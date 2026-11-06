import { AGENT_MODULE_IDS, AGENT_MODULE_NAMES, type AgentModuleId } from "../agents/types";
import { COMPANY_MAX_OPEN_PER_ROUTER, COMPANY_MAX_RUNNING, type CompanyOwnerRequest, type CompanyDispatch, type CompanyDocument, type CompanyEvent, type CompanyPlanTask, type CompanyProject, type CompanyReport, type CompanyStaffActivity } from "./types";
import { dispatchForPlanTask, fallbackReport, pendingDecisions, projectAllDone, projectCounts, projectFolderName, readyPlanTasks, reportMessage, startableQueued, normalizeStaffActivity, staffActivitySourceKey } from "./logic";
import type { CompanyToolPort } from "./tool-specs";
import { companyStaffActivityPrompt } from "./prompts";

export type CompanyPermission = CompanyDispatch["permission"];
/** Desktop keeps the record in a Node file; mobile keeps one per device through the Obsidian adapter. */
export interface CompanyRecordStore {
  load(): Promise<CompanyDocument>;
  snapshot(): CompanyDocument;
  subscribe(listener: () => void): () => void;
  mutate(change: (doc: CompanyDocument) => CompanyDocument): Promise<CompanyDocument>;
}
/** Everything the service needs from the plugin; tests supply a fake. */
export interface CompanyHost {
  now(): number;
  newId(prefix: string): string;
  agents(): readonly Readonly<{ id: string; name: string; position: string; hired: boolean }>[];
  moduleOwner?(moduleId: AgentModuleId): string | null;
  routerPermission(routerId: string): CompanyPermission;
  createWorker(input: Readonly<{ id: string; agentId: string; title: string; projectId?: string }>): Promise<void>;
  /** Starts one background turn on a conversation; resolves once accepted. */
  startTurn(conversationId: string, text: string, permission: CompanyPermission, inheritFrom?: string): Promise<void | "waiting">;
  resumeReviewed?(id: string, fingerprint: string, permission: CompanyPermission): Promise<void>;
  isRunning(conversationId: string): boolean;
  steer(conversationId: string, text: string): Promise<boolean>;
  stop(conversationId: string): Promise<void>;
  lastAssistantText(conversationId: string): Promise<string | undefined>;
  setRouterMetadata(routerId: string, patch: Readonly<{ companyRole?: "router"; projectId?: string }>): Promise<void>;
  ensureFolder(projectName: string, routerId: string): Promise<string | null>;
  /** Refresh and mark the router card unread, without starting a model turn. */
  notifyDecision?(routerId: string, projectId?: string): Promise<void>;
  /** Approval-only turns cannot consume ordinary worker reports. */
  canReceiveReports?(routerId: string): boolean;
  latestUserText(conversationId: string): Promise<string | undefined>;
}

type PlanDispatch = Readonly<{ projectId: string; task: CompanyPlanTask; replaces?: string }>;
const TERMINAL = new Set<CompanyDispatch["status"]>(["done", "failed", "stopped"]);
const PERMISSIONS: readonly CompanyPermission[] = ["read-only", "workspace-write", "danger-full-access"];

export class CompanyService implements CompanyToolPort {
  private readonly assignmentFlights = new Map<string, Promise<string>>();
  private scheduling: Promise<void> = Promise.resolve();
  constructor(private readonly store: CompanyRecordStore, private readonly host: CompanyHost, private readonly limit = COMPANY_MAX_RUNNING) {}
  get doc(): CompanyDocument { return this.store.snapshot(); }
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener); }
  private name(agentId: string): string { return this.host.agents().find(a => a.id === agentId)?.name ?? agentId; }
  private event(projectId: string, kind: CompanyEvent["kind"], who: string, text: string, files?: readonly string[]): CompanyEvent {
    return { id: this.host.newId("ev"), projectId, kind, who, text, at: this.host.now(), ...(files?.length ? { files } : {}) };
  }
  private patch(id: string, change: (d: CompanyDispatch) => CompanyDispatch): Promise<CompanyDocument> {
    return this.store.mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(d => d.id === id ? change(d) : d) }));
  }
  /** All slot claims and dependency dispatches use this same queue. Internal methods never enqueue themselves. */
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const run = this.scheduling.then(work);
    this.scheduling = run.then(() => undefined, () => undefined);
    return run;
  }
  private permission(d: CompanyDispatch): CompanyPermission {
    return PERMISSIONS[Math.min(PERMISSIONS.indexOf(d.permission), PERMISSIONS.indexOf(this.host.routerPermission(d.routerConversationId)))];
  }
  dispatchOf(id: string): CompanyDispatch | undefined { return this.doc.dispatches.find(d => d.id === id); }
  projectOf(id: string): CompanyProject | undefined { return this.doc.projects.find(p => p.id === id); }
  projectForRouter(routerId: string): CompanyProject | undefined { return [...this.doc.projects].reverse().find(p => p.routerConversationId === routerId); }

  async initialize(): Promise<void> {
    await this.store.load();
    await this.store.mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(d => (d.status === "running" || d.status === "waiting" && !d.report) && !this.host.isRunning(d.id)
      ? { ...d, status: "queued" as const, wake: d.wake ?? { text: `${RESTART_NOTE}\n\n原任务：${workerBrief(d, d.projectId ? this.projectOf(d.projectId) : undefined)}`, byPerson: false } } : d) }));
    await this.schedule(async () => {
      for (const project of this.doc.projects) if (project.status === "running") await this.advanceNow(project.id);
      await this.pumpNow();
      await this.flushReports();
    });
  }

  /** Pure record: never schedule, notify a router, write Personal Memory or send a model turn. */
  async recordStaffActivity(input: Readonly<CompanyStaffActivity>): Promise<void> {
    const activity = normalizeStaffActivity(input);
    if (!activity || !this.host.agents().some(agent => agent.id === activity.agentId) || this.dispatchOf(activity.conversationId)) return;
    const key = staffActivitySourceKey(activity);
    if (this.doc.staffActivities?.some(item => staffActivitySourceKey(item) === key)) return;
    await this.store.mutate(doc => {
      if (doc.dispatches.some(dispatch => dispatch.id === activity.conversationId)
        || doc.staffActivities?.some(item => staffActivitySourceKey(item) === key)) return doc;
      return { ...doc, staffActivities: [...(doc.staffActivities ?? []), activity] };
    });
  }
  staffActivityBackground(): string { return companyStaffActivityPrompt(this.doc.staffActivities ?? [], id => this.name(id)); }

  /* ===== 总助的工具 ===== */
  roster(): string {
    const rows = this.host.agents().filter(a => a.id !== "sol" && a.hired).map(a => `- ${a.id}：${a.name}${a.position ? " · " + a.position : ""}`);
    const modules = AGENT_MODULE_IDS.map(id => { const owner = this.host.moduleOwner?.(id); return `- ${id}（${AGENT_MODULE_NAMES[id][0]}）：${owner ? `${owner}（${this.name(owner)}）` : "未指定"}`; });
    return (rows.length ? "员工名单（派活时 agentId 用前面的编号）：\n" + rows.join("\n") : "现在没有可派活的员工。") + "\n模块负责人：\n" + modules.join("\n");
  }
  async transferAgentTasks(from: string, to: string): Promise<void> {
    await this.store.mutate(doc => ({ ...doc, dispatches: doc.dispatches.map(d => d.agentId === from ? { ...withoutPendingReport(d), agentId: to,
      ...(!TERMINAL.has(d.status) ? { status: "stopped" as const, endedAt: this.host.now() } : {}) } : d),
      projects: doc.projects.map(p => ({ ...p, plan: p.plan.map(t => t.agentId === from ? { ...t, agentId: to } : t) })) }));
  }
  pendingModuleAssignments(routerId: string): readonly CompanyOwnerRequest[] { return (this.doc.ownerRequests ?? []).filter(r => r.routerConversationId === routerId); }
  private async missingOwner(routerId: string, moduleId: AgentModuleId, brief: string, title?: string, proposal?: CompanyOwnerRequest["proposal"], source?: Pick<CompanyOwnerRequest, "dispatchId" | "projectId" | "planTaskId">): Promise<string> {
    const previous = this.pendingModuleAssignments(routerId).find(r => r.moduleId === moduleId && r.brief === brief && r.projectId === source?.projectId && r.planTaskId === source?.planTaskId && r.dispatchId === source?.dispatchId);
    if (!previous) await this.store.mutate(doc => ({ ...doc, ownerRequests: [...(doc.ownerRequests ?? []), { id: this.host.newId("owner"), routerConversationId: routerId, moduleId, brief, ...source, ...(title ? { title } : {}), ...(proposal ? { proposal } : {}) }] }));
    await this.host.notifyDecision?.(routerId);
    return `${AGENT_MODULE_NAMES[moduleId][0]}还没有负责人。已显示“指定负责人”入口；请等用户选择，不派给通才，也不要另行重试。`;
  }
  retryModuleAssignment(requestId: string): Promise<string> {
    const pending = this.assignmentFlights.get(requestId); if (pending) return pending;
    const run = this.retryModuleAssignmentOnce(requestId).finally(() => this.assignmentFlights.delete(requestId));
    this.assignmentFlights.set(requestId, run); return run;
  }
  private async retryModuleAssignmentOnce(requestId: string): Promise<string> {
    const request = this.doc.ownerRequests?.find(r => r.id === requestId);
    if (!request) return "这件事已处理。";
    const agentId = this.host.moduleOwner?.(request.moduleId); if (!agentId) return "模块还没有负责人。";
    const previous = request.dispatchId ? this.dispatchOf(request.dispatchId) : undefined;
    const projectId = request.projectId ?? previous?.projectId;
    const project = projectId ? this.projectOf(projectId) : undefined;
    const task = project?.plan.find(t => t.id === (request.planTaskId ?? previous?.planTaskId));
    const plan = project && task && project.routerConversationId === request.routerConversationId && (!previous || previous.status === "stopped" && previous.routerConversationId === request.routerConversationId && previous.moduleId === request.moduleId)
      ? { projectId: project.id, task: { ...task, agentId }, ...(previous ? { replaces: previous.id } : {}) } : undefined;
    // Claim before dispatching so double clicks cannot start duplicate work. Preserve the original project task.
    await this.store.mutate(doc => ({ ...doc, ownerRequests: doc.ownerRequests?.filter(r => r.id !== requestId),
      ...(plan ? { projects: doc.projects.map(p => p.id === plan.projectId ? { ...p, plan: p.plan.map(t => t.id === plan.task.id ? { ...t, agentId } : t) } : p) } : {}) }));
    if (request.proposal) return this.propose(request.routerConversationId, { ...request.proposal, plan: request.proposal.plan.map(t => ({ ...t, agentId: t.moduleId && t.moduleId !== "none" ? this.host.moduleOwner?.(t.moduleId) ?? t.agentId : t.agentId })) });
    return this.dispatch(request.routerConversationId, { agentId, moduleId: request.moduleId, brief: request.brief, ...(request.title ? { title: request.title } : {}) }, plan);
  }

  async dispatch(routerId: string, input: Readonly<{ agentId?: string; brief: string; title?: string; moduleId?: AgentModuleId | "none" }>, plan?: PlanDispatch): Promise<string> {
    return this.schedule(async () => {
      const result = await this.reserve(routerId, input, plan);
      if (typeof result === "string") return result;
      await this.pumpNow();
      await this.flushReports();
      const now = this.dispatchOf(result.id)!;
      if (now.status === "failed") return `派给${this.name(now.agentId)}的这件活没能开工：${now.report?.summary ?? "请稍后重试"}。任务编号 ${now.id}。`;
      return now.status === "running" ? `已派给${this.name(now.agentId)}，任务编号 ${now.id}。做完会自动汇报到这张卡片。`
        : `已派给${this.name(now.agentId)}，任务编号 ${now.id}。现在同时在做的活已满 ${this.limit} 件，这件排队，空出来就开工。`;
    });
  }
  private async reserve(routerId: string, input: Readonly<{ agentId?: string; brief: string; title?: string; moduleId?: AgentModuleId | "none" }>, plan?: PlanDispatch): Promise<CompanyDispatch | string> {
    if (input.moduleId && input.moduleId !== "none") {
      const owner = this.host.moduleOwner?.(input.moduleId);
      if (!owner) return this.missingOwner(routerId, input.moduleId, input.brief, input.title, undefined, plan ? { projectId: plan.projectId, planTaskId: plan.task.id } : undefined);
      if (input.agentId && owner !== input.agentId) return `该模块由 ${owner} 负责，请按 company_roster 中的归属派活。`;
    }
    const targetId = input.agentId ?? (input.moduleId && input.moduleId !== "none" ? this.host.moduleOwner?.(input.moduleId) : "generalist");
    const agent = this.host.agents().find(a => a.id === targetId);
    if (!agent || agent.id === "sol" || !agent.hired) return `没有编号为 ${input.agentId} 的员工，先用 company_roster 看名单。`;
    if (plan) {
      const existing = dispatchForPlanTask(this.doc, plan.projectId, plan.task.id);
      if (existing && !(existing.id === plan.replaces && existing.status === "stopped")) return existing;
      if (this.projectOf(plan.projectId)?.status !== "running") return "项目还没有开工。";
    }
    const open = this.doc.dispatches.filter(d => d.routerConversationId === routerId && !TERMINAL.has(d.status)).length;
    if (open >= COMPANY_MAX_OPEN_PER_ROUTER) return `这张卡片已有 ${open} 件活没做完，先等它们做完或停掉一些再派。`;
    const project = this.projectForRouter(routerId);
    const projectId = plan?.projectId ?? (project?.status === "running" ? project.id : undefined);
    const d: CompanyDispatch = { id: this.host.newId("conversation"), routerConversationId: routerId, agentId: agent.id, brief: input.brief,
      ...(input.moduleId ? { moduleId: input.moduleId } : {}), status: "queued", workerPending: true, permission: this.host.routerPermission(routerId), createdAt: this.host.now(), turns: 0,
      ...(projectId ? { projectId } : {}), ...(plan ? { planTaskId: plan.task.id } : {}) };
    // Persist the plan-task claim before any host call can yield or fail.
    await this.store.mutate(doc => ({ ...doc, dispatches: [...doc.dispatches, d] }));
    await this.createWorker(d, input.title || plan?.task.label || input.brief);
    return this.dispatchOf(d.id)!;
  }
  private async createWorker(d: CompanyDispatch, title?: string): Promise<void> {
    try {
      const task = d.projectId ? this.projectOf(d.projectId)?.plan.find(t => t.id === d.planTaskId) : undefined;
      await this.host.createWorker({ id: d.id, agentId: d.agentId, title: (title || task?.label || d.brief).replace(/\s+/gu, " ").trim().slice(0, 40),
        ...(d.projectId ? { projectId: d.projectId } : {}) });
      await this.patch(d.id, x => { const { workerPending: _pending, ...rest } = x; return rest; });
    } catch (error) { await this.finish(d.id, { outcome: "failed", summary: errorText(error), outputs: [], at: this.host.now() }, d.turns, true); }
  }
  async message(routerId: string, taskId: string, text: string): Promise<string> {
    const d = this.dispatchOf(taskId);
    if (!d || d.routerConversationId !== routerId) return "这张卡片没有派过这件活。";
    if (d.status === "waiting" && d.report?.outcome === "need_decision") {
      await this.answerDecision(taskId, text);
      return `已转给${this.name(d.agentId)}，接着做。`;
    }
    const permission = this.permission(d);
    if (d.status === "running") {
      if (PERMISSIONS.indexOf(permission) < PERMISSIONS.indexOf(d.turnPermission ?? d.permission)) {
        // An insert into the old turn would retain its write authority. Stop that turn before resuming with the narrower permission.
        await this.patch(taskId, x => ({ ...withoutPendingReport(x), status: "stopped", endedAt: this.host.now() }));
        if (this.host.isRunning(taskId)) await this.host.stop(taskId);
      } else if (await this.host.steer(taskId, text)) return `已转给${this.name(d.agentId)}，做完当前一步就看到。`;
    }
    await this.resume(taskId, text);
    return `已转给${this.name(d.agentId)}，接着做。`;
  }
  private async resume(id: string, text: string, answer?: string): Promise<void> {
    await this.store.mutate(doc => {
      let answeredProject: string | undefined;
      const dispatches = doc.dispatches.map(x => {
        if (x.id !== id || (answer !== undefined && (x.status !== "waiting" || x.answer))) return x;
        if (answer !== undefined) answeredProject = x.projectId;
        const { report: _r, reportPending: _pending, answer: _a, endedAt: _end, ...rest } = x;
        return { ...rest, status: "queued" as const, ...(answer !== undefined ? { answer } : {}),
          wake: { text: x.status === "queued" && x.wake ? `${x.wake.text}\n\n${text}` : text, byPerson: true } };
      });
      return { ...doc, dispatches, events: answeredProject ? [...doc.events, this.event(answeredProject, "answer", "me", answer!)] : doc.events };
    });
    await this.schedule(async () => { await this.pumpNow(); await this.flushReports(); });
  }
  async stop(routerId: string, taskId: string): Promise<string> {
    const d = this.dispatchOf(taskId);
    if (!d || d.routerConversationId !== routerId) return "这张卡片没有派过这件活。";
    const wasRunning = this.host.isRunning(taskId);
    await this.patch(taskId, x => ({ ...withoutPendingReport(x), status: "stopped", endedAt: this.host.now() }));
    if (wasRunning) await this.host.stop(taskId);
    await this.schedule(async () => { await this.pumpNow(); await this.flushReports(); });
    return `已停下${this.name(d.agentId)}的这件活。`;
  }
  status(routerId: string, taskId?: string): string {
    const mine = this.doc.dispatches.filter(d => d.routerConversationId === routerId);
    const line = (d: CompanyDispatch) => `- ${d.id} · ${this.name(d.agentId)} · ${STATUS_TEXT[d.status]} · ${d.brief.slice(0, 60)}${d.report ? `\n  汇报：${d.report.summary}` : ""}`;
    if (taskId) { const d = mine.find(x => x.id === taskId); return d ? line(d) : "这张卡片没有派过这件活。"; }
    const project = this.projectForRouter(routerId);
    const head = project ? (() => { const c = projectCounts(this.doc, project);
      return `项目「${project.name}」（${PROJECT_TEXT[project.status]}）：里程碑 ${c.milestonesDone}/${c.milestonesTotal}${c.current ? " · 当前 " + c.current.title : ""}，任务 ${c.tasksDone}/${c.tasksTotal}，${c.turns} 轮对话。\n`; })() : "";
    return head + (mine.length ? mine.map(line).join("\n") : "这张卡片还没派过活。");
  }
  async propose(routerId: string, input: Parameters<CompanyToolPort["propose"]>[1]): Promise<string> {
    const ids = new Set(input.plan.map(t => t.id));
    if (ids.size !== input.plan.length) return "开工卡里的任务编号重复了，请给每件活一个不同的 id。";
    for (const task of input.plan) {
      if (task.moduleId && task.moduleId !== "none") {
        const owner = this.host.moduleOwner?.(task.moduleId);
        if (!owner) return this.missingOwner(routerId, task.moduleId, input.goal, input.name, input);
        if (owner !== task.agentId) return `${task.moduleId}应交给负责人 ${owner}。`;
      }
      const agent = this.host.agents().find(a => a.id === task.agentId);
      if (!agent || agent.id === "sol" || !agent.hired) return `开工卡里的 ${task.id} 派给了不存在的员工 ${task.agentId}，先用 company_roster 看名单。`;
      if (task.dependsOn.some(dep => !ids.has(dep) || dep === task.id)) return `开工卡里的 ${task.id} 依赖了不存在的活，请改正 dependsOn。`;
    }
    if (hasCycle(input.plan)) return "开工卡里的依赖绕成了圈，请重排。";
    const existing = this.projectForRouter(routerId);
    if (existing && existing.status !== "proposed" && existing.status !== "cancelled") return `这张卡片已经绑定了项目「${existing.name}」，一张卡片只管一个项目。`;
    const id = existing?.status === "proposed" ? existing.id : this.host.newId("project");
    const project: CompanyProject = { id, name: input.name, background: input.background, goal: input.goal, criteria: input.criteria, folder: "",
      routerConversationId: routerId, status: "proposed", plan: input.plan, roles: { sol: "牵头：派活、协调、验收", ...input.roles }, createdAt: this.host.now(),
      ...(input.dueLabel ? { dueLabel: input.dueLabel } : {}) };
    await this.store.mutate(doc => ({ ...doc, projects: [...doc.projects.filter(p => p.id !== id), project] }));
    const people = [...new Set(input.plan.map(t => this.name(t.agentId)))].join("、");
    return `开工卡已生成（项目编号 ${id}）：${input.plan.length} 件活，${people} 参与，${input.criteria.length} 条验收标准。等待用户点击开工卡上的“开工”或“先不开”，不要另行询问。`;
  }
  async start(routerId: string, projectId: string): Promise<string> {
    return this.schedule(async () => {
      const project = this.projectOf(projectId);
      if (!project || project.routerConversationId !== routerId) return "这张卡片没有这个开工卡。";
      if (project.status !== "proposed") return project.status === "cancelled" ? `项目「${project.name}」已取消。` : `项目「${project.name}」已经开工了。`;
      if (this.host.routerPermission(routerId) === "read-only") return "当前是只读模式，不能创建项目文件夹或开工。";
      const folder = await this.host.ensureFolder(projectFolderName(project.name, this.host.now()), routerId);
      if (!folder) return "已取消选择文件夹，项目尚未开工。";
      if (this.host.routerPermission(routerId) === "read-only") return "当前已切换为只读模式，项目尚未开工。";
      if (this.projectOf(projectId)?.status !== "proposed") return "开工卡状态已变化，项目未启动。";
      const userText = await this.host.latestUserText(routerId).catch(() => undefined);
      await this.host.setRouterMetadata(routerId, { companyRole: "router", projectId });
      if (this.host.routerPermission(routerId) === "read-only" || this.projectOf(projectId)?.status !== "proposed") return "开工卡状态或权限已变化，项目未启动。";
      const now = this.host.now();
      await this.store.mutate(doc => ({ ...doc, projects: doc.projects.map(p => p.id === projectId ? { ...p, status: "running" as const, folder, startedAt: now } : p),
        events: [...doc.events,
          ...(userText ? [this.event(projectId, "user", "me", userText)] : []),
          this.event(projectId, "goal", "sol", `${project.goal}。验收标准：${project.criteria.join("、")}。`),
          ...project.plan.map(t => this.event(projectId, "dispatch", "sol", `@${this.name(t.agentId)} ${t.brief}${t.dependsOn.length ? "，等「" + t.dependsOn.map(d => project.plan.find(x => x.id === d)?.label ?? d).join("」「") + "」交了再开工。" : "，现在开工。"}`))] }));
      await this.advanceNow(projectId);
      await this.pumpNow();
      await this.flushReports();
      return `已开工：项目「${project.name}」，文件夹 ${folder}。没有依赖的活已经派出，有进展我回这张卡片说。`;
    });
  }
  async cancelProposal(routerId: string, projectId: string): Promise<string> {
    const project = this.projectOf(projectId);
    if (!project || project.routerConversationId !== routerId) return "这张卡片没有这个开工卡。";
    if (project.status !== "proposed") return "这张开工卡已经处理过了。";
    await this.store.mutate(doc => ({ ...doc, projects: doc.projects.map(p => p.id === projectId && p.status === "proposed" ? { ...p, status: "cancelled" as const, endedAt: this.host.now() } : p) }));
    await this.schedule(() => this.sendRouter(routerId, `〔项目已取消〕用户选择先不开项目「${project.name}」。不要派活或重新询问开工，等待用户的下一步要求。`));
    return `项目「${project.name}」已取消，等待你的下一步要求。`;
  }
  async accept(routerId: string, projectId: string, results: Parameters<CompanyToolPort["accept"]>[2], summary: string): Promise<string> {
    const project = this.projectOf(projectId);
    if (!project || project.routerConversationId !== routerId) return "这张卡片没有这个项目。";
    if (project.status === "done") return `项目「${project.name}」已结项。`;
    if (project.status !== "running" && project.status !== "paused") return "项目尚未开工，不能验收结项。";
    const unfinished = project.plan.filter(t => { const d = dispatchForPlanTask(this.doc, projectId, t.id); return !d || !TERMINAL.has(d.status); }).map(t => t.label);
    const live = this.doc.dispatches.filter(d => d.projectId === projectId && !TERMINAL.has(d.status));
    if (unfinished.length || live.length) return `还有任务未结束：${[...new Set([...unfinished, ...live.map(d => project.plan.find(t => t.id === d.planTaskId)?.label ?? d.brief)])].join("、")}。全部任务结束后再验收。`;
    const remaining = [...project.criteria], unexpected: string[] = [];
    for (const result of results) { const index = remaining.indexOf(result.criterion); if (index < 0) unexpected.push(result.criterion); else remaining.splice(index, 1); }
    if (remaining.length || unexpected.length) return ["验收结果必须逐条对应开工卡的原验收标准。", ...(remaining.length ? [`缺少：${remaining.join("、")}。`] : []),
      ...(unexpected.length ? [`多出或重复：${unexpected.join("、")}。`] : [])].join("");
    await this.store.mutate(doc => ({ ...doc, projects: doc.projects.map(p => p.id === projectId ? { ...p, status: "done" as const, endedAt: this.host.now(), acceptance: results, summary } : p),
      events: [...doc.events, this.event(projectId, "close", "sol", summary)] }));
    return `项目「${project.name}」已结项：验收标准 ${results.filter(r => r.passed).length}/${project.criteria.length} 通过。`;
  }
  async report(workerId: string, report: Omit<CompanyReport, "at" | "fallback">): Promise<string> {
    const d = this.dispatchOf(workerId);
    if (!d) return "这件活不是总助派的，不需要汇报。";
    if (d.status === "stopped") return "这件活已停下，不再接收汇报。";
    await this.patch(workerId, x => x.status === "stopped" ? x : { ...x, report: { ...report, at: this.host.now() } });
    return report.outcome === "need_decision" ? "问题已记入“等你定”，等待用户在卡片中回答。现在结束这一轮，不要再继续回复。"
      : "已汇报给总助。现在结束这一轮，不要再继续回复。";
  }

  /** Approval turns keep their reason in the existing project record. Single tasks retain their tool conversation. */
  async recordApprovalDecision(taskId: string, decision: "approve" | "reject" | "defer", reason: string): Promise<void> {
    await this.store.mutate(doc => {
      const d = doc.dispatches.find(item => item.id === taskId);
      if (!d?.projectId || !doc.projects.some(p => p.id === d.projectId)) return doc;
      const label = { approve: "批准", reject: "拒绝", defer: "交由用户决定" }[decision];
      return { ...doc, events: [...doc.events, this.event(d.projectId, "system", "sol",
        `总助审批：${label}。${this.name(d.agentId)}的任务「${d.brief.slice(0, 100)}」（${d.id}）。理由：${reason.trim()}`)] };
    });
  }

  /* ===== 项目页上直接点的“等你定” ===== */
  async resumeAfterReview(id: string, fingerprint: string): Promise<void> {
    await this.schedule(async () => {
      const dispatch = this.dispatchOf(id);
      if (!dispatch || dispatch.status !== "waiting" || dispatch.report || !this.host.resumeReviewed) return;
      if (this.doc.dispatches.filter(d => d.status === "running").length >= this.limit + 1) throw new Error("同时进行的工作已满，请稍后再继续。");
      await this.patch(id, d => ({ ...d, status: "running", turnPermission: this.permission(d) }));
      try { await this.host.resumeReviewed(id, fingerprint, this.permission(dispatch)); }
      catch (error) { await this.patch(id, d => d.status === "running" ? { ...d, status: "waiting" } : d); throw error; }
    });
  }
  async answerDecision(taskId: string, answer: string): Promise<void> {
    const d = this.dispatchOf(taskId);
    if (!d || d.status !== "waiting" || d.answer) return;
    await this.resume(taskId, `用户答：${answer}`, answer);
  }

  /* ===== 一轮结束：保存汇报、推进依赖、补空位、补投待交付汇报 ===== */
  async onWorkerSettled(id: string, outcome: "completed" | "waiting" | "interrupted" | "failed" | "cancelled", turnStartedAt: number): Promise<void> {
    const d = this.dispatchOf(id);
    if (!d || d.status !== "running") return;
    const fresh = d.report && d.report.at >= turnStartedAt ? d.report : undefined;
    const report = fresh ?? fallbackReport(outcome === "completed" ? await this.host.lastAssistantText(id).catch(() => undefined) : undefined, outcome !== "completed", this.host.now());
    if (!await this.finish(id, report, d.turns)) return;
    await this.schedule(async () => {
      if (d.projectId) await this.advanceNow(d.projectId);
      await this.pumpNow();
      await this.flushReports();
    });
  }
  /** Recheck state inside the actual mutation: stop may have happened while reading the last reply. */
  private async finish(id: string, report: CompanyReport, turns: number, allowQueued = false): Promise<boolean> {
    let applied = false;
    await this.store.mutate(doc => {
      const current = doc.dispatches.find(d => d.id === id);
      if (!current || (current.status !== "running" && !(allowQueued && current.status === "queued")) || current.turns !== turns) return doc;
      applied = true;
      const status: CompanyDispatch["status"] = report.outcome === "need_decision" ? "waiting" : report.outcome === "failed" ? "failed" : "done";
      let next: CompanyDocument = { ...doc, dispatches: doc.dispatches.map(d => {
        if (d.id !== id) return d;
        const { answer: _answered, ...rest } = d;
        return { ...rest, status, report, endedAt: this.host.now() };
      }) };
      const project = current.projectId ? next.projects.find(p => p.id === current.projectId) : undefined;
      const all = project && projectAllDone(next, project);
      if (!project || report.outcome !== "done" || all) next = { ...next, dispatches: next.dispatches.map(d => d.id === id ? { ...d,
        reportPending: { id: this.host.newId("report"), ...(all ? { tail: ACCEPT_NOTE } : {}) } } : d) };
      if (project) next = { ...next, events: [...next.events, this.event(project.id, report.outcome === "need_decision" ? "question" : "report", current.agentId,
        report.question ? `${report.summary} ${report.question}` : report.summary, report.outputs)] };
      return next;
    });
    return applied;
  }
  private async advanceNow(projectId: string): Promise<void> {
    const project = this.projectOf(projectId); if (!project) return;
    for (const task of readyPlanTasks(this.doc, project)) {
      if (dispatchForPlanTask(this.doc, projectId, task.id)) continue;
      await this.reserve(project.routerConversationId, { agentId: task.agentId, brief: task.brief, title: task.label, moduleId: task.moduleId }, { projectId, task });
    }
  }
  private async pumpNow(): Promise<void> {
    while (true) {
      // Pick again after every accepted or failed start; stale snapshots must never claim the same slot twice.
      const candidate = startableQueued(this.doc, this.limit)[0];
      if (!candidate) break;
      if (candidate.moduleId && candidate.moduleId !== "none") {
        const owner = this.host.moduleOwner?.(candidate.moduleId);
        if (!owner) {
          await this.patch(candidate.id, d => ({ ...withoutPendingReport(d), status: "stopped", endedAt: this.host.now() }));
          await this.missingOwner(candidate.routerConversationId, candidate.moduleId, candidate.brief, undefined, undefined, { dispatchId: candidate.id, projectId: candidate.projectId, planTaskId: candidate.planTaskId });
          continue;
        }
      }
      if (candidate.workerPending) await this.createWorker(candidate);
      let d = this.dispatchOf(candidate.id);
      if (!d || d.status !== "queued" || !startableQueued(this.doc, this.limit).some(x => x.id === d!.id)) continue;
      const project = d.projectId ? this.projectOf(d.projectId) : undefined;
      const text = d.turns === 0 ? [workerBrief(d, project), ...(d.wake ? [`补充要求：${d.wake.text}`] : [])].join("\n\n") : d.wake?.text ?? workerBrief(d, project);
      const permission = this.permission(d);
      let claimed = false;
      await this.patch(d.id, x => {
        if (x.status !== "queued") return x;
        claimed = true;
        const { wake: _wake, report: _report, reportPending: _pending, ...rest } = x;
        return { ...rest, status: "running", startedAt: this.host.now(), turnPermission: permission, turns: x.turns + 1 };
      });
      if (!claimed) continue;
      d = this.dispatchOf(d.id)!;
      if (d.status !== "running") continue;
      try { if (await this.host.startTurn(d.id, text, permission, d.routerConversationId) === "waiting") await this.patch(d.id, x => x.status === "running" ? { ...x, status: "waiting" } : x); }
      catch (error) { await this.finish(d.id, { outcome: "failed", summary: errorText(error), outputs: [], at: this.host.now() }, d.turns); }
    }
  }
  /** The host calls this after an approval-only router turn settles. */
  flushPendingReports(): Promise<void> { return this.schedule(() => this.flushReports()); }
  private async flushReports(): Promise<void> {
    for (const snapshot of this.doc.dispatches.filter(d => d.reportPending && d.report)) {
      const d = this.dispatchOf(snapshot.id);
      if (!d?.report || !d.reportPending || d.status === "stopped") continue;
      const pending = d.reportPending;
      try {
        if (d.report.outcome === "need_decision") await this.host.notifyDecision?.(d.routerConversationId, d.projectId);
        else {
          if (this.host.canReceiveReports?.(d.routerConversationId) === false) continue;
          await this.sendRouter(d.routerConversationId, reportMessage(d, this.name(d.agentId), d.projectId ? this.projectOf(d.projectId)?.name : undefined) + (pending.tail ?? ""));
        }
        await this.patch(d.id, x => x.reportPending?.id === pending.id ? withoutPendingReport(x) : x);
      } catch { /* Keep the outbox on disk. initialize or the next scheduling event retries it. */ }
    }
  }
  private async sendRouter(routerId: string, text: string): Promise<void> {
    if (this.host.isRunning(routerId) && await this.host.steer(routerId, text)) return;
    await this.host.startTurn(routerId, text, this.host.routerPermission(routerId));
  }
  decisions(projectId?: string): CompanyDispatch[] { return pendingDecisions(this.doc, projectId); }
}

const RESTART_NOTE = "插件重启打断了这件活。先看这个对话里已经做到哪、项目文件夹里已经写了什么，接着做没做完的部分，不要重复已经做过的事。";
const ACCEPT_NOTE = "\n这个项目的活都做完了：请按原验收标准逐条核对，调用 project_accept 结项，再给用户写一句结项小结。";
const STATUS_TEXT: Record<CompanyDispatch["status"], string> = { queued: "排队中", running: "进行中", waiting: "等你定", done: "已完成", failed: "没做成", stopped: "已停下" };
const PROJECT_TEXT: Record<CompanyProject["status"], string> = { proposed: "待开工", running: "进行中", paused: "已暂停", done: "已结项", cancelled: "已取消" };
function withoutPendingReport(d: CompanyDispatch): CompanyDispatch { const { reportPending: _pending, ...rest } = d; return rest; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function workerBrief(d: CompanyDispatch, project?: CompanyProject): string {
  return [d.brief, ...(project ? [`这是项目「${project.name}」的一件活。项目目标：${project.goal}。产出写进项目文件夹 ${project.folder}/。`] : [])].join("\n\n");
}
function hasCycle(plan: readonly CompanyPlanTask[]): boolean {
  const state = new Map<string, number>();
  const visit = (id: string): boolean => { const s = state.get(id); if (s === 1) return true; if (s === 2) return false; state.set(id, 1);
    const task = plan.find(t => t.id === id); const bad = !!task && task.dependsOn.some(visit); state.set(id, 2); return bad; };
  return plan.some(t => visit(t.id));
}
