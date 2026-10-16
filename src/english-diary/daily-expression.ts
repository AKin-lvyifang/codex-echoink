import type { ExpressionEntry, ExpressionOccurrence } from "./types";

function validOccurrence(occurrence: ExpressionOccurrence): boolean {
  if (occurrence.status !== "verified" || !occurrence.targetExcerpt.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(occurrence.date)) return false;
  const date = new Date(`${occurrence.date}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === occurrence.date;
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Calendar days, rather than elapsed local hours, keep rotation stable across DST. */
export function localDiaryDay(date: Date): number {
  const calendar = new Date(0);
  calendar.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(calendar.getTime() / 86_400_000);
}

export function dailyExpression(entries: readonly ExpressionEntry[], date = new Date()): { entry: ExpressionEntry; occurrence: ExpressionOccurrence } | null {
  const candidates = entries.flatMap((entry) => {
    const occurrences = entry.occurrences.filter(validOccurrence)
      .sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id));
    return occurrences.length ? [{ entry, first: occurrences[0].date, occurrence: occurrences[occurrences.length - 1] }] : [];
  }).sort((a, b) => compare(a.first, b.first) || compare(a.entry.id, b.entry.id));
  if (!candidates.length) return null;
  const index = ((localDiaryDay(date) % candidates.length) + candidates.length) % candidates.length;
  return candidates[index];
}
