import { execFile } from "child_process";
import type { AgentBackend, AgentConnectionStatus, AgentModelInfo, AgentProfileInfo, AgentPromptOptions, AgentSessionOptions, AgentTaskInput, AgentTaskResult } from "../agent/types";
import { swallowError } from "./error-handling";
import { formatHermesError } from "./hermes-errors";
import { isSyntheticHermesDefaultModel, normalizeHermesServerUrl, parseHermesVersion, resolveHermesCommand } from "./hermes-models";
import { parseHermesMcpListOutput, type HermesMcpServerInfo } from "../resources/mcp-loader";
import { parseHermesSkillListOutput, type HermesSkillInfo } from "../resources/skill-loader";

export interface HermesBackendOptions {
  cliPath: string;
  serverUrl: string;
  autoStart: boolean;
  hostname: string;
  port: number;
  profile: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  vaultPath: string;
  processRunner?: HermesProcessRunner;
  fetch?: HermesFetch;
  commandExists?: (candidate: string) => boolean;
}

export interface HermesConnectionInfo {
  connected: boolean;
  serverUrl: string;
  command: string;
  version: string;
  upstream: string;
  errors: string[];
}

export type HermesProcessRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;

export type HermesFetch = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text?(): Promise<string>;
}>;

const HERMES_INITIAL_POLL_DELAY_MS = 500;
const HERMES_MAX_POLL_DELAY_MS = 5_000;
const HERMES_POLL_JITTER_MS = 250;
const HERMES_PROMPT_ONLY_TOOLSET = "context_engine";

export class HermesBackend implements AgentBackend {
  readonly kind = "hermes" as const;
  private connectionInfo: HermesConnectionInfo = {
    connected: false,
    serverUrl: "",
    command: "",
    version: "",
    upstream: "",
    errors: []
  };

  constructor(private readonly options: HermesBackendOptions) {}

  async connect(): Promise<AgentConnectionStatus> {
    const command = resolveHermesCommand(this.options.cliPath, { exists: this.options.commandExists });
    const versionOutput = await this.runProcess(command, ["--version"], 15000);
    const version = parseHermesVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    this.connectionInfo = {
      connected: true,
      command,
      serverUrl: normalizeHermesServerUrl(this.options.serverUrl, this.options.hostname, this.options.port),
      version: version.version,
      upstream: version.upstream,
      errors: []
    };
    return {
      connected: true,
      label: "Hermes",
      version: version.version,
      errors: []
    };
  }

  async disconnect(): Promise<void> {
    this.connectionInfo = { ...this.connectionInfo, connected: false };
  }

  getConnectionInfo(): HermesConnectionInfo {
    return this.connectionInfo;
  }

  async listModels(): Promise<AgentModelInfo[]> {
    if (this.options.serverUrl.trim()) {
      const data = await this.fetchJson(`${this.connectionInfo.serverUrl || normalizeHermesServerUrl(this.options.serverUrl, this.options.hostname, this.options.port)}/models`, {
        method: "GET",
        headers: this.headers()
      });
      const models = Array.isArray(data?.data) ? data.data : [];
      return models.map((model: any) => {
        const id = String(model?.id ?? "");
        return {
          id,
          providerId: this.options.providerId || String(model?.providerId ?? model?.provider ?? ""),
          modelId: id,
          displayName: id,
          inputModalities: ["text"]
        };
      }).filter((model: AgentModelInfo) => model.modelId);
    }
    if (!this.options.providerId.trim() || !this.options.modelId.trim()) return [];
    if (isSyntheticHermesDefaultModel(this.options.providerId, this.options.modelId)) return [];
    return [configuredHermesModel(this.options.providerId, this.options.modelId)];
  }

  async listAgents(): Promise<AgentProfileInfo[]> {
    const profile = this.options.profile || "default";
    return [{
      id: profile,
      name: profile,
      displayName: profile,
      mode: "primary",
      native: true
    }];
  }

  async listSkills(): Promise<HermesSkillInfo[]> {
    const command = resolveHermesCommand(this.options.cliPath, { exists: this.options.commandExists });
    const output = await this.runProcess(command, ["skills", "list"], 20000);
    return parseHermesSkillListOutput(`${output.stdout}\n${output.stderr}`);
  }

  async listMcpServers(): Promise<HermesMcpServerInfo[]> {
    const command = resolveHermesCommand(this.options.cliPath, { exists: this.options.commandExists });
    const output = await this.runProcess(command, ["mcp", "list"], 20000);
    return parseHermesMcpListOutput(`${output.stdout}\n${output.stderr}`);
  }

  async startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }> {
    return { sessionId: `hermes-${Date.now()}`, title: options.title };
  }

  async sendPrompt(options: AgentPromptOptions): Promise<string> {
    const text = options.parts.map((part) => part.type === "text" ? part.text : `[file] ${part.path}`).join("\n\n");
    return (await this.runTask({ prompt: text, system: options.system, model: options.model, agent: options.agent, tools: options.tools })).text;
  }

  async abort(runId: string): Promise<void> {
    if (!runId || !this.options.serverUrl.trim()) return;
    await this.fetchJson(`${this.connectionInfo.serverUrl}/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: this.headers()
    }).catch(swallowError("stop Hermes run"));
  }

  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const prompt = buildHermesPrompt(input);
    const profile = input.profile?.trim() || this.options.profile.trim();
    if (this.options.serverUrl.trim()) {
      throwIfAborted(input.abortSignal);
      const run = await this.fetchJson(`${this.connectionInfo.serverUrl || normalizeHermesServerUrl(this.options.serverUrl, this.options.hostname, this.options.port)}/runs`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          input: prompt,
          model: input.model?.modelId || this.options.modelId || undefined,
          provider: input.model?.providerId || this.options.providerId || undefined,
          profile: profile || undefined,
          instructions: input.system?.trim() || undefined,
          cwd: this.options.vaultPath,
          permission: input.permission ?? "workspace-write"
        })
      });
      const runId = String(run?.run_id ?? run?.id ?? "");
      if (!runId) throw new Error(formatHermesError("Hermes API 未返回 run_id"));
      input.onRunId?.(runId);
      const result = await this.pollRun(runId, input.timeoutMs ?? 20 * 60 * 1000, input.abortSignal);
      return {
        text: String(result?.output ?? result?.final_response ?? result?.result ?? ""),
        runId,
        usage: result?.usage
      };
    }
    const command = resolveHermesCommand(this.options.cliPath, { exists: this.options.commandExists });
    const promptOnly = Boolean(input.system?.trim());
    const noTools = input.tools !== undefined && Object.values(input.tools).every((enabled) => !enabled);
    const args = profile ? ["--profile", profile] : [];
    if (promptOnly) args.push("chat", "-q", prompt, "--quiet", "--ignore-rules", "--source", "tool");
    else args.push("-z", prompt);
    if (noTools) args.push("--toolsets", HERMES_PROMPT_ONLY_TOOLSET);
    const providerId = input.model?.providerId || this.options.providerId;
    const modelId = input.model?.modelId || this.options.modelId;
    const useConfiguredModel = !isSyntheticHermesDefaultModel(providerId, modelId);
    if (useConfiguredModel && providerId) args.push("--provider", providerId);
    if (useConfiguredModel && modelId) args.push("--model", modelId);
    const localRunId = `hermes-cli-${Date.now()}`;
    input.onRunId?.(localRunId);
    const env = input.system?.trim()
      ? { HERMES_EPHEMERAL_SYSTEM_PROMPT: input.system.trim(), HERMES_IGNORE_RULES: "1" }
      : undefined;
    const output = await this.runProcess(
      command,
      args,
      input.timeoutMs ?? 20 * 60 * 1000,
      input.abortSignal,
      env
    );
    const sessionId = promptOnly ? parseHermesQuietSessionId(output.stderr) : "";
    if (sessionId) {
      const cleanupArgs = profile ? ["--profile", profile] : [];
      cleanupArgs.push("sessions", "delete", sessionId, "--yes");
      await this.runProcess(command, cleanupArgs, 15_000).catch(swallowError("delete Hermes prompt enhancer session"));
    }
    return { text: output.stdout.trim() };
  }

  private async pollRun(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    const started = Date.now();
    let last: any = null;
    let pollDelayMs = HERMES_INITIAL_POLL_DELAY_MS;
    while (Date.now() - started < timeoutMs) {
      if (signal?.aborted) {
        await this.abort(runId).catch(swallowError("abort canceled Hermes poll"));
        throw new Error("Hermes 任务已取消。");
      }
      last = await this.fetchJson(`${this.connectionInfo.serverUrl}/runs/${encodeURIComponent(runId)}`, {
        method: "GET",
        headers: this.headers()
      });
      const status = String(last?.status ?? "").toLowerCase();
      if (status === "completed" || status === "success" || status === "failed" || status === "canceled" || status === "cancelled") {
        if (status === "completed" || status === "success") return last;
        throw new Error(formatHermesError(last?.error ?? last?.message ?? `Hermes run ${status}`));
      }
      const remainingMs = Math.max(timeoutMs - (Date.now() - started), 0);
      await delay(Math.min(pollDelayMs + Math.random() * HERMES_POLL_JITTER_MS, remainingMs), signal);
      pollDelayMs = Math.min(pollDelayMs * 1.5, HERMES_MAX_POLL_DELAY_MS);
    }
    await this.abort(runId).catch(swallowError("abort timed out Hermes poll"));
    throw new Error(`Hermes 长时间没有返回（${Math.round(timeoutMs / 1000)} 秒），已请求中断。`);
  }

  private async fetchJson(url: string, init: any): Promise<any> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("当前环境没有 fetch，无法连接 Hermes API server");
    const response = await fetchImpl(url, init);
    const data = await response.json().catch(async () => ({ message: response.text ? await response.text() : "" }));
    if (!response.ok) throw new Error(formatHermesError({ status: response.status, data }));
    return data;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.options.apiKey.trim() ? { Authorization: `Bearer ${this.options.apiKey.trim()}` } : {})
    };
  }

  private async runProcess(command: string, args: string[], timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
    const runner = this.options.processRunner ?? defaultProcessRunner;
    try {
      throwIfAborted(signal);
      return await runner(command, args, {
        cwd: this.options.vaultPath,
        env: { ...process.env, PATH: process.env.PATH ?? "", ...env },
        timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        signal
      });
    } catch (error) {
      throw new Error(formatHermesError(error));
    }
  }
}

function buildHermesPrompt(input: AgentTaskInput): string {
  return [
    input.resources?.promptPrefix ?? "",
    input.resources?.warnings?.length ? `资源提示：\n${input.resources.warnings.map((item) => `- ${item}`).join("\n")}` : "",
    input.prompt
  ].filter(Boolean).join("\n\n");
}

function parseHermesQuietSessionId(stderr: string): string {
  return stderr.match(/(?:^|\n)session_id:\s*([^\s]+)/)?.[1]?.trim() ?? "";
}

function configuredHermesModel(providerId: string, modelId: string): AgentModelInfo {
  return {
    id: `${providerId}/${modelId}`,
    providerId,
    modelId,
    displayName: `${providerId}/${modelId}`,
    inputModalities: ["text"]
  };
}

async function defaultProcessRunner(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      signal: options.signal
    }, (error, stdout, stderr) => {
      if (error) {
        reject(appendProcessOutput(error, stdout, stderr));
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function appendProcessOutput(error: Error, stdout: string | Buffer, stderr: string | Buffer): Error {
  const output = [String(stderr ?? "").trim(), String(stdout ?? "").trim()].filter(Boolean).join("\n");
  if (!output) return error;
  const next = new Error(`${error.message}\n${output}`);
  next.name = error.name;
  next.stack = error.stack;
  return next;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", finish);
      if (timeout) clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(finish, ms);
    if (signal) signal.addEventListener("abort", finish, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Hermes 任务已取消。");
}
