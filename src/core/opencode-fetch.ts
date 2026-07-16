import * as http from "node:http";
import * as https from "node:https";

export async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const mergedSignal = mergeAbortSignals(requestInput?.signal, init.signal);
  let streamingResponse = false;
  try {
    throwIfAborted(mergedSignal.signal);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const transport = url.protocol === "https:" ? https : http;
    const method = init.method ?? requestInput?.method ?? "GET";
    const headers = mergedHeaders(requestInput?.headers, init.headers);
    const body = method === "GET" || method === "HEAD"
      ? null
      : init.body !== undefined
        ? await requestBodyToBuffer(init.body)
        : requestInput
          ? await requestBodyFromRequest(requestInput)
          : null;
    throwIfAborted(mergedSignal.signal);
    const result = await nodeHttpRequest({
      url,
      transport,
      method,
      headers,
      body,
      signal: mergedSignal.signal,
      onStreamingResponseClosed: mergedSignal.cleanup
    });
    streamingResponse = result.streaming;
    return result.response;
  } finally {
    if (!streamingResponse) mergedSignal.cleanup();
  }
}

async function nodeHttpRequest(input: {
  url: URL;
  transport: typeof http | typeof https;
  method: string;
  headers: Headers;
  body: Buffer | null;
  signal?: AbortSignal;
  onStreamingResponseClosed: () => void;
}): Promise<{ response: Response; streaming: boolean }> {
  return await new Promise<{ response: Response; streaming: boolean }>((resolve, reject) => {
    let settled = false;
    let responseStream: http.IncomingMessage | null = null;
    let streamingCleanupComplete = false;
    const cleanupStreamingResponse = (): void => {
      if (streamingCleanupComplete) return;
      streamingCleanupComplete = true;
      input.signal?.removeEventListener("abort", abort);
      input.onStreamingResponseClosed();
    };
    const finish = (error: Error | null, response?: Response): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve({ response: response as Response, streaming: false });
    };
    const request = input.transport.request(input.url, {
      method: input.method,
      headers: headersToNode(input.headers),
      timeout: 120000
    }, (response) => {
      responseStream = response;
      const responseHeaders = responseHeadersToWeb(response.headers);
      const status = response.statusCode ?? 0;
      if (responseAllowsBody(status) && isEventStreamResponse(responseHeaders)) {
        request.setTimeout(0);
        try {
          const streamingBody = incomingMessageBody(response, request, cleanupStreamingResponse);
          const streamingWebResponse = new Response(streamingBody, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders
          });
          response.once("close", cleanupStreamingResponse);
          response.once("error", cleanupStreamingResponse);
          settled = true;
          resolve({ response: streamingWebResponse, streaming: true });
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          response.destroy(normalized);
          cleanupStreamingResponse();
          finish(normalized);
        }
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        if (!settled) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("aborted", () => finish(new Error("OpenCode 响应已中断")));
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        try {
          finish(null, new Response(responseAllowsBody(status) ? Buffer.concat(chunks) : null, {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders
          }));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    const abort = (): void => {
      const error = abortError(input.signal?.reason);
      responseStream?.destroy(error);
      request.destroy(error);
      finish(error);
    };
    request.once("timeout", () => {
      const error = new Error("OpenCode 请求超时");
      request.destroy(error);
      finish(error);
    });
    request.once("error", (error) => finish(error));
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.body) request.write(input.body);
    request.end();
  });
}

function isEventStreamResponse(headers: Headers): boolean {
  return headers.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
}

function responseAllowsBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304;
}

function incomingMessageBody(
  response: http.IncomingMessage,
  request: http.ClientRequest,
  onClosed: () => void
): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let settled = false;
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    response.removeListener("data", onData);
    response.removeListener("end", onEnd);
    response.removeListener("aborted", onAborted);
    response.removeListener("error", onError);
    response.removeListener("close", onClose);
    onClosed();
  };
  const close = (): void => {
    if (settled) return;
    settled = true;
    controller?.close();
    cleanup();
  };
  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    controller?.error(error);
    cleanup();
  };
  const onData = (chunk: Buffer | Uint8Array | string): void => {
    if (settled || !controller) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    controller.enqueue(Uint8Array.from(bytes));
    if ((controller.desiredSize ?? 1) <= 0) response.pause();
  };
  const onEnd = (): void => close();
  const onAborted = (): void => fail(new Error("OpenCode 响应已中断"));
  const onError = (error: Error): void => fail(error);
  const onClose = (): void => {
    if (!settled) fail(new Error("OpenCode 响应在流结束前已关闭"));
  };

  // Construct the body with the current global ReadableStream implementation.
  // Electron can expose Response and Web Streams from a different realm than
  // node:stream's Readable.toWeb(), which makes an otherwise healthy SSE body
  // appear as an immediate EOF inside the OpenCode SDK.
  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      response.on("data", onData);
      response.once("end", onEnd);
      response.once("aborted", onAborted);
      response.once("error", onError);
      response.once("close", onClose);
    },
    pull() {
      if (!settled && response.isPaused()) response.resume();
    },
    cancel(reason) {
      if (settled) {
        cleanup();
        return;
      }
      settled = true;
      cleanup();
      const error = reason instanceof Error ? reason : undefined;
      response.destroy(error);
      request.destroy(error);
    }
  });
}

async function requestBodyFromRequest(request: Request): Promise<Buffer | null> {
  const buffer = Buffer.from(await request.clone().arrayBuffer());
  return buffer.length ? buffer : null;
}

async function requestBodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (!body) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error("OpenCode 请求体格式暂不支持");
}

function mergedHeaders(base: HeadersInit | undefined, override: HeadersInit | undefined): Headers {
  const headers = new Headers(base);
  if (override) new Headers(override).forEach((value, key) => headers.set(key, value));
  return headers;
}

function headersToNode(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  new Headers(headers).forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function responseHeadersToWeb(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (typeof value === "string") {
      result.set(key, value);
    }
  }
  return result;
}

function mergeAbortSignals(...signals: Array<AbortSignal | null | undefined>): { signal?: AbortSignal; cleanup: () => void } {
  const sources = Array.from(new Set(signals.filter((signal): signal is AbortSignal => Boolean(signal))));
  if (sources.length <= 1) return { signal: sources[0], cleanup: () => undefined };
  const controller = new AbortController();
  const listeners = sources.map((source) => {
    const listener = () => controller.abort(source.reason);
    source.addEventListener("abort", listener, { once: true });
    if (source.aborted && !controller.signal.aborted) listener();
    return { source, listener };
  });
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { source, listener } of listeners) source.removeEventListener("abort", listener);
    }
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(reason instanceof Error ? reason.message : "OpenCode 请求已取消");
  error.name = "AbortError";
  return error;
}
