import { spawn } from "child_process";
import type { AgentBackendKind, AgentPromptPart, AgentTaskInput, AgentTaskResult } from "./types";
import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentRichStreamRuntime } from "./runtime";
import { normalizeRichStreamEvents } from "./rich-stream";
import { swallowError } from "../core/error-handling";
import { JsonRpcStdioTransport, type JsonRpcMessage, type JsonRpcProcessLike } from "../core/json-rpc-stdio-transport";
import { exactWriteFenceUnavailable } from "./write-fence";

export interface AcpRuntimeCommand {
  command: string | (() => string);
  args?: string[] | (() => string[]);
  cwd: string;
  env?: Record<string, string>;
}

export type AcpSubprocessLike = JsonRpcProcessLike;

export interface AcpRuntimeOptions {
  backend: Exclude<AgentBackendKind, "codex-cli">;
  command: AcpRuntimeCommand;
  processFactory?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => AcpSubprocessLike;
  requestTimeoutMs?: number;
}

const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 1500;
const ACP_METHOD_CANDIDATES = {
  cancel: ["session/cancel", "cancel"],
  initialize: ["initialize"],
  newSession: ["session/new", "newSession"],
  prompt: ["session/prompt", "prompt"]
} as const;

export class AcpAgentRuntime implements AgentRichStreamRuntime {
  readonly kind: Exclude<AgentBackendKind, "codex-cli">;
  private process: AcpSubprocessLike | null = null;
  private transport: AcpJsonRpcProcessTransport | null = null;
  private initialized = false;
  private activeRunId = "";
  private activeEmit: ((event: AgentEvent) => Promise<void>) | null = null;
  private eventQueue = Promise.resolve();
  private startupTimeoutMs = DEFAULT_ACP_STARTUP_TIMEOUT_MS;
  private reasoningBlockCounter = 0;
  private activeReasoningBlockId = "";
  private messageCounter = 0;
  private activeMessageId = "";
  private toolCallCounter = 0;
  private readonly activeToolCalls = new Map<string, AgentEvent>();
  private deferProviderEvents = false;
  private readonly deferredProviderEvents: AgentEvent[] = [];

  constructor(private readonly options: AcpRuntimeOptions) {
    this.kind = options.backend;
  }

  async connect() {
    if (!this.transport) {
      const command = resolveCommandValue(this.options.command.command);
      const args = resolveArgsValue(this.options.command.args);
      this.process = (this.options.processFactory ?? defaultAcpProcessFactory)(command, args, {
        cwd: this.options.command.cwd,
        env: { ...process.env, ...(this.options.command.env ?? {}) }
      });
      this.transport = new AcpJsonRpcProcessTransport(this.process, this.options.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS);
      this.transport.onNotification("session/update", (params) => this.handleSessionUpdate(params));
      this.transport.onNotification("sessionUpdate", (params) => this.handleSessionUpdate(params));
      this.transport.onRequest("session/request_permission", async (params) => this.handlePermissionRequest(params));
      this.transport.onRequest("requestPermission", async (params) => this.handlePermissionRequest(params));
      this.transport.onRequest("fs/read_text_file", async () => ({ content: "" }));
      this.transport.onRequest("fs/readTextFile", async () => ({ content: "" }));
      this.transport.onRequest("fs/write_text_file", async () => {
        throw new Error("EchoInk ACP runtime does not allow direct file writes.");
      });
      this.transport.onRequest("fs/writeTextFile", async () => {
        throw new Error("EchoInk ACP runtime does not allow direct file writes.");
      });
      this.transport.onRequest("terminal/create", async () => {
        throw new Error("EchoInk ACP runtime does not expose terminal execution.");
      });
      this.transport.onRequest("terminalCreate", async () => {
        throw new Error("EchoInk ACP runtime does not expose terminal execution.");
      });
    }
    if (!this.initialized) {
      await this.requestWithFallback("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: {
          name: "codex-echoink",
          title: "Codex EchoInk",
          version: "1.0.3"
        }
      }, this.startupTimeoutMs);
      this.initialized = true;
    }
    return { connected: true, label: this.kind, errors: [] };
  }

  async disconnect(): Promise<void> {
    this.transport?.dispose();
    this.transport = null;
    this.initialized = false;
    this.process?.kill();
    this.process = null;
    this.activeEmit = null;
    this.resetRichEventState();
    await this.eventQueue.catch(swallowError(`${this.options.backend} ACP event queue cleanup`));
  }

  async listModels() {
    return [];
  }

  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    let text = "";
    let completedText = "";
    const result = await this.runTaskStream(input, (event) => {
      if (event.type === "message_delta") text += event.text ?? "";
      if (event.type === "message_completed" || event.type === "completed") completedText = event.text ?? completedText;
    });
    return { ...result, text: text || completedText || result.text };
  }

  async runTaskStream(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult> {
    throwIfAborted(input.abortSignal);
    if (input.requireExactWriteFence) {
      throw exactWriteFenceUnavailable(
        this.kind,
        "ACP transport 当前不会把 writableRoots 下发为可证明的精确写隔离策略。"
      );
    }
    const emitQueued = (event: AgentEvent): Promise<void> => {
      this.eventQueue = this.eventQueue.then(() => Promise.resolve(emit(event)));
      return this.eventQueue;
    };
    const emitNow = (event: Omit<AgentEvent, "backend" | "createdAt">): Promise<void> => emitQueued({
      ...event,
      backend: this.kind,
      createdAt: Date.now()
    });
    let outputText = "";
    let usage: Record<string, unknown> | undefined;
    let promptSubmitted = false;
    let sessionId = "";
    const abortActiveTransport = (): void => {
      const transport = this.transport;
      if (transport && sessionId) transport.notify(ACP_METHOD_CANDIDATES.cancel[0], { sessionId });
      void transport?.dispose().catch(swallowError(`${this.options.backend} ACP abort transport cleanup`));
      try {
        this.process?.kill();
      } catch {
        // The ACP process may already have exited.
      }
    };
    const removeInputAbort = listenForAbort(input.abortSignal, abortActiveTransport);
    const previousStartupTimeoutMs = this.startupTimeoutMs;
    this.startupTimeoutMs = startupTimeoutForTask(input.timeoutMs, this.options.requestTimeoutMs);
    this.eventQueue = Promise.resolve();
    this.resetRichEventState();
    this.activeEmit = async (event) => {
      const sourcedEvent: AgentEvent = {
        ...event,
        data: { ...event.data, streamSource: "acp" }
      };
      if (sourcedEvent.type === "message_delta") outputText += sourcedEvent.text ?? "";
      if (sourcedEvent.type === "usage") usage = sourcedEvent.data;
      await emitQueued(sourcedEvent);
    };
    try {
      await emitNow({ type: "connecting" });
      throwIfAborted(input.abortSignal);
      await this.connect();
      throwIfAborted(input.abortSignal);
      await emitNow({ type: "connected" });
      throwIfAborted(input.abortSignal);
      const session = await this.requestWithFallback("newSession", {
        cwd: this.options.command.cwd,
        mcpServers: []
      }, input.timeoutMs);
      throwIfAborted(input.abortSignal);
      sessionId = stringValue((session as any)?.sessionId ?? (session as any)?.id);
      if (!sessionId) throw new Error("ACP backend did not return a sessionId.");
      this.activeRunId = sessionId;
      input.onRunId?.(sessionId);
      await emitNow({ type: "run_started", runId: sessionId });
      throwIfAborted(input.abortSignal);
      this.deferProviderEvents = true;
      const promptRequest = this.requestWithFallback("prompt", {
        sessionId,
        prompt: buildAcpPromptBlocks(input)
      }, input.timeoutMs, () => {
        if (promptSubmitted) return;
        promptSubmitted = true;
        void emitNow({
          type: "prompt_sent",
          runId: sessionId,
          data: { streamSource: "acp", promptSubmitted: true }
        });
      });
      if (promptSubmitted) {
        await emitNow({ type: "waiting", runId: sessionId, data: { streamSource: "acp", promptSubmitted: true } });
      }
      this.deferProviderEvents = false;
      this.flushDeferredProviderEvents();
      await promptRequest;
      throwIfAborted(input.abortSignal);
      await this.eventQueue;
      throwIfAborted(input.abortSignal);
      await this.completeActiveReasoning("run_completed");
      throwIfAborted(input.abortSignal);
      const unconfirmedToolCallIds = await this.settleActiveToolCalls("unconfirmed");
      throwIfAborted(input.abortSignal);
      const terminalData = {
        ...(this.activeMessageId ? { messageId: this.activeMessageId } : {}),
        streamSource: "acp",
        promptSubmitted,
        unconfirmedToolCallCount: unconfirmedToolCallIds.length,
        ...(unconfirmedToolCallIds.length ? { unconfirmedToolCallIds } : {})
      };
      await emitNow({
        type: "completed",
        runId: sessionId,
        text: outputText,
        data: terminalData
      });
      return { text: outputText, runId: sessionId, usage, terminalData };
    } catch (error) {
      const cancelled = Boolean(input.abortSignal?.aborted);
      const normalizedError = cancelled ? createCancelledError() : error;
      const message = normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
      await this.eventQueue.catch(swallowError(`${this.options.backend} ACP event queue cleanup`));
      await this.completeActiveReasoning(cancelled ? "run_cancelled" : "run_failed");
      const interruptedToolCallIds = await this.settleActiveToolCalls("interrupted");
      await emitNow({
        type: cancelled ? "cancelled" : "failed",
        runId: this.activeRunId || undefined,
        error: message,
        data: {
          streamSource: "acp",
          promptSubmitted,
          interruptedToolCallCount: interruptedToolCallIds.length,
          ...(interruptedToolCallIds.length ? { interruptedToolCallIds } : {})
        }
      });
      if (cancelled) await this.disconnect();
      throw normalizedError;
    } finally {
      removeInputAbort();
      this.startupTimeoutMs = previousStartupTimeoutMs;
      this.activeEmit = null;
      this.activeRunId = "";
      this.resetRichEventState();
    }
  }

  async abort(runId: string): Promise<void> {
    await this.completeActiveReasoning("run_cancelled");
    await this.settleActiveToolCalls("interrupted");
    if (this.transport && runId) {
      this.transport.notify(ACP_METHOD_CANDIDATES.cancel[0], { sessionId: runId });
    }
    await this.disconnect();
  }

  private async requestWithFallback(
    logicalMethod: keyof typeof ACP_METHOD_CANDIDATES,
    params: unknown,
    timeoutMs?: number,
    onWritten?: () => void
  ): Promise<unknown> {
    const transport = this.requireTransport();
    const candidates = ACP_METHOD_CANDIDATES[logicalMethod];
    let lastError: Error | null = null;
    let written = false;
    for (const method of candidates) {
      try {
        return await transport.request(method, params, timeoutMs, () => {
          if (written) return;
          written = true;
          onWritten?.();
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!isMethodMissingError(lastError)) break;
      }
    }
    throw lastError ?? new Error(`ACP request failed: ${logicalMethod}`);
  }

  private handleSessionUpdate(params: unknown): void {
    this.processSessionUpdate(params);
  }

  private processSessionUpdate(params: unknown): void {
    const notification = plainObject(params);
    const update = plainObject(notification?.update) ?? notification;
    if (!update) return;
    const sessionId = stringValue(notification?.sessionId);
    if (this.activeRunId && sessionId && sessionId !== this.activeRunId) return;
    const events = normalizeRichStreamEvents([update], { backend: this.kind, runId: this.activeRunId || sessionId });
    for (const event of events) {
      for (const normalized of this.enrichRichEvent(event)) {
        void this.emitProviderEvent(normalized);
      }
    }
  }

  private emitProviderEvent(event: AgentEvent): Promise<void> {
    if (this.deferProviderEvents) {
      this.deferredProviderEvents.push(event);
      return Promise.resolve();
    }
    return this.activeEmit?.(event) ?? Promise.resolve();
  }

  private flushDeferredProviderEvents(): void {
    const events = this.deferredProviderEvents.splice(0);
    for (const event of events) void this.emitProviderEvent(event);
  }

  private enrichRichEvent(event: AgentEvent): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (event.type === "thinking_delta") {
      const explicitBlockId = stringValue(event.data?.blockId);
      if (this.activeReasoningBlockId && explicitBlockId && explicitBlockId !== this.activeReasoningBlockId) {
        events.push(this.reasoningBoundaryEvent("provider_block_changed", event.createdAt));
      }
      if (!this.activeReasoningBlockId) {
        this.reasoningBlockCounter += 1;
        this.activeReasoningBlockId = explicitBlockId || `${this.activeRunId || "acp"}:reasoning:${this.reasoningBlockCounter}`;
      }
      this.activeMessageId = "";
      events.push({
        ...event,
        data: {
          ...event.data,
          blockId: this.activeReasoningBlockId,
          reasoningKind: event.data?.reasoningKind ?? "provider",
          visibility: event.data?.visibility ?? "public"
        }
      });
      return events;
    }

    if (event.type === "tool_call_requested" || event.type === "permission_requested") {
      if (this.activeReasoningBlockId) events.push(this.reasoningBoundaryEvent("tool", event.createdAt));
      this.activeMessageId = "";
      const toolEvent = this.prepareToolEvent(event);
      const callId = stringValue(toolEvent.data?.callId ?? toolEvent.data?.toolCallId);
      if (callId) this.activeToolCalls.set(callId, toolEvent);
      events.push(toolEvent);
      return events;
    }

    if (event.type === "tool_call_delta" || event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      if (this.activeReasoningBlockId && (event.type === "tool_call_completed" || event.type === "tool_call_failed")) {
        events.push(this.reasoningBoundaryEvent("tool_terminal", event.createdAt));
      }
      const toolEvent = this.prepareToolEvent(event);
      const callId = stringValue(toolEvent.data?.callId ?? toolEvent.data?.toolCallId);
      const active = callId ? this.activeToolCalls.get(callId) : undefined;
      const merged = active ? mergeToolLifecycleEvent(active, toolEvent) : toolEvent;
      if (callId) {
        if (event.type === "tool_call_completed" || event.type === "tool_call_failed") this.activeToolCalls.delete(callId);
        else this.activeToolCalls.set(callId, merged);
      }
      events.push(merged);
      return events;
    }

    if (event.type === "message_delta" || event.type === "message_completed") {
      if (this.activeReasoningBlockId) events.push(this.reasoningBoundaryEvent("message", event.createdAt));
      const explicitMessageId = stringValue(event.data?.messageId);
      if (!this.activeMessageId || (explicitMessageId && explicitMessageId !== this.activeMessageId)) {
        this.messageCounter += 1;
        this.activeMessageId = explicitMessageId || `${this.activeRunId || "acp"}:message:${this.messageCounter}`;
      }
      events.push({
        ...event,
        data: { ...event.data, messageId: this.activeMessageId }
      });
      return events;
    }

    events.push(event);
    return events;
  }

  private prepareToolEvent(event: AgentEvent): AgentEvent {
    const explicitCallId = stringValue(event.data?.callId ?? event.data?.toolCallId);
    let callId = explicitCallId;
    if (!callId) {
      this.toolCallCounter += 1;
      callId = `${this.activeRunId || "acp"}:tool:${this.toolCallCounter}`;
    }
    return {
      ...event,
      data: {
        ...event.data,
        toolCallId: callId,
        callId,
        ...(event.status ? { status: event.status, toolStatus: event.status } : {})
      }
    };
  }

  private reasoningBoundaryEvent(boundary: string, createdAt = Date.now()): AgentEvent {
    const blockId = this.activeReasoningBlockId;
    this.activeReasoningBlockId = "";
    return {
      type: "thinking_completed",
      backend: this.kind,
      createdAt,
      runId: this.activeRunId || undefined,
      data: {
        blockId,
        reasoningKind: "provider",
        visibility: "public",
        boundary
      }
    };
  }

  private async completeActiveReasoning(boundary: string): Promise<void> {
    if (!this.activeReasoningBlockId || !this.activeEmit) return;
    await this.activeEmit(this.reasoningBoundaryEvent(boundary));
  }

  private async settleActiveToolCalls(status: "unconfirmed" | "interrupted"): Promise<string[]> {
    const active = [...this.activeToolCalls.entries()];
    this.activeToolCalls.clear();
    if (!this.activeEmit) return active.map(([callId]) => callId);
    for (const [callId, previous] of active) {
      await this.activeEmit({
        ...previous,
        type: "tool_call_delta",
        createdAt: Date.now(),
        status,
        data: {
          ...previous.data,
          toolCallId: callId,
          callId,
          status,
          toolStatus: status,
          completionState: status
        }
      });
    }
    return active.map(([callId]) => callId);
  }

  private resetRichEventState(): void {
    this.reasoningBlockCounter = 0;
    this.activeReasoningBlockId = "";
    this.messageCounter = 0;
    this.activeMessageId = "";
    this.toolCallCounter = 0;
    this.activeToolCalls.clear();
    this.deferProviderEvents = false;
    this.deferredProviderEvents.length = 0;
  }

  private async handlePermissionRequest(params: unknown): Promise<unknown> {
    const request = plainObject(params);
    const toolCall = plainObject(request?.toolCall);
    const toolName = stringValue(toolCall?.title ?? toolCall?.name ?? toolCall?.kind) || "tool";
    const explicitCallId = stringValue(
      toolCall?.toolCallId
      ?? toolCall?.callId
      ?? toolCall?.id
      ?? request?.toolCallId
      ?? request?.callId
    );
    const input = firstPresentValue(toolCall, ["rawInput", "input", "arguments"]);
    const inputState = contentAvailability(input.present, input.value);
    const permissionEvent: AgentEvent = {
      type: "permission_requested",
      backend: this.kind,
      createdAt: Date.now(),
      runId: this.activeRunId || stringValue(request?.sessionId),
      toolName,
      status: "approval",
      data: {
        ...(request ? { request } : {}),
        ...(explicitCallId ? { callId: explicitCallId, toolCallId: explicitCallId } : {}),
        semanticKind: semanticKindForAcpTool(stringValue(toolCall?.kind), toolName),
        toolStatus: "approval",
        inputState,
        outputState: "unavailable",
        ...(inputState !== "unavailable" ? { input: input.value } : {}),
        displayPreview: toolName
      }
    };
    let callId = explicitCallId;
    for (const event of this.enrichRichEvent(permissionEvent)) {
      callId = callId || stringValue(event.data?.callId);
      await this.emitProviderEvent(event);
    }
    const deniedEvent: AgentEvent = {
      type: "tool_call_failed",
      backend: this.kind,
      createdAt: Date.now(),
      runId: this.activeRunId || stringValue(request?.sessionId),
      toolName,
      status: "denied",
      error: "EchoInk 未批准该工具调用。",
      data: {
        ...permissionEvent.data,
        ...(callId ? { callId, toolCallId: callId } : {}),
        toolStatus: "denied",
        completionState: "denied"
      }
    };
    for (const event of this.enrichRichEvent(deniedEvent)) await this.emitProviderEvent(event);
    return { outcome: { outcome: "cancelled" } };
  }

  private requireTransport(): AcpJsonRpcProcessTransport {
    if (!this.transport) throw new Error("ACP runtime is not connected.");
    return this.transport;
  }
}

class AcpJsonRpcProcessTransport extends JsonRpcStdioTransport {
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private readonly acpProcess: AcpSubprocessLike, defaultTimeoutMs: number) {
    super({
      defaultTimeoutMs,
      closedMessage: "ACP transport is closed.",
      disposeMessage: "ACP transport closed.",
      timeoutMessage: (method) => `ACP request timed out: ${method}`,
      exitMessage: (code) => `ACP process exited with code ${code ?? "unknown"}`,
      killOnDispose: false
    });
    this.start();
  }

  onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    const current = this.notificationHandlers.get(method) ?? new Set();
    current.add(handler);
    this.notificationHandlers.set(method, current);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  protected createProcess(): JsonRpcProcessLike {
    return this.acpProcess;
  }

  async dispose(): Promise<void> {
    await super.dispose();
  }

  protected handleMessage(message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined) {
      void this.handleRequest(message);
      return;
    }
    if (message.method) {
      void this.handleNotification(message);
      return;
    }
  }

  protected formatResponseError(message: JsonRpcMessage, pending: { method: string }): Error {
    return new AcpJsonRpcError(pending.method, Number(message.error?.code ?? 0), String(message.error?.message ?? "ACP request failed"), message.error?.data);
  }

  private async handleNotification(message: JsonRpcMessage): Promise<void> {
    const handlers = this.notificationHandlers.get(message.method ?? "");
    if (!handlers) return;
    for (const handler of handlers) await handler(message.params);
  }

  private async handleRequest(message: JsonRpcMessage): Promise<void> {
    const method = message.method ?? "";
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported ACP request: ${method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

}

class AcpJsonRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "AcpJsonRpcError";
  }
}

function buildAcpPromptBlocks(input: AgentTaskInput): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{
    type: "text",
    text: withResourcePrefix(input.prompt, input.resources?.promptPrefix, input.resources?.warnings, input.system)
  }];
  for (const source of input.sources ?? []) blocks.push(acpBlockFromPart(source));
  return blocks;
}

function acpBlockFromPart(part: AgentPromptPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "text", text: `[file] ${part.path}` };
}

function withResourcePrefix(prompt: string, prefix = "", warnings: string[] = [], system = ""): string {
  return [
    system ? `## System instructions\n${system}` : "",
    prefix,
    warnings.length ? `资源提示：\n${warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

function defaultAcpProcessFactory(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): AcpSubprocessLike {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function resolveCommandValue(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

function resolveArgsValue(value: string[] | (() => string[]) | undefined): string[] {
  return typeof value === "function" ? value() : [...(value ?? [])];
}

function isMethodMissingError(error: Error): boolean {
  return error instanceof AcpJsonRpcError && (error.code === -32601 || /method|not found|unsupported/i.test(error.message));
}

function startupTimeoutForTask(taskTimeoutMs: number | undefined, configuredTimeoutMs: number | undefined): number {
  const ceiling = configuredTimeoutMs ?? DEFAULT_ACP_STARTUP_TIMEOUT_MS;
  if (!taskTimeoutMs || !Number.isFinite(taskTimeoutMs)) return Math.min(ceiling, DEFAULT_ACP_STARTUP_TIMEOUT_MS);
  return Math.max(1, Math.min(ceiling, Math.floor(taskTimeoutMs / 4)));
}

function listenForAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createCancelledError();
}

function createCancelledError(): Error {
  const error = new Error("Agent 任务已取消。");
  error.name = "AbortError";
  return error;
}

function mergeToolLifecycleEvent(previous: AgentEvent, current: AgentEvent): AgentEvent {
  const previousData = previous.data ?? {};
  const currentData = current.data ?? {};
  const data: Record<string, unknown> = { ...previousData, ...currentData };
  preserveAvailableChannel(previousData, currentData, data, "input", "inputState");
  preserveAvailableChannel(previousData, currentData, data, "rawInput", "rawInputState");
  preserveAvailableChannel(previousData, currentData, data, "output", "outputState");
  preserveAvailableChannel(previousData, currentData, data, "rawOutput", "rawOutputState");
  if (!currentData.providerKind && previousData.semanticKind) data.semanticKind = previousData.semanticKind;
  return {
    ...previous,
    ...current,
    toolName: current.toolName ?? previous.toolName,
    resourceId: current.resourceId ?? previous.resourceId,
    data
  };
}

function preserveAvailableChannel(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  target: Record<string, unknown>,
  valueKey: string,
  stateKey: string
): void {
  if (current[stateKey] !== "unavailable" || previous[stateKey] === undefined || previous[stateKey] === "unavailable") return;
  target[stateKey] = previous[stateKey];
  if (Object.prototype.hasOwnProperty.call(previous, valueKey)) target[valueKey] = previous[valueKey];
  else delete target[valueKey];
}

function firstPresentValue(
  value: Record<string, unknown> | null,
  keys: string[]
): { present: boolean; value: unknown } {
  if (!value) return { present: false, value: undefined };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return { present: true, value: value[key] };
  }
  return { present: false, value: undefined };
}

function contentAvailability(present: boolean, value: unknown): "provided" | "empty" | "unavailable" {
  if (!present || value === null || value === undefined) return "unavailable";
  if (value === "") return "empty";
  if (Array.isArray(value) && value.length === 0) return "empty";
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return "empty";
  return "provided";
}

function semanticKindForAcpTool(kind: string, toolName: string): "read" | "search" | "command" | "edit" | "mcp" | "agent" | "plan" | "tool" {
  const value = `${kind} ${toolName}`.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (/(^|_)(read|open|view|cat)(_|$)/.test(value)) return "read";
  if (/(^|_)(search|find|grep|glob|fetch)(_|$)/.test(value)) return "search";
  if (/(^|_)(command|execute|terminal|shell|bash|run)(_|$)/.test(value)) return "command";
  if (/(^|_)(edit|write|delete|move|patch)(_|$)/.test(value)) return "edit";
  if (/(^|_)(mcp)(_|$)/.test(value)) return "mcp";
  if (/(^|_)(agent|delegate|task)(_|$)/.test(value)) return "agent";
  if (/(^|_)(plan|think|todo)(_|$)/.test(value)) return "plan";
  return "tool";
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
