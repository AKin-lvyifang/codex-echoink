import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-memory-settings/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(path => /node:|personal-memory-repository\.ts|dream-engine\.ts|agent-self\.ts|agent-self-metadata\.ts/u.test(path)));
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URL, URLSearchParams,
  structuredClone, AbortController, setTimeout, clearTimeout, require: name => { assert.equal(name, "obsidian"); return { TFile: class {}, TFolder: class {} }; } });
const { MobileMemoryService, MobileMemoryRepository, MobileStore, loadMobileSettings, mobileProvider, mobileModel, MobileCapabilityPolicy, mobileTools,
  inspectMobileTaskResume, USER_PROFILE_SLOTS, applyDreamProfileUpdate, parseCanonicalMemoryRecord, indexChecksum } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value)), clone = value => structuredClone(value);
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let passed = 0;
async function test(name, run) { await run(); console.log(`OK ${++passed} ${name}`); }
function vault() {
  const files = new Map(), dirs = new Set(); let installFailure = false;
  const adapter = {
    exists: async path => files.has(path) || dirs.has(path), read: async path => { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    write: async (path, bytes) => { files.set(path, bytes); }, mkdir: async path => { dirs.add(path); }, remove: async path => { files.delete(path); },
    rename: async (from, to) => { if (installFailure && from.endsWith(".tmp")) { installFailure = false; throw new Error("fixture-install-failure"); } if (!files.has(from) || files.has(to)) throw new Error("rename conflict"); files.set(to, files.get(from)); files.delete(from); },
    list: async path => ({ files: [...files.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")), folders: [...dirs].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")) }),
    rmdir: async path => { for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key); for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key); }
  };
  return { files, adapter, failInstall: () => { installFailure = true; } };
}
async function fixture(request = async () => { throw new Error("No Provider must be used"); }, existing) {
  const host = existing ?? vault(), store = new MobileStore(host.adapter, "plugin/mobile", "memory-fixture"); await store.load();
  const settings = loadMobileSettings({ memory: { dreamRunsPerDay: 6, dreamTokenBudget: 50000, future: true } }); let now = new Date("2026-10-19T12:00:00Z").getTime(), calls = 0;
  const service = new MobileMemoryService({ adapter: host.adapter, store, settings: () => settings, saveSettings: async () => {}, request: async input => { calls++; return request(input); }, changed() {}, isBusy: () => false, now: () => now });
  store.bindCanonicalMemory(() => service.recordsForRuntime());
  return { ...host, store, settings, service, calls: () => calls, setNow: value => { now = value; } };
}
const oldMemory = (id = "mem_old") => ({ schema: "echoink.memory.v1", id, kind: "fact", status: "current", date: "2026-10-18T12:00:00.000Z", source: "mobile:old-task:call", basis: "explicit", title: "旧移动记忆", recallWhen: "长期偏好", content: "喜欢简洁答复", revision: 1, file: "old-device-state.json" });
async function seed(f, memories = [oldMemory()]) { await f.store.update(state => { state.memories = memories; }); return f.files.get(f.store.statePath); }
function model(f) {
  const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "synthetic-key", baseUrl: "https://provider.invalid/v1", models: [mobileModel("fixture")], defaultModelId: "fixture" });
  f.settings.apiProviders = [provider]; f.settings.activeApiProviderId = provider.id; f.settings.defaultModel = "fixture";
}
const answer = text => ({ status: 200, json: { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] } });
await test("unavailable identity keeps canonical reads and independent settings but never creates an ephemeral Memory transaction", async () => {
  const f = await fixture(); await seed(f); await f.service.initialize();
  const store = new MobileStore(f.adapter, "plugin/mobile", "ephemeral-shell", "本机任务标识无法保存");
  await store.load();
  const service = new MobileMemoryService({ adapter: f.adapter, store, settings: () => f.settings, saveSettings: async () => {}, request: async () => { throw new Error("No Provider"); }, changed() {}, isBusy: () => false });
  const before = [...f.files]; await service.initialize();
  assert.equal((await service.list()).records.length, 1);
  const profile = await service.readProfile();
  await assert.rejects(service.saveProfile("identity.name", "Uncommitted", profile.revision), /本机任务标识/u);
  await assert.rejects(service.runDream(), /本机任务标识/u);
  await assert.rejects(service.repository.updateAuxiliary("shared-user/.runtime/ephemeral.json", () => ({ content: "unsafe", value: true })), /本机任务标识/u);
  assert.deepEqual([...f.files], before);
  const draft = service.readSettings(); draft.dreamRunsPerDay = 2; await service.saveSettings(draft);
  assert.equal(service.readSettings().dreamRunsPerDay, 2);
  const empty = vault(), repository = new MobileMemoryRepository(empty.adapter, "another-ephemeral-shell", Date.now, store.unavailableReason);
  await assert.rejects(repository.snapshot(), /本机任务标识/u); assert.equal(empty.files.size, 0);
  const pending = ".echoink/shared-user/.runtime/mobile-transactions/txn_foreign";
  await f.adapter.mkdir(pending); await f.adapter.write(`${pending}/plan.json`, JSON.stringify({ schemaVersion: 1, owner: "stable-owner", entries: [] }));
  const withPending = [...f.files]; await service.initialize();
  await assert.rejects(service.list(), /事务/u); assert.deepEqual([...f.files], withPending);
});
await test("real v2 bytes are backed up, imported once, canonical cold reads preserve source and old state", async () => {
  const f = await fixture(), original = await seed(f); await f.service.initialize();
  const list = await f.service.list(); assert.equal(list.records.length, 1); assert.equal(list.records[0].source, oldMemory().source); assert.equal(list.records[0].revision, list.revision);
  assert.equal(f.files.get(".echoink/shared-user/.runtime/backups/mobile-v2-memory-fixture.json"), original); assert.equal(f.files.get(f.store.statePath), original);
  const canonical = f.files.get(".echoink/shared-user/.runtime/manifest.json"); const again = await fixture(undefined, f); await again.service.initialize();
  assert.equal((await again.service.list()).records.length, 1); assert.equal(f.files.get(".echoink/shared-user/.runtime/manifest.json"), canonical); assert.equal(f.calls(), 0);
});
await test("bad canonical state refuses import and preserves both raw sources", async () => {
  const f = await fixture(), original = await seed(f); f.files.set(".echoink/shared-user/.runtime/manifest.json", "broken-canonical");
  await assert.rejects(f.service.initialize(), /损坏/u); assert.equal(f.files.get(f.store.statePath), original); assert.equal(f.files.get(".echoink/shared-user/.runtime/manifest.json"), "broken-canonical");
});
await test("two services importing the same v2 snapshot coalesce through canonical mapping without duplicate revision", async () => {
  const f = await fixture(); await seed(f); const other = await fixture(undefined, f);
  await Promise.all([f.service.initialize(), other.service.initialize()]); const list = await f.service.list();
  assert.equal(list.records.length, 1); assert.equal(list.revision, 1); const mapping = JSON.parse(f.files.get(".echoink/shared-user/.runtime/mobile-memory-import-memory-fixture.json")); assert.equal(mapping.mapping.mem_old, "mem_old");
});
await test("closed Memory and no Provider still allow deterministic preview/correction/forget/restore/export", async () => {
  const f = await fixture(); await seed(f); await f.service.initialize(); await f.store.setMemoryEnabled(false);
  const list = await f.service.list(), count = f.files.size, before = [...f.files];
  const preview = await f.service.previewCorrection("mem_old", { title: "用户修正", content: "偏好具体例子", recallWhen: "回答时" }, list.revision);
  assert.deepEqual([...f.files], before); assert.equal(f.files.size, count);
  const saved = await f.service.applyCorrection(preview); assert.equal(saved.record.content, "偏好具体例子"); assert.equal(saved.record.supersedes, "mem_old"); assert.equal((await f.service.read("mem_old")).record.status, "superseded");
  const forgotten = await f.service.forget(saved.record.id, "用户主动忘记", saved.revision); assert.equal(forgotten.forgotten.length, 1);
  const restored = await f.service.restore(saved.record.id, forgotten.revision); assert.equal(restored.record.source, saved.record.source);
  const exported = await f.service.export(); assert.match(f.files.get(exported.path), /偏好具体例子/u); assert.equal(f.calls(), 0); assert.equal(f.store.memoryEnabled, false);
});
await test("stale preview and failed atomic install retain canonical bytes and permit explicit retry", async () => {
  const f = await fixture(); await seed(f); const before = await f.service.read("mem_old"), preview = await f.service.previewCorrection("mem_old", { title: "Mine", content: "Mine", recallWhen: "Mine" }, before.revision);
  await f.service.saveProfile("preference.language", "中文", before.revision); await assert.rejects(f.service.applyCorrection(preview), /已变化/u);
  const current = await f.service.read("mem_old"), next = await f.service.previewCorrection("mem_old", { title: "Retry", content: "Retry", recallWhen: "Retry" }, current.revision);
  const manifest = f.files.get(".echoink/shared-user/.runtime/manifest.json"); f.failInstall(); await assert.rejects(f.service.applyCorrection(next)); assert.equal(f.files.get(".echoink/shared-user/.runtime/manifest.json"), manifest);
  await f.service.applyCorrection(next); assert.equal(f.calls(), 0);
});
await test("unknown canonical metadata and live secondary index entries survive local updates", async () => {
  const f = await fixture(); await seed(f); let profile = await f.service.readProfile(); profile = await f.service.saveProfile("preference.language", "中文", profile.revision);
  const manifestPath = ".echoink/shared-user/.runtime/manifest.json", profilePath = ".echoink/shared-user/user-profile-state.json", indexPath = ".echoink/shared-user/.runtime/search-index.json";
  const manifest = JSON.parse(f.files.get(manifestPath)); manifest.future = { keep: true }; manifest.records[0].futureRecord = true; f.files.set(manifestPath, JSON.stringify(manifest));
  const rawProfile = JSON.parse(f.files.get(profilePath)); rawProfile.future = true; rawProfile.items[0].futureItem = true; f.files.set(profilePath, JSON.stringify(rawProfile));
  const record = (await f.service.read("mem_old")).record, file = `.echoink/${record.file}`; f.files.set(file, f.files.get(file).replace("\n---\n", '\nfuture_field: "preserve"\n---\n'));
  const index = JSON.parse(f.files.get(indexPath)); index.secondaryCatalog = [{ id: "secondary_test", parentId: "mem_old", title: "关联", content: "可能相关", recallWhen: "关联", matchTerms: ["相关"], relation: "associated", basis: "llm_inferred", routeTokens: [], contentTokens: [] }];
  index.secondaryIndex = [{ term: "相关", parentId: "mem_old", secondaryId: "secondary_test" }]; index.checksum = indexChecksum(index.revision, index.catalog, index.secondaryCatalog, index.secondaryIndex); f.files.set(indexPath, JSON.stringify(index));
  await f.service.export(); assert.equal(JSON.parse(f.files.get(indexPath)).secondaryCatalog.length, 1); assert.equal(JSON.parse(f.files.get(manifestPath)).future.keep, true); assert.equal(JSON.parse(f.files.get(profilePath)).items[0].futureItem, true);
  const current = await f.service.read("mem_old"), preview = await f.service.previewCorrection("mem_old", { title: "Changed", content: "Changed", recallWhen: "Changed" }, current.revision); await f.service.applyCorrection(preview);
  assert.match(f.files.get(file), /future_field: "preserve"/u); assert.equal(JSON.parse(f.files.get(indexPath)).secondaryCatalog.length, 0);
  const beforeForget = await f.service.read("mem_old"), forgotten = await f.service.forget("mem_old", "保留未知字段", beforeForget.revision);
  await f.service.restore("mem_old", forgotten.revision); assert.match(f.files.get(file), /future_field: "preserve"/u);
});
await test("custom legacy USER is permanently backed up and imported before profile/Dream replaces its projection", async () => {
  for (const action of ["profile", "dream"]) {
    const custom = "# 我自己的 USER\n\n保留所有原始换行与专属文字。\n", f = await fixture(async () => answer(JSON.stringify({ userProfileItems: [{ section: "preference", profileKey: "preference.tone", text: "清楚" }] })));
    f.files.set(".echoink/shared-user/USER.md", custom); await seed(f); await f.service.initialize(); assert.equal(f.files.get(".echoink/shared-user/USER.md"), custom);
    if (action === "profile") { const before = await f.service.readProfile(); await f.service.saveProfile("identity.name", "明确填写", before.revision); }
    else { model(f); await f.service.runDream(); }
    const backups = [...f.files].filter(([path]) => /backups\/legacy-user-[a-f0-9]+\.md$/u.test(path)); assert.equal(backups.length, 1); assert.equal(backups[0][1], custom);
    const records = (await f.service.list()).records; assert.ok(records.some(record => record.title === "迁移自 USER.md 的用户画像" && record.content === custom.trim() && record.basis === "explicit"));
    const cold = await fixture(undefined, f); await cold.service.initialize(); assert.equal(cold.files.get(backups[0][0]), custom);
  }
});
await test("a real interrupted multi-file transaction rolls back on cold reopening", async () => {
  const f = await fixture(); await seed(f); const before = await f.service.readProfile(), originalUser = f.files.get(".echoink/shared-user/USER.md"), originalManifest = f.files.get(".echoink/shared-user/.runtime/manifest.json");
  const rename = f.adapter.rename, write = f.adapter.write; let crashed = false;
  f.adapter.write = async (path, bytes) => { if (crashed) throw new Error("process-interrupted"); await write(path, bytes); };
  f.adapter.rename = async (from, to) => { if (crashed) throw new Error("process-interrupted"); await rename(from, to); if (from.endsWith(".tmp") && to === ".echoink/shared-user/USER.md") { crashed = true; throw new Error("process-interrupted"); } };
  await assert.rejects(f.service.saveProfile("identity.name", "不得半写", before.revision));
  assert.ok([...f.files.keys()].some(path => path.endsWith("/plan.json")));
  f.adapter.rename = rename; f.adapter.write = write;
  const cold = await fixture(undefined, f); await cold.service.initialize(); assert.equal(f.files.get(".echoink/shared-user/USER.md"), originalUser); assert.equal(f.files.get(".echoink/shared-user/.runtime/manifest.json"), originalManifest);
  assert.equal((await cold.service.readProfile()).items.length, 0); assert.ok(![...f.files.keys()].some(path => path.endsWith("/plan.json")));
});
await test("24 slots/three groups, explicit source confirmation, delete preserves source and blocks old evidence", async () => {
  const f = await fixture(); await f.service.initialize(); assert.equal(USER_PROFILE_SLOTS.length, 24); assert.deepEqual([...new Set(USER_PROFILE_SLOTS.map(slot => slot.section))].sort(), ["collaboration", "identity", "preference"]);
  let profile = await f.service.readProfile(); profile = await f.service.saveProfile("preference.tone", "直接清楚", profile.revision);
  assert.equal(profile.items[0].basis, "explicit_memory"); const source = profile.sources[0].id; const record = (await f.service.read(source)).record;
  profile = await f.service.confirmProfile("preference.tone", profile.revision); profile = await f.service.deleteProfile("preference.tone", profile.revision); assert.equal(profile.items.length, 0); assert.equal((await f.service.read(source)).record.content, record.content);
  const snapshot = await f.service.repository.snapshot(), blocked = applyDreamProfileUpdate(snapshot.profile, { items: [{ section: "preference", profileKey: "preference.tone", text: "直接清楚", basis: "explicit_memory", sourceMemoryId: source, sourceEvidence: { kind: "memory", revision: record.revision } }], processedSources: [], now: 1 });
  assert.equal(blocked.items.length, 0); assert.equal(f.calls(), 0);
});
await test("canonical tool write persists M4 intent/readback, old array stays unchanged, cold recovery sees same repository", async () => {
  const f = await fixture(); const original = await seed(f); await f.service.initialize(); const taskId = f.store.session.id;
  await f.store.updateSession(taskId, task => { task.runs = [{ id: "tool-run", status: "running", startedAt: 1 }]; });
  const app = { vault: { adapter: f.adapter, getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: {}, workspace: {} };
  const policy = new MobileCapabilityPolicy({ store: f.store, settings: () => f.settings, agentId: "sol" });
  const tools = mobileTools(app, f.store, () => "", () => null, undefined, taskId, policy, { runId: "tool-run" }, f.service), write = tools.find(tool => tool.name === "memory_write");
  const result = await write.execute("canonical-call", { kind: "fact", title: "新记忆", content: "新的真实记忆", recallWhen: "以后", basis: "explicit" }, new AbortController().signal);
  const record = result.details, operation = f.store.getSession(taskId).operations[0]; assert.equal(operation.status, "completed"); assert.equal(operation.memoryRepository, "canonical"); assert.equal(operation.completedRevision, record.revision);
  assert.equal(f.store.state.memories.length, 1); assert.equal(JSON.parse(original).memories.length, 1); assert.equal((await f.service.list()).records.length, 2);
  const restarted = await fixture(undefined, f); await restarted.service.initialize(); const resume = await inspectMobileTaskResume(app, restarted.store, taskId); assert.equal(resume.issues.length, 0);
  await assert.rejects(write.execute("second-call", { kind: "fact", title: "新记忆", content: "新的真实记忆", recallWhen: "以后", basis: "explicit" }, new AbortController().signal), /不能重复/u);
});
await test("canonical Memory completion receipt failure survives cold Store and exact readback reconciles once", async () => {
  const f = await fixture(); await seed(f); await f.service.initialize(); const taskId = f.store.session.id;
  await f.store.updateSession(taskId, task => { task.runs = [{ id: "receipt-run", status: "running", startedAt: 1 }]; });
  const updateSession = f.store.updateSession.bind(f.store); let failed = false;
  f.store.updateSession = (id, change) => updateSession(id, task => { change(task); if (!failed && task.operations?.at(-1)?.status === "completed") { failed = true; throw new Error("receipt-save-failed"); } });
  const app = { vault: { adapter: f.adapter, getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: {}, workspace: {} }, policy = new MobileCapabilityPolicy({ store: f.store, settings: () => f.settings, agentId: "sol" });
  const write = mobileTools(app, f.store, () => "", () => null, undefined, taskId, policy, { runId: "receipt-run" }, f.service).find(tool => tool.name === "memory_write");
  await assert.rejects(write.execute("receipt-call", { kind: "fact", title: "Durable", content: "写入已发生", recallWhen: "核对", basis: "explicit" }, new AbortController().signal), /receipt-save/u);
  assert.equal(f.store.getSession(taskId).operations[0].status, "uncertain"); const cold = await fixture(undefined, f); await cold.service.initialize();
  const snapshot = await inspectMobileTaskResume(app, cold.store, taskId); assert.equal(snapshot.issues.length, 0); assert.equal(cold.store.getSession(taskId).operations[0].status, "completed"); assert.equal((await cold.service.list()).records.length, 2);
});
await test("Dream only sends user-profile prompt, commits canonical state, counts daily attempt before inference", async () => {
  const bodies = [], f = await fixture(async input => { bodies.push(JSON.parse(input.body)); return answer(JSON.stringify({ userProfileItems: [{ section: "preference", profileKey: "preference.detail", text: "喜欢简洁答复" }] })); });
  await seed(f); model(f); await f.service.initialize(); const status = await f.service.runDream(); assert.equal(status.phase, "completed"); assert.equal(status.attemptsToday, 1); assert.equal(f.calls(), 1);
  assert.equal((await f.service.readProfile()).items[0].text, "喜欢简洁答复"); assert.ok(![...f.files.keys()].some(path => path.includes("AGENT.md") || path.includes("agent-self")));
  assert.equal(f.settings.memory.dreamRunsPerDay, 6); assert.equal(f.service.readSettings().dreamRunsPerDay, 1);
  const current = await f.service.readProfile(); await f.service.saveProfile("preference.language", "中文", current.revision);
  await assert.rejects(f.service.runDream(), /次数/u); assert.equal(f.calls(), 1); assert.ok(JSON.stringify(bodies).includes("userProfileItems"));
});
await test("Dream cancellation/background rejects late result and cold startup marks running interrupted without inference", async () => {
  const pending = deferred(), f = await fixture(() => pending.promise); await seed(f); model(f); await f.service.initialize(); const before = f.files.get(".echoink/shared-user/USER.md");
  const running = f.service.runDream(); while (!f.calls()) await turn(); await f.service.cancelDream(); assert.equal((await running).phase, "interrupted");
  pending.resolve(answer(JSON.stringify({ userProfileItems: [{ section: "identity", profileKey: "identity.name", text: "晚到值" }] }))); await turn(); assert.equal(f.files.get(".echoink/shared-user/USER.md"), before);
  const ledgerPath = ".echoink/shared-user/.runtime/mobile-dream-ledger.json", ledger = JSON.parse(f.files.get(ledgerPath)); ledger.status.phase = "running"; f.files.set(ledgerPath, JSON.stringify(ledger));
  const cold = await fixture(undefined, f); await cold.service.initialize(); assert.equal(cold.service.dreamStatus().phase, "interrupted"); assert.equal(cold.calls(), 0);
});
await test("observed Dream evidence needs independent source groups rather than two records from one task", async () => {
  const output = JSON.stringify({ userProfileItems: [{ section: "preference", profileKey: "preference.tone", text: "偏好清楚" }] }), f = await fixture(async () => answer(output));
  await seed(f, ["mem_a", "mem_b"].map(id => ({ ...oldMemory(id), kind: "view", basis: "observed", source: `pi://vault/conversation/session/${id}?productRun=same-task` }))); model(f); await f.service.runDream();
  assert.equal((await f.service.readProfile()).items.length, 0); const current = await f.service.repository.snapshot();
  await f.service.repository.mutate(current.manifest.revision, "test-new-source", (draft, files) => { const record = f.service.repository.newRecord({ kind: "view", title: "不同任务", content: "偏好清楚", recallWhen: "表达", basis: "observed", source: "pi://vault/conversation/session/third?productRun=another-task", revision: draft.manifest.revision + 1 }); draft.records.push(record); files.set(record.file, module.exports.serializeCanonicalMemoryRecord(record)); });
  f.setNow(new Date("2026-10-20T12:00:00Z").getTime()); await f.service.runDream(); const profile = await f.service.readProfile(); assert.equal(profile.items.length, 1); assert.equal(profile.items[0].basis, "observed_memory"); assert.equal(profile.items[0].sourceMemoryIds.length, 2);
});
await test("cancellation at a canonical file boundary rolls back the Dream transaction", async () => {
  const f = await fixture(async () => answer(JSON.stringify({ userProfileItems: [{ section: "identity", profileKey: "identity.name", text: "不应发布" }] }))); await seed(f); model(f); await f.service.initialize();
  const before = f.files.get(".echoink/shared-user/USER.md"), controller = new AbortController(), rename = f.adapter.rename;
  f.adapter.rename = async (from, to) => { await rename(from, to); if (from.endsWith(".tmp") && to === ".echoink/shared-user/USER.md") controller.abort(); };
  const status = await f.service.runDream(controller.signal); assert.equal(status.phase, "interrupted"); assert.equal(f.files.get(".echoink/shared-user/USER.md"), before); assert.equal((await f.service.readProfile()).items.length, 0);
});
await test("abort inside the final manifest readback is checked before publishing committed", async () => {
  const f = await fixture(async () => answer(JSON.stringify({ userProfileItems: [{ section: "identity", profileKey: "identity.name", text: "最后窗口不能提交" }] }))); await seed(f); model(f); await f.service.initialize();
  const manifestPath = ".echoink/shared-user/.runtime/manifest.json", original = f.files.get(manifestPath), user = f.files.get(".echoink/shared-user/USER.md"), read = f.adapter.read, controller = new AbortController(); let fired = false;
  f.adapter.read = async path => { const bytes = await read(path); if (!fired && path === manifestPath && bytes !== original) { fired = true; controller.abort(); } return bytes; };
  const status = await f.service.runDream(controller.signal); assert.equal(fired, true); assert.equal(status.phase, "interrupted"); assert.equal(f.files.get(manifestPath), original); assert.equal(f.files.get(".echoink/shared-user/USER.md"), user);
});
await test("automatic archive is completed+seven days only, protects drafts/queue/waiting/running and never changes page", async () => {
  const f = await fixture(), at = new Date("2026-10-19T12:00:00Z").getTime(), old = at - 8 * 86_400_000;
  await f.store.update(state => { const base = state.sessions[0]; state.sessions = [
    { ...base, id: "eligible", updatedAt: old, taskStatus: "completed", taskCompletedAt: old },
    { ...base, id: "draft", updatedAt: old, taskStatus: "completed", taskCompletedAt: old, draft: "keep" },
    { ...base, id: "running", updatedAt: old, taskStatus: "running" },
    { ...base, id: "boundary", updatedAt: at - 7 * 86_400_000 + 1, taskStatus: "completed", taskCompletedAt: at - 7 * 86_400_000 + 1 }
  ]; state.activeSessionId = "draft"; state.page = { kind: "detail", taskId: "draft" }; });
  const before = plain(f.store.state.page), settings = f.service.readSettings(); settings.autoArchive = true; await f.service.saveSettings(settings);
  assert.deepEqual((await f.service.listArchives()).map(task => task.id), ["eligible"]); assert.deepEqual(plain(f.store.state.page), before);
  await f.service.restoreArchive("eligible"); assert.equal(f.store.getSession("eligible").agentId, "sol"); assert.equal(f.store.getSession("eligible").archivedAt, undefined); assert.deepEqual(plain(f.store.state.page), before); assert.equal(f.calls(), 0);
});
const crossEndRoot = process.env.ECHOINK_MOBILE_MEMORY_TEST_ROOT;
if (crossEndRoot) {
  const registered = path.resolve(process.env.HOME, "EchoInk-TestVaults/90-任务临时/移动端改版-M9-20261019"), requested = path.resolve(crossEndRoot);
  assert.ok(requested.startsWith(`${registered}${path.sep}`), "Cross-end fixtures must stay inside the registered M9 disposable root");
  await fs.mkdir(requested, { recursive: true });
  assert.ok((await fs.realpath(requested)).startsWith(`${await fs.realpath(registered)}${path.sep}`), "Cross-end fixture root must not escape through a symlink");
  const desktopBuild = await esbuild.build({ entryPoints: ["src/harness/memory/personal-memory-repository.ts"], bundle: true, write: false, format: "cjs", platform: "node", target: "node20", external: ["obsidian"], loader: { ".md": "text" }, logLevel: "silent" });
  const desktopModule = { exports: {} }, require = createRequire(import.meta.url);
  new Function("require", "module", "exports", desktopBuild.outputFiles[0].text)(require, desktopModule, desktopModule.exports);
  const { PersonalMemoryRepository } = desktopModule.exports;
  const managed = ".echoink/shared-user", userPath = `${managed}/USER.md`, journalPath = `${managed}/.runtime/mobile-transactions`;
  async function diskFixture(run) {
    const directory = await fs.mkdtemp(path.join(requested, "memory-cross-end-")), repositories = [];
    const resolve = relative => { const target = path.resolve(directory, relative); assert.ok(target.startsWith(`${directory}${path.sep}`)); return target; };
    const exists = async relative => { try { await fs.access(resolve(relative)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
    const adapter = {
      exists, read: relative => fs.readFile(resolve(relative), "utf8"), write: (relative, bytes) => fs.writeFile(resolve(relative), bytes),
      mkdir: relative => fs.mkdir(resolve(relative), { recursive: true }), remove: relative => fs.unlink(resolve(relative)),
      rename: async (from, to) => { if (await exists(to)) throw new Error("rename conflict"); await fs.rename(resolve(from), resolve(to)); },
      list: async relative => { const entries = await fs.readdir(resolve(relative), { withFileTypes: true }); return {
        files: entries.filter(entry => entry.isFile()).map(entry => `${relative}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${relative}/${entry.name}`)
      }; }, rmdir: (relative, recursive) => fs.rm(resolve(relative), { recursive, force: false })
    };
    const before = await fixture(); await seed(before); await before.service.initialize();
    for (const [relative, bytes] of before.files) { await fs.mkdir(path.dirname(resolve(relative)), { recursive: true }); await fs.writeFile(resolve(relative), bytes); }
    const vaultId = JSON.parse(await adapter.read(`${managed}/.runtime/manifest.json`)).vaultId;
    const desktop = options => { const repository = new PersonalMemoryRepository({ vaultPath: directory, vaultId, watchExternalChanges: false, ...options }); repositories.push(repository); return repository; };
    const snapshot = async () => {
      const files = [];
      async function walk(relative) { for (const entry of (await fs.readdir(resolve(relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${relative}/${entry.name}`; if (entry.isDirectory()) await walk(child); else files.push([child, await adapter.read(child)]);
      } }
      await walk(managed); return files;
    };
    try { await run({ adapter, mobile: await fixture(undefined, { adapter }), desktop, snapshot }); }
    finally { for (const repository of repositories) await repository.dispose(); await fs.rm(directory, { recursive: true }); }
  }
  await test("filesystem: Node desktop opens mobile canonical records and mobile reads desktop initialization", async () => {
    await diskFixture(async f => {
      const desktop = f.desktop(), inspection = await desktop.inspect(); assert.equal(inspection.records.length, 1); assert.equal(inspection.records[0].source, oldMemory().source);
      const mobile = await f.mobile.service.list(); assert.equal(mobile.records.length, 1); assert.equal(mobile.revision, inspection.revision);
    });
  });
  await test("filesystem: interrupted mobile journal blocks cached/cold desktop and preserves later foreign bytes", async () => {
    await diskFixture(async f => {
      const desktop = f.desktop(); await desktop.inspect(); const before = await f.mobile.service.readProfile(), rename = f.adapter.rename, write = f.adapter.write; let crashed = false;
      f.adapter.write = async (relative, bytes) => { if (crashed) throw new Error("process-interrupted"); await write(relative, bytes); };
      f.adapter.rename = async (from, to) => { if (crashed) throw new Error("process-interrupted"); await rename(from, to); if (from.endsWith(".tmp") && to === userPath) { crashed = true; throw new Error("process-interrupted"); } };
      await assert.rejects(f.mobile.service.saveProfile("identity.name", "半写画像", before.revision)); f.adapter.rename = rename; f.adapter.write = write;
      assert.equal((await f.adapter.list(journalPath)).folders.length, 1); await write(userPath, "# 后来的真实外改\n必须保留。\n");
      const protectedBytes = await f.snapshot(); await assert.rejects(desktop.inspect(), /Mobile Memory transaction/u); await assert.rejects(f.desktop().initialize(), /Mobile Memory transaction/u);
      const cold = await fixture(undefined, { adapter: f.adapter }); await assert.rejects(cold.service.initialize(), /其他修改/u); assert.deepEqual(await f.snapshot(), protectedBytes);
    });
  });
  await test("filesystem: legacy shared mobile journals never enter desktop rollback or deletion", async () => {
    for (const shape of ["missing-plan", "before-owner", "with-owner"]) await diskFixture(async f => {
      const desktop = f.desktop(); await desktop.inspect(); const relative = `${managed}/.runtime/transactions/txn_mobile_${shape}`;
      await f.adapter.mkdir(`${relative}/backup`); await f.adapter.write(`${relative}/state`, "applying\n"); await f.adapter.write(`${relative}/backup/0.bak`, "older bytes");
      if (shape !== "missing-plan") await f.adapter.write(`${relative}/plan.json`, JSON.stringify({ schemaVersion: 1, transactionId: `txn_mobile_${shape}`, ...(shape === "with-owner" ? { owner: "old-mobile" } : {}), entries: [{ relativePath: "shared-user/USER.md", existed: true, backupFile: "backup/0.bak" }] }));
      await f.adapter.write(userPath, "# 外改不能被旧 journal 回滚\n"); const protectedBytes = await f.snapshot();
      await assert.rejects(desktop.inspect(), /Legacy Mobile/u); await assert.rejects(f.desktop().initialize(), /Legacy Mobile/u); await assert.rejects(f.mobile.service.repository.snapshot(), /旧版移动记忆事务/u);
      assert.deepEqual(await f.snapshot(), protectedBytes);
    });
  });
  await test("filesystem: mobile refuses pending desktop data until the real desktop owner recovers", async () => {
    await diskFixture(async f => {
      let crash = false; const desktop = f.desktop({ failTransactionAfterChange: () => crash }), before = await desktop.inspect(); crash = true;
      await assert.rejects(desktop.saveUserProfileFromUserControl({ profileKey: "identity.name", text: "桌面未完成", expectedRevision: before.revision }), /simulated_crash/u);
      assert.equal((await f.adapter.list(`${managed}/.runtime/transactions`)).folders.length, 1); const protectedBytes = await f.snapshot();
      await assert.rejects(f.mobile.service.repository.snapshot(), /桌面或旧版移动记忆事务/u); assert.deepEqual(await f.snapshot(), protectedBytes);
      const recovered = await f.desktop().inspect(); assert.equal((await f.mobile.service.list()).revision, recovered.revision); assert.equal((await f.adapter.list(`${managed}/.runtime/transactions`)).folders.length, 0);
    });
  });
}
console.log(`OK ${passed} mobile Memory settings tests; real Store/serializer/transactions${crossEndRoot ? " and Node desktop/filesystem cross-end checks" : ", memory-only Vault adapter; filesystem checks not requested"}; external model unverified`);
