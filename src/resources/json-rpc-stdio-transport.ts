import { spawn } from "node:child_process";

export interface JsonRpcMessage {
  id?: number | string;
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcStdioLaunch {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: number | null;
};

export abstract class JsonRpcStdioTransport {
  private process: ReturnType<typeof spawn> | null = null;
  private buffer = "";
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly options: {
    closedMessage?: string;
    disposeMessage?: string;
    timeoutMessage?: (method: string) => string;
    exitMessage?: (code: number | null, signal: NodeJS.Signals | null) => string;
    disableTimeoutForNonPositive?: boolean;
  } = {}) {}

  start(): void {
    if (this.process) return;
    this.disposed = false;
    const launch = this.buildCommand();
    const child = spawn(launch.command, launch.args ?? [], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    child.on("error", (error) => this.closeWithError(error));
    child.on("exit", (code, signal) => this.closeWithError(
      new Error(this.options.exitMessage?.(code, signal) ?? `JSON-RPC process exited with code ${code ?? "unknown"}`)
    ));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000, onWritten?: () => void): Promise<T> {
    if (!this.process || this.disposed) {
      return Promise.reject(new Error(this.options.closedMessage ?? "JSON-RPC transport is closed."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const noTimeout = timeoutMs <= 0 && this.options.disableTimeoutForNonPositive !== false;
      const timer = noTimeout ? null : window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.options.timeoutMessage?.(method) ?? `JSON-RPC request timed out: ${method}`));
      }, Math.max(0, timeoutMs));
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
        onWritten?.();
      } catch (error) {
        if (timer) window.clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void | Promise<void> {
    if (!this.process || this.disposed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error(this.options.disposeMessage ?? this.options.closedMessage ?? "JSON-RPC transport closed."));
    const child = this.process;
    this.process = null;
    child?.kill();
  }

  protected abstract buildCommand(): JsonRpcStdioLaunch;
  protected abstract handleMessage(message: JsonRpcMessage): void;

  protected formatResponseError(message: JsonRpcMessage, pending: { method: string }): Error {
    return new Error(String(message.error?.message ?? `${pending.method} request failed`));
  }

  private write(message: JsonRpcMessage): void {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || !stdin || this.disposed || !stdin.writable) {
      throw new Error(this.options.closedMessage ?? "JSON-RPC transport is closed.");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line.startsWith("{")) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      const id = Number(message.id);
      const pending = Number.isFinite(id) ? this.pending.get(id) : undefined;
      if (!pending) {
        this.handleMessage(message);
        continue;
      }
      this.pending.delete(id);
      if (pending.timer) window.clearTimeout(pending.timer);
      if (message.error) pending.reject(this.formatResponseError(message, pending));
      else pending.resolve(message.result);
    }
  }

  private closeWithError(error: Error): void {
    if (this.disposed) return;
    this.process = null;
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
