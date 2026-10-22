import type { KnowledgeLinkingTask } from "../../knowledge-base/knowledge-linking-types";
import { maintenanceActivityText, maintenanceStageLabel, type KnowledgeActivity, type KnowledgeActivitySnapshot, type KnowledgeActivitySource, type MaintenanceActivity } from "../../knowledge-base/maintenance-activity";

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
  const button = document.createElement("button"); button.type = "button";
  button.className = "echoink-knowledge-linking-progress-button";
  const title = document.createElement("span"); title.className = "echoink-knowledge-linking-progress-title";
  title.textContent = english ? "Knowledge links" : "知识关联";
  const status = document.createElement("span"); status.className = "echoink-knowledge-linking-progress-status";
  const progress = document.createElement("progress"); progress.className = "echoink-knowledge-linking-progress-bar";
  button.append(title, status, progress); container.append(button);
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
  const bar = container.ownerDocument.createElement("span");
  bar.className = "echoink-maintenance-progress-bar";
  bar.setAttribute("aria-hidden", "true");
  for (const step of activity.steps) {
    const segment = container.ownerDocument.createElement("span");
    segment.className = `echoink-maintenance-progress-segment is-${step.state}`;
    segment.dataset.stage = step.stage;
    const fill = container.ownerDocument.createElement("span");
    const fraction = step.state === "completed" ? 1 : step.total !== null && step.total > 0 ? Math.max(0, Math.min(1, step.completed / step.total)) : 0;
    fill.style.width = `${fraction * 100}%`;
    segment.append(fill); bar.append(segment);
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
  const button = document.createElement("button"); button.type = "button";
  button.className = "echoink-knowledge-linking-progress-button";
  const title = document.createElement("span"); title.className = "echoink-knowledge-linking-progress-title";
  const status = document.createElement("span"); status.className = "echoink-knowledge-linking-progress-status";
  const barHost = document.createElement("span"); barHost.className = "echoink-knowledge-activity-bar";
  button.append(title, status, barHost);
  const details = document.createElement("div"); details.className = "echoink-knowledge-activity-details";
  details.id = `echoink-knowledge-activity-${++activityProgressId}`; details.hidden = true;
  const steps = document.createElement("ol"); details.append(steps);
  const path = document.createElement("div"); path.className = "echoink-knowledge-activity-path"; details.append(path);
  const detailButton = document.createElement("button"); detailButton.type = "button";
  detailButton.className = "echoink-knowledge-activity-open";
  detailButton.textContent = english ? "View task" : "查看任务"; details.append(detailButton);
  const failures = document.createElement("ul"); failures.className = "echoink-knowledge-activity-failures"; failures.hidden = true;
  const otherButton = document.createElement("button"); otherButton.type = "button";
  otherButton.className = "echoink-knowledge-activity-open echoink-knowledge-activity-other"; otherButton.hidden = true;
  container.append(button, details, failures, otherButton);
  const expanded = new Set<string>();
  let current: Readonly<KnowledgeActivity> | null = null, other: Readonly<KnowledgeActivity> | null = null;
  const activityTitle = (activity: Readonly<KnowledgeActivity>) => activity.kind === "maintenance" ? (english ? "Organize knowledge" : "整理知识库") : (english ? "Knowledge links" : "知识关联");
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
        const row = document.createElement("li");
        const label = document.createElement("span"); label.textContent = maintenanceStageLabel(step.stage, english);
        const count = document.createElement("span"); count.className = "echoink-knowledge-activity-step-status";
        const state = step.state === "completed" ? (english ? "Completed" : "已完成")
          : step.state === "pending" ? (english ? "Not started" : "待开始")
          : current.status === "waiting" ? (english ? "Waiting for you" : "等你确认")
          : ["interrupted", "partial", "failed"].includes(current.status) ? (english ? "Ready to resume" : "可继续") : (english ? "In progress" : "进行中");
        count.textContent = `${state}${step.total === null ? "" : ` · ${step.completed} / ${step.total}`}`;
        row.append(label, count); steps.append(row);
      }
      path.hidden = !current.currentPath;
      path.textContent = current.currentPath ? `${english ? "Current" : "当前"}：${current.currentPath}` : "";
      for (const failure of current.failures) { const row = document.createElement("li"); row.textContent = failure.message; failures.append(row); }
      failures.hidden = !current.failures.length;
    } else {
      const task = current.task, progress = document.createElement("progress");
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
