import { rawDigestRecordFromMarkdown, type RawDigestRegistryEntry } from "./raw-digest";
import { rawDigestStateForRecord } from "./digest-status";
import type { KnowledgeBaseRawDigestState } from "./types";
import { isMaintenanceSourceTargetPath, readMaintenanceSourceStateProperty } from "./maintenance-source-frontmatter";
import type { MaintenanceMigrationEvidence, MaintenanceSourceMigrationPlan } from "./maintenance-p1-contract";

export interface MaintenanceSourceLegacyEvidence {
  /** Lazy: only legacy notes without the new property require a body version. */
  fingerprint?: () => string;
  registry?: RawDigestRegistryEntry;
  maintenance?: Readonly<{ fingerprint: string; status: "processed" | "unread" | "failed" }>;
  previous?: Readonly<{ fingerprint?: string }>;
  hasTrackerHint?: boolean;
}

export interface MaintenanceSourceResolution { state: KnowledgeBaseRawDigestState; reason: string; origin: "new" | "private" | "registry" | "legacy" | "none" }

/** Shared transition rule for maintenance, workbench and dashboard; never writes old notes. */
export function resolveMaintenanceSourceState(markdown: string, evidence: MaintenanceSourceLegacyEvidence = {}): MaintenanceSourceResolution {
  const current = readMaintenanceSourceStateProperty(markdown);
  if (current.present) {
    const state = current.value === "已提炼" ? "digested" : current.value === "提炼失败" ? "failed" : current.value === "待重新提炼" ? "changed" : "pending";
    return { state, origin: "new", reason: current.error ?? (state === "digested" ? "采用当前提炼状态" : "当前提炼状态尚未完成，不采用旧完成记录") };
  }
  const frontmatter = rawDigestRecordFromMarkdown(Buffer.from(markdown));
  if (!evidence.maintenance && !evidence.registry && !evidence.previous && !frontmatter?.processed && !frontmatter?.fingerprint && !evidence.hasTrackerHint) return { state: "pending", origin: "none", reason: "没有当前状态或旧完成证据" };
  const fingerprint = evidence.fingerprint?.() ?? "";
  if (!fingerprint) return { state: "pending", origin: "legacy", reason: "旧证据缺少可核对的当前正文版本" };
  // Latest private receipt wins over registry/settings. A stale, failed or unread
  // receipt must not be overruled by conflicting older completion evidence.
  if (evidence.maintenance) {
    if (evidence.maintenance.fingerprint !== fingerprint) return { state: evidence.maintenance.fingerprint ? "changed" : "pending", origin: "private", reason: "最新私有记录不对应当前正文，旧完成证据不予采用" };
    return { state: evidence.maintenance.status === "processed" ? "digested" : evidence.maintenance.status === "failed" ? "failed" : "pending", origin: "private", reason: "采用当前正文版本的最新私有维护记录，优先于registry和旧设置" };
  }
  if (evidence.registry) return { state: evidence.registry.fingerprint === fingerprint ? "digested" : "changed", origin: "registry", reason: evidence.registry.fingerprint === fingerprint ? "旧registry完成记录与当前正文版本一致" : "旧registry记录的正文版本已经过期" };
  return { state: rawDigestStateForRecord({ fingerprint, frontmatter, previous: evidence.previous, hasTrackerHint: evidence.hasTrackerHint ?? false }), origin: "legacy", reason: "按旧文件头或设置的完成证据核对当前正文版本" };
}

export function maintenanceSourceState(markdown: string, evidence: MaintenanceSourceLegacyEvidence = {}): KnowledgeBaseRawDigestState {
  return resolveMaintenanceSourceState(markdown, evidence).state;
}
export function isMaintenanceSourceProcessed(markdown: string, evidence: MaintenanceSourceLegacyEvidence = {}): boolean {
  return maintenanceSourceState(markdown, evidence) === "digested";
}

function legacyProcessedSignal(value: unknown): boolean | undefined {
  if (value === true || value === "已处理" || value === "processed") return true;
  return value === false ? false : undefined;
}

/** Pure migration preview: callers decide whether and when an existing note changes. */
export function planMaintenanceSourceMigration(evidence: MaintenanceMigrationEvidence): MaintenanceSourceMigrationPlan {
  const current = evidence.status;
  const hasCurrent = current !== undefined;
  const validCurrent = current === "已提炼" || current === "未提炼";
  const signals = [legacyProcessedSignal(evidence.legacyProcessed), evidence.privateProcessed, evidence.registryProcessed];
  const legacyConflict = signals.includes(true) && signals.includes(false);
  // A digest identifies a version; it cannot prove that processing completed.
  const processed = hasCurrent ? current === "已提炼"
    : signals.includes(true) && !legacyConflict;
  const status = processed ? "已提炼" : "未提炼";
  const targets = [...(evidence.targetPaths ?? []), ...(evidence.reverseSourceTargets ?? [])];
  const targetPaths = [...new Set(targets.filter(isMaintenanceSourceTargetPath))];
  const existing = [...new Set((evidence.targetPaths ?? []).filter(isMaintenanceSourceTargetPath))];
  return {
    status,
    targetPaths,
    needsReview: (hasCurrent ? !validCurrent : legacyConflict) || targets.some((value) => !isMaintenanceSourceTargetPath(value))
      || (processed && targetPaths.length === 0),
    shouldWrite: current !== status || targetPaths.some((value) => !existing.includes(value))
  };
}
