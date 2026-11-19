import { adapterMemoryQuoteReader } from "../mobile/memory-quotes";
import assert from "node:assert/strict";
import { mkdir, appendFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { createDurablePiSession, assertPiSessionAppendsDurable } from "../harness/pi-native/pi-session-durability";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { MemoryOriginalQuoteReader, memoryQuoteSource, compareMemoryQuotes, type MemoryOriginalQuotePort, type MemoryOriginalQuote } from "../harness/memory/memory-original-quote";
import { canUndoDreamCorrection, correctionCheckKey, emptyDreamCorrectionState, type DreamCorrectionMutation } from "../harness/memory/dream-correction-core";
import { DreamStateStore, defaultDreamState, parseDreamState } from "../harness/memory/dream-state";
import { DreamExperienceInboxStore, normalizeDreamPublicExperience, appendDreamPublicExperience, defaultDreamExperienceInboxState } from "../harness/memory/dream-experience-inbox";
import { CognitiveSystem } from "../harness/memory/cognitive-system";
import { parseCorrectionJudgments } from "../harness/memory/dream-reconciler";
import type { PersonalMemoryRecord } from "../harness/memory/personal-memory-contracts";
import { withPersonalMemoryFixture, type PersonalMemoryFixture } from "./personal-memory-fixture";
import { applyDreamProfileUpdate, emptyUserProfileState, userProfileStateJson } from "../harness/memory/user-profile-state";
import { renderUserMarkdown } from "../harness/memory/cognitive-projection";
import { createHash } from "node:crypto";
import { createSecondaryRecord, serializeSecondaryRecord, SecondaryMemoryStore } from "../harness/memory/secondary-memory-store";
import { queryMemoryPage } from "../plugin/memory-page-service";

const source = (id: string, sessionId = "session-fixture") => memoryQuoteSource({ vaultId: "fixture", conversationId: "conversation-fixture", sessionId, entryId: id, productRunId: `run-${id}` });
function original(id: string, text: string, position: number): MemoryOriginalQuote {
  return { source: source(id), pointer: { vaultId: "fixture", conversationId: "conversation-fixture", sessionId: "session-fixture", entryId: id, productRunId: `run-${id}` }, text, timestamp: 1800000000000 + position, position };
}
async function seed(f: PersonalMemoryFixture, count = 1, pinned = false) {
  const records: PersonalMemoryRecord[] = [];
  for (let i = 0; i < count; i++) records.push((await f.repository.write({ operation: "create", kind: "decision", pinned,
    title: `旧决定 ${i}`, content: `旧事实 ${i}`, recallWhen: `检查决定 ${i}`, basis: "explicit", contentOrigin: "user_statement" },
  f.runtime({ userEntryId: `old-${i}`, productRunId: `run-old-${i}`, piSessionId: "session-fixture", explicitlyAuthorized: pinned }))).record!);
  return records;
}
const derive = JSON.stringify({ secondaryFacts: [], userProfileItems: [], relatedIds: [] });
function modelReply(input: { systemPrompt: string; userPrompt: string }, decision: (id: string, phase: string) => "correct" | "obsolete" | "confirmed" | "uncertain") {
  const value = input.userPrompt === "" ? {} : JSON.parse(input.userPrompt);
  if (input.systemPrompt.includes("纠错候选挑选")) return JSON.stringify(value.directory.map((entry: { id: string }) => entry.id));
  if (input.systemPrompt.includes("拿用户原话核对记忆")) return JSON.stringify({ results: value.memories.map((entry: { id: string }) => {
    const conclusion = decision(entry.id, value.phase);
    return { id: entry.id, source: value.source, conclusion, ...(conclusion === "correct" ? { title: "修正标题", content: "修正后的原话事实", recallWhen: "再次核对决定时" } : {}) };
  }) });
  if (input.systemPrompt.includes("本次只输出 USER")) return "no_change";
  if (value.memories) return JSON.stringify(Object.fromEntries(value.memories.map((entry: { id: string }) => [entry.id, []])));
  return derive;
}
const quotePort = (): MemoryOriginalQuotePort => ({ source: async text => {
  const id = decodeURIComponent(text.split("?")[0].split("/").at(-1)!);
  return { quote: { ...original(id, id === "new" ? "明确改口：使用修正后的原话事实" : "旧事实", id === "new" ? 100 : Number(id.replace("old-", "")) || 0), source: text } };
}, experience: async entry => ({ quote: original("new", entry.userText, 100) }) });
async function experience(f: PersonalMemoryFixture) {
  return await new DreamExperienceInboxStore(f.repository.layout.root).append({ conversationId: "conversation-fixture", productRunId: "run-new", userEntryId: "new",
    assistantEntryId: "answer-new", occurredAt: 1, userText: "明确改口：使用修正后的原话事实", assistantText: "已收到", taskResult: { terminalState: "failed", successfulToolNames: [], failedToolNames: [] } }, f.now());
}

export async function runDreamReconciliationTests(): Promise<void> {
  await originalReader();
  strictResponseAndTime();
  inboxConsumers();
  await correctionAndUndo();
  await originalRepairAndConflicts();
  await invertedExperienceOrder();
  await allPinnedAndBadResponse();
  await failureAndRestart();
  await derivedAndProfile();
  await legacyPinnedSuggestions();
  console.log("Dream reconciliation: identity/compaction, ordering, strict responses, atomic correction/undo, all-targets/pinned-auto, legacy-ignore, crash/restart, derived/profile PASS");
}

async function originalReader() {
  await withPersonalMemoryFixture(async f => {
    const storageRootPath = path.join(f.vaultPath, "quote-store");
    const catalog = new FileConversationCatalog({ storageRootPath, vaultId: f.vaultId }); await catalog.initialize();
    const opened = createDurablePiSession({ api: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
      open: (file, root, cwd) => SessionManager.open(file, root, cwd) }, sessionRoot: catalog.sessionRootPath, cwd: f.vaultPath });
    const entryId = opened.sessionManager.appendMessage({ role: "user", content: "我打算试用，尚未决定。", timestamp: 1800000000000 });
    assertPiSessionAppendsDurable({ sessionRoot: catalog.sessionRootPath, sessionManager: opened.sessionManager, expectedEntryIds: [entryId] });
    await catalog.upsert({ conversationId: "quote-conversation", piSessionId: opened.piSessionId, vaultId: f.vaultId, title: "原话", status: "active", defaultMemoryMode: "normal", sessionFile: opened.sessionFile, createdAt: 1, updatedAt: 1 });
    const runs = new FileProductRunStore({ storageRootPath, vaultId: f.vaultId, catalog });
    await runs.create({ productRunId: "quote-run", conversationId: "quote-conversation", piSessionId: opened.piSessionId, userEntryId: entryId, toolCallIds: [], memoryMode: "normal", state: "accepted", activeLeafId: entryId, createdAt: 1, updatedAt: 1 });
    const pointer = { vaultId: f.vaultId, conversationId: "quote-conversation", sessionId: opened.piSessionId, entryId, productRunId: "quote-run" };
    const reader = new MemoryOriginalQuoteReader(catalog, runs);
    const mobileReader = adapterMemoryQuoteReader({
      exists: async relative => { try { await access(path.join(f.vaultPath, relative)); return true; } catch { return false; } },
      read: relative => readFile(path.join(f.vaultPath, relative), "utf8")
    }, "quote-store", "plugin/mobile", f.vaultId);
    assert.deepEqual(await mobileReader.source(memoryQuoteSource(pointer)), await reader.source(memoryQuoteSource(pointer)), "mobile DataAdapter reads the same original desktop Catalog/ProductRun/JSONL pointer");
    const before = await readFile(opened.sessionFile, "utf8");
    assert.equal((await reader.source(memoryQuoteSource(pointer))).quote?.text, "我打算试用，尚未决定。");
    const compactId = "compacted-entry";
    await appendFile(opened.sessionFile, JSON.stringify({ type: "compaction", id: compactId, parentId: entryId, timestamp: new Date(1800000000200).toISOString(), summary: "摘要", firstKeptEntryId: entryId, tokensBefore: 100 }) + "\n");
    assert.equal((await reader.source(memoryQuoteSource(pointer))).quote?.text, "我打算试用，尚未决定。", "raw entry remains readable after compaction");
    assert.equal((await mobileReader.source(memoryQuoteSource(pointer))).quote?.text, "我打算试用，尚未决定。", "mobile reads the original entry after desktop compaction too");
    assert.equal((await reader.source(memoryQuoteSource({ ...pointer, vaultId: "other" }))).reason, "vault_mismatch");
    assert.equal((await reader.source(memoryQuoteSource({ ...pointer, sessionId: "other" }))).reason, "session_mismatch");
    assert.equal((await reader.source(memoryQuoteSource({ ...pointer, entryId: compactId }))).reason, "product_run_mismatch");
    await runs.create({ productRunId: "non-user-run", conversationId: "quote-conversation", piSessionId: opened.piSessionId, userEntryId: compactId, toolCallIds: [], memoryMode: "normal", state: "accepted", activeLeafId: compactId, createdAt: 2, updatedAt: 2 });
    assert.equal((await reader.source(memoryQuoteSource({ ...pointer, entryId: compactId, productRunId: "non-user-run" }))).reason, "role_mismatch");
    await catalog.status("quote-conversation", "deleted");
    assert.equal((await reader.source(memoryQuoteSource(pointer))).reason, "conversation_deleted");
    assert.ok((await readFile(opened.sessionFile, "utf8")).startsWith(before), "reader never rewrites JSONL");
  }, { watchExternalChanges: false });
}
function strictResponseAndTime() {
  assert.equal(compareMemoryQuotes(original("later", "B", 2), original("earlier", "A", 1)), 1);
  assert.equal(compareMemoryQuotes(original("earlier", "A", 1), original("later", "B", 2)), -1);
  const a = original("a", "A", 1), b = { ...original("b", "B", 1), pointer: { ...a.pointer, sessionId: "other" } };
  assert.equal(compareMemoryQuotes(a, b), null, "same timestamp across sessions has unknown order");
  for (const raw of ["{", '{"results":[]}', JSON.stringify({ results: [{ id: "wrong", source: "source", conclusion: "confirmed" }] }), JSON.stringify({ results: [{ id: "mem_one", source: "source", conclusion: "correct", content: "x" }] })])
    assert.throws(() => parseCorrectionJudgments(raw, ["mem_one"], "source"));
  assert.equal(parseDreamState({ ...defaultDreamState(), reconciliation: { events: "corrupt" } }), null);
}
function inboxConsumers() {
  let inbox = defaultDreamExperienceInboxState();
  const entry = (i: number) => ({ conversationId: "inbox", productRunId: `run-${i}`, userEntryId: `user-${i}`, assistantEntryId: `answer-${i}`, occurredAt: i,
    userText: `用户${i}`, assistantText: "回答", taskResult: { terminalState: "completed" as const, successfulToolNames: [], failedToolNames: [] } });
  for (let i = 0; i < 128; i++) inbox = appendDreamPublicExperience(inbox, entry(i), i);
  const preserved = inbox.entries[0].fingerprint, evicted = inbox.entries[1].fingerprint;
  inbox = { ...inbox, entries: inbox.entries.map((e, i) => i === 0 ? { ...e, evaluatedAt: 1 } : i === 1 ? { ...e, evaluatedAt: 1, reconciledAt: 1 } : e) };
  inbox = appendDreamPublicExperience(inbox, entry(129), 129);
  assert.ok(inbox.entries.some(e => e.fingerprint === preserved)); assert.ok(!inbox.entries.some(e => e.fingerprint === evicted));
}
async function correctionAndUndo() {
  for (const pinned of [false, true]) for (const action of ["correct", "obsolete"] as const) await withPersonalMemoryFixture(async f => {
    const [old] = await seed(f, 1, pinned); await experience(f); let calls = 0;
    const system = await CognitiveSystem.create({ repository: f.repository, originalQuotes: quotePort(), now: f.now, registerInterval: () => {}, getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }),
      llm: () => ({ call: async input => { calls++; return modelReply(input, (_id, phase) => phase === "change" ? action : "confirmed"); } }) });
    try {
      const result = await system.forceDreamRun(); assert.equal(result!.error, null);
      const ledger = await f.repository.readDreamCorrections(); assert.equal(ledger.events.length, 1);
      const event = ledger.events[0]; assert.ok(canUndoDreamCorrection(event, (await f.repository.inspect()).records));
      if (action === "correct") {
        const replacement = (await f.repository.inspect()).records.find(r => r.id === event.afterId)!;
        assert.equal(replacement.contentOrigin, "dream_correction");
        assert.equal(replacement.pinned, pinned);
      }
      const previous = calls; await system.forceDreamRun(); assert.equal(calls, previous, "no new content => zero calls including reconciliation/profile");
      await seed(f, 1); // unrelated change does not invalidate undo
      await f.repository.undoDreamCorrection(event.id);
      assert.equal((await f.repository.inspect()).records.find(r => r.id === old.id)!.status, "current");
      assert.equal((await f.repository.inspect()).records.find(r => r.id === old.id)!.pinned, pinned);
      await system.forceDreamRun();
      assert.equal((await f.repository.readDreamCorrections()).events.length, 1, "undo suppresses same correction next round");
      const reopened = await f.reopen(); assert.equal((await reopened.readDreamCorrections()).events[0].undoneAt !== undefined, true);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
}
async function allPinnedAndBadResponse() {
  await withPersonalMemoryFixture(async f => {
    const records = await seed(f, 8), pin = records[7], closedPin = records[6];
    await f.repository.setPinnedFromUserControl(pin.id, true, (await f.repository.inspect()).revision);
    await f.repository.setPinnedFromUserControl(closedPin.id, true, (await f.repository.inspect()).revision);
    await experience(f); let calls = 0;
    const system = await CognitiveSystem.create({ repository: f.repository, originalQuotes: quotePort(), now: f.now, registerInterval: () => {}, getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }), llm: () => ({ call: async input => {
      calls++; return modelReply(input, (id, phase) => phase === "change" ? (id === closedPin.id ? "obsolete" : "correct") : "confirmed");
    } }) });
    try {
      assert.equal((await system.forceDreamRun())!.error, null);
      const ledger = await f.repository.readDreamCorrections();
      assert.equal(ledger.events.length, 8, "one Dream submits every correction and closure, including pinned targets");
      assert.equal(ledger.diagnostic?.corrected, 7); assert.equal(ledger.diagnostic?.obsolete, 1);
      assert.ok(ledger.experiences.every(e => e.completed));
      assert.ok(!ledger.checks.some(c => c.status === "pending_write"));
      const event = ledger.events.find(e => e.beforeId === pin.id)!;
      const replacement = (await f.repository.inspect()).records.find(r => r.id === event.afterId)!;
      assert.equal(replacement.pinned, true); assert.equal(replacement.contentOrigin, "dream_correction");
      assert.ok(canUndoDreamCorrection(event, (await f.repository.inspect()).records));
      assert.ok(canUndoDreamCorrection(ledger.events.find(e => e.beforeId === closedPin.id)!, (await f.repository.inspect()).records));
      const previous = calls;
      assert.equal((await system.forceDreamRun())!.error, null);
      assert.equal(calls, previous, "nothing is deferred to a second Dream");
      assert.equal((await f.repository.readDreamCorrections()).events.length, 8);
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
  await withPersonalMemoryFixture(async f => {
    await seed(f); await experience(f);
    const system = await CognitiveSystem.create({ repository: f.repository, originalQuotes: quotePort(), now: f.now, registerInterval: () => {}, getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }), llm: () => ({ call: async () => "{" }) });
    try { assert.ok((await system.forceDreamRun())!.error); const ledger = await f.repository.readDreamCorrections(); assert.equal(ledger.events.length, 0); assert.ok(!ledger.experiences.some(e => e.completed)); assert.equal(ledger.calls.length, 1); }
    finally { await system.dispose(); }
  }, { watchExternalChanges: false });
}

async function legacyPinnedSuggestions() {
  await withPersonalMemoryFixture(async f => {
    const [old] = await seed(f, 1, true);
    const check = { ...mutation(old).check, status: "written" as const, reason: "pinned_suggestion" };
    const state = { ...emptyDreamCorrectionState(), checks: [check] };
    for (const suggestions of [[{ checkKey: check.key, memoryId: old.id, title: "旧提示" }], "obsolete malformed payload", null]) {
      const parsed = parseDreamState({ ...defaultDreamState(), reconciliation: { ...state, suggestions } });
      assert.ok(parsed, "legacy suggestion payload must never break loading");
      assert.ok(!("suggestions" in parsed.reconciliation!));
      assert.deepEqual(parsed.reconciliation?.checks, state.checks);
    }
    await new DreamStateStore(f.repository.layout.root).update(current => ({ ...current, reconciliation: { ...state, suggestions: [{ title: "旧提示" }] } }));
    const cold = await f.reopen();
    assert.ok(!("suggestions" in await cold.readDreamCorrections()));
    const page = await queryMemoryPage({ repository: cold, conversations: [], enabled: true, tokenBudget: 1200, request: {} });
    assert.ok(!("correctionSuggestions" in page));
    assert.equal(page.stars.find(r => r.id === old.id)?.pinned, true);
  }, { watchExternalChanges: false });
}
async function originalRepairAndConflicts() {
  for (const conflict of [false, true]) await withPersonalMemoryFixture(async f => {
    const [old] = await seed(f); const longQuote = "我只是打算试用，并没有定下来。".repeat(200) + "完整原话尾部标记";
    let seenFullQuote = false;
    const system = await CognitiveSystem.create({ repository: f.repository, originalQuotes: { ...quotePort(), source: async text => ({ quote: { ...original("old-0", longQuote, 0), source: text } }) }, now: f.now,
      registerInterval: () => {}, getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }), llm: () => ({ call: async input => {
        if (input.systemPrompt.includes("拿用户原话核对记忆")) {
          seenFullQuote = input.userPrompt.includes("完整原话尾部标记");
          if (conflict) await f.repository.supersedeFromUserCorrection({ targetId: old.id, title: "用户抢先改", content: "用户优先", recallWhen: "核对", reason: "并发用户修改", expectedRevision: (await f.repository.inspect()).revision });
        }
        return modelReply(input, (_id, phase) => phase === "original" ? "correct" : "confirmed");
      } }) });
    try {
      const result = await system.forceDreamRun(); assert.ok(seenFullQuote, "original user quote is never truncated at maxInputChars");
      const ledger = await f.repository.readDreamCorrections();
      if (conflict) { assert.ok(result!.error); assert.equal(ledger.events.length, 0); assert.ok(ledger.calls.length > 0, "paid call retained on CAS conflict"); }
      else { assert.equal(result!.error, null); assert.equal(ledger.events[0].phase, "original"); assert.equal(ledger.events.length, 1); }
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
}
async function invertedExperienceOrder() {
  await withPersonalMemoryFixture(async f => {
    const [old] = await seed(f);
    const inbox = new DreamExperienceInboxStore(f.repository.layout.root);
    const later = { conversationId: "conversation-fixture", productRunId: "run-B", userEntryId: "B", assistantEntryId: "answer-B", occurredAt: 10,
      userText: "明确改为 B", assistantText: "收到", taskResult: { terminalState: "completed" as const, successfulToolNames: [], failedToolNames: [] } };
    await inbox.append(later); await inbox.append({ ...later, productRunId: "run-A", userEntryId: "A", assistantEntryId: "answer-A", occurredAt: 99999, userText: "明确改为 A" });
    const system = await CognitiveSystem.create({ repository: f.repository, originalQuotes: { ...quotePort(),
      source: async text => {
        const id = text.split("?")[0].split("/").at(-1)!;
        return ["A", "B"].includes(id) ? { quote: original(id, `明确改为 ${id}`, id === "B" ? 20 : 10) } : await quotePort().source(text);
      }, experience: async entry => ({ quote: original(entry.userEntryId, entry.userText, entry.userEntryId === "B" ? 20 : 10) }) },
      now: f.now, registerInterval: () => {}, getDreamConfig: () => ({ enabled: true, runsPerDay: 3 }), llm: () => ({ call: async input => {
        const value = JSON.parse(input.userPrompt);
        const reply = modelReply(input, (_id, phase) => phase === "change" ? "correct" : "confirmed");
        if (!input.systemPrompt.includes("拿用户原话核对记忆") || value.phase !== "change") return reply;
        const parsed = JSON.parse(reply); for (const result of parsed.results) result.content = value.userQuote;
        return JSON.stringify(parsed);
      } }) });
    try {
      assert.equal((await system.forceDreamRun())!.error, null);
      const event = (await f.repository.readDreamCorrections()).events.find(e => e.beforeId === old.id)!;
      assert.equal((await f.repository.inspect()).records.find(record => record.id === event.afterId)!.content, "明确改为 B", "same-day user entry order wins over reversed inbox and turn-end times");
    } finally { await system.dispose(); }
  }, { watchExternalChanges: false });
}
function mutation(record: PersonalMemoryRecord, action: "correct" | "obsolete" = "correct"): DreamCorrectionMutation {
  return { check: { key: correctionCheckKey("original", record, record.source), phase: "original", memoryId: record.id, memoryRevision: record.revision, source: record.source, status: "pending_write", conclusion: action, at: 1 }, action, ...(action === "correct" ? { title: "正确标题", content: "正确事实", recallWhen: "核对事实时" } : {}) };
}
async function failureAndRestart() {
  let fail = true;
  await withPersonalMemoryFixture(async f => {
    const [record] = await seed(f); const before = await f.repository.inspect();
    await assert.rejects(f.repository.applyDreamCorrections({ expectedMemoryRevision: before.revision, mutations: [mutation(record)], patch: {} }));
    fail = false;
    const reopened = await f.reopen(); assert.equal((await reopened.inspect()).records.length, 1); assert.equal((await reopened.readDreamCorrections()).events.length, 0);
    await reopened.applyDreamCorrections({ expectedMemoryRevision: (await reopened.inspect()).revision, mutations: [mutation(record)], patch: {} });
    const event = (await reopened.readDreamCorrections()).events[0];
    await reopened.supersedeFromUserCorrection({ targetId: event.afterId!, title: "再次修正", content: "用户新说法", recallWhen: "核对", reason: "用户更改", expectedRevision: (await reopened.inspect()).revision });
    await assert.rejects(reopened.undoDreamCorrection(event.id), /已再次更新，无法撤销/u);
  }, { watchExternalChanges: false, failTransactionAfterChange: operation => operation === "dream-correction" && fail });
}
async function derivedAndProfile() {
  await withPersonalMemoryFixture(async f => {
    const [old] = await seed(f);
    const profile = applyDreamProfileUpdate(emptyUserProfileState(1), { now: 2, items: [{ section: "collaboration", profileKey: "collaboration.feedback", text: "喜欢简短回答", basis: "explicit_memory", sourceMemoryId: old.id, sourceEvidence: { kind: "memory", revision: old.revision } }], processedSources: [{ memoryId: old.id, memoryRevision: old.revision }] });
    assert.equal(profile.items.length, 1, "profile fixture must contain a real supported slot");
    const userContent = renderUserMarkdown(profile);
    const updatedProfile = { ...profile, legacyUserMigration: "done" as const, lastProjectedUserHash: createHash("sha256").update(userContent.endsWith("\n") ? userContent : userContent + "\n").digest("hex") };
    const secondary = createSecondaryRecord({ parentId: old.id, title: "旧线索", content: "旧事实的场景入口", recallWhen: "旧场景", matchTerms: ["旧场景"], relation: "context", reason: "直接依据", supportLevel: "direct", evidence: "旧事实", basis: "llm_inferred", confidence: 0.8, sourceMemoryRevision: old.revision, now: f.now() });
    await f.repository.applyCognitiveUpdate({ userContent, secondaryRecords: [secondary], extraChanges: [{ relativePath: secondary.file, content: serializeSecondaryRecord(secondary) }, { relativePath: "shared-user/user-profile-state.json", content: userProfileStateJson(updatedProfile) }], detail: "fixture profile" });
    await f.repository.applyDreamCorrections({ expectedMemoryRevision: (await f.repository.inspect()).revision, mutations: [{ ...mutation(old), derived: { facts: [{ title: "新线索", content: "正确事实的场景入口", recallWhen: "新场景", matchTerms: ["新场景"], relation: "context", reason: "直接依据", supportLevel: "direct", evidence: "正确事实" }], profileItems: [] } }], patch: {} });
    const store = new SecondaryMemoryStore(f.repository.layout.history);
    const correctedFacts = await store.loadAll();
    assert.equal(correctedFacts.find(record => record.id === secondary.id)!.status, "disabled");
    assert.ok(correctedFacts.some(record => record.parentId !== old.id && record.status === "current"), "new version facts regenerate instead of inheriting old facts");
    const after = await f.repository.readUserProfileControlSnapshot();
    assert.ok(!after.items.some(item => item.sourceMemoryIds.includes(old.id)), "old profile evidence removed in correction transaction");
    await f.repository.undoDreamCorrection((await f.repository.readDreamCorrections()).events[0].id);
    assert.ok((await f.repository.readUserProfileControlSnapshot()).items.some(item => item.sourceMemoryIds.includes(old.id)), "undo restores only the retired primary's profile evidence");
    const undoneFacts = await new SecondaryMemoryStore(f.repository.layout.history).loadAll();
    assert.equal(undoneFacts.find(record => record.id === secondary.id)!.status, "current");
    assert.ok(!undoneFacts.some(record => record.parentId !== old.id && record.status === "current"));
    assert.equal((await f.reopen()).inspect instanceof Function, true);
  }, { watchExternalChanges: false });
}
