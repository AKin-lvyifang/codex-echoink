import { agentBackendDisplayName } from "../../agent/registry";
import type { AgentBackendKind, AgentTaskInput } from "../../agent/types";
import type { CodexForObsidianSettings } from "../../settings/settings";
import type { NativeExecutionKind, NativeExecutionPersistence } from "../contracts/native-execution";

export interface HarnessBackendRuntimeProfile {
  displayName: string;
  adapterVersion: string;
  thinkingMessage: boolean;
  editorActionThreadPrewarm: boolean;
  deferMessageModelUntilRunResult: boolean;
}

const RUNTIME_PROFILES: Record<AgentBackendKind, HarnessBackendRuntimeProfile> = {
  "codex-cli": {
    displayName: agentBackendDisplayName("codex-cli"),
    adapterVersion: "rich-runtime",
    thinkingMessage: true,
    editorActionThreadPrewarm: true,
    deferMessageModelUntilRunResult: false
  },
  opencode: {
    displayName: agentBackendDisplayName("opencode"),
    adapterVersion: "legacy-runtime",
    thinkingMessage: false,
    editorActionThreadPrewarm: false,
    deferMessageModelUntilRunResult: true
  },
  hermes: {
    displayName: agentBackendDisplayName("hermes"),
    adapterVersion: "legacy-runtime",
    thinkingMessage: false,
    editorActionThreadPrewarm: false,
    deferMessageModelUntilRunResult: false
  }
};

export function harnessBackendRuntimeProfile(backend: AgentBackendKind): HarnessBackendRuntimeProfile {
  return RUNTIME_PROFILES[backend] ?? RUNTIME_PROFILES["codex-cli"];
}

export function harnessBackendDisplayName(backend: AgentBackendKind): string {
  return harnessBackendRuntimeProfile(backend).displayName;
}

export function harnessBackendAdapterVersion(backend: AgentBackendKind): string {
  return harnessBackendRuntimeProfile(backend).adapterVersion;
}

export function harnessBackendUsesThinkingMessage(backend: AgentBackendKind): boolean {
  return harnessBackendRuntimeProfile(backend).thinkingMessage;
}

export function harnessBackendUsesEditorActionThreadPrewarm(backend: AgentBackendKind): boolean {
  return harnessBackendRuntimeProfile(backend).editorActionThreadPrewarm;
}

export function harnessMessageModelId(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind, turnModel?: string): string {
  if (backend === "opencode") {
    return harnessProviderModelId(settings?.opencode?.providerId, settings?.opencode?.modelId, turnModel);
  }
  if (backend === "hermes") {
    return harnessProviderModelId(settings?.agents?.hermes?.providerId, settings?.agents?.hermes?.modelId, turnModel);
  }
  return normalizeOptionalAgentProfile(turnModel)
    || normalizeOptionalAgentProfile(settings?.defaultModel)
    || normalizeOptionalAgentProfile(settings?.agents?.codex?.defaultModel);
}

export function harnessInitialMessageModelId(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind, turnModel?: string): string {
  if (harnessBackendRuntimeProfile(backend).deferMessageModelUntilRunResult) return "";
  return harnessMessageModelId(settings, backend, turnModel);
}

export function harnessMessageProfileId(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind): string {
  if (backend === "opencode") return normalizeOptionalAgentProfile(settings?.opencode?.agent);
  if (backend === "hermes") return normalizeOptionalAgentProfile(settings?.agents?.hermes?.profile);
  return "";
}

export function harnessTaskModel(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind): AgentTaskInput["model"] | undefined {
  if (backend === "opencode") return providerModelForTask(settings?.opencode?.providerId, settings?.opencode?.modelId);
  if (backend === "hermes") return providerModelForTask(settings?.agents?.hermes?.providerId, settings?.agents?.hermes?.modelId);
  return undefined;
}

export function harnessTaskAgent(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind): string | undefined {
  if (backend !== "opencode") return undefined;
  return normalizeOptionalAgentProfile(settings?.opencode?.agent) || undefined;
}

export function harnessTaskProfile(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind): string | undefined {
  if (backend !== "hermes") return undefined;
  return normalizeOptionalAgentProfile(settings?.agents?.hermes?.profile) || undefined;
}

export function harnessEditorActionModel(settings: CodexForObsidianSettings | null | undefined, backend: AgentBackendKind, configuredModel: string): string {
  if (backend === "opencode") return settings?.opencode?.modelId || configuredModel;
  if (backend === "hermes") return settings?.agents?.hermes?.modelId || configuredModel;
  return configuredModel;
}

export function harnessKnowledgeUsesEchoInkToolBridge(backend: AgentBackendKind): boolean {
  return backend !== "codex-cli";
}

export function harnessKnowledgePromptUsesPreparedResources(backend: AgentBackendKind): boolean {
  return backend !== "hermes";
}

export function harnessKnowledgeTaskTimeoutMs(
  backend: AgentBackendKind,
  overrides: { opencodeTaskTimeoutMs?: number; hermesTaskTimeoutMs?: number } | null | undefined
): number | undefined {
  if (backend === "opencode") return overrides?.opencodeTaskTimeoutMs;
  if (backend === "hermes") return overrides?.hermesTaskTimeoutMs;
  return undefined;
}

export function harnessKnowledgeTaskNativeExecutionKind(backend: Exclude<AgentBackendKind, "codex-cli">): NativeExecutionKind {
  return backend === "opencode" ? "session" : "run";
}

export function harnessKnowledgeTaskNativeExecutionPersistence(backend: Exclude<AgentBackendKind, "codex-cli">): NativeExecutionPersistence {
  return backend === "opencode" ? "provider-persistent" : "unknown";
}

export function harnessProviderModelId(providerValue: unknown, modelValue: unknown, turnModel?: string): string {
  const providerId = normalizeOptionalAgentProfile(providerValue);
  const modelId = normalizeOptionalAgentProfile(modelValue);
  if (providerId && modelId) return modelId.startsWith(`${providerId}/`) ? modelId : `${providerId}/${modelId}`;
  return modelId || normalizeOptionalAgentProfile(turnModel);
}

function providerModelForTask(providerValue: unknown, modelValue: unknown): AgentTaskInput["model"] | undefined {
  const providerId = normalizeOptionalAgentProfile(providerValue);
  const modelId = normalizeOptionalAgentProfile(modelValue);
  return providerId && modelId ? { providerId, modelId } : undefined;
}

function normalizeOptionalAgentProfile(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
