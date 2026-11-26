const SLACK_CHUNK_LIMIT = 3000;

/** Split a long reply into Slack-sized posts, preferring to break at a newline. */
export function chunk(text: string, max = SLACK_CHUNK_LIMIT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > i + max / 2) end = lastNewline;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
