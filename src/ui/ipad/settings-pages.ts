import { Notice } from "obsidian";
import { effectiveEchoInkColorTheme, ECHOINK_APPEARANCE_REFRESH, ECHOINK_COLOR_THEMES, renderCompanionThemeRecommendation } from "../appearance-theme";
import { decorateProAppearanceChoice } from "../appearance-pro";
import license from "../../../LICENSE";
import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md";
import { MobileModelConfiguration } from "../../mobile/model-configuration";
import { getProPluginAccess, hasProPluginAccess, unavailableCapabilityAccess } from "../../membership/access";
import { mobileModuleEnabled, setMobileModuleEnabled } from "../../mobile/module-settings";
import { MobileUI } from "../mobile/mobile-ui";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { MobileShellPage } from "../mobile/shell-types";
import { IPadSettingsShell } from "./settings-shell";
import { createAgentFormPage } from "./agent-form";
import { createAccountPage } from "./account-pages";
import { createAgentSettingsPage } from "./agent-settings-pages";
import { createCapabilityPage } from "./capability-pages";
import { createModelPage } from "./model-pages";
import { createFinanceSettingsPage } from "./finance-forms";
import { moduleView, moduleSettingsGroup, moduleNavigationRow } from "./module-elements";
import { createTodoSettings } from "./todo-pages";
import { createIPadKnowledgeSettingsPage } from "./knowledge-settings-pages";
import { createEnglishDiarySettingsPage } from "./english-diary-pages";
import { settingsText as t } from "./settings-i18n";
import type { IPadPageContext, IPadWorkbenchHost } from "./workbench-contract";
import { ipadIcon } from "./workbench-elements";
import { el, settingsContent, settingsGroup, settingsRow, settingsAction, settingsSwitch, settingsToggle, settingsError, showSettingsError, leaveSettingsConfirm, liveSettingsPage, type IPadSettingsContext } from "./settings-elements";

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
      models: new MobileModelConfiguration(host.settings, host.saveSettings, host.modelRequest, host.services.usageObserver),
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
    if (category === "english-diary-settings") {
      if (!this.mounted) await this.mount("mods");
      if (await this.shell.selectCategory("mods")) {
        const pages = this.shell.activePageShell;
        if (pages?.hasPage("ipad-english-settings")) await pages.backTo("ipad-english-settings");
        else await this.context.push(createEnglishDiarySettingsPage(this.context, () => this.refresh()));
      }
      this.refresh(); return;
    }
    if (category === "knowledge") {
      if (!this.mounted) await this.mount("mods");
      if (await this.shell.selectCategory("mods")) {
        const pages = this.shell.activePageShell;
        if (pages?.hasPage("ipad-settings-knowledge")) await pages.backTo("ipad-settings-knowledge");
        else await this.context.push(createIPadKnowledgeSettingsPage(this.context));
      }
      this.refresh(); return;
    }
    if (!this.mounted) { await this.mount(category); return; }
    if (category) {
      const id = aliases[category] ?? category;
      if (await this.shell.selectCategory(id)) await this.shell.activePageShell?.backTo(`ipad-settings-${id}`);
    }
    this.refresh();
  }
  private refresh(): void {
    if (this.disposed) return;
    this.root.ownerDocument.body.setAttribute("data-echoink-theme", effectiveEchoInkColorTheme(this.host.settings().colorTheme, this.host.accountService));
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
    return createAccountPage(this.context);
  }
  private async save(change: (settings: ReturnType<IPadWorkbenchHost["settings"]>) => () => void): Promise<void> {
    const restore = change(this.host.settings());
    try { await this.host.saveSettings(); } catch (error) { restore(); this.refresh(); throw error; }
    this.refresh();
  }
  private general(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx); let signature = "", busy = false;
    const render = () => {
      const settings = this.host.settings(), hasPro = () => hasProPluginAccess(this.host.accountService ?? unavailableCapabilityAccess), key = JSON.stringify([hasPro(), settings.colorTheme, settings.settingsLanguage, settings.autoOpenHome, this.host.version]);
      if (key === signature) return; signature = key; content.replaceChildren();
      const appearance = settingsGroup(ctx, content, t(ctx, "外观")), row = settingsRow(ctx, appearance, t(ctx, "配色"));
      const track = el(ctx.document, "div", "pd-settings-segments"); track.setAttribute("role", "group"); track.setAttribute("aria-label", t(ctx, "配色"));
      track.dataset.value = effectiveEchoInkColorTheme(settings.colorTheme, this.host.accountService);
      track.classList.add("echoink-appearance-pro-surface");
      track.append(el(ctx.document, "span", "pd-settings-segment-thumb"));
      for (const { id: value, zh: label } of ECHOINK_COLOR_THEMES) {
        const button = el(ctx.document, "button", "pd-settings-segment", t(ctx, label)); button.type = "button";
        button.setAttribute("aria-pressed", String(track.dataset.value === value));
        button.addEventListener("click", () => { if (busy || value !== "minimal" && !hasPro() || effectiveEchoInkColorTheme(this.host.settings().colorTheme, this.host.accountService) === value) return; busy = true;
          track.dataset.value = value;
          this.root.ownerDocument.body.setAttribute("data-echoink-theme", effectiveEchoInkColorTheme(value, this.host.accountService));
          track.querySelectorAll("button").forEach(control => { control.disabled = true; control.setAttribute("aria-pressed", String(control === button)); });
          void this.save(current => { const old = current.colorTheme; current.colorTheme = value; return () => { current.colorTheme = old; }; }).catch(error => ctx.error(error)).finally(() => { busy = false; signature = ""; render(); }); }); if (value !== "minimal") decorateProAppearanceChoice(button, track, { zh: settings.settingsLanguage !== "en", allowed: hasPro, upgrade: () => { void ctx.push(this.category("account")); } })(); track.append(button);
      }
      row.append(track);
      renderCompanionThemeRecommendation(appearance, settings.settingsLanguage !== "en");
      settingsRow(ctx, appearance, t(ctx, "界面语言"), settings.settingsLanguage === "en" ? "English" : "简体中文", () => ctx.push(this.language()));
      settingsSwitch(ctx, settingsGroup(ctx, content, t(ctx, "启动")), t(ctx, "启动时打开工作台"), settings.autoOpenHome === true, enabled => this.save(current => {
        const previous = current.autoOpenHome; current.autoOpenHome = enabled; return () => { current.autoOpenHome = previous; };
      }));
      settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "关于")), "EchoInk Agent", this.host.version ?? "", () => ctx.push(this.about()));
    };
    content.dataset.echoinkAppearancePicker = ""; content.addEventListener(ECHOINK_APPEARANCE_REFRESH, render);
    return liveSettingsPage(ctx, { id: "ipad-settings-general", title: "通用", content, dispose: () => content.removeEventListener(ECHOINK_APPEARANCE_REFRESH, render) }, render);
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
    const activeShell = () => this.shell.activePageShell;
    return { root: this.root, host: this.host, document: this.root.ownerDocument,
      get shell() { const shell = activeShell(); if (!shell) throw new Error("设置页面尚未打开。"); return shell; },
      error: error => this.error(error), navigate: async route => {
        if (route.kind === "agent-form") await this.context.push(createAgentFormPage(this.agentContext(), route.agentId));
        else if (route.kind === "agent") { await this.shell.activePageShell?.backTo("ipad-settings-agent"); this.refresh(); }
      } };
  }
  private agent(): MobileShellPage {
    return createAgentSettingsPage(this.context, id => this.context.push(createAgentFormPage(this.agentContext(), id)));
  }
  private moduleContext(): IPadPageContext {
    const shell = this.shell.activePageShell; if (!shell) throw new Error("设置页面尚未打开。");
    return { root: this.root, document: this.root.ownerDocument, host: this.host, shell,
      error: error => this.error(error), navigate: async route => { if (route.kind === "home") await shell.backTo("ipad-settings-mods"); else await this.host.openAgent(route); } };
  }
  private capabilities(): MobileShellPage {
    return createCapabilityPage(this.context, id => this.context.push(createAgentFormPage(this.agentContext(), id)));
  }
  private modules(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx);
    let signature = "";
    return liveSettingsPage(ctx, { id: "ipad-settings-mods", title: "模块", content }, () => {
      const settings = this.host.settings(), qualified = getProPluginAccess(this.host.accountService ?? unavailableCapabilityAccess, false).canToggle;
      const definitions = [["knowledge-base", "知识库", "library", "knowledge", false], ["journal", "日记", "book-open", "journal", false], ["review", "复盘", "history", "review", false], ["todos", "待办", "list-todo", "todos-settings", false], ["finance", "财务", "wallet", "finance-settings", true], ["english-diary", "英文日记", "languages", "english-diary-settings", true]] as const;
      const key = JSON.stringify([settings.settingsLanguage, settings.journalDirectory, settings.englishDiary, qualified, definitions.map(([id]) => mobileModuleEnabled(settings, id))]); if (key === signature) return; signature = key; content.replaceChildren();
      const basic = settingsGroup(ctx, content, t(ctx, "基础模块")), pro = settingsGroup(ctx, content, t(ctx, "PRO 模块"));
      for (const [id, label, icon, route, paid] of definitions) {
        const directory = id === "journal" ? settings.journalDirectory : id === "english-diary" ? settings.englishDiary.englishDirectory : "";
        const policy = paid ? getProPluginAccess(this.host.accountService ?? unavailableCapabilityAccess, mobileModuleEnabled(settings, id)) : undefined;
        const row = settingsRow(ctx, paid ? pro : basic, t(ctx, label)); row.classList.add("pd-settings-module-row");
        const copy = row.querySelector<HTMLElement>(".pd-settings-copy")!, title = el(ctx.document, "button", "pd-settings-module-title"); title.type = "button";
        const value = el(ctx.document, "span", "pd-settings-value", directory); title.append(ipadIcon(ctx.document, icon), copy, value, ipadIcon(ctx.document, "chevron-right")); row.append(title);
        if (policy && !policy.canToggle) { title.title = policy.reason ?? t(ctx, "需要 PRO"); copy.append(el(ctx.document, "span", "pd-settings-description", policy.reason ?? t(ctx, "需要 PRO"))); }
        title.addEventListener("click", event => { event.stopPropagation(); void Promise.resolve().then(async () => {
          const current = paid ? getProPluginAccess(this.host.accountService ?? unavailableCapabilityAccess, mobileModuleEnabled(this.host.settings(), id)) : undefined;
          if (current && !current.canToggle) throw new Error(current.reason ?? t(ctx, "需要 PRO"));
          if (route === "journal") {
            const moduleCtx = this.moduleContext(), v = moduleView(moduleCtx, "ipad-journal-settings", t(ctx, "日记设置")); v.content.classList.add("is-settings");
            moduleNavigationRow(moduleCtx, moduleSettingsGroup(moduleCtx, v.body), t(ctx, "日记位置"), this.host.settings().journalDirectory, () => this.host.services.modules.journal.openSettings()); await ctx.push(v.finish());
          } else await ctx.push(route === "knowledge" ? createIPadKnowledgeSettingsPage(ctx) : route === "english-diary-settings" ? createEnglishDiarySettingsPage(ctx, () => ctx.refresh()) : route === "todos-settings" ? createTodoSettings(this.moduleContext()) : route === "finance-settings" ? createFinanceSettingsPage(this.moduleContext()) : this.review());
        }).catch(error => ctx.error(error)); });
        if (!paid || qualified) {
          const control = settingsToggle(ctx, `${t(ctx, "启用")}${t(ctx, label)}`, mobileModuleEnabled(settings, id), async enabled => { await setMobileModuleEnabled(this.host, id, enabled); this.refresh(); });
          const hit = el(ctx.document, "label", "pd-settings-switch-hit"); hit.append(control); hit.addEventListener("click", event => event.stopPropagation()); row.append(hit);
        } else {
          const membership = settingsAction(ctx, "需要 PRO", () => this.open("account")); row.append(membership);
        }
      }
    });
  }
  private review(): MobileShellPage {
    const ctx = this.context, content = settingsContent(ctx), english = this.host.settings().settingsLanguage === "en";
    const group = settingsGroup(ctx, content, english ? "Reports" : "周报");
    settingsRow(ctx, group, english ? "Agent weekly report" : "Agent 周报", "", () => ctx.push(this.reportConfiguration("agent")));
    settingsRow(ctx, group, english ? "Knowledge weekly report" : "知识库周报", "", () => ctx.push(this.reportConfiguration("knowledge")));
    content.append(el(ctx.document, "p", "pd-settings-description", english ? "Mobile saves configuration only; reports are not generated automatically." : "移动端仅保存配置，不会自动生成周报。"));
    return { id: "ipad-settings-review", title: english ? "Review" : "复盘", content };
  }
  private reportConfiguration(kind: "agent" | "knowledge"): MobileShellPage {
    const ctx = this.context, english = this.host.settings().settingsLanguage === "en", content = settingsContent(ctx);
    content.classList.add("pd-settings-report");
    const original = this.host.settings().mobileUi.reports[kind], draft = { period: original.period, schedule: original.schedule }, baseline = JSON.stringify(draft);
    const group = settingsGroup(ctx, content, english ? "Report configuration" : "周报配置"), error = settingsError(ctx), leaveArea = el(ctx.document, "div", ""), footer = el(ctx.document, "div", "pd-settings-actions");
    const periods = [["7d", english ? "Last 7 days" : "最近 7 天"], ["last-week", english ? "Previous week" : "上一周"], ["30d", english ? "Last 30 days" : "最近 30 天"]] as const;
    const schedules = [["manual", english ? "Manual" : "手动"], ["weekly", english ? "Weekly" : "每周"], ["monthly", english ? "Monthly" : "每月"]] as const;
    let busy = false, allowed = false;
    const choice = (label: string, entries: readonly (readonly [string, string])[], value: string, change: (value: string) => void) => {
      const row = settingsRow(ctx, group, label), select = el(ctx.document, "select", "pd-settings-input"); select.setAttribute("aria-label", label);
      for (const [id, name] of entries) { const option = el(ctx.document, "option", "", name); option.value = id; select.append(option); } select.value = value;
      select.addEventListener("change", () => { change(select.value); error.hidden = true; }); row.append(select);
    };
    choice(english ? "Report period" : "统计周期", periods, draft.period, value => { draft.period = value as typeof draft.period; });
    choice(english ? "Frequency" : "执行周期", schedules, draft.schedule, value => { draft.schedule = value as typeof draft.schedule; });
    content.append(error, leaveArea);
    const cancel = settingsAction(ctx, "取消", () => { allowed = true; return ctx.back(); }), save = settingsAction(ctx, "保存", async () => {
      if (busy) return; busy = true; error.hidden = true; update();
      try {
        await this.save(settings => {
          const previous = settings.mobileUi.reports[kind], next = { ...previous, ...draft }; settings.mobileUi.reports[kind] = next;
          return () => { if (settings.mobileUi.reports[kind] === next) settings.mobileUi.reports[kind] = previous; };
        });
        allowed = true; busy = false; await ctx.back();
      } catch (failure) { showSettingsError(error, failure); }
      finally { busy = false; update(); }
    }, true);
    function update(): void { content.querySelectorAll<HTMLSelectElement>("select").forEach(select => { select.disabled = busy; }); cancel.disabled = save.disabled = busy; content.setAttribute("aria-busy", String(busy)); }
    footer.append(cancel, save);
    return { id: `ipad-settings-report-${kind}`, title: kind === "agent" ? english ? "Agent weekly report" : "Agent 周报" : english ? "Knowledge weekly report" : "知识库周报", content, footer,
      canLeave: () => busy ? false : allowed || JSON.stringify(draft) === baseline ? true : leaveSettingsConfirm(ctx, leaveArea) };
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
