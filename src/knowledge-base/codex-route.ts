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
  const exact = Boolean(
    (ids.threadId && ids.threadId === state.threadId) ||
    (ids.turnId && ids.turnId === state.turnId) ||
    (ids.itemId && state.itemIds.has(ids.itemId))
  );
  const orphanAssistantItem = Boolean(
    ids.itemId &&
    !ids.threadId &&
    !ids.turnId &&
    (method === "item/started" || method === "item/agentMessage/delta")
  );
  const unscopedError = method === "error" && !ids.threadId && !ids.turnId && !ids.itemId;
  const swallow = exact || orphanAssistantItem || unscopedError;
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
