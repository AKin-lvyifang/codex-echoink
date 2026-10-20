/**
 * search-index-v3.ts — Search Index v3: derived index over primary memories
 * AND secondary facts (二级事实).
 *
 * Compatibility rules (任务书 §八):
 * - echoink.memory.v1 与 recallWhen 不变；
 * - Search Index 是派生文件，v2 可以直接重建为 v3；
 * - matchTerms 使用完整词或短语：中文用双字（bigram）词元，单个常见汉字
 *   不能独立让一条 Memory 进入候选。
 */

import { sha256Hex } from "../../utils/sha256";
import {
  type PersonalMemoryBasis,
  type PersonalMemoryKind,
  type PersonalMemoryStatus,
  type SecondaryBasis,
  type SecondaryMemoryRecord,
  type SecondaryRelation
} from "./personal-memory-contracts";

// ---------------------------------------------------------------------------
// Index shape
// ---------------------------------------------------------------------------

export interface SearchCatalogEntryV3 {
  readonly id: string;
  readonly kind: PersonalMemoryKind;
  readonly status: PersonalMemoryStatus;
  readonly title: string;
  readonly recallWhen: string;
  readonly date: string;
  readonly basis: PersonalMemoryBasis;
  readonly sourceSummary: string;
  readonly summary: string;
  readonly scope?: string;
  readonly routeTokens: readonly string[];
  readonly contentTokens: readonly string[];
}

export interface SecondaryCatalogEntry {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
  readonly matchTerms: readonly string[];
  readonly relation: SecondaryRelation;
  readonly basis: SecondaryBasis;
  readonly routeTokens: readonly string[];
  readonly contentTokens: readonly string[];
}

export interface SecondaryIndexEntry {
  readonly term: string;
  readonly parentId: string;
  readonly secondaryId: string;
}

export interface SearchIndexV3 {
  readonly schemaVersion: 3;
  readonly revision: number;
  readonly catalog: readonly SearchCatalogEntryV3[];
  readonly secondaryCatalog: readonly SecondaryCatalogEntry[];
  readonly secondaryIndex: readonly SecondaryIndexEntry[];
  readonly checksum: string;
}

// ---------------------------------------------------------------------------
// Tokenization: full words for latin, bigrams for CJK
// ---------------------------------------------------------------------------

/**
 * Lexical tokens for matching.
 * - Latin/digit words: whole token, including a single letter or digit.
 * - Han runs: every consecutive 2-character gram. A lone Han character never
 *   becomes a token by itself, so one common Chinese character can no longer
 *   pull unrelated memories into the candidate set.
 */
export function lexicalTokens(text: string): string[] {
  const tokens = new Set<string>();
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  for (const match of normalized.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const hanRuns = word.match(/\p{Script=Han}+/gu);
    if (hanRuns) {
      const nonHan = word.replace(/\p{Script=Han}+/gu, "\u0001");
      for (const part of nonHan.split("\u0001")) {
        if (part.length >= 1) tokens.add(part);
      }
      for (const run of hanRuns) {
        for (let index = 0; index + 2 <= run.length; index += 1) {
          tokens.add(run.slice(index, index + 2));
        }
      }
    } else if (word.length >= 1) {
      tokens.add(word);
    }
  }
  return [...tokens];
}

export function normalizeMatchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase();
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

export interface BuildIndexCatalogInput {
  readonly id: string;
  readonly kind: PersonalMemoryKind;
  readonly status: PersonalMemoryStatus;
  readonly title: string;
  readonly recallWhen: string;
  readonly date: string;
  readonly basis: PersonalMemoryBasis;
  readonly sourceSummary: string;
  readonly summary: string;
  readonly scope?: string;
  readonly content: string;
}

export function buildSearchIndexV3(
  manifestRevision: number,
  catalogInputs: readonly BuildIndexCatalogInput[],
  secondaryRecords: readonly SecondaryMemoryRecord[]
): SearchIndexV3 {
  const catalog: SearchCatalogEntryV3[] = catalogInputs
    .map((input) => Object.freeze({
      id: input.id,
      kind: input.kind,
      status: input.status,
      title: input.title,
      recallWhen: input.recallWhen,
      date: input.date,
      basis: input.basis,
      sourceSummary: input.sourceSummary,
      summary: input.summary,
      ...(input.scope ? { scope: input.scope } : {}),
      routeTokens: Object.freeze(lexicalTokens(`${input.title}\n${input.recallWhen}`)),
      contentTokens: Object.freeze(lexicalTokens(input.content))
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const parentIds = new Set(catalogInputs.map((input) => input.id));
  const currentSecondary = secondaryRecords
    .filter((record) => record.status === "current" && parentIds.has(record.parentId))
    .sort((left, right) => left.id.localeCompare(right.id));

  const secondaryCatalog: SecondaryCatalogEntry[] = currentSecondary.map((record) => Object.freeze({
    id: record.id,
    parentId: record.parentId,
    title: record.title,
    content: record.content.slice(0, 2_000),
    recallWhen: record.recallWhen,
    matchTerms: Object.freeze([...record.matchTerms]),
    relation: record.relation,
    basis: record.basis,
    routeTokens: Object.freeze(lexicalTokens(
      `${record.title}\n${record.recallWhen}\n${record.matchTerms.join("\n")}`
    )),
    contentTokens: Object.freeze(lexicalTokens(record.content))
  }));

  const secondaryIndex: SecondaryIndexEntry[] = [];
  for (const record of currentSecondary) {
    for (const term of record.matchTerms) {
      secondaryIndex.push(Object.freeze({
        term: normalizeMatchText(term),
        parentId: record.parentId,
        secondaryId: record.id
      }));
    }
  }
  secondaryIndex.sort(
    (left, right) => left.term.localeCompare(right.term) || left.secondaryId.localeCompare(right.secondaryId)
  );

  const checksum = indexChecksum(manifestRevision, catalog, secondaryCatalog, secondaryIndex);
  return Object.freeze({
    schemaVersion: 3,
    revision: manifestRevision,
    catalog: Object.freeze(catalog),
    secondaryCatalog: Object.freeze(secondaryCatalog),
    secondaryIndex: Object.freeze(secondaryIndex),
    checksum
  });
}

export function indexChecksum(
  revision: number,
  catalog: readonly SearchCatalogEntryV3[],
  secondaryCatalog: readonly SecondaryCatalogEntry[],
  secondaryIndex: readonly SecondaryIndexEntry[]
): string {
  return sha256Hex(JSON.stringify({
    revision,
    catalog,
    secondaryCatalog,
    secondaryIndex
  }));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface PrimaryScoreInput {
  readonly routeTokens: readonly string[];
  readonly contentTokens: readonly string[];
  readonly title: string;
  readonly recallWhen: string;
}

/** Primary-memory lexical score (no anchors; CJK bigram aware). */
export function scorePrimaryEntry(
  entry: PrimaryScoreInput,
  query: string,
  queryTokens: ReadonlySet<string>
): number {
  if (!query.trim() || queryTokens.size === 0) return 0;
  const normalizedQuery = normalizeMatchText(query);
  const hasHanPhrase = /\p{Script=Han}/u.test(normalizedQuery);
  const routeTokenSet = new Set(entry.routeTokens);
  const contentTokenSet = new Set(entry.contentTokens);
  const titleLower = normalizeMatchText(entry.title);
  const recallLower = normalizeMatchText(entry.recallWhen);

  let score = 0;
  if (hasHanPhrase && (titleLower.includes(normalizedQuery) || recallLower.includes(normalizedQuery))) {
    score += 3.0;
  } else if (hasHanPhrase
    && normalizeMatchText(`${entry.title}\n${entry.recallWhen}`).includes(normalizedQuery)) {
    score += 2.5;
  }

  let matchedRoute = 0;
  let matchedContent = 0;
  for (const token of queryTokens) {
    if (routeTokenSet.has(token)) {
      score += 1.0;
      matchedRoute += 1;
    }
    if (contentTokenSet.has(token)) {
      score += 0.45;
      matchedContent += 1;
    }
  }
  if (matchedRoute === 0 && matchedContent === 0) return 0;
  // Coverage bonus: a full-phrase (all-token) match ranks above partial hits.
  const coverage = matchedRoute / queryTokens.size;
  score += coverage * 1.6;
  if (hasHanPhrase && recallLower.length >= 4 && normalizedQuery.includes(recallLower)) {
    score += 1.0;
  }
  return score;
}

/** Secondary-fact match score against a query (matchTerms are the bridge). */
export function scoreSecondaryEntry(
  entry: SecondaryCatalogEntry,
  query: string,
  queryTokens: ReadonlySet<string>
): number {
  if (!query.trim()) return 0;
  const normalizedQuery = normalizeMatchText(query);
  let matchTermScore = 0;

  for (const term of entry.matchTerms) {
    const normalizedTerm = normalizeMatchText(term);
    if (!normalizedTerm) continue;
    const hasHanPhrase = /\p{Script=Han}/u.test(normalizedTerm);
    if (hasHanPhrase && normalizedTerm.length >= 2 && normalizedQuery.includes(normalizedTerm)) {
      matchTermScore += 2.4;
      continue;
    }
    const termTokens = lexicalTokens(normalizedTerm);
    if (termTokens.length > 0 && termTokens.every((token) => queryTokens.has(token))) {
      matchTermScore += 1.8;
    }
  }

  // Only matchTerms may make a parent eligible. Title, recallWhen and content
  // can refine ordering after that bridge has matched, never create a match.
  if (matchTermScore === 0) return 0;
  let score = matchTermScore;

  const routeTokenSet = new Set(entry.routeTokens);
  const contentTokenSet = new Set(entry.contentTokens);
  for (const token of queryTokens) {
    if (routeTokenSet.has(token)) score += 0.9;
    else if (contentTokenSet.has(token)) score += 0.35;
  }
  return score;
}
