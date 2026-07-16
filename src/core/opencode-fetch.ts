import * as http from "node:http";
import * as https from "node:https";

export async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const mergedSignal = mergeAbortSignals(requestInput?.signal, init.signal);
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
    return await nodeHttpRequest({ url, transport, method, headers, body, signal: mergedSignal.signal });
  } finally {
    mergedSignal.cleanup();
  }
}

async function nodeHttpRequest(input: {
  url: URL;
  transport: typeof http | typeof https;
  method: string;
  headers: Headers;
  body: Buffer | null;
  signal?: AbortSignal;
}): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseStream: http.IncomingMessage | null = null;
    const finish = (error: Error | null, response?: Response): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(response as Response);
    };
    const request = input.transport.request(input.url, {
      method: input.method,
      headers: headersToNode(input.headers),
      timeout: 120000
    }, (response) => {
      responseStream = response;
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        if (!settled) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.once("aborted", () => finish(new Error("OpenCode 响应已中断")));
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        finish(null, new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage,
          headers: responseHeadersToWeb(response.headers)
        }));
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
