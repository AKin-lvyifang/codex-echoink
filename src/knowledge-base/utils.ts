import * as fs from "fs";
import * as fsp from "fs/promises";

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
