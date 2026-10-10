import type { ExpressionEntry } from "./types";

export const normalizedExpressionKey = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

/** The repository and the loaded view must use identical search semantics. */
export function filterExpressions(entries: readonly ExpressionEntry[], query = "", category?: string): ExpressionEntry[] {
  const search = normalizedExpressionKey(query);
  return entries.filter((entry) => (!category || entry.category === category)
    && (!search || normalizedExpressionKey([
      entry.term, entry.meaning, entry.category, entry.note,
      ...entry.occurrences.flatMap((item) => [item.date, item.sourcePath, item.sourceTitle, item.scene, item.reason])
    ].join("\n")).includes(search)))
    .sort((left, right) => left.term.localeCompare(right.term));
}

/** Includes a watched directory itself and parent-folder renames/deletions. */
export function pathsOverlap(path: string, watched: string): boolean {
  return path === watched || path.startsWith(`${watched}/`) || watched.startsWith(`${path}/`);
}
