import type { DiaryResult, ExpressionEntry, ExpressionOccurrence } from "./types";

const ENTRY_MARKER = "echoink-expression:v1";
const NOTE_START = "<!-- echoink:note:start -->";
const NOTE_END = "<!-- echoink:note:end -->";
const LEGACY_DISCLAIMER = "以下为收录时摘录，不表示当前原稿仍保持原样。";
const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();
const heading = (value: string): string => oneLine(value).replace(/([\\`*_{}[\]<>#])/g, "\\$1");

export function diaryWikiLink(path: string, title?: string): string {
  const target = path.replace(/\.md$/i, "").replace(/[[\]|#^]/g, (value) => encodeURIComponent(value));
  return `[[${target}${title ? `|${oneLine(title).replace(/[[\]|]/g, " ")}` : ""}]]`;
}

/** The ordinary Markdown remains readable when the optional product is disabled. */
export function renderDiaryMarkdown(result: DiaryResult): string {
  const lines = [
    "---",
    "echoink-english-diary: 1",
    `journal-id: ${JSON.stringify(result.journalId)}`,
    `source: ${JSON.stringify(result.sourcePath)}`,
    `source-fingerprint: ${JSON.stringify(result.sourceFingerprint)}`,
    `operation-id: ${JSON.stringify(result.operationId)}`,
    "---", "",
    `# ${heading(result.sourceTitle)} · 英文`, "",
    `原稿：${diaryWikiLink(result.sourcePath, result.sourceTitle)}`, "",
    result.english, "", "## 本篇表达收获", ""
  ];
  for (const expression of result.expressions) {
    lines.push(
      `### ${heading(expression.term)}`, "",
      `${expression.type === "sentence" ? "短句" : "短语"} · ${oneLine(expression.meaning)}`,
      ...(expression.status === "needs-review" ? ["", "> 这条说明待确认。"] : []), "",
      `**本篇场景** ${expression.scene}`, "",
      `**拓展例句** ${expression.example}`, "",
      `**这里为什么用** ${expression.reason}`, "",
      `**适用场景** ${expression.usage}`, ""
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function expressionIdentityMarker(id: string): string {
  return `<!-- echoink-expression-id: ${id} -->`;
}

export function expressionIdentity(content: string): string | null {
  return content.match(/<!-- echoink-expression-id: ([a-f0-9]{24}) -->/)?.[1] ?? null;
}

export function renderExpressionOccurrence(occurrence: ExpressionOccurrence): string {
  return [
    `### ${heading(occurrence.date)} · ${heading(occurrence.sourceTitle)}`, "",
    `原稿：${diaryWikiLink(occurrence.sourcePath, occurrence.sourceTitle)} · 英文：${diaryWikiLink(occurrence.englishPath)}`,
    ...(occurrence.status === "needs-review" ? ["", "> 这条说明待确认。"] : []), "",
    `**原稿摘录** ${occurrence.sourceExcerpt}`, "",
    `**英文摘录** ${occurrence.targetExcerpt}`, "",
    `**本篇场景** ${occurrence.scene}`, "",
    `**拓展例句** ${occurrence.example}`, "",
    `**这里为什么用** ${occurrence.reason}`, "",
    `**适用场景** ${occurrence.usage}`
  ].join("\n");
}

function occurrenceBlocks(occurrence: ExpressionOccurrence): string[] {
  const current = renderExpressionOccurrence(occurrence);
  const link = `原稿：${diaryWikiLink(occurrence.sourcePath, occurrence.sourceTitle)} · 英文：${diaryWikiLink(occurrence.englishPath)}`;
  return [current, current.replace(`${link}\n`, `${link}\n\n${LEGACY_DISCLAIMER}\n`)];
}

/** Regeneration may replace edited explanations only inside an identifiable owned block. */
function editedOccurrenceBlock(content: string, occurrence: ExpressionOccurrence): string | null {
  const prefix = `### ${heading(occurrence.date)} · ${heading(occurrence.sourceTitle)}\n\n原稿：${diaryWikiLink(occurrence.sourcePath, occurrence.sourceTitle)} · 英文：${diaryWikiLink(occurrence.englishPath)}`;
  const start = content.indexOf(prefix);
  if (start < 0 || content.indexOf(prefix, start + prefix.length) >= 0) return null;
  const boundaries = [content.indexOf("\n### ", start + prefix.length), content.indexOf("<!-- echoink-expression-id:", start + prefix.length)].filter((index) => index >= 0);
  if (!boundaries.length) return null;
  const end = Math.min(...boundaries), block = content.slice(start, end);
  const labels = ["原稿摘录", "英文摘录", "本篇场景", "拓展例句", "这里为什么用", "适用场景"];
  let position = prefix.length;
  for (const label of labels) {
    const field = `\n**${label}** `;
    const index = block.indexOf(field, position);
    if (index < 0 || block.indexOf(field, index + field.length) >= 0) return null;
    position = index + field.length;
  }
  // Keep separate user paragraphs following the final managed field.
  const paragraphEnd = block.indexOf("\n\n", position);
  return block.slice(0, paragraphEnd < 0 ? block.trimEnd().length : paragraphEnd);
}

/** Only the short stable ID stays in the portable note; full data lives in private JSON. */
export function renderExpressionMarkdown(entry: ExpressionEntry): string {
  return [
    `# ${heading(entry.term)}`, "",
    `${entry.type === "sentence" ? "短句" : "短语"} · ${oneLine(entry.meaning)}`, "",
    `分类：${oneLine(entry.category)}`, "", "## 我的备注", "",
    NOTE_START, entry.note, NOTE_END, "", "## 收录出处", "",
    ...entry.occurrences.flatMap((occurrence) => [renderExpressionOccurrence(occurrence), ""]),
    expressionIdentityMarker(entry.id), ""
  ].join("\n");
}

function categoryLine(content: string, entry: ExpressionEntry): { start: number; end: number; value: string } | null {
  const title = `# ${heading(entry.term)}\n`;
  const start = content.indexOf(title), end = content.indexOf("\n## 我的备注\n", start + title.length);
  if (start < 0 || end < 0 || content.indexOf(title, start + title.length) >= 0) return null;
  const matches = [...content.slice(start, end).matchAll(/^分类：([^\r\n]*)/gm)];
  if (matches.length !== 1) return null;
  const match = matches[0], offset = start + match.index;
  return { start: offset, end: offset + match[0].length, value: match[1].trim() };
}

/** Change only legacy metadata and identifiable owned disclaimer lines; keep other bytes intact. */
export function migrateExpressionMarkdown(content: string, id: string, entry?: ExpressionEntry): string {
  const legacy = content.match(/<!-- echoink-expression:v1 ([A-Za-z0-9+/=]+) -->/);
  const existingId = expressionIdentity(content);
  if (existingId && existingId !== id) throw new Error("表达文件的关联标识不一致。");
  let cleaned = legacy ? content.replace(legacy[0], "") : content;
  if (legacy && !existingId) cleaned = `${cleaned}\n${expressionIdentityMarker(id)}\n`;
  for (const occurrence of entry?.occurrences ?? []) {
    const [current, old] = occurrenceBlocks(occurrence);
    if (cleaned.includes(old)) { cleaned = cleaned.replace(old, current); continue; }
    const edited = editedOccurrenceBlock(cleaned, occurrence);
    if (!edited) continue;
    const link = `原稿：${diaryWikiLink(occurrence.sourcePath, occurrence.sourceTitle)} · 英文：${diaryWikiLink(occurrence.englishPath)}`;
    const updated = edited.replace(`${link}\n\n${LEGACY_DISCLAIMER}\n`, `${link}\n`);
    if (updated !== edited) cleaned = cleaned.replace(edited, updated);
  }
  return cleaned;
}

/** Preserve arbitrary edits; only replace exact owned fields/occurrence blocks. */
export function patchExpressionMarkdown(content: string, before: ExpressionEntry, next: ExpressionEntry, replaceJournalId?: string): string {
  let updated = content;
  if (next.note !== before.note) {
    const start = updated.indexOf(NOTE_START), end = updated.indexOf(NOTE_END, start + NOTE_START.length);
    if (start < 0 || end < 0) throw new Error("备注区域已被手工改动，请在笔记中编辑备注。");
    updated = updated.slice(0, start + NOTE_START.length) + `\n${next.note}\n` + updated.slice(end);
  }
  if (next.category !== before.category) {
    const field = categoryLine(updated, before);
    if (!field || field.value !== before.category) throw new Error("分类区域已被手工改动，请先在笔记中确认该内容。");
    updated = `${updated.slice(0, field.start)}分类：${oneLine(next.category)}${updated.slice(field.end)}`;
  }
  const matched = new Set<number>();
  for (const previous of before.occurrences) {
    const index = next.occurrences.findIndex((item, index) => !matched.has(index) && item.id === previous.id);
    const current = index < 0 ? undefined : next.occurrences[index];
    if (index >= 0) matched.add(index);
    if (current && JSON.stringify(current) === JSON.stringify(previous) && previous.journalId !== replaceJournalId) continue;
    const original = occurrenceBlocks(previous).find((block) => updated.includes(block))
      ?? (previous.journalId === replaceJournalId ? editedOccurrenceBlock(updated, previous) : null);
    if (!original) throw new Error("出处正文有手工修改，请先在笔记中确认该内容。");
    updated = updated.replace(original, current ? renderExpressionOccurrence(current) : "");
  }
  const appended = next.occurrences.filter((_item, index) => !matched.has(index));
  if (appended.length) {
    const marker = expressionIdentityMarker(next.id);
    if (!updated.includes(marker)) throw new Error("表达文件的关联标记已被修改。");
    updated = updated.replace(marker, `${appended.map(renderExpressionOccurrence).join("\n\n")}\n\n${marker}`);
  }
  return updated;
}

export function parseExpressionMarkdown(content: string, path: string, metadata?: ExpressionEntry): ExpressionEntry | null {
  const match = content.match(/<!-- echoink-expression:v1 ([A-Za-z0-9+/=]+) -->/);
  if (!match && !metadata) {
    if (content.includes(`<!-- ${ENTRY_MARKER}`)) throw new Error("表达文件的结构信息损坏，请先恢复该文件。");
    return null;
  }
  const entry = metadata ? JSON.parse(JSON.stringify(metadata)) as ExpressionEntry
    : JSON.parse(Buffer.from(match![1], "base64").toString("utf8")) as ExpressionEntry;
  if (entry.schema !== 1 || !/^[a-f0-9]{24}$/.test(entry.id)
    || !["phrase", "sentence"].includes(entry.type)
    || ![entry.term, entry.meaning, entry.category, entry.note].every((value) => typeof value === "string")
    || !Array.isArray(entry.occurrences)
    || !entry.occurrences.every((item) => item && typeof item.id === "string"
      && [item.journalId, item.sourcePath, item.englishPath, item.sourceTitle, item.date,
        item.sourceFingerprint, item.scene, item.example, item.reason, item.usage,
        item.sourceExcerpt, item.targetExcerpt].every((value) => typeof value === "string")
      && ["verified", "needs-review"].includes(item.status))) {
    throw new Error("表达文件的结构信息不完整，请先恢复该文件。");
  }
  // Notes edited in the ordinary Markdown editor are retained on the next archive.
  const start = content.indexOf(NOTE_START);
  const end = content.indexOf(NOTE_END, start + NOTE_START.length);
  if (start >= 0 && end >= 0) {
    entry.note = content.slice(start + NOTE_START.length, end).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  }
  const category = categoryLine(content, entry)?.value;
  if (category && category !== entry.category) { entry.category = category; entry.userCategory = true; }
  return { ...entry, path };
}
