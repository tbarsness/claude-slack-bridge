import { test } from "node:test";
import assert from "node:assert/strict";
import { slackTablesAsMarkdown } from "./slack-tables.js";

/** A table cell as Slack delivers it: a rich_text block holding one section. */
const cell = (...parts: Record<string, unknown>[]) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: parts }],
});
const t = (text: string) => ({ type: "text", text });

test("a table block becomes a markdown table, header first", () => {
  const blocks = [
    { type: "rich_text", elements: [] },
    {
      type: "table",
      rows: [
        [cell(t("Date")), cell(t("Merchant")), cell(t("Amount"))],
        [cell(t("2026-10-25")), cell(t("Oak Fare & Refreshment")), cell(t("$127.21"))],
      ],
    },
  ];
  assert.deepEqual(slackTablesAsMarkdown(blocks), [
    "| Date | Merchant | Amount |\n| --- | --- | --- |\n| 2026-10-25 | Oak Fare & Refreshment | $127.21 |",
  ]);
});

test("links, mentions and emoji inside a cell keep their text, and pipes are escaped", () => {
  const blocks = [
    {
      type: "table",
      rows: [
        [cell(t("Where"))],
        [cell({ type: "link", url: "https://x.test", text: "site" }, t(" a|b "), { type: "emoji", name: "coffee" })],
        [cell({ type: "link", url: "https://y.test" })],
      ],
    },
  ];
  assert.deepEqual(slackTablesAsMarkdown(blocks), [
    "| Where |\n| --- |\n| site (https://x.test) a\\|b :coffee: |\n| https://y.test |",
  ]);
});

test("no blocks, no tables, or a malformed table give nothing", () => {
  assert.deepEqual(slackTablesAsMarkdown(undefined), []);
  assert.deepEqual(slackTablesAsMarkdown([{ type: "rich_text", elements: [] }]), []);
  assert.deepEqual(slackTablesAsMarkdown([{ type: "table", rows: "nope" }]), []);
});
