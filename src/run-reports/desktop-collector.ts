import type { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import type { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { inspectPiSessionJsonl, readPiActiveLeafCheckpoint } from "../harness/pi-native/pi-session-durability";
import type { RunReport } from "./report";

/** No AgentSession, activation, initialization, repair or recovery calls. */
export async function collectDesktopRunReport(input: {
  catalog: FileConversationCatalog; productRuns: FileProductRunStore; conversationId: string;
  environment: RunReport["environment"]; recentErrors: unknown[];
}): Promise<RunReport> {
  const report: RunReport = { format: "echoink-run-report", formatVersion: 1, createdAt: new Date().toISOString(), description: "", contact: "",
    environment: input.environment, conversation: { id: input.conversationId, title: "", agent: "", provider: "", model: "", catalogStatus: "active", activeLeafId: null },
    runs: [], diagnostics: [], recentErrors: input.recentErrors, entries: [], missing: [], redaction: { applied: true, rules: "v1" } };
  const gap = (part: string, error: unknown) => report.missing.push(`${part}: ${error instanceof Error ? error.message : String(error)}`);
  const catalog = await input.catalog.get(input.conversationId);
  if (!catalog) throw new Error("会话已不存在，无法采集运行记录。");
  Object.assign(report.conversation, { title: catalog.title, agent: catalog.agentId ?? "", catalogStatus: catalog.status });
  try {
    const runs = await input.productRuns.listReadOnly(input.conversationId); report.runs = [...runs];
    if (!runs.length) report.missing.push("runs_not_persisted");
  } catch (error) { gap("runs_unavailable", error); }
  try { report.diagnostics = await input.catalog.diagnostics(input.conversationId); } catch (error) { gap("diagnostics_unavailable", error); }
  if (catalog.sessionFile) {
    try {
      const inspected = inspectPiSessionJsonl({ sessionRoot: input.catalog.sessionRootPath, sessionFile: catalog.sessionFile });
      if (inspected.header?.id !== catalog.piSessionId) report.missing.push("jsonl_session_identity_mismatch");
      else {
        report.entries = [...inspected.entries];
        if (!inspected.valid) {
          report.diagnostics.push(inspected.diagnostic);
          report.missing.push(`jsonl_corrupted_after_line_${(inspected.diagnostic.lineNumber ?? 1) - 1}`);
        }
        // Checkpoint reflects the selected branch; physical last entry may belong to another branch.
        try {
          const leaf = readPiActiveLeafCheckpoint({ sessionRoot: input.catalog.sessionRootPath, piSessionId: catalog.piSessionId });
          if (leaf && (!leaf.activeLeafId || inspected.entries.some(entry => entry.id === leaf.activeLeafId))) report.conversation.activeLeafId = leaf.activeLeafId;
          else report.missing.push("active_leaf_checkpoint_unavailable");
        } catch (error) { gap("active_leaf_unavailable", error); }
        const entriesById = new Map(inspected.entries.map(entry => [entry.id, entry]));
        const branch: typeof inspected.entries[number][] = [];
        let cursor = report.conversation.activeLeafId ? entriesById.get(report.conversation.activeLeafId) : undefined;
        while (cursor) { branch.unshift(cursor); cursor = cursor.parentId ? entriesById.get(cursor.parentId) : undefined; }
        for (const entry of branch) {
          if (entry.type === "model_change") { report.conversation.provider = entry.provider; report.conversation.model = entry.modelId; }
          if (entry.type === "message" && entry.message.role === "assistant") { report.conversation.provider = entry.message.provider; report.conversation.model = entry.message.model; }
        }
      }
    } catch (error) { gap("entries_unavailable", error); }
  } else report.missing.push("session_jsonl_not_persisted");
  const relevantErrors = input.recentErrors.some(error => !!error && typeof error === "object" && "conversationId" in error && error.conversationId === input.conversationId);
  const persistedDetails = report.runs.some(run => {
    if (!run || typeof run !== "object") return false;
    if ("error" in run && typeof run.error === "string" && run.error.trim() && !/^(?:pi_native_runtime_interrupted|process_unknown)$/u.test(run.error)) return true;
    if (!("interruption" in run) || !run.interruption || typeof run.interruption !== "object") return false;
    const interruption = run.interruption as { detail?: string; reason?: string };
    return !!interruption.detail?.trim() || !!interruption.reason && !["process_unknown", "run_failed", "watchdog"].includes(interruption.reason);
  });
  if (catalog.taskStatus === "interrupted" && !relevantErrors && !persistedDetails) report.missing.push("error_text_not_persisted");
  return report;
}
