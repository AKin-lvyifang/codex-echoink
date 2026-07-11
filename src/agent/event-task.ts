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
    await emitNow({ type: "message_completed", text: result.text });
    if (result.usage) await emitNow({ type: "usage", data: result.usage });
    await emitNow({ type: "completed", text: result.text });
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
    runTask: (input) => fallbackRuntime.runTask(input),
    async runTaskEvents(input, emit) {
      if (richRuntime && !shouldAttemptRichRuntime(input.timeoutMs)) {
        return await runConnectedTaskWithLifecycleEvents(fallbackRuntime, input, emit);
      }
      if (richRuntime && shouldAttemptRichRuntime(input.timeoutMs)) {
        try {
          return await richRuntime.runTaskStream(input, emit);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await emit({
            type: "fallback_started",
            backend: fallbackRuntime.kind,
            createdAt: Date.now(),
            error: message
          });
          await richRuntime.disconnect?.().catch(swallowError(`${fallbackRuntime.kind} rich runtime fallback disconnect`));
        }
      }
      return await runTaskWithLifecycleEvents(fallbackRuntime, input, emit);
    },
    async abort(runId: string) {
      await Promise.all([
        fallbackRuntime.abort(runId).catch(swallowError(`${fallbackRuntime.kind} fallback abort cleanup`)),
        richRuntime?.abort(runId).catch(swallowError(`${fallbackRuntime.kind} rich abort cleanup`))
      ]);
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
    await emitNow({ type: "message_completed", text: result.text });
    if (result.usage) await emitNow({ type: "usage", data: result.usage });
    await emitNow({ type: "completed", text: result.text });
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
