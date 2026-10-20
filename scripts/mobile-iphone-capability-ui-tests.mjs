import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { mobileBuildOptions } from "./mobile-build.mjs";

const build = await esbuild.build(mobileBuildOptions("src/ui/iphone/capability-pages.ts"));
const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://iphone-capabilities.invalid" });
const { document, Event } = dom.window;
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
const notices = [], exported = { exports: {} };
const icon = (parent, name) => { const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("data-icon", name); parent.replaceChildren(svg); };
vm.runInNewContext(build.outputFiles[0].text, {
  module: exported, exports: exported.exports, document, window: dom.window, console, structuredClone, AbortController, setTimeout, clearTimeout, atob, btoa, TextEncoder, TextDecoder,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, SVGElement: dom.window.SVGElement,
  require: name => { assert.equal(name, "obsidian"); return { Notice: class { constructor(message) { notices.push(message); } }, setIcon: icon, getIcon: name => { const span = document.createElement("span"); icon(span, name); return span.firstChild; } }; }
});
const { IPhoneCapabilityPages } = exported.exports;
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const skills = [
  { id: "todo-operations", name: "待办操作", description: "维护待办", builtin: true, enabled: false, mobileAvailable: true, contentPath: "Skills/todo-operations/SKILL.md", sourceLabel: "内置技能", icon: "list-todo", agents: [{ id: "assistant", name: "总助", allowed: true }], content: "# saved instruction", version: "skill-v1" },
  { id: "obsidian-cli", name: "Obsidian CLI", description: "命令行", builtin: true, enabled: true, mobileAvailable: false, unavailableReason: "只能在电脑上用", contentPath: null, sourceLabel: "EchoInk 内置", icon: "terminal", agents: [], content: "CLI body", version: "cli-v1" }
];
const calls = { saveSkill: [], toggles: [], discover: [], saveMcp: [], test: [], saveTavily: [], copy: [], editAgent: [] };
let conflict = true, mcpConflict = true, tavilyFailure = true, testPending = false, activeSignal, mcpDraft = { id: "server", name: "远程工具", description: "真实配置", enabled: true, transport: "http", readonly: false, url: "https://tools.invalid/mcp", headers: { Authorization: "Bearer local-secret" }, trusted: false, tools: [], toolPolicies: { oldTool: { enabled: false, trusted: false } }, version: "mcp-v1", status: "configured" };
let tavily = { enabled: false, apiKey: "", version: "tavily-v1" };
const service = {
  async listSkills() { return structuredClone(skills); },
  async readSkill(id) { return structuredClone(skills.find(skill => skill.id === id)); },
  async setSkillEnabled(id, enabled) { calls.toggles.push([id, enabled]); skills.find(skill => skill.id === id).enabled = enabled; return structuredClone(skills.find(skill => skill.id === id)); },
  async saveSkill(id, content, version) { calls.saveSkill.push({ id, content, version }); if (conflict) throw new Error("文件已在其他地方修改"); const skill = skills.find(skill => skill.id === id); Object.assign(skill, { content, version: "skill-v2" }); return structuredClone(skill); },
  defaultSkillContent() { return "# default instruction"; },
  async listMcp() { return [{ ...structuredClone(mcpDraft), statusLabel: "已配置" }, { id: "desktop", name: "本地工具", description: "", transport: "stdio", readonly: true, enabled: true, status: "desktop-only", statusLabel: "只能在电脑上用", trusted: false, tools: [], toolPolicies: {}, version: "desktop-v1" }]; },
  async createMcpDraft(id) { return id === "desktop" ? { ...structuredClone(mcpDraft), id, transport: "stdio", readonly: true } : structuredClone(mcpDraft); },
  async discoverMcp(draft, signal) { calls.discover.push(structuredClone(draft)); activeSignal = signal; return { ...draft, status: "connected", tools: [{ name: "lookup", description: "查询资料", readOnly: true, destructive: false, inputSchema: {} }] }; },
  async saveMcp(draft) { calls.saveMcp.push(structuredClone(draft)); if (mcpConflict) throw new Error("配置冲突 Bearer local-secret"); mcpDraft = structuredClone(draft); return { ...draft, statusLabel: "已连接" }; },
  async setMcpEnabled() { throw new Error("Unexpected immediate MCP persistence"); },
  readTavily() { return { ...tavily }; },
  async saveTavily(draft) { calls.saveTavily.push({ ...draft }); if (tavilyFailure) throw new Error(`保存失败 ${draft.apiKey}`); tavily = { ...draft, version: "tavily-v2" }; return { ...tavily }; },
  async testTavily(draft, signal) { calls.test.push({ ...draft }); activeSignal = signal; if (testPending) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(`aborted ${draft.apiKey}`)), { once: true })); return { results: [{ title: "real result" }] }; }
};
Object.defineProperty(dom.window.navigator, "clipboard", { value: { async writeText(path) { calls.copy.push(path); } } });
const pages = [{ id: "base", content: document.createElement("div") }];
const shell = {
  hasPage: id => pages.some(page => page.id === id), get activePageId() { return pages.at(-1).id; },
  async push(page) { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.push(page); document.body.replaceChildren(page.content); return true; },
  async back() { if (pages.at(-1).canLeave && !await pages.at(-1).canLeave()) return false; pages.pop().dispose?.(); document.body.replaceChildren(pages.at(-1).content); return true; },
  async backTo(id) { while (pages.at(-1).id !== id) if (!await this.back()) return false; return true; }
};
const ctx = { document, shell, host: { services: { capabilities: service }, settings: () => ({ settingsLanguage: "zh" }), agents: { async snapshot() { return { registry: { agents: [{ id: "assistant", name: "总助", avatar: { kind: "preset", presetId: "nova" } }] } }; } }, renderMarkdown: (text, parent) => { parent.textContent = text; } }, error: error => { throw error; } };
const ui = new IPhoneCapabilityPages(ctx, async id => { calls.editAgent.push(id); await shell.push({ id: "agent-edit", content: document.createElement("div") }); });
const body = () => pages.at(-1).content;
const button = text => [...body().querySelectorAll("button")].find(item => item.textContent.trim() === text);
const click = async text => { const target = button(text); assert.ok(target, `Button ${text} exists`); target.click(); await tick(); };
const input = (label, value) => { const node = body().querySelector(`[aria-label="${label}"]`); assert.ok(node, `Input ${label} exists`); node.value = value; node.dispatchEvent(new Event("input", { bubbles: true })); return node; };
try {
  await ui.open(); assert.match(body().textContent, /0 个启用/); assert.match(body().textContent, /0 \/ 0 启用/); assert.doesNotMatch(body().textContent, /Notion|飞书/);
  await click("我的 Skill0 / 0 启用"); assert.match(body().textContent, /还没有我的 Skill/); await shell.back();
  await click("内置技能0 个启用"); assert.equal(body().querySelectorAll('[role="switch"]').length, 1); assert.equal(body().querySelector('[data-icon="list-todo"]') !== null, true);
  const toggle = body().querySelector('[role="switch"]'); toggle.checked = true; toggle.dispatchEvent(new Event("change", { bubbles: true })); await tick(); assert.deepEqual(calls.toggles, [["todo-operations", true]]); assert.equal(shell.activePageId, "iphone-settings-skills-builtin");
  body().querySelector(".ip-cap-skill-main").click(); await tick(); assert.equal(pages.at(-1).title, "待办操作");
  body().querySelector('[aria-label="复制路径"]').click(); await tick(); assert.deepEqual(calls.copy, ["Skills/todo-operations/SKILL.md"]);
  const detailToggle = body().querySelector('[role="switch"]'); detailToggle.checked = false; detailToggle.dispatchEvent(new Event("change")); await tick(); assert.match(body().textContent, /saved instruction/, "A disabled Skill remains readable");
  await click("编辑"); const editor = body().querySelector("textarea"); input("Skill 指令", "my draft");
  await click("总助"); assert.deepEqual(calls.editAgent, ["assistant"]); await shell.back(); assert.equal(body().querySelector("textarea"), editor); assert.equal(editor.value, "my draft");
  await click("恢复默认"); assert.equal(editor.value, "# default instruction"); assert.equal(calls.saveSkill.length, 0);
  input("Skill 指令", "keep on conflict"); await click("保存"); assert.equal(body().querySelector("textarea").value, "keep on conflict"); assert.match(body().textContent, /其他地方修改/); assert.equal(calls.saveSkill[0].version, "skill-v1");
  const pendingBack = shell.back(); await tick(); await click("继续编辑"); assert.equal(await pendingBack, false); assert.equal(body().querySelector("textarea").value, "keep on conflict");
  conflict = false; await click("保存"); assert.equal(body().querySelector("textarea"), null); assert.match(body().textContent, /keep on conflict/);
  await shell.back(); await shell.back(); await click("本地工具只能在电脑上用"); assert.equal(body().querySelector("input"), null); assert.equal(button("连接并发现工具"), undefined); assert.match(body().textContent, /只能在电脑上用/); await shell.back();
  await click("远程工具已配置"); assert.equal(body().querySelector('[aria-label="请求头值"]').type, "password"); assert.doesNotMatch(body().textContent, /local-secret/);
  await click("连接并发现工具"); assert.equal(calls.discover.length, 1); assert.equal(calls.saveMcp.length, 0); assert.match(body().textContent, /lookup/);
  const trusted = [...body().querySelectorAll("label")].find(label => label.textContent === "信任此服务").querySelector("input"); trusted.checked = true; trusted.dispatchEvent(new Event("change"));
  const policy = [...body().querySelectorAll("label")].find(label => label.textContent === "允许调用").querySelector("input"); policy.checked = true; policy.dispatchEvent(new Event("change"));
  await click("保存"); assert.equal(shell.activePageId, "iphone-settings-mcp-server"); assert.match(body().textContent, /配置冲突/); assert.doesNotMatch(body().textContent, /local-secret/); assert.equal(body().querySelector('[aria-label="请求头值"]').value, "Bearer local-secret");
  mcpConflict = false; await click("保存"); assert.equal(calls.saveMcp[1].headers.Authorization, "Bearer local-secret"); assert.equal(calls.saveMcp[1].trusted, true); assert.equal(calls.saveMcp[1].toolPolicies.lookup.enabled, true); assert.equal(calls.saveMcp[1].toolPolicies.oldTool.enabled, false);
  await click("Tavily 联网搜索未填写 Key"); input("API Key", "private-key"); await click("测试连接"); assert.equal(calls.saveTavily.length, 0); assert.match(body().textContent, /连接成功 · 1 条结果/); assert.equal(calls.test[0].apiKey, "private-key");
  testPending = true; await click("测试连接"); await click("停止"); assert.equal(activeSignal.aborted, true); assert.doesNotMatch(body().textContent, /private-key/); assert.equal(body().querySelector('[aria-label="API Key"]').value, "private-key");
  await click("保存"); assert.equal(shell.activePageId, "iphone-settings-tavily"); assert.equal(body().querySelector('[aria-label="API Key"]').value, "private-key"); assert.doesNotMatch(body().textContent, /private-key/);
  tavilyFailure = false; await click("保存"); assert.equal(calls.saveTavily[1].apiKey, "private-key");
  await click("Tavily 联网搜索已填写 Key"); testPending = true; await click("测试连接"); await shell.back(); await tick(); assert.equal(activeSignal.aborted, true, "Leaving a clean testing page aborts its request");
  while (pages.length > 1) { await shell.back(); }
  console.log("PASS iPhone capability pages: real counts, independent toggles, Skill drafts/conflicts/defaults, HTTP discovery/policy/save, stdio readonly, Tavily cancellation/secrets");
} finally { for (const page of pages) page.dispose?.(); dom.window.close(); }
