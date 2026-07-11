import type { KnowledgeBaseSettings } from "../settings/settings";
import { shouldRunScheduledKnowledgeBaseMaintenance } from "./schedule";
import type { KnowledgeBaseRunResult } from "./types";

export interface KnowledgeBaseSchedulerHost {
  getSettings(): KnowledgeBaseSettings;
  isRunning(): boolean;
  registerInterval(intervalId: number): void;
  runMaintenance(): Promise<KnowledgeBaseRunResult>;
  appendScheduledMaintenanceMessage(result: KnowledgeBaseRunResult): Promise<void>;
  refreshKnowledgeBaseSurfaces(): void;
}

export class KnowledgeBaseScheduler {
  private scheduleTimer: number | null = null;
  private schedulerStartedAt = 0;

  constructor(private readonly host: KnowledgeBaseSchedulerHost) {}

  start(): void {
    this.schedulerStartedAt = Date.now();
    this.armSchedule();
    void this.runCatchUpIfNeeded();
  }

  unload(): void {
    if (!this.scheduleTimer) return;
    window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  async runScheduledIfDue(forceCatchUp = false): Promise<void> {
    const settings = this.host.getSettings();
    if (this.host.isRunning()) return;
    if (!shouldRunScheduledKnowledgeBaseMaintenance(settings, new Date(), this.schedulerStartedAt, forceCatchUp)) return;

    const scheduledStartedAt = Date.now();
    settings.lastScheduledRunAt = scheduledStartedAt;
    settings.lastScheduledRunStatus = "running";
    const result = await this.host.runMaintenance();
    settings.lastScheduledRunAt = scheduledStartedAt;
    settings.lastScheduledRunStatus = result.status;
    await this.host.appendScheduledMaintenanceMessage(result);
    this.host.refreshKnowledgeBaseSurfaces();
  }

  private armSchedule(): void {
    if (this.scheduleTimer) window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = window.setInterval(() => void this.runScheduledIfDue(), 60 * 1000);
    this.host.registerInterval(this.scheduleTimer);
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    if (!this.host.getSettings().catchUpOnStartup) return;
    await this.runScheduledIfDue(true);
  }
}
