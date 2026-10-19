import { ItemView, Notice, type EventRef, type WorkspaceLeaf, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginPagination, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { renderActivityHeatmap, setActivityHeatmapsActive } from "../settings/activity-heatmap";
import { EnglishExpressionBrowser } from "../english-diary/expression-view";
import { pathsOverlap } from "../english-diary/expression-search";
import type { SavedDiaryEntry } from "../english-diary/types";
import { ForegroundView } from "../ui/foreground-view";
import { workbenchModuleOwner } from "./module-navigation";
import { loadEnglishDiaryPageData, type EnglishDiaryPageData } from "./english-diary-page-data";

export const ENGLISH_DIARY_PAGE_VIEW_TYPE = "echoink-english-diary-page";
type DiaryPage = "diary" | "expressions";
let nextPageId = 0;

/** Local navigation only. Opening or preparing an action never creates a task or a diary. */
export class EnglishDiaryPageView extends ItemView {
  private readonly pageId = `${ENGLISH_DIARY_PAGE_VIEW_TYPE}-${++nextPageId}`;
  private closed = true;
  private foreground: ForegroundView | null = null;
  private releases: Array<() => void> = [];
  private generation = 0;
  private pending = true;
  private scheduled = false;
  private settingsSignature = "";
  private snapshot: EnglishDiaryPageData | null = null;
  private page: DiaryPage = "diary";
  private diaryPage = 1;
  private diaryScroll = 0;
  private pageScroll: Record<DiaryPage, number> = { diary: 0, expressions: 0 };
  private expressions: EnglishExpressionBrowser | null = null;
  private requestedExpression = "";
  private heatmapSignature = "";
  private heatmapPending = false;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) { super(leaf); }
  getViewType(): string { return ENGLISH_DIARY_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("英文日记", "English diary"); }
  getIcon(): string { return "languages"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-english-diary="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string { return JSON.stringify([new Date().toDateString(), this.plugin.settings.settingsLanguage, this.plugin.settings.englishDiary, this.plugin.settings.agentRegistry]); }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-english-diary-page", "echoink-diary-view");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => {
      this.syncActive();
      if (active) { this.subscribe(); void this.refresh(); }
      else { this.unsubscribe(); this.generation++; this.pending = true; }
    });
    this.ensureExpressions(); this.syncActive();
    if (this.active()) this.subscribe();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.generation++; this.unsubscribe(); this.syncActive();
    this.expressions?.close(); this.expressions = null;
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  private subscribe(): void {
    if (this.releases.length) return;
    const observe = (ref: EventRef) => this.releases.push(() => this.app.vault.offref(ref));
    const changed = (file: { path: string }, oldPath?: string) => {
      const relevant = (path: string) => (this.plugin.englishDiary?.api.repository.affectsExpressions?.(path) ?? true)
        || this.snapshot?.diaries.some(entry => pathsOverlap(path, entry.sourcePath) || pathsOverlap(path, entry.englishPath));
      if (relevant(file.path) || (oldPath && relevant(oldPath))) this.scheduleRefresh();
    };
    observe(this.app.vault.on("create", changed));
    observe(this.app.vault.on("modify", changed));
    observe(this.app.vault.on("delete", changed));
    observe(this.app.vault.on("rename", changed));
    const host = this.plugin.englishDiary;
    const repository = host?.api.repository.subscribe?.(() => this.scheduleRefresh());
    if (repository) this.releases.push(repository);
    if (host?.api.access) this.releases.push(host.api.access.subscribe(() => this.scheduleRefresh()));
  }
  private unsubscribe(): void { for (const release of this.releases.splice(0)) release(); }
  private scheduleRefresh(): void {
    this.pending = true;
    if (this.scheduled || !this.active()) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.pending && this.active()) void this.refresh(); });
  }
  refreshIfSettingsChanged(): void { if (this.signature() !== this.settingsSignature) this.scheduleRefresh(); }
  refreshLanguage(): void { this.refreshIfSettingsChanged(); }
  async refresh(): Promise<void> {
    this.pending = true;
    if (!this.active()) return;
    this.pending = false;
    const generation = ++this.generation;
    this.settingsSignature = this.signature(); this.renderHeader();
    if (!this.snapshot) this.field("status").setText(this.t("正在读取英文日记…", "Reading English diaries…"));
    try {
      const repository = this.plugin.englishDiary?.api.repository;
      if (!repository) throw new Error(this.t("英文日记尚未就绪", "English diary is not ready"));
      const next = await loadEnglishDiaryPageData({ repository });
      if (this.closed || generation !== this.generation || !this.active()) return;
      if (this.snapshot) {
        if (next.errors.activity) next.activity = this.snapshot.activity;
        if (next.errors.expressions) next.expressions = this.snapshot.expressions;
        if (next.errors.diaries) next.diaries = [...new Map([...this.snapshot.diaries, ...next.diaries].map(entry => [entry.id, entry])).values()];
      }
      this.snapshot = next;
      this.reset(this.field("status"));
      if (!this.plugin.settings.englishDiary.enabled) this.field("status").setText(this.t("英文日记已停用，请到设置中启用。已有文件仍可打开。", "English diary is disabled. Enable it in settings. Existing files can still be opened."));
      this.renderHeader(); this.renderMetrics(); this.renderHeatmap(); this.renderDiaries(); this.ensureExpressions();
      this.expressions?.setEntries(next.expressions, next.errors.expressions ? this.t("表达暂时读不到，请重试。已有内容尚未更新。", "Expressions cannot be read. Retry; shown content is not updated.") : "");
      this.showPage();
      if (this.requestedExpression) { const id = this.requestedExpression; this.requestedExpression = ""; await this.expressions?.openExpression(id); }
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.reset(this.field("status"));
      this.regionError(this.field("status"), this.t("暂时读不到英文日记，请重试", "English diaries cannot be read. Please retry") + `：${this.error(error)}` + (this.snapshot ? this.t(" · 尚未更新", " · Not updated") : ""));
    }
  }
  openPage(page: DiaryPage, expressionId?: string): void {
    this.pageScroll[this.page] = this.contentEl.scrollTop;
    this.page = page;
    if (expressionId) this.requestedExpression = expressionId;
    if (!this.contentEl.querySelector('[data-english-diary="diary"]')) return;
    this.showPage(); this.contentEl.scrollTop = this.pageScroll[page];
    if (expressionId && this.snapshot && this.expressions) { this.requestedExpression = ""; void this.expressions.openExpression(expressionId); }
    if (!this.snapshot && this.active()) void this.refresh();
  }
  private reset(host: HTMLElement): void { disposeOriginControls(host); host.empty(); }
  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private button(host: HTMLElement, text: string, action: () => unknown, cls = "is-tertiary"): HTMLButtonElement {
    const button = createOriginButton(host, { text, cls: `english-page-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await result; } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { new Notice(this.error(error)); }
    };
    return button;
  }
  private renderShell(): void {
    this.reset(this.contentEl);
    const inner = this.contentEl.createDiv({ cls: "english-page-inner" });
    inner.createDiv({ cls: "english-page-header", attr: { "data-english-diary": "header" } });
    inner.createDiv({ cls: "english-page-status", attr: { "data-english-diary": "status", role: "status", "aria-live": "polite" } });
    inner.createDiv({ cls: "english-page-metrics", attr: { "data-english-diary": "metrics" } });
    inner.createEl("section", { cls: "english-page-activity", attr: { "data-english-diary": "activity" } });
    const toolbar = inner.createDiv({ cls: "english-page-toolbar" });
    const tabs = toolbar.createDiv({ cls: "english-page-tabs", attr: { role: "tablist", "aria-label": this.t("英文日记内容", "English diary content") } });
    tabs.createSpan({ cls: "english-page-tab-indicator", attr: { "aria-hidden": "true" } });
    for (const [page, zh, en] of [["diary", "日记", "Diaries"], ["expressions", "表达库", "Expressions"]] as const) {
      const tab = this.button(tabs, this.t(zh, en), () => this.openPage(page));
      tab.dataset.englishDiary = `tab-${page}`; tab.id = `${this.pageId}-${page}-tab`;
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `${this.pageId}-${page}`);
      tab.onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? "diary" : event.key === "End" ? "expressions" : this.page === "diary" ? "expressions" : "diary";
        this.openPage(next); this.field(`tab-${next}`).focus();
      };
    }
    this.button(toolbar, this.t("新建英文日记", "New English diary"), () => this.prepareToday(), "is-secondary").dataset.englishDiary = "new";
    for (const page of ["diary", "expressions"] as const) inner.createEl("section", { cls: `english-page-${page}`, attr: { "data-english-diary": page, role: "tabpanel", id: `${this.pageId}-${page}`, "aria-labelledby": `${this.pageId}-${page}-tab` } });
    this.field("activity").addEventListener("focusout", () => queueMicrotask(() => { if (this.heatmapPending && !this.closed) this.renderHeatmap(); }));
    this.renderHeader(); this.showPage();
  }
  private ensureExpressions(): void {
    if (this.expressions || !this.plugin.englishDiary) return;
    this.expressions = new EnglishExpressionBrowser(this.app, this.field("expressions"), this.plugin.englishDiary, { embedded: true, managed: true, onChanged: () => this.scheduleRefresh() });
    this.expressions.mount(this.active() && this.page === "expressions");
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "english-page-title" });
      const back = this.button(title, "", () => this.plugin.activateHomeView({ keepRightSidebar: true }), "is-icon");
      back.setAttribute("aria-label", this.t("返回工作台", "Back to workbench")); setIcon(back, "arrow-left"); title.createEl("h1");
      header.createSpan({ cls: "english-page-note", attr: { "data-english-diary": "review-reason" } });
      this.button(header, "", () => this.reviewExpressions(), "is-primary").dataset.englishDiary = "owner";
    }
    header.querySelector("h1")!.setText(this.getDisplayText());
    header.querySelector(".is-icon")?.setAttribute("aria-label", this.t("返回工作台", "Back to workbench"));
    const owner = workbenchModuleOwner(this.plugin, "english-diary");
    const review = this.field("owner") as HTMLButtonElement;
    review.setText(this.t(`交给 ${owner.name} 复习表达`, `Ask ${owner.name} to review expressions`));
    review.disabled = !this.snapshot?.expressions.length || !this.plugin.settings.englishDiary.enabled;
    review.title = !this.snapshot?.expressions.length ? this.t("还没有可复习的表达", "No expressions to review yet") : "";
    const reason = this.field("review-reason");
    reason.setText(this.snapshot && !this.snapshot.expressions.length && !this.snapshot.errors.expressions ? this.t("还没有可复习的表达", "No expressions to review yet") : "");
    reason.hidden = !reason.textContent;
    if (this.contentEl.querySelector('[data-english-diary="tab-diary"]')) {
      this.field("tab-diary").parentElement?.setAttribute("aria-label", this.t("英文日记内容", "English diary content"));
      this.field("tab-diary").setText(this.t("日记", "Diaries")); this.field("tab-expressions").setText(this.t("表达库", "Expressions"));
      this.field("new").setText(this.t("新建英文日记", "New English diary"));
      (this.field("new") as HTMLButtonElement).disabled = !this.plugin.settings.englishDiary.enabled;
    }
  }
  private renderMetrics(): void {
    const host = this.field("metrics"); this.reset(host); const data = this.snapshot!;
    for (const [zh, en, value, unit, englishUnit] of [["连续打卡", "Current streak", data.streak, "天", "days"], ["收录表达", "Saved expressions", data.expressionCount, "个", "expressions"], ["英文日记", "English diaries", data.diaryCount, "篇", "diaries"]] as const) {
      const item = host.createDiv({ cls: "english-page-metric" }); item.createSpan({ text: this.t(zh, en) });
      const number = item.createDiv({ cls: "english-page-metric-number" }); number.createEl("strong", { text: value === null ? "—" : String(value) }); number.createSpan({ text: this.t(unit, englishUnit) });
    }
  }
  private regionError(host: HTMLElement, message?: string): void {
    if (!message) return;
    const error = host.createDiv({ cls: "english-page-error", attr: { role: "status" } }); error.createSpan({ text: message });
    this.button(error, this.t("重试", "Retry"), () => this.refresh());
  }
  private renderHeatmap(): void {
    const data = this.snapshot; if (!data) return;
    const host = this.field("activity");
    const signature = JSON.stringify([data.activity, data.errors.activity, this.plugin.settings.settingsLanguage]);
    if (signature === this.heatmapSignature) { this.heatmapPending = false; return; }
    const editor = host.querySelector<HTMLElement>(".activity-range-editor");
    if ((editor && !editor.hidden) || host.contains(host.ownerDocument.activeElement)) { this.heatmapPending = true; return; }
    this.heatmapPending = false; this.heatmapSignature = signature; this.reset(host);
    const heading = host.createDiv({ cls: "english-page-heading" }); heading.createEl("h2", { text: this.t("日记足迹", "Diary activity") });
    const byDate = new Map(data.activity.map(day => [day.date, day]));
    if (!data.errors.activity || data.activity.length) renderActivityHeatmap(host, heading, host, {
      days: data.activity.map(day => ({ date: day.date, count: day.expressionCount })), thresholds: [6, 11], zh: this.plugin.settings.settingsLanguage !== "en", stateKey: "diaryActivity", app: this.app,
      title: this.t("日记足迹", "Diary activity"), label: (date, count) => this.t(`${date} · ${count} 个表达 · 生成 ${byDate.get(date)?.generationCount ?? 0} 次`, `${date} · ${count} expressions · ${byDate.get(date)?.generationCount ?? 0} generations`),
      summary: days => this.t(`生成 ${days.reduce((sum, day) => sum + (day.count ?? 0), 0)} 个表达 · 打卡 ${days.filter(day => (byDate.get(day.date)?.generationCount ?? 0) > 0).length} 天`, `${days.reduce((sum, day) => sum + (day.count ?? 0), 0)} generated expressions · ${days.filter(day => (byDate.get(day.date)?.generationCount ?? 0) > 0).length} active days`)
    });
    this.regionError(host, data.errors.activity ? this.t("日记足迹暂时读不到，请重试。已有内容尚未更新。", "Diary activity cannot be read. Retry; shown content is not updated.") : "");
    this.syncActive();
  }
  private renderDiaries(): void {
    const host = this.field("diary"), previous = host.querySelector<HTMLElement>(".english-page-diary-list");
    if (previous) this.diaryScroll = previous.scrollTop;
    this.reset(host); const data = this.snapshot!;
    this.regionError(host, data.errors.diaries ? this.t("部分英文日记暂时读不到，请重试。列表尚未完整更新。", "Some English diaries cannot be read. Retry; this list is not fully updated.") : "");
    if (!data.diaries.length) { host.createDiv({ cls: "english-page-empty", text: data.errors.diaries ? this.t("暂时读不到英文日记", "English diaries are unavailable") : this.t("还没有英文日记", "No English diaries yet") }); return; }
    const pages = Math.max(1, Math.ceil(data.diaries.length / 20)); this.diaryPage = Math.min(this.diaryPage, pages);
    const list = host.createDiv({ cls: "english-page-diary-list" });
    for (const entry of data.diaries.slice((this.diaryPage - 1) * 20, this.diaryPage * 20)) {
      const row = this.button(list, "", () => this.openDiary(entry), "is-tertiary english-page-diary-row"); row.dataset.diaryId = entry.id;
      row.disabled = entry.missingSource && entry.missingEnglish;
      const copy = row.createSpan({ cls: "english-page-row-copy" });
      copy.createEl("strong", { text: entry.date || entry.title });
      if (entry.preview) copy.createSpan({ cls: "english-page-preview", text: entry.preview, attr: { lang: "en" } });
      const metadata = row.createSpan({ cls: "english-page-row-meta" });
      metadata.createSpan({ cls: "english-page-count", text: this.t(`${entry.expressionCount} 个表达`, `${entry.expressionCount} expressions`) });
      const warnings = [entry.missingSource && this.t("原稿找不到了", "Original draft not found"), entry.missingEnglish && this.t("英文文件找不到了", "English file not found"), entry.sourceChanged && this.t("原稿有更新", "Original draft changed"), entry.englishModified && this.t("英文稿有手工修改", "English draft was edited")].filter(Boolean);
      if (warnings.length) metadata.createSpan({ cls: "english-page-note", text: warnings.join(" · ") });
      setIcon(row.createSpan({ cls: "english-page-row-arrow", attr: { "aria-hidden": "true" } }), "chevron-right");
    }
    list.scrollTop = this.diaryScroll;
    const pagination = host.createDiv({ cls: "english-page-pagination" });
    pagination.createSpan({ text: this.t(`${this.diaryPage} / ${pages} 页 · 每页 20 条`, `${this.diaryPage} / ${pages} pages · 20 per page`) });
    createOriginPagination(pagination, this.diaryPage, pages, page => { this.diaryPage = page; this.diaryScroll = 0; list.scrollTop = 0; this.renderDiaries(); });
  }
  private async openDiary(entry: SavedDiaryEntry): Promise<void> {
    const host = this.plugin.englishDiary; if (!host) return;
    if (entry.missingSource || !this.plugin.settings.englishDiary.enabled) {
      await host.openFile(!entry.missingEnglish ? entry.englishPath : entry.sourcePath); return;
    }
    await host.openDiary(entry.sourcePath);
  }
  private showPage(): void {
    for (const page of ["diary", "expressions"] as const) {
      this.field(page).hidden = page !== this.page;
      const tab = this.field(`tab-${page}`); tab.setAttribute("aria-selected", String(page === this.page)); tab.tabIndex = page === this.page ? 0 : -1;
    }
    const tabs = this.field("tab-diary").parentElement!; tabs.dataset.selected = this.page;
    this.field("new").hidden = this.page !== "diary";
    this.syncActive();
  }
  private syncActive(): void { setActivityHeatmapsActive(this.contentEl, this.active()); this.expressions?.setActive(this.active() && this.page === "expressions"); }
  private async reviewExpressions(): Promise<void> {
    if (!this.snapshot?.expressions.length || !this.plugin.settings.englishDiary.enabled) return;
    const owner = workbenchModuleOwner(this.plugin, "english-diary");
    const settings = this.plugin.settings.englishDiary;
    const paths = [...new Set([settings.expressionDirectory, ...(settings.legacyExpressionDirectories ?? [])].filter(Boolean))];
    if (!paths.length) throw new Error(this.t("表达库位置尚未配置", "Expression library location is not configured"));
    const text = this.t("用最近收录的表达考考我。只读取以下表达库范围，不读取原始日记，也不生成或改写英文日记：", "Quiz me on recently saved expressions. Read only these expression library locations; do not read original diaries or generate or rewrite English diaries:") + "\n" + paths.map(path => `- ${path}`).join("\n");
    const opened = await this.plugin.openAgentTaskList(owner.id, text);
    if (!opened) new Notice(this.t("已打开任务列表，原有草稿已保留", "Task list opened; the existing draft was kept"));
  }
  private async prepareToday(): Promise<void> {
    const today = await this.plugin.prepareEnglishDiaryNavigationToday();
    const host = this.field("status"); this.reset(host);
    if (!today.hasContent) {
      host.createSpan({ text: this.t("今天的原稿还没写好", "Today's original draft is not ready") });
      this.button(host, this.t("先写今天的原稿", "Write today's original draft"), () => this.plugin.englishDiary?.openToday(), "is-secondary"); return;
    }
    if (today.hasResult) {
      host.createSpan({ text: this.t("今天已有英文日记", "Today's English diary already exists") });
      this.button(host, this.t("打开英文日记", "Open English diary"), () => this.plugin.englishDiary?.openDiary(today.path), "is-secondary");
      this.button(host, this.t("继续交给负责人", "Continue with the owner"), () => this.prefillToday(today.path), "is-secondary"); return;
    }
    await this.prefillToday(today.path);
  }
  private async prefillToday(path: string): Promise<void> {
    const opened = await this.plugin.prefillEnglishDiaryTask(path);
    if (!opened) new Notice(this.t("已打开任务列表，原有草稿已保留", "Task list opened; the existing draft was kept"));
  }
}
