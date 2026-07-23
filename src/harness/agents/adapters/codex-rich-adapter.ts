import type { TurnOptions } from "../../../core/codex-service";
import {
  buildEchoInkToolLoopExceededError,
  buildEchoInkToolResultTurnPrompt,
  classifyEchoInkToolCallCandidate,
  parseExactEchoInkToolCall,
  truncateEchoInkToolResult,
  type EchoInkToolCallRequest
} from "../../../agent/tool-bridge";
import type { AgentToolBridgeRuntime } from "../../../agent/runtime";
import {
  NativeRunRegistrationError,
  type AgentExactWriteFenceContext,
  type AgentExactWriteFenceReceipt,
  type AgentTaskInput
} from "../../../agent/types";
import {
  assertExactWriteFenceRequest,
  createExactWriteFenceReceipt,
  deliverExactWriteFenceReceipt
} from "../../../agent/write-fence";
import type { UserInput } from "../../../types/app-server";
import { noCapabilities } from "../../contracts/capability";
import type { HarnessEvent, HarnessEventSink, HarnessEventType } from "../../contracts/event";
import type { NativeExecutionDispositionRequest, NativeExecutionDispositionResult, NativeExecutionRef } from "../../contracts/native-execution";
import {
  AgentNativeSessionStaleError,
  type AgentAdapter,
  type AgentConnectContext,
  type AgentConnectionStatus,
  type AgentManifest,
  type AgentNativeSessionPreparationRequest,
  type AgentNativeSessionPreparationResult,
  type AgentRunRequest,
  type AgentRunResult,
  type NativeResourceSnapshot
} from "../adapter";
import type { CodexRichArtifactRecoveryInput } from "./codex-rich-driver";
import { CodexRichRunDriver } from "./codex-rich-driver";
import { CodexRichNotificationHub } from "./codex-rich-notification-hub";

export interface CodexRichAgentAdapterOptions {
  displayName: string;
  version: string;
  turnOptions?: TurnOptions;
  ensureConnected?(context: AgentConnectContext): Promise<AgentConnectionStatus>;
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
  requireExactWriteFence?: boolean;
  exactWriteFence?: AgentExactWriteFenceContext;
  onExactWriteFenceConfigured?: AgentTaskInput["onExactWriteFenceConfigured"];
}

export class CodexRichAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
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

  async connect(context: AgentConnectContext): Promise<AgentConnectionStatus> {
    if (this.options.ensureConnected) {
      return await this.options.ensureConnected(context);
    }
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
      if (!state.resultPromise) state.resultPromise = this.awaitLogicalResult(state);
      await state.driver.cancel().catch(() => undefined);
      this.options.notificationHub?.unregister(state.runId);
      return await state.resultPromise;
    });

    this.runs.clear();
    await Promise.all(settlements);
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [];
  }

  async prepareNativeSession(request: AgentNativeSessionPreparationRequest): Promise<AgentNativeSessionPreparationResult> {
    if (request.action === "none") return { status: "not-applicable" };
    const bindingThreadId = request.binding?.nativeThreadId?.trim()
      || (
        request.binding?.nativeExecutionRef?.kind === "thread"
          ? request.binding.nativeExecutionRef.id.trim()
          : ""
      );
    const existing = bindingThreadId || this.options.getNativeThreadId()?.trim();
    if (!existing) return { status: "not-applicable" };
    if (request.action === "reset") {
      return { status: "reset", nativeExecutionId: existing };
    }
    try {
      await this.options.resumeThread(existing, this.options.turnOptions);
      return { status: "resumed", nativeExecutionId: existing };
    } catch (error) {
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
    const isolateNativeThread = request.context.manifest?.mode === "workflow";
    const terminalGate: CodexRunTerminalGate = { emitted: false };
    const driver = this.createDriver(request.runId, emit, terminalGate);
    const state: CodexRunState = {
      runId: request.runId,
      threadId: "",
      cancelRequested: false,
      cancelGate: new CodexRunCancellationGate(),
      driver,
      emit,
      terminalGate,
      toolCallCount: 0,
      turnOptions: this.turnOptionsForRequest(request),
      isolateNativeThread,
      nativeBindingManagedByHarness: request.nativeBindingManagedByHarness === true
    };
    this.runs.set(request.runId, state);
    this.options.notificationHub?.register(driver);
    try {
      const ensured = await this.ensureThread(request, state.turnOptions, state.isolateNativeThread);
      let threadId = ensured.threadId;
      state.threadId = threadId;
      state.threadWasCreated = ensured.created;
      driver.setThreadId(threadId);
      await this.registerThreadBeforePrompt(request, state);
      state.exactWriteFenceReceipt = await this.configureExactWriteFence(request, state.turnOptions, threadId);
      let input = await this.buildInitialTurnInput(threadId, request);
      if (state.cancelRequested) {
        this.runs.delete(request.runId);
        this.options.notificationHub?.unregister(request.runId);
        return {
          status: "cancelled",
          error: "Run cancelled",
          nativeExecution: this.buildNativeExecutionRef(threadId, state),
          nativeThreadId: threadId
        };
      }
      let turnId: string;
      try {
        turnId = await this.options.startTurn(threadId, input, state.turnOptions);
      } catch (error) {
        if (!isMissingCodexThreadError(error) || state.cancelRequested) throw error;
        if (state.nativeBindingManagedByHarness && !state.isolateNativeThread) {
          throw new AgentNativeSessionStaleError(
            `Codex Native thread became stale before prompt submission: ${threadId}`,
            threadId,
            error
          );
        }
        if (!state.isolateNativeThread) this.options.setNativeThreadId("");
        const replacement = await this.options.startThread(state.turnOptions);
        threadId = replacement.threadId;
        if (!state.isolateNativeThread) this.options.setNativeThreadId(threadId);
        state.threadId = threadId;
        state.threadWasCreated = true;
        driver.setThreadId(threadId);
        await this.registerThreadBeforePrompt(request, state);
        state.exactWriteFenceReceipt = await this.configureExactWriteFence(request, state.turnOptions, threadId);
        input = await this.buildInitialTurnInput(threadId, request);
        if (state.cancelRequested) {
          this.runs.delete(request.runId);
          this.options.notificationHub?.unregister(request.runId);
          return {
            status: "cancelled",
            error: "Run cancelled",
            nativeExecution: this.buildNativeExecutionRef(threadId, state),
            nativeThreadId: threadId
          };
        }
        turnId = await this.options.startTurn(threadId, input, state.turnOptions);
      }
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
            nativeExecution: this.buildNativeExecutionRef(threadId, state),
            nativeThreadId: threadId,
            nativeSessionId: turnId
          };
        }
      }
      return {
        status: "running",
        nativeExecution: this.buildNativeExecutionRef(threadId, state),
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
      state.resultPromise = this.awaitLogicalResult(state);
    }
    try {
      return await state.resultPromise;
    } finally {
      this.releaseRunState(state);
    }
  }

  private createDriver(
    runId: string,
    emit: HarnessEventSink,
    terminalGate: CodexRunTerminalGate
  ): CodexRichRunDriver {
    const bufferedMessageEvents: HarnessEvent[] = [];
    let bufferedMessageText = "";
    let messagePrefixResolved = !this.hasActiveToolBridge();
    const flushBufferedMessages = async (): Promise<void> => {
      while (bufferedMessageEvents.length) await emit(bufferedMessageEvents.shift()!);
      bufferedMessageText = "";
    };
    return new CodexRichRunDriver({
      runId,
      backendId: this.manifest.id,
      emit: async (event) => {
        if (!messagePrefixResolved && isAgentMessageEvent(event.type)) {
          bufferedMessageEvents.push(event);
          const replacement = event.type === "agent.message.completed" || event.data?.replace === true;
          const eventText = event.text ?? "";
          if (!replacement) bufferedMessageText = `${bufferedMessageText}${eventText}`;
          else if (eventText) bufferedMessageText = eventText;
          const candidate = classifyEchoInkToolCallCandidate(bufferedMessageText, {
            messageCompleted: event.type === "agent.message.completed"
          });
          if (candidate !== "visible") return;
          messagePrefixResolved = true;
          await flushBufferedMessages();
          return;
        }
        if (event.type === "run.completed") {
          if (!parseExactEchoInkToolCall(event.text ?? bufferedMessageText)) {
            await flushBufferedMessages();
          } else {
            bufferedMessageEvents.length = 0;
            bufferedMessageText = "";
          }
          terminalGate.pendingCompleted = event;
          return;
        }
        if (event.type === "run.failed" || event.type === "run.cancelled") {
          await flushBufferedMessages();
          await emit(event);
          terminalGate.emitted = true;
          return;
        }
        await emit(event);
      },
      interruptTurn: this.options.interruptTurn
        ? async (threadId, turnId) => await this.options.interruptTurn!(threadId, turnId)
        : undefined,
      inactivityTimeoutMs: this.options.inactivityTimeoutMs,
      finalAnswerGraceMs: this.options.finalAnswerGraceMs,
      artifactRecovery: this.options.artifactRecovery,
      onSettled: async () => {
        this.options.notificationHub?.unregister(runId);
      }
    });
  }

  private async awaitLogicalResult(state: CodexRunState): Promise<AgentRunResult> {
    const result = await this.awaitResultLoop(state);
    if (!state.terminalGate.emitted) await this.emitLogicalTerminal(state, result);
    return result;
  }

  private async awaitResultLoop(state: CodexRunState): Promise<AgentRunResult> {
    try {
      while (true) {
        const turnResult = await state.driver.awaitResult();
        if (turnResult.status !== "completed") {
          return this.finalizeRunState(state, turnResult);
        }
        const bridgeRequest = this.readToolBridgeRequest(turnResult.outputText);
        if (!bridgeRequest) return this.finalizeRunState(state, turnResult);
        state.terminalGate.pendingCompleted = undefined;
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

  private async emitLogicalTerminal(state: CodexRunState, result: AgentRunResult): Promise<void> {
    const type = terminalEventType(result.status);
    const bufferedCompleted = type === "run.completed" ? state.terminalGate.pendingCompleted : undefined;
    const event = bufferedCompleted ?? {
      eventId: "",
      runId: state.runId,
      sequence: 0,
      createdAt: Date.now(),
      source: "kernel",
      type,
      backendId: this.manifest.id,
      text: type === "run.completed" ? result.outputText : undefined,
      error: type === "run.completed" ? undefined : result.error,
      data: result.terminalData
    } satisfies HarnessEvent;
    state.terminalGate.pendingCompleted = undefined;
    await state.emit(event);
    state.terminalGate.emitted = true;
  }

  private readToolBridgeRequest(outputText: string | undefined): EchoInkToolCallRequest | null {
    if (!this.hasActiveToolBridge()) return null;
    return parseExactEchoInkToolCall(outputText ?? "");
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
      controlProtocol: "echoink-tool-call",
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
        (error: unknown) => ({ status: "failed", error } as const)
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
    const driver = this.createDriver(state.runId, state.emit, state.terminalGate);
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
        state.turnOptions
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
      terminalData: state.exactWriteFenceReceipt
        ? { ...(result.terminalData ?? {}), exactWriteFenceReceipt: state.exactWriteFenceReceipt }
        : result.terminalData,
      nativeExecution: result.nativeExecution ?? (state.threadId ? this.buildNativeExecutionRef(state.threadId, state) : undefined),
      nativeThreadId: result.nativeThreadId ?? (state.threadId || undefined),
      nativeSessionId: result.nativeSessionId ?? state.turnId
    };
    return finalized;
  }

  private async configureExactWriteFence(
    request: AgentRunRequest,
    turnOptions: TurnOptions | undefined,
    threadId: string
  ): Promise<AgentExactWriteFenceReceipt | undefined> {
    if (!this.options.requireExactWriteFence) return undefined;
    const task: AgentTaskInput = {
      prompt: "",
      permission: turnOptions?.permission ?? request.permissions.mode,
      writableRoots: turnOptions?.writableRoots ?? request.permissions.writableRoots,
      requireExactWriteFence: true,
      exactWriteFence: this.options.exactWriteFence,
      onExactWriteFenceConfigured: this.options.onExactWriteFenceConfigured
    };
    const vaultPath = turnOptions?.cwd?.trim()
      || request.workspace?.cwd?.trim()
      || request.workspace?.vaultPath?.trim()
      || "";
    assertExactWriteFenceRequest("codex-cli", task, vaultPath);
    const receipt = createExactWriteFenceReceipt({
      backend: "codex-cli",
      task,
      transport: "codex-app-server-thread-sandbox",
      transportAck: {
        operation: "thread.start-or-resume",
        threadId,
        cwd: vaultPath,
        permission: task.permission,
        writableRoots: task.writableRoots ?? []
      }
    });
    await deliverExactWriteFenceReceipt(task, receipt);
    return receipt;
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
      nativeExecution: state.threadId ? this.buildNativeExecutionRef(state.threadId, state) : undefined,
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

  private async ensureThread(
    request: AgentRunRequest,
    turnOptions?: TurnOptions,
    isolateNativeThread = false
  ): Promise<{ threadId: string; created: boolean }> {
    if (isolateNativeThread) {
      return {
        threadId: (await this.options.startThread(turnOptions)).threadId,
        created: true
      };
    }
    const explicit = request.nativeThreadId?.trim();
    if (request.nativeBindingManagedByHarness && explicit) {
      try {
        await this.options.resumeThread(explicit, turnOptions);
        return { threadId: explicit, created: false };
      } catch (error) {
        if (!isMissingCodexThreadError(error)) throw error;
        throw new AgentNativeSessionStaleError(
          `Codex Native thread became stale while resuming: ${explicit}`,
          explicit,
          error
        );
      }
    }
    const existing = request.nativeBindingManagedByHarness
      ? ""
      : this.options.getNativeThreadId()?.trim();
    if (existing) {
      try {
        await this.options.resumeThread(existing, turnOptions);
        return { threadId: existing, created: false };
      } catch {
        // Fall through and create a replacement thread.
      }
    }
    const started = await this.options.startThread(turnOptions);
    if (!request.nativeBindingManagedByHarness) {
      this.options.setNativeThreadId(started.threadId);
    }
    return { threadId: started.threadId, created: true };
  }

  private async registerThreadBeforePrompt(
    request: AgentRunRequest,
    state: CodexRunState
  ): Promise<void> {
    const register = request.registerNativeExecution;
    if (!register || state.registeredThreadIds?.has(state.threadId)) return;
    const native = this.buildNativeExecutionRef(state.threadId, state);
    if (!native) {
      throw new NativeRunRegistrationError(
        "Codex Native execution cannot be registered without a trusted device and Vault identity"
      );
    }
    try {
      await register(native);
      (state.registeredThreadIds ??= new Set()).add(state.threadId);
    } catch (error) {
      if (state.threadWasCreated && this.options.archiveThread) {
        await this.options.archiveThread(state.threadId).catch(() => undefined);
      }
      throw error instanceof NativeRunRegistrationError
        ? error
        : new NativeRunRegistrationError(
          `Codex Native execution registration failed: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
    }
  }

  private buildNativeExecutionRef(
    threadId: string,
    state?: CodexRunState
  ): NativeExecutionRef | undefined {
    const cached = state?.nativeExecutionRefs?.get(threadId);
    if (cached) return cached;
    const context = this.options.nativeRefContext;
    if (!context) return undefined;
    const native: NativeExecutionRef = {
      backendId: this.manifest.id,
      id: threadId,
      kind: "thread",
      persistence: state?.isolateNativeThread || state?.turnOptions?.ephemeral || this.options.turnOptions?.ephemeral
        ? "none"
        : "provider-persistent",
      providerEndpoint: context.providerEndpoint,
      deviceKey: context.deviceKey,
      vaultId: context.vaultId,
      createdAt: Date.now()
    };
    if (state) {
      (state.nativeExecutionRefs ??= new Map()).set(threadId, native);
    }
    return native;
  }

  private turnOptionsForRequest(request: AgentRunRequest): TurnOptions | undefined {
    const workspaceCwd = request.workspace?.cwd?.trim()
      || request.workspace?.vaultPath?.trim()
      || "";
    const base: TurnOptions = this.options.turnOptions ?? {
      model: "",
      reasoning: "medium",
      serviceTier: "standard",
      permission: request.permissions.mode,
      mode: "agent",
      mcpEnabled: false
    };
    const scoped: TurnOptions = {
      ...base,
      ...(base.cwd?.trim() ? {} : workspaceCwd ? { cwd: workspaceCwd } : {}),
      ...(request.context.manifest?.mode === "workflow" ? { ephemeral: true } : {}),
      permission: request.permissions.mode,
      writableRoots: [...request.permissions.writableRoots]
    };
    if (request.workflow === "prompt.enhance") return scoped;
    const systemContext = [
      ...request.context.corePolicy,
      ...request.context.vaultProfile
    ]
      .filter((section) => section.channel === "system")
      .map((section) => section.content.trim())
      .filter(Boolean)
      .join("\n\n");
    if (!systemContext) return scoped;
    return {
      ...scoped,
      developerInstructions: [systemContext, scoped.developerInstructions?.trim() ?? ""]
        .filter(Boolean)
        .join("\n\n")
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
        ? `[EchoInk Long-term Memory]\nUse injected curated items directly. If the local usage archive catalog says earlier details are needed, follow its on-demand local search paths instead of loading the whole archive.\n${memorySections.join("\n\n")}`
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

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:thread\s+not\s+found|unknown\s+thread)/i.test(message);
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
  terminalGate: CodexRunTerminalGate;
  toolCallCount: number;
  turnOptions?: TurnOptions;
  isolateNativeThread: boolean;
  nativeBindingManagedByHarness: boolean;
  threadWasCreated?: boolean;
  registeredThreadIds?: Set<string>;
  nativeExecutionRefs?: Map<string, NativeExecutionRef>;
  exactWriteFenceReceipt?: AgentExactWriteFenceReceipt;
  resultPromise?: Promise<AgentRunResult>;
}

interface CodexRunTerminalGate {
  emitted: boolean;
  pendingCompleted?: HarnessEvent;
}

type BridgeCallOutcome =
  | { status: "completed"; value: unknown }
  | { status: "failed"; error: unknown }
  | { status: "cancelled" };

function isAgentMessageEvent(type: HarnessEventType): boolean {
  return type === "agent.message.delta" || type === "agent.message.completed";
}

function terminalEventType(status: AgentRunResult["status"]): "run.completed" | "run.failed" | "run.cancelled" {
  if (status === "completed") return "run.completed";
  if (status === "cancelled") return "run.cancelled";
  return "run.failed";
}

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
