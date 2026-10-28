import { Buffer } from "node:buffer";
import {
  request as httpsRequest
} from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions
} from "@earendil-works/pi-ai";
import {
  clampMaxTokensToContext
} from "@earendil-works/pi-ai/api/simple-options";
import {
  buildQwenTokenPlanBody,
  createProviderSseStreamDecoder,
  type ProviderSseStreamDecoder
} from "../harness/pi/provider-stream-codec";
import type {
  ControlledPiStreamInput
} from "../harness/pi/production-pi-model-resolver";
import {
  preventProviderRetryAfterPartial,
  isProviderQuotaExhausted,
  safeProviderFailureCode
} from "../harness/pi/provider-failure";
import {
  apiProviderRequestUrl,
  isQwenTokenPlanApiProviderUrl,
  QWEN_TOKEN_PLAN_API_BASE_URL
} from "../settings/provider-presets";

const QWEN_TOKEN_PLAN_BASE_URL = new URL(QWEN_TOKEN_PLAN_API_BASE_URL);
const QWEN_TOKEN_PLAN_HOST = QWEN_TOKEN_PLAN_BASE_URL.hostname;
const QWEN_TOKEN_PLAN_BASE_PATH = QWEN_TOKEN_PLAN_BASE_URL.pathname;
const QWEN_TOKEN_PLAN_COMPLETIONS_PATH =
  `${QWEN_TOKEN_PLAN_BASE_PATH}/chat/completions`;
const MAX_QWEN_TOKEN_PLAN_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_QWEN_TOKEN_PLAN_TIMEOUT_MS = 30_000;

type QwenTokenPlanStreamOptions = StreamOptions &
  Pick<SimpleStreamOptions, "reasoning"> & {
    reasoningEffort?: SimpleStreamOptions["reasoning"];
  };

export interface QwenTokenPlanProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly transportComplete?: boolean;
}

export interface QwenTokenPlanProviderRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onResponse?: (response: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
  }>) => void | Promise<void>;
  readonly onChunk?: (chunk: Uint8Array) => void;
}

export type QwenTokenPlanProviderRequestImpl = (
  input: QwenTokenPlanProviderRequest
) => Promise<QwenTokenPlanProviderResponse>;

/**
 * Qwen Token Plan rejects browser CORS preflight. EchoInk is desktop-only, so
 * this narrowly pinned HTTPS adapter keeps the normal Pi Provider stream
 * contract without changing any other OpenAI-compatible Provider.
 */
export function createQwenTokenPlanOpenAICompletionsAdapter(
  requestImpl: QwenTokenPlanProviderRequestImpl = requestQwenTokenPlanProvider
): ProviderStreams {
  const start = (
    model: Model<Api>,
    context: Context,
    options: QwenTokenPlanStreamOptions
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void executeQwenTokenPlanCompletion({
      model,
      context,
      options,
      output,
      requestImpl
    });
    return output;
  };
  const streams: ProviderStreams = {
    stream: (model, context, options = {}) => start(model, context, options),
    streamSimple: (model, context, options = {}) =>
      start(model, context, options)
  };
  return Object.freeze(streams);
}

export async function requestQwenTokenPlanProvider(
  input: QwenTokenPlanProviderRequest
): Promise<QwenTokenPlanProviderResponse> {
  const parsed = new URL(input.url);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== QWEN_TOKEN_PLAN_HOST
    || (parsed.port !== "" && parsed.port !== "443")
    || parsed.pathname !== QWEN_TOKEN_PLAN_COMPLETIONS_PATH
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("qwen_token_plan_target_invalid");
  }
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    1_000,
    120_000,
    DEFAULT_QWEN_TOKEN_PLAN_TIMEOUT_MS
  );
  return await new Promise<QwenTokenPlanProviderResponse>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("qwen_token_plan_aborted"));
      return;
    }
    let settled = false;
    const request = httpsRequest({
      protocol: "https:",
      hostname: parsed.hostname,
      port: parsed.port || "443",
      path: parsed.pathname,
      method: "POST",
      headers: {
        accept: "text/event-stream, application/json",
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(input.body, "utf8")),
        ...input.headers
      },
      maxHeaderSize: 32 * 1024
    }, (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const status = response.statusCode ?? 0;
      const headers = normalizeHeaders(response.headers);
      const streamSuccessfulResponse = status >= 200
        && status < 300
        && Boolean(input.onChunk);
      response.pause();
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8");
        received += bytes.length;
        if (received > MAX_QWEN_TOKEN_PLAN_RESPONSE_BYTES) {
          request.destroy(new Error("qwen_token_plan_response_too_large"));
          return;
        }
        if (streamSuccessfulResponse) {
          try {
            input.onChunk?.(bytes);
          } catch (error) {
            request.destroy(error instanceof Error
              ? error
              : new Error("qwen_token_plan_stream_failed"));
          }
        } else {
          chunks.push(bytes);
        }
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Object.freeze({
          status,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
          transportComplete: response.complete && !response.aborted
        }));
      });
      response.once("error", fail);
      response.once("aborted", () => fail(
        new Error("qwen_token_plan_response_aborted")
      ));
      void Promise.resolve(input.onResponse?.({ status, headers }))
        .then(() => response.resume())
        .catch((error) => request.destroy(error instanceof Error
          ? error
          : new Error("qwen_token_plan_response_failed")));
    });
    const onAbort = () => request.destroy(
      new Error("qwen_token_plan_aborted")
    );
    const cleanup = () => {
      input.signal?.removeEventListener("abort", onAbort);
      request.removeListener("error", fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", fail);
    request.setTimeout(timeoutMs, () => request.destroy(
      new Error("qwen_token_plan_timeout")
    ));
    request.end(input.body);
  });
}

async function executeQwenTokenPlanCompletion(input: {
  model: Model<Api>;
  context: Context;
  options: QwenTokenPlanStreamOptions;
  output: AssistantMessageEventStream;
  requestImpl: QwenTokenPlanProviderRequestImpl;
}): Promise<void> {
  let status: number | null = null;
  let decoder: ProviderSseStreamDecoder | null = null;
  let responseObserved = false;
  let streamedChunk = false;
  const streamStartedAt = Date.now();
  try {
    if (
      input.model.api !== "openai-completions"
      || input.model.provider !== "qwen-token-plan-cn"
      || !isQwenTokenPlanApiProviderUrl(input.model.baseUrl)
    ) {
      throw new Error("qwen_token_plan_model_invalid");
    }
    const controlled = qwenTokenPlanControlledInput(
      input.model,
      input.context,
      input.options
    );
    let payload: unknown = buildQwenTokenPlanBody(controlled);
    const transformed = await input.options.onPayload?.(payload, input.model);
    if (transformed !== undefined) payload = transformed;
    const response = await input.requestImpl({
      url: apiProviderRequestUrl(
        input.model.baseUrl,
        "openai-completions"
      ),
      headers: input.options.apiKey
        ? { authorization: `Bearer ${input.options.apiKey}` }
        : {},
      body: JSON.stringify(payload),
      signal: input.options.signal,
      timeoutMs: input.options.timeoutMs,
      onResponse: async (observed) => {
        if (responseObserved) throw new Error("qwen_token_plan_response_repeated");
        responseObserved = true;
        status = observed.status;
        await input.options.onResponse?.({
          status: observed.status,
          headers: { ...observed.headers }
        }, input.model);
        if (observed.status >= 200 && observed.status < 300) {
          decoder = createProviderSseStreamDecoder({
            stream: input.output,
            model: input.model,
            statusCode: observed.status,
            headers: observed.headers,
            timestamp: streamStartedAt
          });
        }
      },
      onChunk: (chunk) => {
        if (!decoder) throw new Error("qwen_token_plan_stream_not_ready");
        streamedChunk = true;
        decoder.push(chunk);
      }
    });
    if (!responseObserved) {
      responseObserved = true;
      status = response.status;
      await input.options.onResponse?.({
        status,
        headers: { ...response.headers }
      }, input.model);
      if (status >= 200 && status < 300) {
        decoder = createProviderSseStreamDecoder({
          stream: input.output,
          model: input.model,
          statusCode: status,
          headers: response.headers,
          timestamp: streamStartedAt
        });
      }
    }
    const responseStatus = status ?? response.status;
    if (responseStatus < 200 || responseStatus >= 300) {
      throw new Error(qwenTokenPlanHttpFailureCode(
        responseStatus,
        response.body
      ));
    }
    if (!decoder) throw new Error("qwen_token_plan_stream_not_ready");
    if (!streamedChunk && response.body) decoder.push(response.body);
    if (response.transportComplete === false) {
      throw new Error("provider_network_error_http_incomplete");
    }
    decoder.finish();
  } catch (error) {
    input.output.push({
      type: "error",
      reason: input.options.signal?.aborted ? "aborted" : "error",
      error: qwenTokenPlanFailureMessage(
        input.model,
        input.options.signal?.aborted,
        status,
        error,
        decoder?.partial
      )
    });
  }
}

function qwenTokenPlanControlledInput(
  model: Model<Api>,
  context: Context,
  options: QwenTokenPlanStreamOptions
): ControlledPiStreamInput {
  const reasoning = options.reasoning ?? options.reasoningEffort;
  return {
    runId: "qwen-token-plan-run",
    conversationId: "qwen-token-plan-conversation",
    turnId: "qwen-token-plan-turn",
    correlationId: "qwen-token-plan-correlation",
    provider: {
      providerId: model.provider,
      apiProtocol: "openai-completions",
      authMode: "api-key",
      baseUrl: model.baseUrl,
      modelRef: model.id
    },
    model,
    context,
    options: {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(reasoning ? { reasoning } : {}),
      maxTokens: clampMaxTokensToContext(
        model,
        context,
        boundedInteger(
          options.maxTokens,
          1,
          Math.max(1, model.maxTokens),
          Math.max(1, model.maxTokens)
        )
      ),
      temperature: boundedNumber(options.temperature, 0, 2, 0),
      cacheRetention: "none",
      maxRetries: 0,
      timeoutMs: boundedInteger(
        options.timeoutMs,
        1_000,
        120_000,
        DEFAULT_QWEN_TOKEN_PLAN_TIMEOUT_MS
      )
    }
  };
}

function qwenTokenPlanHttpFailureCode(
  status: number,
  body: string
): string {
  if (
    (status === 400 || status === 413)
    && qwenTokenPlanContextOverflow(body)
  ) {
    return "context_length_exceeded";
  }
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (isProviderQuotaExhausted(body)) return "provider_request_rejected";
  if (status === 429) return "provider_rate_limited";
  if (
    status === 400
    && /(?:model).*(?:not found|does not exist|unsupported|invalid)|(?:unknown|invalid).*(?:model)/iu
      .test(body.slice(0, 8_192))
  ) {
    return "provider_model_invalid";
  }
  if ([400, 404, 405, 413, 422].includes(status)) {
    return "provider_protocol_failed";
  }
  return status >= 500
    ? "provider_service_unavailable"
    : "provider_http_failed";
}

function qwenTokenPlanFailureMessage(
  model: Model<Api>,
  aborted: boolean | undefined,
  status: number | null,
  error: unknown,
  partial?: AssistantMessage
): AssistantMessage {
  const message = error instanceof Error ? error.message : "";
  const safeCode = aborted
    ? "controlled_transport_aborted"
    : /response_(?:aborted|incomplete)/iu.test(message)
      ? "provider_network_error_http_incomplete"
    : safeProviderFailureCode(message)
      ?? (/context_length_exceeded/u.test(message)
        ? "context_length_exceeded"
        : status === 401 || status === 403
          ? "provider_auth_failed"
          : status === 429
            ? "provider_rate_limited"
            : /model_invalid/u.test(message)
              ? "provider_model_invalid"
              : /protocol|parse|json|sse|finish_reason|stream_not_ready|response_repeated|target_invalid/iu.test(message)
                ? "provider_protocol_failed"
                : status !== null && status >= 500
                  ? "provider_service_unavailable"
                  : "provider_network_error");
  const errorMessage = preventProviderRetryAfterPartial(safeCode, partial);
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
    stopReason: aborted ? "aborted" : "error",
    errorMessage
  };
}

function qwenTokenPlanContextOverflow(body: string): boolean {
  const normalized = body.slice(0, 16_384).toLowerCase();
  if (
    /context[_ ]length[_ ]exceeded|model_context_window_exceeded|request_too_large/u
      .test(normalized)
  ) {
    return true;
  }
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

function normalizeHeaders(
  headers: IncomingHttpHeaders
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) {
      result[name.toLowerCase()] = value.join(", ");
    }
  }
  return Object.freeze(result);
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value!))
    : fallback;
}

function boundedNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
