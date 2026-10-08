import { capabilityMessage, unavailableCapabilityAccess } from "../membership/access";
import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { createOriginInput, disposeOriginControls } from "../settings/origin-controls";
import { confirmModal } from "../ui/modals";
import { ENGLISH_EXPRESSION_VIEW, type DiaryGenerationDay, type ExpressionEntry, type ExpressionOccurrence } from "./types";
import type { EnglishDiaryViewHost } from "./view-host";
import { diaryButton, diaryError, diaryField } from "./ui";
import { renderDiaryProgress } from "./activity";

type ExpressionViewState = { query?: string; category?: string; expressionId?: string };
interface ExpressionDraft { id: string; category: string; note: string; initialCategory: string; initialNote: string }
const unsavedExpressionDrafts = new WeakMap<EnglishDiaryViewHost, ExpressionDraft>();

/** Searches and renders saved expression records; this view adds no learning state. */
export class EnglishExpressionView extends ItemView {
  private query = "";
  private category = "";
  private selectedId = "";
  private entries: ExpressionEntry[] = [];
  private allEntries: ExpressionEntry[] = [];
  private activity: DiaryGenerationDay[] | null = null;
  private categories: Array<{ name: string; count: number }> = [];
  private selected: ExpressionEntry | null = null;
  private draft: ExpressionDraft | null = null;
  private error = "";
  private loading = false;
  private saving = false;
  private editingMetadata = false;
  private closed = false;
  private refreshSequence = 0;
  private timer: number | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly host: EnglishDiaryViewHost) { super(leaf); }
  getViewType(): string { return ENGLISH_EXPRESSION_VIEW; }
  getDisplayText(): string { return "表达库"; }
  getIcon(): string { return "book-open"; }
  getState(): ExpressionViewState { return { query: this.query, category: this.category, expressionId: this.selectedId }; }

  async setState(state: ExpressionViewState, result: ViewStateResult): Promise<void> {
    this.query = typeof state?.query === "string" ? state.query : "";
    this.category = typeof state?.category === "string" ? state.category : "";
    this.selectedId = typeof state?.expressionId === "string" ? state.expressionId : this.selectedId;
    await this.refresh();
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.register((this.host.api.access ?? unavailableCapabilityAccess).subscribe(() => this.render()));
    this.contentEl.addClass("echoink-diary-view", "echoink-expression-view");
    const retained = unsavedExpressionDrafts.get(this.host);
    if (retained) { this.selectedId = retained.id; this.draft = { ...retained }; this.editingMetadata = true; }
    const changed = () => this.scheduleRefresh();
    const unsubscribe = this.host.api.repository.subscribe?.(changed);
    if (unsubscribe) this.register(unsubscribe);
    this.registerEvent(this.app.vault.on("modify", changed));
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("delete", changed));
    this.registerEvent(this.app.vault.on("rename", changed));
    await this.refresh();
  }

  async onClose(): Promise<void> {
    if (this.isDirty() && this.draft) {
      unsavedExpressionDrafts.set(this.host, { ...this.draft });
      new Notice("未保存的分类和备注已暂存在本次会话，重新打开可继续。退出 Obsidian 前请保存。", 8000);
    }
    this.closed = true;
    this.refreshSequence++;
    if (this.timer !== null) window.clearTimeout(this.timer);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; void this.refresh(); }, 200);
  }

  async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    this.loading = true;
    try {
      const [all, activity] = await Promise.all([
        this.host.api.repository.listExpressions(),
        this.host.api.repository.listGenerationActivity().catch(() => null)
      ]);
      const entries = this.query || this.category ? await this.host.api.repository.listExpressions(this.query, this.category || undefined) : all;
      if (this.closed || sequence !== this.refreshSequence) return;
      this.entries = entries;
      this.allEntries = all;
      this.activity = activity;
      const counts = new Map<string, number>();
      for (const entry of all) counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
      this.categories = [...counts].map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
      this.selected = all.find((entry) => entry.id === this.selectedId) ?? null;
      if (this.selected && (!this.draft || this.draft.id !== this.selected.id || !this.isDirty())) this.resetDraft(this.selected);
      this.error = "";
    } catch (error) {
      if (this.closed || sequence !== this.refreshSequence) return;
      this.error = diaryError(error);
    } finally {
      if (!this.closed && sequence === this.refreshSequence) { this.loading = false; this.render(); }
    }
  }

  private resetDraft(entry: ExpressionEntry): void {
    this.draft = { id: entry.id, category: entry.category, note: entry.note, initialCategory: entry.category, initialNote: entry.note };
    if (unsavedExpressionDrafts.get(this.host)?.id === entry.id) unsavedExpressionDrafts.delete(this.host);
  }

  private isDirty(): boolean { return !!this.draft && (this.draft.category !== this.draft.initialCategory || this.draft.note !== this.draft.initialNote); }

  private render(): void {
    if (this.closed) return;
    const active = this.contentEl.ownerDocument.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const field = active?.dataset.expressionField;
    const focusedCategory = active?.dataset.expressionCategory;
    const selection = field ? { start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop } : null;
    const scroll = this.contentEl.scrollTop;
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    const page = this.contentEl.createDiv({ cls: "echoink-diary-page" });
    const header = page.createDiv({ cls: "echoink-diary-header" });
    if (this.selectedId) {
      header.addClass("echoink-expression-detail-nav");
      diaryButton(header, "返回表达库", () => this.back(), { tertiary: true });
    } else {
      header.createEl("h2", { cls: "echoink-diary-title", text: "表达库" });
      if (this.query || this.category) header.createSpan({ cls: "echoink-diary-count", text: `显示 ${this.entries.length} 个表达` });
    }
    const notice = capabilityMessage(this.host.api.access ?? unavailableCapabilityAccess, "diary.expression.write");
    if (notice) page.createDiv({ cls: "echoink-diary-notice", text: `已有表达可检索和查看。${notice}` });
    if (this.error) {
      const error = page.createDiv({ cls: "echoink-diary-notice is-error", attr: { role: "alert" } });
      error.createSpan({ text: this.error });
      diaryButton(error, "重试", () => this.refresh());
    }
    if (this.selectedId) {
      if (this.selected) this.renderDetail(page, this.selected);
      else page.createDiv({ cls: "echoink-diary-empty", text: "这个表达已移除，或暂时无法读取。" });
    } else {
      this.renderProgress(page);
      this.renderSearch(page);
      this.renderList(page);
    }
    this.contentEl.scrollTop = scroll;
    if (field && selection) {
      const next = this.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-expression-field="${field}"]`);
      next?.focus({ preventScroll: true });
      if (selection.start !== null && selection.end !== null) next?.setSelectionRange(selection.start, selection.end);
      if (next) next.scrollTop = selection.scroll;
    }
    if (focusedCategory !== undefined) Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-expression-category]"))
      .find((button) => button.dataset.expressionCategory === focusedCategory)?.focus({ preventScroll: true });
  }

  private renderProgress(page: HTMLElement): void {
    if (this.activity && (this.host.api.access ?? unavailableCapabilityAccess).checkCapability("diary.timeline.generate")) renderDiaryProgress(page, this.activity, this.allEntries.length);
    else page.createDiv({ cls: "echoink-diary-description", text: `已收录 ${this.allEntries.length} 个表达 · 打卡记录暂时无法读取` });
  }

  private renderSearch(page: HTMLElement): void {
    const browserTools = page.createDiv({ cls: "echoink-expression-browser-tools" });
    const tools = browserTools.createDiv({ cls: "echoink-expression-tools" });
    const search = createOriginInput(tools, { cls: "echoink-expression-search", value: this.query, attr: { type: "search", placeholder: "搜索表达、意思、日期或日记", "aria-label": "搜索表达库" } });
    search.dataset.expressionField = "search";
    const searchChanged = () => { this.query = search.value; this.app.workspace.requestSaveLayout(); this.scheduleRefresh(); };
    search.addEventListener("input", (event) => { if (!(event as InputEvent).isComposing) searchChanged(); });
    search.addEventListener("compositionend", searchChanged);
    const categories = browserTools.createDiv({ cls: "echoink-diary-filters echoink-expression-categories", attr: { role: "group", "aria-label": "按分类筛选" } });
    for (const category of [{ name: "", count: this.allEntries.length }, ...this.categories]) {
      const button = diaryButton(categories, "", async () => {
        this.category = category.name;
        this.app.workspace.requestSaveLayout();
        await this.refresh();
      }, { tertiary: true });
      button.dataset.expressionCategory = category.name;
      button.setAttribute("aria-pressed", String(this.category === category.name));
      button.toggleClass("is-selected", this.category === category.name);
      button.createSpan({ text: category.name || "全部分类" });
      button.createSpan({ cls: "echoink-diary-count", text: String(category.count) });
    }
  }

  private renderList(page: HTMLElement): void {
    if (!this.entries.length) {
      page.createDiv({ cls: "echoink-diary-empty", text: this.loading ? "正在读取表达…" : this.query || this.category ? "没有匹配的表达。" : "生成英文日记后，表达会自动收录到这里。" });
      return;
    }
    const list = page.createDiv({ cls: "echoink-expression-list" });
    for (const entry of this.entries) {
      const row = diaryButton(list, "", () => this.openEntry(entry.id), { label: `查看表达：${entry.term}` });
      row.addClass("echoink-expression-list-item");
      row.createSpan({ cls: "echoink-expression-list-title", text: entry.term, attr: { lang: "en" } });
      const metadata = row.createSpan({ cls: "echoink-diary-row" });
      metadata.createSpan({ cls: "echoink-diary-badge", text: entry.type === "phrase" ? "短语" : "短句" });
      metadata.createSpan({ cls: "echoink-diary-category", text: entry.category || "未分类" });
      metadata.createSpan({ cls: "echoink-diary-count", text: `${entry.occurrences.length} 次收录` });
      row.createSpan({ cls: "echoink-diary-meaning", text: entry.meaning });
      if (entry.note) row.createSpan({ cls: "echoink-expression-note-preview", text: entry.note });
    }
  }

  private renderDetail(page: HTMLElement, entry: ExpressionEntry): void {
    const summary = page.createEl("section", { cls: "echoink-expression-summary" });
    const heading = summary.createDiv({ cls: "echoink-expression-dictionary-heading" });
    heading.createEl("h2", { cls: "echoink-diary-title", text: entry.term, attr: { lang: "en" } });
    heading.createSpan({ cls: "echoink-diary-badge", text: entry.type === "phrase" ? "短语" : "短句" });
    summary.createDiv({ cls: "echoink-expression-dictionary-meaning", text: entry.meaning });
    const metadata = summary.createDiv({ cls: "echoink-expression-metadata" });
    metadata.createSpan({ cls: "echoink-diary-category", text: entry.category || "未分类" });
    const edit = diaryButton(metadata, this.editingMetadata ? "收起编辑" : this.isDirty() ? "继续编辑分类与备注" : "分类与备注", () => {
      this.editingMetadata = !this.editingMetadata;
      this.render();
    }, { tertiary: true, disabled: !(this.host.api.access ?? unavailableCapabilityAccess).checkCapability("diary.expression.write") });
    edit.setAttribute("aria-expanded", String(this.editingMetadata));

    const usage = savedExpressionUsage(entry.occurrences);
    const usageSummary = summary.createDiv({ cls: "echoink-expression-usage-summary" });
    usageSummary.createEl("h3", { text: "使用摘要" });
    usageSummary.createEl("p", { text: usage || "还没有已确认的用法说明。" });
    const examples = savedExpressionExamples(entry.occurrences);
    if (examples.length) {
      const exampleSection = usageSummary.createDiv({ cls: "echoink-expression-summary-examples" });
      exampleSection.createSpan({ cls: "echoink-diary-label", text: "拓展例句" });
      const renderExample = (container: HTMLElement, item: { example: string; usage: string }) => {
        if (item.usage && normalizedExpressionText(item.usage) !== normalizedExpressionText(usage ?? "")) {
          container.createEl("p", { cls: "echoink-expression-example-usage", text: item.usage });
        }
        container.createEl("p", { cls: "echoink-expression-summary-example", text: item.example, attr: { lang: "en" } });
      };
      renderExample(exampleSection, examples[0]);
      if (examples.length > 1) {
        const additional = exampleSection.createEl("details", { cls: "echoink-expression-additional-examples" });
        additional.createEl("summary", { text: `其它例句（${examples.length - 1}）` });
        for (const example of examples.slice(1)) renderExample(additional.createDiv({ cls: "echoink-expression-additional-example" }), example);
      }
    }
    if (entry.note) {
      const note = summary.createDiv({ cls: "echoink-expression-personal-note" });
      note.createSpan({ cls: "echoink-diary-label", text: "我的备注" });
      note.createDiv({ text: entry.note });
    }
    if (this.editingMetadata) this.renderEditForm(summary, entry);

    const section = page.createEl("section", { cls: "echoink-expression-occurrences" });
    const occurrenceHeader = section.createDiv({ cls: "echoink-diary-section-header" });
    occurrenceHeader.createEl("h3", { text: "使用记录" });
    occurrenceHeader.createSpan({ cls: "echoink-diary-count", text: `${entry.occurrences.length} 次收录` });
    if (!entry.occurrences.length) {
      section.createDiv({ cls: "echoink-diary-empty", text: "还没有保留的使用记录，词条与备注仍在这里。" });
      return;
    }
    const timeline = section.createDiv({ cls: "echoink-expression-timeline" });
    for (const group of ((this.host.api.access ?? unavailableCapabilityAccess).checkCapability("diary.timeline.generate") ? groupExpressionOccurrences(entry.occurrences) : entry.occurrences.map(occurrence => ({ date: occurrence.date, occurrences: [occurrence] })))) {
      const day = timeline.createDiv({ cls: "echoink-expression-timeline-day" });
      const date = day.createDiv({ cls: "echoink-expression-timeline-date" });
      date.createEl("time", { text: group.date || "日期未记录", attr: group.date ? { datetime: group.date } : {} });
      const items = day.createDiv({ cls: "echoink-expression-timeline-items" });
      for (const occurrence of group.occurrences) this.renderOccurrence(items, entry, occurrence);
    }
  }

  private renderEditForm(parent: HTMLElement, entry: ExpressionEntry): void {
    if (!this.draft || this.draft.id !== entry.id) this.resetDraft(entry);
    const draft = this.draft!;
    const form = parent.createDiv({ cls: "echoink-expression-edit" });
    const categoryLabel = form.createEl("label", { cls: "echoink-diary-form-field" });
    categoryLabel.createSpan({ cls: "echoink-diary-label", text: "分类" });
    const category = createOriginInput(categoryLabel, { value: draft.category, attr: { "aria-label": "表达分类", placeholder: "输入分类，也可自定义" } });
    category.dataset.expressionField = "category";
    const noteLabel = form.createEl("label", { cls: "echoink-diary-form-field" });
    noteLabel.createSpan({ cls: "echoink-diary-label", text: "我的备注" });
    const note = noteLabel.createEl("textarea", { cls: "echoink-expression-note", attr: { "aria-label": "我的备注", placeholder: "记下自己的理解或用法" } });
    note.value = draft.note;
    note.dataset.expressionField = "note";
    if (entry.category !== draft.initialCategory || entry.note !== draft.initialNote) form.createDiv({ cls: "echoink-diary-notice", text: "词条在其它位置有更新，当前填写内容已保留。" });
    const actions = form.createDiv({ cls: "echoink-diary-actions" });
    diaryButton(actions, "取消编辑", () => { this.resetDraft(entry); this.editingMetadata = false; this.render(); }, { disabled: this.saving });
    const save = diaryButton(actions, this.saving ? "保存中…" : "保存分类与备注", () => this.saveEntry(), { primary: true, disabled: !this.isDirty() || this.saving });
    const change = () => { draft.category = category.value; draft.note = note.value; save.disabled = !this.isDirty() || this.saving; };
    category.addEventListener("input", change);
    note.addEventListener("input", change);
    category.disabled = this.saving;
    note.disabled = this.saving;
  }

  private renderOccurrence(parent: HTMLElement, entry: ExpressionEntry, occurrence: ExpressionOccurrence): void {
    const article = parent.createEl("article", { cls: "echoink-expression-occurrence" });
    const header = article.createDiv({ cls: "echoink-expression-occurrence-heading" });
    header.createSpan({ cls: "echoink-diary-label", text: occurrence.sourceTitle && occurrence.sourceTitle !== occurrence.date ? occurrence.sourceTitle : "收录时英文" });
    if (occurrence.status === "needs-review") header.createSpan({ cls: "echoink-diary-badge is-review", text: "待确认" });
    const menuButton = diaryButton(header, "", () => {
      const rect = menuButton.getBoundingClientRect();
      this.occurrenceMenu(entry, occurrence).showAtPosition({ x: rect.right, y: rect.bottom }, menuButton.ownerDocument);
    }, { tertiary: true, label: `${occurrence.date} 收录操作` });
    menuButton.addClass("echoink-expression-occurrence-menu");
    menuButton.setAttribute("aria-haspopup", "menu");
    setIcon(menuButton, "ellipsis");
    const body = article.createDiv({ cls: "echoink-expression-occurrence-body" });
    if (occurrence.targetExcerpt) body.createEl("blockquote", { cls: "echoink-expression-english-quote", text: occurrence.targetExcerpt, attr: { lang: "en" } });
    if (occurrence.sourceExcerpt && occurrence.sourceExcerpt !== occurrence.targetExcerpt) diaryField(body, "日记原句", occurrence.sourceExcerpt);
    diaryField(body, "当时的场景", occurrence.scene);
  }

  private occurrenceMenu(entry: ExpressionEntry, occurrence: ExpressionOccurrence): Menu {
    const menu = new Menu();
    const action = (callback: () => Promise<void>) => () => { void callback().catch((error) => new Notice(diaryError(error))); };
    menu.addItem((item) => item.setTitle("查看中英日记").setIcon("file-text").onClick(action(() => this.host.openDiary(occurrence.sourcePath))));
    if (!(this.host.api.access ?? unavailableCapabilityAccess).checkCapability("diary.expression.write")) return menu;
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("移除此出处").setIcon("unlink").onClick(action(async () => {
      const confirmed = await confirmModal(this.app, "移除此出处？", `仅移除“${entry.term}”与“${occurrence.sourceTitle || occurrence.date}”的这条收录关联。日记原稿、英文稿、词条和备注都保留，其它出处也不受影响。`, "移除出处", "取消");
      if (!confirmed) return;
      await this.host.api.repository.removeOccurrence(entry.id, occurrence.id);
      await this.refresh();
      new Notice("已移除此出处。");
    })));
    return menu;
  }

  private async openEntry(id: string): Promise<void> {
    this.editingMetadata = false;
    this.selectedId = id;
    this.selected = this.entries.find((entry) => entry.id === id) ?? null;
    if (this.selected) this.resetDraft(this.selected);
    this.app.workspace.requestSaveLayout();
    this.contentEl.scrollTop = 0;
    this.render();
  }

  private async back(): Promise<void> {
    if (this.isDirty() && !(await confirmModal(this.app, "放弃未保存的修改？", "分类和备注还没有保存。", "放弃并返回", "继续编辑"))) return;
    this.selectedId = "";
    this.selected = null;
    this.draft = null;
    this.editingMetadata = false;
    unsavedExpressionDrafts.delete(this.host);
    this.app.workspace.requestSaveLayout();
    await this.refresh();
  }

  private async saveEntry(): Promise<void> {
    if (!this.draft || this.saving) return;
    const draft = { ...this.draft };
    if (!draft.category.trim()) { new Notice("请填写分类。"); return; }
    this.saving = true;
    this.render();
    try {
      const current = (await this.host.api.repository.listExpressions()).find((entry) => entry.id === draft.id);
      if (!current) throw new Error("词条已被移除，当前修改尚未保存。");
      if ((current.category !== draft.initialCategory || current.note !== draft.initialNote) && !(await confirmModal(this.app, "词条已有其它修改", "保存将采用当前表单中的分类和备注，日记出处会保留。", "保存当前内容", "取消"))) return;
      const saved = await this.host.api.repository.updateExpression(draft.id, { category: draft.category.trim(), note: draft.note });
      this.selected = saved;
      this.resetDraft(saved);
      this.editingMetadata = false;
      this.error = "";
      await this.refresh();
      new Notice("已保存分类与备注。");
    } catch (error) { this.error = diaryError(error); }
    finally { this.saving = false; this.render(); }
  }
}

export function groupExpressionOccurrences(occurrences: readonly ExpressionOccurrence[]): Array<{ date: string; occurrences: ExpressionOccurrence[] }> {
  const groups = new Map<string, ExpressionOccurrence[]>();
  for (const occurrence of [...occurrences].sort((left, right) => right.date.localeCompare(left.date))) {
    const group = groups.get(occurrence.date) ?? [];
    group.push(occurrence);
    groups.set(occurrence.date, group);
  }
  return [...groups].map(([date, items]) => ({ date, occurrences: items }));
}

/** Reuse one actual saved usage paragraph; do not invent a cross-day synthesis. */
export function savedExpressionUsage(occurrences: readonly ExpressionOccurrence[]): string | null {
  for (const group of groupExpressionOccurrences(occurrences)) {
    const source = group.occurrences.find((occurrence) => occurrence.status === "verified" && occurrence.usage.trim());
    if (source) return source.usage.replace(/\s+/gu, " ").trim();
  }
  return null;
}

/** One example per identical saved usage, then exact-text deduplication; no semantic claims. */
export function savedExpressionExamples(occurrences: readonly ExpressionOccurrence[]): Array<{ example: string; usage: string }> {
  const usages = new Set<string>();
  const examples = new Set<string>();
  const result: Array<{ example: string; usage: string }> = [];
  for (const group of groupExpressionOccurrences(occurrences)) {
    for (const occurrence of group.occurrences) {
      if (occurrence.status !== "verified") continue;
      const example = normalizedExpressionText(occurrence.example);
      const usage = normalizedExpressionText(occurrence.usage);
      if (!example || usages.has(usage)) continue;
      usages.add(usage);
      if (examples.has(example)) continue;
      examples.add(example);
      result.push({ example, usage });
    }
  }
  return result;
}

function normalizedExpressionText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}
