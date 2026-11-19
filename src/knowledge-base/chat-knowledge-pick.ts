import type { KnowledgeJudgment, KnowledgeJudgmentInput } from "../membership/decision-client";
import type { ChatKnowledgeCandidatesResult } from "./chat-knowledge-candidates";
import { KNOWLEDGE_NO_EVIDENCE_RESPONSE, KnowledgeRetrievalError, type KnowledgeReferenceBuilder } from "./query";
import type { KnowledgeReference, KnowledgeRetrievalResult } from "./types";

export interface ChatKnowledgePickClient {
  ready(turnId?: string): boolean;
  judgeKnowledge(input: KnowledgeJudgmentInput): Promise<KnowledgeJudgment | null>;
}

/** null means use the unchanged local six-chunk retriever. Abort always escapes. */
export async function pickChatKnowledge(input: {
  question: string;
  decisionTurnId: string;
  recent?: readonly string[];
  candidates: Promise<ChatKnowledgeCandidatesResult | null>;
  client: ChatKnowledgePickClient;
  referenceBuilder: Pick<KnowledgeReferenceBuilder, "buildReference">;
  allowsPath(path: string): boolean;
  signal?: AbortSignal;
  onStage?(): Promise<void>;
}): Promise<KnowledgeRetrievalResult | null> {
  const check = () => {
    if (input.signal?.aborted) throw Object.assign(new Error("Chat Knowledge pick aborted"), { name: "AbortError" });
  };
  check();
  if (!input.client.ready(input.decisionTurnId)) return null;
  let collected: ChatKnowledgeCandidatesResult | null;
  let cancel: (() => void) | undefined;
  try {
    collected = await Promise.race([input.candidates, new Promise<null>(resolve => {
      cancel = () => resolve(null);
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
    })]);
  } catch { check(); return null; }
  finally { if (cancel) input.signal?.removeEventListener("abort", cancel); }
  check();
  // Empty cold/deadline results do not mean that the user's library has no evidence.
  const candidates = collected?.candidates.filter(candidate => input.allowsPath(candidate.hit.vaultRelativePath)) ?? [];
  if (!candidates.length || !input.client.ready(input.decisionTurnId)) return null;
  await input.onStage?.();
  check();
  let judgment: KnowledgeJudgment | null;
  try {
    judgment = await input.client.judgeKnowledge({ turnId: input.decisionTurnId, text: input.question,
      recent: input.recent, notes: candidates.map(candidate => candidate.note), signal: input.signal });
  } catch { check(); return null; }
  check();
  if (!judgment) return null;
  const selected = candidates.filter(candidate => judgment.probabilities[candidate.note.id] >= judgment.threshold)
    .sort((a, b) => judgment.probabilities[b.note.id] - judgment.probabilities[a.note.id]).slice(0, 10);
  const references: KnowledgeReference[] = [];
  for (const { hit } of selected) {
    check();
    if (!input.allowsPath(hit.vaultRelativePath)) continue;
    try {
      references.push(await input.referenceBuilder.buildReference({
        vaultRelativePath: hit.vaultRelativePath, question: input.question,
        lineStart: hit.lineStart, lineEnd: hit.lineEnd, columnStart: hit.columnStart, columnEnd: hit.columnEnd,
        excerpt: hit.excerpt, sectionTitle: hit.sectionTitle, matchSources: hit.matchSources,
        inclusionReason: hit.inclusionReason, outline: hit.outline, related: hit.related, linkCues: hit.linkCues,
        allowUnrefined: hit.kind === "raw", expectedContentRevision: hit.contentRevision, signal: input.signal
      }));
    } catch (error) {
      check();
      if (!(error instanceof KnowledgeRetrievalError)
        || !["not-found", "source-changed", "not-markdown", "invalid-utf8", "read-failed", "forbidden-path"].includes(error.code)) throw error;
    }
  }
  check();
  const delivered = references.filter(reference => input.allowsPath(reference.vaultRelativePath));
  const page = { total: candidates.length, remaining: 0, hasMore: false, exhausted: true };
  return delivered.length
    ? { ...page, status: "ready", shouldInvokePi: true, references: delivered, returned: delivered.length }
    : { ...page, status: "no_evidence", shouldInvokePi: true, references: [], returned: 0, fixedResponse: KNOWLEDGE_NO_EVIDENCE_RESPONSE };
}
