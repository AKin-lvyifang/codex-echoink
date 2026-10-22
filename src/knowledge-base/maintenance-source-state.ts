import { isMaintenanceSourceTargetPath, readMaintenanceSourceStatus } from "./maintenance-source-frontmatter";
import type { MaintenanceMigrationEvidence, MaintenanceSourceMigrationPlan } from "./maintenance-p1-contract";

/** Scanning uses only the current property, never the source body's hash. */
export function isMaintenanceSourceProcessed(markdown: string): boolean {
  return readMaintenanceSourceStatus(markdown) === "已提炼";
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
