import { rawDigestRecordFromMarkdown, type RawDigestRegistryEntry } from "./raw-digest";
import type { KnowledgeBaseRawDigestState } from "./types";
import { isMaintenanceSourceTargetPath, readMaintenanceFrontmatterProperty, readMaintenanceSourceStateProperty } from "./maintenance-source-frontmatter";
import type { MaintenanceMigrationEvidence, MaintenanceSourceMigrationPlan } from "./maintenance-p1-contract";
import type { MaintenanceCanonicalSourceStatus } from "./maintenance-upgrade-contract";

export interface MaintenanceSourceLegacyEvidence {
  /** Optional current body digest, inspected only by the upgrade preview. */
  fingerprint?: () => string;
  registry?: RawDigestRegistryEntry;
  maintenance?: Readonly<{ fingerprint: string; status: "processed" | "unread" | "failed" }>;
  previous?: Readonly<{ fingerprint?: string }>;
  hasTrackerHint?: boolean;
}

export interface MaintenanceSourceResolution { state: KnowledgeBaseRawDigestState; reason: string; origin: "new" | "private" | "registry" | "legacy" | "none" }

export function isMaintenanceCanonicalSourceStatus(value: unknown): value is MaintenanceCanonicalSourceStatus {
  return value === "已提炼" || value === "未提炼" || value === "待重新提炼" || value === "提炼失败" || value === "待校准";
}

function canonicalState(value: MaintenanceCanonicalSourceStatus): KnowledgeBaseRawDigestState {
  return value === "已提炼" ? "digested" : value === "提炼失败" ? "failed" : value === "待重新提炼" ? "changed" : value === "待校准" ? "calibration" : "pending";
}

/** Shared transition rule for maintenance, workbench and dashboard; never writes old notes. */
export function resolveMaintenanceSourceState(markdown: string, evidence: MaintenanceSourceLegacyEvidence = {}): MaintenanceSourceResolution {
  const current = readMaintenanceSourceStateProperty(markdown);
  if (isMaintenanceCanonicalSourceStatus(current.value)) {
    return { state: canonicalState(current.value), origin: "new", reason: "采用当前标准提炼状态" };
  }
  const frontmatter = rawDigestRecordFromMarkdown(Buffer.from(markdown));
  const completed = (origin: MaintenanceSourceResolution["origin"]): MaintenanceSourceResolution => ({ state: "digested", origin, reason: "旧记录确认已经提炼，保留完成状态" });
  // Receipts express outcomes; a fingerprint alone only identifies bytes. The
  // caller supplies the latest private receipt, which outranks older stores.
  if (evidence.maintenance) {
    if (evidence.maintenance.status === "processed") return completed("private");
    return { state: evidence.maintenance.status === "failed" ? "failed" : "pending", origin: "private", reason: "采用最新私有维护结果，优先于registry和旧文件头" };
  }
  if (evidence.registry) return completed("registry");
  const legacyProperty = readMaintenanceFrontmatterProperty(markdown, "已处理");
  if (legacyProcessedSignal(legacyProperty.value) === true || (!legacyProperty.error && frontmatter?.processed)) return completed("legacy");
  return current.present ? { state: "pending", origin: "new", reason: current.error ?? "已有非标准提炼状态，保留原值并请人工核对" }
    : { state: "pending", origin: "none", reason: "没有明确完成记录；单有指纹或历史线索不能证明已经提炼" };
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
  const validCurrent = isMaintenanceCanonicalSourceStatus(current);
  const legacyProcessed = evidence.privateProcessed ?? evidence.registryProcessed ?? legacyProcessedSignal(evidence.legacyProcessed);
  // A digest identifies a version; it cannot prove that processing completed.
  const status: MaintenanceCanonicalSourceStatus = validCurrent ? current : legacyProcessed ? "已提炼" : "未提炼";
  const targets = evidence.targetPaths ?? evidence.reverseSourceTargets ?? [];
  const targetPaths = [...new Set(targets.filter(isMaintenanceSourceTargetPath))];
  return {
    status,
    targetPaths,
    needsReview: (hasCurrent && !validCurrent) || targets.some((value) => !isMaintenanceSourceTargetPath(value))
      || (status === "已提炼" && targetPaths.length === 0),
    shouldWrite: !hasCurrent || (evidence.targetPaths === undefined && targetPaths.length > 0)
  };
}
