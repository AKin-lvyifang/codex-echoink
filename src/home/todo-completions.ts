export type TodoCompletionHistory = Record<string, string | null>;
export function localTodoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function validTodoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && localTodoDate(date) === value;
}
export function normalizeTodoCompletions(value: unknown): TodoCompletionHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, date]) => id.trim() && (date === null || validTodoDate(date))));
}

/** Deleted tasks retain history. A currently unchecked task explicitly retracts it. */
export function reconcileTodoCompletions(
  history: TodoCompletionHistory,
  current: readonly { id: string; done: boolean }[],
  previous: readonly { id: string; done: boolean }[],
  observed: boolean,
  now = new Date(),
  localWrite = false
): TodoCompletionHistory {
  const next = { ...history };
  const before = new Map(previous.map((record) => [record.id, record.done]));
  for (const record of current) {
    if (!record.id) continue;
    if (!record.done) { delete next[record.id]; continue; }
    if (observed && (before.get(record.id) === false || (localWrite && !before.has(record.id)))) next[record.id] = localTodoDate(now);
    else if (!Object.hasOwn(next, record.id)) next[record.id] = null;
  }
  return next;
}

export function todoCompletionStatistics(history: TodoCompletionHistory, now = new Date()) {
  const counts = new Map<string, number>();
  let unknown = 0;
  for (const date of Object.values(history)) {
    if (date === null) unknown++;
    else counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days: { date: string; count: number }[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  cursor.setDate(cursor.getDate() - 364);
  for (let index = 0; index < 365; index++) {
    const date = localTodoDate(cursor);
    days.push({ date, count: counts.get(date) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return { total: Object.keys(history).length, today: counts.get(localTodoDate(now)) ?? 0, unknown, days };
}
