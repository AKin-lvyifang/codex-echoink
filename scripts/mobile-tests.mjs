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
const { MobileStore, MobileRuntime, mobileTools, loadMobileSettings, mobileProvider, mobileModel } = module.exports;
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

await test("production mobile bundle loads and initializes without process, Buffer or Node", async () => {
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
    require(id) { imported.push(id); if (id !== "obsidian") throw new Error(`Node loaded on mobile: ${id}`); return { Platform: { isMobile: true }, Plugin, ItemView: class {}, Component, Notice: class {}, requestUrl() { throw new Error("startup requested provider"); } }; }
  });
  vm.runInContext(code, context); const MobilePlugin = exports.exports.default ?? exports.exports; const plugin = new MobilePlugin(); await plugin.onload();
  assert.ok(commands.includes("open-echoink-mobile")); assert.ok(plugin.store); assert.equal(plugin.settings.apiProviders.length, 0);
  assert.ok(imported.every(id => id === "obsidian")); assert.equal(vm.runInContext("typeof process + ':' + typeof Buffer", context), "undefined:undefined");
});
console.log(`${passed} mobile integration checks passed (real Pi Agent; Provider and Obsidian API fixtures).`);
