import type { MobileSession } from "../mobile/store";
import type { RunReport } from "./report";

/** getSession returns a detached copy of the committed state, never a resumed task. */
export function collectMobileRunReport(session: MobileSession, environment: RunReport["environment"], recentErrors: unknown[], runtimeError?: string): RunReport {
  const last = session.runs?.at(-1);
  const missing: string[] = [];
  if (!session.runs?.length) missing.push("runs_not_persisted");
  const reason = session.interruption?.reason ?? last?.interruption?.reason;
  if (session.taskStatus === "interrupted" && (!reason || ["process_unknown", "run_failed", "watchdog"].includes(reason)) && !runtimeError && !session.messages.some(message => message.role === "assistant" && message.errorMessage)) missing.push("error_text_not_persisted");
  return { format: "echoink-run-report", formatVersion: 1, createdAt: new Date().toISOString(), description: "", contact: "", environment,
    conversation: { id: session.id, title: session.title, agent: session.agentId, provider: last?.providerId ?? "", model: last?.modelId ?? "", catalogStatus: session.archivedAt ? "archived" : "active", activeLeafId: null },
    runs: [...structuredClone(session.runs ?? []), ...structuredClone(session.operations ?? []), ...(session.interruption ? [{ interruption: structuredClone(session.interruption) }] : [])],
    diagnostics: runtimeError ? [{ source: "mobile.runtime", message: runtimeError }] : [], recentErrors,
    entries: [...structuredClone(session.messages), { type: "tools", tools: structuredClone(session.tools) }], missing, redaction: { applied: true, rules: "v1" } };
}
