import { spawn } from "child_process";

export interface JsonRpcMessage {
  id?: number | string;
  jsonrpc?: "2.0";
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface JsonRpcProcessLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream & { setEncoding?: (encoding: BufferEncoding) => void };
  stderr?: NodeJS.ReadableStream & { setEncoding?: (encoding: BufferEncoding) => void };
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean | void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  on?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface JsonRpcStdioLaunch {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface JsonRpcStdioTransportOptions {
  defaultTimeoutMs?: number;
  closedMessage?: string;
  disposeMessage?: string;
  timeoutMessage?: (method: string) => string;
  exitMessage?: (code: number | null, signal: NodeJS.Signals | null) => string;
  killTimeoutMs?: number;
  killOnDispose?: boolean;
  collectStderr?: boolean;
  disableTimeoutForNonPositive?: boolean;
}

interface PendingJsonRpcRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export abstract class JsonRpcStdioTransport {
  protected process: JsonRpcProcessLike | null = null;
  protected disposed = false;
  private processExited = false;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingJsonRpcRequest>();
  private readonly stderrLines: string[] = [];

  constructor(private readonly options: JsonRpcStdioTransportOptions = {}) {}

  start(): void {
    if (this.process) return;
    this.disposed = false;
    this.processExited = false;
    const child = this.createProcess();
    this.process = child;
    child.stdout.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    child.stdout.on("error", (error) => this.handleProcessError(error instanceof Error ? error : new Error(String(error))));
    child.stderr?.on("data", (chunk) => this.captureStderr(String(chunk)));
    child.on?.("error", (error) => this.handleProcessError(error));
    child.on?.("exit", (code, signal) => this.handleProcessExit(code, signal));
  }

  isAlive(): boolean {
    const child = this.process;
    return Boolean(child && !this.disposed && !this.processExited && !child.killed && child.stdin.writable);
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs = this.options.defaultTimeoutMs ?? 30000,
    onWritten?: () => void
  ): Promise<T> {
    if (!this.isAlive()) return Promise.reject(new Error(this.options.closedMessage ?? "JSON-RPC transport is closed."));
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const shouldDisableTimeout = timeoutMs <= 0 && (this.options.disableTimeoutForNonPositive ?? true);
      const timer = !shouldDisableTimeout
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(this.options.timeoutMessage?.(method) ?? `JSON-RPC request timed out: ${method}`));
        }, Math.max(0, timeoutMs))
        : null;
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write(message);
        try {
          onWritten?.();
        } catch {
          // A write observer must not turn an already-submitted request into a retryable failure.
        }
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.isAlive()) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  getRecentStderr(): string {
    return this.stderrLines.join("").trim();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error(this.options.disposeMessage ?? this.options.closedMessage ?? "JSON-RPC transport closed."));
    const child = this.process;
    if (!child) return;
    this.process = null;
    if (this.options.killOnDispose === false) return;
    const killTimeoutMs = this.options.killTimeoutMs;
    if (!killTimeoutMs) {
      child.kill();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, killTimeoutMs);
      child.once?.("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  protected buildCommand(): JsonRpcStdioLaunch {
    throw new Error("JsonRpcStdioTransport subclasses must implement buildCommand or createProcess.");
  }

  protected createProcess(): JsonRpcProcessLike {
    const launch = this.buildCommand();
    return spawn(launch.command, launch.args ?? [], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  protected abstract handleMessage(message: JsonRpcMessage): void;

  protected formatResponseError(message: JsonRpcMessage, pending: { method: string }): Error {
    return new Error(String(message.error?.message ?? `${pending.method} request failed`));
  }

  protected formatProcessError(error: Error): Error {
    return error;
  }

  protected formatExitError(code: number | null, signal: NodeJS.Signals | null): Error {
    return new Error(this.options.exitMessage?.(code, signal) ?? `JSON-RPC process exited with code ${code ?? "unknown"}`);
  }

  protected rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  protected write(message: JsonRpcMessage): void {
    const child = this.process;
    if (!child || !this.isAlive()) throw new Error(this.options.closedMessage ?? "JSON-RPC transport is closed.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line || !line.startsWith("{")) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && this.handleResponse(message)) return;
    this.handleMessage(message);
  }

  private handleResponse(message: JsonRpcMessage): boolean {
    const id = Number(message.id);
    if (!Number.isFinite(id)) return false;
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) pending.reject(this.formatResponseError(message, pending));
    else pending.resolve(message.result);
    return true;
  }

  private handleProcessError(error: Error): void {
    const wasDisposed = this.disposed;
    this.processExited = true;
    this.process = null;
    this.rejectAll(this.formatProcessError(error));
    if (!wasDisposed) this.handleTransportError(error);
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasDisposed = this.disposed;
    this.processExited = true;
    this.process = null;
    const error = this.formatExitError(code, signal);
    this.rejectAll(error);
    if (!wasDisposed) this.handleTransportExit(error, code, signal);
  }

  protected handleTransportError(_error: Error): void {}

  protected handleTransportExit(_error: Error, _code: number | null, _signal: NodeJS.Signals | null): void {}

  private captureStderr(text: string): void {
    if (!this.options.collectStderr) return;
    this.stderrLines.push(text);
    if (this.stderrLines.length > 30) this.stderrLines.shift();
  }
}
