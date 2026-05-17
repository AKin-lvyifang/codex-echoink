import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";
import type { AgentModelInfo, AgentProfileInfo } from "../agent/types";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE, LEGACY_CLAUDE_RULES_FILE } from "../knowledge-base/constants";
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

export type StoredSessionKind = "chat" | "knowledge-base";
export const KNOWLEDGE_BASE_SESSION_TITLE = "知识库管理";

export interface StoredSession {
  id: string;
  title: string;
  kind?: StoredSessionKind;
  threadId?: string;
  cwd: string;
  messages: ChatMessage[];
  tokenUsage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type SettingsTab = "general" | "providers" | "resources" | "editorActions" | "knowledgeBase" | "review";
export type ProviderMode = "codex-login" | "custom-api";
export type ResourceManagementTab = "plugins" | "mcp" | "skills";
export type AgentBackendMode = "codex-cli" | "opencode";
export type KnowledgeBaseBackendMode = "default" | AgentBackendMode;
export type KnowledgeBaseRunStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type KnowledgeBaseInitStatus = "not-started" | "preview-ready" | "initialized" | "failed";
export type KnowledgeBaseCaptureTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";
export type KnowledgeBaseHealthCheckStatus = "success" | "failed";
export type ReviewReportKind = "knowledge-base" | "agent-chat";
export type ReviewRunStatus = "idle" | "running" | "success" | "failed";
export type ReviewPromptTemplateKey = "productJudgement" | "bugTriage" | "largeFeature" | "reworkPrevention";

export interface OpenCodeSettings {
  cliPath: string;
  serverUrl: string;
  autoStart: boolean;
  hostname: string;
  port: number;
  providerId: string;
  modelId: string;
  agent: string;
  textEnabled: boolean;
  imageEnabled: boolean;
  pdfEnabled: boolean;
  lastConnectedAt: number;
  lastError: string;
}

export interface KnowledgeBaseProcessedSource {
  path: string;
  size: number;
  mtime: number;
  digestedAt: number;
}

export interface KnowledgeBaseHealthHistoryEntry {
  date: string;
  status: KnowledgeBaseHealthCheckStatus;
  at: number;
}

export interface KnowledgeBaseSettings {
  enabled: boolean;
  sessionId: string;
  backend: KnowledgeBaseBackendMode;
  useCustomRulesFile: boolean;
  rulesFilePath: string;
  scheduleEnabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  lastRunAt: number;
  lastRunStatus: KnowledgeBaseRunStatus;
  lastReportPath: string;
  lastError: string;
  lastSummary: string;
  initialization: KnowledgeBaseInitializationSettings;
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  healthHistory: KnowledgeBaseHealthHistoryEntry[];
}

export interface KnowledgeBaseInitializationSettings {
  status: KnowledgeBaseInitStatus;
  initializedAt: number;
  rulesFilePath: string;
  templateVersion: string;
  lastPreviewSummary: string;
}

export interface ReviewReportState {
  lastRunAt: number;
  lastRunStatus: ReviewRunStatus;
  lastRangeKey: string;
  lastMarkdownPath: string;
  lastHtmlPath: string;
  lastError: string;
  lastSummary: string;
}

export type ReviewPromptTemplates = Record<ReviewPromptTemplateKey, string>;

export interface WeeklyReviewSettings {
  enabled: boolean;
  knowledgeBaseEnabled: boolean;
  agentChatEnabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  outputDir: string;
  promptTemplates: ReviewPromptTemplates;
  reports: {
    knowledgeBase: ReviewReportState;
    agentChat: ReviewReportState;
  };
}

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
  agentBackend: AgentBackendMode;
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
  opencode: OpenCodeSettings;
  knowledgeBase: KnowledgeBaseSettings;
  review: WeeklyReviewSettings;
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
  },
  {
    id: "translate",
    label: "翻译成英文",
    enabled: true,
    promptTemplate: [
      "请把选中文字翻译成英文。",
      "要求：",
      "1. 只返回英文译文，不要保留中文原文。",
      "2. 准确保留原文含义、事实、数字、专有名词和语气。",
      "3. 保留 Markdown 结构、链接、列表、加粗、代码片段和换行。",
      "4. 不要解释，不要输出多个版本。",
      "5. 如果原文已有英文，保持自然英文表达，可轻微润色但不要新增信息。"
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

export const DEFAULT_REVIEW_OUTPUT_DIR = "outputs";

export const DEFAULT_REVIEW_PROMPT_TEMPLATES: ReviewPromptTemplates = {
  productJudgement: "先不要实现。\n\n请先判断这个需求是否成立：\n1. 真实目标是什么？\n2. 可能有哪些错误假设？\n3. 哪些部分值得做，哪些不值得做？\n4. 如果要做，验收标准是什么？\n5. 哪些问题必须先确认？",
  bugTriage: "请按 bug 排查方式处理：\n\n1. 先复现或确认现象。\n2. 找到相关代码链路。\n3. 说明根因，不要只猜。\n4. 给修复方案。\n5. 修复后跑验证。\n6. 最后告诉我证据。",
  largeFeature: "这个任务可能会很大。\n\n先拆成：\n1. 产品目标\n2. 用户路径\n3. 技术边界\n4. 风险点\n5. 验收标准\n\n拆完后先给我看，不要直接写代码。",
  reworkPrevention: "在执行前，请先指出：\n1. 这个需求里最可能导致返工的地方。\n2. 哪些判断如果错了，后面会重做。\n3. 你建议先验证哪 3 件事。"
};

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
  settingsVersion: 23,
  settingsTab: "general",
  agentBackend: "codex-cli",
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
  opencode: {
    cliPath: "",
    serverUrl: "",
    autoStart: true,
    hostname: "127.0.0.1",
    port: 4096,
    providerId: "",
    modelId: "",
    agent: "build",
    textEnabled: true,
    imageEnabled: false,
    pdfEnabled: false,
    lastConnectedAt: 0,
    lastError: ""
  },
  knowledgeBase: {
    enabled: false,
    sessionId: "",
    backend: "default",
    useCustomRulesFile: true,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
    scheduleEnabled: false,
    scheduleTime: "09:00",
    catchUpOnStartup: true,
    lastRunAt: 0,
    lastRunStatus: "idle",
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    initialization: {
      status: "not-started",
      initializedAt: 0,
      rulesFilePath: "",
      templateVersion: "v0.5",
      lastPreviewSummary: ""
    },
    processedSources: {},
    healthHistory: []
  },
  review: {
    enabled: false,
    knowledgeBaseEnabled: true,
    agentChatEnabled: true,
    scheduleTime: "21:00",
    catchUpOnStartup: true,
    outputDir: DEFAULT_REVIEW_OUTPUT_DIR,
    promptTemplates: DEFAULT_REVIEW_PROMPT_TEMPLATES,
    reports: {
      knowledgeBase: {
        lastRunAt: 0,
        lastRunStatus: "idle",
        lastRangeKey: "",
        lastMarkdownPath: "",
        lastHtmlPath: "",
        lastError: "",
        lastSummary: ""
      },
      agentChat: {
        lastRunAt: 0,
        lastRunStatus: "idle",
        lastRangeKey: "",
        lastMarkdownPath: "",
        lastHtmlPath: "",
        lastError: "",
        lastSummary: ""
      }
    }
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
    agentBackend: normalizeAgentBackendMode(data?.agentBackend),
    providerMode: normalizeProviderMode(data?.providerMode),
    activeApiProviderId: typeof data?.activeApiProviderId === "string" ? data.activeApiProviderId.trim() : "",
    apiProviders: normalizeApiProviders(data?.apiProviders),
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    editorActions: normalizeEditorActionSettings(data?.editorActions, previousVersion),
    opencode: normalizeOpenCodeSettings(data?.opencode),
    knowledgeBase: normalizeKnowledgeBaseSettings(data?.knowledgeBase),
    review: normalizeReviewSettings(data?.review),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: normalizeStoredSessions(data?.sessions),
    activeSessionId: typeof data?.activeSessionId === "string" ? data.activeSessionId : ""
  };

  if (settings.knowledgeBase.sessionId) {
    const session = settings.sessions.find((item) => item.id === settings.knowledgeBase.sessionId);
    if (session) session.kind = "knowledge-base";
  }

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

export function isKnowledgeBaseSession(session: Pick<StoredSession, "kind" | "title" | "id"> | null | undefined, knowledgeBaseSessionId = ""): boolean {
  if (!session) return false;
  return session.kind === "knowledge-base" || Boolean(knowledgeBaseSessionId && session.id === knowledgeBaseSessionId);
}

export function ensureKnowledgeBaseSession(
  settings: Pick<CodexForObsidianSettings, "sessions" | "knowledgeBase" | "activeSessionId">,
  cwd: string,
  idFactory: () => string = () => newId("session")
): StoredSession {
  let session = settings.sessions.find((item) => isKnowledgeBaseSession(item, settings.knowledgeBase.sessionId));
  if (!session) {
    session = {
      id: idFactory(),
      title: KNOWLEDGE_BASE_SESSION_TITLE,
      kind: "knowledge-base",
      cwd,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    settings.sessions.unshift(session);
  }
  session.kind = "knowledge-base";
  session.title = KNOWLEDGE_BASE_SESSION_TITLE;
  session.cwd = cwd;
  settings.knowledgeBase.sessionId = session.id;
  const currentIndex = settings.sessions.findIndex((item) => item.id === session.id);
  if (currentIndex > 0) {
    settings.sessions.splice(currentIndex, 1);
    settings.sessions.unshift(session);
  }
  return session;
}

export function clearLegacyChatWorkspaceDefaults(
  settings: Pick<CodexForObsidianSettings, "sessions" | "knowledgeBase">,
  vaultPath: string,
  previousVersion: number
): number {
  if (previousVersion >= 21) return 0;
  const normalizedVaultPath = normalizeComparablePath(vaultPath);
  if (!normalizedVaultPath) return 0;

  let changed = 0;
  for (const session of settings.sessions) {
    if (isKnowledgeBaseSession(session, settings.knowledgeBase.sessionId)) continue;
    if (normalizeComparablePath(session.cwd) !== normalizedVaultPath) continue;
    session.cwd = "";
    delete session.threadId;
    delete session.tokenUsage;
    changed += 1;
  }
  return changed;
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

export function getKnowledgeBaseRulesFileChoices(paths: string[]): string[] {
  const seen = new Set<string>();
  for (const item of paths) {
    const raw = String(item ?? "").replace(/\\/g, "/").trim();
    if (raw.split("/").some((part) => part === "..")) continue;
    const clean = normalizeKnowledgeBaseRulesPath(item, "");
    if (!clean || !/\.md$/i.test(clean)) continue;
    seen.add(clean);
  }
  return Array.from(seen).sort((left, right) => {
    const byRank = rulesFileChoiceRank(left) - rulesFileChoiceRank(right);
    return byRank || left.localeCompare(right);
  });
}

export function openCodeModelChoiceValue(model: Pick<AgentModelInfo, "providerId" | "modelId">): string {
  return `${model.providerId}\u0000${model.modelId}`;
}

export function parseOpenCodeModelChoiceValue(value: string): { providerId: string; modelId: string } | null {
  const [providerId, modelId, ...rest] = String(value ?? "").split("\u0000");
  if (rest.length || !providerId?.trim() || !modelId?.trim()) return null;
  return { providerId: providerId.trim(), modelId: modelId.trim() };
}

export function openCodeModelCapabilityLabel(model: Pick<AgentModelInfo, "inputModalities">): string {
  return `文本 ${model.inputModalities.includes("text") ? "✓" : "×"} · 图片 ${model.inputModalities.includes("image") ? "✓" : "×"} · PDF ${model.inputModalities.includes("pdf") ? "✓" : "×"}`;
}

export function openCodeModelChoiceLabel(model: Pick<AgentModelInfo, "displayName" | "providerId" | "modelId" | "inputModalities">): string {
  return `${model.displayName || `${model.providerId}/${model.modelId}`} · ${openCodeModelCapabilityLabel(model)}`;
}

export function openCodeAgentModeLabel(agent: Pick<AgentProfileInfo, "mode">): string {
  if (agent.mode === "primary") return "主 Agent";
  if (agent.mode === "all") return "通用 Agent";
  return "子 Agent";
}

export function openCodeAgentChoiceValue(agent: Pick<AgentProfileInfo, "name">): string {
  return agent.name;
}

export function parseOpenCodeAgentChoiceValue(value: string): string | null {
  const agent = String(value ?? "").trim();
  return agent ? agent : null;
}

export function openCodeAgentChoiceLabel(agent: Pick<AgentProfileInfo, "name" | "mode" | "native">): string {
  return `${agent.name} · ${openCodeAgentModeLabel(agent)}${agent.native ? " · 内置" : ""}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeResourceManagementTab(value: any): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeSettingsTab(value: any): SettingsTab {
  return value === "providers" || value === "resources" || value === "editorActions" || value === "knowledgeBase" || value === "review" || value === "general" ? value : DEFAULT_SETTINGS.settingsTab;
}

function normalizeProviderMode(value: any): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
}

function normalizeAgentBackendMode(value: any): AgentBackendMode {
  return value === "opencode" ? "opencode" : DEFAULT_SETTINGS.agentBackend;
}

function normalizeKnowledgeBaseBackendMode(value: any): KnowledgeBaseBackendMode {
  return value === "codex-cli" || value === "opencode" ? value : "default";
}

function normalizeKnowledgeBaseRunStatus(value: any): KnowledgeBaseRunStatus {
  return value === "running" || value === "success" || value === "failed" || value === "canceled" ? value : "idle";
}

function normalizeReviewRunStatus(value: any): ReviewRunStatus {
  return value === "running" || value === "success" || value === "failed" ? value : "idle";
}

function normalizeKnowledgeBaseInitStatus(value: any): KnowledgeBaseInitStatus {
  return value === "preview-ready" || value === "initialized" || value === "failed" ? value : "not-started";
}

function normalizeKnowledgeBaseRulesPath(value: any, fallback: string): string {
  const raw = normalizeText(value, fallback).replace(/\\/g, "/").trim();
  const withoutLeadingSlash = raw.replace(/^\/+/, "");
  const clean = withoutLeadingSlash
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function rulesFileChoiceRank(value: string): number {
  const upper = value.toUpperCase();
  if (upper === DEFAULT_KNOWLEDGE_BASE_RULES_FILE.toUpperCase()) return 0;
  if (upper === AGENTS_RULES_FILE.toUpperCase()) return 1;
  if (upper === LEGACY_CLAUDE_RULES_FILE.toUpperCase()) return 2;
  return value.includes("/") ? 3 : 2;
}

function normalizeOpenCodeSettings(value: any): OpenCodeSettings {
  const fallback = DEFAULT_SETTINGS.opencode;
  return {
    cliPath: normalizeOptionalText(value?.cliPath),
    serverUrl: normalizeOptionalText(value?.serverUrl),
    autoStart: typeof value?.autoStart === "boolean" ? value.autoStart : fallback.autoStart,
    hostname: normalizeText(value?.hostname, fallback.hostname),
    port: normalizePositiveInteger(value?.port, fallback.port, 1024, 65535),
    providerId: normalizeOptionalText(value?.providerId),
    modelId: normalizeOptionalText(value?.modelId),
    agent: normalizeText(value?.agent, fallback.agent),
    textEnabled: value?.textEnabled !== false,
    imageEnabled: value?.imageEnabled === true,
    pdfEnabled: value?.pdfEnabled === true,
    lastConnectedAt: normalizeNonNegativeNumber(value?.lastConnectedAt),
    lastError: normalizeOptionalText(value?.lastError)
  };
}

function normalizeKnowledgeBaseSettings(value: any): KnowledgeBaseSettings {
  const fallback = DEFAULT_SETTINGS.knowledgeBase;
  return {
    enabled: value?.enabled === true,
    sessionId: normalizeOptionalText(value?.sessionId),
    backend: normalizeKnowledgeBaseBackendMode(value?.backend),
    useCustomRulesFile: value?.useCustomRulesFile === true,
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    scheduleEnabled: value?.scheduleEnabled === true,
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    lastRunAt: normalizeNonNegativeNumber(value?.lastRunAt),
    lastRunStatus: normalizeKnowledgeBaseRunStatus(value?.lastRunStatus),
    lastReportPath: normalizeOptionalText(value?.lastReportPath),
    lastError: normalizeOptionalText(value?.lastError),
    lastSummary: normalizeOptionalText(value?.lastSummary),
    initialization: normalizeKnowledgeBaseInitialization(value?.initialization),
    processedSources: normalizeKnowledgeBaseProcessedSources(value?.processedSources),
    healthHistory: normalizeKnowledgeBaseHealthHistory(value?.healthHistory)
  };
}

function normalizeReviewSettings(value: any): WeeklyReviewSettings {
  const fallback = DEFAULT_SETTINGS.review;
  const outputDir = normalizeReviewOutputDir(value?.outputDir, fallback.outputDir);
  return {
    enabled: false,
    knowledgeBaseEnabled: typeof value?.knowledgeBaseEnabled === "boolean" ? value.knowledgeBaseEnabled : fallback.knowledgeBaseEnabled,
    agentChatEnabled: typeof value?.agentChatEnabled === "boolean" ? value.agentChatEnabled : fallback.agentChatEnabled,
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    outputDir,
    promptTemplates: normalizeReviewPromptTemplates(value?.promptTemplates),
    reports: {
      knowledgeBase: normalizeReviewReportState(value?.reports?.knowledgeBase, outputDir),
      agentChat: normalizeReviewReportState(value?.reports?.agentChat, outputDir)
    }
  };
}

function normalizeReviewReportState(value: any, outputDir = DEFAULT_REVIEW_OUTPUT_DIR): ReviewReportState {
  return {
    lastRunAt: normalizeNonNegativeNumber(value?.lastRunAt),
    lastRunStatus: normalizeReviewRunStatus(value?.lastRunStatus),
    lastRangeKey: normalizeReviewRangeKey(value?.lastRangeKey),
    lastMarkdownPath: normalizeReviewOutputPath(value?.lastMarkdownPath, ".md", outputDir),
    lastHtmlPath: normalizeReviewOutputPath(value?.lastHtmlPath, ".html", outputDir),
    lastError: normalizeOptionalText(value?.lastError),
    lastSummary: normalizeOptionalText(value?.lastSummary)
  };
}

function normalizeReviewPromptTemplates(value: any): ReviewPromptTemplates {
  const fallback = DEFAULT_REVIEW_PROMPT_TEMPLATES;
  return {
    productJudgement: normalizeText(value?.productJudgement, fallback.productJudgement),
    bugTriage: normalizeText(value?.bugTriage, fallback.bugTriage),
    largeFeature: normalizeText(value?.largeFeature, fallback.largeFeature),
    reworkPrevention: normalizeText(value?.reworkPrevention, fallback.reworkPrevention)
  };
}

function normalizeReviewRangeKey(value: any): string {
  const text = normalizeOptionalText(value);
  return /^\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function normalizeReviewOutputDir(value: any, fallback = DEFAULT_REVIEW_OUTPUT_DIR): string {
  const raw = normalizeText(value, fallback).replace(/\\/g, "/").replace(/^\/+/, "");
  const clean = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function normalizeReviewOutputPath(value: any, extension: ".md" | ".html", outputDir = DEFAULT_REVIEW_OUTPUT_DIR): string {
  const raw = normalizeOptionalText(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw.endsWith(extension)) return "";
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  const allowedDirs = Array.from(new Set([outputDir, DEFAULT_REVIEW_OUTPUT_DIR].map((item) => normalizeReviewOutputDir(item)).filter(Boolean)));
  return allowedDirs.some((dir) => raw.startsWith(`${dir}/`)) ? raw : "";
}

function normalizeKnowledgeBaseInitialization(value: any): KnowledgeBaseInitializationSettings {
  const fallback = DEFAULT_SETTINGS.knowledgeBase.initialization;
  return {
    status: normalizeKnowledgeBaseInitStatus(value?.status),
    initializedAt: normalizeNonNegativeNumber(value?.initializedAt),
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    templateVersion: normalizeText(value?.templateVersion, fallback.templateVersion),
    lastPreviewSummary: normalizeOptionalText(value?.lastPreviewSummary)
  };
}

function normalizeStoredSessions(value: any): StoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((session: any): StoredSession | null => {
      const id = normalizeOptionalText(session?.id);
      if (!id) return null;
      const messages = Array.isArray(session?.messages) ? session.messages : [];
      const kind = session?.kind === "knowledge-base" ? "knowledge-base" as const : undefined;
      return {
        id,
        title: normalizeText(session?.title, kind === "knowledge-base" ? KNOWLEDGE_BASE_SESSION_TITLE : "新会话"),
        ...(kind ? { kind } : {}),
        threadId: normalizeOptionalText(session?.threadId) || undefined,
        cwd: normalizeOptionalText(session?.cwd),
        messages,
        tokenUsage: session?.tokenUsage,
        createdAt: normalizeNonNegativeNumber(session?.createdAt),
        updatedAt: normalizeNonNegativeNumber(session?.updatedAt)
      };
    })
    .filter((session): session is StoredSession => Boolean(session));
}

function normalizeKnowledgeBaseProcessedSources(value: any): Record<string, KnowledgeBaseProcessedSource> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([key, item]: [string, any]) => {
      const path = normalizeOptionalText(item?.path || key);
      if (!path) return null;
      return [
        path,
        {
          path,
          size: normalizeNonNegativeNumber(item?.size),
          mtime: normalizeNonNegativeNumber(item?.mtime),
          digestedAt: normalizeNonNegativeNumber(item?.digestedAt)
        }
      ] as const;
    })
    .filter((item): item is readonly [string, KnowledgeBaseProcessedSource] => Boolean(item))
    .sort((left, right) => right[1].digestedAt - left[1].digestedAt)
    .slice(0, 1000);
  return Object.fromEntries(entries);
}

function normalizeKnowledgeBaseHealthHistory(value: any): KnowledgeBaseHealthHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, KnowledgeBaseHealthHistoryEntry>();
  for (const item of value) {
    const date = normalizeOptionalText(item?.date);
    const status = normalizeKnowledgeBaseHealthCheckStatus(item?.status);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) continue;
    byDate.set(date, {
      date,
      status,
      at: normalizeNonNegativeNumber(item?.at)
    });
  }
  return Array.from(byDate.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-90);
}

function normalizeKnowledgeBaseHealthCheckStatus(value: any): KnowledgeBaseHealthCheckStatus | null {
  return value === "success" || value === "failed" ? value : null;
}

export function recordKnowledgeBaseHealthCheck(settings: KnowledgeBaseSettings, status: KnowledgeBaseHealthCheckStatus, at = Date.now()): void {
  const date = formatLocalDateKey(at);
  settings.healthHistory = normalizeKnowledgeBaseHealthHistory([
    ...(settings.healthHistory ?? []).filter((entry) => entry.date !== date),
    { date, status, at }
  ]);
}

function formatLocalDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeScheduleTime(value: any, fallback: string): string {
  const text = normalizeOptionalText(value);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
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

function normalizeOptionalText(value: any): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComparablePath(value: any): string {
  return normalizeOptionalText(value)
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
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
