import { setTooltip } from "obsidian";
import type { AgentDefinition } from "../../agents/types";
import { agentTaskCounts, groupAgentTasks, localTaskTime, taskCardHintSummary, taskState, taskStateLabel, taskSummary, type TaskEntry } from "../../agents/task-presentation";
import type { SettingsLanguage, StoredSession } from "../../settings/settings";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { renderTaskAvatar, taskIconButton } from "./agent-roster";

export function renderAgentTaskList(root: HTMLElement, agent: AgentDefinition, entries: readonly TaskEntry[], sessions: readonly StoredSession[],
  actions: { onTask(id: string): void; onEdit(): void; summary?(entry: TaskEntry): string | undefined }, now = Date.now(), language: SettingsLanguage = "zh-CN"): void {
  const prior = root.querySelector<HTMLElement>(".echoink-task-list-items");
  const scrollTop = prior?.scrollTop ?? 0;
  const focused = root.contains(root.ownerDocument.activeElement) ? (root.ownerDocument.activeElement as HTMLElement)?.dataset.taskId : undefined;
  disposeOriginControls(root); root.empty();
  const header = root.createDiv({ cls: "echoink-agent-list-header" });
  renderTaskAvatar(header, agent);
  const copy = header.createDiv({ cls: "echoink-agent-list-identity" });
  copy.createDiv({ cls: "echoink-agent-name", text: agent.name });
  if (agent.position) copy.createDiv({ cls: "echoink-agent-position", text: agent.position });
  header.createSpan({ cls: "echoink-agent-task-count", text: language === "en" ? `${agentTaskCounts(entries, agent.id).total} tasks` : `${agentTaskCounts(entries, agent.id).total} 件事` });
  taskIconButton(header, language === "en" ? "Edit Agent" : "编辑 Agent", "ellipsis", () => actions.onEdit());
  const list = root.createDiv({ cls: "echoink-task-list-items" });
  const groups = groupAgentTasks(entries, agent.id, now, language);
  if (!groups.length) list.createDiv({ cls: "echoink-task-empty", text: language === "en" ? `No tasks assigned to ${agent.name} yet.` : `还没有交给 ${agent.name} 的事。` });
  for (const group of groups) {
    list.createEl("h3", { cls: "echoink-task-group-label", text: group.label });
    for (const entry of group.tasks) {
      const summary = actions.summary?.(entry) ?? taskSummary(entry, sessions.find(session => session.id === entry.conversationId), language);
      const hintSummary = taskCardHintSummary(summary);
      const status = taskState(entry) === "completed" ? localTaskTime(entry.taskCompletedAt ?? entry.updatedAt) : taskStateLabel(entry, language);
      const button = createOriginButton(list, { cls: "echoink-task-card", attr: {
        type: "button", "data-task-id": entry.conversationId,
        "aria-description": `${status}${entry.unreadAnswerAt !== undefined ? language === "en" ? ", new result" : "，有新结果" : ""}`
      } });
      setTooltip(button, `${entry.title}\n${hintSummary}`, { classes: ["echoink-task-card-tooltip"] });
      const line = button.createSpan({ cls: "echoink-task-card-line" });
      line.createSpan({ cls: "echoink-task-card-title", text: entry.title });
      if (entry.unreadAnswerAt !== undefined) line.createSpan({ cls: "echoink-task-unread", attr: { "aria-hidden": "true" } });
      line.createSpan({ cls: `echoink-task-card-status is-${taskState(entry)}`, text: status });
      button.createSpan({ cls: "echoink-task-card-summary", text: summary });
      button.onclick = () => actions.onTask(entry.conversationId);
    }
  }
  list.scrollTop = scrollTop;
  if (focused) Array.from(list.querySelectorAll<HTMLButtonElement>("[data-task-id]")).find(button => button.dataset.taskId === focused)?.focus({ preventScroll: true });
}
