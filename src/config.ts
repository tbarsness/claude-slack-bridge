import "dotenv/config";
import { resolve } from "node:path";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function parseAssistants(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, dir] = entry.split(":").map((s) => s.trim());
    if (!name || !dir) {
      throw new Error(
        `ASSISTANTS entry "${entry}" must be "name:absolute-path"`,
      );
    }
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new Error(
        `ASSISTANTS name "${name}" must be lowercase alphanumeric (slash command compatible)`,
      );
    }
    out[name] = resolve(dir);
  }
  if (Object.keys(out).length === 0) {
    throw new Error("ASSISTANTS must declare at least one assistant");
  }
  return out;
}

function parseChannelAssistants(
  raw: string | undefined,
  assistants: Record<string, string>,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [channelId, name] = entry.split(":").map((s) => s.trim());
    if (!channelId || !name) {
      throw new Error(
        `CHANNEL_ASSISTANTS entry "${entry}" must be "channelId:assistantName"`,
      );
    }
    if (!assistants[name]) {
      throw new Error(
        `CHANNEL_ASSISTANTS references unknown assistant "${name}"`,
      );
    }
    out[channelId] = name;
  }
  return out;
}

const assistants = parseAssistants(required("ASSISTANTS"));
const defaultAssistantRaw = process.env.DEFAULT_ASSISTANT?.trim();
const defaultAssistant =
  defaultAssistantRaw && defaultAssistantRaw !== ""
    ? defaultAssistantRaw
    : undefined;
if (defaultAssistant && !assistants[defaultAssistant]) {
  throw new Error(
    `DEFAULT_ASSISTANT "${defaultAssistant}" not found in ASSISTANTS`,
  );
}

export const config = {
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
    signingSecret: required("SLACK_SIGNING_SECRET"),
  },
  allowedUserIds: required("ALLOWED_USER_IDS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  assistants,
  defaultAssistant,
  channelAssistants: parseChannelAssistants(
    process.env.CHANNEL_ASSISTANTS,
    assistants,
  ),
  claude: {
    systemPrompt: process.env.CLAUDE_SYSTEM_PROMPT,
    model: process.env.CLAUDE_MODEL,
  },
  sessionsFile: resolve(optional("SESSIONS_FILE", "./sessions.json")),
  logDir: resolve(optional("LOG_DIR", "./logs")),
};
