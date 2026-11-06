import { getDesktopPath } from "../platform/desktop-paths";

const path = getDesktopPath().posix;

/** Project Obsidian's exact/relative/suffix lookup onto the file tree after all planned moves. */
export function projectedKnowledgeLinks(
  paths: readonly string[],
  moves: ReadonlyMap<string, string>,
): (link: string, source: string) => string | null {
  const byName = new Map<string, string[]>();
  const add = (value: string) => {
    const name = path.basename(value).toLowerCase();
    const values = byName.get(name) ?? [];
    values.push(value);
    byName.set(name, values);
  };
  for (const value of paths) if (!moves.has(value)) add(value);
  for (const value of moves.values()) add(value);
  return (link, source) => {
    if (!link) return source;
    let name = path.basename(link).toLowerCase();
    let query = link.toLowerCase();
    let candidates = byName.get(name);
    if (!name.includes(".") || !candidates) {
      query += ".md";
      name = path.basename(query);
      candidates = byName.get(name);
    }
    if (!candidates) return null;
    const directory = path.dirname(source) === "." ? "" : path.dirname(source).toLowerCase();
    if (query.startsWith("./") || query.startsWith("../")) {
      const relative = path.normalize(path.join(directory, query));
      const exact = candidates.find((value) => value.toLowerCase() === relative);
      if (exact) return exact;
    }
    const absolute = query.replace(/^\//u, "");
    const exact = candidates.find((value) => value.toLowerCase() === absolute);
    if (exact) return exact;
    if (query.startsWith("/")) return null;
    const suffix = candidates.filter((value) => value.toLowerCase().endsWith(query));
    const local = suffix.filter((value) => value.toLowerCase().startsWith(directory));
    return (local.length ? local : suffix).sort((a, b) => a.length - b.length)[0] ?? null;
  };
}
