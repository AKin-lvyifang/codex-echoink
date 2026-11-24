import { NEXT, failureText, type ErrorCopy, actionFailureText } from "../core/error-copy";
import { moduleOwnerLabel } from "../ui/module-owner-modal";
export { todoPageRecords } from "./todo-page-model";
import { projectKey } from "./todo-page-model";
import { ItemView, Notice, TFolder, type TAbstractFile, type EventRef, type WorkspaceLeaf, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, applyDeleteButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { ForegroundView } from "../ui/foreground-view";
import { confirmModal } from "../ui/modals";
import type { ParsedTodoRecord } from "./todo-markdown";
import { getTodoProjects, resolveTodoProject, type TodoProject } from "./todo-projects";
import { prefillWorkbenchModule } from "./module-navigation";
import { todayKey } from "./home-todos";
import {
  addDays, addMonths, categoryColor, groupTodos, layoutTimed, matchesSmartList, monthGrid, parseDateKey, parseQuickAdd,
  projectIcon, removeQuickAddToken, searchTodos, smartListCounts, snapMinutes, timeOf, todoBucket, todoSubtasks, weekdayOf,
  type QuickAddToken, type TodoBucket, type TodoPlannerFilter, type TodoSmartList
} from "./todo-planner";
import { parsePeopleNames, joinPeopleNames } from "./todo-people";

export const TODO_PAGE_VIEW_TYPE = "echoink-todo-page";
type TodoView = "list" | "calendar";
type CalendarMode = "month" | "week" | "day";
interface TodoPageState {
  filter: TodoPlannerFilter;
  view: TodoView;
  calendar: CalendarMode;
  anchor: string;
  selected: string | null;
  query: string;
  draft: string;
  draftOff: string[];
  doneOpen: boolean;
  expanded: string[];
  pageScroll: number;
  timelineScroll: number | null;
}
const HOUR_HEIGHT = 44, TIMELINE_START = 7, TIMELINE_END = 23;
const savedStates = new WeakMap<CodexForObsidianPlugin, TodoPageState>();
const keyOf = (record: ParsedTodoRecord): string => record.id || `line:${record.lineStart}`;

/** To-do page: smart lists, grouped list, calendar and an inline detail panel. */
export class TodoPageView extends ItemView {
  private readonly state: TodoPageState;
  private foreground: ForegroundView | null = null;
  private unsubscribe: (() => void) | null = null;
  private vaultEvents: EventRef[] = [];
  private projects: TodoProject[] = [];
  private closed = true;
  private generation = 0;
  private initialized = false;
  private settingsSignature = "";
  private dragKey: string | null = null;
  private dragGrab = 0;
  private busy = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.state = savedStates.get(plugin) ?? { filter: { kind: "smart", id: "today" }, view: "list", calendar: "month", anchor: todayKey(), selected: null,
      query: "", draft: "", draftOff: [], doneOpen: false, expanded: [], pageScroll: 0, timelineScroll: null };
    savedStates.set(plugin, this.state);
  }
  getViewType(): string { return TODO_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.t("待办", "To-dos"); }
  getIcon(): string { return "list-todo"; }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private field(name: string): HTMLElement { return this.contentEl.querySelector<HTMLElement>(`[data-todo-page="${name}"]`)!; }
  private active(): boolean { return !this.closed && (this.foreground?.isActive() ?? true); }
  private signature(): string {
    return JSON.stringify([new Date().toDateString(), this.plugin.settings.settingsLanguage, this.plugin.settings.todoCategories,
      this.plugin.settings.knowledgeBase?.folderBindings, this.plugin.settings.agentRegistry]);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("echoink-todo-page");
    this.renderShell();
    this.foreground = new ForegroundView(this, active => {
      if (active) { this.attachListeners(); void this.refresh(); }
      else { this.rememberScroll(); this.detachListeners(); }
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshIfSettingsChanged()));
    if (this.active()) this.attachListeners();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.rememberScroll();
    this.closed = true; this.generation++;
    this.detachListeners();
    this.foreground?.dispose(); this.foreground = null;
    disposeOriginControls(this.contentEl);
  }
  private attachListeners(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.plugin.getTodoStore().subscribe(() => { if (this.active()) this.renderData(); });
    const changed = (file: TAbstractFile, oldPath?: string) => {
      if (!this.active()) return;
      if (file.path === this.plugin.getTodoStore().sourcePath || oldPath === this.plugin.getTodoStore().sourcePath) void this.refresh();
      else if (file instanceof TFolder) this.renderData();
    };
    const renamed = (file: TAbstractFile, oldPath: string) => {
      if (!this.active()) return;
      const filter = this.state.filter;
      if (file instanceof TFolder && filter.kind === "project" && filter.key.startsWith("path:")) {
        const selectedPath = filter.key.slice(5);
        if (selectedPath === oldPath || selectedPath.startsWith(`${oldPath}/`)) filter.key = `path:${file.path}${selectedPath.slice(oldPath.length)}`;
      }
      changed(file, oldPath);
    };
    this.vaultEvents.push(this.app.vault.on("create", changed), this.app.vault.on("delete", changed),
      this.app.vault.on("rename", renamed), this.app.vault.on("modify", file => changed(file)));
  }
  private detachListeners(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    for (const event of this.vaultEvents) this.app.vault.offref(event);
    this.vaultEvents = [];
  }
  refreshIfSettingsChanged(): void { if (this.active() && this.settingsSignature !== this.signature()) this.refreshLanguage(); }
  refreshLanguage(): void { if (this.active()) this.renderData(); }
  async refresh(): Promise<void> {
    if (!this.active()) return;
    const generation = ++this.generation;
    const status = this.field("status");
    if (!this.initialized) status.setText(this.t("正在读取待办…", "Reading to-dos…"));
    try {
      const store = this.plugin.getTodoStore();
      await store.initialize();
      await store.reload();
      if (this.closed || generation !== this.generation || !this.active()) return;
      this.initialized = true;
      disposeOriginControls(status); status.empty();
      this.field("data").hidden = false;
      this.renderData();
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      this.showError(error);
    }
  }
  private showError(error: unknown): void {
    this.field("data").hidden = true;
    const status = this.field("status"); disposeOriginControls(status); status.empty();
    status.createSpan({ text: this.t("待办暂时无法读取", "To-dos are unavailable") + `：${error instanceof Error ? error.message : String(error)}`
      + (this.initialized ? this.t(" · 尚未更新", " · Not updated") : "") });
    this.button(status, this.t("重试", "Retry"), () => this.refresh());
  }

  /* ---------- 外框 ---------- */
  private renderShell(): void {
    disposeOriginControls(this.contentEl); this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "todo-shell" });
    shell.createEl("nav", { cls: "todo-rail", attr: { "data-todo-page": "rail", "aria-label": this.t("待办筛选", "To-do lists") } });
    const main = shell.createEl("section", { cls: "todo-main", attr: { "data-todo-page": "main" } });
    main.createDiv({ cls: "todo-page-header", attr: { "data-todo-page": "header" } });
    main.createDiv({ cls: "todo-page-status", attr: { "data-todo-page": "status", role: "status", "aria-live": "polite" } });
    const data = main.createDiv({ cls: "todo-page-data", attr: { "data-todo-page": "data" } }); data.hidden = true;
    data.createDiv({ cls: "todo-quick", attr: { "data-todo-page": "quick" } });
    data.createDiv({ cls: "todo-tools", attr: { "data-todo-page": "tools" } });
    data.createDiv({ cls: "todo-body", attr: { "data-todo-page": "list" } });
    shell.createEl("aside", { cls: "todo-detail", attr: { "data-todo-page": "detail" } });
  }
  private button(parent: HTMLElement, text: string, action: () => unknown, cls = ""): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `todo-page-button ${cls}` });
    button.onclick = async event => {
      event.stopPropagation();
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await Promise.resolve(result); } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { new Notice(actionFailureText(error, this.plugin.settings.settingsLanguage)); }
    };
    return button;
  }
  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => unknown, cls = ""): HTMLButtonElement {
    const button = this.button(parent, "", action, `is-icon ${cls}`);
    button.setAttribute("aria-label", label); setIcon(button, icon); return button;
  }
  private renderData(): void {
    if (!this.initialized || !this.active()) return;
    try {
      this.projects = getTodoProjects(this.plugin);
      this.settingsSignature = this.signature();
      const records = this.plugin.getTodoStore().snapshot();
      if (this.state.selected && !records.some(record => keyOf(record) === this.state.selected)) this.state.selected = null;
      this.renderRail(records); this.renderHeader(); this.renderQuickAdd(); this.renderTools(); this.renderBody(); this.renderDetail();
    } catch (error) { this.showError(error); }
  }
  private rememberScroll(): void {
    this.state.pageScroll = this.field("main")?.scrollTop ?? 0;
    const timeline = this.contentEl.querySelector<HTMLElement>(".todo-timeline-scroll");
    if (timeline) this.state.timelineScroll = timeline.scrollTop;
  }

  /* ---------- 筛选 ---------- */
  private today(): string { return todayKey(); }
  private categoryColor(name: string): string { return categoryColor(name, this.plugin.settings.todoCategories); }
  private projectOf(record: ParsedTodoRecord) {
    const resolved = resolveTodoProject(record.project, this.projects);
    return resolved.status === "none" ? null : resolved;
  }
  private inFilter(record: ParsedTodoRecord): boolean {
    const filter = this.state.filter;
    if (filter.kind === "smart") return matchesSmartList(record, filter.id, this.today());
    if (filter.kind === "category") return record.categoryName === filter.name;
    return projectKey(record, this.projects) === filter.key;
  }
  private visible(): ParsedTodoRecord[] {
    const records = this.plugin.getTodoStore().snapshot().filter(record => this.inFilter(record));
    return searchTodos(records, this.state.query, record => this.projectOf(record)?.label ?? "");
  }
  private setFilter(filter: TodoPlannerFilter): void { this.state.filter = filter; this.state.draftOff = []; this.renderData(); }
  private renderRail(records: readonly ParsedTodoRecord[]): void {
    const rail = this.field("rail"); disposeOriginControls(rail); rail.empty();
    const counts = smartListCounts(records, this.today()), filter = this.state.filter;
    const item = (selected: boolean, label: string, count: string, onClick: () => void, lead: (host: HTMLElement) => void) => {
      const row = rail.createEl("button", { cls: `todo-rail-item${selected ? " is-selected" : ""}`, attr: { type: "button", "aria-current": selected ? "true" : "false" } });
      lead(row.createSpan({ cls: "todo-rail-lead", attr: { "aria-hidden": "true" } }));
      row.createSpan({ cls: "todo-rail-name", text: label });
      row.createSpan({ cls: "todo-count", text: count });
      row.onclick = onClick;
      this.installDrop(row, null);
    };
    const smart: [TodoSmartList, string, string][] = [["today", "sun", this.t("今天", "Today")], ["upcoming", "calendar-clock", this.t("接下来", "Upcoming")], ["all", "inbox", this.t("全部", "All")], ["done", "circle-check", this.t("已完成", "Done")]];
    for (const [id, icon, label] of smart) item(filter.kind === "smart" && filter.id === id, label, String(counts[id]), () => this.setFilter({ kind: "smart", id }), host => setIcon(host, icon));
    if (this.projects.length) {
      rail.createDiv({ cls: "todo-rail-heading", text: this.t("项目", "Projects") });
      for (const project of this.projects) {
        const key = `path:${project.path}`, mine = records.filter(record => projectKey(record, this.projects) === key);
        const done = mine.filter(record => record.done).length;
        item(filter.kind === "project" && filter.key === key, project.label, String(mine.length - done), () => this.setFilter({ kind: "project", key }), host => this.ring(host, mine.length ? done / mine.length : 0, 16));
      }
    }
    const names = [...new Set([...this.plugin.settings.todoCategories.map(category => category.name), ...records.map(record => record.categoryName).filter(Boolean)])];
    if (names.length) {
      rail.createDiv({ cls: "todo-rail-heading", text: this.t("分类", "Categories") });
      for (const name of names) item(filter.kind === "category" && filter.name === name, name, String(records.filter(record => !record.done && record.categoryName === name).length),
        () => this.setFilter({ kind: "category", name }), host => { host.createSpan({ cls: "todo-dot" }).style.setProperty("--todo-c", this.categoryColor(name)); });
    }
  }
  private ring(host: HTMLElement, value: number, size: number): void {
    const stroke = size > 18 ? 2.6 : 2.2, radius = (size - stroke) / 2, length = 2 * Math.PI * radius;
    const ns = "http://www.w3.org/2000/svg", svg = host.ownerDocument.createElementNS(ns, "svg");
    svg.setAttribute("class", "todo-ring"); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    for (const [cls, offset] of [["todo-ring-bg", 0], ["todo-ring-fg", length * (1 - value)]] as const) {
      const circle = host.ownerDocument.createElementNS(ns, "circle");
      for (const [key, val] of Object.entries({ cx: size / 2, cy: size / 2, r: radius, fill: "none", "stroke-width": stroke, "stroke-dasharray": length, "stroke-dashoffset": offset, "stroke-linecap": "round", class: cls })) circle.setAttribute(key, String(val));
      svg.appendChild(circle);
    }
    host.appendChild(svg);
  }

  /* ---------- 页头 ---------- */
  private renderHeader(): void {
    const header = this.field("header"); disposeOriginControls(header); header.empty();
    const title = header.createDiv({ cls: "todo-page-title" });
    const back = this.iconButton(title, "arrow-left", this.t("返回工作台", "Back to workbench"), () => this.plugin.activateHomeView({ keepRightSidebar: true }));
    back.dataset.todoPage = "back";
    back.dataset.echoinkWorkbenchBack = "";
    const filter = this.state.filter, records = this.plugin.getTodoStore().snapshot();
    const createHeading = (text: string) => {
      title.createEl("h1", { text }).dataset.echoinkModuleTitle = "";
    };
    if (filter.kind === "smart") {
      createHeading({ today: this.t("今天", "Today"), upcoming: this.t("接下来", "Upcoming"), all: this.t("全部", "All"), done: this.t("已完成", "Done") }[filter.id]);
      if (filter.id === "today") title.createSpan({ cls: "todo-page-date", text: this.dayLabel(this.today()) });
      if (filter.id === "done") { const stats = this.plugin.getTodoStore().completionStatistics(); title.createSpan({ cls: "todo-count is-wide", text: this.t(`累计完成 ${stats.total} · 今日完成 ${stats.today}`, `Total completed: ${stats.total} · Today: ${stats.today}`) }); }
    } else if (filter.kind === "category") {
      title.createSpan({ cls: "todo-dot is-large" }).style.setProperty("--todo-c", this.categoryColor(filter.name));
      createHeading(filter.name);
    } else {
      const mine = records.filter(record => projectKey(record, this.projects) === filter.key), done = mine.filter(record => record.done).length;
      this.ring(title, mine.length ? done / mine.length : 0, 22);
      const project = this.projects.find(item => `path:${item.path}` === filter.key);
      createHeading(project?.label ?? filter.key.slice(filter.key.indexOf(":") + 1));
      title.createSpan({ cls: "todo-count is-wide", text: this.t(`已完成 ${done} / ${mine.length}`, `${done} / ${mine.length} done`) });
    }
    const actions = header.createDiv({ cls: "todo-page-actions" });
    this.segments(actions, "view", [["list", this.t("列表", "List"), "list"], ["calendar", this.t("日历", "Calendar"), "calendar"]], this.state.view, value => { this.state.view = value as TodoView; this.state.timelineScroll = null; this.renderData(); });
    this.button(actions, moduleOwnerLabel(this.plugin, "todos"), () => this.handoff(), "is-primary").dataset.todoPage = "owner";
  }
  private segments(parent: HTMLElement, name: string, options: [string, string, string?][], value: string, change: (value: string) => void): void {
    const group = parent.createDiv({ cls: "todo-segments", attr: { role: "tablist", "data-segment": name } });
    for (const [key, label, icon] of options) {
      const button = group.createEl("button", { cls: `todo-segment${key === value ? " is-selected" : ""}`, attr: { type: "button", role: "tab", "aria-selected": String(key === value) } });
      if (icon) setIcon(button.createSpan({ cls: "todo-segment-icon", attr: { "aria-hidden": "true" } }), icon);
      button.createSpan({ text: label });
      button.onclick = () => { if (key !== value) change(key); };
    }
  }
  private async handoff(): Promise<void> {
    const prompt = this.t("帮我把今天和本周的待办排个顺序", "Help me prioritize my to-dos for today and this week");
    const filter = this.state.filter;
    const scope = filter.kind === "project" ? this.t(`项目：${this.projects.find(item => `path:${item.path}` === filter.key)?.label ?? filter.key.slice(5)}`, `Project: ${filter.key.slice(5)}`)
      : filter.kind === "category" ? this.t(`分类：${filter.name}`, `Category: ${filter.name}`) : "";
    await prefillWorkbenchModule(this.plugin, "todos", scope ? `${prompt}（${scope}）` : prompt);
  }

  /* ---------- 快速添加 ---------- */
  private quickContext() {
    return { today: this.today(), categories: this.plugin.settings.todoCategories.map(category => category.name), projects: this.projects.map(project => ({ value: project.value, name: project.name, label: project.label })) };
  }
  private quickDefaults(): { date?: string; category?: string; project?: string } {
    const filter = this.state.filter, off = new Set(this.state.draftOff);
    return {
      date: filter.kind === "smart" && filter.id === "today" && !off.has("date") ? this.today() : undefined,
      category: filter.kind === "category" && !off.has("category") ? filter.name : undefined,
      project: filter.kind === "project" && !off.has("project") ? this.projects.find(item => `path:${item.path}` === filter.key)?.value : undefined
    };
  }
  private renderQuickAdd(): void {
    const host = this.field("quick");
    let input = host.querySelector<HTMLInputElement>("input.todo-quick-input");
    if (!input) {
      host.empty();
      const box = host.createEl("label", { cls: "todo-quick-box" });
      setIcon(box.createSpan({ cls: "todo-quick-icon", attr: { "aria-hidden": "true" } }), "plus");
      input = box.createEl("input", { cls: "todo-quick-input", attr: { type: "text", placeholder: this.t("添加待办", "Add a to-do"), "aria-label": this.t("添加待办", "Add a to-do"), autocomplete: "off" } });
      host.createDiv({ cls: "todo-quick-chips", attr: { "data-todo-page": "chips" } });
      input.addEventListener("input", () => { this.state.draft = input!.value; this.renderChips(); });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void this.submitQuick(input!.value); } });
    }
    if (input.value !== this.state.draft) input.value = this.state.draft;
    input.placeholder = this.t("添加待办", "Add a to-do");
    this.renderChips();
  }
  private renderChips(): void {
    const host = this.field("chips"); if (!host) return; host.empty();
    if (!this.state.draft.trim()) return;
    const parsed = parseQuickAdd(this.state.draft, this.quickContext()), defaults = this.quickDefaults();
    const chip = (icon: string | null, color: string | null, text: string, remove: () => void, implied = false) => {
      const element = host.createSpan({ cls: `todo-chip${implied ? " is-implied" : ""}` });
      if (color) element.createSpan({ cls: "todo-dot" }).style.setProperty("--todo-c", color);
      else if (icon) setIcon(element.createSpan({ cls: "todo-chip-icon", attr: { "aria-hidden": "true" } }), icon);
      element.createSpan({ text });
      const close = element.createEl("button", { cls: "todo-chip-remove", attr: { type: "button", "aria-label": this.t(`去掉 ${text}`, `Remove ${text}`) } });
      setIcon(close, "x");
      close.onclick = event => { event.preventDefault(); remove(); this.renderQuickAdd(); this.field("quick").querySelector<HTMLInputElement>("input")?.focus(); };
    };
    const drop = (token: QuickAddToken) => () => { this.state.draft = removeQuickAddToken(this.state.draft, token); };
    const off = (kind: string) => () => { this.state.draftOff.push(kind); };
    const token = (kind: QuickAddToken["kind"]) => parsed.tokens.find(item => item.kind === kind);
    const date = token("date"), time = token("time"), category = token("category"), project = token("project");
    if (date) chip("calendar", null, this.dayLabel(date.value), drop(date)); else if (defaults.date) chip("calendar", null, this.t("今天", "Today"), off("date"), true);
    if (time) chip("clock", null, time.value, drop(time));
    if (category) chip(null, this.categoryColor(category.value), category.value, drop(category)); else if (defaults.category) chip(null, this.categoryColor(defaults.category), defaults.category, off("category"), true);
    const projectLabel = (value: string) => this.projects.find(item => item.value === value)?.label ?? value;
    if (project) chip(projectIcon(projectLabel(project.value)), null, projectLabel(project.value), drop(project)); else if (defaults.project) chip(projectIcon(projectLabel(defaults.project)), null, projectLabel(defaults.project), off("project"), true);
    for (const person of parsed.tokens.filter(item => item.kind === "person")) chip("user", null, person.value, drop(person));
  }
  private async submitQuick(text: string, forceDate?: string): Promise<void> {
    const parsed = parseQuickAdd(text, this.quickContext());
    if (!parsed.title) return;
    const defaults = this.quickDefaults();
    try {
      await this.plugin.getTodoStore().addTodo({ title: parsed.title, dueDate: forceDate ?? parsed.dueDate ?? defaults.date ?? "", dueTime: parsed.dueDate || forceDate || defaults.date ? parsed.dueTime ?? "" : "",
        categoryName: parsed.categoryName ?? defaults.category ?? "", project: parsed.project ?? defaults.project ?? "", people: joinPeopleNames(parsed.people) });
      if (!forceDate) { this.state.draft = ""; this.state.draftOff = []; }
      this.renderData();
    } catch (error) { new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)); }
  }

  /* ---------- 搜索 ---------- */
  private renderTools(): void {
    const host = this.field("tools");
    let input = host.querySelector<HTMLInputElement>("input.todo-search-input");
    if (!input) {
      host.empty();
      const box = host.createEl("label", { cls: "todo-search" });
      setIcon(box.createSpan({ cls: "todo-search-icon", attr: { "aria-hidden": "true" } }), "search");
      input = box.createEl("input", { cls: "todo-search-input", attr: { type: "search", autocomplete: "off" } });
      input.addEventListener("input", () => { this.state.query = input!.value; this.renderBody(); });
    }
    input.placeholder = this.t("搜索", "Search"); input.setAttribute("aria-label", this.t("搜索待办", "Search to-dos"));
    if (input.value !== this.state.query) input.value = this.state.query;
  }

  /* ---------- 列表 ---------- */
  private renderBody(): void {
    const host = this.field("list"); disposeOriginControls(host); host.empty();
    host.classList.toggle("is-calendar", this.state.view === "calendar");
    if (this.state.view === "calendar") { this.renderCalendar(host); return; }
    const records = this.visible();
    if (!records.length) { host.createDiv({ cls: "todo-empty", text: this.plugin.getTodoStore().snapshot().length ? this.t("没有符合条件的待办", "No matching to-dos") : this.t("暂时没有待办", "No to-dos yet") }); return; }
    const { groups, done } = groupTodos(records, this.today());
    const filter = this.state.filter;
    if (filter.kind === "smart" && filter.id === "done") { this.rows(host, done); return; }
    const labels: Record<TodoBucket, string> = { overdue: this.t("逾期", "Overdue"), today: this.t("今天", "Today"), tomorrow: this.t("明天", "Tomorrow"), week: this.t("7 天内", "Next 7 days"), later: this.t("以后", "Later"), none: this.t("没有日期", "No date") };
    for (const group of groups) {
      const section = host.createEl("section", { cls: `todo-group is-${group.bucket}` });
      const heading = section.createDiv({ cls: "todo-group-head" });
      heading.createEl("h2", { text: labels[group.bucket] }); heading.createSpan({ cls: "todo-count", text: String(group.records.length) });
      this.rows(section, group.records);
    }
    if (done.length) {
      const section = host.createEl("section", { cls: "todo-group is-done" });
      const toggle = section.createEl("button", { cls: `todo-done-toggle${this.state.doneOpen ? " is-open" : ""}`, attr: { type: "button", "aria-expanded": String(this.state.doneOpen) } });
      setIcon(toggle.createSpan({ cls: "todo-done-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
      toggle.createSpan({ text: this.t("已完成", "Done") }); toggle.createSpan({ cls: "todo-count", text: String(done.length) });
      toggle.onclick = () => { this.state.doneOpen = !this.state.doneOpen; this.renderBody(); };
      if (this.state.doneOpen) this.rows(section, done);
    }
  }
  private rows(parent: HTMLElement, records: readonly ParsedTodoRecord[]): void {
    const list = parent.createDiv({ cls: "todo-rows" });
    for (const record of records) this.row(list, record);
  }
  private check(parent: HTMLElement, record: ParsedTodoRecord): HTMLButtonElement {
    const check = parent.createEl("button", { cls: `todo-check${record.done ? " is-checked" : ""}`, attr: { type: "button", role: "checkbox", "aria-checked": String(record.done), "aria-label": this.t(`完成：${record.title}`, `Complete: ${record.title}`) } });
    check.style.setProperty("--todo-c", this.categoryColor(record.categoryName));
    setIcon(check, "check");
    check.onclick = event => { event.stopPropagation(); void this.toggle(record, !record.done, check); };
    return check;
  }
  private row(list: HTMLElement, record: ParsedTodoRecord): void {
    const key = keyOf(record), item = list.createDiv({ cls: "todo-item" });
    const row = item.createDiv({ cls: `todo-row${record.done ? " is-done" : ""}${this.state.selected === key ? " is-selected" : ""}`, attr: { "data-todo-key": key, tabindex: "0" } });
    row.onclick = () => this.select(key);
    row.onkeydown = event => { if (event.key === "Enter") this.select(key); };
    this.check(row, record);
    const main = row.createDiv({ cls: "todo-row-main" });
    main.createSpan({ cls: "todo-row-title", text: record.title || this.t("（无标题）", "(Untitled)") });
    const subtasks = todoSubtasks(record);
    if (subtasks.length) {
      const open = this.state.expanded.includes(key);
      const toggle = main.createEl("button", { cls: `todo-subcount${open ? " is-open" : ""}`, attr: { type: "button", "aria-expanded": String(open), "aria-label": this.t("子任务", "Subtasks") } });
      setIcon(toggle.createSpan({ cls: "todo-subcount-icon", attr: { "aria-hidden": "true" } }), "chevron-right");
      toggle.createSpan({ text: `${subtasks.filter(task => task.done).length}/${subtasks.length}` });
      toggle.onclick = event => { event.stopPropagation(); this.state.expanded = open ? this.state.expanded.filter(value => value !== key) : [...this.state.expanded, key]; this.renderBody(); };
    }
    const project = this.projectOf(record);
    if (project && this.state.filter.kind !== "project") {
      const tag = main.createSpan({ cls: "todo-project-tag" });
      setIcon(tag.createSpan({ cls: "todo-project-icon", attr: { "aria-hidden": "true" } }), projectIcon(project.name));
      tag.createSpan({ text: project.status === "resolved" ? project.label : project.status === "ambiguous" ? this.t("有同名项目", "Duplicate project") : this.t("项目已不存在", "Project removed") });
    }
    const people = parsePeopleNames(record.people);
    if (people.length) { const element = main.createSpan({ cls: "todo-people" }); setIcon(element.createSpan({ attr: { "aria-hidden": "true" } }), "user"); element.createSpan({ text: people.join("、") }); }
    if (record.diaryJournalPath) {
      const source = main.createEl("button", { cls: "todo-source", attr: { type: "button", "aria-label": this.t("AI 从日记记的", "AI from journal") } });
      setIcon(source, "notebook-pen");
      source.onclick = event => { event.stopPropagation(); void this.app.workspace.openLinkText(record.diaryJournalPath!, this.plugin.getTodoStore().sourcePath); };
    }
    const late = !record.done && todoBucket(record, this.today()) === "overdue";
    row.createSpan({ cls: `todo-time${late ? " is-late" : ""}`, text: this.timeLabel(record) });
    const actions = row.createDiv({ cls: "todo-row-actions" });
    const remove = this.iconButton(actions, "trash-2", this.t("删除", "Delete"), () => this.remove(record));
    applyDeleteButton(remove, { iconOnly: true });
    if (subtasks.length && this.state.expanded.includes(key)) {
      const area = item.createDiv({ cls: "todo-subrows" });
      for (const task of subtasks) this.subtask(area, record, task);
    }
  }
  private subtask(parent: HTMLElement, record: ParsedTodoRecord, task: { line: number; title: string; done: boolean }): void {
    const label = parent.createEl("label", { cls: `todo-subrow${task.done ? " is-done" : ""}` });
    const box = label.createEl("input", { attr: { type: "checkbox" } }); box.checked = task.done;
    label.createSpan({ text: task.title });
    box.onchange = () => { box.disabled = true; void this.plugin.getTodoStore().updateSubtasks(record, { line: task.line, done: box.checked })
      .catch(error => { new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)); this.renderData(); }); };
  }
  private dayLabel(key: string): string {
    const date = parseDateKey(key), week = this.t("日一二三四五六", "SMTWTFS")[date.getDay()];
    return this.plugin.settings.settingsLanguage === "en" ? `${date.toLocaleDateString("en", { month: "short", day: "numeric" })} ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]}` : `${date.getMonth() + 1}月${date.getDate()}日 周${week}`;
  }
  private shortDate(key: string): string {
    const date = parseDateKey(key);
    return this.plugin.settings.settingsLanguage === "en" ? date.toLocaleDateString("en", { month: "short", day: "numeric" }) : `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  private timeLabel(record: ParsedTodoRecord): string {
    if (!record.dueDate) return "";
    if (record.done) return this.shortDate(record.dueDate);
    const bucket = todoBucket(record, this.today()), time = record.dueTime ? ` ${record.dueTime}` : "";
    if (bucket === "overdue") return this.shortDate(record.dueDate);
    if (bucket === "today" || bucket === "tomorrow") return record.dueTime ?? "";
    if (bucket === "week") return `${this.t("周" + "日一二三四五六"[weekdayOf(record.dueDate)], ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOf(record.dueDate)])}${time}`;
    return `${this.shortDate(record.dueDate)}${time}`;
  }

  /* ---------- 日历 ---------- */
  private renderCalendar(host: HTMLElement): void {
    const bar = host.createDiv({ cls: "todo-cal-bar" });
    const step = (delta: number) => {
      this.state.anchor = this.state.calendar === "month" ? addMonths(this.state.anchor, delta) : addDays(this.state.anchor, delta * (this.state.calendar === "week" ? 7 : 1));
      this.state.timelineScroll = null; this.renderBody();
    };
    this.iconButton(bar, "chevron-left", this.t("上一个", "Previous"), () => step(-1));
    this.iconButton(bar, "chevron-right", this.t("下一个", "Next"), () => step(1));
    bar.createEl("h2", { text: this.calendarTitle() });
    this.button(bar, this.t("今天", "Today"), () => { this.state.anchor = this.today(); this.state.timelineScroll = null; this.renderBody(); }, "is-small");
    this.segments(bar, "calendar", [["month", this.t("月", "Month")], ["week", this.t("周", "Week")], ["day", this.t("日", "Day")]], this.state.calendar, value => {
      this.state.calendar = value as CalendarMode; if (value !== "month") this.state.anchor = this.today(); this.state.timelineScroll = null; this.renderBody();
    });
    if (this.state.calendar === "month") this.renderMonth(host);
    else if (this.state.calendar === "week") this.renderWeek(host);
    else this.renderDay(host);
  }
  private calendarTitle(): string {
    const anchor = parseDateKey(this.state.anchor);
    if (this.state.calendar === "month") return this.plugin.settings.settingsLanguage === "en" ? anchor.toLocaleDateString("en", { year: "numeric", month: "long" }) : `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`;
    if (this.state.calendar === "week") return `${this.shortDate(this.state.anchor)} – ${this.shortDate(addDays(this.state.anchor, 6))}`;
    return this.dayLabel(this.state.anchor);
  }
  private dated(): ParsedTodoRecord[] { return this.visible().filter(record => !!record.dueDate); }
  private bar(parent: HTMLElement, record: ParsedTodoRecord): HTMLElement {
    const late = !record.done && todoBucket(record, this.today()) === "overdue", key = keyOf(record);
    const bar = parent.createDiv({ cls: `todo-bar${record.done ? " is-done" : ""}${late ? " is-late" : ""}${this.state.selected === key ? " is-selected" : ""}`, attr: { draggable: "true", "data-todo-key": key, title: record.title } });
    bar.style.setProperty("--todo-c", this.categoryColor(record.categoryName));
    if (record.dueTime) bar.createSpan({ cls: "todo-bar-time", text: record.dueTime });
    const project = this.projectOf(record);
    if (project) setIcon(bar.createSpan({ cls: "todo-bar-project", attr: { "aria-hidden": "true" } }), projectIcon(project.name));
    bar.createSpan({ cls: "todo-bar-title", text: record.title });
    bar.onclick = event => { event.stopPropagation(); this.select(key); };
    this.installDrag(bar, key);
    return bar;
  }
  private renderMonth(host: HTMLElement): void {
    const { days, month } = monthGrid(this.state.anchor), records = this.dated(), today = this.today();
    const grid = host.createDiv({ cls: "todo-month" });
    const head = grid.createDiv({ cls: "todo-month-head" });
    for (const name of this.t("一二三四五六日", "MTWTFSS")) head.createDiv({ text: this.plugin.settings.settingsLanguage === "en" ? name : `周${name}` });
    const body = grid.createDiv({ cls: "todo-month-grid" });
    for (const day of days) {
      const date = parseDateKey(day), list = records.filter(record => record.dueDate === day).sort((a, b) => Number(a.done) - Number(b.done) || (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"));
      const cell = body.createDiv({ cls: `todo-cell${date.getMonth() + 1 !== month ? " is-other" : ""}${day === today ? " is-today" : ""}${date.getDay() % 6 === 0 ? " is-weekend" : ""}`, attr: { "data-todo-date": day } });
      cell.createSpan({ cls: "todo-cell-day", text: String(date.getDate()) });
      for (const record of list.slice(0, 3)) this.bar(cell, record);
      if (list.length > 3) {
        const more = cell.createEl("button", { cls: "todo-more", text: `+${list.length - 3}`, attr: { type: "button" } });
        more.onclick = event => { event.stopPropagation(); this.state.calendar = "day"; this.state.anchor = day; this.state.timelineScroll = null; this.renderBody(); };
      }
      cell.onclick = event => { if (event.target === cell || (event.target as HTMLElement).classList.contains("todo-cell-day")) this.cellInput(cell, day); };
      this.installDrop(cell, { date: day, keepTime: true });
    }
  }
  private cellInput(cell: HTMLElement, day: string): void {
    if (cell.querySelector("input")) return;
    const input = cell.createEl("input", { cls: "todo-cell-input", attr: { type: "text", placeholder: this.t("新增待办", "New to-do"), "aria-label": this.t("新增待办", "New to-do") } });
    input.focus();
    let done = false;
    const close = () => { if (!done) { done = true; input.remove(); } };
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") close();
      if (event.key === "Enter" && !event.isComposing && input.value.trim()) { done = true; void this.submitQuick(input.value, day); }
    });
    input.addEventListener("blur", () => window.setTimeout(close, 120));
  }
  private renderWeek(host: HTMLElement): void {
    const days = Array.from({ length: 7 }, (_, index) => addDays(this.state.anchor, index)), records = this.dated(), today = this.today();
    const frame = host.createDiv({ cls: "todo-week" });
    const head = frame.createDiv({ cls: "todo-week-head" }); head.createDiv();
    for (const day of days) {
      const cell = head.createDiv({ cls: day === today ? "is-today" : "" });
      cell.createSpan({ text: this.plugin.settings.settingsLanguage === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekdayOf(day)] : `周${"日一二三四五六"[weekdayOf(day)]}` });
      cell.createSpan({ cls: "todo-cell-day", text: String(parseDateKey(day).getDate()) });
    }
    const allDay = frame.createDiv({ cls: "todo-week-allday" });
    allDay.createDiv({ cls: "todo-week-label", text: this.t("全天", "All day") });
    for (const day of days) {
      const cell = allDay.createDiv({ attr: { "data-todo-date": day } });
      for (const record of records.filter(item => item.dueDate === day && !item.dueTime)) this.bar(cell, record);
      this.installDrop(cell, { date: day, keepTime: false });
    }
    this.timeline(frame, days, records);
  }
  private renderDay(host: HTMLElement): void {
    const day = this.state.anchor, records = this.dated();
    const wrap = host.createDiv({ cls: "todo-day" });
    this.timeline(wrap.createDiv({ cls: "todo-week" }), [day], records);
    const side = wrap.createDiv({ cls: "todo-unscheduled", attr: { "data-todo-date": day } });
    const open = records.filter(record => record.dueDate === day && !record.dueTime && !record.done);
    const heading = side.createDiv({ cls: "todo-group-head" }); heading.createEl("h2", { text: this.t("未排时间", "Unscheduled") }); heading.createSpan({ cls: "todo-count", text: String(open.length) });
    if (!open.length) side.createDiv({ cls: "todo-empty is-small", text: this.t("都排好了", "All scheduled") });
    for (const record of open) {
      const row = side.createDiv({ cls: "todo-unscheduled-item", attr: { draggable: "true", "data-todo-key": keyOf(record) } });
      row.createSpan({ cls: "todo-dot" }).style.setProperty("--todo-c", this.categoryColor(record.categoryName));
      row.createSpan({ cls: "todo-bar-title", text: record.title });
      row.onclick = () => this.select(keyOf(record));
      this.installDrag(row, keyOf(record));
    }
    this.installDrop(side, { date: day, keepTime: false });
  }
  private timeline(parent: HTMLElement, days: string[], records: readonly ParsedTodoRecord[]): void {
    const scroll = parent.createDiv({ cls: "todo-timeline-scroll" });
    const grid = scroll.createDiv({ cls: "todo-timeline" });
    grid.style.setProperty("--todo-columns", String(days.length));
    grid.style.height = `${(TIMELINE_END - TIMELINE_START) * HOUR_HEIGHT}px`;
    const gutter = grid.createDiv({ cls: "todo-timeline-gutter" });
    for (let hour = TIMELINE_START + 1; hour < TIMELINE_END; hour++) gutter.createSpan({ text: `${String(hour).padStart(2, "0")}:00` }).style.top = `${(hour - TIMELINE_START) * HOUR_HEIGHT}px`;
    const now = new Date(), nowMinutes = now.getHours() * 60 + now.getMinutes(), today = this.today();
    for (const day of days) {
      const column = grid.createDiv({ cls: `todo-timeline-col${day === today ? " is-today" : ""}`, attr: { "data-todo-date": day, "data-todo-timeline": "true" } });
      for (const block of layoutTimed(records.filter(record => record.dueDate === day))) {
        const start = Math.max(block.start, TIMELINE_START * 60), top = (start - TIMELINE_START * 60) / 60 * HOUR_HEIGHT, height = Math.max(22, (block.end - start) / 60 * HOUR_HEIGHT - 2);
        const record = block.record, key = keyOf(record), late = !record.done && todoBucket(record, today) === "overdue";
        const element = column.createDiv({ cls: `todo-block${record.done ? " is-done" : ""}${late ? " is-late" : ""}${this.state.selected === key ? " is-selected" : ""}`, attr: { draggable: "true", "data-todo-key": key, title: record.title } });
        element.style.setProperty("--todo-c", this.categoryColor(record.categoryName));
        Object.assign(element.style, { top: `${top}px`, height: `${height}px`, left: `calc(${100 / block.lanes * block.lane}% + 3px)`, width: `calc(${100 / block.lanes}% - 6px)` });
        element.createSpan({ cls: "todo-block-title", text: record.title });
        if (height > 30) {
          const project = this.projectOf(record);
          element.createSpan({ cls: "todo-block-meta", text: `${record.dueTime}–${timeOf(Math.min(block.end, 24 * 60 - 1))}${project ? ` · ${project.label}` : ""}` });
        }
        element.onclick = event => { event.stopPropagation(); this.select(key); };
        this.installDrag(element, key, true);
      }
      if (day === today && nowMinutes >= TIMELINE_START * 60 && nowMinutes <= TIMELINE_END * 60) column.createDiv({ cls: "todo-now" }).style.top = `${(nowMinutes - TIMELINE_START * 60) / 60 * HOUR_HEIGHT}px`;
      this.installDrop(column, { date: day, timeline: true });
    }
    window.requestAnimationFrame(() => {
      scroll.scrollTop = this.state.timelineScroll ?? (8 - TIMELINE_START) * HOUR_HEIGHT - 10;
      scroll.onscroll = () => { this.state.timelineScroll = scroll.scrollTop; };
    });
  }

  /* ---------- 拖动改期 ---------- */
  private installDrag(element: HTMLElement, key: string, block = false): void {
    element.addEventListener("dragstart", event => {
      this.dragKey = key;
      const rect = element.getBoundingClientRect();
      this.dragGrab = block ? (event.clientY - rect.top) * (element.offsetHeight / (rect.height || 1)) : 0;
      event.dataTransfer?.setData("text/plain", key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      window.setTimeout(() => element.addClass("is-dragging"));
    });
    element.addEventListener("dragend", () => { this.dragKey = null; this.contentEl.querySelectorAll(".is-dragging,.is-drop-target").forEach(node => node.removeClass("is-dragging", "is-drop-target")); });
  }
  private installDrop(element: HTMLElement, target: { date: string; keepTime?: boolean; timeline?: boolean } | null): void {
    if (!target) return;
    element.addEventListener("dragover", event => { if (!this.dragKey) return; event.preventDefault(); element.addClass("is-drop-target"); });
    element.addEventListener("dragleave", () => element.removeClass("is-drop-target"));
    element.addEventListener("drop", event => {
      if (!this.dragKey) return;
      event.preventDefault(); event.stopPropagation(); element.removeClass("is-drop-target");
      const record = this.plugin.getTodoStore().snapshot().find(item => keyOf(item) === this.dragKey);
      this.dragKey = null;
      if (!record) return;
      let dueTime = target.keepTime ? record.dueTime ?? "" : "";
      if (target.timeline) {
        const rect = element.getBoundingClientRect(), scale = element.offsetHeight / (rect.height || 1);
        dueTime = timeOf(snapMinutes((event.clientY - rect.top) * scale - this.dragGrab, HOUR_HEIGHT, TIMELINE_START, TIMELINE_END));
      }
      if (record.dueDate === target.date && (record.dueTime ?? "") === dueTime) return;
      void this.update(record, { dueDate: target.date, dueTime });
    });
  }

  /* ---------- 详情 ---------- */
  private select(key: string): void { this.state.selected = this.state.selected === key ? null : key; this.renderData(); }
  private renderDetail(): void {
    const panel = this.field("detail"); disposeOriginControls(panel); panel.empty();
    const record = this.plugin.getTodoStore().snapshot().find(item => keyOf(item) === this.state.selected);
    this.contentEl.classList.toggle("has-detail", !!record);
    panel.hidden = !record;
    if (!record) return;
    const top = panel.createDiv({ cls: "todo-detail-top" });
    this.iconButton(top, "x", this.t("关闭", "Close"), () => { this.state.selected = null; this.renderData(); });
    const head = panel.createDiv({ cls: "todo-detail-title" });
    this.check(head, record);
    const title = head.createEl("input", { cls: "todo-detail-name", attr: { type: "text", "aria-label": this.t("事项", "Item") } }); title.value = record.title;
    title.onchange = () => { if (title.value.trim() && title.value.trim() !== record.title) void this.update(record, { title: title.value.trim() }); };
    title.onkeydown = event => { if (event.key === "Enter") title.blur(); };
    const fields = panel.createDiv({ cls: "todo-detail-fields" });
    const row = (icon: string | null, label: string) => {
      const element = fields.createDiv({ cls: "todo-detail-row", attr: { title: label } });
      if (icon) setIcon(element.createSpan({ cls: "todo-detail-icon", attr: { "aria-hidden": "true" } }), icon);
      return element;
    };
    const dateRow = row("calendar", this.t("日期和时间", "Date and time"));
    const date = dateRow.createEl("input", { cls: "todo-field", attr: { type: "date", "aria-label": this.t("日期", "Date") } }); date.value = record.dueDate;
    const time = dateRow.createEl("input", { cls: "todo-field", attr: { type: "time", "aria-label": this.t("时间", "Time") } }); time.value = record.dueTime ?? ""; time.disabled = !record.dueDate;
    date.onchange = () => void this.update(record, { dueDate: date.value, dueTime: date.value ? record.dueTime ?? "" : "" });
    time.onchange = () => void this.update(record, { dueTime: time.value });
    const projectRow = row("folder", this.t("项目", "Project"));
    const current = resolveTodoProject(record.project, this.projects);
    const projectOptions = [{ value: "", label: this.t("无项目", "No project") }, ...this.projects.map(project => ({ value: project.value, label: project.label }))];
    if (current.status !== "none" && current.status !== "resolved") projectOptions.push({ value: record.project ?? "", label: current.status === "ambiguous" ? this.t("有同名项目，请重新选择", "Duplicate project; select again") : this.t("项目已不存在", "Project no longer exists") });
    const project = createOriginSelect(projectRow, { attr: { "aria-label": this.t("项目", "Project") } }, projectOptions, current.status === "resolved" ? current.project!.value : record.project ?? "", this.app).element;
    project.onchange = () => void this.update(record, { project: project.value });
    const categoryRow = row(null, this.t("分类", "Category"));
    categoryRow.createSpan({ cls: "todo-dot" }).style.setProperty("--todo-c", this.categoryColor(record.categoryName));
    const names = [...new Set([...this.plugin.settings.todoCategories.map(item => item.name), record.categoryName].filter(Boolean))];
    const category = createOriginSelect(categoryRow, { attr: { "aria-label": this.t("分类", "Category") } }, [{ value: "", label: this.t("未分类", "Uncategorized") }, ...names.map(name => ({ value: name, label: name }))], record.categoryName, this.app).element;
    category.onchange = () => void this.update(record, { categoryName: category.value });
    const peopleRow = row("user", this.t("相关人员", "People"));
    const people = peopleRow.createEl("input", { cls: "todo-field", attr: { type: "text", placeholder: this.t("相关人员", "People"), "aria-label": this.t("相关人员", "People") } }); people.value = record.people;
    people.onchange = () => void this.update(record, { people: joinPeopleNames(parsePeopleNames(people.value)) });
    const subtasks = todoSubtasks(record);
    const subSection = panel.createDiv({ cls: "todo-detail-section" });
    const subHead = subSection.createEl("h3", { text: this.t("子任务", "Subtasks") });
    if (subtasks.length) subHead.createSpan({ cls: "todo-count", text: ` ${subtasks.filter(task => task.done).length}/${subtasks.length}` });
    for (const task of subtasks) this.subtask(subSection, record, task);
    const add = subSection.createEl("input", { cls: "todo-subtask-add", attr: { type: "text", placeholder: this.t("添加子任务", "Add subtask"), "aria-label": this.t("添加子任务", "Add subtask") } });
    add.onkeydown = event => {
      if (event.key !== "Enter" || event.isComposing || !add.value.trim()) return;
      const text = add.value.trim(); add.value = "";
      void this.plugin.getTodoStore().updateSubtasks(record, { add: text }).catch(error => new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)));
    };
    if (record.diaryJournalPath) {
      const source = panel.createDiv({ cls: "todo-detail-section" });
      source.createEl("h3", { text: this.t("来源", "Source") });
      const link = source.createEl("button", { cls: "todo-detail-link", attr: { type: "button" } });
      setIcon(link.createSpan({ attr: { "aria-hidden": "true" } }), "notebook-pen"); link.createSpan({ text: record.diaryJournalPath });
      link.onclick = () => void this.app.workspace.openLinkText(record.diaryJournalPath!, this.plugin.getTodoStore().sourcePath);
    }
    const foot = panel.createDiv({ cls: "todo-detail-foot" });
    const remove = this.button(foot, this.t("删除", "Delete"), () => this.remove(record), "is-danger");
    applyDeleteButton(remove);
  }

  /* ---------- 写入 ---------- */
  private async update(record: ParsedTodoRecord, patch: Parameters<ReturnType<CodexForObsidianPlugin["getTodoStore"]>["updateTodo"]>[1]): Promise<void> {
    const key = keyOf(record);
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try { await this.plugin.getTodoStore().updateTodo(record, patch); }
    catch (error) { new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)); if (this.active()) this.renderData(); }
    finally { this.busy.delete(key); }
  }
  private async toggle(record: ParsedTodoRecord, done: boolean, check: HTMLButtonElement): Promise<void> {
    if (check.disabled) return;
    check.disabled = true;
    if (done) { check.addClass("is-checked"); check.closest(".todo-row")?.addClass("is-completing"); }
    try { await this.plugin.getTodoStore().toggleDone(record, done); }
    catch (error) { if (this.active()) this.renderData(); new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)); }
    finally { if (check.isConnected) check.disabled = false; }
  }
  private async remove(record: ParsedTodoRecord): Promise<void> {
    const accepted = await confirmModal(this.app, this.t("删除待办", "Delete to-do"),
      this.t(`确定删除「${record.title}」吗？删除后无法恢复。`, `Delete "${record.title}"? This cannot be undone.`), this.t("删除", "Delete"), this.t("取消", "Cancel"), { deleteAction: true });
    if (!accepted) return;
    try { await this.plugin.getTodoStore().removeTodo(record); if (this.state.selected === keyOf(record)) this.state.selected = null; }
    catch (error) { new Notice(failureText(error, TODO_SAVE_FAILED, NEXT.retryLater, this.plugin.settings.settingsLanguage)); }
  }
}

const TODO_SAVE_FAILED: ErrorCopy = ["待办未能保存。", "The to-do could not be saved."];
