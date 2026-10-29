import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { createOriginButton, createOriginCheck, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { createSettingsSection, showSettingsInlineConfirmation } from "./settings-v2";
import { createPluginEditionBadge } from "./plugin-edition-badge";
import { applyAmicroButton } from "./amicro-buttons";

/** The MCP resource page contains both incoming EchoInk sharing and outgoing client connections. */
export function renderMcpServerSettings(host: HTMLElement, plugin: CodexForObsidianPlugin, onProBenefits: () => void): () => void {
  const controller = plugin.echoInkMcp;
  if (!controller) return () => {};
  const english = plugin.settings.settingsLanguage === "en";
  const access = plugin.accountService ?? unavailableCapabilityAccess;
  const drawerHost = host.createDiv({ cls: "echoink-desktop-modules" });
  const group = createSettingsSection(drawerHost, { surface: "flat" });
  group.addClass("echoink-module-group");
  const card = createSettingsSection(group, { surface: "group" });
  card.addClass("echoink-module-drawer", "echoink-mcp-server-settings");
  const header = card.createDiv({ cls: "echoink-module-drawer-header" });
  const trigger = createOriginButton(header, { cls: "echoink-module-drawer-trigger", attr: { "aria-label": english ? "EchoInk MCP server" : "EchoInk MCP 服务" } });
  setIcon(trigger.createSpan({ cls: "echoink-module-drawer-icon", attr: { "aria-hidden": "true" } }), "radio-tower");
  const copy = trigger.createSpan({ cls: "echoink-module-drawer-copy" });
  const name = copy.createSpan({ cls: "echoink-module-drawer-name" });
  name.createSpan({ cls: "echoink-module-drawer-title", text: english ? "EchoInk MCP server" : "EchoInk MCP 服务" });
  createPluginEditionBadge(name, "pro", plugin.settings.settingsLanguage);
  const summary = copy.createSpan({ cls: "echoink-module-drawer-summary" });
  const chevron = trigger.createSpan({ cls: "echoink-module-drawer-chevron", attr: { "aria-hidden": "true" } });
  setIcon(chevron, "chevron-down");
  const toggle = createOriginSwitch(header, { attr: { "aria-label": english ? "Enable EchoInk MCP server" : "启用 EchoInk MCP 服务" } });
  const required = trigger.createSpan({ cls: "echoink-module-pro-required", text: english ? "Requires PRO" : "需要 PRO" });
  trigger.insertBefore(required, chevron);
  const content = card.createDiv({ cls: "echoink-module-drawer-content" });
  const grants = content.createDiv({ cls: "echoink-mcp-server-grants" });
  const permission = (key: "knowledge" | "memory", title: string) => {
    const label = grants.createEl("label", { cls: "echoink-mcp-server-grant" });
    label.createSpan({ text: title });
    const check = createOriginCheck(label, { attr: { "aria-label": title } });
    check.onchange = () => run(() => controller.update({ [key]: check.checked }));
    return check;
  };
  const knowledge = permission("knowledge", english ? "Knowledge" : "知识库");
  const memory = permission("memory", english ? "Personal memory and profile" : "个人记忆与画像");
  content.createEl("p", { cls: "settings-note echoink-mcp-server-disclosure", text: english
    ? "Shared data enters the external Agent and its model provider’s records. EchoInk cannot control their retention. Revoking access only stops future reads; it cannot recall data already sent."
    : "资料会进入外部 Agent 及其模型服务的记录，EchoInk 无法控制对方保存。撤销授权只能阻止以后读取，已发送的内容无法收回。" });
  const error = content.createDiv({ cls: "settings-state is-error", attr: { role: "status" } });
  const setup = content.createEl("textarea", { cls: "echoink-mcp-server-setup", attr: { readonly: "", rows: "4", spellcheck: "false", "aria-label": english ? "Personal setup text (contains your token)" : "个人接入文字（含令牌）" } });
  const actions = content.createDiv({ cls: "echoink-mcp-server-actions" });
  const rotate = createOriginButton(actions, { cls: "icon-button is-icon", attr: { "aria-label": english ? "Regenerate token" : "重新生成令牌" } });
  applyAmicroButton(rotate, { variant: "icon", motion: "rotate", icon: "refresh-cw" });
  const copyButton = createOriginButton(actions, { text: english ? "Copy setup text" : "复制接入文字", cls: "button mod-cta" });
  applyAmicroButton(copyButton, { variant: "primary", motion: "complete", icon: "copy" });
  let expanded = plugin.settings.mcpServer.enabled, pending = false, disposed = false;
  let localError = "";
  const refresh = () => {
    if (disposed) return;
    const qualified = hasProPluginAccess(access), settings = plugin.settings.mcpServer, state = controller.server.read();
    card.toggleClass("is-pro-locked", !qualified);
    toggle.checked = settings.enabled; toggle.hidden = !qualified; required.hidden = qualified;
    toggle.disabled = pending;
    knowledge.checked = settings.knowledge; memory.checked = settings.memory;
    knowledge.disabled = memory.disabled = pending || !qualified;
    summary.setText(!qualified ? "" : state.status === "running" ? `127.0.0.1:${state.port}`
      : state.status === "starting" ? (english ? "Starting…" : "正在启动…") : settings.enabled ? (english ? "Not running" : "未运行") : (english ? "Off" : "未启用"));
    summary.hidden = !summary.textContent;
    setIcon(chevron, qualified ? "chevron-down" : "chevron-right");
    const open = expanded && settings.enabled && qualified;
    content.hidden = !open; card.toggleClass("is-expanded", open); trigger.setAttribute("aria-expanded", String(open));
    chevron.toggleClass("is-expanded", open);
    const text = controller.server.setupText(); setup.value = text ?? ""; setup.hidden = text === null;
    copyButton.disabled = pending || !text;
    rotate.disabled = pending || !qualified || !settings.enabled;
    error.setText(localError || (state.status === "error" ? (english ? "Could not start the local MCP server. Try turning it off and on." : "本机 MCP 服务启动失败，请关闭后重试。") : ""));
    error.hidden = !error.textContent;
  };
  const run = (action: () => Promise<void>) => {
    if (pending || disposed) return;
    pending = true; localError = ""; refresh();
    void action().catch(failure => { localError = failure instanceof Error ? failure.message : String(failure); })
      .finally(() => { pending = false; refresh(); });
  };
  trigger.onclick = () => { if (!hasProPluginAccess(access)) onProBenefits(); else if (plugin.settings.mcpServer.enabled) { expanded = !expanded; refresh(); } };
  toggle.onchange = () => { const value = toggle.checked; expanded = value; run(() => controller.update({ enabled: value })); };
  rotate.onclick = () => showSettingsInlineConfirmation(content, rotate, { message: english ? "Existing clients will lose access. Regenerate the token?" : "旧接入将立即失效，重新生成令牌？", confirmLabel: english ? "Regenerate" : "重新生成", cancelLabel: english ? "Cancel" : "取消", danger: false, onConfirm: async () => { try { await controller.rotateToken(); } catch (failure) { localError = String(failure); } refresh(); } });
  copyButton.onclick = () => run(async () => { const text = controller.server.setupText(); if (!text) return; await host.ownerDocument.defaultView!.navigator.clipboard.writeText(text); new Notice(english ? "Setup text copied." : "接入文字已复制。"); });
  const releaseServer = controller.server.subscribe(refresh), releaseAccess = access.subscribe(refresh);
  refresh();
  return () => { disposed = true; releaseServer(); releaseAccess(); disposeOriginControls(card); };
}
