/** Offset counts UTF-16 code units; never splits a code point or skips undelivered text. */
export function pdfReadingPage(text: string, offset: number): { text: string; nextOffset: number | null; total: number } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("精读续读位置无效。");
  let used = 0, end = offset;
  for (const point of text.slice(offset)) {
    const bytes = new TextEncoder().encode(point).length;
    if (used + bytes > 10000) break;
    used += bytes; end += point.length;
  }
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null, total: text.length };
}
