/**
 * The plugin side of the sync-service protocol (echoink-web/sync-service/README.md). Pure data in, data out;
 * the engine decides what to do with it, and tests hand in an in-memory stand-in with the same shape.
 */
export interface CloudChange { readonly deviceId: string; readonly path: string; readonly rev: number; readonly size: number; readonly sha256: string; readonly deleted: boolean; readonly cursor: number; readonly content?: string; readonly url?: string; readonly expiresAt?: number; /** Client-encrypted version metadata, opaque to the service. */ readonly meta?: string }
export interface CloudRegistration { readonly deviceId: string; readonly userId: string; readonly cursor: number; readonly usedBytes: number; readonly quotaBytes: number; readonly readOnly: boolean; readonly status: "active" | "grace" | "none"; readonly graceUntil: number | null; readonly keyEpoch: number; readonly smallFileLimit: number; readonly devices: readonly { deviceId: string; name: string; kind: string; lastSeenAt: number }[] }
export interface CloudUsage { readonly usedBytes: number; readonly quotaBytes: number; readonly cursor: number; readonly status: "active" | "grace" | "none"; readonly readOnly: boolean; readonly graceUntil: number | null; readonly keyEpoch: number; readonly devices: readonly { deviceId: string; name: string; kind: string; lastSeenAt: number }[] }
export interface CloudFileRef { readonly path: string; readonly rev: number; readonly size: number; readonly sha256: string; readonly meta?: string }
export type CloudCommitStatus = "committed" | "already" | "stale";
export interface CloudLivePage { readonly fromCursor: number; readonly cursor: number; readonly keyEpoch: number; readonly changes: readonly CloudChange[] }
export interface CloudLiveHandlers { onChanges?(page: CloudLivePage): void; onCursor(cursor: number): void; onOpen(cursor: number, keyEpoch: number): void; onClose(): void }

export class CloudApiError extends Error {
  readonly code: string; readonly status: number; readonly extra: Record<string, unknown>;
  constructor(code: string, status: number, extra: Record<string, unknown> = {}) { super(code); this.code = code; this.status = status; this.extra = extra; }
}
export class CloudNetworkError extends Error { constructor(message = "NETWORK") { super(message); } }

export function isCloudRateLimited(error: unknown): error is CloudApiError & { readonly status: 429 } {
  return error instanceof CloudApiError && error.status === 429;
}

function retrySeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER / 1_000
    ? value : undefined;
}

export function cloudRetryDelay(error: CloudApiError, fallbackMs: number): number {
  const seconds = retrySeconds(error.extra.retryAfter);
  return seconds === undefined ? fallbackMs : seconds * 1_000;
}

function responseRetryAfter(headers: Record<string, string> = {}): number | undefined {
  const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1].trim();
  if (!header) return undefined;
  if (/^\d+$/u.test(header)) return retrySeconds(Number(header));
  if (/^[A-Za-z]{3}, /u.test(header)) return retrySeconds(Math.ceil((Date.parse(header) - Date.now()) / 1_000));
  return undefined;
}

export interface CloudSyncClientPort {
  register(input: { deviceId: string; name: string; kind: "desktop" | "phone" | "tablet" }): Promise<CloudRegistration>;
  usage(): Promise<CloudUsage>;
  changes(since: number): Promise<{ changes: readonly CloudChange[]; next: number; more: boolean; cursor: number; keyEpoch: number }>;
  putSmall(file: CloudFileRef & { content: Uint8Array }): Promise<{ status: CloudCommitStatus; cursor: number; usedBytes?: number }>;
  /** Many small files in one request; services without it answer 404 and the engine falls back to putSmall. */
  putBatch?(files: readonly (CloudFileRef & { content: Uint8Array })[]): Promise<{ cursor: number; usedBytes?: number; results: readonly { path: string; rev: number; status: CloudCommitStatus }[] }>;
  uploadUrls(files: readonly CloudFileRef[]): Promise<readonly { path: string; rev: number; status: "upload" | "stale"; url?: string }[]>;
  putObject(url: string, bytes: Uint8Array): Promise<void>;
  commit(files: readonly ({ path: string; rev: number; size: number; meta?: string } | { path: string; rev: number; deleted: true })[]): Promise<{ cursor: number; usedBytes?: number; results: readonly { path: string; rev: number; status: CloudCommitStatus }[] }>;
  downloadUrls(files: readonly { deviceId: string; path: string; rev: number }[]): Promise<readonly { deviceId: string; path: string; rev: number; status: "inline" | "download" | "missing"; content?: string; url?: string }[]>;
  getObject(url: string): Promise<Uint8Array>;
  reset(): Promise<{ cursor: number; keyEpoch: number }>;
  revokeDevice(deviceId: string): Promise<void>;
  /** Long connection; returns null when the platform has no WebSocket. */
  live(deviceId: string, handlers: CloudLiveHandlers): { close(): void } | null;
}

/** What the plugin host provides: a JSON request (obsidian requestUrl underneath), binary transfers, and a WebSocket factory. */
export interface CloudTransport {
  json(path: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  putBytes(url: string, bytes: Uint8Array): Promise<number | { status: number; headers: Record<string, string> }>;
  getBytes(url: string): Promise<{ status: number; bytes: Uint8Array; headers?: Record<string, string> }>;
  websocket?(url: string): WebSocket;
}

/** Leaves room under the service's 120/minute per-device bucket for reconnects and usage reads. */
const REQUEST_BURST = 20;
const bytesToBase64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };

export class CloudSyncClient implements CloudSyncClientPort {
  private tokens = REQUEST_BURST;
  private tokensAt = 0;
  constructor(private readonly options: { apiUrl: string; token: () => string | null; deviceId: string; transport: CloudTransport; requestsPerMinute?: number }) {}
  /** Token bucket under the service's per-device budget: bursts go out at once, only sustained floods wait. */
  private async throttle(): Promise<void> {
    const perMs = (this.options.requestsPerMinute ?? 100) / 60_000;
    for (;;) {
      const at = Date.now();
      this.tokens = Math.min(REQUEST_BURST, this.tokens + (at - (this.tokensAt || at)) * perMs); this.tokensAt = at;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      await new Promise<void>(resolve => window.setTimeout(resolve, Math.ceil((1 - this.tokens) / perMs)));
    }
  }
  private get headers(): Record<string, string> {
    const token = this.options.token();
    if (!token) throw new CloudApiError("AUTH_REQUIRED", 401);
    return { Authorization: `Bearer ${token}`, "X-Sync-Device": this.options.deviceId };
  }
  private async call<T>(path: string, method: string, body?: unknown): Promise<T> {
    await this.throttle();
    let result: { status: number; body: unknown; headers: Record<string, string> };
    try { result = await this.options.transport.json(`${this.options.apiUrl}${path}`, method, body, this.headers); }
    catch (error) { if (error instanceof CloudApiError) throw error; throw new CloudNetworkError(); }
    if (result.status >= 400) {
      const error = result.body as { error?: string; retryAfter?: unknown } | null;
      const retryAfter = retrySeconds(error?.retryAfter) ?? responseRetryAfter(result.headers);
      const code = typeof error?.error === "string" && error.error ? error.error : "REQUEST_FAILED";
      throw new CloudApiError(code, result.status, { ...error, retryAfter });
    }
    return result.body as T;
  }
  register(input: { deviceId: string; name: string; kind: "desktop" | "phone" | "tablet" }): Promise<CloudRegistration> { return this.call("/sync/devices", "POST", input); }
  usage(): Promise<CloudUsage> { return this.call("/sync/usage", "GET"); }
  changes(since: number) { return this.call<{ changes: CloudChange[]; next: number; more: boolean; cursor: number; keyEpoch: number }>(`/sync/changes?since=${since}`, "GET"); }
  putSmall(file: CloudFileRef & { content: Uint8Array }) { return this.call<{ status: CloudCommitStatus; cursor: number; usedBytes?: number }>("/sync/put-small", "POST", { path: file.path, rev: file.rev, size: file.size, sha256: file.sha256, content: bytesToBase64(file.content), ...(file.meta ? { meta: file.meta } : {}) }); }
  putBatch(files: readonly (CloudFileRef & { content: Uint8Array })[]) {
    return this.call<{ cursor: number; usedBytes?: number; results: { path: string; rev: number; status: CloudCommitStatus }[] }>("/sync/put-batch", "POST",
      { files: files.map(file => ({ path: file.path, rev: file.rev, size: file.size, sha256: file.sha256, content: bytesToBase64(file.content), ...(file.meta ? { meta: file.meta } : {}) })) });
  }
  async uploadUrls(files: readonly CloudFileRef[]) { return (await this.call<{ files: { path: string; rev: number; status: "upload" | "stale"; url?: string }[] }>("/sync/upload-urls", "POST", { files })).files; }
  async putObject(url: string, bytes: Uint8Array): Promise<void> {
    let result: Awaited<ReturnType<CloudTransport["putBytes"]>>;
    try { result = await this.options.transport.putBytes(url, bytes); } catch { throw new CloudNetworkError("FILE_TRANSFER"); }
    const { status, headers } = typeof result === "number" ? { status: result, headers: undefined } : result;
    if (status >= 400) throw new CloudApiError("OBJECT_PUT_FAILED", status, { retryAfter: responseRetryAfter(headers) });
  }
  commit(files: readonly ({ path: string; rev: number; size: number } | { path: string; rev: number; deleted: true })[]) { return this.call<{ cursor: number; usedBytes?: number; results: { path: string; rev: number; status: CloudCommitStatus }[] }>("/sync/commit", "POST", { files: files.map(file => "deleted" in file && file.deleted ? { ...file, size: 0 } : file) }); }
  async downloadUrls(files: readonly { deviceId: string; path: string; rev: number }[]) { return (await this.call<{ files: { deviceId: string; path: string; rev: number; status: "inline" | "download" | "missing"; content?: string; url?: string }[] }>("/sync/download-urls", "POST", { files })).files; }
  async getObject(url: string): Promise<Uint8Array> {
    let result: Awaited<ReturnType<CloudTransport["getBytes"]>>;
    try { result = await this.options.transport.getBytes(url); } catch { throw new CloudNetworkError("FILE_TRANSFER"); }
    if (result.status >= 400) throw new CloudApiError("OBJECT_GET_FAILED", result.status, { retryAfter: responseRetryAfter(result.headers) });
    return result.bytes;
  }
  reset() { return this.call<{ cursor: number; keyEpoch: number }>("/sync/reset", "POST", {}); }
  async revokeDevice(deviceId: string): Promise<void> { await this.call(`/api/devices/${encodeURIComponent(deviceId)}`, "DELETE"); }
  live(deviceId: string, handlers: CloudLiveHandlers): { close(): void } | null {
    const transport = this.options.transport, token = this.options.token();
    if (!transport.websocket || !token) return null;
    let socket: WebSocket;
    try { socket = transport.websocket(`${this.options.apiUrl.replace(/^http/u, "ws")}/sync/live`); } catch { return null; }
    socket.onopen = () => { socket.send(JSON.stringify({ token, deviceId, ...(handlers.onChanges ? { pushChanges: true } : {}) })); };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; cursor?: number; keyEpoch?: number; fromCursor?: number; changes?: CloudChange[] };
        if (message.type === "hello" && typeof message.cursor === "number") handlers.onOpen(message.cursor, message.keyEpoch ?? 0);
        else if (message.type === "cursor" && typeof message.cursor === "number") {
          const changes = message.changes;
          if (handlers.onChanges && Number.isSafeInteger(message.fromCursor) && message.fromCursor! >= 0 && Number.isSafeInteger(message.keyEpoch) && message.keyEpoch! >= 0
            && Number.isSafeInteger(message.cursor) && message.fromCursor! < message.cursor
            && Array.isArray(changes) && changes.length === message.cursor - message.fromCursor! && changes.length <= 200 && changes.every((change, index) =>
              typeof change.deviceId === "string" && typeof change.path === "string" && change.path.length <= 512
              && Number.isSafeInteger(change.rev) && change.rev > 0 && Number.isSafeInteger(change.size) && change.size >= 0
              && typeof change.deleted === "boolean" && typeof change.sha256 === "string" && Number.isSafeInteger(change.cursor)
              && change.cursor === message.fromCursor! + index + 1
              && (change.deleted || (typeof change.content === "string" && change.content.length <= 131072) || (typeof change.url === "string" && /^https?:\/\//u.test(change.url) && typeof change.expiresAt === "number")))) {
            handlers.onChanges({ fromCursor: message.fromCursor!, cursor: message.cursor, keyEpoch: message.keyEpoch!, changes });
          } else handlers.onCursor(message.cursor);
        }
      } catch { /* ignore noise */ }
    };
    socket.onclose = () => handlers.onClose();
    socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
    return { close: () => { socket.onclose = null; try { socket.close(); } catch { /* already closed */ } } };
  }
}
