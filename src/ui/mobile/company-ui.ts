import { setIcon } from "obsidian";
import { dispatchForPlanTask, pendingDecisions, projectCounts, projectMilestones, projectEstimatedTurns } from "../../company/logic";
import type { CompanyService } from "../../company/service";
import type { CompanyDispatch, CompanyProject, CompanyOwnerRequest } from "../../company/types";
import type { AgentDefinition } from "../../agents/types";
import type { EchoInkQuestionAnswer } from "../../types/conversation-turn";
import type { MobileResumeSnapshot } from "../../mobile/task-contracts";
import type { MobileRuntime } from "../../mobile/runtime";
import type { MobileSession, MobileStore } from "../../mobile/store";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { shellElement as el } from "./shell-controls";

/** Everything a phone or iPad page needs from the company layer; each device renders the same pieces. */
export interface MobileCompanyContext {
  readonly document: Document;
  readonly service: CompanyService;
  readonly store: MobileStore;
  readonly runtime: MobileRuntime;
  readonly agents: () => readonly AgentDefinition[];
  readonly error: (error: unknown) => void;
  readonly openTask: (taskId: string) => void;
  readonly openProject: (projectId: string) => void;
  readonly openWorkbench: () => void;
  readonly openNote?: (path: string) => void;
  readonly assignOwner?: (request: CompanyOwnerRequest) => void;
  readonly renderQuestion?: (taskId: string) => { element: HTMLElement; dispose(): void };
}

export type MobileCompanyDecision =
  | { readonly key: string; readonly kind: "owner"; readonly request: CompanyOwnerRequest }
  | { readonly key: string; readonly kind: "resume"; readonly dispatch: CompanyDispatch; readonly snapshot: MobileResumeSnapshot }
  | { readonly key: string; readonly kind: "question"; readonly dispatch: CompanyDispatch; readonly prompt: string; readonly options: readonly string[] }
  | { readonly key: string; readonly kind: "interaction"; readonly dispatch: CompanyDispatch; readonly task: MobileSession; readonly prompt: string;
    readonly options: readonly { id: string; label: string }[]; readonly approval: boolean };

/** Questions from need_decision reports, plus questions a worker task is waiting on: one list, one style. */
export function mobileCompanyDecisions(service: CompanyService, store: MobileStore, scope: Readonly<{ projectId?: string; routerId?: string }> = {}, runtime?: MobileRuntime): MobileCompanyDecision[] {
  const inScope = (d: CompanyDispatch) => (!scope.projectId || d.projectId === scope.projectId) && (!scope.routerId || d.routerConversationId === scope.routerId);
  const items: MobileCompanyDecision[] = pendingDecisions(service.doc).filter(inScope).map(dispatch => ({ key: `q:${dispatch.id}:${dispatch.report!.at}`, kind: "question",
    dispatch, prompt: dispatch.report!.question || dispatch.report!.summary || dispatch.brief, options: dispatch.report!.options ?? [] }));
  for (const request of service.doc.ownerRequests ?? []) if ((!scope.routerId || request.routerConversationId === scope.routerId) && (!scope.projectId || request.projectId === scope.projectId)) items.push({ key: `owner:${request.id}`, kind: "owner", request });
  for (const dispatch of service.doc.dispatches.filter(d => (d.status === "running" || d.status === "waiting") && inScope(d))) {
    const snapshot = runtime?.stateFor?.(dispatch.id).resumeReview;
    if (snapshot) { items.push({ key: `resume:${dispatch.id}:${snapshot.fingerprint}`, kind: "resume", dispatch, snapshot }); continue; }
    if (runtime?.isCompanyApprovalJudging?.(dispatch.id)) continue;
    const task = store.getSession(dispatch.id), interaction = task?.interaction;
    if (!task || interaction?.status !== "pending") continue;
    const question = interaction.questions[0]; if (!question) continue;
    const ids = question.options.map(option => option.optionId);
    items.push({ key: `i:${dispatch.id}:${interaction.runId}:${interaction.questionId}`, kind: "interaction", dispatch, task, prompt: question.prompt,
      options: question.options.map(option => ({ id: option.optionId, label: option.label })), approval: interaction.kind === "confirmation" && ids.includes("approve") && ids.includes("deny") });
  }
  return items;
}

const icon = (document: Document, name: string, className = "emc-icon") => { const span = el(document, "span", className); span.setAttribute("aria-hidden", "true"); setIcon(span, name); return span; };
function avatar(document: Document, agent: AgentDefinition | undefined, className = "emc-avatar"): HTMLElement {
  const url = agent ? resolveAgentAvatarUrl(agent.avatar) : undefined;
  if (url) { const image = el(document, "img", className); image.src = url; image.alt = ""; return image; }
  const fallback = el(document, "span", `${className} is-default`); fallback.append(icon(document, "bot")); return fallback;
}
function button(document: Document, text: string, variant: string, action: () => Promise<void> | void): HTMLButtonElement {
  const element = el(document, "button", `emc-button ${variant}`.trim()); element.type = "button";
  element.append(el(document, "span", "emc-button-visible", text));
  element.addEventListener("click", event => {
    event.stopPropagation(); element.disabled = true;
    void Promise.resolve().then(action).catch(error => console.error("Company action failed", error)).finally(() => { element.disabled = false; });
  });
  return element;
}
const agentOf = (ctx: MobileCompanyContext, id: string) => ctx.agents().find(agent => agent.id === id);
const nameOf = (ctx: MobileCompanyContext, id: string) => id === "me" ? "我" : agentOf(ctx, id)?.name ?? id;
const projectName = (ctx: MobileCompanyContext, d: CompanyDispatch) => d.projectId ? ctx.service.projectOf(d.projectId)?.name : undefined;
/** A path-like token ("旧版大纲.md", "项目/稿.canvas"); prompts without one keep their full text. */
const fileOf = (prompt: string) => /[^\s"'“”「」：:，,]+\.(?:md|canvas|base|pdf|png|jpe?g|txt|json)/iu.exec(prompt)?.[0];

/** Compact card: who, what, where on two lines; approve/deny inline, details folded. */
export function companyDecisionCard(ctx: MobileCompanyContext, item: MobileCompanyDecision, options: Readonly<{ showProject?: boolean }> = {}): HTMLElement {
  const { document } = ctx;
  if (item.kind === "owner") {
    const card = el(document, "div", "emc-decision"); card.dataset.decision = item.key;
    card.append(el(document, "div", "emc-decision-title", "这项工作需要指定模块负责人"), button(document, "指定负责人", "is-strong", () => ctx.assignOwner?.(item.request)));
    return card;
  }
  if (item.kind === "resume") {
    const card = el(document, "div", "emc-decision"); card.dataset.decision = item.key;
    card.append(el(document, "div", "emc-decision-title", "核对上次写入后继续"));
    for (const issue of item.snapshot.issues) card.append(el(document, "div", "emc-detail-text", `${issue.target}：${issue.label}`));
    card.append(button(document, "我已核对，继续", "is-strong", () => ctx.service.resumeAfterReview(item.dispatch.id, item.snapshot.fingerprint).catch(ctx.error)));
    return card;
  }
  const card = el(document, "div", `emc-decision is-${item.kind === "interaction" && item.approval ? "approval" : "question"}`); card.dataset.decision = item.key;
  const head = el(document, "div", "emc-decision-head"), copy = el(document, "div", "emc-grow");
  const where = [nameOf(ctx, item.dispatch.agentId), options.showProject === false ? undefined : projectName(ctx, item.dispatch)].filter(Boolean).join(" · ");
  head.append(avatar(document, agentOf(ctx, item.dispatch.agentId)), copy);
  if (item.kind === "interaction" && item.approval) {
    const destructive = item.task.interaction?.approval?.deleteAction ?? /删除|移除|delete/iu.test(item.prompt);
    const title = el(document, "div", "emc-decision-title");
    if (destructive) title.append(el(document, "span", "emc-danger-text", "删除 "));
    title.append(document.createTextNode((!destructive && /note_create/u.test(item.prompt) ? "新建 " : !destructive && /note_update/u.test(item.prompt) ? "更新 " : "") + (fileOf(item.prompt) ?? item.prompt)));
    copy.append(title, el(document, "div", "emc-decision-sub", where));
    const actions = el(document, "div", "emc-decision-actions");
    actions.append(button(document, "拒绝", "", () => answerInteraction(ctx, item, "deny")),
      button(document, "批准", destructive ? "is-danger" : "is-strong", () => answerInteraction(ctx, item, "approve")));
    head.append(actions); card.append(head);
    const details = el(document, "details", "emc-details"); details.append(el(document, "summary", "", "详情"), el(document, "div", "emc-detail-text", [item.prompt, item.task.interaction?.approval?.preview].filter(Boolean).join("\n")));
    card.append(details);
    return card;
  }
  if (item.kind === "interaction" && ctx.renderQuestion) {
    copy.append(el(document, "div", "emc-decision-sub", where)); card.append(head);
    const question = ctx.renderQuestion(item.task.id); card.append(question.element);
    card.dataset.companyDisposable = "true"; (card as CompanyDisposable).disposeCompany = () => question.dispose();
    return card;
  }
  copy.append(el(document, "div", "emc-decision-title", item.prompt), el(document, "div", "emc-decision-sub", where));
  card.append(head);
  const choices = el(document, "div", "emc-decision-choices");
  if (item.kind === "question") for (const option of item.options) choices.append(button(document, option, "", () => ctx.service.answerDecision(item.dispatch.id, option).catch(ctx.error)));
  else for (const option of item.options) choices.append(button(document, option.label, "", () => answerInteraction(ctx, item, option.id)));
  if (choices.childElementCount) card.append(choices);
  else if (item.kind === "question") {
    const input = el(document, "textarea", "emc-answer-input"); input.setAttribute("aria-label", "你的决定");
    card.append(input, button(document, "回复", "is-strong", () => { const answer = input.value.trim(); if (answer) return ctx.service.answerDecision(item.dispatch.id, answer).catch(ctx.error); }));
  }
  return card;
}

async function answerInteraction(ctx: MobileCompanyContext, item: Extract<MobileCompanyDecision, { kind: "interaction" }>, optionId: string): Promise<void> {
  const interaction = item.task.interaction!;
  const answers: EchoInkQuestionAnswer[] = [{ questionId: interaction.questions[0].questionId, selectedOptionIds: [optionId] }];
  try { await ctx.runtime.answerQuestion(item.task.id, interaction.runId, interaction.questionId, answers); }
  catch (error) { ctx.error(error); }
}

type CompanyDisposable = HTMLElement & { disposeCompany?: () => void };
export function disposeCompanyTree(root: HTMLElement): void {
  for (const element of Array.from(root.querySelectorAll<CompanyDisposable>("[data-company-disposable]"))) element.disposeCompany?.();
}

/** "等你定" group: hidden when empty. */
export function companyDecisionGroup(ctx: MobileCompanyContext, items: readonly MobileCompanyDecision[], options: Readonly<{ showProject?: boolean }> = {}, previous?: HTMLElement): HTMLElement | null {
  if (!items.length) return null;
  const list = el(ctx.document, "div", "emc-decisions");
  const retained = new Map(Array.from(previous?.querySelectorAll<HTMLElement>("[data-decision]") ?? []).map(card => [card.dataset.decision, card]));
  for (const item of items) list.append(retained.get(item.key) ?? companyDecisionCard(ctx, item, options));
  return list;
}

function waitingIcon(document: Document, text: string): HTMLElement {
  const status = el(document, "span", "emc-status is-waiting"); status.append(icon(document, "hand"), el(document, "span", "", text)); return status;
}

/** Briefcase card: name, state, milestone bar, current step and counts. */
export function companyProjectCard(ctx: MobileCompanyContext, project: CompanyProject): HTMLElement {
  const { document, service } = ctx, doc = service.doc, counts = projectCounts(doc, project);
  const card = el(document, "button", `emc-project${project.status === "done" ? " is-done" : ""}`); card.type = "button"; card.dataset.projectId = project.id;
  card.addEventListener("click", () => ctx.openProject(project.id));
  const head = el(document, "div", "emc-project-head");
  head.append(icon(document, "briefcase"), el(document, "span", "emc-project-name", project.name));
  const waiting = mobileCompanyDecisions(service, ctx.store, { projectId: project.id }, ctx.runtime).length;
  if (project.status === "done") {
    const passed = project.acceptance?.filter(result => result.passed).length ?? 0;
    const status = el(document, "span", "emc-status"); status.append(icon(document, "check"), el(document, "span", "", `已结项 · ${passed}/${project.criteria.length} 通过`)); head.append(status);
  } else if (waiting) head.append(waitingIcon(document, `${waiting} 件等你定`));
  else if (project.status === "proposed") head.append(el(document, "span", "emc-status", "待开工"));
  card.append(head);
  const bar = el(document, "div", "emc-milestones"); bar.setAttribute("aria-hidden", "true");
  for (const step of projectMilestones(doc, project).slice(1, -1)) bar.append(el(document, "span", `emc-milestone is-${step.state}`));
  card.append(bar);
  const running = doc.dispatches.find(d => d.projectId === project.id && (d.status === "waiting" || d.status === "running"));
  const line = running ? `${nameOf(ctx, running.agentId)}：${project.plan.find(task => task.id === running.planTaskId)?.label ?? running.brief}${running.status === "waiting" ? "（等你定）" : ""}`
    : project.status === "done" ? project.summary ?? "" : counts.current?.title ?? "";
  if (line) card.append(el(document, "div", "emc-project-line", line));
  card.append(el(document, "div", "emc-project-meta", `里程碑 ${counts.milestonesDone}/${counts.milestonesTotal} · 任务 ${counts.tasksDone}/${counts.tasksTotal} · ${counts.turns} 轮`));
  return card;
}

/** Programmatic start card: only these two buttons can start or cancel a project. */
export function companyStartCard(ctx: MobileCompanyContext, project: CompanyProject): HTMLElement {
  const { document, service } = ctx;
  const card = el(document, "div", "emc-start"); card.dataset.projectId = project.id;
  const head = el(document, "div", "emc-start-head"); head.append(icon(document, "briefcase"), el(document, "span", "", `开工：${project.name}`)); card.append(head);
  const milestones = projectMilestones(service.doc, project).slice(1, -1);
  if (project.status === "proposed") {
    const members = el(document, "div", "emc-start-members");
    for (const task of project.plan) {
      const row = el(document, "div", "emc-start-row");
      const waitFor = task.dependsOn.map(id => project.plan.find(item => item.id === id)?.label ?? id);
      const text = el(document, "span", "emc-start-task", task.brief);
      text.append(el(document, "span", "emc-muted", waitFor.length ? ` · 等「${waitFor.join("」「")}」` : " · 马上开工"));
      row.append(avatar(document, agentOf(ctx, task.agentId)), el(document, "span", "emc-start-who", nameOf(ctx, task.agentId)), text);
      members.append(row);
    }
    card.append(members);
    const plan = el(document, "div", "emc-start-plan");
    plan.append(el(document, "div", "emc-start-meta", [`里程碑 ${milestones.length}`, `验收标准 ${project.criteria.length} 条`, `约 ${projectEstimatedTurns(project)} 轮`, project.dueLabel].filter(Boolean).join(" · ")));
    const details = el(document, "details", "emc-start-details");
    const summary = el(document, "summary", "", "里程碑与验收标准");
    const arrow = el(document, "span", "emc-start-chevron", "▾"); arrow.setAttribute("aria-hidden", "true"); summary.append(arrow);
    details.append(summary, el(document, "div", "emc-start-flow", milestones.map(step => step.title).join(" → ")));
    const criteria = el(document, "ul", "emc-start-criteria");
    criteria.setAttribute("role", "list");
    for (const criterion of project.criteria) criteria.append(el(document, "li", "", criterion));
    details.append(criteria); plan.append(details); card.append(plan);
  } else {
    const meta = project.status === "cancelled" ? "已取消" : [`已开工${project.startedAt ? ` · ${new Date(project.startedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}`, `里程碑 ${milestones.length}`].join(" · ");
    card.append(el(document, "div", "emc-start-meta", meta));
  }
  if (project.status === "proposed") {
    const actions = el(document, "div", "emc-start-actions");
    actions.append(button(document, "先不开", "", () => service.cancelProposal(project.routerConversationId, project.id).then(() => undefined, ctx.error)),
      button(document, "开工", "is-primary", () => service.start(project.routerConversationId, project.id).then(result => { if (!/^已开工/u.test(result)) ctx.error(new Error(result)); }, ctx.error)));
    card.append(actions);
  }
  return card;
}

/** The only company content inside a router conversation besides the start card. */
export function companyReminder(ctx: MobileCompanyContext, routerId: string): HTMLElement | null {
  const items = mobileCompanyDecisions(ctx.service, ctx.store, { routerId }, ctx.runtime);
  if (!items.length) return null;
  const candidate = ctx.service.projectForRouter(routerId);
  const project = candidate && items.some(item => item.kind === "owner" ? item.request.projectId === candidate.id : item.dispatch.projectId === candidate.id) ? candidate : undefined;
  const row = el(ctx.document, "button", "emc-reminder"); row.type = "button";
  row.append(icon(ctx.document, "hand"), el(ctx.document, "span", "emc-grow", `${project && project.status !== "proposed" ? "这个项目" : "员工"}有 ${items.length} 件等你定`), el(ctx.document, "span", "emc-reminder-go", "去处理"), icon(ctx.document, "chevron-right"));
  row.addEventListener("click", () => { if (project && project.status !== "proposed" && project.status !== "cancelled") ctx.openProject(project.id); else ctx.openWorkbench(); });
  return row;
}

function section(document: Document, title: string, count?: number, accent = false): HTMLElement {
  const heading = el(document, "div", "emc-section-heading");
  heading.append(el(document, "h2", "", title));
  if (count !== undefined) heading.append(el(document, "span", `emc-count${accent ? " is-waiting" : ""}`, `${count}`));
  return heading;
}

/** Read-only project page; answering 等你定 is the only action. Order follows the PRD. */
export function companyProjectPage(ctx: MobileCompanyContext, projectId: string, options: Readonly<{ openConversation: () => void; back?: () => void }>): HTMLElement {
  const { document, service } = ctx;
  const root = el(document, "div", "emc-project-page");
  let tab: "record" | "tasks" | "milestones" | "outputs" = "record";
  const render = () => {
    const project = service.projectOf(projectId);
    const focused = document.activeElement as HTMLElement | null;
    const previous = el(document, "div", "");
    for (const card of Array.from(root.querySelectorAll<HTMLElement>("[data-decision]"))) previous.append(card);
    disposeCompanyTree(root); root.replaceChildren();
    if (!project) { disposeCompanyTree(previous); root.append(el(document, "div", "emc-empty", "这个项目已不在本机记录里。")); return; }
    const doc = service.doc, counts = projectCounts(doc, project);
    const head = el(document, "div", "emc-page-head"), copy = el(document, "div", "emc-grow");
    if (options.back) { const back = button(document, "", "is-text", options.back); back.setAttribute("aria-label", "返回"); back.append(icon(document, "chevron-left")); head.append(back); }
    copy.append(el(document, "h1", "", project.name), el(document, "div", "emc-muted", project.folder ? `${project.folder}/` : "待开工"));
    const talk = button(document, "对话", "is-text", options.openConversation);
    talk.addEventListener("click", options.openConversation); head.append(copy, talk); root.append(head);
    if (project.status === "done") {
      root.append(section(document, "结项结果"));
      const result = el(document, "div", "emc-acceptance");
      if (project.summary) result.append(el(document, "div", "emc-summary", project.summary));
      for (const item of project.acceptance ?? []) {
        const row = el(document, "div", `emc-acceptance-row${item.passed ? "" : " is-failed"}`);
        row.append(icon(document, item.passed ? "check" : "x"), el(document, "span", "emc-grow", item.criterion), el(document, "span", "emc-muted", item.evidence));
        result.append(row);
      }
      root.append(result);
    }
    const memberIds = [...new Set(["sol", ...project.plan.map(task => task.agentId)])];
    root.append(section(document, "成员", memberIds.length));
    const members = el(document, "div", "emc-members");
    for (const id of memberIds) {
      const latest = [...doc.dispatches].reverse().find(d => d.projectId === project.id && d.agentId === id);
      const state = id === "sol" ? (project.status === "done" ? "已结项" : "协调中") : !latest ? "排队中" : latest.status === "waiting" ? "等你定" : latest.status === "running" ? "进行中" : latest.status === "done" ? "已完成" : latest.status === "failed" ? "没做成" : latest.status === "stopped" ? "已停下" : "排队中";
      const chip = el(document, "div", "emc-member"); const text = el(document, "div", "emc-member-copy");
      text.append(el(document, "div", "emc-member-name", nameOf(ctx, id)), el(document, "div", `emc-member-state${state === "等你定" ? " is-waiting" : ""}`, state));
      chip.append(avatar(document, agentOf(ctx, id), "emc-avatar is-large"), text); members.append(chip);
    }
    root.append(members, section(document, "概况"));
    const overview = el(document, "div", "emc-overview");
    const fact = (label: string, value: HTMLElement | string, strong = false) => {
      const row = el(document, "div", "emc-fact"); row.append(el(document, "div", "emc-fact-label", label));
      row.append(typeof value === "string" ? el(document, "div", `emc-fact-value${strong ? " is-strong" : ""}`, value) : value); overview.append(row);
    };
    if (project.background) fact("背景", project.background);
    fact("目标", project.goal, true);
    const criteria = el(document, "div", "emc-fact-value");
    for (const criterion of project.criteria) { const passed = project.acceptance?.find(item => item.criterion === criterion)?.passed; criteria.append(el(document, "div", "", `${passed === undefined ? "○" : passed ? "✓" : "✕"} ${criterion}`)); }
    fact("验收标准", criteria);
    fact("时间", [project.startedAt ? `${new Date(project.startedAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}开始` : "未开工", project.dueLabel].filter(Boolean).join(" · "));
    root.append(overview);
    const stats = el(document, "div", "emc-stats");
    const stat = (label: string, value: number, total: string) => { const cell = el(document, "div", "emc-stat"); const number = el(document, "div", "emc-stat-value", `${value}`); number.append(el(document, "span", "emc-muted", ` / ${total}`)); cell.append(el(document, "div", "emc-muted", label), number); stats.append(cell); };
    stat("里程碑", counts.milestonesDone, `${counts.milestonesTotal}`); stat("任务", counts.tasksDone, `${counts.tasksTotal}`); stat("对话轮次", counts.turns, `约 ${projectEstimatedTurns(project)}`);
    root.append(stats);
    const decisions = mobileCompanyDecisions(service, ctx.store, { projectId }, ctx.runtime);
    if (decisions.length) { root.append(section(document, "等你定", decisions.length, true)); root.append(companyDecisionGroup(ctx, decisions, { showProject: false }, previous)!); }
    disposeCompanyTree(previous);
    const tabs = el(document, "div", "emc-tabs"); tabs.setAttribute("role", "tablist");
    const outputs = doc.dispatches.filter(d => d.projectId === project.id).flatMap(d => d.report?.outputs ?? []);
    for (const [id, label, count] of [["record", "记录", ""], ["tasks", "任务", `${counts.tasksDone}/${counts.tasksTotal}`], ["milestones", "里程碑", `${counts.milestonesDone}/${counts.milestonesTotal}`], ["outputs", "产出", `${outputs.length}`]] as const) {
      const item = el(document, "button", `emc-tab${tab === id ? " is-active" : ""}`); item.type = "button"; item.setAttribute("role", "tab"); item.setAttribute("aria-selected", `${tab === id}`);
      item.append(el(document, "span", "", label)); if (count) item.append(el(document, "span", "emc-tab-count", count));
      item.addEventListener("click", () => { tab = id; render(); }); tabs.append(item);
    }
    root.append(tabs);
    const body = el(document, "div", "emc-tab-body");
    if (tab === "record") {
      const events = doc.events.filter(event => event.projectId === project.id);
      if (!events.length) body.append(el(document, "div", "emc-empty", "还没有记录。"));
      for (const event of events) {
        const row = el(document, "div", "emc-event"), copy = el(document, "div", "emc-grow");
        const kind = { user: "交代", goal: "目标", dispatch: "派活", report: "汇报", question: "提问", answer: "回答", close: "结项", system: "记录" }[event.kind as string] ?? "记录";
        const meta = el(document, "div", "emc-event-meta"); meta.append(el(document, "span", "emc-event-who", nameOf(ctx, event.who)), document.createTextNode(` · ${kind} · ${new Date(event.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`));
        copy.append(meta, el(document, "div", "emc-event-text", event.text));
        row.append(avatar(document, agentOf(ctx, event.who === "me" ? "" : event.who)), copy); body.append(row);
      }
    } else if (tab === "tasks") {
      for (const task of project.plan) {
        const d = dispatchForPlanTask(doc, project.id, task.id);
        const row = el(document, "button", "emc-task-row"); row.type = "button"; row.disabled = !d;
        row.append(avatar(document, agentOf(ctx, task.agentId)), el(document, "span", "emc-grow", task.label), el(document, "span", "emc-muted", d ? { queued: "排队中", running: "进行中", waiting: "等你定", done: "已完成", failed: "没做成", stopped: "已停下" }[d.status] : "未开始"));
        if (d) row.addEventListener("click", () => ctx.openTask(d.id));
        body.append(row);
      }
    } else if (tab === "milestones") {
      for (const step of projectMilestones(doc, project, id => nameOf(ctx, id))) {
        const row = el(document, "div", `emc-step is-${step.state}`);
        row.append(el(document, "span", "emc-step-dot"), el(document, "span", "emc-grow", step.title), el(document, "span", "emc-muted", step.state === "done" ? "已完成" : step.state === "waiting" ? "等你定" : step.state === "current" ? "进行中" : "计划"));
        body.append(row);
      }
    } else {
      if (!outputs.length) body.append(el(document, "div", "emc-empty", "还没有产出。"));
      for (const path of [...new Set(outputs)]) {
        const row = button(document, path, "is-text emc-output", () => ctx.openNote?.(path));
        row.prepend(icon(document, "file-text")); body.append(row);
      }
    }
    root.append(body);
    const hint = el(document, "div", "emc-hint"); hint.append(icon(document, "message-circle"), el(document, "span", "", "要调整，回项目对话里跟总助说")); root.append(hint);
    if (focused && root.contains(focused)) focused.focus({ preventScroll: true });
  };
  render();
  const unsubscribe = service.subscribe(render);
  const unsubscribeRuntime = ctx.runtime.subscribe(render);
  (root as HTMLElement & { disposeCompany?: () => void }).disposeCompany = () => { disposeCompanyTree(root); unsubscribe(); unsubscribeRuntime(); };
  return root;
}
