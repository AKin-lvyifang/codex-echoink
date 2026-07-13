import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import { clearKnowledgeBaseVisibleHistory } from "../../knowledge-base/session-history";
import { advanceSessionRevision, sessionBackendBinding } from "../../harness/kernel/session-service";
import { ensureKnowledgeBaseSession, isKnowledgeBaseSession as isKnowledgeSession, newId, type StoredAttachment, type StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue } from "../turn-queue";
import { textInputModal } from "../modals";
import { KnowledgeBaseHistoryModal } from "./history-modal";
import { openSessionMenu as showSessionMenu } from "./menus";
import { renderCodexTabs } from "./tabs";
import type { EchoInkResource } from "../../resources/types";

export interface CodexSessionHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  readonly turnQueue: RuntimeTurnQueue;
  tabBarEl: HTMLElement;
  running: boolean;
  activeRunSessionId: string;
  inputEl: HTMLTextAreaElement;
  attachments: StoredAttachment[];
  selectedSkill: EchoInkResource | null;
  resetVirtualWindow(): void;
  renderTabs(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  renderToolbar(): void;
  renderKnowledgeDashboard(): void;
  refreshKnowledgeDashboard(force?: boolean): Promise<void>;
  updateInputPlaceholder(): void;
  prewarmActiveThread(): void;
  closeComposerMenus(): void;
  renameSession(session: StoredSession): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createSession(title?: string): StoredSession;
  isKnowledgeBaseSession(session: StoredSession): boolean;
  openKnowledgeBaseHistory(session: StoredSession): Promise<void>;
}

export function renderTabsView(host: CodexSessionHost): void {
  ensureSession(host);
  renderCodexTabs(
    host.tabBarEl,
    host.plugin.settings.sessions,
    host.plugin.settings.activeSessionId,
    host.plugin.settings.knowledgeBase.sessionId,
    {
      onActivate: (session) => void (async () => {
        host.plugin.settings.activeSessionId = session.id;
        await host.plugin.saveSettings(true);
        host.resetVirtualWindow();
        host.renderTabs();
        host.renderMessages({ forceBottom: true });
        host.renderToolbar();
        host.renderKnowledgeDashboard();
        void host.refreshKnowledgeDashboard();
        host.updateInputPlaceholder();
        host.prewarmActiveThread();
      })(),
      onContextMenu: (event, session) => openSessionMenuView(host, event, session),
      onRename: (session, knowledgeSession) => {
        if (knowledgeSession) {
          new Notice("知识库管理频道是常驻频道，不能重命名");
          return;
        }
        void host.renameSession(session);
      },
      onCreateSession: () => void (async () => {
        host.createSession();
        host.resetVirtualWindow();
        await host.plugin.saveSettings(true);
        host.renderTabs();
        host.renderMessages({ forceBottom: true });
        host.renderToolbar();
        host.renderKnowledgeDashboard();
        void host.refreshKnowledgeDashboard();
        host.updateInputPlaceholder();
        host.prewarmActiveThread();
      })()
    }
  );
}

export function openSessionMenuView(host: CodexSessionHost, event: MouseEvent, session: StoredSession): void {
  showSessionMenu(event, host.isKnowledgeBaseSession(session), {
    onRename: () => void host.renameSession(session),
    onResetCache: () => void resetSessionNativeCache(host, session),
    onDelete: () => void host.deleteSession(session.id)
  });
}

export async function resetSessionNativeCache(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (host.running && host.activeRunSessionId === session.id) {
    new Notice("当前会话正在运行，结束后再重置 Agent 缓存");
    return;
  }
  try {
    const results = await host.plugin.resetEchoInkSessionNativeCache(session);
    const retained = results.filter((result) => result.cleanup !== "disposed").length;
    new Notice(retained ? `Agent 缓存已重置；${retained} 个原生记录已保留或等待重试` : "Agent 缓存已重置");
  } catch (error) {
    new Notice(`重置 Agent 缓存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function renameSession(host: CodexSessionHost, session: StoredSession): Promise<void> {
  const name = await textInputModal(host.app, "重命名会话", "名称", session.title);
  if (!name) return;
  session.title = name;
  const threadId = sessionBackendBinding(session, "codex-cli")?.nativeThreadId ?? session.threadId;
  if (threadId) await host.plugin.setCodexHarnessThreadName(threadId, name).catch(swallowError("rename Codex chat thread"));
  await host.plugin.saveSettings();
  host.renderTabs();
}

export async function deleteSession(host: CodexSessionHost, sessionId: string): Promise<void> {
  const sessions = host.plugin.settings.sessions;
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return;
  const session = sessions[index];
  if (host.isKnowledgeBaseSession(session)) {
    new Notice("知识库管理频道不能删除");
    return;
  }
  const previousSessions = sessions.slice();
  const previousActiveSessionId = host.plugin.settings.activeSessionId;
  const wasActive = host.plugin.settings.activeSessionId === sessionId;
  sessions.splice(index, 1);
  if (!sessions.length) {
    host.createSession();
  } else if (wasActive) {
    host.plugin.settings.activeSessionId = sessions[Math.max(0, index - 1)]?.id ?? sessions[0].id;
    host.resetVirtualWindow();
  }
  let cleanupResults = [] as Awaited<ReturnType<CodexForObsidianPlugin["commitEchoInkSessionDeletion"]>>;
  try {
    cleanupResults = await host.plugin.commitEchoInkSessionDeletion(session);
  } catch (error) {
    host.plugin.settings.sessions = previousSessions;
    host.plugin.settings.activeSessionId = previousActiveSessionId;
    await host.plugin.saveSettings(true).catch(() => undefined);
    new Notice(`删除会话失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  host.turnQueue.clearSessionQueue(sessionId);
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  const retained = cleanupResults.filter((result) => result.cleanup !== "disposed").length;
  new Notice(retained ? `已删除会话；${retained} 个原生缓存已保留或等待重试` : "已删除会话");
}

export async function clearKnowledgeBasePage(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (!host.isKnowledgeBaseSession(session)) return;
  if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
    new Notice("知识库任务运行中，结束后再清空页面");
    return;
  }
  const result = clearKnowledgeBaseVisibleHistory(session);
  host.inputEl.value = "";
  host.closeComposerMenus();
  host.attachments = [];
  host.selectedSkill = null;
  host.resetVirtualWindow();
  await host.plugin.saveSettings(true);
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  host.updateInputPlaceholder();
  new Notice(result.hiddenCount ? `已清空当前页面，${result.hiddenCount} 条历史仍可在 /history 查看` : "已开启新的知识库上下文");
}

export async function openKnowledgeBaseHistory(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (!host.isKnowledgeBaseSession(session)) return;
  await host.plugin.saveSettings(true);
  const index = await host.plugin.readKnowledgeBaseHistoryIndex().catch((error) => {
    console.error("Codex knowledge history read failed", error);
    return null;
  });
  const historySession = index?.sessions.find((item) => item.sessionId === session.id);
  const days = historySession?.days ?? [];
  if (!days.length) {
    new Notice("没有知识库历史");
    return;
  }
  new KnowledgeBaseHistoryModal(
    host.app,
    days,
    (date) => host.plugin.readKnowledgeBaseHistoryDay(session.id, date),
    (date) => restoreKnowledgeBaseHistoryDate(host, session, date)
  ).open();
}

export async function restoreKnowledgeBaseHistoryDate(host: CodexSessionHost, session: StoredSession, date: string): Promise<void> {
  const messages = await host.plugin.readKnowledgeBaseHistoryDay(session.id, date);
  if (!messages.length) {
    new Notice("这一天没有可恢复的历史");
    return;
  }
  advanceSessionRevision(session);
  session.messages = messages;
  session.historyActiveDate = date;
  delete session.messagesHiddenBefore;
  delete session.threadId;
  delete session.tokenUsage;
  delete session.knowledgeContext;
  session.updatedAt = Date.now();
  host.resetVirtualWindow();
  await host.plugin.saveSettings(true);
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  new Notice("已把这一天恢复到页面显示；模型上下文会从新线程开始");
}

export function ensureSession(host: CodexSessionHost): StoredSession {
  ensureKnowledgeBaseSession(host.plugin.settings, host.plugin.getVaultPath());
  const activeId = host.plugin.settings.activeSessionId;
  const active = host.plugin.settings.sessions.find((session) => session.id === activeId);
  if (active) return active;
  return host.createSession();
}

export function isKnowledgeBaseSession(host: CodexSessionHost, session: StoredSession): boolean {
  return isKnowledgeSession(session, host.plugin.settings.knowledgeBase.sessionId);
}

export function createSession(host: CodexSessionHost, title = "新会话"): StoredSession {
  const session: StoredSession = {
    id: newId("session"),
    title,
    cwd: "",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  host.plugin.settings.sessions.push(session);
  host.plugin.settings.activeSessionId = session.id;
  return session;
}

export function sessionById(host: CodexSessionHost, sessionId: string): StoredSession | null {
  return host.plugin.settings.sessions.find((session) => session.id === sessionId) ?? null;
}

export function activeRunSession(host: CodexSessionHost): StoredSession {
  const active = host.activeRunSessionId ? host.plugin.settings.sessions.find((session) => session.id === host.activeRunSessionId) : null;
  return active ?? ensureSession(host);
}

export function sessionForThread(host: CodexSessionHost, threadId?: string): StoredSession | null {
  if (!threadId) return null;
  return host.plugin.settings.sessions.find((session) => session.threadId === threadId) ?? null;
}
