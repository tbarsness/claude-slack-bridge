import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// config.ts runs at import time: it reads `.env` from the cwd and throws on a
// missing required var. Point it at dummy values from an empty directory so
// the tests never load the live bridge's secrets or depend on its settings.
const envDir = await mkdtemp(join(tmpdir(), "bridge-test-env-"));
const originalCwd = process.cwd();
delete process.env.SHARED_ENV_FILE;
for (const name of ["PEER_ASSISTANTS", "DEFAULT_ASSISTANT", "CHANNEL_ASSISTANTS", "BOARD_API_URL"]) {
  delete process.env[name];
}
Object.assign(process.env, {
  ASSISTANTS: `ivy:${envDir}`,
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SLACK_SIGNING_SECRET: "test-secret",
  ALLOWED_USER_IDS: "U000TEST",
});
process.chdir(envDir);
const { isBoardUploadUrl, formatBoardImagesForPrompt, downloadBoardImages } =
  await import("./attachments.js");
const { mergeQueued } = await import("./board-endpoint.js");
process.chdir(originalCwd);
await rm(envDir, { recursive: true, force: true });

const BOARD = ["https://work.timbarsness.com"];

test("isBoardUploadUrl accepts an upload on the board origin", () => {
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads/a.png", BOARD), true);
});

test("isBoardUploadUrl refuses another host", () => {
  assert.equal(isBoardUploadUrl("https://evil.example.com/uploads/a.png", BOARD), false);
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com.evil.com/uploads/a.png", BOARD), false);
});

test("isBoardUploadUrl refuses an http URL when only https is allowed", () => {
  assert.equal(isBoardUploadUrl("http://work.timbarsness.com/uploads/a.png", BOARD), false);
});

test("isBoardUploadUrl refuses traversal out of /uploads/", () => {
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads/../x", BOARD), false);
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads/%2e%2e/x", BOARD), false);
});

test("isBoardUploadUrl refuses an encoded slash standing in for /uploads/", () => {
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads%2Fa.png", BOARD), false);
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads/..%2Fx", BOARD), false);
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploads/..%5cx", BOARD), false);
});

test("isBoardUploadUrl refuses embedded credentials", () => {
  assert.equal(isBoardUploadUrl("https://u:p@work.timbarsness.com/uploads/a.png", BOARD), false);
  assert.equal(isBoardUploadUrl("https://u@work.timbarsness.com/uploads/a.png", BOARD), false);
});

test("isBoardUploadUrl refuses a non-/uploads path on the board", () => {
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/api/tasks", BOARD), false);
  assert.equal(isBoardUploadUrl("https://work.timbarsness.com/uploadsx/a.png", BOARD), false);
});

test("isBoardUploadUrl refuses malformed and relative URLs", () => {
  assert.equal(isBoardUploadUrl("not a url", BOARD), false);
  assert.equal(isBoardUploadUrl("", BOARD), false);
  assert.equal(isBoardUploadUrl("/uploads/a.png", BOARD), false);
  assert.equal(isBoardUploadUrl("uploads/a.png", BOARD), false);
});

const SAVED_HEADER =
  "[Images attached to Tim's message, saved locally. Use the Read tool to view every one of them before you reply:]";
const FAILED_HEADER =
  "[Images in Tim's message that could not be downloaded. Say so in the thread rather than guessing what they show:]";
const savedImage = { path: "/w/.slack-uploads/board-x/1-a.png", name: "a.png", mimetype: "image/png", size: 42 };
const failedImage = { url: "https://work.timbarsness.com/uploads/b.png", reason: "HTTP 404" };

test("formatBoardImagesForPrompt with nothing is empty", () => {
  assert.equal(formatBoardImagesForPrompt({ saved: [], failed: [] }), "");
});

test("formatBoardImagesForPrompt with saved images only", () => {
  assert.equal(
    formatBoardImagesForPrompt({ saved: [savedImage], failed: [] }),
    ["", "", SAVED_HEADER, "- /w/.slack-uploads/board-x/1-a.png (image/png, 42 bytes)"].join("\n"),
  );
});

test("formatBoardImagesForPrompt with failed images only", () => {
  assert.equal(
    formatBoardImagesForPrompt({ saved: [], failed: [failedImage] }),
    ["", "", FAILED_HEADER, "- https://work.timbarsness.com/uploads/b.png (HTTP 404)"].join("\n"),
  );
});

test("formatBoardImagesForPrompt with both separates the blocks", () => {
  assert.equal(
    formatBoardImagesForPrompt({ saved: [savedImage], failed: [failedImage] }),
    [
      "",
      "",
      SAVED_HEADER,
      "- /w/.slack-uploads/board-x/1-a.png (image/png, 42 bytes)",
      "",
      FAILED_HEADER,
      "- https://work.timbarsness.com/uploads/b.png (HTTP 404)",
    ].join("\n"),
  );
});

test("mergeQueued merges images in order without duplicates", () => {
  const merged = mergeQueued([
    { assistant: "ivy", taskDocumentId: "t1", messageBody: "one", images: ["u/a", "u/b"] },
    { assistant: "ivy", taskDocumentId: "t1", messageBody: "two" },
    { assistant: "ivy", taskDocumentId: "t1", messageBody: "three", images: ["u/b", "u/c", "u/a"] },
  ]);
  assert.deepEqual(merged.images, ["u/a", "u/b", "u/c"]);
  assert.equal(merged.messageBody, "one\n\ntwo\n\nthree");
  assert.equal(merged.trigger, "message");
});

test("mergeQueued leaves no images key when no body had images", () => {
  const merged = mergeQueued([
    { assistant: "ivy", taskDocumentId: "t1", messageBody: " first " },
    { assistant: "ivy", taskDocumentId: "t1", messageBody: "" },
    { assistant: "ivy", taskDocumentId: "t1", messageBody: "second", images: [] },
  ]);
  assert.equal("images" in merged, false);
  assert.equal(merged.messageBody, "first\n\nsecond");
});

test("downloadBoardImages saves allowed images in order and refuses the rest", async (t) => {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (req.url === "/uploads/a.png") {
      res.writeHead(200, { "content-type": "image/png" }).end("PNGDATA");
    } else if (req.url === "/uploads/b.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" }).end("JPGDATA");
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("nope");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const workingDir = await mkdtemp(join(tmpdir(), "bridge-test-board-"));
  t.after(() => rm(workingDir, { recursive: true, force: true }));

  // Same server under another origin string: must be refused without a request.
  const notAllowed = `http://localhost:${port}/uploads/c.png`;
  const result = await downloadBoardImages(
    [`${origin}/uploads/a.png`, `${origin}/uploads/b.jpg`, `${origin}/uploads/missing.png`, notAllowed],
    workingDir,
    "task 1",
    [origin],
  );

  const dir = join(workingDir, ".slack-uploads", "board-task_1");
  assert.deepEqual(
    result.saved.map((s) => s.path),
    [join(dir, "1-a.png"), join(dir, "2-b.jpg")],
  );
  assert.deepEqual(result.saved.map((s) => s.mimetype), ["image/png", "image/jpeg"]);
  assert.equal(await readFile(join(dir, "1-a.png"), "utf8"), "PNGDATA");
  assert.equal(await readFile(join(dir, "2-b.jpg"), "utf8"), "JPGDATA");

  assert.deepEqual(result.failed, [
    { url: `${origin}/uploads/missing.png`, reason: "HTTP 404" },
    { url: notAllowed, reason: "not a board upload URL; not fetched" },
  ]);

  assert.deepEqual(
    seen.map((s) => s.url).sort(),
    ["/uploads/a.png", "/uploads/b.jpg", "/uploads/missing.png"],
  );
  assert.equal(seen.some((s) => s.url === "/uploads/c.png"), false);
  for (const s of seen) assert.equal(s.headers.authorization, undefined);
});
