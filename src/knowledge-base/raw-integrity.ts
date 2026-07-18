import * as fsp from "fs/promises";
import * as path from "path";
import { createHash } from "node:crypto";
import { swallowError } from "../core/error-handling";
import type { StructureNormalizationPathRewrite } from "./types";
import { rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import { isMissingPathError, normalizeSlashes, walkExistingEntries } from "./utils";

export interface RawSnapshotEntry {
  kind?: RawContentSnapshotEntry["kind"];
  fingerprint: string;
  mtimeMs: number;
  ctimeMs?: number;
  size?: number;
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
  ctimeMs: number;
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
  ctimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface RawDirectoryContentSnapshotEntry {
  kind: "directory";
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface RawSpecialContentSnapshotEntry {
  kind: "special";
  mode: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
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
        ctimeMs: stat.ctimeMs,
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
        ctimeMs: stat.ctimeMs,
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
        ctimeMs: stat.ctimeMs,
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
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
      nlink: stat.nlink
    });
  }
  return snapshot;
}

async function walkExistingRawEntries(rawDir: string): Promise<string[]> {
  try {
    return await walkExistingEntries(rawDir);
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
    ctimeMs: entry.ctimeMs,
    size: entry.kind === "file" ? entry.content.length : undefined,
    mode: entry.mode,
    identity: rawEntryIdentity(entry),
    nlink: entry.nlink
  }]));
}

export async function snapshotRawFilesIncremental(
  vaultPath: string,
  previous: RawSnapshot,
  options: RawSnapshotFingerprintOptions = {}
): Promise<RawSnapshot> {
  const rawDir = path.join(vaultPath, "raw");
  const paths = await walkExistingRawEntries(rawDir);
  const snapshot: RawSnapshot = new Map();
  for (const entryPath of paths) {
    const file = normalizeSlashes(path.relative(vaultPath, entryPath));
    const stat = await fsp.lstat(entryPath);
    const kind: RawContentSnapshotEntry["kind"] = stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isFile()
          ? "file"
          : "special";
    const identity = rawEntryIdentityFromStat(stat);
    const prior = previous.get(file);
    const reusable = prior
      && prior.kind === kind
      && prior.size === (stat.isFile() ? stat.size : undefined)
      && Math.abs((prior.mtimeMs ?? 0) - (kind === "directory" ? 0 : stat.mtimeMs)) <= 5
      && Math.abs((prior.ctimeMs ?? 0) - stat.ctimeMs) <= 5
      && sameMode(prior.mode, stat.mode)
      && prior.identity === identity;
    let fingerprint = reusable ? prior.fingerprint : "";
    if (!fingerprint) {
      if (kind === "file") {
        const content = await fsp.readFile(entryPath);
        fingerprint = rawFingerprintForBuffer(file, kind, content, options);
      } else if (kind === "symlink") {
        fingerprint = rawFingerprintForBuffer(file, kind, Buffer.from(await fsp.readlink(entryPath)), options);
      } else if (kind === "special") {
        fingerprint = rawFingerprintForBuffer(file, kind, Buffer.from(String(stat.mode)), options);
      } else {
        fingerprint = rawFingerprintForBuffer(file, kind, Buffer.alloc(0), options);
      }
    }
    snapshot.set(file, {
      kind,
      fingerprint,
      mtimeMs: kind === "directory" ? 0 : stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.isFile() ? stat.size : undefined,
      mode: stat.mode,
      identity,
      nlink: stat.nlink
    });
  }
  return snapshot;
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
        await fsp.rm(fullPath, { force: true, recursive: true }).catch(swallowError("restore raw directory cleanup"));
      }
      await fsp.mkdir(fullPath, { recursive: true });
      await fsp.chmod(fullPath, entry.mode).catch(swallowError("restore raw directory mode"));
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw directory timestamps"));
    } else if (entry.kind === "symlink") {
      await fsp.rm(fullPath, { force: true, recursive: true }).catch(swallowError("restore raw symlink cleanup"));
      await fsp.symlink(entry.target, fullPath);
      await fsp.lutimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw symlink timestamps"));
    } else if (entry.kind === "file") {
      await fsp.rm(fullPath, { force: true, recursive: true }).catch(swallowError("restore raw file cleanup"));
      await fsp.writeFile(fullPath, entry.content);
      await fsp.chmod(fullPath, entry.mode).catch(swallowError("restore raw file mode"));
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw file timestamps"));
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
      await fsp.chmod(fullPath, entry.mode).catch(swallowError("restore raw metadata directory mode"));
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw metadata directory timestamps"));
      restored.push(file);
      continue;
    }
    if (entry.kind === "file" && current.isFile()) {
      await fsp.chmod(fullPath, entry.mode).catch(swallowError("restore raw metadata file mode"));
      await fsp.utimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw metadata file timestamps"));
      restored.push(file);
      continue;
    }
    if (entry.kind === "symlink" && current.isSymbolicLink()) {
      await fsp.lutimes(fullPath, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(swallowError("restore raw metadata symlink timestamps"));
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
    await fsp.rmdir(current).catch(swallowError("prune empty raw parent"));
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

function rawFingerprintForBuffer(
  file: string,
  kind: RawContentSnapshotEntry["kind"],
  content: Buffer,
  options: RawSnapshotFingerprintOptions
): string {
  const normalized = kind === "file"
    ? Buffer.from(options.fileFingerprint?.(file, content) ?? content)
    : content;
  return contentFingerprint(Buffer.concat([Buffer.from(rawKindFingerprint(kind)), normalized]));
}

function rawEntryIdentity(entry: RawContentSnapshotEntry): string | undefined {
  if (entry.kind === "directory") return `${entry.dev}:${entry.ino}`;
  return `${entry.dev}:${entry.ino}:${entry.nlink}`;
}

function rawEntryIdentityFromStat(stat: { dev: number; ino: number; nlink: number; isDirectory(): boolean }): string {
  if (stat.isDirectory()) return `${stat.dev}:${stat.ino}`;
  return `${stat.dev}:${stat.ino}:${stat.nlink}`;
}

function rawKindFingerprint(kind: RawContentSnapshotEntry["kind"]): string {
  return `${kind}\0`;
}
