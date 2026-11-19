/**
 * Local version records for cloud sync conflicts. When two devices edit the same passage, the newer edit wins and the
 * replaced content is kept here (never synced): at most 10 versions per note, 500 MB in all, oldest dropped first.
 */
export interface CloudHistoryFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface CloudHistoryVersion {
  readonly id: string;
  /** When this content was last edited on the device it came from (ms). */
  readonly editedAt: number;
  /** When it was replaced and recorded here (ms). */
  readonly savedAt: number;
  readonly deviceName: string;
  readonly size: number;
  readonly seen: boolean;
}
/** What the sync engine needs: record a replaced version. */
export interface CloudHistoryPort { add(path: string, bytes: Uint8Array, info: { editedAt: number; deviceName: string }): Promise<void> }

export const HISTORY_PER_FILE = 10;
export const HISTORY_TOTAL_BYTES = 500 * 1024 * 1024;
interface Index { version: 1; files: Record<string, CloudHistoryVersion[]> }

export class CloudSyncHistory implements CloudHistoryPort {
  private index: Index | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly fs: CloudHistoryFs, private readonly dir: string, private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async list(path: string): Promise<readonly CloudHistoryVersion[]> { return [...((await this.load()).files[path] ?? [])].sort((a, b) => b.savedAt - a.savedAt); }
  async hasUnseen(path: string): Promise<boolean> { return ((await this.load()).files[path] ?? []).some(v => !v.seen); }
  async read(id: string): Promise<Uint8Array> { return new Uint8Array(await this.fs.readBinary(this.blobPath(id))); }
  add(path: string, bytes: Uint8Array, info: { editedAt: number; deviceName: string }): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(), id = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      await this.ensureDir();
      await this.fs.writeBinary(this.blobPath(id), new Uint8Array(bytes).buffer);
      const list = index.files[path] ??= [];
      list.push({ id, editedAt: info.editedAt, savedAt: this.now(), deviceName: info.deviceName, size: bytes.length, seen: false });
      list.sort((a, b) => a.savedAt - b.savedAt);
      while (list.length > HISTORY_PER_FILE) await this.drop(list.shift()!);
      await this.trimTotal(index); await this.save();
    });
  }
  markSeen(path: string): Promise<void> {
    return this.serial(async () => {
      const list = (await this.load()).files[path]; if (!list?.some(v => !v.seen)) return;
      (await this.load()).files[path] = list.map(v => ({ ...v, seen: true })); await this.save();
    });
  }
  /** Follow renames so a note keeps its records. */
  rename(oldPath: string, newPath: string): Promise<void> {
    return this.serial(async () => {
      const index = await this.load(), list = index.files[oldPath]; if (!list) return;
      index.files[newPath] = [...(index.files[newPath] ?? []), ...list]; delete index.files[oldPath]; await this.save();
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> { const run = this.queue.then(work, work); this.queue = run.catch(() => undefined); return run; }
  private blobPath(id: string): string { return `${this.dir}/${id}.bin`; }
  private async ensureDir(): Promise<void> { if (!await this.fs.exists(this.dir)) await this.fs.mkdir(this.dir); }
  private async load(): Promise<Index> {
    if (this.index) return this.index;
    try {
      const path = `${this.dir}/index.json`;
      const parsed = await this.fs.exists(path) ? JSON.parse(await this.fs.read(path)) as Partial<Index> : null;
      this.index = parsed?.version === 1 && parsed.files && typeof parsed.files === "object" ? { version: 1, files: parsed.files } : { version: 1, files: {} };
    } catch { this.index = { version: 1, files: {} }; }
    return this.index;
  }
  private async save(): Promise<void> {
    await this.ensureDir(); await this.fs.write(`${this.dir}/index.json`, JSON.stringify(this.index));
    for (const listener of [...this.listeners]) listener();
  }
  private async drop(version: CloudHistoryVersion): Promise<void> { try { await this.fs.remove(this.blobPath(version.id)); } catch { /* already gone */ } }
  private async trimTotal(index: Index): Promise<void> {
    const all = Object.entries(index.files).flatMap(([path, list]) => list.map(v => ({ path, v }))).sort((a, b) => a.v.savedAt - b.v.savedAt);
    let total = all.reduce((sum, item) => sum + item.v.size, 0);
    for (const { path, v } of all) {
      if (total <= HISTORY_TOTAL_BYTES) break;
      index.files[path] = index.files[path].filter(item => item.id !== v.id); if (!index.files[path].length) delete index.files[path];
      total -= v.size; await this.drop(v);
    }
  }
}
