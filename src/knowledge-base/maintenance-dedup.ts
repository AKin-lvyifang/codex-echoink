import type {
  MaintenanceDedupCandidate,
  MaintenanceDedupPort,
  MaintenanceKnowledgeUnit,
  MaintenanceUnitCandidates,
  MaintenanceWikiDocument
} from "./maintenance-p2-contract";

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const normalizedName = (value: string): string => value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
const namesOf = (unit: MaintenanceKnowledgeUnit): Set<string> => new Set(
  [unit.title, ...unit.aliases].map(normalizedName).filter(Boolean)
);

/** Collect evidence for later semantic judgment; a search hit never decides a merge. */
export async function collectMaintenanceCandidates(
  units: readonly MaintenanceKnowledgeUnit[],
  port: MaintenanceDedupPort
): Promise<MaintenanceUnitCandidates[]> {
  if (new Set(units.map(unit => unit.id)).size !== units.length) throw new Error("知识条目 ID 重复，无法对应查重结果。");

  // This port enumerates only the bound Wiki. Membership also prevents an overbroad
  // body-search implementation from introducing Raw/other-folder results. No folder
  // name is hard-coded, so custom bindings have the same boundary.
  const wiki = new Map<string, MaintenanceWikiDocument>();
  for (const document of await port.listWiki()) {
    const previous = wiki.get(document.path);
    if (previous && (previous.contentRevision !== document.contentRevision || previous.title !== document.title ||
      JSON.stringify([...previous.aliases].sort(compare)) !== JSON.stringify([...document.aliases].sort(compare)))) {
      throw new Error(`Wiki 查重快照存在冲突：${document.path}`);
    }
    wiki.set(document.path, document);
  }

  const names = units.map(namesOf);
  const results: MaintenanceUnitCandidates[] = units.map((unit, index) => ({
    unitId: unit.id,
    candidates: [],
    batchUnitIds: units.filter((other, otherIndex) => otherIndex !== index &&
      [...names[index]].some(name => names[otherIndex].has(name))).map(other => other.id).sort(compare)
  }));
  const matches = units.map(() => new Map<string, Set<"title" | "alias" | "body">>());
  const addMatch = (unitIndex: number, path: string, kind: "title" | "alias" | "body"): void => {
    const kinds = matches[unitIndex].get(path) ?? new Set<"title" | "alias" | "body">();
    kinds.add(kind);
    matches[unitIndex].set(path, kinds);
  };

  // Finish the exact title/alias pass for the entire batch before body retrieval.
  units.forEach((_unit, index) => {
    for (const document of wiki.values()) {
      if (names[index].has(normalizedName(document.title))) addMatch(index, document.path, "title");
      if (document.aliases.some(alias => names[index].has(normalizedName(alias)))) addMatch(index, document.path, "alias");
    }
  });
  for (const [index, unit] of units.entries()) {
    for (const point of unit.points) {
      const query = point.trim();
      if (!query) continue;
      for (const hit of await port.searchWiki(query)) {
        if (wiki.has(hit.path)) addMatch(index, hit.path, "body");
      }
    }
    results[index].candidates = [...matches[index]].sort(([a], [b]) => compare(a, b)).map(([path, kinds]) => {
      const document = wiki.get(path)!;
      return {
        path,
        title: document.title,
        aliases: [...document.aliases].sort(compare),
        contentRevision: document.contentRevision,
        matches: (["title", "alias", "body"] as const).filter(kind => kinds.has(kind))
      } satisfies MaintenanceDedupCandidate;
    });
  }
  return results;
}
