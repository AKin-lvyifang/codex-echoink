import { getDesktopBuffer } from "../platform/desktop-runtime";
import { getDesktopHttp } from "../platform/desktop-network";

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
  buildDeepSeekBody,
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
  isLoopbackApiProviderUrl
} from "../settings/provider-presets";

const { Buffer } = getDesktopBuffer();
const { request: httpRequest } = getDesktopHttp();

const MAX_LOOPBACK_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOOPBACK_TIMEOUT_MS = 30_000;
type LoopbackStreamOptions = StreamOptions &
  Pick<SimpleStreamOptions, "reasoning">;

export interface LoopbackProviderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly transportComplete?: boolean;
}

export interface LoopbackProviderRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onResponse?: (response: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
  }>) => void | Promise<void>;
  readonly onChunk?: (chunk: Uint8Array) => void;
}

export type LoopbackProviderRequestImpl = (
  input: LoopbackProviderRequest
) => Promise<LoopbackProviderResponse>;

/**
 * Pi's browser-compatible OpenAI client cannot reach an HTTP loopback server
 * from Obsidian's secure app origin. This adapter keeps Ollama inside the same
 * Pi Provider loop while using a strict, redirect-free Node HTTP hop that can
 * only target localhost/loopback. It is never selected for cloud Providers.
 */
export function createLoopbackOpenAICompletionsAdapter(
  requestImpl: LoopbackProviderRequestImpl = requestLoopbackProvider
): ProviderStreams {
  const start = (
    model: Model<Api>,
    context: Context,
    options: LoopbackStreamOptions
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void executeLoopbackCompletion({
      model,
      context,
      options,
      output,
      requestImpl
    });
    return output;
  };
  const streams: ProviderStreams = {
    stream: (model, context, options = {}) =>
      start(model, context, options),
    streamSimple: (model, context, options = {}) =>
      start(model, context, options)
  };
  return Object.freeze(streams);
}

export async function loopbackProviderFetch(
  input: string,
  init: RequestInit
): Promise<Pick<Response, "status" | "json">> {
  if ((init.method ?? "GET").toUpperCase() !== "GET") {
    throw new Error("loopback_model_list_method_invalid");
  }
  const response = await requestLoopbackProvider({
    url: input,
    method: "GET",
    headers: requestHeaders(init.headers),
    signal: init.signal ?? undefined,
    timeoutMs: DEFAULT_LOOPBACK_TIMEOUT_MS
  });
  return {
    status: response.status,
    json: async () => JSON.parse(response.body) as unknown
  };
}

export async function requestLoopbackProvider(
  input: LoopbackProviderRequest
): Promise<LoopbackProviderResponse> {
  if (!isLoopbackApiProviderUrl(input.url)) {
    throw new Error("loopback_provider_target_invalid");
  }
  const parsed = new URL(input.url);
  if (
    parsed.protocol !== "http:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("loopback_provider_target_invalid");
  }
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    1_000,
    120_000,
    DEFAULT_LOOPBACK_TIMEOUT_MS
  );
  const body = input.body ?? "";
  return await new Promise<LoopbackProviderResponse>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("loopback_provider_aborted"));
      return;
    }
    let settled = false;
    const request = httpRequest({
      protocol: "http:",
      hostname: parsed.hostname.replace(/^\[|\]$/gu, ""),
      port: parsed.port || "80",
      path: parsed.pathname,
      method: input.method,
      headers: {
        accept: input.method === "GET"
          ? "application/json"
          : "text/event-stream, application/json",
        ...input.headers,
        ...(body
          ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body, "utf8"))
          }
          : {})
      },
      maxHeaderSize: 32 * 1024
    }, (response) => {
      const chunks: import("node:buffer").Buffer[] = [];
      let received = 0;
      const status = response.statusCode ?? 0;
      const headers = normalizeHeaders(response.headers);
      const streamSuccessfulResponse = input.method === "POST"
        && status >= 200
        && status < 300
        && Boolean(input.onChunk);
      response.pause();
      response.on("data", (chunk: import("node:buffer").Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk, "utf8");
        received += bytes.length;
        if (received > MAX_LOOPBACK_RESPONSE_BYTES) {
          request.destroy(new Error("loopback_provider_response_too_large"));
          return;
        }
        if (streamSuccessfulResponse) {
          try {
            input.onChunk?.(bytes);
          } catch (error) {
            request.destroy(error instanceof Error
              ? error
              : new Error("loopback_provider_stream_failed"));
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
        new Error("loopback_provider_response_aborted")
      ));
      void Promise.resolve(input.onResponse?.({ status, headers }))
        .then(() => response.resume())
        .catch((error) => request.destroy(error instanceof Error
          ? error
          : new Error("loopback_provider_response_failed")));
    });
    const onAbort = () => request.destroy(
      new Error("loopback_provider_aborted")
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
      new Error("loopback_provider_timeout")
    ));
    request.end(body || undefined);
  });
}

async function executeLoopbackCompletion(input: {
  model: Model<Api>;
  context: Context;
  options: LoopbackStreamOptions;
  output: AssistantMessageEventStream;
  requestImpl: LoopbackProviderRequestImpl;
}): Promise<void> {
  let status: number | null = null;
  let decoder: ProviderSseStreamDecoder | null = null;
  let responseObserved = false;
  let streamedChunk = false;
  const streamStartedAt = Date.now();
  try {
    if (
      input.model.api !== "openai-completions"
      || !isLoopbackApiProviderUrl(input.model.baseUrl)
    ) {
      throw new Error("loopback_provider_model_invalid");
    }
    const controlled = loopbackControlledInput(
      input.model,
      input.context,
      input.options
    );
    let payload: unknown = buildDeepSeekBody(controlled);
    const transformed = await input.options.onPayload?.(
      payload,
      input.model
    );
    if (transformed !== undefined) payload = transformed;
    const response = await input.requestImpl({
      url: apiProviderRequestUrl(
        input.model.baseUrl,
        "openai-completions"
      ),
      method: "POST",
      headers: input.options.apiKey
        ? { authorization: `Bearer ${input.options.apiKey}` }
        : {},
      body: JSON.stringify(payload),
      signal: input.options.signal,
      timeoutMs: input.options.timeoutMs,
      onResponse: async (observed) => {
        if (responseObserved) throw new Error("loopback_provider_response_repeated");
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
        if (!decoder) throw new Error("loopback_provider_stream_not_ready");
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
      throw new Error(responseStatus === 401 || responseStatus === 403
        ? "provider_auth_failed"
        : isProviderQuotaExhausted(response.body)
          ? "provider_request_rejected"
        : "provider_http_failed");
    }
    if (!decoder) throw new Error("loopback_provider_stream_not_ready");
    if (!streamedChunk && response.body) decoder.push(response.body);
    if (response.transportComplete === false) {
      throw new Error("provider_network_error_http_incomplete");
    }
    decoder.finish();
  } catch (error) {
    input.output.push({
      type: "error",
      reason: input.options.signal?.aborted ? "aborted" : "error",
      error: loopbackFailureMessage(
        input.model,
        input.options.signal?.aborted,
        status,
        error,
        decoder?.partial
      )
    });
  }
}

function loopbackControlledInput(
  model: Model<Api>,
  context: Context,
  options: LoopbackStreamOptions
): ControlledPiStreamInput {
  return {
    runId: "loopback-provider-run",
    conversationId: "loopback-provider-conversation",
    turnId: "loopback-provider-turn",
    correlationId: "loopback-provider-correlation",
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
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
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
        DEFAULT_LOOPBACK_TIMEOUT_MS
      )
    }
  };
}

function loopbackFailureMessage(
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
      : message === "provider_request_rejected"
        ? message
        : status === 429
        ? "provider_rate_limited"
        : status !== null && status >= 500
          ? "provider_service_unavailable"
    : safeProviderFailureCode(message)
      ?? (status === 401 || status === 403
        ? "provider_auth_failed"
        : /parse|json|sse|protocol|stream_not_ready|response_repeated|target_invalid|model_invalid/iu.test(message)
          ? "provider_protocol_failed"
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

function requestHeaders(
  headers: HeadersInit | undefined
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const result: Record<string, string> = {};
    headers.forEach((value, name) => {
      result[name] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function normalizeHeaders(
  headers: import("node:http").IncomingHttpHeaders
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
