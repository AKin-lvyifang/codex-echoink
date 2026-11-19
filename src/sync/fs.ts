import type { DataAdapter } from "obsidian";

/** The only Vault surface the sync layer touches; desktop and mobile both hand in `app.vault.adapter`. */
export type SyncFs = Pick<DataAdapter, "exists" | "read" | "write" | "append" | "mkdir" | "list" | "stat" | "remove">;

/** Creates every missing segment; mobile adapters do not always create parents. */
export async function ensureFolder(fs: SyncFs, folder: string): Promise<void> {
  const parts = folder.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!await fs.exists(current)) await fs.mkdir(current);
  }
}

/** Missing, half-synced or damaged files read as "not there yet"; the next scan tries again. */
export async function readJsonIfPresent(fs: SyncFs, path: string): Promise<unknown> {
  try {
    if (!await fs.exists(path)) return undefined;
    const text = await fs.read(path);
    return text.trim() ? JSON.parse(text) as unknown : undefined;
  } catch { return undefined; }
}

/** Writes, then reads back and compares; a sync tool must never see a file this device cannot itself read. */
export async function writeJsonVerified(fs: SyncFs, path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent) await ensureFolder(fs, parent);
  await fs.write(path, text);
  const back = await fs.read(path);
  if (back !== text) throw new Error(`同步数据未能保存（${path}）。请重试；如问题持续，请重新打开 EchoInk。`);
}

export async function listFolderNames(fs: SyncFs, folder: string): Promise<string[]> {
  try {
    if (!await fs.exists(folder)) return [];
    const listed = await fs.list(folder);
    return listed.folders.map(item => item.split("/").pop() ?? "").filter(Boolean).sort();
  } catch { return []; }
}

export async function listFileNames(fs: SyncFs, folder: string): Promise<string[]> {
  try {
    if (!await fs.exists(folder)) return [];
    const listed = await fs.list(folder);
    return listed.files.map(item => item.split("/").pop() ?? "").filter(Boolean).sort();
  } catch { return []; }
}

/** Sync tools name conflict copies `x 2.json`, `x.sync-conflict-…`; only the formal file name counts. */
export function isConflictCopy(fileName: string): boolean {
  return /\s\d+\.json$/u.test(fileName) || /sync-conflict/iu.test(fileName) || /\(conflict/iu.test(fileName);
}
