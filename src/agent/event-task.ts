import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentEventTaskRuntime, AgentRichStreamRuntime, AgentTaskRuntime } from "./runtime";
import type { AgentTaskInput, AgentTaskResult } from "./types";
import { swallowError } from "../core/error-handling";
import {
  ExactWriteFenceUnavailableError,
  exactWriteFenceEventData,
  exactWriteFenceUnavailable
} from "./write-fence";

export type AgentExactWriteFenceSupport = "all-runtimes" | "rich-only" | "unsupported";

export interface AgentEventRuntimeFallbackOptions {
  exactWriteFenceSupport?: AgentExactWriteFenceSupport;
  exactWriteFenceUnavailableReason?: string;
}

export async function runTaskWithLifecycleEvents(
  runtime: AgentTaskRuntime,
  input: AgentTaskInput,
  emit: AgentEventSink
): Promise<AgentTaskResult> {
  let runId = "";
  let runStartedEmitted = false;
  let emitQueue = Promise.resolve();
  const emitNow = (event: Omit<AgentEvent, "backend" | "createdAt">): Promise<void> => {
    const next: AgentEvent = {
      ...event,
      backend: runtime.kind,
      createdAt: Date.now(),
      runId: event.runId ?? runId
    };
    emitQueue = emitQueue.then(() => Promise.resolve(emit(next)));
    return emitQueue;
  };
  const emitRunStarted = (id: string): void => {
    runId = id;
    if (runStartedEmitted) return;
    runStartedEmitted = true;
    void emitNow({ type: "run_started", runId: id });
  };

  try {
    await emitNow({ type: "connecting" });
    await runtime.connect();
    await emitNow({ type: "connected" });
    const resultPromise = runtime.runTask({
      ...input,
      onRunId: (id) => {
        emitRunStarted(id);
        input.onRunId?.(id);
      }
    });
    await emitNow({ type: "prompt_sent" });
    await emitNow({ type: "waiting" });
    const result = await resultPromise;
    if (!runStartedEmitted && result.runId) emitRunStarted(result.runId);
    await emitQueue;
    const messageData = lifecycleMessageData(runId, result);
    await emitNow({ type: "message_completed", text: result.text, data: messageData });
    if (result.usage) await emitNow({ type: "usage", data: result.usage });
    await emitNow({ type: "completed", text: result.text, data: messageData });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitQueue.catch(swallowError(`${runtime.kind} lifecycle event queue cleanup`));
    await emitNow({ type: "failed", error: message });
    throw error;
  }
}

export function createAgentEventRuntimeWithFallback(
  fallbackRuntime: AgentTaskRuntime,
  richRuntime?: AgentRichStreamRuntime,
  options: AgentEventRuntimeFallbackOptions = {}
): AgentEventTaskRuntime {
  let selectedRuntime: "fallback" | "rich" = "fallback";
  const exactWriteFenceSupport = options.exactWriteFenceSupport ?? "all-runtimes";
  const exactWriteFenceUnavailableReason = options.exactWriteFenceUnavailableReason
    ?? "当前 backend transport 不支持精确写隔离。";
  return {
    kind: fallbackRuntime.kind,
    connect: () => fallbackRuntime.connect(),
    disconnect: async () => {
      await Promise.all([
        fallbackRuntime.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} fallback disconnect cleanup`)),
        richRuntime?.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} rich disconnect cleanup`))
      ]);
    },
    listModels: () => fallbackRuntime.listModels(),
    listAgents: fallbackRuntime.listAgents ? () => fallbackRuntime.listAgents?.() ?? Promise.resolve([]) : undefined,
    hasNativeSession: fallbackRuntime.hasNativeSession ? (sessionId) => fallbackRuntime.hasNativeSession!(sessionId) : undefined,
    deleteNativeSession: fallbackRuntime.deleteNativeSession ? (sessionId) => fallbackRuntime.deleteNativeSession!(sessionId) : undefined,
    runTask: (input) => {
      throwIfTaskAborted(input.abortSignal);
      if (input.requireExactWriteFence && exactWriteFenceSupport !== "all-runtimes") {
        throw exactWriteFenceUnavailable(
          fallbackRuntime.kind,
          exactWriteFenceSupport === "rich-only"
            ? "普通任务路径不具备精确写隔离，必须使用 rich 事件运行时。"
            : exactWriteFenceUnavailableReason
        );
      }
      selectedRuntime = "fallback";
      return fallbackRuntime.runTask(input);
    },
    async runTaskEvents(input, emit) {
      throwIfTaskAborted(input.abortSignal);
      if (input.requireExactWriteFence && exactWriteFenceSupport === "unsupported") {
        const error = exactWriteFenceUnavailable(
          fallbackRuntime.kind,
          exactWriteFenceUnavailableReason
        );
        await emitExactWriteFenceFailure(emit, fallbackRuntime.kind, error);
        throw error;
      }
      if (richRuntime && !shouldAttemptRichRuntime(input.timeoutMs)) {
        if (input.requireExactWriteFence && exactWriteFenceSupport === "rich-only") {
          const error = exactWriteFenceUnavailable(
            fallbackRuntime.kind,
            "任务超时预算不足以启动 rich transport，且禁止降级到普通 CLI。"
          );
          await emitExactWriteFenceFailure(emit, fallbackRuntime.kind, error);
          throw error;
        }
        selectedRuntime = "fallback";
        return await runConnectedTaskWithLifecycleEvents(fallbackRuntime, input, emit);
      }
      if (richRuntime && shouldAttemptRichRuntime(input.timeoutMs)) {
        selectedRuntime = "rich";
        let richOutputStarted = false;
        let promptSubmitted = false;
        try {
          return await richRuntime.runTaskStream(input, async (event) => {
            if (isRichOutputEvent(event)) richOutputStarted = true;
            if (event.data?.promptSubmitted === true) promptSubmitted = true;
            await emit(event);
          });
        } catch (error) {
          // Once a provider may have accepted the prompt, starting the fallback
          // runtime could execute writes twice. Recovery must stay on the same
          // native session instead of launching a second task.
          if (input.abortSignal?.aborted || promptSubmitted || richOutputStarted) throw error;
          if (input.requireExactWriteFence && exactWriteFenceSupport === "rich-only") {
            if (error instanceof ExactWriteFenceUnavailableError) throw error;
            const fenceError = exactWriteFenceUnavailable(
              fallbackRuntime.kind,
              `rich transport 在提交 prompt 前失败，禁止降级到未证明精确隔离的普通 CLI：${errorMessage(error)}`,
              error
            );
            await emitExactWriteFenceFailure(emit, fallbackRuntime.kind, fenceError);
            throw fenceError;
          }
          const message = error instanceof Error ? error.message : String(error);
          await emit({
            type: "fallback_started",
            backend: fallbackRuntime.kind,
            createdAt: Date.now(),
            error: message,
            data: { streamSource: "lifecycle", promptSubmitted: false }
          });
          await richRuntime.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} rich runtime fallback disconnect`));
        }
      }
      if (input.requireExactWriteFence && exactWriteFenceSupport === "rich-only") {
        const error = exactWriteFenceUnavailable(
          fallbackRuntime.kind,
          "rich transport 不可用，禁止降级到未证明精确隔离的普通 CLI。"
        );
        await emitExactWriteFenceFailure(emit, fallbackRuntime.kind, error);
        throw error;
      }
      selectedRuntime = "fallback";
      return await runTaskWithLifecycleEvents(fallbackRuntime, input, emit);
    },
    async abort(runId: string) {
      if (selectedRuntime === "rich" && richRuntime) {
        await richRuntime.abort(runId).catch(swallowError(`${fallbackRuntime.kind} rich abort cleanup`));
        return;
      }
      await fallbackRuntime.abort(runId).catch(swallowError(`${fallbackRuntime.kind} fallback abort cleanup`));
    }
  };
}

async function emitExactWriteFenceFailure(
  emit: AgentEventSink,
  backend: AgentTaskRuntime["kind"],
  error: ExactWriteFenceUnavailableError
): Promise<void> {
  await emit({
    type: "failed",
    backend,
    createdAt: Date.now(),
    error: error.message,
    data: exactWriteFenceEventData(error)
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfTaskAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Agent 任务已取消。");
}

async function runConnectedTaskWithLifecycleEvents(
  runtime: AgentTaskRuntime,
  input: AgentTaskInput,
  emit: AgentEventSink
): Promise<AgentTaskResult> {
  let runId = "";
  let runStartedEmitted = false;
  let emitQueue = Promise.resolve();
  const emitNow = (event: Omit<AgentEvent, "backend" | "createdAt">): Promise<void> => {
    const next: AgentEvent = {
      ...event,
      backend: runtime.kind,
      createdAt: Date.now(),
      runId: event.runId ?? runId
    };
    emitQueue = emitQueue.then(() => Promise.resolve(emit(next)));
    return emitQueue;
  };
  const emitRunStarted = (id: string): void => {
    runId = id;
    if (runStartedEmitted) return;
    runStartedEmitted = true;
    void emitNow({ type: "run_started", runId: id });
  };
  try {
    const resultPromise = runtime.runTask({
      ...input,
      onRunId: (id) => {
        emitRunStarted(id);
        input.onRunId?.(id);
      }
    });
    await emitNow({ type: "prompt_sent" });
    await emitNow({ type: "waiting" });
    const result = await resultPromise;
    if (!runStartedEmitted && result.runId) emitRunStarted(result.runId);
    await emitQueue;
    const messageData = lifecycleMessageData(runId, result);
    await emitNow({ type: "message_completed", text: result.text, data: messageData });
    if (result.usage) await emitNow({ type: "usage", data: result.usage });
    await emitNow({ type: "completed", text: result.text, data: messageData });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitQueue.catch(swallowError(`${runtime.kind} connected lifecycle event queue cleanup`));
    await emitNow({ type: "failed", error: message });
    throw error;
  }
}

function shouldAttemptRichRuntime(timeoutMs: number | undefined): boolean {
  return !timeoutMs || !Number.isFinite(timeoutMs) || timeoutMs >= 1000;
}

function lifecycleMessageData(runId: string, result: AgentTaskResult): Record<string, unknown> {
  return {
    streamSource: "lifecycle",
    messageId: `${runId || result.runId || "lifecycle"}:message:1`
  };
}

function isRichOutputEvent(event: AgentEvent): boolean {
  return event.type === "message_delta"
    || event.type === "message_completed"
    || event.type === "thinking_delta"
    || event.type === "thinking_completed"
    || event.type === "tool_call_requested"
    || event.type === "tool_call_delta"
    || event.type === "tool_call_completed"
    || event.type === "tool_call_failed"
    || event.type === "permission_requested"
    || event.type === "file_status"
    || event.type === "plan_updated";
}
