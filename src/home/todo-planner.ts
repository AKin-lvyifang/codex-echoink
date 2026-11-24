import type { ParsedTodoRecord } from "./todo-markdown";
import { FINANCE_CATEGORY_COLORS } from "../ui/category-palette";

/**
 * Pure planning rules shared by the desktop page, iPhone and iPad: time
 * buckets, smart lists, quick-add parsing, calendar grids and colors.
 * Dates are local `YYYY-MM-DD` keys; no timezone conversion.
 */

export type TodoBucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";
export const TODO_BUCKETS: readonly TodoBucket[] = ["overdue", "today", "tomorrow", "week", "later", "none"];
export type TodoSmartList = "today" | "upcoming" | "all" | "done";
export type TodoPlannerFilter = { kind: "smart"; id: TodoSmartList } | { kind: "project"; key: string } | { kind: "category"; name: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseDateKey(key: string): Date {
  const match = DATE.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(Number.NaN);
}
export function dateKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function addDays(key: string, days: number): string {
  const date = parseDateKey(key); date.setDate(date.getDate() + days); return dateKeyOf(date);
}
export function diffDays(a: string, b: string): number {
  return Math.round((parseDateKey(a).getTime() - parseDateKey(b).getTime()) / 864e5);
}
/** 0 = Sunday. */
export function weekdayOf(key: string): number { return parseDateKey(key).getDay(); }

export function todoBucket(record: Pick<ParsedTodoRecord, "dueDate">, today: string): TodoBucket {
  if (!record.dueDate) return "none";
  const days = diffDays(record.dueDate, today);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days <= 7 ? "week" : "later";
}

export function matchesSmartList(record: Pick<ParsedTodoRecord, "dueDate" | "done">, list: TodoSmartList, today: string): boolean {
  if (list === "done") return record.done;
  if (list === "all") return true;
  if (list === "upcoming") return !record.done && !!record.dueDate && record.dueDate > today;
  return !!record.dueDate && (record.done ? record.dueDate === today : record.dueDate <= today);
}

export function smartListCounts(records: readonly Pick<ParsedTodoRecord, "dueDate" | "done">[], today: string): Record<TodoSmartList, number> {
  const open = records.filter(record => !record.done);
  return {
    today: open.filter(record => !!record.dueDate && record.dueDate <= today).length,
    upcoming: open.filter(record => !!record.dueDate && record.dueDate > today).length,
    all: open.length,
    done: records.length - open.length
  };
}

/** Date, then time (timed first), then file order. */
export function compareTodos(a: Pick<ParsedTodoRecord, "dueDate" | "dueTime" | "lineStart">, b: Pick<ParsedTodoRecord, "dueDate" | "dueTime" | "lineStart">): number {
  const da = a.dueDate || "9999-99-99", db = b.dueDate || "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.dueTime || "99:99", tb = b.dueTime || "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.lineStart - b.lineStart;
}

export interface TodoGroup<T> { bucket: TodoBucket; records: T[] }
/** Open records grouped by time; done records are returned separately, newest first. */
export function groupTodos<T extends ParsedTodoRecord>(records: readonly T[], today: string): { groups: TodoGroup<T>[]; done: T[] } {
  const open = records.filter(record => !record.done).sort(compareTodos);
  const groups = TODO_BUCKETS.map(bucket => ({ bucket, records: open.filter(record => todoBucket(record, today) === bucket) })).filter(group => group.records.length);
  return { groups, done: records.filter(record => record.done).sort((a, b) => -compareTodos(a, b)) };
}

export function searchTodos<T extends ParsedTodoRecord>(records: readonly T[], query: string, projectLabel: (record: T) => string = () => ""): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...records];
  return records.filter(record => [record.title, record.people, record.categoryName, projectLabel(record), ...todoSubtasks(record).map(item => item.title)]
    .join(" ").toLowerCase().includes(needle));
}

/* ---------- 子任务：原生缩进任务行，保存在 extraMetaLines 里 ---------- */
const SUBTASK = /^(\s+[-*]\s+\[)([ xX])(\]\s*)(.*)$/u;
export interface TodoSubtask { line: number; title: string; done: boolean }
export function todoSubtasks(record: Pick<ParsedTodoRecord, "extraMetaLines">): TodoSubtask[] {
  const result: TodoSubtask[] = [];
  record.extraMetaLines.forEach((line, index) => {
    const match = SUBTASK.exec(line);
    if (match) result.push({ line: index, title: match[4].trim(), done: match[2].toLowerCase() === "x" });
  });
  return result;
}
export function setSubtaskLine(line: string, done: boolean): string {
  return line.replace(SUBTASK, (_all, open: string, _mark: string, close: string, rest: string) => `${open}${done ? "x" : " "}${close}${rest}`);
}
export function subtaskLine(title: string): string { return `  - [ ] ${title.trim()}`; }

/* ---------- 快速添加：本地规则，不调模型 ---------- */
export type QuickAddKind = "date" | "time" | "category" | "project" | "person";
export interface QuickAddToken { kind: QuickAddKind; value: string; raw: string }
export interface QuickAddResult { title: string; tokens: QuickAddToken[]; dueDate?: string; dueTime?: string; categoryName?: string; project?: string; people: string[] }
export interface QuickAddContext {
  today: string;
  categories: readonly string[];
  projects: readonly { value: string; name: string; label: string }[];
}
const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const pad = (value: number) => String(value).padStart(2, "0");
function hour(prefix: string | undefined, value: number): number {
  return /下午|晚上/u.test(prefix ?? "") && value < 12 ? value + 12 : value;
}

export function parseQuickAdd(text: string, context: QuickAddContext): QuickAddResult {
  let rest = ` ${text} `;
  const tokens: QuickAddToken[] = [];
  const take = (kind: QuickAddKind, pattern: RegExp, read: (match: RegExpExecArray) => string | null) => {
    if (tokens.some(token => token.kind === kind)) return;
    const match = pattern.exec(rest);
    if (!match) return;
    const value = read(match);
    if (value === null) return;
    tokens.push({ kind, value, raw: match[0].trim() });
    rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
  };
  const today = context.today;
  take("date", /后天/u, () => addDays(today, 2));
  take("date", /今天|今日/u, () => today);
  take("date", /明天/u, () => addDays(today, 1));
  take("date", /下(?:周|星期)([一二三四五六日天])/u, match => {
    const monday = addDays(today, 7 - ((weekdayOf(today) + 6) % 7));
    return addDays(monday, (WEEKDAYS[match[1]] + 6) % 7);
  });
  take("date", /(?:周|星期)([一二三四五六日天])/u, match => addDays(today, (WEEKDAYS[match[1]] - weekdayOf(today) + 7) % 7));
  take("date", /(\d{1,2})(?:-|\/|月)(\d{1,2})日?/u, match => {
    const month = Number(match[1]), day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = Number(today.slice(0, 4));
    let key = `${year}-${pad(month)}-${pad(day)}`;
    if (key < today) key = `${year + 1}-${pad(month)}-${pad(day)}`;
    return dateKeyOf(parseDateKey(key)) === key ? key : null;
  });
  take("time", /(上午|早上|中午|下午|晚上)?\s*(\d{1,2})[:：](\d{2})/u, match => {
    const h = hour(match[1], Number(match[2])), m = Number(match[3]);
    return h > 23 || m > 59 ? null : `${pad(h)}:${pad(m)}`;
  });
  take("time", /(上午|早上|中午|下午|晚上)?(\d{1,2})点(半|(\d{1,2})分?)?/u, match => {
    const h = hour(match[1], Number(match[2])), m = match[3] === "半" ? 30 : match[4] ? Number(match[4]) : 0;
    return h > 23 || m > 59 ? null : `${pad(h)}:${pad(m)}`;
  });
  take("category", /#(\S+)/u, match => context.categories.find(name => name === match[1]) ?? null);
  take("project", /\s\/([^\s/]\S*)/u, match => {
    const query = match[1].toLowerCase();
    const found = context.projects.filter(project => project.name.replace(/\s/gu, "").toLowerCase().includes(query));
    return found.length === 1 ? found[0].value : null;
  });
  const people: string[] = [];
  let person: RegExpExecArray | null;
  while ((person = /@(\S+)/u.exec(rest))) {
    people.push(person[1]); tokens.push({ kind: "person", value: person[1], raw: person[0] });
    rest = rest.slice(0, person.index) + " " + rest.slice(person.index + person[0].length);
  }
  const value = (kind: QuickAddKind) => tokens.find(token => token.kind === kind)?.value;
  return { title: rest.replace(/\s+/gu, " ").trim(), tokens, dueDate: value("date"), dueTime: value("time"), categoryName: value("category"), project: value("project"), people };
}

/** Remove one recognised token from the raw input. */
export function removeQuickAddToken(text: string, token: QuickAddToken): string {
  return text.replace(token.raw, " ").replace(/\s+/gu, " ").trim();
}

/* ---------- 日历 ---------- */
/** Monday-first month grid covering whole weeks. */
export function monthGrid(anchor: string): { month: number; year: number; days: string[] } {
  const date = parseDateKey(anchor);
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const start = addDays(dateKeyOf(first), -offset);
  const count = Math.ceil((offset + daysInMonth) / 7) * 7;
  return { year: date.getFullYear(), month: date.getMonth() + 1, days: Array.from({ length: count }, (_, index) => addDays(start, index)) };
}
export function addMonths(anchor: string, months: number): string {
  const date = parseDateKey(anchor);
  return dateKeyOf(new Date(date.getFullYear(), date.getMonth() + months, 1));
}

export const TODO_DEFAULT_DURATION = 30;
export function minutesOf(time: string): number { const [h, m] = time.split(":").map(Number); return h * 60 + m; }
export function timeOf(minutes: number): string { return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`; }
export interface TimedBlock<T> { record: T; start: number; end: number; lane: number; lanes: number }
/** Greedy lanes so overlapping blocks sit side by side. */
export function layoutTimed<T extends Pick<ParsedTodoRecord, "dueTime">>(records: readonly T[]): TimedBlock<T>[] {
  const blocks = records.filter(record => record.dueTime && /^\d{2}:\d{2}$/u.test(record.dueTime))
    .map(record => { const start = minutesOf(record.dueTime!); return { record, start, end: start + TODO_DEFAULT_DURATION, lane: 0, lanes: 1 }; })
    .sort((a, b) => a.start - b.start);
  const lanes: number[] = [];
  for (const block of blocks) {
    let lane = lanes.findIndex(end => end <= block.start);
    if (lane < 0) { lane = lanes.length; lanes.push(0); }
    lanes[lane] = block.end; block.lane = lane;
  }
  for (const block of blocks) block.lanes = Math.max(1, lanes.length);
  return blocks;
}
/** Snap a vertical offset in a timeline column to 15 minutes. */
export function snapMinutes(offsetPx: number, hourHeight: number, startHour: number, endHour: number): number {
  const raw = startHour * 60 + Math.round((offsetPx / hourHeight) * 60 / 15) * 15;
  return Math.max(startHour * 60, Math.min(endHour * 60 - 30, raw));
}

/* ---------- 颜色与项目图标 ---------- */
export const TODO_CATEGORY_PALETTE: readonly string[] = FINANCE_CATEGORY_COLORS.map(([, value]) => value);
const DEFAULT_CATEGORY_COLORS = ["#597ca8", "#5c8977", "#9b78a8", "#c28a60", "#4c9995", "#b77d9e"];
export function categoryColor(name: string, categories: readonly { name: string; color?: string }[]): string {
  if (!name) return "var(--echoink-todo-none, #92969c)";
  const index = categories.findIndex(category => category.name === name);
  const saved = index >= 0 ? categories[index].color : undefined;
  if (saved && /^#[0-9a-f]{6}$/iu.test(saved)) return saved;
  return DEFAULT_CATEGORY_COLORS[(index >= 0 ? index : hash(name)) % DEFAULT_CATEGORY_COLORS.length];
}
export const TODO_PROJECT_ICONS: readonly string[] = ["folder", "rocket", "globe", "clapperboard", "book-open", "briefcase", "lightbulb", "palette", "target", "flag", "package", "pen-tool"];
const PROJECT_ICON_HINTS: readonly [RegExp, string][] = [
  [/发版|发布|上线|release/iu, "rocket"], [/官网|网站|web|site/iu, "globe"], [/视频|教程|拍摄|video/iu, "clapperboard"],
  [/学习|读书|课程|study/iu, "book-open"], [/设计|design/iu, "palette"], [/目标|okr|goal/iu, "target"]
];
export function projectIcon(name: string, saved?: string): string {
  if (saved && TODO_PROJECT_ICONS.includes(saved)) return saved;
  return PROJECT_ICON_HINTS.find(([pattern]) => pattern.test(name))?.[1] ?? "folder";
}
function hash(text: string): number { let value = 0; for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0; return value; }
