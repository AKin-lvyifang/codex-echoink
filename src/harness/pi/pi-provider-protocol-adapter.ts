import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type AssistantMessageEventStream,
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
  preventProviderRetryAfterPartial,
  safeProviderFailureCode
} from "./provider-failure";
import { validProviderHistory } from "./provider-stream-codec";
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

export type PiProviderProtocolAdapters = Readonly<
  Record<ApiProviderProtocol, ProviderStreams>
>;

export type PiProviderConnectionFailureKind =
  | "auth"
  | "protocol"
  | "model"
  | "rate_limit"
  | "network"
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

  constructor(adapters: Partial<PiProviderProtocolAdapters> = {}) {
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
    return this.adapters[protocol].stream(
      input.model,
      input.context,
      {
        ...streamOptions,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        onPayload: composeReasoningPayloadTransform(
          clampedReasoning,
          onPayload
        ),
        apiKey: input.apiKey
      }
    );
  }

  streamSimple(input: {
    model: Model<Api>;
    context: Context;
    apiKey: string;
    options: Omit<SimpleStreamOptions, "apiKey">;
  }): AssistantMessageEventStream {
    const protocol = requireApiProviderProtocol(input.model.api);
    const { onPayload, ...streamOptions } = input.options;
    const clampedReasoning = input.options.reasoning
      ? clampThinkingLevel(input.model, input.options.reasoning)
      : undefined;
    return this.adapters[protocol].streamSimple(
      input.model,
      input.context,
      {
        ...streamOptions,
        onPayload: composeReasoningPayloadTransform(
          clampedReasoning,
          onPayload
        ),
        apiKey: input.apiKey
      }
    );
  }
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
    documentInput?: Readonly<{
      currentDocuments(): readonly Readonly<PiChatPreparedDocument>[];
      capabilityTarget: Readonly<PiDocumentCapabilityTarget>;
    }>;
  }) {
    this.authorityId = options.authorityId;
    this.storeSetId = options.storeSetId;
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
    } catch {
      return failedStream(
        input.model,
        input.provider.authMode === "oauth"
          ? "provider_oauth_relogin_required"
          : "provider_api_key_missing"
      );
    }
    let responseStatus: number | null = null;
    try {
      const dispatcher = this.options.dispatcher
        ?? new PiProviderProtocolDispatcher();
      const documents = this.options.documentInput?.currentDocuments() ?? [];
      const nativeDocuments = documents.filter(
        (document) => document.transport === "native"
      );
      const fallbackLocked = this.documentFallbackTurnId === input.turnId
        && nativeDocuments.length > 0;
      const providerContext: Context = {
        ...input.context,
        messages: validProviderHistory(input.context.messages, input.model)
      };
      const dispatchRequest = (
        context: Context,
        injectNativeDocuments: boolean
      ): AssistantMessageEventStream => dispatcher.streamSimple({
        model: input.model,
        context,
        apiKey,
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
          maxRetries: input.options.maxRetries,
          timeoutMs: input.options.timeoutMs,
          ...(injectNativeDocuments && this.options.documentInput
            ? {
                onPayload: (payload: unknown) =>
                  applyPiAnthropicDocumentPayload({
                    payload,
                    documents: nativeDocuments,
                    capabilityTarget: this.options.documentInput!.capabilityTarget
                  })
              }
            : {}),
          onResponse: (response) => {
            responseStatus = response.status;
          }
        }
      });
      let requestContext = providerContext;
      if (fallbackLocked) {
        if (nativeDocuments.some((document) => !document.text?.trim())) {
          return failedStream(input.model, "provider_protocol_failed");
        }
        requestContext = contextWithPiDocumentFallback(
          providerContext,
          nativeDocuments
        );
        if (!piDocumentFallbackFitsInputBudget(input, requestContext)) {
          return failedStream(
            input.model,
            PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
          );
        }
      }
      const upstream = dispatchRequest(
        requestContext,
        nativeDocuments.length > 0 && !fallbackLocked
      );
      return sanitizeProviderStream(
        upstream,
        input.model,
        () => responseStatus,
        nativeDocuments.length > 0 && !fallbackLocked
          ? (event, status) => {
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
          : undefined
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
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (
    /(?:model).*(?:not found|does not exist|unsupported|invalid)/u.test(
      normalized
    )
    || /(?:unknown|invalid).*(?:model)/u.test(normalized)
  ) {
    return "model";
  }
  if ([400, 404, 405, 422].includes(status ?? -1)) return "protocol";
  if (status !== null && status >= 500) return "provider";
  if (
    /timeout|timed out|abort|network|connection error|failed to fetch|fetch failed|enotfound|econn|dns|tls|certificate|offline/u.test(
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
  ) => AssistantMessageEventStream | null
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
          output.push({
            type: "error",
            reason: event.reason,
            error: {
              ...event.error,
              errorMessage: runtimeProviderFailureCode(
                responseStatus(),
                event.error.errorMessage ?? "",
                event.error,
                model.contextWindow
              )
            }
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
 * error to EchoInk's public failure vocabulary. AgentSession relies on the
 * canonical code to start its native compact-and-retry path.
 */
function runtimeProviderFailureCode(
  status: number | null,
  message: string,
  assistantMessage?: AssistantMessage,
  contextWindow?: number
): string {
  for (const code of [
    PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
    PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
  ]) {
    if (message.includes(code)) return code;
  }
  if (
    (
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
  const safeCode = safeProviderFailureCode(message) ?? providerFailureCode(
    classifyPiProviderConnectionFailure(status, message)
  );
  return preventProviderRetryAfterPartial(safeCode, assistantMessage);
}

function thrownProviderFailureCode(
  status: number | null,
  message: string,
  partial?: AssistantMessage
): string {
  for (const code of [
    PI_ANTHROPIC_DOCUMENT_REQUEST_TOO_LARGE,
    PI_DOCUMENT_FALLBACK_INPUT_BUDGET_EXCEEDED
  ]) {
    if (message.includes(code)) return code;
  }
  const safeCode = isStatusContextOverflow(status, message)
    ? "context_length_exceeded"
    : safeProviderFailureCode(message) ?? providerFailureCode(
      classifyPiProviderConnectionFailure(status, message)
    );
  return preventProviderRetryAfterPartial(safeCode, partial);
}

function isExplicitDocumentUnsupported(
  status: number | null,
  message: string
): boolean {
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
