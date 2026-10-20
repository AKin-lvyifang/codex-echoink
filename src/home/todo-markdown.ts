/**
 * Markdown source-of-truth format for EchoInk to-dos.
 *
 * A record is a native Obsidian task line plus optional indented metadata
 * bullets. The stable id lives in a hidden HTML comment so users never have
 * to maintain it; hand-added tasks without an id are still recognized and
 * located by their parsed line range.
 *
 *   - [ ] 提交季度报告 <!-- echoink-todo-id: todo-1 -->
 *     - 相关人员：张三、李四
 *     - 截止日期：2026-09-18
 *     - 截止时间：14:30
 *     - 分类：工作
 */
export interface ParsedTodoRecord {
  /** Stable id from the hidden comment, or "" for hand-added records. */
  id: string;
  title: string;
  people: string;
  dueDate: string;
  /** Local HH:mm; absent/empty uses 09:00. Invalid handwritten values are preserved. */
  dueTime?: string;
  /** Category associated by display name; "" means uncategorized. */
  categoryName: string;
  /** Project display name, or Vault-relative path when names collide. */
  project?: string;
  done: boolean;
  /** 0-based inclusive line range of the whole block in the source file. */
  lineStart: number;
  lineEnd: number;
  /** Indented sub-lines we do not understand; preserved verbatim on rewrite. */
  extraMetaLines: string[];
  /** Original block for conflict detection and preserving handwritten layout. */
  sourceBlock?: string;
}

export interface ParsedTodoMarkdown {
  records: ParsedTodoRecord[];
  /** 1-based line numbers of task-like lines that could not be parsed. */
  warnings: number[];
}

export const TODO_ID_COMMENT = "echoink-todo-id";

const TASK_LINE = /^[-*]\s+\[([ xX])\]\s*(.*)$/;
const META_LINE = /^\s+[-*]\s+(相关人员|截止日期|截止时间|分类|项目)[：:]\s*(.*)$/;
const INDENTED_LINE = /^\s+\S/;
const ID_COMMENT = new RegExp(`<!--\\s*${TODO_ID_COMMENT}:\\s*([^>]+?)\\s*-->`, "u");
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTodoMarkdown(content: string): ParsedTodoMarkdown {
  const lines = content.split("\n");
  const records: ParsedTodoRecord[] = [];
  const warnings: number[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const task = TASK_LINE.exec(line.trimEnd());
    if (!task || /^\s/.test(line)) {
      index++;
      continue;
    }
    if (!task[2] && !ID_COMMENT.test(line)) {
      // Empty task line is still a valid record (title may be filled later).
    }
    const lineStart = index;
    let id = "";
    let title = task[2];
    const idMatch = ID_COMMENT.exec(title);
    if (idMatch) {
      id = idMatch[1].trim();
      title = title.replace(ID_COMMENT, "").trim();
    }
    const record: ParsedTodoRecord = {
      id,
      title,
      people: "",
      dueDate: "",
      categoryName: "",
      done: task[1].toLowerCase() === "x",
      lineStart,
      lineEnd: lineStart,
      extraMetaLines: []
    };
    index++;
    while (index < lines.length) {
      const sub = lines[index];
      if (!INDENTED_LINE.test(sub)) break;
      const meta = META_LINE.exec(sub);
      if (meta) {
        const value = meta[2].trim();
        if (meta[1] === "相关人员") record.people = value;
        else if (meta[1] === "截止日期") record.dueDate = DATE_VALUE.test(value) ? value : "";
        else if (meta[1] === "截止时间") record.dueTime = value;
        else if (meta[1] === "分类") record.categoryName = value;
        else {
          record.project = value;
          // Keep the compatibility carrier used by older field-whitelist editors.
          record.extraMetaLines.push(sub);
        }
      } else {
        record.extraMetaLines.push(sub);
      }
      record.lineEnd = index;
      index++;
    }
    record.sourceBlock = lines.slice(record.lineStart, record.lineEnd + 1).join("\n");
    records.push(record);
  }
  // Task-like but malformed top-level lines (e.g. `- [!] foo`) surface as warnings.
  lines.forEach((line, i) => {
    const trimmed = line.trimEnd();
    if (/^[-*]\s+\[[^\]]*\]/.test(trimmed) && !TASK_LINE.test(trimmed)) warnings.push(i + 1);
  });
  return { records, warnings };
}

const PROJECT_META = /^\s+[-*]\s+项目[：:]\s*(.*)$/u;

export function serializeTodoRecord(record: ParsedTodoRecord): string {
  const legacyProject = record.extraMetaLines.find(line => PROJECT_META.test(line));
  const project = record.project ?? (legacyProject ? PROJECT_META.exec(legacyProject)?.[1].trim() : undefined);
  if (record.sourceBlock !== undefined) {
    const original = parseTodoMarkdown(record.sourceBlock).records[0];
    if (original) {
      const values: Record<string, string | undefined> = { 相关人员: record.people, 截止日期: record.dueDate,
        截止时间: record.dueTime, 分类: record.categoryName, 项目: project };
      const oldValues: Record<string, string | undefined> = { 相关人员: original.people, 截止日期: original.dueDate,
        截止时间: original.dueTime, 分类: original.categoryName, 项目: original.project };
      const lines = record.sourceBlock.split("\n");
      if (record.title !== original.title || record.done !== original.done || record.id !== original.id) {
        const idComment = record.id ? ` <!-- ${TODO_ID_COMMENT}: ${record.id} -->` : "";
        const prefix = /^([-*]\s+\[)[ xX](\]\s*)/u.exec(lines[0]);
        lines[0] = `${prefix?.[1] ?? "- ["}${record.done ? "x" : " "}${prefix?.[2] ?? "] "}${record.title}${idComment}`;
      }
      const seen = new Set<string>();
      const result = [lines[0]];
      for (const line of lines.slice(1)) {
        const meta = /^(\s+[-*]\s+)(相关人员|截止日期|截止时间|分类|项目)([：:]\s*)(.*)$/u.exec(line);
        if (!meta) { result.push(line); continue; }
        const key = meta[2]; seen.add(key);
        if (values[key] === oldValues[key]) result.push(line);
        else if (values[key]) result.push(`${meta[1]}${key}${meta[3]}${values[key]}`);
      }
      for (const [key, value] of Object.entries(values)) {
        if (value && !seen.has(key)) result.push(`  - ${key}：${value}`);
      }
      return result.join("\n");
    }
  }
  const idComment = record.id ? ` <!-- ${TODO_ID_COMMENT}: ${record.id} -->` : "";
  const lines = [`- [${record.done ? "x" : " "}] ${record.title}${idComment}`];
  if (record.people) lines.push(`  - 相关人员：${record.people}`);
  if (record.dueDate) lines.push(`  - 截止日期：${record.dueDate}`);
  if (record.dueTime) lines.push(`  - 截止时间：${record.dueTime}`);
  if (record.categoryName) lines.push(`  - 分类：${record.categoryName}`);
  if (project) lines.push(`  - 项目：${project}`);
  lines.push(...record.extraMetaLines.filter(line => !PROJECT_META.test(line)));
  return lines.join("\n");
}

/** Replace one record's line range inside the latest file content. */
export function replaceRecordLines(
  content: string,
  record: ParsedTodoRecord,
  replacement: string | null
): string {
  const lines = content.split("\n");
  const start = Math.max(0, record.lineStart);
  const end = Math.min(lines.length - 1, record.lineEnd);
  const block = replacement === null ? [] : replacement.split("\n");
  lines.splice(start, end - start + 1, ...block);
  return lines.join("\n");
}

export function appendRecordBlock(content: string, block: string): string {
  if (!content.trim()) return `${block}\n`;
  return content.endsWith("\n") ? `${content}${block}\n` : `${content}\n${block}\n`;
}

/** Locate a record in freshly parsed content: id first, then line range with title guard. */
export function locateRecord(
  parsed: ParsedTodoRecord[],
  target: ParsedTodoRecord
): ParsedTodoRecord | null {
  if (target.id) {
    const byId = parsed.find((record) => record.id === target.id);
    return byId ?? null;
  }
  const byRange = parsed.find(
    (record) => record.lineStart === target.lineStart && record.title === target.title
  );
  return byRange ?? null;
}
