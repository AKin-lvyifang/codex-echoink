import * as http from "node:http";
import * as https from "node:https";

export async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
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
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers: headersToNode(headers),
      timeout: 120000
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage,
          headers: responseHeadersToWeb(response.headers)
        }));
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("OpenCode 请求超时"));
    });
    request.on("error", reject);
    if (body) request.write(body);
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
