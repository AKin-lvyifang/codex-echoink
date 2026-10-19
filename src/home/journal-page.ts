import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginPagination, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { renderActivityHeatmap } from "../settings/activity-heatmap";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { ForegroundView } from "../ui/foreground-view";
import { HomeWorkbenchDataService } from "./home-workbench-data";
import { dateKey } from "./home-workbench-model";
import { JournalTemplateModal } from "./journal-template-modal";
import { journalMonthSelection, journalPageEntries, journalStats, journalSummary, type JournalStats } from "./journal-stats";
import { renderPhotoCalendar } from "./photo-calendar";
import { readNativeJournalSettings } from "./native-journal";
import { prefillWorkbenchModule, workbenchModuleOwner } from "./module-navigation";

export const VIEW_TYPE_ECHOINK_JOURNAL = "echoink-journal";
const parseDate = (value: string) => { const [year, month, day] = value.split("-").map(Number); return new Date(year, month - 1, day, 12); };

/** Desktop journal navigation. Browsing and statistics never invoke a Provider. */
export class EchoInkJournalView extends ItemView {
  private readonly dataService: HomeWorkbenchDataService;
  private foreground: ForegroundView | null = null;
  private closed = true;
  private pending = false;
  private scheduled = false;
  private generation = 0;
  private listGeneration = 0;
  private settingsSignature = "";
  private month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private selected = dateKey(new Date());
  private mode: "month" | "year" = "month";
  private listYear = this.month.getFullYear();
  private page = 1;
  private snapshot: Awaited<ReturnType<HomeWorkbenchDataService["buildJournalRecords"]>> | null = null;
  private stats: JournalStats | null = null;
  private statsDate = "";
  private heatmapSignature = "";
  private heatmapPending = false;
  private readonly summaries = new Map<string, { mtime: number; text: string }>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.dataService = new HomeWorkbenchDataService(this.app, () => plugin.settings.journalDirectory, null, undefined, () => plugin.settings.knowledgeBase?.folderBindings);
  }
  getViewType(): string { return VIEW_TYPE_ECHOINK_JOURNAL; }
  getDisplayText(): string { return this.t("日记", "Journal"); }
  getIcon(): string { return "book-open"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-journal="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string {
    let native: unknown;
    try { native = readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory, this.plugin.settings.knowledgeBase?.folderBindings); }
    catch (error) { native = { error: String(error) }; }
    return JSON.stringify([dateKey(new Date()), this.plugin.settings.settingsLanguage, native, this.plugin.settings.knowledgeBase?.folderBindings, this.plugin.settings.agentRegistry]);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-journal-page");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => { if (active) { if (this.pending) void this.refresh(); else this.refreshIfSettingsChanged(); } });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshIfSettingsChanged()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.generation++; this.listGeneration++;
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  refreshIfSettingsChanged(): void {
    if (this.settingsSignature !== this.signature()) { this.settingsSignature = this.signature(); this.refreshLanguage(); }
  }
  refreshLanguage(): void {
    if (!this.active()) { this.pending = true; return; }
    this.renderHeader();
    if (this.snapshot && this.stats) { this.renderCalendar(); this.renderStats(); void this.renderList(); }
    void this.refresh();
  }
  private scheduleRefresh(): void {
    this.pending = true;
    if (this.scheduled || !this.active()) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.active() && this.pending) void this.refresh(); });
  }
  async refresh(): Promise<void> {
    this.pending = true;
    if (!this.active()) return;
    this.pending = false;
    const generation = ++this.generation;
    this.settingsSignature = this.signature();
    this.renderHeader();
    if (!this.snapshot) this.field("status").setText(this.t("正在读取日记…", "Reading journals…"));
    try {
      const snapshot = await this.dataService.buildJournalRecords();
      if (this.closed || generation !== this.generation) return;
      if (!this.active()) { this.pending = true; return; }
      const unchanged = this.snapshot && JSON.stringify(this.snapshot) === JSON.stringify(snapshot);
      this.snapshot = snapshot;
      if (!snapshot.settings.available) { this.showUnavailable(); return; }
      if (unchanged && this.stats && this.statsDate === dateKey(new Date())) { disposeOriginControls(this.field("status")); this.field("status").empty(); return; }
      this.stats = journalStats(snapshot.records, snapshot.settings.folder, snapshot.settings.format);
      this.statsDate = dateKey(new Date());
      disposeOriginControls(this.field("status")); this.field("status").empty(); this.field("content").hidden = false;
      this.renderCalendar(); this.renderStats(); await this.renderList();
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const status = this.field("status"); disposeOriginControls(status); status.empty();
      status.createSpan({ text: this.t("日记暂时读不到", "Journals are unavailable") + `：${error instanceof Error ? error.message : String(error)}` + (this.snapshot ? this.t(" · 尚未更新", " · Not updated") : "") });
      this.button(status, this.t("重试", "Retry"), () => this.refresh());
    }
  }
  private button(parent: HTMLElement, text: string, action: () => void | Promise<unknown>, cls = ""): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `journal-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof result.then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await result; } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    };
    return button;
  }
  private renderShell(): void {
    disposeOriginControls(this.contentEl); this.contentEl.empty();
    const inner = this.contentEl.createDiv({ cls: "journal-inner" });
    inner.createDiv({ cls: "journal-header", attr: { "data-journal": "header" } });
    inner.createDiv({ cls: "journal-status", attr: { "data-journal": "status", role: "status", "aria-live": "polite" } });
    const content = inner.createDiv({ attr: { "data-journal": "content" } }); content.hidden = true;
    const overview = content.createDiv({ cls: "journal-overview" });
    const calendar = overview.createDiv({ cls: "journal-calendar calendar" });
    const nav = calendar.createDiv({ cls: "journal-month-navigation" });
    nav.createEl("h2", { attr: { "data-journal": "month" } });
    const monthActions = nav.createDiv({ cls: "journal-month-actions" });
    this.iconButton(monthActions, "chevron-left", this.t("上个月", "Previous month"), () => this.changeMonth(-1));
    this.iconButton(monthActions, "chevron-right", this.t("下个月", "Next month"), () => this.changeMonth(1));
    calendar.createDiv({ cls: "calendar-weekdays", attr: { "data-journal": "weekdays" } });
    calendar.createDiv({ cls: "calendar-days", attr: { "data-journal": "days" } });
    calendar.createDiv({ cls: "journal-selected", attr: { "data-journal": "selected" } });
    const summary = overview.createDiv({ cls: "journal-summary" });
    summary.createDiv({ cls: "journal-stats", attr: { "data-journal": "stats" } });
    const heatmap = summary.createDiv({ cls: "journal-heatmap", attr: { "data-journal": "heatmap" } });
    heatmap.addEventListener("focusout", () => queueMicrotask(() => { if (this.heatmapPending && !this.closed) this.renderHeatmap(); }));
    const list = content.createEl("section", { cls: "journal-all" });
    list.createEl("h2", { text: this.t("全部日记", "All journals"), attr: { "data-journal": "list-title" } });
    list.createDiv({ cls: "journal-list-toolbar", attr: { "data-journal": "toolbar" } });
    list.createDiv({ cls: "journal-list", attr: { "data-journal": "list", "aria-live": "polite" } });
    list.createDiv({ cls: "journal-pagination", attr: { "data-journal": "pagination" } });
    this.renderHeader();
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "journal-title" });
      this.iconButton(title, "arrow-left", this.t("返回工作台", "Back to workbench"), () => this.plugin.activateHomeView({ keepRightSidebar: true }));
      title.createEl("h1");
      this.button(header, "", async () => { this.updateOwner(); await prefillWorkbenchModule(this.plugin, "journal", "聊聊今天"); }, "is-primary").dataset.journal = "owner";
    }
    header.querySelector("h1")!.setText(this.t("日记", "Journal"));
    this.updateOwner();
  }
  private updateOwner(): void {
    const name = workbenchModuleOwner(this.plugin, "journal").name;
    this.field("owner").setText(this.t(`和 ${name} 聊今天`, `Talk about today with ${name}`));
  }
  private iconButton(parent: HTMLElement, name: string, label: string, action: () => void | Promise<unknown>): void {
    const button = this.button(parent, "", action, "is-icon"); button.setAttribute("aria-label", label); setIcon(button, name);
  }
  private showUnavailable(): void {
    this.stats = null; this.field("content").hidden = true;
    const status = this.field("status"); disposeOriginControls(status); status.empty();
    status.createSpan({ text: this.t("请先选择日记位置", "Choose a journal location first") });
    this.button(status, this.t("设置日记位置", "Journal settings"), () => this.plugin.openEchoInkKnowledgeSettings());
  }
  private changeMonth(offset: number): void {
    this.month = new Date(this.month.getFullYear(), this.month.getMonth() + offset, 1);
    this.selected = journalMonthSelection(this.month, this.selected); this.page = 1;
    if (this.mode === "month") this.listYear = this.month.getFullYear();
    this.renderCalendar(); if (this.mode === "month") void this.renderList();
  }
  private renderCalendar(): void {
    if (!this.snapshot || !this.stats) return;
    this.field("month").setText(new Intl.DateTimeFormat(this.plugin.settings.settingsLanguage, { year: "numeric", month: "long" }).format(this.month));
    renderPhotoCalendar({ days: this.field("days"), weekdays: this.field("weekdays"), month: this.month, selected: this.selected,
      records: this.snapshot.records, folder: this.snapshot.settings.folder, format: this.snapshot.settings.format, language: this.plugin.settings.settingsLanguage,
      activity: new Map(this.stats.days.map(day => [day.date, day.count])), onSelect: selected => { this.selected = selected; this.renderCalendar(); } });
    const selected = this.field("selected"); disposeOriginControls(selected); selected.empty();
    selected.createSpan({ text: this.selected });
    const exists = this.stats.entries.some(entry => entry.date === this.selected);
    this.button(selected, exists ? this.t("打开原文", "Open original") : this.t("写这天的日记", "Write this day's journal"), () => this.openSelected());
  }
  private renderStats(): void {
    const stats = this.field("stats"); stats.empty();
    for (const [label, value, unit] of [[this.t("连续记录", "Recording streak"), this.stats!.streak, this.t("天", "days")], [this.t("今年", "This year"), this.stats!.currentYearCount, this.t("篇", "entries")]] as const) {
      const item = stats.createDiv(); const number = item.createEl("strong", { text: String(value) }); number.createEl("small", { text: unit }); item.createSpan({ text: label });
    }
    this.renderHeatmap();
  }
  private renderHeatmap(): void {
    if (!this.stats) return;
    const host = this.field("heatmap"), signature = JSON.stringify([this.stats.days, this.plugin.settings.settingsLanguage]);
    if (signature === this.heatmapSignature) { this.heatmapPending = false; return; }
    const editor = host.querySelector<HTMLElement>(".activity-range-editor");
    if (editor && !editor.hidden || host.contains(host.ownerDocument.activeElement)) { this.heatmapPending = true; return; }
    this.heatmapPending = false; this.heatmapSignature = signature;
    disposeOriginControls(host); host.empty();
    const heading = host.createDiv({ cls: "journal-heatmap-heading" }); heading.createEl("h2", { text: this.t("日记记录", "Journal activity") });
    renderActivityHeatmap(host, heading, host, { days: this.stats.days, title: this.t("日记记录", "Journal activity"), stateKey: "journal", zh: this.plugin.settings.settingsLanguage !== "en", app: this.app,
      label: (date, count) => this.t(`${date} · ${count} 篇`, `${date} · ${count} entries`) });
  }
  private async setListMode(mode: "month" | "year"): Promise<void> {
    if (mode === "month" && this.month.getFullYear() !== this.listYear) {
      this.month = new Date(this.listYear, this.month.getMonth(), 1);
      this.selected = journalMonthSelection(this.month, this.selected);
      this.renderCalendar();
    }
    this.mode = mode;
    await this.renderList();
  }
  private async renderList(): Promise<void> {
    if (!this.stats || !this.snapshot) return;
    const generation = ++this.listGeneration, toolbar = this.field("toolbar"), list = this.field("list"), pagination = this.field("pagination");
    const scroll = list.scrollTop;
    for (const region of [toolbar, list, pagination]) { disposeOriginControls(region); region.empty(); }
    this.field("list-title").setText(this.t("全部日记", "All journals"));
    const segments = toolbar.createDiv({ cls: "journal-segments", attr: { role: "tablist", "aria-label": this.t("日记范围", "Journal range") } });
    for (const mode of ["month", "year"] as const) {
      const button = this.button(segments, mode === "month" ? this.t("按月", "By month") : this.t("按年", "By year"), () => this.setListMode(mode));
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(mode === this.mode)); button.classList.toggle("is-selected", mode === this.mode); button.tabIndex = mode === this.mode ? 0 : -1;
    }
    segments.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const mode = event.key === "Home" ? "month" : event.key === "End" ? "year" : this.mode === "month" ? "year" : "month";
      void this.setListMode(mode).then(() => this.field("toolbar").querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
    };
    const year = createOriginSelect(toolbar, { attr: { "aria-label": this.t("年份", "Year") } }, [...new Set([...this.stats.years, this.listYear])].sort((a, b) => b - a).map(year => ({ value: String(year), label: String(year) })), String(this.listYear), this.app).element;
    year.onchange = () => { this.listYear = Number(year.value); this.page = 1; if (this.mode === "month") { this.month = new Date(this.listYear, this.month.getMonth(), 1); this.selected = journalMonthSelection(this.month, this.selected); this.renderCalendar(); } void this.renderList(); };
    if (this.mode === "year") {
      const entries = this.stats.entries.filter(entry => entry.date.startsWith(`${this.listYear}-`));
      for (let month = 0; month < 12; month++) {
        const count = entries.filter(entry => Number(entry.date.slice(5, 7)) === month + 1).length;
        if (!count) continue;
        const row = this.button(list, "", () => {
          this.month = new Date(this.listYear, month, 1); this.selected = journalMonthSelection(this.month, this.selected); this.mode = "month"; this.page = 1; this.renderCalendar(); void this.renderList();
        }, "journal-month-row"); row.dataset.month = String(month + 1);
        const icon = row.createSpan({ cls: "journal-entry-lead", attr: { "aria-hidden": "true" } }); setIcon(icon, "calendar");
        row.createSpan({ cls: "journal-month-label", text: new Intl.DateTimeFormat(this.plugin.settings.settingsLanguage, { year: "numeric", month: "long" }).format(new Date(this.listYear, month, 1)) });
        row.createSpan({ cls: "journal-month-count", text: this.t(`${count} 篇`, `${count} entries`) });
        setIcon(row.createSpan({ attr: { "aria-hidden": "true" } }), "chevron-right");
      }
      if (!entries.length) list.createDiv({ cls: "journal-empty", text: this.t("这一年还没有日记", "No journals this year") });
      return;
    }
    toolbar.createSpan({ cls: "journal-list-period", text: new Intl.DateTimeFormat(this.plugin.settings.settingsLanguage, { year: "numeric", month: "long" }).format(this.month) });
    const result = journalPageEntries(this.stats.entries, this.month.getFullYear(), this.month.getMonth(), this.page); this.page = result.page;
    if (!result.total) list.createDiv({ cls: "journal-empty", text: this.t("这个月还没有日记", "No journals this month") });
    if (result.pages > 1) createOriginPagination(pagination, result.page, result.pages, page => { this.page = page; list.scrollTop = 0; void this.renderList(); });
    const reads = result.entries.map(async entry => {
      const row = this.button(list, "", () => this.openPath(entry.path), "journal-entry-row"); row.dataset.path = entry.path;
      if (entry.firstImageUrl) {
        const image = row.createEl("img", { cls: "journal-thumb", attr: { src: entry.firstImageUrl, alt: "", loading: "lazy" } }); image.onerror = () => image.remove();
      } else setIcon(row.createSpan({ cls: "journal-entry-lead", attr: { "aria-hidden": "true" } }), "book-open");
      const copy = row.createDiv({ cls: "journal-entry-copy" });
      copy.createSpan({ cls: "journal-entry-date", text: entry.date });
      if (!/^\d{1,4}(?:[-./]\d{1,4}){0,2}$/u.test(entry.title)) copy.createEl("strong", { text: entry.title });
      if (result.entries.some(other => other.path !== entry.path && other.title === entry.title)) copy.createSpan({ cls: "journal-entry-path", text: entry.path });
      const summary = copy.createSpan({ cls: "journal-entry-summary", text: this.summaries.get(entry.path)?.text ?? this.t("正在读取…", "Reading…") });
      try {
        const file = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(file instanceof TFile)) throw new Error(this.t("文件已移动或不存在", "File moved or missing"));
        const cached = this.summaries.get(entry.path);
        const text = cached?.mtime === entry.mtime ? cached.text : journalSummary(await this.app.vault.cachedRead(file));
        if (this.closed || generation !== this.listGeneration) return;
        this.summaries.set(entry.path, { mtime: entry.mtime, text }); summary.setText(text);
      } catch {
        if (!this.closed && generation === this.listGeneration) summary.setText((this.summaries.get(entry.path)?.text ?? "") + this.t(" · 尚未更新：这篇日记暂时读不到", " · Not updated: this journal is unavailable"));
      }
    });
    await Promise.all(reads);
    if (!this.closed && generation === this.listGeneration) list.scrollTop = scroll;
  }
  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(this.t("这篇日记已移动或不存在", "This journal moved or no longer exists")); await this.refresh(); return; }
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
  private async openSelected(): Promise<void> {
    const known = this.stats?.entries.find(entry => entry.date === this.selected);
    if (known) { const preferred = this.dataService.existingJournalForDate(parseDate(this.selected)); await this.openPath(preferred?.path ?? known.path); return; }
    const existing = this.dataService.existingJournalForDate(parseDate(this.selected));
    if (existing) { await this.openPath(existing.path); return; }
    new JournalTemplateModal(this.app, { service: this.dataService, customTemplates: this.dataService.listCustomTemplates(), date: parseDate(this.selected), language: this.plugin.settings.settingsLanguage,
      englishEnabled: () => this.plugin.settings.englishDiary.enabled, englishAccess: this.plugin.accountService ?? undefined,
      onEnglish: this.plugin.settings.englishDiary.enabled ? async file => { await this.plugin.englishDiary?.openDiary(file.path); } : undefined,
      onCreated: () => { void this.refresh(); } }).open();
  }
}
