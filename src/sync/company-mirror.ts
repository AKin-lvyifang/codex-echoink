import { normalizeCompanyDocument } from "../company/logic";
import type { CompanyRecordStore } from "../company/service";
import type { CompanyDispatch, CompanyDocument, CompanyProject } from "../company/types";
import type { SyncDeviceStore } from "./device-store";
import { SYNC_SCHEMA, windowTimers, type SyncCompanyArchivePayload, type SyncCompanyPayload, type SyncTimers } from "./types";

const TERMINAL = new Set<CompanyDispatch["status"]>(["done", "failed", "stopped"]);
const FINISHED = new Set<CompanyProject["status"]>(["done", "cancelled"]);
export const COMPANY_MIGRATION_KEY = "company";

/** The part of the record other devices need to see: unfinished projects and loose dispatches. */
export function activeCompanyPayload(doc: CompanyDocument, deviceId: string): SyncCompanyPayload {
  const projects = doc.projects.filter(p => !FINISHED.has(p.status) && owned(p, deviceId));
  const projectIds = new Set(projects.map(p => p.id));
  const dispatches = doc.dispatches.filter(d => owned(d, deviceId) && (d.projectId ? projectIds.has(d.projectId) : !TERMINAL.has(d.status)));
  const events = doc.events.filter(e => projectIds.has(e.projectId));
  return { projects, dispatches, events };
}
export function archivedCompanyPayload(doc: CompanyDocument, project: CompanyProject): SyncCompanyArchivePayload {
  return { project, dispatches: doc.dispatches.filter(d => d.projectId === project.id), events: doc.events.filter(e => e.projectId === project.id) };
}
const owned = (item: { ownerDeviceId?: string }, deviceId: string) => !item.ownerDeviceId || item.ownerDeviceId === deviceId;
/** Changes to the source that matter for the mirror, independent of key order or timestamps the mirror adds. */
export function companyFingerprint(doc: CompanyDocument): string {
  const normalized = normalizeCompanyDocument(doc);
  return `${normalized.projects.length}:${normalized.dispatches.length}:${normalized.events.length}:${JSON.stringify(normalized.projects.map(p => [p.id, p.status, p.endedAt ?? 0]))}`;
}

export interface CompanySyncMirrorOptions {
  readonly device: SyncDeviceStore;
  readonly store: Pick<CompanyRecordStore, "snapshot" | "subscribe">;
  readonly now?: () => number;
  /** Debounce for follow-up exports after the first one; tests pass 0. */
  readonly debounceMs?: number;
  readonly timers?: SyncTimers;
  readonly onError?: (error: unknown) => void;
}

export type CompanySyncMirrorStart = Readonly<{ status: "ready"; migrated: boolean } | { status: "failed"; error: unknown }>;

/**
 * Copies this device's company record into its own sync folder. The runtime store stays the source of truth
 * and keeps its old file, so turning the mirror off loses nothing.
 */
export class CompanySyncMirror {
  private unsubscribe?: () => void;
  private timer: number | null = null;
  private readonly timers: SyncTimers;
  private flight: Promise<void> = Promise.resolve();
  private pending = false;
  private lastActive = "";
  private readonly archived = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly options: CompanySyncMirrorOptions) { this.now = options.now ?? (() => Date.now()); this.timers = options.timers ?? windowTimers(); }
  get deviceId(): string { return this.options.device.deviceId; }

  /** Migration is the first full export; it is re-entrant because every file is rewritten whole and verified. */
  async start(): Promise<CompanySyncMirrorStart> {
    try {
      const device = this.options.device;
      await device.open();
      const doc = this.options.store.snapshot();
      const fingerprint = companyFingerprint(doc);
      const previous = device.migrationRecord(COMPANY_MIGRATION_KEY);
      const migrated = !previous || previous.fingerprint !== fingerprint;
      await this.export(doc, true);
      if (migrated) await device.recordMigration(COMPANY_MIGRATION_KEY, { fingerprint, completedAt: this.now() });
      this.unsubscribe = this.options.store.subscribe(() => this.schedule());
      return { status: "ready", migrated };
    } catch (error) {
      this.stop();
      return { status: "failed", error };
    }
  }
  stop(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
  }
  /** Waits for every scheduled export; tests and shutdown use it. */
  async flush(): Promise<void> {
    if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; this.pending = true; }
    if (this.pending) await this.run();
    await this.flight;
  }

  private schedule(): void {
    this.pending = true;
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.run(); }, this.options.debounceMs ?? 300);
  }
  private run(): Promise<void> {
    this.flight = this.flight.then(async () => {
      if (!this.pending) return;
      this.pending = false;
      try { await this.export(this.options.store.snapshot(), false); }
      catch (error) { this.options.onError?.(error); }
    });
    return this.flight;
  }
  private async export(doc: CompanyDocument, force: boolean): Promise<void> {
    const device = this.options.device;
    for (const project of doc.projects.filter(p => FINISHED.has(p.status) && owned(p, device.deviceId))) {
      const stamp = project.endedAt ?? 0;
      if (this.archived.get(project.id) === stamp) continue;
      const relative = `company-archive/${project.id}.json`;
      if (!force && await device.exists(relative)) { this.archived.set(project.id, stamp); continue; }
      await device.write(relative, SYNC_SCHEMA.companyArchive, archivedCompanyPayload(doc, project));
      this.archived.set(project.id, stamp);
    }
    const active = activeCompanyPayload(doc, device.deviceId);
    const key = JSON.stringify(active);
    if (!force && key === this.lastActive) return;
    await device.write("company.json", SYNC_SCHEMA.company, active);
    this.lastActive = key;
  }
}
