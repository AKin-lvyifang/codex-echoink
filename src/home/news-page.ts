import { NEXT, failureText, actionFailureText } from "../core/error-copy";
import { ItemView, Notice, normalizePath, requestUrl, setIcon, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { GENERALIST_AGENT_ID } from "../agents/types";
import { createNewsFetch, membershipApiUrl } from "../membership/transport";
import { tagMembershipWebsiteLink } from "../membership/website-links";
import { createOriginButton, createOriginInput, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, applyDeleteButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { attachNativeTooltip } from "../ui/native-tooltip";
import { newsAgentPrompt, newsNoteContent, newsNoteFileName } from "../news/actions";
import {
  NEWS_PAGE_SIZE, newsClock, newsDayGroups, newsDayLabel, newsEventItem, newsHotEvents, newsLeadItems, newsMatchesQuery,
  localizeNewsFeed, newsRelativeTime, newsSourceCount, newsUpdatedLabel, safeNewsUrl, type NewsAnnouncement, type NewsCategory, type NewsFeed, type NewsItem, type NewsTrend
} from "../news/feed";
import { buildNewsRelevanceIndex, matchNewsRelevance, newsReasonText, NEWS_RELEVANCE_MAX_NOTES, type NewsNoteSource, type NewsRelevance } from "../news/relevance";
import { addRssSubscription, NewsRssError, NewsRssService, rssErrorText, type NewsRssItem, type NewsRssRequest } from "../news/rss";
import { NEWS_REFRESH_MS, NewsService, type NewsCacheStore, type NewsState } from "../news/service";
import { workbenchHasPro } from "./workbench-module-lock";

export const NEWS_PAGE_VIEW_TYPE = "echoink-news-page";
type NewsTab = "all" | "foryou" | NewsCategory | "mine";
type Row = NewsItem | NewsRssItem;
const TABS: readonly [NewsTab, string, string][] = [["all", "全部", "All"], ["foryou", "为你", "For you"], ["model", "模型", "Models"], ["product", "产品", "Products"],
  ["industry", "行业", "Industry"], ["paper", "论文", "Papers"], ["tutorial", "教程", "Tutorials"], ["opinion", "观点", "Opinion"], ["mine", "我的订阅", "My feeds"]];
const isMine = (item: Row): item is NewsRssItem => "mine" in item;

export interface NewsPageDeps { service: NewsService; rss: NewsRssService; request: NewsRssRequest; now: () => number }
const services = new WeakMap<CodexForObsidianPlugin, NewsPageDeps>();
/** 一个插件实例共用一份服务；缓存只有插件目录里的一个 JSON 文件，不进用户笔记。 */
export function newsPageDeps(plugin: CodexForObsidianPlugin): NewsPageDeps {
  let deps = services.get(plugin);
  if (!deps) {
    const path = normalizePath(`${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/news-cache.json`), adapter = plugin.app.vault.adapter;
    const store: NewsCacheStore = {
      read: async () => await adapter.exists(path) ? await adapter.read(path) : null,
      write: text => adapter.write(path, text),
      remove: async () => { if (await adapter.exists(path)) await adapter.remove(path); }
    };
    const request: NewsRssRequest = async url => { const response = await requestUrl({ url, method: "GET", throw: false }); return { status: response.status, text: response.text }; };
    deps = { service: new NewsService({ fetch: createNewsFetch(membershipApiUrl), token: () => plugin.accountService?.apiToken() ?? null, store }),
      rss: new NewsRssService(request, NEWS_REFRESH_MS), request, now: Date.now };
    services.set(plugin, deps);
  }
  return deps;
}

/** 资讯页：只在页面可见时取数和渲染，切走即清空 DOM；所有外部文字用 createEl/setText 当纯文本。 */
export class NewsPageView extends ItemView {
  private closed = true;
  private visible = false;
  private generation = 0;
  private state: NewsState | null = null;
  private loading = false;
  private page: "feed" | "subscriptions" = "feed";
  private tab: NewsTab = "all";
  private query = "";
  private limit = NEWS_PAGE_SIZE;
  private openId: string | null = null;
  private hotExpanded = false;
  private rssItems: NewsRssItem[] = [];
  private rssError = "";
  private rssDraft = "";
  private rssBusy = false;
  private relevance = new Map<string, NewsRelevance>();
  private relevanceKey = "";
  private releaseAccount: (() => void) | null = null;
  private readonly deps: NewsPageDeps;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin, deps?: NewsPageDeps) { super(leaf); this.deps = deps ?? newsPageDeps(plugin); }
  getViewType(): string { return NEWS_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("资讯", "News"); }
  getIcon(): string { return "newspaper"; }
  private get english(): boolean { return this.plugin.settings.settingsLanguage === "en"; }
  private t(zh: string, en: string): string { return this.english ? en : zh; }
  private hasPro(): boolean { return workbenchHasPro(this.plugin); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-news-page", "echoink-theme-boundary");
    // 宿主切换标签后才更新布局，所以晚一拍再看这页是否还可见。
    const later = () => { this.contentEl.ownerDocument.defaultView?.setTimeout(() => this.syncVisibility(), 0); };
    this.registerEvent(this.app.workspace.on("active-leaf-change", later));
    this.registerEvent(this.app.workspace.on("layout-change", later));
    this.registerDomEvent(this.contentEl, "keydown", event => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || target?.matches("input, textarea, [contenteditable]")) return;
      const search = this.contentEl.querySelector<HTMLInputElement>('[data-news="search"]');
      if (search) { event.preventDefault(); search.focus(); }
    });
    this.releaseAccount = this.plugin.accountService?.subscribe(() => { if (this.visible) void this.refresh(); }) ?? null;
    this.syncVisibility();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.visible = false; this.generation++;
    this.releaseAccount?.(); this.releaseAccount = null;
    this.clear();
  }
  refreshLanguage(): void {
    if (this.visible) this.render();
    const title = (this as ItemView & { titleEl?: HTMLElement }).titleEl;
    if (title) title.textContent = this.getDisplayText();
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }
  refreshIfSettingsChanged(): void { this.syncVisibility(); }
  private clear(): void { disposeOriginControls(this.contentEl); this.contentEl.empty(); }
  /** 标签页被切走时这个容器没有布局盒：清空 DOM、丢弃在途结果；切回来再渲染并按 10 分钟规则取数。 */
  private syncVisibility(): void {
    const visible = !this.closed && this.contentEl.isConnected && this.contentEl.getClientRects().length > 0;
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) { this.generation++; this.loading = false; this.clear(); return; }
    this.render();
    void this.refresh();
  }

  /** force 只来自手动刷新。免费账号不发请求。 */
  async refresh(force = false): Promise<void> {
    if (!this.visible) return;
    if (!this.hasPro()) { this.state = { kind: "pro-required" }; this.loading = false; this.render(); return; }
    const generation = ++this.generation;
    if (!this.state || this.state.kind !== "ready") this.state = await this.deps.service.cached();
    if (generation !== this.generation || !this.visible) return;
    this.loading = true; this.render();
    const updateRss = (items: NewsRssItem[]) => {
      if (generation !== this.generation || !this.visible || !this.hasPro()) return;
      this.rssItems = items;
      if (this.tab === "mine") this.render();
    };
    void this.deps.rss.load(this.plugin.settings.news.subscriptions, force, updateRss).then(updateRss, () => {});
    const state = await this.deps.service.load(force);
    if (generation !== this.generation || !this.visible) return;
    this.state = state; this.loading = false;
    this.updateRelevance();
    this.render();
  }
  /** 只在数据或笔记数量变化时重算一次；只读 metadataCache 里的标题和标签。 */
  private updateRelevance(): void {
    if (this.state?.kind !== "ready") { this.relevance = new Map(); this.relevanceKey = ""; return; }
    const files = this.app.vault.getMarkdownFiles(), key = `${this.state.feed.generatedAt}|${this.state.feed.items.length}|${files.length}`;
    if (key === this.relevanceKey) return;
    const notes: NewsNoteSource[] = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, NEWS_RELEVANCE_MAX_NOTES).map(file => {
      const cache = this.app.metadataCache.getFileCache(file), front: unknown = cache?.frontmatter?.tags;
      const frontTags = Array.isArray(front) ? front.filter((tag): tag is string => typeof tag === "string") : typeof front === "string" ? front.split(/[\s,]+/u) : [];
      return { title: file.basename, tags: [...(cache?.tags ?? []).map(tag => tag.tag), ...frontTags] };
    });
    this.relevance = matchNewsRelevance(buildNewsRelevanceIndex(notes), this.state.feed.items);
    this.relevanceKey = key;
  }

  // ---------- 通用小件 ----------
  private glyph(parent: HTMLElement, name: string, cls = "news-icon"): HTMLElement {
    const node = parent.createSpan({ cls, attr: { "aria-hidden": "true" } }); setIcon(node, name); return node;
  }
  private button(parent: HTMLElement, text: string, variant: "primary" | "secondary" | "tertiary" | "icon", icon: string | null, action: (button: HTMLButtonElement) => unknown): HTMLButtonElement {
    const button = createOriginButton(parent, { text: variant === "icon" ? "" : text, cls: `news-button is-${variant}`, attr: variant === "icon" ? { "aria-label": text } : {} });
    applyAmicroButton(button, { variant });
    if (icon) button.prepend(this.glyph(button, icon, "news-button-icon"));
    if (variant === "icon") attachNativeTooltip(button, text);
    button.onclick = event => {
      event.stopPropagation();
      if (button.disabled) return;
      void Promise.resolve().then(() => action(button)).catch(error => new Notice(actionFailureText(error, this.plugin.settings.settingsLanguage)));
    };
    return button;
  }
  private openExternal(value: string): void {
    const url = safeNewsUrl(value);
    if (!url) { new Notice(this.t("这个链接无法打开。", "This link cannot be opened.")); return; }
    this.contentEl.ownerDocument.defaultView?.open(tagMembershipWebsiteLink(url, "plugin.news"), "_blank", "noopener,noreferrer");
  }

  // ---------- 页面 ----------
  private render(): void {
    if (!this.visible) return;
    const active = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
    const hadSearchFocus = active?.dataset.news === "search", caret = hadSearchFocus ? (active as HTMLInputElement).selectionStart : null, scroll = this.contentEl.scrollTop;
    this.clear();
    const inner = this.contentEl.createDiv({ cls: "news-inner" });
    if (this.page === "subscriptions" && this.hasPro()) { this.renderSubscriptions(inner); return; }
    this.page = "feed";
    const state = this.state;
    if (!this.hasPro() || state?.kind === "pro-required") {
      this.renderLock(inner, "newspaper", this.t("资讯是 PRO 功能", "News is a PRO feature"), this.t("每 3 小时整理一次 AI 与科技要闻和热点榜。", "AI and tech headlines and a trending list, refreshed every 3 hours."),
        [this.t("升级 PRO", "Upgrade to PRO"), "benefits"]);
    } else if (state?.kind === "signed-out") {
      this.renderLock(inner, "newspaper", this.t("登录后查看资讯", "Sign in to read News"), "", [this.t("登录", "Sign in"), "login"]);
    } else if (state?.kind === "soon") {
      this.renderLock(inner, "newspaper", this.t("资讯即将开放", "News is coming soon"), this.t("正在小范围内测，开放后这里会自动出现内容。", "It is in a limited preview. Content will appear here once it opens."));
    } else if (state?.kind === "paused") {
      this.renderHeader(inner, this.t("暂停更新", "Paused"));
      this.renderBulletin(inner, state.announcement);
      this.renderNotice(inner, "circle-pause", this.t("资讯暂时下线，恢复后会自动更新", "News is temporarily offline and will update again when it is back"));
    } else if (state?.kind === "ready") {
      const updated = state.feed.generatedAt ? newsUpdatedLabel(state.feed.generatedAt, this.deps.now(), this.english) : newsClock(state.fetchedAt);
      this.renderHeader(inner, this.loading ? this.t("正在更新…", "Updating…") : state.offline ? this.t(`离线 · 显示 ${updated} 的内容`, `Offline · showing ${updated}`) : this.t(`更新于 ${updated}`, `Updated ${updated}`));
      this.renderBulletin(inner, state.feed.announcement);
      this.renderTop(inner);
      const grid = inner.createDiv({ cls: "news-grid" });
      const feed = this.displayFeed(state.feed);
      this.renderMain(grid.createDiv({ cls: "news-main" }), feed);
      this.renderRail(grid, feed, updated);
    } else if (state?.kind === "empty" && !this.loading) {
      this.renderHeader(inner, "");
      const row = this.renderNotice(inner, "cloud-off", this.t("暂时取不到资讯", "News is unavailable right now"));
      this.button(row, this.t("重试", "Retry"), "tertiary", null, () => this.refresh(true));
    } else {
      this.renderHeader(inner, this.t("正在更新…", "Updating…"));
      const grid = inner.createDiv({ cls: "news-grid", attr: { "aria-busy": "true" } });
      this.renderSkeleton(grid);
    }
    if (hadSearchFocus) {
      const search = this.contentEl.querySelector<HTMLInputElement>('[data-news="search"]');
      if (search) { search.focus(); if (caret !== null) search.setSelectionRange(caret, caret); }
    }
    this.contentEl.scrollTop = scroll;
  }
  private renderHeader(parent: HTMLElement, status: string): void {
    const header = parent.createEl("header", { cls: "news-header" });
    const title = header.createDiv({ cls: "news-title" });
    title.createEl("h1", { text: this.t("资讯", "News") }).dataset.echoinkModuleTitle = "";
    if (status) title.createSpan({ cls: "news-status", text: status, attr: { "data-news": "status", "aria-live": "polite" } });
    const badge = title.createSpan({ cls: "news-tag", text: this.t("AI 摘要", "AI summary"), attr: { tabindex: "0" } });
    attachNativeTooltip(badge, this.t("标题和摘要由 AI 根据原文整理，可能有误，请以原文为准", "Titles and summaries are written by AI from the original and may be wrong. Check the original."));
    const actions = header.createDiv({ cls: "news-header-actions" });
    const refresh = this.button(actions, this.t("刷新", "Refresh"), "icon", "refresh-cw", () => this.refresh(true));
    refresh.dataset.news = "refresh"; refresh.classList.toggle("is-spinning", this.loading); refresh.disabled = this.loading;
    this.button(actions, this.t("订阅设置", "Feed settings"), "icon", "settings-2", () => { this.page = "subscriptions"; this.rssError = ""; this.render(); this.contentEl.scrollTop = 0; }).dataset.news = "subscriptions";
  }
  private renderBulletin(parent: HTMLElement, announcement: NewsAnnouncement | null): void {
    if (!announcement) return;
    const key = `${announcement.text}\n${announcement.url ?? ""}`;
    if (this.plugin.settings.news.dismissedAnnouncement === key) return;
    const bar = parent.createDiv({ cls: "news-bulletin", attr: { "data-news": "bulletin" } });
    this.glyph(bar, "megaphone");
    bar.createSpan({ cls: "news-bulletin-text", text: announcement.text });
    const url = announcement.url;
    if (url) this.button(bar, this.t("查看", "View"), "tertiary", null, () => this.openExternal(url));
    this.button(bar, this.t("关闭公告", "Dismiss"), "icon", "x", async () => {
      this.plugin.settings.news.dismissedAnnouncement = key; bar.remove();
      await this.plugin.saveSettings();
    });
  }
  private renderNotice(parent: HTMLElement, icon: string, text: string): HTMLElement {
    const row = parent.createDiv({ cls: "news-notice" });
    this.glyph(row, icon); row.createSpan({ cls: "news-notice-text", text });
    return row;
  }
  private renderTop(parent: HTMLElement): void {
    const top = parent.createDiv({ cls: "news-top" });
    const tabs = top.createDiv({ cls: "news-tabs", attr: { role: "tablist", "aria-label": this.t("资讯分类", "News categories") } });
    for (const [id, zh, en] of TABS) {
      const tab = createOriginButton(tabs, { text: this.english ? en : zh, cls: "news-tab", attr: { role: "tab", "aria-selected": String(this.tab === id), "data-news-tab": id } });
      tab.onclick = () => { this.selectTab(id); };
    }
    const search = top.createEl("label", { cls: "news-search" });
    this.glyph(search, "search");
    const input = createOriginInput(search, { value: this.query, attr: { type: "search", placeholder: this.t("搜索标题、摘要", "Search titles and summaries"), "data-news": "search", "aria-label": this.t("搜索资讯", "Search news") } });
    search.createEl("kbd", { text: "/" });
    input.oninput = () => { this.query = input.value; this.limit = NEWS_PAGE_SIZE; this.render(); };
  }
  private selectTab(tab: NewsTab): void { this.tab = tab; this.openId = null; this.limit = NEWS_PAGE_SIZE; this.render(); }

  private localized?: { source: NewsFeed; english: boolean; feed: NewsFeed };
  private displayFeed(source: NewsFeed): NewsFeed {
    const english = this.english;
    if (this.localized?.source !== source || this.localized.english !== english) this.localized = { source, english, feed: localizeNewsFeed(source, english) };
    return this.localized.feed;
  }
  private rows(feed: NewsFeed): { rows: Row[]; lead: NewsItem[] } {
    const showLead = this.tab === "all" && !this.query.trim(), lead = showLead ? newsLeadItems(feed) : [], leadIds = new Set(lead.map(item => item.id));
    const pool: Row[] = this.tab === "mine" ? this.rssItems : feed.items.filter(item => this.tab === "all" ? !leadIds.has(item.id) : this.tab === "foryou" ? this.relevance.has(item.id) : item.category === this.tab);
    return { rows: pool.filter(item => newsMatchesQuery(item, this.query)), lead };
  }
  private renderMain(parent: HTMLElement, feed: NewsFeed): void {
    const { rows, lead } = this.rows(feed), now = this.deps.now();
    if (lead.length) {
      const block = parent.createDiv({ cls: "news-lead" });
      lead.forEach((item, index) => this.renderLeadCard(block, feed, item, index === 0, now));
    }
    if (!rows.length) { if (!lead.length) this.renderEmpty(parent); return; }
    const sorted = [...rows].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    for (const group of newsDayGroups(sorted.slice(0, this.limit), now)) {
      const section = parent.createEl("section", { cls: "news-day" });
      section.createEl("h2", { cls: "news-day-label", text: newsDayLabel(group, this.english) });
      for (const item of group.items) this.renderItem(section, feed, item);
    }
    if (sorted.length > this.limit) {
      const more = parent.createDiv({ cls: "news-more" });
      this.button(more, this.t("更早的资讯", "Earlier news"), "secondary", "chevrons-down", () => { this.limit += NEWS_PAGE_SIZE; this.render(); }).dataset.news = "more";
    }
  }
  private renderEmpty(parent: HTMLElement): void {
    const query = this.query.trim(), label = TABS.find(tab => tab[0] === this.tab)!;
    const text = query ? this.t(`没有找到「${query}」`, `No results for “${query}”`)
      : this.tab === "mine" ? (this.plugin.settings.news.subscriptions.length ? this.t("订阅里暂时没有内容", "Your feeds have no items yet") : this.t("还没有订阅内容", "No feeds yet"))
      : this.tab === "foryou" ? this.t("暂时没有和你的笔记相关的资讯", "Nothing related to your notes right now")
      : this.tab === "all" ? this.t("暂时没有资讯", "No news yet") : this.t(`近 7 天没有${label[1]}类资讯`, `No ${label[2].toLowerCase()} news in the last 7 days`);
    const row = this.renderNotice(parent, "inbox", text);
    row.dataset.news = "empty";
    if (this.tab === "mine" && !query) this.button(row, this.t("添加 RSS", "Add RSS"), "tertiary", null, () => { this.page = "subscriptions"; this.rssError = ""; this.render(); });
    else if (this.tab !== "all" || query) this.button(row, this.t("看全部", "Show all"), "tertiary", null, () => { this.query = ""; this.selectTab("all"); });
  }
  private renderSource(parent: HTMLElement, source: string): void {
    const node = parent.createSpan({ cls: "news-source" });
    node.createSpan({ cls: "news-mono", text: [...source.trim()][0]?.toUpperCase() ?? "", attr: { "aria-hidden": "true" } });
    node.createSpan({ text: source });
  }
  private renderMeta(parent: HTMLElement, feed: NewsFeed, item: Row, parts: string[], tag = false): HTMLElement {
    const meta = parent.createDiv({ cls: "news-meta" });
    this.renderSource(meta, item.source);
    if (tag) meta.createSpan({ cls: `news-tag${isMine(item) ? " is-mine" : ""}`, text: this.categoryLabel(item) });
    const count = isMine(item) ? 1 : newsSourceCount(feed, item);
    for (const part of [...parts, ...(count > 1 ? [this.t(`${count} 个来源`, `${count} sources`)] : [])]) meta.createSpan({ cls: "news-meta-part", text: part });
    return meta;
  }
  private categoryLabel(item: Row): string { const tab = TABS.find(entry => entry[0] === (isMine(item) ? "mine" : item.category))!; return this.english ? tab[2] : tab[1]; }
  private renderReason(parent: HTMLElement, item: Row): void {
    const relevance = this.relevance.get(item.id);
    if (!relevance) return;
    const why = parent.createDiv({ cls: "news-why" });
    this.glyph(why, "link-2"); why.createSpan({ text: newsReasonText(relevance.reason, this.english) });
  }
  private renderLeadCard(parent: HTMLElement, feed: NewsFeed, item: NewsItem, main: boolean, now: number): void {
    const card = parent.createEl("article", { cls: `news-lead-card${main ? " is-main" : ""}`, attr: { tabindex: "0", role: "link", "data-news-item": item.id } });
    const relative = newsRelativeTime(item.publishedAt, now, this.english);
    if (main) this.renderMeta(card, feed, item, [relative, this.categoryLabel(item)]);
    card.createDiv({ cls: "news-lead-title", text: item.title });
    if (main) { if (item.summary) card.createDiv({ cls: "news-lead-summary", text: item.summary }); this.renderReason(card, item); }
    else this.renderMeta(card, feed, item, [relative]);
    this.renderHoverActions(card, item);
    card.onclick = () => this.openExternal(item.url);
    card.onkeydown = event => { if (event.target === card && event.key === "Enter") this.openExternal(item.url); };
  }
  private renderHoverActions(parent: HTMLElement, item: Row): void {
    const actions = parent.createDiv({ cls: "news-row-actions" });
    this.button(actions, this.t("存到收件箱", "Save to Inbox"), "icon", "inbox", button => this.saveToInbox(item, button));
    if (!isMine(item)) this.button(actions, this.t("让 Agent 解读", "Ask an Agent"), "icon", "sparkles", () => this.askAgent(item));
    this.button(actions, this.t("打开原文", "Open original"), "icon", "external-link", () => this.openExternal(item.url));
  }
  private renderItem(parent: HTMLElement, feed: NewsFeed, item: Row): void {
    const open = this.openId === item.id;
    const row = parent.createDiv({ cls: `news-item${open ? " is-open" : ""}`, attr: { tabindex: "0", role: "button", "aria-expanded": String(open), "data-news-item": item.id } });
    row.createSpan({ cls: "news-item-time", text: newsClock(item.publishedAt) });
    const body = row.createDiv({ cls: "news-item-body" });
    body.createDiv({ cls: "news-item-title", text: item.title });
    if (item.summary) body.createDiv({ cls: "news-item-summary", text: item.summary });
    this.renderMeta(body, feed, item, [], true);
    if (open) {
      const more = body.createDiv({ cls: "news-item-more" });
      this.renderReason(more, item);
      const actions = more.createDiv({ cls: "news-item-actions" });
      this.button(actions, this.t("存到收件箱", "Save to Inbox"), "secondary", "inbox", button => this.saveToInbox(item, button));
      if (!isMine(item)) this.button(actions, this.t("让 Agent 解读", "Ask an Agent"), "secondary", "sparkles", () => this.askAgent(item));
      this.button(actions, this.t("原文", "Original"), "secondary", "external-link", () => this.openExternal(item.url));
    } else this.renderHoverActions(row, item);
    const toggle = () => { this.openId = open ? null : item.id; this.render(); this.contentEl.querySelector<HTMLElement>(`.news-item[data-news-item="${item.id}"]`)?.focus({ preventScroll: true }); };
    row.onclick = toggle;
    row.onkeydown = event => { if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(); } };
  }
  /** 热点和「和你有关」点进来：切到全部、清掉搜索、把那一条露出来并展开。 */
  private reveal(feed: NewsFeed, id: string): void {
    this.tab = "all"; this.query = "";
    const isLead = newsLeadItems(feed).some(item => item.id === id);
    if (!isLead) {
      const sorted = feed.items.filter(item => !newsLeadItems(feed).includes(item)).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      this.limit = Math.max(this.limit, Math.ceil((sorted.findIndex(item => item.id === id) + 1) / NEWS_PAGE_SIZE) * NEWS_PAGE_SIZE);
      this.openId = id;
    }
    this.render();
    const target = this.contentEl.querySelector<HTMLElement>(`.news-main [data-news-item="${id}"]`);
    target?.scrollIntoView({ block: "center" }); target?.focus({ preventScroll: true });
  }
  private renderRail(parent: HTMLElement, feed: NewsFeed, updated: string): void {
    const rail = parent.createEl("aside", { cls: "news-rail" });
    const hot = newsHotEvents(feed);
    if (hot.length) {
      const panel = rail.createEl("section", { cls: "news-panel", attr: { "data-news": "hot" } });
      const head = panel.createDiv({ cls: "news-section-head" });
      head.createSpan({ cls: "news-live", attr: { "aria-hidden": "true" } });
      head.createEl("h2", { text: this.t("当前热点", "Trending now") });
      head.createSpan({ cls: "news-count", text: updated });
      const trends: Record<NewsTrend, [string, string, string]> = { new: ["sparkle", "新上榜", "New"], up: ["trending-up", "上升", "Rising"], down: ["trending-down", "回落", "Falling"], flat: ["minus", "持平", "Steady"] };
      hot.slice(0, this.hotExpanded ? hot.length : 5).forEach((event, index) => {
        const target = newsEventItem(feed, event);
        const row = createOriginButton(panel, { cls: "news-hot" });
        row.createSpan({ cls: `news-hot-rank${index < 3 ? " is-top" : ""}`, text: String(index + 1) });
        row.createSpan({ cls: "news-hot-title", text: event.title });
        if (event.sourceCount > 1) attachNativeTooltip(row.createSpan({ cls: "news-hot-sources", text: String(event.sourceCount) }), this.t(`${event.sourceCount} 个来源在报道`, `${event.sourceCount} sources are covering this`));
        const [icon, zh, en] = trends[event.trend];
        attachNativeTooltip(this.glyph(row, icon, `news-trend${event.trend === "new" || event.trend === "up" ? " is-up" : ""}`), this.english ? en : zh);
        row.onclick = () => { if (target) this.reveal(feed, target.id); };
      });
      if (!this.hotExpanded && hot.length > 5) {
        const foot = panel.createDiv({ cls: "news-panel-foot" });
        this.button(foot, this.t(`还有 ${hot.length - 5} 条`, `${hot.length - 5} more`), "tertiary", null, () => { this.hotExpanded = true; this.render(); }).append(this.glyph(foot, "chevron-down", "news-button-icon"));
      }
    }
    const picks = feed.items.filter(item => this.relevance.has(item.id)).sort((a, b) => this.relevance.get(b.id)!.weight - this.relevance.get(a.id)!.weight || b.score - a.score).slice(0, 5);
    if (!picks.length) return;
    const section = rail.createEl("section", { cls: "news-picks", attr: { "data-news": "picks" } });
    const head = section.createDiv({ cls: "news-section-head" });
    head.createEl("h2", { text: this.t("和你有关", "Related to you") });
    head.createSpan({ cls: "news-count", text: String(picks.length) });
    for (const item of picks) {
      const row = createOriginButton(section, { cls: "news-pick" });
      this.glyph(row, "link-2");
      const text = row.createSpan({ cls: "news-pick-text" });
      text.createSpan({ cls: "news-pick-title", text: item.title });
      text.createSpan({ cls: "news-pick-reason", text: newsReasonText(this.relevance.get(item.id)!.reason, this.english) });
      row.onclick = () => this.reveal(feed, item.id);
    }
  }
  private renderSkeleton(grid: HTMLElement): void {
    const bar = (parent: HTMLElement, width: 30 | 40 | 55 | 70 | 85 | 100, cls = "") => parent.createDiv({ cls: `news-skeleton is-w${width} ${cls}`.trim() });
    const main = grid.createDiv({ cls: "news-main", attr: { "aria-hidden": "true" } });
    const lead = main.createDiv({ cls: "news-lead" });
    const big = lead.createDiv({ cls: "news-lead-card is-main is-placeholder" });
    bar(big, 40); bar(big, 85, "is-tall"); bar(big, 55, "is-tall"); bar(big, 100); bar(big, 85);
    for (let i = 0; i < 2; i++) { const small = lead.createDiv({ cls: "news-lead-card is-placeholder" }); bar(small, 85); bar(small, 70); bar(small, 40); }
    for (let i = 0; i < 4; i++) {
      const row = main.createDiv({ cls: "news-item is-placeholder" });
      bar(row.createSpan({ cls: "news-item-time" }), 30);
      const body = row.createDiv({ cls: "news-item-body" }); bar(body, 70, "is-tall"); bar(body, 100); bar(body, 55);
    }
    const panel = grid.createEl("aside", { cls: "news-rail", attr: { "aria-hidden": "true" } }).createDiv({ cls: "news-panel" });
    for (let i = 0; i < 7; i++) { const row = panel.createDiv({ cls: "news-hot is-placeholder" }); row.createSpan({ cls: "news-hot-rank", text: String(i + 1) }); bar(row, ([85, 85, 70, 70, 55, 55, 40] as const)[i]); }
  }
  /** 锁定页：后面是模糊的版式骨架，中间一句话，最多一个主按钮。 */
  private renderLock(parent: HTMLElement, icon: string, title: string, text: string, action?: [string, "benefits" | "login"]): void {
    const wrap = parent.createDiv({ cls: "news-lock-wrap", attr: { "data-news": "lock" } });
    const ghost = wrap.createDiv({ cls: "news-ghost", attr: { "aria-hidden": "true", inert: "" } });
    this.renderSkeleton(ghost.createDiv({ cls: "news-grid" }));
    const card = wrap.createDiv({ cls: "news-lock" });
    this.glyph(card, icon, "news-lock-icon");
    card.createEl("h1", { text: title });
    if (text) card.createEl("p", { text });
    if (action) this.button(card, action[0], "primary", action[1] === "benefits" ? "sparkles" : null, () => this.plugin.openEchoInkAccountSettings(action[1])).dataset.news = "lock-action";
  }

  // ---------- 订阅设置（页内二级页） ----------
  private renderSubscriptions(parent: HTMLElement): void {
    const header = parent.createEl("header", { cls: "news-header" });
    const title = header.createDiv({ cls: "news-title" });
    this.button(title, this.t("返回", "Back"), "icon", "arrow-left", () => { this.page = "feed"; this.render(); this.contentEl.scrollTop = 0; this.contentEl.querySelector<HTMLElement>('[data-news="subscriptions"]')?.focus(); }).dataset.news = "back";
    title.createEl("h1", { text: this.t("订阅设置", "Feed settings") });
    const subscriptions = this.plugin.settings.news.subscriptions;
    const section = parent.createEl("section", { cls: "news-sources" });
    const head = section.createDiv({ cls: "news-section-head" });
    head.createEl("h2", { text: this.t("资讯源", "Sources") });
    head.createSpan({ cls: "news-count", text: String(subscriptions.length + 1) });
    const rows = section.createDiv({ cls: "news-rows" });
    const builtin = rows.createDiv({ cls: "news-source-row" });
    this.glyph(builtin, "server", "news-source-icon");
    const builtinText = builtin.createDiv({ cls: "news-source-text" });
    builtinText.createDiv({ text: this.t("EchoInk 资讯源", "EchoInk News") });
    builtinText.createDiv({ cls: "news-source-sub", text: this.t("AI 与科技 · 每 3 小时更新", "AI and tech · updated every 3 hours") });
    builtin.createSpan({ cls: "news-count", text: this.t("默认", "Default") });
    for (const subscription of subscriptions) {
      const row = rows.createDiv({ cls: "news-source-row", attr: { "data-news-source": subscription.url } });
      this.glyph(row, "rss", "news-source-icon");
      const text = row.createDiv({ cls: "news-source-text" });
      text.createDiv({ text: subscription.title });
      text.createDiv({ cls: "news-source-sub", text: subscription.url });
      const remove = createOriginButton(row, { cls: "news-button is-icon", attr: { "aria-label": this.t("删除资讯源", "Remove source") } });
      applyDeleteButton(remove, { iconOnly: true });
      remove.onclick = async () => {
        this.plugin.settings.news.subscriptions = subscriptions.filter(item => item.url !== subscription.url);
        this.rssItems = this.rssItems.filter(item => item.source !== subscription.title); this.deps.rss.forget();
        this.render();
        try { await this.plugin.saveSettings(); new Notice(this.t("已删除资讯源", "Source removed")); } catch (error) { new Notice(failureText(error, ["资讯源设置未能保存。", "The source settings could not be saved."], NEXT.retryLater, this.plugin.settings.settingsLanguage)); }
      };
    }
    const add = rows.createDiv({ cls: "news-source-add" });
    const field = add.createDiv({ cls: "news-field" });
    const input = createOriginInput(field, { value: this.rssDraft, attr: { type: "url", placeholder: this.t("粘贴 RSS 地址", "Paste an RSS address"), "data-news": "rss-input", "aria-label": this.t("RSS 地址", "RSS address"), ...(this.rssError ? { "aria-invalid": "true" } : {}) } });
    input.oninput = () => { this.rssDraft = input.value; };
    const submit = this.button(field, this.t("添加", "Add"), "secondary", "plus", () => this.addSubscription());
    submit.dataset.news = "rss-add";
    if (this.rssBusy) { submit.disabled = true; input.disabled = true; setAmicroButtonPending(submit, true); }
    input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void this.addSubscription(); } };
    if (this.rssError) {
      const error = add.createDiv({ cls: "news-error", attr: { role: "alert", "data-news": "rss-error" } });
      this.glyph(error, "circle-alert"); error.createSpan({ text: this.rssError });
    }
  }
  private async addSubscription(): Promise<void> {
    if (this.rssBusy) return;
    this.rssBusy = true; this.rssError = "";
    try {
      this.render();
      const added = await addRssSubscription(this.plugin.settings.news.subscriptions, this.rssDraft, this.deps.request, this.deps.now());
      this.plugin.settings.news.subscriptions = [...this.plugin.settings.news.subscriptions, added.subscription];
      await this.plugin.saveSettings();
      this.rssItems = [...this.rssItems, ...added.items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)); this.deps.rss.forget();
      this.rssDraft = "";
      new Notice(this.t("已添加，内容会出现在「我的订阅」", "Added. Items will appear in My feeds"));
    } catch (error) {
      this.rssError = error instanceof NewsRssError ? rssErrorText(error.code, this.english) : error instanceof Error ? error.message : String(error);
    } finally {
      this.rssBusy = false; this.render();
      this.contentEl.querySelector<HTMLInputElement>('[data-news="rss-input"]')?.focus();
    }
  }

  // ---------- 行操作 ----------
  /** 存到知识库收件箱下的「资讯」文件夹；同名已存在就不重复建。 */
  private async saveToInbox(item: Row, button: HTMLButtonElement): Promise<void> {
    const binding = this.plugin.settings.knowledgeBase?.folderBindings?.roles.inbox;
    if (binding && (!binding.enabled || !binding.writePath || !(this.app.vault.getAbstractFileByPath(binding.writePath) instanceof TFolder))) {
      new Notice(this.t("请先在知识库设置里选择收件箱位置。", "Choose an inbox folder in Knowledge settings first."));
      await this.plugin.openEchoInkKnowledgeSettings(); return;
    }
    button.disabled = true;
    try {
      const directory = normalizePath(`${binding?.writePath ?? "inbox"}/${this.t("资讯", "News")}`);
      let current = "";
      for (const part of directory.split("/")) {
        current = current ? `${current}/${part}` : part;
        if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current).catch(error => { if (!this.app.vault.getAbstractFileByPath(current)) throw error; });
      }
      const path = `${directory}/${newsNoteFileName(item.title)}.md`;
      if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) { new Notice(this.t(`已经存过了：${path}`, `Already saved: ${path}`)); return; }
      await this.app.vault.create(path, newsNoteContent(item, this.english));
      new Notice(this.t(`已存到 ${path}`, `Saved to ${path}`));
    } finally { if (button.isConnected) button.disabled = false; }
  }
  /** 只把提问预填进对话栏，由用户自己发送；资讯内容在提问里标明是不可信的外部资料。 */
  private async askAgent(item: NewsItem): Promise<void> {
    const agents = this.plugin.settings.agentRegistry.agents;
    const agent = agents.find(entry => entry.id === GENERALIST_AGENT_ID) ?? agents[0];
    if (!agent) { new Notice(this.t("还没有可用的 Agent。", "No Agent is available yet.")); return; }
    await this.plugin.openAgentTaskList(agent.id, newsAgentPrompt(item, this.english));
  }
}
