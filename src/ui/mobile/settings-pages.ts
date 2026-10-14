import { defaultAgentIdentityState } from "../../harness/memory/agent-identity-model";
import { AgentIdentityModal } from "../agent-identity-modal";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { AGENT_TEMPLATES, getAgentTemplate, type AgentTemplateId } from "../../harness/memory/agent-templates";
import type { MobileAgentProfile } from "../../harness/memory/mobile-profile-protocol";
import { TFile, TFolder, setIcon } from "obsidian";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeDirectory } from "../../knowledge-base/folder-bindings";
import type { MobileUIHost } from "./mobile-ui";
import { newId } from "../../core/new-id";
import { EchoInkTodoFormModal } from "../../home/todo-edit-modal";
import { TODO_SOURCE_PATH } from "../../home/todo-store";
import type { ParsedTodoRecord } from "../../home/todo-markdown";
import type { MobileServices } from "../../mobile/services";
import { SETTINGS_TAB_ICONS } from "../../settings/settings-tab-icons";
import type { AnimatedSettingsTabIconName } from "../../settings/animated-settings-tab-icon";
import { mountAccountMembership } from "../../settings/account-membership";
import { MOBILE_ACTIVATION_NOTICE } from "../../membership/mobile-storage";
import { membershipWebsiteLink } from "../../membership/website-links";
import license from "../../../LICENSE";
import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md";
import { FinanceCatalogPanel, type CatalogKind } from "../../lifestyle/finance-catalog-dialog";

type MobileFinanceCatalogPage = "finance-merchants" | "finance-accounts" | "finance-categories";
const financeCatalogKinds: Record<MobileFinanceCatalogPage, CatalogKind> = { "finance-merchants": "merchants", "finance-accounts": "accounts", "finance-categories": "categories" };
export type MobileSettingsPage = "basic" | "layout" | "resources" | "knowledge" | "review" | "todos-settings" | "todos" | "profile-agent" | "profile-user" | "archives" | "account" | "finance-settings" | MobileFinanceCatalogPage;
export type MobileSettingsRoute = MobileSettingsPage | "settings" | "providers";
interface Controls {
  go(page: MobileSettingsPage | "memories" | "providers" | "chat"): void;
  back(): void;
  captureScroll(key?: string): void;
  restoreScroll(key?: string): void;
  updateHeader(): void;
  sheet(title: string, render: (body: HTMLElement) => void): void;
  closeSheet(): void;
  row(parent: HTMLElement, title: string, description: string, icon: string, action: () => void | Promise<void>): HTMLButtonElement;
  button(parent: HTMLElement, title: string, action: () => void | Promise<void>, icon?: string, cls?: string): HTMLButtonElement;
  field(parent: HTMLElement, title: string, value: string, update: (value: string) => void, type?: string): HTMLInputElement;
  act(action: () => void | Promise<void>): Promise<void>;
}
function node<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag); element.className = cls; if (text !== undefined) element.textContent = text; parent.append(element); return element;
}
export class MobileSettingsPages {
  readonly categories: { page: MobileSettingsPage | "providers"; title: string; icon: AnimatedSettingsTabIconName }[] = [
    { page: "basic", title: "基础设置", icon: SETTINGS_TAB_ICONS.general },
    { page: "layout", title: "布局与外观", icon: SETTINGS_TAB_ICONS.layout },
    { page: "providers", title: "API Provider", icon: SETTINGS_TAB_ICONS.providers },
    { page: "resources", title: "Skills & MCP", icon: SETTINGS_TAB_ICONS.resources },
    { page: "knowledge", title: "知识库管理", icon: SETTINGS_TAB_ICONS.knowledgeBase },
    { page: "review", title: "复盘", icon: SETTINGS_TAB_ICONS.review },
    { page: "todos-settings", title: "待办", icon: SETTINGS_TAB_ICONS.todos },
    { page: "account", title: "账号与会员", icon: SETTINGS_TAB_ICONS.account }
  ];
  readonly titles: Record<MobileSettingsPage, string> = { basic: "基础设置", layout: "布局与外观", resources: "Skills & MCP", knowledge: "知识库管理", review: "复盘", "todos-settings": "待办设置", todos: "待办", "profile-agent": "Agent 档案", "profile-user": "用户画像", archives: "已归档会话", account: "账号与会员", "finance-settings": "财务设置", "finance-merchants": "管理商户", "finance-accounts": "管理账户", "finance-categories": "管理分类" };
  private knowledgeMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private resourceTab = "plugins";
  private todoStatus = "open";
  private todoCategory = "";
  private todoDate = "all";
  private profileScroll = new Map<string, number>();
  private identityLink?: HTMLButtonElement;
  private agentArticle?: HTMLElement;
  private unsubscribe?: () => void;
  constructor(private host: MobileUIHost, private ui: Controls) {}
  private accountPage?: { dispose(): void };
  private financeCatalog?: FinanceCatalogPanel;
  dispose() { this.identityLink = undefined; this.agentArticle = undefined; this.unsubscribe?.(); this.unsubscribe = undefined; this.accountPage?.dispose(); this.accountPage = undefined; this.financeCatalog?.dispose(); this.financeCatalog = undefined; }
  categoryPage(page: string) { return page === "finance-settings" || Object.hasOwn(financeCatalogKinds, page) ? "resources" : page; }
  navigationKey() { return this.financeCatalog?.navigationKey(); }
  navigationTitle() { return this.financeCatalog?.title(); }
  backLabel() { return this.financeCatalog?.backLabel(); }
  back(): boolean { if (!this.financeCatalog) return false; this.financeCatalog.back(); return true; }
  refreshIdentity() { if (this.identityLink?.isConnected) this.fillIdentityLink(this.identityLink); if (this.agentArticle?.isConnected) void this.loadAgentProfile(this.agentArticle); }
  private avatar(parent: HTMLElement, profile: MobileAgentProfile["identity"], cls: string) {
    const box = node(parent, "span", cls); box.setAttribute("aria-hidden", "true");
    const url = resolveAgentAvatarUrl(profile.avatar);
    if (url) { const image = node(box, "img"); image.src = url; image.alt = ""; image.addEventListener("error", () => { image.remove(); setIcon(box, "bot"); }, { once: true }); }
    else setIcon(box, "bot");
    return box;
  }
  private fillIdentityLink(link: HTMLButtonElement) {
    const identity = this.host.services?.agentIdentity ?? defaultAgentIdentityState();
    link.querySelector(".em-avatar")?.remove(); link.prepend(this.avatar(link, identity, "em-avatar"));
    link.querySelector(".em-row-label strong")!.textContent = identity.displayName;
  }
  private get services(): MobileServices { if (!this.host.services) throw new Error("当前预览尚未提供 Vault 服务。"); return this.host.services; }
  private help(parent: HTMLElement, text: string) { return node(parent, "p", "em-help", text); }
  private heading(parent: HTMLElement, title: string) { return node(parent, "h3", "em-section-title", title); }
  group(parent: HTMLElement) { return node(parent, "section", "em-setting-group"); }
  private toggle(parent: HTMLElement, title: string, checked: boolean, update: (checked: boolean) => Promise<void>) {
    const label = node(parent, "label", "em-row"); const text = node(label, "span", "em-row-label"); node(text, "strong", "", title);
    const input = node(label, "input", "em-switch"); input.type = "checkbox"; input.checked = checked; input.setAttribute("role", "switch"); input.setAttribute("aria-label", title);
    input.addEventListener("change", () => { void this.ui.act(() => update(input.checked)); }); return input;
  }
  basicEntries(body: HTMLElement, memory: HTMLElement) {
    this.ui.row(memory, "离线记忆整理（做梦）", "", "moon", () => this.ui.sheet("做梦与成长", part => {
      this.help(part, "移动端尚未接通记忆整理引擎。已有记忆可查看、修正与忘记；配置与资料已保留。");
      this.ui.button(part, "查看记忆", () => this.ui.go("memories"), "brain", "em-wide-action");
    }));
    this.heading(body, "身份与用户画像");
    const identity = this.group(body);
    const profile = this.ui.row(identity, (this.host.services?.agentIdentity ?? defaultAgentIdentityState()).displayName, "EchoInk Agent", "user", () => this.ui.go("profile-agent")); profile.classList.add("em-profile-link");
    this.identityLink = profile; profile.querySelector(".em-icon")?.remove(); this.fillIdentityLink(profile);
    this.ui.row(identity, "用户画像", "", "file-text", () => this.ui.go("profile-user"));
  }
  basicGeneral(body: HTMLElement) {
    this.heading(body, "通用");
    const general = this.group(body);
    const language = node(general, "div", "em-row"); node(language, "strong", "em-row-label", "设置语言"); node(language, "span", "em-row-value", "简体中文");
    this.ui.row(general, "关于 EchoInk", "", "circle-help", () => this.ui.sheet("关于 EchoInk", part => {
      node(part, "h2", "em-about-title", "EchoInk"); this.help(part, `版本 ${this.host.version ?? "本地测试包"}`);
      this.help(part, "你的思考，在这里积累。");
      this.help(part, "作者：AKin-lvyifang · Copyright © 2026 EchoInk Agent contributors");
      const website = node(part, "a", "em-wide-action", "官网 echoink.cn"); website.href = membershipWebsiteLink("plugin.about"); website.target = "_blank"; website.rel = "noopener noreferrer";
      this.help(part, "基础部分采用 MIT 许可；PRO 功能遵循单独许可，需有效授权。模型与账号操作会按所选服务发送请求。");
      for (const [title, content] of [["组件许可", license], ["第三方许可", thirdPartyNotices]]) {
        const details = node(part, "details", "em-about-license"); node(details, "summary", "", title); node(details, "pre", "em-license", content);
      }
    }));
  }
  render(page: MobileSettingsPage, body: HTMLElement) {
    body.classList.add("em-settings-page");
    switch (page) {
      case "finance-settings": this.financeSettings(body); break;
      case "finance-merchants": case "finance-accounts": case "finance-categories": this.financeCatalogPage(body, financeCatalogKinds[page]); break;
      case "account": {
        const account = this.host.accountService;
        if (!account) { this.help(body, "账号服务尚未初始化，请稍后重试。"); break; }
        this.accountPage = mountAccountMembership(body, { app: this.host.app, viewModel: account.read(), actions: account.actions, read: () => account.read(), subscribe: listener => account.subscribe(listener), language: "zh-CN", openProviders: () => this.ui.go("providers"), activationNotice: MOBILE_ACTIVATION_NOTICE });
        break;
      }
      case "layout": this.layout(body); break;
      case "resources": this.resources(body); break;
      case "knowledge": this.knowledge(body); break;
      case "review": this.review(body); break;
      case "todos-settings": this.todoSettings(body); break;
      case "todos": this.todos(body); break;
      case "profile-agent": case "profile-user": this.profile(body, page === "profile-agent" ? "agent" : "user"); break;
      case "archives": this.archives(body); break;
    }
  }
  private layout(body: HTMLElement) {
    this.heading(body, "显示"); const group = this.group(body); const settings = this.host.settings();
    const names = { system: "跟随 Obsidian", light: "浅色", dark: "深色" };
    this.ui.row(group, "外观", names[settings.mobileUi.appearance], "sun", () => this.ui.sheet("外观", part => {
      const choices = this.group(part);
      for (const id of ["system", "light", "dark"] as const) {
        const row = this.ui.row(choices, names[id], "", settings.mobileUi.appearance === id ? "check" : "sun", async () => { settings.mobileUi.appearance = id; await this.host.saveSettings(); this.ui.go("layout"); });
        row.setAttribute("aria-pressed", String(settings.mobileUi.appearance === id));
      }
    }));
    this.toggle(group, "放大正文", settings.mobileUi.largeText, async value => { settings.mobileUi.largeText = value; await this.host.saveSettings(); this.host.applyAppearance?.(); });
  }
  private resources(body: HTMLElement) {
    const tabs = node(body, "div", "em-tabs em-segments"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "资源类型");
    const panel = node(body, "section"); panel.setAttribute("role", "tabpanel");
    const render = () => {
      panel.replaceChildren();
      tabs.querySelectorAll("button").forEach(button => button.setAttribute("aria-selected", String(button.dataset.tab === this.resourceTab)));
      if (this.resourceTab === "plugins") {
        const plugins = this.services.plugins();
        if (!plugins.length) node(panel, "p", "em-empty", "暂无插件");
        const group = plugins.length ? this.group(panel) : panel;
        for (const plugin of plugins) this.ui.row(group, plugin.name, `${plugin.enabled ? "已启用" : "未启用"} · ${plugin.description}`, "puzzle", () => plugin.id === "echoink:finance" ? this.ui.go("finance-settings") : this.ui.sheet(plugin.name, part => {
          this.help(part, plugin.description); this.help(part, plugin.mobileStatus);
          this.help(part, plugin.enabled ? "已保留启用状态与配置。" : "当前未启用；启用与授权由桌面已有设置管理。");
        }));
      } else if (this.resourceTab === "mcp") {
        this.ui.button(panel, "添加 MCP 服务", () => this.mcpEditor(), "plus", "em-wide-action");
        const records = this.host.settings().resources.mcpConnections;
        const group = this.group(panel);
        if (!Object.keys(records).length) node(group, "p", "em-empty", "暂无 MCP 服务");
        for (const [id, record] of Object.entries(records)) {
          const resource = this.host.settings().resources.catalog.find(item => item.id === id);
          this.ui.row(group, resource?.name ?? id, record.transport === "stdio" ? "移动端无法启动本地进程" : "未连接 · 移动远程调用尚未接通", "server", () => this.mcpEditor(id));
        }
      } else {
        const skills = this.services.skills(); const group = skills.length ? this.group(panel) : panel;
        for (const skill of skills) this.ui.row(group, skill.name, skill.enabled ? skill.description : "已停用", "sparkles", () => this.ui.sheet(skill.name, part => {
          this.help(part, skill.description);
          this.toggle(this.group(part), "启用 Skill", skill.enabled, async enabled => {
            const settings = this.host.settings(); const saved = settings.resources.catalog.find(item => item.id === skill.id);
            if (saved) saved.enabled = enabled; else { settings.resources.legacyEnabledOverrides ??= {}; settings.resources.legacyEnabledOverrides[skill.id] = enabled; }
            await this.host.saveSettings(); skill.enabled = enabled;
          });
          this.ui.button(part, "查看 Skill", async () => { const content = await this.services.requireAvailableEchoInkSkill(skill.id); const article = node(part, "article", "em-memory-content markdown-rendered"); this.host.renderMarkdown(content, article); }, "file-text", "em-wide-action");
          this.ui.button(part, "在对话中使用", async () => {
            if (this.host.runtime.busy) throw new Error("请先停止当前回答。");
            await this.services.requireAvailableEchoInkSkill(skill.id); this.host.store.session.skillId = skill.id; await this.host.store.save(); this.ui.go("chat");
          }, "message-circle", "em-primary em-wide-action");
        }));
      }
    };
    for (const [id, title] of [["plugins", "插件"], ["mcp", "MCP"], ["skills", "Skills"]]) {
      const button = this.ui.button(tabs, title, () => { this.resourceTab = id; render(); }); button.dataset.tab = id; button.setAttribute("role", "tab");
    }
    render();
  }
  private financeSettings(body: HTMLElement) {
    const lifestyle = this.services.lifestyle;
    if (!lifestyle) { this.help(body, "财务服务尚未初始化，请稍后重试。"); return; }
    const settings = this.host.settings();
    const page = node(body, "div", "echoink-settings-demo echoink-lifestyle-view echoink-life-finance echoink-mobile-finance-settings");
    const group = this.group(page);
    const toggle = (title: string, value: () => boolean, save: (enabled: boolean) => Promise<void>) => {
      const input = this.toggle(group, title, value(), async enabled => { try { await save(enabled); } catch (error) { input.checked = value(); throw error; } });
      return input;
    };
    toggle("启用财务", () => settings.lifestyle.finance.enabled, enabled => lifestyle.setEnabled("finance", enabled));
    this.ui.button(group, "打开财务工作区", () => lifestyle.open("finance"), "wallet", "em-wide-action");
    toggle("AI 分析", () => settings.lifestyle.finance.aiEnabled, enabled => lifestyle.finance.saveOption("aiEnabled", enabled));
    toggle("导入时智能整理", () => settings.lifestyle.finance.importAiEnabled, enabled => lifestyle.finance.saveOption("importAiEnabled", enabled));
    toggle("在首页显示", () => settings.homeModules.finance !== false, enabled => lifestyle.finance.saveOption("showOnHome", enabled));
    this.help(group, "未配置模型时仍可记账、预算和导入。AI 分析与智能整理使用当前 EchoInk 模型。");
    const catalog = node(page, "div", "echoink-life-settings-page");
    const menu = this.group(catalog);
    for (const page of Object.keys(financeCatalogKinds) as MobileFinanceCatalogPage[]) this.ui.row(menu, this.titles[page], "", "list", () => this.ui.go(page));
  }
  private financeCatalogPage(body: HTMLElement, kind: CatalogKind) {
    if (!this.services.lifestyle) { this.help(body, "财务服务尚未初始化，请稍后重试。"); return; }
    const page = node(body, "div", "echoink-settings-demo echoink-lifestyle-view echoink-life-finance echoink-mobile-finance-settings");
    const content = node(page, "div", "echoink-life-settings-page");
    let renderedKey: string | undefined;
    const draw = () => {
      if (this.financeCatalog !== catalog || !body.isConnected) return;
      if (renderedKey) this.ui.captureScroll(renderedKey);
      content.replaceChildren();
      catalog.render(content);
      renderedKey = catalog.navigationKey();
      this.ui.updateHeader();
      this.ui.restoreScroll(renderedKey);
    };
    const catalog = new FinanceCatalogPanel(this.services, kind, () => {
      catalog.dispose(); this.financeCatalog = undefined; this.ui.back();
    }, draw);
    this.financeCatalog = catalog;
    draw();
  }
  private mcpEditor(id?: string) {
    const settings = this.host.settings(); const record = id ? settings.resources.mcpConnections[id] : undefined;
    this.ui.sheet(id ? "MCP 服务" : "添加 MCP 服务", body => {
      if (record?.transport === "stdio") { this.help(body, `移动端不能启动 stdio 本地进程：${record.command}。配置保留，需在桌面端运行。`); return; }
      let name = id ? settings.resources.catalog.find(item => item.id === id)?.name ?? id : ""; let url = record?.url ?? "";
      this.ui.field(body, "名称", name, value => { name = value; }); this.ui.field(body, "服务地址", url, value => { url = value; }, "url");
      this.help(body, "未连接。移动端远程 MCP 调用尚未接通；保存只保存配置。");
      this.ui.button(body, "保存", async () => {
        if (!name.trim()) throw new Error("请填写服务名称。"); let parsed: URL; try { parsed = new URL(url.trim()); } catch { throw new Error("请填写有效的 HTTP 或 HTTPS 地址。"); }
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("请填写有效的 HTTP 或 HTTPS 地址。");
        const key = id ?? newId("mcp");
        settings.resources.mcpConnections[key] = { ...record, transport: "http", url: parsed.href, trusted: record?.trusted ?? false, toolPolicies: record?.toolPolicies ?? {}, tools: record?.tools ?? [] };
        const entry = settings.resources.catalog.find(item => item.id === key);
        if (entry) entry.name = name.trim(); else settings.resources.catalog.push({ id: key, kind: "mcp-server", source: "manual", name: name.trim(), description: "", enabled: true, bridgeMode: "native-mcp" });
        await this.host.saveSettings(); this.ui.go("resources");
      }, "check", "em-primary em-wide-action");
      if (id) this.ui.button(body, "删除配置", async () => { delete settings.resources.mcpConnections[id]; settings.resources.catalog = settings.resources.catalog.filter(item => item.id !== id); await this.host.saveSettings(); this.ui.go("resources"); }, "trash-2", "em-danger em-wide-action");
    });
  }
  private knowledge(body: HTMLElement) {
    body.classList.add("kb-mobile");
    const today = new Date(); const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const files = { wiki: this.services.knowledgeFiles("wiki"), raw: this.services.knowledgeFiles("raw"), inbox: this.services.knowledgeFiles("inbox") };
    const added = (list: TFile[]) => list.filter(file => dayKey(new Date(file.stat.ctime)) === dayKey(today)).length;
    const checks = this.host.settings().knowledgeBase.healthHistory;
    const logs = this.host.settings().knowledgeBase.maintenanceHistory;
    const section = (title: string, detail = "") => {
      const part = node(body, "section", "kb-section"); const heading = node(part, "div", "kb-section-heading"); node(heading, "h3", "", title); if (detail) node(heading, "span", "", detail); return part;
    };
    const list = (kind: "wiki" | "raw" | "inbox") => this.ui.sheet(kind === "wiki" ? "Wiki" : kind === "raw" ? "Raw" : "Inbox", part => {
      if (!files[kind].length) node(part, "p", "em-empty", "没有笔记");
      for (const file of files[kind]) this.ui.row(part, file.basename, file.path, "file-text", () => this.host.openNote(file.path));
    });
    const title = node(body, "div", "kb-title-row"); node(title, "span", "em-help", `更新于 ${today.toLocaleTimeString()}`); this.ui.button(title, "", () => this.ui.go("knowledge"), "refresh-cw", "kb-icon-button").setAttribute("aria-label", "刷新状态");
    const latestCheck = checks.filter(check => check.status === "success" && Number.isFinite(check.at)).sort((a, b) => b.at - a.at)[0];
    const latestMaintenance = logs.filter(log => Number.isFinite(log.at)).sort((a, b) => b.at - a.at)[0];
    const health = node(body, "section", "kb-health");
    const overview = node(health, "div", "kb-health-overview");
    const healthCard = node(overview, "article", "kb-health-card");
    const label = node(healthCard, "div", "kb-card-label"); node(label, "h3", "", "结构健康度"); node(label, "span", "kb-status-neutral", "尚未接通");
    const score = node(healthCard, "div", "kb-health-score"); node(score, "strong", "", "—"); node(score, "small", "", "/ 100");
    this.ui.button(score, "评分说明", () => this.ui.sheet("评分与检查范围", part => this.help(part, "移动端尚未接通结构健康扫描。目录、笔记数量与已有记录来自当前笔记库；评分、Tracker 与来源状态尚未检查。")), "info", "kb-health-open");
    node(healthCard, "p", "", "接通本地结构扫描后显示评分；当前未评估知识库健康。" );
    const freshness = node(overview, "article", "kb-freshness-card");
    const freshLabel = node(freshness, "div", "kb-card-label"); node(freshLabel, "h3", "", "体检新鲜度"); node(freshLabel, "span", "kb-status-neutral", latestCheck ? "已有记录" : "待确认");
    const freshTitle = node(freshness, "div", "kb-freshness-title"); const calendarIcon = node(freshTitle, "span"); setIcon(calendarIcon, "calendar-days");
    node(freshTitle, "strong", "", latestCheck?.date ?? "暂无成功体检记录");
    node(freshness, "p", "", latestCheck ? "仅以成功的体检记录计算，失败和普通维护不会刷新确认时间。" : "这代表缺少确认，不代表知识库已经损坏。");
    this.ui.button(freshness, "维护成功不等于完成全库体检。", () => this.ui.sheet("体检新鲜度", part => this.help(part, "新鲜度取已有成功体检的最近时间，普通维护与失败体检不会刷新它。")), "circle-help", "kb-freshness-note");
    const facts = node(health, "dl", "kb-health-facts");
    for (const [label, value] of [["最近成功体检", latestCheck?.date ?? "—"], ["连续体检", "—"], ["最近维护", latestMaintenance?.date ?? "—"], ["Tracker", "尚未检查"]]) { const row = node(facts, "div"); node(row, "dt", "", label); node(row, "dd", "", value); }
    const counts = node(health, "div", "kb-counts");
    for (const [kind, label] of [["wiki", "Wiki"], ["raw", "Raw"], ["inbox", "Inbox"]] as const) { const card = node(counts, "div"); this.ui.button(card, label, () => list(kind)); node(card, "strong", "", String(files[kind].length)); node(card, "small", "", `今日 +${added(files[kind])}`); }
    const structure = section("Wiki 结构", `${files.wiki.length} 篇内容`);
    const columns = node(structure, "div", "kb-wiki-columns"); for (const label of ["分类", "数量 / 占比", "今日"]) node(columns, "span", "", label);
    const groups = new Map<string, TFile[]>(); for (const file of files.wiki) { const name = file.parent?.name ?? "其他"; groups.set(name, [...groups.get(name) ?? [], file]); }
    const wikiList = node(structure, "div", "kb-wiki-list");
    for (const [name, items] of groups) { const row = node(wikiList, "div", "kb-wiki-row"); node(row, "span", "kb-wiki-name", name); const count = node(row, "span", "kb-wiki-count", String(items.length)); node(count, "small", "", `${Math.round(items.length / files.wiki.length * 100)}%`); node(row, "span", "kb-wiki-today", added(items) ? `+${added(items)}` : "—"); const track = node(row, "span", "kb-wiki-track"); node(track, "b").style.width = `${items.length / files.wiki.length * 100}%`; }
    if (!files.wiki.length) node(wikiList, "p", "em-empty", "还没有 Wiki 笔记");
    const queue = node(section("资料队列", "处理状态尚未扫描"), "div", "kb-queues");
    for (const [kind, label] of [["raw", "Raw"], ["inbox", "Inbox"]] as const) { const row = this.ui.button(queue, "", () => list(kind), undefined, "kb-queue-row"); const labelEl = node(row, "span", "kb-queue-label"); node(labelEl, "strong", "", label); node(labelEl, "small", "", `${files[kind].length} 篇`); const facts = node(row, "span", "kb-queue-facts"); for (const text of [`今日 +${added(files[kind])}`, "待处理 —", "待校准 —"]) node(facts, "span", "", text); }
    const calendar = section("体检记录", `${checks.length} 条记录`); calendar.classList.add("kb-calendar");
    const drawCalendar = () => {
      calendar.querySelectorAll(".kb-month-nav,.kb-weekdays,.kb-calendar-grid,.kb-calendar-legend").forEach(element => element.remove());
      const year = this.knowledgeMonth.getFullYear(), month = this.knowledgeMonth.getMonth(); const records = checks.filter(check => check.date.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`));
      const nav = node(calendar, "div", "kb-month-nav"); this.ui.button(nav, "", () => { this.knowledgeMonth = new Date(year, month - 1, 1); drawCalendar(); }, "chevron-left", "kb-icon-button").setAttribute("aria-label", "上个月"); node(nav, "strong", "", `${year} 年 ${month + 1} 月`).setAttribute("aria-live", "polite"); const next = this.ui.button(nav, "", () => { this.knowledgeMonth = new Date(year, month + 1, 1); drawCalendar(); }, "chevron-right", "kb-icon-button"); next.setAttribute("aria-label", "下个月"); next.disabled = year === today.getFullYear() && month === today.getMonth();
      const week = node(calendar, "div", "kb-weekdays"); for (const label of ["一", "二", "三", "四", "五", "六", "日"]) node(week, "span", "", label);
      const grid = node(calendar, "div", "kb-calendar-grid"); for (let i = 0; i < (new Date(year, month, 1).getDay() + 6) % 7; i++) node(grid, "span", "kb-day kb-day-empty");
      for (let day = 1; day <= new Date(year, month + 1, 0).getDate(); day++) { const key = dayKey(new Date(year, month, day)); const record = records.find(check => check.date === key); const cell = record ? this.ui.button(grid, "", () => this.ui.sheet("体检记录", part => { this.help(part, `${record.date} · ${record.status}`); this.help(part, new Date(record.at).toLocaleString()); }), undefined, `kb-day kb-day-${record.status === "success" ? "success" : "failed"}`) : node(grid, "span", `kb-day ${key === dayKey(today) ? "kb-day-today" : ""}`); node(cell, "span", "", String(day)); cell.setAttribute("aria-label", `${month + 1} 月 ${day} 日，${record ? record.status : "无体检记录"}`); if (record) node(cell, "b"); if (key === dayKey(today)) cell.setAttribute("aria-current", "date"); }
      const legend = node(calendar, "div", "kb-calendar-legend"); node(legend, "span", "", `成功 ${records.filter(record => record.status === "success").length}`); node(legend, "span", "", `失败 ${records.filter(record => record.status !== "success").length}`); this.ui.button(legend, "本月", () => { this.knowledgeMonth = new Date(today.getFullYear(), today.getMonth(), 1); drawCalendar(); });
    }; drawCalendar();
    const model = this.group(section("模型")); this.ui.row(model, "EchoInk 当前模型", "选择模型", "server", () => this.ui.go("providers"));
    const history = this.group(section("维护日志")); if (!logs.length) node(history, "p", "em-empty", "还没有维护记录");
    for (const log of logs) this.ui.row(history, log.date, log.resultStatus ?? log.status, "history", () => this.ui.sheet("维护记录", part => {
      this.help(part, `${log.date} · ${log.resultStatus ?? log.status}`);
      if (log.recordId) {
        const loading = this.help(part, "读取中…");
        void this.services.readMaintenanceRecord(log.recordId).then(record => {
          if (!part.isConnected) return;
          loading.remove(); this.help(part, record.summary);
          this.heading(part, "来源");
          for (const source of record.sources) this.help(part, `${source.path} · ${source.status === "processed" ? "已处理" : source.status === "unread" ? "未读取" : "待处理"}`);
          this.heading(part, "成果");
          if (!record.result.notes.length) this.help(part, "本轮没有新增知识笔记");
          for (const note of record.result.notes) this.ui.row(part, note.title, note.path, "file-text", () => this.host.openNote(note.path));
          for (const assessment of record.result.assessments) this.help(part, `${assessment.claim} · ${assessment.status} · ${assessment.verification}`);
          if (record.result.issues.length) { this.heading(part, "问题"); for (const issue of record.result.issues) this.help(part, `${issue.path ? `${issue.path}：` : ""}${issue.message}`); }
        }).catch(error => { if (part.isConnected) { loading.className = "em-error"; loading.textContent = error instanceof Error ? error.message : String(error); } });
      } else if (log.reportPath) this.ui.button(part, "打开历史报告", () => this.host.openNote(log.reportPath), "file-text");
      if (log.errorCode) this.help(part, log.errorCode);
    }));
    const manage = this.group(section("管理")); this.ui.row(manage, "知识提炼偏好", "", "sliders-horizontal", () => this.preferences());
    for (const [kind, label] of [["raw", "资料来源"], ["wiki", "知识成果"], ["inbox", "收件箱"]] as const) this.ui.row(manage, label, this.services.knowledgeBindingDescription(kind), "folder", () => this.editKnowledgeBinding(kind, label));
  }
  private editKnowledgeBinding(kind: "raw" | "wiki" | "inbox", title: string) {
    const saved = this.host.settings().knowledgeBase.folderBindings;
    const draft = structuredClone(saved ?? emptyKnowledgeFolderBindings());
    const binding = draft.roles[kind];
    const revision = saved?.revision ?? 0;
    this.ui.sheet(title, part => {
      let busy = false;
      const error = node(part, "p", "em-error"); error.hidden = true;
      const toggle = this.toggle(part, "启用", binding.enabled, async checked => { binding.enabled = checked; sync(); });
      const paths = node(part, "div");
      const choose = node(part, "label", "em-field"); node(choose, "span", "", "选择已有目录");
      const select = node(choose, "select"); select.setAttribute("aria-label", "选择已有目录");
      node(select, "option", "", "请选择目录").value = "";
      for (const folder of this.host.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !!file.path).sort((a, b) => a.path.localeCompare(b.path))) node(select, "option", "", folder.path).value = folder.path;
      const add = this.ui.button(part, kind === "raw" ? "添加来源" : "使用所选目录", () => {
        if (busy || !select.value) return;
        const directory = normalizeKnowledgeDirectory(select.value);
        binding.readPaths = kind === "raw" ? [...new Set([...binding.readPaths, directory])] : [directory];
        binding.compatibilityReadScopes = false;
        if (binding.readPaths.length === 1) binding.writePath = directory;
        binding.enabled = true; toggle.checked = true; drawPaths(); sync();
      }, "plus", "em-wide-action");
      const defaults = node(part, "label", "em-field"); node(defaults, "span", "", "新资料默认保存位置");
      const defaultSelect = node(defaults, "select"); defaultSelect.setAttribute("aria-label", "新资料默认保存位置");
      defaultSelect.addEventListener("change", () => { binding.writePath = defaultSelect.value || null; });
      const unbind = this.ui.button(part, "解绑位置", () => { if (busy) return; binding.readPaths = []; binding.writePath = null; binding.enabled = false; toggle.checked = false; drawPaths(); sync(); }, "unlink", "em-wide-action");
      const save = this.ui.button(part, "保存", async () => {
        if (busy) return;
        busy = true; sync(); error.hidden = true; part.setAttribute("aria-busy", "true");
        try {
          draft.migrationIssues = draft.migrationIssues.filter(issue => !issue.startsWith(`${kind}：`));
          await this.services.saveKnowledgeBindings(draft, revision);
          this.ui.go("knowledge");
        } catch (failure) { error.hidden = false; error.textContent = failure instanceof Error ? failure.message : String(failure); }
        finally { busy = false; part.removeAttribute("aria-busy"); sync(); }
      }, "check", "em-primary em-wide-action");
      const sync = () => { toggle.disabled = busy; select.disabled = busy || !binding.enabled; add.disabled = busy || !binding.enabled; defaultSelect.disabled = busy || !binding.enabled; unbind.disabled = busy; save.disabled = busy; save.querySelector("span:last-child")!.textContent = busy ? "保存中…" : "保存"; paths.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = busy || !binding.enabled; }); };
      const drawPaths = () => {
        paths.replaceChildren();
        for (const directory of binding.readPaths) {
          const row = node(paths, "div", "em-row"); node(row, "span", "em-row-label", directory);
          this.ui.button(row, "移除", () => { if (busy) return; binding.readPaths = binding.readPaths.filter(value => value !== directory); if (binding.writePath === directory) binding.writePath = binding.readPaths.length === 1 ? binding.readPaths[0] : null; drawPaths(); sync(); });
        }
        defaultSelect.replaceChildren(); node(defaultSelect, "option", "", "请选择默认位置").value = "";
        for (const directory of binding.readPaths) node(defaultSelect, "option", "", directory).value = directory;
        defaultSelect.value = binding.writePath ?? ""; defaults.hidden = kind !== "raw";
      };
      drawPaths(); sync();
    });
  }
  private preferences() {
    void this.ui.act(async () => {
      const original = await this.services.readPreferences();
      this.ui.sheet("知识提炼偏好", body => {
        this.help(body, original === null ? "当前使用默认提炼偏好。保存后，移动对话会使用你的自定义偏好。" : "自定义偏好与桌面共享同一文件。");
        const input = node(body, "textarea", "em-memory-editor"); input.value = original ?? this.services.defaultPreferences; input.setAttribute("aria-label", "知识提炼偏好");
        this.ui.button(body, "保存", async () => { await this.services.savePreferences(input.value, original); this.ui.go("knowledge"); }, "check", "em-primary em-wide-action");
        this.ui.button(body, "恢复默认", async () => { await this.services.restorePreferences(original); this.ui.go("knowledge"); }, "rotate-ccw", "em-wide-action");
      });
    });
  }
  private profile(body: HTMLElement, kind: "agent" | "user") {
    if (kind === "agent") {
      this.agentArticle = node(body, "article", "em-agent-profile");
      void this.loadAgentProfile(this.agentArticle); return;
    }
    const article = node(body, "article", "em-profile-reader markdown-rendered"); article.tabIndex = 0;
    this.heading(article, "用户画像");
    void this.ui.act(async () => {
      const content = await this.services.readProfile(kind); if (!article.isConnected) return;
      if (content === null) this.help(article, "当前笔记库还没有这份档案。"); else this.host.renderMarkdown(content, article);
      article.scrollTop = this.profileScroll.get(kind) ?? 0;
    });
    article.addEventListener("scroll", () => this.profileScroll.set(kind, article.scrollTop), { passive: true });
  }
  private async loadAgentProfile(article: HTMLElement) {
    const restore = article.contains(article.ownerDocument.activeElement);
    try {
      const data = await this.services.readAgentProfile(); if (!article.isConnected) return;
      article.replaceChildren();
      const header = node(article, "header", "em-profile-actions"); node(header, "h3", "", "Agent 画像");
      const select = this.ui.button(header, data.templateId ? "重新选择人格模板" : "选择人格模板", () => this.selectAgentTemplate(data), "users"); select.classList.add("em-profile-template");
      const card = node(article, "section", "echoink-agent-profile-card-body");
      const identity = node(card, "div", "echoink-agent-profile-identity");
      const avatarButton = this.ui.button(identity, "", () => this.editAgentIdentity(data), undefined, "em-profile-avatar-button"); avatarButton.setAttribute("aria-label", "编辑身份");
      this.avatar(avatarButton, data.identity, "echoink-agent-profile-avatar");
      node(identity, "strong", "echoink-agent-profile-name", data.identity.displayName);
      node(identity, "span", "echoink-agent-profile-personality", `初始风格：${getAgentTemplate(data.templateId)?.labelZh ?? "尚未选择"}`);
      this.ui.button(identity, "编辑身份", () => this.editAgentIdentity(data), "user-round-pen", "em-profile-edit");
      const content = node(card, "section", "echoink-agent-profile-content"); node(content, "h4", "echoink-agent-profile-content-title", "我的公开画像");
      if (data.profile) {
        const fields = node(content, "dl", "echoink-agent-profile-current-fields");
        for (const [label, text] of [["思考方式", data.profile.thinkingMethod], ["回答语气", data.profile.answerTone], ["回答结构", data.profile.answerStructure]]) {
          const field = node(fields, "div", "echoink-agent-profile-field"); node(field, "dt", "echoink-agent-profile-field-label", label); node(field, "dd", "echoink-agent-profile-field-value", text);
        }
        node(content, "h4", "echoink-agent-profile-section-title", "长期形成的习惯");
        if (data.profile.representativeHabits.length) { const list = node(content, "ul", "echoink-agent-profile-habit-list"); data.profile.representativeHabits.forEach(text => node(list, "li", "", text)); }
        else node(content, "p", "echoink-agent-profile-growth-empty", "我还没有需要长期保留的后天习惯。");
      } else this.help(content, "尚未设置人格。选择一种初始风格，开始建立你的 Agent 画像。");
      node(content, "p", "echoink-agent-profile-growth-note", "我会随着与你的长期对话持续学习，逐步调整自己的处事方式。");
      if (restore) select.focus({ preventScroll: true });
    } catch {
      if (!article.isConnected) return;
      article.replaceChildren(); this.heading(article, "Agent 画像");
      this.help(article, "人格资料读取失败或尚未完成同步。原资料已保留。");
      this.ui.button(article, "重新读取人格", () => this.loadAgentProfile(article));
    }
  }
  private editAgentIdentity(data: MobileAgentProfile, templateId?: AgentTemplateId) {
    const restore = this.agentArticle?.querySelector<HTMLElement>(".em-profile-edit");
    const modal = new AgentIdentityModal(this.host.app, { initialName: data.identity.displayName, initialAvatar: data.identity.avatar, language: "zh", mode: data.identity.revision === 0 ? "first-run" : "edit",
      onConfirm: async identity => { await this.services.saveAgentProfile({ identity, ...(templateId ? { templateId } : {}) }, data.version); if (templateId) this.ui.closeSheet(); } });
    modal.modalEl.classList.add("echoink-mobile-identity-modal"); modal.modalEl.classList.toggle("em-large-text", this.host.settings().mobileUi.largeText);
    const close = modal.onClose.bind(modal) as () => void; modal.onClose = () => { close(); const target = restore?.isConnected ? restore : this.agentArticle?.querySelector<HTMLElement>(".em-profile-template"); target?.focus({ preventScroll: true }); };
    modal.open();
  }
  private selectAgentTemplate(data: MobileAgentProfile) {
    this.ui.sheet("选择人格模板", body => {
      this.help(body, "只调整基础风格，长期形成的习惯会保留。");
      const list = node(body, "div", "em-template-list");
      let busy = false;
      for (const template of AGENT_TEMPLATES) {
        const row = this.ui.row(list, template.labelZh, template.tone, "users", async () => {
          if (busy) return;
          if (data.templateId === template.id) { this.ui.closeSheet(); return; }
          if (data.identity.revision === 0) { this.editAgentIdentity(data, template.id); return; }
          busy = true; list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
          try { await this.services.saveAgentProfile({ templateId: template.id }, data.version); this.ui.closeSheet(); }
          finally { busy = false; list.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; }); }
        });
        row.setAttribute("aria-current", data.templateId === template.id ? "true" : "false");
      }
      this.ui.button(body, "取消", () => this.ui.closeSheet(), undefined, "em-wide-action");
    });
  }
  private review(body: HTMLElement) {
    this.heading(body, "生成周报"); const group = this.group(body);
    this.ui.row(group, "Agent 周报", "", "feather", () => this.reportConfig("agent")); this.ui.row(group, "知识库周报", "", "book-text", () => this.reportConfig("knowledge"));
    this.heading(body, "管理"); const manage = this.group(body);
    this.ui.row(manage, "已归档会话", "", "history", () => this.ui.go("archives")); this.ui.row(manage, "记忆修正", "", "brain", () => this.ui.go("memories"));
    this.ui.button(body, "归档当前会话", async () => {
      if (this.host.runtime.busy) throw new Error("请先停止当前回答。");
      this.host.store.session.archivedAt = Date.now(); await this.host.store.createSession(); this.host.runtime.onChange(); this.ui.go("archives");
    }, "archive", "em-wide-action");
  }
  private reportConfig(kind: "agent" | "knowledge") {
    const config = this.host.settings().mobileUi.reports[kind];
    this.ui.sheet(kind === "agent" ? "Agent 周报" : "知识库周报", body => {
      const choices = (title: string, field: "period" | "schedule", entries: readonly (readonly [string, string])[]) => {
        this.heading(body, title); const group = node(body, "div", "em-tabs em-segments"); group.setAttribute("role", "group"); group.setAttribute("aria-label", title);
        for (const [id, label] of entries) { const button = this.ui.button(group, label, async () => { if (field === "period") config.period = id as typeof config.period; else config.schedule = id as typeof config.schedule; await this.host.saveSettings(); group.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === button))); }); button.setAttribute("aria-pressed", String(config[field] === id)); }
      };
      choices("统计周期", "period", [["7d", "最近 7 天"], ["last-week", "上一周"], ["30d", "最近 30 天"]]);
      choices("执行周期", "schedule", [["manual", "手动"], ["weekly", "每周"], ["monthly", "每月"]]);
      this.help(body, "移动端尚未接通周报生成与后台调度；配置已保存，不会自动执行。已有报告可从笔记库打开。");
      const button = this.ui.button(body, "立即执行", () => { throw new Error("移动周报生成链尚未接通，未执行、未生成报告。"); }, "play", "em-primary em-wide-action"); button.setAttribute("aria-describedby", "em-report-status");
      this.ui.button(body, "完成", () => this.ui.go("review"), "check", "em-wide-action");
    });
  }
  private archives(body: HTMLElement) {
    const sessions = this.host.store.state.sessions.filter(item => item.archivedAt);
    if (!sessions.length) node(body, "p", "em-empty", "还没有已归档会话");
    for (const session of sessions) {
      const details = node(body, "details", "em-archive"); node(details, "summary", "", session.title);
      details.addEventListener("toggle", () => {
        if (!details.open || details.querySelector("article")) return;
        const article = node(details, "article");
        for (const message of session.messages) {
          if (!("content" in message) || message.role === "toolResult") continue;
          const content = typeof message.content === "string" ? message.content : message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
          const bubble = node(article, "div", message.role === "user" ? "em-user-message" : "em-answer markdown-rendered");
          if (message.role === "user") bubble.textContent = content; else this.host.renderMarkdown(content, bubble);
        }
        this.ui.button(article, "恢复会话", async () => { if (this.host.runtime.busy) throw new Error("请先停止当前回答。"); delete session.archivedAt; this.host.store.state.activeSessionId = session.id; await this.host.store.save(); this.host.runtime.onChange(); this.ui.go("chat"); }, "rotate-ccw", "em-wide-action");
      });
    }
  }
  private todoSettings(body: HTMLElement) {
    this.heading(body, "数据文件"); const data = this.group(body); this.ui.row(data, "待办源文件", TODO_SOURCE_PATH, "file-text", () => this.services.getTodoStore().openSourceFile());
    this.ui.row(data, "待办清单", "", "check-check", () => this.ui.go("todos"));
    this.heading(body, "待办分类");
    const settings = this.host.settings();
    const categories = settings.todoCategories.length ? this.group(body) : body;
    for (const category of settings.todoCategories) this.ui.row(categories, category.name, "", "bookmark", () => this.ui.sheet("编辑分类", part => {
      let name = category.name; this.ui.field(part, "分类名称", name, value => { name = value; });
      this.ui.button(part, "保存", async () => {
        name = name.trim(); if (!name) throw new Error("分类名称不能为空。"); if (settings.todoCategories.some(other => other.id !== category.id && other.name === name)) throw new Error("已有同名分类。");
        await this.services.getTodoStore().renameCategoryInSource(category.name, name); category.name = name; await this.host.saveSettings(); this.ui.go("todos-settings");
      }, "check", "em-primary em-wide-action");
    }));
    this.ui.button(body, "添加分类", () => this.ui.sheet("添加分类", part => {
      let name = ""; this.ui.field(part, "分类名称", "", value => { name = value; });
      this.ui.button(part, "保存", async () => { name = name.trim(); if (!name || settings.todoCategories.some(item => item.name === name)) throw new Error("请填写一个新的分类名称。"); settings.todoCategories.push({ id: newId("todo-category"), name }); await this.host.saveSettings(); this.ui.go("todos-settings"); }, "check", "em-primary em-wide-action");
    }), "plus", "em-wide-action");
  }
  private todos(body: HTMLElement) {
    const store = this.services.getTodoStore();
    const status = node(body, "div", "em-tabs em-segments"); status.setAttribute("role", "group"); status.setAttribute("aria-label", "待办状态");
    const filters = node(body, "div", "em-todo-filters");
    const category = node(filters, "select"); category.setAttribute("aria-label", "待办分类");
    for (const name of ["", ...this.host.settings().todoCategories.map(item => item.name)]) { const option = node(category, "option", "", name || "全部分类"); option.value = name; }
    category.value = this.todoCategory;
    const date = node(filters, "select"); date.setAttribute("aria-label", "待办日期");
    for (const [id, title] of [["all", "全部日期"], ["today", "今天"], ["overdue", "已逾期"], ["none", "无日期"]]) { const option = node(date, "option", "", title); option.value = id; } date.value = this.todoDate;
    const list = node(body, "section", "em-todo-list");
    const render = () => {
      list.replaceChildren(); const today = new Date().toLocaleDateString("sv-SE");
      const records = store.snapshot().filter(item => (this.todoStatus === "all" || (this.todoStatus === "done" ? item.done : !item.done)) && (!this.todoCategory || item.categoryName === this.todoCategory) && (this.todoDate === "all" || (this.todoDate === "none" ? !item.dueDate : this.todoDate === "today" ? item.dueDate === today : !!item.dueDate && item.dueDate < today && !item.done)));
      if (!records.length) node(list, "p", "em-empty", "没有符合条件的待办");
      for (const item of records) this.todoRow(list, item, render);
    };
    for (const [id, title] of [["open", "未完成"], ["done", "已完成"], ["all", "全部"]]) { const button = this.ui.button(status, title, () => { this.todoStatus = id; status.querySelectorAll("button").forEach(tab => tab.setAttribute("aria-pressed", String(tab === button))); render(); }); button.setAttribute("aria-pressed", String(id === this.todoStatus)); }
    category.addEventListener("change", () => { this.todoCategory = category.value; render(); }); date.addEventListener("change", () => { this.todoDate = date.value; render(); });
    this.ui.button(body, "新建待办", () => { new EchoInkTodoFormModal(this.host.app, this.services, null).open(); }, "plus", "em-wide-action");
    render();
    this.unsubscribe = store.subscribe(() => { if (body.isConnected) render(); });
  }
  private todoRow(parent: HTMLElement, item: ParsedTodoRecord, refresh: () => void) {
    const row = node(parent, "div", "em-todo-row");
    this.toggle(row, item.title, item.done, async done => { await this.services.getTodoStore().toggleDone(item, done); refresh(); });
    row.querySelector("input")?.setAttribute("role", "checkbox");
    this.ui.button(row, "编辑", () => { new EchoInkTodoFormModal(this.host.app, this.services, item).open(); }, "pencil");
    this.help(row, [item.dueDate, item.categoryName].filter(Boolean).join(" · "));
  }
}
