import { apiProviderHasUsableCredential, getApiProviderModel, type ApiProviderConfig, type ApiProviderModelConfig, type CodexForObsidianSettings } from "../settings/settings";
import { isEchoInkPiReasoningEffortSupported, resolveEchoInkPiReasoningCapabilities } from "../settings/pi-model-catalog";
import { resolveComposerReasoningState } from "../ui/composer-reasoning";
import type { ReasoningEffort } from "../types/app-server";
import type { TurnOptions } from "../ui/turn-options";
import { xiaoechoDesktopModelName } from "../membership/xiaoecho-points";
import type { AgentDefinition, AgentModelPreference } from "./types";

type ModelSettings = Pick<CodexForObsidianSettings, "agentRegistry" | "apiProviders" | "openAICodexCredential">;

/** A usable Agent model; reasoning is present only when the Agent's own choice is legal for this model. */
export interface AgentModelSelection {
  readonly providerSettingsId: string;
  readonly runtimeProviderId: string;
  readonly modelId: string;
  readonly reasoning?: ReasoningEffort;
}

export type AgentReasoningChoices =
  | { readonly kind: "levels" | "toggle"; readonly options: readonly ReasoningEffort[] }
  | { readonly kind: "none" };

export function agentModelPreference(settings: Pick<CodexForObsidianSettings, "agentRegistry">, agentId: string | undefined): AgentModelPreference | undefined {
  return agentId ? settings.agentRegistry.agents.find(agent => agent.id === agentId)?.model : undefined;
}

function reasoningCapabilities(provider: ApiProviderConfig, model: ApiProviderModelConfig) {
  return resolveEchoInkPiReasoningCapabilities(provider.runtimeProviderId, model.id, model);
}

/**
 * Null when the Agent follows the conversation, or its model was removed or signed out;
 * the run then keeps the conversation's own model instead of failing.
 */
export function resolveAgentModelSelection(settings: ModelSettings, agentId: string | undefined): AgentModelSelection | null {
  const preference = agentModelPreference(settings, agentId);
  if (!preference) return null;
  const provider = settings.apiProviders.find(item => item.id === preference.providerSettingsId);
  const model = provider ? getApiProviderModel(provider, preference.modelId) : null;
  if (!provider || !model || !apiProviderHasUsableCredential(provider, settings.openAICodexCredential)) return null;
  const reasoning = preference.reasoning && isEchoInkPiReasoningEffortSupported(reasoningCapabilities(provider, model), preference.reasoning) ? preference.reasoning : undefined;
  return Object.freeze({ providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId, modelId: model.id, ...(reasoning ? { reasoning } : {}) });
}

/** The Agent's effort, else the model's own default exactly as the composer resolves it. */
export function agentSelectionReasoning(settings: Pick<CodexForObsidianSettings, "apiProviders">, selection: AgentModelSelection): ReasoningEffort {
  return selection.reasoning ?? resolveComposerReasoningState(settings, selection.providerSettingsId, selection.modelId)?.effort ?? "none";
}

/** A programmatic turn for this Agent runs on its own model; following Agents keep the given options. */
export function withAgentModel<T extends Pick<TurnOptions, "providerSettingsId" | "runtimeProviderId" | "model" | "reasoning">>(settings: ModelSettings, agentId: string | undefined, options: T): T {
  const selection = resolveAgentModelSelection(settings, agentId);
  return selection ? { ...options, providerSettingsId: selection.providerSettingsId, runtimeProviderId: selection.runtimeProviderId,
    model: selection.modelId, reasoning: agentSelectionReasoning(settings, selection) } : options;
}

/** Multi-level models offer 思考强度, on/off models offer 深度思考, the rest offer nothing. */
export function agentReasoningChoices(provider: ApiProviderConfig, model: ApiProviderModelConfig): AgentReasoningChoices {
  const capabilities = reasoningCapabilities(provider, model);
  if (!capabilities.supported) return { kind: "none" };
  const enabled = capabilities.enabledOptions.map(option => option.effort);
  return {
    kind: capabilities.enabledOptions.every(option => option.display === "toggle") ? "toggle" : "levels",
    options: [...(capabilities.supportsOff ? ["none" as const] : []), ...enabled]
  };
}

/** The editor always stores an explicit effort: the previous one when still legal, else the model's current default. */
export function defaultAgentReasoning(settings: Pick<CodexForObsidianSettings, "apiProviders">, provider: ApiProviderConfig, model: ApiProviderModelConfig, previous?: ReasoningEffort): ReasoningEffort | undefined {
  const choices = agentReasoningChoices(provider, model);
  if (choices.kind === "none") return undefined;
  if (previous && choices.options.includes(previous)) return previous;
  const current = resolveComposerReasoningState(settings, provider.id, model.id)?.effort ?? "none";
  return choices.options.includes(current) ? current : choices.options[choices.options.length - 1];
}

/** Settings list summary: the Agent's own model name, empty when it follows the conversation. */
export function agentModelLabel(settings: Pick<CodexForObsidianSettings, "apiProviders">, agent: Pick<AgentDefinition, "model">): string {
  if (!agent.model) return "";
  const provider = settings.apiProviders.find(item => item.id === agent.model!.providerSettingsId);
  const model = provider ? getApiProviderModel(provider, agent.model.modelId) : null;
  if (!provider || !model) return agent.model.modelId;
  return provider.providerId === "xiaoecho" ? xiaoechoDesktopModelName(provider.providerId, model) : model.displayName || model.id;
}
