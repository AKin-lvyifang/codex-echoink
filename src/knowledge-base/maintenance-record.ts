import type { KnowledgeMaintenanceResultEnvelope } from "./knowledge-maintenance-result";

export interface KnowledgeMaintenanceRecord {
  schemaVersion: 1;
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
