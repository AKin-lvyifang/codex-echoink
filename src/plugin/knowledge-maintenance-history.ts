import { recordKnowledgeBaseMaintenanceRun, type KnowledgeBaseSettings } from "../settings/settings";
import type { KnowledgeMaintenanceTerminalEvent } from "./pi-knowledge-maintenance-production";

/** Returns false for a repeated tool receipt. No report/assessment can claim a host health check. */
export function recordProductionMaintenanceTerminal(settings: KnowledgeBaseSettings, { input, result, at }: KnowledgeMaintenanceTerminalEvent): boolean {
  const runId = `${input.productRunId}:${input.toolCallId}`;
  if (settings.maintenanceHistory.some((entry) => entry.runId === runId)) return false;
  const terminal = result.status === "cancelled" ? "cancelled" : result.maintenanceResult?.status ?? "failed";
  recordKnowledgeBaseMaintenanceRun(settings, {
    runId, recordId: result.recordId, at, mode: "maintain", resultStatus: terminal,
    status: terminal === "cancelled" ? "canceled" : terminal === "completed" || terminal === "noop" ? "success" : "failed",
    completion: terminal === "completed" ? "full" : terminal === "partial" ? "partial" : terminal === "noop" ? "noop" : undefined,
    reportPath: result.maintenanceResult?.systemPaths.find((p) => /^outputs\/(?:maintenance\/)?kb-.*\.md$/u.test(p)) ?? "",
    errorCode: result.errorCode,
    warnings: result.maintenanceResult?.issues.map((issue) => ({ id: issue.code, message: issue.message }))
  });
  settings.lastSummary = result.message;
  return true;
}
