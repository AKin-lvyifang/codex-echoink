import { setIcon, type App } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ApiProviderConfig } from "../../settings/settings";
import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import { MOBILE_DEFAULT_WELCOME, mobileModel, mobilePresets, mobileProvider, selectedModel, supportedProvider, validateMobileProvider, type MobileSettings } from "../../mobile/settings";
import { memoryCategories } from "../../mobile/tools";
import { type MobilePermission, MobileStore } from "../../mobile/store";
import { MobileRuntime } from "../../mobile/runtime";

export interface MobileUIHost {
  app: App;
  store: MobileStore;
  runtime: MobileRuntime;
  settings(): MobileSettings;
  saveSettings(): Promise<void>;
  openNote(path: string): Promise<void>;
  beginRender(): void;
  renderMarkdown(text: string, element: HTMLElement): void;
}
type Page = "chat" | "settings" | "basic" | "providers" | "provider" | "models" | "permissions" | "history" | "review" | "memories" | "memory" | "notes";
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
  private page: Page = "chat";
  private stack: Page[] = [];
  private scroll = new Map<string, number>();
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
  private timer?: number;
  private onRuntimeChange = () => { if (this.page === "chat") this.refreshChat(); };
  constructor(private root: HTMLElement, private host: MobileUIHost) {}
  mount() { this.mounted = true; this.root.classList.add("echoink-mobile"); this.host.runtime.onChange = this.onRuntimeChange; this.render(); this.timer = window.setInterval(() => this.updateTimers(), 250); }
  destroy() { this.mounted = false; window.clearInterval(this.timer); if (this.host.runtime.onChange === this.onRuntimeChange) this.host.runtime.onChange = () => {}; this.root.replaceChildren(); }
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
  private go(page: Page) { this.captureScroll(); this.stack.push(this.page); this.page = page; this.error = ""; this.render(); }
  private back() { this.captureScroll(); this.page = this.stack.pop() ?? "chat"; this.error = ""; this.render(); }
  private showError() {
    const box = this.root.querySelector<HTMLElement>(".em-error");
    if (box) { box.textContent = this.error; box.hidden = !this.error; }
  }
  private render() {
    this.host.beginRender(); this.root.replaceChildren();
    const header = el(this.root, "header", "em-header");
    if (this.page !== "chat") this.iconButton(header, "返回", "chevron-left", () => this.back());
    else icon(header, "bot");
    const titles: Record<Page, string> = { chat: "Nova", settings: "设置", basic: "基础设置", providers: "模型与提供商", provider: "配置提供商", models: "选择模型", permissions: "工作区权限", history: "历史对话", review: "复盘", memories: "记忆", memory: "记忆详情", notes: "引用笔记" };
    el(header, "h2", "em-title", titles[this.page]);
    if (this.page === "chat") {
      this.iconButton(header, "历史对话", "history", () => this.go("history"));
      this.iconButton(header, "设置", "settings-2", () => this.go("settings"));
    }
    const error = el(this.root, "div", "em-error"); error.setAttribute("role", "alert"); this.showError();
    const body = el(this.root, "main", "em-body");
    switch (this.page) {
      case "chat": this.chat(body); break;
      case "settings": this.settings(body); break;
      case "basic": this.basic(body); break;
      case "providers": this.providers(body); break;
      case "provider": this.provider(body); break;
      case "models": this.models(body); break;
      case "permissions": this.permissionPage(body); break;
      case "history": this.history(body); break;
      case "review": this.row(body, "记忆", "查看、修正和忘记", "brain", () => this.go("memories")); break;
      case "memories": this.memories(body); break;
      case "memory": this.memory(body); break;
      case "notes": this.notes(body); break;
    }
    body.scrollTop = this.scroll.get(this.scrollKey()) ?? 0;
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
    const compose = el(this.root, "footer", "em-compose");
    const quick = el(compose, "div", "em-quick");
    const newButton = this.button(quick, "新对话", async () => { if (this.host.runtime.busy) return; await this.host.store.createSession(); this.scroll.delete("chat"); this.render(); }, "square-pen"); newButton.disabled = this.host.runtime.busy;
    this.button(quick, "引用笔记", () => this.go("notes"), "file-text");
    this.button(quick, "写日记", () => { const area = this.root.querySelector<HTMLTextAreaElement>(".em-input")!; area.value = "帮我整理今天的记录，生成一篇 Markdown 日记并保存。\n"; this.updateDraft(area.value); area.focus(); }, "notebook-pen");
    const session = this.host.store.session;
    if (session.notePath) {
      const chip = el(compose, "div", "em-context"); this.button(chip, session.notePath, () => this.host.openNote(session.notePath), "file-text");
      this.iconButton(chip, "移除笔记引用", "x", async () => { session.notePath = ""; await this.host.store.save(); this.render(); });
    }
    const composer = el(compose, "div", "em-composer");
    const input = el(composer, "textarea", "em-input"); input.placeholder = "和 Nova 说说你的想法…"; input.setAttribute("aria-label", "消息草稿"); input.rows = 2; input.value = session.draft;
    input.addEventListener("input", () => this.updateDraft(input.value));
    const controls = el(composer, "div", "em-composer-tools");
    this.iconButton(controls, `工作区权限：${permissions.find(p => p[0] === this.host.store.state.permission)?.[1]}`, "shield-check", () => this.go("permissions"));
    const model = selectedModel(this.host.settings());
    const picker = this.button(controls, "", () => this.go("models"), undefined, "em-model"); picker.setAttribute("aria-label", "选择模型");
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
  private updateDraft(text: string) { this.host.store.session.draft = text; void this.act(() => this.host.store.save()); }
  private refreshChat() {
    if (!this.mounted) return;
    // Preserve keyboard focus and draft while only message and status regions change.
    const body = this.root.querySelector<HTMLElement>(".em-messages");
    if (!body) return;
    const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 90;
    this.host.beginRender(); body.replaceChildren(); this.messages(body);
    if (nearBottom) body.scrollTop = body.scrollHeight;
    const input = this.root.querySelector<HTMLTextAreaElement>(".em-input");
    if (input && input.value !== this.host.store.session.draft) input.value = this.host.store.session.draft;
    const send = this.root.querySelector<HTMLButtonElement>(".em-send");
    if (send) { send.replaceChildren(); icon(send, this.host.runtime.busy ? "square" : "arrow-up"); send.setAttribute("aria-label", this.host.runtime.busy ? "停止回答" : "发送消息"); }
    const newButton = this.root.querySelector<HTMLButtonElement>(".em-quick button"); if (newButton) newButton.disabled = this.host.runtime.busy;
    const status = this.root.querySelector<HTMLElement>(".em-status"); if (status) status.textContent = this.host.runtime.busy ? "正在等待模型或执行工具…" : "";
    this.error = this.host.runtime.error; this.showError();
  }
  private updateTimers() {
    if (!this.host.runtime.busy || this.page !== "chat") return;
    for (const element of Array.from(this.root.querySelectorAll<HTMLElement>(".em-tool-timer"))) {
      const timing = this.host.store.session.tools[element.dataset.callId ?? ""];
      if (timing && timing.elapsedMs === undefined) element.textContent = `${((Date.now() - timing.startedAt) / 1000).toFixed(1)} 秒 · 进行中`;
    }
  }
  private messages(body: HTMLElement) {
    const session = this.host.store.session;
    if (!session.messages.length) {
      const welcome = el(body, "section", "em-welcome"); el(welcome, "span", "em-eyebrow", "EchoInk · Nova");
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
    this.row(body, "基础设置", "长期记忆、自定义欢迎语", "sliders-horizontal", () => this.go("basic"));
    this.row(body, "API Provider", "模型与提供商", "cpu", () => this.go("providers"));
    this.row(body, "复盘", "查看与修正记忆", "brain", () => this.go("review"));
  }
  private basic(body: HTMLElement) {
    const label = el(body, "label", "em-row"); const text = el(label, "span", "em-row-label"); el(text, "strong", "", "长期记忆"); el(text, "small", "", "保存值得保留的信息，在后续对话中召回");
    const toggle = el(label, "input"); toggle.type = "checkbox"; toggle.checked = this.host.store.state.memoryEnabled; toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-label", "长期记忆");
    toggle.addEventListener("change", () => { void this.act(async () => { this.host.runtime.stop(); this.host.store.state.memoryEnabled = toggle.checked; await this.host.store.save(); }); });
    el(body, "p", "em-help", "关闭后保留已有记忆，停止自动召回和写入。记忆查看与忘记仍可使用。");

    const settings = this.host.settings();
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
  }
  private permissionPage(body: HTMLElement) {
    for (const [id, title, description] of permissions) {
      const row = this.row(body, title, description, this.host.store.state.permission === id ? "circle-check" : "circle", async () => { this.host.store.state.permission = id; await this.host.store.save(); this.back(); }); row.setAttribute("aria-pressed", String(this.host.store.state.permission === id));
    }
    el(body, "p", "em-help", "三种权限均限定于当前笔记库。长期记忆由基础设置中的开关独立控制。");
  }
  private providers(body: HTMLElement) {
    for (const provider of this.host.settings().apiProviders.filter(supportedProvider)) {
      const row = this.row(body, provider.name, `${provider.models.map(m => m.displayName || m.id).join("、")}${provider.id === this.host.settings().activeApiProviderId ? " · 当前" : ""}`, "cpu", () => { this.providerDraft = structuredClone(provider); this.go("provider"); });
      const mark = row.querySelector<HTMLElement>(".em-icon")!; mark.replaceChildren(); renderProviderBrandIcon(mark, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
    }
    this.button(body, "添加提供商", () => { this.providerDraft = mobileProvider("deepseek"); this.go("provider"); }, "plus", "em-wide-action");
  }
  private field(parent: HTMLElement, title: string, value: string, update: (value: string) => void, type = "text") {
    const label = el(parent, "label", "em-field"); el(label, "span", "", title); const input = el(label, "input"); input.type = type; input.value = value; input.setAttribute("aria-label", title); input.autocomplete = "off"; input.spellcheck = false;
    input.addEventListener("input", () => update(input.value)); return input;
  }
  private provider(body: HTMLElement) {
    const draft = this.providerDraft!;
    const form = el(body, "div", "em-form");
    const presetLabel = el(form, "label", "em-field"); el(presetLabel, "span", "", "供应商"); const presets = el(presetLabel, "select"); presets.setAttribute("aria-label", "供应商");
    for (const preset of mobilePresets) { const option = el(presets, "option", "", preset.name.split(" / ")[0]); option.value = preset.id; }
    presets.value = draft.providerId ?? "custom";
    presets.addEventListener("change", () => { const selected = mobilePresets.find(preset => preset.id === presets.value); if (!selected) return; const preset = mobileProvider(selected.id); this.providerDraft = { ...draft, ...preset, id: draft.id, apiKey: draft.providerId === preset.providerId ? draft.apiKey : "" }; this.render(); });
    this.field(form, "名称", draft.name, value => { draft.name = value; });
    this.field(form, "API Key", draft.apiKey, value => { draft.apiKey = value; }, "password");
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
        await this.host.saveSettings(); this.back();
      } finally { this.saving = false; }
    };
    this.button(form, "保存并设为当前", () => persist(true), "check", "em-primary em-wide-action");
    this.button(form, "保存", () => persist(false), undefined, "em-wide-action");
    if (this.host.settings().apiProviders.some(p => p.id === draft.id)) {
      this.button(form, "删除提供商", () => this.confirmAction(form, `删除「${draft.name}」的本地配置？`, "确认删除", async () => {
        const settings = this.host.settings(); settings.apiProviders = settings.apiProviders.filter(p => p.id !== draft.id);
        if (settings.activeApiProviderId === draft.id) { settings.activeApiProviderId = ""; settings.defaultModel = ""; }
        await this.host.saveSettings(); this.back();
      }), "trash-2", "em-danger em-wide-action");
    }
  }
  private models(body: HTMLElement) {
    const settings = this.host.settings();
    for (const provider of settings.apiProviders.filter(supportedProvider)) for (const model of provider.models) {
      const active = provider.id === settings.activeApiProviderId && model.id === settings.defaultModel;
      const row = this.row(body, model.displayName || model.id, provider.name, active ? "check" : "cpu", async () => { settings.activeApiProviderId = provider.id; settings.defaultModel = model.id; settings.providerMode = "api"; await this.host.saveSettings(); this.back(); }); row.setAttribute("aria-pressed", String(active));
      const mark = row.querySelector<HTMLElement>(".em-icon")!; mark.replaceChildren(); renderProviderBrandIcon(mark, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
      if (active) { const check = row.querySelector<HTMLElement>(".em-icon:last-child")!; check.replaceChildren(); setIcon(check, "check"); }
    }
    this.button(body, "模型与提供商设置", () => this.go("providers"), "settings-2", "em-wide-action");
  }
  private history(body: HTMLElement) {
    for (const session of this.host.store.state.sessions) {
      const row = this.row(body, session.title, new Date(session.updatedAt).toLocaleString(), "message-square", async () => { if (this.host.runtime.busy) throw new Error("请先停止当前回答。"); this.host.store.state.activeSessionId = session.id; await this.host.store.save(); this.stack = []; this.page = "chat"; this.scroll.delete("chat"); this.render(); }); row.disabled = this.host.runtime.busy;
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
      for (const record of items) this.row(rows, record.title, memoryCategories.find(c => (c.kinds as readonly string[]).includes(record.kind))?.label ?? "", "brain", () => { this.memoryId = record.id; this.memoryEditing = this.memoryDrafts.has(record.id); this.go("memory"); });
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
      this.button(body, "保存修改", async () => {
        if (!this.host.store.state.memoryEnabled) throw new Error("请先在基础设置中开启长期记忆。");
        if (!draft.title.trim() || !draft.content.trim()) throw new Error("标题和内容不能为空。");
        const updated = { ...record, title: draft.title.trim(), content: draft.content.trim(), date: new Date().toISOString(), revision: record.revision + 1, basis: "explicit" as const, contentOrigin: "user_edit" as const };
        this.host.store.state.memories = this.host.store.state.memories.map(r => r.id === record.id ? updated : r); await this.host.store.save(); this.memoryDrafts.delete(record.id); this.memoryEditing = false; this.render();
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
    if (active?.extension === "md") this.row(body, "当前笔记", active.path, "file-text", async () => { this.host.store.session.notePath = active.path; await this.host.store.save(); this.back(); });
    this.search(body, "按标题或路径查找笔记", this.noteQuery, value => { this.noteQuery = value; renderRows(); });
    const rows = el(body, "div");
    const renderRows = () => {
      rows.replaceChildren();
      const files = this.host.app.vault.getMarkdownFiles().filter(f => !f.path.split("/").some(p => p.startsWith(".")) && f.path.toLocaleLowerCase().includes(this.noteQuery.toLocaleLowerCase())).slice(0, 60);
      if (!files.length) el(rows, "p", "em-empty", "没有找到笔记");
      for (const file of files) this.row(rows, file.basename, file.path, "file-text", async () => { this.host.store.session.notePath = file.path; await this.host.store.save(); this.back(); });
    }; renderRows();
  }
}
