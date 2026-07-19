import { CodexService, type TurnOptions } from "../core/codex-service";
import { createHarnessAgentAdapter } from "../harness/agents/adapter-factory";
import type { AgentAdapter } from "../harness/agents/adapter";
import { CodexRichNotificationHub } from "../harness/agents/adapters/codex-rich-notification-hub";
import { runEphemeralUtility } from "../harness/native/ephemeral-utility-lifecycle";
import type CodexForObsidianPlugin from "../main";
import {
  DEFAULT_CODEX_UTILITY_MODEL,
  DEFAULT_HERMES_UTILITY_MODEL,
  DEFAULT_HERMES_UTILITY_PROVIDER,
  DEFAULT_OPENCODE_UTILITY_MODEL,
  DEFAULT_OPENCODE_UTILITY_PROVIDER,
  getActiveApiProvider,
  getApiProviderModels,
  newId,
  promptEnhancerModelId,
  type ApiProviderConfig,
  type CodexForObsidianSettings,
  type ProviderMode
} from "../settings/settings";
import type { AgentBackendKind, AgentModelInfo } from "../agent/types";
import { cleanPromptEnhancerOutput, ENHANCE_META_PROMPT, ENHANCE_PROMPT_AGENT_NAME } from "./meta-prompt";
import { createPromptEnhancerRuntimeWorkspace } from "./runtime-workspace";

const NO_RESOURCES = { selected: [], resolvedAt: 0, warnings: [] };
const NO_TOOLS = { read: false, write: false, edit: false, bash: false };

export interface RunPromptEnhancerInput {
  plugin: CodexForObsidianPlugin;
  prompt: string;
  signal?: AbortSignal;
  onRunCreated?: (runId: string) => void;
  onTurnStarted?: (turnId: string) => void;
}

export interface PromptEnhancerBackendCapabilities {
  reasoning: boolean;
  serviceTier: boolean;
}

export function promptEnhancerBackendCapabilities(backend: AgentBackendKind): PromptEnhancerBackendCapabilities {
  const usesCodex = backend === "codex-cli";
  return {
    reasoning: usesCodex,
    serviceTier: usesCodex
  };
}

export async function runPromptEnhancer(input: RunPromptEnhancerInput): Promise<string> {
  throwIfPromptEnhancerAborted(input.signal);
  const backend = resolvePromptEnhancerBackend(input.plugin.settings);
  const runId = newId("prompt-enhancer-run");
  return backend === "codex-cli"
    ? await runCodexPromptEnhancer(input, runId)
    : await runTaskPromptEnhancer({ ...input, backend }, runId);
}

export function resolvePromptEnhancerBackend(settings: CodexForObsidianSettings): AgentBackendKind {
  const configured = settings.promptEnhancer.backend;
  return configured === "opencode" || configured === "hermes" ? configured : "codex-cli";
}

export function resolvePromptEnhancerModel(settings: CodexForObsidianSettings, backend = resolvePromptEnhancerBackend(settings)): string {
  const configured = settings.promptEnhancer.model.trim();
  if (configured) return configured;
  if (backend === "opencode") return DEFAULT_OPENCODE_UTILITY_MODEL;
  if (backend === "hermes") return DEFAULT_HERMES_UTILITY_MODEL;
  const provider = settings.providerMode === "custom-api" ? getActiveApiProvider(settings) : null;
  const providerModel = provider ? getApiProviderModels(provider)[0] : "";
  if (providerModel) return providerModel;
  return DEFAULT_CODEX_UTILITY_MODEL;
}

export function resolvePromptEnhancerProviderId(settings: CodexForObsidianSettings, backend = resolvePromptEnhancerBackend(settings)): string {
  const configured = settings.promptEnhancer.providerId.trim();
  if (configured) return configured;
  if (backend === "opencode") return DEFAULT_OPENCODE_UTILITY_PROVIDER;
  if (backend === "hermes") return DEFAULT_HERMES_UTILITY_PROVIDER;
  return "";
}

export function resolvePromptEnhancerCodexProvider(settings: CodexForObsidianSettings): {
  providerMode: ProviderMode;
  activeApiProvider: ApiProviderConfig | null;
} {
  const providerMode = settings.providerMode === "custom-api" ? "custom-api" : "codex-login";
  if (providerMode !== "custom-api") return { providerMode, activeApiProvider: null };
  const activeApiProvider = getActiveApiProvider(settings);
  if (!activeApiProvider) throw new Error("Codex API Provider 未配置");
  return { providerMode, activeApiProvider };
}

async function runCodexPromptEnhancer(input: RunPromptEnhancerInput, runId: string): Promise<string> {
  const plugin = input.plugin;
  const settings = plugin.settings.promptEnhancer;
  throwIfPromptEnhancerAborted(input.signal);
  const workspace = await createPromptEnhancerRuntimeWorkspace("codex-cli");
  const hub = new CodexRichNotificationHub();
  const { providerMode, activeApiProvider } = resolvePromptEnhancerCodexProvider(plugin.settings);
  const service = new CodexService({
    cliPath: plugin.settings.cliPath,
    proxyEnabled: plugin.settings.proxyEnabled,
    proxyUrl: plugin.settings.proxyUrl,
    providerMode,
    activeApiProvider,
    vaultPath: workspace.cwd,
    onNotification: (notification) => {
      hub.dispatch(notification);
    },
    onServerRequest: async () => ({ decision: "decline" })
  });
  let adapter: AgentAdapter | null = null;
  try {
    throwIfPromptEnhancerAborted(input.signal);
    const status = await service.connect();
    throwIfPromptEnhancerAborted(input.signal);
    if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
    const turnOptions: TurnOptions = {
      cwd: workspace.cwd,
      model: resolvePromptEnhancerModel(plugin.settings, "codex-cli"),
      developerInstructions: ENHANCE_META_PROMPT,
      ephemeral: true,
      reasoning: settings.reasoning,
      serviceTier: settings.serviceTier,
      permission: "read-only",
      mode: "agent",
      mcpEnabled: false,
      persistExtendedHistory: false,
      requestTimeoutMs: settings.timeoutMs,
      workspaceResources: { plugins: {}, mcpServers: {}, skills: {} }
    };
    adapter = createHarnessAgentAdapter({
      backendId: "codex-cli",
      settings: plugin.settings,
      vaultPath: workspace.cwd,
      codexRich: {
        turnOptions,
        notificationHub: hub,
        getNativeThreadId: () => undefined,
        setNativeThreadId: () => undefined,
        buildInput: () => [{ type: "text", text: input.prompt, text_elements: [] }],
        startThread: async (options) => await service.startThread(options ?? turnOptions),
        resumeThread: async (threadId, options) => await service.resumeThread(threadId, options ?? turnOptions),
        startTurn: async (threadId, turnInput, options) => {
          const turnId = await service.startTurn(threadId, turnInput, options ?? turnOptions);
          if (!input.signal?.aborted) input.onTurnStarted?.(turnId);
          return turnId;
        },
        interruptTurn: async (threadId, turnId) => await service.interruptTurn(threadId, turnId),
        archiveThread: async (threadId) => await service.archiveThread(threadId),
        nativeRefContext: plugin.getNativeExecutionRefContext("codex-cli")
      }
    });
    const request = {
      runId,
      sessionId: `${ENHANCE_PROMPT_AGENT_NAME}:${runId}`,
      surface: "chat" as const,
      workflow: "prompt.enhance" as const,
      backendId: "codex-cli",
      workspace: {
        vaultPath: workspace.cwd,
        cwd: workspace.cwd
      },
      input: {
        text: input.prompt,
        attachments: []
      },
      permissions: {
        mode: "read-only" as const,
        writableRoots: [],
        requireApproval: true
      },
      resourceSelection: NO_RESOURCES,
      memoryPolicy: {
        enabled: false,
        maxItems: 0
      },
      outputContract: {
        kind: "plain-text" as const
      }
    };
    return await runEphemeralUtility({
      host: plugin,
      adapter,
      request,
      signal: input.signal,
      timeoutMs: settings.timeoutMs,
      timeoutMessage: "增强提示词响应超时",
      onHarnessStarted: () => input.onRunCreated?.(runId),
      awaitResult: async () => {
        if (!adapter?.awaitResult) {
          throw new Error("当前 Agent 不支持异步结果收口");
        }
        return await adapter.awaitResult(runId);
      },
      validateOutput: (text) => validatePromptEnhancerCandidateOutput(
        text,
        settings.maxInputChars
      ),
      isCancellation: isPromptEnhancerCancellation,
      logLabel: "Prompt Enhancer"
    });
  } finally {
    await service.disconnect().catch(() => undefined);
    await workspace.cleanup().catch(() => undefined);
  }
}

async function runTaskPromptEnhancer(input: RunPromptEnhancerInput & { backend: Exclude<AgentBackendKind, "codex-cli"> }, runId: string): Promise<string> {
  const plugin = input.plugin;
  const enhancer = plugin.settings.promptEnhancer;
  const taskSettings = promptEnhancerTaskSettings(plugin.settings, input.backend);
  throwIfPromptEnhancerAborted(input.signal);
  const workspace = await createPromptEnhancerRuntimeWorkspace(input.backend);
  const backendAgent = enhancer.agent.trim() || (input.backend === "opencode" ? ENHANCE_PROMPT_AGENT_NAME : "");
  const model = resolvePromptEnhancerModel(plugin.settings, input.backend);
  const providerId = resolvePromptEnhancerProviderId(plugin.settings, input.backend);
  let adapter: AgentAdapter | null = null;
  try {
    throwIfPromptEnhancerAborted(input.signal);
    adapter = createHarnessAgentAdapter({
      backendId: input.backend,
      settings: taskSettings,
      vaultPath: workspace.cwd,
      nativeRefContext: plugin.getNativeExecutionRefContext(input.backend),
      task: {
        system: ENHANCE_META_PROMPT,
        timeoutMs: enhancer.timeoutMs,
        tools: NO_TOOLS,
        ...(providerId && model ? { model: { providerId, modelId: model } } : {}),
        ...(backendAgent ? { agent: backendAgent } : {}),
        ...(enhancer.agent.trim() ? { profile: enhancer.agent.trim() } : {}),
        requireDirectAgent: input.backend === "opencode",
        abortSignal: input.signal
      }
    });
    throwIfPromptEnhancerAborted(input.signal);
    const request = {
      runId,
      sessionId: `${ENHANCE_PROMPT_AGENT_NAME}:${runId}`,
      surface: "chat" as const,
      workflow: "prompt.enhance" as const,
      backendId: input.backend,
      workspace: {
        vaultPath: workspace.cwd,
        cwd: workspace.cwd
      },
      input: {
        text: input.prompt,
        attachments: []
      },
      permissions: {
        mode: "read-only" as const,
        writableRoots: [],
        requireApproval: true
      },
      resourceSelection: NO_RESOURCES,
      memoryPolicy: {
        enabled: false,
        maxItems: 0
      },
      outputContract: {
        kind: "plain-text" as const
      }
    };
    return await runEphemeralUtility({
      host: plugin,
      adapter,
      request,
      signal: input.signal,
      timeoutMs: enhancer.timeoutMs,
      timeoutMessage: "增强提示词响应超时",
      onHarnessStarted: () => input.onRunCreated?.(runId),
      awaitResult: async () => {
        if (!adapter?.awaitResult) {
          throw new Error("当前 Agent 不支持异步结果收口");
        }
        return await adapter.awaitResult(runId);
      },
      validateOutput: (text) => validatePromptEnhancerCandidateOutput(
        text,
        enhancer.maxInputChars
      ),
      isCancellation: isPromptEnhancerCancellation,
      logLabel: "Prompt Enhancer"
    });
  } finally {
    await workspace.cleanup().catch(() => undefined);
  }
}

export function validatePromptEnhancerCandidateOutput(
  value: string,
  maxInputChars: number
): { value: string; terminalText: string } {
  const cleaned = cleanPromptEnhancerOutput(value);
  if (!cleaned.trim()) throw new Error("增强结果为空");
  if (cleaned.length > Math.max(4000, maxInputChars * 2)) {
    throw new Error("增强结果过长，请缩短输入后重试");
  }
  return { value: cleaned, terminalText: cleaned };
}

function isPromptEnhancerCancellation(error: unknown): boolean {
  return /已中断|已取消|cancelled|canceled/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function throwIfPromptEnhancerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("增强提示词已中断");
}

function promptEnhancerTaskSettings(settings: CodexForObsidianSettings, backend: Exclude<AgentBackendKind, "codex-cli">): CodexForObsidianSettings {
  const cloned = JSON.parse(JSON.stringify(settings)) as CodexForObsidianSettings;
  const enhancer = settings.promptEnhancer;
  if (backend === "opencode") {
    if (enhancer.providerId) cloned.opencode.providerId = enhancer.providerId;
    if (enhancer.model) cloned.opencode.modelId = enhancer.model;
    if (enhancer.agent) cloned.opencode.agent = enhancer.agent;
  } else {
    if (enhancer.providerId) cloned.agents.hermes.providerId = enhancer.providerId;
    if (enhancer.model) cloned.agents.hermes.modelId = enhancer.model;
    if (enhancer.agent) cloned.agents.hermes.profile = enhancer.agent;
  }
  return cloned;
}

export function promptEnhancerModelChoices(
  settings: CodexForObsidianSettings,
  statusModels: string[] = [],
  backendModels: AgentModelInfo[] = []
): string[] {
  const enhancer = settings.promptEnhancer;
  const backend = resolvePromptEnhancerBackend(settings);
  const provider = backend === "codex-cli" && settings.providerMode === "custom-api"
    ? getActiveApiProvider(settings)
    : null;
  const configuredId = promptEnhancerModelId(backend, enhancer.providerId, enhancer.model);
  const inheritedId = backend === "opencode"
    ? promptEnhancerModelId(backend, settings.opencode.providerId, settings.opencode.modelId)
    : backend === "hermes"
      ? promptEnhancerModelId(backend, settings.agents.hermes.providerId, settings.agents.hermes.modelId)
      : "";
  const automaticId = promptEnhancerModelId(
    backend,
    resolvePromptEnhancerProviderId(settings, backend),
    resolvePromptEnhancerModel(settings, backend)
  );
  return Array.from(new Set([
    configuredId,
    ...enhancer.customModelIds[backend],
    inheritedId,
    automaticId,
    ...(backend === "codex-cli" && provider ? getApiProviderModels(provider) : []),
    ...(backend === "codex-cli" ? statusModels : []),
    ...backendModels.map((model) => promptEnhancerModelId(backend, model.providerId, model.modelId))
  ].map((model) => model.trim()).filter(Boolean)));
}
