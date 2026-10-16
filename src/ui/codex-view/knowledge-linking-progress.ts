import type { KnowledgeLinkingTask } from "../../knowledge-base/knowledge-linking-types";

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
