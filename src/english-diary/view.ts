import { showEchoInkMenu } from "../ui/theme-boundary";
import { getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { Component, ItemView, MarkdownRenderer, Menu, Notice, Platform, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { textInputModal } from "../ui/modals";
import { fingerprint } from "./model";
import { reviewDiaryPrivacy } from "./privacy-modal";
import { ENGLISH_DIARY_VIEW, type DiaryAlignment, type DiaryExpression, type DiaryRecord, type DiarySource } from "./types";
import type { EnglishDiaryViewHost } from "./view-host";
import { diaryButton, diaryError, diaryField, hasExactAlignment } from "./ui";
import { diaryReadingBody, markDiaryReadingBlock, renderDiaryReading } from "./reading-renderer";

type ExpressionFilter = "all" | "phrase" | "sentence";
type DiaryViewState = { sourcePath?: string };
let diaryViewSequence = 0;
let diaryMarkSequence = 0;

/** The original belongs to its native Markdown leaf; this pane only reads results. */
export class EnglishDiaryView extends ItemView {
  private sourcePath = "";
  private source: DiarySource | null = null;
  private record: DiaryRecord | null = null;
  private generating = false;
  private stage = "";
  private failure = "";
  private loadFailure = "";
  private filter: ExpressionFilter = "all";
  private selectedAlignment: string | null = null;
  private hoveredAlignment: string | null = null;
  private selectedExpression: string | null = null;
  private refreshSequence = 0;
  private renderSequence = 0;
  private refreshTimer: number | null = null;
  private closed = false;
  private markdown: Component | null = null;
  private explanationEl: HTMLElement | null = null;
  private explanationAnchor: HTMLElement | null = null;
  private alignmentAnchors = new Map<string, HTMLElement>();
  private readonly explanationId = `echoink-diary-explanation-${++diaryViewSequence}`;

  constructor(leaf: WorkspaceLeaf, private readonly host: EnglishDiaryViewHost) { super(leaf); }
  getViewType(): string { return ENGLISH_DIARY_VIEW; }
  getDisplayText(): string { return this.source?.title ? `${this.source.title} · 英文日记` : "英文日记"; }
  getIcon(): string { return "languages"; }
  getState(): DiaryViewState { return { sourcePath: this.sourcePath }; }

  async setState(state: DiaryViewState, result: ViewStateResult): Promise<void> {
    const path = typeof state?.sourcePath === "string" ? state.sourcePath : "";
    if (path !== this.sourcePath) {
      this.host.api.cancel(this.sourcePath);
      this.sourcePath = path;
      this.source = null;
      this.record = null;
      this.selectedAlignment = null;
      this.selectedExpression = null;
      this.failure = "";
      this.loadFailure = "";
    }
    await this.refresh();
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
    this.registerDomEvent(this.contentEl.ownerDocument, "keydown", (event) => {
      if (event.key === "Escape" && this.selectedAlignment && !event.defaultPrevented && !(event.target as HTMLElement).closest?.(".modal-container,.menu,.popover")) this.clearAlignment();
    });
    this.registerDomEvent(this.contentEl, "click", (event) => {
      if (!(event.target as HTMLElement).closest("button, a, input, textarea, summary, .echoink-diary-mark, .echoink-diary-expression, .echoink-diary-alignment-note")) this.clearAlignment();
    });
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.refreshSequence++;
    this.renderSequence++;
    this.host.api.cancel(this.sourcePath);
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.disposeMarkdown();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private disposeMarkdown(): void {
    if (this.markdown) this.removeChild(this.markdown);
    this.markdown = null;
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, 150);
  }

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    if (!this.sourcePath) { this.render(); return; }
    try {
      const source = await this.host.api.readSource(this.sourcePath);
      const record = await this.host.api.load(this.sourcePath);
      if (sequence !== this.refreshSequence || this.closed) return;
      this.source = source;
      this.record = record;
      this.loadFailure = "";
      if (!this.canAlign()) this.clearAlignment();
    } catch (error) {
      if (sequence !== this.refreshSequence || this.closed) return;
      this.loadFailure = diaryError(error);
      this.clearAlignment();
    }
    this.render();
  }

  private writable(): boolean { return this.host.enabled() && getProPluginAccess(this.host.api.access ?? unavailableCapabilityAccess, this.host.enabled()).canWrite; }
  private canGenerate(): boolean { return this.writable() && !Platform.isMobile && !!this.source?.content.trim() && !this.loadFailure; }
  private sourceChanged(): boolean { return !!this.record?.result && !!this.source && fingerprint(this.source.content) !== this.record.result.sourceFingerprint; }
  private running(): boolean { return this.generating || this.host.api.isGenerating(this.sourcePath); }

  private canAlign(): boolean {
    const result = this.record?.result;
    return !!result && !!this.source && !this.loadFailure && !this.sourceChanged() && !this.record?.englishModified && !this.record?.missingEnglish && fingerprint(result.english) === result.englishFingerprint;
  }

  private reliableAlignments(): DiaryAlignment[] {
    if (!this.canAlign()) return [];
    return this.record!.result!.alignments.filter((alignment) => hasExactAlignment(alignment, this.source!.content, this.record!.result!.english));
  }

  private render(): void {
    if (this.closed) return;
    const sequence = ++this.renderSequence;
    const scroll = this.contentEl.scrollTop;
    this.disposeMarkdown();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.alignmentAnchors.clear();
    this.explanationEl = null;
    this.explanationAnchor = null;
    const page = this.contentEl.createDiv({ cls: "echoink-diary-page" });
    if (!this.sourcePath) {
      page.createEl("h2", { cls: "echoink-diary-title", text: "英文日记" });
      page.createDiv({ cls: "echoink-diary-empty", text: "从首页“写日记”选择“英文”，或运行“英文日记：打开今天的日记”。" });
      diaryButton(page, "表达库", () => this.host.openLibrary());
      return;
    }
    this.renderHeader(page);
    this.renderStatus(page);
    if (!this.source && !this.record?.result) return;
    this.renderEnglish(page, sequence);
    this.renderExpressions(page);
    this.updateAlignmentHighlight();
    this.contentEl.scrollTop = scroll;
  }

  private renderHeader(page: HTMLElement): void {
    const header = page.createDiv({ cls: "echoink-diary-header" });
    header.createEl("h2", { cls: "echoink-diary-title", text: this.source?.title || "英文日记" });
    const actions = header.createDiv({ cls: "echoink-diary-actions" });
    const more = diaryButton(actions, "", () => {
      const rect = more.getBoundingClientRect();
      const menu = this.headerMenu();
      showEchoInkMenu(more.ownerDocument, () => menu.showAtPosition({ x: rect.right, y: rect.bottom }, more.ownerDocument));
    }, { icon: true, label: "更多操作" });
    more.setAttribute("aria-haspopup", "menu");
    setIcon(more, "ellipsis");
    if (this.running()) {
      actions.createSpan({ cls: "echoink-diary-generation-stage", text: this.stage || "正在生成…", attr: { role: "status" } });
      const stop = diaryButton(actions, "停止", () => { this.host.api.cancel(this.sourcePath); this.stage = "正在停止…"; this.render(); }, { primary: true, disabled: this.stage === "正在停止…" });
      applyAmicroButton(stop, { variant: "primary" });
      setAmicroButtonPending(stop, true);
      return;
    }
    const result = this.record?.result;
    const latest = !!result && !this.sourceChanged() && !this.record?.pending;
    if (latest) {
      diaryButton(actions, "复制英文", async () => {
        await this.contentEl.ownerDocument.defaultView!.navigator.clipboard.writeText(diaryReadingBody(result.english).markdown);
        new Notice("已复制英文。");
      });
    } else {
      diaryButton(actions, result ? "更新英文" : "生成英文", () => this.generate(), { primary: true, disabled: !this.canGenerate() });
    }
  }

  private headerMenu(): Menu {
    const menu = new Menu();
    const action = (callback: () => Promise<void>) => () => { void callback().catch((error) => new Notice(diaryError(error))); };
    menu.addItem((item) => item.setTitle("重新生成").setIcon("refresh-cw").setDisabled(this.running() || !this.canGenerate() || !this.record?.result).onClick(action(() => this.generate(true))));
    if (this.record?.missingEnglish) menu.addItem((item) => item.setTitle("恢复英文文件").setIcon("file-plus").setDisabled(this.running() || !this.writable()).onClick(action(async () => { await this.host.api.restore(this.sourcePath); await this.refresh(); })));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("表达库").setIcon("book-open").onClick(action(() => this.host.openLibrary())));
    menu.addItem((item) => item.setTitle("发送范围").setIcon("shield").setDisabled(this.running() || !this.source || !this.writable()).onClick(action(() => this.reviewPrivacy())));
    menu.addItem((item) => item.setTitle("整理想法").setIcon("message-square").setDisabled(!this.host.enabled()).onClick(action(() => this.host.organizeThoughts(this.sourcePath))));
    return menu;
  }

  private renderStatus(page: HTMLElement): void {
    const error = this.failure || this.loadFailure;
    const text = error || (this.record?.englishModified ? "英文文件被外部修改。下方保留生成时的英文，来源定位已暂停；更新前请先备份需要保留的手工内容。"
      : this.record?.missingEnglish ? "英文文件已移除，可从更多操作恢复已保存的结果，无需再次调用模型。"
      : this.sourceChanged() ? "原稿已改变，下方英文和表达来自上次生成。更新成功前保留旧结果，来源定位暂不可用。"
      : !this.host.enabled() ? "英文日记已关闭，已有英文和表达仍可查看。"
      : Platform.isMobile ? "英文生成仅在桌面端可用，已有英文和表达仍可查看。"
      : !this.writable() ? "需要 PRO 才能生成；已有英文和表达仍可查看。"
      : this.record?.pending && !this.generating ? "上次保存尚未完成，可继续保存已有生成结果。" : "");
    if (!text) return;
    const notice = page.createDiv({ cls: `echoink-diary-notice${error ? " is-error" : ""}`, attr: error ? { role: "alert" } : { role: "status" } });
    notice.createSpan({ text });
    if (this.loadFailure) diaryButton(notice, "重新读取", () => this.refresh());
  }

  private renderEnglish(page: HTMLElement, sequence: number): void {
    const section = page.createEl("section", { cls: "echoink-diary-english" });
    const body = section.createDiv({ cls: "echoink-diary-reading markdown-rendered", attr: { lang: "en" } });
    this.explanationEl = section.createDiv({ cls: "echoink-diary-alignment-note", attr: { id: this.explanationId, "aria-live": "polite", lang: "zh" } });
    this.explanationEl.hidden = true;
    if (!this.record?.result) {
      body.createDiv({ cls: "echoink-diary-empty", text: this.running() ? "正在生成英文…" : "原稿准备好后，生成这篇日记的英文。" });
      return;
    }
    const result = this.record.result;
    const alignments = this.reliableAlignments().sort((a, b) => Number(b.kind === "correction") - Number(a.kind === "correction"));
    const markdown = new Component();
    this.markdown = markdown;
    this.addChild(markdown);
    const current = () => !this.closed && sequence === this.renderSequence;
    void renderDiaryReading(body, result.english, async (text, container) => {
      const component = container === body ? markdown : new Component();
      if (component !== markdown) component.load();
      try { await MarkdownRenderer.render(this.app, text, container, this.sourcePath, component); }
      finally { if (component !== markdown) component.unload(); }
    }, current).then((blocks) => {
      if (!current()) return;
      for (const block of blocks) markDiaryReadingBlock(block, alignments, (mark, ids, anchor) => this.decorateMark(mark, ids, anchor));
      const after = new Map<HTMLElement, HTMLElement>();
      for (const alignment of [...alignments].sort((a, b) => Number(b.kind === "correction") - Number(a.kind === "correction"))) {
        const visibleRanges = alignment.target.filter((range) => range.end > diaryReadingBody(result.english).start);
        const related = blocks.filter((block) => visibleRanges.some((range) => range.start < block.end && range.end > block.start));
        if (!related.length || related.every((block) => block.element?.matches("h1,h2,h3,h4,h5,h6"))) continue;
        const covered = visibleRanges.every((range) => blocks.some((block) => block.exactText && block.element && range.start >= block.start && range.end <= block.end));
        if (covered) continue;
        const block = related.find((entry) => entry.element && !entry.element.matches("h1,h2,h3,h4,h5,h6"));
        const anchor = block?.element ?? body.lastElementChild as HTMLElement | null;
        if (!anchor) continue;
        let list = after.get(anchor);
        if (!list) {
          list = body.ownerDocument.createElement("div");
          list.className = "echoink-diary-comparisons";
          list.lang = "zh";
          anchor.after(list);
          after.set(anchor, list);
        }
        const button = diaryButton(list, `${this.alignmentLabel(alignment)}：${alignment.target.map((range) => range.text).join(" … ")}`, () => this.selectAlignment(alignment.id, false, list), { tertiary: true });
        button.addClass("echoink-diary-comparison");
        button.dataset.alignmentIds = JSON.stringify([alignment.id]);
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", this.explanationId);
        this.alignmentAnchors.set(alignment.id, list);
      }
      if (this.selectedAlignment) this.explanationAnchor = this.alignmentAnchors.get(this.selectedAlignment) ?? null;
      this.updateAlignmentHighlight();
    }).catch((error) => {
      if (!current()) return;
      this.failure = diaryError(error);
      page.querySelector(":scope > .echoink-diary-notice")?.remove();
      const notice = page.createDiv({ cls: "echoink-diary-notice is-error", text: this.failure, attr: { role: "alert" } });
      page.querySelector(".echoink-diary-header")?.after(notice);
    });
    if (result.warnings.length) {
      const warnings = section.createEl("details", { cls: "echoink-diary-warnings" });
      warnings.createEl("summary", { text: `${result.warnings.length} 条结果提示` });
      for (const warning of result.warnings) warnings.createEl("p", { text: warning });
    }
  }

  private decorateMark(mark: HTMLElement, ids: string[], anchor: HTMLElement): void {
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-pressed", "false");
    mark.setAttribute("aria-controls", this.explanationId);
    mark.dataset.alignmentIds = JSON.stringify(ids);
    const label = mark.ownerDocument.createElement("span");
    label.id = `${this.explanationId}-mark-${++diaryMarkSequence}`;
    label.textContent = mark.textContent;
    mark.replaceChildren(label);
    mark.setAttribute("aria-labelledby", label.id);
    const help = `${this.explanationId}-mark-help`;
    mark.setAttribute("aria-describedby", help);
    if (!this.contentEl.querySelector(`#${help}`)) this.contentEl.createSpan({ cls: "echoink-diary-sr-only", text: "按回车对照原稿，按 Escape 收起说明。", attr: { id: help } });
    const alignment = this.reliableAlignments().find((entry) => entry.id === ids[0]);
    if (alignment?.reason) setTooltip(mark, alignment.reason, { placement: "top", classes: ["echoink-diary-tooltip"], delay: 250 });
    ids.forEach((id) => { if (!this.alignmentAnchors.has(id)) this.alignmentAnchors.set(id, anchor); });
    mark.addEventListener("pointerenter", () => { this.hoveredAlignment = ids[0]; this.updateAlignmentHighlight(); });
    mark.addEventListener("pointerleave", () => { this.hoveredAlignment = null; this.updateAlignmentHighlight(); });
    mark.addEventListener("focus", () => { this.hoveredAlignment = ids[0]; this.updateAlignmentHighlight(); });
    mark.addEventListener("blur", () => { this.hoveredAlignment = null; this.updateAlignmentHighlight(); });
    mark.addEventListener("click", (event) => { event.stopPropagation(); this.selectAlignment(ids[0], false, anchor); });
    mark.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); this.selectAlignment(ids[0], false, anchor); }
    });
  }

  private renderExpressions(page: HTMLElement): void {
    const section = page.createEl("section", { cls: "echoink-diary-expressions" });
    const header = section.createDiv({ cls: "echoink-diary-section-header" });
    header.createEl("h3", { text: "本篇表达收获" });
    const filters = header.createDiv({ cls: "echoink-diary-filters", attr: { role: "group", "aria-label": "表达类型" } });
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
    const more = diaryButton(header, "", () => {
      const rect = more.getBoundingClientRect();
      const menu = this.expressionMenu(expression);
      showEchoInkMenu(more.ownerDocument, () => menu.showAtPosition({ x: rect.right, y: rect.bottom }, more.ownerDocument));
    }, { icon: true, label: "表达操作", disabled: !this.writable() });
    more.addClass("echoink-diary-expression-menu");
    more.setAttribute("aria-haspopup", "menu");
    setIcon(more, "ellipsis");
    card.createDiv({ cls: "echoink-diary-meaning", text: expression.meaning });
    diaryField(card, "本篇场景", expression.scene);
    diaryField(card, "拓展例句", expression.example, "is-example");
    const canLocate = expression.status === "verified" && !!expression.alignmentId && this.reliableAlignments().some((alignment) => alignment.id === expression.alignmentId);
    card.tabIndex = 0;
    title.querySelector("h4")!.id = `${this.explanationId}-expression-${expression.id}`;
    card.setAttribute("aria-labelledby", title.querySelector("h4")!.id);
    const help = `${this.explanationId}-expression-help-${expression.id}`;
    card.createSpan({ cls: "echoink-diary-sr-only", text: `${canLocate ? "按回车定位原文。" : ""}按 Shift+F10 打开表达操作。`, attr: { id: help } });
    card.setAttribute("aria-describedby", help);
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu=this.expressionMenu(expression);
      showEchoInkMenu(card.ownerDocument,()=>menu.showAtMouseEvent(event));
    });
    card.addEventListener("keydown", (event) => {
      if (event.target === card && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        event.stopPropagation();
        const rect = card.getBoundingClientRect();
        const menu=this.expressionMenu(expression);
        showEchoInkMenu(card.ownerDocument,()=>menu.showAtPosition({ x: rect.left + 12, y: rect.top + 12 }, card.ownerDocument));
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
        if ((event.target as HTMLElement).closest("button,a,input,textarea")) return;
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

  private selectAlignment(id: string, locate = false, anchor?: HTMLElement): void {
    const alignment = this.reliableAlignments().find((entry) => entry.id === id);
    if (!alignment) return;
    this.selectedAlignment = this.selectedAlignment === id && !locate ? null : id;
    if (!this.selectedAlignment) this.selectedExpression = null;
    this.hoveredAlignment = null;
    this.explanationAnchor = anchor ?? this.alignmentAnchors.get(id) ?? null;
    this.updateAlignmentHighlight();
    if (!this.selectedAlignment) return;
    const sourcePath = this.sourcePath;
    void this.host.focusSource(sourcePath, alignment.source, { expectedFingerprint: this.record!.result!.sourceFingerprint }).catch((error) => {
      if (!this.closed && this.sourcePath === sourcePath) { this.failure = diaryError(error); void this.refresh(); }
    });
    if (locate) this.explanationEl?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  private clearAlignment(): void { this.selectedAlignment = null; this.hoveredAlignment = null; this.selectedExpression = null; this.updateAlignmentHighlight(); }
  private markIds(element: HTMLElement): string[] { try { return JSON.parse(element.dataset.alignmentIds ?? "[]") as string[]; } catch { return []; } }

  private updateAlignmentHighlight(): void {
    const id = this.canAlign() ? this.hoveredAlignment ?? this.selectedAlignment : null;
    this.contentEl.querySelectorAll<HTMLElement>("[data-alignment-ids]").forEach((element) => {
      const selected = !!this.selectedAlignment && this.markIds(element).includes(this.selectedAlignment);
      element.toggleClass("is-emphasized", !!id && this.markIds(element).includes(id));
      if (element.classList.contains("echoink-diary-mark")) element.setAttribute("aria-pressed", String(selected));
      else element.setAttribute("aria-expanded", String(selected));
    });
    this.contentEl.querySelectorAll<HTMLElement>(".echoink-diary-expression").forEach((element) => element.toggleClass("is-selected", element.dataset.expressionId === this.selectedExpression));
    if (!this.explanationEl) return;
    const alignment = this.selectedAlignment ? this.reliableAlignments().find((entry) => entry.id === this.selectedAlignment) : null;
    this.explanationEl.hidden = !alignment;
    if (!alignment) {
      this.explanationEl.removeAttribute("data-alignment-id");
      disposeOriginControls(this.explanationEl);
      this.explanationEl.empty();
      return;
    }
    const anchor = this.explanationAnchor ?? this.alignmentAnchors.get(alignment.id);
    if (anchor && anchor.nextElementSibling !== this.explanationEl) anchor.after(this.explanationEl);
    if (this.explanationEl.dataset.alignmentId === alignment.id) return;
    this.explanationEl.dataset.alignmentId = alignment.id;
    disposeOriginControls(this.explanationEl);
    this.explanationEl.empty();
    const copy = this.explanationEl.createDiv({ cls: "echoink-diary-alignment-copy" });
    copy.createSpan({ cls: "echoink-diary-label", text: this.alignmentLabel(alignment) });
    copy.createSpan({ text: alignment.reason });
    const change = copy.createDiv({ cls: "echoink-diary-change" });
    change.createSpan({ text: `原文：${alignment.source.map((range) => range.text).join(" … ")}` });
    change.createSpan({ text: `英文：${alignment.target.map((range) => range.text).join(" … ")}` });
    diaryButton(this.explanationEl, "收起", () => this.clearAlignment(), { tertiary: true });
  }

  private alignmentLabel(alignment: DiaryAlignment): string { return alignment.kind === "translation" ? "这里为什么用" : alignment.kind === "correction" ? "英文修正" : "衔接调整"; }

  private async reviewPrivacy(): Promise<void> {
    if (!this.source || this.running()) return;
    const source = await this.host.api.readSource(this.sourcePath);
    await reviewDiaryPrivacy(this.app, source.content, this.record?.privacy ?? null, (privacy) => this.host.api.savePrivacy(this.sourcePath, privacy), this.host.api.access ?? unavailableCapabilityAccess);
    await this.refresh();
  }

  private async generate(force = false): Promise<void> {
    if (this.running() || !this.canGenerate()) return;
    const path = this.sourcePath;
    this.generating = true;
    this.stage = "正在生成…";
    this.failure = "";
    this.render();
    try {
      const record = await this.host.generate(path, { force, onStage: (stage) => {
        if (this.sourcePath !== path || this.closed) return;
        this.stage = stage === "generating" ? "正在生成…" : stage === "saving" ? "正在保存…" : "正在恢复…";
        this.render();
      } });
      if (this.sourcePath === path && !this.closed) this.record = record;
    } catch (error) {
      if (this.sourcePath !== path || this.closed) return;
      if ((error as { code?: string })?.code === "english_diary_privacy_review_required") {
        this.generating = false;
        await this.reviewPrivacy();
        this.failure = "请确认发送范围后，再次生成英文。";
      } else if ((error as { code?: string })?.code === "english_diary_cancelled") this.failure = "已停止，已有结果保留。";
      else this.failure = diaryError(error);
    } finally {
      this.generating = false;
      this.stage = "";
      if (!this.closed && this.sourcePath === path) await this.refresh();
    }
  }
}
