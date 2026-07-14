import type { StoredSession } from "../../settings/settings";
import type { CodexNotification, TokenUsage } from "../../types/app-server";

export interface CodexNotificationRouterContext {
  sessionForThread(threadId?: string): StoredSession | null;
  updateContextForSession(session: StoredSession, tokenUsage: TokenUsage | undefined, persist: boolean): void;
  addContextCompactionMessage(session: StoredSession): void;
}

export class CodexNotificationRouter {
  constructor(private readonly context: CodexNotificationRouterContext) {}

  handle(notification: CodexNotification): void {
    const { method, params } = notification;
    const payload = paramsObject(params);
    const view = this.context;
    if (method === "thread/tokenUsage/updated") {
      const session = view.sessionForThread(notificationThreadId(payload));
      if (!session) return;
      view.updateContextForSession(session, tokenUsageParam(payload.tokenUsage), true);
      return;
    }
    if (method === "thread/compacted") {
      const session = view.sessionForThread(notificationThreadId(payload));
      if (!session) return;
      view.addContextCompactionMessage(session);
      if (payload.tokenUsage) view.updateContextForSession(session, tokenUsageParam(payload.tokenUsage), true);
    }
  }
}

function paramsObject(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function notificationThreadId(payload: Record<string, unknown>): string {
  const direct = payload.threadId;
  if (typeof direct === "string") return direct;
  const nested = paramsObject(payload.thread).id;
  return typeof nested === "string" ? nested : "";
}

function tokenUsageParam(value: unknown): TokenUsage | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as TokenUsage : undefined;
}
