import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import type { EchoInkTurnInteraction } from "../types/conversation-turn";
import type { SettingsLanguage } from "../settings/settings";
import type { StoredSession } from "../settings/settings";
import { GENERAL_ASSISTANT_ID } from "./types";
import type { ConversationTaskStatus } from "./task-metadata";

export type TaskEntry = Readonly<PiConversationCatalogEntry>;
export function isUserTask(entry: TaskEntry): boolean {
  return entry.status !== "deleted" && !entry.conversationId.startsWith("knowledge-linking-");
}
export function taskState(entry: TaskEntry): ConversationTaskStatus {
  return entry.pendingResponse ? "waiting" : entry.taskStatus ?? "interrupted";
}
export function taskStateLabel(entry: TaskEntry, language: SettingsLanguage = "zh-CN"): string {
  return (language === "en" ? { waiting: "Waiting for you", running: "In progress", interrupted: "Interrupted", completed: "Completed" }
    : { waiting: "等你回应", running: "进行中", interrupted: "已中断", completed: "已完成" })[taskState(entry)];
}
export function taskActivityAt(entry: TaskEntry): number {
  return Math.max(entry.updatedAt, entry.taskStartedAt ?? 0, entry.taskCompletedAt ?? 0, entry.taskInterruptedAt ?? 0);
}
export function localDateLabel(at: number, now = Date.now(), language: SettingsLanguage = "zh-CN"): string {
  const date = new Date(at), current = new Date(now);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (key(date) === key(current)) return language === "en" ? "Today" : "今天";
  current.setDate(current.getDate() - 1);
  if (key(date) === key(current)) return language === "en" ? "Yesterday" : "昨天";
  if (language === "en") return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" as const } : {}) }).format(date);
  return `${date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日`;
}
export function localTaskTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
export function taskSummary(entry: TaskEntry, session?: Pick<StoredSession, "messages">, language: SettingsLanguage = "zh-CN", pending?: Readonly<EchoInkTurnInteraction>): string {
  const state = taskState(entry), messages = session?.messages ?? [];
  if (state === "waiting") {
    if (pending?.conversationId === entry.conversationId && pending.turnId === entry.pendingResponse?.runId) {
      if (pending.kind === "question") return pending.questions[pending.activeQuestionIndex ?? 0]?.prompt ?? taskStateLabel(entry, language);
      return pending.preview ?? pending.target ?? taskStateLabel(entry, language);
    }
    const waiting = [...messages].reverse().find(message => message.runId === entry.pendingResponse?.runId && message.approval?.status === "pending");
    return waiting?.approval?.preview ?? waiting?.approval?.target ?? taskStateLabel(entry, language);
  }
  if (state === "running") {
    const nodes = [...messages].reverse().flatMap(message => [...(message.assistantTurn?.processNodes ?? [])].reverse());
    const node = nodes.find(node => node.status === "running");
    return node?.summary ?? node?.title ?? entry.taskStage ?? taskStateLabel(entry, language);
  }
  if (state === "interrupted") {
    const latest = [...messages].reverse().find(message => message.assistantTurn?.processNodes?.length)?.assistantTurn?.processNodes?.at(-1);
    return (entry.taskStage || latest?.title)?.replace(/\s+/gu, " ").trim() || taskStateLabel(entry, language);
  }
  const answer = [...messages].reverse().find(message => message.text.trim() && message.role === "assistant");
  return answer?.text.replace(/\s+/gu, " ").trim() || taskStateLabel(entry, language);
}

export function groupAgentTasks(entries: readonly TaskEntry[], agentId: string, now = Date.now(), language: SettingsLanguage = "zh-CN"): { label: string; tasks: TaskEntry[] }[] {
  const tasks = entries.filter(entry => isUserTask(entry) && (entry.agentId ?? GENERAL_ASSISTANT_ID) === agentId);
  const groups: { label: string; tasks: TaskEntry[] }[] = [];
  const active = tasks.filter(entry => taskState(entry) !== "completed").sort((a, b) => taskActivityAt(b) - taskActivityAt(a));
  if (active.length) groups.push({ label: language === "en" ? "In progress" : "进行中", tasks: active });
  for (const entry of tasks.filter(entry => taskState(entry) === "completed").sort((a, b) => (b.taskCompletedAt ?? b.updatedAt) - (a.taskCompletedAt ?? a.updatedAt))) {
    const label = localDateLabel(entry.taskCompletedAt ?? entry.updatedAt, now, language);
    let group = groups.find(group => group.label === label);
    if (!group) { group = { label, tasks: [] }; groups.push(group); }
    group.tasks.push(entry);
  }
  return groups;
}
export function agentTaskCounts(entries: readonly TaskEntry[], agentId: string) {
  const tasks = entries.filter(entry => isUserTask(entry) && (entry.agentId ?? GENERAL_ASSISTANT_ID) === agentId);
  return { total: tasks.length, waiting: tasks.filter(e => taskState(e) === "waiting").length,
    interrupted: tasks.filter(e => taskState(e) === "interrupted").length, running: tasks.filter(e => taskState(e) === "running").length,
    unread: tasks.filter(e => e.unreadAnswerAt !== undefined).length };
}
