import { getDesktopPath } from "../../platform/desktop-paths";
import { cognitiveReadJsonOrNull, cognitiveWriteJson } from "./cognitive-file-utils";
import { DREAM_STATE_RELATIVE_PATH, defaultDreamState, parseDreamState, type DreamState } from "./dream-state-core";

const path = getDesktopPath();
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
    this.cache = raw ? parseDreamState(raw) ?? defaultDreamState() : defaultDreamState();
    return this.cache;
  }

  /** Persist a new state (atomic). Updates the cache. */
  async write(state: DreamState): Promise<void> {
    this.cache = state;
    await cognitiveWriteJson(this.filePath, state);
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
