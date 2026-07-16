import { buildDiffSummary, serializeFileChanges, type RawFileChange } from "../../core/diff-summary";
import { extractProcessFileRefs, normalizeProcessFileRef, summarizeProcessEvent } from "../../core/mapping";
import {
  normalizeHarnessRunUsage,
  type HarnessRunUsage,
  type HarnessContentAvailability,
  type HarnessEvent,
  type HarnessProcessEventData,
  type HarnessToolSemanticKind,
  type HarnessToolStatus
} from "../../harness/contracts/event";
import type { ChatMessage, DiffFileSummary, DiffSummary } from "../../settings/settings";
import type { ProcessEventKind, ProcessFileRef } from "../../types/app-server";

export interface HarnessEventProjectorInput {
  runId: string;
  backendId: string;
  vaultPath: string;
  answerMessage: ChatMessage;
}

export interface HarnessProjectionBatch {
  acceptedSequences: number[];
  updates: ChatMessage[];
  /** Stable UI row order for this run, including interleaved answer rows. */
  orderedMessageIds?: string[];
}

export interface HarnessProjectionSettlement {
  status: "completed" | "failed" | "cancelled";
  text?: string;
  error?: string;
  createdAt?: number;
}

interface ToolProjectionState {
  callId: string;
  message: ChatMessage;
  inputText: string;
  outputText: string;
  diffText: string;
  preview: string;
  inputState?: HarnessContentAvailability;
  outputState?: HarnessContentAvailability;
  files?: ChatMessage["files"];
  diffSummary?: DiffSummary;
}

const ACTIVE_PROCESS_STATUSES = new Set(["requested", "running", "approval", "blocked", "in_progress", "inProgress"]);
const EMPTY_DISPLAY_VALUES = new Set(["{}", "[]", "null", "undefined", "unavailable", "(unavailable)", "n/a"]);

/**
 * Projects backend-neutral Harness events into the single EchoInk ChatMessage UI model.
 * Provider-specific decoding belongs in adapters; this class only consumes normalized
 * message/block/call identities and semantic process fields.
 */
export class HarnessEventProjector {
  private readonly answer: ChatMessage;
  private readonly answerTemplate: ChatMessage;
  private readonly processById = new Map<string, ChatMessage>();
  private readonly answerSegments = new Map<string, ChatMessage>();
  private readonly rowOrder: string[] = [];
  private readonly tools = new Map<string, ToolProjectionState>();
  private readonly pending = new Map<number, HarnessEvent>();
  private readonly seenEventIds = new Set<string>();
  private readonly reasoningSegmentCounts = new Map<string, number>();
  private readonly answerSegmentCounts = new Map<string, number>();
  private nextSequence = 1;
  private fallbackReasoningIndex = 0;
  private fallbackToolIndex = 0;
  private fallbackMessageIndex = 0;
  private activeReasoningBlockId = "";
  private activeReasoningProviderBlockId = "";
  private activeMessageSegmentId = "";
  private activeProviderMessageId = "";
  private canonicalMessageSegmentId = "";
  private terminalStatus: HarnessProjectionSettlement["status"] | "" = "";
  private latestRunUsage?: HarnessRunUsage;

  constructor(private readonly input: HarnessEventProjectorInput) {
    this.answer = cloneMessage(input.answerMessage);
    this.answerTemplate = cloneMessage(input.answerMessage);
  }

  project(event: HarnessEvent): HarnessProjectionBatch {
    if (event.runId !== this.input.runId || !Number.isInteger(event.sequence) || event.sequence < this.nextSequence) {
      return emptyBatch();
    }
    if (!this.pending.has(event.sequence)) this.pending.set(event.sequence, event);

    const acceptedSequences: number[] = [];
    const changed = new Map<string, ChatMessage>();
    while (this.pending.has(this.nextSequence)) {
      const current = this.pending.get(this.nextSequence)!;
      this.pending.delete(this.nextSequence);
      acceptedSequences.push(current.sequence);
      const eventId = stringValue(current.eventId);
      if (!eventId || !this.seenEventIds.has(eventId)) {
        if (eventId) this.seenEventIds.add(eventId);
        this.processEvent(current, (message) => changed.set(message.id, message));
      }
      this.nextSequence += 1;
    }
    return {
      acceptedSequences,
      updates: Array.from(changed.values(), cloneMessage),
      orderedMessageIds: this.orderedMessageIds()
    };
  }

  settle(settlement: HarnessProjectionSettlement): HarnessProjectionBatch {
    const changed = new Map<string, ChatMessage>();
    this.settleRun(settlement, (message) => changed.set(message.id, message));
    return {
      acceptedSequences: [],
      updates: Array.from(changed.values(), cloneMessage),
      orderedMessageIds: this.orderedMessageIds()
    };
  }

  snapshot(): ChatMessage[] {
    return this.orderedMessageIds()
      .map((id) => this.messageById(id))
      .filter((message): message is ChatMessage => Boolean(message))
      .map(cloneMessage);
  }

  private processEvent(event: HarnessEvent, markChanged: (message: ChatMessage) => void): void {
    if (event.type === "usage.updated") {
      const usage = normalizeHarnessRunUsage(event.data?.usage ?? event.data);
      if (usage) {
        this.latestRunUsage = { ...usage };
        if (this.terminalStatus) {
          this.answer.runUsage = { ...usage };
          markChanged(this.answer);
        }
      }
      return;
    }
    if (isReasoningEvent(event.type)) {
      this.closeActiveAnswer("completed", event.createdAt, markChanged);
      this.projectReasoning(event, markChanged);
      return;
    }
    if (event.type === "agent.message.delta" || event.type === "agent.message.completed") {
      this.closeActiveReasoning("completed", event.createdAt, markChanged);
      this.projectAnswer(event, markChanged);
      return;
    }
    if (event.type === "agent.plan.updated") {
      this.closeActiveAnswer("completed", event.createdAt, markChanged);
      this.closeActiveReasoning("completed", event.createdAt, markChanged);
      this.projectPlan(event, markChanged);
      return;
    }
    if (isToolEvent(event.type)) {
      if (endsReasoningAtToolBoundary(event)) {
        this.closeActiveAnswer("completed", event.createdAt, markChanged);
        this.closeActiveReasoning("completed", event.createdAt, markChanged);
      }
      this.projectTool(event, markChanged);
      return;
    }
    if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") {
      this.settleRun({
        status: event.type === "run.completed" ? "completed" : event.type === "run.cancelled" ? "cancelled" : "failed",
        text: event.text,
        error: event.error,
        createdAt: event.createdAt
      }, markChanged);
    }
  }

  private projectReasoning(event: HarnessEvent, markChanged: (message: ChatMessage) => void): void {
    if (event.data?.visibility && event.data.visibility !== "public") return;
    const explicitBlockId = stringValue(event.data?.blockId);
    if (this.activeReasoningBlockId && explicitBlockId && explicitBlockId !== this.activeReasoningProviderBlockId) {
      this.closeActiveReasoning("completed", event.createdAt, markChanged);
    }
    if (!this.activeReasoningBlockId) {
      this.fallbackReasoningIndex += 1;
      const providerBlockId = explicitBlockId || `${this.input.runId}:reasoning:${this.fallbackReasoningIndex}`;
      this.activeReasoningProviderBlockId = providerBlockId;
      this.activeReasoningBlockId = nextSegmentId(providerBlockId, this.reasoningSegmentCounts);
    }

    const blockId = this.activeReasoningBlockId;
    const messageId = processMessageId(this.input.runId, "reasoning", blockId);
    const completed = event.type === "agent.reasoning.summary.completed" || event.type === "agent.thinking.completed";
    const visibleText = visibleString(event.text);
    let message = this.processById.get(messageId);
    if (!message && visibleText) {
      message = this.addProcessMessage({
        id: messageId,
        role: "assistant",
        itemType: "reasoning",
        processKind: "reasoning",
        title: "推理过程",
        text: "",
        status: "running",
        createdAt: eventTime(event, this.answer.createdAt),
        ...this.sharedMessageFields()
      });
    }
    if (message) {
      if (visibleText) {
        message.text = completed || event.data?.replace === true
          ? visibleText
          : `${message.text}${visibleText}`;
      }
      message.status = completed ? "completed" : "running";
      if (completed) message.completedAt = eventTime(event, Date.now());
      markChanged(message);
    }
    if (completed) {
      this.activeReasoningBlockId = "";
      this.activeReasoningProviderBlockId = "";
    }
  }

  private projectAnswer(event: HarnessEvent, markChanged: (message: ChatMessage) => void): void {
    const explicitMessageId = stringValue(event.data?.messageId);
    if (this.activeMessageSegmentId && explicitMessageId && explicitMessageId !== this.activeProviderMessageId) {
      this.closeActiveAnswer("completed", event.createdAt, markChanged);
    }
    if (!this.activeMessageSegmentId) {
      this.fallbackMessageIndex += 1;
      const providerMessageId = explicitMessageId || `${this.input.runId}:message:${this.fallbackMessageIndex}`;
      const segmentId = nextSegmentId(providerMessageId, this.answerSegmentCounts);
      this.startAnswerSegment(segmentId, providerMessageId, event, markChanged);
    }
    const message = this.messageForAnswerSegment(this.activeMessageSegmentId);
    if (!message) return;
    const text = visibleString(event.text);
    if (text) {
      message.text = event.type === "agent.message.completed" || event.data?.replace === true
        ? text
        : `${message.text}${text}`;
    }
    message.status = "running";
    message.itemType = "assistant";
    if (event.type === "agent.message.completed") {
      delete message.completedAt;
      this.activeMessageSegmentId = "";
      this.activeProviderMessageId = "";
    } else {
      delete message.completedAt;
    }
    markChanged(message);
  }

  private projectPlan(event: HarnessEvent, markChanged: (message: ChatMessage) => void): void {
    const text = visibleString(event.text);
    if (!text) return;
    const data = event.data ?? {};
    const planId = stringValue(data.blockId ?? data.planId ?? data.id) || "plan";
    const messageId = processMessageId(this.input.runId, "plan", planId);
    let message = this.processById.get(messageId);
    if (!message) {
      message = this.addProcessMessage({
        id: messageId,
        role: "assistant",
        itemType: "plan",
        processKind: "plan",
        title: event.title || "更新计划",
        text,
        status: normalizedProcessStatus(event.status, "completed"),
        createdAt: eventTime(event, this.answer.createdAt),
        ...this.sharedMessageFields()
      });
    } else {
      message.text = text;
      message.title = event.title || message.title;
      message.status = normalizedProcessStatus(event.status, "completed");
    }
    markChanged(message);
  }

  private projectTool(event: HarnessEvent, markChanged: (message: ChatMessage) => void): void {
    const data = event.data ?? {};
    const callId = this.resolveToolCallId(event);
    const semanticKind = normalizedSemanticKind(data.semanticKind, event.toolName, event.type);
    let state = this.tools.get(callId);
    if (!state) {
      const message = this.addProcessMessage(this.createToolMessage(event, callId, semanticKind));
      state = { callId, message, inputText: "", outputText: "", diffText: "", preview: "" };
      this.tools.set(callId, state);
    }

    const input = channelText(data.inputState, data.input);
    const output = channelText(data.outputState, data.output);
    const preview = visibleString(data.displayPreview);
    const nextInputState = data.inputState ?? (hasOwn(data, "input") ? (input ? "provided" : "empty") : undefined);
    const nextOutputState = data.outputState ?? (hasOwn(data, "output") ? (output ? "provided" : "empty") : undefined);
    const preserveInput = shouldPreserveProvidedChannel(state.inputState, state.inputText, nextInputState);
    const preserveOutput = shouldPreserveProvidedChannel(state.outputState, state.outputText, nextOutputState);
    if (!preserveInput) {
      if (nextInputState) state.inputState = nextInputState;
      if (nextInputState === "empty") state.inputText = "";
      else if (input) state.inputText = input;
    }
    if (!preserveOutput) {
      if (nextOutputState) state.outputState = nextOutputState;
      if (nextOutputState === "empty") state.outputText = "";
      else if (output) state.outputText = output;
    }
    if (preview) state.preview = preview;

    const eventText = visibleString(event.text);
    const eventError = visibleString(event.error);
    if (event.type === "tool.output.delta" && !output && eventText) {
      state.outputText = `${state.outputText}${eventText}`;
    } else if ((event.type === "tool.completed" || event.type === "tool.failed" || event.type === "file.change.applied" || event.type === "file.change.reverted") && !output && eventText) {
      state.outputText = eventText;
    } else if ((event.type === "tool.failed" || event.type === "file.change.reverted") && !output && eventError) {
      state.outputState = "provided";
      state.outputText = eventError;
    } else if (startsToolBoundary(event.type) && !state.preview && eventText) {
      state.preview = eventText;
    }

    const message = state.message;
    const currentSemanticKind = normalizedSemanticKind(data.semanticKind, event.toolName, event.type);
    const viewKind = toolViewKind(currentSemanticKind);
    const payload = normalizedToolPayload(event, state.inputText, state.outputText, state.preview);
    const summary = summarizeProcessEvent(viewKind.itemType, payload, this.input.vaultPath);
    const diff = toolDiffSummary(event);
    const serializedDiff = diff?.changes.some((change) => visibleString(change.diff))
      ? serializeFileChanges(diff.changes)
      : "";
    const files = mergeProcessFileRefs(
      structuredToolFileRefs(event, this.input.vaultPath),
      state.files ?? [],
      extractProcessFileRefs(payload, this.input.vaultPath)
    );
    if (files.length) state.files = files;
    if (diff) state.diffSummary = diff.summary;
    if (serializedDiff) state.diffText = serializedDiff;
    message.role = viewKind.itemType === "plan" ? "assistant" : "tool";
    message.itemType = viewKind.itemType;
    message.processKind = projectedToolProcessKind(currentSemanticKind, viewKind.processKind, summary.kind);
    message.title = event.title || event.toolName || summary.title || "工具";
    message.details = state.preview || meaningfulSummaryDetail(summary.detail);
    message.text = state.outputText || state.diffText || state.inputText || "";
    message.status = toolMessageStatus(event, data.toolStatus);
    message.files = state.files;
    message.diffSummary = state.diffSummary;
    message.processInputAvailability = normalizedChannelAvailability(state.inputState, state.inputText);
    message.processOutputAvailability = state.diffText
      ? "provided"
      : normalizedChannelAvailability(state.outputState, state.outputText);
    message.processInput = message.processInputAvailability === "provided" ? state.inputText : undefined;
    message.processOutput = message.processOutputAvailability === "provided"
      ? state.outputText || state.diffText
      : undefined;
    message.processContentAvailability = toolContentAvailability(state, message);
    if (message.status === "completed" || message.status === "failed" || message.status === "interrupted") {
      message.completedAt = eventTime(event, Date.now());
    }
    markChanged(message);
  }

  private createToolMessage(event: HarnessEvent, callId: string, semanticKind: HarnessToolSemanticKind): ChatMessage {
    const viewKind = toolViewKind(semanticKind);
    return {
      id: processMessageId(this.input.runId, "tool", callId),
      role: viewKind.itemType === "plan" ? "assistant" : "tool",
      itemType: viewKind.itemType,
      processKind: viewKind.processKind,
      title: event.title || event.toolName || "工具",
      text: "",
      status: toolMessageStatus(event, event.data?.toolStatus),
      createdAt: eventTime(event, this.answer.createdAt),
      ...this.sharedMessageFields()
    };
  }

  private resolveToolCallId(event: HarnessEvent): string {
    const explicit = stringValue(event.data?.callId ?? event.data?.toolCallId);
    if (explicit) return explicit;
    this.fallbackToolIndex += 1;
    return `${this.input.runId}:tool:${this.fallbackToolIndex}`;
  }

  private settleRun(settlement: HarnessProjectionSettlement, markChanged: (message: ChatMessage) => void): void {
    const createdAt = settlement.createdAt ?? Date.now();
    const processStatus = settlement.status === "completed" ? "completed" : "interrupted";
    this.closeActiveReasoning(processStatus, createdAt, markChanged);
    const toolMessages = new Set(Array.from(this.tools.values(), (tool) => tool.message));
    for (const message of this.processById.values()) {
      if (!ACTIVE_PROCESS_STATUSES.has(message.status ?? "")) continue;
      if (toolMessages.has(message)) {
        message.status = settlement.status === "completed" ? "unconfirmed" : "interrupted";
      } else {
        message.status = processStatus;
      }
      message.completedAt = createdAt;
      markChanged(message);
    }

    const answerRepositioned = this.prepareTerminalFailureAnswer(settlement.status, createdAt, markChanged);
    const terminalText = visibleString(settlement.text);
    const terminalError = visibleString(settlement.error);
    const nextStatus = settlement.status === "completed" ? "completed" : settlement.status === "cancelled" ? "interrupted" : "failed";
    const nextItemType = settlement.status === "completed" ? "assistant" : "error";
    const projectedAnswerText = visibleString(this.answer.text);
    const nextText = settlement.status === "completed"
      ? (this.canonicalMessageSegmentId ? projectedAnswerText || terminalText : terminalText || projectedAnswerText) || emptySettlementText(settlement.status)
      : terminalError || terminalText || (!answerRepositioned ? projectedAnswerText : "") || emptySettlementText(settlement.status);
    const alreadySettled = this.terminalStatus === settlement.status
      && this.answer.status === nextStatus
      && this.answer.itemType === nextItemType
      && this.answer.text === nextText;
    this.terminalStatus = settlement.status;
    this.answer.status = nextStatus;
    this.answer.itemType = nextItemType;
    this.answer.text = nextText;
    this.answer.completedAt = createdAt;
    if (this.latestRunUsage) this.answer.runUsage = { ...this.latestRunUsage };
    if (!alreadySettled) markChanged(this.answer);
  }

  private prepareTerminalFailureAnswer(
    status: HarnessProjectionSettlement["status"],
    createdAt: number,
    markChanged: (message: ChatMessage) => void
  ): boolean {
    if (status === "completed" || this.terminalStatus) return false;
    const answerIndex = this.rowOrder.lastIndexOf(this.answer.id);
    if (answerIndex < 0 || !this.rowOrder.slice(answerIndex + 1).some((id) => this.processById.has(id))) return false;

    if (this.canonicalMessageSegmentId && hasVisibleText(this.answer.text)) {
      this.demoteCanonicalAnswer(createdAt, markChanged);
    } else {
      this.rowOrder.splice(answerIndex, 1);
    }

    resetAnswerMessage(this.answer, this.answerTemplate, createdAt);
    this.canonicalMessageSegmentId = terminalAnswerSegmentId(this.input.runId);
    this.activeMessageSegmentId = "";
    this.activeProviderMessageId = "";
    this.rowOrder.push(this.answer.id);
    return true;
  }

  private closeActiveReasoning(status: "completed" | "interrupted", createdAt: number, markChanged: (message: ChatMessage) => void): void {
    if (!this.activeReasoningBlockId) return;
    const message = this.processById.get(processMessageId(this.input.runId, "reasoning", this.activeReasoningBlockId));
    this.activeReasoningBlockId = "";
    this.activeReasoningProviderBlockId = "";
    if (!message) return;
    message.status = status;
    message.completedAt = createdAt || Date.now();
    markChanged(message);
  }

  private closeActiveAnswer(status: "completed" | "interrupted", createdAt: number, markChanged: (message: ChatMessage) => void): void {
    if (!this.activeMessageSegmentId) return;
    const message = this.messageForAnswerSegment(this.activeMessageSegmentId);
    this.activeMessageSegmentId = "";
    this.activeProviderMessageId = "";
    if (!message) return;
    message.status = status;
    message.completedAt = createdAt || Date.now();
    markChanged(message);
  }

  private startAnswerSegment(
    segmentId: string,
    providerMessageId: string,
    event: HarnessEvent,
    markChanged: (message: ChatMessage) => void
  ): void {
    if (this.canonicalMessageSegmentId) this.demoteCanonicalAnswer(eventTime(event, Date.now()), markChanged);
    resetAnswerMessage(this.answer, this.answerTemplate, eventTime(event, this.answerTemplate.createdAt));
    this.canonicalMessageSegmentId = segmentId;
    this.activeMessageSegmentId = segmentId;
    this.activeProviderMessageId = providerMessageId;
    this.rowOrder.push(this.answer.id);
  }

  private demoteCanonicalAnswer(completedAt: number, markChanged: (message: ChatMessage) => void): void {
    if (!this.canonicalMessageSegmentId) return;
    const historical = cloneMessage(this.answer);
    historical.id = answerSegmentMessageId(this.input.runId, this.canonicalMessageSegmentId);
    historical.status = "completed";
    historical.completedAt = completedAt;
    this.answerSegments.set(this.canonicalMessageSegmentId, historical);
    const canonicalIndex = this.rowOrder.lastIndexOf(this.answer.id);
    if (canonicalIndex >= 0) this.rowOrder[canonicalIndex] = historical.id;
    markChanged(historical);
  }

  private messageForAnswerSegment(segmentId: string): ChatMessage | undefined {
    return segmentId === this.canonicalMessageSegmentId ? this.answer : this.answerSegments.get(segmentId);
  }

  private addProcessMessage(message: ChatMessage): ChatMessage {
    this.processById.set(message.id, message);
    this.rowOrder.push(message.id);
    return message;
  }

  private orderedMessageIds(): string[] {
    return this.canonicalMessageSegmentId || this.rowOrder.includes(this.answer.id)
      ? [...this.rowOrder]
      : [...this.rowOrder, this.answer.id];
  }

  private messageById(id: string): ChatMessage | undefined {
    if (id === this.answer.id) return this.answer;
    return this.processById.get(id) ?? Array.from(this.answerSegments.values()).find((message) => message.id === id);
  }

  private sharedMessageFields(): Pick<ChatMessage, "backendId" | "modelId" | "profileId" | "runId"> {
    return {
      backendId: this.input.backendId,
      modelId: this.answer.modelId,
      profileId: this.answer.profileId,
      runId: this.input.runId
    };
  }
}

/** Applies projected messages without replacing existing ChatMessage object identities. */
export function applyHarnessProjectionBatch(
  messages: ChatMessage[],
  batch: HarnessProjectionBatch,
  answerMessageId: string
): ChatMessage[] {
  const applied: ChatMessage[] = [];
  for (const projected of batch.updates) {
    const existing = messages.find((message) => message.id === projected.id);
    if (existing) {
      clearMissingProjectedFields(existing, projected);
      Object.assign(existing, projected);
      applied.push(existing);
      continue;
    }
    const inserted = cloneMessage(projected);
    messages.push(inserted);
    applied.push(inserted);
  }
  reconcileProjectedMessageOrder(messages, batch.orderedMessageIds, answerMessageId);
  return applied;
}

function clearMissingProjectedFields(existing: ChatMessage, projected: ChatMessage): void {
  const optionalFields: Array<keyof ChatMessage> = [
    "completedAt",
    "details",
    "previewText",
    "rawRef",
    "rawSize",
    "rawLines",
    "rawTruncatedForPreview",
    "processInput",
    "processOutput",
    "processInputAvailability",
    "processOutputAvailability",
    "processContentAvailability",
    "runUsage"
  ];
  for (const field of optionalFields) {
    if (!hasOwn(projected, field)) delete existing[field];
  }
}

function reconcileProjectedMessageOrder(messages: ChatMessage[], orderedMessageIds: string[] | undefined, answerMessageId: string): void {
  if (!orderedMessageIds?.length) return;
  const ordered = new Set(orderedMessageIds);
  const indices = messages
    .map((message, index) => ordered.has(message.id) ? index : -1)
    .filter((index) => index >= 0);
  const fallbackIndex = messages.findIndex((message) => message.id === answerMessageId);
  const anchor = indices.length ? Math.min(...indices) : fallbackIndex >= 0 ? fallbackIndex : messages.length;
  const byId = new Map<string, ChatMessage>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!ordered.has(message.id)) continue;
    byId.set(message.id, message);
    messages.splice(index, 1);
  }
  const rows = orderedMessageIds.map((id) => byId.get(id)).filter((message): message is ChatMessage => Boolean(message));
  messages.splice(Math.min(anchor, messages.length), 0, ...rows);
}

function isReasoningEvent(type: HarnessEvent["type"]): boolean {
  return type === "agent.reasoning.started"
    || type === "agent.reasoning.summary.delta"
    || type === "agent.reasoning.summary.completed"
    || type === "agent.thinking.delta"
    || type === "agent.thinking.completed";
}

function isToolEvent(type: HarnessEvent["type"]): boolean {
  return type === "tool.requested"
    || type === "tool.started"
    || type === "tool.output.delta"
    || type === "tool.approval.requested"
    || type === "tool.approval.resolved"
    || type === "tool.completed"
    || type === "tool.failed"
    || type === "file.change.proposed"
    || type === "file.change.applied"
    || type === "file.change.reverted";
}

function startsToolBoundary(type: HarnessEvent["type"]): boolean {
  return type === "tool.requested"
    || type === "tool.started"
    || type === "tool.approval.requested"
    || type === "file.change.proposed";
}

function endsReasoningAtToolBoundary(event: HarnessEvent): boolean {
  if (startsToolBoundary(event.type)) return true;
  if (event.type === "tool.completed"
    || event.type === "tool.failed"
    || event.type === "file.change.applied"
    || event.type === "file.change.reverted") return true;
  const status = event.data?.toolStatus;
  return status === "completed" || status === "failed" || status === "denied" || status === "interrupted" || status === "unconfirmed";
}

function toolMessageStatus(event: HarnessEvent, normalized?: HarnessToolStatus): string {
  if (normalized === "requested" || normalized === "running") return "running";
  if (normalized === "approval") return "approval";
  if (normalized === "completed" || normalized === "unconfirmed") return normalized;
  if (normalized === "failed" || normalized === "denied") return "failed";
  if (normalized === "interrupted") return "interrupted";
  if (event.type === "tool.completed" || event.type === "file.change.applied") return "completed";
  if (event.type === "tool.failed" || event.type === "file.change.reverted") return "failed";
  if (event.type === "tool.approval.requested") return "approval";
  if (event.status === "failed" || event.status === "error" || event.error) return "failed";
  return "running";
}

function normalizedSemanticKind(
  value: HarnessToolSemanticKind | undefined,
  toolName: string | undefined,
  eventType: HarnessEvent["type"]
): HarnessToolSemanticKind {
  if (value) return value;
  if (eventType.startsWith("file.change.")) return "edit";
  const name = (toolName ?? "").trim().toLowerCase();
  if (/(^|[._\/-])(read|open|view|cat|fetch[_-]?file)([._\/-]|$)/.test(name)) return "read";
  if (/(^|[._\/-])(search|grep|find|glob|rg|lookup|list[_-]?files)([._\/-]|$)/.test(name)) return "search";
  if (/(^|[._\/-])(shell|bash|terminal|command|exec|execute|run)([._\/-]|$)/.test(name)) return "command";
  if (/(^|[._\/-])(edit|write|patch|apply[_-]?patch|replace|file[_-]?change)([._\/-]|$)/.test(name)) return "edit";
  if (/(^|[._\/-])(agent|spawn|delegate|subagent|task)([._\/-]|$)/.test(name)) return "agent";
  return "tool";
}

function toolViewKind(kind: HarnessToolSemanticKind): { itemType: string; processKind: ProcessEventKind } {
  switch (kind) {
    case "read":
      return { itemType: "dynamicToolCall", processKind: "view" };
    case "search":
      return { itemType: "dynamicToolCall", processKind: "search" };
    case "command":
      return { itemType: "commandExecution", processKind: "command" };
    case "edit":
      return { itemType: "fileChange", processKind: "edit" };
    case "mcp":
      return { itemType: "mcpToolCall", processKind: "tool" };
    case "agent":
      return { itemType: "collabAgentToolCall", processKind: "tool" };
    case "plan":
      return { itemType: "plan", processKind: "plan" };
    default:
      return { itemType: "dynamicToolCall", processKind: "tool" };
  }
}

function projectedToolProcessKind(
  semanticKind: HarnessToolSemanticKind,
  fallback: ProcessEventKind,
  summarized: ProcessEventKind
): ProcessEventKind {
  if (semanticKind === "command" && (summarized === "search" || summarized === "view" || summarized === "run")) {
    return summarized;
  }
  return fallback;
}

function normalizedToolPayload(event: HarnessEvent, input: string, output: string, preview: string): Record<string, unknown> {
  const data = event.data ?? {};
  const command = commandFromInput(data.input);
  return {
    tool: event.toolName,
    resourceId: event.resourceId,
    status: data.toolStatus ?? event.status,
    input: input || undefined,
    output: output || undefined,
    message: preview || undefined,
    command: command || undefined,
    files: data.files,
    locations: data.locations,
    changes: data.changes,
    diff: data.diff,
    diffSummary: data.diffSummary
  };
}

function structuredToolFileRefs(event: HarnessEvent, vaultPath: string): ProcessFileRef[] {
  const data = event.data ?? {};
  const candidates: string[] = [];
  collectFileCollectionPaths(data.files, candidates);
  collectFileCollectionPaths(data.locations, candidates);
  collectStructuredInputPaths(data.input, candidates);
  if (event.resourceId) candidates.push(event.resourceId);
  return mergeProcessFileRefs(candidates.map((candidate) => normalizeProcessFileRef(candidate, vaultPath)));
}

function collectFileCollectionPaths(value: unknown, candidates: string[]): void {
  if (typeof value === "string") {
    if (visibleString(value)) candidates.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFileCollectionPaths(entry, candidates);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const direct = visibleString(record.path ?? record.file ?? record.filePath ?? record.filename ?? record.uri);
  if (direct) candidates.push(direct);
}

function collectStructuredInputPaths(value: unknown, candidates: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectStructuredInputPaths(entry, candidates);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "file", "filePath", "filename", "uri"].includes(key) && typeof entry === "string") {
      const candidate = visibleString(entry);
      if (candidate) candidates.push(candidate);
      continue;
    }
    if (entry && typeof entry === "object") collectStructuredInputPaths(entry, candidates);
  }
}

function mergeProcessFileRefs(...groups: ProcessFileRef[][]): ProcessFileRef[] {
  const merged: ProcessFileRef[] = [];
  for (const ref of groups.flat()) {
    if (!ref.openable) continue;
    const duplicate = merged.find((candidate) => sameProcessFileRef(candidate, ref));
    if (duplicate) continue;
    const canonicalDuplicate = merged.find((candidate) => sameCanonicalVaultFile(candidate, ref));
    if (canonicalDuplicate) continue;
    merged.push(ref);
  }
  return merged.slice(0, 8);
}

function sameProcessFileRef(left: ProcessFileRef, right: ProcessFileRef): boolean {
  return Boolean(left.absolutePath && right.absolutePath && left.absolutePath === right.absolutePath)
    || (left.kind === right.kind && left.path === right.path);
}

function sameCanonicalVaultFile(left: ProcessFileRef, right: ProcessFileRef): boolean {
  if (left.kind !== "vault" || right.kind !== "vault" || left.name !== right.name) return false;
  const canonical = left.absolutePath ? left : right.absolutePath ? right : null;
  const ambiguous = canonical === left ? right : canonical === right ? left : null;
  if (!canonical || !ambiguous || ambiguous.absolutePath) return false;
  const canonicalPath = canonical.path.replace(/^\/+/, "");
  const ambiguousPath = ambiguous.path.replace(/^\/+/, "");
  return ambiguousPath === canonicalPath || ambiguousPath.endsWith(`/${canonicalPath}`);
}

function commandFromInput(input: unknown): string {
  if (typeof input === "string") return visibleString(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  return visibleString(record.command ?? record.cmd ?? record.script ?? record.shellCommand);
}

interface NormalizedDiffFile {
  summary: DiffFileSummary;
  change: RawFileChange;
}

function toolDiffSummary(event: HarnessEvent): { summary: DiffSummary; changes: RawFileChange[] } | undefined {
  const data = event.data ?? {};
  const fallbackPaths = diffFallbackPaths(data, event.resourceId);
  const changes = normalizeDiffFiles(data.changes, fallbackPaths);
  if (changes.length) return diffProjection(changes);
  const normalizedDiff = normalizeDiffFiles(data.diff, fallbackPaths);
  if (normalizedDiff.length) return diffProjection(normalizedDiff);
  const summary = explicitDiffSummary(data.diffSummary);
  return summary ? { summary, changes: [] } : undefined;
}

function normalizeDiffFiles(value: unknown, fallbackPaths: string[]): NormalizedDiffFile[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => normalizeDiffFiles(entry, [fallbackPaths[index] ?? fallbackPaths[0] ?? ""]));
  }
  if (typeof value === "string") {
    const text = visibleString(value);
    if (!text) return [];
    const looksLikeDiff = /^(?:@@|diff\s+--git|---\s|\+\+\+\s)/m.test(text) || text.includes("\n");
    return [normalizedDiffFile(
      looksLikeDiff ? { path: fallbackPaths[0], diff: text } : { path: text },
      fallbackPaths[0]
    )];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = Array.isArray(record.files)
    ? record.files
    : Array.isArray(record.changes)
      ? record.changes
      : Array.isArray(record.diffs)
        ? record.diffs
        : null;
  if (nested) return normalizeDiffFiles(nested, fallbackPaths);
  return [normalizedDiffFile(record, fallbackPaths[0])];
}

function normalizedDiffFile(value: Record<string, unknown>, fallbackPath = ""): NormalizedDiffFile {
  const path = stringValue(value.path ?? value.file ?? value.filePath ?? value.filename ?? value.name) || fallbackPath || "文件改动";
  const kindValue = value.kind ?? value.status ?? value.type;
  const diff = visibleString(value.diff ?? value.patch ?? value.text);
  const change: RawFileChange = { path, kind: kindValue, diff: diff || undefined };
  const built = buildDiffSummary([change]).files[0];
  return {
    change,
    summary: {
      path,
      previousPath: stringValue(value.previousPath ?? value.oldPath ?? value.from) || built.previousPath,
      kind: normalizedDiffKind(kindValue, built.kind),
      added: optionalNumber(value.added ?? value.additions) ?? built.added,
      removed: optionalNumber(value.removed ?? value.deletions) ?? built.removed
    }
  };
}

function diffProjection(files: NormalizedDiffFile[]): { summary: DiffSummary; changes: RawFileChange[] } {
  const summaries = files.map((file) => file.summary);
  return {
    summary: {
      totalFiles: summaries.length,
      added: summaries.reduce((sum, file) => sum + file.added, 0),
      removed: summaries.reduce((sum, file) => sum + file.removed, 0),
      files: summaries
    },
    changes: files.map((file) => file.change)
  };
}

function explicitDiffSummary(value: unknown): DiffSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.files)) return undefined;
  const files: DiffFileSummary[] = [];
  for (const entry of record.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const file = entry as Record<string, unknown>;
    const path = stringValue(file.path);
    if (!path) continue;
    files.push({
      path,
      previousPath: stringValue(file.previousPath) || undefined,
      kind: normalizedDiffKind(file.kind, "unknown"),
      added: numberValue(file.added),
      removed: numberValue(file.removed)
    });
  }
  if (!files.length) return undefined;
  return {
    totalFiles: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    files
  };
}

function normalizedDiffKind(value: unknown, fallback: DiffFileSummary["kind"]): DiffFileSummary["kind"] {
  if (value === "add" || value === "added" || value === "create" || value === "created") return "add";
  if (value === "delete" || value === "deleted" || value === "remove" || value === "removed") return "delete";
  if (value === "update" || value === "updated" || value === "modify" || value === "modified") return "update";
  if (value === "move" || value === "moved" || value === "rename" || value === "renamed") return "move";
  return fallback;
}

function diffFallbackPaths(data: HarnessProcessEventData, resourceId?: string): string[] {
  const values = Array.isArray(data.files)
    ? data.files
    : Array.isArray(data.locations)
      ? data.locations
      : [];
  const paths = values.map((value) => {
    if (typeof value === "string") return stringValue(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const record = value as Record<string, unknown>;
    return stringValue(record.path ?? record.file ?? record.filePath ?? record.uri);
  }).filter(Boolean);
  const fallback = stringValue(resourceId);
  if (fallback && !paths.includes(fallback)) paths.push(fallback);
  return paths;
}

function channelText(state: HarnessContentAvailability | undefined, value: unknown): string {
  if (state === "empty" || state === "unavailable") return "";
  return displayValue(value);
}

function normalizedChannelAvailability(
  state: HarnessContentAvailability | undefined,
  text: string
): HarnessContentAvailability | undefined {
  if (state === "unavailable") return "unavailable";
  if (state === "empty") return "empty";
  if (state === "provided") return text ? "provided" : "empty";
  return text ? "provided" : undefined;
}

function shouldPreserveProvidedChannel(
  currentState: HarnessContentAvailability | undefined,
  currentText: string,
  nextState: HarnessContentAvailability | undefined
): boolean {
  if (nextState !== "empty" && nextState !== "unavailable") return false;
  return normalizedChannelAvailability(currentState, currentText) === "provided";
}

function toolContentAvailability(
  state: Pick<ToolProjectionState, "inputState" | "outputState" | "preview">,
  message: ChatMessage
): ChatMessage["processContentAvailability"] {
  // A provider preview is useful in the collapsed summary, but it is not raw
  // input/output. Keep the expanded body honest when only the preview exists.
  if (visibleString(message.text) || message.files?.length || message.diffSummary?.files.length) return "provided";
  if (state.inputState === "unavailable" || state.outputState === "unavailable") return "unavailable";
  if (state.inputState === "empty" || state.outputState === "empty") return "empty";
  return undefined;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return visibleString(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return "";
  try {
    return visibleString(JSON.stringify(value, null, 2));
  } catch {
    return "";
  }
}

function visibleString(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || EMPTY_DISPLAY_VALUES.has(trimmed.toLowerCase())) return "";
  return value;
}

function meaningfulSummaryDetail(value: string): string | undefined {
  const detail = visibleString(value);
  if (!detail || /^(调用工具|调用外部工具|记录执行过程)$/.test(detail)) return undefined;
  return detail;
}

function emptySettlementText(status: HarnessProjectionSettlement["status"]): string {
  if (status === "completed") return "Agent 未返回内容";
  if (status === "cancelled") return "已停止生成";
  return "Agent 执行失败";
}

function normalizedProcessStatus(value: string | undefined, fallback: string): string {
  return value === "in_progress" || value === "inProgress" ? "running" : value || fallback;
}

function processMessageId(runId: string, kind: "reasoning" | "plan" | "tool", id: string): string {
  return `inline-process:${runId}:${kind}:${id}`;
}

function answerSegmentMessageId(runId: string, segmentId: string): string {
  return `inline-answer:${runId}:${segmentId}`;
}

function terminalAnswerSegmentId(runId: string): string {
  return `${runId}:terminal`;
}

function hasVisibleText(value: string): boolean {
  return value.trim().length > 0;
}

function nextSegmentId(providerId: string, counts: Map<string, number>): string {
  const count = (counts.get(providerId) ?? 0) + 1;
  counts.set(providerId, count);
  return count === 1 ? providerId : `${providerId}:segment:${count}`;
}

function resetAnswerMessage(target: ChatMessage, template: ChatMessage, createdAt: number): void {
  const id = target.id;
  Object.assign(target, cloneMessage(template), {
    id,
    role: "assistant",
    itemType: "assistant",
    status: "running",
    text: "",
    createdAt
  });
  delete target.completedAt;
  delete target.details;
  delete target.previewText;
  delete target.rawRef;
  delete target.rawSize;
  delete target.rawLines;
  delete target.rawTruncatedForPreview;
}

function eventTime(event: HarnessEvent, fallback: number): number {
  return Number.isFinite(event.createdAt) && event.createdAt > 0 ? event.createdAt : fallback + Math.max(0, event.sequence);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    runUsage: message.runUsage ? { ...message.runUsage } : undefined,
    files: message.files ? [...message.files] : undefined,
    diffSummary: message.diffSummary
      ? { ...message.diffSummary, files: message.diffSummary.files.map((file) => ({ ...file })) }
      : undefined
  };
}

function emptyBatch(): HarnessProjectionBatch {
  return { acceptedSequences: [], updates: [] };
}
