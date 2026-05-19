import type { ChatMessage, StoredSession } from "../settings/settings";

export interface KnowledgeBaseClearResult {
  hiddenCount: number;
  hiddenBefore: number;
}

export function getActiveKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "historyActiveDate">): ChatMessage[] {
  const activeDate = session.historyActiveDate || latestLocalDate(session.messages);
  if (!activeDate) return [];
  return session.messages.filter((message) => localDateKeyForTimestamp(message.createdAt) === activeDate);
}

export function getVisibleKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore" | "historyActiveDate">): ChatMessage[] {
  const activeMessages = getActiveKnowledgeBaseMessages(session);
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return activeMessages;
  return activeMessages.filter((message) => message.createdAt > hiddenBefore);
}

export function getHiddenKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore" | "historyActiveDate">): ChatMessage[] {
  const activeMessages = getActiveKnowledgeBaseMessages(session);
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return [];
  return activeMessages.filter((message) => message.createdAt <= hiddenBefore);
}

export function clearKnowledgeBaseVisibleHistory(session: StoredSession, now = Date.now()): KnowledgeBaseClearResult {
  const activeMessages = getActiveKnowledgeBaseMessages(session);
  const hiddenBefore = Math.max(now, ...activeMessages.map((message) => message.createdAt || 0));
  session.messagesHiddenBefore = hiddenBefore;
  delete session.threadId;
  delete session.tokenUsage;
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

function latestLocalDate(messages: ChatMessage[]): string {
  let latest = 0;
  for (const message of messages) {
    if ((message.createdAt || 0) > latest) latest = message.createdAt || 0;
  }
  return latest ? localDateKeyForTimestamp(latest) : "";
}

function localDateKeyForTimestamp(value: number): string {
  const date = new Date(Number.isFinite(value) && value > 0 ? value : Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
