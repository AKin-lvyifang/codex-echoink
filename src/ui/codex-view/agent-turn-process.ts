import type { ChatMessage, SettingsLanguage } from "../../settings/settings";
import {
  conversationCopy,
  type ConversationCopy
} from "../../settings/i18n";
import { knowledgeUsageMessageData } from "../../knowledge-base/usage";
import {
  echoInkProviderReasoningSegments,
  type EchoInkAssistantTurnStatus,
  type EchoInkProviderReasoningSegmentSnapshot,
  type EchoInkProviderReasoningSnapshot,
  type EchoInkTurnInteractionRecord,
  type EchoInkTurnProcessNode,
  type EchoInkTurnProcessNodeKind,
  type EchoInkTurnProcessNodeStatus
} from "../../types/conversation-turn";
import type { EchoInkReasoningActivity } from "../../types/reasoning-summary";
import { stableHashedIdentity } from "../../core/mapping";
import { piToolCallIdFromProjectedMessageId } from "../../harness/pi-native/pi-chat-ui-projector";
import { shouldDisplayReasoning } from "./reasoning-visibility";

const ACTIVE_STATUSES = new Set([
  "running",
  "in_progress",
  "inProgress",
  "approval",
  "blocked",
  "waiting_approval",
  "approved",
  "verifying",
  "recovery-pending"
]);
const WAITING_USER_STATUSES = new Set(["approval", "blocked", "waiting_approval"]);
const FAILED_STATUSES = new Set(["failed", "error", "recovery-blocked"]);
const CANCELLED_STATUSES = new Set(["canceled", "cancelled", "denied"]);
const INTERRUPTED_STATUSES = new Set(["interrupted", "unconfirmed", "uncertain"]);
const ATTENTION_PROCESS_STATUSES = new Set([
  "unconfirmed",
  "interrupted",
  "failed",
  "error",
  "canceled",
  "cancelled",
  "denied",
  "uncertain",
  "recovery-blocked"
]);

/** One stable, bubble-free row for every keyed assistant run or turn. */
export interface AgentTurnView {
  readonly key: string;
  readonly runId: string;
  readonly turnId: string;
  readonly status: EchoInkAssistantTurnStatus;
  readonly messages: readonly ChatMessage[];
  readonly messageIndices: readonly number[];
  readonly processMessages: readonly ChatMessage[];
  readonly processIndices: readonly number[];
  readonly processNodes: readonly Readonly<EchoInkTurnProcessNode>[];
  readonly providerReasoningSegments: readonly Readonly<
    EchoInkProviderReasoningSegmentSnapshot
  >[];
  /** Transitional single-segment view until the Elements renderer consumes all segments. */
  readonly providerReasoning?: Readonly<EchoInkProviderReasoningSnapshot>;
  readonly interactionRecords: readonly Readonly<EchoInkTurnInteractionRecord>[];
  readonly finalAnswer?: ChatMessage;
  readonly finalAnswerIndex?: number;
  readonly anchorIndex: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly durationMs: number;
  readonly completedSteps: number;
  readonly toolCount: number;
  readonly currentNodeId?: string;
  readonly failed: boolean;
  readonly requiresAttention: boolean;
}

/** Legacy completed-turn shape retained for callers that only need closeout data. */
export interface CompletedAgentTurn {
  key: string;
  runId: string;
  finalAnswer: ChatMessage;
  processMessages: ChatMessage[];
  processIndices: number[];
  processStartIndex: number;
  finalAnswerIndex: number;
  durationMs: number;
  failed: boolean;
  requiresAttention: boolean;
}

export type AgentTurnProjectionItem =
  | { kind: "message"; index: number; message: ChatMessage }
  | { kind: "assistantTurn"; index: number; turn: AgentTurnView }
  /** Kept in the public union for source compatibility; no longer emitted. */
  | { kind: "completedProcess"; index: number; turn: CompletedAgentTurn };

export function isAgentProcessItemType(itemType?: string): boolean {
  return itemType === "generationProgress" ||
    itemType === "thinking" ||
    itemType === "reasoning" ||
    itemType === "commandExecution" ||
    itemType === "fileChange" ||
    itemType === "mcpToolCall" ||
    itemType === "dynamicToolCall" ||
    itemType === "collabAgentToolCall" ||
    itemType === "interactionRecord" ||
    itemType === "plan" ||
    itemType === "contextCompaction";
}

export function isAgentAnswerMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if (
    message.itemType === "knowledgeBase"
    || message.itemType === "taskPlan"
  ) return false;
  return !isAgentProcessItemType(message.itemType);
}

export function isAgentTurnTerminalMessage(message: ChatMessage): boolean {
  if (isAgentAnswerMessage(message)) return true;
  return message.role === "system"
    && message.itemType === "error"
    && (!message.status || FAILED_STATUSES.has(message.status));
}

export function buildAgentTurns(
  messages: ChatMessage[],
  language: SettingsLanguage = "zh-CN"
): AgentTurnView[] {
  const copy = conversationCopy(language);
  const indicesByKey = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (!isAssistantTurnMember(message)) return;
    const key = agentTurnKey(message);
    if (!key) return;
    const indices = indicesByKey.get(key) ?? [];
    indices.push(index);
    indicesByKey.set(key, indices);
  });

  const turns: AgentTurnView[] = [];
  for (const [key, indices] of indicesByKey) {
    const firstIndex = indices[0];
    const lastIndex = indices[indices.length - 1];
    if (hasForeignTurnBetween(messages, firstIndex, lastIndex, key)) continue;
    turns.push(buildAgentTurn(messages, indices, key, copy));
  }
  return turns.sort((left, right) => left.anchorIndex - right.anchorIndex);
}

export function buildCompletedAgentTurns(
  messages: ChatMessage[],
  language: SettingsLanguage = "zh-CN"
): CompletedAgentTurn[] {
  return buildAgentTurns(messages, language).flatMap((turn) => {
    if (!turn.finalAnswer || turn.finalAnswerIndex === undefined || !isTerminalTurnStatus(turn.status)) {
      return [];
    }
    return [{
      key: turn.key,
      runId: turn.runId,
      finalAnswer: turn.finalAnswer,
      processMessages: [...turn.processMessages],
      processIndices: [...turn.processIndices],
      processStartIndex: turn.processIndices[0] ?? turn.anchorIndex,
      finalAnswerIndex: turn.finalAnswerIndex,
      durationMs: turn.durationMs,
      failed: turn.failed,
      requiresAttention: turn.requiresAttention
    }];
  });
}

export function buildAgentTurnProjection(
  messages: ChatMessage[],
  language: SettingsLanguage = "zh-CN"
): AgentTurnProjectionItem[] {
  const turns = buildAgentTurns(messages, language);
  const turnByAnchor = new Map(turns.map((turn) => [turn.anchorIndex, turn]));
  const turnMessageIndices = new Set(turns.flatMap((turn) => [...turn.messageIndices]));
  const projection: AgentTurnProjectionItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const turn = turnByAnchor.get(index);
    if (turn) {
      projection.push({ kind: "assistantTurn", index, turn });
      continue;
    }
    if (turnMessageIndices.has(index)) continue;
    projection.push({ kind: "message", index, message: messages[index] });
  }
  return projection;
}

export function insertAgentProcessMessage(messages: ChatMessage[], message: ChatMessage): void {
  const key = agentTurnKey(message);
  const answerIndex = key ? lastMatchingAnswerIndex(messages, key) : -1;
  if (answerIndex >= 0) messages.splice(answerIndex, 0, message);
  else messages.push(message);
}

export function markAgentAnswerStreaming(message: ChatMessage): void {
  message.status = "running";
  delete message.completedAt;
}

export function settleAgentAnswer(
  messages: ChatMessage[],
  runId: string,
  status: "completed" | "failed" | "interrupted",
  completedAt: number
): ChatMessage | null {
  if (!runId) return null;
  const index = lastMatchingAnswerIndex(messages, `run:${runId}`);
  const message = index >= 0 ? messages[index] : null;
  if (!message) return null;
  message.status = status;
  message.completedAt = completedAt;
  return message;
}

export function formatAgentTurnDuration(
  durationMs: number,
  language: SettingsLanguage = "zh-CN"
): string {
  return conversationCopy(language).turn.processed(formatAgentTurnDurationValue(durationMs));
}

export function formatAgentTurnSummary(turn: Readonly<Pick<
  AgentTurnView,
  "status" | "completedSteps" | "toolCount" | "durationMs" | "currentNodeId" | "processNodes"
>>, language: SettingsLanguage = "zh-CN"): string {
  const copy = conversationCopy(language);
  if (!isTerminalTurnStatus(turn.status)) {
    if (turn.status === "waiting_for_user") return copy.turn.waitingForUser;
    const current = turn.currentNodeId
      ? turn.processNodes.find((node) => node.nodeId === turn.currentNodeId)
      : undefined;
    return copy.turn.processing(current?.title);
  }
  const prefix = copy.turn.terminalPrefix(turn.status);
  const parts = [copy.turn.stepCount(turn.completedSteps)];
  if (turn.toolCount > 0) parts.push(copy.turn.toolCount(turn.toolCount));
  parts.push(formatAgentTurnDurationValue(turn.durationMs));
  return `${prefix} · ${parts.join(" · ")}`;
}

export function isTerminalTurnStatus(status: EchoInkAssistantTurnStatus): boolean {
  return status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

function buildAgentTurn(
  allMessages: ChatMessage[],
  indices: number[],
  key: string,
  copy: ConversationCopy
): AgentTurnView {
  const messages = indices.map((index) => allMessages[index]);
  const explicitTurn = latestExplicitTurn(messages);
  const providerReasoningSegments = explicitTurn
    ? echoInkProviderReasoningSegments(explicitTurn)
    : [];
  const finalAnswerIndex = explicitFinalAnswerIndex(allMessages, indices, explicitTurn?.finalAnswerMessageId)
    ?? implicitFinalAnswerIndex(allMessages, indices);
  const finalAnswer = finalAnswerIndex === undefined ? undefined : allMessages[finalAnswerIndex];
  const processIndices = indices.filter((index) => index !== finalAnswerIndex);
  const processMessages = processIndices.map((index) => allMessages[index]);
  const startedAt = minimumTimestamp([
    explicitTurn?.startedAt,
    ...messages.map((message) => message.createdAt),
    ...providerReasoningSegments.map((segment) => segment.startedAt)
  ]);
  const updatedAt = maximumTimestamp([
    explicitTurn?.updatedAt,
    ...messages.flatMap((message) => [message.createdAt, message.completedAt]),
    ...providerReasoningSegments.map((segment) => segment.updatedAt)
  ], startedAt);
  const status = explicitTurn?.status ?? statusForMessages(messages, finalAnswer);
  const completedAt = isTerminalTurnStatus(status)
    ? maximumTimestamp([
        explicitTurn?.completedAt,
        ...messages.map((message) => message.completedAt),
        ...providerReasoningSegments.map((segment) => segment.completedAt),
        updatedAt
      ], updatedAt)
    : undefined;
  const processNodes = buildProcessNodes(messages, explicitTurn?.processNodes ?? [], copy);
  const currentNode = status === "waiting_for_user"
    ? undefined
    : processNodes.slice().reverse().find((node) => node.status === "running");
  const completedSteps = explicitTurn?.summary?.completedSteps
    ?? processNodes.filter((node) => node.status === "completed" || node.status === "skipped").length;
  const toolCount = explicitTurn?.summary?.toolCount ?? countTools(messages, processNodes);
  const durationMs = explicitTurn?.summary?.durationMs
    ?? Math.max(0, (completedAt ?? updatedAt) - startedAt);
  const runId = messages.find((message) => message.runId)?.runId ?? "";
  const turnId = explicitTurn?.turnId
    ?? messages.find((message) => message.turnId)?.turnId
    ?? runId;
  const requiresAttention = messages.some((message) =>
    ATTENTION_PROCESS_STATUSES.has(message.status ?? "")
  ) || processNodes.some((node) => node.status === "failed" || node.status === "cancelled");

  return {
    key,
    runId,
    turnId,
    status,
    messages,
    messageIndices: [...indices],
    processMessages,
    processIndices,
    processNodes,
    providerReasoningSegments,
    ...(providerReasoningSegments.at(-1)
      ? { providerReasoning: providerReasoningSegments.at(-1) }
      : {}),
    interactionRecords: mergeInteractionRecords(
      explicitTurn?.interactionRecords ?? [],
      messages.flatMap((message) =>
        message.interactionRecord ? [message.interactionRecord] : []
      )
    ),
    ...(finalAnswer ? { finalAnswer } : {}),
    ...(finalAnswerIndex === undefined ? {} : { finalAnswerIndex }),
    anchorIndex: indices[0],
    startedAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    durationMs,
    completedSteps,
    toolCount,
    ...(currentNode ? { currentNodeId: currentNode.nodeId } : {}),
    failed: status === "failed",
    requiresAttention
  };
}

function buildProcessNodes(
  messages: readonly ChatMessage[],
  explicitNodes: readonly Readonly<EchoInkTurnProcessNode>[],
  copy: ConversationCopy
): Readonly<EchoInkTurnProcessNode>[] {
  const explicitTurn = latestExplicitTurn(messages);
  const reasoningSegments = explicitTurn ? echoInkProviderReasoningSegments(explicitTurn) : [];
  const nodes: EchoInkTurnProcessNode[] = explicitNodes
    .filter((node) => !node.nodeId.startsWith("sources:"))
    .filter((node) => {
      if (node.kind !== "reasoning") return true;
      const segment = reasoningSegments.find((candidate) => node.nodeId === `provider-reasoning:${candidate.reasoningId}`);
      const source = messages.find((message) => message.id === node.sourceMessageId);
      const readableText = segment?.text ?? (source?.itemType === "reasoning" && !source.reasoningSummary ? source.text : "");
      return shouldDisplayReasoning(segment ?? node, readableText);
    })
    .map((node) => ({ ...node }));
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const representedMessageIds = new Set(nodes.flatMap((node) =>
    node.sourceMessageId ? [node.sourceMessageId] : []
  ));
  const representedToolActivityIds = new Set<string>();
  const responseHasStarted = messages.some((message) =>
    (isAgentAnswerMessage(message) && message.text.trim()) || isToolMessage(message))
    || (explicitTurn ? echoInkProviderReasoningSegments(explicitTurn).some((segment) => segment.text.trim()) : false);
  for (const node of explicitNodes) {
    if (node.toolCallId) {
      representedToolActivityIds.add(reasoningToolActivityId(node.toolCallId));
    }
  }
  for (const message of messages) {
    const toolCallId = toolCallIdForMessage(message);
    if (toolCallId) representedToolActivityIds.add(reasoningToolActivityId(toolCallId));
  }

  for (const message of messages) {
    if (message.reasoningSummary && !representedMessageIds.has(message.id)) {
      for (const activity of message.reasoningSummary.activities) {
        if (activity.kind === "provider" && activity.status === "active" && responseHasStarted) continue;
        if (
          activity.kind === "tool"
          && representedToolActivityIds.has(activity.id)
        ) continue;
        const node = nodeForReasoningActivity(message, activity, copy);
        if (!node) continue;
        if (!nodeIds.has(node.nodeId)) {
          nodes.push(node);
          nodeIds.add(node.nodeId);
        }
      }
    } else if (!representedMessageIds.has(message.id)
      && !(message.itemType === "thinking" && messages.some((candidate) =>
        candidate.reasoningSummary || isToolMessage(candidate)))) {
      const node = nodeForMessage(message, copy);
      if (node && !nodeIds.has(node.nodeId)) {
        nodes.push(node);
        nodeIds.add(node.nodeId);
      }
    }

    for (const node of knowledgeNodesForMessage(message, copy)) {
      if (!nodeIds.has(node.nodeId)) {
        nodes.push(node);
        nodeIds.add(node.nodeId);
      }
    }
  }

  for (const reasoning of explicitTurn
    ? echoInkProviderReasoningSegments(explicitTurn)
    : []) {
    if (!shouldDisplayReasoning(reasoning, reasoning.text)) continue;
    const nodeId = `provider-reasoning:${reasoning.reasoningId}`;
    if (!nodeIds.has(nodeId)) {
      nodes.push({
        nodeId,
        kind: "reasoning",
        status: providerReasoningNodeStatus(reasoning.status),
        title: copy.process.reasoningTitle,
        summary: reasoning.status === "running"
          ? copy.process.providerReasoningRunning
          : reasoning.durationMs === undefined
            ? copy.process.providerReasoningEnded
            : copy.process.providerReasoningDuration(formatAgentTurnDurationValue(reasoning.durationMs)),
        startedAt: reasoning.startedAt,
        updatedAt: reasoning.updatedAt,
        ...(reasoning.completedAt === undefined ? {} : { completedAt: reasoning.completedAt })
      });
      nodeIds.add(nodeId);
    }
  }

  for (const record of explicitTurn?.interactionRecords ?? []) {
    const nodeId = `interaction:${record.interactionId}`;
    if (nodeIds.has(nodeId)) continue;
    nodes.push({
      nodeId,
      kind: "interaction",
      status: record.outcome === "failed"
        ? "failed"
        : record.outcome === "cancelled" || record.outcome === "denied" || record.outcome === "expired"
          ? "cancelled"
          : "completed",
      title: record.kind === "question"
        ? copy.process.questionAnswered
        : copy.process.interactionOutcome(record.outcome),
      summary: record.summary,
      startedAt: record.updatedAt,
      updatedAt: record.updatedAt,
      completedAt: record.updatedAt,
      interactionId: record.interactionId
    });
    nodeIds.add(nodeId);
  }

  // The projector has already reduced Provider failures to safe user-facing copy.
  // Reuse that same-turn result rather than exposing raw transport errors here.
  const providerFailure = [...messages].reverse().find(message =>
    message.role === "assistant" && message.itemType === "error" && message.status === "failed");
  const providerFailureText = providerFailure?.details?.trim() || providerFailure?.text.trim();
  return nodes
    .map((node, index) => ({
      node: node.status === "failed" && node.title === copy.process.activityTitle("provider") && providerFailureText
        ? { ...node, summary: providerFailureText }
        : node,
      index
    }))
    .sort((left, right) =>
      left.node.startedAt - right.node.startedAt
      || left.node.updatedAt - right.node.updatedAt
      || left.index - right.index
    )
    .map(({ node }) => Object.freeze({ ...node }));
}

function nodeForMessage(
  message: ChatMessage,
  copy: ConversationCopy
): EchoInkTurnProcessNode | null {
  const kind = nodeKindForMessage(message);
  if (!kind) return null;
  const toolCallId = toolCallIdForMessage(message);
  const status = processNodeStatus(message.status);
  const updatedAt = finiteTimestamp(message.completedAt) ?? finiteTimestamp(message.createdAt) ?? 0;
  return {
    nodeId: message.interactionRecord
      ? `interaction:${message.interactionRecord.interactionId}`
      : `message:${message.id}`,
    kind,
    status,
    title: processNodeTitle(message, kind, copy),
    ...(message.details?.trim() ? { summary: message.details.trim() } : {}),
    startedAt: finiteTimestamp(message.createdAt) ?? updatedAt,
    updatedAt,
    ...(status === "running" || status === "waiting" ? {} : { completedAt: updatedAt }),
    sourceMessageId: message.id,
    ...(toolCallId ? { toolCallId } : {}),
    ...(message.taskPlan?.planId ? { taskPlanId: message.taskPlan.planId } : {}),
    ...(message.interactionRecord
      ? { interactionId: message.interactionRecord.interactionId }
      : {})
  };
}

function knowledgeNodesForMessage(
  message: ChatMessage,
  copy: ConversationCopy
): EchoInkTurnProcessNode[] {
  const usage = knowledgeUsageMessageData(message);
  const nodes: EchoInkTurnProcessNode[] = [];
  if (usage.producedPaths.length) {
    nodes.push({
      nodeId: `artifacts:${message.id}`,
      kind: "artifact",
      status: processNodeStatus(message.status),
      title: copy.process.artifactsTitle,
      summary: copy.process.fileCount(usage.producedPaths.length),
      startedAt: finiteTimestamp(message.createdAt) ?? 0,
      updatedAt: finiteTimestamp(message.completedAt) ?? finiteTimestamp(message.createdAt) ?? 0,
      sourceMessageId: message.id
    });
  }
  return nodes;
}

function nodeForReasoningActivity(
  message: ChatMessage,
  activity: Readonly<EchoInkReasoningActivity>,
  copy: ConversationCopy
): EchoInkTurnProcessNode | null {
  const elapsed = Math.max(0, activity.updatedAt - activity.startedAt);
  if (activity.kind === "provider"
    && (activity.status === "completed" || (activity.status === "active" && elapsed <= 5_000))) return null;
  if (activity.kind === "memory" && activity.status === "completed"
    && !(activity.completed ?? activity.current ?? 0)) return null;
  const kind = reasoningActivityNodeKind(activity.kind);
  const summary = reasoningActivitySummary(activity, copy);
  return {
    nodeId: `process-activity:${message.id}:${activity.id}`,
    kind,
    status: reasoningActivityNodeStatus(activity.status),
    title: reasoningActivityTitle(activity, copy),
    ...(summary ? { summary } : {}),
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
    ...(activity.status === "active" ? {} : { completedAt: activity.updatedAt }),
    sourceMessageId: message.id
  };
}

function nodeKindForMessage(message: ChatMessage): EchoInkTurnProcessNodeKind | null {
  if (message.itemType === "generationProgress") return message.processKind === "view" ? "retrieval" : "process";
  if (message.interactionRecord || message.itemType === "interactionRecord") return "interaction";
  if (message.taskPlan || message.itemType === "taskPlan" || message.itemType === "plan") return "task";
  if (message.itemType === "fileChange") return "diff";
  if (message.itemType === "knowledgeBase") return "artifact";
  if (message.processKind === "search" || message.processKind === "view") return "retrieval";
  if (
    message.role === "tool"
    || message.itemType === "commandExecution"
    || message.itemType === "mcpToolCall"
    || message.itemType === "dynamicToolCall"
    || message.itemType === "collabAgentToolCall"
  ) return "tool";
  if (message.itemType === "thinking" || message.itemType === "reasoning" || message.itemType === "contextCompaction") {
    return "process";
  }
  return null;
}

function processNodeTitle(
  message: ChatMessage,
  kind: EchoInkTurnProcessNodeKind,
  copy: ConversationCopy
): string {
  if (message.taskPlan) return message.taskPlan.title;
  if (message.reasoningSummary) return copy.message.thinking;
  if (message.interactionRecord) {
    return message.interactionRecord.kind === "question"
      ? copy.process.questionAnswered
      : copy.process.interactionOutcome(message.interactionRecord.outcome);
  }
  return copy.process.fallbackTitle(kind);
}

function mergeInteractionRecords(
  left: readonly Readonly<EchoInkTurnInteractionRecord>[],
  right: readonly Readonly<EchoInkTurnInteractionRecord>[]
): readonly Readonly<EchoInkTurnInteractionRecord>[] {
  const records = new Map<string, Readonly<EchoInkTurnInteractionRecord>>();
  for (const record of [...left, ...right]) {
    const previous = records.get(record.interactionId);
    if (!previous || previous.updatedAt <= record.updatedAt) {
      records.set(record.interactionId, record);
    }
  }
  return Object.freeze([...records.values()].sort((a, b) =>
    a.updatedAt - b.updatedAt
  ));
}

function statusForMessages(
  messages: readonly ChatMessage[],
  finalAnswer: ChatMessage | undefined
): EchoInkAssistantTurnStatus {
  const statuses = messages
    .filter((message) => !isSupersededEmptyAnswer(message, finalAnswer))
    .map((message) => message.status ?? "");
  if (statuses.some((status) => WAITING_USER_STATUSES.has(status))) return "waiting_for_user";
  if (statuses.some((status) => ACTIVE_STATUSES.has(status))) return "running";
  if (statuses.some((status) => FAILED_STATUSES.has(status))) return "failed";
  if (statuses.some((status) => CANCELLED_STATUSES.has(status))) return "cancelled";
  if (statuses.some((status) => INTERRUPTED_STATUSES.has(status))) return "interrupted";
  if (finalAnswer || messages.some(isAgentTurnTerminalMessage)) return "completed";
  return "preparing";
}

function isSupersededEmptyAnswer(
  message: ChatMessage,
  finalAnswer: ChatMessage | undefined
): boolean {
  if (!finalAnswer || message === finalAnswer || !isAgentAnswerMessage(message)) return false;
  return ACTIVE_STATUSES.has(message.status ?? "")
    && !(message.text || message.previewText || "").trim();
}

function processNodeStatus(status: string | undefined): EchoInkTurnProcessNodeStatus {
  if (WAITING_USER_STATUSES.has(status ?? "")) return "waiting";
  if (ACTIVE_STATUSES.has(status ?? "")) return "running";
  if (FAILED_STATUSES.has(status ?? "")) return "failed";
  if (CANCELLED_STATUSES.has(status ?? "") || INTERRUPTED_STATUSES.has(status ?? "")) return "cancelled";
  if (status === "pending") return "waiting";
  return "completed";
}

function providerReasoningNodeStatus(
  status: EchoInkProviderReasoningSnapshot["status"]
): EchoInkTurnProcessNodeStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  return "completed";
}

function reasoningActivityNodeKind(
  kind: EchoInkReasoningActivity["kind"]
): EchoInkTurnProcessNodeKind {
  if (kind === "knowledge" || kind === "memory") return "retrieval";
  if (kind === "task") return "task";
  if (kind === "tool") return "tool";
  // Legacy provider lifecycle telemetry is Process, never public Reasoning.
  return "process";
}

function reasoningActivityNodeStatus(
  status: EchoInkReasoningActivity["status"]
): EchoInkTurnProcessNodeStatus {
  if (status === "active") return "running";
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  return "completed";
}

function reasoningActivityTitle(
  activity: Readonly<EchoInkReasoningActivity>,
  copy: ConversationCopy
): string {
  return copy.process.activityTitle(activity.kind, activity.name);
}

function reasoningActivitySummary(
  activity: Readonly<EchoInkReasoningActivity>,
  copy: ConversationCopy
): string {
  if (activity.kind === "knowledge") {
    if (activity.status === "active") return copy.process.searching;
    if (activity.total === undefined) return activity.completed === undefined && activity.current === undefined
      ? copy.process.activityStage("completed") : copy.process.activityCompleted(activity.completed ?? activity.current ?? 0);
    return copy.process.knowledgeResult(activity.total ?? 0, activity.completed ?? activity.current ?? 0);
  }
  if (activity.kind === "memory") {
    if (activity.status === "active") return copy.process.memoryChecking;
    return copy.process.memoryUsed(activity.completed ?? activity.current ?? 0);
  }
  if (activity.kind === "provider" && activity.status === "active") {
    return copy.process.waitingSeconds(Math.floor((activity.updatedAt - activity.startedAt) / 1000));
  }
  const count = typeof activity.current === "number" && typeof activity.total === "number"
    ? `${activity.current}/${activity.total}`
    : typeof activity.completed === "number"
      ? copy.process.activityCompleted(activity.completed)
      : "";
  const stage = activity.stage ? copy.process.activityStage(activity.stage) : "";
  return [stage, count].filter(Boolean).join(" · ");
}

function countTools(
  messages: readonly ChatMessage[],
  nodes: readonly Readonly<EchoInkTurnProcessNode>[]
): number {
  const toolMessages = messages.filter(isToolMessage);
  const messageIds = new Set(toolMessages.map((message) => message.id));
  const toolIds = new Set(toolMessages.map((message) => {
    const toolCallId = toolCallIdForMessage(message);
    return toolCallId ? `tool:${toolCallId}` : `message:${message.id}`;
  }));
  for (const node of nodes) {
    if (node.kind !== "tool" && node.kind !== "diff") continue;
    if (node.sourceMessageId && messageIds.has(node.sourceMessageId)) continue;
    toolIds.add(node.toolCallId ? `tool:${node.toolCallId}` : `node:${node.nodeId}`);
  }
  return toolIds.size;
}

function toolCallIdForMessage(message: ChatMessage): string | undefined {
  if (!isToolMessage(message)) return undefined;
  return piToolCallIdFromProjectedMessageId(message.id);
}

function reasoningToolActivityId(toolCallId: string): string {
  return stableHashedIdentity("reasoning-tool", toolCallId);
}

function isToolMessage(message: ChatMessage): boolean {
  return message.role === "tool"
    || message.itemType === "commandExecution"
    || message.itemType === "fileChange"
    || message.itemType === "mcpToolCall"
    || message.itemType === "dynamicToolCall"
    || message.itemType === "collabAgentToolCall";
}

function latestExplicitTurn(messages: readonly ChatMessage[]) {
  return messages
    .flatMap((message) => message.assistantTurn ? [message.assistantTurn] : [])
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function explicitFinalAnswerIndex(
  messages: readonly ChatMessage[],
  indices: readonly number[],
  messageId: string | undefined
): number | undefined {
  if (!messageId) return undefined;
  return indices.find((index) => messages[index].id === messageId);
}

function implicitFinalAnswerIndex(
  messages: readonly ChatMessage[],
  indices: readonly number[]
): number | undefined {
  const answerIndices = indices.filter((index) => isAgentAnswerMessage(messages[index]));
  const meaningful = answerIndices.slice().reverse().find((index) => {
    const message = messages[index];
    return Boolean((message.text || message.previewText || "").trim())
      || !ACTIVE_STATUSES.has(message.status ?? "");
  });
  return meaningful ?? answerIndices[answerIndices.length - 1];
}

function isAssistantTurnMember(message: ChatMessage): boolean {
  if (message.role === "user") return false;
  return Boolean(agentTurnKey(message));
}

function agentTurnKey(message: ChatMessage): string {
  if (message.runId) return `run:${message.runId}`;
  if (message.turnId) return `turn:${message.turnId}`;
  return "";
}

function lastMatchingAnswerIndex(messages: ChatMessage[], key: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (agentTurnKey(messages[index]) === key && isAgentAnswerMessage(messages[index])) return index;
  }
  return -1;
}

function hasForeignTurnBetween(
  messages: ChatMessage[],
  startIndex: number,
  endIndex: number,
  key: string
): boolean {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const message = messages[index];
    if (message.role === "user") return true;
    const candidate = agentTurnKey(message);
    if (candidate && candidate !== key && isAssistantTurnMember(message)) return true;
    if (!candidate && message.role === "assistant" && isAgentTurnTerminalMessage(message)) return true;
  }
  return false;
}

function formatAgentTurnDurationValue(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function minimumTimestamp(values: readonly unknown[]): number {
  const timestamps = values.map(finiteTimestamp).filter((value): value is number => value !== undefined);
  return timestamps.length ? Math.min(...timestamps) : 0;
}

function maximumTimestamp(values: readonly unknown[], fallback: number): number {
  const timestamps = values.map(finiteTimestamp).filter((value): value is number => value !== undefined);
  return timestamps.length ? Math.max(...timestamps) : fallback;
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
