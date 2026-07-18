import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import type { StoredSession } from "../../settings/settings";
import type { SessionMessageInput } from "./session-message-store";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutText } from "../turn-watchdog";
import type { EditorActionStatusView } from "../../editor-actions/types";
import type { SettleRunTerminalInput } from "../../harness/kernel/run-orchestrator";

export interface CodexTurnLifecycleHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "knowledge-base" | "editor" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  editorActionCurrentItemIds: Set<string>;
  turnWatchdog: number | null;
  isEditorActionRunActive(): boolean;
  setEditorActionStatus(status: EditorActionStatusView): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  prewarmEditorActionThread(): void;
  activeRunSession(): StoredSession;
  pauseQueueForSession(sessionId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  addMessageToSession(session: StoredSession, message: SessionMessageInput): void;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
  isKnowledgeBaseSession(session: StoredSession): boolean;
}

export async function stopTurn(host: CodexTurnLifecycleHost): Promise<void> {
  if (host.isEditorActionRunActive()) {
    if (host.activeRunId) await host.plugin.cancelHarnessRun(host.activeRunId);
    host.running = false;
    host.activeTurnId = "";
    host.clearTurnWatchdog();
    host.clearActiveRun();
    host.editorActionCurrentItemIds.clear();
    host.setEditorActionStatus({ status: "canceled", message: "已中断" });
    host.applyStatus();
    return;
  }
  if (host.activeRunKind === "knowledge-base") {
    const manager = host.plugin.getKnowledgeBaseManager();
    if (manager) {
      const session = host.activeRunSession();
      const cancellation = await manager.cancelMaintenance();
      if (cancellation.accepted) {
        host.pauseQueueForSession(session.id);
      }
      return;
    }
  }
  const session = host.activeRunSession();
  const runId = host.activeRunId;
  if (!runId) return;
  const backendId = backendIdForRun(session, runId);
  await host.plugin.cancelHarnessRun(runId);
  host.pauseQueueForSession(session.id);
  host.running = false;
  host.activeTurnId = "";
  host.editorActionActiveTimeoutMs = 0;
  host.clearTurnWatchdog();
  host.finishThinkingMessage(session, "中断");
  host.finishRunningProcessMessages(session, "interrupted");
  host.addMessageToSession(session, {
    role: "system",
    title: "已中断",
    itemType: "error",
    status: "canceled",
    runId,
    text: "本轮对话已中断。"
  });
  host.clearActiveRun();
  await persistAndSettleChatRun(host.plugin, { runId, status: "cancelled", backendId, error: "用户中断" });
  host.applyStatus();
}

export function armTurnWatchdog(host: CodexTurnLifecycleHost, timeoutMs = CHAT_TURN_WATCHDOG_MS, timeoutText?: string): void {
  host.clearTurnWatchdog();
  host.turnWatchdog = window.setTimeout(() => {
    host.turnWatchdog = null;
    if (!host.running) return;
    host.running = false;
    if (host.isEditorActionRunActive()) {
      if (host.activeRunId) void host.plugin.cancelHarnessRun(host.activeRunId).catch(swallowError("interrupt timed out editor action Harness run"));
      host.setEditorActionStatus({ status: "failed", message: "响应超时", error: "写作操作响应超时" });
      host.activeTurnId = "";
      host.clearActiveRun();
      host.editorActionCurrentItemIds.clear();
      host.applyStatus();
      host.prewarmEditorActionThread();
      return;
    }
    host.activeTurnId = "";
    const session = host.activeRunSession();
    const runId = host.activeRunId;
    const shouldPauseQueue = host.activeRunKind === "chat";
    const backendId = backendIdForRun(session, runId);
    if (runId) void host.plugin.cancelHarnessRun(runId).catch(swallowError("cancel timed out Harness run"));
    host.finishThinkingMessage(session, "失败");
    host.finishRunningProcessMessages(session, "error");
    const error = timeoutText ?? turnWatchdogTimeoutText(timeoutMs);
    host.addMessageToSession(session, {
      role: "system",
      title: "响应超时",
      itemType: "error",
      status: "failed",
      runId,
      text: error
    });
    if (shouldPauseQueue && runId) {
      void persistAndSettleChatRun(host.plugin, { runId, status: "failed", backendId, error });
    } else {
      void host.plugin.saveSettings(true);
    }
    host.clearActiveRun();
    host.applyStatus();
    if (shouldPauseQueue) void host.afterTurnSettled(session.id, false);
  }, timeoutMs);
}

export async function persistAndSettleChatRun(plugin: CodexForObsidianPlugin, input: SettleRunTerminalInput): Promise<void> {
  await plugin.saveSettings(true);
  await plugin.settleHarnessRunTerminal(input);
}

function backendIdForRun(session: StoredSession, runId: string): string {
  return session.messages.slice().reverse().find((message) => message.runId === runId && message.backendId)?.backendId ?? "codex-cli";
}

export function clearTurnWatchdog(host: CodexTurnLifecycleHost): void {
  if (!host.turnWatchdog) return;
  window.clearTimeout(host.turnWatchdog);
  host.turnWatchdog = null;
}

export function clearActiveRun(host: CodexTurnLifecycleHost, clearMessageStoreActiveRun: () => void): void {
  host.activeRunId = "";
  host.activeRunKind = "";
  host.activeRunSessionId = "";
  host.activeTurnId = "";
  host.editorActionActiveTimeoutMs = 0;
  clearMessageStoreActiveRun();
}
