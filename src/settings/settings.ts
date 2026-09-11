import type { CodexModel, CodexPluginInfo, CodexSkill, McpServerStatus, PermissionMode, ProcessEventKind, ProcessFileRef, ReasoningEffort, TokenUsage, UiMode } from "../types/app-server";
import { DEFAULT_QUICK_CHAT_HOTKEY, normalizeAccelerator } from "../core/quick-hotkey";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import {
  apiProviderAuthMode,
  apiProviderApiKeyRequired,
  apiProviderConfiguredDisplayName,
  apiProviderMaxOutputReserve,
  getApiProviderPreset,
  getApiProviderModelPreset,
  isLoopbackApiProviderUrl,
  isQwenTokenPlanApiProviderUrl,
  normalizeApiProviderId,
  normalizeApiProviderProtocol,
  normalizeApiProviderBaseUrl,
  type ApiProviderId,
  type ApiProviderAuthMode,
  type ApiProviderProtocol
} from "./provider-presets";
import {
  parsePiContextLedger,
  type PiContextLedger
} from "../harness/pi-native/pi-context-budget";
import { normalizeHarnessRunUsage, type HarnessRunUsage } from "../harness/contracts/event";
import { defaultResourceSettings } from "../resources/registry";
import { normalizeMcpConnectionRecords } from "../resources/mcp-connections";
import type { EchoInkResourceSettings } from "../resources/types";
import type {
  KnowledgeBaseCitationSummary,
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunWarning
} from "../knowledge-base/types";
import type { KnowledgeBaseMessageUiPayload } from "../knowledge-base/maintain-report-card";
import {
  normalizeEchoInkTaskPlanSnapshot,
  type EchoInkTaskPlanSnapshot
} from "../types/task-plan";
import {
  normalizeEchoInkReasoningSummarySnapshot,
  type EchoInkReasoningSummarySnapshot
} from "../types/reasoning-summary";
import type { EchoInkConversationSessionShell } from "./current-conversation";
import {
  normalizeEchoInkReasoningEffort,
  resolveEchoInkPiCatalogModel
} from "./pi-model-catalog";
import type {
  EchoInkAssistantTurnSnapshot,
  EchoInkTurnInteractionRecord
} from "../types/conversation-turn";
import {
  DEFAULT_JOURNAL_DIRECTORY,
  normalizeJournalDirectory,
  normalizedJournalDirectoryOrNull
} from "../home/journal-directory";

export interface StoredAttachment {
  type: "file" | "image";
  name: string;
  path: string;
  /** Local display metadata only; image payloads remain exclusively in Pi Session. */
  mimeType?: string;
  /** Local display metadata; document bytes are never persisted here. */
  sizeBytes?: number;
  /** Derived at projection time and never persisted as transcript truth. */
  availability?: "available" | "unavailable";
  /** Composer-only private replay data; message projections must never copy it. */
  documentReplay?: Readonly<StoredPiDocumentReplayMetadata>;
}

export interface StoredPiImageAttachmentMetadata {
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  /** Last observed local state; every projection revalidates it against the resource. */
  readonly availability?: "available" | "unavailable";
}

/** Display-only metadata for a user-selected whole-note mention. */
export interface NoteMentionReference {
  readonly vaultRelativePath: string;
  readonly fileName: string;
}

export type StoredPiImageAttachmentsByEntry = Readonly<
  Record<string, readonly Readonly<StoredPiImageAttachmentMetadata>[]>
>;

export interface StoredPiDocumentReplayMetadata {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly kind: "pdf" | "word" | "markdown" | "html";
  readonly sha256: string;
  /** Null is a durable tombstone: persisted bytes are unavailable and this Turn had no extracted text. */
  readonly text: string | null;
}

export type StoredPiDocumentReplayByEntry = Readonly<
  Record<string, readonly Readonly<StoredPiDocumentReplayMetadata>[]>
>;

/** Minimal display metadata for a primary Personal Memory injected this turn. */
export interface PersonalMemorySourceReference {
  id: string;
  title: string;
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

export type EchoInkChatTerminalPayloadSource =
  | {
    kind: "inline";
    value: string;
    contentHash: string;
    size: number;
    lines: number;
  }
  | {
    kind: "raw";
    rawRef: string;
    contentHash: string;
    previewHash: string;
    size: number;
    lines: number;
  };

export interface EchoInkChatRunTerminalRecovery {
  namespace: "echoink.chat-terminal";
  schemaVersion: 1;
  runId: string;
  status: "completed" | "cancelled" | "failed";
  backendId?: string;
  data?: Record<string, unknown>;
  payloadPresent: boolean;
  payloadHash: string;
  terminalCommitId: string;
  carrierMessageId: string;
  payloadSource: EchoInkChatTerminalPayloadSource;
}

export type ChatMessageApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled";

/** Display-only projection of the durable Approval Ticket lifecycle. */
export interface ChatMessageApprovalSnapshot {
  readonly status: ChatMessageApprovalStatus;
  readonly target?: string;
  readonly preview?: string;
  readonly updatedAt?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  backendId?: string;
  /** Exact runtime Provider identity captured from Pi; absent on historical messages. */
  providerId?: string;
  modelId?: string;
  profileId?: string;
  runTerminalRecoveryPending?: "completed" | "cancelled" | "failed";
  echoInkRunTerminalRecovery?: EchoInkChatRunTerminalRecovery;
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
  processContentAvailability?: "provided" | "empty" | "unavailable";
  processInput?: string;
  processOutput?: string;
  processInputAvailability?: "provided" | "empty" | "unavailable";
  processOutputAvailability?: "provided" | "empty" | "unavailable";
  approval?: Readonly<ChatMessageApprovalSnapshot>;
  diffSummary?: DiffSummary;
  citations?: KnowledgeBaseCitationSummary;
  /** True only when a settled `/ask` source snapshot was projected. */
  askSourceAttribution?: true;
  /** Display-only primary Memory ids and titles; never Memory bodies or prompts. */
  personalMemorySources?: readonly PersonalMemorySourceReference[];
  /** Display-only note mention metadata; note bodies remain in Pi Session. */
  noteMentions?: readonly NoteMentionReference[];
  knowledgeBaseUi?: KnowledgeBaseMessageUiPayload;
  attachments?: StoredAttachment[];
  files?: ProcessFileRef[];
  images?: StoredAttachment[];
  runUsage?: HarnessRunUsage;
  /** Thin projection of a structured Pi Session task-plan entry. */
  taskPlan?: Readonly<EchoInkTaskPlanSnapshot>;
  /** Bounded, privacy-safe projection of one Pi ProductRun lifecycle. */
  reasoningSummary?: Readonly<EchoInkReasoningSummarySnapshot>;
  /** Display-only unified Assistant Turn projection; Pi Session remains authoritative. */
  assistantTurn?: Readonly<EchoInkAssistantTurnSnapshot>;
  /** Compact, non-interactive Question/Confirmation history on the process spine. */
  interactionRecord?: Readonly<EchoInkTurnInteractionRecord>;
  createdAt: number;
  completedAt?: number;
}

export type StoredSession = EchoInkConversationSessionShell<
  ChatMessage,
  Readonly<PiContextLedger>,
  TokenUsage
> & {
  /** Local-only metadata keyed by the durable Pi user Entry identity. */
  piImageAttachments?: StoredPiImageAttachmentsByEntry;
  /** Private extracted-text replay snapshots; never bytes, Base64, or local paths. */
  piDocumentReplay?: StoredPiDocumentReplayByEntry;
};

export type SettingsTab = "general" | "providers" | "resources" | "knowledgeBase" | "review";
export type ProviderMode = "custom-api";
export type ResourceManagementTab = "plugins" | "mcp" | "skills";
export type KnowledgeBaseRunStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type KnowledgeBaseInitStatus = "not-started" | "preview-ready" | "initialized" | "failed";
export type KnowledgeBaseCaptureTarget = "inbox" | "raw-articles" | "raw-attachments" | "journal";
export type KnowledgeBaseHealthCheckStatus = "success" | "failed";
export type KnowledgeBaseMaintenanceTerminalStatus = KnowledgeBaseHealthCheckStatus | "canceled";
export type KnowledgeBaseMaintenanceMode = "maintain" | "lint" | "reingest" | "outputs" | "inbox" | "unknown";
export type ReviewReportKind = "knowledge-base" | "agent-chat";
export type ReviewRangeMode = "previous-week" | "current-week";
export type SettingsLanguage = "zh-CN" | "en";

export interface SetupSettings {
  completedAt: number;
  lastCheckedAt: number;
  dismissedVersion: string;
  tutorialVersion: string;
  tutorialStep: "sidebar" | "settings" | "provider" | "knowledge" | "personality";
}

export const DEFAULT_ECHOINK_WELCOME_TITLE = "What's new?";
export const DEFAULT_ECHOINK_WELCOME_SUBTITLE =
  "当前 Conversation 需要先选择工作区；添加笔记只作为本轮上下文。";

export interface EchoInkWelcomeCopy {
  readonly title: string;
  readonly subtitle: string;
}

export interface EchoInkMemorySettings {
  useLongTermMemory: boolean;
  /** Dream scheduler: offline memory consolidation (anchor expansion + personality signal extraction). */
  dreamEnabled: boolean;
  /** Number of dream runs per day (1-6). */
  dreamRunsPerDay: number;
  /** Max token budget per dream run. */
  dreamTokenBudget: number;
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

export interface KnowledgeBaseMaintenanceHistoryEntry {
  resultStatus?: "completed" | "partial" | "noop" | "failed" | "write_uncertain" | "cancelled";
  date: string;
  status: KnowledgeBaseMaintenanceTerminalStatus;
  at: number;
  runId?: string;
  mode: KnowledgeBaseMaintenanceMode;
  reportPath: string;
  completion?: KnowledgeBaseRunCompletion;
  pendingSources?: string[];
  /** @deprecated Read-only compatibility for pre-resilience history. */
  phase?: string;
  errorCode?: string;
  warnings?: KnowledgeBaseRunWarning[];
}

export interface KnowledgeBaseSettings {
  lastRunAt: number;
  lastRunStatus: KnowledgeBaseRunStatus;
  lastReportPath: string;
  lastError: string;
  lastSummary: string;
  lastCompletion: KnowledgeBaseRunCompletion | "";
  lastPendingSources: string[];
  lastWarnings: KnowledgeBaseRunWarning[];
  initialization: KnowledgeBaseInitializationSettings;
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  healthHistory: KnowledgeBaseHealthHistoryEntry[];
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
}

export interface KnowledgeBaseInitializationSettings {
  status: KnowledgeBaseInitStatus;
  initializedAt: number;
  templateVersion: string;
  lastPreviewSummary: string;
}

export interface ReviewReportState {
  lastRangeKey: string;
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
  providerId?: ApiProviderId;
  runtimeProviderId: string;
  apiProtocol: ApiProviderProtocol;
  authMode: ApiProviderAuthMode;
  name: string;
  baseUrl: string;
  /** Enabled models. Model identity is scoped to this Provider settings id. */
  models: ApiProviderModelConfig[];
  /** Explicit default; always references one entry in models when configured. */
  defaultModelId: string;
  apiKey: string;
  queryParams?: Record<string, string>;
}

export type ApiProviderModelInput = "text" | "image";
export type ApiProviderModelMetadataSource =
  | "preset"
  | "catalog"
  | "unknown"
  | "manual";

export interface ApiProviderModelLimitsOverride {
  contextWindow?: number;
  modelMaxTokens?: number;
  maxOutputTokens?: number;
}

export interface ApiProviderModelConfig {
  id: string;
  displayName: string;
  input: ApiProviderModelInput[];
  toolCalling: boolean;
  /** Pi/catalog capability metadata. This does not express the user's preference. */
  reasoning: boolean;
  /** User master switch scoped to this exact Provider model record. */
  reasoningEnabled: boolean;
  /** Last valid positive strength, retained while reasoning is disabled. */
  reasoningEffort?: ReasoningEffort;
  contextWindow: number;
  /** Provider-published model output ceiling. */
  modelMaxTokens: number;
  /** EchoInk's actual per-request output ceiling. */
  maxOutputTokens: number;
  /** User-entered limits only. Missing fields inherit effective metadata. */
  limitsOverride?: ApiProviderModelLimitsOverride;
  metadataSource: ApiProviderModelMetadataSource;
}

const INVALID_STORED_REASONING_EFFORT_MODELS = new WeakSet<
  ApiProviderModelConfig
>();
const EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS = new WeakSet<
  ApiProviderModelConfig
>();
const INVALID_STORED_REASONING_EFFORT_IDENTITIES = new Set<string>();

/**
 * Tracks an invalid persisted value without admitting that value into settings.
 * The signal lives only for the normalized in-memory model object so Composer can
 * distinguish a missing preference from one that needs a visible correction.
 */
export function apiProviderModelHadInvalidStoredReasoningEffort(
  providerSettingsId: string,
  model: ApiProviderModelConfig
): boolean {
  return INVALID_STORED_REASONING_EFFORT_MODELS.has(model)
    || INVALID_STORED_REASONING_EFFORT_IDENTITIES.has(
      invalidStoredReasoningEffortIdentity(providerSettingsId, model.id)
    );
}

export function clearApiProviderModelInvalidStoredReasoningEffort(
  providerSettingsId: string,
  model: ApiProviderModelConfig
): void {
  INVALID_STORED_REASONING_EFFORT_MODELS.delete(model);
  EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS.delete(model);
  INVALID_STORED_REASONING_EFFORT_IDENTITIES.delete(
    invalidStoredReasoningEffortIdentity(providerSettingsId, model.id)
  );
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

export interface QuickChatSettings {
  /** Master switch for the global quick-chat hotkey and popout window. */
  enabled: boolean;
  /** Electron accelerator, e.g. `CommandOrControl+Shift+E`. */
  hotkey: string;
}

export interface CodexForObsidianSettings {
  productGeneration: "pi-agent-product-v1";
  settingsVersion: number;
  settingsLanguage: SettingsLanguage;
  settingsTab: SettingsTab;
  proxyEnabled: boolean;
  proxyUrl: string;
  proxyEndpoint: string;
  proxyCredentialRef: string;
  providerMode: ProviderMode;
  activeApiProviderId: string;
  apiProviders: ApiProviderConfig[];
  openAICodexCredential: OAuthCredential | null;
  defaultModel: string;
  defaultPermission: PermissionMode;
  defaultMode: UiMode;
  autoOpen: boolean;
  autoOpenHome: boolean;
  quickChat: QuickChatSettings;
  journalDirectory: string;
  customWelcomeEnabled: boolean;
  customWelcomeTitle: string;
  customWelcomeSubtitle: string;
  setup: SetupSettings;
  memory: EchoInkMemorySettings;
  resourceManagementTab: ResourceManagementTab;
  knowledgeBase: KnowledgeBaseSettings;
  review: WeeklyReviewSettings;
  resources: EchoInkResourceSettings;
  workspaceResources: WorkspaceResourceToggles;
  workspaceResourceCache: WorkspaceResourceCache;
  sessions: StoredSession[];
  activeSessionId: string;
}

export const DEFAULT_REVIEW_OUTPUT_DIR = "outputs";

export const DEFAULT_SETTINGS: CodexForObsidianSettings = {
  productGeneration: "pi-agent-product-v1",
  settingsVersion: 53,
  settingsLanguage: "zh-CN",
  settingsTab: "providers",
  proxyEnabled: false,
  proxyUrl: "http://127.0.0.1:7890",
  proxyEndpoint: "",
  proxyCredentialRef: "",
  providerMode: "custom-api",
  activeApiProviderId: "",
  apiProviders: [createDefaultApiProvider()],
  openAICodexCredential: null,
  defaultModel: "",
  defaultPermission: "workspace-write",
  defaultMode: "agent",
  autoOpen: false,
  autoOpenHome: false,
  quickChat: {
    enabled: false,
    hotkey: DEFAULT_QUICK_CHAT_HOTKEY
  },
  journalDirectory: DEFAULT_JOURNAL_DIRECTORY,
  customWelcomeEnabled: false,
  customWelcomeTitle: DEFAULT_ECHOINK_WELCOME_TITLE,
  customWelcomeSubtitle: DEFAULT_ECHOINK_WELCOME_SUBTITLE,
  setup: {
    completedAt: 0,
    lastCheckedAt: 0,
    dismissedVersion: "",
    tutorialVersion: "",
    tutorialStep: "sidebar"
  },
  memory: {
    useLongTermMemory: true,
    dreamEnabled: true,
    dreamRunsPerDay: 3,
    dreamTokenBudget: 50000
  },
  resourceManagementTab: "plugins",
  knowledgeBase: {
    lastRunAt: 0,
    lastRunStatus: "idle",
    lastReportPath: "",
    lastError: "",
    lastSummary: "",
    lastCompletion: "",
    lastPendingSources: [],
    lastWarnings: [],
    initialization: {
      status: "not-started",
      initializedAt: 0,
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
        lastRangeKey: ""
      },
      agentChat: {
        lastRangeKey: ""
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

export function normalizeQuickChatSettings(input: unknown): QuickChatSettings {
  const record = settingsRecord(input) ?? {};
  const hotkey = typeof record.hotkey === "string"
    ? normalizeAccelerator(record.hotkey)
    : "";
  return {
    enabled: record.enabled === true,
    hotkey: hotkey || DEFAULT_QUICK_CHAT_HOTKEY
  };
}

export function normalizeSettingsData(input: unknown): { settings: CodexForObsidianSettings; changed: boolean } {
  const data = settingsRecord(input) ?? {};
  const retiredDataPresent = hasRetiredSettingsData(data);
  const legacyTokenPlanCustomPresent = hasLegacyTokenPlanCustomProvider(
    data.apiProviders
  );
  const currentProductData = data.productGeneration === DEFAULT_SETTINGS.productGeneration;
  const currentData = Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS)
      .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
      .map((key) => [key, data[key]])
  ) as Partial<CodexForObsidianSettings>;
  const previousVersion = typeof data?.settingsVersion === "number" ? data.settingsVersion : 0;
  const normalizedLanguage = normalizeSettingsLanguage(data?.settingsLanguage);
  const settings: CodexForObsidianSettings = {
    ...DEFAULT_SETTINGS,
    ...currentData,
    productGeneration: DEFAULT_SETTINGS.productGeneration,
    settingsLanguage: normalizedLanguage,
    settingsTab: normalizeSettingsTab(data?.settingsTab),
    providerMode: normalizeProviderMode(data?.providerMode),
    autoOpenHome: data?.autoOpenHome === true,
    journalDirectory: normalizeJournalDirectory(data?.journalDirectory),
    activeApiProviderId: typeof data?.activeApiProviderId === "string" ? data.activeApiProviderId.trim() : "",
    apiProviders: normalizeApiProviders(
      data?.apiProviders,
      previousVersion < 52
    ),
    customWelcomeEnabled: data?.customWelcomeEnabled === true,
    customWelcomeTitle: normalizeWelcomeLine(
      data?.customWelcomeTitle,
      DEFAULT_ECHOINK_WELCOME_TITLE
    ),
    customWelcomeSubtitle: normalizeWelcomeLine(
      data?.customWelcomeSubtitle,
      DEFAULT_ECHOINK_WELCOME_SUBTITLE
    ),
    openAICodexCredential: normalizeOpenAICodexCredential(
      data?.openAICodexCredential
    ),
    setup: normalizeSetupSettings(data?.setup),
    memory: normalizeMemorySettings(data?.memory),
    quickChat: normalizeQuickChatSettings(data?.quickChat),
    resourceManagementTab: normalizeResourceManagementTab(data?.resourceManagementTab),
    knowledgeBase: normalizeKnowledgeBaseSettings(data?.knowledgeBase),
    review: normalizeReviewSettings(data?.review),
    resources: normalizeEchoInkResourceSettings(data?.resources, data?.workspaceResources),
    workspaceResources: normalizeWorkspaceResources(data?.workspaceResources),
    workspaceResourceCache: normalizeWorkspaceResourceCache(data?.workspaceResourceCache),
    sessions: currentProductData ? normalizeStoredSessions(data?.sessions) : [],
    activeSessionId: currentProductData && typeof data?.activeSessionId === "string"
      ? data.activeSessionId
      : ""
  };

  settings.knowledgeBase.lastRunAt = currentProductData ? settings.knowledgeBase.lastRunAt : 0;
  settings.knowledgeBase.lastRunStatus = currentProductData ? settings.knowledgeBase.lastRunStatus : "idle";
  settings.knowledgeBase.lastReportPath = currentProductData ? settings.knowledgeBase.lastReportPath : "";
  settings.knowledgeBase.lastError = currentProductData ? settings.knowledgeBase.lastError : "";
  settings.knowledgeBase.lastSummary = currentProductData ? settings.knowledgeBase.lastSummary : "";
  settings.knowledgeBase.lastCompletion = currentProductData ? settings.knowledgeBase.lastCompletion : "";
  settings.knowledgeBase.lastPendingSources = currentProductData ? settings.knowledgeBase.lastPendingSources : [];
  settings.knowledgeBase.lastWarnings = currentProductData ? settings.knowledgeBase.lastWarnings : [];
  settings.knowledgeBase.processedSources = currentProductData ? settings.knowledgeBase.processedSources : {};
  settings.knowledgeBase.healthHistory = currentProductData ? settings.knowledgeBase.healthHistory : [];
  settings.knowledgeBase.maintenanceHistory = currentProductData ? settings.knowledgeBase.maintenanceHistory : [];
  if (!settings.sessions.some((session) => session.id === settings.activeSessionId)) {
    settings.activeSessionId = settings.sessions[0]?.id ?? "";
  }

  if (previousVersion < 1) {
    if (!data?.defaultModel) settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    settings.proxyEnabled = data?.proxyEnabled !== false;
    settings.proxyUrl = settings.proxyEndpoint || settings.proxyCredentialRef
      ? ""
      : typeof data?.proxyUrl === "string" && data.proxyUrl.trim()
        ? data.proxyUrl.trim()
        : DEFAULT_SETTINGS.proxyUrl;
  }

  if (previousVersion < 4) {
    if (!settings.defaultModel || settings.defaultModel === "gpt-5.4" || settings.defaultModel === "gpt-5.4-mini") {
      settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    }
  }

  if (previousVersion < 25 && settings.defaultModel === "gpt-5.5") {
    settings.defaultModel = "";
  }

  if (settings.proxyEndpoint || settings.proxyCredentialRef) {
    settings.proxyUrl = "";
  }
  migrateLegacyReasoningPreference(settings, data, previousVersion);
  normalizeApiProviderSelection(settings);
  settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  const languageChanged = data?.settingsLanguage !== normalizedLanguage;
  const sessionBoundaryChanged = currentProductData
    && (
      settings.activeSessionId !== data?.activeSessionId
      || settings.sessions.length !== (Array.isArray(data?.sessions) ? data.sessions.length : 0)
    );
  const welcomeSettingsChanged = Object.hasOwn(data, "showWelcome")
    || !Object.hasOwn(data, "customWelcomeEnabled")
    || !Object.hasOwn(data, "customWelcomeTitle")
    || !Object.hasOwn(data, "customWelcomeSubtitle");
  return {
    settings,
    changed: previousVersion !== DEFAULT_SETTINGS.settingsVersion
      || languageChanged
      || !currentProductData
      || sessionBoundaryChanged
      || welcomeSettingsChanged
      || retiredDataPresent
      || legacyTokenPlanCustomPresent
  };
}

export function resolveEchoInkWelcomeCopy(
  settings: Pick<
    CodexForObsidianSettings,
    "customWelcomeEnabled" | "customWelcomeTitle" | "customWelcomeSubtitle"
  >
): Readonly<EchoInkWelcomeCopy> {
  if (!settings.customWelcomeEnabled) {
    return Object.freeze({
      title: DEFAULT_ECHOINK_WELCOME_TITLE,
      subtitle: DEFAULT_ECHOINK_WELCOME_SUBTITLE
    });
  }
  return Object.freeze({
    title: settings.customWelcomeTitle.trim() || DEFAULT_ECHOINK_WELCOME_TITLE,
    subtitle: settings.customWelcomeSubtitle.trim() || DEFAULT_ECHOINK_WELCOME_SUBTITLE
  });
}

function hasRetiredSettingsData(data: Record<string, unknown>): boolean {
  const currentKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  if (Object.keys(data).some((key) => !currentKeys.has(key))) return true;
  const knowledgeBase = settingsRecord(data.knowledgeBase);
  if (knowledgeBase && Object.keys(knowledgeBase).some((key) => !KNOWLEDGE_BASE_SETTINGS_KEYS.has(key))) {
    return true;
  }
  const knowledgeInitialization = settingsRecord(knowledgeBase?.initialization);
  if (knowledgeInitialization && Object.hasOwn(knowledgeInitialization, "rulesFilePath")) {
    return true;
  }
  const resources = settingsRecord(data.resources);
  if (!resources) return false;
  if (Object.hasOwn(resources, "enabledByScope")) return true;
  return Array.isArray(resources.catalog) && resources.catalog.some((resource) => {
    const record = settingsRecord(resource);
    return Boolean(record && Object.hasOwn(record, "scopes"));
  });
}

function hasLegacyTokenPlanCustomProvider(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const provider = settingsRecord(item);
    return provider?.providerId === "custom"
      && typeof provider.baseUrl === "string"
      && isQwenTokenPlanApiProviderUrl(provider.baseUrl.trim());
  });
}

const KNOWLEDGE_BASE_SETTINGS_KEYS = new Set<string>([
  "lastRunAt",
  "lastRunStatus",
  "lastReportPath",
  "lastError",
  "lastSummary",
  "lastCompletion",
  "lastPendingSources",
  "lastWarnings",
  "initialization",
  "processedSources",
  "healthHistory",
  "maintenanceHistory"
]);

export function getActiveApiProvider(settings: Pick<CodexForObsidianSettings, "activeApiProviderId" | "apiProviders">): ApiProviderConfig | null {
  return settings.apiProviders.find((provider) => provider.id === settings.activeApiProviderId) ?? null;
}

export function apiProviderHasUsableApiKey(provider: ApiProviderConfig): boolean {
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  return provider.authMode === "api-key"
    && (
      !apiProviderApiKeyRequired(providerId)
      || Boolean(provider.apiKey.trim())
    );
}

export function apiProviderHasUsableCredential(
  provider: ApiProviderConfig,
  openAICodexCredential: OAuthCredential | null
): boolean {
  return provider.authMode === "oauth"
    ? normalizeApiProviderId(
        provider.providerId,
        provider.baseUrl,
        provider.name
      ) === "openai-codex"
      && openAICodexCredential !== null
    : apiProviderHasUsableApiKey(provider);
}

export function applyApiProviderPreset(
  settings: Pick<
    CodexForObsidianSettings,
    | "providerMode"
    | "activeApiProviderId"
  >,
  provider: ApiProviderConfig,
  providerId: ApiProviderId
): void {
  const preset = getApiProviderPreset(providerId);
  provider.providerId = preset.id;
  provider.runtimeProviderId = preset.runtimeProviderId;
  provider.apiProtocol = preset.apiProtocol;
  provider.authMode = preset.authMode;
  provider.name = preset.name;
  provider.baseUrl = preset.baseUrl;
  provider.models = preset.model
    ? [createApiProviderModelConfig(preset.id, preset.model)]
    : [];
  provider.defaultModelId = provider.models[0]?.id ?? "";
  delete provider.queryParams;
  clearApiProviderApiKey(settings, provider);
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
}

export function createApiProviderConfig(
  providerId: ApiProviderId = "deepseek",
  id = newId("provider")
): ApiProviderConfig {
  const preset = getApiProviderPreset(providerId);
  const models = preset.model
    ? [createApiProviderModelConfig(preset.id, preset.model)]
    : [];
  return {
    id,
    providerId: preset.id,
    runtimeProviderId: preset.runtimeProviderId,
    apiProtocol: preset.apiProtocol,
    authMode: preset.authMode,
    name: preset.name,
    baseUrl: preset.baseUrl,
    models,
    defaultModelId: models[0]?.id ?? "",
    apiKey: ""
  };
}

export function createApiProviderModelConfig(
  providerId: ApiProviderId,
  modelId: string,
  runtimeProviderId = getApiProviderPreset(providerId).runtimeProviderId
): ApiProviderModelConfig {
  const id = modelId.trim();
  const preset = getApiProviderModelPreset(providerId, id);
  if (preset) {
    return {
      id: preset.id,
      displayName: preset.displayName ?? preset.id,
      input: preset.imageInput ? ["text", "image"] : ["text"],
      toolCalling: preset.toolCalling,
      reasoning: preset.reasoning,
      reasoningEnabled: preset.reasoning,
      contextWindow: preset.contextWindow,
      modelMaxTokens: preset.modelMaxTokens,
      maxOutputTokens: preset.maxOutputTokens,
      metadataSource: "preset"
    };
  }
  const catalogModel = resolveEchoInkPiCatalogModel(runtimeProviderId, id);
  if (catalogModel) {
    return {
      id: catalogModel.id,
      displayName: catalogModel.name.trim() || catalogModel.id,
      input: catalogModel.input.includes("image")
        ? ["text", "image"]
        : ["text"],
      // Pi's public chat-model wrappers contain only tool-capable models. Pi
      // Model has no separate toolCalling field; input is not used to infer it.
      toolCalling: true,
      reasoning: catalogModel.reasoning,
      reasoningEnabled: catalogModel.reasoning,
      contextWindow: catalogModel.contextWindow,
      modelMaxTokens: catalogModel.maxTokens,
      maxOutputTokens: Math.min(
        catalogModel.contextWindow,
        catalogModel.maxTokens,
        apiProviderMaxOutputReserve(
          providerId,
          catalogModel.id,
          catalogModel.maxTokens
        )
      ),
      metadataSource: "catalog"
    };
  }
  return {
    id,
    displayName: id,
    input: ["text"],
    toolCalling: false,
    // Provider discovery often returns models newer than the pinned Pi
    // catalog. Product default assumes deep reasoning until the user turns it
    // off; an explicit catalog/preset `false` above still wins.
    reasoning: true,
    reasoningEnabled: true,
    contextWindow: 64_000,
    modelMaxTokens: 8_192,
    maxOutputTokens: 8_192,
    metadataSource: "unknown"
  };
}

export function applyApiProviderModelLimitsOverride(
  model: ApiProviderModelConfig,
  providerId: ApiProviderId,
  runtimeProviderId: string,
  value: unknown
): void {
  const limitsOverride = normalizeApiProviderModelLimitsOverride(value);
  const baseline = createApiProviderModelConfig(
    providerId,
    model.id,
    runtimeProviderId
  );
  if (limitsOverride.contextWindow === baseline.contextWindow) {
    delete limitsOverride.contextWindow;
  }
  if (limitsOverride.modelMaxTokens === baseline.modelMaxTokens) {
    delete limitsOverride.modelMaxTokens;
  }
  const contextWindow = limitsOverride.contextWindow
    ?? baseline.contextWindow;
  const modelMaxTokens = limitsOverride.modelMaxTokens
    ?? baseline.modelMaxTokens;
  const automaticMaxOutputTokens = Math.min(
    baseline.maxOutputTokens,
    contextWindow,
    modelMaxTokens,
    1_000_000
  );
  if (
    limitsOverride.maxOutputTokens !== undefined
    && Math.min(
      limitsOverride.maxOutputTokens,
      contextWindow,
      modelMaxTokens,
      1_000_000
    ) === automaticMaxOutputTokens
  ) {
    delete limitsOverride.maxOutputTokens;
  }
  const requestedMaxOutputTokens = limitsOverride.maxOutputTokens
    ?? baseline.maxOutputTokens;
  model.contextWindow = contextWindow;
  model.modelMaxTokens = modelMaxTokens;
  model.maxOutputTokens = Math.min(
    requestedMaxOutputTokens,
    contextWindow,
    modelMaxTokens,
    1_000_000
  );
  if (Object.keys(limitsOverride).length > 0) {
    model.limitsOverride = limitsOverride;
  } else {
    delete model.limitsOverride;
  }
}

export function applyApiProviderModelPreset(
  provider: ApiProviderConfig,
  modelId: string
): boolean {
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  const modelPreset = getApiProviderModelPreset(providerId, modelId);
  if (!modelPreset) return false;
  const model = createApiProviderModelConfig(providerId, modelPreset.id);
  const index = provider.models.findIndex((entry) => entry.id === model.id);
  if (index >= 0) {
    const previous = provider.models[index];
    const previousEffort = previous?.reasoningEffort;
    model.reasoningEnabled = Boolean(previous?.reasoningEnabled && model.reasoning);
    if (previousEffort && previousEffort !== "none") {
      model.reasoningEffort = previousEffort;
    }
    if (previous) {
      clearApiProviderModelInvalidStoredReasoningEffort(provider.id, previous);
    }
    provider.models[index] = model;
  }
  else provider.models.push(model);
  provider.defaultModelId = model.id;
  return true;
}

export function getApiProviderModel(
  provider: Pick<ApiProviderConfig, "models">,
  modelId: string
): ApiProviderModelConfig | null {
  return provider.models.find((model) => model.id === modelId) ?? null;
}

export function getDefaultApiProviderModel(
  provider: Pick<ApiProviderConfig, "models" | "defaultModelId">
): ApiProviderModelConfig | null {
  return getApiProviderModel(provider, provider.defaultModelId);
}

export function getActiveApiProviderModel(
  settings: Pick<
    CodexForObsidianSettings,
    "activeApiProviderId" | "apiProviders" | "defaultModel"
  >
): Readonly<{
  provider: ApiProviderConfig;
  model: ApiProviderModelConfig;
}> | null {
  const provider = getActiveApiProvider(settings);
  if (!provider) return null;
  const model = getApiProviderModel(provider, settings.defaultModel);
  return model ? { provider, model } : null;
}

export function setApiProviderDefaultModel(
  provider: Pick<ApiProviderConfig, "models" | "defaultModelId">,
  modelId: string
): boolean {
  if (!getApiProviderModel(provider, modelId)) return false;
  provider.defaultModelId = modelId;
  return true;
}

export function apiProviderModelSupportsImage(
  model: Pick<ApiProviderModelConfig, "input">
): boolean {
  return model.input.includes("image");
}

export function activateApiProvider(
  settings: Pick<
    CodexForObsidianSettings,
    | "providerMode"
    | "activeApiProviderId"
    | "defaultModel"
  >,
  provider: ApiProviderConfig
): void {
  activateApiProviderModel(settings, provider, provider.defaultModelId);
}

export function activateApiProviderModel(
  settings: Pick<
    CodexForObsidianSettings,
    | "providerMode"
    | "activeApiProviderId"
    | "defaultModel"
  >,
  provider: ApiProviderConfig,
  modelId: string
): void {
  if (!getApiProviderModel(provider, modelId)) {
    throw new Error("provider_model_unavailable");
  }
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
  settings.defaultModel = modelId;
}

export function clearApiProviderApiKey(
  settings: Pick<
    CodexForObsidianSettings,
    "providerMode" | "activeApiProviderId"
  >,
  provider: ApiProviderConfig
): void {
  provider.apiKey = "";
  settings.providerMode = "custom-api";
  settings.activeApiProviderId = provider.id;
}

export function getApiProviderModels(
  provider: Pick<ApiProviderConfig, "models">
): string[] {
  return provider.models.map((model) => model.id);
}

export function providerModelLabel(
  provider: Pick<ApiProviderConfig, "models" | "defaultModelId">,
  language: SettingsLanguage = "zh-CN"
): string {
  const models = getApiProviderModels(provider);
  if (!models.length) return language === "en" ? "No model set" : "未设置模型";
  const primary = provider.defaultModelId || models[0];
  return models.length === 1 ? primary : language === "en" ? `${primary} + ${models.length - 1} more` : `${primary} 等 ${models.length} 个`;
}

export function sanitizeCredentialSettingsForDataSave(
  settings: CodexForObsidianSettings
): void {
  assertCredentialSettingsReadyForDataSave(settings);
  if (
    settings.proxyEndpoint
    || settings.proxyCredentialRef
  ) {
    settings.proxyUrl = "";
  }
}

export type CredentialSettingsPersistenceErrorCode =
  "proxy_credential_plaintext_unmigrated";

export class CredentialSettingsPersistenceError extends Error {
  constructor(readonly code: CredentialSettingsPersistenceErrorCode) {
    super(code);
    this.name = "CredentialSettingsPersistenceError";
  }
}

function assertCredentialSettingsReadyForDataSave(
  settings: CodexForObsidianSettings
): void {
  const proxyUrls = [settings.proxyUrl];
  const proxyEndpoints = [settings.proxyEndpoint];
  if (proxyEndpoints.some(proxyUrlContainsCredential)) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
  if (!proxyUrls.some(proxyUrlContainsCredential)) return;

  const topLevelCredentialRef = normalizeCredentialRef(
    settings.proxyCredentialRef
  );
  const topLevelEndpoint = normalizeOptionalText(settings.proxyEndpoint);
  if (
    !topLevelCredentialRef
    || !topLevelEndpoint
  ) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
}

function proxyUrlContainsCredential(value: unknown): boolean {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return false;
  if (
    raw !== raw.trim()
    || raw.includes("\\")
    || [...raw].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined
        && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)
    ? raw
    : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || !parsed.hostname
      || (parsed.pathname !== "" && parsed.pathname !== "/")
    ) {
      throw new CredentialSettingsPersistenceError(
        "proxy_credential_plaintext_unmigrated"
      );
    }
    return (
      parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
    );
  } catch (error) {
    if (error instanceof CredentialSettingsPersistenceError) {
      throw error;
    }
    throw new CredentialSettingsPersistenceError(
      "proxy_credential_plaintext_unmigrated"
    );
  }
}

export function validateApiProvider(provider: Pick<ApiProviderConfig,
  | "name"
  | "baseUrl"
  | "models"
  | "defaultModelId"
  | "apiKey"
  | "apiProtocol"
  | "authMode"
  | "runtimeProviderId"
> & Partial<Pick<ApiProviderConfig,
  "providerId"
>>, language: SettingsLanguage = "zh-CN"): string[] {
  const errors: string[] = [];
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  if (provider.authMode !== apiProviderAuthMode(providerId)) {
    errors.push(language === "en" ? "Authentication mode is invalid" : "认证方式无效");
  }
  if (!provider.name.trim()) errors.push(language === "en" ? "Name is required" : "名称不能为空");
  if (!provider.baseUrl.trim()) errors.push(language === "en" ? "Base URL is required" : "Base URL 不能为空");
  if (provider.baseUrl.trim()) {
    try {
      normalizeApiProviderBaseUrl(
        provider.baseUrl,
        provider.apiProtocol
      );
    } catch {
      errors.push(language === "en" ? "API URL must use HTTPS or exact loopback HTTP" : "API URL 必须使用 HTTPS；本地仅允许精确 loopback HTTP 地址");
    }
  }
  if (
    providerId === "ollama"
    && provider.baseUrl.trim()
    && !isLoopbackApiProviderUrl(provider.baseUrl)
  ) {
    errors.push(language === "en"
      ? "Ollama must use an exact local loopback address"
      : "Ollama 只允许使用精确的本机 loopback 地址");
  }
  if (provider.models.length === 0) {
    errors.push(language === "en"
      ? "Select at least one model"
      : "至少选择一个模型");
  }
  const seenModelIds = new Set<string>();
  for (const model of provider.models) {
    if (
      !isValidApiProviderModelConfig(model)
      || seenModelIds.has(model.id)
    ) {
      errors.push(language === "en"
        ? "Model metadata is invalid"
        : "模型元数据无效");
      break;
    }
    seenModelIds.add(model.id);
  }
  if (
    !isValidApiProviderModelId(provider.defaultModelId)
    || !seenModelIds.has(provider.defaultModelId)
  ) {
    errors.push(language === "en"
      ? "Choose a valid default model"
      : "请选择有效的默认模型");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(provider.runtimeProviderId)) {
    errors.push(language === "en" ? "Runtime Provider ID is invalid" : "Runtime Provider ID 无效");
  }
  if (
    apiProviderApiKeyRequired(providerId)
    && !provider.apiKey.trim()
  ) {
    errors.push(language === "en" ? "API key is required" : "API key 不能为空");
  }
  return errors;
}

export function isValidApiProviderModelId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !/[\s\p{Cc}]/u.test(value);
}

export function isValidApiProviderModelConfig(
  value: unknown
): value is ApiProviderModelConfig {
  const model = settingsRecord(value);
  if (!model || !isValidApiProviderModelId(model.id)) return false;
  if (
    typeof model.displayName !== "string"
    || !model.displayName.trim()
    || !Array.isArray(model.input)
    || !model.input.includes("text")
    || model.input.some((entry) => entry !== "text" && entry !== "image")
    || typeof model.toolCalling !== "boolean"
    || typeof model.reasoning !== "boolean"
    || typeof model.reasoningEnabled !== "boolean"
    || (model.reasoningEnabled && !model.reasoning)
    || (
      model.reasoningEffort !== undefined
      && (
        !normalizeEchoInkReasoningEffort(model.reasoningEffort)
        || model.reasoningEffort === "none"
      )
    )
    || !["preset", "catalog", "unknown", "manual"].includes(String(model.metadataSource))
    || !isValidApiProviderModelLimitsOverride(model.limitsOverride)
  ) return false;
  const contextWindow = model.contextWindow;
  const modelMaxTokens = model.modelMaxTokens;
  const maxOutputTokens = model.maxOutputTokens;
  return Number.isSafeInteger(contextWindow)
    && Number(contextWindow) >= 1_024
    && Number(contextWindow) <= 2_000_000
    && Number.isSafeInteger(modelMaxTokens)
    && Number(modelMaxTokens) >= 1
    && Number(modelMaxTokens) <= 1_000_000
    && Number.isSafeInteger(maxOutputTokens)
    && Number(maxOutputTokens) >= 1
    && Number(maxOutputTokens) <= Math.min(
      Number(contextWindow),
      Number(modelMaxTokens),
      1_000_000
    );
}

function isValidApiProviderModelLimitsOverride(value: unknown): boolean {
  if (value === undefined) return true;
  const record = settingsRecord(value);
  if (!record) return false;
  const allowed = new Set([
    "contextWindow",
    "modelMaxTokens",
    "maxOutputTokens"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  const normalized = normalizeApiProviderModelLimitsOverride(record);
  return Object.keys(record).every((key) =>
    normalized[key as keyof ApiProviderModelLimitsOverride] === record[key]
  );
}

export function removeApiProvider(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, providerId: string): boolean {
  const index = settings.apiProviders.findIndex((provider) => provider.id === providerId);
  if (index < 0) return false;
  const removed = settings.apiProviders[index];
  for (const model of removed?.models ?? []) {
    clearApiProviderModelInvalidStoredReasoningEffort(providerId, model);
  }
  const wasActive = settings.activeApiProviderId === providerId;
  settings.apiProviders.splice(index, 1);
  if (wasActive) {
    const next = settings.apiProviders[Math.min(index, settings.apiProviders.length - 1)];
    settings.activeApiProviderId = next?.id ?? "";
    if (!next) settings.providerMode = "custom-api";
  }
  return true;
}

export function selectActiveConversationSession(
  settings: Pick<
    CodexForObsidianSettings,
    "sessions" | "activeSessionId"
  >
): StoredSession | null {
  const active = settings.sessions.find(
    (session) => session.id === settings.activeSessionId
  );
  if (active) return active;
  const fallback = settings.sessions[0] ?? null;
  settings.activeSessionId = fallback?.id ?? "";
  return fallback;
}

export function providerConnectionLabel(settings: Pick<CodexForObsidianSettings, "providerMode" | "activeApiProviderId" | "apiProviders">, language: SettingsLanguage = "zh-CN"): string {
  const provider = getActiveApiProvider(settings);
  if (!provider) return language === "en" ? "Provider not configured" : "Provider 未配置";
  const providerId = normalizeApiProviderId(
    provider.providerId,
    provider.baseUrl,
    provider.name
  );
  return `${apiProviderConfiguredDisplayName(
    providerId,
    provider.name,
    language
  )} · ${providerModelLabel(provider, language)}`;
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

function normalizeResourceManagementTab(value: unknown): ResourceManagementTab {
  return value === "mcp" || value === "skills" || value === "plugins" ? value : DEFAULT_SETTINGS.resourceManagementTab;
}

function normalizeSettingsTab(value: unknown): SettingsTab {
  if (value === "agents") return "providers";
  return value === "providers"
    || value === "resources"
    || value === "knowledgeBase"
    || value === "review"
    || value === "general"
    ? value
    : DEFAULT_SETTINGS.settingsTab;
}

export function normalizeSettingsLanguage(value: unknown): SettingsLanguage {
  return value === "en" ? "en" : DEFAULT_SETTINGS.settingsLanguage;
}

function normalizeProviderMode(value: unknown): ProviderMode {
  return value === "custom-api" ? "custom-api" : DEFAULT_SETTINGS.providerMode;
}

function normalizeKnowledgeBaseRunStatus(value: unknown): KnowledgeBaseRunStatus {
  return value === "running" || value === "success" || value === "failed" || value === "canceled" ? value : "idle";
}

function normalizeKnowledgeBaseInitStatus(value: unknown): KnowledgeBaseInitStatus {
  return value === "preview-ready" || value === "initialized" || value === "failed" ? value : "not-started";
}

function normalizeEchoInkResourceSettings(value: unknown, legacyWorkspaceResources: unknown): EchoInkResourceSettings {
  void legacyWorkspaceResources;
  const record = settingsRecord(value) ?? {};
  const fallback = defaultResourceSettings();
  const enabledByScope = settingsRecord(record.enabledByScope) ?? {};
  const legacyOverrides = Object.values(enabledByScope)
    .map(normalizeBooleanMap);
  const importedFrom = settingsRecord(record.importedFrom);
  const catalog = Array.isArray(record.catalog)
    ? record.catalog.filter(isEchoInkResourceLike).map((resource) => {
        const legacyValues = legacyOverrides.flatMap((overrides) =>
          typeof overrides[resource.id] === "boolean" ? [overrides[resource.id]] : []);
        const enabled = legacyValues.includes(false)
          ? false
          : legacyValues.includes(true)
            ? true
            : resource.enabled !== false;
        const { scopes: _legacyScopes, ...current } = resource as EchoInkResourceSettings["catalog"][number] & { scopes?: unknown };
        return { ...current, enabled };
      })
    : [];
  const catalogIds = new Set(catalog.map((resource) => resource.id));
  const legacyEnabledOverrides = Object.fromEntries([
    ...Object.entries(normalizeBooleanMap(record.legacyEnabledOverrides)),
    ...legacyResourceDecisions(legacyOverrides)
  ].filter(([resourceId]) => !catalogIds.has(resourceId)));
  return {
    catalog,
    ...(Object.keys(legacyEnabledOverrides).length ? { legacyEnabledOverrides } : {}),
    importedFrom: importedFrom
      ? Object.fromEntries(Object.entries(importedFrom).map(([key, raw]) => [key, normalizeNonNegativeNumber(raw)]))
      : fallback.importedFrom,
    mcpConnections: normalizeMcpConnectionRecords(record.mcpConnections ?? fallback.mcpConnections),
    lastScannedAt: normalizeNonNegativeNumber(record.lastScannedAt),
    lastError: normalizeOptionalText(record.lastError)
  };
}

function legacyResourceDecisions(
  overrides: Array<Record<string, boolean>>
): Array<[string, boolean]> {
  const ids = new Set<string>();
  for (const values of overrides) {
    for (const resourceId of Object.keys(values)) ids.add(resourceId);
  }
  return Array.from(ids).map((resourceId) => {
    const values = overrides.flatMap((scope) =>
      typeof scope[resourceId] === "boolean" ? [scope[resourceId]] : []);
    return [resourceId, !values.includes(false) && values.includes(true)];
  });
}

function normalizePermissionMode(value: unknown, fallback: PermissionMode): PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : fallback;
}

function normalizeUiMode(value: unknown, fallback: UiMode): UiMode {
  return value === "agent" || value === "plan" ? value : fallback;
}

function normalizeSetupSettings(input: unknown): SetupSettings {
  const value = settingsRecord(input) ?? {};
  const tutorialStep = value?.tutorialStep;
  return {
    completedAt: normalizeNonNegativeNumber(value?.completedAt),
    lastCheckedAt: normalizeNonNegativeNumber(value?.lastCheckedAt),
    dismissedVersion: normalizeOptionalText(value?.dismissedVersion),
    tutorialVersion: normalizeOptionalText(value?.tutorialVersion),
    tutorialStep: tutorialStep === "settings"
      || tutorialStep === "provider"
      || tutorialStep === "knowledge"
      || tutorialStep === "personality"
      ? tutorialStep
      : "sidebar"
  };
}

function normalizeWelcomeLine(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeMemorySettings(input: unknown): EchoInkMemorySettings {
  const value = settingsRecord(input) ?? {};
  const runsPerDay = typeof value?.dreamRunsPerDay === "number" && Number.isSafeInteger(value.dreamRunsPerDay)
    ? Math.max(1, Math.min(6, value.dreamRunsPerDay))
    : 3;
  const tokenBudget = typeof value?.dreamTokenBudget === "number" && Number.isSafeInteger(value.dreamTokenBudget)
    ? Math.max(1000, Math.min(200000, value.dreamTokenBudget))
    : 50000;
  return {
    useLongTermMemory: value?.useLongTermMemory !== false,
    dreamEnabled: value?.dreamEnabled !== false,
    dreamRunsPerDay: runsPerDay,
    dreamTokenBudget: tokenBudget
  };
}

function normalizeKnowledgeBaseSettings(input: unknown): KnowledgeBaseSettings {
  const value = settingsRecord(input) ?? {};
  const normalized: KnowledgeBaseSettings = {
    lastRunAt: normalizeNonNegativeNumber(value?.lastRunAt),
    lastRunStatus: normalizeKnowledgeBaseRunStatus(value?.lastRunStatus),
    lastReportPath: normalizeOptionalText(value?.lastReportPath),
    lastError: normalizeOptionalText(value?.lastError),
    lastSummary: normalizeOptionalText(value?.lastSummary),
    lastCompletion: normalizeKnowledgeBaseRunCompletion(value?.lastCompletion),
    lastPendingSources: normalizeKnowledgeBasePendingSources(value?.lastPendingSources),
    lastWarnings: normalizeKnowledgeBaseRunWarnings(value?.lastWarnings),
    initialization: normalizeKnowledgeBaseInitialization(value?.initialization),
    processedSources: normalizeKnowledgeBaseProcessedSources(value?.processedSources),
    healthHistory: normalizeKnowledgeBaseHealthHistory(value?.healthHistory),
    maintenanceHistory: normalizeKnowledgeBaseMaintenanceHistory(value?.maintenanceHistory)
  };
  return normalized;
}

function normalizeReviewSettings(input: unknown): WeeklyReviewSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.review;
  const outputDir = normalizeReviewOutputDir(value?.outputDir, fallback.outputDir);
  const reports = settingsRecord(value?.reports) ?? {};
  return {
    enabled: value?.enabled === true,
    knowledgeBaseEnabled: typeof value?.knowledgeBaseEnabled === "boolean" ? value.knowledgeBaseEnabled : fallback.knowledgeBaseEnabled,
    agentChatEnabled: typeof value?.agentChatEnabled === "boolean" ? value.agentChatEnabled : fallback.agentChatEnabled,
    scheduleTime: normalizeScheduleTime(value?.scheduleTime, fallback.scheduleTime),
    catchUpOnStartup: value?.catchUpOnStartup !== false,
    outputDir,
    rangeMode: normalizeReviewRangeMode(value?.rangeMode, fallback.rangeMode),
    openHtmlAfterRun: value?.openHtmlAfterRun === true,
    reports: {
      knowledgeBase: normalizeReviewReportState(reports.knowledgeBase),
      agentChat: normalizeReviewReportState(reports.agentChat)
    }
  };
}

function normalizeReviewReportState(input: unknown): ReviewReportState {
  const value = settingsRecord(input) ?? {};
  return {
    lastRangeKey: normalizeReviewRangeKey(value?.lastRangeKey)
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
  if (raw === ".") return ".";
  const clean = raw
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || fallback;
}

function normalizeKnowledgeBaseInitialization(input: unknown): KnowledgeBaseInitializationSettings {
  const value = settingsRecord(input) ?? {};
  const fallback = DEFAULT_SETTINGS.knowledgeBase.initialization;
  return {
    status: normalizeKnowledgeBaseInitStatus(value?.status),
    initializedAt: normalizeNonNegativeNumber(value?.initializedAt),
    templateVersion: normalizeText(value?.templateVersion, fallback.templateVersion),
    lastPreviewSummary: normalizeOptionalText(value?.lastPreviewSummary)
  };
}

function normalizeStoredSessions(value: unknown): StoredSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rawSession: unknown): StoredSession | null => {
      const session = settingsRecord(rawSession) ?? {};
      if (session.kind === "knowledge-base") return null;
      const id = normalizeOptionalText(session.id);
      if (!id) return null;
      const messages = normalizeChatMessages(session.messages);
      const piSessionId = normalizeOptionalText(session.piSessionId) || undefined;
      const defaultSkillId = normalizeStoredSessionSkillId(
        session.defaultSkillId
      );
      const journalDirectory = normalizedJournalDirectoryOrNull(
        session.journalDirectory
      ) ?? undefined;
      const parsedContextLedger = parsePiContextLedger(session.contextLedger);
      const contextLedger = parsedContextLedger
        && parsedContextLedger.conversationId === id
        && (!piSessionId || parsedContextLedger.piSessionId === piSessionId)
        ? parsedContextLedger
        : undefined;
      const bodyAuthority = normalizeStoredSessionBodyAuthority(
        session.bodyAuthority
      );
      const piImageAttachments = bodyAuthority === "pi_session_only"
        ? sanitizeStoredPiImageAttachments(session.piImageAttachments)
        : undefined;
      const piDocumentReplay = bodyAuthority === "pi_session_only"
        ? sanitizeStoredPiDocumentReplay(session.piDocumentReplay)
        : undefined;
      const unreadAnswerAt = normalizeStoredSessionUnreadAnswerAt(
        session.unreadAnswerAt
      );
      return {
        id,
        title: normalizeText(session.title, "新会话"),
        piSessionId,
        defaultMemoryMode: normalizeStoredSessionMemoryMode(session.defaultMemoryMode),
        ...(defaultSkillId ? { defaultSkillId } : {}),
        ...(journalDirectory ? { journalDirectory } : {}),
        bodyAuthority,
        cwd: normalizeOptionalText(session.cwd),
        messages,
        tokenUsage: session.tokenUsage as TokenUsage,
        contextLedger,
        ...(unreadAnswerAt === undefined ? {} : { unreadAnswerAt }),
        ...(piImageAttachments ? { piImageAttachments } : {}),
        ...(piDocumentReplay ? { piDocumentReplay } : {}),
        createdAt: normalizeNonNegativeNumber(session.createdAt),
        updatedAt: normalizeNonNegativeNumber(session.updatedAt)
      };
    })
    .filter((session): session is StoredSession => Boolean(session));
}

function normalizeStoredSessionUnreadAnswerAt(
  value: unknown
): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    ? value
    : undefined;
}

function normalizeStoredSessionMemoryMode(
  value: unknown
): StoredSession["defaultMemoryMode"] {
  return value === "normal" || value === "no_memory" ? value : undefined;
}

function normalizeStoredSessionSkillId(value: unknown): string | undefined {
  const id = normalizeOptionalText(value);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ? id : undefined;
}

function normalizeStoredSessionBodyAuthority(
  value: unknown
): StoredSession["bodyAuthority"] {
  return value === "pi_session_only" ? value : undefined;
}

export function sanitizeStoredPiImageAttachments(
  value: unknown
): StoredPiImageAttachmentsByEntry | undefined {
  const record = settingsRecord(value);
  if (!record) return undefined;
  const entries: Array<[
    string,
    readonly Readonly<StoredPiImageAttachmentMetadata>[]
  ]> = [];
  for (const [rawEntryId, rawAttachments] of Object.entries(record)) {
    const entryId = rawEntryId.trim();
    if (!entryId || !Array.isArray(rawAttachments)) continue;
    const attachments = rawAttachments
      .map((raw): StoredPiImageAttachmentMetadata | null => {
        const item = settingsRecord(raw);
        if (!item) return null;
        const name = normalizeOptionalText(item.name);
        const path = normalizeOptionalText(item.path);
        const mimeType = normalizeStoredPiImageMimeType(item.mimeType);
        if (!name || !path || !mimeType) return null;
        const availability = normalizeStoredAttachmentAvailability(
          item.availability
        );
        return Object.freeze({
          name,
          path,
          mimeType,
          ...(availability ? { availability } : {})
        });
      })
      .filter((item): item is StoredPiImageAttachmentMetadata => Boolean(item));
    if (attachments.length) {
      entries.push([entryId, Object.freeze(attachments)]);
    }
  }
  return entries.length
    ? Object.freeze(Object.fromEntries(entries))
    : undefined;
}

export function sanitizeStoredPiDocumentReplay(
  value: unknown
): StoredPiDocumentReplayByEntry | undefined {
  const source = settingsRecord(value);
  if (!source) return undefined;
  const entries: Array<[
    string,
    readonly Readonly<StoredPiDocumentReplayMetadata>[]
  ]> = [];
  for (const [rawEntryId, rawDocuments] of Object.entries(source)) {
    const entryId = rawEntryId.trim();
    if (!entryId || !Array.isArray(rawDocuments)) continue;
    const documents = rawDocuments
      .map((raw): StoredPiDocumentReplayMetadata | null => {
        const item = settingsRecord(raw);
        if (!item) return null;
        const name = normalizeOptionalText(item.name);
        const mimeType = normalizeOptionalText(item.mimeType).toLowerCase();
        const sizeBytes = item.sizeBytes;
        const kind = item.kind;
        const sha256 = normalizeOptionalText(item.sha256).toLowerCase();
        const text = typeof item.text === "string"
          ? item.text.replace(/\u0000/gu, "").trim()
          : item.text === null
            ? null
            : undefined;
        if (
          !name
          || !mimeType
          || !Number.isSafeInteger(sizeBytes)
          || (sizeBytes as number) < 1
          || (sizeBytes as number) > 20 * 1024 * 1024
          || (kind !== "pdf" && kind !== "word" && kind !== "markdown" && kind !== "html")
          || !/^[a-f0-9]{64}$/u.test(sha256)
          || text === undefined
          || (text === null && (kind !== "pdf" || mimeType !== "application/pdf"))
          || (typeof text === "string" && (
            !text
            || new TextEncoder().encode(text).byteLength > 20 * 1024 * 1024
          ))
        ) return null;
        return Object.freeze({
          name,
          mimeType,
          sizeBytes: sizeBytes as number,
          kind,
          sha256,
          text
        });
      })
      .filter((item): item is StoredPiDocumentReplayMetadata => Boolean(item));
    if (documents.length) entries.push([entryId, Object.freeze(documents)]);
  }
  return entries.length
    ? Object.freeze(Object.fromEntries(entries))
    : undefined;
}

function normalizeStoredAttachmentAvailability(
  value: unknown
): StoredAttachment["availability"] {
  return value === "available" || value === "unavailable"
    ? value
    : undefined;
}

function normalizeStoredPiImageMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mimeType = value.trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  return mimeType === "image/png"
    || mimeType === "image/jpeg"
    || mimeType === "image/gif"
    || mimeType === "image/webp"
    || mimeType === "image/bmp"
    || mimeType === "image/heic"
    || mimeType === "image/heif"
    || mimeType === "image/svg+xml"
    ? mimeType
    : undefined;
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
      assignOptionalText(message, "providerId", item.providerId ?? item.provider);
      assignOptionalText(message, "modelId", item.modelId ?? item.model);
      assignOptionalText(message, "profileId", item.profileId ?? item.profile);
      message.runTerminalRecoveryPending = normalizeRunTerminalRecoveryPending(item.runTerminalRecoveryPending);
      message.echoInkRunTerminalRecovery = normalizeEchoInkChatRunTerminalRecovery(
        item.echoInkRunTerminalRecovery
      );
      if (!message.echoInkRunTerminalRecovery) {
        delete message.echoInkRunTerminalRecovery;
      }
      if (typeof item.runTerminalRecovered === "boolean") message.runTerminalRecovered = item.runTerminalRecovered;
      else delete message.runTerminalRecovered;
      message.runUsage = normalizeHarnessRunUsage(item.runUsage);
      if (!message.runUsage) delete message.runUsage;
      message.approval = normalizeChatMessageApproval(item.approval);
      if (!message.approval) delete message.approval;
      try {
        message.taskPlan = normalizeEchoInkTaskPlanSnapshot(item.taskPlan);
      } catch {
        delete message.taskPlan;
      }
      try {
        message.reasoningSummary = normalizeEchoInkReasoningSummarySnapshot(
          item.reasoningSummary
        );
      } catch {
        delete message.reasoningSummary;
      }
      message.createdAt = normalizeNonNegativeNumber(item.createdAt);
      message.completedAt = normalizeOptionalPositiveNumber(item.completedAt);
      return message;
    })
    .filter((message): message is ChatMessage => Boolean(message));
}

function normalizeChatMessageApproval(
  value: unknown
): ChatMessage["approval"] {
  const approval = settingsRecord(value);
  if (!approval) return undefined;
  const status = approval.status;
  if (
    status !== "pending"
    && status !== "approved"
    && status !== "denied"
    && status !== "expired"
    && status !== "cancelled"
  ) return undefined;
  const target = normalizeOptionalText(approval.target);
  const preview = normalizeOptionalText(approval.preview);
  const updatedAt = normalizeOptionalPositiveNumber(approval.updatedAt);
  return Object.freeze({
    status,
    ...(target ? { target } : {}),
    ...(preview ? { preview } : {}),
    ...(updatedAt === undefined ? {} : { updatedAt })
  });
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
  return value === "completed" || value === "cancelled" || value === "failed"
    ? value
    : undefined;
}

function normalizeEchoInkChatRunTerminalRecovery(
  value: unknown
): ChatMessage["echoInkRunTerminalRecovery"] {
  const marker = settingsRecord(value);
  if (
    !marker
    || marker.namespace !== "echoink.chat-terminal"
    || marker.schemaVersion !== 1
  ) {
    return undefined;
  }
  const runId = normalizeOptionalText(marker.runId);
  const status = normalizeRunTerminalRecoveryPending(marker.status);
  const payloadHash = normalizeOptionalText(marker.payloadHash);
  const terminalCommitId = normalizeOptionalText(marker.terminalCommitId);
  const carrierMessageId = normalizeOptionalText(marker.carrierMessageId);
  const payloadSource = normalizeEchoInkChatTerminalPayloadSource(
    marker.payloadSource
  );
  if (
    !runId
    || !status
    || !payloadHash
    || !terminalCommitId
    || !carrierMessageId
    || !payloadSource
    || typeof marker.payloadPresent !== "boolean"
  ) {
    return undefined;
  }
  const backendId = normalizeOptionalText(marker.backendId);
  const data = marker.data === undefined
    ? undefined
    : settingsRecord(marker.data) ?? undefined;
  if (marker.data !== undefined && !data) return undefined;
  return {
    namespace: "echoink.chat-terminal",
    schemaVersion: 1,
    runId,
    status,
    ...(backendId ? { backendId } : {}),
    ...(data ? { data } : {}),
    payloadPresent: marker.payloadPresent,
    payloadHash,
    terminalCommitId,
    carrierMessageId,
    payloadSource
  };
}

function normalizeEchoInkChatTerminalPayloadSource(
  value: unknown
): EchoInkChatTerminalPayloadSource | undefined {
  const source = settingsRecord(value);
  if (!source) return undefined;
  const contentHash = normalizeOptionalText(source.contentHash);
  const size = normalizeOptionalNonNegativeInteger(source.size);
  const lines = normalizeOptionalNonNegativeInteger(source.lines);
  if (!contentHash || size === undefined || lines === undefined) {
    return undefined;
  }
  if (source.kind === "inline" && typeof source.value === "string") {
    return {
      kind: "inline",
      value: source.value,
      contentHash,
      size,
      lines
    };
  }
  const rawRef = normalizeOptionalText(source.rawRef);
  const previewHash = normalizeOptionalText(source.previewHash);
  if (source.kind !== "raw" || !rawRef || !previewHash) return undefined;
  return {
    kind: "raw",
    rawRef,
    contentHash,
    previewHash,
    size,
    lines
  };
}

function normalizeOptionalNonNegativeInteger(
  value: unknown
): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
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

const KNOWLEDGE_BASE_RESULT_MAX_PENDING_SOURCES = 50;
const KNOWLEDGE_BASE_RESULT_MAX_WARNINGS = 10;
const KNOWLEDGE_BASE_RESULT_MAX_MESSAGE_CHARS = 500;
const KNOWLEDGE_BASE_MAINTENANCE_HISTORY_MAX = 500;
const KNOWLEDGE_BASE_WORKFLOW_ID_MAX_CHARS = 512;

export function canonicalizeKnowledgeBaseMaintenanceHistoryEntry(
  value: unknown,
  legacyMode: KnowledgeBaseMaintenanceMode = "unknown"
): KnowledgeBaseMaintenanceHistoryEntry | null {
  const record = settingsRecord(value) ?? {};
  const date = normalizeOptionalText(record.date);
  const status = normalizeKnowledgeBaseMaintenanceTerminalStatus(record.status);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !status) return null;
  const at = normalizeNonNegativeNumber(record.at);
  const runId = normalizeLimitedText(
    record.runId,
    KNOWLEDGE_BASE_WORKFLOW_ID_MAX_CHARS
  );
  const mode = normalizeKnowledgeBaseMaintenanceMode(record.mode) ?? legacyMode;
  const reportPath = normalizeOptionalText(record.reportPath);
  const completion = normalizeKnowledgeBaseRunCompletion(record.completion);
  const pendingSources = normalizeKnowledgeBasePendingSources(record.pendingSources);
  const phase = normalizeLimitedText(record.phase, 160);
  const errorCode = normalizeLimitedText(record.errorCode, 160);
  const warnings = normalizeKnowledgeBaseRunWarnings(record.warnings);
  return {
    date,
    status,
    at,
    ...(runId ? { runId } : {}),
    mode,
    reportPath,
    ...(["completed", "partial", "noop", "failed", "write_uncertain", "cancelled"].includes(String(record.resultStatus))
      ? { resultStatus: record.resultStatus as KnowledgeBaseMaintenanceHistoryEntry["resultStatus"] } : {}),
    ...(completion ? { completion } : {}),
    ...(pendingSources.length ? { pendingSources } : {}),
    ...(phase ? { phase } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(warnings.length ? { warnings } : {})
  };
}

function normalizeKnowledgeBaseMaintenanceHistory(value: unknown, legacyHealthHistory?: unknown): KnowledgeBaseMaintenanceHistoryEntry[] {
  const byRun = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
  const add = (item: unknown, legacyMode: KnowledgeBaseMaintenanceMode): void => {
    const normalized =
      canonicalizeKnowledgeBaseMaintenanceHistoryEntry(item, legacyMode);
    if (!normalized) return;
    const key = normalized.runId || [
      normalized.date,
      normalized.at,
      normalized.mode,
      normalized.status,
      normalized.reportPath
    ].join("\u0000");
    byRun.set(key, normalized);
  };
  if (Array.isArray(value)) {
    for (const item of value) add(item, "unknown");
  }
  if (Array.isArray(legacyHealthHistory)) {
    const representedDates = new Set(Array.from(byRun.values()).map((entry) => entry.date));
    for (const item of legacyHealthHistory) {
      const record = settingsRecord(item) ?? {};
      const date = normalizeOptionalText(record.date);
      if (!representedDates.has(date)) add(item, "lint");
    }
  }
  return Array.from(byRun.values())
    .sort((left, right) =>
      left.at - right.at
      || left.date.localeCompare(right.date)
      || (left.runId ?? "").localeCompare(right.runId ?? ""))
    .slice(-KNOWLEDGE_BASE_MAINTENANCE_HISTORY_MAX);
}

function normalizeKnowledgeBaseMaintenanceTerminalStatus(value: unknown): KnowledgeBaseMaintenanceTerminalStatus | "" {
  return value === "success" || value === "failed" || value === "canceled" ? value : "";
}

function normalizeKnowledgeBaseRunCompletion(value: unknown): KnowledgeBaseRunCompletion | "" {
  return value === "full" || value === "partial" || value === "recovered" || value === "noop" ? value : "";
}

function normalizeKnowledgeBasePendingSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const source = normalizeLimitedText(item, 1000).replace(/\\/g, "/");
    if (!source || seen.has(source)) continue;
    seen.add(source);
    result.push(source);
    if (result.length >= KNOWLEDGE_BASE_RESULT_MAX_PENDING_SOURCES) break;
  }
  return result;
}

function normalizeKnowledgeBaseRunWarnings(value: unknown): KnowledgeBaseRunWarning[] {
  if (!Array.isArray(value)) return [];
  const result: KnowledgeBaseRunWarning[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const record = settingsRecord(value[index]);
    const message = normalizeLimitedText(record?.message ?? value[index], KNOWLEDGE_BASE_RESULT_MAX_MESSAGE_CHARS);
    if (!message) continue;
    const id = normalizeLimitedText(record?.id, 160) || `warning-${index + 1}`;
    result.push({ id, message });
    if (result.length >= KNOWLEDGE_BASE_RESULT_MAX_WARNINGS) break;
  }
  return result;
}

function normalizeLimitedText(value: unknown, maxChars: number): string {
  return normalizeOptionalText(value).slice(0, maxChars);
}

function normalizeKnowledgeBaseHealthCheckStatus(value: unknown): KnowledgeBaseHealthCheckStatus | null {
  return value === "success" || value === "failed" ? value : null;
}

function normalizeKnowledgeBaseMaintenanceMode(value: unknown): KnowledgeBaseMaintenanceMode | null {
  return value === "maintain" || value === "lint" || value === "reingest" || value === "outputs" || value === "inbox" || value === "unknown" ? value : null;
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
  input: {
    status: KnowledgeBaseMaintenanceTerminalStatus;
    resultStatus?: KnowledgeBaseMaintenanceHistoryEntry["resultStatus"];
    mode: KnowledgeBaseMaintenanceMode;
    at?: number;
    runId?: string;
    reportPath?: string;
    completion?: KnowledgeBaseRunCompletion;
    pendingSources?: string[];
    phase?: string;
    errorCode?: string;
    warnings?: KnowledgeBaseRunWarning[];
    verifiedHealthCheck?: boolean;
  }
): void {
  const at = input.at ?? Date.now();
  const date = formatLocalDateKey(at);
  const entry = canonicalizeKnowledgeBaseMaintenanceHistoryEntry({
    ...input,
    date,
    at,
    reportPath: input.reportPath ?? ""
  });
  if (!entry) {
    throw new Error("知识库维护历史终态无法规范化");
  }
  if (entry.runId && settings.maintenanceHistory?.some((previous) => previous.runId === entry.runId)) return;
  settings.lastRunAt = at;
  settings.lastRunStatus = entry.status;
  settings.lastReportPath = entry.reportPath;
  settings.lastError = entry.errorCode ?? "";
  settings.lastCompletion = entry.completion ?? "";
  settings.lastPendingSources = entry.pendingSources ?? [];
  settings.lastWarnings = entry.warnings ?? [];
  settings.maintenanceHistory = normalizeKnowledgeBaseMaintenanceHistory([
    ...(settings.maintenanceHistory ?? []),
    entry
  ], settings.healthHistory);
  if (input.verifiedHealthCheck === true && input.mode === "lint" && input.status !== "canceled") {
    recordKnowledgeBaseHealthCheck(settings, input.status, at);
  }
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

function normalizeApiProviderModelLimitsOverride(
  value: unknown
): ApiProviderModelLimitsOverride {
  const record = settingsRecord(value);
  if (!record) return {};
  const limitsOverride: ApiProviderModelLimitsOverride = {};
  for (const [key, min, max] of [
    ["contextWindow", 1_024, 2_000_000],
    ["modelMaxTokens", 1, 1_000_000],
    ["maxOutputTokens", 1, 1_000_000]
  ] as const) {
    if (!Object.hasOwn(record, key)) continue;
    const number = typeof record[key] === "number"
      ? record[key]
      : Number(record[key]);
    if (
      !Number.isSafeInteger(number)
      || number < min
      || number > max
    ) continue;
    limitsOverride[key] = number;
  }
  return limitsOverride;
}

function normalizeNonNegativeNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number;
}

function normalizeApiProviderSelection(settings: Pick<
  CodexForObsidianSettings,
  | "providerMode"
  | "activeApiProviderId"
  | "apiProviders"
  | "defaultModel"
  | "openAICodexCredential"
>): void {
  const active = getActiveApiProvider(settings);
  settings.providerMode = "custom-api";
  if (
    active
    && apiProviderHasUsableCredential(
      active,
      settings.openAICodexCredential
    )
  ) {
    settings.defaultModel = getApiProviderModel(active, settings.defaultModel)?.id
      ?? active.defaultModelId;
    return;
  }
  const first = settings.apiProviders.find((provider) =>
    apiProviderHasUsableCredential(
      provider,
      settings.openAICodexCredential
    )
  );
  settings.activeApiProviderId = first?.id ?? "";
  settings.defaultModel = first?.defaultModelId ?? "";
}

function normalizeApiProviders(
  value: unknown,
  migrateLegacyLimits: boolean
): ApiProviderConfig[] {
  if (!Array.isArray(value)) {
    return [createDefaultApiProvider()];
  }
  if (value.length === 0) return [];
  const usedIds = new Set<string>();
  return value.map((item, index) => {
    const record = settingsRecord(item) ?? {};
    const id = uniqueProviderId(sanitizeProviderId(record.id, index), usedIds, index);
    usedIds.add(id);
    const queryParams = normalizeQueryParams(record.queryParams);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    const migratesLegacyTokenPlanCustom = record.providerId === "custom"
      && isQwenTokenPlanApiProviderUrl(baseUrl);
    const providerId = normalizeApiProviderId(
      record.providerId,
      baseUrl,
      name
    );
    const preset = getApiProviderPreset(providerId);
    const runtimeProviderId = providerId === "qwen-token-plan"
      ? preset.runtimeProviderId
      : normalizeRuntimeProviderId(
        record.runtimeProviderId,
        providerId === "custom"
          ? preset.runtimeProviderId
          : providerId === "openai"
            || providerId === "anthropic"
            ? providerId
            : preset.runtimeProviderId
      );
    const modelSelection = normalizeApiProviderModels(
      record,
      providerId,
      runtimeProviderId,
      migrateLegacyLimits
    );
    rememberInvalidStoredReasoningEffortIdentities(id, modelSelection.models);
    return {
      id,
      providerId,
      runtimeProviderId,
      apiProtocol: providerId === "custom"
        || providerId === "openai"
        || providerId === "anthropic"
        ? normalizeApiProviderProtocol(record.apiProtocol, providerId)
        : preset.apiProtocol,
      authMode: apiProviderAuthMode(providerId),
      name: migratesLegacyTokenPlanCustom
        && (!name || name === getApiProviderPreset("custom").name)
        ? preset.name
        : name || preset.name,
      baseUrl: baseUrl || preset.baseUrl,
      models: modelSelection.models,
      defaultModelId: modelSelection.defaultModelId,
      apiKey: apiProviderAuthMode(providerId) === "oauth"
        ? ""
        : typeof record.apiKey === "string"
        ? record.apiKey.trim()
        : "",
      ...(Object.keys(queryParams).length ? { queryParams } : {})
    };
  });
}

function migrateLegacyReasoningPreference(
  settings: Pick<
    CodexForObsidianSettings,
    "apiProviders"
  >,
  data: Record<string, unknown>,
  previousVersion: number
): void {
  if (previousVersion >= 52) return;
  const effort = normalizeEchoInkReasoningEffort(data.defaultReasoning);
  const providerSettingsId = typeof data.activeApiProviderId === "string"
    ? data.activeApiProviderId.trim()
    : "";
  const modelId = typeof data.defaultModel === "string"
    ? data.defaultModel.trim()
    : "";
  if (!effort || !providerSettingsId || !modelId) return;
  const provider = settings.apiProviders.find(
    (candidate) => candidate.id === providerSettingsId
  );
  const model = provider ? getApiProviderModel(provider, modelId) : null;
  if (!model) return;
  if (effort === "none") {
    model.reasoningEnabled = false;
    delete model.reasoningEffort;
    return;
  }
  if (!model.reasoning) return;
  model.reasoningEnabled = true;
  if (model.reasoningEffort === undefined) model.reasoningEffort = effort;
}

function normalizeApiProviderModels(
  provider: Record<string, unknown>,
  providerId: ApiProviderId,
  runtimeProviderId: string,
  migrateLegacyLimits: boolean
): Readonly<{
  models: ApiProviderModelConfig[];
  defaultModelId: string;
}> {
  const rawModels = Array.isArray(provider.models) ? provider.models : [];
  const explicitRecords = rawModels
    .map(settingsRecord)
    .filter((record): record is Record<string, unknown> => Boolean(
      record && isValidApiProviderModelId(record.id)
    ));
  const legacyModelId = isValidApiProviderModelId(provider.model)
    ? String(provider.model).trim()
    : rawModels.find(isValidApiProviderModelId)?.toString().trim()
      ?? getApiProviderPreset(providerId).model;
  const source = explicitRecords.length
    ? explicitRecords.map((record) => normalizeStoredApiProviderModel(
      record,
      providerId,
      runtimeProviderId,
      migrateLegacyLimits
    ))
    : legacyModelId
      ? [normalizeLegacyApiProviderModel(
        provider,
        providerId,
        runtimeProviderId,
        legacyModelId
      )]
      : [];
  const models: ApiProviderModelConfig[] = [];
  const seen = new Set<string>();
  for (const model of source) {
    if (!isValidApiProviderModelId(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  const requestedDefault = isValidApiProviderModelId(provider.defaultModelId)
    ? String(provider.defaultModelId).trim()
    : isValidApiProviderModelId(provider.model)
      ? String(provider.model).trim()
      : "";
  if (requestedDefault && !seen.has(requestedDefault)) {
    const model = createApiProviderModelConfig(
      providerId,
      requestedDefault,
      runtimeProviderId
    );
    seen.add(model.id);
    models.unshift(model);
  }
  return {
    models,
    defaultModelId: seen.has(requestedDefault)
      ? requestedDefault
      : models[0]?.id ?? ""
  };
}

function normalizeStoredApiProviderModel(
  record: Record<string, unknown>,
  providerId: ApiProviderId,
  runtimeProviderId: string,
  migrateLegacyLimits: boolean
): ApiProviderModelConfig {
  const id = String(record.id).trim();
  const normalized = record.metadataSource === "manual"
    ? normalizeManualApiProviderModel(
      record,
      providerId,
      runtimeProviderId,
      id,
      migrateLegacyLimits
    )
    : createApiProviderModelConfig(providerId, id, runtimeProviderId);
  if (normalized.metadataSource === "unknown") {
    normalized.displayName = normalizeText(record.displayName, id);
  }
  if (
    record.metadataSource !== "manual"
    && Object.hasOwn(record, "limitsOverride")
  ) {
    applyApiProviderModelLimitsOverride(
      normalized,
      providerId,
      runtimeProviderId,
      record.limitsOverride
    );
  }
  if (record.metadataSource === "manual") {
    const catalogModel = resolveEchoInkPiCatalogModel(runtimeProviderId, id);
    const presetModel = getApiProviderModelPreset(providerId, id);
    if (catalogModel) normalized.reasoning = catalogModel.reasoning;
    else if (presetModel) normalized.reasoning = presetModel.reasoning;
  }
  return withStoredReasoningPreference(
    normalized,
    record.reasoningEnabled,
    record.reasoningEffort,
    record.metadataSource === "manual" && record.reasoning === true
  );
}

function normalizeLegacyApiProviderModel(
  provider: Record<string, unknown>,
  providerId: ApiProviderId,
  runtimeProviderId: string,
  modelId: string
): ApiProviderModelConfig {
  const known = createApiProviderModelConfig(
    providerId,
    modelId,
    runtimeProviderId
  );
  if (known.metadataSource !== "unknown") {
    return known;
  }
  const hasLegacyMetadata = [
    "toolCalling",
    "imageInput",
    "reasoning",
    "contextWindow",
    "modelMaxTokens",
    "maxOutputTokens"
  ].some((key) => Object.hasOwn(provider, key));
  return hasLegacyMetadata
    ? normalizeManualApiProviderModel(
      provider,
      providerId,
      runtimeProviderId,
      modelId,
      true
    )
    : known;
}

function normalizeManualApiProviderModel(
  record: Record<string, unknown>,
  providerId: ApiProviderId,
  runtimeProviderId: string,
  modelId: string,
  migrateLegacyLimits: boolean
): ApiProviderModelConfig {
  const preset = getApiProviderModelPreset(providerId, modelId);
  const baseline = createApiProviderModelConfig(
    providerId,
    modelId,
    runtimeProviderId
  );
  const input = normalizeApiProviderModelInput(
    record.input,
    record.imageInput === true
  );
  const normalized: ApiProviderModelConfig = {
    id: modelId,
    displayName: normalizeText(
      record.displayName,
      preset?.displayName ?? modelId
    ),
    input,
    toolCalling: typeof record.toolCalling === "boolean"
      ? record.toolCalling
      : preset?.toolCalling ?? false,
    reasoning: typeof record.reasoning === "boolean"
      ? record.reasoning
      : preset?.reasoning ?? false,
    reasoningEnabled: false,
    contextWindow: baseline.contextWindow,
    modelMaxTokens: baseline.modelMaxTokens,
    maxOutputTokens: baseline.maxOutputTokens,
    metadataSource: "manual"
  };
  const limitsOverride = Object.hasOwn(record, "limitsOverride")
    ? record.limitsOverride
    : migrateLegacyLimits
      ? normalizeLegacyApiProviderModelLimits(record, providerId, modelId)
      : undefined;
  applyApiProviderModelLimitsOverride(
    normalized,
    providerId,
    runtimeProviderId,
    limitsOverride
  );
  return withStoredReasoningPreference(
    normalized,
    record.reasoningEnabled,
    record.reasoningEffort,
    record.reasoning === true
  );
}

function normalizeLegacyApiProviderModelLimits(
  record: Record<string, unknown>,
  providerId: ApiProviderId,
  modelId: string
): ApiProviderModelLimitsOverride {
  const preset = getApiProviderModelPreset(providerId, modelId);
  const contextWindow = normalizePositiveInteger(
    record.contextWindow,
    preset?.contextWindow ?? 64_000,
    1_024,
    2_000_000
  );
  const modelMaxTokens = normalizePositiveInteger(
    record.modelMaxTokens,
    normalizePositiveInteger(
      record.maxOutputTokens,
      preset?.modelMaxTokens ?? 8_192,
      1,
      1_000_000
    ),
    1,
    1_000_000
  );
  const maxOutputTokens = Math.min(
    apiProviderMaxOutputReserve(
      providerId,
      modelId,
      normalizePositiveInteger(
        record.maxOutputTokens,
        preset?.maxOutputTokens ?? Math.min(modelMaxTokens, 8_192),
        1,
        Math.min(contextWindow, modelMaxTokens, 1_000_000)
      )
    ),
    contextWindow,
    modelMaxTokens
  );
  return {
    contextWindow,
    modelMaxTokens,
    maxOutputTokens
  };
}

function withStoredReasoningPreference(
  model: ApiProviderModelConfig,
  enabledValue: unknown,
  effortValue: unknown,
  legacyReasoningEnabled: boolean
): ApiProviderModelConfig {
  const effort = normalizeEchoInkReasoningEffort(effortValue);
  const explicitEnabled = typeof enabledValue === "boolean"
    ? enabledValue
    : undefined;
  const legacyEffortEnabled = effortValue !== undefined
    && effortValue !== "none";
  const enabled = effort === "none"
    ? false
    : explicitEnabled ?? Boolean(
      effort
      || legacyEffortEnabled
      || legacyReasoningEnabled
    );
  model.reasoningEnabled = Boolean(model.reasoning && enabled);
  delete model.reasoningEffort;
  INVALID_STORED_REASONING_EFFORT_MODELS.delete(model);
  EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS.delete(model);
  if (effort && effort !== "none") {
    model.reasoningEffort = effort;
    EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS.add(model);
  } else if (effort === "none") {
    // `none` is a valid legacy off state. It is migrated to the master switch
    // and must clear any earlier invalid-value identity for this model.
    EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS.add(model);
  } else if (effortValue !== undefined && effort !== "none") {
    INVALID_STORED_REASONING_EFFORT_MODELS.add(model);
  }
  return model;
}

function rememberInvalidStoredReasoningEffortIdentities(
  providerSettingsId: string,
  models: readonly ApiProviderModelConfig[]
): void {
  for (const model of models) {
    const identity = invalidStoredReasoningEffortIdentity(
      providerSettingsId,
      model.id
    );
    if (INVALID_STORED_REASONING_EFFORT_MODELS.has(model)) {
      INVALID_STORED_REASONING_EFFORT_IDENTITIES.add(identity);
    } else if (EXPLICIT_VALID_STORED_REASONING_EFFORT_MODELS.has(model)) {
      INVALID_STORED_REASONING_EFFORT_IDENTITIES.delete(identity);
    }
  }
}

function invalidStoredReasoningEffortIdentity(
  providerSettingsId: string,
  modelId: string
): string {
  return JSON.stringify([providerSettingsId, modelId]);
}

function normalizeApiProviderModelInput(
  value: unknown,
  legacyImageInput: boolean
): ApiProviderModelInput[] {
  const entries = Array.isArray(value) ? value : [];
  const image = legacyImageInput || entries.includes("image");
  return image ? ["text", "image"] : ["text"];
}

function createDefaultApiProvider(): ApiProviderConfig {
  const preset = getApiProviderPreset("deepseek");
  const models = preset.model
    ? [createApiProviderModelConfig(preset.id, preset.model)]
    : [];
  return {
    id: "provider-default",
    providerId: preset.id,
    runtimeProviderId: preset.runtimeProviderId,
    apiProtocol: preset.apiProtocol,
    authMode: preset.authMode,
    name: preset.name,
    baseUrl: preset.baseUrl,
    models,
    defaultModelId: models[0]?.id ?? "",
    apiKey: ""
  };
}

function normalizeOpenAICodexCredential(
  value: unknown
): OAuthCredential | null {
  const record = settingsRecord(value);
  if (
    record?.type !== "oauth"
    || typeof record.access !== "string"
    || !record.access.trim()
    || typeof record.refresh !== "string"
    || !record.refresh.trim()
    || typeof record.expires !== "number"
    || !Number.isFinite(record.expires)
    || record.expires <= 0
  ) return null;
  const accountId = typeof record.accountId === "string"
    && record.accountId.trim()
    ? record.accountId.trim()
    : undefined;
  return {
    type: "oauth",
    access: record.access.trim(),
    refresh: record.refresh.trim(),
    expires: record.expires,
    ...(accountId ? { accountId } : {})
  };
}

function normalizeRuntimeProviderId(
  value: unknown,
  fallback: string
): string {
  const providerId = normalizeOptionalText(value);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(providerId)
    ? providerId
    : fallback;
}

function normalizeCredentialRef(value: unknown): string {
  const credentialRef = normalizeOptionalText(value);
  return /^cred-[a-f0-9]{32}$/u.test(credentialRef)
    ? credentialRef
    : "";
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
