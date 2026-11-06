import { Notice, TFile, setIcon, type App } from "obsidian";
import { GENERAL_ASSISTANT_ID, type AgentDefinition } from "../agents/types";
import { dispatchForPlanTask, projectMilestones } from "../company/logic";
import type { CompanyAcceptance, CompanyDispatch, CompanyDispatchStatus, CompanyDocument, CompanyProject } from "../company/types";
import { resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";

/** Shared by the project page and the workbench project card: one wording for every status. */
export const DISPATCH_STATUS: Record<CompanyDispatchStatus, readonly [icon: string, label: string]> = {
  queued: ["clock", "排队中"], running: ["loader-circle", "进行中"], waiting: ["hand", "等你定"],
  done: ["check", "已完成"], failed: ["circle-alert", "没做成"], stopped: ["circle-pause", "已停下"]
};

export type AgentLookup = (id: string) => AgentDefinition | undefined;
export function agentLookup(agents: readonly AgentDefinition[]): AgentLookup { return id => agents.find(agent => agent.id === id); }
export function agentName(lookup: AgentLookup, id: string): string { return lookup(id)?.name ?? (id === GENERAL_ASSISTANT_ID ? "总助" : id); }

export function renderAvatar(parent: HTMLElement, agent: AgentDefinition | undefined, small = false): HTMLElement {
  const avatar = parent.createSpan({ cls: `echoink-project-avatar${small ? " is-small" : ""}`, attr: { "aria-hidden": "true" } });
  const url = agent ? resolveAgentAvatarUrl(agent.avatar) : null;
  if (url) avatar.createEl("img", { attr: { src: url, alt: "", draggable: "false" } }); else setIcon(avatar, "bot");
  return avatar;
}
export function renderMe(parent: HTMLElement): HTMLElement { return parent.createSpan({ cls: "echoink-project-me", text: "你", attr: { "aria-hidden": "true" } }); }

export function projectAcceptance(project: CompanyProject): readonly CompanyAcceptance[] {
  return project.criteria.map(criterion => project.acceptance?.find(result => result.criterion === criterion)
    ?? { criterion, passed: false, evidence: "未提供验收结果" });
}

export function renderStatus(parent: HTMLElement, icon: string, label: string, tone: "" | "wait" | "run" = ""): HTMLElement {
  const status = parent.createSpan({ cls: `echoink-project-status${tone ? ` is-${tone}` : ""}` });
  setIcon(status.createSpan({ cls: "echoink-project-status-icon", attr: { "aria-hidden": "true" } }), icon);
  status.createSpan({ text: label });
  return status;
}
export function renderDispatchStatus(parent: HTMLElement, status: CompanyDispatchStatus | undefined): HTMLElement {
  const [icon, label] = DISPATCH_STATUS[status ?? "queued"];
  return renderStatus(parent, icon, label, status === "waiting" || status === "failed" ? "wait" : status === "running" ? "run" : "");
}

export function projectDispatches(doc: CompanyDocument, projectId: string): CompanyDispatch[] {
  return doc.dispatches.filter(d => d.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
}
export function latestDispatchOf(doc: CompanyDocument, projectId: string, agentId: string): CompanyDispatch | undefined {
  return projectDispatches(doc, projectId).filter(d => d.agentId === agentId).pop();
}

export interface ProjectOutput { readonly path: string; readonly agentId: string; readonly at: number }
/** Deliverables are what the last milestone group handed in; everything else is a process file. */
export function projectOutputs(doc: CompanyDocument, project: CompanyProject): { deliverables: ProjectOutput[]; process: ProjectOutput[] } {
  const groups = projectMilestones(doc, project).filter(m => m.taskIds.length);
  const finalTasks = new Set(groups[groups.length - 1]?.taskIds ?? []);
  const finalIds = new Set([...finalTasks].flatMap(id => { const d = dispatchForPlanTask(doc, project.id, id); return d?.status === "done" ? [d.id] : []; }));
  const seen = new Set<string>(), deliverables: ProjectOutput[] = [], process: ProjectOutput[] = [];
  for (const d of projectDispatches(doc, project.id)) for (const path of d.report?.outputs ?? []) {
    if (seen.has(path)) continue; seen.add(path);
    (finalIds.has(d.id) ? deliverables : process).push({ path, agentId: d.agentId, at: d.report?.at ?? d.endedAt ?? d.createdAt });
  }
  return { deliverables, process };
}
export function fileLabel(path: string): string { return path.replace(/^.*\//u, "").replace(/\.md$/u, ""); }

function resolveOutput(app: App, path: string, folder: string): TFile | null {
  const clean = path.replace(/^\/+/u, "");
  for (const candidate of [clean, folder ? `${folder}/${clean}` : ""]) {
    const file = candidate ? app.vault.getAbstractFileByPath(candidate) : null;
    if (file instanceof TFile) return file;
  }
  return null;
}
export function outputExists(app: App, path: string, folder: string): boolean { return resolveOutput(app, path, folder) !== null; }
export function openOutput(app: App, path: string, folder: string): void {
  const file = resolveOutput(app, path, folder);
  if (!file) { new Notice(`找不到文件：${path}`); return; }
  void app.workspace.openLinkText(file.path, "", false).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
}

export function formatClock(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export function formatTime(at: number): string { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
export function formatDay(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${"日一二三四五六".charAt(d.getDay())}`;
}
