import type { App, Component } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type { ChatMessage, StoredSession } from "../../settings/settings";
import { settleStaleRunningMessages } from "../../core/message-state";
import { getDisplayKnowledgeBaseMessages, getHiddenKnowledgeBaseMessages } from "../../knowledge-base/session-history";
import { SessionMessageStore, type SessionMessageInput } from "./session-message-store";
import { CodexMessageListRenderer } from "./message-list";
import { MessageScrollFollowController, type MessageRenderScheduleOptions } from "./message-scroll-follow";

export interface CodexMessageHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  running: boolean;
  activeRunId: string;
  activeTurnId: string;
  activeThinkingMessageId?: string;
  activePlanMessageId?: string;
  activeItemMessages?: Map<string, string>;
  sessionSaveTimer: number | null;
  knowledgeBaseRunProgressTimer: number | null;
  messagesEl: HTMLElement;
  virtualListEl: HTMLElement;
  messageListRenderer: CodexMessageListRenderer;
  messageScrollFollow: MessageScrollFollowController;
  messagesBottomFollowPaused: boolean;
  ensureSession(): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  openKnowledgeBaseHistory(session: StoredSession): Promise<void>;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  scheduleRenderMessages(options?: MessageRenderScheduleOptions): void;
  scheduleMeasureVirtualRows(forceBottom?: boolean): void;
  scheduleKnowledgeBaseRunProgress(): void;
  isMessagesAtBottom(): boolean;
}

const CHAT_SESSION_SAVE_DEBOUNCE_MS = 500;
const sessionMessageStores = new WeakMap<object, SessionMessageStore>();

export function sessionMessageStoreFor(host: CodexMessageHost): SessionMessageStore {
  const existing = sessionMessageStores.get(host);
  if (existing) return existing;
  const store = new SessionMessageStore({
    getActiveRunId: () => host.activeRunId ?? "",
    getActiveTurnId: () => host.activeTurnId ?? "",
    getVaultPath: () => host.plugin.getVaultPath(),
    externalizeMessageText: async (message, text) => {
      await host.plugin.externalizeMessageText(message, text);
    },
    renderMessagesIfActive: (session, updatedMessage) => renderMessagesIfActive(host, session, updatedMessage),
    scheduleSessionSave: () => scheduleSessionSave(host)
  });
  sessionMessageStores.set(host, store);
  return store;
}

export function clearLegacySessionMessageState(host: CodexMessageHost): void {
  host.activeThinkingMessageId = "";
  host.activePlanMessageId = "";
  host.activeItemMessages?.clear();
}

export function clearSessionMessageActiveRun(host: CodexMessageHost): void {
  sessionMessageStoreFor(host).clearActiveRun();
  clearLegacySessionMessageState(host);
}

export function renderMessages(host: CodexMessageHost, options: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean } = {}): void {
  const session = host.ensureSession();
  settleStaleMessages(host, session);
  const knowledgeSession = host.isKnowledgeBaseSession(session);
  const messages = knowledgeSession ? getDisplayKnowledgeBaseMessages(session) : session.messages;
  const hiddenCount = knowledgeSession ? getHiddenKnowledgeBaseMessages(session).length : 0;
  const renderOptions = host.messagesBottomFollowPaused ? { ...options, forceBottom: false, preserveScroll: true } : options;
  host.messageListRenderer.render({
    app: host.app,
    component: host as unknown as Component,
    messagesEl: host.messagesEl,
    virtualListEl: host.virtualListEl,
    sessionId: session.id,
    knowledgeSession,
    messages,
    hiddenKnowledgeMessageCount: hiddenCount,
    vaultPath: host.plugin.getVaultPath(),
    readRawMessageText: (rawRef) => host.plugin.readRawMessageText(rawRef),
    onOpenKnowledgeHistory: () => void host.openKnowledgeBaseHistory(session),
    onScheduleMeasure: () => host.scheduleMeasureVirtualRows(),
    onScheduleRunProgress: () => host.scheduleKnowledgeBaseRunProgress(),
    shouldFollowBottom: () => !host.messagesBottomFollowPaused,
    options: renderOptions
  });
}

export function settleStaleMessages(host: CodexMessageHost, session: StoredSession): void {
  if (host.running) return;
  if (host.isKnowledgeBaseSession(session) && host.plugin.getKnowledgeBaseManager()?.isRunning) return;
  const count = settleStaleRunningMessages(session.messages);
  if (!count) return;
  clearSessionMessageActiveRun(host);
  void host.plugin.saveSettings();
}

export function appendItemDelta(host: CodexMessageHost, session: StoredSession, itemId: string, role: ChatMessage["role"], delta: string, itemType: string, title: string): void {
  sessionMessageStoreFor(host).appendItemDelta(session, itemId, role, delta, itemType, title);
}

export function appendProcessDelta(host: CodexMessageHost, session: StoredSession, itemId: string, itemType: string, delta: string, payload: unknown): void {
  sessionMessageStoreFor(host).appendProcessDelta(session, itemId, itemType, delta, payload);
}

export function ensureThinkingMessage(host: CodexMessageHost, session: StoredSession, title: string, text: string): void {
  sessionMessageStoreFor(host).ensureThinkingMessage(session, title, text);
}

export function markThinkingAsStreaming(host: CodexMessageHost, session: StoredSession): void {
  sessionMessageStoreFor(host).markThinkingAsStreaming(session);
}

export function finishThinkingMessage(host: CodexMessageHost, session: StoredSession, status: string): void {
  sessionMessageStoreFor(host).finishThinkingMessage(session, status);
}

export function finishPlanMessage(host: CodexMessageHost, session: StoredSession): void {
  sessionMessageStoreFor(host).finishPlanMessage(session);
}

export function finishRunningProcessMessages(host: CodexMessageHost, session: StoredSession, status: string): void {
  sessionMessageStoreFor(host).finishRunningProcessMessages(session, status);
}

export function renderPlanUpdate(host: CodexMessageHost, session: StoredSession, params: unknown): void {
  sessionMessageStoreFor(host).renderPlanUpdate(session, params);
}

export function renderStartedItem(host: CodexMessageHost, session: StoredSession, item: unknown): void {
  sessionMessageStoreFor(host).renderStartedItem(session, item);
}

export async function renderCompletedItem(host: CodexMessageHost, session: StoredSession, item: unknown): Promise<void> {
  await sessionMessageStoreFor(host).renderCompletedItem(session, item);
}

export async function upsertProcessItem(host: CodexMessageHost, session: StoredSession, id: string, itemType: string, text: string, status: string | undefined, payload: unknown): Promise<void> {
  await sessionMessageStoreFor(host).upsertProcessItem(session, id, itemType, text, status, payload);
}

export function addMessageToSession(host: CodexMessageHost, session: StoredSession, message: SessionMessageInput): void {
  sessionMessageStoreFor(host).addMessageToSession(session, message);
}

export function scheduleSessionSave(host: CodexMessageHost): void {
  if (host.sessionSaveTimer) return;
  host.sessionSaveTimer = window.setTimeout(() => {
    host.sessionSaveTimer = null;
    void host.plugin.saveSettings(true).catch(() => undefined);
  }, CHAT_SESSION_SAVE_DEBOUNCE_MS);
}

export async function flushSessionSave(host: CodexMessageHost): Promise<void> {
  if (host.sessionSaveTimer) {
    window.clearTimeout(host.sessionSaveTimer);
    host.sessionSaveTimer = null;
  }
  await host.plugin.saveSettings(true);
}

export function moveMessageToEnd(host: CodexMessageHost, session: StoredSession, messageId: string): void {
  sessionMessageStoreFor(host).moveMessageToEnd(session, messageId);
}

export function addContextCompactionMessage(host: CodexMessageHost, session: StoredSession): void {
  const last = session.messages[session.messages.length - 1];
  if (last?.itemType === "contextCompaction" && Date.now() - last.createdAt < 10_000) return;
  addMessageToSession(host, session, { role: "system", title: "上下文压缩", itemType: "contextCompaction", text: "Codex 已自动压缩上下文。", createdAt: Date.now() });
}

export function attachTurnIdToRun(host: CodexMessageHost, session: StoredSession, turnId: string): void {
  if (!turnId || !host.activeRunId) return;
  for (const message of session.messages) {
    if (message.runId === host.activeRunId) message.turnId = turnId;
  }
}

export function renderMessagesIfActive(host: CodexMessageHost, session: StoredSession, updatedMessage?: ChatMessage): void {
  if (session.id !== host.plugin.settings.activeSessionId) return;
  if (updatedMessage && host.messageListRenderer.tryUpdateMessage(updatedMessage)) return;
  host.scheduleRenderMessages();
}

export function handleMessagesScroll(host: CodexMessageHost): void {
  host.scheduleRenderMessages(host.messageScrollFollow.handleScroll(host.isMessagesAtBottom()));
}

export function scheduleRenderMessages(host: CodexMessageHost, options: MessageRenderScheduleOptions = {}): void {
  host.messageScrollFollow.scheduleRender(options, (callback) => window.requestAnimationFrame(callback), (renderOptions) => host.renderMessages(renderOptions));
}

export function scheduleMeasureVirtualRows(host: CodexMessageHost, forceBottom = !host.messagesBottomFollowPaused): void {
  host.messageScrollFollow.scheduleMeasure(forceBottom, (callback) => window.requestAnimationFrame(callback), (shouldForceBottom) => measureVisibleVirtualRows(host, shouldForceBottom));
}

export function scheduleKnowledgeBaseRunProgress(host: CodexMessageHost): void {
  if (host.knowledgeBaseRunProgressTimer !== null) return;
  host.knowledgeBaseRunProgressTimer = window.setTimeout(() => {
    host.knowledgeBaseRunProgressTimer = null;
    const forceBottom = !host.messagesBottomFollowPaused;
    host.scheduleRenderMessages({ forceBottom, fromScroll: !forceBottom });
  }, 700);
}

export function clearKnowledgeBaseRunProgressTimer(host: CodexMessageHost): void {
  if (host.knowledgeBaseRunProgressTimer === null) return;
  window.clearTimeout(host.knowledgeBaseRunProgressTimer);
  host.knowledgeBaseRunProgressTimer = null;
}

export function measureVisibleVirtualRows(host: CodexMessageHost, forceBottom = false): boolean {
  if (!host.virtualListEl || !host.messagesEl) return false;
  const changed = host.messageListRenderer.measureVisibleVirtualRows(host.messagesEl, host.virtualListEl, forceBottom, { rerender: false });
  if (changed) host.scheduleRenderMessages({ forceBottom, fromScroll: !forceBottom });
  return changed;
}

export function isMessagesNearBottom(host: CodexMessageHost): boolean {
  if (!host.messagesEl) return true;
  return host.messageListRenderer.isNearBottom(host.messagesEl, host.virtualListEl);
}

export function isMessagesAtBottom(host: CodexMessageHost): boolean {
  if (!host.messagesEl) return true;
  return host.messageListRenderer.isAtBottom(host.messagesEl, host.virtualListEl);
}

export function resetVirtualWindow(host: CodexMessageHost): void {
  host.messageListRenderer.resetVirtualWindow();
  host.messageScrollFollow.reset();
  if (host.messagesEl) host.messagesEl.scrollTop = 0;
}
