import type { KnowledgeMaintenanceRecord } from "./maintenance-record";
import type { KnowledgeLinkingTask } from "./knowledge-linking-types";

export const MAINTENANCE_ACTIVITY_STAGES = ["scan", "decompose", "plan", "write", "finalize"] as const;
export type MaintenanceActivityStage = typeof MAINTENANCE_ACTIVITY_STAGES[number];
export type MaintenanceActivityStatus = "running" | "waiting" | "interrupted" | "partial" | "failed" | "completed";
/** Stored only in the existing maintenance record (or the first ProductRun until bound). */
export interface MaintenanceActivityProgress {
  version: 1;
  stage: MaintenanceActivityStage;
  status: MaintenanceActivityStatus;
  elapsedMs: Partial<Record<MaintenanceActivityStage, number>>;
  waitingReasons: string[];
  updatedAt: number;
  currentPath?: string;
  completedAt?: number;
  failures: { key: string; message: string; at: number }[];
  notified: string[];
  batch?: { index: number; total: number };
}
export interface MaintenanceInitialActivity {
  version: 1;
  sourcePaths: string[];
  progress: MaintenanceActivityProgress;
  recordId?: string;
}
export interface MaintenanceActivityStep {
  stage: MaintenanceActivityStage;
  completed: number;
  total: number | null;
  state: "pending" | "running" | "completed";
}
export interface MaintenanceActivity {
  kind: "maintenance";
  id: string;
  originConversationId: string;
  status: MaintenanceActivityStatus;
  stage: MaintenanceActivityStage;
  steps: readonly MaintenanceActivityStep[];
  sourceCount: number | null;
  sourcePaths: readonly string[];
  batch: { index: number; total: number };
  currentPath?: string;
  activeElapsedMs: number;
  etaMs: number | null;
  failures: readonly { key: string; message: string; at: number }[];
  updatedAt: number;
  completedAt?: number;
}
export interface LinkingActivity {
  kind: "linking";
  id: string;
  originConversationId?: string;
  status: MaintenanceActivityStatus;
  task: Readonly<KnowledgeLinkingTask>;
  updatedAt: number;
}
export type KnowledgeActivity = MaintenanceActivity | LinkingActivity;
export interface KnowledgeActivitySnapshot {
  primary: Readonly<KnowledgeActivity> | null;
  other: Readonly<KnowledgeActivity> | null;
  maintenance: readonly Readonly<MaintenanceActivity>[];
}
export interface KnowledgeActivitySource {
  readonly ready: Promise<void>;
  snapshot(): Readonly<KnowledgeActivitySnapshot>;
  subscribe(listener: (snapshot: Readonly<KnowledgeActivitySnapshot>) => void): () => void;
}
export interface MaintenanceActivityLifecycle {
  type: "start" | "waiting" | "stop" | "settled" | "stage";
  conversationId: string;
  productRunId: string;
  sourcePaths?: readonly string[];
  reason?: string;
  waiting?: boolean;
  failed?: boolean;
  stage?: MaintenanceActivityStage;
  currentPath?: string;
  request?: string;
}

export function newMaintenanceProgress(now: number, stage: MaintenanceActivityStage = "scan"): MaintenanceActivityProgress {
  return { version: 1, stage, status: "running", elapsedMs: {}, waitingReasons: [], updatedAt: now, failures: [], notified: [] };
}
export function maintenanceRecordStage(record: Readonly<KnowledgeMaintenanceRecord>): MaintenanceActivityStage {
  return record.p1?.phase === "completed" ? "finalize" : record.p1?.phase ?? "scan";
}
export function projectMaintenanceActivity(record: Readonly<KnowledgeMaintenanceRecord>): MaintenanceActivity | null {
  if (!record.p1 || !record.originConversationId) return null;
  const state = record.p1, progress = record.progress;
  const stage = progress?.stage ?? maintenanceRecordStage(record);
  const completed = state.phase === "completed";
  // Historical start timestamps cannot stand in for actual completion time.
  if (completed && progress?.completedAt === undefined) return null;
  const index = MAINTENANCE_ACTIVITY_STAGES.indexOf(stage);
  const finalized = new Set([...state.finalizedSources, ...Object.keys(state.p2?.committedFinalization ?? {})]).size;
  const pageTotal = ["write", "finalize", "completed"].includes(state.phase) ? new Set(state.writingPlan.map(p => p.targetPath)).size : null;
  const steps = MAINTENANCE_ACTIVITY_STAGES.map((step, i): MaintenanceActivityStep => ({
    stage: step,
    completed: step === "decompose" ? new Set(state.decompositions.map(d => d.sourcePath)).size
      : step === "write" ? new Set(Object.values(state.committedPages).map(p => p.path)).size
      : step === "finalize" ? finalized : step === "plan" ? (state.phase === "decompose" || state.phase === "plan" ? 0 : 1) : 0,
    total: step === "decompose" ? record.sources.length : step === "write" ? pageTotal
      : step === "finalize" ? (pageTotal === null ? null : record.sources.length + (state.p2?.finalization.length ?? 0))
      : null,
    state: completed || i < index ? "completed" : i === index ? "running" : "pending"
  }));
  const status = completed ? "completed" : progress?.status ?? "interrupted";
  const current = steps[index];
  const elapsed = progress?.elapsedMs[stage] ?? 0;
  const etaMs = status === "running" && current.completed >= 2 && current.total !== null && current.total > current.completed && elapsed > 0
    ? Math.round(elapsed / current.completed * (current.total - current.completed)) : null;
  return { kind: "maintenance", id: record.recordId, originConversationId: record.originConversationId, stage, status, steps,
    sourceCount: record.sources.length, sourcePaths: record.sources.map(source => source.path), batch: progress?.batch ?? { index: 1, total: 1 }, ...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
    activeElapsedMs: Object.values(progress?.elapsedMs ?? {}).reduce((sum, value) => sum + value, 0), etaMs,
    failures: progress?.failures ?? [], updatedAt: progress?.updatedAt ?? record.at,
    ...(progress?.completedAt ? { completedAt: progress.completedAt } : {}) };
}

/** The initializer's existing frozen-batch prompt carries this display context. Never increment on resume. */
export function maintenanceBatchContext(request: string): { index: number; total: number } {
  const match = /^(?:\/maintain\s+)?用户已确认(?:从工作台整理资料|知识库初始化)，本批\s+(\d+)\/(\d+)。/u.exec(request.trim());
  const index = Number(match?.[1]), total = Number(match?.[2]);
  return index > 0 && total >= index ? { index, total } : { index: 1, total: 1 };
}

export function projectMaintenanceInitialActivity(initial: Readonly<MaintenanceInitialActivity>, conversationId: string, productRunId: string): MaintenanceActivity {
  const progress = initial.progress;
  return { kind: "maintenance", id: `run:${productRunId}`, originConversationId: conversationId, status: progress.status,
    stage: progress.stage, steps: MAINTENANCE_ACTIVITY_STAGES.map(stage => ({ stage, completed: 0, total: stage === "decompose" && initial.sourcePaths.length ? initial.sourcePaths.length : null, state: stage === progress.stage ? "running" : "pending" })),
    sourceCount: initial.sourcePaths.length || null, sourcePaths: [...initial.sourcePaths], batch: progress.batch ?? { index: 1, total: 1 }, currentPath: progress.currentPath,
    activeElapsedMs: Object.values(progress.elapsedMs).reduce((sum, n) => sum + n, 0), etaMs: null, failures: progress.failures, updatedAt: progress.updatedAt };
}

export function parseMaintenanceInitialActivity(value: unknown): MaintenanceInitialActivity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid maintenance activity");
  const initial = value as MaintenanceInitialActivity, progress = initial.progress;
  if (Object.keys(initial).some(key => !["version", "sourcePaths", "progress", "recordId"].includes(key)) || initial.version !== 1
    || !Array.isArray(initial.sourcePaths) || initial.sourcePaths.some(path => typeof path !== "string")
    || (initial.recordId !== undefined && typeof initial.recordId !== "string") || !progress || progress.version !== 1
    || !MAINTENANCE_ACTIVITY_STAGES.includes(progress.stage) || !["running", "waiting", "interrupted", "partial", "failed", "completed"].includes(progress.status)
    || !Number.isFinite(progress.updatedAt) || !Array.isArray(progress.waitingReasons) || progress.waitingReasons.some(reason => typeof reason !== "string")
    || !progress.elapsedMs || Object.entries(progress.elapsedMs).some(([key, elapsed]) => !MAINTENANCE_ACTIVITY_STAGES.includes(key as MaintenanceActivityStage) || !Number.isFinite(elapsed) || elapsed < 0)
    || !Array.isArray(progress.failures) || progress.failures.some(item => typeof item?.key !== "string" || typeof item.message !== "string" || !Number.isFinite(item.at))
    || !Array.isArray(progress.notified) || progress.notified.some(key => typeof key !== "string")
    || progress.currentPath !== undefined && typeof progress.currentPath !== "string"
    || progress.completedAt !== undefined && !Number.isFinite(progress.completedAt)
    || progress.batch !== undefined && (!Number.isInteger(progress.batch.index) || !Number.isInteger(progress.batch.total) || progress.batch.index < 1 || progress.batch.total < progress.batch.index)
    || Object.keys(progress).some(key => !["version", "stage", "status", "elapsedMs", "waitingReasons", "updatedAt", "currentPath", "completedAt", "failures", "notified", "batch"].includes(key))) throw new Error("Invalid maintenance activity");
  return structuredClone(initial);
}
export function maintenanceStageLabel(stage: MaintenanceActivityStage, english = false): string {
  return (english ? { scan: "Scanning", decompose: "Extracting knowledge", plan: "Comparing knowledge", write: "Writing Wiki", finalize: "Finalizing" }
    : { scan: "扫描", decompose: "拆知识点", plan: "汇总查重", write: "写Wiki", finalize: "收尾" })[stage];
}
export function maintenanceActivityText(activity: Readonly<MaintenanceActivity>, english = false): string {
  const status = activity.status === "waiting" ? (english ? "Waiting for you" : "等你确认")
    : activity.status === "interrupted" ? (english ? "Ready to resume" : "可继续")
    : activity.status === "failed" ? (english ? "Failed · Ready to resume" : "维护失败 · 可继续")
    : activity.status === "partial" ? (english ? "Partially completed · Ready to resume" : "部分完成 · 可继续")
    : activity.status === "completed" ? (english ? "Completed" : "已完成") : maintenanceStageLabel(activity.stage, english);
  const step = activity.steps.find(s => s.stage === activity.stage);
  const count = step?.total !== null && step?.total !== undefined ? ` ${step.completed} / ${step.total}` : "";
  const eta = activity.status === "running" && activity.etaMs !== null ? (english ? ` · about ${Math.max(1, Math.ceil(activity.etaMs / 60_000))} min left` : ` · 约剩${Math.max(1, Math.ceil(activity.etaMs / 60_000))}分钟`) : "";
  const stepNumber = MAINTENANCE_ACTIVITY_STAGES.indexOf(activity.stage) + 1;
  const detail = activity.status === "waiting" ? `${maintenanceStageLabel(activity.stage, english)}${count} · ${status}` : `${status}${count}`;
  return `${english ? `Batch ${activity.batch.index}/${activity.batch.total} · Step ${stepNumber}/5` : `第${activity.batch.index}/${activity.batch.total}批 · 第${stepNumber}/5步`} · ${detail}${eta}`;
}

export function maintenanceStatusBarText(activity: Readonly<MaintenanceActivity>, english = false): string {
  if (activity.status === "waiting") return english ? "EchoInk Waiting for you" : "EchoInk 等你确认";
  const label = activity.status === "running" ? (english ? "Organizing knowledge" : "整理知识")
    : activity.status === "partial" ? (english ? "Partially completed" : "部分完成")
    : activity.status === "failed" ? (english ? "Maintenance failed" : "维护失败")
    : activity.status === "completed" ? (english ? "Completed" : "整理完成") : (english ? "Ready to resume" : "可继续");
  const step = activity.steps.find(step => step.stage === activity.stage);
  return `EchoInk ${label}${step?.total !== null && step?.total !== undefined ? ` ${step.completed}/${step.total}` : ""}`;
}
