import { todoPageRecords } from "./todo-page-model";
export { todoPageRecords } from "./todo-page-model";
import { ItemView, Notice, TFolder, type TAbstractFile, type EventRef, type WorkspaceLeaf, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createOriginButton, createOriginPagination, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { ForegroundView } from "../ui/foreground-view";
import { confirmModal } from "../ui/modals";
import { EchoInkTodoFormModal } from "./todo-edit-modal";
import type { ParsedTodoRecord } from "./todo-markdown";
import { getTodoProjects, resolveTodoProject, type TodoProject } from "./todo-projects";
import { prefillWorkbenchModule, workbenchModuleOwner } from "./module-navigation";
import { renderTodoTable, todoTableCopy } from "./todo-table";

export const TODO_PAGE_VIEW_TYPE = "echoink-todo-page";
type TodoStatus = "all" | "open" | "done";
interface TodoPageState {
  status: TodoStatus;
  category: string | null;
  project: string | null;
  page: number;
  scrollTop: number;
  scrollLeft: number;
  pageScroll: number;
}
const savedStates = new WeakMap<CodexForObsidianPlugin, TodoPageState>();
/** Local data page. Only the explicit handoff action opens an Agent draft. */
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

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {
    super(leaf);
    this.state = savedStates.get(plugin) ?? { status: "all", category: null, project: null, page: 1, scrollTop: 0, scrollLeft: 0, pageScroll: 0 };
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
    this.contentEl.scrollTop = this.state.pageScroll;
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
      // Only an observed folder rename establishes identity. Preserve the
      // selected project through both project and bound-root renames before
      // refreshing projects or awaiting the store's Markdown rewrite.
      if (file instanceof TFolder && this.state.project?.startsWith("path:")) {
        const selectedPath = this.state.project.slice(5);
        if (selectedPath === oldPath || selectedPath.startsWith(`${oldPath}/`)) {
          this.state.project = `path:${file.path}${selectedPath.slice(oldPath.length)}`;
        }
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
  refreshIfSettingsChanged(): void {
    if (this.active() && this.settingsSignature !== this.signature()) this.refreshLanguage();
  }
  refreshLanguage(): void { if (this.active()) this.renderData(); }
  async refresh(): Promise<void> {
    if (!this.active()) return;
    const generation = ++this.generation;
    const status = this.field("status");
    if (!this.initialized) status.setText(this.t("正在读取待办…", "Reading to-dos…"));
    try {
      const store = this.plugin.getTodoStore();
      await store.initialize();
      // Reopening an initialized store must verify the source, rather than
      // treating its last cached snapshot as a successful read.
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
    status.createSpan({ text: this.t("待办暂时读不到", "To-dos are unavailable") + `：${error instanceof Error ? error.message : String(error)}`
      + (this.initialized ? this.t(" · 尚未更新", " · Not updated") : "") });
    this.button(status, this.t("重试", "Retry"), () => this.refresh());
  }
  private renderShell(): void {
    disposeOriginControls(this.contentEl); this.contentEl.empty();
    const content = this.contentEl.createDiv({ cls: "echoink-todo-page-content" });
    content.createDiv({ cls: "todo-page-header", attr: { "data-todo-page": "header" } });
    content.createDiv({ cls: "todo-page-status", attr: { "data-todo-page": "status", role: "status", "aria-live": "polite" } });
    const data = content.createDiv({ attr: { "data-todo-page": "data" } }); data.hidden = true;
    data.createDiv({ cls: "todo-page-toolbar", attr: { "data-todo-page": "toolbar" } });
    data.createDiv({ cls: "todo-page-count", attr: { "data-todo-page": "count", role: "status", "aria-live": "polite" } });
    data.createDiv({ cls: "todo-page-list", attr: { "data-todo-page": "list" } });
    data.createDiv({ cls: "todo-page-pagination", attr: { "data-todo-page": "pagination" } });
    this.renderHeader();
  }
  private button(parent: HTMLElement, text: string, action: () => unknown, cls = ""): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `todo-page-button ${cls}` });
    button.onclick = async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result && typeof (result as Promise<unknown>).then === "function") {
          applyAmicroButton(button, { variant: cls.includes("is-primary") ? "primary" : "secondary" });
          button.disabled = true; setAmicroButtonPending(button, true);
          try { await result; } finally { button.disabled = false; setAmicroButtonPending(button, false); }
        }
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    };
    return button;
  }
  private renderHeader(): void {
    const header = this.field("header");
    if (!header.firstChild) {
      const title = header.createDiv({ cls: "todo-page-title" });
      const back = this.button(title, "", () => this.plugin.activateHomeView({ keepRightSidebar: true }), "is-icon");
      back.dataset.todoPage = "back"; setIcon(back, "arrow-left");
      title.createEl("h1");
      this.button(header, "", () => this.handoff(), "is-primary").dataset.todoPage = "owner";
    }
    header.querySelector("h1")!.setText(this.t("待办", "To-dos"));
    this.field("back").setAttribute("aria-label", this.t("返回工作台", "Back to workbench"));
    const owner = workbenchModuleOwner(this.plugin, "todos").name;
    this.field("owner").setText(this.t(`交给 ${owner} 排一排`, `Plan with ${owner}`));
  }
  private async handoff(): Promise<void> {
    this.renderHeader();
    const scope: string[] = [];
    if (this.state.project !== null) {
      const project = this.projects.find(project => `path:${project.path}` === this.state.project);
      scope.push(this.t(`项目：${this.state.project === "none" ? "不属于项目" : project?.label ?? this.state.project.slice(4)}`,
        `Project: ${this.state.project === "none" ? "No project" : project?.label ?? this.state.project.slice(4)}`));
    }
    if (this.state.category !== null) scope.push(this.t(`分类：${this.state.category || "未分类"}`, `Category: ${this.state.category || "Uncategorized"}`));
    const prompt = this.t("帮我把今天和本周的待办排个顺序", "Help me prioritize my to-dos for today and this week");
    await prefillWorkbenchModule(this.plugin, "todos", scope.length ? `${prompt}（${scope.join("；")}）` : prompt);
  }
  private renderData(): void {
    if (!this.initialized || !this.active()) return;
    try {
      const projects = getTodoProjects(this.plugin);
      if (this.state.project?.startsWith("path:") && !projects.some(project => `path:${project.path}` === this.state.project)) {
        const previous = this.projects.find(project => `path:${project.path}` === this.state.project);
        if (previous) this.state.project = `raw:${previous.value}`;
      }
      this.projects = projects;
      this.settingsSignature = this.signature();
      this.renderHeader(); this.renderToolbar(); this.renderList();
    } catch (error) { this.showError(error); }
  }
  private changeFilter(update: Partial<Pick<TodoPageState, "status" | "category" | "project">>): void {
    Object.assign(this.state, update, { page: 1, scrollTop: 0, scrollLeft: 0 });
    this.renderToolbar(); this.renderList();
  }
  private renderToolbar(): void {
    const toolbar = this.field("toolbar"); disposeOriginControls(toolbar); toolbar.empty();
    const segments = toolbar.createDiv({ cls: "todo-page-segments", attr: { role: "tablist", "aria-label": this.t("待办状态", "To-do status") } });
    const statuses = ["all", "open", "done"] as const;
    for (const status of statuses) {
      const text = { all: this.t("全部", "All"), open: this.t("未完成", "Open"), done: this.t("已完成", "Done") }[status];
      const button = this.button(segments, text, () => this.changeFilter({ status }));
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(status === this.state.status));
      button.classList.toggle("is-selected", status === this.state.status); button.tabIndex = status === this.state.status ? 0 : -1;
    }
    segments.onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = statuses.indexOf(this.state.status);
      const status = statuses[event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowLeft" ? 2 : 1)) % 3];
      this.changeFilter({ status }); this.field("toolbar").querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    };
    const field = (label: string) => {
      const group = toolbar.createDiv({ cls: "todo-page-filter" });
      group.createSpan({ text: label, attr: { "aria-hidden": "true" } });
      return group;
    };
    const records = this.plugin.getTodoStore().snapshot();
    const categories = [...new Set([...this.plugin.settings.todoCategories.map(category => category.name), ...records.map(record => record.categoryName).filter(Boolean), ...(this.state.category ? [this.state.category] : [])])];
    const categoryLabel = this.t("分类", "Category");
    const category = createOriginSelect(field(categoryLabel), { attr: { "aria-label": categoryLabel } }, [
      { value: "all", label: this.t("全部分类", "All categories") }, { value: "none", label: this.t("未分类", "Uncategorized") },
      ...categories.map(name => ({ value: `category:${name}`, label: name }))
    ], this.state.category === null ? "all" : this.state.category === "" ? "none" : `category:${this.state.category}`, this.app).element;
    category.onchange = () => this.changeFilter({ category: category.value === "all" ? null : category.value === "none" ? "" : category.value.slice(9) });
    const choices = new Map(this.projects.map(project => [`path:${project.path}`, project.label]));
    for (const record of records) {
      const resolved = resolveTodoProject(record.project, this.projects);
      if (resolved.status !== "missing" && resolved.status !== "ambiguous") continue;
      choices.set(`raw:${record.project}`, `${record.project} · ${resolved.status === "missing" ? this.t("项目已不存在", "Project no longer exists") : this.t("有同名项目，请重新选择", "Duplicate project names; select again")}`);
    }
    if (this.state.project && this.state.project !== "none" && !choices.has(this.state.project)) choices.set(this.state.project, this.state.project.slice(this.state.project.indexOf(":") + 1));
    const projectLabel = this.t("项目", "Project");
    const project = createOriginSelect(field(projectLabel), { attr: { "aria-label": projectLabel } }, [
      { value: "all", label: this.t("全部项目", "All projects") }, { value: "none", label: this.t("不属于项目", "No project") },
      ...Array.from(choices, ([value, label]) => ({ value, label }))
    ], this.state.project ?? "all", this.app).element;
    project.onchange = () => this.changeFilter({ project: project.value === "all" ? null : project.value });
    this.button(toolbar, this.t("新增待办", "New to-do"), () => new EchoInkTodoFormModal(this.app, this.plugin, null).open(), "todo-page-add");
  }
  private rememberScroll(): void {
    const list = this.contentEl.querySelector<HTMLElement>(".echoink-todo-table-wrap");
    if (list) { this.state.scrollTop = list.scrollTop; this.state.scrollLeft = list.scrollLeft; }
    this.state.pageScroll = this.contentEl.scrollTop;
  }
  private renderList(): void {
    const host = this.field("list"), pagination = this.field("pagination");
    // Data refreshes preserve position; explicit filters/pages have reset state.
    const scrollTop = this.state.scrollTop, scrollLeft = this.state.scrollLeft;
    disposeOriginControls(host); disposeOriginControls(pagination); pagination.empty();
    const all = this.plugin.getTodoStore().snapshot();
    const result = todoPageRecords(all, this.projects, this.state); this.state.page = result.page;
    const copy = todoTableCopy(this.plugin.settings.settingsLanguage);
    if (all.length && !result.total) copy.empty = this.t("没有符合条件的待办", "No matching to-dos");
    renderTodoTable(host, result.records, copy, {
      onToggle: (record, done) => { void this.toggle(record, done); },
      onEdit: record => new EchoInkTodoFormModal(this.app, this.plugin, record).open(),
      onDelete: record => { void this.remove(record).catch(error => new Notice(error instanceof Error ? error.message : String(error))); }
    }, this.projects);
    const wrap = host.querySelector<HTMLElement>(".echoink-todo-table-wrap")!;
    wrap.tabIndex = 0; wrap.setAttribute("aria-label", this.t("待办表格", "To-do table"));
    wrap.scrollTop = scrollTop; wrap.scrollLeft = scrollLeft;
    wrap.onscroll = () => { this.state.scrollTop = wrap.scrollTop; this.state.scrollLeft = wrap.scrollLeft; };
    const count = this.field("count"); disposeOriginControls(count); count.empty();
    const values = count.createDiv({ cls: "todo-page-count-values" });
    values.createSpan({ text: this.t(`符合条件 ${result.total} 项 · 全部 ${all.length} 项`, `${result.total} matching · ${all.length} total`) });
    const stats = this.plugin.getTodoStore().completionStatistics();
    values.createSpan({ cls: "todo-history-summary", text: this.t(`累计完成 ${stats.total} · 今日完成 ${stats.today}`, `Total completed: ${stats.total} · Today: ${stats.today}`) });
    if (this.state.status !== "all" || this.state.category !== null || this.state.project !== null) this.button(count, this.t("清除筛选", "Clear filters"), () => this.changeFilter({ status: "all", category: null, project: null }), "is-tertiary");
    createOriginPagination(pagination, result.page, result.pages, page => {
      this.state.page = page; this.state.scrollTop = 0; this.renderList();
    });
  }
  private async toggle(record: ParsedTodoRecord, done: boolean): Promise<void> {
    const row = Array.from(this.field("list").querySelectorAll<HTMLTableRowElement>("tbody tr")).find(row => row.dataset.todoId === record.id);
    const checkbox = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox?.disabled) return;
    if (checkbox) checkbox.disabled = true;
    try { await this.plugin.getTodoStore().toggleDone(record, done); }
    catch (error) { if (this.active()) this.renderList(); new Notice(error instanceof Error ? error.message : String(error)); }
    finally { if (checkbox?.isConnected) checkbox.disabled = false; }
  }
  private async remove(record: ParsedTodoRecord): Promise<void> {
    const accepted = await confirmModal(this.app, this.t("删除待办", "Delete to-do"),
      this.t(`确定删除「${record.title}」吗？删除后无法恢复。`, `Delete "${record.title}"? This cannot be undone.`), this.t("删除", "Delete"), this.t("取消", "Cancel"));
    if (accepted) await this.plugin.getTodoStore().removeTodo(record);
  }
}
