import { PersonalMemoryAccessError } from './personal-memory-error';
import { memoryDirectoryAllows } from './memory-catalog';
import { memoryAssociationGraph, relatedMemoryTargets, MEMORY_ASSOCIATION_ADMISSION_THRESHOLD, type MemoryAssociationJudgment, type MemoryAssociationOrigin } from './memory-association';
import { automaticMemoryQueryTokens, memoryRelevanceScorer, memoryTemporalContext, rankMemory, type MemoryActivityState } from './memory-relevance';
import { scoreSecondaryEntry, type SearchIndexV3, type SecondaryCatalogEntry } from './search-index-core';
import type { PersonalMemoryRecord, PersonalMemorySearchItem, PersonalMemorySearchRequest, SecondaryMemoryRecord, SecondaryMatchView } from './personal-memory-contracts';
import type { PersonalMemoryManifest, PersonalMemoryTurnCatalogCandidate, PersonalMemoryTurnSearchResult } from './personal-memory-repository';
type SearchIndex = SearchIndexV3;
const MAX_SEARCH_LIMIT = 50;
export interface MemoryTurnSearchPort {
 now(): number;
 records: readonly PersonalMemoryRecord[];
 secondary: readonly SecondaryMemoryRecord[];
 activity(now: number, preview: boolean): Promise<MemoryActivityState>;
 readRecord(metadata: PersonalMemoryManifest['records'][number]): Promise<PersonalMemoryRecord>;
}
export async function prepareMemoryTurnSearch(
    deps: MemoryTurnSearchPort,
    request: Readonly<Pick<PersonalMemorySearchRequest, "query" | "scope" | "statuses" | "from" | "to"> & {
      preview?: boolean;
      now?: number;
      includeUnmatchedCandidates?: boolean;
      preferredCandidateIds?: readonly string[];
      associationJudgment?: MemoryAssociationJudgment;
    }>,
    manifest: PersonalMemoryManifest,
    index: Readonly<SearchIndex>,
    selectCandidateIds: ((
      candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[], requiredIds?: readonly string[], rankedTotal?: number
    ) => readonly string[] | Promise<readonly string[]>) | undefined
  ): Promise<Readonly<PersonalMemoryTurnSearchResult>> {
    const query = cleanOptional(request.query, "query", 2_000) ?? "";
    const queryTokens = automaticMemoryQueryTokens(query);
    const browseAll = query.length === 0;
    const queryTokenSet = new Set(queryTokens);
    const now = request.now ?? deps.now();
    const secondaryBest = bestSecondaryScores(index, query, queryTokenSet, true);
    const secondaryMatches = groupSecondaryMatches(index, query, queryTokenSet);
    const metadataById = new Map(manifest.records.map((record) => [record.id, record]));
    const cachedRecordsById = new Map(deps.records?.map((record) => [record.id, record]) ?? []);
    const secondaryById = new Map(deps.secondary.map((record) => [record.id, record]));
    const forgottenIds = new Set(manifest.tombstones.map((entry) => entry.recordId));
    const associationGraph = memoryAssociationGraph(manifest.records, forgottenIds);
    const scope = cleanOptional(request.scope, "scope", 240)?.toLocaleLowerCase();
    const withinBoundary = (record: Pick<PersonalMemoryRecord, "scope" | "date">) =>
      matchesRecallScope(record.scope, scope)
      && (!request.from || record.date >= request.from)
      && (!request.to || record.date <= request.to);
    const identityFor = (id: string) => {
      const record = cachedRecordsById.get(id) ?? metadataById.get(id);
      if (!record) {
        throw new PersonalMemoryAccessError("invalid_request", "Personal Memory turn index contains an unavailable record");
      }
      const { supersedes, ...rest } = searchItemIdentity(record);
      const identity = { ...rest, ...memoryTemporalContext(record, now) };
      // Resolve historical metadata only from this turn's manifest. A current
      // global record cannot expose a project history outside the turn scope.
      const previous = supersedes ? metadataById.get(supersedes) : undefined;
      const historyScope = scope ?? record.scope?.trim().toLocaleLowerCase() ?? "global";
      if (!previous || previous.id === id || forgottenIds.has(previous.id)
        || !withinBoundary(previous) || !matchesRecallScope(previous.scope, historyScope)) {
        return identity;
      }
      return {
        ...identity,
        supersedes,
        ...(record.status === "current" ? {
          supersededRecord: Object.freeze({
            id: previous.id,
            ...(previous.asOf ? { asOf: previous.asOf } : {}),
            readHint: "需要旧原文时按此 id 调用 memory_read，includeHistorical=true；旧内容只作历史参考。"
          })
        } : {})
      };
    };
    const secondaryViewFor = (entry: SecondaryCatalogEntry) =>
      toSecondaryMatchView(entry, secondaryById.get(entry.id));
    const directoryMode = request.includeUnmatchedCandidates === true || request.preferredCandidateIds !== undefined;
    const statuses = new Set((request.statuses ?? ["current"]).filter(status => !directoryMode || status === "current"));
    // A project boundary keeps global preferences alongside this project's
    // records. Historical records remain opt-in through explicit statuses.
    const eligible = index.catalog
      .filter((record) => statuses.has(record.status))
      .filter(withinBoundary)
      .filter(record => !directoryMode || metadataById.get(record.id)?.status === "current" && !forgottenIds.has(record.id))
      .filter(record => directoryMode ? memoryDirectoryAllows(metadataById.get(record.id)!, request) : !metadataById.get(record.id)?.pinned);
    const activity = await deps.activity(now, !!request.preview);
    const scorePrimary = memoryRelevanceScorer(eligible, query, "automatic", queryTokens);
    const lifecycleRanked = eligible
      .map((record) => {
        const primaryScore = scorePrimary(record);
        const secondary = secondaryBest.get(record.id);
        return {
          record,
          primaryScore,
          secondary,
          ...rankMemory(primaryScore + (secondary?.score ?? 0), metadataById.get(record.id)!, activity, now, query, "automatic")
        };
      })
      .filter(entry => directoryMode || entry.eligible);
    const preferredOrder = new Map((request.preferredCandidateIds ?? []).map((id, index) => [id, index]));
    const validPreferredIds = new Set(lifecycleRanked.filter(entry => preferredOrder.has(entry.record.id)).map(entry => entry.record.id));
    const admit = (id: string, score: number) => {
      if (request.preferredCandidateIds !== undefined) return validPreferredIds.has(id);
      return request.includeUnmatchedCandidates === true || validPreferredIds.has(id)
        || (request.preferredCandidateIds === undefined && browseAll)
        || (queryTokens.length > 0 && score > 0);
    };
    const preferredRank = (id: string) => validPreferredIds.has(id) ? preferredOrder.get(id)! : Number.MAX_SAFE_INTEGER;
    const ranked = lifecycleRanked
      .filter(entry => admit(entry.record.id, entry.score))
      .sort((left, right) =>
        preferredRank(left.record.id) - preferredRank(right.record.id)
        || right.score - left.score
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      );
    const catalogCandidates = Object.freeze(ranked.map(({ record, score, recallReason, activity }) => {
      const matches = secondaryMatches.get(record.id);
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: record.summary,
        date: record.date,
        ...identityFor(record.id),
        recallReason,
        score,
        activity, related: [...(associationGraph.get(record.id) ?? [])],
        ...(matches && matches.length > 0
          ? { secondaryMatches: Object.freeze(matches.map(secondaryViewFor)) }
          : {})
      });
    }));
    const requestedIds = selectCandidateIds
      ? [...await selectCandidateIds(catalogCandidates)]
      : catalogCandidates.slice(0, MAX_SEARCH_LIMIT).map((candidate) => candidate.id);
    type RankedEntry = Omit<(typeof ranked)[number], "recallReason"> & { recallReason: NonNullable<PersonalMemorySearchItem["recallReason"]> };
    const rankedById = new Map<string, RankedEntry>(ranked.map((entry) => [entry.record.id, entry]));
    const selectedIds = new Set<string>();
    for (const id of requestedIds) {
      if (selectedIds.has(id) || !rankedById.has(id)) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn candidate selection is invalid"
        );
      }
      selectedIds.add(id);
    }
    // A secondary match counts as "decisive" when its parent would NOT have
    // made the candidate set on primary-memory scores alone. Re-run the exact
    // production selector over a primary-only ranking: candidate count is not
    // a valid proxy because the token-budget selector can skip one oversized
    // record and still admit smaller records that follow it.
    const primaryOnlyCandidates = Object.freeze(eligible
      .map((record) => {
        const lifecycle = rankMemory(scorePrimary(record), metadataById.get(record.id)!, activity, now, query, "automatic");
        return { record, primaryScore: lifecycle.score, ...lifecycle };
      })
      .filter(entry => (directoryMode || entry.eligible) && admit(entry.record.id, entry.primaryScore))
      .sort((left, right) =>
        preferredRank(left.record.id) - preferredRank(right.record.id)
        || right.primaryScore - left.primaryScore
        || right.record.date.localeCompare(left.record.date)
        || left.record.id.localeCompare(right.record.id)
      )
      .map(({ record, primaryScore, recallReason, activity }) => Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: record.summary,
        date: record.date,
        ...identityFor(record.id),
        recallReason,
        score: primaryScore,
        activity
      })));
    const primaryOnlyRequestedIds = selectCandidateIds
      ? [...await selectCandidateIds(primaryOnlyCandidates)]
      : primaryOnlyCandidates.slice(0, MAX_SEARCH_LIMIT).map((candidate) => candidate.id);
    const primaryOnlyCandidateSet = new Set(primaryOnlyRequestedIds);
    const pendingSecondaryHits: Array<Readonly<{ secondaryId: string; parentId: string }>> = [];
    const decisiveSecondaryId = new Map<string, string>();
    for (const id of requestedIds) {
      const entry = rankedById.get(id)!;
      if (!entry.secondary) continue;
      if (!primaryOnlyCandidateSet.has(id)) {
        decisiveSecondaryId.set(id, entry.secondary.entry.id);
        pendingSecondaryHits.push(Object.freeze({ secondaryId: entry.secondary.entry.id, parentId: id }));
      }
    }
    const linked = new Map<string, { id: string; title: string }>();
    const associationSources: Record<string, MemoryAssociationOrigin> = {};
    let addedAssociations = 0;
    const usedSeeds = new Map<string, number>();
    const judgment = request.associationJudgment;
    const seen = new Set(judgment?.seenIds ?? []);
    const seeds: string[] = [];
    // The directory model already selected these entries. Attribute only to an
    // earlier, admitted primary seed; this never creates a new model selection.
    for (const id of requestedIds) {
      const parentId = judgment?.route === "directory" && linked.size < 3
        ? seeds.find(seed => associationGraph.get(seed)?.has(id) && (usedSeeds.get(seed) ?? 0) < 2) : undefined;
      if (parentId) {
        linked.set(id, { id: parentId, title: metadataById.get(parentId)!.title });
        associationSources[id] = "directory_selected";
        usedSeeds.set(parentId, (usedSeeds.get(parentId) ?? 0) + 1);
      } else seeds.push(id);
    }
    if (!request.includeUnmatchedCandidates && requestedIds.length) {
      const associationEligible = new Set(eligible.map(record => record.id));
      const targets = relatedMemoryTargets(manifest.records, seeds, associationEligible, forgottenIds);
      const mainCandidates = catalogCandidates.filter(candidate => selectedIds.has(candidate.id));
      const admitted: PersonalMemoryTurnCatalogCandidate[] = [...mainCandidates];
      for (const target of targets) {
        if (linked.size >= 3) break;
        if (requestedIds.includes(target.id)) continue;
        if (seen.has(target.id) && (judgment?.route === "directory"
          || !(Number.isFinite(judgment?.probabilities?.[target.id]) && judgment!.probabilities![target.id] >= MEMORY_ASSOCIATION_ADMISSION_THRESHOLD))) continue;
        const parent = target.relatedParents.find(parent => (usedSeeds.get(parent.id) ?? 0) < 2);
        if (!parent) continue;
        const record = index.catalog.find(record => record.id === target.id)!;
        const candidate = { ...record, ...identityFor(record.id), score: 0, activity: 0, recallReason: "related" as const, relatedFrom: parent };
        const proposal = [...admitted, candidate];
        const fitted = selectCandidateIds ? await selectCandidateIds(proposal, requestedIds, ranked.length + addedAssociations + 1) : proposal.map(item => item.id);
        if (!proposal.every(item => fitted.includes(item.id))) continue;
        linked.set(record.id, parent); usedSeeds.set(parent.id, (usedSeeds.get(parent.id) ?? 0) + 1); admitted.push(candidate); requestedIds.push(record.id);
        associationSources[record.id] = seen.has(record.id) ? "cloud_probability" : "unseen_fallback";
        addedAssociations++;
        rankedById.set(record.id, { record, score: 0, activity: 0, primaryScore: 0, secondary: undefined,
          recallReason: "related", layer: "peripheral", multiplier: 1, eligible: true });
      }
    }
    const items = await Promise.all(requestedIds.map(async (id) => {
      const rankedEntry = rankedById.get(id)!;
      const metadata = metadataById.get(id);
      if (!metadata) {
        throw new PersonalMemoryAccessError(
          "invalid_request",
          "Personal Memory turn index contains an unavailable record"
        );
      }
      const full = await deps.readRecord(metadata);
      const record = rankedEntry.record;
      const matched = secondaryMatches.get(id) ?? [];
      return Object.freeze({
        id: record.id,
        kind: record.kind,
        title: record.title,
        recallWhen: record.recallWhen,
        summary: summarize(full.content),
        date: record.date,
        ...identityFor(id),
        score: rankedEntry.score,
        recallReason: linked.has(id) ? "related" as const : rankedEntry.recallReason,
        ...(linked.has(id) ? { relatedFrom: linked.get(id)! } : {}),
        ...(decisiveSecondaryId.has(id) ? { matchedSecondaryId: decisiveSecondaryId.get(id)! } : {}),
        ...(matched.length > 0 ? { secondaryMatches: Object.freeze(matched.map(secondaryViewFor)) } : {})
      });
    }));
    const total = ranked.length + addedAssociations;
    const returned = items.length;
    return Object.freeze({
      revision: manifest.revision,
      total,
      returned,
      remaining: total - returned,
      exhausted: returned === total,
      items: Object.freeze(items),
      associationSources: Object.freeze(associationSources),
      directory: Object.freeze(index.catalog.filter(record => memoryDirectoryAllows(metadataById.get(record.id)!, request)).map(record => ({
        id: record.id, title: record.title, recallWhen: record.recallWhen, kind: record.kind, date: record.date,
        summary: record.summary, activity: rankMemory(0, metadataById.get(record.id)!, activity, now, query, "search").activity }))),
      pendingSecondaryHits: Object.freeze(pendingSecondaryHits)
    });
  }
export function bestSecondaryScores(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>,
  requireQueryTokenMatch = false
): Map<string, { score: number; entry: SecondaryCatalogEntry }> {
  const best = new Map<string, { score: number; entry: SecondaryCatalogEntry }>();
  if (!query.trim()) return best;
  for (const entry of index.secondaryCatalog) {
    const score = scoreSecondaryEntry(entry, query, queryTokens, requireQueryTokenMatch);
    if (score <= 0) continue;
    const current = best.get(entry.parentId);
    if (!current || score > current.score) best.set(entry.parentId, { score, entry });
  }
  return best;
}

export function groupSecondaryMatches(
  index: Readonly<SearchIndex>,
  query: string,
  queryTokens: ReadonlySet<string>
): Map<string, SecondaryCatalogEntry[]> {
  const matches = new Map<string, SecondaryCatalogEntry[]>();
  if (!query.trim()) return matches;
  for (const entry of index.secondaryCatalog) {
    if (scoreSecondaryEntry(entry, query, queryTokens, true) <= 0) continue;
    const list = matches.get(entry.parentId) ?? [];
    list.push(entry);
    matches.set(entry.parentId, list);
  }
  return matches;
}

export function matchesRecallScope(recordScope: string | undefined, requestedScope: string | undefined): boolean {
  if (!requestedScope) return true;
  const scope = recordScope?.trim().toLocaleLowerCase();
  return !scope
    || scope === "global"
    || scope.replace(/^project:/u, "").trim() === requestedScope.replace(/^project:/u, "").trim();
}

export function searchItemIdentity(record: Omit<PersonalMemoryRecord, "content">): Pick<PersonalMemorySearchItem,
  "status" | "basis" | "sourceSummary" | "contentOrigin" | "scope" | "asOf" | "supersedes" | "revision" | "file"
> {
  return {
    status: record.status,
    basis: record.basis,
    sourceSummary: summarize(summarizeSource(record.source)),
    ...(record.contentOrigin ? { contentOrigin: record.contentOrigin } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.asOf ? { asOf: record.asOf } : {}),
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    revision: record.revision,
    file: record.file
  };
}

export function toSecondaryMatchView(
  entry: SecondaryCatalogEntry,
  cached?: SecondaryMemoryRecord
): SecondaryMatchView {
  const support = cached?.parentId === entry.parentId ? cached : undefined;
  return Object.freeze({
    id: entry.id,
    parentId: entry.parentId,
    title: entry.title,
    content: entry.content,
    recallWhen: entry.recallWhen,
    matchTerms: Object.freeze([...entry.matchTerms]),
    relation: entry.relation,
    basis: entry.basis,
    ...(support?.status ? { status: support.status } : {}),
    ...(support?.supportLevel ? { supportLevel: support.supportLevel } : {}),
    ...(support?.evidence ? { evidence: support.evidence } : {}),
    ...(support?.sourceMemoryRevision !== undefined
      ? { sourceMemoryRevision: support.sourceMemoryRevision }
      : {})
  });
}

export function summarize(content: string): string {
  const compact = content.replaceAll(/\s+/gu, " ").trim();
  return compact.length <= 240 ? compact : `${compact.slice(0, 237)}…`;
}

export function summarizeSource(source: string): string {
  if (source.startsWith("pi://")) {
    const [base] = source.split("?");
    const segments = base.split("/");
    return `pi://…/${segments.at(-2) ?? "session"}/${segments.at(-1) ?? "entry"}`;
  }
  return source;
}

export function cleanRequired(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string") throw new PersonalMemoryAccessError("invalid_request", `${name} must be text`);
  const clean = value.trim();
  if (!clean || clean.length > maxChars || hasDisallowedControlCharacters(clean)) {
    throw new PersonalMemoryAccessError("invalid_request", `${name} is empty, too large, or contains control characters`);
  }
  return clean;
}

export function cleanOptional(value: unknown, name: string, maxChars: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return cleanRequired(value, name, maxChars);
}

export function hasDisallowedControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || code === 0x7f
    ) return true;
  }
  return false;
}
