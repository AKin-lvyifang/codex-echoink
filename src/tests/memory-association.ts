import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { parseCanonicalMemoryRecord, serializeCanonicalMemoryRecord, parseCanonicalMemoryManifest } from "../harness/memory/personal-memory-core";
import { memoryAssociationGraph } from "../harness/memory/memory-association";
import { mergeInjectedMemorySources } from "../harness/pi-native/pi-memory-sources";
import { memoryRecallReason } from "../home/memory/memory-panel";
import { buildMemoryNavigation } from "../harness/memory/memory-navigation";
import { prepareMemoryCatalog, normalizeMemoryDirectoryNames } from "../harness/memory/memory-catalog";
import { prepareDreamAssociationBatch, parseDreamAssociationBatch } from "../harness/memory/dream-association-batch";
import { RELATED_MEMORY_SELECTION_RULES } from "../harness/memory/dream-engine";

async function create(f: PersonalMemoryFixture, title: string, kind: "fact" | "goal" = "fact") {
  return (await f.repository.write({ operation: "create", kind, title, content: `${title}：独立的实际约定。`, basis: "explicit", contentOrigin: "user_statement" }, f.runtime())).record!;
}
async function link(f: PersonalMemoryFixture, id: string, relatedIds: readonly string[]) {
  const state = await f.repository.inspect(); const record = state.records.find(record => record.id === id)!;
  await f.repository.applyCognitiveUpdate({ secondaryRecords: [], extraChanges: [], associationUpdates: [{ id, expectedRevision: record.revision, relatedIds }],
    expectedMemoryRevision: state.revision, detail: "association-test" });
}
function recall(f: PersonalMemoryFixture, selected: readonly string[], query = "独立问题", tokenBudget = 6_000) {
  return new PersonalMemoryRecallHarness(f.repository, { decisions: { judgeMemory: async request => ({ selected,
    probabilities: Object.fromEntries(request.memories.map(entry => [entry.id, selected.includes(entry.id) ? 1 : 0.6])) }) } })
    .prepareTurnContext({ ...f.runtime(), decisionTurnId: "association-test", query, tokenBudget, availableInputTokens: 32_000 });
}
export async function runMemoryAssociationTests() {
  await withPersonalMemoryFixture(async f => {
    const a = await create(f, "种子ABC"), b = await create(f, "低概率目标"), c = await create(f, "临界概率目标");
    await link(f, a.id, [b.id, c.id]);
    const cloud = new PersonalMemoryRecallHarness(f.repository, { decisions: { judgeMemory: async () => ({ selected: [a.id], probabilities: { [a.id]: 0.99, [b.id]: 0.499, [c.id]: 0.5 } }) } });
    const input = { ...f.runtime(), query: a.title, decisionTurnId: "cloud-gate", tokenBudget: 6000, availableInputTokens: 32000 };
    const accepted = await cloud.prepareTurnContext(input);
    assert.deepEqual(new Set(accepted.recall!.candidates.map(item => item.id)), new Set([a.id, c.id]));
    assert.equal(accepted.selectionReceipt!.expandedSources![c.id], "cloud_probability");
    assert.equal(accepted.selectionReceipt!.associationThreshold, 0.5);
    for (const selected of [[a.id], [a.id, c.id]]) {
      const prepared = await new PersonalMemoryRecallHarness(f.repository, { directory: { modelInputBudget: 32000, llm: { call: async request => {
        const rows = JSON.parse(request.systemPrompt.split("\n</memory_directory>")[0].split("\n").slice(1).join("\n"));
        assert.deepEqual(new Set(rows.find((entry: { id: string }) => entry.id === a.id).related), new Set([b.id, c.id]));
        return { text: JSON.stringify(selected) };
      } } } }).prepareTurnContext(input);
      assert.deepEqual(prepared.recall!.candidates.map(item => item.id), selected, "seen but unselected neighbors are never reintroduced");
      assert.equal(prepared.recall!.total, selected.length, "directory-selected linked entries are already included in total");
      if (selected.length > 1) {
        assert.equal(prepared.selectionReceipt!.expandedSources![c.id], "directory_selected");
        assert.deepEqual(prepared.recall!.candidates[1].relatedFrom, { id: a.id, title: a.title });
      }
    }
    const unseen = await f.repository.prepareTurnSnapshot({ memoryMode: "normal", query: a.title, preferredCandidateIds: [a.id],
      associationJudgment: { route: "directory", seenIds: [a.id] }, selectCandidateIds: (candidates, required) => required?.length ? candidates.map(candidate => candidate.id) : [a.id] }, f.runtime());
    assert.equal(unseen.search!.associationSources![b.id], "unseen_fallback");
    const lexical = await new PersonalMemoryRecallHarness(f.repository).prepareTurnContext(input);
    assert.equal(lexical.selectionReceipt!.expandedSources![b.id], "unseen_fallback");
    let calls = 0;
    const incomplete = await new PersonalMemoryRecallHarness(f.repository, { decisions: { judgeMemory: async () => ({ selected: [a.id], probabilities: { [a.id]: 1 } }) },
      directory: { modelInputBudget: 32000, llm: { call: async () => { calls++; return { text: JSON.stringify([a.id]) }; } } } }).prepareTurnContext(input);
    assert.equal(calls, 1); assert.equal(incomplete.selectionReceipt!.route, "directory");
    assert.deepEqual(incomplete.recall!.candidates.map(item => item.id), [a.id]);
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const a = await create(f, "山间路线"), b = await create(f, "柠檬配方"), c = await create(f, "远处灯塔"), d = await create(f, "深海温度");
    const aPath=path.join(f.repository.layout.root,a.file);
    await fs.writeFile(aPath,(await fs.readFile(aPath,"utf8")).replace("---\n",'---\nowner_tag: "preserve-me"\n'));
    await link(f, a.id, [b.id, c.id]);
    assert.match(await fs.readFile(aPath,"utf8"),/owner_tag: "preserve-me"/u); await link(f, b.id, [d.id]);
    const prepared = await recall(f, [a.id], "山间路线");
    assert.deepEqual(new Set(prepared.recall!.candidates.map(item => item.id)), new Set([a.id, b.id, c.id]));
    assert.ok(!prepared.recall!.candidates.some(item => item.id === d.id), "one hop only");
    for (const candidate of prepared.recall!.candidates.slice(1)) assert.deepEqual(candidate.relatedFrom, { id: a.id, title: a.title });
    assert.equal(prepared.selectionReceipt!.expandedIds!.length, 2);
    assert.equal((await recall(f, [a.id], "山间路线", 1)).recall!.candidates.length, 0, "no admitted seed means no neighbor");
    assert.equal((await recall(f, [], "毫不相干")).recall!.candidates.length, 0, "no seed means no expansion");
    const record = (await f.repository.inspect()).records.find(record => record.id === a.id)!;
    const roundtrip = parseCanonicalMemoryRecord(serializeCanonicalMemoryRecord(record), record.file);
    assert.deepEqual(roundtrip.related, [b.id, c.id]);
    assert.equal(parseCanonicalMemoryRecord(serializeCanonicalMemoryRecord({ ...record, related: [] }), record.file).related, undefined);
    assert.throws(() => serializeCanonicalMemoryRecord({ ...record, related: [a.id] }));
    const reopened = await f.reopen(); assert.deepEqual((await reopened.inspect()).records.find(record => record.id === a.id)!.related, record.related);
    const b2 = (await f.repository.write({ operation: "supersede", targetId: b.id, title: "替换配方", content: "更新后的配方。", basis: "explicit", reason: "更新" }, f.runtime())).record!;
    assert.deepEqual(b2.related, [d.id], "replacement inherits relationships");
    assert.ok(memoryAssociationGraph((await f.repository.inspect()).records).get(a.id)!.has(b2.id), "old IDs resolve to current replacements");
    await f.repository.write({ operation: "forget", targetId: b2.id, reason: "忘记", explicitForget: true }, f.runtime({ explicitlyAuthorized: true }));
    assert.ok(!(await recall(f, [a.id])).recall!.candidates.some(item => item.id === b2.id));
    const merged = mergeInjectedMemorySources([{ id: c.id, title: c.title, reason: "related", relatedFrom: { id: a.id, title: a.title }, revision: 1 }], [{ id: c.id, title: c.title, reason: "tool_read", revision: 2 }]);
    assert.equal(merged.length, 1); assert.equal(merged[0].reason, "related"); assert.equal(merged[0].relatedFrom!.title, a.title);
    assert.equal(memoryRecallReason(merged[0].reason, "zh", merged[0].relatedFrom), `由「${a.title}」带出`);
    assert.equal(memoryRecallReason("related", "en", merged[0].relatedFrom), `Linked from ${a.title}`);
    assert.equal(prepared.navigation!.total, 1); assert.ok(prepared.navigation!.content.includes(d.id));
    assert.ok(!prepared.navigation!.content.includes(a.id));
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const a = await create(f, "甲"), b = await create(f, "乙"); let calls = 0;
    const system = await CognitiveSystem.create({ repository: f.repository, llm: () => ({ call: async input => {
      calls++; if (input.systemPrompt.includes("本次只输出 USER")) return "no_change";
      const value = JSON.parse(input.userPrompt); return JSON.stringify({ secondaryFacts: [], userProfileItems: [], relatedIds: value.memory.title === a.title ? [b.id] : [] });
    } }), getDreamConfig: () => ({ enabled: false, runsPerDay: 1 }), registerInterval: () => undefined, now: f.now });
    try {
      const result = await system.engine.runOnce(); assert.equal(result.committed, true, JSON.stringify(result)); assert.equal(result.failedMemoryIds.length, 0);
      const records = (await f.repository.inspect()).records; assert.deepEqual(records.find(record => record.id === a.id)!.related, [b.id]);
      const state = await system.dreamStateStore.read();
      for (const record of records) assert.equal(state.processedMemorySources.find(source => source.memoryId === record.id)!.associationRevision, record.revision);
      const previous = calls; assert.equal((await system.engine.runOnce()).processedMemoryIds.length, 0); assert.equal(calls, previous, "legal empty relationships do not cause paid retries");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  let failCommit = false;
  await withPersonalMemoryFixture(async f => {
    const a = await create(f, "来源甲"), b = await create(f, "目标乙"); let calls = 0;
    const system = await CognitiveSystem.create({ repository: f.repository, llm: () => ({ call: async input => {
      calls++; assert.match(input.systemPrompt, /只判断记忆与记忆/);
      const value = JSON.parse(input.userPrompt); return JSON.stringify(Object.fromEntries(value.memories.map((record: { id: string }) => [record.id, record.id === a.id ? [b.id] : []])));
    } }), getDreamConfig: () => ({ enabled: false, runsPerDay: 1 }), registerInterval: () => undefined, now: f.now });
    try {
      const records = (await f.repository.inspect()).records;
      await system.dreamStateStore.write({ ...await system.dreamStateStore.read(), processedMemorySources: records.map(record => ({ memoryId: record.id, memoryRevision: record.revision, processedAt: f.now() })) });
      failCommit = true;
      const failed = await system.engine.runOnce(); assert.equal(failed.committed, false);
      assert.equal((await f.repository.inspect()).records.find(record => record.id === a.id)!.related, undefined, "transaction rolled back the primary relationship");
      assert.ok((await system.dreamStateStore.read()).processedMemorySources.every(source => source.associationRevision === undefined), "failed commit never marks association checks complete");
      const retry=await system.engine.runOnce(); assert.equal(retry.committed, true, JSON.stringify(retry));
      const previous = calls; system.dreamStateStore.invalidate();
      assert.equal((await system.engine.runOnce()).processedMemoryIds.length, 0); assert.equal(calls, previous, "association-only legal empty survives disk reread");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false, failTransactionAfterChange: (operation, applied) => {
    if (failCommit && operation === "cognitive-update" && applied === 3) { failCommit = false; throw new Error("injected_write_failure"); } return false;
  } });
  await withPersonalMemoryFixture(async f => {
    const records = [];
    for (let index = 0; index < 8; index++) records.push(await create(f, `存量记忆${index}`));
    const ids = records.map(record => record.id);
    const malformed = { [ids[0]]: [], [ids[2]]: ["mem_illegal"], [ids[3]]: ids.filter(id => id !== ids[3]).slice(0, 6),
      [ids[4]]: [ids[4]], [ids[5]]: [ids[0], ids[0]], [ids[6]]: "not-array", [ids[7]]: [ids[0]] };
    assert.deepEqual([...parseDreamAssociationBatch(JSON.stringify(malformed), ids, ids).keys()], [ids[0], ids[7]]);
    assert.equal(parseDreamAssociationBatch("{broken", ids, ids).size, 0);
    const directory = records.map(record => ({ ...record, summary: record.content, activity: 1 }));
    const options = { rules: RELATED_MEMORY_SELECTION_RULES, tokenBudget: 20_000, inputTokenBudget: 32_000, maxInputChars: 2_000 };
    const full = await prepareDreamAssociationBatch(records, directory, options);
    assert.equal(full!.records.length, 8);
    const budget = full!.inputTokens + full!.maxTokens - 1;
    const split = await prepareDreamAssociationBatch(records, directory, { ...options, tokenBudget: budget });
    assert.ok(split!.records.length > 0 && split!.records.length < 8, "actual prompt plus complete response reserve splits the batch");
    assert.equal(split!.catalog.entries.length, 8, "split targets before narrowing the complete catalog");
    assert.ok(split!.inputTokens + split!.maxTokens <= budget);
    const contextSplit = await prepareDreamAssociationBatch(records, directory, { ...options, inputTokenBudget: budget });
    assert.equal(contextSplit!.records.length, split!.records.length, "Provider context and Dream budget are both enforced");
    assert.equal(await prepareDreamAssociationBatch(records, directory, { ...options, tokenBudget: 1 }), null);

    let calls = 0;
    const batches: string[][] = [];
    const openSystem = (repository: PersonalMemoryFixture["repository"]) => CognitiveSystem.create({ repository,
      llm: () => ({ call: async input => {
        calls++;
        assert.doesNotMatch(input.systemPrompt, /本次只输出 USER/, "association backfill never pays for profile analysis");
        const value = JSON.parse(input.userPrompt);
        const batchIds = value.memories.map((record: { id: string }) => record.id);
        batches.push(batchIds);
        assert.equal(value.directory.length, 8);
        return JSON.stringify(calls === 1 ? malformed : Object.fromEntries(batchIds.map((id: string) => [id, []])));
      } }), getDreamConfig: () => ({ enabled: false, runsPerDay: 1 }), registerInterval: () => undefined, now: f.now });
    let system = await openSystem(f.repository);
    try {
      await system.dreamStateStore.write({ ...await system.dreamStateStore.read(), pendingMemoryIds: ids,
        processedMemorySources: records.map(record => ({ memoryId: record.id, memoryRevision: record.revision, processedAt: f.now() })) });
      const first = await system.engine.runOnce();
      assert.equal(first.committed, true); assert.deepEqual(first.processedMemoryIds, [ids[0], ids[7]]);
      assert.deepEqual(new Set(first.failedMemoryIds), new Set(ids.slice(1, 7)));
      assert.equal(calls, 1, "eight old memories share one request");
      const firstState = await system.dreamStateStore.read();
      assert.equal(firstState.associationSelections!.length, 8);
      assert.ok(firstState.associationSelections!.every(receipt => receipt.batchSize === 8 && receipt.batchIndex === 1));
      assert.deepEqual(firstState.pendingMemoryIds, ids.slice(1, 7));
      assert.deepEqual((await f.repository.inspect()).records.find(record => record.id === ids[7])!.related, [ids[0]], "valid sibling commits its primary edge");
      await system.dispose();
      system = await openSystem(await f.reopen());
      const retry = await system.engine.runOnce();
      assert.equal(retry.committed, true); assert.deepEqual(batches[1], ids.slice(1, 7), "restart retries only invalid or missing items");
      assert.equal(retry.failedMemoryIds.length, 0); assert.equal(calls, 2);
      await system.dispose();
      system = await openSystem(await f.reopen());
      assert.equal((await system.engine.runOnce()).processedMemoryIds.length, 0);
      assert.equal(calls, 2, "completed empty and nonempty rows survive cold reopen without another call");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const seeds = [await create(f, "种子一"), await create(f, "种子二")];
    const targets = [await create(f, "目标一"), await create(f, "目标二"), await create(f, "目标三"), await create(f, "目标四")];
    for (const seed of seeds) await link(f, seed.id, targets.map(target => target.id));
    const result = await recall(f, seeds.map(seed => seed.id));
    const expanded = result.recall!.candidates.filter(item => item.relatedFrom);
    assert.equal(expanded.length, 3); assert.equal(new Set(expanded.map(item => item.id)).size, 3);
    for (const seed of seeds) assert.ok(expanded.filter(item => item.relatedFrom!.id === seed.id).length <= 2);
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const memories = [await create(f, "甲目标", "goal"), await create(f, "乙目标", "goal")];
    let sent = 0;
    const prepared = await new PersonalMemoryRecallHarness(f.repository, { decisions: { judgeMemory: async request => { sent = request.memories.length; return { selected: [memories[0].id], probabilities: Object.fromEntries(request.memories.map(entry => [entry.id, entry.id === memories[0].id ? 1 : 0])) }; } },
      directory: { modelInputBudget: 100, llm: { call: async () => { throw Error("No fallback expected"); } } } })
      .prepareTurnContext({ ...f.runtime(), query: "这件事", tokenBudget: 4_000, decisionTurnId: "small-chat-context" });
    assert.equal(sent, 2, "chat-provider budget cannot prefilter the separate cloud classifier"); assert.equal(prepared.recall!.candidates[0].id, memories[0].id);
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    const a=await create(f,"模型等待前的记忆"), b=await create(f,"另一条记忆");const observed=await f.repository.inspect();
    const file=path.join(f.repository.layout.root,a.file);await fs.writeFile(file,(await fs.readFile(file,"utf8")).replace(a.content,a.content+"用户刚刚补充的新原话。"));
    await assert.rejects(()=>f.repository.applyCognitiveUpdate({secondaryRecords:[],extraChanges:[],associationUpdates:[{id:a.id,expectedRevision:a.revision,relatedIds:[b.id]}],expectedMemoryRevision:observed.revision,detail:"concurrent-user-edit"}),/revision conflict/iu);
    assert.match((await f.repository.inspect()).records.find(record=>record.id===a.id)!.content,/用户刚刚补充的新原话/u);
  },{watchExternalChanges:false});
  const names=[{id:"name-fixture",title:"EchoInk 与 DeepSeek，NovaNote iPhone May US",recallWhen:"",activity:1}];
  assert.equal(normalizeMemoryDirectoryNames("ECHOINK 接 Deepseek 或 NOVANOTE",names),"echoink 接 deepseek 或 novanote");
  assert.equal(normalizeMemoryDirectoryNames("US us OtherBrand MyEchoInk `EchoInk` /tmp/EchoInk https://x/EchoInk",names),"US us OtherBrand MyEchoInk `EchoInk` /tmp/EchoInk https://x/EchoInk");
  assert.equal(normalizeMemoryDirectoryNames("May may IPHONE ```\nEchoInk\n```",names),"May may iphone ```\nEchoInk\n```");
  const entries = Array.from({ length: 80 }, (_, i) => ({ id: `entry-${i}`, title: `完整标题${i}`, recallWhen: "场景", summary: "内容", kind: "fact" as const, date: "2026-11-14", activity: i, score: i === 79 ? 2 : 0 }));
  const full = await prepareMemoryCatalog(entries, { tokenBudget: 30_000 }); assert.equal(full.entries.length, 80); assert.equal(full.prefiltered, false);
  const screened = await prepareMemoryCatalog(entries, { tokenBudget: 500 }); assert.equal(screened.prefiltered, true); assert.ok(screened.entries.some(entry => entry.id === "entry-79"));
  const navigation = await buildMemoryNavigation(entries, new Set(["entry-0"]), 300); assert.ok(navigation.tokens <= 300); assert.equal(navigation.total, 79); assert.equal(navigation.truncated, true);
  assert.throws(() => parseCanonicalMemoryManifest(JSON.stringify({ schemaVersion: 1, vaultId: "v", revision: 0, updatedAt: 0, tombstones: [], records: [{ related: ["bad"] }] })));
  console.log("PASS memory association: transactional roundtrip, one hop, real seed/budget, redirects, forget, first receipt reason, Dream revision/empty ledger, full catalog and navigation budgets");
}
