import { dateKey, journalDateFromPath, type HomeVaultFileRecord } from "./home-workbench-model";

export interface JournalEntry extends HomeVaultFileRecord { date: string }
export interface JournalStats {
  entries: JournalEntry[];
  days: { date: string; count: number }[];
  years: number[];
  currentYearCount: number;
  streak: number;
}

/** Files count as entries, including empty templates; streaks count local dates. */
export function journalStats(records: readonly HomeVaultFileRecord[], folder: string, format: string, now = new Date()): JournalStats {
  const entries: JournalEntry[] = records.flatMap(record => {
    const date = journalDateFromPath(record.path, folder, format);
    return date ? [{ ...record, date }] : [];
  }).sort((left, right) => right.date.localeCompare(left.date) || left.path.localeCompare(right.path));
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.date, (counts.get(entry.date) ?? 0) + 1);
  const today = dateKey(now), year = now.getFullYear();
  const cursor = new Date(year, now.getMonth(), now.getDate(), 12);
  if (!counts.has(today)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (counts.has(dateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return { entries, days: [...counts].map(([date, count]) => ({ date, count })),
    years: [...new Set([year, ...entries.map(entry => Number(entry.date.slice(0, 4)))])].sort((a, b) => b - a),
    currentYearCount: entries.filter(entry => entry.date.startsWith(`${year}-`) && entry.date <= today).length, streak };
}

export function journalPageEntries(entries: readonly JournalEntry[], year: number, month: number, page: number) {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const matching = entries.filter(entry => entry.date.startsWith(prefix));
  const pages = Math.max(1, Math.ceil(matching.length / 20));
  const current = Math.min(pages, Math.max(1, page));
  return { entries: matching.slice((current - 1) * 20, current * 20), page: current, pages, total: matching.length };
}

export function journalMonthSelection(month: Date, selected: string): string {
  const day = Number(selected.slice(8)) || 1;
  return dateKey(new Date(month.getFullYear(), month.getMonth(), Math.min(day, new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate())));
}

export function journalSummary(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "").replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1").replace(/^[#>\s*-]+/gmu, "")
    .replace(/[`*_~]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 120);
}
