import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeBaseDashboardFile, KnowledgeBaseDashboardRecommendationCard, KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";

export const VIEW_TYPE_ECHOINK_HOME = "codex-echoink-home";

export type HomeFilter = "all" | "recent" | "stale" | "raw" | "wiki" | "suggested";
export type HomeSort = "relevance" | "updated" | "folder";
export type HomeFolderFilter = typeof HOME_FOLDER_ALL | string;
export type HomeCardKind = "raw" | "wiki" | "inbox" | "outputs";
type HeatmapLevel = "none" | "low" | "mid" | "high" | "bad";

export interface HomeCard {
  id: string;
  title: string;
  path: string;
  kind: HomeCardKind;
  summary: string;
  tags: string[];
  status: string;
  touchedAt: number;
}

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
export const HOME_CARD_ACTION_LABELS = ["打开", "提炼", "加入复盘"] as const;
export const HOME_CARDS_PAGE_SIZE = 24;
export const HOME_FOLDER_ALL = "all";
export const HOME_SORT_OPTIONS: ReadonlyArray<{ id: HomeSort; label: string; icon: string }> = [
  { id: "relevance", label: "按相关度", icon: "sparkles" },
  { id: "updated", label: "按更新时间", icon: "clock-3" },
  { id: "folder", label: "按文件夹", icon: "folder-tree" }
];

export class EchoInkHomeView extends ItemView {
  private snapshot: KnowledgeBaseDashboardSnapshot | null = null;
  private loading = false;
  private error = "";
  private activeFilter: HomeFilter | null = null;
  private filterTouched = false;
  private activeSort: HomeSort = "relevance";
  private activeFolderFilter: HomeFolderFilter = HOME_FOLDER_ALL;
  private visibleCardLimit = HOME_CARDS_PAGE_SIZE;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_ECHOINK_HOME;
  }

  getDisplayText(): string {
    return "EchoInk 首页";
  }

  getIcon(): string {
    return "feather";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("codex-home-view");
    this.render();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const manager = this.plugin.getKnowledgeBaseManager();
    if (!manager) {
      this.error = "知识库管理器还没有准备好。";
      this.render();
      return;
    }
    this.loading = true;
    this.error = "";
    this.render();
    try {
      this.snapshot = await manager.getDashboardSnapshot();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("codex-home-view");

    const page = contentEl.createDiv({ cls: "codex-home-page" });
    this.renderHeader(page);
    if (this.error) page.createDiv({ cls: "codex-home-error", text: this.error });
    this.renderDashboard(page);
    this.renderFeed(page);
  }

  private renderHeader(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const header = container.createDiv({ cls: "codex-home-header" });

    const brand = header.createDiv({ cls: "codex-home-brand" });
    const logo = brand.createSpan({ cls: "codex-home-logo" });
    setIcon(logo, "feather");
    brand.createEl("h1", { text: "EchoInk 首页" });

    const vault = header.createDiv({ cls: "codex-home-vault" });
    vault.createSpan({ text: snapshot?.vaultName || this.plugin.app.vault.getName?.() || "当前知识库" });
    const vaultIcon = vault.createSpan();
    setIcon(vaultIcon, "chevron-down");

    const health = header.createDiv({ cls: `codex-home-health-pill is-${snapshot?.health.status ?? "unknown"}` });
    const healthIcon = health.createSpan();
    setIcon(healthIcon, "shield-check");
    health.createSpan({ text: snapshot?.health.label ?? (this.loading ? "扫描中" : "等待") });
    health.createEl("strong", { text: snapshot ? `${snapshot.health.score}/100` : "--/100" });

    header.createDiv({
      cls: "codex-home-last-check",
      text: `最后体检：${snapshot?.checkFreshness.lastCheckAt ? formatDateTime(snapshot.checkFreshness.lastCheckAt) : "无记录"}`
    });

    const actions = header.createDiv({ cls: "codex-home-actions" });
    this.addActionButton(actions, "体检", "shield-check", () => void this.runKnowledgeMaintenance("lint"));
    this.addActionButton(actions, "维护", "wrench", () => void this.runKnowledgeMaintenance("maintain"));
    this.addActionButton(actions, "收集", "inbox", () => void this.openKnowledgeCommand("/inbox "));
    this.addActionButton(actions, "查看历史", "history", () => void this.openKnowledgeCommand("/history"));
    this.addIconButton(actions, "settings", "插件设置", () => void this.plugin.openWorkspaceResourceSettings());
  }

  private addActionButton(container: HTMLElement, label: string, iconName: string, onClick: () => void): void {
    const button = container.createEl("button", { cls: "codex-home-action", attr: { type: "button" } });
    const icon = button.createSpan({ cls: "codex-home-action-icon" });
    setIcon(icon, iconName);
    button.createSpan({ text: label });
    button.onclick = onClick;
  }

  private addIconButton(container: HTMLElement, iconName: string, label: string, onClick: (event: MouseEvent) => void, disabled = false): void {
    const button = container.createEl("button", {
      cls: "codex-home-icon-button",
      attr: { type: "button", title: label, "aria-label": label }
    });
    setIcon(button, iconName);
    button.disabled = disabled;
    button.onclick = onClick;
  }

  private renderDashboard(container: HTMLElement): void {
    const grid = container.createDiv({ cls: "codex-home-top-grid" });
    const main = grid.createDiv({ cls: "codex-home-main-column" });
    const side = grid.createDiv({ cls: "codex-home-side-column" });
    this.renderCalendar(main);
    this.renderHeatmap(main);
    this.renderTodayReview(side);
    this.renderSidePanels(side);
  }

  private renderCalendar(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const now = snapshot ? new Date(snapshot.generatedAt) : new Date();
    const section = container.createDiv({ cls: "codex-home-panel codex-home-calendar-panel" });
    const head = section.createDiv({ cls: "codex-home-section-head" });
    head.createDiv({ cls: "codex-home-section-title", text: "知识活动日历" });

    const monthNav = head.createDiv({ cls: "codex-home-month-nav" });
    const prev = monthNav.createSpan({ cls: "codex-home-nav-icon" });
    setIcon(prev, "chevron-left");
    monthNav.createSpan({ cls: "codex-home-month-label", text: `${now.getFullYear()}年${now.getMonth() + 1}月` });
    const next = monthNav.createSpan({ cls: "codex-home-nav-icon" });
    setIcon(next, "chevron-right");
    head.createSpan({ cls: "codex-home-today-chip", text: "今天" });

    const calendar = section.createDiv({ cls: "codex-home-calendar" });
    for (const day of WEEKDAYS) calendar.createDiv({ cls: "codex-home-calendar-weekday", text: day });

    const year = now.getFullYear();
    const month = now.getMonth();
    const first = new Date(year, month, 1);
    const firstOffset = (first.getDay() + 6) % 7;
    const displayOffset = firstOffset === 0 ? 7 : firstOffset;
    const statusByDay = new Map((snapshot?.checkHeatmap ?? []).map((day) => [day.date, day.status]));
    const activityByDay = new Map((snapshot?.activity?.days ?? []).map((day) => [day.date, day]));
    const todayKey = dateKeyForLocal(new Date());

    for (let index = 0; index < 42; index++) {
      const cellDate = new Date(year, month, index - displayOffset + 1);
      const dateKey = dateKeyForLocal(cellDate);
      const activityDay = activityByDay.get(dateKey);
      const status = activityDay?.status ?? statusByDay.get(dateKey) ?? "none";
      const isCurrentMonth = cellDate.getMonth() === month;
      const activity = activityDay?.total ?? 0;
      const level = activityLevel(activity, status);
      const cell = calendar.createDiv({
        cls: [
          "codex-home-calendar-cell",
          `is-${level}`,
          isCurrentMonth ? "" : "is-outside",
          dateKey === todayKey ? "is-today" : ""
        ].filter(Boolean).join(" "),
        attr: { title: `${dateKey}：${activity} 条知识活动${status === "failed" ? "，体检异常" : ""}` }
      });
      cell.createSpan({ cls: "codex-home-calendar-day", text: String(cellDate.getDate()) });
      const marker = cell.createSpan({ cls: "codex-home-calendar-marker" });
      if (activity > 0) {
        marker.createSpan({ cls: `codex-home-calendar-dot is-${level}` });
        marker.createSpan({ cls: "codex-home-calendar-count", text: String(activity) });
      }
    }

    const legend = section.createDiv({ cls: "codex-home-calendar-legend" });
    this.addLegendItem(legend, "高活动 (≥6)", "high");
    this.addLegendItem(legend, "中活动 (3-5)", "mid");
    this.addLegendItem(legend, "低活动 (1-2)", "low");
    this.addLegendItem(legend, "无活动 (0)", "none");
    this.addLegendItem(legend, "已体检", "checked");
    this.addLegendItem(legend, "待维护", "maintenance");
    this.addLegendItem(legend, "有异常", "bad");
  }

  private addLegendItem(container: HTMLElement, label: string, level: string): void {
    const item = container.createSpan({ cls: "codex-home-legend-item" });
    item.createSpan({ cls: `codex-home-legend-dot is-${level}` });
    item.createSpan({ text: label });
  }

  private renderTodayReview(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const section = container.createDiv({ cls: "codex-home-panel codex-home-review-board" });
    section.createDiv({ cls: "codex-home-section-title", text: "今日复盘" });
    const metrics = section.createDiv({ cls: "codex-home-review-metrics" });
    const todayPending = snapshot ? snapshot.raw.changedCount + snapshot.inbox.fileCount + snapshot.wiki.todayCount : 0;
    this.renderMetricCard(metrics, {
      cls: "is-orange",
      title: "今日待处理",
      value: snapshot ? String(todayPending) : "--",
      unit: "项",
      lines: [
        `${snapshot?.wiki.todayCount ?? 0} 条 Wiki 建议`,
        `${snapshot?.raw.changedCount ?? 0} 条 Raw 待处理`,
        `${Math.max(snapshot?.warnings.length ?? 0, snapshot?.checkFreshness.reasons.length ?? 0)} 条维护任务`
      ],
      icon: "file-search"
    });
    this.renderMetricCard(metrics, {
      cls: "is-blue",
      title: "Raw 待提炼",
      value: snapshot ? String(snapshot.raw.changedCount) : "--",
      unit: "条",
      lines: [`较昨日 +${snapshot?.raw.todayCount ?? 0}`],
      icon: "file-text"
    });
    this.renderMetricCard(metrics, {
      cls: "is-purple",
      title: "Inbox",
      value: snapshot ? String(snapshot.inbox.fileCount) : "--",
      unit: "条待处理",
      lines: [`较昨日 +${snapshot?.inbox.todayCount ?? 0}`],
      icon: "mail"
    });
    this.renderMetricCard(metrics, {
      cls: "is-cyan",
      title: "Wiki 今日更新",
      value: snapshot ? String(snapshot.wiki.todayCount) : "--",
      unit: "条",
      lines: [`较昨日 +${snapshot?.wiki.todayCount ?? 0}`],
      icon: "book-open"
    });
  }

  private renderMetricCard(container: HTMLElement, item: { cls: string; title: string; value: string; unit: string; lines: string[]; icon: string }): void {
    const card = container.createDiv({ cls: `codex-home-metric ${item.cls}` });
    const text = card.createDiv({ cls: "codex-home-metric-copy" });
    text.createDiv({ cls: "codex-home-metric-title", text: item.title });
    const value = text.createDiv({ cls: "codex-home-metric-value" });
    value.createSpan({ text: item.value });
    value.createEl("small", { text: item.unit });
    const list = text.createDiv({ cls: "codex-home-metric-lines" });
    for (const line of item.lines) list.createDiv({ text: line });
    const icon = card.createSpan({ cls: "codex-home-metric-icon" });
    setIcon(icon, item.icon);
  }

  private renderSidePanels(container: HTMLElement): void {
    const panels = container.createDiv({ cls: "codex-home-side-panels" });
    this.renderLatestReport(panels);
    this.renderActionLog(panels);
  }

  private renderLatestReport(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const panel = container.createDiv({ cls: "codex-home-panel codex-home-report-panel" });
    panel.createDiv({ cls: "codex-home-section-title", text: "最近维护报告" });
    const body = panel.createDiv({ cls: "codex-home-report-card" });
    body.createDiv({ cls: "codex-home-report-title", text: titleFromPath(snapshot?.outputs.latestReportPath || "暂无维护报告") });
    body.createSpan({ cls: `codex-home-report-status is-${snapshot?.lastRun.status === "success" ? "done" : "risk"}`, text: snapshot?.lastRun.status === "success" ? "已完成" : "待确认" });
    body.createDiv({ cls: "codex-home-report-line", text: `开始时间：${snapshot?.lastRun.at ? formatDateTime(snapshot.lastRun.at) : "无记录"}` });
    body.createDiv({ cls: "codex-home-report-line", text: `报告路径：${snapshot?.outputs.latestReportPath || "暂无"}` });
    const stats = body.createDiv({ cls: "codex-home-report-stats" });
    stats.createSpan({ text: `新增 ${snapshot?.raw.todayCount ?? 0}` });
    stats.createSpan({ text: `变更 ${snapshot?.raw.changedCount ?? 0}` });
    stats.createSpan({ text: `校准 ${snapshot?.raw.digestStatus.calibration ?? 0}` });
    stats.createSpan({ text: `跳过 ${snapshot?.warnings.length ?? 0}` });
    const link = panel.createEl("button", { cls: "codex-home-text-link", text: "查看完整维护报告 →", attr: { type: "button" } });
    link.onclick = () => void this.openVaultFile(snapshot?.outputs.latestReportPath || "");
  }

  private renderActionLog(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const panel = container.createDiv({ cls: "codex-home-panel codex-home-log-panel" });
    panel.createDiv({ cls: "codex-home-section-title", text: "Codex 行动日志" });
    const list = panel.createDiv({ cls: "codex-home-log-list" });
    const logs = snapshot?.activity?.logs ?? [];
    if (!logs.length) {
      this.addLogItem(list, "--:--", "等待扫描：还没有可展示的知识库行动记录。", "muted");
    } else {
      for (const log of logs) this.addLogItem(list, formatClock(log.at), `${log.label}：${log.text}`, log.tone);
    }
    panel.createEl("button", { cls: "codex-home-text-link", text: "查看全部日志 →", attr: { type: "button" } }).onclick = () => void this.openKnowledgeCommand("/history");
  }

  private addLogItem(container: HTMLElement, time: string, text: string, tone: string): void {
    const item = container.createDiv({ cls: "codex-home-log-item" });
    item.createSpan({ cls: "codex-home-log-time", text: time });
    item.createSpan({ cls: `codex-home-log-dot is-${tone}` });
    item.createSpan({ cls: "codex-home-log-text", text });
  }

  private renderHeatmap(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const section = container.createDiv({ cls: "codex-home-panel codex-home-heatmap-panel" });
    const head = section.createDiv({ cls: "codex-home-section-head" });
    head.createDiv({ cls: "codex-home-section-title", text: "年度体检热力图" });
    head.createDiv({ cls: "codex-home-section-note", text: snapshot ? `${(snapshot.checkHeatmap ?? []).filter((day) => day.status !== "none").length} 次记录` : "等待扫描" });

    const monthLabels = section.createDiv({ cls: "codex-home-heatmap-months" });
    for (const month of MONTH_LABELS) monthLabels.createSpan({ text: month });

    const rows = section.createDiv({ cls: "codex-home-heatmap-rows" });
    const heatmapRows = snapshot?.activity?.heatmapRows ?? [];
    if (heatmapRows.length) {
      for (const row of heatmapRows) this.renderHeatmapRow(rows, row.label, row.cells);
    } else {
      this.renderHeatmapRow(rows, "知识健康度");
      this.renderHeatmapRow(rows, "Wiki 变更");
      this.renderHeatmapRow(rows, "Raw 变更");
      this.renderHeatmapRow(rows, "维护完成");
    }

    const footer = section.createDiv({ cls: "codex-home-heatmap-footer" });
    footer.createEl("button", { cls: "codex-home-text-link", text: "查看完整体检报告 →", attr: { type: "button" } }).onclick = () => void this.openVaultFile(snapshot?.outputs.latestReportPath || "");
    const legend = footer.createSpan({ cls: "codex-home-heatmap-legend" });
    this.addLegendItem(legend, "高", "high");
    this.addLegendItem(legend, "中", "mid");
    this.addLegendItem(legend, "低", "low");
    this.addLegendItem(legend, "无", "none");
  }

  private renderHeatmapRow(container: HTMLElement, label: string, cellsData?: KnowledgeBaseDashboardSnapshot["activity"]["heatmapRows"][number]["cells"]): void {
    const row = container.createDiv({ cls: "codex-home-heatmap-row" });
    row.createSpan({ cls: "codex-home-heatmap-label", text: label });
    const cells = row.createSpan({ cls: "codex-home-heatmap-cells" });
    for (let index = 0; index < 52; index++) {
      const cell = cellsData?.[index];
      cells.createSpan({
        cls: `codex-home-heatmap-cell is-${cell?.level ?? "none"}`,
        attr: cell ? { title: `${cell.startDate} - ${cell.endDate}：${cell.count}` } : undefined
      });
    }
  }

  private renderFeed(container: HTMLElement): void {
    const snapshot = this.snapshot;
    const allCards = buildHomeCards(snapshot);
    const nextFilter = resolveActiveHomeFilter(this.activeFilter, this.filterTouched, allCards, Boolean(snapshot));
    if (nextFilter !== this.activeFilter) {
      this.activeFilter = nextFilter;
      this.visibleCardLimit = HOME_CARDS_PAGE_SIZE;
    }
    const activeFilter = this.activeFilter;
    const filteredCards = filterHomeCards(allCards, activeFilter);
    const folderFilters = buildHomeFolderFilterItems(filteredCards);
    if (!folderFilters.some((filter) => filter.id === this.activeFolderFilter)) this.activeFolderFilter = HOME_FOLDER_ALL;
    const cards = sortHomeCards(filterHomeCardsByFolder(filteredCards, this.activeFolderFilter), this.activeSort);
    const visibleCards = cards.slice(0, this.visibleCardLimit);
    const section = container.createDiv({ cls: "codex-home-feed" });
    const filters = section.createDiv({ cls: "codex-home-filters" });
    for (const filter of filterItems(snapshot, allCards)) {
      const button = filters.createEl("button", {
        cls: `codex-home-filter ${activeFilter === filter.id ? "is-active" : ""}`.trim(),
        attr: { type: "button" }
      });
      button.createSpan({ text: filter.label });
      button.createEl("strong", { text: String(filter.count) });
      button.onclick = () => {
        this.filterTouched = true;
        this.activeFilter = filter.id;
        this.activeFolderFilter = HOME_FOLDER_ALL;
        this.visibleCardLimit = HOME_CARDS_PAGE_SIZE;
        this.render();
      };
    }
    const activeSortOption = HOME_SORT_OPTIONS.find((option) => option.id === this.activeSort) ?? HOME_SORT_OPTIONS[0];
    const sort = filters.createEl("button", {
      cls: "codex-home-sort",
      attr: { type: "button", "aria-label": "切换卡片排序", title: "切换卡片排序" }
    });
    sort.createSpan({ text: activeSortOption.label });
    setIcon(sort.createSpan(), "chevron-down");
    sort.onclick = (event) => this.openHomeSortMenu(event);
    const activeFolder = folderFilters.find((filter) => filter.id === this.activeFolderFilter) ?? folderFilters[0];
    const folder = filters.createEl("button", {
      cls: "codex-home-folder-filter",
      attr: { type: "button", "aria-label": "文件夹筛选", title: "文件夹筛选" }
    });
    folder.createSpan({ text: activeFolder?.label ?? "全部文件夹" });
    setIcon(folder.createSpan(), "chevron-down");
    folder.onclick = (event) => this.openHomeFolderMenu(event, folderFilters);

    const grid = section.createDiv({ cls: "codex-home-card-grid" });
    if (!cards.length) {
      grid.createDiv({ cls: "codex-home-empty", text: snapshot ? "这个筛选下暂时没有卡片。" : "扫描后会展示最近 Raw、Wiki、Inbox 和输出记录。" });
      return;
    }
    for (const card of visibleCards) this.renderCard(grid, card);
    if (visibleCards.length < cards.length) {
      const more = section.createEl("button", {
        cls: "codex-home-load-more",
        text: `显示更多 ${Math.min(HOME_CARDS_PAGE_SIZE, cards.length - visibleCards.length)} 张 · 已显示 ${visibleCards.length}/${cards.length}`,
        attr: { type: "button" }
      });
      more.onclick = () => {
        this.visibleCardLimit += HOME_CARDS_PAGE_SIZE;
        this.render();
      };
    }
  }

  private renderCard(container: HTMLElement, card: HomeCard): void {
    const item = container.createDiv({ cls: `codex-home-card is-${card.kind}` });
    const head = item.createDiv({ cls: "codex-home-card-head" });
    head.createDiv({ cls: "codex-home-card-title", text: card.title });
    head.createSpan({ cls: "codex-home-card-time", text: relativeDayText(card.touchedAt) });
    item.createDiv({ cls: "codex-home-card-path", text: compactPath(card.path) });
    const tags = item.createDiv({ cls: "codex-home-card-tags" });
    for (const tag of card.tags) tags.createSpan({ cls: "codex-home-card-tag", text: tag });
    item.createDiv({ cls: "codex-home-card-summary", text: card.summary });
    const status = item.createDiv({ cls: `codex-home-card-status is-${card.kind}` });
    status.createSpan();
    status.createEl("strong", { text: card.status });
    const actions = item.createDiv({ cls: "codex-home-card-actions" });
    this.addCardAction(actions, HOME_CARD_ACTION_LABELS[0], "external-link", () => void this.openVaultFile(card.path));
    this.addCardAction(actions, HOME_CARD_ACTION_LABELS[1], "pen-line", () => void this.openRefineCommand(card));
    this.addCardAction(actions, HOME_CARD_ACTION_LABELS[2], "upload", () => void this.openReviewCommand(card));
    this.addIconButton(actions, "more-horizontal", "更多", (event) => this.openHomeCardMenu(event, card));
  }

  private addCardAction(container: HTMLElement, label: string, iconName: string, onClick: () => void): void {
    const button = container.createEl("button", { cls: "codex-home-card-action", attr: { type: "button" } });
    setIcon(button.createSpan(), iconName);
    button.createSpan({ text: label });
    button.onclick = onClick;
  }

  private async runKnowledgeMaintenance(mode: "lint" | "maintain"): Promise<void> {
    const manager = this.plugin.getKnowledgeBaseManager();
    if (!manager) {
      new Notice("知识库管理器还没有准备好");
      return;
    }
    const result = await manager.runMaintenance(mode);
    if (result.status === "success") await this.refresh();
  }

  private async openKnowledgeCommand(command: string): Promise<void> {
    await this.plugin.activateKnowledgeBaseChannel();
    this.plugin.getCodexView()?.fillKnowledgeBaseCommand(command);
  }

  private async openRefineCommand(card: HomeCard): Promise<void> {
    const command = card.kind === "raw"
      ? `/maintain 重点处理 ${card.path}`
      : `/ask 提炼这条知识卡片：${card.path}`;
    await this.openKnowledgeCommand(command);
  }

  private async openReviewCommand(card: HomeCard): Promise<void> {
    const command = `/week 复盘 ${card.path}`;
    await this.openKnowledgeCommand(command);
  }

  private openHomeCardMenu(event: MouseEvent, card: HomeCard): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("复制链接").setIsLabel(true));
    menu.addItem((item) =>
      item
        .setTitle("复制 Obsidian 内链")
        .setIcon("brackets")
        .onClick(() => void this.copyHomeCardText(homeCardObsidianLinkToCopy(card), "已复制 Obsidian 内链"))
    );
    menu.addItem((item) =>
      item
        .setTitle("复制相对路径")
        .setIcon("copy")
        .onClick(() => void this.copyHomeCardText(homeCardPathToCopy(card), "已复制相对路径"))
    );
    menu.addItem((item) =>
      item
        .setTitle("复制 Markdown 链接")
        .setIcon("link")
        .onClick(() => void this.copyHomeCardText(homeCardMarkdownLinkToCopy(card), "已复制 Markdown 链接"))
    );
    menu.showAtMouseEvent(event);
  }

  private async copyHomeCardText(text: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(successMessage);
    } catch (error) {
      new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openHomeSortMenu(event: MouseEvent): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("排序方式").setIsLabel(true));
    for (const option of HOME_SORT_OPTIONS) {
      menu.addItem((item) =>
        item
          .setTitle(option.label)
          .setIcon(option.icon)
          .setChecked(this.activeSort === option.id)
          .onClick(() => {
            this.activeSort = option.id;
            this.visibleCardLimit = HOME_CARDS_PAGE_SIZE;
            this.render();
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private openHomeFolderMenu(event: MouseEvent, folderFilters: Array<{ id: HomeFolderFilter; label: string; count: number }>): void {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("文件夹筛选").setIsLabel(true));
    for (const folder of folderFilters) {
      menu.addItem((item) =>
        item
          .setTitle(`${folder.label} (${folder.count})`)
          .setIcon(folder.id === HOME_FOLDER_ALL ? "folders" : "folder")
          .setChecked(this.activeFolderFilter === folder.id)
          .onClick(() => {
            this.activeFolderFilter = folder.id;
            this.visibleCardLimit = HOME_CARDS_PAGE_SIZE;
            this.render();
          })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private async openVaultFile(relativePath: string): Promise<void> {
    if (!relativePath) {
      new Notice("暂无可打开的文件");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(relativePath));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    new Notice(`没有在当前 Obsidian 仓库找到：${relativePath}`);
  }
}

export function buildHomeCards(snapshot: KnowledgeBaseDashboardSnapshot | null): HomeCard[] {
  if (!snapshot) return [];
  if (snapshot.recommendations?.cards?.length) {
    return snapshot.recommendations.cards.map(recommendationToHomeCard).filter((card) => !isSystemHomeCardPath(card.path));
  }
  const cards: HomeCard[] = [
    ...visibleHomeFiles(snapshot.raw.recentFiles).map((file) => fileToCard(file, "raw", snapshot)),
    ...visibleHomeFiles(snapshot.wiki.recentFiles).map((file) => fileToCard(file, "wiki", snapshot)),
    ...visibleHomeFiles(snapshot.inbox.recentFiles).map((file) => fileToCard(file, "inbox", snapshot)),
    ...visibleHomeFiles(snapshot.outputs.recentFiles).map((file) => fileToCard(file, "outputs", snapshot))
  ];
  return cards
    .sort((a, b) => b.touchedAt - a.touchedAt)
    .slice(0, 18);
}

function recommendationToHomeCard(card: KnowledgeBaseDashboardRecommendationCard): HomeCard {
  return {
    id: card.id,
    title: card.title,
    path: card.path,
    kind: card.kind,
    summary: card.summary,
    tags: card.tags,
    status: card.status,
    touchedAt: card.touchedAt
  };
}

function visibleHomeFiles(files: KnowledgeBaseDashboardFile[]): KnowledgeBaseDashboardFile[] {
  return files.filter((file) => !isSystemHomeCardPath(file.path));
}

export function isSystemHomeCardPath(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? relativePath;
  if (parts.some((part) => part.startsWith("."))) return true;
  if (basename.startsWith(".")) return true;
  if (/^(index|raw\/index|wiki\/index)\.(md|markdown|json)$/i.test(relativePath)) return true;
  if (/^(index|00-索引)\.(md|markdown)$/i.test(basename)) return true;
  if (/(\.ingest-tracker|\.raw-digest-registry)\.(md|json)$/i.test(basename)) return true;
  return false;
}

function fileToCard(file: KnowledgeBaseDashboardFile, kind: HomeCardKind, snapshot: KnowledgeBaseDashboardSnapshot): HomeCard {
  return {
    id: `${kind}:${file.path}`,
    title: titleFromPath(file.path),
    path: file.path,
    kind,
    summary: cardSummary(file, kind, snapshot),
    tags: cardTags(file.path, kind),
    status: cardStatus(file, kind, snapshot),
    touchedAt: file.mtime
  };
}

function filterItems(snapshot: KnowledgeBaseDashboardSnapshot | null, cards: HomeCard[]): Array<{ id: HomeFilter; label: string; count: number }> {
  return [
    { id: "all", label: "全部", count: cards.length },
    { id: "recent", label: "最近常看", count: filterHomeCards(cards, "recent").length },
    { id: "stale", label: "很久未看", count: filterHomeCards(cards, "stale").length },
    { id: "raw", label: "Raw 待提炼", count: filterHomeCards(cards, "raw").length },
    { id: "wiki", label: "Wiki 更新", count: filterHomeCards(cards, "wiki").length },
    { id: "suggested", label: "猜你想看", count: filterHomeCards(cards, "suggested").length }
  ];
}

export function resolveDefaultHomeFilter(cards: HomeCard[]): HomeFilter {
  if (filterHomeCards(cards, "wiki").length > 0) return "wiki";
  if (filterHomeCards(cards, "suggested").length > 0) return "suggested";
  return "all";
}

export function resolveActiveHomeFilter(current: HomeFilter | null, userSelected: boolean, cards: HomeCard[], hasSnapshot: boolean): HomeFilter {
  if (!hasSnapshot) return current ?? "all";
  if (userSelected) return current ?? resolveDefaultHomeFilter(cards);
  return resolveDefaultHomeFilter(cards);
}

export function filterHomeCards(cards: HomeCard[], filter: HomeFilter): HomeCard[] {
  if (filter === "all") return cards;
  if (filter === "recent") return cards.slice(0, 8);
  if (filter === "stale") return [...cards].sort((a, b) => a.touchedAt - b.touchedAt).slice(0, 8);
  if (filter === "raw") return cards.filter((card) => card.kind === "raw" && card.status === "Raw 待提炼");
  if (filter === "wiki") return cards.filter((card) => card.kind === "wiki" && card.status === "Wiki 更新");
  return cards.filter((card) => card.kind === "raw" || card.kind === "inbox").slice(0, 8);
}

export function homeCardPathToCopy(card: Pick<HomeCard, "path">): string {
  return card.path;
}

export function homeCardObsidianLinkToCopy(card: Pick<HomeCard, "path">): string {
  return `[[${stripMarkdownExtension(card.path)}]]`;
}

export function homeCardMarkdownLinkToCopy(card: Pick<HomeCard, "path" | "title">): string {
  return `[${escapeMarkdownLinkText(card.title)}](<${escapeMarkdownDestination(card.path)}>)`;
}

function stripMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\.(md|markdown)$/i, "");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replace(/([<>])/g, "\\$1");
}

export function buildHomeFolderFilterItems(cards: readonly HomeCard[]): Array<{ id: HomeFolderFilter; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const folder = homeCardFolderScope(card.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const folders = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "zh-Hans"))
    .map(([id, count]) => ({ id, label: id, count }));
  return [{ id: HOME_FOLDER_ALL, label: "全部文件夹", count: cards.length }, ...folders];
}

export function filterHomeCardsByFolder(cards: readonly HomeCard[], folder: HomeFolderFilter): HomeCard[] {
  if (folder === HOME_FOLDER_ALL) return [...cards];
  return cards.filter((card) => homeCardFolderScope(card.path) === folder);
}

export function sortHomeCards(cards: readonly HomeCard[], sort: HomeSort): HomeCard[] {
  if (sort === "relevance") return [...cards];
  if (sort === "updated") return [...cards].sort(compareHomeCardsByUpdated);
  return [...cards].sort((left, right) => {
    const folder = homeCardFolder(left.path).localeCompare(homeCardFolder(right.path), "zh-Hans");
    if (folder !== 0) return folder;
    return compareHomeCardsByUpdated(left, right);
  });
}

function compareHomeCardsByUpdated(left: HomeCard, right: HomeCard): number {
  return right.touchedAt - left.touchedAt || left.path.localeCompare(right.path, "zh-Hans");
}

function homeCardFolder(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index >= 0 ? relativePath.slice(0, index) : "";
}

export function homeCardFolderScope(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length >= 3) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? "根目录";
}

function cardStatus(file: KnowledgeBaseDashboardFile, kind: HomeCardKind, snapshot: KnowledgeBaseDashboardSnapshot): string {
  if (kind === "raw") {
    if (snapshot.raw.changedCount > 0) return "Raw 待提炼";
    return file.rawDigest ? "已提炼" : "待校准";
  }
  if (kind === "inbox") return "Inbox 待分流";
  if (kind === "outputs") return "维护报告";
  return "Wiki 更新";
}

function cardSummary(file: KnowledgeBaseDashboardFile, kind: HomeCardKind, snapshot: KnowledgeBaseDashboardSnapshot): string {
  if (kind === "raw") return snapshot.raw.changedCount > 0 ? "这条来源可能还没有完全沉淀到 Wiki，适合进入下一轮维护。" : "原始来源已登记，可作为后续引用和复盘依据。";
  if (kind === "wiki") return "结构化知识页，适合作为问答、复盘和关联推荐的长期依据。";
  if (kind === "inbox") return "临时收集内容，需要判断是进入 Raw、Wiki、Journal 还是项目区。";
  return "近期输出记录，可用于复盘、沉淀和追踪 Agent 工作结果。";
}

function cardTags(relativePath: string, kind: HomeCardKind): string[] {
  const parts = relativePath.split("/").filter(Boolean);
  const tags = [kindLabel(kind)];
  if (parts.length > 1) tags.push(parts[1].replace(/\.(md|markdown)$/i, ""));
  if (/reddit|github|wechat|公众号|小红书|xhs/i.test(relativePath)) tags.push("来源");
  return tags.slice(0, 3);
}

function kindLabel(kind: HomeCardKind): string {
  if (kind === "raw") return "Raw";
  if (kind === "wiki") return "Wiki";
  if (kind === "inbox") return "Inbox";
  return "Output";
}

function titleFromPath(relativePath: string): string {
  const basename = relativePath.split("/").pop() ?? relativePath;
  return basename.replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/i, "") || relativePath;
}

function compactPath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 2) return relativePath;
  return `${parts[0]}/${parts[1]}`;
}

function formatDateTime(timestamp: number): string {
  if (!timestamp) return "无记录";
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatClock(timestamp: number): string {
  if (!timestamp) return "--:--";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function relativeDayText(timestamp: number): string {
  if (!timestamp) return "未知";
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  if (days === 0) return "今天";
  if (days === 1) return "1 天前";
  if (days < 7) return `${days} 天前`;
  return `${Math.max(1, Math.floor(days / 7))} 周前`;
}

function dateKeyForLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function activityLevel(count: number, status: string): HeatmapLevel {
  if (status === "failed") return "bad";
  if (count >= 6) return "high";
  if (count >= 3) return "mid";
  if (count >= 1) return "low";
  return "none";
}
