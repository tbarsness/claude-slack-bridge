import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { config } from "./config.js";
import { log } from "./log.js";
import { runClaude } from "./claude.js";
import { SessionStore } from "./sessions.js";
import { downloadBoardImages, formatBoardImagesForPrompt } from "./attachments.js";

/**
 * Private HTTP endpoint that lets work.timbarsness.com run an assistant.
 *
 * Two things reach it: a message Tim posts to a card's thread, and the button
 * in the card drawer. Both arrive as one POST /dispatch and are handled the
 * same way; only the prompt differs.
 *
 * Reachable over Tailscale only (bind to the tailnet address, never the LAN)
 * and every request carries the shared secret. That matters more here than for
 * voice: a dispatch runs an agent with bypassPermissions on this machine.
 *
 * The caller is answered immediately with 202 and the turn runs in the
 * background. A board dispatch is routinely minutes of real work, and holding
 * a Strapi lifecycle hook open for that would stall the write that triggered it.
 */

/** How often, at most, a running dispatch writes its heartbeat to the board. */
const HEARTBEAT_MS = 10_000;

/**
 * Board work is long by nature: reading a thread, checking mail, editing a
 * sheet. Only silence should end it, and the window is wider than the Slack
 * default because nobody is sitting watching this one.
 */
const BOARD_IDLE_MS = 10 * 60 * 1000;

interface DispatchBody {
  assistant?: string;
  taskDocumentId?: string;
  taskId?: number;
  title?: string;
  url?: string;
  team?: string;
  column?: string;
  trigger?: string;
  author?: string;
  messageBody?: string;
  /**
   * Absolute URLs of images in Tim's message, under the board's /uploads/.
   * Optional so the board and the bridge can deploy in either order.
   */
  images?: string[];
}

/** More images than this in one turn is a mistake, not a screenshot set. */
const MAX_IMAGES = 20;

/** The usable image URLs on a body, tolerating anything the JSON held. */
function imageUrls(b: DispatchBody): string[] {
  if (!Array.isArray(b.images)) return [];
  return b.images.filter(
    (u): u is string => typeof u === "string" && u.trim() !== "",
  );
}

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

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Write dispatch state back onto the card.
 *
 * Best-effort on purpose. If the board is unreachable the run still has value:
 * the assistant posts its own reply to the thread when it can. Failing the run
 * because a status write failed would trade the work for the progress bar.
 */
async function patchTask(
  taskDocumentId: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!config.board.apiUrl) return;
  try {
    const res = await fetch(`${config.board.apiUrl}/tasks/${taskDocumentId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log("board patch failed", { taskDocumentId, status: res.status });
    }
  } catch (err) {
    log("board patch error", {
      taskDocumentId,
      msg: err instanceof Error ? err.message : String(err),
    });
  }
}

/** A short human label for what the run is doing, shown on the card. */
function activityLabel(type: string, subtype: string | undefined): string {
  if (type === "assistant") return "thinking";
  if (type === "user") return "running tools";
  if (type === "system" && subtype === "init") return "starting up";
  if (type === "result") return "wrapping up";
  return "working";
}

export async function buildPrompt(
  b: DispatchBody,
  workingDir: string,
): Promise<string> {
  const where = b.url ?? `card ${b.taskId ?? b.taskDocumentId}`;
  const head =
    b.trigger === "button"
      ? `Tim pressed the "${b.assistant}" button on a card at work.timbarsness.com. He is asking you to pick this up now.`
      : `Tim posted a message to a card's thread at work.timbarsness.com.`;

  const lines = [
    head,
    "",
    `Card: ${b.title ?? "(untitled)"}`,
    `Team: ${b.team ?? "unknown"}   Column: ${b.column ?? "unknown"}`,
    `Link: ${where}`,
    `Card documentId: ${b.taskDocumentId}`,
  ];

  if (b.messageBody) {
    lines.push("", "What Tim wrote:", "", b.messageBody);
  }

  lines.push(
    "",
    // Marketing, F&A and HR/Office run out of worktrees off Jude's repo, so
    // their CLAUDE.md is Jude's and tells them to post as jude. The first
    // smoke test came back signed "jude" from the F&A worktree, which would
    // make all four fjorge assistants indistinguishable on the board. The
    // dispatch knows who it asked for, so it says so here rather than
    // diverging CLAUDE.md on three branches that have to keep merging.
    `Post to the card's thread as \`${b.assistant}\`, whatever author your`,
    "CLAUDE.md names. That is who Tim handed this to and who he expects to",
    "hear back from. Never post as another assistant.",
    "",
    "Use your /board skill. Read the whole thread before acting: another",
    "assistant may already have done part of it. Then do the work.",
    "",
    "When you are finished, post what happened to this card's thread and move",
    "the column if its state changed. Write what happened, not that you did",
    "something. If you need a decision or an action from Tim, move it to",
    "Waiting on Tim; if anyone or anything else owes it, move it to Blocked,",
    "and say in the thread what is being waited on and who owes it.",
    "",
    "Nobody is watching a chat window for this run, so the thread post is the",
    "only output that reaches Tim. Do not end without one.",
  );

  const prompt = lines.join("\n");

  // Without images this is exactly the prompt as it was before images existed.
  const urls = [...new Set(imageUrls(b))].slice(0, MAX_IMAGES);
  if (!urls.length) return prompt;
  const images = await downloadBoardImages(urls, workingDir, b.taskDocumentId!);
  return prompt + formatBoardImagesForPrompt(images);
}

export interface BoardDeps {
  client: WebClient;
  sessions: SessionStore;
}

/**
 * Cards currently being worked, so a double-click on the button or a burst of
 * messages cannot start two agents on one card. Process-local: a bridge
 * restart clears it, which is the right default, since any run it was tracking
 * died with the process anyway.
 */
const inFlight = new Set<string>();

/**
 * Dispatches that arrived while the same card was already running, keyed the
 * same way as inFlight.
 *
 * These used to get a bare 409 and be dropped on the floor. On 2026-10-13 Tim
 * replied "use the chromium skill to log in via authn.timbarsness.com" to a
 * card mid-run; the reply was refused here, never reached the agent, and
 * nothing anywhere said so, so it read as the assistant ignoring him. Holding
 * them and delivering them when the current turn ends costs a wait and loses
 * nothing.
 */
const queued = new Map<string, DispatchBody[]>();

/**
 * Take everything queued for a card as a single follow-up turn. A burst of
 * replies while one turn ran is one thing to respond to, not several, so they
 * are joined rather than replayed one run at a time.
 */
function takeQueued(key: string): DispatchBody | undefined {
  const q = queued.get(key);
  if (!q?.length) return undefined;
  queued.delete(key);
  return mergeQueued(q);
}

/** Join queued dispatches into one: texts in order, images in order, deduplicated. */
export function mergeQueued(q: DispatchBody[]): DispatchBody {
  const last = q[q.length - 1]!;
  const bodies = q
    .map((item) => item.messageBody?.trim())
    .filter((t): t is string => Boolean(t));
  const images = [...new Set(q.flatMap(imageUrls))];
  const merged: DispatchBody = {
    ...last,
    trigger: "message",
    messageBody: bodies.length ? bodies.join("\n\n") : last.messageBody,
  };
  if (images.length) merged.images = images;
  else delete merged.images;
  return merged;
}

async function runDispatch(deps: BoardDeps, b: DispatchBody): Promise<void> {
  const assistant = b.assistant!;
  const taskDocumentId = b.taskDocumentId!;
  const workingDir = config.assistants[assistant];
  const started = Date.now();

  await patchTask(taskDocumentId, {
    dispatchState: "running",
    dispatchAssistant: assistant,
    dispatchStartedAt: new Date().toISOString(),
    dispatchActivityAt: new Date().toISOString(),
    dispatchNote: "starting up",
  });

  // One session per (assistant, card), so a follow-up message on the same card
  // continues the same conversation instead of re-reading the thread cold.
  const sessionKey = `board:${assistant}:${taskDocumentId}`;
  const stored = await deps.sessions.get(sessionKey);
  const resume = stored?.assistant === assistant ? stored.sessionId : undefined;

  let lastBeat = 0;

  const prompt = await buildPrompt(b, workingDir);
  const result = await runClaude(prompt, resume, workingDir, {
    idleTimeoutMs: BOARD_IDLE_MS,
    onActivity: (a) => {
      const now = Date.now();
      if (now - lastBeat < HEARTBEAT_MS) return;
      lastBeat = now;
      // Fire and forget: a heartbeat must never slow the run down.
      void patchTask(taskDocumentId, {
        dispatchActivityAt: new Date().toISOString(),
        dispatchNote: activityLabel(a.type, a.subtype),
      });
    },
  });

  if (result.sessionId) {
    await deps.sessions.set(sessionKey, {
      sessionId: result.sessionId,
      assistant,
    });
  }

  const ms = Date.now() - started;
  await patchTask(taskDocumentId, {
    dispatchState: result.error ? "failed" : "done",
    dispatchActivityAt: new Date().toISOString(),
    dispatchNote: result.error
      ? result.error.slice(0, 500)
      : `finished in ${Math.round(ms / 1000)}s`,
  });

  log("board dispatch finished", {
    assistant,
    taskDocumentId,
    ms,
    error: result.error ?? null,
  });

  // Mirror into Slack so board work is searchable next to everything else,
  // and so a failure is visible somewhere Tim actually looks.
  const channelId = Object.entries(config.channelAssistants).find(
    ([, name]) => name === assistant,
  )?.[0];
  if (!channelId) return;

  const header = `:clipboard: *Board:* <${b.url ?? ""}|${b.title ?? "card"}>`;
  const body = result.error
    ? `:warning: ${result.error}`
    : result.text || "_(no response; check the card's thread)_";

  await deps.client.chat
    .postMessage({ channel: channelId, text: `${header}\n\n${body}` })
    .catch((err: unknown) => {
      log("board slack post failed", {
        assistant,
        msg: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * Run a card's turn, then any replies that landed while it was running, until
 * the queue is empty. Each follow-up resumes the same session, so the agent
 * reads Tim's reply as the next thing said in a conversation it is already in
 * rather than re-reading the thread cold.
 *
 * The key is released only once nothing is left. Nothing awaits between the
 * final takeQueued and that release, so a dispatch cannot slip into the queue
 * and be stranded there.
 */
async function drainCard(
  deps: BoardDeps,
  first: DispatchBody,
  key: string,
): Promise<void> {
  let body: DispatchBody | undefined = first;
  try {
    while (body) {
      await runDispatch(deps, body).catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log("board dispatch threw", { key, msg });
        await patchTask(body!.taskDocumentId!, {
          dispatchState: "failed",
          dispatchActivityAt: new Date().toISOString(),
          dispatchNote: msg.slice(0, 500),
        });
      });
      body = takeQueued(key);
      if (body) log("board dispatch picking up queued reply", { key });
    }
  } finally {
    inFlight.delete(key);
    queued.delete(key);
  }
}

export function startBoardEndpoint(deps: BoardDeps): void {
  if (!config.board.enabled) {
    log("board endpoint disabled");
    return;
  }
  if (!config.board.secret) {
    log("board endpoint NOT started (BOARD_SECRET unset)");
    return;
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === "GET" && req.url === "/health") {
          return json(res, 200, { ok: true, inFlight: inFlight.size });
        }
        if (req.method !== "POST" || !req.url?.startsWith("/dispatch")) {
          return json(res, 404, { error: "not found" });
        }

        const supplied = req.headers["x-board-secret"];
        if (
          typeof supplied !== "string" ||
          !safeEqual(supplied, config.board.secret)
        ) {
          log("board auth rejected", { ip: req.socket.remoteAddress });
          return json(res, 401, { error: "unauthorized" });
        }

        let b: DispatchBody;
        try {
          b = JSON.parse(await readBody(req)) as DispatchBody;
        } catch {
          return json(res, 400, { error: "invalid json" });
        }

        const assistant = b.assistant?.trim();
        if (!assistant || !config.assistants[assistant]) {
          return json(res, 400, { error: `unknown assistant "${assistant}"` });
        }
        if (!b.taskDocumentId?.trim()) {
          return json(res, 400, { error: "taskDocumentId required" });
        }

        const key = `${assistant}:${b.taskDocumentId}`;
        if (inFlight.has(key)) {
          const q = queued.get(key) ?? [];
          q.push({ ...b, assistant });
          queued.set(key, q);
          log("board dispatch queued behind running turn", {
            key,
            depth: q.length,
          });
          return json(res, 202, { accepted: true, queued: true, assistant });
        }
        inFlight.add(key);

        log("board dispatch accepted", {
          assistant,
          taskDocumentId: b.taskDocumentId,
          trigger: b.trigger,
        });

        // Answer now; the turn runs on its own. Everything after this point
        // reports through the card and Slack, never through this response.
        json(res, 202, { accepted: true, assistant });

        void drainCard(deps, { ...b, assistant }, key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("board endpoint error", { msg });
        if (!res.headersSent) json(res, 500, { error: msg });
      }
    })();
  });

  server.on("error", (err) => {
    log("board endpoint listen error", { msg: err.message });
  });

  server.listen(config.board.port, config.board.host, () => {
    log("board endpoint ready", {
      host: config.board.host,
      port: config.board.port,
    });
  });

  server.unref();
}
