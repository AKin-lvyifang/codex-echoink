import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import moment from "moment";
import { parse as parseYaml } from "yaml";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, FixtureTFile } from "../tests/mobile/host.mjs";

// Pure in-memory fixtures: never calls a Provider or writes a physical Vault.
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-module-settings/entry.ts"), metafile: true });
for (const file of Object.keys(build.metafile.inputs)) assert.ok(!["src/main.ts", "src/mobile/services.ts", "src/lifestyle/service.ts", "src/membership/account-service.ts", "src/settings/settings.ts"].includes(file), `unexpected runtime import: ${file}`);
const module = { exports: {} };
class FixtureFolder { constructor(path) { this.path = path; this.name = path.split("/").pop(); this.children = []; } }
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, crypto: webcrypto, structuredClone, TextEncoder, TextDecoder,
  AbortController, URL, setTimeout, clearTimeout, console, require(name) {
    assert.equal(name, "obsidian"); return { TFile: FixtureTFile, TFolder: FixtureFolder, moment, parseYaml, Notice: class {} };
  } });
const { mobileModuleEnabled, setMobileModuleEnabled, loadMobileSettings, MobileCapabilityPolicy, MobileWorkbenchService, MobileStore, parseTodoMarkdown, localWorkbenchDate, EMPTY_LIFESTYLE_DATA } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const basic = ["knowledge-base", "journal", "review", "todos"];
const pro = { checkCapability: () => true, subscribe: () => () => {} };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function settingHost(raw = {}, persist = async () => {}) {
  const settings = loadMobileSettings(raw); let saves = 0; const finance = [];
  const host = { settings: () => settings, async saveSettings() { saves++; await persist(settings); }, services: { lifestyle: { async setEnabled(kind, value) {
    finance.push([kind, value]); const previous = settings.lifestyle.finance.enabled; settings.lifestyle.finance.enabled = value;
    try { await host.saveSettings(); } catch (error) { settings.lifestyle.finance.enabled = previous; throw error; }
  } } } };
  return { settings, host, finance, saves: () => saves };
}
let passed = 0;
const test = async (name, run) => { await run(); console.log(`OK ${++passed} ${name}`); };

await test("missing basic module switches default on without changing older settings", () => {
  const f = settingHost({ review: { enabled: false }, unrelated: { keep: true } }), before = plain(f.settings);
  for (const id of basic) assert.equal(mobileModuleEnabled(f.settings, id), true);
  assert.equal(mobileModuleEnabled(f.settings, "finance"), false); assert.equal(mobileModuleEnabled(f.settings, "english-diary"), false);
  assert.equal(mobileModuleEnabled(f.settings, "pdf-reading"), false); assert.deepEqual(plain(f.settings), before);
  assert.equal(f.settings.mobileUi.moduleEnabled, undefined);
});
await test("each basic toggle changes only its mobile opt-out and preserves desktop module fields", async () => {
  const f = settingHost({ review: { enabled: true }, knowledgeBase: { lastSummary: "kept" }, todos: [], mobileUi: { future: { keep: true } } });
  const original = plain(f.settings);
  for (const id of basic) {
    await setMobileModuleEnabled(f.host, id, false); assert.equal(mobileModuleEnabled(f.settings, id), false);
    await setMobileModuleEnabled(f.host, id, true); assert.equal(mobileModuleEnabled(f.settings, id), true);
  }
  const after = plain(f.settings); delete after.mobileUi.moduleEnabled;
  assert.deepEqual(after, original); assert.equal(f.saves(), 8); assert.equal(f.finance.length, 0);
});
await test("explicit stored opt-outs survive loading while malformed boolean values do not disable", () => {
  const f = settingHost({ mobileUi: { moduleEnabled: { journal: false, todos: "false", future: { keep: true } } } });
  assert.equal(mobileModuleEnabled(f.settings, "journal"), false); assert.equal(mobileModuleEnabled(f.settings, "todos"), true);
  assert.deepEqual(plain(f.settings.mobileUi.moduleEnabled.future), { keep: true });
});
await test("failed basic save restores absence and leaves configuration intact", async () => {
  const f = settingHost({}, async () => { throw new Error("disk"); }), before = plain(f.settings);
  await assert.rejects(setMobileModuleEnabled(f.host, "todos", false), /保存失败/u);
  assert.deepEqual(plain(f.settings), before); assert.equal(f.settings.mobileUi.moduleEnabled, undefined);
});
await test("basic rollback restores one key while preserving unrelated edits", async () => {
  const f = settingHost({ mobileUi: { moduleEnabled: { journal: false }, future: "kept" } }, async settings => {
    settings.mobileUi.moduleEnabled.todos = false; settings.mobileUi.largeText = true; throw new Error("disk");
  });
  await assert.rejects(setMobileModuleEnabled(f.host, "journal", true), /保存失败/u);
  assert.deepEqual(plain(f.settings.mobileUi.moduleEnabled), { journal: false, todos: false }); assert.equal(f.settings.mobileUi.largeText, true);
});
await test("module writes serialize and a failed operation does not poison the next save", async () => {
  const pending = deferred(); let attempt = 0;
  const f = settingHost({}, async () => { if (++attempt === 1) await pending.promise; });
  const first = setMobileModuleEnabled(f.host, "journal", false), second = setMobileModuleEnabled(f.host, "todos", false);
  await turn(); assert.equal(f.saves(), 1); pending.reject(new Error("disk"));
  await assert.rejects(first, /保存失败/u); await second;
  assert.equal(mobileModuleEnabled(f.settings, "journal"), true); assert.equal(mobileModuleEnabled(f.settings, "todos"), false);
});
await test("both paid modules reject toggles without PRO and retain existing enabled data", async () => {
  for (const enabled of [true, false]) {
    const f = settingHost({ englishDiary: { enabled, legacyEnglishDirectories: ["kept"] }, lifestyle: { finance: { enabled } } }), before = plain(f.settings);
    for (const id of ["finance", "english-diary"]) for (const value of [true, false]) await assert.rejects(setMobileModuleEnabled(f.host, id, value), /PRO/u);
    assert.deepEqual(plain(f.settings), before); assert.equal(f.saves(), 0); assert.equal(f.finance.length, 0);
  }
});
await test("finance delegates to the existing service exactly once and does not create a second setting", async () => {
  const f = settingHost(); f.host.accountService = pro;
  await setMobileModuleEnabled(f.host, "finance", true);
  assert.deepEqual(f.finance, [["finance", true]]); assert.equal(f.saves(), 1); assert.equal(mobileModuleEnabled(f.settings, "finance"), true);
  assert.equal(f.settings.mobileUi.moduleEnabled, undefined);
  await setMobileModuleEnabled(f.host, "finance", false); assert.equal(mobileModuleEnabled(f.settings, "finance"), false);
});
await test("finance save failure retains the existing service rollback contract", async () => {
  const f = settingHost({}, async () => { throw new Error("disk"); }); f.host.accountService = pro;
  await assert.rejects(setMobileModuleEnabled(f.host, "finance", true), /disk/u); assert.equal(f.settings.lifestyle.finance.enabled, false);
});
await test("English uses unified PRO eligibility and preserves all existing configuration", async () => {
  const f = settingHost({ englishDiary: { enabled: false, legacyEnglishDirectories: ["kept"], englishDirectory: "English" } });
  f.host.accountService = { checkCapability: capability => capability === "finance.export" };
  await setMobileModuleEnabled(f.host, "english-diary", true);
  assert.equal(f.settings.englishDiary.enabled, true); assert.deepEqual(plain(f.settings.englishDiary.legacyEnglishDirectories), ["kept"]);
  assert.equal(f.settings.englishDiary.englishDirectory, "English"); assert.equal(f.saves(), 1); assert.equal(f.settings.mobileUi.moduleEnabled, undefined);
});
await test("failed English save restores enabled and paid eligibility is checked at queued execution", async () => {
  const f = settingHost({}, async () => { throw new Error("disk"); }); f.host.accountService = pro;
  await assert.rejects(setMobileModuleEnabled(f.host, "english-diary", true), /保存失败/u); assert.equal(f.settings.englishDiary.enabled, false);
  f.host.accountService = { checkCapability: () => false };
  await assert.rejects(setMobileModuleEnabled(f.host, "english-diary", true), /PRO/u); assert.equal(f.saves(), 1);
});
await test("unsupported mobile module toggles never mutate settings", async () => {
  const f = settingHost(), before = plain(f.settings);
  await assert.rejects(setMobileModuleEnabled(f.host, "pdf-reading", true), /暂不支持/u); assert.deepEqual(plain(f.settings), before);
});
async function policyFixture() {
  const vault = createHost(), f = settingHost({ review: { enabled: true } });
  const store = new MobileStore(vault.adapter, "plugin/mobile", "module-fixture"); await store.load();
  const policy = new MobileCapabilityPolicy({ store, settings: () => f.settings, agentId: "sol" });
  return { ...f, ...vault, store, policy };
}
await test("a live policy rejects the next module Skill after disabling and accepts it after reenable", async () => {
  const f = await policyFixture();
  for (const [id, skill] of [["knowledge-base", "obsidian-markdown"], ["journal", "daily-journal"], ["todos", "todo-operations"], ["review", "knowledge-review"]]) {
    f.policy.assertSkill(skill); const before = f.policy.signature();
    await setMobileModuleEnabled(f.host, id, false); assert.notEqual(f.policy.signature(), before);
    assert.throws(() => f.policy.assertSkill(skill), error => error.reason === "module_disabled");
    f.policy.assertTool("task_update");
    await setMobileModuleEnabled(f.host, id, true); f.policy.assertSkill(skill);
  }
});
await test("direct note tools obey disabled target modules including the real todo source", async () => {
  const f = await policyFixture();
  for (const [id, path] of [["knowledge-base", "wiki/source.md"], ["journal", "journal/source.md"], ["todos", "EchoInk/待办.md"], ["review", "outputs/reviews/source.md"]]) {
    f.policy.assertTool("note_read", { path }); f.policy.assertTool("note_create", { path });
    await setMobileModuleEnabled(f.host, id, false);
    for (const tool of ["note_read", "note_create"]) assert.throws(() => f.policy.assertTool(tool, { path }), error => error.reason === "module_disabled");
    await setMobileModuleEnabled(f.host, id, true);
  }
});
await test("existing review prerequisites remain required and memory stays independent", async () => {
  const f = await policyFixture(); f.settings.review.enabled = false;
  assert.equal(mobileModuleEnabled(f.settings, "review"), true);
  assert.throws(() => f.policy.assertSkill("knowledge-review"), error => error.reason === "module_disabled");
  for (const id of basic) await setMobileModuleEnabled(f.host, id, false);
  f.policy.assertTool("memory_read"); assert.equal(f.store.memoryEnabled, true);
  await f.store.setMemoryEnabled(false); assert.throws(() => f.policy.assertTool("memory_read"), error => error.reason === "memory_disabled");
});
async function workbenchFixture() {
  const now = new Date(); now.setDate(now.getDate() + (6 - now.getDay() + 7) % 7); now.setHours(19, 0, 0, 0);
  const date = localWorkbenchDate(now.getTime());
  const seed = { "EchoInk/待办.md": `- [ ] 今日任务\n  - 截止日期: ${date}\n`, "raw/a.md": "a", "raw/b.md": "b", "raw/c.md": "c",
    "plugin/workbench-records.json": JSON.stringify({ version: 1, inbox: {}, tasks: {}, journals: {}, reviews: {} }) };
  const vault = createHost(seed), f = settingHost({ review: { enabled: true }, lifestyle: { finance: { enabled: true } } }); f.host.accountService = pro;
  const store = new MobileStore(vault.adapter, "plugin/mobile", "module-workbench"); await store.load();
  await store.updateSession(store.session.id, task => { task.taskStatus = "completed"; task.messages = [{ role: "user", content: "已保存记录", timestamp: 1 }]; });
  const noSubscription = () => () => {}, todo = { subscribe: noSubscription, async readOnlySnapshot() {
    return { records: parseTodoMarkdown(vault.files.get("EchoInk/待办.md")).records, sourcePath: "EchoInk/待办.md", contentVersion: "fixture" };
  } };
  const services = { directory: "plugin/mobile", preferencesPath: "plugin/pi-agent-product-v1/knowledge/preferences.md", getTodoStore: () => todo, accountService: pro,
    knowledgePath: role => role, async readMaintenanceRecord() { throw new Error("record missing"); }, lifestyle: {
      store: { subscribe: noSubscription, async readFresh() { return structuredClone(EMPTY_LIFESTYLE_DATA); } },
      finance: { subscribeEntries: noSubscription, ledger: { entries: () => [], issues: () => [], async readSnapshots() { return []; } } }
    } };
  const workbench = new MobileWorkbenchService(vault.app, store, () => f.settings, () => services);
  return { ...f, ...vault, store, workbench, now: now.getTime(), seed };
}
await test("workbench opt-outs remove modules/signals and today's todos while retaining tasks and source files", async () => {
  const f = await workbenchFixture();
  try {
    const initial = await f.workbench.load(f.now), sessions = plain(f.store.state.sessions);
    for (const id of basic) assert.ok(initial.modules.includes(id));
    for (const id of [1, 7, 9, 10]) assert.ok(initial.signals.some(signal => signal.id === id), `missing enabled signal ${id}`);
    assert.equal(initial.todayTodos.length, 1);
    for (const id of basic) await setMobileModuleEnabled(f.host, id, false);
    const disabled = await f.workbench.load(f.now);
    for (const id of basic) { assert.ok(!disabled.modules.includes(id)); assert.ok(!disabled.signals.some(signal => signal.moduleId === id)); }
    assert.equal(disabled.todayTodos.length, 0); assert.deepEqual(plain(f.store.state.sessions), sessions);
    for (const [path, content] of Object.entries(f.seed)) assert.equal(f.files.get(path), content);
    await setMobileModuleEnabled(f.host, "todos", true); const restored = await f.workbench.load(f.now);
    assert.ok(restored.signals.some(signal => signal.id === 1)); assert.equal(restored.todayTodos.length, 1);
  } finally { f.workbench.dispose(); }
});
await test("stale workbench handoffs cannot bypass a newly disabled module", async () => {
  const f = await workbenchFixture();
  try {
    const signal = (await f.workbench.load()).signals.find(item => item.moduleId === "knowledge-base"); assert.ok(signal);
    const drafts = plain(f.store.state.newTaskDrafts);
    await setMobileModuleEnabled(f.host, "knowledge-base", false);
    await assert.rejects(f.workbench.handoff(signal), /提醒已更新/u); assert.deepEqual(plain(f.store.state.newTaskDrafts), drafts);
  } finally { f.workbench.dispose(); }
});
console.log(`OK ${passed} mobile module settings tests; all fixtures in memory; no model requests`);
