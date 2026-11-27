import { test } from "node:test";
import assert from "node:assert/strict";
import { appendParagraph, messageText } from "./turn-text.js";

const msg = (...texts: string[]) => ({
  content: texts.map((text) => ({ type: "text", text })),
});

test("each assistant message becomes its own paragraph", () => {
  let text = "";
  for (const m of [msg("Continuing now."), msg("Working."), msg("Now let me query.")]) {
    text = appendParagraph(text, messageText(m));
  }
  assert.equal(text, "Continuing now.\n\nWorking.\n\nNow let me query.");
});

test("text blocks within one message are separated, tool blocks and blanks skipped", () => {
  const m = {
    content: [
      { type: "text", text: "First.\n" },
      { type: "tool_use", name: "Bash" },
      { type: "text", text: "  " },
      { type: "text", text: "Second." },
    ],
  };
  assert.equal(messageText(m), "First.\n\nSecond.");
});

test("a message with no text adds nothing", () => {
  assert.equal(appendParagraph("Done.", messageText({ content: [{ type: "tool_use" }] })), "Done.");
  assert.equal(messageText(null), "");
});
