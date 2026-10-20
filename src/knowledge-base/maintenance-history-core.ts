import type { KnowledgeMaintenanceRecord } from "./maintenance-record";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "../settings/settings";

/** Private records are authoritative; preserve legacy reports and every result state. */
export function mergeKnowledgeMaintenanceHistory(
  settingsHistory: readonly KnowledgeBaseMaintenanceHistoryEntry[],
  privateRecords: readonly KnowledgeMaintenanceRecord[]
): KnowledgeBaseMaintenanceHistoryEntry[] {
  const privateEntries: KnowledgeBaseMaintenanceHistoryEntry[] = privateRecords.map((record) => ({ recordId: record.recordId, runId: record.runId, date: record.date, at: record.at, status: record.cancelled ? "canceled" : record.result.status === "completed" || record.result.status === "noop" ? "success" : "failed", mode: "maintain", reportPath: "", resultStatus: record.cancelled ? "cancelled" : record.result.status, completion: record.result.status === "partial" ? "partial" : record.result.status === "noop" ? "noop" : record.result.status === "completed" ? "full" : undefined, pendingSources: record.sources.filter((source) => source.status !== "processed").map((source) => source.path), warnings: record.result.issues.map((issue) => ({ id: issue.code, message: issue.message })) }));
  const recordIds = new Set<string>(), runIds = new Set<string>();
  return [...privateEntries, ...settingsHistory].filter((entry) => {
    const duplicate = Boolean((entry.recordId && recordIds.has(entry.recordId)) || (entry.runId && runIds.has(entry.runId)));
    // Track both identities even when one already matched, to coalesce aliases as well.
    if (entry.recordId) recordIds.add(entry.recordId);
    if (entry.runId) runIds.add(entry.runId);
    return !duplicate;
  }).sort((left, right) => right.at - left.at || right.date.localeCompare(left.date));
}

