import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { mobileBuildOptions } from "./mobile-build.mjs";

const bundle = await esbuild.build(mobileBuildOptions("src/ui/iphone/workbench-pages.ts"));
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://iphone-pages.invalid" });
const { window } = dom, { document } = window, module = { exports: {} };
window.HTMLElement.prototype.scrollIntoView = function () {};
vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document, window, console,
  crypto: webcrypto, structuredClone, TextEncoder, TextDecoder, AbortController, URL, setTimeout, clearTimeout, atob, btoa,
  HTMLElement: window.HTMLElement, Element: window.Element, MutationObserver: window.MutationObserver,
  require(name) { assert.equal(name, "obsidian", `Unexpected Node dependency: ${name}`); return { setIcon(element, icon) { element.dataset.icon = icon; } }; }
});
const { createAgentFormPage } = module.exports;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`OK ${name}`); }
function fixture() {
  let registry = { schemaVersion: 1, legacyMigrationVersion: 1, agents: [
    { id: "sol", name: "总助", avatar: { kind: "preset", presetId: "sol" }, position: "总助", styleId: "execution", disabledCapabilityIds: ["hidden-desktop-capability"] },
    { id: "organizer", name: "整理员", avatar: { kind: "custom", dataUrl: "data:image/webp;base64,AA==" }, position: "整理资料", styleId: "analysis", capabilityIds: ["knowledge", "hidden-desktop-capability"] }
  ], moduleOwners: { journal: "sol", todos: "sol", finance: "sol", "knowledge-base": "organizer", "english-diary": "sol", "pdf-reading": "sol", review: "organizer" } };
  let version = "v1", writes = 0, backs = 0, removals = 0, failure, page;
  const errors = [], settings = { resources: { catalog: [], mcpConnections: {} }, get agentRegistry() { return registry; } };
  const root = document.createElement("main"); root.className = "echoink-iphone"; document.body.append(root);
  const context = { document, navigate: async () => {}, error(error) { errors.push(error); }, shell: { activePageId: "iphone-agent-form", async back() { if (await page.canLeave()) backs++; return true; } },
    host: { settings: () => settings, agents: { async snapshot() { return structuredClone({ registry, version }); }, async update(change, expected) {
      writes++; assert.equal(expected, version); if (failure) throw failure;
      const candidate = structuredClone(registry); change(candidate); registry = candidate; version = "v2"; return structuredClone({ registry, version });
    } }, services: { async refreshAgentIdentity() {}, async removeAgent() { removals++; } } }
  };
  return { context, root, get registry() { return registry; }, get writes() { return writes; }, get backs() { return backs; }, get removals() { return removals; }, errors,
    fail(error) { failure = error; }, async form(id) { page = createAgentFormPage(context, id); root.append(page.content, page.footer); await flush(); return page; },
    dispose() { page?.dispose(); root.remove(); } };
}
function input(element, value) { element.value = value; element.dispatchEvent(new window.Event("input", { bubbles: true })); }
function button(root, text) { const found = [...root.querySelectorAll("button")].find(button => button.textContent.trim() === text); assert.ok(found, `Button ${text} exists`); return found; }

try {
  await test("new Agent preset only prefills until one atomic save", async () => {
    const fixtureState = fixture(); await fixtureState.form();
    assert.equal(fixtureState.root.querySelectorAll(".ip-avatar-option").length, 15);
    fixtureState.root.querySelector(".ip-preset").click(); await flush();
    assert.equal(fixtureState.writes, 0); assert.equal(fixtureState.registry.agents.length, 2);
    const inputs = fixtureState.root.querySelectorAll("input[type=text]"); assert.equal(inputs[0].value, "整理员");
    input(inputs[0], "新整理员"); button(fixtureState.root, "创建").click(); await flush();
    assert.equal(fixtureState.writes, 1); assert.equal(fixtureState.backs, 1); assert.equal(fixtureState.registry.agents.length, 3);
    const created = fixtureState.registry.agents.find(agent => agent.name === "新整理员"); assert.ok(created);
    assert.equal(fixtureState.registry.moduleOwners["knowledge-base"], created.id);
    assert.equal(fixtureState.registry.moduleOwners.review, "organizer"); fixtureState.dispose();
  });
  await test("editing preserves custom avatar and unshown capabilities/owner", async () => {
    const fixtureState = fixture(); await fixtureState.form("organizer");
    assert.equal(fixtureState.root.querySelectorAll(".ip-avatar-option").length, 16);
    assert.equal(fixtureState.root.querySelector(".ip-avatar-option.is-selected").getAttribute("aria-label"), "头像 自定义头像");
    input(fixtureState.root.querySelector("input[type=text]"), "资料整理"); button(fixtureState.root, "保存").click(); await flush();
    const saved = fixtureState.registry.agents.find(agent => agent.id === "organizer"); assert.equal(saved.name, "资料整理");
    assert.ok(saved.capabilityIds.includes("hidden-desktop-capability")); assert.equal(saved.avatar.kind, "custom");
    assert.equal(fixtureState.registry.moduleOwners.review, "organizer"); assert.equal(fixtureState.writes, 1); fixtureState.dispose();
  });
  await test("save conflict retains exact typed input and does not navigate", async () => {
    const fixtureState = fixture(); await fixtureState.form("organizer"); fixtureState.fail(new Error("Agent 配置已变化"));
    input(fixtureState.root.querySelector("input[type=text]"), "未保存的新名字"); button(fixtureState.root, "保存").click(); await flush();
    assert.equal(fixtureState.root.querySelector("input[type=text]").value, "未保存的新名字");
    assert.match(fixtureState.root.querySelector(".ip-error").textContent, /Agent 配置已变化/u);
    assert.equal(fixtureState.backs, 0); assert.equal(fixtureState.registry.agents[1].name, "整理员");
    assert.equal(button(fixtureState.root, "保存").disabled, false); fixtureState.dispose();
  });
  await test("dirty leave is inline and can keep editing or discard", async () => {
    const fixtureState = fixture(); const page = await fixtureState.form("organizer");
    assert.equal(await page.canLeave(), true); input(fixtureState.root.querySelector("input[type=text]"), "还没保存");
    const keep = page.canLeave(); button(fixtureState.root, "继续编辑").click(); assert.equal(await keep, false);
    assert.equal(fixtureState.root.querySelector("input[type=text]").value, "还没保存");
    const discard = page.canLeave(); button(fixtureState.root, "放弃修改").click(); assert.equal(await discard, true);
    assert.equal(fixtureState.writes, 0); fixtureState.dispose();
  });
  await test("general assistant has no remove action and disabled hidden grant survives", async () => {
    const fixtureState = fixture(); await fixtureState.form("sol"); assert.equal(fixtureState.root.querySelector(".ip-danger-zone"), null);
    input(fixtureState.root.querySelector("input[type=text]"), "我的总助"); button(fixtureState.root, "保存").click(); await flush();
    assert.ok(fixtureState.registry.agents[0].disabledCapabilityIds.includes("hidden-desktop-capability")); assert.equal(fixtureState.removals, 0); fixtureState.dispose();
  });
  await test("custom Agent removal uses the handoff service after inline confirmation", async () => {
    const fixtureState = fixture(); await fixtureState.form("organizer"); button(fixtureState.root, "删除这个 Agent").click();
    assert.equal(fixtureState.removals, 0); button(fixtureState.root, "删除并交回总助").click(); await flush();
    assert.equal(fixtureState.removals, 1); assert.equal(fixtureState.writes, 0); assert.equal(fixtureState.backs, 1); fixtureState.dispose();
  });
  console.log(`${passed} iPhone page scenarios passed`);
} finally { dom.window.close(); }
