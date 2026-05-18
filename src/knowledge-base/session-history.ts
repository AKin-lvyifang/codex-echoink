import type { ChatMessage, StoredSession } from "../settings/settings";

export interface KnowledgeBaseClearResult {
  hiddenCount: number;
  hiddenBefore: number;
}

export function getVisibleKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore">): ChatMessage[] {
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return session.messages;
  return session.messages.filter((message) => message.createdAt > hiddenBefore);
}

export function getHiddenKnowledgeBaseMessages(session: Pick<StoredSession, "messages" | "messagesHiddenBefore">): ChatMessage[] {
  const hiddenBefore = normalizedHiddenBefore(session.messagesHiddenBefore);
  if (!hiddenBefore) return [];
  return session.messages.filter((message) => message.createdAt <= hiddenBefore);
}

export function clearKnowledgeBaseVisibleHistory(session: StoredSession, now = Date.now()): KnowledgeBaseClearResult {
  const hiddenBefore = Math.max(now, ...session.messages.map((message) => message.createdAt || 0));
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
