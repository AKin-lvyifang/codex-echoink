import license from "../../../LICENSE";
import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md";
import type { AgentModuleId } from "../../agents/types";
import { membershipWebsiteLink } from "../../membership/website-links";
import { getProPluginAccess, hasProPluginAccess, unavailableCapabilityAccess } from "../../membership/access";
import { mobileModuleEnabled, setMobileModuleEnabled } from "../../mobile/module-settings";
import { createStaticSettingsTabIcon } from "../../settings/animated-settings-tab-icon";
import { effectiveEchoInkColorTheme, ECHOINK_APPEARANCE_REFRESH, ECHOINK_COLOR_THEMES, renderCompanionThemeRecommendation } from "../appearance-theme";
import { decorateProAppearanceChoice } from "../appearance-pro";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { MobileShellPage } from "../mobile/shell-types";
import { refreshSettingsLanguage, settingsMessage, settingsText } from "./settings-language";
import { IPhoneModulePage } from "./module-elements";
import { createAgentFormPage } from "./agent-form";
import { IPhoneAccountPages } from "./account-pages";
import { IPhoneAgentSettingsPages } from "./agent-settings-pages";
import { IPhoneCapabilityPages } from "./capability-pages";
import { IPhoneModelPages } from "./model-pages";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { pushSettingsPage, settingsBody, settingsBrand, settingsError, settingsGroup, settingsRow, settingsSelect, settingsSwitch } from "./settings-elements";

export const IPHONE_SETTINGS_CATEGORIES = [
  ["general", "settings", "通用"], ["model", "key-round", "模型"], ["agent", "bot", "Agent"],
  ["caps", "layout-list", "能力"], ["mods", "blocks", "模块"], ["account", "feather", "账号与会员"]
] as const;
type Category = typeof IPHONE_SETTINGS_CATEGORIES[number][0];

/** iPhone settings own their page stack; legacy content is bridged only at explicit leaf entries. */
export class IPhoneSettingsPages {
  readonly models: IPhoneModelPages;
  readonly capabilityPages: IPhoneCapabilityPages;
  readonly agentPages: IPhoneAgentSettingsPages;
  readonly accountPages: IPhoneAccountPages;
  private readonly refreshers = new Set<() => void>();
  constructor(private readonly ctx: IPhonePageContext, private readonly legacy: (route: MobileSettingsRoute) => Promise<void>) {
    this.models = new IPhoneModelPages(ctx, () => this.refresh());
    this.capabilityPages = new IPhoneCapabilityPages(ctx, id => this.agentForm(id));
    this.agentPages = new IPhoneAgentSettingsPages(ctx, id => this.agentForm(id));
    this.accountPages = new IPhoneAccountPages(ctx);
  }
  refresh(): void { for (const render of this.refreshers) render(); refreshSettingsLanguage(this.ctx); this.capabilityPages.refresh(); this.agentPages.refresh(); this.accountPages.refresh(); }
  private tracked(id: string, title: string, render: (body: HTMLElement) => void): MobileShellPage {
    const body = settingsBody(this.ctx), update = () => { body.replaceChildren(); render(body); };
    update(); this.refreshers.add(update);
    return { id, title, content: body, canLeave: () => !body.querySelector('[aria-busy="true"]'), dispose: () => { this.refreshers.delete(update); } };
  }
  async open(category?: Category): Promise<void> {
    const { ctx } = this;
    if (category === "model") return this.models.open();
    if (category === "caps") return this.capabilityPages.open();
    if (category === "agent") return this.agentPages.open();
    if (category === "account") return this.accountPages.open();
    const title = IPHONE_SETTINGS_CATEGORIES.find(item => item[0] === category)?.[2] ?? "设置";
    const id = `iphone-settings-${category ?? "root"}`;
    if (ctx.shell.hasPage(id)) { this.refresh(); await ctx.shell.backTo(id); return; }
    const page = category === "general" ? this.general() : this.tracked(id, title, body => {
      if (!category) {
        const group = settingsGroup(ctx, body), active = ctx.host.settings().apiProviders.find(provider => provider.id === ctx.host.settings().activeApiProviderId), current = active?.models.find(model => model.id === ctx.host.settings().defaultModel);
        for (const [key, icon, name] of IPHONE_SETTINGS_CATEGORIES) {
          const account = ctx.host.accountService?.read();
          const row = settingsRow(ctx, group, name, { icon, value: key === "account" ? account?.identity ? account.membership.planName ?? "免费版" : "未登录" : key === "model" ? current?.displayName || current?.id || "未选择" : undefined, valueLeading: key === "model" && current ? settingsBrand(ctx, active?.providerId) : undefined, literalValue: key === "model" && !!current, action: () => this.open(key) });
          if (icon === "blocks") row.querySelector(".ip-icon")?.replaceChildren(createStaticSettingsTabIcon(ctx.document, "blocks"));
        }
      } else if (category === "mods") this.modules(body);
    });
    await pushSettingsPage(ctx, page);
  }
  private general(): MobileShellPage {
    const { ctx } = this, body = settingsBody(ctx), appearance = settingsGroup(ctx, body, "外观");
    const color = settingsRow(ctx, appearance, "配色"), track = el(ctx.document, "div", "ip-settings-segments"); track.setAttribute("role", "group"); track.setAttribute("aria-label", "配色");
    const slider = el(ctx.document, "span", "ip-settings-segment-slider"); slider.setAttribute("aria-hidden", "true"); track.append(slider); color.append(track);
    const choices = ECHOINK_COLOR_THEMES.map(theme => [theme.id, theme.zh] as const);
    const error = settingsError(ctx, body); let busy = false;
    const hasPro = () => hasProPluginAccess(ctx.host.accountService ?? unavailableCapabilityAccess);
    const locks: (() => void)[] = [];
    track.classList.add("echoink-appearance-pro-surface"); track.dataset.echoinkAppearancePicker = "";
    const colorButtons = choices.map(([value, label]) => {
      const button = el(ctx.document, "button", "ip-settings-segment"); button.append(settingsMessage(ctx, el(ctx.document, "span", "echoink-theme-choice-title"), label)); button.type = "button";
      button.addEventListener("click", () => { if (value !== "minimal" && !hasPro() || effectiveEchoInkColorTheme(ctx.host.settings().colorTheme, ctx.host.accountService) === value) return; void persist("colorTheme", value).then(sync).catch(error.show); }); if (value !== "minimal") locks.push(decorateProAppearanceChoice(button, track, { zh: ctx.host.settings().settingsLanguage !== "en", allowed: hasPro, upgrade: () => { void this.accountPages.open(); } })); track.append(button); return button;
    });
    renderCompanionThemeRecommendation(appearance, ctx.host.settings().settingsLanguage !== "en");
    const language = settingsSelect(ctx, appearance, "界面语言", [["zh-CN", "简体中文"], ["en", "English"]], ctx.host.settings().settingsLanguage, value => {
      if (value !== ctx.host.settings().settingsLanguage) void persist("settingsLanguage", value).catch(error.show);
    });
    const startup = settingsGroup(ctx, body, "启动"), startLabel = el(ctx.document, "label", "ip-settings-row"), start = el(ctx.document, "input", "ip-settings-switch");
    start.type = "checkbox"; start.setAttribute("role", "switch"); start.setAttribute("aria-label", "启动时打开工作台"); start.checked = ctx.host.settings().autoOpenHome === true;
    startLabel.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-label"), "启动时打开工作台"), start); startup.append(startLabel);
    start.addEventListener("change", () => { void persist("autoOpenHome", start.checked).then(sync).catch(error.show); });
    settingsRow(ctx, settingsGroup(ctx, body, "关于"), "EchoInk Agent", { value: ctx.host.version ?? "版本未知", action: () => this.about() });
    const sync = () => {
      const value = effectiveEchoInkColorTheme(ctx.host.settings().colorTheme, ctx.host.accountService); track.dataset.selected = value;
      for (const [index, button] of colorButtons.entries()) { button.setAttribute("aria-pressed", String(choices[index][0] === value)); button.disabled = busy; }
      locks.forEach(update => update());
      language.value = ctx.host.settings().settingsLanguage; language.disabled = busy; language.setAttribute("aria-label", settingsText(ctx, "界面语言"));
      start.checked = ctx.host.settings().autoOpenHome === true; start.disabled = busy;
      ctx.document.body.setAttribute("data-echoink-theme", value);
    };
    const persist = async (key: "colorTheme" | "autoOpenHome" | "settingsLanguage", value: string | boolean) => {
      if (busy) { sync(); return; } busy = true; error.show(); const settings: Record<string, unknown> = ctx.host.settings(), previous = settings[key]; settings[key] = value; sync();
      try { await ctx.host.saveSettings(); this.refresh(); }
      catch (failure) { if (settings[key] === value) settings[key] = previous; throw failure; }
      finally { busy = false; sync(); }
    };
    track.addEventListener(ECHOINK_APPEARANCE_REFRESH, sync); sync(); return { id: "iphone-settings-general", title: "通用", content: body, canLeave: () => !busy };
  }
  private async about(): Promise<void> {
    const { ctx } = this, body = settingsBody(ctx), group = settingsGroup(ctx, body);
    settingsRow(ctx, group, "EchoInk Agent", { value: ctx.host.version ?? "版本未知" });
    const website = settingsMessage(ctx, el(ctx.document, "a", "ip-settings-website"), "官网 echoink.cn") as HTMLAnchorElement; website.href = membershipWebsiteLink("plugin.about"); website.target = "_blank"; website.rel = "noopener noreferrer"; body.append(website);
    for (const [name, text] of [["组件许可", license], ["第三方许可", thirdPartyNotices]]) {
      const detail = el(ctx.document, "details", "ip-settings-license"); detail.append(settingsMessage(ctx, el(ctx.document, "summary", ""), name), el(ctx.document, "pre", "", text)); body.append(detail);
    }
    await pushSettingsPage(ctx, { id: "iphone-settings-about", title: "关于 EchoInk", content: body });
  }
  private async agentForm(agentId?: string): Promise<void> {
    const page = createAgentFormPage(this.ctx, agentId), dispose = page.dispose;
    page.dispose = () => { dispose?.(); this.refresh(); }; await pushSettingsPage(this.ctx, page);
  }
  private async review(): Promise<void> {
    const { ctx } = this, english = ctx.host.settings().settingsLanguage === "en", view = new IPhoneModulePage(ctx, "iphone-settings-review", english ? "Review" : "复盘"), group = view.group(english ? "Reports" : "周报");
    settingsRow(ctx, group, english ? "Agent weekly report" : "Agent 周报", { literal: true, action: () => this.reportConfiguration("agent") });
    settingsRow(ctx, group, english ? "Knowledge weekly report" : "知识库周报", { literal: true, action: () => this.reportConfiguration("knowledge") });
    view.body.append(el(ctx.document, "p", "ip-module-status", english ? "Mobile saves configuration only; reports are not generated automatically." : "移动端仅保存配置，不会自动生成周报。"));
    await view.push();
  }
  private async reportConfiguration(kind: "agent" | "knowledge"): Promise<void> {
    const { ctx } = this, english = ctx.host.settings().settingsLanguage === "en";
    const title = kind === "agent" ? english ? "Agent weekly report" : "Agent 周报" : english ? "Knowledge weekly report" : "知识库周报";
    const view = new IPhoneModulePage(ctx, `iphone-settings-report-${kind}`, title), original = ctx.host.settings().mobileUi.reports[kind], draft = { period: original.period, schedule: original.schedule }, baseline = JSON.stringify(draft), group = view.group(english ? "Report configuration" : "周报配置");
    view.dirty = () => JSON.stringify(draft) !== baseline;
    view.select(group, english ? "Report period" : "统计周期", [["7d", english ? "Last 7 days" : "最近 7 天"], ["last-week", english ? "Previous week" : "上一周"], ["30d", english ? "Last 30 days" : "最近 30 天"]], draft.period, value => { draft.period = value as typeof draft.period; });
    view.select(group, english ? "Frequency" : "执行周期", [["manual", english ? "Manual" : "手动"], ["weekly", english ? "Weekly" : "每周"], ["monthly", english ? "Monthly" : "每月"]], draft.schedule, value => { draft.schedule = value as typeof draft.schedule; });
    view.button(view.footer, "取消", async () => { view.allow(); await ctx.shell.back(); });
    view.button(view.footer, "保存", async () => {
      const saved = await view.run(async () => {
        const settings = ctx.host.settings(), previous = settings.mobileUi.reports[kind], next = { ...previous, ...draft }; settings.mobileUi.reports[kind] = next;
        try { await ctx.host.saveSettings(); }
        catch (failure) { if (settings.mobileUi.reports[kind] === next) settings.mobileUi.reports[kind] = previous; throw failure; }
      });
      if (saved) { view.allow(); await ctx.shell.back(); }
    }, true); await view.push();
  }
  private modules(body: HTMLElement): void {
    const { ctx } = this, base = settingsGroup(ctx, body, "基础模块"), pro = settingsGroup(ctx, body, "PRO 模块"), settings = ctx.host.settings();
    const entries: { id: AgentModuleId; name: string; icon: string; pro?: boolean; route?: MobileSettingsRoute; value?: string }[] = [
      { id: "knowledge-base", name: "知识库", icon: "library", route: "knowledge" },
      { id: "journal", name: "日记", icon: "book-open", value: settings.journalDirectory },
      { id: "review", name: "复盘", icon: "history", route: "review" },
      { id: "todos", name: "待办", icon: "list-todo", route: "todos-settings" },
      { id: "finance", name: "财务", icon: "wallet", pro: true, route: "finance-settings" },
      { id: "english-diary", name: "英文日记", icon: "languages", pro: true, route: "english-diary-settings", value: settings.englishDiary.englishDirectory }
    ];
    for (const entry of entries) {
      const group = entry.pro ? pro : base, row = settingsRow(ctx, group, entry.name, { icon: entry.icon, value: entry.value, literalValue: true });
      row.classList.add("ip-settings-module-row");
      const enabled = () => mobileModuleEnabled(ctx.host.settings(), entry.id), policy = entry.pro ? getProPluginAccess(ctx.host.accountService ?? unavailableCapabilityAccess, enabled()) : undefined;
      const label = row.querySelector<HTMLElement>(".ip-settings-label")!, button = el(ctx.document, "button", "ip-settings-module-link"); button.type = "button";
      const value = row.querySelector<HTMLElement>(".ip-settings-value");
      const icon = row.querySelector<HTMLElement>(".ip-icon"); if (icon) button.append(icon); button.append(label); if (value) button.append(value); button.append(iphoneIcon(ctx.document, "chevron-right")); row.prepend(button);
      if (policy && !policy.canToggle) label.append(el(ctx.document, "span", "ip-settings-detail", policy.reason ?? "需要 PRO"));
      button.addEventListener("click", () => { void Promise.resolve().then(async () => {
        const current = entry.pro ? getProPluginAccess(ctx.host.accountService ?? unavailableCapabilityAccess, enabled()) : undefined;
        if (current && !current.canToggle) throw new Error(current.reason ?? "需要 PRO");
        if (entry.id === "journal") {
          const view = new IPhoneModulePage(ctx, "iphone-settings-journal", "日记设置"); settingsRow(ctx, view.group(), "日记位置", { value: ctx.host.settings().journalDirectory, literalValue: true, action: async () => { ctx.host.services.modules.journal.openSettings(); } }); await view.push();
        } else if (entry.id === "review") await this.review();
        else if (entry.route) await this.legacy(entry.route);
      }).catch(ctx.error); });
      if (policy && !policy.canToggle) {
        const rights = el(ctx.document, "button", "ip-settings-module-rights"); rights.type = "button"; settingsMessage(ctx, rights, "需要 PRO"); rights.addEventListener("click", () => { void this.legacy("account").catch(ctx.error); }); row.append(rights);
      } else settingsSwitch(ctx, group, entry.id === "finance" ? "财务" : entry.name, enabled, value => setMobileModuleEnabled(ctx.host, entry.id, value), undefined, row);
    }
  }
}
