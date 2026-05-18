import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import type { CodexServerRequest } from "../types/app-server";

type PendingRequest = {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | null;
};

type NotificationHandler = (params: any) => void;
type ServerRequestHandler = (request: CodexServerRequest) => Promise<any>;

export interface CodexRpcLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class CodexRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private stderrLines: string[] = [];
  private disposed = false;

  constructor(private readonly launch: CodexRpcLaunchOptions) {}

  start(): void {
    if (this.proc) return;
    this.disposed = false;
    this.proc = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: this.launch.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.stderrLines.push(text);
      if (this.stderrLines.length > 30) this.stderrLines.shift();
    });

    this.proc.on("exit", (code, signal) => {
      const wasDisposed = this.disposed;
      this.proc = null;
      const message = [
        "Codex app-server 已退出",
        typeof code === "number" ? `退出码 ${code}` : "",
        signal ? `信号 ${signal}` : ""
      ].filter(Boolean).join("，");
      const error = new Error(message);
      this.rejectAll(error);
      if (!wasDisposed) {
        this.emitNotification("error", {
          message,
          code: "APP_SERVER_EXIT",
          exitCode: typeof code === "number" ? code : undefined,
          signal: signal ?? undefined,
          stderr: this.getRecentStderr()
        });
      }
    });

    this.proc.on("error", (error) => {
      const wasDisposed = this.disposed;
      this.proc = null;
      const formatted = formatProcessError(error, this.launch.command);
      this.rejectAll(formatted);
      if (!wasDisposed) {
        this.emitNotification("error", {
          message: formatted.message,
          code: processErrorCode(error),
          stderr: this.getRecentStderr()
        });
      }
    });
  }

  isAlive(): boolean {
    return Boolean(this.proc && !this.disposed && !this.proc.killed && this.proc.stdin.writable);
  }

  async initialize(): Promise<any> {
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

  request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    if (!this.isAlive()) throw new Error("Codex app-server 未连接");
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`请求超时：${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer
      });
      try {
        this.sendRaw(message);
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: any): void {
    if (!this.isAlive()) return;
    this.sendRaw({ jsonrpc: "2.0", method, params });
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

  getRecentStderr(): string {
    return this.stderrLines.join("").trim();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectAll(new Error("Codex app-server 已关闭"));
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2500);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(formatJsonRpcError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.emitNotification(message.method, message.params);
    }
  }

  private emitNotification(method: string, params?: any): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const handler of handlers) handler(params);
  }

  private async handleServerRequest(message: { id: number | string; method: string; params: any }): Promise<void> {
    const handler = this.serverRequestHandlers.get(message.method);
    try {
      const result = handler ? await handler({ id: message.id, method: message.method, params: message.params }) : {};
      this.sendRaw({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.sendRaw({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  private sendRaw(message: unknown): void {
    const proc = this.proc;
    if (!proc || !this.isAlive()) throw new Error("Codex app-server 未连接");
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
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

export function formatJsonRpcError(error: any): Error {
  const code = error?.code !== undefined ? String(error.code) : "";
  const message = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "JSON-RPC 请求失败";
  const data = error?.data !== undefined ? safeStringify(error.data) : "";
  return new Error([
    "JSON-RPC 错误",
    code ? `错误码：${code}` : "",
    `消息：${message}`,
    data ? `数据：${data}` : ""
  ].filter(Boolean).join("\n"));
}

function safeStringify(value: any): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
