import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

export interface RunResult {
  text: string;
  sessionId: string | null;
  error?: string;
}

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
): Promise<RunResult> {
  const options: Options = {
    cwd: config.claude.workingDir,
    permissionMode: "bypassPermissions",
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

  try {
    for await (const msg of query({ prompt, options })) {
      const m = msg as { type: string; session_id?: string; message?: unknown };
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
  }

  return { text: text.trim(), sessionId };
}
