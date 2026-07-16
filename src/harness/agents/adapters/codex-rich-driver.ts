import type { CodexNotification } from "../../../types/app-server";
import type { HarnessEvent, HarnessEventSink, HarnessEventType } from "../../contracts/event";
import type { AgentRunResult } from "../adapter";

export interface CodexRichArtifactRecoveryInput {
  runId: string;
  threadId?: string;
  turnId?: string;
  assistantText: string;
}

export interface CodexRichRunDriverOptions {
  runId: string;
  backendId: string;
  emit: HarnessEventSink;
  now?: () => number;
  threadId?: string;
  turnId?: string;
  interruptTurn?: (threadId: string, turnId: string) => Promise<void>;
  inactivityTimeoutMs?: number;
  artifactRecovery?: (input: CodexRichArtifactRecoveryInput) => Promise<string | null>;
  onSettled?: (result: AgentRunResult) => void | Promise<void>;
  finalAnswerGraceMs?: number;
}

export class CodexRichRunDriver {
  readonly runId: string;
  readonly backendId: string;
  threadId: string;
  turnId: string;

  private readonly emit: HarnessEventSink;
  private readonly now: () => number;
  private readonly itemIds = new Set<string>();
  private readonly toolItems = new Map<string, ToolItemState>();
  private readonly assistantTextByItem = new Map<string, string>();
  private readonly assistantOrder: string[] = [];
  private fallbackMessageCounter = 0;
  private fallbackReasoningCounter = 0;
  private fallbackToolCounter = 0;
  private activeFallbackMessageId = "";
  private activeFallbackReasoningId = "";
  private readonly fallbackToolIdsByType = new Map<string, string[]>();
  private readonly onSettled?: (result: AgentRunResult) => void | Promise<void>;
  private readonly artifactRecovery?: (input: CodexRichArtifactRecoveryInput) => Promise<string | null>;
  private readonly inactivityTimeoutMs?: number;
  private readonly finalAnswerGraceMs: number;
  private readonly interruptTurn?: (threadId: string, turnId: string) => Promise<void>;

  private queue: Promise<void> = Promise.resolve();
  private interrupting?: Promise<void>;
  private settling?: Promise<void>;
  private terminalResolved = false;
  private cancelRequested = false;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private finalAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveResult!: (result: AgentRunResult) => void;
  private readonly resultPromise: Promise<AgentRunResult>;

  constructor(options: CodexRichRunDriverOptions) {
    this.runId = options.runId;
    this.backendId = options.backendId;
    this.threadId = options.threadId ?? "";
    this.turnId = options.turnId ?? "";
    this.emit = options.emit;
    this.now = options.now ?? Date.now;
    this.onSettled = options.onSettled;
    this.artifactRecovery = options.artifactRecovery;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs;
    this.finalAnswerGraceMs = Math.max(1, options.finalAnswerGraceMs ?? 1_500);
    this.interruptTurn = options.interruptTurn;
    this.resultPromise = new Promise<AgentRunResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  setThreadId(threadId: string): void {
    this.threadId = threadId.trim();
  }

  setTurnId(turnId: string): void {
    this.turnId = turnId.trim();
    this.armInactivityTimer();
  }

  hasItemId(itemId: string): boolean {
    return this.itemIds.has(itemId);
  }

  requestCancel(): void {
    this.cancelRequested = true;
  }

  isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  handleNotification(notification: CodexNotification): void {
    const params = notificationParams(notification.params);
    const threadId = stringValue(
      params.threadId,
      params.thread?.id,
      params.turn?.threadId,
      params.item?.threadId
    );
    const turnId = stringValue(
      params.turnId,
      params.turn?.id,
      params.item?.turnId
    );
    const itemId = stringValue(params.itemId, params.item?.id);
    if (threadId) this.threadId = threadId;
    if (turnId) this.turnId = turnId;
    if (itemId) this.itemIds.add(itemId);
    void this.enqueue(async () => {
      await this.processNotification(notification);
    }).catch(() => undefined);
  }

  async awaitResult(): Promise<AgentRunResult> {
    return await this.resultPromise;
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.terminalResolved) return;
    if (!this.threadId || !this.turnId || !this.interruptTurn) {
      const error = "Codex interrupt is unavailable for the active run";
      await this.settle({ status: "failed", error }, { type: "run.failed", source: "kernel", error });
      throw new Error(error);
    }
    if (!this.interrupting) {
      this.interrupting = this.interruptTurn(this.threadId, this.turnId)
        .finally(() => {
          this.interrupting = undefined;
        });
    }
    try {
      await this.interrupting;
    } catch (cause) {
      const message = `Codex interrupt failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      await this.settle({ status: "failed", error: message }, { type: "run.failed", source: "kernel", error: message });
      throw cause;
    }
    await this.settle({ status: "cancelled", error: "Run cancelled" }, { type: "run.cancelled", source: "kernel" });
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work, work);
    await this.queue;
  }

  private async processNotification(notification: CodexNotification): Promise<void> {
    if (this.terminalResolved) return;
    const method = notification.method;
    const params = notificationParams(notification.params);
    const itemId = stringValue(params?.itemId, params?.item?.id);
    const threadId = stringValue(params?.threadId, params?.thread?.id, params?.turn?.threadId, params?.item?.threadId);
    const turnId = stringValue(params?.turnId, params?.turn?.id, params?.item?.turnId);
    if (threadId) this.threadId = threadId;
    if (turnId) this.turnId = turnId;
    if (itemId) this.itemIds.add(itemId);
    this.clearFinalAnswerTimerForFollowUp(method);
    this.armInactivityTimer();

    if (method === "item/agentMessage/delta") {
      const delta = textValue(params?.delta);
      this.activeFallbackReasoningId = "";
      const messageId = this.resolveMessageId(itemId);
      this.appendAssistantDelta(messageId, delta);
      await this.emitEvent("agent.message.delta", "agent", {
        text: delta,
        data: withMessageIdentity(sanitizeNotificationData(params), messageId)
      });
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      this.activeFallbackMessageId = "";
      const blockId = this.resolveReasoningId(itemId, true);
      await this.emitEvent("agent.reasoning.started", "agent", {
        data: withReasoningIdentity(sanitizeNotificationData(params), blockId)
      });
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      this.activeFallbackMessageId = "";
      const blockId = this.resolveReasoningId(itemId);
      await this.emitEvent("agent.reasoning.summary.delta", "agent", {
        text: textValue(params?.delta),
        data: withReasoningIdentity(sanitizeNotificationData(params), blockId)
      });
      return;
    }

    if (method === "turn/plan/updated" || method === "item/plan/delta") {
      await this.emitEvent("agent.plan.updated", "agent", {
        text: planTextFromParams(params),
        data: sanitizeNotificationData(params)
      });
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      this.closeFallbackContentSegments();
      await this.emitToolDelta(this.resolveToolProgressId(itemId, "commandExecution"), textValue(params?.delta), params);
      return;
    }

    if (method === "item/mcpToolCall/progress") {
      this.closeFallbackContentSegments();
      await this.emitToolDelta(this.resolveToolProgressId(itemId, "mcpToolCall"), textValue(params?.message, params?.delta), params);
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      this.closeFallbackContentSegments();
      const fileChangeId = this.resolveToolProgressId(itemId, "fileChange");
      await this.emitEvent("file.change.proposed", "agent", {
        text: textValue(params?.delta),
        toolName: this.toolItems.get(fileChangeId)?.toolName ?? "文件改动",
        data: withToolIdentity(sanitizeNotificationData(params), fileChangeId, "edit", "running")
      });
      return;
    }

    if (method === "item/started" && params?.item) {
      await this.handleStartedItem(params.item);
      return;
    }

    if (method === "item/completed" && params?.item) {
      await this.handleCompletedItem(params.item);
      return;
    }

    if (method === "turn/completed") {
      const usage = recordValue(params?.usage, params?.turn?.usage, params?.tokenUsage);
      if (usage) {
        await this.emitEvent("usage.updated", "agent", { data: sanitizeData(usage) });
      }
      const status = normalizeStatus(params?.turn?.status);
      if (isFailedStatus(status)) {
        await this.settle({ status: "failed", error: stringValue(params?.turn?.error, params?.error, params?.message) || "Codex run failed" }, {
          type: "run.failed",
          source: "kernel",
          error: stringValue(params?.turn?.error, params?.error, params?.message) || "Codex run failed"
        });
        return;
      }
      if (isCancelledStatus(status)) {
        await this.settle({ status: "cancelled", error: "Run cancelled" }, { type: "run.cancelled", source: "kernel" });
        return;
      }
      await this.settle({ status: "completed", outputText: this.finalAssistantText() }, {
        type: "run.completed",
        source: "kernel",
        text: this.finalAssistantText()
      });
      return;
    }

    if (method === "error") {
      if (isRetryingCodexError(params)) return;
      await this.settle({ status: "failed", error: stringValue(params?.message, params?.error) || "Codex run failed" }, {
        type: "run.failed",
        source: "kernel",
        error: stringValue(params?.message, params?.error) || "Codex run failed"
      });
    }
  }

  private async handleStartedItem(item: any): Promise<void> {
    const explicitItemId = stringValue(item?.id);
    const itemType = codexItemType(item);
    if (isCodexToolItemType(itemType)) this.closeFallbackContentSegments();
    const itemId = explicitItemId || (isCodexToolItemType(itemType) ? this.startFallbackToolId(itemType) : "");
    if (itemId) this.itemIds.add(itemId);
    if (itemId && isCodexToolItemType(itemType)) this.trackStartedToolId(itemType, itemId);
    if (itemType === "commandExecution" || itemType === "mcpToolCall") {
      const toolName = toolNameFromItem(item);
      if (itemId) this.toolItems.set(itemId, { itemType, toolName });
      await this.emitEvent("tool.started", "tool", {
        toolName,
        data: normalizedCodexToolData(item, itemId || `${this.runId}:tool`, itemType, "running")
      });
      return;
    }
    if (itemType === "fileChange") {
      if (itemId) this.toolItems.set(itemId, { itemType, toolName: "文件改动" });
      await this.emitEvent("file.change.proposed", "agent", {
        toolName: "文件改动",
        text: stringValue(item?.title, item?.path, item?.name),
        data: normalizedCodexToolData(item, itemId || `${this.runId}:file-change`, itemType, "running")
      });
    }
  }

  private async handleCompletedItem(item: any): Promise<void> {
    const explicitItemId = stringValue(item?.id);
    const itemType = codexItemType(item);
    if (itemType === "agentMessage") this.activeFallbackReasoningId = "";
    else if (itemType === "reasoning") this.activeFallbackMessageId = "";
    else if (isCodexToolItemType(itemType)) this.closeFallbackContentSegments();
    const itemId = itemType === "agentMessage"
      ? this.resolveMessageId(explicitItemId, true)
      : itemType === "reasoning"
        ? this.resolveReasoningId(explicitItemId, false, true)
        : isCodexToolItemType(itemType)
          ? this.resolveCompletedToolId(explicitItemId, itemType)
          : explicitItemId;
    if (itemId) this.itemIds.add(itemId);
    if (itemType === "agentMessage") {
      this.ensureAssistantItem(itemId);
      const text = textValue(item?.text, item?.output) || this.assistantTextByItem.get(itemId) || "";
      this.assistantTextByItem.set(itemId, text);
      await this.emitEvent("agent.message.completed", "agent", {
        text,
        data: withMessageIdentity(sanitizeData(item), itemId)
      });
      if (stringValue(item?.phase).toLowerCase() === "final_answer") {
        this.armFinalAnswerTimer();
      }
      return;
    }
    if (itemType === "reasoning") {
      await this.emitEvent("agent.reasoning.summary.completed", "agent", {
        text: textValue(item?.text, item?.output),
        data: withReasoningIdentity(sanitizeData(item), itemId)
      });
      return;
    }
    if (itemType === "commandExecution" || itemType === "mcpToolCall") {
      const toolStatus = completedToolStatus(item?.status);
      await this.emitEvent(isToolFailureStatus(toolStatus) ? "tool.failed" : "tool.completed", "tool", {
        toolName: toolNameFromItem(item, this.toolItems.get(itemId)?.toolName),
        text: itemType === "commandExecution"
          ? textValue(item?.aggregatedOutput, item?.output, item?.text)
          : textValue(item?.output, item?.text),
        error: stringValue(item?.error),
        data: normalizedCodexToolData(item, itemId, itemType, toolStatus)
      });
      return;
    }
    if (itemType === "fileChange") {
      const toolStatus = completedToolStatus(item?.status);
      const eventType = isToolFailureStatus(toolStatus)
        ? "file.change.reverted"
        : toolStatus === "completed"
          ? "file.change.applied"
          : "file.change.proposed";
      await this.emitEvent(eventType, "agent", {
        toolName: "文件改动",
        text: textValue(item?.output, item?.text, item?.title),
        error: stringValue(item?.error),
        data: normalizedCodexToolData(item, itemId, itemType, toolStatus)
      });
    }
  }

  private async emitToolDelta(itemId: string, text: string, params: any): Promise<void> {
    const toolState = this.toolItems.get(itemId);
    const data = withToolIdentity(
      sanitizeNotificationData(params),
      itemId || `${this.runId}:tool`,
      semanticKindForCodexItem(toolState?.itemType),
      "running"
    );
    if (toolState?.itemType === "commandExecution") data.outputState = "provided";
    await this.emitEvent("tool.output.delta", "tool", {
      toolName: toolState?.toolName,
      text,
      data
    });
  }

  private appendAssistantDelta(itemId: string, delta: string): void {
    this.ensureAssistantItem(itemId);
    this.assistantTextByItem.set(itemId, `${this.assistantTextByItem.get(itemId) ?? ""}${delta}`);
  }

  private ensureAssistantItem(itemId: string): void {
    if (this.assistantTextByItem.has(itemId)) return;
    this.assistantOrder.push(itemId);
    this.assistantTextByItem.set(itemId, "");
  }

  private resolveMessageId(explicitId: string, completed = false): string {
    if (explicitId) {
      this.activeFallbackMessageId = completed ? "" : explicitId;
      return explicitId;
    }
    if (!this.activeFallbackMessageId) {
      this.fallbackMessageCounter += 1;
      this.activeFallbackMessageId = `${this.runId}:message:${this.fallbackMessageCounter}`;
    }
    const id = this.activeFallbackMessageId;
    if (completed) this.activeFallbackMessageId = "";
    return id;
  }

  private closeFallbackContentSegments(): void {
    this.activeFallbackMessageId = "";
    this.activeFallbackReasoningId = "";
  }

  private resolveReasoningId(explicitId: string, started = false, completed = false): string {
    if (explicitId) {
      this.activeFallbackReasoningId = completed ? "" : explicitId;
      return explicitId;
    }
    if (started || !this.activeFallbackReasoningId) {
      this.fallbackReasoningCounter += 1;
      this.activeFallbackReasoningId = `${this.runId}:reasoning:${this.fallbackReasoningCounter}`;
    }
    const id = this.activeFallbackReasoningId;
    if (completed) this.activeFallbackReasoningId = "";
    return id;
  }

  private startFallbackToolId(itemType: string): string {
    this.fallbackToolCounter += 1;
    return `${this.runId}:tool:${this.fallbackToolCounter}`;
  }

  private trackStartedToolId(itemType: string, id: string): void {
    const queue = this.fallbackToolIdsByType.get(itemType) ?? [];
    if (!queue.includes(id)) queue.push(id);
    this.fallbackToolIdsByType.set(itemType, queue);
  }

  private resolveToolProgressId(explicitId: string, itemType: string): string {
    if (explicitId) return explicitId;
    const queued = this.fallbackToolIdsByType.get(itemType)?.[0];
    if (queued) return queued;
    const generated = this.startFallbackToolId(itemType);
    this.trackStartedToolId(itemType, generated);
    return generated;
  }

  private completeFallbackToolId(itemType: string): string {
    const queue = this.fallbackToolIdsByType.get(itemType);
    const id = queue?.shift() ?? this.startFallbackToolId(itemType);
    if (queue && !queue.length) this.fallbackToolIdsByType.delete(itemType);
    return id;
  }

  private resolveCompletedToolId(explicitId: string, itemType: string): string {
    if (!explicitId) return this.completeFallbackToolId(itemType);
    const queue = this.fallbackToolIdsByType.get(itemType);
    const index = queue?.indexOf(explicitId) ?? -1;
    if (queue && index >= 0) queue.splice(index, 1);
    if (queue && !queue.length) this.fallbackToolIdsByType.delete(itemType);
    return explicitId;
  }

  private finalAssistantText(): string {
    return this.assistantOrder
      .map((itemId) => this.assistantTextByItem.get(itemId) ?? "")
      .join("")
      .trim();
  }

  private async emitEvent(type: HarnessEventType, source: HarnessEvent["source"], input: {
    text?: string;
    error?: string;
    toolName?: string;
    data?: Record<string, unknown>;
  } = {}): Promise<void> {
    await this.emit({
      eventId: "",
      runId: this.runId,
      sequence: 0,
      createdAt: this.now(),
      source,
      type,
      backendId: this.backendId,
      text: input.text,
      error: input.error,
      toolName: input.toolName,
      data: { streamSource: "codex-native", ...input.data }
    });
  }

  private armInactivityTimer(): void {
    if (!this.inactivityTimeoutMs || this.terminalResolved) return;
    if (!this.threadId || !this.turnId) return;
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      void this.enqueue(async () => {
        await this.handleInactivityTimeout();
      }).catch(() => undefined);
    }, Math.max(1, this.inactivityTimeoutMs));
  }

  private armFinalAnswerTimer(): void {
    if (this.terminalResolved) return;
    this.clearFinalAnswerTimer();
    this.finalAnswerTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.terminalResolved) return;
        const text = this.finalAssistantText();
        await this.settle({ status: "completed", outputText: text }, {
          type: "run.completed",
          source: "kernel",
          text,
          data: { settlement: "final-answer-grace" }
        });
      }).catch(() => undefined);
    }, this.finalAnswerGraceMs);
  }

  private clearFinalAnswerTimerForFollowUp(method: string): void {
    if (!this.finalAnswerTimer) return;
    if (!FINAL_ANSWER_FOLLOW_UP_METHODS.has(method)) return;
    this.clearFinalAnswerTimer();
  }

  private async handleInactivityTimeout(): Promise<void> {
    if (this.terminalResolved) return;
    this.clearInactivityTimer();
    if (!this.artifactRecovery) {
      await this.settle({ status: "failed", error: "Codex inactivity timeout" }, {
        type: "run.failed",
        source: "kernel",
        error: "Codex inactivity timeout"
      });
      return;
    }
    try {
      const text = await this.artifactRecovery({
        runId: this.runId,
        threadId: this.threadId || undefined,
        turnId: this.turnId || undefined,
        assistantText: this.finalAssistantText()
      });
      if (typeof text !== "string" || !text.trim()) {
        await this.settle({ status: "failed", error: "Codex inactivity timeout" }, {
          type: "run.failed",
          source: "kernel",
          error: "Codex inactivity timeout"
        });
        return;
      }
      if (this.threadId && this.turnId && this.interruptTurn) {
        await this.interruptTurn(this.threadId, this.turnId);
      }
      await this.settle({ status: "completed", outputText: text }, {
        type: "run.completed",
        source: "kernel",
        text
      });
    } catch (error) {
      await this.settle({ status: "failed", error: error instanceof Error ? error.message : String(error) }, {
        type: "run.failed",
        source: "kernel",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async settle(result: AgentRunResult, terminalEvent: {
    type: "run.completed" | "run.failed" | "run.cancelled";
    source: HarnessEvent["source"];
    text?: string;
    error?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    if (this.terminalResolved) return;
    if (!this.settling) {
      this.settling = this.performSettle(result, terminalEvent);
    }
    await this.settling;
  }

  private async performSettle(result: AgentRunResult, terminalEvent: {
    type: "run.completed" | "run.failed" | "run.cancelled";
    source: HarnessEvent["source"];
    text?: string;
    error?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    this.clearInactivityTimer();
    this.clearFinalAnswerTimer();
    let settledResult = result;
    try {
      await this.emitEvent(terminalEvent.type, terminalEvent.source, {
        text: terminalEvent.text,
        error: terminalEvent.error,
        data: terminalEvent.data
      });
    } catch (error) {
      settledResult = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
    this.terminalResolved = true;
    try {
      await this.onSettled?.(settledResult);
    } catch {
      // Settlement cleanup is best-effort; the run result must never remain pending.
    }
    this.resolveResult(settledResult);
  }

  private clearInactivityTimer(): void {
    if (!this.inactivityTimer) return;
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private clearFinalAnswerTimer(): void {
    if (!this.finalAnswerTimer) return;
    clearTimeout(this.finalAnswerTimer);
    this.finalAnswerTimer = null;
  }
}

const FINAL_ANSWER_FOLLOW_UP_METHODS = new Set([
  "item/started",
  "item/agentMessage/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "turn/plan/updated",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/mcpToolCall/progress",
  "item/fileChange/outputDelta"
]);

function notificationParams(value: unknown): any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

interface ToolItemState {
  itemType: string;
  toolName: string;
}

function codexItemType(item: any): string {
  return stringValue(item?.type, item?.itemType, item?.kind, item?.data?.itemType);
}

function toolNameFromItem(item: any, fallback = ""): string {
  return stringValue(item?.toolName, item?.title, item?.name, item?.command, fallback) || "工具";
}

function planTextFromParams(params: any): string {
  if (typeof params?.delta === "string") return params.delta;
  if (Array.isArray(params?.plan)) {
    return params.plan
      .map((entry) => {
        const step = stringValue(entry?.step, entry?.text, entry?.title);
        const status = stringValue(entry?.status);
        return [step, status].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeStatus(status: unknown): string {
  return typeof status === "string"
    ? status.trim().toLowerCase()
    : "";
}

function isCancelledStatus(status: string): boolean {
  return status === "cancelled"
    || status === "canceled"
    || status === "interrupted"
    || status === "aborted";
}

function isFailedStatus(status: string): boolean {
  return status === "failed"
    || status === "error"
    || status === "denied"
    || status === "rejected";
}

function completedToolStatus(status: unknown): "completed" | "failed" | "denied" | "interrupted" | "unconfirmed" {
  const normalized = normalizeStatus(status);
  if (!normalized || normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded") return "completed";
  if (normalized === "denied" || normalized === "rejected") return "denied";
  if (isCancelledStatus(normalized)) return "interrupted";
  if (isFailedStatus(normalized)) return "failed";
  return "unconfirmed";
}

function isToolFailureStatus(status: string): boolean {
  return status === "failed" || status === "denied" || status === "interrupted";
}

function isRetryingCodexError(params: any): boolean {
  return params?.willRetry === true || params?.error?.willRetry === true;
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function textValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function recordValue(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function sanitizeNotificationData(params: any): Record<string, unknown> {
  return sanitizeData({
    ...params,
    item: params?.item && typeof params.item === "object"
      ? sanitizeData(params.item)
      : params?.item
  });
}

function withMessageIdentity(data: Record<string, unknown>, messageId: string): Record<string, unknown> {
  return { ...data, messageId };
}

function withReasoningIdentity(data: Record<string, unknown>, blockId: string): Record<string, unknown> {
  return {
    ...data,
    blockId,
    reasoningKind: "summary",
    visibility: "public"
  };
}

function withToolIdentity(
  data: Record<string, unknown>,
  callId: string,
  semanticKind: string,
  toolStatus: string
): Record<string, unknown> {
  return {
    ...data,
    callId,
    toolCallId: callId,
    semanticKind,
    toolStatus
  };
}

function normalizedCodexToolData(
  item: any,
  callId: string,
  itemType: string,
  toolStatus: string
): Record<string, unknown> {
  const data = withToolIdentity(sanitizeData(item), callId, semanticKindForCodexItem(itemType), toolStatus);
  const input = firstPresentValue(item, ["input", "arguments", "command", "changes"]);
  const output = itemType === "commandExecution" && item?.aggregatedOutput !== null && item?.aggregatedOutput !== undefined
    ? { present: true, value: item.aggregatedOutput }
    : firstPresentValue(item, ["output", "result", "text"]);
  const inputState = contentAvailability(input.present, input.value);
  const outputState = contentAvailability(output.present, output.value);
  data.inputState = inputState;
  data.outputState = outputState;
  if (inputState === "provided") data.input = input.value;
  if (outputState === "provided") data.output = output.value;
  const files = codexToolFiles(item);
  if (files.length) data.files = files;
  const diff = firstPresentValue(item, ["diff", "changes", "patch"]);
  if (diff.present) data.diff = diff.value;
  return data;
}

function codexToolFiles(item: any): string[] {
  const candidates: unknown[] = [item?.path, item?.file, item?.filePath];
  for (const collection of [item?.files, item?.locations, item?.changes]) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (typeof entry === "string") candidates.push(entry);
      else if (entry && typeof entry === "object") {
        candidates.push(entry.path, entry.file, entry.filePath, entry.uri);
      }
    }
  }
  return [...new Set(candidates.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

function isCodexToolItemType(itemType: string): boolean {
  return itemType === "commandExecution" || itemType === "mcpToolCall" || itemType === "fileChange";
}

function semanticKindForCodexItem(itemType: string | undefined): string {
  if (itemType === "commandExecution") return "command";
  if (itemType === "fileChange") return "edit";
  if (itemType === "mcpToolCall") return "mcp";
  return "tool";
}

function firstPresentValue(value: any, keys: string[]): { present: boolean; value: unknown } {
  if (!value || typeof value !== "object") return { present: false, value: undefined };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return { present: true, value: value[key] };
  }
  return { present: false, value: undefined };
}

function contentAvailability(present: boolean, value: unknown): "provided" | "empty" | "unavailable" {
  if (!present) return "unavailable";
  if (value === undefined || value === null || value === "") return "empty";
  if (Array.isArray(value) && value.length === 0) return "empty";
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return "empty";
  return "provided";
}

function sanitizeData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "threadId" || key === "turnId" || key === "itemId" || key === "nativeThreadId" || key === "nativeTurnId") continue;
    if (key === "id") continue;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      copy[key] = sanitizeData(entry);
      continue;
    }
    copy[key] = entry;
  }
  return copy;
}
