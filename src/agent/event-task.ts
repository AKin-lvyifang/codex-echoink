import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentEventTaskRuntime, AgentRichStreamRuntime, AgentTaskRuntime } from "./runtime";
import type { AgentTaskInput, AgentTaskResult } from "./types";
import { swallowError } from "../core/error-handling";

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
  richRuntime?: AgentRichStreamRuntime
): AgentEventTaskRuntime {
  let selectedRuntime: "fallback" | "rich" = "fallback";
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
      selectedRuntime = "fallback";
      return fallbackRuntime.runTask(input);
    },
    async runTaskEvents(input, emit) {
      if (richRuntime && !shouldAttemptRichRuntime(input.timeoutMs)) {
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
