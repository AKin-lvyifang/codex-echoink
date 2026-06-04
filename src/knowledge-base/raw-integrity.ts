import * as fsp from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";
import type { StructureNormalizationPathRewrite } from "./types";
import { rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";

export interface RawSnapshotEntry {
  kind?: RawContentSnapshotEntry["kind"];
  fingerprint: string;
  mtimeMs: number;
  mode?: number;
  identity?: string;
  nlink?: number;
}
export type RawSnapshot = Map<string, RawSnapshotEntry>;
export type RawContentSnapshotEntry = RawFileContentSnapshotEntry | RawDirectoryContentSnapshotEntry | RawSymlinkContentSnapshotEntry | RawSpecialContentSnapshotEntry;

export interface RawFileContentSnapshotEntry {
  kind: "file";
  content: Buffer;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface RawSymlinkContentSnapshotEntry {
  kind: "symlink";
  target: string;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface RawDirectoryContentSnapshotEntry {
  kind: "directory";
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface RawSpecialContentSnapshotEntry {
  kind: "special";
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export type RawContentSnapshot = Map<string, RawContentSnapshotEntry>;
export const RAW_INTEGRITY_ERROR_PREFIX = "知识库任务试图改写 raw/ 原始资料文件";

export interface RawSnapshotChange {
  file: string;
  mapped: string;
  kind: "changed" | "missing" | "added";
  message: string;
}

export interface RawSnapshotChangeClassification {
  blockingChanges: RawSnapshotChange[];
  externalAdditions: RawSnapshotChange[];
}

export interface RawSnapshotFingerprintOptions {
  fileFingerprint?: (relativePath: string, content: Buffer) => string;
}

export interface RawSnapshotDiffOptions {
  allowedManagedFrontmatterPaths?: Set<string>;
}

export async function snapshotRawFiles(vaultPath: string, options: RawSnapshotFingerprintOptions = {}): Promise<RawSnapshot> {
  return fingerprintRawContentSnapshot(await snapshotRawFileContents(vaultPath), options);
}

export async function snapshotRawFileContents(vaultPath: string): Promise<RawContentSnapshot> {
  const rawDir = path.join(vaultPath, "raw");
  const entries = await walkExistingRawEntries(rawDir);
  const snapshot: RawContentSnapshot = new Map();
  for (const entryPath of entries) {
    const relativePath = normalizeSlashes(path.relative(vaultPath, entryPath));
    const stat = await fsp.lstat(entryPath);
    if (stat.isDirectory()) {
      snapshot.set(relativePath, {
        kind: "directory",
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      snapshot.set(relativePath, {
        kind: "symlink",
        target: await fsp.readlink(entryPath),
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink
      });
      continue;
    }
    if (!stat.isFile()) {
      snapshot.set(relativePath, {
        kind: "special",
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs,
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink
      });
      continue;
    }
    const content = await fsp.readFile(entryPath);
    snapshot.set(relativePath, {
      kind: "file",
      content,
      mode: stat.mode,
      atimeMs: stat.atimeMs,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink
    });
  }
  return snapshot;
}

async function walkExistingRawEntries(rawDir: string): Promise<string[]> {
  try {
    return await walkRawEntries(rawDir);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

export function fingerprintRawContentSnapshot(snapshot: RawContentSnapshot, options: RawSnapshotFingerprintOptions = {}): RawSnapshot {
  return new Map(Array.from(snapshot.entries()).map(([file, entry]) => [file, {
    kind: entry.kind,
    fingerprint: rawEntryFingerprint(file, entry, options),
    mtimeMs: entry.kind === "directory" ? 0 : entry.mtimeMs,
    mode: entry.mode,
    identity: rawEntryIdentity(entry),
    nlink: entry.nlink
  }]));
}

export function contentFingerprint(content: Buffer): string {
  return `sha256:${content.length}:${createHash("sha256").update(content).digest("hex")}`;
}

export function diffRawSnapshot(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = [], options: RawSnapshotDiffOptions = {}): string[] {
  return rawSnapshotChangeMessages(diffRawSnapshotChanges(before, after, rewrites, options));
}

export function classifyRawSnapshotChanges(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = [], options: RawSnapshotDiffOptions = {}): RawSnapshotChangeClassification {
  const blockingChanges: RawSnapshotChange[] = [];
  const externalAdditions: RawSnapshotChange[] = [];
  for (const change of diffRawSnapshotChanges(before, after, rewrites, options)) {
    if (change.kind === "added" && !isUnsafeAddedRawEntry(after.get(change.mapped))) {
      externalAdditions.push(change);
    } else {
      blockingChanges.push(change);
    }
  }
  return { blockingChanges, externalAdditions };
}

export function rawSnapshotChangeMessages(changes: RawSnapshotChange[]): string[] {
  return changes.map((change) => change.message);
}

export function formatRawIntegrityError(changes: string[], restored: boolean): string {
  const suffix = restored ? "，已恢复原内容" : "";
  return `${RAW_INTEGRITY_ERROR_PREFIX}${suffix}：${changes.slice(0, 5).join("，")}`;
}

export function isRawIntegrityErrorMessage(message: string): boolean {
  return message.startsWith(RAW_INTEGRITY_ERROR_PREFIX);
}

export function changedRawSnapshotPaths(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = []): string[] {
  return diffRawSnapshotChanges(before, after, rewrites)
    .filter((change) => change.kind !== "added")
    .map((change) => change.file);
}

export function addedRawSnapshotPaths(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = []): string[] {
  return diffRawSnapshotChanges(before, after, rewrites)
    .filter((change) => change.kind === "added")
    .map((change) => change.file);
}

export async function restoreRawSnapshot(
  vaultPath: string,
  snapshot: RawContentSnapshot,
  before: RawSnapshot,
  after: RawSnapshot,
  rewrites: StructureNormalizationPathRewrite[] = [],
  options: { removeAdded?: "all" | "unsafe" | "none" } = {}
): Promise<{ restored: string[]; removed: string[] }> {
  const restored = await restoreRawFileContents(vaultPath, snapshot, changedRawSnapshotPaths(before, after, rewrites), rewrites);
  const removed = await removeAddedRawFiles(vaultPath, addedRawSnapshotPaths(before, after, rewrites), after, options.removeAdded ?? "all");
  return { restored, removed };
}

export async function restoreRawFileContents(
  vaultPath: string,
  snapshot: RawContentSnapshot,
  files?: string[],
  rewrites: StructureNormalizationPathRewrite[] = []
): Promise<string[]> {
  const allowed = files ? new Set(files.map(normalizeSlashes)) : null;
  const restored: string[] = [];
  for (const [file, entry] of sortedContentSnapshotEntries(snapshot)) {
    if (isRawIndex(file)) continue;
    if (allowed && !allowed.has(file)) continue;
    const target = rewriteKnowledgeBaseRelativePath(file, rewrites);
    const fullPath = path.join(vaultPath, target);
    await fsp.mkdir(path.dirname(fullPath), { recursive: true });
    if (entry.kind === "directory") {
      const current = await fsp.lstat(fullPath).catch(() => null);
      if (current && !current.isDirectory()) {
        await fsp.rm(fullPath, { force: true, recursive: true }).catch(() => undefined);
      }
      await fsp.mkdir(fullPath, { recursive: true });
      await fsp.chmod(fullPath, entry.mode).catch(() => undefined);
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
    } else if (entry.kind === "symlink") {
      await fsp.rm(fullPath, { force: true, recursive: true }).catch(() => undefined);
      await fsp.symlink(entry.target, fullPath);
      await fsp.lutimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
    } else if (entry.kind === "file") {
      await fsp.rm(fullPath, { force: true, recursive: true }).catch(() => undefined);
      await fsp.writeFile(fullPath, entry.content);
      await fsp.chmod(fullPath, entry.mode).catch(() => undefined);
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
    }
    restored.push(target);
  }
  return restored;
}

export async function restoreRawMetadata(vaultPath: string, snapshot: RawContentSnapshot, files?: string[]): Promise<string[]> {
  const allowed = files ? new Set(files.map(normalizeSlashes)) : null;
  const restored: string[] = [];
  for (const [file, entry] of sortedContentSnapshotEntries(snapshot)) {
    if (isRawIndex(file)) continue;
    if (allowed && !allowed.has(file)) continue;
    const fullPath = path.join(vaultPath, file);
    const current = await fsp.lstat(fullPath).catch(() => null);
    if (!current) continue;
    if (entry.kind === "directory" && current.isDirectory()) {
      await fsp.chmod(fullPath, entry.mode).catch(() => undefined);
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
      restored.push(file);
      continue;
    }
    if (entry.kind === "file" && current.isFile()) {
      await fsp.chmod(fullPath, entry.mode).catch(() => undefined);
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
      restored.push(file);
      continue;
    }
    if (entry.kind === "symlink" && current.isSymbolicLink()) {
      await fsp.lutimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
      restored.push(file);
    }
  }
  return restored;
}

function diffRawSnapshotChanges(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = [], options: RawSnapshotDiffOptions = {}): RawSnapshotChange[] {
  const changed: RawSnapshotChange[] = [];
  const expectedAfterPaths = new Set<string>();
  for (const [file, beforeEntry] of sortedSnapshotEntries(before)) {
    if (isRawIndex(file)) continue;
    const mapped = rewriteKnowledgeBaseRelativePath(file, rewrites);
    expectedAfterPaths.add(mapped);
    const afterEntry = after.get(mapped);
    const label = file === mapped ? file : `${file} -> ${mapped}`;
    if (!afterEntry) {
      changed.push({ file, mapped, kind: "missing", message: `${label} 文件缺失或被改写` });
      continue;
    }
    if (afterEntry.fingerprint !== beforeEntry.fingerprint) {
      changed.push({ file, mapped, kind: "changed", message: `${label} 文件内容被改写` });
      continue;
    }
    if (!sameMode(afterEntry.mode, beforeEntry.mode)) {
      changed.push({ file, mapped, kind: "changed", message: `${label} 文件权限被改写` });
      continue;
    }
    if (beforeEntry.kind !== "directory" && !sameMtime(afterEntry.mtimeMs, beforeEntry.mtimeMs) && !allowsManagedFrontmatterMetadataChange(file, mapped, options)) {
      changed.push({ file, mapped, kind: "changed", message: `${label} 文件元数据被改写` });
      continue;
    }
    if (afterEntry.identity !== beforeEntry.identity && !allowsManagedFrontmatterIdentityChange(file, mapped, beforeEntry, afterEntry, options)) {
      changed.push({ file, mapped, kind: "changed", message: `${label} 文件身份被改写` });
    }
  }
  for (const [file] of sortedSnapshotEntries(after)) {
    if (isRawIndex(file)) continue;
    if (expectedAfterPaths.has(file)) continue;
    changed.push({ file, mapped: file, kind: "added", message: `${file} 文件新增或被移动到 raw/` });
  }
  return changed;
}

async function removeAddedRawFiles(vaultPath: string, files: string[], after: RawSnapshot, removeAdded: "all" | "unsafe" | "none"): Promise<string[]> {
  const removed: string[] = [];
  if (removeAdded === "none") return removed;
  for (const file of files.map(normalizeSlashes).sort((left, right) => left.localeCompare(right))) {
    const isRawRoot = file === "raw";
    if (isRawIndex(file) || (!isRawRoot && !file.startsWith("raw/"))) continue;
    if (removeAdded === "unsafe" && !isUnsafeAddedRawEntry(after.get(file))) continue;
    const fullPath = path.resolve(vaultPath, file);
    const rawRoot = path.resolve(vaultPath, "raw");
    if (isRawRoot ? fullPath !== rawRoot : !isInside(rawRoot, fullPath)) continue;
    await fsp.rm(fullPath, { force: true, recursive: true });
    if (!isRawRoot) await pruneEmptyRawParents(path.dirname(fullPath), rawRoot);
    removed.push(file);
  }
  return removed;
}

function isUnsafeAddedRawEntry(entry: RawSnapshotEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.kind === "symlink" || entry.kind === "special") return true;
  return entry.kind === "file" && typeof entry.nlink === "number" && entry.nlink > 1;
}

async function pruneEmptyRawParents(startDir: string, rawRoot: string): Promise<void> {
  let current = startDir;
  while (isInside(rawRoot, current) && current !== rawRoot) {
    const entries = await fsp.readdir(current).catch(() => null);
    if (!entries || entries.length) return;
    await fsp.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sortedSnapshotEntries(snapshot: RawSnapshot): Array<[string, RawSnapshotEntry]> {
  return Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function sortedContentSnapshotEntries(snapshot: RawContentSnapshot): Array<[string, RawContentSnapshotEntry]> {
  return Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function isRawIndex(file: string): boolean {
  return normalizeSlashes(file) === "raw/index.md";
}

function sameMtime(left: number, right: number): boolean {
  return Math.abs(left - right) <= 5;
}

function sameMode(left: number | undefined, right: number | undefined): boolean {
  if (typeof left !== "number" || typeof right !== "number") return left === right;
  return (left & 0o7777) === (right & 0o7777);
}

function allowsManagedFrontmatterMetadataChange(file: string, mapped: string, options: RawSnapshotDiffOptions): boolean {
  const allowed = options.allowedManagedFrontmatterPaths;
  if (!allowed?.size) return false;
  return allowed.has(normalizeSlashes(file)) || allowed.has(normalizeSlashes(mapped));
}

function allowsManagedFrontmatterIdentityChange(
  file: string,
  mapped: string,
  beforeEntry: RawSnapshotEntry,
  afterEntry: RawSnapshotEntry,
  options: RawSnapshotDiffOptions
): boolean {
  if (!allowsManagedFrontmatterMetadataChange(file, mapped, options)) return false;
  if (beforeEntry.kind !== "file" || afterEntry.kind !== "file") return false;
  if (typeof afterEntry.nlink === "number" && afterEntry.nlink > 1) return false;
  return true;
}

function rawEntryFingerprint(file: string, entry: RawContentSnapshotEntry, options: RawSnapshotFingerprintOptions): string {
  const prefix = Buffer.from(rawKindFingerprint(entry.kind));
  const content = entry.kind === "symlink"
    ? Buffer.from(entry.target)
    : entry.kind === "file"
      ? Buffer.from(options.fileFingerprint?.(file, entry.content) ?? entry.content)
      : entry.kind === "special"
        ? Buffer.from(String(entry.mode))
        : Buffer.from("");
  return contentFingerprint(Buffer.concat([prefix, content]));
}

function rawEntryIdentity(entry: RawContentSnapshotEntry): string | undefined {
  if (entry.kind === "directory") return `${entry.dev}:${entry.ino}`;
  return `${entry.dev}:${entry.ino}:${entry.nlink}`;
}

function rawKindFingerprint(kind: RawContentSnapshotEntry["kind"]): string {
  return `${kind}\0`;
}

async function walkRawEntries(dir: string): Promise<string[]> {
  const stat = await fsp.lstat(dir);
  const result = [dir];
  if (!stat.isDirectory()) return result;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    result.push(full);
    if (entry.isDirectory()) result.push(...await walkRawEntries(full));
  }
  return result;
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}
