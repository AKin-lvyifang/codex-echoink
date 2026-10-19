import { setIcon } from "obsidian";
import type { AgentDefinition, AgentModuleId } from "../../agents/types";
import type { MobileSession } from "../../mobile/store";
import { resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { shellElement } from "../mobile/shell-controls";

export const iphoneElement = shellElement;
export const IPHONE_MODULES: readonly { id: AgentModuleId; name: string; icon: string }[] = [
  { id: "journal", name: "日记", icon: "book-open" }, { id: "todos", name: "待办", icon: "list-todo" },
  { id: "finance", name: "财务", icon: "wallet" }, { id: "knowledge-base", name: "知识库", icon: "library" },
  { id: "english-diary", name: "英文日记", icon: "languages" }, { id: "pdf-reading", name: "PDF 精读", icon: "file-text" }
];

export function iphoneIcon(document: Document, name: string): HTMLElement {
  const element = shellElement(document, "span", "ip-icon");
  element.setAttribute("aria-hidden", "true"); setIcon(element, name); return element;
}

export function iphoneButton(document: Document, text: string, action: () => void, variant = "", icon?: string): HTMLButtonElement {
  const button = shellElement(document, "button", `ip-button ${variant}`.trim()); button.type = "button";
  const visible = shellElement(document, "span", "ip-button-visible");
  if (icon) visible.append(iphoneIcon(document, icon));
  visible.append(shellElement(document, "span", "", text)); button.append(visible);
  button.addEventListener("click", event => { event.stopPropagation(); action(); }); return button;
}

export function iphoneAvatar(document: Document, agent: Pick<AgentDefinition, "name" | "avatar">, className = "ip-avatar"): HTMLElement {
  const url = resolveAgentAvatarUrl(agent.avatar);
  if (url) { const image = shellElement(document, "img", className); image.src = url; image.alt = ""; return image; }
  const avatar = shellElement(document, "span", `${className} ip-avatar-default`);
  avatar.append(iphoneIcon(document, "bot")); avatar.setAttribute("aria-hidden", "true"); return avatar;
}

export function iphoneTasks(sessions: readonly MobileSession[]): MobileSession[] {
  return sessions.filter(task => !task.archivedAt && (!!task.taskStatus || task.messages.length > 0));
}
export function iphoneTaskStatus(task: MobileSession): NonNullable<MobileSession["taskStatus"]> { return task.taskStatus ?? "completed"; }
export function iphoneTaskUnread(task: MobileSession): boolean { return (task.unreadAnswerAt ?? 0) > (task.lastReadAt ?? 0); }
export function iphoneTaskTime(task: MobileSession): number { return task.taskCompletedAt ?? task.updatedAt; }

export function iphoneDateGroup(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now), yesterday = new Date(now); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return `${date.getFullYear() === today.getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}
export function iphoneClock(at: number): string { return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); }

export function iphoneTaskSummary(task: MobileSession): string {
  const status = iphoneTaskStatus(task);
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

export function iphoneStatus(document: Document, task: MobileSession): HTMLElement {
  const status = iphoneTaskStatus(task), element = shellElement(document, "span", `ip-status is-${status}`);
  if (status === "completed") {
    if (iphoneTaskUnread(task)) { const dot = shellElement(document, "span", "ip-dot"); dot.setAttribute("aria-label", "有新结果"); element.append(dot); }
    element.append(shellElement(document, "span", "", iphoneClock(iphoneTaskTime(task))));
  } else {
    const icon = status === "waiting" ? "hand" : status === "interrupted" ? "circle-pause" : "loader-circle";
    let label = status === "waiting" ? "等你回应" : status === "interrupted" ? "已中断" : "正在进行";
    const start = task.runs?.at(-1)?.startedAt ?? task.taskStartedAt;
    if (status === "running" && start) {
      const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      label = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
    }
    element.append(iphoneIcon(document, icon), shellElement(document, "span", "", label));
  }
  return element;
}

/** Excludes streamed text: changing a token must not remount a question being answered. */
export function iphoneTaskProjection(tasks: readonly MobileSession[]): string {
  return JSON.stringify(tasks.map(task => [task.id, task.agentId, task.title, task.taskStatus, task.taskStage,
    task.taskCompletedAt, task.taskInterruptedAt, task.unreadAnswerAt, task.lastReadAt, task.messages.length,
    task.interaction?.questionId, task.interaction?.status, task.pendingResponse, task.interruption]));
}
