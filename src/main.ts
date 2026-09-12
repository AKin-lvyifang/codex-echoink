import { HomeActivityService } from "./home/home-activity-service";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Notice, Plugin } from "obsidian";
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
import {
  apiProviderModelSupportsImage,
  apiProviderHasUsableCredential,
  getActiveApiProvider,
  getActiveApiProviderModel,
  type ChatMessage,
  type CodexForObsidianSettings,
  type KnowledgeBaseSettings,
  type ResourceManagementTab,
  type StoredSession
} from "./settings/settings";
import { CodexView, VIEW_TYPE_CODEX } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "./home/home-view";
import {
  EchoInkSettingsStore,
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
import { pluginDataDir } from "./plugin/plugin-data-paths";
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
import { CognitiveSystem, type AgentProfileView } from "./harness/memory/cognitive-system";
import {
  DEFAULT_AGENT_DISPLAY_NAME,
  defaultAgentIdentityState
} from "./harness/memory/agent-identity-state";
import { resolveAgentAvatarUrl } from "./ui/agent-avatar-presets";
import type { AgentIdentityView } from "./ui/codex-view/message-list";
import type { DreamLlmPort } from "./harness/memory/dream-engine";
import {
  SkillRuntimeCoordinator,
  type BuiltinSkillRuntimeSnapshot
} from "./harness/resources/skill-runtime";
import type { BuiltinSkillId } from "./harness/resources/builtin-skills";
import {
  advanceEchoInkOnboardingTutorial,
  dismissEchoInkOnboardingTutorial,
  echoInkOnboardingTab,
  onboardingCoachmarkCopy,
  prepareEchoInkOnboardingTutorial,
  shouldAutoStartEchoInkOnboarding,
  selectEchoInkOnboardingStep,
  ECHOINK_ONBOARDING_STEPS,
  type EchoInkOnboardingStep
} from "./settings/onboarding";
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
  private knowledgeBase: EchoInkKnowledgeSurfaceService | null = null;
  private review: ReviewManager | null = null;
  private settingsStore: EchoInkSettingsStore | null = null;
  private viewService: EchoInkViewService | null = null;
  private quickChatWindow: QuickChatWindowController | null = null;
  private resourceCatalogService: EchoInkResourceCatalogService | null = null;
  private skillRuntimeCoordinator: SkillRuntimeCoordinator | null = null;
  private pendingSettingsResourceDetailId = "";
  private pendingKnowledgeDashboardFocus = false;
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
  private piLocalDataFlight: Promise<PiLocalDataService> | null = null;
  private cognitiveSystem: CognitiveSystem | null = null;
  private cognitiveSystemFlight: Promise<CognitiveSystem> | null = null;
  private readonly piRunConversations = new Map<string, string>();
  private readonly piSubmittingConversations = new Set<string>();
  private readonly apiProviderActivation = new ApiProviderActivationService();
  private editorTranslation: EditorTranslationService | null = null;
  private personalMemoryCorrection: PersonalMemoryCorrectionService | null = null;
  private readonly productActivity = new ProductActivityGate();
  private developerMemoryChanging = false;
  readonly developerMode = new DeveloperModeAccess();
  private developerService: DeveloperModeService | null = null;
  private onboardingRequested = false;
  private onboardingRibbonAnchor: HTMLElement | null = null;
  private onboardingWorkspaceCoachmark: EchoInkOnboardingCoachmarkHandle | null = null;
  private onboardingDesktopWaitCleanup: (() => void) | null = null;
  async onload(): Promise<void> {
    const enabledAfterLayoutReady = this.app.workspace.layoutReady;
    const settingsLoad = await this.loadSettings();
    this.onboardingRequested = shouldAutoStartEchoInkOnboarding(
      settingsLoad.emptyData,
      this.settings.setup,
      enabledAfterLayoutReady
    );
    if (this.onboardingRequested && prepareEchoInkOnboardingTutorial(
      this.settings.setup,
      { forceRestart: enabledAfterLayoutReady }
    )) {
      await this.saveSettings(true);
    }
    this.homeActivity = new HomeActivityService(path.join(pluginDataDir(this.getVaultPath(), this.manifest.dir ?? this.manifest.id), "home-activity.json"));
    await this.homeActivity.initialize();
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
    // Cognitive main-chain (personality / dreaming / secondary facts): start the
    // scheduler as soon as local data is ready; failures never block the plugin.
    void this.getCognitiveSystem().catch((error) => {
      console.error("EchoInk cognitive system init failed", error);
    });
    const controllers = registerEchoInkPluginFeatures(this);
    this.knowledgeBase = controllers.knowledgeBase;
    this.review = controllers.review;
    registerEchoInkStartupTasks(this);
    // Global quick-chat window: registration is fail-safe by design; when the
    // desktop bridge is missing the sidebar experience stays untouched.
    this.quickChatWindow = new QuickChatWindowController(this);
    const quickChatRegistration = this.quickChatWindow.applySettings();
    if (this.settings.quickChat.enabled && !quickChatRegistration.ok) {
      console.warn("EchoInk quick chat hotkey not registered", quickChatRegistration.reason);
    }
  }

  onunload(): void {
    void this.performUnload();
  }

  private async performUnload(): Promise<void> {
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
  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> { return this.getViewService().activateHomeView(options); }
  /** Push settings-driven home changes (module visibility, todos) to open home views. */
  notifyHomeSurfacesChanged(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME)) {
      if (leaf.view instanceof EchoInkHomeView) leaf.view.refreshHomeSurfaces();
    }
  }
  async activateView(): Promise<void> { return this.getViewService().activateView(); }
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
    if (step === "sidebar" || step === "settings") {
      await this.showEchoInkOnboardingWorkspaceCoachmark(step);
      return;
    }
    await this.getViewService().openEchoInkSettings(
      echoInkOnboardingTab(step)
    );
  }
  setEchoInkOnboardingRibbonAnchor(anchor: HTMLElement): void {
    this.onboardingRibbonAnchor = anchor;
  }
  async handleEchoInkOnboardingTargetActivated(
    expectedStep: "sidebar" | "settings"
  ): Promise<boolean> {
    if (
      !this.onboardingRequested
      || this.settings.setup.tutorialStep !== expectedStep
    ) return false;
    let nextStep: EchoInkOnboardingStep | null;
    try {
      nextStep = await this.advanceEchoInkOnboarding(expectedStep);
    } catch (error) {
      console.error("EchoInk onboarding advance failed", error);
      new Notice(this.settings.settingsLanguage === "en"
        ? "Tutorial progress could not be saved. Try again."
        : "引导进度保存失败，请重试。");
      return true;
    }
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
    if (nextStep === "settings") {
      await this.showEchoInkOnboardingWorkspaceCoachmark("settings");
    } else if (nextStep === "provider") {
      await this.getViewService().openEchoInkSettings("providers");
    }
    return true;
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
  }
  getEchoInkOnboardingStep(): EchoInkOnboardingStep {
    return this.settings.setup.tutorialStep;
  }
  async advanceEchoInkOnboarding(
    expectedStep: EchoInkOnboardingStep
  ): Promise<EchoInkOnboardingStep | null> {
    if (!this.onboardingRequested) return null;
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
  private async showEchoInkOnboardingWorkspaceCoachmark(
    step: "sidebar" | "settings"
  ): Promise<void> {
    this.clearEchoInkOnboardingWorkspaceCoachmark(false);
    if (step === "sidebar" && !this.isEchoInkOnboardingDesktopReady()) {
      this.waitForEchoInkOnboardingDesktop();
      return;
    }
    if (step === "settings" && !this.findEchoInkOnboardingSettingsAnchor()) {
      await this.activateView();
    }
    const anchor = step === "sidebar"
      ? this.onboardingRibbonAnchor
      : this.findEchoInkOnboardingSettingsAnchor();
    if (!anchor?.isConnected) return;
    const zh = this.settings.settingsLanguage !== "en";
    const copy = onboardingCoachmarkCopy(step, zh);
    this.onboardingWorkspaceCoachmark = mountEchoInkOnboardingCoachmark({
      app: this.app,
      anchor,
      stepClass: step,
      stepLabel: copy.step,
      title: copy.title,
      description: copy.description,
      actionLabel: copy.action,
      tip: copy.tip,
      icon: copy.icon,
      tone: copy.tone,
      steps: copy.steps,
      progressLabel: copy.progressLabel,
      previousLabel: copy.previousLabel,
      dismissLabel: copy.dismissLabel,
      restoreFocusEl: anchor,
      onDismiss: async () => {
        await this.dismissEchoInkOnboarding();
        this.clearEchoInkOnboardingWorkspaceCoachmark(true);
      },
      onPrevious: step === "sidebar" ? undefined : async () => {
        const previous = ECHOINK_ONBOARDING_STEPS[ECHOINK_ONBOARDING_STEPS.indexOf(step) - 1];
        if (await this.selectEchoInkOnboardingStep(step, previous)) await this.openPendingEchoInkOnboarding();
      },
      onStep: async (nextStep) => {
        if (!await this.selectEchoInkOnboardingStep(step, nextStep)) return;
        this.clearEchoInkOnboardingWorkspaceCoachmark(false);
        await this.openPendingEchoInkOnboarding();
      },
      onAction: async () => {
        if (step === "sidebar") {
          await this.activateHomeAndSidebar();
          await this.handleEchoInkOnboardingTargetActivated("sidebar");
          return;
        }
        await this.handleEchoInkOnboardingTargetActivated("settings");
      },
      onActionError: (error) => {
        console.error("EchoInk onboarding action failed", error);
        new Notice(zh ? "页面没有打开，请再试一次。" : "The page did not open. Try again.");
      }
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
    this.pendingKnowledgeDashboardFocus = true;
    await this.getViewService().openEchoInkSettings("knowledgeBase");
  }
  consumeKnowledgeDashboardFocus(): boolean {
    const focus = this.pendingKnowledgeDashboardFocus;
    this.pendingKnowledgeDashboardFocus = false;
    return focus;
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
        || !relative.toLocaleLowerCase().startsWith("raw/")
        || !isRawMarkdownPath(relative)
      ) {
        throw new Error("/maintain 附件必须是当前 Vault 的 raw/** Markdown 笔记。");
      }
      await bundle.knowledgeAgentIndex.read({ vaultRelativePath: relative });
      return Object.freeze({
        mode: "exact" as const,
        sourcePaths: Object.freeze<[string]>([relative])
      });
    }
    if (!request) return Object.freeze({ mode: "global" as const });
    const result = await bundle.knowledgeAgentIndex.search({
      query: request,
      kinds: ["raw"],
      limit: 50
    });
    const candidatePaths = result.hits
      .map((hit) => hit.vaultRelativePath)
      .filter(isRawMarkdownPath)
      .slice(0, 12);
    if (!candidatePaths.length) {
      throw new Error("没有找到可可靠匹配的 Raw 笔记；本轮不会回退到全局维护。");
    }
    return Object.freeze({
      mode: "query" as const,
      candidatePaths: Object.freeze(candidatePaths)
    });
  }
  async submitPiChat(
    request: PiChatSubmitRequest
  ): Promise<PiChatRunHandle> {
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
        await this.waitForPiConversationActivation(conversationId);
        const bundle = await this.ensurePiProductionRuntime();
        const handle = await bundle.runtime.submit(request);
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
    return await (await this.ensurePiLocalData()).listConversations(statuses);
  }
  async createPiConversation(
    input: CreatePiNativeConversationInput
  ): Promise<Readonly<PiConversationCatalogEntry>> {
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
  async setPiConversationStatus(
    conversationId: string,
    status: PiConversationCatalogStatus
  ): Promise<Readonly<PiConversationCatalogEntry>> {
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
      return runtime
        ? await runtime.runtime.setConversationStatus(
            conversationId,
            status
          )
        : await (await this.ensurePiLocalData()).setConversationStatus(
            conversationId,
            status
          );
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
    const bundle = await this.ensurePiProductionRuntime();
    await bundle.runtime.abort(conversationId);
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
  async getEchoInkPersonalMemoryState() {
    const localData = await this.ensurePiLocalData();
    let control = await localData.personalMemory.readUserControlState();
    let agentProfile:
      | Readonly<{ kind: "ready" } & AgentProfileView>
      | Readonly<{ kind: "error" }>;
    let system: CognitiveSystem | null = null;
    let agentIdentity = defaultAgentIdentityState();
    try {
      system = this.cognitiveSystem
        ?? (typeof this.getCognitiveSystem === "function"
          ? await this.getCognitiveSystem()
          : null);
      agentProfile = Object.freeze({ kind: "error" as const });
      if (system) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const profile = await system.readAgentProfile();
          const identity = await system.readAgentIdentity();
          const nextControl = await localData.personalMemory.readUserControlState();
          control = nextControl;
          agentIdentity = identity;
          if (profile.revision !== nextControl.revision) continue;
          agentProfile = Object.freeze({ kind: "ready" as const, ...profile });
          break;
        }
      }
    } catch {
      agentProfile = Object.freeze({ kind: "error" as const });
    }
    return Object.freeze({
      revision: control.revision,
      user: control.user,
      memory: control.memory,
      records: control.records,
      forgottenIds: control.forgottenIds,
      agentIdentity,
      agentProfile
    });
  }

  /**
   * 同步读取当前 Agent 展示快照（消息头名称、头像与等待态人格）。数据
   * 来自 CognitiveSystem 已预热的缓存；系统未初始化完成时返回默认
   * EchoInk / bot 图标与无模板状态，绝不在消息渲染时读磁盘。
   */
  getEchoInkAgentIdentityView(): AgentIdentityView {
    const system = this.cognitiveSystem;
    if (!system) {
      return Object.freeze({
        displayName: DEFAULT_AGENT_DISPLAY_NAME,
        avatarUrl: null,
        personalityTemplateId: null
      });
    }
    const identity = system.currentAgentIdentity();
    return Object.freeze({
      displayName: identity.displayName,
      avatarUrl: resolveAgentAvatarUrl(identity.avatar),
      personalityTemplateId: system.currentPersonalityTemplateId()
    });
  }
  async updateEchoInkPersonalMemoryProfile(
    profile: "agent" | "user",
    content: string,
    expectedRevision: number
  ) {
    return await (await this.ensurePiLocalData()).personalMemory.updateIdentityFile(
      profile,
      content,
      expectedRevision
    );
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
  getPluginDataDirName(): string { const dir = (this.manifest as { dir?: unknown }).dir; return typeof dir === "string" && dir.trim() ? dir : this.manifest.id; }
  async loadSettings(): Promise<Readonly<SettingsLoadResult>> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> { return this.getSettingsStore().saveSettings(force, options); }
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
          resolveOAuthAccessToken: async () =>
            await this.resolveOpenAICodexAccessToken()
        });
    }
    return this.piProviderConfigurationService;
  }
  private activePiProviderConfigurationDraft(): PiProviderConfigurationDraft {
    const active = getActiveApiProviderModel(this.settings);
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
      .then((localData) => {
        this.piLocalData = localData;
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
      .then(async (localData) =>
        await createPiProductionRuntimeBundle(this, localData)
      )
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
