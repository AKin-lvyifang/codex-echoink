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

/** Count execution time only; replaying a pending projection cannot extend it. */
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

export function turnWatchdogTimeoutText(timeoutMs: number): string {
  const minutes = Math.max(1, Math.floor(timeoutMs / 60_000));
  return `这轮回复超过 ${minutes} 分钟没有完成，已停止等待。可以重试或重新连接 Codex。`;
}
