import type { EditorActionStatus } from "./types";

export type EditorActionResultKind = "success" | "failed" | "canceled" | "timeout";

export function editorActionStatusFromResult(result: EditorActionResultKind): EditorActionStatus {
  if (result === "success") return "awaiting-confirm";
  if (result === "canceled") return "canceled";
  return "failed";
}

export function editorActionStartBlockReason(input: {
  running: boolean;
  activeRunId?: string;
  activeTurnId?: string;
  hasEditorActionRun?: boolean;
}): string | null {
  if (!input.running) return null;
  if (!input.activeRunId && !input.activeTurnId && !input.hasEditorActionRun) return null;
  return "Agent 正在处理上一轮，请稍后再试";
}

export interface EditorActionNotificationIds {
  threadId: string;
  turnId: string;
  itemId: string;
}

export function extractEditorActionNotificationIds(params: any): EditorActionNotificationIds {
  return {
    threadId: firstString(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId),
    turnId: firstString(params?.turnId, params?.turn?.id, params?.item?.turnId),
    itemId: firstString(params?.itemId, params?.item?.id)
  };
}

export function isEditorActionHiddenNotification(input: {
  params: any;
  threadIds: ReadonlySet<string>;
  turnIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
}): boolean {
  const ids = extractEditorActionNotificationIds(input.params);
  return Boolean(
    (ids.threadId && input.threadIds.has(ids.threadId)) ||
    (ids.turnId && input.turnIds.has(ids.turnId)) ||
    (ids.itemId && input.itemIds.has(ids.itemId))
  );
}

export function isEditorActionCurrentRunNotification(input: {
  params: any;
  currentThreadId?: string;
  currentTurnId?: string;
  threadIds: ReadonlySet<string>;
  turnIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
  currentItemIds?: ReadonlySet<string>;
  allowUnscoped?: boolean;
}): boolean {
  const ids = extractEditorActionNotificationIds(input.params);
  if (!ids.threadId && !ids.turnId && !ids.itemId) return Boolean(input.allowUnscoped);
  if (ids.itemId && input.itemIds.has(ids.itemId) && !input.currentItemIds?.has(ids.itemId)) return false;
  return Boolean(
    (ids.threadId && ids.threadId === input.currentThreadId) ||
    (ids.turnId && ids.turnId === input.currentTurnId) ||
    (ids.itemId && input.currentItemIds?.has(ids.itemId))
  );
}

export interface EditorActionNotificationRouteInput {
  method: string;
  params: any;
  active: boolean;
  currentThreadId?: string;
  currentTurnId?: string;
  threadIds: ReadonlySet<string>;
  turnIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
  currentItemIds?: ReadonlySet<string>;
  allowUnscoped?: boolean;
}

export interface EditorActionNotificationRoute {
  swallow: boolean;
  current: boolean;
  collectAssistantDelta: boolean;
  rememberCurrentItem: boolean;
}

export function routeEditorActionNotification(input: EditorActionNotificationRouteInput): EditorActionNotificationRoute {
  const ids = extractEditorActionNotificationIds(input.params);
  const hidden = isEditorActionHiddenNotification({
    params: input.params,
    threadIds: input.threadIds,
    turnIds: input.turnIds,
    itemIds: input.itemIds
  });
  const current = input.active && isEditorActionCurrentRunNotification({
    params: input.params,
    currentThreadId: input.currentThreadId,
    currentTurnId: input.currentTurnId,
    threadIds: input.threadIds,
    turnIds: input.turnIds,
    itemIds: input.itemIds,
    currentItemIds: input.currentItemIds,
    allowUnscoped: input.allowUnscoped
  });
  const canAdoptAssistantDelta = Boolean(
    input.active &&
    input.method === "item/agentMessage/delta" &&
    ids.itemId &&
    !input.itemIds.has(ids.itemId)
  );
  const effectiveCurrent = current || canAdoptAssistantDelta;
  const hiddenMethod = isEditorActionStreamMethod(input.method);
  const swallow = hidden || effectiveCurrent || (input.active && hiddenMethod);
  return {
    swallow,
    current: effectiveCurrent,
    collectAssistantDelta: effectiveCurrent && input.method === "item/agentMessage/delta",
    rememberCurrentItem: canAdoptAssistantDelta
  };
}

function isEditorActionStreamMethod(method: string): boolean {
  return method.startsWith("thread/") || method.startsWith("turn/") || method.startsWith("item/") || method === "error";
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
