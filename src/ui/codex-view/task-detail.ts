import type { SettingsLanguage } from "../../settings/settings";
import type { AgentDefinition } from "../../agents/types";
import { localDateLabel, localTaskTime, taskState, taskStateLabel, type TaskEntry } from "../../agents/task-presentation";
import { disposeOriginControls } from "../../settings/origin-controls";
import { renderTaskAvatar, taskIconButton } from "./agent-roster";

export function renderTaskDetailHeader(root: HTMLElement, agent: AgentDefinition, entry: TaskEntry, onBack: () => void, language: SettingsLanguage = "zh-CN"): void {
  disposeOriginControls(root); root.empty();
  const header = root.createDiv({ cls: "echoink-task-detail-header" });
  taskIconButton(header, language === "en" ? "Back to tasks" : "返回任务列表", "arrow-left", onBack);
  renderTaskAvatar(header, agent);
  const titles = header.createDiv({ cls: "echoink-task-detail-titles" });
  titles.createDiv({ cls: "echoink-task-detail-title", text: entry.title, attr: { title: entry.title } });
  const completed = taskState(entry) === "completed";
  const at = completed ? entry.taskCompletedAt ?? entry.updatedAt : entry.taskInterruptedAt;
  titles.createDiv({ cls: "echoink-task-detail-subtitle", text: `${agent.name}${at !== undefined ? ` · ${localDateLabel(at, Date.now(), language)} ${localTaskTime(at)}` : ""}` });
  header.createSpan({ cls: `echoink-task-card-status is-${taskState(entry)}`, text: taskStateLabel(entry, language) });
  // These rows are display metadata, separate from every transcript/message array.
  for (const event of entry.taskTransfers ?? []) root.createDiv({ cls: "echoink-task-transfer", text: language === "en" ? `Transferred from ${event.fromName} to the general assistant · ${localDateLabel(event.at, Date.now(), language)} ${localTaskTime(event.at)}` : `由 ${event.fromName} 转交给总助 · ${localDateLabel(event.at)} ${localTaskTime(event.at)}` });
}
const entered = new WeakMap<HTMLElement, number>();
export function animateTaskDetailEntry(root: HTMLElement, navigationToken: number): void {
  if (entered.get(root) === navigationToken) return;
  entered.set(root, navigationToken);
  if (root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  root.animate?.([{ transform: "translateX(16px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 160, easing: "ease-out" });
}
