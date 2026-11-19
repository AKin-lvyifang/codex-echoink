import type { PersonalMemoryRecord } from "./personal-memory-contracts";

export const MEMORY_ASSOCIATION_ADMISSION_THRESHOLD = 0.5;
export type MemoryAssociationOrigin = "cloud_probability" | "directory_selected" | "unseen_fallback";
export type MemoryAssociationJudgment = Readonly<{
  route: "decisions" | "directory";
  seenIds: readonly string[];
  probabilities?: Readonly<Record<string, number>>;
}>;

type Node = Pick<PersonalMemoryRecord, "id" | "title" | "status" | "supersedes" | "related" | "revision">;
/** Only current nodes contribute edges; superseded nodes supply redirects, never bodies. */
export function memoryAssociationGraph(records: readonly Node[], forgotten: ReadonlySet<string> = new Set()): ReadonlyMap<string, ReadonlySet<string>> {
  const byId = new Map(records.map(record => [record.id, record]));
  const next = new Map<string, Node>();
  for (const record of records) if (record.supersedes && (next.get(record.supersedes)?.revision ?? -1) < record.revision) next.set(record.supersedes, record);
  const resolve = (id: string): string | null => {
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(id) || forgotten.has(id)) return null;
      seen.add(id);
      const node = byId.get(id);
      if (!node) return null;
      if (node.status === "current") return id;
      if (node.status !== "superseded" || !next.has(id)) return null;
      id = next.get(id)!.id;
    }
  };
  const edges = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { const values = edges.get(a) ?? new Set<string>(); values.add(b); edges.set(a, values); };
  for (const node of records) {
    if (node.status !== "current" || forgotten.has(node.id)) continue;
    for (const raw of node.related ?? []) {
      const target = resolve(raw);
      if (target && target !== node.id) { add(node.id, target); add(target, node.id); }
    }
  }
  return edges;
}

/** Ranked one-hop targets; no lexical admission and no recursive expansion. */
export function relatedMemoryTargets(records: readonly Node[], seeds: readonly string[], eligible: ReadonlySet<string>, forgotten?: ReadonlySet<string>): readonly Readonly<{ id: string; relatedFrom: { id: string; title: string }; relatedParents: readonly { id: string; title: string }[] }>[] {
  const graph = memoryAssociationGraph(records, forgotten), byId = new Map(records.map(record => [record.id, record]));
  const targets = new Map<string, string[]>();
  for (const seed of seeds) for (const id of graph.get(seed) ?? []) {
    if (!eligible.has(id) || seeds.includes(id)) continue;
    targets.set(id, [...(targets.get(id) ?? []), seed]);
  }
  return [...targets].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([id, parents]) => ({
    id, relatedFrom: { id: parents[0], title: byId.get(parents[0])!.title },
    relatedParents: parents.map(parent => ({ id: parent, title: byId.get(parent)!.title }))
  }));
}
