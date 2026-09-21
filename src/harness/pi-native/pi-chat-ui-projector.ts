import {
  extractProcessFileRefs,
  stableHashedIdentity,
  summarizeProcessEvent
} from "../../core/mapping";
import { buildDiffSummary } from "../../core/diff-summary";
import type { ChatMessage, StoredAttachment } from "../../settings/settings";
import { noteMentionReferencesFromPiContext } from "./pi-note-mentions";
import {
  documentAttachmentsFromPiContext,
  PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
} from "./pi-document-context";
import type { KnowledgeReference } from "../../knowledge-base/types";
import type { KnowledgeBaseMaintainReportPayload } from "../../knowledge-base/maintain-report-card";
import {
  knowledgeMaintenanceEnvelopeFromToolResult,
  knowledgeMaintenanceReportPayloadFromToolResult
} from "../../knowledge-base/knowledge-maintenance-result";
import type { ProcessEventKind } from "../../types/app-server";
import type {
  PiChatRuntimeEvent,
  PiConversationDiagnostic,
  PiKnowledgeObservation,
  PiProductRunTerminalState
} from "./contracts";
import {
  resolvePiChatUiToolProductStatus,
  type PiChatUiToolApprovalView,
  type PiChatUiToolProductProjectionInput,
  type PiChatUiToolProductStatus,
  type PiChatUiToolReceiptView
} from "./pi-tool-product-state";
import {
  isEchoInkTaskPlanTerminal,
  taskPlanFromSessionEntry,
  taskPlanFromToolResult,
  type EchoInkTaskPlanSnapshot
} from "../../types/task-plan";
import { PI_TASK_UPDATE_TOOL_ID } from "./pi-task-plan";
import {
  reasoningSummaryFromSessionEntry,
  reasoningSummaryIsNewer,
  type EchoInkReasoningActivity,
  type EchoInkReasoningSummarySnapshot
} from "../../types/reasoning-summary";
import { closeReasoningSummary } from "./pi-reasoning-summary";
import {
  ECHOINK_ASSISTANT_TURN_VIEW_VERSION,
  cloneEchoInkAssistantTurn,
  cloneEchoInkTurnInteraction,
  echoInkProviderReasoningSegments,
  turnInteractionRecordFromSessionEntry,
  type EchoInkAssistantTurnSnapshot,
  type EchoInkAssistantTurnStatus,
  type EchoInkProviderReasoningSegmentSnapshot,
  type EchoInkTurnInteraction,
  type EchoInkTurnInteractionRecord
} from "../../types/conversation-turn";
import { PI_USER_QUESTION_TOOL_ID } from "./pi-user-question-tool";
import { providerFailureText } from "../pi/provider-failure";

export type {
  PiChatUiToolApprovalStatus,
  PiChatUiToolApprovalView,
  PiChatUiToolProductProjectionInput,
  PiChatUiToolProductStatus,
  PiChatUiToolReceiptStatus,
  PiChatUiToolReceiptView
} from "./pi-tool-product-state";

export interface PiApprovalPreviewChangeProjection {
  readonly path?: string;
  readonly kind: "add" | "delete" | "update" | "move" | "unknown";
  readonly added?: number;
  readonly removed?: number;
  readonly diff?: string;
}

export function piApprovalPreviewChangeProjection(
  preview: string | undefined
): PiApprovalPreviewChangeProjection | undefined {
  if (!preview?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(preview);
  } catch {
    return undefined;
  }
  const root = plainObject(parsed);
  if (!root) return undefined;
  const nestedChange = plainObject(root.change);
  const change = nestedChange ?? root;
  const path = visibleText(change.relativePath)
    || visibleText(root.relativePath);
  const kindValue = visibleText(change.kind);
  const kind = kindValue === "add"
    || kindValue === "delete"
    || kindValue === "update"
    || kindValue === "move"
    ? kindValue
    : "unknown";
  const added = nonNegativeInteger(change.added);
  const removed = nonNegativeInteger(change.removed);
  const diff = typeof change.diff === "string" && change.diff.trim()
    ? change.diff
    : undefined;
  if (!path && added === undefined && removed === undefined && !diff) return undefined;
  return Object.freeze({
    ...(path ? { path } : {}),
    kind,
    ...(added === undefined ? {} : { added }),
    ...(removed === undefined ? {} : { removed }),
    ...(diff ? { diff } : {})
  });
}

/**
 * The narrow, structural subset of a Pi content block needed by the UI.
 * Values returned by SessionManager.getBranch() satisfy this shape without the
 * projector importing a package-internal SessionEntry path.
 */
export interface PiSessionContentBlockView {
  readonly type: string;
  readonly text?: string;
  readonly mimeType?: string;
  readonly thinking?: string;
  readonly redacted?: boolean;
  readonly id?: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

/** Structural, read-only subset of a Pi AgentMessage. */
export interface PiSessionMessageView {
  readonly role: string;
  readonly content?: string | readonly PiSessionContentBlockView[];
  readonly timestamp?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly details?: unknown;
  readonly isError?: boolean;
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  readonly cancelled?: boolean;
  readonly display?: boolean;
  readonly customType?: string;
  readonly summary?: string;
  readonly fromId?: string;
  readonly tokensBefore?: number;
}

/**
 * The only Pi Session Entry surface consumed by this module. The caller must
 * pass the already-selected active Branch in root-to-leaf order.
 */
export interface PiSessionBranchEntryView {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly message?: PiSessionMessageView;
  readonly summary?: string;
  readonly firstKeptEntryId?: string;
  readonly tokensBefore?: number;
  readonly fromId?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly details?: unknown;
  readonly content?: string | readonly PiSessionContentBlockView[];
  readonly display?: boolean;
}

export type PiChatUiRunState =
  | "idle"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Optional ProductRun identities let a durable rebuild retain UI turn groups. */
export interface PiChatUiRunIdentity {
  readonly productRunId: string;
  readonly userEntryId: string;
  readonly assistantEntryId?: string;
  readonly toolCallIds?: readonly string[];
  readonly knowledgeWorkflow?: PiKnowledgeObservation["workflow"];
  readonly updatedAt?: number;
}

export interface PiChatUiViewModel {
  piSessionId: string;
  activeLeafId: string | null;
  productRunId?: string;
  runState: PiChatUiRunState;
  messages: ChatMessage[];
  diagnostics: PiConversationDiagnostic[];
  queuedSteering: string[];
  queuedFollowUp: string[];
  /** UI items created from live events that still need a Branch readback. */
  provisionalMessageIds: string[];
  /** Tool calls visible on the active Branch without a durable Tool Result. */
  pendingToolCallIds: string[];
  /** Current-session request shown by the Composer Interaction Dock. */
  pendingInteraction?: Readonly<EchoInkTurnInteraction>;
  updatedAt: number;
}

export interface PiChatUiBranchProjectionInput
  extends PiChatUiToolProductProjectionInput {
  readonly piSessionId: string;
  readonly activeLeafId: string | null;
  readonly entries: readonly PiSessionBranchEntryView[];
  readonly diagnostics?: readonly PiConversationDiagnostic[];
  readonly runState?: PiChatUiRunState;
  readonly productRunId?: string;
  readonly runIdentities?: readonly PiChatUiRunIdentity[];
  readonly queuedSteering?: readonly string[];
  readonly queuedFollowUp?: readonly string[];
  readonly vaultPath?: string;
  readonly now?: number;
}

export interface PiChatUiRuntimeProjectionInput
  extends PiChatUiToolProductProjectionInput {
  readonly current: Readonly<PiChatUiViewModel>;
  readonly event: Readonly<PiChatRuntimeEvent>;
  readonly vaultPath?: string;
}

export interface PiChatUiBranchReconciliationInput
  extends Omit<
    PiChatUiBranchProjectionInput,
    "piSessionId" | "runState" | "productRunId" | "queuedSteering" | "queuedFollowUp"
  > {
  readonly current: Readonly<PiChatUiViewModel>;
}

export interface PiChatUiMessageDecoration {
  readonly piSessionId?: string;
  readonly entryId?: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly title?: string;
  readonly details?: string;
  readonly citations?: ChatMessage["citations"];
  readonly diffSummary?: ChatMessage["diffSummary"];
  readonly files?: ChatMessage["files"];
  readonly knowledgeReferences?: readonly KnowledgeReference[];
  readonly knowledgeProducedPaths?: readonly string[];
  readonly askSourceAttribution?: ChatMessage["askSourceAttribution"];
  readonly personalMemorySources?: ChatMessage["personalMemorySources"];
}

interface BranchProjectionContext {
  readonly scope: string;
  readonly piSessionId: string;
  readonly vaultPath: string;
  readonly entryRuns: ReadonlyMap<string, string>;
  readonly toolRuns: ReadonlyMap<string, string>;
  readonly privacySafeToolRuns: ReadonlySet<string>;
  currentRunId?: string;
}

interface ToolCallProjection {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

interface DurableProviderReasoningBlock {
  readonly contentIndex: number;
  readonly text: string;
}

/**
 * Stateless translation from live Pi events or a durable active Branch into
 * the existing ChatMessage view contract. Every method returns a fresh model.
 */
export class PiChatUiProjector {
  private readonly toolExecutionTimes = new Map<string, { startedAt: number; completedAt?: number }>();

  private toolTimeKey(piSessionId: string, toolCallId: string): string {
    return `${piSessionId}:${stableHashedIdentity("reasoning-tool", toolCallId)}`;
  }

  private applyReliableToolTimes(view: PiChatUiViewModel): void {
    for (const message of view.messages) {
      const identity = projectionIdentity(message.id);
      if (identity?.kind !== "tool") continue;
      const timing = this.toolExecutionTimes.get(this.toolTimeKey(view.piSessionId, identity.value));
      if (timing) {
        message.createdAt = timing.startedAt;
        if (timing.completedAt !== undefined) message.completedAt = timing.completedAt;
        else delete message.completedAt;
      } else if (message.completedAt !== undefined) {
        // Preserve ordering, but give the timeline no invented execution interval.
        message.createdAt = message.completedAt;
      }
    }
  }


  createEmpty(input: {
    readonly piSessionId: string;
    readonly activeLeafId?: string | null;
    readonly now?: number;
  }): PiChatUiViewModel {
    return {
      piSessionId: requireIdentity(input.piSessionId, "piSessionId"),
      activeLeafId: input.activeLeafId ?? null,
      runState: "idle",
      messages: [],
      diagnostics: [],
      queuedSteering: [],
      queuedFollowUp: [],
      provisionalMessageIds: [],
      pendingToolCallIds: [],
      updatedAt: finiteTime(input.now, 0)
    };
  }

  projectSessionBranch(input: PiChatUiBranchProjectionInput): PiChatUiViewModel {
    const piSessionId = requireIdentity(input.piSessionId, "piSessionId");
    const runState = input.runState ?? "idle";
    const scope = projectionScope(piSessionId, input.activeLeafId);
    const {
      entryRuns,
      toolRuns,
      privacySafeToolRuns
    } = buildRunIdentityMaps(input.runIdentities ?? []);
    const context: BranchProjectionContext = {
      scope,
      piSessionId,
      vaultPath: input.vaultPath ?? "",
      entryRuns,
      toolRuns,
      privacySafeToolRuns,
      currentRunId: input.productRunId
    };
    // Reasoning summaries persist the actual tool events; assistant timestamps include model waiting.
    for (const entry of input.entries) {
      const summary = reasoningSummaryFromSessionEntry(entry, piSessionId);
      for (const activity of summary?.activities ?? []) {
        if (activity.kind !== "tool") continue;
        const key = `${piSessionId}:${activity.id}`;
        const previous = this.toolExecutionTimes.get(key);
        // Closing a run also closes unfinished activities at terminalAt; that is not a tool end event.
        const completedAt = (activity.status === "completed" || activity.status === "failed" || activity.status === "cancelled")
          && activity.updatedAt !== summary?.terminalAt
          ? activity.updatedAt
          : previous?.startedAt === activity.startedAt ? previous.completedAt : undefined;
        this.toolExecutionTimes.set(key, {
          startedAt: activity.startedAt,
          ...(completedAt !== undefined ? { completedAt } : {})
        });
      }
    }
    const messages: ChatMessage[] = [];
    const pendingTools = new Set<string>();

    for (const entry of input.entries) {
      this.projectDurableEntry(messages, pendingTools, entry, context);
    }
    const reopenedReasoningStatus = reopenedReasoningTerminalStatus(runState);
    if (reopenedReasoningStatus && input.productRunId) {
      const message = messages.find((candidate) =>
        candidate.reasoningSummary?.productRunId === input.productRunId
      );
      const summary = message?.reasoningSummary;
      const run = (input.runIdentities ?? []).find(
        (candidate) => candidate.productRunId === input.productRunId
      );
      if (
        summary
        && summary.terminalAt === undefined
        && run?.updatedAt !== undefined
        && Number.isFinite(run.updatedAt)
      ) {
        upsertReasoningSummaryMessage(
          messages,
          scope,
          closeReasoningSummary({
            summary,
            status: reopenedReasoningStatus,
            terminalAt: run.updatedAt
          })
        );
      }
    }
    settleUnfinishedDurableTools(messages, pendingTools, runState);

    const diagnostics = dedupeDiagnostics(
      (input.diagnostics ?? []).filter((item) => item.piSessionId === piSessionId)
    );
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === "runtime_resource_warning") continue;
      upsertMessage(messages, diagnosticMessage(scope, diagnostic));
    }
    const durableUpdatedAt = Math.max(
      0,
      ...input.entries.map(entryTime),
      ...diagnostics.map((diagnostic) => diagnostic.createdAt)
    );
    const projectionTime = finiteTime(input.now, durableUpdatedAt);
    appendRehydratedTerminalMarker(
      messages,
      scope,
      input.productRunId,
      runState,
      projectionTime
    );

    const updatedAt = latestProjectionTime(
      messages,
      diagnostics,
      projectionTime
    );
    const view: PiChatUiViewModel = {
      piSessionId,
      activeLeafId: input.activeLeafId,
      productRunId: input.productRunId,
      runState,
      messages: positionReasoningMessages(dedupeMessages(messages)),
      diagnostics,
      queuedSteering: [...(input.queuedSteering ?? [])],
      queuedFollowUp: [...(input.queuedFollowUp ?? [])],
      provisionalMessageIds: [],
      pendingToolCallIds: Array.from(pendingTools),
      updatedAt
    };
    applyToolProductStates(view, input);
    this.applyReliableToolTimes(view);
    return view;
  }

  projectRuntimeEvent(input: PiChatUiRuntimeProjectionInput): PiChatUiViewModel {
    const event = input.event;
    if (event.piSessionId !== input.current.piSessionId) {
      return cloneView(input.current);
    }
    if (
      input.current.productRunId
      && input.current.productRunId !== event.productRunId
      && (input.current.runState === "running" || input.current.runState === "finalizing")
    ) {
      return cloneView(input.current);
    }

    if (event.type === "branch_changed") {
      return this.projectBranchChange(input.current, event);
    }

    const view = cloneView(input.current);
    if (!view.productRunId || !isActiveRunState(view.runState)) {
      view.productRunId = event.productRunId;
    }
    if (view.activeLeafId === null && event.activeLeafId !== null) {
      view.activeLeafId = event.activeLeafId;
    }
    const scope = projectionScope(view.piSessionId, view.activeLeafId);
    view.updatedAt = Math.max(view.updatedAt, finiteTime(event.occurredAt, view.updatedAt));

    switch (event.type) {
      case "reasoning_summary":
        upsertReasoningSummaryMessage(
          view.messages,
          scope,
          event.summary
        );
        break;
      case "provider_reasoning_start":
        this.projectProviderReasoningStart(view, scope, event);
        break;
      case "provider_reasoning_delta":
        this.projectProviderReasoningDelta(view, event);
        break;
      case "provider_reasoning_end":
        this.projectProviderReasoningEnd(view, event);
        break;
      case "interaction_requested":
        this.projectInteractionRequested(view, scope, event);
        break;
      case "interaction_resolved":
        this.projectInteractionResolved(view, scope, event);
        break;
      case "knowledge_progress":
        this.projectKnowledgeProgress(view, scope, event);
        break;
      case "memory_recall_progress":
        this.projectMemoryRecallProgress(view, scope, event);
        break;
      case "message_start":
        if (!runtimeEventIsPrivate(event) && event.role !== "tool") {
          this.projectRuntimeMessageStart(view, scope, event);
        }
        break;
      case "message_update":
        if (!runtimeEventIsPrivate(event)) {
          this.projectRuntimeMessageUpdate(view, scope, event);
        }
        break;
      case "message_end":
        if (!runtimeEventIsPrivate(event) && event.role !== "tool") {
          this.projectRuntimeMessageEnd(view, scope, event);
        }
        break;
      case "message_entry_resolved":
        this.resolveRuntimeMessageEntry(view, scope, event.messageKey, event.entryId);
        break;
      case "tool_execution_start":
        this.projectRuntimeToolStart(view, scope, event, input.vaultPath ?? "");
        break;
      case "tool_execution_update":
        this.projectRuntimeToolUpdate(view, scope, event, input.vaultPath ?? "");
        break;
      case "tool_execution_end":
        this.projectRuntimeToolEnd(view, scope, event, input.vaultPath ?? "");
        break;
      case "compaction_start":
        this.projectRuntimeCompactionStart(view, scope, event);
        break;
      case "compaction_end":
        this.projectRuntimeCompactionEnd(view, scope, event);
        break;
      case "queue_update":
        view.queuedSteering = [...event.steering];
        view.queuedFollowUp = [...event.followUp];
        break;
      case "agent_end":
        // A lower-level loop may still retry, compact, or consume a queue.
        if (view.runState === "idle") view.runState = "running";
        break;
      case "agent_settled":
        view.runState = "finalizing";
        updateAssistantTurnStatus(
          view,
          event.productRunId,
          "completing",
          event.occurredAt
        );
        break;
      case "diagnostic":
        this.projectRuntimeDiagnostic(view, scope, event.diagnostic);
        break;
      case "product_run_settled":
        this.projectProductSettlement(view, scope, event.terminalState, event.occurredAt);
        break;
    }
    view.messages = positionReasoningMessages(dedupeMessages(view.messages));
    view.provisionalMessageIds = uniqueStrings(view.provisionalMessageIds);
    view.pendingToolCallIds = uniqueStrings(view.pendingToolCallIds);
    applyToolProductStates(view, input);
    this.applyReliableToolTimes(view);
    return view;
  }

  /**
   * Rebuilds durable items, then retains only live items that the readback has
   * not yet proven durable. This is the agent_settled correction boundary.
   */
  reconcileSessionBranch(input: PiChatUiBranchReconciliationInput): PiChatUiViewModel {
    const current = input.current;
    const rebuilt = this.projectSessionBranch({
      ...input,
      piSessionId: current.piSessionId,
      productRunId: current.productRunId,
      runState: current.runState,
      queuedSteering: current.queuedSteering,
      queuedFollowUp: current.queuedFollowUp
    });
    const durableEntryIds = new Set(input.entries.map((entry) => entry.id));
    const durableToolResultIds = toolResultIdsFromEntries(input.entries);

    const unresolved: string[] = [];
    for (const provisionalId of current.provisionalMessageIds) {
      const live = current.messages.find((message) => message.id === provisionalId);
      if (!live) continue;
      const identity = projectionIdentity(live.id);
      if (identity?.kind === "entry" && durableEntryIds.has(identity.value)) continue;
      if (identity?.kind === "tool" && durableToolResultIds.has(identity.value)) continue;
      const nextId = reScopeMessageId(live.id, projectionScope(current.piSessionId, input.activeLeafId));
      const retained = { ...live, id: nextId };
      upsertMessage(rebuilt.messages, retained);
      unresolved.push(nextId);
    }

    rebuilt.diagnostics = dedupeDiagnostics([
      ...rebuilt.diagnostics,
      ...current.diagnostics.filter((item) => item.piSessionId === current.piSessionId)
    ]);
    rebuilt.provisionalMessageIds = uniqueStrings(unresolved);
    rebuilt.pendingToolCallIds = uniqueStrings([
      ...rebuilt.pendingToolCallIds,
      ...unresolved.flatMap((id) => {
        const identity = projectionIdentity(id);
        return identity?.kind === "tool" ? [identity.value] : [];
      })
    ]);
    rebuilt.updatedAt = Math.max(rebuilt.updatedAt, current.updatedAt);
    if (current.pendingInteraction && isActiveRunState(current.runState)) {
      rebuilt.pendingInteraction = cloneEchoInkTurnInteraction(
        current.pendingInteraction
      );
    }
    rebuilt.messages = dedupeMessages(rebuilt.messages);
    applyToolProductStates(rebuilt, input);
    this.applyReliableToolTimes(rebuilt);
    return rebuilt;
  }

  /** Applies Approval/Receipt state to existing Pi-owned Tool cards only. */
  decorateToolProductState(
    current: Readonly<PiChatUiViewModel>,
    input: PiChatUiToolProductProjectionInput
  ): PiChatUiViewModel {
    const view = cloneView(current);
    applyToolProductStates(view, input);
    this.applyReliableToolTimes(view);
    return view;
  }

  /** Adds product-owned display metadata without changing Pi-owned content. */
  decorate(
    current: Readonly<PiChatUiViewModel>,
    decorations: readonly PiChatUiMessageDecoration[]
  ): PiChatUiViewModel {
    const view = cloneView(current);
    const byIdentity = new Map<string, PiChatUiMessageDecoration>();
    for (const decoration of decorations) {
      if (decoration.piSessionId && decoration.piSessionId !== view.piSessionId) {
        continue;
      }
      if (decoration.toolCallId) {
        byIdentity.set(`tool:${decoration.toolCallId}`, decoration);
      } else if (decoration.entryId) {
        byIdentity.set(`entry:${decoration.entryId}`, decoration);
      }
    }
    view.messages = view.messages.map((message) => {
      const identity = projectionIdentity(message.id);
      const decoration = identity
        ? byIdentity.get(`${identity.kind}:${identity.value}`)
        : undefined;
      if (!decoration) return message;
      return {
        ...message,
        ...(decoration.status === undefined ? {} : { status: decoration.status }),
        ...(decoration.title === undefined ? {} : { title: decoration.title }),
        ...(decoration.details === undefined ? {} : { details: decoration.details }),
        ...(decoration.citations === undefined ? {} : { citations: decoration.citations }),
        ...(decoration.diffSummary === undefined ? {} : { diffSummary: decoration.diffSummary }),
        ...(decoration.files === undefined ? {} : { files: decoration.files }),
        ...(decoration.knowledgeReferences === undefined
          ? {}
          : { knowledgeReferences: decoration.knowledgeReferences.map((reference) => ({ ...reference })) }),
        ...(decoration.knowledgeProducedPaths === undefined
          ? {}
          : { knowledgeProducedPaths: [...decoration.knowledgeProducedPaths] }),
        ...(decoration.askSourceAttribution === true
          ? {
              askSourceAttribution: true as const,
              personalMemorySources: (decoration.personalMemorySources ?? [])
                .map((source) => ({ ...source }))
            }
          : {})
      };
    });
    return view;
  }

  private projectDurableEntry(
    messages: ChatMessage[],
    pendingTools: Set<string>,
    entry: PiSessionBranchEntryView,
    context: BranchProjectionContext
  ): void {
    const createdAt = entryTime(entry);
    if (entry.type === "message" && entry.message) {
      this.projectDurableMessage(messages, pendingTools, entry, entry.message, createdAt, context);
      return;
    }
    if (entry.type === "compaction") {
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "system",
        itemType: "contextCompaction",
        processKind: "other",
        title: "上下文已压缩",
        details: entry.tokensBefore && entry.tokensBefore > 0
          ? `压缩前 ${entry.tokensBefore} tokens`
          : undefined,
        text: visibleText(entry.summary) || "上下文压缩完成",
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt,
        completedAt: createdAt
      });
      return;
    }
    if (entry.type === "branch_summary") {
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "system",
        itemType: "contextCompaction",
        processKind: "other",
        title: "已切换对话分支",
        details: visibleText(entry.fromId) ? `来源节点 ${entry.fromId}` : undefined,
        text: visibleText(entry.summary) || "已从所选节点继续对话",
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt,
        completedAt: createdAt
      });
      return;
    }
    if (entry.type === "custom_message") {
      const noteMentions = noteMentionReferencesFromPiContext(
        entry.customType,
        entry.details
      );
      const documentAttachments = documentAttachmentsFromPiContext(
        entry.customType,
        entry.details
      );
      if (noteMentions.length || documentAttachments.length) {
        if (noteMentions.length) {
          attachNoteMentionsToLatestUserMessage(messages, noteMentions);
        }
        if (documentAttachments.length) {
          attachDocumentsToLatestUserMessage(messages, documentAttachments);
        }
        return;
      }
    }
    if (entry.type === "custom_message" && entry.display !== false) {
      const text = textFromContent(entry.content);
      if (!text) return;
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "system",
        itemType: "assistant",
        title: visibleText(entry.customType) || "会话信息",
        text,
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt,
        completedAt: createdAt
      });
      return;
    }
    if (entry.type === "custom") {
      const interactionRecord = turnInteractionRecordFromSessionEntry(
        entry,
        context.piSessionId
      );
      if (interactionRecord) {
        upsertInteractionRecordMessage(
          messages,
          context.scope,
          interactionRecord.turnId,
          interactionRecord.record,
          createdAt
        );
        return;
      }
      const reasoningSummary = reasoningSummaryFromSessionEntry(
        entry,
        context.piSessionId
      );
      if (reasoningSummary) {
        upsertReasoningSummaryMessage(
          messages,
          context.scope,
          reasoningSummary
        );
        return;
      }
      const taskPlan = taskPlanFromSessionEntry(entry, context.piSessionId);
      if (taskPlan) {
        upsertTaskPlanMessage(messages, context.scope, taskPlan, createdAt);
        return;
      }
      const diagnostic = diagnosticFromCustomEntry(entry, context);
      if (diagnostic) upsertMessage(messages, diagnostic);
    }
  }

  private projectDurableMessage(
    messages: ChatMessage[],
    pendingTools: Set<string>,
    entry: PiSessionBranchEntryView,
    message: PiSessionMessageView,
    createdAt: number,
    context: BranchProjectionContext
  ): void {
    const role = normalizedRole(message.role);
    if (role === "user") {
      context.currentRunId = context.entryRuns.get(entry.id)
        ?? syntheticRunId(context.scope, entry.id);
      const text = textFromContent(message.content);
      const images = imageAttachmentsFromContent(message.content);
      if (!text && !images.length) return;
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "user",
        itemType: "user",
        text,
        ...(images.length ? { images } : {}),
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt: messageTime(message, createdAt),
        completedAt: messageTime(message, createdAt)
      });
      return;
    }
    if (role === "assistant") {
      const runId = context.entryRuns.get(entry.id) ?? context.currentRunId;
      const text = textFromContent(message.content);
      const failure = assistantFailure(message);
      const observedAt = messageTime(message, createdAt);
      if (text || failure.text) {
        upsertMessage(messages, {
          id: entryMessageId(context.scope, entry.id),
          role: "assistant",
          itemType: failure.itemType,
          title: failure.itemType === "error" ? failure.title : undefined,
          text: text || failure.text,
          ...(text && failure.itemType === "error"
            ? { details: failure.text }
            : {}),
          status: failure.status,
          providerId: visibleText(message.provider) || undefined,
          modelId: visibleText(message.model) || undefined,
          runId,
          turnId: runId,
          createdAt: observedAt,
          completedAt: observedAt
        });
      }
      for (const toolCall of toolCallsFromContent(message.content)) {
        if (
          toolCall.toolName === PI_TASK_UPDATE_TOOL_ID
          || toolCall.toolName === PI_USER_QUESTION_TOOL_ID
        ) continue;
        const toolRunId = context.toolRuns.get(toolCall.toolCallId) ?? runId;
        upsertMessage(messages, toolMessage({
          scope: context.scope,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
          privacySafe: context.privacySafeToolRuns.has(toolCall.toolCallId),
          status: initialPiToolCallStatus(toolCall.toolName),
          runId: toolRunId,
          createdAt: this.toolExecutionTimes.get(this.toolTimeKey(context.piSessionId, toolCall.toolCallId))?.startedAt ?? observedAt,
          vaultPath: context.vaultPath
        }));
        pendingTools.add(toolCall.toolCallId);
      }
      const reasoningBlocks = providerReasoningBlocksFromContent(
        message.content
      );
      if (reasoningBlocks.length) {
        projectDurableProviderReasoningSegments({
          messages,
          scope: context.scope,
          entryId: entry.id,
          runId: runId ?? syntheticRunId(context.scope, entry.id),
          observedAt,
          status: failure.status === "failed"
            ? "failed"
            : failure.status === "interrupted"
              ? "interrupted"
              : "completed",
          reasoningBlocks
        });
      }
      return;
    }
    if (role === "toolresult" || role === "tool") {
      const toolCallId = requireLooseIdentity(message.toolCallId, entry.id);
      const toolName = visibleText(message.toolName) || "tool";
      if (
        toolName === PI_TASK_UPDATE_TOOL_ID
        || toolName === PI_USER_QUESTION_TOOL_ID
      ) return;
      const resultText = textFromContent(message.content);
      const cancelled = isCancelledResult(message.details);
      const status = cancelled ? "interrupted" : message.isError ? "failed" : "completed";
      const runId = context.toolRuns.get(toolCallId) ?? context.currentRunId;
      const existing = findByIdentity(messages, "tool", toolCallId);
      const timing = this.toolExecutionTimes.get(this.toolTimeKey(context.piSessionId, toolCallId));
      const projected = toolMessage({
        scope: context.scope,
        toolCallId,
        toolName,
        args: existing?.processInput,
        result: message.details ?? resultText,
        resultText,
        privacySafe: context.privacySafeToolRuns.has(toolCallId),
        status,
        runId,
        createdAt: timing?.completedAt !== undefined ? timing.startedAt : messageTime(message, createdAt),
        completedAt: timing?.completedAt ?? messageTime(message, createdAt),
        vaultPath: context.vaultPath
      });
      const knowledgeBaseUi = projectKnowledgeMaintenanceReport({
        toolName,
        result: message.details,
        isError: message.isError === true
      });
      if (knowledgeBaseUi) projected.knowledgeBaseUi = knowledgeBaseUi;
      if (knowledgeBaseUi) projected.itemType = "knowledgeBase";
      upsertMessage(messages, mergeToolMessages(existing, projected));
      pendingTools.delete(toolCallId);
      return;
    }
    if (role === "bashexecution") {
      const status = message.cancelled
        ? "interrupted"
        : typeof message.exitCode === "number" && message.exitCode !== 0
          ? "failed"
          : "completed";
      const toolCallId = `entry-${entry.id}`;
      upsertMessage(messages, toolMessage({
        scope: context.scope,
        toolCallId,
        toolName: "bash",
        args: { command: message.command ?? "" },
        resultText: message.output ?? "",
        status,
        runId: context.currentRunId,
        createdAt: messageTime(message, createdAt),
        completedAt: messageTime(message, createdAt),
        vaultPath: context.vaultPath
      }));
      return;
    }
    if (role === "custom") {
      const noteMentions = noteMentionReferencesFromPiContext(
        message.customType,
        message.details
      );
      const documentAttachments = documentAttachmentsFromPiContext(
        message.customType,
        message.details
      );
      if (noteMentions.length || documentAttachments.length) {
        if (noteMentions.length) {
          attachNoteMentionsToLatestUserMessage(messages, noteMentions);
        }
        if (documentAttachments.length) {
          attachDocumentsToLatestUserMessage(messages, documentAttachments);
        }
        return;
      }
    }
    if (role === "custom" && message.display !== false) {
      const text = textFromContent(message.content);
      if (!text) return;
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "system",
        itemType: "assistant",
        title: visibleText(message.customType) || "会话信息",
        text,
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt: messageTime(message, createdAt),
        completedAt: messageTime(message, createdAt)
      });
      return;
    }
    if (role === "compactionsummary" || role === "branchsummary") {
      const branch = role === "branchsummary";
      upsertMessage(messages, {
        id: entryMessageId(context.scope, entry.id),
        role: "system",
        itemType: "contextCompaction",
        processKind: "other",
        title: branch ? "已切换对话分支" : "上下文已压缩",
        text: visibleText(message.summary) || (branch ? "已从所选节点继续对话" : "上下文压缩完成"),
        status: "completed",
        runId: context.currentRunId,
        turnId: context.currentRunId,
        createdAt: messageTime(message, createdAt),
        completedAt: messageTime(message, createdAt)
      });
    }
  }

  private projectProviderReasoningStart(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "provider_reasoning_start" }>
  ): void {
    const carrier = ensureAssistantTurnCarrier(view, scope, event);
    const turn = carrier.assistantTurn!;
    const segments = [...echoInkProviderReasoningSegments(turn)];
    const segmentIndex = segments.findIndex(
      (segment) => segment.reasoningId === event.reasoningId
    );
    const previous = segmentIndex >= 0 ? segments[segmentIndex] : undefined;
    const activeSince = previous?.status === "running"
      && previous.activeSince !== undefined
      ? previous.activeSince
      : event.occurredAt;
    const next = Object.freeze({
      reasoningId: event.reasoningId,
      source: "provider_public" as const,
      status: "running" as const,
      text: previous?.text ?? "",
      startedAt: previous?.startedAt ?? event.occurredAt,
      activeSince,
      updatedAt: event.occurredAt,
      ...(previous?.durationMs === undefined
        ? {}
        : { durationMs: previous.durationMs })
    });
    if (segmentIndex >= 0) segments[segmentIndex] = next;
    else segments.push(next);
    const { providerReasoning: _legacyReasoning, ...current } = turn;
    carrier.assistantTurn = {
      ...current,
      status: "running",
      updatedAt: Math.max(turn.updatedAt, event.occurredAt),
      providerReasoningSegments: Object.freeze(segments)
    };
    view.runState = "running";
  }

  private projectProviderReasoningDelta(
    view: PiChatUiViewModel,
    event: Extract<PiChatRuntimeEvent, { type: "provider_reasoning_delta" }>
  ): void {
    const carrier = findAssistantTurnCarrier(
      view,
      event.productRunId,
      event.reasoningId
    );
    const turn = carrier?.assistantTurn;
    if (!carrier || !turn || !event.textDelta) return;
    const segments = [...echoInkProviderReasoningSegments(turn)];
    const segmentIndex = segments.findIndex(
      (segment) => segment.reasoningId === event.reasoningId
    );
    const previous = segments[segmentIndex];
    if (!previous) return;
    segments[segmentIndex] = Object.freeze({
      ...previous,
      status: "running" as const,
      text: `${previous.text}${event.textDelta}`,
      updatedAt: event.occurredAt
    });
    const { providerReasoning: _legacyReasoning, ...current } = turn;
    carrier.assistantTurn = {
      ...current,
      status: "running",
      updatedAt: Math.max(turn.updatedAt, event.occurredAt),
      providerReasoningSegments: Object.freeze(segments)
    };
    view.runState = "running";
  }

  private projectProviderReasoningEnd(
    view: PiChatUiViewModel,
    event: Extract<PiChatRuntimeEvent, { type: "provider_reasoning_end" }>
  ): void {
    const carrier = findAssistantTurnCarrier(
      view,
      event.productRunId,
      event.reasoningId
    );
    const turn = carrier?.assistantTurn;
    if (!carrier || !turn) return;
    const segments = [...echoInkProviderReasoningSegments(turn)];
    const segmentIndex = segments.findIndex(
      (segment) => segment.reasoningId === event.reasoningId
    );
    const previous = segments[segmentIndex];
    if (!previous) return;
    const { providerReasoning: _legacyReasoning, ...current } = turn;
    if (!event.text.trim()) {
      segments.splice(segmentIndex, 1);
      carrier.assistantTurn = {
        ...current,
        status: assistantTurnStatusDuringRun(view),
        updatedAt: Math.max(turn.updatedAt, event.occurredAt),
        ...(segments.length
          ? { providerReasoningSegments: Object.freeze(segments) }
          : { providerReasoningSegments: undefined })
      };
      return;
    }
    const activeDuration = previous.status === "running"
      && previous.activeSince !== undefined
      ? Math.max(0, event.occurredAt - previous.activeSince)
      : 0;
    segments[segmentIndex] = Object.freeze({
      reasoningId: event.reasoningId,
      source: "provider_public" as const,
      status: event.status,
      text: event.text,
      startedAt: previous.startedAt,
      updatedAt: event.occurredAt,
      completedAt: event.occurredAt,
      durationMs: (previous.durationMs ?? 0) + activeDuration
    });
    carrier.assistantTurn = {
      ...current,
      status: assistantTurnStatusDuringRun(view),
      updatedAt: Math.max(turn.updatedAt, event.occurredAt),
      providerReasoningSegments: Object.freeze(segments)
    };
  }

  private projectRuntimeMessageStart(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "message_start" }>
  ): void {
    const id = runtimeMessageId(scope, event.messageKey);
    let existing = view.messages.find((message) => message.id === id);
    if (!existing && event.role === "user") {
      const acceptedUser = view.messages.find((message) =>
        message.role === "user"
        && message.runId === event.productRunId
        && projectionIdentity(message.id)?.kind === "entry"
      );
      if (acceptedUser) {
        removeMessage(view.messages, acceptedUser.id);
        removeProvisional(view, acceptedUser.id);
        existing = { ...acceptedUser, id };
        upsertMessage(view.messages, existing);
      }
    }
    if (!existing) {
      upsertMessage(view.messages, {
        id,
        role: event.role === "user" ? "user" : "assistant",
        itemType: event.role === "user" ? "user" : "assistant",
        text: "",
        status: event.role === "user" ? "completed" : "running",
        runId: event.productRunId,
        turnId: event.productRunId,
        createdAt: event.occurredAt
      });
    }
    addProvisional(view, id);
    view.runState = "running";
  }

  private projectMemoryRecallProgress(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "memory_recall_progress" }>
  ): void {
    const id = `${scope}:memory-recall:${event.productRunId}`;
    if (event.status === "completed") {
      removeMessage(view.messages, id);
      return;
    }
    upsertMessage(view.messages, {
      id,
      role: "assistant",
      itemType: "thinking",
      title: "正在回忆相关 Memory",
      text: memoryRecallStageText(event.stage),
      status: "running",
      runId: event.productRunId,
      turnId: event.productRunId,
      createdAt: event.occurredAt
    });
    view.runState = "running";
  }

  private projectKnowledgeProgress(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "knowledge_progress" }>
  ): void {
    const id = knowledgeProgressMessageId(
      scope,
      event.productRunId,
      event.stage
    );
    if (event.status === "completed") {
      removeMessage(view.messages, id);
      return;
    }
    const copy = knowledgeProgressCopy(event.stage);
    upsertMessage(view.messages, {
      id,
      role: "assistant",
      itemType: "thinking",
      title: copy.title,
      text: copy.text,
      status: "running",
      runId: event.productRunId,
      turnId: event.productRunId,
      createdAt: event.occurredAt
    });
    view.runState = "running";
  }

  private projectRuntimeMessageUpdate(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "message_update" }>
  ): void {
    const id = runtimeMessageId(scope, event.messageKey);
    let message = view.messages.find((item) => item.id === id);
    if (!message) {
      message = {
        id,
        role: "assistant",
        itemType: "assistant",
        text: "",
        status: "running",
        runId: event.productRunId,
        turnId: event.productRunId,
        createdAt: event.occurredAt
      };
      upsertMessage(view.messages, message);
    }
    message.text = `${message.text}${event.textDelta}`;
    if (event.textDelta.trim()) {
      removeRuntimeProgressMessages(view, scope, event.productRunId);
    }
    message.status = "running";
    delete message.completedAt;
    addProvisional(view, id);
    view.runState = "running";
  }

  private projectRuntimeMessageEnd(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "message_end" }>
  ): void {
    const provisionalId = runtimeMessageId(scope, event.messageKey);
    const id = event.entryId ? entryMessageId(scope, event.entryId) : provisionalId;
    const existing = view.messages.find((message) => message.id === provisionalId)
      ?? view.messages.find((message) => message.id === id);
    const status = runtimeMessageStatus(event.status);
    const role = event.role === "user" ? "user" : "assistant";
    const projected: ChatMessage = {
      ...(existing ?? {
        id,
        role,
        text: "",
        createdAt: event.occurredAt
      }),
      id,
      role,
      itemType: role === "assistant" && status !== "completed" ? "error" : role,
      title: role === "assistant" && status === "failed"
        ? "回答失败"
        : role === "assistant" && status === "interrupted"
          ? "回答已停止"
          : existing?.title,
      text: event.text || existing?.text || runtimeEmptyMessageText(role, status),
      status,
      runId: event.productRunId,
      turnId: event.productRunId,
      completedAt: event.occurredAt
    };
    removeMessage(view.messages, provisionalId);
    upsertMessage(view.messages, projected);
    replaceProvisional(view, provisionalId, id);
    if (role === "assistant" && projected.text.trim()) {
      removeRuntimeProgressMessages(view, scope, event.productRunId);
    }
  }

  private resolveRuntimeMessageEntry(
    view: PiChatUiViewModel,
    scope: string,
    messageKey: string,
    entryId: string
  ): void {
    const provisionalId = runtimeMessageId(scope, messageKey);
    const resolvedId = entryMessageId(scope, entryId);
    const provisional = view.messages.find((message) => message.id === provisionalId);
    const resolved = view.messages.find((message) => message.id === resolvedId);
    if (provisional) {
      removeMessage(view.messages, provisionalId);
      upsertMessage(view.messages, mergeResolvedMessage(resolved, { ...provisional, id: resolvedId }));
    }
    replaceProvisional(view, provisionalId, resolvedId);
  }

  private projectRuntimeToolStart(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "tool_execution_start" }>,
    vaultPath: string
  ): void {
    if (event.toolName === PI_USER_QUESTION_TOOL_ID) {
      view.runState = "running";
      return;
    }
    if (event.toolName === PI_TASK_UPDATE_TOOL_ID) {
      view.runState = "running";
      return;
    }
    this.toolExecutionTimes.set(this.toolTimeKey(view.piSessionId, event.toolCallId), { startedAt: event.occurredAt });
    const existing = findByIdentity(view.messages, "tool", event.toolCallId);
    const projected = toolMessage({
      scope,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      privacySafe: event.privacySafe === true,
      status: existing && terminalProcessStatus(existing.status)
        ? existing.status!
        : initialPiToolCallStatus(event.toolName),
      runId: event.productRunId,
      createdAt: event.occurredAt,
      vaultPath
    });
    upsertMessage(view.messages, mergeToolMessages(existing, projected));
    addProvisional(view, projected.id);
    addPendingTool(view, event.toolCallId);
    view.runState = "running";
  }

  private projectRuntimeToolUpdate(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "tool_execution_update" }>,
    vaultPath: string
  ): void {
    if (
      event.toolName === PI_TASK_UPDATE_TOOL_ID
      || event.toolName === PI_USER_QUESTION_TOOL_ID
    ) return;
    const existing = findByIdentity(view.messages, "tool", event.toolCallId);
    const projected = toolMessage({
      scope,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: existing?.processInput,
      result: event.update,
      resultText: displayUnknown(event.update),
      privacySafe: event.privacySafe === true,
      status: runtimeToolProgressStatus(existing, event.update),
      runId: event.productRunId,
      createdAt: existing?.createdAt ?? event.occurredAt,
      vaultPath
    });
    upsertMessage(view.messages, mergeToolMessages(existing, projected));
    addProvisional(view, projected.id);
    addPendingTool(view, event.toolCallId);
  }

  private projectRuntimeToolEnd(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "tool_execution_end" }>,
    vaultPath: string
  ): void {
    if (event.toolName === PI_USER_QUESTION_TOOL_ID) return;
    if (event.toolName === PI_TASK_UPDATE_TOOL_ID) {
      const taskPlan = taskPlanFromToolResult(event.result);
      if (taskPlan) {
        upsertTaskPlanMessage(
          view.messages,
          scope,
          taskPlan,
          event.occurredAt
        );
      }
      return;
    }
    const timing = this.toolExecutionTimes.get(this.toolTimeKey(view.piSessionId, event.toolCallId));
    if (timing) timing.completedAt = event.occurredAt;
    const existing = findByIdentity(view.messages, "tool", event.toolCallId);
    const cancelled = isCancelledResult(event.result);
    const status = cancelled ? "interrupted" : event.isError ? "failed" : "completed";
    const projected = toolMessage({
      scope,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: existing?.processInput,
      result: event.result,
      resultText: displayUnknown(event.result),
      privacySafe: event.privacySafe === true,
      status,
      runId: event.productRunId,
      createdAt: timing?.startedAt ?? event.occurredAt,
      completedAt: event.occurredAt,
      vaultPath
    });
    const knowledgeBaseUi = projectKnowledgeMaintenanceReport({
      toolName: event.toolName,
      result: event.result,
      isError: event.isError
    });
    if (knowledgeBaseUi) projected.knowledgeBaseUi = knowledgeBaseUi;
    if (knowledgeBaseUi) projected.itemType = "knowledgeBase";
    upsertMessage(view.messages, mergeToolMessages(existing, projected));
    addProvisional(view, projected.id);
    removePendingTool(view, event.toolCallId);
  }

  private projectRuntimeCompactionStart(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "compaction_start" }>
  ): void {
    const id = runtimeCompactionId(scope, event.productRunId, event.reason);
    upsertMessage(view.messages, {
      id,
      role: "system",
      itemType: "contextCompaction",
      processKind: "other",
      title: "正在压缩上下文",
      details: compactionReasonLabel(event.reason),
      text: "正在整理较早的对话，并保留近期原文。",
      status: "running",
      runId: event.productRunId,
      turnId: event.productRunId,
      createdAt: event.occurredAt
    });
    addProvisional(view, id);
    view.runState = "running";
  }

  private projectInteractionRequested(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "interaction_requested" }>
  ): void {
    const interaction = cloneEchoInkTurnInteraction(event.interaction);
    if (
      interaction.conversationId !== event.conversationId
      || interaction.piSessionId !== event.piSessionId
      || interaction.turnId !== event.productRunId
    ) return;
    view.pendingInteraction = interaction;
    const questionCount = interaction.kind === "question"
      ? interaction.questions.length
      : 1;
    upsertMessage(view.messages, {
      id: interactionMessageId(scope, interaction.interactionId),
      role: "system",
      itemType: "interactionRecord",
      processKind: "other",
      title: interaction.kind === "question" ? "等待用户回答" : "等待用户确认",
      details: interaction.kind === "question"
        ? `${questionCount} 个结构化问题`
        : "需要用户确认后继续",
      text: interaction.kind === "question"
        ? interaction.questions[0]?.prompt ?? "等待用户回答"
        : interaction.preview ?? interaction.target ?? "等待用户确认",
      status: "blocked",
      runId: event.productRunId,
      turnId: event.productRunId,
      createdAt: interaction.createdAt
    });
    view.runState = "running";
    updateAssistantTurnStatus(
      view,
      event.productRunId,
      "waiting_for_user",
      event.occurredAt
    );
  }

  private projectInteractionResolved(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "interaction_resolved" }>
  ): void {
    if (
      view.pendingInteraction?.interactionId === event.record.interactionId
      && view.pendingInteraction.turnId === event.productRunId
    ) delete view.pendingInteraction;
    upsertInteractionRecordMessage(
      view.messages,
      scope,
      event.productRunId,
      event.record,
      event.occurredAt
    );
    updateAssistantTurnStatus(
      view,
      event.productRunId,
      "running",
      event.occurredAt
    );
  }

  private projectRuntimeCompactionEnd(
    view: PiChatUiViewModel,
    scope: string,
    event: Extract<PiChatRuntimeEvent, { type: "compaction_end" }>
  ): void {
    const provisionalId = runtimeCompactionId(scope, event.productRunId, event.reason);
    const id = event.entryId ? entryMessageId(scope, event.entryId) : provisionalId;
    const existing = view.messages.find((message) => message.id === provisionalId);
    const status = event.aborted ? (event.error ? "failed" : "interrupted") : "completed";
    removeMessage(view.messages, provisionalId);
    upsertMessage(view.messages, {
      ...(existing ?? {
        id,
        role: "system",
        itemType: "contextCompaction",
        processKind: "other",
        text: "",
        createdAt: event.occurredAt
      }),
      id,
      title: event.aborted ? "上下文压缩未完成" : "上下文已压缩",
      details: compactionReasonLabel(event.reason),
      text: event.error || (event.aborted ? "本次上下文压缩已停止" : "上下文压缩完成"),
      status,
      completedAt: event.occurredAt
    });
    if (event.entryId) replaceProvisional(view, provisionalId, id);
    else removeProvisional(view, provisionalId);
  }

  private projectRuntimeDiagnostic(
    view: PiChatUiViewModel,
    scope: string,
    diagnostic: PiConversationDiagnostic
  ): void {
    if (diagnostic.piSessionId !== view.piSessionId) return;
    view.diagnostics = dedupeDiagnostics([...view.diagnostics, diagnostic]);
    upsertMessage(view.messages, diagnosticMessage(scope, diagnostic));
  }

  private projectProductSettlement(
    view: PiChatUiViewModel,
    scope: string,
    terminalState: PiProductRunTerminalState,
    occurredAt: number
  ): void {
    view.runState = terminalState;
    delete view.pendingInteraction;
    const terminalStatus = terminalState === "completed"
      ? "completed"
      : terminalState === "cancelled"
        ? "interrupted"
        : "failed";
    for (const message of view.messages) {
      if (
        message.runId !== view.productRunId
        || !runtimeMessageStillActive(message.status)
      ) continue;
      message.status = message.role === "tool" && terminalState === "cancelled"
        ? "cancelled"
        : terminalStatus;
      message.completedAt = occurredAt;
    }
    const runId = view.productRunId ?? "unknown-run";
    const hasAnswer = view.messages.some((message) =>
      message.runId === runId
      && message.role === "assistant"
      && message.itemType !== "contextCompaction"
    );
    if (terminalState === "completed" && !hasAnswer) {
      upsertMessage(view.messages, {
        id: terminalMessageId(scope, runId),
        role: "assistant",
        itemType: "assistant",
        text: "Agent 未返回可显示内容",
        status: "completed",
        runId,
        turnId: runId,
        createdAt: occurredAt,
        completedAt: occurredAt
      });
    }
    if (terminalState !== "completed") {
      upsertMessage(view.messages, {
        id: terminalMessageId(scope, runId),
        role: "system",
        itemType: "error",
        title: terminalState === "cancelled" ? "回答已停止" : "回答失败",
        text: terminalState === "cancelled" ? "已停止生成" : "Agent 执行失败",
        status: terminalStatus,
        runId,
        turnId: runId,
        createdAt: occurredAt,
        completedAt: occurredAt
      });
    }
    updateAssistantTurnStatus(
      view,
      runId,
      terminalState === "completed"
        ? "completed"
        : terminalState === "cancelled"
          ? "cancelled"
          : "failed",
      occurredAt
    );
  }

  private projectBranchChange(
    current: Readonly<PiChatUiViewModel>,
    event: Extract<PiChatRuntimeEvent, { type: "branch_changed" }>
  ): PiChatUiViewModel {
    const scope = projectionScope(current.piSessionId, event.activeLeafId);
    const next = cloneView(current);
    delete next.pendingInteraction;
    return {
      ...next,
      activeLeafId: event.activeLeafId,
      productRunId: event.productRunId,
      runState: "running",
      messages: [{
        id: branchChangeMessageId(scope),
        role: "system",
        itemType: "contextCompaction",
        processKind: "other",
        title: "正在切换对话分支",
        details: event.previousLeafId
          ? `原节点 ${event.previousLeafId}`
          : undefined,
        text: "正在从 Pi Session 的活动分支重新加载对话。",
        status: "running",
        runId: event.productRunId,
        turnId: event.productRunId,
        createdAt: event.occurredAt
      }],
      provisionalMessageIds: [],
      pendingToolCallIds: [],
      updatedAt: Math.max(current.updatedAt, event.occurredAt)
    };
  }
}

function ensureAssistantTurnCarrier(
  view: PiChatUiViewModel,
  scope: string,
  event: Pick<
    PiChatRuntimeEvent,
    "conversationId" | "productRunId" | "occurredAt"
  >
): ChatMessage {
  let carrier = view.messages.find((message) =>
    message.reasoningSummary?.productRunId === event.productRunId
  ) ?? view.messages.find((message) =>
    message.assistantTurn?.turnId === event.productRunId
  );
  if (!carrier) {
    carrier = {
      id: `${scope}:assistant-turn-state:${encodeIdentity(event.productRunId)}`,
      role: "system",
      itemType: "assistantTurnState",
      text: "",
      status: "running",
      runId: event.productRunId,
      turnId: event.productRunId,
      createdAt: event.occurredAt
    };
    upsertMessage(view.messages, carrier);
  }
  if (!carrier.assistantTurn) {
    carrier.assistantTurn = Object.freeze({
      viewVersion: ECHOINK_ASSISTANT_TURN_VIEW_VERSION,
      conversationId: event.conversationId,
      turnId: event.productRunId,
      status: assistantTurnStatusDuringRun(view),
      startedAt: event.occurredAt,
      updatedAt: event.occurredAt,
      processNodes: Object.freeze([]),
      interactionRecords: Object.freeze([])
    });
  }
  return carrier;
}

function findAssistantTurnCarrier(
  view: Readonly<PiChatUiViewModel>,
  turnId: string,
  reasoningId: string
): ChatMessage | undefined {
  return view.messages.find((message) =>
    message.assistantTurn?.turnId === turnId
    && echoInkProviderReasoningSegments(message.assistantTurn).some(
      (segment) => segment.reasoningId === reasoningId
    )
  );
}

function assistantTurnStatusDuringRun(
  view: Readonly<PiChatUiViewModel>
): EchoInkAssistantTurnStatus {
  if (view.runState === "finalizing") return "completing";
  if (view.runState === "failed") return "failed";
  if (view.runState === "cancelled") return "cancelled";
  if (view.runState === "interrupted") return "interrupted";
  if (view.runState === "completed") return "completed";
  return "running";
}

function updateAssistantTurnStatus(
  view: PiChatUiViewModel,
  turnId: string,
  status: EchoInkAssistantTurnStatus,
  observedAt: number
): void {
  for (const message of view.messages) {
    const turn = message.assistantTurn;
    if (!turn || turn.turnId !== turnId) continue;
    const terminal = status === "completed"
      || status === "failed"
      || status === "cancelled"
      || status === "interrupted";
    const { completedAt: _previousCompletedAt, ...base } = turn;
    message.assistantTurn = {
      ...base,
      status,
      updatedAt: Math.max(turn.updatedAt, observedAt),
      ...(terminal ? { completedAt: observedAt } : {})
    };
  }
}

function toolMessage(input: {
  readonly scope: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
  readonly resultText?: string;
  readonly privacySafe?: boolean;
  readonly status: string;
  readonly runId?: string;
  readonly createdAt: number;
  readonly completedAt?: number;
  readonly vaultPath: string;
}): ChatMessage {
  const personalMemoryCopy = personalMemoryToolCopy(
    input.toolName,
    input.status,
    input.result
  );
  if (personalMemoryCopy) {
    return {
      id: toolMessageId(input.scope, input.toolCallId),
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: personalMemoryCopy.processKind,
      title: personalMemoryCopy.title,
      details: undefined,
      text: personalMemoryCopy.text,
      processInput: undefined,
      processOutput: personalMemoryCopy.processOutput,
      processContentAvailability: personalMemoryCopy.processOutput
        ? "provided"
        : "unavailable",
      processInputAvailability: "empty",
      processOutputAvailability: personalMemoryCopy.processOutput
        ? "provided"
        : "unavailable",
      files: undefined,
      status: input.status,
      runId: input.runId,
      turnId: input.runId,
      createdAt: input.createdAt,
      completedAt: input.completedAt
    };
  }
  const privateCopy = input.privacySafe
    ? privacySafeKnowledgeToolCopy(input.toolName, input.status, input.result, input.resultText)
    : null;
  if (privateCopy) {
    return {
      id: toolMessageId(input.scope, input.toolCallId),
      role: "tool",
      itemType: "dynamicToolCall",
      processKind: privateCopy.processKind,
      title: privateCopy.title,
      details: privateCopy.details,
      text: privateCopy.text,
      processContentAvailability: input.status === "running"
        ? "unavailable"
        : "empty",
      processInputAvailability: "empty",
      processOutputAvailability: input.status === "running"
        ? "unavailable"
        : "empty",
      status: input.status,
      runId: input.runId,
      turnId: input.runId,
      createdAt: input.createdAt,
      completedAt: input.completedAt
    };
  }
  const itemType = toolItemType(input.toolName, input.args, input.result);
  const processKind = toolProcessKind(input.toolName, itemType);
  const processInput = displayUnknown(input.args);
  const processOutput = personalMemoryToolFailureText(
    input.toolName,
    input.result
  ) ?? input.resultText ?? displayUnknown(input.result);
  const payload = {
    tool: input.toolName,
    input: input.args,
    output: input.result,
    result: input.result
  };
  const summary = summarizeProcessEvent(itemType, payload, input.vaultPath);
  const files = extractProcessFileRefs(payload, input.vaultPath);
  const exactTitle = exactPiToolDisplayTitle(input.toolName);
  return {
    id: toolMessageId(input.scope, input.toolCallId),
    role: "tool",
    itemType,
    processKind: summary.kind === "other" ? processKind : summary.kind,
    title: exactTitle ?? summary.title ?? input.toolName ?? "工具",
    details: summary.detail || input.toolName || undefined,
    text: processOutput || processInput,
    processInput: processInput || undefined,
    processOutput: processOutput || undefined,
    processInputAvailability: processInput ? "provided" : "empty",
    processOutputAvailability: processOutput
      ? "provided"
      : input.status === "running"
        ? "unavailable"
        : "empty",
    processContentAvailability: processInput || processOutput
      ? "provided"
      : input.status === "running"
        ? "unavailable"
        : "empty",
    files: files.length ? files : undefined,
    status: input.status,
    runId: input.runId,
    turnId: input.runId,
    createdAt: input.createdAt,
    completedAt: input.completedAt
  };
}

function projectKnowledgeMaintenanceReport(input: Readonly<{
  toolName: string;
  result: unknown;
  isError: boolean;
}>): KnowledgeBaseMaintainReportPayload | null {
  if (input.toolName !== "knowledge_maintain") return null;
  const envelope = knowledgeMaintenanceEnvelopeFromToolResult(input.result);
  if (!envelope) return null;
  if (
    input.isError
    && (envelope.status === "completed" || envelope.status === "noop")
  ) return null;
  return knowledgeMaintenanceReportPayloadFromToolResult(input.result);
}

function mergeToolMessages(existing: ChatMessage | undefined, projected: ChatMessage): ChatMessage {
  if (!existing) return projected;
  return {
    ...existing,
    ...projected,
    processInput: projected.processInput || existing.processInput,
    processInputAvailability: projected.processInputAvailability
      ?? existing.processInputAvailability,
    processOutput: projected.processOutput || existing.processOutput,
    processOutputAvailability: projected.processOutputAvailability
      ?? existing.processOutputAvailability,
    text: projected.text || existing.text,
    files: projected.files?.length ? projected.files : existing.files
  };
}

const PHASE_TWO_READ_TOOL_IDS = new Set(["vault_search", "note_read"]);
const PHASE_TWO_WRITE_TOOL_IDS = new Set([
  "note_create",
  "note_update",
  "metadata_update",
  "note_move",
  "note_delete"
]);
const PHASE_THREE_BATCH_WRITE_TOOL_IDS = new Set(["knowledge_maintain"]);

function initialPiToolCallStatus(toolName: string): string {
  const toolId = normalizedToolName(toolName);
  if (PHASE_THREE_BATCH_WRITE_TOOL_IDS.has(toolId)) return "running";
  return (
    PHASE_TWO_WRITE_TOOL_IDS.has(toolId)
    || PHASE_THREE_BATCH_WRITE_TOOL_IDS.has(toolId)
  )
    ? "waiting_approval"
    : "running";
}

function applyToolProductStates(
  view: PiChatUiViewModel,
  input: PiChatUiToolProductProjectionInput
): void {
  const approvals = productRecordsByIdentity(input.approvals ?? [], view.piSessionId);
  const receipts = productRecordsByIdentity(input.receipts ?? [], view.piSessionId);
  for (const message of view.messages) {
    const identity = projectionIdentity(message.id);
    if (identity?.kind !== "tool" || !message.runId) continue;
    const key = toolProductIdentityKey(identity.value, message.runId);
    const approval = approvals.get(key);
    const receipt = receipts.get(key);
    if (approval) {
      message.approval = approvalSnapshot(approval);
      applyApprovalPreviewProjection(message, approval);
    } else delete message.approval;
    const toolId = projectedToolId(message);
    const knownRead = PHASE_TWO_READ_TOOL_IDS.has(toolId);
    const knownWrite = PHASE_TWO_WRITE_TOOL_IDS.has(toolId);
    const knownBatchWrite = PHASE_THREE_BATCH_WRITE_TOOL_IDS.has(toolId);
    if (
      !knownRead
      && !knownWrite
      && !knownBatchWrite
      && !approval
      && !receipt
    ) continue;

    const hasDurableResult = !view.provisionalMessageIds.includes(message.id)
      && !view.pendingToolCallIds.includes(identity.value);
    let piStatus = piOwnedToolStatus(message.status, hasDurableResult, knownWrite);
    if (
      approval?.status === "approved"
      && normalizedToken(message.status) === "waitingapproval"
    ) piStatus = "approved";
    const status = resolvePiChatUiToolProductStatus({
      piSessionId: view.piSessionId,
      toolCallId: identity.value,
      productRunId: message.runId,
      // The Phase 3 batch Tool Result is emitted only after its WAL and
      // Readback complete. Unlike the five Phase 2 write Tools it has no
      // separate DomainReceipt, so that durable Result is its final proof.
      writeTool: knownBatchWrite && hasDurableResult
        ? false
        : knownWrite || knownBatchWrite
          || (!knownRead && Boolean(approval || receipt)),
      piStatus,
      hasDurableResult,
      approval,
      receipt
    });
    message.status = status;
    message.details = toolProductDetails(message.details, status, approval, receipt);
    const updatedAt = latestProductRecordTime(approval, receipt);
    if (updatedAt !== undefined) view.updatedAt = Math.max(view.updatedAt, updatedAt);
    if (toolProductStatusIsTerminal(status)) {
      message.completedAt ??= updatedAt ?? message.createdAt;
    } else {
      delete message.completedAt;
    }
  }
}

function approvalSnapshot(
  approval: Readonly<PiChatUiToolApprovalView>
): NonNullable<ChatMessage["approval"]> {
  const updatedAt = finiteProductRecordTime(approval.updatedAt);
  const target = visibleText(approval.target);
  const preview = visibleText(approval.preview);
  return Object.freeze({
    status: approval.status,
    ...(target ? { target } : {}),
    ...(preview ? { preview } : {}),
    ...(updatedAt > 0 ? { updatedAt } : {})
  });
}

function applyApprovalPreviewProjection(
  message: ChatMessage,
  approval: Readonly<PiChatUiToolApprovalView>
): void {
  const change = piApprovalPreviewChangeProjection(approval.preview);
  const refs = extractProcessFileRefs([
    approval.target,
    change?.path
  ], "");
  if (refs.length) {
    const byIdentity = new Map<string, NonNullable<ChatMessage["files"]>[number]>();
    for (const ref of [...(message.files ?? []), ...refs]) {
      byIdentity.set(`${ref.kind}\0${ref.path}`, ref);
    }
    message.files = [...byIdentity.values()];
  }
  if (message.diffSummary || !change?.path) return;
  if (change.added === undefined && change.removed === undefined && !change.diff) return;
  const summary = buildDiffSummary([{
    path: change.path,
    kind: change.kind,
    diff: change.diff
  }]);
  const file = summary.files[0];
  const added = change.added ?? file.added;
  const removed = change.removed ?? file.removed;
  message.diffSummary = {
    totalFiles: 1,
    added,
    removed,
    files: [{
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      kind: file.kind,
      added,
      removed
    }]
  };
}

interface ToolProductRecordIdentity {
  readonly piSessionId?: string;
  readonly toolCallId: string;
  readonly productRunId: string;
  readonly updatedAt?: number;
}

function productRecordsByIdentity<T extends ToolProductRecordIdentity>(
  records: readonly T[],
  piSessionId: string
): ReadonlyMap<string, T> {
  const byIdentity = new Map<string, T>();
  for (const record of records) {
    if (record.piSessionId && record.piSessionId !== piSessionId) continue;
    if (!visibleText(record.toolCallId) || !visibleText(record.productRunId)) continue;
    const key = toolProductIdentityKey(record.toolCallId, record.productRunId);
    const previous = byIdentity.get(key);
    if (
      !previous
      || finiteProductRecordTime(record.updatedAt) >= finiteProductRecordTime(previous.updatedAt)
    ) byIdentity.set(key, record);
  }
  return byIdentity;
}

function toolProductIdentityKey(toolCallId: string, productRunId: string): string {
  return `${toolCallId}\u0000${productRunId}`;
}

function projectedToolId(message: ChatMessage): string {
  const title = visibleText(message.title);
  const prefix = "使用工具：";
  if (title.startsWith(prefix)) return normalizedToolName(title.slice(prefix.length));
  return normalizedToolName(title);
}

function piOwnedToolStatus(
  status: string | undefined,
  hasDurableResult: boolean,
  writeTool: boolean
): PiChatUiToolProductStatus {
  const normalized = normalizedToken(status);
  if (normalized === "waitingapproval") return "waiting_approval";
  if (normalized === "approved") return "approved";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (
    normalized === "cancelled"
    || normalized === "canceled"
    || normalized === "interrupted"
  ) return "cancelled";
  if (hasDurableResult) return "completed";
  if (writeTool && normalized === "completed") return "completed";
  return "running";
}

function toolProductDetails(
  existing: string | undefined,
  status: PiChatUiToolProductStatus,
  approval: PiChatUiToolApprovalView | undefined,
  receipt: PiChatUiToolReceiptView | undefined
): string | undefined {
  const productDetail = visibleText(receipt?.readbackSummary)
    || visibleText(receipt?.summary)
    || visibleText(approval?.preview)
    || visibleText(receipt?.target)
    || visibleText(approval?.target);
  if (productDetail) return productDetail;
  if (status === "waiting_approval") return "等待确认精确目标与改动预览";
  if (status === "approved") return "已批准，等待开始执行";
  if (status === "denied") return "本次写操作未获授权";
  if (status === "verifying") return "正在核对写后实际结果";
  if (status === "uncertain") return "写后实际结果尚不确定，请勿自动重试";
  if (status === "completed" && receipt?.readbackVerified) return "写后 Readback 已验证";
  return existing;
}

function latestProductRecordTime(
  approval: PiChatUiToolApprovalView | undefined,
  receipt: PiChatUiToolReceiptView | undefined
): number | undefined {
  const times = [approval?.updatedAt, receipt?.updatedAt].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0
  );
  return times.length ? Math.max(...times) : undefined;
}

function finiteProductRecordTime(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function toolProductStatusIsTerminal(status: PiChatUiToolProductStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "denied"
    || status === "uncertain";
}

function settleUnfinishedDurableTools(
  messages: ChatMessage[],
  pendingTools: ReadonlySet<string>,
  runState: PiChatUiRunState
): void {
  if (runState === "running" || runState === "finalizing") return;
  for (const toolCallId of pendingTools) {
    const message = findByIdentity(messages, "tool", toolCallId);
    if (!message || !runtimeMessageStillActive(message.status)) continue;
    const personalMemoryToolName = personalMemoryToolNameFromCard(message);
    message.status = runState === "cancelled" || runState === "interrupted"
      ? "cancelled"
      : "failed";
    message.completedAt = message.createdAt;
    if (personalMemoryToolName) {
      const copy = personalMemoryToolCopy(
        personalMemoryToolName,
        message.status,
        undefined
      )!;
      message.title = copy.title;
      message.text = copy.text;
      message.processOutput = copy.processOutput;
      message.processContentAvailability = copy.processOutput
        ? "provided"
        : "unavailable";
      message.processInputAvailability = "empty";
      message.processOutputAvailability = copy.processOutput
        ? "provided"
        : "unavailable";
      delete message.processInput;
      delete message.details;
      delete message.files;
      continue;
    }
    if (!message.text) message.text = "工具调用在结果提交前中断";
  }
}

function assistantFailure(message: PiSessionMessageView): {
  readonly itemType: "assistant" | "error";
  readonly status: "completed" | "failed" | "interrupted";
  readonly title?: string;
  readonly text: string;
} {
  const stopReason = normalizedToken(message.stopReason);
  if (stopReason === "length") {
    return {
      itemType: "error",
      status: "failed",
      title: "回答未完成",
      text: providerFailureText("provider_output_limit_reached")
        ?? "达到输出上限，回答未完整生成。"
    };
  }
  if (stopReason === "error") {
    return {
      itemType: "error",
      status: "failed",
      title: "回答失败",
      text: assistantFailureText(message.errorMessage)
    };
  }
  if (stopReason === "aborted" || stopReason === "cancelled" || stopReason === "canceled") {
    const errorMessage = visibleText(message.errorMessage);
    return {
      itemType: "error",
      status: "interrupted",
      title: "回答已停止",
      text: errorMessage ? assistantFailureText(errorMessage) : "已停止生成"
    };
  }
  return { itemType: "assistant", status: "completed", text: "" };
}

function assistantFailureText(errorMessage: unknown): string {
  const safe = visibleText(errorMessage);
  if (safe === PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED) {
    return "Provider 不支持该原生文档输入，且冻结文本超过当前模型的输入容量；未发起第二次请求。请减少文档、新开会话或切换容量更大的模型。";
  }
  return (providerFailureText(safe) ?? safe) || "Agent 执行失败";
}

function toolCallsFromContent(
  content: PiSessionMessageView["content"]
): ToolCallProjection[] {
  if (!Array.isArray(content)) return [];
  const calls: ToolCallProjection[] = [];
  const blocks = content as readonly PiSessionContentBlockView[];
  for (const block of blocks) {
    if (normalizedToken(block.type) !== "toolcall") continue;
    const toolCallId = visibleText(block.id) || visibleText(block.toolCallId);
    if (!toolCallId) continue;
    calls.push({
      toolCallId,
      toolName: visibleText(block.name) || "tool",
      args: block.arguments
    });
  }
  return calls;
}

function providerReasoningBlocksFromContent(
  content: PiSessionMessageView["content"]
): DurableProviderReasoningBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks = content as readonly PiSessionContentBlockView[];
  return blocks.flatMap((block, contentIndex) => {
    if (
      normalizedToken(block.type) !== "thinking"
      || block.redacted === true
      || typeof block.thinking !== "string"
      || !block.thinking.trim()
    ) return [];
    return [{ contentIndex, text: block.thinking }];
  });
}

function projectDurableProviderReasoningSegments(input: Readonly<{
  messages: ChatMessage[];
  scope: string;
  entryId: string;
  runId: string;
  observedAt: number;
  status: EchoInkProviderReasoningSegmentSnapshot["status"];
  reasoningBlocks: readonly DurableProviderReasoningBlock[];
}>): void {
  let carrier = input.messages.find((message) =>
    message.assistantTurn?.turnId === input.runId
  ) ?? input.messages.find((message) =>
    message.reasoningSummary?.productRunId === input.runId
  ) ?? input.messages.find((message) =>
    message.runId === input.runId && message.role !== "user"
  );
  if (!carrier) {
    carrier = {
      id: `${input.scope}:assistant-turn-state:${encodeIdentity(input.runId)}`,
      role: "system",
      itemType: "assistantTurnState",
      text: "",
      status: input.status,
      runId: input.runId,
      turnId: input.runId,
      createdAt: input.observedAt,
      completedAt: input.observedAt
    };
    upsertMessage(input.messages, carrier);
  }
  const previous: Readonly<EchoInkAssistantTurnSnapshot> =
    carrier.assistantTurn ?? Object.freeze({
    viewVersion: ECHOINK_ASSISTANT_TURN_VIEW_VERSION,
    turnId: input.runId,
    status: input.status,
    startedAt: input.observedAt,
    updatedAt: input.observedAt,
    completedAt: input.observedAt,
    processNodes: Object.freeze([]),
    interactionRecords: Object.freeze([])
    });
  const segments = [...echoInkProviderReasoningSegments(previous)];
  const reasoningIds = new Set(segments.map((segment) => segment.reasoningId));
  for (const block of input.reasoningBlocks) {
    const reasoningId = stableHashedIdentity(
      "provider-reasoning",
      `${input.entryId}\0${block.contentIndex}`
    );
    if (reasoningIds.has(reasoningId)) continue;
    reasoningIds.add(reasoningId);
    segments.push(Object.freeze({
      reasoningId,
      source: "provider_public" as const,
      status: input.status,
      text: block.text,
      startedAt: input.observedAt,
      updatedAt: input.observedAt,
      completedAt: input.observedAt,
      durationMs: 0
    }));
  }
  const {
    providerReasoning: _legacyProviderReasoning,
    ...current
  } = previous;
  carrier.assistantTurn = Object.freeze({
    ...current,
    status: input.status,
    startedAt: Math.min(previous.startedAt, input.observedAt),
    updatedAt: Math.max(previous.updatedAt, input.observedAt),
    completedAt: Math.max(
      previous.completedAt ?? input.observedAt,
      input.observedAt
    ),
    providerReasoningSegments: Object.freeze(segments)
  });
}

function toolResultIdsFromEntries(
  entries: readonly PiSessionBranchEntryView[]
): ReadonlySet<string> {
  const toolCallIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const role = normalizedRole(entry.message.role);
    if (role !== "toolresult" && role !== "tool") continue;
    toolCallIds.add(requireLooseIdentity(entry.message.toolCallId, entry.id));
  }
  return toolCallIds;
}

function textFromContent(
  content: string | readonly PiSessionContentBlockView[] | undefined
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = content as readonly PiSessionContentBlockView[];
  return blocks
    .filter((block) => normalizedToken(block.type) === "text")
    .map((block) => block.text ?? "")
    .join("");
}

function imageAttachmentsFromContent(
  content: PiSessionMessageView["content"]
): StoredAttachment[] {
  if (!Array.isArray(content)) return [];
  const blocks = content as readonly PiSessionContentBlockView[];
  return blocks
    .filter((block) => normalizedToken(block.type) === "image")
    .map((block, index) => {
      const mimeType = visibleText(block.mimeType);
      return {
        type: "image" as const,
        name: `图片 ${index + 1}`,
        path: "",
        ...(mimeType ? { mimeType } : {}),
        availability: "unavailable" as const
      };
    });
}

function diagnosticFromCustomEntry(
  entry: PiSessionBranchEntryView,
  context: BranchProjectionContext
): ChatMessage | undefined {
  const customType = normalizedToken(entry.customType);
  if (!customType.includes("error") && !customType.includes("diagnostic")) return undefined;
  const data = plainObject(entry.data);
  const text = visibleText(data?.message) || visibleText(data?.error) || displayUnknown(entry.data);
  if (!text) return undefined;
  const createdAt = entryTime(entry);
  return {
    id: entryMessageId(context.scope, entry.id),
    role: "system",
    itemType: "error",
    title: "会话诊断",
    text,
    status: "failed",
    runId: context.currentRunId,
    turnId: context.currentRunId,
    createdAt,
    completedAt: createdAt
  };
}

function optionalVisibleFields(data: Record<string, unknown>): {
  readonly title?: string;
  readonly details?: string;
  readonly itemType?: string;
} {
  const title = visibleText(data.title);
  const details = visibleText(data.details);
  const itemType = visibleText(data.itemType);
  return {
    ...(title ? { title } : {}),
    ...(details ? { details } : {}),
    ...(itemType ? { itemType } : {})
  };
}

function strictIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function diagnosticMessage(scope: string, diagnostic: PiConversationDiagnostic): ChatMessage {
  return {
    id: diagnosticMessageId(scope, diagnostic.diagnosticId),
    role: "system",
    itemType: "error",
    title: "会话诊断",
    details: diagnostic.code,
    text: diagnostic.message,
    status: diagnostic.code === "runtime_interrupted" ? "interrupted" : "failed",
    createdAt: diagnostic.createdAt,
    completedAt: diagnostic.createdAt
  };
}

function appendRehydratedTerminalMarker(
  messages: ChatMessage[],
  scope: string,
  productRunId: string | undefined,
  runState: PiChatUiRunState,
  createdAt: number
): void {
  if (runState !== "failed" && runState !== "cancelled" && runState !== "interrupted") return;
  const status = runState === "failed" ? "failed" : "interrupted";
  const alreadyVisible = messages.some((message) =>
    message.itemType === "error"
    && (message.status === status || (status === "interrupted" && message.status === "cancelled"))
  );
  if (alreadyVisible) return;
  const runId = productRunId ?? "rehydrated-run";
  upsertMessage(messages, {
    id: terminalMessageId(scope, runId),
    role: "system",
    itemType: "error",
    title: runState === "failed" ? "回答失败" : runState === "cancelled" ? "回答已停止" : "上次运行已中断",
    text: runState === "failed"
      ? "Agent 执行失败"
      : runState === "cancelled"
        ? "已停止生成"
        : "插件关闭前本轮尚未完成；这里只显示 Pi Session 中已验证的内容。",
    status,
    runId,
    turnId: runId,
    createdAt,
    completedAt: createdAt
  });
}

function runtimeEventIsPrivate(event: Readonly<PiChatRuntimeEvent>): boolean {
  const dynamic = event as Readonly<PiChatRuntimeEvent> & Readonly<Record<string, unknown>>;
  const contentKind = normalizedToken(
    dynamic.contentKind ?? dynamic.contentType ?? dynamic.visibility
  );
  if (contentKind === "reasoning" || contentKind === "thinking") return true;
  if (contentKind === "private" || contentKind === "hidden" || contentKind === "internal") return true;
  if ("messageKey" in event) {
    return /(^|[.:/_-])(reasoning|thinking)([.:/_-]|$)/iu.test(event.messageKey);
  }
  return false;
}

function toolItemType(toolName: string, args: unknown, result: unknown): string {
  const name = normalizedToolName(toolName);
  const hinted = visibleText(plainObject(args)?.itemType)
    || visibleText(plainObject(result)?.itemType);
  if (
    hinted === "commandExecution"
    || hinted === "fileChange"
    || hinted === "collabAgentToolCall"
    || hinted === "dynamicToolCall"
    || hinted === "mcpToolCall"
  ) return hinted;
  if (name === "memory_write") return "dynamicToolCall";
  if (/(^|[./_-])mcp([./_-]|$)/u.test(name)) return "mcpToolCall";
  if (/(^|[./_-])(shell|bash|terminal|command|exec|execute|run)([./_-]|$)/u.test(name)) return "commandExecution";
  if (/(^|[./_-])(edit|write|patch|replace|filechange)([./_-]|$)/u.test(name)) return "fileChange";
  if (/(^|[./_-])(agent|spawn|delegate|subagent)([./_-]|$)/u.test(name)) return "collabAgentToolCall";
  return "dynamicToolCall";
}

function exactPiToolDisplayTitle(toolName: string): string | undefined {
  return normalizedToolName(toolName) === "memory_write"
    ? "写入个人记忆"
    : undefined;
}

function personalMemoryToolCopy(
  toolName: string,
  status: string,
  result: unknown
): Readonly<{
  processKind: ProcessEventKind;
  title: string;
  text: string;
  processOutput?: string;
}> | null {
  const name = normalizedToolName(toolName);
  if (!["memory_search", "memory_read", "memory_write"].includes(name)) {
    return null;
  }
  const inProgress = status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying";
  const interrupted = status === "interrupted" || status === "cancelled";
  const failureText = personalMemoryToolFailureText(toolName, result);
  const copy = name === "memory_search"
    ? {
        processKind: "search" as const,
        runningTitle: "正在检查已有记忆",
        completedTitle: "已完成已有记忆检查",
        terminalTitle: "检查已有记忆",
        runningText: "正在检查是否已有相关记忆。",
        completedText: "已有记忆检查完成。",
        failedText: "已有记忆检查没有完成。"
      }
    : name === "memory_read"
      ? {
          processKind: "view" as const,
          runningTitle: "正在读取相关记忆",
          completedTitle: "已读取相关记忆",
          terminalTitle: "读取相关记忆",
          runningText: "正在读取与当前对话相关的记忆。",
          completedText: "相关记忆读取完成。",
          failedText: "相关记忆读取没有完成。"
        }
      : {
          processKind: "tool" as const,
          runningTitle: "正在整理个人记忆",
          completedTitle: "已完成个人记忆处理",
          terminalTitle: "写入个人记忆",
          runningText: "正在整理值得长期保留的信息。",
          completedText: "个人记忆处理完成。",
          failedText: "这次记忆操作没有完成，长期记忆未发生变化。"
        };
  const terminalText = failureText
    ?? (interrupted ? "这次记忆操作已停止。" : copy.failedText);
  const text = inProgress
    ? copy.runningText
    : status === "completed"
      ? copy.completedText
      : terminalText;
  return {
    processKind: copy.processKind,
    title: inProgress
      ? copy.runningTitle
      : status === "completed"
        ? copy.completedTitle
        : copy.terminalTitle,
    text,
    ...(inProgress ? {} : { processOutput: text })
  };
}

function personalMemoryToolNameFromCard(
  message: Readonly<ChatMessage>
): "memory_search" | "memory_read" | "memory_write" | null {
  const title = message.title ?? "";
  if (["正在检查已有记忆", "已完成已有记忆检查", "检查已有记忆"].includes(title)) {
    return "memory_search";
  }
  if (["正在读取相关记忆", "已读取相关记忆", "读取相关记忆"].includes(title)) {
    return "memory_read";
  }
  if (["正在整理个人记忆", "已完成个人记忆处理", "写入个人记忆"].includes(title)) {
    return "memory_write";
  }
  return null;
}

function personalMemoryToolFailureText(
  toolName: string,
  result: unknown
): string | undefined {
  if (!["memory_search", "memory_read", "memory_write"].includes(
    normalizedToolName(toolName)
  )) return undefined;
  const outer = plainObject(result);
  const details = plainObject(outer?.details) ?? outer;
  switch (visibleText(details?.errorCode)) {
    case "personal_memory_no_memory":
      return "长期记忆开关已关闭，本次操作没有执行。";
    case "personal_memory_invalid_request":
      return "这次记忆操作未通过检查，没有执行。";
    case "personal_memory_current_turn_search_required":
      return "写入未完成：本轮还没有先检查是否已有相同记忆。";
    case "personal_memory_not_found":
      return "没有找到要处理的长期记忆，本次操作没有执行。";
    case "personal_memory_revision_conflict":
      return "长期记忆刚刚发生了变化，本次操作没有执行。";
    case "personal_memory_vault_mismatch":
      return "当前请求与正在使用的资料库不一致，本次操作没有执行。";
    case "personal_memory_unsafe_path":
      return "记忆存储位置未通过安全检查，本次操作已停止。";
    case "personal_memory_result_too_large":
      return "返回内容过多，请缩小范围后重试。";
    case "personal_memory_authorization_failed":
      return "这次记忆操作未通过系统校验，没有执行。";
    case "operation_cancelled":
      return "这次记忆操作已取消。";
    case "personal_memory_failed":
      return "这次记忆操作没有完成，长期记忆未发生变化。";
    default:
      return undefined;
  }
}

function toolProcessKind(toolName: string, itemType: string): ProcessEventKind {
  if (itemType === "commandExecution") return "command";
  if (itemType === "fileChange") return "edit";
  const name = normalizedToolName(toolName);
  if (/(^|[./_-])(read|open|view|cat|fetch)([./_-]|$)/u.test(name)) return "view";
  if (/(^|[./_-])(search|grep|find|glob|lookup|list)([./_-]|$)/u.test(name)) return "search";
  return "tool";
}

function displayUnknown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  const object = plainObject(value);
  if (object) {
    const content = object.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = textFromContent(content as PiSessionContentBlockView[]);
      if (text) return text;
    }
    for (const key of ["text", "output", "message", "error"]) {
      const direct = object[key];
      if (typeof direct === "string" && direct) return direct;
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "无法显示结构化结果";
  }
}

function isCancelledResult(value: unknown): boolean {
  const object = plainObject(value);
  if (!object) return false;
  return object.cancelled === true
    || object.canceled === true
    || normalizedToken(object.status) === "cancelled"
    || normalizedToken(object.status) === "canceled";
}

function runtimeToolProgressStatus(
  existing: ChatMessage | undefined,
  update: unknown
): string {
  if (existing && terminalProcessStatus(existing.status)) return existing.status!;
  const object = plainObject(update);
  const phase = normalizedToken(object?.phase ?? object?.status);
  return phase === "approved" ? "approved" : "running";
}

function buildRunIdentityMaps(identities: readonly PiChatUiRunIdentity[]): {
  readonly entryRuns: ReadonlyMap<string, string>;
  readonly toolRuns: ReadonlyMap<string, string>;
  readonly privacySafeToolRuns: ReadonlySet<string>;
} {
  const entryRuns = new Map<string, string>();
  const toolRuns = new Map<string, string>();
  const privacySafeToolRuns = new Set<string>();
  for (const identity of identities) {
    if (!identity.productRunId || !identity.userEntryId) continue;
    entryRuns.set(identity.userEntryId, identity.productRunId);
    if (identity.assistantEntryId) entryRuns.set(identity.assistantEntryId, identity.productRunId);
    for (const toolCallId of identity.toolCallIds ?? []) {
      if (!toolCallId) continue;
      toolRuns.set(toolCallId, identity.productRunId);
      if (identity.knowledgeWorkflow) privacySafeToolRuns.add(toolCallId);
    }
  }
  return { entryRuns, toolRuns, privacySafeToolRuns };
}

function projectionScope(piSessionId: string, activeLeafId: string | null): string {
  return `pi:${encodeIdentity(piSessionId)}:leaf:${encodeIdentity(activeLeafId ?? "root")}`;
}

function entryMessageId(scope: string, entryId: string): string {
  return `${scope}:entry:${encodeIdentity(entryId)}`;
}

function toolMessageId(scope: string, toolCallId: string): string {
  return `${scope}:tool:${encodeIdentity(toolCallId)}`;
}

function taskPlanMessageId(scope: string, planId: string): string {
  return `${scope}:task-plan:${encodeIdentity(planId)}`;
}

function interactionMessageId(scope: string, interactionId: string): string {
  return `${scope}:interaction:${encodeIdentity(interactionId)}`;
}

function reasoningSummaryMessageId(scope: string, productRunId: string): string {
  return `${scope}:reasoning:${encodeIdentity(productRunId)}`;
}

function runtimeMessageId(scope: string, messageKey: string): string {
  return `${scope}:provisional-message:${encodeIdentity(messageKey)}`;
}

function knowledgeProgressMessageId(
  scope: string,
  productRunId: string,
  stage: Extract<
    PiChatRuntimeEvent,
    { type: "knowledge_progress" }
  >["stage"]
): string {
  return `${scope}:knowledge-progress:${encodeIdentity(productRunId)}:${stage}`;
}

function runtimeCompactionId(scope: string, runId: string, reason: string): string {
  return `${scope}:provisional-compaction:${encodeIdentity(runId)}:${encodeIdentity(reason)}`;
}

function diagnosticMessageId(scope: string, diagnosticId: string): string {
  return `${scope}:diagnostic:${encodeIdentity(diagnosticId)}`;
}

function branchChangeMessageId(scope: string): string {
  return `${scope}:branch-change`;
}

function terminalMessageId(scope: string, runId: string): string {
  return `${scope}:terminal:${encodeIdentity(runId)}`;
}

function syntheticRunId(scope: string, userEntryId: string): string {
  return `${scope}:turn:${encodeIdentity(userEntryId)}`;
}

function projectionIdentity(id: string): { readonly kind: "entry" | "tool"; readonly value: string } | undefined {
  const match = /:(entry|tool):([^:]+)$/u.exec(id);
  if (!match) return undefined;
  return {
    kind: match[1] as "entry" | "tool",
    value: decodeIdentity(match[2])
  };
}

export function piEntryIdFromProjectedMessageId(
  messageId: string
): string | undefined {
  const identity = projectionIdentity(messageId);
  return identity?.kind === "entry" ? identity.value : undefined;
}

export function piToolCallIdFromProjectedMessageId(
  messageId: string
): string | undefined {
  const identity = projectionIdentity(messageId);
  return identity?.kind === "tool" ? identity.value : undefined;
}

export function piRuntimeMessageKeyFromProjectedMessageId(
  messageId: string
): string | undefined {
  const provisionalMessage = /:provisional-message:([^:]+)$/u.exec(messageId);
  return provisionalMessage ? decodeIdentity(provisionalMessage[1]) : undefined;
}

export function piProjectedEntryMessageId(
  piSessionId: string,
  activeLeafId: string | null,
  entryId: string
): string {
  return entryMessageId(
    projectionScope(requireIdentity(piSessionId, "piSessionId"), activeLeafId),
    requireIdentity(entryId, "entryId")
  );
}

function reScopeMessageId(id: string, scope: string): string {
  const identity = projectionIdentity(id);
  if (identity?.kind === "entry") return entryMessageId(scope, identity.value);
  if (identity?.kind === "tool") return toolMessageId(scope, identity.value);
  const provisionalMessage = /:provisional-message:([^:]+)$/u.exec(id);
  if (provisionalMessage) return runtimeMessageId(scope, decodeIdentity(provisionalMessage[1]));
  const provisionalCompaction = /:provisional-compaction:([^:]+):([^:]+)$/u.exec(id);
  if (provisionalCompaction) {
    return runtimeCompactionId(
      scope,
      decodeIdentity(provisionalCompaction[1]),
      decodeIdentity(provisionalCompaction[2])
    );
  }
  return id;
}

function findByIdentity(
  messages: readonly ChatMessage[],
  kind: "entry" | "tool",
  value: string
): ChatMessage | undefined {
  return messages.find((message) => {
    const identity = projectionIdentity(message.id);
    return identity?.kind === kind && identity.value === value;
  });
}

function mergeResolvedMessage(existing: ChatMessage | undefined, live: ChatMessage): ChatMessage {
  if (!existing) return live;
  return {
    ...live,
    ...existing,
    text: existing.text || live.text,
    createdAt: Math.min(existing.createdAt, live.createdAt)
  };
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): void {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) messages[index] = { ...messages[index], ...message };
  else messages.push(message);
}

function upsertReasoningSummaryMessage(
  messages: ChatMessage[],
  scope: string,
  summary: Readonly<EchoInkReasoningSummarySnapshot>
): void {
  const id = reasoningSummaryMessageId(scope, summary.productRunId);
  const existing = messages.find(
    (message) => message.id === id && message.reasoningSummary
  );
  if (
    existing?.reasoningSummary
    && !reasoningSummaryIsNewer(summary, existing.reasoningSummary)
  ) return;
  const terminalAt = summary.terminalAt;
  upsertMessage(messages, {
    id,
    role: "assistant",
    itemType: "reasoning",
    processKind: "reasoning",
    title: reasoningSummaryTitle(summary),
    text: reasoningSummaryText(summary),
    processContentAvailability: summary.activities.length ? "provided" : "empty",
    status: summary.status,
    reasoningSummary: summary,
    runId: summary.productRunId,
    turnId: summary.productRunId,
    createdAt: summary.startedAt,
    ...(terminalAt === undefined ? {} : { completedAt: terminalAt })
  });
}

function reasoningSummaryTitle(
  summary: Readonly<EchoInkReasoningSummarySnapshot>
): string {
  if (summary.status === "running") return "正在思考";
  const endpoint = summary.status === "completed"
    ? summary.firstAssistantTextAt ?? summary.terminalAt ?? summary.updatedAt
    : summary.terminalAt ?? summary.updatedAt;
  const seconds = Math.max(1, Math.round(
    Math.max(0, endpoint - summary.startedAt) / 1_000
  ));
  if (summary.status === "completed") return `思考完成 · ${seconds} 秒`;
  if (summary.status === "interrupted") return `思考中断 · ${seconds} 秒`;
  if (summary.status === "cancelled") return `思考已取消 · ${seconds} 秒`;
  return `处理失败 · ${seconds} 秒`;
}

function reasoningSummaryText(
  summary: Readonly<EchoInkReasoningSummarySnapshot>
): string {
  if (summary.activities.length === 0) return "";
  return summary.activities.map(reasoningActivityText).join("\n");
}

function reopenedReasoningTerminalStatus(
  runState: PiChatUiRunState
): Exclude<EchoInkReasoningSummarySnapshot["status"], "running"> | null {
  if (runState === "completed") return "completed";
  if (runState === "failed") return "failed";
  if (runState === "cancelled") return "cancelled";
  if (runState === "interrupted" || runState === "idle") return "interrupted";
  return null;
}

function reasoningActivityText(
  activity: Readonly<EchoInkReasoningActivity>
): string {
  const progress = activity.total === undefined
    ? ""
    : ` · ${activity.current ?? activity.completed ?? 0}/${activity.total}`;
  if (activity.kind === "provider") {
    return `${reasoningActivityStatusCopy(activity.status, "请求模型")}${progress}`;
  }
  if (activity.kind === "knowledge") {
    return `${reasoningStageCopy(activity.stage, "处理 Knowledge")}${progress}`;
  }
  if (activity.kind === "memory") {
    return `${reasoningStageCopy(activity.stage, "处理 Memory")}${progress}`;
  }
  if (activity.kind === "task") {
    return `${reasoningActivityStatusCopy(activity.status, "更新任务计划")}${progress}`;
  }
  return reasoningActivityStatusCopy(
    activity.status,
    `执行 ${activity.name ?? "工具"}`
  );
}

function reasoningActivityStatusCopy(
  status: EchoInkReasoningActivity["status"],
  activeCopy: string
): string {
  if (status === "active") return activeCopy;
  if (status === "completed") return `${activeCopy}完成`;
  if (status === "failed") return `${activeCopy}失败`;
  if (status === "cancelled") return `${activeCopy}已取消`;
  return `${activeCopy}中断`;
}

function reasoningStageCopy(
  stage: EchoInkReasoningActivity["stage"],
  fallback: string
): string {
  switch (stage) {
    case "requesting": return "请求模型";
    case "searching": return "检索 Knowledge";
    case "continuing_search": return "继续检索 Knowledge";
    case "reading_knowledge": return "读取 Knowledge";
    case "comparing_memory": return "比对 Memory";
    case "checking_conflicts_freshness": return "检查冲突与时效";
    case "refining_knowledge": return "提炼 Knowledge";
    case "writing_and_readback": return "写入并回读 Knowledge";
    case "loading": return "加载 Memory";
    case "catalog": return "检查 Memory 目录";
    case "matching": return "匹配 Memory";
    case "budgeting": return "分配 Memory 上下文";
    case "assembling": return "组装 Memory 上下文";
    case "pending": return "等待任务计划";
    case "in_progress": return "执行任务计划";
    case "paused": return "任务计划已中断";
    case "completed": return "任务计划已完成";
    case "failed": return "任务计划失败";
    case "cancelled": return "任务计划已取消";
    default: return fallback;
  }
}

function positionReasoningMessages(messages: ChatMessage[]): ChatMessage[] {
  for (const reasoning of messages.filter((message) =>
    message.itemType === "reasoning" && Boolean(message.reasoningSummary)
  )) {
    const currentIndex = messages.findIndex((message) => message.id === reasoning.id);
    if (currentIndex < 0) continue;
    const userIndex = messages.findIndex((message) =>
      message.role === "user"
      && message.runId === reasoning.runId
    );
    if (userIndex < 0 || currentIndex === userIndex + 1) continue;
    messages.splice(currentIndex, 1);
    const nextUserIndex = messages.findIndex((message) =>
      message.role === "user"
      && message.runId === reasoning.runId
    );
    messages.splice(nextUserIndex + 1, 0, reasoning);
  }
  return messages;
}

function upsertTaskPlanMessage(
  messages: ChatMessage[],
  scope: string,
  plan: Readonly<EchoInkTaskPlanSnapshot>,
  observedAt: number
): void {
  const id = taskPlanMessageId(scope, plan.planId);
  const existing = messages.find(
    (message) => message.taskPlan?.planId === plan.planId
  );
  if (
    existing?.taskPlan
    && existing.taskPlan.version > plan.version
  ) return;
  if (existing && existing.id !== id) removeMessage(messages, existing.id);
  const terminal = isEchoInkTaskPlanTerminal(plan.status);
  upsertMessage(messages, {
    id,
    role: "assistant",
    itemType: "taskPlan",
    text: "",
    status: plan.status,
    taskPlan: plan,
    runId: plan.productRunId,
    turnId: plan.productRunId,
    createdAt: existing?.createdAt ?? plan.createdAt ?? observedAt,
    ...(terminal ? { completedAt: plan.updatedAt } : {})
  });
}

function upsertInteractionRecordMessage(
  messages: ChatMessage[],
  scope: string,
  turnId: string,
  record: Readonly<EchoInkTurnInteractionRecord>,
  observedAt: number
): void {
  const id = interactionMessageId(scope, record.interactionId);
  const existing = messages.find((message) =>
    message.interactionRecord?.interactionId === record.interactionId
    || message.id === id
  );
  if (
    existing?.interactionRecord
    && existing.interactionRecord.updatedAt > record.updatedAt
  ) return;
  if (existing && existing.id !== id) removeMessage(messages, existing.id);
  const status = interactionRecordMessageStatus(record.outcome);
  upsertMessage(messages, {
    id,
    role: "system",
    itemType: "interactionRecord",
    processKind: "other",
    title: interactionRecordTitle(record),
    details: record.summary,
    text: record.summary,
    status,
    interactionRecord: Object.freeze({ ...record }),
    runId: turnId,
    turnId,
    createdAt: existing?.createdAt ?? observedAt,
    completedAt: record.updatedAt
  });
}

function interactionRecordMessageStatus(
  outcome: EchoInkTurnInteractionRecord["outcome"]
): "completed" | "failed" | "cancelled" {
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled" || outcome === "denied" || outcome === "expired") {
    return "cancelled";
  }
  return "completed";
}

function interactionRecordTitle(
  record: Readonly<EchoInkTurnInteractionRecord>
): string {
  if (record.kind === "question") return "用户已回答";
  if (record.outcome === "approved") return "用户已批准";
  if (record.outcome === "denied") return "用户已拒绝";
  if (record.outcome === "completed") return "确认已执行";
  if (record.outcome === "failed") return "交互失败";
  if (record.outcome === "expired") return "交互已过期";
  return "交互已取消";
}

function removeMessage(messages: ChatMessage[], id: string): void {
  const index = messages.findIndex((message) => message.id === id);
  if (index >= 0) messages.splice(index, 1);
}

function dedupeMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) upsertMessage(result, cloneProjectedMessage(message));
  return result;
}

function cloneView(current: Readonly<PiChatUiViewModel>): PiChatUiViewModel {
  return {
    ...current,
    messages: current.messages.map(cloneProjectedMessage),
    diagnostics: current.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    queuedSteering: [...current.queuedSteering],
    queuedFollowUp: [...current.queuedFollowUp],
    provisionalMessageIds: [...current.provisionalMessageIds],
    pendingToolCallIds: [...current.pendingToolCallIds],
    ...(current.pendingInteraction
      ? { pendingInteraction: cloneEchoInkTurnInteraction(current.pendingInteraction) }
      : {})
  };
}

function cloneProjectedMessage(message: Readonly<ChatMessage>): ChatMessage {
  return {
    ...message,
    ...(message.approval ? { approval: { ...message.approval } } : {}),
    ...(message.attachments
      ? { attachments: message.attachments.map((attachment) => ({ ...attachment })) }
      : {}),
    ...(message.images
      ? { images: message.images.map((image) => ({ ...image })) }
      : {}),
    ...(message.noteMentions
      ? { noteMentions: message.noteMentions.map((mention) => ({ ...mention })) }
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
  };
}

function attachNoteMentionsToLatestUserMessage(
  messages: ChatMessage[],
  noteMentions: NonNullable<ChatMessage["noteMentions"]>
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    message.noteMentions = noteMentions.map((mention) => ({ ...mention }));
    return;
  }
}

function attachDocumentsToLatestUserMessage(
  messages: ChatMessage[],
  documents: readonly Readonly<StoredAttachment>[]
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const merged = new Map<string, StoredAttachment>();
    for (const attachment of [...(message.attachments ?? []), ...documents]) {
      const identity = attachment.path.trim();
      if (!identity || merged.has(identity)) continue;
      merged.set(identity, { ...attachment, type: "file" });
    }
    message.attachments = [...merged.values()];
    return;
  }
}

function addProvisional(view: PiChatUiViewModel, id: string): void {
  if (!view.provisionalMessageIds.includes(id)) view.provisionalMessageIds.push(id);
}

function removeProvisional(view: PiChatUiViewModel, id: string): void {
  view.provisionalMessageIds = view.provisionalMessageIds.filter((item) => item !== id);
}

function replaceProvisional(view: PiChatUiViewModel, previousId: string, nextId: string): void {
  const hadPrevious = view.provisionalMessageIds.includes(previousId);
  removeProvisional(view, previousId);
  if (hadPrevious || previousId === nextId) addProvisional(view, nextId);
}

function addPendingTool(view: PiChatUiViewModel, toolCallId: string): void {
  if (!view.pendingToolCallIds.includes(toolCallId)) view.pendingToolCallIds.push(toolCallId);
}

function removePendingTool(view: PiChatUiViewModel, toolCallId: string): void {
  view.pendingToolCallIds = view.pendingToolCallIds.filter((item) => item !== toolCallId);
}

function dedupeDiagnostics(
  diagnostics: readonly PiConversationDiagnostic[]
): PiConversationDiagnostic[] {
  const byId = new Map<string, PiConversationDiagnostic>();
  for (const diagnostic of diagnostics) byId.set(diagnostic.diagnosticId, { ...diagnostic });
  return Array.from(byId.values()).sort((left, right) => left.createdAt - right.createdAt);
}

function normalizedRole(value: string): string {
  return normalizedToken(value);
}

function normalizedToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "")
    : "";
}

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "_");
}

function visibleText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function entryTime(entry: PiSessionBranchEntryView): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageTime(message: PiSessionMessageView, fallback: number): number {
  return finiteTime(message.timestamp, fallback);
}

function finiteTime(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function latestProjectionTime(
  messages: readonly ChatMessage[],
  diagnostics: readonly PiConversationDiagnostic[],
  fallback: number
): number {
  return Math.max(
    fallback,
    ...messages.map((message) => message.completedAt ?? message.createdAt),
    ...diagnostics.map((diagnostic) => diagnostic.createdAt)
  );
}

function runtimeMessageStatus(status: "completed" | "failed" | "cancelled" | undefined): string {
  if (status === "failed") return "failed";
  if (status === "cancelled") return "interrupted";
  return "completed";
}

function runtimeEmptyMessageText(role: "user" | "assistant", status: string): string {
  if (role === "user") return "";
  if (status === "failed") return "Agent 执行失败";
  if (status === "interrupted") return "已停止生成";
  return "";
}

function memoryRecallStageText(
  stage: Extract<PiChatRuntimeEvent, { type: "memory_recall_progress" }>["stage"]
): string {
  switch (stage) {
    case "loading": return "正在读取 Memory 真源";
    case "catalog": return "正在核对完整 Memory 索引";
    case "matching": return "正在寻找相关历史";
    case "budgeting": return "正在按上下文预算筛选";
    case "assembling": return "正在组装本轮 Recall 上下文";
  }
}

function knowledgeProgressCopy(
  stage: Extract<
    PiChatRuntimeEvent,
    { type: "knowledge_progress" }
  >["stage"]
): Readonly<{ title: string; text: string }> {
  switch (stage) {
    case "searching":
      return { title: "正在检索知识库", text: "正在查找相关本地知识" };
    case "continuing_search":
      return { title: "正在继续查找", text: "当前证据不足，继续读取后续结果" };
    case "reading_knowledge":
      return { title: "正在读取相关笔记", text: "正在核对可引用的真实内容" };
    case "comparing_memory":
      return { title: "正在比对历史偏好", text: "正在核对相关 Personal Memory" };
    case "checking_conflicts_freshness":
      return { title: "正在检查冲突与时效", text: "已发现来源变化或时效冲突信号" };
    case "refining_knowledge":
      return { title: "正在提炼知识", text: "正在锁定来源、核对冲突并生成知识候选" };
    case "writing_and_readback":
      return { title: "正在写入并回读", text: "正在通过 WAL 与 CAS 安全写入并核对最终文件" };
  }
}

function privacySafeKnowledgeToolCopy(
  toolName: string,
  status: string,
  result: unknown,
  resultText: string | undefined
): Readonly<{
  processKind: ProcessEventKind;
  title: string;
  details: string;
  text: string;
}> | null {
  const inProgress = runtimeMessageStillActive(status);
  const completed = status === "completed";
  const title = (running: string, success: string, stopped: string) =>
    inProgress ? running : completed ? success : stopped;
  const text = (running: string, success: string) =>
    inProgress ? running : completed ? success
      : status === "interrupted" || status === "cancelled"
        ? "本次操作已停止，未确认完成。"
        : privacySafeToolFailureText(result, resultText);
  switch (toolName) {
    case "knowledge_search":
    case "vault_search":
      return {
        processKind: "search",
        title: title("正在检索知识库", "知识库检索完成", "检索知识库"),
        details: "Knowledge 索引",
        text: text("正在查找相关本地知识", "已完成本次知识库检索")
      };
    case "knowledge_read":
    case "note_read":
      return {
        processKind: "view",
        title: title("正在读取相关笔记", "相关笔记读取完成", "读取相关笔记"),
        details: "只读笔记",
        text: text("正在核对可引用的真实内容", "已完成本次只读核对")
      };
    case "memory_search":
    case "memory_read":
      return {
        processKind: toolName === "memory_search" ? "search" : "view",
        title: title("正在比对历史偏好", "历史偏好比对完成", "比对历史偏好"),
        details: "只读 Personal Memory",
        text: text("正在核对相关 Personal Memory", "已完成本次历史偏好核对")
      };
    case "knowledge_maintain":
      return {
        processKind: "other",
        title: title("正在处理知识维护", "知识维护处理完成", "处理知识维护"),
        details: "固定六步协议",
        text: text("正在提炼、写入并回读验证", "已完成本次维护 Tool")
      };
    default:
      return {
        processKind: "other",
        title: title("Knowledge Agent 正在处理", "Knowledge Agent 工具完成", "Knowledge Agent 工具"),
        details: "隐私安全进度",
        text: text("正在执行受控本地步骤", "已完成本次受控处理")
      };
  }
}

function privacySafeToolFailureText(result: unknown, resultText: string | undefined): string {
  const copy: Readonly<Record<string, string>> = {
    target_not_found: "未找到目标文件，文件可能尚未创建或路径已变化。",
    target_kind_invalid: "目标类型不符合本次操作要求，文件与文件夹不能互换。",
    knowledge_not_found: "未找到目标资料，资料可能已移除或尚未进入索引。",
    knowledge_source_changed: "来源内容已变化，本次读取未完成。",
    knowledge_cursor_stale: "检索结果已更新，本次后续页未读取。",
    knowledge_cursor_invalid: "后续页位置无效，本次检索未完成。",
    knowledge_invalid_request: "本次检索或阅读参数不符合要求。",
    knowledge_unsupported_content: "暂不支持读取这份资料的内容格式。",
    knowledge_read_failed: "本次知识读取未完成，记录未保留可展示的具体原因。",
    tool_policy_blocked: "此次调用被阻止，记录未保留具体原因。",
    authorization_failed: "此次调用未通过执行校验，没有执行。",
    approval_denied: "此次操作未获批准，没有执行。",
    approval_cancelled: "此次操作已取消。",
    operation_cancelled: "此次操作已取消。"
  };
  // Live events wrap content/details; durable blocked calls can contain only a code.
  // Match known codes exactly, never render raw result bodies or exception messages.
  const outer = plainObject(result);
  const content = Array.isArray(outer?.content) ? outer.content : [];
  const candidates: unknown[] = [result, resultText, ...content.map((item) => plainObject(item)?.text)];
  for (let value of candidates) {
    if (typeof value === "string") {
      const code = value.trim();
      if (Object.hasOwn(copy, code)) return copy[code];
      try { value = JSON.parse(code); } catch { continue; }
    }
    const record = plainObject(value);
    const details = plainObject(record?.details);
    const error = plainObject(record?.error);
    for (const code of [details?.errorCode, record?.errorCode, error?.code, record?.error, record?.code]) {
      if (typeof code === "string" && Object.hasOwn(copy, code)) return copy[code];
    }
  }
  return "本次操作未完成，记录未保留可展示的具体原因。";
}

function removeRuntimeProgressMessages(
  view: PiChatUiViewModel,
  scope: string,
  productRunId: string
): void {
  removeMessage(view.messages, `${scope}:memory-recall:${productRunId}`);
  view.messages = view.messages.filter((message) =>
    !message.id.startsWith(
      `${scope}:knowledge-progress:${encodeIdentity(productRunId)}:`
    )
  );
}

function terminalProcessStatus(status: string | undefined): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "denied"
    || status === "uncertain"
    || status === "interrupted"
    || status === "unconfirmed";
}

function runtimeMessageStillActive(status: string | undefined): boolean {
  return status === "running"
    || status === "waiting_approval"
    || status === "approved"
    || status === "verifying";
}

function isActiveRunState(state: PiChatUiRunState): boolean {
  return state === "running" || state === "finalizing";
}

function compactionReasonLabel(reason: "manual" | "threshold" | "overflow"): string {
  if (reason === "overflow") return "上下文溢出恢复";
  if (reason === "threshold") return "达到模型上下文阈值";
  return "手动压缩";
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function requireLooseIdentity(value: string | undefined, fallback: string): string {
  return visibleText(value) || fallback;
}

function encodeIdentity(value: string): string {
  return encodeURIComponent(value);
}

function decodeIdentity(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
