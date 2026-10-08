import type {
  ApiProviderConfig,
  ApiProviderModelConfig,
  CodexForObsidianSettings
} from "../settings/settings";
import {
  apiProviderModelHadInvalidStoredReasoningEffort,
  clearApiProviderModelInvalidStoredReasoningEffort
} from "../settings/settings";
import {
  resolveEchoInkPiReasoningCapabilities,
  type EchoInkPiReasoningOption,
  type EchoInkPiReasoningCapabilities
} from "../settings/pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";

export interface ComposerReasoningState {
  readonly provider: ApiProviderConfig;
  readonly model: ApiProviderModelConfig;
  readonly capabilities: Readonly<EchoInkPiReasoningCapabilities>;
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly adjustable: boolean;
  readonly enabledOptions: readonly Readonly<EchoInkPiReasoningOption>[];
  readonly effort: ReasoningEffort;
  readonly status: "valid" | "missing" | "invalid" | "disabled" | "unavailable";
  readonly previousEffort: ReasoningEffort | undefined;
}

export function resolveComposerReasoningState(
  settings: Pick<CodexForObsidianSettings, "apiProviders">,
  providerSettingsId: string,
  modelId: string
): Readonly<ComposerReasoningState> | null {
  const provider = settings.apiProviders.find(
    (candidate) => candidate.id === providerSettingsId
  );
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  if (!provider || !model) return null;
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    provider.runtimeProviderId,
    model.id,
    model
  );
  const supported = capabilities.supported;
  const enabled = supported
    && (!capabilities.supportsOff || model.reasoningEnabled);
  const enabledOptions = capabilities.enabledOptions;
  const adjustable = enabled && enabledOptions.length > 1;
  const previousEffort = model.reasoningEffort;
  const invalidStoredEffort =
    apiProviderModelHadInvalidStoredReasoningEffort(provider.id, model);

  if (!supported || !enabled) {
    return Object.freeze({
      provider,
      model,
      capabilities,
      supported,
      enabled,
      adjustable: false,
      enabledOptions,
      effort: "none",
      status: supported ? "disabled" : "unavailable",
      previousEffort
    });
  }
  if (
    previousEffort
    && !invalidStoredEffort
    && enabledOptions.some((option) => option.effort === previousEffort)
  ) {
    return Object.freeze({
      provider,
      model,
      capabilities,
      supported,
      enabled,
      adjustable,
      enabledOptions,
      effort: previousEffort,
      status: "valid",
      previousEffort
    });
  }
  const effort = capabilities.defaultEffort;
  return Object.freeze({
    provider,
    model,
    capabilities,
    supported,
    enabled,
    adjustable,
    enabledOptions,
    effort: effort ?? "none",
    status: previousEffort || invalidStoredEffort
      ? "invalid"
      : effort ? "missing" : "unavailable",
    previousEffort
  });
}

export function applyComposerReasoningFallback(
  state: Readonly<ComposerReasoningState>
): boolean {
  if (state.status !== "missing" && state.status !== "invalid") return false;
  if (state.effort === "none") return false;
  state.model.reasoningEffort = state.effort;
  clearApiProviderModelInvalidStoredReasoningEffort(
    state.provider.id,
    state.model
  );
  return true;
}
