import { normalizeEchoInkColorTheme } from "../ui/appearance-theme";
import { DEFAULT_UNDECLARED_TOOL_CALLING, resolveStoredModelToolCalling } from "../settings/provider-model-capabilities";
import { normalizeKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { ApiProviderConfig, ApiProviderModelConfig, CodexForObsidianSettings } from "../settings/settings";
import { API_PROVIDER_PRESETS, getApiProviderPreset, normalizeApiProviderBaseUrl, type ApiProviderId } from "../settings/provider-presets";
import { newId } from "./store";
import { DEFAULT_ENGLISH_DIARY_SETTINGS } from "../english-diary/types";
import { normalizeLifestyleSettings } from "../lifestyle/settings";
import { defaultHomeModuleVisibility } from "../home/home-modules";
import { normalizeTodoCompletions } from "../home/todo-completions";
import type { TodoHost, HomeHost } from "../home/home-host";
import { normalizeAgentRegistry } from "../agents/registry";
import type { AgentRegistry } from "../agents/types";
import { normalizeTavilySettings, type TavilySettings } from "../tools/tavily-settings";

// Input provenance only: normalization must not make a fresh default look persisted.
const registrySources = new WeakMap<MobileSettings, "missing" | "existing" | "invalid">();
export function mobileAgentRegistrySource(settings: MobileSettings): "missing" | "existing" | "invalid" {
  return registrySources.get(settings) ?? "existing";
}

export interface MobileAppearance {
  todoSourcePath?: string;
  appearance: "system" | "light" | "dark";
  largeText: boolean;
  /** Mobile-only opt-outs; absence preserves the existing enabled behavior. */
  moduleEnabled?: Partial<Record<"knowledge-base" | "journal" | "review" | "todos", boolean>>;
  knowledgePaths: Record<"wiki" | "raw" | "inbox", string>;
  reports: Record<"agent" | "knowledge", { period: "7d" | "last-week" | "30d"; schedule: "manual" | "weekly" | "monthly" }>;
}

type MobileHomeSettings = Omit<HomeHost["settings"], "knowledgeBase">;
export interface MobileSettings extends Record<string, unknown>, MobileHomeSettings, Pick<CodexForObsidianSettings, "colorTheme" | "customWelcomeEnabled" | "customWelcomeTitle" | "customWelcomeSubtitle" | "resources" | "knowledgeBase" | "review"> {
  apiProviders: ApiProviderConfig[];
  activeApiProviderId: string;
  defaultModel: string;
  autoOpenHome: boolean;
  mobileUi: MobileAppearance;
  agentRegistry: AgentRegistry;
  tavily: TavilySettings;
  mobileMemory: { dreamEnabled: boolean; dreamRunsPerDay: number; autoArchive: boolean };
}
export const MOBILE_DEFAULT_WELCOME = {
  title: "让想法，慢慢清晰。",
  subtitle: "聊聊此刻的思考，读一篇笔记，或把今天写下来。"
} as const;
export const mobilePresets = API_PROVIDER_PRESETS.filter(p => ["glm", "kimi", "deepseek", "qwen", "qwen-token-plan", "custom"].includes(p.id));
export function supportedProvider(p: ApiProviderConfig): boolean {
  return p.authMode === "api-key" && !["openai-codex", "anthropic", "minimax", "ollama"].includes(p.providerId ?? "")
    && (p.apiProtocol === "openai-completions" || p.apiProtocol === "openai-responses");
}
export function loadMobileSettings(value: unknown): MobileSettings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const saved = (raw?.mobileUi ?? {}) as Partial<MobileAppearance>;
  const savedMemory = (raw?.mobileMemory ?? {}) as { dreamEnabled?: unknown; dreamRunsPerDay?: unknown; autoArchive?: unknown };
  const settings: MobileSettings = {
    ...raw,
    colorTheme: normalizeEchoInkColorTheme(raw?.colorTheme),
    // Both desktop and mobile persist the same provider configuration schema.
    apiProviders: Array.isArray(raw?.apiProviders) ? (raw.apiProviders as ApiProviderConfig[]).map(provider => {
      const models = provider.models.map(model => {
        const toolCalling = resolveStoredModelToolCalling(model);
        return model.toolCalling === toolCalling ? model : { ...model, toolCalling };
      });
      return models.some((model, index) => model !== provider.models[index]) ? { ...provider, models } : provider;
    }) : [],
    activeApiProviderId: typeof raw?.activeApiProviderId === "string" ? raw.activeApiProviderId : "",
    defaultModel: typeof raw?.defaultModel === "string" ? raw.defaultModel : "",
    autoOpenHome: raw?.autoOpenHome === true,
    agentRegistry: normalizeAgentRegistry(raw?.agentRegistry),
    tavily: { ...(raw?.tavily as object), ...normalizeTavilySettings(raw?.tavily) },
    mobileMemory: {
      ...savedMemory, dreamEnabled: savedMemory.dreamEnabled !== false,
      dreamRunsPerDay: typeof savedMemory.dreamRunsPerDay === "number" && Number.isFinite(savedMemory.dreamRunsPerDay)
        ? Math.max(1, Math.min(6, Math.trunc(savedMemory.dreamRunsPerDay))) : 1,
      autoArchive: savedMemory.autoArchive === true
    },
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
    knowledgeBase: { lastRunAt: 0, lastRunStatus: "idle", lastReportPath: "", lastError: "", lastSummary: "", lastCompletion: "", lastPendingSources: [], lastWarnings: [], initialization: { status: "not-started", initializedAt: 0, templateVersion: "", lastPreviewSummary: "" }, processedSources: {}, healthHistory: [], maintenanceHistory: [], ...(raw?.knowledgeBase as object), folderBindings: normalizeKnowledgeFolderBindings((raw?.knowledgeBase as { folderBindings?: unknown } | undefined)?.folderBindings) },
    review: { enabled: false, knowledgeBaseEnabled: true, agentChatEnabled: true, scheduleTime: "21:00", catchUpOnStartup: true, outputDir: "outputs/reviews", rangeMode: "previous-week", openHtmlAfterRun: false, reports: { knowledgeBase: { lastRangeKey: "" }, agentChat: { lastRangeKey: "" } }, ...(raw?.review as object) },
    mobileUi: { ...saved, todoSourcePath: typeof saved.todoSourcePath === "string" && /\.md$/iu.test(saved.todoSourcePath) && !saved.todoSourcePath.startsWith("/") && !saved.todoSourcePath.split("/").some(part => !part || part === "." || part === "..") && !/[\\:]/u.test(saved.todoSourcePath) && ![...saved.todoSourcePath].some(character => character.charCodeAt(0) < 32) ? saved.todoSourcePath : undefined, appearance: saved.appearance === "light" || saved.appearance === "dark" ? saved.appearance : "system", largeText: saved.largeText === true,
      knowledgePaths: { wiki: "wiki", raw: "raw", inbox: "inbox", ...saved.knowledgePaths },
      reports: { ...saved.reports, agent: { period: "7d", schedule: "manual", ...saved.reports?.agent }, knowledge: { period: "7d", schedule: "manual", ...saved.reports?.knowledge } } }
  };
  const registry = raw?.agentRegistry;
  registrySources.set(settings, registry === undefined ? "missing"
    : registry && typeof registry === "object" && !Array.isArray(registry)
      && (registry as Record<string, unknown>).schemaVersion === 1 ? "existing" : "invalid");
  return settings;
}
export function mobileModel(id: string, existing?: ApiProviderModelConfig): ApiProviderModelConfig {
  return { input: ["text"], toolCalling: DEFAULT_UNDECLARED_TOOL_CALLING, reasoning: false, reasoningEnabled: false, contextWindow: 128000, modelMaxTokens: 8192, maxOutputTokens: 4096, metadataSource: "manual", ...existing, id, displayName: existing?.displayName || id };
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
