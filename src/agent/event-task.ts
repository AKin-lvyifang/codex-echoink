import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentEventTaskRuntime, AgentRichStreamRuntime, AgentTaskRuntime } from "./runtime";
import {
  NativeRunRegistrationError,
  NativeSessionStaleError,
  isNativeRunRegistrationError,
  isNativeSessionStaleError,
  type AgentTaskInput,
  type AgentTaskResult
} from "./types";
import { swallowError } from "../core/error-handling";
import {
  ExactWriteFenceUnavailableError,
  exactWriteFenceEventData,
  exactWriteFenceUnavailable
} from "./write-fence";

export type AgentExactWriteFenceSupport = "all-runtimes" | "rich-only" | "unsupported";
export type AgentNativeRegistrationSupport = "all-runtimes" | "rich-only" | "unsupported";

export interface AgentEventRuntimeFallbackOptions {
  exactWriteFenceSupport?: AgentExactWriteFenceSupport;
  exactWriteFenceUnavailableReason?: string;
  nativeRegistrationBeforePromptSupport?: AgentNativeRegistrationSupport;
  nativeRegistrationBeforePromptUnavailableReason?: string;
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
      onRunId: async (id, native) => {
        emitRunStarted(id);
        await input.onRunId?.(id, native);
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
  const nativeRegistrationSupport = options.nativeRegistrationBeforePromptSupport ?? "all-runtimes";
  const nativeRegistrationUnavailableReason = options.nativeRegistrationBeforePromptUnavailableReason
    ?? "fallback transport 无法在 Prompt 前提供 backend-owned Native execution ID。";
  const capabilitySnapshot = () => (
    richRuntime?.capabilitySnapshot?.()
    ?? fallbackRuntime.capabilitySnapshot?.()
  );
  const hasNativeSession = richRuntime?.hasNativeSession || fallbackRuntime.hasNativeSession
    ? async (sessionId: string): Promise<boolean> => {
      const snapshot = richRuntime?.capabilitySnapshot?.();
      if (
        snapshot?.nativeSession.inspectExistence
        && richRuntime?.hasNativeSession
      ) {
        return await richRuntime.hasNativeSession(sessionId);
      }
      if (fallbackRuntime.hasNativeSession) {
        return await fallbackRuntime.hasNativeSession(sessionId);
      }
      throw new Error("Native session existence inspection is unavailable.");
    }
    : undefined;
  const deleteNativeSession = richRuntime?.deleteNativeSession || fallbackRuntime.deleteNativeSession
    ? async (sessionId: string): Promise<boolean> => {
      const snapshot = richRuntime?.capabilitySnapshot?.();
      if (
        snapshot?.nativeSession.delete
        && richRuntime?.deleteNativeSession
      ) {
        return await richRuntime.deleteNativeSession(sessionId);
      }
      if (fallbackRuntime.deleteNativeSession) {
        return await fallbackRuntime.deleteNativeSession(sessionId);
      }
      return false;
    }
    : undefined;
  return {
    kind: fallbackRuntime.kind,
    connect: async () => {
      const status = await fallbackRuntime.connect();
      if (richRuntime?.capabilitySnapshot) {
        await richRuntime.connect().catch(
          swallowError(`${fallbackRuntime.kind} rich capability probe`)
        );
      }
      return status;
    },
    disconnect: async () => {
      await Promise.all([
        fallbackRuntime.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} fallback disconnect cleanup`)),
        richRuntime?.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} rich disconnect cleanup`))
      ]);
    },
    capabilitySnapshot,
    listModels: () => fallbackRuntime.listModels(),
    listAgents: fallbackRuntime.listAgents ? () => fallbackRuntime.listAgents?.() ?? Promise.resolve([]) : undefined,
    hasNativeSession,
    deleteNativeSession,
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
      failNativeRegistrationBeforeFallback(
        input,
        fallbackRuntime.kind,
        nativeRegistrationSupport,
        nativeRegistrationUnavailableReason,
        "普通任务路径只能使用 fallback transport"
      );
      selectedRuntime = "fallback";
      return fallbackRuntime.runTask(input);
    },
    async runTaskEvents(input, emit) {
      throwIfTaskAborted(input.abortSignal);
      if (
        input.requireNativeRegistrationBeforePrompt
        && nativeRegistrationSupport === "unsupported"
      ) {
        failNativeRegistrationBeforeFallback(
          input,
          fallbackRuntime.kind,
          nativeRegistrationSupport,
          nativeRegistrationUnavailableReason,
          "当前没有 transport 能满足 Native identity barrier"
        );
      }
      if (input.requireExactWriteFence && exactWriteFenceSupport === "unsupported") {
        const error = exactWriteFenceUnavailable(
          fallbackRuntime.kind,
          exactWriteFenceUnavailableReason
        );
        await emitExactWriteFenceFailure(emit, fallbackRuntime.kind, error);
        throw error;
      }
      if (richRuntime && !shouldAttemptRichRuntime(input.timeoutMs)) {
        failManagedResumeBeforeFallback(
          input,
          fallbackRuntime.kind,
          "任务超时预算不足以安全恢复显式 Native session"
        );
        failNativeRegistrationBeforeFallback(
          input,
          fallbackRuntime.kind,
          nativeRegistrationSupport,
          nativeRegistrationUnavailableReason,
          "任务超时预算不足以启动 rich transport"
        );
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
          if (
            input.abortSignal?.aborted
            || promptSubmitted
            || richOutputStarted
            || isNativeRunRegistrationError(error)
            || isNativeSessionStaleError(error)
          ) {
            throw error;
          }
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
          failManagedResumeBeforeFallback(
            input,
            fallbackRuntime.kind,
            `rich transport 在提交 prompt 前失败：${errorMessage(error)}`,
            error
          );
          if (
            input.requireNativeRegistrationBeforePrompt
            && nativeRegistrationSupport !== "all-runtimes"
          ) {
            await richRuntime.disconnect?.().catch(
              swallowError(`${fallbackRuntime.kind} rich runtime registration-barrier cleanup`)
            );
          }
          failNativeRegistrationBeforeFallback(
            input,
            fallbackRuntime.kind,
            nativeRegistrationSupport,
            nativeRegistrationUnavailableReason,
            `rich transport 在提交 Prompt 前失败：${errorMessage(error)}`,
            error
          );
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
      failManagedResumeBeforeFallback(
        input,
        fallbackRuntime.kind,
        "rich transport 不可用，无法安全恢复显式 Native session"
      );
      failNativeRegistrationBeforeFallback(
        input,
        fallbackRuntime.kind,
        nativeRegistrationSupport,
        nativeRegistrationUnavailableReason,
        "rich transport 不可用"
      );
      selectedRuntime = "fallback";
      return await runTaskWithLifecycleEvents(fallbackRuntime, input, emit);
    },
    async abort(runId: string) {
      // Fulfilment is an acknowledgement boundary for guarded callers. Do not
      // turn a provider rejection into success here; cleanup-only call sites
      // must choose and document their own best-effort catch.
      if (selectedRuntime === "rich" && richRuntime) {
        await richRuntime.abort(runId);
        return;
      }
      await fallbackRuntime.abort(runId);
    }
  };
}

function failNativeRegistrationBeforeFallback(
  input: AgentTaskInput,
  backend: AgentTaskRuntime["kind"],
  support: AgentNativeRegistrationSupport,
  unavailableReason: string,
  reason: string,
  cause?: unknown
): void {
  if (
    !input.requireNativeRegistrationBeforePrompt
    || support === "all-runtimes"
  ) {
    return;
  }
  throw new NativeRunRegistrationError(
    `${backend} 任务要求在 Prompt 前耐久登记 backend-owned Native execution ID；${reason}，禁止降级。${unavailableReason}`,
    cause
  );
}

function failManagedResumeBeforeFallback(
  input: AgentTaskInput,
  backend: AgentTaskRuntime["kind"],
  reason: string,
  cause?: unknown
): void {
  const nativeSessionId = input.nativeSessionId?.trim() ?? "";
  if (!input.requireNativeSessionResume || !nativeSessionId) return;
  throw new NativeSessionStaleError(
    `${backend} Native session requires Harness retirement before fallback: ${nativeSessionId}; ${reason}`,
    nativeSessionId,
    cause
  );
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
      onRunId: async (id, native) => {
        emitRunStarted(id);
        await input.onRunId?.(id, native);
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
