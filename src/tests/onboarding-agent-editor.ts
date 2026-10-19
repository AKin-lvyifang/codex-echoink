import assert from "node:assert/strict";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import type { AgentEditorHost } from "../ui/codex-view/agent-editor-contract";
import { AGENT_PRESETS } from "../agents/presets";
import type { AgentDefinition, AgentModuleId } from "../agents/types";
import { DEFAULT_SETTINGS } from "../settings/settings";

const settle = async () => { for (let pass = 0; pass < 3; pass++) await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

export async function runOnboardingAgentEditorTests(win: Window & typeof globalThis): Promise<void> {
  const create = function(this: HTMLElement, tag: string, options: any = {}) {
    const node = this.ownerDocument.createElement(tag); if (options.cls) node.className = options.cls;
    if (options.text !== undefined) node.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, String(value));
    this.append(node); return node;
  };
  Object.assign(win.Element.prototype, {
    addClass(...names: string[]) { this.classList.add(...names); }, removeClass(...names: string[]) { this.classList.remove(...names); },
    toggleClass(name: string, value: boolean) { this.classList.toggle(name, value); },
    setAttr(name: string, value: string) { this.setAttribute(name, value); }, setText(value: string) { this.textContent = value; },
    createEl: create, createDiv(options: any) { return create.call(this, "div", options); }, createSpan(options: any) { return create.call(this, "span", options); },
    hasPointerCapture() { return false; }, setPointerCapture() {}, releasePointerCapture() {}, scrollIntoView() {}
  });
  const button = (root: HTMLElement, label: string) => {
    const node = [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
    assert.ok(node, `Missing button: ${label}`); return node;
  };
  const input = (root: HTMLElement, field: string, value: string) => {
    const node = root.querySelector<HTMLInputElement>(`[data-field="${field}"]`)!;
    node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const submit = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!;
  const fixture = (onboarding = true) => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const saved: Array<{ agent: AgentDefinition; moduleIds: readonly AgentModuleId[] }> = [];
    const closed: Array<string | undefined> = [], allocatedIds: string[] = [];
    let failure = false, gate: Promise<void> | null = null;
    const host: AgentEditorHost = {
      settings, draftCacheKey: {}, onboarding,
      async loadResources() { return []; },
      async saveAgent(agent, moduleIds) {
        saved.push({ agent: structuredClone(agent), moduleIds: [...moduleIds] });
        if (gate) await gate;
        if (failure) throw new Error("合成保存失败");
        const index = settings.agentRegistry.agents.findIndex(item => item.id === agent.id);
        if (index < 0) settings.agentRegistry.agents.push(structuredClone(agent));
        else settings.agentRegistry.agents[index] = structuredClone(agent);
        for (const id of moduleIds) settings.agentRegistry.moduleOwners[id] = agent.id;
      },
      async deleteAgent() { assert.fail("Onboarding must not delete an Agent"); },
      async getDeleteCounts() { return { total: 0, running: 0 }; },
      onClose(id) { closed.push(id); }
    };
    const root = win.document.createElement("div"); win.document.body.append(root);
    let editor = new AgentEditorController(host);
    const open = async (id?: string) => {
      const original = globalThis.crypto.randomUUID;
      globalThis.crypto.randomUUID = () => { const value = original.call(globalThis.crypto); allocatedIds.push(`agent-${value}`); return value; };
      try { editor.open(id); } finally { globalThis.crypto.randomUUID = original; }
      editor.render(root); await settle();
    };
    return { settings, host, root, saved, closed, allocatedIds, get editor() { return editor; }, open,
      failSave(value: boolean) { failure = value; }, saveGate(value: Promise<void> | null) { gate = value; },
      async reopen(id?: string) { editor.dispose(); editor = new AgentEditorController(host); await open(id); },
      dispose() { editor.dispose(); root.remove(); }
    };
  };

  {
    const f = fixture(); await f.open();
    assert.equal(f.editor.element, f.root); assert.equal(f.saved.length, 0);
    assert.equal(submit(f.root).textContent, "创建并完成"); assert.equal(submit(f.root).disabled, false);
    assert.equal(f.root.querySelectorAll(".echoink-agent-editor-footer .mod-cta").length, 1);
    const initialCount = f.settings.agentRegistry.agents.length;
    const gate = deferred(); f.saveGate(gate.promise);
    const saveButton = submit(f.root); saveButton.click(); saveButton.click();
    const organizer = AGENT_PRESETS.find(item => item.presetId === "organizer")!;
    assert.equal(f.saved.length, 1); assert.equal(f.allocatedIds.length, 1);
    assert.deepEqual(f.saved[0], { agent: { ...structuredClone(organizer.agent), id: f.allocatedIds[0] }, moduleIds: [...organizer.moduleIds] });
    assert.equal(f.editor.isPending(), true); assert.equal(submit(f.root).disabled, true);
    assert.equal(submit(f.root).getAttribute("aria-busy"), "true"); assert.match(f.root.textContent!, /正在创建/);
    assert.equal(button(f.root, "取消").disabled, true);
    let left = false; f.editor.requestLeave(() => { left = true; }); assert.equal(left, false);
    assert.equal(f.settings.agentRegistry.agents.length, initialCount); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    gate.resolve(); await settle();
    assert.deepEqual(f.closed, [f.saved[0].agent.id]); assert.equal(f.editor.element, null);
    assert.equal(f.settings.agentRegistry.agents.length, initialCount + 1);
    assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], f.saved[0].agent.id);
    f.dispose();
    console.log("PASS untouched onboarding uses every real organizer field and original draft ID; one footer action, duplicate/busy guard and success callback");
  }
  {
    const f = fixture(); await f.open(); f.failSave(true);
    submit(f.root).click(); await settle();
    assert.equal(f.saved.length, 1); assert.equal(f.closed.length, 0); assert.equal(f.editor.isPending(), false);
    assert.match(f.root.textContent!, /合成保存失败/); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "整理员");
    const original = structuredClone(f.saved[0]);
    await f.reopen(); assert.equal(f.allocatedIds.length, 1);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "整理员");
    f.failSave(false); submit(f.root).click(); await settle();
    assert.equal(f.saved.length, 2); assert.deepEqual(f.saved[1], original);
    assert.deepEqual(f.closed, [original.agent.id]);
    assert.equal(f.settings.agentRegistry.agents.filter(agent => agent.id === original.agent.id).length, 1);
    f.dispose();
    console.log("PASS failed default creation preserves the full draft, owners and ID across reopen/retry");
  }
  for (const change of ["name", "position", "avatar", "current-avatar", "style", "current-style", "module", "capability"]) {
    const f = fixture(); await f.open();
    if (change === "name") { input(f.root, "name", "暂定"); input(f.root, "name", ""); }
    if (change === "position") input(f.root, "position", "用户自己填写的职位");
    if (change === "avatar") f.root.querySelector<HTMLButtonElement>('[aria-label="Nova"]')!.click();
    if (change === "current-avatar") f.root.querySelector<HTMLButtonElement>('[aria-label="默认头像"]')!.click();
    if (change === "style") f.root.querySelector<HTMLButtonElement>('[role="radiogroup"][aria-label="风格"] [aria-label="严谨分析"]')!.click();
    if (change === "current-style") f.root.querySelector<HTMLButtonElement>('[role="radiogroup"][aria-label="风格"] [aria-label="干脆执行"]')!.click();
    if (change === "module") f.root.querySelector<HTMLButtonElement>('[data-module-id="journal"]')!.click();
    if (change === "capability") f.root.querySelector<HTMLButtonElement>('[data-capability-id="journal"]')!.click();
    await settle();
    assert.equal(submit(f.root).disabled, true, `${change} must not fall back to organizer`);
    assert.equal(f.root.querySelector('[data-field="name"]')!.getAttribute("aria-invalid"), "true");
    assert.match(f.root.textContent!, /名字需为 1–24/);
    submit(f.root).click(); assert.equal(f.saved.length, 0);
    input(f.root, "name", "我的同事"); submit(f.root).click(); await settle();
    assert.equal(f.saved[0].agent.name, "我的同事"); assert.equal(f.saved[0].agent.id, f.allocatedIds[0]);
    assert.equal(f.saved[0].agent.position, change === "position" ? "用户自己填写的职位" : "");
    assert.deepEqual(f.saved[0].moduleIds, change === "module" ? ["journal"] : []);
    assert.deepEqual(f.saved[0].agent.capabilityIds, change === "capability" ? ["journal"] : []);
    if (change === "avatar") assert.deepEqual(f.saved[0].agent.avatar, { kind: "preset", presetId: "nova" });
    if (change === "style") assert.equal(f.saved[0].agent.styleId, "analysis");
    f.dispose();
  }
  console.log("PASS all identity/style/module/capability edits disable empty defaults and preserve custom fields after name validation");
  {
    const f = fixture(); await f.open();
    const picker = f.root.querySelector<HTMLInputElement>('[data-field="avatar-file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [new win.Blob(["invalid avatar"], { type: "text/plain" })] });
    picker.dispatchEvent(new win.Event("change")); await settle();
    assert.equal(submit(f.root).disabled, true); assert.equal(f.saved.length, 0);
    assert.match(f.root.textContent!, /只支持 SVG 头像/); assert.match(f.root.textContent!, /名字需为 1–24/);
    f.dispose();
    console.log("PASS a rejected custom avatar upload remains a user edit and cannot trigger the organizer default");
  }
  {
    const f = fixture(); await f.open();
    f.root.querySelector<HTMLButtonElement>('[data-preset="bookkeeper"]')!.click(); await settle();
    input(f.root, "position", "保留我的职位"); input(f.root, "name", "");
    assert.equal(submit(f.root).disabled, true); input(f.root, "name", "我的记账员");
    submit(f.root).click(); await settle();
    assert.equal(f.saved[0].agent.name, "我的记账员"); assert.equal(f.saved[0].agent.position, "保留我的职位");
    assert.deepEqual(f.saved[0].moduleIds, ["finance"]); assert.deepEqual(f.saved[0].agent.capabilityIds, ["finance"]);
    assert.equal(f.settings.lifestyle.finance.enabled, false);
    assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    f.dispose();
    console.log("PASS selected presets and user overrides keep their own module/capability fields without enabling modules");
  }
  for (const action of ["cancel", "back", "requestLeave"]) {
    const f = fixture(); await f.open(); input(f.root, "position", "离开前的自定义草稿");
    let left = false;
    const leave = () => {
      if (action === "cancel") button(f.root, "取消").click();
      else if (action === "back") f.root.querySelector<HTMLButtonElement>(".echoink-agent-editor-back")!.click();
      else f.editor.requestLeave(() => { left = true; });
    };
    leave(); assert.equal(f.closed.length, 0); assert.equal(left, false);
    assert.match(f.root.textContent!, /Agent 还有未保存的修改/);
    button(f.root, "继续编辑").click(); assert.equal(f.closed.length, 0); assert.equal(left, false);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="position"]')!.value, "离开前的自定义草稿");
    leave(); button(f.root, "放弃修改").click(); await settle();
    assert.equal(action === "requestLeave" ? left : f.closed.length === 1, true);
    assert.equal(f.saved.length, 0); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    f.dispose();
  }
  {
    const f = fixture(); await f.open(); button(f.root, "取消").click();
    assert.deepEqual(f.closed, [undefined]); assert.equal(f.saved.length, 0); f.dispose();
  }
  console.log("PASS cancel, back and host navigation use the existing leave confirmation and never create");
  {
    const f = fixture(false); await f.open();
    assert.equal(submit(f.root).textContent, "创建"); assert.equal(submit(f.root).disabled, true);
    input(f.root, "name", "普通新建"); submit(f.root).click(); await settle();
    assert.deepEqual(f.saved[0].moduleIds, []); assert.deepEqual(f.saved[0].agent.capabilityIds, []);
    assert.equal(f.saved[0].agent.position, ""); assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    f.dispose();
    const editing = fixture(); await editing.open("sol");
    assert.equal(submit(editing.root).textContent, "保存"); submit(editing.root).click(); await settle();
    assert.equal(editing.saved[0].agent.id, "sol"); assert.equal(editing.saved[0].agent.name, "总助"); editing.dispose();
    const english = fixture(); english.settings.settingsLanguage = "en"; await english.open();
    assert.equal(submit(english.root).textContent, "Create and finish"); english.dispose();
    console.log("PASS ordinary creation, existing Agent editing, moduleIds and English onboarding label remain separate");
  }
}
