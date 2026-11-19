import { SYNC_CONVERSATION_MIGRATION_KEY, SYNC_CONVERSATION_MIGRATION_WINDOW_MS, SyncConversationWriter, type SyncConversationSource } from "./conversations";
import type { SyncDeviceStore } from "./device-store";
import type { SyncFs } from "./fs";

export interface SyncConversationExporterOptions {
  readonly fs: SyncFs;
  readonly device: SyncDeviceStore;
  /** Ids of every conversation on this device with its last update time; the exporter picks the recent ones. */
  readonly list: () => Promise<readonly { id: string; updatedAt: number }[]>;
  /** The full neutral record for one conversation; null when it no longer exists or has no user message. */
  readonly read: (id: string) => Promise<SyncConversationSource | null>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/** Runtime-neutral driver: a settled turn exports that conversation; the first start exports the last 30 days. */
export class SyncConversationExporter {
  readonly writer: SyncConversationWriter;
  private readonly now: () => number;
  constructor(private readonly options: SyncConversationExporterOptions) {
    this.now = options.now ?? (() => Date.now());
    this.writer = new SyncConversationWriter({ fs: options.fs, device: options.device, now: this.now });
  }
  async exportOne(id: string): Promise<void> {
    try {
      const source = await this.options.read(id);
      if (source) await this.writer.export(source);
    } catch (error) { this.options.onError?.(error); }
  }
  /** Re-entrant: an interrupted first export simply runs again next start; every file is rewritten or appended idempotently. */
  async migrate(): Promise<number> {
    const device = this.options.device;
    await device.open();
    if (device.migrationRecord(SYNC_CONVERSATION_MIGRATION_KEY)) return 0;
    const since = this.now() - SYNC_CONVERSATION_MIGRATION_WINDOW_MS;
    const recent = (await this.options.list()).filter(item => item.updatedAt >= since);
    let exported = 0;
    for (const item of recent) {
      const source = await this.options.read(item.id).catch(error => { this.options.onError?.(error); return null; });
      if (!source) continue;
      await this.writer.export(source);
      exported++;
    }
    await device.recordMigration(SYNC_CONVERSATION_MIGRATION_KEY, { fingerprint: `v1:${recent.length}`, completedAt: this.now() });
    return exported;
  }
}
