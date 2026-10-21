import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

// Project-scoped .mcp.json files are a Claude Code CLI convention; the SDK
// does not auto-load them. Bridge sessions therefore saw none of a project's
// configured MCP servers (e.g. ms365 under huahua) until we started reading
// the file here and forwarding it in Options.mcpServers.
function loadProjectMcpServers(
  workingDir: string,
): Options["mcpServers"] | undefined {
  const path = resolvePath(workingDir, ".mcp.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    log("mcp load error", { path, error: (err as Error).message });
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Options["mcpServers"] };
    const servers = parsed.mcpServers;
    if (!servers || Object.keys(servers).length === 0) return undefined;
    // launchd starts us with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which can't
    // find npx/node from Homebrew. Stdio MCP servers like npx-based ones then
    // fail to spawn and their tools silently don't register. Prepend the
    // common Homebrew locations to every stdio server's env.PATH so they
    // behave the same as if launched from a user shell.
    const PATH_EXTRA = "/opt/homebrew/bin:/usr/local/bin";
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object") continue;
      const c = cfg as { type?: string; env?: Record<string, string> };
      if (c.type && c.type !== "stdio") continue;
      const env = (c.env = { ...(c.env ?? {}) });
      const existing = env.PATH ?? process.env.PATH ?? "";
      env.PATH = existing ? `${PATH_EXTRA}:${existing}` : PATH_EXTRA;
      log("mcp env patched", { server: name, PATH: env.PATH });
    }
    log("mcp loaded", { path, servers: Object.keys(servers) });
    return servers;
  } catch (err) {
    log("mcp parse error", { path, error: (err as Error).message });
    return undefined;
  }
}

export interface RunResult {
  text: string;
  sessionId: string | null;
  error?: string;
}

/** What the run is doing right now, for callers that show liveness. */
export interface Activity {
  /** SDK message type, e.g. "assistant", "user", "system". */
  type: string;
  subtype?: string;
  /** Messages seen so far, so a caller can show forward motion. */
  count: number;
}

export interface RunHooks {
  /**
   * Called on every message the SDK emits. Use it to prove the run is alive;
   * it fires often, so throttle anything expensive.
   */
  onActivity?: (activity: Activity) => void;
  /** Silence, in ms, before the run is treated as hung. */
  idleTimeoutMs?: number;
  /** Absolute ceiling regardless of activity. */
  maxTimeoutMs?: number;
}

/**
 * Two deadlines, not one.
 *
 * The old single 5-minute wall clock killed healthy work: a run that was
 * genuinely busy for six minutes was aborted mid-flight and reported as a
 * failure. But it was there for a real reason, recorded in voice-endpoint.ts:
 * the SDK has been seen to hang forever when its subprocess dies, emitting
 * nothing and never throwing.
 *
 * Idle time is what separates those two cases. A working run keeps emitting
 * messages; a dead one goes silent. So the clock that can kill a run is reset
 * on every message, and only silence trips it. MAX is a backstop for the
 * pathological case of a run that chatters forever without finishing.
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { content?: unknown };
  if (!Array.isArray(m.content)) return "";
  let out = "";
  for (const block of m.content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        out += b.text;
      }
    }
  }
  return out;
}

export async function runClaude(
  prompt: string,
  resume: string | undefined,
  workingDir: string,
  hooks: RunHooks = {},
): Promise<RunResult> {
  const idleMs = hooks.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxMs = hooks.maxTimeoutMs ?? MAX_TIMEOUT_MS;

  const ac = new AbortController();
  // Why the run was killed, so the caller can say which it was instead of
  // reporting the SDK's generic abort message.
  let killedBy: "idle" | "max" | null = null;

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      killedBy = "idle";
      ac.abort();
    }, idleMs);
  };
  resetIdle();

  const maxTimer = setTimeout(() => {
    killedBy = "max";
    ac.abort();
  }, maxMs);

  const options: Options = {
    cwd: workingDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController: ac,
    stderr: (data) => log("sdk stderr", data.trim()),
  };
  const projectMcp = loadProjectMcpServers(workingDir);
  if (projectMcp) {
    options.mcpServers = projectMcp;
  }
  if (config.claude.systemPrompt) {
    options.systemPrompt = config.claude.systemPrompt;
  }
  if (config.claude.model) {
    options.model = config.claude.model;
  }
  if (resume) {
    options.resume = resume;
  }

  let sessionId: string | null = null;
  let text = "";
  let seen = 0;

  // Claude Code subprocess interprets a leading `/` as a CLI slash command and
  // bails with no assistant output. Pad with a space so the prompt is always
  // treated as user text.
  const safePrompt = prompt.startsWith("/") ? " " + prompt : prompt;

  try {
    for await (const msg of query({ prompt: safePrompt, options })) {
      const m = msg as {
        type: string;
        session_id?: string;
        message?: unknown;
        subtype?: string;
      };
      log("sdk msg", { type: m.type, subtype: m.subtype });

      // Proof of life: push the idle deadline out and tell the caller. Done
      // before any parsing so a message we do not understand still counts as
      // the run being alive.
      resetIdle();
      seen += 1;
      if (hooks.onActivity) {
        try {
          hooks.onActivity({ type: m.type, subtype: m.subtype, count: seen });
        } catch (err) {
          // A caller's progress reporting must never kill the run itself.
          log("onActivity threw", {
            msg: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // `hook_started` / `hook_response` are emitted before `init` and carry a
      // throwaway session id that never gets a transcript on disk. Latching
      // onto it poisons the thread's stored session, so the NEXT message fails
      // with "No conversation found with session ID". `init` is authoritative.
      const isHookMsg =
        m.subtype === "hook_started" || m.subtype === "hook_response";
      if (m.session_id && !isHookMsg) {
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id;
        } else if (!sessionId) {
          sessionId = m.session_id;
        }
      }
      if (m.type === "assistant") {
        text += extractText(m.message);
      }

      // `result` is the SDK's end-of-turn message, and the iterator is
      // supposed to close right after it. It does not always: a project MCP
      // server that keeps its stdio transport open holds the stream open too,
      // so the loop sits here with nothing left to read until the idle
      // watchdog fires and reports a run that already finished as having gone
      // quiet. Both Huahua dispatches on 2026-10-13 died that way, ten minutes
      // after a `result: success`, and the card was marked failed with the
      // work done. Leave on the result itself rather than waiting for a close
      // that may never come.
      if (m.type === "result") break;
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // An abort reads as a generic error from the SDK, so name the real cause.
    const message =
      killedBy === "idle"
        ? `Went quiet for ${Math.round(idleMs / 60000)} minutes with no output, so I stopped waiting. Nothing was left half-finished on your side.`
        : killedBy === "max"
          ? `Ran past the ${Math.round(maxMs / 3600000)}-hour ceiling and was stopped.`
          : raw;
    // A failed run's session id is a fresh id the CLI minted and abandoned;
    // never hand it back for the caller to store.
    return { text, sessionId: null, error: message };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  }

  return { text: text.trim(), sessionId };
}
