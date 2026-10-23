import type { KnowledgeMaintenanceRecord } from "./maintenance-record";
import type { KnowledgeLinkingTask } from "./knowledge-linking-types";
import { maintenanceFailureText } from "./maintenance-user-copy";

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
  taskKind?: "upgrade";
  upgradeCounts?: Readonly<import("./maintenance-upgrade-contract").MaintenanceUpgradeActivityCounts>;
  id: string;
  originConversationId: string;
  status: MaintenanceActivityStatus;
  stage: MaintenanceActivityStage;
  steps: readonly MaintenanceActivityStep[];
  sourceCount: number | null;
  sourcePaths: readonly string[];
  pageCounts?: Readonly<MaintenancePageCounts>;
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
  if (record.upgrade && record.originConversationId) {
    const upgrade = record.upgrade, progress = record.progress;
    const writes = Object.values(upgrade.writes), done = writes.filter(write => write.done);
    const sourceDone = done.filter(write => write.role === "source");
    const counts = { sourceTotal: upgrade.plan.counts.sourceStatusCount, sourceCompleted: sourceDone.filter(write => upgrade.plan.sourceItems.find(item => item.path === write.path)?.addStatus !== undefined).length,
      linkTotal: upgrade.plan.counts.backlinkCount, linksCompleted: sourceDone.reduce((sum, write) => sum + (upgrade.plan.sourceItems.find(item => item.path === write.path)?.addTargetPaths?.length ?? 0), 0),
      wikiTotal: upgrade.plan.wikiItems.length, wikiCompleted: done.filter(write => write.role === "wiki").length };
    const completed = upgrade.phase === "completed", stage = progress?.stage ?? "scan", index = MAINTENANCE_ACTIVITY_STAGES.indexOf(stage);
    return { kind: "maintenance", taskKind: "upgrade", id: record.recordId, originConversationId: record.originConversationId,
      sourceCount: upgrade.plan.counts.sourceCount, sourcePaths: upgrade.plan.sourceItems.map(item => item.path), upgradeCounts: counts,
      batch: { index: 1, total: 1 }, stage, status: completed ? "completed" : progress?.status ?? "interrupted",
      steps: MAINTENANCE_ACTIVITY_STAGES.map((step, i) => ({ stage: step,
        completed: step === "decompose" ? Object.keys(upgrade.classifications).length : step === "write" ? done.length : completed || i < index ? 1 : 0,
        total: step === "decompose" ? counts.wikiTotal : step === "write" ? upgrade.plan.sourceItems.length + counts.wikiTotal : 1,
        state: completed || i < index ? "completed" : i === index ? "running" : "pending" })),
      activeElapsedMs: Object.values(progress?.elapsedMs ?? {}).reduce((sum, value) => sum + value, 0), etaMs: null,
      failures: progress?.failures ?? [], updatedAt: progress?.updatedAt ?? record.at, currentPath: progress?.currentPath,
      ...(progress?.completedAt ? { completedAt: progress.completedAt } : {}) };
  }
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
    sourceCount: record.sources.length, sourcePaths: record.sources.map(source => source.path), pageCounts: maintenancePageCounts(record), batch: progress?.batch ?? { index: 1, total: 1 }, ...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
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
export function maintenanceStageLabel(stage: MaintenanceActivityStage, english = false, taskKind?: "upgrade"): string {
  if (taskKind === "upgrade") return (english ? { scan: "Scanning", decompose: "Choosing types", plan: "Checking changes", write: "Adding properties and links", finalize: "Final checks" }
    : { scan: "扫描", decompose: "判断类型", plan: "核对变更", write: "补属性和链接", finalize: "收尾" })[stage];
  return (english ? { scan: "Scanning", decompose: "Extracting knowledge", plan: "Comparing knowledge", write: "Writing Wiki", finalize: "Finalizing" }
    : { scan: "扫描", decompose: "拆知识点", plan: "汇总查重", write: "写Wiki", finalize: "收尾" })[stage];
}
export interface MaintenancePageCounts { written: number; created: number; updated: number }
export interface MaintenanceUserReceipt { version: 1; text: string; sourceCount?: number; pageCounts?: Readonly<MaintenancePageCounts> }
export function maintenancePageCounts(record: Readonly<KnowledgeMaintenanceRecord>): MaintenancePageCounts {
  const pages = new Map<string, "missing" | "file">();
  for (const item of record.p1?.writingPlan ?? []) if (record.p1?.committedPages[item.id]) pages.set(item.targetPath, item.expectedTarget.kind);
  return { written: pages.size, created: [...pages.values()].filter(kind => kind === "missing").length, updated: [...pages.values()].filter(kind => kind === "file").length };
}
export function maintenanceTaskStatus(activity: Pick<MaintenanceActivity, "status">): "running" | "waiting" | "interrupted" | "completed" {
  return activity.status === "completed" ? "completed" : activity.status === "waiting" ? "waiting" : activity.status === "running" ? "running" : "interrupted";
}
export function maintenanceTaskStateLabel(activity: Pick<MaintenanceActivity, "status">, english = false): string {
  return (english ? { running: "In progress", waiting: "Waiting for you", interrupted: "Not finished", completed: "Completed" }
    : { running: "进行中", waiting: "等你回应", interrupted: "没做完", completed: "已完成" })[maintenanceTaskStatus(activity)];
}
export function maintenanceTaskTitle(activity: Pick<MaintenanceActivity, "sourceCount" | "taskKind">, english = false): string {
  if (activity.taskKind === "upgrade") return english ? "Upgrade existing knowledge" : "升级旧知识";
  if (activity.sourceCount === null) return english ? "Organize knowledge" : "整理知识库";
  return english ? `Organize knowledge (${activity.sourceCount} sources)` : `整理知识库（${activity.sourceCount} 篇资料）`;
}
export function maintenanceCompletionText(activity: Pick<MaintenanceActivity, "sourceCount" | "pageCounts"> & Partial<Pick<MaintenanceActivity, "upgradeCounts">>, english = false): string {
  if (activity.upgradeCounts) {
    const counts = activity.upgradeCounts;
    return english ? `Added status for ${counts.sourceCompleted} sources, added ${counts.linksCompleted} links and types for ${counts.wikiCompleted} Wiki pages`
      : `已补好 ${counts.sourceCompleted} 篇资料状态、${counts.linksCompleted} 条链接，为 ${counts.wikiCompleted} 页 Wiki 补好类型`;
  }
  const { sourceCount, pageCounts } = activity;
  if (sourceCount === null || !pageCounts) return english ? "Organizing completed." : "这次整理已完成。";
  return english ? `Organized ${sourceCount} sources and produced ${pageCounts.written} Wiki pages (${pageCounts.created} new, ${pageCounts.updated} updated)`
    : `整理完 ${sourceCount} 篇资料，生成 ${pageCounts.written} 页 Wiki（新建 ${pageCounts.created} 页，更新 ${pageCounts.updated} 页）`;
}
export function maintenanceStepText(step: Readonly<MaintenanceActivityStep>, english = false, taskKind?: "upgrade"): string {
  if (taskKind === "upgrade") {
    if (step.stage === "finalize") return english ? "Checking upgraded properties" : "正在核对升级结果";
    if (step.total === null || !["decompose", "write"].includes(step.stage)) return maintenanceStageLabel(step.stage, english, taskKind);
    const remaining = Math.max(0, step.total - step.completed);
    return english ? `${step.completed} ${step.stage === "decompose" ? "pages classified" : "items updated"}, ${remaining} left (${step.total} total)`
      : `${step.stage === "decompose" ? "已判断" : "已补好"} ${step.completed} ${step.stage === "decompose" ? "页" : "项"}，还剩 ${remaining} ${step.stage === "decompose" ? "页" : "项"}（共 ${step.total} ${step.stage === "decompose" ? "页" : "项"}）`;
  }
  if (step.stage === "finalize") return english ? "Adding links and domain maps" : "正在补链接和领域地图";
  const label = maintenanceStageLabel(step.stage, english);
  if (step.total === null || !["decompose", "write"].includes(step.stage)) return label;
  const remaining = Math.max(0, step.total - step.completed), unit = step.stage === "decompose" ? "篇" : "页";
  return english ? `${step.stage === "decompose" ? "Read" : "Written"} ${step.completed} ${step.stage === "decompose" ? "sources" : "pages"}, ${remaining} left (${step.total} total)`
    : `${step.stage === "decompose" ? "已读完" : "已写好"} ${step.completed} ${unit}，还剩 ${remaining} ${unit}（共 ${step.total} ${unit}）`;
}
export function maintenanceReceiptForRecord(record: Readonly<KnowledgeMaintenanceRecord>): MaintenanceUserReceipt {
  const state = record.p1!, pageCounts = maintenancePageCounts(record), sourceCount = new Set(record.sources.map(source => source.path)).size;
  const text = state.phase === "completed" ? maintenanceCompletionText({ sourceCount, pageCounts })
    : state.phase === "decompose" ? maintenanceStepText({ stage: "decompose", completed: new Set(state.decompositions.map(d => d.sourcePath)).size, total: sourceCount, state: "running" })
    : state.phase === "write" ? maintenanceStepText({ stage: "write", completed: pageCounts.written, total: new Set(state.writingPlan.map(item => item.targetPath)).size, state: "running" })
    : state.phase === "finalize" ? "正在补链接和领域地图" : "正在汇总知识，核对已有内容。";
  return { version: 1, text, sourceCount, pageCounts };
}
export function maintenanceActivityText(activity: Readonly<MaintenanceActivity>, english = false): string {
  if (activity.status === "completed") return maintenanceCompletionText(activity, english);
  const status = maintenanceTaskStateLabel(activity, english), step = activity.steps.find(step => step.stage === activity.stage);
  const progress = step ? maintenanceStepText(step, english, activity.taskKind) : maintenanceStageLabel(activity.stage, english, activity.taskKind);
  const eta = activity.status === "running" && activity.etaMs !== null ? (english ? ` · about ${Math.max(1, Math.ceil(activity.etaMs / 60_000))} min left` : ` · 约剩${Math.max(1, Math.ceil(activity.etaMs / 60_000))}分钟`) : "";
  const reason = maintenanceTaskStatus(activity) === "interrupted" ? ` · ${activity.failures[0] ? activity.taskKind === "upgrade" ? activity.failures[0].message : maintenanceFailureText(activity.failures[0].message, activity.currentPath, english) : english ? "Stopped; saved work is preserved." : "这次整理已停下，已写好的内容会保留。"}` : "";
  const stepNumber = MAINTENANCE_ACTIVITY_STAGES.indexOf(activity.stage) + 1;
  const batch = activity.batch.total > 1 ? english ? `Batch ${activity.batch.index}/${activity.batch.total} · ` : `第 ${activity.batch.index} 批（共 ${activity.batch.total} 批）· ` : "";
  const position = batch + (english ? `Step ${stepNumber}/5` : `第 ${stepNumber} 步（共 5 步）`);
  const stage = maintenanceStageLabel(activity.stage, english, activity.taskKind);
  return `${position} · ${status} · ${stage}${progress === stage ? "" : ` · ${progress}`}${eta}${reason}`;
}
export function maintenanceStatusBarText(activity: Readonly<MaintenanceActivity>, english = false): string {
  if (activity.taskKind === "upgrade") return `EchoInk ${maintenanceTaskTitle(activity, english)}：${maintenanceTaskStateLabel(activity, english)} · ${maintenanceStageLabel(activity.stage, english, "upgrade")}`;
  const step = activity.steps.find(step => step.stage === activity.stage);
  const count = step?.total !== null && step?.total !== undefined && ["decompose", "write"].includes(activity.stage)
    ? ` ${step.completed}/${step.total}${english ? activity.stage === "decompose" ? " sources" : " pages" : activity.stage === "decompose" ? " 篇" : " 页"}` : "";
  const stage = activity.stage === "finalize" ? english ? "Adding links and maps" : "补链接和领域地图" : maintenanceStageLabel(activity.stage, english);
  return `EchoInk ${english ? "Organize knowledge" : "整理知识"}：${maintenanceTaskStateLabel(activity, english)} · ${stage}${count}`;
}
