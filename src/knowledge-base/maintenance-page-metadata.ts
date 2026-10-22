import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";

export function maintenancePageTitle(content: string, path: string): string {
  const title = createMaintenanceSectionSnapshot(content).regions.find(region => region.kind === "introduction" && region.start < region.contentStart);
  if (title) {
    const heading = content.slice(title.start, title.contentStart).trim();
    return heading.replace(/^ {0,3}#[ \t]+/u, "").replace(/[ \t]+#+$/u, "").replace(/\r?\n[=]+[ \t]*$/u, "").replace(/\r?\n/gu, " ").trim();
  }
  return path.split("/").at(-1)!.replace(/\.(?:md|markdown)$/iu, "");
}

/** Add tokens in place; existing aliases, comments, quoting and every other byte stay intact. */
export function appendMaintenanceAliases(content: string, requested: readonly string[]): string {
  const names = [...new Set(requested.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()))];
  if (!names.length) return content;
  const eol = content.match(/\r\n|\n|\r/u)?.[0] ?? "\n", bom = content.startsWith("\uFEFF") ? 1 : 0;
  const open = /^---[ \t]*(?:\r\n|\n|\r)/u.exec(content.slice(bom));
  if (!open) return content.slice(0, bom) + `---${eol}aliases: ${JSON.stringify(names)}${eol}---${eol}` + content.slice(bom);
  const start = bom + open[0].length, close = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gmu;
  close.lastIndex = start;
  const end = close.exec(content);
  if (!end) throw new Error("已有页文件头未闭合，不能安全追加aliases。");
  const yaml = content.slice(start, end.index), doc = parseDocument(yaml, { keepSourceTokens: true, uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents) || doc.contents.flow) throw new Error("已有页文件头不是明确YAML映射，不能安全追加aliases。");
  const pair = doc.contents.items.find(pair => isScalar(pair.key) && pair.key.value === "aliases");
  if (!pair) return content.slice(0, end.index) + `aliases: ${JSON.stringify(names)}${eol}` + content.slice(end.index);
  const seq = pair.value;
  if (!isScalar(pair.key) || pair.key.anchor || pair.key.tag || !isSeq(seq) || seq.anchor || seq.tag || !seq.range || seq.items.some(item => !isScalar(item) || item.anchor || item.tag || typeof item.value !== "string" || item.type === "BLOCK_LITERAL" || item.type === "BLOCK_FOLDED")) throw new Error("已有aliases须为无锚点的普通字符串列表；保留原值，不转换或删除复杂标量。");
  const normal = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const seen = new Set(seq.items.map(item => normal(String(isScalar(item) ? item.value : ""))));
  const additions = names.filter(name => { if (seen.has(normal(name))) return false; seen.add(normal(name)); return true; });
  if (!additions.length) return content;
  const first = seq.items[0], style = isScalar(first) ? first.type : undefined;
  const encode = (value: string) => style === "QUOTE_SINGLE" ? `'${value.replace(/'/gu, "''")}'` : style === "PLAIN" && /^[\p{L}\p{N}][\p{L}\p{N} _./-]*$/u.test(value) && !/^(?:true|false|null|yes|no|on|off|\d+)$/iu.test(value) ? value : JSON.stringify(value);
  const edits: { at: number; text: string }[] = [];
  if (seq.flow) {
    const closing = yaml.lastIndexOf("]", seq.range[1] - 1);
    if (closing < seq.range[0]) throw new Error("aliases流式列表范围无效。");
    const last = seq.items.at(-1);
    if (!yaml.slice(seq.range[0], closing).includes("\n")) {
      const comma = seq.items.length && !/,[ \t]*$/u.test(yaml.slice(seq.range[0], closing)) ? ", " : "";
      edits.push({ at: closing, text: comma + additions.map(encode).join(", ") });
    } else {
      if (last?.range && !/^[ \t]*,/u.test(yaml.slice(last.range[1], closing))) edits.push({ at: last.range[1], text: "," });
      const lineStart = yaml.lastIndexOf("\n", closing - 1) + 1;
      const indent = yaml.slice(lineStart, closing).match(/^[ \t]*/u)?.[0] ?? "";
      edits.push({ at: lineStart, text: additions.map(value => `${indent}  ${encode(value)},${eol}`).join("") });
    }
  } else {
    const last = seq.items.at(-1);
    if (!last?.range) throw new Error("aliases块列表范围无效。");
    const ending = /\r\n|\n|\r/gu; ending.lastIndex = last.range[1];
    const newline = ending.exec(yaml), at = newline ? newline.index + newline[0].length : yaml.length;
    const lineStart = Math.max(yaml.lastIndexOf("\n", seq.range[0] - 1), yaml.lastIndexOf("\r", seq.range[0] - 1)) + 1;
    const indent = yaml.slice(lineStart, seq.range[0]).match(/^[ \t]*/u)?.[0] ?? "";
    edits.push({ at, text: (newline ? "" : eol) + additions.map(value => `${indent}- ${encode(value)}${eol}`).join("") });
  }
  let updated = yaml;
  for (const edit of edits.sort((a,b) => b.at - a.at)) updated = updated.slice(0, edit.at) + edit.text + updated.slice(edit.at);
  const verified = parseDocument(updated, { uniqueKeys: true, strict: true });
  const aliases = verified.get("aliases");
  const expected = [...seq.items.map(item => isScalar(item) ? item.value : null), ...additions];
  if (verified.errors.length || !isSeq(aliases) || JSON.stringify(aliases.items.map(item => isScalar(item) ? item.value : null)) !== JSON.stringify(expected)) throw new Error("追加aliases无法保持原列表，未写入。");
  return content.slice(0, start) + updated + content.slice(end.index);
}
