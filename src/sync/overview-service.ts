import type { CompanyDocument } from "../company/types";
import { EMPTY_SYNC_OVERVIEW, readSyncCompanyOverview, type RemoteCompanyProject, type SyncCompanyOverview } from "./company-view";
import type { SyncFs } from "./fs";
import { SYNC_ROOT, windowTimers, type SyncTimers } from "./types";

export interface SyncOverviewServiceOptions {
  readonly fs: SyncFs;
  readonly deviceId: string;
  readonly now?: () => number;
  /** Periodic rescan as a fallback for sync tools whose changes raise no Vault event. */
  readonly refreshMs?: number;
  readonly debounceMs?: number;
  readonly timers?: SyncTimers;
  readonly onError?: (error: unknown) => void;
}

/** Cached read-only view of the other devices' folders. Nothing here is ever written or executed. */
export class SyncOverviewService {
  private overview: SyncCompanyOverview = EMPTY_SYNC_OVERVIEW;
  private readonly listeners = new Set<() => void>();
  private flight: Promise<void> | null = null;
  private again = false;
  private timer: number | null = null;
  private interval: number | null = null;
  private signature = "";
  private readonly timers: SyncTimers;
  constructor(private readonly options: SyncOverviewServiceOptions) { this.timers = options.timers ?? windowTimers(); }
  get deviceId(): string { return this.options.deviceId; }
  snapshot(): SyncCompanyOverview { return this.overview; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  remoteProject(projectId: string, deviceId?: string): RemoteCompanyProject | undefined {
    return this.overview.projects.find(p => p.id === projectId && (!deviceId || p.deviceId === deviceId));
  }
  docOf(deviceId: string): CompanyDocument | undefined { return this.overview.docs[deviceId]; }
  deviceName(deviceId: string): string { return this.overview.devices.find(d => d.id === deviceId)?.name ?? deviceId; }

  start(): void {
    if (this.interval !== null) return;
    this.interval = this.timers.setInterval(() => { void this.refresh(); }, this.options.refreshMs ?? 60_000);
    void this.refresh();
  }
  stop(): void {
    if (this.interval !== null) { this.timers.clearInterval(this.interval); this.interval = null; }
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    this.listeners.clear();
  }
  /** Vault events for paths under the sync folder coalesce into one rescan. */
  noteVaultChange(path: string): void {
    if (!path.startsWith(`${SYNC_ROOT}/`)) return;
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.refresh(); }, this.options.debounceMs ?? 500);
  }
  refresh(): Promise<void> {
    if (this.flight) { this.again = true; return this.flight; }
    this.flight = (async () => {
      do {
        this.again = false;
        try {
          const next = await readSyncCompanyOverview(this.options.fs, this.options.deviceId, this.options.now?.() ?? Date.now());
          const signature = JSON.stringify(next);
          if (signature !== this.signature) { this.signature = signature; this.overview = next; for (const listener of [...this.listeners]) listener(); }
        } catch (error) { this.options.onError?.(error); }
      } while (this.again);
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}
