import { ItemView, Notice, TFile, TFolder, setIcon, type EventRef, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginPagination, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { renderActivityHeatmap, setActivityHeatmapsActive } from "../settings/activity-heatmap";
import { renderSettingsKnowledgeDashboard } from "../settings/knowledge-dashboard";
import { knowledgeMaintenanceHistoryTitle, knowledgeMaintenanceHistoryDescription, knowledgeMaintenanceHistoryStatus, renderKnowledgeMaintenanceHistoryList, renderKnowledgeMaintenanceRecordDetail, openKnowledgeMaintenancePath } from "../settings/knowledge-maintenance-history";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { ForegroundView } from "../ui/foreground-view";
import { loadKnowledgePageData, type KnowledgePageSnapshot } from "./knowledge-page-data";
import { getWorkbenchDataService } from "./workbench-data";
import { prefillWorkbenchModule, workbenchModuleOwner } from "./module-navigation";
import { openObsidianFolderGraphLeaf } from "./open-native-graph";

export const KNOWLEDGE_PAGE_VIEW_TYPE = "echoink-knowledge-page";
type Page = "overview" | "health" | "history";
type Issue = "isolated" | "sources";

/** Desktop read-only knowledge surface. Every handoff is a draft, never an execution. */
export class KnowledgePageView extends ItemView {
  private closed = true;
  private foreground: ForegroundView | null = null;
  private releases: Array<() => void> = [];
  private generation = 0;
  private pending = true;
  private scheduled = false;
  private settingsSignature = "";
  private snapshot: KnowledgePageSnapshot | null = null;
  private page: Page = "overview";
  private issue: Issue | null = null;
  private issuePage = 1;
  private detail: KnowledgeMaintenanceRecord | null = null;
  private detailBack: Page = "history";
  private historyState = { date: "", page: 1, listScroll: 0 };
  private secondaryCleanup: (() => void) | null = null;
  private expanded = new Set<string>();
  private heatmapSignature = "";
  private heatmapPending = false;
  private healthSignature = "";
  private healthExpanded = true;
  private overviewScroll = 0;
  private pendingIssue: Issue | null = null;
  private healthDataset: Record<string, string> = {};
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) { super(leaf); }
  getViewType(): string { return KNOWLEDGE_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("知识库", "Knowledge"); }
  getIcon(): string { return "library"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-knowledge="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string { return JSON.stringify([new Date().toDateString(), this.plugin.settings.settingsLanguage, this.plugin.settings.knowledgeBase, this.plugin.settings.agentRegistry]); }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-knowledge-page");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => {
      if (active) { this.syncHeatmaps(); this.subscribe(); void this.refresh(); }
      else { this.syncHeatmaps(); this.unsubscribe(); this.generation++; this.pending = true; }
    });
    if (this.active()) this.subscribe();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.syncHeatmaps(); this.generation++; this.unsubscribe();
    this.secondaryCleanup?.(); this.secondaryCleanup = null;
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  private subscribe(): void {
    if (this.releases.length) return;
    const observe = (host: { offref(ref: EventRef): void }, ref: EventRef) => this.releases.push(() => host.offref(ref));
    observe(this.app.vault, this.app.vault.on("create", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("delete", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("rename", () => this.scheduleRefresh()));
    observe(this.app.vault, this.app.vault.on("modify", () => this.scheduleRefresh()));
    observe(this.app.metadataCache, this.app.metadataCache.on("resolved", () => this.scheduleRefresh()));
    observe(this.app.metadataCache, this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    this.releases.push(getWorkbenchDataService(this.plugin).subscribe(() => this.scheduleRefresh()));
  }
  private unsubscribe(): void { for (const release of this.releases.splice(0)) release(); }
  private scheduleRefresh(): void {
    this.pending = true;
    if (this.scheduled || !this.active()) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.pending && this.active()) void this.refresh(); });
  }
  refreshIfSettingsChanged(): void { if (this.signature() !== this.settingsSignature) { this.pending = true; if (this.active()) void this.refresh(); } }
  refreshLanguage(): void { this.heatmapSignature = ""; this.healthSignature = ""; this.refreshIfSettingsChanged(); }
  private loadSnapshot(): Promise<KnowledgePageSnapshot> { return loadKnowledgePageData(this.plugin, bindings => getWorkbenchDataService(this.plugin).loadKnowledgeLinkHealth(bindings)); }
  async refresh(): Promise<void> {
    this.pending = true;
    if (!this.active()) return;
    this.pending = false;
    const generation = ++this.generation;
    this.settingsSignature = this.signature(); this.renderHeader();
    if (!this.snapshot) this.field("status").setText(this.t("正在读取知识库…", "Reading knowledge…"));
    try {
      const next = await this.loadSnapshot();
      if (this.closed || generation !== this.generation || !this.active()) return;
      this.snapshot = next;
      this.reset(this.field("status")); this.renderOverview(); this.renderSecondary();
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const status = this.field("status"); this.reset(status);
      status.createSpan({ text: this.t("知识库状态暂时读不到", "Knowledge is unavailable") + `：${this.error(error)}` + (this.snapshot ? this.t(" · 尚未更新", " · Not updated") : "") });
      this.button(status, this.t("重试", "Retry"), () => this.refresh());
    }
  }
  openPage(page: Page): void {
    if (this.page === "overview" && !this.issue && !this.detail && page !== "overview") this.overviewScroll = this.contentEl.scrollTop;
    this.page = page; this.issue = null; this.detail = null;
    if (!this.contentEl.querySelector('[data-knowledge="overview"]')) return;
    this.showPage(); this.renderSecondary();
    if (this.active() && !this.snapshot) void this.refresh();
  }
  private reset(host: HTMLElement): void { disposeOriginControls(host); host.empty(); }
  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private button(host: HTMLElement, text: string, action: () => unknown, cls = "is-tertiary"): HTMLButtonElement {
    const button = createOriginButton(host, { text, cls: `knowledge-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await Promise.resolve(result); } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { new Notice(this.error(error)); }
    };
    return button;
  }
  private renderIcon(host: HTMLElement, name: string): void { setIcon(host.createSpan({ cls: "knowledge-icon", attr: { "aria-hidden": "true" } }), name); }
  private renderShell(): void {
    this.reset(this.contentEl);
    const inner = this.contentEl.createDiv({ cls: "knowledge-inner" });
    inner.createDiv({ cls: "knowledge-status", attr: { "data-knowledge": "status", role: "status", "aria-live": "polite" } });
    const overview = inner.createDiv({ attr: { "data-knowledge": "overview" } });
    overview.createDiv({ cls: "knowledge-header", attr: { "data-knowledge": "header" } });
    overview.createDiv({ cls: "knowledge-metrics", attr: { "data-knowledge": "metrics" } });
    for (const name of ["activity", "directories", "issues", "recent"]) overview.createEl("section", { cls: `knowledge-${name}`, attr: { "data-knowledge": name } });
    inner.createDiv({ attr: { "data-knowledge": "secondary" } });
    this.field("activity").addEventListener("focusout", () => queueMicrotask(() => { if (this.heatmapPending && !this.closed) this.renderHeatmap(); }));
    this.renderHeader(); this.showPage();
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "knowledge-title" });
      const back = this.button(title, "", () => this.plugin.activateHomeView({ keepRightSidebar: true }), "is-icon");
      back.setAttribute("aria-label", this.t("返回工作台", "Back to workbench")); setIcon(back, "arrow-left"); title.createEl("h1");
      this.button(header, "", () => prefillWorkbenchModule(this.plugin, "knowledge-base", this.t("帮我看看知识库里有哪些值得整理的内容", "Help me review what is worth organizing in my knowledge base")), "is-primary").dataset.knowledge = "owner";
    }
    header.querySelector("h1")!.setText(this.t("知识库", "Knowledge"));
    const owner = workbenchModuleOwner(this.plugin, "knowledge-base").name;
    this.field("owner").setText(this.t(`交给 ${owner}`, `Ask ${owner}`));
  }
  private heading(host: HTMLElement, title: string): HTMLElement { const heading = host.createDiv({ cls: "knowledge-heading" }); heading.createEl("h2", { text: title }); return heading; }
  private regionError(host: HTMLElement, message?: string): void {
    if (!message) return;
    const error = host.createDiv({ cls: "knowledge-error", attr: { role: "status" } }); error.createSpan({ text: message });
    this.button(error, this.t("重试", "Retry"), () => this.refresh());
  }
  private renderOverview(): void {
    const data = this.snapshot!; const metrics = this.field("metrics"); this.reset(metrics);
    const health = data.health;
    const available = health && ["local-structure", "limited"].includes(health.assessment);
    for (const [label, value, unit] of [
      [this.t("知识健康", "Knowledge health"), available ? health.score : null, ""],
      [this.t("本周新增", "Added this week"), data.weekly.added, this.t("篇", "notes")],
      [this.t("本周整理", "Organized this week"), data.weekly.organized, this.t("次", "batches")]
    ] as const) {
      const item = metrics.createDiv({ cls: "knowledge-metric" }); item.createSpan({ text: label });
      const number = item.createDiv({ cls: "knowledge-metric-number" }); number.createEl("strong", { text: value === null ? "—" : String(value) }); if (unit) number.createSpan({ text: unit });
      if (label === this.t("知识健康", "Knowledge health")) {
        this.button(item, this.t("评分说明", "Score details"), () => this.openPage("health"));
        if (!available || health?.assessment === "limited") item.createSpan({ cls: "knowledge-note", text: health?.assessment === "uninitialized" ? this.t("未初始化", "Not initialized") : available ? this.t("检查不完整", "Limited coverage") : this.t("暂无法评估", "Unavailable") });
      }
    }
    this.renderHeatmap(); this.renderDirectories(); this.renderIssues(); this.renderRecent();
  }
  private renderHeatmap(): void {
    const data = this.snapshot; if (!data) return;
    const host = this.field("activity");
    const signature = JSON.stringify([data.activityDays, data.errors.activity, data.weekly.unknownCreatedAtCount, this.plugin.settings.settingsLanguage]);
    if (signature === this.heatmapSignature) { this.heatmapPending = false; return; }
    const editor = host.querySelector<HTMLElement>(".activity-range-editor");
    if ((editor && !editor.hidden) || host.contains(host.ownerDocument.activeElement)) { this.heatmapPending = true; return; }
    this.heatmapPending = false; this.heatmapSignature = signature; this.reset(host);
    const heading = this.heading(host, this.t("新增与整理", "Additions and organization"));
    const byDate = new Map(data.activityDays.map(day => [day.date, day]));
    const label = (date: string) => { const day = byDate.get(date); return this.t(`${date} · 新增${day?.added ?? 0}篇 · 整理${day?.organized ?? 0}次`, `${date} · ${day?.added ?? 0} added notes · ${day?.organized ?? 0} organized batches`); };
    if (!data.errors.activity) renderActivityHeatmap(host, heading, host, { days: data.activityDays.map(day => ({ date: day.date, count: day.total, label: label(day.date) })), title: this.t("新增与整理", "Additions and organization"), stateKey: "knowledgeActivity", zh: this.plugin.settings.settingsLanguage !== "en", app: this.app, label,
      summary: days => { const records = days.map(day => byDate.get(day.date)); const added = records.reduce((sum, day) => sum + (day?.added ?? 0), 0), organized = records.reduce((sum, day) => sum + (day?.organized ?? 0), 0); return this.t(`新增 ${added} 篇 · 整理 ${organized} 次`, `${added} added notes · ${organized} organized batches`); } });
    this.regionError(host, data.errors.activity);
    if (data.weekly.unknownCreatedAtCount) host.createDiv({ cls: "knowledge-note", text: this.t("部分文件创建时间未知", "Some file creation dates are unknown") });
    const rules = host.createEl("details", { cls: "knowledge-rules" }); rules.createEl("summary", { text: this.t("统计口径", "How counts work") });
    rules.createEl("p", { text: this.t("新增按知识成果文件的创建时间统计，复制或同步可能改变该时间；整理只计算正式维护中完成或核实无需改动的批次。", "Additions use knowledge file creation dates, which copying or syncing may change. Organization counts completed or verified no-change maintenance batches only.") });
  }
  private roleLabel(role: string): string { const names: Record<string, [string, string]> = { raw: ["资料来源", "Sources"], wiki: ["知识成果", "Knowledge"], projects: ["项目", "Projects"], inbox: ["收件箱", "Inbox"] }; return this.t(...names[role]); }
  private directoryState(state: string): string {
    const labels: Record<string, [string, string]> = { disabled: ["未启用", "Disabled"], unbound: ["尚未设置知识库位置", "No location configured"], invalid: ["位置已失效", "Location is unavailable"], unavailable: ["位置暂时读不到", "Location cannot be read"], partial: ["部分位置尚未更新", "Some locations are not updated"] };
    return labels[state] ? this.t(...labels[state]) : "";
  }
  private renderDirectories(): void {
    const host = this.field("directories"); this.reset(host);
    const heading = this.heading(host, this.t("目录", "Folders"));
    this.button(heading, this.t("打开图谱", "Open graph"), () => this.openGraph(), "is-secondary");
    const list = host.createDiv({ cls: "knowledge-directory-list" });
    for (const directory of this.snapshot!.directories) {
      const group = list.createDiv({ cls: "knowledge-directory-group" });
      const multiple = directory.roots.length > 1;
      const row = this.button(group, "", async () => {
        if (multiple) { if (this.expanded.has(directory.role)) this.expanded.delete(directory.role); else this.expanded.add(directory.role); this.renderDirectories(); this.field("directories").querySelector<HTMLButtonElement>(`[data-role="${directory.role}"]`)?.focus(); }
        else if (["ready", "partial"].includes(directory.roots[0]?.state ?? "")) await this.openFolder(directory.roots[0].path);
        else await this.plugin.openEchoInkKnowledgeSettings();
      }, "is-tertiary knowledge-directory-row");
      row.dataset.role = directory.role;
      if (multiple) row.setAttribute("aria-expanded", String(this.expanded.has(directory.role)));
      this.renderIcon(row, multiple ? this.expanded.has(directory.role) ? "chevron-down" : "chevron-right" : "folder");
      const copy = row.createDiv({ cls: "knowledge-row-copy" }); copy.createEl("strong", { text: this.roleLabel(directory.role) });
      copy.createSpan({ cls: "knowledge-note", text: multiple ? directory.roots.map(root => root.path).join(" · ") : directory.roots[0]?.path ?? this.directoryState(directory.state) });
      if (directory.state !== "ready" && directory.roots.length) copy.createSpan({ cls: "knowledge-note", text: this.directoryState(directory.state) });
      const figures = row.createDiv({ cls: "knowledge-directory-figures" });
      figures.createSpan({ cls: "knowledge-count", text: directory.count === null ? "—" : `${directory.count} ${this.plugin.settings.settingsLanguage === "en" ? ({ raw: "files", wiki: "notes", projects: "projects", inbox: "items" }[directory.role]) : directory.unit}` });
      figures.createSpan({ cls: "knowledge-note", text: directory.latestMtime ? this.t("最近更新 ", "Updated ") + this.time(directory.latestMtime) : this.t("暂无记录", "No record") });
      if (!multiple) {
        if (["ready", "partial"].includes(directory.roots[0]?.state ?? "")) this.renderIcon(row, "chevron-right");
        else row.createSpan({ cls: "knowledge-note", text: this.t("去设置", "Settings") });
      }
      if (multiple && this.expanded.has(directory.role)) {
        const roots = group.createDiv({ cls: "knowledge-directory-roots" });
        for (const root of directory.roots) {
          const entry = this.button(roots, "", () => ["ready", "partial"].includes(root.state) ? this.openFolder(root.path) : this.plugin.openEchoInkKnowledgeSettings(), "is-tertiary knowledge-root-row");
          entry.createSpan({ text: root.path }); entry.createSpan({ cls: "knowledge-note", text: root.state === "ready" ? root.count === null ? "—" : String(root.count) : root.error || this.directoryState(root.state) });
        }
      }
    }
    this.regionError(host, this.snapshot!.errors.directories);
  }
  private async openFolder(path: string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(path);
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf?.view as { revealInFolder?: (folder: TFolder) => unknown } | undefined;
    if (!(folder instanceof TFolder) || !leaf || !view?.revealInFolder) throw new Error(this.t(`无法在文件列表中打开目录：${path}，请启用文件列表并核对位置。`, `Cannot reveal folder: ${path}. Enable the file explorer and check its location.`));
    await view.revealInFolder(folder); await this.app.workspace.revealLeaf(leaf);
  }
  private async openGraph(): Promise<void> {
    const signature = this.signature();
    const next = await this.loadSnapshot();
    if (this.closed) return;
    if (signature !== this.signature()) { await this.refresh(); throw new Error(this.t("目录位置已更新，请重试", "Folder locations changed. Retry.")); }
    const roots = next.directories.filter(directory => directory.role === "wiki" || directory.role === "projects").flatMap(directory => directory.roots.filter(root => ["ready", "partial"].includes(root.state)).map(root => root.path));
    if (!roots.length) { new Notice(this.t("请先在设置中选择有效的知识成果或项目位置", "Choose a valid knowledge or project folder in settings first")); return; }
    await openObsidianFolderGraphLeaf(this.app, roots, this.plugin.settings.settingsLanguage);
  }
  private issuePaths(issue: Issue, data: KnowledgePageSnapshot): string[] { return issue === "isolated" ? data.links.state === "ready" && !data.errors.links ? data.links.isolatedPaths : [] : !data.errors.sources ? data.sources.missing.map(item => item.path) : []; }
  private issueText(issue: Issue, count: number): string { return issue === "isolated" ? this.t(`${count} 篇笔记没有任何链接`, `${count} notes have no links`) : this.t(`${count} 篇知识成果的来源文件找不到了`, `Source files are missing for ${count} knowledge notes`); }
  private renderIssues(): void {
    const host = this.field("issues"); this.reset(host); this.heading(host, this.t("可以处理", "Ready to handle"));
    let count = 0;
    for (const issue of ["isolated", "sources"] as const) {
      const paths = this.issuePaths(issue, this.snapshot!); if (!paths.length) continue; count++;
      const row = host.createDiv({ cls: "knowledge-issue-row" });
      const body = this.button(row, this.issueText(issue, paths.length), () => { this.overviewScroll = this.contentEl.scrollTop; this.issue = issue; this.issuePage = 1; this.showPage(); this.renderSecondary(); }, "is-tertiary knowledge-issue-copy"); body.dataset.issue = issue;
      const handoff = this.button(row, this.t(`交给 ${workbenchModuleOwner(this.plugin, "knowledge-base").name}`, `Ask ${workbenchModuleOwner(this.plugin, "knowledge-base").name}`), () => this.handoffIssue(issue), "is-secondary"); handoff.disabled = this.pendingIssue !== null;
    }
    if (this.snapshot!.links.state !== "ready") host.createDiv({ cls: "knowledge-note", text: this.t("链接还在解析", "Links are still being resolved") });
    this.regionError(host, this.snapshot!.errors.links); this.regionError(host, this.snapshot!.errors.sources);
    if (!count && this.snapshot!.links.state === "ready" && !this.snapshot!.errors.links && !this.snapshot!.errors.sources && this.snapshot!.sources.state !== "unknown") host.createDiv({ cls: "knowledge-empty", text: this.t("暂时没有可处理的问题", "No issues to handle right now") });
    if (this.snapshot!.sources.state !== "ready") host.createDiv({ cls: "knowledge-note", text: this.t("部分来源尚无法核实", "Some sources could not be verified") });
  }
  private async handoffIssue(issue: Issue): Promise<void> {
    if (this.pendingIssue) return;
    this.pendingIssue = issue;
    try {
    const generation = ++this.generation, next = await this.loadSnapshot();
    if (this.closed || generation !== this.generation || !this.active()) return;
    this.snapshot = next; this.renderOverview(); this.renderSecondary();
    if (issue === "isolated" && (next.links.state !== "ready" || next.errors.links) || issue === "sources" && next.errors.sources) throw new Error(this.t("问题范围暂时无法核实，请重试", "Issue scope could not be verified. Retry."));
    const paths = this.issuePaths(issue, next);
    if (!paths.length) { new Notice(this.t("这条提醒已更新", "This reminder has changed")); return; }
    const prompt = issue === "isolated" ? this.t(`帮我看看这 ${paths.length} 篇没有任何链接的笔记`, `Help me review these ${paths.length} notes with no links`) : this.t(`帮我核对这 ${paths.length} 篇知识成果的来源文件`, `Help me verify the source files of these ${paths.length} knowledge notes`);
    const objects = issue === "isolated" ? paths.map(path => `- ${path}`).join("\n") : next.sources.missing.map(item => `- ${item.path}\n${item.sourcePaths.map(path => this.t(`  原来源：${path}`, `  Original source: ${path}`)).join("\n")}`).join("\n");
    await prefillWorkbenchModule(this.plugin, "knowledge-base", `${prompt}\n\n${objects}`);
    } finally { this.pendingIssue = null; if (this.active() && this.snapshot) this.renderIssues(); }
  }
  private renderRecent(): void {
    const data = this.snapshot!, host = this.field("recent"); this.reset(host);
    const heading = this.heading(host, this.t("最近整理", "Recent organization"));
    this.button(heading, this.t("查看全部", "View all"), () => this.openPage("history"));
    this.regionError(host, data.errors.history);
    if (!data.maintenanceHistory.length && !data.errors.history) host.createDiv({ cls: "knowledge-empty", text: this.t("还没有整理记录", "No organization records yet") });
    for (const entry of data.maintenanceHistory.slice(0, 5)) {
      const record = data.maintenanceRecords.find(item => item.recordId === entry.recordId);
      const row = this.button(host, "", () => {
        if (record) { this.overviewScroll = this.contentEl.scrollTop; this.detail = record; this.detailBack = "overview"; this.showPage(); this.renderSecondary(); }
        else if (entry.reportPath) return this.openPath(entry.reportPath);
        else new Notice(this.t("维护记录尚未读取或已缺失", "Maintenance record is unavailable"));
      }, "is-tertiary knowledge-recent-row");
      this.renderIcon(row, "notebook-pen");
      const copy = row.createDiv({ cls: "knowledge-row-copy" }); copy.createEl("strong", { text: knowledgeMaintenanceHistoryTitle(entry, this.plugin.settings.settingsLanguage !== "en") });
      const added = record?.result.notes.filter(note => note.operation === "created").length ?? 0;
      const updated = record?.result.notes.filter(note => note.operation === "updated").length ?? 0;
      const summary = added || updated
        ? [added ? this.t(`新增 ${added} 篇`, `${added} created`) : "", updated ? this.t(`更新 ${updated} 篇`, `${updated} updated`) : ""].filter(Boolean).join(" · ")
        : record?.summary.split(/\r?\n/u)[0].replace(/Readback/giu, this.t("回读核对", "readback"));
      copy.createSpan({ cls: "knowledge-note", text: record ? `${knowledgeMaintenanceHistoryStatus(entry, this.plugin.settings.settingsLanguage !== "en")} · ${summary}` : knowledgeMaintenanceHistoryDescription(entry, this.plugin.settings.settingsLanguage !== "en") });
    }
  }
  private time(at: number): string { return new Date(at).toLocaleString(this.plugin.settings.settingsLanguage === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
  private openPath(path: string): Promise<void> { return openKnowledgeMaintenancePath(this.app, path, this.plugin.settings.settingsLanguage !== "en"); }
  private showPage(): void {
    const wasHidden = this.field("overview").hidden;
    this.field("overview").hidden = this.page !== "overview" || !!this.issue || !!this.detail;
    const secondary = this.field("secondary");
    secondary.hidden = !this.field("overview").hidden;
    const legacy = !this.issue && (this.page === "health" || this.page === "history" || !!this.detail);
    secondary.toggleClass("echoink-settings-demo", legacy);
    secondary.toggleClass("knowledge-legacy", legacy);
    this.syncHeatmaps();
    if (wasHidden && !this.field("overview").hidden) this.contentEl.scrollTop = this.overviewScroll;
    if (!this.field("overview").hidden && this.heatmapPending) this.renderHeatmap();
  }
  private syncHeatmaps(): void {
    const overview = this.field("overview"), secondary = this.field("secondary");
    setActivityHeatmapsActive(overview, this.active() && !overview.hidden);
    setActivityHeatmapsActive(secondary, this.active() && !secondary.hidden);
  }
  private renderSecondary(): void {
    this.showPage();
    if (!this.field("overview").hidden) { this.secondaryCleanup?.(); this.secondaryCleanup = null; return; }
    const host = this.field("secondary"), data = this.snapshot;
    if (this.page === "health" && !this.issue && !this.detail) {
      const signature = JSON.stringify([data?.dashboard, data?.errors.health, this.healthExpanded, this.plugin.settings.settingsLanguage]);
      const editor = host.querySelector<HTMLElement>(".activity-range-editor");
      if (signature === this.healthSignature || editor && !editor.hidden ) return;
      this.healthSignature = signature;
    } else this.healthSignature = "";
    const oldDashboard = host.querySelector<HTMLElement>(".settings-knowledge-dashboard");
    if (oldDashboard) this.healthDataset = { ...oldDashboard.dataset } as Record<string, string>;
    this.secondaryCleanup?.(); this.secondaryCleanup = null; this.reset(host);
    if (this.detail) {
      this.secondaryCleanup = renderKnowledgeMaintenanceRecordDetail(host, { zh: this.plugin.settings.settingsLanguage !== "en", record: this.detail, onBack: () => { this.detail = null; this.page = this.detailBack; this.renderSecondary(); }, onOpenPath: path => this.openPath(path) }); return;
    }
    if (this.page === "history" && !this.issue && data) {
      this.secondaryCleanup = renderKnowledgeMaintenanceHistoryList(host, { zh: this.plugin.settings.settingsLanguage !== "en", entries: data.maintenanceHistory, records: data.maintenanceRecords, state: this.historyState, error: data.errors.history, onBack: () => this.openPage("overview"), onChange: () => this.renderSecondary(), onSelectRecord: record => { this.detail = record; this.detailBack = "history"; this.renderSecondary(); }, onOpenPath: path => this.openPath(path), onUnavailable: () => { new Notice(this.t("维护记录尚未读取或已缺失", "Maintenance record is unavailable")); } }); return;
    }
    this.button(host, this.t("返回知识库", "Back to knowledge"), () => this.openPage("overview"));
    if (!data) { host.createDiv({ text: this.t("正在读取…", "Reading…") }); return; }
    if (this.issue) { this.renderIssueList(host, this.issue, data); return; }
    const dashboard = host.createDiv(); Object.assign(dashboard.dataset, this.healthDataset);
    renderSettingsKnowledgeDashboard(dashboard, { language: this.plugin.settings.settingsLanguage, visible: true, snapshot: data.dashboard, expanded: this.healthExpanded, loading: false, error: data.errors.health ?? "", recovery: this.plugin.getKnowledgeSurfaceService()?.maintenanceRecoveryStatus ?? { state: "ready", message: "" } }, { onRefresh: () => { this.healthSignature = ""; void this.refresh(); }, onToggleExpanded: () => { this.healthExpanded = !this.healthExpanded; this.healthSignature = ""; this.renderSecondary(); }, onOpenHistory: () => this.openPage("history"), onOpenRaw: () => { const raw = data.directories.find(item => item.role === "raw"); const roots = raw?.roots.filter(root => ["ready", "partial"].includes(root.state)) ?? []; if (roots.length === 1) void this.openFolder(roots[0].path).catch(error => new Notice(this.error(error))); else { this.openPage("overview"); this.expanded.add("raw"); this.renderDirectories(); this.field("directories").scrollIntoView({ block: "nearest" }); } } }, this.app);
  }
  private renderIssueList(host: HTMLElement, issue: Issue, data: KnowledgePageSnapshot): void {
    const paths = this.issuePaths(issue, data), pages = Math.max(1, Math.ceil(paths.length / 20)); this.issuePage = Math.min(this.issuePage, pages);
    host.createEl("h1", { text: this.issueText(issue, paths.length) });
    const list = host.createDiv({ cls: "knowledge-object-list" });
    for (const path of paths.slice((this.issuePage - 1) * 20, this.issuePage * 20)) {
      const row = list.createDiv({ cls: "knowledge-object-row" });
      this.button(row, path, async () => { const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) { await this.refresh(); throw new Error(this.t("文件已移动或不存在", "File moved or missing")); } await this.app.workspace.getLeaf("tab").openFile(file, { active: true }); });
      if (issue === "sources") for (const source of data.sources.missing.find(item => item.path === path)?.sourcePaths ?? []) row.createSpan({ cls: "knowledge-note", text: this.t(`原来源：${source}`, `Original source: ${source}`) });
    }
    if (!paths.length) host.createDiv({ cls: "knowledge-empty", text: this.t("这条提醒已更新", "This reminder has changed") });
    const pagination = host.createDiv({ cls: "knowledge-pagination" });
    pagination.createSpan({ text: this.t(`${this.issuePage} / ${pages} 页 · 每页 20 条`, `${this.issuePage} / ${pages} pages · 20 per page`) });
    createOriginPagination(pagination, this.issuePage, pages, page => { this.issuePage = page; this.renderSecondary(); });
    this.regionError(host, issue === "isolated" ? data.errors.links : data.errors.sources);
  }
}
