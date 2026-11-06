import type { MemoryActivityState } from "./memory-relevance";

export const MEMORY_ACTIVITY_PATH = "shared-user/.runtime/memory-activity.json";
export interface MemoryActivityPort {
  read(): Promise<string | null>;
  write(content: string, expected: string | null): Promise<void>;
}
const lanes = new Map<string, Promise<unknown>>();
export function emptyMemoryActivity(vaultId: string, now: number): MemoryActivityState {
  return { version: 1, vaultId, initializedAt: new Date(now).toISOString(), records: {} };
}
export function parseMemoryActivity(raw: string, vaultId: string): MemoryActivityState {
  const state = JSON.parse(raw) as MemoryActivityState;
  if (!state || state.version !== 1 || state.vaultId !== vaultId || !Number.isFinite(Date.parse(state.initializedAt))
    || !state.records || typeof state.records !== "object" || Array.isArray(state.records)
    || Object.values(state.records).some(hit => !hit || !Number.isFinite(hit.lastRecalledAt) || hit.lastRecalledAt < 0 || !Number.isSafeInteger(hit.recallCount) || hit.recallCount < 0 || hit.lastTurnId !== undefined && typeof hit.lastTurnId !== "string")) throw new Error("memory_activity_invalid");
  return state;
}
export function mergeMemoryActivity(left: MemoryActivityState, right: MemoryActivityState): MemoryActivityState {
  const records = { ...left.records };
  for (const [id, hit] of Object.entries(right.records)) {
    const previous = records[id];
    records[id] = { ...((previous?.lastRecalledAt ?? -1) > hit.lastRecalledAt ? previous : hit), lastRecalledAt: Math.max(previous?.lastRecalledAt ?? 0, hit.lastRecalledAt), recallCount: Math.max(previous?.recallCount ?? 0, hit.recallCount) };
  }
  return { ...right, initializedAt: Date.parse(left.initializedAt) < Date.parse(right.initializedAt) ? left.initializedAt : right.initializedAt, records };
}

/** One portable, best-effort activity authority; adapters supply atomic file I/O. */
export class MemoryActivityStore {
  private cached?: MemoryActivityState;
  private readonly turns = new Map<string, Set<string>>();
  constructor(private readonly vaultId: string, private readonly port: MemoryActivityPort) {}
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const pending = (lanes.get(this.vaultId) ?? Promise.resolve()).catch(() => {}).then(run);
    lanes.set(this.vaultId, pending);
    void pending.finally(() => { if (lanes.get(this.vaultId) === pending) lanes.delete(this.vaultId); }).catch(() => {});
    return pending;
  }
  private async load(now: number) {
    const raw = await this.port.read();
    const disk = raw === null ? emptyMemoryActivity(this.vaultId, now) : parseMemoryActivity(raw, this.vaultId);
    if (raw === null || this.cached?.initializedAt !== disk.initializedAt) { this.cached = undefined; this.turns.clear(); }
    return { raw, state: this.cached ? mergeMemoryActivity(this.cached, disk) : disk };
  }
  async peek(now: number): Promise<MemoryActivityState> {
    try { const raw = await this.port.read(); return raw === null ? emptyMemoryActivity(this.vaultId, now) : parseMemoryActivity(raw, this.vaultId); }
    catch { return emptyMemoryActivity(this.vaultId, now); }
  }
  async snapshot(now: number): Promise<MemoryActivityState> {
    try {
      return await this.enqueue(async () => {
        const { raw, state } = await this.load(now);
        if (raw === null) await this.port.write(JSON.stringify(state) + "\n", null);
        this.cached = state;
        return structuredClone(state);
      });
    } catch { return emptyMemoryActivity(this.vaultId, now); }
  }
  async record(ids: readonly string[], turnId: string, now: number): Promise<boolean> {
    if (!ids.length) return true;
    try {
      return await this.enqueue(async () => {
        const { raw, state } = await this.load(now);
        const seen = this.turns.get(turnId) ?? new Set<string>();
        const pending = [...new Set(ids)].filter(id => !seen.has(id) && state.records[id]?.lastTurnId !== turnId);
        if (!pending.length) return true;
        for (const id of pending) {
          const hit = state.records[id];
          state.records[id] = { lastRecalledAt: Math.max(now, hit?.lastRecalledAt ?? 0), recallCount: (hit?.recallCount ?? 0) + 1, lastTurnId: turnId };
        }
        await this.port.write(JSON.stringify(state) + "\n", raw);
        this.cached = state;
        for (const id of pending) seen.add(id);
        this.turns.set(turnId, seen);
        if (this.turns.size > 128) { const oldest = [...this.turns.keys()][0]; if (oldest !== undefined) this.turns.delete(oldest); }
        return true;
      });
    } catch { return false; }
  }
  /** Restoring fading changes activity only; no Memory revision or content. */
  async restore(id: string, now: number): Promise<boolean> {
    try {
      return await this.enqueue(async () => {
        const { raw, state } = await this.load(now);
        state.records[id] = { ...state.records[id], lastRecalledAt: now, recallCount: state.records[id]?.recallCount ?? 0 };
        await this.port.write(JSON.stringify(state) + "\n", raw);
        this.cached = state;
        return true;
      });
    } catch { return false; }
  }
}
