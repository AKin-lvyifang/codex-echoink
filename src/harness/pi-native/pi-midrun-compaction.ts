import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, getLatestCompactionEntry, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, isContextOverflow, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model } from "@earendil-works/pi-ai";
import { assistantHasPartialOutput } from "../pi/provider-failure";
import type { PiEffectiveInputBudget } from "./pi-effective-input-budget";
import { ECHOINK_PI_CODING_AGENT_VERSION } from "./pi-session-durability";

interface PiMidrunCompactionOptions {
  session: AgentSession;
  codingAgentVersion: string;
  budget: Readonly<PiEffectiveInputBudget>;
  measure(context: Readonly<Context>, model: Model<Api>): Promise<number>;
  maintenanceCheckpoint?(): Promise<string | undefined>;
}

type LiveRequestBoundary = { messages: AgentMessage[]; signal: AbortSignal };
type CompactionReason = "threshold" | "overflow";

export function installPiMidrunCompaction(options: PiMidrunCompactionOptions): void {
  const { session, budget } = options;
  const { agent } = session;
  const refresh = agent.prepareNextTurnWithContext;
  const transform = agent.transformContext;
  // Pi SDK has no public in-flight compaction API in 0.82.1. The manual API aborts the agent.
  const native = session as unknown as {
    _runAutoCompaction?: (reason: CompactionReason, willRetry: false) => Promise<boolean>;
    _checkCompaction?: (message: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
  };
  if (options.codingAgentVersion !== ECHOINK_PI_CODING_AGENT_VERSION
    || typeof native._runAutoCompaction !== "function" || typeof native._checkCompaction !== "function" || !refresh) {
    throw new Error(`EchoInk 请求压缩适配要求 Pi ${ECHOINK_PI_CODING_AGENT_VERSION} 的原生压缩和轮间钩子，请检查插件版本。`);
  }
  const compact = native._runAutoCompaction.bind(session);
  const checkNativeCompaction = native._checkCompaction.bind(session);
  const stream = agent.streamFunction;
  let pending: LiveRequestBoundary | undefined;
  let toolAssistant: AgentMessage | undefined;
  let compacting: AbortSignal | undefined;
  let failure: Error | undefined;
  let compactedForRequest = false;

  session.subscribe(event => {
    if (event.type !== "agent_settled") return;
    pending = undefined;
    toolAssistant = undefined;
    failure = undefined;
    compactedForRequest = false;
  });

  // The live request handles explicit Provider errors before Pi publishes
  // them. Preserve Pi's separate checks based on response usage.
  native._checkCompaction = async (message, skipAbortedCheck) => {
    if (skipAbortedCheck === false || message.stopReason === "error" || compactedForRequest || failure
      || !isContextOverflow(message, session.model?.contextWindow ?? 0)) return false;
    return await checkNativeCompaction(message, skipAbortedCheck);
  };

  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const update = await refresh(turn, signal);
    toolAssistant = turn.toolResults.length ? turn.message : undefined;
    return update;
  };

  agent.transformContext = async (messages, signal) => {
    // Pi passes its live loop array here, including the new prompt and any
    // steering. The stream receives a separate, transformed LLM payload.
    if (signal) pending = { messages, signal };
    return await transform?.(messages, signal) ?? messages;
  };

  agent.streamFunction = async (model, context, streamOptions) => {
    compacting?.throwIfAborted();
    streamOptions?.signal?.throwIfAborted();
    if (failure) throw failure;
    // Pi sends summaries directly through this stream with their own signal,
    // without transforming live conversation messages first.
    const boundary = pending;
    if (!boundary || boundary.signal !== streamOptions?.signal) return await stream(model, context, streamOptions);
    pending = undefined;
    compactedForRequest = false;
    const { signal } = boundary;
    signal.throwIfAborted();
    const tokens = await options.measure(context, model);
    signal.throwIfAborted();
    const request = tokens <= budget.effectiveInputBudget ? context : await compactRequest(context, model, boundary, "threshold");
    const first = await streamBeforeOverflow(await stream(model, request, streamOptions), model.contextWindow);
    if (first) return first;
    signal.throwIfAborted();
    if (compactedForRequest) fail("provider_history_still_too_long");

    const retry = await compactRequest(context, model, boundary, "overflow");
    const second = await streamBeforeOverflow(await stream(model, retry, streamOptions), model.contextWindow);
    if (second) return second;
    signal.throwIfAborted();
    return fail("provider_history_still_too_long");
  };

  function fail(message: string): never {
    failure = new Error(message);
    throw failure;
  }

  async function compactRequest(context: Context, model: Model<Api>, boundary: LiveRequestBoundary, reason: CompactionReason): Promise<Context> {
    compactedForRequest = true;
    const { signal } = boundary;
    const previous = latestCompactionId(session);
    const saved = session.sessionManager.buildSessionContext().messages;
    const live = new Set(boundary.messages);
    // Pi removes the last failed reply from memory for an automatic retry but
    // leaves it on disk. Rebuilding after compaction must preserve that choice.
    const omittedErrors = new Set(saved.filter(message => message.role === "assistant"
      && message.stopReason === "error" && !live.has(message)));
    let anchor = toolAssistant && live.has(toolAssistant) ? toolAssistant : undefined;
    for (let index = boundary.messages.length - 1; !anchor && index >= 0; index--) {
      const message = boundary.messages[index];
      if (message.role === "user") anchor = message;
    }
    const settings = session.settingsManager;
    const originalKeep = settings.getCompactionKeepRecentTokens();
    const anchorIndex = anchor ? saved.lastIndexOf(anchor) : -1;
    const keepRecentTokens = anchorIndex < 0 ? originalKeep : 1 + saved.slice(anchorIndex + 1)
      .reduce((sum, message) => sum + estimateTokens(message), 0);
    const cancelSummary = () => session.abortCompaction();
    compacting = signal;
    signal.addEventListener("abort", cancelSummary, { once: true });
    settings.applyOverrides({ compaction: { keepRecentTokens } });
    try {
      await compact(reason, false);
    } finally {
      settings.applyOverrides({ compaction: { keepRecentTokens: originalKeep } });
      signal.removeEventListener("abort", cancelSummary);
      compacting = undefined;
    }
    signal.throwIfAborted();

    if (latestCompactionId(session) === previous) {
      fail("provider_history_compaction_failed");
    }

    const messages = session.sessionManager.buildSessionContext().messages.filter(message => !omittedErrors.has(message));
    agent.state.messages = messages.slice();
    const checkpoint = await options.maintenanceCheckpoint?.();
    signal.throwIfAborted();
    if (checkpoint) {
      // Keep the checkpoint in this live loop. Pi's original entries and summary
      // remain the durable history, so reopening never adds an extra user turn.
      messages.splice(1, 0, { role: "custom", customType: "echoink-maintenance-compaction-checkpoint-v1",
        content: checkpoint, display: false, timestamp: Date.now() });
    }
    boundary.messages.splice(0, boundary.messages.length, ...messages);
    const transformed = await transform?.(boundary.messages, signal) ?? boundary.messages;
    const request = { ...context, messages: await agent.convertToLlm(transformed) };
    const after = await options.measure(request, model);
    signal.throwIfAborted();
    if (after > budget.effectiveInputBudget) {
      fail("provider_history_still_too_long");
    }
    return request;
  }
}

/** Hold only an empty start event until we know whether the request was rejected. */
async function streamBeforeOverflow(source: AssistantMessageEventStream, contextWindow: number): Promise<AssistantMessageEventStream | undefined> {
  const iterator = source[Symbol.asyncIterator]();
  let first = await iterator.next();
  const start = !first.done && first.value.type === "start" && !assistantHasPartialOutput(first.value.partial) ? first.value : undefined;
  if (start) first = await iterator.next();
  if (first.done) return source;
  if (first.value.type === "error" && first.value.reason !== "aborted"
    && !assistantHasPartialOutput(first.value.error) && isContextOverflow(first.value.error, contextWindow)) {
    await iterator.return?.();
    return undefined;
  }

  const output = createAssistantMessageEventStream();
  if (start) output.push(start);
  output.push(first.value);
  void (async () => {
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) output.push(event);
    output.end(await source.result());
  })();
  return output;
}

function latestCompactionId(session: AgentSession): string | undefined {
  return getLatestCompactionEntry(session.sessionManager.getBranch())?.id;
}
