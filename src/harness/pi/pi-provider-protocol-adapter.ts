import { anthropicCacheRoute, applyPromptCacheBoundary, providerCacheKey } from "./prompt-cache";
import { withXiaoechoTurn } from "../../membership/xiaoecho-turn";
import { publishXiaoechoModelSignal } from "../../membership/xiaoecho-model-signal";
import { XIAOECHO_RETRY_DELAY_MS, xiaoechoBusyCode } from "./xiaoecho-retry";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Api,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  clampThinkingLevel,
  getOverflowPatterns,
  isContextOverflow
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi
} from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import {
  openAICompletionsApi
} from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  openAIResponsesApi
} from "@earendil-works/pi-ai/api/openai-responses.lazy";
import {
  openAICodexResponsesApi
} from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import type {
  ApiProviderProtocol
} from "../../settings/provider-presets";
import type {
  ControlledPiStreamInput,
  ControlledPiStreamPort
} from "./production-pi-model-resolver";
import {
  applyEchoInkPiReasoningPayload
} from "../../settings/pi-model-catalog";
import {
  assistantHasPartialOutput,
  isProviderQuotaExhausted,
  sanitizeProviderFailureDetail,
  preventProviderRetryAfterPartial,
  providerFailureCodeFromError,
  providerPlanFailureCode,
  providerFailureHttpStatus,
  safeProviderFailureCode,
  xiaoechoProviderFailureDetail,
  type AssistantProviderFailure
} from "./provider-failure";
import { validProviderHistory } from "./provider-stream-codec";
import { openCodeSessionHeaders, withOpenCodeRequestHeaders } from "./opencode-go-headers";
import { observeUsageStream, type UsageRequestEvent } from "../usage/usage-stream";
import { estimateTokenValue } from "../usage/token-estimator";
import type { PiChatPreparedDocument } from "../pi-native/contracts";
import {
  applyPiAnthropicDocumentPayload,
  buildPiDocumentFallbackProviderContext,
  PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
  PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED,
  type PiDocumentCapabilityTarget
} from "../pi-native/pi-document-context";
import {
  calculatePiEffectiveInputBudget,
  estimatePiContextTokens
} from "../pi-native/pi-context-budget";
import {
  streamWithPiAutoOutputLimit,
  PI_OUTPUT_LIMIT_REJECTED,
  PI_AUTO_OUTPUT_REQUEST_REJECTED,
  type PiAutoOutputLimitPolicy,
  type PiAutoOutputLimitRequestState
} from "./auto-output-limit";

export type PiProviderProtocolAdapters = Readonly<
  Record<ApiProviderProtocol, ProviderStreams>
>;

export type PiProviderConnectionFailureKind =
  | "auth"
  | "protocol"
  | "model"
  | "rate_limit"
  | "network"
  | "certificate"
  | "proxy"
  | "timeout"
  | "request"
  | "provider";

const DEFAULT_PI_PROVIDER_PROTOCOL_ADAPTERS:
PiProviderProtocolAdapters = Object.freeze({
  "openai-codex-responses": createOpenAICodexSseAdapter(),
  "openai-responses": openAIResponsesApi(),
  "openai-completions": openAICompletionsApi(),
  "anthropic-messages": anthropicMessagesApi()
});
const PI_CONTEXT_OVERFLOW_PATTERNS = getOverflowPatterns();

export class PiProviderProtocolDispatcher {
  readonly adapters: PiProviderProtocolAdapters;

  constructor(
    adapters: Partial<PiProviderProtocolAdapters> = {},
    private readonly autoOutputLimits?: PiAutoOutputLimitPolicy
  ) {
    this.adapters = Object.freeze({
      ...DEFAULT_PI_PROVIDER_PROTOCOL_ADAPTERS,
      ...adapters
    });
  }

  stream(input: {
    model: Model<Api>;
    context: Context;
    apiKey: string;
    options: Omit<StreamOptions, "apiKey"> & Pick<SimpleStreamOptions, "reasoning">;
  }): AssistantMessageEventStream {
    const protocol = requireApiProviderProtocol(input.model.api);
    const { reasoning, onPayload, ...streamOptions } = input.options;
    const clampedReasoning = reasoning
      ? clampThinkingLevel(input.model, reasoning)
      : undefined;
    const reasoningEffort = clampedReasoning === "off"
      ? undefined
      : clampedReasoning;
    return streamWithPiAutoOutputLimit({
      model: input.model,
      context: input.context,
      policy: this.autoOutputLimits,
      options: {
        ...streamOptions,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        onPayload: composeReasoningPayloadTransform(
          clampedReasoning,
          onPayload
        ),
        apiKey: input.apiKey
      },
      start: (model, options) => streamWithXiaoechoModelSignals(
        model,
        withOpenCodeRequestHeaders(model, options),
        (requestOptions) => this.adapters[protocol].stream(model, input.context, requestOptions)
      )
    });
  }

  streamSimple(input: {
    model: Model<Api>;
    context: Context;
    apiKey: string;
    options: Omit<SimpleStreamOptions, "apiKey">;
    autoOutputLimitState?: PiAutoOutputLimitRequestState;
  }): AssistantMessageEventStream {
    const protocol = requireApiProviderProtocol(input.model.api);
    const { onPayload, ...streamOptions } = input.options;
    const clampedReasoning = input.options.reasoning
      ? clampThinkingLevel(input.model, input.options.reasoning)
      : undefined;
    return streamWithPiAutoOutputLimit({
      model: input.model,
      context: input.context,
      policy: this.autoOutputLimits,
      state: input.autoOutputLimitState,
      options: {
        ...streamOptions,
        onPayload: composeReasoningPayloadTransform(
          clampedReasoning,
          onPayload
        ),
        apiKey: input.apiKey
      },
      start: (model, options) => streamWithXiaoechoModelSignals(
        model,
        withOpenCodeRequestHeaders(model, options),
        (requestOptions) => this.adapters[protocol].streamSimple(model, input.context, requestOptions)
      )
    });
  }
}

function withDefinedHeaders(headers: Record<string, string> | undefined): { headers?: Record<string, string> } {
  return headers ? { headers } : {};
}

/** Scope fallback attribution to the actual HTTP request, including existing retries. */
function streamWithXiaoechoModelSignals<T extends StreamOptions>(
  model: Model<Api>,
  options: T,
  start: (options: T) => AssistantMessageEventStream
): AssistantMessageEventStream {
  if (model.provider !== "xiaoecho") return start(options);
  const requestedModelId = model.id;
  const baseUrl = model.baseUrl;
  const requestId = crypto.randomUUID();
  let fallback = false;
  let reported = false;
  const report = (kind: "fallback" | "retired") => {
    if (reported) return;
    reported = true;
    publishXiaoechoModelSignal({ kind, requestedModelId, baseUrl, requestId });
  };
  const observeFailure = (value: unknown) => {
    const error = value && typeof value === "object"
      ? value as Partial<AssistantProviderFailure> & { message?: unknown; code?: unknown }
      : undefined;
    if ([
      typeof value === "string" ? value : undefined,
      error?.message,
      error?.code,
      error?.errorMessage,
      error?.echoInkProviderFailure?.code,
      error?.echoInkProviderFailure?.message
    ].some((text) => typeof text === "string" && /\bMODEL_(?:UNKNOWN|UNAVAILABLE)\b/u.test(text))) {
      report("retired");
    }
  };
  try {
    const upstream = start({
      ...options,
      onResponse: async (response, responseModel) => {
        const headers = Object.fromEntries(Object.entries(response.headers).map(
          ([name, value]) => [name.toLowerCase(), value]
        ));
        if (
          response.status >= 200 && response.status < 300
          && headers["x-xiaoecho-fallback"] === "auto"
          && headers["x-xiaoecho-requested-model"] === requestedModelId
        ) {
          fallback = true;
          report("fallback");
        }
        await options.onResponse?.(response, responseModel);
      }
    });
    return xiaoechoModelResponseStream(
      upstream,
      (message) => fallback ? { ...message, model: "auto" } : message,
      observeFailure
    );
  } catch (error) {
    observeFailure(error);
    throw error;
  }
}

/** Preserve the adapter's iterator/result error behavior while mapping every message. */
function xiaoechoModelResponseStream(
  upstream: AssistantMessageEventStream,
  mapMessage: (message: AssistantMessage) => AssistantMessage,
  observeFailure: (error: unknown) => void
): AssistantMessageEventStream {
  const iterate = async function* (): AsyncGenerator<AssistantMessageEvent> {
    try {
      for await (const event of upstream) {
        if (event.type === "error") observeFailure(event.error);
        if ("partial" in event) {
          yield { ...event, partial: mapMessage(event.partial) };
        } else if (event.type === "done") {
          yield { ...event, message: mapMessage(event.message) };
        } else {
          yield { ...event, error: mapMessage(event.error) };
        }
      }
    } catch (error) {
      observeFailure(error);
      throw error;
    }
  };
  const result = async (): Promise<AssistantMessage> => {
    try {
      const message = await upstream.result();
      if (message.stopReason === "error") observeFailure(message);
      return mapMessage(message);
    } catch (error) {
      observeFailure(error);
      throw error;
    }
  };
  return new Proxy(upstream, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return iterate;
      if (property === "result") return result;
      if (property === "push") return target.push.bind(target);
      if (property === "end") return target.end.bind(target);
      const value: unknown = Reflect.get(target, property, target);
      return value;
    }
  });
}

function composeReasoningPayloadTransform(
  level: ModelThinkingLevel | undefined,
  downstream: StreamOptions["onPayload"]
): NonNullable<StreamOptions["onPayload"]> {
  return async (payload, model) => {
    const transformed = applyEchoInkPiReasoningPayload(
      payload,
      model,
      level
    );
    if (!downstream) return transformed;
    return await downstream(transformed, model) ?? transformed;
  };
}

export class PiProviderProtocolTransport
implements ControlledPiStreamPort {
  readonly authorityId: string;
  readonly storeSetId: string;
  private documentFallbackTurnId: string | null = null;

  constructor(private readonly options: {
    authorityId: string;
    storeSetId: string;
    resolveAuthToken(): string | Promise<string>;
    dispatcher?: PiProviderProtocolDispatcher;
    recordUsage?(event: UsageRequestEvent): void | Promise<void>;
    observeRequest?(context: Readonly<Context>, execution: ControlledPiStreamInput, additionalInputTokens: number): void | Promise<void>;
    documentInput?: Readonly<{
      currentDocuments(): readonly Readonly<PiChatPreparedDocument>[];
      capabilityTarget: Readonly<PiDocumentCapabilityTarget>;
    }>;
  }) {
    this.authorityId = options.authorityId;
    this.storeSetId = options.storeSetId;
  }

  prepareProviderInput(context: Readonly<Context>, model: Model<Api>, turnId: string) {
    const nativeDocuments = (this.options.documentInput?.currentDocuments() ?? [])
      .filter(document => document.transport === "native");
    const fallbackLocked = this.documentFallbackTurnId === turnId && nativeDocuments.length > 0;
    const providerContext: Context = { ...context, messages: validProviderHistory(context.messages, model) };
    const injectDocuments = nativeDocuments.length > 0 && !fallbackLocked;
    return {
      providerContext, nativeDocuments, fallbackLocked, injectDocuments,
      requestContext: fallbackLocked ? contextWithPiDocumentFallback(providerContext, nativeDocuments) : providerContext,
      additionalInputTokens: injectDocuments
        ? nativeDocuments.reduce((sum, document) => sum + Math.max(1_200, estimateTokenValue(document.text ?? "")), 0)
        : 0
    };
  }

  async stream(
    input: ControlledPiStreamInput
  ): Promise<AssistantMessageEventStream> {
    if (this.documentFallbackTurnId !== input.turnId) {
      this.documentFallbackTurnId = null;
    }
    let apiKey: string;
    try {
      apiKey = await this.options.resolveAuthToken();
    } catch (error) {
      return failedStream(
        input.model,
        providerFailureCodeFromError(error)
          ?? (input.provider.authMode === "account"
            ? "provider_account_login_required"
            : input.provider.authMode === "oauth"
            ? (error instanceof Error && /授权已失效|登录状态已失效/u.test(error.message)
              ? "provider_oauth_relogin_required"
              : thrownProviderFailureCode(null, error instanceof Error ? error.message : ""))
            : "provider_api_key_missing")
      );
    }
    let responseStatus: number | null = null;
    try {
      const dispatcher = this.options.dispatcher
        ?? new PiProviderProtocolDispatcher();
      const prepared = this.prepareProviderInput(input.context, input.model, input.turnId);
      const { nativeDocuments, providerContext, requestContext, fallbackLocked, injectDocuments } = prepared;
      const autoOutputLimitState: PiAutoOutputLimitRequestState = {
        retried: false,
        ...(input.options.timeoutMs && input.options.timeoutMs > 0
          ? { deadline: Date.now() + input.options.timeoutMs }
          : {})
      };
      const dispatchRequest = (
        context: Context,
        injectNativeDocuments: boolean
      ): AssistantMessageEventStream => deferredStream(input.model, async () => {
        const additionalInputTokens = injectNativeDocuments ? prepared.additionalInputTokens : 0;
        await this.options.observeRequest?.(context, input, additionalInputTokens);
        const upstream = dispatcher.streamSimple({
        model: input.model,
        context,
        apiKey,
        autoOutputLimitState,
        options: {
          signal: input.options.signal,
          ...(input.options.reasoning
            ? { reasoning: input.options.reasoning }
            : {}),
          ...(input.options.maxTokens === undefined
            ? {}
            : { maxTokens: input.options.maxTokens }),
          temperature: input.options.temperature,
          cacheRetention: input.options.cacheRetention,
          ...(input.options.cacheRetention === "short" ? { sessionId: providerCacheKey(input.conversationId) } : {}),
          ...withDefinedHeaders(openCodeSessionHeaders(input.model, providerCacheKey(input.conversationId))),
          maxRetries: input.options.maxRetries,
          timeoutMs: input.options.timeoutMs,
          onPayload: (payload: unknown) => {
            const prepared = injectNativeDocuments && this.options.documentInput
              ? applyPiAnthropicDocumentPayload({ payload, documents: nativeDocuments, capabilityTarget: this.options.documentInput.capabilityTarget })
              : payload;
            const separated = applyPromptCacheBoundary(prepared, input.options.cacheRetention === "short"
              && anthropicCacheRoute(input.model.provider, input.model.id, input.model.api));
            const cachePayload = input.options.cacheRetention === "short" && input.model.provider === "xiaoecho"
              && /^gpt-/u.test(input.model.id) && separated && typeof separated === "object"
              ? { ...separated, prompt_cache_key: providerCacheKey(input.conversationId) }
              : separated;
            return withXiaoechoTurn(cachePayload, input.model.provider, input.purpose ? {
              conversationId: input.conversationId, turnId: input.turnId, purpose: input.purpose, shortReply: input.shortReply
            } : undefined);
          },
          onResponse: (response) => {
            responseStatus = response.status;
          }
        }
        });
        return this.options.recordUsage ? observeUsageStream(upstream, {
          context,
          provider: input.model.provider,
          model: input.model.id,
          source: "conversation",
          recordUsage: (event) => this.options.recordUsage?.(event),
          additionalInputTokens,
          onRecordError: () => console.error("EchoInk request usage could not be recorded")
        }) : upstream;
      });
      if (fallbackLocked) {
        if (nativeDocuments.some((document) => !document.text?.trim())) {
          return failedStream(input.model, "provider_protocol_failed");
        }
        if (!piDocumentFallbackFitsInputBudget(input, requestContext)) {
          return failedStream(
            input.model,
            PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
          );
        }
      }
      const upstream = dispatchRequest(requestContext, injectDocuments);
      // 小echo: the server's concurrency gate says "busy" → wait 2 s and send the same request once more, silently.
      let busyRetried = false;
      const busyRetry = (event: AssistantMessage, status: number | null): AssistantMessageEventStream | null => {
        if (busyRetried || !xiaoechoBusyCode(input.model.provider, status, event.errorMessage ?? "")) return null;
        busyRetried = true;
        responseStatus = null;
        return delayedStream(input.model, XIAOECHO_RETRY_DELAY_MS, () => dispatchRequest(requestContext, injectDocuments));
      };
      const documentFallback = nativeDocuments.length > 0 && !fallbackLocked
          ? (event: AssistantMessage, status: number | null) => {
              if (!isExplicitDocumentUnsupported(status, event.errorMessage ?? "")) {
                return null;
              }
              if (nativeDocuments.some((document) => !document.text?.trim())) {
                return null;
              }
              this.documentFallbackTurnId = input.turnId;
              const fallbackContext = contextWithPiDocumentFallback(
                providerContext,
                nativeDocuments
              );
              if (!piDocumentFallbackFitsInputBudget(input, fallbackContext)) {
                return failedStream(
                  input.model,
                  PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
                );
              }
              responseStatus = null;
              return dispatchRequest(fallbackContext, false);
            }
          : undefined;
      return sanitizeProviderStream(
        upstream,
        input.model,
        () => responseStatus,
        (event, status) => busyRetry(event, status) ?? documentFallback?.(event, status) ?? null,
        [apiKey]
      );
    } catch (error) {
      return failedStream(
        input.model,
        thrownProviderFailureCode(
          responseStatus,
          error instanceof Error ? error.message : ""
        )
      );
    }
  }
}

export function classifyPiProviderConnectionFailure(
  status: number | null,
  message: string
): PiProviderConnectionFailureKind {
  const normalized = message.toLowerCase();
  // Pi SDK errors may carry the HTTP status only in the error prefix.
  status = status ?? providerFailureHttpStatus(message);
  const authenticationStatus = status;
  if (authenticationStatus === 401) return "auth";
  if (authenticationStatus === 403) return "request";
  // OAuth and local adapters provide content-free codes. Keep those categories
  // instead of treating their human-readable messages as upstream response bodies.
  switch (safeProviderFailureCode(message)) {
    case "provider_oauth_relogin_required":
    case "provider_auth_failed":
    case "provider_api_key_missing": return "auth";
    case "provider_model_invalid":
    case "provider_model_unavailable": return "model";
    case "provider_rate_limited": return "rate_limit";
    case "provider_request_rejected": return "request";
    case "provider_request_timeout": return "timeout";
    case "provider_certificate_failed": return "certificate";
    case "provider_proxy_failed": return "proxy";
    case "provider_network_error_http_incomplete": return "network";
    case "provider_network_error":
    case "provider_network_failed":
    case "provider_network_interrupted": return "network";
    case "provider_protocol_failed":
    case "provider_protocol_mismatch":
    case "provider_sse_json_invalid": return "protocol";
    case "provider_service_unavailable":
    case "provider_service_failed": return "provider";
  }
  // Some providers return 429 for exhausted billing/account quota. Retrying
  // cannot restore that balance; keep ordinary rate limits retryable below.
  if (isProviderQuotaExhausted(message)) {
    return "request";
  }
  if (status === 429 || /rate[ _-]?limit|usage[ _-]?limit|quota|too many requests/u.test(normalized)) {
    return "rate_limit";
  }
  if (
    /(?:model).*(?:not found|does not exist|unsupported|not supported|invalid|not available|unavailable|do not have access)/u.test(
      normalized
    )
    || /(?:unknown|invalid).*(?:model)/u.test(normalized)
  ) {
    return "model";
  }
  if (status === 400 || status === 422) return "request";
  if (status === 404 || status === 405) return "protocol";
  if (status !== null && status >= 500) return "provider";
  if (/timeout|timed out|provider_request_timeout/u.test(normalized)) return "timeout";
  if (/unsupported[_ ]parameter|invalid[_ ](?:request|parameter)|unknown[_ ]parameter/u.test(normalized)) return "request";
  if (
    /abort|network|connection error|failed to fetch|fetch failed|enotfound|econn|dns|tls|certificate|offline/u.test(
      normalized
    )
  ) {
    return "network";
  }
  if (
    /protocol|parse|invalid response|unexpected.*json|json.*unexpected|provider_(?:finish_reason|sse_json|tool_call|utf8)_/u.test(
      normalized
    )
  ) {
    return "protocol";
  }
  return "provider";
}

function sanitizeProviderStream(
  upstream: AssistantMessageEventStream,
  model: Model<Api>,
  responseStatus: () => number | null,
  fallback?: (
    error: AssistantMessage,
    status: number | null
  ) => AssistantMessageEventStream | null,
  secrets: readonly string[] = []
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let partial: AssistantMessage | undefined;
    try {
      let assistantEventObserved = false;
      const pipe = async (
        stream: AssistantMessageEventStream,
        allowFallback: boolean
      ): Promise<void> => {
        for await (const event of stream) {
          if (
            (event.type === "done" && (event.reason === "length" || event.message.stopReason === "length"))
            || (event.type === "error" && event.reason !== "aborted" && event.error.errorMessage === "provider_output_limit_reached")
          ) {
            const message = event.type === "done" ? event.message : event.error;
            partial = {
              ...message,
              content: message.content.filter((block) => block.type !== "toolCall"),
              stopReason: "length"
            };
            delete partial.errorMessage;
            // Pi otherwise fails truncated calls and immediately requests again
            // inside its tool loop, bypassing the runtime continuation budget.
            output.push({ type: "done", reason: "length", message: partial });
            continue;
          }
          if (event.type !== "error") {
            assistantEventObserved = true;
            if ("partial" in event) partial = event.partial;
            else if (event.type === "done") partial = event.message;
            output.push(event);
            continue;
          }
          if (
            allowFallback
            && !assistantEventObserved
            && !assistantHasPartialOutput(event.error)
            && fallback
          ) {
            const retry = fallback(event.error, responseStatus());
            if (retry) {
              await pipe(retry, false);
              return;
            }
          }
          partial = event.error;
          const status = responseStatus();
          const raw = (event.error as AssistantProviderFailure).echoInkProviderFailure ?? event.error.errorMessage;
          const detail = model.provider === "xiaoecho"
            ? xiaoechoProviderFailureDetail(raw) : sanitizeProviderFailureDetail(status, raw, secrets);
          const declaredOverflow = model.provider === "xiaoecho"
            ? status === 413 || detail?.message === "CONTENT_TOO_LONG"
            : isStatusContextOverflow(status, detail?.code ?? "") || isStatusContextOverflow(status, detail?.message ?? "");
          output.push({
            type: "error",
            reason: event.reason,
            error: Object.assign({}, event.error, {
              echoInkProviderFailure: detail,
              errorMessage: runtimeProviderFailureCode(status, event.error.errorMessage ?? "", event.error, model.contextWindow, declaredOverflow)
            })
          });
        }
      };
      await pipe(upstream, true);
    } catch (error) {
      output.push({
        type: "error",
        reason: "error",
        error: errorMessage(
          model,
          thrownProviderFailureCode(
            responseStatus(),
            error instanceof Error ? error.message : "",
            partial
          ),
          partial
        )
      });
    }
  })();
  return output;
}

/**
 * Preserve Pi's context-overflow signal while reducing every other Provider
 * error to EchoInk's public failure vocabulary. The live request can recover
 * from the canonical code before Pi commits an assistant failure.
 */
function runtimeProviderFailureCode(
  status: number | null,
  message: string,
  assistantMessage?: AssistantMessage,
  contextWindow?: number,
  declaredOverflow = false
): string {
  if (message === PI_OUTPUT_LIMIT_REJECTED || message === PI_AUTO_OUTPUT_REQUEST_REJECTED) return message;
  for (const code of [
    PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
    PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
  ]) {
    if (message.includes(code)) return code;
  }
  if (
    declaredOverflow || (
      assistantMessage
      && isContextOverflow(assistantMessage, contextWindow)
    )
    || isStatusContextOverflow(status, message)
  ) {
    return preventProviderRetryAfterPartial(
      "context_length_exceeded",
      assistantMessage
    );
  }
  if (/Stream ended without finish_reason|stream ended before (?:message_stop|a terminal response event)/iu.test(message)) {
    return preventProviderRetryAfterPartial("provider_network_error_http_incomplete", assistantMessage);
  }
  const safeCode = safeProviderFailureCode(message) ?? providerPlanFailureCode(message) ?? providerFailureCode(
    classifyPiProviderConnectionFailure(status, message)
  );
  return preventProviderRetryAfterPartial(safeCode, assistantMessage);
}

function thrownProviderFailureCode(
  status: number | null,
  message: string,
  partial?: AssistantMessage
): string {
  if (message === PI_OUTPUT_LIMIT_REJECTED || message === PI_AUTO_OUTPUT_REQUEST_REJECTED) return message;
  for (const code of [
    PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
    PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
  ]) {
    if (message.includes(code)) return code;
  }
  const safeCode = isStatusContextOverflow(status, message)
    ? "context_length_exceeded"
    : safeProviderFailureCode(message) ?? providerPlanFailureCode(message) ?? providerFailureCode(
      classifyPiProviderConnectionFailure(status, message)
    );
  return preventProviderRetryAfterPartial(safeCode, partial);
}

function isExplicitDocumentUnsupported(
  status: number | null,
  message: string
): boolean {
  status = status ?? providerFailureHttpStatus(message);
  if (status !== 400 && status !== 415 && status !== 422) return false;
  const normalized = message.trim().toLowerCase();
  return /(?:\b(?:pdf|documents?(?:\s+(?:inputs?|types?|blocks?(?:\s+types?)?))?|files?(?:\s+(?:inputs?|types?|blocks?))?|(?:content\s+)?blocks?(?:\s+types?)?(?:\s*[:=]?\s*documents?)?)\b\s+(?:(?:is|are|was|were)\s+)?(?:unsupported|not\s+supported)\b)|(?:\b(?:unsupported|not\s+supported)\b\s+(?:pdf|documents?(?:\s+(?:inputs?|types?|blocks?(?:\s+types?)?))?|files?(?:\s+(?:inputs?|types?|blocks?))?|(?:content\s+)?blocks?(?:\s+types?)?(?:\s*[:=]?\s*documents?)?)\b)/u
    .test(normalized);
}

function piDocumentFallbackFitsInputBudget(
  input: Readonly<ControlledPiStreamInput>,
  fallbackContext: Readonly<Context>
): boolean {
  const maxOutputReserve = Math.min(
    input.options.maxTokens ?? input.model.maxTokens,
    input.model.maxTokens
  );
  const budget = calculatePiEffectiveInputBudget({
    contextWindow: input.model.contextWindow,
    maxOutputReserve
  });
  return estimatePiContextTokens(fallbackContext).tokens
    <= budget.effectiveInputBudget;
}

function contextWithPiDocumentFallback(
  context: Readonly<Context>,
  documents: readonly Readonly<PiChatPreparedDocument>[]
): Context {
  const fallback = buildPiDocumentFallbackProviderContext(documents);
  const messages = structuredClone(context.messages);
  let promptIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (
      typeof content === "string"
      || content.some((block) => block.type === "text" || block.type === "image")
    ) {
      promptIndex = index;
      break;
    }
  }
  messages.splice(promptIndex, 0, {
    role: "user",
    content: fallback,
    timestamp: Date.now()
  });
  return {
    ...structuredClone(context),
    messages
  };
}

function isStatusContextOverflow(
  status: number | null,
  message: string
): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (
    /^(?:throttling error|service unavailable):|rate limit|too many requests|throttl/u
      .test(normalized)
  ) {
    return false;
  }
  if (PI_CONTEXT_OVERFLOW_PATTERNS.some((pattern) =>
    pattern.test(message)
  )) {
    return true;
  }
  if (
    /context[_ ]length[_ ]exceeded|model_context_window_exceeded|request_too_large/u
      .test(normalized)
  ) {
    return true;
  }
  if (status !== 400 && status !== 413) return false;
  const overflowQualifier =
    /exceed|too (?:long|large|many)|maximum|max(?:imum)?|limit|overflow|out of range|reduce/u;
  if (!overflowQualifier.test(normalized)) return false;
  return (
    /context(?: window| length| size)?/u.test(normalized)
    || /(?:prompt|input).*(?:token|length|long|large)/u.test(normalized)
    || /(?:token count|token length|token limit|too many tokens)/u
      .test(normalized)
  );
}

/** Starts the real request only after `delayMs`; events then flow through unchanged. */
function deferredStream(model: Model<Api>, start: () => Promise<AssistantMessageEventStream>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    try { for await (const event of await start()) stream.push(event); }
    catch (error) { stream.push({ type: "error", reason: "error", error: errorMessage(model, thrownProviderFailureCode(null, error instanceof Error ? error.message : "")) }); }
    finally { stream.end(); }
  })();
  return stream;
}

function delayedStream(
  model: Model<Api>,
  delayMs: number,
  start: () => AssistantMessageEventStream
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  window.setTimeout(() => {
    void (async () => {
      try { for await (const event of start()) stream.push(event); }
      catch (error) { stream.push({ type: "error", reason: "error", error: errorMessage(model, thrownProviderFailureCode(null, error instanceof Error ? error.message : "")) }); }
    })();
  }, delayMs);
  return stream;
}
function failedStream(
  model: Model<Api>,
  safeCode: string
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: errorMessage(model, safeCode)
    });
  });
  return stream;
}

function errorMessage(
  model: Model<Api>,
  safeCode: string,
  partial?: AssistantMessage
): AssistantMessage {
  return {
    ...(partial ?? {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0
        }
      },
      timestamp: Date.now()
    }),
    stopReason: "error",
    errorMessage: safeCode
  };
}

function providerFailureCode(
  failure: PiProviderConnectionFailureKind
): string {
  switch (failure) {
    case "auth":
      return "provider_auth_failed";
    case "protocol":
      return "provider_protocol_mismatch";
    case "model":
      return "provider_model_unavailable";
    case "rate_limit":
      return "provider_rate_limited";
    case "network":
      return "provider_network_error";
    case "certificate":
      return "provider_certificate_failed";
    case "proxy":
      return "provider_proxy_failed";
    case "timeout":
      return "provider_request_timeout";
    case "request":
      return "provider_request_rejected";
    case "provider":
      return "provider_service_unavailable";
  }
}

export function requireApiProviderProtocol(
  value: Api
): ApiProviderProtocol {
  if (
    value === "openai-codex-responses"
    || value === "openai-responses"
    || value === "openai-completions"
    || value === "anthropic-messages"
  ) {
    return value as ApiProviderProtocol;
  }
  throw new Error("provider_protocol_unsupported");
}

// The Codex OAuth backend rejects temperature, including the zero supplied by
// connection checks and chat defaults. Other Provider adapters keep their options.
export function createOpenAICodexSseAdapter(
  upstream: ProviderStreams = openAICodexResponsesApi()
): ProviderStreams {
  return Object.freeze({
    stream: (
      model: Model<Api>,
      context: Context,
      options?: StreamOptions
    ) => upstream.stream(
      model,
      context,
      { ...options, temperature: undefined, transport: "sse" }
    ),
    streamSimple: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions
    ) => upstream.streamSimple(
      model,
      context,
      { ...options, temperature: undefined, transport: "sse" }
    )
  });
}
