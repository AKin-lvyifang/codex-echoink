import { getProPluginAccess, capabilityMessage, unavailableCapabilityAccess } from "../membership/access";
import { ItemView, Menu, Notice, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { disposeOriginControls } from "../settings/origin-controls";
import { confirmModal, textInputModal } from "../ui/modals";
import { fingerprint } from "./model";
import { reviewDiaryPrivacy } from "./privacy-modal";
import { ENGLISH_DIARY_VIEW, type DiaryAlignment, type DiaryExpression, type DiaryRecord, type DiarySource } from "./types";
import type { EnglishDiaryViewHost } from "./view-host";
import { alignmentSegments, diaryButton, diaryError, diaryField, hasExactAlignment } from "./ui";

type ExpressionFilter = "all" | "phrase" | "sentence";
type DiaryViewState = { sourcePath?: string };
type UnsavedDiaryDraft = { content: string; expected: string };
const unsavedDrafts = new WeakMap<EnglishDiaryViewHost, Map<string, UnsavedDiaryDraft>>();
let diaryViewSequence = 0;

/** Owns only presentation and an explicit unsaved draft; the original file remains canonical. */
export class EnglishDiaryView extends ItemView {
  private sourcePath = "";
  private source: DiarySource | null = null;
  private record: DiaryRecord | null = null;
  private editing = false;
  private draft = "";
  private expectedSource = "";
  private savingSource = false;
  private generating = false;
  private stage = "";
  private failure = "";
  private loadFailure = "";
  private filter: ExpressionFilter = "all";
  private selectedAlignment: string | null = null;
  private hoveredAlignment: string | null = null;
  private selectedExpression: string | null = null;
  private refreshSequence = 0;
  private refreshTimer: number | null = null;
  private closed = false;
  private explanationEl: HTMLElement | null = null;
  private readonly explanationId = `echoink-diary-explanation-${++diaryViewSequence}`;

  constructor(leaf: WorkspaceLeaf, private readonly host: EnglishDiaryViewHost) { super(leaf); }
  getViewType(): string { return ENGLISH_DIARY_VIEW; }
  getDisplayText(): string { return this.source?.title ? `${this.source.title} · 英文日记` : "英文日记"; }
  getIcon(): string { return "languages"; }
  getState(): DiaryViewState { return { sourcePath: this.sourcePath }; }

  async setState(state: DiaryViewState, result: ViewStateResult): Promise<void> {
    const path = typeof state?.sourcePath === "string" ? state.sourcePath : "";
    if (path !== this.sourcePath) {
      if (this.editing && this.draft !== this.expectedSource) {
        const discard = await confirmModal(this.app, "放弃未保存的原稿？", "当前修改尚未写入日记，切换后将丢弃这些修改。", "放弃并切换", "继续编辑");
        if (!discard) return;
      }
      unsavedDrafts.get(this.host)?.delete(this.sourcePath);
      this.host.api.cancel(this.sourcePath);
      this.sourcePath = path;
      this.editing = false;
      this.source = null;
      this.record = null;
      this.selectedAlignment = null;
      this.selectedExpression = null;
      this.failure = "";
    }
    await this.refresh(true);
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.register((this.host.api.access ?? unavailableCapabilityAccess).subscribe(() => this.render()));
    this.contentEl.addClass("echoink-diary-view");
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path === this.sourcePath || file.path === this.record?.englishPath) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file.path === this.sourcePath || file.path === this.record?.englishPath) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (oldPath === this.sourcePath) {
        this.host.api.cancel(oldPath);
        this.sourcePath = file.path;
        this.app.workspace.requestSaveLayout();
        this.scheduleRefresh();
      } else if (oldPath === this.record?.englishPath) this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file?.path === this.sourcePath || info.file?.path === this.record?.englishPath) this.scheduleRefresh();
    }));
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape" && this.selectedAlignment) {
        event.stopPropagation();
        this.clearAlignment();
      }
    });
    this.registerDomEvent(this.contentEl, "click", (event) => {
      if (!(event.target as HTMLElement).closest("button, a, input, textarea, summary, .echoink-diary-mark, .echoink-diary-expression")) this.clearAlignment();
    });
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.editing && this.draft !== this.expectedSource) {
      let drafts = unsavedDrafts.get(this.host);
      if (!drafts) { drafts = new Map(); unsavedDrafts.set(this.host, drafts); }
      drafts.set(this.sourcePath, { content: this.draft, expected: this.expectedSource });
      new Notice("未保存的原稿修改已暂存在本次会话，重新打开可继续。退出 Obsidian 前请保存。", 8000);
    }
    this.closed = true;
    this.refreshSequence++;
    this.host.api.cancel(this.sourcePath);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, 150);
  }

  async refresh(editOnOpen = false): Promise<void> {
    const sequence = ++this.refreshSequence;
    let focusEditor = false;
    if (!this.sourcePath) { this.render(); return; }
    try {
      const source = await this.host.api.readSource(this.sourcePath);
      const record = await this.host.api.load(this.sourcePath);
      if (sequence !== this.refreshSequence || this.closed) return;
      const firstLoad = this.source === null;
      this.source = source;
      this.record = record;
      this.loadFailure = "";
      const retained = unsavedDrafts.get(this.host)?.get(this.sourcePath);
      if (!this.editing && (retained || ((firstLoad || editOnOpen) && this.writable()))) {
        this.host.api.cancel(this.sourcePath);
        this.editing = true;
        this.draft = retained?.content ?? source.content;
        this.expectedSource = retained?.expected ?? source.content;
        focusEditor = true;
      }
      if (!this.canAlign()) this.clearAlignment();
    } catch (error) {
      if (sequence !== this.refreshSequence || this.closed) return;
      this.loadFailure = diaryError(error);
      this.clearAlignment();
    }
    this.render();
    if (focusEditor) this.contentEl.querySelector<HTMLTextAreaElement>(".echoink-diary-editor")?.focus({ preventScroll: true });
  }

  private writable(): boolean { return this.host.enabled() && getProPluginAccess(this.host.api.access ?? unavailableCapabilityAccess, this.host.enabled()).canWrite; }

  private sourceChanged(): boolean {
    return !!this.record?.result && !!this.source && fingerprint(this.source.content) !== this.record.result.sourceFingerprint;
  }

  private canAlign(): boolean {
    const result = this.record?.result;
    return !!result && !!this.source && !this.editing && !this.loadFailure && !this.sourceChanged() && !this.record?.englishModified && !this.record?.missingEnglish && fingerprint(result.english) === result.englishFingerprint;
  }

  private reliableAlignments(): DiaryAlignment[] {
    if (!this.canAlign()) return [];
    return this.record!.result!.alignments.filter((alignment) => hasExactAlignment(alignment, this.source!.content, this.record!.result!.english));
  }

  private render(): void {
    if (this.closed) return;
    const focused = this.contentEl.ownerDocument.activeElement;
    const editor = focused instanceof this.contentEl.ownerDocument.defaultView!.HTMLTextAreaElement && focused.classList.contains("echoink-diary-editor") ? focused : null;
    const selection = editor ? { start: editor.selectionStart, end: editor.selectionEnd, scroll: editor.scrollTop } : null;
    const scroll = this.contentEl.scrollTop;
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    const page = this.contentEl.createDiv({ cls: "echoink-diary-page" });
    if (!this.sourcePath) {
      page.createEl("h2", { cls: "echoink-diary-title", text: "英文日记" });
      page.createDiv({ cls: "echoink-diary-empty", text: "从首页“写日记”选择“英文”，或运行“英文日记：打开今天的日记”。" });
      diaryButton(page, "表达库", () => this.host.openLibrary());
      return;
    }
    this.renderHeader(page);
    if (this.loadFailure) {
      const error = page.createDiv({ cls: "echoink-diary-notice is-error", attr: { role: "alert" } });
      error.createSpan({ text: this.loadFailure });
      diaryButton(error, "重新读取", () => this.refresh());
    }
    if (!this.source) return;
    this.renderStatus(page);
    const columns = page.createDiv({ cls: "echoink-diary-columns" });
    this.renderSource(columns);
    this.renderEnglish(columns);
    this.explanationEl = page.createDiv({ cls: "echoink-diary-alignment-note", attr: { id: this.explanationId, "aria-live": "polite" } });
    this.renderExpressions(page);
    this.updateAlignmentHighlight();
    this.contentEl.scrollTop = scroll;
    if (selection) {
      const next = this.contentEl.querySelector<HTMLTextAreaElement>(".echoink-diary-editor");
      next?.focus({ preventScroll: true });
      next?.setSelectionRange(selection.start, selection.end);
      if (next) next.scrollTop = selection.scroll;
    }
  }

  private renderHeader(page: HTMLElement): void {
    const header = page.createDiv({ cls: "echoink-diary-header" });
    header.createEl("h2", { cls: "echoink-diary-title", text: this.source?.title || "英文日记" });
    const actions = header.createDiv({ cls: "echoink-diary-actions" });
    diaryButton(actions, "表达库", () => this.host.openLibrary());
    diaryButton(actions, "整理想法", () => this.host.organizeThoughts(this.sourcePath), { disabled: !this.host.enabled() });
    diaryButton(actions, "发送范围", () => this.reviewPrivacy(), { disabled: this.editing || this.generating || !this.source || !this.writable() });
    const running = this.generating || this.host.api.isGenerating(this.sourcePath);
    if (running) {
      const cancel = diaryButton(actions, this.stage || "停止生成", () => { this.host.api.cancel(this.sourcePath); this.stage = "正在停止…"; this.render(); });
      cancel.setAttribute("aria-label", "停止生成英文");
      cancel.setAttribute("aria-busy", "true");
    } else {
      const result = this.record?.result;
      const unchanged = !!result && !this.sourceChanged() && !this.record?.pending;
      if (unchanged && !this.record?.missingEnglish) {
        actions.createSpan({ cls: "echoink-diary-badge", text: "英文已生成" });
        return;
      }
      const label = this.record?.missingEnglish ? "恢复英文" : this.record?.pending ? "继续保存" : result ? "更新英文" : "生成英文";
      diaryButton(actions, label, async () => {
        if (this.record?.missingEnglish) { await this.host.api.restore(this.sourcePath); await this.refresh(); }
        else await this.generate();
      }, { primary: !unchanged, disabled: this.editing || this.savingSource || !this.source?.content.trim() || (!unchanged && !this.record?.pending && !this.writable()) || !!this.loadFailure });
    }
  }

  private renderStatus(page: HTMLElement): void {
    if (this.host.enabled() && !this.writable()) page.createDiv({ cls: "echoink-diary-notice", text: "需要有效 PRO 才能写入和生成；已有日记和表达仍可查看。" });
    if (!this.host.enabled()) page.createDiv({ cls: "echoink-diary-notice", text: "英文日记已关闭，已有正文和表达仍可查看。启用后可继续生成。" });
    if (this.failure) page.createDiv({ cls: "echoink-diary-notice is-error", text: this.failure, attr: { role: "alert" } });
    if (this.editing && this.source?.content !== this.expectedSource) page.createDiv({ cls: "echoink-diary-notice", text: "原稿已在其它位置修改。当前草稿仍保留，保存前需要先处理冲突。" });
    if (this.record?.englishModified) page.createDiv({ cls: "echoink-diary-notice", text: "英文文件被外部修改。下方保留生成时的英文，来源定位已暂停；更新前请先备份需要保留的手工内容。" });
    else if (this.record?.missingEnglish) page.createDiv({ cls: "echoink-diary-notice", text: "英文文件已移除，可恢复已保存的结果，无需再次调用模型。" });
    else if (this.sourceChanged()) page.createDiv({ cls: "echoink-diary-notice", text: "原稿已改变，下方英文和表达来自上次生成。更新成功前保留旧结果，来源定位暂不可用。" });
    if (this.record?.pending && !this.generating) page.createDiv({ cls: "echoink-diary-notice", text: "上次保存尚未完成，可继续保存已有生成结果。" });
    if (this.record?.result?.warnings.length) {
      const warnings = page.createEl("details", { cls: "echoink-diary-warnings" });
      warnings.createEl("summary", { text: `${this.record.result.warnings.length} 条结果提示` });
      for (const warning of this.record.result.warnings) warnings.createEl("p", { text: warning });
    }
  }

  private renderSource(parent: HTMLElement): void {
    const section = parent.createEl("section", { cls: "echoink-diary-column", attr: { "aria-label": "日记原稿" } });
    const header = section.createDiv({ cls: "echoink-diary-column-header" });
    const heading = header.createDiv({ cls: "echoink-diary-source-heading" });
    heading.createEl("h3", { text: "原稿" });
    const markdownHintId = `${this.explanationId}-markdown-help`;
    if (this.editing) heading.createSpan({ cls: "echoink-diary-source-hint", text: "支持 Markdown 语法", attr: { id: markdownHintId } });
    const actions = header.createDiv({ cls: "echoink-diary-actions" });
    if (this.editing) {
      diaryButton(actions, "放弃修改", () => this.discardEditing(), { disabled: this.savingSource });
      diaryButton(actions, this.savingSource ? "保存中…" : "保存原稿", () => this.saveEditing(), { primary: true, disabled: this.savingSource || !this.writable() });
      const textarea = section.createEl("textarea", { cls: "echoink-diary-editor", attr: { "aria-label": "编辑日记原稿", "aria-describedby": markdownHintId, spellcheck: "false" } });
      textarea.value = this.draft;
      textarea.disabled = this.savingSource;
      textarea.readOnly = !this.writable();
      textarea.addEventListener("input", () => { this.draft = textarea.value; });
      textarea.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (!this.savingSource) void this.saveEditing();
        }
      });
    } else {
      diaryButton(actions, "打开原稿", () => this.host.openFile(this.sourcePath), { tertiary: true });
      diaryButton(actions, "编辑", () => this.startEditing(), { disabled: !!this.loadFailure || !this.writable() });
      const body = section.createDiv({ cls: "echoink-diary-reading", attr: { "aria-label": "原稿内容" } });
      if (!this.source!.content.trim()) body.createDiv({ cls: "echoink-diary-empty", text: "写下今天发生的事，中英文都可以。" });
      else this.renderReading(body, this.source!.content, "source");
    }
  }

  private renderEnglish(parent: HTMLElement): void {
    const section = parent.createEl("section", { cls: "echoink-diary-column", attr: { "aria-label": "英文日记" } });
    const header = section.createDiv({ cls: "echoink-diary-column-header" });
    header.createEl("h3", { text: this.record?.englishModified ? "生成时英文" : "英文" });
    const body = section.createDiv({ cls: "echoink-diary-reading", attr: { "aria-label": "英文内容", lang: "en" } });
    if (this.record?.result) this.renderReading(body, this.record.result.english, "target");
    else body.createDiv({ cls: "echoink-diary-empty", text: this.generating ? "正在生成英文…" : "原稿准备好后，生成这篇日记的英文。" });
  }

  private renderReading(parent: HTMLElement, text: string, side: "source" | "target"): void {
    if (!this.canAlign()) { parent.textContent = text; return; }
    for (const segment of alignmentSegments(text, this.reliableAlignments(), side)) {
      if (!segment.ids.length) { parent.appendText(segment.text); continue; }
      const mark = parent.createSpan({ cls: `echoink-diary-mark is-${segment.kind}`, text: segment.text, attr: { tabindex: "0", role: "button", "aria-describedby": this.explanationId, "aria-pressed": "false" } });
      mark.dataset.alignmentIds = JSON.stringify(segment.ids);
      mark.setAttribute("aria-label", `查看${segment.kind === "translation" ? "对应原意" : segment.kind === "correction" ? "英文修正" : "衔接调整"}：${segment.text}`);
      const reason = this.record!.result!.alignments.find((alignment) => alignment.id === segment.ids[0])?.reason;
      if (reason) setTooltip(mark, reason, { placement: "top", classes: ["echoink-diary-tooltip"], delay: 250 });
      mark.addEventListener("pointerenter", () => { this.hoveredAlignment = segment.ids[0]; this.updateAlignmentHighlight(); });
      mark.addEventListener("pointerleave", () => { this.hoveredAlignment = null; this.updateAlignmentHighlight(); });
      mark.addEventListener("focus", () => { this.hoveredAlignment = segment.ids[0]; this.updateAlignmentHighlight(); });
      mark.addEventListener("blur", () => { this.hoveredAlignment = null; this.updateAlignmentHighlight(); });
      mark.addEventListener("click", (event) => { event.stopPropagation(); this.selectAlignment(segment.ids[0]); });
      mark.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.selectAlignment(segment.ids[0]); }
      });
    }
  }

  private renderExpressions(page: HTMLElement): void {
    const section = page.createEl("section", { cls: "echoink-diary-expressions", attr: { "aria-label": "本篇表达收获" } });
    const notice = capabilityMessage(this.host.api.access ?? unavailableCapabilityAccess, "diary.explanation.generate");
    if (notice) section.createDiv({ cls: "echoink-diary-notice", text: `英文生成与对照免费。新表达讲解：${notice}` });
    const header = section.createDiv({ cls: "echoink-diary-section-header" });
    header.createEl("h3", { text: "本篇表达收获" });
    const filters = header.createDiv({ cls: "echoink-diary-filters", attr: { "aria-label": "表达类型" } });
    for (const [value, label] of [["all", "ALL"], ["phrase", "短语"], ["sentence", "短句"]] as const) {
      const button = diaryButton(filters, label, () => { this.filter = value; this.render(); });
      button.setAttribute("aria-pressed", String(this.filter === value));
      button.toggleClass("is-selected", this.filter === value);
    }
    const expressions = this.record?.result?.expressions ?? [];
    const filtered = expressions.filter((expression) => this.filter === "all" || expression.type === this.filter);
    if (!filtered.length) {
      section.createDiv({ cls: "echoink-diary-empty", text: expressions.length ? "本篇没有这一类表达。" : this.record?.result ? "这篇没有需要额外收录的表达。" : "生成英文后，在这里查看本篇表达。" });
      return;
    }
    for (const expression of filtered) this.renderExpression(section, expression);
  }

  private renderExpression(parent: HTMLElement, expression: DiaryExpression): void {
    const card = parent.createEl("article", { cls: "echoink-diary-expression" });
    card.dataset.expressionId = expression.id;
    card.toggleClass("is-selected", this.selectedExpression === expression.id);
    const header = card.createDiv({ cls: "echoink-diary-card-header" });
    const title = header.createDiv({ cls: "echoink-diary-card-heading" });
    title.createEl("h4", { text: expression.term, attr: { lang: "en" } });
    title.createSpan({ cls: "echoink-diary-badge", text: expression.type === "phrase" ? "短语" : "短句" });
    if (expression.status === "needs-review") title.createSpan({ cls: "echoink-diary-badge is-review", text: "待确认" });
    header.createSpan({ cls: "echoink-diary-category", text: expression.category });
    card.createDiv({ cls: "echoink-diary-meaning", text: expression.meaning });
    diaryField(card, "本篇场景", expression.scene);
    diaryField(card, "拓展例句", expression.example, "is-example");
    const canLocate = expression.status === "verified" && !!expression.alignmentId && this.reliableAlignments().some((alignment) => alignment.id === expression.alignmentId);
    card.tabIndex = 0;
    card.setAttribute("aria-label", `${expression.term}${canLocate ? "，按回车定位原文" : ""}，按 Shift+F10 打开菜单`);
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.expressionMenu(expression).showAtMouseEvent(event);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        event.stopPropagation();
        const rect = card.getBoundingClientRect();
        this.expressionMenu(expression).showAtPosition({ x: rect.left + 12, y: rect.top + 12 }, card.ownerDocument);
      }
    });
    if (canLocate) {
      card.addClass("is-locatable");
      const selectCard = () => {
        if (this.selectedExpression === expression.id && this.selectedAlignment === expression.alignmentId) { this.clearAlignment(); return; }
        this.selectedExpression = expression.id;
        this.selectAlignment(expression.alignmentId!, true);
      };
      card.addEventListener("click", (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const selection = card.ownerDocument.getSelection();
        if (selection && !selection.isCollapsed && selection.anchorNode && card.contains(selection.anchorNode)) return;
        event.stopPropagation();
        selectCard();
      });
      card.addEventListener("keydown", (event) => {
        if (event.target === card && (event.key === "Enter" || event.key === " ") && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          selectCard();
        }
      });
    }
  }

  private expressionMenu(expression: DiaryExpression): Menu {
    const menu = new Menu();
    if (!this.writable()) return menu;
    menu.addItem((item) => item
      .setTitle(expression.status === "needs-review" ? "修正说明" : "不符合原意")
      .setIcon(expression.status === "needs-review" ? "pencil" : "flag")
      .onClick(() => { void this.correctExpression(expression).catch((error) => new Notice(diaryError(error))); }));
    return menu;
  }

  private async correctExpression(expression: DiaryExpression): Promise<void> {
    const record = this.record;
    const sourcePath = this.sourcePath;
    if (!record) return;
    (this.host.api.access ?? unavailableCapabilityAccess).requireCapability("diary.expression.write");
    let updated: DiaryRecord;
    if (expression.status === "needs-review") {
      const reason = await textInputModal(this.app, "修正表达说明", "这里为什么用", expression.reason);
      if (reason === null || !reason.trim()) return;
      updated = await this.host.api.repository.markExpression(record, expression.id, "verified", reason.trim());
    } else {
      updated = await this.host.api.repository.markExpression(record, expression.id, "needs-review");
    }
    if (this.closed || this.sourcePath !== sourcePath) return;
    this.record = updated;
    this.clearAlignment();
    this.render();
  }

  private selectAlignment(id: string, locate = false): void {
    this.selectedAlignment = this.selectedAlignment === id && !locate ? null : id;
    if (!this.selectedAlignment) this.selectedExpression = null;
    this.hoveredAlignment = null;
    this.updateAlignmentHighlight();
    if (locate) {
      const marked = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".echoink-diary-mark")).find((element) => this.markIds(element).includes(id));
      marked?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  private clearAlignment(): void { this.selectedAlignment = null; this.hoveredAlignment = null; this.selectedExpression = null; this.updateAlignmentHighlight(); }

  private markIds(element: HTMLElement): string[] {
    try { return JSON.parse(element.dataset.alignmentIds ?? "[]") as string[]; } catch { return []; }
  }

  private updateAlignmentHighlight(): void {
    const id = this.canAlign() ? this.hoveredAlignment ?? this.selectedAlignment : null;
    this.contentEl.querySelectorAll<HTMLElement>(".echoink-diary-mark").forEach((element) => {
      const active = !!id && this.markIds(element).includes(id);
      element.toggleClass("is-emphasized", active);
      element.setAttribute("aria-pressed", String(!!this.selectedAlignment && this.markIds(element).includes(this.selectedAlignment)));
    });
    this.contentEl.querySelectorAll<HTMLElement>(".echoink-diary-expression").forEach((element) => element.toggleClass("is-selected", element.dataset.expressionId === this.selectedExpression));
    if (!this.explanationEl) return;
    disposeOriginControls(this.explanationEl);
    this.explanationEl.empty();
    const alignment = this.selectedAlignment ? this.reliableAlignments().find((entry) => entry.id === this.selectedAlignment) : null;
    this.explanationEl.hidden = !alignment;
    if (!alignment) return;
    const copy = this.explanationEl.createDiv({ cls: "echoink-diary-alignment-copy" });
    copy.createSpan({ cls: "echoink-diary-label", text: this.alignmentLabel(alignment) });
    copy.createSpan({ text: alignment.reason });
    if (alignment.kind !== "translation") {
      const change = copy.createDiv({ cls: "echoink-diary-change" });
      change.createSpan({ text: `原文：${alignment.source.map((range) => range.text).join(" … ")}` });
      change.createSpan({ text: `英文：${alignment.target.map((range) => range.text).join(" … ")}` });
    }
    if (this.selectedAlignment) diaryButton(this.explanationEl, "取消定位", () => this.clearAlignment(), { tertiary: true });
  }

  private alignmentLabel(alignment: DiaryAlignment): string { return alignment.kind === "translation" ? "这里为什么用" : alignment.kind === "correction" ? "英文修正" : "衔接调整"; }

  private startEditing(): void {
    if (!this.source) return;
    this.host.api.cancel(this.sourcePath);
    this.draft = this.source.content;
    this.expectedSource = this.source.content;
    this.editing = true;
    this.clearAlignment();
    this.render();
    this.contentEl.querySelector<HTMLTextAreaElement>(".echoink-diary-editor")?.focus();
  }

  private async discardEditing(): Promise<void> {
    if (this.draft !== this.expectedSource && !(await confirmModal(this.app, "放弃未保存的修改？", "原稿文件保持不变，当前编辑内容会被丢弃。", "放弃修改", "继续编辑"))) return;
    this.host.api.cancel(this.sourcePath);
    this.editing = false;
    this.draft = "";
    unsavedDrafts.get(this.host)?.delete(this.sourcePath);
    await this.refresh();
  }

  private async saveEditing(): Promise<void> {
    if (!this.editing || this.savingSource) return;
    this.host.api.cancel(this.sourcePath);
    this.savingSource = true;
    this.failure = "";
    this.render();
    try {
      await this.host.saveSource(this.sourcePath, this.draft, this.expectedSource);
      this.editing = false;
      this.draft = "";
      unsavedDrafts.get(this.host)?.delete(this.sourcePath);
      await this.refresh();
    } catch (error) { this.failure = diaryError(error); }
    finally { this.savingSource = false; this.render(); }
  }

  private async reviewPrivacy(): Promise<void> {
    if (!this.source || this.editing) return;
    const source = await this.host.api.readSource(this.sourcePath);
    await reviewDiaryPrivacy(this.app, source.content, this.record?.privacy ?? null, (privacy) => this.host.api.savePrivacy(this.sourcePath, privacy), this.host.api.access ?? unavailableCapabilityAccess);
    await this.refresh();
  }

  private async generate(): Promise<void> {
    if (this.generating || this.editing || !this.host.enabled()) return;
    this.generating = true;
    this.stage = "正在生成…";
    this.failure = "";
    this.render();
    try {
      this.record = await this.host.generate(this.sourcePath, { onStage: (stage) => {
        this.stage = stage === "generating" ? "正在生成…" : stage === "saving" ? "正在保存…" : "正在恢复…";
        this.render();
      } });
    } catch (error) {
      if ((error as { code?: string })?.code === "english_diary_privacy_review_required") {
        this.generating = false;
        await this.reviewPrivacy();
        this.failure = "请确认发送范围后，再次生成英文。";
      } else if ((error as { code?: string })?.code === "english_diary_cancelled") this.failure = "已停止，本次未发布的生成不会替换已有结果。";
      else this.failure = diaryError(error);
    } finally {
      this.generating = false;
      this.stage = "";
      if (!this.closed) await this.refresh();
    }
  }
}
