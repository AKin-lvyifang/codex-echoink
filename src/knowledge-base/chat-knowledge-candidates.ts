import { redactEchoInkLocalSecretsV1 } from "../security/local-secrets";
import { knowledgeRecallCandidateAllowed } from "./folder-organization";
import type { KnowledgeAgentIndex, KnowledgeAgentSearchHit } from "./knowledge-agent-index";
import { getKnowledgeFolderBindings } from "./root-paths";
import type { KnowledgeCandidateSearch, KnowledgeCandidateStopReason } from "./search/contracts";

export interface ChatKnowledgeCandidateNote {
  id: string;
  title: string;
  excerpt: string;
}

export interface ChatKnowledgeCandidate {
  /** The only fields intended for the knowledge-selection request. */
  note: ChatKnowledgeCandidateNote;
  /** Original search evidence, including its revision and navigation metadata. */
  hit: KnowledgeAgentSearchHit;
}

export interface CollectChatKnowledgeCandidatesInput {
  vaultPath: string;
  agentIndex: Pick<KnowledgeAgentIndex, "search" | "bodySearch">;
  question: string;
  signal?: AbortSignal;
  /** Defaults to 25 unique notes; capped at the server's 30-note limit. */
  maxCandidates?: number;
  /** Defaults to 250 inspected hits, including filtered and duplicate hits. */
  maxScannedHits?: number;
  /** Defaults to 50 pages for older ports; production uses one ranking. */
  maxPages?: number;
  /** Cooperative production body-search deadline; defaults to 600 ms.
   * Legacy maintenance-index initialization cannot be interrupted internally.
   */
  timeBudgetMs?: number;
}

export interface ChatKnowledgeCandidatesResult {
  candidates: ChatKnowledgeCandidate[];
  /** Hits actually inspected; an uninspected page tail is not counted. */
  scannedHits: number;
  pages: number;
  /** scan_budget also covers an unusable or repeated continuation cursor. */
  stopReason: KnowledgeCandidateStopReason;
}

/** Collect ordinary-chat candidates without reading or building references. */
export async function collectChatKnowledgeCandidates(
  input: CollectChatKnowledgeCandidatesInput
): Promise<ChatKnowledgeCandidatesResult> {
  const startedAt = performance.now();
  const maxCandidates = Math.min(30, countBudget(input.maxCandidates, 25));
  const maxScannedHits = countBudget(input.maxScannedHits, 250);
  const maxPages = countBudget(input.maxPages, 50);
  const timeBudgetMs = countBudget(input.timeBudgetMs, 600);
  const candidates: ChatKnowledgeCandidate[] = [];
  const paths = new Set<string>();
  const cursors = new Set<string>();
  let scannedHits = 0;
  let pages = 0;
  let cursor: string | undefined;
  const allowed = (relativePath: string) =>
    (!input.agentIndex.bodySearch || input.agentIndex.bodySearch.allowsPath(relativePath))
    && knowledgeRecallCandidateAllowed(getKnowledgeFolderBindings(input.vaultPath), relativePath);
  const pruneWithdrawn = () => {
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (allowed(candidates[index].hit.vaultRelativePath)) continue;
      paths.delete(candidates[index].hit.vaultRelativePath);
      candidates.splice(index, 1);
    }
    candidates.forEach((candidate, index) => { candidate.note.id = `n${index}`; });
  };
  const result = (stopReason: ChatKnowledgeCandidatesResult["stopReason"]): ChatKnowledgeCandidatesResult => {
    checkAbort(input.signal);
    pruneWithdrawn();
    return { candidates, scannedHits, pages, stopReason };
  };

  checkAbort(input.signal);
  const query = input.question.trim();
  if (!query) return result("exhausted");
  if (!maxCandidates) return result("candidate_limit");
  if (!maxScannedHits || !maxPages) return result("scan_budget");

  const controller = new AbortController();
  let deadlineExpired = false;
  const onUserAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onUserAbort, { once: true });
  const deadlineAt = startedAt + timeBudgetMs;
  const expire = () => { deadlineExpired = true; controller.abort(); };
  const timer = window.setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
  const timedOut = () => !input.signal?.aborted && (deadlineExpired || performance.now() >= deadlineAt);
  const check = () => {
    checkAbort(input.signal);
    if (timedOut()) expire();
    checkAbort(controller.signal);
  };
  const candidateSearch: KnowledgeCandidateSearch = { maxCandidates, maxScannedHits, allowsPath: allowed, check, timedOut };

  try {
  while (scannedHits < maxScannedHits && pages < maxPages) {
    check();
    // Omit kinds and workflow policies to preserve ordinary-chat search scope.
    const page = await input.agentIndex.search({
      query,
      limit: Math.min(50, maxScannedHits - scannedHits),
      signal: controller.signal,
      candidateSearch,
      ...(cursor ? { cursor } : {})
    });
    pages++;
    checkAbort(input.signal);
    // Production body search collects from one complete ranking. Older isolated
    // ports can ignore the internal flag and retain their paginated contract.
    if (page.candidateSearch) scannedHits += page.candidateSearch.scannedHits;
    if (!page.candidateSearch) check();
    // Folder consent can change while a later page is being searched.
    pruneWithdrawn();

    let inspected = 0;
    for (const hit of page.hits) {
      if (!page.candidateSearch && scannedHits >= maxScannedHits) break;
      if (page.candidateSearch) checkAbort(input.signal);
      else check();
      if (!page.candidateSearch) scannedHits++;
      inspected++;
      const relativePath = hit.vaultRelativePath;
      if (!allowed(relativePath)) continue;
      if (paths.has(relativePath)) continue;
      paths.add(relativePath);
      candidates.push({
        note: {
          id: `n${candidates.length}`,
          // Redact the complete field first: secrets can cross a clipping point.
          title: noteText(hit.title, 120),
          excerpt: noteText(hit.excerpt ?? "", 200)
        },
        hit
      });
      if (candidates.length >= maxCandidates) {
        if (!page.candidateSearch) return result("candidate_limit");
        break;
      }
    }

    if (page.candidateSearch) return result(timedOut() ? "time_budget" : page.candidateSearch.stopReason);
    if (inspected < page.hits.length) return result("scan_budget");
    if (!page.hasMore || page.exhausted) return result("exhausted");
    const nextCursor = page.continuationCursor;
    if (!nextCursor || cursors.has(nextCursor)) return result("scan_budget");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  return result("scan_budget");
  } catch (error) {
    checkAbort(input.signal);
    if (timedOut() && (error as { name?: string })?.name === "AbortError") return result("time_budget");
    throw error;
  } finally {
    window.clearTimeout(timer);
    input.signal?.removeEventListener("abort", onUserAbort);
  }
}

function countBudget(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

function noteText(value: string, limit: number): string {
  const clipped = redactEchoInkLocalSecretsV1(value).slice(0, limit);
  return /[\uD800-\uDBFF]$/u.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error("Chat Knowledge candidate collection aborted"), { name: "AbortError" });
}
