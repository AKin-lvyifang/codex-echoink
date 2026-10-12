import type { DataAdapter } from "obsidian";

export async function readMobileFile(adapter: DataAdapter, path: string): Promise<string | null> {
  return await adapter.exists(path) ? adapter.read(path) : null;
}

/** Install without relying on rename-overwrite; the caller owns backup cleanup. */
export async function replaceMobileFile(adapter: DataAdapter, path: string, content: string, expected: string | null, backupPath: string | undefined, conflict: () => Error): Promise<void> {
  const temporary = `${path}.${Math.random().toString(36).slice(2)}.tmp`;
  let moved = false;
  try {
    await adapter.write(temporary, content);
    if (await readMobileFile(adapter, path) !== expected) throw conflict();
    if (expected !== null) {
      if (!backupPath || await adapter.exists(backupPath)) throw conflict();
      await adapter.rename(path, backupPath);
      moved = true;
      // A change between the comparison and rename must also be preserved.
      if (await adapter.read(backupPath) !== expected) throw conflict();
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
