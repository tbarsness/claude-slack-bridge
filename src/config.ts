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
  claude: {
    workingDir: resolve(required("CLAUDE_WORKING_DIR")),
    systemPrompt: process.env.CLAUDE_SYSTEM_PROMPT,
    model: process.env.CLAUDE_MODEL,
  },
  sessionsFile: resolve(optional("SESSIONS_FILE", "./sessions.json")),
  logDir: resolve(optional("LOG_DIR", "./logs")),
};
