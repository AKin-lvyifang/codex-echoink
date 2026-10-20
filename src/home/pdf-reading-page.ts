import { ItemView, Notice, setIcon, type EventRef, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginPagination, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { ForegroundView } from "../ui/foreground-view";
import type { PdfJob, PdfNavigationArtifact, PdfNavigationData, PdfNavigationEntry } from "../pdf-reading/types";
import { workbenchModuleOwner } from "./module-navigation";
import { PdfReadingUploadModal, pdfFileSize } from "./pdf-reading-upload-modal";

export const PDF_READING_PAGE_VIEW_TYPE = "echoink-pdf-reading-page";

/** History is a read-only projection of the existing PDF jobs and actual files. */
export class PdfReadingPageView extends ItemView {
  private closed = true;
  private foreground: ForegroundView | null = null;
  private releases: Array<() => void> = [];
  private snapshot: PdfNavigationData | null = null;
  private generation = 0;
  private scheduled = false;
  private settingsSignature = "";
  private renderedSignature = "";
  private page = 1;
  private selectedId = "";
  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) { super(leaf); }
  getViewType(): string { return PDF_READING_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("PDF 精读", "PDF reading"); }
  getIcon(): string { return "file-text"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(key: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-pdf-page="${key}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string { return JSON.stringify([this.plugin.settings.settingsLanguage, this.plugin.settings.pdfReading, this.plugin.settings.agentRegistry]); }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-pdf-reading-page", "echoink-theme-boundary");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => {
      if (active) { this.subscribe(); void this.refresh(); }
      else { this.unsubscribe(); this.generation++; }
    });
    if (this.active()) this.subscribe();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.generation++; this.unsubscribe();
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
    // The PDF service owns execution. Closing this page never cancels a task.
  }
  private subscribe(): void {
    if (this.releases.length) return;
    const host = this.plugin.pdfReading;
    if (host) {
      this.releases.push(host.api.subscribe(() => this.scheduleRefresh()));
      this.releases.push(host.api.deps.access.subscribe(() => this.scheduleRefresh()));
    }
    const runService = this.plugin.getConversationRunService?.();
    if (runService) this.releases.push(runService.subscribe({ refresh: () => this.scheduleRefresh(), clearAcceptedDraft() {}, isTaskVisible: () => false }));
    const changed = (file: { path: string }, oldPath?: string) => {
      const relevant = (path: string) => this.snapshot?.entries.some(entry => entry.artifacts.some(artifact => artifact.path.split("#")[0] === path)
        || entry.job.original?.savedPath === path || entry.job.original?.plannedPath === path);
      if (relevant(file.path) || (oldPath && relevant(oldPath))) this.scheduleRefresh();
    };
    const observe = (ref: EventRef) => this.releases.push(() => this.app.vault.offref(ref));
    observe(this.app.vault.on("create", changed)); observe(this.app.vault.on("modify", changed));
    observe(this.app.vault.on("delete", changed)); observe(this.app.vault.on("rename", changed));
  }
  private unsubscribe(): void { for (const release of this.releases.splice(0)) release(); }
  private scheduleRefresh(): void {
    if (this.scheduled || !this.active()) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (this.active()) void this.refresh(); });
  }
  refreshIfSettingsChanged(): void { if (this.settingsSignature !== this.signature()) this.scheduleRefresh(); }
  refreshLanguage(): void { this.refreshIfSettingsChanged(); }
  async refresh(): Promise<void> {
    if (!this.active()) return;
    const generation = ++this.generation;
    this.settingsSignature = this.signature(); this.renderHeader();
    if (!this.snapshot) this.field("status").setText(this.t("正在读取PDF记录…", "Reading PDF history…"));
    try {
      const host = this.plugin.pdfReading;
      if (!host) throw new Error(this.t("PDF 服务尚未就绪", "PDF service is not ready"));
      const data = await host.navigationData();
      if (!this.active() || generation !== this.generation) return;
      this.snapshot = { entries: [...data.entries].sort((a, b) => b.job.createdAt - a.job.createdAt), errors: data.errors };
      const status = this.field("status"); this.reset(status);
      if (data.errors.length) {
        status.createSpan({ text: data.entries.length ? this.t("部分记录暂时读不到", "Some PDF records cannot be read") : this.t("暂时读不到PDF记录，请重试", "PDF history cannot be read. Please retry") });
        this.button(status, this.t("重试", "Retry"), () => this.refresh());
      }
      const signature = JSON.stringify([this.snapshot, this.settingsSignature]);
      if (signature !== this.renderedSignature) { this.renderedSignature = signature; this.renderHistory(); this.renderDetail(); }
    } catch (error) {
      if (!this.active() || generation !== this.generation) return;
      const status = this.field("status"); this.reset(status);
      status.createSpan({ text: this.t("暂时读不到PDF记录，请重试", "PDF history cannot be read. Please retry") + `：${this.error(error)}` });
      this.button(status, this.t("重试", "Retry"), () => this.refresh());
    }
  }
  private reset(host: HTMLElement): void { disposeOriginControls(host); host.empty(); }
  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private button(host: HTMLElement, text: string, action: () => unknown, cls = "is-tertiary"): HTMLButtonElement {
    const button = createOriginButton(host, { text, cls: `pdf-page-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: "tertiary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await Promise.resolve(result); } finally { if (button.isConnected) { button.disabled = false; setAmicroButtonPending(button, false); } }
        }
      } catch (error) { new Notice(this.error(error)); }
    };
    return button;
  }
  private renderShell(): void {
    this.reset(this.contentEl);
    const inner = this.contentEl.createDiv({ cls: "pdf-page-inner" });
    inner.createDiv({ cls: "pdf-page-header", attr: { "data-pdf-page": "header" } });
    inner.createDiv({ cls: "pdf-page-status", attr: { "data-pdf-page": "status", role: "status", "aria-live": "polite" } });
    const columns = inner.createDiv({ cls: "pdf-page-columns" });
    const history = columns.createEl("section", { cls: "pdf-page-history", attr: { "aria-label": this.t("PDF 历史", "PDF history") } });
    history.createDiv({ cls: "pdf-page-history-list", attr: { "data-pdf-page": "history" } });
    history.createDiv({ cls: "pdf-page-pagination", attr: { "data-pdf-page": "pagination" } });
    columns.createEl("section", { cls: "pdf-page-detail", attr: { "data-pdf-page": "detail", "aria-label": this.t("PDF 成果", "PDF outputs") } });
    this.renderHeader(); this.renderDetail();
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "pdf-page-title" });
      const back = this.button(title, "", () => this.plugin.activateHomeView({ keepRightSidebar: true }), "is-icon");
      setIcon(back, "arrow-left"); title.createEl("h1");
      const upload = this.button(header, "", () => new PdfReadingUploadModal(this.plugin, upload).open(), "is-primary");
      upload.dataset.pdfPage = "upload";
    }
    header.querySelector("h1")!.setText(this.getDisplayText());
    header.querySelector(".is-icon")!.setAttribute("aria-label", this.t("返回工作台", "Back to workbench"));
    const owner = workbenchModuleOwner(this.plugin, "pdf-reading");
    this.field("upload").setText(this.t(`上传 PDF 交给 ${owner.name}`, `Upload PDF for ${owner.name}`));
  }
  private state(entry: PdfNavigationEntry): string {
    const job = entry.job;
    if (entry.taskStatus === "waiting") return this.t("等你回应", "Waiting for you");
    if (entry.taskStatus === "interrupted") return this.t("已中断", "Interrupted");
    const missingKnowledge = (job.options.reading && !entry.artifacts.some(a => a.kind === "reading" && !a.missing))
      || (job.options.summary && !entry.artifacts.some(a => a.kind === "summary" && !a.missing));
    if (job.state === "completed" && entry.taskStatus === "running") return this.t("正在核对成果…", "Checking outputs…");
    if (job.state === "completed" && missingKnowledge && entry.taskStatus !== "completed") return this.t("部分完成", "Partially completed");
    if (job.wikiState === "running") return this.t("正在整理知识成果…", "Organizing knowledge notes…");
    if (job.wikiState === "failed" && job.state === "completed") return this.t("部分完成", "Partially completed");
    if (job.state === "completed") return this.t("已完成", "Completed");
    if (job.state === "partial") return this.t("部分完成", "Partially completed");
    if (job.state === "failed") return this.t("处理失败", "Failed");
    if (job.state === "cancelled") return this.t("已中断", "Interrupted");
    return this.plugin.settings.settingsLanguage === "en" ? "Processing" : job.stage || "处理中";
  }
  private date(job: PdfJob): string {
    return new Date(job.createdAt).toLocaleDateString(this.plugin.settings.settingsLanguage === "en" ? "en" : "zh-CN");
  }
  private artifactName(artifact: PdfNavigationArtifact): string {
    const names = { original: ["原文件", "Original PDF"], raw: ["提取原文", "Extracted source"], translation: ["译文", "Translation"], reading: ["精读", "Close reading"], summary: ["摘要", "Summary"], wiki: ["知识成果", "Knowledge note"] };
    return this.t(names[artifact.kind][0], names[artifact.kind][1]);
  }
  private renderHistory(): void {
    const host = this.field("history"), pagination = this.field("pagination");
    const scroll = host.scrollTop;
    const focused = host.contains(host.ownerDocument.activeElement) ? (host.ownerDocument.activeElement as HTMLElement).dataset.pdfJob : undefined;
    this.reset(host); this.reset(pagination);
    const entries = this.snapshot?.entries ?? [];
    if (!entries.length) {
      host.createDiv({ cls: "pdf-page-empty", text: this.snapshot?.errors.length ? this.t("没有可读取的 PDF 记录", "No readable PDF records") : this.t("还没有处理过PDF", "No PDFs processed yet") });
      return;
    }
    const pages = Math.max(1, Math.ceil(entries.length / 20)); this.page = Math.max(1, Math.min(this.page, pages));
    for (const entry of entries.slice((this.page - 1) * 20, this.page * 20)) {
      const row = this.button(host, "", () => this.select(entry.job.id), "is-tertiary pdf-page-history-row");
      row.dataset.pdfJob = entry.job.id;
      row.setAttribute("aria-current", String(entry.job.id === this.selectedId));
      const name = row.createSpan({ cls: "pdf-page-row-name", text: entry.job.name });
      const meta = row.createSpan({ cls: "pdf-page-row-meta" });
      meta.createSpan({ text: this.state(entry) });
      meta.createEl("time", { text: this.date(entry.job), attr: { datetime: new Date(entry.job.createdAt).toISOString() } });
      const kinds = [...new Set(entry.artifacts.filter(artifact => !artifact.missing && artifact.kind !== "original").map(artifact => this.artifactName(artifact)))];
      if (kinds.length) meta.createSpan({ cls: "pdf-page-row-outputs", text: kinds.join(" · ") });
      const arrow = row.createSpan({ cls: "pdf-page-arrow", attr: { "aria-hidden": "true" } }); setIcon(arrow, "chevron-right");
      row.setAttribute("aria-label", `${name.textContent} · ${this.state(entry)} · ${this.date(entry.job)}`);
    }
    pagination.createSpan({ text: this.t(`${entries.length} 份 · 第 ${this.page} / ${pages} 页`, `${entries.length} PDFs · Page ${this.page} of ${pages}`) });
    if (pages > 1) {
      const nav = createOriginPagination(pagination, this.page, pages, page => { this.page = page; this.renderHistory(); this.field("history").scrollTop = 0; });
      nav.setAttribute("aria-label", this.t("PDF 历史分页", "PDF history pages"));
      if (this.plugin.settings.settingsLanguage === "en") for (const button of Array.from(nav.querySelectorAll("button"))) {
        const label = button.getAttribute("aria-label") ?? "";
        button.setAttribute("aria-label", label === "上一页" ? "Previous page" : label === "下一页" ? "Next page" : label.replace(/^第 (\d+) 页$/u, "Page $1"));
      }
    }
    host.scrollTop = scroll;
    if (focused) Array.from(host.querySelectorAll<HTMLButtonElement>("[data-pdf-job]")).find(row => row.dataset.pdfJob === focused)?.focus({ preventScroll: true });
  }
  private select(id: string): void {
    this.selectedId = id;
    for (const row of Array.from(this.field("history").querySelectorAll<HTMLElement>("[data-pdf-job]"))) row.setAttribute("aria-current", String(row.dataset.pdfJob === id));
    this.renderDetail();
  }
  private originalMessage(entry: PdfNavigationEntry): string {
    if (entry.originalState === "not-saved") return this.t("这份历史记录没有保存原件", "This historical record has no saved original PDF");
    if (entry.originalState === "missing") return this.t("原PDF找不到了", "The original PDF cannot be found");
    if (entry.originalState === "changed") return this.t("原PDF已经改过，请先核对", "The original PDF has changed. Check it before continuing");
    if (entry.originalState === "pending") return this.t("原 PDF 尚未保存", "The original PDF has not been saved yet");
    return "";
  }
  private renderDetail(): void {
    const host = this.field("detail"); this.reset(host);
    const entry = this.snapshot?.entries.find(item => item.job.id === this.selectedId);
    if (!entry) {
      host.createDiv({ cls: "pdf-page-empty", text: this.selectedId && this.snapshot?.errors.length ? this.t("这份PDF记录暂时读不到，请重试", "This PDF record cannot be read. Please retry") : this.t("选择一份PDF查看成果", "Select a PDF to view its outputs") }); return;
    }
    host.createEl("h2", { text: entry.job.name });
    const meta = [this.date(entry.job)];
    if (entry.job.original?.byteLength) meta.push(pdfFileSize(entry.job.original.byteLength));
    if (entry.job.pages.length) meta.push(this.t(`${entry.job.pages.length} 页`, `${entry.job.pages.length} pages`));
    host.createDiv({ cls: "pdf-page-detail-meta", text: meta.join(" · ") });
    host.createDiv({ cls: "pdf-page-run-state", text: this.state(entry), attr: { role: "status" } });
    if (entry.job.error) host.createDiv({ cls: "pdf-page-message is-error", text: entry.job.error });
    for (const warning of entry.job.warnings) host.createDiv({ cls: "pdf-page-message", text: warning });
    const original = this.originalMessage(entry);
    if (original) host.createDiv({ cls: "pdf-page-message", text: original });
    const artifacts = host.createDiv({ cls: "pdf-page-artifacts" });
    for (const artifact of entry.artifacts) this.renderArtifact(artifacts, artifact, entry);
    if (!entry.artifacts.some(artifact => artifact.kind !== "original" && !artifact.missing)) host.createDiv({ cls: "pdf-page-empty", text: this.t("还没有保存的成果", "No saved outputs yet") });
    if (entry.taskId) this.button(host, this.t("查看任务", "View task"), () => this.plugin.openTaskDetail(entry.taskId!), "is-tertiary pdf-page-task");
  }
  private renderArtifact(host: HTMLElement, artifact: PdfNavigationArtifact, entry: PdfNavigationEntry): void {
    const unavailable = artifact.missing || artifact.kind === "original" && entry.originalState !== "available";
    const row = unavailable ? host.createDiv({ cls: "pdf-page-artifact-row is-unavailable" }) : this.button(host, "", () => this.openArtifact(artifact), "is-tertiary pdf-page-artifact-row");
    const icon = row.createSpan({ cls: "pdf-page-file-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, artifact.kind === "original" ? "file" : "file-text");
    row.createSpan({ cls: "pdf-page-row-name", text: this.artifactName(artifact) });
    row.createSpan({ cls: "pdf-page-artifact-path", text: artifact.path });
    if (artifact.kind === "wiki" && artifact.label && artifact.label !== "知识成果") row.createSpan({ cls: "pdf-page-artifact-label", text: artifact.label });
    if (unavailable) {
      if (artifact.kind !== "original") row.createSpan({ cls: "pdf-page-message is-error", text: this.t("这个成果文件找不到了", "This output file cannot be found") });
    } else {
      const arrow = row.createSpan({ cls: "pdf-page-arrow", attr: { "aria-hidden": "true" } }); setIcon(arrow, "arrow-up-right");
    }
  }
  private async openArtifact(artifact: PdfNavigationArtifact): Promise<void> {
    try { await this.plugin.pdfReading!.openNote(artifact.path); }
    catch (error) { this.scheduleRefresh(); throw error; }
  }
}
