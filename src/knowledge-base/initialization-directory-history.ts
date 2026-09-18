import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface Position { original: string; current: string; identity: string }
interface DirectoryHistory {
  version: 1;
  createdAt: number;
  jobId: string;
  folders: string[];
  files: Position[];
  createdFolders: string[];
  pending: { from: string; to: string; identity: string } | null;
}
export interface DirectoryRestoreResult {
  restored: number;
  skipped: { path: string; reason: string }[];
}
export interface DirectoryHistoryHost {
  vaultRoot: string;
  privateRoot: string;
  mkdir(relativePath: string): Promise<void>;
  rename(from: string, to: string, restoring?: boolean): Promise<void>;
  removeEmptyFolder(relativePath: string): Promise<void>;
}

/** Position journal, never a content backup. Callers serialize all mutations. */
export class InitializationDirectoryHistory {
  constructor(private readonly host: DirectoryHistoryHost) {}
  private get indexPath(): string { return path.join(this.host.privateRoot, "knowledge/initialization/original-directory-index.json"); }

  private absolute(relative: string): string {
    if (!relative || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))) throw new Error("目录索引包含无效路径");
    return path.join(this.host.vaultRoot, ...relative.split("/"));
  }

  private async identity(relative: string): Promise<string | null> {
    const absolute = this.absolute(relative);
    let cursor = this.host.vaultRoot;
    for (const part of relative.split("/")) {
      cursor = path.join(cursor, part);
      const info = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) return null;
      if (info.isSymbolicLink()) throw new Error(`符号链接保持原位：${relative}`);
    }
    const stat = await fs.stat(absolute);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }

  private async read(): Promise<DirectoryHistory | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.indexPath, "utf8")) as DirectoryHistory;
      if (value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.folders) || !Array.isArray(value.createdFolders)) throw new Error("初始化目录索引损坏，未执行位置操作");
      for (const item of value.files) { this.absolute(item.original); this.absolute(item.current); if (typeof item.identity !== "string") throw new Error("目录索引身份无效"); }
      for (const folder of [...value.folders, ...value.createdFolders]) this.absolute(folder);
      if (value.pending) { this.absolute(value.pending.from); this.absolute(value.pending.to); }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async save(value: DirectoryHistory): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, this.indexPath);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async status(): Promise<{ createdAt: number; files: number } | null> {
    const record = await this.read();
    return record ? { createdAt: record.createdAt, files: record.files.length } : null;
  }

  async capture(jobId: string): Promise<void> {
    if (await this.read()) return; // Never replace the original with a later layout.
    const record: DirectoryHistory = { version: 1, createdAt: Date.now(), jobId, folders: [], files: [], createdFolders: [], pending: null };
    const walk = async (parent: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(this.host.vaultRoot, parent), { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
        const relative = parent ? `${parent}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { record.folders.push(relative); await walk(relative); }
        else if (entry.isFile() && !["agents.md", "llm-wiki.md"].includes(entry.name.toLowerCase())) {
          const identity = await this.identity(relative);
          if (!identity) throw new Error(`记录目录时文件消失：${relative}`);
          record.files.push({ original: relative, current: relative, identity });
        }
      }
    };
    await walk("");
    await this.save(record);
  }

  async createdFolder(relative: string): Promise<void> {
    const record = await this.read();
    if (!record || record.folders.includes(relative) || record.createdFolders.includes(relative)) return;
    this.absolute(relative);
    record.createdFolders.push(relative);
    await this.save(record);
  }

  private async applyMove(record: DirectoryHistory, from: string, to: string): Promise<void> {
    const rebase = (value: string) => value === from ? to : value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
    for (const item of record.files) {
      if (rebase(item.current) === item.current) continue;
      item.current = rebase(item.current);
      // A folder rename changes paths, not file identities. Never adopt a
      // replacement file created later at the same path as an original item.
    }
    record.createdFolders = record.createdFolders.map(rebase);
    // Bilingual folders made from original folders also belong to this operation.
    if (record.folders.includes(from) && !record.folders.includes(to) && !record.createdFolders.includes(to)) record.createdFolders.push(to);
    record.pending = null;
    await this.save(record);
  }

  private async recoverPending(record: DirectoryHistory): Promise<void> {
    const move = record.pending;
    if (!move) return;
    const source = await this.identity(move.from);
    const target = await this.identity(move.to);
    if (target === move.identity && source === null) await this.applyMove(record, move.from, move.to);
    else if (source === move.identity && target === null) { record.pending = null; await this.save(record); }
    else throw new Error(`上次移动位置无法确认，未猜测：${move.from} → ${move.to}`);
  }

  async rename(from: string, to: string, assertActive?: () => void): Promise<void> {
    const record = await this.read();
    if (record) await this.recoverPending(record);
    const identity = await this.identity(from);
    if (!identity) throw new Error(`源路径缺失：${from}`);
    if (await this.identity(to)) throw new Error(`原位置已被占用：${to}`);
    if (record) { record.pending = { from, to, identity }; await this.save(record); }
    assertActive?.();
    await this.host.rename(from, to);
    if (record) await this.applyMove(record, from, to);
  }

  async restore(onProgress: (message: string) => void = () => undefined): Promise<DirectoryRestoreResult> {
    const record = await this.read();
    if (!record) throw new Error("暂无初始化前目录记录");
    await this.recoverPending(record);
    const result: DirectoryRestoreResult = { restored: 0, skipped: [] };
    for (const folder of record.folders.sort((a, b) => a.split("/").length - b.split("/").length)) {
      try { await this.host.mkdir(folder); }
      catch (error) { result.skipped.push({ path: folder, reason: String(error) }); }
    }
    for (const item of record.files) {
      try {
        const current = await this.identity(item.current);
        if (!current || current !== item.identity) throw new Error(current ? "文件身份已变化，保留现状" : "文件缺失，未猜测新位置");
        if (item.current !== item.original) {
          if (await this.identity(item.original)) throw new Error("原位置已被占用，未覆盖");
          const parent = path.posix.dirname(item.original);
          if (parent !== ".") await this.host.mkdir(parent);
          const from = item.current;
          record.pending = { from, to: item.original, identity: current };
          await this.save(record);
          await this.host.rename(from, item.original, true);
          await this.applyMove(record, from, item.original);
          result.restored++;
        }
      } catch (error) {
        result.skipped.push({ path: item.original, reason: error instanceof Error ? error.message : String(error) });
        // Resolve a completed rename whose final journal write failed before proceeding.
        if (record.pending) await this.recoverPending(record);
      }
      onProgress(`已恢复 ${result.restored}，未恢复 ${result.skipped.length} / ${record.files.length}`);
    }
    for (const folder of [...record.createdFolders].sort((a, b) => b.split("/").length - a.split("/").length)) {
      if (record.folders.includes(folder)) continue;
      const children = await fs.readdir(this.absolute(folder)).catch(() => null);
      if (children?.length === 0) await this.host.removeEmptyFolder(folder);
    }
    return result;
  }
}
