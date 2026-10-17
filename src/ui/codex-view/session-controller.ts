import { cloneSelectionAnnotations } from "../../types/selection-annotations";
import { applyConversationTaskMetadata, normalizeConversationTaskMetadata, type ConversationTaskMetadata } from "../../agents/task-metadata";
import { emptySelectionDraft, restoreSelectionDraft } from "../../selection-ask/draft";
import { Notice, type App } from "obsidian";
import type CodexForObsidianPlugin from "../../main";
import type {
  PiConversationCatalogEntry,
  PiConversationProjection
} from "../../harness/pi-native/contracts";
import { newId, selectActiveConversationSession, type StoredAttachment, type StoredSession } from "../../settings/settings";
import { RuntimeTurnQueue } from "../turn-queue";
import { confirmModal, textInputModal } from "../modals";
import { openSessionMenu as showSessionMenu } from "./menus";
import { renderCodexTabs } from "./tabs";
import type { EchoInkResource } from "../../resources/types";
import {
  copyPiImageAttachmentsForProjection,
  piComposerImageAttachmentsForEntry,
  projectPiImageAttachments,
  refreshPiConversationSupport,
  rememberPiConversationProjection
} from "./pi-conversation-support";
import { piEntryIdFromProjectedMessageId } from "../../harness/pi-native/pi-chat-ui-projector";
import { conversationUiText } from "./ui-i18n";

export interface CodexSessionHost {
  readonly app: App;
  readonly plugin: CodexForObsidianPlugin;
  readonly turnQueue: RuntimeTurnQueue;
  tabBarEl: HTMLElement;
  running: boolean;
  readonly runningSessionIds: ReadonlySet<string>;
  activeRunSessionId: string;
  inputEl: HTMLTextAreaElement;
  attachments: StoredAttachment[];
  selectedSkill: EchoInkResource | null;
  switchComposerDraft?(sessionId: string): void;
  resetVirtualWindow(): void;
  renderTabs(): void;
  renderMessages(options?: { forceBottom?: boolean; fromScroll?: boolean; preserveScroll?: boolean }): void;
  renderToolbar(): void;
  updateInputPlaceholder(): void;
  closeComposerMenus(): void;
  renameSession(session: StoredSession): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  createSession(title?: string, options?: CreateSessionOptions): Promise<StoredSession>;
}

export interface CreateSessionOptions extends ConversationTaskMetadata {
  readonly defaultSkillId?: string;
  readonly journalDirectory?: string;
}

const conversationTransitionLanes = new WeakMap<
  CodexSessionHost,
  Promise<void>
>();
const conversationSelectionGenerations = new WeakMap<
  CodexSessionHost,
  number
>();
const conversationSelectionTargets = new WeakMap<
  CodexSessionHost,
  string
>();

export function renderTabsView(host: CodexSessionHost): void {
  ensureSession(host);
  releaseInactiveConversationBodies(host);
  renderCodexTabs(
    host.tabBarEl,
    host.plugin.settings.sessions,
    host.plugin.settings.activeSessionId,
    {
      onActivate: (session) => void (async () => {
        try {
          await activateSession(host, session);
        } catch (error) {
          new Notice(conversationUiText(
            host.plugin.settings.settingsLanguage,
            `打开会话失败：${errorMessage(error)}`,
            `Could not open the conversation: ${errorMessage(error)}`
          ));
        } finally {
          renderConversationShellChange(host);
        }
      })(),
      onContextMenu: (event, session) => openSessionMenuView(host, event, session),
      onRename: (session) => void host.renameSession(session),
      onArchive: (session) => void host.archiveSession(session.id),
      onDeleteSessions: (sessionIds) => void confirmDeleteSessions(host, sessionIds),
      onCreateSession: () => void (async () => {
        try {
          await host.createSession();
        } catch (error) {
          new Notice(conversationUiText(
            host.plugin.settings.settingsLanguage,
            `新建会话失败：${errorMessage(error)}`,
            `Could not create a conversation: ${errorMessage(error)}`
          ));
        } finally {
          renderConversationShellChange(host);
        }
      })()
    },
    host.runningSessionIds,
    host.plugin.settings.settingsLanguage
  );
}

export function openSessionMenuView(host: CodexSessionHost, event: MouseEvent, session: StoredSession): void {
  showSessionMenu(
    event,
    {
      onRename: () => void host.renameSession(session),
      onArchive: () => void host.archiveSession(session.id),
      onResetCache: () => void resetSessionNativeCache(host, session),
      onDelete: () => void confirmDeleteSessions(host, [session.id])
    },
    host.plugin.settings.settingsLanguage
  );
}

export async function resetSessionNativeCache(host: CodexSessionHost, session: StoredSession): Promise<void> {
  if (host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "当前会话正在运行，结束后再重置 Agent 缓存",
      "The current conversation is running. Reset the Agent cache after it finishes."
    ));
    return;
  }
  try {
    await host.plugin.releasePiConversation(session.id);
    delete session.tokenUsage;
    await persistPiConversationShells(host);
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "Agent 运行实例已释放，下次打开会从同一会话记录恢复",
      "The Agent runtime was released. It will restore from this conversation record when reopened."
    ));
  } catch (error) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `重置 Agent 缓存失败：${errorMessage(error)}`,
      `Could not reset the Agent cache: ${errorMessage(error)}`
    ));
  }
}

export async function refreshPiConversationShells(
  host: CodexSessionHost,
  options: { createIfEmpty?: boolean } = {}
): Promise<void> {
  const before = conversationShellFingerprint(host);
  let catalogEntries = await host.plugin.listPiConversations(["active"]);
  if (catalogEntries.length === 0 && options.createIfEmpty !== false) {
    catalogEntries = [await host.plugin.createPiConversation({
      conversationId: newId("conversation"),
      title: conversationUiText(host.plugin.settings.settingsLanguage, "新会话", "New conversation"),
      cwd: host.plugin.getVaultPath(),
      defaultMemoryMode: "normal"
    })];
  }
  const existingChatShells = new Map(
    host.plugin.settings.sessions.map((session) => [session.id, session])
  );
  const chatShells = catalogEntries.map((entry) =>
    applyPiCatalogEntryToShell(
      existingChatShells.get(entry.conversationId)
        ?? createPiConversationShell(host, entry),
      entry
    )
  );
  host.plugin.settings.sessions = chatShells;
  selectActiveConversationSession(host.plugin.settings);
  releaseInactiveConversationBodies(host);
  if (before !== conversationShellFingerprint(host)) {
    await persistPiConversationShells(host);
  }
}

export function activateSession(
  host: CodexSessionHost,
  session: StoredSession
): Promise<void> {
  const generation = beginConversationSelection(host, session.id);
  // Keep projection reads and activation intent ordering in one short lane so
  // a late read cannot enqueue an obsolete AgentSession after a newer choice.
  // Settings persistence happens after this lane and has its own save queue.
  return completeSessionActivation(
    host,
    enqueueConversationTransition(
      host,
      async () => await activateSessionInTransitionLane(
        host,
        session,
        generation
      )
    )
  );
}

type ConversationSelectionOutcome =
  | Readonly<{ status: "stale" }>
  | Readonly<{
      status: "selected";
      error?: unknown;
    }>;

async function completeSessionActivation(
  host: CodexSessionHost,
  selection: Promise<ConversationSelectionOutcome>
): Promise<void> {
  const outcome = await selection;
  if (outcome.status === "stale") return;
  await persistPiConversationShells(host);
  if ("error" in outcome) throw outcome.error;
}

async function activateSessionInTransitionLane(
  host: CodexSessionHost,
  session: StoredSession,
  generation: number
): Promise<ConversationSelectionOutcome> {
  if (!isCurrentConversationSelection(host, generation)) {
    return { status: "stale" };
  }
  const previous = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === host.plugin.settings.activeSessionId
  );
  try {
    const projection = await host.plugin.switchPiConversation(
      previous?.id ?? null,
      session.id,
      {
        isStillCurrent: () =>
          isCurrentConversationSelection(host, generation)
      }
    );
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    applyPiConversationProjectionToShell(host, session, projection);
    host.switchComposerDraft?.(session.id);
    host.plugin.settings.activeSessionId = session.id;
    const unreadAnswerAt = session.unreadAnswerAt;
    releaseInactiveConversationBodies(host);
    host.updateInputPlaceholder();
    renderConversationShellChange(host);
    // The durable projection was read and rendered before marking this task read.
    // A later data.json failure cannot roll back the Catalog commit through a shell.
    if (unreadAnswerAt !== undefined) await host.plugin.setPiConversationTaskMetadata(session.id, { unreadAnswerAt: undefined, lastReadAt: Date.now() }, { markReadThrough: unreadAnswerAt });
    return { status: "selected" };
  } catch (error) {
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    await refreshPiConversationSupport(host.plugin, session.id)
      .catch(() => undefined);
    if (!isCurrentConversationSelection(host, generation)) {
      return { status: "stale" };
    }
    host.switchComposerDraft?.(session.id);
    host.plugin.settings.activeSessionId = session.id;
    releaseInactiveConversationBodies(host);
    host.updateInputPlaceholder();
    renderConversationShellChange(host);
    return { status: "selected", error };
  }
}

function isCurrentConversationSelection(
  host: CodexSessionHost,
  generation: number
): boolean {
  return conversationSelectionGenerations.get(host) === generation;
}

function beginConversationSelection(
  host: CodexSessionHost,
  targetConversationId?: string
): number {
  const generation = (conversationSelectionGenerations.get(host) ?? 0) + 1;
  conversationSelectionGenerations.set(host, generation);
  if (targetConversationId) {
    conversationSelectionTargets.set(host, targetConversationId);
  } else {
    conversationSelectionTargets.delete(host);
  }
  return generation;
}

function bindConversationSelectionTarget(
  host: CodexSessionHost,
  generation: number,
  targetConversationId: string
): boolean {
  if (!isCurrentConversationSelection(host, generation)) return false;
  conversationSelectionTargets.set(host, targetConversationId);
  return true;
}

function isConversationSelectionTarget(
  host: CodexSessionHost,
  conversationId: string
): boolean {
  return conversationSelectionTargets.get(host) === conversationId;
}

export function derivePiConversationFromMessage(
  host: CodexSessionHost,
  session: StoredSession,
  targetEntryId: string
): Promise<void> {
  return enqueueConversationTransition(
    host,
    async () => await derivePiConversationInTransitionLane(
      host,
      session,
      targetEntryId
    )
  );
}

async function derivePiConversationInTransitionLane(
  host: CodexSessionHost,
  session: StoredSession,
  targetEntryId: string
): Promise<void> {
  if (session.bodyAuthority !== "pi_session_only") return;
  if (host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "当前任务运行中，结束后再新建会话",
      "A task is running. Create a conversation after it finishes."
    ));
    return;
  }
  const entryId = targetEntryId.trim();
  const resendAnnotations = cloneSelectionAnnotations(session.messages.find((message) => piEntryIdFromProjectedMessageId(message.id) === entryId)?.selectionAnnotations ?? []);
  if (!entryId) return;

  let derivation: Awaited<
    ReturnType<CodexForObsidianPlugin["derivePiConversation"]>
  >;
  try {
    derivation = await host.plugin.derivePiConversation({
      sourceConversationId: session.id,
      targetConversationId: newId("conversation"),
      anchorEntryId: entryId,
      title: derivedConversationTitle(
        session,
        entryId,
        host.plugin.settings.settingsLanguage
      )
    });
  } catch (error) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `新建会话失败：${errorMessage(error)}`,
      `Could not create a conversation: ${errorMessage(error)}`
    ));
    return;
  }
  if (
    derivation.sourceConversationId !== session.id
    || derivation.projection.catalog.conversationId === session.id
  ) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "新建会话失败：派生结果没有独立会话身份",
      "Could not create a conversation: the derived result has no independent conversation identity"
    ));
    return;
  }

  const targetId = derivation.projection.catalog.conversationId;
  let derived = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === targetId
  );
  if (!derived) {
    derived = createPiConversationShell(host, derivation.projection.catalog);
    host.plugin.settings.sessions.push(derived);
  }
  const resendImages = derivation.anchorRole === "user"
    ? piComposerImageAttachmentsForEntry(session, entryId)
    : [];
  copyPiImageAttachmentsForProjection(
    session,
    derived,
    derivation.projection.messages
  );
  applyPiConversationProjectionToShell(host, derived, derivation.projection);
  host.switchComposerDraft?.(derived.id);
  host.plugin.settings.activeSessionId = derived.id;
  host.inputEl.value = derivation.editorText;
  restoreSelectionDraft(host.inputEl, { ...emptySelectionDraft(derivation.editorText), annotations: derivation.anchorRole === "user" ? resendAnnotations : [], nextNumber: Math.max(0, ...resendAnnotations.map((annotation) => annotation.number)) + 1 });
  host.closeComposerMenus();
  host.attachments = resendImages;
  host.selectedSkill = null;
  host.inputEl.focus();
  host.inputEl.setSelectionRange(
    derivation.editorText.length,
    derivation.editorText.length
  );
  renderConversationShellChange(host);
  try {
    await persistPiConversationShells(host);
  } catch (error) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      `新会话已创建，但界面状态保存失败：${errorMessage(error)}`,
      `The new conversation was created, but its UI state could not be saved: ${errorMessage(error)}`
    ));
  }
  if (derivation.activation.status === "failed") {
    new Notice(
      conversationUiText(
        host.plugin.settings.settingsLanguage,
        `会话已创建，但 Agent 暂未激活：${derivation.activation.message}`,
        `The conversation was created, but the Agent is not active yet: ${derivation.activation.message}`
      )
    );
    return;
  }
  new Notice(derivation.anchorRole === "user"
    ? conversationUiText(host.plugin.settings.settingsLanguage, "已新建会话，可编辑原提问后发送", "A new conversation was created. You can edit the original question before sending it.")
    : conversationUiText(host.plugin.settings.settingsLanguage, "已从所选回复新建会话", "A new conversation was created from the selected reply"));
}

function enqueueConversationTransition<T>(
  host: CodexSessionHost,
  transition: () => Promise<T>
): Promise<T> {
  const previous = conversationTransitionLanes.get(host);
  let result: Promise<T>;
  try {
    result = previous ? previous.then(transition) : transition();
  } catch (error) {
    result = Promise.reject(error instanceof Error
      ? error
      : new Error(String(error)));
  }
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  conversationTransitionLanes.set(host, settled);
  void settled.then(() => {
    if (conversationTransitionLanes.get(host) === settled) {
      conversationTransitionLanes.delete(host);
    }
  });
  return result;
}

export async function renameSession(host: CodexSessionHost, session: StoredSession): Promise<void> {
  const language = host.plugin.settings.settingsLanguage;
  const name = await textInputModal(
    host.app,
    conversationUiText(language, "重命名会话", "Rename conversation"),
    conversationUiText(language, "名称", "Name"),
    session.title
  );
  const title = name?.trim();
  if (!title) return;
  const catalogEntry = await host.plugin.renamePiConversation(
    session.id,
    title
  );
  applyPiCatalogEntryToShell(session, catalogEntry);
  await persistPiConversationShells(host);
  host.renderTabs();
}

export async function archiveSession(
  host: CodexSessionHost,
  sessionId: string
): Promise<void> {
  const session = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === sessionId
  );
  if (!session) return;
  if (host.runningSessionIds.has(session.id)) {
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "当前会话正在运行，结束后再归档",
      "The current conversation is running. Archive it after it finishes."
    ));
    return;
  }
  const fallbackGeneration =
    host.plugin.settings.activeSessionId === session.id
      || isConversationSelectionTarget(host, session.id)
      ? beginConversationSelection(host)
      : undefined;
  await host.plugin.setPiConversationStatus(session.id, "archived");
  host.turnQueue.clearSessionQueue(session.id);
  removeConversationShell(host, session.id);
  const fallbackError = await activateFallbackConversation(
    host,
    fallbackGeneration
  );
  await persistPiConversationShells(host);
  renderConversationShellChange(host);
  new Notice(
    fallbackError
      ? conversationUiText(host.plugin.settings.settingsLanguage, "会话已归档，可在设置中恢复。无法打开后续会话，请重试。", "Conversation archived. You can restore it in Settings. Could not open the next conversation. Please try again.")
      : conversationUiText(host.plugin.settings.settingsLanguage, "会话已归档，可在设置中恢复。", "Conversation archived. You can restore it in Settings.")
  );
}

export async function deleteSession(host: CodexSessionHost, sessionId: string): Promise<void> {
  await deleteSessions(host, [sessionId]);
}

export async function discardUnacceptedSession(
  host: CodexSessionHost,
  sessionId: string
): Promise<boolean> {
  const session = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === sessionId
  );
  if (
    !session
    || session.messages.length > 0
    || host.runningSessionIds.has(sessionId)
  ) return false;
  const fallbackGeneration = host.plugin.settings.activeSessionId === sessionId
    || isConversationSelectionTarget(host, sessionId)
    ? beginConversationSelection(host)
    : undefined;
  await host.plugin.setPiConversationStatus(sessionId, "deleted");
  host.turnQueue.clearSessionQueue(sessionId);
  removeConversationShell(host, sessionId);
  const fallbackError = await activateFallbackConversation(
    host,
    fallbackGeneration
  );
  await persistPiConversationShells(host);
  renderConversationShellChange(host);
  if (fallbackError) throw fallbackError;
  return true;
}

export async function restoreArchivedConversation(
  host: CodexSessionHost,
  entry: Readonly<PiConversationCatalogEntry>
): Promise<boolean> {
  const restored = await host.plugin.setPiConversationStatus(entry.conversationId, "active");
  const existing = host.plugin.settings.sessions.find(
    (session) => session.id === restored.conversationId
  );
  if (existing) applyPiCatalogEntryToShell(existing, restored);
  else host.plugin.settings.sessions.push(createPiConversationShell(host, restored));
  await persistPiConversationShells(host);
  new Notice(conversationUiText(
    host.plugin.settings.settingsLanguage,
    `已恢复会话“${entry.title}”`,
    `Restored conversation “${entry.title}”`
  ));
  return true;
}

export async function deleteArchivedConversation(
  host: CodexSessionHost,
  entry: Readonly<PiConversationCatalogEntry>,
  options: ConversationRecordMutationUiOptions = {}
): Promise<boolean> {
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  const accepted = await confirm(
    conversationUiText(host.plugin.settings.settingsLanguage, `删除会话“${entry.title}”？`, `Delete conversation “${entry.title}”?`),
    conversationUiText(host.plugin.settings.settingsLanguage, "删除后无法在设置中恢复。", "You cannot restore this conversation in Settings after deletion."),
    conversationUiText(host.plugin.settings.settingsLanguage, "删除", "Delete"),
    conversationUiText(host.plugin.settings.settingsLanguage, "取消", "Cancel")
  );
  if (!accepted) return false;
  await host.plugin.setPiConversationStatus(entry.conversationId, "deleted");
  new Notice(conversationUiText(
    host.plugin.settings.settingsLanguage,
    "已删除会话",
    "Conversation deleted."
  ));
  return true;
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
    new Notice(conversationUiText(
      host.plugin.settings.settingsLanguage,
      "所选会话不可删除；知识库和运行中会话会被保留",
      "The selected conversations cannot be deleted; Knowledge and running conversations are kept."
    ));
    return;
  }
  const confirm = options.confirm ?? defaultRecordMutationConfirm(host);
  let committedCount = 0;
  let fallbackGeneration: number | undefined;
  for (const session of candidates) {
    try {
      const accepted = await confirm(
        conversationUiText(host.plugin.settings.settingsLanguage, `删除会话“${session.title}”？`, `Delete conversation “${session.title}”?`),
        conversationUiText(host.plugin.settings.settingsLanguage, "删除后无法在设置中恢复。", "You cannot restore this conversation in Settings after deletion."),
        conversationUiText(host.plugin.settings.settingsLanguage, "删除", "Delete"),
        conversationUiText(host.plugin.settings.settingsLanguage, "取消", "Cancel")
      );
      if (!accepted) continue;
      if (host.runningSessionIds.has(session.id)) {
        new Notice(conversationUiText(
          host.plugin.settings.settingsLanguage,
          `“${session.title}”正在运行，已跳过删除`,
          `“${session.title}” is running and was skipped`
        ));
        continue;
      }
      if (
        host.plugin.settings.activeSessionId === session.id
        || isConversationSelectionTarget(host, session.id)
      ) {
        fallbackGeneration = beginConversationSelection(host);
      }
      await host.plugin.setPiConversationStatus(session.id, "deleted");
      committedCount += 1;
      host.turnQueue.clearSessionQueue(session.id);
      removeConversationShell(host, session.id);
    } catch (error) {
      new Notice(
        conversationUiText(
          host.plugin.settings.settingsLanguage,
          `删除“${session.title}”失败：${errorMessage(error)}`,
          `Could not delete “${session.title}”: ${errorMessage(error)}`
        )
      );
    }
  }
  if (committedCount) {
    const fallbackError = await activateFallbackConversation(
      host,
      fallbackGeneration
    );
    await persistPiConversationShells(host);
    renderConversationShellChange(host);
    new Notice(
      fallbackError
        ? conversationUiText(
          host.plugin.settings.settingsLanguage,
          `${committedCount === 1 ? "已删除会话" : `已删除 ${committedCount} 个会话`}；无法打开后续会话，请重试。`,
          `${committedCount === 1 ? "Conversation deleted." : `${committedCount} conversations deleted.`} Could not open the next conversation. Please try again.`
        )
        : conversationUiText(
          host.plugin.settings.settingsLanguage,
          committedCount === 1 ? "已删除会话" : `已删除 ${committedCount} 个会话`,
          committedCount === 1 ? "Conversation deleted." : `${committedCount} conversations deleted.`
        )
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

function renderConversationShellChange(
  host: CodexSessionHost
): void {
  releaseInactiveConversationBodies(host);
  host.resetVirtualWindow();
  host.renderTabs();
  host.renderMessages({ forceBottom: true });
  host.renderToolbar();
  host.updateInputPlaceholder();
}

/**
 * Pi Session JSONL is the durable authority for every conversation body.
 * Keep only the currently open shell and in-flight runs resident so a long
 * history cannot retain every projected message array in the UI process.
 */
function releaseInactiveConversationBodies(host: CodexSessionHost): void {
  const retainedSessionIds = new Set<string>();
  if (host.plugin.settings.activeSessionId) {
    retainedSessionIds.add(host.plugin.settings.activeSessionId);
  }
  for (const sessionId of host.runningSessionIds) {
    retainedSessionIds.add(sessionId);
  }
  for (const session of host.plugin.settings.sessions) {
    if (!retainedSessionIds.has(session.id) && session.messages.length > 0) {
      session.messages = [];
    }
  }
}

function deletableSessions(host: CodexSessionHost, sessionIds: string[]): StoredSession[] {
  const requested = new Set(sessionIds);
  return host.plugin.settings.sessions.filter((session) => {
    if (!requested.has(session.id)) return false;
    return !host.runningSessionIds.has(session.id);
  });
}

export function ensureSession(host: CodexSessionHost): StoredSession {
  const session = selectActiveConversationSession(host.plugin.settings);
  if (session) return session;
  throw new Error(conversationUiText(
    host.plugin.settings.settingsLanguage,
    "Pi Conversation Catalog 中没有可打开的普通会话",
    "Pi Conversation Catalog has no openable regular conversation"
  ));
}

export async function ensureInitialConversation(
  host: CodexSessionHost
): Promise<{ session: StoredSession; created: boolean }> {
  const existing = selectActiveConversationSession(host.plugin.settings);
  if (existing) return { session: existing, created: false };
  return {
    session: await createSession(host),
    created: true
  };
}

export async function createSession(
  host: CodexSessionHost,
  title?: string,
  options: CreateSessionOptions = {}
): Promise<StoredSession> {
  return await createSessionForSelection(
    host,
    title ?? conversationUiText(host.plugin.settings.settingsLanguage, "新会话", "New conversation"),
    beginConversationSelection(host),
    options
  );
}

async function createSessionForSelection(
  host: CodexSessionHost,
  title: string,
  generation: number,
  options: CreateSessionOptions = {}
): Promise<StoredSession> {
  const conversationId = newId("conversation");
  let createdConversationId = conversationId;
  const previousActiveSessionId = host.plugin.settings.activeSessionId;
  let catalogCreated = false;
  bindConversationSelectionTarget(host, generation, conversationId);
  try {
    const catalogEntry = await host.plugin.createPiConversation({
      conversationId,
      title,
      ...normalizeConversationTaskMetadata(options),
      cwd: host.plugin.getVaultPath(),
      defaultMemoryMode: "normal",
      ...(options.defaultSkillId
        ? { defaultSkillId: options.defaultSkillId }
        : {}),
      ...(options.journalDirectory
        ? { journalDirectory: options.journalDirectory }
        : {})
    });
    createdConversationId = catalogEntry.conversationId;
    catalogCreated = true;
    const session = createPiConversationShell(host, catalogEntry);
    host.plugin.settings.sessions.push(session);
    const outcome = await enqueueConversationTransition(
      host,
      async () => await activateSessionInTransitionLane(
        host,
        session,
        generation
      )
    );
    if (outcome.status === "selected" && "error" in outcome) {
      throw outcome.error;
    }
    await persistPiConversationShells(host);
    return session;
  } catch (error) {
    if (catalogCreated) {
      await rollbackFailedSessionCreation(
        host,
        createdConversationId,
        previousActiveSessionId,
        generation,
        error
      );
    }
    throw error;
  }
}

async function rollbackFailedSessionCreation(
  host: CodexSessionHost,
  conversationId: string,
  previousActiveSessionId: string,
  generation: number,
  originalError: unknown
): Promise<void> {
  const session = host.plugin.settings.sessions.find(
    (candidate) => candidate.id === conversationId
  );
  if (session?.messages.length) return;

  const cleanupErrors: unknown[] = [];
  try {
    await host.plugin.setPiConversationStatus(conversationId, "deleted");
  } catch (error) {
    cleanupErrors.push(error);
  }
  host.turnQueue.clearSessionQueue(conversationId);
  removeConversationShell(host, conversationId);
  if (host.plugin.settings.activeSessionId === conversationId) {
    const restoredSessionId = host.plugin.settings.sessions.some(
      (candidate) => candidate.id === previousActiveSessionId
    )
      ? previousActiveSessionId
      : "";
    host.switchComposerDraft?.(restoredSessionId);
    host.plugin.settings.activeSessionId = restoredSessionId;
  }
  if (isCurrentConversationSelection(host, generation)) {
    beginConversationSelection(
      host,
      host.plugin.settings.activeSessionId || undefined
    );
  }
  try {
    await persistPiConversationShells(host);
  } catch (error) {
    cleanupErrors.push(error);
  }
  renderConversationShellChange(host);
  if (cleanupErrors.length) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      conversationUiText(
        host.plugin.settings.settingsLanguage,
        "新会话创建失败，且未能完整回滚",
        "Conversation creation failed and could not be fully rolled back"
      )
    );
  }
}

function derivedConversationTitle(
  source: StoredSession,
  anchorEntryId: string,
  language: "zh-CN" | "en"
): string {
  const anchorIndex = source.messages.findIndex(
    (message) => piEntryIdFromProjectedMessageId(message.id) === anchorEntryId
  );
  const anchor = source.messages[anchorIndex];
  const intent = anchor?.role === "user"
    ? anchor
    : source.messages
      .slice(0, Math.max(0, anchorIndex + 1))
      .reverse()
      .find((message) => message.role === "user");
  const preview = (intent?.text || intent?.previewText || "")
    .replace(/\s+/gu, " ")
    .trim();
  if (preview) {
    const clipped = preview.length > 28
      ? `${preview.slice(0, 27)}…`
      : preview;
    return conversationUiText(language, `新会话 · ${clipped}`, `New conversation · ${clipped}`);
  }
  const sourceTitle = source.title.trim();
  const newConversation = conversationUiText(language, "新会话", "New conversation");
  return !sourceTitle || sourceTitle === "新会话" || sourceTitle === "New conversation"
    ? newConversation
    : conversationUiText(language, `继续 · ${sourceTitle}`, `Continue · ${sourceTitle}`);
}

export function sessionById(host: CodexSessionHost, sessionId: string): StoredSession | null {
  return host.plugin.settings.sessions.find((session) => session.id === sessionId) ?? null;
}

export function activeRunSession(host: CodexSessionHost): StoredSession {
  const active = host.activeRunSessionId ? host.plugin.settings.sessions.find((session) => session.id === host.activeRunSessionId) : null;
  return active ?? ensureSession(host);
}

export function createPiConversationShell(
  host: CodexSessionHost,
  catalogEntry: Readonly<PiConversationCatalogEntry>
): StoredSession {
  return applyPiCatalogEntryToShell({
    id: catalogEntry.conversationId,
    title: catalogEntry.title,
    cwd: host.plugin.getVaultPath(),
    messages: [],
    createdAt: catalogEntry.createdAt,
    updatedAt: catalogEntry.updatedAt
  }, catalogEntry);
}

function applyPiCatalogEntryToShell(
  shell: StoredSession,
  catalogEntry: Readonly<PiConversationCatalogEntry>
): StoredSession {
  // Old catalogs lack a metadata revision. Retain their existing settings-only
  // projection until the plugin imports it; stamped catalogs own all task fields.
  if (catalogEntry.taskMetadataUpdatedAt !== undefined) {
    // On the same revision, the shell may carry edits made during an awaited
    // save. Preserve them for the next sync; a late older projection cannot win.
    if (shell.taskMetadataUpdatedAt === undefined || catalogEntry.taskMetadataUpdatedAt > shell.taskMetadataUpdatedAt) {
      applyConversationTaskMetadata(shell, catalogEntry);
    }
  } else {
    applyConversationTaskMetadata(shell, { ...catalogEntry, ...shell });
  }
  shell.title = catalogEntry.title;
  shell.piSessionId = catalogEntry.piSessionId;
  shell.defaultMemoryMode = catalogEntry.defaultMemoryMode;
  if (catalogEntry.defaultSkillId) {
    shell.defaultSkillId = catalogEntry.defaultSkillId;
  } else {
    delete shell.defaultSkillId;
  }
  if (catalogEntry.journalDirectory) {
    shell.journalDirectory = catalogEntry.journalDirectory;
  } else {
    delete shell.journalDirectory;
  }
  shell.bodyAuthority = "pi_session_only";
  shell.createdAt = catalogEntry.createdAt;
  shell.updatedAt = catalogEntry.updatedAt;
  return shell;
}

export function applyPiConversationProjectionToShell(
  host: CodexSessionHost,
  shell: StoredSession,
  projection: Readonly<PiConversationProjection>
): void {
  rememberPiConversationProjection(host.plugin, projection);
  applyPiCatalogEntryToShell(shell, projection.catalog);
  shell.messages = projectPiImageAttachments(
    shell,
    structuredClone(projection.messages)
  );
  if (projection.contextLedger) {
    shell.contextLedger = structuredClone(projection.contextLedger);
  } else {
    delete shell.contextLedger;
  }
}

function removeConversationShell(
  host: CodexSessionHost,
  conversationId: string
): void {
  host.plugin.settings.sessions = host.plugin.settings.sessions.filter(
    (session) => session.id !== conversationId
  );
}

async function activateFallbackConversation(
  host: CodexSessionHost,
  selectionGeneration?: number
): Promise<Error | null> {
  const active = host.plugin.settings.sessions.find(
    (session) => session.id === host.plugin.settings.activeSessionId
  );
  if (active) return null;
  const generation = selectionGeneration
    ?? beginConversationSelection(host);
  if (!isCurrentConversationSelection(host, generation)) return null;
  const fallback = host.plugin.settings.sessions[0];
  if (!fallback) {
    try {
      await createSessionForSelection(
        host,
        conversationUiText(host.plugin.settings.settingsLanguage, "新会话", "New conversation"),
        generation
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
  if (!bindConversationSelectionTarget(host, generation, fallback.id)) {
    return null;
  }
  const outcome = await enqueueConversationTransition(
    host,
    async () => await activateSessionInTransitionLane(
      host,
      fallback,
      generation
    )
  );
  if (outcome.status === "stale" || !("error" in outcome)) return null;
  return outcome.error instanceof Error
    ? outcome.error
    : new Error(String(outcome.error));
}

async function persistPiConversationShells(
  host: CodexSessionHost
): Promise<void> {
  await host.plugin.saveSettings(true, {
    flushConversationStore: false
  });
}

function conversationShellFingerprint(host: CodexSessionHost): string {
  return JSON.stringify({
    activeSessionId: host.plugin.settings.activeSessionId,
    sessions: host.plugin.settings.sessions.map((session) => ({
      id: session.id,
      ...normalizeConversationTaskMetadata(session),
      title: session.title,
      piSessionId: session.piSessionId,
      defaultMemoryMode: session.defaultMemoryMode,
      defaultSkillId: session.defaultSkillId,
      journalDirectory: session.journalDirectory,
      bodyAuthority: session.bodyAuthority,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    }))
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
