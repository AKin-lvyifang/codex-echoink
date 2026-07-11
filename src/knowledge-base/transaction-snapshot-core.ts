import { createHash } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { normalizePath } from "obsidian";
import { swallowError } from "../core/error-handling";
import { walkExistingEntries } from "./utils";

export interface KnowledgeTransactionSnapshot {
  vaultPath: string;
  roots: string[];
  entries: Map<string, KnowledgeTransactionSnapshotEntry>;
  tempDir?: string;
}

export interface KnowledgeTransactionSnapshotEntry {
  kind: "file" | "directory" | "symlink" | "special";
  content?: Buffer;
  contentPath?: string;
  contentHash?: string;
  size?: number;
  target?: string;
  nlink?: number;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

export interface KnowledgeTransactionSnapshotOptions {
  fileStorageThreshold?: number;
}

export const KNOWLEDGE_TRANSACTION_FILE_STORAGE_THRESHOLD = 50;

export async function snapshotKnowledgeTransactionEntries(
  vaultPath: string,
  roots: string[],
  options: KnowledgeTransactionSnapshotOptions = {}
): Promise<KnowledgeTransactionSnapshot> {
  const records: Array<{ absolutePath: string; relativePath: string; stat: fs.Stats }> = [];
  for (const root of roots) {
    const absolute = path.join(vaultPath, root);
    const paths = await walkExistingEntries(absolute);
    for (const entryPath of paths) {
      records.push({
        absolutePath: entryPath,
        relativePath: normalizePath(path.relative(vaultPath, entryPath)),
        stat: await fsp.lstat(entryPath)
      });
    }
  }

  const threshold = options.fileStorageThreshold ?? KNOWLEDGE_TRANSACTION_FILE_STORAGE_THRESHOLD;
  const fileCount = records.filter((record) => record.stat.isFile()).length;
  const useTempFiles = fileCount > threshold;
  const tempDir = useTempFiles ? await fsp.mkdtemp(path.join(tmpdir(), "echoink-kb-snapshot-")) : undefined;
  const entries: KnowledgeTransactionSnapshot["entries"] = new Map();
  let tempFileIndex = 0;

  for (const record of records) {
    const { absolutePath, relativePath, stat } = record;
    if (stat.isDirectory()) {
      entries.set(relativePath, {
        kind: "directory",
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs
      });
    } else if (stat.isSymbolicLink()) {
      entries.set(relativePath, {
        kind: "symlink",
        target: await fsp.readlink(absolutePath),
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs
      });
    } else if (stat.isFile()) {
      entries.set(relativePath, await snapshotFileEntry(absolutePath, stat, tempDir, tempFileIndex++));
    } else {
      entries.set(relativePath, {
        kind: "special",
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  return { vaultPath, roots: roots.map((root) => normalizePath(root)), entries, tempDir };
}

export async function readKnowledgeTransactionEntryContent(entry: KnowledgeTransactionSnapshotEntry | undefined): Promise<Buffer | null> {
  if (!entry || entry.kind !== "file") return null;
  if (entry.content) return entry.content;
  if (entry.contentPath) return fsp.readFile(entry.contentPath);
  return null;
}

export async function disposeKnowledgeTransactionSnapshot(snapshot: KnowledgeTransactionSnapshot | null | undefined): Promise<void> {
  if (!snapshot?.tempDir) return;
  await fsp.rm(snapshot.tempDir, { recursive: true, force: true }).catch(swallowError("dispose transaction snapshot temp directory"));
  snapshot.tempDir = undefined;
}

async function snapshotFileEntry(
  absolutePath: string,
  stat: fs.Stats,
  tempDir: string | undefined,
  tempFileIndex: number
): Promise<KnowledgeTransactionSnapshotEntry> {
  if (!tempDir) {
    const content = await fsp.readFile(absolutePath);
    return {
      kind: "file",
      content,
      contentHash: hashBuffer(content),
      size: stat.size,
      nlink: stat.nlink,
      mode: stat.mode,
      atimeMs: stat.atimeMs,
      mtimeMs: stat.mtimeMs
    };
  }

  const contentPath = path.join(tempDir, `file-${String(tempFileIndex).padStart(6, "0")}`);
  await fsp.copyFile(absolutePath, contentPath);
  return {
    kind: "file",
    contentPath,
    contentHash: await hashFile(contentPath),
    size: stat.size,
    nlink: stat.nlink,
    mode: stat.mode,
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs
  };
}

function hashBuffer(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}
