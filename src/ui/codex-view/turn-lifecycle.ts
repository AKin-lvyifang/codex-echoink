import type CodexForObsidianPlugin from "../../main";
import { runErrors } from "../../run-reports/recent-errors";
import type { StoredSession } from "../../settings/settings";
import type { SessionMessageInput } from "./session-message-store";
import { armPausableTurnWatchdog, clearPausableTurnWatchdog, turnWatchdogTimeoutText, CHAT_TURN_WATCHDOG_MS, type TurnWatchdogOwner } from "../turn-watchdog";

export interface CodexTurnLifecycleHost {
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeRunKind: "chat" | "";
  activeRunSessionId: string;
  activeTurnId: string;
  turnWatchdog: number | null;
  /** Stable run state when this host is a short-lived View adapter. */
  readonly turnWatchdogOwner?: TurnWatchdogOwner;
  cancelPendingTurn?(): void;
  clearTurnWatchdog(): void;
  clearActiveRun(): void;
  applyStatus(): void;
  activeRunSession(): StoredSession;
  pauseQueueForSession(sessionId: string): void;
  finishThinkingMessage(session: StoredSession, status: string): void;
  finishRunningProcessMessages(session: StoredSession, status: string): void;
  addMessageToSession(session: StoredSession, message: SessionMessageInput): void;
  afterTurnSettled(sessionId: string, succeeded: boolean): Promise<void>;
}

export async function stopTurn(host: CodexTurnLifecycleHost): Promise<void> {
  const session = host.activeRunSession();
  const runId = host.activeRunId;
  host.cancelPendingTurn?.();
  host.pauseQueueForSession(session.id);
  if (!runId) return;
  if (!host.plugin.isPiProductionRun(runId)) return;
  host.clearTurnWatchdog();
  await host.plugin.cancelHarnessRun(runId);
  host.applyStatus();
}

export function armTurnWatchdog(host: CodexTurnLifecycleHost, timeoutMs = CHAT_TURN_WATCHDOG_MS, timeoutText?: string): void {
  armPausableTurnWatchdog(host.turnWatchdogOwner ?? host, () => {
    if (!host.running) return;
    const session = host.activeRunSession();
    const runId = host.activeRunId;
    if (!runId) return;
    if (host.plugin.isPiProductionRun(runId)) {
      const message = timeoutText ?? turnWatchdogTimeoutText(timeoutMs, host.plugin.settings.settingsLanguage);
      runErrors.record("desktop.watchdog", new Error(message), { code: "turn_no_progress_timeout", conversationId: session.id, runId });
      host.pauseQueueForSession(session.id);
      void host.plugin.recordTaskInterruption(session.id, "watchdog")
        .catch(error => console.error("Task interruption cause could not be saved", error))
        .then(() => host.plugin.cancelHarnessRun(runId))
        .catch((error) => console.error("Pi Chat timeout cancellation failed", error));
      host.applyStatus();
    }
  }, timeoutMs);
}

export function clearTurnWatchdog(host: CodexTurnLifecycleHost): void {
  clearPausableTurnWatchdog(host.turnWatchdogOwner ?? host);
}

export function clearActiveRun(host: CodexTurnLifecycleHost, clearMessageStoreActiveRun: () => void): void {
  host.activeRunId = "";
  host.activeRunKind = "";
  host.activeRunSessionId = "";
  host.activeTurnId = "";
  clearMessageStoreActiveRun();
}
