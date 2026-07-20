import { createAgentTaskRuntime } from "../../agent/factory";
import { agentBackendDisplayName } from "../../agent/registry";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "../../agent/runtime";
import type { AgentBackendKind, AgentTaskInput } from "../../agent/types";
import type { CodexForObsidianSettings } from "../../settings/settings";
import type { AgentAdapter } from "./adapter";
import type { NativeExecutionRef } from "../contracts/native-execution";
import { CodexRichAgentAdapter, type CodexRichAgentAdapterOptions } from "./adapters/codex-rich-adapter";
import { TaskRuntimeAgentAdapter } from "./adapters/task-runtime-adapter";

type CodexTransportKey = "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "archiveThread";

export type CodexRichAdapterFactoryOptions =
  Omit<CodexRichAgentAdapterOptions, "displayName" | "version" | CodexTransportKey>
  & Partial<Pick<CodexRichAgentAdapterOptions, CodexTransportKey>>;

export type CodexRichAdapterFactory = (
  options: Omit<CodexRichAgentAdapterOptions, CodexTransportKey>
  & Partial<Pick<CodexRichAgentAdapterOptions, CodexTransportKey>>
) => AgentAdapter;

export interface CreateHarnessAgentAdapterInput {
  backendId: string;
  settings: CodexForObsidianSettings;
  vaultPath: string;
  displayName?: string;
  version?: string;
  nativeRefContext?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">;
  codexRich?: CodexRichAdapterFactoryOptions;
  createCodexRichAdapter?: CodexRichAdapterFactory;
  task?: {
    system?: string;
    resources?: PreparedAgentResources;
    toolBridge?: AgentToolBridgeRuntime | null;
    timeoutMs?: number;
    tools?: Record<string, boolean>;
    model?: AgentTaskInput["model"];
    agent?: string;
    profile?: string;
    requireDirectAgent?: boolean;
    requireExactWriteFence?: boolean;
    exactWriteFence?: AgentTaskInput["exactWriteFence"];
    onExactWriteFenceConfigured?: AgentTaskInput["onExactWriteFenceConfigured"];
    abortSignal?: AbortSignal;
    requireNativeRegistrationBeforePrompt?: boolean;
    onRunId?: (
      runId: string,
      native: NativeExecutionRef
    ) => void | Promise<void>;
  };
  adapterFactories?: HarnessAgentAdapterRegistry;
}

export type HarnessAgentAdapterBuilder = (input: CreateHarnessAgentAdapterInput) => AgentAdapter;
export type HarnessAgentAdapterRegistry = Record<string, HarnessAgentAdapterBuilder>;

const DEFAULT_ADAPTER_FACTORIES: HarnessAgentAdapterRegistry = {
  "codex-cli": createCodexRichHarnessAdapter,
  opencode: createTaskRuntimeHarnessAdapter,
  hermes: createTaskRuntimeHarnessAdapter
};

export function createHarnessAgentAdapter(input: CreateHarnessAgentAdapterInput): AgentAdapter {
  const factory = { ...DEFAULT_ADAPTER_FACTORIES, ...input.adapterFactories }[input.backendId];
  if (!factory) throw new Error(`No Harness adapter factory registered for ${input.backendId}.`);
  return factory(input);
}

function createCodexRichHarnessAdapter(input: CreateHarnessAgentAdapterInput): AgentAdapter {
  const displayName = input.displayName ?? agentBackendDisplayName(input.backendId);
  if (!input.codexRich) throw new Error("Codex rich adapter options are required.");
  const factory = input.createCodexRichAdapter ?? ((options) => new CodexRichAgentAdapter(options as CodexRichAgentAdapterOptions));
  return factory({
    displayName,
    version: input.version ?? "rich-runtime",
    ...input.codexRich,
    toolBridge: input.task?.toolBridge ?? null,
    requireExactWriteFence: input.task?.requireExactWriteFence,
    exactWriteFence: input.task?.exactWriteFence,
    onExactWriteFenceConfigured: input.task?.onExactWriteFenceConfigured
  });
}

function createTaskRuntimeHarnessAdapter(input: CreateHarnessAgentAdapterInput): AgentAdapter {
  const displayName = input.displayName ?? agentBackendDisplayName(input.backendId);
  return new TaskRuntimeAgentAdapter({
    backendId: input.backendId,
    displayName,
    version: input.version ?? "legacy-runtime",
    runtime: createAgentTaskRuntime({
      backend: input.backendId as AgentBackendKind,
      settings: input.settings,
      vaultPath: input.vaultPath
    }),
    nativeRefContext: input.nativeRefContext,
    capabilities: "legacy",
    legacyTaskDefaults: input.task
  });
}
