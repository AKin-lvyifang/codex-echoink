export const CHAT_TURN_WATCHDOG_MS = 5 * 60 * 1000;

export interface TurnWatchdogOwner {
  turnWatchdog: number | null;
}

interface TurnWatchdogState {
  waiting: boolean;
  remainingMs: number;
  startedAt: number;
  onTimeout?: () => void;
}

const watchdogStates = new WeakMap<TurnWatchdogOwner, TurnWatchdogState>();

/** Count time without progress; real runtime events re-arm this pausable timer. */
export function armPausableTurnWatchdog(
  owner: TurnWatchdogOwner,
  onTimeout: () => void,
  timeoutMs = CHAT_TURN_WATCHDOG_MS
): void {
  const waiting = watchdogStates.get(owner)?.waiting ?? false;
  clearPausableTurnWatchdog(owner);
  const state: TurnWatchdogState = { waiting, remainingMs: timeoutMs, startedAt: 0, onTimeout };
  watchdogStates.set(owner, state);
  if (!waiting) startTimer(owner, state);
}

export function setTurnWatchdogWaiting(owner: TurnWatchdogOwner, waiting: boolean): void {
  const state = watchdogStates.get(owner);
  if (!state) {
    if (waiting) watchdogStates.set(owner, { waiting, remainingMs: 0, startedAt: 0 });
    return;
  }
  if (state.waiting === waiting) return;
  state.waiting = waiting;
  if (waiting) {
    if (owner.turnWatchdog !== null) {
      window.clearTimeout(owner.turnWatchdog);
      owner.turnWatchdog = null;
      state.remainingMs = Math.max(0, state.remainingMs - Math.max(0, Date.now() - state.startedAt));
    }
  } else if (state.onTimeout) {
    startTimer(owner, state);
  }
}

export function clearPausableTurnWatchdog(owner: TurnWatchdogOwner): void {
  if (owner.turnWatchdog !== null) window.clearTimeout(owner.turnWatchdog);
  owner.turnWatchdog = null;
  watchdogStates.delete(owner);
}

function startTimer(owner: TurnWatchdogOwner, state: TurnWatchdogState): void {
  state.startedAt = Date.now();
  owner.turnWatchdog = window.setTimeout(() => {
    if (watchdogStates.get(owner) !== state || state.waiting) return;
    owner.turnWatchdog = null;
    watchdogStates.delete(owner);
    state.onTimeout?.();
  }, state.remainingMs);
}

export function turnWatchdogTimeoutText(timeoutMs: number, language = "zh-CN"): string {
  const minutes = Math.max(1, Math.floor(timeoutMs / 60_000));
  return language === "en"
    ? `Agent has made no progress for ${minutes} ${minutes === 1 ? "minute" : "minutes"} and has stopped. Click Continue to retry.`
    : `Agent 已经 ${minutes} 分钟没有任何进展，已停止。可以点继续重试。`;
}
export function isTurnWatchdogProgressEvent(event: Readonly<{ type: string; textDelta?: string }>): boolean {
  switch (event.type) {
    case "message_update":
    case "provider_reasoning_delta":
      return (event.textDelta?.length ?? 0) > 0;
    case "model_progress":
    case "message_start":
    case "message_end":
    case "provider_reasoning_start":
    case "provider_reasoning_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "knowledge_progress":
    case "memory_recall_progress":
    case "generation_progress":
    case "compaction_start":
    case "compaction_end":
    case "interaction_requested":
    case "interaction_resolved":
      return true;
    default:
      return false;
  }
}
