import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context
} from "@earendil-works/pi-ai";
import { estimateUsageInputTokens, estimateUsageOutputTokens, USAGE_TOKEN_STANDARD } from "./token-estimator";

export type UsageSource = "conversation" | "background" | "connection-test";
export interface UsageRequestEvent {
  readonly requestId: string;
  readonly recordedAt: number;
  readonly provider: string;
  readonly model: string;
  readonly source: UsageSource;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly status: "completed" | "failed" | "cancelled";
  readonly standard: typeof USAGE_TOKEN_STANDARD;
}

export interface ObserveUsageOptions {
  readonly context: Readonly<Context>;
  readonly provider: string;
  readonly model: string;
  readonly source: UsageSource;
  readonly recordUsage: (event: UsageRequestEvent) => Promise<void> | void;
  readonly requestId?: string;
  readonly now?: () => number;
  /** Native document contents omitted from the text Context, when available. */
  readonly additionalInputTokens?: number;
  /** Transport-specific visible output kept outside AssistantMessage.content. */
  readonly estimateOutputTokens?: (message: Readonly<AssistantMessage>) => number;
  readonly onRecordError?: () => void;
}

/** Each actual dispatch owns one wrapper; stream snapshots are not increments. */
export function observeUsageStream(
  upstream: AssistantMessageEventStream,
  options: ObserveUsageOptions
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const requestId = options.requestId ?? crypto.randomUUID();
  const now = options.now ?? Date.now;
  const recordedAt = now();
  const additionalInputTokens = Number.isSafeInteger(options.additionalInputTokens)
    ? Math.max(0, options.additionalInputTokens!) : 0;
  const inputTokens = estimateUsageInputTokens(options.context) + additionalInputTokens;
  let settled = false;
  let partial: AssistantMessage | undefined;
  const interrupted = (): AssistantMessage => ({ role: "assistant", api: partial?.api ?? "openai-completions",
    provider: options.provider, model: options.model, timestamp: now(), content: partial?.content ?? [],
    usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: "provider_stream_interrupted" });
  const record = async (message: AssistantMessage, status: UsageRequestEvent["status"]) => {
    if (settled) return;
    settled = true;
    const outputTokens = options.estimateOutputTokens?.(message) ?? estimateUsageOutputTokens(message);
    // A local admission error or rejected request is not evidence of inference.
    if (status !== "completed" && outputTokens === 0) return;
    try {
      await options.recordUsage({ requestId, recordedAt, provider: options.provider, model: options.model,
        source: options.source, inputTokens, outputTokens, status, standard: USAGE_TOKEN_STANDARD });
    } catch {
      try { options.onRecordError?.(); } catch { /* Statistics never fail inference. */ }
    }
  };
  void (async () => {
    try {
      for await (const event of upstream) {
        if ("partial" in event) partial = event.partial;
        if (event.type === "done") await record(event.message, "completed");
        else if (event.type === "error") {
          const message = estimateUsageOutputTokens(event.error) > 0 ? event.error : partial ?? event.error;
          await record(message, event.reason === "aborted" ? "cancelled" : "failed");
        }
        output.push(event);
      }
      if (!settled) {
        const error = interrupted();
        await record(error, "failed");
        output.push({ type: "error", reason: "error", error });
      }
      output.end();
    } catch {
      const error = interrupted();
      await record(error, "failed");
      output.push({ type: "error", reason: "error", error });
      output.end();
    }
  })();
  return output;
}
