interface CodexNativeResponse {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  once(event: "end" | "aborted" | "close", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string | string[]>;
}

export interface CodexNativeRequest {
  on(event: "response", listener: (response: CodexNativeResponse) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "abort", listener: () => void): unknown;
  setHeader(name: string, value: string): void;
  write(body: string | Uint8Array): void;
  end(): void;
  abort(): void;
}

export type CodexNativeRequestFactory = (options: {
  url: string;
  method: string;
  redirect: "error";
}) => CodexNativeRequest;

function desktopRequest(options: Parameters<CodexNativeRequestFactory>[0]): CodexNativeRequest {
  // Resolve lazily: loading the plugin must not require an active network host.
  // Electron's network stack uses the same system/session proxy as Obsidian.
  const electronRequire = window.require;
  const electron = electronRequire?.("electron") as {
    net?: { request: CodexNativeRequestFactory };
    remote?: { net?: { request: CodexNativeRequestFactory } };
  } | undefined;
  const net = electron?.net ?? electron?.remote?.net;
  if (!net?.request) throw new Error("Codex desktop network transport unavailable");
  return net.request(options);
}

/** Fetch subset used by Pi's Codex SSE module, without renderer CORS. */
export function createCodexDesktopFetch(
  requestFactory: CodexNativeRequestFactory = desktopRequest
): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init = {}) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal;
    const abortError = () => signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Request was aborted", "AbortError");
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let request: CodexNativeRequest | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let receivedResponse = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const stopRequest = () => request?.abort();
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      const failure = error instanceof Error ? error : new Error("Codex network request failed");
      controller?.error(failure);
      reject(failure);
      stopRequest();
    };
    const onAbort = () => fail(abortError());

    try {
      request = requestFactory({
        url: input,
        method: init.method ?? "GET",
        redirect: "error"
      });
      request.on("error", fail);
      request.on("abort", () => fail(abortError()));
      // ClientRequest is a Writable: Electron emits its close after uploading,
      // even before response headers. Only the response's close can truncate SSE.
      request.on("response", (response: CodexNativeResponse) => {
        if (finished) return;
        if (receivedResponse) {
          fail(new Error("Codex network received repeated response"));
          return;
        }
        receivedResponse = true;
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
              // Pi cancels its reader when the user stops after headers arrive.
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
          response.once("aborted", () => fail(new Error("Codex network response interrupted")));
          response.once("close", () => {
            if (!finished) fail(new Error("Codex network response closed before completion"));
          });
          // Adding data starts the native readable. Register terminal listeners
          // first so a buffered short response cannot end across remote IPC early.
          response.on("data", (chunk: Uint8Array) => {
            if (finished) return;
            try {
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
      new Headers(init.headers).forEach((value, name) => request!.setHeader(name, value));
      if (init.body != null) {
        if (typeof init.body === "string") request.write(init.body);
        else if (init.body instanceof ArrayBuffer) request.write(new Uint8Array(init.body));
        else if (ArrayBuffer.isView(init.body)) {
          request.write(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength));
        } else {
          throw new TypeError("Unsupported Codex request body");
        }
      }
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}

export const codexDesktopFetch = createCodexDesktopFetch();
