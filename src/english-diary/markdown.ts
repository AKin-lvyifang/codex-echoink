import type { DiaryResult, ExpressionEntry, ExpressionOccurrence } from "./types";

const ENTRY_MARKER = "echoink-expression:v1";
const NOTE_START = "<!-- echoink:note:start -->";
const NOTE_END = "<!-- echoink:note:end -->";
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
    `原稿：${diaryWikiLink(occurrence.sourcePath, occurrence.sourceTitle)} · 英文：${diaryWikiLink(occurrence.englishPath)}`, "",
    "以下为收录时摘录，不表示当前原稿仍保持原样。",
    ...(occurrence.status === "needs-review" ? ["", "> 这条说明待确认。"] : []), "",
    `**原稿摘录** ${occurrence.sourceExcerpt}`, "",
    `**英文摘录** ${occurrence.targetExcerpt}`, "",
    `**本篇场景** ${occurrence.scene}`, "",
    `**拓展例句** ${occurrence.example}`, "",
    `**这里为什么用** ${occurrence.reason}`, "",
    `**适用场景** ${occurrence.usage}`
  ].join("\n");
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

/** Migration removes exactly the old payload, without normalizing any user-written bytes. */
export function migrateExpressionMarkdown(content: string, id: string): string {
  const legacy = content.match(/<!-- echoink-expression:v1 ([A-Za-z0-9+/=]+) -->/);
  if (!legacy) return content;
  const existingId = expressionIdentity(content);
  if (existingId && existingId !== id) throw new Error("表达文件的关联标识不一致。");
  const cleaned = content.replace(legacy[0], "");
  return existingId ? cleaned : `${cleaned}\n${expressionIdentityMarker(id)}\n`;
}

/** Preserve arbitrary edits; only replace exact owned fields/occurrence blocks. */
export function patchExpressionMarkdown(content: string, before: ExpressionEntry, next: ExpressionEntry): string {
  let updated = content;
  if (next.note !== before.note) {
    const start = updated.indexOf(NOTE_START), end = updated.indexOf(NOTE_END, start + NOTE_START.length);
    if (start < 0 || end < 0) throw new Error("备注区域已被手工改动，请在笔记中编辑备注。");
    updated = updated.slice(0, start + NOTE_START.length) + `\n${next.note}\n` + updated.slice(end);
  }
  if (next.category !== before.category) {
    updated = updated.replace(`分类：${oneLine(before.category)}\n`, `分类：${oneLine(next.category)}\n`);
  }
  for (const previous of before.occurrences) {
    const current = next.occurrences.find((item) => item.id === previous.id);
    if (current && JSON.stringify(current) === JSON.stringify(previous)) continue;
    const original = renderExpressionOccurrence(previous);
    if (!updated.includes(original)) throw new Error("出处正文有手工修改，请先在笔记中确认该内容。");
    updated = updated.replace(original, current ? renderExpressionOccurrence(current) : "");
  }
  const appended = next.occurrences.filter((item) => !before.occurrences.some((old) => old.id === item.id));
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
  return { ...entry, path };
}
