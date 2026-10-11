import { requestUrl, type RequestUrlResponse } from "obsidian";
import type {
  EchoInkMcpConnectionConfig,
  EchoInkMcpConnectionRecords,
  EchoInkResource
} from "./types";
import { resolveMcpConnectionConfig } from "./mcp-connections";
import { swallowError } from "../core/error-handling";
import { JsonRpcStdioTransport, type JsonRpcMessage, type JsonRpcStdioLaunch } from "./json-rpc-stdio-transport";

export interface EchoInkMcpBrokerInvocation {
  resource: EchoInkResource;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface EchoInkMcpBrokerTransport {
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<unknown>;
  notify?(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<void>;
  close(): Promise<void>;
}

export interface EchoInkMcpBrokerOptions {
  connections?: EchoInkMcpConnectionRecords;
  transportFactory?: (config: EchoInkMcpConnectionConfig) => Promise<EchoInkMcpBrokerTransport>;
  /** Resolves a SecretStorage reference into an ephemeral transport config. */
  credentialResolver?: (
    resource: EchoInkResource,
    config: EchoInkMcpConnectionConfig
  ) => Promise<EchoInkMcpConnectionConfig>;
  /** Must contain only display-safe config identity, never the secret value. */
  transportPoolKey?: (
    resource: EchoInkResource,
    config: EchoInkMcpConnectionConfig
  ) => string;
}

export interface EchoInkMcpBrokerResult {
  content: unknown;
}

export interface EchoInkMcpToolListResult {
  tools: unknown[];
}

const transportPool = new Map<string, Promise<EchoInkMcpBrokerTransport>>();

export type EchoInkMcpBrokerErrorCode =
  | "connection_failed"
  | "authentication_failed"
  | "schema_invalid"
  | "disconnected"
  | "timeout"
  | "call_failed";

export class EchoInkMcpBrokerError extends Error {
  constructor(
    readonly code: EchoInkMcpBrokerErrorCode,
    safeMessage: string
  ) {
    super(safeMessage);
    this.name = "EchoInkMcpBrokerError";
  }
}

export function mcpBrokerConnectionConfig(resource: EchoInkResource): EchoInkMcpConnectionConfig | null {
  return resolveMcpConnectionConfig(resource, { mcpConnections: {} } as any);
}

export function isMcpBrokerConnectable(resource: EchoInkResource, connections?: EchoInkMcpConnectionRecords): boolean {
  return Boolean(resolveMcpConnectionConfig(resource, { mcpConnections: connections ?? {} } as any));
}

export function mcpBrokerResourceStatus(resource: EchoInkResource, connections?: EchoInkMcpConnectionRecords): "connectable" | "imported-only" | "not-mcp" {
  if (resource.kind !== "mcp-server") return "not-mcp";
  return isMcpBrokerConnectable(resource, connections) ? "connectable" : "imported-only";
}

export class EchoInkMcpBroker {
  constructor(private readonly options: EchoInkMcpBrokerOptions) {}

  async listTools(
    resource: EchoInkResource,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<EchoInkMcpToolListResult> {
    const publicConfig = resolveMcpConnectionConfig(resource, { mcpConnections: this.options.connections ?? {} } as any);
    if (!publicConfig) throw brokerError("connection_failed", "MCP 资源没有 EchoInk broker 连接配置。");
    const config = await this.resolveRuntimeConfig(resource, publicConfig);
    throwIfMcpAborted(signal);
    let transport: EchoInkMcpBrokerTransport | undefined;
    try {
      transport = await getPooledMcpTransport(
        config,
        this.options.transportFactory ?? createDefaultMcpTransport,
        timeoutMs,
        signal,
        this.poolKey(resource, publicConfig)
      );
      throwIfMcpAborted(signal);
      const result = await transport.request(
        "tools/list",
        {},
        timeoutMs,
        signal
      );
      if (!result || typeof result !== "object" || !Array.isArray((result as any).tools)) {
        throw brokerError("schema_invalid", "MCP tools/list 返回了非法 Schema。");
      }
      const tools = (result as any).tools;
      return { tools };
    } catch (error) {
      if (transport) await closePooledMcpTransport(config, "close MCP broker transport after listTools failure", this.poolKey(resource, publicConfig));
      throw normalizeBrokerError(error, "connection_failed");
    }
  }

  async callTool(invocation: EchoInkMcpBrokerInvocation): Promise<EchoInkMcpBrokerResult> {
    const publicConfig = resolveMcpConnectionConfig(invocation.resource, { mcpConnections: this.options.connections ?? {} } as any);
    if (!publicConfig) {
      throw brokerError("connection_failed", "MCP 资源没有 EchoInk broker 连接配置。");
    }
    const config = await this.resolveRuntimeConfig(invocation.resource, publicConfig);
    throwIfMcpAborted(invocation.signal);
    let transport: EchoInkMcpBrokerTransport | undefined;
    try {
      transport = await getPooledMcpTransport(
        config,
        this.options.transportFactory ?? createDefaultMcpTransport,
        invocation.timeoutMs,
        invocation.signal,
        this.poolKey(invocation.resource, publicConfig)
      );
      const content = await transport.request(
        "tools/call",
        {
          name: invocation.toolName,
          arguments: invocation.arguments ?? {}
        },
        invocation.timeoutMs ?? 30000,
        invocation.signal
      );
      return { content };
    } catch (error) {
      if (transport) await closePooledMcpTransport(config, "close MCP broker transport after callTool failure", this.poolKey(invocation.resource, publicConfig));
      throw normalizeBrokerError(error, "call_failed");
    }
  }

  private async resolveRuntimeConfig(
    resource: EchoInkResource,
    config: EchoInkMcpConnectionConfig
  ): Promise<EchoInkMcpConnectionConfig> {
    if (!this.options.credentialResolver) return config;
    try {
      return await this.options.credentialResolver(resource, config);
    } catch (error) {
      throw normalizeBrokerError(error, "authentication_failed");
    }
  }

  private poolKey(resource: EchoInkResource, config: EchoInkMcpConnectionConfig): string {
    return this.options.transportPoolKey?.(resource, config)
      ?? mcpTransportPoolKey(config);
  }
}

export async function closeMcpBrokerConnectionPool(): Promise<void> {
  const pending = Array.from(transportPool.values());
  transportPool.clear();
  const settled = await Promise.allSettled(pending);
  await Promise.allSettled(settled.map((result) => {
    if (result.status !== "fulfilled") return Promise.resolve();
    return result.value.close().catch(swallowError("close pooled MCP broker transport"));
  }));
}

async function getPooledMcpTransport(
  config: EchoInkMcpConnectionConfig,
  transportFactory: (config: EchoInkMcpConnectionConfig) => Promise<EchoInkMcpBrokerTransport>,
  timeoutMs = 30000,
  signal?: AbortSignal,
  safePoolKey?: string
): Promise<EchoInkMcpBrokerTransport> {
  throwIfMcpAborted(signal);
  const key = safePoolKey ?? mcpTransportPoolKey(config);
  let transportPromise = transportPool.get(key);
  const shared = Boolean(transportPromise);
  if (!transportPromise) {
    transportPromise = createInitializedMcpTransport(
      config,
      transportFactory,
      timeoutMs,
      signal
    );
    transportPool.set(key, transportPromise);
    transportPromise.catch(() => {
      if (transportPool.get(key) === transportPromise) transportPool.delete(key);
    });
  }
  // A later caller may cancel its own wait without closing the shared initialization.
  // Failed initialization already closes its transport and removes its pool entry.
  let transport: EchoInkMcpBrokerTransport;
  if (signal && shared) {
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(mcpAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      throwIfMcpAborted(signal);
      transport = await Promise.race([transportPromise, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  } else {
    transport = await transportPromise;
  }
  throwIfMcpAborted(signal);
  return transport;
}

async function createInitializedMcpTransport(
  config: EchoInkMcpConnectionConfig,
  transportFactory: (config: EchoInkMcpConnectionConfig) => Promise<EchoInkMcpBrokerTransport>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<EchoInkMcpBrokerTransport> {
  const transport = await transportFactory(config);
  try {
    await initializeMcpClient(transport, timeoutMs, signal);
    return transport;
  } catch (error) {
    await transport.close().catch(swallowError("close MCP broker transport after initialize failure"));
    throw error;
  }
}

async function closePooledMcpTransport(
  config: EchoInkMcpConnectionConfig,
  context: string,
  safePoolKey?: string
): Promise<void> {
  const key = safePoolKey ?? mcpTransportPoolKey(config);
  const transportPromise = transportPool.get(key);
  if (!transportPromise) return;
  transportPool.delete(key);
  const transport = await transportPromise.catch(() => null);
  if (transport) await transport.close().catch(swallowError(context));
}

function mcpTransportPoolKey(config: EchoInkMcpConnectionConfig): string {
  return JSON.stringify(stableJson(config));
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, raw]) => [key, stableJson(raw)])
  );
}

async function initializeMcpClient(
  transport: EchoInkMcpBrokerTransport,
  timeoutMs = 30000,
  signal?: AbortSignal
): Promise<void> {
  await transport.request(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "EchoInk", version: "1.0.0" }
    },
    timeoutMs,
    signal
  );
  throwIfMcpAborted(signal);
  await transport.notify?.("notifications/initialized", {}, signal, timeoutMs);
}

async function createDefaultMcpTransport(config: EchoInkMcpConnectionConfig): Promise<EchoInkMcpBrokerTransport> {
  if (config.transport === "http") return new HttpMcpTransport(config);
  return await StdioMcpTransport.start(config);
}

class HttpMcpTransport implements EchoInkMcpBrokerTransport {
  private nextId = 1;
  private sessionId = "";
  private closed = false;
  private readonly pending = new Set<() => void>();
  constructor(private readonly config: Extract<EchoInkMcpConnectionConfig, { transport: "http" }>) {}

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30000,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params: params ?? {} }, timeoutMs, signal);
      this.assertOpen(signal);
      const returnedSessionId = mcpHttpHeader(response, "mcp-session-id").trim();
      if (returnedSessionId) {
        if (!/^[\x21-\x7e]{1,256}$/u.test(returnedSessionId)) {
          throw brokerError("schema_invalid", "MCP Server 返回了非法 Session ID。");
        }
      }
      const data = parseMcpHttpResponse(response);
      if (data?.error) {
        throw brokerError("call_failed", safeJsonRpcError(data.error));
      }
      if (returnedSessionId) this.sessionId = returnedSessionId;
      return data?.result;
    } catch (error) {
      throw normalizeBrokerError(error, "connection_failed");
    }
  }

  async notify(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30000
  ): Promise<void> {
    try {
      await this.post({ jsonrpc: "2.0", method, params: params ?? {} }, timeoutMs, signal);
      this.assertOpen(signal);
    } catch (error) {
      throw normalizeBrokerError(error, "connection_failed");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.pending) cancel();
  }

  private assertOpen(signal?: AbortSignal): void {
    throwIfMcpAborted(signal);
    if (this.closed) throw brokerError("disconnected", "MCP Server 已断线。");
  }

  private post(
    message: { method: string } & Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RequestUrlResponse> {
    this.assertOpen(signal);
    // Obsidian's CORS-free requestUrl cannot abort the underlying HTTP request.
    // Only the local wait is cancelled; late responses must have no effects here.
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(onClose);
        action();
      };
      const onAbort = () => finish(() => reject(mcpAbortError()));
      const onClose = () => finish(() => reject(brokerError("disconnected", "MCP Server 已断线。")));
      const timer = setTimeout(() => finish(() => reject(
        brokerError("timeout", `MCP 请求超时：${message.method}。`)
      )), timeoutMs);
      this.pending.add(onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        void requestUrl({
          url: this.config.url,
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(message),
          throw: false
        }).then((response) => finish(() => {
          if (response.status === 401 || response.status === 403) {
            reject(brokerError("authentication_failed", "MCP 认证失败，请检查 Credential。"));
          } else if (response.status < 200 || response.status >= 300) {
            reject(brokerError("connection_failed", `MCP HTTP ${response.status}。`));
          } else {
            resolve(response);
          }
        }), (error: unknown) => finish(() => reject(normalizeBrokerError(error, "connection_failed"))));
      } catch (error) {
        finish(() => reject(normalizeBrokerError(error, "connection_failed")));
      }
    });
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.config.headers ?? {})
    };
  }
}

class StdioMcpTransport extends JsonRpcStdioTransport implements EchoInkMcpBrokerTransport {
  private constructor(private readonly config: Extract<EchoInkMcpConnectionConfig, { transport: "stdio" }>) {
    super({
      closedMessage: "MCP transport closed",
      disposeMessage: "MCP transport closed",
      timeoutMessage: (method) => `MCP request timed out: ${method}`,
      exitMessage: (code) => `MCP server exited with code ${code ?? "unknown"}`,
      disableTimeoutForNonPositive: false
    });
  }

  static async start(config: Extract<EchoInkMcpConnectionConfig, { transport: "stdio" }>): Promise<StdioMcpTransport> {
    const transport = new StdioMcpTransport(config);
    transport.start();
    return transport;
  }

  protected buildCommand(): JsonRpcStdioLaunch {
    return {
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: this.config.cwd || process.cwd(),
      env: { ...process.env, ...(this.config.env ?? {}) }
    };
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    onWritten?: () => void
  ): Promise<T>;
  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<T>;
  async request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = 30000,
    completion?: (() => void) | AbortSignal
  ): Promise<T> {
    if (typeof completion === "function") {
      return await super.request<T>(
        method,
        params,
        timeoutMs,
        completion
      );
    }
    const signal = completion;
    if (!signal) {
      return await super.request<T>(method, params, timeoutMs);
    }
    throwIfMcpAborted(signal);
    const operation = super.request<T>(method, params, timeoutMs);
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      void this.dispose();
      rejectAbort(mcpAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async notify(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfMcpAborted(signal);
    super.notify(method, params ?? {});
  }

  async close(): Promise<void> {
    await this.dispose();
  }

  protected handleMessage(_message: JsonRpcMessage): void {
    // MCP responses are handled by the shared transport; broker notifications are ignored.
  }

  protected formatResponseError(message: JsonRpcMessage): Error {
    return normalizeBrokerError(
      new Error(safeJsonRpcError(message.error)),
      "call_failed"
    );
  }
}

function mcpHttpHeader(response: RequestUrlResponse, name: string): string {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
}

function parseMcpHttpResponse(response: RequestUrlResponse): any {
  const contentType = mcpHttpHeader(response, "content-type").toLowerCase();
  const text = response.text;
  if (!text.trim()) {
    throw brokerError("schema_invalid", "MCP Server 返回了空响应。");
  }
  try {
    if (contentType.includes("text/event-stream")) {
      const payloads = text.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line && line !== "[DONE]");
      if (!payloads.length) {
        throw brokerError("schema_invalid", "MCP SSE 响应没有 JSON-RPC data 事件。");
      }
      return JSON.parse(payloads[payloads.length - 1]);
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof EchoInkMcpBrokerError) throw error;
    throw brokerError("schema_invalid", "MCP Server 返回了无法解析的 JSON-RPC 响应。");
  }
}

function safeJsonRpcError(error: unknown): string {
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const raw = typeof record?.message === "string" ? record.message : "MCP request failed";
  return sanitizeSingleLine(raw).slice(0, 300) || "MCP request failed";
}

function normalizeBrokerError(
  error: unknown,
  fallback: EchoInkMcpBrokerErrorCode
): EchoInkMcpBrokerError | Error {
  if (error instanceof EchoInkMcpBrokerError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  const safe = sanitizeSingleLine(message).slice(0, 300);
  if (/unauthori[sz]ed|forbidden|authentication|credential|\b401\b|\b403\b/iu.test(safe)) {
    return brokerError("authentication_failed", "MCP 认证失败，请检查 Credential。");
  }
  if (/timed? out|timeout/iu.test(safe)) {
    return brokerError("timeout", "MCP 请求超时。");
  }
  if (/closed|exited|broken pipe|econnreset|disconnected/iu.test(safe)) {
    return brokerError("disconnected", "MCP Server 已断线。");
  }
  return brokerError(fallback, safe || "MCP 请求失败。");
}

function sanitizeSingleLine(value: string): string {
  return value.replaceAll("\u0000", " ").replace(/[\r\n]+/gu, " ").trim();
}

function brokerError(
  code: EchoInkMcpBrokerErrorCode,
  message: string
): EchoInkMcpBrokerError {
  return new EchoInkMcpBrokerError(code, message.trim());
}

function throwIfMcpAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mcpAbortError();
}

function mcpAbortError(): Error {
  const error = new Error("MCP 工具调用已取消。");
  error.name = "AbortError";
  return error;
}
