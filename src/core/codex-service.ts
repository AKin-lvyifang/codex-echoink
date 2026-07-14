import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { Notice } from "obsidian";
import type {
  CodexModel,
  CodexNotification,
  CodexPluginInfo,
  RateLimitSnapshot,
  CodexServerRequest,
  CodexSkill,
  CodexStatusSnapshot,
  McpServerStatus,
  PermissionMode,
  ReasoningEffort,
  ServiceTierChoice,
  UiMode,
  UserInput,
  WorkspaceResourceSnapshot
} from "../types/app-server";
import { buildCollaborationMode, buildSandboxPolicy, normalizeServiceTier } from "./mapping";
import { CodexRpcClient } from "./codex-rpc";
import { normalizeRateLimitResponse } from "./rate-limits";
import { mergeMcpServers } from "./workspace-resources";
import { getApiProviderModels, hasResourceOverrides, resourceEnabled, type ApiProviderConfig, type ProviderMode, type WorkspaceResourceToggles } from "../settings/settings";
import type { AgentBackend, AgentConnectionStatus, AgentInputModality, AgentModelInfo, AgentPromptOptions, AgentPromptPart, AgentSessionOptions } from "../agent/types";
import { expandHome } from "./path-utils";

export interface CodexServiceOptions {
  cliPath: string;
  proxyEnabled: boolean;
  proxyUrl: string;
  providerMode: ProviderMode;
  activeApiProvider: ApiProviderConfig | null;
  vaultPath: string;
  onNotification: (notification: CodexNotification) => void;
  onServerRequest: (request: CodexServerRequest) => Promise<unknown>;
  processRunner?: CodexProcessRunner;
}

export interface CodexLaunchConfig {
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type CodexProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>;

type CodexAgentStatusSnapshot = CodexStatusSnapshot & AgentConnectionStatus;
type UnknownRecord = Record<string, unknown>;
type CodexRpcListResponse = { data?: unknown };

interface CodexInitResult {
  codexHome?: string;
  platformOs?: string;
}

interface CodexAccountReadResponse {
  account?: {
    type?: string;
    email?: string;
  };
  requiresOpenaiAuth?: boolean;
}

type CodexRuntimeResourceConfig = UnknownRecord & { enabled?: boolean };

interface CodexRuntimeConfig {
  mcp_servers?: Record<string, CodexRuntimeResourceConfig>;
  plugins?: Record<string, CodexRuntimeResourceConfig>;
}

export interface CodexCommandResolveOptions {
  home?: string;
  envPath?: string;
  platform?: NodeJS.Platform | string;
  appData?: string;
  programData?: string;
  exists?: (candidate: string) => boolean;
}

export interface TurnOptions {
  cwd?: string;
  model: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  reasoning: ReasoningEffort;
  serviceTier: ServiceTierChoice;
  permission: PermissionMode;
  mode: UiMode;
  mcpEnabled: boolean;
  persistExtendedHistory?: boolean;
  requestTimeoutMs?: number;
  writableRoots?: string[];
  workspaceResources?: WorkspaceResourceToggles;
}

const NOTIFICATION_METHODS = [
  "thread/started",
  "thread/status/changed",
  "thread/compacted",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "serverRequest/resolved",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "error"
];

const SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request"
];

export class CodexService implements AgentBackend {
  readonly kind = "codex-cli" as const;
  private client: CodexRpcClient | null = null;
  private initResult: CodexInitResult | null = null;
  private cachedSkills: CodexSkill[] = [];
  private cachedRuntimeConfig: CodexRuntimeConfig | null = null;

  constructor(private readonly options: CodexServiceOptions) {}

  async connect(force = false, options: { refreshLogin?: boolean } = {}): Promise<CodexAgentStatusSnapshot> {
    if (this.client && !force && this.client.isAlive()) return this.refreshStatus({ refreshToken: options.refreshLogin === true });
    await this.disconnect();

    const command = resolveCodexCommand(this.options.cliPath);
    const launch = buildCodexLaunchConfig({
      proxyEnabled: this.options.proxyEnabled,
      proxyUrl: this.options.proxyUrl,
      providerMode: this.options.providerMode,
      activeApiProvider: this.options.activeApiProvider
    });
    this.client = new CodexRpcClient({
      command,
      args: launch.args,
      cwd: this.options.vaultPath,
      env: launch.env
    });
    this.client.start();

    for (const method of NOTIFICATION_METHODS) {
      this.client.onNotification(method, (params) => this.options.onNotification({ method, params }));
    }
    for (const method of SERVER_REQUEST_METHODS) {
      this.client.onServerRequest(method, (request) => this.options.onServerRequest(request));
    }

    this.initResult = normalizeInitResult(await this.client.initialize());
    return this.refreshStatus({ refreshToken: options.refreshLogin === true });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await client.dispose();
  }

  isConnected(): boolean {
    return Boolean(this.client?.isAlive());
  }

  async listModels(): Promise<AgentModelInfo[]> {
    const status = this.isConnected() ? await this.refreshStatus() : await this.connect();
    return status.models.map(codexModelToAgentModel);
  }

  async startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }> {
    const session = await this.startThread(turnOptionsFromAgentSession(options, this.options.vaultPath));
    return { sessionId: session.threadId, title: session.title || options.title };
  }

  async sendPrompt(options: AgentPromptOptions): Promise<string> {
    throw new Error("Codex 输出通过通知流返回；请使用 sendPromptAsync 并在调用方汇总 turn 通知。");
  }

  async sendPromptAsync(options: AgentPromptOptions): Promise<void> {
    await this.startTurn(options.sessionId, agentPromptPartsToCodexInput(options.parts, options.system), turnOptionsFromAgentPrompt(options, this.options.vaultPath));
  }

  async abort(runId: string): Promise<void> {
    const { threadId, turnId } = parseCodexRunId(runId);
    await this.interruptTurn(threadId, turnId);
  }

  async refreshStatus(options: { refreshToken?: boolean } = {}): Promise<CodexAgentStatusSnapshot> {
    const errors: string[] = [];
    if (!this.client) {
      return {
        connected: false,
        label: "Codex",
        accountLabel: "未连接",
        loggedIn: false,
        models: [],
        skills: [],
        mcpServers: [],
        rateLimits: null,
        rateLimitsByLimitId: null,
        errors: ["Codex app-server 未连接"]
      };
    }

    const [account, models, skills] = await Promise.all([
      this.safeRequest<CodexAccountReadResponse>("account/read", { refreshToken: options.refreshToken === true }, options.refreshToken ? 15000 : 3000, errors),
      this.safeRequest<CodexRpcListResponse>("model/list", { cursor: null }, 3000, errors),
      Promise.resolve({ data: this.cachedSkills } satisfies CodexRpcListResponse)
    ]);

    return {
      connected: true,
      label: "Codex",
      codexHome: this.initResult?.codexHome,
      platform: this.initResult?.platformOs,
      accountLabel: formatAccountLabel(account),
      loggedIn: Boolean(account?.account),
      configModel: null,
      profile: null,
      models: normalizeModels(models?.data),
      skills: this.cachedSkills.length ? this.cachedSkills : normalizeSkills(skills?.data),
      mcpServers: [],
      rateLimits: null,
      rateLimitsByLimitId: null,
      errors
    };
  }

  async refreshRateLimits(): Promise<{
    rateLimits: RateLimitSnapshot | null;
    rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
    error: string | null;
  }> {
    try {
      const response = await this.requireClient().request("account/rateLimits/read", undefined, 60000);
      return { ...normalizeRateLimitResponse(response), error: null };
    } catch (error) {
      return {
        rateLimits: null,
        rateLimitsByLimitId: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async refreshSkills(): Promise<CodexSkill[]> {
    const response = await this.requireClient().request<CodexRpcListResponse>("skills/list", { cwds: [this.options.vaultPath] }, 12000);
    this.cachedSkills = normalizeSkills(response?.data);
    return this.cachedSkills;
  }

  async refreshMcpStatus(): Promise<{ servers: McpServerStatus[]; error: string | null }> {
    const config = await this.optionalRequest("config/read", {}, 12000);
    const runtimeConfig = normalizeRuntimeConfig(config.data);
    if (config.data) this.cachedRuntimeConfig = runtimeConfig;
    const configuredServers = normalizeMcpConfig(runtimeConfig.mcp_servers);
    const status = await this.optionalRequest<CodexRpcListResponse>("mcpServerStatus/list", { cursor: null, limit: 100 }, configuredServers.length ? 8000 : 45000);
    const servers = mergeMcpServers(configuredServers, normalizeMcp(status.data?.data));
    return { servers, error: status.error && !servers.length ? status.error : null };
  }

  async refreshPluginResources(): Promise<{ plugins: CodexPluginInfo[]; error: string | null }> {
    const response = await this.optionalRequest("plugin/list", { cursor: null }, 12000);
    return { plugins: normalizePlugins(response.data), error: response.error };
  }

  async refreshSkillResources(): Promise<{ skills: CodexSkill[]; error: string | null }> {
    const response = await this.optionalRequest<CodexRpcListResponse>("skills/list", { cwds: [this.options.vaultPath] }, 12000);
    const skills = normalizeSkills(response.data?.data);
    if (skills.length) this.cachedSkills = skills;
    return { skills, error: response.error };
  }

  async refreshWorkspaceResources(): Promise<WorkspaceResourceSnapshot> {
    const [plugins, skills, mcp, config] = await Promise.all([
      this.optionalRequest("plugin/list", { cursor: null }, 12000),
      this.optionalRequest<CodexRpcListResponse>("skills/list", { cwds: [this.options.vaultPath] }, 12000),
      this.optionalRequest<CodexRpcListResponse>("mcpServerStatus/list", { cursor: null, limit: 100 }, 8000),
      this.optionalRequest("config/read", {}, 12000)
    ]);
    const runtimeConfig = normalizeRuntimeConfig(config.data);
    if (config.data) this.cachedRuntimeConfig = runtimeConfig;
    const normalizedSkills = normalizeSkills(skills.data?.data);
    if (normalizedSkills.length) this.cachedSkills = normalizedSkills;
    const mcpServers = mergeMcpServers(normalizeMcpConfig(runtimeConfig.mcp_servers), normalizeMcp(mcp.data?.data));
    return {
      plugins: normalizePlugins(plugins.data),
      skills: normalizedSkills,
      mcpServers,
      errors: {
        ...(plugins.error ? { plugins: plugins.error } : {}),
        ...(skills.error ? { skills: skills.error } : {}),
        ...(mcp.error && !mcpServers.length ? { mcp: mcp.error } : {}),
        ...(config.error ? { config: config.error } : {})
      }
    };
  }

  async startThread(options: TurnOptions): Promise<{ threadId: string; title: string }> {
    const client = this.requireClient();
    const scopedConfig = await this.buildThreadConfig(options);
    const cwd = this.resolveTurnCwd(options);
    const sandboxPolicy = buildSandboxPolicy(options.permission, cwd, options.writableRoots);
    const result = await client.request<{ thread?: { id?: string; name?: string; preview?: string } }>(
      "thread/start",
      {
        model: options.model || null,
        cwd,
        ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
        ...(options.ephemeral ? { ephemeral: true } : {}),
        approvalPolicy: options.permission === "danger-full-access" ? "never" : "on-request",
        sandbox: options.permission,
        sandboxPolicy,
        ...(scopedConfig ? { config: scopedConfig } : {}),
        serviceTier: normalizeServiceTier(options.serviceTier),
        experimentalRawEvents: false,
        persistExtendedHistory: options.persistExtendedHistory !== false
      },
      options.requestTimeoutMs ?? 60000
    );
    const thread = result.thread;
    if (!thread?.id) throw new Error("Codex thread/start 未返回 thread.id");
    return {
      threadId: thread.id,
      title: thread.name || thread.preview || "新会话"
    };
  }

  async resumeThread(threadId: string, options: TurnOptions): Promise<void> {
    const client = this.requireClient();
    const scopedConfig = await this.buildThreadConfig(options);
    const cwd = this.resolveTurnCwd(options);
    const sandboxPolicy = buildSandboxPolicy(options.permission, cwd, options.writableRoots);
    await client.request(
      "thread/resume",
      {
        threadId,
        model: options.model || null,
        cwd,
        ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
        approvalPolicy: options.permission === "danger-full-access" ? "never" : "on-request",
        sandbox: options.permission,
        sandboxPolicy,
        ...(scopedConfig ? { config: scopedConfig } : {}),
        serviceTier: normalizeServiceTier(options.serviceTier),
        persistExtendedHistory: options.persistExtendedHistory !== false
      },
      options.requestTimeoutMs ?? 60000
    );
  }

  async startTurn(threadId: string, input: UserInput[], options: TurnOptions): Promise<string> {
    const client = this.requireClient();
    const cwd = this.resolveTurnCwd(options);
    const collaborationMode = buildCollaborationMode(options.mode, options.model, options.reasoning);
    const result = await client.request<{ turn?: { id?: string } }>(
      "turn/start",
      {
        threadId,
        input,
        cwd,
        model: options.model || null,
        effort: options.reasoning,
        serviceTier: normalizeServiceTier(options.serviceTier),
        approvalPolicy: options.permission === "danger-full-access" ? "never" : "on-request",
        sandbox: options.permission,
        sandboxPolicy: buildSandboxPolicy(options.permission, cwd, options.writableRoots),
        ...(collaborationMode ? { collaborationMode } : {})
      },
      options.requestTimeoutMs ?? 60000
    );
    return result?.turn?.id ?? "";
  }

  private resolveTurnCwd(options: TurnOptions): string {
    return options.cwd?.trim() || this.options.vaultPath;
  }

  async steerTurn(threadId: string, turnId: string, input: UserInput[]): Promise<void> {
    const client = this.requireClient();
    await client.request("turn/steer", { threadId, expectedTurnId: turnId, input }, 30000);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const client = this.requireClient();
    await client.request("turn/interrupt", { threadId, turnId }, 10000);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    const client = this.requireClient();
    await client.request("thread/name/set", { threadId, name }, 10000);
  }

  async archiveThread(threadId: string): Promise<void> {
    const id = threadId.trim();
    if (!id) throw new Error("缺少 Codex threadId，无法归档");
    const command = resolveCodexCommand(this.options.cliPath);
    const launch = buildCodexLaunchConfig({
      proxyEnabled: this.options.proxyEnabled,
      proxyUrl: this.options.proxyUrl,
      providerMode: this.options.providerMode,
      activeApiProvider: this.options.activeApiProvider
    });
    const runner = this.options.processRunner ?? execFilePromise;
    try {
      await runner(command, ["archive", id], {
        cwd: this.options.vaultPath,
        env: launch.env,
        timeoutMs: 15000,
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      throw new Error(`Codex thread 归档失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async login(): Promise<unknown> {
    const client = this.requireClient();
    return client.request("account/login/start", { authMode: "chatgpt" }, 15000);
  }

  async startMcpOAuth(name: string): Promise<string> {
    const client = this.requireClient();
    const response = await client.request<{ authorizationUrl?: string }>("mcpServer/oauth/login", { name, timeoutSecs: 120 }, 15000);
    return response?.authorizationUrl ?? "";
  }

  private async safeRequest<T = unknown>(method: string, params: unknown, timeoutMs: number, errors: string[]): Promise<T | null> {
    try {
      return await this.requireClient().request<T>(method, params, timeoutMs);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async optionalRequest<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<{ data: T | null; error: string | null }> {
    try {
      return { data: await this.requireClient().request<T>(method, params, timeoutMs), error: null };
    } catch (error) {
      return { data: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async buildThreadConfig(options: TurnOptions): Promise<Record<string, unknown> | null> {
    const workspaceResources = options.workspaceResources;
    const config: Record<string, unknown> = {};
    if (!options.mcpEnabled) {
      config.mcp_servers = {};
    } else if (hasResourceOverrides(workspaceResources?.mcpServers)) {
      const runtimeConfig = await this.readRuntimeConfig();
      const baseMcp = runtimeConfig?.mcp_servers;
      if (baseMcp) {
        config.mcp_servers = Object.fromEntries(
          Object.entries(baseMcp).filter(([name, serverConfig]) =>
            resourceEnabled(workspaceResources?.mcpServers, name, serverConfig?.enabled !== false)
          )
        );
      }
    }

    if (hasResourceOverrides(workspaceResources?.plugins)) {
      const runtimeConfig = await this.readRuntimeConfig();
      const basePlugins = runtimeConfig?.plugins && typeof runtimeConfig.plugins === "object" ? runtimeConfig.plugins : {};
      config.plugins = Object.fromEntries(
        Object.entries({
          ...basePlugins,
          ...Object.fromEntries(Object.keys(workspaceResources?.plugins ?? {}).map((id) => [id, basePlugins[id] ?? {}]))
        }).map(([id, pluginConfig]) => [
          id,
          {
            ...(pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}),
            enabled: resourceEnabled(workspaceResources?.plugins, id, pluginConfig?.enabled !== false)
          }
        ])
      );
    }

    return Object.keys(config).length ? config : null;
  }

  private async readRuntimeConfig(): Promise<CodexRuntimeConfig> {
    if (this.cachedRuntimeConfig) return this.cachedRuntimeConfig;
    const response = await this.requireClient().request("config/read", {}, 12000);
    this.cachedRuntimeConfig = normalizeRuntimeConfig(response);
    return this.cachedRuntimeConfig;
  }

  private requireClient(): CodexRpcClient {
    if (!this.client?.isAlive()) throw new Error("Codex app-server 未连接");
    return this.client;
  }
}

export function resolveCodexCommand(customPath: string, options: CodexCommandResolveOptions = {}): string {
  const custom = customPath.trim();
  const found = detectCodexCommand(customPath, options);
  if (found) return found;
  if (custom) {
    const expanded = expandHome(custom, options.home ?? os.homedir());
    throw new Error(`找不到 Codex CLI：${expanded}。请先安装 Codex CLI，或在设置里填写正确路径。`);
  }
  throw new Error("找不到 Codex CLI。请先安装并登录 Codex CLI；自定义 API Provider 也需要通过 Codex CLI app-server 调用。");
}

export function detectCodexCommand(customPath: string, options: CodexCommandResolveOptions = {}): string | null {
  const home = options.home ?? os.homedir();
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const custom = customPath.trim();
  if (custom) {
    const expanded = expandHome(custom, home);
    return exists(expanded) ? expanded : null;
  }
  return codexCommandCandidateList(
    home,
    options.envPath ?? process.env.PATH ?? "",
    options.platform ?? process.platform,
    options.appData ?? process.env.APPDATA ?? "",
    options.programData ?? process.env.ProgramData ?? "C:\\ProgramData"
  ).find((candidate) => exists(candidate)) ?? null;
}

export function buildCodexLaunchConfig(options: {
  proxyEnabled: boolean;
  proxyUrl: string;
  providerMode: ProviderMode;
  activeApiProvider: ApiProviderConfig | null;
}): CodexLaunchConfig {
  const env = buildEnv(options.proxyEnabled, options.proxyUrl);
  const args = ["app-server", "--listen", "stdio://"];
  const provider = options.providerMode === "custom-api" ? options.activeApiProvider : null;
  if (!provider) return { args, env };

  const providerId = provider.id;
  const model = getApiProviderModels(provider)[0] ?? provider.model;
  const envKey = customApiProviderEnvKey(providerId);
  env[envKey] = provider.apiKey;
  args.push(
    "-c",
    `model_provider=${tomlString(providerId)}`,
    "-c",
    `model=${tomlString(model)}`,
    "-c",
    `model_providers.${providerId}.name=${tomlString(provider.name)}`,
    "-c",
    `model_providers.${providerId}.base_url=${tomlString(provider.baseUrl)}`,
    "-c",
    `model_providers.${providerId}.env_key=${tomlString(envKey)}`,
    "-c",
    `model_providers.${providerId}.wire_api="responses"`,
    "-c",
    `model_providers.${providerId}.requires_openai_auth=false`
  );
  for (const [key, value] of Object.entries(provider.queryParams ?? {})) {
    if (/^[A-Za-z0-9_-]+$/.test(key) && value.trim()) {
      args.push("-c", `model_providers.${providerId}.query_params.${key}=${tomlString(value.trim())}`);
    }
  }
  return { args, env };
}

function customApiProviderEnvKey(providerId: string): string {
  const safeId = providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `OBSIDIAN_CODEX_API_KEY_${safeId || "CUSTOM"}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function execFilePromise(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer
    }, (error, stdout, stderr) => {
      if (error) {
        const message = [error.message, stderr ? `stderr: ${stderr}` : ""].filter(Boolean).join("\n");
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildEnv(proxyEnabled: boolean, proxyUrl: string): NodeJS.ProcessEnv {
  const home = os.homedir();
  const pathParts = [
    ...codexAppCommandCandidates(home).map((candidate) => path.dirname(candidate)),
    path.join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || ""
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || os.homedir(),
    PATH: Array.from(new Set(pathParts.filter(Boolean).join(path.delimiter).split(path.delimiter))).join(path.delimiter)
  };
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  if (proxyEnabled && normalizedProxyUrl) {
    env.HTTP_PROXY = normalizedProxyUrl;
    env.HTTPS_PROXY = normalizedProxyUrl;
    env.ALL_PROXY = normalizedProxyUrl;
    env.http_proxy = normalizedProxyUrl;
    env.https_proxy = normalizedProxyUrl;
    env.all_proxy = normalizedProxyUrl;
    const noProxy = mergeNoProxy(env.NO_PROXY || env.no_proxy);
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}

function codexCommandCandidates(home: string, envPath: string): string[] {
  const platform = process.platform;
  const appData = process.env.APPDATA || "";
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return codexCommandCandidateList(home, envPath, platform, appData, programData);
}

function codexCommandCandidateList(home: string, envPath: string, platform: string, appData: string, programData: string): string[] {
  const windowsCandidates = platform === "win32"
    ? [
      appData ? path.win32.join(appData, "npm", "codex.cmd") : "",
      appData ? path.win32.join(appData, "npm", "codex.ps1") : "",
      path.win32.join(home, "scoop", "shims", "codex.cmd"),
      path.win32.join(programData, "chocolatey", "bin", "codex.exe")
    ].filter(Boolean)
    : [];
  return [
    path.join(home, ".npm-global", "bin", "codex"),
    ...codexAppCommandCandidates(home),
    ...windowsCandidates,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...String(envPath || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((part) => path.join(part, "codex"))
  ];
}

function codexAppCommandCandidates(home: string): string[] {
  return [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")
  ];
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function mergeNoProxy(existing?: string): string {
  const base = ["127.0.0.1", "localhost", "::1", "*.local"];
  const extra = String(existing || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set([...base, ...extra])).join(",");
}

function normalizeInitResult(value: unknown): CodexInitResult {
  const record = asRecord(value);
  return {
    codexHome: stringValue(record?.codexHome),
    platformOs: stringValue(record?.platformOs)
  };
}

function normalizeRuntimeConfig(value: unknown): CodexRuntimeConfig {
  const record = asRecord(value);
  return {
    mcp_servers: normalizeRuntimeResourceRecord(record?.mcp_servers),
    plugins: normalizeRuntimeResourceRecord(record?.plugins)
  };
}

function normalizeRuntimeResourceRecord(value: unknown): Record<string, CodexRuntimeResourceConfig> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => Boolean(key.trim()))
      .map(([key, item]) => [key, normalizeRuntimeResourceConfig(item)])
  );
}

function normalizeRuntimeResourceConfig(value: unknown): CodexRuntimeResourceConfig {
  const record = asRecord(value);
  if (!record) return {};
  return {
    ...record,
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {})
  };
}

function formatAccountLabel(response: unknown): string {
  const record = asRecord(response);
  const account = asRecord(record?.account);
  if (!account) return record?.requiresOpenaiAuth === true ? "未登录" : "未知";
  const type = stringValue(account.type);
  if (type === "chatgpt") {
    const email = stringValue(account.email);
    return email ? `ChatGPT：${email}` : "ChatGPT 已登录";
  }
  if (type === "apiKey") return "API Key 已配置";
  return "已登录";
}

function codexModelToAgentModel(model: CodexModel): AgentModelInfo {
  const modelId = model.model || model.id;
  return {
    id: model.id || modelId,
    providerId: "codex",
    modelId,
    displayName: model.displayName || modelId,
    inputModalities: normalizeCodexAgentModalities(model.inputModalities)
  };
}

function normalizeCodexAgentModalities(input: string[] | undefined): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const item of input ?? []) {
    if (item === "image" || item === "pdf") modalities.add(item);
  }
  return Array.from(modalities);
}

function turnOptionsFromAgentSession(options: AgentSessionOptions, vaultPath: string): TurnOptions {
  return {
    cwd: vaultPath,
    model: options.model?.modelId ?? "",
    reasoning: options.reasoning ?? "medium",
    serviceTier: options.serviceTier ?? "standard",
    permission: options.permission ?? "workspace-write",
    mode: options.mode ?? "agent",
    mcpEnabled: true,
    writableRoots: options.writableRoots
  };
}

function turnOptionsFromAgentPrompt(options: AgentPromptOptions, vaultPath: string): TurnOptions {
  return {
    cwd: vaultPath,
    model: options.model?.modelId ?? "",
    reasoning: "medium",
    serviceTier: "standard",
    permission: options.tools?.write === false && options.tools?.edit === false ? "read-only" : "workspace-write",
    mode: "agent",
    mcpEnabled: true
  };
}

function agentPromptPartsToCodexInput(parts: AgentPromptPart[], system?: string): UserInput[] {
  const input: UserInput[] = [];
  if (system?.trim()) input.push({ type: "text", text: system.trim(), text_elements: [] });
  for (const part of parts) {
    if (part.type === "text") {
      input.push({ type: "text", text: part.text, text_elements: [] });
    } else if (part.mime.startsWith("image/")) {
      input.push({ type: "localImage", path: part.path });
    } else {
      input.push({ type: "mention", name: part.filename || path.basename(part.path), path: part.path });
    }
  }
  return input.length ? input : [{ type: "text", text: "", text_elements: [] }];
}

export function codexRunIdForTurn(threadId: string, turnId: string): string {
  return `${threadId}::${turnId}`;
}

function parseCodexRunId(runId: string): { threadId: string; turnId: string } {
  const separator = runId.indexOf("::");
  const threadId = separator === -1 ? "" : runId.slice(0, separator).trim();
  const turnId = separator === -1 ? "" : runId.slice(separator + 2).trim();
  if (!threadId || !turnId) throw new Error("Codex abort 需要 threadId::turnId 格式的 runId。");
  return { threadId, turnId };
}

function normalizeModels(data: unknown): CodexModel[] {
  if (!Array.isArray(data)) return [];
  return data
    .map(asRecord)
    .filter((item): item is UnknownRecord => Boolean(item && item.hidden !== true))
    .map((item) => {
      const model = stringValue(item.model) || stringValue(item.id);
      const id = stringValue(item.id) || model;
      return {
        id,
        model,
        displayName: stringValue(item.displayName) || model || id,
        description: stringValue(item.description) || undefined,
        isDefault: typeof item.isDefault === "boolean" ? item.isDefault : undefined,
        supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [],
        defaultReasoningEffort: isReasoningEffort(item.defaultReasoningEffort) ? item.defaultReasoningEffort : undefined,
        inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities.filter((entry): entry is string => typeof entry === "string") : []
      };
    });
}

function normalizeSkills(data: unknown): CodexSkill[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const record = asRecord(entry);
    const skills = Array.isArray(record?.skills) ? record.skills : [];
    return skills.map((skill) => {
      const item = asRecord(skill);
      return {
        name: stringValue(item?.name),
        description: stringValue(item?.description) || stringValue(item?.shortDescription),
        path: stringValue(item?.path),
        scope: stringValue(item?.scope) || undefined,
        enabled: item?.enabled !== false
      };
    });
  });
}

function normalizePlugins(response: unknown): CodexPluginInfo[] {
  const record = asRecord(response);
  const marketplaces = Array.isArray(record?.marketplaces) ? record.marketplaces : [];
  return marketplaces.flatMap((marketplace) => {
    const marketplaceRecord = asRecord(marketplace);
    const marketplaceName = stringValue(marketplaceRecord?.id) || stringValue(marketplaceRecord?.name);
    const plugins = Array.isArray(marketplaceRecord?.plugins) ? marketplaceRecord.plugins : [];
    return plugins.map((plugin) => {
      const pluginRecord = asRecord(plugin);
      const interfaceRecord = asRecord(pluginRecord?.interface);
      const id = stringValue(pluginRecord?.id) || stringValue(pluginRecord?.name);
      const displayName = stringValue(interfaceRecord?.displayName) || stringValue(pluginRecord?.displayName) || stringValue(pluginRecord?.name) || id;
      const installed = pluginRecord?.installed !== false;
      return {
        id,
        name: stringValue(pluginRecord?.name) || id,
        displayName,
        description: stringValue(interfaceRecord?.shortDescription) || stringValue(pluginRecord?.description),
        marketplace: marketplaceName,
        category: stringValue(interfaceRecord?.category) || undefined,
        installed,
        enabled: installed && pluginRecord?.enabled !== false
      };
    }).filter((plugin: CodexPluginInfo) => Boolean(plugin.id && plugin.installed));
  });
}

function normalizeMcp(data: unknown): McpServerStatus[] {
  if (!Array.isArray(data)) return [];
  return data.map((server) => {
    const record = asRecord(server);
    return {
      name: stringValue(record?.name),
      tools: asRecord(record?.tools) ?? {},
      resources: Array.isArray(record?.resources) ? record.resources : [],
      resourceTemplates: Array.isArray(record?.resourceTemplates) ? record.resourceTemplates : [],
      authStatus: stringValue(record?.authStatus) || "unknown"
    };
  });
}

function normalizeMcpConfig(data: unknown): McpServerStatus[] {
  const record = asRecord(data);
  if (!record) return [];
  return Object.entries(record)
    .filter(([name]) => typeof name === "string" && Boolean(name.trim()))
    .map(([name, serverConfig]) => ({
      name,
      tools: {},
      resources: [],
      resourceTemplates: [],
      authStatus: asRecord(serverConfig)?.enabled === false ? "disabled" : "configured"
    }));
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}
