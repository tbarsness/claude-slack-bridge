import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { log } from "./log.js";

export interface RunResult {
  text: string;
  sessionId: string | null;
  error?: string;
}

const RUN_TIMEOUT_MS = 5 * 60 * 1000;

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
): Promise<RunResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);

  const options: Options = {
    cwd: workingDir,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController: ac,
    stderr: (data) => log("sdk stderr", data.trim()),
  };
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
      if (m.session_id && !sessionId) {
        sessionId = m.session_id;
      }
      if (m.type === "assistant") {
        text += extractText(m.message);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text, sessionId, error: message };
  } finally {
    clearTimeout(timer);
  }

  return { text: text.trim(), sessionId };
}
