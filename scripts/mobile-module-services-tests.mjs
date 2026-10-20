import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, FixtureTFile, answer } from "../tests/mobile/host.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-modules/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(file => /node:|tool-authorization\.ts$|pi-obsidian-tools\.ts$|workbench-records\.ts$/u.test(file)));
const dom = new JSDOM("<!doctype html><body></body>", { url: "https://fixture.invalid" });
const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
const shim = { exports: {} };
vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, console });
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, Uint8Array,
  AbortController, URL, URLSearchParams, atob, btoa, setTimeout, clearTimeout, console, window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser,
  require: name => { assert.equal(name, "obsidian"); return { ...shim.exports, TFile: FixtureTFile }; } });
const { MobileServices, MobileStore, MobileRuntime, loadMobileSettings, mobileModel, mobileProvider, defaultJournalTemplateChoice,
  todoPageRecords, MobileCapabilityPolicy, mobileTools, inspectMobileTaskResume, assertMobileResumeObservations } = module.exports;
let passed = 0;
const plain = value => JSON.parse(JSON.stringify(value));
async function test(name, run) { await run(); console.log(`OK ${++passed} ${name}`); }
async function fixture(request = async () => { throw Error("No Provider may be used by local module services"); }) {
  const host = createHost({ "journal/2026-10-18.md": "# Yesterday\n\nA real synthetic journal body.", "templates/daily.md": "# {{date:YYYY-MM-DD}}\n\nOriginal template {{title}}", "images/synthetic.png": "synthetic image" });
  host.folders.add("journal"); host.folders.add("templates");
  const get = host.app.vault.getAbstractFileByPath.bind(host.app.vault);
  host.app.vault.getAbstractFileByPath = path => { const file = get(path); return file && !(file instanceof FixtureTFile) ? Object.assign(new shim.exports.TFolder(), file) : file; };
  host.app.vault.process = async (file, change) => { const next = change(await host.app.vault.read(file)); await host.app.vault.modify(file, next); return next; };
  host.app.vault.getResourcePath = file => `fixture-resource:${file.path}`;
  host.app.metadataCache.getFileCache = file => file.path.startsWith("journal/") ? { embeds: [{ link: "images/synthetic.png" }] } : {};
  host.app.metadataCache.getFirstLinkpathDest = path => get(path);
  host.app.fileManager = { trashFile: async file => { host.files.delete(file.path); } };
  host.app.internalPlugins = { plugins: { "daily-notes": { instance: { options: { folder: "journal", format: "YYYY-MM-DD", template: "templates/daily.md" } } }, templates: { instance: { options: { folder: "templates" } } } } };
  const settings = loadMobileSettings({}), provider = mobileProvider("custom"); Object.assign(provider, { apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", models: [mobileModel("fixture")], defaultModelId: "fixture" });
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = "fixture"; settings.lifestyle.finance.enabled = true;
  const store = new MobileStore(host.adapter, "plugin/mobile", "module-fixture"); await store.load();
  let pro = true, saves = 0;
  const access = { checkCapability: () => pro, requireCapability: () => { if (!pro) throw Error("PRO revoked"); }, subscribe: () => () => {} };
  const runtime = new MobileRuntime(host.app, store, () => settings, request, async () => "", async () => {}, () => access);
  const services = new MobileServices({ app: host.app, settings, store, runtime, navigation: {}, accountService: access, saveSettings: async () => { saves++; }, registerEvent() {}, showPage: async () => {} }, "plugin/mobile");
  await services.initializeFinance(); await runtime.initialize();
  const release = async () => { await runtime.shutdown(); await services.dispose(); services.getTodoStore().dispose(); };
  return { ...host, settings, store, runtime, services, access, revoke: () => { pro = false; }, saves: () => saves, release };
}
async function financeRun(f, id, text, permission = "workspace-write", resume) {
  await f.store.setPermission(permission);
  await f.store.updateSession(f.store.session.id, task => { (task.runs ??= []).push({ id, status: "running", startedAt: 1 }); });
  const policy = new MobileCapabilityPolicy({ store: f.store, settings: () => f.settings, agentId: "sol", proAccess: () => f.access });
  return mobileTools(f.app, f.store, () => "", () => f.settings.knowledgeBase.folderBindings, undefined, f.store.session.id, policy, { runId: id, userText: text, ...(resume ? { resume } : {}) }, undefined, f.services.modules.finance.service);
}
const tool = (tools, name) => { const found = tools.find(item => item.name === name); assert.ok(found, `${name} must be registered`); return found; };
const call = (tools, name, id, args) => tool(tools, name).execute(id, args, new AbortController().signal);
await test("journal reads original native settings/photos, explicit creation uses native template and reopening writes nothing", async () => {
  const f = await fixture(), before = [...f.files];
  const snapshot = await f.services.modules.journal.read(); assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].firstImagePath, "images/synthetic.png"); assert.match(await f.services.modules.journal.readSummary(snapshot.records[0].path), /synthetic journal/u); assert.deepEqual([...f.files], before);
  const result = await f.services.modules.journal.create(new Date(2026, 9, 19, 12), defaultJournalTemplateChoice()); assert.equal(result.created, true); assert.match(f.files.get(result.path), /Original template 2026-10-19/u);
  const saved = [...f.files]; assert.equal((await f.services.modules.journal.create(new Date(2026, 9, 19, 12), defaultJournalTemplateChoice())).created, false); assert.deepEqual([...f.files], saved);
  let opened = ""; f.app.setting = { open() {}, openTabById(id) { opened = id; } }; f.services.modules.journal.openSettings(); assert.equal(opened, "daily-notes"); await f.release();
});
await test("journal template read/import keeps conflict and explicit safe-copy behavior", async () => {
  const f = await fixture(), template = f.services.modules.journal.previewImportedTemplate("Imported.md", "# Imported\n\n{{date:YYYY-MM-DD}}");
  const saved = await f.services.modules.journal.saveImportedTemplate(template); assert.equal(saved.status, "saved"); const bytes = [...f.files];
  assert.equal((await f.services.modules.journal.saveImportedTemplate(template)).status, "conflict"); assert.deepEqual([...f.files], bytes);
  const copied = await f.services.modules.journal.saveImportedTemplate(template, "safe-copy"); assert.equal(copied.status, "saved"); assert.notEqual(copied.path, saved.path); await f.release();
});
await test("Todo source versions, new categories, completion history, filters and stale writes share one source", async () => {
  const f = await fixture(); let snapshot = await f.services.modules.todos.read();
  await f.services.modules.todos.add({ title: "Synthetic task", dueDate: "2026-10-19", dueTime: "14:30", categoryName: "New category" }, snapshot.contentVersion);
  snapshot = await f.services.modules.todos.read(); assert.ok(snapshot.categories.some(item => item.name === "New category")); assert.equal(snapshot.records[0].dueTime, "14:30");
  await f.services.modules.todos.toggle(snapshot.records[0], true, snapshot.contentVersion); let done = await f.services.modules.todos.read(); assert.equal(done.completion.total, 1); assert.equal(done.completion.today, 1);
  await assert.rejects(f.services.modules.todos.update(snapshot.records[0], { title: "stale" }, snapshot.contentVersion)); assert.equal((await f.services.modules.todos.read()).records[0].title, "Synthetic task");
  await f.services.modules.todos.renameCategory("New category", "Renamed", done.contentVersion); done = await f.services.modules.todos.read(); assert.equal(done.records[0].categoryName, "Renamed");
  assert.equal(todoPageRecords(done.records, done.projects, { status: "done", category: null, project: null, page: 1 }).total, 1);
  await f.services.modules.todos.remove(done.records[0], done.contentVersion); assert.equal((await f.services.modules.todos.read()).completion.total, 1); await f.release();
});
await test("a real TodoStore subscriber may read fresh module snapshots without notifying itself again", async () => {
  const f = await fixture(), port = f.services.modules.todos, settle = () => new Promise(resolve => setTimeout(resolve, 300));
  let before = await port.read(); await port.add({ title: "Before external edit" }, before.contentVersion); await settle(); before = await port.read();
  let notifications = 0; const refreshes = [], observed = [];
  const unsubscribe = port.subscribe(() => {
    notifications++;
    // Bound the old failure so this regression reports an error instead of hanging.
    if (notifications <= 4) refreshes.push(port.read().then(snapshot => { observed.push(snapshot); }));
  });
  try {
    await port.read(); await port.read(); await Promise.all(refreshes); assert.equal(notifications, 0, "reading must not emit another TodoStore notification");
    const file = f.app.vault.getAbstractFileByPath(before.sourcePath);
    await f.app.vault.modify(file, f.files.get(before.sourcePath).replace("Before external edit", "After external edit").replace("- [ ]", "- [x]"));
    const immediate = await port.read(); assert.equal(immediate.records[0].title, "After external edit"); assert.equal(immediate.records[0].done, true); assert.notEqual(immediate.contentVersion, before.contentVersion);
    await settle(); await Promise.all(refreshes);
    assert.equal(notifications, 1); assert.equal(observed.length, 1); assert.equal(observed[0].records[0].title, "After external edit"); assert.equal(observed[0].completion.total, 1);
    await port.read(); await Promise.all(refreshes); assert.equal(notifications, 1, "the subscription refresh must terminate");
  } finally { unsubscribe(); await f.release(); }
});
await test("module handoff only fills the Registry owner's unsent draft and conflicts never overwrite it", async () => {
  const f = await fixture(), count = f.store.state.sessions.length, owner = f.services.modules.owner("todos");
  const first = await f.services.modules.handoff("todos", "synthetic unsent request"); assert.equal(first.agentId, owner.id); assert.equal(first.conflict, false); assert.equal(f.store.state.sessions.length, count);
  const draft = plain(f.store.state.newTaskDrafts[owner.id]); assert.equal((await f.services.modules.handoff("todos", "different request")).conflict, true); assert.deepEqual(plain(f.store.state.newTaskDrafts[owner.id]), draft);
  assert.equal((await f.services.modules.handoff("todos", "explicit replacement", true)).conflict, false); assert.equal(f.store.state.sessions.length, count); assert.equal(f.store.state.sessions.some(task => task.runs?.length), false); await f.release();
});
await test("finance query/create/update/budget/bill operations reuse exact ledger and durable M4 receipts", async () => {
  const f = await fixture(), tools = await financeRun(f, "finance-run", "记一笔早餐12元，然后修改预算并创建旅行账单");
  await call(tools, "finance_record", "create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } });
  let state = await f.services.modules.finance.service.readForConversation(); assert.equal(state.records.length, 1); assert.equal(f.store.session.operations[0].status, "completed");
  const row = state.records[0]; const update = await financeRun(f, "update-run", "把这笔早餐修改为15元"); await call(update, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents: 1500 } });
  const budget = (await call(update, "finance_budget", "budget-read", { action: "get", scope: "default" })).details.data;
  const budgetTools = await financeRun(f, "budget-run", "设置默认预算总额1000元"); await call(budgetTools, "finance_budget", "budget", { action: "update", scope: "default", expectedVersion: budget.expectedVersion, totalCents: 100000 });
  const bills = await financeRun(f, "bill-run", "创建旅行账单预算500元"); await call(bills, "finance_bill", "bill", { action: "create", name: "Synthetic trip", budgetCents: 50000 });
  assert.equal((await f.services.modules.finance.readData()).financeBillPlans.length, 1); assert.equal(f.store.session.operations.every(item => item.status === "completed"), true);
  const operations = (await call(tools, "finance_query", "operations", { action: "operations" })).details.operations; assert.equal(operations.length, 4);
  const resume = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service); assert.equal(resume.issues.length, 0);
  await assert.rejects(call(tools, "finance_record", "repeat", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } })); assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 1); await f.release();
});
await test("distinct explicit purchases in new runs are independent while same-run, missing-intent and resume repeats stay blocked", async () => {
  const f = await fixture(), args = { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } };
  const first = await financeRun(f, "first-purchase", "记一笔早餐12元"); await call(first, "finance_record", "same-provider-id", args);
  await assert.rejects(call(first, "finance_record", "different-call-same-run", args));
  const second = await financeRun(f, "second-purchase", "再记一笔早餐12元"); await call(second, "finance_record", "same-provider-id", args);
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 2);
  assert.equal(new Set(f.store.session.operations.map(item => item.semanticKey)).size, 1);
  assert.equal(new Set(f.store.session.operations.map(item => item.target)).size, 2);
  const missing = await financeRun(f, "missing-intent", "继续"); await assert.rejects(call(missing, "finance_record", "not-a-new-purchase", args), /明确本次财务写入意图/u);
  const resume = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service); assert.equal(resume.issues.length, 0);
  const resumed = await financeRun(f, "resume-run", "再记一笔早餐12元", "workspace-write", resume);
  await assert.rejects(call(resumed, "finance_record", "different-resume-call", args));
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 2); assert.equal(f.store.session.operations.length, 2); await f.release();
});
await test("exact completed receipt chains reconcile create/update/delete and repeated budget/bill writes without replay", async () => {
  const f = await fixture(), first = await financeRun(f, "chain-create", "记一笔早餐12元");
  await call(first, "finance_record", "create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } });
  for (const amountCents of [1500, 1800]) {
    const row = (await f.services.modules.finance.service.readForConversation()).records[0], update = await financeRun(f, `chain-${amountCents}`, "把早餐修改为新的金额");
    await call(update, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents } });
  }
  assert.equal((await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service)).issues.length, 0);
  const row = (await f.services.modules.finance.service.readForConversation()).records[0], deletion = await financeRun(f, "chain-delete", "删除早餐账目");
  await call(deletion, "finance_record", "delete", { action: "delete", targets: [{ id: row.entry.id, expectedVersion: row.version }] });
  for (const totalCents of [100000, 120000]) {
    const tools = await financeRun(f, `chain-budget-${totalCents}`, "设置默认预算总额"), budget = (await call(tools, "finance_budget", "read", { action: "get", scope: "default" })).details.data;
    await call(tools, "finance_budget", "update", { action: "update", scope: "default", expectedVersion: budget.expectedVersion, totalCents });
  }
  const billTools = await financeRun(f, "chain-bill-create", "创建旅行账单"); await call(billTools, "finance_bill", "create", { action: "create", name: "Synthetic trip", budgetCents: 50000 });
  const bill = (await call(billTools, "finance_bill", "list", { action: "list" })).details.data.bills[0], changeBill = await financeRun(f, "chain-bill-update", "修改旅行账单预算");
  await call(changeBill, "finance_bill", "update", { action: "update", id: bill.id, expectedVersion: bill.expectedVersion, budgetCents: 60000 });
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const snapshot = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service); assert.equal(snapshot.issues.length, 0); assert.equal(snapshot.operations.length, 8); assert.equal(snapshot.operations.every(item => item.status === "completed"), true);
  await assertMobileResumeObservations(f.app, cold, snapshot, undefined, f.services.modules.finance.service); await f.release();
});
await test("one run may create then update the same record while cold recovery leaves every durable receipt intact", async () => {
  const f = await fixture(), tools = await financeRun(f, "one-run-chain", "记一笔早餐12元，然后把早餐修改为15元");
  await call(tools, "finance_record", "create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } });
  const row = (await f.services.modules.finance.service.readForConversation()).records[0];
  await call(tools, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents: 1500 } });
  const durable = JSON.stringify(f.store.session.operations), cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const snapshot = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service);
  assert.equal(snapshot.issues.length, 0); assert.equal(snapshot.operations.length, 2); assert.equal(JSON.stringify(cold.session.operations), durable);
  await assertMobileResumeObservations(f.app, cold, snapshot, undefined, f.services.modules.finance.service);
  await f.app.vault.modify(f.app.vault.getAbstractFileByPath(row.path), f.files.get(row.path) + "\nExternal edit after review");
  await assert.rejects(assertMobileResumeObservations(f.app, cold, snapshot, undefined, f.services.modules.finance.service)); await f.release();
});
await test("overlapping batch receipt chains verify each record's exact continuation and retain any broken record", async () => {
  const f = await fixture(), tools = await financeRun(f, "overlap", "记一笔早餐12元和一笔晚餐20元，再把这些笔全部修改为15元，随后单独修改第一笔金额");
  for (const [name, amountCents] of [["早餐", 1200], ["晚餐", 2000]]) await call(tools, "finance_record", name, { action: "create", record: { description: name, amountCents, category: "餐饮" } });
  let rows = (await f.services.modules.finance.service.readForConversation()).records;
  await call(tools, "finance_record", "batch", { action: "update", targets: rows.map(row => ({ id: row.entry.id, expectedVersion: row.version })), patch: { amountCents: 1500 } });
  rows = (await f.services.modules.finance.service.readForConversation()).records;
  await call(tools, "finance_record", "single", { action: "update", targets: [{ id: rows[0].entry.id, expectedVersion: rows[0].version }], patch: { amountCents: 1800 } });
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const snapshot = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service); assert.equal(snapshot.issues.length, 0);
  await assertMobileResumeObservations(f.app, cold, snapshot, undefined, f.services.modules.finance.service);
  await f.app.vault.modify(f.app.vault.getAbstractFileByPath(rows[1].path), f.files.get(rows[1].path) + "\nExternal edit on the other record");
  const changed = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service);
  assert.deepEqual(plain(changed.issues.map(issue => issue.operationId)), plain(cold.session.operations.slice(0, 3).map(operation => operation.id)));
  assert.equal(changed.issues.every(issue => issue.status === "conflict"), true); await f.release();
});
await test("receipt chains retain conflicts when external edits break the before-version or change the latest result", async () => {
  const f = await fixture(), first = await financeRun(f, "external-create", "记一笔早餐12元");
  await call(first, "finance_record", "create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } });
  let row = (await f.services.modules.finance.service.readForConversation()).records[0];
  await f.app.vault.modify(f.app.vault.getAbstractFileByPath(row.path), f.files.get(row.path) + "\nExternal edit before update");
  row = (await f.services.modules.finance.service.readForConversation()).records[0]; const update = await financeRun(f, "external-update", "把早餐修改为15元");
  await call(update, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents: 1500 } });
  let snapshot = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service);
  assert.equal(snapshot.issues.length, 1); assert.equal(snapshot.issues[0].operationId, f.store.session.operations[0].id); assert.equal(snapshot.issues[0].status, "conflict");
  await f.app.vault.modify(f.app.vault.getAbstractFileByPath(row.path), f.files.get(row.path) + "\nExternal edit after update");
  snapshot = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service); assert.equal(snapshot.issues.length, 2); assert.equal(snapshot.issues.every(issue => issue.status === "conflict"), true); await f.release();
});
await test("an uncertain successor never folds a completed predecessor or upgrades an unknown write", async () => {
  const f = await fixture(), first = await financeRun(f, "uncertain-create", "记一笔早餐12元");
  await call(first, "finance_record", "create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } });
  const row = (await f.services.modules.finance.service.readForConversation()).records[0], tools = await financeRun(f, "uncertain-update", "把早餐修改为15元"), update = f.store.updateSession.bind(f.store); let failed = false;
  f.store.updateSession = (id, change) => update(id, task => { change(task); if (!failed && task.operations?.at(-1)?.status === "completed") { failed = true; throw Error("successor-receipt-failed"); } });
  await assert.rejects(call(tools, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents: 1500 } }));
  const snapshot = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service);
  assert.equal(snapshot.issues.length, 2); assert.equal(snapshot.issues.find(issue => issue.operationId === f.store.session.operations[0].id).status, "conflict"); assert.equal(snapshot.issues.find(issue => issue.operationId === f.store.session.operations[1].id).status, "unknown");
  assert.equal(f.store.session.operations[1].status, "uncertain"); assert.equal((await f.services.modules.finance.service.readForConversation()).records[0].entry.amountCents, 1500); await f.release();
});
await test("a completed successor cannot upgrade an uncertain predecessor or permit its later replay", async () => {
  const f = await fixture(), tools = await financeRun(f, "unknown-create", "记一笔早餐12元"), update = f.store.updateSession.bind(f.store); let failed = false;
  const createArgs = { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } };
  f.store.updateSession = (id, change) => update(id, task => { change(task); if (!failed && task.operations?.at(-1)?.status === "completed") { failed = true; throw Error("predecessor-receipt-failed"); } });
  await assert.rejects(call(tools, "finance_record", "create", createArgs));
  const row = (await f.services.modules.finance.service.readForConversation()).records[0], successor = await financeRun(f, "known-update", "把早餐修改为15元");
  await call(successor, "finance_record", "update", { action: "update", targets: [{ id: row.entry.id, expectedVersion: row.version }], patch: { amountCents: 1500 } });
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const snapshot = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service);
  assert.equal(snapshot.issues.length, 1); assert.equal(snapshot.issues[0].operationId, f.store.session.operations[0].id); assert.equal(snapshot.issues[0].status, "unknown");
  assert.equal(cold.session.operations[0].status, "uncertain"); assert.equal(cold.session.operations[1].status, "completed");
  const later = await financeRun(f, "unknown-create-replay", "再记一笔早餐12元"); await assert.rejects(call(later, "finance_record", "retry", createArgs));
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 1); await f.release();
});
await test("read-only and revoked PRO at the actual create boundary block effects", async () => {
  const f = await fixture(), read = await financeRun(f, "readonly", "记一笔早餐12元", "read-only"); assert.equal(read.some(item => item.name === "finance_record"), false);
  const tools = await financeRun(f, "revoked", "记一笔早餐12元"), get = f.app.vault.getAbstractFileByPath.bind(f.app.vault); let revoked = false;
  const directory = f.services.modules.finance.service.ledger.paths().directory;
  // Revoke after the durable started receipt, at the ledger's final existence check.
  f.app.vault.getAbstractFileByPath = path => { const found = get(path); if (!found && path.startsWith(`${directory}/`) && path.endsWith('.md') && f.store.session.operations?.some(item => item.status === 'started')) { revoked = true; f.revoke(); } return found; };
  await assert.rejects(call(tools, "finance_record", "revoked-create", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } })); f.app.vault.getAbstractFileByPath = get; assert.equal(revoked, true);
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 0); assert.equal(f.store.session.operations[0].status, "uncertain"); await f.release();
});
await test("receipt failure keeps financial effect, cold task reports unknown and exact semantic replay stays blocked", async () => {
  const f = await fixture(), tools = await financeRun(f, "receipt-run", "记一笔早餐12元"), update = f.store.updateSession.bind(f.store); let failed = false;
  f.store.updateSession = (id, change) => update(id, task => { change(task); if (!failed && task.operations?.at(-1)?.status === "completed") { failed = true; throw Error("receipt-save-failed"); } });
  await assert.rejects(call(tools, "finance_record", "receipt", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } }));
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 1);
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load(); const resume = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service); assert.equal(resume.issues[0].status, "unknown");
  const retry = await financeRun(f, "later-run", "记一笔早餐12元"); await assert.rejects(call(retry, "finance_record", "new-call", { action: "create", record: { description: "早餐", amountCents: 1200, category: "餐饮" } })); assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 1); await f.release();
});
await test("actual MobileRuntime attributes reused finance call IDs by run, ignores read-only transcripts and cold reads exact receipts", async () => {
  let calls = 0;
  const f = await fixture(async () => ++calls % 2 === 1 ? answer("openai-completions", "", [
    ["runtime-finance", "finance_record", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }],
    ["budget-read", "finance_budget", { action: "get", scope: "default" }], ["bill-read", "finance_bill", { action: "list" }]
  ]) : answer("openai-completions", "已按真实回执记账。"));
  await f.store.setPermission("workspace-write");
  await f.runtime.send("记一笔早餐12元"); await f.runtime.send("再记一笔早餐12元");
  assert.equal(calls, 4); assert.equal(f.store.session.taskStatus, "completed"); assert.equal(f.store.session.operations.length, 2); assert.equal(f.store.session.operations.every(item => item.toolName === "finance_write" && item.status === "completed"), true);
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 2);
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const resume = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service); assert.equal(resume.issues.length, 0); await f.release();
});
await test("finance transcripts without original M4 intent remain unknown and cannot replay in a later run", async () => {
  let calls = 0;
  const f = await fixture(async () => ++calls === 1 ? answer("openai-completions", "", [["legacy-finance", "finance_record", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }]]) : answer("openai-completions", "已记账。"));
  await f.store.setPermission("workspace-write"); await f.runtime.send("记一笔早餐12元");
  await f.store.updateSession(f.store.session.id, task => { task.operations = []; });
  const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load();
  const resume = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service);
  assert.equal(resume.issues.length, 1); assert.equal(resume.issues[0].status, "unknown"); assert.match(resume.issues[0].label, /旧财务写调用/u);
  const retry = await financeRun(f, "later-legacy-run", "再记一笔早餐12元"); await assert.rejects(call(retry, "finance_record", "different-call", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }));
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 1); assert.equal(f.store.session.operations.length, 0); await f.release();
});
await test("Agent capability revocation inside actual Vault.process prevents a ledger patch", async () => {
  const f = await fixture(), created = await financeRun(f, "seed-run", "记一笔早餐12元"); await call(created, "finance_record", "seed", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } });
  const before = (await f.services.modules.finance.service.readForConversation()).records[0], tools = await financeRun(f, "patch-run", "把这笔早餐修改为15元"), process = f.app.vault.process.bind(f.app.vault);
  let revoked = false; f.app.vault.process = async (file, change) => process(file, text => { if (file.path === before.path) { f.settings.agentRegistry.agents[0].disabledCapabilityIds = ["finance"]; revoked = true; } return change(text); });
  await assert.rejects(call(tools, "finance_record", "patch-revoked", { action: "update", targets: [{ id: before.entry.id, expectedVersion: before.version }], patch: { amountCents: 1500 } }));
  assert.equal(revoked, true); assert.equal((await f.services.modules.finance.service.readForConversation()).records[0].version, before.version); await f.release();
});
await test("batch interruption keeps a partial financial result uncertain and prevents replay", async () => {
  const f = await fixture(), create = await financeRun(f, "batch-seed", "记一笔早餐12元");
  await call(create, "finance_record", "first", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } });
  const second = await financeRun(f, "second-seed", "记一笔晚餐20元"); await call(second, "finance_record", "second", { action: "create", record: { amountCents: 2000, category: "餐饮", description: "晚餐" } });
  const before = (await f.services.modules.finance.service.readForConversation()).records, tools = await financeRun(f, "batch-update", "把这两笔全部修改为15元"), modify = f.app.vault.modify.bind(f.app.vault); let changed = 0;
  f.app.vault.modify = async (file, text) => { await modify(file, text); if (before.some(row => row.path === file.path) && ++changed === 1) f.settings.agentRegistry.agents[0].disabledCapabilityIds = ["finance"]; };
  await assert.rejects(call(tools, "finance_record", "batch", { action: "update", targets: before.map(row => ({ id: row.entry.id, expectedVersion: row.version })), patch: { amountCents: 1500 } }));
  const after = (await f.services.modules.finance.service.readForConversation()).records; assert.equal(after.filter(row => row.entry.amountCents === 1500).length, 1); assert.equal(f.store.session.operations.at(-1).status, "uncertain");
  const resume = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service); assert.ok(resume.issues.some(issue => issue.status === "unknown")); await f.release();
});
await test("bill association, record deletion and external changes retain exact observed versions", async () => {
  const f = await fixture(), tools = await financeRun(f, "seed", "记一笔早餐12元，创建旅行账单"); await call(tools, "finance_record", "create", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }); await call(tools, "finance_bill", "bill", { action: "create", name: "Synthetic trip", budgetCents: 50000 });
  let state = await f.services.modules.finance.service.readForConversation(); const row = state.records[0], bill = (await call(tools, "finance_bill", "bills", { action: "list" })).details.data.bills[0];
  const associate = await financeRun(f, "associate", "把刚才这笔关联到旅行账单"); await call(associate, "finance_bill", "associate", { action: "associate", id: bill.id, expectedVersion: bill.expectedVersion, targets: [{ id: row.entry.id, expectedVersion: row.version }] });
  state = await f.services.modules.finance.service.readForConversation(); assert.equal(state.records[0].entry.billPlanId, bill.id);
  const snapshot = await inspectMobileTaskResume(f.app, f.store, f.store.session.id, undefined, f.services.modules.finance.service);
  await f.app.vault.modify(f.app.vault.getAbstractFileByPath(row.path), f.files.get(row.path) + "\nExternal synthetic edit");
  await assert.rejects(assertMobileResumeObservations(f.app, f.store, snapshot, undefined, f.services.modules.finance.service));
  const current = (await f.services.modules.finance.service.readForConversation()).records[0], deletion = await financeRun(f, "delete", "删除刚才这一笔账目"); await call(deletion, "finance_record", "delete", { action: "delete", targets: [{ id: current.entry.id, expectedVersion: current.version }] });
  assert.equal((await f.services.modules.finance.service.readForConversation()).records.length, 0); assert.equal(f.store.session.operations.at(-1).status, "completed"); await f.release();
});
await test("physical DataAdapter persists ledger and M4 receipt for a fresh cold store", async () => {
  const registered = path.join(homedir(), "EchoInk-TestVaults/90-任务临时/移动端改版-M11-20261019"); await fs.mkdir(registered, { recursive: true });
  const directory = await fs.mkdtemp(path.join(registered, "module-services-")), f = await fixture();
  const full = relative => { const target = path.resolve(directory, relative); assert.ok(target.startsWith(`${directory}${path.sep}`)); return target; };
  try {
    for (const [relative, text] of f.files) { await fs.mkdir(path.dirname(full(relative)), { recursive: true }); await fs.writeFile(full(relative), text); }
    const write = f.adapter.write, rename = f.adapter.rename, remove = f.adapter.remove, create = f.app.vault.create.bind(f.app.vault);
    f.adapter.read = relative => fs.readFile(full(relative), "utf8");
    f.adapter.write = async (relative, text) => { await fs.mkdir(path.dirname(full(relative)), { recursive: true }); await fs.writeFile(full(relative), text); await write(relative, text); };
    f.adapter.rename = async (from, to) => { await fs.rename(full(from), full(to)); await rename(from, to); };
    f.adapter.remove = async relative => { await fs.unlink(full(relative)); await remove(relative); };
    f.app.vault.create = async (relative, text) => { await fs.mkdir(path.dirname(full(relative)), { recursive: true }); await fs.writeFile(full(relative), text, { flag: "wx" }); return create(relative, text); };
    const tools = await financeRun(f, "physical", "记一笔早餐12元"); await call(tools, "finance_record", "disk", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } });
    const row = (await f.services.modules.finance.service.readForConversation()).records[0]; assert.match(await fs.readFile(full(row.path), "utf8"), /12\.00/u);
    const cold = new MobileStore(f.adapter, "plugin/mobile", "module-fixture"); await cold.load(); assert.equal(cold.session.operations[0].status, "completed");
    const resumed = await inspectMobileTaskResume(f.app, cold, cold.session.id, undefined, f.services.modules.finance.service); assert.equal(resumed.issues.length, 0);
    const service = f.services.modules.finance.service, ledger = service.ledger;
    await ledger.reload();
    let notifications = 0;
    const refreshes = [], observed = [];
    const unsubscribe = service.subscribeEntries(() => {
      notifications++;
      // Bound the old self-notification failure so a regression fails rather than hanging.
      if (notifications <= 12) refreshes.push(ledger.readSnapshots({ notify: false }).then(records => { observed.push(records); }));
    });
    try {
      const before = await fs.readFile(full(row.path), "utf8"), writesBefore = f.writes.length;
      await ledger.readSnapshots({ notify: false }); await Promise.all(refreshes);
      assert.equal(notifications, 0, "a read-only snapshot must not notify its own subscriber");
      assert.equal(f.writes.length, writesBefore); assert.equal(await fs.readFile(full(row.path), "utf8"), before);
      const external = before.replace(/^amount:.*$/mu, 'amount: "18.00"'); assert.notEqual(external, before);
      await fs.writeFile(full(row.path), external); // Real external bytes; the Vault event is the host boundary.
      f.app.vault.trigger("modify", f.app.vault.getAbstractFileByPath(row.path));
      const changed = await ledger.readSnapshots({ notify: false }); await Promise.all(refreshes);
      assert.equal(notifications, 1, "external modifications still notify");
      assert.equal(changed[0].entry.amountCents, 1800); assert.equal(observed[0][0].entry.amountCents, 1800); assert.notEqual(changed[0].version, row.version);
      await ledger.readSnapshots({ notify: false }); assert.equal(notifications, 1, "subscription reads terminate without another refresh");
      await ledger.add({ ...changed[0].entry, id: "snapshot-manual", source: "manual", sourceId: "snapshot-manual" });
      const withManual = await ledger.readSnapshots({ notify: false }); await Promise.all(refreshes);
      assert.ok(notifications > 1, "an explicit manual ledger write still notifies");
      assert.equal(withManual.length, 2); assert.ok(observed.at(-1).some(record => record.entry.id === "snapshot-manual"));
      const afterWrite = notifications;
      await ledger.readSnapshots(); await Promise.all(refreshes);
      assert.equal(notifications, afterWrite + 1, "the default snapshot call retains its existing notification behavior");
      await ledger.readSnapshots({ notify: false }); assert.equal(notifications, afterWrite + 1);
    } finally { unsubscribe(); }

  } finally { await f.release(); await fs.rm(directory, { recursive: true }); }
});
console.log(`OK ${passed} mobile module service checks; no Node/security runtime in browser bundle; controlled transports only`);
