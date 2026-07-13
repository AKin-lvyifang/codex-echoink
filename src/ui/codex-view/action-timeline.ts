import type { ChatMessage, DiffSummary } from "../../settings/settings";
import type { ProcessFileRef } from "../../types/app-server";

export type ActionGroupKind =
  | "read"
  | "search"
  | "command"
  | "edit"
  | "tool"
  | "agent"
  | "plan"
  | "verify"
  | "system";

export type ActionStatus = "running" | "completed" | "failed" | "blocked" | "canceled";

export interface ActionItemViewModel {
  id: string;
  kind: ActionGroupKind;
  title: string;
  detail?: string;
  status: ActionStatus;
  createdAt: number;
  file?: ProcessFileRef;
  files?: ProcessFileRef[];
  diff?: {
    added?: number;
    removed?: number;
  };
  command?: {
    summary: string;
    durationMs?: number;
    rawRef?: string;
  };
  rawRef?: string;
  source: ChatMessage;
}

export interface ActionGroupViewModel {
  id: string;
  runId: string;
  kind: ActionGroupKind;
  title: string;
  status: ActionStatus;
  count: number;
  items: ActionItemViewModel[];
  defaultExpanded: boolean;
}

export interface ActionTimelineViewModel {
  stateId: string;
  runId: string;
  runStatus: ActionStatus;
  summaryTitle: string;
  summaryDetail: string;
  activeLabel: string;
  totalCount: number;
  countLabels: string[];
  groups: ActionGroupViewModel[];
}

const COUNT_LABELS: Record<ActionGroupKind, string> = {
  read: "读取",
  search: "搜索",
  command: "命令",
  edit: "编辑",
  tool: "工具",
  agent: "智能体",
  plan: "计划",
  verify: "验证",
  system: "系统"
};

export function isActionTimelineItem(message: Pick<ChatMessage, "itemType" | "role">): boolean {
  if (message.itemType === "knowledgeBase") return false;
  if (message.itemType === "reasoning") return false;
  return Boolean(
    message.itemType === "commandExecution" ||
    message.itemType === "fileChange" ||
    message.itemType === "mcpToolCall" ||
    message.itemType === "dynamicToolCall" ||
    message.itemType === "collabAgentToolCall" ||
    message.itemType === "plan" ||
    message.itemType === "contextCompaction"
  );
}

export function buildActionTimeline(messages: ChatMessage[]): ActionTimelineViewModel {
  const items = messages.filter(isActionTimelineItem).map(toActionItem);
  const groups: ActionGroupViewModel[] = [];
  for (const item of items) {
    const previous = groups[groups.length - 1];
    if (previous && canAppendToGroup(previous, item)) {
      previous.items.push(item);
      previous.count = previous.items.length;
      previous.status = statusForItems(previous.items);
      previous.title = titleForGroup(previous.kind, previous.items);
      continue;
    }
    groups.push({
      id: actionGroupId(item),
      runId: item.source.runId ?? "",
      kind: item.kind,
      title: titleForGroup(item.kind, [item]),
      status: item.status,
      count: 1,
      items: [item],
      defaultExpanded: false
    });
  }
  applyDefaultExpanded(groups);
  const runId = items.find((item) => item.source.runId)?.source.runId ?? "";
  const runStatus = statusForItems(items);
  const countLabelsValue = countLabels(items);
  return {
    stateId: actionTimelineStateId(items),
    runId,
    runStatus,
    summaryTitle: actionSummaryTitle(items.length),
    summaryDetail: countLabelsValue.join(" · "),
    activeLabel: activeLabelForItems(items, runStatus),
    totalCount: items.length,
    countLabels: countLabelsValue,
    groups
  };
}

function toActionItem(message: ChatMessage): ActionItemViewModel {
  const kind = actionKindForMessage(message);
  const commandSummary = kind === "command" ? commandSummaryForMessage(message) : "";
  const diff = diffForMessage(message.diffSummary);
  return {
    id: message.id,
    kind,
    title: actionTitleForMessage(message, kind, commandSummary),
    detail: message.details || undefined,
    status: normalizeStatus(message.status),
    createdAt: message.createdAt,
    file: primaryFileForMessage(message),
    files: message.files,
    diff,
    command: kind === "command"
      ? {
        summary: commandSummary || message.details || message.title || "命令",
        rawRef: message.rawRef
      }
      : undefined,
    rawRef: message.rawRef,
    source: message
  };
}

function actionKindForMessage(message: ChatMessage): ActionGroupKind {
  if (message.itemType === "contextCompaction") return "system";
  if (message.itemType === "plan" || message.processKind === "plan") return "plan";
  if (message.itemType === "fileChange" || message.processKind === "edit") return "edit";
  if (message.itemType === "collabAgentToolCall") return "agent";
  if (message.processKind === "search") return "search";
  if (message.processKind === "view") return "read";
  if (message.itemType === "commandExecution" || message.processKind === "run" || message.processKind === "command") return "command";
  if (message.itemType === "mcpToolCall" || message.itemType === "dynamicToolCall" || message.processKind === "tool") return "tool";
  return "system";
}

function actionTitleForMessage(message: ChatMessage, kind: ActionGroupKind, commandSummary: string): string {
  if (kind === "command" && commandSummary) return `已运行 ${commandSummary}`;
  if (kind === "edit" && message.diffSummary?.files.length === 1) return `已编辑 ${message.diffSummary.files[0].path}`;
  if (kind === "read" && message.files?.[0]) return `已读取 ${message.files[0].name}`;
  if (kind === "search") return message.details || message.title || "已搜索";
  if (kind === "agent") return message.status === "failed" || message.status === "error" ? "创建智能体失败" : message.title || "智能体动作";
  return message.title || fallbackActionTitle(kind);
}

function fallbackActionTitle(kind: ActionGroupKind): string {
  const labels: Record<ActionGroupKind, string> = {
    read: "已读取文件",
    search: "已搜索",
    command: "已运行命令",
    edit: "已编辑文件",
    tool: "已调用工具",
    agent: "智能体动作",
    plan: "更新计划",
    verify: "运行验证",
    system: "系统动作"
  };
  return labels[kind];
}

function canAppendToGroup(group: ActionGroupViewModel, item: ActionItemViewModel): boolean {
  return group.kind === item.kind && group.runId === (item.source.runId ?? "") && sameStatusFamily(group.status, item.status);
}

function sameStatusFamily(a: ActionStatus, b: ActionStatus): boolean {
  if (a === "failed" || b === "failed") return a === b;
  if (a === "blocked" || b === "blocked") return a === b;
  if (a === "canceled" || b === "canceled") return a === b;
  return true;
}

function statusForItems(items: ActionItemViewModel[]): ActionStatus {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "canceled")) return "canceled";
  return "completed";
}

function normalizeStatus(status: string | undefined): ActionStatus {
  if (status === "running" || status === "in_progress" || status === "inProgress") return "running";
  if (status === "error" || status === "failed") return "failed";
  if (status === "blocked" || status === "approval") return "blocked";
  if (status === "canceled" || status === "cancelled" || status === "interrupted") return "canceled";
  return "completed";
}

function applyDefaultExpanded(groups: ActionGroupViewModel[]): void {
  const target = groups.find((group) => group.status === "failed") ?? groups.find((group) => group.status === "running" || group.status === "blocked");
  for (const group of groups) group.defaultExpanded = group === target;
}

function actionTimelineStateId(items: ActionItemViewModel[]): string {
  const first = items[0];
  const runId = first?.source.runId;
  if (runId) return `run:${runId}`;
  return `run:${first?.id ?? "empty"}`;
}

function actionSummaryTitle(count: number): string {
  return count === 1 ? "已处理 1 个动作" : `已处理 ${count} 个动作`;
}

function activeLabelForItems(items: ActionItemViewModel[], status: ActionStatus): string {
  const active = items.slice().reverse().find((item) => item.status === "running" || item.status === "blocked") ?? items[items.length - 1];
  if (!active) return "";
  if (status === "failed") {
    const failed = items.slice().reverse().find((item) => item.status === "failed") ?? active;
    return liveLabelForItem(failed, "failed");
  }
  if (status === "running" || status === "blocked") return liveLabelForItem(active, status);
  if (status === "canceled") return "过程已中断";
  return actionSummaryTitle(items.length);
}

function liveLabelForItem(item: ActionItemViewModel, status: ActionStatus): string {
  const target = actionTarget(item);
  const suffix = target ? ` ${target}` : "";
  if (status === "failed") {
    if (item.kind === "command") return `命令失败${suffix}`;
    if (item.kind === "edit") return `文件改动失败${suffix}`;
    if (item.kind === "agent") return `智能体动作失败${suffix}`;
    return `动作失败${suffix}`;
  }
  if (status === "blocked") return `等待确认${suffix}`;
  if (item.kind === "read") return `正在读取${suffix}`;
  if (item.kind === "search") return `正在检索${suffix}`;
  if (item.kind === "command") return `正在运行${suffix}`;
  if (item.kind === "edit") return `正在整理文件改动${suffix}`;
  if (item.kind === "tool") return `正在调用工具${suffix}`;
  if (item.kind === "agent") return `正在等待智能体${suffix}`;
  if (item.kind === "plan") return "正在更新计划";
  if (item.kind === "verify") return `正在验证${suffix}`;
  return `正在处理${suffix}`;
}

function actionTarget(item: ActionItemViewModel): string {
  if (item.kind === "command" && item.command?.summary) return trimActionTarget(item.command.summary);
  if (item.kind === "edit" && item.source.diffSummary?.files.length) return trimActionTarget(item.source.diffSummary.files[0].path);
  if (item.file) return trimActionTarget(item.file.name || item.file.displayPath || item.file.path);
  if (item.detail) return trimActionTarget(item.detail);
  if (item.title) return trimActionTarget(item.title.replace(/^已运行\s+/, "").replace(/^已读取\s+/, ""));
  return "";
}

function trimActionTarget(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 64 ? `${normalized.slice(0, 63)}…` : normalized;
}

function countLabels(items: ActionItemViewModel[]): string[] {
  const counts = new Map<ActionGroupKind, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return (Object.keys(COUNT_LABELS) as ActionGroupKind[])
    .filter((kind) => counts.has(kind))
    .map((kind) => `${COUNT_LABELS[kind]} ${counts.get(kind)}`);
}

function titleForGroup(kind: ActionGroupKind, items: ActionItemViewModel[]): string {
  const count = items.length;
  if (kind === "read") {
    const fileCount = uniqueFileCount(items);
    return `已读取 ${fileCount || count} 个文件`;
  }
  if (kind === "search") return `搜索了 ${count} 次`;
  if (kind === "command") return count > 1 ? "运行了多个命令" : "已运行命令";
  if (kind === "edit") {
    const fileCount = uniqueFileCount(items);
    return `已编辑 ${fileCount || count} 个文件`;
  }
  if (kind === "tool") return `调用了 ${count} 个工具`;
  if (kind === "agent") return items.some((item) => item.status === "failed") ? `创建失败 ${count} 个智能体` : `处理了 ${count} 个智能体动作`;
  if (kind === "plan") return count === 1 ? "更新了计划" : `更新了 ${count} 次计划`;
  if (kind === "verify") return `运行了 ${count} 个验证`;
  return count === 1 ? "系统动作" : `${count} 个系统动作`;
}

function uniqueFileCount(items: ActionItemViewModel[]): number {
  const paths = new Set<string>();
  for (const item of items) {
    for (const file of item.files ?? []) paths.add(file.displayPath || file.path || file.name);
  }
  return paths.size;
}

function diffForMessage(diffSummary: DiffSummary | undefined): ActionItemViewModel["diff"] | undefined {
  if (!diffSummary) return undefined;
  return {
    added: diffSummary.added,
    removed: diffSummary.removed
  };
}

function primaryFileForMessage(message: ChatMessage): ProcessFileRef | undefined {
  return message.files?.[0];
}

function commandSummaryForMessage(message: ChatMessage): string {
  const text = message.details || message.text || "";
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  const withoutPrefix = firstLine.replace(/^已运行\s+/, "").replace(/^\$\s*/, "");
  return withoutPrefix.length > 96 ? `${withoutPrefix.slice(0, 95)}…` : withoutPrefix;
}

function actionGroupId(item: ActionItemViewModel): string {
  return `action:${item.source.runId ?? "none"}:${item.kind}:${item.id}`;
}
