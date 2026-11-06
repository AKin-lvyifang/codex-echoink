import type { App } from "obsidian";
import { isKnowledgeMap } from "./knowledge-wiki-policy";

/** Only plain generated list entries are normalized; handwritten labels and annotations remain. */
export function normalizeMergedMapEntries(
  app: App,
  path: string,
  before: string,
  after: string,
  redirects: ReadonlyMap<string, string>,
): string {
  if (!isKnowledgeMap(path, before)) return after;
  const oldLines = before.split(/\r?\n/u);
  const lines = after.split(/\r?\n/u);
  if (oldLines.length !== lines.length) throw new Error("地图行数已变化，请重新查看合并预览。");
  const entries: {
    index: number;
    key: string;
    target: string;
    redirected: boolean;
    generated: boolean;
  }[] = [];
  let section = "",
    domain = "";
  const parents: { indent: number; index: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const marker = /<!-- echoink-domain-map:BEGIN ([^ ]+) -->/u.exec(oldLines[index]);
    if (marker) domain = marker[1];
    const heading = /^(#{2,3})\s+(.+)$/u.exec(oldLines[index]);
    if (heading || marker) parents.length = 0;
    if (heading) section = heading[1] + heading[2];
    const list = /^(\s*)[-+*]\s+/u.exec(oldLines[index]);
    if (!list) continue;
    const indent = list[1].length;
    while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
    const parent = parents.at(-1)?.index ?? "root";
    parents.push({ indent, index });
    const match = /^(\s*[-+*]\s+)\[\[([^\]#|]+)(?:\|([^\]]+))?\]\]\s*$/u.exec(oldLines[index]);
    if (!match) continue;
    const file = app.metadataCache.getFirstLinkpathDest(match[2], path);
    if (!file) continue;
    const target = redirects.get(file.path) ?? file.path;
    const generated = !match[3] || match[3] === match[2] || match[3] === file.basename;
    const key = `${domain}\0${section}\0${parent}\0${target}`;
    entries.push({ index, key, target, redirected: redirects.has(file.path), generated });
  }
  const existing = new Set(entries.filter((entry) => !entry.redirected).map((entry) => entry.key));
  const removed = new Set<number>();
  for (const entry of entries.filter((entry) => entry.redirected && entry.generated)) {
    const indent = /^\s*/u.exec(oldLines[entry.index])![0].length;
    const next = oldLines[entry.index + 1];
    const hasChildren =
      next && /^\s*[-+*]\s+/u.test(next) && /^\s*/u.exec(next)![0].length > indent;
    if (existing.has(entry.key) && !hasChildren) removed.add(entry.index);
    else {
      const prefix = /^(\s*[-+*]\s+)/u.exec(lines[entry.index])![1];
      const name = entry.target.split("/").at(-1)!.replace(/\.md$/u, "");
      lines[entry.index] = `${prefix}[[${entry.target.replace(/\.md$/u, "")}|${name}]]`;
      existing.add(entry.key);
    }
  }
  return lines
    .filter((_line, index) => !removed.has(index))
    .join(after.includes("\r\n") ? "\r\n" : "\n");
}
