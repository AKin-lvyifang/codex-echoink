import { spawn, type ChildProcess } from "child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { AgentBackend, AgentFileStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentPromptPart, AgentSessionOptions, AgentTaskResult } from "../agent/types";
import { emptyArrayOnMissingPathOrWarn } from "./error-handling";
import { formatOpenCodeError } from "./opencode-errors";
import { nodeFetch } from "./opencode-fetch";
import { flattenOpenCodeAgents, flattenOpenCodeModels, normalizeOpenCodeServerUrl, resolveOpenCodeCommand, toOpenCodePromptPart } from "./opencode-models";
import { buildOpenCodeRunArgs, openCodeRunSessionIdFromLine, parseOpenCodeModelListOutput, parseOpenCodeRunJsonLines } from "./opencode-run";

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

export interface OpenCodeHistoryMessage {
  sessionId: string;
  sessionTitle: string;
  directory: string;
  role: string;
  createdAt: number;
  createdAtLabel: string;
  modelLabel: string;
  text: string;
}

export interface OpenCodeHistorySnapshot {
  serverUrl: string;
  sessionsScanned: number;
  sessionsMatched: number;
  messages: OpenCodeHistoryMessage[];
  truncated: boolean;
}

export interface OpenCodeCliTaskOptions {
  prompt: string;
  parts?: AgentPromptPart[];
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onRunId?: (runId: string) => void;
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
    const cliModels = await this.listCliModels().catch(emptyArrayOnMissingPathOrWarn("list OpenCode CLI models"));
    if (cliModels.length) return cliModels;
    const client = this.requireClient();
    const response = await unwrapOpenCodeResult(client.provider.list({ directory: this.options.vaultPath }), "读取 OpenCode 模型失败");
    return flattenOpenCodeModels(response?.all ?? []);
  }

  async listAgents(): Promise<AgentProfileInfo[]> {
    const client = this.requireClient();
    const response = await unwrapOpenCodeResult(client.app.agents({ directory: this.options.vaultPath }), "读取 OpenCode Agent 失败");
    return flattenOpenCodeAgents(response ?? []);
  }

  async collectHistoryMessages(input: { startMs: number; endMs: number; maxSessions?: number; maxMessages?: number; maxChars?: number }): Promise<OpenCodeHistorySnapshot> {
    const client = this.requireClient();
    const maxSessions = input.maxSessions ?? 100;
    const maxMessages = input.maxMessages ?? 80;
    const maxChars = input.maxChars ?? 60000;
    const pageSize = 50;
    const candidates: any[] = [];
    let sessionsScanned = 0;
    let truncated = false;

    for (let start = 0; start < maxSessions; start += pageSize) {
      const limit = Math.min(pageSize, maxSessions - start);
      const page = await unwrapOpenCodeResult(client.session.list({
        directory: this.options.vaultPath,
        start,
        limit
      }), "读取 OpenCode 会话列表失败");
      const sessions = Array.isArray(page) ? page : [];
      sessionsScanned += sessions.length;
      for (const session of sessions) {
        const rawSession = session as any;
        const createdAt = normalizeOpenCodeTimeMs(rawSession?.time?.created ?? rawSession?.created_at);
        const updatedAt = normalizeOpenCodeTimeMs(rawSession?.time?.updated ?? rawSession?.updated_at ?? createdAt);
        if (updatedAt >= input.startMs && createdAt < input.endMs) candidates.push(session);
      }
      const oldestUpdatedAt = Math.min(...sessions.map((session) => {
        const rawSession = session as any;
        return normalizeOpenCodeTimeMs(rawSession?.time?.updated ?? rawSession?.updated_at);
      }).filter((value) => value > 0));
      if (sessions.length < limit || (Number.isFinite(oldestUpdatedAt) && oldestUpdatedAt < input.startMs)) break;
      if (start + limit >= maxSessions) truncated = true;
    }

    const messages: OpenCodeHistoryMessage[] = [];
    let charBudget = maxChars;
    for (const session of candidates) {
      if (messages.length >= maxMessages || charBudget <= 0) {
        truncated = true;
        break;
      }
      const sessionMessages = await unwrapOpenCodeResult(client.session.messages({
        sessionID: session.id,
        directory: this.options.vaultPath,
        limit: 200
      }), `读取 OpenCode 会话消息失败：${session.title ?? session.id}`);
      const entries = Array.isArray(sessionMessages) ? sessionMessages : [];
      for (const entry of entries) {
        const info = (entry?.info ?? {}) as any;
        const createdAt = normalizeOpenCodeTimeMs(info?.time?.created ?? info?.created_at);
        if (createdAt < input.startMs || createdAt >= input.endMs) continue;
        const text = compactOpenCodeText(extractOpenCodePartsText(entry?.parts ?? []), Math.min(1800, charBudget));
        if (!text) continue;
        messages.push({
          sessionId: String(session.id ?? info.sessionID ?? ""),
          sessionTitle: String(session.title ?? "未命名会话"),
          directory: String((session as any).directory ?? info?.path?.cwd ?? ""),
          role: String(info.role ?? "unknown"),
          createdAt,
          createdAtLabel: formatOpenCodeTimeLabel(createdAt),
          modelLabel: openCodeMessageModelLabel(info, session),
          text
        });
        charBudget -= text.length;
        if (messages.length >= maxMessages || charBudget <= 0) {
          truncated = true;
          break;
        }
      }
    }

    messages.sort((left, right) => left.createdAt - right.createdAt);
    return {
      serverUrl: this.connectionInfo.serverUrl,
      sessionsScanned,
      sessionsMatched: candidates.length,
      messages,
      truncated
    };
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

  async runCliTask(options: OpenCodeCliTaskOptions): Promise<AgentTaskResult> {
    const command = this.connectionInfo.command || resolveOpenCodeCommand(this.options.cliPath);
    const files = (options.parts ?? []).filter((part) => part.type === "file").map((part) => part.path);
    const args = buildOpenCodeRunArgs({
      prompt: options.prompt,
      directory: this.options.vaultPath,
      model: options.model,
      agent: options.agent ?? this.options.agent,
      files
    });
    let lineBuffer = "";
    let emittedRunId = false;
    const output = await runOpenCodeCommand({
      command,
      args,
      cwd: this.options.vaultPath,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      onStdoutChunk: (chunk) => {
        lineBuffer += chunk;
        for (;;) {
          const index = lineBuffer.indexOf("\n");
          if (index < 0) break;
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          const runId = openCodeRunSessionIdFromLine(line);
          if (runId && !emittedRunId) {
            emittedRunId = true;
            options.onRunId?.(runId);
          }
        }
      }
    });
    const parsed = parseOpenCodeRunJsonLines(output);
    if (parsed.sessionId && !emittedRunId) options.onRunId?.(parsed.sessionId);
    if (!parsed.text) throw new Error("OpenCode CLI 未返回内容。");
    return { text: parsed.text, runId: parsed.sessionId, usage: parsed.usage };
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

  private async listCliModels(): Promise<AgentModelInfo[]> {
    const command = this.connectionInfo.command || resolveOpenCodeCommand(this.options.cliPath);
    const output = await runOpenCodeCommand({
      command,
      args: ["models"],
      cwd: this.options.vaultPath,
      timeoutMs: 15000
    });
    return parseOpenCodeModelListOutput(output);
  }
}

async function runOpenCodeCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const abort = () => {
      stopOpenCodeServer(child);
      finish(new Error("Agent 任务已取消。"));
    };
    const timer = input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
        stopOpenCodeServer(child);
        finish(new Error(`OpenCode CLI 执行超时：${input.timeoutMs}ms`));
      }, input.timeoutMs)
      : null;
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => {
      const value = chunk.toString();
      stdout += value;
      input.onStdoutChunk?.(value);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const parsedError = parseOpenCodeRunFailure(stdout);
      finish(new Error(parsedError || `OpenCode CLI 已退出：${code ?? signal ?? "unknown"}${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

function parseOpenCodeRunFailure(output: string): string {
  try {
    parseOpenCodeRunJsonLines(output);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
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

function normalizeOpenCodeTimeMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 100000000000 ? parsed * 1000 : parsed;
}

function formatOpenCodeTimeLabel(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function openCodeMessageModelLabel(info: any, session: any): string {
  const provider = info?.providerID ?? info?.model?.providerID ?? session?.model?.providerID ?? "";
  const model = info?.modelID ?? info?.model?.modelID ?? info?.model?.id ?? session?.model?.id ?? "";
  return [provider, model].filter(Boolean).join("/");
}

function extractOpenCodePartsText(parts: any[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (part?.ignored) continue;
    if (part?.type === "text" && typeof part.text === "string") {
      lines.push(part.text.trim());
    } else if (part?.type === "tool") {
      lines.push(openCodeToolPartSummary(part));
    } else if (part?.type === "patch" && Array.isArray(part.files)) {
      lines.push(`文件改动：${part.files.join("，")}`);
    } else if (part?.type === "file") {
      lines.push(`引用文件：${part.filename || part.url || "未命名文件"}`);
    } else if (part?.type === "agent") {
      lines.push(`切换 Agent：${part.name}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

function openCodeToolPartSummary(part: any): string {
  const tool = part.tool ? `工具 ${part.tool}` : "工具调用";
  const state = part.state ?? {};
  if (state.status === "completed") {
    const title = state.title ? `：${state.title}` : "";
    const output = typeof state.output === "string" && state.output.trim()
      ? `\n${compactOpenCodeText(state.output, 500)}`
      : "";
    return `${tool}${title}${output}`;
  }
  if (state.status === "error") return `${tool} 失败：${state.error ?? "未知错误"}`;
  if (state.status === "running") return `${tool} 运行中`;
  return tool;
}

function compactOpenCodeText(value: string, limit: number): string {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!normalized || normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 20)).trimEnd()}\n...（已截断）`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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
