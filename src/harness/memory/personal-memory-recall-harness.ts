import { estimatePiContextTokens } from "../pi-native/pi-context-budget";
import type {
  PersonalMemoryMode,
  PersonalMemorySearchItem,
  PersonalMemorySearchRequest,
  SecondaryMatchView
} from "./personal-memory-contracts";
import { PersonalMemoryRepository } from "./personal-memory-repository";
import type { PersonalMemoryTurnCatalogCandidate } from "./personal-memory-repository";

export type PersonalMemoryRecallCandidate = Pick<PersonalMemorySearchItem,
  "id" | "kind" | "title" | "recallWhen" | "summary" | "date" | "scope" | "score"
  | "basis" | "contentOrigin" | "status" | "asOf" | "supersedes" | "supersededRecord" | "sourceSummary" | "revision" | "file"
> & Readonly<{
  /** Secondary fact that decisively pulled this Memory into the candidates. */
  matchedSecondaryId?: string;
  /** All secondary facts of this Memory that matched the turn query. */
  secondaryMatches?: readonly SecondaryMatchView[];
}>;

export interface PersonalMemoryPreparedTurnContext {
  readonly revision: number;
  readonly agent: string;
  readonly user: string | null;
  readonly memory: string | null;
  readonly recall: Readonly<{
    readonly candidates: readonly Readonly<PersonalMemoryRecallCandidate>[];
    readonly exhaustive: boolean;
    readonly hasMore: boolean;
    readonly total: number;
    readonly injected: number;
    readonly remaining: number;
  }> | null;
  readonly injectionKeys: readonly string[];
}

export const PERSONAL_MEMORY_RECALL_STAGES = Object.freeze([
  "loading",
  "catalog",
  "matching",
  "budgeting",
  "assembling"
] as const);
export type PersonalMemoryRecallStage = typeof PERSONAL_MEMORY_RECALL_STAGES[number];
export interface PersonalMemoryRecallSafeStats {
  readonly result: "completed" | "skipped_no_memory" | "failed";
  readonly scanned: number;
  readonly candidates: number;
  readonly injected: number;
  readonly remaining: number;
  readonly exhausted: boolean;
}

export class PersonalMemoryRecallHarness {
  constructor(private readonly repository: PersonalMemoryRepository) {}

  async prepareTurnContext(input: Readonly<{
    memoryMode: PersonalMemoryMode;
    query: string;
    recentConversation?: readonly string[];
    /** Explicit boundaries; project recall also retains unscoped global Memory. */
    scope?: PersonalMemorySearchRequest["scope"];
    statuses?: PersonalMemorySearchRequest["statuses"];
    from?: PersonalMemorySearchRequest["from"];
    to?: PersonalMemorySearchRequest["to"];
    tokenBudget: number;
    vaultId: string;
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    onProgress?(
      stage: PersonalMemoryRecallStage,
      stats?: Readonly<PersonalMemoryRecallSafeStats>
    ): void | Promise<void>;
  }>): Promise<Readonly<PersonalMemoryPreparedTurnContext>> {
    await input.onProgress?.("loading");
    const tokenBudget = normalizeTokenBudget(input.tokenBudget);
    const query = input.memoryMode === "normal"
      ? buildBoundedRecallQuery(
          input.query,
          input.recentConversation ?? [],
          tokenBudget
        )
      : "";
    await input.onProgress?.("catalog");
    const snapshot = await this.repository.prepareTurnSnapshot({
      memoryMode: input.memoryMode,
      ...(input.memoryMode === "normal"
        ? {
            query,
            scope: input.scope,
            statuses: input.statuses,
            from: input.from,
            to: input.to,
            selectCandidateIds: (
              candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[]
            ) => selectRecallCandidateIds(candidates, tokenBudget)
          }
        : {})
    }, input.memoryMode === "normal" ? {
      vaultId: input.vaultId,
      conversationId: input.conversationId,
      piSessionId: input.piSessionId,
      productRunId: input.productRunId,
      memoryMode: "normal"
    } : undefined);
    const { search, scanned, ...fixed } = snapshot;
    if (input.memoryMode === "no_memory") {
      await input.onProgress?.("assembling", {
        result: "skipped_no_memory",
        scanned: 0,
        candidates: 0,
        injected: 0,
        remaining: 0,
        exhausted: true
      });
      return Object.freeze({
        ...fixed,
        recall: null,
        injectionKeys: Object.freeze([...fixed.injectionKeys])
      });
    }
    if (!search) throw new Error("personal_memory_recall_snapshot_missing_search");
    // Stats-only, fire-and-forget: never blocks or fails the turn.
    const pendingSecondaryHits = search.pendingSecondaryHits ?? [];
    if (pendingSecondaryHits.length > 0) {
      void this.repository.recordSecondaryRecallHits(pendingSecondaryHits).catch(() => {});
    }
    await input.onProgress?.("matching");
    await input.onProgress?.("budgeting");
    const candidates = fitSecondaryMatchesWithinBudget(
      search.items.map(toRecallCandidate),
      search.total,
      tokenBudget
    );
    const remaining = search.remaining;
    const exhaustive = search.exhausted;
    await input.onProgress?.("assembling", {
      result: "completed",
      scanned,
      candidates: search.total,
      injected: candidates.length,
      remaining,
      exhausted: exhaustive
    });
    return Object.freeze({
      ...fixed,
      recall: Object.freeze({
        candidates: Object.freeze(candidates),
        exhaustive,
        hasMore: !exhaustive,
        total: search.total,
        injected: candidates.length,
        remaining
      }),
      injectionKeys: Object.freeze([
        ...fixed.injectionKeys,
        "echoink.memory.recall"
      ])
    });
  }
}

export interface PersonalMemorySecondaryInjectionFact {
  readonly parentId: string;
  readonly parentTitle: string;
  readonly fact: SecondaryMatchView;
}

export interface SerializedRecallBlocks {
  /** `<echoink_memory_recall>` 区块：candidates 只带 matchedSecondaryId。 */
  readonly recallBlock: string;
  /** `<echoink_memory_secondary>` 区块；没有二级事实时为 null（完全省略）。 */
  readonly secondaryBlock: string | null;
  /** 最终注入文本 = recallBlock + 可选 secondaryBlock（与实际上下文逐字一致）。 */
  readonly combined: string;
}

/**
 * 最终上下文区块的唯一序列化入口（Round 6 修复一）：
 * - Recall JSON 不包含 secondaryFacts；candidates 只保留 matchedSecondaryId；
 * - 完整二级事实只出现在 secondary block，且每条只出现一次；
 * - routeTokens/contentTokens 等索引内部字段不进入任一区块；
 * - 预算函数与生产注入（pi-production-runtime-composition）都必须走这里，
 *   保证「预算函数测量的就是实际注入文本」。
 */
export function serializeRecallBlocks(input: Readonly<{
  candidates: readonly Readonly<PersonalMemoryRecallCandidate>[];
  secondaryFacts: readonly PersonalMemorySecondaryInjectionFact[];
  exhaustive: boolean;
  hasMore: boolean;
  total: number;
  injected: number;
  remaining: number;
}>): SerializedRecallBlocks {
  const candidates = input.candidates.map((candidate) => {
    // toRecallCandidate 已按白名单字段重建候选；再显式剥离 secondaryMatches，
    // 只保留 matchedSecondaryId（完整事实只允许出现在 secondary block）。
    const injected: Record<string, unknown> = { ...toRecallCandidate(candidate) };
    delete injected.secondaryMatches;
    return injected;
  });
  const recallBlock = [
    `<echoink_memory_recall trust="user-owned-memory" exhaustive="${input.exhaustive}" has_more="${input.hasMore}">`,
    JSON.stringify({
      candidates,
      total: input.total,
      injected: input.injected,
      remaining: input.remaining
    }),
    "</echoink_memory_recall>"
  ].join("\n");
  // 每条二级事实在最终上下文中只允许出现一次：按 fact.id 防御性去重，
  // 即使调用方传入重复引用（多个候选命中同一事实）。
  const seenFactIds = new Set<string>();
  const uniqueSecondaryFacts = input.secondaryFacts.filter((entry) => {
    if (seenFactIds.has(entry.fact.id)) return false;
    seenFactIds.add(entry.fact.id);
    return true;
  });
  const secondaryBlock = uniqueSecondaryFacts.length === 0
    ? null
    : [
        "<echoink_memory_secondary trust=\"llm-inferred-reference\">",
        JSON.stringify({ secondaryFacts: uniqueSecondaryFacts }),
        "</echoink_memory_secondary>"
      ].join("\n");
  return Object.freeze({
    recallBlock,
    secondaryBlock,
    combined: secondaryBlock === null ? recallBlock : `${recallBlock}\n\n${secondaryBlock}`
  });
}

function secondaryFactsFor(
  items: readonly Readonly<PersonalMemoryRecallCandidate>[]
): PersonalMemorySecondaryInjectionFact[] {
  const seen = new Set<string>();
  const facts: PersonalMemorySecondaryInjectionFact[] = [];
  for (const item of items) {
    for (const view of item.secondaryMatches ?? []) {
      if (seen.has(view.id)) continue;
      seen.add(view.id);
      facts.push({ parentId: item.id, parentTitle: item.title, fact: view });
    }
  }
  return facts;
}

/**
 * Token 预算必须按照最终真实注入内容计算（Round 6 修复一）：
 * 直接测量 serializeRecallBlocks().combined —— 即实际注入的区块文本，
 * 不再维护近似包装常量。`rankedTotal` 为完整排序候选数；缺省等于 items
 * 长度（最终注入测量）。候选预算阶段传入全量候选数，即可得到与最终
 * payload 完全一致的口径：total = 全量候选数，injected = 已选数，
 * remaining = total - injected，exhaustive = injected === total。
 */
export function measureFinalInjectionTokens(
  items: readonly Readonly<PersonalMemoryRecallCandidate>[],
  rankedTotal?: number
): number {
  const total = rankedTotal ?? items.length;
  const injected = items.length;
  const blocks = serializeRecallBlocks({
    candidates: items,
    secondaryFacts: secondaryFactsFor(items),
    total,
    injected,
    remaining: Math.max(0, total - injected),
    exhaustive: injected === total,
    hasMore: injected !== total
  });
  return estimatePiContextTokens(blocks.combined).tokens;
}

/** Primary records claim the budget first; association clues use only remainder. */
export function measurePrimaryInjectionTokens(
  items: readonly Readonly<PersonalMemoryRecallCandidate>[],
  rankedTotal?: number
): number {
  return measureFinalInjectionTokens(
    items.map((item) => stripSecondaryCandidate(toRecallCandidate(item))),
    rankedTotal
  );
}

function selectRecallCandidateIds(
  candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[],
  tokenBudget: number
): readonly string[] {
  const selected: PersonalMemoryTurnCatalogCandidate[] = [];
  for (const item of candidates) {
    const withCandidate = [...selected, item];
    // First reserve the complete primary-Memory block. Association clues are
    // fitted only after all selected primary records have claimed their space.
    if (measurePrimaryInjectionTokens(withCandidate, candidates.length) > tokenBudget) continue;
    selected.push(item);
  }
  return Object.freeze(selected.map((item) => item.id));
}

function fitSecondaryMatchesWithinBudget(
  candidates: readonly Readonly<PersonalMemoryRecallCandidate>[],
  rankedTotal: number,
  tokenBudget: number
): readonly Readonly<PersonalMemoryRecallCandidate>[] {
  let fitted = candidates.map(stripSecondaryCandidate);
  for (const [index, candidate] of candidates.entries()) {
    for (const fact of candidate.secondaryMatches ?? []) {
      const next = [...fitted];
      const current = next[index];
      next[index] = Object.freeze({
        ...current,
        secondaryMatches: Object.freeze([...(current.secondaryMatches ?? []), fact]),
        ...(candidate.matchedSecondaryId === fact.id
          ? { matchedSecondaryId: candidate.matchedSecondaryId }
          : {})
      });
      if (measureFinalInjectionTokens(next, rankedTotal) <= tokenBudget) {
        fitted = next;
      }
    }
  }
  return Object.freeze(fitted);
}

function stripSecondaryCandidate(
  candidate: Readonly<PersonalMemoryRecallCandidate>
): Readonly<PersonalMemoryRecallCandidate> {
  const { matchedSecondaryId: _matched, secondaryMatches: _matches, ...primary } = candidate;
  return Object.freeze(primary);
}

function toRecallCandidate(
  item: Readonly<PersonalMemoryRecallCandidate>
): Readonly<PersonalMemoryRecallCandidate> {
  return Object.freeze({
    id: item.id,
    kind: item.kind,
    title: item.title,
    recallWhen: item.recallWhen,
    summary: item.summary,
    date: item.date,
    status: item.status,
    basis: item.basis,
    sourceSummary: item.sourceSummary,
    ...(item.contentOrigin ? { contentOrigin: item.contentOrigin } : {}),
    ...(item.scope ? { scope: item.scope } : {}),
    ...(item.asOf ? { asOf: item.asOf } : {}),
    ...(item.supersedes ? { supersedes: item.supersedes } : {}),
    ...(item.supersededRecord ? {
      supersededRecord: Object.freeze({
        id: item.supersededRecord.id,
        ...(item.supersededRecord.asOf ? { asOf: item.supersededRecord.asOf } : {}),
        readHint: item.supersededRecord.readHint
      })
    } : {}),
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
    ...(item.file ? { file: item.file } : {}),
    score: item.score,
    ...(item.matchedSecondaryId ? { matchedSecondaryId: item.matchedSecondaryId } : {}),
    ...(item.secondaryMatches && item.secondaryMatches.length > 0
      ? { secondaryMatches: Object.freeze(item.secondaryMatches.map((view) => Object.freeze({ ...view }))) }
      : {})
  });
}

const MAX_RECALL_QUERY_CHARS = 2_000;

function buildBoundedRecallQuery(
  currentQuery: string,
  recentConversation: readonly string[],
  maxTokens: number
): string {
  const segments = [
    currentQuery,
    ...recentConversation.slice(-6).reverse()
  ].map((value) => value.trim()).filter(Boolean);
  let result = "";
  for (const segment of segments) {
    const separator = result ? "\n" : "";
    const remainingChars = MAX_RECALL_QUERY_CHARS - result.length - separator.length;
    if (remainingChars <= 0) break;
    const prefix = `${result}${separator}`;
    const fitted = fitSegment(prefix, segment.slice(0, remainingChars), maxTokens);
    if (!fitted) continue;
    result = `${prefix}${fitted}`;
    if (fitted.length < segment.length) break;
  }
  return result;
}

function fitSegment(prefix: string, segment: string, maxTokens: number): string {
  if (estimatePiContextTokens(`${prefix}${segment}`).tokens <= maxTokens) return segment;
  let low = 0;
  let high = segment.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimatePiContextTokens(`${prefix}${segment.slice(0, middle)}`).tokens <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return segment.slice(0, low);
}

function normalizeTokenBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("personal_memory_recall_token_budget_invalid");
  }
  return value;
}
