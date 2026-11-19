import assert from "node:assert/strict";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { CognitiveSystem, type CognitiveSystemOptions } from "../harness/memory/cognitive-system";
import { DreamExperienceInboxStore } from "../harness/memory/dream-experience-inbox";

const reply = (input: { systemPrompt: string; userPrompt: string }) => {
  if (input.systemPrompt.includes("本次只输出 USER")) return "no_change";
  const value = JSON.parse(input.userPrompt);
  return JSON.stringify(value.memories ? Object.fromEntries(value.memories.map((record: { id: string }) => [record.id, []]))
    : { secondaryFacts: [], userProfileItems: [], relatedIds: [] });
};
const options = (f: PersonalMemoryFixture): Omit<CognitiveSystemOptions, "llm"> => ({ repository: f.repository,
  getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }), registerInterval: () => undefined, now: f.now });
async function seed(f: PersonalMemoryFixture, count: number) {
  const records = [];
  for (let i = 0; i < count; i++) records.push((await f.repository.write({ operation: "create", kind: "fact",
    title: `待处理${i}`, content: `独立事实${i}`, basis: "explicit", contentOrigin: "user_statement" }, f.runtime())).record!);
  return records;
}
async function oldInventory(system: CognitiveSystem) {
  const records = (await system.repository.inspect()).records;
  await system.dreamStateStore.write({ ...await system.dreamStateStore.read(), pendingMemoryIds: records.map(record => record.id),
    processedMemorySources: records.map(record => ({ memoryId: record.id, memoryRevision: record.revision, processedAt: 1 })) });
}
const experience = (i: number) => ({ conversationId: "completion", productRunId: `completion-${i}`, userEntryId: `user-${i}`,
  assistantEntryId: `assistant-${i}`, occurredAt: i, userText: `公开对话${i}`, assistantText: "任务完成",
  taskResult: { terminalState: "completed" as const, successfulToolNames: [], failedToolNames: [] } });

export async function runDreamCompletionTests() {
  await withPersonalMemoryFixture(async f => {
    const [alreadyDone] = await seed(f, 1);
    await f.repository.applyCognitiveUpdate({ userContent: "# USER\n\n我长期喜欢简短回答。\n", secondaryRecords: [], extraChanges: [], detail: "fixture-legacy-user" });
    let calls = 0;
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async input => { calls++; return reply(input); } }) });
    try {
      await system.dreamStateStore.write({ ...await system.dreamStateStore.read(), pendingMemoryIds: [],
        processedMemorySources: [{ memoryId: alreadyDone.id, memoryRevision: alreadyDone.revision, associationRevision: alreadyDone.revision, processedAt: 1 }] });
      const result = await system.forceDreamRun();
      assert.equal(result!.error, null, "local migration is progress and must not stop the draining loop");
      assert.equal(result!.processedMemoryIds.length, 1); assert.equal(calls, 2);
      assert.ok(!result!.processedMemoryIds.includes(alreadyDone.id), "migration can replace a finished ID in the remaining set without changing its size");
      await system.forceDreamRun(); assert.equal(calls, 2);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 26); let calls = 0;
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async input => { calls++; return reply(input); } }) });
    try {
      await oldInventory(system);
      // A foreground request stays in flight while the manual and automatic paths finish.
      let finishForeground!: () => void;
      const foreground = new Promise<void>(resolve => { finishForeground = resolve; });
      await system.scheduler.tick();
      const result = system.scheduler.lastResult;
      assert.equal(result!.processedMemoryIds.length, 26); assert.equal(calls, 3);
      assert.equal(result!.failedMemoryIds.length, 0);
      const summary = (await system.dreamStateStore.read()).runSummary!;
      assert.equal(summary.batches, 3); assert.equal(summary.processedMemories, 26); assert.equal(summary.modelCalls, 3);
      assert.equal(summary.stopReason, "completed");
      finishForeground(); await foreground;
      const unchangedRevision = (await f.repository.inspect()).revision;
      f.advance(30 * 86_400_000);
      await system.scheduler.tick(); assert.equal(calls, 3, "automatic path shares the drained ledger");
      assert.equal(system.scheduler.lastResult!.committed, false, "no new inputs skips consolidation even after time passes");
      await system.forceDreamRun(); assert.equal(calls, 3, "no new inputs means zero calls including profile");
      assert.equal((await f.repository.inspect()).revision, unchangedRevision, "an empty run only writes its lightweight run receipt");
      assert.equal((await system.dreamStateStore.read()).runSummary!.modelCalls, 0);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 16); let calls = 0;
    const inbox = new DreamExperienceInboxStore(f.repository.layout.root);
    for (let i = 0; i < 51; i++) await inbox.append(experience(i), f.now());
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async input => { calls++; return reply(input); } }) });
    try {
      const result = await system.forceDreamRun();
      assert.equal(result!.processedMemoryIds.length, 16, "new memories drain past count/token chunk limits");
      assert.ok((await inbox.read()).entries.every(entry => entry.evaluatedAt !== null), "all 51 experiences drain past the 24-source cap");
      assert.equal((await system.dreamStateStore.read()).runSummary!.evaluatedExperiences, 51);
      const previous = calls; await system.forceDreamRun(); assert.equal(calls, previous);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 26); let calls = 0;
    let fail = true; const attempted: string[][] = [];
    const open = (repository: PersonalMemoryFixture["repository"]) => CognitiveSystem.create({ ...options(f), repository,
      llm: () => ({ call: async input => {
        calls++; attempted.push(JSON.parse(input.userPrompt).memories.map((record: { id: string }) => record.id));
        if (fail && calls === 2) throw new Error("provider_network_failed");
        return reply(input);
      } }) });
    let system = await open(f.repository);
    try {
      await oldInventory(system);
      const result = await system.forceDreamRun();
      assert.equal(result!.processedMemoryIds.length, 10); assert.equal(calls, 2, "ordinary failure stops without retrying");
      assert.equal((await system.dreamStateStore.read()).runSummary!.stopReason, "failed");
      await system.dispose(); fail = false;
      system = await open(await f.reopen());
      const retry = await system.forceDreamRun();
      assert.equal(retry!.processedMemoryIds.length, 16);
      assert.ok(attempted.slice(2).flat().every(id => !attempted[0].includes(id)), "committed first batch survives interruption/reopen");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 1); let calls = 0; const waits: number[] = [];
    const system = await CognitiveSystem.create({ ...options(f), sleep: async ms => { waits.push(ms); },
      llm: () => ({ call: async input => { calls++; if (calls <= 2) throw Object.assign(new Error("throttled"), { status: 429 }); return reply(input); } }) });
    try {
      await oldInventory(system); await system.forceDreamRun();
      assert.deepEqual(waits, [1_000, 2_000]); assert.equal(calls, 3);
      assert.equal((await system.dreamStateStore.read()).runSummary!.rateLimitRetries, 2);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 1); let calls = 0;
    const system = await CognitiveSystem.create({ ...options(f), sleep: async () => { throw Error("must not back off billing quota"); },
      llm: () => ({ call: async () => { calls++; throw Object.assign(new Error("insufficient_quota"), { status: 429 }); } }) });
    try { await oldInventory(system); await system.forceDreamRun(); assert.equal(calls, 1); }
    finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 1); let calls = 0; const waits: number[] = [];
    const system = await CognitiveSystem.create({ ...options(f), sleep: async ms => { waits.push(ms); },
      llm: () => ({ call: async () => { calls++; throw Object.assign(new Error("concurrency"), { code: "CONCURRENCY_LIMIT" }); } }) });
    try {
      await oldInventory(system); await system.forceDreamRun();
      assert.equal(calls, 4); assert.deepEqual(waits, [1_000, 2_000, 4_000]);
      assert.equal((await system.dreamStateStore.read()).processedMemorySources[0].associationRevision, undefined);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f, 26); let calls = 0;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async input => {
      calls++;
      if (calls === 2) return await new Promise<string>((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); entered();
      });
      return reply(input);
    } }) });
    await oldInventory(system);
    const running = system.forceDreamRun(); await pending; await system.dispose();
    const result = await running;
    assert.equal(result!.processedMemoryIds.length, 10); assert.equal(result!.error, "dream_cancelled");
    assert.equal(calls, 2, "unload stops dispatching subsequent chunks");
    const repository = await f.reopen(); let recovered = 0;
    const reopened = await CognitiveSystem.create({ ...options(f), repository, llm: () => ({ call: async input => { recovered++; return reply(input); } }) });
    try {
      assert.equal((await reopened.forceDreamRun())!.processedMemoryIds.length, 16); assert.equal(recovered, 2);
    } finally { await reopened.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const [record] = await seed(f, 1);
    let addedId = "";
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async () => {
      addedId = (await f.repository.write({ operation: "create", kind: "fact", title: "前台新记忆", content: "新事实", basis: "explicit", contentOrigin: "user_statement" }, f.runtime())).record!.id;
      await system.settleDreamEnqueue(); throw Error("provider_network_failed");
    } }) });
    try {
      await oldInventory(system); await system.forceDreamRun();
      const state = await system.dreamStateStore.read();
      assert.ok(state.pendingMemoryIds.includes(addedId) && state.pendingMemoryIds.includes(record.id), "failure receipt and run diagnostics preserve foreground enqueues");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const inbox = new DreamExperienceInboxStore(f.repository.layout.root);
    await inbox.append(experience(1), f.now()); let calls = 0;
    const system = await CognitiveSystem.create({ ...options(f), llm: () => ({ call: async () => {
      calls++; if (calls === 1) await inbox.append(experience(2), f.now()); return "no_change";
    } }) });
    try {
      await system.forceDreamRun(); assert.equal(calls, 1, "one run drains its initial snapshot without chasing new conversations");
      assert.equal((await inbox.read()).entries.filter(entry => entry.evaluatedAt === null).length, 1);
      await system.forceDreamRun(); assert.equal(calls, 2); await system.forceDreamRun(); assert.equal(calls, 2);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  console.log("PASS Dream run-to-completion: 26 old/16 new/51 experiences, foreground overlap, empty zero calls, durable partial retry, rate-only backoff");
}
