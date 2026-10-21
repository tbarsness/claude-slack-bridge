import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Bridge-specific settings load first, so anything defined here wins.
loadEnv();
// Shared fjorge MCP secrets (Bill.com, QuickBooks, HubSpot, ...) live in one
// canonical .env so a rotated token only has to be edited in a single place.
// Point SHARED_ENV_FILE at it; dotenv will not overwrite anything set above.
if (process.env.SHARED_ENV_FILE) {
  loadEnv({ path: process.env.SHARED_ENV_FILE });
}

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

function parsePeerAssistants(
  raw: string | undefined,
  hosted: Record<string, string>,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
      throw new Error(
        `PEER_ASSISTANTS name "${name}" must be lowercase alphanumeric`,
      );
    }
    if (hosted[name]) {
      throw new Error(
        `PEER_ASSISTANTS name "${name}" is also in ASSISTANTS; list each name in only one var`,
      );
    }
    out.push(name);
  }
  return out;
}

const assistants = parseAssistants(required("ASSISTANTS"));
const peerAssistants = parsePeerAssistants(
  process.env.PEER_ASSISTANTS,
  assistants,
);
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
  peerAssistants,
  knownAssistantNames: [...Object.keys(assistants), ...peerAssistants],
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
  transcription: {
    // Slack voice clips are transcribed locally with whisper.cpp so the
    // audio never leaves this machine. Set TRANSCRIPTION_ENABLED=false to
    // fall back to passing the raw file path through to the assistant.
    enabled: optional("TRANSCRIPTION_ENABLED", "true") !== "false",
    binary: optional("WHISPER_BIN", "/opt/homebrew/bin/whisper-cli"),
    model: optional(
      "WHISPER_MODEL",
      resolve(
        process.env.HOME ?? "",
        ".local/share/whisper-models/ggml-small.en.bin",
      ),
    ),
    timeoutMs: Number(optional("TRANSCRIPTION_TIMEOUT_MS", "180000")),
    // Post the transcript of an inbound voice memo back into the thread so
    // Slack search can index the words, not just store the audio.
    postTranscript: optional("POST_TRANSCRIPT", "true") !== "false",
  },
  speech: {
    // Replies wrapped in [VOICE: ...] are spoken as well as written.
    enabled: optional("SPEECH_ENABLED", "true") !== "false",
    voice: optional("SPEECH_VOICE", "Samantha"),
    rate: Number(optional("SPEECH_RATE", "185")),
    timeoutMs: Number(optional("SPEECH_TIMEOUT_MS", "60000")),
  },
  board: {
    // Dispatches from work.timbarsness.com: a thread message from Tim, or the
    // button in the card drawer. Bind to the Tailscale address; a dispatch
    // runs an agent with bypassPermissions, so the LAN must never see it.
    enabled: optional("BOARD_ENDPOINT_ENABLED", "true") !== "false",
    host: optional("BOARD_BIND_HOST", "127.0.0.1"),
    port: Number(optional("BOARD_PORT", "8738")),
    secret: optional("BOARD_SECRET", ""),
    // Where to write heartbeats back to, e.g. https://work.timbarsness.com/api
    apiUrl: optional("BOARD_API_URL", "").replace(/\/+$/, ""),
  },
  voice: {
    // Hands-free endpoint for the "Hey Siri, Jude" iOS Shortcut. Bind to the
    // Tailscale address so it is never exposed on the LAN; the shared secret
    // is a second layer, not the only one.
    enabled: optional("VOICE_ENDPOINT_ENABLED", "true") !== "false",
    host: optional("VOICE_BIND_HOST", "127.0.0.1"),
    port: Number(optional("VOICE_PORT", "8737")),
    secret: optional("VOICE_SECRET", ""),
    assistant: optional("VOICE_ASSISTANT", "jude"),
  },
};
