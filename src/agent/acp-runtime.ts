import { spawn } from "child_process";
import type { AgentBackendKind, AgentPromptPart, AgentTaskInput, AgentTaskResult } from "./types";
import type { AgentEvent, AgentEventSink } from "./events";
import type { AgentRichStreamRuntime } from "./runtime";
import { normalizeRichStreamEvents } from "./rich-stream";

export interface AcpRuntimeCommand {
  command: string | (() => string);
  args?: string[] | (() => string[]);
  cwd: string;
  env?: Record<string, string>;
}

export interface AcpSubprocessLike {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals | number): boolean | void;
  on?(event: "error", listener: (error: Error) => void): unknown;
  on?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface AcpRuntimeOptions {
  backend: Exclude<AgentBackendKind, "codex-cli">;
  command: AcpRuntimeCommand;
  processFactory?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => AcpSubprocessLike;
  requestTimeoutMs?: number;
}

interface JsonRpcMessage {
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

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_ACP_STARTUP_TIMEOUT_MS = 1500;
const ACP_METHOD_CANDIDATES = {
  cancel: ["session/cancel", "cancel"],
  initialize: ["initialize"],
  newSession: ["session/new", "newSession"],
  prompt: ["session/prompt", "prompt"]
} as const;

export class AcpAgentRuntime implements AgentRichStreamRuntime {
  readonly kind: Exclude<AgentBackendKind, "codex-cli">;
  private process: AcpSubprocessLike | null = null;
  private transport: AcpJsonRpcProcessTransport | null = null;
  private initialized = false;
  private activeRunId = "";
  private activeEmit: ((event: AgentEvent) => Promise<void>) | null = null;
  private eventQueue = Promise.resolve();
  private startupTimeoutMs = DEFAULT_ACP_STARTUP_TIMEOUT_MS;

  constructor(private readonly options: AcpRuntimeOptions) {
    this.kind = options.backend;
  }

  async connect() {
    if (!this.transport) {
      const command = resolveCommandValue(this.options.command.command);
      const args = resolveArgsValue(this.options.command.args);
      this.process = (this.options.processFactory ?? defaultAcpProcessFactory)(command, args, {
        cwd: this.options.command.cwd,
        env: { ...process.env, ...(this.options.command.env ?? {}) }
      });
      this.transport = new AcpJsonRpcProcessTransport(this.process, this.options.requestTimeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS);
      this.transport.onNotification("session/update", (params) => this.handleSessionUpdate(params));
      this.transport.onNotification("sessionUpdate", (params) => this.handleSessionUpdate(params));
      this.transport.onRequest("session/request_permission", async (params) => this.handlePermissionRequest(params));
      this.transport.onRequest("requestPermission", async (params) => this.handlePermissionRequest(params));
      this.transport.onRequest("fs/read_text_file", async () => ({ content: "" }));
      this.transport.onRequest("fs/readTextFile", async () => ({ content: "" }));
      this.transport.onRequest("fs/write_text_file", async () => {
        throw new Error("EchoInk ACP runtime does not allow direct file writes.");
      });
      this.transport.onRequest("fs/writeTextFile", async () => {
        throw new Error("EchoInk ACP runtime does not allow direct file writes.");
      });
      this.transport.onRequest("terminal/create", async () => {
        throw new Error("EchoInk ACP runtime does not expose terminal execution.");
      });
      this.transport.onRequest("terminalCreate", async () => {
        throw new Error("EchoInk ACP runtime does not expose terminal execution.");
      });
    }
    if (!this.initialized) {
      await this.requestWithFallback("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: {
          name: "codex-echoink",
          title: "Codex EchoInk",
          version: "1.0.3"
        }
      }, this.startupTimeoutMs);
      this.initialized = true;
    }
    return { connected: true, label: this.kind, errors: [] };
  }

  async disconnect(): Promise<void> {
    this.transport?.dispose();
    this.transport = null;
    this.initialized = false;
    this.process?.kill();
    this.process = null;
    this.activeEmit = null;
    await this.eventQueue.catch(() => undefined);
  }

  async listModels() {
    return [];
  }

  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    let text = "";
    let completedText = "";
    const result = await this.runTaskStream(input, (event) => {
      if (event.type === "message_delta") text += event.text ?? "";
      if (event.type === "message_completed" || event.type === "completed") completedText = event.text ?? completedText;
    });
    return { ...result, text: text || completedText || result.text };
  }

  async runTaskStream(input: AgentTaskInput, emit: AgentEventSink): Promise<AgentTaskResult> {
    const emitQueued = (event: AgentEvent): Promise<void> => {
      this.eventQueue = this.eventQueue.then(() => Promise.resolve(emit(event)));
      return this.eventQueue;
    };
    const emitNow = (event: Omit<AgentEvent, "backend" | "createdAt">): Promise<void> => emitQueued({
      ...event,
      backend: this.kind,
      createdAt: Date.now()
    });
    let outputText = "";
    let usage: Record<string, unknown> | undefined;
    const previousStartupTimeoutMs = this.startupTimeoutMs;
    this.startupTimeoutMs = startupTimeoutForTask(input.timeoutMs, this.options.requestTimeoutMs);
    this.eventQueue = Promise.resolve();
    this.activeEmit = async (event) => {
      if (event.type === "message_delta") outputText += event.text ?? "";
      if (event.type === "usage") usage = event.data;
      await emitQueued(event);
    };
    try {
      await emitNow({ type: "connecting" });
      await this.connect();
      await emitNow({ type: "connected" });
      const session = await this.requestWithFallback("newSession", {
        cwd: this.options.command.cwd,
        mcpServers: []
      }, input.timeoutMs);
      const sessionId = stringValue((session as any)?.sessionId ?? (session as any)?.id);
      if (!sessionId) throw new Error("ACP backend did not return a sessionId.");
      this.activeRunId = sessionId;
      input.onRunId?.(sessionId);
      await emitNow({ type: "run_started", runId: sessionId });
      await emitNow({ type: "prompt_sent", runId: sessionId });
      await emitNow({ type: "waiting", runId: sessionId });
      await this.requestWithFallback("prompt", {
        sessionId,
        prompt: buildAcpPromptBlocks(input)
      }, input.timeoutMs);
      await this.eventQueue;
      await emitNow({ type: "completed", runId: sessionId, text: outputText });
      return { text: outputText, runId: sessionId, usage };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.eventQueue.catch(() => undefined);
      await emitNow({ type: "failed", runId: this.activeRunId || undefined, error: message });
      throw error;
    } finally {
      this.startupTimeoutMs = previousStartupTimeoutMs;
      this.activeEmit = null;
      this.activeRunId = "";
    }
  }

  async abort(runId: string): Promise<void> {
    if (this.transport && runId) {
      this.transport.notify(ACP_METHOD_CANDIDATES.cancel[0], { sessionId: runId });
    }
    await this.disconnect();
  }

  private async requestWithFallback(logicalMethod: keyof typeof ACP_METHOD_CANDIDATES, params: unknown, timeoutMs?: number): Promise<unknown> {
    const transport = this.requireTransport();
    const candidates = ACP_METHOD_CANDIDATES[logicalMethod];
    let lastError: Error | null = null;
    for (const method of candidates) {
      try {
        return await transport.request(method, params, timeoutMs);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!isMethodMissingError(lastError)) break;
      }
    }
    throw lastError ?? new Error(`ACP request failed: ${logicalMethod}`);
  }

  private handleSessionUpdate(params: unknown): void {
    const notification = plainObject(params);
    const update = plainObject(notification?.update) ?? notification;
    if (!update) return;
    const sessionId = stringValue(notification?.sessionId);
    if (this.activeRunId && sessionId && sessionId !== this.activeRunId) return;
    const events = normalizeRichStreamEvents([update], { backend: this.kind, runId: this.activeRunId || sessionId });
    for (const event of events) {
      void this.activeEmit?.(event);
    }
  }

  private async handlePermissionRequest(params: unknown): Promise<unknown> {
    const request = plainObject(params);
    const toolCall = plainObject(request?.toolCall);
    await this.activeEmit?.({
      type: "permission_requested",
      backend: this.kind,
      createdAt: Date.now(),
      runId: this.activeRunId || stringValue(request?.sessionId),
      toolName: stringValue(toolCall?.title ?? toolCall?.kind) || "tool",
      data: request ? { ...request } : {}
    });
    return { outcome: { outcome: "cancelled" } };
  }

  private requireTransport(): AcpJsonRpcProcessTransport {
    if (!this.transport) throw new Error("ACP runtime is not connected.");
    return this.transport;
  }
}

class AcpJsonRpcProcessTransport {
  private buffer = "";
  private disposed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void | Promise<void>>>();
  private readonly requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(private readonly process: AcpSubprocessLike, private readonly defaultTimeoutMs: number) {
    process.stdout.setEncoding?.("utf8");
    process.stderr?.setEncoding?.("utf8");
    process.stdout.on("data", (chunk) => this.onData(String(chunk)));
    process.stdout.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    process.on?.("error", (error) => this.rejectAll(error));
    process.on?.("exit", (code) => this.rejectAll(new Error(`ACP process exited with code ${code ?? "unknown"}`)));
  }

  onNotification(method: string, handler: (params: unknown) => void | Promise<void>): void {
    const current = this.notificationHandlers.get(method) ?? new Set();
    current.add(handler);
    this.notificationHandlers.set(method, current);
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params: unknown, timeoutMs = this.defaultTimeoutMs): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("ACP transport is closed."));
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs)
        : null;
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(message);
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error("ACP transport closed."));
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
    if (message.method && message.id !== undefined) {
      void this.handleRequest(message);
      return;
    }
    if (message.method) {
      void this.handleNotification(message);
      return;
    }
    this.handleResponse(message);
  }

  private handleResponse(message: JsonRpcMessage): void {
    const id = Number(message.id);
    if (!Number.isFinite(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new AcpJsonRpcError(pending.method, Number(message.error.code ?? 0), String(message.error.message ?? "ACP request failed"), message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleNotification(message: JsonRpcMessage): Promise<void> {
    const handlers = this.notificationHandlers.get(message.method ?? "");
    if (!handlers) return;
    for (const handler of handlers) await handler(message.params);
  }

  private async handleRequest(message: JsonRpcMessage): Promise<void> {
    const method = message.method ?? "";
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported ACP request: ${method}` } });
      return;
    }
    try {
      const result = await handler(message.params);
      this.write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  private write(message: JsonRpcMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class AcpJsonRpcError extends Error {
  constructor(readonly method: string, readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "AcpJsonRpcError";
  }
}

function buildAcpPromptBlocks(input: AgentTaskInput): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [{ type: "text", text: withResourcePrefix(input.prompt, input.resources?.promptPrefix, input.resources?.warnings) }];
  for (const source of input.sources ?? []) blocks.push(acpBlockFromPart(source));
  return blocks;
}

function acpBlockFromPart(part: AgentPromptPart): Record<string, unknown> {
  if (part.type === "text") return { type: "text", text: part.text };
  return { type: "text", text: `[file] ${part.path}` };
}

function withResourcePrefix(prompt: string, prefix = "", warnings: string[] = []): string {
  return [
    prefix,
    warnings.length ? `资源提示：\n${warnings.map((item) => `- ${item}`).join("\n")}` : "",
    prompt
  ].filter(Boolean).join("\n\n");
}

function defaultAcpProcessFactory(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): AcpSubprocessLike {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function resolveCommandValue(value: string | (() => string)): string {
  return typeof value === "function" ? value() : value;
}

function resolveArgsValue(value: string[] | (() => string[]) | undefined): string[] {
  return typeof value === "function" ? value() : [...(value ?? [])];
}

function isMethodMissingError(error: Error): boolean {
  return error instanceof AcpJsonRpcError && (error.code === -32601 || /method|not found|unsupported/i.test(error.message));
}

function startupTimeoutForTask(taskTimeoutMs: number | undefined, configuredTimeoutMs: number | undefined): number {
  const ceiling = configuredTimeoutMs ?? DEFAULT_ACP_STARTUP_TIMEOUT_MS;
  if (!taskTimeoutMs || !Number.isFinite(taskTimeoutMs)) return Math.min(ceiling, DEFAULT_ACP_STARTUP_TIMEOUT_MS);
  return Math.max(1, Math.min(ceiling, Math.floor(taskTimeoutMs / 4)));
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
