import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentRichStreamRuntime } from "./runtime";
import type { AgentConnectionStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentSessionOptions, AgentTaskInput, AgentTaskResult } from "./types";
import type { OpenCodeBackend, OpenCodeCliTaskOptions, OpenCodeConnectionInfo } from "../core/opencode-backend";
import { openCodeAssistantMessageIds } from "../core/opencode-run";
import type { PermissionMode } from "../types/app-server";
import {
  ExactWriteFenceUnavailableError,
  assertExactWriteFenceRequest,
  createExactWriteFenceReceipt,
  deliverExactWriteFenceReceipt,
  exactWriteFenceEventData,
  exactWriteFenceUnavailable
} from "./write-fence";
import type { AgentExactWriteFenceReceipt } from "./types";

type AgentEventDraft = Omit<AgentEvent, "backend" | "createdAt" | "runId">;
type OpenCodeStreamSource = "sse" | "cli-jsonl" | "session-readback";
type OpenCodeTerminalToolStatus = "unconfirmed" | "interrupted";
type OpenCodeToolSemanticKind = "read" | "search" | "command" | "edit" | "mcp" | "agent" | "plan" | "tool";

export interface OpenCodeRichRuntimeBackend {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionInfo(): OpenCodeConnectionInfo;
  listModels(): Promise<AgentModelInfo[]>;
  listAgents(): Promise<AgentProfileInfo[]>;
  hasSession(sessionId: string): Promise<boolean>;
  updateSessionPermissions(sessionId: string, permission: PermissionMode, writableRoots?: string[]): Promise<void>;
  deleteSession(sessionId: string): Promise<boolean>;
  startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }>;
  sendPromptAsync(options: AgentPromptOptions, signal?: AbortSignal): Promise<void>;
  subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<unknown>>;
  replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  getSessionStatus(sessionId: string): Promise<string | undefined>;
  readSessionMessages(sessionId: string): Promise<unknown[]>;
  runCliTask(options: OpenCodeCliTaskOptions): Promise<AgentTaskResult>;
  abort(sessionId: string): Promise<void>;
}

export interface OpenCodeRichRuntimeOptions {
  backend: OpenCodeRichRuntimeBackend;
  title?: string;
  sseReadyTimeoutMs?: number;
  recoveryPollMs?: number;
  manageBackendConnection?: boolean;
  vaultPath?: string;
}

export interface OpenCodeProjectionResult {
  events: AgentEventDraft[];
  terminal?: { type: "idle" } | { type: "error"; error: Error };
  settledToolCallIds?: string[];
}

const DEFAULT_SSE_READY_TIMEOUT_MS = 2_000;
const DEFAULT_RECOVERY_POLL_MS = 250;
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1_000;

export class OpenCodeRichRuntime implements AgentRichStreamRuntime {
  readonly kind = "opencode" as const;
  private activeRunId = "";
  private activeController: AbortController | null = null;
  private backendAbortRunId = "";

  constructor(private readonly options: OpenCodeRichRuntimeOptions) {}

  async connect(): Promise<AgentConnectionStatus> {
    if (this.options.manageBackendConnection !== false) await this.options.backend.connect();
    const info = this.options.backend.getConnectionInfo();
    return { connected: info.connected, label: "OpenCode", version: info.version, errors: info.errors };
  }

  async disconnect(): Promise<void> {
    this.activeController?.abort();
    this.activeController = null;
    if (this.options.manageBackendConnection !== false) await this.options.backend.disconnect();
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return await this.options.backend.listModels();
  }

  async listAgents(): Promise<AgentProfileInfo[]> {
    return await this.options.backend.listAgents();
  }

  async hasNativeSession(sessionId: string): Promise<boolean> {
    return await this.options.backend.hasSession(sessionId);
  }

  async deleteNativeSession(sessionId: string): Promise<boolean> {
    return await this.options.backend.deleteSession(sessionId);
  }

  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    let streamedText = "";
    let completedText = "";
    const result = await this.runTaskStream(input, (event) => {
      if (event.type === "message_delta") streamedText += event.text ?? "";
      if (event.type === "message_completed" || event.type === "completed") completedText = event.text ?? completedText;
    });
    return { ...result, text: completedText || streamedText || result.text };
  }

  async runTaskStream(input: AgentTaskInput, sink: AgentEventSink): Promise<AgentTaskResult> {
    if (this.activeController) throw new Error("OpenCode rich runtime 已有任务在运行。");
    throwIfAborted(input.abortSignal);
    assertExactWriteFenceRequest("opencode", input, this.options.vaultPath ?? "");

    const runController = new AbortController();
    this.activeController = runController;
    this.backendAbortRunId = "";
    const removeInputAbort = forwardAbort(input.abortSignal, runController);
    const deadline = Date.now() + normalizeTimeout(input.timeoutMs);
    let sessionId = "";
    let promptSubmitted = false;
    let exactWriteFenceReceipt: AgentExactWriteFenceReceipt | undefined;
    let failedEmitted = false;
    let outputText = "";
    let usage: Record<string, unknown> | undefined;
    let emitQueue = Promise.resolve();
    const emitDraft = (draft: AgentEventDraft, source: OpenCodeStreamSource = "sse"): Promise<void> => {
      const event: AgentEvent = {
        ...draft,
        backend: "opencode",
        createdAt: Date.now(),
        runId: sessionId || undefined,
        data: {
          ...(draft.data ?? {}),
          streamSource: source,
          promptSubmitted
        }
      };
      if (event.type === "message_delta") outputText += event.text ?? "";
      if (event.type === "message_completed" && event.text !== undefined) outputText = event.text;
      if (event.type === "usage") usage = event.data;
      if (event.type === "failed") failedEmitted = true;
      emitQueue = emitQueue.then(() => Promise.resolve(sink(event)));
      return emitQueue;
    };
    const emitProjection = async (projection: OpenCodeProjectionResult, source: OpenCodeStreamSource): Promise<void> => {
      for (const event of projection.events) await emitDraft(event, source);
    };

    let streamController: AbortController | null = null;
    let streamPump: Promise<void> | null = null;
    let projector: OpenCodeEventProjector | null = null;
    let activeStreamSource: OpenCodeStreamSource = "sse";
    try {
      const resumed = input.nativeSessionId && await this.options.backend.hasSession(input.nativeSessionId)
        ? input.nativeSessionId
        : "";
      if (resumed) {
        sessionId = resumed;
        await this.options.backend.updateSessionPermissions(
          sessionId,
          input.permission ?? "workspace-write",
          input.writableRoots
        );
      } else {
        const session = await this.options.backend.startSession({
          title: this.options.title ?? "EchoInk Chat",
          model: input.model,
          agent: input.agent,
          permission: input.permission,
          writableRoots: input.writableRoots
        });
        sessionId = session.sessionId;
      }
      if (input.requireExactWriteFence) {
        exactWriteFenceReceipt = createExactWriteFenceReceipt({
          backend: "opencode",
          task: input,
          transport: "opencode-sdk-session-permissions",
          transportAck: {
            operation: resumed ? "session.permissions.update" : "session.start",
            sessionId,
            permission: input.permission,
            writableRoots: input.writableRoots ?? []
          }
        });
        await deliverExactWriteFenceReceipt(input, exactWriteFenceReceipt);
      }
      this.activeRunId = sessionId;
      input.onRunId?.(sessionId);
      await emitDraft({ type: "run_started", data: { streamSource: "sse", promptSubmitted: false } });

      // A resumed session can already contain completed assistant messages. If
      // its pre-submit baseline cannot be read, later recovery cannot safely
      // distinguish those stale messages from this turn's answer. Fail before
      // crossing the prompt submission boundary so the outer runtime may use a
      // safe fallback without ever returning old session text as new output.
      const beforeMessages = resumed
        ? await this.options.backend.readSessionMessages(sessionId)
        : await this.options.backend.readSessionMessages(sessionId).catch(() => []);
      const knownAssistantIds = openCodeAssistantMessageIds(beforeMessages);
      projector = new OpenCodeEventProjector(sessionId, "sse");

      streamController = linkedAbortController(runController.signal);
      let iterator: AsyncIterator<unknown>;
      let first: IteratorResult<unknown>;
      try {
        const stream = await this.options.backend.subscribeEvents(streamController.signal);
        iterator = stream[Symbol.asyncIterator]();
        first = await withDeadline(
          iterator.next(),
          Math.min(deadline, Date.now() + (this.options.sseReadyTimeoutMs ?? DEFAULT_SSE_READY_TIMEOUT_MS)),
          runController.signal,
          "OpenCode SSE 启动超时"
        );
        if (first.done) throw new Error("OpenCode SSE 在就绪前已断开。");
      } catch (error) {
        streamController.abort();
        if (runController.signal.aborted) throw createCancelledError();
        if (input.requireExactWriteFence) {
          throw exactWriteFenceUnavailable(
            "opencode",
            `SSE transport 在提交 prompt 前不可用，禁止降级到不带可证明 scoped permission 的 CLI：${errorMessage(error)}`,
            error
          );
        }
        activeStreamSource = "cli-jsonl";
        return await this.runCliFallback({
          input,
          sessionId,
          knownAssistantIds,
          deadline,
          reason: errorMessage(error),
          projector,
          emitDraft,
          emitProjection,
          signal: runController.signal,
          markPromptSubmitted: () => { promptSubmitted = true; }
        });
      }

      const terminal = deferred<{ type: "idle" } | { type: "error"; error: Error }>();
      const terminalResultPromise = terminal.promise.then(
        (result) => result,
        (error) => ({ type: "stream_error" as const, error: normalizeError(error) })
      );
      let sawSubmittedRunActivity = false;
      const consume = async (event: unknown): Promise<void> => {
        if (!eventBelongsToSession(event, sessionId)) return;
        if (promptSubmitted && isSubmittedRunActivity(event, knownAssistantIds)) {
          sawSubmittedRunActivity = true;
        }
        const projection = projector!.project(event);
        await emitProjection(projection, "sse");
        const permissionRequest = openCodePermissionRequest(event);
        if (promptSubmitted && permissionRequest) {
          try {
            await this.options.backend.replyPermission(
              permissionRequest.requestId,
              openCodePermissionReply(input.permission ?? "workspace-write", permissionRequest.permission)
            );
          } catch (error) {
            terminal.resolve({ type: "error", error: normalizeError(error) });
            return;
          }
        }
        // The directory-wide stream can still contain an idle event emitted for
        // this session before the new prompt crosses the submission boundary.
        // Such a stale terminal must not settle the new turn.
        if (projection.terminal
          && promptSubmitted
          && (projection.terminal.type === "error" || sawSubmittedRunActivity)) {
          terminal.resolve(projection.terminal);
        }
      };
      streamPump = (async () => {
        try {
          await consume(first.value);
          while (!terminal.settled && !streamController!.signal.aborted) {
            const next = await iterator.next();
            if (next.done) break;
            await consume(next.value);
          }
          if (!terminal.settled && !streamController!.signal.aborted) {
            terminal.reject(new Error("OpenCode SSE 在任务完成前已断开。"));
          }
        } catch (error) {
          if (!terminal.settled && !streamController!.signal.aborted) terminal.reject(normalizeError(error));
        }
      })();

      let promptTransportError: unknown;
      const promptController = linkedAbortController(runController.signal);
      try {
        // Invoking promptAsync crosses the no-retry boundary: the request may have reached
        // OpenCode even if its HTTP response later fails, so no other path may submit it again.
        const promptPromise = this.options.backend.sendPromptAsync({
          sessionId,
          parts: richPromptParts(input),
          model: input.model,
          agent: input.agent,
          system: input.system,
          tools: input.tools
        }, promptController.signal);
        const promptResultPromise = promptPromise.then(
          () => ({ type: "prompt_accepted" as const }),
          (error) => ({ type: "prompt_error" as const, error: normalizeError(error) })
        );
        promptSubmitted = true;
        await emitDraft({ type: "prompt_sent" });
        const promptOrTerminal = await withDeadline(Promise.race([
          promptResultPromise,
          terminalResultPromise.then((result) => ({ type: "terminal" as const, result }))
        ]), deadline, runController.signal, "OpenCode 提交任务等待超时");
        if (promptOrTerminal.type === "prompt_error") {
          throw promptOrTerminal.error;
        }
        if (promptOrTerminal.type === "terminal") {
          if (promptOrTerminal.result.type === "stream_error") {
            // Losing the observation channel does not prove the POST reached OpenCode.
            // Let that one submitted request finish (or hit the same deadline) before readback.
            const promptResult = await withDeadline(promptResultPromise, deadline, runController.signal, "OpenCode 提交任务等待超时");
            if (promptResult.type === "prompt_error") throw promptResult.error;
          } else {
            // A scoped provider terminal proves this turn was accepted. Stop waiting on a
            // stuck HTTP acknowledgement without cancelling the already-finished session.
            promptController.abort();
          }
        }
      } catch (error) {
        promptController.abort();
        promptTransportError = error;
      }
      await emitDraft({ type: "waiting" });

      let terminalResult: { type: "idle" } | { type: "error"; error: Error } | { type: "stream_error"; error: Error };
      try {
        if (promptTransportError) throw promptTransportError;
        terminalResult = await withDeadline(terminalResultPromise, deadline, runController.signal, "OpenCode 任务等待超时");
        if (terminalResult.type === "stream_error") throw terminalResult.error;
      } catch (streamError) {
        if (runController.signal.aborted) throw createCancelledError();
        const recovered = await this.recoverSubmittedSession({
          sessionId,
          knownAssistantIds,
          deadline,
          signal: runController.signal,
          projector,
          emitProjection
        });
        // Recovery is authoritative once the same session is idle/completed.
        // Preserve an intentional empty answer instead of reviving an earlier
        // partial SSE snapshot through truthy fallback semantics.
        outputText = recovered.text;
        usage = recovered.usage ?? usage;
        terminalResult = { type: "idle" };
        activeStreamSource = "session-readback";
        await emitDraft({
          type: "waiting",
          data: { recovery: "session-readback", streamError: errorMessage(streamError) }
        }, "session-readback");
      }
      if (terminalResult.type === "error") throw terminalResult.error;

      streamController.abort();
      await streamPump.catch(() => undefined);
      const readback = await this.projectSessionReadback(sessionId, knownAssistantIds, projector, emitProjection).catch(() => null);
      if (readback?.error) throw readback.error;
      const finishProjection = projector.finish("unconfirmed");
      await emitProjection(finishProjection, activeStreamSource);
      const unconfirmedToolCallIds = finishProjection.settledToolCallIds ?? [];
      const finalText = readback?.completed
        ? readback.text
        : readback?.text || outputText;
      usage = readback?.usage ?? usage;
      const terminalData = {
        messageId: projector.lastAssistantMessageId,
        streamSource: activeStreamSource,
        promptSubmitted,
        ...(exactWriteFenceReceipt ? { exactWriteFenceReceipt } : {}),
        unconfirmedToolCallCount: unconfirmedToolCallIds.length,
        ...(unconfirmedToolCallIds.length ? { unconfirmedToolCallIds } : {})
      };
      await emitQueue;
      if (usage) await emitDraft({ type: "usage", data: usage }, activeStreamSource);
      await emitDraft({
        type: "completed",
        text: finalText,
        data: terminalData
      }, activeStreamSource);
      return { text: finalText, runId: sessionId, usage, terminalData };
    } catch (error) {
      streamController?.abort();
      if (streamPump) await streamPump.catch(() => undefined);
      const interruptedProjection = projector?.finish("interrupted");
      const interruptedToolCallIds = interruptedProjection?.settledToolCallIds ?? [];
      if (interruptedProjection) {
        await emitProjection(interruptedProjection, activeStreamSource).catch(() => undefined);
      }
      if (runController.signal.aborted || input.abortSignal?.aborted) {
        await this.abortBackendOnce(sessionId).catch(() => undefined);
        await emitDraft({
          type: "cancelled",
          error: "OpenCode 任务已取消。",
          data: {
            interruptedToolCallCount: interruptedToolCallIds.length,
            ...(interruptedToolCallIds.length ? { interruptedToolCallIds } : {})
          }
        });
        throw createCancelledError();
      }
      if (promptSubmitted) await this.abortBackendOnce(sessionId).catch(() => undefined);
      const normalized = normalizeError(error);
      if (!failedEmitted) {
        await emitDraft({
          type: "failed",
          error: normalized.message,
          data: {
            ...(error instanceof ExactWriteFenceUnavailableError ? exactWriteFenceEventData(error) : {}),
            interruptedToolCallCount: interruptedToolCallIds.length,
            ...(interruptedToolCallIds.length ? { interruptedToolCallIds } : {})
          }
        });
      }
      throw normalized;
    } finally {
      streamController?.abort();
      removeInputAbort();
      this.activeController = null;
      this.activeRunId = "";
      await emitQueue.catch(() => undefined);
    }
  }

  async abort(runId: string): Promise<void> {
    this.activeController?.abort();
    const sessionId = runId || this.activeRunId;
    if (sessionId) await this.abortBackendOnce(sessionId);
  }

  private async abortBackendOnce(sessionId: string): Promise<void> {
    if (!sessionId || this.backendAbortRunId === sessionId) return;
    this.backendAbortRunId = sessionId;
    await this.options.backend.abort(sessionId);
  }

  private async runCliFallback(input: {
    input: AgentTaskInput;
    sessionId: string;
    knownAssistantIds: ReadonlySet<string>;
    deadline: number;
    reason: string;
    projector: OpenCodeEventProjector;
    emitDraft: (draft: AgentEventDraft, source?: OpenCodeStreamSource) => Promise<void>;
    emitProjection: (projection: OpenCodeProjectionResult, source: OpenCodeStreamSource) => Promise<void>;
    signal: AbortSignal;
    markPromptSubmitted: () => void;
  }): Promise<AgentTaskResult> {
    await input.emitDraft({
      type: "fallback_started",
      error: input.reason,
      data: { fallbackReason: input.reason }
    }, "cli-jsonl");
    let cliQueue = Promise.resolve();
    let submissionEvent = Promise.resolve();
    let cliPromptSubmitted = false;
    let terminalSource: OpenCodeStreamSource = "cli-jsonl";
    let result: AgentTaskResult;
    try {
      result = await this.options.backend.runCliTask({
        prompt: richCliPromptText(input.input),
        nativeSessionId: input.sessionId,
        parts: input.input.sources,
        model: input.input.model,
        agent: input.input.agent,
        timeoutMs: remainingMs(input.deadline),
        abortSignal: input.signal,
        thinking: true,
        onPromptSubmitted: () => {
          cliPromptSubmitted = true;
          input.markPromptSubmitted();
          submissionEvent = input.emitDraft({ type: "prompt_sent" }, "cli-jsonl");
        },
        onEvent: (event) => {
          cliQueue = cliQueue.then(async () => {
            await input.emitProjection(input.projector.projectCli(event), "cli-jsonl");
          });
        }
      });
    } catch (error) {
      await submissionEvent;
      await cliQueue;
      if (!cliPromptSubmitted) throw error;
      const recovered = await this.recoverSubmittedSession({
        sessionId: input.sessionId,
        knownAssistantIds: input.knownAssistantIds,
        deadline: input.deadline,
        signal: input.signal,
        projector: input.projector,
        emitProjection: input.emitProjection
      });
      terminalSource = "session-readback";
      await input.emitDraft({
        type: "waiting",
        data: { recovery: "session-readback", cliError: errorMessage(error) }
      }, terminalSource);
      result = {
        text: recovered.text,
        runId: input.sessionId,
        usage: recovered.usage,
        terminalData: { recovery: "session-readback", cliError: errorMessage(error) }
      };
    }
    await submissionEvent;
    await cliQueue;
    const finishProjection = input.projector.finish("unconfirmed");
    await input.emitProjection(finishProjection, terminalSource);
    const unconfirmedToolCallIds = finishProjection.settledToolCallIds ?? [];
    const terminalData = {
      ...(result.terminalData ?? {}),
      messageId: input.projector.lastAssistantMessageId,
      streamSource: terminalSource,
      promptSubmitted: cliPromptSubmitted,
      unconfirmedToolCallCount: unconfirmedToolCallIds.length,
      ...(unconfirmedToolCallIds.length ? { unconfirmedToolCallIds } : {})
    };
    if (result.usage) await input.emitDraft({ type: "usage", data: result.usage }, terminalSource);
    await input.emitDraft({
      type: "completed",
      text: result.text,
      data: terminalData
    }, terminalSource);
    return { ...result, runId: result.runId || input.sessionId, terminalData };
  }

  private async recoverSubmittedSession(input: {
    sessionId: string;
    knownAssistantIds: ReadonlySet<string>;
    deadline: number;
    signal: AbortSignal;
    projector: OpenCodeEventProjector;
    emitProjection: (projection: OpenCodeProjectionResult, source: OpenCodeStreamSource) => Promise<void>;
  }): Promise<{ text: string; usage?: Record<string, unknown> }> {
    let latestText = "";
    let latestUsage: Record<string, unknown> | undefined;
    let delayMs = this.options.recoveryPollMs ?? DEFAULT_RECOVERY_POLL_MS;
    while (Date.now() < input.deadline) {
      throwIfAborted(input.signal);
      const readback = await this.projectSessionReadback(
        input.sessionId,
        input.knownAssistantIds,
        input.projector,
        input.emitProjection
      );
      if (readback.error) throw readback.error;
      latestText = readback.completed
        ? readback.text
        : readback.text || latestText;
      latestUsage = readback.usage ?? latestUsage;
      const status = await this.options.backend.getSessionStatus(input.sessionId).catch(() => undefined);
      const recovered = status === "idle"
        ? readback.completed || (readback.hasAssistant && !readback.toolContinuation && Boolean(readback.text))
        : status === undefined && readback.completed;
      if (recovered) return { text: latestText, usage: latestUsage };
      await abortableDelay(Math.min(delayMs, remainingMs(input.deadline)), input.signal);
      delayMs = Math.min(Math.max(delayMs * 1.5, 1), 1_000);
    }
    throw new Error("OpenCode SSE 断开后，同一会话仍未在超时前完成。");
  }

  private async projectSessionReadback(
    sessionId: string,
    knownAssistantIds: ReadonlySet<string>,
    projector: OpenCodeEventProjector,
    emitProjection: (projection: OpenCodeProjectionResult, source: OpenCodeStreamSource) => Promise<void>
  ): Promise<{ text: string; usage?: Record<string, unknown>; completed: boolean; hasAssistant: boolean; toolContinuation: boolean; error?: Error }> {
    const messages = await this.options.backend.readSessionMessages(sessionId);
    let usage: Record<string, unknown> | undefined;
    let latestText = "";
    let latestCompletion: OpenCodeAssistantCompletion = "incomplete";
    let latestError: Error | undefined;
    let latestAt = Number.NEGATIVE_INFINITY;
    let latestIndex = -1;
    for (const [index, entry] of messages.entries()) {
      const record = plainObject(entry);
      const info = plainObject(record.info);
      const messageId = stringValue(info.id);
      if (info.role !== "assistant" || (messageId && knownAssistantIds.has(messageId))) continue;
      const messageProjection = projector.project({
        type: "message.updated",
        properties: { sessionID: sessionId, info }
      }, "session-readback");
      await emitProjection(messageProjection, "session-readback");
      for (const part of arrayValue(record.parts)) {
        await emitProjection(projector.project({
          type: "message.part.updated",
          properties: { sessionID: sessionId, part }
        }, "session-readback"), "session-readback");
      }
      const parsedUsage = usageFromAssistantInfo(info);
      if (parsedUsage) usage = parsedUsage;
      const time = plainObject(info.time);
      const createdAt = finiteNumber(time.completed) ?? finiteNumber(time.created) ?? 0;
      if (createdAt > latestAt || (createdAt === latestAt && index > latestIndex)) {
        latestAt = createdAt;
        latestIndex = index;
        latestText = openCodeAssistantMessageText(record);
        latestCompletion = openCodeAssistantMessageCompletion(record);
        latestError = messageProjection.terminal?.type === "error"
          ? messageProjection.terminal.error
          : openCodeAssistantMessageError(record);
      }
    }
    return {
      text: latestText,
      usage,
      completed: latestIndex >= 0 && latestCompletion === "completed",
      hasAssistant: latestIndex >= 0,
      toolContinuation: latestIndex >= 0 && latestCompletion === "tool-continuation",
      ...(latestError ? { error: latestError } : {})
    };
  }
}

export class OpenCodeEventProjector {
  readonly sessionId: string;
  lastAssistantMessageId = "";
  private readonly textSnapshots = new Map<string, string>();
  private readonly reasoningSnapshots = new Map<string, string>();
  private readonly reasoningSegmentNumbers = new Map<string, number>();
  private readonly messageRoles = new Map<string, string>();
  private readonly partTypes = new Map<string, string>();
  private readonly partMessageIds = new Map<string, string>();
  private readonly pendingParts = new Map<string, Map<string, unknown>>();
  private readonly requestedTools = new Set<string>();
  private readonly terminalTools = new Set<string>();
  private readonly toolFingerprints = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly toolStates = new Map<string, { toolName: string; data: Record<string, unknown> }>();
  private readonly permissionRequests = new Map<string, { callId: string; messageId: string; toolName: string }>();
  private readonly usageFingerprints = new Set<string>();
  private activeReasoning: { partId: string; blockId: string; messageId: string; text: string } | null = null;
  private cliText = "";

  constructor(sessionId: string, private streamSource: OpenCodeStreamSource = "sse") {
    this.sessionId = sessionId;
  }

  project(rawEvent: unknown, source: OpenCodeStreamSource = this.streamSource): OpenCodeProjectionResult {
    this.streamSource = source;
    const event = plainObject(rawEvent);
    const type = stringValue(event.type);
    const properties = plainObject(event.properties);
    if (!type) return { events: [] };
    if (type === "message.updated") return this.projectMessageUpdated(properties);
    if (type === "message.part.updated" || type === "message.part.delta") {
      const part = plainObject(properties.part);
      const partId = stringValue(part.id ?? properties.partID);
      const messageId = stringValue(part.messageID ?? properties.messageID ?? this.partMessageIds.get(partId));
      const role = this.messageRoles.get(messageId);
      if (role === "user") return { events: [] };
      if (role !== "assistant") {
        const pendingKey = `${type}:${partId || stringValue(part.type)}:${this.pendingParts.get(messageId)?.size ?? 0}`;
        const pending = this.pendingParts.get(messageId) ?? new Map<string, unknown>();
        pending.set(pendingKey, rawEvent);
        this.pendingParts.set(messageId, pending);
        return { events: [] };
      }
      return type === "message.part.delta"
        ? this.projectPartDelta(properties)
        : this.projectPart(part);
    }
    if (type === "permission.asked") return this.projectPermission(properties);
    if (type === "permission.replied") return this.projectPermissionReply(properties);
    if (type === "todo.updated") return this.projectTodos(properties);
    if (type === "session.diff") return this.projectDiff(properties);
    if (type === "session.idle" || (type === "session.status" && plainObject(properties.status).type === "idle")) {
      return { events: this.completeReasoning(), terminal: { type: "idle" } };
    }
    if (type === "session.error") {
      return { events: this.completeReasoning(), terminal: { type: "error", error: openCodeEventError(properties.error) } };
    }
    return { events: [] };
  }

  projectCli(rawEvent: unknown): OpenCodeProjectionResult {
    this.streamSource = "cli-jsonl";
    const event = plainObject(rawEvent);
    const type = stringValue(event.type);
    const part = plainObject(event.part);
    const messageId = stringValue(part.messageID) || "cli-assistant";
    this.lastAssistantMessageId = messageId;
    if (type === "text") {
      const text = stringValue(part.text);
      this.cliText += text;
      return {
        events: [
          ...this.completeReasoning(),
          ...(text ? [{
            type: "message_delta" as const,
            text,
            data: { messageId, partId: stringValue(part.id) || "cli-text", fullText: this.cliText }
          }] : [])
        ]
      };
    }
    if (type === "reasoning") {
      const text = stringValue(part.text);
      if (!text) return { events: [] };
      const partId = stringValue(part.id) || `cli-reasoning:${messageId}`;
      return { events: this.appendReasoning(partId, messageId, text, true) };
    }
    if (type === "tool" || type === "tool_use") return this.projectPart({ ...part, type: "tool", messageID: messageId });
    if (type === "step_finish" || type === "step-finish") {
      const usage = usageFromStep(part);
      return { events: usage ? [this.usageEvent(usage, messageId)] : [] };
    }
    if (type === "error") {
      return { events: this.completeReasoning(), terminal: { type: "error", error: openCodeEventError(event.error) } };
    }
    return this.project(rawEvent, "cli-jsonl");
  }

  finish(toolStatus?: OpenCodeTerminalToolStatus): OpenCodeProjectionResult {
    const settlement = toolStatus ? this.settlePendingTools(toolStatus) : { events: [], callIds: [] };
    return {
      events: [...this.completeReasoning(), ...settlement.events],
      ...(settlement.callIds.length ? { settledToolCallIds: settlement.callIds } : {})
    };
  }

  private projectMessageUpdated(properties: Record<string, unknown>): OpenCodeProjectionResult {
    const info = plainObject(properties.info);
    const messageId = stringValue(info.id ?? properties.messageID);
    const role = stringValue(info.role);
    if (messageId && role) this.messageRoles.set(messageId, role);
    if (role !== "assistant") {
      if (messageId) this.pendingParts.delete(messageId);
      return { events: [] };
    }
    this.lastAssistantMessageId = messageId || this.lastAssistantMessageId;
    const events: AgentEventDraft[] = [];
    const pending = this.pendingParts.get(messageId);
    if (pending) {
      this.pendingParts.delete(messageId);
      for (const pendingEvent of pending.values()) events.push(...this.project(pendingEvent).events);
    }
    const usage = usageFromAssistantInfo(info);
    if (usage) events.push(this.usageEvent(usage, messageId));
    const error = info.error ? openCodeEventError(info.error) : null;
    return error
      ? { events: [...events, ...this.completeReasoning()], terminal: { type: "error", error } }
      : { events };
  }

  private projectPart(part: Record<string, unknown>): OpenCodeProjectionResult {
    const partType = stringValue(part.type);
    const partId = stringValue(part.id) || `${partType}:${stringValue(part.messageID)}`;
    const messageId = stringValue(part.messageID);
    if (partId) {
      if (partType) this.partTypes.set(partId, partType);
      if (messageId) this.partMessageIds.set(partId, messageId);
    }
    this.lastAssistantMessageId = messageId || this.lastAssistantMessageId;
    if (partType === "text") {
      const fullText = stringValue(part.text);
      const delta = appendedDelta(this.textSnapshots.get(partId) ?? "", fullText);
      this.textSnapshots.set(partId, fullText);
      return {
        events: [
          ...this.completeReasoning(),
          ...(delta.text ? [{
            type: "message_delta" as const,
            text: delta.text,
            data: { messageId, partId, fullText, ...(delta.replaced ? { replace: true } : {}) }
          }] : [])
        ]
      };
    }
    if (partType === "reasoning") {
      const fullText = stringValue(part.text);
      const delta = appendedDelta(this.reasoningSnapshots.get(partId) ?? "", fullText);
      this.reasoningSnapshots.set(partId, fullText);
      const events = delta.text ? this.appendReasoning(partId, messageId, delta.text, false, delta.replaced) : [];
      if (plainObject(part.time).end !== undefined) events.push(...this.completeReasoning());
      return { events };
    }
    if (partType === "tool") {
      return { events: [...this.completeReasoning(), ...this.projectTool(part)] };
    }
    if (partType === "step-finish") {
      const usage = usageFromStep(part);
      return { events: usage ? [this.usageEvent(usage, messageId)] : [] };
    }
    if (partType === "patch") {
      const files = arrayValue(part.files).map(stringValue).filter(Boolean);
      return {
        events: [{
          type: "file_status",
          status: "updated",
          resourceId: files[0],
          data: { messageId, files, diff: part }
        }]
      };
    }
    return { events: [] };
  }

  private projectPartDelta(properties: Record<string, unknown>): OpenCodeProjectionResult {
    if (stringValue(properties.field) !== "text") return { events: [] };
    const partId = stringValue(properties.partID);
    const messageId = stringValue(properties.messageID ?? this.partMessageIds.get(partId));
    const partType = this.partTypes.get(partId) ?? "";
    const delta = stringValue(properties.delta);
    if (!partId || !messageId || !delta) return { events: [] };
    this.lastAssistantMessageId = messageId;
    if (partType === "reasoning") {
      this.reasoningSnapshots.set(partId, `${this.reasoningSnapshots.get(partId) ?? ""}${delta}`);
      return { events: this.appendReasoning(partId, messageId, delta, true) };
    }
    if (partType === "text") {
      const fullText = `${this.textSnapshots.get(partId) ?? ""}${delta}`;
      this.textSnapshots.set(partId, fullText);
      return {
        events: [
          ...this.completeReasoning(),
          { type: "message_delta", text: delta, data: { messageId, partId, fullText, rawDelta: true } }
        ]
      };
    }
    return { events: [] };
  }

  private appendReasoning(partId: string, messageId: string, text: string, rawDelta: boolean, replaced = false): AgentEventDraft[] {
    const events: AgentEventDraft[] = [];
    if (this.activeReasoning && this.activeReasoning.partId !== partId) events.push(...this.completeReasoning());
    if (!this.activeReasoning) {
      const segment = (this.reasoningSegmentNumbers.get(partId) ?? 0) + 1;
      this.reasoningSegmentNumbers.set(partId, segment);
      this.activeReasoning = { partId, blockId: segment === 1 ? partId : `${partId}:${segment}`, messageId, text: "" };
    }
    this.activeReasoning.text = replaced ? text : `${this.activeReasoning.text}${text}`;
    events.push({
      type: "thinking_delta",
      text,
      data: {
        messageId,
        blockId: this.activeReasoning.blockId,
        reasoningKind: "provider",
        visibility: "public",
        fullText: this.activeReasoning.text,
        ...(rawDelta ? { rawDelta: true } : {}),
        ...(replaced ? { replace: true } : {})
      }
    });
    return events;
  }

  private completeReasoning(): AgentEventDraft[] {
    const current = this.activeReasoning;
    if (!current) return [];
    this.activeReasoning = null;
    return [{
      type: "thinking_completed",
      text: current.text,
      data: {
        messageId: current.messageId,
        blockId: current.blockId,
        reasoningKind: "provider",
        visibility: "public",
        fullText: current.text
      }
    }];
  }

  private projectTool(part: Record<string, unknown>): AgentEventDraft[] {
    const state = plainObject(part.state);
    const callId = stringValue(part.callID ?? part.callId ?? part.id);
    const toolName = stringValue(part.tool) || "tool";
    const providerStatus = stringValue(state.status) || "pending";
    const toolStatus = normalizeOpenCodeToolStatus(providerStatus);
    const input = state.input;
    const output = state.output;
    const inputState = valueAvailability(state, "input");
    const outputState = valueAvailability(state, "output");
    const displayPreview = toolDisplayPreview(state, inputState, outputState);
    const files = toolFiles(state);
    const data: Record<string, unknown> = {
      messageId: stringValue(part.messageID),
      callId,
      toolCallId: callId,
      semanticKind: openCodeToolSemanticKind(toolName),
      toolStatus,
      providerStatus,
      inputState,
      outputState,
      displayPreview,
      files,
      diff: plainObject(state.metadata).diff ?? plainObject(part.metadata).diff
    };
    if (inputState === "provided") data.input = input;
    if (outputState === "provided") data.output = output;
    this.toolNames.set(callId, toolName);
    this.toolStates.set(callId, { toolName, data });
    const fingerprint = stableFingerprint({ providerStatus, input, output, displayPreview, files });
    const previousFingerprint = this.toolFingerprints.get(callId);
    this.toolFingerprints.set(callId, fingerprint);
    const events: AgentEventDraft[] = [];
    if (!this.requestedTools.has(callId)) {
      this.requestedTools.add(callId);
      events.push({
        type: "tool_call_requested",
        toolName,
        status: "requested",
        data: { ...data, toolStatus: "requested" }
      });
    } else if (previousFingerprint !== fingerprint
      && !this.terminalTools.has(callId)
      && toolStatus !== "completed"
      && toolStatus !== "failed") {
      events.push({ type: "tool_call_delta", toolName, status: toolStatus, text: outputState === "provided" ? String(output) : undefined, data });
    }
    if (toolStatus === "completed" && !this.terminalTools.has(callId)) {
      this.terminalTools.add(callId);
      events.push({ type: "tool_call_completed", toolName, status: "completed", text: displayPreview, data });
    }
    if (toolStatus === "failed" && !this.terminalTools.has(callId)) {
      this.terminalTools.add(callId);
      const error = stringValue(state.error) || "OpenCode 工具调用失败";
      events.push({ type: "tool_call_failed", toolName, status: "failed", error, data });
    }
    return events;
  }

  private projectPermission(properties: Record<string, unknown>): OpenCodeProjectionResult {
    const tool = plainObject(properties.tool);
    const requestId = stringValue(properties.requestID ?? properties.id);
    const callId = stringValue(tool.callID) || requestId;
    const messageId = stringValue(tool.messageID);
    const toolName = this.toolNames.get(callId) ?? stringValue(properties.permission) ?? "permission";
    if (requestId) this.permissionRequests.set(requestId, { callId, messageId, toolName });
    const approvalData = mergeOpenCodeToolLifecycleData(this.toolStates.get(callId)?.data ?? {}, {
      messageId,
      callId,
      toolCallId: callId,
      semanticKind: openCodeToolSemanticKind(toolName),
      toolStatus: "approval",
      inputState: "unavailable",
      outputState: "unavailable",
      permissionRequestId: requestId,
      request: properties
    });
    if (callId) {
      this.requestedTools.add(callId);
      this.toolNames.set(callId, toolName);
      this.toolStates.set(callId, { toolName, data: approvalData });
    }
    return {
      events: [
        ...this.completeReasoning(),
        {
          type: "permission_requested",
          toolName,
          status: "approval",
          data: approvalData
        }
      ]
    };
  }

  private projectPermissionReply(properties: Record<string, unknown>): OpenCodeProjectionResult {
    const requestId = stringValue(properties.requestID ?? properties.id);
    const request = this.permissionRequests.get(requestId);
    if (requestId) this.permissionRequests.delete(requestId);
    const reply = stringValue(properties.reply);
    const denied = reply === "reject" || reply === "denied";
    const callId = request?.callId || requestId;
    const toolName = request?.toolName ?? this.toolNames.get(callId) ?? "permission";
    const toolStatus = denied ? "denied" : "running";
    const replyData = mergeOpenCodeToolLifecycleData(this.toolStates.get(callId)?.data ?? {}, {
      messageId: request?.messageId ?? "",
      callId,
      toolCallId: callId,
      semanticKind: openCodeToolSemanticKind(toolName),
      toolStatus,
      inputState: "unavailable",
      outputState: "unavailable",
      permissionRequestId: requestId,
      permissionReply: reply
    });
    if (denied && callId) this.terminalTools.add(callId);
    if (callId) {
      this.toolStates.set(callId, {
        toolName,
        data: replyData
      });
    }
    return {
      events: [{
          type: "tool_call_delta",
          toolName,
          status: toolStatus,
          data: replyData
        }]
    };
  }

  private settlePendingTools(status: OpenCodeTerminalToolStatus): { events: AgentEventDraft[]; callIds: string[] } {
    const events: AgentEventDraft[] = [];
    const callIds: string[] = [];
    for (const callId of this.requestedTools) {
      if (this.terminalTools.has(callId)) continue;
      this.terminalTools.add(callId);
      callIds.push(callId);
      const snapshot = this.toolStates.get(callId);
      const toolName = snapshot?.toolName ?? this.toolNames.get(callId) ?? "tool";
      events.push({
        type: "tool_call_delta",
        toolName,
        status,
        data: {
          ...(snapshot?.data ?? {}),
          callId,
          toolCallId: callId,
          semanticKind: snapshot?.data.semanticKind ?? openCodeToolSemanticKind(toolName),
          toolStatus: status,
          completionState: status
        }
      });
    }
    this.permissionRequests.clear();
    return { events, callIds };
  }

  private projectTodos(properties: Record<string, unknown>): OpenCodeProjectionResult {
    const todos = arrayValue(properties.todos).map(plainObject);
    const text = todos.map((todo) => {
      const checked = stringValue(todo.status) === "completed" ? "x" : " ";
      return `- [${checked}] ${stringValue(todo.content)}`;
    }).filter((line) => line.trim() !== "- [ ]").join("\n");
    return {
      events: [{
        type: "plan_updated",
        text,
        data: { planId: "opencode-todo", todos }
      }]
    };
  }

  private projectDiff(properties: Record<string, unknown>): OpenCodeProjectionResult {
    const diff = arrayValue(properties.diff)
      .map(plainObject)
      .filter(hasOpenCodeDiffContent);
    const files = Array.from(new Set([
      ...arrayValue(properties.files).map(openCodeDiffFile).filter(Boolean),
      ...diff.map(openCodeDiffFile).filter(Boolean)
    ]));
    if (diff.length === 0 && files.length === 0) return { events: [] };
    return {
      events: [{
        type: "file_status",
        status: "updated",
        resourceId: files[0],
        data: { files, diff }
      }]
    };
  }

  private usageEvent(usage: Record<string, unknown>, messageId: string): AgentEventDraft {
    const fingerprint = stableFingerprint(usage);
    this.usageFingerprints.add(fingerprint);
    return { type: "usage", data: { messageId, ...usage } };
  }
}

export function eventBelongsToSession(event: unknown, sessionId: string): boolean {
  const eventSessionId = openCodeEventSessionId(event);
  if (eventSessionId) return eventSessionId === sessionId;
  // /event is directory-wide. Only the connection handshake is safe to accept
  // without a session id; an unscoped session.error must not terminate an
  // unrelated active run.
  return stringValue(plainObject(event).type) === "server.connected";
}

function isSubmittedRunActivity(event: unknown, knownAssistantIds: ReadonlySet<string>): boolean {
  const record = plainObject(event);
  const type = stringValue(record.type);
  const properties = plainObject(record.properties);
  if (type === "message.updated") {
    const info = plainObject(properties.info);
    const messageId = stringValue(info.id ?? properties.messageID);
    return info.role === "assistant" && Boolean(messageId) && !knownAssistantIds.has(messageId);
  }
  if (type === "session.status") {
    const status = stringValue(plainObject(properties.status).type);
    return status === "busy" || status === "retry";
  }
  if (type === "message.part.updated" || type === "message.part.delta") {
    const part = plainObject(properties.part);
    const messageId = stringValue(part.messageID ?? properties.messageID);
    return Boolean(messageId) && !knownAssistantIds.has(messageId);
  }
  return type === "permission.asked" || type === "todo.updated" || type === "session.diff";
}

export function openCodePermissionReply(mode: PermissionMode, permission: string): "once" | "reject" {
  if (mode === "read-only") return "reject";
  if (mode === "workspace-write" && permission === "external_directory") return "reject";
  return "once";
}

function openCodePermissionRequest(event: unknown): { requestId: string; permission: string } | null {
  const record = plainObject(event);
  if (record.type !== "permission.asked") return null;
  const properties = plainObject(record.properties);
  const requestId = stringValue(properties.requestID ?? properties.id);
  if (!requestId) return null;
  return { requestId, permission: stringValue(properties.permission) };
}

export function openCodeEventSessionId(rawEvent: unknown): string {
  const event = plainObject(rawEvent);
  const properties = plainObject(event.properties);
  const part = plainObject(properties.part ?? event.part);
  const info = plainObject(properties.info);
  return stringValue(
    properties.sessionID
    ?? properties.sessionId
    ?? part.sessionID
    ?? part.sessionId
    ?? info.sessionID
    ?? event.sessionID
  );
}

export function createOpenCodeRichRuntime(backend: OpenCodeBackend, options: Omit<OpenCodeRichRuntimeOptions, "backend"> = {}): OpenCodeRichRuntime {
  return new OpenCodeRichRuntime({ backend, ...options });
}

function richPromptParts(input: AgentTaskInput) {
  return [
    { type: "text" as const, text: richPromptText(input) },
    ...(input.sources ?? [])
  ];
}

function richPromptText(input: AgentTaskInput): string {
  return [
    input.resources?.promptPrefix ?? "",
    input.resources?.warnings?.length ? `资源提示：\n${input.resources.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    input.prompt
  ].filter(Boolean).join("\n\n");
}

function richCliPromptText(input: AgentTaskInput): string {
  return [
    input.system?.trim()
      ? `## System instructions\nTreat the following instructions as the governing policy for this run:\n\n${input.system.trim()}`
      : "",
    richPromptText(input)
  ].filter(Boolean).join("\n\n");
}

function usageFromAssistantInfo(info: Record<string, unknown>): Record<string, unknown> | undefined {
  const tokens = plainObject(info.tokens);
  if (!Object.keys(tokens).length && typeof info.cost !== "number") return undefined;
  const cache = plainObject(tokens.cache);
  return compactRecord({
    inputTokens: finiteNumber(tokens.input),
    outputTokens: finiteNumber(tokens.output),
    reasoningTokens: finiteNumber(tokens.reasoning),
    totalTokens: finiteNumber(tokens.total),
    cacheReadTokens: finiteNumber(cache.read),
    cacheWriteTokens: finiteNumber(cache.write),
    cost: finiteNumber(info.cost)
  });
}

function usageFromStep(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const tokens = plainObject(part.tokens);
  if (!Object.keys(tokens).length && typeof part.cost !== "number") return undefined;
  const cache = plainObject(tokens.cache);
  return compactRecord({
    inputTokens: finiteNumber(tokens.input),
    outputTokens: finiteNumber(tokens.output),
    reasoningTokens: finiteNumber(tokens.reasoning),
    totalTokens: finiteNumber(tokens.total),
    cacheReadTokens: finiteNumber(cache.read),
    cacheWriteTokens: finiteNumber(cache.write),
    cost: finiteNumber(part.cost)
  });
}

function valueAvailability(record: Record<string, unknown>, key: string): "provided" | "empty" | "unavailable" {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined || record[key] === null) return "unavailable";
  const value = record[key];
  if (value === "") return "empty";
  if (Array.isArray(value) && value.length === 0) return "empty";
  if (value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0) return "empty";
  return "provided";
}

function mergeOpenCodeToolLifecycleData(
  previous: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...previous, ...current };
  preserveOpenCodeToolChannel(previous, current, merged, "input", "inputState");
  preserveOpenCodeToolChannel(previous, current, merged, "output", "outputState");
  return merged;
}

function preserveOpenCodeToolChannel(
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

function normalizeOpenCodeToolStatus(value: string): "requested" | "running" | "completed" | "failed" {
  switch (value.trim().toLowerCase()) {
    case "running":
    case "in_progress":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    default:
      return "requested";
  }
}

function openCodeToolSemanticKind(value: string): OpenCodeToolSemanticKind {
  const name = value.trim().toLowerCase().replace(/[\s.-]+/g, "_");
  if (name === "read" || name === "cat") return "read";
  if (name === "grep" || name === "glob" || name === "search" || name === "websearch" || name === "webfetch") return "search";
  if (name === "bash" || name === "shell" || name === "terminal" || name === "command") return "command";
  if (name === "write" || name === "edit" || name === "patch" || name === "apply_patch" || name === "multiedit") return "edit";
  if (name === "task" || name === "delegate_task" || name === "agent") return "agent";
  if (name === "todowrite" || name === "todo" || name === "plan") return "plan";
  if (name === "mcp" || name.startsWith("mcp_")) return "mcp";
  return "tool";
}

function toolDisplayPreview(state: Record<string, unknown>, inputState: string, outputState: string): string {
  const title = stringValue(state.title);
  if (title) return title;
  if (outputState === "provided") return truncatePreview(String(state.output));
  if (inputState === "provided") return truncatePreview(safeJson(state.input));
  return "";
}

function toolFiles(state: Record<string, unknown>): string[] {
  return arrayValue(state.attachments).map((attachment) => {
    const record = plainObject(attachment);
    const source = plainObject(record.source);
    return stringValue(source.path ?? record.filename ?? record.url);
  }).filter(Boolean);
}

function hasOpenCodeDiffContent(entry: Record<string, unknown>): boolean {
  if (openCodeDiffFile(entry)) return true;
  if (["patch", "before", "after", "status"].some((key) => stringValue(entry[key]).trim().length > 0)) return true;
  return ["additions", "deletions"].some((key) => (finiteNumber(entry[key]) ?? 0) !== 0);
}

function openCodeDiffFile(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const entry = plainObject(value);
  return stringValue(entry.file ?? entry.path).trim();
}

function appendedDelta(previous: string, next: string): { text: string; replaced: boolean } {
  if (next === previous) return { text: "", replaced: false };
  if (next.startsWith(previous)) return { text: next.slice(previous.length), replaced: false };
  return { text: next, replaced: true };
}

function openCodeEventError(value: unknown): Error {
  const error = plainObject(value);
  const data = plainObject(error.data);
  const message = stringValue(data.message ?? error.message) || "OpenCode 会话失败。";
  return new Error(message);
}

type OpenCodeAssistantCompletion = "completed" | "tool-continuation" | "failed" | "incomplete";

function openCodeAssistantMessageCompletion(value: unknown): OpenCodeAssistantCompletion {
  const record = plainObject(value);
  const info = plainObject(record.info);
  const parts = arrayValue(record.parts).map(plainObject);
  if (info.error) return "failed";
  const finishReason = openCodeAssistantFinishReason(record);
  if (finishReason) {
    if (isOpenCodeToolContinuationReason(finishReason)) return "tool-continuation";
    return isOpenCodeFailureFinishReason(finishReason) ? "failed" : "completed";
  }
  if (info.finish === true) return "completed";
  const hasTextPart = parts.some((part) => stringValue(part.type) === "text");
  return hasTextPart && plainObject(info.time).completed !== undefined ? "completed" : "incomplete";
}

function openCodeAssistantMessageError(value: unknown): Error | undefined {
  const record = plainObject(value);
  const info = plainObject(record.info);
  if (info.error) return openCodeEventError(info.error);
  const finishReason = openCodeAssistantFinishReason(record);
  return finishReason && isOpenCodeFailureFinishReason(finishReason)
    ? new Error(`OpenCode 会话失败（结束原因：${finishReason}）。`)
    : undefined;
}

function openCodeAssistantFinishReason(value: unknown): string {
  const record = plainObject(value);
  const info = plainObject(record.info);
  const stepReasons = arrayValue(record.parts)
    .map(plainObject)
    .filter((part) => stringValue(part.type) === "step-finish" || stringValue(part.type) === "step_finish")
    .map((part) => stringValue(part.reason))
    .filter(Boolean);
  const infoFinish = typeof info.finish === "string"
    ? info.finish
    : stringValue(plainObject(info.finish).reason ?? plainObject(info.finish).type);
  return stepReasons.at(-1) || infoFinish;
}

function openCodeAssistantMessageText(value: unknown): string {
  return arrayValue(plainObject(value).parts)
    .map(plainObject)
    .filter((part) => stringValue(part.type) === "text" && part.ignored !== true)
    .map((part) => stringValue(part.text))
    .join("")
    .trim();
}

function isOpenCodeToolContinuationReason(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized === "tool-calls" || normalized === "tool-call" || normalized === "tool-use" || normalized === "tool-uses";
}

function isOpenCodeFailureFinishReason(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return normalized === "error" || normalized === "failed" || normalized === "failure";
}

function plainObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stableFingerprint(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value);
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)])
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncatePreview(value: string): string {
  return value.length <= 400 ? value : `${value.slice(0, 400)}…`;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS;
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createCancelledError();
}

function createCancelledError(): Error {
  const error = new Error("OpenCode 任务已取消。");
  error.name = "AbortError";
  return error;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}

function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, signal: AbortSignal, timeoutMessage: string): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createCancelledError()));
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), remainingMs(deadline));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const state = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value: T) {
      if (state.settled) return;
      state.settled = true;
      resolvePromise(value);
    },
    reject(error: unknown) {
      if (state.settled) return;
      state.settled = true;
      rejectPromise(error);
    }
  };
  return state;
}
