import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build(mobileBuildOptions("src/ui/ipad/capability-pages.ts"));
const dom = new JSDOM("<!doctype html><body><aside><textarea>right pane draft</textarea></aside><main></main></body>", { pretendToBeVisual: true, url: "https://ipad-capabilities.invalid" });
const notices = [], copied = [];
Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async value => copied.push(value) } });
const module = { exports: {} };
vm.runInNewContext(build.outputFiles[0].text, { module, exports: module.exports, document: dom.window.document, window: dom.window,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, AbortController, structuredClone, URL, setTimeout, clearTimeout, console, atob, btoa, TextEncoder, TextDecoder,
  require(id) { assert.equal(id, "obsidian"); return { setIcon: (node, icon) => { node.dataset.icon = icon; }, Notice: class { constructor(value) { notices.push(value); } } }; } });
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const root = dom.window.document.querySelector("main"), right = dom.window.document.querySelector("aside textarea");
const skills = [
  { id: "todo-operations", name: "待办操作", builtin: true, enabled: false, mobileAvailable: true, contentPath: "Skills/todo/SKILL.md", sourceLabel: "EchoInk 内置", description: "处理待办", icon: "list-todo", agents: [{ id: "general", name: "总助", allowed: true }], content: "saved instructions", version: "v1" },
  { id: "obsidian-cli", name: "Obsidian CLI", builtin: true, enabled: true, mobileAvailable: false, contentPath: null, sourceLabel: "EchoInk 内置", description: "电脑命令", icon: "terminal", agents: [], content: "CLI instructions", version: "v1" }
];
const desktop = { id: "desktop", name: "本地服务", description: "", enabled: true, transport: "stdio", readonly: true, status: "desktop-only", statusLabel: "只能在电脑上用", trusted: true, tools: [], toolPolicies: {}, version: "v1" };
const settings = { settingsLanguage: "zh-CN", resources: { tick: 0 }, agentRegistry: { agents: [{ id: "general", name: "总助", avatar: { kind: "default" } }] } };
let tavily = { enabled: false, apiKey: "", version: "v1" }, failSave = false, failToggle = false, failMcpSave = false, failTavilySave = false, testFailure = "", pendingDiscovery = false, pendingTest = false, discoveryAborted = false, testAborted = false;
const writes = { skills: [], mcp: [], tavily: [] }, stack = [], editedAgents = [];
const api = {
  listSkills: async () => structuredClone(skills), readSkill: async id => structuredClone(skills.find(skill => skill.id === id)),
  setSkillEnabled: async (id, enabled) => { if (failToggle) throw new Error("toggle failed"); const item = skills.find(skill => skill.id === id); item.enabled = enabled; settings.resources.tick++; return structuredClone(item); },
  saveSkill: async (id, content, version) => { writes.skills.push({ id, content, version }); if (failSave) throw new Error("外部内容已更改"); const item = skills.find(skill => skill.id === id); Object.assign(item, { content, version: "v2" }); settings.resources.tick++; return structuredClone(item); },
  defaultSkillContent: () => "default instructions", listMcp: async () => [desktop],
  createMcpDraft: async id => id ? { ...desktop, url: "", headers: {} } : { id: "remote", name: "", description: "", enabled: true, transport: "http", readonly: false, url: "", headers: {}, trusted: false, tools: [], toolPolicies: {}, version: "" },
  discoverMcp: async (draft, signal) => {
    if (pendingDiscovery) return new Promise((resolve, reject) => signal.addEventListener("abort", () => { discoveryAborted = true; reject(new Error("cancelled")); }, { once: true }));
    return { ...draft, trusted: false, status: "connected", discoveredAt: 1, tools: [{ name: "read_page", description: "Read page", readOnly: true, destructive: false, inputSchema: {} }] };
  },
  saveMcp: async draft => { writes.mcp.push(structuredClone(draft)); if (failMcpSave) throw new Error(`save failed: ${draft.headers.Authorization}`); settings.resources.tick++; return draft; },
  setMcpEnabled: async () => { throw new Error("not used by draft form"); },
  readTavily: () => ({ ...tavily }), saveTavily: async draft => { writes.tavily.push({ ...draft }); if (failTavilySave) throw new Error(`save failed: ${draft.apiKey}`); tavily = { ...draft, version: "v2" }; settings.resources.tick++; return tavily; },
  testTavily: async (draft, signal) => { if (testFailure) throw new Error(testFailure); if (pendingTest) return new Promise((resolve, reject) => signal.addEventListener("abort", () => { testAborted = true; reject(new Error("cancelled")); }, { once: true })); return { results: [] }; }
};
const mount = page => { const panel = dom.window.document.createElement("section"); panel.className = "echoink-ipad-page"; panel.append(page.content); if (page.footer) panel.append(page.footer); root.append(panel); page.panel = panel; stack.push(page); };
const ctx = { root, document: dom.window.document, host: { services: { capabilities: api }, settings: () => settings, renderMarkdown: (text, node) => { node.textContent = text; } },
  error: error => notices.push(String(error)), refresh: () => root.dispatchEvent(new dom.window.Event("pd-settings-refresh")),
  async push(page) { const current = stack.at(-1); if (current?.canLeave && !await current.canLeave()) { page.dispose?.(); return false; } if (current) current.panel.hidden = true; mount(page); return true; },
  async back() { const page = stack.at(-1); if (page?.canLeave && !await page.canLeave()) return false; stack.pop(); page.dispose?.(); page.panel.remove(); if (stack.at(-1)) stack.at(-1).panel.hidden = false; return true; }, shell: {} };
const current = () => stack.at(-1);
const button = text => [...current().panel.querySelectorAll("button")].find(node => node.textContent.trim() === text);
const click = async text => { const node = button(text); assert.ok(node, `button exists: ${text}`); node.click(); await tick(); };
const input = (label, value) => { const node = current().content.querySelector(`[aria-label="${label}"]`); assert.ok(node, `input exists: ${label}`); node.value = value; node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); return node; };
const unhandled = []; const collect = error => unhandled.push(error); process.on("unhandledRejection", collect);
try {
  mount(module.exports.createCapabilityPage(ctx, async id => { editedAgents.push(id); return ctx.push({ id: "agent-editor", title: "Agent", content: dom.window.document.createElement("div") }); })); await tick();
  assert.match(current().content.textContent, /0 个启用/); assert.match(current().content.textContent, /0 \/ 0 启用/);
  await click("内置技能0 个启用");
  assert.equal(current().content.querySelectorAll("[role=switch]").length, 1, "desktop-only skill has no switch");
  assert.equal(current().content.querySelector("[data-skill-id=todo-operations] [data-icon]").dataset.icon, "list-todo");
  failToggle = true; const toggle = current().content.querySelector("[role=switch]"); toggle.checked = true; toggle.dispatchEvent(new dom.window.Event("change")); await tick();
  assert.equal(toggle.checked, false); assert.match(current().content.textContent, /toggle failed/); failToggle = false;
  current().content.querySelector("[data-skill-id=obsidian-cli]").click(); await tick(); assert.equal(current().content.querySelector('[role="switch"]'), null); assert.equal(current().content.querySelector('[aria-label="复制路径"]'), null, "builtin source has no fabricated copy path");
  await click("编辑"); input("Skill 指令", "cancelled CLI edit"); await click("取消"); assert.equal(writes.skills.length, 0, "cancelled desktop-only edit never writes"); await ctx.back();
  current().content.querySelector("[data-skill-id=todo-operations]").click(); await tick();
  assert.match(current().content.textContent, /saved instructions/, "disabled skill remains readable");
  current().content.querySelector('[aria-label="复制路径"]').click(); await tick(); assert.deepEqual(copied, ["Skills/todo/SKILL.md"]);
  await click("编辑"); const editor = input("Skill 指令", "my draft");
  await click("恢复默认"); assert.equal(editor.value, "default instructions"); assert.equal(writes.skills.length, 0);
  input("Skill 指令", "conflicting draft"); failSave = true; await click("保存");
  assert.equal(current().content.querySelector("textarea").value, "conflicting draft"); assert.match(current().content.textContent, /外部内容已更改/);
  await click("总助"); assert.deepEqual(editedAgents, ["general"]); assert.equal(current().id, "agent-editor");
  await ctx.back(); assert.equal(current().content.querySelector("textarea"), editor, "Agent editor preserves central Skill draft nodes");
  assert.equal(right.value, "right pane draft");
  const denied = ctx.back(); await tick(); await click("继续编辑"); assert.equal(await denied, false); assert.equal(editor.value, "conflicting draft");
  failSave = false; await click("保存"); assert.equal(skills[0].content, "conflicting draft"); assert.equal(writes.skills.at(-1).version, "v1");
  await ctx.back(); await ctx.back(); await tick();
  await click("本地服务只能在电脑上用"); assert.equal(current().content.querySelectorAll("button,input").length, 0, "stdio is read only"); await ctx.back();
  await click("添加 MCP 服务"); input("连接名称", "Remote"); input("接口地址", "https://remote.invalid/mcp"); await click("添加请求头"); input("名称", "Authorization"); const credential = input("值", "private-token"); assert.equal(credential.type, "password");
  assert.ok(!current().content.textContent.includes("private-token"));
  const serverTrust = current().content.querySelector('[aria-label="信任此服务"]'); serverTrust.checked = true; serverTrust.dispatchEvent(new dom.window.Event("change"));
  await click("连接并发现工具"); assert.match(current().content.textContent, /read_page/); assert.equal(writes.mcp.length, 0, "discovery must not save"); assert.equal(serverTrust.checked, false, "discovery trust reset is visible");
  for (const label of ["信任此服务", "允许调用", "信任此工具"]) { const control = current().content.querySelector(`[aria-label="${label}"]`); control.checked = true; control.dispatchEvent(new dom.window.Event("change")); }
  pendingDiscovery = true; await click("连接并发现工具"); await click("停止"); assert.equal(discoveryAborted, true); assert.equal(credential.value, "private-token");
  failMcpSave = true; await click("保存"); assert.equal(credential.value, "private-token"); assert.match(current().content.textContent, /\[redacted\]/); assert.ok(!current().content.textContent.includes("private-token"));
  failMcpSave = false; await click("保存"); assert.equal(writes.mcp.length, 2); assert.equal(writes.mcp[1].headers.Authorization, "private-token"); assert.equal(writes.mcp[1].trusted, true); assert.equal(writes.mcp[1].toolPolicies.read_page.trusted, true);
  await click("Tavily 联网搜索未填写 Key"); const testButton = button("测试连接"); assert.equal(testButton.disabled, true, "no Key cannot send a test");
  const searchEnabled = current().content.querySelector('[role="switch"]'); searchEnabled.checked = true; searchEnabled.dispatchEvent(new dom.window.Event("change")); await tick(); assert.equal(button("保存").disabled, true);
  input("API Key", "private-search-key"); testFailure = "Tavily 积分不足，请检查账户额度。"; await click("测试连接"); assert.match(current().content.textContent, /积分不足/, "service quota error must not become a network error"); testFailure = "";
  failTavilySave = true; await click("保存"); assert.equal(current().content.querySelector('[aria-label="API Key"]').value, "private-search-key"); assert.match(current().content.textContent, /\[redacted\]/); assert.ok(!current().content.textContent.includes("private-search-key"));
  failTavilySave = false; await click("保存"); assert.equal(current().id, "ipad-settings-caps"); assert.equal(tavily.enabled, true);
  await click("Tavily 联网搜索已填写 Key"); pendingTest = true; await click("测试连接"); await click("停止"); assert.match(current().content.textContent, /测试已取消/); testAborted = false;
  await click("测试连接"); const tavilyPage = current(); tavilyPage.dispose(); await tick(); assert.equal(testAborted, true, "disposing aborts test");
  assert.equal(writes.tavily.length, 2); assert.equal(right.value, "right pane draft");
  assert.equal(unhandled.length, 0, "no unhandled asynchronous failures");
  console.log("iPad capability UI: real counts/icons, switch rollback, disabled read/edit, default draft, conflict retention, central Agent stack, leave guard, private MCP discovery/trust/policies/abort, stdio read-only, Tavily no-Key/quota/save retention/cancel/dispose passed.");
} finally { while (stack.length) { const page = stack.pop(); page.dispose?.(); } process.off("unhandledRejection", collect); dom.window.close(); }
