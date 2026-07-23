export interface KnowledgeBaseDailyScheduleState {
  enabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  lastRunAt: number;
  lastRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
  lastScheduledRunAt?: number;
  lastScheduledRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
  lastScheduledRunId?: string;
  scheduledAttemptCount?: number;
  scheduledNextRetryAt?: number;
}

export const SCHEDULED_MAINTENANCE_MAX_ATTEMPTS = 3;
const SCHEDULED_MAINTENANCE_RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  15 * 60 * 1000
] as const;

export function shouldRunScheduledKnowledgeBaseMaintenance(
  settings: KnowledgeBaseDailyScheduleState,
  now = new Date(),
  schedulerStartedAt = 0,
  forceCatchUp = false
): boolean {
  if (!settings.enabled) return false;
  const scheduled = scheduledTimeForToday(settings.scheduleTime, now);
  if (!scheduled || now.getTime() < scheduled.getTime()) return false;
  const lastScheduled = settings.lastScheduledRunAt ? new Date(settings.lastScheduledRunAt) : null;
  const attemptedToday = Boolean(
    lastScheduled
    && lastScheduled.toDateString() === now.toDateString()
  );
  if (
    attemptedToday
    && (
      settings.lastScheduledRunStatus === "success"
      || settings.lastScheduledRunStatus === "canceled"
    )
  ) {
    return false;
  }
  // A durable running id is owned by startup recovery. Retrying it here could
  // launch a second Agent while the first workflow is committed or recoverable.
  if (
    settings.lastScheduledRunStatus === "running"
    && Boolean(settings.lastScheduledRunId?.trim())
  ) {
    return false;
  }
  if (attemptedToday && settings.lastScheduledRunStatus === "failed") {
    const attemptCount = normalizedAttemptCount(
      settings.scheduledAttemptCount
    );
    const nextRetryAt = normalizedTimestamp(settings.scheduledNextRetryAt);
    if (
      attemptCount < 1
      || attemptCount >= SCHEDULED_MAINTENANCE_MAX_ATTEMPTS
      || nextRetryAt < 1
      || now.getTime() < nextRetryAt
    ) {
      return false;
    }
  }
  if (forceCatchUp) return settings.catchUpOnStartup;
  if (schedulerStartedAt > scheduled.getTime() && !settings.catchUpOnStartup) return false;
  return true;
}

export function scheduledMaintenanceRetryDelayMs(
  failedAttemptCount: number
): number | null {
  if (
    !Number.isSafeInteger(failedAttemptCount)
    || failedAttemptCount < 1
    || failedAttemptCount >= SCHEDULED_MAINTENANCE_MAX_ATTEMPTS
  ) {
    return null;
  }
  return SCHEDULED_MAINTENANCE_RETRY_DELAYS_MS[failedAttemptCount - 1] ?? null;
}

function scheduledTimeForToday(value: string, now: Date): Date | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const scheduled = new Date(now);
  scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return scheduled;
}

function normalizedAttemptCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) >= 0
    ? value ?? 0
    : 0;
}

function normalizedTimestamp(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) >= 0
    ? value ?? 0
    : 0;
}
