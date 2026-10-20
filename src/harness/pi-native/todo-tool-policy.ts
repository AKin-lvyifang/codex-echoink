export const PI_TODO_TOOL_IDS = ["todo_query", "todo_add", "todo_update", "todo_complete"] as const;
export type PiTodoToolId = typeof PI_TODO_TOOL_IDS[number];
export type PiTodoWriteToolId = Exclude<PiTodoToolId, "todo_query">;
export interface TodoToolFields {
  title?: string;
  people?: string;
  dueDate?: string;
  dueTime?: string;
  categoryName?: string;
  project?: string;
}
const FIELDS = ["title", "people", "dueDate", "dueTime", "categoryName", "project"];
export function isPiTodoTool(value: string): value is PiTodoToolId { return (PI_TODO_TOOL_IDS as readonly string[]).includes(value); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("todo_invalid_request");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("todo_invalid_request");
}
function text(value: unknown, max: number, allowEmpty = true): string {
  if (typeof value !== "string" || /[\0\r\n]/u.test(value) || value.length > max || !allowEmpty && !value.trim()) throw new Error("todo_invalid_request");
  return value.trim();
}
function fields(value: unknown, requireTitle: boolean): TodoToolFields {
  const input = object(value); only(input, FIELDS);
  const result: TodoToolFields = {};
  for (const key of FIELDS as (keyof TodoToolFields)[]) if (input[key] !== undefined) result[key] = text(input[key], key === "title" ? 1_000 : 500, key !== "title");
  if (result.title && /<!--\s*echoink-todo-id:/iu.test(result.title)) throw new Error("todo_invalid_request");
  if (requireTitle && !result.title || !requireTitle && !Object.keys(result).length) throw new Error("todo_invalid_request");
  if (result.dueDate) {
    const date = new Date(`${result.dueDate}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(result.dueDate) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== result.dueDate) throw new Error("todo_invalid_due_date");
  }
  if (result.dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(result.dueTime)) throw new Error("todo_invalid_due_time");
  return result;
}
/**
 * Validated storage semantics, shared by tool dispatch and P4 replay comparison.
 * Adds default absent text to empty; updates preserve omission as "keep current".
 */
export function normalizeTodoToolRequest(tool: PiTodoToolId, value: unknown): Record<string, unknown> {
  const input = object(value);
  if (tool === "todo_add") {
    const result = { people: "", dueDate: "", dueTime: "", categoryName: "", project: "", ...fields(input, true) };
    if (result.dueTime && !result.dueDate) throw new Error("todo_due_date_required");
    return result;
  }
  if (tool === "todo_update") {
    only(input, ["id", "patch"]);
    const patch = fields(input.patch, false);
    // TodoStore clears the time whenever the date is cleared, regardless of a
    // stale time supplied by the caller. An omitted date still preserves it.
    if (patch.dueDate === "") patch.dueTime = "";
    return { id: text(input.id, 200, false), patch };
  }
  if (tool === "todo_complete") {
    only(input, ["id", "done"]);
    if (input.done !== undefined && typeof input.done !== "boolean") throw new Error("todo_invalid_request");
    return { id: text(input.id, 200, false), done: input.done ?? true };
  }
  only(input, ["id", "status", "project", "query", "limit"]);
  const result: Record<string, unknown> = { status: input.status ?? "all", limit: input.limit ?? 100 };
  if (!["all", "open", "completed"].includes(String(result.status)) || !Number.isInteger(result.limit) || Number(result.limit) < 1 || Number(result.limit) > 200) throw new Error("todo_invalid_request");
  for (const key of ["id", "project", "query"]) if (input[key] !== undefined) result[key] = text(input[key], 500, key === "project");
  return result;
}
