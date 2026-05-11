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
};

function ensureExtension(name: string, mimetype: string): string {
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name;
  const ext = MIME_EXT[mimetype];
  return ext ? `${name}.${ext}` : name;
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
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.slack.botToken}` },
      });
      if (!res.ok) {
        log("attachment fetch failed", {
          id: file.id,
          name: file.name,
          status: res.status,
        });
        continue;
      }

      // Slack returns HTTP 200 with an HTML login page when the bot lacks
      // `files:read`. Saving that as `image.png` later causes the API to
      // reject the request with "Could not process image". Detect and skip.
      const contentType = res.headers.get("content-type") ?? "";
      if (/^text\/html\b/i.test(contentType)) {
        log("attachment fetch returned HTML (check bot has files:read scope)", {
          id: file.id,
          name: file.name,
          contentType,
        });
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        log("attachment skipped (too large after fetch)", {
          id: file.id,
          name: file.name,
          size: buf.byteLength,
        });
        continue;
      }

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
