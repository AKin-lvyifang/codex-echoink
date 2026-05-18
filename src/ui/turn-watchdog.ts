export const CHAT_TURN_WATCHDOG_MS = 5 * 60 * 1000;

export function turnWatchdogTimeoutForSession(isKnowledgeBaseSession: boolean, fallbackMs = CHAT_TURN_WATCHDOG_MS): number | null {
  return isKnowledgeBaseSession ? null : fallbackMs;
}

export function turnWatchdogTimeoutText(timeoutMs: number): string {
  const minutes = Math.max(1, Math.floor(timeoutMs / 60_000));
  return `这轮回复超过 ${minutes} 分钟没有完成，已停止等待。可以重试或重新连接 Codex。`;
}
