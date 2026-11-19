import { openModuleOwnerSheet } from "../mobile/module-owner-sheet";
import { createInlineQuestion } from "./inline-question";
import { iphoneButton, iphoneAvatar } from "./workbench-elements";
import { GENERAL_ASSISTANT_ID } from "../../agents/types";
import type { MobileShellPage } from "../mobile/shell-types";
import { shellElement } from "../mobile/shell-controls";
import { disposeCompanyTree, companyDecisionGroup, companyProjectCard, companyProjectPage, mobileCompanyDecisions, remoteCompanyDecisions, remoteProjectSources, type MobileCompanyContext } from "../mobile/company-ui";
import type { IPhonePageContext } from "./workbench-contract";
import { createRemoteConversationContent, renderRemoteConversationList } from "../mobile/remote-conversation";

export function iphoneCompany(ctx: IPhonePageContext): MobileCompanyContext | null {
  const service = ctx.host.company?.();
  if (!service) return null;
  return { document: ctx.document, service, store: ctx.host.store, runtime: ctx.host.runtime, agents: () => ctx.host.settings().agentRegistry.agents, error: ctx.error,
    openWorkbench: () => { void ctx.navigate({ kind: "home" }).catch(ctx.error); },
    openNote: path => { void ctx.host.openNote(path).catch(ctx.error); },
    renderQuestion: id => createInlineQuestion(ctx, id),
    assignOwner: request => openModuleOwnerSheet({ document: ctx.document, prefix: "ip", language: ctx.host.settings().settingsLanguage, agents: ctx.host.agents, roster: ctx.host.settings().agentRegistry.agents, shell: ctx.shell,
      avatar: agent => iphoneAvatar(ctx.document, agent), button: (text, action, variant) => iphoneButton(ctx.document, text, action, variant),
      create: () => ctx.navigate({ kind: "agent-form", creation: { moduleIds: [request.moduleId] } }),
      start: async () => { await service.retryModuleAssignment(request.id); }, error: ctx.error }, request.moduleId),
    overview: ctx.host.syncOverview?.() ?? null, requests: ctx.host.syncRequests?.() ?? null,
    openTask: taskId => { void ctx.navigate({ kind: "task", taskId }).catch(ctx.error); },
    openProject: (projectId, deviceId) => { void ctx.navigate({ kind: "project", projectId, ...(deviceId ? { deviceId } : {}) }).catch(ctx.error); } };
}

function heading(document: Document, label: string, count: number, waiting = false): HTMLElement {
  const element = shellElement(document, "div", "ip-section-heading");
  element.append(shellElement(document, "h2", "", label), shellElement(document, "span", `ip-count${waiting ? " emc-count is-waiting" : ""}`, `${count}`));
  return element;
}

/** Top of the workbench: 等你定 first (hidden when empty), then projects. */
export function renderIPhoneCompanyHome(ctx: IPhonePageContext, slot: HTMLElement): void {
  const focused = ctx.document.activeElement as HTMLElement | null;
  const company = iphoneCompany(ctx);
  const conversations = renderRemoteConversationList(ctx.document, ctx.host.syncOverview?.() ?? null,
    summary => { void ctx.navigate({ kind: "remote-conversation", deviceId: summary.deviceId, conversationId: summary.id }).catch(ctx.error); }, "ip");
  if (!company) { disposeCompanyTree(slot); slot.replaceChildren(); if (conversations) slot.append(conversations); return; }
  const decisions = [...mobileCompanyDecisions(company.service, ctx.host.store, {}, ctx.host.runtime), ...remoteCompanyDecisions(company)];
  const group = companyDecisionGroup(company, decisions, {}, slot);
  disposeCompanyTree(slot); slot.replaceChildren();
  if (group) { const area = shellElement(ctx.document, "section", "ip-section emc-home-decisions"); area.append(heading(ctx.document, "等你定", decisions.length, true), group); slot.append(area); }
  const projects = company.service.doc.projects.filter(project => project.status === "running" || project.status === "paused" || project.status === "done" && (project.endedAt ?? 0) > Date.now() - 7 * 86_400_000)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  const remote = remoteProjectSources(company);
  if (projects.length || remote.length) {
    const area = shellElement(ctx.document, "section", "ip-section emc-home-projects"), cards = shellElement(ctx.document, "div", "emc-projects");
    for (const project of projects) cards.append(companyProjectCard(company, project));
    for (const source of remote) cards.append(companyProjectCard(company, source.project, source));
    area.append(heading(ctx.document, "项目", projects.length + remote.length), cards); slot.append(area);
  }
  if (focused && slot.contains(focused)) focused.focus({ preventScroll: true });
  if (conversations) slot.append(conversations);
}

export function createRemoteConversationPage(ctx: IPhonePageContext, deviceId: string, conversationId: string): MobileShellPage {
  const content = shellElement(ctx.document, "div", "ip-project-page");
  const summary = ctx.host.syncOverview?.()?.snapshot().conversations.find(item => item.deviceId === deviceId && item.id === conversationId);
  if (!summary) content.append(shellElement(ctx.document, "div", "emc-empty", "暂时无法读取这段对话。"));
  else content.append(createRemoteConversationContent({ document: ctx.document, fs: ctx.host.app.vault.adapter, store: ctx.host.store, summary, error: ctx.error,
    agentIds: () => ctx.host.settings().agentRegistry.agents.map(agent => agent.id), openAgent: agentId => ctx.navigate({ kind: "agent", agentId }) }));
  return { id: `remote-conversation:${deviceId}:${conversationId}`, title: summary?.title ?? "对话", header: "content", content };
}

/** Project worker tasks live on the project page; their questions live in 等你定. */
export function iphoneCompanyHidden(ctx: IPhonePageContext, task: { id: string; companyRole?: string; projectId?: string }): boolean {
  if (task.companyRole === "router" && task.projectId) return true;
  if (task.companyRole !== "worker") return false;
  const dispatch = ctx.host.company?.()?.dispatchOf(task.id);
  return !!task.projectId || dispatch?.status === "running" && ctx.host.store.getSession(task.id)?.interaction?.status === "pending";
}

export function createProjectPage(ctx: IPhonePageContext, projectId: string, deviceId?: string): MobileShellPage {
  const company = iphoneCompany(ctx);
  const content = shellElement(ctx.document, "div", "ip-project-page");
  const project = deviceId ? company?.overview?.remoteProject(projectId, deviceId) : company?.service.projectOf(projectId);
  const view = company ? companyProjectPage(company, projectId, { deviceId, back: () => { void ctx.shell.back(); }, openConversation: () => {
    const routerId = company.service.projectOf(projectId)?.routerConversationId;
    if (routerId) void ctx.navigate({ kind: "task", taskId: routerId }).catch(ctx.error);
    else void ctx.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }).catch(ctx.error);
  } }) : shellElement(ctx.document, "div", "emc-empty", "公司功能暂不可用。");
  content.append(view);
  return { id: deviceId ? `project:${deviceId}:${projectId}` : `project:${projectId}`, title: project?.name ?? "项目", header: "content", content,
    dispose: () => { (view as HTMLElement & { disposeCompany?: () => void }).disposeCompany?.(); } };
}
