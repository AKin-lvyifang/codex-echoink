import { getExcalidrawService } from "../../excalidraw/service";
import { repairQueuedXiaoechoModelSelection } from "../xiaoecho-selection";
export { repairQueuedXiaoechoModelSelection } from "../xiaoecho-selection";
import { agentCapabilityErrorText } from "../../agents/capability-denial";
import { runErrors } from "../../run-reports/recent-errors";
import { pdfAttachmentReceipt } from "../../pdf-reading/attachment-receipt";
import { isPiConversationPersistenceError } from "../../harness/pi-native/pi-conversation-persistence-error";
import { freezeWorkbenchTaskSource } from "../../home/workbench-context";
import { isPdfReadingIntent } from "../../pdf-reading/intent";
import { buildPiSelectionAnnotationContextMessage } from "../../harness/pi-native/pi-selection-annotations";
import { composerSelectionAnnotations, restoreSelectionDraft, emptySelectionDraft } from "../../selection-ask/draft";
import { cloneSelectionAnnotations, selectionAnnotationsMatch, type SelectionAnnotation } from "../../types/selection-annotations";
import { Notice } from "obsidian";
import { isTurnWatchdogProgressEvent } from "../turn-watchdog";
import type {
  PiChatPreparedImage,
  PiChatPreparedDocument,
  PiChatRuntimeEvent,
  PiConversationMemoryMode,
  PiConversationProjection,
  PiProductRunRecord,
  PiProductRunTerminalState,
  PiTaskPlanTransitionRequest
} from "../../harness/pi-native/contracts";
import { PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE } from "../../harness/pi-native/contracts";
import { PROVIDER_FAILURE_DETAIL_PREFIX, providerFailureText } from "../../harness/pi/provider-failure";
import { CAUSE, joinErrorCopy, NEXT, userFacingErrorText, ACTION_FAILED } from "../../core/error-copy";
import {
  PiChatUiProjector,
  piEntryIdFromProjectedMessageId,
  piProjectedEntryMessageId,
  piRuntimeMessageKeyFromProjectedMessageId,
  piToolCallIdFromProjectedMessageId,
  type PiChatUiRunState,
  type PiChatUiViewModel
} from "../../harness/pi-native/pi-chat-ui-projector";
import type {
  ApiProviderConfig,
  ApiProviderModelConfig,
  ChatMessage,
  StoredAttachment,
  StoredSession
} from "../../settings/settings";
import {
  apiProviderModelSupportsImage,
  apiProviderHasUsableCredential,
  getApiProviderModel,
  newId,
  validateApiProvider
} from "../../settings/settings";
import { composerPrimaryActionForState } from "../composer-state";
import { canStartQueuedTurn, canInsertQueuedTurn, type QueuedTurnItem } from "../turn-queue";
import { enabledSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { CodexViewTurnContext, MessageRenderFollowContext, QueuedTurnOutcome, QueuedTurnSource } from "./runner-context";
import {
  projectPiImageAttachments,
  recordPiDocumentReplayForEntry,
  recordPiImageAttachmentsForEntry,
  rememberPiConversationProjection,
  selectedPiConversationDraftId
} from "./pi-conversation-support";
import { routeKnowledgeConversationCommand } from "../../knowledge-base/commands";
import { isMaintenanceScopeConfirmation } from "../../harness/pi-native/maintenance-scope-context";
import {
  PiImageInputError,
  preparePiChatImages
} from "./pi-image-input";
import {
  PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER,
  type PiDocumentCapabilityTarget
} from "../../harness/pi-native/pi-document-context";
import {
  buildPiDocumentContext,
  PiDocumentInputError,
  preparePiChatDocuments,
  reconcilePiDocumentTransports,
  type PiChatPreparedDocumentSet
} from "./pi-document-input";
import {
  calculatePiEffectiveInputBudget,
  estimatePiContextTokens
} from "../../harness/pi-native/pi-context-budget";
import {
  cloneEchoInkAssistantTurn
} from "../../types/conversation-turn";
import {
  isEchoInkPiReasoningEffortSupported,
  resolveEchoInkPiReasoningCapabilities
} from "../../settings/pi-model-catalog";
import type { TurnOptions } from "../turn-options";
import {
  addComposerNoteMentionSelection,
  composerNoteMentionSelections,
  snapshotComposerNoteMentions
} from "./note-mentions";
import {
  conversationUiText,
  localizeKnownConversationSystemCopy
} from "./ui-i18n";

const activeComposerTransfers = new WeakMap<
  CodexViewTurnContext,
  Readonly<QueuedTurnItem>
>();

const submittedPiAccess = new WeakMap<
  CodexViewTurnContext["plugin"],
  Map<string, Pick<TurnOptions, "permission" | "mode">>
>();

function uiText(
  view: Pick<CodexViewTurnContext, "plugin" | "onPiRunFailure">,
  zh: string,
  en: string
): string {
  return conversationUiText(
    view.plugin?.settings?.settingsLanguage ?? "zh-CN",
    zh,
    en
  );
}

function showNotice(
  view: Pick<CodexViewTurnContext, "plugin" | "onPiRunFailure">,
  zh: string,
  en: string
): void {
  reportPiRunFailure(view, uiText(view, zh, en));
}

function reportPiRunFailure(view: Pick<CodexViewTurnContext, "onPiRunFailure">, message: string): void {
  if (view.onPiRunFailure?.(message) !== true) new Notice(message);
}

/** "What happened" plus the user-facing reason when there is one, otherwise the scene's next step. */
function failureNotice(
  view: Pick<CodexViewTurnContext, "plugin">,
  error: unknown,
  lead: readonly [string, string],
  next: readonly [string, string]
): string {
  const reason = localizedPiChatErrorMessage(view, error, "");
  const en = view.plugin?.settings?.settingsLanguage === "en";
  return `${uiText(view, ...lead)}${en ? " " : ""}${reason || uiText(view, ...next)}`;
}

export async function sendMessage(view: CodexViewTurnContext): Promise<void> {
  if (view.lifecycleSignal?.aborted || (view.queueStartInProgress && !view.activeRunId)) return;
  const session = view.ensureSession();
  const action = composerPrimaryActionForState(view.composerStateForSession(session));
  if (
    view.turnQueue.isSessionRecoveryRequired(session.id)
    && action !== "stop-turn"
    && action !== "cancel-knowledge-task"
  ) {
    showNotice(
      view,
      "上一次任务的记录尚未整理完成，暂时无法开始新任务。请重新加载插件后重试。",
      "The previous task record is still being finalized, so a new task cannot start. Reload the plugin and try again."
    );
    return;
  }
  if (action === "enqueue") {
    await view.enqueueComposerDraft();
    return;
  }
  if (action === "resume-queue") {
    await view.resumeQueuedTurns(session.id);
    return;
  }
  if (action === "stop-turn") {
    if (
      view.running
      && view.activeRunSessionId
      && view.activeRunSessionId !== session.id
    ) {
      showNotice(
        view,
        "另一个会话正在运行；可继续浏览或填写草稿，当前运行不会被停止。",
        "Another conversation is running. You can keep browsing or draft a message without stopping it."
      );
      return;
    }
    await view.stopTurn();
    return;
  }
  if (action === "cancel-knowledge-task") {
    showNotice(
      view,
      "旧知识库 Agent 运行时已退场；请在普通 EchoInk 会话中使用 /maintain。",
      "The legacy Knowledge Agent runtime is no longer available. Use /maintain in a regular EchoInk conversation."
    );
    return;
  }
  view.queueStartInProgress = true;
  let item: QueuedTurnItem | null = null;
  let outcome: QueuedTurnOutcome = "cancelled";
  try {
    item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: true });
    if (!item || view.lifecycleSignal?.aborted) return;
    outcome = await view.startQueuedTurnItemSafely(item, "composer");
  } finally {
    view.queueStartInProgress = false;
    if (item) view.onComposerTransferFinished?.(item, outcome);
    view.renderToolbar();
  }
  if (item && outcome !== "running") {
    await view.afterTurnSettled(item.sessionId, outcome === "completed");
  }
}

export function piChatMemoryModeForGlobalSetting(
  useLongTermMemory: boolean
): PiConversationMemoryMode {
  return useLongTermMemory ? "normal" : "no_memory";
}

export async function enqueueComposerDraft(view: CodexViewTurnContext): Promise<void> {
  if (view.lifecycleSignal?.aborted) return;
  const item = await view.createQueuedTurnFromComposer({ allowLocalKnowledgeCommands: false });
  if (!item) return;
  view.turnQueue.enqueue(item);
  // Enter always freezes a complete next turn. Insertion is an explicit queue action.
  clearComposerAfterPiAcceptance(view, item, "composer");
  view.onComposerTransferFinished?.(item, "queued");
  view.renderQueue();
  view.renderToolbar();
  if (!view.composerStateForSession(view.ensureSession()).viewRunning && !view.turnQueue.isSessionQueuePaused(item.sessionId)
    && !view.turnQueue.isSessionRecoveryRequired(item.sessionId)) {
    void view.startNextQueuedTurn(item.sessionId);
  }
}

const insertingQueuedTurns = new Set<string>();
export async function insertQueuedTurnIntoActiveRun(
  view: Pick<CodexViewTurnContext, "plugin" | "turnQueue" | "running" | "activeRunSessionId" | "renderQueue" | "renderToolbar">,
  sessionId: string, itemId: string
): Promise<void> {
  const item = view.turnQueue.itemsForSession(sessionId).find(value => value.id === itemId);
  if (!item || !canInsertQueuedTurn(item) || !view.running || view.activeRunSessionId !== sessionId
    || view.turnQueue.isSessionQueuePaused(sessionId) || view.turnQueue.isSessionRecoveryRequired(sessionId) || insertingQueuedTurns.has(itemId)) return;
  const access = submittedPiAccess.get(view.plugin)?.get(sessionId);
  if (!access || access.permission !== item.turnOptions.permission || access.mode !== item.turnOptions.mode) {
    showNotice(view, "该消息的权限或模式与当前任务不同，已保留在队列中待发送。", "This message uses different access or mode settings and was kept in the queue."); return;
  }
  insertingQueuedTurns.add(itemId);
  try {
    await view.plugin.steerPiConversation(sessionId, item.text);
    view.turnQueue.removeQueuedItem(sessionId, itemId);
  } catch (error) {
    new Notice(failureNotice(view, error,
      ["消息未能插入当前任务。", "The message could not be added to the current task."],
      ["该消息仍在队列中，请稍后重新插入。", "It is still in the queue; try inserting it again later."]));
  } finally { insertingQueuedTurns.delete(itemId); view.renderQueue(); view.renderToolbar(); }
}

export async function steerPiChatFromComposer(
  view: CodexViewTurnContext
): Promise<void> {
  const session = view.ensureSession();
  if (!isActivePiChatRun(view, session)) {
    showNotice(view, "当前无正在进行的回答。请直接发送该内容。", "No answer is in progress. Send this as a new message.");
    return;
  }
  const text = view.inputEl.value.trim();
  if (!text) return;
  if (
    view.attachments.length
    || composerSelectionAnnotations(view.inputEl).length
    || composerNoteMentionSelections(view.inputEl).length
    || view.selectedSkill
  ) {
    showNotice(
      view,
      "调整方向只支持文字；附件或 Skill 请留到下一轮发送。",
      "Steering supports text only. Send attachments or a Skill in the next turn."
    );
    return;
  }
  const options = view.currentTurnOptions(session);
  const access = submittedPiAccess.get(view.plugin)?.get(session.id);
  if (access?.permission !== options.permission || access.mode !== options.mode) {
    await enqueueComposerDraft(view);
    return;
  }
  const acceptedDraft: QueuedTurnItem = {
    id: newId("steering-draft"), sessionId: session.id, text, composerTextSnapshot: view.inputEl.value,
    attachments: [], skill: null, turnOptions: { ...options }, kind: "chat", createdAt: Date.now()
  };
  try {
    await view.plugin.steerPiConversation(session.id, text);
    clearComposerAfterPiAcceptance(view, acceptedDraft, "composer");
    view.renderQueue();
    view.renderToolbar();
    showNotice(view, "已调整当前任务的方向", "Updated the direction of the current task.");
  } catch (error) {
    new Notice(failureNotice(view, error,
      ["未能调整当前任务的方向。", "Could not change the direction of the current task."],
      ["请等待当前回答结束后，将该内容作为新消息发送。", "Wait for the current answer to finish, then send it as a new message."]));
  }
}

export async function handlePiTaskPlanAction(
  view: CodexViewTurnContext,
  planId: string,
  action: PiTaskPlanTransitionRequest["action"]
): Promise<void> {
  const session = view.ensureSession();
  if (
    session.bodyAuthority !== "pi_session_only"
  ) {
    showNotice(view, "该任务计划不属于当前会话。请返回其所在会话后操作。", "This task plan belongs to another conversation. Open that conversation to change it.");
    return;
  }
  if ((view.running || view.queueStartInProgress) && action !== "pause") {
    showNotice(view, "当前计划正在执行，请先暂停。", "The current plan is running. Pause it first.");
    return;
  }
  try {
    await view.plugin.transitionPiTaskPlan({
      conversationId: session.id,
      planId,
      action
    });
    const projection = await view.plugin.readPiConversationProjection(
      session.id
    );
    rememberPiConversationProjection(view.plugin, projection);
    applyPiConversationProjection(session, projection);
    view.renderMessagesIfActive(session);

    if (action === "pause") {
      showNotice(view, "任务计划已暂停", "Task plan paused.");
      return;
    }
    if (action === "cancel") {
      showNotice(view, "任务计划已取消", "Task plan cancelled.");
      return;
    }

    const item: QueuedTurnItem = {
      id: newId("queued-turn"),
      sessionId: session.id,
      text: action === "execute"
        ? `执行任务计划 ${planId}，从当前步骤开始，并用 task_update 持续写入结构化状态。`
        : `继续执行任务计划 ${planId}，从暂停的当前步骤继续，并用 task_update 持续写入结构化状态。`,
      attachments: [],
      skill: null,
      turnOptions: {
        ...view.currentTurnOptions(session),
        mode: "agent"
      },
      kind: "chat",
      createdAt: Date.now()
    };
    const outcome = await view.startQueuedTurnItemSafely(item, "queue");
    if (outcome === "failed" || outcome === "cancelled") {
      let latest = await view.plugin.readPiConversationProjection(session.id);
      const activePlan = latest.messages.find(
        (message) => message.taskPlan?.planId === planId
      )?.taskPlan;
      if (activePlan?.status === "in_progress") {
        await view.plugin.transitionPiTaskPlan({
          conversationId: session.id,
          planId,
          action: "pause"
        });
        latest = await view.plugin.readPiConversationProjection(session.id);
      }
      rememberPiConversationProjection(view.plugin, latest);
      applyPiConversationProjection(session, latest);
      view.renderMessagesIfActive(session);
    }
    if (outcome !== "running") {
      await view.afterTurnSettled(session.id, outcome === "completed");
    }
  } catch (error) {
    new Notice(failureNotice(view, error,
      ["任务计划未能更新。", "The task plan could not be updated."],
      ["请重新打开该会话后重试。", "Reopen this conversation and try again."]));
  }
}

export async function resumeQueuedTurns(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  if (view.turnQueue.isSessionRecoveryRequired(sessionId)) {
    showNotice(
      view,
      "上一次任务的记录尚未整理完成，排队的消息暂时无法继续发送。请重新加载插件后重试。",
      "The previous task record is still being finalized, so queued messages cannot continue. Reload the plugin and try again."
    );
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.turnQueue.resumeSessionQueue(sessionId);
  view.renderQueue();
  view.renderToolbar();
  await view.startNextQueuedTurn(sessionId);
}

export async function afterTurnSettled(view: CodexViewTurnContext, sessionId: string, succeeded: boolean): Promise<void> {
  const settlement = view.turnQueue.settleSessionQueue(sessionId, succeeded);
  if (settlement === "continue") {
    await view.startNextQueuedTurn(sessionId);
  }
  view.renderQueue();
  view.renderToolbar();
}

export function messageRenderOptionsForRunUpdate(view: MessageRenderFollowContext): { forceBottom: boolean; preserveScroll: boolean } {
  const forceBottom = !view.messagesBottomFollowPaused;
  return { forceBottom, preserveScroll: !forceBottom };
}

export function selectFirstNonBlankText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

export async function startNextQueuedTurn(view: CodexViewTurnContext, sessionId: string): Promise<void> {
  if (view.lifecycleSignal?.aborted) return;
  if (!canStartQueuedTurn({
    queueStartInProgress: view.queueStartInProgress,
    viewRunning: view.running,
    knowledgeTaskRunning: false
  })) return;
  const item = view.turnQueue.peekNext(sessionId);
  if (!item) {
    view.renderQueue();
    view.renderToolbar();
    return;
  }
  view.queueStartInProgress = true;
  view.renderQueue();
  view.renderToolbar();
  let outcome: QueuedTurnOutcome = "failed";
  let headChangedDuringActivation = false;
  if (item.clearComposerAfterPiAcceptance === true) {
    activeComposerTransfers.set(view, item);
  }
  try {
    if (!await prepareTurnProviderModel(view, item, true)) {
      view.turnQueue.pauseSessionQueue(sessionId);
      return;
    }
    const current = view.turnQueue.peekNext(sessionId);
    if (!current || current.id !== item.id) {
      headChangedDuringActivation = true;
    } else {
      outcome = await startPreparedQueuedTurnItemSafely(view, item, "queue");
    }
  } finally {
    if (activeComposerTransfers.get(view)?.id === item.id) {
      activeComposerTransfers.delete(view);
    }
    view.queueStartInProgress = false;
    view.renderQueue();
    view.renderToolbar();
  }
  if (headChangedDuringActivation) {
    if (
      view.turnQueue.hasQueuedItems(sessionId)
      && !view.turnQueue.isSessionQueuePaused(sessionId)
    ) await view.startNextQueuedTurn(sessionId);
    return;
  }
  if (outcome !== "running") {
    const retainedBeforePiAcceptance = view.turnQueue
      .itemsForSession(item.sessionId)
      .some((candidate) => candidate.id === item.id);
    await view.afterTurnSettled(item.sessionId, outcome === "completed");
    if (retainedBeforePiAcceptance && outcome !== "completed") {
      showNotice(
        view,
        "排队的消息未能发送，队列已暂停。请确认模型可用后点击“继续”。",
        "The queued message could not be sent, so the queue is paused. Check that the model is available, then click Continue."
      );
    }
  }
}

export async function createQueuedTurnFromComposer(view: CodexViewTurnContext, options: { allowLocalKnowledgeCommands: boolean; onError?: (message: string) => void; frozenNoteMentions?: QueuedTurnItem["noteMentions"] }): Promise<QueuedTurnItem | null> {
  const session = view.ensureSession();
  const currentOptions = view.currentTurnOptions(session);
  // Unavailable credentials can hide the effective model. Keep the user's
  // selection in the failed snapshot so repairing credentials can retry it.
  const turnOptions = { ...currentOptions, model: currentOptions.model || view.selectedModel, drawingRequested: view.drawingRequested === true };
  const text = view.inputEl.value.trim();
  const composerTextSnapshot = view.inputEl.value;
  const attachments = view.attachments.map((attachment) => ({ ...attachment }));
  const skill = view.selectedSkill ? { ...view.selectedSkill } : null;
  const selectedNoteMentions = composerNoteMentionSelections(view.inputEl);
  const selectionAnnotations = composerSelectionAnnotations(view.inputEl);
  if (selectionAnnotations.length && !text) {
    options.onError?.(uiText(view, "请先输入问题，再发送注释。", "Enter a question before sending annotations."));
    showNotice(view, "请先输入问题，再发送注释。", "Enter a question before sending annotations."); return null;
  }
  if (!text && !attachments.length && !selectedNoteMentions.length && !skill) return null;
  const piDraftId = session.bodyAuthority === "pi_session_only"
    ? selectedPiConversationDraftId(view.plugin, session.id)
    : undefined;
  const snapshot: QueuedTurnItem = {
    id: newId("queued-turn"), sessionId: session.id, text, composerTextSnapshot,
    attachments, skill, turnOptions, kind: "chat", createdAt: Date.now(),
    noteMentions: selectedNoteMentions.map(mention => ({ ...mention, content: "" })),
    selectionAnnotations, composerPreparationRequired: true, ...(piDraftId ? { piDraftId } : {})
  };
  repairQueuedXiaoechoModelSelection(view.plugin.settings, snapshot);
  if (view.onComposerTransferStarted) { snapshot.composerDraftTransferred = true; view.onComposerTransferStarted(snapshot); }
  const onError = options.onError;
  options = { ...options, onError: message => { onError?.(message); view.onComposerTransferError?.(snapshot.id, message); } };
  let prepared = false;
  try {
  const workspaceReady = await view.ensureChatWorkspaceSelected(session);
  if (!workspaceReady || view.lifecycleSignal?.aborted) {
    options.onError?.(uiText(view, "工作区尚未就绪，消息未发送。文字和附件已保留。", "The workspace is not ready. The draft and attachments were kept."));
    return null;
  }
  let noteMentions: Awaited<ReturnType<typeof snapshotComposerNoteMentions>>;
  try {
    noteMentions = options.frozenNoteMentions ? options.frozenNoteMentions.map(mention => ({ ...mention }))
      : await snapshotComposerNoteMentions(view.app, view.inputEl, selectedNoteMentions);
    snapshot.noteMentions = noteMentions; snapshot.preparedNoteMentions = noteMentions;
    view.onComposerTransferPrepared?.(snapshot);
  } catch (error) {
    options.onError?.(localizedPiChatErrorMessage(view, error));
    reportPiRunFailure(view, localizedPiChatErrorMessage(view, error));
    return null;
  }
  if (session.cwd) turnOptions.cwd = session.cwd;
  repairQueuedXiaoechoModelSelection(view.plugin.settings, snapshot);
  if (!frozenTurnReasoningSelectionIsValid(
    view.plugin.settings,
    turnOptions
  )) {
    options.onError?.(uiText(view, CAUSE.providerModelRemoved[0], CAUSE.providerModelRemoved[1]));
    showNotice(
      view,
      CAUSE.providerModelRemoved[0],
      CAUSE.providerModelRemoved[1]
    );
    return null;
  }
  let preparedDocuments: readonly Readonly<PiChatPreparedDocument>[] = Object.freeze([]);
  const documentAttachments = attachments.filter(
    (attachment) => attachment.type === "file"
  );
  const submittedText = text
    || (noteMentions.length
      ? "请结合我提及的笔记继续。"
      : documentAttachments.length
        ? "请阅读我附加的文档，并根据文档内容回应。"
        : "");
  if (
    documentAttachments.length
    && routeKnowledgeConversationCommand(submittedText).kind !== "maintain"
  ) {
    const provider = view.plugin.settings.apiProviders.find(
      (candidate) => candidate.id === turnOptions.providerSettingsId
    );
    if (!provider) {
      options.onError?.(uiText(view, CAUSE.providerModelRemoved[0], CAUSE.providerModelRemoved[1]));
      showNotice(
        view,
        CAUSE.providerModelRemoved[0],
        CAUSE.providerModelRemoved[1]
      );
      return null;
    }
    try {
      const prepared = await preparePiChatDocuments(documentAttachments, {
        pdfToolReference: isPdfReadingIntent(submittedText, documentAttachments.some(a => /\.pdf$/iu.test(a.name) || a.mimeType === "application/pdf")) && view.plugin.settings.pdfReading?.enabled === true && view.plugin.pdfReading?.policy().canWrite === true,
        availableInputTokens: availableDocumentInputTokens(
          view,
          session,
          { turnOptions, noteMentions, selectionAnnotations },
          submittedText
        ),
        capabilityTarget: piDocumentCapabilityTarget(provider, turnOptions.model)
      });
      preparedDocuments = prepared.documents;
    } catch (error) {
      options.onError?.(localizedPiChatErrorMessage(view, error));
      reportPiRunFailure(view, localizedPiChatErrorMessage(view, error));
      return null;
    }
  }
  if (view.isComposerTransferCancelled?.(snapshot.id) || view.lifecycleSignal?.aborted) return null;
  prepared = true;
  const result: QueuedTurnItem = {
    ...snapshot,
    composerPreparationRequired: false,
    sessionId: session.id,
    text,
    composerTextSnapshot,
    attachments,
    ...(preparedDocuments.length ? { preparedDocuments } : {}),
    noteMentions,
    selectionAnnotations,
    skill,
    turnOptions,
    kind: "chat",
    createdAt: Date.now(),
    ...(piDraftId ? { piDraftId } : {})
  };
  view.onComposerTransferPrepared?.(result);
  return result;
  } finally {
    if (!prepared) view.onComposerTransferFinished?.(snapshot, "failed");
  }
}

export async function startQueuedTurnItem(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  repairQueuedXiaoechoModelSelection(view.plugin.settings, item);
  if (item.composerPreparationRequired) {
    // This data-only input keeps retries independent from whichever draft is visible now.
    const input = { value: item.composerTextSnapshot ?? item.text } as HTMLTextAreaElement;
    restoreSelectionDraft(input, { ...emptySelectionDraft(input.value), annotations: cloneSelectionAnnotations(item.selectionAnnotations ?? []) });
    for (const mention of item.noteMentions ?? []) addComposerNoteMentionSelection(input, mention);
    const adapter = Object.create(view) as CodexViewTurnContext;
    const submissionId = item.id;
    Object.defineProperties(adapter, {
      inputEl: { value: input }, attachments: { value: item.attachments }, selectedSkill: { value: item.skill }, drawingRequested: { value: item.turnOptions.drawingRequested },
      ensureSession: { value: () => view.sessionById(item.sessionId)! }, currentTurnOptions: { value: () => item.turnOptions },
      onComposerTransferStarted: { value: undefined }, onComposerTransferFinished: { value: undefined }, isComposerTransferCancelled: { value: undefined },
      onComposerTransferPrepared: { value: (prepared: QueuedTurnItem) => { Object.assign(item, prepared, { id: submissionId }); } }
    });
    const prepared = await createQueuedTurnFromComposer(adapter, { allowLocalKnowledgeCommands: false, frozenNoteMentions: item.preparedNoteMentions });
    if (!prepared) return "failed";
    Object.assign(item, prepared, { id: item.id, composerDraftTransferred: true });
  }
  const ownsStart = !view.queueStartInProgress;
  if (ownsStart) view.queueStartInProgress = true;
  try {
    const retainQueueHead = source === "queue" && view.turnQueue.itemsForSession(item.sessionId).some(queued => queued.id === item.id);
    if (!await prepareTurnProviderModel(view, item, retainQueueHead)) return "failed";
    return await startPreparedQueuedTurnItem(view, item, source);
  } finally {
    if (ownsStart) view.queueStartInProgress = false;
  }
}

async function startPreparedQueuedTurnItem(
  view: CodexViewTurnContext,
  item: QueuedTurnItem,
  source: QueuedTurnSource
): Promise<QueuedTurnOutcome> {
  const session = view.sessionById(item.sessionId);
  if (!session) {
    showNotice(view, "队列所属会话已不存在", "The conversation for this queued item no longer exists.");
    return "failed";
  }
  return await view.startChatTurn(session, item, source);
}

export async function startQueuedTurnItemSafely(view: CodexViewTurnContext, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  try {
    return await view.startQueuedTurnItem(item, source);
  } catch (error) {
    runErrors.record("desktop.turn.finalization", error, { conversationId: item.sessionId, runId: item.id });
    reportPiRunFailure(view, failureNotice(view, error,
      ["本次任务未正常结束。", "This task did not finish normally."],
      ["请重新打开该会话核对内容后，再决定是否重新发送。", "Reopen this conversation to check its content before deciding whether to resend."]));
    return "failed";
  }
}

async function startPreparedQueuedTurnItemSafely(
  view: CodexViewTurnContext,
  item: QueuedTurnItem,
  source: QueuedTurnSource
): Promise<QueuedTurnOutcome> {
  try {
    return await startPreparedQueuedTurnItem(view, item, source);
  } catch (error) {
    runErrors.record("desktop.turn.finalization", error, { conversationId: item.sessionId, runId: item.id });
    reportPiRunFailure(view, failureNotice(view, error,
      ["本次任务未正常结束。", "This task did not finish normally."],
      ["请重新打开该会话核对内容后，再决定是否重新发送。", "Reopen this conversation to check its content before deciding whether to resend."]));
    return "failed";
  }
}

/** Shared preflight for a list draft before creating its durable Conversation. */
export async function validateTaskTurnBeforeCreation(view: CodexViewTurnContext, item: QueuedTurnItem): Promise<boolean> {
  if (item.englishDiarySourcePath) {
    try {
      if (item.turnOptions.mode === "plan" || item.turnOptions.permission === "read-only") throw new Error("生成英文日记需要可写工作区和 Agent 模式。");
      if (item.attachments.length || item.noteMentions?.length || item.selectionAnnotations?.length || item.skill) throw new Error("英文日记仅按已确认的发送范围处理。请移除额外的附件、引用和技能。");
      await view.plugin.validateEnglishDiaryTaskSource(item.englishDiarySourcePath);
    } catch (error) {
      reportPiRunFailure(view, userFacingErrorText(error, uiText(view, "英文日记任务未能开始。请检查所选日记后重试。", "The English diary task could not start. Check the selected diary and try again."), view.plugin.settings.settingsLanguage));
      return false;
    }
  }
  return await prepareTurnProviderModel(view, item, false);
}

async function prepareTurnProviderModel(
  view: CodexViewTurnContext,
  item: Pick<QueuedTurnItem, "turnOptions" | "text" | "attachments" | "piUserEntryAccepted">,
  retainQueueHead: boolean
): Promise<boolean> {
  repairQueuedXiaoechoModelSelection(view.plugin.settings, item);
  const selection = item.turnOptions;
  const settings = view.plugin.settings;
  const target = settings.apiProviders.find(
    (provider) => provider.id === selection.providerSettingsId
  );
  const targetModel = target && getApiProviderModel(target, selection.model);
  if (selection.drawingRequested) {
    const reason = selection.mode === "plan" ? "计划模式只讨论方案，请切换到 Agent 模式后画图。"
      : selection.permission === "read-only" ? "当前是只读权限，请允许写入后再画图。"
        : targetModel?.toolCalling === false ? "当前模型不支持工具调用，请选择支持工具的模型后画图。"
          : getExcalidrawService(view.app).disabledReason();
    if (reason) { reportPiRunFailure(view, reason); return false; }
  }

  if (
    !target
    || !targetModel
    || !apiProviderHasUsableCredential(target, settings.openAICodexCredential)
    || validateApiProvider(target).length > 0
  ) {
    showNotice(view, retainQueueHead
      ? "排队消息所选的模型已不可用，发送已暂停。请在 设置 → 模型服务 中检查后点击“继续”。"
      : CAUSE.providerModelRemoved[0], retainQueueHead
      ? "The model chosen for this queued message is no longer available, so sending is paused. Go to Settings → Model services to check it, then click Continue."
      : CAUSE.providerModelRemoved[1]);
    return false;
  }
  if (!frozenTurnReasoningSelectionIsValid(settings, selection)) {
    showNotice(view, retainQueueHead
      ? "排队消息所选的模型配置已变更，发送已暂停。请删除该消息后重新发送。"
      : "当前思考强度已不可用，请重新选择后重试。", retainQueueHead
      ? "The model settings chosen for this queued message have changed, so sending is paused. Delete it and send it again."
      : "The current reasoning level is unavailable. Select it again and try again.");
    return false;
  }
  if (
    item.attachments.some((attachment) => attachment.type === "image")
    && routeKnowledgeConversationCommand(item.text.trim()).kind !== "maintain"
    && !apiProviderModelSupportsImage(targetModel)
  ) {
    const message = localizedPiChatErrorMessage(view, new Error(PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE));
    reportPiRunFailure(view, message);
    return false;
  }
  return !view.lifecycleSignal?.aborted;
}

export async function startChatTurn(view: CodexViewTurnContext, session: StoredSession, item: QueuedTurnItem, source: QueuedTurnSource): Promise<QueuedTurnOutcome> {
  const additionalMaintenanceItems: QueuedTurnItem[] = [];
  const sourceSnapshot = freezeWorkbenchTaskSource(item.prefillSource);
  if (sourceSnapshot?.signalId === 7 && !item.maintenanceScope
    && item.turnOptions.mode !== "plan" && item.turnOptions.permission !== "read-only") {
    try {
      const manager = view.plugin.getKnowledgeSurfaceService();
      if (!manager) throw new Error("知识库维护尚未就绪，请重试。");
      const batches = await manager.prepareWorkbenchMaintenance(sourceSnapshot, item.text);
      const batchItem = (batch: typeof batches[number], index: number): QueuedTurnItem => {
        const objects = [...batch.maintenanceScope.sourcePaths];
        return { ...item, id: index ? newId("queued-turn") : item.id, text: batch.text,
          maintenanceScope: structuredClone(batch.maintenanceScope), composerDraftTransferred: true,
          ...(index ? { piDraftId: undefined, piUserEntryAccepted: undefined, clearComposerAfterPiAcceptance: undefined } : {}),
          prefillSource: JSON.stringify({ ...sourceSnapshot, objects,
            ...(sourceSnapshot.versions ? { versions: Object.fromEntries(Object.entries(sourceSnapshot.versions).filter(([path]) => objects.includes(path))) } : {}) }) };
      };
      Object.assign(item, batchItem(batches[0], 0));
      additionalMaintenanceItems.push(...batches.slice(1).map((batch, index) => batchItem(batch, index + 1)));
    } catch (error) { reportPiRunFailure(view, localizedPiChatErrorMessage(view, error)); return "failed"; }
  }
  const submittedText = item.text.trim()
    || (item.noteMentions?.length
      ? "请结合我提及的笔记继续。"
      : item.attachments.some((attachment) => attachment.type === "file")
        ? "请阅读我附加的文档，并根据文档内容回应。"
        : "");
  const knowledgeCommand = routeKnowledgeConversationCommand(submittedText);
  let maintenanceScope: Awaited<
    ReturnType<CodexViewTurnContext["plugin"]["prepareEchoInkKnowledgeMaintenanceScope"]>
  > | undefined = item.maintenanceScope;
  let preparedImages: Awaited<ReturnType<typeof preparePiChatImages>> = item.preparedImages ? [...item.preparedImages] : [];
  let preparedDocumentSet: Readonly<PiChatPreparedDocumentSet> = Object.freeze({
    documents: Object.freeze((item.preparedDocuments ?? []).map((document) => Object.freeze({
      ...document,
      bytes: new Uint8Array(document.bytes),
      attachment: Object.freeze({ ...document.attachment })
    }))),
    contextText: "",
    estimatedInputTokens: 0,
    totalBytes: (item.preparedDocuments ?? []).reduce(
      (sum, document) => sum + document.attachment.sizeBytes,
      0
    )
  });
  if (knowledgeCommand.kind === "maintain") {
    if (item.turnOptions.mode === "plan") {
      showNotice(
        view,
        "/maintain 只在 Agent 模式执行；请先退出 Plan 模式。",
        "/maintain runs only in Agent mode. Exit Plan mode first."
      );
      return "failed";
    }
    try {
      if (!maintenanceScope && item.turnOptions.permission !== "read-only"
        && (item.attachments.length > 0 || !isMaintenanceScopeConfirmation(knowledgeCommand.request))) {
        maintenanceScope = await view.plugin.prepareEchoInkKnowledgeMaintenanceScope({
          request: knowledgeCommand.request,
          attachmentPaths: item.attachments.map((attachment) => attachment.path)
        });
      }
    } catch (error) {
      reportPiRunFailure(view, localizedPiChatErrorMessage(view, error));
      return "failed";
    }
  } else if (item.attachments.length) {
    try {
      const imageAttachments = item.attachments.filter(
        (attachment) => attachment.type === "image"
      );
      const documentAttachments = item.attachments.filter(
        (attachment) => attachment.type === "file"
      );
      if (!item.preparedImages) { preparedImages = await preparePiChatImages(imageAttachments); item.preparedImages = preparedImages; }
      if (documentAttachments.length) {
        if (
          preparedDocumentSet.documents.length !== documentAttachments.length
          || !preparedDocumentsMatchAttachments(
            preparedDocumentSet.documents,
            documentAttachments
          )
        ) {
          throw new Error(uiText(
            view,
            "附件内容与提交时不一致，消息未发送。请保留草稿，重新添加附件后发送。",
            "The attachment no longer matches what was queued, so this message was not sent. Keep the draft, add the attachment again, then send."
          ));
        }
        const provider = view.plugin.settings.apiProviders.find(
          (candidate) => candidate.id === item.turnOptions.providerSettingsId
        );
        if (!provider) {
          throw new Error(uiText(
            view,
            CAUSE.providerModelRemoved[0],
            CAUSE.providerModelRemoved[1]
          ));
        }
        const reconciledDocuments = reconcilePiDocumentTransports(
          preparedDocumentSet.documents,
          piDocumentCapabilityTarget(provider, item.turnOptions.model)
        );
        const contextText = buildPiDocumentContext(reconciledDocuments);
        const estimatedInputTokens = estimatePiContextTokens(contextText).tokens;
        const availableInputTokens = availableDocumentInputTokens(
          view,
          session,
          item,
          submittedText
        );
        if (estimatedInputTokens > availableInputTokens) {
          throw new Error(uiText(
            view,
            CAUSE.documentsTooLong[0],
            CAUSE.documentsTooLong[1]
          ));
        }
        preparedDocumentSet = Object.freeze({
          documents: reconciledDocuments,
          contextText,
          estimatedInputTokens,
          totalBytes: reconciledDocuments.reduce(
            (sum, document) => sum + document.attachment.sizeBytes,
            0
          )
        });
      }
    } catch (error) {
      reportPiRunFailure(view, localizedPiChatErrorMessage(view, error));
      return "failed";
    }
  }
  let currentSkill: EchoInkResource | null = null;
  const defaultSkillId = session.defaultSkillId?.trim() ?? "";
  if (defaultSkillId || item.skill) {
    try {
      const enabledSkills = enabledSkillResources(
        await view.plugin.buildRuntimeEchoInkResourceCatalog()
      );
      currentSkill = defaultSkillId
        ? enabledSkills.find((skill) => resourceMatchesSkillId(
            skill,
            defaultSkillId
          )) ?? null
        : enabledSkills.find((skill) => skill.id === item.skill?.id) ?? null;
    } catch {
      showNotice(
        view,
        defaultSkillId
          ? "无法确认会话默认技能的启用状态，消息未发送。请稍后重试。"
          : "无法确认所选技能的启用状态，消息未发送。请稍后重试。",
        defaultSkillId
          ? "Could not confirm whether the conversation's default Skill is enabled, so the message was not sent. Try again later."
          : "Could not confirm whether the selected Skill is enabled, so the message was not sent. Try again later."
      );
      return "failed";
    }
    if (!currentSkill) {
      showNotice(
        view,
        defaultSkillId
          ? `会话默认技能 ${defaultSkillId} 已禁用或已删除，消息未发送。请重新选择技能。`
          : "所选技能已禁用或已删除，消息未发送。请重新选择技能。",
        defaultSkillId
          ? `The conversation's default Skill ${defaultSkillId} is disabled or no longer exists, so the message was not sent. Choose a Skill again.`
          : "The selected Vault Skill is disabled or no longer exists, so the message was not sent. Choose a Skill again."
      );
      return "failed";
    }
  }
  const skillPath = currentSkill?.contentPath?.trim();
  const skillName = currentSkill?.name.trim();
  const skillId = currentSkill
    ? stableSkillIdForResource(currentSkill)
    : "";
  if (currentSkill && (!skillPath || !skillName)) {
    showNotice(
      view,
      "未找到所选技能的文件，消息未发送。请重新选择技能。",
      "The selected Skill's file could not be found, so this message was not sent. Choose the Skill again."
    );
    return "failed";
  }
  if (
    !submittedText
    && !preparedImages.length
    && !preparedDocumentSet.documents.length
  ) return "failed";
  const submissionSignal = view.lifecycleSignal;
  if (submissionSignal?.aborted) return "cancelled";
  const projector = new PiChatUiProjector();
  let handle: Awaited<
    ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>
  > | null = null;
  let subscription: ReturnType<
    CodexViewTurnContext["plugin"]["subscribePiRun"]
  > | null = null;
  let approvalSubscription: ReturnType<
    CodexViewTurnContext["plugin"]["subscribePiAgentApproval"]
  > | null = null;
  let approvalProjectionFlight: Promise<void> = Promise.resolve();
  let approvalProjectionRefreshFailed = false;
  let liveProjection: PiChatUiViewModel | null = null;
  let agentSettledObserved = false;
  let terminalObserved = false;
  let finalizingProjectionError: unknown = null;
  let finalizingProjectionFlight: Promise<void> = Promise.resolve();
  let acceptedTaskMetadataFailed = false;

  if (!item.resumeContext) view.running = true;
  let accessByConversation = submittedPiAccess.get(view.plugin);
  if (!accessByConversation) {
    accessByConversation = new Map();
    submittedPiAccess.set(view.plugin, accessByConversation);
  }
  accessByConversation.set(session.id, {
    permission: item.turnOptions.permission,
    mode: item.turnOptions.mode
  });
  view.activeRunKind = "chat";
  view.activeRunSessionId = session.id;
  view.turnStartedAt = Date.now();
  view.renderTabs();
  view.renderToolbar();
  view.applyStatus();
  try {
    const submittedAt = Date.now();
    const workbenchSource = freezeWorkbenchTaskSource(item.prefillSource);
    repairQueuedXiaoechoModelSelection(view.plugin.settings, item);
    handle = await view.plugin.submitPiChat({
      onPreparationStage: view.onPreparationStage,
      ...(item.turnOptions.companyProgrammatic ? { companyProgrammatic: true } : {}),
      ...(item.turnOptions.companyProgrammatic && item.turnOptions.companyApprovalKey ? { companyApprovalKey: item.turnOptions.companyApprovalKey } : {}),
      ...(workbenchSource ? { workbenchSource } : {}),
      ...(item.turnOptions.drawingRequested ? { drawingRequested: true } : {}),
      ...(item.generationRequest ? { generationRequest: item.generationRequest } : {}),
      ...(item.pdfTaskRequest ? { pdfTaskRequest: item.pdfTaskRequest } : {}),
      ...(item.englishDiarySourcePath ? { englishDiarySourcePath: item.englishDiarySourcePath } : {}),
      ...(item.resumeContext ? { resumeContext: item.resumeContext } : {}),
      signal: submissionSignal,
      conversationId: session.id,
      text: submittedText,
      submittedAt,
      mode: item.turnOptions.mode === "plan" ? "plan" : "agent",
      permission: item.turnOptions.permission,
      providerSettingsId: item.turnOptions.providerSettingsId,
      runtimeProviderId: item.turnOptions.runtimeProviderId,
      modelId: item.turnOptions.model,
      reasoning: item.turnOptions.reasoning,
      memoryMode: piChatMemoryModeForGlobalSetting(
        view.plugin.settings?.memory?.useLongTermMemory !== false
      ),
      ...(!defaultSkillId && skillPath && skillName ? { skillId, skillPath, skillName } : {}),
      ...(item.piDraftId ? { draftId: item.piDraftId } : {}),
      ...(maintenanceScope ? { maintenanceScope } : {}),
      ...(preparedImages.length ? { images: preparedImages } : {}),
      ...(preparedDocumentSet.documents.length
        ? { documents: preparedDocumentSet.documents }
        : {}),
      ...(item.selectionAnnotations?.length ? { selectionAnnotations: cloneSelectionAnnotations(item.selectionAnnotations) } : {}),
      ...(item.noteMentions?.length ? { noteMentions: item.noteMentions } : {})
    });
    item.piUserEntryAccepted = true;
    item.piUserEntryId = handle.userEntryId;
    item.piProductRunId = handle.productRunId;
    view.onPiUserEntryAccepted?.(item);
    // Remaining batches become eligible only after this first Pi entry is durable.
    for (const batch of [...additionalMaintenanceItems].reverse()) view.turnQueue.enqueueFront(batch);
    if (additionalMaintenanceItems.length) view.renderQueue();
    view.running = true;
    if (source === "queue") {
      view.turnQueue.acceptPiUserEntry(session.id, item.id);
      view.renderQueue();
    }
    clearComposerAfterPiAcceptance(view, item, source);
    try {
      await view.plugin.setPiConversationTaskMetadata(session.id, {
        taskStatus: "running", taskStartedAt: submittedAt,
        taskCompletedAt: undefined, taskInterruptedAt: undefined, pendingResponse: undefined
      });
    } catch (error) {
      acceptedTaskMetadataFailed = true;
      throw error;
    }
    if (preparedImages.length) {
      recordPiImageAttachmentsForEntry(
        session,
        handle.userEntryId,
        preparedImages
      );
    }
    if (preparedDocumentSet.documents.length) {
      recordPiDocumentReplayForEntry(
        session,
        handle.userEntryId,
        preparedDocumentSet.documents
      );
    }
    if (preparedImages.length || preparedDocumentSet.documents.length) {
      await view.plugin.persistPiNativeSettings().catch(() => {
        showNotice(
          view,
          "附件已发送，但本地重放信息保存失败；重启后可能无法恢复附件。",
          "The attachment was sent, but its local replay data could not be saved. It may not be recoverable after restart."
        );
      });
    }
    if (source === "queue") {
      view.turnQueue.acceptPiUserEntry(session.id, item.id);
      view.renderQueue();
    }
    if (submissionSignal?.aborted) {
      clearComposerAfterPiAcceptance(view, item, source);
      await view.plugin.abortPiConversation(session.id);
      await handle.result;
      return "cancelled";
    }
    view.activeRunId = handle.productRunId;
    view.activeRunKind = "chat";
    view.activeRunSessionId = session.id;
    view.activeTurnId = handle.productRunId;
    await view.onPiRunAccepted?.(item);
    liveProjection = piChatLiveProjectionFromSession(
      session,
      handle,
      submittedText,
      preparedImages,
      preparedDocumentSet.documents,
      item.noteMentions ?? [],
      item.selectionAnnotations ?? [],
      submittedAt,
      item.generationRequest
    );
    applyPiChatLiveProjection(view, session, liveProjection);
    approvalSubscription = view.plugin.subscribePiAgentApproval({
      conversationId: handle.conversationId,
      piSessionId: handle.piSessionId,
      productRunId: handle.productRunId
    }, () => {
      // The live broker can become ready just after Tool start. Re-render once
      // immediately for the pending fallback, then project the durable Ticket.
      view.renderMessagesIfActive(session);
      approvalProjectionFlight = approvalProjectionFlight
        .then(async () => {
          if (!handle || terminalObserved) return;
          const projection = await view.plugin.readPiConversationProjection(
            handle.conversationId
          );
          if (terminalObserved) return;
          rememberPiConversationProjection(view.plugin, projection);
          liveProjection = piChatLiveProjectionFromDurable(
            projection,
            handle,
            "running"
          );
          applyPiConversationProjection(session, projection);
          applyPiChatLiveProjection(view, session, liveProjection);
          view.renderMessagesIfActive(session);
          view.renderToolbar();
          view.applyStatus();
        })
        .catch(() => {
          if (approvalProjectionRefreshFailed) return;
          approvalProjectionRefreshFailed = true;
          showNotice(
            view,
            "审批状态刷新失败，请等待当前工具状态更新。",
            "Could not refresh approval status. Wait for the current Tool status update."
          );
        });
    });
    clearComposerAfterPiAcceptance(view, item, source);
    view.renderTabs();
    view.renderMessagesIfActive(session);
    view.renderToolbar();
    view.applyStatus();
    view.armTurnWatchdog();

    type ProductRunSettledEvent = Extract<
      PiChatRuntimeEvent,
      { type: "product_run_settled" }
    >;
    let resolveTerminal!: (value: Readonly<ProductRunSettledEvent>) => void;
    let rejectTerminal!: (error: Error) => void;
    const terminal = new Promise<Readonly<ProductRunSettledEvent>>(
      (resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      }
    );
    subscription = view.plugin.subscribePiRun(
      handle.productRunId,
      (event) => {
        try {
          assertPiChatRuntimeEventIdentity(event, handle!);
          if (isTurnWatchdogProgressEvent(event)) view.armTurnWatchdog();
          // Buffered/private model text still makes progress, without changing
          // the visible projection or scheduling a settings save for each token.
          if (event.type === "model_progress") return;
          if (event.type === "tool_execution_end" && event.toolName === "pdf_reading_process" && !event.isError) {
            const receipt = pdfAttachmentReceipt(event.result);
            if (receipt?.conversationId === handle!.conversationId && receipt.userEntryId === handle!.userEntryId) {
              const keep = (document: Readonly<PiChatPreparedDocument>) => {
                if (document.transport !== "tool_reference" || document.attachmentId !== receipt.attachmentId || document.sha256 !== receipt.sha256) return true;
                (document.bytes as Uint8Array).fill(0);
                return false;
              };
              item.preparedDocuments = item.preparedDocuments?.filter(keep);
              preparedDocumentSet = { ...preparedDocumentSet, documents: preparedDocumentSet.documents.filter(keep) };
            }
          }
          liveProjection = projector.projectRuntimeEvent({
            current: liveProjection!,
            event,
            vaultPath: view.plugin.getVaultPath()
          });
          const changedMessage = applyPiChatLiveProjection(
            view,
            session,
            liveProjection,
            event
          );
          view.renderMessagesIfActive(session, changedMessage);
          view.renderToolbar();
          view.applyStatus();

          if (event.type === "agent_settled" && !agentSettledObserved) {
            agentSettledObserved = true;
            finalizingProjectionFlight = view.plugin
              .readPiConversationProjection(session.id)
              .then((projection) => {
                if (terminalObserved) return;
                rememberPiConversationProjection(view.plugin, projection);
                liveProjection = piChatLiveProjectionFromDurable(
                  projection,
                  handle!,
                  "finalizing"
                );
                applyPiConversationProjection(session, projection);
                applyPiChatLiveProjection(view, session, liveProjection);
                view.renderMessagesIfActive(session);
                view.renderToolbar();
                view.applyStatus();
              })
              .catch((error: unknown) => {
                finalizingProjectionError = error;
              });
            return;
          }

          if (event.type === "product_run_settled" && !terminalObserved) {
            if (!agentSettledObserved) {
              throw new Error(
                "Pi Chat ProductRun 在 agent_settled 之前进入正式终态。"
              );
            }
            terminalObserved = true;
            resolveTerminal(event);
          }
        } catch (error) {
          rejectTerminal(normalizePiChatError(error));
        }
      }
    );

    const [settledEvent, settledRun] = await Promise.all([
      terminal,
      handle.result
    ]);
    await finalizingProjectionFlight;
    if (finalizingProjectionError) {
      throw normalizePiChatError(finalizingProjectionError);
    }
    assertPiChatSettlementIdentity(settledEvent, settledRun);
    const committedFinalProjection =
      await view.plugin.readPiConversationProjection(session.id);
    rememberPiConversationProjection(view.plugin, committedFinalProjection);
    applyPiConversationProjection(session, committedFinalProjection);
    view.renderMessagesIfActive(session);
    await markUnreadCompletedAnswerIfBackground(
      view,
      session,
      settledEvent,
      settledRun,
      committedFinalProjection
    );

    if (settledEvent.terminalState === "failed" && !settledRun.interruption?.retryAttempts) {
      // The raw error stays in the run record for "Report a problem"; the Notice only shows plain words.
      new Notice(localizedPiChatErrorMessage(
        view,
        providerFailureText(settledRun.error, view.plugin.settings.settingsLanguage)
          ?? settledRun.error?.split(`\n${PROVIDER_FAILURE_DETAIL_PREFIX}`)[0],
        uiText(view, "本次回答未完成。请重新发送；如问题持续，请点击“上报问题”。", "The answer could not be completed. Send it again; if the problem persists, click Report a problem.")
      ));
    }
    return queuedTurnOutcomeForPiTerminal(settledEvent.terminalState);
  } catch (error) {
    runErrors.record("desktop.turn", error, { conversationId: session.id, runId: handle?.productRunId });
    view.onPiRunFailure?.(localizedPiChatErrorMessage(view, error));
    if (item.piUserEntryAccepted || piUserEntryWasAccepted(error)) {
      item.piUserEntryAccepted = true;
      if (source === "queue") {
        view.turnQueue.acceptPiUserEntry(session.id, item.id);
        view.renderQueue();
      }
      const acceptedEntryId = handle?.userEntryId ?? piAcceptedUserEntryId(error);
      item.piUserEntryId = acceptedEntryId;
      item.piProductRunId = handle?.productRunId;
      view.onPiUserEntryAccepted?.(item);
      if (acceptedEntryId) {
        if (preparedImages.length) {
          recordPiImageAttachmentsForEntry(
            session,
            acceptedEntryId,
            preparedImages
          );
        }
        if (preparedDocumentSet.documents.length) {
          recordPiDocumentReplayForEntry(
            session,
            acceptedEntryId,
            preparedDocumentSet.documents
          );
        }
      }
      if (
        acceptedEntryId
        && (preparedImages.length || preparedDocumentSet.documents.length)
      ) {
        await view.plugin.persistPiNativeSettings().catch(() => {
          showNotice(
            view,
            "附件已发送，但本地重放信息保存失败；重启后可能无法恢复附件。",
            "The attachment was sent, but its local replay data could not be saved. It may not be recoverable after restart."
          );
        });
      }
      clearComposerAfterPiAcceptance(view, item, source);
    }
    if (handle) {
      await view.plugin.abortPiConversation(session.id).catch(() => undefined);
      await handle.result.catch(() => undefined);
    }
    const projection = await view.plugin
      .readPiConversationProjection(session.id)
      .catch(() => null);
    if (projection) {
      rememberPiConversationProjection(view.plugin, projection);
      applyPiConversationProjection(session, projection);
      view.renderMessagesIfActive(session);
    }
    if (submissionSignal?.aborted) return "cancelled";
    console.error("EchoInk conversation finalization failed", error);
    const rawMessage = normalizePiChatError(error).message;
    const message = localizedPiChatErrorMessage(view, error);
    reportPiRunFailure(view,
      acceptedTaskMetadataFailed
        ? uiText(
          view,
          "消息已接收，但本次进度未能保存，任务已停止。请重新打开该会话核对内容后，再决定是否重新发送。",
          "The message was received, but its progress could not be saved, so it stopped. Reopen this conversation to check its content before deciding whether to resend."
        )
        : item.piUserEntryAccepted
          ? uiText(view,
            isPiConversationPersistenceError(error)
              ? "回答已生成，但记录保存失败。已有内容已保留，无需重新发送。"
              : "本轮收尾未能完成，已有内容已保留。",
            isPiConversationPersistenceError(error)
              ? "The answer was generated, but its records could not be saved. Your content was kept; do not resend."
              : "This turn could not finish finalizing. Your content was kept.")
        : rawMessage === PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE
        ? message
        : failureNotice(view, error,
          ["消息未能发送。", "The message could not be sent."],
          ["请重新发送；如问题持续，请在 设置 → 模型服务 中点击“测试连接”。", "Send it again; if the problem persists, go to Settings → Model services and click “Test connection”."])
    );
    return "failed";
  } finally {
    try {
      approvalSubscription?.unsubscribe();
    } catch {
      // The durable Ticket and Tool projection remain authoritative.
    }
    await approvalProjectionFlight.catch(() => undefined);
    try {
      subscription?.unsubscribe();
    } catch {
      // The canonical terminal/readback above remains authoritative.
    }
    if (handle) {
      view.setPendingInteraction(session.id, null, handle.productRunId);
      view.plugin.releasePiProductionRun(handle.productRunId);
      await view.plugin.releasePiConversationIfInactive(
        session.id,
        () => view.plugin.settings.activeSessionId !== session.id
      ).catch((error) => {
        console.error("Inactive Pi Conversation release failed", error);
      });
    }
    view.running = false;
    view.activeTurnId = "";
    view.clearTurnWatchdog();
    if (!handle || view.activeRunId === handle.productRunId) {
      view.clearActiveRun();
    }
    view.renderTabs();
    if (view.plugin.settings.activeSessionId === session.id) {
      view.renderMessages(messageRenderOptionsForRunUpdate(view));
    }
    view.renderToolbar();
    view.applyStatus();
  }
}

export function resourceMatchesSkillId(
  skill: Readonly<EchoInkResource>,
  skillId: string
): boolean {
  const normalizedId = skillId.trim();
  if (!normalizedId || skill.kind !== "skill") return false;
  const resourceId = typeof skill.metadata?.resourceId === "string"
    ? skill.metadata.resourceId.trim()
    : "";
  return skill.id === normalizedId || resourceId === normalizedId;
}

function stableSkillIdForResource(skill: Readonly<EchoInkResource>): string {
  const resourceId = typeof skill.metadata?.resourceId === "string"
    ? skill.metadata.resourceId.trim()
    : "";
  return resourceId || skill.id.trim();
}

export function frozenTurnReasoningSelectionIsValid(
  settings: CodexViewTurnContext["plugin"]["settings"],
  selection: Pick<
    TurnOptions,
    "providerSettingsId" | "runtimeProviderId" | "model" | "reasoning"
  >
): boolean {
  const provider: ApiProviderConfig | undefined = settings.apiProviders.find(
    (candidate) => candidate.id === selection.providerSettingsId
  );
  const model: ApiProviderModelConfig | null = provider
    ? getApiProviderModel(provider, selection.model)
    : null;
  if (
    !provider
    || !model
    || provider.runtimeProviderId !== selection.runtimeProviderId
  ) return false;
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    selection.runtimeProviderId,
    selection.model,
    model
  );
  return isEchoInkPiReasoningEffortSupported(
    capabilities,
    selection.reasoning
  );
}

function assertPiChatRuntimeEventIdentity(
  event: Readonly<PiChatRuntimeEvent>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >
): void {
  if (
    event.productRunId !== handle.productRunId
    || event.conversationId !== handle.conversationId
    || event.piSessionId !== handle.piSessionId
  ) {
    throw new Error("Pi Chat 事件身份与当前运行不一致。");
  }
}

function assertPiChatSettlementIdentity(
  event: Readonly<Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>>,
  run: Readonly<PiProductRunRecord>
): void {
  if (
    run.productRunId !== event.productRunId
    || run.conversationId !== event.conversationId
    || run.piSessionId !== event.piSessionId
    || run.state !== "product_run_settled"
    || run.terminalState !== event.terminalState
  ) {
    throw new Error("Pi Chat ProductRun 终态与耐久回读不一致。");
  }
}

export async function markUnreadCompletedAnswerIfBackground(
  view: CodexViewTurnContext,
  session: StoredSession,
  event: Readonly<Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>>,
  run: Readonly<PiProductRunRecord>,
  projection: Readonly<PiConversationProjection>
): Promise<void> {
  const unreadAnswerAt = piConversationUnreadAnswerAt({
    sessionId: session.id,
    activeSessionId: view.plugin.getConversationRunService?.().isTaskVisible(session.id)
      ? view.plugin.settings.activeSessionId : "",
    event,
    run,
    projection
  });
  if (unreadAnswerAt === undefined) return;

  try {
    await view.plugin.setPiConversationTaskMetadata(session.id, { unreadAnswerAt });
  } catch (error) {
    console.error("Unread Pi answer persistence failed", error);
  }
}

export function piConversationUnreadAnswerAt(input: Readonly<{
  sessionId: string;
  activeSessionId: string;
  event: Readonly<Extract<PiChatRuntimeEvent, { type: "product_run_settled" }>>;
  run: Readonly<PiProductRunRecord>;
  projection: Readonly<PiConversationProjection>;
  now?: number;
}>): number | undefined {
  if (
    input.event.terminalState !== "completed"
    || input.activeSessionId === input.sessionId
  ) return undefined;
  const assistantEntryId = input.event.assistantEntryId
    ?? input.run.assistantEntryId;
  if (
    !assistantEntryId
    || !input.projection.messages.some((message) =>
      message.role === "assistant"
      && message.status === "completed"
      && piEntryIdFromProjectedMessageId(message.id) === assistantEntryId
    )
  ) return undefined;
  return [input.run.settledAt, input.event.occurredAt, input.now].find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0
  ) ?? Math.max(1, Date.now());
}

function applyPiConversationProjection(
  target: StoredSession,
  projection: Readonly<PiConversationProjection>
): void {
  target.title = projection.catalog.title;
  target.piSessionId = projection.catalog.piSessionId;
  target.defaultMemoryMode = projection.catalog.defaultMemoryMode;
  if (projection.catalog.defaultSkillId) {
    target.defaultSkillId = projection.catalog.defaultSkillId;
  } else {
    delete target.defaultSkillId;
  }
  target.messages = projectPiImageAttachments(
    target,
    clonePiChatMessages(projection.messages)
  );
  if (projection.contextLedger) {
    target.contextLedger = structuredClone(projection.contextLedger);
  } else {
    delete target.contextLedger;
  }
  target.createdAt = projection.catalog.createdAt;
  target.updatedAt = projection.catalog.updatedAt;
}

function applyPiChatLiveProjection(
  view: CodexViewTurnContext,
  session: StoredSession,
  projection: Readonly<PiChatUiViewModel>,
  changedEvent?: Readonly<PiChatRuntimeEvent>
): ChatMessage | undefined {
  session.piSessionId = projection.piSessionId;
  session.messages = projectPiImageAttachments(
    session,
    clonePiChatMessages(projection.messages)
  );
  view.setPendingInteraction(
    session.id,
    piChatPendingInteraction(view, session, projection),
    projection.productRunId
  );
  return changedEvent
    ? changedPiChatMessageForRuntimeEvent(session.messages, changedEvent)
    : undefined;
}

/** The live approval broker is authoritative; a durable pending Ticket can outlive its decision. */
function piChatPendingInteraction(
  view: CodexViewTurnContext,
  session: StoredSession,
  projection: Readonly<PiChatUiViewModel>
): Readonly<import("../../types/conversation-turn").EchoInkTurnInteraction> | null {
  const runId = projection.productRunId;
  const projected = projection.pendingInteraction;
  if (projected && (projected.status === "pending" || projected.status === "submitting")) return projected;
  // Approval readback rebuilds from the durable Branch. Retain a simultaneous
  // structured Question only while its actual one-shot broker still accepts it.
  const current = view.plugin.getConversationRunService?.().pendingInteractions?.get(session.id);
  if (current?.kind === "question" && current.turnId === runId && (current.status === "pending" || current.status === "submitting")
    && view.plugin.piTurnInteractionBinding?.({ conversationId: session.id, piSessionId: projection.piSessionId,
      productRunId: current.turnId, interactionId: current.interactionId })) return current;
  if (runId && view.plugin.piAgentApprovalBinding) {
    for (const message of projection.messages.slice().reverse()) {
      if (message.runId !== runId) continue;
      const toolCallId = piToolCallIdFromProjectedMessageId(message.id);
      if (!toolCallId) continue;
      const binding = view.plugin.piAgentApprovalBinding({ conversationId: session.id, piSessionId: projection.piSessionId, productRunId: runId, toolCallId });
      if (!binding) continue;
      return { kind: "confirmation", interactionId: `pi-agent-approval:${encodeURIComponent(toolCallId)}`,
        conversationId: session.id, piSessionId: projection.piSessionId, turnId: runId, toolCallId,
        status: "pending", createdAt: message.createdAt, updatedAt: projection.updatedAt,
        // The real parameters remain exclusively in the existing approval binding/card.
        preview: uiText(view, "是否批准本次操作？", "Approve this operation?") };
    }
  }
  return projected ?? null;
}

function changedPiChatMessageForRuntimeEvent(
  messages: readonly ChatMessage[],
  event: Readonly<PiChatRuntimeEvent>
): ChatMessage | undefined {
  if (
    event.type === "provider_reasoning_start"
    || event.type === "provider_reasoning_delta"
    || event.type === "provider_reasoning_end"
  ) {
    return messages.find((message) =>
      message.assistantTurn?.turnId === event.productRunId
      && message.assistantTurn.providerReasoningSegments?.some(
        (segment) => segment.reasoningId === event.reasoningId
      )
    );
  }
  if (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) {
    return messages.find((message) =>
      piToolCallIdFromProjectedMessageId(message.id) === event.toolCallId
    );
  }
  if (event.type === "message_start" || event.type === "message_update") {
    return messages.find((message) =>
      piRuntimeMessageKeyFromProjectedMessageId(message.id) === event.messageKey
    );
  }
  if (event.type === "message_end") {
    return event.entryId
      ? messages.find((message) =>
          piEntryIdFromProjectedMessageId(message.id) === event.entryId
        )
      : messages.find((message) =>
          piRuntimeMessageKeyFromProjectedMessageId(message.id) === event.messageKey
        );
  }
  if (event.type === "message_entry_resolved") {
    return messages.find((message) =>
      piEntryIdFromProjectedMessageId(message.id) === event.entryId
    );
  }
  if (event.type === "reasoning_summary") {
    return messages.find((message) =>
      message.reasoningSummary?.productRunId === event.productRunId
    );
  }
  return messages.find((message) =>
    message.assistantTurn?.turnId === event.productRunId
  );
}

function piChatLiveProjectionFromSession(
  session: Readonly<StoredSession>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >,
  submittedText: string,
  preparedImages: readonly Readonly<PiChatPreparedImage>[],
  preparedDocuments: readonly Readonly<PiChatPreparedDocument>[],
  noteMentions: readonly Readonly<NonNullable<QueuedTurnItem["noteMentions"]>[number]>[],
  selectionAnnotations: readonly SelectionAnnotation[],
  submittedAt: number,
  generationRequest?: import("../../generation/types").GenerationRequest
): PiChatUiViewModel {
  const messages = clonePiChatMessages(session.messages);
  {
    const acceptedUserMessage: ChatMessage = {
      id: piProjectedEntryMessageId(
        handle.piSessionId,
        null,
        handle.userEntryId
      ),
      role: "user",
      itemType: "user",
      text: submittedText,
      ...(generationRequest ? { generationRequest: structuredClone(generationRequest) } : {}),
      ...(selectionAnnotations.length ? { selectionAnnotations: cloneSelectionAnnotations(selectionAnnotations) } : {}),
      ...(preparedImages.length
        ? { images: preparedImages.map(({ attachment }) => ({ ...attachment })) }
        : {}),
      ...(preparedDocuments.length
        ? {
            attachments: preparedDocuments.map((document) => ({
              ...document.attachment,
              ...(document.transport === "tool_reference" ? { path: `pdf-attachment:${document.attachmentId}`, availability: "unavailable" as const } : {})
            }))
          }
        : {}),
      ...(noteMentions.length
        ? {
            noteMentions: noteMentions.map(({ vaultRelativePath, fileName }) => ({
              vaultRelativePath,
              fileName
            }))
          }
        : {}),
      status: "completed",
      runId: handle.productRunId,
      turnId: handle.productRunId,
      createdAt: submittedAt,
      completedAt: submittedAt
    };
    const existingIndex = messages.findIndex((message) =>
      piEntryIdFromProjectedMessageId(message.id) === handle.userEntryId
    );
    if (existingIndex >= 0) messages[existingIndex] = acceptedUserMessage;
    else messages.push(acceptedUserMessage);
  }
  return {
    piSessionId: handle.piSessionId,
    activeLeafId: null,
    productRunId: handle.productRunId,
    runState: "running",
    messages,
    diagnostics: [],
    queuedSteering: [],
    queuedFollowUp: [],
    provisionalMessageIds: [],
    pendingToolCallIds: [],
    updatedAt: Date.now()
  };
}

function piChatLiveProjectionFromDurable(
  projection: Readonly<PiConversationProjection>,
  handle: NonNullable<
    Awaited<ReturnType<CodexViewTurnContext["plugin"]["submitPiChat"]>>
  >,
  runState: PiChatUiRunState
): PiChatUiViewModel {
  return {
    piSessionId: projection.catalog.piSessionId,
    activeLeafId: projection.activeLeafId,
    productRunId: handle.productRunId,
    runState,
    messages: clonePiChatMessages(projection.messages),
    diagnostics: projection.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    queuedSteering: [],
    queuedFollowUp: [],
    provisionalMessageIds: [],
    pendingToolCallIds: [],
    updatedAt: Date.now()
  };
}

function clonePiChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.approval ? { approval: { ...message.approval } } : {}),
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.images
      ? { images: message.images.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.selectionAnnotations ? { selectionAnnotations: cloneSelectionAnnotations(message.selectionAnnotations) } : {}),
    ...(message.noteMentions
      ? { noteMentions: message.noteMentions.map((mention) => ({ ...mention })) }
      : {}),
    ...(message.files
      ? { files: message.files.map((file) => ({ ...file })) }
      : {}),
    ...(message.personalMemorySources
      ? {
          personalMemorySources: message.personalMemorySources.map(
            (source) => ({ ...source })
          )
        }
      : {}),
    ...(message.taskPlan
      ? {
        taskPlan: {
          ...message.taskPlan,
          steps: message.taskPlan.steps.map((step) => ({ ...step }))
        }
      }
      : {}),
    ...(message.reasoningSummary
      ? {
          reasoningSummary: {
            ...message.reasoningSummary,
            activities: message.reasoningSummary.activities.map(
              (activity) => ({ ...activity })
            )
          }
        }
      : {}),
    ...(message.assistantTurn
      ? { assistantTurn: cloneEchoInkAssistantTurn(message.assistantTurn) }
      : {}),
    ...(message.interactionRecord
      ? { interactionRecord: Object.freeze({ ...message.interactionRecord }) }
      : {})
  }));
}

function queuedTurnOutcomeForPiTerminal(
  terminalState: PiProductRunTerminalState
): QueuedTurnOutcome {
  if (terminalState === "completed") return "completed";
  return terminalState === "cancelled" ? "cancelled" : "failed";
}

function normalizePiChatError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Pass "" as the fallback to get "" when the error has no user-facing reason. */
function localizedPiChatErrorMessage(
  view: Pick<CodexViewTurnContext, "plugin">,
  error: unknown,
  fallback = joinErrorCopy(ACTION_FAILED, NEXT.retryOrReload, view.plugin.settings.settingsLanguage)
): string {
  if (error instanceof PiDocumentInputError) {
    return localizedPiDocumentInputError(view, error);
  }
  if (error instanceof PiImageInputError) {
    return localizedPiImageInputError(view, error);
  }
  return localizedKnownPiChatError(
    view,
    normalizePiChatError(error).message,
    fallback
  );
}

function localizedPiDocumentInputError(
  view: Pick<CodexViewTurnContext, "plugin">,
  error: PiDocumentInputError
): string {
  const fileName = error.fileName ? `“${error.fileName}”` : "";
  switch (error.code) {
    case "unsupported_format":
      return uiText(
        view,
        error.message,
        `Document ${fileName} has an unsupported format. Choose a PDF, Word, Markdown, or HTML file.`
      );
    case "too_many_documents":
      return uiText(
        view,
        error.message,
        "You can add up to 8 documents in one turn. Remove some files and try again."
      );
    case "file_too_large":
      return uiText(
        view,
        error.message,
        `Document ${fileName} exceeds 20 MiB. Compress or split it and try again.`
      );
    case "total_too_large":
      return uiText(
        view,
        error.message,
        `Adding document ${fileName} exceeds the 50 MiB total limit. Remove some files and try again.`
      );
    case "unreadable":
      return uiText(
        view,
        error.message,
        `Could not read document ${fileName}. Check that it is still on this computer, has not moved, and EchoInk can read it.`
      );
    case "encrypted":
      return uiText(
        view,
        error.message,
        `Document ${fileName} is encrypted or password-protected. Remove the protection locally and try again.`
      );
    case "invalid_utf8":
      return uiText(
        view,
        error.message,
        `Document ${fileName} is not valid UTF-8. Save it with UTF-8 encoding and try again.`
      );
    case "damaged":
      return uiText(
        view,
        error.message,
        `Document ${fileName} cannot be parsed. It may be damaged or its format may not match its extension; save it again with its original app and try again.`
      );
    case "textless":
      return uiText(
        view,
        error.message,
        `Document ${fileName} has no text that EchoInk can use. Add the original file again and try sending it.`
      );
    case "input_budget_exceeded":
      return uiText(
        view,
        error.message,
        CAUSE.documentsTooLong[1]
      );
  }
}

function localizedPiImageInputError(
  view: Pick<CodexViewTurnContext, "plugin">,
  error: PiImageInputError
): string {
  const fileName = `“${error.fileName}”`;
  switch (error.code) {
    case "ordinary_file_unsupported":
      return uiText(
        view,
        error.message,
        `This conversation accepts only image attachments, so ${fileName} was not sent. Use an image, or a PDF, Word, Markdown, or HTML file.`
      );
    case "image_unreadable":
      return uiText(
        view,
        error.message,
        `Could not read image attachment ${fileName}. Check that the local file still exists.`
      );
    case "image_format_unsupported":
      return uiText(
        view,
        error.message,
        `Could not identify the actual format of image attachment ${fileName}.`
      );
    case "image_conversion_failed":
      return uiText(
        view,
        error.message,
        `Could not convert image attachment ${fileName}. It was not sent in this turn.`
      );
    case "image_resize_failed":
      return uiText(
        view,
        error.message,
        `Could not process image attachment ${fileName}. It may be damaged. Use another image and try again.`
      );
  }
}

function localizedKnownPiChatError(
  view: Pick<CodexViewTurnContext, "plugin">,
  message: string,
  fallback: string
): string {
  const denial = agentCapabilityErrorText(message, view.plugin.settings.settingsLanguage);
  if (denial) return denial;
  if (message === PI_IMAGE_INPUT_UNSUPPORTED_MESSAGE) {
    return uiText(
      view,
      message,
      "The current model does not support image input. Choose a model that supports images."
    );
  }
  if (
    message === "Pi Chat 事件身份与当前运行不一致。"
    || message === "Pi Chat ProductRun 终态与耐久回读不一致。"
    || message === "Pi Chat ProductRun 在 agent_settled 之前进入正式终态。"
  ) {
    return uiText(
      view,
      "本次回答的记录未能完整保存。请重新打开该会话核对内容后，再决定是否重新发送。",
      "This answer's record could not be saved completely. Reopen this conversation to check its content before deciding whether to resend."
    );
  }
  const known = providerFailureText(message, view.plugin.settings.settingsLanguage);
  if (known) return known;
  const missingMention = /^找不到提及的笔记：(.+)$/u.exec(message);
  if (missingMention) {
    return uiText(
      view,
      message,
      `Could not find mentioned note: ${missingMention[1]}`
    );
  }
  return userFacingErrorText(
    localizeKnownConversationSystemCopy(view.plugin.settings.settingsLanguage, message),
    fallback,
    view.plugin.settings.settingsLanguage
  );
}

function piUserEntryWasAccepted(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as { piUserEntryAccepted?: unknown }).piUserEntryAccepted === true
  );
}

function piAcceptedUserEntryId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { piUserEntryId?: unknown }).piUserEntryId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clearComposerAfterPiAcceptance(
  view: CodexViewTurnContext,
  item: Readonly<QueuedTurnItem>,
  source: QueuedTurnSource
): void {
  if (item.composerDraftTransferred) return;
  if (source !== "composer" && item.clearComposerAfterPiAcceptance !== true) return;
  if (view.clearAcceptedComposerDraft) view.clearAcceptedComposerDraft(item);
  else if (composerStillMatchesQueuedTurn(view, item)) view.clearComposerDraft();
}

function composerStillMatchesQueuedTurn(
  view: CodexViewTurnContext,
  item: Readonly<QueuedTurnItem>
): boolean {
  return view.plugin.settings.activeSessionId === item.sessionId
    && (item.composerTextSnapshot === undefined ? view.inputEl.value.trim() === item.text : view.inputEl.value === item.composerTextSnapshot)
    && selectionAnnotationsMatch(composerSelectionAnnotations(view.inputEl), item.selectionAnnotations ?? [])
    && attachmentListsMatch(view.attachments, item.attachments)
    && noteMentionPathsMatch(
      composerNoteMentionSelections(view.inputEl),
      item.noteMentions ?? []
    )
    && Boolean(view.drawingRequested) === Boolean(item.turnOptions?.drawingRequested)
    && (view.selectedSkill?.id ?? null) === (item.skill?.id ?? null);
}

function noteMentionPathsMatch(
  left: readonly Readonly<{ vaultRelativePath: string }>[],
  right: readonly Readonly<{ vaultRelativePath: string }>[]
): boolean {
  return left.length === right.length
    && left.every((mention, index) =>
      mention.vaultRelativePath === right[index]?.vaultRelativePath
    );
}

function attachmentListsMatch(
  left: readonly Readonly<StoredAttachment>[],
  right: readonly Readonly<StoredAttachment>[]
): boolean {
  return left.length === right.length
    && left.every((attachment, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && attachment.type === candidate.type
        && attachment.name === candidate.name
        && attachment.path === candidate.path
        && attachment.mimeType === candidate.mimeType
        && attachment.sizeBytes === candidate.sizeBytes;
    });
}

function availableDocumentInputTokens(
  view: CodexViewTurnContext,
  session: Readonly<StoredSession>,
  item: Pick<QueuedTurnItem, "turnOptions" | "noteMentions" | "selectionAnnotations">,
  submittedText: string
): number {
  const provider = view.plugin.settings.apiProviders.find(
    (candidate) => candidate.id === item.turnOptions.providerSettingsId
  );
  const model = provider
    ? getApiProviderModel(provider, item.turnOptions.model)
    : null;
  if (!provider || !model) return 0;
  const effective = calculatePiEffectiveInputBudget({
    contextWindow: model.contextWindow,
    maxOutputReserve: Math.min(model.maxOutputTokens, model.modelMaxTokens)
  });
  const ledger = session.contextLedger;
  const baseline = ledger
    && ledger.model.provider === item.turnOptions.runtimeProviderId
    && ledger.model.id === item.turnOptions.model
    && ledger.budget.contextWindow === model.contextWindow
    ? ledger.remainingInputTokens
    : effective.effectiveInputBudget - Math.max(
      4_096,
      Math.floor(effective.effectiveInputBudget * 0.15)
    );
  const selectionContext = buildPiSelectionAnnotationContextMessage(item.selectionAnnotations ?? []);
  const currentTurnTokens = estimatePiContextTokens({
    text: submittedText,
    noteMentions: [...(item.noteMentions?.map((mention) => mention.content) ?? []), ...(selectionContext ? [JSON.stringify({ type: "echoink.turn-material.v1", contextType: selectionContext.customType, content: selectionContext.content })] : [])]
  }).tokens;
  return Math.max(0, baseline - currentTurnTokens);
}

function piDocumentCapabilityTarget(
  provider: Readonly<ApiProviderConfig>,
  modelId: string
): Readonly<PiDocumentCapabilityTarget> {
  return Object.freeze({
    providerId: provider.providerId ?? "",
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    modelId,
    adapter: PI_ANTHROPIC_PDF_DOCUMENT_ADAPTER
  });
}

function preparedDocumentsMatchAttachments(
  documents: readonly Readonly<PiChatPreparedDocument>[],
  attachments: readonly Readonly<StoredAttachment>[]
): boolean {
  return documents.length === attachments.length
    && documents.every((document, index) => {
      const attachment = attachments[index];
      return attachment?.type === "file"
        && document.attachment.path === attachment.path
        && document.attachment.name === attachment.name.trim();
    });
}

function isActivePiChatRun(
  view: Pick<
    CodexViewTurnContext,
    "running" | "activeRunKind" | "activeRunSessionId"
  >,
  session: StoredSession | null
): session is StoredSession {
  return Boolean(
    session
    && session.bodyAuthority === "pi_session_only"
    && view.running
    && view.activeRunKind === "chat"
    && view.activeRunSessionId === session.id
  );
}
