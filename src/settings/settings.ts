import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, ServiceTierChoice, TokenUsage, UiMode } from "../types/app-server";
import type { AgentBackendKind, AgentModelInfo, AgentProfileInfo } from "../agent/types";
import type { CapabilityBackendChoice } from "../agent/registry";
import type { BackendSessionBinding } from "../harness/contracts/run";
import type { NativeCleanupStatus, NativeExecutionRef, NativeLocalCommitStatus } from "../harness/contracts/native-execution";
import type { ContextCompileMode, ContextSyncCursor, SessionContextSnapshot } from "../harness/contracts/context";
import { defaultResourceSettings } from "../resources/registry";
import { normalizeMcpBrokerSettings } from "../resources/mcp-broker";
import { normalizeMcpConnectionRecords } from "../resources/mcp-connections";
import type { EchoInkResourceSettings } from "../resources/types";
import { AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE, LEGACY_CLAUDE_RULES_FILE } from "../knowledge-base/constants";
import { isSyntheticHermesDefaultModel } from "../core/hermes-models";
import type { KnowledgeBaseCitationSummary } from "../knowledge-base/types";
import type { KnowledgeBaseMessageUiPayload } from "../knowledge-base/maintain-report-card";
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
  backendId?: string;
  modelId?: string;
  profileId?: string;
  nativeExecutionIdHash?: string;
  contextMode?: ContextCompileMode;
  contextCompiledThroughMessageId?: string;
  contextSnapshotVersion?: string;
  nativeLeaseId?: string;
  nativeLeaseStatus?: BackendSessionBinding["leaseStatus"];
  nativeLeaseTurnCount?: number;
  nativeLeaseReused?: boolean;
  nativeLocalCommitStatus?: NativeLocalCommitStatus;
  nativeCleanupStatus?: NativeCleanupStatus;
  runTerminalRecoveryPending?: "cancelled" | "failed";
  runTerminalRecovered?: boolean;
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
  citations?: KnowledgeBaseCitationSummary;
  knowledgeBaseUi?: KnowledgeBaseMessageUiPayload;
  attachments?: StoredAttachment[];
  files?: ProcessFileRef[];
  images?: StoredAttachment[];
  createdAt: number;
  completedAt?: number;
}

export type StoredSessionKind = "chat" | "knowledge-base";
export const KNOWLEDGE_BASE_SESSION_TITLE = "知识库管理";

export interface KnowledgeContextBridgeEntry {
  id: string;
  intent: string;
  command: string;
  summary: string;
  sourceMessageId: string;
  citations?: KnowledgeBaseCitationSummary;
  createdAt: number;
  injectedThreadIds: string[];
}

export interface StoredSession {
  id: string;
  title: string;
  kind?: StoredSessionKind;
  threadId?: string;
  backendBindings?: Record<string, BackendSessionBinding>;
  revision?: number;
  contextSnapshot?: SessionContextSnapshot;
  cwd: string;
  messages: ChatMessage[];
  rollingSummary?: {
    text: string;
    updatedAt: number;
  };
  knowledgeContext?: KnowledgeContextBridgeEntry[];
  messagesHiddenBefore?: number;
  historyActiveDate?: string;
  tokenUsage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
}

export type SettingsTab = "agents" | "general" | "providers" | "resources" | "editorActions" | "knowledgeBase" | "review";
export type ProviderMode = "codex-login" | "custom-api";
export type ResourceManagementTab = "plugins" | "mcp" | "skills";
export type AgentBackendMode = AgentBackendKind;
export type KnowledgeBaseBackendMode = "default" | AgentBackendMode;
export type KnowledgeBaseRunStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type KnowledgeBaseInitStatus = "not-started" | "preview-ready" | "initialized" | "failed";
export type KnowledgeBaseCaptureTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";
export type KnowledgeBaseHealthCheckStatus = "success" | "failed";
export type KnowledgeBaseMaintenanceMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox" | "unknown";
export type KnowledgeBaseManagedThreadKind = KnowledgeBaseMaintenanceMode | "ask" | "journal" | "review";
export type KnowledgeBaseManagedThreadArchiveState = "running" | "pending-archive" | "archived" | "archive-failed";
export type ReviewReportKind = "knowledge-base" | "agent-chat";
export type ReviewRunStatus = "idle" | "running" | "success" | "failed";
export type ReviewRangeMode = "previous-week" | "current-week";
export type SettingsLanguage = "zh-CN" | "en";

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

export interface HermesAgentSettings {
  cliPath: string;
  serverUrl: string;
  autoStart: boolean;
  hostname: string;
  port: number;
  profile: string;
  providerId: string;
  modelId: string;
  apiKey: string;
  providerConfigured: boolean;
  lastProviderCheckAt: number;
  lastProviderError: string;
  lastConnectedAt: number;
  lastError: string;
  version: string;
}

export interface CodexAgentSettings {
  cliPath: string;
  proxyEnabled: boolean;
  proxyUrl: string;
  providerMode: ProviderMode;
  activeApiProviderId: string;
  defaultModel: string;
  defaultReasoning: ReasoningEffort;
  defaultServiceTier: ServiceTierChoice;
  defaultPermission: PermissionMode;
  defaultMode: UiMode;
}

export interface AgentSettings {
  defaultBackend: AgentBackendMode;
  codex: CodexAgentSettings;
  opencode: OpenCodeSettings;
  hermes: HermesAgentSettings;
}

export interface CapabilityBackendSettings {
  chatBackend: CapabilityBackendChoice;
  knowledgeBackend: CapabilityBackendChoice;
  editorActionBackend: CapabilityBackendChoice;
}

export interface SetupSettings {
  completedAt: number;
  lastCheckedAt: number;
  dismissedVersion: string;
}

export interface KnowledgeBaseProcessedSource {
  path: string;
  size: number;
  mtime: number;
  fingerprint?: string;
  digestedAt: number;
  reportPath?: string;
  evidencePaths?: string[];
  runId?: string;
  confidence?: "verified" | "repaired";
}

export interface KnowledgeBaseHealthHistoryEntry {
  date: string;
  status: KnowledgeBaseHealthCheckStatus;
  at: number;
}

export interface KnowledgeBaseMaintenanceHistoryEntry extends KnowledgeBaseHealthHistoryEntry {
  mode: KnowledgeBaseMaintenanceMode;
  reportPath: string;
}

export interface KnowledgeBaseManagedThread {
  threadId: string;
  runId: string;
  kind: KnowledgeBaseManagedThreadKind;
  vaultPath: string;
  archiveState: KnowledgeBaseManagedThreadArchiveState;
  createdAt: number;
  settledAt: number;
  archivedAt: number;
  attempts: number;
  lastError: string;
}

export interface KnowledgeBaseSettings {
  enabled: boolean;
  sessionId: string;
  backend: KnowledgeBaseBackendMode;
  useCustomRulesFile: boolean;
  rulesFilePath: string;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  lastRunAt: number;
  lastRunStatus: KnowledgeBaseRunStatus;
  lastScheduledRunAt: number;
  lastScheduledRunStatus: KnowledgeBaseRunStatus;
  lastReportPath: string;
  lastError: string;
  lastSummary: string;
  historyRetentionDays: number;
  managedThreads: Record<string, KnowledgeBaseManagedThread>;
  initialization: KnowledgeBaseInitializationSettings;
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  healthHistory: KnowledgeBaseHealthHistoryEntry[];
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
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

export interface WeeklyReviewSettings {
  enabled: boolean;
  knowledgeBaseEnabled: boolean;
  agentChatEnabled: boolean;
  scheduleTime: string;
  catchUpOnStartup: boolean;
  outputDir: string;
  rangeMode: ReviewRangeMode;
  openHtmlAfterRun: boolean;
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
  settingsLanguage: SettingsLanguage;
  settingsTab: SettingsTab;
  agentBackend: AgentBackendMode;
  agents: AgentSettings;
  capabilities: CapabilityBackendSettings;
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
  autoOpenHome: boolean;
  showContext: boolean;
  setup: SetupSettings;
  resourceManagementTab: ResourceManagementTab;
  editorActions: EditorAiActionSettings;
  opencode: OpenCodeSettings;
  knowledgeBase: KnowledgeBaseSettings;
  review: WeeklyReviewSettings;
  resources: EchoInkResourceSettings;
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
  },
  {
    id: "enhance",
    label: "增强提示词",
    enabled: false,
    promptTemplate: [
      "请将以下「选中文字」视为用户的原始需求，按提示词增强规则改写为更清晰、更具体、更可执行的提示词。",
      "",
      "要求：",
      "1. 保留用户原始目的，不回答问题，不编造新需求。",
      "2. 补齐必要上下文、约束、输出格式和验收标准。",
      "3. 不要建议用户未提及的具体技术。",
      "4. 保持与输入相同的语言，结果控制在约 800 字符内。",
      "5. 只输出增强后的提示词，不输出解释。",
      "",
      "用户原始需求：{{selected_text}}",
      "",
      "文件上下文（仅供参考）：",
      "{{before_context}}",
      "{{after_context}}"
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

const DEFAULT_OPENCODE_SETTINGS: OpenCodeSettings = {
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
};

const DEFAULT_HERMES_AGENT_SETTINGS: HermesAgentSettings = {
  cliPath: "",
  serverUrl: "",
  autoStart: true,
  hostname: "127.0.0.1",
  port: 8642,
  profile: "",
  providerId: "",
  modelId: "",
  apiKey: "",
  providerConfigured: false,
  lastProviderCheckAt: 0,
  lastProviderError: "",
  lastConnectedAt: 0,
  lastError: "",
  version: ""
};

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  settingsVersion: 29,
  settingsLanguage: "zh-CN",
  settingsTab: "agents",
  agentBackend: "codex-cli",
  agents: {
    defaultBackend: "codex-cli",
    codex: {
      cliPath: "",
      proxyEnabled: false,
      proxyUrl: "http://127.0.0.1:7890",
      providerMode: "codex-login",
      activeApiProviderId: "",
      defaultModel: "",
      defaultReasoning: "high",
      defaultServiceTier: "fast",
      defaultPermission: "workspace-write",
      defaultMode: "agent"
    },
    opencode: DEFAULT_OPENCODE_SETTINGS,
    hermes: DEFAULT_HERMES_AGENT_SETTINGS
  },
  capabilities: {
    chatBackend: "default",
    knowledgeBackend: "default",
    editorActionBackend: "default"
  },
  cliPath: "",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  providerMode: "codex-login",
  activeApiProviderId: "",
  apiProviders: [],
  mcpEnabled: false,
  defaultModel: "",
  defaultReasoning: "high",
  defaultServiceTier: "fast",
  defaultPermission: "workspace-write",
  defaultMode: "agent",
  autoOpen: false,
  autoOpenHome: false,
  showContext: true,
  setup: {
    completedAt: 0,
    lastCheckedAt: 0,
    dismissedVersion: ""
  },
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
  opencode: DEFAULT_OPENCODE_SETTINGS,
  knowledgeBase: {
    enabled: false,
    sessionId: "",
    backend: "default",
    useCustomRulesFile: true,
    rulesFilePath: DEFAULT_KNOWLEDGE_BASE_RULES_FILE,
    scheduleTime: "09:00",
    catchUpOnStartup: true,
    lastRunAt: 0,
    lastRunStatus: "idle",
    lastScheduledRunAt: 0,
    lastScheduledRunStatus: "idle",
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    historyRetentionDays: 30,
    managedThreads: {},
    initialization: {
      status: "not-started",
      initializedAt: 0,
      rulesFilePath: "",
      templateVersion: "v0.7",
      lastPreviewSummary: ""
    },
    processedSources: {},
    healthHistory: [],
    maintenanceHistory: []
  },
  review: {
    enabled: false,
    knowledgeBaseEnabled: true,
    agentChatEnabled: true,
    scheduleTime: "21:00",
    catchUpOnStartup: true,
    outputDir: DEFAULT_REVIEW_OUTPUT_DIR,
    rangeMode: "previous-week",
    openHtmlAfterRun: false,
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
  resources: defaultResourceSettings(),
  workspaceResources: {
    plugins: {},
    mcpServers: {},
    skills: {}
  },
  workspaceResourceCache: {},
  sessions: [],
  activeSessionId: ""
};

export function normalizeSettingsData(input: unknown): { settings: CodexForObsidianSettings; changed: boolean } {
  const data = settingsRecord(input) ?? {};
  const agentsData = settingsRecord(data.agents);
  const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
  const normalizedLanguage = normalizeSettingsLanguage(data?.settingsLanguage);
  const normalizedAgentBackend = normalizeAgentBackendMode(data?.agentBackend ?? agentsData?.defaultBackend);
  const normalizedOpenCode = normalizeOpenCodeSettings(data?.opencode ?? agentsData?.opencode);
  const normalizedAgents = normalizeAgentSettings(data?.agents, data, normalizedAgentBackend, normalizedOpenCode);
  const settings: CodexForObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...data,
    settingsLanguage: normalizedLanguage,
    settingsTab: normalizeSettingsTab(data?.settingsTab),
    agentBackend: normalizedAgentBackend,
    agents: normalizedAgents,
    capabilities: normalizeCapabilityBackendSettings(data?.capabilities),
    providerMode: normalizeProviderMode(data?.providerMode),
    autoOpenHome: data?.autoOpenHome === true,
    activeApiProviderId: typeof data?.activeApiProviderId === "string" ? data.activeApiProviderId.trim() : "",
    apiProviders: normalizeApiProviders(data?.apiProviders),
    setup: normalizeSetupSettings(data?.setup),
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    editorActions: normalizeEditorActionSettings(data?.editorActions, previousVersion),
    opencode: normalizedOpenCode,
    knowledgeBase: normalizeKnowledgeBaseSettings(data?.knowledgeBase),
    review: normalizeReviewSettings(data?.review),
    resources: normalizeEchoInkResourceSettings(data?.resources, data?.workspaceResources),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: normalizeStoredSessions(data?.sessions),
    activeSessionId: typeof data?.activeSessionId === "string" ? data.activeSessionId : ""
  };
  syncLegacyAgentFields(settings);

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

  if (previousVersion < 25 && settings.defaultModel === "gpt-5.5") {
    settings.defaultModel = "";
  }

  syncAgentsFromLegacyFields(settings);
  normalizeApiProviderSelection(settings);
  settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  const languageChanged = data?.settingsLanguage !== normalizedLanguage;
  return { settings, changed: previousVersion !== DEFAULT_SETTINGS.settingsVersion || languageChanged };
}

export function getActiveApiProvider(settings: Pick<CodexForObsidianSettings, "activeApiProviderId" | "apiProviders">): ApiProviderConfig | null {
  return settings.apiProviders.find((provider) => provider.id === settings.activeApiProviderId) ?? null;
}

export function getApiProviderModels(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>): string[] {
  return normalizeModelList([...(provider.models ?? []), provider.model]);
}

export function providerModelLabel(provider: Pick<ApiProviderConfig, "model"> & Partial<Pick<ApiProviderConfig, "models">>, language: SettingsLanguage = "zh-CN"): string {
  const models = getApiProviderModels(provider);
  if (!models.length) return language === "en" ? "No model set" : "未设置模型";
  return models.length === 1 ? models[0] : language === "en" ? `${models[0]} + ${models.length - 1} more` : `${models[0]} 等 ${models.length} 个`;
}

export function validateApiProvider(provider: Pick<ApiProviderConfig, "name" | "baseUrl" | "model" | "apiKey"> & Partial<Pick<ApiProviderConfig, "models">>, language: SettingsLanguage = "zh-CN"): string[] {
  const errors: string[] = [];
  if (!provider.name.trim()) errors.push(language === "en" ? "Name is required" : "名称不能为空");
  if (!provider.baseUrl.trim()) errors.push(language === "en" ? "Base URL is required" : "Base URL 不能为空");
  if (!getApiProviderModels(provider).length) errors.push(language === "en" ? "Model is required" : "模型不能为空");
  if (!provider.apiKey.trim()) errors.push(language === "en" ? "API key is required" : "API key 不能为空");
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

export function providerConnectionLabel(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, language: SettingsLanguage = "zh-CN"): string {
  if (settings.providerMode !== "custom-api") return language === "en" ? "Codex login" : "Codex 登录态";
  const provider = getActiveApiProvider(settings);
  if (!provider) return language === "en" ? "Custom API not configured" : "自定义 API 未配置";
  return language === "en" ? `Custom API: ${provider.name} · ${providerModelLabel(provider, language)}` : `自定义 API：${provider.name} · ${providerModelLabel(provider, language)}`;
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

export function normalizeEditorActionSettings(input: unknown, previousVersion = DEFAULT_SETTINGS.settingsVersion): EditorAiActionSettings {
  const value = settingsRecord(input) ?? {};
  const defaults = DEFAULT_SETTINGS.editorActions;
  const actions = normalizeEditorActionConfigs(value?.actions, defaults.actions, previousVersion);
  const styles = normalizeEditorActionStyles(value?.styles, defaults.styles, previousVersion);
  const requestedDefaultStyleId = normalizeOptionalText(value?.defaultStyleId);
  const defaultStyleId = requestedDefaultStyleId && styles.some((style) => style.id === requestedDefaultStyleId)
    ? requestedDefaultStyleId
    : defaults.defaultStyleId;
  const legacyContextCharsBefore = normalizeEditorActionPerformanceNumber(value?.contextCharsBefore, defaults.contextCharsBefore, 1200, previousVersion, 0, 10000);
  const legacyContextCharsAfter = normalizeEditorActionPerformanceNumber(value?.contextCharsAfter, defaults.contextCharsAfter, 1200, previousVersion, 0, 10000);
  const legacyTimeoutMs = normalizeEditorActionTimeoutMs(value?.timeoutMs, defaults.timeoutMs, previousVersion);
  const hasExistingEditorActionSettings = Boolean(settingsRecord(input));
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

export function normalizeWorkspaceResources(input: unknown): WorkspaceResourceToggles {
  const value = settingsRecord(input) ?? {};
  return {
    plugins: normalizeBooleanMap(value?.plugins),
    mcpServers: normalizeBooleanMap(value?.mcpServers),
    skills: normalizeBooleanMap(value?.skills)
  };
}

export function normalizeWorkspaceResourceCache(input: unknown): WorkspaceResourceCache {
  const value = settingsRecord(input) ?? {};
  return {
    ...(normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) ? { plugins: normalizeCacheEntry(value?.plugins, normalizeCachedPlugin) } : {}),
    ...(normalizeCacheEntry(value?.mcp, normalizeCachedMcp) ? { mcp: normalizeCacheEntry(value?.mcp, normalizeCachedMcp) } : {}),
    ...(normalizeCacheEntry(value?.skills, normalizeCachedSkill) ? { skills: normalizeCacheEntry(value?.skills, normalizeCachedSkill) } : {})
  };
}

function normalizeEditorActionSummaryCache(value: unknown): EditorAiActionSettings["summaryCache"] {
  const record = settingsRecord(value);
  if (!record) return {};
  const entries = Object.values(record)
    .map((item: unknown) => {
      const itemRecord = settingsRecord(item) ?? {};
      const filePath = normalizeText(itemRecord.filePath, "");
      const summary = normalizeText(itemRecord.summary, "");
      const contentHash = normalizeText(itemRecord.contentHash, "");
      if (!filePath || !summary || !contentHash) return null;
      return {
        filePath,
        mtime: normalizeNonNegativeNumber(itemRecord.mtime),
        size: normalizeNonNegativeNumber(itemRecord.size),
        contentHash,
        summary,
        updatedAt: normalizeNonNegativeNumber(itemRecord.updatedAt),
        lastUsedAt: normalizeNonNegativeNumber(itemRecord.lastUsedAt ?? itemRecord.updatedAt)
      };
    })
    .filter((item): item is EditorAiActionSettings["summaryCache"][string] => Boolean(item))
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, 200);
  return Object.fromEntries(entries.map((entry) => [entry.filePath, entry]));
}

function normalizeArticleUnderstandingCache(value: unknown, legacySummaryCache: unknown, fallbackModel: string): ArticleUnderstandingCache {
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

function normalizeArticleUnderstandingCacheEntries(value: unknown): ArticleUnderstandingCache {
  const record = settingsRecord(value);
  if (!record) return {};
  const entries = Object.values(record)
    .map((item: unknown) => {
      const itemRecord = settingsRecord(item) ?? {};
      const filePath = normalizeText(itemRecord.filePath, "");
      const understanding = normalizeText(itemRecord.understanding, "");
      const contentHash = normalizeText(itemRecord.contentHash, "");
      const model = normalizeText(itemRecord.model, DEFAULT_EDITOR_ACTION_MODE_CONFIGS.quality.model);
      const mode = normalizeEditorActionQualityMode(itemRecord.mode, "quality");
      const fingerprint = normalizeArticleUnderstandingFingerprint(itemRecord.fingerprint);
      if (!filePath || !understanding || !contentHash) return null;
      return {
        filePath,
        mtime: normalizeNonNegativeNumber(itemRecord.mtime),
        size: normalizeNonNegativeNumber(itemRecord.size),
        contentHash,
        model,
        mode,
        understanding,
        ...(fingerprint ? { fingerprint } : {}),
        updatedAt: normalizeNonNegativeNumber(itemRecord.updatedAt),
        lastUsedAt: normalizeNonNegativeNumber(itemRecord.lastUsedAt ?? itemRecord.updatedAt)
      };
    })
    .filter((item): item is ArticleUnderstandingCache[string] => Boolean(item))
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, 200);
  return Object.fromEntries(entries.map((entry) => [entry.filePath, entry]));
}

function normalizeArticleUnderstandingFingerprint(input: unknown): ArticleUnderstandingFingerprint | null {
  const value = settingsRecord(input);
  if (!value) return null;
  const stableLineHashes = Array.isArray(value.stableLineHashes)
    ? value.stableLineHashes.map((item: unknown) => normalizeText(item, "")).filter(Boolean).slice(0, 12)
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

export function openCodeModelCapabilityLabel(model: Pick<AgentModelInfo, "inputModalities">, language: SettingsLanguage = "zh-CN"): string {
  return language === "en"
    ? `Text ${model.inputModalities.includes("text") ? "✓" : "×"} · Images ${model.inputModalities.includes("image") ? "✓" : "×"} · PDF ${model.inputModalities.includes("pdf") ? "✓" : "×"}`
    : `文本 ${model.inputModalities.includes("text") ? "✓" : "×"} · 图片 ${model.inputModalities.includes("image") ? "✓" : "×"} · PDF ${model.inputModalities.includes("pdf") ? "✓" : "×"}`;
}

export function openCodeModelChoiceLabel(model: Pick<AgentModelInfo, "displayName" | "providerId" | "modelId" | "inputModalities">, language: SettingsLanguage = "zh-CN"): string {
  return `${model.displayName || `${model.providerId}/${model.modelId}`} · ${openCodeModelCapabilityLabel(model, language)}`;
}

export function openCodeAgentModeLabel(agent: Pick<AgentProfileInfo, "mode">, language: SettingsLanguage = "zh-CN"): string {
  if (agent.mode === "primary") return language === "en" ? "Primary agent" : "主 Agent";
  if (agent.mode === "all") return language === "en" ? "Universal agent" : "通用 Agent";
  return language === "en" ? "Subagent" : "子 Agent";
}

export function openCodeAgentChoiceValue(agent: Pick<AgentProfileInfo, "name">): string {
  return agent.name;
}

export function parseOpenCodeAgentChoiceValue(value: string): string | null {
  const agent = String(value ?? "").trim();
  return agent ? agent : null;
}

export function openCodeAgentChoiceLabel(agent: Pick<AgentProfileInfo, "name" | "mode" | "native">, language: SettingsLanguage = "zh-CN"): string {
  return `${agent.name} · ${openCodeAgentModeLabel(agent, language)}${agent.native ? (language === "en" ? " · Built-in" : " · 内置") : ""}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeResourceManagementTab(value: unknown): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeSettingsTab(value: unknown): SettingsTab {
  return value === "agents" || value === "providers" || value === "resources" || value === "editorActions" || value === "knowledgeBase" || value === "review" || value === "general" ? value : DEFAULT_SETTINGS.settingsTab;
}

export function normalizeSettingsLanguage(value: unknown): SettingsLanguage {
  return value === "en" ? "en" : DEFAULT_SETTINGS.settingsLanguage;
}

function normalizeProviderMode(value: unknown): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
}

export function normalizeAgentBackendMode(value: unknown): AgentBackendMode {
  return value === "opencode" || value === "hermes" ? value : DEFAULT_SETTINGS.agentBackend;
}

export function normalizeKnowledgeBaseBackendMode(value: unknown): KnowledgeBaseBackendMode {
  return value === "codex-cli" || value === "opencode" || value === "hermes" ? value : "default";
}

function normalizeCapabilityBackendChoice(value: unknown): CapabilityBackendChoice {
  return value === "codex-cli" || value === "opencode" || value === "hermes" ? value : "default";
}

function normalizeCapabilityBackendSettings(input: unknown): CapabilityBackendSettings {
  const value = settingsRecord(input) ?? {};
  return {
    chatBackend: normalizeCapabilityBackendChoice(value?.chatBackend),
    knowledgeBackend: normalizeCapabilityBackendChoice(value?.knowledgeBackend),
    editorActionBackend: normalizeCapabilityBackendChoice(value?.editorActionBackend)
  };
}

function normalizeKnowledgeBaseRunStatus(value: unknown): KnowledgeBaseRunStatus {
  return value === "running" || value === "success" || value === "failed" || value === "canceled" ? value : "idle";
}

function normalizeReviewRunStatus(value: unknown): ReviewRunStatus {
  return value === "running" || value === "success" || value === "failed" ? value : "idle";
}

function normalizeKnowledgeBaseInitStatus(value: unknown): KnowledgeBaseInitStatus {
  return value === "preview-ready" || value === "initialized" || value === "failed" ? value : "not-started";
}

function normalizeKnowledgeBaseRulesPath(value: unknown, fallback: string): string {
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

function normalizeOpenCodeSettings(input: unknown): OpenCodeSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_OPENCODE_SETTINGS;
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

function normalizeHermesAgentSettings(input: unknown): HermesAgentSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_HERMES_AGENT_SETTINGS;
  const providerId = normalizeOptionalText(value?.providerId);
  const modelId = normalizeOptionalText(value?.modelId);
  const hasSyntheticDefault = isSyntheticHermesDefaultModel(providerId, modelId);
  return {
    cliPath: normalizeOptionalText(value?.cliPath),
    serverUrl: normalizeOptionalText(value?.serverUrl).replace(/\/$/, ""),
    autoStart: typeof value?.autoStart === "boolean" ? value.autoStart : fallback.autoStart,
    hostname: normalizeText(value?.hostname, fallback.hostname),
    port: normalizePositiveInteger(value?.port, fallback.port, 1024, 65535),
    profile: normalizeOptionalText(value?.profile),
    providerId: hasSyntheticDefault ? "" : providerId,
    modelId: hasSyntheticDefault ? "" : modelId,
    apiKey: normalizeOptionalText(value?.apiKey),
    providerConfigured: hasSyntheticDefault ? false : value?.providerConfigured === true,
    lastProviderCheckAt: hasSyntheticDefault ? 0 : normalizeNonNegativeNumber(value?.lastProviderCheckAt),
    lastProviderError: hasSyntheticDefault ? "" : normalizeOptionalText(value?.lastProviderError),
    lastConnectedAt: normalizeNonNegativeNumber(value?.lastConnectedAt),
    lastError: normalizeOptionalText(value?.lastError),
    version: normalizeOptionalText(value?.version)
  };
}

function normalizeCodexAgentSettings(agentValue: unknown, legacy: unknown): CodexAgentSettings {
  const agent = settingsRecord(agentValue) ?? {};
  const legacyRecord = settingsRecord(legacy) ?? {};
  const proxyEnabled = agent.proxyEnabled ?? legacyRecord.proxyEnabled;
  const fallback = DEFAULT_SETTINGS.agents.codex;
  return {
    cliPath: normalizeOptionalText(agent.cliPath ?? legacyRecord.cliPath),
    proxyEnabled: typeof proxyEnabled === "boolean" ? proxyEnabled : fallback.proxyEnabled,
    proxyUrl: normalizeText(agent.proxyUrl ?? legacyRecord.proxyUrl, fallback.proxyUrl),
    providerMode: normalizeProviderMode(agent.providerMode ?? legacyRecord.providerMode),
    activeApiProviderId: normalizeOptionalText(agent.activeApiProviderId ?? legacyRecord.activeApiProviderId),
    defaultModel: normalizeOptionalText(agent.defaultModel ?? legacyRecord.defaultModel),
    defaultReasoning: normalizeReasoningEffort(agent.defaultReasoning ?? legacyRecord.defaultReasoning, fallback.defaultReasoning),
    defaultServiceTier: normalizeServiceTierChoice(agent.defaultServiceTier ?? legacyRecord.defaultServiceTier, fallback.defaultServiceTier),
    defaultPermission: normalizePermissionMode(agent.defaultPermission ?? legacyRecord.defaultPermission, fallback.defaultPermission),
    defaultMode: normalizeUiMode(agent.defaultMode ?? legacyRecord.defaultMode, fallback.defaultMode)
  };
}

function normalizeAgentSettings(value: unknown, legacy: unknown, defaultBackend: AgentBackendMode, opencode: OpenCodeSettings): AgentSettings {
  const record = settingsRecord(value) ?? {};
  const legacyRecord = settingsRecord(legacy) ?? {};
  return {
    defaultBackend,
    codex: normalizeCodexAgentSettings(record.codex, legacy),
    opencode,
    hermes: normalizeHermesAgentSettings(record.hermes ?? legacyRecord.hermes)
  };
}

function syncLegacyAgentFields(settings: CodexForObsidianSettings): void {
  settings.agentBackend = settings.agents.defaultBackend;
  settings.cliPath = settings.agents.codex.cliPath;
  settings.proxyEnabled = settings.agents.codex.proxyEnabled;
  settings.proxyUrl = settings.agents.codex.proxyUrl;
  settings.providerMode = settings.agents.codex.providerMode;
  settings.activeApiProviderId = settings.agents.codex.activeApiProviderId;
  settings.defaultModel = settings.agents.codex.defaultModel;
  settings.defaultReasoning = settings.agents.codex.defaultReasoning;
  settings.defaultServiceTier = settings.agents.codex.defaultServiceTier;
  settings.defaultPermission = settings.agents.codex.defaultPermission;
  settings.defaultMode = settings.agents.codex.defaultMode;
  settings.opencode = settings.agents.opencode;
}

function syncAgentsFromLegacyFields(settings: CodexForObsidianSettings): void {
  settings.agents.defaultBackend = settings.agentBackend;
  settings.agents.codex = {
    cliPath: settings.cliPath,
    proxyEnabled: settings.proxyEnabled,
    proxyUrl: settings.proxyUrl,
    providerMode: settings.providerMode,
    activeApiProviderId: settings.activeApiProviderId,
    defaultModel: settings.defaultModel,
    defaultReasoning: settings.defaultReasoning,
    defaultServiceTier: settings.defaultServiceTier,
    defaultPermission: settings.defaultPermission,
    defaultMode: settings.defaultMode
  };
  settings.agents.opencode = settings.opencode;
}

function normalizeEchoInkResourceSettings(value: unknown, legacyWorkspaceResources: unknown): EchoInkResourceSettings {
  const record = settingsRecord(value) ?? {};
  const fallback = defaultResourceSettings();
  const enabledByScope = settingsRecord(record.enabledByScope) ?? {};
  const importedFrom = settingsRecord(record.importedFrom);
  const legacy = normalizeWorkspaceResources(legacyWorkspaceResources);
  return {
    catalog: Array.isArray(record.catalog) ? record.catalog.filter(isEchoInkResourceLike) : [],
    enabledByScope: {
      chat: normalizeBooleanMap(enabledByScope.chat),
      knowledge: {
        ...normalizeBooleanMap(enabledByScope.knowledge),
        ...Object.fromEntries(Object.entries(legacy.skills).map(([key, enabled]) => [`codex-import:skill:${resourceSlugFromLegacyKey(key)}`, enabled])),
        ...Object.fromEntries(Object.entries(legacy.mcpServers).map(([key, enabled]) => [`codex-import:mcp-server:${resourceSlugFromLegacyKey(key)}`, enabled]))
      },
      "editor-actions": normalizeBooleanMap(enabledByScope["editor-actions"])
    },
    importedFrom: importedFrom
      ? Object.fromEntries(Object.entries(importedFrom).map(([key, raw]) => [key, normalizeNonNegativeNumber(raw)]))
      : fallback.importedFrom,
    mcpBroker: normalizeMcpBrokerSettings(record.mcpBroker ?? fallback.mcpBroker),
    mcpConnections: normalizeMcpConnectionRecords(record.mcpConnections ?? fallback.mcpConnections),
    lastScannedAt: normalizeNonNegativeNumber(record.lastScannedAt),
    lastError: normalizeOptionalText(record.lastError)
  };
}

function resourceSlugFromLegacyKey(value: string): string {
  const basename = String(value ?? "").split(/[\\/]/).filter(Boolean).pop() ?? value;
  return basename
    .replace(/\.md$/i, "")
    .replace(/^SKILL$/i, String(value ?? "").split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? "skill")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "resource";
}

function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort): ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : fallback;
}

function normalizeServiceTierChoice(value: unknown, fallback: ServiceTierChoice): ServiceTierChoice {
  return value === "standard" || value === "fast" || value === "flex" ? value : fallback;
}

function normalizePermissionMode(value: unknown, fallback: PermissionMode): PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : fallback;
}

function normalizeUiMode(value: unknown, fallback: UiMode): UiMode {
  return value === "agent" || value === "plan" ? value : fallback;
}

function normalizeSetupSettings(input: unknown): SetupSettings {
  const value = settingsRecord(input) ?? {};
  return {
    completedAt: normalizeNonNegativeNumber(value?.completedAt),
    lastCheckedAt: normalizeNonNegativeNumber(value?.lastCheckedAt),
    dismissedVersion: normalizeOptionalText(value?.dismissedVersion)
  };
}

function normalizeKnowledgeBaseSettings(input: unknown): KnowledgeBaseSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.knowledgeBase;
  const legacyScheduleEnabled = typeof value?.scheduleEnabled === "boolean" ? value.scheduleEnabled : true;
  return {
    enabled: value?.enabled === true && legacyScheduleEnabled !== false,
    sessionId: normalizeOptionalText(value?.sessionId),
    backend: normalizeKnowledgeBaseBackendMode(value?.backend),
    useCustomRulesFile: value?.useCustomRulesFile === true,
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    lastRunAt: normalizeNonNegativeNumber(value?.lastRunAt),
    lastRunStatus: normalizeKnowledgeBaseRunStatus(value?.lastRunStatus),
    lastScheduledRunAt: normalizeNonNegativeNumber(value?.lastScheduledRunAt),
    lastScheduledRunStatus: normalizeKnowledgeBaseRunStatus(value?.lastScheduledRunStatus),
    lastReportPath: normalizeOptionalText(value?.lastReportPath),
    lastError: normalizeOptionalText(value?.lastError),
    lastSummary: normalizeOptionalText(value?.lastSummary),
    historyRetentionDays: normalizeKnowledgeBaseHistoryRetentionDays(value?.historyRetentionDays, fallback.historyRetentionDays),
    managedThreads: normalizeKnowledgeBaseManagedThreads(value?.managedThreads),
    initialization: normalizeKnowledgeBaseInitialization(value?.initialization),
    processedSources: normalizeKnowledgeBaseProcessedSources(value?.processedSources),
    healthHistory: normalizeKnowledgeBaseHealthHistory(value?.healthHistory),
    maintenanceHistory: normalizeKnowledgeBaseMaintenanceHistory(value?.maintenanceHistory, value?.healthHistory)
  };
}

function normalizeReviewSettings(input: unknown): WeeklyReviewSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.review;
  const outputDir = normalizeReviewOutputDir(value?.outputDir, fallback.outputDir);
  const reports = settingsRecord(value?.reports) ?? {};
  return {
    enabled: false,
    knowledgeBaseEnabled: typeof value?.knowledgeBaseEnabled === "boolean" ? value.knowledgeBaseEnabled : fallback.knowledgeBaseEnabled,
    agentChatEnabled: typeof value?.agentChatEnabled === "boolean" ? value.agentChatEnabled : fallback.agentChatEnabled,
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    outputDir,
    rangeMode: normalizeReviewRangeMode(value?.rangeMode, fallback.rangeMode),
    openHtmlAfterRun: value?.openHtmlAfterRun === true,
    reports: {
      knowledgeBase: normalizeReviewReportState(reports.knowledgeBase, outputDir),
      agentChat: normalizeReviewReportState(reports.agentChat, outputDir)
    }
  };
}

function normalizeReviewReportState(input: unknown, outputDir = DEFAULT_REVIEW_OUTPUT_DIR): ReviewReportState {
  const value = settingsRecord(input) ?? {};
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

function normalizeReviewRangeMode(value: unknown, fallback: ReviewRangeMode): ReviewRangeMode {
  return value === "current-week" || value === "previous-week" ? value : fallback;
}

function normalizeReviewRangeKey(value: unknown): string {
  const text = normalizeOptionalText(value);
  return /^\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function normalizeReviewOutputDir(value: unknown, fallback = DEFAULT_REVIEW_OUTPUT_DIR): string {
  const raw = normalizeText(value, fallback).replace(/\\/g, "/").replace(/^\/+/, "");
  const clean = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function normalizeReviewOutputPath(value: unknown, extension: ".md" | ".html", outputDir = DEFAULT_REVIEW_OUTPUT_DIR): string {
  const raw = normalizeOptionalText(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw.endsWith(extension)) return "";
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return "";
  const allowedDirs = Array.from(new Set([outputDir, DEFAULT_REVIEW_OUTPUT_DIR].map((item) => normalizeReviewOutputDir(item)).filter(Boolean)));
  return allowedDirs.some((dir) => raw.startsWith(`${dir}/`)) ? raw : "";
}

function normalizeKnowledgeBaseInitialization(input: unknown): KnowledgeBaseInitializationSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.knowledgeBase.initialization;
  return {
    status: normalizeKnowledgeBaseInitStatus(value?.status),
    initializedAt: normalizeNonNegativeNumber(value?.initializedAt),
    rulesFilePath: normalizeKnowledgeBaseRulesPath(value?.rulesFilePath, fallback.rulesFilePath),
    templateVersion: normalizeText(value?.templateVersion, fallback.templateVersion),
    lastPreviewSummary: normalizeOptionalText(value?.lastPreviewSummary)
  };
}

function normalizeStoredSessions(value: unknown): StoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rawSession: unknown): StoredSession | null => {
      const session = settingsRecord(rawSession) ?? {};
      const id = normalizeOptionalText(session.id);
      if (!id) return null;
      const messages = normalizeChatMessages(session.messages);
      const kind = session.kind === "knowledge-base" ? "knowledge-base" as const : undefined;
      const legacyThreadId = normalizeOptionalText(session.threadId) || undefined;
      return {
        id,
        title: normalizeText(session.title, kind === "knowledge-base" ? KNOWLEDGE_BASE_SESSION_TITLE : "新会话"),
        ...(kind ? { kind } : {}),
        threadId: legacyThreadId,
        backendBindings: normalizeBackendSessionBindings(session.backendBindings, legacyThreadId),
        revision: normalizeSessionRevision(session.revision),
        contextSnapshot: normalizeSessionContextSnapshot(session.contextSnapshot, id),
        cwd: normalizeOptionalText(session.cwd),
        messages,
        rollingSummary: normalizeSessionSummary(session.rollingSummary),
        knowledgeContext: normalizeKnowledgeContextBridgeEntries(session.knowledgeContext),
        messagesHiddenBefore: normalizeOptionalPositiveNumber(session.messagesHiddenBefore),
        historyActiveDate: normalizeOptionalText(session.historyActiveDate) || undefined,
        tokenUsage: session.tokenUsage as TokenUsage,
        createdAt: normalizeNonNegativeNumber(session.createdAt),
        updatedAt: normalizeNonNegativeNumber(session.updatedAt)
      };
    })
    .filter((session): session is StoredSession => Boolean(session));
}

function normalizeChatMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw: unknown): ChatMessage | null => {
      const item = settingsRecord(raw);
      if (!item) return null;
      const id = normalizeOptionalText(item.id);
      const role = normalizeChatMessageRole(item.role);
      if (!id || !role) return null;
      const message = { ...item, id, role } as unknown as ChatMessage;
      message.text = typeof item.text === "string" ? item.text : "";
      assignOptionalText(message, "backendId", item.backendId);
      assignOptionalText(message, "modelId", item.modelId ?? item.model);
      assignOptionalText(message, "profileId", item.profileId ?? item.profile);
      assignOptionalText(message, "nativeExecutionIdHash", item.nativeExecutionIdHash);
      assignOptionalText(message, "contextCompiledThroughMessageId", item.contextCompiledThroughMessageId);
      assignOptionalText(message, "contextSnapshotVersion", item.contextSnapshotVersion);
      assignOptionalText(message, "nativeLeaseId", item.nativeLeaseId);
      message.contextMode = normalizeContextCompileMode(item.contextMode);
      message.nativeLeaseStatus = normalizeNativeLeaseStatus(item.nativeLeaseStatus);
      message.nativeLocalCommitStatus = normalizeNativeLocalCommitStatus(item.nativeLocalCommitStatus);
      message.nativeCleanupStatus = normalizeNativeCleanupStatus(item.nativeCleanupStatus);
      message.runTerminalRecoveryPending = normalizeRunTerminalRecoveryPending(item.runTerminalRecoveryPending);
      message.nativeLeaseTurnCount = normalizeOptionalPositiveNumber(item.nativeLeaseTurnCount);
      if (typeof item.nativeLeaseReused === "boolean") message.nativeLeaseReused = item.nativeLeaseReused;
      else delete message.nativeLeaseReused;
      if (typeof item.runTerminalRecovered === "boolean") message.runTerminalRecovered = item.runTerminalRecovered;
      else delete message.runTerminalRecovered;
      message.createdAt = normalizeNonNegativeNumber(item.createdAt);
      message.completedAt = normalizeOptionalPositiveNumber(item.completedAt);
      return message;
    })
    .filter((message): message is ChatMessage => Boolean(message));
}

function assignOptionalText<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const normalized = normalizeOptionalText(value);
  if (normalized) target[key] = normalized as T[K];
  else delete target[key];
}

function normalizeChatMessageRole(value: unknown): ChatMessage["role"] | null {
  return value === "user" || value === "assistant" || value === "system" || value === "tool" ? value : null;
}

function normalizeRunTerminalRecoveryPending(value: unknown): ChatMessage["runTerminalRecoveryPending"] {
  return value === "cancelled" || value === "failed" ? value : undefined;
}

function normalizeContextCompileMode(value: unknown): ContextCompileMode | undefined {
  return value === "bootstrap" || value === "incremental" || value === "catch-up" || value === "workflow" ? value : undefined;
}

function normalizeBackendSessionBindings(value: unknown, legacyThreadId?: string): Record<string, BackendSessionBinding> | undefined {
  const bindings: Record<string, BackendSessionBinding> = {};
  const records = settingsRecord(value);
  if (records) {
    for (const [key, raw] of Object.entries(records)) {
      const item = settingsRecord(raw) ?? {};
      const backendId = normalizeOptionalText(item.backendId || key);
      if (!backendId) continue;
      const nativeSessionId = normalizeOptionalText(item.nativeSessionId);
      const nativeThreadId = normalizeOptionalText(item.nativeThreadId);
      bindings[backendId] = {
        backendId,
        ...(nativeSessionId ? { nativeSessionId } : {}),
        ...(nativeThreadId ? { nativeThreadId } : {}),
        nativeExecutionKind: normalizeNativeExecutionKind(item.nativeExecutionKind),
        nativeExecutionRef: normalizeNativeExecutionRef(item.nativeExecutionRef, backendId),
        leaseId: normalizeOptionalText(item.leaseId) || undefined,
        leaseStatus: normalizeNativeLeaseStatus(item.leaseStatus),
        leaseCreatedAt: normalizeOptionalPositiveNumber(item.leaseCreatedAt),
        leaseLastUsedAt: normalizeOptionalPositiveNumber(item.leaseLastUsedAt),
        leaseExpiresAt: normalizeOptionalPositiveNumber(item.leaseExpiresAt),
        leaseTurnCount: normalizeOptionalPositiveNumber(item.leaseTurnCount),
        leaseMaxTurns: normalizeOptionalPositiveNumber(item.leaseMaxTurns),
        leaseContextChars: normalizeOptionalPositiveNumber(item.leaseContextChars),
        leaseMaxContextChars: normalizeOptionalPositiveNumber(item.leaseMaxContextChars),
        contextCheckpointMessageId: normalizeOptionalText(item.contextCheckpointMessageId) || undefined,
        syncedThroughMessageId: normalizeOptionalText(item.syncedThroughMessageId) || undefined,
        syncedSessionRevision: normalizeSessionRevision(item.syncedSessionRevision),
        snapshotVersion: normalizeOptionalText(item.snapshotVersion) || undefined,
        contextCursor: normalizeContextSyncCursor(item.contextCursor, item),
        lastUsedAt: normalizeNonNegativeNumber(item.lastUsedAt),
        ...(item.capabilitySnapshot ? { capabilitySnapshot: item.capabilitySnapshot as BackendSessionBinding["capabilitySnapshot"] } : {})
      };
    }
  }
  if (legacyThreadId && !bindings["codex-cli"]) {
    bindings["codex-cli"] = {
      backendId: "codex-cli",
      nativeThreadId: legacyThreadId,
      nativeExecutionKind: "thread",
      syncedSessionRevision: 1,
      lastUsedAt: 0
    };
  }
  return Object.keys(bindings).length ? bindings : undefined;
}

function normalizeSessionRevision(value: unknown): number {
  return normalizePositiveInteger(value, 1, 1, 1_000_000_000) || 1;
}

function normalizeNativeExecutionKind(value: unknown): BackendSessionBinding["nativeExecutionKind"] | undefined {
  return value === "thread" || value === "session" || value === "run" || value === "process" ? value : undefined;
}

function normalizeNativeExecutionRef(value: unknown, backendId: string): NativeExecutionRef | undefined {
  const item = settingsRecord(value);
  if (!item) return undefined;
  const id = normalizeOptionalText(item.id);
  const kind = normalizeNativeExecutionKind(item.kind);
  const persistence = item.persistence === "none" || item.persistence === "process-local" || item.persistence === "provider-persistent" || item.persistence === "unknown"
    ? item.persistence
    : undefined;
  const deviceKey = normalizeOptionalText(item.deviceKey);
  const vaultId = normalizeOptionalText(item.vaultId);
  if (!id || !kind || !persistence || !deviceKey || !vaultId) return undefined;
  const providerEndpoint = normalizeOptionalText(item.providerEndpoint);
  return {
    backendId,
    id,
    kind,
    persistence,
    ...(providerEndpoint ? { providerEndpoint } : {}),
    deviceKey,
    vaultId,
    createdAt: normalizeNonNegativeNumber(item.createdAt)
  };
}

function normalizeNativeLeaseStatus(value: unknown): BackendSessionBinding["leaseStatus"] | undefined {
  return value === "active" || value === "expired" || value === "cleanup-pending" || value === "disposed" || value === "failed" ? value : undefined;
}

function normalizeNativeLocalCommitStatus(value: unknown): NativeLocalCommitStatus | undefined {
  return value === "pending" || value === "committed" || value === "failed" ? value : undefined;
}

function normalizeNativeCleanupStatus(value: unknown): NativeCleanupStatus | undefined {
  return value === "not-needed" || value === "pending" || value === "disposed" || value === "unsupported" || value === "failed" || value === "retained-for-recovery" || value === "retained"
    ? value
    : undefined;
}

function normalizeContextSyncCursor(value: unknown, fallback?: unknown): ContextSyncCursor | undefined {
  const source = settingsRecord(value) ?? settingsRecord(fallback);
  if (!source) return undefined;
  const syncedThroughMessageId = normalizeOptionalText(source.syncedThroughMessageId);
  const snapshotVersion = normalizeOptionalText(source.snapshotVersion);
  return {
    ...(syncedThroughMessageId ? { syncedThroughMessageId } : {}),
    syncedSessionRevision: normalizeSessionRevision(source.syncedSessionRevision),
    ...(snapshotVersion ? { snapshotVersion } : {})
  };
}

function normalizeSessionContextSnapshot(value: unknown, sessionId: string): SessionContextSnapshot | undefined {
  const item = settingsRecord(value);
  if (!item) return undefined;
  const version = normalizeOptionalText(item.version);
  const rollingSummary = normalizeOptionalText(item.rollingSummary).slice(0, 8000);
  if (!version && !rollingSummary) return undefined;
  const summarizedFromMessageId = normalizeOptionalText(item.summarizedFromMessageId);
  const summarizedThroughMessageId = normalizeOptionalText(item.summarizedThroughMessageId);
  return {
    sessionId: normalizeOptionalText(item.sessionId) || sessionId,
    version: version || "snapshot-v1",
    goal: normalizeOptionalText(item.goal).slice(0, 2000),
    currentState: normalizeOptionalText(item.currentState).slice(0, 4000),
    decisions: normalizeTextArray(item.decisions, 80, 1000),
    constraints: normalizeTextArray(item.constraints, 80, 1000),
    openLoops: normalizeTextArray(item.openLoops, 80, 1000),
    keyReferences: normalizeTextArray(item.keyReferences, 80, 1000),
    rollingSummary,
    ...(summarizedFromMessageId ? { summarizedFromMessageId } : {}),
    ...(summarizedThroughMessageId ? { summarizedThroughMessageId } : {}),
    sourceMessageCount: normalizePositiveInteger(item.sourceMessageCount, 0, 0, 1_000_000),
    createdAt: normalizeNonNegativeNumber(item.createdAt),
    updatedAt: normalizeNonNegativeNumber(item.updatedAt)
  };
}

function normalizeTextArray(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeOptionalText(item).slice(0, maxChars)).filter(Boolean).slice(-maxItems);
}

function normalizeSessionSummary(value: unknown): StoredSession["rollingSummary"] {
  const item = settingsRecord(value);
  const text = normalizeOptionalText(item?.text).slice(0, 4000);
  if (!text) return undefined;
  return { text, updatedAt: normalizeNonNegativeNumber(item?.updatedAt) };
}

function normalizeKnowledgeContextBridgeEntries(value: unknown): KnowledgeContextBridgeEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((item: unknown): KnowledgeContextBridgeEntry | null => {
      const record = settingsRecord(item) ?? {};
      const id = normalizeOptionalText(record.id);
      const summary = normalizeOptionalText(record.summary).slice(0, 2000);
      if (!id || !summary) return null;
      return {
        id,
        intent: normalizeOptionalText(record.intent) || "unknown",
        command: normalizeOptionalText(record.command).slice(0, 500),
        summary,
        sourceMessageId: normalizeOptionalText(record.sourceMessageId),
        ...(record.citations ? { citations: record.citations as KnowledgeBaseCitationSummary } : {}),
        createdAt: normalizeNonNegativeNumber(record.createdAt),
        injectedThreadIds: normalizeKnowledgeContextThreadIds(record.injectedThreadIds)
      };
    })
    .filter((entry): entry is KnowledgeContextBridgeEntry => Boolean(entry))
    .slice(-8);
  return entries.length ? entries : undefined;
}

function normalizeKnowledgeContextThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((threadId: unknown) => normalizeOptionalText(threadId))
    .filter((threadId): threadId is string => Boolean(threadId));
  return [...new Set(ids)].slice(-20);
}

function normalizeOptionalPositiveNumber(value: unknown): number | undefined {
  const normalized = normalizeNonNegativeNumber(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeKnowledgeBaseProcessedSources(value: unknown): Record<string, KnowledgeBaseProcessedSource> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value)
    .map(([key, item]: [string, unknown]) => {
      const record = settingsRecord(item) ?? {};
      const path = normalizeOptionalText(record.path || key);
      if (!path) return null;
      const fingerprint = normalizeOptionalText(record.fingerprint);
      const source: KnowledgeBaseProcessedSource = {
        path,
        size: normalizeNonNegativeNumber(record.size),
        mtime: normalizeNonNegativeNumber(record.mtime),
        digestedAt: normalizeNonNegativeNumber(record.digestedAt)
      };
      if (fingerprint) source.fingerprint = fingerprint;
      const reportPath = normalizeOptionalText(record.reportPath);
      if (reportPath) source.reportPath = reportPath;
      const evidencePaths = Array.isArray(record.evidencePaths)
        ? record.evidencePaths.map(normalizeOptionalText).filter(Boolean)
        : [];
      if (evidencePaths.length) source.evidencePaths = evidencePaths;
      const runId = normalizeOptionalText(record.runId);
      if (runId) source.runId = runId;
      if (record.confidence === "verified" || record.confidence === "repaired") source.confidence = record.confidence;
      return [
        path,
        source
      ] as const;
    })
    .filter((item): item is readonly [string, KnowledgeBaseProcessedSource] => Boolean(item))
    .sort((left, right) => right[1].digestedAt - left[1].digestedAt)
    .slice(0, 1000);
  return Object.fromEntries(entries);
}

function normalizeKnowledgeBaseHealthHistory(value: unknown): KnowledgeBaseHealthHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const byDate = new Map<string, KnowledgeBaseHealthHistoryEntry>();
  for (const item of value) {
    const record = settingsRecord(item) ?? {};
    const date = normalizeOptionalText(record.date);
    const status = normalizeKnowledgeBaseHealthCheckStatus(record.status);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) continue;
    byDate.set(date, {
      date,
      status,
      at: normalizeNonNegativeNumber(record.at)
    });
  }
  return Array.from(byDate.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-90);
}

function normalizeKnowledgeBaseMaintenanceHistory(value: unknown, legacyHealthHistory?: unknown): KnowledgeBaseMaintenanceHistoryEntry[] {
  const byDate = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
  const add = (item: unknown, legacyMode: KnowledgeBaseMaintenanceMode) => {
    const record = settingsRecord(item) ?? {};
    const date = normalizeOptionalText(record.date);
    const status = normalizeKnowledgeBaseHealthCheckStatus(record.status);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) return;
    const at = normalizeNonNegativeNumber(record.at);
    const current = byDate.get(date);
    if (current && current.at > at) return;
    byDate.set(date, {
      date,
      status,
      at,
      mode: normalizeKnowledgeBaseMaintenanceMode(record.mode) ?? legacyMode,
      reportPath: normalizeOptionalText(record.reportPath)
    });
  };
  if (Array.isArray(legacyHealthHistory)) {
    for (const item of legacyHealthHistory) add(item, "lint");
  }
  if (Array.isArray(value)) {
    for (const item of value) add(item, "unknown");
  }
  return Array.from(byDate.values())
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-180);
}

function normalizeKnowledgeBaseHealthCheckStatus(value: unknown): KnowledgeBaseHealthCheckStatus | null {
  return value === "success" || value === "failed" ? value : null;
}

function normalizeKnowledgeBaseMaintenanceMode(value: unknown): KnowledgeBaseMaintenanceMode | null {
  return value === "maintain" || value === "lint" || value === "reingest" || value === "outputs" || value === "inbox" || value === "unknown" ? value : null;
}

function normalizeKnowledgeBaseManagedThreadKind(value: unknown): KnowledgeBaseManagedThreadKind {
  const maintenanceMode = normalizeKnowledgeBaseMaintenanceMode(value);
  if (maintenanceMode) return maintenanceMode;
  return value === "ask" || value === "journal" || value === "review" ? value : "unknown";
}

function normalizeKnowledgeBaseManagedThreadArchiveState(value: unknown): KnowledgeBaseManagedThreadArchiveState {
  return value === "running" || value === "pending-archive" || value === "archived" || value === "archive-failed" ? value : "pending-archive";
}

export function normalizeKnowledgeBaseHistoryRetentionDays(value: unknown, fallback: number): number {
  const normalized = normalizePositiveInteger(value, fallback, 0, 3650);
  return normalized === 0 || normalized === 7 || normalized === 30 || normalized === 90 ? normalized : fallback;
}

function normalizeKnowledgeBaseManagedThreads(value: unknown): Record<string, KnowledgeBaseManagedThread> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: Array<[string, KnowledgeBaseManagedThread]> = [];
  for (const [key, raw] of Object.entries(value)) {
    const item = settingsRecord(raw) ?? {};
    const threadId = normalizeOptionalText(item?.threadId || key);
    if (!threadId) continue;
    entries.push([threadId, {
      threadId,
      runId: normalizeOptionalText(item?.runId),
      kind: normalizeKnowledgeBaseManagedThreadKind(item?.kind),
      vaultPath: normalizeOptionalText(item?.vaultPath),
      archiveState: normalizeKnowledgeBaseManagedThreadArchiveState(item?.archiveState),
      createdAt: normalizeNonNegativeNumber(item?.createdAt),
      settledAt: normalizeNonNegativeNumber(item?.settledAt),
      archivedAt: normalizeNonNegativeNumber(item?.archivedAt),
      attempts: normalizePositiveInteger(item?.attempts, 0, 0, 1000),
      lastError: normalizeOptionalText(item?.lastError)
    }]);
  }
  return Object.fromEntries(entries.slice(-200));
}

export function recordKnowledgeBaseHealthCheck(settings: KnowledgeBaseSettings, status: KnowledgeBaseHealthCheckStatus, at = Date.now()): void {
  const date = formatLocalDateKey(at);
  settings.healthHistory = normalizeKnowledgeBaseHealthHistory([
    ...(settings.healthHistory ?? []).filter((entry) => entry.date !== date),
    { date, status, at }
  ]);
}

export function recordKnowledgeBaseMaintenanceRun(
  settings: KnowledgeBaseSettings,
  input: { status: KnowledgeBaseHealthCheckStatus; mode: KnowledgeBaseMaintenanceMode; at?: number; reportPath?: string }
): void {
  const at = input.at ?? Date.now();
  const date = formatLocalDateKey(at);
  settings.maintenanceHistory = normalizeKnowledgeBaseMaintenanceHistory([
    ...(settings.maintenanceHistory ?? []).filter((entry) => entry.date !== date),
    { date, status: input.status, at, mode: input.mode, reportPath: input.reportPath ?? "" }
  ], settings.healthHistory);
  if (input.mode === "lint") recordKnowledgeBaseHealthCheck(settings, input.status, at);
}

function formatLocalDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeScheduleTime(value: unknown, fallback: string): string {
  const text = normalizeOptionalText(value);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeEditorActionConfigs(value: unknown, defaults: EditorAiActionConfig[], previousVersion: number): EditorAiActionConfig[] {
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const used = new Set<string>();
  const result: EditorAiActionConfig[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    const record = settingsRecord(item) ?? {};
    const id = normalizeEditorActionId(record.id);
    if (!id || used.has(id)) continue;
    const fallback = defaultById.get(id);
    used.add(id);
    const rawPromptTemplate = normalizeText(record.promptTemplate, fallback?.promptTemplate ?? "{{selected_text}}");
    result.push({
      id,
      label: normalizeText(record.label, fallback?.label ?? id),
      enabled: typeof record.enabled === "boolean" ? record.enabled : fallback?.enabled ?? true,
      promptTemplate: shouldMigrateEditorActionPrompt(id, rawPromptTemplate, previousVersion) ? fallback?.promptTemplate ?? rawPromptTemplate : rawPromptTemplate
    });
  }
  for (const fallback of defaults) {
    if (used.has(fallback.id)) continue;
    result.push({ ...fallback });
  }
  return result;
}

function normalizeEditorActionStyles(value: unknown, defaults: EditorAiStyleConfig[], previousVersion: number): EditorAiStyleConfig[] {
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const used = new Set<string>();
  const result: EditorAiStyleConfig[] = [];
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    const record = settingsRecord(item) ?? {};
    const id = normalizeEditorActionId(record.id);
    if (!id || used.has(id)) continue;
    const fallback = defaultById.get(id);
    used.add(id);
    const rawInstruction = normalizeText(record.instruction, fallback?.instruction ?? "");
    result.push({
      id,
      label: normalizeText(record.label, fallback?.label ?? id),
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
  value: unknown,
  defaults: Record<EditorActionQualityMode, EditorActionModeConfig>,
  legacyFast?: { model: string; contextCharsBefore: number; contextCharsAfter: number }
): Record<EditorActionQualityMode, EditorActionModeConfig> {
  const source = settingsRecord(value) ?? {};
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
  input: unknown,
  fallback: EditorActionModeConfig,
  overrideFallback?: Partial<Pick<EditorActionModeConfig, "model" | "contextCharsBefore" | "contextCharsAfter">>
): EditorActionModeConfig {
  const value = settingsRecord(input) ?? {};
  return {
    mode: fallback.mode,
    label: fallback.label,
    model: normalizeText(value?.model, overrideFallback?.model ?? fallback.model),
    contextCharsBefore: normalizePositiveInteger(value?.contextCharsBefore, overrideFallback?.contextCharsBefore ?? fallback.contextCharsBefore, 0, 10000),
    contextCharsAfter: normalizePositiveInteger(value?.contextCharsAfter, overrideFallback?.contextCharsAfter ?? fallback.contextCharsAfter, 0, 10000)
  };
}

export function normalizeEditorActionQualityMode(value: unknown, fallback: EditorActionQualityMode): EditorActionQualityMode {
  return value === "fast" || value === "quality" || value === "strict" ? value : fallback;
}

function normalizeEditorActionId(value: unknown): string {
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

function normalizeText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeComparablePath(value: unknown): string {
  return normalizeOptionalText(value)
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function normalizeEditorActionPerformanceNumber(value: unknown, fallback: number, legacyDefault: number, previousVersion: number, min: number, max: number): number {
  if (previousVersion < 10 && Number(value) === legacyDefault) return fallback;
  return normalizePositiveInteger(value, fallback, min, max);
}

function normalizeEditorActionTimeoutMs(value: unknown, fallback: number, previousVersion: number): number {
  const number = Number(value);
  if (previousVersion < 13 && (number === 90000 || number === 25000)) return fallback;
  return normalizePositiveInteger(value, fallback, 10000, 300000);
}

function normalizeNonNegativeNumber(value: unknown): number {
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

function normalizeApiProviders(value: unknown): ApiProviderConfig[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value.map((item, index) => {
    const record = settingsRecord(item) ?? {};
    const id = uniqueProviderId(sanitizeProviderId(record.id, index), usedIds, index);
    usedIds.add(id);
    const queryParams = normalizeQueryParams(record.queryParams);
    const models = normalizeModelList(Array.isArray(record.models) ? [...record.models, record.model] : [record.model]);
    return {
      id,
      name: typeof record.name === "string" ? record.name.trim() : "",
      baseUrl: typeof record.baseUrl === "string" ? record.baseUrl.trim() : "",
      model: models[0] ?? "",
      models,
      apiKey: typeof record.apiKey === "string" ? record.apiKey.trim() : "",
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

function sanitizeProviderId(value: unknown, index: number): string {
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

function normalizeQueryParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    const stringValue = typeof raw === "string" ? raw.trim() : "";
    if (stringValue) result[key] = stringValue;
  }
  return result;
}

function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof key === "string" && key.trim() && typeof enabled === "boolean") result[key] = enabled;
  }
  return result;
}

function normalizeCacheEntry<T>(value: unknown, normalizeItem: (item: unknown) => T | null): WorkspaceResourceCacheEntry<T> | undefined {
  const record = settingsRecord(value);
  if (!record || !Array.isArray(record.items)) return undefined;
  const items = record.items.map(normalizeItem).filter((item): item is T => Boolean(item));
  const fetchedAt = typeof record.fetchedAt === "number" && Number.isFinite(record.fetchedAt) ? record.fetchedAt : Date.now();
  const error = typeof record.error === "string" && record.error.trim() ? record.error : "";
  return { fetchedAt, items, ...(error ? { error } : {}) };
}

function normalizeCachedPlugin(item: unknown): CodexPluginInfo | null {
  const value = settingsRecord(item) ?? {};
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  return {
    id,
    name: typeof value.name === "string" ? value.name : id,
    displayName: typeof value.displayName === "string" ? value.displayName : id,
    description: typeof value.description === "string" ? value.description : "",
    marketplace: typeof value.marketplace === "string" ? value.marketplace : "",
    category: typeof value.category === "string" ? value.category : "",
    installed: value.installed !== false,
    enabled: value.enabled !== false
  };
}

function normalizeCachedSkill(item: unknown): CodexSkill | null {
  const value = settingsRecord(item) ?? {};
  const name = typeof value.name === "string" ? value.name : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!name || !path) return null;
  return {
    name,
    path,
    description: typeof value.description === "string" ? value.description : "",
    scope: typeof value.scope === "string" ? value.scope : "",
    enabled: value.enabled !== false
  };
}

function normalizeCachedMcp(item: unknown): McpServerStatus | null {
  const value = settingsRecord(item) ?? {};
  const name = typeof value.name === "string" ? value.name : "";
  if (!name) return null;
  return {
    name,
    tools: settingsRecord(value.tools) ?? {},
    resources: Array.isArray(value.resources) ? value.resources : [],
    resourceTemplates: Array.isArray(value.resourceTemplates) ? value.resourceTemplates : [],
    authStatus: typeof value.authStatus === "string" ? value.authStatus : "unknown"
  };
}

function isEchoInkResourceLike(value: unknown): value is EchoInkResourceSettings["catalog"][number] {
  const record = settingsRecord(value);
  return typeof record?.id === "string";
}

function settingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
