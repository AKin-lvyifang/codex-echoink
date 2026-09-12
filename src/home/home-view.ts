import { ItemView, Modal, Notice, TFile, WorkspaceLeaf, sanitizeHTMLToDom, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { SettingsLanguage } from "../settings/settings";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import { homeEntryIndexPath, HomeWorkbenchDataService, type HomeEntrySummary, type HomeWorkbenchData } from "./home-workbench-data";
import { readNativeJournalSettings } from "./native-journal";
import { dateKey, journalDateFromPath, type HomeVaultFileRecord } from "./home-workbench-model";
import { homeConversationMessage, homeReviewPrompt, type HomeConversationAction } from "./home-conversation-actions";
import { JournalTemplateModal } from "./journal-template-modal";
import { formatHomeFullDate, formatHomeRelativeTime, homeCopy, type HomeCopy } from "./home-i18n";
import { openObsidianLocalGraphLeaf } from "./open-native-graph";
import { homeWorkspaceMarkup } from "./home-workspace-template";
import { HomeSearchService, type HomeSearchMatch } from "./home-search";
import { type HomeActivityEvent, type HomeActivityKind } from "./home-activity-service";
import { ECHOINK_HOME_MODULES } from "./home-modules";
import { sortOpenTodos } from "./home-todos";
import { EchoInkTodoFormModal } from "./todo-edit-modal";
import { renderTodoTable, todoTableCopy } from "./todo-table";
import type { ParsedTodoRecord } from "./todo-markdown";
import { confirmModal } from "../ui/modals";

export const VIEW_TYPE_ECHOINK_HOME = "codex-echoink-home";
let nextHomeId = 0;
const esc = (value: string | number | null | undefined): string => String(value ?? "").replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const icon = (name: string) => `<i data-icon="${name}" aria-hidden="true"></i>`;
function markup(el: HTMLElement, html: string): void {
  el.empty();
  el.appendChild(el.ownerDocument.importNode(sanitizeHTMLToDom(html), true));
  el.querySelectorAll<HTMLElement>("[data-icon]").forEach((node) => setIcon(node, node.dataset.icon!));
}
const parseDate = (key: string): Date => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };

export class EchoInkHomeView extends ItemView {
  private readonly dataService: HomeWorkbenchDataService;
  private readonly searchService: HomeSearchService;
  private searchResolvedQuery: string | null = null;
  private snapshot: KnowledgeBaseDashboardSnapshot | null = null;
  private data: HomeWorkbenchData | null = null;
  private selectedDate: string | null = null;
  private month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private readonly id = `echoink-home-${++nextHomeId}`;
  private closed = false;
  private refreshVersion = 0;
  private refreshTimer: number | null = null;
  private searchTimer: number | null = null;
  private searchAbort: AbortController | null = null;
  private searchMatches: HomeSearchMatch[] = [];
  private searchIndex = -1;
  private activityUnsubscribe: (() => void) | null = null;
  private todoUnsubscribe: (() => void) | null = null;
  private todoFilter: "all" | "open" | "done" = "all";
  /** null = all categories; "" = uncategorized; otherwise the category name. */
  private todoCategoryFilter: string | null = null;
  private categoryFilterPopEl: HTMLElement | null = null;
  private categoryFilterOutsideHandler: ((event: PointerEvent) => void) | null = null;
  private categoryFilterEscHandler: ((event: KeyboardEvent) => void) | null = null;
  private categoryFilterScrollHandler: (() => void) | null = null;
  private activityModal: Modal | null = null;
  private captureBusy = false;
  private searchOpen = false;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.dataService = new HomeWorkbenchDataService(plugin.app, () => plugin.settings.journalDirectory, plugin.homeActivity);
    this.searchService = new HomeSearchService(plugin.app);
  }
  getViewType(): string { return VIEW_TYPE_ECHOINK_HOME; }
  getDisplayText(): string { return this.copy.viewTitle; }
  getIcon(): string { return "feather"; }
  private get language(): SettingsLanguage { return this.plugin.settings.settingsLanguage; }
  private get copy(): HomeCopy { return homeCopy(this.language); }
  private t(zh: string, en: string): string { return this.language === "en" ? en : zh; }
  private el(selector: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(selector)!; }
  private field(name: string): HTMLElement { return this.el(`[data-home="${name}"]`); }
  private get events(): readonly HomeActivityEvent[] { return this.plugin.homeActivity?.snapshot().events ?? []; }
  private kind(kind: HomeActivityKind): string { return this.t({ created: "新建", modified: "修改", reopened: "重读" }[kind], { created: "Created", modified: "Modified", reopened: "Reopened" }[kind]); }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-home-workspace");
    this.contentEl.tabIndex = -1;
    this.renderShell();
    this.activityUnsubscribe = this.plugin.homeActivity?.subscribe(() => this.scheduleRefresh()) ?? null;
    this.todoUnsubscribe = this.plugin.getTodoStore().subscribe(() => {
      if (!this.closed) this.renderTodos();
    });
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerDomEvent(this.contentEl, "click", (e) => { void this.handleClick(e).catch((error) => new Notice(errorMessage(error))); });
    this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKeys(e));
    this.registerDomEvent(this.contentEl, "input", (e) => {
      if ((e.target as HTMLElement).dataset.home === "search-input" && !(e as InputEvent).isComposing) this.scheduleSearch();
    });
    this.registerDomEvent(this.contentEl, "compositionend", () => this.scheduleSearch());
    this.registerDomEvent(this.contentEl, "pointermove", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(".search-result");
      if (target && this.searchOpen) this.selectSearchIndex(Number(target.dataset.searchIndex), false);
    });
    this.registerDomEvent(this.contentEl, "focusout", (event) => {
      if (event.relatedTarget && !this.field("header-search").contains(event.relatedTarget as Node)) this.closeSearch(false);
    });
    this.registerDomEvent(this.contentEl.ownerDocument, "pointerdown", (e) => {
      if (!this.field("header-search").contains(e.target as Node)) this.closeSearch(false);
    });
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.refreshVersion++;
    this.closeCategoryFilterPop(false);
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.refreshTimer !== null) win?.clearTimeout(this.refreshTimer);
    if (this.searchTimer !== null) win?.clearTimeout(this.searchTimer);
    this.searchAbort?.abort(); this.activityUnsubscribe?.(); this.todoUnsubscribe?.(); this.activityModal?.close();
    this.contentEl.empty(); this.contentEl.removeClass("echoink-home-workspace");
  }
  private scheduleRefresh(): void {
    const win = this.contentEl.ownerDocument.defaultView;
    if (!win || this.closed) return;
    if (this.refreshTimer !== null) win.clearTimeout(this.refreshTimer);
    this.refreshTimer = win.setTimeout(() => { this.refreshTimer = null; void this.refresh(); }, 220);
  }
  async refreshLanguage(): Promise<void> { this.renderShell(); await this.refresh(); }
  async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    const [data, health] = await Promise.allSettled([this.dataService.build(this.month), this.plugin.getKnowledgeSurfaceService()?.getDashboardSnapshot()]);
    if (this.closed || version !== this.refreshVersion) return;
    if (data.status === "fulfilled") this.data = data.value;
    if (health.status === "fulfilled") this.snapshot = health.value ?? null;
    else this.snapshot = null;
    this.renderRecent(); this.renderActivity(); this.renderCalendar(); this.renderEntries(); this.renderTodos();
    this.applyModuleVisibility();
    if (data.status === "rejected") this.field("recent-subtitle").setText(this.t("笔记读取失败，请稍后重试", "Could not read notes. Try again."));
  }
  /**
   * Fixed-slot module visibility: hidden modules keep their layout slot but
   * hide content and interactions; other cards never reflow.
   */
  applyModuleVisibility(): void {
    const visibility = this.plugin.settings.homeModules;
    for (const module of ECHOINK_HOME_MODULES) {
      const root = this.contentEl.querySelector<HTMLElement>(module.selector);
      if (!root) continue;
      const hidden = visibility[module.id] === false;
      root.toggleClass("echoink-module-hidden", hidden);
      root.toggleAttribute("aria-hidden", hidden);
    }
  }
  /** Lightweight re-render for settings-driven changes (modules + todos). */
  refreshHomeSurfaces(): void {
    if (this.closed) return;
    this.applyModuleVisibility();
    this.renderTodos();
  }
  private renderShell(): void {
    markup(this.contentEl, homeWorkspaceMarkup(this.language));
    for (const node of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-home]"))) node.id = `${this.id}-${node.dataset.home}`;
    for (const node of Array.from(this.contentEl.querySelectorAll<HTMLElement>("[aria-controls], [aria-labelledby], [for]"))) {
      for (const attr of ["aria-controls", "aria-labelledby", "for"]) if (node.hasAttribute(attr)) node.setAttribute(attr, node.getAttribute(attr)!.split(" ").map((id) => `${this.id}-${id}`).join(" "));
    }
    this.el(".date-caption").setText(new Intl.DateTimeFormat(this.language, { month: "short", day: "numeric", weekday: "long" }).format(new Date()));
    this.field("recent-subtitle").setText(this.t("按文件创建 / 修改时间排序", "Sorted by file creation / modification time"));
    this.searchOpen = false;
  }
  private records(): HomeVaultFileRecord[] {
    const records = this.data?.records ?? [];
    if (!this.selectedDate) return [...records].sort((a, b) => Math.max(b.ctime ?? 0, b.mtime) - Math.max(a.ctime ?? 0, a.mtime));
    const events = this.events.filter((e) => e.date === this.selectedDate);
    const paths = [...new Set(events.map((e) => e.path))];
    const byPath = new Map(records.map((r) => [r.path, r]));
    return paths.map((p) => byPath.get(p)).filter((r): r is HomeVaultFileRecord => !!r);
  }
  private renderRecent(): void {
    const records = this.records(); const selected = this.selectedDate;
    this.field("recent-title").setText(selected ? this.t(`${this.shortDate(selected)}的记录`, `Notes · ${this.shortDate(selected)}`) : this.t("最近笔记", "Recent notes"));
    this.el(".reset-date").hidden = !selected;
    this.field("recent-subtitle").setText(selected ? this.t(`已展示 ${Math.min(3, records.length)} / ${records.length} 篇`, `Showing ${Math.min(3, records.length)} of ${records.length}`) : this.t("按文件创建 / 修改时间排序", "Sorted by file creation / modification time"));
    const host = this.field("recent-notes");
    if (!records.length) { markup(host, `<div class="recent-empty"><h3>${this.t("还没有留下记录", "No notes yet")}</h3><p>${this.t("从现在开始，接住一个想法。", "Start with a thought worth keeping.")}</p><button class="text-button" data-action="reset-date">${this.t("回到最近", "Back to recent")}${icon("arrow-right")}</button></div>`); return; }
    const label = (r: HomeVaultFileRecord) => selected ? [...new Set(this.events.filter((e) => e.path === r.path && e.date === selected).map((e) => this.kind(e.kind)))].join(" · ") : this.kind(r.ctime && r.mtime <= r.ctime + 1000 ? "created" : "modified");
    const time = (r: HomeVaultFileRecord) => selected ? this.shortDate(selected) : formatHomeRelativeTime(Math.max(r.ctime ?? 0, r.mtime), this.language);
    const first = records[0];
    markup(host, `<button class="note-feature" data-note="${esc(first.path)}"><span class="note-kicker">${icon("file-text")}${esc(first.folder)}<span class="resume-chip">${esc(label(first))}</span></span><h3>${esc(first.title)}</h3><p class="note-excerpt"></p><span class="note-feature-bottom"><span>${esc(time(first))}</span><span>${this.t("打开笔记", "Open note")}${icon("arrow-up-right")}</span></span></button><div class="small-note-list">${records.slice(1, 3).map((r) => `<button class="small-note" data-note="${esc(r.path)}"><span class="small-note-label">${icon("file-text")}${esc(r.folder)}<span class="resume-chip">${esc(label(r))}</span></span><h3>${esc(r.title)}</h3><span class="small-note-time"><span>${esc(time(r))}</span>${icon("arrow-up-right")}</span></button>`).join("")}${selected && records.length > 3 ? `<button class="small-note" data-action="all-day"><span class="small-note-label">${this.t("查看当天全部", "View all for this day")} ${records.length}</span></button>` : ""}</div>`);
    const target = host.querySelector<HTMLElement>(".note-excerpt")!;
    void this.searchService.excerpt(first.path).then((text) => { if (target.isConnected) target.setText(text || first.path); }).catch(() => { if (target.isConnected) target.setText(this.t("摘要读取失败", "Could not read excerpt")); });
  }
  private weekDates(): string[] {
    const today = new Date(); today.setHours(0, 0, 0, 0); today.setDate(today.getDate() - (today.getDay() + 6) % 7);
    return Array.from({ length: 7 }, (_, i) => dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)));
  }
  private renderActivity(): void {
    const dates = this.weekDates(); const events = this.events.filter((e) => dates.includes(e.date));
    this.el(".week-range").setText(`${this.shortDate(dates[0])} — ${this.shortDate(dates[6])}`);
    markup(this.field("trace-count"), `${events.length}<span>${this.t("次积累", "activities")}</span>`);
    markup(this.el(".trace-legend"), (["created", "modified", "reopened"] as const).map((kind, i) => `<span><b class="mark ${["new", "edit", "revisit"][i]}"></b>${this.kind(kind)} <em>${events.filter((e) => e.kind === kind).length}</em></span>`).join(""));
    markup(this.field("week-spines"), dates.map((d) => { const daily = events.filter((e) => e.date === d); return `<button class="day-spines ${d === this.selectedDate ? "selected" : ""} ${d === dateKey(new Date()) ? "is-today" : ""}" data-date="${d}" aria-pressed="${d === this.selectedDate}" aria-label="${esc(this.shortDate(d))} · ${daily.length}"><span class="spine-books">${daily.slice(0, 9).map((e) => `<b class="spine ${{created:"new",modified:"edit",reopened:"revisit"}[e.kind]}"></b>`).join("")}</span><span class="day-label">${d === dateKey(new Date()) ? this.t("今天", "Today") : new Intl.DateTimeFormat(this.language, { weekday: "narrow" }).format(parseDate(d))}</span></button>`; }).join(""));
    const activity = this.plugin.homeActivity?.snapshot();
    this.field("trace-caption").setText(activity?.error ? this.t("足迹读取或保存失败，记录可能不完整", "Activity could not be read or saved; records may be incomplete") : activity ? this.t(`自 ${this.shortDate(dateKey(new Date(activity.startedAt)))} 起记录，之前没有足迹历史`, `Recording since ${this.shortDate(dateKey(new Date(activity.startedAt)))}; earlier history is unavailable`) : this.t("足迹记录暂不可用", "Activity is unavailable"));
  }
  private renderCalendar(): void {
    this.field("month-label").setText(new Intl.DateTimeFormat(this.language, { year: "numeric", month: "long" }).format(this.month));
    const weekdays = this.el(".calendar-weekdays");
    markup(weekdays, Array.from({ length: 7 }, (_, i) => `<span>${esc(new Intl.DateTimeFormat(this.language, { weekday: "narrow" }).format(new Date(2024, 0, i + 1)))}</span>`).join(""));
    const first = new Date(this.month.getFullYear(), this.month.getMonth(), 1); const offset = (first.getDay() + 6) % 7;
    const cells = Math.ceil((new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate() + offset) / 7) * 7;
    markup(this.field("calendar-days"), Array.from({ length: cells }, (_, i) => {
      const date = new Date(first.getFullYear(), first.getMonth(), i - offset + 1); const key = dateKey(date); const count = this.events.filter((e) => e.date === key).length;
      return `<button data-date="${key}" class="${date.getMonth() !== first.getMonth() ? "outside" : ""} ${key === dateKey(new Date()) ? "today" : ""} ${key === this.selectedDate ? "selected" : ""} ${count ? "has-record" : ""}" aria-pressed="${key === this.selectedDate}" aria-label="${esc(formatHomeFullDate(date, this.language))} · ${count}" ${key === dateKey(new Date()) ? 'aria-current="date"' : ""}>${date.getDate()}</button>`;
    }).join(""));
    const prefix = dateKey(first).slice(0, 7); const count = new Set(this.events.filter((e) => e.date.startsWith(prefix)).map((e) => e.date)).size;
    this.field("month-record-count").setText(this.t(`本月 ${count} 天`, `${count} days this month`));
    const key = this.selectedDate ?? dateKey(new Date());
    this.field("journal-label").setText(this.t(`${this.shortDate(key)}的日记`, `Journal · ${this.shortDate(key)}`));
    this.field("journal-hint").setText(this.dataService.existingJournalForDate(parseDate(key)) ? this.t("已经留下一页，点开看看", "A page is waiting for you") : this.t("这一天还没有日记", "No journal for this day yet"));
  }
  private renderEntries(): void {
    const records = this.data?.records ?? [];
    const entry = (id: string) => this.data?.entries.find((e) => e.id === id);
    const latest = (id: string) => records.filter((r) => r.path.startsWith(`${id}/`)).sort((a, b) => b.mtime - a.mtime)[0];
    const count = (id: string) => entry(id)?.count ?? 0;
    markup(this.el(".wiki-count"), `${count("wiki")}<span>${this.t("篇笔记", "notes")}</span>`);
    const changed = new Set(this.events.filter((e) => e.path.startsWith("wiki/") && this.weekDates().includes(e.date) && e.kind !== "reopened").map((e) => e.path)).size;
    this.el(".wiki .bento-meta").setText(this.t(`本周留下 ${changed} 篇笔记的足迹`, `${changed} notes touched this week`));
    this.el(".outputs .bento-line").setText(latest("outputs")?.title ?? this.t("思考的成果，从这里开始", "A place for your work"));
    this.el(".outputs .bento-meta").setText(this.t(`${count("outputs")} 份成果`, `${count("outputs")} outputs`));
    this.el(".project-line").setText(latest("projects")?.title ?? this.t("下一件值得推进的事", "The next thing worth doing"));
    this.el(".projects .bento-meta").setText(this.t(`${count("projects")} 篇项目笔记`, `${count("projects")} project notes`));
    this.field("inbox-count").setText(String(count("inbox")));
    this.el(".journal-date").setText(new Intl.DateTimeFormat(this.language, { month: "long", day: "numeric" }).format(new Date()));
    const prefix = dateKey(new Date()).slice(0, 7);
    const journals = records.filter((r) => {
      const parsed = journalDateFromPath(r.path, this.dataService.getJournalDirectory(), readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory).format);
      return parsed?.startsWith(prefix);
    }).length;
    this.el(".journal .bento-meta").setText(this.t(`这个月，留下了 ${journals} 篇日记`, `${journals} journal pages this month`));
    const health = this.snapshot?.health;
    const score = health && health.status !== "unknown" ? String(health.score) : "—";
    this.el(".review-score strong").setText(score);
    const status = !health ? this.t("健康状态暂不可用", "Health is unavailable") : health.assessment === "uninitialized" ? this.t("初始化知识库", "Initialize knowledge") : health.assessment === "unavailable" ? this.t("健康状态无法评估", "Health cannot be assessed") : this.t(`本地结构 ${score} 分${health.assessment === "limited" ? " · 检查受限" : ""}`, `Local structure ${score}${health.assessment === "limited" ? " · Limited" : ""}`);
    markup(this.el(".health"), `<b></b>${esc(status)}${icon("chevron-right")}`);
  }
  private renderTodos(): void {
    const host = this.field("todo-list");
    const store = this.plugin.getTodoStore();
    const all = store.snapshot();
    const pool = this.todoCategoryFilter === null
      ? all
      : all.filter((record) => (record.categoryName || "") === this.todoCategoryFilter);
    const open = sortOpenTodos(pool);
    this.field("todo-subtitle").setText(this.t(
      open.length ? `还有 ${open.length} 件未完成，按期限排序` : "暂时没有未完成的事",
      open.length ? `${open.length} open, nearest due date first` : "Nothing open right now"
    ));
    this.renderTodoFilterBar();
    const visible = this.todoFilter === "open"
      ? open
      : this.todoFilter === "done"
        ? pool.filter((record) => record.done)
        : [...open, ...pool.filter((record) => record.done)];
    renderTodoTable(host, visible, todoTableCopy(this.language), {
      onToggle: (record, done) => void store.toggleDone(record, done),
      onEdit: (record) => new EchoInkTodoFormModal(this.app, this.plugin, record).open(),
      onDelete: (record) => void this.confirmTodoDelete(record)
    });
  }
  private renderTodoFilterBar(): void {
    const bar = this.field("todo-filter-bar");
    bar.empty();
    const categoryLabel = this.todoCategoryFilter === null
      ? this.t("全部分类", "All categories")
      : this.todoCategoryFilter === ""
        ? this.t("未分类", "Uncategorized")
        : this.todoCategoryFilter;
    const trigger = bar.createEl("button", {
      cls: `todo-filter todo-category-filter${this.todoCategoryFilter !== null ? " is-active" : ""}`,
      attr: { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" }
    });
    trigger.createSpan({ cls: "todo-category-label", text: categoryLabel });
    const caret = trigger.createSpan({ cls: "todo-category-caret", attr: { "aria-hidden": "true" } });
    setIcon(caret, "chevron-down");
    trigger.onclick = () => this.toggleCategoryFilterPop();
    for (const option of ["all", "open", "done"] as const) {
      const label = this.t(
        { all: "全部", open: "未完成", done: "已完成" }[option],
        { all: "All", open: "Open", done: "Done" }[option]
      );
      const button = bar.createEl("button", {
        cls: `todo-filter ${this.todoFilter === option ? "is-active" : ""}`,
        text: label,
        attr: { type: "button", "aria-pressed": String(this.todoFilter === option) }
      });
      button.onclick = () => {
        this.todoFilter = option;
        this.renderTodos();
      };
    }
  }
  /** Compact floating category filter menu: never shifts the list or page. */
  private toggleCategoryFilterPop(): void {
    if (this.categoryFilterPopEl) {
      this.closeCategoryFilterPop();
      return;
    }
    const bar = this.field("todo-filter-bar");
    const trigger = bar.querySelector<HTMLElement>(".todo-category-filter");
    if (!trigger) return;
    const pop = bar.createDiv({ cls: "echoink-todo-filter-pop" });
    const options: Array<{ value: string | null; label: string }> = [
      { value: null, label: this.t("全部分类", "All categories") },
      { value: "", label: this.t("未分类", "Uncategorized") },
      ...this.plugin.settings.todoCategories.map((category) => ({ value: category.name, label: category.name }))
    ];
    for (const option of options) {
      const button = pop.createEl("button", {
        cls: `echoink-todo-filter-option${this.todoCategoryFilter === option.value ? " is-active" : ""}`,
        text: option.label,
        attr: { type: "button" }
      });
      button.onclick = () => {
        this.todoCategoryFilter = option.value;
        this.closeCategoryFilterPop();
        this.renderTodos();
      };
    }
    this.categoryFilterPopEl = pop;
    trigger.setAttribute("aria-expanded", "true");
    const contentRect = this.contentEl.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const spaceBelow = contentRect.bottom - triggerRect.bottom;
    const spaceAbove = triggerRect.top - contentRect.top;
    if (spaceBelow < 232 && spaceAbove > spaceBelow) pop.addClass("drop-up");
    this.categoryFilterOutsideHandler = (event: PointerEvent) => {
      const target = event.target as Node;
      if (pop.contains(target) || trigger.contains(target)) return;
      event.stopPropagation();
      this.closeCategoryFilterPop();
    };
    this.contentEl.addEventListener("pointerdown", this.categoryFilterOutsideHandler, true);
    this.categoryFilterEscHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.closeCategoryFilterPop();
    };
    this.contentEl.ownerDocument.addEventListener("keydown", this.categoryFilterEscHandler, true);
    this.categoryFilterScrollHandler = () => this.closeCategoryFilterPop();
    this.contentEl.addEventListener("scroll", this.categoryFilterScrollHandler, { passive: true });
  }
  private closeCategoryFilterPop(focusTrigger = true): void {
    this.categoryFilterPopEl?.remove();
    this.categoryFilterPopEl = null;
    if (this.categoryFilterOutsideHandler) {
      this.contentEl.removeEventListener("pointerdown", this.categoryFilterOutsideHandler, true);
      this.categoryFilterOutsideHandler = null;
    }
    if (this.categoryFilterEscHandler) {
      this.contentEl.ownerDocument.removeEventListener("keydown", this.categoryFilterEscHandler, true);
      this.categoryFilterEscHandler = null;
    }
    if (this.categoryFilterScrollHandler) {
      this.contentEl.removeEventListener("scroll", this.categoryFilterScrollHandler);
      this.categoryFilterScrollHandler = null;
    }
    const trigger = this.field("todo-filter-bar").querySelector<HTMLElement>(".todo-category-filter");
    trigger?.setAttribute("aria-expanded", "false");
    if (focusTrigger) trigger?.focus();
  }
  private async confirmTodoDelete(record: ParsedTodoRecord): Promise<void> {
    const accepted = await confirmModal(
      this.app,
      this.t("删除待办", "Delete to-do"),
      this.t(`确定删除「${record.title}」吗？删除后无法恢复。`, `Delete "${record.title}"? This cannot be undone.`),
      this.t("删除", "Delete"),
      this.t("取消", "Cancel")
    );
    if (!accepted) return;
    await this.plugin.getTodoStore().removeTodo(record);
  }
  private shortDate(key: string): string { return new Intl.DateTimeFormat(this.language, { month: "short", day: "numeric" }).format(parseDate(key)); }
  private selectDate(key: string | null): void {
    this.selectedDate = key;
    if (key) this.month = new Date(parseDate(key).getFullYear(), parseDate(key).getMonth(), 1);
    this.renderRecent(); this.renderActivity(); this.renderCalendar();
  }
  private async handleClick(event: MouseEvent): Promise<void> {
    const button = (event.target as HTMLElement).closest?.<HTMLButtonElement>("button");
    if (!button || !this.contentEl.contains(button)) return;
    if (button.dataset.note) { this.closeSearch(false); await this.openNote(button.dataset.note); return; }
    if (button.dataset.date) { this.selectDate(button.dataset.date); return; }
    if (button.dataset.nativeGraph) { const e = this.data?.entries.find((e) => e.id === button.dataset.nativeGraph); if (e) await this.openEntry(e); return; }
    switch (button.dataset.action) {
      case "capture": await this.capture(); break;
      case "journal-chat": await this.openConversationAction("daily"); break;
      case "review": await this.openReviewConversation(); break;
      case "journal-template": this.openJournalTemplate(new Date()); break;
      case "selected-journal": await this.openJournal(parseDate(this.selectedDate ?? dateKey(new Date()))); break;
      case "today": this.selectDate(dateKey(new Date())); break;
      case "reset-date": this.selectDate(null); break;
      case "previous-month": case "next-month": this.month = new Date(this.month.getFullYear(), this.month.getMonth() + (button.dataset.action === "next-month" ? 1 : -1), 1); this.renderCalendar(); break;
      case "knowledge-settings": await this.plugin.openEchoInkKnowledgeSettings(); break;
      case "settings": await this.plugin.openEchoInkGeneralSettings(); break;
      case "search": this.openSearch(); break;
      case "close-search": this.closeSearch(true); break;
      case "week-review": this.showActivity(false); break;
      case "all-day": this.showActivity(true); break;
      case "footprint-help": this.showActivity(false, true); break;
      case "todo-new": new EchoInkTodoFormModal(this.app, this.plugin, null).open(); break;
      case "todo-open-source": void this.plugin.getTodoStore().openSourceFile(); break;
    }
  }
  private async capture(): Promise<void> {
    if (this.captureBusy) return;
    this.captureBusy = true;
    try {
      const file = await this.dataService.createBlankInboxNote(this.language);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      await this.refresh();
    } finally { this.captureBusy = false; }
  }
  private async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(this.t("笔记已移动或删除", "This note was moved or deleted")); return; }
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
  private showActivity(dayOnly: boolean, help = false): void {
    this.activityModal?.close();
    const modal = new Modal(this.app); this.activityModal = modal;
    modal.contentEl.addClass("echoink-home-activity-dialog");
    modal.titleEl.setText(help ? this.t("留痕组件 · 七日书脊", "Activity · Seven days of book spines") : this.t(dayOnly ? "当天全部足迹" : "这一周留下的足迹", dayOnly ? "All activity for this day" : "This week's activity"));
    if (help) {
      modal.contentEl.createEl("h2", { text: this.t("留下了什么，比打了多少卡更有意思。", "What you leave behind matters more than a streak.") });
      modal.contentEl.createEl("p", { text: this.t("每一本小书脊对应一次积累。绿色是新记录，浅绿是修改，暖色是重读。点一组书脊，上方就展开那天的具体笔记。", "Each spine represents one activity: green for a new note, light green for an edit, and warm tones for reopening a note. Select a day's spines to see its notes above.") });
      modal.contentEl.createEl("p", { text: this.t("月历和它使用同一个日期筛选。不用追求连续天数，也不用把空白补满。", "The calendar uses the same date filter. There is no need to maintain a streak or fill every blank day.") });
    }
    if (!help) {
      const events = this.events.filter((e) => dayOnly ? e.date === this.selectedDate : this.weekDates().includes(e.date));
      const notes = new Set(events.map((event) => event.path)).size;
      modal.contentEl.createEl("p", { cls: "lead", text: this.t(`${events.length} 次积累，${notes} 篇笔记。点开标题，回到具体内容。`, `Activity: ${events.length} · Notes: ${notes}. Select a title to return to its content.`) });
      if (!events.length) modal.contentEl.createEl("p", { text: this.t("这段时间还没有足迹", "No activity recorded for this period") });
      for (const e of events) {
        const row = modal.contentEl.createDiv({ cls: "trace-row" });
        row.createEl("time", { text: e.date.slice(5).replace("-", "."), attr: { datetime: e.date } });
        row.createEl("b", { cls: `mark ${{ created: "new", modified: "edit", reopened: "revisit" }[e.kind]}`, attr: { "aria-hidden": "true" } });
        const entry = row.createSpan({ text: `${this.kind(e.kind)} · ` });
        const button = entry.createEl("button", { text: this.data?.records.find((r) => r.path === e.path)?.title ?? e.path, attr: { type: "button" } });
        button.onclick = () => { modal.close(); void this.openNote(e.path); };
      }
    }
    modal.contentEl.createEl("p", { cls: "helper", text: this.t("同一天、同一笔记、同一种动作合并记录；重读指再次打开已打开过的笔记。开始记录前没有历史。", "Each action is counted once per note per day. Reopened means opening a note you have opened before. Earlier history is unavailable.") });
    if (help) {
      const actions = modal.contentEl.createDiv({ cls: "dialog-actions" });
      const button = actions.createEl("button", { cls: "mod-cta", text: this.t("看看完整足迹", "View this week's activity"), attr: { type: "button" } });
      button.onclick = () => this.showActivity(false);
    }
    modal.open();
  }
  private openSearch(): void {
    this.searchOpen = true;
    this.field("header-search").addClass("is-open"); this.el(".page-heading").addClass("search-open");
    this.field("search-suggestions").hidden = false;
    const input = this.field("search-input") as HTMLInputElement;
    input.tabIndex = 0; input.setAttribute("aria-expanded", "true"); this.el(".search-trigger").setAttribute("aria-expanded", "true"); this.el(".search-close").tabIndex = 0;
    input.focus(); this.scheduleSearch();
  }
  private closeSearch(focus: boolean): void {
    if (!this.searchOpen) return;
    this.searchOpen = false; this.searchAbort?.abort();
    this.field("header-search").removeClass("is-open"); this.el(".page-heading").removeClass("search-open"); this.field("search-suggestions").hidden = true;
    const input = this.field("search-input") as HTMLInputElement;
    input.tabIndex = -1; input.value = ""; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
    this.el(".search-trigger").setAttribute("aria-expanded", "false"); this.el(".search-close").tabIndex = -1;
    if (focus) this.el(".search-trigger").focus();
  }
  private scheduleSearch(): void {
    if (!this.searchOpen) return;
    this.searchAbort?.abort();
    this.searchResolvedQuery = null; this.searchMatches = []; this.searchIndex = -1;
    this.field("search-input").removeAttribute("aria-activedescendant");
    this.field("search-results").empty();
    this.field("search-empty").hidden = true;
    this.field("search-results-heading").setText(this.t("正在查找…", "Searching…"));
    const win = this.contentEl.ownerDocument.defaultView;
    if (this.searchTimer !== null) win?.clearTimeout(this.searchTimer);
    this.searchTimer = win?.setTimeout(() => { this.searchTimer = null; void this.runSearch(); }, 100) ?? null;
  }
  private async runSearch(): Promise<void> {
    const abort = new AbortController(); this.searchAbort = abort;
    this.field("search-results-heading").setText(this.t("正在查找…", "Searching…"));
    try {
      const query = (this.field("search-input") as HTMLInputElement).value;
      const result = await this.searchService.search(query, abort.signal);
      if (abort.signal.aborted || !this.searchOpen || this.closed) return;
      if (query !== (this.field("search-input") as HTMLInputElement).value) return;
      this.searchResolvedQuery = query;
      this.searchMatches = result.matches; this.searchIndex = -1;
      this.field("search-input").removeAttribute("aria-activedescendant");
      this.field("search-results-heading").setText(this.t(`找到 ${result.count} 篇笔记`, `${result.count} notes found`));
      markup(this.field("search-results"), result.matches.map((r, i) => `<button class="search-result" id="${this.id}-option-${i}" role="option" tabindex="-1" aria-selected="false" data-search-index="${i}" data-note="${esc(r.path)}">${icon("file-text")}<span class="search-result-copy"><strong>${esc(r.title)}</strong><small>${esc(r.snippet || r.path)}</small><span>${esc(r.path)} · ${esc(formatHomeRelativeTime(r.mtime, this.language))}</span></span>${icon("arrow-up-right")}</button>`).join(""));
      this.field("search-empty").hidden = result.count > 0;
      this.field("search-results-hint").setText(result.failed ? this.t(`${result.failed} 篇笔记读取失败`, `${result.failed} notes could not be read`) : this.t("↑ ↓ 选择 · Enter 打开 · 最多显示 6 项", "↑ ↓ Select · Enter Open · Up to 6 results"));
    } catch { if (!abort.signal.aborted) this.field("search-results-heading").setText(this.t("搜索失败，请重试", "Search failed. Try again.")); }
  }
  private handleKeys(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.metaKey || event.ctrlKey) && ["k", "j"].includes(event.key.toLowerCase())) {
      event.preventDefault(); event.stopPropagation();
      if (event.key.toLowerCase() === "k") this.openSearch(); else void this.capture().catch((error) => new Notice(errorMessage(error)));
      return;
    }
    if (!this.searchOpen) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.closeSearch(true); return; }
    if ((event.target as HTMLElement).dataset.home !== "search-input") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); if (!this.searchMatches.length) return;
      const count = this.searchMatches.length;
      const index = this.searchIndex < 0 ? (event.key === "ArrowUp" ? count - 1 : 0)
          : (this.searchIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      this.selectSearchIndex(index, true);
    }
    if (event.key === "Enter") { event.preventDefault(); if (this.searchResolvedQuery !== (this.field("search-input") as HTMLInputElement).value) return; const match = this.searchMatches[Math.max(0, this.searchIndex)]; if (match) { this.closeSearch(true); void this.openNote(match.path); } }
  }

  private selectSearchIndex(index: number, scroll: boolean): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.searchMatches.length) return;
    this.searchIndex = index;
    const options = this.field("search-results").querySelectorAll<HTMLElement>("[role=option]");
    options.forEach((el, i) => el.setAttribute("aria-selected", String(i === index)));
    const option = options[index];
    if (!option) return;
    this.field("search-input").setAttribute("aria-activedescendant", option.id);
    if (scroll) option.scrollIntoView({ block: "nearest" });
  }

  private async openConversationAction(action: HomeConversationAction): Promise<void> {
    const now = new Date();
    if (action === "daily") {
      try {
        await this.plugin.requireAvailableEchoInkSkill("daily-journal");
      } catch (error) {
        const detail = this.language === "en"
          ? "The daily-journal Skill is disabled, missing, or could not be loaded."
          : errorMessage(error);
        new Notice(this.copy.conversation.cannotCreateSession(detail));
        await this.plugin.openEchoInkSkillSettings("daily-journal").catch(
          (settingsError) => console.warn(
            "[EchoInk] Failed to open daily-journal settings:",
            settingsError
          )
        );
        return;
      }
    }
    try {
      await this.plugin.activateView();
      const view = this.plugin.getCodexView();
      if (!view) throw new Error(this.copy.conversation.sidebarNotReady);
      const title = action === "daily"
        ? this.copy.conversation.dailySessionTitle(dateKey(now))
        : this.copy.conversation.revisitSessionTitle(dateKey(now));
      await view.startHomeConversation({
        title,
        message: homeConversationMessage(action, this.language),
        ...(action === "daily"
          ? {
              defaultSkillId: "daily-journal"
            }
          : {})
      });
    } catch (error) {
      console.warn("[EchoInk] Failed to start Home conversation:", error);
      new Notice(this.copy.conversation.cannotCreateSession(errorMessage(error)));
    }
  }

  private async openEntry(entry: HomeEntrySummary): Promise<void> {
    const indexPath = homeEntryIndexPath(entry.id);
    if (indexPath) {
      await openObsidianLocalGraphLeaf(this.app, indexPath, this.language);
      return;
    }
    if (entry.id === "journal") {
      this.openJournalTemplate(new Date());
      return;
    }
    if (entry.id === "review") {
      await this.openReviewConversation();
      return;
    }
  }

  private async openReviewConversation(): Promise<void> {
    try {
      await this.plugin.activateView();
      const view = this.plugin.getCodexView();
      if (!view) throw new Error(this.copy.conversation.sidebarNotReady);
      const now = new Date();
      await view.createAndStartGuidedSession({
        title: this.copy.conversation.reviewSessionTitle(dateKey(now)),
        prompt: homeReviewPrompt(this.language),
        defaultSkillId: "knowledge-review"
      });
    } catch (error) {
      console.warn("[EchoInk] Failed to prepare Home review draft:", error);
      new Notice(this.copy.conversation.cannotCreateReviewSession(errorMessage(error)));
    }
  }

  private async openJournal(date: Date): Promise<void> {
    const existing = this.dataService.existingJournalForDate(date);
    if (existing instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(existing, { active: true });
      return;
    }
    this.openJournalTemplate(date);
  }

  private openJournalTemplate(date: Date): void {
    const customTemplates = this.dataService.listCustomTemplates();
    if (this.data) this.data.customTemplates = customTemplates;
    new JournalTemplateModal(this.app, {
      service: this.dataService,
      customTemplates: [...customTemplates],
      date,
      language: this.language,
      onCreated: () => void this.refresh()
    }).open();
  }

  }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
