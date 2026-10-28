import type { TaskResumeSafetySnapshot } from "../plugin/task-resume-safety";

export const TASK_INTERRUPTION_REASONS = [
  "app_closed", "user_stopped", "plugin_disabled", "run_failed", "process_unknown", "watchdog"
] as const;
export type TaskInterruptionReason = typeof TASK_INTERRUPTION_REASONS[number];

/** Saved on the ProductRun. Absence on old runs means the cause was not recorded. */
export interface TaskInterruptionRecord {
  readonly at: number;
  readonly reason: TaskInterruptionReason;
  readonly stage: string;
  readonly detail?: string;
  /** Actual SDK retry count; absent means no retry exhaustion was observed. */
  readonly retryAttempts?: number;
}
export interface TaskInterruptionInfo extends TaskInterruptionRecord {
  readonly taskId: string;
  /** Derived from current policy, never a fifth persisted task state. */
  readonly failureMessage?: string;
  readonly resumeBlocked?: boolean;
  readonly uncertainOperations: readonly { readonly id: string; readonly label: string }[];
}
/** Per-run recovery facts; never reused as the next ordinary turn's policy. */
export interface TaskResumeContext {
  readonly safety: TaskResumeSafetySnapshot;
  readonly interruption: TaskInterruptionRecord;
}

export function latestTaskRun<T extends { createdAt: number; updatedAt: number }>(runs: readonly T[]): T | undefined {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0];
}
