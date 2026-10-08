import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, answer } from "../tests/mobile/host.mjs";

const build = await esbuild.build(mobileBuildOptions("tests/mobile/entry.ts"));
const module = { exports: {} };
const globals = { module, exports: module.exports, URL, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout, structuredClone, crypto: webcrypto, console, require: id => { if (id !== "obsidian") throw new Error(`Node import on mobile: ${id}`); return { setIcon() {} }; } };
vm.runInNewContext(build.outputFiles[0].text, globals);
const { MobileStore, MobileRuntime, mobileTools, loadMobileSettings, mobileProvider, mobileModel, MobileWorkspace } = module.exports;
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

await test("public workspace navigation preserves panes, reuses readers and recovers closed pairs", async () => {
  const rootSplit = {}; const leaves = []; const splits = []; let recent;
  const leaf = (type, path, pinned = false) => {
    const state = { type, state: { file: path }, pinned };
    const item = { parent: {}, view: { containerEl: { clientWidth: 1024 }, getViewType: () => state.type }, getViewState: () => state, getRoot: () => rootSplit,
      async setViewState(next) { item.sets++; Object.assign(state, next); }, sets: 0,
      async openFile(file) { state.type = "markdown"; state.state = { file: file.path }; } };
    leaves.push(item); return item;
  };
  const workspace = { rootSplit, containerEl: { clientWidth: 1024, querySelector: () => null },
    iterateAllLeaves: callback => leaves.forEach(callback), getLeavesOfType: type => leaves.filter(l => l.view.getViewType() === type),
    getMostRecentLeaf: () => recent, getLeaf: type => { assert.equal(type, "tab"); return leaf("empty"); },
    createLeafBySplit: (source, direction, before) => { splits.push({ source, direction, before }); return leaf("empty"); },
    async revealLeaf(item) { recent = item; }
  };
  const original = leaf("markdown", "source.md"); recent = original;
  const navigation = new MobileWorkspace(workspace, true);
  await Promise.all([navigation.open(), navigation.open(), navigation.open()]);
  assert.equal(leaves.length, 2); assert.equal(splits[0].source, original); assert.equal(splits[0].direction, "vertical");
  const chat = recent; assert.equal(chat.sets, 1); assert.equal(original.getViewState().state.file, "source.md");
  await navigation.openNote({ path: "source.md" }, chat); assert.equal(leaves.length, 2);
  await navigation.openNote({ path: "other.md" }, chat); assert.equal(leaves.length, 2); assert.equal(original.getViewState().state.file, "other.md");
  original.getViewState().pinned = true;
  await navigation.openNote({ path: "third.md" }, chat); assert.equal(leaves.length, 3); assert.equal(original.getViewState().state.file, "other.md");
  const reader = recent; assert.equal(splits.at(-1).before, true);
  reader.getViewState().state.file = "unrelated.md";
  await navigation.openNote({ path: "fourth.md" }, chat); assert.equal(reader.getViewState().state.file, "unrelated.md");
  const fourth = recent; leaves.splice(leaves.indexOf(fourth), 1);
  await Promise.all([navigation.openNote({ path: "fifth.md" }, chat), navigation.openNote({ path: "fifth.md" }, chat)]);
  assert.equal(leaves.length, 4); assert.equal(splits.length, 4);
  leaves.splice(leaves.indexOf(chat), 1); recent = original;
  await navigation.open(); assert.equal(recent.view.getViewType(), "echoink-mobile"); assert.equal(original.getViewState().pinned, true);
  workspace.containerEl.clientWidth = 393;
  recent.view.containerEl.clientWidth = 393;
  const before = splits.length; await navigation.openNote({ path: "narrow.md" }, recent); assert.equal(splits.length, before);
  leaves.splice(leaves.findIndex(l => l.view.getViewType() === "echoink-mobile"), 1);
  recent.view.containerEl.clientWidth = 393;
  await navigation.open(); assert.equal(splits.length, before);
  workspace.containerEl.clientWidth = 1024;
  const phone = new MobileWorkspace(workspace, false); await phone.openNote({ path: "phone.md" }, recent); assert.equal(splits.length, before);
  // A wide root cannot justify splitting an already narrow view.
  recent.view.containerEl.clientWidth = 512;
  await navigation.openNote({ path: "already-split.md" }, recent); assert.equal(splits.length, before);
  const currentChat = leaves.find(l => l.view.getViewType() === "echoink-mobile");
  const sameTab = leaf("markdown", "same-tab.md", true); sameTab.parent = currentChat.parent;
  currentChat.view.containerEl.clientWidth = 1024;
  const sameGroupNavigation = new MobileWorkspace(workspace, true);
  await sameGroupNavigation.openNote({ path: "same-tab.md" }, currentChat);
  assert.equal(splits.length, before + 1); assert.notEqual(recent.parent, currentChat.parent);
  assert.equal(sameTab.getViewState().pinned, true);
  await sameGroupNavigation.openNote({ path: "same-tab.md" }, currentChat); assert.equal(splits.length, before + 1);
  const otherTab = leaf("markdown", "narrow-tab.md"); otherTab.parent = currentChat.parent;
  currentChat.view.containerEl.clientWidth = 512;
  await navigation.openNote({ path: "narrow-tab.md" }, currentChat); assert.equal(recent, otherTab); assert.equal(splits.length, before + 1);
  // Reopening from a same-group source after widening retains the same chat UI.
  otherTab.view.containerEl.clientWidth = 1024;
  const reopen = new MobileWorkspace(workspace, true); const chatSets = currentChat.sets;
  await Promise.all([reopen.open(), reopen.open()]);
  assert.equal(recent, currentChat); assert.equal(currentChat.sets, chatSets);
  assert.equal(splits.length, before + 2); assert.equal(splits.at(-1).before, true);
  const duplicate = leaves.find(item => item.parent !== currentChat.parent && item.getViewState().state.file === "narrow-tab.md");
  assert.ok(duplicate); recent = otherTab; await reopen.open(); assert.equal(splits.length, before + 2);
});

for (const platform of [{ isMobileApp: true, isMobile: true, isTablet: false }, { isMobileApp: true, isMobile: false, isTablet: true }]) await test(`production mobile bundle initializes without Node: ${platform.isTablet ? "tablet desktop UI" : "phone"}`, async () => {
  const code = await fs.readFile("dist/main.js", "utf8"); const host = createHost(); const imported = []; const commands = [];
  class Plugin {
    constructor() { this.app = host.app; this.manifest = { id: "codex-echoink", dir: "plugin" }; }
    async loadData() { return { desktopUnknown: { keep: true } }; }
    async saveData() {}
    registerView(type, factory) { this.factory = factory; }
    addRibbonIcon() {}
    addCommand(command) { commands.push(command.id); }
  }
  class Component {}
  const exports = { exports: {} };
  const context = vm.createContext({ module: exports, exports: exports.exports, URL, TextEncoder, TextDecoder, AbortController, structuredClone, crypto: webcrypto, console, setTimeout, clearTimeout,
    require(id) { imported.push(id); if (id !== "obsidian") throw new Error(`Node loaded on mobile: ${id}`); return { Platform: platform, Plugin, ItemView: class {}, Component, Notice: class {}, requestUrl() { throw new Error("startup requested provider"); } }; }
  });
  vm.runInContext(code, context); const MobilePlugin = exports.exports.default ?? exports.exports; const plugin = new MobilePlugin(); await plugin.onload();
  assert.ok(commands.includes("open-echoink-mobile")); assert.ok(plugin.store); assert.equal(plugin.settings.apiProviders.length, 0);
  assert.ok(imported.every(id => id === "obsidian")); assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
});
console.log(`${passed} mobile integration checks passed (real Pi Agent; Provider and Obsidian API fixtures).`);
