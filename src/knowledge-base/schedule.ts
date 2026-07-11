export interface KnowledgeBaseDailyScheduleState {
  enabled: boolean;
  scheduleEnabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  lastRunAt: number;
  lastRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
  lastScheduledRunAt?: number;
  lastScheduledRunStatus?: "idle" | "running" | "success" | "failed" | "canceled";
}

export function shouldRunScheduledKnowledgeBaseMaintenance(
  settings: KnowledgeBaseDailyScheduleState,
  now = new Date(),
  schedulerStartedAt = 0,
  forceCatchUp = false
): boolean {
  if (!settings.enabled || !settings.scheduleEnabled) return false;
  const scheduled = scheduledTimeForToday(settings.scheduleTime, now);
  if (!scheduled || now.getTime() < scheduled.getTime()) return false;
  const lastScheduled = settings.lastScheduledRunAt ? new Date(settings.lastScheduledRunAt) : null;
  if (lastScheduled && lastScheduled.toDateString() === now.toDateString()) return false;
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
