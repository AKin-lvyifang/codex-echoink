import type { SettingsLanguage } from "../../settings/settings";
import type { AgentDefinition } from "../../agents/types";
import { localDateLabel, localTaskTime, maintenanceActivityForTask, taskEntryWithMaintenance, taskState, taskStateLabel, type TaskEntry } from "../../agents/task-presentation";
import { maintenanceTaskTitle, type MaintenanceActivity } from "../../knowledge-base/maintenance-activity";
import { disposeOriginControls } from "../../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";
import { renderTaskAvatar, taskIconButton } from "./agent-roster";

export function renderTaskDetailHeader(root: HTMLElement, agent: AgentDefinition, original: TaskEntry, onBack: () => void, language: SettingsLanguage = "zh-CN", maintenance: readonly Readonly<MaintenanceActivity>[] = [], onStopUpgrade?: () => Promise<void> | void): void {
  const entry = taskEntryWithMaintenance(original, maintenance);
  const activity = maintenanceActivityForTask(original, maintenance), title = activity ? maintenanceTaskTitle(activity, language === "en") : entry.title;
  disposeOriginControls(root); root.empty();
  const header = root.createDiv({ cls: "echoink-task-detail-header" });
  taskIconButton(header, language === "en" ? "Back to tasks" : "返回任务列表", "arrow-left", onBack);
  renderTaskAvatar(header, agent);
  const titles = header.createDiv({ cls: "echoink-task-detail-titles" });
  titles.createDiv({ cls: "echoink-task-detail-title", text: title, attr: { title } });
  const completed = taskState(entry) === "completed";
  const at = completed ? entry.taskCompletedAt ?? entry.updatedAt : entry.taskInterruptedAt;
  titles.createDiv({ cls: "echoink-task-detail-subtitle", text: `${agent.name}${at !== undefined ? ` · ${localDateLabel(at, Date.now(), language)} ${localTaskTime(at)}` : ""}` });
  if (activity?.taskKind === "upgrade" && taskState(entry) === "running" && onStopUpgrade) {
    const stop = taskIconButton(header, language === "en" ? "Stop upgrade" : "停止升级", "square", () => {});
    applyAmicroButton(stop, { variant: "secondary" });
    stop.onclick = async () => {
      if (stop.disabled) return;
      stop.disabled = true; setAmicroButtonPending(stop, true);
      try { await onStopUpgrade(); } finally { stop.disabled = false; setAmicroButtonPending(stop, false); }
    };
  }
  header.createSpan({ cls: `echoink-task-card-status is-${taskState(entry)}`, text: taskStateLabel(entry, language) });
}
const entered = new WeakMap<HTMLElement, number>();
export function animateTaskDetailEntry(root: HTMLElement, navigationToken: number): void {
  if (entered.get(root) === navigationToken) return;
  entered.set(root, navigationToken);
  if (root.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  root.animate?.([{ transform: "translateX(16px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 160, easing: "ease-out" });
}
