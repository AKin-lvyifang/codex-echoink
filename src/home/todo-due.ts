export const DEFAULT_TODO_DUE_TIME = "09:00";

export function isTodoDueTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

export function normalizeTodoDueTime(value: unknown): string {
  const time = typeof value === "string" ? value.trim() : "";
  return isTodoDueTime(time) ? time : "";
}

export interface TodoDeadline {
  dueDate: string;
  dueTime?: string;
}

/** Local wall-clock deadline. Invalid handwritten dates/times never alert. */
export function todoDueAt(record: TodoDeadline): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(record.dueDate)) return null;
  const time = record.dueTime?.trim() || DEFAULT_TODO_DUE_TIME;
  if (!isTodoDueTime(time)) return null;
  const [year, month, day] = record.dueDate.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  // Reject impossible calendar dates. DST gaps use the host's next valid time.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/** The local deadline, rather than its timezone-dependent epoch, is the identity. */
export function todoReminderKey(record: TodoDeadline & { id: string }): string | null {
  if (!record.id || todoDueAt(record) === null) return null;
  return JSON.stringify([record.id, record.dueDate, record.dueTime?.trim() || DEFAULT_TODO_DUE_TIME]);
}
