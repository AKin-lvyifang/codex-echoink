import { CodexService, type TurnOptions } from "../core/codex-service";
import { createHarnessAgentAdapter } from "../harness/agents/adapter-factory";
import type { AgentAdapter, AgentRunResult } from "../harness/agents/adapter";
import { CodexRichNotificationHub } from "../harness/agents/adapters/codex-rich-notification-hub";
import type { HarnessRunResult } from "../harness/contracts/run";
import type CodexForObsidianPlugin from "../main";
import {
  getActiveApiProvider,
  getApiProviderModels,
  newId,
  type ApiProviderConfig,
  type CodexForObsidianSettings,
  type ProviderMode
} from "../settings/settings";
import type { ServiceTierChoice } from "../types/app-server";
import type { AgentBackendKind } from "../agent/types";
import { cleanPromptEnhancerOutput, ENHANCE_META_PROMPT, ENHANCE_PROMPT_AGENT_NAME } from "./meta-prompt";
import { createPromptEnhancerRuntimeWorkspace } from "./runtime-workspace";

const NO_RESOURCES = { selected: [], resolvedAt: 0, warnings: [] };
const NO_TOOLS = { read: false, write: false, edit: false, bash: false };

export interface RunPromptEnhancerInput {
  plugin: CodexForObsidianPlugin;
  prompt: string;
  serviceTier?: ServiceTierChoice;
  onRunCreated?: (runId: string) => void;
  onTurnStarted?: (turnId: string) => void;
}

export async function runPromptEnhancer(input: RunPromptEnhancerInput): Promise<string> {
  const enhancer = input.plugin.settings.promptEnhancer;
  const backend = resolvePromptEnhancerBackend(input.plugin.settings);
  const runId = newId("prompt-enhancer-run");
  input.onRunCreated?.(runId);
  const result = backend === "codex-cli"
    ? await runCodexPromptEnhancer(input, runId)
    : await runTaskPromptEnhancer({ ...input, backend }, runId);
  const cleaned = cleanPromptEnhancerOutput(result);
  if (!cleaned.trim()) throw new Error("增强结果为空");
  if (cleaned.length > Math.max(4000, enhancer.maxInputChars * 2)) throw new Error("增强结果过长，请缩短输入后重试");
  return cleaned;
}

export function resolvePromptEnhancerBackend(settings: CodexForObsidianSettings): AgentBackendKind {
  const configured = settings.promptEnhancer.backend;
  return configured === "default" ? settings.agentBackend : configured;
}

export function resolvePromptEnhancerCodexProvider(settings: CodexForObsidianSettings): {
  providerMode: ProviderMode;
  activeApiProvider: ApiProviderConfig | null;
} {
  const enhancer = settings.promptEnhancer;
  const providerMode = enhancer.codexProviderMode === "default" ? settings.providerMode : enhancer.codexProviderMode;
  if (providerMode !== "custom-api") return { providerMode, activeApiProvider: null };
  const activeApiProvider = enhancer.codexProviderMode === "custom-api"
    ? settings.apiProviders.find((provider) => provider.id === enhancer.activeApiProviderId) ?? null
    : getActiveApiProvider(settings);
  if (!activeApiProvider) throw new Error("增强提示词 API Provider 未配置");
  return { providerMode, activeApiProvider };
}

async function runCodexPromptEnhancer(input: RunPromptEnhancerInput, runId: string): Promise<string> {
  const plugin = input.plugin;
  const settings = plugin.settings.promptEnhancer;
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
    const status = await service.connect();
    if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
    const turnOptions: TurnOptions = {
      cwd: workspace.cwd,
      model: settings.model.trim(),
      developerInstructions: ENHANCE_META_PROMPT,
      ephemeral: true,
      reasoning: "low",
      serviceTier: input.serviceTier ?? plugin.settings.defaultServiceTier,
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
          input.onTurnStarted?.(turnId);
          return turnId;
        },
        interruptTurn: async (threadId, turnId) => await service.interruptTurn(threadId, turnId),
        nativeRefContext: {
          deviceKey: "prompt-enhancer",
          vaultId: workspace.cwd,
          providerEndpoint: providerMode === "custom-api" ? activeApiProvider?.baseUrl : "codex-login"
        }
      }
    });
    const harnessResult = await plugin.runHarnessWithAdapter({
      adapter,
      request: {
        runId,
        sessionId: `${ENHANCE_PROMPT_AGENT_NAME}:${runId}`,
        surface: "chat",
        workflow: "prompt.enhance",
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
          mode: "read-only",
          writableRoots: [],
          requireApproval: true
        },
        resourceSelection: NO_RESOURCES,
        memoryPolicy: {
          enabled: false,
          maxItems: 0
        },
        outputContract: {
          kind: "plain-text"
        }
      }
    });
    return await resolveHarnessText(adapter, runId, harnessResult, settings.timeoutMs, "增强提示词响应超时");
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await service.disconnect().catch(() => undefined);
    await workspace.cleanup().catch(() => undefined);
  }
}

async function runTaskPromptEnhancer(input: RunPromptEnhancerInput & { backend: Exclude<AgentBackendKind, "codex-cli"> }, runId: string): Promise<string> {
  const plugin = input.plugin;
  const enhancer = plugin.settings.promptEnhancer;
  const taskSettings = promptEnhancerTaskSettings(plugin.settings, input.backend);
  const workspace = await createPromptEnhancerRuntimeWorkspace(input.backend);
  const backendAgent = enhancer.agent.trim() || (input.backend === "opencode" ? ENHANCE_PROMPT_AGENT_NAME : "");
  let adapter: AgentAdapter | null = null;
  try {
    adapter = createHarnessAgentAdapter({
      backendId: input.backend,
      settings: taskSettings,
      vaultPath: workspace.cwd,
      nativeRefContext: {
        ...plugin.getNativeExecutionRefContext(input.backend),
        vaultId: workspace.cwd
      },
      task: {
        system: ENHANCE_META_PROMPT,
        timeoutMs: enhancer.timeoutMs,
        tools: NO_TOOLS,
        ...(enhancer.providerId && enhancer.model ? { model: { providerId: enhancer.providerId, modelId: enhancer.model } } : {}),
        ...(backendAgent ? { agent: backendAgent } : {}),
        ...(enhancer.agent.trim() ? { profile: enhancer.agent.trim() } : {}),
        requireDirectAgent: input.backend === "opencode"
      }
    });
    const harnessResult = await withTimeout(plugin.runHarnessWithAdapter({
      adapter,
      request: {
        runId,
        sessionId: `${ENHANCE_PROMPT_AGENT_NAME}:${runId}`,
        surface: "chat",
        workflow: "prompt.enhance",
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
          mode: "read-only",
          writableRoots: [],
          requireApproval: true
        },
        resourceSelection: NO_RESOURCES,
        memoryPolicy: {
          enabled: false,
          maxItems: 0
        },
        outputContract: {
          kind: "plain-text"
        }
      }
    }), enhancer.timeoutMs, "增强提示词响应超时", async () => await adapter?.cancel(runId));
    return await resolveHarnessText(adapter, runId, harnessResult, enhancer.timeoutMs, "增强提示词响应超时");
  } finally {
    await adapter?.dispose().catch(() => undefined);
    await workspace.cleanup().catch(() => undefined);
  }
}

async function resolveHarnessText(adapter: AgentAdapter, runId: string, result: HarnessRunResult, timeoutMs: number, timeoutMessage: string): Promise<string> {
  if (result.status === "completed") return result.outputText ?? "";
  if (result.status === "running") {
    if (typeof adapter.awaitResult !== "function") throw new Error("当前 Agent 不支持异步结果收口");
    const awaited = await withTimeout(
      adapter.awaitResult(runId),
      timeoutMs,
      timeoutMessage,
      async () => await adapter.cancel(runId)
    );
    return agentResultText(awaited);
  }
  throw new Error(result.error || "增强提示词任务失败");
}

function agentResultText(result: AgentRunResult): string {
  if (result.status === "completed") return result.outputText ?? "";
  throw new Error(result.error || (result.status === "cancelled" ? "增强提示词已中断" : "增强提示词任务失败"));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, onTimeout?: () => Promise<void>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      void onTimeout?.().catch(() => undefined);
      reject(new Error(message));
    }, Math.max(1000, timeoutMs));
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      }
    );
  });
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

export function promptEnhancerModelChoices(settings: CodexForObsidianSettings, statusModels: string[] = []): string[] {
  const enhancer = settings.promptEnhancer;
  const provider = enhancer.codexProviderMode === "custom-api" && enhancer.activeApiProviderId
    ? settings.apiProviders.find((item) => item.id === enhancer.activeApiProviderId) ?? null
    : enhancer.codexProviderMode === "default" && settings.providerMode === "custom-api"
      ? getActiveApiProvider(settings)
      : null;
  return Array.from(new Set([
    enhancer.model,
    ...(provider ? getApiProviderModels(provider) : []),
    ...statusModels
  ].map((model) => model.trim()).filter(Boolean)));
}
