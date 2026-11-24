import type { DataAdapter } from "obsidian";

export async function readMobileFile(adapter: DataAdapter, path: string): Promise<string | null> {
  return await adapter.exists(path) ? adapter.read(path) : null;
}

type FileComparison = (left: string | null, right: string | null) => boolean;

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length
    && left.every((value, index) => equalJson(value, right[index]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(right)) return false;
  const first = left as Record<string, unknown>, second = right as Record<string, unknown>;
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every(key => Object.hasOwn(second, key) && equalJson(first[key], second[key]));
}

/** Compare the full JSON document, including extension fields and array order. */
export function sameMobileJson(left: string | null, right: string | null, validate?: (raw: string) => unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  try {
    const first: unknown = JSON.parse(left), second: unknown = JSON.parse(right);
    validate?.(left); validate?.(right);
    return equalJson(first, second);
  } catch { return false; }
}

/** Install without relying on rename-overwrite; the caller owns backup cleanup. */
export async function replaceMobileFile(adapter: DataAdapter, path: string, content: string, expected: string | null, backupPath: string | undefined, conflict: () => Error, same: FileComparison = (left, right) => left === right): Promise<void> {
  const temporary = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  let moved = false;
  try {
    await adapter.write(temporary, content);
    if (!same(await readMobileFile(adapter, path), expected)) throw conflict();
    if (expected !== null) {
      if (!backupPath || await adapter.exists(backupPath)) throw conflict();
      await adapter.rename(path, backupPath);
      moved = true;
      // A change between the comparison and rename must also be preserved.
      if (!same(await adapter.read(backupPath), expected)) throw conflict();
    }
    await adapter.rename(temporary, path);
  } catch (error) {
    const errors = [error];
    try {
      if (moved && !await adapter.exists(path)) await adapter.rename(backupPath!, path);
    } catch (restoreError) { errors.push(restoreError); }
    try { if (await adapter.exists(temporary)) await adapter.remove(temporary); }
    catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, "保存失败，原资料与恢复备份已保留，恢复尚未完成。");
    throw error;
  }
}
