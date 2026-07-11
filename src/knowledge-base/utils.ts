import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { isMissingPathError, swallowError } from "../core/error-handling";
export { isMissingPathError };
export { normalizeSlashes } from "../core/path-utils";

export interface WalkFilesOptions {
  maxFiles?: number;
  shouldSkipEntry?: (entry: fs.Dirent, absolutePath: string) => boolean;
  shouldIncludeFile?: (entry: fs.Dirent, absolutePath: string) => boolean;
  onDirectory?: (entry: fs.Dirent, absolutePath: string) => void | Promise<void>;
  onReadDirError?: (error: unknown, absolutePath: string) => void | Promise<void>;
}

export async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

export function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateForFile(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function writeFileAtomic(absolutePath: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  const temp = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content);
    await fsp.rename(temp, absolutePath);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(swallowError("remove failed atomic write temp file"));
    throw error;
  }
}

export async function walkExistingEntries(rootPath: string): Promise<string[]> {
  const stat = await fsp.lstat(rootPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) return [rootPath];
  const result = [rootPath];
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    result.push(...await walkExistingEntries(path.join(rootPath, entry.name)));
  }
  return result;
}

export async function walkFiles(dir: string, options: WalkFilesOptions = {}): Promise<string[]> {
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    if (options.maxFiles !== undefined && result.length >= options.maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (options.onReadDirError) {
        await options.onReadDirError(error, current);
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (options.maxFiles !== undefined && result.length >= options.maxFiles) return;
      const full = path.join(current, entry.name);
      if (options.shouldSkipEntry?.(entry, full)) continue;
      if (entry.isDirectory()) {
        await options.onDirectory?.(entry, full);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.shouldIncludeFile && !options.shouldIncludeFile(entry, full)) continue;
      result.push(full);
    }
  }
  await walk(dir);
  return result;
}
