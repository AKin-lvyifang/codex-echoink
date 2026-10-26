/** Source-only image operations. Never rewrite attachment paths or aliases. */
export interface ImageSpan { from: number; to: number; raw: string; target: string }
export interface GalleryBlock { from: number; to: number; headerTo: number; header: string; body: string; images: ImageSpan[]; valid: boolean; row: boolean; height?: number }
export interface GalleryEdit { from: number; to: number; insert: string; cursor?: number }
export const GALLERY_GAP_MESSAGE = "这几张图片之间有其他内容，先把它们挪到一起";
/** The first numeric token is the sole height control; clamp to safe tile sizes. */
export function galleryOptions(metadata = ""): { row: boolean; height?: number } {
  const parts = metadata.split("|").map(part => part.trim().toLowerCase());
  const number = parts.find(part => /^\d+$/u.test(part));
  return { row: parts.includes("row"), height: number === undefined ? undefined : Math.max(120, Math.min(800, Number(number))) };
}
const imageExtension = /\.(?:avif|bmp|gif|heic|jpe?g|png|svg|webp)$/iu;
function imageTarget(target: string): boolean {
  try { return imageExtension.test(decodeURIComponent(target.replace(/\\(.)/gu, "$1").split(/[?#]/u)[0])); }
  catch { return false; }
}
function closing(text: string, start: number, char: string): number {
  for (let i = start; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === char) return i; }
  return -1;
}
function token(text: string, start: number, base: number): ImageSpan | null {
  let end: number, target: string;
  if (text.startsWith("![[", start)) {
    end = text.indexOf("]]", start + 3); if (end < 0) return null;
    target = text.slice(start + 3, end).split("|")[0].trim(); end += 2;
  } else if (text.startsWith("![", start)) {
    const labelEnd = closing(text, start + 2, "]");
    if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
    let at = labelEnd + 2; while (/\s/u.test(text[at] ?? "") && at < text.length) at++;
    const begin = at;
    if (text[at] === "<") {
      const close = closing(text, at + 1, ">"); if (close < 0) return null;
      target = text.slice(at + 1, close); at = close + 1;
    } else {
      let depth = 0;
      for (; at < text.length; at++) {
        if (text[at] === "\\") { at++; continue; }
        if (text[at] === "(") depth++;
        else if (text[at] === ")") { if (!depth) break; depth--; }
        else if (/\s/u.test(text[at]) && !depth) break;
      }
      target = text.slice(begin, at);
    }
    while (/\s/u.test(text[at] ?? "") && at < text.length) at++;
    if (text[at] === '"' || text[at] === "'") { const close = closing(text, at + 1, text[at]); if (close < 0) return null; at = close + 1; }
    while (/\s/u.test(text[at] ?? "") && at < text.length) at++;
    if (text[at] !== ")") return null; end = at + 1;
  } else return null;
  if (!imageTarget(target)) return null;
  return { from: base + start, to: base + end, raw: text.slice(start, end), target };
}
export function parseImageLine(text: string, base = 0): ImageSpan[] | null {
  if (/^(?: {4}|\t)/u.test(text)) return null;
  const images: ImageSpan[] = [];
  let at = 0;
  while (at < text.length) {
    if (/\s/u.test(text[at])) { at++; continue; }
    const image = token(text, at, base); if (!image) return null;
    images.push(image); at = image.to - base;
  }
  return images.length ? images : null;
}
function lines(source: string): { text: string; from: number; to: number }[] {
  let from = 0;
  return source.split("\n").map(text => { const line = { text: text.replace(/\r$/u, ""), from, to: from + text.length }; from += text.length + 1; return line; });
}

function htmlLine(text: string, previous: string): string | null {
  const start = previous || (/^\s*<!--/u.test(text) ? "comment" : text.match(/^\s*<(script|pre|style|textarea)(?:\s|>)/iu)?.[1]?.toLowerCase() ?? (/^\s*<\/?[a-z]/iu.test(text) ? "block" : ""));
  if (!start) return null;
  if (start === "comment") return text.includes("-->") ? "" : start;
  if (start === "block") return !text.trim() || /^\s*<\//u.test(text) ? "" : start;
  return new RegExp("</" + start + "\\s*>", "iu").test(text) ? "" : start;
}

/** Conservative root-level scan: ignore frontmatter, code and quote/list continuations. */
export function standaloneImages(source: string): ImageSpan[] {
  let fence = "", fenceLength = 0, frontmatter = false, container = false, html = "";
  const images: ImageSpan[] = [];
  for (const [index, line] of lines(source).entries()) {
    if (index === 0 && line.text === "---") { frontmatter = true; continue; }
    if (frontmatter) { if (/^(?:---|\.\.\.)$/u.test(line.text)) frontmatter = false; continue; }
    const marker = line.text.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) { if (marker?.[0] === fence && marker.length >= fenceLength && /^ {0,3}(?:`+|~+)\s*$/u.test(line.text)) fence = ""; continue; }
    if (marker) { fence = marker[0]; fenceLength = marker.length; continue; }
    const htmlBlock = htmlLine(line.text, html);
    if (htmlBlock !== null) { html = htmlBlock; continue; }
    if (!line.text.trim()) { container = false; continue; }
    if (/^ {0,3}(?:>|[-+*]\s|\d+[.)]\s)/u.test(line.text)) container = true;
    if (!container) images.push(...(parseImageLine(line.text, line.from) ?? []));
  }
  return images;
}
export function galleryBlocks(source: string): GalleryBlock[] {
  const all = lines(source), blocks: GalleryBlock[] = [];
  let fence = "", frontmatter = false, html = "";
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (i === 0 && line.text === "---") { frontmatter = true; continue; }
    if (frontmatter) { if (/^(?:---|\.\.\.)$/u.test(line.text)) frontmatter = false; continue; }
    const htmlBlock = htmlLine(line.text, html);
    if (htmlBlock !== null) { html = htmlBlock; continue; }
    const marker = line.text.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(line.text)) fence = ""; continue; }
    if (fence) continue;
    const header = line.text.match(/^ {0,3}>\s*\[!gallery(?:\|([^\]]*))?\]([+-])?(?:\s.*)?$/iu);
    if (!header) continue;
    const body: string[] = [], images: ImageSpan[] = [];
    const options = galleryOptions(header[1]);
    let valid = true, to = line.to;
    const start = i;
    while (i + 1 < all.length && /^ {0,3}>/u.test(all[i + 1].text)) {
      const next = all[++i], prefix = next.text.match(/^ {0,3}> ?/u)![0], text = next.text.slice(prefix.length);
      body.push(text); to = next.to;
      if (!text.trim()) continue;
      const parsed = parseImageLine(text, next.from + prefix.length);
      if (!parsed) valid = false; else images.push(...parsed);
    }
    blocks.push({ from: all[start].from, to, headerTo: line.to, header: line.text, body: body.join("\n"), images, valid: valid && images.length > 0 && images.length <= 3, ...options });
  }
  return blocks;
}
export function galleryAt(source: string, position: number): GalleryBlock | undefined {
  return galleryBlocks(source).find(group => group.from <= position && position <= group.to);
}
export function imagesInSelection(source: string, from: number, to: number): ImageSpan[] {
  return standaloneImages(source).filter(image => image.from >= from && image.to <= to);
}
export function groupImages(source: string, chosen: readonly ImageSpan[], row = false): GalleryEdit {
  if (chosen.length < 2) throw new Error("再选 1 张");
  if (chosen.length > 3) throw new Error("一组最多 3 张");
  const ordered = [...chosen].sort((a, b) => a.from - b.from);
  const eligible = standaloneImages(source);
  if (ordered.some(image => source.slice(image.from, image.to) !== image.raw || !eligible.some(item => item.from === image.from && item.to === image.to))) throw new Error("图片内容已变化，请重新选择");
  const from = source.lastIndexOf("\n", ordered[0].from - 1) + 1;
  const lastEnd = source.indexOf("\n", ordered.at(-1)!.to), to = lastEnd < 0 ? source.length : lastEnd;
  const region = source.slice(from, to);
  const regionImages = eligible.filter(image => image.from >= from && image.to <= to);
  const selected = new Set(ordered.map(image => image.from));
  if (regionImages.length !== ordered.length || regionImages.some(image => !selected.has(image.from)) || lines(region).some(line => line.text.trim() && !parseImageLine(line.text))) throw new Error(GALLERY_GAP_MESSAGE);
  const insert = `> [!gallery${row && ordered.length === 3 ? "|row" : ""}]\n> ${ordered.map(image => image.raw).join("\n> ")}`;
  const separated = source[to] === "\n" && source[to + 1] && source[to + 1] !== "\n" ? insert + "\n" : insert;
  return { from, to, insert: separated };
}
export function splitGallery(source: string, position: number): GalleryEdit {
  const group = galleryAt(source, position); if (!group) throw new Error("把光标放到图片组中再拆开");
  return { from: group.from, to: group.to, insert: group.valid ? group.images.map(image => image.raw).join("\n\n") : group.body };
}
export function changeGalleryLayout(source: string, position: number, row: boolean): GalleryEdit {
  const group = galleryAt(source, position);
  if (!group?.valid || group.images.length !== 3) throw new Error("只有三张图片的图片组可以切换排法");
  const metadata = group.header.match(/\[!gallery(?:\|([^\]]*))?\]/iu)?.[1] ?? "";
  const parts = metadata.split("|").map(part => part.trim()).filter(part => part && part.toLowerCase() !== "row");
  if (row) parts.unshift("row");
  return { from: group.from, to: group.headerTo, insert: group.header.replace(/\[!gallery[^\]]*\]/iu, `[!gallery${parts.length ? "|" + parts.join("|") : ""}]`) };
}
export function insertGallery(source: string, position: number): GalleryEdit {
  const from = source.lastIndexOf("\n", position - 1) + 1;
  const end = source.indexOf("\n", position);
  const probe = source.slice(0, from) + "![[__echoink_gallery_probe__.png]]" + source.slice(end < 0 ? source.length : end);
  if (!standaloneImages(probe).some(image => image.from === from)) throw new Error("请把光标放到笔记的普通正文中再插入图片组");
  // Inserting into a source container would make a nested or non-rendering group.
  if (galleryAt(source, position) || /^(?:\s*>|\s*[-+*]\s|\s*\d+[.)]\s| {4}|\t)/u.test(source.slice(from, position))) throw new Error("请把光标放到笔记的普通正文中再插入图片组");
  const before = source.slice(0, position), after = source.slice(position);
  const prefix = before ? before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n" : "";
  const block = `${prefix}> [!gallery]\n> `, suffix = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return { from: position, to: position, insert: block + suffix, cursor: position + block.length };
}
