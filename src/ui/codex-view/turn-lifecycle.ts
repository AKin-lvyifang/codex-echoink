import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import type { StoredSession } from "../../settings/settings";
import type { SessionMessageInput } from "./session-message-store";
import { CHAT_TURN_WATCHDOG_MS, turnWatchdogTimeoutText } from "../turn-watchdog";
import type { EditorActionStatusView } from "../../editor-actions/types";
import type {
  AppendRunEventInput,
  SettleRunTerminalInput
} from "../../harness/kernel/run-orchestrator";

export type ChatSurfaceTerminalOwner =
  | "adapter"
  | "stop"
  | "watchdog"
  | "sync"
  | "error"
  | "view-close";
export type ChatSurfaceTerminalStatus = "completed" | "failed" | "cancelled";

export interface ChatSurfaceTerminalClaim {
  runId: string;
  owner: ChatSurfaceTerminalOwner;
  status: ChatSurfaceTerminalStatus;
  claimedAt: number;
}

const chatSurfaceTerminalClaims = new Map<string, ChatSurfaceTerminalClaim>();
const chatSurfaceTerminalLateAuditDurableRunIds = new Set<string>();
const chatSurfaceTerminalLateAuditFlights = new Map<string, Promise<void>>();
const MAX_CHAT_SURFACE_TERMINAL_CLAIMS = 256;
const CHAT_SURFACE_LATE_AUDIT_MAX_ATTEMPTS = 3;
const CHAT_SURFACE_LATE_AUDIT_RETRY_DELAY_MS = 5;

export interface CodexTurnLifecycleHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "knowledge-base" | "editor" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  activeRunNativeExecutionRecordIds?: string[];
  editorActionActiveTimeoutMs: number;
  editorActionThreadId: string;
  editorActionCurrentItemIds: Set<string>;
  turnWatchdog: number | null;
  isEditorActionRunActive(): boolean;
  setEditorActionStatus(status: EditorActionStatusView): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
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
  const terminalClaim = claimChatSurfaceTerminal(runId, "stop", "cancelled");
  if (!terminalClaim.acquired) return;
  const backendId = backendIdForRun(session, runId);
  try {
    await host.plugin.cancelHarnessRun(runId);
  } catch (error) {
    releaseChatSurfaceTerminal(runId, "stop");
    throw error;
  }
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
    const chatRunId = host.activeRunKind === "chat" ? host.activeRunId : "";
    if (
      chatRunId
      && !claimChatSurfaceTerminal(chatRunId, "watchdog", "failed").acquired
    ) {
      return;
    }
    host.running = false;
    if (host.isEditorActionRunActive()) {
      if (host.activeRunId) void host.plugin.cancelHarnessRun(host.activeRunId).catch(swallowError("interrupt timed out editor action Harness run"));
      host.setEditorActionStatus({ status: "failed", message: "响应超时", error: "写作操作响应超时" });
      host.activeTurnId = "";
      host.clearActiveRun();
      host.editorActionCurrentItemIds.clear();
      host.applyStatus();
      return;
    }
    host.activeTurnId = "";
    const session = host.activeRunSession();
    const runId = host.activeRunId;
    if (!runId) return;
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
      void persistAndSettleChatRun(host.plugin, { runId, status: "failed", backendId, error })
        .catch(swallowError("persist timed out Chat run"));
    } else {
      void host.plugin.saveSettings(true);
    }
    host.clearActiveRun();
    host.applyStatus();
    if (shouldPauseQueue) void host.afterTurnSettled(session.id, false);
  }, timeoutMs);
}

export async function persistAndSettleChatRun(plugin: CodexForObsidianPlugin, input: SettleRunTerminalInput): Promise<void> {
  await plugin.commitChatSurfaceTerminal(input);
}

export function prepareChatSurfaceTerminal(runId: string): void {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) return;
  chatSurfaceTerminalClaims.delete(normalizedRunId);
  chatSurfaceTerminalLateAuditDurableRunIds.delete(normalizedRunId);
  chatSurfaceTerminalLateAuditFlights.delete(normalizedRunId);
  while (chatSurfaceTerminalClaims.size >= MAX_CHAT_SURFACE_TERMINAL_CLAIMS) {
    const oldestRunId = Array.from(chatSurfaceTerminalClaims.keys())[0];
    if (!oldestRunId) break;
    chatSurfaceTerminalClaims.delete(oldestRunId);
    chatSurfaceTerminalLateAuditDurableRunIds.delete(oldestRunId);
    chatSurfaceTerminalLateAuditFlights.delete(oldestRunId);
  }
}

export function claimChatSurfaceTerminal(
  runId: string,
  owner: ChatSurfaceTerminalOwner,
  status: ChatSurfaceTerminalStatus
): { acquired: boolean; winner: ChatSurfaceTerminalClaim } {
  const normalizedRunId = runId.trim();
  const existing = chatSurfaceTerminalClaims.get(normalizedRunId);
  if (existing) {
    return {
      acquired: false,
      winner: existing
    };
  }
  const winner: ChatSurfaceTerminalClaim = {
    runId: normalizedRunId,
    owner,
    status,
    claimedAt: Date.now()
  };
  chatSurfaceTerminalClaims.set(normalizedRunId, winner);
  return { acquired: true, winner };
}

export function chatSurfaceTerminalClaim(
  runId: string
): ChatSurfaceTerminalClaim | undefined {
  return chatSurfaceTerminalClaims.get(runId.trim());
}

export function releaseChatSurfaceTerminal(
  runId: string,
  owner: ChatSurfaceTerminalOwner
): void {
  const normalizedRunId = runId.trim();
  const existing = chatSurfaceTerminalClaims.get(normalizedRunId);
  if (existing?.owner === owner) {
    chatSurfaceTerminalClaims.delete(normalizedRunId);
    chatSurfaceTerminalLateAuditDurableRunIds.delete(normalizedRunId);
    chatSurfaceTerminalLateAuditFlights.delete(normalizedRunId);
  }
}

export async function recordIgnoredLateChatTerminal(
  plugin: {
    appendHarnessRunEvent?: (input: AppendRunEventInput) => Promise<unknown>;
  },
  input: {
    runId: string;
    backendId: string;
    lateStatus: ChatSurfaceTerminalStatus;
    winner: ChatSurfaceTerminalClaim;
  }
): Promise<void> {
  const normalizedRunId = input.runId.trim();
  if (
    !normalizedRunId
    || chatSurfaceTerminalLateAuditDurableRunIds.has(normalizedRunId)
  ) return;
  const existing = chatSurfaceTerminalLateAuditFlights.get(normalizedRunId);
  if (existing) {
    await existing;
    return;
  }
  const flight = (async () => {
    if (typeof plugin.appendHarnessRunEvent !== "function") {
      console.warn("EchoInk ignored late Chat terminal", input);
      return;
    }
    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= CHAT_SURFACE_LATE_AUDIT_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await plugin.appendHarnessRunEvent({
          runId: input.runId,
          source: "workflow",
          type: "run.surface_terminal.ignored",
          backendId: input.backendId,
          status: input.lateStatus,
          data: {
            warningKind: "late-surface-terminal-ignored",
            winnerOwner: input.winner.owner,
            winnerStatus: input.winner.status,
            lateStatus: input.lateStatus
          }
        });
        chatSurfaceTerminalLateAuditDurableRunIds.add(normalizedRunId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < CHAT_SURFACE_LATE_AUDIT_MAX_ATTEMPTS) {
          await delayChatSurfaceLateAuditRetry();
        }
      }
    }
    // Do not mark the audit durable after bounded retry exhaustion. A later
    // late-terminal observation starts a new single flight and can retry.
    console.warn("EchoInk late Chat terminal audit warning failed", lastError);
  })();
  chatSurfaceTerminalLateAuditFlights.set(normalizedRunId, flight);
  try {
    await flight;
  } finally {
    if (chatSurfaceTerminalLateAuditFlights.get(normalizedRunId) === flight) {
      chatSurfaceTerminalLateAuditFlights.delete(normalizedRunId);
    }
  }
}

async function delayChatSurfaceLateAuditRetry(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, CHAT_SURFACE_LATE_AUDIT_RETRY_DELAY_MS);
  });
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
  if (host.activeRunNativeExecutionRecordIds) {
    host.activeRunNativeExecutionRecordIds = [];
  }
  host.editorActionActiveTimeoutMs = 0;
  clearMessageStoreActiveRun();
}
