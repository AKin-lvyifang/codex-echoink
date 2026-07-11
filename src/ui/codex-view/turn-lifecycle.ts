import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import type { StoredSession } from "../../settings/settings";
import type { EditorActionRunWaiter } from "./runner-context";
import type { SessionMessageInput } from "./session-message-store";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutText } from "../turn-watchdog";
import type { EditorActionStatusView } from "../../editor-actions/types";

export interface CodexTurnLifecycleHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "knowledge-base" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  editorActionRun: EditorActionRunWaiter | null;
  editorActionCurrentItemIds: Set<string>;
  turnWatchdog: number | null;
  isEditorActionRunActive(): boolean;
  rejectEditorActionRun(error: Error): void;
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
    if (host.editorActionThreadId && host.activeTurnId) {
      await host.plugin.codex?.interruptTurn(host.editorActionThreadId, host.activeTurnId).catch(swallowError("cancel editor action Codex turn"));
    }
    host.rejectEditorActionRun(new Error("写作操作已中断"));
    host.running = false;
    host.activeTurnId = "";
    host.clearTurnWatchdog();
    host.clearActiveRun();
    host.editorActionCurrentItemIds.clear();
    host.setEditorActionStatus({ status: "canceled", message: "已中断" });
    host.applyStatus();
    return;
  }
  const session = host.activeRunSession();
  host.pauseQueueForSession(session.id);
  if (!session.threadId || !host.activeTurnId) return;
  await host.plugin.codex?.interruptTurn(session.threadId, host.activeTurnId).catch(swallowError("cancel active Codex turn"));
  if (host.editorActionRun?.runId === host.activeRunId) host.rejectEditorActionRun(new Error("写作操作已中断"));
  host.running = false;
  host.activeTurnId = "";
  host.editorActionActiveTimeoutMs = 0;
  host.clearTurnWatchdog();
  host.finishThinkingMessage(session, "中断");
  host.finishRunningProcessMessages(session, "interrupted");
  host.clearActiveRun();
  host.applyStatus();
  void host.plugin.saveSettings(true);
}

export function armTurnWatchdog(host: CodexTurnLifecycleHost, timeoutMs = CHAT_TURN_WATCHDOG_MS, timeoutText?: string): void {
  host.clearTurnWatchdog();
  host.turnWatchdog = window.setTimeout(() => {
    host.turnWatchdog = null;
    if (!host.running) return;
    const timedOutThreadId = host.editorActionThreadId;
    const timedOutTurnId = host.activeTurnId;
    host.running = false;
    if (host.isEditorActionRunActive()) {
      if (timedOutThreadId && timedOutTurnId) {
        void host.plugin.codex?.interruptTurn(timedOutThreadId, timedOutTurnId).catch(swallowError("interrupt timed out editor action Codex turn"));
      }
      host.rejectEditorActionRun(new Error("写作操作响应超时"));
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
    const knowledgeSession = host.isKnowledgeBaseSession(session);
    const shouldPauseQueue = host.activeRunKind === "chat";
    if (knowledgeSession && session.threadId && timedOutTurnId) {
      void host.plugin.codex?.interruptTurn(session.threadId, timedOutTurnId).catch(swallowError("interrupt timed out knowledge base Codex turn"));
    }
    host.finishThinkingMessage(session, "失败");
    host.finishRunningProcessMessages(session, "error");
    host.addMessageToSession(session, {
      role: "system",
      title: "响应超时",
      itemType: "error",
      text: timeoutText ?? turnWatchdogTimeoutText(timeoutMs)
    });
    host.clearActiveRun();
    host.applyStatus();
    void host.plugin.saveSettings(true);
    if (shouldPauseQueue) void host.afterTurnSettled(session.id, false);
  }, timeoutMs);
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
