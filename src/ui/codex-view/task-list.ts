import { setIcon, setTooltip } from "obsidian";
import type { AgentDefinition } from "../../agents/types";
import { agentDisplayTitle, agentPositionDescription } from "../../agents/identity";
import { agentTaskCounts, groupAgentTasks, localTaskTime, taskCardHintSummary, taskState, taskStateLabel, taskSummary, type TaskEntry } from "../../agents/task-presentation";
import type { SettingsLanguage, StoredSession } from "../../settings/settings";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { renderTaskAvatar, taskIconButton } from "./agent-roster";

export function renderAgentTaskList(root: HTMLElement, agent: AgentDefinition, entries: readonly TaskEntry[], sessions: readonly StoredSession[],
  actions: { onTask(id: string): void; onEdit(): void; onTaskMenu?(event: MouseEvent, taskId: string): void; onSessionMenu?(event: MouseEvent, session: StoredSession): void; summary?(entry: TaskEntry): string | undefined; status?(entry: TaskEntry): string | undefined;
    /** General assistant only: split cards into 项目 (bound to a project) and 日常. */
    section?(entry: TaskEntry): "project" | "chat" }, now = Date.now(), language: SettingsLanguage = "zh-CN"): void {
  const prior = root.querySelector<HTMLElement>(".echoink-task-list-items");
  const scrollTop = prior?.scrollTop ?? 0;
  const focused = root.contains(root.ownerDocument.activeElement) ? (root.ownerDocument.activeElement as HTMLElement)?.dataset.taskId : undefined;
  disposeOriginControls(root); root.empty();
  const header = root.createDiv({ cls: "echoink-agent-list-header" });
  renderTaskAvatar(header, agent);
  const copy = header.createDiv({ cls: "echoink-agent-list-identity" });
  copy.createDiv({ cls: "echoink-agent-name", text: agentDisplayTitle(agent, language) });
  const description = agentPositionDescription(agent);
  if (description) copy.createDiv({ cls: "echoink-agent-position", text: description });
  header.createSpan({ cls: "echoink-agent-task-count", text: language === "en" ? `${agentTaskCounts(entries, agent.id).total} tasks` : `${agentTaskCounts(entries, agent.id).total} 件事` });
  taskIconButton(header, language === "en" ? "Edit Agent" : "编辑 Agent", "ellipsis", () => actions.onEdit());
  const list = root.createDiv({ cls: "echoink-task-list-items" });
  const groups = groupAgentTasks(entries, agent.id, now, language);
  if (!groups.length) list.createDiv({ cls: "echoink-task-empty", text: language === "en" ? `No tasks assigned to ${agent.name} yet.` : `还没有交给 ${agent.name} 的事。` });
  const card = (entry: TaskEntry, kind?: "project" | "chat") => {
      const summary = actions.summary?.(entry) ?? taskSummary(entry, sessions.find(session => session.id === entry.conversationId), language);
      const hintSummary = taskCardHintSummary(summary);
      const status = actions.status?.(entry) ?? (taskState(entry) === "completed" ? localTaskTime(entry.taskCompletedAt ?? entry.updatedAt) : taskStateLabel(entry, language));
      const button = createOriginButton(list, { cls: "echoink-task-card", attr: {
        type: "button", "data-task-id": entry.conversationId,
        "aria-description": `${status}${entry.unreadAnswerAt !== undefined ? language === "en" ? ", new result" : "，有新结果" : ""}`
      } });
      setTooltip(button, `${entry.title}\n${hintSummary}`, { classes: ["echoink-task-card-tooltip"] });
      const line = button.createSpan({ cls: "echoink-task-card-line" });
      if (kind) setIcon(line.createSpan({ cls: "echoink-task-card-kind", attr: { "aria-hidden": "true" } }), kind === "project" ? "briefcase" : "message-circle");
      line.createSpan({ cls: "echoink-task-card-title", text: entry.title });
      if (entry.unreadAnswerAt !== undefined) line.createSpan({ cls: "echoink-task-unread", attr: { "aria-hidden": "true" } });
      line.createSpan({ cls: `echoink-task-card-status is-${taskState(entry)}`, text: status });
      button.createSpan({ cls: "echoink-task-card-summary", text: summary });
      button.onclick = () => actions.onTask(entry.conversationId);
      const session = sessions.find(session => session.id === entry.conversationId);
      if (actions.onTaskMenu) button.oncontextmenu = event => actions.onTaskMenu?.(event, entry.conversationId);
      else if (session && actions.onSessionMenu) button.oncontextmenu = event => actions.onSessionMenu?.(event, session);
  };
  const sectionOf = actions.section ? (entry: TaskEntry) => actions.section!(entry) : undefined;
  if (!sectionOf) {
    for (const group of groups) { list.createEl("h3", { cls: "echoink-task-group-label", text: group.label }); for (const entry of group.tasks) card(entry); }
  } else {
    // 项目 first, newest activity first; 日常 keeps the existing day groups.
    const projects = groups.flatMap(group => group.tasks).filter(entry => sectionOf(entry) === "project");
    const heading = (kind: "project" | "chat", count: number) => {
      const head = list.createEl("h3", { cls: "echoink-task-section-label" });
      setIcon(head.createSpan({ attr: { "aria-hidden": "true" } }), kind === "project" ? "briefcase" : "message-circle");
      head.createSpan({ text: kind === "project" ? (language === "en" ? "Projects" : "项目") : (language === "en" ? "Daily" : "日常") });
      head.createSpan({ cls: "echoink-task-section-count", text: String(count) });
    };
    if (projects.length) { heading("project", projects.length); for (const entry of projects) card(entry, "project"); }
    const daily = groups.map(group => ({ label: group.label, tasks: group.tasks.filter(entry => sectionOf(entry) === "chat") })).filter(group => group.tasks.length);
    if (daily.length) {
      heading("chat", daily.reduce((n, group) => n + group.tasks.length, 0));
      for (const group of daily) { list.createEl("h3", { cls: "echoink-task-group-label", text: group.label }); for (const entry of group.tasks) card(entry, "chat"); }
    }
  }
  list.scrollTop = scrollTop;
  if (focused) Array.from(list.querySelectorAll<HTMLButtonElement>("[data-task-id]")).find(button => button.dataset.taskId === focused)?.focus({ preventScroll: true });
}
