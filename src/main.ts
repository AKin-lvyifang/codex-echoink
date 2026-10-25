import { maintenanceActivityText, maintenanceStatusBarText, maintenanceTaskStateLabel, projectMaintenanceInitialActivity } from "./knowledge-base/maintenance-activity";
import { knowledgeLinkingProgressText } from "./ui/codex-view/knowledge-linking-progress";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES } from "./knowledge-base/root-paths-core";
import { assertPdfTaskDelivery, pdfKnowledgeSection } from "./pdf-reading/delivery";
import type { PdfNavigationStart, PdfNavigationArtifact, PdfOptions, PdfTaskRequest } from "./pdf-reading/types";
import { checkAgentCapability } from "./agents/capability-policy";
import { KnowledgeAgentIndex } from "./knowledge-base/knowledge-agent-index";
import { knowledgeRoleStatus } from "./knowledge-base/root-paths";
import { HomeWorkbenchDataService } from "./home/home-workbench-data";
import { hasEnglishDiarySourceContent } from "./home/english-diary-source";
import { workbenchStoreForApp } from "./home/workbench-records";
import { readNativeJournalContext, readNativeJournalSettings } from "./home/native-journal";
import { journalDateFromPath } from "./home/home-workbench-model";
import { normalizeEnglishDiarySourcePath } from "./english-diary/task-context";
import { workbenchModuleOwner, prefillWorkbenchModule } from "./home/module-navigation";
import { latestTaskRun, type TaskInterruptionInfo, type TaskInterruptionReason, type TaskResumeContext } from "./agents/task-resume";
import { prepareTaskResumeSafety, readTaskResumeSafety } from "./plugin/task-resume-safety";
import { assertTaskResumeCapabilities } from "./plugin/pi-production-runtime-composition";
import { cloneQueuedTurnItem, type QueuedTurnItem } from "./ui/turn-queue";
import { frozenTurnReasoningSelectionIsValid } from "./ui/codex-view/turn-runner";
import { resolveComposerReasoningState } from "./ui/composer-reasoning";
import { readDurableTaskInterruptionStage } from "./harness/pi-native/pi-native-conversation-runtime";
import { consumeAcceptedTaskDraft } from "./agents/task-workspace";
import { ConversationRunService } from "./plugin/conversation-run-service";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "./agents/types";
import { normalizeAgentRegistry, removeAgentDefinition, setModuleOwner } from "./agents/registry";
import { patchConversationTaskMetadata, type ConversationTaskMetadataPatch } from "./agents/task-metadata";
import { assertPiSubmissionActive, waitForPiSubmission } from "./harness/pi-native/pi-submission-lifecycle";
import { registerKnowledgePrivateRoot } from "./knowledge-base/root-paths";
import { applyConversationTaskMetadata, normalizeConversationTaskMetadata } from "./agents/task-metadata";
import { knowledgeFolderOrganizationPrompt, projectedKnowledgeFolderRoles } from "./knowledge-base/folder-bindings";
import { PdfReadingController } from "./pdf-reading/controller";
import { createPluginAccountService } from "./membership/plugin-service";
import type { AccountService } from "./membership/account-service";
import { UsageStore, type UsageRequestEvent } from "./harness/usage/usage-store";
import { hasProPluginAccess, requireProPlugin, unavailableCapabilityAccess } from "./membership/access";
import { ConversationAutoArchive } from "./plugin/conversation-auto-archive";
import { EchoInkAppearance } from "./ui/appearance-theme";
import { knowledgePathRole } from "./knowledge-base/root-paths";
import { HomeActivityService } from "./home/home-activity-service";
import { EchoInkWorkbenchView } from "./home/workbench-view";
import { LifestyleService } from "./lifestyle/service";
import type { LifestyleKind } from "./lifestyle/settings";
import type { CodexSettingTab } from "./settings/settings-tab";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Notice, Platform, Plugin, TFile } from "obsidian";
import { DeveloperModeAccess } from "./plugin/developer-mode/access";
import { DeveloperModeService } from "./plugin/developer-mode/service";
import { MemoryDeveloperBackups, type DeveloperMemoryChange } from "./plugin/developer-mode/memory-backups";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { closeMcpBrokerConnectionPool } from "./resources/mcp-broker";
import {
  EchoInkMcpBrokerService,
  type CallEchoInkMcpToolInput
} from "./resources/mcp-broker-service";
import type { EchoInkResource } from "./resources/types";
import { enabledSkillResources } from "./resources/registry";
import type { ReviewManager } from "./review/manager";
import { getApiProviderModel, validateApiProvider, newId, apiProviderModelSupportsImage, apiProviderHasUsableCredential, getActiveApiProvider, getActiveApiProviderModel, getEnglishDiaryApiProviderModel, type ChatMessage, type CodexForObsidianSettings, type ResourceManagementTab } from "./settings/settings";
import { CodexView, VIEW_TYPE_CODEX } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import { EnglishDiaryController } from "./english-diary/controller";
import { confirmModal } from "./ui/modals";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "./home/home-view";
import { PaperGuideController } from "./plugin/paper-guide-controller";
import { EchoInkTodoStore } from "./home/todo-store";
import { TodoReminderService } from "./home/todo-reminder-service";
import {
  EchoInkSettingsStore,
  SettingsPersistenceError,
  restoreApiProviderSettings,
  snapshotApiProviderSettings,
  type SettingsLoadResult,
  type SettingsSaveOptions
} from "./plugin/settings-store";
import { EchoInkViewService } from "./plugin/view-service";
import { QuickChatWindowController, type QuickChatRegistrationResult } from "./plugin/quick-chat-window";
import {
  EchoInkResourceCatalogService,
  requireAvailableEchoInkSkillResource
} from "./plugin/resource-catalog-service";
import {
  EchoInkMcpSettingsService,
  type EchoInkMcpServerDraft
} from "./plugin/mcp-settings-service";
import { EchoInkKnowledgeSurfaceService } from "./plugin/knowledge-surface-service";
import type {
  KnowledgeInitializationAssignment,
  KnowledgeBaseStructureRepairProgress,
  KnowledgeInitializationMode,
  KnowledgeInitializationRole
} from "./knowledge-base/initializer";
import type {
  ExperienceSourceRef,
  PiBranchNavigationResult,
  PiChatEventSubscription,
  PiChatRunHandle,
  PiChatRuntimeEventListener,
  PiChatSubmitRequest,
  PiKnowledgeMaintenanceScope,
  PiConversationCatalogEntry,
  PiConversationDerivationResult,
  PiConversationMemoryMode,
  PiConversationCatalogStatus,
  PiConversationProjection,
  PiConversationSupportState,
  PiTaskPlanTransitionRequest,
  PiTaskPlanTransitionResult
} from "./harness/pi-native/contracts";
import type {
  ActivatePiNativeConversationOptions,
  CreatePiNativeConversationInput,
  DerivePiNativeConversationInput,
  PiNativeConversationRecoveryResult,
  RecoverPiNativeConversationInput
} from "./harness/pi-native/pi-native-conversation-runtime";
import { recordDurablePiAnswerSave } from "./harness/pi-native/pi-native-conversation-runtime";
import { createPiLocalConversation } from "./harness/pi-native/pi-local-data-service";
import {
  createPiProductionModelDefinition,
  createPiProductionRuntimeBundle,
  type PiProductionRuntimeBundle
} from "./plugin/pi-production-runtime-composition";
import type {
  PiAgentApprovalDecisionBinding,
  PiAgentApprovalIdentity,
  PiAgentApprovalRunIdentity,
  PiAgentApprovalSubscription
} from "./plugin/pi-agent-approval-broker";
import type {
  PiTurnInteractionDecisionBinding,
  PiTurnInteractionIdentity
} from "./plugin/pi-turn-interaction-broker";
import { PiLocalDataService } from "./plugin/pi-local-data-service";
import { pluginDataDir, pluginInstallDir, preparePluginDataRoot } from "./plugin/plugin-data-paths";
import {
  KnowledgeMaintenancePreferenceRepository
} from "./knowledge-base/knowledge-maintenance-preferences";
import { isRawMarkdownPath } from "./knowledge-base/raw-digest";
import {
  PiProviderConfigurationService,
  type PiProviderConfigurationDraft,
  type PiProviderConnectionTestResult,
  type PiProviderModelListResult
} from "./plugin/pi-provider-configuration-service";
import {
  ApiProviderActivationService,
  ProductActivityGate
} from "./plugin/api-provider-activation-service";
import { EditorTranslationService } from "./plugin/editor-translation-service";
import {
  PersonalMemoryCorrectionService,
  type PersonalMemoryCorrectionRecord
} from "./plugin/personal-memory-correction-service";
import { normalizeApiProviderId } from "./settings/provider-presets";
import { CognitiveSystem } from "./harness/memory/cognitive-system";
import { DEFAULT_AGENT_DISPLAY_NAME } from "./harness/memory/agent-identity-model";
import { resolveAgentAvatarUrl } from "./ui/agent-avatar-presets";
import type { AgentIdentityView } from "./ui/codex-view/message-list";
import type { DreamLlmPort } from "./harness/memory/dream-engine";
import {
  SkillRuntimeCoordinator,
  type BuiltinSkillRuntimeSnapshot
} from "./harness/resources/skill-runtime";
import type { BuiltinSkillId } from "./harness/resources/builtin-skills";
import { advanceEchoInkOnboardingTutorial, dismissEchoInkOnboardingTutorial, echoInkOnboardingTab, onboardingCoachmarkCopy, onboardingCompletionCopy, prepareEchoInkOnboardingTutorial, shouldAutoStartEchoInkOnboarding, selectEchoInkOnboardingStep, type EchoInkOnboardingStep } from "./settings/onboarding";
import {
  mountEchoInkOnboardingCoachmark,
  type EchoInkOnboardingCoachmarkHandle
} from "./ui/onboarding-coachmark";
import {
  logoutOpenAICodexAfterRuntimeSuspension,
  OpenAICodexOAuthService,
  type OpenAICodexAuthStatus
} from "./plugin/openai-codex-oauth-service";

interface PiConversationActivationTask {
  readonly generation: number;
  readonly isStillCurrent?: () => boolean;
  cancelled: boolean;
  promise: Promise<void>;
}

export interface PiConversationSelectionActivationOptions
extends ActivatePiNativeConversationOptions {
  /** UI-owned selection guard; never forwarded into AgentSession options. */
  isStillCurrent?: () => boolean;
}

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  homeActivity: HomeActivityService | null = null;
  lifestyle!: LifestyleService;
  private settingsTabInstance: CodexSettingTab | null = null;
  private knowledgeBase: EchoInkKnowledgeSurfaceService | null = null;
  private review: ReviewManager | null = null;
  private settingsStore: EchoInkSettingsStore | null = null;
  private viewService: EchoInkViewService | null = null;
  selectionAskController: import("./selection-ask/controller").SelectionAskController | null = null;
  private quickChatWindow: QuickChatWindowController | null = null;
  private todoStore: EchoInkTodoStore | null = null;
  private todoReminderService: TodoReminderService | null = null;
  private resourceCatalogService: EchoInkResourceCatalogService | null = null;
  private skillRuntimeCoordinator: SkillRuntimeCoordinator | null = null;
  private autoArchive: ConversationAutoArchive | null = null;
  private agentRegistryWriteTail: Promise<void> = Promise.resolve();
  private readonly agentRegistryListeners = new Set<() => void>();
  private readonly conversationCatalogListeners = new Set<() => void>();
  private pendingSettingsResourceDetailId = "";
  private mcpBrokerService: EchoInkMcpBrokerService | null = null;
  private mcpSettingsService: EchoInkMcpSettingsService | null = null;
  private piProviderConfigurationService:
    PiProviderConfigurationService | null = null;
  private openAICodexOAuthService:
    OpenAICodexOAuthService | null = null;
  private piRuntimeBundle: PiProductionRuntimeBundle | null = null;
  private piRuntimeFlight: Promise<PiProductionRuntimeBundle> | null = null;
  private piConversationActivationGeneration = 0;
  private piConversationActivationLane: Promise<void> = Promise.resolve();
  private readonly piConversationActivationTasks = new Map<
    string,
    PiConversationActivationTask
  >();
  private piActivatedConversationId: string | null = null;
  private piLocalData: PiLocalDataService | null = null;
  private piTaskMetadataSyncTail: Promise<void> = Promise.resolve();
  private piTaskMetadataWriteTails = new Map<string, Promise<unknown>>();
  private conversationRunService: ConversationRunService | null = null;
  private applicationQuitObserved = false;
  private piLocalDataFlight: Promise<PiLocalDataService> | null = null;
  private cognitiveSystem: CognitiveSystem | null = null;
  private cognitiveSystemFlight: Promise<CognitiveSystem> | null = null;
  private readonly piRunConversations = new Map<string, string>();
  private readonly piSubmittingConversations = new Set<string>();
  private readonly apiProviderActivation = new ApiProviderActivationService();
  private editorTranslation: EditorTranslationService | null = null;
  pdfReading: PdfReadingController | null = null;
  englishDiary: EnglishDiaryController | null = null;
  accountService: AccountService | null = null;
  usageStore: UsageStore | null = null;
  private personalMemoryCorrection: PersonalMemoryCorrectionService | null = null;
  private readonly productActivity = new ProductActivityGate();
  private developerMemoryChanging = false;
  readonly developerMode = new DeveloperModeAccess();
  private developerService: DeveloperModeService | null = null;
  private onboardingRequested = false;
  private paperGuide: PaperGuideController | null = null;
  private onboardingRibbonAnchor: HTMLElement | null = null;
  private onboardingWorkspaceCoachmark: EchoInkOnboardingCoachmarkHandle | null = null;
  private onboardingDesktopWaitCleanup: (() => void) | null = null;
  private appearance: EchoInkAppearance | null = null;
  async onload(): Promise<void> {
    this.registerEvent(this.app.workspace.on("quit", tasks => {
      this.applicationQuitObserved = true;
      tasks.add(async () => { await this.conversationRunService?.dispose("app_closed"); });
    }));
    const enabledAfterLayoutReady = this.app.workspace.layoutReady;
    const dataRoot = await preparePluginDataRoot(this.getVaultPath(), this.manifest, this.app.vault.configDir);
    this.register(() => dataRoot.dispose());
    const settingsLoad = await this.loadSettings();
    registerKnowledgePrivateRoot(this.getVaultPath(), path.join(pluginDataDir(this.getVaultPath(), this.getPluginDataDirName()), "pi-agent-product-v1", "knowledge"));
    this.appearance = new EchoInkAppearance(this.app, () => this.settings.colorTheme);
    this.appearance.refresh();
    this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, win) => {
      this.appearance?.applyToDocument(win.document);
    }));
    this.register(() => { this.appearance?.dispose(); this.appearance = null; });
    if (dataRoot.usingPreviousRoot) {
      new Notice(this.settings.settingsLanguage === "en"
        ? `EchoInk is keeping your existing conversations, memory and activity in their previous folder. You can keep using them without moving files.\nIn use: ${dataRoot.rootPath}${dataRoot.installRootHasData ? `\nThe installation folder also has data; it has been kept unchanged: ${dataRoot.installRootPath}` : ""}`
        : `EchoInk 正在沿用原来的数据目录，已有会话、记忆和足迹可以继续使用，无需立即搬动文件。\n正在使用：${dataRoot.rootPath}${dataRoot.installRootHasData ? `\n安装目录中也有数据，已原样保留：${dataRoot.installRootPath}` : ""}`, 15000);
    }
    this.onboardingRequested = shouldAutoStartEchoInkOnboarding(
      settingsLoad.emptyData,
      this.settings.setup,
      enabledAfterLayoutReady
    );
    if (this.onboardingRequested && prepareEchoInkOnboardingTutorial(
      this.settings.setup,
      { forceRestart: false }
    )) {
      await this.saveSettings(true);
    }
    this.homeActivity = new HomeActivityService(path.join(pluginDataDir(this.getVaultPath(), this.getPluginDataDirName()), "home-activity.json"));
    await this.homeActivity.initialize();
    try {
      const usage = new UsageStore(path.join(pluginDataDir(this.getVaultPath(), this.getPluginDataDirName()), "usage-statistics.json"));
      await usage.initialize();
      this.usageStore = usage;
    } catch (error) {
      console.error("EchoInk local usage statistics could not initialize", error);
    }
    this.accountService = await createPluginAccountService(this);
    this.lifestyle = new LifestyleService(this);
    await this.lifestyle.initialize();
    this.app.workspace.onLayoutReady(() => {
      const activity = this.homeActivity;
      if (!activity) return;
      this.registerEvent(this.app.vault.on("create", (file) => activity.record(file.path, "created")));
      this.registerEvent(this.app.vault.on("modify", (file) => activity.record(file.path, "modified")));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => activity.rename(oldPath, file.path)));
      this.registerEvent(this.app.vault.on("delete", (file) => activity.delete(file.path)));
      this.registerEvent(this.app.workspace.on("file-open", (file) => activity.open(file?.path ?? null)));
      activity.restoreOpen(this.app.workspace.getActiveFile()?.path ?? null);
    });
    await this.initializePiLocalData();
    this.initializeAutoArchive();
    // Cognitive main-chain (personality / dreaming / secondary facts): start the
    // scheduler as soon as local data is ready; failures never block the plugin.
    void this.getCognitiveSystem().catch((error) => {
      console.error("EchoInk cognitive system init failed", error);
    });
    this.pdfReading = new PdfReadingController(this);
    this.englishDiary = new EnglishDiaryController(this);
    this.englishDiary.register();
    this.register(this.accountService.subscribe(() => this.notifyHomeSurfacesChanged()));
    const controllers = registerEchoInkPluginFeatures(this);
    this.knowledgeBase = controllers.knowledgeBase;
    this.initializeKnowledgeActivityStatusBar();
    this.review = controllers.review;
    this.selectionAskController = controllers.selectionAsk;
    registerEchoInkStartupTasks(this);
    // Global quick-chat window: registration is fail-safe by design; when the
    // desktop bridge is missing the sidebar experience stays untouched.
    this.quickChatWindow = new QuickChatWindowController(this);
    const quickChatRegistration = this.quickChatWindow.applySettings();
    if (this.settings.quickChat.enabled && !quickChatRegistration.ok) {
      console.warn("EchoInk quick chat hotkey not registered", quickChatRegistration.reason);
    }
    this.getTodoReminderService().start();
  }

  onunload(): void {
    // Stop notifications synchronously, before the async service shutdown.
    this.todoReminderService?.dispose();
    this.todoReminderService = null;
    this.todoStore?.dispose();
    this.todoStore = null;
    void this.performUnload();
  }

  private async performUnload(): Promise<void> {
    await this.conversationRunService?.dispose(this.applicationQuitObserved ? "app_closed" : "plugin_disabled").catch(error => console.error("Conversation shutdown could not finalize", error));
    this.accountService?.dispose();this.accountService=null;
    this.pdfReading?.api.cancel();
    this.pdfReading = null;
    this.englishDiary?.dispose();
    this.englishDiary = null;
    this.lifestyle?.dispose();
    await this.autoArchive?.dispose();
    this.autoArchive = null;
    this.quickChatWindow?.dispose();
    this.quickChatWindow = null;
    const activity = this.homeActivity;
    this.homeActivity = null;
    await activity?.dispose();
    this.developerMode.reset();
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
    this.onboardingRibbonAnchor = null;
    const cognitive = this.cognitiveSystem
      ?? await this.cognitiveSystemFlight?.catch(() => null)
      ?? null;
    await cognitive?.dispose();
    this.cognitiveSystem = null;
    this.cognitiveSystemFlight = null;
    await this.knowledgeBase?.unload();
    this.review?.unload();
    await this.cancelAllPiConversationActivations();
    await this.piRuntimeBundle?.runtime.shutdown();
    await this.usageStore?.flush().catch((error) => console.error("EchoInk usage statistics could not be saved", error));
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await this.persistPiNativeSettings();
    const localData = this.piLocalData
      ?? await this.piLocalDataFlight?.catch(() => null)
      ?? null;
    await localData?.dispose();
    this.piLocalData = null;
    this.piLocalDataFlight = null;
    await closeMcpBrokerConnectionPool();
  }

  async activateHomeAndSidebar(): Promise<void> { return this.getViewService().activateHomeAndSidebar(); }
  async openPaperGuideAfterOnboarding(): Promise<void> {
    if (!this.paperGuide) {
      this.paperGuide = new PaperGuideController(this, () =>
        this.app.workspace.getActiveViewOfType(EchoInkWorkbenchView)?.contentEl
          ?? this.app.workspace.getActiveViewOfType(EchoInkHomeView)?.contentEl ?? null);
      this.register(() => { this.paperGuide?.dispose(); this.paperGuide = null; });
    }
    await this.paperGuide.showAfterOnboarding();
  }
  async openEchoInkAccountSettings(target?: "login" | "benefits"): Promise<void> {
    await this.getViewService().openEchoInkSettings("account", target ? `account:${target}` : undefined);
  }
  applyAppearanceTheme(ownerDocument?: Document): void {
    if (ownerDocument) this.appearance?.applyToDocument(ownerDocument);
    this.appearance?.refresh();
  }
  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> { return this.getViewService().activateHomeView(options); }
  async activateKnowledgeView(page: "overview" | "health" | "history" = "overview"): Promise<void> { return this.getViewService().activateKnowledgeView(page); }

  private pdfNavigationFlight: Promise<string> | null = null;
  private pdfNavigationIndex: KnowledgeAgentIndex | null = null;
  async activatePdfReadingPage(): Promise<void> { return this.getViewService().activatePdfReadingPage(); }
  pdfNavigationStartReason(options: PdfOptions): string {
    const host = this.pdfReading;
    if (!host || !this.settings.pdfReading.enabled) return "请先启用 PDF 精读。";
    if (!host.policy().canWrite) return "需要有效 PRO；已有 PDF 和成果仍可查看。";
    if (host.api.isBusy()) return "已有一份 PDF 正在处理。";
    const owner = workbenchModuleOwner(this, "pdf-reading");
    const context = { settings: this.settings, agentId: owner.id, vaultRoot: this.getVaultPath(), resources: [], proAccess: this.accountService ?? unavailableCapabilityAccess };
    if (!checkAgentCapability(context, "pdf-reading", "resource").allowed) return `${owner.name}还不能处理 PDF。`;
    if ((options.reading || options.summary) && !checkAgentCapability(context, "knowledge", "resource").allowed) return `${owner.name}还不能整理知识库；请调整能力，或取消精读和摘要。`;
    if ((options.reading || options.summary) && knowledgeRoleStatus(this.getVaultPath(), "wiki") !== "ready") return "请先设置可用的知识成果位置，或取消精读和摘要。";
    return "";
  }
  async validatePdfNavigationStart(input: PdfNavigationStart): Promise<void> {
    const reason = this.pdfNavigationStartReason(input.options); if (reason) throw new Error(reason);
    if (input.attachment.type !== "file" || !/\.pdf$/iu.test(input.attachment.name) || !input.attachment.path) throw new Error("请选择一份 PDF。");
    if (!this.pdfReading!.originalDirectories().includes(input.originalDirectory)) throw new Error("原 PDF 保存位置已失效，请重新选择资料来源位置。");
    if (input.options.wiki !== (input.options.reading || input.options.summary === true)) throw new Error("PDF 成果选项不一致，请重新选择。");
  }
  async startPdfNavigationTask(input: PdfNavigationStart): Promise<string> {
    if (this.pdfNavigationFlight) return this.pdfNavigationFlight;
    const frozen = structuredClone(input);
    const flight = (async () => {
      await this.validatePdfNavigationStart(frozen);
      await this.activateView();
      const view = this.getCodexView();
      if (!view || !await view.waitForTaskUiReady()) throw new Error("对话栏尚未就绪，请重试。");
      return view.startPdfNavigationTask(frozen);
    })();
    this.pdfNavigationFlight = flight;
    try { return await flight; } finally { if (this.pdfNavigationFlight === flight) this.pdfNavigationFlight = null; }
  }
  async verifyPdfTaskDelivery(request: Readonly<PdfTaskRequest> | string, noNewSourcePaths: readonly string[]): Promise<void> {
    const jobId = typeof request === "string" ? request : request.jobId;
    const data = await this.pdfReading?.navigationData(jobId);
    if (!data || data.errors.length) throw new Error(data?.errors[0] || "PDF 记录暂时读不到，已保存成果保留。");
    const entry = data.entries.find(entry => entry.job.id === jobId);
    if (!entry) throw new Error("PDF 任务记录暂时读不到，已保存成果保留。");
    assertPdfTaskDelivery(typeof request === "string" ? { jobId, sourceFingerprint: entry.job.sourceFingerprint ?? "", options: entry.job.options, requiresOriginal: !!entry.job.original } : request, entry, noNewSourcePaths);
  }
  async readPdfKnowledgeArtifacts(rawPath: string): Promise<PdfNavigationArtifact[]> {
    // Same local index and storage as Pi, with no Provider initialization or search disclosure.
    const local = await this.ensurePiLocalData();
    const index = this.piRuntimeBundle?.knowledgeAgentIndex ?? (this.pdfNavigationIndex ??= new KnowledgeAgentIndex({
      vaultPath: this.getVaultPath(), storageRootPath: path.join(local.piNativeStorageRootPath, "knowledge"),
      linkResolver: (linkpath, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path
    }));
    index.invalidate();
    const result = await index.readReliableKnowledgeForRaw(rawPath);
    const artifacts: PdfNavigationArtifact[] = [];
    for (const entry of result?.entries ?? []) {
      artifacts.push({ kind: "wiki", path: entry.vaultRelativePath, label: entry.title || "知识成果" });
      for (const [kind, label] of [["reading", "精读"], ["summary", "摘要"]] as const) {
        const heading = pdfKnowledgeSection(entry.content, kind);
        if (heading) artifacts.push({ kind, path: `${entry.vaultRelativePath}#${heading}`, label });
      }
    }
    return artifacts;
  }

  async activateEnglishDiaryPage(page: "diary" | "expressions" = "diary", expressionId?: string): Promise<void> { return this.getViewService().activateEnglishDiaryPage(page, expressionId); }
  async validateEnglishDiaryTaskSource(sourcePath: string): Promise<void> {
    if (!this.settings.englishDiary.enabled || !this.englishDiary) throw new Error("英文日记已停用。");
    if (!normalizeEnglishDiarySourcePath(sourcePath)) throw new Error("英文日记原稿位置无效。");
    const native = readNativeJournalSettings(this.app, this.settings.journalDirectory, this.settings.knowledgeBase.folderBindings);
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!native.available || !(file instanceof TFile) || !journalDateFromPath(sourcePath, native.folder, native.format)) throw new Error("原稿已移动或不在当前日记范围，请从英文日记页重新选择。");
  }
  async prepareEnglishDiaryNavigationToday(): Promise<{ path: string; hasContent: boolean; hasResult: boolean }> {
    const now = new Date();
    const data = new HomeWorkbenchDataService(this.app, () => this.settings.journalDirectory, this.homeActivity, undefined, () => this.settings.knowledgeBase.folderBindings);
    const native = await readNativeJournalContext(this.app, { now, legacyDirectory: this.settings.journalDirectory, bindings: this.settings.knowledgeBase.folderBindings });
    const file = data.existingJournalForDate(now), sourcePath = file?.path ?? data.journalPathForDate(now);
    const template = this.app.vault.getAbstractFileByPath(native.template);
    const baseline = (await workbenchStoreForApp(this.app)?.snapshot())?.journals[sourcePath];
    const hasContent = file ? hasEnglishDiarySourceContent(await this.app.vault.read(file), {
      template: template instanceof TFile ? await this.app.vault.read(template) : native.templateContent,
      now, title: file.basename, formats: native, baseline
    }) : false;
    const saved = await this.englishDiary?.api.repository.listSavedDiaries?.();
    return { path: sourcePath, hasContent, hasResult: saved?.entries.some(entry => entry.sourcePath === sourcePath && !entry.missingEnglish) ?? false };
  }
  async prefillEnglishDiaryTask(sourcePath: string): Promise<boolean> {
    await this.validateEnglishDiaryTaskSource(sourcePath);
    return this.openAgentTaskList(workbenchModuleOwner(this, "english-diary").id,
      "请把今天的日记生成英文，沿用已确认的发送范围。", undefined, sourcePath);
  }
  createEnglishDiaryTaskGenerator() {
    return { generate: (input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }) => this.generateEnglishDiaryTextInRun(input),
      providerLabel: () => this.englishDiaryProviderLabel(), skill: async () => { await this.requireAvailableEchoInkSkill("english-diary"); return (await this.readEchoInkBuiltinSkill("english-diary")).content; } };
  }

  async activateTodoView(): Promise<void> { return this.getViewService().activateTodoView(); }

  async activateJournalView(): Promise<void> { return this.getViewService().activateJournalView(); }
  getWorkbenchModuleOwner(moduleId: AgentModuleId): AgentDefinition { return workbenchModuleOwner(this, moduleId); }
  async prefillWorkbenchModule(moduleId: AgentModuleId, text: string): Promise<boolean> { return prefillWorkbenchModule(this, moduleId, text); }
  setSettingsTabInstance(tab: CodexSettingTab): void { this.settingsTabInstance = tab; }
  private settingsNavigationTargets(): CodexSettingTab[] {
    const targets = this.settingsTabInstance ? [this.settingsTabInstance] : [];
    // Native settings search may display a host-owned copy of the registered
    // tab. Route the visible copy too; otherwise external shortcuts update only
    // the detached registration while leaving the open page where it was.
    const active = (this.app as unknown as { setting?: { activeTab?: CodexSettingTab & { id?: string } } }).setting?.activeTab;
    if (Platform.isDesktopApp && active?.id === this.manifest.id && typeof active.openDesktopRoute === "function" && !targets.includes(active)) targets.push(active);
    return targets;
  }
  prepareDesktopSettingsRoute(route: import("./settings/desktop-settings-route").DesktopSettingsRoute): void {
    if (Platform.isDesktopApp) for (const tab of this.settingsNavigationTargets()) tab.openDesktopRoute(route);
  }
  async openLifestyleSettings(kind: LifestyleKind): Promise<void> {
    this.settings.settingsTab = "resources";
    this.settings.resourceManagementTab = "plugins";
    this.prepareDesktopSettingsRoute({ tab: "modules" });
    for (const tab of this.settingsNavigationTargets()) tab.openLifestyleDetail(kind);
    await this.saveSettings(true);
    const setting = (this.app as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    if (!setting?.open || !setting.openTabById) { new Notice("无法打开 EchoInk 设置页"); return; }
    setting.open();
    setting.openTabById(this.manifest.id);
  }
  /** Push settings-driven home changes (module visibility, todos) to open home views. */
  notifyHomeSurfacesChanged(): void {
    for (const leaf of [...this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME), ...this.app.workspace.getLeavesOfType("echoink-legacy-home")]) {
      if (leaf.view instanceof EchoInkHomeView) leaf.view.refreshHomeSurfaces();
      else if (leaf.view instanceof EchoInkWorkbenchView) leaf.view.refreshIfSettingsChanged();
    }
  }
  getTodoStore(options: { initialize?: boolean } = {}): EchoInkTodoStore {
    if (!this.todoStore) this.todoStore = new EchoInkTodoStore(this);
    if (options.initialize !== false) {
      void this.todoStore.initialize().catch((error) => {
        console.error("EchoInk todo store initialization failed", error);
      });
    }
    return this.todoStore;
  }
  getTodoReminderService(): TodoReminderService {
    if (!this.todoReminderService) this.todoReminderService = new TodoReminderService(this);
    return this.todoReminderService;
  }
  async activateView(options: { focusInput?: boolean } = {}): Promise<void> { return this.getViewService().activateView(options); }
  getQuickChatWindowController(): QuickChatWindowController | null { return this.quickChatWindow; }
  async toggleQuickChatWindow(): Promise<void> {
    const controller = this.quickChatWindow;
    if (!controller) {
      await this.activateView();
      return;
    }
    await controller.toggle();
  }
  async returnQuickChatToSidebar(): Promise<void> {
    const controller = this.quickChatWindow;
    if (!controller) {
      await this.activateView();
      return;
    }
    await controller.returnToSidebar();
  }
  applyQuickChatSettings(): QuickChatRegistrationResult {
    return this.quickChatWindow?.applySettings() ?? { ok: false, reason: "unavailable" };
  }
  async openPendingEchoInkOnboarding(): Promise<void> {
    if (!this.onboardingRequested) return;
    const step = this.settings.setup.tutorialStep;
    if (step === "sidebar" || step === "settings" || step === "colleague") {
      await this.showEchoInkOnboardingWorkspaceCoachmark(step);
      return;
    }
    await this.getViewService().openEchoInkSettings(
      echoInkOnboardingTab(step), step === "personality" ? "general:personality-template"
        : step === "knowledge" ? "knowledge:onboarding" : "providers:add"
    );
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
  }
  setEchoInkOnboardingRibbonAnchor(anchor: HTMLElement): void { this.onboardingRibbonAnchor = anchor; }
  async handleEchoInkOnboardingTargetActivated(_expectedStep: "sidebar" | "settings"): Promise<boolean> {
    // Ordinary ribbon/gear actions only navigate. Tutorial controls own progress.
    return false;
  }
  isEchoInkOnboardingRequested(): boolean { return this.onboardingRequested; }
  shouldAutoOpenEchoInkOnboarding(): boolean { return this.onboardingRequested; }
  async dismissEchoInkOnboarding(): Promise<void> {
    const previousRequested = this.onboardingRequested;
    const previousSetup = { ...this.settings.setup };
    this.onboardingRequested = false;
    dismissEchoInkOnboardingTutorial(this.settings.setup);
    try {
      await this.saveSettings(true);
    } catch (error) {
      this.onboardingRequested = previousRequested;
      Object.assign(this.settings.setup, previousSetup);
      throw error;
    }
    this.clearEchoInkOnboardingWorkspaceCoachmark(true);
  }
  getEchoInkOnboardingStep(): EchoInkOnboardingStep {
    return this.settings.setup.tutorialStep;
  }
  async advanceEchoInkOnboarding(
    expectedStep: EchoInkOnboardingStep
  ): Promise<EchoInkOnboardingStep | null> {
    if (!this.onboardingRequested) return null;
    if (expectedStep === "colleague" && !this.settings.agentRegistry.agents.some(agent => agent.id === this.settings.setup.onboardingAgentId))
      throw new Error(this.settings.settingsLanguage === "en" ? "Create your colleague first." : "请先创建这位同事。");
    const previousRequested = this.onboardingRequested;
    const previousSetup = { ...this.settings.setup };
    const result = advanceEchoInkOnboardingTutorial(
      this.settings.setup,
      expectedStep,
      Date.now()
    );
    if (result.completed) this.onboardingRequested = false;
    if (result.changed) {
      try {
        await this.saveSettings(true);
      } catch (error) {
        this.onboardingRequested = previousRequested;
        Object.assign(this.settings.setup, previousSetup);
        throw error;
      }
    }
    return result.nextStep;
  }
  async selectEchoInkOnboardingStep(
    expectedStep: EchoInkOnboardingStep,
    nextStep: EchoInkOnboardingStep
  ): Promise<boolean> {
    if (!this.onboardingRequested) return false;
    const previousSetup = { ...this.settings.setup };
    if (!selectEchoInkOnboardingStep(this.settings.setup, expectedStep, nextStep)) return false;
    try {
      await this.saveSettings(true);
    } catch (error) {
      Object.assign(this.settings.setup, previousSetup);
      throw error;
    }
    return true;
  }
  async restartEchoInkOnboarding(): Promise<void> {
    const previousRequested = this.onboardingRequested;
    const previousSetup = { ...this.settings.setup };
    prepareEchoInkOnboardingTutorial(this.settings.setup, { forceRestart: true });
    this.onboardingRequested = true;
    try {
      await this.saveSettings(true);
    } catch (error) {
      this.onboardingRequested = previousRequested;
      Object.assign(this.settings.setup, previousSetup);
      throw error;
    }
  }
  private async showEchoInkOnboardingWorkspaceCoachmark(step: "sidebar" | "settings" | "colleague"): Promise<void> {
    await this.activateHomeAndSidebar();
    const view = this.getCodexView();
    if (!view || !await view.waitForTaskUiReady()) throw new Error("Agent page is not ready");
    if (step === "colleague" && this.settings.agentRegistry.agents.some(agent => agent.id === this.settings.setup.onboardingAgentId)) {
      await this.advanceEchoInkOnboarding("colleague");
      this.showEchoInkOnboardingCompletion();
      return;
    }
    const anchor = step === "colleague" ? view.openOnboardingAgentEditor() : view.onboardingAgentAnchor;
    if (!anchor?.isConnected) throw new Error("Agent page is not ready");
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
    const copy = onboardingCoachmarkCopy(step, this.settings.settingsLanguage !== "en");
    let navigating = false;
    const leave = (action: () => Promise<void>): Promise<void> | undefined => {
      let pending: Promise<void> | undefined;
      const run = () => {
        if (navigating) return;
        navigating = true;
        const card = this.onboardingWorkspaceCoachmark?.element;
        card?.setAttribute("aria-busy", "true"); card?.querySelectorAll("button").forEach(button => { button.disabled = true; });
        pending = this.runEchoInkOnboardingNavigation(action).catch(error => { console.warn("EchoInk onboarding navigation failed", error); new Notice(this.settings.settingsLanguage === "en" ? "The page did not open. Try again." : "页面没有打开，请重试。"); })
          .finally(() => { navigating = false; card?.setAttribute("aria-busy", "false"); card?.querySelectorAll("button").forEach(button => { button.disabled = false; }); });
      };
      if (step === "colleague") view.requestOnboardingEditorLeave(run); else run();
      return pending;
    };
    this.onboardingWorkspaceCoachmark = mountEchoInkOnboardingCoachmark({
      app: this.app, anchor, stepClass: step, stepLabel: copy.step, title: copy.title,
      description: copy.description, actionLabel: copy.action,
      tip: copy.tip || undefined, icon: copy.icon, tone: copy.tone, steps: copy.steps,
      progressLabel: copy.progressLabel, previousLabel: copy.previousLabel, dismissLabel: copy.dismissLabel,
      restoreFocusEl: anchor,
      onDismiss: () => { void leave(() => this.dismissEchoInkOnboarding()); return false; },
      onPrevious: () => leave(async () => {
        if (step === "sidebar" || step === "settings") { await this.dismissEchoInkOnboarding(); return; }
        if (await this.selectEchoInkOnboardingStep(step, "personality")) await this.openPendingEchoInkOnboarding();
      }),
      onStep: next => leave(async () => { if (await this.selectEchoInkOnboardingStep(step, next)) await this.openPendingEchoInkOnboarding(); }),
      onAction: step === "colleague" ? () => view.submitOnboardingAgentEditor() : () => this.runEchoInkOnboardingNavigation(async () => { await this.advanceEchoInkOnboarding(step); await this.openPendingEchoInkOnboarding(); }),
      onActionError: error => { console.warn("EchoInk onboarding action failed", error); new Notice(this.settings.settingsLanguage === "en" ? "Tutorial progress could not be saved. Try again." : "引导进度保存失败，请重试。"); }
    });
  }
  async runEchoInkOnboardingNavigation(action: () => Promise<void>): Promise<void> {
    const previousSetup = { ...this.settings.setup }, previousRequested = this.onboardingRequested;
    try { await action(); }
    catch (error) {
      const changed = JSON.stringify(previousSetup) !== JSON.stringify(this.settings.setup);
      this.settings.setup = previousSetup; this.onboardingRequested = previousRequested;
      if (changed) {
        try { await this.saveSettings(true); }
        catch (saveError) { console.warn("EchoInk onboarding navigation rollback failed", saveError); }
      }
      throw error;
    }
  }
  hideEchoInkOnboardingWorkspaceCard(): void { this.clearEchoInkOnboardingWorkspaceCoachmark(false); }
  showEchoInkOnboardingCompletion(): void {
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
    const anchor = this.getCodexView()?.onboardingAgentAnchor ?? this.app.workspace.containerEl;
    const back = async () => { await this.activateHomeAndSidebar(); this.clearEchoInkOnboardingWorkspaceCoachmark(false); await this.openPaperGuideAfterOnboarding(); };
    this.onboardingWorkspaceCoachmark = mountEchoInkOnboardingCoachmark({
      app: this.app, anchor, stepClass: "complete", stepLabel: "", complete: true,
      ...onboardingCompletionCopy(this.settings.settingsLanguage !== "en"), restoreFocusEl: anchor,
      onPrevious: async () => { await this.restartEchoInkOnboarding(); await this.openPendingEchoInkOnboarding(); },
      onAction: back, onDismiss: back,
      onActionError: error => { console.warn("EchoInk onboarding completion failed", error); new Notice(this.settings.settingsLanguage === "en" ? "The action did not finish. Try again." : "操作未完成，请重试。"); }
    });
  }
  private findEchoInkOnboardingSettingsAnchor(): HTMLElement | null {
    return this.app.workspace.containerEl.ownerDocument.querySelector<HTMLElement>(
      '[data-echoink-onboarding-anchor="settings"]'
    );
  }
  private isEchoInkOnboardingDesktopReady(): boolean {
    const ownerDocument = this.app.workspace.containerEl.ownerDocument;
    const settingsModal = ownerDocument.querySelector<HTMLElement>(".modal.mod-settings");
    if (!settingsModal) return true;
    const computed = ownerDocument.defaultView?.getComputedStyle(settingsModal);
    return computed?.display === "none" || computed?.visibility === "hidden";
  }
  private waitForEchoInkOnboardingDesktop(): void {
    const ownerDocument = this.app.workspace.containerEl.ownerDocument;
    const MutationObserverCtor = ownerDocument.defaultView?.MutationObserver
      ?? MutationObserver;
    const observer = new MutationObserverCtor(() => {
      if (
        !this.onboardingRequested
        || this.settings.setup.tutorialStep !== "sidebar"
        || !this.isEchoInkOnboardingDesktopReady()
      ) return;
      observer.disconnect();
      this.onboardingDesktopWaitCleanup = null;
      void this.showEchoInkOnboardingWorkspaceCoachmark("sidebar");
    });
    observer.observe(ownerDocument.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden"]
    });
    this.onboardingDesktopWaitCleanup = () => observer.disconnect();
  }
  private clearEchoInkOnboardingWorkspaceCoachmark(restoreFocus: boolean): void {
    this.onboardingDesktopWaitCleanup?.();
    this.onboardingDesktopWaitCleanup = null;
    this.onboardingWorkspaceCoachmark?.destroy(restoreFocus);
    this.onboardingWorkspaceCoachmark = null;
  }
  applyComposerDefaultsToView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX)) {
      if (leaf.view instanceof CodexView) {
        leaf.view.applySavedComposerDefaults();
      }
    }
  }
  getCodexView(): CodexView | null { return this.getViewService().getCodexView(); }
  refreshKnowledgeBaseSurfaces(): void { this.getViewService().refreshKnowledgeBaseSurfaces(); }
  async refreshLanguageSurfaces(): Promise<void> { await this.getViewService().refreshLanguageSurfaces(); }
  async openEchoInkGeneralSettings(): Promise<void> { await this.getViewService().openEchoInkSettings("general"); }
  async openEchoInkKnowledgeSettings(): Promise<void> {
    await this.getViewService().openEchoInkSettings("knowledgeBase");
  }
  async openWorkspaceResourceSettings(tab: ResourceManagementTab = "plugins"): Promise<void> { return this.getViewService().openWorkspaceResourceSettings(tab); }
  async openReviewHtmlPreview(relativePath: string): Promise<void> { return this.getViewService().openReviewHtmlPreview(relativePath); }
  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000, signal?: AbortSignal): Promise<unknown[]> {
    return await this.getMcpBrokerService().listTools(resourceId, timeoutMs, signal);
  }
  async callEchoInkMcpTool(input: CallEchoInkMcpToolInput): Promise<unknown> {
    return await this.getMcpBrokerService().callTool(input);
  }
  async callEchoInkMcpToolFromResourceSnapshot(
    input: CallEchoInkMcpToolInput,
    snapshot: Readonly<CodexForObsidianSettings["resources"]>
  ): Promise<unknown> {
    return await this.getMcpBrokerService().callToolFromResourceSnapshot(input, snapshot);
  }
  async saveEchoInkMcpServer(draft: Readonly<EchoInkMcpServerDraft>): Promise<EchoInkResource> {
    return await this.getMcpSettingsService().saveServer(draft);
  }
  async deleteEchoInkMcpServer(resourceId: string): Promise<void> {
    await this.getMcpSettingsService().deleteServer(resourceId);
  }
  async refreshEchoInkMcpServer(resourceId: string, timeoutMs = 30_000, signal?: AbortSignal) {
    return await this.getMcpSettingsService().refreshServer(resourceId, timeoutMs, signal);
  }
  async setEchoInkMcpServerTrusted(resourceId: string, trusted: boolean): Promise<void> {
    await this.getMcpSettingsService().setServerTrusted(resourceId, trusted);
  }
  async setEchoInkMcpServerEnabled(resourceId: string, enabled: boolean): Promise<void> {
    await this.getMcpSettingsService().setServerEnabled(resourceId, enabled);
  }
  async setEchoInkMcpToolPolicy(resourceId: string, toolName: string, patch: { enabled?: boolean; trusted?: boolean }): Promise<void> {
    await this.getMcpSettingsService().setToolPolicy(resourceId, toolName, patch);
  }
  async setEchoInkSkillResourceEnabled(resourceId: string, enabled: boolean): Promise<void> {
    await this.withEchoInkResourceMutation(async () => {
      const previous = structuredClone(this.settings.resources);
      const resource = this.settings.resources.catalog.find((candidate) =>
        candidate.id === resourceId && candidate.kind === "skill"
      );
      if (!resource) throw new Error("skill_resource_not_found");
      if (resource.enabled === enabled) return;
      resource.enabled = enabled;
      await this.getSettingsStore().saveResourceMutation(previous);
    });
  }
  async listPiProviderModels(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderModelListResult> {
    return await this.getPiProviderConfigurationService().listModels(draft);
  }
  async testPiProviderConnection(
    draft: PiProviderConfigurationDraft
  ): Promise<PiProviderConnectionTestResult> {
    return await this.getPiProviderConfigurationService()
      .testConnection(draft);
  }
  async getOpenAICodexAuthStatus(): Promise<OpenAICodexAuthStatus> {
    return await this.getOpenAICodexOAuthService().status();
  }
  async loginOpenAICodex(
    interaction: AuthInteraction
  ): Promise<OpenAICodexAuthStatus> {
    return await this.getOpenAICodexOAuthService().login(interaction);
  }
  async logoutOpenAICodex(): Promise<void> {
    const active = getActiveApiProvider(this.settings);
    const activeCodexOAuth = active?.authMode === "oauth"
      && normalizeApiProviderId(
        active.providerId,
        active.baseUrl,
        active.name
      ) === "openai-codex";
    await logoutOpenAICodexAfterRuntimeSuspension({
      active: activeCodexOAuth,
      suspendRuntime: async () => await this.suspendPiProductionRuntime(),
      logout: async () =>
        await this.getOpenAICodexOAuthService().logout()
    });
  }
  async resolveOpenAICodexAccessToken(): Promise<string> {
    return await this.getOpenAICodexOAuthService().resolveAccessToken();
  }
  async translateEditorSelectionToEnglish(selectedText: string): Promise<string> {
    return await this.withProductActivity(
      async () => await this.getEditorTranslationService().translate(selectedText)
    );
  }
  async cancelHarnessRun(runId: string): Promise<void> {
    const conversationId = this.piRunConversations.get(runId);
    if (conversationId && this.piRuntimeBundle) {
      await this.piRuntimeBundle.runtime.abort(conversationId);
    }
  }
  async prepareEchoInkKnowledgeMaintenanceScope(input: Readonly<{
    request: string;
    attachmentPaths: readonly string[];
  }>): Promise<Readonly<PiKnowledgeMaintenanceScope>> {
    const request = input.request.trim();
    if (input.attachmentPaths.length > 1) {
      throw new Error("/maintain 一次只支持一篇 Raw 笔记。");
    }
    if (input.attachmentPaths.length && request) {
      throw new Error("/maintain 不能同时使用附件和尾随名称。");
    }
    const bundle = await this.ensurePiProductionRuntime();
    if (input.attachmentPaths.length === 1) {
      const vaultRoot = await fsp.realpath(this.getVaultPath());
      const candidate = await fsp.realpath(input.attachmentPaths[0] ?? "")
        .catch(() => "");
      const relative = candidate
        ? path.relative(vaultRoot, candidate).split(path.sep).join("/")
        : "";
      if (
        !candidate
        || !relative
        || relative.startsWith("../")
        || path.isAbsolute(relative)
        || knowledgePathRole(vaultRoot, relative) !== "raw"
        || !isRawMarkdownPath(relative)
      ) {
        throw new Error("/maintain 附件必须是当前 Vault 已绑定资料来源中的 Markdown 笔记。");
      }
      await bundle.knowledgeAgentIndex.read({ vaultRelativePath: relative });
      return Object.freeze({
        mode: "exact" as const,
        sourcePaths: Object.freeze<[string]>([relative])
      });
    }
    return await bundle.resolveMaintenanceScope(request);
  }
  async submitPiChat(
    request: PiChatSubmitRequest
  ): Promise<PiChatRunHandle> {
    assertPiSubmissionActive(request.signal);
    const conversationId = request.conversationId;
    if (
      this.piSubmittingConversations.has(conversationId)
      || [...this.piRunConversations.values()].includes(conversationId)
    ) {
      throw new Error("当前会话正在处理请求，请等待本轮完成。");
    }
    this.piSubmittingConversations.add(conversationId);
    try {
      return await this.productActivity.run(async () => {
        assertPiSubmissionActive(request.signal);
        const entry = await this.readPiConversationCatalogEntry(conversationId);
        if (entry && this.conversationRunService?.isAgentBlocked(entry.agentId ?? GENERAL_ASSISTANT_ID)) throw new Error("agent_removal_in_progress");
        await waitForPiSubmission(this.waitForPiConversationActivation(conversationId), request.signal);
        const bundle = await waitForPiSubmission(this.ensurePiProductionRuntime(), request.signal);
        assertPiSubmissionActive(request.signal);
        const handle = await bundle.runtime.submit(request);
        void handle.result.then(async (result) => {
          if (result.terminalState === "completed") {
            await this.usageStore?.recordCompletedTurn(result.productRunId, result.settledAt ?? result.updatedAt);
          }
        }).catch((error) => console.error("EchoInk conversation usage could not be recorded", error));
        this.piRunConversations.set(
          handle.productRunId,
          handle.conversationId
        );
        return handle;
      }, { concurrent: true });
    } finally {
      this.piSubmittingConversations.delete(conversationId);
    }
  }

  subscribePiRun(
    productRunId: string,
    listener: PiChatRuntimeEventListener
  ): PiChatEventSubscription {
    if (!this.piRuntimeBundle) {
      throw new Error("EchoInk Pi Runtime 尚未就绪。");
    }
    return this.piRuntimeBundle.runtime.subscribeProductRun(
      productRunId,
      listener
    );
  }
  piAgentApprovalBinding(
    identity: Readonly<PiAgentApprovalIdentity>
  ): PiAgentApprovalDecisionBinding | null {
    return this.piRuntimeBundle?.approvalBroker.bindingFor(identity) ?? null;
  }
  piTurnInteractionBinding(
    identity: Readonly<PiTurnInteractionIdentity>
  ): PiTurnInteractionDecisionBinding | null {
    return this.piRuntimeBundle?.interactionBroker.bindingFor(identity) ?? null;
  }
  subscribePiAgentApproval(
    identity: Readonly<PiAgentApprovalRunIdentity>,
    listener: () => void
  ): PiAgentApprovalSubscription {
    return this.piRuntimeBundle?.approvalBroker.subscribeRun(identity, listener)
      ?? Object.freeze({ unsubscribe: () => undefined });
  }
  isPiProductionRun(runId: string): boolean {
    return this.piRunConversations.has(runId);
  }
  releasePiProductionRun(runId: string): void {
    this.piRunConversations.delete(runId);
    this.piRuntimeBundle?.runtime.releaseProductRun(runId);
  }
  async readPiConversationProjection(
    conversationId: string
  ): Promise<PiConversationProjection> {
    if (this.piRuntimeBundle) {
      return await this.piRuntimeBundle.runtime.readProjection(conversationId);
    }
    const localData = await this.ensurePiLocalData();
    const cwd = this.settings.sessions.find(
      (session) => session.id === conversationId
    )?.cwd;
    return await localData.readConversationProjection(conversationId, cwd);
  }
  async readPiConversationSupportState(
    conversationId: string
  ): Promise<PiConversationSupportState> {
    return await (await this.ensurePiLocalData())
      .readConversationSupportState(conversationId);
  }
  async recordPiAnswerSave(conversationId: string, messageId: string, path: string): Promise<void> {
    const recording = this.piConversationActivationLane.then(async () => {
      if (this.piRuntimeBundle) {
        await this.piRuntimeBundle.runtime.recordAnswerSave(conversationId, messageId, path);
        return;
      }
      const localData = await this.ensurePiLocalData();
      await recordDurablePiAnswerSave({
        catalog: localData.catalog, sessionApi: localData.sessionApi, conversationId, messageId, path,
        resolveConversationCwd: () => this.settings.sessions.find(session => session.id === conversationId)?.cwd
          || localData.vaultRootPath
      });
    });
    this.piConversationActivationLane = recording.catch(() => undefined);
    await recording;
  }
  async discardPiConversationDraft(
    conversationId: string,
    draftId: string
  ): Promise<boolean> {
    return await (await this.ensurePiLocalData())
      .discardDraft(conversationId, draftId);
  }
  async recoverPiConversationFromVerifiedPrefix(
    input: RecoverPiNativeConversationInput
  ): Promise<Readonly<PiNativeConversationRecoveryResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.recoverConversationFromVerifiedPrefix(input);
  }
  async readPiExperienceSourceRef(
    productRunId: string
  ): Promise<Readonly<ExperienceSourceRef> | null> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.readExperienceSourceRef(productRunId);
  }
  async listPiConversations(
    statuses?: readonly PiConversationCatalogStatus[]
  ): Promise<Readonly<PiConversationCatalogEntry>[]> {
    const localData = await this.ensurePiLocalData();
    try {
      await this.syncPiConversationTaskMetadata();
    } catch (error) {
      console.warn("EchoInk task metadata could not sync; loading the existing conversation list.", error);
    }
    return (await localData.listConversations(statuses)).filter(entry => !entry.conversationId.startsWith("knowledge-linking-"));
  }
  async readPiConversationCatalogEntry(conversationId: string): Promise<Readonly<PiConversationCatalogEntry> | null> {
    return await (await this.ensurePiLocalData()).catalog.get(conversationId);
  }
  async readWorkbenchTaskReceipts(taskId: string): Promise<readonly Readonly<import("./harness/pi-native/domain-receipt-store").DomainReceipt>[]> {
    return (await this.ensurePiLocalData()).receipts.listReceipts({ conversationId: taskId, statuses: ["completed"] });
  }
  getConversationRunService(): ConversationRunService {
    if (!this.conversationRunService) {
      this.conversationRunService = new ConversationRunService(this);
      // Owned by the same service: dispose() clears this subscription on plugin unload.
      this.conversationRunService.subscribe({ refresh() {}, isTaskVisible: () => false,
        clearAcceptedDraft: item => this.consumeAcceptedTaskComposerDraft(item) });
    }
    return this.conversationRunService;
  }
  resumeTask(taskId: string, optionalMessage?: string, frozenItem?: QueuedTurnItem): Promise<import("./ui/codex-view/runner-context").QueuedTurnOutcome> {
    if (this.knowledgeBase?.upgrade?.ownsTask(taskId)) return this.knowledgeBase.resumeUpgrade().then(snapshot => snapshot.status === "running" ? "running" : snapshot.status === "completed" ? "completed" : "failed");
    return this.getConversationRunService().resumeTask(taskId, optionalMessage, frozenItem);
  }
  isTaskResuming(taskId: string): boolean { return this.knowledgeBase?.upgrade?.ownsTask(taskId) ? this.knowledgeBase.upgrade.running : this.conversationRunService?.isResuming(taskId) ?? false; }
  getTaskResumeError(taskId: string): string | undefined { return this.conversationRunService?.getResumeError(taskId); }
  get activeTaskResumeSafety(): ReadonlyMap<string, Readonly<TaskResumeContext>> {
    return this.getConversationRunService().activeResumeContexts;
  }
  async resumeTaskAndOpenDetail(taskId: string, optionalMessage?: string, frozenItem?: QueuedTurnItem): Promise<import("./ui/codex-view/runner-context").QueuedTurnOutcome> {
    const [opening, resumed] = await Promise.allSettled([this.openTaskDetail(taskId), this.resumeTask(taskId, optionalMessage, frozenItem)]);
    if (opening.status === "rejected") throw opening.reason;
    if (resumed.status === "rejected") throw resumed.reason;
    return resumed.value;
  }
  async readTaskInterruption(taskId: string): Promise<TaskInterruptionInfo | null> {
    const local = await this.ensurePiLocalData();
    const entry = await local.catalog.get(taskId);
    if (!entry || entry.status === "deleted" || entry.taskStatus !== "interrupted") return null;
    const runs = await local.productRuns.listReadOnly(taskId);
    const last = latestTaskRun(runs);
    const safety = last ? await readTaskResumeSafety({ ...local, conversationId: taskId, vaultRootPath: this.getVaultPath(), interruptedRunId: last.productRunId }) : null;
    const stage = last?.interruption?.stage?.trim() || entry.taskStage?.trim()
      || (last ? readDurableTaskInterruptionStage({ catalogStore: local.catalog, catalog: entry, runs, productRunId: last.productRunId }) : "");
    return {
      taskId, at: last?.interruption?.at ?? entry.taskInterruptedAt ?? last?.settledAt ?? last?.updatedAt ?? entry.updatedAt,
      reason: last?.interruption?.reason ?? (last?.terminalState === "failed" ? "run_failed" : "process_unknown"),
      stage,
      ...(last?.interruption?.detail ? { detail: last.interruption.detail } : last?.error ? { detail: last.error } : {}),
      uncertainOperations: (safety?.operations ?? []).filter(operation => operation.status === "uncertain").map(operation => ({ id: operation.operationIdentity, label: operation.label }))
    };
  }
  async recordTaskInterruption(taskId: string, reason: TaskInterruptionReason): Promise<void> {
    await this.piRuntimeBundle?.runtime.recordTaskInterruption(taskId, reason);
  }
  /** Only the run service calls this after synchronously taking its resume lease. */
  async prepareTaskResume(taskId: string, message?: string, frozenItem?: QueuedTurnItem, signal?: AbortSignal): Promise<QueuedTurnItem> {
    assertPiSubmissionActive(signal);
    const reply = this.settings.taskWorkspace?.replyDrafts[taskId];
    const choice = reply ? { providerId: reply.selectedProviderSettingsId, model: reply.selectedModel, permission: reply.selectedPermission, mode: reply.selectedMode } : undefined;
    const local = await this.ensurePiLocalData();
    assertPiSubmissionActive(signal);
    const entry = await local.catalog.get(taskId);
    assertPiSubmissionActive(signal);
    if (!entry || entry.status === "deleted") throw new Error("这个任务已不存在，无法继续。");
    if (entry.taskStatus !== "interrupted") throw new Error("这个任务当前不是已中断状态，请查看最新记录。");
    if (this.getConversationRunService().isAgentBlocked(entry.agentId ?? GENERAL_ASSISTANT_ID)) throw new Error("这个 Agent 正在调整，请稍后继续。");
    // Loading this original JSONL validates its active branch and keeps native compaction intact.
    const projection = await this.readPiConversationProjection(taskId);
    assertPiSubmissionActive(signal);
    if (projection.catalog.piSessionId !== entry.piSessionId) throw new Error("任务的原始记录已变化，请重新打开后继续。");
    const last = latestTaskRun(await local.productRuns.listReadOnly(taskId));
    assertPiSubmissionActive(signal);
    if (!last) throw new Error("这件任务没有可核对的运行记录，暂时无法安全继续。已有文字和附件已保留。");
    const snapshotInput = { ...local, conversationId: taskId, vaultRootPath: this.getVaultPath(), ...(last ? { interruptedRunId: last.productRunId } : {}) };
    const inspected = await readTaskResumeSafety(snapshotInput);
    assertPiSubmissionActive(signal);
    let item: QueuedTurnItem;
    if (frozenItem) {
      if (frozenItem.sessionId !== taskId) throw new Error("这份文字和附件不属于当前任务，请重新发送。");
      item = cloneQueuedTurnItem(frozenItem);
      if (message !== undefined && message !== frozenItem.text) throw new Error("发送内容与已保存的快照不一致，请重新发送。");
    } else {
      const providerId = choice?.providerId ?? this.settings.activeApiProviderId;
      const modelId = choice?.model ?? this.settings.defaultModel;
      const provider = this.settings.apiProviders.find(provider => provider.id === providerId);
      const model = provider && getApiProviderModel(provider, modelId);
      if (!provider || !model) throw new Error("没有可用模型，请先在设置中选择模型。");
      item = { id: newId("task-resume"), sessionId: taskId, text: message?.trim() || "请带着本任务已有上下文继续，先核对已经完成的内容和未完成步骤。", attachments: [], skill: null, kind: "chat", createdAt: Date.now(),
        turnOptions: { cwd: this.getVaultPath(), providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId, model: model.id,
          reasoning: resolveComposerReasoningState(this.settings, provider.id, model.id)?.effort ?? "none",
          permission: choice?.permission ?? this.settings.defaultPermission, mode: choice?.mode ?? this.settings.defaultMode, mcpEnabled: true }, clearComposerAfterPiAcceptance: false };
    }
    const selection = item.turnOptions;
    const provider = this.settings.apiProviders.find(provider => provider.id === selection.providerSettingsId);
    if (!provider || !getApiProviderModel(provider, selection.model)) throw new Error("没有可用模型，请检查当前 Provider 和模型设置。");
    if (!apiProviderHasUsableCredential(provider, this.settings.openAICodexCredential)) throw new Error("当前模型尚未登录或缺少 API Key，请先检查模型设置。");
    const validation = validateApiProvider(provider);
    if (validation.length) throw new Error(`当前模型配置不可用：${validation.join("；")}`);
    if (!frozenTurnReasoningSelectionIsValid(this.settings, selection)) throw new Error("当前模型或思考强度已变化，请重新选择后继续。");
    await assertTaskResumeCapabilities(this, local.catalog, taskId, { permission: selection.permission, mode: selection.mode === "plan" ? "plan" : "agent", memoryMode: this.settings.memory.useLongTermMemory === false ? "no_memory" : "normal" }, last?.agentSnapshot, inspected.operations);
    assertPiSubmissionActive(signal);
    const safety = await prepareTaskResumeSafety(snapshotInput);
    assertPiSubmissionActive(signal);
    if (safety.fileConflicts.length) throw new Error(`文件已被修改，本次没有继续，也不会覆盖：${safety.fileConflicts.map(conflict => conflict.relativePath).join("、")}`);
    const interruption = {
      at: last?.interruption?.at ?? entry.taskInterruptedAt ?? last?.updatedAt ?? entry.updatedAt,
      reason: last?.interruption?.reason ?? (last?.terminalState === "failed" ? "run_failed" as const : "process_unknown" as const),
      stage: last?.interruption?.stage ?? entry.taskStage ?? "",
      ...(last?.interruption?.detail ? { detail: last.interruption.detail } : {})
    };
    item.resumeContext = { safety, interruption };
    const current = await local.catalog.get(taskId);
    assertPiSubmissionActive(signal);
    if (!current || current.status === "deleted" || current.agentId !== entry.agentId || current.piSessionId !== entry.piSessionId || current.taskStatus !== "interrupted") throw new Error("任务负责人或记录已变化，请重新打开后继续。");
    if (this.getConversationRunService().isAgentBlocked(current.agentId ?? GENERAL_ASSISTANT_ID)) throw new Error("这个 Agent 正在调整，请稍后继续。");
    let session = this.settings.sessions.find(session => session.id === taskId);
    if (!session) {
      session = { id: taskId, piSessionId: entry.piSessionId, title: entry.title, cwd: this.getVaultPath(), messages: projection.messages,
        bodyAuthority: "pi_session_only", defaultMemoryMode: entry.defaultMemoryMode, ...(entry.defaultSkillId ? { defaultSkillId: entry.defaultSkillId } : {}), createdAt: entry.createdAt, updatedAt: entry.updatedAt };
      applyConversationTaskMetadata(session, entry);
      this.settings.sessions.push(session);
    }
    return item;
  }

  private consumeAcceptedTaskComposerDraft(item: Parameters<typeof consumeAcceptedTaskDraft>[2]): void {
    if (this.settings.taskWorkspace) consumeAcceptedTaskDraft(this.settings.taskWorkspace, item.sessionId, item);
  }
  /** Import unstamped P1 projections once. Afterwards Catalog only hydrates settings. */
  async syncPiConversationTaskMetadata(): Promise<void> {
    const sync = this.piTaskMetadataSyncTail.then(async () => {
      const localData = this.piLocalData;
      if (!localData) return;
      for (const shell of this.settings.sessions) {
        await this.piTaskMetadataWriteTails.get(shell.id)?.catch(() => undefined);
        const entry = await localData.catalog.get(shell.id);
        if (!entry || entry.status === "deleted" || (shell.piSessionId && shell.piSessionId !== entry.piSessionId)) continue;
        if (entry.taskMetadataUpdatedAt === undefined) {
          const { taskMetadataUpdatedAt: _revision, ...metadata } = normalizeConversationTaskMetadata(shell);
          await this.setPiConversationTaskMetadata(shell.id, metadata, { importOnlyIfUnstamped: true });
        } else if ((shell.taskMetadataUpdatedAt ?? -1) <= entry.taskMetadataUpdatedAt) {
          applyConversationTaskMetadata(shell, entry);
        }
      }
    });
    this.piTaskMetadataSyncTail = sync.catch(() => undefined);
    await sync;
  }
  async setPiConversationTaskMetadata(
    conversationId: string,
    patch: ConversationTaskMetadataPatch,
    options: { importOnlyIfUnstamped?: boolean; markReadThrough?: number; onlyIfStatusMissing?: boolean } = {},
    metadataUpdatedAt = Date.now()
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    const submitted = structuredClone(patch);
    const previous = this.piTaskMetadataWriteTails.get(conversationId) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const localData = await this.ensurePiLocalData();
      const current = await localData.catalog.get(conversationId);
      if (!current) throw new Error(`Conversation ${conversationId} not found`);
      if (options.onlyIfStatusMissing && current.taskStatus !== undefined || options.importOnlyIfUnstamped && current.taskMetadataUpdatedAt !== undefined) {
        for (const shell of this.settings.sessions) if (shell.id === conversationId) applyConversationTaskMetadata(shell, current);
        return current;
      }
      if (options.markReadThrough !== undefined && current.unreadAnswerAt !== undefined && current.unreadAnswerAt > options.markReadThrough) delete submitted.unreadAnswerAt;
      const metadata = patchConversationTaskMetadata(current, submitted);
      const entry = this.piRuntimeBundle
        ? await this.piRuntimeBundle.runtime.setConversationTaskMetadata(conversationId, metadata, current.taskMetadataUpdatedAt, metadataUpdatedAt)
        : await localData.catalog.updateTaskMetadata(conversationId, metadata, current.taskMetadataUpdatedAt, metadataUpdatedAt);
      for (const shell of this.settings.sessions) {
        if (shell.id === conversationId) applyConversationTaskMetadata(shell, entry);
      }
      return entry;
    });
    this.piTaskMetadataWriteTails.set(conversationId, write);
    try { return await write; }
    finally { if (this.piTaskMetadataWriteTails.get(conversationId) === write) this.piTaskMetadataWriteTails.delete(conversationId); }
  }
  private async writeAgentRegistry(action: () => Promise<void>): Promise<void> {
    const write = (this.agentRegistryWriteTail ?? Promise.resolve()).catch(() => undefined).then(action);
    this.agentRegistryWriteTail = write.catch(() => undefined);
    await write;
    this.getCodexView()?.refreshAgentTasks();
    for (const listener of this.agentRegistryListeners ?? []) listener();
  }
  onAgentRegistryChanged(listener: () => void): () => void {
    this.agentRegistryListeners.add(listener);
    return () => { this.agentRegistryListeners.delete(listener); };
  }
  async setAgentModuleOwner(moduleId: AgentModuleId, agentId: string): Promise<void> {
    await this.writeAgentRegistry(async () => {
      const previous = this.settings.agentRegistry;
      this.settings.agentRegistry = setModuleOwner(previous, moduleId, agentId);
      try { await this.saveSettings(true); }
      catch (error) { this.settings.agentRegistry = previous; throw error; }
    });
  }
  async saveAgentDefinition(agent: AgentDefinition, moduleIds: readonly AgentModuleId[], baseline?: { agent: AgentDefinition; moduleIds: readonly AgentModuleId[] }, onboarding = false): Promise<void> {
    agent = structuredClone(agent); moduleIds = [...moduleIds];
    baseline = baseline ? structuredClone(baseline) : undefined;
    if (this.conversationRunService?.isAgentBlocked(agent.id)) throw new Error("agent_removal_in_progress");
    await this.writeAgentRegistry(async () => {
      const previous = this.settings.agentRegistry;
      const previousSetup = { ...this.settings.setup }, previousRequested = this.onboardingRequested;
      if (onboarding) {
        const created = previous.agents.find(entry => entry.id === this.settings.setup.onboardingAgentId);
        if (created) {
          if (created.id === agent.id) return;
          throw new Error(this.settings.settingsLanguage === "en" ? "Your colleague was already created." : "这位同事已经创建，请勿重复提交。");
        }
        if (!this.onboardingRequested || this.settings.setup.tutorialStep !== "colleague") throw new Error("Onboarding step changed");
      }
      const current = previous.agents.find(entry => entry.id === agent.id);
      if (!baseline && current) throw new Error(this.settings.settingsLanguage === "en" ? "This Agent was already created. Reopen it to edit." : "这个 Agent 已经创建，请重新打开后编辑。你的输入已保留。");
      if (baseline && (!current || baseline.agent.id !== agent.id)) throw new Error(this.settings.settingsLanguage === "en" ? "This Agent was deleted. Your draft has been kept." : "这个 Agent 已被删除，你的输入已保留。");
      if (baseline && JSON.stringify(current) !== JSON.stringify(baseline.agent)) throw new Error(this.settings.settingsLanguage === "en" ? "This Agent changed elsewhere. Reopen it before saving." : "这个 Agent 已在别处修改，请重新打开后核对。你的输入已保留。");
      const candidate = normalizeAgentRegistry({ ...previous, agents: current ? previous.agents.map(entry => entry.id === agent.id ? { ...agent, identityEdited: true } : entry) : [...previous.agents, { ...agent, identityEdited: true }] });
      if (!candidate.agents.some(entry => entry.id === agent.id)) throw new Error("agent_definition_invalid");
      for (const id of AGENT_MODULE_IDS) {
        // Unchanged assignments belong to the current registry, not an old editor.
        if (baseline && baseline.moduleIds.includes(id) === moduleIds.includes(id)) continue;
        candidate.moduleOwners[id] = moduleIds.includes(id) ? agent.id
          : previous.moduleOwners[id] === agent.id ? GENERAL_ASSISTANT_ID : previous.moduleOwners[id];
      }
      this.settings.agentRegistry = candidate;
      if (onboarding) {
        this.settings.setup.onboardingAgentId = agent.id;
        advanceEchoInkOnboardingTutorial(this.settings.setup, "colleague", Date.now());
        this.onboardingRequested = false;
      }
      try { await this.saveSettings(true); }
      catch (error) { this.settings.agentRegistry = previous; if (onboarding) { this.settings.setup = previousSetup; this.onboardingRequested = previousRequested; } throw error; }
    });
  }
  async saveOnboardingAgentDefinition(agent: AgentDefinition, moduleIds: readonly AgentModuleId[]): Promise<void> {
    await this.saveAgentDefinition(agent, moduleIds, undefined, true);
  }
  getAgentCapabilityAvailability(id: string, resources: readonly EchoInkResource[] = []): { available: boolean; reason?: string } {
    const settings = this.settings, zh = settings.settingsLanguage !== "en";
    const enabled = id === "finance" ? settings.lifestyle.finance.enabled : id === "pdf-reading" ? settings.pdfReading.enabled
      : id === "english-diary" ? settings.englishDiary.enabled : id === "web-search" ? settings.tavily.enabled && !!settings.tavily.apiKey.trim()
        : id === "journal" ? settings.knowledgeBase.folderBindings?.roles.journal.enabled !== false
          : id === "knowledge" ? !settings.knowledgeBase.folderBindings || ["raw", "wiki", "projects", "inbox"].some(role => settings.knowledgeBase.folderBindings!.roles[role as "raw"].enabled) : true;
    if (!enabled) return { available: false, reason: zh ? "对应功能尚未启用" : "This feature is disabled" };
    if (["finance", "pdf-reading", "english-diary"].includes(id) && !hasProPluginAccess(this.accountService ?? unavailableCapabilityAccess)) return { available: false, reason: zh ? "需要有效 PRO，已有资料仍可查看" : "Requires an active PRO membership; existing data remains readable" };
    if (id.startsWith("mcp:") || id.startsWith("vault-skill:")) {
      let resourceId: string; try { resourceId = decodeURIComponent(id.split(":")[1]); } catch { return { available: false, reason: zh ? "资源不可用" : "Resource unavailable" }; }
      const resource = resources.find(resource => resource.id === resourceId || resource.metadata?.resourceId === resourceId);
      if (!resource?.enabled) return { available: false, reason: zh ? "资源已禁用或不可用" : "Resource disabled or unavailable" };
    }
    return { available: true };
  }
  async listAgentTaskEntries(): Promise<Readonly<PiConversationCatalogEntry>[]> {
    const entries = (await this.listPiConversations()).filter(entry => entry.status !== "deleted");
    const localData = await this.ensurePiLocalData();
    const visible: Readonly<PiConversationCatalogEntry>[] = [];
    for (const entry of entries) {
      if (entry.taskStatus) { visible.push(entry); continue; }
      const runs = await localData.productRuns.list(entry.conversationId);
      const last = [...runs].sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0];
      if (!last) {
        try {
          const projection = await localData.readConversationProjection(entry.conversationId);
          if (!projection.messages.some(message => message.role === "user")) continue;
        } catch {
          visible.push(await this.setPiConversationTaskMetadata(entry.conversationId, {
            taskStatus: "interrupted", taskInterruptedAt: entry.updatedAt, pendingResponse: undefined
          }, { onlyIfStatusMissing: true }));
          continue;
        }
      }
      const active = this.conversationRunService?.runs.get(entry.conversationId);
      visible.push(await this.setPiConversationTaskMetadata(entry.conversationId,
        active?.running ? { taskStatus: entry.pendingResponse ? "waiting" : "running", taskStartedAt: last?.createdAt ?? entry.updatedAt }
          : last?.terminalState === "completed" && !entry.pendingResponse
            ? { taskStatus: "completed", taskCompletedAt: last.settledAt ?? last.updatedAt }
            : { taskStatus: "interrupted", taskInterruptedAt: last?.settledAt ?? last?.updatedAt ?? entry.updatedAt, pendingResponse: undefined }, { onlyIfStatusMissing: true }));
    }
    return visible;
  }
  async getAgentDeleteCounts(agentId: string): Promise<{ total: number; running: number }> {
    const tasks = (await this.listAgentTaskEntries()).filter(entry => (entry.agentId ?? GENERAL_ASSISTANT_ID) === agentId);
    const service = this.getConversationRunService();
    return { total: tasks.length, running: tasks.filter(entry => {
      const run = service.runs.get(entry.conversationId);
      return service.isResuming(entry.conversationId) || run?.running || run?.queueStartInProgress || !!run?.flight || this.piSubmittingConversations.has(entry.conversationId)
        || [...this.piRunConversations.values()].includes(entry.conversationId);
    }).length };
  }
  async openTaskDetail(taskId: string): Promise<void> {
    await this.activateView();
    const view = this.getCodexView();
    if (view && await view.waitForTaskUiReady()) await view.openTaskDetail(taskId);
  }
  async openAgentTaskList(agentId: string, prefill?: string, prefillSource?: string, englishDiarySourcePath?: string): Promise<boolean> {
    await this.activateView();
    const view = this.getCodexView();
    return view && await view.waitForTaskUiReady() ? await view.openAgentTaskList(agentId, prefill, prefillSource, englishDiarySourcePath) : false;
  }
  async deleteAgent(agentId: string): Promise<void> {
    if (agentId === GENERAL_ASSISTANT_ID) throw new Error("general_assistant_cannot_be_deleted");
    if (!this.settings.agentRegistry.agents.some(agent => agent.id === agentId)) return;
    const service = this.getConversationRunService();
    if (service.isAgentBlocked(agentId)) throw new Error("agent_removal_in_progress");
    service.blockAgent(agentId);
    try {
      await this.writeAgentRegistry(async () => {
      const localData = await this.ensurePiLocalData();
      const tasks = (await localData.catalog.list()).filter(entry => entry.agentId === agentId && entry.status !== "deleted");
      const stopForHandoff = async (entries: readonly Readonly<PiConversationCatalogEntry>[]) => {
        await Promise.all(entries.map(entry => service.stopTask(entry.conversationId)));
        await this.requireKnowledgeSurfaceService().linking.stopForOrigins(entries.map(task => task.conversationId));
        // Rebuild fixed identity next turn, retaining the durable Pi Session.
        await Promise.all(entries.map(task => this.releasePiConversation(task.conversationId)));
      };
      await stopForHandoff(tasks);
      // A business write that was already in flight can finish creating its
      // internal judge Conversation while being drained. Include it as well.
      const known = new Set(tasks.map(task => task.conversationId));
      const late = (await localData.catalog.list()).filter(entry => entry.agentId === agentId && entry.status !== "deleted" && !known.has(entry.conversationId));
      if (late.length) { await stopForHandoff(late); tasks.push(...late); }
      for (const task of tasks) await this.setPiConversationTaskMetadata(task.conversationId, { agentId: GENERAL_ASSISTANT_ID });
      const previous = this.settings.agentRegistry;
      this.settings.agentRegistry = removeAgentDefinition(previous, agentId);
      try { await this.saveSettings(true); }
      catch (error) { this.settings.agentRegistry = previous; throw error; }
      });
    } finally { service.unblockAgent(agentId); }
  }
  async createPiConversation(
    input: CreatePiNativeConversationInput
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    if (this.conversationRunService?.isAgentBlocked(input.agentId ?? GENERAL_ASSISTANT_ID)) throw new Error("agent_removal_in_progress");
    return await createPiLocalConversation(await this.ensurePiLocalData(), input);
  }
  async derivePiConversation(
    input: DerivePiNativeConversationInput
  ): Promise<Readonly<PiConversationDerivationResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.deriveConversation(input);
  }
  async renamePiConversation(
    conversationId: string,
    title: string
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    await this.settlePiRuntimeFlight();
    return this.piRuntimeBundle
      ? await this.piRuntimeBundle.runtime.renameConversation(
          conversationId,
          title
        )
      : await (await this.ensurePiLocalData()).renameConversation(
          conversationId,
          title
        );
  }
  async setPiConversationMemoryMode(
    conversationId: string,
    defaultMemoryMode: PiConversationMemoryMode
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    await this.settlePiRuntimeFlight();
    return this.piRuntimeBundle
      ? await this.piRuntimeBundle.runtime.setConversationMemoryMode(
          conversationId,
          defaultMemoryMode
        )
      : await (await this.ensurePiLocalData()).setConversationMemoryMode(
          conversationId,
          defaultMemoryMode
        );
  }
  onConversationCatalogChanged(listener: () => void): () => void {
    this.conversationCatalogListeners.add(listener);
    return () => { this.conversationCatalogListeners.delete(listener); };
  }
  private isAutoArchiveProtected(id: string): boolean {
    if (this.piSubmittingConversations.has(id)
      || this.piConversationActivationTasks.has(id) || [...this.piRunConversations.values()].includes(id)) return true;
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX).some(leaf =>
      leaf.view instanceof CodexView && leaf.view.isConversationInUse(id));
  }
  private initializeAutoArchive(): void {
    if (this.autoArchive || !this.piLocalData) return;
    const data = this.piLocalData;
    this.autoArchive = new ConversationAutoArchive({
      days: () => this.settings.autoArchiveDays,
      list: () => data.listConversations(["active"]),
      activity: async id => {
        const [entry, runs, drafts] = await Promise.all([data.catalog.get(id), data.productRuns.list(id), data.catalog.drafts(id)]);
        return { updatedAt: runs.reduce((latest, run) => Math.max(latest, run.updatedAt), entry?.updatedAt ?? 0), hasDrafts: drafts.length > 0 || entry?.status !== "active" };
      },
      isProtected: id => this.isAutoArchiveProtected(id),
      archive: async id => {
        if (this.isAutoArchiveProtected(id) || !this.settings.autoArchiveDays) return;
        await this.setPiConversationStatus(id, "archived");
        this.settings.sessions = this.settings.sessions.filter(session => session.id !== id);
        if (this.settings.activeSessionId === id) this.settings.activeSessionId = this.settings.sessions[0]?.id ?? "";
      },
      changed: async () => {
        await this.saveSettings(true, { flushConversationStore: false });
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CODEX)) {
          if (leaf.view instanceof CodexView) leaf.view.refreshAfterAutomaticArchive();
        }
        for (const listener of this.conversationCatalogListeners) listener();
      },
      onError: () => console.warn("EchoInk automatic archive could not complete; it will retry next hour.")
    });
    this.autoArchive.configure();
    this.register(() => { void this.autoArchive?.dispose(); });
  }
  async setPiConversationStatus(
    conversationId: string,
    status: PiConversationCatalogStatus
  ): Promise<Readonly<PiConversationCatalogEntry>> {
    await this.syncPiConversationTaskMetadata();
    const runtime = this.piRuntimeBundle;
    if (status !== "active") {
      // A task waiting for its Production Runtime has not created an
      // AgentSession yet, so cancel it without making local management join
      // that initialization. Once a runtime exists, wait for task cleanup.
      await this.cancelPiConversationActivation(
        conversationId,
        runtime !== null
      );
    }
    try {
      const entry = runtime
        ? await runtime.runtime.setConversationStatus(
            conversationId,
            status
          )
        : await (await this.ensurePiLocalData()).setConversationStatus(
            conversationId,
            status
          );
      for (const listener of this.conversationCatalogListeners ?? []) listener();
      return entry;
    } finally {
      if (
        status !== "active"
        && this.piActivatedConversationId === conversationId
      ) {
        this.piActivatedConversationId = null;
      }
    }
  }
  async activatePiConversation(
    conversationId: string,
    options: PiConversationSelectionActivationOptions = {}
  ): Promise<PiConversationProjection> {
    // Start both sides of the selection before awaiting local history.
    const localProjection = this.readPiConversationProjection(
      conversationId
    );
    const { isStillCurrent, ...activationOptions } = options;
    if (isStillCurrent?.() !== false) {
      this.queuePiConversationActivation(
        null,
        conversationId,
        activationOptions,
        isStillCurrent
      );
    }
    return await localProjection;
  }
  async switchPiConversation(
    previousConversationId: string | null,
    nextConversationId: string,
    options: PiConversationSelectionActivationOptions = {}
  ): Promise<PiConversationProjection> {
    // Start both sides of the selection before awaiting local history.
    const localProjection = this.readPiConversationProjection(
      nextConversationId
    );
    const { isStillCurrent, ...activationOptions } = options;
    if (isStillCurrent?.() !== false) {
      this.queuePiConversationActivation(
        previousConversationId,
        nextConversationId,
        activationOptions,
        isStillCurrent
      );
    }
    return await localProjection;
  }
  async releasePiConversation(conversationId: string): Promise<void> {
    await this.cancelPiConversationActivation(conversationId);
    await this.settlePiRuntimeFlight();
    try {
      await this.piRuntimeBundle?.runtime.releaseConversation(conversationId);
    } finally {
      if (this.piActivatedConversationId === conversationId) {
        this.piActivatedConversationId = null;
      }
    }
  }
  async releasePiConversationIfInactive(
    conversationId: string,
    isStillInactive: () => boolean
  ): Promise<boolean> {
    const previousLane = this.piConversationActivationLane;
    let released = false;
    const release = previousLane.then(async () => {
      if (
        !isStillInactive()
        || this.piActivatedConversationId === conversationId
      ) return;
      await this.settlePiRuntimeFlight();
      if (
        !isStillInactive()
        || this.piActivatedConversationId === conversationId
      ) return;
      released = await this.piRuntimeBundle?.runtime
        .releaseConversationIfIdle(conversationId) ?? false;
    });
    this.piConversationActivationLane = release.then(
      () => undefined,
      () => undefined
    );
    await release;
    return released;
  }
  async steerPiConversation(
    conversationId: string,
    text: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.steer(conversationId, text);
  }
  async followUpPiConversation(
    conversationId: string,
    text: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.followUp(conversationId, text);
  }
  async abortPiConversation(conversationId: string): Promise<void> {
    await this.cancelPiConversationActivation(conversationId, this.piRuntimeBundle !== null);
    await this.piRuntimeBundle?.runtime.abort(conversationId);
  }
  async transitionPiTaskPlan(
    request: Readonly<PiTaskPlanTransitionRequest>
  ): Promise<Readonly<PiTaskPlanTransitionResult>> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.transitionTaskPlan(request);
  }
  async navigatePiConversationBranch(
    conversationId: string,
    targetEntryId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {}
  ): Promise<PiBranchNavigationResult> {
    const bundle = await this.ensurePiProductionRuntime();
    return await bundle.runtime.navigateBranch(
      conversationId,
      targetEntryId,
      options
    );
  }
  async compactPiConversation(
    conversationId: string,
    customInstructions?: string
  ): Promise<void> {
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.compactConversation(
      conversationId,
      customInstructions
    );
  }
  async reloadPiProductionRuntime(): Promise<void> {
    await this.cancelAllPiConversationActivations();
    if (this.piRuntimeFlight) {
      await this.piRuntimeFlight.catch(() => undefined);
    }
    const current = this.piRuntimeBundle;
    this.piRuntimeBundle = null;
    this.piRuntimeFlight = null;
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await current?.runtime.shutdown();
    await this.ensurePiProductionRuntime();
  }
  async activateApiProviderSettings(
    applyCandidate: (settings: CodexForObsidianSettings) => void,
    runtimeMode: "replace" | "preserve" | "suspend" = "replace"
  ): Promise<void> {
    if (this.piRunConversations.size > 0) {
      throw new Error("EchoInk 正在回答，当前模型暂时不能切换。");
    }
    this.productActivity.beginSwitch();
    try {
      const candidateSettings = structuredClone(this.settings);
      applyCandidate(candidateSettings);
      if (runtimeMode === "replace") {
        createPiProductionModelDefinition(candidateSettings);
      }
      const candidateSnapshot = snapshotApiProviderSettings(candidateSettings);
      await this.cancelAllPiConversationActivations();
      await this.apiProviderActivation.run({
        isBusy: () => false,
        beginSwitch: () => undefined,
        endSwitch: () => undefined,
        snapshotMemory: () => snapshotApiProviderSettings(this.settings),
        readPersisted: async () =>
          await this.getSettingsStore().readPersistedApiProviderSettingsSnapshot(),
        applyCandidate: () => restoreApiProviderSettings(
          this.settings,
          candidateSnapshot
        ),
        persistCandidate: async () => {
          await this.saveSettings(true);
        },
        createCandidateRuntime: async () => {
          if (runtimeMode === "preserve") return this.piRuntimeBundle;
          if (runtimeMode === "suspend") return null;
          return await createPiProductionRuntimeBundle(
            this,
            await this.ensurePiLocalData()
          );
        },
        currentRuntime: () => this.piRuntimeBundle,
        finalizeCandidate: async () => undefined,
        abortCandidate: async () => undefined,
        activateRuntime: (runtime) => {
          const changed = runtime !== this.piRuntimeBundle;
          this.piRuntimeBundle = runtime;
          this.piRuntimeFlight = null;
          if (changed) {
            this.piActivatedConversationId = null;
            this.piRunConversations.clear();
          }
        },
        shutdownRuntime: async (runtime) => await runtime.runtime.shutdown(),
        restoreMemory: (snapshot) => restoreApiProviderSettings(this.settings, snapshot),
        restorePersisted: async (snapshot) =>
          await this.getSettingsStore().restorePersistedApiProviderSettingsSnapshot(snapshot)
      });
      this.applyComposerDefaultsToView();
    } finally {
      this.productActivity.endSwitch();
    }
  }

  private async withProductActivity<T>(action: () => Promise<T>): Promise<T> {
    if (this.piRunConversations.size > 0 || this.productActivity.hasActivity) {
      throw new Error("EchoInk 正在处理其他请求，请稍后再试。");
    }
    return await this.productActivity.run(action);
  }

  getDeveloperModeService(): DeveloperModeService {
    if (!this.developerService) {
      this.developerService = new DeveloperModeService(this.developerMode, {
        getSystem: () => this.getCognitiveSystem(),
        vaultName: () => this.app.vault.getName(),
        foregroundBusy: () => this.developerMemoryChanging || this.piRunConversations.size > 0
          || this.piSubmittingConversations.size > 0 || this.productActivity.hasActivity,
        writable: () => this.settings.defaultPermission !== "read-only",
        withLocalActivity: (action) => this.withProductActivity(action),
        changeMemory: (action) => this.changeDeveloperMemory(action),
        latestBackup: async () => new MemoryDeveloperBackups(
          (await this.ensurePiLocalData()).personalMemory.layout.root
        ).latestResetPath()
      });
    }
    return this.developerService;
  }

  private async changeDeveloperMemory(action: "reset" | "restore"): Promise<DeveloperMemoryChange> {
    this.developerMode.require();
    if (this.developerMemoryChanging || this.piRunConversations.size > 0
      || this.piSubmittingConversations.size > 0 || this.cognitiveSystem?.engine.isRunning) {
      throw new Error("developer_mode_busy");
    }
    this.productActivity.beginSwitch();
    this.developerMemoryChanging = true;
    let stopped = false;
    try {
      const localData = this.piLocalData ?? await this.piLocalDataFlight;
      const cognitive = this.cognitiveSystem ?? await this.cognitiveSystemFlight;
      if (!localData || !cognitive) throw new Error("developer_memory_not_ready");
      if (cognitive.engine.isRunning) throw new Error("developer_mode_busy");
      await this.suspendPiProductionRuntime();
      await cognitive.dispose();
      stopped = true;
      this.cognitiveSystem = null;
      this.cognitiveSystemFlight = null;
      this.piLocalData = null;
      this.piLocalDataFlight = null;
      this.personalMemoryCorrection = null;
      const backups = new MemoryDeveloperBackups(localData.personalMemory.layout.root);
      this.developerMode.require();
      return await backups.change(action, async () => {
        const next = await PiLocalDataService.create(this, { recoverDeveloperChange: false });
        try {
          const system = await this.createCognitiveSystem(next);
          await system.dispose();
        } finally { await next.dispose(); }
      });
    } finally {
      // Failed backups/rolled-back changes still need fresh local references.
      // No Provider Runtime is started here; the next Chat builds it lazily.
      try {
        if (stopped && !this.piLocalData) {
          await this.recreateDeveloperMemoryReferences();
        }
      } finally {
        this.developerMemoryChanging = false;
        this.productActivity.endSwitch();
        this.getCodexView()?.refreshPersonalizationUi();
      }
    }
  }
  private async recreateDeveloperMemoryReferences(): Promise<void> {
    const next = await PiLocalDataService.create(this);
    try {
      this.cognitiveSystem = await this.createCognitiveSystem(next);
      this.piLocalData = next;
    } catch (error) {
      await next.dispose();
      throw error;
    }
  }
  async suspendPiProductionRuntime(): Promise<void> {
    await this.cancelAllPiConversationActivations();
    if (this.piRuntimeFlight) {
      await this.piRuntimeFlight.catch(() => undefined);
    }
    const current = this.piRuntimeBundle;
    this.piRuntimeBundle = null;
    this.piRuntimeFlight = null;
    this.piActivatedConversationId = null;
    this.piRunConversations.clear();
    await current?.runtime.shutdown();
  }
  async readEchoInkUserProfile() {
    return (await this.ensurePiLocalData()).personalMemory.readUserProfileControlSnapshot();
  }
  async saveEchoInkUserProfile(input: { profileKey: string; text: string; expectedRevision: number }) {
    const result = await (await this.ensurePiLocalData()).personalMemory.saveUserProfileFromUserControl(input);
    this.getCodexView()?.refreshPersonalizationUi();
    return result;
  }
  async deleteEchoInkUserProfile(input: { profileKey: string; expectedRevision: number }) {
    const result = await (await this.ensurePiLocalData()).personalMemory.deleteUserProfileFromUserControl(input);
    this.getCodexView()?.refreshPersonalizationUi();
    return result;
  }
  async getEchoInkPersonalMemoryState() {
    return await (await this.ensurePiLocalData()).personalMemory.readUserControlState();
  }
  async readEchoInkPersonalMemorySource(id: string, expectedRevision?: number) {
    return await (await this.ensurePiLocalData()).personalMemory.readUserControlSource(id, expectedRevision);
  }

  /** Desktop display identity comes only from the Agent registry. */
  getEchoInkAgentIdentityView(): AgentIdentityView {
    const registry = this.settings.agentRegistry;
    const page = this.settings.taskWorkspace.page;
    const id = page.kind === "list" ? page.agentId : this.settings.sessions.find(session => session.id === page.taskId)?.agentId;
    const agent = registry?.agents.find(agent => agent.id === (id ?? GENERAL_ASSISTANT_ID)) ?? registry?.agents[0];
    return Object.freeze({ displayName: agent?.name ?? DEFAULT_AGENT_DISPLAY_NAME, avatarUrl: agent ? resolveAgentAvatarUrl(agent.avatar) : null, personalityTemplateId: null });
  }

  async generateEchoInkPersonalMemoryCorrection(
    record: PersonalMemoryCorrectionRecord,
    correction: string,
    signal?: AbortSignal
  ) {
    return await this.withProductActivity(
      async () => await this.getPersonalMemoryCorrectionService()
        .generatePreview({ record, correction, signal })
    );
  }
  async applyEchoInkPersonalMemoryCorrection(input: Readonly<{
    targetId: string;
    title: string;
    content: string;
    recallWhen: string;
    reason: string;
    expectedRevision: number;
  }>) {
    return await this.withProductActivity(async () =>
      await (await this.ensurePiLocalData()).personalMemory
        .supersedeFromUserCorrection(input)
    );
  }
  async exportEchoInkPersonalMemory() {
    return await (await this.ensurePiLocalData()).personalMemory.exportMemory();
  }
  async forgetEchoInkPersonalMemory(
    id: string,
    reason: string,
    expectedRevision: number
  ) {
    return await (await this.ensurePiLocalData()).personalMemory.forgetFromUserControl(
      id,
      reason,
      expectedRevision
    );
  }
  async restoreEchoInkPersonalMemory(id: string, expectedRevision: number) {
    return await (await this.ensurePiLocalData()).personalMemory.restoreForgotten(
      id,
      expectedRevision
    );
  }
  async getEchoInkKnowledgeMaintenancePreferenceState() {
    const stores = await this.resolveKnowledgeMaintenancePreferenceStores();
    return await stores.preferences.read();
  }
  async saveEchoInkKnowledgeMaintenancePreferences(
    content: string,
    expectedRevision: string
  ) {
    const stores = await this.resolveKnowledgeMaintenancePreferenceStores();
    return await stores.preferences.save({
      content,
      expectedRevision
    });
  }
  async buildRuntimeEchoInkResourceCatalog(): Promise<EchoInkResource[]> { return await this.getResourceCatalogService().buildRuntimeCatalog(); }
  async requireAvailableEchoInkSkill(skillId: string): Promise<Readonly<EchoInkResource>> {
    return requireAvailableEchoInkSkillResource(
      await this.buildRuntimeEchoInkResourceCatalog(),
      skillId
    );
  }
  async openEchoInkSkillSettings(skillId: string): Promise<void> {
    const resourceId = this.settings.resources.catalog.find((resource) =>
      resource.kind === "skill"
      && resource.metadata?.resourceId === skillId
    )?.id ?? `echoink-local:skill:${skillId}`;
    this.pendingSettingsResourceDetailId = resourceId;
    await this.openWorkspaceResourceSettings("skills");
  }
  consumeEchoInkSettingsResourceDetail(): string {
    const resourceId = this.pendingSettingsResourceDetailId;
    this.pendingSettingsResourceDetailId = "";
    return resourceId;
  }
  getSkillRuntimeCoordinator(): SkillRuntimeCoordinator {
    if (!this.skillRuntimeCoordinator) {
      this.skillRuntimeCoordinator = new SkillRuntimeCoordinator(
        this.getVaultPath(),
        { reviewLlm: () => this.createSkillReviewLlmPort() }
      );
    }
    return this.skillRuntimeCoordinator;
  }
  async readEchoInkBuiltinSkill(
    skillId: BuiltinSkillId
  ): Promise<BuiltinSkillRuntimeSnapshot> {
    return await this.getSkillRuntimeCoordinator().inspectBuiltinSkill(skillId);
  }
  async saveEchoInkBuiltinSkill(
    skillId: BuiltinSkillId,
    content: string
  ): Promise<BuiltinSkillRuntimeSnapshot> {
    return await this.getSkillRuntimeCoordinator()
      .saveBuiltinSkillContent(skillId, content);
  }
  async restoreEchoInkBuiltinSkill(
    skillId: BuiltinSkillId
  ): Promise<BuiltinSkillRuntimeSnapshot> {
    return await this.getSkillRuntimeCoordinator().restoreBuiltinSkill(skillId);
  }
  async readPersistedEchoInkResourceSnapshot(): Promise<
  CodexForObsidianSettings["resources"]> {
    return await this.getSettingsStore().readPersistedEchoInkResourceSnapshot();
  }
  async ensureEchoInkSkillResourcesLoaded(_force = false): Promise<EchoInkResource[]> {
    return enabledSkillResources(await this.buildRuntimeEchoInkResourceCatalog());
  }
  getVaultPath(): string { const adapter = this.app.vault.adapter as { basePath?: string; path?: string }; return adapter.basePath || adapter.path || ""; }
  getPluginDataDirName(): string {
    return pluginInstallDir(this.manifest, this.app.vault.configDir);
  }
  async loadSettings(): Promise<Readonly<SettingsLoadResult>> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> {
    await this.getSettingsStore().saveSettings(force, options);
    this.selectionAskController?.refresh();
    this.autoArchive?.configure();
  }
  async persistPiNativeSettings(): Promise<void> {
    await this.getSettingsStore().saveSettings(true, {
      flushConversationStore: false
    });
  }
  async withEchoInkConversationMutation<R>(conversationId: string, action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withConversationMutation(conversationId, action); }
  async withEchoInkSettingsPersistenceAuthorityGate<R>(action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withSettingsPersistenceAuthorityGate(action); }
  async withEchoInkResourceMutation<R>(action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withResourceMutation(action); }
  async saveEchoInkResourceMutation(previous: CodexForObsidianSettings["resources"]): Promise<void> { await this.getSettingsStore().saveResourceMutation(previous); }
  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> { return this.getSettingsStore().externalizeMessageText(message, fullText); }
  async readRawMessageText(rawRef: string): Promise<string> { return this.getSettingsStore().readRawMessageText(rawRef); }
  getKnowledgeSurfaceService(): EchoInkKnowledgeSurfaceService | null { return this.knowledgeBase; }
  /** Local stores and the Vault journal are available without initializing a Provider. */
  getKnowledgeUpgradeLocalData(): Promise<PiLocalDataService> { return this.ensurePiLocalData(); }
  async readKnowledgeInitialActivities(): Promise<import("./knowledge-base/maintenance-activity").MaintenanceActivity[]> {
    const local = await this.ensurePiLocalData();
    const visible = new Set((await local.catalog.list({ statuses: ["active"] })).map(entry => entry.conversationId));
    return (await local.productRuns.list()).filter(run => visible.has(run.conversationId) && run.maintenanceActivity && !run.maintenanceActivity.recordId && run.maintenanceActivity.progress.status !== "completed")
      .map(run => projectMaintenanceInitialActivity(run.maintenanceActivity!, run.conversationId, run.productRunId));
  }
  private initializeKnowledgeActivityStatusBar(): void {
    if (!Platform.isDesktopApp) return;
    const source = this.getKnowledgeActivitySource();
    if (!source) return;
    const item = this.addStatusBarItem();
    item.classList.add("mod-clickable"); item.setAttribute("role", "button"); item.tabIndex = 0;
    let current: import("./knowledge-base/maintenance-activity").KnowledgeActivity | null = null;
    const open = () => {
      if (current?.originConversationId) void this.openTaskDetail(current.originConversationId);
      else if (current?.kind === "linking") void this.openKnowledgeLinkingDetails(current.id);
    };
    this.registerDomEvent(item, "click", open);
    this.registerDomEvent(item, "keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    this.register(source.subscribe(snapshot => {
      current = snapshot.primary;
      item.hidden = !current;
      if (!current) { item.textContent = ""; return; }
      const english = this.settings.settingsLanguage === "en";
      item.textContent = current.kind === "maintenance" ? maintenanceStatusBarText(current, english)
        : `EchoInk ${english ? "Knowledge links" : "知识关联"}：${maintenanceTaskStateLabel(current, english)}${current.task.total === null ? "" : ` ${current.task.processed}/${current.task.total}${english ? " pages" : " 页"}`}`;
      const detail = current.kind === "maintenance" ? maintenanceActivityText(current, english) : knowledgeLinkingProgressText(current.task, english);
      item.setAttribute("aria-label", detail); item.title = detail;
    }));
  }
  getKnowledgeActivitySource(): import("./knowledge-base/maintenance-activity").KnowledgeActivitySource | undefined { return this.knowledgeBase?.activity; }
  async getKnowledgeLinkingIndex() { return (await this.ensurePiProductionRuntime()).knowledgeAgentIndex; }
  async queueKnowledgeLinking(targetPaths: readonly string[], sourcePaths: readonly string[] = [], taskId?: string, originConversationId?: string) { return await this.requireKnowledgeSurfaceService().linking.start("automatic", [...targetPaths], taskId, [...sourcePaths], originConversationId); }
  private pendingKnowledgeLinkingFocus = false;
  private pendingKnowledgeLinkingTaskId: string | null = null;
  async openKnowledgeLinkingDetails(taskId?: string): Promise<void> { this.pendingKnowledgeLinkingTaskId = taskId ?? null; this.pendingKnowledgeLinkingFocus = true; await this.openEchoInkKnowledgeSettings(); }
  consumeKnowledgeLinkingTaskId(): string | null { const id = this.pendingKnowledgeLinkingTaskId; this.pendingKnowledgeLinkingTaskId = null; return id; }
  consumeKnowledgeLinkingFocus(): boolean { const pending = this.pendingKnowledgeLinkingFocus; this.pendingKnowledgeLinkingFocus = false; return pending; }
  async getEchoInkKnowledgeInitializationState() {
    return await this.requireKnowledgeSurfaceService().getInitializationState();
  }
  async getEchoInkKnowledgeBaseStructure() {
    return await this.requireKnowledgeSurfaceService().getKnowledgeBaseStructure();
  }
  async restoreEchoInkKnowledgeBaseStructure(
    onProgress?: (progress: Readonly<KnowledgeBaseStructureRepairProgress>) => void
  ) {
    return await this.requireKnowledgeSurfaceService()
      .restoreKnowledgeBaseStructure(onProgress);
  }
  async startEchoInkKnowledgeInitialization(mode: KnowledgeInitializationMode) {
    return await this.requireKnowledgeSurfaceService().startInitialization(mode);
  }
  async assignEchoInkKnowledgeInitializationNote(
    sourcePath: string,
    role: KnowledgeInitializationRole
  ) {
    return await this.requireKnowledgeSurfaceService()
      .assignInitializationNote(sourcePath, role);
  }
  async assignManyEchoInkKnowledgeInitializationNotes(
    assignments: readonly KnowledgeInitializationAssignment[]
  ) {
    return await this.requireKnowledgeSurfaceService()
      .assignManyInitializationNotes(assignments);
  }
  async confirmEchoInkKnowledgeInitialization() {
    return await this.requireKnowledgeSurfaceService().confirmInitialization();
  }
  async continueEchoInkKnowledgeInitialization() {
    return await this.requireKnowledgeSurfaceService().continueInitialization();
  }
  async cancelEchoInkKnowledgeInitialization() {
    return await this.requireKnowledgeSurfaceService().cancelInitialization();
  }
  getReviewManager(): ReviewManager | null { return this.review; }
  private requireKnowledgeSurfaceService(): EchoInkKnowledgeSurfaceService {
    if (!this.knowledgeBase) throw new Error("知识库服务尚未就绪。");
    return this.knowledgeBase;
  }
  private getMcpBrokerService(): EchoInkMcpBrokerService {
    if (!this.mcpBrokerService) {
      this.mcpBrokerService = new EchoInkMcpBrokerService(this);
    }
    return this.mcpBrokerService;
  }
  private getMcpSettingsService(): EchoInkMcpSettingsService {
    if (!this.mcpSettingsService) {
      this.mcpSettingsService = new EchoInkMcpSettingsService(this);
    }
    return this.mcpSettingsService;
  }
  private getSettingsStore(): EchoInkSettingsStore {
    if (!this.settingsStore) this.settingsStore = new EchoInkSettingsStore(this);
    return this.settingsStore;
  }
  private getViewService(): EchoInkViewService {
    if (!this.viewService) this.viewService = new EchoInkViewService(this);
    return this.viewService;
  }
  private getResourceCatalogService(): EchoInkResourceCatalogService {
    if (!this.resourceCatalogService) {
      this.resourceCatalogService = new EchoInkResourceCatalogService(this);
    }
    return this.resourceCatalogService;
  }
  private getPiProviderConfigurationService():
  PiProviderConfigurationService {
    if (!this.piProviderConfigurationService) {
      this.piProviderConfigurationService =
        new PiProviderConfigurationService(this, {
          recordUsage: (event) => this.recordModelUsage(event),
          resolveOAuthAccessToken: async () =>
            await this.resolveOpenAICodexAccessToken()
        });
    }
    return this.piProviderConfigurationService;
  }
  async recordModelUsage(event: UsageRequestEvent): Promise<void> {
    await this.usageStore?.recordUsage(event);
  }
  async generateWikiFolderNames(systemPrompt: string, userPrompt: string): Promise<string> {
    return await this.getPiProviderConfigurationService().generateText({
      draft: this.activePiProviderConfigurationDraft(), systemPrompt, userPrompt,
      timeoutMs: 60_000, maxTokens: 4_096
    });
  }
  createPdfReadingGenerator(draft: PiProviderConfigurationDraft = this.activePiProviderConfigurationDraft()) {
    const budget = Math.min(7000, Math.floor(Math.min(draft.contextWindow - draft.maxOutputTokens - 2000, draft.maxOutputTokens / 3)));
    if (budget < 500) throw new Error("当前模型输出或上下文预算过小，请在 Provider 设置中调整。");
    return { maxSourceCharacters: budget, generate: async (systemPrompt: string, userPrompt: string, signal: AbortSignal) => {
      requireProPlugin(this.accountService ?? unavailableCapabilityAccess);
      // The current chat owns the activity; PdfReadingService serializes jobs.
      // Entering a second top-level activity here would reject our own Tool call.
      return this.getPiProviderConfigurationService().generateText({ draft, systemPrompt, userPrompt, signal, timeoutMs: 120_000, maxTokens: draft.maxOutputTokens });
    } };
  }
  englishDiaryProviderLabel(): string {
    try {
      const active = getEnglishDiaryApiProviderModel(this.settings);
      return `${active.provider.name} · ${active.model.id}`;
    } catch (error) {
      return error instanceof Error ? error.message : "请在英文日记设置中选择模型。";
    }
  }
  async setEnglishDiaryModel(providerSettingsId: string, modelId: string): Promise<void> {
    providerSettingsId = providerSettingsId.trim();
    modelId = modelId.trim();
    if (this.piRunConversations.size > 0 || this.piSubmittingConversations.size > 0) {
      throw new Error("EchoInk 正在回答，英文日记模型暂时不能切换。");
    }
    this.productActivity.beginSwitch();
    try {
      if (providerSettingsId || modelId) {
        getEnglishDiaryApiProviderModel({ ...this.settings, englishDiary: {
          ...this.settings.englishDiary, providerSettingsId, modelId
        } });
      }
      const current = this.settings.englishDiary;
      if (current.providerSettingsId === providerSettingsId && current.modelId === modelId) return;
      const previous = { providerSettingsId: current.providerSettingsId, modelId: current.modelId,
        approvedProvider: current.approvedProvider };
      Object.assign(current, { providerSettingsId, modelId, approvedProvider: "" });
      try {
        await this.saveSettings(true, { flushConversationStore: false });
      } catch (error) {
        Object.assign(this.settings.englishDiary, previous);
        throw new Error(error instanceof SettingsPersistenceError && error.persistenceStatus === "unknown"
          ? "保存状态未能确认，请重载 EchoInk 后检查英文日记模型设置。"
          : "英文日记模型设置未保存，已保留原选择，请稍后重试。", { cause: error });
      }
    } finally {
      this.productActivity.endSwitch();
    }
  }
  async generateEnglishDiaryText(input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }): Promise<string> {
    return this.withProductActivity(() => this.generateEnglishDiaryTextInRun(input));
  }
  private async generateEnglishDiaryTextInRun(input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }): Promise<string> {
      requireProPlugin(this.accountService ?? unavailableCapabilityAccess);
      (this.accountService ?? unavailableCapabilityAccess).requireCapability("diary.explanation.generate");
      if (!this.settings.englishDiary.enabled) throw new Error("英文日记已停用。");
      if (input.signal.aborted) throw new Error("已取消，未发送日记内容。");
      const active = getEnglishDiaryApiProviderModel(this.settings);
      if (!apiProviderHasUsableCredential(active.provider, this.settings.openAICodexCredential)) {
        throw new Error(active.provider.authMode === "oauth"
          ? "英文日记所选 Provider 需要登录，请在 API Provider 设置中完成登录。"
          : "英文日记所选 Provider 缺少 API Key，请在 API Provider 设置中补充。");
      }
      const draft = this.activePiProviderConfigurationDraft(active);
      const identity = JSON.stringify([draft.providerSettingsId, draft.providerId, draft.baseUrl, draft.modelId]);
      if (this.settings.englishDiary.approvedProvider !== identity) {
        let recipient: string = draft.providerId;
        try { if (draft.baseUrl) recipient = new URL(draft.baseUrl).origin; } catch { /* Provider validation reports invalid endpoints before sending. */ }
        const accepted = await confirmModal(this.app, "确认英文日记使用的模型", `本次使用 ${active.provider.name} · ${active.model.id}。\n接收方：${recipient}\n\n生成英文会发送你允许处理的日记段落；标记为“不发送”的段落始终留在本地。`, "确认并继续", "取消", { signal: input.signal });
        if (!accepted || input.signal.aborted) throw new Error("已取消，未发送日记内容。");
        requireProPlugin(this.accountService ?? unavailableCapabilityAccess);
        (this.accountService ?? unavailableCapabilityAccess).requireCapability("diary.explanation.generate");
        this.settings.englishDiary.approvedProvider = identity;
        await this.saveSettings(true);
      }
      if (input.signal.aborted || !this.settings.englishDiary.enabled) throw new Error("已取消，未发送日记内容。");
      requireProPlugin(this.accountService ?? unavailableCapabilityAccess);
      (this.accountService ?? unavailableCapabilityAccess).requireCapability("diary.explanation.generate");
      try {
        return await this.getPiProviderConfigurationService().generateText({
          draft, ...input, timeoutMs: 120_000, maxTokens: 12_000
        });
      } catch (error) {
        const failures: Record<string, string> = {
          provider_api_key_missing: "英文日记所选 Provider 缺少 API Key，请在 API Provider 设置中补充。",
          provider_oauth_missing: "英文日记所选 Provider 需要登录，请在 API Provider 设置中完成登录。",
          provider_model_invalid: "英文日记所选模型无效，请在 API Provider 设置中检查模型。",
          provider_model_metadata_invalid: "英文日记所选模型配置不完整，请在 API Provider 设置中检查模型。",
          provider_text_generation_aborted: "英文日记生成已取消。",
          provider_text_generation_timeout: "英文日记生成超时，请稍后重试。"
        };
        throw new Error(failures[error instanceof Error ? error.message : ""]
          ?? "英文日记生成失败，请检查所选 API Provider 的连接与模型设置后重试。", { cause: error });
      }
  }
  async prepareWikiFolderNamesForMaintenance(input: { initialization: boolean; assertActive(): void }): Promise<string> {
    if (this.settings.knowledgeBase.folderBindings) { input.assertActive(); return `当前目录用途：${JSON.stringify(projectedKnowledgeFolderRoles(this.settings.knowledgeBase.folderBindings, DESKTOP_KNOWLEDGE_ROOT_ROLES))}；维护只提炼本轮已选资料，不改名目录。${knowledgeFolderOrganizationPrompt(this.settings.knowledgeBase.folderBindings, DESKTOP_KNOWLEDGE_ROOT_ROLES)}`; }
    const result = await this.requireKnowledgeSurfaceService().optimizeFolderNames(undefined, input.initialization, { ...input, authorized: true });
    return `${result.message ?? `目录优化：改名 ${result.renamed.length}，跳过 ${result.skipped.length}。`}${JSON.stringify(result.skipped)}`;
  }
  private activePiProviderConfigurationDraft(
    active = getActiveApiProviderModel(this.settings)
  ): PiProviderConfigurationDraft {
    if (!active) throw new Error("请先在 API Provider 中选择可用模型。");
    const { provider, model } = active;
    return {
      providerSettingsId: provider.id,
      providerId: normalizeApiProviderId(
        provider.providerId,
        provider.baseUrl,
        provider.name
      ),
      runtimeProviderId: provider.runtimeProviderId,
      apiProtocol: provider.apiProtocol,
      authMode: provider.authMode,
      baseUrl: provider.baseUrl,
      modelId: model.id,
      apiKey: "",
      toolCalling: model.toolCalling,
      imageInput: apiProviderModelSupportsImage(model),
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      modelMaxTokens: model.modelMaxTokens,
      maxOutputTokens: model.maxOutputTokens
    };
  }
  private getOpenAICodexOAuthService(): OpenAICodexOAuthService {
    if (!this.openAICodexOAuthService) {
      this.openAICodexOAuthService = new OpenAICodexOAuthService(this);
    }
    return this.openAICodexOAuthService;
  }
  private getEditorTranslationService(): EditorTranslationService {
    if (!this.editorTranslation) {
      this.editorTranslation = new EditorTranslationService({
        generateEnglishTranslation: async (input) => {
          return await this.getPiProviderConfigurationService().generateText({
            draft: this.activePiProviderConfigurationDraft(),
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            timeoutMs: input.timeoutMs,
            maxTokens: 4_096
          });
        }
      });
    }
    return this.editorTranslation;
  }

  /**
   * Cognitive system facade: personality templates, dreaming scheduler and
   * secondary facts. Created once per Vault against the Personal Memory repo.
   */
  async getCognitiveSystem(): Promise<CognitiveSystem> {
    if (this.developerMemoryChanging) throw new Error("developer_memory_changing");
    if (this.cognitiveSystem) return this.cognitiveSystem;
    if (!this.cognitiveSystemFlight) {
      const flight = (async () => {
        const localData = await this.ensurePiLocalData();
        const system = await this.createCognitiveSystem(localData);
        this.cognitiveSystem = system;
        this.getCodexView()?.refreshPersonalizationUi();
        return system;
      })();
      let tracked: Promise<CognitiveSystem>;
      tracked = flight.catch((error) => {
        if (this.cognitiveSystemFlight === tracked) this.cognitiveSystemFlight = null;
        throw error;
      });
      this.cognitiveSystemFlight = tracked;
    }
    return await this.cognitiveSystemFlight;
  }

  private async createCognitiveSystem(localData: PiLocalDataService): Promise<CognitiveSystem> {
    localData.assertMemoryAvailable();
    const system = await CognitiveSystem.create({
      repository: localData.personalMemory,
      llm: () => this.createDreamLlmPort(),
      // The same Memory/Dream gates apply to scheduled and manual runs.
      getDreamConfig: () => ({
        enabled: this.settings.memory.dreamEnabled && this.settings.memory.useLongTermMemory,
        runsPerDay: this.settings.memory.dreamRunsPerDay
      }),
      isForegroundBusy: () => this.developerMemoryChanging
        || this.piRunConversations.size > 0 || this.productActivity.hasActivity,
      registerInterval: (handle) => this.registerInterval(handle)
    });
    system.startDreamScheduler();
    return system;
  }

  /** One-shot dream LLM port; null when no Provider is configured. */
  private createDreamLlmPort(): DreamLlmPort | null {
    if (!getActiveApiProviderModel(this.settings)) return null;
    return {
      call: async (input) => await this.getPiProviderConfigurationService().generateText({
        draft: this.activePiProviderConfigurationDraft(),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        timeoutMs: 120_000,
        maxTokens: input.maxTokens
      })
    };
  }

  /** Independent post-task Skill review; unavailable without a configured Provider. */
  createSkillReviewLlmPort(): DreamLlmPort | null {
    return this.createDreamLlmPort();
  }

  async generateLifestyleText(systemPrompt: string, userPrompt: string, maxTokens = 1400, signal?: AbortSignal): Promise<string> {
    if (!getActiveApiProviderModel(this.settings)) throw new Error("请先在 EchoInk 模型设置中配置当前 Provider。当前记录仍可手动使用。");
    return await this.withProductActivity(async () => await this.getPiProviderConfigurationService().generateText({
      draft: this.activePiProviderConfigurationDraft(),
      systemPrompt,
      userPrompt,
      timeoutMs: 120_000,
      maxTokens,
      signal
    }));
  }

  private getPersonalMemoryCorrectionService(): PersonalMemoryCorrectionService {
    if (!this.personalMemoryCorrection) {
      this.personalMemoryCorrection = new PersonalMemoryCorrectionService({
        generateCorrection: async (input) => {
          return await this.getPiProviderConfigurationService().generateText({
            draft: this.activePiProviderConfigurationDraft(),
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            timeoutMs: input.timeoutMs,
            maxTokens: 2_048,
            signal: input.signal
          });
        }
      });
    }
    return this.personalMemoryCorrection;
  }

  private async resolveKnowledgeMaintenancePreferenceStores() {
    const vaultRootPath = await fsp.realpath(this.getVaultPath());
    const rawPluginDataRootPath = pluginDataDir(
      vaultRootPath,
      this.getPluginDataDirName()
    );
    await fsp.mkdir(rawPluginDataRootPath, { recursive: true, mode: 0o700 });
    const pluginDataRootPath = await fsp.realpath(rawPluginDataRootPath);
    const privateKnowledgeRootPath = path.join(
      pluginDataRootPath,
      "pi-agent-product-v1",
      "knowledge"
    );
    return Object.freeze({
      preferences: new KnowledgeMaintenancePreferenceRepository(
        privateKnowledgeRootPath
      )
    });
  }

  private async initializePiLocalData(): Promise<void> {
    try {
      await this.ensurePiLocalData();
    } catch (error) {
      console.error("EchoInk 本地数据初始化失败", error);
    }
  }

  private queuePiConversationActivation(
    previousConversationId: string | null,
    conversationId: string,
    options: ActivatePiNativeConversationOptions = {},
    isStillCurrent?: () => boolean
  ): PiConversationActivationTask {
    const task: PiConversationActivationTask = {
      generation: ++this.piConversationActivationGeneration,
      ...(isStillCurrent ? { isStillCurrent } : {}),
      cancelled: false,
      promise: Promise.resolve()
    };
    const previousLane = this.piConversationActivationLane;
    task.promise = previousLane
      .then(async () => {
        if (!this.isCurrentPiConversationActivation(task)) return;
        const previousActiveConversationId =
          this.piActivatedConversationId
          ?? (
            previousConversationId
            && previousConversationId !== conversationId
              ? previousConversationId
              : null
          );
        if (!this.piProviderCanActivateAgentSession()) {
          const bundle = this.piRuntimeBundle;
          if (previousActiveConversationId && bundle) {
            try {
              await bundle.runtime.releaseConversationIfIdle(
                previousActiveConversationId
              );
            } finally {
              if (
                this.piActivatedConversationId
                === previousActiveConversationId
              ) {
                this.piActivatedConversationId = null;
              }
            }
          } else if (
            this.piActivatedConversationId === previousActiveConversationId
          ) {
            this.piActivatedConversationId = null;
          }
          return;
        }

        const bundle = await this.ensurePiProductionRuntime();
        if (!this.isCurrentPiConversationActivation(task)) return;

        if (
          previousActiveConversationId
          && previousActiveConversationId !== conversationId
        ) {
          this.piActivatedConversationId = null;
          await bundle.runtime.switchConversation(
            previousActiveConversationId,
            conversationId,
            options
          );
        } else {
          await bundle.runtime.activateConversation(conversationId, options);
        }
        this.piActivatedConversationId = conversationId;

        if (!this.isCurrentPiConversationActivation(task)) {
          try {
            await bundle.runtime.releaseConversationIfIdle(conversationId);
          } finally {
            if (this.piActivatedConversationId === conversationId) {
              this.piActivatedConversationId = null;
            }
          }
        }
      })
      .finally(() => {
        if (this.piConversationActivationTasks.get(conversationId) === task) {
          this.piConversationActivationTasks.delete(conversationId);
        }
      });
    this.piConversationActivationTasks.set(conversationId, task);
    this.piConversationActivationLane = task.promise.then(
      () => undefined,
      () => undefined
    );
    void task.promise.catch(() => undefined);
    return task;
  }

  private isCurrentPiConversationActivation(
    task: Readonly<PiConversationActivationTask>
  ): boolean {
    return !task.cancelled
      && task.generation === this.piConversationActivationGeneration
      && task.isStillCurrent?.() !== false;
  }

  private async waitForPiConversationActivation(
    conversationId: string
  ): Promise<void> {
    // Selection activation is an optimization, not permission to send. A
    // background queue may submit after the user has opened another conversation.
    const pending = this.piConversationActivationTasks.get(conversationId);
    if (pending) await pending.promise.catch(() => undefined);
  }

  private async cancelPiConversationActivation(
    conversationId: string,
    waitForSettlement = true
  ): Promise<void> {
    const task = this.piConversationActivationTasks.get(conversationId);
    if (!task) return;
    task.cancelled = true;
    if (waitForSettlement) {
      await task.promise.catch(() => undefined);
    }
  }

  private async cancelAllPiConversationActivations(): Promise<void> {
    for (const task of this.piConversationActivationTasks.values()) {
      task.cancelled = true;
    }
    await this.piConversationActivationLane;
  }

  private async ensurePiLocalData(): Promise<PiLocalDataService> {
    if (this.developerMemoryChanging) throw new Error("developer_memory_changing");
    if (this.piLocalData) return this.piLocalData;
    if (this.piLocalDataFlight) return await this.piLocalDataFlight;
    const flight = PiLocalDataService.create(this)
      .then(async (localData) => {
        this.piLocalData = localData;
        for (const entry of await localData.catalog.list()) {
          if (!["running", "waiting"].includes(entry.taskStatus ?? "") || entry.status === "deleted") continue;
          await this.setPiConversationTaskMetadata(entry.conversationId, { taskStatus: "interrupted", taskInterruptedAt: entry.taskInterruptedAt ?? entry.taskMetadataUpdatedAt ?? entry.updatedAt, taskCompletedAt: undefined, pendingResponse: undefined })
            .catch(error => console.warn("Interrupted conversation state could not be saved", error));
        }
        return localData;
      })
      .finally(() => {
        if (this.piLocalDataFlight === flight) {
          this.piLocalDataFlight = null;
        }
      });
    this.piLocalDataFlight = flight;
    return await flight;
  }

  async getVaultMemoryNotice() { return (await this.ensurePiLocalData()).memoryNotice; }

  async dismissVaultMemoryNotice(): Promise<void> {
    await (await this.ensurePiLocalData()).dismissMemoryNotice();
    this.notifyHomeSurfacesChanged();
  }

  async resolveVaultMemory(action: "adopt" | "reset"): Promise<void> {
    const local = await this.ensurePiLocalData();
    const cognitive = this.cognitiveSystem ?? await this.cognitiveSystemFlight?.catch(() => null);
    if (this.developerMemoryChanging || this.piRunConversations.size || this.piSubmittingConversations.size
      || this.productActivity.hasActivity || cognitive?.engine.isRunning) {
      throw new Error(this.settings.settingsLanguage === "en" ? "Wait for the current task to finish, then try again." : "请等当前任务结束后再试。");
    }
    this.productActivity.beginSwitch();
    this.developerMemoryChanging = true;
    try {
      await this.suspendPiProductionRuntime();
      await cognitive?.dispose();
      this.cognitiveSystem = null;
      this.cognitiveSystemFlight = null;
      this.personalMemoryCorrection = null;
      await local.resolveMemory(action);
      this.cognitiveSystem = await this.createCognitiveSystem(local);
    } finally {
      this.developerMemoryChanging = false;
      this.productActivity.endSwitch();
      this.getCodexView()?.refreshPersonalizationUi();
      this.notifyHomeSurfacesChanged();
    }
  }

  private async settlePiRuntimeFlight(): Promise<void> {
    await this.piRuntimeFlight?.catch(() => undefined);
  }

  private piProviderCanActivateAgentSession(): boolean {
    const provider = getActiveApiProvider(this.settings);
    return Boolean(provider && apiProviderHasUsableCredential(
      provider,
      this.settings.openAICodexCredential
    ));
  }

  private async ensurePiProductionRuntime(): Promise<PiProductionRuntimeBundle> {
    if (this.developerMemoryChanging) throw new Error("developer_memory_changing");
    if (this.piRuntimeBundle) return this.piRuntimeBundle;
    if (this.piRuntimeFlight) return await this.piRuntimeFlight;
    const flight = this.ensurePiLocalData()
      .then(async (localData) => {
        localData.assertMemoryAvailable();
        return await createPiProductionRuntimeBundle(this, localData);
      })
      .then((bundle) => {
        this.piRuntimeBundle = bundle;
        return bundle;
      })
      .finally(() => {
        if (this.piRuntimeFlight === flight) {
          this.piRuntimeFlight = null;
        }
      });
    this.piRuntimeFlight = flight;
    return await flight;
  }
}
