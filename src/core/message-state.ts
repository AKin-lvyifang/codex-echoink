import type { ChatMessage } from "../settings/settings";
import { buildKnowledgeBaseFallbackReportPayload } from "../knowledge-base/maintain-report-card";
import type { KnowledgeBaseCommandUiMode } from "../knowledge-base/types";

export interface PendingRunTerminalRecovery {
  runId: string;
  backendId?: string;
  status: "cancelled" | "failed";
  error: string;
}

export interface StaleHarnessRunRecoveryResult {
  settledMessageCount: number;
  settledRunIds: string[];
  failedRunIds: string[];
}

export async function recoverStaleHarnessRuns(input: {
  messages: ChatMessage[];
  commitLocalHistory: () => Promise<void>;
  settleRunTerminal: (recovery: PendingRunTerminalRecovery) => Promise<void>;
  deferRunIds?: ReadonlySet<string>;
}): Promise<StaleHarnessRunRecoveryResult> {
  const settledMessageCount = settleStaleRunningMessages(
    input.messages,
    input.deferRunIds
  );
  if (settledMessageCount > 0) await input.commitLocalHistory();

  const recoveries = pendingRunTerminalRecoveries(
    input.messages,
    input.deferRunIds
  );
  const settledRunIds: string[] = [];
  const failedRunIds: string[] = [];
  for (const recovery of recoveries) {
    try {
      await input.settleRunTerminal(recovery);
      clearRunTerminalRecovery(input.messages, recovery.runId);
      settledRunIds.push(recovery.runId);
    } catch {
      failedRunIds.push(recovery.runId);
    }
  }
  if (settledRunIds.length > 0) await input.commitLocalHistory();
  return { settledMessageCount, settledRunIds, failedRunIds };
}

export function settleStaleRunningMessages(
  messages: ChatMessage[],
  deferRunIds: ReadonlySet<string> = new Set()
): number {
  let settled = 0;
  const pendingByRun = new Map<string, "cancelled" | "failed">();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.status !== "running") continue;
    if (message.runId && deferRunIds.has(message.runId)) continue;

    if (message.runId) {
      const status = isKnowledgeBaseRunMessage(message) ? "failed" : "cancelled";
      if (status === "failed" || !pendingByRun.has(message.runId)) pendingByRun.set(message.runId, status);
    }

    if (message.itemType === "thinking" || isEmptyProcessMessage(message)) {
      messages.splice(index, 1);
      settled += 1;
      continue;
    }

    if (isKnowledgeBaseRunMessage(message)) {
      const mode = knowledgeBaseUiMode(message.knowledgeBaseUi?.mode);
      const text = staleKnowledgeBaseRunText(mode);
      message.status = "failed";
      message.text = text;
      message.knowledgeBaseUi = buildKnowledgeBaseFallbackReportPayload(
        mode,
        "failed",
        text
      );
      settled += 1;
      continue;
    }

    message.status = "interrupted";
    settled += 1;
  }
  const completedRunIds = new Set(messages
    .filter((message) => message.runId && isCompletedFinalAnswer(message))
    .map((message) => message.runId as string));
  for (const message of messages) {
    if (!message.runId || message.runTerminalRecovered || completedRunIds.has(message.runId)) continue;
    if (message.status === "interrupted" || message.status === "canceled" || message.status === "cancelled") {
      if (!pendingByRun.has(message.runId)) pendingByRun.set(message.runId, "cancelled");
    } else if (message.status === "failed" || message.status === "error") {
      pendingByRun.set(message.runId, "failed");
    }
  }
  for (const [runId, status] of pendingByRun) {
    const marker = [...messages].reverse().find((message) => message.runId === runId);
    if (marker) marker.runTerminalRecoveryPending = status;
  }
  return settled;
}

export function pendingRunTerminalRecoveries(
  messages: ChatMessage[],
  deferRunIds: ReadonlySet<string> = new Set()
): PendingRunTerminalRecovery[] {
  const recoveries = new Map<string, PendingRunTerminalRecovery>();
  for (const message of messages) {
    const status = message.runTerminalRecoveryPending;
    if (!message.runId || !status) continue;
    if (deferRunIds.has(message.runId)) continue;
    const current = recoveries.get(message.runId);
    recoveries.set(message.runId, {
      runId: message.runId,
      backendId: message.backendId ?? current?.backendId,
      status: status === "failed" || current?.status === "failed" ? "failed" : "cancelled",
      error: status === "failed" ? "插件重载时知识库任务未完成" : "插件重载导致运行中断"
    });
  }
  return [...recoveries.values()];
}

function clearRunTerminalRecovery(messages: ChatMessage[], runId: string): void {
  let recoveredMarker: ChatMessage | null = null;
  for (const message of messages) {
    if (message.runId !== runId) continue;
    if (message.runTerminalRecoveryPending) recoveredMarker = message;
    delete message.runTerminalRecoveryPending;
  }
  if (recoveredMarker) recoveredMarker.runTerminalRecovered = true;
}

function isCompletedFinalAnswer(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.status !== "completed") return false;
  return !message.itemType || message.itemType === "assistant";
}

function isEmptyProcessMessage(message: ChatMessage): boolean {
  if (!isProcessItemType(message.itemType)) return false;
  return !String(message.text ?? "").trim();
}

function isProcessItemType(itemType?: string): boolean {
  return itemType === "reasoning" || itemType === "commandExecution" || itemType === "fileChange" || itemType === "mcpToolCall" || itemType === "dynamicToolCall" || itemType === "collabAgentToolCall" || itemType === "plan";
}

function isKnowledgeBaseRunMessage(message: ChatMessage): boolean {
  return message.itemType === "knowledgeBase" && message.knowledgeBaseUi?.kind === "maintain-run";
}

function staleKnowledgeBaseRunText(mode: unknown): string {
  return `知识库${knowledgeBaseModeLabel(mode)}失败：任务中断，未收到完成报告。`;
}

function knowledgeBaseModeLabel(mode: unknown): string {
  switch (mode) {
    case "lint":
      return "体检";
    case "reingest":
      return "重新提炼";
    case "calibrate":
      return "Raw 状态校准";
    case "outputs":
      return "Outputs 整理";
    case "inbox":
      return "Inbox 分流";
    case "maintain":
    default:
      return "维护";
  }
}

function knowledgeBaseUiMode(mode: unknown): KnowledgeBaseCommandUiMode {
  if (
    mode === "lint"
    || mode === "reingest"
    || mode === "calibrate"
    || mode === "outputs"
    || mode === "inbox"
  ) {
    return mode;
  }
  return "maintain";
}
