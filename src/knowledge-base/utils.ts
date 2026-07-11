import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

export async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

export function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
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
    await fsp.rm(temp, { force: true }).catch(() => undefined);
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
