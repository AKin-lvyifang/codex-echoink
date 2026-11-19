import type { SyncFs } from "../sync/fs";

/** Disposable in-memory Vault adapter shared by several "devices" in one test. Never touches a real Vault. */
export class FakeSyncVault implements SyncFs {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** Set to throw on the next writes; simulates a sync tool or disk failure. */
  failWrites = 0;
  readonly writes: string[] = [];
  exists(path: string): Promise<boolean> {
    return Promise.resolve(!path || this.files.has(path) || this.folders.has(path) || [...this.files.keys()].some(key => key.startsWith(`${path}/`)));
  }
  read(path: string): Promise<string> { const text = this.files.get(path); if (text === undefined) return Promise.reject(new Error(`Missing ${path}`)); return Promise.resolve(text); }
  write(path: string, data: string): Promise<void> {
    if (this.failWrites > 0) { this.failWrites--; return Promise.reject(new Error("disk full")); }
    this.writes.push(path); this.files.set(path, data); return Promise.resolve();
  }
  append(path: string, data: string): Promise<void> {
    if (this.failWrites > 0) { this.failWrites--; return Promise.reject(new Error("disk full")); }
    this.writes.push(path); this.files.set(path, (this.files.get(path) ?? "") + data); return Promise.resolve();
  }
  mkdir(path: string): Promise<void> { this.folders.add(path); return Promise.resolve(); }
  remove(path: string): Promise<void> { this.files.delete(path); return Promise.resolve(); }
  rmdir(path: string, recursive: boolean): Promise<void> {
    const prefix = `${path}/`;
    if (!recursive && ([...this.files.keys()].some(k => k.startsWith(prefix)) || [...this.folders].some(f => f.startsWith(prefix)))) return Promise.reject(new Error(`Folder not empty: ${path}`));
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(prefix)) this.folders.delete(folder);
    return Promise.resolve();
  }
  stat(path: string): Promise<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null> {
    const text = this.files.get(path);
    if (text !== undefined) return Promise.resolve({ type: "file", ctime: 0, mtime: 0, size: text.length });
    return this.exists(path).then(present => present ? { type: "folder" as const, ctime: 0, mtime: 0, size: 0 } : null);
  }
  list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = path ? `${path}/` : "", files: string[] = [], folders = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]); else files.push(key);
    }
    for (const folder of this.folders) if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes("/")) folders.add(folder);
    return Promise.resolve({ files, folders: [...folders] });
  }
  json(path: string): unknown { const text = this.files.get(path); return text === undefined ? undefined : JSON.parse(text); }
}
