import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, FixtureTFile } from "../tests/mobile/host.mjs";

const built = await esbuild.build({ ...mobileBuildOptions(), entryPoints: undefined, stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
export {IPhoneSettingsPages} from './src/ui/iphone/settings-pages';
export {IPadSettings} from './src/ui/ipad/settings-pages';
export {createHomePage as phoneHome} from './src/ui/iphone/workbench-pages';
export {createHomePage as padHome} from './src/ui/ipad/workbench-pages';
export {createAgentFormPage as phoneAgent} from './src/ui/iphone/agent-form';
export {createAgentFormPage as padAgent} from './src/ui/ipad/agent-form';
export {openIPhoneTodos as phoneTodos} from './src/ui/iphone/todo-pages';
export {createTodoPage as padTodos} from './src/ui/ipad/todo-pages';
export {EchoInkTodoStore} from './src/home/todo-store';
export {MobileCapabilitiesService} from './src/mobile/capabilities';
export {loadMobileSettings} from './src/mobile/settings';
export {normalizeAgentRegistry} from './src/agents/registry';
` } });
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://settings-regression.invalid" });
const { document, Event } = dom.window, module = { exports: {} };
// Install host methods in the fixture's own realm before any viewport is constructed.
// Repeating this at fixture boundaries also prevents earlier scenarios leaking prototype changes.
function prepareHostPrototypes(win) {
  win.HTMLElement.prototype.createDiv = function (options = {}) { const node = this.ownerDocument.createElement("div"); node.className = options.cls ?? ""; this.append(node); return node; };
  win.Element.prototype.setAttr = function (name, value) { this.setAttribute(name, String(value)); };
  win.Element.prototype.toggleClass = function (name, enabled) { this.classList.toggle(name, enabled); };
}
prepareHostPrototypes(dom.window);
const asynchronousErrors = [];
dom.window.addEventListener("error", event => { asynchronousErrors.push(event.error ?? new Error(event.message)); });
vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document, console, Error,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  structuredClone, crypto: webcrypto, TextEncoder, TextDecoder, AbortController, URL, setTimeout, clearTimeout, atob, btoa,
  require(name) { assert.equal(name, "obsidian"); return { TFile: FixtureTFile, TFolder: class {}, Notice: class {}, Modal: class {}, Component: class {}, ItemView: class {}, PluginSettingTab: class {}, Platform: { isMobileApp: true, isDesktopApp: false },
    setIcon(node, icon) { node.dataset.icon = icon; } }; }
});
const api = module.exports, tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
function shell(root) {
  const pages = []; const mount = () => root.replaceChildren(...(pages.length ? [pages.at(-1).content, ...(pages.at(-1).footer ? [pages.at(-1).footer] : [])] : []));
  return { get activePageId() { return pages.at(-1)?.id; }, hasPage: id => pages.some(page => page.id === id),
    async push(page) { pages.push(page); mount(); return true; }, async back() { pages.pop()?.dispose?.(); mount(); return true; },
    async backTo() { return true; }, dispose() { while (pages.length) pages.pop().dispose?.(); root.remove(); } };
}
function button(root, label) { const node = [...root.querySelectorAll("button")].find(item => item.textContent.trim() === label); assert.ok(node, label); return node; }
function sourceFixture(endpoint) {
  const bytes = "- [ ] A task <!-- echoink-todo-id: shared -->\n  - 截止日期：2026-10-21\n";
  const memory = createHost({ "A.md": bytes, "B.md": bytes, "Skills/custom/SKILL.md": "Custom instructions" });
  memory.app.vault.process = async (file, change) => { const next = change(await memory.app.vault.read(file)); await memory.app.vault.modify(file, next); return next; };
  prepareHostPrototypes(document.defaultView);
  const settings = api.loadMobileSettings({}), root = document.createElement("main"); root.className = endpoint === "phone" ? "echoink-iphone" : "echoink-ipad"; document.body.append(root);
  assert.equal(typeof root.createDiv, "function", "the fixture must expose the host createDiv API before constructing a viewport");
  let source = "A.md";
  const owner = settings.agentRegistry.agents[0], host = { app: memory.app, settings: () => settings, store: { state: { sessions: [], newTaskDrafts: {}, page: { kind: "list", agentId: "sol" } } },
    runtime: { subscribe: () => () => {} }, workbench: { subscribe: () => () => {} }, async openModule() {}, async openLegacy() {}, async openSearch() {} };
  const todoHost = { app: memory.app, settings, registerEvent() {}, async saveSettings() {}, getTodoStore: () => store };
  const store = new api.EchoInkTodoStore(todoHost, () => source);
  const port = { async read() { return { ...await store.readOnlySnapshot(), categories: [], projects: [], completion: { total: 0, today: 0 } }; }, subscribe: () => () => {},
    add: (...args) => store.addTodo(...args), update: (...args) => store.updateTodo(...args), remove: (...args) => store.removeTodo(...args), toggle: (target, done, version, path) => store.updateTodo(target, { done }, version, path) };
  host.services = { getTodoStore: () => store, subscribeIdentity: () => () => {}, modules: { todos: port, owner: () => owner } };
  const errors = [], pages = shell(root), ctx = { root, document, host, shell: pages, navigate: async () => {}, error: error => errors.push(error) };
  return { ...memory, settings, store, host, ctx, root, pages, errors, bytes,
    async switchSource() { await store.changeSource("A.md", async () => { source = "B.md"; }); },
    close() { pages.dispose(); store.dispose(); } };
}

try {
  if (!process.argv.includes("--review-only")) for (const endpoint of ["phone", "pad"]) {
    const f = sourceFixture(endpoint);
    try {
      if (endpoint === "phone") await api.phoneTodos(f.ctx); else await f.pages.push(api.padTodos(f.ctx)); await tick();
      const main = endpoint === "phone" ? f.root.querySelector(".ip-todo-main") : [...f.root.querySelectorAll(".pd-todo-table button")].find(item => item.textContent.trim() === "A task"); assert.ok(main); main.click(); await tick();
      const title = f.root.querySelector('[aria-label="事项"]'); title.value = "Old source draft"; title.dispatchEvent(new Event("input"));
      await f.switchSource();
      if (endpoint === "phone") { button(f.root, "重新读取").click(); await tick(); assert.match(f.root.textContent, /数据文件已切换/); }
      button(f.root, "保存").click(); await tick(); assert.equal(title.value, "Old source draft"); assert.ok(f.root.contains(title));
      assert.match(f.root.textContent, /数据文件已切换/); assert.equal(f.files.get("A.md"), f.bytes); assert.equal(f.files.get("B.md"), f.bytes);
      console.log(`PASS ${endpoint} editor freezes source across reload/save and retains draft`);
    } finally { f.close(); }

    const home = sourceFixture(endpoint);
    try {
      const read = await home.store.readOnlySnapshot();
      home.host.workbench.load = async () => ({ generatedAt: 1, signals: [], todayTodos: read.records, todoSource: { path: read.sourcePath, version: read.contentVersion }, modules: ["todos"], issues: [] });
      const page = api[endpoint === "phone" ? "phoneHome" : "padHome"](home.ctx); await home.pages.push(page); await tick();
      const check = home.root.querySelector('input[type="checkbox"]'); assert.ok(check);
      const switching = home.switchSource(); check.checked = true; check.dispatchEvent(new Event("change")); await switching; await tick();
      assert.equal(home.files.get("A.md"), home.bytes); assert.equal(home.files.get("B.md"), home.bytes); assert.ok(home.errors.some(error => /数据文件已切换/.test(String(error)))); assert.equal(check.checked, false);
      console.log(`PASS ${endpoint} home completion carries frozen source/version into the real queue`);
    } finally { home.close(); }

    const f2 = sourceFixture(endpoint);
    try {
      const { settings } = f2; settings.agentRegistry.agents.push({ id: "other", name: "Other", avatar: { kind: "default" }, position: "", styleId: "execution", capabilityIds: ["knowledge", "skill:custom"] });
      settings.resources.catalog.push({ id: "custom", kind: "skill", source: "manual", enabled: true, name: "Mine", description: "Custom", bridgeMode: "prompt-only", contentPath: "Skills/custom/SKILL.md" });
      let version = "v1"; const agents = { async snapshot() { return { registry: structuredClone(settings.agentRegistry), version }; }, async update(change, expected) { assert.equal(expected, version); const next = structuredClone(settings.agentRegistry); change(next); settings.agentRegistry = api.normalizeAgentRegistry(next); version += "x"; return this.snapshot(); } };
      Object.assign(f2.host, { agents }); f2.host.services.refreshAgentIdentity = async () => {};
      const capabilities = new api.MobileCapabilitiesService({ adapter: f2.adapter, settings: () => settings, saveSettings: async () => {}, agents, policy() { throw Error("No model calls"); } });
      const before = await capabilities.readSkill("custom"); assert.equal(before.agents.find(agent => agent.id === "other").allowed, true);
      const form = api[endpoint === "phone" ? "phoneAgent" : "padAgent"](f2.ctx, "other"); await f2.pages.push(form); await tick();
      const choice = [...f2.root.querySelectorAll("label")].find(label => label.textContent.trim() === "Mine").querySelector("input"); assert.equal(choice.checked, true); choice.checked = false; choice.dispatchEvent(new Event("change")); button(f2.root, "保存").click(); await tick();
      const denied = await capabilities.readSkill("custom"); assert.equal(denied.agents.find(agent => agent.id === "other").allowed, false);
      const agent = settings.agentRegistry.agents.find(agent => agent.id === "other"); assert.ok(agent.capabilityIds.includes("knowledge")); assert.ok(!agent.capabilityIds.includes("skill:custom")); assert.ok(agent.disabledCapabilityIds.includes("vault-skill:custom"));
      await capabilities.saveSkillAgents("custom", ["other"], denied.agentsVersion);
      const granted = settings.agentRegistry.agents.find(agent => agent.id === "other"); assert.ok(granted.capabilityIds.includes("vault-skill:custom")); assert.ok(!granted.disabledCapabilityIds.includes("vault-skill:custom"));
      const again = api[endpoint === "phone" ? "phoneAgent" : "padAgent"](f2.ctx, "other"); await f2.pages.push(again); await tick(); assert.equal([...f2.root.querySelectorAll("label")].find(label => label.textContent.trim() === "Mine").querySelector("input").checked, true);
      console.log(`PASS ${endpoint} custom Skill detail/editor share canonical grants, clear aliases and preserve module rights`);
    } finally { f2.close(); }
  }
  for (const endpoint of ["phone", "pad"]) {
    const f = sourceFixture(endpoint); let controller;
    try {
      let failed = true, saveCalls = 0, legacyCalls = 0, disk;
      f.host.agents = { async snapshot() { return { registry: structuredClone(f.settings.agentRegistry), version: "v1" }; } };
      f.host.saveSettings = async () => { saveCalls++; if (failed) throw new Error("配置保存失败"); disk = structuredClone(f.settings.mobileUi.reports); };
      f.settings.mobileUi.reports.agent.future = "preserve";
      const original = structuredClone(f.settings.mobileUi.reports), legacy = async () => { legacyCalls++; throw Error("Review must not use the old mixed page"); };
      if (endpoint === "phone") { controller = new api.IPhoneSettingsPages(f.ctx, legacy); await controller.open("mods"); }
      else { controller = new api.IPadSettings(f.root, f.host); await controller.mount("mods"); }
      const active = () => endpoint === "phone" ? f.root : f.root.querySelector('.echoink-ipad-page:not([hidden])');
      const activeId = () => endpoint === "phone" ? f.pages.activePageId : controller.shell.activePageId;
      button(active(), "复盘").click(); await tick(); assert.equal(activeId(), `${endpoint === "phone" ? "iphone" : "ipad"}-settings-review`);
      assert.match(active().textContent, /移动端仅保存配置，不会自动生成周报/);
      assert.doesNotMatch(active().textContent, /记忆|归档|立即执行|生成周报按钮/); assert.equal(f.root.querySelector(".em-sheet"), null);
      assert.equal(active().querySelectorAll("button.pd-settings-row,button.ip-settings-row").length, 2);
      button(active(), "Agent 周报").click(); await tick();
      const change = (label, value) => { const select = active().querySelector(`select[aria-label="${label}"]`); assert.ok(select, label); select.value = value; select.dispatchEvent(new Event("change")); return select; };
      const period = change("统计周期", "last-week"), schedule = change("执行周期", "monthly");
      assert.deepEqual([...period.options].map(option => option.value), ["7d", "last-week", "30d"]); assert.deepEqual([...schedule.options].map(option => option.value), ["manual", "weekly", "monthly"]);
      button(active(), "保存").click(); await tick(); assert.equal(saveCalls, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.settings.mobileUi.reports)), original); assert.equal(period.value, "last-week"); assert.equal(schedule.value, "monthly"); assert.match(active().textContent, /配置保存失败/);
      failed = false; button(active(), "保存").click(); await tick(); assert.equal(activeId(), `${endpoint === "phone" ? "iphone" : "ipad"}-settings-review`); assert.equal(disk.agent.period, "last-week"); assert.equal(disk.agent.schedule, "monthly"); assert.equal(disk.agent.future, "preserve"); assert.deepEqual(disk.knowledge, original.knowledge);
      button(active(), "Agent 周报").click(); await tick(); assert.equal(active().querySelector('select[aria-label="统计周期"]').value, "last-week"); change("统计周期", "30d"); button(active(), "取消").click(); await tick(); assert.equal(saveCalls, 2); assert.equal(f.settings.mobileUi.reports.agent.period, "last-week");
      button(active(), "知识库周报").click(); await tick(); change("统计周期", "30d"); change("执行周期", "weekly"); button(active(), "保存").click(); await tick(); assert.equal(disk.knowledge.period, "30d"); assert.equal(disk.knowledge.schedule, "weekly"); assert.equal(disk.agent.period, "last-week"); assert.equal(legacyCalls, 0);
      assert.equal(f.root.querySelector(".em-sheet"), null);
      console.log(`PASS ${endpoint} review grouped routes, real configuration persistence/rollback/cancel, independent report kinds and no legacy sheet or generation`);
    } finally { if (endpoint === "pad") controller?.dispose(); f.close(); }
  }
  // Surface errors queued by viewport resize/frame callbacks before destroying their window.
  await new Promise(resolve => dom.window.requestAnimationFrame(resolve));
  await tick();
  assert.deepEqual(asynchronousErrors, [], "viewport and host callbacks must finish without asynchronous errors");
} finally { dom.window.close(); }
