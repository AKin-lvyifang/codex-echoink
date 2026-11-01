import type {
  ProviderStreams
} from "@earendil-works/pi-ai";
import type { PiAutoOutputLimitPolicy } from "../harness/pi/auto-output-limit";
import {
  apiProviderModelUsesAutoOutputLimit,
  normalizeApiProviderAutoLimits,
  type ApiProviderConfig,
  type CodexForObsidianSettings
} from "../settings/settings";
import {
  PiProviderProtocolDispatcher
} from "../harness/pi/pi-provider-protocol-adapter";
import type {
  ApiProviderId,
  ApiProviderProtocol
} from "../settings/provider-presets";
import {
  isLoopbackApiProviderUrl
} from "../settings/provider-presets";
import {
  createLoopbackOpenAICompletionsAdapter
} from "./loopback-openai-provider-adapter";
import {
  createQwenTokenPlanOpenAICompletionsAdapter
} from "./qwen-token-plan-provider-adapter";

export type ConfiguredPiProviderTransportKind =
  | "default"
  | "loopback"
  | "qwen-token-plan";

export interface ConfiguredPiProviderTransportInput {
  readonly providerId: ApiProviderId;
  readonly runtimeProviderId: string;
  readonly apiProtocol: ApiProviderProtocol;
  readonly baseUrl: string;
}

export function resolveConfiguredPiProviderTransportKind(
  input: ConfiguredPiProviderTransportInput
): ConfiguredPiProviderTransportKind {
  if (isLoopbackApiProviderUrl(input.baseUrl)) return "loopback";
  if (
    input.providerId === "qwen-token-plan"
    && input.apiProtocol === "openai-completions"
  ) {
    return "qwen-token-plan";
  }
  return "default";
}

/** Shared by settings preflight, background text generation and real Pi Chat. */
export function createConfiguredPiProviderProtocolDispatcher(
  input: ConfiguredPiProviderTransportInput,
  adapters: Readonly<{
    loopback?: ProviderStreams;
    qwenTokenPlan?: ProviderStreams;
  }> = {},
  autoOutputLimits?: PiAutoOutputLimitPolicy
): PiProviderProtocolDispatcher {
  switch (resolveConfiguredPiProviderTransportKind(input)) {
    case "loopback":
      return new PiProviderProtocolDispatcher({
        "openai-completions": adapters.loopback
          ?? createLoopbackOpenAICompletionsAdapter()
      }, autoOutputLimits);
    case "qwen-token-plan":
      return new PiProviderProtocolDispatcher({
        "openai-completions": adapters.qwenTokenPlan
          ?? createQwenTokenPlanOpenAICompletionsAdapter()
      }, autoOutputLimits);
    default:
      return new PiProviderProtocolDispatcher({}, autoOutputLimits);
  }
}

/** Bound to one saved connection; no credentials are copied into the policy. */
export function createConfiguredPiAutoOutputLimitPolicy(
  host: { readonly settings: CodexForObsidianSettings; saveSettings(force?: boolean): Promise<void> },
  provider: Pick<ApiProviderConfig, "id" | "baseUrl">,
  modelId: string
): PiAutoOutputLimitPolicy {
  const providerId = provider.id, baseUrl = provider.baseUrl;
  const current = () => {
    const connection = host.settings.apiProviders.find(candidate => candidate.id === providerId && candidate.baseUrl === baseUrl);
    const model = connection?.models.find(candidate => candidate.id === modelId);
    return connection && model && apiProviderModelUsesAutoOutputLimit(connection.providerId ?? "custom", model, connection.runtimeProviderId)
      ? model : undefined;
  };
  return {
    read: model => {
      const target = model.id === modelId ? current() : undefined;
      return target ? target.autoLimits ?? {} : null;
    },
    remember: async (model, limits) => {
      const target = model.id === modelId ? current() : undefined;
      const accepted = normalizeApiProviderAutoLimits(limits);
      if (!target || !accepted) return;
      target.autoLimits = { ...target.autoLimits, ...accepted };
      await host.saveSettings();
    }
  };
}
