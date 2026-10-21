import type { ParsedTodoRecord } from "./todo-markdown";
import { resolveTodoProject, type TodoProject } from "./todo-projects";
import { sortOpenTodos } from "./home-todos";
type TodoStatus = "all" | "open" | "done";
export const projectKey = (record: ParsedTodoRecord, projects: readonly TodoProject[]): string => {
  const result = resolveTodoProject(record.project, projects);
  return result.status === "none" ? "none" : result.status === "resolved" ? `path:${result.project!.path}` : `raw:${record.project}`;
};

/** Filter the complete source before sorting and taking a 20-row page. */
export function todoPageRecords(records: readonly ParsedTodoRecord[], projects: readonly TodoProject[], filters: {
  status: TodoStatus; category: string | null; project: string | null; page: number;
}) {
  const filtered = records.filter(record => (filters.status === "all" || record.done === (filters.status === "done"))
    && (filters.category === null || record.categoryName === filters.category)
    && (filters.project === null || projectKey(record, projects) === filters.project));
  const ordered = [...sortOpenTodos(filtered), ...filtered.filter(record => record.done)];
  const pages = Math.max(1, Math.ceil(ordered.length / 20));
  const page = Math.min(pages, Math.max(1, filters.page));
  return { records: ordered.slice((page - 1) * 20, page * 20), total: ordered.length, page, pages };
}
