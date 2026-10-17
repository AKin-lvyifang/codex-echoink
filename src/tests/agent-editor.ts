import assert from "node:assert/strict";
import { AgentEditorController } from "../ui/codex-view/agent-editor";
import type { AgentEditorHost } from "../ui/codex-view/agent-editor-contract";
import { DEFAULT_SETTINGS } from "../settings/settings";
import type { AgentDefinition, AgentModuleId } from "../agents/types";
import type { EchoInkResource } from "../resources/types";
import { mcpToolCapabilityId, vaultSkillCapabilityId } from "../agents/capability-policy";

const settle = async () => { for (let pass = 0; pass < 3; pass++) await new Promise(resolve => setTimeout(resolve, 0)); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

export async function runAgentEditorTests(win: Window & typeof globalThis): Promise<void> {
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
  const button = (root: HTMLElement, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label)!;
  const input = (root: HTMLElement, value: string) => { const node = root.querySelector<HTMLInputElement>('[data-field="name"]')!; node.value = value; node.dispatchEvent(new win.Event("input", { bubbles: true })); };
  const check = (root: HTMLElement, id: string) => root.querySelector<HTMLButtonElement>(`[data-capability-id="${id}"]`)!;
  const fixture = () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    let resources: EchoInkResource[] = [];
    let saveFailure = false, deleteFailure = false, resourceFailure = false;
    let saveGate: Promise<void> | null = null, deleteGate: Promise<void> | null = null;
    let counts = { total: 3, running: 1 }, countCalls = 0, deletes = 0, loads = 0;
    const saved: Array<{ agent: AgentDefinition; moduleIds: readonly AgentModuleId[] }> = [], closed: Array<string | undefined> = [];
    const host: AgentEditorHost = {
      get settings() { return settings; }, draftCacheKey: {},
      async loadResources() { loads++; if (resourceFailure) throw new Error("资源暂时不可读"); return resources; },
      getCapabilityAvailability: id => id === "finance" ? { available: false, reason: "PRO 已到期" } : { available: true },
      async saveAgent(agent, moduleIds) {
        saved.push({ agent: structuredClone(agent), moduleIds: [...moduleIds] }); if (saveGate) await saveGate;
        if (saveFailure) throw new Error("磁盘写入失败");
        const old = settings.agentRegistry.agents.findIndex(item => item.id === agent.id);
        if (old < 0) settings.agentRegistry.agents.push(agent); else settings.agentRegistry.agents[old] = agent;
        for (const id of moduleIds) settings.agentRegistry.moduleOwners[id] = agent.id;
      },
      async getDeleteCounts() { countCalls++; return { ...counts }; },
      async deleteAgent(id) { deletes++; if (deleteGate) await deleteGate; if (deleteFailure) throw new Error("停止任务失败，未删除 Agent"); settings.agentRegistry.agents = settings.agentRegistry.agents.filter(agent => agent.id !== id); },
      onClose(id) { closed.push(id); }
    };
    const root = win.document.createElement("div"); win.document.body.append(root);
    let editor = new AgentEditorController(host);
    return { settings, host, root, saved, closed, get editor() { return editor; }, setResources(value: EchoInkResource[]) { resources = value; },
      failSave(value: boolean) { saveFailure = value; }, failDelete(value: boolean) { deleteFailure = value; }, failResources(value: boolean) { resourceFailure = value; },
      saveGate(value: Promise<void> | null) { saveGate = value; }, deleteGate(value: Promise<void> | null) { deleteGate = value; },
      setCounts(value: typeof counts) { counts = value; }, get deletes() { return deletes; }, get countCalls() { return countCalls; }, get loads() { return loads; },
      async open(id?: string) { editor.open(id); editor.render(root); await settle(); },
      async reopen(id?: string) { editor.dispose(); editor = new AgentEditorController(host); editor.open(id); editor.render(root); await settle(); },
      dispose() { editor.dispose(); root.remove(); }
    };
  };

  {
    const f = fixture(); await f.open();
    assert.equal(f.root.querySelectorAll("[data-preset]").length, 5); assert.equal(f.saved.length, 0);
    f.root.querySelector<HTMLButtonElement>('[data-preset="organizer"]')!.click(); await settle();
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "整理员");
    assert.equal(f.root.querySelector('[data-module-id="knowledge-base"]')!.getAttribute("aria-checked"), "true");
    assert.equal(f.settings.agentRegistry.moduleOwners["knowledge-base"], "sol");
    assert.match(f.root.textContent!, /总助 → 整理员/);
    assert.equal(check(f.root, "knowledge").getAttribute("aria-checked"), "true");
    input(f.root, "𠮷".repeat(25)); assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.disabled, true);
    assert.match(f.root.textContent!, /1–24/);
    input(f.root, "𠮷".repeat(24)); assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.disabled, false);
    input(f.root, "保留修改");
    f.root.querySelector<HTMLButtonElement>('[data-preset="bookkeeper"]')!.click(); await settle();
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "保留修改");
    button(f.root, "保留修改").click(); await settle();
    f.root.querySelector<HTMLButtonElement>('[data-preset="bookkeeper"]')!.click(); await settle(); button(f.root, "使用预设").click(); await settle();
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "记账员"); assert.match(f.root.textContent!, /PRO 已到期/);
    assert.equal(f.settings.lifestyle.finance.enabled, false, "selecting capabilities must not enable the global module");
    const gate = deferred(); f.saveGate(gate.promise); f.failSave(true);
    f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click();
    assert.equal(f.saved.length, 1); assert.equal(f.root.querySelector('[data-action="save-agent"]')!.getAttribute("aria-busy"), "true");
    gate.resolve(); await settle(); assert.match(f.root.textContent!, /磁盘写入失败/); assert.equal(f.closed.length, 0);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "记账员");
    f.failSave(false); f.saveGate(null); f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.equal(f.saved.length, 2); assert.deepEqual(f.saved[1].moduleIds, ["finance"]); assert.deepEqual(f.saved[1].agent.capabilityIds, ["finance"]);
    assert.equal(f.closed[0], f.saved[1].agent.id); f.dispose();
    console.log("PASS real editor/Origin presets, Unicode name validation, deferred ownership, save failure preservation and duplicate prevention");
  }
  {
    const f = fixture(); await f.open(); input(f.root, "跨窗口草稿");
    check(f.root, "journal").click(); await settle();
    await f.reopen(); assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "跨窗口草稿");
    assert.equal(check(f.root, "journal").getAttribute("aria-checked"), "true");
    button(f.root, "取消").click(); await f.reopen(); assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "");
    assert.equal(check(f.root, "journal").getAttribute("aria-checked"), "false");
    f.failResources(true); button(f.root, "刷新资源").click(); await settle(); assert.match(f.root.textContent!, /资源暂时不可读/);
    input(f.root, "读取失败不丢草稿"); f.failResources(false); button(f.root, "刷新资源").click(); await settle();
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "读取失败不丢草稿"); f.dispose();
    console.log("PASS data-only View draft restoration, explicit cancel discard and resource error/retry preservation");
  }
  {
    const f = fixture();
    const server: EchoInkResource = { id: "manual:mcp-server:alpha", name: "Alpha", description: "", enabled: true, kind: "mcp-server", source: "manual", bridgeMode: "structured-tools" };
    const empty: EchoInkResource = { ...server, id: "manual:mcp-server:empty", name: "Empty" };
    const skill: EchoInkResource = { id: "echoink-local:skill:custom", name: "自建 Skill", description: "", enabled: false, kind: "skill", source: "echoink-local", bridgeMode: "prompt-only", metadata: { resourceId: "custom" } };
    const tool = (name: string) => ({ name, description: "", readOnly: true, destructive: false, inputSchema: { type: "object" } });
    f.settings.resources.mcpConnections[server.id] = { transport: "http", url: "https://mcp.invalid", trusted: true, tools: [tool("read"), tool("write")], toolPolicies: { read: { enabled: true, trusted: true }, write: { enabled: true, trusted: true } } };
    f.settings.resources.mcpConnections[empty.id] = { ...f.settings.resources.mcpConnections[server.id], tools: [] };
    f.setResources([server, empty, skill]);
    f.settings.agentRegistry.agents.push({ id: "ordinary", name: "普通同事", avatar: { kind: "default" }, position: "", styleId: "execution", capabilityIds: ["unknown-preserved"] });
    await f.open("ordinary");
    const serviceCheck = () => f.root.querySelector<HTMLButtonElement>('[aria-label="MCP 服务：Alpha"]')!;
    assert.equal(f.root.querySelector<HTMLButtonElement>('[aria-label="MCP 服务：Empty"]')!.disabled, true); assert.match(f.root.textContent!, /尚未发现可用工具/);
    const details = f.root.querySelector<HTMLDetailsElement>(`details[data-resource-id="${server.id}"]`)!;
    assert.equal(details.open, false); serviceCheck().click(); await settle(); assert.equal(serviceCheck().getAttribute("aria-checked"), "true");
    details.open = true; await settle(); check(f.root, mcpToolCapabilityId(server.id, "write")).click(); await settle();
    assert.equal(serviceCheck().getAttribute("aria-checked"), "mixed");
    assert.equal(check(f.root, mcpToolCapabilityId(server.id, "read")).getAttribute("aria-checked"), "true");
    assert.match(f.root.textContent!, /资源未启用/); check(f.root, vaultSkillCapabilityId(skill.id)).click();
    f.root.querySelector<HTMLButtonElement>('[data-module-id="journal"]')!.click(); await settle(); assert.match(f.root.textContent!, /缺少「日记」能力/);
    f.settings.resources.mcpConnections[server.id].tools.push(tool("new-tool")); button(f.root, "刷新资源").click(); await settle();
    const again = f.root.querySelector<HTMLDetailsElement>(`details[data-resource-id="${server.id}"]`)!; again.open = true; await settle();
    assert.equal(check(f.root, mcpToolCapabilityId(server.id, "new-tool")).getAttribute("aria-checked"), "false");
    f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.deepEqual(new Set(f.saved[0].agent.capabilityIds), new Set(["unknown-preserved", mcpToolCapabilityId(server.id, "read"), vaultSkillCapabilityId(skill.id)]));
    assert.equal(f.settings.resources.catalog.some(item => item.enabled), false, "editor does not mutate the resource registry");
    f.dispose();
    const s = fixture(); s.setResources([server]); s.settings.resources.mcpConnections[server.id] = structuredClone(f.settings.resources.mcpConnections[server.id]);
    s.settings.agentRegistry.agents[0].disabledCapabilityIds = ["finance", mcpToolCapabilityId(server.id, "write"), "unknown-disabled"];
    await s.open("sol"); assert.equal(s.root.querySelector('[aria-label="MCP 服务：Alpha"]')!.getAttribute("aria-checked"), "mixed");
    assert.equal(s.root.querySelector('[data-action="delete-agent"]'), null);
    const solDetails = s.root.querySelector<HTMLDetailsElement>("details[data-resource-id]")!; solDetails.open = true; await settle();
    assert.equal(check(s.root, mcpToolCapabilityId(server.id, "new-tool")).getAttribute("aria-checked"), "true");
    s.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.deepEqual(s.saved[0].agent.disabledCapabilityIds, ["finance", mcpToolCapabilityId(server.id, "write"), "unknown-disabled"]); assert.equal(s.saved[0].agent.capabilityIds, undefined);
    s.dispose();
    console.log("PASS real MCP service/tool tri-state, new-tool defaults, Sol exclusion/ordinary whitelist storage and unchanged module/resource switches");
  }
  {
    const f = fixture(); f.settings.agentRegistry.agents.push({ id: "colleague", name: "同事", avatar: { kind: "default" }, position: "", styleId: "companion", capabilityIds: [] });
    await f.open("colleague"); input(f.root, "未保存的新名字");
    f.root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle();
    assert.equal(f.countCalls, 1); assert.match(f.root.textContent!, /3 件事（1 件正在进行）会交给总助/);
    assert.match(f.root.textContent!, /不会自动重新执行/); button(f.root, "取消删除").click(); await settle(); assert.equal(f.deletes, 0);
    f.setCounts({ total: 5, running: 2 }); f.root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle(); assert.match(f.root.textContent!, /5 件事（2 件正在进行）/);
    const gate = deferred(); f.deleteGate(gate.promise); f.failDelete(true);
    f.root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click(); f.root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click();
    assert.equal(f.deletes, 1); assert.match(f.root.textContent!, /正在停止任务并交回总助/); assert.equal(f.closed.length, 0);
    gate.resolve(); await settle(); assert.match(f.root.textContent!, /停止任务失败/); assert.ok(f.settings.agentRegistry.agents.find(agent => agent.id === "colleague"));
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "未保存的新名字");
    f.deleteGate(null); f.failDelete(false); f.root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle();
    assert.equal(f.countCalls, 3); f.root.querySelector<HTMLButtonElement>('[data-action="confirm-delete"]')!.click(); await settle();
    assert.equal(f.closed[0], "sol"); assert.equal(f.settings.agentRegistry.agents.some(agent => agent.id === "colleague"), false); f.dispose();
    console.log("PASS latest deletion totals/running counts, inline cancel, in-flight duplicate guard and failure preservation");
  }
  {
    const f = fixture(); await f.open(); input(f.root, "头像测试");
    const before = f.root.querySelector<HTMLImageElement>(".echoink-agent-editor-avatar-preview")!.src;
    const picker = f.root.querySelector<HTMLInputElement>('[data-field="avatar-file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [] }); picker.dispatchEvent(new win.Event("change"));
    assert.equal(f.root.querySelector<HTMLImageElement>(".echoink-agent-editor-avatar-preview")!.src, before);
    Object.defineProperty(picker, "files", { configurable: true, value: [new Blob(['<svg width="256" height="256"><script>bad</script></svg>'], { type: "image/svg+xml" })] });
    picker.dispatchEvent(new win.Event("change")); await settle(); assert.match(f.root.textContent!, /头像处理失败/);
    assert.equal(f.root.querySelector<HTMLImageElement>(".echoink-agent-editor-avatar-preview")!.src, before);
    globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() {} }) as ImageBitmap;
    win.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
    win.HTMLCanvasElement.prototype.toBlob = function(callback) { callback(new win.Blob(["synthetic raster"], { type: "image/webp" })); };
    const next = f.root.querySelector<HTMLInputElement>('[data-field="avatar-file"]')!;
    Object.defineProperty(next, "files", { configurable: true, value: [new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="100" /></svg>'], { type: "image/svg+xml" })] });
    next.dispatchEvent(new win.Event("change")); await settle(); await settle();
    f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.equal(f.saved[0].agent.avatar.kind, "custom"); assert.equal((f.saved[0].agent.avatar as any).mimeType, "image/webp");
    assert.match((f.saved[0].agent.avatar as any).dataUrl, /^data:image\/webp;base64,/); f.dispose();
    console.log("PASS existing avatar SVG validation/rasterization pipeline, picker cancel and invalid upload preservation");
  }
  {
    const f = fixture(), load = deferred();
    f.host.loadResources = async () => { await load.promise; return []; };
    f.editor.open(); f.editor.render(f.root);
    button(f.root, "取消").click(); load.resolve(); await settle();
    assert.equal(f.root.children.length, 0, "a late resource reply cannot rebuild a disposed form");
    await f.reopen(); input(f.root, "保存中的旧草稿");
    const save = deferred(); f.saveGate(save.promise);
    f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click();
    await f.reopen(); input(f.root, "重新打开后的新修改");
    save.resolve(); await settle();
    assert.equal(f.closed.length, 1, "a detached save callback cannot navigate the reopened View");
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "重新打开后的新修改");
    await f.reopen(); assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "重新打开后的新修改", "an older save cannot erase a newer cached revision");
    f.dispose();
    console.log("PASS disposal releases its mount and stale resource/save callbacks cannot replace a newer View draft");
  }
  {
    const f = fixture(); f.settings.settingsLanguage = "en";
    f.settings.agentRegistry.agents.push({ id: "english-ui", name: "用户原名", avatar: { kind: "default" }, position: "用户的原始职位，不翻译", styleId: "analysis", capabilityIds: [] });
    const skill: EchoInkResource = { id: "echoink-local:skill:unchanged", name: "用户自建 Skill 名字", description: "", kind: "skill", source: "echoink-local", enabled: false, bridgeMode: "prompt-only", metadata: { resourceId: "unchanged" } };
    const server: EchoInkResource = { id: "manual:mcp-server:english", name: "用户服务名称", description: "", kind: "mcp-server", source: "manual", enabled: true, bridgeMode: "structured-tools" };
    f.setResources([skill, server]);
    f.settings.resources.mcpConnections[server.id] = { transport: "http", url: "https://mcp.invalid", trusted: true, tools: [{ name: "用户工具名称", description: "", readOnly: true, destructive: false, inputSchema: { type: "object" } }], toolPolicies: {} };
    await f.open("english-ui");
    assert.equal(f.root.lang, "en"); assert.equal(f.root.querySelector("h2")?.textContent, "Edit Agent");
    assert.ok(button(f.root, "Back")); assert.ok(button(f.root, "Save")); assert.ok(button(f.root, "Cancel")); assert.ok(button(f.root, "Delete Agent"));
    assert.deepEqual([...f.root.querySelectorAll("h3")].map(node => node.textContent), ["Name, avatar and role", "Responsible for", "Capabilities", "Style"]);
    assert.match(f.root.textContent!, /PRO membership has expired/); assert.match(f.root.textContent!, /Resource disabled/);
    assert.match(f.root.textContent!, /用户自建 Skill 名字/); assert.match(f.root.textContent!, /用户服务名称/);
    const details = f.root.querySelector<HTMLDetailsElement>("details[data-resource-id]")!; assert.match(details.textContent!, /1 tool/); details.open = true; await settle();
    assert.match(details.textContent!, /用户工具名称/); assert.match(details.textContent!, /Tool disabled/);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-field="name"]')!.value, "用户原名");
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-field="position"]')!.value, "用户的原始职位，不翻译");
    assert.ok(f.root.querySelector('[role="radiogroup"][aria-label="Style"] [aria-label="Careful analysis"]'));
    assert.match(f.root.querySelector(".echoink-agent-editor-style-description")!.textContent!, /Check assumptions, evidence/);
    input(f.root, ""); assert.match(f.root.textContent!, /Use 1–24 characters without line breaks or tabs/); input(f.root, "用户原名");
    f.root.querySelector<HTMLButtonElement>('[data-action="delete-agent"]')!.click(); await settle();
    assert.match(f.root.textContent!, /Its 3 tasks \(1 running\) will be transferred to the general assistant/);
    assert.match(f.root.textContent!, /will not restart automatically/); assert.ok(button(f.root, "Delete and transfer to the general assistant"));
    button(f.root, "Cancel deletion").click(); await settle(); assert.equal(f.deletes, 0);
    f.root.querySelector<HTMLButtonElement>('[data-action="save-agent"]')!.click(); await settle();
    assert.equal(f.saved[0].agent.name, "用户原名"); assert.equal(f.saved[0].agent.position, "用户的原始职位，不翻译"); f.dispose();
    const creation = fixture(); creation.settings.settingsLanguage = "en"; await creation.open();
    assert.equal(creation.root.querySelector("h2")!.textContent, "New Agent"); assert.match(creation.root.textContent!, /Start from a preset/);
    assert.ok(creation.root.querySelector('[data-preset="organizer"][aria-label="Organizer"]'));
    assert.match(creation.root.textContent!, /No custom Skills/); assert.match(creation.root.textContent!, /No connected MCP services/); assert.ok(button(creation.root, "Create"));
    creation.dispose();
    console.log("PASS English renderer labels/status/style/deletion copy and unchanged user identity/resource/tool content");
  }
}
