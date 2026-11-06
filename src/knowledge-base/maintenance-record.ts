import type { KnowledgeMaintenanceResultEnvelope } from "./knowledge-maintenance-result";

export interface KnowledgeMaintenanceRecord {
  schemaVersion: 1;
  /** An approved legacy upgrade shares this record and its durable progress. */
  upgrade?: import("./maintenance-upgrade-contract").MaintenanceUpgradeState;
  /** Durable P1 writing list and unfinished source finalization, in the existing record. */
  p1?: import("./maintenance-p1-contract").MaintenanceP1State;
  progress?: import("./maintenance-activity").MaintenanceActivityProgress;
  cancelled?: boolean;
  recordId: string;
  runId: string;
  /** Exact source Conversation from the maintenance/WAL contract, never parsed from runId. */
  originConversationId?: string;
  at: number;
  date: string;
  result: KnowledgeMaintenanceResultEnvelope;
  sources: { path: string; fingerprint: string; status: "processed" | "unread" | "failed"; evidencePaths: string[] }[];
  summary: string;
  /** Only new maintenance WALs that explicitly delegated linking can carry this intent. */
  pendingLinking?: { taskId: string; sourcePaths: string[]; targetPaths: string[] };
}

export function latestMaintenanceSourceStates(records: readonly Readonly<KnowledgeMaintenanceRecord>[]): ReadonlyMap<string, KnowledgeMaintenanceRecord["sources"][number]> {
  const latest = new Map<string, KnowledgeMaintenanceRecord["sources"][number]>();
  for (const record of [...records].sort((left, right) => right.at - left.at)) {
    for (const source of record.sources) if (!latest.has(source.path)) latest.set(source.path, source);
  }
  return latest;
}

export const SOURCE_FRONTMATTER_UNSAFE = "source_frontmatter_unsafe";

/** Never trust an optional marker without its matching durable checkpoints. */
export function hasP1PartialSettlement(record: Readonly<KnowledgeMaintenanceRecord>): boolean {
  const state = record.p1;
  if (!state || state.settlement?.version !== 1 || state.settlement.status !== "partial"
    || state.phase !== "finalize" || record.result.status !== "partial"
    || record.result.issues.some(issue => issue.code === "p1_pending")) return false;
  const failures = state.sourceFrontmatterFailures;
  if (!failures || !Object.keys(failures).length || !record.sources.length) return false;
  if (!state.writingPlan.every(item => state.committedPages[item.id]?.path === item.targetPath)
    || state.p2 && !state.p2.finalization.every(item => state.p2!.committedFinalization[item.id]?.path === item.targetPath)) return false;
  if (Object.keys(failures).some(path => !record.sources.some(source => source.path === path))) return false;
  return record.sources.every(source => state.decompositions.some(item => item.sourcePath === source.path)
    && (state.finalizedSources.includes(source.path)
      ? source.status === "processed" && !failures[source.path]
      : source.status === "failed" && /^sha256:[a-f0-9]{64}$/u.test(failures[source.path]?.contentRevision ?? "")
        && record.result.issues.some(issue => issue.code === SOURCE_FRONTMATTER_UNSAFE && issue.path === source.path)));
}

/** Legacy completed records settle; legacy unfinished records remain recoverable. */
export function isP1Open(record: Readonly<KnowledgeMaintenanceRecord>): boolean {
  return !!record.p1 && record.p1.phase !== "completed" && !hasP1PartialSettlement(record);
}

/** A retry belongs to one original record; mixed selections never create duplicate work. */
export function maintenanceP1RetryRecord(records: readonly KnowledgeMaintenanceRecord[], conversationId: string, selected: readonly string[]): KnowledgeMaintenanceRecord | undefined {
  const latest = new Map<string, KnowledgeMaintenanceRecord>();
  for (const record of [...records].sort((a, b) => b.at - a.at)) for (const source of record.sources) if (!latest.has(source.path)) latest.set(source.path, record);
  const retry = new Map<string, KnowledgeMaintenanceRecord>();
  for (const path of selected) {
    const record = latest.get(path);
    if (record && hasP1PartialSettlement(record) && record.p1!.sourceFrontmatterFailures?.[path]) retry.set(record.recordId, record);
  }
  if (!retry.size) return undefined;
  if (retry.size > 1) throw new Error("这些资料来自不同整理任务，请分别回到原任务重试属性回写。");
  const record = [...retry.values()][0];
  if (record.originConversationId !== conversationId) throw new Error("这些资料已有整理记录，请回到原整理任务重试属性回写，不会重新提炼。");
  if (selected.some(path => !record.sources.some(source => source.path === path))) throw new Error("请先单独重试原任务中属性回写失败的资料，再整理新资料；原整理进度会保留。");
  return record;
}
