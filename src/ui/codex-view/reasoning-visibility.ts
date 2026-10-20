interface ReasoningDisplayState {
  readonly status: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
}

/** UI titles and duration summaries are never public reasoning content. */
export function shouldDisplayReasoning(state: ReasoningDisplayState, readableText: string): boolean {
  if (state.status === "running") return true;
  const duration = state.durationMs ?? Math.max(0, (state.completedAt ?? state.updatedAt) - state.startedAt);
  return Boolean(readableText.trim()) || duration >= 2_000;
}
