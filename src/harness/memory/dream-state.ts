import { getDesktopPath } from "../../platform/desktop-paths";
import { cognitivePathExists, cognitiveReadJsonOrNull, cognitiveWriteJson } from "./cognitive-file-utils";
import { DREAM_STATE_RELATIVE_PATH, defaultDreamState, parseDreamState, type DreamState } from "./dream-state-core";

const path = getDesktopPath();
const writeLanes = new Map<string, Promise<unknown>>();
export * from "./dream-state-core";

export class DreamStateStore {
  readonly filePath: string;
  private cache: DreamState | null = null;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, DREAM_STATE_RELATIVE_PATH);
  }

  async read(): Promise<DreamState> {
    if (this.cache) return this.cache;
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    if (!raw && await cognitivePathExists(this.filePath)) throw new Error("dream_state_invalid");
    this.cache = raw ? parseDreamState(raw) : defaultDreamState();
    if (!this.cache) throw new Error("dream_state_invalid");
    return this.cache;
  }

  /** Persist a new state (atomic). Updates the cache. */
  async write(state: DreamState): Promise<void> {
    await this.update(() => state);
  }

  /** Merge foreground enqueues and background diagnostics against the newest disk state. */
  async update(updater: (state: DreamState) => DreamState): Promise<DreamState> {
    return await this.commit(updater, async next => { await cognitiveWriteJson(this.filePath, next); });
  }

  /** Hold the same lane as foreground enqueues until a Repository transaction commits. */
  async commit(updater: (state: DreamState) => DreamState, commit: (state: DreamState) => Promise<void>): Promise<DreamState> {
    return await this.transaction(async current => {
      const state = updater(current);
      await commit(state);
      return { state, result: state };
    });
  }

  async transaction<T>(action: (current: DreamState) => Promise<{ state: DreamState; result: T }>): Promise<T> {
    const previous = writeLanes.get(this.filePath) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
      if (!raw && await cognitivePathExists(this.filePath)) throw new Error("dream_state_invalid");
      const current = raw ? parseDreamState(raw) : defaultDreamState();
      if (!current) throw new Error("dream_state_invalid");
      const committed = await action(current);
      this.cache = committed.state;
      return committed.result;
    });
    writeLanes.set(this.filePath, pending);
    try { return await pending; }
    finally { if (writeLanes.get(this.filePath) === pending) writeLanes.delete(this.filePath); }
  }

  /** Current cached state without disk IO (after at least one read). */
  peek(): DreamState {
    return this.cache ?? defaultDreamState();
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Update the cache after the state was committed through a transaction. */
  updateCache(state: DreamState): void {
    this.cache = state;
  }
}
