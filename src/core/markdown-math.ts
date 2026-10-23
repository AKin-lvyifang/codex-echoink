/** Apply a text transform without changing fenced or inline code examples. */
export function mapMarkdownOutsideFences(text: string, transform: (text: string) => string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let fence: { marker: string; length: number } | null = null;
  let plain = "";
  let result = "";
  for (const line of lines) {
    const marker = line.match(/^[\t ]*(?:>[\t ]*)*(`{3,}|~{3,})([^\r\n]*)/u);
    if (fence) {
      result += line;
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      result += transform(plain) + line;
      plain = "";
      fence = { marker: marker[1][0], length: marker[1].length };
    } else {
      plain += line;
    }
  }
  return result + transform(plain);
}

export function mapMarkdownInlineCode(
  text: string,
  transform: (text: string) => string,
  codeTransform: (code: string, original: string) => string = (_code, original) => original
): string {
  const spans = /(`+)(?!`)([\s\S]*?)\1(?!`)/gu;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(spans)) {
    const start = match.index;
    if (start > 0 && text[start - 1] === "`") continue;
    result += transform(text.slice(cursor, start)) + codeTransform(match[2], match[0]);
    cursor = start + match[0].length;
  }
  return result + transform(text.slice(cursor));
}

/** Keep the stored/copyable answer unchanged; normalize only the render input. */
export function normalizeMarkdownMath(text: string): string {
  return mapMarkdownOutsideFences(text, (block) => mapMarkdownInlineCode(block, normalizeMathText));
}

function normalizeMathText(text: string): string {
  let result = "";
  let cursor = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    if (text[index] !== "\\" || text[index - 1] === "\\" || !["(", "["].includes(text[index + 1])) continue;
    const block = text[index + 1] === "[";
    const delimiter = block ? "\\]" : "\\)";
    let end = text.indexOf(delimiter, index + 2);
    while (end >= 0 && text[end - 1] === "\\") end = text.indexOf(delimiter, end + 2);
    if (end < 0) continue;
    const formula = text.slice(index + 2, end).trim();
    result += text.slice(cursor, index) + (block ? `\n$$\n${formula}\n$$\n` : `$${formula.replace(/\r?\n/gu, " ")}$`);
    cursor = end + 2;
    index = end + 1;
  }
  return result + text.slice(cursor);
}
