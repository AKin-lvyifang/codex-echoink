import type { ApiProviderConfig, ApiProviderModelConfig, CodexForObsidianSettings } from "../settings/settings";
import { API_PROVIDER_PRESETS, getApiProviderPreset, normalizeApiProviderBaseUrl, type ApiProviderId } from "../settings/provider-presets";
import { newId } from "./store";
import { DEFAULT_ENGLISH_DIARY_SETTINGS } from "../english-diary/types";
import { normalizeLifestyleSettings } from "../lifestyle/settings";
import { defaultHomeModuleVisibility } from "../home/home-modules";
import { normalizeTodoCompletions } from "../home/todo-completions";
import type { TodoHost, HomeHost } from "../home/home-host";

export interface MobileAppearance {
  appearance: "system" | "light" | "dark";
  largeText: boolean;
  knowledgePaths: Record<"wiki" | "raw" | "inbox", string>;
  reports: Record<"agent" | "knowledge", { period: "7d" | "last-week" | "30d"; schedule: "manual" | "weekly" | "monthly" }>;
}

type MobileHomeSettings = HomeHost["settings"];
export interface MobileSettings extends Record<string, unknown>, MobileHomeSettings, Pick<CodexForObsidianSettings, "customWelcomeEnabled" | "customWelcomeTitle" | "customWelcomeSubtitle" | "resources" | "knowledgeBase" | "review"> {
  apiProviders: ApiProviderConfig[];
  activeApiProviderId: string;
  defaultModel: string;
  mobileUi: MobileAppearance;
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
  const saved = (raw?.mobileUi ?? {}) as Partial<MobileAppearance>;
  return {
    ...raw,
    // Both desktop and mobile persist the same provider configuration schema.
    apiProviders: Array.isArray(raw?.apiProviders) ? raw.apiProviders as ApiProviderConfig[] : [],
    activeApiProviderId: typeof raw?.activeApiProviderId === "string" ? raw.activeApiProviderId : "",
    defaultModel: typeof raw?.defaultModel === "string" ? raw.defaultModel : "",
    customWelcomeEnabled: raw?.customWelcomeEnabled === true,
    customWelcomeTitle: typeof raw?.customWelcomeTitle === "string" ? raw.customWelcomeTitle : "",
    customWelcomeSubtitle: typeof raw?.customWelcomeSubtitle === "string" ? raw.customWelcomeSubtitle : "",
    settingsLanguage: raw?.settingsLanguage === "en" ? "en" : "zh-CN",
    journalDirectory: typeof raw?.journalDirectory === "string" ? raw.journalDirectory : "journal",
    englishDiary: { ...DEFAULT_ENGLISH_DIARY_SETTINGS, ...(raw?.englishDiary as object) },
    lifestyle: normalizeLifestyleSettings(raw?.lifestyle),
    homeModules: { ...defaultHomeModuleVisibility(), ...(raw?.homeModules as object) },
    todos: Array.isArray(raw?.todos) ? raw.todos as TodoHost["settings"]["todos"] : [],
    todoCategories: Array.isArray(raw?.todoCategories) ? raw.todoCategories as TodoHost["settings"]["todoCategories"] : [],
    todoCompletions: normalizeTodoCompletions(raw?.todoCompletions),
    resources: { catalog: [], importedFrom: {}, mcpConnections: {}, lastScannedAt: 0, lastError: "", ...(raw?.resources as object) },
    knowledgeBase: { lastRunAt: 0, lastRunStatus: "idle", lastReportPath: "", lastError: "", lastSummary: "", lastCompletion: "", lastPendingSources: [], lastWarnings: [], initialization: { status: "not-started", initializedAt: 0, templateVersion: "", lastPreviewSummary: "" }, processedSources: {}, healthHistory: [], maintenanceHistory: [], ...(raw?.knowledgeBase as object) },
    review: { enabled: false, knowledgeBaseEnabled: true, agentChatEnabled: true, scheduleTime: "21:00", catchUpOnStartup: true, outputDir: "outputs/reviews", rangeMode: "previous-week", openHtmlAfterRun: false, reports: { knowledgeBase: { lastRangeKey: "" }, agentChat: { lastRangeKey: "" } }, ...(raw?.review as object) },
    mobileUi: { appearance: saved.appearance === "light" || saved.appearance === "dark" ? saved.appearance : "system", largeText: saved.largeText === true,
      knowledgePaths: { wiki: "wiki", raw: "raw", inbox: "inbox", ...saved.knowledgePaths },
      reports: { agent: { period: "7d", schedule: "manual", ...saved.reports?.agent }, knowledge: { period: "7d", schedule: "manual", ...saved.reports?.knowledge } } }
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
