import type { ApiProviderConfig, ApiProviderModelConfig, CodexForObsidianSettings } from "../settings/settings";
import { API_PROVIDER_PRESETS, getApiProviderPreset, normalizeApiProviderBaseUrl, type ApiProviderId } from "../settings/provider-presets";
import { newId } from "./store";

export interface MobileSettings extends Record<string, unknown>, Pick<CodexForObsidianSettings, "customWelcomeEnabled" | "customWelcomeTitle" | "customWelcomeSubtitle"> {
  apiProviders: ApiProviderConfig[];
  activeApiProviderId: string;
  defaultModel: string;
}
export const MOBILE_DEFAULT_WELCOME = {
  title: "让想法，慢慢清晰。",
  subtitle: "聊聊此刻的思考，读一篇笔记，或把今天写下来。"
} as const;
export const mobilePresets = API_PROVIDER_PRESETS.filter(p => p.authMode === "api-key" && (p.apiProtocol === "openai-completions" || p.apiProtocol === "openai-responses"));
export function supportedProvider(p: ApiProviderConfig): boolean {
  return p.authMode !== "oauth" && (p.apiProtocol === "openai-completions" || p.apiProtocol === "openai-responses");
}
export function loadMobileSettings(value: unknown): MobileSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return {
    ...raw,
    // Both desktop and mobile persist the same provider configuration schema.
    apiProviders: Array.isArray(raw?.apiProviders) ? raw.apiProviders as ApiProviderConfig[] : [],
    activeApiProviderId: typeof raw?.activeApiProviderId === "string" ? raw.activeApiProviderId : "",
    defaultModel: typeof raw?.defaultModel === "string" ? raw.defaultModel : "",
    customWelcomeEnabled: raw?.customWelcomeEnabled === true,
    customWelcomeTitle: typeof raw?.customWelcomeTitle === "string" ? raw.customWelcomeTitle : "",
    customWelcomeSubtitle: typeof raw?.customWelcomeSubtitle === "string" ? raw.customWelcomeSubtitle : ""
  };
}
export function mobileModel(id: string, existing?: ApiProviderModelConfig): ApiProviderModelConfig {
  return { input: ["text"], toolCalling: true, reasoning: false, reasoningEnabled: false, contextWindow: 128000, modelMaxTokens: 8192, maxOutputTokens: 4096, metadataSource: "manual", ...existing, id, displayName: existing?.displayName || id };
}
export function mobileProvider(providerId: ApiProviderId): ApiProviderConfig {
  const preset = getApiProviderPreset(providerId);
  return { id: newId(), providerId, runtimeProviderId: preset.runtimeProviderId, apiProtocol: preset.apiProtocol, authMode: "api-key", name: preset.name.split(" / ")[0], baseUrl: preset.baseUrl, models: preset.model ? [mobileModel(preset.model)] : [], defaultModelId: preset.model, apiKey: "" };
}
export function selectedModel(settings: MobileSettings) {
  const provider = settings.apiProviders.find(p => p.id === settings.activeApiProviderId && supportedProvider(p));
  const model = provider?.models.find(m => m.id === settings.defaultModel) ?? provider?.models.find(m => m.id === provider.defaultModelId);
  return provider && model ? { provider, model } : null;
}
export function validateMobileProvider(provider: ApiProviderConfig): void {
  if (!supportedProvider(provider)) throw new Error("手机首版支持 Chat Completions 和 Responses API Key 接口。");
  normalizeApiProviderBaseUrl(provider.baseUrl, provider.apiProtocol);
  if (!provider.apiKey.trim() && provider.providerId !== "ollama") throw new Error("请填写 API Key。");
  if (!provider.models.length || provider.models.some(m => !m.id.trim())) throw new Error("请填写模型 ID。");
}
