import bolt from "@slack/bolt";
import { basename } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { config } from "./config.js";
import { runClaude } from "./claude.js";
import { SessionStore, type SessionRecord } from "./sessions.js";
import { log } from "./log.js";
import { enqueue, claudeLimiter } from "./turn-queue.js";
import { chunk } from "./slack-chunk.js";
import {
  downloadAttachments,
  formatAttachmentsForPrompt,
  type SlackFile,
} from "./attachments.js";
import {
  transcribeAudioAttachments,
  formatTranscriptsForPrompt,
} from "./transcribe.js";
import { parseVoiceTags, synthesizeAll } from "./speak.js";
import type { FoodChat, Photo } from "./food-chat-endpoint.js";

const { App } = bolt;

const sessions = new SessionStore(config.sessionsFile);

/** Shared with the voice endpoint so spoken turns reuse the same store. */
export const sessionStore = sessions;

/**
 * Extract `[ATTACH: /absolute/path]` tags from Claude's response text.
 * Returns the cleaned text (tags removed) and the list of file paths to upload.
 * Tags may appear anywhere in the response; surrounding whitespace is trimmed.
 */
function parseAttachments(text: string): {
  cleanText: string;
  filePaths: string[];
} {
  const filePaths: string[] = [];
  const cleanText = text
    .replace(/\[ATTACH:\s*([^\]]+)\]/g, (_, p: string) => {
      filePaths.push(p.trim());
      return "";
    })
    .trim();
  return { cleanText, filePaths };
}

/**
 * Subset of fields we use from Slack message attachments. Forwarded/shared
 * messages arrive as entries in the message's `attachments` array with
 * `is_share: true`; the original message's files live in `attachments[].files`
 * (NOT the top-level `files` array) and its text in `attachments[].text`.
 */
interface SlackMessageAttachment {
  text?: string;
  fallback?: string;
  author_name?: string;
  author_subname?: string;
  is_share?: boolean;
  files?: SlackFile[];
}

/**
 * Pull files and quoted text out of forwarded/shared messages so they behave
 * like direct uploads. Returns files found in any attachment plus a formatted
 * text block for each shared message.
 */
function extractForwarded(attachments: SlackMessageAttachment[]): {
  files: SlackFile[];
  texts: string[];
} {
  const files: SlackFile[] = [];
  const texts: string[] = [];
  for (const att of attachments) {
    if (Array.isArray(att.files)) files.push(...att.files);
    const attText = att.text ?? att.fallback;
    if (att.is_share && attText) {
      const who = att.author_name ?? att.author_subname;
      texts.push(
        `[Forwarded message${who ? ` from ${who}` : ""}]\n${attText}`,
      );
    }
  }
  return { files, texts };
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

export interface MirrorMessage {
  channelId: string;
  threadTs?: string;
  ts: string;
  userId: string;
  /** The message text, with any forwarded text already appended. */
  text: string;
  files: SlackFile[];
}

export interface MirrorDeps {
  /** Undefined when the food chat is off; then nothing is routed. */
  foodChat: Pick<FoodChat, "chatForThread" | "submit"> | undefined;
  /** The #ivy channel the mirror threads live in. */
  channel: string;
  timUserId: string;
  /** The food chat's assistant; a message addressed to it is still Tim's turn. */
  assistant: string;
  /** Downloads the message's images; other files are skipped. */
  downloadPhotos: (files: SlackFile[]) => Promise<Photo[]>;
}

/**
 * Route Tim's reply in a food-chat mirror thread to that chat as a turn (U6).
 * Returns false, leaving the message to the normal Slack path, for any other
 * thread, any other sender, and a message addressed to another assistant.
 * The turn ID is the message ts, so a redelivered event is the same turn and
 * the store runs it once. The food chat posts the reply; Tim's message is
 * already in the thread and is not posted again.
 */
export async function routeFoodChatMessage(
  m: MirrorMessage,
  deps: MirrorDeps,
): Promise<boolean> {
  if (!deps.foodChat || !m.threadTs || m.channelId !== deps.channel) return false;
  const chat = deps.foodChat.chatForThread(m.threadTs);
  if (!chat) return false;
  if (m.userId !== deps.timUserId) return false;
  const addressed = detectAddressedAssistant(m.text);
  if (addressed && addressed !== deps.assistant) return false;

  const photos = m.files.length
    ? await deps.downloadPhotos(m.files)
    : [];
  if (!m.text.trim() && !photos.length) return true;
  const { turn, created } = await deps.foodChat.submit({
    turnId: m.ts,
    chat,
    origin: "slack",
    text: m.text,
    photos,
  });
  log("food chat slack turn", { chat, turnId: turn.turnId, created, photos: photos.length });
  return true;
}

/** Download a Slack message's images as food-chat photos; other files are skipped. */
async function downloadSlackPhotos(
  files: SlackFile[],
  channelId: string,
  threadTs: string,
): Promise<Photo[]> {
  const images = files.filter((f) => f.mimetype?.startsWith("image/"));
  if (!images.length) return [];
  const saved = await downloadAttachments(images, config.foodChat.ivyDir, channelId, threadTs);
  return Promise.all(
    saved.map(async (a) => ({ name: a.name, mime: a.mimetype, data: await readFile(a.path) })),
  );
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
  /**
   * Slack files attached to the inbound message (images, PDFs, etc.). The
   * bridge downloads these into the assistant's working directory and tells
   * Claude where to find them so it can Read them.
   */
  files?: SlackFile[];
  client: bolt.webApi.WebClient;
}

async function processTurn({
  channelId,
  threadTs,
  reactionTs,
  prompt,
  assistant,
  guestTurn = false,
  files = [],
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

      const attachments = files.length
        ? await downloadAttachments(files, workingDir, channelId, threadTs)
        : [];

      // Voice clips can't be Read by the model, so transcribe them locally
      // and inline the text. Clips that transcribed successfully are kept
      // out of the "Read these files" list to save a wasted tool call.
      const transcripts = await transcribeAudioAttachments(attachments);
      const transcribedPaths = new Set(transcripts.map((t) => t.path));
      const readableAttachments = attachments.filter(
        (a) => !transcribedPaths.has(a.path),
      );

      // Slack stores the audio but indexes none of the words. Post the
      // transcript back into the thread so the memo is searchable later.
      if (config.transcription.postTranscript) {
        for (const t of transcripts) {
          await client.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `:studio_microphone: *Voice memo:* ${t.text}`,
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log("transcript post failed", { msg });
            });
        }
      }

      const finalPrompt =
        prompt +
        formatTranscriptsForPrompt(transcripts) +
        formatAttachmentsForPrompt(readableAttachments);

      log("dispatch", {
        threadKey,
        assistant,
        guestTurn,
        resume: resume ? "yes" : "no",
        len: finalPrompt.length,
        attachments: attachments.length,
        transcripts: transcripts.length,
      });

      let result = await claudeLimiter.run(() =>
        runClaude(finalPrompt, resume, workingDir),
      );

      // A stored session can go missing (transcript cleanup, or an id that was
      // never real). Start the thread over instead of leaving it dead forever.
      if (resume && result.error?.includes("No conversation found")) {
        log("resume failed, starting fresh", { threadKey, resume });
        result = await claudeLimiter.run(() =>
          runClaude(finalPrompt, undefined, workingDir),
        );
      }

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

      const rawReply = result.error
        ? `:warning: ${result.error}${result.text ? `\n\n${result.text}` : ""}`
        : result.text;

      // `[VOICE: ...]` becomes both a spoken clip and visible text, so the
      // words the assistant says are searchable alongside everything else.
      const voiceParsed = parseVoiceTags(rawReply ?? "");
      const segments = await synthesizeAll(voiceParsed.segments);
      const spokenPaths = segments
        .map((s) => s.audioPath)
        .filter((p): p is string => Boolean(p));

      const { cleanText, filePaths: attachPaths } = parseAttachments(
        voiceParsed.cleanText,
      );
      const filePaths = [...attachPaths, ...spokenPaths];
      const reply = cleanText || (filePaths.length === 0 ? "_(no response)_" : "");

      if (reply) {
        for (const part of chunk(reply)) {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: part,
          });
        }
      }

      for (const filePath of filePaths) {
        try {
          await client.filesUploadV2({
            channel_id: channelId,
            thread_ts: threadTs,
            file: filePath,
            filename: basename(filePath),
          });
          log("file uploaded", { filePath });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("file upload error", { filePath, msg });
          await client.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: `:warning: couldn't upload \`${basename(filePath)}\`: ${msg}`,
            })
            .catch(() => undefined);
        }
      }

      // Generated voice clips are scratch files; Slack has the copy now.
      for (const p of spokenPaths) {
        await unlink(p).catch(() => undefined);
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

export function buildApp(
  opts: {
    /** The food chat, once started; undefined while it is off. */
    foodChat?: () => FoodChat | undefined;
  } = {},
): bolt.App {
  // Watchdog logger: Bolt's socket-mode client emits a WARN log when a pong
  // isn't received from the server, but its auto-reconnect can silently fail
  // afterwards (process stays alive, websocket is dead). Intercept that WARN
  // and exit so launchd respawns us with a fresh socket.
  const watchdogLogger = {
    setLevel: () => {},
    getLevel: () => "warn",
    setName: () => {},
    // Bolt ignores `logLevel` when a custom logger is supplied. Left fully on,
    // debug emits every WebSocket frame + full HTTP body (~38 MB/day) —
    // synchronous IO that stalls the event loop. We keep ONLY socket-health
    // lines (connect/disconnect/reconnect/WSS/too_many_websockets) so we retain
    // visibility into the reconnect gaps that drop inbound messages, and drop
    // the high-volume noise (HTTP bodies, apiCalls, per-event frames).
    debug: (...m: unknown[]) => {
      const text = m
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join(" ");
      if (
        /disconnect|reconnect|too_many_websockets|pong wasn|retrieve a new WSS|Initiating new WebSocket|WebSocket (open|close|error)|unable_to_socket|Going to retrieve|Authenticated the connection|slow/i.test(
          text,
        )
      ) {
        log("bolt-debug", text.slice(0, 300));
      }
    },
    info: () => {},
    warn: (...m: unknown[]) => {
      console.warn(...m);
      const text = m
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join(" ");
      if (/pong wasn'?t received/i.test(text)) {
        log("pong timeout detected, exiting");
        setTimeout(() => process.exit(2), 50).unref();
      }
    },
    error: (...m: unknown[]) => console.error(...m),
  };

  const appOptions = {
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    logger: watchdogLogger,
  } as unknown as ConstructorParameters<typeof App>[0];
  const app = new App(appOptions);

  app.message(async ({ message, client, say }) => {
    const m = message as unknown as Record<string, unknown>;

    // Compact trace of EVERY message envelope Slack delivers, logged before any
    // early return. If a message that got no reaction has no `msg-in` line, Slack
    // never delivered it (socket/reconnect loss); if it has `msg-in` but no
    // `received`, the bridge dropped it in routing. One line per message.
    log("msg-in", {
      ts: typeof m.ts === "string" ? m.ts : null,
      subtype: typeof m.subtype === "string" ? m.subtype : null,
      thread: typeof m.thread_ts === "string" ? m.thread_ts : null,
      textLen: typeof m.text === "string" ? m.text.length : 0,
    });

    // Drop most subtyped events (channel_join, message_changed, etc.) but
    // let `file_share` through — that's how Slack delivers a user message
    // with file attachments — and `share`/`thread_broadcast`, which can
    // carry forwarded messages.
    if (
      typeof m.subtype === "string" &&
      !["file_share", "share", "thread_broadcast"].includes(m.subtype)
    ) {
      log("dropped subtype", {
        subtype: m.subtype,
        channel: typeof m.channel === "string" ? m.channel : undefined,
        ts: typeof m.ts === "string" ? m.ts : undefined,
        user: typeof m.user === "string" ? m.user : undefined,
        textLen:
          typeof m.text === "string"
            ? m.text.length
            : typeof (m as { message?: { text?: unknown } }).message?.text ===
                "string"
              ? ((m as { message?: { text: string } }).message?.text?.length ??
                0)
              : 0,
      });
      return;
    }
    if (m.bot_id) return;

    const userId = typeof m.user === "string" ? m.user : undefined;
    const channelId = typeof m.channel === "string" ? m.channel : undefined;
    const ts = typeof m.ts === "string" ? m.ts : undefined;
    const threadTs = typeof m.thread_ts === "string" ? m.thread_ts : undefined;
    const channelType =
      typeof m.channel_type === "string" ? m.channel_type : undefined;
    const text = typeof m.text === "string" ? m.text : "";
    const directFiles: SlackFile[] = Array.isArray(m.files)
      ? (m.files as SlackFile[])
      : [];

    // Forwarded/shared messages: the original message rides along in the
    // `attachments` array. Extract its files and text so the assistant sees
    // them like a direct upload.
    const msgAttachments: SlackMessageAttachment[] = Array.isArray(
      m.attachments,
    )
      ? (m.attachments as SlackMessageAttachment[])
      : [];
    const forwarded = extractForwarded(msgAttachments);

    // De-dupe by file id in case Slack lists a file in both places.
    const seenIds = new Set(
      directFiles.map((f) => f.id).filter((id): id is string => !!id),
    );
    const files: SlackFile[] = [
      ...directFiles,
      ...forwarded.files.filter((f) => !f.id || !seenIds.has(f.id)),
    ];

    if (!userId || !channelId || !ts) return;

    // Include forwarded message text (quoted) beneath the user's own comment.
    const prompt = forwarded.texts.length
      ? [text.trim(), ...forwarded.texts].filter(Boolean).join("\n\n")
      : text;

    // Tim's replies in a food-chat mirror thread run as that chat's turns.
    if (
      await routeFoodChatMessage(
        { channelId, threadTs, ts, userId, text: prompt, files },
        {
          foodChat: opts.foodChat?.(),
          channel: config.foodChat.channel,
          timUserId: config.foodChat.timUserId,
          assistant: config.foodChat.assistant,
          downloadPhotos: (photoFiles) =>
            downloadSlackPhotos(photoFiles, channelId, threadTs ?? ts),
        },
      )
    ) {
      return;
    }

    const threadRoot = threadTs ?? ts;
    const threadKey = buildThreadKey(channelId, threadRoot);
    const stored = await sessions.get(threadKey);
    const addressed = detectAddressedAssistant(text);

    // Resolve the assistant for this turn. Priority:
    //   1. Address prefix (e.g. "jude check this") - explicit override.
    //   2. Stored thread owner - continuing an existing conversation.
    //   3. Channel mapping (CHANNEL_ASSISTANTS) - new threads in mapped
    //      channels route to the mapped assistant.
    //   4. DEFAULT_ASSISTANT - new top-level DMs only.
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
    } else if (stored) {
      assistant = stored.assistant;
    } else if (threadTs) {
      // Thread reply we have no stored session for - another bridge owns it.
      return;
    } else if (channelType === "im") {
      // New top-level DM - DEFAULT_ASSISTANT (set on exactly one bridge).
      assistant = config.defaultAssistant;
    } else {
      // New top-level non-DM message - only handle if channel is mapped.
      assistant = config.channelAssistants[channelId];
      if (!assistant) return;
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

    // Allow attachment-only messages (e.g. "here's a screenshot" with no
    // text body) — the prompt will end up as just the attachment block.
    if (!text.trim() && files.length === 0 && forwarded.texts.length === 0)
      return;

    log("received", {
      userId,
      threadKey,
      assistant,
      addressed: addressed ?? null,
      guestTurn,
      isNew: !threadTs,
      len: text.length,
      files: files.length,
      forwarded: forwarded.texts.length,
    });

    await processTurn({
      channelId,
      threadTs: threadRoot,
      reactionTs: ts,
      prompt,
      assistant: assistant!,
      guestTurn,
      files,
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
