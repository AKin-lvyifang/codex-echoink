import { AGENT_MODULE_IDS, type AgentModuleId } from "../agents/types";
import { COMPANY_MAX_RUNNING, COMPANY_REPORT_SUMMARY_LIMIT, COMPANY_STAFF_ACTIVITY_LIMIT, COMPANY_STAFF_ACTIVITY_TITLE_LIMIT, COMPANY_STAFF_ACTIVITY_SUMMARY_LIMIT, type CompanyDispatch, type CompanyDocument, type CompanyEvent, type CompanyMilestone,
  type CompanyOwnerRequest, type CompanyPlanTask, type CompanyProject, type CompanyReport, type CompanyStaffActivity } from "./types";

export function emptyCompanyDocument(): CompanyDocument { return { schemaVersion: 1, projects: [], dispatches: [], events: [], staffActivities: [] }; }

/* ===== 读盘规整：未知或损坏的条目丢弃，不让一条坏数据拖垮整个公司 ===== */
const PROJECT_STATUS = ["proposed", "running", "paused", "done", "cancelled"];
const DISPATCH_STATUS = ["queued", "running", "waiting", "done", "failed", "stopped"];
const OUTCOMES = ["done", "need_decision", "failed"];
const EVENT_KINDS = ["user", "goal", "dispatch", "report", "question", "answer", "rework", "system", "close"];
const PERMISSIONS = ["read-only", "workspace-write", "danger-full-access"];
const rec = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const str = (v: unknown, max = 2000): string => typeof v === "string" ? v.trim().slice(0, max) : "";
const time = (v: unknown): number | undefined => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const strs = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v : []).map(item => str(item, 400)).filter(Boolean).slice(0, max);

export function normalizeCompanyDocument(value: unknown): CompanyDocument {
  const raw = rec(value);
  if (!raw || raw.schemaVersion !== 1) return emptyCompanyDocument();
  const projects = (Array.isArray(raw.projects) ? raw.projects : []).flatMap(item => { const p = normalizeProject(item); return p ? [p] : []; });
  const dispatches = (Array.isArray(raw.dispatches) ? raw.dispatches : []).flatMap(item => { const d = normalizeDispatch(item); return d ? [d] : []; });
  const events = (Array.isArray(raw.events) ? raw.events : []).flatMap(item => { const e = normalizeEvent(item); return e ? [e] : []; });
  const activities = (Array.isArray(raw.staffActivities) ? raw.staffActivities : []).flatMap(item => { const activity = normalizeStaffActivity(item); return activity ? [activity] : []; });
  const unique = new Map(activities.map(activity => [staffActivitySourceKey(activity), activity]));
  const staffActivities = [...unique.values()].sort((a, b) => a.at - b.at).slice(-COMPANY_STAFF_ACTIVITY_LIMIT);
  const ownerRequests: CompanyOwnerRequest[] = (Array.isArray(raw.ownerRequests) ? raw.ownerRequests : []).flatMap(value => {
    const r = rec(value); if (!r || !AGENT_MODULE_IDS.includes(r.moduleId as AgentModuleId) || !str(r.id, 128) || !str(r.routerConversationId, 256)) return [];
    const project = r.proposal ? normalizeProject({ ...rec(r.proposal), id: "owner-proposal", status: "proposed", routerConversationId: r.routerConversationId }) : null;
    return [{ id: str(r.id, 128), routerConversationId: str(r.routerConversationId, 256), moduleId: r.moduleId as AgentModuleId, brief: str(r.brief, 1000),
      ...(str(r.projectId, 128) ? { projectId: str(r.projectId, 128) } : {}), ...(str(r.planTaskId, 64) ? { planTaskId: str(r.planTaskId, 64) } : {}), ...(str(r.dispatchId, 256) ? { dispatchId: str(r.dispatchId, 256) } : {}), ...(str(r.title, 64) ? { title: str(r.title, 64) } : {}), ...(project ? { proposal: { name: project.name, background: project.background, goal: project.goal, criteria: project.criteria, roles: project.roles, plan: project.plan, ...(project.dueLabel ? { dueLabel: project.dueLabel } : {}) } } : {}) }];
  });
  return { schemaVersion: 1, projects, dispatches, events, staffActivities, ...(ownerRequests.length ? { ownerRequests } : {}) };
}

/** The source is the formal Pi turn identity, never a timestamp or a text prefix. */
export function staffActivitySourceKey(activity: Pick<CompanyStaffActivity, "conversationId" | "piSessionId" | "turnId">): string {
  return JSON.stringify([activity.conversationId, activity.piSessionId, activity.turnId]);
}
export function normalizeStaffActivity(value: unknown): CompanyStaffActivity | null {
  const r = rec(value), conversationId = str(r?.conversationId, 256), piSessionId = str(r?.piSessionId, 256), turnId = str(r?.turnId, 256), agentId = str(r?.agentId, 128);
  const oneLine = (value: unknown, limit: number) => typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
  const title = oneLine(r?.title, COMPANY_STAFF_ACTIVITY_TITLE_LIMIT), summary = oneLine(r?.summary, COMPANY_STAFF_ACTIVITY_SUMMARY_LIMIT), at = time(r?.at);
  if (!r || !conversationId || !piSessionId || !turnId || !agentId || agentId === "sol" || !title || !summary || at === undefined) return null;
  return { conversationId, piSessionId, turnId, agentId, title, summary, at };
}
function normalizePlanTask(value: unknown): CompanyPlanTask | null {
  const r = rec(value); const id = str(r?.id, 64), agentId = str(r?.agentId, 128), label = str(r?.label, 40);
  if (!r || !id || !agentId || !label) return null;
  const milestone = str(r.milestone, 40);
  return { id, agentId, ...(AGENT_MODULE_IDS.includes(r.moduleId as AgentModuleId) || r.moduleId === "none" ? { moduleId: r.moduleId as AgentModuleId | "none" } : {}), label, brief: str(r.brief, 1000) || label, dependsOn: strs(r.dependsOn, 12), ...(milestone ? { milestone } : {}) };
}
function normalizeProject(value: unknown): CompanyProject | null {
  const r = rec(value); const id = str(r?.id, 128), name = str(r?.name, 120), routerConversationId = str(r?.routerConversationId, 256);
  if (!r || !id || !name || !routerConversationId || !PROJECT_STATUS.includes(r.status as string)) return null;
  const plan = (Array.isArray(r.plan) ? r.plan : []).flatMap(item => { const t = normalizePlanTask(item); return t ? [t] : []; });
  const roles: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec(r.roles) ?? {})) { const role = str(value, 80); if (role) roles[key] = role; }
  const acceptance = Array.isArray(r.acceptance) ? r.acceptance.flatMap(item => { const a = rec(item); const criterion = str(a?.criterion, 200);
    return a && criterion ? [{ criterion, passed: a.passed === true, evidence: str(a.evidence, 300), ...(str(a.agentId, 128) ? { agentId: str(a.agentId, 128) } : {}) }] : []; }) : undefined;
  return { id, name, background: str(r.background), goal: str(r.goal, 600), criteria: strs(r.criteria, 10), folder: str(r.folder, 400), routerConversationId,
    status: r.status as CompanyProject["status"], plan, roles, createdAt: time(r.createdAt) ?? 0,
    ...(time(r.startedAt) !== undefined ? { startedAt: time(r.startedAt) } : {}), ...(str(r.dueLabel, 40) ? { dueLabel: str(r.dueLabel, 40) } : {}),
    ...(time(r.endedAt) !== undefined ? { endedAt: time(r.endedAt) } : {}), ...(acceptance ? { acceptance } : {}), ...(str(r.summary) ? { summary: str(r.summary) } : {}) };
}
export function normalizeReport(value: unknown): CompanyReport | null {
  const r = rec(value); if (!r || !OUTCOMES.includes(r.outcome as string)) return null;
  const question = str(r.question, 600), options = strs(r.options, 6);
  return { outcome: r.outcome as CompanyReport["outcome"], summary: str(r.summary, COMPANY_REPORT_SUMMARY_LIMIT), outputs: strs(r.outputs, 20), at: time(r.at) ?? 0,
    ...(question ? { question } : {}), ...(options.length ? { options } : {}), ...(r.fallback === true ? { fallback: true } : {}) };
}
function normalizeDispatch(value: unknown): CompanyDispatch | null {
  const r = rec(value); const id = str(r?.id, 256), routerConversationId = str(r?.routerConversationId, 256), agentId = str(r?.agentId, 128);
  if (!r || !id || !routerConversationId || !agentId || !DISPATCH_STATUS.includes(r.status as string)) return null;
  const report = normalizeReport(r.report), wake = rec(r.wake), wakeText = str(wake?.text, 4000);
  const pending = rec(r.reportPending), pendingId = str(pending?.id, 128);
  return { id, routerConversationId, agentId, ...(AGENT_MODULE_IDS.includes(r.moduleId as AgentModuleId) || r.moduleId === "none" ? { moduleId: r.moduleId as AgentModuleId | "none" } : {}), brief: str(r.brief, 1000), status: r.status as CompanyDispatch["status"],
    permission: PERMISSIONS.includes(r.permission as string) ? r.permission as CompanyDispatch["permission"] : "read-only",
    ...(PERMISSIONS.includes(r.turnPermission as string) ? { turnPermission: r.turnPermission as CompanyDispatch["permission"] } : {}),
    ...(r.workerPending === true ? { workerPending: true } : {}),
    createdAt: time(r.createdAt) ?? 0, turns: time(r.turns) ?? 0,
    ...(str(r.projectId, 128) ? { projectId: str(r.projectId, 128) } : {}), ...(str(r.planTaskId, 64) ? { planTaskId: str(r.planTaskId, 64) } : {}),
    ...(time(r.startedAt) !== undefined ? { startedAt: time(r.startedAt) } : {}), ...(time(r.endedAt) !== undefined ? { endedAt: time(r.endedAt) } : {}),
    ...(report ? { report } : {}), ...(str(r.answer, 600) ? { answer: str(r.answer, 600) } : {}),
    ...(report && pendingId ? { reportPending: { id: pendingId, ...(str(pending?.tail, 1000) ? { tail: str(pending?.tail, 1000) } : {}) } } : {}),
    ...(wakeText ? { wake: { text: wakeText, byPerson: wake?.byPerson === true } } : {}) };
}
function normalizeEvent(value: unknown): CompanyEvent | null {
  const r = rec(value); const id = str(r?.id, 128), projectId = str(r?.projectId, 128), who = str(r?.who, 128), text = str(r?.text, 1200);
  if (!r || !id || !projectId || !who || !text || !EVENT_KINDS.includes(r.kind as string)) return null;
  const files = strs(r.files, 12);
  return { id, projectId, kind: r.kind as CompanyEvent["kind"], who, text, at: time(r.at) ?? 0, ...(files.length ? { files } : {}) };
}

/* ===== 调度：哪些计划任务现在可以开工 ===== */
const LIVE = new Set(["running", "waiting"]);
export const runningDispatchCount = (doc: CompanyDocument): number => doc.dispatches.filter(d => d.status === "running").length;
export function dispatchForPlanTask(doc: CompanyDocument, projectId: string, planTaskId: string): CompanyDispatch | undefined {
  return [...doc.dispatches].reverse().find(d => d.projectId === projectId && d.planTaskId === planTaskId);
}
export function planTaskDone(doc: CompanyDocument, projectId: string, planTaskId: string): boolean {
  return dispatchForPlanTask(doc, projectId, planTaskId)?.status === "done";
}
/** Plan tasks whose dependencies are done and that were never dispatched, in plan order. */
export function readyPlanTasks(doc: CompanyDocument, project: CompanyProject): CompanyPlanTask[] {
  if (project.status !== "running") return [];
  return project.plan.filter(task => !dispatchForPlanTask(doc, project.id, task.id) && task.dependsOn.every(dep => planTaskDone(doc, project.id, dep)));
}
/**
 * Queued dispatches that may start now. Continuing started work goes before new work, and a person's reply
 * may take one slot beyond the limit, so new work never keeps the user waiting on a task they already answered.
 */
export function startableQueued(doc: CompanyDocument, limit = COMPANY_MAX_RUNNING): CompanyDispatch[] {
  let used = runningDispatchCount(doc);
  const picked: CompanyDispatch[] = [];
  const queued = doc.dispatches.filter(d => d.status === "queued").sort((a, b) => Number(!a.wake) - Number(!b.wake) || a.createdAt - b.createdAt);
  for (const d of queued) if (used < limit || (d.wake?.byPerson && used < limit + 1)) { picked.push(d); used++; }
  return picked;
}
export function projectAllDone(doc: CompanyDocument, project: CompanyProject): boolean {
  return project.plan.length > 0 && project.plan.every(task => planTaskDone(doc, project.id, task.id))
    && doc.dispatches.filter(d => d.projectId === project.id).every(d => d.status === "done" || d.status === "failed" || d.status === "stopped");
}
export function pendingDecisions(doc: CompanyDocument, projectId?: string): CompanyDispatch[] {
  return doc.dispatches.filter(d => d.status === "waiting" && d.report?.outcome === "need_decision" && !d.answer && (!projectId || d.projectId === projectId));
}

/* ===== 展示：里程碑和计数，各处同一口径 ===== */
export function projectMilestones(doc: CompanyDocument, project: CompanyProject, agentName: (id: string) => string = id => id): CompanyMilestone[] {
  const groups: { title: string; tasks: CompanyPlanTask[] }[] = [];
  for (const task of project.plan) {
    const title = task.milestone || task.label;
    const group = groups.find(g => g.title === title); if (group) group.tasks.push(task); else groups.push({ title, tasks: [task] });
  }
  const started = project.status !== "proposed";
  const steps: CompanyMilestone[] = [{ title: "开工", agentIds: ["sol"], taskIds: [], state: started ? "done" : "current", ...(project.startedAt ? { doneAt: project.startedAt } : {}) }];
  let currentSeen = !started;
  for (const group of groups) {
    const dispatches = group.tasks.map(task => dispatchForPlanTask(doc, project.id, task.id));
    const done = dispatches.every(d => d?.status === "done");
    const waiting = dispatches.some(d => d?.status === "waiting" && d.report?.outcome === "need_decision" && !d.answer);
    const state = done ? "done" : currentSeen ? "todo" : waiting ? "waiting" : "current";
    if (state !== "done") currentSeen = true;
    const doneAt = done ? Math.max(...dispatches.map(d => d?.endedAt ?? 0)) : undefined;
    const outs = done ? dispatches.flatMap(d => d?.report?.outputs ?? []).map(o => "《" + o.replace(/^.*\//u, "").replace(/\.md$/u, "") + "》") : [];
    const next = done ? project.plan.find(t => t.dependsOn.some(dep => group.tasks.some(g => g.id === dep))) : undefined;
    steps.push({ title: group.title, agentIds: [...new Set(group.tasks.map(t => t.agentId))], taskIds: group.tasks.map(t => t.id), state,
      ...(doneAt ? { doneAt } : {}), ...(outs.length && next ? { handoff: outs.join("") + " → " + agentName(next.agentId) } : {}) });
  }
  const closed = project.status === "done";
  steps.push({ title: "验收结项", agentIds: ["sol"], taskIds: [], state: closed ? "done" : currentSeen ? "todo" : "current", ...(closed && project.endedAt ? { doneAt: project.endedAt } : {}) });
  return steps;
}
export function projectCounts(doc: CompanyDocument, project: CompanyProject) {
  const milestones = projectMilestones(doc, project);
  const tasks = project.plan.map(task => dispatchForPlanTask(doc, project.id, task.id));
  const reworks = doc.dispatches.filter(d => d.projectId === project.id && !d.planTaskId).length;
  return {
    milestonesDone: milestones.filter(m => m.state === "done").length, milestonesTotal: milestones.length,
    current: milestones.find(m => m.state !== "done"),
    tasksDone: tasks.filter(d => d?.status === "done").length, tasksTotal: project.plan.length,
    tasksRunning: tasks.filter(d => d && LIVE.has(d.status) && d.status === "running").length,
    tasksWaiting: pendingDecisions(doc, project.id).length,
    reworks,
    turns: doc.dispatches.filter(d => d.projectId === project.id).reduce((sum, d) => sum + d.turns, 0)
  };
}

/* ===== 汇报：员工忘了调用 report_to_router 时，用最后一条回复兜底 ===== */
export function fallbackReport(lastAssistantText: string | undefined, interrupted: boolean, at: number): CompanyReport {
  const text = (lastAssistantText ?? "").replace(/\s+/gu, " ").trim();
  if (interrupted) return { outcome: "failed", summary: text ? text.slice(0, COMPANY_REPORT_SUMMARY_LIMIT) : "任务中断，没有完成。", outputs: [], at, fallback: true };
  return { outcome: "done", summary: text ? text.slice(0, COMPANY_REPORT_SUMMARY_LIMIT) : "做完了，但没有留下说明。", outputs: [], at, fallback: true };
}
/** The message the router receives. Short, structured, and clearly not typed by the user. */
export function reportMessage(dispatch: CompanyDispatch, agentName: string, projectName?: string): string {
  const r = dispatch.report!;
  const head = r.outcome === "done" ? "做完了" : r.outcome === "failed" ? "没做成" : "需要用户定";
  return [`〔员工汇报〕${agentName}${projectName ? " · " + projectName : ""}：${head}`, `任务：${dispatch.brief}`, `摘要：${r.summary}`,
    ...(r.outputs.length ? [`产出：${r.outputs.join("、")}`] : []), ...(r.question ? [`问题：${r.question}`] : []),
    ...(r.options?.length ? [`选项：${r.options.join(" / ")}`] : []), `任务编号：${dispatch.id}`].join("\n");
}
export function projectFolderName(name: string, now: number): string {
  const d = new Date(now); const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${ym} ${name.replace(/[\\/:*?"<>|#^[\]]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 60)}`;
}

/** Both desktop and mobile show one initial turn per planned task. */
export function projectEstimatedTurns(project: Pick<CompanyProject, "plan">): number { return project.plan.length; }
