import bolt from "@slack/bolt";
import { config } from "./config.js";
import { runClaude } from "./claude.js";
import { SessionStore, type SessionRecord } from "./sessions.js";
import { log } from "./log.js";

const { App } = bolt;

const sessions = new SessionStore(config.sessionsFile);

const threadQueues = new Map<string, Promise<void>>();

function enqueue(threadKey: string, work: () => Promise<void>): Promise<void> {
  const prev = threadQueues.get(threadKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  threadQueues.set(
    threadKey,
    next.finally(() => {
      if (threadQueues.get(threadKey) === next) threadQueues.delete(threadKey);
    }),
  );
  return next;
}

const SLACK_CHUNK_LIMIT = 3000;

function chunk(text: string, max = SLACK_CHUNK_LIMIT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > i + max / 2) end = lastNewline;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

function buildThreadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function resolveAssistantForNewThread(channelId: string): string | undefined {
  return config.channelAssistants[channelId] ?? config.defaultAssistant;
}

function ownsAssistant(assistant: string | undefined): boolean {
  return !!assistant && !!config.assistants[assistant];
}

interface ProcessParams {
  channelId: string;
  threadTs: string;
  reactionTs?: string;
  prompt: string;
  assistant: string;
  client: bolt.webApi.WebClient;
}

async function processTurn({
  channelId,
  threadTs,
  reactionTs,
  prompt,
  assistant,
  client,
}: ProcessParams): Promise<void> {
  const threadKey = buildThreadKey(channelId, threadTs);
  const workingDir = config.assistants[assistant];
  if (!workingDir) {
    log("dropped: unknown assistant", { threadKey, assistant });
    return;
  }

  await enqueue(threadKey, async () => {
    if (reactionTs) {
      await client.reactions
        .add({ channel: channelId, timestamp: reactionTs, name: "eyes" })
        .catch(() => undefined);
    }

    try {
      const stored = await sessions.get(threadKey);
      const resume =
        stored?.assistant === assistant ? stored.sessionId : undefined;

      log("dispatch", {
        threadKey,
        assistant,
        resume: resume ? "yes" : "no",
        len: prompt.length,
      });

      const result = await runClaude(prompt, resume, workingDir);

      if (result.sessionId) {
        const record: SessionRecord = {
          sessionId: result.sessionId,
          assistant,
        };
        if (
          !stored ||
          stored.sessionId !== result.sessionId ||
          stored.assistant !== assistant
        ) {
          await sessions.set(threadKey, record);
        }
      }

      const reply = result.error
        ? `:warning: ${result.error}${result.text ? `\n\n${result.text}` : ""}`
        : result.text || "_(no response)_";

      for (const part of chunk(reply)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: part,
        });
      }

      if (reactionTs) {
        await client.reactions
          .remove({ channel: channelId, timestamp: reactionTs, name: "eyes" })
          .catch(() => undefined);
        await client.reactions
          .add({
            channel: channelId,
            timestamp: reactionTs,
            name: result.error ? "x" : "white_check_mark",
          })
          .catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("handler error", { threadKey, msg });
      await client.chat
        .postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:warning: bridge error: ${msg}`,
        })
        .catch(() => undefined);
    }
  });
}

export function buildApp(): bolt.App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  app.message(async ({ message, client, say }) => {
    const m = message as unknown as Record<string, unknown>;

    if (typeof m.subtype === "string") return;
    if (m.bot_id) return;

    const userId = typeof m.user === "string" ? m.user : undefined;
    const channelId = typeof m.channel === "string" ? m.channel : undefined;
    const ts = typeof m.ts === "string" ? m.ts : undefined;
    const threadTs = typeof m.thread_ts === "string" ? m.thread_ts : undefined;
    const channelType =
      typeof m.channel_type === "string" ? m.channel_type : undefined;
    const text = typeof m.text === "string" ? m.text : "";

    if (!userId || !channelId || !ts) return;

    const threadRoot = threadTs ?? ts;
    const threadKey = buildThreadKey(channelId, threadRoot);
    const stored = await sessions.get(threadKey);

    // In non-DM channels, only respond to threads we've already engaged with.
    // Channel mappings are honored for new threads kicked off via slash command,
    // not by random channel chatter.
    if (channelType !== "im" && !stored) return;

    // Resolve the assistant for this turn. Continue threads with whatever
    // assistant they were started with; new DMs use channel mapping or
    // DEFAULT_ASSISTANT. If this instance doesn't own the resolved assistant,
    // stay silent — another bridge instance owns it.
    const assistant =
      stored?.assistant ?? resolveAssistantForNewThread(channelId);
    if (!ownsAssistant(assistant)) return;

    if (!config.allowedUserIds.includes(userId)) {
      log("rejected unauthorized user", { userId });
      await say({
        thread_ts: threadRoot,
        text: "Sorry, you're not on this bot's allowlist.",
      }).catch(() => undefined);
      return;
    }

    if (!text.trim()) return;

    log("received", {
      userId,
      threadKey,
      assistant,
      isNew: !threadTs,
      len: text.length,
    });

    await processTurn({
      channelId,
      threadTs: threadRoot,
      reactionTs: ts,
      prompt: text,
      assistant: assistant!,
      client,
    });
  });

  for (const assistant of Object.keys(config.assistants)) {
    app.command(`/${assistant}`, async ({ command, ack, client }) => {
      await ack();

      const userId = command.user_id;
      const channelId = command.channel_id;
      const text = command.text?.trim() ?? "";

      if (!config.allowedUserIds.includes(userId)) {
        await client.chat
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: "Sorry, you're not on this bot's allowlist.",
          })
          .catch(() => undefined);
        return;
      }

      if (!text) {
        await client.chat
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: `Usage: \`/${assistant} <message>\``,
          })
          .catch(() => undefined);
        return;
      }

      let starterTs: string;
      try {
        const posted = await client.chat.postMessage({
          channel: channelId,
          text: `<@${userId}> → *${assistant}*: ${text}`,
        });
        if (!posted.ts) throw new Error("starter message missing ts");
        starterTs = posted.ts;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("slash post error", { assistant, channelId, msg });
        await client.chat
          .postEphemeral({
            channel: channelId,
            user: userId,
            text: `:warning: couldn't post to this channel: ${msg}`,
          })
          .catch(() => undefined);
        return;
      }

      log("slash dispatch", { userId, assistant, channelId, starterTs });

      await processTurn({
        channelId,
        threadTs: starterTs,
        reactionTs: starterTs,
        prompt: text,
        assistant,
        client,
      });
    });
  }

  return app;
}
