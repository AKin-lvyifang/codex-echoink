import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";
import { createHost, FixtureTFile, answer } from "../tests/mobile/host.mjs";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://mobile-expert.invalid" });
const build = await esbuild.build({ ...mobileBuildOptions("tests/mobile-experts/entry.ts"), metafile: true });
assert.ok(!Object.keys(build.metafile.inputs).some(file => file.includes("node:fs") || file.includes("pi-coding-agent/")));
const shimBuild = await esbuild.build({ entryPoints: ["tests/mobile/browser-obsidian.ts"], bundle: true, write: false, platform: "browser", format: "cjs", logLevel: "silent" });
const shim = { exports: {} };
vm.runInNewContext(shimBuild.outputFiles[0].text, { module: shim, exports: shim.exports, window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser, HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, console });
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, window: dom.window, document: dom.window.document,
  crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, Uint8Array, AbortController, URL, URLSearchParams, atob, btoa, setTimeout, clearTimeout, console,
  HTMLElement: dom.window.HTMLElement, SVGElement: dom.window.SVGElement, DOMParser: dom.window.DOMParser,
  require(name) { assert.equal(name, "obsidian"); return { ...shim.exports, TFile: FixtureTFile }; }
});
const api = module.exports;
const PRIVATE_PERSONA = "SYNTHETIC PRIVATE MOBILE PERSONA";
const PRIVATE_SKILL = "SYNTHETIC PRIVATE MOBILE PRECONFIGURED SKILL";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const waitFor = async condition => { const until = Date.now() + 4000; while (!condition()) { if (Date.now() > until) throw new Error("condition timed out"); await tick(); } };
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`OK ${name}`); };

async function fixture(providerAction = async () => answer("openai-completions", "完成")) {
  const host = createHost();
  const settings = api.loadMobileSettings({});
  const provider = api.mobileProvider("custom"); Object.assign(provider, { apiKey: "synthetic-only", baseUrl: "https://provider.invalid/v1", models: [api.mobileModel("fixture", { toolCalling: true })], defaultModelId: "fixture" });
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = "fixture";
  const store = new api.MobileStore(host.adapter, "plugin/mobile", "expert-fixture"); await store.load(); await store.setMemoryEnabled(false);
  let services, available = true, failDownload = false, version = "draft-1", ordinarySkills = 0;
  const requests = [], opens = [], savedSettings = [];
  const access = { checkCapability: () => available, requireCapability() { if (!available) throw new Error("PRO revoked"); }, subscribe: () => () => {} };
  const runtime = new api.MobileRuntime(host.app, store, () => settings, async request => { requests.push(JSON.parse(request.body)); return providerAction(request, { revoke: () => { available = false; } }); }, (id, turn) => services.context(id, turn), async () => {}, () => access);
  services = new api.MobileServices({ app: host.app, settings, store, runtime, navigation: {}, accountService: access, manifest: { version: "2.8.8" },
    saveSettings: async registry => { savedSettings.push(JSON.stringify(registry ?? settings)); }, registerEvent() {}, showPage: async () => {},
    openExpertConversation: async (agentId, id) => { opens.push({ agentId, id }); await store.update(state => { state.activeSessionId = id; state.page = { kind: "detail", taskId: id }; }); }
  }, "plugin/mobile");
  Object.defineProperty(services, "experts", { value: { async resolve(id) {
    if (failDownload) throw new Error("synthetic download failed");
    const resolvedVersion = version;
    const assertAvailable = () => { if (!available) throw new Error("synthetic expert authorization revoked"); };
    assertAvailable();
    return { id, name: "测试专家", summary: "测试公开简介", version: resolvedVersion, meta: { scene: "测试" }, avatar: { kind: "custom", mimeType: "image/webp", dataUrl: "data:image/webp;base64,UklGRgAAAABXRUJQ", width: 256, height: 256 },
      assertAvailable, buildTransientPrompt: () => { assertAvailable(); return `<expert-private-context>${PRIVATE_PERSONA}\n${PRIVATE_SKILL} ${resolvedVersion}</expert-private-context>`; }, licenseTexts: () => [] };
  } } });
  await services.agents.initialize(); await runtime.initialize();
  const capabilities = services.capabilities;
  capabilities.resolveRunSkills = async () => { ordinarySkills++; throw new Error("expert must never resolve ordinary Skills"); };
  return { ...host, settings, services, runtime, store, requests, opens, savedSettings, get ordinarySkills() { return ordinarySkills; },
    revoke() { available = false; }, downloadFail(value) { failDownload = value; }, version(value) { version = value; },
    async dispose() { await runtime.shutdown(); runtime.dispose(); await services.dispose(); }
  };
}
function assertPublicPersistence(f) {
  for (const value of [JSON.stringify(f.store.state), ...f.savedSettings, ...[...f.files].filter(([path]) => !path.includes("expert-cache")).map(([, content]) => content)]) {
    assert.ok(!value.includes(PRIVATE_PERSONA)); assert.ok(!value.includes(PRIVATE_SKILL));
  }
}
try {
  await test("real mobile Agent sends private expert system context while task store/settings/report contain no hidden text", async () => {
    const f = await fixture();
    try {
      await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); const id = f.opens.at(-1).id;
      await f.store.updateSession(id, task => { task.skillId = "ordinary-custom-skill"; });
      const submission = await f.runtime.submit("检查测试方案", id); await submission.completion;
      assert.equal(f.ordinarySkills, 0); assert.equal(f.requests.length, 1);
      const system = f.requests[0].messages.filter(item => item.role === "system").map(item => item.content).join("\n");
      assert.match(system, new RegExp(PRIVATE_PERSONA)); assert.match(system, new RegExp(PRIVATE_SKILL)); assert.doesNotMatch(system, /当前基础风格/u);
      assert.ok(f.requests[0].messages.filter(item => item.role !== "system").every(item => !JSON.stringify(item).includes(PRIVATE_PERSONA)));
      const task = f.store.getSession(id); assert.equal(task.runs.at(-1).agentSnapshot.expertPackageVersion, "draft-1"); assert.equal(task.runs.at(-1).skillId, undefined);
      const report = api.freezeReport(api.collectMobileRunReport(task, { pluginVersion: "2.8.8", platform: "ios", obsidianVersion: "fixture" }, []));
      assert.ok(!report.json.includes(PRIVATE_PERSONA)); assert.ok(!report.json.includes(PRIVATE_SKILL)); assertPublicPersistence(f);
      assert.equal(api.mobileExpertEvents(f.settings.agentRegistry.agents.find(agent => agent.id === "expert-synthetic"), id).filter(event => event.id === "disclosure").length, 1);
    } finally { await f.dispose(); }
  });
  await test("dismissal stops active and queued inputs, retains conversations, and rehire resumes last valid conversation", async () => {
    const pending = gate(); let calls = 0;
    const f = await fixture(async () => { calls++; await pending.promise; return answer("openai-completions", "late answer"); });
    try {
      await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); const id = f.opens.at(-1).id;
      const running = await f.runtime.submit("first", id); await waitFor(() => calls === 1);
      const queued = await f.runtime.submit("queued", id); void queued.completion.catch(() => {});
      await f.services.dismissExpert("expert-synthetic");
      await running.completion; await assert.rejects(queued.completion);
      const stopped = f.store.getSession(id); assert.equal(stopped.agentId, "expert-synthetic"); assert.equal(stopped.taskStatus, "interrupted"); assert.equal(stopped.queuePaused, true);
      assert.ok(stopped.runs.every(run => run.status === "interrupted")); assert.equal(stopped.queue[0].text, "queued", "unexecuted user input stays recoverable");
      await assert.rejects(f.runtime.submit("after dismissal", id), /解聘|不存在|未获准/u);
      await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); assert.equal(f.opens.at(-1).id, id);
      const agent = f.settings.agentRegistry.agents.find(agent => agent.id === "expert-synthetic");
      assert.equal(agent.expert.events.filter(event => event.id === "disclosure").length, 1); assert.equal(agent.expert.events.filter(event => event.id !== "disclosure").length, 1);
      const reopened = new api.MobileStore(f.adapter, "plugin/mobile", "expert-fixture"); await reopened.load(); assert.equal(reopened.getSession(id).agentId, "expert-synthetic");
      pending.resolve(); await tick(); assert.equal(calls, 1, "rehire never replays a stopped queue"); assertPublicPersistence(f);
    } finally { pending.resolve(); await f.dispose(); }
  });
  for (const lastState of ["archived", "deleted", "no-valid-conversation"]) {
    await test(`rehire binds its pending event to the chosen conversation when last is ${lastState}`, async () => {
      const f = await fixture();
      try {
        const agentId = "expert-synthetic";
        await f.services.hireExpert("synthetic"); await f.services.openExpert(agentId); const firstId = f.opens.at(-1).id;
        const first = await f.runtime.submit("first conversation", firstId); await first.completion;
        let expectedId;
        if (lastState !== "no-valid-conversation") {
          const older = await f.store.createSession(agentId), newest = await f.store.createSession(agentId);
          await f.store.updateSession(older.id, task => { task.updatedAt = 100; task.messages.push({ role: "user", content: "older history", timestamp: 100 }); });
          await f.store.updateSession(newest.id, task => { task.updatedAt = 200; task.messages.push({ role: "user", content: "newest history", timestamp: 200 }); });
          expectedId = newest.id;
        }
        let registry = await f.services.agents.snapshot();
        await f.services.agents.updateExpert(draft => {
          const agent = draft.agents.find(agent => agent.id === agentId);
          agent.expert.lastConversationId = firstId;
          agent.expert.events.push({ id: "historical-rehire", at: 1, conversationId: firstId });
        }, registry.version);
        await f.services.dismissExpert(agentId);
        await f.store.update(state => {
          if (lastState === "deleted") state.sessions = state.sessions.filter(task => task.id !== firstId);
          else state.sessions.find(task => task.id === firstId).archivedAt = Date.now();
          state.activeSessionId = state.sessions.find(task => task.agentId === "sol").id; state.page = { kind: "list", agentId: "sol" };
        });
        const historicalEvents = structuredClone(f.settings.agentRegistry.agents.find(agent => agent.id === agentId).expert.events);
        await f.services.hireExpert("synthetic");
        const hired = f.settings.agentRegistry.agents.find(agent => agent.id === agentId);
        const pending = hired.expert.events.find(event => !historicalEvents.some(previous => previous.id === event.id));
        assert.ok(pending, "rehire creates exactly one new persistent event");
        // Reconstruct the service to prove a restart between hiring and opening
        // retains the pending event without an in-memory handoff map.
        const recreated = new api.MobileServices({ app: f.app, settings: f.settings, store: f.store, runtime: f.runtime, navigation: {},
          saveSettings: async () => {}, registerEvent() {}, showPage: async () => {},
          openExpertConversation: async (id, conversationId) => { f.opens.push({ agentId: id, id: conversationId }); }
        }, "plugin/mobile");
        try { await recreated.openExpert(agentId); } finally { await recreated.dispose(); }
        const selectedId = f.opens.at(-1).id;
        if (expectedId) assert.equal(selectedId, expectedId, "the most recent valid alternative is resumed");
        else { assert.notEqual(selectedId, firstId); assert.equal(f.store.getSession(selectedId).agentId, agentId); }
        const selected = f.settings.agentRegistry.agents.find(agent => agent.id === agentId);
        assert.equal(selected.expert.lastConversationId, selectedId);
        assert.equal(selected.expert.events.find(event => event.id === pending.id).conversationId, selectedId);
        assert.deepEqual(JSON.parse(JSON.stringify(selected.expert.events.filter(event => historicalEvents.some(previous => previous.id === event.id)))), JSON.parse(JSON.stringify(historicalEvents)), "already-bound historical events remain untouched");
        assert.equal(selected.expert.events.filter(event => event.id === "disclosure").length, 1, "opening does not repeat the first disclosure");
        assert.ok(api.mobileExpertEvents(selected, selectedId).some(event => event.id === pending.id), "the resumed chat can display this rehire line");
        assertPublicPersistence(f);
      } finally { await f.dispose(); }
    });
  }
  await test("download failure leaves no identity; next use adopts updated package version without exposing private body", async () => {
    const f = await fixture();
    try {
      f.downloadFail(true); await assert.rejects(f.services.hireExpert("synthetic"), /download failed/u); assert.equal(f.settings.agentRegistry.agents.length, 1);
      f.downloadFail(false); await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); const id = f.opens.at(-1).id;
      f.version("draft-2"); const submission = await f.runtime.submit("update package", id); await submission.completion;
      assert.equal(f.settings.agentRegistry.agents.find(agent => agent.id === "expert-synthetic").expert.packageVersion, "draft-2");
      assert.equal(f.store.getSession(id).runs.at(-1).agentSnapshot.expertPackageVersion, "draft-2"); assertPublicPersistence(f);
    } finally { await f.dispose(); }
  });
  await test("authorization revocation at model response boundary prevents stale expert response from reaching chat", async () => {
    const f = await fixture(async (_request, controls) => { controls.revoke(); return answer("openai-completions", "REVOKED_RESPONSE_MUST_NOT_APPEAR"); });
    try {
      await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); const id = f.opens.at(-1).id;
      const submission = await f.runtime.submit("revoke", id); await assert.rejects(submission.completion);
      assert.ok(!JSON.stringify(f.store.getSession(id).messages).includes("REVOKED_RESPONSE_MUST_NOT_APPEAR")); assertPublicPersistence(f);
    } finally { await f.dispose(); }
  });
  await test("actual workspace tool creates interactive HTML receipt and read-only runs cannot write", async () => {
    let calls = 0;
    const f = await fixture(async () => ++calls === 1 ? answer("openai-completions", "", [["create-html", "workspace_create", { path: "demo.html", content: '<button onclick="this.textContent=42">点我</button>' }]]) : answer("openai-completions", "已保存"));
    try {
      await f.services.hireExpert("synthetic"); await f.services.openExpert("expert-synthetic"); const id = f.opens.at(-1).id;
      const submission = await f.runtime.submit("make html", id); await submission.completion;
      assert.ok(f.files.has("EchoInk/工作区/demo.html"));
      const receipt = f.store.getSession(id).messages.find(message => message.role === "toolResult" && message.toolName === "workspace_create");
      assert.equal(api.mobileWorkspacePreviewPath(receipt), "EchoInk/工作区/demo.html");
      assert.equal(api.mobileWorkspacePreviewPath({ role: "toolResult", toolName: "other", details: { previewPath: "EchoInk/工作区/demo.html" } }), undefined);
      await f.store.setPermission("read-only"); calls = 0; const readonly = await f.runtime.submit("attempt write", id); await readonly.completion;
      assert.ok(f.requests.at(-1).tools.every(tool => !["workspace_create", "workspace_update"].includes(tool.function.name))); assertPublicPersistence(f);
    } finally { await f.dispose(); }
  });
  console.log(`Passed ${passed} mobile expert integration scenarios (real Agent, memory-only Vault and faux provider; native/device acceptance remains separate).`);
} finally { dom.window.close(); }
