import type { TurnOptions } from "../../../core/codex-service";
import {
  buildEchoInkToolLoopExceededError,
  buildEchoInkToolResultTurnPrompt,
  parseEchoInkToolCall,
  truncateEchoInkToolResult,
  type EchoInkToolCallRequest
} from "../../../agent/tool-bridge";
import type { AgentToolBridgeRuntime } from "../../../agent/runtime";
import type { UserInput } from "../../../types/app-server";
import { noCapabilities } from "../../contracts/capability";
import type { HarnessEventSink, HarnessEventType } from "../../contracts/event";
import type { NativeExecutionDispositionRequest, NativeExecutionDispositionResult, NativeExecutionRef } from "../../contracts/native-execution";
import type {
  AgentAdapter,
  AgentConnectContext,
  AgentConnectionStatus,
  AgentManifest,
  AgentNativeSessionPreparationRequest,
  AgentNativeSessionPreparationResult,
  AgentRunRequest,
  AgentRunResult,
  NativeResourceSnapshot
} from "../adapter";
import type { CodexRichArtifactRecoveryInput } from "./codex-rich-driver";
import { CodexRichRunDriver } from "./codex-rich-driver";
import { CodexRichNotificationHub } from "./codex-rich-notification-hub";

export interface CodexRichAgentAdapterOptions {
  displayName: string;
  version: string;
  turnOptions?: TurnOptions;
  getNativeThreadId(): string | undefined;
  setNativeThreadId(threadId: string): void;
  buildInput(threadId: string, request: AgentRunRequest): UserInput[] | Promise<UserInput[]>;
  startThread(options?: TurnOptions): Promise<{ threadId: string; title: string }>;
  resumeThread(threadId: string, options?: TurnOptions): Promise<void>;
  startTurn(threadId: string, input: UserInput[], options?: TurnOptions): Promise<string>;
  interruptTurn?(threadId: string, turnId: string): Promise<void>;
  archiveThread?(threadId: string): Promise<void>;
  nativeRefContext?: {
    deviceKey: string;
    vaultId: string;
    providerEndpoint?: string;
  };
  nativeResources?: NativeResourceSnapshot["resources"] | (() => Promise<NativeResourceSnapshot["resources"]> | NativeResourceSnapshot["resources"]);
  onTurnStarted?(ids: { threadId: string; turnId: string }): void;
  notificationHub?: CodexRichNotificationHub;
  toolBridge?: AgentToolBridgeRuntime | null;
  artifactRecovery?: (input: CodexRichArtifactRecoveryInput) => Promise<string | null>;
  inactivityTimeoutMs?: number;
  finalAnswerGraceMs?: number;
}

export class CodexRichAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  private preparedThreadId = "";
  private readonly runs = new Map<string, CodexRunState>();

  constructor(private readonly options: CodexRichAgentAdapterOptions) {
    this.manifest = {
      id: "codex-cli",
      displayName: options.displayName,
      version: options.version,
      capabilities: {
        ...noCapabilities(),
        sessions: { resume: "native", fork: "none" },
        output: { streaming: "native", reasoningSummary: "native", thinkingTrace: "none", planEvents: "native", usage: "native" },
        tools: { structuredCalls: "none", nativeMcp: "native", nativeSkills: "native", approvals: "native" },
        files: { read: "native", write: "native", diffEvents: "native" },
        input: { text: "native", image: "native", pdf: "native" },
        cancellation: "native"
      },
      nativeExecution: {
        persistence: "provider-persistent",
        dispositions: {
          processExit: false,
          archive: typeof options.archiveThread === "function",
          delete: false
        },
        idempotentDisposition: true,
        canInspectExistence: false
      }
    };
  }

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    return {
      connected: true,
      label: this.manifest.displayName,
      version: this.manifest.version,
      errors: []
    };
  }

  async dispose(): Promise<void> {
    const activeStates = Array.from(this.runs.values());
    if (!activeStates.length) return;

    const settlements = activeStates.map(async (state) => {
      this.signalRunCancellation(state);
      await state.driver.cancel().catch(() => undefined);
      this.options.notificationHub?.unregister(state.runId);
      return await state.driver.awaitResult();
    });

    this.runs.clear();
    await Promise.all(settlements);
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  async prepareNativeSession(request: AgentNativeSessionPreparationRequest): Promise<AgentNativeSessionPreparationResult> {
    const existing = this.options.getNativeThreadId()?.trim();
    this.preparedThreadId = "";
    if (!existing || request.action === "none") return { status: "not-applicable" };
    if (request.action === "reset") {
      this.options.setNativeThreadId("");
      return { status: "reset", nativeExecutionId: existing };
    }
    try {
      await this.options.resumeThread(existing, this.options.turnOptions);
      this.preparedThreadId = existing;
      return { status: "resumed", nativeExecutionId: existing };
    } catch (error) {
      this.options.setNativeThreadId("");
      return {
        status: "failed",
        nativeExecutionId: existing,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listNativeResources(): Promise<NativeResourceSnapshot> {
    const resources = typeof this.options.nativeResources === "function"
      ? await this.options.nativeResources()
      : this.options.nativeResources ?? [];
    return {
      backendId: this.manifest.id,
      resources,
      capturedAt: Date.now()
    };
  }

  async disposeNativeExecution(request: NativeExecutionDispositionRequest): Promise<NativeExecutionDispositionResult> {
    if (request.ref.backendId !== this.manifest.id || request.ref.kind !== "thread") {
      return {
        outcome: "retained",
        message: "Native execution does not belong to Codex thread adapter"
      };
    }
    if (request.requested !== "archive") {
      return {
        outcome: "unsupported",
        message: `Codex adapter does not support ${request.requested}`
      };
    }
    const contextMismatch = nativeRefContextMismatch(request.ref, this.options.nativeRefContext);
    if (contextMismatch) return { outcome: "retained", message: contextMismatch };
    if (!this.options.archiveThread) {
      return {
        outcome: "unsupported",
        message: "Codex archive is unavailable"
      };
    }
    await this.options.archiveThread(request.ref.id);
    return {
      outcome: "disposed",
      applied: "archive"
    };
  }

  async run(request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
    const driver = this.createDriver(request.runId, emit);
    const state: CodexRunState = {
      runId: request.runId,
      threadId: "",
      cancelRequested: false,
      cancelGate: new CodexRunCancellationGate(),
      driver,
      emit,
      toolCallCount: 0
    };
    this.runs.set(request.runId, state);
    this.options.notificationHub?.register(driver);
    try {
      const threadId = await this.ensureThread();
      state.threadId = threadId;
      driver.setThreadId(threadId);
      const input = await this.buildInitialTurnInput(threadId, request);
      if (state.cancelRequested) {
        this.runs.delete(request.runId);
        this.options.notificationHub?.unregister(request.runId);
        return {
          status: "cancelled",
          error: "Run cancelled",
          nativeExecution: this.buildNativeExecutionRef(threadId),
          nativeThreadId: threadId
        };
      }
      const turnId = await this.options.startTurn(threadId, input, this.options.turnOptions);
      state.turnId = turnId;
      driver.setTurnId(turnId);
      this.options.onTurnStarted?.({ threadId, turnId });
      await emit({
        eventId: "",
        runId: request.runId,
        sequence: 0,
        createdAt: 0,
        source: "agent",
        type: "agent.connected",
        backendId: this.manifest.id,
        data: { status: "turn-started" }
      });
      if (state.cancelRequested) {
        try {
          await driver.cancel();
          return this.finalizeRunState(state, this.buildCancelledResult(state));
        } catch {
          return {
            status: "running",
            nativeExecution: this.buildNativeExecutionRef(threadId),
            nativeThreadId: threadId,
            nativeSessionId: turnId
          };
        }
      }
      return {
        status: "running",
        nativeExecution: this.buildNativeExecutionRef(threadId),
        nativeThreadId: threadId,
        nativeSessionId: turnId
      };
    } catch (error) {
      this.runs.delete(request.runId);
      this.options.notificationHub?.unregister(request.runId);
      throw error;
    }
  }

  async cancel(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) return;
    this.signalRunCancellation(state);
    if (!state.threadId || !state.turnId) return;
    await state.driver.cancel();
  }

  async awaitResult(runId: string): Promise<AgentRunResult> {
    const state = this.runs.get(runId);
    if (!state) throw new Error(`Unknown Codex run: ${runId}`);
    if (!state.resultPromise) {
      state.resultPromise = this.awaitResultLoop(state);
    }
    try {
      return await state.resultPromise;
    } finally {
      this.releaseRunState(state);
    }
  }

  private createDriver(runId: string, emit: HarnessEventSink): CodexRichRunDriver {
    return new CodexRichRunDriver({
      runId,
      backendId: this.manifest.id,
      emit,
      interruptTurn: this.options.interruptTurn,
      inactivityTimeoutMs: this.options.inactivityTimeoutMs,
      finalAnswerGraceMs: this.options.finalAnswerGraceMs,
      artifactRecovery: this.options.artifactRecovery,
      onSettled: async () => {
        this.options.notificationHub?.unregister(runId);
      }
    });
  }

  private async awaitResultLoop(state: CodexRunState): Promise<AgentRunResult> {
    try {
      while (true) {
        const turnResult = await state.driver.awaitResult();
        if (turnResult.status !== "completed") {
          return this.finalizeRunState(state, turnResult);
        }
        const bridgeRequest = this.readToolBridgeRequest(turnResult.outputText);
        if (!bridgeRequest) {
          return this.finalizeRunState(state, turnResult);
        }
        const bridgedResult = await this.continueWithEchoInkToolBridge(state, bridgeRequest);
        if (bridgedResult) return bridgedResult;
      }
    } catch (error) {
      return this.finalizeRunState(state, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private readToolBridgeRequest(outputText: string | undefined): EchoInkToolCallRequest | null {
    if (!this.hasActiveToolBridge()) return null;
    return parseEchoInkToolCall(outputText ?? "");
  }

  private async continueWithEchoInkToolBridge(
    state: CodexRunState,
    request: EchoInkToolCallRequest
  ): Promise<AgentRunResult | null> {
    const bridge = this.options.toolBridge;
    if (!bridge) return null;
    if (state.cancelRequested) return this.finalizeRunState(state, this.buildCancelledResult(state));
    if (state.toolCallCount >= bridge.maxToolCalls) {
      const error = buildEchoInkToolLoopExceededError(bridge.maxToolCalls);
      await this.emitToolEvent(state, "tool.failed", request.tool, bridge.toolResourceIds?.[request.tool], error, {
        toolCallId: buildToolCallId(state.runId, state.toolCallCount),
        input: request.arguments
      });
      return this.finalizeRunState(state, { status: "failed", error });
    }

    const toolCallId = buildToolCallId(state.runId, state.toolCallCount);
    const resourceId = bridge.toolResourceIds?.[request.tool];
    await this.emitToolEvent(state, "tool.requested", request.tool, resourceId, undefined, {
      toolCallId,
      input: request.arguments
    });
    if (resourceId) {
      await this.emitToolEvent(state, "tool.approval.requested", request.tool, resourceId, undefined, {
        toolCallId,
        input: request.arguments
      });
    }

    try {
      const bridgeCall: Promise<BridgeCallOutcome> = bridge.callTool({
        tool: request.tool,
        arguments: request.arguments,
        scope: bridge.scope,
        backend: "codex-cli",
        signal: state.cancelGate.abortSignal
      }).then(
        (value) => ({ status: "completed", value } as const),
        (error) => ({ status: "failed", error } as const)
      );
      const outcome = await Promise.race<BridgeCallOutcome>([
        bridgeCall,
        state.cancelGate.promise.then(() => ({ status: "cancelled" }))
      ]);
      if (outcome.status === "cancelled" || state.cancelGate.signalled) {
        return this.finalizeRunState(state, this.buildCancelledResult(state));
      }
      if (outcome.status === "failed") throw outcome.error;
      const output = truncateEchoInkToolResult(outcome.value);
      await this.emitToolEvent(state, "tool.completed", request.tool, resourceId, undefined, {
        toolCallId,
        input: request.arguments,
        output
      }, output);
      state.toolCallCount += 1;
      if (state.cancelRequested) return this.finalizeRunState(state, this.buildCancelledResult(state));
      const started = await this.startFollowUpTurn(state, request, output);
      if (!started) return this.finalizeRunState(state, this.buildCancelledResult(state));
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emitToolEvent(state, "tool.failed", request.tool, resourceId, message, {
        toolCallId,
        input: request.arguments
      });
      return this.finalizeRunState(state, { status: "failed", error: message });
    }
  }

  private async startFollowUpTurn(
    state: CodexRunState,
    request: EchoInkToolCallRequest,
    output: string
  ): Promise<boolean> {
    const driver = this.createDriver(state.runId, state.emit);
    state.driver = driver;
    state.turnId = undefined;
    this.options.notificationHub?.register(driver);
    driver.setThreadId(state.threadId);
    if (state.cancelRequested) {
      this.options.notificationHub?.unregister(state.runId);
      return false;
    }
    try {
      const turnId = await this.options.startTurn(
        state.threadId,
        [textUserInput(buildEchoInkToolResultTurnPrompt(request, output))],
        this.options.turnOptions
      );
      state.turnId = turnId;
      driver.setTurnId(turnId);
      this.options.onTurnStarted?.({ threadId: state.threadId, turnId });
      if (!state.cancelRequested) return true;
      try {
        await driver.cancel();
      } catch {
        // Keep the run cancellable without hanging on a late interrupt failure.
      }
      return false;
    } catch (error) {
      this.options.notificationHub?.unregister(state.runId);
      throw error;
    }
  }

  private finalizeRunState(state: CodexRunState, result: AgentRunResult): AgentRunResult {
    const finalized: AgentRunResult = {
      ...result,
      nativeExecution: result.nativeExecution ?? (state.threadId ? this.buildNativeExecutionRef(state.threadId) : undefined),
      nativeThreadId: result.nativeThreadId ?? (state.threadId || undefined),
      nativeSessionId: result.nativeSessionId ?? state.turnId
    };
    return finalized;
  }

  private releaseRunState(state: CodexRunState): void {
    if (this.runs.get(state.runId) === state) {
      this.runs.delete(state.runId);
    }
  }

  private signalRunCancellation(state: CodexRunState): void {
    state.cancelRequested = true;
    state.cancelGate.signal();
    state.driver.requestCancel();
  }

  private buildCancelledResult(state: CodexRunState): AgentRunResult {
    return {
      status: "cancelled",
      error: "Run cancelled",
      nativeExecution: state.threadId ? this.buildNativeExecutionRef(state.threadId) : undefined,
      nativeThreadId: state.threadId || undefined,
      nativeSessionId: state.turnId
    };
  }

  private async buildInitialTurnInput(threadId: string, request: AgentRunRequest): Promise<UserInput[]> {
    const input = this.injectEchoInkContext(
      await this.options.buildInput(threadId, request),
      request
    );
    return this.injectToolBridgePrompt(input);
  }

  private async ensureThread(): Promise<string> {
    if (this.preparedThreadId) {
      const prepared = this.preparedThreadId;
      this.preparedThreadId = "";
      return prepared;
    }
    const existing = this.options.getNativeThreadId()?.trim();
    if (existing) {
      try {
        await this.options.resumeThread(existing, this.options.turnOptions);
        return existing;
      } catch {
        // Fall through and create a replacement thread.
      }
    }
    const started = await this.options.startThread(this.options.turnOptions);
    this.options.setNativeThreadId(started.threadId);
    return started.threadId;
  }

  private buildNativeExecutionRef(threadId: string): NativeExecutionRef | undefined {
    const context = this.options.nativeRefContext;
    if (!context) return undefined;
    return {
      backendId: this.manifest.id,
      id: threadId,
      kind: "thread",
      persistence: this.options.turnOptions?.ephemeral ? "none" : "provider-persistent",
      providerEndpoint: context.providerEndpoint,
      deviceKey: context.deviceKey,
      vaultId: context.vaultId,
      createdAt: Date.now()
    };
  }

  private injectEchoInkContext(input: UserInput[], request: AgentRunRequest): UserInput[] {
    const context = this.buildEchoInkContextInput(input, request);
    if (!context) return input;
    return [context, ...input];
  }

  private injectToolBridgePrompt(input: UserInput[]): UserInput[] {
    if (!this.hasActiveToolBridge()) return input;
    return [textUserInput(this.options.toolBridge!.prompt.trim()), ...input];
  }

  private buildEchoInkContextInput(input: UserInput[], request: AgentRunRequest): UserInput | null {
    const sessionSections = request.context.sessionContext
      .map((section) => this.sanitizeSessionContextSection(section.content, input, request))
      .filter((content) => content.length > 0);
    const memorySections = request.context.memoryContext
      .map((section) => section.content.trim())
      .filter(Boolean);
    if (!sessionSections.length && !memorySections.length) return null;
    const sections = [
      sessionSections.length ? `[EchoInk Session Context]\n${sessionSections.join("\n\n")}` : "",
      memorySections.length
        ? `[EchoInk Long-term Memory]\nThe following items were retrieved and injected by EchoInk. Use them as context without searching local files.\n${memorySections.map((item) => `- ${item}`).join("\n")}`
        : ""
    ].filter(Boolean);
    return {
      type: "text",
      text: sections.join("\n\n"),
      text_elements: []
    };
  }

  private sanitizeSessionContextSection(section: string, input: UserInput[], request: AgentRunRequest): string {
    const lines = section
      .split("\n")
      .map((line) => line.trimEnd());
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    const currentTexts = [
      request.input.text,
      ...input
        .filter((entry): entry is UserInput & { type: "text"; text: string } => entry.type === "text" && typeof entry.text === "string")
        .map((entry) => entry.text)
    ];
    const duplicateIndex = findLastDuplicateCurrentUserLine(lines, currentTexts);
    if (duplicateIndex >= 0) lines.splice(duplicateIndex, 1);
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n").trim();
  }

  private hasActiveToolBridge(): boolean {
    return Boolean(this.options.toolBridge?.enabled && this.options.toolBridge.prompt.trim() && this.options.toolBridge.maxToolCalls > 0);
  }

  private async emitToolEvent(
    state: CodexRunState,
    type: HarnessEventType,
    toolName: string,
    resourceId?: string,
    error?: string,
    data?: Record<string, unknown>,
    text?: string
  ): Promise<void> {
    await state.emit({
      eventId: "",
      runId: state.runId,
      sequence: 0,
      createdAt: Date.now(),
      source: "tool",
      type,
      backendId: this.manifest.id,
      toolName,
      resourceId,
      error,
      text,
      data
    });
  }
}

function nativeRefContextMismatch(
  ref: NativeExecutionRef,
  context?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">
): string {
  if (!context) return "Native execution context is unavailable";
  if (ref.deviceKey !== context.deviceKey) return "Native execution belongs to another device";
  if (ref.vaultId !== context.vaultId) return "Native execution belongs to another Vault";
  if ((ref.providerEndpoint ?? "") !== (context.providerEndpoint ?? "")) return "Native execution belongs to another provider endpoint";
  return "";
}

interface CodexRunState {
  runId: string;
  threadId: string;
  turnId?: string;
  cancelRequested: boolean;
  cancelGate: CodexRunCancellationGate;
  driver: CodexRichRunDriver;
  emit: HarnessEventSink;
  toolCallCount: number;
  resultPromise?: Promise<AgentRunResult>;
}

type BridgeCallOutcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

class CodexRunCancellationGate {
  signalled = false;
  readonly promise: Promise<void>;
  readonly abortSignal: AbortSignal;
  private resolve!: () => void;
  private readonly abortController = new AbortController();

  constructor() {
    this.abortSignal = this.abortController.signal;
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  signal(): void {
    if (this.signalled) return;
    this.signalled = true;
    this.abortController.abort(new Error("Run cancelled"));
    this.resolve();
  }
}

function compactContextText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findLastDuplicateCurrentUserLine(lines: string[], currentTexts: string[]): number {
  const normalizedCurrentTexts = currentTexts.map(compactContextText).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^user:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const lineUserText = compactContextText(match[1] ?? "");
    if (!lineUserText) continue;
    const duplicatesCurrentTurn = normalizedCurrentTexts.includes(lineUserText);
    if (duplicatesCurrentTurn) return index;
  }
  return -1;
}

function textUserInput(text: string): UserInput {
  return {
    type: "text",
    text,
    text_elements: []
  };
}

function buildToolCallId(runId: string, index: number): string {
  return `${runId}-echoink-tool-${index + 1}`;
}
