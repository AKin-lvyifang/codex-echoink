import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecondaryMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import {
  measureFinalInjectionTokens,
  PersonalMemoryRecallHarness
} from "../harness/memory/personal-memory-recall-harness";
import {
  applySecondaryDecay,
  applySecondaryHit,
  createSecondaryRecord,
  indexableSecondaryRecords,
  reconcileSecondaryForParent,
  SecondaryMemoryStore,
  serializeSecondaryRecord
} from "../harness/memory/secondary-memory-store";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";

const DAY = 86_400_000;

function supportIdentity(record: SecondaryMemoryRecord): unknown {
  return { supportLevel: record.supportLevel, evidence: record.evidence,
    relation: record.relation, sourceMemoryRevision: record.sourceMemoryRevision, basis: record.basis };
}

async function retainEvidence(name: string, evidence: unknown): Promise<void> {
  const directory = process.env.ECHOINK_SECONDARY_TEST_EVIDENCE;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n");
}

/** Real files, Repository transactions and fresh Store/Repository instances. */
export async function runSecondaryMemoryPersistentRecallTests(): Promise<void> {
  await withPersonalMemoryFixture(async (fixture) => {
    const runtime = fixture.runtime({ explicitlyAuthorized: true });
    const parent = (await fixture.repository.write({
      operation: "create", kind: "fact", title: "周末工作约定",
      content: "下午做一次回顾。", recallWhen: "安排工作回顾时", basis: "explicit"
    }, runtime)).record!;
    const query = "茉莉冷萃";
    assert.ok(![parent.title, parent.content, parent.recallWhen].join("\n").includes(query));
    const primaryOnly = await fixture.repository.prepareTurnSnapshot({ memoryMode: "normal", query }, runtime);
    assert.equal(primaryOnly.search?.total, 0, "唯一查询词必须在 primary-only 真实查询中不命中");
    assert.deepEqual(primaryOnly.search?.pendingSecondaryHits, []);
    const target = createSecondaryRecord({
      parentId: parent.id, title: "午后休息线索", content: "休息前查看父记忆的安排。",
      recallWhen: "讨论下午饮品时", matchTerms: [query], relation: "context",
      reason: "从场景找回已有安排", supportLevel: "direct",
      evidence: "父记忆明确规定下午回顾；饮品场景仅是检索入口。",
      basis: "llm_inferred", confidence: 0.7, sourceMemoryRevision: parent.revision,
      now: fixture.now(), idFactory: () => "sec_persistent_target"
    });
    const other = createSecondaryRecord({
      ...target, title: "另一条场景线索", matchTerms: ["青柠苏打"],
      now: fixture.now(), idFactory: () => "sec_persistent_other"
    });
    const seeded = [target, other];
    await fixture.repository.applyCognitiveUpdate({ secondaryRecords: seeded,
      extraChanges: seeded.map(record => ({ relativePath: record.file, content: serializeSecondaryRecord(record) })),
      detail: "persistent-secondary-only-fixture" });
    const beforeRaw = await Promise.all(seeded.map(record => readFile(path.join(fixture.repository.layout.root, record.file), "utf8")));
    const parentRaw = await readFile(path.join(fixture.repository.layout.root, parent.file), "utf8");
    await fixture.repository.dispose();

    const repositories: PersonalMemoryRepository[] = [];
    const open = async () => {
      const store = new SecondaryMemoryStore(fixture.repository.layout.history);
      const repository = new PersonalMemoryRepository({
        vaultPath: fixture.vaultPath, vaultId: fixture.vaultId, now: fixture.now,
        secondaryRecordsProvider: () => store.loadAll(), watchExternalChanges: false
      });
      repository.setSecondaryChangedHook(records => store.setCache(records));
      repository.setSecondaryRefreshProvider(() => store.refresh());
      repositories.push(repository);
      await repository.initialize();
      return { repository, store };
    };
    try {
      const { repository, store } = await open();
      assert.deepEqual(await store.loadAll(), [...seeded].sort((left, right) => left.id.localeCompare(right.id)),
        "测试必须从磁盘重新加载线索，不能只替换内存快照");
      const snapshots: unknown[] = [], calls: unknown[] = [], rounds: unknown[] = [];
      const pendingTransactions: Promise<void>[] = [];
      let currentRun = "";
      const snapshot = repository.prepareTurnSnapshot.bind(repository);
      repository.prepareTurnSnapshot = async (...args) => {
        const result = await snapshot(...args);
        snapshots.push({ productRunId: args[1]?.productRunId, query: args[0].query,
          pendingSecondaryHits: result.search?.pendingSecondaryHits,
          candidates: result.search?.items });
        assert.deepEqual(result.search?.pendingSecondaryHits, [{ secondaryId: target.id, parentId: parent.id }]);
        return result;
      };
      const recordHits = repository.recordSecondaryRecallHits.bind(repository);
      repository.recordSecondaryRecallHits = hits => {
        calls.push({ function: "PersonalMemoryRepository.recordSecondaryRecallHits", productRunId: currentRun, hits });
        const transaction = recordHits(hits);
        pendingTransactions.push(transaction);
        return transaction;
      };
      const harness = new PersonalMemoryRecallHarness(repository);
      for (let round = 1; round <= 3; round += 1) {
        currentRun = `persistent-secondary-hit-${round}`;
        const prepared = await harness.prepareTurnContext({ ...runtime, memoryMode: "normal",
          productRunId: currentRun, query, tokenBudget: 1200 });
        assert.deepEqual(prepared.recall?.candidates.map(item => item.id), [parent.id]);
        assert.equal(prepared.recall?.candidates[0]?.matchedSecondaryId, target.id);
        assert.ok(measureFinalInjectionTokens(prepared.recall!.candidates, prepared.recall!.total) <= 1200);
        assert.equal(pendingTransactions.length, round, "每轮都必须真正调用写回事务");
        await pendingTransactions[round - 1];
        const diskRecords = await new SecondaryMemoryStore(repository.layout.history).loadAll();
        const diskTarget = diskRecords.find(record => record.id === target.id)!;
        assert.equal(diskTarget.hitCount, round);
        assert.ok(diskTarget.lastHitAt! > target.createdAt);
        assert.deepEqual(supportIdentity(diskTarget), supportIdentity(target));
        assert.equal(diskRecords.find(record => record.id === other.id)?.hitCount, 0);
        rounds.push({ round, productRunId: currentRun, prepared, diskRecords,
          raw: await readFile(path.join(repository.layout.root, target.file), "utf8") });
      }
      await repository.dispose();
      const reopened = await open();
      const reopenedRecords = await reopened.store.loadAll();
      const after = reopenedRecords.find(record => record.id === target.id)!;
      assert.equal(after.hitCount, 3);
      assert.ok(after.confidence > target.confidence, "旧数值当前确实发生使用强化");
      assert.deepEqual(supportIdentity(after), supportIdentity(target));
      const parentAfter = (await reopened.repository.read(parent.id, runtime)).record;
      assert.deepEqual(parentAfter, parent, "命中不改变父记忆支持身份和自身 revision");
      assert.equal(await readFile(path.join(reopened.repository.layout.root, parent.file), "utf8"), parentRaw);
      const proof = { primaryOnly, parentBefore: parent, parentAfter, parentRaw,
        before: seeded, beforeRaw, snapshots, calls, rounds, reopenedRecords,
        afterRaw: await Promise.all(seeded.map(record => readFile(path.join(reopened.repository.layout.root, record.file), "utf8"))),
        audit: await readFile(reopened.repository.layout.audit, "utf8") };
      await retainEvidence("persistent-secondary-only", proof);
      console.log(`PASS persistent secondary-only Recall: primary=0, pending=${snapshots.length}, real hit transactions=${calls.length}, reopened hitCount=${after.hitCount}`);
    } finally {
      await Promise.all(repositories.map(repository => repository.dispose()));
    }
  }, { watchExternalChanges: false });
}

function record(overrides: Partial<SecondaryMemoryRecord> = {}): SecondaryMemoryRecord {
  return Object.freeze({ ...createSecondaryRecord({ parentId: "mem_support_parent",
    title: "既有场景", content: "较弱的原推断。", recallWhen: "核对此场景时", matchTerms: ["雪后散步"],
    relation: "context", reason: "合成场景", supportLevel: "strong_inference", evidence: "原依据。",
    basis: "llm_inferred", confidence: 0.65, sourceMemoryRevision: 4, now: 1000,
    idFactory: () => "sec_support_old" }), ...overrides });
}

async function assertPersistentParentLifecycleProtection(): Promise<void> {
  await withPersonalMemoryFixture(async fixture => {
    const parent = (await fixture.repository.write({ operation: "create", kind: "fact",
      title: "父记录生命周期", content: "保留已确认的工作约定。", recallWhen: "核对工作约定时",
      basis: "explicit" }, fixture.runtime({ explicitlyAuthorized: true }))).record!;
    const system = await CognitiveSystem.create({ repository: fixture.repository, now: fixture.now,
      llm: () => null, getDreamConfig: () => ({ enabled: false, runsPerDay: 1 }),
      isForegroundBusy: () => false, registerInterval: () => {} });
    system.scheduler.stop();
    try {
      const states = [
        { id: "sec_parent_current", status: "current", disabledReason: null, basis: "llm_inferred" },
        { id: "sec_parent_edited", status: "current", disabledReason: null, basis: "user_edited_inference" },
        { id: "sec_parent_low", status: "disabled", disabledReason: "low_confidence", basis: "llm_inferred" },
        { id: "sec_parent_replaced", status: "disabled", disabledReason: "redream_replaced", basis: "llm_inferred" }
      ] as const;
      const seeded = states.map(state => {
        const base = createSecondaryRecord({ parentId: parent.id, title: state.id, content: "父约定的场景线索。",
          recallWhen: "需要此约定时", matchTerms: ["山间茶歇"], relation: "context", reason: "合成生命周期",
          supportLevel: "direct", evidence: "父记录中的工作约定。", basis: state.basis,
          confidence: state.basis === "user_edited_inference" ? 0.01 : 0.8,
          sourceMemoryRevision: parent.revision, now: fixture.now(), idFactory: () => state.id });
        return Object.freeze({ ...base, status: state.status, disabledReason: state.disabledReason });
      });
      await fixture.repository.applyCognitiveUpdate({ secondaryRecords: seeded,
        extraChanges: seeded.map(item => ({ relativePath: item.file, content: serializeSecondaryRecord(item) })),
        detail: "secondary-parent-lifecycle-fixture" });
      const disabledRaw = await Promise.all(seeded.filter(item => item.status === "disabled")
        .map(item => readFile(path.join(fixture.repository.layout.root, item.file), "utf8")));
      await fixture.repository.write({ operation: "forget", targetId: parent.id, reason: "测试父失效", explicitForget: true },
        fixture.runtime({ explicitlyAuthorized: true }));
      const forgotten = await new SecondaryMemoryStore(fixture.repository.layout.history).loadAll();
      assert.ok(forgotten.every(item => item.status === "disabled"));
      const noParent = await fixture.repository.prepareTurnSnapshot({ memoryMode: "normal", query: "山间茶歇" }, fixture.runtime());
      assert.equal(noParent.search?.total, 0, "父记忆失效时任何线索都不能拉回父记录");
      await fixture.repository.restoreForgotten(parent.id);
      const restored = await new SecondaryMemoryStore(fixture.repository.layout.history).loadAll();
      for (const before of seeded) {
        const after = restored.find(item => item.id === before.id)!;
        assert.deepEqual(supportIdentity(after), supportIdentity(before));
        assert.equal(after.confidence, before.confidence);
        assert.equal(after.status, before.status, "restore只重新启用本轮因父生命周期失效的记录");
        assert.equal(after.disabledReason, before.disabledReason);
      }
      assert.deepEqual(await Promise.all(seeded.filter(item => item.status === "disabled")
        .map(item => readFile(path.join(fixture.repository.layout.root, item.file), "utf8"))), disabledRaw,
      "旧停用线索不因父生命周期或语义调整批量重写/复活");
      await retainEvidence("parent-lifecycle", { seeded, forgotten, noParent, restored, disabledRaw });
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  console.log("PASS persistent parent forget/restore preserves disabled and user-edited boundaries");
}

export async function runSecondaryMemorySupportActivityTests(): Promise<void> {
  await runSecondaryMemoryPersistentRecallTests();
  await assertPersistentParentLifecycleProtection();
  const failures: unknown[] = [];
  for (const sameFingerprint of [true, false]) {
    try {
      let old = record({ supportLevel: "weak_inference", confidence: 0.45, lastDecayAt: 1100 });
      for (let hit = 0; hit < 10; hit += 1) old = applySecondaryHit(old, 2000 + hit);
      const candidate = { title: old.title, content: "新候选有直接支持。", recallWhen: old.recallWhen,
        matchTerms: sameFingerprint ? old.matchTerms : ["林间步行"], relation: old.relation,
        reason: "更充分的依据", supportLevel: "direct" as const, evidence: "新直接依据。" };
      const result = reconcileSecondaryForParent({ parentId: old.parentId, parentBasis: "explicit",
        parentRevision: 4, existing: [old], candidates: [candidate], now: 3000 });
      const updated = result.records.find(item => item.id === old.id)!;
      await retainEvidence(sameFingerprint ? "fingerprint-support-comparison" : "wide-key-support-comparison", { old, candidate, result });
      assert.equal(updated.supportLevel, "direct", "频繁命中的弱支持不能压过新候选支持");
      assert.equal(updated.evidence, candidate.evidence);
      assert.equal(updated.confidence, old.confidence, "复用/替换不把活动重置成支持分");
      assert.equal(updated.hitCount, old.hitCount);
      assert.equal(updated.lastHitAt, old.lastHitAt);
      assert.equal(updated.lastDecayAt, old.lastDecayAt);
      assert.equal(updated.createdAt, old.createdAt);
      assert.equal(updated.file, old.file);
      assert.equal(updated.revision, old.revision + 1);
    } catch (error) { failures.push(error); }
  }
  for (const unknownSupport of [false, true]) {
    try {
      const old = record({ supportLevel: "direct", confidence: unknownSupport ? 0.95 : 0.12,
        evidence: unknownSupport ? "" : "现有直接依据。" });
      const candidate = { title: old.title, content: "新的推断表述。", recallWhen: old.recallWhen,
        matchTerms: old.matchTerms, relation: old.relation, reason: "新依据",
        supportLevel: "strong_inference" as const, evidence: "新候选明确记录的推断依据。" };
      const result = reconcileSecondaryForParent({ parentId: old.parentId, parentBasis: "explicit",
        parentRevision: 4, existing: [old], candidates: [candidate], now: 3000 });
      const updated = result.records.find(item => item.id === old.id)!;
      await retainEvidence(unknownSupport ? "unknown-support-comparison" : "low-activity-strong-support", { old, candidate, result });
      assert.equal(updated.supportLevel, unknownSupport ? candidate.supportLevel : old.supportLevel,
        unknownSupport ? "依据不足的旧活动值不能补成支持分" : "低活动不能让已有强支持输给较弱新候选");
      assert.equal(updated.evidence, unknownSupport ? candidate.evidence : old.evidence);
      assert.equal(updated.confidence, old.confidence);
    } catch (error) { failures.push(error); }
  }
  const strong = record({ supportLevel: "direct", confidence: 0.61 });
  const decayed = applySecondaryDecay(strong, strong.createdAt + 30 * DAY).record;
  assert.deepEqual(supportIdentity(decayed), supportIdentity(strong));
  assert.equal(decayed.status, "current");
  assert.deepEqual(indexableSecondaryRecords([decayed]), [], "活动衰减退出索引，支持描述保持");
  const inactive = applySecondaryDecay(strong, strong.createdAt + 900 * DAY).record;
  assert.equal(inactive.disabledReason, "low_confidence");
  assert.deepEqual(supportIdentity(inactive), supportIdentity(strong), "低活动停用也不能改写支持依据");
  assert.deepEqual(indexableSecondaryRecords([record({ supportLevel: "weak_inference", confidence: 0.95 })]).map(item => item.id), [strong.id],
    "已有活跃记录不因为本次语义更正被追溯按新候选准入重筛");
  const edited = record({ basis: "user_edited_inference", confidence: 0.01 });
  assert.equal(applySecondaryDecay(edited, edited.createdAt + 900 * DAY).record, edited);
  assert.deepEqual(indexableSecondaryRecords([edited]), [edited]);
  const protectedEdit = reconcileSecondaryForParent({ parentId: edited.parentId, parentBasis: "explicit",
    parentRevision: 4, existing: [edited], now: 3000,
    candidates: [{ title: edited.title, content: "不应覆盖手工编辑。", recallWhen: edited.recallWhen,
      matchTerms: edited.matchTerms, relation: edited.relation, reason: "新候选",
      supportLevel: "direct", evidence: "新支持也不能覆盖人工版本。" }] });
  assert.deepEqual(protectedEdit.records, [edited]);
  assert.deepEqual(protectedEdit.fileChanges, []);
  for (const disabledReason of ["parent_lifecycle", "low_confidence", "redream_replaced"] as const) {
    const disabled = record({ status: "disabled", disabledReason });
    assert.equal(applySecondaryDecay(disabled, disabled.createdAt + 900 * DAY).record, disabled);
    assert.deepEqual(indexableSecondaryRecords([disabled]), []);
  }
  if (failures.length) throw new AggregateError(failures, "Secondary support/activity behavioral regressions");
  console.log("PASS secondary support comparison, activity retention and compatibility boundaries");
}
