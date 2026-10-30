import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type CodexForObsidianPlugin from "../main";
import { renderMcpServerSettings } from "../settings/mcp-server-settings";
import type { OriginCheckElement } from "../settings/origin-controls";
import { normalizeEchoInkMcpServerSettings } from "../mcp-server/settings";
import { installObsidianDom } from "./obsidian-dom";

/** Real Origin/Radix controls in a synthetic DOM; native layout is accepted separately. */
export async function runMcpServerSettingsTests(): Promise<void> {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const win = dom.window;
  installObsidianDom(win);
  Object.assign(globalThis, {
    window: win, document: win.document, HTMLElement: win.HTMLElement, Element: win.Element,
    Node: win.Node, HTMLInputElement: win.HTMLInputElement, HTMLFormElement: win.HTMLFormElement,
    HTMLButtonElement: win.HTMLButtonElement, MutationObserver: win.MutationObserver,
    Event: win.Event, CustomEvent: win.CustomEvent, getComputedStyle: win.getComputedStyle.bind(win)
  });
  const proto = win.HTMLElement.prototype as HTMLElement & Record<string, unknown>;
  proto.empty = function (this: HTMLElement) { this.replaceChildren(); };
  proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
  proto.addClass = function (this: HTMLElement, ...names: string[]) { this.classList.add(...names); };
  proto.removeClass = function (this: HTMLElement, ...names: string[]) { this.classList.remove(...names); };
  proto.toggleClass = function (this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); };
  proto.createEl = function (this: HTMLElement, tag: string, options: DomElementInfo = {}) {
    const element = win.createEl(tag as keyof HTMLElementTagNameMap, options);
    this.appendChild(element);
    return element;
  } as HTMLElement["createEl"];
  proto.createDiv = function (this: HTMLElement, options: DomElementInfo = {}) { return this.createEl("div", options); };
  proto.createSpan = function (this: HTMLElement, options: DomElementInfo = {}) { return this.createEl("span", options); };
  const host = win.document.querySelector<HTMLElement>("main")!;
  let pro = true, benefits = 0, finishWrite: (() => void) | undefined;
  let stored = normalizeEchoInkMcpServerSettings({ enabled: true, knowledge: false, memory: false });
  const settings = { settingsLanguage: "zh-CN", mcpServer: { ...stored } };
  const patches: Array<Record<string, boolean>> = [];
  const accountListeners = new Set<() => void>(), serverListeners = new Set<() => void>();
  const publish = () => { for (const listener of accountListeners) listener(); };
  const plugin = {
    settings,
    accountService: { checkCapability: () => pro, subscribe(listener: () => void) { accountListeners.add(listener); return () => accountListeners.delete(listener); } },
    echoInkMcp: {
      server: {
        read: () => ({ status: settings.mcpServer.enabled ? "running" : "stopped", port: 27184 }),
        setupText: () => null,
        subscribe(listener: () => void) { serverListeners.add(listener); return () => serverListeners.delete(listener); }
      },
      async update(patch: Record<string, boolean>) {
        patches.push({ ...patch });
        await new Promise<void>(resolve => { finishWrite = resolve; });
        Object.assign(settings.mcpServer, patch);
        stored = { ...settings.mcpServer };
      }
    }
  } as unknown as CodexForObsidianPlugin;
  let dispose = renderMcpServerSettings(host, plugin, () => { benefits++; });
  const control = (label: string) => host.querySelector<OriginCheckElement>(`[aria-label="${label}"]`)!;
  const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
  const change = async (key: "enabled" | "knowledge" | "memory", label: string, checked: boolean, clickLabel = false) => {
    const check = control(label), before = patches.length;
    assert.equal(check.checked, !checked);
    if (clickLabel) check.closest("label")!.click(); else check.click();
    assert.equal(patches.length, before + 1, "each real control/label click submits exactly once");
    assert.deepEqual(patches.at(-1), { [key]: checked }, "capture the clicked value before pending refresh restores stored state");
    assert.equal(check.disabled, true, "saving prevents duplicate changes");
    finishWrite!(); await tick();
    assert.equal(stored[key], checked);
    assert.equal(check.checked, checked);
    assert.equal(check.disabled, false);
  };
  try {
    await change("knowledge", "知识库", true);
    await change("memory", "个人记忆与画像", true, true);
    await change("knowledge", "知识库", false, true);
    await change("memory", "个人记忆与画像", false);
    dispose(); host.empty();
    settings.mcpServer = normalizeEchoInkMcpServerSettings(JSON.parse(JSON.stringify(stored)));
    dispose = renderMcpServerSettings(host, plugin, () => { benefits++; });
    assert.equal(control("知识库").checked, false);
    assert.equal(control("个人记忆与画像").checked, false);
    await change("enabled", "启用 EchoInk MCP 服务", false);
    await change("enabled", "启用 EchoInk MCP 服务", true);
    assert.equal(control("知识库").checked, false, "service re-enable preserves explicit false grants");
    assert.equal(control("个人记忆与画像").checked, false);
    settings.mcpServer = normalizeEchoInkMcpServerSettings({}); publish();
    await change("enabled", "启用 EchoInk MCP 服务", true);
    assert.equal(control("知识库").checked, true, "new/missing grants start checked");
    assert.equal(control("个人记忆与画像").checked, true);
    pro = false; publish();
    assert.equal(control("启用 EchoInk MCP 服务").hidden, true);
    assert.equal(control("知识库").disabled, true);
    assert.equal(control("个人记忆与画像").disabled, true);
    assert.equal(host.querySelector<HTMLElement>(".echoink-module-drawer-content")!.hidden, true);
    const before = patches.length;
    host.querySelector<HTMLButtonElement>(".echoink-module-drawer-trigger")!.click();
    assert.equal(benefits, 1, "non-PRO keeps the existing benefits entry");
    assert.equal(patches.length, before);
    console.log("MCP settings: real Origin control/label clicks, pending capture, saved toggles, missing/false grants and non-PRO UI: PASS");
  } finally {
    dispose(); host.remove(); dom.window.close();
    assert.equal(accountListeners.size, 0); assert.equal(serverListeners.size, 0);
  }
}
