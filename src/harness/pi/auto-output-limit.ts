import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamOptions
} from "@earendil-works/pi-ai";
import { estimatePiContextTokens } from "../pi-native/pi-context-budget";
import {
  assistantHasPartialOutput,
  isProviderQuotaExhausted,
  providerFailureHttpStatus,
  sanitizeProviderFailureDetail,
  type AssistantProviderFailure
} from "./provider-failure";

export interface PiAutoOutputLimitPolicy {
  /** null means this model already has a reliable declared output limit. */
  read(model: Readonly<Model<Api>>): {
    maxOutputTokens?: number;
    contextWindow?: number;
  } | null;
  remember(model: Readonly<Model<Api>>, limits: {
    maxOutputTokens?: number;
    contextWindow?: number;
  }): void | Promise<void>;
}

/** Shared only by the native-document request and its existing text fallback. */
export interface PiAutoOutputLimitRequestState {
  retried: boolean;
  deadline?: number;
}

const AUTO_OUTPUT_TOKENS = 262_144;
const FALLBACK_OUTPUT_TOKENS = 8_192;
const CONTEXT_MARGIN = 4_096;
export const PI_OUTPUT_LIMIT_REJECTED = "provider_output_limit_rejected";
export const PI_AUTO_OUTPUT_REQUEST_REJECTED = "provider_auto_output_request_rejected";

type LearnedLimits = { maxOutputTokens?: number; contextWindow?: number };
type RetryLimit = { maxTokens: number; remember: LearnedLimits; explicit: boolean };

/** Only the request copy changes; Session/model admission budgets stay intact. */
export function streamWithPiAutoOutputLimit<T extends StreamOptions>(input: {
  model: Model<Api>;
  context: Context;
  options: T;
  policy?: PiAutoOutputLimitPolicy;
  state?: PiAutoOutputLimitRequestState;
  start(model: Model<Api>, options: T): AssistantMessageEventStream;
}): AssistantMessageEventStream {
  if (!input.policy || input.options.maxTokens !== undefined) {
    return input.start(input.model, input.options);
  }
  const limits = input.policy.read(input.model);
  if (limits === null) return input.start(input.model, input.options);
  const state = input.state ?? { retried: false };
  if (state.deadline === undefined && positiveInteger(input.options.timeoutMs)) {
    state.deadline = Date.now() + input.options.timeoutMs!;
  }
  const knownWindow = positiveInteger(limits.contextWindow);
  const initialLimit = positiveInteger(limits.maxOutputTokens) ?? AUTO_OUTPUT_TOKENS;
  const estimatedInput = knownWindow ? estimatePiContextTokens(input.context).tokens : 0;
  const maxTokens = knownWindow
    ? Math.min(initialLimit, Math.max(1, knownWindow - estimatedInput - CONTEXT_MARGIN))
    : initialLimit;
  const output = createAssistantMessageEventStream();
  void (async () => {
    let observed = false;
    let retry: RetryLimit | undefined;
    let partial: AssistantMessage | undefined;
    let status: number | null = null;
    let limit = maxTokens;
    for (;;) {
      let failure: AssistantMessage | undefined;
      let aborted = false;
      try {
        const requestModel = { ...input.model, maxTokens: limit, contextWindow: 0 };
        const options: T = {
          ...input.options,
          maxTokens: limit,
          ...(state.deadline === undefined ? {} : {
            timeoutMs: Math.max(1, state.deadline - Date.now())
          }),
          onPayload: async (payload, model) => {
            const transformed = await input.options.onPayload?.(payload, model) ?? payload;
            return constrainOutputPayload(transformed, model, limit);
          },
          onResponse: async (response, model) => {
            status = response.status;
            await input.options.onResponse?.(response, model);
          }
        };
        const upstream = input.start(requestModel, options);
        for await (const event of upstream) {
          if (event.type === "error") {
            failure = event.error;
            aborted = event.reason === "aborted";
            break;
          }
          observed = true; // Even an empty start closes the regeneration gate.
          if ("partial" in event) partial = event.partial;
          else if (event.type === "done") partial = event.message;
          if (event.type === "done" && retry && (event.reason === "stop" || event.reason === "toolUse")) {
            try { await input.policy!.remember(input.model, retry.remember); }
            catch { /* A settings write must not turn a completed answer into an error. */ }
          }
          output.push(event);
        }
        if (!failure) return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failure = failureMessage(input.model, message, partial);
      }
      if (aborted || input.options.signal?.aborted || failure.stopReason === "aborted") {
        output.push({ type: "error", reason: "aborted", error: { ...failure, stopReason: "aborted" } });
        return;
      }
      if (retry) {
        const rejection = outputLimitRetry(failure, status);
        const secrets = input.options.apiKey ? [input.options.apiKey] : [];
        const detail = sanitizeProviderFailureDetail(status,
          (failure as AssistantProviderFailure).echoInkProviderFailure ?? failure.errorMessage, secrets);
        // Structured bodies without an error.message must never become prose.
        const plainMessage = failure.errorMessage && !/[{}[\]]/u.test(failure.errorMessage)
          ? failure.errorMessage : undefined;
        // Deliberately contains no Pi retry/overflow/continuation trigger.
        output.push({ type: "error", reason: "error", error: {
          ...failure,
          errorMessage: rejection?.explicit ? PI_OUTPUT_LIMIT_REJECTED : PI_AUTO_OUTPUT_REQUEST_REJECTED,
          echoInkProviderFailure: detail?.message || !plainMessage ? detail
            : sanitizeProviderFailureDetail(status, { ...detail, message: plainMessage }, secrets)
        } as AssistantProviderFailure });
        return;
      }
      const candidate = maxTokens > input.model.maxTokens
        && !observed && !assistantHasPartialOutput(failure) && !state.retried
        && (state.deadline === undefined || Date.now() < state.deadline)
        ? outputLimitRetry(failure, status) : null;
      if (!candidate || candidate.maxTokens >= limit) {
        output.push({ type: "error", reason: "error", error: failure });
        return;
      }
      state.retried = true;
      retry = candidate;
      limit = knownWindow
        ? Math.min(candidate.maxTokens, Math.max(1, knownWindow - estimatedInput - CONTEXT_MARGIN))
        : candidate.maxTokens;
      status = null;
    }
  })();
  return output;
}

function constrainOutputPayload(payload: unknown, model: Model<Api>, maxTokens: number): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(PI_OUTPUT_LIMIT_REJECTED);
  }
  const constrained = { ...payload } as Record<string, unknown>;
  const fields = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
  const present = fields.filter((field) => Object.hasOwn(constrained, field));
  const fallback = model.api === "anthropic-messages" ? "max_tokens"
    : model.api === "openai-completions" ? (model as Model<"openai-completions">).compat?.maxTokensField ?? "max_completion_tokens"
    : "max_output_tokens";
  for (const field of present.length ? present : [fallback]) constrained[field] = maxTokens;
  return constrained;
}

/** Only an unstarted HTTP 400/422 can be evidence for an output negotiation. */
function outputLimitRetry(error: AssistantMessage, status: number | null): RetryLimit | null {
  const detail = (error as AssistantProviderFailure).echoInkProviderFailure;
  const message = error.errorMessage ?? "";
  status = status ?? detail?.status ?? providerFailureHttpStatus(message);
  if (status !== 400 && status !== 422) return null;
  const text = [message, detail?.code, detail?.param, detail?.message].filter(Boolean).join(" ").slice(0, 16_384);
  if (isProviderQuotaExhausted(text) ||
    /auth|api[ _-]?key|unauthori[sz]ed|forbidden|permission denied|rate[ _-]?limit|too many requests|overloaded|network|timed?\s*out|timeout|abort|cancel|content[_ -]?(?:filter|policy)|safety|sensitive|余额|鉴权|限流/iu.test(text) ||
    /unsupported[_ ]parameter|unknown[_ ]parameter|parameter[^.\n]{0,80}(?:not supported|unsupported)|budget_tokens|thinking[^.\n]{0,60}(?:budget|conflict|must|invalid|not supported)|(?:pdf|document|file|block)[^.\n]{0,60}(?:unsupported|not supported)|(?:unsupported|not supported)[^.\n]{0,60}(?:pdf|document|file|block)/iu.test(text)) {
    return null;
  }
  // These messages declare an independent input cap; reducing output cannot fix it.
  if (/prompt is too long|maximum (?:input|prompt)|range of (?:input|prompt) length|(?:input|prompt)[^.\n]{0,60}(?:must be|should be)[^.\n]{0,30}(?:less|shorter)/iu.test(text)) return null;
  const total = totalContextLimit(text);
  if (!total && /(?:input|prompt)[_ ](?:tokens?|length)[^.\n]{0,80}(?:exceeds?|too (?:long|large))/iu.test(text)) return null;
  const explicitCap = explicitOutputCap(text);
  if (explicitCap) return { maxTokens: explicitCap, remember: { maxOutputTokens: explicitCap }, explicit: true };
  if (total) {
    if (total.input >= total.window || total.window - total.input <= CONTEXT_MARGIN) return null;
    return {
      maxTokens: total.window - total.input - CONTEXT_MARGIN,
      remember: { contextWindow: total.window },
      explicit: true
    };
  }
  // Leave genuine/ambiguous input overflow to the existing compaction path.
  if (/context[_ ](?:length|window|limit)|context.{0,30}(?:maximum|exceed|limit)|input.{0,40}(?:too long|too large|exceed)|prompt.{0,40}(?:too long|too large|exceed)|request_too_large|too many (?:input )?tokens/iu.test(text)) return null;
  return { maxTokens: FALLBACK_OUTPUT_TOKENS, remember: { maxOutputTokens: FALLBACK_OUTPUT_TOKENS }, explicit: false };
}

function explicitOutputCap(text: string): number | undefined {
  const patterns = [
    /(?:range\s+of\s+[`'"]?max_tokens[`'"]?[^[\n]{0,80}|[`'"]?max_tokens[`'"]?[^\n]{0,100}range[^[\n]{0,25})\[\s*\d[\d,]*\s*,\s*([\d,]+)\s*\]/iu,
    /supports at most\s+([\d,]+)\s+(?:completion|output) tokens/iu,
    /max_tokens\s*[:=]?\s*\d[\d,]*\s*(?:>|is greater than)\s*([\d,]+)[^.\n]{0,100}maximum allowed[^.\n]{0,30}output/iu,
    /does not support max[ _]tokens\s*>\s*([\d,]+)/iu
  ];
  for (const pattern of patterns) {
    const number = tokenCount(text.match(pattern)?.[1]);
    if (number) return number;
  }
  return undefined;
}

function totalContextLimit(text: string): { window: number; input: number } | null {
  const sum = text.match(/input length and max_tokens exceed context limit:\s*([\d,]+)\s*\+\s*[\d,]+\s*>\s*([\d,]+)/iu);
  if (sum) {
    const input = tokenCount(sum[1]);
    const window = tokenCount(sum[2]);
    return input !== undefined && window ? { window, input } : null;
  }
  const window = tokenCount(text.match(/(?:maximum context length|context window|context limit|model token limit)(?:\s+(?:is|of|for this model is))?\s*[:=(]?\s*([\d,]+)\s*(?:tokens?)?/iu)?.[1]);
  const textInput = tokenCount(text.match(/([\d,]+)\s+of text input/iu)?.[1]);
  const toolInput = tokenCount(text.match(/([\d,]+)\s+of tool input/iu)?.[1]);
  const input = textInput !== undefined && toolInput !== undefined
    ? textInput + toolInput
    : tokenCount(text.match(/([\d,]+)\s+(?:tokens?\s+)?in (?:the )?(?:messages|prompt|input)/iu)?.[1]
      ?? text.match(/(?:input|prompt)(?:[_ ]tokens?| length)\s*[:=]\s*([\d,]+)/iu)?.[1]
      ?? text.match(/(?:prompt contains at least|request has)\s+([\d,]+)\s+input tokens/iu)?.[1]);
  return window && input !== undefined ? { window, input } : null;
}

function tokenCount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}

function failureMessage(model: Model<Api>, message: string, partial?: AssistantMessage): AssistantMessage {
  return {
    ...(partial ?? {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now()
    }),
    stopReason: "error", errorMessage: message
  };
}
