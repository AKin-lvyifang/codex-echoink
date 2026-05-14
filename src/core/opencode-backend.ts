import { spawn, type ChildProcess } from "child_process";
import * as http from "node:http";
import * as https from "node:https";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentBackend, AgentFileStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentSessionOptions } from "../agent/types";
import { flattenOpenCodeAgents, flattenOpenCodeModels, normalizeOpenCodeServerUrl, resolveOpenCodeCommand, toOpenCodePromptPart } from "./opencode-models";

export interface OpenCodeBackendOptions {
  cliPath: string;
  serverUrl: string;
  autoStart: boolean;
  hostname: string;
  port: number;
  vaultPath: string;
  providerId: string;
  modelId: string;
  agent: string;
}

export interface OpenCodeConnectionInfo {
  connected: boolean;
  serverUrl: string;
  command: string;
  version: string;
  errors: string[];
}

interface StartedOpenCodeServer {
  url: string;
  command: string;
  process: ChildProcess;
}

const OPENCODE_START_TIMEOUT_MS = 8000;

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  private client: OpencodeClient | null = null;
  private startedServer: StartedOpenCodeServer | null = null;
  private connectionInfo: OpenCodeConnectionInfo = {
    connected: false,
    serverUrl: "",
    command: "",
    version: "",
    errors: []
  };

  constructor(private readonly options: OpenCodeBackendOptions) {}

  async connect(): Promise<void> {
    await this.disconnect();
    const errors: string[] = [];
    let serverUrl = normalizeOpenCodeServerUrl(this.options.serverUrl, this.options.hostname, this.options.port);
    let command = "";
    if (!this.options.serverUrl.trim()) {
      command = resolveOpenCodeCommand(this.options.cliPath);
      if (this.options.autoStart) {
        this.startedServer = await startOpenCodeServer({
          command,
          hostname: this.options.hostname,
          port: this.options.port,
          cwd: this.options.vaultPath
        });
        serverUrl = this.startedServer.url;
      }
    }

    this.client = createOpencodeClient({ baseUrl: serverUrl, directory: this.options.vaultPath, fetch: nodeFetch });
    const health = await unwrapOpenCodeResult(this.client.global.health(), "OpenCode 连接失败");
    this.connectionInfo = {
      connected: true,
      serverUrl,
      command,
      version: health?.version ?? "",
      errors
    };
  }

  async disconnect(): Promise<void> {
    if (this.startedServer) {
      stopOpenCodeServer(this.startedServer.process);
      this.startedServer = null;
    }
    this.client = null;
    this.connectionInfo = { ...this.connectionInfo, connected: false };
  }

  getConnectionInfo(): OpenCodeConnectionInfo {
    return this.connectionInfo;
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const client = this.requireClient();
    const response = await unwrapOpenCodeResult(client.provider.list({ directory: this.options.vaultPath }), "读取 OpenCode 模型失败");
    return flattenOpenCodeModels(response?.all ?? []);
  }

  async listAgents(): Promise<AgentProfileInfo[]> {
    const client = this.requireClient();
    const response = await unwrapOpenCodeResult(client.app.agents({ directory: this.options.vaultPath }), "读取 OpenCode Agent 失败");
    return flattenOpenCodeAgents(response ?? []);
  }

  async startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }> {
    const client = this.requireClient();
    const model = options.model ?? defaultOpenCodeModel(this.options);
    const session = await unwrapOpenCodeResult(client.session.create({
      directory: this.options.vaultPath,
      title: options.title,
      agent: options.agent ?? this.options.agent,
      ...(model ? { model: { id: model.modelId, providerID: model.providerId } } : {})
    }), "创建 OpenCode 会话失败");
    return {
      sessionId: session.id,
      title: session.title ?? options.title
    };
  }

  async sendPrompt(options: AgentPromptOptions): Promise<string> {
    const client = this.requireClient();
    const result = await unwrapOpenCodeResult(client.session.prompt({
      sessionID: options.sessionId,
      directory: this.options.vaultPath,
      agent: options.agent ?? this.options.agent,
      ...(options.model ? { model: { providerID: options.model.providerId, modelID: options.model.modelId } } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      parts: options.parts.map((part) => toOpenCodePromptPart(part))
    }), "OpenCode 执行任务失败");
    return openCodePromptText(result?.parts ?? []);
  }

  async sendPromptAsync(options: AgentPromptOptions): Promise<void> {
    const client = this.requireClient();
    await unwrapOpenCodeResult(client.session.promptAsync({
      sessionID: options.sessionId,
      directory: this.options.vaultPath,
      agent: options.agent ?? this.options.agent,
      ...(options.model ? { model: { providerID: options.model.providerId, modelID: options.model.modelId } } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      parts: options.parts.map((part) => toOpenCodePromptPart(part))
    }), "OpenCode 启动异步任务失败");
  }

  async abort(sessionId: string): Promise<void> {
    await unwrapOpenCodeResult(this.requireClient().session.abort({
      sessionID: sessionId,
      directory: this.options.vaultPath
    }), "取消 OpenCode 会话失败");
  }

  async fileStatus(): Promise<AgentFileStatus[]> {
    const response = await unwrapOpenCodeResult(this.requireClient().file.status({ directory: this.options.vaultPath }), "读取 OpenCode 文件状态失败");
    return (response ?? []).map((file: any) => ({
      path: String(file.path ?? ""),
      status: String(file.status ?? ""),
      added: typeof file.added === "number" ? file.added : undefined,
      removed: typeof file.removed === "number" ? file.removed : undefined
    }));
  }

  private requireClient(): OpencodeClient {
    if (!this.client) throw new Error("OpenCode 未连接");
    return this.client;
  }
}

function openCodePromptText(parts: any[]): string {
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

async function unwrapOpenCodeResult<T>(promise: Promise<{ data: T; error: undefined } | { data: undefined; error: any }>, fallback: string): Promise<T> {
  const result = await promise;
  if (result.error) throw new Error(`${fallback}：${formatOpenCodeError(result.error)}`);
  return result.data as T;
}

function formatOpenCodeError(error: any): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.data?.message === "string") return error.data.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function nodeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const transport = url.protocol === "https:" ? https : http;
  const body = await requestBodyToBuffer(init.body);
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(url, {
      method: init.method ?? "GET",
      headers: headersToNode(init.headers),
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

async function requestBodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (!body) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error("OpenCode 请求体格式暂不支持");
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

function defaultOpenCodeModel(options: OpenCodeBackendOptions): { providerId: string; modelId: string } | null {
  if (!options.providerId || !options.modelId) return null;
  return { providerId: options.providerId, modelId: options.modelId };
}

async function startOpenCodeServer(input: { command: string; hostname: string; port: number; cwd: string }): Promise<StartedOpenCodeServer> {
  const args = ["serve", `--hostname=${input.hostname || "127.0.0.1"}`, `--port=${input.port || 4096}`];
  const proc = spawn(input.command, args, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  const fallbackUrl = normalizeOpenCodeServerUrl("", input.hostname, input.port);
  let output = "";
  const started = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`OpenCode server 启动超时：${output.trim() || fallbackUrl}`));
    }, OPENCODE_START_TIMEOUT_MS);
    const finish = (value: string) => {
      clearTimeout(timer);
      resolve(value);
    };
    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening.*\s(on\s+)?(https?:\/\/[^\s]+)/);
      if (match?.[2]) finish(match[2].replace(/\/$/, ""));
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode server 已退出：${code ?? "unknown"}${output.trim() ? `\n${output.trim()}` : ""}`));
    });
  });
  try {
    const url = await started;
    return { url, command: input.command, process: proc };
  } catch (error) {
    stopOpenCodeServer(proc);
    throw error;
  }
}

function stopOpenCodeServer(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (typeof proc.pid === "number") {
    try {
      process.kill(-proc.pid, "SIGTERM");
      globalThis.setTimeout(() => {
        try {
          process.kill(-proc.pid!, "SIGKILL");
        } catch {
          // Already stopped.
        }
      }, 1500);
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  proc.kill("SIGTERM");
}
