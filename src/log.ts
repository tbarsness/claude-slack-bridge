import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

let stream: WriteStream | null = null;

function ensureStream(logDir: string): WriteStream {
  if (stream) return stream;
  mkdirSync(logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  stream = createWriteStream(join(logDir, `${date}.log`), { flags: "a" });
  return stream;
}

export function initLog(logDir: string): void {
  ensureStream(logDir);
}

export function log(...parts: unknown[]): void {
  const line =
    `[${new Date().toISOString()}] ` +
    parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
      .join(" ") +
    "\n";
  process.stdout.write(line);
  if (stream) stream.write(line);
}
