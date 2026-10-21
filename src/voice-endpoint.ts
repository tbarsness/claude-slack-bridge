import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { config } from "./config.js";
import { log } from "./log.js";
import { runClaude } from "./claude.js";
import { SessionStore } from "./sessions.js";

/**
 * Private HTTP endpoint for hands-free voice queries from an iOS Shortcut
 * ("Hey Siri, Jude"). Reachable only over Tailscale — we bind to the tailnet
 * address, never the LAN — and every request must carry the shared secret.
 *
 * Voice answers are short by construction. Anything that needs real work is
 * deferred: the caller hears one sentence immediately, and the full turn runs
 * in the background and reports into Slack.
 */

/** Prepended to voice prompts to force spoken-length answers. */
const VOICE_SYSTEM = `You are answering out loud through a phone. Rules:
- Reply in at most 2-3 short sentences of plain spoken prose.
- No markdown, lists, code, file paths, URLs, or emoji.
- Round numbers for speech: say "about eighteen thousand", not "$18,081.42".
- If you can answer from what you know or with one quick lookup, just answer.
- If answering properly would take more than ~30 seconds of real work (multi-step
  tool chains, editing files, reconciling records), do NOT start it. Reply with
  exactly: DEFER: <one sentence describing what you will go do>
  The system will run the full task separately and report in Slack.`;

/** Marker the model returns when a request is too big to answer live. */
const DEFER = /^\s*DEFER:\s*/i;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface VoiceDeps {
  client: WebClient;
  sessions: SessionStore;
}

/**
 * Hard ceiling on a deferred turn. The agent SDK has been observed to hang
 * forever when its subprocess dies mid-run: it stops emitting, never throws,
 * and its own abort never fires. Without this race the promise never settles
 * and the request vanishes with no answer and no error — the worst outcome,
 * since the caller was already told the work had started.
 */
const DEFERRED_TIMEOUT_MS = 10 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "__timeout__"> {
  return Promise.race([
    p,
    new Promise<"__timeout__">((resolve) =>
      setTimeout(() => resolve("__timeout__"), ms).unref(),
    ),
  ]);
}

/**
 * Run the full (non-voice) version of a deferred request and post the result
 * into the assistant's Slack channel. Fire-and-forget: the HTTP caller has
 * already been answered, so Slack is the only channel left to report on —
 * which is why every path here ends in a post.
 */
async function runDeferred(
  deps: VoiceDeps,
  assistant: string,
  workingDir: string,
  channelId: string | undefined,
  question: string,
): Promise<void> {
  const header = `:studio_microphone: *Voice request:* ${question}`;
  let body: string;

  try {
    const outcome = await withTimeout(
      runClaude(
        `${question}\n\n[Asked by voice; answer here in Slack with full detail.]`,
        undefined,
        workingDir,
      ),
      DEFERRED_TIMEOUT_MS,
    );

    if (outcome === "__timeout__") {
      log("voice deferred timed out", { assistant, ms: DEFERRED_TIMEOUT_MS });
      body =
        ":warning: This one ran past ten minutes and I stopped waiting on it. Nothing was left half-finished on your side, but ask again here if you still want it.";
    } else if (outcome.error) {
      body = `:warning: ${outcome.error}`;
    } else {
      body = outcome.text || "_(no response)_";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("voice deferred failed", { assistant, msg });
    body = `:warning: ${msg}`;
  }

  if (!channelId) {
    log("voice deferred finished with nowhere to post", { assistant });
    return;
  }

  await deps.client.chat
    .postMessage({ channel: channelId, text: `${header}\n\n${body}` })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log("voice deferred post failed", { assistant, msg });
    });
}

export function startVoiceEndpoint(deps: VoiceDeps): void {
  if (!config.voice.enabled) {
    log("voice endpoint disabled");
    return;
  }
  if (!config.voice.secret) {
    log("voice endpoint NOT started (VOICE_SECRET unset)");
    return;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          return json(res, 200, { ok: true });
        }
        if (req.method !== "POST" || !req.url?.startsWith("/ask")) {
          return json(res, 404, { error: "not found" });
        }

        const supplied = req.headers["x-voice-secret"];
        if (
          typeof supplied !== "string" ||
          !safeEqual(supplied, config.voice.secret)
        ) {
          log("voice auth rejected", { ip: req.socket.remoteAddress });
          return json(res, 401, { error: "unauthorized" });
        }

        const body = await readBody(req);
        let parsed: { text?: string; assistant?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "invalid json" });
        }

        const question = (parsed.text ?? "").trim();
        if (!question) return json(res, 400, { error: "empty text" });

        const assistant = parsed.assistant?.trim() || config.voice.assistant;
        const workingDir = config.assistants[assistant];
        if (!workingDir) {
          return json(res, 400, { error: `unknown assistant "${assistant}"` });
        }

        const started = Date.now();
        log("voice ask", { assistant, chars: question.length });

        // Dedicated session so spoken exchanges have continuity with each
        // other without entangling any Slack thread's history.
        const sessionKey = `voice:${assistant}`;
        const stored = await deps.sessions.get(sessionKey);
        const resume =
          stored?.assistant === assistant ? stored.sessionId : undefined;

        const result = await runClaude(
          `${VOICE_SYSTEM}\n\n---\n\n${question}`,
          resume,
          workingDir,
        );

        if (result.sessionId) {
          await deps.sessions.set(sessionKey, {
            sessionId: result.sessionId,
            assistant,
          });
        }

        const channelId = Object.entries(config.channelAssistants).find(
          ([, name]) => name === assistant,
        )?.[0];

        let spoken = (result.text || "").trim();
        let deferred = false;

        if (result.error) {
          spoken = "Something went wrong on my end. Check Slack for details.";
        } else if (DEFER.test(spoken)) {
          deferred = true;
          spoken = spoken.replace(DEFER, "").trim();
          void runDeferred(deps, assistant, workingDir, channelId, question);
        }

        if (!spoken) spoken = "I didn't get anything back. Try again?";

        json(res, 200, { reply: spoken, deferred });
        log("voice reply", {
          assistant,
          deferred,
          ms: Date.now() - started,
          chars: spoken.length,
        });

        // Mirror into Slack so spoken exchanges are searchable alongside
        // everything else. Deferred requests get their own post from
        // runDeferred, so skip the duplicate here.
        if (channelId && !deferred) {
          await deps.client.chat
            .postMessage({
              channel: channelId,
              text: `:studio_microphone: *Asked by voice:* ${question}\n\n${spoken}`,
            })
            .catch(() => undefined);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("voice endpoint error", { msg });
        if (!res.headersSent) json(res, 500, { error: msg });
      }
    })();
  });

  server.on("error", (err) => {
    log("voice endpoint listen error", { msg: err.message });
  });

  server.listen(config.voice.port, config.voice.host, () => {
    log("voice endpoint ready", {
      host: config.voice.host,
      port: config.voice.port,
      assistant: config.voice.assistant,
    });
  });

  server.unref();
}
