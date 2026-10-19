/** Desktop user Memory, profile and Dream lifecycle. Legacy Agent Self is mobile-only. */
import { inspectUserProfileStateFile, userProfileStateJson, UserProfileStateStore } from "./user-profile-state";
import { DreamStateStore, enqueuePendingMemoryIds } from "./dream-state";
import { DreamExperienceInboxStore } from "./dream-experience-inbox";
import { SecondaryMemoryStore, serializeSecondaryRecord } from "./secondary-memory-store";
import { DreamEngine, type DreamLlmPort, type DreamRepositoryPort, type DreamRunResult } from "./dream-engine";
import { DreamScheduler, type DreamSchedulerConfig } from "./dream-scheduler";
import type { PersonalMemoryRecord, SecondaryMemoryRecord } from "./personal-memory-contracts";
import type { PersonalMemoryRepository } from "./personal-memory-repository";

export interface CognitiveSystemOptions {
  readonly repository: PersonalMemoryRepository;
  readonly llm: () => DreamLlmPort | null;
  readonly getDreamConfig: () => DreamSchedulerConfig;
  readonly isForegroundBusy: () => boolean;
  readonly registerInterval: (handle: number) => void;
  readonly now?: () => number;
}

class RepositoryDreamPort implements DreamRepositoryPort {
  constructor(private readonly repository: PersonalMemoryRepository) {}

  async inspect(): Promise<Readonly<{ revision: number; records: readonly PersonalMemoryRecord[] }>> {
    const state = await this.repository.inspect();
    return Object.freeze({ revision: state.revision, records: state.records });
  }

  async readVaultId(): Promise<string> {
    return await this.repository.readVaultId();
  }

  async readFixedFiles(): Promise<Readonly<{
    user: string;
    userHash: string;
    userBytes: number;
  }>> {
    return await this.repository.inspectCognitiveFixedFiles();
  }

  async applyCognitiveUpdate(input: Readonly<{
    userContent?: string;
    secondaryRecords: readonly SecondaryMemoryRecord[];
    extraChanges: readonly Readonly<{ relativePath: string; content: string }>[];
    detail: string;
    expectedMemoryRevision: number;
    expectedUserProjectionHash?: string;
  }>): Promise<Readonly<{ revision: number }>> {
    return await this.repository.applyCognitiveUpdate(input);
  }

  async writeSystemMemory(input: Readonly<{
    kind: PersonalMemoryRecord["kind"];
    title: string;
    content: string;
    recallWhen: string;
    basis: PersonalMemoryRecord["basis"];
  }>): Promise<Readonly<{ id: string; revision: number }>> {
    const vaultId = await this.repository.readVaultId();
    const result = await this.repository.write({
      operation: "create",
      kind: input.kind,
      title: input.title,
      content: input.content,
      recallWhen: input.recallWhen,
      basis: input.basis,
      contentOrigin: "user_statement"
    } as never, {
      vaultId,
      conversationId: "echoink-dream",
      piSessionId: "echoink-dream",
      productRunId: "echoink-dream-migration",
      userEntryId: "dream",
      memoryMode: "normal",
      explicitlyAuthorized: true
    });
    return Object.freeze({ id: result.record!.id, revision: result.revision });
  }
}

export class CognitiveSystem {
  readonly repository: PersonalMemoryRepository;
  readonly profileStore: UserProfileStateStore;
  readonly dreamStateStore: DreamStateStore;
  readonly secondaryStore: SecondaryMemoryStore;
  readonly engine: DreamEngine;
  readonly scheduler: DreamScheduler;
  private readonly now: () => number;

  private constructor(options: CognitiveSystemOptions, parts: Readonly<{
    profileStore: UserProfileStateStore;
    dreamStateStore: DreamStateStore;
    secondaryStore: SecondaryMemoryStore;
    engine: DreamEngine;
    scheduler: DreamScheduler;
  }>) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.profileStore = parts.profileStore;
    this.dreamStateStore = parts.dreamStateStore;
    this.secondaryStore = parts.secondaryStore;
    this.engine = parts.engine;
    this.scheduler = parts.scheduler;
  }

  static async create(options: CognitiveSystemOptions): Promise<CognitiveSystem> {
    const secondaryStore = new SecondaryMemoryStore(options.repository.layout.history);
    options.repository.setSecondaryRecords(await secondaryStore.loadAll());
    const layout = await options.repository.initialize();
    await options.repository.ensureSecondaryIndexFresh();

    const root = layout.root;
    const profileStore = new UserProfileStateStore(root);
    const dreamStateStore = new DreamStateStore(root);
    const experienceInboxStore = new DreamExperienceInboxStore(root);
    const profileInspection = await inspectUserProfileStateFile(profileStore.filePath);
    if (profileInspection.kind === "invalid") {
      throw new Error(`user_profile_state_invalid:${profileInspection.reason}`);
    }
    if (profileInspection.kind === "v1") {
      try {
        await options.repository.applyCognitiveUpdate({
          secondaryRecords: await secondaryStore.loadAll(),
          extraChanges: [{
            relativePath: "shared-user/user-profile-state.json",
            content: userProfileStateJson(profileInspection.state)
          }],
          detail: "user-profile-v1-to-v2-migration"
        });
      } catch {
        throw new Error("user_profile_migration_blocked:transaction_failed");
      }
    }

    const engine = new DreamEngine({
      repository: new RepositoryDreamPort(options.repository),
      profileStore,
      secondaryStore,
      dreamStateStore,
      experienceInboxStore,
      llm: options.llm,
      ...(options.now ? { now: options.now } : {})
    });

    const system = new CognitiveSystem(options, {
      profileStore,
      dreamStateStore,
      secondaryStore,
      engine,
      scheduler: null as unknown as DreamScheduler
    });

    const scheduler = new DreamScheduler({
      engine,
      getConfig: options.getDreamConfig,
      isForegroundBusy: options.isForegroundBusy,
      readLastRunAt: async () => (await dreamStateStore.read()).lastRunAt,
      registerInterval: options.registerInterval,
      ...(options.now ? { now: options.now } : {})
    });
    (system as { scheduler: DreamScheduler }).scheduler = scheduler;

    options.repository.setSecondaryLifecycleHandler(async (input) =>
      await system.handleSecondaryLifecycle(input.operation, input.parentId)
    );
    options.repository.setSecondaryRefreshProvider(async () =>
      await secondaryStore.refresh()
    );
    options.repository.setMemoryCommittedHook((event) => {
      void system.enqueueForDream([event.recordId]).catch(() => {});
    });
    options.repository.setSecondaryChangedHook((records) => {
      secondaryStore.setCache(records);
    });

    return system;
  }

  async listSecondaryForParent(parentId: string): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.listForParent(parentId);
  }

  async listAllSecondary(): Promise<readonly SecondaryMemoryRecord[]> {
    return await this.secondaryStore.loadAll();
  }

  async updateSecondaryFact(parentId: string, secondaryId: string, edits: Readonly<{
    title?: string;
    content?: string;
    recallWhen?: string;
    matchTerms?: readonly string[];
    reason?: string;
  }>, expectedRevision: number): Promise<Readonly<{
    revision: number;
    record: SecondaryMemoryRecord;
  }>> {
    const result = await this.repository.applySecondaryUserMutation({
      operation: "edit",
      parentId,
      secondaryId,
      expectedRevision,
      edits
    });
    if (!result.record) throw new Error("secondary_edit_missing_result");
    return Object.freeze({ revision: result.revision, record: result.record });
  }

  async deleteSecondaryFact(
    parentId: string,
    secondaryId: string,
    expectedRevision: number
  ): Promise<Readonly<{ revision: number }>> {
    const result = await this.repository.applySecondaryUserMutation({
      operation: "delete",
      parentId,
      secondaryId,
      expectedRevision
    });
    return Object.freeze({ revision: result.revision });
  }

  startDreamScheduler(): void {
    this.scheduler.start();
  }

  async forceDreamRun(): Promise<DreamRunResult | null> {
    return await this.scheduler.forceRun();
  }

  async dispose(): Promise<void> {
    this.scheduler.dispose();
    await this.repository.dispose();
    await this.settleDreamEnqueue();
  }

  private enqueueLane: Promise<void> = Promise.resolve();

  async settleDreamEnqueue(): Promise<void> {
    await this.enqueueLane;
  }

  async enqueueForDream(memoryIds: readonly string[]): Promise<void> {
    const run = async (): Promise<void> => {
      const state = await this.dreamStateStore.read();
      const next = enqueuePendingMemoryIds(state, memoryIds, this.now());
      if (next !== state) await this.dreamStateStore.write(next);
    };
    const lane = this.enqueueLane.then(run, run);
    this.enqueueLane = lane.catch(() => undefined);
    return lane;
  }

  private async handleSecondaryLifecycle(
    operation: "supersede" | "forget" | "restore" | "close",
    parentId: string
  ): Promise<Readonly<{
    records: readonly SecondaryMemoryRecord[];
    changedFiles: readonly Readonly<{ relativePath: string; content: string }>[];
  }>> {
    const records = [...(await this.secondaryStore.loadAll())];
    const changedFiles: Array<{ relativePath: string; content: string }> = [];
    const now = this.now();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.parentId !== parentId) continue;
      if (operation === "restore") {
        if (record.status !== "disabled") continue;
        if (record.disabledReason !== null && record.disabledReason !== "parent_lifecycle") continue;
        const updated: SecondaryMemoryRecord = Object.freeze({
          ...record,
          status: "current",
          disabledReason: null,
          revision: record.revision + 1,
          updatedAt: now
        });
        records[index] = updated;
        changedFiles.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      } else {
        if (record.status !== "current") continue;
        const updated: SecondaryMemoryRecord = Object.freeze({
          ...record,
          status: "disabled",
          disabledReason: "parent_lifecycle",
          revision: record.revision + 1,
          updatedAt: now
        });
        records[index] = updated;
        changedFiles.push({ relativePath: updated.file, content: serializeSecondaryRecord(updated) });
      }
    }
    return Object.freeze({ records: Object.freeze(records), changedFiles: Object.freeze(changedFiles) });
  }
}
