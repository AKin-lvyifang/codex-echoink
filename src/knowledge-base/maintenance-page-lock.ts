/** Shared in-process gate; persisted P1 records restore holds before maintenance resumes. */
const owners = new Map<string, Set<string>>();
const flights = new Map<string, Promise<unknown>>();
const released = new Set<() => void>();
const key = (vault: string, path: string) => `${vault}\0${path}`;
export function holdMaintenancePages(owner: string, vault: string, paths: readonly string[]): void { owners.set(owner, new Set(paths.map(path => key(vault, path)))); }
export function releaseMaintenancePages(owner: string): void { owners.delete(owner); for (const listener of released) listener(); }
export function maintenancePageIsHeld(vault: string, path: string): boolean { return [...owners.values()].some(paths => paths.has(key(vault, path))); }
export async function serializeMaintenancePage<T>(vault: string, path: string, write: () => Promise<T>): Promise<T> {
  const id = key(vault, path), previous = flights.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  flights.set(id, next);
  try { return await next; } finally { if (flights.get(id) === next) flights.delete(id); }
}
export async function backgroundMaintenancePageWrite(vault: string, path: string, write: () => Promise<void>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (maintenancePageIsHeld(vault, path)) await new Promise<void>(resolve => {
      const done = () => { if (!maintenancePageIsHeld(vault, path) || signal.aborted) { released.delete(done); signal.removeEventListener("abort", done); resolve(); } };
      released.add(done); signal.addEventListener("abort", done, { once: true }); done();
    });
    if (signal.aborted) return;
    const written = await serializeMaintenancePage(vault, path, async () => {
      if (maintenancePageIsHeld(vault, path)) return false;
      await write(); return true;
    });
    if (written) return;
  }
}
