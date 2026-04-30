import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";

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

export type SettingsTab = "general" | "providers" | "resources";
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
  workspaceResources: WorkspaceResourceToggles;
  workspaceResourceCache: WorkspaceResourceCache;
  sessions: StoredSession[];
  activeSessionId: string;
}

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  settingsVersion: 6,
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
  return value === "providers" || value === "resources" || value === "general" ? value : DEFAULT_SETTINGS.settingsTab;
}

function normalizeProviderMode(value: any): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
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
