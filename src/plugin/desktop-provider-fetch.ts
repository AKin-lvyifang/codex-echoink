interface DesktopProviderNativeResponse {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  once(event: "end" | "aborted" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[]>;
}

export interface DesktopProviderNativeRequest {
  on(event: "response", listener: (response: DesktopProviderNativeResponse) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "abort", listener: () => void): unknown;
  setHeader(name: string, value: string): void;
  write(body: string | Uint8Array): void;
  end(): void;
  abort(): void;
}

export type DesktopProviderNativeRequestFactory = (options: {
  url: string;
  method: string;
  redirect: "error";
  session?: unknown;
}) => DesktopProviderNativeRequest;

export function desktopProviderRequest(options: Parameters<DesktopProviderNativeRequestFactory>[0]): DesktopProviderNativeRequest {
  // Resolve lazily: loading the plugin must not require an active network host.
  // Electron's network stack uses the same system/session proxy as Obsidian.
  const electronRequire = window.require;
  const electron = electronRequire?.("electron") as {
    net?: { request: DesktopProviderNativeRequestFactory };
    remote?: { net?: { request: DesktopProviderNativeRequestFactory }; getCurrentWebContents?(): { session: unknown } };
  } | undefined;
  const net = electron?.net ?? electron?.remote?.net;
  if (!net?.request) throw new Error("Desktop Provider network transport unavailable");
  const session = electron?.remote?.getCurrentWebContents?.().session;
  return net.request({ ...options, ...(session ? { session } : {}) });
}

/** Desktop SDK fetch bridge. Pi retains each protocol codec; Electron owns proxy routing. */
export function createDesktopProviderFetch(
  requestFactory: DesktopProviderNativeRequestFactory = desktopProviderRequest,
  options: { timeoutMs?: number } = {}
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
      ? options.timeoutMs! : 30_000;
    let timer: number | undefined;
    const armTimeout = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fail(new Error("provider_request_timeout")), timeoutMs);
    };
    const abortError = () => signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Request was aborted", "AbortError");
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let request: DesktopProviderNativeRequest | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let receivedResponse = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stopRequest = () => request?.abort();
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      const failure = signal?.aborted ? abortError() : new Error(
        desktopProviderFailureCode(error)
          ?? (receivedResponse ? "provider_network_error_http_incomplete" : "provider_network_error")
      );
      controller?.error(failure);
      reject(failure);
      stopRequest();
    };
    const onAbort = () => fail(abortError());

    try {
      const url = new URL(input);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("provider_protocol_failed");
      }
      request = requestFactory({
        url: input,
        method: init.method ?? "GET",
        redirect: "error"
      });
      request.on("error", fail);
      request.on("abort", () => fail(abortError()));
      // ClientRequest is a Writable: Electron emits its close after uploading,
      // even before response headers. Only the response's close can truncate SSE.
      request.on("response", (response: DesktopProviderNativeResponse) => {
        if (finished) return;
        if (receivedResponse) {
          fail(new Error("provider_protocol_failed"));
          return;
        }
        receivedResponse = true;
        armTimeout();
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
          }
          const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value; },
            cancel() {
              if (finished) return;
              finished = true;
              cleanup();
              // Cancel the native transaction as well as the SDK reader.
              stopRequest();
            }
          });
          response.once("end", () => {
            if (finished) return;
            finished = true;
            cleanup();
            controller!.close();
          });
          response.once("error", fail);
          response.once("aborted", () => fail(new Error("provider_network_error_http_incomplete")));
          response.once("close", () => {
            if (!finished) fail(new Error("provider_network_error_http_incomplete"));
          });
          // Adding data starts the native readable. Register terminal listeners
          // first so a buffered short response cannot end across remote IPC early.
          response.on("data", (chunk: Uint8Array) => {
            if (finished) return;
            try {
              armTimeout();
              controller!.enqueue(Uint8Array.from(chunk));
            } catch (error) {
              fail(error);
            }
          });
          resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : body, {
            status: response.statusCode,
            statusText: response.statusMessage ?? "",
            headers
          }));
        } catch (error) {
          fail(error);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      new Headers(init.headers).forEach((value, name) => {
        // Electron computes these itself; SDKs may have supplied Content-Length.
        if (!["content-length", "host", "connection", "transfer-encoding"].includes(name)) {
          request!.setHeader(name, value);
        }
      });
      if (init.body != null) {
        if (typeof init.body === "string") request.write(init.body);
        else if (init.body instanceof ArrayBuffer) request.write(new Uint8Array(init.body));
        else if (ArrayBuffer.isView(init.body)) {
          request.write(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength));
        } else {
          throw new TypeError("Unsupported Provider request body");
        }
      }
      armTimeout();
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

export const desktopProviderFetch = createDesktopProviderFetch();

/** Capture native evidence before SDKs reduce connection errors to a generic message. */
export function desktopProviderFailureCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const value = current as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown; status?: unknown };
    // A readable HTTP rejection is upstream evidence, not a native connection error.
    if (typeof value.status === "number" && value.status > 0) return null;
    const text = [value.code, value.message, value.name].filter(x => typeof x === "string").join(" ");
    const explicit = text.match(/\b(provider_(?:certificate_failed|proxy_failed|request_timeout|network_error_http_incomplete|network_error|protocol_failed))\b/u)?.[1];
    if (explicit) return explicit;
    if (/ERR_CERT_|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/u.test(text)) return "provider_certificate_failed";
    if (/ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|NO_SUPPORTED_PROXIES|PROXY_AUTH[^ ]*)/u.test(text)) return "provider_proxy_failed";
    if (/APIConnectionTimeoutError|TimeoutError|Request timed out/iu.test(text)) return "provider_request_timeout";
    current = value.cause;
  }
  return null;
}
