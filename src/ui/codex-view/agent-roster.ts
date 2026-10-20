import { setIcon } from "obsidian";
import type { SettingsLanguage } from "../../settings/settings";
import type { AgentDefinition } from "../../agents/types";
import { agentTaskCounts, type TaskEntry } from "../../agents/task-presentation";
import { createOriginButton, disposeOriginControls } from "../../settings/origin-controls";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";

export function renderTaskAvatar(root: HTMLElement, agent: AgentDefinition, size = 26): void {
  const avatar = root.createSpan({ cls: "echoink-task-avatar", attr: { "aria-hidden": "true" } });
  avatar.style.width = avatar.style.height = `${size}px`;
  const url = resolveAgentAvatarUrl(agent.avatar);
  if (url) avatar.createEl("img", { attr: { src: url, alt: "", draggable: "false" } });
  else setIcon(avatar, "bot");
}
export function taskIconButton(root: HTMLElement, label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const button = createOriginButton(root, { cls: "echoink-task-icon", attr: { type: "button", "aria-label": label, title: label, "data-variant": "icon" } });
  setIcon(button, icon); button.onclick = onClick; return button;
}
export function renderAgentRoster(root: HTMLElement, agents: readonly AgentDefinition[], entries: readonly TaskEntry[], selected: string,
  actions: { onSelect(id: string): void; onCreate(): void }, language: SettingsLanguage = "zh-CN"): void {
  const scrollLeft = root.scrollLeft;
  const previousSelection = root.dataset.selectedAgent;
  const focused = root.contains(root.ownerDocument.activeElement)
    ? (root.ownerDocument.activeElement as HTMLElement).dataset.agentId : undefined;
  disposeOriginControls(root); root.empty(); root.className = "echoink-agent-roster";
  for (const agent of agents) {
    const counts = agentTaskCounts(entries, agent.id);
    const label = language === "en" ? `${agent.name}, ${counts.total} tasks, ${counts.waiting} waiting, ${counts.interrupted} interrupted, ${counts.running} running, ${counts.unread} new results` : `${agent.name}，${counts.total}件事，${counts.waiting}件等你回应，${counts.interrupted}件已中断，${counts.running}件进行中，${counts.unread}件有新结果`;
    const button = createOriginButton(root, { cls: `echoink-agent-roster-item${agent.id === selected ? " is-selected" : ""}`,
      attr: { type: "button", title: label, "aria-label": label, "aria-pressed": agent.id === selected, "data-agent-id": agent.id } });
    renderTaskAvatar(button, agent, 28);
    if (counts.waiting) button.createSpan({ cls: "echoink-agent-badge is-waiting", text: String(counts.waiting) });
    else if (counts.interrupted) button.createSpan({ cls: "echoink-agent-badge is-interrupted", text: "!" });
    else if (counts.running) setIcon(button.createSpan({ cls: "echoink-agent-badge is-running" }), "loader-circle");
    else if (counts.unread) button.createSpan({ cls: "echoink-agent-badge is-unread" });
    button.onclick = () => actions.onSelect(agent.id);
  }
  const add = taskIconButton(root, language === "en" ? "Create Agent" : "新建 Agent", "plus", () => actions.onCreate()); add.classList.add("echoink-agent-add");
  root.scrollLeft = scrollLeft; root.dataset.selectedAgent = selected;
  if (previousSelection !== selected) Array.from(root.querySelectorAll<HTMLButtonElement>("[data-agent-id]")).find(button => button.dataset.agentId === selected)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (focused) Array.from(root.querySelectorAll<HTMLButtonElement>("[data-agent-id]")).find(button => button.dataset.agentId === focused)?.focus({ preventScroll: true });
}
