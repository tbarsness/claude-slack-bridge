import bolt from "@slack/bolt";
import { config } from "./config.js";
import { runClaude } from "./claude.js";
import { SessionStore } from "./sessions.js";
import { log } from "./log.js";

const { App } = bolt;

const sessions = new SessionStore(config.sessionsFile);

const threadQueues = new Map<string, Promise<void>>();

function enqueue(threadId: string, work: () => Promise<void>): Promise<void> {
  const prev = threadQueues.get(threadId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  threadQueues.set(
    threadId,
    next.finally(() => {
      if (threadQueues.get(threadId) === next) threadQueues.delete(threadId);
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

export function buildApp(): bolt.App {
  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  app.message(async ({ message, client, say }) => {
    const m = message as unknown as Record<string, unknown>;

    if (m.channel_type !== "im") return;
    if (typeof m.subtype === "string") return;
    if (m.bot_id) return;

    const userId = typeof m.user === "string" ? m.user : undefined;
    const channelId = typeof m.channel === "string" ? m.channel : undefined;
    const ts = typeof m.ts === "string" ? m.ts : undefined;
    const threadTs = typeof m.thread_ts === "string" ? m.thread_ts : undefined;
    const text = typeof m.text === "string" ? m.text : "";

    if (!userId || !channelId || !ts) return;

    if (!config.allowedUserIds.includes(userId)) {
      log("rejected unauthorized user", { userId });
      await say({
        thread_ts: threadTs ?? ts,
        text: "Sorry, you're not on this bot's allowlist.",
      });
      return;
    }

    if (!text.trim()) return;

    const threadId = threadTs ?? ts;
    log("received", { userId, threadId, isNew: !threadTs, len: text.length });

    await enqueue(threadId, async () => {
      try {
        await client.reactions
          .add({ channel: channelId, timestamp: ts, name: "eyes" })
          .catch(() => undefined);

        const resume = await sessions.get(threadId);
        const result = await runClaude(text, resume);

        if (result.sessionId && result.sessionId !== resume) {
          await sessions.set(threadId, result.sessionId);
        }

        const reply = result.error
          ? `:warning: ${result.error}${result.text ? `\n\n${result.text}` : ""}`
          : result.text || "_(no response)_";

        for (const part of chunk(reply)) {
          await say({ thread_ts: threadId, text: part });
        }

        await client.reactions
          .remove({ channel: channelId, timestamp: ts, name: "eyes" })
          .catch(() => undefined);
        await client.reactions
          .add({
            channel: channelId,
            timestamp: ts,
            name: result.error ? "x" : "white_check_mark",
          })
          .catch(() => undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("handler error", { threadId, msg });
        await say({
          thread_ts: threadId,
          text: `:warning: bridge error: ${msg}`,
        }).catch(() => undefined);
      }
    });
  });

  return app;
}
