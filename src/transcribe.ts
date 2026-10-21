import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { config } from "./config.js";
import { log } from "./log.js";
import type { DownloadedAttachment } from "./attachments.js";

const execFileAsync = promisify(execFile);

/**
 * Slack voice clips ("audio clips") arrive as ordinary file attachments.
 * Claude can't read audio, so we transcribe locally with whisper.cpp and
 * hand the text to the model instead. Everything stays on this Mac — the
 * audio is never sent to a third-party transcription service.
 */

/** Audio mimetypes we attempt to transcribe. Slack clips are mp4/m4a. */
const AUDIO_MIME = /^audio\/|^video\/mp4$|^video\/quicktime$/i;

/** Extensions we treat as audio when Slack's mimetype is unhelpful. */
const AUDIO_EXT = /\.(m4a|mp3|mp4|wav|aac|ogg|opus|webm|caf|aiff?)$/i;

export function isAudioAttachment(a: DownloadedAttachment): boolean {
  return AUDIO_MIME.test(a.mimetype) || AUDIO_EXT.test(a.path);
}

export interface Transcript {
  /** Absolute path of the source audio file. */
  path: string;
  /** Original Slack filename. */
  name: string;
  /** Transcribed text, trimmed. Empty when nothing intelligible was found. */
  text: string;
}

/**
 * Convert arbitrary audio to the 16 kHz mono WAV whisper.cpp expects.
 * Uses macOS's built-in `afconvert` so we don't depend on ffmpeg.
 * Returns the temp WAV path.
 */
async function toWav16k(src: string): Promise<string> {
  const out = `${src}.16k.wav`;
  await execFileAsync(
    "/usr/bin/afconvert",
    ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, out],
    { timeout: config.transcription.timeoutMs },
  );
  return out;
}

/**
 * Transcribe one audio file. Returns "" if transcription fails or the clip
 * is silent — callers keep going either way, since a failed transcript
 * should never sink the whole turn.
 */
export async function transcribeFile(src: string): Promise<string> {
  let wav: string | undefined;
  try {
    wav = await toWav16k(src);
    const { stdout } = await execFileAsync(
      config.transcription.binary,
      [
        "-m", config.transcription.model,
        "-f", wav,
        "--no-timestamps",
        "--no-prints",
        "--language", "en",
      ],
      { timeout: config.transcription.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("transcription failed", { src, msg });
    return "";
  } finally {
    if (wav) await unlink(wav).catch(() => {});
  }
}

/**
 * Transcribe every audio attachment in the list. Non-audio files are
 * ignored. Runs sequentially: whisper saturates the CPU, and a Slack turn
 * rarely carries more than one clip.
 */
export async function transcribeAudioAttachments(
  attachments: DownloadedAttachment[],
): Promise<Transcript[]> {
  if (!config.transcription.enabled) return [];

  const audio = attachments.filter(isAudioAttachment);
  if (!audio.length) return [];

  const out: Transcript[] = [];
  for (const a of audio) {
    const started = Date.now();
    const text = await transcribeFile(a.path);
    log("transcribed", {
      name: a.name,
      bytes: a.size,
      chars: text.length,
      ms: Date.now() - started,
    });
    if (text) out.push({ path: a.path, name: a.name, text });
  }
  return out;
}

/**
 * Render transcripts for the prompt. The transcript is presented as the
 * user's actual message so the assistant treats a voice note exactly like
 * a typed one.
 */
export function formatTranscriptsForPrompt(transcripts: Transcript[]): string {
  if (!transcripts.length) return "";
  const blocks = transcripts.map((t) =>
    [`[Voice message — transcribed from ${t.name}:]`, t.text].join("\n"),
  );
  return ["", "", ...blocks].join("\n");
}
