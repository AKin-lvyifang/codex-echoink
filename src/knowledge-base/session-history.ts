import type { ChatMessage, StoredSession } from "../settings/settings";
import { activeKnowledgeBaseMessageDates, localDateKeyForTimestamp } from "./history-store";

export interface KnowledgeBaseClearResult {
  hiddenCount: number;
  hiddenBefore: number;
}

export function getActiveKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "historyActiveDate">, now = Date.now()): ChatMessage[] {
  const activeDates = activeKnowledgeBaseMessageDates(session.messages, session.historyActiveDate, now);
  if (!activeDates.size) return [];
  return session.messages.filter((message) => activeDates.has(localDateKeyForTimestamp(message.createdAt)));
}

export function getVisibleKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore" | "historyActiveDate">, now = Date.now()): ChatMessage[] {
  const activeMessages = getActiveKnowledgeBaseMessages(session, now);
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return activeMessages;
  return activeMessages.filter((message) => message.createdAt > hiddenBefore);
}

export function getDisplayKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore" | "historyActiveDate">, now = Date.now()): ChatMessage[] {
  return hideSettledKnowledgeBaseRunInternals(getVisibleKnowledgeBaseMessages(session, now));
}

export function getHiddenKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore" | "historyActiveDate">, now = Date.now()): ChatMessage[] {
  const activeMessages = getActiveKnowledgeBaseMessages(session, now);
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return [];
  return activeMessages.filter((message) => message.createdAt <= hiddenBefore);
}

export function clearKnowledgeBaseVisibleHistory(session: StoredSession, now = Date.now()): KnowledgeBaseClearResult {
  const activeMessages = getActiveKnowledgeBaseMessages(session, now);
  const hiddenBefore = Math.max(now, ...activeMessages.map((message) => message.createdAt || 0));
  session.messagesHiddenBefore = hiddenBefore;
  delete session.threadId;
  delete session.tokenUsage;
  delete session.knowledgeContext;
  session.updatedAt = now;
  return {
    hiddenCount: getHiddenKnowledgeBaseMessages(session).length,
    hiddenBefore
  };
}

export function restoreKnowledgeBaseVisibleHistory(session: StoredSession, now = Date.now()): void {
  delete session.messagesHiddenBefore;
  session.updatedAt = now;
}

function normalizedHiddenBefore(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hideSettledKnowledgeBaseRunInternals(messages: ChatMessage[]): ChatMessage[] {
  const knowledgeRunIds = new Set(
    messages
      .filter((message) => message.itemType === "knowledgeBase" && message.runId)
      .map((message) => message.runId as string)
  );
  if (!knowledgeRunIds.size) return messages;
  return messages.filter((message) => {
    if (!message.runId || !knowledgeRunIds.has(message.runId)) return true;
    return message.role === "user" || message.itemType === "knowledgeBase";
  });
}
