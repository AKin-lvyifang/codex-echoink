import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import moment from "moment";
import { parse as parseYaml } from "yaml";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, FixtureTFile, answer } from "../tests/mobile/host.mjs";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile/workbench-entry.ts"), metafile: true });
for (const file of Object.keys(build.metafile.inputs)) assert.ok(!["src/home/workbench-data.ts", "src/home/workbench-records.ts", "src/home/task-launcher.ts", "src/knowledge-base/raw-digest.ts", "src/settings/settings.ts"].includes(file), `desktop import: ${file}`);
const module = { exports: {} };
class FixtureFolder { constructor(path) { this.path = path; this.name = path.split("/").pop(); this.children = []; } }
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder,
  AbortController, URL, setTimeout, clearTimeout, console, require(id) {
    assert.equal(id, "obsidian"); return { TFile: FixtureTFile, TFolder: FixtureFolder, moment, parseYaml, Notice: class {} };
  } }, { filename: "mobile-workbench-browser.cjs" });
const { MobileWorkbenchService, MobileRuntime, MobileStore, loadMobileSettings, mobileProvider, mobileModel, parseTodoMarkdown,
  localWorkbenchDate, workbenchWeekKey, emptyKnowledgeFolderBindings, EMPTY_LIFESTYLE_DATA, parseMobileWorkbenchSource, sha256Hex } = module.exports;
let passed = 0;
const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
const keyDate = localWorkbenchDate(Date.now());
const oldDate = new Date(); oldDate.setDate(oldDate.getDate() - 6);
const todoText = (title = "到期待办") => `- [ ] ${title}\n  - 截止日期: ${localWorkbenchDate(oldDate)}\n`;
const make = async (seed = {}, raw = {}, providerRequest) => {
  const host = createHost(seed); let scans = 0, reads = 0, requests = 0;
  const files = host.app.vault.getFiles.bind(host.app.vault), abstract = host.app.vault.getAbstractFileByPath.bind(host.app.vault);
  host.app.vault.getFiles = () => { scans++; return files(); };
  host.app.vault.getAbstractFileByPath = path => host.folders.has(path) ? new FixtureFolder(path) : abstract(path);
  host.app.vault.readBinary = async file => { reads++; return new TextEncoder().encode(await host.adapter.read(file.path)).buffer; };
  const provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "fake-fixture", baseUrl: "https://fixture.example/v1", models: [mobileModel("fixture-model")], defaultModelId: "fixture-model" });
  const settings = loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model", ...raw });
  const store = new MobileStore(host.adapter, "plugin/mobile", "workbench-fixture"); await store.load();
  const runtime = new MobileRuntime(host.app, store, () => settings, async request => { requests++; return providerRequest ? providerRequest(request) : answer("openai-completions", "完成"); });
  await runtime.initialize();
  const noSubscription = () => () => {};
  const financeListeners = new Set();
  const todo = { subscribe: noSubscription, async readOnlySnapshot() {
    const text = await host.adapter.exists("EchoInk/待办.md") ? await host.adapter.read("EchoInk/待办.md") : null;
    return { records: text === null ? [] : parseTodoMarkdown(text).records, sourcePath: "EchoInk/待办.md", contentVersion: text === null ? null : sha256Hex(text) };
  } };
  const services = { directory: "plugin/mobile", preferencesPath: "plugin/pi-agent-product-v1/knowledge/preferences.md", getTodoStore: () => todo,
    knowledgePath: role => role, async readMaintenanceRecord() { throw new Error("fixture record missing"); },
    lifestyle: { store: { subscribe: noSubscription, async readFresh() { return structuredClone(EMPTY_LIFESTYLE_DATA); } },
      finance: { subscribeEntries(listener) { financeListeners.add(listener); return () => financeListeners.delete(listener); },
        ledger: { entries() { return []; }, async readSnapshots() { return []; }, issues() { return []; } } } } };
  const workbench = new MobileWorkbenchService(host.app, store, () => settings, () => services, runtime);
  return { ...host, settings, store, runtime, services, workbench, emitFinance() { for (const listener of financeListeners) listener(); },
    counts: () => ({ scans, reads, requests }), close() { workbench.dispose(); runtime.dispose(); } };
};
const reject = async (action, pattern) => { await assert.rejects(action, pattern); };
const renameFixture = (f, from, to, directory = false) => {
  const entries = [...f.files].filter(([path]) => path === from || path.startsWith(`${from}/`));
  for (const [path] of entries) f.files.delete(path);
  for (const [path, text] of entries) f.files.set(to + path.slice(from.length), text);
  if (directory) { f.folders.delete(from); f.folders.add(to); }
  f.app.vault.trigger("rename", directory ? new FixtureFolder(to) : f.app.vault.getAbstractFileByPath(to), from);
};

await test("unconfigured or not-yet-observed facts are silent unknowns, not persistent errors", async () => {
  const f = await make({}, { englishDiary: { enabled: true } });
  f.services.accountService = { checkCapability: () => true, subscribe: () => () => {} };
  const facts = await f.workbench.readFacts();
  assert.equal(facts.englishMissing, null); assert.equal(facts.reviewComplete, null); assert.equal(facts.isolated, null);
  assert.equal((await f.workbench.load()).issues.length, 0);
  f.app.workspace.layoutReady = false; f.workbench.invalidate();
  const waiting = await f.workbench.readFacts(); assert.equal(waiting.todos, null); assert.equal(waiting.issues.length, 0); f.close();
});
await test("unknown source failures stay null and never create English/review/link or due reminders", async () => {
  const f = await make({}, { englishDiary: { enabled: true } });
  f.services.accountService = { checkCapability: () => true, subscribe: () => () => {} };
  f.services.getTodoStore().readOnlySnapshot = async () => { throw new Error("TODO_UNAVAILABLE"); };
  const facts = await f.workbench.readFacts();
  assert.equal(facts.todos, null); assert.equal(facts.englishMissing, null); assert.equal(facts.reviewComplete, null); assert.equal(facts.isolated, null);
  const snapshot = await f.workbench.load();
  assert.ok(snapshot.issues.some(issue => issue.includes("TODO_UNAVAILABLE")));
  assert.ok(!snapshot.signals.some(signal => [1, 2, 5, 9, 14, 8].includes(signal.id))); f.close();
});
await test("handoff is only an unsent Agent-list draft; conflict preserves draft, note context and tasks", async () => {
  const f = await make({ "EchoInk/待办.md": todoText() });
  const snapshot = await f.workbench.load(), signal = snapshot.signals.find(item => item.id === 1);
  assert.ok(signal, JSON.stringify(snapshot)); const ids = f.store.state.sessions.map(task => task.id);
  await f.store.update(latest => { latest.newTaskDrafts.sol = { text: "已有的不同草稿", attachments: [], noteMentions: [{ vaultRelativePath: "旧.md", fileName: "旧" }], selectedPermission: "read-only" }; });
  const before = JSON.stringify(f.store.state.newTaskDrafts.sol), page = JSON.stringify(f.store.state.page);
  assert.equal((await f.workbench.handoff(signal)).conflict, true);
  assert.equal(JSON.stringify(f.store.state.newTaskDrafts.sol), before); assert.equal(JSON.stringify(f.store.state.page), page);
  assert.equal((await f.workbench.handoff(signal, true)).conflict, false);
  const draft = f.store.state.newTaskDrafts.sol;
  assert.equal(draft.text, signal.prompt); assert.equal(draft.selectedPermission, "read-only"); assert.equal(draft.noteMentions, undefined);
  assert.equal(f.store.state.page.kind, "list"); assert.equal(f.store.state.page.agentId, "sol");
  assert.deepEqual(f.store.state.sessions.map(task => task.id), ids); assert.equal(f.counts().requests, 0);
  assert.ok((await f.workbench.load()).signals.some(item => item.key === signal.key)); f.close();
});
await test("click rechecks source bytes without needing a file event and rejects a now-stale row", async () => {
  const f = await make({ "EchoInk/待办.md": todoText() }); const signal = (await f.workbench.load()).signals.find(item => item.id === 1);
  assert.ok(signal); f.files.set("EchoInk/待办.md", todoText("内容已修改，日期不变"));
  await reject(f.workbench.handoff(signal), /提醒已更新/u); assert.equal(f.store.state.newTaskDrafts.sol, undefined); assert.equal(f.counts().requests, 0); f.close();
});
await test("real accepted candidate writes businessKey atomically; prefill remains visible until admission", async () => {
  let release; const response = new Promise(resolve => { release = resolve; });
  const f = await make({ "EchoInk/待办.md": todoText() }, {}, () => response);
  const signal = (await f.workbench.load()).signals.find(item => item.id === 1); assert.ok(signal);
  await f.workbench.handoff(signal); assert.ok((await f.workbench.load()).signals.some(item => item.key === signal.key));
  const sent = await f.runtime.sendNew("sol", f.store.state.newTaskDrafts.sol.text);
  assert.equal(f.store.getSession(sent.taskId).businessKey, signal.key); assert.equal(f.store.getSession(sent.taskId).taskStatus, "running");
  assert.ok(!(await f.workbench.load()).signals.some(item => item.key === signal.key));
  const reopened = new MobileStore(f.adapter, "plugin/mobile", "workbench-fixture"); await reopened.load(); assert.equal(reopened.getSession(sent.taskId).businessKey, signal.key);
  release(answer("openai-completions", "完成")); await sent.completion;
  assert.ok((await f.workbench.load()).signals.some(item => item.key === signal.key)); f.close();
});
await test("invalid/edited provenance never attributes an unrelated task and no provider leaves draft intact", async () => {
  const f = await make({ "EchoInk/待办.md": todoText() });
  const signal = (await f.workbench.load()).signals.find(item => item.id === 1); assert.ok(signal);
  assert.equal(parseMobileWorkbenchSource(JSON.stringify({ ...signal.source, businessKey: "workbench:finance:due:bad" })), null);
  assert.equal(parseMobileWorkbenchSource(JSON.stringify({ ...signal.source, signalId: 8 })), null);
  await f.workbench.handoff(signal); f.settings.apiProviders = [];
  await reject(f.runtime.sendNew("sol", signal.prompt), /提供商/u);
  assert.equal(f.store.state.newTaskDrafts.sol.text, signal.prompt); assert.equal(f.store.state.sessions.length, 1); assert.equal(f.counts().requests, 0); f.close();
  const edited = await make({ "EchoInk/待办.md": todoText() });
  const row = (await edited.workbench.load()).signals.find(item => item.id === 1); await edited.workbench.handoff(row);
  const sent = await edited.runtime.sendNew("sol", "完全不同的事情"); await sent.completion;
  assert.equal(edited.store.getSession(sent.taskId).businessKey, undefined); edited.close();
});
await test("streaming changes notify task projection without rescanning the Vault", async () => {
  const f = await make({ "EchoInk/待办.md": todoText(), "raw/资料.md": "原始资料" }); await f.workbench.load();
  const before = f.counts();
  for (let index = 0; index < 20; index++) { await f.store.updateSession(f.store.session.id, task => { task.draft = String(index); }); f.runtime.onChange(); await f.workbench.load(); }
  assert.equal(f.counts().scans, before.scans); assert.equal(f.counts().reads, before.reads); f.close();
});
await test("Inbox baseline is durable, only new entries signal and source versions reject stale click", async () => {
  const f = await make({ "inbox/已有.md": "已有" }); assert.ok(!(await f.workbench.load()).signals.some(item => item.id === 6));
  for (let index = 0; index < 3; index++) await f.app.vault.create(`inbox/新${index}.md`, `新内容${index}`);
  let snapshot = await f.workbench.load(), signal = snapshot.signals.find(item => item.id === 6); assert.ok(signal);
  assert.equal(signal.source.objects.length, 3); assert.ok(!signal.source.objects.includes("inbox/已有.md"));
  f.workbench.dispose(); f.workbench = new MobileWorkbenchService(f.app, f.store, () => f.settings, () => f.services, f.runtime);
  snapshot = await f.workbench.load(); assert.equal(snapshot.signals.find(item => item.id === 6).source.objects.length, 3);
  f.files.set("inbox/新0.md", "更新的版本"); await reject(f.workbench.handoff(signal), /提醒已更新/u); f.close();
});
await test("renaming three baseline Inbox files preserves their existing observation instead of reporting arrivals", async () => {
  const f = await make(Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`inbox/原${index}.md`, `已有${index}`])));
  assert.equal((await f.workbench.readFacts()).inbox.length, 0);
  for (let index = 0; index < 3; index++) renameFixture(f, `inbox/原${index}.md`, `inbox/改名${index}.md`);
  assert.equal((await f.workbench.readFacts()).inbox.length, 0);
  assert.ok(!(await f.workbench.load()).signals.some(item => item.id === 6));
  f.workbench.dispose(); f.workbench = new MobileWorkbenchService(f.app, f.store, () => f.settings, () => f.services, f.runtime);
  assert.equal((await f.workbench.readFacts()).inbox.length, 0); f.close();
});
await test("Inbox directory/subtree rename chains preserve baseline and genuine original arrival timestamps", async () => {
  const f = await make({ "inbox/旧/0.md": "已有0", "inbox/旧/嵌套/1.md": "已有1", "inbox/旧/嵌套/2.md": "已有2" });
  await f.workbench.load(); renameFixture(f, "inbox/旧", "inbox/中间", true); renameFixture(f, "inbox/中间", "inbox/最终", true);
  assert.equal((await f.workbench.readFacts()).inbox.length, 0);
  for (let index = 0; index < 3; index++) await f.app.vault.create(`inbox/新增/${index}.md`, `新增${index}`);
  const before = (await f.workbench.readFacts()).inbox;
  renameFixture(f, "inbox/新增", "inbox/新增改名", true);
  const after = (await f.workbench.readFacts()).inbox;
  assert.equal(after.length, 3);
  for (const file of before) assert.equal(after.find(item => item.path === file.path.replace("inbox/新增/", "inbox/新增改名/")).enteredAt, file.enteredAt);
  f.close();
});
await test("moving outside files or a directory into Inbox creates genuine arrivals", async () => {
  for (const directory of [false, true]) {
    const f = await make(Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`outside/来源/${index}.md`, `外部${index}`])));
    await f.workbench.load();
    if (directory) renameFixture(f, "outside/来源", "inbox/移入", true);
    else for (let index = 0; index < 3; index++) renameFixture(f, `outside/来源/${index}.md`, `inbox/移入${index}.md`);
    const signal = (await f.workbench.load()).signals.find(item => item.id === 6);
    assert.ok(signal); assert.equal(signal.source.objects.length, 3); assert.equal((await f.workbench.readFacts()).inbox.length, 3); f.close();
  }
});
await test("real financial eligibility and ledger facts drive budget, classification and import-gap signals", async () => {
  const f = await make({}, { lifestyle: { finance: { enabled: true } } });
  const now = Date.now(), data = structuredClone(EMPTY_LIFESTYLE_DATA), month = keyDate.slice(0, 7);
  data.budgets = [{ month, totalCents: 1000, allocations: { 餐饮: 1000 } }]; data.lastSuccessfulImportAt = now - 31 * 86400000;
  f.services.lifestyle.store.readFresh = async () => data;
  f.services.lifestyle.finance.ledger.readSnapshots = async () => [{ entry: { id: "bill", source: "manual", sourceId: "", date: keyDate, merchant: "午餐", category: "餐饮", kind: "expense", amountCents: 900, status: "completed", account: "", description: "", currency: "CNY", note: "", classificationPending: true } }];
  assert.ok(!(await f.workbench.load()).signals.some(item => [3, 11, 13].includes(item.id)));
  f.services.accountService = { checkCapability: () => true, subscribe: () => () => {} };
  const ids = (await f.workbench.load()).signals.map(item => item.id); for (const id of [3, 11, 13]) assert.ok(ids.includes(id), String(id)); f.close();
});
await test("ledger snapshot-read emissions do not loop; only changed entries or issues reload workbench facts", async () => {
  const f = await make({}, { lifestyle: { finance: { enabled: true } } });
  f.services.accountService = { checkCapability: () => true, subscribe: () => () => {} };
  let entries = [], issues = [], reads = 0, notifications = 0;
  const reloads = [];
  const ledger = f.services.lifestyle.finance.ledger;
  ledger.entries = () => structuredClone(entries);
  ledger.issues = () => structuredClone(issues);
  ledger.readSnapshots = async () => {
    reads++; f.emitFinance(); // Actual readDirect emits after every read, including unchanged data.
    return entries.map(entry => ({ entry: structuredClone(entry) }));
  };
  const unsubscribe = f.workbench.subscribe(() => {
    notifications++;
    // Bound a regression so an accidental feedback loop fails without hanging the process.
    if (notifications <= 4) reloads.push(f.workbench.load());
  });
  await f.workbench.load(); await Promise.all(reloads);
  assert.equal(reads, 1); assert.equal(notifications, 0);
  for (let index = 0; index < 3; index++) { f.emitFinance(); await f.workbench.load(); }
  assert.equal(reads, 1); assert.equal(notifications, 0);
  entries = [{ id: "changed-bill", source: "manual", sourceId: "", date: keyDate, merchant: "真实新增", category: "餐饮", kind: "expense", amountCents: 900, status: "completed", account: "", description: "", currency: "CNY", note: "", classificationPending: true }];
  f.emitFinance(); await Promise.all(reloads);
  assert.equal(notifications, 1); assert.equal(reads, 2);
  assert.ok((await f.workbench.load()).signals.some(signal => signal.id === 11));
  f.emitFinance(); await f.workbench.load(); assert.equal(notifications, 1); assert.equal(reads, 2);
  issues = [{ path: "账本/损坏.md", reason: "真实读取错误" }];
  f.emitFinance(); await Promise.all(reloads);
  assert.equal(notifications, 2); assert.equal(reads, 3);
  assert.ok((await f.workbench.load()).issues.some(issue => issue.includes("真实读取错误")));
  unsubscribe(); f.close();
});
await test("journal missing and 3-day states are mutually exclusive; verified baselines enable English missing evidence", async () => {
  const f = await make({}, { englishDiary: { enabled: true } });
  f.services.accountService = { checkCapability: () => true, subscribe: () => () => {} };
  const ids = (await f.workbench.load()).signals.map(item => item.id); assert.ok(ids.includes(10)); assert.ok(!ids.includes(4));
  const path = `日记（journal）/${keyDate.slice(0, 7)}/${keyDate}.md`;
  f.files.set(path, `# ${keyDate}\n今天记录了真实的生活。`);
  f.files.set("plugin/workbench-records.json", JSON.stringify({ version: 1, inbox: {}, tasks: {}, journals: { [path]: { fingerprint: "", lines: [] } }, reviews: {} }));
  f.folders.add("plugin/english-diary"); f.workbench.invalidate();
  assert.ok((await f.workbench.load()).signals.some(item => item.id === 5));
  f.files.delete("plugin/workbench-records.json"); f.workbench.invalidate();
  assert.equal((await f.workbench.readFacts()).journals[0].state, "unknown"); assert.ok(!(await f.workbench.load()).signals.some(item => item.id === 5)); f.close();
});
await test("weekly review requires actual status evidence and validates saved output existence", async () => {
  const f = await make(); const weekend = new Date(); weekend.setDate(weekend.getDate() + (6 - weekend.getDay() + 7) % 7); weekend.setHours(19);
  assert.ok(!(await f.workbench.load(weekend.getTime())).signals.some(item => item.id === 9));
  const records = { version: 1, inbox: {}, tasks: {}, journals: {}, reviews: {} };
  f.files.set("plugin/workbench-records.json", JSON.stringify(records)); f.workbench.invalidate();
  assert.ok((await f.workbench.load(weekend.getTime())).signals.some(item => item.id === 9));
  records.reviews[workbenchWeekKey(weekend.getTime())] = { completedAt: weekend.getTime(), outputPath: "outputs/复盘.md" };
  f.files.set("plugin/workbench-records.json", JSON.stringify(records)); f.files.set("outputs/复盘.md", "正式复盘内容"); f.workbench.invalidate();
  assert.ok(!(await f.workbench.load(weekend.getTime())).signals.some(item => item.id === 9)); f.close();
});
await test("evening-only journal reminder uses real single-day absence instead of the 3-day reminder", async () => {
  const now = new Date(); now.setHours(19, 0, 0, 0);
  const seed = {}, journals = {};
  for (const offset of [1, 2]) {
    const date = new Date(now); date.setDate(date.getDate() - offset); const key = localWorkbenchDate(date);
    const path = `日记（journal）/${key.slice(0, 7)}/${key}.md`; seed[path] = "已经记录的日记";
    journals[path] = { fingerprint: "", lines: [] };
  }
  seed["plugin/workbench-records.json"] = JSON.stringify({ version: 1, inbox: {}, tasks: {}, journals, reviews: {} });
  const f = await make(seed); const ids = (await f.workbench.load(now.getTime())).signals.map(item => item.id);
  assert.ok(ids.includes(4)); assert.ok(!ids.includes(10)); f.close();
});
await test("Inbox recovers a parked replacement before calculating arrivals", async () => {
  const f = await make({ "inbox/已有.md": "已有" }); await f.workbench.load();
  const path = "plugin/mobile/workbench-workbench-fixture.json";
  await f.adapter.rename(path, `${path}.replace-backup.json`); f.workbench.invalidate();
  await f.workbench.load(); assert.ok(await f.adapter.exists(path));
  for (let index = 0; index < 3; index++) await f.app.vault.create(`inbox/后来${index}.md`, String(index));
  assert.equal((await f.workbench.load()).signals.find(item => item.id === 6).source.objects.length, 3); f.close();
});
await test("text Raw current versions honor persisted digest/maintenance state and isolate binary limitations", async () => {
  const f = await make({ "raw/a.md": "资料a", "raw/b.md": "资料b", "raw/c.md": "资料c", "raw/附件.pdf": "binary" });
  const snapshot = await f.workbench.load(), signal = snapshot.signals.find(item => item.id === 7); assert.ok(signal);
  assert.ok(!signal.source.objects.includes("raw/附件.pdf")); assert.equal(snapshot.issues.length, 0);
  const body = "资料a";
  f.files.set("plugin/pi-agent-product-v1/knowledge/processed-sources.json", JSON.stringify({ schemaVersion: 1, entries: { "raw/a.md": { fingerprint: `sha256:${new TextEncoder().encode(body).length}:${sha256Hex(body)}` } } }));
  f.workbench.invalidate(); assert.ok(!(await f.workbench.load()).signals.some(item => item.id === 7)); f.close();
});
await test("isolation comes from complete resolved links in bound wiki/project scope, never file count", async () => {
  const f = await make(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`wiki/${index}.md`, `笔记${index}`])));
  f.folders.add("wiki"); const bindings = emptyKnowledgeFolderBindings(); bindings.roles.wiki = { ...bindings.roles.wiki, enabled: true, readPaths: ["wiki"], writePath: "wiki" };
  f.settings.knowledgeBase.folderBindings = bindings; f.workbench.invalidate();
  assert.equal((await f.workbench.readFacts()).isolated, null); assert.ok(!(await f.workbench.load()).signals.some(item => item.id === 14));
  f.app.metadataCache.resolvedLinks = Object.fromEntries(f.app.vault.getMarkdownFiles().map(file => [file.path, {}])); f.app.metadataCache.trigger("resolved");
  assert.ok((await f.workbench.load()).signals.some(item => item.id === 14)); f.close();
});
console.log(`OK ${passed} mobile workbench tests; browser bundle excludes desktop/Node workbench services`);
