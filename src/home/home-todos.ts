import { dateKey } from "./home-workbench-model";

export type EchoInkTodoDueState = "overdue" | "today" | "future" | "none";

/** Local calendar date key for "today"; no timezone conversion. */
export function todayKey(): string {
  return dateKey(new Date());
}

export function todoDueState(dueDate: string, today = todayKey()): EchoInkTodoDueState {
  if (!dueDate) return "none";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "future";
}

/**
 * Open items first, nearest due date first, undated last; file order breaks
 * ties so reordering in the source file is respected.
 */
export function sortOpenTodos<T extends { dueDate: string; done: boolean }>(
  records: readonly T[]
): T[] {
  return records
    .filter((record) => !record.done)
    .sort((a, b) => {
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      return 0;
    });
}
