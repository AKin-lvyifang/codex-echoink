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
      if (itemId) this.appendAssistantDelta(itemId, delta);
      await this.emitEvent("agent.message.delta", "agent", { text: delta, data: sanitizeNotificationData(params) });
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      await this.emitEvent("agent.reasoning.started", "agent", { data: sanitizeNotificationData(params) });
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      await this.emitEvent("agent.reasoning.summary.delta", "agent", {
        text: textValue(params?.delta),
        data: sanitizeNotificationData(params)
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
      await this.emitToolDelta(itemId, textValue(params?.delta), params);
      return;
    }

    if (method === "item/mcpToolCall/progress") {
      await this.emitToolDelta(itemId, textValue(params?.message, params?.delta), params);
      return;
    }

    if (method === "item/fileChange/outputDelta") {
      await this.emitEvent("file.change.proposed", "agent", {
        text: textValue(params?.delta),
        toolName: this.toolItems.get(itemId)?.toolName ?? "文件改动",
        data: sanitizeNotificationData(params)
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
      if (status === "failed") {
        await this.settle({ status: "failed", error: stringValue(params?.turn?.error, params?.error, params?.message) || "Codex run failed" }, {
          type: "run.failed",
          source: "kernel",
          error: stringValue(params?.turn?.error, params?.error, params?.message) || "Codex run failed"
        });
        return;
      }
      if (status === "cancelled") {
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
    const itemId = stringValue(item?.id);
    if (itemId) this.itemIds.add(itemId);
    const itemType = codexItemType(item);
    if (itemType === "commandExecution" || itemType === "mcpToolCall") {
      const toolName = toolNameFromItem(item);
      if (itemId) this.toolItems.set(itemId, { itemType, toolName });
      await this.emitEvent("tool.started", "tool", {
        toolName,
        data: sanitizeData(item)
      });
      return;
    }
    if (itemType === "fileChange") {
      if (itemId) this.toolItems.set(itemId, { itemType, toolName: "文件改动" });
      await this.emitEvent("file.change.proposed", "agent", {
        toolName: "文件改动",
        text: stringValue(item?.title, item?.path, item?.name),
        data: sanitizeData(item)
      });
    }
  }

  private async handleCompletedItem(item: any): Promise<void> {
    const itemId = stringValue(item?.id);
    if (itemId) this.itemIds.add(itemId);
    const itemType = codexItemType(item);
    if (itemType === "agentMessage") {
      if (itemId) this.ensureAssistantItem(itemId);
      const text = textValue(item?.text, item?.output) || (itemId ? this.assistantTextByItem.get(itemId) ?? "" : "");
      if (itemId) this.assistantTextByItem.set(itemId, text);
      await this.emitEvent("agent.message.completed", "agent", { text, data: sanitizeData(item) });
      if (stringValue(item?.phase).toLowerCase() === "final_answer") {
        this.armFinalAnswerTimer();
      }
      return;
    }
    if (itemType === "reasoning") {
      await this.emitEvent("agent.reasoning.summary.completed", "agent", {
        text: textValue(item?.text, item?.output),
        data: sanitizeData(item)
      });
      return;
    }
    if (itemType === "commandExecution" || itemType === "mcpToolCall") {
      const status = normalizeStatus(item?.status);
      await this.emitEvent(status === "failed" ? "tool.failed" : "tool.completed", "tool", {
        toolName: toolNameFromItem(item, this.toolItems.get(itemId)?.toolName),
        text: textValue(item?.output, item?.text),
        error: stringValue(item?.error),
        data: sanitizeData(item)
      });
      return;
    }
    if (itemType === "fileChange") {
      const status = normalizeStatus(item?.status);
      const eventType = status === "failed"
        ? "file.change.reverted"
        : "file.change.applied";
      await this.emitEvent(eventType, "agent", {
        toolName: "文件改动",
        text: textValue(item?.output, item?.text, item?.title),
        error: stringValue(item?.error),
        data: sanitizeData(item)
      });
    }
  }

  private async emitToolDelta(itemId: string, text: string, params: any): Promise<void> {
    const toolState = this.toolItems.get(itemId);
    await this.emitEvent("tool.output.delta", "tool", {
      toolName: toolState?.toolName,
      text,
      data: sanitizeNotificationData(params)
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
      data: input.data
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
