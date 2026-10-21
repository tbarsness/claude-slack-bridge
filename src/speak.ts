import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { config } from "./config.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

/**
 * Text-to-speech for assistant replies. The assistant marks the part of a
 * reply it wants spoken with a `[VOICE: ...]` tag; we synthesize that text
 * to an m4a Slack can play inline, and leave the same words in the message
 * body so Slack search can find them.
 *
 * Keeping one tag as the source of both the audio and the text is the whole
 * point — they can never drift apart.
 */

/** Matches `[VOICE: spoken words]`, non-greedy, across newlines. */
const VOICE_TAG = /\[VOICE:\s*([\s\S]*?)\]/g;

/** Marker prefixed to spoken text in the posted message. */
const SPOKEN_PREFIX = ":studio_microphone:";

/**
 * Strip formatting that sounds wrong when read aloud. The assistant is told
 * to write clean prose in the tag, but markdown leaks in easily.
 */
function speakable(text: string): string {
  return text
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/[*_~#>]/g, "")
    .replace(/<https?:\/\/[^>|]+(?:\|([^>]+))?>/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SpokenSegment {
  /** The words, cleaned, as spoken and as posted. */
  text: string;
  /** Absolute path to the generated audio, or undefined if synthesis failed. */
  audioPath?: string;
}

/**
 * Pull `[VOICE: ...]` tags out of a reply.
 *
 * Returns the message text with each tag replaced by its spoken words
 * (prefixed with a mic marker so it reads as speech in the transcript), plus
 * the list of segments to synthesize.
 */
export function parseVoiceTags(text: string): {
  cleanText: string;
  segments: SpokenSegment[];
} {
  const segments: SpokenSegment[] = [];
  const cleanText = text.replace(VOICE_TAG, (_, raw: string) => {
    const spoken = speakable(raw);
    if (!spoken) return "";
    segments.push({ text: spoken });
    return `${SPOKEN_PREFIX} ${spoken}`;
  });
  return { cleanText, segments };
}

/**
 * Synthesize one string to an m4a. Returns the path, or undefined on
 * failure — a broken voice note should never cost the text reply.
 */
export async function synthesize(text: string): Promise<string | undefined> {
  if (!config.speech.enabled) return undefined;
  const dir = join(tmpdir(), "voice-replies");
  try {
    await mkdir(dir, { recursive: true });
    const out = join(
      dir,
      `reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`,
    );
    await execFileAsync(
      "/usr/bin/say",
      [
        "-v", config.speech.voice,
        "-r", String(config.speech.rate),
        "--data-format=aac",
        "-o", out,
        text,
      ],
      { timeout: config.speech.timeoutMs },
    );
    log("synthesized", { chars: text.length, path: out });
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("synthesis failed", { chars: text.length, msg });
    return undefined;
  }
}

/** Synthesize every segment in place. */
export async function synthesizeAll(
  segments: SpokenSegment[],
): Promise<SpokenSegment[]> {
  for (const seg of segments) {
    seg.audioPath = await synthesize(seg.text);
  }
  return segments;
}
