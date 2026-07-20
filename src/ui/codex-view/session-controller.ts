import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import { swallowError } from "../../core/error-handling";
import { clearKnowledgeBaseVisibleHistory } from "../../knowledge-base/session-history";
import { sessionBackendBinding } from "../../harness/kernel/session-service";
import type { EchoInkSessionContextRotationResult } from "../../plugin/session-context-lifecycle";
import { ensureKnowledgeBaseSession, isKnowledgeBaseSession as isKnowledgeSession, newId, type StoredAttachment, type StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue } from "../turn-queue";
import { confirmModal, textInputModal } from "../modals";
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
    onClearRecords: () =>
      void clearSessionConversationRecords(host, session),
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

type ConversationRecordMutationConfirm = (
  title: string,
  body: string,
  acceptText: string,
  declineText: string
) => Promise<boolean>;

interface ConversationRecordMutationUiOptions {
  confirm?: ConversationRecordMutationConfirm;
}

export async function clearSessionConversationRecords(
  host: CodexSessionHost,
  session: StoredSession,
  options: ConversationRecordMutationUiOptions = {}
): Promise<void> {
  if (host.isKnowledgeBaseSession(session)) {
    new Notice("知识库记录请在知识库历史管理中单独处理");
    return;
  }
  if (host.running && host.activeRunSessionId === session.id) {
    new Notice("当前会话正在运行，结束后再清空记录");
    return;
  }
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  try {
    const preview =
      await host.plugin.previewEchoInkConversationRecordClear(session);
    if (preview.blockers.length) {
      new Notice(
        `“${session.title}”暂时不能安全清空：`
        + recordMutationBlockerDetail(preview.blockers)
      );
      return;
    }
    const accepted = await confirm(
      `清空会话“${session.title}”的记录？`,
      recordMutationConfirmationBody(
        session,
        "clear-conversation-records",
        preview.disposition.retainMemoryIds.length,
        preview.disposition.retainArtifactIds.length
      ),
      "安全清空",
      "取消"
    );
    if (!accepted) return;
    if (host.running && host.activeRunSessionId === session.id) {
      new Notice("当前会话正在运行，已跳过清空");
      return;
    }
    const receipt = await host.plugin.clearEchoInkConversationRecords(
      session,
      preview.disposition
    );
    if (receipt.localState === "committed") {
      host.turnQueue.clearSessionQueue(session.id);
      renderCommittedConversationRecordMutation(host);
      const pending =
        receipt.projection === "awaiting-recovery"
        || receipt.nativeRetirement === "awaiting-recovery";
      new Notice(
        pending
          ? "会话记录已提交清空；后台清理或界面投影等待恢复"
          : "会话记录已安全清空；关联 Agent 记录按后端能力后台清理"
      );
      return;
    }
    if (receipt.localState === "awaiting-recovery") {
      new Notice("会话记录清空已进入恢复队列，暂不重复操作");
      return;
    }
    new Notice(
      `清空“${session.title}”失败，记录已安全恢复：`
      + (receipt.error ?? "未知错误")
    );
  } catch (error) {
    new Notice(
      `清空“${session.title}”失败：`
      + (error instanceof Error ? error.message : String(error))
    );
  }
}

export async function confirmDeleteSessions(host: CodexSessionHost, sessionIds: string[]): Promise<void> {
  await deleteSessions(host, sessionIds);
}

export async function deleteSessions(
  host: CodexSessionHost,
  sessionIds: string[],
  options: ConversationRecordMutationUiOptions = {}
): Promise<void> {
  const candidates = deletableSessions(host, sessionIds);
  if (!candidates.length) {
    new Notice("所选会话不可删除；知识库和运行中会话会被保留");
    return;
  }
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  let committedCount = 0;
  let pendingRecoveryCount = 0;
  for (const session of candidates) {
    try {
      const preview =
        await host.plugin.previewEchoInkSessionDeletion(session);
      if (preview.blockers.length) {
        const detail = recordMutationBlockerDetail(preview.blockers);
        new Notice(`“${session.title}”暂时不能安全删除：${detail}`);
        continue;
      }
      const accepted = await confirm(
        `删除会话“${session.title}”？`,
        recordMutationConfirmationBody(
          session,
          "delete-conversation",
          preview.disposition.retainMemoryIds.length,
          preview.disposition.retainArtifactIds.length
        ),
        "安全删除",
        "取消"
      );
      if (!accepted) continue;
      if (
        host.running
        && host.activeRunSessionId === session.id
      ) {
        new Notice(`“${session.title}”正在运行，已跳过删除`);
        continue;
      }
      const receipt = await host.plugin.commitEchoInkSessionDeletion(
        session,
        preview.disposition
      );
      if (receipt.localState === "committed") {
        committedCount += 1;
        host.turnQueue.clearSessionQueue(session.id);
        if (
          receipt.projection === "awaiting-recovery"
          || receipt.nativeRetirement === "awaiting-recovery"
        ) {
          pendingRecoveryCount += 1;
        }
        continue;
      }
      if (receipt.localState === "awaiting-recovery") {
        pendingRecoveryCount += 1;
        new Notice(
          `“${session.title}”的删除已进入恢复队列，暂不重复操作`
        );
        continue;
      }
      new Notice(
        `删除“${session.title}”失败，记录已安全恢复：${receipt.error ?? "未知错误"}`
      );
    } catch (error) {
      new Notice(
        `删除“${session.title}”失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (committedCount) {
    renderCommittedConversationRecordMutation(host);
    new Notice(
      pendingRecoveryCount
        ? `已提交 ${committedCount} 个会话删除；${pendingRecoveryCount} 个后台清理或界面投影等待恢复`
        : `已安全删除 ${committedCount} 个会话；关联 Agent 记录按后端能力后台清理`
    );
  }
}

function defaultRecordMutationConfirm(
  host: CodexSessionHost
): ConversationRecordMutationConfirm {
  return async (title, body, acceptText, declineText) =>
    await confirmModal(
      host.app,
      title,
      body,
      acceptText,
      declineText
    );
}

function recordMutationBlockerDetail(
  blockers: ReadonlyArray<{ code: string; subjectId: string }>
): string {
  return blockers
    .slice(0, 3)
    .map((blocker) => `${blocker.code}:${blocker.subjectId}`)
    .join("；");
}

function renderCommittedConversationRecordMutation(
  host: CodexSessionHost
): void {
  host.resetVirtualWindow();
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  host.renderKnowledgeDashboard();
  void host.refreshKnowledgeDashboard();
  host.updateInputPlaceholder();
}

function recordMutationConfirmationBody(
  session: StoredSession,
  operation: "clear-conversation-records" | "delete-conversation",
  retainedMemoryCount: number,
  retainedArtifactCount: number
): string {
  const retained = [
    retainedMemoryCount
      ? `${retainedMemoryCount} 条待确认长期记忆`
      : "",
    retainedArtifactCount
      ? `${retainedArtifactCount} 个正式产物`
      : ""
  ].filter(Boolean).join("、");
  const sourceMarker = operation === "delete-conversation"
    ? "来源会话已删除"
    : "来源会话记录已清空";
  const retention = retained
    ? (
        `会保留${retained}，并标记${sourceMarker}。`
        + "如需丢弃，请先在对应的 Memory 或产物管理中单独处理。"
      )
    : "没有需要额外确认保留的长期记忆或正式产物。";
  const localEffect = operation === "delete-conversation"
    ? (
        `将删除“${session.title}”的 Conversation、消息、快照、`
        + "独占 Raw 和策略选中的运行明细。"
      )
    : (
        `将保留“${session.title}”的会话入口，但删除消息、快照、`
        + "独占 Raw 和策略选中的运行明细，并开启空上下文。"
      );
  return (
    localEffect
    + `${retention}关联 Agent thread/session 的清理由独立收据跟踪，失败不会把已提交的本地操作伪装成失败。`
  );
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
