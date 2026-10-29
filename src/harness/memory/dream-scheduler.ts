/**
 * dream-scheduler.ts — production dream scheduler (做梦 PRD §4).
 *
 * - Created once by the plugin when it starts; disposed with the plugin.
 * - 60s heartbeat checks whether the next daily slot is due.
 * - Default 3 runs/day; interval = 24h / runsPerDay.
 * - Toggle / runs-per-day changes apply immediately — no restart needed.
 * - Dreaming pauses while a foreground Provider request is running (deferred,
 *   never cancelled).
 * - The scheduler itself never calls the LLM; DreamEngine does the work.
 */

import type { DreamEngine, DreamRunResult } from "./dream-engine";

export interface DreamSchedulerConfig {
  readonly enabled: boolean;
  readonly runsPerDay: number;
}

export const DEFAULT_DREAM_RUNS_PER_DAY = 3;

const HEARTBEAT_MS = 60_000;
const DAY_MS = 86_400_000;

export interface DreamSchedulerDeps {
  readonly engine: DreamEngine;
  /** Live settings — read on every heartbeat, so toggles apply without restart. */
  readonly getConfig: () => DreamSchedulerConfig;
  /** True while a foreground chat/Provider request is in flight. */
  readonly isForegroundBusy: () => boolean;
  /** Last successful/started run timestamp from dream-state (0 = never). */
  readonly readLastRunAt: () => Promise<number>;
  /** Register the heartbeat interval with the plugin lifecycle. */
  readonly registerInterval: (handle: number) => void;
  readonly now?: () => number;
}

export class DreamScheduler {
  private timer: number | null = null;
  private checking = false;
  private disposed = false;
  lastResult: DreamRunResult | null = null;
  /** Test/diagnostic hook, called after every completed run. */
  onRunFinished: ((result: DreamRunResult) => void) | null = null;

  constructor(private readonly deps: DreamSchedulerDeps) {}

  get active(): boolean {
    return this.timer !== null;
  }

  /** Start the heartbeat. Idempotent. */
  start(): void {
    if (this.disposed || this.timer !== null) return;
    const handle = window.setInterval(() => {
      void this.tick();
    }, HEARTBEAT_MS);
    this.timer = handle;
    this.deps.registerInterval(handle);
  }

  /** Stop the heartbeat (dreaming off or plugin unloading). */
  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /** Whether a run is due right now given the configured runs/day. */
  async isDue(nowInput?: number): Promise<boolean> {
    const config = this.deps.getConfig();
    if (!config.enabled) return false;
    const runsPerDay = normalizeRunsPerDay(config.runsPerDay);
    const lastRunAt = await this.deps.readLastRunAt();
    if (lastRunAt <= 0) return true;
    const now = nowInput ?? this.now();
    return now - lastRunAt >= DAY_MS / runsPerDay;
  }

  /** Heartbeat step: run when enabled, due, and the foreground is idle. */
  async tick(): Promise<void> {
    if (this.disposed || this.checking) return;
    this.checking = true;
    try {
      const config = this.deps.getConfig();
      if (!config.enabled) return;
      if (this.deps.isForegroundBusy()) return; // 延后，不打断前台请求
      if (this.deps.engine.isRunning) return;
      if (!(await this.isDue())) return;
      // A reset may stop/dispose the scheduler while the due check reads disk.
      if (this.disposed || !this.deps.getConfig().enabled
        || this.deps.isForegroundBusy() || this.deps.engine.isRunning) return;
      const result = await this.deps.engine.runOnce();
      this.lastResult = result;
      this.onRunFinished?.(result);
    } catch {
      // A failed round keeps pending state intact; the next heartbeat retries.
    } finally {
      this.checking = false;
    }
  }

  /**
   * Manual trigger (e.g. diagnostics). Respects the same gates as the
   * heartbeat: dreaming off / long-term memory off / learning off / busy.
   */
  async forceRun(): Promise<DreamRunResult | null> {
    if (this.disposed || this.checking || this.deps.engine.isRunning) return null;
    if (!this.deps.getConfig().enabled) return null;
    if (this.deps.isForegroundBusy()) return null;
    const result = await this.deps.engine.runOnce();
    this.lastResult = result;
    this.onRunFinished?.(result);
    return result;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

export function normalizeRunsPerDay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DREAM_RUNS_PER_DAY;
  return Math.max(1, Math.min(6, Math.round(value)));
}
