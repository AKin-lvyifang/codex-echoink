import { ownedEl, ownedSpan, ownedDiv } from "../owned-dom";
import type { KnowledgeLinkingTask } from "../../knowledge-base/knowledge-linking-types";
import { maintenanceActivityText, maintenanceStageLabel, maintenanceStepText, maintenanceTaskStateLabel, maintenanceTaskTitle, type KnowledgeActivity, type KnowledgeActivitySnapshot, type KnowledgeActivitySource, type MaintenanceActivity } from "../../knowledge-base/maintenance-activity";
import { maintenanceFailureText, maintenancePageLabel } from "../../knowledge-base/maintenance-user-copy";

export interface KnowledgeLinkingProgressSource {
  subscribe(listener: (task: KnowledgeLinkingTask | null) => void): () => void;
}
export function knowledgeLinkingProgressText(task: KnowledgeLinkingTask, english = false): string {
  const labels = english ? { queued: "Waiting for current task", scanning: "Scanning notes", judging: task.judgment === "aliases" ? "Generating aliases" : "Reviewing links", "awaiting-confirmation": "Awaiting confirmation", writing: "Writing links", completed: "Completed", partial: "Partially completed · View results", failed: "Linking failed", interrupted: "Ready to resume", cancelled: "Cancelled" } : { queued: "等待当前关联任务", scanning: "扫描笔记", judging: task.judgment === "aliases" ? "生成别名" : "判断关联", "awaiting-confirmation": "待确认", writing: "写入关联", completed: "已完成", partial: "部分完成 · 查看结果", failed: "关联补全失败", interrupted: "可继续", cancelled: "已取消" };
  const label = labels[task.phase];
  return ["scanning", "judging", "writing"].includes(task.phase) && task.total !== null ? `${label} ${task.processed} / ${task.total}` : label;
}
export function knowledgeLinkingProgressVisible(task: KnowledgeLinkingTask | null): boolean {
  return !!task && !task.dismissed && !["completed", "cancelled"].includes(task.phase);
}
export function mountKnowledgeLinkingProgress(container: HTMLElement, source: KnowledgeLinkingProgressSource, open: (taskId?: string) => void, english = false): () => void {
  const document = container.ownerDocument;
  container.classList.add("echoink-knowledge-linking-progress");
  const button = ownedEl(document, "button"); button.type = "button";
  button.className = "echoink-knowledge-linking-progress-button";
  const title = button.createSpan({ cls: "echoink-knowledge-linking-progress-title", text: english ? "Knowledge links" : "知识关联" });
  const status = button.createSpan({ cls: "echoink-knowledge-linking-progress-status" });
  const progress = button.createEl("progress", { cls: "echoink-knowledge-linking-progress-bar" });
  container.append(button);
  let currentTaskId: string | undefined;
  button.onclick = () => open(currentTaskId);
  const unsubscribe = source.subscribe(task => {
    container.hidden = !knowledgeLinkingProgressVisible(task);
    if (!task) return;
    currentTaskId = task.id;
    status.textContent = knowledgeLinkingProgressText(task, english);
    button.setAttribute("aria-label", `${title.textContent} · ${status.textContent}`);
    const active = ["scanning", "judging", "writing"].includes(task.phase);
    progress.hidden = !active;
    if (task.total !== null && task.total > 0) { progress.max = task.total; progress.value = Math.min(task.processed, task.total); }
    else progress.removeAttribute("value");
  });
  return () => { unsubscribe(); button.onclick = null; container.replaceChildren(); };
}

/** A read-only bar shared by the sidebar and the existing workbench task. */
export function renderMaintenanceProgressBar(container: HTMLElement, activity: Readonly<MaintenanceActivity>): HTMLElement {
  const bar = ownedSpan(container.ownerDocument);
  bar.className = "echoink-maintenance-progress-bar";
  bar.setAttribute("aria-hidden", "true");
  for (const step of activity.steps) {
    const segment = bar.createSpan({ cls: `echoink-maintenance-progress-segment is-${step.state}` });
    segment.dataset.stage = step.stage;
    const fill = segment.createSpan();
    const fraction = step.state === "completed" ? 1 : step.total !== null && step.total > 0 ? Math.max(0, Math.min(1, step.completed / step.total)) : 0;
    fill.style.width = `${fraction * 100}%`;
  }
  container.append(bar);
  return bar;
}

let activityProgressId = 0;
export function mountKnowledgeActivityProgress(
  container: HTMLElement,
  source: KnowledgeActivitySource,
  open: (activity: Readonly<KnowledgeActivity>) => void,
  english = false
): () => void {
  const document = container.ownerDocument;
  container.classList.add("echoink-knowledge-linking-progress", "echoink-knowledge-activity-progress");
  container.hidden = true;
  const button = ownedEl(document, "button"); button.type = "button";
  button.className = "echoink-knowledge-linking-progress-button";
  const title = button.createSpan({ cls: "echoink-knowledge-linking-progress-title" });
  const status = button.createSpan({ cls: "echoink-knowledge-linking-progress-status" });
  const barHost = button.createSpan({ cls: "echoink-knowledge-activity-bar" });
  const details = ownedDiv(document); details.className = "echoink-knowledge-activity-details";
  details.id = `echoink-knowledge-activity-${++activityProgressId}`; details.hidden = true;
  const steps = details.createEl("ol");
  const path = details.createDiv({ cls: "echoink-knowledge-activity-path" });
  const detailButton = details.createEl("button", { cls: "echoink-knowledge-activity-open", text: english ? "View task" : "查看任务", attr: { type: "button" } });
  const failures = ownedEl(document, "ul"); failures.className = "echoink-knowledge-activity-failures"; failures.hidden = true;
  details.insertBefore(failures, detailButton);
  const otherButton = ownedEl(document, "button"); otherButton.type = "button";
  otherButton.className = "echoink-knowledge-activity-open echoink-knowledge-activity-other"; otherButton.hidden = true;
  container.append(button, details, otherButton);
  const expanded = new Set<string>();
  let current: Readonly<KnowledgeActivity> | null = null, other: Readonly<KnowledgeActivity> | null = null;
  const activityTitle = (activity: Readonly<KnowledgeActivity>) => activity.kind === "maintenance" ? maintenanceTaskTitle(activity, english) : (english ? "Knowledge links" : "知识关联");
  const activityText = (activity: Readonly<KnowledgeActivity>) => activity.kind === "maintenance" ? maintenanceActivityText(activity, english) : knowledgeLinkingProgressText(activity.task, english);
  const updateExpanded = () => {
    const maintenance = current?.kind === "maintenance" ? current : null, isExpanded = maintenance !== null && expanded.has(maintenance.id);
    details.hidden = !isExpanded;
    if (maintenance) { button.setAttribute("aria-expanded", String(isExpanded)); button.setAttribute("aria-controls", details.id); }
    else { button.removeAttribute("aria-expanded"); button.removeAttribute("aria-controls"); }
  };
  button.onclick = () => {
    if (!current) return;
    if (current.kind === "linking") { open(current); return; }
    if (expanded.has(current.id)) expanded.delete(current.id); else expanded.add(current.id);
    updateExpanded();
  };
  detailButton.onclick = () => { if (current) open(current); };
  otherButton.onclick = () => { if (other) open(other); };
  const render = (snapshot: Readonly<KnowledgeActivitySnapshot>) => {
    current = snapshot.primary; other = snapshot.other;
    container.hidden = !current;
    if (!current) return;
    title.textContent = activityTitle(current); status.textContent = activityText(current);
    button.setAttribute("aria-label", `${title.textContent} · ${status.textContent}`);
    button.dataset.status = current.status;
    barHost.replaceChildren(); steps.replaceChildren(); failures.replaceChildren();
    failures.hidden = true; path.hidden = true;
    if (current.kind === "maintenance") {
      barHost.hidden = false;
      renderMaintenanceProgressBar(barHost, current);
      for (const step of current.steps) {
        const row = ownedEl(document, "li");
        row.createSpan({ text: maintenanceStageLabel(step.stage, english, current.taskKind) });
        const count = row.createSpan({ cls: "echoink-knowledge-activity-step-status" });
        const state = step.state === "completed" ? (english ? "Completed" : "已完成")
          : step.state === "pending" ? (english ? "Not started" : "待开始")
          : maintenanceTaskStateLabel(current, english);
        const progress = step.stage === "finalize" && step.state === "running" || step.total !== null && ["decompose", "write"].includes(step.stage)
          ? maintenanceStepText(step, english, current.taskKind) : "";
        count.textContent = progress ? `${state} · ${progress}` : state;
        steps.append(row);
      }
      path.hidden = !current.currentPath;
      path.textContent = current.currentPath ? `${english ? "Current: " : "当前："}${maintenancePageLabel(current.currentPath)}` : "";
      for (const failure of current.failures) { const row = ownedEl(document, "li"); row.textContent = current.taskKind === "upgrade" ? failure.message : maintenanceFailureText(failure.message, current.currentPath, english); failures.append(row); }
      failures.hidden = !current.failures.length;
    } else {
      const task = current.task, progress = ownedEl(document, "progress");
      progress.className = "echoink-knowledge-linking-progress-bar";
      progress.hidden = !["scanning", "judging", "writing"].includes(task.phase);
      barHost.hidden = progress.hidden;
      if (task.total !== null && task.total > 0) { progress.max = task.total; progress.value = Math.min(task.processed, task.total); }
      barHost.append(progress);
    }
    otherButton.hidden = !other;
    otherButton.textContent = other ? `${activityTitle(other)} · ${activityText(other)}` : "";
    updateExpanded();
  };
  render(source.snapshot());
  const unsubscribe = source.subscribe(render);
  return () => { unsubscribe(); button.onclick = detailButton.onclick = otherButton.onclick = null; container.replaceChildren(); };
}
