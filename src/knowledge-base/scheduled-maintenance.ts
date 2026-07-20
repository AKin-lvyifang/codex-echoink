import { isDeepStrictEqual } from "node:util";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import {
  createConversationMessageRevision,
  type ConversationMessageAuthorityProof
} from "../harness/conversation/conversation-store";
import {
  ensureKnowledgeBaseSession,
  newId,
  type ChatMessage,
  type KnowledgeBaseNativeLifecycleRecoveryReceipt,
  type KnowledgeBaseSettings,
  type StoredSession
} from "../settings/settings";
import type { KnowledgeBaseNativeLifecycleSummary } from "./agent-task-service";
import { localDateKeyForTimestamp } from "./history-store";
import { appendKnowledgeBaseWarning, saveSettingsSafely } from "./maintenance";
import { buildKnowledgeBaseMaintainReportPayload } from "./maintain-report-card";
import { readKnowledgeBaseReportExcerpt } from "./report";
import { buildScheduledKnowledgeBaseMessage } from "./scheduled-message";
import type { KnowledgeBaseRunResult } from "./types";

const SCHEDULED_MAINTENANCE_SAVE_OPTIONS = {
  strictConversationStore: true,
  strictKnowledgeBaseHistory: true
} as const;

export interface ScheduledMaintenanceMessageAuthorityReceipt {
  state: "durable" | "absent" | "ambiguous";
  conversationId: string;
  messageId: string;
  payloadDigest: string;
  durableMessageCount: number;
  liveMessageCount: number;
  reason: string;
}

export class ScheduledMaintenanceMessageAuthorityError extends Error {
  readonly code = "scheduled_message_authority_ambiguous";

  constructor(
    readonly receipt: ScheduledMaintenanceMessageAuthorityReceipt,
    cause: unknown
  ) {
    super(
      `Scheduled maintenance message authority is ambiguous for ${receipt.messageId}: ${receipt.reason}`,
      { cause }
    );
    this.name = "ScheduledMaintenanceMessageAuthorityError";
  }
}

export async function appendScheduledMaintenanceMessage(
  plugin: CodexForObsidianPlugin,
  result: KnowledgeBaseRunResult,
  afterMessageSaved: () => Promise<KnowledgeBaseNativeLifecycleSummary | null | void>
): Promise<void> {
  const settings = plugin.settings;
  let sessionsBeforeAppend: StoredSession[] = [];
  let sessionIdBeforeAppend = "";
  let scheduledSessionId: string | null = null;
  let scheduledMessageId: string | null = null;
  let scheduledMessage: ChatMessage | null = null;
  let scheduledMessageAdded = false;
  let scheduledSessionAfterAppend: StoredSession | null = null;
  try {
    const reportText = result.reportPath
      ? await readKnowledgeBaseReportExcerpt(plugin.getVaultPath(), result.reportPath, 3000).catch(() => null)
      : null;
    const message = buildScheduledMaintenanceChatMessage(result, reportText ?? "");
    scheduledMessageId = message.id;
    await plugin.externalizeMessageText(message, message.text);
    scheduledMessage = clonePlainValue(message);
    // Do not capture a rollback baseline across report or Raw externalization
    // awaits. Concurrent live mutations completed there are part of the
    // pre-append state and must survive a proven-absent rollback.
    sessionsBeforeAppend = cloneStoredSessions(settings.sessions);
    sessionIdBeforeAppend = settings.knowledgeBase.sessionId;
    const session = ensureKnowledgeBaseSession(settings, plugin.getVaultPath());
    scheduledSessionId = session.id;
    session.messages.push(message);
    scheduledMessageAdded = true;
    session.title = "知识库管理";
    session.updatedAt = message.createdAt;
    scheduledSessionAfterAppend = clonePlainValue(session);
    await plugin.saveSettings(true, SCHEDULED_MAINTENANCE_SAVE_OPTIONS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = await plugin.withEchoInkSettingsPersistenceAuthorityGate(
      async () => {
        const authority = scheduledMessageAdded && scheduledSessionId && scheduledMessage
          ? await readScheduledMaintenanceMessageAuthority(
            plugin,
            scheduledSessionId,
            scheduledMessage
          )
          : scheduledMaintenanceMessageAbsentReceipt(
            scheduledSessionId ?? "",
            scheduledMessageId ?? "",
            scheduledMessage,
            "scheduled message was not added to the live Conversation candidate"
          );
        if (authority.state === "durable") {
          // saveSettings is a multi-store transaction. Conversation pass 1 is
          // the source authority, so later History, Conversation pass 2, or
          // data.json failure cannot turn its commit into a rollback candidate.
          console.warn(
            "每日维护消息已由 Conversation authority 确认耐久，继续恢复剩余提交",
            message,
            authority
          );
          return "durable" as const;
        }
        if (authority.state === "absent") {
          if (scheduledMessageAdded) {
            rollbackScheduledMaintenanceMessage(settings, {
              sessionsBeforeAppend,
              sessionIdBeforeAppend,
              scheduledSessionId,
              scheduledMessageId,
              scheduledMessage,
              scheduledSessionAfterAppend
            });
          }
          // Raw ownership is cross-Store. Preserve its sidecar for the
          // reference-graph GC even when the Conversation append is absent.
          settings.knowledgeBase.lastError = appendKnowledgeBaseWarning(
            settings.knowledgeBase.lastError,
            `自动维护消息保存失败：${message}`
          );
          return "absent" as const;
        }

        // Neither rollback nor another settings write is safe: either could
        // delete a source that is durable but temporarily unreadable.
        const warning = `自动维护消息持久化状态不明确，已停止后续提交：${message}；${authority.reason}`;
        settings.knowledgeBase.lastError = appendKnowledgeBaseWarning(
          settings.knowledgeBase.lastError,
          warning
        );
        plugin.poisonEchoInkSettingsPersistenceForRecovery(warning);
        new Notice("每日维护消息持久化状态不明确，已停止后续提交");
        throw new ScheduledMaintenanceMessageAuthorityError(authority, error);
      }
    );
    if (outcome === "absent") {
      await saveSettingsSafely(plugin, SCHEDULED_MAINTENANCE_SAVE_OPTIONS);
      new Notice(`每日维护消息保存失败：${message}`);
      return;
    }
  }
  let lifecycleSummary: KnowledgeBaseNativeLifecycleSummary | null | void;
  try {
    lifecycleSummary = await afterMessageSaved();
  } catch (error) {
    lifecycleSummary = {
      localCommitStatus: "failed",
      cleanupStatuses: ["retained-for-recovery"],
      cleanupAttempted: false,
      disposedCount: 0,
      recordIds: [],
      recoveryRequired: true,
      warning: `Native Execution 本地持久化收口状态未知：${errorMessage(error)}`
    };
  }
  const recovery = reconcileKnowledgeBaseNativeLifecycleRecovery(
    settings.knowledgeBase,
    lifecycleSummary
  );
  if (recovery.changed) {
    const warningSaveError = await saveSettingsSafely(plugin);
    if (recovery.state === "recovery-pending") {
      console.warn(
        recovery.issue === "local-persistence"
          ? "每日维护结果尚未完全提交，本地持久化待恢复"
          : "每日维护结果已保存，但 Native Execution 清理待恢复",
        recovery.message,
        ...(warningSaveError ? [`恢复收据保存失败：${warningSaveError}`] : [])
      );
    } else if (warningSaveError) {
      console.warn(
        "每日维护 Native Execution 恢复状态清除保存失败",
        warningSaveError
      );
    }
  }
  await plugin.pruneKnowledgeBaseHistoryByRetention().catch((cleanupError) => console.warn("知识库历史清理失败", cleanupError));
  try {
    plugin.getCodexView()?.refreshAfterBackgroundKnowledgeMessage();
  } catch (error) {
    console.warn("每日维护消息刷新失败", error);
  }
}

const NATIVE_RECOVERY_WARNING_IDS = new Set([
  "native-local-commit-recovery",
  "native-cleanup-recovery"
]);

export interface KnowledgeBaseNativeLifecycleRecoveryReconciliation {
  changed: boolean;
  state: "unchanged" | "recovery-pending" | "cleared";
  issue?: KnowledgeBaseNativeLifecycleRecoveryReceipt["issue"];
  message?: string;
}

export function reconcileKnowledgeBaseNativeLifecycleRecovery(
  settings: KnowledgeBaseSettings,
  summary: KnowledgeBaseNativeLifecycleSummary | null | void,
  observedAt = Date.now()
): KnowledgeBaseNativeLifecycleRecoveryReconciliation {
  const previousReceipt = settings.nativeLifecycleRecoveryReceipt;
  const issue = summary ? nativeLifecycleRecoveryIssue(summary) : null;
  if (previousReceipt) {
    if (summary && summaryProvesNativeLifecycleRecovery(previousReceipt, summary)) {
      clearKnowledgeBaseNativeLifecycleRecovery(settings);
      if (issue) {
        return projectKnowledgeBaseNativeLifecycleRecovery(
          settings,
          summary,
          issue,
          observedAt,
          observedAt
        );
      }
      return {
        changed: true,
        state: "cleared"
      };
    }

    if (
      summary
      && previousReceipt.issue === "native-cleanup"
      && issue === "local-persistence"
    ) {
      // A cleanup-only receipt proves the business result was already saved.
      // A newer uncommitted local result is the stronger safety obligation, so
      // keep that exact batch visible while Native Store retains old cleanup.
      clearKnowledgeBaseNativeLifecycleRecovery(settings);
      return projectKnowledgeBaseNativeLifecycleRecovery(
        settings,
        summary,
        issue,
        observedAt,
        observedAt
      );
    }

    const summaryRecordIds = summary
      ? normalizedNativeLifecycleRecordIds(summary.recordIds)
      : [];
    if (
      summary
      && issue === previousReceipt.issue
      && summaryRecordIds.length > 0
      && sameRecordIds(previousReceipt.recordIds, summaryRecordIds)
    ) {
      clearKnowledgeBaseNativeLifecycleRecovery(settings);
      return projectKnowledgeBaseNativeLifecycleRecovery(
        settings,
        summary,
        issue,
        previousReceipt.firstObservedAt,
        observedAt
      );
    }

    const changed = ensureKnowledgeBaseNativeLifecycleRecoveryProjection(
      settings,
      previousReceipt,
      observedAt
    );
    return {
      changed,
      state: changed ? "recovery-pending" : "unchanged",
      issue: previousReceipt.issue,
      message: previousReceipt.message
    };
  }

  if (!summary || !issue) {
    return { changed: false, state: "unchanged" };
  }
  return projectKnowledgeBaseNativeLifecycleRecovery(
    settings,
    summary,
    issue,
    observedAt,
    observedAt
  );
}

function nativeLifecycleRecoveryIssue(
  summary: KnowledgeBaseNativeLifecycleSummary
): KnowledgeBaseNativeLifecycleRecoveryReceipt["issue"] | null {
  return summary.localCommitStatus === "failed"
    ? "local-persistence"
    : summary.recoveryRequired
      ? "native-cleanup"
      : null;
}

function projectKnowledgeBaseNativeLifecycleRecovery(
  settings: KnowledgeBaseSettings,
  summary: KnowledgeBaseNativeLifecycleSummary,
  issue: KnowledgeBaseNativeLifecycleRecoveryReceipt["issue"],
  firstObservedAt: number,
  observedAt: number
): KnowledgeBaseNativeLifecycleRecoveryReconciliation {
  const warningId = issue === "local-persistence"
    ? "native-local-commit-recovery"
    : "native-cleanup-recovery";
  const detail = summary.warning?.trim() || (
    issue === "local-persistence"
      ? "Native Execution 本地提交待恢复"
      : "Native Execution 清理待恢复"
  );
  const errorProjection = issue === "local-persistence"
    ? `自动维护结果尚未完全提交；${detail}`
    : `自动维护结果已保存；${detail}`;
  const summaryProjection = nativeLifecycleRecoverySummaryProjection(issue);
  const lastErrorBefore = settings.lastError;
  const lastSummaryBefore = settings.lastSummary;
  const lastErrorWithRecovery = appendKnowledgeBaseWarning(
    lastErrorBefore,
    errorProjection
  );
  const lastSummaryWithRecovery = appendKnowledgeBaseWarning(
    lastSummaryBefore,
    summaryProjection
  );
  const receipt: KnowledgeBaseNativeLifecycleRecoveryReceipt = {
    schemaVersion: 1,
    issue,
    warningId,
    localCommitStatus: summary.localCommitStatus ?? "unknown",
    cleanupStatuses: Array.from(new Set(summary.cleanupStatuses)),
    cleanupAttempted: summary.cleanupAttempted,
    recordIds: normalizedNativeLifecycleRecordIds(summary.recordIds),
    message: errorProjection,
    firstObservedAt,
    updatedAt: observedAt,
    projection: {
      lastErrorBefore,
      lastSummaryBefore,
      lastErrorWithRecovery,
      lastSummaryWithRecovery
    }
  };

  settings.lastError = lastErrorWithRecovery;
  settings.lastSummary = lastSummaryWithRecovery;
  settings.lastWarnings = [
    ...settings.lastWarnings.filter(
      (entry) => !NATIVE_RECOVERY_WARNING_IDS.has(entry.id)
    ),
    {
      id: warningId,
      message: errorProjection
    }
  ];
  settings.nativeLifecycleRecoveryReceipt = receipt;
  return {
    changed: true,
    state: "recovery-pending",
    issue,
    message: errorProjection
  };
}

function ensureKnowledgeBaseNativeLifecycleRecoveryProjection(
  settings: KnowledgeBaseSettings,
  receipt: KnowledgeBaseNativeLifecycleRecoveryReceipt,
  observedAt: number
): boolean {
  const lastErrorBefore = removeStructuredRecoveryProjection(
    settings.lastError,
    receipt.projection.lastErrorBefore,
    receipt.projection.lastErrorWithRecovery
  );
  const lastSummaryBefore = removeStructuredRecoveryProjection(
    settings.lastSummary,
    receipt.projection.lastSummaryBefore,
    receipt.projection.lastSummaryWithRecovery
  );
  const lastErrorWithRecovery = appendKnowledgeBaseWarning(
    lastErrorBefore,
    receipt.message
  );
  const lastSummaryWithRecovery = appendKnowledgeBaseWarning(
    lastSummaryBefore,
    nativeLifecycleRecoverySummaryProjection(receipt.issue)
  );
  const lastWarnings = [
    ...settings.lastWarnings.filter(
      (entry) => !NATIVE_RECOVERY_WARNING_IDS.has(entry.id)
    ),
    {
      id: receipt.warningId,
      message: receipt.message
    }
  ];
  const projectionChanged = receipt.projection.lastErrorBefore !== lastErrorBefore
    || receipt.projection.lastSummaryBefore !== lastSummaryBefore
    || receipt.projection.lastErrorWithRecovery !== lastErrorWithRecovery
    || receipt.projection.lastSummaryWithRecovery !== lastSummaryWithRecovery;
  const changed = settings.lastError !== lastErrorWithRecovery
    || settings.lastSummary !== lastSummaryWithRecovery
    || !sameKnowledgeBaseWarnings(settings.lastWarnings, lastWarnings)
    || projectionChanged;
  if (!changed) return false;

  settings.lastError = lastErrorWithRecovery;
  settings.lastSummary = lastSummaryWithRecovery;
  settings.lastWarnings = lastWarnings;
  settings.nativeLifecycleRecoveryReceipt = {
    ...receipt,
    updatedAt: observedAt,
    projection: {
      lastErrorBefore,
      lastSummaryBefore,
      lastErrorWithRecovery,
      lastSummaryWithRecovery
    }
  };
  return true;
}

function clearKnowledgeBaseNativeLifecycleRecovery(
  settings: KnowledgeBaseSettings
): boolean {
  const receipt = settings.nativeLifecycleRecoveryReceipt;
  let changed = false;
  if (receipt) {
    const nextLastError = removeStructuredRecoveryProjection(
      settings.lastError,
      receipt.projection.lastErrorBefore,
      receipt.projection.lastErrorWithRecovery
    );
    if (nextLastError !== settings.lastError) {
      settings.lastError = nextLastError;
      changed = true;
    }
    const nextLastSummary = removeStructuredRecoveryProjection(
      settings.lastSummary,
      receipt.projection.lastSummaryBefore,
      receipt.projection.lastSummaryWithRecovery
    );
    if (nextLastSummary !== settings.lastSummary) {
      settings.lastSummary = nextLastSummary;
      changed = true;
    }
    settings.nativeLifecycleRecoveryReceipt = null;
    changed = true;
  }
  const retainedWarnings = settings.lastWarnings.filter(
    (entry) => !NATIVE_RECOVERY_WARNING_IDS.has(entry.id)
  );
  if (retainedWarnings.length !== settings.lastWarnings.length) {
    settings.lastWarnings = retainedWarnings;
    changed = true;
  }
  return changed;
}

function nativeLifecycleRecoverySummaryProjection(
  issue: KnowledgeBaseNativeLifecycleRecoveryReceipt["issue"]
): string {
  return issue === "local-persistence"
    ? "自动维护结果尚未完全提交；本地持久化待恢复，Native Execution 恢复收据已保留。"
    : "Native Execution 清理待恢复，不影响已保存的维护结果。";
}

function normalizedNativeLifecycleRecordIds(recordIds: string[]): string[] {
  return Array.from(new Set(
    recordIds.map((recordId) => recordId.trim()).filter(Boolean)
  ));
}

function sameRecordIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((recordId) => rightIds.has(recordId));
}

function sameKnowledgeBaseWarnings(
  left: KnowledgeBaseSettings["lastWarnings"],
  right: KnowledgeBaseSettings["lastWarnings"]
): boolean {
  return left.length === right.length
    && left.every((warning, index) => (
      warning.id === right[index]?.id
      && warning.message === right[index]?.message
    ));
}

function summaryProvesNativeLifecycleRecovery(
  receipt: KnowledgeBaseNativeLifecycleRecoveryReceipt,
  summary: KnowledgeBaseNativeLifecycleSummary
): boolean {
  if (!receipt.recordIds.length) return false;
  const summaryRecordIds = new Set(
    normalizedNativeLifecycleRecordIds(summary.recordIds)
  );
  if (!receipt.recordIds.every((recordId) => summaryRecordIds.has(recordId))) {
    return false;
  }
  if (receipt.issue === "local-persistence") {
    return summary.localCommitStatus === "committed";
  }
  const safelySettledCleanupStatuses = new Set([
    "not-needed",
    "disposed",
    "unsupported",
    "retained"
  ]);
  return !summary.recoveryRequired
    && summary.cleanupStatuses.length >= summaryRecordIds.size
    && summary.cleanupStatuses.every(
      (status) => safelySettledCleanupStatuses.has(status)
    );
}

function removeStructuredRecoveryProjection(
  current: string,
  before: string,
  withRecovery: string
): string {
  if (current === withRecovery) return before;
  const structuredPrefix = `${withRecovery}；`;
  if (!current.startsWith(structuredPrefix)) return current;
  return appendKnowledgeBaseWarning(
    before,
    current.slice(structuredPrefix.length)
  );
}

export function buildScheduledMaintenanceChatMessage(
  result: KnowledgeBaseRunResult,
  reportText = "",
  createdAt = Date.now()
): ChatMessage {
  const ui = buildKnowledgeBaseMaintainReportPayload("maintain", result);
  return {
    id: newId("msg"),
    role: "assistant",
    title: "每日知识库维护",
    itemType: "knowledgeBase",
    status: result.status === "success"
      ? "completed"
      : result.status === "canceled"
        ? "canceled"
        : "failed",
    text: buildScheduledKnowledgeBaseMessage(result, reportText),
    ...(ui.runId ? { runId: ui.runId } : {}),
    ...(ui.backend ? { backendId: ui.backend } : {}),
    knowledgeBaseUi: ui,
    createdAt,
    completedAt: createdAt
  };
}

async function readScheduledMaintenanceMessageAuthority(
  plugin: CodexForObsidianPlugin,
  conversationId: string,
  expectedMessage: ChatMessage
): Promise<ScheduledMaintenanceMessageAuthorityReceipt> {
  const messageId = expectedMessage.id;
  const payloadDigest = createConversationMessageRevision(expectedMessage);
  const liveSession = plugin.settings.sessions.find(
    (session) => session.id === conversationId
  );
  const liveMessages = liveSession?.messages.filter(
    (message) => message.id === messageId
  ) ?? [];
  if (
    liveMessages.length > 1
    || (
      liveMessages.length === 1
      && createConversationMessageRevision(liveMessages[0]) !== payloadDigest
    )
  ) {
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: 0,
      liveMessageCount: liveMessages.length,
      reason: liveMessages.length > 1
        ? "live Conversation contains duplicate scheduled message IDs"
        : "live scheduled message payload does not match the append target"
    };
  }

  let proof: ConversationMessageAuthorityProof;
  try {
    proof = await plugin.proveEchoInkConversationMessageAuthority({
      conversationId,
      messageId,
      expectedMessage
    });
  } catch (error) {
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: 0,
      liveMessageCount: liveMessages.length,
      reason: `Conversation authority readback failed: ${errorMessage(error)}`
    };
  }
  const liveAfterProof = plugin.settings.sessions
    .find((session) => session.id === conversationId)
    ?.messages.filter((message) => message.id === messageId) ?? [];
  if (
    liveAfterProof.length > 1
    || (
      liveAfterProof.length === 1
      && createConversationMessageRevision(liveAfterProof[0]) !== payloadDigest
    )
  ) {
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: proof.matchingMessageCount,
      liveMessageCount: liveAfterProof.length,
      reason: liveAfterProof.length > 1
        ? "live Conversation changed to duplicate scheduled message IDs during authority readback"
        : "live scheduled message payload changed during authority readback"
    };
  }
  if (proof.state === "conflict") {
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: proof.matchingMessageCount,
      liveMessageCount: liveAfterProof.length,
      reason: proof.matchingMessageCount > 1
        ? "canonical Conversation contains duplicate scheduled message IDs"
        : "canonical scheduled message payload conflicts with the append target"
    };
  }
  if (proof.state === "durable") {
    if (liveAfterProof.length === 1) {
      return {
        state: "durable",
        conversationId,
        messageId,
        payloadDigest,
        durableMessageCount: 1,
        liveMessageCount: 1,
        reason: "scheduled message ID and payload match canonical Conversation"
      };
    }
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: 1,
      liveMessageCount: liveAfterProof.length,
      reason: "canonical scheduled message is durable but the live candidate no longer owns it"
    };
  }

  try {
    const historyMessages = await plugin.readKnowledgeBaseHistoryDay(
      conversationId,
      localDateKeyForTimestamp(expectedMessage.createdAt)
    );
    if (historyMessages.some((message) => message.id === messageId)) {
      return {
        state: "ambiguous",
        conversationId,
        messageId,
        payloadDigest,
        durableMessageCount: 0,
        liveMessageCount: liveAfterProof.length,
        reason: "scheduled message is absent from Conversation but remains in History"
      };
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      return {
        state: "ambiguous",
        conversationId,
        messageId,
        payloadDigest,
        durableMessageCount: 0,
        liveMessageCount: liveAfterProof.length,
        reason: `History contradiction readback failed: ${errorMessage(error)}`
      };
    }
  }
  const liveAfterHistory = plugin.settings.sessions
    .find((session) => session.id === conversationId)
    ?.messages.filter((message) => message.id === messageId) ?? [];
  if (
    liveAfterHistory.length > 1
    || (
      liveAfterHistory.length === 1
      && createConversationMessageRevision(liveAfterHistory[0]) !== payloadDigest
    )
  ) {
    return {
      state: "ambiguous",
      conversationId,
      messageId,
      payloadDigest,
      durableMessageCount: 0,
      liveMessageCount: liveAfterHistory.length,
      reason: liveAfterHistory.length > 1
        ? "live Conversation changed to duplicate scheduled message IDs during History readback"
        : "live scheduled message payload changed during History readback"
    };
  }
  return {
    state: "absent",
    conversationId,
    messageId,
    payloadDigest,
    durableMessageCount: 0,
    liveMessageCount: liveAfterHistory.length,
    reason: "scheduled message ID is absent from Conversation and History"
  };
}

function scheduledMaintenanceMessageAbsentReceipt(
  conversationId: string,
  messageId: string,
  expectedMessage: ChatMessage | null,
  reason: string
): ScheduledMaintenanceMessageAuthorityReceipt {
  return {
    state: "absent",
    conversationId,
    messageId,
    payloadDigest: expectedMessage
      ? createConversationMessageRevision(expectedMessage)
      : "",
    durableMessageCount: 0,
    liveMessageCount: 0,
    reason
  };
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function rollbackScheduledMaintenanceMessage(
  settings: CodexForObsidianPlugin["settings"],
  options: {
    sessionsBeforeAppend: StoredSession[];
    sessionIdBeforeAppend: string;
    scheduledSessionId: string | null;
    scheduledMessageId: string | null;
    scheduledMessage: ChatMessage | null;
    scheduledSessionAfterAppend: StoredSession | null;
  }
): void {
  const beforeById = new Map(
    options.sessionsBeforeAppend.map((session) => [session.id, session])
  );
  const scheduledSession = options.scheduledSessionId
    ? settings.sessions.find((session) => session.id === options.scheduledSessionId)
    : null;
  if (
    scheduledSession
    && options.scheduledMessageId
    && options.scheduledMessage
  ) {
    const matchingMessages = scheduledSession.messages.filter(
      (message) => message.id === options.scheduledMessageId
    );
    const targetStillExact = matchingMessages.length === 1
      && createConversationMessageRevision(matchingMessages[0])
        === createConversationMessageRevision(options.scheduledMessage);
    if (!targetStillExact) return;
    const sessionIsExactAppendCandidate = Boolean(
      options.scheduledSessionAfterAppend
      && isDeepStrictEqual(
        scheduledSession,
        options.scheduledSessionAfterAppend
      )
    );
    scheduledSession.messages = scheduledSession.messages.filter(
      (message) => message !== matchingMessages[0]
    );
    const beforeSession = beforeById.get(scheduledSession.id);
    if (!beforeSession) {
      if (
        sessionIsExactAppendCandidate
        && scheduledSession.messages.length === 0
      ) {
        settings.sessions = settings.sessions.filter((session) => session.id !== scheduledSession.id);
      }
    } else if (sessionIsExactAppendCandidate) {
      replaceStoredSessionInPlace(scheduledSession, beforeSession);
    }
  }
  if (settings.knowledgeBase.sessionId === options.scheduledSessionId) {
    const scheduledStillExists = Boolean(options.scheduledSessionId && settings.sessions.some((session) => session.id === options.scheduledSessionId));
    settings.knowledgeBase.sessionId = scheduledStillExists
      ? options.scheduledSessionId
      : options.sessionIdBeforeAppend;
  }
}

function replaceStoredSessionInPlace(
  target: StoredSession,
  source: StoredSession
): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, clonePlainValue(source));
}

function cloneStoredSessions(sessions: StoredSession[] | undefined): StoredSession[] {
  return clonePlainValue(sessions ?? []);
}

function clonePlainValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePlainValue(item)) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePlainValue(entry)])
    ) as T;
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
