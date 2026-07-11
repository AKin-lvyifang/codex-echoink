import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { normalizePath } from "obsidian";
import { swallowError } from "../core/error-handling";
import type { KnowledgeBaseRunMode } from "./types";
import {
  disposeKnowledgeTransactionSnapshot,
  readKnowledgeTransactionEntryContent,
  snapshotKnowledgeTransactionEntries,
  type KnowledgeTransactionSnapshot,
  type KnowledgeTransactionSnapshotEntry
} from "./transaction-snapshot-core";
import { formatDateForFile, isMissingPathError, pad, writeFileAtomic } from "./utils";

export {
  KNOWLEDGE_TRANSACTION_FILE_STORAGE_THRESHOLD,
  disposeKnowledgeTransactionSnapshot,
  type KnowledgeTransactionSnapshot,
  type KnowledgeTransactionSnapshotEntry
} from "./transaction-snapshot-core";

export interface OptionalFileSnapshot {
  absolutePath: string;
  existed: boolean;
  content?: Buffer;
  atimeMs?: number;
  mtimeMs?: number;
  mode?: number;
}

export interface KnowledgeConflictDuplicateMove {
  from: string;
  to: string;
  canonical: string;
}

export interface KnowledgeConflictDuplicateCleanup {
  moved: KnowledgeConflictDuplicateMove[];
  backupRoot: string;
}

export function knowledgeTransactionRootsForMode(mode: KnowledgeBaseRunMode): string[] {
  if (mode === "lint") return ["outputs"];
  return ["raw/index.md", "wiki", "outputs", "inbox", "projects"];
}

export function assertSafeKnowledgeTransactionRoots(snapshot: KnowledgeTransactionSnapshot, options: { allowedUnsafePaths?: Set<string> } = {}): void {
  for (const [relativePath, entry] of snapshot.entries) {
    if (options.allowedUnsafePaths?.has(normalizePath(relativePath))) continue;
    if (entry.kind === "symlink") {
      throw new Error(`知识库写入区不能包含 symlink：${relativePath}`);
    }
    if (entry.kind === "special") {
      throw new Error(`知识库写入区不能包含特殊文件：${relativePath}`);
    }
    if (entry.kind === "file" && typeof entry.nlink === "number" && entry.nlink > 1) {
      throw new Error(`知识库写入区不能包含 hardlink：${relativePath}`);
    }
    if (entry.kind === "file" && isKnowledgeConflictDuplicatePath(relativePath, snapshot.entries)) {
      throw new Error(`知识库写入区不能包含冲突副本：${relativePath}`);
    }
  }
  for (const root of snapshot.roots) {
    const entry = snapshot.entries.get(root);
    if (!entry) continue;
    const rootIsFile = path.extname(root) !== "";
    if (rootIsFile && entry.kind !== "file") {
      throw new Error(`知识库写入区不是普通文件：${root}`);
    }
    if (!rootIsFile && entry.kind !== "directory") {
      throw new Error(`知识库写入区不是普通目录：${root}`);
    }
  }
}

export async function assertSafeKnowledgeTransactionCurrentState(
  vaultPath: string,
  roots: string[],
  options: { allowedUnsafePaths?: Set<string> } = {}
): Promise<void> {
  const snapshot = await snapshotKnowledgeTransaction(vaultPath, roots);
  try {
    assertSafeKnowledgeTransactionRoots(snapshot, options);
  } finally {
    await disposeKnowledgeTransactionSnapshot(snapshot);
  }
}

export async function quarantinePreexistingKnowledgeConflictDuplicates(
  vaultPath: string,
  snapshot: KnowledgeTransactionSnapshot,
  startedAt: number,
  mode: KnowledgeBaseRunMode
): Promise<KnowledgeConflictDuplicateCleanup> {
  if (mode === "lint") return { moved: [], backupRoot: "" };
  const duplicatePaths = Array.from(snapshot.entries.entries())
    .filter(([relativePath, entry]) => entry.kind === "file" && isKnowledgeConflictDuplicatePath(relativePath, snapshot.entries))
    .map(([relativePath]) => normalizePath(relativePath))
    .sort((left, right) => left.localeCompare(right));
  if (!duplicatePaths.length) return { moved: [], backupRoot: "" };

  const backupRoot = normalizePath(`outputs/maintenance/conflict-duplicates-${formatDateTimeForFile(new Date(startedAt))}`);
  const moved: KnowledgeConflictDuplicateMove[] = [];
  for (const from of duplicatePaths) {
    const canonical = knowledgeConflictDuplicateCanonicalPath(from);
    if (!canonical) continue;
    const to = normalizePath(path.join(backupRoot, from));
    await moveKnowledgeConflictDuplicate(vaultPath, from, to);
    moved.push({ from, to, canonical });
  }
  return { moved, backupRoot };
}

export async function snapshotKnowledgeTransaction(vaultPath: string, roots: string[]): Promise<KnowledgeTransactionSnapshot> {
  return snapshotKnowledgeTransactionEntries(vaultPath, roots);
}

export async function restoreKnowledgeTransactionOnFailure(snapshot: KnowledgeTransactionSnapshot | null): Promise<{ restored: boolean; error?: string }> {
  if (!snapshot) return { restored: false };
  try {
    await restoreKnowledgeTransaction(snapshot);
    return { restored: true };
  } catch (error) {
    return {
      restored: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function commitLintReportOnly(vaultPath: string, snapshot: KnowledgeTransactionSnapshot | null, reportPath: string): Promise<void> {
  if (!snapshot) return;
  const reportSnapshot = await snapshotOptionalFile(path.join(vaultPath, reportPath));
  if (!reportSnapshot.existed || !reportSnapshot.content) return;
  await restoreKnowledgeTransactionChanges(snapshot, new Set([normalizePath(reportPath)]));
  await restoreOptionalFile(reportSnapshot);
}

export async function snapshotOptionalFile(absolutePath: string): Promise<OptionalFileSnapshot> {
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return { absolutePath, existed: false };
  if (!stat.isFile()) return { absolutePath, existed: true };
  return {
    absolutePath,
    existed: true,
    content: await fsp.readFile(absolutePath),
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode
  };
}

export async function restoreOptionalFile(snapshot: OptionalFileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await fsp.rm(snapshot.absolutePath, { force: true, recursive: true });
    return;
  }
  if (!snapshot.content) return;
  await fsp.mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
  await writeFileAtomic(snapshot.absolutePath, snapshot.content);
  if (typeof snapshot.mode === "number") await fsp.chmod(snapshot.absolutePath, snapshot.mode).catch(swallowError("restore optional file mode"));
  if (typeof snapshot.atimeMs === "number" && typeof snapshot.mtimeMs === "number") {
    await fsp.utimes(snapshot.absolutePath, new Date(snapshot.atimeMs), new Date(snapshot.mtimeMs)).catch(swallowError("restore optional file timestamps"));
  }
}

async function restoreKnowledgeTransaction(snapshot: KnowledgeTransactionSnapshot): Promise<void> {
  const current = await snapshotKnowledgeTransaction(snapshot.vaultPath, snapshot.roots);
  try {
    const currentEntries = current.entries;
    for (const [relativePath] of sortedTransactionEntries(currentEntries).reverse()) {
      if (snapshot.entries.has(relativePath)) continue;
      if (!isTransactionPath(relativePath)) continue;
      await fsp.rm(path.join(snapshot.vaultPath, relativePath), { force: true, recursive: true });
    }
    for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries)) {
      if (!isTransactionPath(relativePath)) continue;
      const currentEntry = currentEntries.get(relativePath);
      if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
      await restoreKnowledgeTransactionEntry(snapshot.vaultPath, relativePath, entry);
    }
    for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries).reverse()) {
      if (entry.kind !== "directory" || !isTransactionPath(relativePath)) continue;
      const currentEntry = currentEntries.get(relativePath);
      if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
      await fsp.utimes(path.join(snapshot.vaultPath, relativePath), new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore transaction directory timestamps"));
    }
  } finally {
    await disposeKnowledgeTransactionSnapshot(current);
  }
}

async function restoreKnowledgeTransactionEntry(vaultPath: string, relativePath: string, entry: KnowledgeTransactionSnapshotEntry): Promise<void> {
  const absolute = path.join(vaultPath, relativePath);
  if (entry.kind === "directory") {
    const current = await fsp.lstat(absolute).catch(() => null);
    if (current && !current.isDirectory()) {
      await fsp.rm(absolute, { force: true, recursive: true });
    }
    await fsp.mkdir(absolute, { recursive: true });
    await fsp.chmod(absolute, entry.mode).catch(swallowError("restore transaction directory mode"));
    await fsp.utimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore transaction directory timestamps"));
  } else if (entry.kind === "symlink" && entry.target !== undefined) {
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.rm(absolute, { force: true, recursive: true }).catch(swallowError("restore transaction symlink cleanup"));
    await fsp.symlink(entry.target, absolute);
    await fsp.lutimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore transaction symlink timestamps"));
  } else if (entry.kind === "file") {
    const content = await readKnowledgeTransactionEntryContent(entry);
    if (!content) return;
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.rm(absolute, { force: true, recursive: true }).catch(swallowError("restore transaction file cleanup"));
    await fsp.writeFile(absolute, content);
    await fsp.chmod(absolute, entry.mode).catch(swallowError("restore transaction file mode"));
    await fsp.utimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore transaction file timestamps"));
  }
}

async function restoreKnowledgeTransactionChanges(snapshot: KnowledgeTransactionSnapshot, keepPaths: Set<string>): Promise<void> {
  const keep = normalizeKeepPaths(keepPaths);
  const current = await snapshotKnowledgeTransaction(snapshot.vaultPath, snapshot.roots);
  try {
    for (const [relativePath] of sortedTransactionEntries(current.entries).reverse()) {
      if (snapshot.entries.has(relativePath)) continue;
      if (shouldKeepTransactionPath(relativePath, keep)) continue;
      if (!isTransactionPath(relativePath)) continue;
      await fsp.rm(path.join(snapshot.vaultPath, relativePath), { force: true, recursive: true });
    }
    for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries)) {
      if (!isTransactionPath(relativePath) || shouldKeepTransactionPath(relativePath, keep)) continue;
      const currentEntry = current.entries.get(relativePath);
      if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
      await restoreKnowledgeTransactionEntry(snapshot.vaultPath, relativePath, entry);
    }
    for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries).reverse()) {
      if (entry.kind !== "directory" || !isTransactionPath(relativePath) || shouldKeepTransactionPath(relativePath, keep)) continue;
      const currentEntry = current.entries.get(relativePath);
      if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
      await fsp.utimes(path.join(snapshot.vaultPath, relativePath), new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore kept transaction directory timestamps"));
    }
  } finally {
    await disposeKnowledgeTransactionSnapshot(current);
  }
}

function normalizeKeepPaths(keepPaths: Set<string>): Set<string> {
  const keep = new Set<string>();
  for (const item of keepPaths) {
    const normalized = normalizePath(item);
    if (!normalized) continue;
    keep.add(normalized);
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index++) {
      keep.add(parts.slice(0, index).join("/"));
    }
  }
  return keep;
}

function shouldKeepTransactionPath(relativePath: string, keepPaths: Set<string>): boolean {
  return keepPaths.has(normalizePath(relativePath));
}

function sameTransactionEntry(left: KnowledgeTransactionSnapshotEntry, right: KnowledgeTransactionSnapshotEntry): boolean {
  if (left.kind !== right.kind) return false;
  if (left.mode !== right.mode) return false;
  if (Math.round(left.mtimeMs) !== Math.round(right.mtimeMs)) return false;
  if (left.kind === "file") {
    if (typeof left.size === "number" && typeof right.size === "number" && left.size !== right.size) return false;
    if (left.contentHash && right.contentHash) return left.contentHash === right.contentHash;
    return Boolean(left.content && right.content && left.content.equals(right.content));
  }
  if (left.kind === "symlink") return left.target === right.target;
  if (left.kind === "special") return true;
  return true;
}

function sortedTransactionEntries(entries: Map<string, KnowledgeTransactionSnapshotEntry>): Array<[string, KnowledgeTransactionSnapshotEntry]> {
  return Array.from(entries.entries()).sort(([left], [right]) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

function isTransactionPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return normalized === "raw/index.md"
    || normalized === "wiki"
    || normalized.startsWith("wiki/")
    || normalized === "outputs"
    || normalized.startsWith("outputs/")
    || normalized === "inbox"
    || normalized.startsWith("inbox/")
    || normalized === "projects"
    || normalized.startsWith("projects/");
}

function knowledgeConflictDuplicateCanonicalPath(relativePath: string): string | null {
  const normalized = normalizePath(relativePath);
  const match = /^(.*) \d+(\.md)$/i.exec(normalized);
  if (!match) return null;
  return `${match[1]}${match[2]}`;
}

async function moveKnowledgeConflictDuplicate(vaultPath: string, from: string, to: string): Promise<void> {
  const fromAbs = path.join(vaultPath, from);
  const toAbs = path.join(vaultPath, to);
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  if (await pathExists(toAbs)) {
    throw new Error(`冲突副本备份路径已存在，停止移动：${to}`);
  }
  await fsp.rename(fromAbs, toAbs);
}

function isKnowledgeConflictDuplicatePath(relativePath: string, entries: Map<string, KnowledgeTransactionSnapshotEntry>): boolean {
  const normalized = normalizePath(relativePath);
  const match = /^(.*) \d+(\.md)$/i.exec(normalized);
  if (!match) return false;
  return entries.has(`${match[1]}${match[2]}`);
}

function formatDateTimeForFile(date: Date): string {
  return `${formatDateForFile(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}
