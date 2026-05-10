import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";
import {
  DEFAULT_EDITOR_ACTION_MODEL,
  type ArticleUnderstandingCache,
  type ArticleUnderstandingFingerprint,
  type EditorActionModeConfig,
  type EditorActionQualityMode,
  type EditorAiActionConfig,
  type EditorAiActionSettings,
  type EditorAiStyleConfig
} from "../editor-actions/types";
export type { EditorActionModeConfig, EditorActionQualityMode, EditorAiActionConfig, EditorAiActionSettings, EditorAiStyleConfig };

export interface StoredAttachment {
  type: "file" | "image";
  name: string;
  path: string;
}

export interface DiffFileSummary {
  path: string;
  previousPath?: string;
  kind: "add" | "delete" | "update" | "move" | "unknown";
  added: number;
  removed: number;
}

export interface DiffSummary {
  totalFiles: number;
  added: number;
  removed: number;
  files: DiffFileSummary[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  previewText?: string;
  rawRef?: string;
  rawSize?: number;
  rawLines?: number;
  rawTruncatedForPreview?: boolean;
  phase?: string | null;
  itemType?: string;
  runId?: string;
  turnId?: string;
  processKind?: ProcessEventKind;
  title?: string;
  status?: string;
  details?: string;
  diffSummary?: DiffSummary;
  attachments?: StoredAttachment[];
  files?: ProcessFileRef[];
  images?: StoredAttachment[];
  createdAt: number;
}

export interface StoredSession {
  id: string;
  title: string;
  threadId?: string;
  cwd: string;
  messages: ChatMessage[];
  tokenUsage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type SettingsTab = "general" | "providers" | "resources" | "editorActions";
export type ProviderMode = "codex-login" | "custom-api";
export type ResourceManagementTab = "plugins" | "mcp" | "skills";

export interface ApiProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  models: string[];
  apiKey: string;
  queryParams?: Record<string, string>;
}

export interface WorkspaceResourceToggles {
  plugins: Record<string, boolean>;
  mcpServers: Record<string, boolean>;
  skills: Record<string, boolean>;
}

export interface WorkspaceResourceCacheEntry<T> {
  fetchedAt: number;
  items: T[];
  error?: string;
}

export interface WorkspaceResourceCache {
  plugins?: WorkspaceResourceCacheEntry<CodexPluginInfo>;
  mcp?: WorkspaceResourceCacheEntry<McpServerStatus>;
  skills?: WorkspaceResourceCacheEntry<CodexSkill>;
}

export interface CodexForObsidianSettings {
  settingsVersion: number;
  settingsTab: SettingsTab;
  cliPath: string;
  proxyEnabled: boolean;
  proxyUrl: string;
  providerMode: ProviderMode;
  activeApiProviderId: string;
  apiProviders: ApiProviderConfig[];
  mcpEnabled: boolean;
  defaultModel: string;
  defaultReasoning: ReasoningEffort;
  defaultServiceTier: ServiceTierChoice;
  defaultPermission: PermissionMode;
  defaultMode: UiMode;
  autoOpen: boolean;
  showContext: boolean;
  resourceManagementTab: ResourceManagementTab;
  editorActions: EditorAiActionSettings;
  workspaceResources: WorkspaceResourceToggles;
  workspaceResourceCache: WorkspaceResourceCache;
  sessions: StoredSession[];
  activeSessionId: string;
}

const LEGACY_EDITOR_ACTION_PROMPTS: Record<string, string> = {
  rewrite: "请在保持原意的前提下改写选中文字，让表达更清楚、更自然。\n\n选中文字：\n{{selected_text}}\n\n写作风格：{{style}}",
  expand: "请在保持原意的前提下扩写选中文字，补充必要细节、上下文或例子。\n\n选中文字：\n{{selected_text}}\n\n写作风格：{{style}}",
  continue: "请基于选中文字和前后文继续写。不要重复原文，只返回续写候选正文。\n\n选中文字：\n{{selected_text}}\n\n选区前文：\n{{before_context}}\n\n选区后文：\n{{after_context}}\n\n写作风格：{{style}}"
};

const VERSION_9_EDITOR_ACTION_PROMPTS: Record<string, string> = {
  rewrite: [
    "请把选中文字改写成一个明显不同、表达更有质感的版本。",
    "要求：",
    "1. 保留核心事实和真实含义，不编造新信息。",
    "2. 重组句式和表达节奏，不要只替换一两个词，也不要只加语气词。",
    "3. 按写作风格要求重塑语气、画面感和信息重点。",
    "4. 如果原文太平，要主动补足表达张力，但不要夸张油腻。",
    "5. 只返回改写后的候选正文。",
    "",
    "选中文字：",
    "{{selected_text}}",
    "",
    "写作风格：{{style}}"
  ].join("\n"),
  expand: [
    "请把选中文字扩写成信息更完整、读起来更顺的版本。",
    "要求：",
    "1. 保留原意，并围绕原意增加动机、背景、过程、感受或具体细节。",
    "2. 扩写后长度要明显增加，不能只是同义改写。",
    "3. 按写作风格要求调整语气和表达方式。",
    "4. 不要编造硬事实；不确定的信息用更稳妥的表达。",
    "5. 只返回扩写后的候选正文。",
    "",
    "选中文字：",
    "{{selected_text}}",
    "",
    "选区前文：",
    "{{before_context}}",
    "",
    "选区后文：",
    "{{after_context}}",
    "",
    "写作风格：{{style}}"
  ].join("\n"),
  continue: [
    "请基于选中文字和前后文继续写一段自然衔接的内容。",
    "要求：",
    "1. 承接当前语气、主题和叙述方向，不要重复原文。",
    "2. 续写内容要能直接接在选中文字后面。",
    "3. 按写作风格要求增强表达，但不要跑题。",
    "4. 不要总结解释，不要输出多个版本。",
    "5. 只返回续写候选正文。",
    "",
    "选中文字：",
    "{{selected_text}}",
    "",
    "选区前文：",
    "{{before_context}}",
    "",
    "选区后文：",
    "{{after_context}}",
    "",
    "写作风格：{{style}}"
  ].join("\n")
};

const DEFAULT_EDITOR_ACTIONS: EditorAiActionConfig[] = [
  {
    id: "rewrite",
    label: "改写",
    enabled: true,
    promptTemplate: [
      "请把选中文字改写成一个明显不同、表达更有质感的版本。",
      "要求：",
      "1. 保留核心事实和真实含义，不编造新信息。",
      "2. 重组句式和表达节奏，不要只替换一两个词，也不要只加语气词。",
      "3. 按写作风格要求重塑语气、画面感和信息重点。",
      "4. 如果原文太平，要主动补足表达张力，但不要夸张油腻。",
      "5. 只返回改写后的候选正文。"
    ].join("\n")
  },
  {
    id: "expand",
    label: "扩写",
    enabled: true,
    promptTemplate: [
      "请把选中文字扩写成信息更完整、读起来更顺的版本。",
      "要求：",
      "1. 保留原意，并围绕原意增加动机、背景、过程、感受或具体细节。",
      "2. 扩写后长度要明显增加，不能只是同义改写。",
      "3. 按写作风格要求调整语气和表达方式。",
      "4. 不要编造硬事实；不确定的信息用更稳妥的表达。",
      "5. 输出一小段即可，不要写成长文。",
      "6. 只返回扩写后的候选正文。"
    ].join("\n")
  },
  {
    id: "continue",
    label: "续写",
    enabled: true,
    promptTemplate: [
      "请基于选中文字和前后文继续写一段自然衔接的内容。",
      "要求：",
      "1. 承接当前语气、主题和叙述方向，不要重复原文。",
      "2. 续写内容要能直接接在选中文字后面。",
      "3. 按写作风格要求增强表达，但不要跑题。",
      "4. 不要总结解释，不要输出多个版本。",
      "5. 只返回续写候选正文。"
    ].join("\n")
  }
];

const LEGACY_EDITOR_STYLE_INSTRUCTIONS: Record<string, string> = {
  xiaohongshu: "表达更有分享感和吸引力，但不要夸张堆词。"
};

const DEFAULT_EDITOR_STYLES: EditorAiStyleConfig[] = [
  { id: "clear", label: "清楚", instruction: "表达清楚、准确、自然，删掉含糊和绕弯，但保留原文的真实语气。" },
  { id: "formal", label: "正式", instruction: "语气正式、稳重、有条理，适合方案、报告、文档和对外说明。" },
  { id: "casual", label: "口语", instruction: "语气自然、像真实的人在表达，句子更顺口，但不要松散和啰嗦。" },
  { id: "xiaohongshu", label: "小红书", instruction: "生活化、有画面感、有分享欲，适合笔记正文；可以增强情绪和场景，但避免夸张标题党、口水词和虚假承诺。" }
];

export const DEFAULT_EDITOR_ACTION_MODE_CONFIGS: Record<EditorActionQualityMode, EditorActionModeConfig> = {
  fast: {
    mode: "fast",
    label: "快速",
    model: DEFAULT_EDITOR_ACTION_MODEL,
    contextCharsBefore: 500,
    contextCharsAfter: 500
  },
  quality: {
    mode: "quality",
    label: "质量",
    model: "gpt-5.4",
    contextCharsBefore: 1000,
    contextCharsAfter: 1000
  },
  strict: {
    mode: "strict",
    label: "严格",
    model: "gpt-5.5",
    contextCharsBefore: 1500,
    contextCharsAfter: 1500
  }
};

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  settingsVersion: 14,
  settingsTab: "general",
  cliPath: "",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  providerMode: "codex-login",
  activeApiProviderId: "",
  apiProviders: [],
  mcpEnabled: false,
  defaultModel: "gpt-5.5",
  defaultReasoning: "high",
  defaultServiceTier: "fast",
  defaultPermission: "workspace-write",
  defaultMode: "agent",
  autoOpen: false,
  showContext: true,
  resourceManagementTab: "plugins",
  editorActions: {
    enabled: false,
    statusSlotEnabled: true,
    qualityMode: "quality",
    showContextPanel: true,
    model: DEFAULT_EDITOR_ACTION_MODEL,
    defaultStyleId: "clear",
    maxSelectedChars: 4000,
    contextCharsBefore: 300,
    contextCharsAfter: 300,
    timeoutMs: 45000,
    modeConfigs: DEFAULT_EDITOR_ACTION_MODE_CONFIGS,
    articleUnderstandingCache: {},
    summaryCacheEnabled: false,
    summaryCache: {},
    actions: DEFAULT_EDITOR_ACTIONS,
    styles: DEFAULT_EDITOR_STYLES
  },
  workspaceResources: {
    plugins: {},
    mcpServers: {},
    skills: {}
  },
  workspaceResourceCache: {},
  sessions: [],
  activeSessionId: ""
};

export function normalizeSettingsData(data: any): { settings: CodexForObsidianSettings; changed: boolean } {
  const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
  const settings: CodexForObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    settingsTab: normalizeSettingsTab(data?.settingsTab),
    providerMode: normalizeProviderMode(data?.providerMode),
    activeApiProviderId: typeof data?.activeApiProviderId === "string" ? data.activeApiProviderId.trim() : "",
    apiProviders: normalizeApiProviders(data?.apiProviders),
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    editorActions: normalizeEditorActionSettings(data?.editorActions, previousVersion),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: Array.isArray(data?.sessions) ? data.sessions : [],
    activeSessionId: typeof data?.activeSessionId === "string" ? data.activeSessionId : ""
  };

  if (previousVersion < 1) {
    if (!data?.defaultModel) settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    if (data?.defaultReasoning === "high") settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    if (data?.defaultServiceTier === "standard") settings.defaultServiceTier = DEFAULT_SETTINGS.defaultServiceTier;
    settings.proxyEnabled = data?.proxyEnabled !== false;
    settings.proxyUrl = typeof data?.proxyUrl === "string" && data.proxyUrl.trim() ? data.proxyUrl.trim() : DEFAULT_SETTINGS.proxyUrl;
    settings.mcpEnabled = data?.mcpEnabled === true;
  }

  if (previousVersion < 3) {
    if (settings.defaultReasoning === "high" || settings.defaultReasoning === "xhigh") {
      settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    }
    if (settings.defaultServiceTier === "standard") {
      settings.defaultServiceTier = DEFAULT_SETTINGS.defaultServiceTier;
    }
  }

  if (previousVersion < 4) {
    if (!settings.defaultModel || settings.defaultModel === "gpt-5.4" || settings.defaultModel === "gpt-5.4-mini") {
      settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    }
    if (!settings.defaultReasoning || settings.defaultReasoning === "low") {
      settings.defaultReasoning = DEFAULT_SETTINGS.defaultReasoning;
    }
  }

  normalizeApiProviderSelection(settings);
  settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  return { settings, changed: previousVersion !== DEFAULT_SETTINGS.settingsVersion };
}

export function getActiveApiProvider(settings: Pick<CodexForObsidianSettings, "activeApiProviderId" | "apiProviders">): ApiProviderConfig | null {
  return settings.apiProviders.find((provider) => provider.id === settings.activeApiProviderId) ?? null;
}

export function getApiProviderModels(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>): string[] {
  return normalizeModelList([...(provider.models ?? []), provider.model]);
}

export function providerModelLabel(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>): string {
  const models = getApiProviderModels(provider);
  if (!models.length) return "未设置模型";
  return models.length === 1 ? models[0] : `${models[0]} 等 ${models.length} 个`;
}

export function validateApiProvider(provider: Pick<ApiProviderConfig, "name" | "baseUrl" | "model" | "apiKey"> & Partial<Pick<ApiProviderConfig, "models">>): string[] {
  const errors: string[] = [];
  if (!provider.name.trim()) errors.push("名称不能为空");
  if (!provider.baseUrl.trim()) errors.push("Base URL 不能为空");
  if (!getApiProviderModels(provider).length) errors.push("模型不能为空");
  if (!provider.apiKey.trim()) errors.push("API key 不能为空");
  return errors;
}

export function removeApiProvider(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, providerId: string): boolean {
  const index = settings.apiProviders.findIndex((provider) => provider.id === providerId);
  if (index < 0) return false;
  const wasActive = settings.activeApiProviderId === providerId;
  settings.apiProviders.splice(index, 1);
  if (wasActive) {
    const next = settings.apiProviders[Math.min(index, settings.apiProviders.length - 1)];
    settings.activeApiProviderId = next?.id ?? "";
    if (!next) settings.providerMode = "codex-login";
  }
  return true;
}

export function providerConnectionLabel(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">): string {
  if (settings.providerMode !== "custom-api") return "Codex 登录态";
  const provider = getActiveApiProvider(settings);
  return provider ? `自定义 API：${provider.name} · ${providerModelLabel(provider)}` : "自定义 API 未配置";
}

export function ensureModelChoices(models: CodexModel[], ...preferredModels: Array<string | null | undefined>): CodexModel[] {
  const seen = new Set(models.map((item) => item.model));
  const preferred: CodexModel[] = [];
  for (const value of preferredModels) {
    const model = typeof value === "string" ? value.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    preferred.push({ id: model, model, displayName: model });
  }
  return [...preferred, ...models];
}

export function normalizeEditorActionSettings(value: any, previousVersion = DEFAULT_SETTINGS.settingsVersion): EditorAiActionSettings {
  const defaults = DEFAULT_SETTINGS.editorActions;
  const actions = normalizeEditorActionConfigs(value?.actions, defaults.actions, previousVersion);
  const styles = normalizeEditorActionStyles(value?.styles, defaults.styles, previousVersion);
  const defaultStyleId = typeof value?.defaultStyleId === "string" && styles.some((style) => style.id === value.defaultStyleId.trim())
    ? value.defaultStyleId.trim()
    : defaults.defaultStyleId;
  const legacyContextCharsBefore = normalizeEditorActionPerformanceNumber(value?.contextCharsBefore, defaults.contextCharsBefore, 1200, previousVersion, 0, 10000);
  const legacyContextCharsAfter = normalizeEditorActionPerformanceNumber(value?.contextCharsAfter, defaults.contextCharsAfter, 1200, previousVersion, 0, 10000);
  const legacyTimeoutMs = normalizeEditorActionTimeoutMs(value?.timeoutMs, defaults.timeoutMs, previousVersion);
  const hasExistingEditorActionSettings = value && typeof value === "object" && !Array.isArray(value);
  const legacyUpgrade = hasExistingEditorActionSettings && previousVersion < 14;
  const qualityMode = legacyUpgrade ? "fast" : normalizeEditorActionQualityMode(value?.qualityMode, defaults.qualityMode);
  const modeConfigs = normalizeEditorActionModeConfigs(previousVersion < 14 ? null : value?.modeConfigs, defaults.modeConfigs, legacyUpgrade ? {
    model: normalizeText(value?.model, defaults.model),
    contextCharsBefore: legacyContextCharsBefore,
    contextCharsAfter: legacyContextCharsAfter
  } : undefined);
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    statusSlotEnabled: typeof value?.statusSlotEnabled === "boolean" ? value.statusSlotEnabled : defaults.statusSlotEnabled,
    qualityMode,
    showContextPanel: typeof value?.showContextPanel === "boolean" ? value.showContextPanel : defaults.showContextPanel,
    model: normalizeText(value?.model, defaults.model),
    defaultStyleId,
    maxSelectedChars: normalizePositiveInteger(value?.maxSelectedChars, defaults.maxSelectedChars, 200, 20000),
    contextCharsBefore: legacyContextCharsBefore,
    contextCharsAfter: legacyContextCharsAfter,
    timeoutMs: legacyTimeoutMs,
    modeConfigs,
    articleUnderstandingCache: normalizeArticleUnderstandingCache(value?.articleUnderstandingCache, value?.summaryCache, modeConfigs.quality.model),
    summaryCacheEnabled: previousVersion < 13 ? false : (typeof value?.summaryCacheEnabled === "boolean" ? value.summaryCacheEnabled : defaults.summaryCacheEnabled),
    summaryCache: normalizeEditorActionSummaryCache(value?.summaryCache),
    actions,
    styles
  };
}

export function resolveEditorActionModeConfig(settings: EditorAiActionSettings, mode = settings.qualityMode): EditorActionModeConfig {
  return settings.modeConfigs[mode] ?? settings.modeConfigs.quality ?? settings.modeConfigs.fast ?? DEFAULT_EDITOR_ACTION_MODE_CONFIGS.quality;
}

export function normalizeWorkspaceResources(value: any): WorkspaceResourceToggles {
  return {
    plugins: normalizeBooleanMap(value?.plugins),
    mcpServers: normalizeBooleanMap(value?.mcpServers),
    skills: normalizeBooleanMap(value?.skills)
  };
}

export function normalizeWorkspaceResourceCache(value: any): WorkspaceResourceCache {
  return {
    ...(normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) ? { plugins: normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) } : {}),
    ...(normalizeCacheEntry(value?.mcp, normalizeCachedMcp) ? { mcp: normalizeCacheEntry(value?.mcp, normalizeCachedMcp) } : {}),
    ...(normalizeCacheEntry(value?.skills, normalizeCachedSkill) ? { skills: normalizeCacheEntry(value?.skills, normalizeCachedSkill) } : {})
  };
}

function normalizeEditorActionSummaryCache(value: any): EditorAiActionSettings["summaryCache"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.values(value)
    .map((item: any) => {
      const filePath = normalizeText(item?.filePath, "");
      const summary = normalizeText(item?.summary, "");
      const contentHash = normalizeText(item?.contentHash, "");
      if (!filePath || !summary || !contentHash) return null;
      return {
        filePath,
        mtime: normalizeNonNegativeNumber(item?.mtime),
        size: normalizeNonNegativeNumber(item?.size),
        contentHash,
        summary,
        updatedAt: normalizeNonNegativeNumber(item?.updatedAt),
        lastUsedAt: normalizeNonNegativeNumber(item?.lastUsedAt ?? item?.updatedAt)
      };
    })
    .filter((item): item is EditorAiActionSettings["summaryCache"][string] => Boolean(item))
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, 200);
  return Object.fromEntries(entries.map((entry) => [entry.filePath, entry]));
}

function normalizeArticleUnderstandingCache(value: any, legacySummaryCache: any, fallbackModel: string): ArticleUnderstandingCache {
  const direct = normalizeArticleUnderstandingCacheEntries(value);
  if (Object.keys(direct).length) return direct;
  const summaries = Object.values(normalizeEditorActionSummaryCache(legacySummaryCache))
    .map((entry) => ({
      filePath: entry.filePath,
      mtime: entry.mtime,
      size: entry.size,
      contentHash: entry.contentHash,
      model: fallbackModel || DEFAULT_EDITOR_ACTION_MODE_CONFIGS.quality.model,
      mode: "quality" as EditorActionQualityMode,
      understanding: entry.summary,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt
    }))
    .filter((entry) => entry.filePath && entry.understanding)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, 200);
  return Object.fromEntries(summaries.map((entry) => [entry.filePath, entry]));
}

function normalizeArticleUnderstandingCacheEntries(value: any): ArticleUnderstandingCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.values(value)
    .map((item: any) => {
      const filePath = normalizeText(item?.filePath, "");
      const understanding = normalizeText(item?.understanding, "");
      const contentHash = normalizeText(item?.contentHash, "");
      const model = normalizeText(item?.model, DEFAULT_EDITOR_ACTION_MODE_CONFIGS.quality.model);
      const mode = normalizeEditorActionQualityMode(item?.mode, "quality");
      const fingerprint = normalizeArticleUnderstandingFingerprint(item?.fingerprint);
      if (!filePath || !understanding || !contentHash) return null;
      return {
        filePath,
        mtime: normalizeNonNegativeNumber(item?.mtime),
        size: normalizeNonNegativeNumber(item?.size),
        contentHash,
        model,
        mode,
        understanding,
        ...(fingerprint ? { fingerprint } : {}),
        updatedAt: normalizeNonNegativeNumber(item?.updatedAt),
        lastUsedAt: normalizeNonNegativeNumber(item?.lastUsedAt ?? item?.updatedAt)
      };
    })
    .filter((item): item is ArticleUnderstandingCache[string] => Boolean(item))
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, 200);
  return Object.fromEntries(entries.map((entry) => [entry.filePath, entry]));
}

function normalizeArticleUnderstandingFingerprint(value: any): ArticleUnderstandingFingerprint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stableLineHashes = Array.isArray(value.stableLineHashes)
    ? value.stableLineHashes.map((item: any) => normalizeText(item, "")).filter(Boolean).slice(0, 12)
    : [];
  const fingerprint = {
    textLength: normalizeNonNegativeNumber(value.textLength),
    titleHash: normalizeText(value.titleHash, ""),
    firstBlockHash: normalizeText(value.firstBlockHash, ""),
    lastBlockHash: normalizeText(value.lastBlockHash, ""),
    stableLineHashes
  };
  if (!fingerprint.textLength && !fingerprint.titleHash && !fingerprint.firstBlockHash && !fingerprint.lastBlockHash && !stableLineHashes.length) return null;
  return fingerprint;
}

export function resourceEnabled(overrides: Record<string, boolean> | undefined, key: string, sourceEnabled = true): boolean {
  if (!key) return sourceEnabled;
  const override = overrides?.[key];
  return typeof override === "boolean" ? override : sourceEnabled;
}

export function hasResourceOverrides(overrides: Record<string, boolean> | undefined): boolean {
  return Boolean(overrides && Object.keys(overrides).length > 0);
}

export function filterEnabledSkills(skills: CodexSkill[], overrides: Record<string, boolean> | undefined): CodexSkill[] {
  return skills.filter((skill) => resourceEnabled(overrides, skill.path || skill.name, skill.enabled !== false));
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeResourceManagementTab(value: any): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeSettingsTab(value: any): SettingsTab {
  return value === "providers" || value === "resources" || value === "editorActions" || value === "general" ? value : DEFAULT_SETTINGS.settingsTab;
}

function normalizeProviderMode(value: any): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
}

function normalizeEditorActionConfigs(value: any, defaults: EditorAiActionConfig[], previousVersion: number): EditorAiActionConfig[] {
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const used = new Set<string>();
  const result: EditorAiActionConfig[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    const id = normalizeEditorActionId(item?.id);
    if (!id || used.has(id)) continue;
    const fallback = defaultById.get(id);
    used.add(id);
    const rawPromptTemplate = normalizeText(item?.promptTemplate, fallback?.promptTemplate ?? "{{selected_text}}");
    result.push({
      id,
      label: normalizeText(item?.label, fallback?.label ?? id),
      enabled: typeof item?.enabled === "boolean" ? item.enabled : fallback?.enabled ?? true,
      promptTemplate: shouldMigrateEditorActionPrompt(id, rawPromptTemplate, previousVersion) ? fallback?.promptTemplate ?? rawPromptTemplate : rawPromptTemplate
    });
  }
  for (const fallback of defaults) {
    if (used.has(fallback.id)) continue;
    result.push({ ...fallback });
  }
  return result;
}

function normalizeEditorActionStyles(value: any, defaults: EditorAiStyleConfig[], previousVersion: number): EditorAiStyleConfig[] {
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const used = new Set<string>();
  const result: EditorAiStyleConfig[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    const id = normalizeEditorActionId(item?.id);
    if (!id || used.has(id)) continue;
    const fallback = defaultById.get(id);
    used.add(id);
    const rawInstruction = normalizeText(item?.instruction, fallback?.instruction ?? "");
    result.push({
      id,
      label: normalizeText(item?.label, fallback?.label ?? id),
      instruction: shouldMigrateEditorStyleInstruction(id, rawInstruction, previousVersion) ? fallback?.instruction ?? rawInstruction : rawInstruction
    });
  }
  for (const fallback of defaults) {
    if (used.has(fallback.id)) continue;
    result.push({ ...fallback });
  }
  return result;
}

function normalizeEditorActionModeConfigs(
  value: any,
  defaults: Record<EditorActionQualityMode, EditorActionModeConfig>,
  legacyFast?: { model: string; contextCharsBefore: number; contextCharsAfter: number }
): Record<EditorActionQualityMode, EditorActionModeConfig> {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    fast: normalizeEditorActionModeConfig(source.fast, defaults.fast, legacyFast ? {
      model: legacyFast.model || defaults.fast.model,
      contextCharsBefore: legacyFast.contextCharsBefore,
      contextCharsAfter: legacyFast.contextCharsAfter
    } : undefined),
    quality: normalizeEditorActionModeConfig(source.quality, defaults.quality),
    strict: normalizeEditorActionModeConfig(source.strict, defaults.strict)
  };
}

function normalizeEditorActionModeConfig(
  value: any,
  fallback: EditorActionModeConfig,
  overrideFallback?: Partial<Pick<EditorActionModeConfig, "model" | "contextCharsBefore" | "contextCharsAfter">>
): EditorActionModeConfig {
  return {
    mode: fallback.mode,
    label: fallback.label,
    model: normalizeText(value?.model, overrideFallback?.model ?? fallback.model),
    contextCharsBefore: normalizePositiveInteger(value?.contextCharsBefore, overrideFallback?.contextCharsBefore ?? fallback.contextCharsBefore, 0, 10000),
    contextCharsAfter: normalizePositiveInteger(value?.contextCharsAfter, overrideFallback?.contextCharsAfter ?? fallback.contextCharsAfter, 0, 10000)
  };
}

function normalizeEditorActionQualityMode(value: any, fallback: EditorActionQualityMode): EditorActionQualityMode {
  return value === "fast" || value === "quality" || value === "strict" ? value : fallback;
}

function normalizeEditorActionId(value: any): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function shouldMigrateEditorActionPrompt(id: string, value: string, previousVersion: number): boolean {
  if (previousVersion < 8) return LEGACY_EDITOR_ACTION_PROMPTS[id] === value;
  if (previousVersion < 10) return VERSION_9_EDITOR_ACTION_PROMPTS[id] === value;
  return false;
}

function shouldMigrateEditorStyleInstruction(id: string, value: string, previousVersion: number): boolean {
  if (previousVersion >= 8) return false;
  return LEGACY_EDITOR_STYLE_INSTRUCTIONS[id] === value;
}

function normalizeText(value: any, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizePositiveInteger(value: any, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeEditorActionPerformanceNumber(value: any, fallback: number, legacyDefault: number, previousVersion: number, min: number, max: number): number {
  if (previousVersion < 10 && Number(value) === legacyDefault) return fallback;
  return normalizePositiveInteger(value, fallback, min, max);
}

function normalizeEditorActionTimeoutMs(value: any, fallback: number, previousVersion: number): number {
  const number = Number(value);
  if (previousVersion < 13 && (number === 90000 || number === 25000)) return fallback;
  return normalizePositiveInteger(value, fallback, 10000, 300000);
}

function normalizeNonNegativeNumber(value: any): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function normalizeApiProviderSelection(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">): void {
  const active = getActiveApiProvider(settings);
  if (active) return;
  const first = settings.apiProviders[0];
  settings.activeApiProviderId = first?.id ?? "";
  if (settings.providerMode === "custom-api" && !first) settings.providerMode = "codex-login";
}

function normalizeApiProviders(value: any): ApiProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value.map((item, index) => {
    const id = uniqueProviderId(sanitizeProviderId(item?.id, index), usedIds, index);
    usedIds.add(id);
    const queryParams = normalizeQueryParams(item?.queryParams);
    const models = normalizeModelList(Array.isArray(item?.models) ? [...item.models, item?.model] : [item?.model]);
    return {
      id,
      name: typeof item?.name === "string" ? item.name.trim() : "",
      baseUrl: typeof item?.baseUrl === "string" ? item.baseUrl.trim() : "",
      model: models[0] ?? "",
      models,
      apiKey: typeof item?.apiKey === "string" ? item.apiKey.trim() : "",
      ...(Object.keys(queryParams).length ? { queryParams } : {})
    };
  });
}

function normalizeModelList(value: unknown[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value) {
    const model = typeof item === "string" ? item.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function sanitizeProviderId(value: any, index: number): string {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : `provider_${index + 1}`;
}

function uniqueProviderId(id: string, usedIds: Set<string>, index: number): string {
  if (!usedIds.has(id)) return id;
  let next = `provider_${index + 1}`;
  let suffix = 2;
  while (usedIds.has(next)) {
    next = `provider_${index + 1}_${suffix}`;
    suffix += 1;
  }
  return next;
}

function normalizeQueryParams(value: any): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const stringValue = typeof raw === "string" ? raw.trim() : "";
    if (stringValue) result[key] = stringValue;
  }
  return result;
}

function normalizeBooleanMap(value: any): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key === "string" && key.trim() && typeof enabled === "boolean") result[key] = enabled;
  }
  return result;
}

function normalizeCacheEntry<T>(value: any, normalizeItem: (item: any) => T | null): WorkspaceResourceCacheEntry<T> | undefined {
  if (!value || typeof value !== "object" || !Array.isArray(value.items)) return undefined;
  const items = value.items.map(normalizeItem).filter((item): item is T => Boolean(item));
  const fetchedAt = typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : Date.now();
  const error = typeof value.error === "string" && value.error.trim() ? value.error : "";
  return { fetchedAt, items, ...(error ? { error } : {}) };
}

function normalizeCachedPlugin(item: any): CodexPluginInfo | null {
  const id = typeof item?.id === "string" ? item.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof item?.name === "string" ? item.name : id,
    displayName: typeof item?.displayName === "string" ? item.displayName : id,
    description: typeof item?.description === "string" ? item.description : "",
    marketplace: typeof item?.marketplace === "string" ? item.marketplace : "",
    category: typeof item?.category === "string" ? item.category : "",
    installed: item?.installed !== false,
    enabled: item?.enabled !== false
  };
}

function normalizeCachedSkill(item: any): CodexSkill | null {
  const name = typeof item?.name === "string" ? item.name : "";
  const path = typeof item?.path === "string" ? item.path : "";
  if (!name || !path) return null;
  return {
    name,
    path,
    description: typeof item?.description === "string" ? item.description : "",
    scope: typeof item?.scope === "string" ? item.scope : "",
    enabled: item?.enabled !== false
  };
}

function normalizeCachedMcp(item: any): McpServerStatus | null {
  const name = typeof item?.name === "string" ? item.name : "";
  if (!name) return null;
  return {
    name,
    tools: item?.tools && typeof item.tools === "object" && !Array.isArray(item.tools) ? item.tools : {},
    resources: Array.isArray(item?.resources) ? item.resources : [],
    resourceTemplates: Array.isArray(item?.resourceTemplates) ? item.resourceTemplates : [],
    authStatus: typeof item?.authStatus === "string" ? item.authStatus : "unknown"
  };
}
