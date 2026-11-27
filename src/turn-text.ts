/**
 * A turn's reply is every assistant message the SDK streams, and each one is a
 * separate thought ("Continuing now." then "Working." then "Now let me query").
 * Gluing them end to end ran sentences together in Slack, so each message, and
 * each text block within one, becomes its own paragraph.
 */

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { content?: unknown };
  if (!Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const block of m.content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        parts.push(b.text.trim());
      }
    }
  }
  return parts.join("\n\n");
}

export function appendParagraph(text: string, next: string): string {
  if (!next) return text;
  return text ? `${text}\n\n${next}` : next;
}
