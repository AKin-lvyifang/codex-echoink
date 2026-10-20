import { formatMobileDateGroup, formatMobileClock } from "../../mobile/date-display";
import { setIcon } from "obsidian";
import type { AgentDefinition, AgentModuleId } from "../../agents/types";
import type { MobileSession } from "../../mobile/store";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { shellElement } from "../mobile/shell-controls";

export const ipadElement = shellElement;
export const IPAD_MODULES: readonly { id: AgentModuleId; name: string; icon: string }[] = [
  { id: "journal", name: "日记", icon: "book-open" }, { id: "todos", name: "待办", icon: "list-todo" },
  { id: "finance", name: "财务", icon: "wallet" }, { id: "knowledge-base", name: "知识库", icon: "library" },
  { id: "english-diary", name: "英文日记", icon: "languages" }, { id: "pdf-reading", name: "PDF 精读", icon: "file-text" }
];

export function ipadIcon(document: Document, name: string): HTMLElement {
  const element = shellElement(document, "span", "pd-icon");
  element.setAttribute("aria-hidden", "true"); setIcon(element, name); return element;
}

export function ipadButton(document: Document, text: string, action: () => void, variant = "", icon?: string): HTMLButtonElement {
  const button = shellElement(document, "button", `pd-button ${variant}`.trim()); button.type = "button";
  const visible = shellElement(document, "span", "pd-button-visible");
  if (icon) visible.append(ipadIcon(document, icon));
  visible.append(shellElement(document, "span", "", text)); button.append(visible);
  button.addEventListener("click", event => { event.stopPropagation(); action(); }); return button;
}

export function ipadAvatar(document: Document, agent: Pick<AgentDefinition, "name" | "avatar">, className = "pd-avatar"): HTMLElement {
  const url = resolveAgentAvatarUrl(agent.avatar);
  if (url) { const image = shellElement(document, "img", className); image.src = url; image.alt = ""; return image; }
  const avatar = shellElement(document, "span", `${className} pd-avatar-default`);
  avatar.append(ipadIcon(document, "bot")); avatar.setAttribute("aria-hidden", "true"); return avatar;
}

export function ipadTasks(sessions: readonly MobileSession[]): MobileSession[] {
  return sessions.filter(task => !task.archivedAt && (!!task.taskStatus || task.messages.length > 0));
}
export function ipadTaskStatus(task: MobileSession): NonNullable<MobileSession["taskStatus"]> { return task.taskStatus ?? "completed"; }
export function ipadTaskUnread(task: MobileSession): boolean { return (task.unreadAnswerAt ?? 0) > (task.lastReadAt ?? 0); }
export function ipadTaskTime(task: MobileSession): number { return task.taskCompletedAt ?? task.updatedAt; }

export const ipadDateGroup = formatMobileDateGroup;
export const ipadClock = formatMobileClock;

export function ipadTaskSummary(task: MobileSession): string {
  const status = ipadTaskStatus(task);
  if (status === "interrupted") return `停在：${task.interruption?.stage || task.taskStage || "未记录阶段"}`;
  if (status === "waiting") return task.interaction?.questions[0]?.prompt || "等你回应";
  if (status === "running") return task.taskStage || "正在进行";
  for (let index = task.messages.length - 1; index >= 0; index--) {
    const message = task.messages[index] as unknown as { role: string; content?: string | { type: string; text?: string }[] };
    if (message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : message.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("");
    if (text?.trim()) return text.trim();
  }
  return task.taskStage || "";
}

export function ipadStatus(document: Document, task: MobileSession): HTMLElement {
  const status = ipadTaskStatus(task), element = shellElement(document, "span", `pd-status is-${status}`);
  if (status === "completed") {
    if (ipadTaskUnread(task)) { const dot = shellElement(document, "span", "pd-dot"); dot.setAttribute("aria-label", "有新结果"); element.append(dot); }
    element.append(shellElement(document, "span", "", ipadClock(ipadTaskTime(task))));
  } else {
    const icon = status === "waiting" ? "hand" : status === "interrupted" ? "circle-pause" : "loader-circle";
    let label = status === "waiting" ? "等你回应" : status === "interrupted" ? "已中断" : "正在进行";
    const start = task.runs?.at(-1)?.startedAt ?? task.taskStartedAt;
    if (status === "running" && start) {
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      label = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
    }
    element.append(ipadIcon(document, icon), shellElement(document, "span", "", label));
  }
  return element;
}

/** Excludes streamed text: changing a token must not remount a question being answered. */
export function ipadTaskProjection(tasks: readonly MobileSession[]): string {
  return JSON.stringify(tasks.map(task => [task.id, task.agentId, task.title, task.taskStatus, task.taskStage,
    task.taskCompletedAt, task.taskInterruptedAt, task.unreadAnswerAt, task.lastReadAt, task.messages.length,
    task.interaction?.questionId, task.interaction?.status, task.pendingResponse, task.interruption]));
}
