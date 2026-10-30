import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

const bundle = await esbuild.build(mobileBuildOptions("tests/agent-persona/entry.ts"));
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://agent-persona.invalid" });
const { window } = dom, { document } = window, module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document, window, console,
  crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, AbortController, URL, setTimeout, clearTimeout, atob, btoa,
  HTMLElement: window.HTMLElement, Element: window.Element, MutationObserver: window.MutationObserver,
  require(name) { assert.equal(name, "obsidian"); return { setIcon(element, icon) { element.dataset.icon = icon; } }; }
});
const api = module.exports;
api.installObsidianDom(window);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setTimeout(resolve, 0)); };
const expert = { id: "expert-socrates", name: "苏格拉底", avatar: { kind: "preset", presetId: "lin" }, position: "思考伙伴", positionDescription: "公开简介", styleId: "analysis", kind: "expert",
  expert: { expertId: "socrates", hired: true, packageVersion: "draft-1", summary: "公开简介", disclosureShown: true, lastConversationId: "conversation-1", events: [{ id: "rehired", at: 123, conversationId: "conversation-1" }] }, capabilityIds: ["knowledge"] };
function fixture(registry = api.defaultAgentRegistry()) {
  registry.legacyMigrationVersion = 1;
  const settings = api.loadMobileSettings({ agentRegistry: plain(registry) });
  const service = new api.MobileAgentRegistryService({ exists: async () => false, read: async () => { throw new Error("unexpected file read"); } }, settings, async () => {});
  return { service, settings };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`OK ${name}`); }
function button(root, text) { const node = [...root.querySelectorAll("button")].find(item => item.textContent.trim() === text); assert.ok(node, `button ${text}`); return node; }
function input(node, value) { node.value = value; node.dispatchEvent(new window.Event("input", { bubbles: true })); }

try {
  await test("new three-field identities retain roles while legacy mobile callers retain their descriptions", async () => {
    const { service } = fixture(); let state = await service.snapshot();
    const base = { name: "小林", avatar: { kind: "default" }, position: "编辑", styleId: "creative", capabilityIds: [] };
    state = await service.createAgent({ ...base, id: "new-editor", positionDescription: "" }, state.version);
    assert.equal(state.registry.agents.find(agent => agent.id === "new-editor").position, "编辑");
    assert.equal(state.registry.agents.find(agent => agent.id === "new-editor").positionDescription, "");
    state = await service.createAgent({ ...base, id: "legacy-editor", position: "写文章、整理资料" }, state.version);
    const legacy = state.registry.agents.find(agent => agent.id === "legacy-editor");
    assert.equal(legacy.position, ""); assert.equal(legacy.positionDescription, "写文章、整理资料");
    const context = await service.context(false, legacy.id); assert.match(context, /写文章、整理资料/u);
  });
  await test("normalization retains legacy style, permissions, ownership and all expert public state", () => {
    const registry = api.defaultAgentRegistry(); registry.agents.push({ id: "writer", name: "写作者", avatar: { kind: "default" }, position: "写作", positionDescription: "写文章", styleId: "creative", capabilityIds: ["knowledge", "custom-tool"], persona: "正文😀" }, plain(expert));
    registry.moduleOwners.journal = "writer"; registry.moduleOwners.todos = expert.id;
    const normalized = api.normalizeAgentRegistry(registry);
    assert.deepEqual(plain(normalized.agents[1]), registry.agents[1]); assert.deepEqual(plain(normalized.agents[2]), expert);
    assert.equal(normalized.moduleOwners.journal, "writer"); assert.equal(normalized.moduleOwners.todos, expert.id);
    assert.equal(api.normalizeAgentRegistry(api.defaultAgentRegistry()).agents[0].persona, undefined);
    const dirty = plain(expert); dirty.persona = "private body must never enter an editor"; registry.agents[2] = dirty;
    assert.equal(api.normalizeAgentRegistry(registry).agents[2].persona, undefined);
    dirty.id = "wrong-fixed-identity"; const invalid = api.normalizeAgentRegistry(registry).agents[2];
    assert.equal(api.isExpertAgent(invalid), true); assert.equal(api.isAgentHired(invalid), false, "a malformed fixed identity remains locked and unavailable");
  });
  await test("4000 Unicode places and template recognition preserve selected fallback semantics", () => {
    const text = "😀".repeat(4001); assert.equal(api.agentPersonaLength(api.normalizeAgentPersona(text)), 4000);
    assert.throws(() => api.assertAgentPersonaLength(text), /agent_persona_invalid/u);
    assert.equal(api.hasCustomAgentPersona("  \n"), false); assert.equal(api.hasCustomAgentPersona("自己写的人格"), true);
    for (const style of ["execution", "analysis", "companion", "creative"]) {
      assert.equal(api.hasCustomAgentPersona(api.getAgentPersonaTemplate(style)), false);
      assert.equal(api.hasCustomAgentPersona(api.getAgentPersonaTemplate(style, "en")), false);
    }
  });
  await test("normal update and patch reject expert lock edits and deletion; explicit lifecycle retains identity", async () => {
    const { service } = fixture(); let state = await service.snapshot();
    await assert.rejects(service.createAgent(plain(expert), state.version), /hiring_flow/u);
    state = await service.updateExpert(registry => { registry.agents.push(plain(expert)); }, state.version);
    for (const patch of [{ name: "改名" }, { position: "改职位" }, { positionDescription: "改简介" }, { avatar: { kind: "default" } }, { persona: "私有正文" }, { capabilityIds: [] }, { styleId: "creative" }, { kind: "custom", expert: undefined }, { expert: { ...expert.expert, hired: false } }]) {
      await assert.rejects(service.patchAgent(expert.id, patch, state.version), /expert_agent_locked/u);
    }
    await assert.rejects(service.update(registry => { registry.agents = registry.agents.filter(agent => agent.id !== expert.id); }, state.version), /expert_agent_locked/u);
    await assert.rejects(service.removeAgent(expert.id, state.version), /dismissal_flow/u);
    state = await service.setOwner("journal", expert.id, state.version);
    state = await service.updateExpert(registry => { registry.agents.find(agent => agent.id === expert.id).expert.hired = false; }, state.version);
    assert.equal(state.registry.moduleOwners.journal, "sol"); assert.equal(state.registry.agents.find(agent => agent.id === expert.id).expert.lastConversationId, "conversation-1");
    await assert.rejects(service.setOwner("journal", expert.id, state.version), /agent_module_owner_invalid/u);
    await assert.rejects(service.updateExpert(registry => { registry.agents = registry.agents.filter(agent => agent.id !== expert.id); }, state.version), /history_required/u);
    await assert.rejects(service.updateExpert(registry => { registry.agents[0].name = "改总助"; }, state.version), /cannot_edit_custom_agent/u);
  });
  await test("mobile context uses persona without memory and style only when empty; old snapshot stays compatible", async () => {
    const registry = api.defaultAgentRegistry(); registry.agents[0].persona = "测试人格正文"; const { service } = fixture(registry);
    assert.match(await service.context(false), /测试人格正文/u); assert.doesNotMatch(await service.context(false), /当前基础风格/u);
    assert.match(await service.context(true), /测试人格正文/u);
    const old = { agentId: "sol", name: "旧名字", position: "旧职位", styleId: "creative" };
    const oldContext = await service.context(false, "sol", old); assert.match(oldContext, /当前基础风格/u); assert.doesNotMatch(oldContext, /测试人格正文/u);
    let state = await service.snapshot(); await service.patchAgent("sol", { persona: "  " }, state.version); assert.match(await service.context(false), /当前基础风格/u);
    state = await service.snapshot(); await service.updateExpert(draft => { draft.agents.push(plain(expert)); }, state.version);
    const expertContext = await service.context(false, expert.id); assert.doesNotMatch(expertContext, /当前基础风格/u); assert.match(expertContext, /公开简介/u);
  });
  for (const [device, prefix, create] of [["iPhone", "ip", api.createIPhoneAgentForm], ["iPad", "pd", api.createIPadAgentForm]]) {
    await test(`${device} persona edits keep template selected, confirm replacement and enforce Unicode limit`, async () => {
      const { service, settings } = fixture(); const root = document.createElement("main"); document.body.append(root);
      const ctx = { document, root, host: { settings: () => settings, agents: service, services: { refreshAgentIdentity: async () => {} } }, shell: { back: async () => true }, navigate: async () => {}, error: failure => { throw failure; } };
      const page = create(ctx, "sol"); root.append(page.content, page.footer); await flush();
      root.querySelector('[data-persona-template="analysis"]').click(); input(root.querySelector("textarea"), "自己写的正文");
      assert.equal(root.querySelector('[data-persona-template="analysis"]').getAttribute("aria-pressed"), "true");
      root.querySelector('[data-persona-template="creative"]').click(); assert.equal(root.querySelector("textarea").value, "自己写的正文");
      button(root, "保留修改").click(); assert.equal(root.querySelector("textarea").value, "自己写的正文");
      root.querySelector('[data-persona-template="creative"]').click(); button(root, "替换").click();
      assert.equal(root.querySelector("textarea").value, api.getAgentPersonaTemplate("creative"));
      input(root.querySelector("textarea"), "😀".repeat(4001)); assert.equal(api.agentPersonaLength(root.querySelector("textarea").value), 4000);
      assert.equal(root.querySelector(`.${prefix}-persona-count`).textContent, "4000 / 4000");
      button(root, "保存").click(); await flush(); assert.equal(api.agentPersonaLength(settings.agentRegistry.agents[0].persona), 4000); assert.equal(settings.agentRegistry.agents[0].styleId, "creative");
      page.dispose(); root.remove();
    });
    await test(`${device} expert form reveals only public introduction and uses dismissal hook`, async () => {
      const registry = api.defaultAgentRegistry(); registry.agents.push(plain(expert)); const { service, settings } = fixture(registry);
      let dismissals = 0, about = 0; const root = document.createElement("main"); document.body.append(root);
      const ctx = { document, root, host: { settings: () => settings, agents: service, services: { refreshAgentIdentity: async () => {}, dismissExpert: async id => { assert.equal(id, expert.id); dismissals++; }, showExpertAbout: () => { about++; } } }, shell: { back: async () => true }, navigate: async () => {}, error: failure => { throw failure; } };
      const page = create(ctx, expert.id); root.append(page.content, page.footer); await flush();
      assert.equal(root.querySelectorAll("textarea,input[type=text],[data-persona-template]").length, 0); assert.equal(root.querySelector(`.${prefix}-expert-summary`).textContent, "公开简介");
      assert.doesNotMatch(root.textContent, /能用的能力|删除这个 Agent/u); assert.equal(root.querySelectorAll(`.${prefix}-expert-lock`).length, 2);
      assert.equal([...root.querySelectorAll("button")].some(node => ["关于", "About"].includes(node.textContent.trim())), false);
      assert.equal(about, 0, "the form never exposes or invokes the retained internal About hook");
      button(root, "解聘").click(); await flush(); assert.equal(dismissals, 1);
      page.dispose(); root.remove();
    });
  }
  console.log(`Passed ${passed} persona scenarios (memory-only fixtures; native visual review remains separate).`);
} finally { dom.window.close(); }
