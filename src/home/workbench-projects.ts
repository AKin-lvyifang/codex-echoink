import { setIcon } from "obsidian";
import { dispatchForPlanTask, pendingDecisions, projectCounts } from "../company/logic";
import type { CompanyDocument, CompanyProject } from "../company/types";
import { ownedEl } from "../ui/owned-dom";
import { agentName, projectAcceptance, renderAvatar, type AgentLookup } from "./project-parts";

/** Projects shown on the workbench: live ones newest first, closed ones last. */
export function workbenchProjects(doc: CompanyDocument): CompanyProject[] {
  const at = (p: CompanyProject) => p.startedAt ?? p.createdAt;
  return doc.projects.filter(p => p.status === "running" || p.status === "paused" || p.status === "done")
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || at(b) - at(a));
}
export function workbenchProjectSignature(doc: CompanyDocument, project: CompanyProject): string {
  return JSON.stringify([project, doc.dispatches.filter(d => d.projectId === project.id)]);
}

export function workbenchProjectCard(document: Document, doc: CompanyDocument, project: CompanyProject, agent: AgentLookup, open: () => void, approvalCount = 0): HTMLElement {
  const card = ownedEl(document, "button");
  card.type = "button"; card.className = "wb-project-card"; card.dataset.wbFocus = `project-${project.id}`;
  card.onclick = open;
  const counts = projectCounts(doc, project), waiting = pendingDecisions(doc, project.id).length + approvalCount, done = project.status === "done";
  const head = card.createSpan({ cls: "wb-project-head" });
  setIcon(head.createSpan({ cls: "wb-project-icon", attr: { "aria-hidden": "true" } }), "briefcase");
  head.createSpan({ cls: "wb-project-name", text: project.name });
  const results = projectAcceptance(project), passed = results.filter(result => result.passed).length;
  const badge = done ? [passed === results.length && results.length ? "check" : "circle-alert", `已结项 · ${passed}/${results.length} 通过`, ""] : waiting ? ["hand", `${waiting} 件等你定`, " is-wait"] : project.status === "paused" ? ["circle-pause", "已暂停", ""] : null;
  if (badge) {
    const status = head.createSpan({ cls: `wb-project-status${badge[2]}` });
    setIcon(status.createSpan({ cls: "wb-project-status-icon", attr: { "aria-hidden": "true" } }), badge[0]);
    status.createSpan({ text: badge[1] });
  }
  const bar = card.createSpan({ cls: "wb-project-bar", attr: { "aria-hidden": "true" } }).createEl("i");
  bar.setCssProps({ "--wb-project-progress": `${counts.milestonesTotal ? Math.round(counts.milestonesDone / counts.milestonesTotal * 100) : 0}%` });
  const kv = card.createSpan({ cls: "wb-project-kv" });
  kv.createSpan({ text: `里程碑 ${counts.milestonesDone}/${counts.milestonesTotal}${counts.current ? ` · ${counts.current.title}` : ""}` });
  kv.createSpan({ text: `任务 ${counts.tasksDone}/${counts.tasksTotal}` });
  kv.createSpan({ text: `${counts.turns} 轮对话` });
  if (project.status !== "running") return card;
  const busy = project.plan.flatMap(task => {
    const d = dispatchForPlanTask(doc, project.id, task.id);
    return d && (d.status === "running" || d.status === "waiting") ? [{ task, d }] : [];
  }).slice(0, 3);
  if (!busy.length) return card;
  const doing = card.createSpan({ cls: "wb-project-doing" });
  for (const { task, d } of busy) {
    const line = doing.createSpan({ cls: "wb-project-now" });
    renderAvatar(line, agent(d.agentId), true);
    line.createSpan({ cls: "wb-project-ellip", text: `${agentName(agent, d.agentId)}：${task.label}${d.status === "waiting" ? "（等你定）" : ""}` });
  }
  return card;
}
