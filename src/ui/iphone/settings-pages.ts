import license from "../../../LICENSE";
import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md";
import type { AgentModuleId } from "../../agents/types";
import { membershipWebsiteLink } from "../../membership/website-links";
import { getProPluginAccess, unavailableCapabilityAccess } from "../../membership/access";
import { mobileModuleEnabled, setMobileModuleEnabled } from "../../mobile/module-settings";
import { normalizeEchoInkColorTheme } from "../appearance-theme";
import type { MobileSettingsRoute } from "../mobile/settings-pages";
import type { MobileShellPage } from "../mobile/shell-types";
import { refreshSettingsLanguage, settingsMessage } from "./settings-language";
import { createAgentFormPage } from "./agent-form";
import { IPhoneAgentSettingsPages } from "./agent-settings-pages";
import { IPhoneCapabilityPages } from "./capability-pages";
import { IPhoneModelPages } from "./model-pages";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { pushSettingsPage, settingsBody, settingsBrand, settingsError, settingsGroup, settingsRow, settingsSwitch } from "./settings-elements";

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
  private readonly refreshers = new Set<() => void>();
  constructor(private readonly ctx: IPhonePageContext, private readonly legacy: (route: MobileSettingsRoute) => Promise<void>) {
    this.models = new IPhoneModelPages(ctx, () => this.refresh());
    this.capabilityPages = new IPhoneCapabilityPages(ctx, id => this.agentForm(id));
    this.agentPages = new IPhoneAgentSettingsPages(ctx, id => this.agentForm(id));
  }
  refresh(): void { for (const render of this.refreshers) render(); refreshSettingsLanguage(this.ctx); this.capabilityPages.refresh(); this.agentPages.refresh(); }
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
    if (category === "account") return this.legacy("account");
    const title = IPHONE_SETTINGS_CATEGORIES.find(item => item[0] === category)?.[2] ?? "设置";
    const id = `iphone-settings-${category ?? "root"}`;
    if (ctx.shell.hasPage(id)) { this.refresh(); await ctx.shell.backTo(id); return; }
    const page = category === "general" ? this.general() : this.tracked(id, title, body => {
      if (!category) {
        const group = settingsGroup(ctx, body), active = ctx.host.settings().apiProviders.find(provider => provider.id === ctx.host.settings().activeApiProviderId), current = active?.models.find(model => model.id === ctx.host.settings().defaultModel);
        for (const [key, icon, name] of IPHONE_SETTINGS_CATEGORIES) {
          const account = ctx.host.accountService?.read();
          settingsRow(ctx, group, name, { icon, value: key === "account" ? account?.identity ? account.membership.planName ?? "免费版" : "未登录" : key === "model" ? current?.displayName || current?.id || "未选择" : undefined, valueLeading: key === "model" && current ? settingsBrand(ctx, active?.providerId) : undefined, literalValue: key === "model" && !!current, action: () => this.open(key) });
        }
      } else if (category === "mods") this.modules(body);
    });
    await pushSettingsPage(ctx, page);
  }
  private general(): MobileShellPage {
    const { ctx } = this, body = settingsBody(ctx), appearance = settingsGroup(ctx, body, "外观");
    const color = settingsRow(ctx, appearance, "配色"), track = el(ctx.document, "div", "ip-settings-segments"); track.setAttribute("role", "group"); track.setAttribute("aria-label", "配色");
    const slider = el(ctx.document, "span", "ip-settings-segment-slider"); slider.setAttribute("aria-hidden", "true"); track.append(slider); color.append(track);
    const choices: ["green" | "violet", string][] = [["green", "暖白翠绿"], ["violet", "雾紫石墨"]];
    const error = settingsError(ctx, body); let busy = false;
    const colorButtons = choices.map(([value, label]) => {
      const button = el(ctx.document, "button", "ip-settings-segment"); settingsMessage(ctx, button, label); button.type = "button";
      button.addEventListener("click", () => { void persist("colorTheme", value).then(sync).catch(error.show); }); track.append(button); return button;
    });
    const language = settingsRow(ctx, appearance, "界面语言", { value: ctx.host.settings().settingsLanguage === "en" ? "English" : "简体中文", action: () => this.language(() => { settingsMessage(ctx, language.querySelector<HTMLElement>(".ip-settings-value")!, ctx.host.settings().settingsLanguage === "en" ? "English" : "简体中文"); }) });
    const startup = settingsGroup(ctx, body, "启动"), startLabel = el(ctx.document, "label", "ip-settings-row"), start = el(ctx.document, "input", "ip-settings-switch");
    start.type = "checkbox"; start.setAttribute("role", "switch"); start.setAttribute("aria-label", "启动时打开工作台"); start.checked = ctx.host.settings().autoOpenHome === true;
    startLabel.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-label"), "启动时打开工作台"), start); startup.append(startLabel);
    start.addEventListener("change", () => { void persist("autoOpenHome", start.checked).then(sync).catch(error.show); });
    settingsRow(ctx, settingsGroup(ctx, body, "关于"), "EchoInk Agent", { value: ctx.host.version ?? "版本未知", action: () => this.about() });
    const sync = () => {
      const value = normalizeEchoInkColorTheme(ctx.host.settings().colorTheme); track.dataset.selected = value;
      for (const [index, button] of colorButtons.entries()) { button.setAttribute("aria-pressed", String(choices[index][0] === value)); button.disabled = busy; }
      start.checked = ctx.host.settings().autoOpenHome === true; start.disabled = busy;
      ctx.document.body.setAttribute("data-echoink-theme", value);
    };
    const persist = async (key: "colorTheme" | "autoOpenHome", value: string | boolean) => {
      if (busy) { sync(); return; } busy = true; error.show(); const settings: Record<string, unknown> = ctx.host.settings(), previous = settings[key]; settings[key] = value; sync();
      try { await ctx.host.saveSettings(); this.refresh(); }
      catch (failure) { if (settings[key] === value) settings[key] = previous; throw failure; }
      finally { busy = false; sync(); }
    };
    sync(); return { id: "iphone-settings-general", title: "通用", content: body, canLeave: () => !busy };
  }
  private async language(changed: () => void): Promise<void> {
    const { ctx } = this, body = settingsBody(ctx), group = settingsGroup(ctx, body), error = settingsError(ctx, body); let busy = false;
    const buttons: HTMLElement[] = [];
    const render = () => { for (const [index, button] of buttons.entries()) { const selected = ctx.host.settings().settingsLanguage === (index === 0 ? "zh-CN" : "en"); button.setAttribute("aria-pressed", String(selected)); button.classList.toggle("is-selected", selected); button.querySelector(".ip-icon")?.remove(); if (selected) button.append(iphoneIcon(ctx.document, "check")); (button as HTMLButtonElement).disabled = busy; } };
    for (const [value, label] of [["zh-CN", "简体中文"], ["en", "English"]] as const) {
      buttons.push(settingsRow(ctx, group, label, { selected: ctx.host.settings().settingsLanguage === value, action: async () => {
        if (busy) return; busy = true; error.show(); const settings = ctx.host.settings(), previous = settings.settingsLanguage; settings.settingsLanguage = value; render();
        try { await ctx.host.saveSettings(); changed(); this.refresh(); }
        catch (failure) { if (settings.settingsLanguage === value) settings.settingsLanguage = previous; error.show(failure); }
        finally { busy = false; render(); }
      } }));
    }
    await pushSettingsPage(ctx, { id: "iphone-settings-language", title: "界面语言", content: body, canLeave: () => !busy });
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
  private modules(body: HTMLElement): void {
    const { ctx } = this, base = settingsGroup(ctx, body, "基础模块"), pro = settingsGroup(ctx, body, "PRO 模块"), settings = ctx.host.settings();
    const entries: { id: AgentModuleId; name: string; icon: string; pro?: boolean; route?: MobileSettingsRoute; value?: string }[] = [
      { id: "knowledge-base", name: "知识库", icon: "library", route: "knowledge" },
      { id: "journal", name: "日记", icon: "book-open", value: settings.journalDirectory },
      { id: "review", name: "复盘", icon: "history", route: "review" },
      { id: "todos", name: "待办", icon: "list-todo", route: "todos-settings" },
      { id: "finance", name: "财务", icon: "wallet", route: "finance-settings", pro: true },
      { id: "english-diary", name: "英文日记", icon: "languages", pro: true, value: settings.englishDiary.englishDirectory }
    ];
    for (const entry of entries) {
      const group = entry.pro ? pro : base, row = settingsRow(ctx, group, entry.name, { icon: entry.icon, value: entry.value, literalValue: true });
      row.classList.add("ip-settings-module-row");
      const enabled = () => mobileModuleEnabled(ctx.host.settings(), entry.id), policy = entry.pro ? getProPluginAccess(ctx.host.accountService ?? unavailableCapabilityAccess, enabled()) : undefined;
      if (entry.route && (!policy || policy.canEnter)) {
        const label = row.querySelector<HTMLElement>(".ip-settings-label")!, button = el(ctx.document, "button", "ip-settings-module-link"); button.type = "button";
        button.append(...Array.from(label.childNodes)); label.replaceWith(button); button.addEventListener("click", () => { void this.legacy(entry.route!).catch(ctx.error); });
      }
      if (policy && !policy.canToggle) {
        const rights = el(ctx.document, "button", "ip-settings-module-rights"); rights.type = "button"; settingsMessage(ctx, rights, "需要 PRO"); rights.addEventListener("click", () => { void this.legacy("account").catch(ctx.error); }); row.append(rights);
      } else settingsSwitch(ctx, group, entry.name, enabled, value => setMobileModuleEnabled(ctx.host, entry.id, value), undefined, row);
    }
  }
}
