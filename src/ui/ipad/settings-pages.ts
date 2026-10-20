import { Notice } from "obsidian";
import license from "../../../LICENSE";
import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md";
import { MobileModelConfiguration } from "../../mobile/model-configuration";
import { GENERAL_ASSISTANT_ID, type AgentModuleId } from "../../agents/types";
import { BUILTIN_SKILL_IDS } from "../../harness/resources/builtin-skills";
import { getProPluginAccess, unavailableCapabilityAccess } from "../../membership/access";
import { mobileModuleEnabled, setMobileModuleEnabled } from "../../mobile/module-settings";
import { MobileUI } from "../mobile/mobile-ui";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { MobileShellPage } from "../mobile/shell-types";
import { IPadSettingsShell } from "./settings-shell";
import { createAgentFormPage } from "./agent-form";
import { createModelPage } from "./model-pages";
import { settingsText as t } from "./settings-i18n";
import type { IPadPageContext, IPadWorkbenchHost } from "./workbench-contract";
import { IPAD_MODULES, ipadAvatar, ipadIcon } from "./workbench-elements";
import { el, settingsContent, settingsGroup, settingsRow, settingsAction, settingsSwitch, settingsToggle, liveSettingsPage, type IPadSettingsContext } from "./settings-elements";

const CATEGORIES = [["general", "settings", "通用"], ["model", "key-round", "模型"], ["agent", "bot", "Agent"], ["caps", "layout-list", "能力"], ["mods", "blocks", "模块"], ["account", "feather", "账号与会员"]] as const;
const aliases: Record<string, string> = { providers: "model", models: "model", basic: "general", layout: "general", resources: "caps", modules: "mods" };

/** One central settings tab; the Agent pane and its input nodes remain untouched. */
export class IPadSettings {
  readonly shell: IPadSettingsShell;
  private readonly context: IPadSettingsContext;
  private mounted = false;
  private disposed = false;
  private readonly unsubscribers: (() => void)[] = [];
  constructor(private readonly root: HTMLElement, private readonly host: IPadWorkbenchHost) {
    root.classList.add("pd-settings");
    const categories = CATEGORIES.map(([id, icon, label]) => ({ id, icon, label: t({ host }, label), createPage: () => this.category(id) }));
    this.shell = new IPadSettingsShell(root, categories, { onError: error => this.error(error) });
    this.context = { root, host, document: root.ownerDocument, shell: this.shell,
      models: new MobileModelConfiguration(host.settings, host.saveSettings, host.modelRequest),
      error: error => this.error(error), refresh: () => this.refresh(),
      push: async page => { const moved = await this.shell.push(page); if (!moved) page.dispose?.(); return moved; }, back: () => this.shell.back() };
    this.unsubscribers.push(host.services.subscribeIdentity(() => this.refresh()), host.workbench.subscribe(() => this.refresh()));
    if (host.accountService) this.unsubscribers.push(host.accountService.subscribe(() => this.refresh()));
  }
  async mount(category?: string): Promise<void> {
    if (this.disposed) return;
    await this.host.agents.snapshot(); if (this.disposed) return;
    this.mounted = true; await this.shell.mount(category ? aliases[category] ?? category : undefined); this.refresh();
  }
  async open(category?: string): Promise<void> {
    if (this.disposed) return;
    if (!this.mounted) { await this.mount(category); return; }
    if (category) {
      const id = aliases[category] ?? category;
      if (await this.shell.selectCategory(id)) await this.shell.activePageShell?.backTo(`ipad-settings-${id}`);
    }
    this.refresh();
  }
  private refresh(): void {
    if (this.disposed) return;
    this.root.ownerDocument.body.setAttribute("data-echoink-theme", this.host.settings().colorTheme === "violet" ? "violet" : "green");
    for (const [id, , label] of CATEGORIES) {
      const text = this.root.querySelector(`[data-category-id="${id}"] .echoink-ipad-settings-category-label`); if (text) text.textContent = t(this.context, label);
    }
    this.root.dispatchEvent(new this.root.ownerDocument.defaultView!.Event("pd-settings-refresh"));
  }
  private error(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }
  private category(id: string): MobileShellPage {
    if (id === "general") return this.general();
    if (id === "model") return createModelPage(this.context);
    if (id === "agent") return this.agent();
    if (id === "caps") return this.capabilities();
    if (id === "mods") return this.modules();
    return this.legacy("account", "账号与会员", "ipad-settings-account");
  }
  private async save(change: (settings: ReturnType<IPadWorkbenchHost["settings"]>) => () => void): Promise<void> {
    const restore = change(this.host.settings());
    try { await this.host.saveSettings(); } catch (error) { restore(); this.refresh(); throw error; }
    this.refresh();
  }
  private general(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx); let signature = "", busy = false;
    const render = () => {
      const settings = this.host.settings(), key = JSON.stringify([settings.colorTheme, settings.settingsLanguage, settings.autoOpenHome, this.host.version]);
      if (key === signature) return; signature = key; content.replaceChildren();
      const appearance = settingsGroup(ctx, content, t(ctx, "外观")), row = settingsRow(ctx, appearance, t(ctx, "配色"));
      const track = el(ctx.document, "div", "pd-settings-segments"); track.setAttribute("role", "group"); track.setAttribute("aria-label", t(ctx, "配色"));
      track.dataset.value = settings.colorTheme === "violet" ? "violet" : "green";
      track.append(el(ctx.document, "span", "pd-settings-segment-thumb"));
      for (const [value, label] of [["green", "暖白翠绿"], ["violet", "雾紫石墨"]]) {
        const button = el(ctx.document, "button", "pd-settings-segment", t(ctx, label)); button.type = "button";
        button.setAttribute("aria-pressed", String(track.dataset.value === value));
        button.addEventListener("click", () => { if (busy || this.host.settings().colorTheme === value) return; busy = true;
          track.querySelectorAll("button").forEach(control => { control.disabled = true; });
          void this.save(current => { const old = current.colorTheme; current.colorTheme = value; return () => { current.colorTheme = old; }; }).catch(ctx.error).finally(() => { busy = false; signature = ""; render(); }); }); track.append(button);
      }
      row.append(track);
      settingsRow(ctx, appearance, t(ctx, "界面语言"), settings.settingsLanguage === "en" ? "English" : "简体中文", () => ctx.push(this.language()));
      settingsSwitch(ctx, settingsGroup(ctx, content, t(ctx, "启动")), t(ctx, "启动时打开工作台"), settings.autoOpenHome === true, enabled => this.save(current => {
        const previous = current.autoOpenHome; current.autoOpenHome = enabled; return () => { current.autoOpenHome = previous; };
      }));
      settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "关于")), "EchoInk Agent", this.host.version ?? "", () => ctx.push(this.about()));
    };
    return liveSettingsPage(ctx, { id: "ipad-settings-general", title: "通用", content }, render);
  }
  private language(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx); let busy = false, signature = "";
    const render = () => {
      const value = this.host.settings().settingsLanguage; if (value === signature) return; signature = value; content.replaceChildren();
      const group = settingsGroup(ctx, content, t(ctx, "界面语言"));
      for (const [id, label] of [["zh-CN", "简体中文"], ["en", "English"]]) {
        const row = settingsRow(ctx, group, label, value === id ? t(ctx, "已选择") : "", async () => {
          if (busy || this.host.settings().settingsLanguage === id) return; busy = true;
          try { await this.save(settings => { const old = settings.settingsLanguage; settings.settingsLanguage = id as "en" | "zh-CN"; return () => { settings.settingsLanguage = old; }; }); }
          finally { busy = false; }
        }); row.setAttribute("aria-pressed", String(value === id));
      }
    };
    return liveSettingsPage(ctx, { id: "ipad-settings-language", title: "界面语言", content }, render);
  }
  private about(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx);
    let language = "";
    return liveSettingsPage(ctx, { id: "ipad-settings-about", title: "关于 EchoInk", content }, () => {
      const value = this.host.settings().settingsLanguage; if (language === value) return; language = value; content.replaceChildren();
      content.append(el(ctx.document, "h2", "pd-settings-about-title", "EchoInk Agent"), el(ctx.document, "p", "", this.host.version ? `${value === "en" ? "Version" : "版本"} ${this.host.version}` : t(ctx, "版本未提供")));
      for (const [title, text] of [["组件许可", license], ["第三方许可", thirdPartyNotices]]) {
        const details = el(ctx.document, "details", "pd-settings-license"); details.append(el(ctx.document, "summary", "", t(ctx, title)), el(ctx.document, "pre", "", text)); content.append(details);
      }
    });
  }
  private agentContext(): IPadPageContext {
    const controller = this;
    return { root: this.root, host: this.host, document: this.root.ownerDocument,
      get shell() { const shell = controller.shell.activePageShell; if (!shell) throw new Error("设置页面尚未打开。"); return shell; },
      error: error => this.error(error), navigate: async route => {
        if (route.kind === "agent-form") await this.context.push(createAgentFormPage(this.agentContext(), route.agentId));
        else if (route.kind === "agent") { await this.shell.activePageShell?.backTo("ipad-settings-agent"); this.refresh(); }
      } };
  }
  private agent(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx); let signature = "";
    const render = () => {
      const registry = this.host.settings().agentRegistry, key = JSON.stringify([registry, this.host.store.state.memoryEnabled, this.host.settings().settingsLanguage]);
      if (key === signature) return; signature = key; content.replaceChildren();
      const agents = settingsGroup(ctx, content, t(ctx, "我的 Agent"));
      for (const agent of registry.agents) settingsRow(ctx, agents, agent.name, "", () => ctx.push(createAgentFormPage(this.agentContext(), agent.id)), ipadAvatar(ctx.document, agent), agent.position);
      settingsRow(ctx, agents, t(ctx, "新建 Agent"), "", () => ctx.push(createAgentFormPage(this.agentContext())), ipadIcon(ctx.document, "user-plus"));
      const owners = settingsGroup(ctx, content, t(ctx, "模块负责人"));
      for (const module of IPAD_MODULES) {
        const owner = registry.agents.find(agent => agent.id === registry.moduleOwners[module.id]);
        settingsRow(ctx, owners, module.name, owner?.name ?? "总助", () => ctx.push(this.owner(module.id)), ipadIcon(ctx.document, module.icon));
      }
      const memory = settingsGroup(ctx, content, t(ctx, "记忆"));
      settingsSwitch(ctx, memory, t(ctx, "长期记忆"), this.host.store.state.memoryEnabled, async enabled => { await this.host.store.setMemoryEnabled(enabled); this.refresh(); });
      settingsRow(ctx, memory, t(ctx, "记忆修正"), "", () => ctx.push(this.legacy("memories", "长期记忆")));
      settingsRow(ctx, memory, t(ctx, "你的画像"), "", () => ctx.push(this.legacy("profile-user", "你的画像")));
      settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "会话")), t(ctx, "已归档会话"), "", () => ctx.push(this.legacy("archives", "已归档会话")));
    };
    return liveSettingsPage(ctx, { id: "ipad-settings-agent", title: "Agent", content }, render);
  }
  private owner(moduleId: AgentModuleId): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx), group = settingsGroup(ctx, content, "选一位负责人"); let busy = false;
    for (const agent of this.host.settings().agentRegistry.agents) settingsRow(ctx, group, agent.name, this.host.settings().agentRegistry.moduleOwners[moduleId] === agent.id ? "已选择" : "", async () => {
      if (busy) return; busy = true;
      try { const snapshot = await this.host.agents.snapshot(); await this.host.agents.setOwner(moduleId, agent.id || GENERAL_ASSISTANT_ID, snapshot.version); await this.host.services.refreshAgentIdentity(); this.refresh(); await ctx.back(); }
      finally { busy = false; }
    }, ipadAvatar(ctx.document, agent));
    return { id: `ipad-settings-owner-${moduleId}`, title: "模块负责人", content };
  }
  private capabilities(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx); let signature = "";
    const render = () => {
      const resources = this.host.settings().resources, key = JSON.stringify(resources); if (key === signature) return; signature = key; content.replaceChildren();
      const skills = this.host.services.skills(), skillGroup = settingsGroup(ctx, content, "Skills");
      const builtin = skills.filter(item => (BUILTIN_SKILL_IDS as readonly string[]).includes(item.id));
      settingsRow(ctx, skillGroup, t(ctx, "内置技能"), `${builtin.length}`, () => ctx.push(this.legacy("resources", "Skills", undefined, "skills")), ipadIcon(ctx.document, "sparkles"));
      settingsRow(ctx, skillGroup, t(ctx, "我的 Skill"), `${skills.length - builtin.length}`, () => ctx.push(this.legacy("resources", "Skills", undefined, "skills")), ipadIcon(ctx.document, "sparkles"));
      const mcp = settingsGroup(ctx, content, "MCP");
      for (const resource of resources.catalog.filter(item => item.kind === "mcp-server")) settingsRow(ctx, mcp, resource.name, resources.mcpConnections[resource.id]?.transport === "http" ? "远程配置" : "仅电脑", () => ctx.push(this.legacy("resources", resource.name, undefined, "mcp")), ipadIcon(ctx.document, "plug"));
      settingsRow(ctx, mcp, t(ctx, "管理 MCP 服务"), "", () => ctx.push(this.legacy("resources", "MCP 服务", undefined, "mcp")), ipadIcon(ctx.document, "plus"));
      settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "工具")), "Tavily", t(ctx, "移动端暂不可配置"), undefined, ipadIcon(ctx.document, "globe"));
    };
    return liveSettingsPage(ctx, { id: "ipad-settings-caps", title: "能力", content }, render);
  }
  private modules(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx);
    let signature = "";
    return liveSettingsPage(ctx, { id: "ipad-settings-mods", title: "模块", content }, () => {
      const settings = this.host.settings(), qualified = getProPluginAccess(this.host.accountService ?? unavailableCapabilityAccess, false).canToggle;
      const definitions = [["knowledge-base", "知识库", "library", "knowledge", false], ["journal", "日记", "book-open", undefined, false], ["review", "复盘", "history", "review", false], ["todos", "待办", "list-todo", "todos-settings", false], ["finance", "财务", "wallet", "finance-settings", true], ["english-diary", "英文日记", "languages", undefined, true]] as const;
      const key = JSON.stringify([settings.settingsLanguage, settings.journalDirectory, settings.englishDiary, qualified, definitions.map(([id]) => mobileModuleEnabled(settings, id))]); if (key === signature) return; signature = key; content.replaceChildren();
      const basic = settingsGroup(ctx, content, t(ctx, "基础模块")), pro = settingsGroup(ctx, content, t(ctx, "PRO 模块"));
      for (const [id, label, icon, route, paid] of definitions) {
        const directory = id === "journal" ? settings.journalDirectory : id === "english-diary" ? settings.englishDiary.englishDirectory : "";
        const row = settingsRow(ctx, paid ? pro : basic, t(ctx, label), directory, undefined, ipadIcon(ctx.document, icon)); row.classList.add("pd-settings-module-row");
        const copy = row.querySelector<HTMLElement>(".pd-settings-copy")!;
        if (route) {
          const title = el(ctx.document, "button", "pd-settings-module-title"); title.type = "button"; title.append(...Array.from(copy.childNodes)); copy.append(title);
          title.addEventListener("click", event => { event.stopPropagation(); void ctx.push(this.legacy(route, label)).catch(ctx.error); });
        }
        if (!paid || qualified) {
          const control = settingsToggle(ctx, `${t(ctx, "启用")}${t(ctx, label)}`, mobileModuleEnabled(settings, id), async enabled => { await setMobileModuleEnabled(this.host, id, enabled); this.refresh(); });
          const hit = el(ctx.document, "label", "pd-settings-switch-hit"); hit.append(control); hit.addEventListener("click", event => event.stopPropagation()); row.append(hit);
        } else {
          const membership = settingsAction(ctx, "需要 PRO", () => ctx.push(this.legacy("account", "账号与会员"))); row.append(membership);
        }
      }
    });
  }
  private legacy(route: MobileSettingsRoute, title: string, id = `ipad-settings-legacy-${route}`, resourceTab?: string): MobileShellPage {
    const content = el(this.root.ownerDocument, "div", "pd-settings-legacy");
    const ui = new MobileUI(content, { app: this.host.app, store: this.host.store, runtime: this.host.runtime, services: this.host.services,
      settings: this.host.settings, saveSettings: this.host.saveSettings, settingsOnly: true,
      accountService: this.host.accountService, version: this.host.version, settingsRoot: route,
      onSettingsRootBack: async () => { await this.shell.back(); }, openChat: async () => { await this.shell.back(); },
      openNote: this.host.openNote, beginRender: () => {}, renderMarkdown: this.host.renderMarkdown });
    ui.mount();
    if (resourceTab) content.querySelector<HTMLButtonElement>(`button[data-tab="${resourceTab}"]`)?.click();
    return { id, title, header: "content", content, dispose: () => ui.destroy() };
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unsubscribers.forEach(unsubscribe => unsubscribe()); this.shell.dispose(); this.root.classList.remove("pd-settings"); }
}
