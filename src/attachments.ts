import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * Subset of fields we use from the Slack `file` object.
 * See https://api.slack.com/types/file
 */
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface DownloadedAttachment {
  /** Absolute path to the saved file. */
  path: string;
  /** Original filename from Slack (best effort). */
  name: string;
  /** MIME type reported by Slack. */
  mimetype: string;
  /** Bytes written to disk. */
  size: number;
}

/** Skip files larger than this; Slack itself caps uploads but be defensive. */
const MAX_BYTES = 50 * 1024 * 1024;

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return cleaned || "file";
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  // Slack voice clips — transcribed locally, see transcribe.ts.
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
};

function ensureExtension(name: string, mimetype: string): string {
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  const ext = MIME_EXT[mimetype];
  return ext ? `${name}.${ext}` : name;
}

type FetchResult =
  | { ok: true; buf: Buffer; contentType: string }
  | { ok: false; reason: string };

/**
 * Fetch one file into memory with the checks every download path needs: HTTP
 * status, an HTML page served in place of the file, and the size cap. Logs
 * and returns a reason instead of throwing. Callers choose the headers, so
 * only the Slack path ever sends the bot token. `htmlHint`, when given, is
 * appended to the HTML-response log line to say what usually causes it.
 */
async function fetchFileBuffer(
  url: string,
  init: RequestInit,
  ctx: Record<string, unknown>,
  htmlHint?: string,
): Promise<FetchResult> {
  const res = await fetch(url, init);
  if (!res.ok) {
    log("attachment fetch failed", { ...ctx, status: res.status });
    return { ok: false, reason: `HTTP ${res.status}` };
  }

  // A server can answer HTTP 200 with an HTML page (a login or error page)
  // instead of the file. Saving that as `image.png` later causes the API to
  // reject the request with "Could not process image". Detect and skip.
  const contentType = res.headers.get("content-type") ?? "";
  if (/^text\/html\b/i.test(contentType)) {
    log(`attachment fetch returned HTML${htmlHint ? ` (${htmlHint})` : ""}`, {
      ...ctx,
      contentType,
    });
    return { ok: false, reason: "server returned an HTML page, not a file" };
  }

  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    log("attachment skipped (too large)", { ...ctx, size: declared });
    return { ok: false, reason: `larger than ${MAX_BYTES} bytes` };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    log("attachment skipped (too large after fetch)", {
      ...ctx,
      size: buf.byteLength,
    });
    return { ok: false, reason: `larger than ${MAX_BYTES} bytes` };
  }

  return { ok: true, buf, contentType };
}

/**
 * Download every Slack file attached to a message into a thread-scoped
 * folder under the assistant's working directory. Files are private to the
 * Slack workspace, so we authenticate downloads with the bot token.
 *
 * Files that fail to download are skipped (logged); we never throw — a
 * missing attachment shouldn't block the rest of the turn.
 */
export async function downloadAttachments(
  files: SlackFile[],
  workingDir: string,
  channelId: string,
  threadTs: string,
): Promise<DownloadedAttachment[]> {
  if (!files.length) return [];

  const destDir = resolve(
    workingDir,
    ".slack-uploads",
    `${channelId}-${threadTs}`,
  );
  await mkdir(destDir, { recursive: true });

  const out: DownloadedAttachment[] = [];

  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      log("attachment skipped (no url)", { id: file.id, name: file.name });
      continue;
    }
    if (typeof file.size === "number" && file.size > MAX_BYTES) {
      log("attachment skipped (too large)", {
        id: file.id,
        name: file.name,
        size: file.size,
      });
      continue;
    }

    try {
      const fetched = await fetchFileBuffer(
        url,
        { headers: { Authorization: `Bearer ${config.slack.botToken}` } },
        { id: file.id, name: file.name },
        // Slack serves its HTML login page with HTTP 200 when the bot lacks
        // `files:read`.
        "check bot has files:read scope",
      );
      if (!fetched.ok) continue;
      const buf = fetched.buf;

      const baseName = sanitizeName(file.name ?? file.title ?? "file");
      const mimetype = file.mimetype ?? "application/octet-stream";
      const finalName = ensureExtension(baseName, mimetype);
      const prefix = file.id ? `${file.id}-` : "";
      const filePath = join(destDir, `${prefix}${finalName}`);
      await writeFile(filePath, buf);

      out.push({
        path: filePath,
        name: file.name ?? finalName,
        mimetype,
        size: buf.byteLength,
      });

      log("attachment saved", {
        id: file.id,
        path: filePath,
        bytes: buf.byteLength,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("attachment error", { id: file.id, name: file.name, msg });
    }
  }

  return out;
}

/**
 * Build a short block to append to the user's prompt, telling Claude where
 * the downloaded files live so it can decide whether to Read them.
 */
export function formatAttachmentsForPrompt(
  attachments: DownloadedAttachment[],
): string {
  if (!attachments.length) return "";
  const lines = attachments.map(
    (a) => `- ${a.path} (${a.mimetype}, ${a.size} bytes)`,
  );
  return [
    "",
    "",
    "[Files attached in Slack — saved locally. Use the Read tool to view them:]",
    ...lines,
  ].join("\n");
}

/** The board's own host. Images are served from its `/uploads/` path. */
const BOARD_ORIGIN = "https://work.timbarsness.com";

/**
 * Origins whose `/uploads/` the bridge will fetch board images from: the
 * board's public host, plus wherever BOARD_API_URL points if that is another
 * name for it (the .ts.net host, a dev box).
 */
export function boardImageOrigins(): string[] {
  const origins = [BOARD_ORIGIN];
  if (config.board.apiUrl) {
    try {
      const o = new URL(config.board.apiUrl).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch {
      // A malformed BOARD_API_URL already breaks heartbeats; ignore it here.
    }
  }
  return origins;
}

/**
 * True only for a URL under `/uploads/` on one of the allowed origins. A
 * dispatch body names URLs for the bridge to fetch from this machine, so
 * anything else (another host, another path on the board, embedded
 * credentials) is refused before any request is made.
 */
export function isBoardUploadUrl(raw: string, allowedOrigins: string[]): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (!allowedOrigins.includes(u.origin)) return false;
  // URL parsing has already resolved any `..` segments.
  return u.pathname.startsWith("/uploads/");
}

export interface FailedImage {
  url: string;
  reason: string;
}

export interface BoardImages {
  saved: DownloadedAttachment[];
  failed: FailedImage[];
}

/**
 * Download the images in a board message into a card-scoped folder under the
 * assistant's working directory (`.slack-uploads/` is gitignored in every
 * assistant repo). Board uploads are public on the tailnet, so no
 * Authorization header is sent; the Slack bot token never leaves for here.
 *
 * Never throws: an image that cannot be fetched is returned in `failed` so
 * the prompt can say so and the run still starts.
 */
export async function downloadBoardImages(
  urls: string[],
  workingDir: string,
  taskDocumentId: string,
  allowedOrigins: string[] = boardImageOrigins(),
): Promise<BoardImages> {
  const unique = [...new Set(urls)];
  if (!unique.length) return { saved: [], failed: [] };

  const destDir = resolve(
    workingDir,
    ".slack-uploads",
    `board-${sanitizeName(taskDocumentId)}`,
  );

  // Filled by URL index, then compacted, so both lists keep the order the
  // URLs came in however the fetches finish.
  const savedAt: (DownloadedAttachment | undefined)[] = [];
  const failedAt: (FailedImage | undefined)[] = [];
  const toFetch: number[] = [];

  for (const [i, url] of unique.entries()) {
    if (isBoardUploadUrl(url, allowedOrigins)) {
      toFetch.push(i);
      continue;
    }
    log("board image refused (not a board upload)", { url });
    failedAt[i] = { url, reason: "not a board upload URL; not fetched" };
  }

  if (toFetch.length) {
    let dirError: string | undefined;
    try {
      await mkdir(destDir, { recursive: true });
    } catch (err) {
      dirError = err instanceof Error ? err.message : String(err);
    }

    if (dirError !== undefined) {
      for (const i of toFetch) {
        const url = unique[i]!;
        log("board image error", { url, msg: dirError });
        failedAt[i] = { url, reason: dirError };
      }
    } else {
      let next = 0;
      const worker = async () => {
        while (next < toFetch.length) {
          const i = toFetch[next++]!;
          const outcome = await saveBoardImage(unique[i]!, i, destDir);
          if ("saved" in outcome) savedAt[i] = outcome.saved;
          else failedAt[i] = outcome.failed;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(BOARD_FETCH_CONCURRENCY, toFetch.length) }, worker),
      );
    }
  }

  return {
    saved: savedAt.filter((a): a is DownloadedAttachment => a !== undefined),
    failed: failedAt.filter((f): f is FailedImage => f !== undefined),
  };
}

/** How many board images are fetched at once. */
const BOARD_FETCH_CONCURRENCY = 4;

/**
 * Fetch one allowed board image and save it as `${i + 1}-<name>` in
 * `destDir`, which already exists. Never throws.
 */
async function saveBoardImage(
  url: string,
  i: number,
  destDir: string,
): Promise<{ saved: DownloadedAttachment } | { failed: FailedImage }> {
  try {
    const fetched = await fetchFileBuffer(
      url,
      // A redirect could lead off the board; refuse rather than follow.
      { redirect: "error", signal: AbortSignal.timeout(30_000) },
      { url },
    );
    if (!fetched.ok) return { failed: { url, reason: fetched.reason } };

    const mimetype =
      fetched.contentType.split(";")[0]!.trim() || "application/octet-stream";
    let base = "image";
    try {
      base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    } catch {
      // Undecodable name: fall back to "image".
    }
    const finalName = ensureExtension(sanitizeName(base || "image"), mimetype);
    const filePath = join(destDir, `${i + 1}-${finalName}`);
    await writeFile(filePath, fetched.buf);

    log("board image saved", { url, path: filePath, bytes: fetched.buf.byteLength });
    return {
      saved: {
        path: filePath,
        name: base || finalName,
        mimetype,
        size: fetched.buf.byteLength,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("board image error", { url, msg });
    return { failed: { url, reason: msg } };
  }
}

/**
 * The prompt block for a board message's images: where they were saved, an
 * instruction to look at them before replying, and any that could not be
 * fetched, so the assistant says so in the thread instead of guessing.
 */
export function formatBoardImagesForPrompt(images: BoardImages): string {
  const { saved, failed } = images;
  if (!saved.length && !failed.length) return "";
  const lines = ["", ""];
  if (saved.length) {
    lines.push(
      "[Images attached to Tim's message, saved locally. Use the Read tool to view every one of them before you reply:]",
      ...saved.map((a) => `- ${a.path} (${a.mimetype}, ${a.size} bytes)`),
    );
  }
  if (failed.length) {
    if (saved.length) lines.push("");
    lines.push(
      "[Images in Tim's message that could not be downloaded. Say so in the thread rather than guessing what they show:]",
      ...failed.map((f) => `- ${f.url} (${f.reason})`),
    );
  }
  return lines.join("\n");
}
