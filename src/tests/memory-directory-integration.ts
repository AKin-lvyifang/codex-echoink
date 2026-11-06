import assert from "node:assert/strict";
import {
  measureFinalInjectionTokens,
  PersonalMemoryRecallHarness,
  serializeRecallBlocks,
  type PersonalMemoryPreparedTurnContext
} from "../harness/memory/personal-memory-recall-harness";
import type { MemoryDirectoryLlmPort } from "../harness/memory/memory-directory-selector";
import type { PersonalMemoryWriteRequest } from "../harness/memory/personal-memory-contracts";
import { createSecondaryRecord, serializeSecondaryRecord } from "../harness/memory/secondary-memory-store";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";

type Turn = Parameters<PersonalMemoryRecallHarness["prepareTurnContext"]>[0];
type Call = Parameters<MemoryDirectoryLlmPort["call"]>[0];
type Catalog = Array<{ id: string; title: string; recallWhen: string }>;
const DAY = 86_400_000;

function turn(fixture: PersonalMemoryFixture, overrides: Partial<Turn> = {}): Turn {
  return { ...fixture.runtime(), query: "柚子", tokenBudget: 2_000, ...overrides };
}

async function create(
  fixture: PersonalMemoryFixture,
  title: string,
  extra: Partial<Extract<PersonalMemoryWriteRequest, { operation: "create" }>> = {}
) {
  return (await fixture.repository.write({ operation: "create", kind: "fact", title,
    content: `${title}的具体约定。`, recallWhen: title, basis: "explicit", ...extra },
  fixture.runtime({ explicitlyAuthorized: true }))).record!;
}

function parseCatalog(call: Call): Catalog {
  const start = call.systemPrompt.indexOf("\n") + 1;
  const end = call.systemPrompt.indexOf("\n</memory_directory>");
  assert.ok(end > start);
  return JSON.parse(call.systemPrompt.slice(start, end));
}

function harness(fixture: PersonalMemoryFixture, llm: MemoryDirectoryLlmPort) {
  return new PersonalMemoryRecallHarness(fixture.repository, { directory: { llm, modelInputBudget: 32_000 } });
}

function ids(prepared: PersonalMemoryPreparedTurnContext): readonly string[] {
  return prepared.recall?.candidates.map(candidate => candidate.id) ?? [];
}

export async function runMemoryDirectoryIntegrationTests(): Promise<void> {
  let passed = 0;
  const test = async (name: string, body: (fixture: PersonalMemoryFixture) => Promise<void>) => {
    await withPersonalMemoryFixture(body, { watchExternalChanges: false });
    passed++;
    console.log(`PASS memory directory integration: ${name}`);
  };

  await test("semantic IDs lead, lexical results supplement, and receipts stay outside serialized memory", async fixture => {
    const semantic = await create(fixture, "山楂账本");
    const lexical = await create(fixture, "柚子");
    const unrelated = await create(fixture, "晴空约定");
    const baseline = await new PersonalMemoryRecallHarness(fixture.repository).prepareTurnContext(turn(fixture));
    assert.deepEqual(ids(baseline), [lexical.id]);
    let calls = 0;
    const prepared = await harness(fixture, { call: async call => {
      calls++;
      assert.deepEqual(new Set(parseCatalog(call).map(entry => entry.id)), new Set([semantic.id, lexical.id, unrelated.id]));
      return { text: JSON.stringify([semantic.id, "unknown", semantic.id]), usage: { cacheRead: 120 } };
    } }).prepareTurnContext(turn(fixture));
    assert.equal(calls, 1);
    assert.deepEqual(ids(prepared), [semantic.id, lexical.id]);
    assert.equal(prepared.directorySelection?.status, "selected");
    assert.equal(prepared.directorySelection?.stats.usage?.cacheRead, 120);
    assert.ok(measureFinalInjectionTokens(prepared.recall!.candidates, prepared.recall!.total) <= 2_000);
    const serialized = serializeRecallBlocks({ ...prepared.recall!, secondaryFacts: [] }).combined;
    assert.doesNotMatch(serialized, /directorySelection|cacheRead|activity|晴空/u);
    const noQuery = await harness(fixture, { call: async () => ({ text: JSON.stringify([semantic.id]) }) })
      .prepareTurnContext(turn(fixture, { query: "" }));
    assert.deepEqual(ids(noQuery), [semantic.id], "empty query must not browse unrelated records after semantic selection");
  });

  await test("empty and all-unknown results suppress dynamic records but retain core memory", async fixture => {
    const core = await create(fixture, "核心约定", { pinned: true });
    await create(fixture, "柚子");
    for (const response of [[], ["unknown"]]) {
      const prepared = await harness(fixture, { call: async () => ({ text: JSON.stringify(response) }) })
        .prepareTurnContext(turn(fixture));
      assert.equal(prepared.directorySelection?.status, "selected");
      assert.deepEqual(ids(prepared), []);
      assert.equal(prepared.core?.[0]?.id, core.id);
      assert.equal(prepared.recall?.total, 0);
      assert.equal(prepared.recall?.exhaustive, true);
    }
  });

  await test("parse and call failures use the unchanged lexical route exactly once", async fixture => {
    await create(fixture, "柚子");
    await create(fixture, "山楂账本");
    const now = fixture.now();
    const baseline = await new PersonalMemoryRecallHarness(fixture.repository).prepareTurnContext(turn(fixture, { now }));
    for (const failure of ["parse", "call"] as const) {
      let calls = 0;
      const prepared = await harness(fixture, { call: async () => {
        calls++;
        if (failure === "call") throw new Error("offline fixture");
        return { text: "invalid JSON" };
      } }).prepareTurnContext(turn(fixture, { now }));
      assert.equal(calls, 1);
      assert.equal(prepared.directorySelection?.status, "fallback");
      assert.deepEqual(prepared.recall, baseline.recall);
    }
  });

  await test("preview, skip and no-memory turns do not invoke the directory or add an extra snapshot", async fixture => {
    const record = await create(fixture, "柚子");
    let calls = 0;
    const preparedHarness = harness(fixture, { call: async () => { calls++; return { text: "[]" }; } });
    let snapshots = 0;
    const snapshot = fixture.repository.prepareTurnSnapshot.bind(fixture.repository);
    fixture.repository.prepareTurnSnapshot = async (...args) => { snapshots++; return snapshot(...args); };
    for (const flags of [{ preview: true }, { skipDirectory: true }, { memoryMode: "no_memory" as const }]) {
      const before = snapshots;
      const prepared = await preparedHarness.prepareTurnContext(turn(fixture, flags));
      assert.equal(snapshots - before, 1);
      assert.equal(prepared.directorySelection, undefined);
      if (flags.memoryMode === "no_memory") assert.equal(prepared.recall, null);
      else assert.deepEqual(ids(prepared), [record.id]);
    }
    assert.equal(calls, 0);
  });

  await test("directory respects real-query project inference, explicit scope, current status and all faded exclusions", async fixture => {
    const global = await create(fixture, "全局约定");
    const alpha = await create(fixture, "甲项目安排", { scope: "project:alpha" });
    await create(fixture, "乙项目安排", { scope: "project:beta" });
    const old = await create(fixture, "旧的全局约定");
    const current = (await fixture.repository.write({ operation: "supersede", targetId: old.id,
      title: "新的全局约定", content: "新的明确规定。", recallWhen: "新的全局约定", basis: "explicit", reason: "fixture update" }, fixture.runtime())).record!;
    const closed = await create(fixture, "已结束安排", { kind: "task" });
    await fixture.repository.write({ operation: "close", targetId: closed.id, reason: "fixture close" }, fixture.runtime());
    const forgotten = await create(fixture, "已忘记约定");
    await fixture.repository.write({ operation: "forget", targetId: forgotten.id, reason: "fixture forget", explicitForget: true }, fixture.runtime({ explicitlyAuthorized: true }));
    await create(fixture, "固定约定", { pinned: true });
    const fadedGoal = await create(fixture, "远期目标", { kind: "goal" });
    await fixture.repository.memoryActivity(fixture.now());
    fixture.advance(900 * DAY);
    const now = fixture.now();
    assert.ok((await new PersonalMemoryRecallHarness(fixture.repository).prepareTurnContext(turn(fixture, { query: fadedGoal.title, now })))
      .recall?.candidates.some(candidate => candidate.id === fadedGoal.id), "old lexical direct-goal exception remains available");
    const expected = new Set([global.id, alpha.id, current.id]);
    const preparedHarness = harness(fixture, { call: async call => {
      assert.deepEqual(new Set(parseCatalog(call).map(entry => entry.id)), expected);
      return { text: JSON.stringify([alpha.id]) };
    } });
    const inferred = await preparedHarness.prepareTurnContext(turn(fixture, {
      query: "alpha 的安排", statuses: ["current", "superseded", "closed"], now
    }));
    assert.equal(ids(inferred)[0], alpha.id);
    const explicit = await preparedHarness.prepareTurnContext(turn(fixture, {
      query: "beta 远期目标", scope: "alpha", statuses: ["current", "superseded", "closed"], now
    }));
    assert.equal(ids(explicit)[0], alpha.id);
    assert.ok(!ids(explicit).includes(fadedGoal.id));
  });

  await test("date boundaries are shared by catalog discovery and final selection", async fixture => {
    await create(fixture, "前一天约定");
    fixture.advance(DAY);
    const inside = await create(fixture, "当天约定");
    fixture.advance(DAY);
    await create(fixture, "后一天约定");
    const prepared = await harness(fixture, { call: async call => {
      assert.deepEqual(parseCatalog(call).map(entry => entry.id), [inside.id]);
      return { text: JSON.stringify([inside.id]) };
    } }).prepareTurnContext(turn(fixture, { from: inside.date, to: inside.date }));
    assert.deepEqual(ids(prepared), [inside.id]);
  });

  await test("the model runs outside the mutation lock and selected records are revalidated afterward", async fixture => {
    const selected = await create(fixture, "山楂账本");
    await create(fixture, "柚子");
    let calls = 0;
    const snapshots: Array<{ query?: string; preview?: boolean; reads: number }> = [];
    const repository = fixture.repository as unknown as {
      readRecord(...args: unknown[]): Promise<unknown>;
    };
    const readRecord = repository.readRecord.bind(fixture.repository);
    let reads = 0;
    repository.readRecord = async (...args) => { reads++; return readRecord(...args); };
    const snapshot = fixture.repository.prepareTurnSnapshot.bind(fixture.repository);
    fixture.repository.prepareTurnSnapshot = async (...args) => {
      const before = reads;
      const result = await snapshot(...args);
      snapshots.push({ query: args[0].query, preview: args[0].preview, reads: reads - before });
      return result;
    };
    const prepared = await harness(fixture, { call: async () => {
      calls++;
      const state = await fixture.repository.inspect();
      await fixture.repository.forgetFromUserControl(selected.id, "fixture concurrent forget", state.revision);
      return { text: JSON.stringify([selected.id]) };
    } }).prepareTurnContext(turn(fixture));
    assert.equal(calls, 1);
    assert.equal(prepared.directorySelection?.status, "selected", "write completed before the model deadline, proving the mutation lock was released");
    assert.deepEqual(ids(prepared), [], "invalidated semantic IDs must not fall back to unrelated lexical records");
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].preview, true);
    assert.equal(snapshots[0].query, "柚子", "discovery must preserve the real query");
    assert.equal(snapshots[0].reads, 0, "metadata-only discovery does not read dynamic bodies");
  });

  await test("run cancellation aborts the waiting adapter and prevents the final snapshot", async fixture => {
    await create(fixture, "柚子");
    const controller = new AbortController();
    const previews: Array<boolean | undefined> = [];
    const snapshot = fixture.repository.prepareTurnSnapshot.bind(fixture.repository);
    fixture.repository.prepareTurnSnapshot = async (...args) => {
      previews.push(args[0].preview);
      return snapshot(...args);
    };
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    let adapterAborted = false;
    let calls = 0;
    const preparedHarness = harness(fixture, { call: request => {
      calls++;
      request.signal.addEventListener("abort", () => { adapterAborted = true; }, { once: true });
      notifyStarted();
      return new Promise(() => undefined);
    } });
    const pending = preparedHarness.prepareTurnContext(turn(fixture, { signal: controller.signal }));
    await started;
    controller.abort();
    await assert.rejects(pending, /memory_recall_aborted/u);
    assert.equal(adapterAborted, true);
    assert.equal(calls, 1);
    assert.deepEqual(previews, [true], "cancelled selection must not proceed to the final repository snapshot");
    await assert.rejects(preparedHarness.prepareTurnContext(turn(fixture, { signal: controller.signal })), /memory_recall_aborted/u);
    assert.equal(calls, 1, "an already-cancelled turn must not invoke the model");
    assert.deepEqual(previews, [true], "an already-cancelled turn must not read the directory");
  });

  await test("directory-selected parents are not miscounted as decisive secondary hits", async fixture => {
    const parent = await create(fixture, "晨间回顾");
    const fact = createSecondaryRecord({ parentId: parent.id, title: "关联线索", content: "回顾原有安排。",
      recallWhen: "相关场景", matchTerms: ["柚子"], relation: "context", reason: "fixture association",
      supportLevel: "direct", evidence: "父记录已有明确约定；这里仅验证关联入口的统计归属。",
      basis: "llm_inferred", confidence: 0.7, sourceMemoryRevision: parent.revision,
      now: fixture.now(), idFactory: () => "sec_directory_fixture" });
    await fixture.repository.applyCognitiveUpdate({ secondaryRecords: [fact],
      extraChanges: [{ relativePath: fact.file, content: serializeSecondaryRecord(fact) }], detail: "directory-secondary-fixture" });
    const pendingHits: unknown[] = [];
    const snapshot = fixture.repository.prepareTurnSnapshot.bind(fixture.repository);
    fixture.repository.prepareTurnSnapshot = async (...args) => {
      const result = await snapshot(...args);
      pendingHits.push(result.search?.pendingSecondaryHits);
      return result;
    };
    const prepared = await harness(fixture, { call: async () => ({ text: JSON.stringify([parent.id]) }) })
      .prepareTurnContext(turn(fixture));
    assert.deepEqual(ids(prepared), [parent.id]);
    assert.equal(prepared.recall?.candidates[0]?.matchedSecondaryId, undefined);
    assert.equal(prepared.recall?.candidates[0]?.secondaryMatches?.[0]?.id, fact.id);
    assert.deepEqual(pendingHits, [[], []]);
  });
  console.log(`Memory directory integration: ${passed} tests passed`);
}
