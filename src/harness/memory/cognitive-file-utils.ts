/**
 * cognitive-file-utils.ts — tiny shared filesystem helpers for the cognitive
 * state stores (personality, user profile, dream state, secondary memory).
 * Kept dependency-free so tests can run them under plain Node.
 */

import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

const { randomUUID } = getDesktopCrypto();


const { lstat, mkdir, readFile, rename, writeFile } = getDesktopFsPromises();
const path = getDesktopPath();

export async function cognitivePathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function cognitiveAtomicWrite(
  target: string,
  content: string | Uint8Array
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(
    temporary,
    content,
    typeof content === "string" ? { encoding: "utf8", mode: 0o600 } : { mode: 0o600 }
  );
  await rename(temporary, target);
}

export async function cognitiveWriteJson(target: string, value: unknown): Promise<void> {
  await cognitiveAtomicWrite(target, `${JSON.stringify(value, null, 2)}\n`);
}

export async function cognitiveReadJsonOrNull<T>(target: string): Promise<T | null> {
  if (!(await cognitivePathExists(target))) return null;
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function cognitiveReadTextOrEmpty(target: string): Promise<string> {
  if (!(await cognitivePathExists(target))) return "";
  return await readFile(target, "utf8");
}

export function cognitiveJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function newCognitiveId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function normalizeTextForDedupe(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();
}
