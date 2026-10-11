import { setIcon, type App } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ApiProviderConfig } from "../../settings/settings";
import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import { renderAnimatedSettingsTabIcon } from "../../settings/animated-settings-tab-icon";
import { MOBILE_DEFAULT_WELCOME, mobileModel, mobilePresets, mobileProvider, selectedModel, supportedProvider, validateMobileProvider, type MobileSettings } from "../../mobile/settings";
import { memoryCategories } from "../../mobile/tools";
import { type MobilePermission, MobileStore } from "../../mobile/store";
import { MobileRuntime } from "../../mobile/runtime";
import type { MobileServices } from "../../mobile/services";
import { MobileViewport } from "./viewport";
import { MobileSettingsPages, type MobileSettingsPage, type MobileSettingsRoute } from "./settings-pages";
import { defaultAgentIdentityState } from "../../harness/memory/agent-identity-model";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { renderSettingsGearIcon } from "../codex-icon";
import type { AccountService } from "../../membership/account-service";

export interface MobileUIHost {
  app: App;
  isTablet?: boolean;
  settingsOnly?: boolean;
  openSettings?(page: MobileSettingsRoute): Promise<void>;
  openChat?(): Promise<void>;
  services?: MobileServices;
  version?: string;
  accountService?: AccountService;
  applyAppearance?(): void;
  store: MobileStore;
  runtime: MobileRuntime;
  settings(): MobileSettings;
  saveSettings(): Promise<void>;
  openNote(path: string): Promise<void>;
  beginRender(): void;
  renderMarkdown(text: string, element: HTMLElement): void;
}
type Page = MobileSettingsPage | "chat" | "settings" | "basic" | "providers" | "provider" | "models" | "permissions" | "history" | "review" | "memories" | "memory" | "notes";
const permissions: [MobilePermission, string, string][] = [
  ["read-only", "只读", "读取笔记，不新建文档"],
  ["workspace-write", "工作区可写", "读取并新建当前笔记库的文档"],
  ["full-access", "完全访问权限", "使用当前笔记库中已接通的工具"]
];
const toolNames: Record<string, string> = { vault_search: "查找笔记", note_read: "读取笔记", note_create: "保存文档", memory_search: "查找记忆", memory_read: "读取记忆", memory_write: "保存记忆" };
function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.append(node); return node;
}
function icon(parent: HTMLElement, name: string) { const node = el(parent, "span", "em-icon"); node.setAttribute("aria-hidden", "true"); setIcon(node, name); return node; }
function contentText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : (message.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
}
function detailRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The same DOM controller is used by the ItemView and browser host fixture. */
export class MobileUI {
  private providerPickerBack?: () => void;
  private viewport?: MobileViewport;
  private overlay?: HTMLElement;
  private sheetRestore?: HTMLElement;
  private settingPages: MobileSettingsPages;
  private page: Page = "chat";
  private stack: Page[] = [];
  private scroll = new Map<string, number>();
  private sidebarScroll = new Map<string, number>();
  private providerDraft?: ApiProviderConfig;
  private memoryId = "";
  private memoryDrafts = new Map<string, { title: string; content: string }>();
  private memoryEditing = false;
  private memoryCategory = "all";
  private memoryQuery = "";
  private noteQuery = "";
  private expandedTools = new Set<string>();
  private error = "";
  private saving = false;
  private mounted = false;
  private content!: HTMLElement;
  private timer?: number;
  private chatSessionId?: string;
  private onRuntimeChange = () => { if (this.page === "chat" || (this.host.isTablet && this.page === "history")) this.refreshChat(); };
  constructor(private root: HTMLElement, private host: MobileUIHost) { this.host.applyAppearance = () => this.applyAppearance(); this.settingPages = new MobileSettingsPages(host, { go: page => this.go(page), sheet: (title, render) => this.openSheet(title, render), row: (parent, title, desc, name, action) => this.row(parent, title, desc, name, action), button: (parent, title, action, name, cls) => this.button(parent, title, action, name, cls), field: (parent, title, value, update, type) => this.field(parent, title, value, update, type), act: action => this.act(action) }); }
  showPage(page: MobileSettingsRoute) { this.go(page, page === "settings"); }
  showChat() { if (this.host.settingsOnly) return; if (this.page !== "chat") this.go("chat"); else this.refreshChat(); }
  mount() {
    this.mounted = true; this.root.classList.add("echoink-mobile"); this.root.classList.toggle("em-tablet", !!this.host.isTablet); this.root.classList.toggle("em-settings-surface", !!this.host.settingsOnly);
    if (this.host.settingsOnly) this.page = "settings";
    else { this.host.runtime.onChange = this.onRuntimeChange; this.timer = window.setInterval(() => this.updateTimers(), 250); }
    this.render(); this.viewport = new MobileViewport(this.root); this.applyAppearance();
  }
  refreshSettings() { this.applyAppearance(); this.updateComposerLabels(); if (!this.host.settingsOnly) this.refreshChat(); }
  destroy() { this.viewport?.dispose(); this.settingPages.dispose(); this.closeSheet(false); this.mounted = false; window.clearInterval(this.timer); if (this.host.runtime.onChange === this.onRuntimeChange) this.host.runtime.onChange = () => {}; this.root.replaceChildren(); }
  private async act(action: () => void | Promise<void>) {
    try { this.error = ""; this.showError(); await action(); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); if (this.mounted) this.showError(); }
  }
  private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, iconName?: string, className = "") {
    const button = el(parent, "button", className); button.type = "button";
    if (iconName) icon(button, iconName);
    if (label) el(button, "span", "", label);
    button.addEventListener("click", () => { void this.act(action); });
    return button;
  }
  private iconButton(parent: HTMLElement, label: string, name: string, action: () => void | Promise<void>) {
    const button = this.button(parent, "", action, name, "em-icon-button"); button.setAttribute("aria-label", label); return button;
  }
  private scrollKey() { return this.page === "memory" ? `memory:${this.memoryId}` : this.page; }
  private captureScroll() { const body = this.root.querySelector<HTMLElement>(".em-body"); if (body) this.scroll.set(this.scrollKey(), body.scrollTop); }
  private go(page: Page, fromHome = false) {
    if (this.host.settingsOnly && page === "chat") { this.closeSheet(false); if (this.host.openChat) void this.act(() => this.host.openChat!()); return; }
    if (!this.host.settingsOnly && this.host.isTablet && this.host.openSettings && (page === "settings" || page === "finance-settings" || this.settingPages.categories.some(item => item.page === page))) { this.closeSheet(false); void this.act(() => this.host.openSettings!(page as MobileSettingsRoute)); return; }
    this.captureScroll();
    if (fromHome) this.stack = [this.host.settingsOnly ? "settings" : "chat"]; else if (page !== this.page) this.stack.push(this.page);
    this.page = page; this.error = "";
    if (this.host.isTablet && this.root.clientWidth >= 760) {
      if (page === "settings") { this.stack.push("settings"); this.page = "basic"; }
      if (page === "memories" && this.host.store.state.memories.length) {
        if (!this.host.store.state.memories.some(record => record.id === this.memoryId)) this.memoryId = this.host.store.state.memories[0].id;
        this.memoryEditing = this.memoryDrafts.has(this.memoryId); this.stack.push("memories"); this.page = "memory";
      }
    }
    this.closeSheet(false); this.render();
  }
  private back() { if (this.overlay) { this.closeSheet(); return; } this.captureScroll(); this.page = this.stack.pop() ?? (this.host.settingsOnly ? "settings" : "chat"); this.error = ""; this.render(); }
  private showError() {
    this.root.querySelectorAll<HTMLElement>(".em-error,.em-sheet-error").forEach(box => { box.textContent = this.error; box.hidden = !this.error; });
  }
  private render() {
    this.settingPages.dispose();
    const previousSidebar = this.root.querySelector<HTMLElement>(".em-sidebar");
    if (previousSidebar) this.sidebarScroll.set(previousSidebar.getAttribute("aria-label") ?? "", previousSidebar.scrollTop);
    this.host.beginRender(); this.root.replaceChildren();
    this.root.dataset.page = this.page;
    const header = el(this.root, "header", "em-header");
    if (this.page !== "chat" && !(this.host.settingsOnly && this.page === "settings")) this.iconButton(header, "返回", "chevron-left", () => this.back());
    else if (this.page === "chat") el(header, "span", "em-agent-avatar"); else icon(header, "settings-2");
    const titles: Record<Page, string> = { ...this.settingPages.titles, chat: (this.host.services?.agentIdentity ?? defaultAgentIdentityState()).displayName, settings: "设置", basic: "基础设置", providers: "模型与提供商", provider: "配置提供商", models: "选择模型", permissions: "工作区权限", history: "历史对话", review: "复盘", memories: "记忆", memory: "记忆详情", notes: "引用笔记" };
    el(header, "h2", "em-title", this.host.settingsOnly && this.page === "settings" ? "EchoInk 设置" : titles[this.page]);
    if (this.page === "chat") {
      this.updateIdentity();
      this.iconButton(header, "历史对话", "history", () => this.openSheet("历史对话", body => this.history(body)));
      const settingsButton = this.iconButton(header, "设置", "settings-2", () => this.go("settings")); settingsButton.replaceChildren(); renderSettingsGearIcon(settingsButton);
    }
    const error = el(this.root, "div", "em-error"); error.setAttribute("role", "alert"); this.showError();
    const workspace = el(this.root, "div", "em-workspace");
    if (this.host.isTablet && !this.host.settingsOnly) {
      const navigation = el(workspace, "nav", "em-navigation"); navigation.setAttribute("aria-label", "EchoInk 导航");
      for (const [page, label, name] of [["chat", "对话", "message-square"], ["memories", "记忆", "brain"], ["settings", "设置", "settings-2"]] as const) {
        const button = this.button(navigation, label, () => this.go(page), name);
        const selected = page === "chat" ? this.page === "chat" || this.page === "history" : page === "memories" ? this.page === "memories" || this.page === "memory" : ["settings", "provider", ...this.settingPages.categories.map(item => item.page)].includes(this.page);
        button.setAttribute("aria-current", selected ? "page" : "false");
      }
    }
    const panels = el(workspace, "div", "em-panels");
    this.content = el(panels, "section", "em-content");
    // If a narrow list was widened, keep the revealed detail once interacted with.
    const retainDetail = () => {
      if (!this.host.isTablet || this.root.clientWidth < 760) return;
      if (this.page !== "settings" && this.page !== "memories") return;
      this.stack.push(this.page); this.page = this.page === "settings" ? "basic" : "memory";
      this.root.dataset.page = this.page;
    };
    this.content.addEventListener("pointerdown", retainDetail);
    this.content.addEventListener("focusin", retainDetail);
    const body = el(this.content, "main", "em-body");
    if (this.host.isTablet && this.tabletPanels(panels, body)) {
      body.addEventListener("scroll", retainDetail);
      const aside = panels.querySelector<HTMLElement>(".em-sidebar");
      if (aside) aside.scrollTop = this.sidebarScroll.get(aside.getAttribute("aria-label") ?? "") ?? 0;
      body.scrollTop = this.scroll.get(this.scrollKey()) ?? 0;
      return;
    }
    switch (this.page) {
      case "chat": this.chat(body); break;
      case "settings": this.settings(body); break;
      case "basic": this.basic(body); break;
      case "providers": this.providers(body); break;
      case "provider": this.provider(body); break;
      case "models": this.models(body); break;
      case "permissions": this.permissionPage(body); break;
      case "history": this.history(body); break;
      case "review": this.settingPages.render("review", body); break;
      case "memories": this.memories(body); break;
      case "memory": this.memory(body); break;
      case "notes": this.notes(body); break;
      default: this.settingPages.render(this.page, body); break;
    }
    body.scrollTop = this.scroll.get(this.scrollKey()) ?? 0;
  }
  private tabletPanels(panels: HTMLElement, body: HTMLElement): boolean {
    const sidebar = (label: string) => {
      const aside = document.createElement("aside"); aside.className = "em-sidebar"; aside.setAttribute("aria-label", label);
      panels.prepend(aside); el(aside, "h3", "em-sidebar-title", label); return aside;
    };
    if (this.page === "chat" || this.page === "history") {
      this.history(sidebar("历史对话")); this.chat(body); return true;
    }
    if (this.page === "memories" || this.page === "memory") {
      if (!this.host.store.state.memories.some(record => record.id === this.memoryId)) {
        this.memoryId = this.host.store.state.memories[0]?.id ?? "";
        this.memoryEditing = this.memoryDrafts.has(this.memoryId);
      }
      this.memories(sidebar("记忆"));
      if (this.memoryId) this.memory(body); else el(body, "p", "em-empty", "还没有记忆");
      return true;
    }
    if (["settings", "provider", ...this.settingPages.categories.map(item => item.page)].includes(this.page)) {
      const navigation = sidebar("设置"); this.settings(navigation);
      if (this.page === "providers") this.providers(body);
      else if (this.page === "provider") this.provider(body);
      else if (this.page === "settings" || this.page === "basic") this.basic(body);
      else this.settingPages.render(this.page as MobileSettingsPage, body);
      const category = this.page === "settings" ? "基础设置" : this.page === "provider" ? "API Provider" : this.settingPages.categories.find(item => item.page === this.page)?.title ?? "基础设置";
      navigation.querySelectorAll<HTMLButtonElement>(".em-row").forEach(row => row.setAttribute("aria-current", row.querySelector("strong")?.textContent === category ? "page" : "false"));
      return true;
    }
    return false;
  }
  private row(parent: HTMLElement, title: string, description: string, iconName: string, action: () => void | Promise<void>) {
    const row = this.button(parent, "", action, undefined, "em-row"); icon(row, iconName);
    const label = el(row, "span", "em-row-label"); el(label, "strong", "", title); if (description) el(label, "small", "", description);
    icon(row, "chevron-right"); return row;
  }
  private confirmAction(parent: HTMLElement, message: string, label: string, action: () => Promise<void>) {
    parent.querySelector(".em-confirm")?.remove();
    const group = el(parent, "div", "em-confirm"); group.setAttribute("role", "group"); group.setAttribute("aria-label", message);
    el(group, "p", "", message);
    this.button(group, "取消", () => group.remove());
    this.button(group, label, async () => { await action(); group.remove(); }, undefined, "em-danger");
    group.scrollIntoView({ block: "nearest" });
  }
  private chat(body: HTMLElement) {
    body.classList.add("em-messages"); this.messages(body);
    const compose = el(this.content, "footer", "em-compose");
    const quick = el(compose, "div", "em-quick");
    const newButton = this.button(quick, "新对话", async () => { if (this.host.runtime.busy) return; await this.host.store.createSession(); this.scroll.delete("chat"); this.render(); }, "square-pen"); newButton.disabled = this.host.runtime.busy;
    this.button(quick, "引用笔记", () => this.openSheet("引用笔记", body => this.notes(body)), "file-text");
    const journal = async () => { if (!this.host.services) throw new Error("日记服务尚未就绪。"); await this.host.services.prepareJournal(); this.closeSheet(); this.root.querySelector<HTMLTextAreaElement>(".em-input")?.focus(); };
    this.button(quick, "写日记", journal, "notebook-pen");
    const session = this.host.store.session;
    this.chatSessionId = session.id;
    const context = el(compose, "div", "em-context");
    this.refreshContext(context);
    const composer = el(compose, "div", "em-composer");
    const input = el(composer, "textarea", "em-input"); input.placeholder = `和 ${(this.host.services?.agentIdentity ?? defaultAgentIdentityState()).displayName} 说说你的想法…`; input.setAttribute("aria-label", "消息草稿"); input.rows = 2; input.value = session.draft;
    input.addEventListener("input", () => this.updateDraft(input.value));
    const controls = el(composer, "div", "em-composer-tools");
    this.iconButton(controls, "添加到对话", "plus", () => this.openSheet("添加到对话", body => { this.row(body, "引用笔记", "", "file-text", () => this.openSheet("引用笔记", part => this.notes(part))); this.row(body, "写日记", "", "notebook-pen", journal); this.row(body, "选择 Skill", "", "sparkles", () => this.go("resources")); }));
    this.iconButton(controls, `工作区权限：${permissions.find(p => p[0] === this.host.store.state.permission)?.[1]}`, "shield-check", () => this.openSheet("工作区权限", body => this.permissionPage(body)));
    const model = selectedModel(this.host.settings());
    const picker = this.button(controls, "", () => this.openSheet("选择模型", body => this.models(body)), undefined, "em-model"); picker.setAttribute("aria-label", "选择模型");
    if (model) renderProviderBrandIcon(el(picker, "span", "em-brand"), model.provider.providerId === "openai" ? "openai-codex" : model.provider.providerId ?? "custom");
    el(picker, "span", "em-model-label", model?.model.displayName || "配置模型"); icon(picker, "chevron-down");
    const send = this.iconButton(controls, this.host.runtime.busy ? "停止回答" : "发送消息", this.host.runtime.busy ? "square" : "arrow-up", async () => {
      if (this.host.runtime.busy) { this.host.runtime.stop(); return; }
      const draft = input.value;
      if (!draft.trim()) return;
      await this.host.runtime.send(draft);
    }); send.classList.add("em-send");
    const status = el(compose, "div", "em-status", this.host.runtime.busy ? "正在等待模型或执行工具…" : ""); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  }
  private refreshContext(container = this.root.querySelector<HTMLElement>(".em-context")) {
    if (!container) return;
    container.replaceChildren(); const session = this.host.store.session; container.hidden = !session.notePath;
    if (!session.notePath) return;
    this.button(container, session.notePath, () => this.host.openNote(session.notePath), "file-text");
    this.iconButton(container, "移除笔记引用", "x", async () => { session.notePath = ""; await this.host.store.save(); this.refreshContext(container); });
  }
  private updateDraft(text: string) { this.host.store.session.draft = text; void this.act(() => this.host.store.save()); }
  private updateIdentity() {
    const avatar = this.root.querySelector<HTMLElement>(".em-agent-avatar"); if (!avatar) return;
    const identity = this.host.services?.agentIdentity ?? defaultAgentIdentityState();
    const title = this.root.querySelector<HTMLElement>(".em-header .em-title"); if (title) title.textContent = identity.displayName;
    const input = this.root.querySelector<HTMLTextAreaElement>(".em-input"); if (input) input.placeholder = `和 ${identity.displayName} 说说你的想法…`;
    const url = resolveAgentAvatarUrl(identity.avatar);
    if (avatar.dataset.avatarUrl === (url ?? "")) return;
    avatar.dataset.avatarUrl = url ?? ""; avatar.replaceChildren();
    if (url) { const image = el(avatar, "img"); image.src = url; image.alt = ""; image.draggable = false; image.decoding = "async"; }
    else icon(avatar, "bot");
  }
  private refreshChat() {
    if (!this.mounted) return;
    this.updateIdentity();
    // Preserve keyboard focus and draft while only message and status regions change.
    const body = this.root.querySelector<HTMLElement>(".em-messages");
    if (!body) return;
    const changedSession = this.chatSessionId !== this.host.store.session.id;
    if (changedSession) {
      this.chatSessionId = this.host.store.session.id; this.scroll.delete("chat"); this.refreshContext();
      this.root.querySelectorAll<HTMLElement>(".em-session-list").forEach(list => { list.replaceChildren(); this.history(list); });
    }
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
    this.host.beginRender(); body.replaceChildren(); this.messages(body);
    if (nearBottom || changedSession) body.scrollTop = body.scrollHeight;
    const input = this.root.querySelector<HTMLTextAreaElement>(".em-input");
    if (input && input.value !== this.host.store.session.draft) input.value = this.host.store.session.draft;
    const send = this.root.querySelector<HTMLButtonElement>(".em-send");
    if (send) { send.replaceChildren(); icon(send, this.host.runtime.busy ? "square" : "arrow-up"); send.setAttribute("aria-label", this.host.runtime.busy ? "停止回答" : "发送消息"); }
    const newButton = this.root.querySelector<HTMLButtonElement>(".em-quick button"); if (newButton) newButton.disabled = this.host.runtime.busy;
    this.root.querySelectorAll<HTMLButtonElement>(".em-session-row").forEach(row => {
      row.disabled = this.host.runtime.busy;
      row.setAttribute("aria-current", row.dataset.sessionId === this.host.store.state.activeSessionId ? "page" : "false");
      const session = this.host.store.state.sessions.find(item => item.id === row.dataset.sessionId);
      if (session) { const title = row.querySelector("strong"); const time = row.querySelector("small"); if (title) title.textContent = session.title; if (time) time.textContent = new Date(session.updatedAt).toLocaleString(); }
    });
    const status = this.root.querySelector<HTMLElement>(".em-status"); if (status) status.textContent = this.host.runtime.busy ? "正在等待模型或执行工具…" : "";
    this.error = this.host.runtime.error; this.showError();
  }
  private updateTimers() {
    if (!this.host.runtime.busy || (this.page !== "chat" && !(this.host.isTablet && this.page === "history"))) return;
    for (const element of Array.from(this.root.querySelectorAll<HTMLElement>(".em-tool-timer"))) {
      const timing = this.host.store.session.tools[element.dataset.callId ?? ""];
      if (timing && timing.elapsedMs === undefined) element.textContent = `${((Date.now() - timing.startedAt) / 1000).toFixed(1)} 秒 · 进行中`;
    }
  }
  private messages(body: HTMLElement) {
    const session = this.host.store.session;
    if (!session.messages.length) {
      const welcome = el(body, "section", "em-welcome");
      const settings = this.host.settings();
      const title = settings.customWelcomeEnabled ? settings.customWelcomeTitle.trim() : "";
      const subtitle = settings.customWelcomeEnabled ? settings.customWelcomeSubtitle.trim() : "";
      el(welcome, "h1", "", title || MOBILE_DEFAULT_WELCOME.title);
      el(welcome, "p", "", subtitle || MOBILE_DEFAULT_WELCOME.subtitle);
      if (!selectedModel(this.host.settings())) this.button(welcome, "添加模型与提供商", () => this.go("providers"), "plus", "em-text-action");
      return;
    }
    for (const message of session.messages) {
      if (message.role === "toolResult") continue;
      const text = contentText(message);
      if (text) {
        const bubble = el(body, "article", message.role === "user" ? "em-user-message" : "em-answer markdown-rendered");
        if (message.role === "user") bubble.textContent = text; else this.host.renderMarkdown(text, bubble);
      }
      if (message.role !== "assistant") continue;
      if (message.stopReason === "aborted" || message.stopReason === "error") el(body, "p", "em-message-state", message.stopReason === "aborted" ? "已停止，可继续发送消息。" : message.errorMessage ?? "回答失败，可继续发送消息。");
      if (message.stopReason === "length") el(body, "p", "em-message-state", "回答达到输出上限，可继续提问。");
      for (const call of message.content.filter(c => c.type === "toolCall")) {
        if (call.type !== "toolCall") continue;
        const receipt = session.messages.find((m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId === call.id);
        const timing = session.tools[call.id];
        const details = el(body, "details", "em-tool"); details.open = this.expandedTools.has(call.id);
        details.addEventListener("toggle", () => { if (details.open) this.expandedTools.add(call.id); else this.expandedTools.delete(call.id); });
        const summary = el(details, "summary"); icon(summary, receipt?.isError ? "circle-alert" : receipt ? "check" : "ellipsis");
        el(summary, "span", "", toolNames[call.name] ?? "工具操作");
        const timer = el(summary, "small", "em-tool-timer", timing?.elapsedMs !== undefined ? `${(timing.elapsedMs / 1000).toFixed(1)} 秒` : this.host.runtime.busy ? timing ? `${((Date.now() - timing.startedAt) / 1000).toFixed(1)} 秒 · 进行中` : "等待执行" : "未完成");
        timer.dataset.callId = call.id;
        const content = el(details, "div", "em-tool-content"); this.toolContent(content, call.name, call.arguments, receipt);
        const record = receipt?.details as { saved?: boolean; path?: string } | undefined;
        if (record?.saved && record.path) this.button(body, `打开 ${record.path}`, () => this.host.openNote(record.path!), "file-text", "em-note-link");
      }
    }
  }
  private toolContent(parent: HTMLElement, name: string, args: Record<string, unknown>, receipt?: ToolResultMessage) {
    if (receipt?.isError) { el(parent, "p", "", contentText(receipt)); return; }
    const data: unknown = receipt?.details;
    const result = detailRecord(data);
    const note = (path: string) => this.button(parent, path, () => this.host.openNote(path), "file-text", "em-note-link");
    const markdown = (text: string) => { const article = el(parent, "article", "markdown-rendered"); this.host.renderMarkdown(text, article); };
    if (name === "note_read") {
      if (typeof result?.path === "string") note(result.path); else if (typeof args.path === "string") el(parent, "p", "", args.path);
      if (typeof result?.content === "string") markdown(result.content);
    } else if (name === "note_create") {
      if (result?.saved && typeof result.path === "string") { note(result.path); if (typeof args.content === "string") markdown(args.content); }
      else el(parent, "p", "", typeof args.path === "string" ? args.path : "等待保存结果");
    } else if (name === "vault_search") {
      if (Array.isArray(data)) { if (!data.length) el(parent, "p", "", "没有找到相关笔记"); for (const item of data) { const record = detailRecord(item); if (typeof record?.path === "string") note(record.path); } }
      else if (typeof args.query === "string") el(parent, "p", "", args.query);
    } else if (name.startsWith("memory_") && toolNames[name]) {
      const records: unknown[] = Array.isArray(data) ? data : data ? [data] : [];
      if (receipt && !records.length) el(parent, "p", "", "没有找到相关记忆");
      for (const item of records) { const record = detailRecord(item); if (typeof record?.title === "string") el(parent, "strong", "", record.title); if (typeof record?.content === "string") markdown(record.content); }
      if (!receipt && typeof args.title === "string") el(parent, "p", "", args.title);
    } else {
      el(parent, "pre", "", JSON.stringify(args, null, 2)); if (receipt) el(parent, "pre", "", contentText(receipt));
    }
  }
  private settings(body: HTMLElement) {
    for (const category of this.settingPages.categories) {
      const row = this.row(body, category.title, "", category.icon, () => this.go(category.page));
      const leadingIcon = row.querySelector<HTMLElement>(".em-icon")!;
      // Reuse the desktop static layers and their CSS, without animation listeners.
      leadingIcon.classList.add("codex-settings-tab-icon");
      renderAnimatedSettingsTabIcon(leadingIcon, category.icon, null);
    }
  }
  private basic(body: HTMLElement) {
    el(body, "h3", "em-section-title", "长期记忆");
    const label = el(body, "label", "em-row"); const text = el(label, "span", "em-row-label"); el(text, "strong", "", "使用长期记忆"); el(text, "small", "", "保存值得保留的信息，在后续对话中召回");
    const toggle = el(label, "input"); toggle.type = "checkbox"; toggle.checked = this.host.store.state.memoryEnabled; toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-label", "长期记忆");
    toggle.addEventListener("change", () => { void this.act(async () => { this.host.runtime.stop(); this.host.store.state.memoryEnabled = toggle.checked; await this.host.store.save(); }); });
    el(body, "p", "em-help", "关闭后保留已有记忆，停止自动召回和写入。记忆查看与忘记仍可使用。");

    this.settingPages.basicEntries(body);
    const settings = this.host.settings();
    el(body, "h3", "em-section-title", "欢迎语");
    const welcomeLabel = el(body, "label", "em-row");
    const welcomeText = el(welcomeLabel, "span", "em-row-label");
    el(welcomeText, "strong", "", "自定义欢迎语");
    el(welcomeText, "small", "", "自定义空对话的标题和问候语");
    const welcomeToggle = el(welcomeLabel, "input"); welcomeToggle.type = "checkbox";
    welcomeToggle.checked = settings.customWelcomeEnabled;
    welcomeToggle.setAttribute("role", "switch"); welcomeToggle.setAttribute("aria-label", "自定义欢迎语");
    const fields = el(body, "div"); fields.hidden = !settings.customWelcomeEnabled;
    el(fields, "p", "em-help", "输入后自动保存。留空时使用默认文案；关闭后保留自定义内容。");
    const title = this.field(fields, "欢迎标题", settings.customWelcomeTitle, value => {
      settings.customWelcomeTitle = value;
      void this.act(() => this.host.saveSettings());
    });
    title.maxLength = 80; title.placeholder = MOBILE_DEFAULT_WELCOME.title;
    const subtitle = this.field(fields, "问候语", settings.customWelcomeSubtitle, value => {
      settings.customWelcomeSubtitle = value;
      void this.act(() => this.host.saveSettings());
    });
    subtitle.maxLength = 240; subtitle.placeholder = MOBILE_DEFAULT_WELCOME.subtitle;
    welcomeToggle.addEventListener("change", () => {
      settings.customWelcomeEnabled = welcomeToggle.checked;
      fields.hidden = !welcomeToggle.checked;
      void this.act(() => this.host.saveSettings());
    });
    this.settingPages.basicGeneral(body);
  }
  private permissionPage(body: HTMLElement) {
    for (const [id, title, description] of permissions) {
      const row = this.row(body, title, description, this.host.store.state.permission === id ? "circle-check" : "circle", async () => { this.host.store.state.permission = id; await this.host.store.save(); this.closeSheet(); this.updateComposerLabels(); }); row.setAttribute("aria-pressed", String(this.host.store.state.permission === id));
    }
    el(body, "p", "em-help", "三种权限均限定于当前笔记库。长期记忆由基础设置中的开关独立控制。");
  }
  private providers(body: HTMLElement) {
    for (const provider of this.host.settings().apiProviders.filter(supportedProvider)) {
      const row = this.row(body, provider.name, `${provider.models.map(m => m.displayName || m.id).join("、")}${provider.id === this.host.settings().activeApiProviderId ? " · 当前" : ""}`, "cpu", () => { this.providerDraft = structuredClone(provider); this.openSheet("编辑模型", body => this.provider(body)); });
      const mark = row.querySelector<HTMLElement>(".em-icon")!; mark.replaceChildren(); renderProviderBrandIcon(mark, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
    }
    this.button(body, "添加提供商", () => { this.providerDraft = mobileProvider("deepseek"); this.openSheet("添加模型", body => this.provider(body)); }, "plus", "em-wide-action");
  }
  private field(parent: HTMLElement, title: string, value: string, update: (value: string) => void, type = "text") {
    const label = el(parent, "label", "em-field"); el(label, "span", "", title); const input = el(label, "input"); input.type = type; input.value = value; input.setAttribute("aria-label", title); input.autocomplete = "off"; input.spellcheck = false;
    input.addEventListener("input", () => update(input.value)); return input;
  }
  private provider(body: HTMLElement) {
    const draft = this.providerDraft!;
    const form = el(body, "div", "em-form em-provider-form");
    const presetLabel = el(form, "div", "em-field"); el(presetLabel, "span", "", "供应商");
    const presets = this.button(presetLabel, "", () => {
      const scroll = body.scrollTop;
      form.hidden = true; presets.setAttribute("aria-expanded", "true");
      const picker = el(body, "section", "em-provider-picker");
      const close = () => { this.providerPickerBack = undefined; picker.remove(); form.hidden = false; presets.setAttribute("aria-expanded", "false"); body.scrollTop = scroll; presets.focus({ preventScroll: true }); };
      this.providerPickerBack = close;
      this.button(picker, "返回配置", close, "chevron-left", "em-provider-back");
      el(picker, "h3", "em-section-title", "选择供应商");
      const list = el(picker, "div"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "供应商");
      for (const preset of mobilePresets) {
        const row = this.row(list, preset.name.split(" / ")[0], "", "cpu", () => {
          close();
          if (draft.providerId === preset.id) return;
          const replacement = mobileProvider(preset.id);
          this.providerDraft = { ...draft, ...replacement, id: draft.id, apiKey: draft.providerId === replacement.providerId ? draft.apiKey : "" };
          body.replaceChildren(); this.provider(body); body.scrollTop = scroll;
          body.querySelector<HTMLElement>(".em-provider-trigger")?.focus({ preventScroll: true });
        });
        const art = row.querySelector<HTMLElement>(".em-icon")!; renderProviderBrandIcon(art, preset.id); art.classList.add("em-provider-brand");
        row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(draft.providerId === preset.id)); row.dataset.provider = preset.id;
        row.lastElementChild?.remove();
        if (draft.providerId === preset.id) icon(row, "check");
      }
      picker.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const options = Array.from(list.querySelectorAll<HTMLButtonElement>("button")), index = options.indexOf(picker.ownerDocument.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
        options[next]?.focus();
      });
      list.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    }, undefined, "em-provider-trigger");
    presets.setAttribute("aria-label", `供应商：${mobilePresets.find(item => item.id === draft.providerId)?.name.split(" / ")[0] ?? draft.name}`); presets.setAttribute("aria-haspopup", "listbox"); presets.setAttribute("aria-expanded", "false");
    const brand = el(presets, "span", "em-provider-brand"); brand.setAttribute("aria-hidden", "true"); renderProviderBrandIcon(brand, draft.providerId === "openai" ? "openai-codex" : draft.providerId ?? "custom");
    el(presets, "span", "", mobilePresets.find(item => item.id === draft.providerId)?.name.split(" / ")[0] ?? draft.name); icon(presets, "chevron-down");
    this.field(form, "显示名称", draft.name, value => { draft.name = value; });
    const key = this.field(form, "API Key", draft.apiKey, value => { draft.apiKey = value; }, "password");
    const reveal = this.button(form, "显示 API Key", () => { const visible = key.type === "password"; key.type = visible ? "text" : "password"; reveal.setAttribute("aria-pressed", String(visible)); }, "eye"); reveal.setAttribute("aria-pressed", "false");
    this.field(form, "接口地址", draft.baseUrl, value => { draft.baseUrl = value; }, "url");
    const protocolLabel = el(form, "label", "em-field"); el(protocolLabel, "span", "", "协议"); const protocols = el(protocolLabel, "select"); protocols.setAttribute("aria-label", "协议");
    for (const [value, name] of [["openai-completions", "Chat Completions"], ["openai-responses", "OpenAI Responses"]]) { const option = el(protocols, "option", "", name); option.value = value; } protocols.value = draft.apiProtocol;
    protocols.addEventListener("change", () => { if (protocols.value === "openai-completions" || protocols.value === "openai-responses") draft.apiProtocol = protocols.value; });
    this.field(form, "模型 ID（多个用逗号分隔）", draft.models.map(m => m.id).join(", "), value => {
      const ids = [...new Set(value.split(/[,，\n]/u).map(id => id.trim()).filter(Boolean))];
      draft.models = ids.map(id => mobileModel(id, draft.models.find(m => m.id === id))); draft.defaultModelId = ids.includes(draft.defaultModelId) ? draft.defaultModelId : ids[0] ?? "";
    });
    el(form, "p", "em-help", "API Key 保存在本地插件配置中。保存只检查填写；发送消息时才请求模型。");
    const persist = async (activate: boolean) => {
      if (this.saving) return;
      validateMobileProvider(draft); this.saving = true;
      try {
        const settings = this.host.settings(); const index = settings.apiProviders.findIndex(p => p.id === draft.id);
        if (index < 0) settings.apiProviders.push(structuredClone(draft)); else settings.apiProviders[index] = structuredClone(draft);
        if (activate || !settings.activeApiProviderId) { settings.activeApiProviderId = draft.id; settings.defaultModel = draft.defaultModelId; settings.providerMode = "api"; }
        else if (settings.activeApiProviderId === draft.id && !draft.models.some(m => m.id === settings.defaultModel)) settings.defaultModel = draft.defaultModelId;
        await this.host.saveSettings(); this.closeSheet(); this.render();
      } finally { this.saving = false; }
    };
    this.button(form, "检查填写", () => { validateMobileProvider(draft); let feedback = form.querySelector<HTMLElement>(".em-provider-feedback"); if (!feedback) feedback = el(form, "p", "em-provider-feedback"); feedback.setAttribute("role", "status"); feedback.textContent = "填写检查通过；尚未请求供应商。"; }, "check", "em-wide-action");
    const actions = el(form, "div", "em-provider-actions");
    this.button(actions, "保存并设为当前", () => persist(true), "check", "em-primary");
    this.button(actions, "保存", () => persist(false));
    if (this.host.settings().apiProviders.some(p => p.id === draft.id)) {
      this.button(form, "删除提供商", () => this.confirmAction(form, `删除「${draft.name}」的本地配置？`, "确认删除", async () => {
        const settings = this.host.settings(); settings.apiProviders = settings.apiProviders.filter(p => p.id !== draft.id);
        if (settings.activeApiProviderId === draft.id) { settings.activeApiProviderId = ""; settings.defaultModel = ""; }
        await this.host.saveSettings(); this.closeSheet(); this.render();
      }), "trash-2", "em-danger em-wide-action");
    }
  }
  private models(body: HTMLElement) {
    const settings = this.host.settings();
    for (const provider of settings.apiProviders.filter(supportedProvider)) for (const model of provider.models) {
      const active = provider.id === settings.activeApiProviderId && model.id === settings.defaultModel;
      const row = this.row(body, model.displayName || model.id, provider.name, active ? "check" : "cpu", async () => { settings.activeApiProviderId = provider.id; settings.defaultModel = model.id; settings.providerMode = "api"; await this.host.saveSettings(); this.closeSheet(); this.updateComposerLabels(); }); row.setAttribute("aria-pressed", String(active));
      const mark = row.querySelector<HTMLElement>(".em-icon")!; mark.replaceChildren(); renderProviderBrandIcon(mark, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
      if (active) { const check = row.querySelector<HTMLElement>(".em-icon:last-child")!; check.replaceChildren(); setIcon(check, "check"); }
    }
    this.button(body, "模型与提供商设置", () => this.go("providers"), "settings-2", "em-wide-action");
  }
  private history(body: HTMLElement) {
    body.classList.add("em-session-list");
    if (!this.host.store.state.sessions.length) el(body, "p", "em-empty", "还没有历史对话");
    for (const session of this.host.store.state.sessions.filter(item => !item.archivedAt)) {
      const row = this.row(body, session.title, new Date(session.updatedAt).toLocaleString(), "message-square", async () => { if (this.host.runtime.busy) throw new Error("请先停止当前回答。"); this.captureScroll(); this.host.store.state.activeSessionId = session.id; await this.host.store.save(); this.stack = []; this.page = "chat"; this.scroll.delete("chat"); this.closeSheet(false); this.render(); }); row.disabled = this.host.runtime.busy;
      row.classList.add("em-session-row"); row.dataset.sessionId = session.id; row.setAttribute("aria-current", session.id === this.host.store.state.activeSessionId ? "page" : "false");
    }
  }
  private search(parent: HTMLElement, label: string, value: string, update: (value: string) => void) {
    const input = el(parent, "input", "em-search"); input.type = "search"; input.placeholder = label; input.setAttribute("aria-label", label); input.value = value;
    input.addEventListener("input", () => update(input.value)); return input;
  }
  private memories(body: HTMLElement) {
    const search = this.search(body, "搜索记忆", this.memoryQuery, value => { this.memoryQuery = value; renderRows(); });
    const tabs = el(body, "div", "em-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "记忆分类");
    for (const category of memoryCategories) {
      const button = this.button(tabs, category.label, () => {
        this.memoryCategory = category.id; tabs.querySelectorAll("button").forEach(tab => tab.setAttribute("aria-selected", String(tab === button))); renderRows();
      }); button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(category.id === this.memoryCategory));
    }
    const rows = el(body, "div", "em-memory-list");
    const renderRows = () => {
      rows.replaceChildren(); const category = memoryCategories.find(c => c.id === this.memoryCategory)!;
      const items = this.host.store.state.memories.filter(r => (category.id === "all" || (category.kinds as readonly string[]).includes(r.kind)) && `${r.title}\n${r.content}`.toLocaleLowerCase().includes(this.memoryQuery.toLocaleLowerCase()));
      if (!items.length) el(rows, "p", "em-empty", search.value ? "没有找到相关记忆" : "还没有记忆");
      for (const record of items) {
        const row = this.row(rows, record.title, memoryCategories.find(c => (c.kinds as readonly string[]).includes(record.kind))?.label ?? "", "brain", () => { this.captureScroll(); this.memoryId = record.id; this.memoryEditing = this.memoryDrafts.has(record.id); this.stack.push(this.page); this.page = "memory"; this.error = ""; this.render(); });
        row.setAttribute("aria-current", record.id === this.memoryId ? "page" : "false");
      }
    }; renderRows();
  }
  private memory(body: HTMLElement) {
    const record = this.host.store.state.memories.find(r => r.id === this.memoryId);
    if (!record) { el(body, "p", "em-empty", "这条记忆已不存在。"); return; }
    const toolbar = el(body, "div", "em-detail-toolbar"); el(toolbar, "span", "", memoryCategories.find(c => (c.kinds as readonly string[]).includes(record.kind))?.label ?? "记忆");
    this.button(toolbar, this.memoryEditing ? "查看原文" : this.memoryDrafts.has(record.id) ? "继续编辑" : "编辑", () => { this.memoryEditing = !this.memoryEditing; this.render(); }, this.memoryEditing ? "book-open" : "pencil");
    if (this.memoryEditing) {
      const draft = this.memoryDrafts.get(record.id) ?? { title: record.title, content: record.content }; this.memoryDrafts.set(record.id, draft);
      this.field(body, "标题", draft.title, value => { draft.title = value; });
      const label = el(body, "label", "em-field"); el(label, "span", "", "内容"); const input = el(label, "textarea", "em-memory-editor"); input.value = draft.content; input.setAttribute("aria-label", "记忆内容"); input.addEventListener("input", () => { draft.content = input.value; });
      this.button(body, "预览修改", () => {
        if (!this.host.store.state.memoryEnabled) throw new Error("请先在基础设置中开启长期记忆。");
        if (!draft.title.trim() || !draft.content.trim()) throw new Error("标题和内容不能为空。");
        if (draft.title.trim() === record.title && draft.content.trim() === record.content) throw new Error("内容没有变化。");
        this.openSheet("记忆修改预览", part => {
          el(part, "h3", "em-section-title", "修改前"); el(part, "strong", "", record.title); const before = el(part, "article", "em-memory-content markdown-rendered"); this.host.renderMarkdown(record.content, before);
          el(part, "h3", "em-section-title", "修改后"); el(part, "strong", "", draft.title.trim()); const after = el(part, "article", "em-memory-content markdown-rendered"); this.host.renderMarkdown(draft.content.trim(), after);
          this.button(part, "应用修改", async () => {
            const current = this.host.store.state.memories.find(item => item.id === record.id);
            if (!current || current.revision !== record.revision) throw new Error("记忆已更新，请重新打开后编辑。");
            const updated = { ...record, title: draft.title.trim(), content: draft.content.trim(), date: new Date().toISOString(), revision: record.revision + 1, basis: "explicit" as const, contentOrigin: "user_edit" as const };
            this.host.store.state.memories = this.host.store.state.memories.map(item => item.id === record.id ? updated : item); await this.host.store.save(); this.memoryDrafts.delete(record.id); this.memoryEditing = false; this.closeSheet(false); this.render();
          }, "check", "em-primary em-wide-action");
        });
      }, "check", "em-primary em-wide-action");
    } else {
      el(body, "h1", "em-memory-title", record.title); const article = el(body, "article", "em-memory-content markdown-rendered"); this.host.renderMarkdown(record.content, article);
      el(body, "p", "em-help", `${new Date(record.date).toLocaleString()} · ${record.basis === "explicit" ? "明确陈述" : record.basis === "observed" ? "对话观察" : "推测"}`);
    }
    this.button(body, "忘记这条记忆", () => this.confirmAction(body, `忘记「${record.title}」？此操作会删除这条本地记忆。`, "确认忘记", async () => {
      this.host.store.state.memories = this.host.store.state.memories.filter(r => r.id !== record.id); await this.host.store.save(); this.memoryDrafts.delete(record.id); this.back();
    }), "trash-2", "em-danger em-wide-action");
  }
  private notes(body: HTMLElement) {
    const active = this.host.app.workspace.getActiveFile();
    if (active?.extension === "md") this.row(body, "当前笔记", active.path, "file-text", async () => { this.host.store.session.notePath = active.path; await this.host.store.save(); this.closeSheet(); this.refreshContext(); });
    this.search(body, "按标题或路径查找笔记", this.noteQuery, value => { this.noteQuery = value; renderRows(); });
    const rows = el(body, "div");
    const renderRows = () => {
      rows.replaceChildren();
      const files = this.host.app.vault.getMarkdownFiles().filter(f => !f.path.split("/").some(p => p.startsWith(".")) && f.path.toLocaleLowerCase().includes(this.noteQuery.toLocaleLowerCase())).slice(0, 60);
      if (!files.length) el(rows, "p", "em-empty", "没有找到笔记");
      for (const file of files) this.row(rows, file.basename, file.path, "file-text", async () => { this.host.store.session.notePath = file.path; await this.host.store.save(); this.closeSheet(); this.refreshContext(); });
    }; renderRows();
  }

  private updateComposerLabels() {
    const model = selectedModel(this.host.settings());
    const label = this.root.querySelector(".em-model-label"); if (label) label.textContent = model?.model.displayName || "配置模型";
    const picker = this.root.querySelector<HTMLElement>(".em-model"); let brand = picker?.querySelector<HTMLElement>(".em-brand");
    if (!model) brand?.remove();
    else if (picker) { if (!brand) { brand = el(picker, "span", "em-brand"); picker.prepend(brand); } renderProviderBrandIcon(brand, model.provider.providerId === "openai" ? "openai-codex" : model.provider.providerId ?? "custom"); }
    const permission = this.root.querySelector<HTMLButtonElement>('button[aria-label^="工作区权限："]'); if (permission) permission.setAttribute("aria-label", `工作区权限：${permissions.find(item => item[0] === this.host.store.state.permission)?.[1]}`);
  }
  private applyAppearance() {
    this.root.dataset.appearance = this.host.settings().mobileUi.appearance;
    this.root.classList.toggle("em-large-text", this.host.settings().mobileUi.largeText);
  }
  private openSheet(title: string, render: (body: HTMLElement) => void) {
    const prior = this.sheetRestore ?? this.root.ownerDocument.activeElement as HTMLElement;
    this.closeSheet(false); this.sheetRestore = prior;
    for (const child of Array.from(this.root.children)) (child as HTMLElement).inert = true;
    const overlay = el(this.root, "div", "em-sheet-overlay"); this.overlay = overlay;
    const scrim = this.button(overlay, "", () => this.closeSheet(), undefined, "em-sheet-scrim"); scrim.setAttribute("aria-label", "关闭弹层");
    const sheet = el(overlay, "section", "em-sheet"); sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", title); sheet.tabIndex = -1;
    const grabber = el(sheet, "div", "em-sheet-grabber"); let dragY: number | undefined;
    grabber.addEventListener("pointerdown", event => { dragY = event.clientY; grabber.setPointerCapture(event.pointerId); });
    grabber.addEventListener("pointerup", event => { if (dragY !== undefined && event.clientY - dragY > 65) this.closeSheet(); dragY = undefined; });
    const header = el(sheet, "header"); el(header, "h2", "", title); this.iconButton(header, "关闭弹层", "x", () => this.closeSheet());
    const error = el(sheet, "p", "em-sheet-error"); error.setAttribute("role", "alert"); error.hidden = true;
    const body = el(sheet, "main", "em-sheet-body"); render(body);
    sheet.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.closeSheet(); }
      if (event.key === "Tab") {
        const nodes = Array.from(sheet.querySelectorAll<HTMLElement>('button,input,textarea,select,[tabindex="0"]')).filter(node => !node.hidden && !(node as HTMLButtonElement).disabled && !node.closest('[hidden]'));
        const first = nodes[0], last = nodes.at(-1); const active = this.root.ownerDocument.activeElement;
        if (event.shiftKey && (active === first || active === sheet)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || active === sheet)) { event.preventDefault(); first?.focus(); }
      }
    });
    sheet.focus({ preventScroll: true });
  }
  private closeSheet(restore = true) {
    if (restore && this.providerPickerBack) { this.providerPickerBack(); return; }
    this.providerPickerBack = undefined;
    this.overlay?.remove(); this.overlay = undefined;
    for (const child of Array.from(this.root.children)) (child as HTMLElement).inert = false;
    if (restore && this.sheetRestore?.isConnected) this.sheetRestore.focus({ preventScroll: true });
    this.sheetRestore = undefined; this.applyAppearance();
  }
}
