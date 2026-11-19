import { getDesktopPath } from "../../platform/desktop-paths";
import { cognitivePathExists, cognitiveReadJsonOrNull, cognitiveWriteJson } from "./cognitive-file-utils";
import { DREAM_EXPERIENCE_INBOX_RELATIVE_PATH, defaultDreamExperienceInboxState, appendDreamPublicExperience, markDreamExperiencesEvaluated, parseDreamExperienceInboxState, markDreamExperiencesReconciled, type DreamExperienceInboxState, type DreamPublicExperienceInput } from "./dream-experience-core";
export * from "./dream-experience-core";
const path = getDesktopPath();
const fileLanes = new Map<string, Promise<unknown>>();
export class DreamExperienceInboxStore {
  readonly filePath: string;

  constructor(root: string) {
    this.filePath = path.join(root, DREAM_EXPERIENCE_INBOX_RELATIVE_PATH);
  }

  async read(): Promise<DreamExperienceInboxState> {
    return await this.readFresh();
  }

  async append(input: DreamPublicExperienceInput, now = Date.now()): Promise<DreamExperienceInboxState> {
    return await this.withLane(async () => {
      const next = appendDreamPublicExperience(await this.readFresh(), input, now);
      await cognitiveWriteJson(this.filePath, next);
      return next;
    });
  }

  /**
   * Merge evaluation marks into the newest disk snapshot while holding the
   * same lane used by foreground appends. The callback must commit the supplied
   * state inside the Repository transaction; a failed callback leaves it
   * unevaluated and therefore retryable.
   */
  async commitEvaluations<T>(
    fingerprints: ReadonlySet<string>,
    now: number,
    commit: (next: DreamExperienceInboxState) => Promise<T>
  ): Promise<Readonly<{ result: T; state: DreamExperienceInboxState }>> {
    return await this.withLane(async () => {
      const next = markDreamExperiencesEvaluated(await this.readFresh(), fingerprints, now);
      const result = await commit(next);
      return Object.freeze({ result, state: next });
    });
  }

  async commitCorrections<T>(fingerprints: ReadonlySet<string>, now: number, commit: (next: DreamExperienceInboxState) => Promise<T>): Promise<T> {
    return await this.withLane(async () => {
      const current = await this.readFresh();
      const next = markDreamExperiencesReconciled(current, fingerprints, now);
      return await commit(next);
    });
  }

  private async readFresh(): Promise<DreamExperienceInboxState> {
    const raw = await cognitiveReadJsonOrNull<Record<string, unknown>>(this.filePath);
    if (!raw) {
      if (await cognitivePathExists(this.filePath)) {
        throw new Error("dream_experience_inbox_invalid:unparseable_json");
      }
      return defaultDreamExperienceInboxState();
    }
    const parsed = parseDreamExperienceInboxState(raw);
    if (!parsed) throw new Error("dream_experience_inbox_invalid:field_parse_failed");
    return parsed;
  }

  private async withLane<T>(action: () => Promise<T>): Promise<T> {
    const previous = fileLanes.get(this.filePath) ?? Promise.resolve();
    const current = previous.then(action, action);
    fileLanes.set(this.filePath, current);
    try {
      return await current;
    } finally {
      if (fileLanes.get(this.filePath) === current) fileLanes.delete(this.filePath);
    }
  }
}
