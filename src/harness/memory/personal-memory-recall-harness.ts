import { buildMemoryNavigation } from "./memory-navigation";
import { MEMORY_ASSOCIATION_ADMISSION_THRESHOLD, type MemoryAssociationJudgment } from "./memory-association";
import { prepareMemoryCatalog, normalizeMemoryDirectoryNames } from "./memory-catalog";
import type { MemoryRecallReceipt, MemoryRecallAttempt } from "./memory-recall-receipt";
import { estimateTokenValue } from "../usage/token-estimator";
import { estimateTokenValueAsync } from "../usage/token-estimator";
import type {
  PersonalMemoryMode,
  PersonalMemorySearchItem,
  PersonalMemorySearchRequest,
  SecondaryMatchView
} from "./personal-memory-contracts";
import type { PersonalMemoryRepository } from "./personal-memory-repository";
import type { PersonalMemoryTurnCatalogCandidate } from "./personal-memory-repository";
import {
  selectMemoryDirectory,
  type MemoryDirectoryEntry,
  type MemoryDirectoryLlmPort,
  type MemoryDirectorySelectionResult
} from "./memory-directory-selector";

export type PersonalMemoryRecallCandidate = Pick<PersonalMemorySearchItem,
  "id" | "kind" | "title" | "recallWhen" | "summary" | "date" | "scope" | "score" | "daysAgo" | "due" | "overdue" | "recallReason" | "relatedFrom"
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
  readonly core?: readonly import("./personal-memory-contracts").PersonalMemoryCoreCandidate[];
  readonly recall: Readonly<{
    readonly candidates: readonly Readonly<PersonalMemoryRecallCandidate>[];
    readonly exhaustive: boolean;
    readonly hasMore: boolean;
    readonly total: number;
    readonly injected: number;
    readonly remaining: number;
  }> | null;
  readonly injectionKeys: readonly string[];
  /** Diagnostic receipt only; the prompt serializer does not include this. */
  readonly directorySelection?: MemoryDirectorySelectionResult;
  readonly selectionReceipt?: MemoryRecallReceipt;
  readonly navigation?: Awaited<ReturnType<typeof buildMemoryNavigation>>;
}

export interface PersonalMemoryRecallHarnessOptions {
  readonly directory?: Readonly<{ llm: MemoryDirectoryLlmPort; modelInputBudget: number }>;
  /** 智能判断（PRO）挑记忆；返回 null 时回到 directory 的大模型挑选。 */
  readonly decisions?: Readonly<{
    diagnostic?(turnId: string): Readonly<{ reason?: string; threshold?: number; orderEnsemble?: "full" | "partial" }> | undefined;
    judgeMemory(input: Readonly<{ turnId: string; text: string; recent?: readonly string[]; memories: readonly MemoryDirectoryEntry[] }>): Promise<Readonly<{ selected: readonly string[]; probabilities: Readonly<Record<string, number>> }> | null>;
  }>;
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

/** Capability shared with role-aware hosts; legacy string[] callers stay valid. */
export const PERSONAL_MEMORY_RECALL_HISTORY_POLICY =
  "current_query_with_unresolved_reference_previous_user_v1";

export function selectMemoryRecallPreviousUserContext(
  history: readonly Readonly<{ role: string; content: string }>[]
): readonly string[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.role === "user" && turn.content.trim()) {
      return Object.freeze([turn.content.trim()]);
    }
  }
  return Object.freeze([]);
}

export class PersonalMemoryRecallHarness {
  constructor(
    private readonly repository: Pick<PersonalMemoryRepository, "prepareTurnSnapshot" | "recordSecondaryRecallHits">,
    private readonly options: PersonalMemoryRecallHarnessOptions = {}
  ) {}

  async prepareTurnContext(input: Readonly<{
    memoryMode: PersonalMemoryMode;
    preview?: boolean;
    skipDirectory?: boolean;
    signal?: AbortSignal;
    now?: number;
    query: string;
    /** Previous user context when known; untyped legacy text is never role-inferred. */
    recentConversation?: readonly string[];
    /** Explicit boundaries; project recall also retains unscoped global Memory. */
    scope?: PersonalMemorySearchRequest["scope"];
    statuses?: PersonalMemorySearchRequest["statuses"];
    from?: PersonalMemorySearchRequest["from"];
    to?: PersonalMemorySearchRequest["to"];
    tokenBudget: number;
    availableInputTokens?: number;
    vaultId: string;
    conversationId: string;
    piSessionId: string;
    productRunId: string;
    /** 与本轮 /turn 相同的 turnId；有它才请求智能判断。 */
    decisionTurnId?: string;
    onProgress?(
      stage: PersonalMemoryRecallStage,
      stats?: Readonly<PersonalMemoryRecallSafeStats>
    ): void | Promise<void>;
  }>): Promise<Readonly<PersonalMemoryPreparedTurnContext>> {
    const selectionStartedAt = Date.now();
    let selectionQuery = input.query;
    const attempts: MemoryRecallAttempt[] = [];
    let catalogCount = 0;
    let rankedIds: readonly string[] = []; let rankedCaptured = false;
    await input.onProgress?.("loading");
    if (input.signal?.aborted) throw new Error("memory_recall_aborted");
    const tokenBudget = normalizeTokenBudget(input.tokenBudget);
    const query = input.memoryMode === "normal"
      ? await buildBoundedRecallQuery(
          input.query,
          input.recentConversation ?? [],
          tokenBudget
        )
      : "";
    await input.onProgress?.("catalog");
    if (input.signal?.aborted) throw new Error("memory_recall_aborted");
    const request = {
      memoryMode: input.memoryMode,
      preview: input.preview,
      now: input.now,
      ...(input.memoryMode === "normal"
        ? {
            query,
            scope: input.scope,
            statuses: input.statuses,
            from: input.from,
            to: input.to
          }
        : {})
    };
    const runtime = input.memoryMode === "normal" ? {
      vaultId: input.vaultId,
      conversationId: input.conversationId,
      piSessionId: input.piSessionId,
      productRunId: input.productRunId,
      memoryMode: "normal" as const
    } : undefined;
    let directorySelection: MemoryDirectorySelectionResult | undefined;
    let associationJudgment: MemoryAssociationJudgment | undefined;
    const decisions = input.decisionTurnId ? this.options.decisions : undefined;
    if ((this.options.directory || decisions) && input.memoryMode === "normal" && !input.preview && !input.skipDirectory) {
      let catalog: readonly MemoryDirectoryEntry[] = [];
      let captured = false;
      let localMatch = false;
      await this.repository.prepareTurnSnapshot({
        ...request,
        preview: true,
        includeUnmatchedCandidates: true,
        selectCandidateIds(candidates) {
          if (!captured) {
            localMatch = candidates.some(candidate => candidate.score > 0);
            catalog = candidates.map(candidate => ({ id: candidate.id, title: candidate.title,
              recallWhen: candidate.recallWhen, summary: candidate.summary, kind: candidate.kind, date: candidate.date,
              activity: candidate.activity ?? 0, score: candidate.score, secondaryMatch: !!candidate.secondaryMatches?.length, related: candidate.related })).sort((a, b) => a.id.localeCompare(b.id));
            captured = true;
          }
          return [];
        }
      }, runtime);
      catalogCount = catalog.length;
      selectionQuery = normalizeMemoryDirectoryNames(input.query, catalog);
      // 智能判断一次判断全部记忆（只按规则过滤过的目录，不做关键词预筛），拿到结果就不再调用户的大模型。
      let judgedEmpty = false;
      if (decisions && catalog.length) {
        const startedAt = Date.now();
        // Drex owns its model budget/chunking. A small chat model must not trim the cloud catalog.
        const sent = await prepareMemoryCatalog(catalog, { tokenBudget: Number.POSITIVE_INFINITY, maxEntries: 1_000 });
        let judged = sent.entries.length ? await decisions.judgeMemory({
          turnId: input.decisionTurnId!, text: selectionQuery, recent: input.recentConversation,
          memories: sent.entries
        }).catch(() => null) : null;
        const invalidProbabilities = judged && !sent.entries.every(entry => typeof judged!.probabilities?.[entry.id] === "number"
          && Number.isFinite(judged!.probabilities[entry.id]) && judged!.probabilities[entry.id] >= 0 && judged!.probabilities[entry.id] <= 1);
        if (invalidProbabilities) judged = null;
        const diagnostic = decisions.diagnostic?.(input.decisionTurnId!);
        attempts.push({ catalogCount: catalog.length, sentCount: sent.entries.length, sentIds: sent.entries.map(entry => entry.id), ...(sent.prefiltered ? { prefilterReason: sent.reason } : {}), route: "decisions", status: judged ? "selected" : "fallback", selectedIds: judged?.selected ?? [],
          ...(diagnostic?.threshold === undefined ? {} : { threshold: diagnostic.threshold }),
          ...(diagnostic?.orderEnsemble ? { orderEnsemble: diagnostic.orderEnsemble } : {}),
          ...(!judged ? { reason: invalidProbabilities ? "invalid_response" : diagnostic?.reason ?? "unavailable" } : !judged.selected.length && localMatch ? { reason: "empty_local_hit" } : {}),
          elapsedMs: Date.now() - startedAt });
        if (judged) {
          const known = new Set(catalog.map(entry => entry.id));
          const ids = judged.selected.filter(id => known.has(id));
          judgedEmpty = ids.length === 0;
          if (ids.length || !localMatch || !this.options.directory) {
            associationJudgment = { route: "decisions", seenIds: sent.entries.map(entry => entry.id), probabilities: judged.probabilities };
            directorySelection = Object.freeze({ status: "selected" as const, ids: Object.freeze(ids),
            stats: Object.freeze({ catalogCount: catalog.length, included: catalog.length, truncated: 0, tokens: 0, elapsedMs: Date.now() - startedAt }) });
          }
        }
      }
      const pickDirectory = async (reason?: string) => {
        const directory = this.options.directory!;
        const result = await selectMemoryDirectory({ entries: catalog, query: selectionQuery, now: input.now,
          recentConversation: input.recentConversation, modelInputBudget: directory.modelInputBudget,
          llm: directory.llm, memoryMode: input.memoryMode, signal: input.signal });
        associationJudgment = result.status === "selected" ? { route: "directory", seenIds: result.stats.sentIds ?? [] } : undefined;
        attempts.push({ route: "directory", catalogCount: result.stats.catalogCount, sentCount: result.stats.included, sentIds: result.stats.sentIds, prefilterReason: result.stats.prefilterReason, status: result.status, selectedIds: result.ids,
          elapsedMs: result.stats.elapsedMs, ...(result.stats.reason || reason ? { reason: result.stats.reason ?? reason } : {}) });
        return result;
      };
      if (!directorySelection && this.options.directory) directorySelection = await pickDirectory(judgedEmpty ? "empty_local_hit_review" : undefined);
      if (!judgedEmpty && directorySelection?.status === "selected" && !directorySelection.ids.length
        && localMatch && this.options.directory) directorySelection = await pickDirectory("empty_local_hit_review");
    }
    if (input.signal?.aborted) throw new Error("memory_recall_aborted");
    const snapshot = await this.repository.prepareTurnSnapshot({
      ...request,
      ...(directorySelection?.status === "selected" ? { preferredCandidateIds: directorySelection.ids } : {}),
      ...(associationJudgment ? { associationJudgment } : {}),
      ...(input.memoryMode === "normal" ? {
        selectCandidateIds: (candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[], requiredIds?: readonly string[], rankedTotal?: number) => {
          if (!rankedCaptured && !requiredIds?.length) { rankedIds = candidates.map(candidate => candidate.id); rankedCaptured = true; }
          return selectRecallCandidateIds(candidates, tokenBudget, requiredIds, rankedTotal);
        }
      } : {})
    }, runtime);
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
        selectionReceipt: { schemaVersion: 1 as const, route: "skipped" as const, reason: "no_memory",
          candidateCount: 0, selectedCount: 0, injectedCount: 0, selectedIds: [], injectedIds: [], coreIds: [],
          elapsedMs: Date.now() - selectionStartedAt, attempts },
        recall: null,
        injectionKeys: Object.freeze([...fixed.injectionKeys])
      });
    }
    if (!search) throw new Error("personal_memory_recall_snapshot_missing_search");
    // Stats-only, fire-and-forget: never blocks or fails the turn.
    const pendingSecondaryHits = search.pendingSecondaryHits ?? [];
    if (!input.preview && pendingSecondaryHits.length > 0) {
      void this.repository.recordSecondaryRecallHits(pendingSecondaryHits).catch(() => {});
    }
    await input.onProgress?.("matching");
    await input.onProgress?.("budgeting");
    const candidates = await fitSecondaryMatchesWithinBudget(
      search.items.map(toRecallCandidate),
      search.total,
      tokenBudget
    );
    const delivered = new Set([...candidates.map(candidate => candidate.id), ...(fixed.core ?? []).map(core => core.id)]);
    const fixedTokens = await estimateTokenValueAsync({ user: fixed.user, core: fixed.core, recall: finalInjectionText(candidates, search.total) });
    const navigation = !input.preview && !input.skipDirectory ? await buildMemoryNavigation(search.directory ?? [], delivered,
      Math.max(0, (input.availableInputTokens ?? this.options.directory?.modelInputBudget ?? 0) - fixedTokens - 128)) : undefined;
    const remaining = search.remaining;
    const exhaustive = search.exhausted;
    const receiptRoute: MemoryRecallReceipt["route"] = directorySelection?.status === "selected"
      ? attempts.at(-1)?.route ?? "directory" : "lexical";
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
      ...(directorySelection ? { directorySelection } : {}),
      ...(navigation ? { navigation } : {}),
      selectionReceipt: {
        schemaVersion: 1 as const,
        route: receiptRoute,
        ...(attempts.length ? {} : { reason: input.preview ? "preview" : input.skipDirectory ? "skip_directory" : "no_semantic_provider" }),
        ...(navigation ? { navigation: { total: navigation.total, listed: navigation.listed, truncated: navigation.truncated, tokens: navigation.tokens } } : {}),
        expandedIds: candidates.filter(candidate => candidate.relatedFrom).map(candidate => candidate.id),
        expandedFrom: Object.fromEntries(candidates.filter(candidate => candidate.relatedFrom).map(candidate => [candidate.id, candidate.relatedFrom!.id])),
        expandedSources: Object.fromEntries(candidates.filter(candidate => candidate.relatedFrom).map(candidate => [candidate.id, search.associationSources?.[candidate.id] ?? "unseen_fallback"])),
        ...(associationJudgment?.route === "decisions" ? { associationThreshold: MEMORY_ASSOCIATION_ADMISSION_THRESHOLD } : {}),
        candidateCount: catalogCount || search.total,
        selectedIds: directorySelection?.status === "selected" ? directorySelection.ids : rankedIds,
        selectedCount: directorySelection?.status === "selected" ? directorySelection.ids.length : rankedIds.length,
        injectedIds: candidates.map(candidate => candidate.id), injectedCount: candidates.length,
        coreIds: (fixed.core ?? []).map(core => core.id), elapsedMs: Date.now() - selectionStartedAt, attempts
      },
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
        "echoink.memory.recall",
        ...(navigation?.content ? ["echoink.memory.navigation"] : [])
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
    delete injected.file;
    delete injected.score;
    delete injected.sourceSummary;
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
  return estimateTokenValue(finalInjectionText(items, rankedTotal));
}

function finalInjectionText(items: readonly Readonly<PersonalMemoryRecallCandidate>[], rankedTotal?: number): string {
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
  return blocks.combined;
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

async function selectRecallCandidateIds(
  candidates: readonly Readonly<PersonalMemoryTurnCatalogCandidate>[],
  tokenBudget: number, requiredIds: readonly string[] = [], rankedTotal = candidates.length
): Promise<readonly string[]> {
  const selected: PersonalMemoryTurnCatalogCandidate[] = candidates.filter(item => requiredIds.includes(item.id));
  for (const item of candidates) {
    if (requiredIds.includes(item.id)) continue;
    const withCandidate = [...selected, item];
    // First reserve the complete primary-Memory block. Association clues are
    // fitted only after all selected primary records have claimed their space.
    if (await estimateTokenValueAsync(finalInjectionText(withCandidate.map(item => stripSecondaryCandidate(toRecallCandidate(item))), rankedTotal)) > tokenBudget) continue;
    selected.push(item);
  }
  return Object.freeze(selected.map((item) => item.id));
}

async function fitSecondaryMatchesWithinBudget(
  candidates: readonly Readonly<PersonalMemoryRecallCandidate>[],
  rankedTotal: number,
  tokenBudget: number
): Promise<readonly Readonly<PersonalMemoryRecallCandidate>[]> {
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
      if (await estimateTokenValueAsync(finalInjectionText(next, rankedTotal)) <= tokenBudget) {
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
    ...(item.recallReason ? { recallReason: item.recallReason } : {}),
    ...(item.relatedFrom ? { relatedFrom: Object.freeze({ ...item.relatedFrom }) } : {}),
    ...(item.daysAgo !== undefined ? { daysAgo: item.daysAgo } : {}),
    ...(item.due ? { due: item.due, overdue: item.overdue } : {}),
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

function needsPreviousUserContext(currentQuery: string): boolean {
  // A leading explicit pronoun has no antecedent in this question. Keep this
  // gate narrow: a named subject, a bare 那/呢 or a later pronoun cannot opt in.
  const query = currentQuery.trim();
  return /^(?:它们?|他们?|她们?)(?=的|是|呢|何时|什么时候|为什么|为何|怎么|如何|是否|能否|会|能|要|还|已经|之前|现在|[，,？?]|$)/u.test(query)
    || /^(?:这|那)(?:个(?:项目|方案|计划|任务|决定)?|件事)(?=的|是|呢|何时|什么时候|为什么|怎么|是否|能否|还|现在|之前|[，,？?]|$)/u.test(query)
    || /^(?:(?:what|when|where|why|how|who)\s+)?(?:(?:is|are|was|were|does|do|did|can|could|should|would)\s+)?(?:its|their)\b/iu.test(query)
    || /^(?:it|they)\s+(?:is|are|was|were|has|have|does|do|can|could|should|would)\b/iu.test(query)
    || /^(?:(?:what|when|where|why|how|who)\s+)?(?:is|are|was|were|does|do|did|can|could|should|would)\s+(?:it|they)\b/iu.test(query)
    || /^(?:this|that)\s+(?:project|plan|decision|task)\s+(?:is|was|has|does|can|should)\b/iu.test(query);
}

async function buildBoundedRecallQuery(
  currentQuery: string,
  recentConversation: readonly string[],
  maxTokens: number
): Promise<string> {
  const segments = [
    currentQuery,
    ...(needsPreviousUserContext(currentQuery) ? recentConversation.slice(-1) : [])
  ].map((value) => value.trim()).filter(Boolean);
  let result = "";
  for (const segment of segments) {
    const separator = result ? "\n" : "";
    const remainingChars = MAX_RECALL_QUERY_CHARS - result.length - separator.length;
    if (remainingChars <= 0) break;
    const prefix = `${result}${separator}`;
    const fitted = await fitSegment(prefix, segment.slice(0, remainingChars), maxTokens);
    if (!fitted) continue;
    result = `${prefix}${fitted}`;
    if (fitted.length < segment.length) break;
  }
  return result;
}

async function fitSegment(prefix: string, segment: string, maxTokens: number): Promise<string> {
  if (await estimateTokenValueAsync(`${prefix}${segment}`) <= maxTokens) return segment;
  let low = 0;
  let high = segment.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (await estimateTokenValueAsync(`${prefix}${segment.slice(0, middle)}`) <= maxTokens) {
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
