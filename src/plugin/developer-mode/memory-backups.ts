import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { cognitiveAtomicWrite } from "../../harness/memory/cognitive-file-utils";
import { parseSecondaryRecord } from "../../harness/memory/secondary-memory-store";
import { parsePersonalMemoryRecord } from "../../harness/memory/personal-memory-repository";

const { randomUUID } = getDesktopCrypto();

const fs = getDesktopFsPromises();
const path = getDesktopPath();

const FIXED = [
  "agents/echoink/AGENT.md", "agents/echoink/agent-self-meta.json",
  "shared-user/USER.md", "shared-user/MEMORY.md", "shared-user/user-profile-state.json",
  ...["manifest.json", "search-index.json", "source-map.json", "audit.jsonl", "dream-state.json", "dream-experience-inbox.json"]
    .map((name) => `shared-user/.runtime/${name}`)
] as const;
const LEGACY_AGENT_FILES = new Set<string>(FIXED.slice(0, 2));
const PRIMARY = /^shared-user\/memory\/(facts|views|decisions|active|episodes)\/[a-zA-Z0-9_-]{3,96}\.md$/u;
const SECONDARY = /^shared-user\/memory\/secondary\/[a-zA-Z0-9_-]{3,96}\/[a-zA-Z0-9_-]{3,96}\.md$/u;
const FORGOTTEN = /^shared-user\/\.runtime\/backups\/(forgets|source-deletions)\/[a-zA-Z0-9_-]{3,96}-\d+\.md$/u;
const SNAPSHOT_NAME = /^(reset|restore)-\d+-[a-f0-9-]+\.json$/u;
type Files = Record<string, string | null>;
interface Snapshot { schema: "echoink.developer-memory-backup.v1"; action: "reset" | "restore"; at: number; files: Files }
interface Journal { schema: "echoink.developer-memory-change.v1"; before: string; paths: string[]; committed: boolean }
export interface DeveloperMemoryChange { backup: string; preservedLearningConflicts: number }

/** Bounded file transaction for the current Memory store only. Never deletes a directory. */
export class MemoryDeveloperBackups {
  readonly directory: string;
  private readonly journal: string;

  constructor(readonly memoryRoot: string, private readonly io: {
    atomicWrite: typeof cognitiveAtomicWrite;
  } = { atomicWrite: cognitiveAtomicWrite }) {
    this.directory = path.join(path.dirname(memoryRoot), "developer-backups");
    this.journal = path.join(this.directory, "active-change.json");
  }

  async latestResetPath(): Promise<string | null> {
    await this.safePath(this.directory);
    const names = await fs.readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const latest = names.filter((name) => SNAPSHOT_NAME.test(name) && name.startsWith("reset-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
    return latest ? path.join(this.directory, latest) : null;
  }

  /** Called before the Repository opens, so recovery cannot race its watchers. */
  async recoverInterruptedChange(): Promise<void> {
    await this.safePath(this.journal);
    const raw = await this.readOptional(this.journal);
    if (raw === null) return;
    const journal = JSON.parse(raw.toString("utf8")) as Journal;
    if (journal.schema !== "echoink.developer-memory-change.v1"
      || !SNAPSHOT_NAME.test(journal.before) || !Array.isArray(journal.paths)
      || typeof journal.committed !== "boolean") throw new Error("developer_backup_journal_invalid");
    for (const name of journal.paths) this.assertMemoryFile(name);
    if (!journal.committed) {
      const before = await this.readSnapshot(path.join(this.directory, journal.before));
      await this.apply(before.files, journal.paths);
    }
    await fs.unlink(this.journal);
  }

  async change(action: "reset" | "restore", validateReopen: () => Promise<void>): Promise<DeveloperMemoryChange> {
    await this.recoverInterruptedChange();
    const restorePath = action === "restore" ? await this.latestResetPath() : null;
    if (action === "restore" && !restorePath) throw new Error("developer_backup_missing");
    const restore = restorePath ? await this.readSnapshot(restorePath) : null;
    const current = await this.capture();
    const next: Files = restore ? { ...restore.files } : {};
    if (restore) {
      // User Memory restore must not restore a stale hash for the legacy Agent
      // files that remain in place, including edits made from mobile after reset.
      const manifestPath = "shared-user/.runtime/manifest.json";
      const live: unknown = JSON.parse(Buffer.from(current[manifestPath] ?? "", "base64").toString("utf8"));
      const saved: unknown = JSON.parse(Buffer.from(next[manifestPath] ?? "", "base64").toString("utf8"));
      if (!live || typeof live !== "object" || !saved || typeof saved !== "object") throw new Error("developer_memory_manifest_invalid");
      const liveHashes = "fixedFileHashes" in live ? live.fixedFileHashes : undefined;
      const savedHashes = "fixedFileHashes" in saved ? saved.fixedFileHashes : undefined;
      const agentHash = liveHashes && typeof liveHashes === "object" && "agent" in liveHashes ? liveHashes.agent : undefined;
      if (savedHashes && typeof savedHashes === "object" && typeof agentHash === "string" && /^[a-f0-9]{64}$/u.test(agentHash)) {
        (savedHashes as Record<string, unknown>).agent = agentHash;
        next[manifestPath] = Buffer.from(`${JSON.stringify(saved)}\n`).toString("base64");
      }
    }
    // A complete backup is persisted and read back before any current file changes.
    const beforeName = `${action}-${Date.now()}-${randomUUID()}.json`;
    const beforePath = path.join(this.directory, beforeName);
    await this.safePath(beforePath);
    const snapshot: Snapshot = { schema: "echoink.developer-memory-backup.v1", action, at: Date.now(), files: current };
    const serialized = `${JSON.stringify(snapshot)}\n`;
    await this.io.atomicWrite(beforePath, serialized);
    if (await fs.readFile(beforePath, "utf8") !== serialized) throw new Error("developer_backup_readback_failed");
    const paths = [...new Set([...Object.keys(current), ...Object.keys(next), ...FIXED])]
      .filter((name) => !LEGACY_AGENT_FILES.has(name));
    const journal: Journal = { schema: "echoink.developer-memory-change.v1", before: beforeName, paths, committed: false };
    await this.io.atomicWrite(this.journal, JSON.stringify(journal));
    try {
      await this.apply(next, paths);
      await validateReopen();
      await this.io.atomicWrite(this.journal, JSON.stringify({ ...journal, committed: true }));
    } catch (error) {
      try {
        await this.apply(current, paths);
        await fs.unlink(this.journal);
      } catch (rollbackError) {
        throw new Error(`developer_memory_recovery_required: ${beforePath}; ${String(error)}; rollback: ${String(rollbackError)}`);
      }
      throw new Error(`developer_memory_change_rolled_back: ${beforePath}; ${String(error)}`);
    }
    // A committed journal is harmless; next startup removes it if cleanup fails.
    await fs.unlink(this.journal).catch(() => undefined);
    return { backup: beforePath, preservedLearningConflicts: 0 };
  }

  private async capture(): Promise<Files> {
    const names = new Set<string>(FIXED);
    const manifestPath = this.target("shared-user/.runtime/manifest.json");
    await this.safePath(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      records: { file: string }[]; tombstones: { backupFile: string }[];
    };
    if (!Array.isArray(manifest.records) || !Array.isArray(manifest.tombstones)) throw new Error("developer_memory_manifest_invalid");
    for (const record of manifest.records) {
      if (!PRIMARY.test(record.file)) throw new Error("developer_memory_record_path_invalid");
      names.add(record.file);
    }
    for (const record of manifest.tombstones) {
      if (!FORGOTTEN.test(record.backupFile)) throw new Error("developer_memory_backup_path_invalid");
      names.add(record.backupFile);
    }
    // restoreForgotten removes the tombstone but intentionally keeps its backup.
    // These valid current-store backups must move too, or startup resurrects it.
    for (const directory of ["forgets", "source-deletions"]) {
      for (const candidate of await this.walkFiles(path.join(this.memoryRoot, "shared-user/.runtime/backups", directory), 1)) {
        const name = path.relative(this.memoryRoot, candidate).split(path.sep).join("/");
        if (!FORGOTTEN.test(name)) continue;
        try {
          const record = parsePersonalMemoryRecord(await fs.readFile(candidate, "utf8"), name);
          const timestamp = path.basename(name).match(/-(\d+)\.md$/u)?.[1];
          if (!timestamp || Number(timestamp) <= 0 || !Number.isSafeInteger(Number(timestamp))
            || path.basename(name) !== `${record.id}-${timestamp}.md`) continue;
        } catch { continue; }
        names.add(name);
      }
    }
    const secondaryRoot = path.join(this.memoryRoot, "shared-user/memory/secondary");
    for (const candidate of await this.walkFiles(secondaryRoot, 2)) {
      const name = path.relative(this.memoryRoot, candidate).split(path.sep).join("/");
      if (!SECONDARY.test(name)) continue;
      try { parseSecondaryRecord(await fs.readFile(candidate, "utf8"), name); }
      catch { continue; } // Unrecognized user files are preserved.
      names.add(name);
    }
    const files: Files = {};
    for (const name of names) {
      const target = this.target(name);
      await this.safePath(target);
      files[name] = (await this.readOptional(target))?.toString("base64") ?? null;
    }
    return files;
  }

  private async readSnapshot(file: string): Promise<Snapshot> {
    if (path.dirname(file) !== this.directory || !SNAPSHOT_NAME.test(path.basename(file))) throw new Error("developer_backup_path_invalid");
    await this.safePath(file);
    const snapshot = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
    if (snapshot.schema !== "echoink.developer-memory-backup.v1"
      || !snapshot.files || typeof snapshot.files !== "object" || Array.isArray(snapshot.files)) throw new Error("developer_backup_invalid");
    for (const [name, content] of Object.entries(snapshot.files)) {
      this.assertMemoryFile(name);
      if (content !== null && (typeof content !== "string" || Buffer.from(content, "base64").toString("base64") !== content)) throw new Error("developer_backup_content_invalid");
    }
    for (const name of FIXED) {
      if (!Object.hasOwn(snapshot.files, name)) throw new Error("developer_backup_incomplete");
    }
    return snapshot;
  }

  private async apply(files: Files, names: readonly string[]): Promise<void> {
    // Preflight the full path set before deleting or replacing anything.
    for (const name of names) {
      if (!LEGACY_AGENT_FILES.has(name)) await this.safePath(this.target(name));
    }
    for (const name of names) {
      if (LEGACY_AGENT_FILES.has(name)) continue;
      const target = this.target(name);
      const previous = await this.readOptional(target);
      const content = files[name] ?? null;
      if (content === null) {
        if (previous !== null) await fs.unlink(target);
      } else {
        const next = Buffer.from(content, "base64");
        if (!previous?.equals(next)) await this.io.atomicWrite(target, next);
      }
    }
  }

  private assertMemoryFile(name: string): void {
    if (typeof name !== "string" || !((FIXED as readonly string[]).includes(name)
      || PRIMARY.test(name) || SECONDARY.test(name) || FORGOTTEN.test(name))) throw new Error("developer_memory_path_invalid");
  }
  private target(name: string): string { this.assertMemoryFile(name); return path.join(this.memoryRoot, name); }

  private async safePath(target: string): Promise<void> {
    // Only the current Pi memory tree or its sibling developer-backups is allowed.
    const boundary = path.dirname(this.memoryRoot);
    const relative = path.relative(boundary, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("developer_memory_path_invalid");
    let cursor = boundary;
    for (const part of ["", ...relative.split(path.sep)]) {
      cursor = path.join(cursor, part);
      const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink() || (stat && !stat.isFile() && !stat.isDirectory())) throw new Error("developer_memory_unsafe_path");
    }
  }

  private async readOptional(target: string): Promise<Buffer | null> {
    return await fs.readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  }
  private async walkFiles(directory: string, depth: number): Promise<string[]> {
    await this.safePath(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const result: string[] = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("developer_memory_unsafe_path");
      if (entry.isFile()) result.push(file);
      else if (entry.isDirectory() && depth > 1) result.push(...await this.walkFiles(file, depth - 1));
    }
    return result;
  }
}
