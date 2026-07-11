import type { CodexServerRequest } from "../types/app-server";
import { JsonRpcStdioTransport, type JsonRpcMessage, type JsonRpcStdioLaunch } from "./json-rpc-stdio-transport";

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>;

export interface CodexRpcLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class CodexRpcClient extends JsonRpcStdioTransport {
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();

  constructor(private readonly launch: CodexRpcLaunchOptions) {
    super({
      closedMessage: "Codex app-server 未连接",
      disposeMessage: "Codex app-server 已关闭",
      timeoutMessage: (method) => `请求超时：${method}`,
      exitMessage: (code, signal) => [
        "Codex app-server 已退出",
        typeof code === "number" ? `退出码 ${code}` : "",
        signal ? `信号 ${signal}` : ""
      ].filter(Boolean).join("，"),
      killTimeoutMs: 2500,
      collectStderr: true
    });
  }

  protected buildCommand(): JsonRpcStdioLaunch {
    return this.launch;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.isAlive()) throw new Error("Codex app-server 未连接");
    return super.request<T>(method, params, timeoutMs);
  }

  async initialize(): Promise<unknown> {
    const result = await this.request(
      "initialize",
      {
        clientInfo: { name: "codex-for-obsidian", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      },
      15000
    );
    this.notify("initialized");
    return result;
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  protected handleMessage(message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message as { id: number | string; method: string; params: unknown });
      return;
    }

    if (message.method) {
      this.emitNotification(message.method, message.params);
    }
  }

  protected formatResponseError(message: JsonRpcMessage): Error {
    return formatJsonRpcError(message.error);
  }

  protected formatProcessError(error: Error): Error {
    return formatProcessError(error, this.launch.command);
  }

  protected handleTransportError(error: Error): void {
    this.emitNotification("error", {
      message: this.formatProcessError(error).message,
      code: processErrorCode(error),
      stderr: this.getRecentStderr()
    });
  }

  protected handleTransportExit(error: Error, code: number | null, signal: NodeJS.Signals | null): void {
    this.emitNotification("error", {
      message: error.message,
      code: "APP_SERVER_EXIT",
      exitCode: typeof code === "number" ? code : undefined,
      signal: signal ?? undefined,
      stderr: this.getRecentStderr()
    });
  }

  private emitNotification(method: string, params?: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) handler(params);
  }

  private async handleServerRequest(message: { id: number | string; method: string; params: unknown }): Promise<void> {
    const handler = this.serverRequestHandlers.get(message.method);
    try {
      const result = handler ? await handler({ id: message.id, method: message.method, params: message.params }) : {};
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

function formatProcessError(error: unknown, command: string): Error {
  const code = processErrorCode(error);
  if (code === "ENOENT") return new Error(`找不到 Codex CLI：${command}`);
  return error instanceof Error ? error : new Error(String(error));
}

function processErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

export function formatJsonRpcError(error: unknown): Error {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const code = record?.code !== undefined ? String(record.code) : "";
  const message = typeof record?.message === "string" && record.message.trim() ? record.message.trim() : "JSON-RPC 请求失败";
  const data = record?.data !== undefined ? safeStringify(record.data) : "";
  return new Error([
    "JSON-RPC 错误",
    code ? `错误码：${code}` : "",
    `消息：${message}`,
    data ? `数据：${data}` : ""
  ].filter(Boolean).join("\n"));
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
