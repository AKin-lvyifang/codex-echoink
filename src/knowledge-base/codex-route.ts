export interface KnowledgeBaseCodexRouteState {
  threadId: string;
  turnId: string;
  itemIds: ReadonlySet<string>;
}

export interface KnowledgeBaseCodexRoute {
  swallow: boolean;
  collectAssistantDelta: boolean;
  rememberItemId?: string;
}

export function routeKnowledgeBaseCodexNotification(method: string, params: any, state: KnowledgeBaseCodexRouteState): KnowledgeBaseCodexRoute {
  const ids = extractKnowledgeBaseNotificationIds(params);
  const exact = isKnowledgeBaseScopedNotification(method, ids, state);
  const orphanAssistantItem = Boolean(
    ids.itemId &&
    !ids.threadId &&
    !ids.turnId &&
    method.startsWith("item/")
  );
  const swallow = exact || orphanAssistantItem;
  return {
    swallow,
    collectAssistantDelta: swallow && method === "item/agentMessage/delta",
    ...(swallow && ids.itemId && !state.itemIds.has(ids.itemId) ? { rememberItemId: ids.itemId } : {})
  };
}

export function extractKnowledgeBaseNotificationIds(params: any): { threadId: string; turnId: string; itemId: string } {
  return {
    threadId: firstString(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId),
    turnId: firstString(params?.turnId, params?.turn?.id, params?.item?.turnId),
    itemId: firstString(params?.itemId, params?.item?.id)
  };
}

function firstString(...values: any[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isKnowledgeBaseScopedNotification(
  method: string,
  ids: { threadId: string; turnId: string; itemId: string },
  state: KnowledgeBaseCodexRouteState
): boolean {
  if (ids.itemId && state.itemIds.has(ids.itemId)) {
    if (ids.threadId && ids.threadId !== state.threadId) return false;
    if (ids.turnId) return state.turnId ? ids.turnId === state.turnId : ids.threadId === state.threadId;
    if (ids.threadId) return ids.threadId === state.threadId;
    return true;
  }
  if (ids.turnId) {
    if (state.turnId) return ids.turnId === state.turnId;
    return method === "turn/started" && ids.threadId === state.threadId;
  }
  if (!ids.threadId || ids.threadId !== state.threadId) return false;
  if (method.startsWith("turn/") && state.turnId && ids.turnId) return false;
  return true;
}
