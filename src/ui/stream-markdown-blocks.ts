/** Publication boundaries only; Markdown syntax remains owned by the host.
 * An unfinished fence/list stays in the tail until its boundary is known. */
export function splitStreamMarkdown(text: string, finished = false): string[] {
  // Definitions and raw HTML may affect earlier blocks; preserve their native
  // rendering context rather than claiming a false independent boundary.
  if (/^ {0,3}\[[^\]\n]+\]:/mu.test(text) || /<(?:div|table|details|pre|script|style)\b/iu.test(text)) return [text];
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const blocks: string[] = [];
  let start = 0, offset = 0, fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/u, ""), marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    offset += lines[i].length;
    if (fence || line.trim() || i + 1 >= lines.length) continue;
    const next = lines.slice(i + 1).find(candidate => candidate.trim());
    if (!next) continue;
    const block = text.slice(start, offset), list = /^\s*(?:[-+*]|\d+[.)])\s/u.test(block.trimStart());
    if (list && /^(?:\s+(?:\S)| {0,3}(?:[-+*]|\d+[.)])\s)/u.test(next)) continue;
    // An unindented empty line is legal inside one indented code block.
    if (/^(?: {4}|\t)/u.test(block) && /^(?: {4}|\t)/u.test(next)) continue;
    blocks.push(block); start = offset;
  }
  // Always retain one tail slot, even when empty. Completion can native-render
  // that tail without removing any already published block.
  if (start < text.length || !blocks.length || finished) blocks.push(text.slice(start));
  return blocks;
}
