import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { zipSync, strToU8 } from "fflate";
import { createHash, webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, answer, FixtureTFile } from "../tests/mobile/host.mjs";

const build = await esbuild.build(mobileBuildOptions("tests/mobile/entry.ts"));
const dom = new JSDOM("<!doctype html><body><div id=app></div>", { pretendToBeVisual: true });
dom.window.HTMLElement.prototype.setAttr = function (name, value) { this.setAttribute(name, String(value)); };
dom.window.HTMLElement.prototype.toggleClass = function (name, enabled) { this.classList.toggle(name, enabled); };
const module = { exports: {} };
const obsidian = { exports: {} };
const hostBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
vm.runInNewContext(hostBuild.outputFiles[0].text, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, DOMParser: dom.window.DOMParser, module: obsidian, exports: obsidian.exports, console });
const globals = { window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, MutationObserver: dom.window.MutationObserver, HTMLElement: dom.window.HTMLElement, module, exports: module.exports, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, structuredClone, crypto: webcrypto, btoa, atob, Blob, FormData, Response, console, require: id => { if (id !== "obsidian") throw new Error(`Node import on mobile: ${id}`); return { ...obsidian.exports, TFile: FixtureTFile }; } };
vm.runInNewContext(build.outputFiles[0].text, globals);
const { MobileStore, MobileRuntime, mobileTools, loadMobileSettings, mobileProvider, mobileModel, mobilePresets, MobileUI, MobileWorkspace, MobileServices, HomeActivityCore, mobilePluginDataRoot, SETTINGS_TAB_ICONS, renderAnimatedSettingsTabIcon, createMobileMembershipStorage, AccountService, MembershipApiError, keyHash, mobileLifestyleStore, mobileGenerateText, readFinanceBill, sha256Hex, FinanceWorkspace, EchoInkMobilePlugin, mobileWorkspaceFixture } = module.exports;
const memoryArgs = { kind: "view", title: "解释偏好", content: "解释技术问题时先说结论。", recallWhen: "解释技术问题", basis: "explicit" };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
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
  for (const manifestDir of [undefined, "custom/plugins/codex-echoink"]) {
    const oldRoot = `.obsidian/plugins/${manifestDir ?? "codex-echoink"}`;
    const currentRoot = "custom/plugins/codex-echoink";
    const financeOnly = createHost({ [`${oldRoot}/lifestyle.json`]: JSON.stringify({ budgets: [{ totalCents: 12345 }], goals: [{ id: "old-goal" }], reports: [{ id: "old-report" }] }) });
    assert.equal(await mobilePluginDataRoot(financeOnly.adapter, currentRoot, "codex-echoink", manifestDir), oldRoot);
    financeOnly.files.set(`${currentRoot}/lifestyle.json`, "new-finance-preserved");
    assert.equal(await mobilePluginDataRoot(financeOnly.adapter, currentRoot, "codex-echoink", manifestDir), oldRoot, "do not merge two finance roots");
    financeOnly.files.set(`${oldRoot}/lifestyle.json`, "");
    assert.equal(await mobilePluginDataRoot(financeOnly.adapter, currentRoot, "codex-echoink", manifestDir), currentRoot, "empty finance file is not durable state");
    assert.equal(financeOnly.files.get(`${currentRoot}/lifestyle.json`), "new-finance-preserved");
  }
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

await test("formal DOM: sheet preserves draft node and focus, eight settings and local save", async () => {
  const host = createHost(); host.app.workspace.containerEl = dom.window.document.body;
  const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load(); const config = settings(); let saved = "";
  const runtime = new MobileRuntime(host.app, store, () => config, async () => answer("openai-completions", "ok"));
  let ui;
  const services = new MobileServices({ app: host.app, settings: config, store, runtime, navigation: {}, registerEvent() {}, showPage: async page => ui.showPage(page), saveSettings: async () => {} }, "plugin/mobile"); await services.initialize();
  const root = dom.window.document.querySelector("#app"); root.style.setProperty("--view-bottom-spacing", "68px");
  ui = new MobileUI(root, { app: host.app, store, runtime, services, settings: () => config, saveSettings: async () => { saved = JSON.stringify(config); }, openNote: async () => {}, beginRender() {}, renderMarkdown(text, element) { element.textContent = text; } }); ui.mount();
  const button = text => [...root.querySelectorAll("button")].find(element => element.textContent.trim() === text || element.getAttribute("aria-label") === text);
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await services.openEchoInkGeneralSettings(); assert.equal(root.dataset.page, "settings"); button("基础设置").click(); assert.equal(root.dataset.page, "basic"); button("返回").click(); assert.equal(root.dataset.page, "settings"); button("返回").click(); assert.equal(root.dataset.page, "chat");
  ui.showPage("layout"); await services.openEchoInkGeneralSettings(); button("基础设置").click(); button("返回").click(); assert.equal(root.dataset.page, "settings"); button("返回").click(); assert.equal(root.dataset.page, "chat", "Home settings entry returns to chat even when another detail was open");
  const input = root.querySelector(".em-input"); input.value = "保留中文草稿"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.focus();
  button("引用笔记").click(); const dialog = root.querySelector('[role="dialog"]'); assert.ok(dialog); assert.ok(root.querySelector(".em-header").inert); dialog.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })); assert.equal(dom.window.document.activeElement, dialog.querySelector("button"));
  button("当前笔记笔记/来源.md").click(); await settle(); assert.equal(root.querySelector(".em-input"), input); assert.equal(input.value, "保留中文草稿"); assert.equal(dom.window.document.activeElement, input); assert.equal(store.session.notePath, "笔记/来源.md");
  const viewport = new dom.window.EventTarget(); viewport.scale = 1; viewport.height = 552; viewport.offsetTop = 0; Object.defineProperty(dom.window, "visualViewport", { value: viewport, configurable: true }); root.getBoundingClientRect = () => ({ bottom: 852 });
  dom.window.dispatchEvent(new dom.window.Event("resize")); await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(root.style.getPropertyValue("--em-viewport-occlusion"), "300px"); assert.equal(root.querySelector(".em-input"), input); assert.equal(root.style.getPropertyValue("--view-bottom-spacing"), "68px");
  button("设置").click(); assert.equal(root.querySelectorAll(".em-body>.em-row").length, 8); button("布局与外观").click(); const large = root.querySelector('[aria-label="放大正文"]'); large.checked = true; large.dispatchEvent(new dom.window.Event("change")); await settle(); assert.equal(loadMobileSettings(JSON.parse(saved)).mobileUi.largeText, true); ui.showPage("layout"); button("返回").click(); assert.equal(root.dataset.page, "settings");
  store.state.memories.push({ id: "edit-fixture", kind: "view", title: "待修正记忆", content: "原文", recallWhen: "解释", basis: "explicit", date: new Date().toISOString(), revision: 1, contentOrigin: "user_edit" });
  ui.showPage("memories"); [...root.querySelectorAll(".em-row")].find(row => row.textContent.includes("待修正记忆")).click(); button("编辑").click(); const editor = root.querySelector('[aria-label="记忆内容"]'); editor.value = "修正后正文"; editor.dispatchEvent(new dom.window.Event("input")); button("预览修改").click(); assert.equal(store.state.memories.at(-1).content, "原文"); assert.ok(root.querySelector('[role="dialog"]').textContent.includes("修改前")); button("应用修改").click(); await settle(); assert.equal(store.state.memories.at(-1).content, "修正后正文"); assert.equal(store.state.memories.at(-1).revision, 2);
  const oldId = store.session.id; ui.showPage("review"); button("归档当前会话").click(); await settle(); assert.ok(store.state.sessions.find(session => session.id === oldId).archivedAt); root.querySelector(".em-archive summary").click(); await settle(); button("恢复会话").click(); await settle(); assert.equal(store.session.id, oldId); assert.equal(store.session.archivedAt, undefined);
  ui.destroy(); await services.dispose();
});

await test("journal entries wait for input and retain old, quick and plus-menu drafts", async () => {
  const state = await setup("openai-completions", async () => { throw new Error("journal must not request a provider"); }); let sends = 0; state.runtime.send = async () => { sends++; };
  state.config.apiProviders = []; const root = dom.window.document.querySelector("#app"); const services = new MobileServices({ ...state, settings: state.config, navigation: new MobileWorkspace(state.app.workspace, false), registerEvent() {}, saveSettings: async () => {}, showPage: async () => {} }, "plugin/mobile");
  const old = state.store.session; old.draft = "帮我整理今天的记录，生成一篇 Markdown 日记并保存。\n";
  const view = services.getCodexView(); await view.startHomeConversation({ title: "今日记录", message: "示例句", defaultSkillId: "daily-journal" }); assert.notEqual(state.store.session.id, old.id); assert.equal(old.draft, "帮我整理今天的记录，生成一篇 Markdown 日记并保存。\n"); assert.equal(state.store.session.draft, ""); assert.equal(state.store.session.skillId, "daily-journal"); assert.equal(sends, 0);
  const ui = new MobileUI(root, { app: state.app, store: state.store, runtime: state.runtime, services, settings: () => state.config, saveSettings: async () => {}, openNote: async () => {}, beginRender() {}, renderMarkdown(text, element) { element.textContent = text; } }); ui.mount();
  const input = root.querySelector(".em-input"); const click = (label, selector = "button") => [...root.querySelectorAll(selector)].find(b => b.getAttribute("aria-label") === label || b.textContent.trim() === label).click();
  click("写日记"); await settle(); await settle(); assert.equal(input.value, ""); assert.equal(dom.window.document.activeElement, input);
  input.value = "用户未完成的记录"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); click("写日记"); await settle(); await settle(); assert.equal(input.value, "用户未完成的记录"); click("添加到对话"); click("写日记", ".em-sheet button"); await settle(); await settle(); assert.equal(input.value, "用户未完成的记录"); assert.equal(root.querySelector(".em-input"), input); assert.ok(!root.querySelector(".em-sheet-overlay")); assert.equal(sends, 0);
  await view.createAndStartGuidedSession({ title: "显式复盘", prompt: "开始复盘", defaultSkillId: "knowledge-review" }); assert.equal(sends, 1); assert.equal(state.store.session.draft, "开始复盘");
  ui.destroy(); await services.dispose();
});

await test("iPad settings: formal central leaf reuse, isolated listener, local sync and close/reopen", async () => {
  const state = await setup("openai-completions", async () => answer("openai-completions", "ok"));
  const platform = obsidian.exports.Platform; const previousTablet = platform.isTablet; platform.isTablet = true;
  const root = dom.window.document.querySelector("#app"), home = dom.window.document.body.appendChild(dom.window.document.createElement("div")), central = dom.window.document.body.appendChild(dom.window.document.createElement("div"));
  Object.defineProperty(central, "clientWidth", { value: 800, configurable: true });
  const plugin = new EchoInkMobilePlugin(state.app, { id: "codex-echoink", version: "2.6.3-beta.6" });
  Object.assign(plugin, { store: state.store, runtime: state.runtime, settings: state.config }); plugin.saveData = async () => {};
  const fixture = mobileWorkspaceFixture(plugin, { chat: root, home, settings: central }, true);
  const services = new MobileServices({ ...plugin, app: state.app, settings: state.config, store: state.store, runtime: state.runtime, navigation: plugin.navigation, registerEvent() {}, saveSettings: () => plugin.saveSettings(), showPage: page => plugin.showPage(page) }, "plugin/mobile"); plugin.services = services;
  let intervals = 0; const interval = dom.window.setInterval; dom.window.setInterval = (...args) => { intervals++; return interval(...args); };
  try {
    await plugin.navigation.open(); const input = root.querySelector(".em-input"); input.value = "保持输入和焦点"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.focus(); const listener = state.runtime.onChange;
    await Promise.all([services.openEchoInkGeneralSettings(), plugin.showPage("settings")]); assert.equal(fixture.leaves.filter(leaf => leaf.view.getViewType() === "echoink-mobile-settings").length, 1); assert.equal(state.runtime.onChange, listener); assert.equal(intervals, 1); assert.ok(!central.querySelector(".em-input,.em-navigation")); assert.equal(root.querySelector(".em-input"), input); assert.equal(central.querySelectorAll(".em-sidebar .em-row").length, 8);
    await plugin.showPage("providers"); [...central.querySelectorAll("button")].find(b => b.textContent.trim() === "添加提供商").click(); const key = central.querySelector('[aria-label="API Key"]'); key.value = "synthetic-settings-key"; key.dispatchEvent(new dom.window.Event("input")); await plugin.showPage("settings"); assert.equal(central.querySelector('[aria-label="API Key"]'), key); assert.equal(key.value, "synthetic-settings-key");
    key.focus(); state.config.customWelcomeEnabled = true; state.config.customWelcomeTitle = "设置即时同步"; state.config.mobileUi.largeText = true; await plugin.saveSettings(); assert.equal(root.querySelector(".em-input"), input); assert.equal(dom.window.document.activeElement, key); assert.equal(input.value, "保持输入和焦点"); assert.ok(root.classList.contains("em-large-text")); assert.equal(root.querySelector(".em-welcome h1").textContent, "设置即时同步");
    await fixture.leaves.find(leaf => leaf.view.getViewType() === "echoink-mobile-settings").detach(); assert.equal(state.runtime.onChange, listener); assert.equal(intervals, 1); state.store.session.messages.push({ role: "user", content: "设置关闭后仍更新", timestamp: Date.now() }); state.runtime.onChange(); assert.ok(root.textContent.includes("设置关闭后仍更新")); assert.equal(root.querySelector(".em-input"), input);
    await plugin.showPage("settings"); assert.equal(intervals, 1); assert.equal(state.runtime.onChange, listener); assert.ok(!central.querySelector(".em-input")); Object.defineProperty(central, "clientWidth", { value: 460, configurable: true }); await plugin.showPage("basic"); central.querySelector('[aria-label="返回"]').click(); assert.equal(central.dataset.page, "settings"); assert.ok(!central.querySelector('[aria-label="返回"]'));
    const click = (surface, label) => { const button = [...surface.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === label || b.textContent.trim() === label); assert.ok(button, label); button.click(); };
    click(root, "选择模型"); assert.ok(root.querySelector(".em-sheet-overlay")); click(root, "模型与提供商设置"); await settle(); await settle(); assert.equal(central.dataset.page, "providers"); assert.ok(!root.querySelector(".em-sheet-overlay")); assert.ok([...root.children].every(child => !child.inert)); assert.equal(root.querySelector(".em-input"), input);
    click(root, "添加到对话"); assert.ok(root.querySelector(".em-sheet-overlay")); click(root, "选择 Skill"); await settle(); await settle(); assert.equal(central.dataset.page, "resources"); assert.ok(!root.querySelector(".em-sheet-overlay")); assert.ok([...root.children].every(child => !child.inert)); assert.equal(input.value, "保持输入和焦点");
    const oldSession = state.store.session; click(root, "历史对话"); await plugin.showPage("review"); click(central, "归档当前会话"); await settle(); await settle(); assert.notEqual(state.store.session.id, oldSession.id); assert.equal(input.value, ""); assert.ok(!root.textContent.includes("设置关闭后仍更新")); assert.ok(root.querySelector(".em-context").hidden); assert.equal(root.querySelector('.em-session-row[aria-current="page"]').dataset.sessionId, state.store.session.id); assert.ok(!root.querySelector(`[data-session-id="${oldSession.id}"]`)); click(root, "关闭弹层");
    central.querySelector(".em-archive summary").click(); await settle(); click(central, "恢复会话"); await settle(); await settle(); assert.equal(state.store.session.id, oldSession.id); assert.equal(input.value, oldSession.draft); assert.equal(root.querySelector(".em-input"), input); assert.ok(root.textContent.includes("设置关闭后仍更新")); assert.ok(root.querySelector(".em-context").textContent.includes("笔记/来源.md")); click(root, "历史对话"); assert.equal(root.querySelector('.em-session-row[aria-current="page"]').dataset.sessionId, oldSession.id); click(root, "关闭弹层");
    await fixture.leaves.find(leaf => leaf.view.getViewType() === "echoink-mobile-settings").detach(); const deferred = fixture.restoreDeferredSettings(); await plugin.showPage("account"); assert.equal(fixture.active, deferred); assert.equal(central.dataset.page, "account"); assert.equal(state.runtime.onChange, listener); assert.equal(intervals, 1);
  } finally { await fixture.dispose(); home.remove(); central.remove(); platform.isTablet = previousTablet; dom.window.setInterval = interval; }
});

await test("provider branded picker: every brand, nested cancel, keyboard, same-key retention and saved selection", async () => {
  const state = await setup("openai-completions", async () => answer("openai-completions", "ok"));
  state.config.apiProviders[0].providerId = "deepseek";
  const root = dom.window.document.querySelector("#app"); let saved = 0;
  const ui = new MobileUI(root, { app: state.app, store: state.store, runtime: state.runtime, settings: () => state.config, saveSettings: async () => { saved++; }, openNote: async () => {}, beginRender() {}, renderMarkdown() {} }); ui.mount(); ui.showPage("providers");
  root.querySelector(".em-row").click(); const original = root.querySelector('[aria-label="API Key"]'); original.value = "synthetic-edited-key"; original.dispatchEvent(new dom.window.Event("input"));
  const trigger = root.querySelector(".em-provider-trigger"); assert.ok(trigger.querySelector("svg,img")); trigger.click();
  const options = [...root.querySelectorAll('[role="option"]')]; assert.equal(JSON.stringify(options.map(item => item.dataset.provider)), JSON.stringify(mobilePresets.map(item => item.id))); assert.ok(options.every(option => option.querySelector("svg,img"))); assert.equal(root.querySelector('[role="option"][aria-selected=true]').dataset.provider, "deepseek");
  root.querySelector(".em-provider-picker").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); assert.equal(dom.window.document.activeElement.getAttribute("role"), "option");
  root.querySelector(".em-provider-picker").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.ok(root.querySelector('[role="dialog"]')); assert.equal(root.querySelector('[aria-label="API Key"]'), original); assert.equal(original.value, "synthetic-edited-key"); assert.equal(dom.window.document.activeElement, trigger);
  trigger.click(); root.querySelector('[role="option"][data-provider="deepseek"]').click(); assert.equal(root.querySelector('[aria-label="API Key"]'), original); assert.equal(original.value, "synthetic-edited-key");
  trigger.click(); root.querySelector('[role="option"][data-provider="kimi"]').click(); assert.equal(root.querySelector('[aria-label="API Key"]').value, "");
  const key = root.querySelector('[aria-label="API Key"]'); key.value = "synthetic-kimi-key"; key.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find(b => b.textContent.trim() === "保存").click(); await settle();
  assert.equal(saved, 1); assert.equal(state.config.apiProviders[0].providerId, "kimi"); assert.equal(state.config.apiProviders[0].apiKey, "synthetic-kimi-key"); ui.destroy();
});

await test("mobile full finance: same ledger, budget, plans, real workspace, CSV export and revoked write gate", async () => {
  const state = await setup("openai-completions", async () => answer("openai-completions", "ok")); let qualified = true;
  const access = { checkCapability: () => qualified, requireCapability: () => { if (!qualified) throw new Error("PRO_REQUIRED"); }, subscribe: () => () => {} };
  state.config.lifestyle.finance.enabled = true;
  const services = new MobileServices({ app: state.app, settings: state.config, store: state.store, runtime: state.runtime, accountService: access, navigation: {}, registerEvent() {}, showPage: async () => {}, saveSettings: async () => {} }, "plugin/mobile"); await services.initialize(); await services.initializeFinance();
  const service = services.lifestyle, finance = service.finance; await finance.initialize();
  const date = new Date(), month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}`;
  await finance.saveBudgetChanges({ defaultBudget: { totalCents: 100000, allocations: {} }, overrides: [], removedMonths: [] });
  await finance.saveBillPlan({ id: "fixture-plan", name: "测试计划", budgetCents: 50000 });
  await finance.addManual({ date: `${month}-10 10:00:00`, merchant: "合成商户", category: "餐饮", kind: "expense", amountCents: 1234, status: "completed", account: "合成账户", description: "说明", currency: "CNY", note: "", billPlanId: "fixture-plan" });
  assert.equal(finance.entries().length, 1); assert.ok([...state.files.keys()].some(path => path.endsWith(".md") && path.includes("transactions"))); assert.ok(state.files.has("plugin/lifestyle.json"));
  const root = dom.window.document.querySelector("#app"); root.replaceChildren(); root.className = "echoink-lifestyle-view echoink-mobile-finance";
  const body = root.createDiv(); const workspace = new FinanceWorkspace(service); workspace.render(body);
  const click = label => [...root.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(label)).click();
  click("收支明细"); assert.ok(root.textContent.includes("合成商户")); root.querySelector(".echoink-finance-export").click(); await settle();
  const exported = [...state.files.entries()].find(([path]) => path.endsWith(".csv")); assert.ok(exported); assert.ok(exported[1].includes("合成商户"));
  click("月度预算"); assert.ok(root.textContent.includes("预算")); click("账单计划"); assert.ok(root.textContent.includes("测试计划"));
  qualified = false; assert.equal(finance.accessState().canEnter, true); await assert.rejects(finance.saveBillPlan({ id: "other", name: "禁止", budgetCents: 5000 }), /PRO_REQUIRED/);
  workspace.detach(); root.replaceChildren(); await services.dispose();
});

await test("phone/tablet settings reuse all eight desktop SVGs in static mode", async () => {
  const expected = ["settings", "blocks", "key-round", "layout-list", "book-open-check", "clipboard-check", "list-todo", "feather"];
  assert.deepEqual(Object.values(SETTINGS_TAB_ICONS), expected);
  for (const isTablet of [false, true]) {
    const state = await setup("openai-completions", async () => answer("openai-completions", "ok"));
    const root = dom.window.document.querySelector("#app");
    const ui = new MobileUI(root, { app: state.app, isTablet, store: state.store, runtime: state.runtime, settings: () => state.config, saveSettings: async () => {}, openNote: async () => {}, beginRender() {}, renderMarkdown() {} });
    ui.mount(); ui.showPage("settings");
    const selector = `${isTablet ? ".em-sidebar" : ".em-body"} .em-row>.codex-settings-tab-icon`;
    assert.equal(root.querySelectorAll(selector).length, 8);
    for (const [index, iconName] of expected.entries()) {
      const icon = root.querySelectorAll(selector)[index];
      const desktop = dom.window.document.createElement("span");
      renderAnimatedSettingsTabIcon(desktop, iconName, null);
      assert.equal(icon.innerHTML, desktop.innerHTML, iconName);
      assert.ok(icon.querySelector("path"), "no circle-only fixture fallback");
      icon.parentElement.dispatchEvent(new dom.window.MouseEvent("mouseenter")); icon.parentElement.focus(); icon.parentElement.click();
      assert.equal(icon.classList.contains("is-animating"), false);
      assert.equal(icon.style.getPropertyValue("--echoink-tab-icon-delay"), "");
      ui.showPage("settings");
    }
    ui.showPage("settings");
    assert.equal(root.querySelector(".codex-settings-tab-icon.is-animating"), null);
    ui.destroy();
  }
});

await test("mobile account: SecretStorage identity concurrency, real signed lease, restart and failed logout clearing", async () => {
  const values = new Map(); let failWrites = false;
  const secret = { getSecret: id => values.get(id) ?? null, setSecret(id, value) { if (failWrites) throw new Error("fixture storage failure"); values.set(id, value); } };
  const [storage, concurrent] = await Promise.all([createMobileMembershipStorage(secret, "https://fixture.test"), createMobileMembershipStorage(secret, "https://fixture.test")]);
  const [identity, otherIdentity, sameIdentity] = await Promise.all([storage.identity(), concurrent.identity(), storage.identity()]);
  assert.deepEqual(identity, otherIdentity); assert.deepEqual(identity, sameIdentity);
  const storedIdentity = [...values.entries()].find(([key]) => key.endsWith("-identity"))[1];
  assert.deepEqual(JSON.parse(storedIdentity), JSON.parse(JSON.stringify(identity)));
  const signer = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await webcrypto.subtle.exportKey("jwk", signer.publicKey);
  const now = Date.now(); const calls = []; let activated = false, offline = false;
  const transport = async (path, method, body, token) => {
    calls.push({ path, method, body });
    if (offline) throw new Error("fixture offline");
    if (path === "/api/products") return { products: [] };
    if (path === "/api/auth/code") return {};
    if (path === "/api/auth/login") { assert.equal(body.method, "code"); return { token: "fixture-secret-token" }; }
    if (path === "/api/auth/logout") { assert.equal(token, "fixture-secret-token"); return {}; }
    if (path === "/api/account") return { id: "fixture", email: "fixture@example.test", name: "Fixture", joinedAt: "2026-10-11", avatar: null, passwordSet: false };
    if (path === "/api/membership") return { state: "active", planId: "year", deviceLimit: 3, devices: activated ? [{ id: "device-fixture", name: "手机实例", platform: "Obsidian", verified: now }] : [], capabilities: ["finance.export"], serverTime: now };
    if (path === "/api/devices/challenge") return { challengeId: "challenge", nonce: "fixture-nonce" };
    if (path === "/api/devices/lease" && !activated) throw new MembershipApiError("DEVICE_REVOKED");
    if (path === "/api/devices/activate" || path === "/api/devices/lease") {
      const verifyKey = await webcrypto.subtle.importKey("jwk", body.publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      assert.ok(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, Buffer.from(body.signature, "base64url"), new TextEncoder().encode("echoink-device-v1\nchallenge\nfixture-nonce")));
      activated = true;
      const claims = { schema: 1, iss: "echoink", sub: "fixture", deviceId: "device-fixture", keyHash: await keyHash(body.publicKey), capabilities: ["finance.export"], major: 2, iat: now, exp: now + 3600000 };
      const parts = [Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "fixture" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")];
      const payload = parts.join(".");
      const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, new TextEncoder().encode(payload))).toString("base64url");
      return { lease: payload + "." + signature, deviceId: "device-fixture", serverTime: now };
    }
    if (path === "/api/keys") return { keys: [{ kid: "fixture", alg: "ES256", publicKey }] };
    throw new Error("unexpected fixture path " + path);
  };
  const makeService = adapter => new AccountService(adapter, transport, "https://fixture.test", () => {}, "https://fixture.test", () => "missing");
  const account = makeService(storage); await account.initialize();
  await account.actions.requestCode({ email: "fixture@example.test", purpose: "login" });
  await account.actions.signIn({ email: "fixture@example.test", method: "code", credential: "123456" });
  assert.equal(account.read().membership.state, "device-required"); assert.equal(account.checkCapability("finance.export"), false);
  await account.actions.activateDevice("手机实例"); assert.equal(account.checkCapability("finance.export"), true);
  assert.equal(account.checkCapability("finance.analysis.generate"), false);
  account.dispose(); offline = true;
  const restoredStorage = await createMobileMembershipStorage(secret, "https://fixture.test");
  const restored = makeService(restoredStorage); await restored.initialize();
  assert.equal(restored.checkCapability("finance.export"), true); assert.equal(restored.read().membership.state, "offline-valid");
  offline = false; failWrites = true;
  const before = calls.filter(call => call.path === "/api/auth/logout").length;
  await assert.rejects(restored.actions.signOut(), /安全存储未保存成功/);
  assert.equal(calls.filter(call => call.path === "/api/auth/logout").length, before + 1);
  assert.equal(restored.checkCapability("finance.export"), false); assert.equal(restored.read().identity, null); assert.equal(restoredStorage.persistent, false);
  assert.match(restored.read().storageNotice, /本次运行/);
  failWrites = false; await restored.actions.signOut();
  assert.deepEqual(JSON.parse([...values.entries()].find(([key]) => key.endsWith("-state"))[1]), {});
  assert.equal([...values.entries()].find(([key]) => key.endsWith("-identity"))[1], storedIdentity);
  restored.dispose();
  const transient = await createMobileMembershipStorage(undefined, "fixture"); assert.equal(transient.persistent, false);
  const [temporaryA, temporaryB] = await Promise.all([transient.identity(), transient.identity()]); assert.deepEqual(temporaryA, temporaryB);
});

await test("mobile finance Skill files: desktop customization, disabled metadata, queued atomic usage and failure", async () => {
  const host = createHost({ ".echoink/resources/skills/finance-analysis/SKILL.md": "用户已有财务 Skill", ".echoink/resources/skill-state.json": JSON.stringify({ schema: "echoink.skill-runtime.v1", unowned: true, records: { "finance-analysis": { status: "active", lastUsedAt: null, usageCount: 2, contentHash: "preserved" } } }) });
  const store = new MobileStore(host.adapter, "plugin/mobile"); await store.load(); const config = settings();
  const services = new MobileServices({ app: host.app, settings: config, store, runtime: {}, navigation: {}, registerEvent() {}, showPage: async () => {}, saveSettings: async () => {} }, "plugin/mobile");
  assert.equal((await services.readEchoInkBuiltinSkill("finance-analysis")).content, "用户已有财务 Skill");
  const coordinator = services.getSkillRuntimeCoordinator(); await Promise.all([coordinator.recordUse("finance-analysis"), coordinator.recordUse("finance-analysis")]);
  const saved = host.files.get(".echoink/resources/skill-state.json"), state = JSON.parse(saved); assert.equal(state.records["finance-analysis"].usageCount, 4); assert.equal(state.unowned, true); assert.equal(state.records["finance-analysis"].contentHash, "preserved");
  host.adapter.rename = async () => { throw new Error("WRITE_FAILED"); }; await assert.rejects(coordinator.recordUse("finance-analysis"), /WRITE_FAILED/); assert.equal(host.files.get(".echoink/resources/skill-state.json"), saved);
  config.resources.catalog.push({ id: "echoink-local:skill:finance-analysis", kind: "skill", enabled: false, metadata: { resourceId: "finance-analysis" } });
  await assert.rejects(services.requireAvailableEchoInkSkill("finance-analysis"), /停用/);
});

await test("finance DataAdapter: same root, queued writes, failure rollback, unknown fields, legacy backup and restart", async () => {
  const host = createHost({ "custom/lifestyle.json": JSON.stringify({ version: 1, unowned: { keep: true }, financeEntries: [{ id: "legacy" }] }) });
  const store = mobileLifestyleStore(host.adapter, "custom/lifestyle.json"); await store.initialize();
  await store.retainLegacyFinanceBackup(); const backup = host.files.get("custom/lifestyle.json.finance-legacy-backup.json");
  await Promise.all([store.update(d => { d.budgets.push({ month: "2026-10", totalCents: 5000, allocations: {} }); }), store.update(d => { d.financeBillPlans.push({ id: "plan", name: "计划", budgetCents: 6000 }); })]);
  const before = JSON.stringify(store.snapshot()), bytes = host.files.get("custom/lifestyle.json"), rename = host.adapter.rename;
  host.adapter.rename = async () => { throw new Error("WRITE_FAILED"); };
  await assert.rejects(store.update(d => { d.budgets = []; }), /WRITE_FAILED/);
  assert.equal(JSON.stringify(store.snapshot()), before); assert.equal(host.files.get("custom/lifestyle.json"), bytes); assert.ok(![...host.files.keys()].some(p => p.endsWith(".tmp")));
  host.adapter.rename = rename; await store.update(d => { d.reports = []; }); await store.retainLegacyFinanceBackup(); assert.equal(host.files.get("custom/lifestyle.json.finance-legacy-backup.json"), backup);
  const reopened = mobileLifestyleStore(host.adapter, "custom/lifestyle.json"); await reopened.initialize(); assert.equal(reopened.snapshot().unowned.keep, true); assert.equal(reopened.snapshot().budgets.length, 1); assert.equal(reopened.snapshot().financeBillPlans[0].id, "plan");
  for (const text of ["", "abc", "中文😀", "a".repeat(1000000)]) assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"));
});

await test("finance XLSX universal parser matches CSV in browser without Buffer or process", async () => {
  const rows = [["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号"], ["2026-10-10 10:00:00", "商户消费", "合成商户", "合成商品", "支出", "12.34", "零钱", "支付成功", "synthetic-1"]];
  const cell = (value, column, row) => `<c r="${String.fromCharCode(65 + column)}${row + 1}" t="inlineStr"><is><t>${value}</t></is></c>`;
  const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((values, row) => `<row r="${row + 1}">${values.map((v, c) => cell(v, c, row)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const zip = zipSync({ "xl/workbook.xml": strToU8('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账单" sheetId="1" r:id="rId1"/></sheets></workbook>'), "xl/_rels/workbook.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'), "xl/worksheets/sheet1.xml": strToU8(sheet) });
  const xlsx = await readFinanceBill(zip, "bill.xlsx", "wechat"), csv = await readFinanceBill(new TextEncoder().encode(rows.map(row => row.join(",")).join("\n")), "bill.csv", "wechat");
  assert.equal(xlsx[0].entry.amountCents, 1234); const normalize = rows => JSON.parse(JSON.stringify(rows)).map(row => { delete row.entry.id; return row; }); assert.deepEqual(normalize(xlsx), normalize(csv));
});

await test("finance independent inference: both protocols, secret redaction, cancellation and late response", async () => {
  for (const protocol of ["openai-completions", "openai-responses"]) {
    const config = settings(protocol), provider = config.apiProviders[0]; let sent;
    const value = await mobileGenerateText(provider, provider.models[0], async request => { sent = JSON.parse(request.body); return answer(protocol, "独立财务分析"); }, "财务系统", "本月资料", 1800, new AbortController().signal);
    assert.equal(value, "独立财务分析"); assert.ok(!sent.tools); assert.equal((sent.messages ?? sent.input).filter(m => m.role === "user").length, 1);
    const controller = new AbortController(); let finish;
    const pending = mobileGenerateText(provider, provider.models[0], () => new Promise(resolve => { finish = resolve; }), "sys", "data", 1800, controller.signal);
    await settle(); controller.abort(); await assert.rejects(pending, /已停止/); finish(answer(protocol, "迟到")); await settle();
    await assert.rejects(mobileGenerateText(provider, provider.models[0], async () => ({ status: 401, json: { error: { message: provider.apiKey } } }), "sys", "data", 1800, new AbortController().signal), error => !error.message.includes(provider.apiKey));
  }
});

await test("mobile identity persists the same temporary key when SecretStorage recovers", async () => {
  const values = new Map(); let failed = true;
  const port = { getSecret: id => values.get(id) ?? null, setSecret: (id, value) => { if (failed) throw new Error("WRITE_FAILED"); values.set(id,value); } };
  const temporary = await createMobileMembershipStorage(port, "recovering-port"); assert.equal(temporary.persistent, false);
  const first = await temporary.identity(); failed = false;
  const recovered = await createMobileMembershipStorage(port, "recovering-port"); assert.equal(recovered.persistent, true); assert.deepEqual(await recovered.identity(), first);
  assert.deepEqual(JSON.parse([...values.entries()].find(([id]) => id.endsWith("-identity"))[1]), JSON.parse(JSON.stringify(first)));
  const restartedPort = { getSecret: id => values.get(id) ?? null, setSecret: (id,value) => values.set(id,value) };
  const restarted = await createMobileMembershipStorage(restartedPort, "recovering-port"); assert.equal(JSON.stringify(await restarted.identity()), JSON.stringify(first));
});

for (const platform of [{ isMobileApp: true, isMobile: true, isTablet: false }, { isMobileApp: true, isMobile: false, isTablet: true }]) await test(`production mobile bundle initializes without Node: ${platform.isTablet ? "tablet desktop UI" : "phone"}`, async () => {
  const code = await fs.readFile("dist/main.js", "utf8"); const host = createHost(); const imported = []; const commands = [];
  class Plugin {
    constructor() { this.app = host.app; this.manifest = { id: "codex-echoink", dir: "plugin" }; }
    async loadData() { return { desktopUnknown: { keep: true } }; }
    async saveData() {}
    registerEvent() {}
    register() {}
    registerDomEvent() {}
    registerInterval(id) { this.interval = id; }
    registerView(type, factory) { this.factory = factory; }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command.id); }
  }
  class Component {}
  const exports = { exports: {} };
  const context = vm.createContext({ module: exports, exports: exports.exports, window: dom.window, document: dom.window.document, URL, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: webcrypto, btoa, atob, Blob, FormData, Response, console, setTimeout, clearTimeout,
    require(id) { imported.push(id); if (id !== "obsidian") throw new Error(`Node loaded on mobile: ${id}`); return { Platform: platform, Plugin, ItemView: class {}, Component, Modal: class {}, TFile: FixtureTFile, Notice: class {}, requestUrl() { throw new Error("startup requested provider"); } }; }
  });
  vm.runInContext(code, context); const MobilePlugin = exports.exports.default ?? exports.exports; const plugin = new MobilePlugin(); await plugin.onload();
  assert.ok(commands.includes("open-echoink-mobile")); assert.ok(plugin.store); assert.equal(plugin.settings.apiProviders.length, 0);
  assert.ok(imported.every(id => id === "obsidian")); assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
  plugin.onunload(); dom.window.clearInterval(plugin.interval);
});
console.log(`${passed} mobile integration checks passed (real Pi Agent; Provider and Obsidian API fixtures).`);
