import { spawn, type ChildProcess } from "child_process";
import * as path from "node:path";
import { createOpencodeClient, type OpencodeClient, type ProviderAuthAuthorization, type ProviderAuthMethod } from "@opencode-ai/sdk/v2";
import type { AgentBackend, AgentFileStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentPromptPart, AgentSessionOptions, AgentTaskResult } from "../agent/types";
import type { PermissionMode } from "../types/app-server";
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
  parseOpenCodeRunJsonLine,
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
  onPromptSubmitted?: () => void;
  onEvent?: (event: unknown) => void;
  thinking?: boolean;
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
    const sdkModel = model ? openCodeSdkModelReference(model) : null;
    const session = await unwrapOpenCodeResult(client.session.create({
      directory: this.options.vaultPath,
      title: options.title,
      agent: options.agent ?? this.options.agent,
      ...(sdkModel ? { model: { id: sdkModel.modelID, providerID: sdkModel.providerID } } : {}),
      permission: openCodePermissionRules(options.permission ?? "workspace-write", options.writableRoots, this.options.vaultPath)
    }), "创建 OpenCode 会话失败");
    return {
      sessionId: session.id,
      title: session.title ?? options.title
    };
  }

  async sendPrompt(options: AgentPromptOptions): Promise<string> {
    const client = this.requireClient();
    const requestedAgent = options.agent ?? this.options.agent;
    const sdkModel = options.model ? openCodeSdkModelReference(options.model) : null;
    const result = await unwrapOpenCodeResult(client.session.prompt({
      sessionID: options.sessionId,
      directory: this.options.vaultPath,
      agent: requestedAgent,
      ...(sdkModel ? { model: sdkModel } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      parts: options.parts.map((part) => toOpenCodePromptPart(part))
    }), "OpenCode 执行任务失败");
    assertOpenCodeAgentSelection(requestedAgent, String(result?.info?.agent ?? ""));
    return openCodePromptText(result?.parts ?? []);
  }

  async sendPromptAsync(options: AgentPromptOptions, signal?: AbortSignal): Promise<void> {
    const client = this.requireClient();
    const sdkModel = options.model ? openCodeSdkModelReference(options.model) : null;
    await unwrapOpenCodeResult(client.session.promptAsync({
      sessionID: options.sessionId,
      directory: this.options.vaultPath,
      agent: options.agent ?? this.options.agent,
      ...(sdkModel ? { model: sdkModel } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      parts: options.parts.map((part) => toOpenCodePromptPart(part))
    }, { signal }), "OpenCode 启动异步任务失败");
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

  async updateSessionPermissions(sessionId: string, permission: PermissionMode, writableRoots: string[] = []): Promise<void> {
    await unwrapOpenCodeResult(this.requireClient().session.update({
      sessionID: sessionId,
      directory: this.options.vaultPath,
      permission: openCodePermissionRules(permission, writableRoots, this.options.vaultPath)
    }), `更新 OpenCode 会话权限失败：${sessionId}`);
  }

  async subscribeEvents(signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    let streamError: unknown;
    const result = await this.requireClient().event.subscribe({
      directory: this.options.vaultPath
    }, {
      signal,
      sseMaxRetryAttempts: 1,
      onSseError: (error) => {
        streamError = error;
      }
    });
    const source = result.stream as AsyncIterable<unknown>;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) yield event;
        if (streamError && !signal.aborted) throw normalizeOpenCodeStreamError(streamError);
      }
    };
  }

  async replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    await unwrapOpenCodeResult(this.requireClient().permission.reply({
      requestID: requestId,
      directory: this.options.vaultPath,
      reply
    }), "回复 OpenCode 权限请求失败");
  }

  async getSessionStatus(sessionId: string): Promise<string | undefined> {
    const statuses = await unwrapOpenCodeResult(this.requireClient().session.status({
      directory: this.options.vaultPath
    }), "读取 OpenCode 会话状态失败");
    const status = (statuses as Record<string, { type?: unknown }> | undefined)?.[sessionId];
    return typeof status?.type === "string" ? status.type : undefined;
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
      serverUrl: this.connectionInfo.serverUrl,
      model: options.model,
      agent: options.agent ?? this.options.agent,
      files,
      thinking: options.thinking
    });
    let lineBuffer = "";
    let emittedRunId = false;
    let eventCallbackError: unknown;
    let promptSubmitted = false;
    const markPromptSubmitted = (): void => {
      if (promptSubmitted) return;
      promptSubmitted = true;
      try {
        options.onPromptSubmitted?.();
      } catch (error) {
        eventCallbackError = error;
      }
    };
    const consumeLine = (line: string): void => {
      const runId = openCodeRunSessionIdFromLine(line);
      if (runId && !emittedRunId) {
        emittedRunId = true;
        options.onRunId?.(runId);
      }
      const event = parseOpenCodeRunJsonLine(line);
      if (!event || !options.onEvent) return;
      try {
        options.onEvent(event);
      } catch (error) {
        eventCallbackError = error;
      }
    };
    const output = await runOpenCodeCommand({
      command: launch.command,
      argsPrefix: launch.argsPrefix,
      args,
      cwd: this.options.vaultPath,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      // runOpenCodeCommand invokes this only after Node emits the successful
      // `spawn` event; asynchronous ENOENT/EACCES never cross this boundary.
      onSpawn: () => markPromptSubmitted(),
      onStdoutChunk: (chunk) => {
        lineBuffer += chunk;
        for (;;) {
          const index = lineBuffer.indexOf("\n");
          if (index < 0) break;
          const line = lineBuffer.slice(0, index);
          lineBuffer = lineBuffer.slice(index + 1);
          consumeLine(line);
        }
      }
    });
    if (lineBuffer.trim()) consumeLine(lineBuffer);
    if (eventCallbackError) throw eventCallbackError;
    const parsed = parseOpenCodeRunJsonLines(output);
    const sessionId = parsed.sessionId || options.nativeSessionId;
    if (sessionId && !emittedRunId) options.onRunId?.(sessionId);
    const recoveredText = !parsed.hasAuthoritativeFinal && !parsed.text && sessionId && knownAssistantIds
      ? await this.recoverLatestAssistantText(sessionId, knownAssistantIds)
      : "";
    const text = parsed.hasAuthoritativeFinal ? parsed.text : parsed.text || recoveredText;
    if (!parsed.hasAuthoritativeFinal && !text) throw new Error("OpenCode CLI 未返回内容。");
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

  async readSessionMessages(sessionId: string): Promise<unknown[]> {
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

function openCodeSdkModelReference(model: { providerId: string; modelId: string }): { providerID: string; modelID: string } {
  const providerID = model.providerId.trim();
  const configuredModelID = model.modelId.trim();
  const qualifiedPrefix = providerID ? `${providerID}/` : "";
  return {
    providerID,
    // `opencode models` returns provider-qualified IDs, while the SDK sends
    // provider and model as separate fields. Passing both unchanged makes the
    // server resolve e.g. `opencode/opencode/big-pickle`.
    modelID: qualifiedPrefix && configuredModelID.startsWith(qualifiedPrefix)
      ? configuredModelID.slice(qualifiedPrefix.length)
      : configuredModelID
  };
}

export function openCodePermissionRules(
  mode: PermissionMode,
  writableRoots: string[] = [],
  vaultPath = ""
): Array<{ permission: string; pattern: string; action: "allow" | "deny" }> {
  if (mode === "danger-full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      // EchoInk does not currently expose OpenCode's interactive question API.
      { permission: "question", pattern: "*", action: "deny" }
    ];
  }
  if (mode === "workspace-write") {
    const resolvedVaultPath = vaultPath.trim() ? path.resolve(vaultPath) : "";
    const resolvedWritableRoots = Array.from(new Set(writableRoots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root))));
    const scopedWorkspaceWrite = Boolean(
      resolvedVaultPath
      && resolvedWritableRoots.length
      && !resolvedWritableRoots.some((root) => path.resolve(root) === resolvedVaultPath)
    );
    const internalWritableRoots = resolvedWritableRoots
      .filter((root) => resolvedVaultPath && isPathInside(root, resolvedVaultPath));
    const externalWritableRoots = resolvedWritableRoots
      .filter((root) => !resolvedVaultPath || !isPathInside(root, resolvedVaultPath));
    if (scopedWorkspaceWrite) {
      const scopedEditRules = [
        ...internalWritableRoots.flatMap((root) => {
          const relative = toOpenCodePath(path.relative(resolvedVaultPath, root));
          return openCodePathRules("edit", relative, "allow");
        }),
        ...externalWritableRoots.flatMap((root) =>
          openCodePathRules("edit", toOpenCodePath(root), "allow")
        )
      ];
      return [
        // Maintenance Shadow runs fail closed. OpenCode evaluates matching rules
        // from top to bottom and the last match wins, so exact edit roots can
        // safely override this catch-all without exposing native tools, MCP,
        // shell, skills, or subagents.
        { permission: "*", pattern: "*", action: "deny" },
        ...["read", "glob", "grep", "list", "todowrite"].map((permission) => ({
          permission,
          pattern: "*",
          action: "allow" as const
        })),
        ...scopedEditRules,
        // The tracker is plugin-owned transaction state. Even though it lives
        // below outputs/, the Agent must never update it directly.
        ...openCodePathRules("edit", "outputs/.ingest-tracker.md", "deny"),
        { permission: "external_directory", pattern: "*", action: "deny" },
        ...externalWritableRoots.flatMap((root) =>
          openCodePathRules("external_directory", toOpenCodePath(root), "allow")
        ),
        { permission: "question", pattern: "*", action: "deny" }
      ];
    }
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
      ...externalWritableRoots.flatMap((root) => [
        { permission: "external_directory", pattern: toOpenCodePath(root), action: "allow" as const },
        { permission: "external_directory", pattern: `${toOpenCodePath(root)}/**`, action: "allow" as const }
      ]),
      { permission: "question", pattern: "*", action: "deny" }
    ];
  }
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...["read", "glob", "grep", "list", "webfetch", "websearch", "codesearch", "todowrite"].map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const
    }))
  ];
}

function openCodePathRules(
  permission: string,
  normalizedPath: string,
  action: "allow" | "deny"
): Array<{ permission: string; pattern: string; action: "allow" | "deny" }> {
  const clean = normalizedPath.replace(/\/+$/, "");
  if (!clean) return [];
  return [
    { permission, pattern: clean, action },
    { permission, pattern: `${clean}/**`, action }
  ];
}

function toOpenCodePath(value: string): string {
  return value.split(path.sep).join("/");
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalizeOpenCodeStreamError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`OpenCode SSE 连接失败：${String(error)}`);
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
