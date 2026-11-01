import { journalMoment } from "./journal-moment";

export const DEFAULT_JOURNAL_DATE_FORMAT = "YYYY-MM/YYYY-MM-DD";
export const NATIVE_JOURNAL_DATE_FORMAT = "YYYY-MM-DD";
export const JOURNAL_FORMAT_PRESETS = [DEFAULT_JOURNAL_DATE_FORMAT, NATIVE_JOURNAL_DATE_FORMAT, "YYYY/MM/YYYY-MM-DD", "YYYY/YYYY-MM-DD"] as const;
const COMMON_FORMATS = [...JOURNAL_FORMAT_PRESETS, "YYYYMMDD", "YYYY.MM.DD", "YYYY_MM_DD"];
export type JournalFormatError = "empty" | "date" | "path" | "time" | "fields";

/** Validate before normalization: normalization must never hide traversal. */
export function safeJournalPath(path: string): boolean {
  return Boolean(path) && !path.startsWith("/") && !/[\\:*?"<>|]/u.test(path) && !Array.from(path).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    && path.split("/").every(part => Boolean(part) && !part.startsWith(".") && !/[. ]$/u.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

export function journalFormatError(input: string): JournalFormatError | null {
  const format = input.trim();
  if (!format) return "empty";
  const fields = format.replace(/\[[^\]]*\]/gu, "");
  if (!["YYYY", "MM", "DD"].every(token => fields.includes(token))) return "date";
  if (!safeJournalPath(format) || /\.md$/iu.test(format)) return "path";
  if (/[HhmsSAaXZz]/u.test(fields.replace(/YYYY|MM|DD|dddd|ddd|dd|d/gu, ""))) return "time";
  if (format.length > 240 || /\.md$/iu.test(format) || !safeJournalPath(journalMoment(new Date(2026, 10, 1)).format(format))) return "path";
  if (/[A-Za-z[\]]/u.test(fields.replace(/YYYY|MM|DD|dddd|ddd|dd|d/gu, ""))) return "fields";
  for (const date of [new Date(2024, 1, 29), new Date(2025, 11, 31), new Date(2026, 0, 1)]) {
    const rendered = journalMoment(date).format(format), parsed = journalMoment(rendered, format, true);
    if (!safeJournalPath(rendered) || !parsed.isValid() || parsed.format("YYYY-MM-DD") !== journalMoment(date).format("YYYY-MM-DD")) return "date";
  }
  return null;
}

export function journalFormats(current = DEFAULT_JOURNAL_DATE_FORMAT, history: readonly string[] = []): string[] {
  return [...new Set([current, ...history, ...COMMON_FORMATS].filter(value => typeof value === "string" && value.length > 0 && value.length <= 240))];
}

export function journalPathForFormat(date: Date | string, folder: string, format: string): string {
  const value = typeof date === "string" ? journalMoment(date, "YYYY-MM-DD", true) : journalMoment(date);
  if (!value.isValid()) throw new Error("journal_date_invalid");
  const path = `${folder ? `${folder}/` : ""}${value.format(format)}.md`;
  if (!safeJournalPath(path)) throw new Error("journal_path_invalid");
  return path;
}

/** Only exact paths round-trip; a date mentioned inside an ordinary title is insufficient. */
export function parseJournalDate(path: string, folder = "journal", format = DEFAULT_JOURNAL_DATE_FORMAT, history: readonly string[] = []): string | null {
  const normalized = path.replace(/\\/gu, "/"), prefix = folder ? `${folder.replace(/\/$/u, "")}/` : "";
  if (!normalized.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()) || !/\.md$/iu.test(normalized) || !safeJournalPath(normalized)) return null;
  const name = normalized.slice(prefix.length, -3);
  for (const candidate of journalFormats(format, history)) {
    const date = journalMoment(name, candidate, true);
    if (date.isValid() && date.format(candidate) === name) return date.format("YYYY-MM-DD");
  }
  return null;
}

export function preferredJournalPath(paths: readonly string[], date: Date, folder: string, format: string, history: readonly string[] = []): string | null {
  const target = journalPathForFormat(date, folder, format), key = journalMoment(date).format("YYYY-MM-DD");
  return paths.includes(target) ? target : paths.filter(path => parseJournalDate(path, folder, format, history) === key).sort()[0] ?? null;
}
