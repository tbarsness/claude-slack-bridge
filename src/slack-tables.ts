/**
 * Slack keeps a message's table only in its `table` block: the plain `text`
 * field the bridge reads leaves it out entirely, so a table Tim (or the Claude
 * app on his behalf) posted reached the assistant as a gap. This renders each
 * table block as a markdown table so it can ride along in the prompt.
 */

type Element = { type?: unknown; text?: unknown; url?: unknown; name?: unknown; elements?: unknown };

// The visible text of one rich_text element, walking nested sections.
function elementText(el: Element): string {
  switch (el.type) {
    case "text":
      return typeof el.text === "string" ? el.text : "";
    case "link": {
      const url = typeof el.url === "string" ? el.url : "";
      return typeof el.text === "string" && el.text ? `${el.text} (${url})` : url;
    }
    case "emoji":
      return typeof el.name === "string" ? `:${el.name}:` : "";
    default:
      return Array.isArray(el.elements) ? (el.elements as Element[]).map(elementText).join("") : "";
  }
}

function cellText(cell: unknown): string {
  const text = elementText((cell ?? {}) as Element);
  return text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

export function slackTablesAsMarkdown(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return [];
  const tables: string[] = [];
  for (const block of blocks as { type?: unknown; rows?: unknown }[]) {
    if (block?.type !== "table" || !Array.isArray(block.rows) || !block.rows.length) continue;
    const rows = (block.rows as unknown[]).filter(Array.isArray).map((r) => (r as unknown[]).map(cellText));
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    tables.push([line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n"));
  }
  return tables;
}
