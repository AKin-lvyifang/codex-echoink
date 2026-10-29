import type { DiaryOrganizerEngine } from "./engine";

export interface DiaryOrganizerSchedulerOptions { startupMs?: number; intervalMs?: number; onError?: (error: unknown) => void }

/** Desktop-only lifecycle belongs to the host. Each check is serialized by the engine. */
export class DiaryOrganizerScheduler {
  private timer: ReturnType<typeof window.setTimeout> | null = null;
  private started = false;

  constructor(private readonly engine: DiaryOrganizerEngine, private readonly options: DiaryOrganizerSchedulerOptions = {}) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.options.startupMs ?? 120000);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.engine.runOnce().catch(error => this.options.onError?.(error)).finally(() => {
        if (this.started) this.schedule(this.options.intervalMs ?? 30 * 60 * 1000);
      });
    }, delay);
  }
}
