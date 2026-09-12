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
 *     - 分类：工作
 */
export interface ParsedTodoRecord {
  /** Stable id from the hidden comment, or "" for hand-added records. */
  id: string;
  title: string;
  people: string;
  dueDate: string;
  /** Category associated by display name; "" means uncategorized. */
  categoryName: string;
  done: boolean;
  /** 0-based inclusive line range of the whole block in the source file. */
  lineStart: number;
  lineEnd: number;
  /** Indented sub-lines we do not understand; preserved verbatim on rewrite. */
  extraMetaLines: string[];
}

export interface ParsedTodoMarkdown {
  records: ParsedTodoRecord[];
  /** 1-based line numbers of task-like lines that could not be parsed. */
  warnings: number[];
}

export const TODO_ID_COMMENT = "echoink-todo-id";

const TASK_LINE = /^[-*]\s+\[([ xX])\]\s*(.*)$/;
const META_LINE = /^\s+[-*]\s+(相关人员|截止日期|分类)[：:]\s*(.*)$/;
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
        else record.categoryName = value;
      } else {
        record.extraMetaLines.push(sub);
      }
      record.lineEnd = index;
      index++;
    }
    records.push(record);
  }
  // Task-like but malformed top-level lines (e.g. `- [!] foo`) surface as warnings.
  lines.forEach((line, i) => {
    const trimmed = line.trimEnd();
    if (/^[-*]\s+\[[^\]]*\]/.test(trimmed) && !TASK_LINE.test(trimmed)) warnings.push(i + 1);
  });
  return { records, warnings };
}

export function serializeTodoRecord(record: ParsedTodoRecord): string {
  const idComment = record.id ? ` <!-- ${TODO_ID_COMMENT}: ${record.id} -->` : "";
  const lines = [`- [${record.done ? "x" : " "}] ${record.title}${idComment}`];
  if (record.people) lines.push(`  - 相关人员：${record.people}`);
  if (record.dueDate) lines.push(`  - 截止日期：${record.dueDate}`);
  if (record.categoryName) lines.push(`  - 分类：${record.categoryName}`);
  lines.push(...record.extraMetaLines);
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
    if (byId) return byId;
  }
  const byRange = parsed.find(
    (record) => record.lineStart === target.lineStart && record.title === target.title
  );
  return byRange ?? null;
}
