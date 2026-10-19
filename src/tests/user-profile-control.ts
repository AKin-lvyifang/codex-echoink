import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PersonalMemoryRepository,
  type PersonalMemoryRepositoryOptions,
  type PersonalMemoryRuntimeContext
} from "../harness/memory/personal-memory-repository";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { DreamExperienceInboxStore, type DreamPublicExperienceInput } from "../harness/memory/dream-experience-inbox";
import type { DreamLlmPort } from "../harness/memory/dream-engine";
import {
  USER_OBSERVED_MIN_SOURCES,
  USER_PROFILE_SLOTS,
  UserProfileStateStore,
  applyDreamProfileUpdate,
  emptyUserProfileState,
  parseUserProfileState,
  rebindProfileSource,
  reconcileProfileSources,
  revokeReprocessedProfileSources
} from "../harness/memory/user-profile-state";

interface Fixture {
  repository: PersonalMemoryRepository;
  now(): number;
  runtime(input?: Partial<PersonalMemoryRuntimeContext>): PersonalMemoryRuntimeContext;
  reopen(): Promise<PersonalMemoryRepository>;
  fault(operation: string | null): void;
}

async function withFixture(name: string, callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = process.env.ECHOINK_USER_PROFILE_TEST_RUN_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("Explicit profile test run root is required");
  const vaultPath = await mkdtemp(path.join(root, `${name}-`));
  const vaultId = `p13-${path.basename(vaultPath)}`;
  let clock = 1_800_000_000_000;
  let id = 0;
  let fault: string | null = null;
  const repositories: PersonalMemoryRepository[] = [];
  const now = () => ++clock;
  const create = async () => {
    const options: PersonalMemoryRepositoryOptions = {
      vaultPath, vaultId, now, idFactory: () => `mem_p13_${++id}`,
      watchExternalChanges: false,
      failTransactionAfterChange: (operation, count) => {
        if (count !== 1) return false;
        if (fault === `crash:${operation}`) return true;
        if (fault === operation) throw new Error("p13_injected_write_failure");
        return false;
      }
    };
    const repository = new PersonalMemoryRepository(options);
    repositories.push(repository);
    await repository.initialize();
    return repository;
  };
  try {
    await callback({
      repository: await create(), now, reopen: create,
      fault: (operation) => { fault = operation; },
      runtime: (input = {}) => ({
        vaultId, conversationId: "p13-conversation", piSessionId: "p13-session",
        productRunId: "p13-run", userEntryId: "p13-user-entry", memoryMode: "normal", ...input
      })
    });
  } finally {
    await Promise.all(repositories.map((repository) => repository.dispose()));
    await rm(vaultPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function createSystem(fixture: Fixture, repository: PersonalMemoryRepository, call: DreamLlmPort["call"] | null) {
  return await CognitiveSystem.create({
    repository, llm: () => call ? { call } : null,
    getDreamConfig: () => ({ enabled: false, runsPerDay: 1 }),
    isForegroundBusy: () => false, registerInterval: () => undefined, now: fixture.now
  });
}

async function save(repository: PersonalMemoryRepository, profileKey: string, text: string) {
  const snapshot = await repository.readUserProfileControlSnapshot();
  return await repository.saveUserProfileFromUserControl({ profileKey, text, expectedRevision: snapshot.revision });
}

async function remove(repository: PersonalMemoryRepository, profileKey: string) {
  const snapshot = await repository.readUserProfileControlSnapshot();
  return await repository.deleteUserProfileFromUserControl({ profileKey, expectedRevision: snapshot.revision });
}

async function memoryBytes(repository: PersonalMemoryRepository) {
  const records = (await repository.inspect()).records;
  return await Promise.all(records.map(async (record) => [
    record.id, await readFile(path.join(repository.layout.root, record.file), "utf8")
  ]));
}

function experience(fixture: Fixture, id: number, text: string): DreamPublicExperienceInput {
  return {
    conversationId: `p13-experience-conversation-${id}`, productRunId: `p13-experience-run-${id}`,
    userEntryId: `p13-user-${id}`, assistantEntryId: `p13-assistant-${id}`,
    occurredAt: fixture.now(), userText: text, assistantText: "已按要求完成。",
    taskResult: { terminalState: "completed", successfulToolNames: [], failedToolNames: [] }
  };
}

async function localControlsAndValidation(): Promise<void> {
  await withFixture("local", async (fixture) => {
    const repository = fixture.repository;
    await createSystem(fixture, repository, null);
    assert.deepEqual((await repository.readUserProfileControlSnapshot()).items, []);
    await assert.rejects(repository.write({
      operation: "create", kind: "fact", title: "关闭记忆", content: "不应由运行时写入", basis: "explicit"
    }, fixture.runtime({ memoryMode: "no_memory" })));
    await save(repository, "identity.name", "  方哥  ");
    await save(repository, "identity.role", "产品经理");
    let snapshot = await repository.readUserProfileControlSnapshot();
    assert.equal(snapshot.items.find((item) => item.profileKey === "identity.name")?.text, "方哥");
    for (const input of [
      { profileKey: "identity.name", text: "  " },
      { profileKey: "unknown.slot", text: "未知" },
      { profileKey: "identity.name", text: "长".repeat(121) }
    ]) {
      await assert.rejects(repository.saveUserProfileFromUserControl({ ...input, expectedRevision: snapshot.revision }));
    }
    await assert.rejects(repository.deleteUserProfileFromUserControl({ profileKey: "unknown.slot", expectedRevision: snapshot.revision }));
    await assert.rejects(repository.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "方哥", expectedRevision: undefined as never }));
    assert.deepEqual(await repository.readUserProfileControlSnapshot(), snapshot);
    assert.equal((await save(repository, "identity.name", "方哥")).revision, snapshot.revision, "retry is idempotent");
    await save(repository, "identity.name", "阿方");
    const records = (await repository.inspect()).records;
    assert.ok(records.some((record) => record.status === "current" && record.source === "ui://user-profile-control"));
    const bytes = await memoryBytes(repository);
    await remove(repository, "identity.name");
    snapshot = await repository.readUserProfileControlSnapshot();
    assert.deepEqual(snapshot.items.map((item) => item.profileKey), ["identity.role"]);
    assert.deepEqual(await memoryBytes(repository), bytes, "slot deletion retains all primary Memory bytes");
    assert.deepEqual((await repository.inspect()).records, records);
  });
  console.log("PASS local controls without Provider/runtime Memory; validation and single-slot deletion");
}

async function observedConfirmationAndWholeSlotDeletion(): Promise<void> {
  await withFixture("observed", async (fixture) => {
    assert.equal(USER_OBSERVED_MIN_SOURCES, 2);
    for (let index = 0; index < 2; index += 1) {
      await fixture.repository.write({
        operation: "create", kind: "view", title: `观察呈现方式 ${index}`,
        content: `第 ${index} 次任务先看结论再看依据`, basis: "observed"
      }, fixture.runtime({ productRunId: `p13-observed-run-${index}`, conversationId: `p13-observed-conversation-${index}` }));
    }
    const system = await createSystem(fixture, fixture.repository, async (request) =>
      request.systemPrompt.includes("本次只输出 Agent current-self") ? "no_change" : JSON.stringify({
        secondaryFacts: [], userProfileItems: [{ section: "preference", profileKey: "preference.format", text: "先看结论再看依据" }]
      }));
    assert.equal((await system.engine.runOnce()).committed, true);
    const observed = (await fixture.repository.readUserProfileControlSnapshot()).items[0]!;
    assert.equal(observed.basis, "observed_memory");
    assert.equal(observed.sourceMemoryIds.length, 2);
    await save(fixture.repository, observed.profileKey, observed.text);
    const confirmed = await fixture.repository.readUserProfileControlSnapshot();
    assert.equal(confirmed.items.length, 1, "explicit hides the same slot's observed value");
    assert.equal(confirmed.items[0]?.basis, "explicit_memory");
    const bytes = await memoryBytes(fixture.repository);
    await remove(fixture.repository, observed.profileKey);
    assert.equal((await fixture.repository.readUserProfileControlSnapshot()).items.length, 0);
    assert.equal((await new UserProfileStateStore(fixture.repository.layout.root).read())?.items.some((item) => item.profileKey === observed.profileKey), false);
    assert.deepEqual(await memoryBytes(fixture.repository), bytes);
  });
  console.log("PASS observed threshold, local confirmation, explicit priority and both-basis slot deletion");
}

async function deletionSurvivesReloadAndDreamReplay(): Promise<void> {
  await withFixture("replay", async (fixture) => {
    const oldText = "我偏好直接清晰的语气";
    await save(fixture.repository, "preference.tone", oldText);
    await save(fixture.repository, "identity.role", "产品经理");
    const inbox = new DreamExperienceInboxStore(fixture.repository.layout.root);
    await inbox.append(experience(fixture, 1, oldText), fixture.now());
    const bytes = await memoryBytes(fixture.repository);
    await remove(fixture.repository, "preference.tone");
    const reopened = await fixture.reopen();
    assert.deepEqual(await memoryBytes(reopened), bytes);
    let targetText = oldText;
    let memoryCalls = 0;
    let experienceCalls = 0;
    const system = await createSystem(fixture, reopened, async (request) => {
      if (!request.systemPrompt.includes("本次只输出 Agent current-self")) {
        memoryCalls += 1;
        const input = JSON.parse(request.userPrompt) as { memory: { content: string } };
        return JSON.stringify({ secondaryFacts: [], userProfileItems: input.memory.content === targetText
          ? [{ section: "preference", profileKey: "preference.tone", text: targetText }] : [] });
      }
      const input = JSON.parse(request.userPrompt) as { sources: Array<{ sourceId: string; userText?: string; content?: string }> };
      const sources = input.sources.filter((source) => source.userText === targetText || source.content === targetText);
      if (sources.some((source) => source.userText)) experienceCalls += 1;
      return JSON.stringify({ userProfileItems: sources.length ? [{
        section: "preference", profileKey: "preference.tone", text: targetText, basis: "explicit",
        sources: sources.map((source) => ({ sourceId: source.sourceId, evidenceQuote: targetText }))
      }] : [] });
    });
    assert.equal((await system.engine.runOnce()).committed, true);
    assert.ok(memoryCalls > 0 && experienceCalls > 0, "old Memory and old Experience really reached both Dream routes");
    assert.equal((await reopened.readUserProfileControlSnapshot()).items.some((item) => item.profileKey === "preference.tone"), false);
    assert.equal((await new UserProfileStateStore(reopened.layout.root).read())?.deletionBarriers?.length, 1);
    targetText = "我偏好温和简洁的语气";
    await reopened.write({ operation: "create", kind: "fact", title: "新语气偏好", content: targetText, basis: "explicit", contentOrigin: "user_statement" }, fixture.runtime({ productRunId: "p13-new-memory" }));
    assert.equal((await system.engine.runOnce()).committed, true);
    assert.equal((await reopened.readUserProfileControlSnapshot()).items.find((item) => item.profileKey === "preference.tone")?.text, targetText, "new Memory revision may refill the deleted slot");
    await remove(reopened, "preference.tone");
    targetText = "我偏好平静自然的语气";
    await inbox.append(experience(fixture, 2, targetText), fixture.now());
    assert.equal((await system.engine.runOnce()).committed, true);
    assert.equal((await reopened.readUserProfileControlSnapshot()).items.find((item) => item.profileKey === "preference.tone")?.text, targetText, "genuinely later Experience may refill the slot");
    await remove(reopened, "identity.role");
    await save(reopened, "preference.tone", oldText);
    const barriers = (await new UserProfileStateStore(reopened.layout.root).read())?.deletionBarriers;
    assert.deepEqual(barriers?.map((entry) => entry.profileKey), ["identity.role"], "explicit refill clears only its own deletion barrier");
  });
  console.log("PASS durable old-evidence suppression across reload and real Dream, new evidence and explicit refill");
}

async function concurrentControlsRejectStaleRevisions(): Promise<void> {
  await withFixture("cas", async (fixture) => {
    const other = await fixture.reopen();
    const initial = await other.readUserProfileControlSnapshot();
    await save(fixture.repository, "identity.name", "方哥");
    await assert.rejects(other.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "旧草稿", expectedRevision: initial.revision }), /revision conflict/iu);
    await assert.rejects(other.deleteUserProfileFromUserControl({ profileKey: "identity.name", expectedRevision: initial.revision }), /revision conflict/iu);
    const current = await other.readUserProfileControlSnapshot();
    assert.equal(current.items[0]?.text, "方哥", "another instance reads the new committed disk revision");
    const results = await Promise.allSettled([fixture.repository, other].map((repository, index) =>
      repository.saveUserProfileFromUserControl({ profileKey: "identity.name", text: `并发 ${index}`, expectedRevision: current.revision })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  });
  console.log("PASS two-repository read consistency and stale/concurrent mutation rejection");
}

async function inFlightDreamCannotRestoreDeletedSlot(): Promise<void> {
  for (const pauseAt of ["profile-read", "provider"] as const) await withFixture(`dream-cas-${pauseAt}`, async (fixture) => {
    await save(fixture.repository, "preference.tone", "我偏好直接清晰的语气");
    let entered!: () => void;
    let release!: () => void;
    const inProvider = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const system = await createSystem(fixture, fixture.repository, async (request) => {
      if (request.systemPrompt.includes("本次只输出 Agent current-self")) return "no_change";
      if (pauseAt === "provider") {
        entered();
        await resume;
      }
      return JSON.stringify({ secondaryFacts: [], userProfileItems: [{ section: "preference", profileKey: "preference.tone", text: "我偏好直接清晰的语气" }] });
    });
    if (pauseAt === "profile-read") {
      const readProfile = system.profileStore.read.bind(system.profileStore);
      system.profileStore.read = async () => {
        const state = await readProfile();
        entered();
        await resume;
        return state;
      };
    }
    const pending = system.engine.runOnce();
    await inProvider;
    try { await remove(fixture.repository, "preference.tone"); } finally { release(); }
    const result = await pending;
    assert.equal(result.committed, false);
    assert.match(result.error ?? "", /revision conflict/iu);
    assert.equal((await fixture.repository.readUserProfileControlSnapshot()).items.length, 0);
  });
  console.log("PASS Dream CAS protects deletion during profile read and during Provider work");
}

async function transactionRollbackAndReadFailures(): Promise<void> {
  await withFixture("faults", async (fixture) => {
    await save(fixture.repository, "identity.name", "方哥");
    const previous = await fixture.repository.readUserProfileControlSnapshot();
    const state = await readFile(fixture.repository.layout.userProfileState, "utf8");
    const user = await readFile(fixture.repository.layout.user, "utf8");
    const bytes = await memoryBytes(fixture.repository);
    for (const operation of ["profile-delete", "profile-update"]) {
      fixture.fault(operation);
      await assert.rejects(operation === "profile-delete"
        ? fixture.repository.deleteUserProfileFromUserControl({ profileKey: "identity.name", expectedRevision: previous.revision })
        : fixture.repository.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "未提交", expectedRevision: previous.revision }));
      fixture.fault(null);
      assert.deepEqual(await fixture.repository.readUserProfileControlSnapshot(), previous);
      assert.equal(await readFile(fixture.repository.layout.userProfileState, "utf8"), state);
      assert.equal(await readFile(fixture.repository.layout.user, "utf8"), user);
      assert.deepEqual(await memoryBytes(fixture.repository), bytes);
    }
    fixture.fault("crash:profile-delete");
    await assert.rejects(fixture.repository.deleteUserProfileFromUserControl({ profileKey: "identity.name", expectedRevision: previous.revision }), /simulated_crash/u);
    fixture.fault(null);
    const recovered = await fixture.reopen();
    assert.deepEqual(await recovered.readUserProfileControlSnapshot(), previous, "initialization recovers an interrupted profile transaction");
    assert.equal(await readFile(recovered.layout.userProfileState, "utf8"), state);
    await writeFile(fixture.repository.layout.userProfileState, "{broken", "utf8");
    await assert.rejects(fixture.repository.readUserProfileControlSnapshot(), /user_profile_state_invalid/u);
    await writeFile(fixture.repository.layout.userProfileState, state, "utf8");
    await writeFile(fixture.repository.layout.user, "unexpected external USER edit", "utf8");
    await assert.rejects(fixture.repository.readUserProfileControlSnapshot(), /committed manifest/u);
  });
  console.log("PASS save/delete transaction rollback and explicit snapshot corruption/conflict errors");
}

function compatibleBarrierStateTransforms(): void {
  const empty = emptyUserProfileState(100);
  const legacy = { ...empty } as Record<string, unknown>;
  delete legacy.deletionBarriers;
  assert.deepEqual(parseUserProfileState(legacy)?.deletionBarriers, []);
  const barrier = { profileKey: "preference.tone", memoryRevisionCutoff: 10, experienceOccurredAtCutoff: 100 };
  const previous = { ...empty, deletionBarriers: [barrier] };
  const base = { section: "preference" as const, profileKey: "preference.tone", text: "清晰", basis: "observed_memory" as const };
  const state = applyDreamProfileUpdate(previous, {
    items: [
      { ...base, sourceMemoryId: "old", sourceEvidence: { kind: "memory", revision: 10 } },
      { ...base, sourceMemoryId: "missing-metadata" },
      { ...base, sourceMemoryId: "experience-old", sourceEvidence: { kind: "experience", occurredAt: 100 } },
      { ...base, sourceMemoryId: "new-a", sourceEvidence: { kind: "memory", revision: 11 } },
      { ...base, sourceMemoryId: "new-b", sourceEvidence: { kind: "experience", occurredAt: 101 } }
    ], processedSources: [{ memoryId: "new-a", memoryRevision: 11 }], now: 200
  });
  assert.deepEqual(state.items[0]?.sourceMemoryIds, ["new-a", "new-b"]);
  for (const transformed of [
    parseUserProfileState(JSON.parse(JSON.stringify(state)))!,
    reconcileProfileSources(state, new Set(["new-a"]), 201),
    revokeReprocessedProfileSources(state, new Set(["new-a"]), 201),
    rebindProfileSource(state, { previousMemoryId: "new-a", replacementMemoryId: "new-c", previousMemoryRevision: 11, replacementText: "清晰", now: 201 })
  ]) assert.deepEqual(transformed.deletionBarriers, [barrier]);
  assert.equal(parseUserProfileState({ ...state, deletionBarriers: [{ ...barrier, profileKey: "unknown.slot" }] }), null);
  console.log("PASS older v2 compatibility, bounded barrier validation and lifecycle preservation");
}

async function snapshotIncludesAllSlotsBeforeProjectionBudget(): Promise<void> {
  await withFixture("budget", async (fixture) => {
    for (const slot of USER_PROFILE_SLOTS) await save(fixture.repository, slot.profileKey, `${slot.labelZh}${"内容".repeat(45)}`);
    const snapshot = await fixture.repository.readUserProfileControlSnapshot();
    assert.equal(snapshot.items.length, USER_PROFILE_SLOTS.length);
    assert.equal(new Set(snapshot.items.map((item) => item.profileKey)).size, 24);
    const user = await readFile(fixture.repository.layout.user, "utf8");
    assert.ok(user.length <= 2_000);
    assert.ok(snapshot.items.some((item) => !user.includes(item.text)), "control snapshot includes valid slots beyond the text projection budget");
  });
  console.log("PASS all 24 structured slots remain manageable beyond USER.md projection budget");
}

export async function runUserProfileControlScenarios(): Promise<void> {
  compatibleBarrierStateTransforms();
  await localControlsAndValidation();
  await observedConfirmationAndWholeSlotDeletion();
  await deletionSurvivesReloadAndDreamReplay();
  await concurrentControlsRejectStaleRevisions();
  await inFlightDreamCannotRestoreDeletedSlot();
  await transactionRollbackAndReadFailures();
  await snapshotIncludesAllSlotsBeforeProjectionBudget();
  console.log("User profile control acceptance: PASS (8 scenarios)");
}
