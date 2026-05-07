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
  return "Codex 正在处理上一轮，请稍后再试";
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
  return Boolean(
    (ids.threadId && ids.threadId === input.currentThreadId) ||
    (ids.turnId && ids.turnId === input.currentTurnId) ||
    (ids.itemId && input.currentItemIds?.has(ids.itemId))
  );
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
