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

function detectAddressedAssistant(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // First token: optional @, name, optional , or :
  const match = trimmed.match(/^@?([a-zA-Z][a-zA-Z0-9_-]*)[,:]?(\s|$)/);
  if (!match) return undefined;
  const candidate = match[1].toLowerCase();
  return config.knownAssistantNames.includes(candidate) ? candidate : undefined;
}

interface ProcessParams {
  channelId: string;
  threadTs: string;
  reactionTs?: string;
  prompt: string;
  assistant: string;
  /**
   * If true, do not resume the thread's stored session and do not persist a
   * new session for this turn. Used for address-prefix "guest turns" where
   * another assistant is being addressed inside an existing thread that this
   * assistant doesn't own.
   */
  guestTurn?: boolean;
  client: bolt.webApi.WebClient;
}

async function processTurn({
  channelId,
  threadTs,
  reactionTs,
  prompt,
  assistant,
  guestTurn = false,
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
        !guestTurn && stored?.assistant === assistant
          ? stored.sessionId
          : undefined;

      log("dispatch", {
        threadKey,
        assistant,
        guestTurn,
        resume: resume ? "yes" : "no",
        len: prompt.length,
      });

      const result = await runClaude(prompt, resume, workingDir);

      if (result.sessionId && !guestTurn) {
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
    const addressed = detectAddressedAssistant(text);

    // Resolve the assistant for this turn. Priority:
    //   1. Address prefix (e.g. "jude check this") - explicit override.
    //   2. Stored thread owner - continuing an existing conversation.
    //   3. Channel mapping or DEFAULT_ASSISTANT - for new top-level DMs.
    // In a multi-bridge setup, every instance sees every event; only the one
    // that owns the resolved assistant acts.
    let assistant: string | undefined;
    let guestTurn = false;
    if (addressed) {
      assistant = addressed;
      // If addressed inside an existing thread we don't own (or that's owned
      // by a different assistant), this is a one-shot guest turn. Don't
      // resume any prior session and don't take over the thread.
      if (threadTs && stored?.assistant !== addressed) {
        guestTurn = true;
      }
    } else {
      assistant = stored?.assistant ?? resolveAssistantForNewThread(channelId);
      // Bail silently when there's no stored session AND either:
      //   - we're in a non-DM channel (random channel chatter, not for us); or
      //   - we're in a thread reply (the other bridge probably owns the thread).
      // Only top-level DMs (no thread) fall through to DEFAULT_ASSISTANT.
      if (!stored && (channelType !== "im" || threadTs)) return;
    }
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
      addressed: addressed ?? null,
      guestTurn,
      isNew: !threadTs,
      len: text.length,
    });

    await processTurn({
      channelId,
      threadTs: threadRoot,
      reactionTs: ts,
      prompt: text,
      assistant: assistant!,
      guestTurn,
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
