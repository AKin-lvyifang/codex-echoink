import { envelope, parseEnvelope } from "./envelope";
import { ensureFolder, readJsonIfPresent, writeJsonVerified, type SyncFs } from "./fs";
import { SYNC_FORMAT_VERSION, SYNC_README, SYNC_ROOT, SYNC_SCHEMA, deviceDir, isSyncDeviceId, type SyncDeviceKind, type SyncDevicePayload, type SyncEnvelope, type SyncMigrationRecord } from "./types";

const README_TEXT = "# EchoInk 同步数据\n\nEchoInk 自动维护这个文件夹：每台设备只写自己的 `devices/<设备>/`，读所有设备的。请不要手动修改或删除其中的文件。\n";
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function parseDevicePayload(raw: unknown): SyncDevicePayload | null {
  const r = rec(raw);
  if (!r || typeof r.name !== "string" || !["desktop", "phone", "tablet"].includes(r.kind as string)) return null;
  if (typeof r.lastSeenAt !== "number" || typeof r.rev !== "number" || !Number.isSafeInteger(r.rev) || r.rev < 0) return null;
  const migration: Record<string, SyncMigrationRecord> = {};
  for (const [key, value] of Object.entries(rec(r.migration) ?? {})) {
    const m = rec(value);
    if (m && typeof m.fingerprint === "string" && typeof m.completedAt === "number") migration[key] = { fingerprint: m.fingerprint, completedAt: m.completedAt };
  }
  return { name: r.name.slice(0, 80), kind: r.kind as SyncDeviceKind, formatVersion: SYNC_FORMAT_VERSION, lastSeenAt: r.lastSeenAt, rev: r.rev, ...(Object.keys(migration).length ? { migration } : {}) };
}

export interface SyncDeviceStoreOptions {
  readonly fs: SyncFs;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceKind: SyncDeviceKind;
  readonly now?: () => number;
}

/**
 * The single writer for `devices/<deviceId>/`. Every file it writes carries this device's id and the next rev.
 * Nothing here ever writes into another device's folder.
 */
export class SyncDeviceStore {
  readonly deviceId: string;
  readonly dir: string;
  private rev = 0;
  private migration: Record<string, SyncMigrationRecord> = {};
  private opened = false;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly options: SyncDeviceStoreOptions) {
    if (!isSyncDeviceId(options.deviceId)) throw new Error("同步设备信息无效。请点击“上报问题”。");
    this.deviceId = options.deviceId;
    this.dir = deviceDir(options.deviceId);
    this.now = options.now ?? (() => Date.now());
  }
  get currentRev(): number { return this.rev; }
  path(relative: string): string { return `${this.dir}/${relative}`; }

  /** Creates the folder and restores the rev counter from device.json; writes the first heartbeat. */
  async open(): Promise<void> {
    if (this.opened) return;
    const fs = this.options.fs;
    await ensureFolder(fs, this.dir);
    if (!await fs.exists(SYNC_README)) { try { await fs.write(SYNC_README, README_TEXT); } catch { /* README is a courtesy, not data. */ } }
    const existing = parseEnvelope(await readJsonIfPresent(fs, this.path("device.json")), SYNC_SCHEMA.device, parseDevicePayload);
    if (existing && existing.deviceId === this.deviceId) { this.rev = Math.max(existing.rev, existing.payload.rev); this.migration = { ...existing.payload.migration }; }
    this.opened = true;
    await this.heartbeat();
  }

  migrationRecord(key: string): SyncMigrationRecord | undefined { return this.migration[key]; }
  async recordMigration(key: string, record: SyncMigrationRecord): Promise<void> {
    this.migration = { ...this.migration, [key]: record };
    await this.heartbeat();
  }

  /** Writes one payload file under this device's folder with the next rev, then refreshes device.json. */
  write<T>(relative: string, schema: string, payload: T): Promise<SyncEnvelope<T>> {
    return this.serialize(async () => {
      if (!this.opened) throw new Error("同步数据文件夹尚未打开。请重试；如问题持续，请重新打开 EchoInk。");
      const next = this.rev + 1;
      const record = envelope(schema, this.deviceId, next, this.now(), payload);
      await writeJsonVerified(this.options.fs, this.path(relative), record);
      this.rev = next;
      await this.writeDevice();
      return record;
    });
  }
  async exists(relative: string): Promise<boolean> { return this.options.fs.exists(this.path(relative)); }
  heartbeat(): Promise<void> { return this.serialize(() => this.writeDevice()); }

  private async writeDevice(): Promise<void> {
    const payload: SyncDevicePayload = { name: this.options.deviceName, kind: this.options.deviceKind, formatVersion: SYNC_FORMAT_VERSION, lastSeenAt: this.now(), rev: this.rev,
      ...(Object.keys(this.migration).length ? { migration: this.migration } : {}) };
    await writeJsonVerified(this.options.fs, this.path("device.json"), envelope(SYNC_SCHEMA.device, this.deviceId, this.rev, this.now(), payload));
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writing.then(work, work);
    this.writing = run.catch(() => undefined);
    return run;
  }
}

export { SYNC_ROOT };
