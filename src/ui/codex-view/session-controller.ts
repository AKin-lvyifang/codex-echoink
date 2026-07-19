import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import { clearKnowledgeBaseVisibleHistory } from "../../knowledge-base/session-history";
import { sessionBackendBinding } from "../../harness/kernel/session-service";
import type { EchoInkSessionContextRotationResult } from "../../plugin/session-context-lifecycle";
import { ensureKnowledgeBaseSession, isKnowledgeBaseSession as isKnowledgeSession, newId, type StoredAttachment, type StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue } from "../turn-queue";
import { textInputModal } from "../modals";
import { KnowledgeBaseHistoryModal } from "./history-modal";
import { openSessionMenu as showSessionMenu } from "./menus";
import { renderCodexTabs } from "./tabs";
import type { EchoInkResource } from "../../resources/types";

export const SESSION_DELETION_DISABLED_NOTICE =
  "安全删除正在迁移中。为避免只删掉部分记录，当前不会删除会话、历史或关联 Agent 缓存。";

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
        host.updateInputPlaceholder();
        await host.plugin.saveSettings(true);
        host.resetVirtualWindow();
        host.renderTabs();
        host.renderMessages({ forceBottom: true });
        host.renderToolbar();
        host.renderKnowledgeDashboard();
        void host.refreshKnowledgeDashboard();
        host.updateInputPlaceholder();
      })(),
      onContextMenu: (event, session) => openSessionMenuView(host, event, session),
      onRename: (session, knowledgeSession) => {
        if (knowledgeSession) {
          new Notice("知识库管理频道是常驻频道，不能重命名");
          return;
        }
        void host.renameSession(session);
      },
      onDeleteSessions: (sessionIds) => void confirmDeleteSessions(host, sessionIds),
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
      })()
    },
    host.running ? host.activeRunSessionId : ""
  );
}

export function openSessionMenuView(host: CodexSessionHost, event: MouseEvent, session: StoredSession): void {
  showSessionMenu(event, host.isKnowledgeBaseSession(session), {
    onRename: () => void host.renameSession(session),
    onResetCache: () => void resetSessionNativeCache(host, session),
    onDelete: () => void confirmDeleteSessions(host, [session.id])
  });
}

export async function resetSessionNativeCache(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (host.running && host.activeRunSessionId === session.id) {
    new Notice("当前会话正在运行，结束后再重置 Agent 缓存");
    return;
  }
  try {
    const rotation = await host.plugin.rotateEchoInkSessionContext(session, {
      reason: "agent-cache-reset",
      advanceContext: false,
      precondition: () => {
        if (host.running && host.activeRunSessionId === session.id) {
          throw new Error("当前会话正在运行，结束后再重置 agent 缓存");
        }
      },
      mutate: (candidate) => {
        delete candidate.tokenUsage;
      }
    });
    new Notice(`Agent 缓存已重置${contextRotationCleanupNoticeSuffix(rotation)}`);
  } catch (error) {
    new Notice(`重置 Agent 缓存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function renameSession(host: CodexSessionHost, session: StoredSession): Promise<void> {
  const name = await textInputModal(host.app, "重命名会话", "名称", session.title);
  if (!name) return;
  await host.plugin.withEchoInkConversationMutation(session.id, async () => {
    session.title = name;
    await host.plugin.saveSettings(true);
  });
  const threadId = sessionBackendBinding(session, "codex-cli")?.nativeThreadId ?? session.threadId;
  if (threadId) await host.plugin.setCodexHarnessThreadName(threadId, name).catch(swallowError("rename Codex chat thread"));
  host.renderTabs();
}

export async function deleteSession(host: CodexSessionHost, sessionId: string): Promise<void> {
  await deleteSessions(host, [sessionId]);
}

export async function confirmDeleteSessions(host: CodexSessionHost, sessionIds: string[]): Promise<void> {
  await deleteSessions(host, sessionIds);
}

export async function deleteSessions(host: CodexSessionHost, sessionIds: string[]): Promise<void> {
  const candidates = deletableSessions(host, sessionIds);
  if (!candidates.length) {
    new Notice("所选会话不可删除；知识库和运行中会话会被保留");
    return;
  }
  new Notice(SESSION_DELETION_DISABLED_NOTICE);
}

function deletableSessions(host: CodexSessionHost, sessionIds: string[]): StoredSession[] {
  const requested = new Set(sessionIds);
  return host.plugin.settings.sessions.filter((session) => {
    if (!requested.has(session.id) || host.isKnowledgeBaseSession(session)) return false;
    return !(host.running && host.activeRunSessionId === session.id);
  });
}

export async function clearKnowledgeBasePage(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (!host.isKnowledgeBaseSession(session)) return;
  if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
    new Notice("知识库任务运行中，结束后再清空页面");
    return;
  }
  const rotatedAt = Date.now();
  let hiddenCount = 0;
  let rotation: EchoInkSessionContextRotationResult;
  try {
    rotation = await host.plugin.rotateEchoInkSessionContext(session, {
      reason: "start-new-context",
      precondition: () => {
        if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
          throw new Error("知识库任务运行中，结束后再清空页面");
        }
      },
      workspace: {
        vaultPath: host.plugin.getVaultPath(),
        cwd: session.cwd || host.plugin.getVaultPath()
      },
      now: () => rotatedAt,
      mutate: (candidate) => {
        hiddenCount = clearKnowledgeBaseVisibleHistory(candidate, rotatedAt).hiddenCount;
      }
    });
  } catch (error) {
    new Notice(`开启知识库新上下文失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  host.inputEl.value = "";
  host.closeComposerMenus();
  host.attachments = [];
  host.selectedSkill = null;
  host.resetVirtualWindow();
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  host.updateInputPlaceholder();
  const primary = hiddenCount
    ? `已清空当前页面，${hiddenCount} 条历史仍可在 /history 查看`
    : "已开启新的知识库上下文";
  new Notice(`${primary}${contextRotationCleanupNoticeSuffix(rotation)}`);
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
  if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
    new Notice("知识库任务运行中，结束后再恢复历史");
    return;
  }
  const messages = await host.plugin.readKnowledgeBaseHistoryDay(session.id, date);
  if (!messages.length) {
    new Notice("这一天没有可恢复的历史");
    return;
  }
  if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
    new Notice("知识库任务运行中，结束后再恢复历史");
    return;
  }
  const restoredThroughMessageId = messages.at(-1)?.id;
  let rotation: EchoInkSessionContextRotationResult;
  try {
    rotation = await host.plugin.rotateEchoInkSessionContext(session, {
      reason: "history-restore",
      precondition: () => {
        if (host.running || host.plugin.getKnowledgeBaseManager()?.isRunning) {
          throw new Error("知识库任务运行中，结束后再恢复历史");
        }
      },
      contextStartsAfterMessageId: restoredThroughMessageId,
      mutate: (candidate) => {
        candidate.messages = messages;
        candidate.historyActiveDate = date;
        delete candidate.messagesHiddenBefore;
        delete candidate.tokenUsage;
      }
    });
  } catch (error) {
    new Notice(`恢复知识库历史失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  host.resetVirtualWindow();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  new Notice(`已把这一天恢复到页面显示；模型上下文会从恢复内容之后开始${contextRotationCleanupNoticeSuffix(rotation)}`);
}

export function contextRotationCleanupNoticeSuffix(
  rotation: EchoInkSessionContextRotationResult
): string {
  if (rotation.retirementPromotion === "awaiting-recovery") {
    return "；原生记录已保留，等待恢复对账";
  }
  return rotation.retirementPromotion === "promoted"
    ? "；原生记录已登记，后台按后端能力处置"
    : "";
}

export function ensureSession(host: CodexSessionHost): StoredSession {
  const sessionCountBefore = host.plugin.settings.sessions.length;
  const knowledgeSession = ensureKnowledgeBaseSession(
    host.plugin.settings,
    host.plugin.getVaultPath()
  );
  if (host.plugin.settings.sessions.length > sessionCountBefore) {
    host.plugin.registerEchoInkPristineConversationSession(knowledgeSession);
  }
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
    revision: 1,
    generation: 1,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  host.plugin.settings.sessions.push(session);
  host.plugin.settings.activeSessionId = session.id;
  host.plugin.registerEchoInkPristineConversationSession(session);
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
