import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, answer, FixtureTFile } from "../tests/mobile/host.mjs";

const build = await esbuild.build(mobileBuildOptions("tests/mobile/entry.ts"));
const dom = new JSDOM("<!doctype html><body><div id=app></div>", { pretendToBeVisual: true });
const module = { exports: {} };
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, module, exports: module.exports, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, structuredClone, crypto: webcrypto, console, require: id => { if (id !== "obsidian") throw new Error(`Node import on mobile: ${id}`); return { setIcon() {}, Modal: class {}, ItemView: class {}, TFile: FixtureTFile, Notice: class {} }; } };
vm.runInNewContext(build.outputFiles[0].text, globals);
const { MobileStore, MobileRuntime, mobileTools, loadMobileSettings, mobileProvider, mobileModel, MobileUI, MobileWorkspace, MobileServices, HomeActivityCore, mobilePluginDataRoot } = module.exports;
const memoryArgs = { kind: "view", title: "解释偏好", content: "解释技术问题时先说结论。", recallWhen: "解释技术问题", basis: "explicit" };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }
function settings(protocol = "openai-completions") {
  const provider = mobileProvider("custom"); Object.assign(provider, { apiProtocol: protocol, name: "Fixture", baseUrl: "https://provider.example/v1", apiKey: "fixture-not-a-real-key", models: [mobileModel("fixture-model")], defaultModelId: "fixture-model" });
  return loadMobileSettings({ apiProviders: [provider], activeApiProviderId: provider.id, defaultModel: "fixture-model", desktopUnknown: { keep: true }, providerMode: "api" });
}
async function setup(protocol, request) {
  const host = createHost(); const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load(); store.session.notePath = "笔记/来源.md";
  const config = settings(protocol); const runtime = new MobileRuntime(host.app, store, () => config, request);
  return { ...host, store, config, runtime };
}

for (const protocol of ["openai-completions", "openai-responses"]) await test(`${protocol}: real Agent read → memory + Markdown tools → answer; reopen and recall`, async () => {
  let requests = 0;
  const state = await setup(protocol, async request => {
    const body = JSON.parse(request.body);
    assert.equal(body.stream, false); assert.equal(body.model, "fixture-model");
    assert.equal(request.url, `https://provider.example/v1/${protocol === "openai-responses" ? "responses" : "chat/completions"}`);
    assert.ok(body.tools.some(tool => (tool.name ?? tool.function?.name) === "memory_write"));
    const history = body.input ?? body.messages;
    if (protocol === "openai-responses") for (const item of history) if (item.role === "assistant") assert.equal(typeof item.content, "string");
    if (requests++ === 0) return answer(protocol, "", [["read_1", "note_read", {}]]);
    if (requests === 2) {
      assert.ok(JSON.stringify(history).includes("先完成手机本地问答"));
      return answer(protocol, "", [["memory_1", "memory_write", memoryArgs], ["save_1", "note_create", { path: "输出/移动记录.md", content: "# 移动记录\n\n先完成手机本地问答。" }]]);
    }
    assert.ok(JSON.stringify(history).includes('save_1')); assert.ok(JSON.stringify(history).includes("saved"));
    return answer(protocol, "已经根据笔记整理，并保存到输出/移动记录.md。");
  });
  await state.runtime.send("读取引用笔记并生成 Markdown 保存；记住我喜欢先说结论。");
  assert.equal(requests, 3); assert.equal(state.runtime.error, ""); assert.equal(state.runtime.busy, false);
  assert.ok(state.files.get("输出/移动记录.md").startsWith("# 移动记录"));
  assert.equal(state.store.state.memories.length, 1);
  assert.equal(state.store.session.messages.filter(m => m.role === "toolResult").length, 3);
  assert.equal(state.store.session.messages.at(-1).usage.totalTokens, 26);
  for (const id of ["read_1", "memory_1", "save_1"]) assert.equal(typeof state.store.session.tools[id].elapsedMs, "number");
  await state.runtime.send("继续说明"); assert.equal(requests, 4);
  const reopened = new MobileStore(state.adapter, "plugin/mobile"); await reopened.load();
  assert.equal(reopened.session.messages.length, state.store.session.messages.length);
  assert.equal(reopened.state.memories[0].content, memoryArgs.content);
  await reopened.createSession(); let recallCalls = 0;
  const recall = new MobileRuntime(state.app, reopened, () => state.config, async request => {
    const body = JSON.parse(request.body);
    if (recallCalls++ === 0) return answer(protocol, "", [["recall_1", "memory_search", { query: "解释" }]]);
    assert.ok(JSON.stringify(body.input ?? body.messages).includes("先说结论"));
    return answer(protocol, "你喜欢解释技术问题时先说结论。");
  });
  await recall.send("我喜欢怎样解释技术问题？"); assert.equal(recallCalls, 2);
  reopened.state.memoryEnabled = false; await reopened.createSession();
  const disabled = new MobileRuntime(state.app, reopened, () => state.config, async request => {
    const body = JSON.parse(request.body);
    assert.ok(body.tools.every(tool => !(tool.name ?? tool.function?.name).startsWith("memory_")));
    assert.ok(!JSON.stringify(body).includes(memoryArgs.content)); return answer(protocol, "长期记忆已关闭。");
  });
  await disabled.send("我有什么偏好？"); assert.equal(reopened.state.memories.length, 1);
});

await test("stop settles immediately; late response cannot write or request again", async () => {
  let resolve; let calls = 0; const pending = new Promise(done => { resolve = done; });
  const state = await setup("openai-completions", () => { calls++; return pending; });
  const running = state.runtime.send("请保存笔记");
  while (!calls) await new Promise(done => setTimeout(done, 1));
  state.runtime.stop();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("stop failed to settle")), 1000))]);
  resolve(answer("openai-completions", "", [["late", "note_create", { path: "迟到.md", content: "must not write" }]]));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(calls, 1); assert.ok(!state.files.has("迟到.md")); assert.equal(state.runtime.busy, false);
  assert.equal(state.store.session.messages.at(-1).stopReason, "aborted");
  assert.equal(state.runtime.error, "");
});

await test("read-only, duplicate paths and Vault boundary retain original notes", async () => {
  let calls = 0;
  const state = await setup("openai-completions", async request => {
    if (calls++ === 0) return answer("openai-completions", "", [["readonly", "note_create", { path: "不应创建.md", content: "x" }]]);
    assert.ok(request.body.includes("只读权限")); return answer("openai-completions", "当前只读，未保存。");
  });
  state.store.state.permission = "read-only"; await state.runtime.send("保存一篇笔记"); assert.ok(!state.files.has("不应创建.md"));
  state.store.state.permission = "workspace-write";
  const create = mobileTools(state.app, state.store, () => "").find(t => t.name === "note_create");
  await assert.rejects(create.execute("duplicate", { path: "笔记/来源.md", content: "overwrite" }), /同名/u);
  for (const path of ["../outside.md", "/outside.md", "C:\\outside.md", ".obsidian/private.md", "a/../outside.md"]) await assert.rejects(create.execute("escape", { path, content: "x" }), /相对路径/u);
  assert.equal(state.files.get("笔记/来源.md"), "项目决定：先完成手机本地问答。");
});

await test("Provider error is visible and redacted; same session can continue", async () => {
  let calls = 0;
  const state = await setup("openai-completions", async () => {
    calls++; if (calls === 1) return { status: 401, json: { error: { message: "invalid fixture-not-a-real-key" } } };
    return answer("openai-completions", "可以继续。");
  });
  await state.runtime.send("问题"); assert.match(state.runtime.error, /401/u); assert.ok(!state.runtime.error.includes("fixture-not-a-real-key"));
  await state.runtime.send("再试一次"); assert.equal(state.runtime.error, ""); assert.equal(state.store.session.messages.at(-1).content[0].text, "可以继续。");
});

await test("queued snapshots preserve the latest draft and independent settings", async () => {
  const state = await setup("openai-completions", async () => answer("openai-completions", "ok"));
  state.store.session.draft = "old"; const first = state.store.save(); state.store.session.draft = "new"; const last = state.store.save();
  await Promise.all([first, last]); const reopened = new MobileStore(state.adapter, "plugin/mobile"); await reopened.load(); assert.equal(reopened.session.draft, "new");
  const loaded = loadMobileSettings({ desktopUnknown: { keep: true }, apiProviders: [], other: [1, 2] });
  loaded.apiProviders.push(mobileProvider("deepseek")); assert.equal(loaded.desktopUnknown.keep, true); assert.equal(loaded.other.join(","), "1,2");
  const tools = mobileTools(state.app, state.store, () => ""); state.store.state.memoryEnabled = false;
  await assert.rejects(tools.find(t => t.name === "memory_write").execute("disabled", memoryArgs), /已关闭/u);
  assert.equal(state.store.state.memories.length, 0);
});

await test("native right chat coexists with outline; Home and protected central notes; serialized reuse", async () => {
  const rootSplit = {}, rightSplit = {}; const leaves = []; let recent; let rightCreates = 0;
  const leaf = (type, path, root = rootSplit, pinned = false) => {
    const state = { type, state: { file: path }, pinned };
    const item = { view: { getViewType: () => state.type }, getViewState: () => state, getRoot: () => root,
      async setViewState(next) { item.sets++; Object.assign(state, next); }, sets: 0,
      async openFile(file) { state.type = "markdown"; state.state = { file: file.path }; }, detach() { leaves.splice(leaves.indexOf(item), 1); } }; leaves.push(item); return item;
  };
  const workspace = { rootSplit, rightSplit, iterateAllLeaves: callback => leaves.forEach(callback), getLeavesOfType: type => leaves.filter(l => l.view.getViewType() === type), getLeaf: type => { assert.equal(type, "tab"); return leaf("empty"); }, getRightLeaf: split => { assert.equal(split, false); rightCreates++; return leaf("empty", undefined, rightSplit); }, async revealLeaf(item) { recent = item; } };
  const original = leaf("markdown", "source.md"); const outline = leaf("outline", undefined, rightSplit); const legacy = leaf("echoink-mobile");
  const navigation = new MobileWorkspace(workspace, true); await Promise.all([navigation.open(), navigation.open(), navigation.openHome()]);
  const chat = leaves.find(item => item.view.getViewType() === "echoink-mobile"); assert.equal(chat.getRoot(), rightSplit); assert.equal(rightCreates, 1); assert.equal(chat.sets, 1); assert.ok(leaves.includes(outline)); assert.ok(!leaves.includes(legacy));
  assert.equal(recent.view.getViewType(), "codex-echoink-home"); const home = recent; await navigation.openHome(); assert.equal(recent, home); assert.equal(home.sets, 1);
  await navigation.openNote({ path: "source.md" }); assert.equal(recent, original); await navigation.openNote({ path: "other.md" }); assert.equal(recent, original);
  original.getViewState().pinned = true; await navigation.openNote({ path: "third.md" }); assert.notEqual(recent, original); assert.equal(original.getViewState().state.file, "other.md");
  const reader = recent; reader.getViewState().state.file = "unrelated.md"; await Promise.all([navigation.openNote({ path: "fourth.md" }), navigation.openNote({ path: "fourth.md" })]); assert.equal(reader.getViewState().state.file, "unrelated.md"); assert.equal(leaves.filter(item => item.getViewState().state?.file === "fourth.md").length, 1);
  await navigation.open(); assert.equal(recent, chat); assert.ok(leaves.includes(home)); assert.ok(leaves.includes(outline)); assert.equal(rightCreates, 1);
  const phone = new MobileWorkspace(workspace, false); await phone.open(); assert.equal(rightCreates, 1);
});
await test("Vault services: shared preferences, actual knowledge, Todo persistence and real activity", async () => {
  const host = createHost({ "笔记/来源.md": "note", "Wiki/主题/知识.md": "# knowledge", ".echoink/shared-user/USER.md": "# Real profile" });
  const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load(); const config = settings();
  const services = new MobileServices({ app: host.app, settings: config, store, runtime: { busy: false }, navigation: {}, registerEvent() {}, async saveSettings() {}, async showPage() {} }, "plugin/mobile"); await services.initialize();
  assert.equal(services.knowledgeFiles("wiki").length, 1); assert.equal(await services.readProfile("user"), "# Real profile"); assert.equal(await services.readProfile("agent"), null); assert.equal(services.preferencesPath, "plugin/pi-agent-product-v1/knowledge/preferences.md");
  assert.ok(services.defaultPreferences.includes("关注维度")); assert.ok((await services.context()).includes(services.defaultPreferences));
  store.session.skillId = "two-layer-explanation"; assert.ok((await services.context()).includes(await services.requireAvailableEchoInkSkill("two-layer-explanation"))); config.resources.legacyEnabledOverrides = { "two-layer-explanation": false }; await assert.rejects(services.context(), /停用/u); delete store.session.skillId;
  await services.savePreferences("custom", null); assert.equal(await services.readPreferences(), "custom"); await assert.rejects(services.savePreferences("stale", null), /其他页面/u); await services.restorePreferences("custom"); assert.equal(await services.readPreferences(), null); assert.equal(host.files.get(services.preferencesPath + ".mobile-backup"), "custom");
  const todo = services.getTodoStore(); await todo.addTodo({ title: "真实待办", dueDate: "2026-10-11", categoryName: "工作", people: "" }); assert.equal(todo.snapshot()[0].title, "真实待办"); await todo.toggleDone(todo.snapshot()[0], true); assert.equal(todo.snapshot()[0].done, true); assert.ok([...host.files.values()].some(text => text.includes("真实待办")));
  await services.dispose(); assert.ok(host.files.has("plugin/mobile/home-activity.json"));
});
await test("concurrent context preparation issues one provider request", async () => {
  const state = await setup("openai-completions", async () => { requests++; return answer("openai-completions", "ok"); }); let requests = 0;
  const runtime = new MobileRuntime(state.app, state.store, () => state.config, async () => { requests++; return answer("openai-completions", "ok"); }, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return "real context"; });
  await Promise.all([runtime.send("same prompt"), runtime.send("same prompt")]); assert.equal(requests, 1);
});
await test("stop during context preparation preserves draft and never reaches provider", async () => {
  const state = await setup("openai-completions", async () => answer("openai-completions", "ok")); state.store.session.draft = "pending draft"; let release; let requests = 0;
  const runtime = new MobileRuntime(state.app, state.store, () => state.config, async () => { requests++; return answer("openai-completions", "ok"); }, () => new Promise(resolve => { release = resolve; })); const pending = runtime.send("pending draft"); runtime.stop(); release("context"); await pending; assert.equal(requests, 0); assert.equal(state.store.session.draft, "pending draft"); assert.equal(runtime.busy, false);
});
await test("desktop legacy data root is selected without merging stores", async () => {
  const host = createHost({ ".obsidian/plugins/custom/plugins/codex-echoink/pi-agent-product-v1/knowledge/preferences.md": "legacy", "custom/plugins/codex-echoink/pi-agent-product-v1/knowledge/preferences.md": "new" });
  assert.equal(await mobilePluginDataRoot(host.adapter, "custom/plugins/codex-echoink", "codex-echoink", "custom/plugins/codex-echoink"), ".obsidian/plugins/custom/plugins/codex-echoink");
  assert.equal(await mobilePluginDataRoot(host.adapter, ".obsidian/plugins/codex-echoink", "codex-echoink"), ".obsidian/plugins/codex-echoink");
  host.files.set(".obsidian/plugins/codex-echoink/pi-agent-product-v1/knowledge/preferences.md", "legacy without manifest.dir");
  assert.equal(await mobilePluginDataRoot(host.adapter, "custom/plugins/codex-echoink", "codex-echoink"), ".obsidian/plugins/codex-echoink");
});
await test("mobile default preferences match desktop literal", async () => {
  const desktop = await fs.readFile("src/knowledge-base/knowledge-maintenance-preferences.ts", "utf8"); const mobile = await fs.readFile("src/core/knowledge-preferences-default.ts", "utf8"); const literal = text => text.slice(text.indexOf("export const ECHOINK_DEFAULT_"), text.indexOf('].join("\\n");') + 13).trim(); assert.ok(literal(desktop).length > 100); assert.equal(literal(desktop), literal(mobile));
});

await test("shared activity extraction preserves desktop history, rename, delete and persistence", async () => {
  const originalSource = await fs.readFile("tests/mobile/desktop-activity-baseline.ts", "utf8");
  const compiled = await esbuild.transform(originalSource, { loader: "ts", format: "cjs" }); const original = { exports: {} }; let beforeBytes = null, afterBytes = null;
  vm.runInNewContext(compiled.code, { module: original, exports: original.exports, setTimeout, clearTimeout, console, require(name) { if (name === "node:fs/promises") return { readFile: async () => { if (beforeBytes === null) throw { code: "ENOENT" }; return beforeBytes; } }; if (name === "../knowledge-base/utils") return { isMissingPathError: error => error.code === "ENOENT", writeFileAtomic: async (_path, bytes) => { beforeBytes = bytes; } }; throw new Error(name); } });
  let now = Date.now(); const before = new original.exports.HomeActivityService("fixture", () => now); const after = new HomeActivityCore({ read: async () => afterBytes, write: async bytes => { afterBytes = bytes; } }, () => now);
  await before.initialize(); await after.initialize();
  for (const service of [before, after]) { service.restoreOpen("Wiki/one.md"); service.open(null); service.open("Wiki/one.md"); service.record("Wiki/two.md", "created"); service.record("Wiki/two.md", "modified"); service.rename("Wiki/two.md", "Wiki/renamed.md"); service.record(".private/no.md", "created"); service.delete("Wiki/one.md"); await service.flush(); }
  assert.equal(JSON.stringify(after.snapshot()), JSON.stringify(before.snapshot())); assert.equal(afterBytes, beforeBytes); await before.dispose(); await after.dispose();
});

await test("formal DOM: sheet preserves draft node and focus, seven settings and local save", async () => {
  const host = createHost(); host.app.workspace.containerEl = dom.window.document.body;
  const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load(); const config = settings(); let saved = "";
  const runtime = new MobileRuntime(host.app, store, () => config, async () => answer("openai-completions", "ok"));
  const services = new MobileServices({ app: host.app, settings: config, store, runtime, navigation: {}, registerEvent() {}, showPage: async () => {}, saveSettings: async () => {} }, "plugin/mobile"); await services.initialize();
  const root = dom.window.document.querySelector("#app"); root.style.setProperty("--view-bottom-spacing", "68px");
  const ui = new MobileUI(root, { app: host.app, store, runtime, services, settings: () => config, saveSettings: async () => { saved = JSON.stringify(config); }, openNote: async () => {}, beginRender() {}, renderMarkdown(text, element) { element.textContent = text; } }); ui.mount();
  const button = text => [...root.querySelectorAll("button")].find(element => element.textContent.trim() === text || element.getAttribute("aria-label") === text);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const input = root.querySelector(".em-input"); input.value = "保留中文草稿"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.focus();
  button("引用笔记").click(); const dialog = root.querySelector('[role="dialog"]'); assert.ok(dialog); assert.ok(root.querySelector(".em-header").inert); dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })); assert.equal(dom.window.document.activeElement, dialog.querySelector("button"));
  button("当前笔记笔记/来源.md").click(); await settle(); assert.equal(root.querySelector(".em-input"), input); assert.equal(input.value, "保留中文草稿"); assert.equal(dom.window.document.activeElement, input); assert.equal(store.session.notePath, "笔记/来源.md");
  const viewport = new dom.window.EventTarget(); viewport.scale = 1; viewport.height = 552; viewport.offsetTop = 0; Object.defineProperty(dom.window, "visualViewport", { value: viewport, configurable: true }); root.getBoundingClientRect = () => ({ bottom: 852 });
  dom.window.dispatchEvent(new dom.window.Event("resize")); await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(root.style.getPropertyValue("--em-viewport-occlusion"), "300px"); assert.equal(root.querySelector(".em-input"), input); assert.equal(root.style.getPropertyValue("--view-bottom-spacing"), "68px");
  button("设置").click(); assert.equal(root.querySelectorAll(".em-body>.em-row").length, 7); button("布局与外观").click(); const large = root.querySelector('[aria-label="放大正文"]'); large.checked = true; large.dispatchEvent(new dom.window.Event("change")); await settle(); assert.equal(loadMobileSettings(JSON.parse(saved)).mobileUi.largeText, true);
  store.state.memories.push({ id: "edit-fixture", kind: "view", title: "待修正记忆", content: "原文", recallWhen: "解释", basis: "explicit", date: new Date().toISOString(), revision: 1, contentOrigin: "user_edit" });
  ui.showPage("memories"); [...root.querySelectorAll(".em-row")].find(row => row.textContent.includes("待修正记忆")).click(); button("编辑").click(); const editor = root.querySelector('[aria-label="记忆内容"]'); editor.value = "修正后正文"; editor.dispatchEvent(new dom.window.Event("input")); button("预览修改").click(); assert.equal(store.state.memories.at(-1).content, "原文"); assert.ok(root.querySelector('[role="dialog"]').textContent.includes("修改前")); button("应用修改").click(); await settle(); assert.equal(store.state.memories.at(-1).content, "修正后正文"); assert.equal(store.state.memories.at(-1).revision, 2);
  const oldId = store.session.id; ui.showPage("review"); button("归档当前会话").click(); await settle(); assert.ok(store.state.sessions.find(session => session.id === oldId).archivedAt); root.querySelector(".em-archive summary").click(); await settle(); button("恢复会话").click(); await settle(); assert.equal(store.session.id, oldId); assert.equal(store.session.archivedAt, undefined);
  ui.destroy(); await services.dispose();
});

for (const platform of [{ isMobileApp: true, isMobile: true, isTablet: false }, { isMobileApp: true, isMobile: false, isTablet: true }]) await test(`production mobile bundle initializes without Node: ${platform.isTablet ? "tablet desktop UI" : "phone"}`, async () => {
  const code = await fs.readFile("dist/main.js", "utf8"); const host = createHost(); const imported = []; const commands = [];
  class Plugin {
    constructor() { this.app = host.app; this.manifest = { id: "codex-echoink", dir: "plugin" }; }
    async loadData() { return { desktopUnknown: { keep: true } }; }
    async saveData() {}
    registerEvent() {}
    registerView(type, factory) { this.factory = factory; }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command.id); }
  }
  class Component {}
  const exports = { exports: {} };
  const context = vm.createContext({ module: exports, exports: exports.exports, URL, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: webcrypto, console, setTimeout, clearTimeout,
    require(id) { imported.push(id); if (id !== "obsidian") throw new Error(`Node loaded on mobile: ${id}`); return { Platform: platform, Plugin, ItemView: class {}, Component, Modal: class {}, TFile: FixtureTFile, Notice: class {}, requestUrl() { throw new Error("startup requested provider"); } }; }
  });
  vm.runInContext(code, context); const MobilePlugin = exports.exports.default ?? exports.exports; const plugin = new MobilePlugin(); await plugin.onload();
  assert.ok(commands.includes("open-echoink-mobile")); assert.ok(plugin.store); assert.equal(plugin.settings.apiProviders.length, 0);
  assert.ok(imported.every(id => id === "obsidian")); assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
});
console.log(`${passed} mobile integration checks passed (real Pi Agent; Provider and Obsidian API fixtures).`);
