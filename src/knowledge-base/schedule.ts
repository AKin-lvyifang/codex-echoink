export interface KnowledgeBaseDailyScheduleState {
  enabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  lastRunAt: number;
  lastRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
  lastScheduledRunAt?: number;
  lastScheduledRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
  lastScheduledRunId?: string;
}

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
  const completedToday = lastScheduled
    && lastScheduled.toDateString() === now.toDateString()
    && (settings.lastScheduledRunStatus === "success" || settings.lastScheduledRunStatus === "canceled");
  if (completedToday) return false;
  // A durable running id is owned by startup recovery. Retrying it here could
  // launch a second Agent while the first workflow is committed or recoverable.
  if (
    settings.lastScheduledRunStatus === "running"
    && Boolean(settings.lastScheduledRunId?.trim())
  ) {
    return false;
  }
  if (forceCatchUp) return settings.catchUpOnStartup;
  if (schedulerStartedAt > scheduled.getTime() && !settings.catchUpOnStartup) return false;
  return true;
}

function scheduledTimeForToday(value: string, now: Date): Date | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const scheduled = new Date(now);
  scheduled.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return scheduled;
}
