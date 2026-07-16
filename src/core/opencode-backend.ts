import { spawn, type ChildProcess } from "child_process";
import { createOpencodeClient, type OpencodeClient, type ProviderAuthAuthorization, type ProviderAuthMethod } from "@opencode-ai/sdk/v2";
import type { AgentBackend, AgentFileStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentPromptPart, AgentSessionOptions, AgentTaskResult } from "../agent/types";
import { emptyArrayOnMissingPathOrWarn } from "./error-handling";
import { formatOpenCodeError, isOpenCodeNotFoundError } from "./opencode-errors";
import { nodeFetch } from "./opencode-fetch";
import { collectOpenCodeHistoryMessages, normalizeOpenCodeTimeMs, type OpenCodeHistorySnapshot } from "./opencode-history-loader";
import { assertOpenCodeAgentSelection } from "./opencode-agent-selection";
import { flattenOpenCodeAgents, flattenOpenCodeModels, normalizeOpenCodeServerUrl, resolveOpenCodeLaunch, toOpenCodePromptPart, type OpenCodeCommandLaunch } from "./opencode-models";
import { runOpenCodeCommand, stopOpenCodeProcess } from "./opencode-process";
import { isOpenCodeServerHealthy } from "./opencode-server-health";
import {
  buildOpenCodeRunArgs,
  latestOpenCodeAssistantText,
  openCodeAssistantMessageIds,
  openCodeRunSessionIdFromLine,
  parseOpenCodeModelListOutput,
  parseOpenCodeRunJsonLines
} from "./opencode-run";

export type { OpenCodeHistoryMessage, OpenCodeHistorySnapshot } from "./opencode-history-loader";

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
  requireOwnedServer?: boolean;
  startTimeoutMs?: number;
}

export interface OpenCodeConnectionInfo {
  connected: boolean;
  serverUrl: string;
  command: string;
  version: string;
  errors: string[];
}

export interface OpenCodeCliTaskOptions {
  prompt: string;
  nativeSessionId?: string;
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

const OPENCODE_START_TIMEOUT_MS = 30_000;

export class OpenCodeBackend implements AgentBackend {
  readonly kind = "opencode" as const;
  private client: OpencodeClient | null = null;
  private startedServer: StartedOpenCodeServer | null = null;
  private commandLaunch: OpenCodeCommandLaunch | null = null;
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
    if (this.options.requireOwnedServer && this.options.serverUrl.trim()) {
      throw new Error("OpenCode 授权只允许使用 EchoInk 本次启动的本地服务");
    }
    let serverUrl = normalizeOpenCodeServerUrl(this.options.serverUrl, this.options.hostname, this.options.port);
    let command = "";
    if (!this.options.serverUrl.trim()) {
      if (this.options.autoStart) {
        const canReuse = !this.options.requireOwnedServer && await isOpenCodeServerHealthy(serverUrl);
        if (!canReuse) {
          const launch = resolveOpenCodeLaunch(this.options.cliPath);
          this.commandLaunch = launch;
          command = launch.resolvedPath;
          this.startedServer = await startOpenCodeServer({
            launch,
            hostname: this.options.hostname,
            port: this.options.port,
            cwd: this.options.vaultPath,
            requireLoopback: Boolean(this.options.requireOwnedServer),
            timeoutMs: this.options.startTimeoutMs
          });
          serverUrl = this.startedServer.url;
        }
      } else {
        const launch = resolveOpenCodeLaunch(this.options.cliPath);
        this.commandLaunch = launch;
        command = launch.resolvedPath;
      }
    }

    if (this.options.requireOwnedServer) this.assertOwnedAuthorizationServer();

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
    this.commandLaunch = null;
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

  async listProviderAuthMethods(signal?: AbortSignal): Promise<Record<string, ProviderAuthMethod[]>> {
    if (this.options.requireOwnedServer) this.assertOwnedAuthorizationServer();
    const response = await unwrapOpenCodeResult(
      this.requireClient().provider.auth({ directory: this.options.vaultPath }, { signal }),
      "读取 OpenCode Provider 授权方式失败"
    );
    return response ?? {};
  }

  async listConnectedProviders(signal?: AbortSignal): Promise<string[]> {
    if (this.options.requireOwnedServer) this.assertOwnedAuthorizationServer();
    const response = await unwrapOpenCodeResult(
      this.requireClient().provider.list({ directory: this.options.vaultPath }, { signal }),
      "读取 OpenCode Provider 状态失败"
    );
    return Array.isArray(response?.connected) ? response.connected : [];
  }

  async beginProviderOAuth(providerId: string, method: number, inputs: Record<string, string> = {}, signal?: AbortSignal): Promise<ProviderAuthAuthorization> {
    this.assertOwnedAuthorizationServer();
    return await unwrapOpenCodeResult(
      this.requireClient().provider.oauth.authorize({
        providerID: providerId,
        directory: this.options.vaultPath,
        method,
        inputs
      }, { signal }),
      "启动 OpenCode OAuth 失败"
    );
  }

  async completeProviderOAuth(providerId: string, method: number, code?: string, signal?: AbortSignal): Promise<boolean> {
    this.assertOwnedAuthorizationServer();
    return await unwrapOpenCodeResult(
      this.requireClient().provider.oauth.callback({
        providerID: providerId,
        directory: this.options.vaultPath,
        method,
        ...(code?.trim() ? { code: code.trim() } : {})
      }, { signal }),
      "完成 OpenCode OAuth 失败"
    );
  }

  async setProviderApiKey(providerId: string, key: string, metadata?: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
    this.assertOwnedAuthorizationServer();
    const secret = key.trim();
    if (!secret) throw new Error("OpenCode API Key 不能为空");
    return await unwrapOpenCodeResult(
      this.requireClient().auth.set({
        providerID: providerId,
        auth: { type: "api", key: secret, ...(metadata ? { metadata } : {}) }
      }, { signal }),
      "保存 OpenCode Provider 凭据失败"
    );
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

    const loaded = await collectOpenCodeHistoryMessages({
      sessions: candidates,
      startMs: input.startMs,
      endMs: input.endMs,
      maxMessages,
      maxChars,
      fetchMessages: async (session) => {
        const sessionMessages = await unwrapOpenCodeResult(client.session.messages({
          sessionID: String(session.id ?? ""),
          directory: this.options.vaultPath,
          limit: 200
        }), `读取 OpenCode 会话消息失败：${String(session.title ?? session.id ?? "")}`);
        return Array.isArray(sessionMessages) ? sessionMessages : [];
      }
    });

    return {
      serverUrl: this.connectionInfo.serverUrl,
      sessionsScanned,
      sessionsMatched: candidates.length,
      messages: loaded.messages,
      truncated: truncated || loaded.truncated
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
    const requestedAgent = options.agent ?? this.options.agent;
    const result = await unwrapOpenCodeResult(client.session.prompt({
      sessionID: options.sessionId,
      directory: this.options.vaultPath,
      agent: requestedAgent,
      ...(options.model ? { model: { providerID: options.model.providerId, modelID: options.model.modelId } } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      parts: options.parts.map((part) => toOpenCodePromptPart(part))
    }), "OpenCode 执行任务失败");
    assertOpenCodeAgentSelection(requestedAgent, String(result?.info?.agent ?? ""));
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

  async hasSession(sessionId: string): Promise<boolean> {
    try {
      const session = await unwrapOpenCodeResult(this.requireClient().session.get({
        sessionID: sessionId,
        directory: this.options.vaultPath
      }), `读取 OpenCode 会话失败：${sessionId}`);
      return Boolean(session?.id);
    } catch {
      return false;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.requireClient().session.delete({
      sessionID: sessionId,
      directory: this.options.vaultPath
    });
    if (result.error) {
      if (isOpenCodeNotFoundError(result.error)) return false;
      throw new Error(`删除 OpenCode 会话失败：${formatOpenCodeError(result.error)}`);
    }
    return result.data === true;
  }

  async runCliTask(options: OpenCodeCliTaskOptions): Promise<AgentTaskResult> {
    const launch = this.commandLaunch ?? resolveOpenCodeLaunch(this.options.cliPath);
    const knownAssistantIds = options.nativeSessionId
      ? await this.readSessionMessages(options.nativeSessionId).then(openCodeAssistantMessageIds).catch(() => null)
      : new Set<string>();
    const files = (options.parts ?? []).filter((part) => part.type === "file").map((part) => part.path);
    const args = buildOpenCodeRunArgs({
      prompt: options.prompt,
      directory: this.options.vaultPath,
      sessionId: options.nativeSessionId,
      model: options.model,
      agent: options.agent ?? this.options.agent,
      files
    });
    let lineBuffer = "";
    let emittedRunId = false;
    const output = await runOpenCodeCommand({
      command: launch.command,
      argsPrefix: launch.argsPrefix,
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
    const sessionId = parsed.sessionId || options.nativeSessionId;
    if (sessionId && !emittedRunId) options.onRunId?.(sessionId);
    const recoveredText = !parsed.text && sessionId && knownAssistantIds
      ? await this.recoverLatestAssistantText(sessionId, knownAssistantIds)
      : "";
    const text = parsed.text || recoveredText;
    if (!text) throw new Error("OpenCode CLI 未返回内容。");
    return { text, runId: sessionId, usage: parsed.usage };
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

  private assertOwnedAuthorizationServer(): void {
    const server = this.startedServer;
    if (!this.options.requireOwnedServer || !server || server.process.exitCode !== null || server.process.signalCode !== null || server.process.killed) {
      throw new Error("OpenCode 授权服务不属于当前 EchoInk 进程，已拒绝发送凭据");
    }
  }

  private async readSessionMessages(sessionId: string): Promise<unknown[]> {
    const messages = await unwrapOpenCodeResult(this.requireClient().session.messages({
      sessionID: sessionId,
      directory: this.options.vaultPath,
      limit: 200
    }), `读取 OpenCode 会话消息失败：${sessionId}`);
    return Array.isArray(messages) ? messages : [];
  }

  private async recoverLatestAssistantText(sessionId: string, knownAssistantIds: ReadonlySet<string>): Promise<string> {
    for (const delayMs of [0, 100, 300]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const text = latestOpenCodeAssistantText(await this.readSessionMessages(sessionId), knownAssistantIds);
      if (text) return text;
    }
    return "";
  }

  private async listCliModels(): Promise<AgentModelInfo[]> {
    const launch = this.commandLaunch ?? resolveOpenCodeLaunch(this.options.cliPath);
    const output = await runOpenCodeCommand({
      command: launch.command,
      argsPrefix: launch.argsPrefix,
      args: ["models"],
      cwd: this.options.vaultPath,
      timeoutMs: 15000
    });
    return parseOpenCodeModelListOutput(output);
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

function defaultOpenCodeModel(options: OpenCodeBackendOptions): { providerId: string; modelId: string } | null {
  if (!options.providerId || !options.modelId) return null;
  return { providerId: options.providerId, modelId: options.modelId };
}

async function startOpenCodeServer(input: { launch: OpenCodeCommandLaunch; hostname: string; port: number; cwd: string; requireLoopback: boolean; timeoutMs?: number }): Promise<StartedOpenCodeServer> {
  const port = Number.isInteger(input.port) && input.port >= 0 ? input.port : 4096;
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.max(1_000, input.timeoutMs)
    : OPENCODE_START_TIMEOUT_MS;
  const args = ["serve", `--hostname=${input.hostname || "127.0.0.1"}`, `--port=${port}`];
  const proc = spawn(input.launch.command, [...input.launch.argsPrefix, ...args], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false
  });
  const fallbackUrl = normalizeOpenCodeServerUrl("", input.hostname, input.port);
  let output = "";
  const started = new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onStdout = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening.*\s(on\s+)?(https?:\/\/[^\s]+)/);
      if (match?.[2]) finish(null, match[2].replace(/\/$/, ""));
    };
    const onStderr = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(
      `OpenCode server 已退出：${code ?? "unknown"}${output.trim() ? `\n${output.trim()}` : ""}`
    ));
    const timer = setTimeout(() => finish(new Error(
      `OpenCode server 启动超时：${output.trim() || fallbackUrl}`
    )), timeoutMs);
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
  try {
    const url = normalizedStartedOpenCodeUrl(await started, input.requireLoopback);
    return { url, command: input.launch.resolvedPath, process: proc };
  } catch (error) {
    stopOpenCodeServer(proc);
    throw error;
  }
}

function normalizedStartedOpenCodeUrl(value: string, requireLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenCode server 返回了无效监听地址");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    && hostname.split(".").every((part) => Number(part) <= 255);
  if (requireLoopback && ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback || Number(url.port) <= 0)) {
    throw new Error("OpenCode 授权服务没有返回安全的本机监听地址");
  }
  return value.replace(/\/$/, "");
}

function stopOpenCodeServer(proc: ChildProcess): void {
  stopOpenCodeProcess(proc);
}
