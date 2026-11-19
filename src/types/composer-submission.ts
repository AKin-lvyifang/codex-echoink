/** Display-only observations. They never accept a turn or change its execution. */
import type { EchoInkReasoningActivity } from "./reasoning-summary";
import { CAUSE, joinErrorCopy, pickErrorCopy, rawErrorText, userFacingErrorText, NEXT } from "../core/error-copy";

export const PREPARATION_ACTIVITY_IDS = { judgment: "preparation:judgment", knowledge: "knowledge:retrieval", memory: "memory:recall", thinking: "provider:thinking" } as const;
export const THINKING_NODE_ID = "process-activity:provider:thinking";
export type PreparationStage = "judgment" | "thinking" | "knowledge" | "memory";
export interface PreparationUpdate {
  stage: PreparationStage;
  startedAt?: number;
  updatedAt?: number;
  knowledgeDecision?: boolean;
  skillName?: string;
  memoriesUsed?: number;
  memorySources?: readonly { id: string; title: string; reason?: string; revision?: number }[];
  readyForModel?: boolean;
  /** A phase of the existing knowledge row, never a second preparation row. */
  detail?: "selecting_knowledge";
  status: "active" | "completed";
  /** Verified note paths actually included in this request, never chunk counts. */
  notePaths?: readonly string[];
}
export type PreparationObserver = (update: Readonly<PreparationUpdate>) => void;

/** The temporary submission and durable run describe the same semantic activities. */
export function preparationActivity(update: Readonly<PreparationUpdate>): EchoInkReasoningActivity | undefined {
  if (update.stage === "thinking") return;
  const count = update.memoriesUsed;
  return { id: PREPARATION_ACTIVITY_IDS[update.stage], kind: update.stage === "knowledge" ? "knowledge" : update.stage,
    status: update.status, startedAt: update.startedAt ?? 0, updatedAt: update.updatedAt ?? update.startedAt ?? 0,
    ...(update.stage === "knowledge" ? { stage: update.detail ?? "searching", notesRead: uniqueNotePaths(update.notePaths ?? []).length } : {}),
    ...(count !== undefined ? { current: count, total: count, completed: count } : {}),
    ...(update.knowledgeDecision !== undefined ? { knowledgeDecision: update.knowledgeDecision } : {}),
    ...(update.skillName ? { skillName: update.skillName } : {}) };
}

export function judgmentResultText(value: Readonly<{ knowledgeDecision?: boolean; skillName?: string }>, language: string): string {
  const en = language === "en";
  return [value.knowledgeDecision === undefined ? "" : value.knowledgeDecision ? en ? "Search knowledge" : "查知识库" : en ? "Skip knowledge search" : "不查知识库",
    value.skillName ? en ? `Use ${value.skillName}` : `用${value.skillName}` : ""].filter(Boolean).join(" · ") || (en ? "Use the usual flow" : "按常规处理");
}

export function reportPreparation(observer: PreparationObserver | undefined, update: PreparationUpdate): void {
  try { observer?.(update); } catch { /* A view cannot interrupt a conversation. */ }
}

export function uniqueNotePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(path => path.trim().replace(/\\/gu, "/")).filter(Boolean))];
}

export interface ComposerSubmission<T, D> {
  id: string;
  owner: string;
  snapshot: T;
  draft: D;
  cancelled: boolean;
  phase: "preparing" | "accepted" | "failed" | "review";
  stages: PreparationUpdate[];
  error?: string;
  userEntryId?: string;
  turnId?: string;
  queued?: boolean;
}

/** Plugin-owned memory only. Formal messages and the existing queue remain authoritative. */
export class ComposerSubmissions<T, D> {
  readonly records = new Map<string, ComposerSubmission<T, D>>();
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* Other views still refresh. */ } } }
  begin(id: string, owner: string, snapshot: T, draft: D): ComposerSubmission<T, D> {
    const record: ComposerSubmission<T, D> = { id, owner, snapshot, draft, cancelled: false, phase: "preparing", stages: [{ stage: "thinking", status: "active" }] };
    this.records.set(id, record); this.notify(); return record;
  }
  stage(id: string, update: Readonly<PreparationUpdate>): void {
    const record = this.records.get(id);
    if (!record || record.cancelled || record.phase !== "preparing") return;
    const previous = record.stages.findIndex(value => value.stage === update.stage);
    const at = update.updatedAt ?? Date.now();
    const stage = { ...update, startedAt: record.stages[previous]?.startedAt ?? update.startedAt ?? at, updatedAt: at,
      ...(update.notePaths ? { notePaths: uniqueNotePaths(update.notePaths) } : {}) };
    if (previous < 0) record.stages.push(stage); else record.stages[previous] = stage;
    this.notify();
  }
  accept(id: string, identity: { userEntryId?: string; turnId?: string }): void {
    const record = this.records.get(id); if (!record) return;
    record.phase = "accepted"; record.cancelled = false; delete record.error; Object.assign(record, identity); this.notify();
  }
  fail(id: string, error: string): void {
    const record = this.records.get(id);
    if (!record || record.phase === "accepted" || record.cancelled) return;
    record.phase = "failed"; record.error = error; this.notify();
  }
  /** True only when this submission owns a user-side failure bubble. */
  captureFailure(id: string, error: string): boolean {
    const record = this.records.get(id);
    if (!record || record.cancelled || record.queued || record.phase === "accepted" || record.phase === "review") return false;
    record.error = error; return true;
  }
  retry(id: string): ComposerSubmission<T, D> | undefined {
    const record = this.records.get(id);
    if (!record || record.phase !== "failed") return;
    if (record.cancelled) record.queued = false;
    record.phase = "preparing"; record.cancelled = false; record.stages = [{ stage: "thinking", status: "active" }]; delete record.error;
    this.notify(); return record;
  }
  remove(id: string): void { if (this.records.delete(id)) this.notify(); }
}

export function knowledgeResultText(count: number, language: string): string {
  if (count === 0) return language === "en" ? "No related notes found" : "没有找到相关笔记";
  return language === "en" ? `Read ${count} relevant note${count === 1 ? "" : "s"}` : `读了 ${count} 篇相关笔记`;
}

export function preparationText(update: Readonly<PreparationUpdate>, language: string): string {
  const en = language === "en";
  if (update.stage === "knowledge" && update.status === "completed") {
    const count = uniqueNotePaths(update.notePaths ?? []).length;
    return knowledgeResultText(count, language);
  }
  if (update.stage === "knowledge" && update.detail === "selecting_knowledge") return en ? "Selecting relevant notes…" : "挑选相关笔记…";
  return ({ judgment: en ? "Assessing your request…" : "智能判断中…", thinking: en ? "Thinking…" : "思考中…",
    knowledge: en ? "Searching knowledge…" : "检索知识库…", memory: en ? "Recalling relevant memories…" : "回忆相关记忆…" })[update.stage];
}

/** Failure under the pending message: the error's readable reason, else the send scene + next step. */
export function submissionFailureText(error: unknown, language = "zh"): string {
  const text = rawErrorText(error) || String(error), lang = language === "en" ? "en" : "zh";
  if (/401|403|unauthori[sz]ed|invalid.{0,20}(key|token)|api.?key.*invalid/iu.test(text)) return pickErrorCopy(CAUSE.providerAuth, lang);
  if (/contentPath|skill_binding_invalid/iu.test(text)) return pickErrorCopy(["所选技能暂时不可用。请重新选择后重试。", "The selected skill is unavailable. Choose it again and retry."], lang);
  const readable = /Pi user Entry|provider_execution/iu.test(text) ? "" : userFacingErrorText(error, "", lang);
  if (readable) return readable;
  if (/timeout|timed out|超时/iu.test(text)) return pickErrorCopy(CAUSE.providerTimeout, lang);
  if (/fetch failed|failed to fetch|network|econn|enotfound|断网|网络/iu.test(text)) return pickErrorCopy(CAUSE.providerNetwork, lang);
  return joinErrorCopy(["消息未能发送，内容已保留。", "The message could not be sent; your text has been kept."], NEXT.resendOrTest, lang);
}
