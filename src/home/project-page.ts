import { ItemView, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { dispatchForPlanTask, projectCounts, projectMilestones } from "../company/logic";
import type { CompanyService } from "../company/service";
import type { CompanyDocument, CompanyProject } from "../company/types";
import { companyApprovals, companyDecisions, CompanyInteractionController } from "../company/interaction-bridge";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { agentLookup, agentName, fileLabel, formatClock, latestDispatchOf, projectAcceptance, projectOutputs, renderAvatar, renderDispatchStatus, renderStatus, type AgentLookup } from "./project-parts";
import { renderMilestoneTab, renderOutputTab, renderRecordTab, renderTaskTab, type ProjectTabContext } from "./project-page-tabs";

export const PROJECT_PAGE_VIEW_TYPE = "echoink-project-page";
type ProjectTab = "record" | "task" | "milestone" | "output";
interface ProjectPageState { projectId?: string }

/** Read-only project page. The only action is answering 等你定; changes go through the router card. */
export class ProjectPageView extends ItemView {
  private projectId = "";
  private tab: ProjectTab = "record";
  private expanded: string | null = null;
  private service: CompanyService | null = null;
  private unsubscribe: (() => void) | null = null;
  private resize: ResizeObserver | null = null;
  private signature = "";
  private opened = false;
  private unsubscribeRuns?: () => void;
  private readonly interactions: CompanyInteractionController;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) { super(leaf); this.interactions = new CompanyInteractionController(plugin); }
  getViewType(): string { return PROJECT_PAGE_VIEW_TYPE; }
  getDisplayText(): string { return this.project()?.name ?? "项目"; }
  getIcon(): string { return "briefcase"; }
  getState(): Record<string, unknown> { return this.projectId ? { projectId: this.projectId } : {}; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const id = (state as ProjectPageState | null)?.projectId;
    const next = typeof id === "string" ? id : "";
    if (next !== this.projectId) { this.projectId = next; this.tab = "record"; this.expanded = null; this.contentEl.scrollTop = 0; }
    await super.setState(state, result);
    if (this.opened) this.render(true);
  }

  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.addClass("echoink-project-page");
    this.registerDomEvent(this.contentEl, "scroll", () => this.syncStuck());
    const win = this.contentEl.ownerDocument.defaultView;
    if (win) { this.resize = new win.ResizeObserver(() => this.syncPanelHeight()); this.resize.observe(this.contentEl); }
    // The company service may appear after layout restore; pick it up when the workspace moves.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.ensureSubscription()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.ensureSubscription()));
    this.ensureSubscription();
    this.unsubscribeRuns = this.plugin.getConversationRunService().subscribe({ refresh: () => this.render(), clearAcceptedDraft() {}, isTaskVisible: () => false });
    if (!this.signature) this.render(true);
  }
  async onClose(): Promise<void> {
    this.opened = false; this.signature = "";
    this.unsubscribe?.(); this.unsubscribe = null; this.service = null;
    this.unsubscribeRuns?.(); this.unsubscribeRuns = undefined;
    this.interactions.dispose();
    this.resize?.disconnect(); this.resize = null;
    disposeOriginControls(this.contentEl); this.contentEl.empty(); this.contentEl.removeClass("echoink-project-page");
  }
  private ensureSubscription(): void {
    const service = this.plugin.companyService;
    if (service === this.service) return;
    this.unsubscribe?.(); this.unsubscribe = null; this.service = service;
    if (service) this.unsubscribe = service.subscribe(() => this.render());
    this.render(true);
  }
  private project(): CompanyProject | undefined { return this.projectId ? this.plugin.companyService?.projectOf(this.projectId) : undefined; }
  private agents(): AgentLookup { return agentLookup(this.plugin.settings.agentRegistry.agents); }

  private render(force = false): void {
    if (!this.opened) return;
    const service = this.plugin.companyService, project = this.project(), source = service?.doc;
    const approvals = source && project ? companyApprovals(this.plugin, source, { projectId: project.id }) : [];
    const approvalIds = new Set(approvals.map(item => item.dispatch.id));
    const doc = source ? { ...source, dispatches: source.dispatches.map(d => approvalIds.has(d.id) ? { ...d, status: "waiting" as const } : d) } : undefined;
    const signature = JSON.stringify([this.tab, this.expanded, project, approvals.map(a => a.key), doc && project ? [doc.dispatches.filter(d => d.projectId === project.id), doc.events.filter(e => e.projectId === project.id)] : null]);
    if (!force && signature === this.signature) return;
    this.signature = signature;
    const root = this.contentEl, scroll = root.scrollTop;
    const focusKey = (root.ownerDocument.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-pp-focus]")?.dataset.ppFocus;
    disposeOriginControls(root); root.empty();
    const page = root.createDiv({ cls: "echoink-project-content" });
    if (!service || !doc || !project) {
      page.createEl("h1", { text: "项目" });
      page.createDiv({ cls: "echoink-project-empty", text: !service ? "项目功能还没准备好，稍后再打开。" : "找不到这个项目，可能已被删除。" });
      return;
    }
    const ctx: ProjectTabContext = { app: this.app, doc, project, agent: this.agents(), expanded: this.expanded,
      openTask: id => this.openTask(id), openRouter: () => this.openTask(project.routerConversationId), toggleAgent: id => this.toggleAgent(id) };
    this.renderHeader(page, project);
    if (project.status === "done") this.renderBanner(page, doc, project, ctx.agent);
    this.renderMembers(page, doc, project, ctx.agent);
    this.renderOverview(page, doc, project);
    this.renderDecisions(page, service, project);
    this.renderTabs(page, doc, project, ctx);
    root.scrollTop = scroll;
    this.syncPanelHeight(); this.syncStuck();
    if (focusKey) root.querySelector<HTMLElement>(`[data-pp-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
  /** Not named open(): that is Obsidian's View lifecycle method and would swallow page opening. */
  private openTask(taskId: string): void { void this.plugin.openTaskDetail(taskId).catch(error => new Notice(message(error))); }

  private button(parent: HTMLElement, text: string, key: string, action: () => unknown, variant: "primary" | "secondary" = "secondary", icon?: string): HTMLButtonElement {
    const button = createOriginButton(parent, { cls: `echoink-project-button is-${variant}`, text, attr: { "data-pp-focus": key } });
    applyAmicroButton(button, { variant });
    if (icon) { const node = button.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }); setIcon(node, icon); button.prepend(node); }
    button.onclick = () => { void Promise.resolve().then(action).catch(error => new Notice(message(error))); };
    return button;
  }
  private section(parent: HTMLElement, title: string, count?: string, cls = ""): HTMLElement {
    const section = parent.createEl("section", { cls: `echoink-project-section ${cls}`.trim() });
    const head = section.createDiv({ cls: "echoink-project-section-head" });
    head.createEl("h2", { text: title });
    if (count) head.createSpan({ cls: "echoink-project-count", text: count });
    return section;
  }

  private renderHeader(page: HTMLElement, project: CompanyProject): void {
    const header = page.createDiv({ cls: "echoink-project-header" });
    const title = header.createDiv({ cls: "echoink-project-title" });
    title.createEl("h1", { text: project.name });
    if (project.folder) title.createDiv({ cls: "echoink-project-folder", text: `${project.folder}/` });
    this.button(header, "项目对话", "router", () => this.plugin.openTaskDetail(project.routerConversationId), "secondary", "message-circle");
  }
  private renderBanner(page: HTMLElement, doc: CompanyDocument, project: CompanyProject, agent: AgentLookup): void {
    const results = projectAcceptance(project), passed = results.filter(r => r.passed).length;
    const achieved = results.length > 0 && passed === results.length;
    const banner = page.createEl("section", { cls: "echoink-project-banner" });
    const head = banner.createDiv({ cls: "echoink-project-who" });
    setIcon(head.createSpan({ cls: "echoink-project-banner-icon", attr: { "aria-hidden": "true" } }), achieved ? "badge-check" : "circle-alert");
    head.createSpan({ cls: "echoink-project-card-title", text: achieved ? "目标已达成" : "已结项，验收未全部通过" });
    const total = project.criteria.length || results.length;
    head.createSpan({ cls: "echoink-project-status", text: `验收标准 ${results.filter(r => r.passed).length}/${total} 通过${project.endedAt ? ` · ${formatClock(project.endedAt)} 结项` : ""}` });
    if (results.length) {
      const rows = banner.createDiv({ cls: "echoink-project-rows" });
      for (const result of results) {
        const row = rows.createDiv({ cls: "echoink-project-row" });
        setIcon(row.createSpan({ cls: `echoink-project-lead${result.passed ? "" : " is-wait"}`, attr: { "aria-hidden": "true" } }), result.passed ? "check" : "x");
        const text = row.createDiv({ cls: "echoink-project-grow" });
        text.createDiv({ text: result.criterion });
        if (result.evidence) text.createDiv({ cls: "echoink-project-sub", text: result.evidence });
        if (result.agentId) renderAvatar(row, agent(result.agentId), true);
        row.createSpan({ cls: `echoink-project-status${result.passed ? "" : " is-wait"}`, text: result.passed ? "验收通过" : "未通过" });
      }
    }
    const deliverables = projectOutputs(doc, project).deliverables;
    if (deliverables.length) banner.createDiv({ cls: "echoink-project-kv", text: `交付物：${deliverables.map(o => fileLabel(o.path)).join("、")}` });
  }
  private renderMembers(page: HTMLElement, doc: CompanyDocument, project: CompanyProject, agent: AgentLookup): void {
    const ids = [GENERAL_ASSISTANT_ID, ...new Set(project.plan.map(t => t.agentId).filter(id => id !== GENERAL_ASSISTANT_ID))];
    const section = this.section(page, "项目成员", `${ids.length} 人`);
    const grid = section.createDiv({ cls: "echoink-project-members" });
    for (const id of ids) {
      const card = grid.createDiv({ cls: "echoink-project-member" });
      renderAvatar(card, agent(id));
      const text = card.createDiv({ cls: "echoink-project-grow" });
      text.createDiv({ cls: "echoink-project-ellip" }).createEl("b", { text: agentName(agent, id) });
      text.createDiv({ cls: "echoink-project-sub echoink-project-ellip", text: project.roles[id] || project.plan.filter(t => t.agentId === id).map(t => t.label).join("、") });
      if (id === GENERAL_ASSISTANT_ID) renderStatus(card, project.status === "done" ? "check" : "radio", project.status === "done" ? "已结项" : "在协调");
      else renderDispatchStatus(card, latestDispatchOf(doc, project.id, id)?.status);
    }
  }
  private renderOverview(page: HTMLElement, doc: CompanyDocument, project: CompanyProject): void {
    const section = this.section(page, "概况");
    const list = section.createEl("dl", { cls: "echoink-project-brief" });
    const item = (term: string, cls = "") => { list.createEl("dt", { text: term }); return list.createEl("dd", { cls }); };
    if (project.background) item("背景").setText(project.background);
    item("目标", "is-goal").setText(project.goal);
    const passed = projectAcceptance(project).map(result => result.passed);
    const criteria = item("验收标准");
    const checks = criteria.createEl("ul", { cls: "echoink-project-checks" });
    project.criteria.forEach((criterion, i) => {
      const li = checks.createEl("li", { cls: passed[i] ? "is-ok" : "" });
      setIcon(li.createSpan({ cls: "echoink-project-check-icon", attr: { "aria-hidden": "true" } }), passed[i] ? "check" : "circle");
      li.createSpan({ text: criterion });
    });
    criteria.createSpan({ cls: "echoink-project-count", text: `${passed.filter(Boolean).length}/${project.criteria.length} 通过` });
    const due = project.dueLabel ? `计划 ${project.dueLabel}` : "";
    const time = [project.startedAt ? `${formatClock(project.startedAt)} 开始` : "还没开工",
      project.endedAt ? `${formatClock(project.endedAt)} 结束${due ? `（${due}）` : ""}` : due ? `${due} 结束` : ""].filter(Boolean).join(" · ");
    item("时间").setText(time);

    const counts = projectCounts(doc, project), milestones = projectMilestones(doc, project);
    const scope = { projectId: project.id };
    const waitingCount = new Set([...companyApprovals(this.plugin, doc, scope).map(item => item.dispatch.id),
      ...companyDecisions(this.plugin, doc, scope).map(dispatch => dispatch.id)]).size;
    const tiles = section.createDiv({ cls: "echoink-project-tiles" });
    const tile = (label: string, done: number, total: number | string, go?: ProjectTab) => {
      const node = tiles.createEl(go ? "button" : "div", { cls: `echoink-project-tile${go ? " is-go" : ""}`, attr: go ? { type: "button", "data-pp-focus": `tile-${go}` } : {} });
      if (go) node.onclick = () => this.goto(go);
      const head = node.createSpan({ cls: "echoink-project-tile-head" });
      head.createSpan({ text: label });
      if (go) setIcon(head.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "chevron-right");
      const number = node.createSpan({ cls: "echoink-project-tile-number" });
      number.createEl("b", { text: String(done) });
      if (total !== "") number.createSpan({ text: `/ ${total}` });
      return node;
    };
    const segments = (parent: HTMLElement, states: readonly string[]) => {
      const bar = parent.createSpan({ cls: "echoink-project-segs", attr: { "aria-hidden": "true" } });
      for (const state of states) bar.createEl("i", { cls: state ? `is-${state}` : "" });
    };
    const caption = (parent: HTMLElement) => parent.createSpan({ cls: "echoink-project-tile-caption echoink-project-ellip" });

    const ms = tile("里程碑", counts.milestonesDone, counts.milestonesTotal, "milestone");
    segments(ms, milestones.map(m => m.state === "done" ? "done" : m.state === "waiting" ? "wait" : m.state === "current" ? "run" : ""));
    const msCap = caption(ms);
    if (!counts.current) msCap.setText(project.endedAt ? `全部完成 · ${formatClock(project.endedAt)}` : "全部完成");
    else { msCap.appendText("当前："); msCap.createEl("b", { text: counts.current.title }); if (counts.current.state === "waiting") msCap.appendText(" · 等你定"); }

    const tasks = tile("任务", counts.tasksDone, counts.tasksTotal, "task");
    const taskStates = project.plan.map(t => dispatchForPlanTask(doc, project.id, t.id)?.status);
    segments(tasks, taskStates.map(s => s === "done" ? "done" : s === "running" ? "run" : s === "waiting" || s === "failed" ? "wait" : ""));
    const failed = taskStates.filter(s => s === "failed").length;
    const now = counts.tasksTotal && counts.tasksDone === counts.tasksTotal ? "全部已完成"
      : [counts.tasksRunning ? `${counts.tasksRunning} 进行中` : "", waitingCount ? `${waitingCount} 等你定` : "", failed ? `${failed} 没做成` : ""].filter(Boolean).join(" · ") || "排队中";
    caption(tasks).setText(now + (counts.reworks ? ` · 返工 ${counts.reworks} 次` : ""));

    const turns = tile("对话轮次", counts.turns, "");
    caption(turns).setText("按员工对话轮次统计");
  }
  private renderDecisions(page: HTMLElement, service: CompanyService, project: CompanyProject): void {
    const scope = { projectId: project.id };
    const count = companyDecisions(this.plugin, service.doc, scope).length + companyApprovals(this.plugin, service.doc, scope).length;
    if (!count) { this.interactions.dispose(); return; }
    const section = this.section(page, "等你定", String(count));
    this.interactions.render(section.createDiv({ cls: "echoink-company-interactions" }), scope, () => this.render(true));
  }
  private renderTabs(page: HTMLElement, doc: CompanyDocument, project: CompanyProject, ctx: ProjectTabContext): void {
    const counts = projectCounts(doc, project), outputs = projectOutputs(doc, project);
    page.createDiv({ cls: "echoink-project-tabs-anchor" });
    const bar = page.createDiv({ cls: "echoink-project-tabs", attr: { role: "tablist", "aria-label": "项目内容" } });
    bar.createSpan({ cls: "echoink-project-stuck-title echoink-project-ellip", text: project.name });
    const tabs: [ProjectTab, string, string][] = [["record", "记录", ""], ["task", "任务", `${counts.tasksDone}/${counts.tasksTotal}`],
      ["milestone", "里程碑", `${counts.milestonesDone}/${counts.milestonesTotal}`], ["output", "产出", String(outputs.deliverables.length + outputs.process.length)]];
    for (const [id, label, count] of tabs) {
      const button = bar.createEl("button", { cls: `echoink-project-tab${id === this.tab ? " is-selected" : ""}`,
        attr: { type: "button", role: "tab", "aria-selected": String(id === this.tab), "data-pp-focus": `tab-${id}` } });
      button.createSpan({ text: label });
      if (count) button.createSpan({ cls: "echoink-project-count", text: count });
      button.onclick = () => this.switchTab(id);
    }
    const panel = page.createDiv({ cls: "echoink-project-panel", attr: { role: "tabpanel" } });
    ({ record: renderRecordTab, task: renderTaskTab, milestone: renderMilestoneTab, output: renderOutputTab })[this.tab](panel, ctx);
  }

  private anchor(): HTMLElement | null { return this.contentEl.querySelector<HTMLElement>(".echoink-project-tabs-anchor"); }
  private isStuck(): boolean {
    const anchor = this.anchor();
    return !!anchor && anchor.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top <= 1;
  }
  private syncStuck(): void { this.contentEl.querySelector(".echoink-project-tabs")?.classList.toggle("is-stuck", this.isStuck()); }
  private scrollToTabs(): void {
    const anchor = this.anchor(); if (!anchor) return;
    this.contentEl.scrollTop += anchor.getBoundingClientRect().top - this.contentEl.getBoundingClientRect().top;
    // Once stuck, measure where the bar really sits (the view adds its own top padding) and leave the Demo's 16px below it.
    const tabs = this.contentEl.querySelector<HTMLElement>(".echoink-project-tabs");
    const first = this.contentEl.querySelector<HTMLElement>(".echoink-project-panel")?.firstElementChild;
    if (tabs && first) this.contentEl.scrollTop += first.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom - 16;
    this.syncStuck();
  }
  private switchTab(tab: ProjectTab): void {
    const stuck = this.isStuck(); this.tab = tab; this.render();
    // While stuck, a new tab starts at its own top instead of the old scroll offset.
    if (stuck) this.scrollToTabs();
  }
  private goto(tab: ProjectTab): void { this.tab = tab; this.render(); this.scrollToTabs(); }
  private toggleAgent(agentId: string): void { this.expanded = this.expanded === agentId ? null : agentId; this.render(); }
  /** One pane-height of panel keeps short tabs stuck after switching. */
  private syncPanelHeight(): void {
    const tabs = this.contentEl.querySelector<HTMLElement>(".echoink-project-tabs");
    const height = Math.max(0, this.contentEl.clientHeight - (tabs?.offsetHeight ?? 0));
    this.contentEl.setCssProps({ "--echoink-project-panel-min": `${height}px` });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
