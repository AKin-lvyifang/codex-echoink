import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { openTestModals } from "obsidian";
import { DesktopAgentSettings, type DesktopAgentSettingsHost } from "../settings/agent-settings";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import type { AgentEditorSaveBaseline } from "../ui/codex-view/agent-editor-contract";
import { DEFAULT_SETTINGS } from "../settings/settings";
import { defaultAgentRegistry, normalizeAgentRegistry, setModuleOwner } from "../agents/registry";
import { GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "../agents/types";
import { disposeOriginControls, type OriginSelectElement } from "../settings/origin-controls";

export async function runAgentSettingsTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://agent-settings.invalid" });
  const win = dom.window as any;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement", "DocumentFragment", "Node", "Element", "Event", "CustomEvent", "MutationObserver", "ResizeObserver", "getComputedStyle"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value: key === "getComputedStyle" ? win.getComputedStyle.bind(win) : win[key] });
  }
  const create = function(this: HTMLElement, tag: string, options: any = {}) {
    const el = this.ownerDocument.createElement(tag); if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
    this.appendChild(el); return el;
  };
  Object.assign(win.Element.prototype, {
    createEl: create, createDiv(options: any) { return create.call(this, "div", options); }, createSpan(options: any) { return create.call(this, "span", options); },
    empty() { this.replaceChildren(); }, setText(value: string) { this.textContent = value; }, setAttr(key: string, value: string) { this.setAttribute(key, value); },
    addClass(...values: string[]) { this.classList.add(...values); }, removeClass(...values: string[]) { this.classList.remove(...values); }, toggleClass(value: string, active: boolean) { this.classList.toggle(value, active); },
    scrollIntoView() {}, attachEvent() {}, detachEvent() {}, hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}
  });
  win.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const container = () => { const el = document.createElement("div"); el.className = "echoink-settings-demo"; document.body.appendChild(el); return el; };
  const button = (parent: Element, text: string) => Array.from(parent.querySelectorAll<HTMLButtonElement>("button")).find(value => value.textContent === text)!;
  const nameField = (parent: Element) => parent.querySelector<HTMLInputElement>('[data-field="name"]')!;
  const changeName = (parent: Element, name: string) => { const input = nameField(parent); input.value = name; input.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const settings = structuredClone(DEFAULT_SETTINGS); settings.settingsLanguage = "zh-CN"; settings.agentRegistry = defaultAgentRegistry();
  const pluginIdentity = {};
  const saveBaselines: Array<AgentEditorSaveBaseline | undefined> = [];
  let failOwner = false, failAgent = false, redraws = 0, focused = "", saves = 0, countReads = 0, deletes = 0;
  let deletionCounts = { total: 3, running: 0 };
  const host: DesktopAgentSettingsHost = {
    settings, draftCacheKey: pluginIdentity, loadResources: async () => [], getCapabilityAvailability: () => ({ available: true }),
    saveAgent: async (agent: AgentDefinition, moduleIds: readonly AgentModuleId[], baseline?: AgentEditorSaveBaseline) => {
      saveBaselines.push(baseline ? structuredClone(baseline) : undefined);
      if (failAgent) throw new Error("Agent 保存失败");
      const current = settings.agentRegistry;
      const next = normalizeAgentRegistry({ ...current, agents: current.agents.some(value => value.id === agent.id) ? current.agents.map(value => value.id === agent.id ? agent : value) : [...current.agents, agent] });
      for (const module of moduleIds) next.moduleOwners[module] = agent.id;
      settings.agentRegistry = next; saves++;
    },
    deleteAgent: async id => { assert.notEqual(id, GENERAL_ASSISTANT_ID); deletes++; settings.agentRegistry = { ...settings.agentRegistry, agents: settings.agentRegistry.agents.filter(agent => agent.id !== id) }; },
    getDeleteCounts: async () => { countReads++; return deletionCounts; },
    setAgentModuleOwner: async (module, id) => { if (failOwner) throw new Error("磁盘已满"); settings.agentRegistry = setModuleOwner(settings.agentRegistry, module, id); }
  };
  const panel = new DesktopAgentSettings(host, { redraw: () => redraws++, restoreFocus: value => { focused = value; } });
  const root = container();
  try {
    panel.renderSummary(root);
    assert.equal(root.querySelectorAll(".echoink-agent-settings-row").length, 1); assert.equal(root.querySelectorAll(".echoink-agent-owner-row").length, 7);
    assert.equal(root.querySelectorAll('[role="combobox"]').length, 7); assert.ok(root.textContent?.includes("内置")); assert.equal(saves, 0);
    settings.agentRegistry.agents.push({ id: "editor", name: "整理员", avatar: { kind: "preset", presetId: "nova" }, position: "整理知识", styleId: "analysis", capabilityIds: ["knowledge"] });
    panel.renderSummary(root);
    const owner = root.querySelector<OriginSelectElement>('[data-echoink-focus-key="agent:owner:journal"]')!;
    owner.value = "editor"; owner.dispatchEvent(new win.Event("change", { bubbles: true })); assert.equal(owner.disabled, true); await settle();
    assert.equal(settings.agentRegistry.moduleOwners.journal, "editor"); assert.equal(settings.agentRegistry.moduleOwners.todos, GENERAL_ASSISTANT_ID);
    failOwner = true; const todoOwner = root.querySelector<OriginSelectElement>('[data-echoink-focus-key="agent:owner:todos"]')!;
    todoOwner.value = "editor"; todoOwner.dispatchEvent(new win.Event("change", { bubbles: true })); await settle(); assert.equal(todoOwner.value, GENERAL_ASSISTANT_ID); assert.ok(root.textContent?.includes("负责人未保存")); assert.equal(settings.agentRegistry.moduleOwners.journal, "editor"); failOwner = false;

    panel.open(GENERAL_ASSISTANT_ID); panel.renderDetail(root); await settle(); assert.equal(panel.isDetail, true); assert.equal(root.querySelector('[data-action="delete-agent"]'), null);
    assert.equal(root.querySelector('[aria-label="返回 Agent 设置"]') !== null, true);
    changeName(root, "设置里的总助"); const retained = nameField(root); panel.suspend(); disposeOriginControls(root); root.empty();
    let detachedLeave = 0; panel.requestLeave(() => detachedLeave++); panel.renderDetail(root);
    assert.equal(nameField(root), retained); assert.equal(retained.value, "设置里的总助");
    assert.ok(root.querySelector(".echoink-settings-inline-confirm")); button(root, "继续编辑").click(); assert.equal(detachedLeave, 0);
    root.querySelector<HTMLButtonElement>(".echoink-agent-editor-back")!.click(); assert.ok(root.querySelector(".echoink-settings-inline-confirm")); button(root, "继续编辑").click(); assert.equal(panel.hasDraft, true);
    failAgent = true; root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); assert.equal(panel.submitting, true); await settle();
    assert.equal(settings.agentRegistry.agents[0].name, "总助"); assert.equal(nameField(root).value, "设置里的总助"); assert.ok(root.textContent?.includes("Agent 保存失败"));
    assert.equal(saveBaselines[0]?.agent.name, "总助"); assert.equal(saveBaselines[0]?.moduleIds.includes("journal"), false);
    failAgent = false; root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle(); assert.equal(panel.isDetail, false); assert.equal(settings.agentRegistry.agents[0].name, "设置里的总助"); assert.equal(focused, "agent:sol:edit");

    const sidebarRoot = container(); const sidebar = new AgentEditorController({ ...host, onClose() {} }); sidebar.open(GENERAL_ASSISTANT_ID); sidebar.render(sidebarRoot); await settle();
    assert.equal(nameField(sidebarRoot).value, "设置里的总助"); changeName(sidebarRoot, "侧栏未保存草稿"); sidebarRoot.querySelector<HTMLButtonElement>(".echoink-agent-editor-back")!.click(); assert.equal(sidebarRoot.querySelector(".echoink-settings-inline-confirm"), null);
    panel.open(GENERAL_ASSISTANT_ID); panel.renderDetail(root); await settle(); assert.equal(nameField(root).value, "侧栏未保存草稿");
    let left = 0; panel.requestLeave(() => left++); button(root, "继续编辑").click(); assert.equal(left, 0); panel.requestLeave(() => left++); button(root, "放弃修改").click(); await settle(); assert.equal(left, 1); assert.equal(panel.isDetail, false);
    panel.open(); panel.renderDetail(root); await settle(); root.querySelector<HTMLButtonElement>('[data-preset="organizer"]')!.click(); await settle(); assert.equal(panel.hasDraft, true); assert.equal(nameField(root).value, "整理员");
    panel.requestLeave(() => {}); button(root, "放弃修改").click(); await settle();

    panel.open("editor"); panel.renderDetail(root); await settle(); root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle(); assert.equal(countReads, 1); assert.ok(root.textContent?.includes("3 件事会交给总助")); assert.equal(root.textContent?.includes("0 件正在进行"), false); button(root, "取消删除").click();
    deletionCounts = { total: 4, running: 2 }; root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle(); assert.ok(root.textContent?.includes("2 件正在进行")); root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click(); await settle(); assert.equal(deletes, 1); assert.equal(panel.isDetail, false); assert.equal(openTestModals.length, 0);

    const conflictSettings = structuredClone(DEFAULT_SETTINGS); conflictSettings.agentRegistry = defaultAgentRegistry();
    const openingAgent = structuredClone(conflictSettings.agentRegistry.agents[0]);
    const openingModules = Object.keys(conflictSettings.agentRegistry.moduleOwners) as AgentModuleId[];
    const conflictBaselines: Array<AgentEditorSaveBaseline | undefined> = [];
    const conflictHost: DesktopAgentSettingsHost = { ...host, settings: conflictSettings, draftCacheKey: {},
      saveAgent: async (_agent, _modules, baseline) => { conflictBaselines.push(baseline ? structuredClone(baseline) : undefined); throw new Error("并发身份冲突"); } };
    const cachedRoot = container();
    const cachedSidebar = new AgentEditorController({ ...conflictHost, onClose() {} });
    cachedSidebar.open(GENERAL_ASSISTANT_ID); cachedSidebar.render(cachedRoot); await settle();
    changeName(cachedRoot, "旧表单的修改"); cachedSidebar.dispose();
    conflictSettings.agentRegistry.agents[0].name = "另一入口已改名";
    conflictSettings.agentRegistry.moduleOwners.journal = "another-agent";
    const conflictPanel = new DesktopAgentSettings(conflictHost, { redraw() {} });
    try {
      conflictPanel.open(GENERAL_ASSISTANT_ID); conflictPanel.renderDetail(cachedRoot); await settle();
      assert.equal(nameField(cachedRoot).value, "旧表单的修改");
      cachedRoot.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
      assert.deepEqual(conflictBaselines[0], { agent: openingAgent, moduleIds: openingModules }, "cached drafts keep the original identity and ownership baseline across entry points");
      assert.equal(nameField(cachedRoot).value, "旧表单的修改"); assert.ok(cachedRoot.textContent?.includes("并发身份冲突"));
      conflictPanel.suspend(); conflictPanel.renderDetail(cachedRoot);
      cachedRoot.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
      assert.deepEqual(conflictBaselines[1], conflictBaselines[0], "failed saves and redraws cannot refresh the editing baseline");
    } finally { conflictPanel.dispose(); cachedRoot.remove(); }
    let newBaseline: AgentEditorSaveBaseline | undefined = { agent: openingAgent, moduleIds: openingModules };
    const newRoot = container(); const newEditor = new AgentEditorController({ ...host, draftCacheKey: {}, saveAgent: async (_agent, _modules, baseline) => { newBaseline = baseline; }, onClose() {} });
    newEditor.open(); newEditor.render(newRoot); await settle(); changeName(newRoot, "新 Agent");
    newRoot.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.equal(newBaseline, undefined, "creating an Agent does not send an existing-agent baseline"); newEditor.dispose(); newRoot.remove();
    assert.ok(redraws > 0);
    console.log("PASS agent-settings: real shared editor/cache, stable save baseline across entries/conflicts/redraws, seven owner controls and rollback, settings leave/suspend, save failure, sidebar compatibility, presets, real delete counts and callbacks");
  } finally {
    panel.dispose(); disposeOriginControls(document.body); dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
