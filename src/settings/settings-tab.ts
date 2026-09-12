import { OriginSetting } from "./origin-setting";
import { createOriginInput, createOriginButton, createOriginSwitch, createOriginSlider, disposeOriginControls, type OriginCheckElement } from "./origin-controls";
import { renderSettingsKnowledgeDashboard } from "./knowledge-dashboard";
import { BUILTIN_SKILLS } from "../harness/resources/builtin-skills";
import { mountSettingsEditor } from "./inline-editor";
import { Modal, Notice, Platform, PluginSettingTab, Setting, TFile, type TFolder, normalizePath, setIcon, setTooltip } from "obsidian";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { settingsCategoryDefinitions } from "./settings-search";
import type CodexForObsidianPlugin from "../main";
import { DeveloperModePanel } from "./developer-mode-panel";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import {
  type PersonalMemoryKind,
  type PersonalMemoryRecord
} from "../harness/memory/personal-memory-contracts";
import { initialTemplateSelectionStatus } from "../harness/memory/cognitive-system";
import {
  AGENT_TEMPLATES
} from "../harness/memory/agent-templates";
import {
  isBuiltinSkillId,
  type BuiltinSkillId
} from "../harness/resources/builtin-skills";
import type {
  BuiltinSkillRuntimeSnapshot
} from "../harness/resources/skill-runtime";
import { AGENT_AVATAR_PRESETS, resolveAgentAvatarUrl } from "../ui/agent-avatar-presets";
import { normalizeJournalDirectory } from "../home/journal-directory";
import { ECHOINK_HOME_MODULES } from "../home/home-modules";
import { TODO_SOURCE_PATH } from "../home/todo-store";
import { formatAcceleratorForDisplay, normalizeAccelerator, recordAcceleratorFromEvent } from "../core/quick-hotkey";
import type { QuickChatRegistrationResult } from "../plugin/quick-chat-window";
import { readNativeJournalSettings, saveNativeJournalFolder } from "../home/native-journal";
import { AgentIdentityModal } from "../ui/agent-identity-modal";
import { renderAnimateIcon } from "../ui/animate-icon";
import {
  mountEchoInkOnboardingCoachmark,
  type EchoInkOnboardingCoachmarkHandle
} from "../ui/onboarding-coachmark";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import {
  mcpConnectionStatus,
  mcpConnectionStatusLabel,
  mcpCredentialConfigured,
  mcpToolPolicy,
  resolveMcpConnectionRecord
} from "../resources/mcp-connections";
import type {
  EchoInkMcpConnectionRecord,
  EchoInkMcpDiagnosticCode,
  EchoInkResource
} from "../resources/types";
import {
  emptyWorkspaceResourceSnapshot,
  errorsFromWorkspaceResourceCache,
  loadedTabsFromWorkspaceResourceCache,
  snapshotFromWorkspaceResourceCache
} from "../core/workspace-resources";
import { filterWorkspaceResourceRows } from "../core/workspace-resource-filter";
import {
  DEFAULT_SETTINGS,
  activateApiProvider,
  activateApiProviderModel,
  apiProviderHasUsableCredential,
  createApiProviderConfig,
  getActiveApiProvider,
  getApiProviderModel,
  getDefaultApiProviderModel,
  newId,
  normalizeReviewOutputDir,
  normalizeSettingsLanguage,
  validateApiProvider,
  type ApiProviderConfig,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type ReviewReportKind,
  type ResourceManagementTab,
  type SettingsTab,
  type WorkspaceResourceToggles
} from "./settings";
import {
  apiProviderApiKeyRequired,
  apiProviderConfiguredDisplayName,
  getApiProviderPreset,
  normalizeApiProviderBaseUrl,
  normalizeApiProviderId
} from "./provider-presets";
import type { WorkspaceResourceSnapshot } from "../types/app-server";
import { CODEX_MEMORY_LITE_URL } from "../knowledge-base/constants";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_STEPS
} from "../knowledge-base/knowledge-maintenance-protocol";
import { KnowledgeInitializationSection } from "./knowledge-initialization-section";
import {
  applyAmicroButton,
  confirmAmicroButton,
  setAmicroButtonPending
} from "./amicro-buttons";
import {
  confirmModal,
  memoryCorrectionModal,
  textInputModal
} from "../ui/modals";
import { SETTINGS_LANGUAGE_OPTIONS, settingsCopy, type SettingsCopy } from "./i18n";
import { captureSettingsScrollSnapshot, restoreSettingsScrollSnapshot } from "./settings-scroll";
import {
  ProviderModelModal,
  type ProviderModelSaveResult
} from "./provider-model-modal";
import { renderProviderBrandIcon } from "./provider-brand-icons";
import {
  renderAnimatedSettingsTabIcon,
  type AnimatedSettingsTabIconName
} from "./animated-settings-tab-icon";
import { McpServerModal } from "./mcp-server-modal";
import {
  applySettingsRow,
  addSettingsHelp,
  showSettingsInlineConfirmation,
  createSettingsCompactList,
  createSettingsFeatureCard,
  createSettingsGroup,
  createSettingsNavigationRow,
  createSettingsPage,
  createSettingsSection,
  createSettingsState
} from "./settings-v2";
import {
  beginSavingKnowledgeMaintenancePreference,
  createKnowledgeMaintenancePreferenceEditor,
  editKnowledgeMaintenancePreference,
  failSavingKnowledgeMaintenancePreference,
  knowledgeMaintenancePreferenceDraftState,
  knowledgeMaintenancePreferenceIsDirty,
  restoreDefaultKnowledgeMaintenancePreference,
  type KnowledgeMaintenancePreferenceEditorState
} from "./knowledge-maintenance-preference-editor";
import {
  echoInkOnboardingTab,
  onboardingCoachmarkCopy,
  onboardingCompletionCopy,
  ECHOINK_ONBOARDING_STEPS,
  type EchoInkOnboardingStep
} from "./onboarding";
import { openExternalInElectron } from "../core/electron";
import type { KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import {
  clearKnowledgeDashboardHealthTooltips,
  createKnowledgeDashboardTooltipState,
  disposeKnowledgeDashboardTooltipState,
  type KnowledgeDashboardTooltipState
} from "../ui/codex-view/knowledge-dashboard";

type PersonalMemoryControlState = Awaited<
  ReturnType<CodexForObsidianPlugin["getEchoInkPersonalMemoryState"]>
>;

type KnowledgeMaintenancePreferenceControlState = Awaited<
  ReturnType<CodexForObsidianPlugin[
    "getEchoInkKnowledgeMaintenancePreferenceState"
  ]>
>;

interface AgentProfileCardRefs {
  readonly templateBtn: HTMLElement;
  readonly templateLabel: HTMLElement;
  readonly pickerPanel: HTMLElement;
  readonly collapsedTemplateLabel: string;
  readonly expandedTemplateLabel: string;
}

interface BuiltinSkillEditorState {
  resourceId: string;
  skillId: BuiltinSkillId;
  snapshot: BuiltinSkillRuntimeSnapshot | null;
  draftContent: string;
  loading: boolean;
  saving: boolean;
  error: string;
}

interface NativeSettingsNavigation {
  listEl: HTMLElement;
  workspaceEl: HTMLElement;
  rows: Map<VisibleSettingsTab, { setting: Setting; button: HTMLButtonElement | null }>;
}

const settingsContainerFocusIntents = new WeakMap<HTMLElement, string>();
const PERSONALITY_TEMPLATE_FOCUS_INTENT = "explicit:general:personality-template";

export class CodexSettingTab extends PluginSettingTab {
  private resourceSnapshot: WorkspaceResourceSnapshot | null = null;
  private runtimeEchoInkResources: EchoInkResource[] = [];
  private resourceLoadingTab: ResourceManagementTab | null = null;
  private resourceLoaded: Record<ResourceManagementTab, boolean> = { plugins: false, mcp: false, skills: false };
  private resourceLoadErrors: Partial<Record<ResourceManagementTab, string>> = {};
  private resourceSearchQuery: Record<ResourceManagementTab, string> = { plugins: "", mcp: "", skills: "" };
  private resourceSearchDebounceTimer: number | null = null;
  private builtinSkillEditor: BuiltinSkillEditorState | null = null;
  private builtinSkillEditorRequestId = 0;
  private settingsVisible = false;
  private memoryActionRunning = false;
  private personalMemoryState: PersonalMemoryControlState | null = null;
  private personalMemoryLoading = false;
  private personalMemoryError: string | null = null;
  private knowledgePreferenceState:
    KnowledgeMaintenancePreferenceControlState | null = null;
  private knowledgePreferenceEditor:
    Readonly<KnowledgeMaintenancePreferenceEditorState> | null = null;
  private knowledgePreferenceLoading = false;
  private knowledgePreferenceLoadError: string | null = null;
  private knowledgeInitSection: KnowledgeInitializationSection | null = null;
  private knowledgePreferenceClosePromptRunning = false;
  private knowledgeDashboardEl: HTMLElement | null = null;
  private knowledgeDashboardSnapshot: KnowledgeBaseDashboardSnapshot | null = null;
  private knowledgeDashboardExpanded = true;
  private knowledgeDashboardLoading = false;
  private knowledgeDashboardError = "";
  private knowledgeDashboardRequestId = 0;
  private readonly knowledgeDashboardTooltipState: KnowledgeDashboardTooltipState =
    createKnowledgeDashboardTooltipState();
  private displayFrame: number | null = null;
  private displayFrameWindow: Window | null = null;
  private settingsTitleEl: HTMLElement | null = null;
  private settingsTabsEl: HTMLElement | null = null;
  private settingsBodyEl: HTMLElement | null = null;
  private settingsStatusEl: HTMLElement | null = null;
  private settingsTabFocusId: VisibleSettingsTab | null = null;
  private resourceTabFocusId: ResourceManagementTab | null = null;
  private settingsTabPointerActivated = false;
  private resourceTabPointerActivated = false;
  private suppressSettingsTabFocusRestore = false;
  private suppressResourceTabFocusRestore = false;
  private settingsFocusIntent: string | null = null;
  private settingsActionErrors: Partial<Record<SettingsActionContext, string>> = {};
  private settingsDetail: SettingsDetail = null;
  private knowledgeMaintenanceHistoryDate = "";
  private archivedConversations: readonly Readonly<PiConversationCatalogEntry>[] | null = null;
  private archivedConversationsLoading = false;
  private archivedConversationsError = "";
  private archivedConversationQuery = "";
  private archivedConversationBusyId = "";
  private settingsTabsResizeObserver: ResizeObserver | null = null;
  private lastRenderedSettingsTab: VisibleSettingsTab | null = null;
  private renderedSettingsLocation = "";
  private renderedInlineHost: HTMLElement | null = null;
  private settingsTabIconAnimation: Readonly<{
    tabId: VisibleSettingsTab;
    startedAtMs: number;
  }> | null = null;
  private readonly verifiedProviderConnections = new Map<string, string>();
  private onboardingCoachmarkHandle: EchoInkOnboardingCoachmarkHandle | null = null;
  private onboardingRestoreFocusEl: HTMLElement | null = null;
  private onboardingRefreshGeneration = 0;
  private developerPanel: DeveloperModePanel | null = null;
  private inlineEditor: { tab: VisibleSettingsTab; host: HTMLElement; dispose: () => void } | null = null;
  private nativeSettingsNavigation: NativeSettingsNavigation | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    this.plugin.register(() => this.disposeSettingsView());
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  private get copy(): SettingsCopy {
    return settingsCopy(this.plugin.settings.settingsLanguage);
  }

  getSettingDefinitions(): SettingsCategoryGroupDefinition[] {
    return settingsCategoryDefinitions(this.plugin.settings.settingsLanguage,
      (tab, setting, group) => this.renderNativeSettingsCategory(tab, setting, group));
  }

  private renderNativeSettingsCategory(
    tab: VisibleSettingsTab,
    setting: Setting,
    group: SettingGroup
  ): () => void {
    if (this.nativeSettingsNavigation?.listEl !== group.listEl) {
      this.disposeSettingsView();
      const workspaceEl = group.listEl.parentElement;
      if (!workspaceEl) return () => undefined;
      this.containerEl.addClass("echoink-settings-host");
      workspaceEl.addClass("echoink-settings-demo", "echoink-native-settings-workspace");
      this.nativeSettingsNavigation = { listEl: group.listEl, workspaceEl, rows: new Map() };
      this.settingsTitleEl = workspaceEl.createDiv({ cls: "codex-settings-title" });
      workspaceEl.insertBefore(this.settingsTitleEl, group.listEl);
      const tabsEl = workspaceEl.createDiv({ cls: "codex-settings-tabs-slot" });
      this.settingsTabsEl = tabsEl;
      workspaceEl.insertBefore(tabsEl, group.listEl);
      tabsEl.appendChild(group.listEl);
      this.createSettingsBody(workspaceEl);
      this.beginSettingsDisplay();
    }
    const navigation = this.nativeSettingsNavigation;
    if (!navigation) return () => undefined;
    const row = { setting, button: null as HTMLButtonElement | null };
    navigation.rows.set(tab, row);
    setting.settingEl.addClass("echoink-native-settings-row");
    // Keep the host's row and name elements: search can still focus/highlight
    // this real visible boundary. Only the original button lives inside it.
    this.renderTopTabs(this.settingsTabsEl!, visibleSettingsTab(this.plugin.settings.settingsTab));
    this.scheduleDisplay();
    return () => {
      if (setting.nameEl.parentElement === row.button) setting.infoEl.appendChild(setting.nameEl);
      disposeOriginControls(setting.settingEl);
      if (navigation.rows.get(tab) !== row) return;
      navigation.rows.delete(tab);
      if (this.nativeSettingsNavigation === navigation && navigation.rows.size === 0) {
        this.disposeSettingsView();
      }
    };
  }

  display(): void {
    // Host 1.13+ owns the definition rows; an imperative refresh must not delete them.
    if (this.nativeSettingsNavigation) {
      this.scheduleDisplay();
      return;
    }
    this.renderSettingsShell();
    this.beginSettingsDisplay();
    this.renderSettingsContent();
  }

  private beginSettingsDisplay(): void {
    this.settingsVisible = true;
    this.lastRenderedSettingsTab = null;
    this.settingsTabIconAnimation = null;
    this.cancelScheduledDisplay();
    const pendingResourceId = this.plugin.consumeEchoInkSettingsResourceDetail?.() ?? "";
    if (pendingResourceId) {
      this.openSettingsDetail({
        kind: "resource",
        resourceId: pendingResourceId
      });
    }
  }

  hide(): void {
    const shouldConfirmKnowledgePreference =
      this.settingsDetail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
      && !this.knowledgePreferenceClosePromptRunning;
    this.disposeSettingsView();
    super.hide();
    if (shouldConfirmKnowledgePreference) {
      this.knowledgePreferenceClosePromptRunning = true;
      void this.confirmKnowledgePreferenceDiscard().then((discard) => {
        this.knowledgePreferenceClosePromptRunning = false;
        if (discard) {
          this.resetKnowledgePreferenceDraft();
          return;
        }
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        const settings = (this.app as {
          setting?: { open?: () => void; openTabById?: (id: string) => void };
        }).setting;
        settings?.open?.();
        settings?.openTabById?.(this.plugin.manifest.id);
      });
    }
  }

  private disposeSettingsView(): void {
    const navigation = this.nativeSettingsNavigation;
    for (const { setting, button } of navigation?.rows.values() ?? []) {
      if (setting.nameEl.parentElement === button) setting.infoEl.appendChild(setting.nameEl);
    }
    this.inlineEditor?.dispose();
    this.inlineEditor = null;
    this.developerPanel?.dispose();
    this.developerPanel = null;
    this.settingsVisible = false;
    this.clearOnboardingCoachmark(true);
    this.knowledgeInitSection?.dispose();
    this.knowledgeDashboardRequestId += 1;
    this.knowledgeDashboardEl = null;
    this.knowledgeDashboardSnapshot = null;
    this.knowledgeDashboardLoading = false;
    this.knowledgeDashboardError = "";
    disposeKnowledgeDashboardTooltipState(this.knowledgeDashboardTooltipState);
    this.disconnectSettingsTabsResizeObserver();
    this.cancelScheduledDisplay();
    this.clearResourceSearchDebounceTimer();
    disposeOriginControls(navigation?.workspaceEl ?? this.containerEl);
    this.nativeSettingsNavigation = null;
    if (navigation) {
      // Return the host list before removing our shell; never remove its rows.
      if (this.settingsTabsEl?.contains(navigation.listEl)) {
        navigation.workspaceEl.insertBefore(navigation.listEl, this.settingsTabsEl);
      }
      this.settingsTitleEl?.remove();
      this.settingsTabsEl?.remove();
      this.settingsBodyEl?.remove();
      this.settingsStatusEl?.remove();
      navigation.rows.clear();
      this.settingsTitleEl = this.settingsTabsEl = this.settingsBodyEl = this.settingsStatusEl = null;
    }
  }

  private renderSettingsShell(): void {
    this.disconnectSettingsTabsResizeObserver();
    const { containerEl } = this;
    containerEl.removeClass("echoink-settings-demo");
    containerEl.addClass("echoink-settings-host");
    disposeOriginControls(containerEl);
    containerEl.empty();
    const workspace = containerEl.createDiv({ cls: "echoink-settings-demo" });
    this.settingsTitleEl = workspace.createDiv({ cls: "codex-settings-title" });
    this.settingsTabsEl = workspace.createDiv({ cls: "codex-settings-tabs-slot" });
    this.createSettingsBody(workspace);
  }

  private createSettingsBody(workspace: HTMLElement): void {
    this.settingsBodyEl = workspace.createDiv({ cls: "codex-settings-body" });
    this.settingsStatusEl = workspace.createDiv({
      cls: "codex-settings-status",
      attr: {
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });
  }

  private ensureSettingsShell(): void {
    if (this.nativeSettingsNavigation) return;
    if (this.settingsBodyEl && this.containerEl.contains(this.settingsBodyEl)) return;
    this.renderSettingsShell();
  }

  private renderSettingsContent(): void {
    this.developerPanel?.dispose();
    this.developerPanel = null;
    this.ensureSettingsShell();
    this.captureTabFocusIntent();
    this.captureSettingsFocusIntent();
    const copy = this.copy;
    const settingsScrollSnapshot = captureSettingsScrollSnapshot(this.containerEl);
    try {
      this.clearResourceSearchDebounceTimer();
      const titleEl = this.settingsTitleEl;
      const tabsEl = this.settingsTabsEl;
      const bodyEl = this.settingsBodyEl;
      if (!titleEl || !tabsEl || !bodyEl) return;
      clearKnowledgeDashboardHealthTooltips(this.knowledgeDashboardTooltipState);
      this.knowledgeDashboardEl = null;
      disposeOriginControls(titleEl);
      titleEl.empty();
      if (!this.nativeSettingsNavigation) {
        disposeOriginControls(tabsEl);
        tabsEl.empty();
      }
      const activeInline = this.inlineEditor;
      if (activeInline && activeInline.tab === visibleSettingsTab(this.plugin.settings.settingsTab)) activeInline.host.remove();
      else if (activeInline) { activeInline.dispose(); this.inlineEditor = null; }
      disposeOriginControls(bodyEl);
      bodyEl.empty();
      const pageTitle = new OriginSetting(titleEl)
        .setName(copy.title)
        .setHeading();
      pageTitle.settingEl.addClass("echoink-settings-page-title-row");
      pageTitle.nameEl.addClass("codex-settings-page-title");
      pageTitle.nameEl.id = SETTINGS_TITLE_ID;

      const activeTab = visibleSettingsTab(this.plugin.settings.settingsTab);
      this.plugin.settings.settingsTab = activeTab;
      this.renderTopTabs(tabsEl, activeTab);
      bodyEl.setAttr("id", SETTINGS_PANEL_ID);
      bodyEl.setAttr("role", "tabpanel");
      bodyEl.setAttr("aria-labelledby", settingsTabDomId(activeTab));
      bodyEl.setAttr("tabindex", "0");

      bodyEl.setAttr("aria-busy", String(
        (activeTab === "resources" && this.resourceLoadingTab === this.plugin.settings.resourceManagementTab)
        || this.memoryActionRunning
      ));

      if (this.inlineEditor) {
        bodyEl.appendChild(this.inlineEditor.host);
      } else if (activeTab === "providers") {
        this.renderProviderModelManager(bodyEl);
      } else if (activeTab === "resources") {
        this.renderWorkspaceResourceManager(bodyEl);
      } else if (activeTab === "knowledgeBase") {
        this.renderKnowledgeBaseSettings(bodyEl);
      } else if (activeTab === "review") {
        this.renderReviewSettings(bodyEl);
      } else if (activeTab === "todos") {
        this.renderTodosSettings(bodyEl);
      } else {
        this.renderGeneralSettings(bodyEl);
      }
    } finally {
      const tab = visibleSettingsTab(this.plugin.settings.settingsTab);
      const location = JSON.stringify([tab, this.settingsDetail,
        tab === "resources" ? this.plugin.settings.resourceManagementTab : null]);
      const inlineHost = this.inlineEditor?.host ?? null;
      if (location !== this.renderedSettingsLocation || inlineHost !== this.renderedInlineHost) {
        // A new page starts at its heading; background refreshes keep their position.
        const rootScroll = settingsScrollSnapshot.find((entry) => entry.element === this.containerEl);
        if (rootScroll) { rootScroll.top = 0; rootScroll.left = 0; }
        else settingsScrollSnapshot.unshift({ element: this.containerEl, top: 0, left: 0 });
      }
      this.renderedSettingsLocation = location;
      this.renderedInlineHost = inlineHost;
      restoreSettingsScrollSnapshot(settingsScrollSnapshot);
      this.restoreSettingsFocusIntent();
      if (this.plugin.consumeKnowledgeDashboardFocus?.()) {
        this.knowledgeDashboardEl?.setAttribute("tabindex", "-1");
        this.knowledgeDashboardEl?.focus({ preventScroll: true });
        this.knowledgeDashboardEl?.scrollIntoView({ block: "start" });
      }
      void this.refreshOnboardingCoachmark();
    }
  }

  private scheduleDisplay(): void {
    if (!this.settingsVisible) return;
    if (this.displayFrame !== null) return;
    const settingsWindow = this.containerEl.ownerDocument.defaultView ?? window;
    this.displayFrameWindow = settingsWindow;
    this.displayFrame = settingsWindow.requestAnimationFrame(() => {
      this.displayFrame = null;
      this.displayFrameWindow = null;
      this.renderSettingsContent();
    });
  }

  private cancelScheduledDisplay(): void {
    if (this.displayFrame !== null) {
      this.displayFrameWindow?.cancelAnimationFrame(this.displayFrame);
    }
    this.displayFrame = null;
    this.displayFrameWindow = null;
  }

  private captureTabFocusIntent(): void {
    const activeElement = this.containerEl.ownerDocument.activeElement;
    if (!(activeElement instanceof (this.containerEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)) || !this.containerEl.contains(activeElement)) return;

    const settingsButton = activeElement.closest<HTMLButtonElement>(
      "button.codex-settings-tab[data-settings-tab]"
    );
    const settingsTabId = settingsButton?.dataset.settingsTab;
    if (
      !this.suppressSettingsTabFocusRestore
      && this.settingsTabFocusId === null
      && SETTINGS_TABS.some((tab) => tab.id === settingsTabId)
    ) {
      this.settingsTabFocusId = settingsTabId as VisibleSettingsTab;
    }

    const resourceButton = activeElement.closest<HTMLButtonElement>(
      "button.codex-resource-tab[data-resource-tab]"
    );
    const resourceTabId = resourceButton?.dataset.resourceTab;
    if (
      !this.suppressResourceTabFocusRestore
      && this.resourceTabFocusId === null
      && RESOURCE_TABS.some((tab) => tab.id === resourceTabId)
    ) {
      this.resourceTabFocusId = resourceTabId as ResourceManagementTab;
    }
  }

  private captureSettingsFocusIntent(): void {
    if (this.settingsFocusIntent) return;
    const activeElement = this.containerEl.ownerDocument.activeElement;
    if (!(activeElement instanceof (this.containerEl.ownerDocument.defaultView?.HTMLElement ?? HTMLElement)) || !this.containerEl.contains(activeElement)) return;
    const focusable = activeElement.closest<HTMLElement>("button, input, select, textarea, a[href]");
    if (!focusable) return;
    if (focusable.getAttribute("role") === "tab") return;
    this.settingsFocusIntent = this.settingsFocusKey(focusable);
  }

  private restoreSettingsFocusIntent(): void {
    const sharedKey = settingsContainerFocusIntents.get(this.containerEl);
    const key = sharedKey ?? this.settingsFocusIntent;
    if (!key) return;
    if (sharedKey) {
      (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
        const focusable = Array.from(this.containerEl.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href]"
        )).find((element) => this.settingsFocusKey(element) === sharedKey);
        if (!focusable?.isConnected) return;
        focusable.focus({ preventScroll: true });
        if (this.containerEl.ownerDocument.activeElement !== focusable) return;
        settingsContainerFocusIntents.delete(this.containerEl);
        this.settingsFocusIntent = null;
      });
      return;
    }
    const focusable = Array.from(this.containerEl.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href]"
    )).find((element) => this.settingsFocusKey(element) === key);
    if (!focusable) return;
    const focusTarget = () => {
      if (focusable.isConnected) focusable.focus({ preventScroll: true });
    };
    focusTarget();
    (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget);
    this.settingsFocusIntent = null;
  }

  private requestPersonalityTemplateFocusRestore(): void {
    this.settingsFocusIntent = PERSONALITY_TEMPLATE_FOCUS_INTENT;
    settingsContainerFocusIntents.set(
      this.containerEl,
      PERSONALITY_TEMPLATE_FOCUS_INTENT
    );
  }

  private settingsFocusKey(element: HTMLElement): string {
    const explicit = element.dataset.echoinkFocusKey;
    if (explicit) return `explicit:${explicit}`;
    const id = element.id;
    if (id) return `id:${id}`;
    const stableText = element.getAttribute("aria-label")
      ?? element.getAttribute("data-settings-tab")
      ?? element.getAttribute("data-resource-tab")
      ?? element.getAttribute("data-resource-key")
      ?? element.textContent?.trim()
      ?? "";
    const className = Array.from(element.classList).filter((name) => name.startsWith("codex-")).sort().join(".");
    return `${element.tagName}:${className}:${stableText}`;
  }

  private announceSettingsStatus(message: string): void {
    this.settingsStatusEl?.setText(message);
  }

  private renderSettingsActionError(
    container: HTMLElement,
    context: SettingsActionContext
  ): void {
    const message = this.settingsActionErrors[context];
    if (!message) return;
    createSettingsState(container, message, "error");
  }

  private reportSettingsActionError(context: SettingsActionContext): void {
    const message = this.plugin.settings.settingsLanguage === "en"
      ? `${context === "review" ? "Review" : context === "resources" ? "Resource" : context === "providers" ? "Model" : "Knowledge"} action did not finish. Check the current configuration and try again.`
      : `${context === "review" ? "复盘" : context === "resources" ? "资源" : context === "providers" ? "模型" : "知识库"}操作未完成。请检查当前配置后重试。`;
    this.settingsActionErrors[context] = message;
    this.announceSettingsStatus(message);
  }

  private async refreshOnboardingCoachmark(): Promise<void> {
    const generation = ++this.onboardingRefreshGeneration;
    if (!this.settingsVisible || !this.plugin.isEchoInkOnboardingRequested()) {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const step = this.plugin.getEchoInkOnboardingStep();
    if (step === "sidebar" || step === "settings") {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const requiredTab = echoInkOnboardingTab(step);
    if (this.plugin.settings.settingsTab !== requiredTab) {
      // 教程只在对应页面提供提示，不接管设置导航。用户主动切到其他
      // Tab 时隐藏 coachmark；点「下一步」仍会显式导航到下一站。
      this.clearOnboardingCoachmark(false);
      return;
    }
    const settingsWindow = this.containerEl.ownerDocument.defaultView ?? window;
    settingsWindow.requestAnimationFrame(() => {
      if (
        generation !== this.onboardingRefreshGeneration
        || !this.settingsVisible
        || !this.plugin.isEchoInkOnboardingRequested()
      ) return;
      this.renderOnboardingCoachmark(step);
    });
  }

  private renderOnboardingCoachmark(step: EchoInkOnboardingStep): void {
    if (step === "sidebar" || step === "settings") {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const anchorKey = step === "provider"
      ? "providers:add"
      : step === "knowledge"
        ? "knowledge:onboarding"
        : "general:personality-template";
    const anchor = this.containerEl.querySelector<HTMLElement>(
      `[data-echoink-focus-key="${anchorKey}"]`
    );
    if (!anchor) {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const highlightAnchor = step === "personality"
      ? anchor.closest<HTMLElement>(".echoink-agent-profile-card-header") ?? anchor
      : step === "knowledge"
        ? anchor.querySelector<HTMLElement>(".echoink-knowledge-init-tabs") ?? anchor
        : anchor;
    const focusAnchor = step === "knowledge"
      ? highlightAnchor.querySelector<HTMLElement>('button[aria-selected="true"]') ?? anchor
      : anchor;
    // A body/container captured when settings opens is connected but cannot
    // restore useful focus. Always return to this step's real product target.
    if (step === "knowledge" && focusAnchor === anchor) anchor.setAttr("tabindex", "-1");
    this.onboardingRestoreFocusEl = focusAnchor;
    this.clearOnboardingCoachmark(false);
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const copy = onboardingCoachmarkCopy(step, zh);
    const handle = mountEchoInkOnboardingCoachmark({
      app: this.app,
      anchor: focusAnchor,
      highlightAnchor,
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
      restoreFocusEl: this.onboardingRestoreFocusEl,
      onDismiss: async () => {
        await this.plugin.dismissEchoInkOnboarding();
        this.clearOnboardingCoachmark(true);
      },
      onPrevious: async () => {
        await this.selectOnboardingTutorialStep(step, ECHOINK_ONBOARDING_STEPS[ECHOINK_ONBOARDING_STEPS.indexOf(step) - 1]);
      },
      onStep: async (nextStep) => { await this.selectOnboardingTutorialStep(step, nextStep); },
      onAction: async () => {
        await this.advanceOnboardingTutorial(step);
      },
      onActionError: (error) => {
        console.error("EchoInk onboarding advance failed", error);
        new Notice(zh ? "引导进度保存失败，请重试" : "Failed to save tutorial progress. Try again.");
      }
    });
    this.onboardingCoachmarkHandle = handle;
  }

  private async advanceOnboardingTutorial(step: EchoInkOnboardingStep): Promise<void> {
    const nextStep = await this.plugin.advanceEchoInkOnboarding(step);
    if (!nextStep) {
      this.onboardingRestoreFocusEl = this.containerEl.querySelector<HTMLElement>(
        '[data-echoink-focus-key="general:personality-template"]'
      ) ?? this.onboardingRestoreFocusEl;
      this.showOnboardingCompletion();
      return;
    }
    await this.showOnboardingTutorialStep(nextStep);
  }

  private async selectOnboardingTutorialStep(step: EchoInkOnboardingStep, nextStep: EchoInkOnboardingStep): Promise<void> {
    if (await this.plugin.selectEchoInkOnboardingStep(step, nextStep)) await this.showOnboardingTutorialStep(nextStep);
  }

  private async showOnboardingTutorialStep(nextStep: EchoInkOnboardingStep): Promise<void> {
    this.clearOnboardingCoachmark(false);
    this.onboardingRestoreFocusEl = null;
    if (nextStep === "sidebar" || nextStep === "settings") {
      (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
      await this.plugin.openPendingEchoInkOnboarding();
      return;
    }
    await this.activateSettingsTab(
      echoInkOnboardingTab(nextStep),
      false
    );
    if (this.plugin.settings.settingsTab === echoInkOnboardingTab(nextStep)) {
      this.scheduleDisplay();
    }
  }

  private showOnboardingCompletion(): void {
    const anchor = this.onboardingRestoreFocusEl ?? this.containerEl;
    this.clearOnboardingCoachmark(false);
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const backToWorkspace = async () => {
      // Opening the workspace first keeps this card retryable if navigation
      // fails. Close the host only after the requested destination is ready.
      await this.plugin.activateHomeAndSidebar();
      this.clearOnboardingCoachmark(false);
      (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
    };
    this.onboardingCoachmarkHandle = mountEchoInkOnboardingCoachmark({
      app: this.app,
      anchor,
      stepClass: "complete",
      stepLabel: "",
      complete: true,
      tone: "green",
      ...onboardingCompletionCopy(zh),
      restoreFocusEl: anchor,
      onPrevious: async () => {
        await this.plugin.restartEchoInkOnboarding();
        await this.showOnboardingTutorialStep("sidebar");
      },
      onAction: backToWorkspace,
      onDismiss: backToWorkspace,
      onActionError: (error) => {
        console.error("EchoInk onboarding completion action failed", error);
        new Notice(zh ? "操作未完成，请重试。" : "The action did not finish. Try again.");
      }
    });
  }

  private clearOnboardingCoachmark(restoreFocus: boolean): void {
    this.onboardingCoachmarkHandle?.destroy(false);
    this.onboardingCoachmarkHandle = null;
    if (!restoreFocus) return;
    const restore = this.onboardingRestoreFocusEl;
    this.onboardingRestoreFocusEl = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  private async runSettingsButtonAction(
    button: HTMLButtonElement,
    context: SettingsActionContext,
    action: () => Promise<void>
  ): Promise<void> {
    button.disabled = true;
    setAmicroButtonPending(button, true);
    delete this.settingsActionErrors[context];
    let completed = false;
    try {
      await action();
      completed = true;
    } catch {
      this.reportSettingsActionError(context);
    } finally {
      if (completed) confirmAmicroButton(button);
      else setAmicroButtonPending(button, false);
      if (button.isConnected) button.disabled = false;
      this.scheduleDisplay();
    }
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    const copy = this.copy;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(containerEl, {
      title: zh ? "基础设置" : "General",
      description: zh
        ? "调整 EchoInk 的界面语言、启动方式、长期记忆和个性化。"
        : "Choose EchoInk's language, startup behavior, long-term memory, and personalization."
    });
    const interfaceSection = createSettingsSection(page, {
      title: zh ? "界面与启动" : "Interface and startup",
      surface: "group"
    });
    const interfaceGroup = createSettingsGroup(interfaceSection);
    applySettingsRow(new OriginSetting(interfaceGroup).setName(copy.general.settingsLanguage).setDesc(copy.general.settingsLanguageDesc).addOriginDropdown(this.app, (dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.general.settingsLanguage);
      for (const language of SETTINGS_LANGUAGE_OPTIONS) dropdown.addOption(language, copy.general.languageOptions[language]);
      dropdown.setValue(this.plugin.settings.settingsLanguage);
      dropdown.onChange(async (value) => {
        this.plugin.settings.settingsLanguage = normalizeSettingsLanguage(value);
        await this.plugin.saveSettings(true);
        await this.plugin.refreshLanguageSurfaces();
        // Refresh native labels/index as well as the existing content. The
        // method is absent on old hosts, which continue through display().
        (this as CodexSettingTab & { update?: () => void }).update?.();
        this.scheduleDisplay();
      });
    }));

    applySettingsRow(new OriginSetting(interfaceGroup)
      .setName(copy.general.autoOpen)
      .setDesc(zh ? "Obsidian 启动后自动打开 EchoInk 侧栏。" : "Open the EchoInk sidebar when Obsidian starts.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, copy.general.autoOpen);
        toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
          this.plugin.settings.autoOpen = value;
          await this.plugin.saveSettings();
        });
      }));

    applySettingsRow(new OriginSetting(interfaceGroup)
      .setName(copy.general.autoOpenHome)
      .setDesc(zh ? "Obsidian 启动后显示 EchoInk 首页概览。" : "Show the EchoInk home overview when Obsidian starts.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, copy.general.autoOpenHome);
        toggle.setValue(this.plugin.settings.autoOpenHome).onChange(async (value) => {
          this.plugin.settings.autoOpenHome = value;
          await this.plugin.saveSettings();
        });
      }));

    const quickChatSection = createSettingsSection(page, {
      title: zh ? "快捷 AI 小窗" : "Quick AI window",
      surface: "group"
    });
    const quickChatGroup = createSettingsGroup(quickChatSection);
    const quickChatToggleLabel = zh ? "全局快捷键唤起 AI 小窗" : "Global quick AI window hotkey";
    applySettingsRow(new OriginSetting(quickChatGroup)
      .setName(quickChatToggleLabel)
      .setDesc(zh
        ? "在任意应用前台时按快捷键，EchoInk 对话小窗浮现在当前屏幕上，直接提问；再次按下收起，按 Esc 关闭。收起保留草稿与正在生成的回答。需要 Obsidian 桌面端保持运行。"
        : "From any app, press the hotkey to float the EchoInk chat window over the current screen and ask directly. Press again or hit Esc to collapse; drafts and running generations survive. Requires the Obsidian desktop app to stay running.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, quickChatToggleLabel);
        toggle.setValue(this.plugin.settings.quickChat.enabled).onChange(async (value) => {
          this.plugin.settings.quickChat.enabled = value;
          await this.plugin.saveSettings();
          const result = this.plugin.applyQuickChatSettings();
          if (value && !result.ok) {
            new Notice(describeQuickChatRegistration(result, true, this.plugin.settings.quickChat.hotkey, zh));
          }
          this.scheduleDisplay();
        });
      }));

    applySettingsRow(new OriginSetting(quickChatGroup)
      .setName(zh ? "快捷键" : "Hotkey")
      .setDesc(zh
        ? "点击输入框后按下新的组合键（需包含 Ctrl/⌘ 等修饰键）；Esc 取消录制。"
        : "Focus the field and press a new combination (a modifier key is required); Esc cancels recording.")
      .addOriginText((text) => {
        const input = text.inputEl;
        input.readOnly = true;
        const settings = this.plugin.settings;
        const renderHotkey = (): void => {
          input.value = formatAcceleratorForDisplay(settings.quickChat.hotkey, Platform.isMacOS);
        };
        input.placeholder = zh ? "按下快捷键…" : "Press keys…";
        renderHotkey();
        let recording = false;
        input.addEventListener("focus", () => {
          recording = true;
          input.value = zh ? "按下新组合…" : "Press a new combination…";
        });
        input.addEventListener("blur", () => {
          recording = false;
          renderHotkey();
        });
        input.addEventListener("keydown", (event) => {
          if (!recording) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            input.blur();
            return;
          }
          if (event.isComposing || event.keyCode === 229) return;
          const recorded = recordAcceleratorFromEvent(event);
          if (!recorded.valid) return;
          const normalized = normalizeAccelerator(recorded.accelerator);
          if (!normalized) return;
          settings.quickChat.hotkey = normalized;
          void (async () => {
            await this.plugin.saveSettings();
            const result = this.plugin.applyQuickChatSettings();
            if (settings.quickChat.enabled && !result.ok) {
              new Notice(describeQuickChatRegistration(result, true, normalized, zh));
            }
            input.blur();
            this.scheduleDisplay();
          })();
        });
      }));

    const quickChatRegistration = this.plugin.getQuickChatWindowController()?.registration
      ?? { ok: false, reason: "disabled" as const };
    applySettingsRow(new OriginSetting(quickChatGroup)
      .setName(zh ? "注册状态" : "Registration status")
      .setDesc(describeQuickChatRegistration(
        quickChatRegistration,
        this.plugin.settings.quickChat.enabled,
        this.plugin.settings.quickChat.hotkey,
        zh
      )));

    const journalSection = createSettingsSection(page, {
      title: zh ? "日记" : "Journal",
      surface: "group"
    });
    const journalGroup = createSettingsGroup(journalSection);
    applySettingsRow(new OriginSetting(journalGroup)
      .setName(zh ? "日记保存文件夹" : "Journal folder")
      .setDesc(zh
        ? "与 Obsidian 原生日记共用文件夹。日期格式和模板可在原生日记设置中调整；默认按月存放，每天一篇。"
        : "Shared with Obsidian Daily notes. Set the date format and template there; the default is one note per day in monthly folders.")
      .addOriginText((text) => {
        const label = zh ? "日记保存文件夹" : "Journal folder";
        text.setPlaceholder("journal").setValue(readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory).folder);
        text.inputEl.setAttr("aria-label", label);
        const saveDirectory = async (): Promise<void> => {
          const previous = readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory).folder;
          const normalized = normalizeJournalDirectory(text.getValue());
          text.setValue(normalized);
          if (normalized === previous) return;
          try {
            await saveNativeJournalFolder(this.app, normalized);
          } catch {
            text.setValue(previous);
            new Notice(zh ? "日记保存文件夹未保存，请重试" : "Journal folder was not saved. Try again.");
          }
        };
        text.inputEl.addEventListener("blur", () => void saveDirectory());
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          text.inputEl.blur();
        });
      }));

    const memorySection = createSettingsSection(page, {
      title: zh ? "长期记忆" : "Long-term memory",
      surface: "group"
    });
    const memoryGroup = createSettingsGroup(memorySection);
    const memoryToggle = applySettingsRow(new OriginSetting(memoryGroup)
      .setName(zh ? "使用长期记忆" : "Use long-term memory")
      .setDesc(zh
        ? "开启后，Agent 可在所有新旧对话中自主记住、更新、忘掉和整理长期记忆。关闭后仍保留 Agent 名称、头像与基础人格，但不会读取或写入记忆、不会做梦，也不会加载从长期协作中形成的用户画像或 Agent 学习内容。"
        : "When enabled, the Agent can remember, update, forget, and consolidate long-term memory in every conversation. When disabled, its name, avatar, and base personality remain, but it does not read or write memory, dream, or load user-profile or Agent learning content formed through long-term collaboration.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, zh ? "使用长期记忆" : "Use long-term memory");
        toggle.setValue(this.plugin.settings.memory.useLongTermMemory).onChange(async (enabled) => {
          this.plugin.settings.memory.useLongTermMemory = enabled;
          const mode = enabled ? "normal" : "no_memory";
          for (const session of this.plugin.settings.sessions) session.defaultMemoryMode = mode;
          await this.plugin.saveSettings(true);
          this.plugin.getCodexView()?.refreshPersonalizationUi();
        });
      }));

    addSettingsHelp(memoryToggle, zh ? "Agent 可在新旧对话中记住、更新、忘掉和整理记忆。" : "The Agent can remember, update, forget, and consolidate memory across conversations.", memoryToggle.descEl.textContent ?? "");

    // --- Dream scheduler settings ---
    const dreamToggle = applySettingsRow(new OriginSetting(memoryGroup)
      .setName(zh ? "离线记忆整理（做梦）" : "Offline memory consolidation (dreaming)")
      .setDesc(zh
        ? "默认开启。开启后，Obsidian 打开期间定时处理一级 Memory，生成只帮助召回、不代表用户确认的二级联想，并更新用户画像与 Agent 长期形成的处事方式。关闭后，一级 Memory 仍在对话当轮正常写入和召回；派生状态与积压会保留，重新开启后继续处理。"
        : "Enabled by default. While Obsidian is open, it periodically processes primary Memory, creates secondary associations that aid recall without representing user confirmation, and updates the user profile and the Agent's learned ways of working. When disabled, primary Memory still writes and recalls; derived state and backlog are preserved and resume after re-enabling.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, zh ? "离线记忆整理" : "Memory consolidation");
        toggle.setValue(this.plugin.settings.memory.dreamEnabled).onChange(async (enabled) => {
          this.plugin.settings.memory.dreamEnabled = enabled;
          await this.plugin.saveSettings();
        });
      }));

    addSettingsHelp(dreamToggle, zh ? "Obsidian 打开期间，定时整理 Memory，更新用户画像与 Agent 长期形成的处事方式。" : "While Obsidian is open, consolidate Memory and update the user profile and the Agent’s learned ways of working.", dreamToggle.descEl.textContent ?? "");

    const runsSetting = applySettingsRow(new OriginSetting(memoryGroup)
      .setName(zh ? "每日整理次数" : "Runs per day")
      .setDesc(zh ? "每天执行几次离线整理（1–6 次）。" : "Choose how many consolidation runs to schedule each day (1–6)."));
    runsSetting.controlEl.addClass("general-range");
    const runsOutput = runsSetting.controlEl.createEl("output", { text: zh ? `${this.plugin.settings.memory.dreamRunsPerDay} 次/天` : `${this.plugin.settings.memory.dreamRunsPerDay}/day` });
    const slider = createOriginSlider(runsSetting.controlEl, {
      value: this.plugin.settings.memory.dreamRunsPerDay, min: 1, max: 6, step: 1,
      label: zh ? "每日整理次数" : "Runs per day",
      onValueChange: (value) => { runsOutput.setText(zh ? `${value} 次/天` : `${value}/day`); },
      onValueCommit: (value) => {
        this.plugin.settings.memory.dreamRunsPerDay = value;
        void this.plugin.saveSettings();
      }
    });
    runsSetting.controlEl.insertBefore(slider, runsOutput);

    const layoutSection = createSettingsSection(page, {
      title: zh ? "布局与外观" : "Layout & appearance",
      surface: "group"
    });
    const layoutGroup = createSettingsGroup(layoutSection);
    for (const module of ECHOINK_HOME_MODULES) {
      const label = zh ? module.zhName : module.enName;
      applySettingsRow(new OriginSetting(layoutGroup)
        .setName(label)
        .setDesc(zh
          ? "控制工作台首页是否展示该模块；隐藏时保留原布局槽位，不删除模块数据。"
          : "Show or hide this module on the workbench home. Hiding keeps its layout slot and data.")
        .addOriginToggle((toggle) => {
          labelSettingsToggle(toggle, label);
          toggle.setValue(this.plugin.settings.homeModules[module.id] !== false).onChange(async (value) => {
            this.plugin.settings.homeModules[module.id] = value;
            await this.plugin.saveSettings();
            this.plugin.notifyHomeSurfacesChanged();
          });
        }));
    }

    this.renderFilePersonalizationSettings(page);
    this.renderDeveloperModeSettings(page);
    this.renderAboutSection(page);
  }

  private renderTodosSettings(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const store = this.plugin.getTodoStore();
    const sourceSection = createSettingsSection(page, {
      title: zh ? "数据文件" : "Data file",
      surface: "group"
    });
    const sourceGroup = createSettingsGroup(sourceSection);
    const sourceRow = applySettingsRow(new OriginSetting(sourceGroup)
      .setName(zh ? "待办源文件" : "To-do source file")
      .setDesc(zh
        ? `待办的唯一持久化来源：Vault 内 ${TODO_SOURCE_PATH}。Obsidian 原生待办清单格式，可直接编辑；界面操作会写回同一文件。`
        : `Single source of truth: ${TODO_SOURCE_PATH} in this vault. Native Obsidian task-list format; edit it directly and the UI follows.`));
    const openButton = sourceRow.controlEl.createEl("button", {
      cls: "mod-cta",
      text: zh ? "打开源文件" : "Open source file",
      attr: { type: "button" }
    });
    openButton.onclick = () => void store.openSourceFile();

    const section = createSettingsSection(page, {
      title: zh ? "待办分类" : "To-do categories",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    applySettingsRow(new OriginSetting(group)
      .setName(zh ? "分类与待办的关系" : "Categories and to-dos")
      .setDesc(zh
        ? "分类以名称写入源文件；重命名后已有待办同步显示新名称；删除分类不会删除待办，相关事项转为「未分类」。是否在工作台显示待办，请在「基础设置 → 布局与外观」管理。"
        : "Categories are stored by name in the source file; renames apply to existing to-dos. Deleting a category keeps its to-dos, which become uncategorized. Whether the to-do module shows on the workbench is managed under General → Layout & appearance."));
    for (const category of this.plugin.settings.todoCategories) {
      const row = applySettingsRow(new OriginSetting(group).setName(category.name));
      const renameButton = row.controlEl.createEl("button", {
        cls: "mod-cta",
        text: zh ? "重命名" : "Rename",
        attr: { type: "button" }
      });
      renameButton.onclick = () => void (async () => {
        const next = await textInputModal(
          this.app,
          zh ? "重命名分类" : "Rename category",
          zh ? "分类名称" : "Category name",
          category.name
        );
        if (next === null) return;
        const trimmed = next.trim();
        if (!trimmed) {
          new Notice(zh ? "分类名称不能为空" : "The category name cannot be empty");
          return;
        }
        if (this.plugin.settings.todoCategories.some((entry) => entry.id !== category.id && entry.name === trimmed)) {
          new Notice(zh ? "已有同名分类" : "A category with this name already exists");
          return;
        }
        const previous = category.name;
        category.name = trimmed;
        await this.plugin.saveSettings();
        await store.renameCategoryInSource(previous, trimmed);
        this.plugin.notifyHomeSurfacesChanged();
        this.scheduleDisplay();
      })();
      const deleteButton = row.controlEl.createEl("button", {
        cls: "mod-warning",
        text: zh ? "删除" : "Delete",
        attr: { type: "button" }
      });
      deleteButton.onclick = () => void (async () => {
        const affected = store.snapshot().filter((record) => record.categoryName === category.name).length;
        const accepted = await confirmModal(
          this.app,
          zh ? "删除分类" : "Delete category",
          zh
            ? `删除「${category.name}」后，${affected} 条相关待办将转为「未分类」；待办本身不会被删除。`
            : `Deleting "${category.name}" moves ${affected} to-do(s) to Uncategorized. The to-dos themselves are kept.`,
          zh ? "删除" : "Delete",
          zh ? "取消" : "Cancel"
        );
        if (!accepted) return;
        const index = this.plugin.settings.todoCategories.findIndex((entry) => entry.id === category.id);
        if (index >= 0) this.plugin.settings.todoCategories.splice(index, 1);
        await this.plugin.saveSettings();
        await store.removeCategoryFromSource(category.name);
        this.plugin.notifyHomeSurfacesChanged();
        this.scheduleDisplay();
      })();
    }
    const addRow = applySettingsRow(new OriginSetting(group)
      .setName(zh ? "新增分类" : "Add category")
      .setDesc(zh ? "名称不能为空，也不能与已有分类同名。" : "Names cannot be empty or duplicate an existing category."));
    const addButton = addRow.controlEl.createEl("button", {
      cls: "mod-cta",
      text: zh ? "新增" : "Add",
      attr: { type: "button" }
    });
    addButton.onclick = () => void (async () => {
      const name = await textInputModal(
        this.app,
        zh ? "新增分类" : "Add category",
        zh ? "分类名称" : "Category name"
      );
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed || this.plugin.settings.todoCategories.some((entry) => entry.name === trimmed)) {
        new Notice(zh ? "名称为空或已存在同名分类" : "The name is empty or already exists");
        return;
      }
      this.plugin.settings.todoCategories.push({ id: newId("todo-category"), name: trimmed });
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    })();
  }

  private renderDeveloperModeSettings(page: HTMLElement): void {
    const access = this.plugin.developerMode;
    if (!access?.revealed) return;
    const language = this.plugin.settings.settingsLanguage;
    const zh = language !== "en";
    const section = createSettingsSection(page, {
      title: zh ? "开发者模式" : "Developer mode",
      surface: "group"
    });
    section.addClass("echoink-developer-settings");
    const group = createSettingsGroup(section);
    const label = zh ? "显示测试工具" : "Show testing tools";
    applySettingsRow(new OriginSetting(group).setName(label).setDesc(zh
      ? "显示记忆与做梦的测试操作。仅在当前插件会话中生效。"
      : "Show memory and Dream testing actions for this plugin session.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, label);
        toggle.toggleEl.setAttribute("data-developer-toggle", "true");
        toggle.setValue(access.enabled).onChange((enabled) => {
          access.setEnabled(enabled);
          this.renderSettingsContent();
        });
      }));
    if (!access.enabled) return;
    const panelEl = group.createDiv({ cls: "echoink-developer-panel" });
    const panel: DeveloperModePanel = new DeveloperModePanel(panelEl, this.plugin.getDeveloperModeService(), zh,
      () => this.settingsVisible && this.developerPanel === panel
        && this.plugin.settings.settingsLanguage === language
        && visibleSettingsTab(this.plugin.settings.settingsTab) === "general",
      () => { if (access.enabled) this.scheduleDisplay(); });
    this.developerPanel = panel;
    void panel.render();
  }

  private renderFilePersonalizationSettings(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const section = createSettingsSection(page, {
      title: zh ? "身份与用户画像" : "Identity and user profile",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    if (this.personalMemoryLoading) {
      createSettingsState(group, zh ? "正在读取画像数据…" : "Loading profile data…", "neutral");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(
        group,
        zh ? "画像数据暂时无法读取" : "Profile data is temporarily unavailable",
        "error",
        {
          label: zh ? "重新加载画像数据" : "Reload profile data",
          onActivate: () => void this.loadPersonalMemoryState(true)
        }
      );
      return;
    }
    this.addAgentProfileCard(group);
    // User profile: read-only (maintained by dreaming / memory corrections)
    this.addReadOnlyUserProfileCard(group, this.personalMemoryState.user);
    applySettingsRow(new OriginSetting(group)
      .setName(this.copy.general.customWelcome)
      .setDesc(this.copy.general.customWelcomeDesc)
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, this.copy.general.customWelcome);
        toggle.setValue(this.plugin.settings.customWelcomeEnabled).onChange(async (value) => {
          this.plugin.settings.customWelcomeEnabled = value;
          await this.plugin.saveSettings(true);
          this.plugin.getCodexView()?.refreshPersonalizationUi();
          this.scheduleDisplay();
        });
      }));
    if (this.plugin.settings.customWelcomeEnabled) {
      applySettingsRow(new OriginSetting(group)
        .setName(this.copy.general.welcomeTitle)
        .setDesc(this.copy.general.welcomeTitleDesc)
        .addOriginText((text) => {
          text
            .setValue(this.plugin.settings.customWelcomeTitle)
            .setPlaceholder("What's new?")
            .onChange(async (value) => {
              this.plugin.settings.customWelcomeTitle = value;
              await this.plugin.saveSettings(true);
              this.plugin.getCodexView()?.refreshPersonalizationUi();
            });
          text.inputEl.maxLength = 80;
          text.inputEl.setAttr("aria-label", this.copy.general.welcomeTitle);
        }));
      applySettingsRow(new OriginSetting(group)
        .setName(this.copy.general.welcomeGreeting)
        .setDesc(this.copy.general.welcomeGreetingDesc)
        .addOriginText((text) => {
          text
            .setValue(this.plugin.settings.customWelcomeSubtitle)
            .setPlaceholder("当前 Conversation 需要先选择工作区；添加笔记只作为本轮上下文。")
            .onChange(async (value) => {
              this.plugin.settings.customWelcomeSubtitle = value;
              await this.plugin.saveSettings(true);
              this.plugin.getCodexView()?.refreshPersonalizationUi();
            });
          text.inputEl.maxLength = 240;
          text.inputEl.setAttr("aria-label", this.copy.general.welcomeGreeting);
        }));
    }

  }

  private renderAboutSection(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const version = this.plugin.manifest.version ?? "unknown";

    const section = createSettingsSection(page, {
      title: zh ? "关于 EchoInk" : "About EchoInk",
      surface: "group"
    });
    const group = createSettingsGroup(section);

    // --- Plugin info card ---
    const card = group.createDiv({ cls: "echoink-about-card" });

    // Logo + name + version
    const header = card.createDiv({ cls: "echoink-about-header" });
    const logoWrap = createOriginButton(header, {
      cls: "echoink-about-logo",
      attr: { type: "button", "aria-label": "EchoInk Agent" }
    });
    setIcon(logoWrap, "feather");
    logoWrap.addEventListener("click", (event) => {
      if (this.plugin.developerMode.click(event.altKey)) this.renderSettingsContent();
    });
    const nameArea = header.createDiv({ cls: "echoink-about-name-area" });
    nameArea.createDiv({ cls: "echoink-about-name", text: "EchoInk Agent" });
    nameArea.createDiv({ cls: "echoink-about-version", text: `v${version}` });

    // Description
    card.createDiv({
      cls: "echoink-about-desc",
      text: zh
        ? "EchoInk 是一个 Obsidian 本地 AI 插件，让 Agent 拥有长期记忆、可演化的人格和知识库能力。所有数据留在你的 Vault 里，不上传任何云端。"
        : "EchoInk is a local Obsidian AI plugin that gives your Agent long-term memory, evolving personality, and knowledge base capabilities. All data stays in your Vault — nothing is uploaded to the cloud."
    });

    // Philosophy
    const philosophy = card.createDiv({ cls: "echoink-about-philosophy" });
    philosophy.createDiv({
      cls: "echoink-about-philosophy-title",
      text: zh ? "设计理念" : "Philosophy"
    });
    const principles = zh
      ? [
          "真实高于迎合 — Agent 不会为了讨好你而隐藏风险或伪造确定性",
          "记忆属于用户 — 所有记忆存在本地 Vault，你可随时查看、纠正、删除",
          "人格缓慢演化 — 不是你说一次就改，而是从对话和记忆中逐渐校准",
          "克制而非全能 — 只做该做的事，轻微变化保持安静"
        ]
      : [
          "Truth over flattery — Agent won't hide risks or fake certainty to please you",
          "Memory belongs to you — all memories live in your local Vault, always inspectable",
          "Personality evolves slowly — calibrated from conversations and memories, not instant overrides",
          "Restraint over omnipotence — does what's needed, stays quiet on minor changes"
        ];
    for (const p of principles) {
      const item = philosophy.createDiv({ cls: "echoink-about-principle" });
      item.createSpan({ cls: "echoink-about-principle-dot" });
      item.createSpan({ cls: "echoink-about-principle-text", text: p });
    }

    // --- Action buttons row ---
    const actions = card.createDiv({ cls: "echoink-about-actions" });

    // Star on GitHub button (sparkle animation)
    const starBtn = actions.createEl("a", {
      cls: "echoink-about-btn echoink-about-btn-surface echoink-about-btn-star",
      attr: {
        href: "https://github.com/AKin-lvyifang/codex-echoink",
        target: "_blank",
        rel: "noopener noreferrer"
      }
    });
    const starIconWrap = starBtn.createSpan({ cls: "echoink-sparkle-icon-wrap" });
    // Default icon: GitHub
    const githubIcon = starIconWrap.createSpan({ cls: "echoink-sparkle-icon-default" });
    appendAboutSvg(githubIcon, {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "currentColor"
    }, [
      "M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"
    ]);
    // Hover icon: Star (hidden by default)
    const starIcon = starIconWrap.createSpan({ cls: "echoink-sparkle-icon-hover" });
    appendAboutSvg(starIcon, {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "currentColor",
      class: "echoink-star-yellow"
    }, [
      "M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"
    ]);
    // Sparkle particles (appear on hover)
    const sparkle1 = starIconWrap.createSpan({ cls: "echoink-sparkle-particle echoink-sparkle-p1" });
    appendAboutSvg(sparkle1, {
      width: "8",
      height: "8",
      viewBox: "0 0 24 24",
      fill: "currentColor"
    }, [
      "M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"
    ]);
    const sparkle2 = starIconWrap.createSpan({ cls: "echoink-sparkle-particle echoink-sparkle-p2" });
    appendAboutSvg(sparkle2, {
      width: "6",
      height: "6",
      viewBox: "0 0 24 24",
      fill: "currentColor"
    }, [
      "M12 2l2.4 7.6H22l-6.2 4.5 2.4 7.6-6.2-4.5-6.2 4.5 2.4-7.6L2 9.6h7.6z"
    ]);
    starBtn.createSpan({ cls: "echoink-about-btn-label", text: "Star on GitHub" });

    // Issues link (amicro btn-24: Send morphs into Check on hover/focus)
    const issuesBtn = actions.createEl("a", {
      cls: "echoink-about-btn echoink-about-btn-surface echoink-about-btn-issue",
      attr: {
        href: "https://github.com/AKin-lvyifang/codex-echoink/issues",
        target: "_blank",
        rel: "noopener noreferrer"
      }
    });
    const issueIconWrap = issuesBtn.createSpan({ cls: "echoink-about-morph-icon-wrap" });
    const issueSendIcon = issueIconWrap.createSpan({ cls: "echoink-about-morph-icon-default" });
    appendAboutSvg(issueSendIcon, {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    }, [
      "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
      "m21.854 2.147-10.94 10.939"
    ]);
    const issueCheckIcon = issueIconWrap.createSpan({ cls: "echoink-about-morph-icon-hover" });
    appendAboutSvg(issueCheckIcon, {
      width: "16",
      height: "16",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    }, [
      "M20 6 9 17l-5-5"
    ]);
    issuesBtn.createSpan({
      cls: "echoink-about-btn-label",
      text: zh ? "反馈问题" : "Report Issue"
    });
  }
  /**
   * Agent Profile is a read-only projection of AGENT.md/current-self. The UI
   * receives no full AGENT.md content and exposes no numeric personality state.
   */
  private addAgentProfileCard(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const state = this.personalMemoryState!;
    const profile = state.agentProfile;
    const readyProfile = profile.kind === "ready" ? profile : null;
    const identity = state.agentIdentity;
    const ready = readyProfile !== null;
    const selectedTemplateId = readyProfile?.templateId ?? null;
    const pickerId = "echoink-agent-template-picker";
    const pickerTriggerId = `${pickerId}-trigger`;
    const profileCardTitleId = "echoink-agent-profile-card-title";
    const profileContentTitleId = "echoink-agent-profile-content-title";
    const currentSectionTitleId = "echoink-agent-profile-current-title";
    const growthSectionTitleId = "echoink-agent-profile-growth-title";
    const collapsedTemplateLabel = !ready
      ? (zh ? "重新读取人格" : "Reload profile")
      : readyProfile.templateId
        ? (zh ? "重新选择人格模板" : "Choose another template")
        : (zh ? "选择人格模板" : "Choose a template");
    const expandedTemplateLabel = zh ? "收起人格模板" : "Hide personality templates";
    const card = container.createEl("section", {
      cls: "echoink-agent-profile-card",
      attr: { "aria-labelledby": profileCardTitleId }
    });
    card.dataset.profileState = ready ? "ready" : "error";

    const header = card.createDiv({ cls: "echoink-agent-profile-card-header" });
    const profileCardHeading = new OriginSetting(header)
      .setName(zh ? "Agent 画像" : "Agent profile")
      .setHeading();
    profileCardHeading.settingEl.addClass("echoink-agent-profile-heading-row");
    profileCardHeading.nameEl.addClass("echoink-agent-profile-card-label");
    profileCardHeading.nameEl.setAttr("id", profileCardTitleId);
    profileCardHeading.nameEl.setAttr("role", "heading");
    profileCardHeading.nameEl.setAttr("aria-level", "4");
    const templateBtn = createOriginButton(header, {
      cls: "echoink-agent-profile-reselect",
      attr: {
        type: "button",
        "data-echoink-focus-key": "general:personality-template",
        ...(ready ? {
          id: pickerTriggerId,
          "aria-expanded": "false",
          "aria-controls": pickerId
        } : {})
      }
    });
    if (ready) {
      templateBtn.addClass("is-disclosure");
      templateBtn.dataset.templateId = readyProfile.templateId ?? "";
      const usersIcon = templateBtn.createSpan({ cls: "echoink-agent-profile-template-icon" });
      renderAnimateIcon(usersIcon, "users");
    } else {
      templateBtn.dataset.failClosed = "true";
    }
    const templateLabel = templateBtn.createSpan({
      cls: "echoink-agent-profile-template-label",
      text: collapsedTemplateLabel
    });
    if (ready) {
      const chevron = templateBtn.createSpan({
        cls: "echoink-agent-profile-template-chevron",
        attr: { "aria-hidden": "true" }
      });
      setIcon(chevron, "chevron-down");
    }

    const body = card.createDiv({ cls: "echoink-agent-profile-card-body" });
    const identitySide = body.createDiv({ cls: "echoink-agent-profile-identity" });
    const selectedTemplate = ready
      ? AGENT_TEMPLATES.find((template) => template.id === readyProfile.templateId) ?? null
      : null;
    const avatarEl = identitySide.createDiv({ cls: "echoink-agent-profile-avatar" });
    const avatarUrl = resolveAgentAvatarUrl(identity.avatar);
    if (avatarUrl) {
      const image = avatarEl.createEl("img", {
        attr: { src: avatarUrl, alt: "" }
      });
      image.addEventListener("error", () => {
        image.remove();
        avatarEl.addClass("is-default");
        setIcon(avatarEl, "bot");
      }, { once: true });
    } else {
      avatarEl.addClass("is-default");
      setIcon(avatarEl, "bot");
    }
    const nameRow = identitySide.createDiv({ cls: "echoink-agent-profile-name-row" });
    nameRow.createDiv({ cls: "echoink-agent-profile-name", text: identity.displayName });
    identitySide.createDiv({
      cls: "echoink-agent-profile-personality",
      text: ready
        ? selectedTemplate ? (zh ? selectedTemplate.labelZh : selectedTemplate.labelEn) : (zh ? "尚未选择" : "Not selected")
        : (zh ? "人格读取失败" : "Profile unavailable")
    });
    const editIdentityLabel = !selectedTemplateId
      ? (zh ? "选择风格并设置身份" : "Choose a style and set identity")
      : (zh ? "编辑 Agent 身份" : "Edit Agent identity");
    const editIdentityBtn = ready
      ? createOriginButton(identitySide, {
          cls: "echoink-agent-identity-edit text-button",
          attr: {
            type: "button",
            "aria-label": editIdentityLabel
          }
        })
      : null;
    if (editIdentityBtn) {
      setTooltip(editIdentityBtn, editIdentityLabel, { placement: "top" });
      const editIcon = editIdentityBtn.createSpan();
      renderAnimateIcon(editIcon, "user-round-pen");
      editIdentityBtn.createSpan({ text: selectedTemplateId ? (zh ? "编辑身份" : "Edit identity") : editIdentityLabel });
    }
    if (ready && selectedTemplate?.preferredSkillIds.length) {
      const methods = identitySide.createDiv({ cls: "echoink-agent-profile-methods" });
      methods.createDiv({
        cls: "echoink-agent-profile-methods-label",
        text: zh ? "风格默认携带的 Skills" : "Skills included with this style"
      });
      const methodTags = methods.createDiv({ cls: "echoink-agent-profile-method-tags" });
      for (const skillId of selectedTemplate?.preferredSkillIds ?? []) {
        methodTags.createSpan({ cls: "echoink-agent-profile-method-tag", text: zh ? (BUILTIN_SKILLS.find((skill) => skill.id === skillId)?.title ?? skillId) : skillId.replace(/-/g, " "), attr: { title: skillId } });
      }
    }

    const contentSide = body.createEl("section", {
      cls: "echoink-agent-profile-content",
      attr: { "aria-labelledby": profileContentTitleId }
    });
    const profileContentHeading = new OriginSetting(contentSide)
      .setName(zh ? "我的公开画像" : "My public profile")
      .setHeading();
    profileContentHeading.settingEl.addClass("echoink-agent-profile-heading-row");
    profileContentHeading.nameEl.addClass("echoink-agent-profile-content-title");
    profileContentHeading.nameEl.setAttr("id", profileContentTitleId);
    profileContentHeading.nameEl.setAttr("role", "heading");
    profileContentHeading.nameEl.setAttr("aria-level", "5");
    contentSide.createEl("p", { cls: "general-growth-description", text: zh
      ? "伴随聊天和记忆整理，Agent 会持续更新这份画像，逐步调整自己的处事方式。"
      : "Through conversations and memory consolidation, the Agent updates this profile and gradually adjusts how it works with you." });
    if (ready) {
      const currentSection = contentSide.createEl("section", {
        cls: "echoink-agent-profile-section is-current",
        attr: { "aria-labelledby": currentSectionTitleId }
      });
      const currentSectionHeading = new OriginSetting(currentSection)
        .setName(zh ? "当前方式" : "How I work now")
        .setHeading();
      currentSectionHeading.settingEl.addClass("echoink-agent-profile-heading-row");
      currentSectionHeading.nameEl.addClass("echoink-agent-profile-section-title");
      currentSectionHeading.nameEl.setAttr("id", currentSectionTitleId);
      currentSectionHeading.nameEl.setAttr("role", "heading");
      currentSectionHeading.nameEl.setAttr("aria-level", "6");
      const currentFields = currentSection.createEl("dl", { cls: "echoink-agent-profile-current-fields" });
      const fields = [
        [zh ? "思考方式" : "Thinking", readyProfile.currentSelf.thinkingMethod],
        [zh ? "回答语气" : "Answer tone", readyProfile.currentSelf.answerTone],
        [zh ? "回答结构" : "Answer structure", readyProfile.currentSelf.answerStructure]
      ] as const;
      for (const [label, value] of fields) {
        const field = currentFields.createDiv({ cls: "echoink-agent-profile-field" });
        field.createEl("dt", { cls: "echoink-agent-profile-field-label", text: label });
        field.createEl("dd", { cls: "echoink-agent-profile-field-value", text: value });
      }

      const growthSection = contentSide.createEl("section", {
        cls: "echoink-agent-profile-section is-growth",
        attr: { "aria-labelledby": growthSectionTitleId }
      });
      const growthSectionHeading = new OriginSetting(growthSection)
        .setName(zh ? "长期成长" : "Long-term growth")
        .setHeading();
      growthSectionHeading.settingEl.addClass("echoink-agent-profile-heading-row");
      growthSectionHeading.nameEl.addClass("echoink-agent-profile-section-title");
      growthSectionHeading.nameEl.setAttr("id", growthSectionTitleId);
      growthSectionHeading.nameEl.setAttr("role", "heading");
      growthSectionHeading.nameEl.setAttr("aria-level", "6");
      if (readyProfile.currentSelf.representativeHabits.length > 0) {
        const habitList = growthSection.createEl("ul", { cls: "echoink-agent-profile-habit-list" });
        for (const habit of readyProfile.currentSelf.representativeHabits) {
          habitList.createEl("li", { cls: "echoink-agent-profile-habit", text: habit });
        }
      } else {
        growthSection.createEl("p", {
          cls: "echoink-agent-profile-growth-empty",
          text: zh
            ? "我们还没有形成需要长期展示的相处习惯。"
            : "We have not formed any long-term habits to show here yet."
        });
      }
      growthSection.createEl("p", {
        cls: "echoink-agent-profile-growth-note",
        text: zh
          ? "我会随着与你的长期对话持续学习，逐步调整自己的处事方式。"
          : "I keep learning through our long-term conversations and gradually adjust how I work with you."
      });
    } else {
      contentSide.createEl("p", {
        cls: "echoink-agent-profile-error",
        text: zh
          ? "当前人格无法读取。现有数据不会被覆盖，请重新读取。"
          : "The current profile could not be read. Existing data was not overwritten; reload to try again."
      });
    }

    const pickerPanel = card.createDiv({
      cls: "echoink-template-picker general-template-picker",
      attr: ready ? {
        id: pickerId,
        "aria-labelledby": pickerTriggerId
      } : {}
    });
    const refs: AgentProfileCardRefs = {
      templateBtn,
      templateLabel,
      pickerPanel,
      collapsedTemplateLabel,
      expandedTemplateLabel
    };

    templateBtn.onclick = () => {
      if (!ready) {
        void this.loadPersonalMemoryState(true);
        return;
      }
      if (pickerPanel.hasClass("is-visible")) {
        this.closeTemplatePicker(refs);
        return;
      }
      this.showTemplatePicker(refs, zh);
    };

    if (editIdentityBtn) editIdentityBtn.onclick = () => {
      if (!selectedTemplateId) {
        this.startInitialIdentitySetup();
        return;
      }
      const modal = new AgentIdentityModal(this.plugin.app, {
        initialName: identity.displayName,
        initialAvatar: identity.avatar,
        language: zh ? "zh" : "en",
        mode: "edit",
        presets: AGENT_AVATAR_PRESETS,
        onConfirm: async (draft) => {
          const system = await this.plugin.getCognitiveSystem();
          await system.updateAgentIdentity({
            displayName: draft.displayName,
            avatar: draft.avatar
          });
          await this.refreshIdentityAfterChange();
          new Notice(zh ? "Agent 身份已更新" : "Agent identity updated");
        }
      });
      this.openInlineEditor(modal, "general");
    };
  }

  private showTemplatePicker(refs: AgentProfileCardRefs, zh: boolean): void {
    const panel = refs.pickerPanel;
    disposeOriginControls(panel);
    panel.empty();
    panel.addClass("is-visible");
    this.setTemplatePickerExpanded(refs, true);
    panel.onkeydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const rows = Array.from(panel.querySelectorAll<HTMLButtonElement>(".echoink-picker-row"));
        const index = rows.indexOf(panel.ownerDocument.activeElement as HTMLButtonElement);
        if (index >= 0) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
          rows[next]?.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.closeTemplatePicker(refs);
    };

    const intro = panel.createDiv({ cls: "echoink-picker-intro" });
    const introText = intro.createDiv({ cls: "echoink-picker-intro-text" });
    introText.createDiv({
      cls: "echoink-picker-intro-title",
      text: zh ? "选择 Agent 的初始风格" : "Choose the Agent's starting style"
    });
    introText.createDiv({
      cls: "echoink-picker-intro-copy",
      text: zh
        ? "只调整基础风格，长期形成的习惯会保留。关闭或取消不会产生修改。"
        : "Only the base style changes; learned habits are preserved. Closing or cancelling makes no changes."
    });
    intro.createDiv({
      cls: "echoink-picker-count",
      text: zh ? `${AGENT_TEMPLATES.length} 种风格` : `${AGENT_TEMPLATES.length} styles`
    });

    const list = panel.createDiv({ cls: "echoink-picker-list general-template-grid" });
    const currentTemplateId = refs.templateBtn.dataset.templateId ?? "";
    let firstRow: HTMLElement | null = null;
    let currentRow: HTMLElement | null = null;
    for (const template of AGENT_TEMPLATES) {
      const isCurrent = currentTemplateId === template.id;
      const row = createOriginButton(list, {
        cls: "echoink-picker-row general-template",
        attr: {
          type: "button",
          "data-template-id": template.id,
          ...(isCurrent ? { "aria-current": "true" } : {})
        }
      });
      firstRow ??= row;
      if (isCurrent) currentRow = row;
      row.classList.toggle("is-current", isCurrent);
      const heading = row.createEl("strong", { cls: "echoink-picker-row-heading" });
      heading.createSpan({
        cls: "echoink-picker-row-name",
        text: zh ? template.labelZh : template.labelEn
      });
      if (isCurrent) {
        heading.createSpan({
          cls: "echoink-picker-current-badge settings-badge",
          text: zh ? "当前模板" : "Current"
        });
      }
      row.createEl("p", {
        cls: "echoink-picker-row-desc",
        text: template.complexProblemMethod
      });
      const indicator = row.createSpan({
        cls: "echoink-picker-row-indicator",
        attr: { "aria-hidden": "true" }
      });
      setIcon(indicator, "arrow-up-right");

      row.onclick = () => {
        row.setAttr("disabled", "true");
        void (async () => {
          try {
            const system = await this.plugin.getCognitiveSystem();
            const snapshot = await system.readAgentSelfState();
            const identity = await system.readAgentIdentity();
            const selection = initialTemplateSelectionStatus(snapshot.metadata, identity);
            if (selection.requiresFirstNaming) {
              row.removeAttribute("disabled");
              this.openAgentIdentityModal({
                templateId: template.id,
                templateLabel: zh ? template.labelZh : template.labelEn,
                panel,
                refs,
                zh
              });
              return;
            }
            await system.selectPersonalityTemplate(template.id);
            this.requestPersonalityTemplateFocusRestore();
            await this.refreshIdentityAfterChange();
            new Notice(zh
              ? `已应用「${template.labelZh}」人格模板`
              : `Applied template: ${template.labelEn}`);
            this.closeTemplatePicker(refs);
          } catch (error) {
            console.error("EchoInk personality template selection failed", error);
            new Notice(zh ? "人格模板保存失败，请重试" : "Failed to save personality template");
          } finally {
            row.removeAttribute("disabled");
          }
        })();
      };
    }

    const cancelRow = panel.createDiv({ cls: "echoink-picker-cancel-row" });
    const cancelBtn = createOriginButton(cancelRow, {
      cls: "echoink-picker-cancel-btn",
      text: zh ? "取消" : "Cancel",
      attr: { type: "button" }
    });
    cancelBtn.onclick = () => {
      this.closeTemplatePicker(refs);
    };

    (currentRow ?? firstRow)?.focus({ preventScroll: true });
  }

  private closeTemplatePicker(refs: AgentProfileCardRefs): void {
    if (!refs.templateBtn.isConnected || !refs.pickerPanel.isConnected) return;
    refs.pickerPanel.removeClass("is-visible");
    disposeOriginControls(refs.pickerPanel);
    refs.pickerPanel.empty();
    refs.pickerPanel.onkeydown = null;
    this.setTemplatePickerExpanded(refs, false);
    refs.templateBtn.focus({ preventScroll: true });
  }

  private setTemplatePickerExpanded(refs: AgentProfileCardRefs, expanded: boolean): void {
    refs.templateBtn.setAttr("aria-expanded", expanded ? "true" : "false");
    refs.templateBtn.classList.toggle("is-expanded", expanded);
    refs.templateLabel.textContent = expanded
      ? refs.expandedTemplateLabel
      : refs.collapsedTemplateLabel;
  }

  private openAgentIdentityModal(context: Readonly<{
    templateId: string;
    templateLabel: string;
    panel: HTMLElement;
    refs: AgentProfileCardRefs;
    zh: boolean;
  }>): void {
    const { templateId, templateLabel, panel, refs, zh } = context;
    let confirmed = false;
    const modal = new AgentIdentityModal(this.plugin.app, {
      initialName: "",
      initialAvatar: Object.freeze({ kind: "default" }),
      language: zh ? "zh" : "en",
      mode: "first-run",
      presets: AGENT_AVATAR_PRESETS,
      onConfirm: async (draft) => {
        const system = await this.plugin.getCognitiveSystem();
        await system.selectPersonalityTemplate(templateId, {
          initialIdentity: { displayName: draft.displayName, avatar: draft.avatar }
        });
        confirmed = true;
        this.requestPersonalityTemplateFocusRestore();
        await this.refreshIdentityAfterChange();
        new Notice(zh
          ? `已应用「${templateLabel}」人格模板，Agent 名称：${draft.displayName}`
          : `Applied template: ${templateLabel}. Agent name: ${draft.displayName}`);
        this.closeTemplatePicker(refs);
      }
    });
    this.openInlineEditor(modal, "general", () => {
      if (!confirmed) this.startInitialIdentitySetup();
    });
  }

  private async refreshIdentityAfterChange(): Promise<void> {
    await this.loadPersonalMemoryState(true);
    this.plugin.getCodexView()?.refreshPersonalizationUi();
  }

  private startInitialIdentitySetup(): void {
    const templateEntry = this.containerEl.querySelector<HTMLElement>(
      '[data-echoink-focus-key="general:personality-template"]'
    );
    if (!templateEntry) return;
    templateEntry.scrollIntoView({ block: "center", inline: "nearest" });
    templateEntry.click();
    const picker = this.containerEl.querySelector<HTMLElement>(
      ".echoink-template-picker.is-visible"
    );
    if (!picker) return;
    picker.scrollIntoView({ block: "center", inline: "nearest" });
    const firstRow = picker.querySelector<HTMLElement>(".echoink-picker-row");
    (firstRow ?? picker).focus({ preventScroll: true });
  }

  /** USER.md is maintained by dreaming / memory corrections — read-only here. */
  private addReadOnlyUserProfileCard(container: HTMLElement, userContent: string): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const card = container.createDiv({ cls: "echoink-agent-profile-card" });
    const header = card.createDiv({ cls: "echoink-agent-profile-card-header" });
    const titleArea = header.createDiv({ cls: "echoink-agent-profile-card-title-area" });
    titleArea.createDiv({ cls: "echoink-agent-profile-card-label", text: zh ? "用户画像" : "User profile" });
    titleArea.createSpan({
      cls: "echoink-agent-profile-card-badge",
      text: zh ? "持续了解你" : "Keeps learning about you"
    });
    header.createDiv({
      cls: "echoink-agent-profile-card-desc",
      text: zh
        ? "EchoInk 会从聊天和记忆整理中持续了解你，自动更新这份画像。"
        : "EchoInk keeps learning about you through conversations and memory consolidation, and updates this profile automatically."
    });
    const pre = card.createEl("pre", {
      cls: "echoink-user-profile-text",
      text: userContent
    });
    pre.setAttr("tabindex", "0");
  }

  /** 知识库初始化体验的唯一挂载点；渲染与状态都在 KnowledgeInitializationSection 内。 */
  private mountKnowledgeInitializationSection(page: HTMLElement, zh: boolean): void {
    if (!this.knowledgeInitSection) {
      this.knowledgeInitSection = new KnowledgeInitializationSection(
        this.plugin,
        () => this.scheduleDisplay(),
        () => this.activateSettingsTab("providers", true)
      );
    }
    this.knowledgeInitSection.render(page, zh);
  }

  private mountKnowledgeDashboard(page: HTMLElement, zh: boolean): void {
    if (!this.knowledgeInitSection?.showDashboard) {
      this.knowledgeDashboardEl = null;
      page.createEl("p", { cls: "init-awaiting", text: zh
        ? "初始化后，这里会展示知识库状态与统计。"
        : "Knowledge status and statistics will appear here after initialization." });
      return;
    }
    const section = createSettingsSection(page, {
      surface: "flat"
    });
    this.knowledgeDashboardEl = section.createDiv({
      cls: "settings-knowledge-dashboard"
    });
    this.renderKnowledgeSettingsDashboard();
    if (!this.knowledgeDashboardSnapshot && !this.knowledgeDashboardLoading) {
      void this.refreshKnowledgeSettingsDashboard();
    }
  }

  private renderKnowledgeSettingsDashboard(): void {
    const container = this.knowledgeDashboardEl;
    if (!container) return;
    const manager = this.plugin.getKnowledgeSurfaceService?.();
    const recovery = manager?.maintenanceRecoveryStatus ?? {
      state: "ready" as const,
      message: ""
    };
    renderSettingsKnowledgeDashboard(
      container,
      {
        language: this.plugin.settings.settingsLanguage,
        visible: true,
        snapshot: this.knowledgeDashboardSnapshot,
        expanded: this.knowledgeDashboardExpanded,
        loading: this.knowledgeDashboardLoading,
        error: this.knowledgeDashboardError,
        recovery
      },
      {
        onRefresh: () => void this.refreshKnowledgeSettingsDashboard(true),
        onOpenHistory: () => this.openSettingsDetail("knowledge-maintenance-history"),
        onOpenRaw: () => void this.openKnowledgeRawFolder(),
        onToggleExpanded: () => {
          this.knowledgeDashboardExpanded = !this.knowledgeDashboardExpanded;
          this.renderKnowledgeSettingsDashboard();
        }
      }
    );
  }

  private async openKnowledgeRawFolder(): Promise<void> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const folder = this.app.vault.getAbstractFileByPath("raw");
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf?.view as (typeof leaf.view & { revealInFolder?: (folder: TFolder) => void | Promise<void> }) | undefined;
    if (!folder || folder instanceof TFile || !leaf || !view?.revealInFolder) {
      new Notice(zh ? "请在文件列表中打开 Raw 目录。" : "Open the Raw folder in the file explorer.");
      return;
    }
    try {
      await view.revealInFolder(folder as TFolder);
      await this.app.workspace.revealLeaf(leaf);
      (this.app as unknown as { setting?: { close: () => void } }).setting?.close();
    } catch {
      new Notice(zh ? "Raw 目录未能打开，请从文件列表重试。" : "The Raw folder could not open. Retry from the file explorer.");
    }
  }

  private async refreshKnowledgeSettingsDashboard(force = false): Promise<void> {
    if (this.knowledgeDashboardLoading && !force) return;
    const manager = this.plugin.getKnowledgeSurfaceService?.();
    if (!manager) {
      this.knowledgeDashboardError = this.plugin.settings.settingsLanguage === "en"
        ? "Knowledge status is not ready yet."
        : "知识库状态服务尚未就绪。";
      this.renderKnowledgeSettingsDashboard();
      return;
    }
    const requestId = ++this.knowledgeDashboardRequestId;
    this.knowledgeDashboardLoading = true;
    this.knowledgeDashboardError = "";
    this.renderKnowledgeSettingsDashboard();
    try {
      const snapshot = await manager.getDashboardSnapshot();
      if (requestId !== this.knowledgeDashboardRequestId) return;
      this.knowledgeDashboardSnapshot = snapshot;
    } catch (error) {
      if (requestId !== this.knowledgeDashboardRequestId) return;
      this.knowledgeDashboardError = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === this.knowledgeDashboardRequestId) {
        this.knowledgeDashboardLoading = false;
        this.renderKnowledgeSettingsDashboard();
      }
    }
  }

  private renderKnowledgeMaintenanceHistory(page: HTMLElement, zh: boolean): void {
    const section = createSettingsSection(page, {
      title: zh ? "维护日志" : "Maintenance log",
      surface: "flat"
    });
    section.addClass("standard-section");
    const group = createSettingsGroup(section);
    group.addClass("settings-card");
    const count = this.plugin.settings.knowledgeBase.maintenanceHistory.length;
    createSettingsNavigationRow(group, {
      title: zh ? "维护日志" : "Maintenance log",
      description: zh
        ? "打开完整记录，按日期查看每次知识维护。"
        : "Open the complete history and view Knowledge maintenance by date.",
      value: zh
        ? `${count} 条记录`
        : `${count} ${count === 1 ? "record" : "records"}`,
      actionLabel: zh ? "查看" : "View",
      focusKey: "knowledge:maintenance-history",
      onActivate: () => this.openSettingsDetail("knowledge-maintenance-history")
    });
  }

  private renderKnowledgeMaintenanceHistoryDetail(container: HTMLElement, zh: boolean): void {
    const page = createSettingsPage(container, {
      title: zh ? "维护日志" : "Maintenance log",
      description: zh
        ? "每次维护都沿用现有记录；打开报告可查看本轮新增、移动与提炼明细。"
        : "Each run uses the existing history. Open its report to inspect added, moved, and refined items.",
      detail: true,
      backLabel: zh ? "返回知识库" : "Back to Knowledge",
      onBack: () => void this.closeSettingsDetail()
    });
    page.addClass("echoink-maintenance-history-page");
    const selectedDate = this.knowledgeMaintenanceHistoryDate;
    const filter = page.createDiv({ cls: "history-filter" });
    const filterLabel = zh ? "维护日志日期筛选" : "Maintenance log date filter";
    filter.createSpan({ text: zh ? "按日期筛选" : "Filter by date" });
    const date = createOriginInput(filter, { attr: {
      type: "date", "aria-label": filterLabel,
      "data-echoink-focus-key": "knowledge:maintenance-history:date"
    } });
    date.value = selectedDate;
    date.onchange = () => {
      this.knowledgeMaintenanceHistoryDate = date.value;
      this.scheduleDisplay();
    };
    const clear = createOriginButton(filter, { cls: "text-button", text: zh ? "清除" : "Clear", attr: {
      type: "button", "aria-label": zh ? "清除日期筛选" : "Clear date filter",
      "data-echoink-focus-key": "knowledge:maintenance-history:clear"
    } });
    clear.disabled = !selectedDate;
    clear.onclick = () => {
      this.knowledgeMaintenanceHistoryDate = "";
      this.settingsFocusIntent = "explicit:knowledge:maintenance-history:date";
      this.scheduleDisplay();
    };
    const group = createSettingsGroup(page);
    const allEntries = [...this.plugin.settings.knowledgeBase.maintenanceHistory]
      .sort((left, right) => right.at - left.at || right.date.localeCompare(left.date));
    if (!allEntries.length) {
      filter.createSpan({ cls: "history-count", text: zh ? "0 条记录" : "0 records" });
      this.renderHistoryEmpty(group, zh ? "还没有知识库维护记录" : "No Knowledge maintenance runs yet", zh ? "完成维护后，记录和报告会显示在这里。" : "Records and reports will appear here after maintenance.");
      return;
    }
    const entries = selectedDate
      ? allEntries.filter((entry) => entry.date === selectedDate)
      : allEntries;
    filter.createSpan({ cls: "history-count", text: zh ? `${entries.length} 条记录` : `${entries.length} records` });
    if (!entries.length) {
      this.renderHistoryEmpty(group, zh ? "所选日期没有维护记录" : "No maintenance runs on this date", zh ? "选择另一个日期，或清除筛选查看全部记录。" : "Choose another date or clear the filter to see all records.");
      return;
    }
    for (const entry of entries) {
      const row = new OriginSetting(group)
        .setName(knowledgeMaintenanceHistoryTitle(entry, zh))
        .setDesc(knowledgeMaintenanceHistoryDescription(entry, zh));
      if (entry.reportPath) {
        row.addOriginButton((button) => {
          const label = zh ? "查看明细" : "View details";
          button
            .setButtonText(label)
            .onClick(() => void this.openKnowledgeMaintenanceReport(entry.reportPath));
          button.buttonEl.setAttr(
            "aria-label",
            `${label} ${knowledgeMaintenanceHistoryTitle(entry, zh)}`
          );
        });
      }
      applySettingsRow(row);
    }
  }

  private renderHistoryEmpty(container: HTMLElement, title: string, description: string): void {
    const empty = container.createDiv({ cls: "settings-empty history-empty" });
    setIcon(empty.createSpan({ cls: "history-empty-icon" }), "history");
    empty.createDiv({ cls: "settings-empty-title", text: title, attr: { role: "heading", "aria-level": "3" } });
    empty.createEl("p", { text: description });
  }

  private async openKnowledgeMaintenanceReport(relativePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(relativePath));
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
      return;
    }
    new Notice(this.plugin.settings.settingsLanguage === "en"
      ? `The report was not found in this Vault: ${relativePath}`
      : `当前 Vault 中没有找到维护报告：${relativePath}`);
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void {
    const copy = this.copy;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    if (this.settingsDetail === "knowledge-maintenance-history") {
      this.renderKnowledgeMaintenanceHistoryDetail(container, zh);
      return;
    }
    if (this.settingsDetail === "knowledge-preferences") {
      this.renderKnowledgeMaintenancePreferences(container);
      return;
    }

    if (
      !this.knowledgePreferenceState
      && !this.knowledgePreferenceLoading
      && !this.knowledgePreferenceLoadError
    ) void this.loadKnowledgePreferenceState();

    const page = createSettingsPage(container, {
      title: copy.knowledge.title,
      description: zh
        ? "/ask 先查知识库，有依据时展示 Sources；最终没有找到时会说明，并按需使用已有外部资料或模型知识补答。/maintain 用于整理资料。是否写入由会话底部的工作区选项和你的要求决定：只读可分析，可写时按现有流程执行并核对结果。"
        : "Use /ask to search your knowledge base first and show Sources when evidence is found. If none is found, EchoInk says so and may use available external sources or model knowledge. Use /maintain to organize material. Writing follows the workspace option below the conversation and your request: read-only allows analysis; writable modes use the existing workflow and verify results."
    });
    page.addClass("codex-knowledge-settings");
    this.renderSettingsActionError(page, "knowledge");

    this.mountKnowledgeInitializationSection(page, zh);
    this.mountKnowledgeDashboard(page, zh);

    const runSection = createSettingsSection(page, {
      title: zh ? "模型" : "Model",
      surface: "flat"
    });
    runSection.addClass("standard-section");
    const runGroup = createSettingsGroup(runSection);
    runGroup.addClass("settings-card");
    const availableTargets = this.plugin.settings.apiProviders.flatMap(
      (provider) => apiProviderHasUsableCredential(
        provider,
        this.plugin.settings.openAICodexCredential
      )
        ? provider.models.map((model) => ({ provider, model }))
        : []
    );
    const modelSetting = applySettingsRow(new OriginSetting(runGroup)
      .setName(zh ? "EchoInk 当前模型" : "Current EchoInk model")
      .setDesc(zh
        ? "普通聊天、/ask、/maintain 与选区翻译共用这个模型。"
        : "Chat, /ask, /maintain, and selection translation share this model.")
      .addOriginDropdown(this.app, (dropdown) => {
        dropdown.selectEl.setAttr("aria-label", zh ? "EchoInk 当前模型" : "Current EchoInk model");
        if (availableTargets.length === 0) {
          dropdown.addOption("", this.plugin.settings.apiProviders.length === 0
            ? (zh ? "尚无已保存模型" : "No saved models")
            : (zh ? "无可用模型" : "No available models"));
        }
        for (const provider of this.plugin.settings.apiProviders) {
          const credentialReady = apiProviderHasUsableCredential(
            provider,
            this.plugin.settings.openAICodexCredential
          );
          const providerDisplayName = apiProviderConfiguredDisplayName(
            normalizeApiProviderId(
              provider.providerId,
              provider.baseUrl,
              provider.name
            ),
            provider.name,
            this.plugin.settings.settingsLanguage
          );
          for (const model of provider.models) {
            const value = providerModelSelectionValue(provider.id, model.id);
            dropdown.addOption(
              value,
              `${providerDisplayName} · ${model.displayName}${credentialReady ? "" : (
                provider.authMode === "oauth"
                  ? (zh ? "（需要登录）" : " (sign-in required)")
                  : (zh ? "（需重新保存 API Key）" : " (API key required)")
              )}`
            );
            dropdown.setOptionDisabled(value, !credentialReady);
          }
        }
        dropdown
          .setValue(availableTargets.length === 0
            ? ""
            : providerModelSelectionValue(
              this.plugin.settings.activeApiProviderId,
              this.plugin.settings.defaultModel
            ))
          .onChange(async (value) => {
            const selection = parseProviderModelSelectionValue(value);
            if (!selection) return;
            const target = this.plugin.settings.apiProviders.find(
              (provider) => provider.id === selection.providerSettingsId
            );
            if (!target || !apiProviderHasUsableCredential(
              target,
              this.plugin.settings.openAICodexCredential
            ) || !getApiProviderModel(target, selection.modelId)) return;
            try {
              await this.plugin.activateApiProviderSettings((settings) => {
                const candidate = settings.apiProviders.find(
                  (provider) => provider.id === selection.providerSettingsId
                );
                if (!candidate || !apiProviderHasUsableCredential(
                  candidate,
                  settings.openAICodexCredential
                )) {
                  throw new Error("Provider authentication unavailable");
                }
                activateApiProviderModel(settings, candidate, selection.modelId);
              });
              const providerDisplayName = apiProviderConfiguredDisplayName(
                normalizeApiProviderId(
                  target.providerId,
                  target.baseUrl,
                  target.name
                ),
                target.name,
                this.plugin.settings.settingsLanguage
              );
              new Notice(zh
                ? `已切换到 ${providerDisplayName} · ${selection.modelId}`
                : `Now using ${providerDisplayName} · ${selection.modelId}`);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : copy.providers.saveFailed);
            }
            this.scheduleDisplay();
          });
        dropdown.selectEl.disabled = availableTargets.length === 0;
      })
      .addOriginButton((button) => button
        .setButtonText(zh ? "管理模型" : "Manage models")
        .onClick(() => void this.activateSettingsTab("providers", true))));
    modelSetting.settingEl.dataset.echoinkFocusKey = "knowledge:provider";

    this.renderKnowledgeMaintenanceHistory(page, zh);

    const management = createSettingsSection(page, {
      title: zh ? "管理" : "Management",
      surface: "flat"
    });
    management.addClass("standard-section");
    const managementGroup = createSettingsGroup(management);
    managementGroup.addClass("settings-card");
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "调整关注维度、颗粒度、组织、融合和表达；固定六步、权限与安全边界不可编辑。"
        : "Adjust focus, granularity, organization, merging, and style. The fixed six steps and safety boundaries cannot be edited.",
      value: this.knowledgePreferenceLoading
        ? (zh ? "读取中" : "Loading")
        : this.knowledgePreferenceLoadError
          ? (zh ? "读取失败" : "Unavailable")
          : this.knowledgePreferenceState?.state === "custom"
            ? (zh ? "已自定义" : "Customized")
            : (zh ? "使用默认" : "Using default"),
      actionLabel: zh ? "编辑" : "Edit",
      focusKey: "knowledge:preferences",
      onActivate: () => this.openSettingsDetail("knowledge-preferences")
    });
  }

  private renderKnowledgeMaintenancePreferences(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "固定提炼步骤不可编辑；偏好只影响下一次 /maintain。"
        : "The fixed refinement steps cannot be edited. Preferences affect only the next /maintain run.",
      detail: true,
      backLabel: zh ? "返回知识库" : "Back to Knowledge",
      onBack: () => void this.closeSettingsDetail()
    });

    const protocolSection = createSettingsSection(page, {
      title: zh ? "固定提炼步骤" : "Fixed refinement steps",
      description: zh
        ? "EchoInk 始终按以下六步执行，偏好文本不能改变显式命令授权、来源、写入目录或 Raw 保护。"
        : "EchoInk always follows these six steps. Preference text cannot change explicit-command authorization, sources, write targets, or Raw protection.",
      surface: "group"
    });
    const protocolGroup = createSettingsGroup(protocolSection);
    const protocolList = protocolGroup.createEl("ol", {
      cls: "echoink-knowledge-protocol-list"
    });
    const protocolEnglish = [
      ["Lock sources", "Use the named Raw sources, or changed sources in Tracker. Bind paths, original content, attachments, and source versions."],
      ["Understand and break down", "Identify themes, conclusions, evidence, conditions, counterexamples, open questions, and reusable insights."],
      ["Check quality", "Check freshness, conflicts, credibility, and missing information. Keep unsupported judgments separate from source content."],
      ["Compare existing knowledge", "Search Wiki and Projects to decide what to create, extend, deduplicate, or merge."],
      ["Draft candidates", "Draft Markdown in wiki or projects, with clickable source links and exact source-version markers."],
      ["Review, save, and read back", "Check sources, destinations, unchanged Raw files, and candidate completeness before authorized writes and readback."]
    ];
    for (const [index, step] of ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_STEPS.entries()) {
      const item = protocolList.createEl("li", {
        cls: "echoink-knowledge-protocol-item"
      });
      item.createDiv({
        cls: "echoink-knowledge-protocol-title",
        text: zh ? step.title : protocolEnglish[index][0]
      });
      item.setAttr("title", zh ? step.instruction : protocolEnglish[index][1]);
    }

    const preferenceSection = createSettingsSection(page, {
      title: zh ? "知识提炼偏好" : "Knowledge refinement preferences",
      description: zh
        ? "写你希望 EchoInk 关注什么、怎样拆分和融合，以及什么样的结果算好。"
        : "Describe what EchoInk should focus on, how it should split and merge knowledge, and what a good result looks like.",
      surface: "group"
    });
    const preferenceGroup = createSettingsGroup(preferenceSection);

    if (this.knowledgePreferenceLoading) {
      createSettingsState(
        preferenceGroup,
        zh ? "正在读取插件私有偏好…" : "Loading private plugin preferences…"
      );
      return;
    }
    if (this.knowledgePreferenceLoadError) {
      createSettingsState(
        preferenceGroup,
        zh
          ? "知识提炼偏好暂时无法读取。为避免覆盖现有内容，编辑器没有打开。"
          : "Preferences are temporarily unavailable. The editor remains closed to avoid overwriting existing content.",
        "error",
        {
          label: zh ? "重新加载" : "Reload",
          onActivate: () => void this.loadKnowledgePreferenceState(true)
        }
      );
      return;
    }
    const state = this.knowledgePreferenceState;
    const initialEditor = this.knowledgePreferenceEditor;
    let editor = initialEditor;
    if (!state || !editor) {
      if (!this.knowledgePreferenceLoading) void this.loadKnowledgePreferenceState();
      createSettingsState(
        preferenceGroup,
        zh ? "正在准备编辑器…" : "Preparing editor…"
      );
      return;
    }
    const loadedEditor: Readonly<KnowledgeMaintenancePreferenceEditorState> =
      editor;

    const row = applySettingsRow(new OriginSetting(preferenceGroup)
      .setName(zh ? "偏好 Markdown" : "Preference Markdown")
      .setDesc(zh
        ? "保存在插件私有目录；不会写入 Vault 知识文件。"
        : "Stored in the plugin-private directory and never written into Vault knowledge files.")
      .setClass("echoink-personalization-instruction-row")
      .setClass("echoink-knowledge-preference-row"));
    disposeOriginControls(row.controlEl);
    row.controlEl.empty();
    const textarea = row.controlEl.createEl("textarea", {
      cls: "echoink-personalization-textarea echoink-knowledge-preference-textarea",
      attr: {
        rows: "16",
        maxlength: String(64 * 1024),
        "aria-label": zh ? "知识提炼偏好 Markdown" : "Knowledge refinement preference Markdown",
        "data-echoink-focus-key": "knowledge:preferences:editor"
      }
    });
    textarea.value = loadedEditor.draftContent;
    const status = row.controlEl.createDiv({
      cls: "echoink-knowledge-preference-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    const error = row.controlEl.createDiv({
      cls: "codex-settings-inline-error echoink-knowledge-preference-error",
      attr: { role: "alert" }
    });
    const actions = row.controlEl.createDiv({
      cls: "echoink-personalization-actions"
    });
    const restore = createOriginButton(actions, {
      text: zh ? "恢复 EchoInk 默认" : "Restore EchoInk default",
      attr: {
        type: "button",
        "data-echoink-focus-key": "knowledge:preferences:restore"
      }
    });
    const save = createOriginButton(actions, {
      cls: "echoink-settings-save-button",
      text: zh ? "保存" : "Save",
      attr: {
        type: "button",
        "data-echoink-focus-key": "knowledge:preferences:save"
      }
    });

    const syncControls = () => {
      const currentEditor: Readonly<KnowledgeMaintenancePreferenceEditorState> =
        this.knowledgePreferenceEditor ?? loadedEditor;
      editor = currentEditor;
      const dirty = knowledgeMaintenancePreferenceIsDirty(currentEditor);
      const draftState = knowledgeMaintenancePreferenceDraftState(
        currentEditor
      );
      status.setText([
        draftState === "default"
          ? (zh ? "使用 EchoInk 默认" : "Using EchoInk default")
          : (zh ? "已自定义" : "Customized"),
        dirty
          ? (zh ? "有未保存修改" : "Unsaved changes")
          : (zh ? "已保存" : "Saved"),
        currentEditor.saving
          ? (zh ? "正在保存…" : "Saving…")
          : ""
      ].filter(Boolean).join(" · "));
      error.setText(currentEditor.error ?? "");
      error.toggleClass("is-visible", Boolean(currentEditor.error));
      textarea.setAttr("aria-invalid", String(Boolean(currentEditor.error)));
      textarea.disabled = currentEditor.saving;
      restore.disabled = currentEditor.saving || draftState === "default";
      save.disabled = currentEditor.saving || !dirty;
      save.toggleClass("mod-cta", dirty && !currentEditor.saving);
      save.setText(currentEditor.saving
        ? (zh ? "保存中…" : "Saving…")
        : (zh ? "保存" : "Save"));
    };

    textarea.oninput = () => {
      const current = this.knowledgePreferenceEditor;
      if (!current || current.saving) return;
      this.knowledgePreferenceEditor = editKnowledgeMaintenancePreference(
        current,
        textarea.value
      );
      syncControls();
    };
    restore.onclick = () => {
      const current = this.knowledgePreferenceEditor;
      if (!current || current.saving) return;
      this.knowledgePreferenceEditor =
        restoreDefaultKnowledgeMaintenancePreference(current);
      textarea.value = this.knowledgePreferenceEditor.draftContent;
      syncControls();
      textarea.focus();
    };
    save.onclick = () => void this.saveKnowledgePreference(textarea.value);
    syncControls();
  }

  private renderReviewSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    if (this.settingsDetail === "review-archives") {
      this.renderArchivedConversationSettings(container);
      return;
    }
    if (this.settingsDetail === "review-memory") {
      this.renderPersonalMemoryCorrectionCategories(container);
      return;
    }
    if (
      typeof this.settingsDetail === "object"
      && this.settingsDetail?.kind === "review-memory-category"
    ) {
      this.renderPersonalMemoryCorrectionRecords(
        container,
        this.settingsDetail.category
      );
      return;
    }
    const page = createSettingsPage(container, {
      title: copy.review.title,
      description: zh
        ? "生成本地周报，并管理从聊天列表移出的历史会话。"
        : "Generate local weekly summaries and manage conversations removed from chat."
    });
    page.addClass("codex-review-settings");
    this.renderSettingsActionError(page, "review");

    const generation = createSettingsSection(page, { surface: "flat" });
    const summary = createSettingsFeatureCard(
      generation,
      copy.review.generateHeading,
      zh
        ? "选择来源、统计周期和保存文件夹；生成结果只保留在所选目录。"
        : "Choose the source, date range, and destination folder. Generated files stay in that folder."
    );
    const actions = summary.createDiv({ cls: "review-generation" });
    this.addReviewAction(actions, copy.review.generateAgent, "agent-chat");
    this.addReviewAction(actions, copy.review.generateKnowledge, "knowledge-base");
    const controls = createSettingsGroup(summary);
    const outputSetting = applySettingsRow(new OriginSetting(controls)
      .setName(copy.review.outputDir)
      .setDesc(zh ? "默认保存到 outputs，也可选择当前 Vault 内任意文件夹。" : "Defaults to outputs; choose any folder in this Vault.")
      .addOriginText((text) => {
        text.inputEl.setAttr("aria-label", copy.review.outputDir);
        text.setValue(settings.outputDir === "." ? (zh ? "Vault 根目录" : "Vault root") : settings.outputDir);
        text.inputEl.readOnly = true;
      })
      .addOriginButton((button) => button
        .setButtonText(zh ? "选择" : "Choose")
        .onClick(() => void this.chooseReviewOutputFolder())));
    outputSetting.settingEl.dataset.echoinkFocusKey = "review:output-dir";
    this.addReviewRangeMode(controls);
    this.addReviewOpenAfterRun(controls);

    const management = createSettingsSection(page, {
      title: zh ? "管理" : "Management",
      surface: "group"
    });
    const managementGroup = createSettingsGroup(management);
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "已归档会话" : "Archived conversations",
      description: zh
        ? "搜索、恢复或删除已归档会话；删除后无法在设置中恢复。"
        : "Search, restore, or delete archived conversations. Deleted conversations cannot be restored in Settings.",
      value: this.archivedConversations
        ? String(this.archivedConversations.length)
        : (zh ? "查看" : "View"),
      actionLabel: zh ? "打开" : "Open",
      focusKey: "review:archives",
      onActivate: () => this.openSettingsDetail("review-archives")
    });
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "记忆修正" : "Memory correction",
      description: zh
        ? "按五类浏览当前 Memory；修正先由当前模型生成预览，确认后才创建新版本。"
        : "Browse current Memory in five categories. The current model creates a preview before any new version is written.",
      value: this.personalMemoryState
        ? String(this.personalMemoryState.records.filter((record) => record.status === "current").length)
        : (zh ? "查看" : "View"),
      actionLabel: zh ? "打开" : "Open",
      focusKey: "review:memory",
      onActivate: () => this.openSettingsDetail("review-memory")
    });
  }

  private async chooseReviewOutputFolder(): Promise<void> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const folders = this.app.vault.getAllFolders(true)
      .map((folder) => folder.path || ".")
      .sort((left, right) => left.localeCompare(right, "zh-CN"));
    const selected = await new Promise<string | null>((resolve) => {
      const picker = new Modal(this.app);
      picker.onOpen = () => {
        picker.titleEl.setText(zh ? "选择周报保存文件夹" : "Choose report folder");
        const list = picker.contentEl.createDiv({ cls: "settings-card settings-stack" });
        for (const folder of [...new Set([".", ...folders])]) {
          createSettingsNavigationRow(list, {
            title: folder === "." ? (zh ? "Vault 根目录" : "Vault root") : folder,
            actionLabel: folder === this.plugin.settings.review.outputDir ? (zh ? "当前文件夹" : "Current folder") : (zh ? "选择" : "Choose"),
            onActivate: () => { resolve(folder); picker.close(); }
          });
        }
      };
      picker.onClose = () => { resolve(null); picker.contentEl.empty(); };
      this.openInlineEditor(picker, "review");
    });
    if (!selected) return;
    this.plugin.settings.review.outputDir = normalizeReviewOutputDir(
      selected,
      DEFAULT_SETTINGS.review.outputDir
    );
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private renderArchivedConversationSettings(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "已归档会话" : "Archived conversations",
      description: zh
        ? "你可以搜索、恢复或删除会话；删除后无法在设置中恢复。"
        : "You can search, restore, or delete conversations. Deleted conversations cannot be restored in Settings.",
      detail: true,
      backLabel: zh ? "返回复盘" : "Back to Review",
      onBack: () => void this.closeSettingsDetail()
    });
    page.addClass("echoink-review-archives-page");
    if (!this.archivedConversations && !this.archivedConversationsLoading && !this.archivedConversationsError) {
      void this.loadArchivedConversations();
    }
    const toolbar = page.createDiv({ cls: "settings-toolbar review-archive-toolbar" });
    const search = createOriginInput(toolbar, {
      cls: "echoink-review-archive-search settings-input",
      attr: {
        type: "search",
        placeholder: zh ? "搜索已归档会话" : "Search archived conversations",
        "aria-label": zh ? "搜索已归档会话" : "Search archived conversations",
        "data-echoink-focus-key": "review:archives:search"
      }
    });
    search.value = this.archivedConversationQuery;
    let composing = false;
    const updateQuery = () => {
      this.archivedConversationQuery = search.value;
      this.settingsFocusIntent = "explicit:review:archives:search";
      this.scheduleDisplay();
    };
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; updateQuery(); });
    search.oninput = (event) => { if (!composing && !(event as InputEvent).isComposing) updateQuery(); };

    const section = createSettingsSection(page, {
      title: zh
        ? `已归档 ${this.archivedConversations?.length ?? 0}`
        : `Archived ${this.archivedConversations?.length ?? 0}`,
      surface: "group"
    });
    const list = createSettingsCompactList(section);
    if (this.archivedConversationsLoading) {
      createSettingsState(list, zh ? "正在读取已归档会话…" : "Loading archived conversations…");
      return;
    }
    if (this.archivedConversationsError) {
      createSettingsState(list, zh ? "暂时无法读取已归档会话。" : "Archived conversations are unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadArchivedConversations(true)
      });
      return;
    }
    const query = this.archivedConversationQuery.trim().toLocaleLowerCase("zh-CN");
    const entries = (this.archivedConversations ?? []).filter((entry) =>
      !query || entry.title.toLocaleLowerCase("zh-CN").includes(query)
    );
    if (!entries.length) {
      this.renderHistoryEmpty(list, query
        ? (zh ? "没有匹配的已归档会话" : "No archived conversations match")
        : (zh ? "暂无已归档会话" : "No archived conversations"),
        query ? (zh ? "试试另一个关键词。" : "Try another keyword.") : (zh ? "归档后的会话会显示在这里。" : "Archived conversations will appear here."));
      return;
    }
    for (const entry of entries) {
      const busy = this.archivedConversationBusyId === entry.conversationId;
      const row = list.createDiv({ cls: "echoink-settings-compact-row" });
      row.setAttr("aria-busy", String(busy));
      const rowCopy = row.createDiv({ cls: "echoink-settings-compact-copy" });
      rowCopy.createDiv({ cls: "echoink-settings-compact-title", text: entry.title });
      rowCopy.createDiv({
        cls: "echoink-settings-compact-description",
        text: `${zh ? "归档时间" : "Archived"} · ${new Date(entry.updatedAt).toLocaleString()}`
      });
      const rowActions = row.createDiv({ cls: "echoink-settings-compact-actions" });
      const restore = createOriginButton(rowActions, {
        text: busy ? (zh ? "处理中…" : "Working…") : (zh ? "恢复" : "Restore"),
        attr: { type: "button", "aria-label": `${zh ? "恢复" : "Restore"} ${entry.title}` }
      });
      restore.disabled = Boolean(this.archivedConversationBusyId);
      restore.onclick = () => void this.restoreArchivedConversation(entry);
      const remove = createOriginButton(rowActions, {
        text: zh ? "删除" : "Delete",
        cls: "mod-warning",
        attr: { type: "button", "aria-label": `${zh ? "删除" : "Delete"} ${entry.title}` }
      });
      remove.disabled = Boolean(this.archivedConversationBusyId);
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        message: zh ? `删除“${entry.title}”后无法在设置中恢复。确认删除这条会话？` : `Delete “${entry.title}”? It cannot be restored in Settings afterward.`,
        confirmLabel: zh ? "确认删除" : "Confirm deletion", cancelLabel: zh ? "取消" : "Cancel",
        onConfirm: () => this.softDeleteArchivedConversation(entry)
      });
    }
  }

  private async loadArchivedConversations(force = false): Promise<void> {
    if (this.archivedConversationsLoading || (this.archivedConversations && !force)) return;
    this.archivedConversationsLoading = true;
    this.archivedConversationsError = "";
    this.scheduleDisplay();
    try {
      this.archivedConversations = Object.freeze(
        [...await this.plugin.listPiConversations(["archived"])]
          .filter((entry) => entry.status === "archived")
          .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      );
    } catch (error) {
      this.archivedConversations = null;
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationsLoading = false;
      this.scheduleDisplay();
    }
  }

  private async restoreArchivedConversation(entry: Readonly<PiConversationCatalogEntry>): Promise<void> {
    if (this.archivedConversationBusyId) return;
    this.archivedConversationBusyId = entry.conversationId;
    this.scheduleDisplay();
    try {
      await this.plugin.setPiConversationStatus(entry.conversationId, "active");
      this.removeArchivedConversation(entry.conversationId);
      await this.plugin.getCodexView()?.refreshPiConversationCatalog();
      new Notice(`${this.plugin.settings.settingsLanguage === "en" ? "Restored" : "已恢复"}“${entry.title}”`);
    } catch (error) {
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationBusyId = "";
      this.scheduleDisplay();
    }
  }

  private async softDeleteArchivedConversation(entry: Readonly<PiConversationCatalogEntry>): Promise<void> {
    if (this.archivedConversationBusyId) return;
    this.archivedConversationBusyId = entry.conversationId;
    this.scheduleDisplay();
    try {
      await this.plugin.setPiConversationStatus(entry.conversationId, "deleted");
      this.removeArchivedConversation(entry.conversationId);
      new Notice(this.plugin.settings.settingsLanguage === "en" ? "Conversation deleted." : "已删除会话");
    } catch (error) {
      this.archivedConversationsError = error instanceof Error ? error.message : String(error);
    } finally {
      this.archivedConversationBusyId = "";
      this.scheduleDisplay();
    }
  }

  private removeArchivedConversation(conversationId: string): void {
    this.archivedConversations = Object.freeze(
      (this.archivedConversations ?? []).filter((entry) => entry.conversationId !== conversationId)
    );
  }

  private renderPersonalMemoryCorrectionCategories(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const page = createSettingsPage(container, {
      title: zh ? "记忆修正" : "Memory correction",
      description: zh
        ? "这里只显示仍然生效的 Memory 内容，不展示文件名、路径、内部 ID、revision 或来源 URI。"
        : "Only current Memory content appears here. File names, paths, internal IDs, revisions, and source URIs stay hidden.",
      detail: true,
      backLabel: zh ? "返回复盘" : "Back to Review",
      onBack: () => void this.closeSettingsDetail()
    });
    if (!this.personalMemoryState && !this.personalMemoryLoading && !this.personalMemoryError) {
      void this.loadPersonalMemoryState();
    }
    const section = createSettingsSection(page, {
      title: zh ? "Memory 分类" : "Memory categories",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    if (this.personalMemoryLoading) {
      createSettingsState(group, zh ? "正在读取当前 Memory…" : "Loading current Memory…");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(group, zh ? "当前 Memory 暂时无法读取。" : "Current Memory is unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadPersonalMemoryState(true)
      });
      return;
    }
    const total = this.personalMemoryState.records.filter((record) => record.status === "current").length;
    section.querySelector<HTMLElement>(".settings-card-header")?.createSpan({ cls: "settings-badge", text: zh ? `${total} 条记录` : `${total} records` });
    for (const category of PERSONAL_MEMORY_CORRECTION_CATEGORIES) {
      const count = this.currentPersonalMemoryRecords(category.id).length;
      const row = createSettingsNavigationRow(group, {
        title: zh ? category.labelZh : category.labelEn,
        description: zh ? category.descriptionZh : category.descriptionEn,
        value: String(count),
        actionLabel: zh ? "查看" : "View",
        focusKey: `review:memory:${category.id}`,
        onActivate: () => this.openSettingsDetail({
          kind: "review-memory-category",
          category: category.id
        })
      });
      row.querySelector<HTMLElement>(".echoink-settings-navigation-value")?.addClass("settings-badge", "review-memory-count");
    }
  }

  private renderPersonalMemoryCorrectionRecords(
    container: HTMLElement,
    categoryId: PersonalMemoryCorrectionCategory
  ): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const category = personalMemoryCorrectionCategory(categoryId);
    const page = createSettingsPage(container, {
      title: zh ? category.labelZh : category.labelEn,
      description: zh ? category.descriptionZh : category.descriptionEn,
      detail: true,
      backLabel: zh ? "返回记忆修正" : "Back to Memory correction",
      onBack: () => {
        this.settingsDetail = "review-memory";
        this.settingsFocusIntent = `explicit:review:memory:${category.id}`;
        this.scheduleDisplay();
      }
    });
    const section = createSettingsSection(page, { surface: "flat" });
    const list = createSettingsCompactList(section);
    list.addClass("echoink-memory-record-list");
    if (this.personalMemoryLoading) {
      createSettingsState(list, zh ? "正在读取当前 Memory…" : "Loading current Memory…");
      return;
    }
    if (!this.personalMemoryState) {
      createSettingsState(list, zh ? "当前 Memory 暂时无法读取。" : "Current Memory is unavailable.", "error", {
        label: zh ? "重试" : "Retry",
        onActivate: () => void this.loadPersonalMemoryState(true)
      });
      return;
    }
    const records = this.currentPersonalMemoryRecords(category.id);
    if (!records.length) {
      createSettingsState(list, zh ? "这一类暂无当前记录。" : "No current records in this category.");
      return;
    }
    for (const [recordIndex, record] of records.entries()) {
      const row = list.createDiv({ cls: "echoink-settings-compact-row echoink-memory-correction-row" });
      const header = row.createDiv({ cls: "echoink-memory-card-header" });
      header.createDiv({ cls: "echoink-memory-card-title", text: record.title });
      const actions = header.createDiv({
        cls: "echoink-settings-compact-actions echoink-memory-card-actions"
      });
      const correct = createOriginButton(actions, {
        text: zh ? "修正" : "Correct",
        attr: {
          type: "button",
          "aria-label": `${zh ? "修正" : "Correct"} ${record.title}`,
          "data-echoink-focus-key": `review:memory:${category.id}:correct:${recordIndex}`
        }
      });
      correct.disabled = this.memoryActionRunning;
      correct.onclick = () => void this.correctPersonalMemoryRecord(record);
      const forget = createOriginButton(actions, {
        cls: "mod-warning",
        text: zh ? "忘掉" : "Forget",
        attr: {
          type: "button",
          "aria-label": `${zh ? "忘掉" : "Forget"} ${record.title}`,
          "data-echoink-focus-key": `review:memory:${category.id}:forget:${recordIndex}`
        }
      });
      forget.disabled = this.memoryActionRunning;
      forget.onclick = () => showSettingsInlineConfirmation(row, forget, {
        message: zh ? `忘掉“${record.title}”后，它不会再被召回；相关用户画像与 Agent 长期学习内容会同步更新。` : `After “${record.title}” is forgotten, it will no longer be recalled. Related user-profile and Agent learning projections will be updated too.`,
        confirmLabel: zh ? "确认忘掉" : "Confirm forgetting", cancelLabel: this.copy.common.cancel,
        onConfirm: () => this.forgetPersonalMemoryRecord(record)
      });

      const fields = row.createDiv({ cls: "echoink-memory-card-fields" });
      const content = fields.createDiv({
        cls: "echoink-memory-card-field echoink-memory-card-content"
      });
      content.createDiv({
        cls: "echoink-memory-card-label",
        text: zh ? "记忆内容" : "Memory content"
      });
      content.createDiv({ cls: "echoink-memory-card-body", text: record.content });

      const recall = fields.createDiv({
        cls: "echoink-memory-card-field echoink-memory-card-recall"
      });
      recall.createDiv({
        cls: "echoink-memory-card-label",
        text: zh ? "召回时机" : "Recall when"
      });
      recall.createDiv({ cls: "echoink-memory-card-body", text: record.recallWhen });
    }
  }

  private currentPersonalMemoryRecords(
    categoryId: PersonalMemoryCorrectionCategory
  ): readonly Readonly<PersonalMemoryRecord>[] {
    const kinds = new Set(personalMemoryCorrectionCategory(categoryId).kinds);
    return Object.freeze(
      [...(this.personalMemoryState?.records ?? [])]
        .filter((record) => record.status === "current" && kinds.has(record.kind))
        .sort((left, right) =>
          right.date.localeCompare(left.date)
          || left.title.localeCompare(right.title, "zh-CN")
        )
    );
  }

  private async correctPersonalMemoryRecord(
    record: Readonly<PersonalMemoryRecord>
  ): Promise<void> {
    if (this.memoryActionRunning) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const state = this.personalMemoryState;
    if (!state || record.status !== "current") return;
    this.memoryActionRunning = true;
    this.personalMemoryError = null;
    this.scheduleDisplay();
    try {
      const result = await memoryCorrectionModal(
        this.app,
        {
          memoryType: personalMemoryKindLabel(record.kind, zh),
          title: record.title,
          content: record.content,
          recallWhen: record.recallWhen
        },
        this.plugin.settings.settingsLanguage,
        {
          generate: async (correction, signal) =>
            await this.plugin.generateEchoInkPersonalMemoryCorrection(
              {
                kind: record.kind,
                title: record.title,
                content: record.content,
                recallWhen: record.recallWhen
              },
              correction,
              signal
            ),
          save: async (preview, correction) => {
            try {
              await this.plugin.applyEchoInkPersonalMemoryCorrection({
                targetId: record.id,
                title: preview.title,
                content: preview.content,
                recallWhen: preview.recallWhen,
                reason: `${zh ? "用户在记忆修正中明确纠正" : "User explicitly corrected this Memory"}：${correction}`.slice(0, 1_900),
                expectedRevision: state.revision
              });
              this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
            } catch (error) {
              if (isPersonalMemoryRevisionConflict(error)) {
                try {
                  this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
                  this.scheduleDisplay();
                } catch {
                  // Preserve the original conflict as the actionable result.
                }
                new Notice(zh
                  ? "Memory 已变化，列表已刷新；请从最新记录重新生成。"
                  : "Memory changed. The list was refreshed; regenerate from the latest record.");
              }
              throw error;
            }
          }
        },
        (modal) => this.openInlineEditor(modal, "review")
      );
      if (result === "saved") {
        new Notice(zh ? "Memory 已保存为新版本" : "Memory saved as a new version");
      }
    } catch (error) {
      this.personalMemoryError = error instanceof Error ? error.message : String(error);
      new Notice(zh
        ? "Memory 修正未写入；请重新加载后重试。"
        : "Memory correction was not written. Reload and try again.");
    } finally {
      this.memoryActionRunning = false;
      this.scheduleDisplay();
    }
  }

  private async forgetPersonalMemoryRecord(
    record: Readonly<PersonalMemoryRecord>
  ): Promise<void> {
    if (this.memoryActionRunning) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const state = this.personalMemoryState;
    if (!state || record.status !== "current") return;
    this.memoryActionRunning = true;
    this.personalMemoryError = null;
    this.scheduleDisplay();
    let forgotten = false;
    try {
      await this.plugin.forgetEchoInkPersonalMemory(
        record.id,
        zh
          ? `用户在复盘记忆管理中明确要求忘掉“${record.title}”`
          : `User explicitly requested forgetting “${record.title}” in Review`,
        state.revision
      );
      forgotten = true;
      this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
      new Notice(zh ? "Memory 已忘掉" : "Memory forgotten");
    } catch (error) {
      if (isPersonalMemoryRevisionConflict(error)) {
        try {
          this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
          this.personalMemoryError = null;
          new Notice(zh
            ? "Memory 已变化，列表已刷新；请从最新记录重新操作。"
            : "Memory changed. The list was refreshed; retry from the latest record.");
        } catch (reloadError) {
          this.personalMemoryError = reloadError instanceof Error
            ? reloadError.message
            : String(reloadError);
          new Notice(zh
            ? "Memory 已变化，但列表刷新失败；请重新打开复盘。"
            : "Memory changed, but the list could not refresh. Reopen Review.");
        }
      } else {
        this.personalMemoryError = error instanceof Error ? error.message : String(error);
        new Notice(forgotten
          ? (zh
            ? "Memory 已忘掉，但列表刷新失败；请重新打开复盘。"
            : "Memory was forgotten, but the list could not refresh. Reopen Review.")
          : (zh
            ? "Memory 未能忘掉；请重新加载后重试。"
            : "Memory was not forgotten. Reload and try again."));
      }
    } finally {
      this.memoryActionRunning = false;
      this.scheduleDisplay();
    }
  }

  private addReviewAction(container: HTMLElement, label: string, kind: ReviewReportKind): void {
    const copy = this.copy;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const button = createOriginButton(container, {
      cls: "review-generate-card",
      attr: {
        type: "button",
        "aria-label": label,
        "data-echoink-focus-key": `review:${kind}:generate`
      }
    });
    setIcon(button.createEl("i"), kind === "agent-chat" ? "message-circle" : "book-open");
    const content = button.createDiv();
    content.createEl("strong", { text: label });
    content.createSpan({ text: kind === "agent-chat"
      ? (zh ? "回看这一周的对话与协作" : "Review this week's conversations and collaboration")
      : (zh ? "回看知识整理与积累" : "Review how your knowledge has grown") });
    setIcon(button.createSpan({ cls: "review-generate-arrow" }), "arrow-up-right");
    button.onclick = async () => {
      const reportLabel = copy.review.reportLabels[kind];
      const accepted = await confirmModal(
        this.app,
        copy.review.confirmTitle(label),
        copy.review.confirmBody(reportLabel, this.plugin.settings.review.outputDir),
        copy.review.generate,
        copy.review.cancel
      );
      if (!accepted) return;
      this.settingsFocusIntent = `explicit:review:${kind}:generate`;
      await this.runSettingsButtonAction(button, "review", async () => {
        const manager = this.plugin.getReviewManager();
        if (!manager) {
          throw new Error(this.plugin.settings.settingsLanguage === "en"
            ? "Review is not ready yet. Reopen EchoInk and try again."
            : "复盘服务尚未就绪。请重新打开 EchoInk 后重试。"
          );
        }
        const result = await manager.runReview(kind);
        if (result.status === "failed") {
          throw new Error(this.plugin.settings.settingsLanguage === "en"
            ? "The review report could not be generated. Check the output directory and try again."
            : "复盘报告生成失败。请检查输出目录后重试。"
          );
        }
        this.announceSettingsStatus(this.plugin.settings.settingsLanguage === "en"
          ? `${reportLabel} generated.`
          : `${reportLabel}已生成。`
        );
        this.scheduleDisplay();
      });
    };
  }

  private addReviewRangeMode(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    this.decorateSetting(new OriginSetting(container).setName(copy.review.rangeMode).addOriginDropdown(this.app, (dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.review.rangeMode);
      dropdown
        .addOption("previous-week", copy.review.rangeOptions["previous-week"])
        .addOption("current-week", copy.review.rangeOptions["current-week"])
        .setValue(settings.rangeMode)
        .onChange(async (value) => {
          settings.rangeMode = value === "current-week" ? "current-week" : "previous-week";
          await this.plugin.saveSettings();
        });
    }), "calendar-days");
  }

  private addReviewOpenAfterRun(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    this.decorateSetting(new OriginSetting(container).setName(copy.review.openHtmlAfterRun).addOriginToggle((toggle) => {
      labelSettingsToggle(toggle, copy.review.openHtmlAfterRun);
      toggle.setValue(settings.openHtmlAfterRun).onChange(async (value) => {
        settings.openHtmlAfterRun = value;
        await this.plugin.saveSettings();
      });
    }), "panel-right-open");
  }

  private renderTopTabs(
    container: HTMLElement,
    activeTab: VisibleSettingsTab
  ): void {
    const copy = this.copy;
    const navigation = this.nativeSettingsNavigation;
    const tabs = navigation?.listEl ?? container.createDiv({ cls: "codex-settings-tabs" });
    tabs.addClass("codex-settings-tabs");
    tabs.setAttr("role", "tablist");
    tabs.setAttr("aria-labelledby", SETTINGS_TITLE_ID);
    tabs.setAttr("aria-orientation", "horizontal");
    let activeButton: HTMLButtonElement | null = null;
    const keepActiveTabVisible = () => {
      if (!activeButton?.isConnected) return;
      const bounds = activeButton.getBoundingClientRect();
      const viewport = tabs.getBoundingClientRect();
      // Only adjust the strip; never scroll or focus the page on resize.
      if (bounds.left < viewport.left) tabs.scrollLeft += bounds.left - viewport.left;
      else if (bounds.right > viewport.right) tabs.scrollLeft += bounds.right - viewport.right;
    };
    const updateOverflowHint = () => {
      const maxScrollLeft = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
      container.toggleClass("can-scroll-left", tabs.scrollLeft > 1);
      container.toggleClass("can-scroll-right", tabs.scrollLeft < maxScrollLeft - 1);
    };
    tabs.onscroll = updateOverflowHint;
    this.disconnectSettingsTabsResizeObserver();
    const TabResizeObserver = container.ownerDocument.defaultView?.ResizeObserver;
    if (TabResizeObserver) {
      this.settingsTabsResizeObserver = new TabResizeObserver(() => {
        keepActiveTabVisible();
        updateOverflowHint();
      });
      this.settingsTabsResizeObserver.observe(tabs);
    }
    const now = Date.now();
    if (
      this.lastRenderedSettingsTab !== null
      && this.lastRenderedSettingsTab !== activeTab
    ) {
      this.settingsTabIconAnimation = { tabId: activeTab, startedAtMs: now };
    }
    const activeAnimationElapsed =
      this.settingsTabIconAnimation?.tabId === activeTab
        ? Math.max(0, now - this.settingsTabIconAnimation.startedAtMs)
        : null;
    if (
      activeAnimationElapsed !== null
      && activeAnimationElapsed >= SETTINGS_TAB_ICON_ANIMATION_WINDOW_MS
    ) {
      this.settingsTabIconAnimation = null;
    }
    const activeAnimationProgress =
      activeAnimationElapsed !== null
      && activeAnimationElapsed < SETTINGS_TAB_ICON_ANIMATION_WINDOW_MS
        ? activeAnimationElapsed
        : null;
    SETTINGS_TABS.forEach((tab, index) => {
      const nativeRow = navigation?.rows.get(tab.id);
      if (navigation && !nativeRow) return;
      const label = copy.tabs[tab.id];
      const isActive = activeTab === tab.id;
      const button = nativeRow?.button ?? createOriginButton(nativeRow?.setting.controlEl ?? tabs, {
        cls: `codex-settings-tab ${isActive ? "is-active" : ""}`,
        attr: {
          id: settingsTabDomId(tab.id),
          type: "button",
          role: "tab",
          "data-settings-tab": tab.id,
          "data-echoink-focus-key": `settings-tab:${tab.id}`,
          "aria-selected": String(isActive),
          "aria-controls": SETTINGS_PANEL_ID,
          tabindex: isActive ? "0" : "-1"
        }
      });
      if (nativeRow) nativeRow.button = button;
      button.toggleClass("is-active", isActive);
      button.setAttr("aria-selected", String(isActive));
      button.setAttr("tabindex", isActive ? "0" : "-1");
      const icon = button.querySelector<HTMLElement>(".codex-settings-tab-icon")
        ?? button.createSpan({ cls: "codex-settings-tab-icon settings-motion-icon" });
      renderAnimatedSettingsTabIcon(
        icon,
        tab.icon,
        isActive ? activeAnimationProgress : null
      );
      const labelEl = nativeRow?.setting.nameEl
        ?? button.createSpan({ cls: "codex-settings-tab-label" });
      labelEl.addClass("codex-settings-tab-label");
      labelEl.setText(label);
      if (nativeRow && labelEl.parentElement !== button) button.appendChild(labelEl);
      if (isActive) {
        activeButton = button;
      }
      button.onpointerdown = () => {
        this.settingsTabPointerActivated = true;
      };
      button.onclick = () => {
        const restoreKeyboardFocus = !this.settingsTabPointerActivated;
        this.settingsTabPointerActivated = false;
        if (activeTab === tab.id) return;
        void this.activateSettingsTab(tab.id, restoreKeyboardFocus);
      };
      button.onkeydown = (event) => {
        const nextIndex = tabIndexFromKeyboard(event.key, index, SETTINGS_TABS.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateSettingsTab(SETTINGS_TABS[nextIndex].id, true);
      };
    });
    this.lastRenderedSettingsTab = activeTab;
    (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(updateOverflowHint);

    if (!activeButton) {
      this.suppressSettingsTabFocusRestore = false;
      return;
    }
    const restoreKeyboardFocus = !this.suppressSettingsTabFocusRestore;
    this.suppressSettingsTabFocusRestore = false;
    const tabButton = activeButton as HTMLButtonElement;
    (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      if (!tabButton.isConnected) return;
      keepActiveTabVisible();
      updateOverflowHint();
      if (!restoreKeyboardFocus || this.settingsTabFocusId !== activeTab) return;
      tabButton.focus({ preventScroll: true });
      (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
        if (
          tabButton.isConnected
          && this.containerEl.ownerDocument.activeElement === tabButton
          && this.settingsTabFocusId === activeTab
        ) {
          this.settingsTabFocusId = null;
        }
      });
    });
  }

  private disconnectSettingsTabsResizeObserver(): void {
    this.settingsTabsResizeObserver?.disconnect();
    this.settingsTabsResizeObserver = null;
  }

  private async activateSettingsTab(
    tabId: VisibleSettingsTab,
    focus: boolean
  ): Promise<void> {
    if (this.plugin.settings.settingsTab === tabId) return;
    if (
      this.plugin.settings.settingsTab === "knowledgeBase"
      && tabId !== "knowledgeBase"
    ) {
      this.knowledgeInitSection?.invalidate();
    }
    if (
      this.settingsDetail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
    ) {
      const discard = await this.confirmKnowledgePreferenceDiscard();
      if (!discard) {
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        this.scheduleDisplay();
        return;
      }
      this.resetKnowledgePreferenceDraft();
    }
    this.settingsDetail = null;
    this.announceSettingsStatus("");
    this.settingsTabFocusId = focus ? tabId : null;
    this.suppressSettingsTabFocusRestore = !focus;
    this.plugin.settings.settingsTab = tabId;
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private openSettingsDetail(detail: Exclude<SettingsDetail, null>): void {
    this.settingsDetail = detail;
    this.settingsFocusIntent = "explicit:settings-detail:back";
    if (typeof detail === "object" && detail.kind === "resource") {
      const resource = this.currentEchoInkResourceCatalog().find(
        (candidate) => candidate.id === detail.resourceId
      );
      const skillId = resource ? builtinSkillIdForResource(resource) : null;
      if (skillId) this.loadBuiltinSkillEditor(detail.resourceId, skillId);
      else this.clearBuiltinSkillEditor();
    } else {
      this.clearBuiltinSkillEditor();
    }
    if (detail === "knowledge-maintenance-history") {
      this.knowledgeMaintenanceHistoryDate = "";
    }
    if (detail === "knowledge-preferences") {
      void this.loadKnowledgePreferenceState();
    }
    if (detail === "review-archives") {
      void this.loadArchivedConversations();
    }
    if (detail === "review-memory") {
      void this.loadPersonalMemoryState();
    }
    this.scheduleDisplay();
  }

  private async closeSettingsDetail(): Promise<void> {
    const detail = this.settingsDetail;
    if (
      detail === "knowledge-preferences"
      && knowledgeMaintenancePreferenceIsDirty(
        this.knowledgePreferenceEditor
      )
    ) {
      const discard = await this.confirmKnowledgePreferenceDiscard();
      if (!discard) {
        this.settingsFocusIntent =
          "explicit:knowledge:preferences:editor";
        this.scheduleDisplay();
        return;
      }
      this.resetKnowledgePreferenceDraft();
    }
    this.settingsDetail = null;
    this.clearBuiltinSkillEditor();
    if (typeof detail === "object" && detail?.kind === "resource") {
      this.settingsFocusIntent = `explicit:resource:${detail.resourceId}:detail`;
    } else if (
      typeof detail === "object"
      && detail?.kind === "review-memory-category"
    ) {
      this.settingsFocusIntent = `explicit:review:memory:${detail.category}`;
    } else if (detail === "knowledge-preferences") {
      this.settingsFocusIntent = "explicit:knowledge:preferences";
    } else if (detail === "knowledge-maintenance-history") {
      this.settingsFocusIntent = "explicit:knowledge:maintenance-history";
    } else if (detail === "review-archives") {
      this.settingsFocusIntent = "explicit:review:archives";
    } else if (detail === "review-memory") {
      this.settingsFocusIntent = "explicit:review:memory";
    }
    this.scheduleDisplay();
  }

  private clearBuiltinSkillEditor(): void {
    this.builtinSkillEditorRequestId += 1;
    this.builtinSkillEditor = null;
  }

  private loadBuiltinSkillEditor(
    resourceId: string,
    skillId: BuiltinSkillId
  ): void {
    const requestId = ++this.builtinSkillEditorRequestId;
    this.builtinSkillEditor = {
      resourceId,
      skillId,
      snapshot: null,
      draftContent: "",
      loading: true,
      saving: false,
      error: ""
    };
    void this.plugin.readEchoInkBuiltinSkill(skillId).then((snapshot) => {
      if (requestId !== this.builtinSkillEditorRequestId) return;
      this.builtinSkillEditor = {
        resourceId,
        skillId,
        snapshot,
        draftContent: snapshot.content,
        loading: false,
        saving: false,
        error: ""
      };
      this.scheduleDisplay();
    }).catch((error) => {
      if (requestId !== this.builtinSkillEditorRequestId) return;
      this.builtinSkillEditor = {
        resourceId,
        skillId,
        snapshot: null,
        draftContent: "",
        loading: false,
        saving: false,
        error: error instanceof Error ? error.message : String(error)
      };
      this.scheduleDisplay();
    });
  }

  private renderProviderModelManager(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const label = (chinese: string, english: string) => zh ? chinese : english;
    const wrapper = createSettingsPage(container, {
      title: label("模型与提供商", "Models and providers"),
      description: label(
        "管理 EchoInk 使用的 Provider 和模型。每个 Provider 可启用多个模型，指定其中一个作为默认。",
        "Manage EchoInk's providers and models. Enable multiple models per provider and choose one as the default."
      )
    });
    wrapper.addClass("codex-provider-model-manager");
    this.renderSettingsActionError(wrapper, "providers");

    const savedSection = wrapper.createDiv({ cls: "codex-provider-saved-section settings-card provider-list-card" });
    const addSection = savedSection.createDiv({
      cls: "codex-provider-add-section"
    });
    const addCopy = addSection.createDiv({ cls: "codex-provider-add-copy" });
    addCopy.createDiv({
      cls: "codex-provider-add-title",
      text: label("已保存模型", "Saved models")
    });
    addCopy.createDiv({
      cls: "codex-provider-add-description",
      text: label(
        "当前模型用于后续对话。",
        "The current model is used for subsequent conversations."
      )
    });
    const addButton = createOriginButton(addSection, {
      cls: "codex-provider-add-button",
      attr: { type: "button", "data-echoink-focus-key": "providers:add" }
    });
    applyAmicroButton(addButton, { variant: "primary", motion: "slide", icon: "plus" });
    addButton.createSpan({ text: label("添加模型", "Add model") });
    addButton.onclick = () => {
      this.openProviderModelModal(createApiProviderConfig(), false);
    };

    const savedList = savedSection.createDiv({
      cls: "codex-provider-saved-list"
    });
    const active = getActiveApiProvider(this.plugin.settings);

    for (const saved of this.plugin.settings.apiProviders) {
      const preset = getApiProviderPreset(normalizeApiProviderId(
        saved.providerId,
        saved.baseUrl,
        saved.name
      ));
      const providerId = preset.id;
      const providerDisplayName = apiProviderConfiguredDisplayName(
        providerId,
        saved.name,
        this.plugin.settings.settingsLanguage
      );
      const defaultModel = getDefaultApiProviderModel(saved);
      const modelDisplayName = defaultModel
        ? defaultModel.displayName
        : label("未设置模型", "No model set");
      const row = savedList.createDiv({
        cls: `codex-provider-saved-row is-provider-${providerId}${saved.id === active?.id ? " is-current" : ""}`
      });
      const identity = row.createDiv({
        cls: "codex-provider-saved-identity",
        attr: {
          "aria-label": `${modelDisplayName} · ${providerDisplayName}`
        }
      });
      const rowIcon = identity.createSpan({
        cls: `codex-provider-saved-icon is-${providerId}`
      });
      renderProviderBrandIcon(rowIcon, providerId);
      const savedCopy = identity.createDiv({
        cls: "codex-provider-saved-copy"
      });
      const modelHeading = savedCopy.createDiv({ cls: "codex-provider-saved-model" });
      modelHeading.createEl("strong", { text: modelDisplayName });
      if (saved.models.length > 1) {
        modelHeading.createSpan({ cls: "codex-provider-model-count", text: `+ ${saved.models.length - 1}` });
      }
      if (saved.id === active?.id) {
        modelHeading.createSpan({ cls: "codex-provider-active-badge", text: label("当前选择", "Current selection") });
      }
      const metadata = savedCopy.createEl("p", { cls: "codex-provider-saved-details" });
      const savedProvider = metadata.createSpan({
        cls: "codex-provider-saved-provider",
        text: providerDisplayName,
        attr: {
          tabindex: "0",
          "aria-label": providerId === "openai-codex"
            ? (this.plugin.settings.settingsLanguage === "en"
              ? `${providerDisplayName}. OpenAI OAuth.`
              : `${providerDisplayName}。OpenAI OAuth。`)
            : this.plugin.settings.settingsLanguage === "en"
              ? `${providerDisplayName}. Provider endpoint: ${saved.baseUrl}`
              : `${providerDisplayName}。Provider 地址：${saved.baseUrl}`
        }
      });
      if (providerId !== "openai-codex") {
        savedProvider.createSpan({
          cls: "codex-provider-url-tooltip",
          text: saved.baseUrl,
          attr: { "aria-hidden": "true" }
        });
      }

      const rowMeta = row.createDiv({ cls: "codex-provider-saved-meta" });
      const apiKeyRequired = apiProviderApiKeyRequired(providerId);
      const credentialReady = apiProviderHasUsableCredential(
        saved,
        this.plugin.settings.openAICodexCredential
      );
      const credentialState = saved.authMode === "oauth"
        ? credentialReady ? "oauth-ready" : "oauth-missing"
        : !apiKeyRequired
          ? "not-required"
          : credentialReady
            ? "ready"
            : "missing";
      if (providerId === "openai-codex") {
        metadata.createSpan({
          cls: "codex-provider-beta-pill",
          text: "Beta"
        });
      }
      metadata.createSpan({
        cls: `codex-provider-credential-badge is-${credentialState}`,
        text: credentialState === "oauth-ready"
          ? label("OpenAI 已连接", "OpenAI connected")
          : credentialState === "oauth-missing"
            ? label("需要 OpenAI 登录", "OpenAI sign-in required")
          : credentialState === "not-required"
          ? label("无需 API Key", "No API key required")
          : credentialState === "ready"
            ? label("API Key 已填写", "API key configured")
            : label("未配置 API Key", "API key missing")
      });
      if (
        this.verifiedProviderConnections.get(saved.id)
        === providerConfigurationFingerprint(saved)
      ) {
        metadata.createSpan({
          cls: "codex-provider-connection-badge is-connected",
          text: label("连接正常", "Connection verified")
        });
      }
      if (saved.id !== active?.id) {
        const use = createOriginButton(rowMeta, { cls: "text-button", text: label("设为当前", "Set as current"), attr: { type: "button", "data-echoink-focus-key": `provider:${saved.id}:activate` } });
        use.onclick = () => void this.runSettingsButtonAction(use, "providers", async () => {
          const result = await this.saveAndActivateProviderModel(saved, "", this.verifiedProviderConnections.get(saved.id) === providerConfigurationFingerprint(saved), saved);
          if (!result.saved) throw new Error(result.message ?? this.copy.providers.saveFailed);
        });
      }
      const edit = createOriginButton(rowMeta, {
        cls: "codex-provider-row-action is-edit",
        text: label("编辑", "Edit"),
        attr: {
          type: "button",
          title: label(`编辑 ${providerDisplayName} · ${modelDisplayName}`, `Edit ${providerDisplayName} · ${modelDisplayName}`),
          "aria-label": label(`编辑 ${providerDisplayName} · ${modelDisplayName}`, `Edit ${providerDisplayName} · ${modelDisplayName}`),
          "data-echoink-focus-key": `provider:${saved.id}:edit`
        }
      });
      applyAmicroButton(edit, { variant: "secondary" });
      edit.onclick = () => {
        this.openProviderModelModal(saved, true);
      };
      const remove = createOriginButton(rowMeta, {
        cls: "codex-provider-row-action is-delete",
        attr: {
          type: "button",
          title: label(`删除 ${providerDisplayName} · ${modelDisplayName}`, `Delete ${providerDisplayName} · ${modelDisplayName}`),
          "aria-label": label(`删除 ${providerDisplayName} · ${modelDisplayName}`, `Delete ${providerDisplayName} · ${modelDisplayName}`),
          "data-echoink-focus-key": `provider:${saved.id}:delete`
        }
      });
      setIcon(remove, "trash-2");
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        message: `${this.copy.providers.deleteConfirm(providerDisplayName)} ${saved.id === active?.id
          ? label("将删除当前使用中的模型。EchoInk 会切换到下一项；若没有其他项，则进入未配置状态。", "The active model will be removed. EchoInk will switch to the next saved model, or become unconfigured if none remains.")
          : label("这会删除已保存的模型配置。", "This removes the saved model configuration.")}`,
        confirmLabel: label("确认删除", "Confirm deletion"), cancelLabel: this.copy.common.cancel,
        onConfirm: () => this.deleteSavedProviderModel(saved.id)
      });
    }

    if (this.plugin.settings.apiProviders.length === 0) {
      const empty = savedList.createDiv({
        cls: "codex-provider-saved-empty"
      });
      const emptyIcon = empty.createSpan();
      setIcon(emptyIcon, "server");
      const emptyCopy = empty.createDiv();
      emptyCopy.createDiv({
        cls: "codex-provider-saved-empty-title",
        text: label("还没有已保存模型", "No saved models yet")
      });
      emptyCopy.createDiv({
        cls: "codex-provider-saved-empty-description",
        text: label(
          "添加第一个 Provider 后，就可以在 EchoInk 对话中使用。",
          "Add a provider to start using it in EchoInk conversations."
        )
      });
    }
  }

  private openInlineEditor(editor: Modal, tab: VisibleSettingsTab, onBack?: () => void): void {
    this.inlineEditor?.dispose();
    const host = this.containerEl.ownerDocument.createElement("div");
    const backLabel = tab === "providers"
      ? (this.plugin.settings.settingsLanguage === "en" ? "Back to saved models" : "返回已保存模型")
      : (this.plugin.settings.settingsLanguage === "en" ? "Back to settings" : "返回设置");
    const dispose = mountSettingsEditor(editor, host, backLabel, () => {
      if (!this.settingsVisible || this.inlineEditor?.host !== host) return;
      this.inlineEditor = null;
      this.renderSettingsContent();
      onBack?.();
    });
    this.inlineEditor = { tab, host, dispose };
    this.renderSettingsContent();
    host.querySelector<HTMLElement>("input, button")?.focus();
  }

  private openProviderModelModal(
    source: ApiProviderConfig,
    editing: boolean
  ): void {
    const editor = new ProviderModelModal({
      app: this.app,
      draft: structuredClone(source),
      editing,
      language: this.plugin.settings.settingsLanguage,
      copy: this.copy,
      preflight: {
        listModels: async (draft) =>
          await this.plugin.listPiProviderModels(draft),
        testConnection: async (draft) =>
          await this.plugin.testPiProviderConnection(draft)
      },
      codexOAuth: {
        status: async () =>
          await this.plugin.getOpenAICodexAuthStatus(),
        login: async (interaction) =>
          await this.plugin.loginOpenAICodex(interaction),
        logout: async () =>
          await this.plugin.logoutOpenAICodex(),
        openExternal: async (url) =>
          await openExternalInElectron(url)
      },
      save: async (draft, apiKey, connectionVerified) =>
        await this.saveAndActivateProviderModel(
          draft,
          apiKey,
          connectionVerified,
          editing ? source : null
        )
    });
    this.openInlineEditor(editor, "providers");
  }

  private async saveAndActivateProviderModel(
    draftInput: ApiProviderConfig,
    apiKeyInput: string,
    connectionVerified = false,
    replacedProvider: ApiProviderConfig | null = null
  ): Promise<ProviderModelSaveResult> {
    const draft = structuredClone(draftInput);
    if (replacedProvider) {
      draft.id = replacedProvider.id;
    } else {
      const usedIds = new Set(
        this.plugin.settings.apiProviders.map((provider) => provider.id)
      );
      do draft.id = newId("provider");
      while (usedIds.has(draft.id));
    }
    const providerId = normalizeApiProviderId(
      draft.providerId,
      draft.baseUrl,
      draft.name
    );
    const preset = getApiProviderPreset(providerId);
    const apiKey = apiKeyInput.trim();
    if (providerId !== "custom") {
      draft.providerId = preset.id;
      draft.runtimeProviderId = preset.runtimeProviderId;
      draft.baseUrl = preset.baseUrl;
      draft.apiProtocol = preset.apiProtocol;
      draft.authMode = preset.authMode;
    }
    try {
      draft.baseUrl = normalizeApiProviderBaseUrl(
        draft.baseUrl,
        draft.apiProtocol
      );
    } catch {
      return { saved: false, message: this.copy.providers.saveFailed };
    }
    draft.name = draft.name.trim().slice(0, 80) || preset.name;
    draft.runtimeProviderId = draft.runtimeProviderId.trim();
    const seenModelIds = new Set<string>();
    draft.models = draft.models.flatMap((model) => {
      const id = model.id.trim();
      if (!id || seenModelIds.has(id)) return [];
      seenModelIds.add(id);
      return [{
        ...model,
        id,
        displayName: model.displayName.trim() || id,
        input: model.input.includes("image")
          ? ["text", "image"] as const
          : ["text"] as const
      }];
    }).map((model) => ({
      ...model,
      input: [...model.input]
    }));
    draft.defaultModelId = draft.defaultModelId.trim();
    draft.apiKey = draft.authMode === "oauth"
      ? ""
      : apiKey || draftInput.apiKey.trim();
    if (
      draft.authMode === "oauth"
      && !this.plugin.settings.openAICodexCredential
    ) {
      return {
        saved: false,
        message: this.plugin.settings.settingsLanguage === "en"
          ? "Sign in with OpenAI before saving this model."
          : "请先使用 OpenAI 登录，再保存该模型。"
      };
    }
    if (!draft.apiKey && apiProviderApiKeyRequired(providerId)) {
      return { saved: false, message: this.copy.providers.missingKey };
    }
    const errors = validateApiProvider(
      draft,
      this.plugin.settings.settingsLanguage
    );
    if (errors.length) {
      return { saved: false, message: this.copy.common.enableFailed(errors) };
    }

    try {
      await this.plugin.activateApiProviderSettings((settings) => {
        if (replacedProvider) {
          const index = settings.apiProviders.findIndex(
            (provider) => provider.id === replacedProvider.id
          );
          if (index < 0) throw new Error("Provider being edited no longer exists");
          settings.apiProviders[index] = structuredClone(draft);
        } else {
          if (settings.apiProviders.some((provider) => provider.id === draft.id)) {
            throw new Error("New Provider settings id already exists");
          }
          settings.apiProviders.push(structuredClone(draft));
        }
        const candidate = settings.apiProviders.find(
          (provider) => provider.id === draft.id
        );
        if (!candidate) throw new Error("Provider candidate missing");
        activateApiProvider(settings, candidate);
      });
      if (connectionVerified) {
        const committed = this.plugin.settings.apiProviders.find(
          (provider) => provider.id === draft.id
        );
        if (committed) {
          this.verifiedProviderConnections.set(
            committed.id,
            providerConfigurationFingerprint(committed)
          );
        }
      } else {
        this.verifiedProviderConnections.delete(draft.id);
      }
      new Notice(this.copy.providers.saved(
        apiProviderConfiguredDisplayName(
          providerId,
          draft.name,
          this.plugin.settings.settingsLanguage
        )
      ));
      this.scheduleDisplay();
      return { saved: true };
    } catch (error) {
      return {
        saved: false,
        message: error instanceof Error ? error.message : this.copy.providers.saveFailed
      };
    }
  }

  private async deleteSavedProviderModel(providerId: string): Promise<void> {
    const provider = this.plugin.settings.apiProviders.find(
      (item) => item.id === providerId
    );
    if (!provider) return;
    const wasActive = this.plugin.settings.activeApiProviderId === providerId;
    const fallback = this.plugin.settings.apiProviders.find(
      (item) => item.id !== providerId && apiProviderHasUsableCredential(
        item,
        this.plugin.settings.openAICodexCredential
      )
    ) ?? null;
    try {
      await this.plugin.activateApiProviderSettings((settings) => {
        settings.apiProviders = settings.apiProviders.filter(
          (item) => item.id !== providerId
        );
        if (!wasActive) return;
        const next = fallback
          ? settings.apiProviders.find((item) => item.id === fallback.id)
          : null;
        if (next) activateApiProvider(settings, next);
        else {
          settings.activeApiProviderId = "";
          settings.defaultModel = "";
        }
      }, wasActive ? (fallback ? "replace" : "suspend") : "preserve");
      const fallbackDisplayName = fallback
        ? apiProviderConfiguredDisplayName(
            normalizeApiProviderId(
              fallback.providerId,
              fallback.baseUrl,
              fallback.name
            ),
            fallback.name,
            this.plugin.settings.settingsLanguage
          )
        : "";
      new Notice(fallback && wasActive
        ? (this.plugin.settings.settingsLanguage === "en"
          ? `Removed. Now using ${fallbackDisplayName} · ${fallback.defaultModelId}.`
          : `已删除，现已切换到 ${fallbackDisplayName} · ${fallback.defaultModelId}。`)
        : (this.plugin.settings.settingsLanguage === "en"
          ? "Saved model removed."
          : "已删除已保存模型。"));
      this.scheduleDisplay();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : this.copy.providers.saveFailed);
    }
  }

  private async loadPersonalMemoryState(force = false): Promise<void> {
    if (this.personalMemoryLoading || (!force && this.personalMemoryState)) return;
    this.personalMemoryLoading = true;
    if (force) this.personalMemoryError = null;
    try {
      this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState();
      this.personalMemoryError = null;
    } catch (error) {
      this.personalMemoryError = error instanceof Error ? error.message : String(error);
    } finally {
      this.personalMemoryLoading = false;
      this.scheduleDisplay();
    }
  }

  private async loadKnowledgePreferenceState(force = false): Promise<void> {
    if (
      this.knowledgePreferenceLoading
      || (!force && this.knowledgePreferenceState && this.knowledgePreferenceEditor)
    ) return;
    this.knowledgePreferenceLoading = true;
    this.knowledgePreferenceLoadError = null;
    this.scheduleDisplay();
    try {
      const state =
        await this.plugin.getEchoInkKnowledgeMaintenancePreferenceState();
      this.knowledgePreferenceState = state;
      this.knowledgePreferenceEditor =
        createKnowledgeMaintenancePreferenceEditor(state);
    } catch {
      this.knowledgePreferenceLoadError =
        this.plugin.settings.settingsLanguage === "en"
          ? "Knowledge refinement preferences could not be loaded."
          : "知识提炼偏好读取失败。";
    } finally {
      this.knowledgePreferenceLoading = false;
      this.scheduleDisplay();
    }
  }

  private async saveKnowledgePreference(draftContent: string): Promise<void> {
    const current = this.knowledgePreferenceEditor;
    if (!current || current.saving) return;
    const edited = editKnowledgeMaintenancePreference(current, draftContent);
    if (!knowledgeMaintenancePreferenceIsDirty(edited)) return;
    this.knowledgePreferenceEditor =
      beginSavingKnowledgeMaintenancePreference(edited);
    this.settingsFocusIntent = "explicit:knowledge:preferences:save";
    this.scheduleDisplay();
    try {
      const state = await this.plugin.saveEchoInkKnowledgeMaintenancePreferences(
        edited.draftContent,
        edited.expectedRevision
      );
      this.knowledgePreferenceState = state;
      this.knowledgePreferenceEditor =
        createKnowledgeMaintenancePreferenceEditor(state);
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Knowledge refinement preferences saved."
        : "知识提炼偏好已保存。";
      this.announceSettingsStatus(message);
      new Notice(message);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      const message = this.plugin.settings.settingsLanguage === "en"
        ? code === "revision_conflict"
          ? "Preferences changed in another window. Copy your draft, reload, and reconcile before saving."
          : code === "invalid_content"
            ? "Preferences must contain valid text and remain within 64 KiB."
            : "Preferences could not be saved. Existing content was not overwritten."
        : code === "revision_conflict"
          ? "偏好已在另一个窗口变化。请先复制当前草稿，重新加载并合并后再保存。"
          : code === "invalid_content"
            ? "偏好必须是有效非空文本，且不超过 64 KiB。"
            : "知识提炼偏好保存失败，现有内容未被覆盖。";
      this.knowledgePreferenceEditor =
        failSavingKnowledgeMaintenancePreference(edited, message);
      this.announceSettingsStatus(message);
    } finally {
      this.scheduleDisplay();
    }
  }

  private resetKnowledgePreferenceDraft(): void {
    const state = this.knowledgePreferenceState;
    this.knowledgePreferenceEditor = state
      ? createKnowledgeMaintenancePreferenceEditor(state)
      : null;
  }

  private async confirmKnowledgePreferenceDiscard(): Promise<boolean> {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    return await confirmModal(
      this.app,
      zh ? "有未保存的知识提炼偏好" : "Unsaved refinement preferences",
      zh
        ? "离开会舍弃当前未保存修改。继续编辑可以返回设置页保存。"
        : "Leaving will discard the current unsaved changes. Continue editing to return and save them.",
      zh ? "舍弃修改" : "Discard changes",
      zh ? "继续编辑" : "Continue editing"
    );
  }

  private addProviderText(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => Promise<void>,
    type: "text" | "password" = "text"
  ): void {
    const setting = new OriginSetting(container).setName(label).addOriginText((text) => {
      text.setPlaceholder(placeholder).setValue(value).onChange(onChange);
      text.inputEl.type = type;
      text.inputEl.setAttr("aria-label", label);
    });
    this.decorateSetting(setting, type === "password" ? "key-round" : "text-cursor-input");
  }

  private renderWorkspaceResourceManager(container: HTMLElement): void {
    const copy = this.copy;
    const detailId = typeof this.settingsDetail === "object"
      && this.settingsDetail?.kind === "resource"
      ? this.settingsDetail.resourceId
      : "";
    if (detailId) {
      const resource = this.currentEchoInkResourceCatalog().find((item) => item.id === detailId);
      if (resource) {
        this.renderResourceDetail(container, resource);
        return;
      }
      this.settingsDetail = null;
    }
    const page = createSettingsPage(container, {
      title: copy.resources.title,
      headingId: RESOURCE_TITLE_ID,
      description: copy.resources.note
    });
    page.addClass("echoink-resources-page");
    this.renderSettingsActionError(page, "resources");
    const wrapper = page.createDiv({ cls: "codex-resource-manager" });
    const activeTab = this.plugin.settings.resourceManagementTab;
    const controls = wrapper.createDiv({ cls: "codex-resource-controls" });
    const tabs = controls.createDiv({
      cls: "codex-resource-tabs",
      attr: {
        role: "tablist",
        "aria-labelledby": RESOURCE_TITLE_ID,
        "aria-orientation": "horizontal"
      }
    });
    const toolbar = controls.createDiv({ cls: "codex-resource-toolbar" });
    let activeButton: HTMLButtonElement | null = null;
    RESOURCE_TABS.forEach((tab, index) => {
      const label = copy.resources.tabs[tab.id];
      const isActive = activeTab === tab.id;
      const button = createOriginButton(tabs, {
        cls: `codex-resource-tab ${isActive ? "is-active" : ""}`,
        attr: {
          id: resourceTabDomId(tab.id),
          type: "button",
          role: "tab",
          "data-resource-tab": tab.id,
          "data-echoink-focus-key": `resource-tab:${tab.id}`,
          "aria-selected": String(isActive),
          "aria-controls": RESOURCE_PANEL_ID,
          tabindex: isActive ? "0" : "-1"
        }
      });
      const icon = button.createSpan({ cls: "settings-motion-icon" });
      const iconName = tab.id === "plugins" ? "package" : tab.id === "mcp" ? "blocks" : "sparkles";
      renderAnimatedSettingsTabIcon(icon, iconName, null);
      button.onmouseenter = () => renderAnimatedSettingsTabIcon(icon, iconName, 0);
      button.onfocus = () => renderAnimatedSettingsTabIcon(icon, iconName, 0);
      button.createSpan({ text: label });
      if (isActive) activeButton = button;
      button.onpointerdown = () => {
        this.resourceTabPointerActivated = true;
      };
      button.onclick = () => {
        const restoreKeyboardFocus = !this.resourceTabPointerActivated;
        this.resourceTabPointerActivated = false;
        if (activeTab === tab.id) return;
        void this.activateResourceTab(tab.id, restoreKeyboardFocus);
      };
      button.onkeydown = (event) => {
        const nextIndex = tabIndexFromKeyboard(event.key, index, RESOURCE_TABS.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateResourceTab(RESOURCE_TABS[nextIndex].id, true);
      };
    });
    this.renderResourceSearch(toolbar, activeTab);
    const toolbarActions = toolbar.createDiv({ cls: "codex-resource-toolbar-actions" });
    if (activeTab === "mcp") {
      const add = createOriginButton(toolbarActions, {
        cls: "codex-resource-add",
        attr: {
          type: "button",
          "aria-label": this.plugin.settings.settingsLanguage === "en" ? "Add MCP server" : "新增 MCP Server",
          "data-echoink-focus-key": "resources:mcp:add"
        }
      });
      applyAmicroButton(add, { variant: "secondary", motion: "slide", icon: "plus" });
      add.createSpan({ text: this.plugin.settings.settingsLanguage === "en" ? "Add server" : "新增 Server" });
      add.onclick = () => this.openMcpServerModal();
    }
    const refresh = createOriginButton(toolbarActions, {
      cls: "codex-resource-refresh",
      attr: { type: "button", "aria-label": copy.resources.refreshTitle, "data-echoink-focus-key": "resources:refresh" }
    });
    applyAmicroButton(refresh, { variant: "secondary", motion: "rotate", icon: "refresh-cw" });
    refresh.createSpan({ text: this.resourceLoadingTab === this.plugin.settings.resourceManagementTab ? copy.common.loading : copy.common.refresh });
    refresh.disabled = this.resourceLoadingTab === this.plugin.settings.resourceManagementTab;
    refresh.onclick = () => void this.loadWorkspaceResources(true, this.plugin.settings.resourceManagementTab);

    const english = this.plugin.settings.settingsLanguage === "en";
    wrapper.createEl("p", {
      cls: "settings-note resources-tab-hint",
      text: activeTab === "plugins"
        ? (english ? "Manage tool bundles available to EchoInk." : "管理可供 EchoInk 使用的工具包。")
        : activeTab === "mcp"
          ? (english ? "Connect external services and manage server and tool availability." : "连接外部服务，并管理 Server 与 Tool 的可用范围。")
          : (english ? "Manage how the Agent approaches tasks. Enable or adjust instructions as needed." : "管理 Agent 处理问题的方式，按需要启用或调整指令。")
    });

    const activeMeta = RESOURCE_TABS.find((tab) => tab.id === activeTab);
    const isLoading = this.resourceLoadingTab === activeTab;
    const loadError = this.resourceLoadErrors[activeTab] ?? "";
    const body = wrapper.createDiv({
      cls: "codex-resource-body",
      attr: {
        id: RESOURCE_PANEL_ID,
        role: "tabpanel",
        "aria-labelledby": resourceTabDomId(activeTab),
        tabindex: "0",
        "aria-busy": String(isLoading)
      }
    });
    if (isLoading) {
      createSettingsState(body, copy.resources.loadingTab(activeMeta ? copy.resources.tabs[activeMeta.id] : copy.tabs.resources));
    }
    if (loadError) {
      createSettingsState(
        body,
        this.plugin.settings.settingsLanguage === "en"
          ? "Resources could not be synchronized. Check the current Vault configuration and refresh this list."
          : "资源同步未完成。请检查当前 Vault 配置后刷新列表。",
        "error"
      );
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) {
      createSettingsState(body, copy.resources.notLoaded);
    }
    const hasSavedCatalog = this.currentEchoInkResourceCatalog(this.resourceSnapshot).some((resource) => resource.kind === resourceKindForResourceTab(activeTab));
    if ((this.resourceSnapshot || hasSavedCatalog) && (this.resourceLoaded[activeTab] || isLoading || hasSavedCatalog)) {
      this.renderActiveResourceTab(body, this.resourceSnapshot ?? emptyWorkspaceResourceSnapshot());
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) void this.loadWorkspaceResources(false, activeTab);

    if (this.suppressResourceTabFocusRestore) {
      this.suppressResourceTabFocusRestore = false;
    } else if (activeButton) {
      const tabButton = activeButton as HTMLButtonElement;
      (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
        if (!tabButton.isConnected) return;
        tabButton.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (this.resourceTabFocusId !== activeTab) return;
        tabButton.focus();
        (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
          if (
            tabButton.isConnected
            && this.containerEl.ownerDocument.activeElement === tabButton
            && this.resourceTabFocusId === activeTab
          ) {
            this.resourceTabFocusId = null;
          }
        });
      });
    }
  }

  private renderResourceDetail(container: HTMLElement, resource: EchoInkResource): void {
    const english = this.plugin.settings.settingsLanguage === "en";
    const page = createSettingsPage(container, {
      title: resource.kind === "skill" ? `/${resource.name}` : resource.name,
      description: resource.description || (english ? "Resource details" : "资源详情"),
      detail: true,
      backLabel: english ? "Back to Skills and MCP" : "返回 Skills 与 MCP",
      onBack: () => {
        void this.closeSettingsDetail();
      }
    });
    page.addClass("echoink-resource-detail");
    this.renderSettingsActionError(page, "resources");
    const connectionStatus = resource.kind === "mcp-server"
      ? mcpConnectionStatus(resource, this.plugin.settings.resources)
      : "not-mcp";
    if (resource.kind !== "mcp-server") {
      const status = createSettingsSection(page, {
        title: resource.name,
        description: resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage),
        surface: "group"
      });
      status.addClass("resources-detail-status");
      const statusActions = status.querySelector<HTMLElement>(".settings-card-header")!.createDiv({ cls: "resources-status-actions" });
      statusActions.createSpan({ cls: `status ${resource.enabled ? "healthy" : "neutral"}`, text: resource.enabled
        ? (english ? "Enabled" : "已启用") : (english ? "Disabled" : "已停用") });
      if (resource.kind === "skill") {
        const toggle = createOriginSwitch(statusActions, { cls: "codex-resource-toggle", attr: {
          type: "checkbox", "aria-label": english ? `Enable ${resource.name}` : `启用 ${resource.name}`,
          "data-echoink-focus-key": `resource:${resource.id}:enabled`
        } });
        toggle.checked = resource.enabled;
        toggle.onchange = async () => {
          toggle.disabled = true;
          try {
            await this.plugin.setEchoInkSkillResourceEnabled(resource.id, toggle.checked);
            toggle.checked = this.plugin.settings.resources.catalog.find((item) => item.id === resource.id)?.enabled ?? false;
            this.scheduleDisplay();
          } catch {
            toggle.checked = this.plugin.settings.resources.catalog.find((item) => item.id === resource.id)?.enabled ?? resource.enabled;
            const message = english ? "The resource setting was not saved." : "资源开关未保存，请重试。";
            new Notice(message);
            this.announceSettingsStatus(message);
          } finally { toggle.disabled = false; }
        };
      }
      const path = resource.contentPath ?? resource.configPath ?? "";
      if (path) {
        const pathRow = status.createDiv({ cls: "resources-path" });
        pathRow.createSpan({ text: english ? "File location" : "文件位置" });
        const pathButton = createOriginButton(pathRow, {
          cls: "codex-copyable-value resource-status-path",
          attr: {
            type: "button",
            "aria-label": english ? `Copy full path: ${path}` : `复制完整路径：${path}`,
            "data-echoink-focus-key": `resource:${resource.id}:path`
          }
        });
        pathButton.createSpan({ cls: "resource-status-path-label", text: path });
        applyAmicroButton(pathButton, {
          variant: "tertiary",
          motion: "complete",
          icon: "copy"
        });
        pathButton.onclick = () => void this.copySettingsValue(path, pathButton);
      }
    }
    const builtinSkillId = builtinSkillIdForResource(resource);
    if (builtinSkillId) {
      this.renderBuiltinSkillEditor(page, resource, builtinSkillId);
    }
    if (resource.kind === "mcp-server") {
      const connection = resolveMcpConnectionRecord(resource, this.plugin.settings.resources);
      const actions = createSettingsSection(page, {
        title: english ? "Connection" : "连接",
        description: english
          ? "Configure the transport first, then verify the tools EchoInk can call."
          : "先补全传输配置，再验证 EchoInk 可以调用的工具。",
        surface: "group"
      });
      actions.addClass("echoink-resource-connection");
      actions.querySelector<HTMLElement>(".settings-card-header")!.createSpan({
        cls: `status ${connectionStatus === "verified" ? "healthy" : "neutral"}`,
        text: mcpConnectionStatusLabel(connectionStatus, this.plugin.settings.settingsLanguage)
      });
      const actionGroup = createSettingsGroup(actions);
      const diagnostic = connection?.diagnostic;
      if (diagnostic) {
        createSettingsState(
          actionGroup,
          english
            ? `${mcpDiagnosticLabel(diagnostic.code, true)}: ${diagnostic.message}`
            : `${mcpDiagnosticLabel(diagnostic.code, false)}：${diagnostic.message}`,
          "error"
        );
      }
      if (connection) {
        const summary = actionGroup.createDiv({ cls: "resources-connection-summary" });
        summary.createSpan({ cls: "settings-badge", text: connection.transport === "http" ? "HTTP" : "stdio" });
        summary.createEl("code", { text: mcpConnectionSummary(connection, english).replace(/^(HTTP|stdio) · /u, "") });
        actionGroup.createEl("p", { cls: "settings-note resources-credential-note", text: mcpCredentialConfigured(connection)
          ? (english ? "Credential saved securely; the secret is not displayed." : "Credential 已安全保存，Secret 不会回显。")
          : (english ? "No credential is configured." : "尚未配置 Credential。") });
        this.renderMcpSettingsToggle(actionGroup, {
          title: english ? "Enable server" : "启用 Server",
          description: english
            ? "Controls whether this server is available to EchoInk."
            : "控制此 Server 是否可供 EchoInk 使用。",
          checked: resource.enabled,
          focusKey: `resource:${resource.id}:enabled`,
          action: async (enabled) => await this.plugin.setEchoInkMcpServerEnabled(resource.id, enabled)
        });
        this.renderMcpSettingsToggle(actionGroup, {
          title: english ? "Trust server" : "信任 Server",
          description: english
            ? "Admits individually trusted tools. Side-effect tools still require approval."
            : "允许逐个信任的 Tool 进入 Pi；有副作用 Tool 仍必须审批。",
          checked: connection.trusted,
          focusKey: `resource:${resource.id}:trusted`,
          action: async (trusted) => await this.plugin.setEchoInkMcpServerTrusted(resource.id, trusted)
        });
      }
      const row = actionGroup.createDiv({ cls: "echoink-settings-action-row resources-connection-actions" });
      this.renderMcpConnectionActions(row, resource, connectionStatus);

      const toolsSection = createSettingsSection(page, {
        title: english ? "Tools" : "Tools",
        description: english
          ? "Enable and trust each discovered tool. Read-only tools run directly; side effects always use approval and Receipt."
          : "逐个启用并信任发现到的 Tool。只读 Tool 直调；有副作用 Tool 始终经过审批与 Receipt。",
        surface: "group"
      });
      toolsSection.addClass("echoink-resource-tools");
      toolsSection.querySelector<HTMLElement>(".settings-card-header")!.createSpan({ cls: "settings-badge", text: english
        ? `${connection?.tools.length ?? 0} tools` : `${connection?.tools.length ?? 0} 个工具` });
      const toolsGroup = createSettingsGroup(toolsSection);
      if (!connection?.tools.length) {
        this.renderResourceEmpty(toolsGroup,
          english ? "No verified tools yet" : "尚无已验证的 Tool 清单",
          english ? "Complete the configuration and test the connection to discover tools." : "补全配置并测试连接后，会展示发现到的工具。", "blocks");
      } else {
        for (const tool of connection.tools) {
          const policy = mcpToolPolicy(connection, tool);
          const toolRow = toolsGroup.createDiv({ cls: "codex-mcp-tool-policy-row" });
          const toolCopy = toolRow.createDiv({ cls: "codex-mcp-tool-policy-copy" });
          const heading = toolCopy.createDiv({ cls: "codex-mcp-tool-policy-heading" });
          heading.createSpan({ cls: "codex-mcp-tool-policy-name", text: tool.name });
          heading.createSpan({
            cls: `codex-mcp-tool-effect is-${tool.readOnly ? "read" : tool.destructive ? "destructive" : "write"}`,
            text: tool.readOnly
              ? (english ? "Read only" : "只读")
              : tool.destructive
                ? (english ? "Destructive" : "破坏性")
                : (english ? "Approval required" : "需审批")
          });
          if (tool.description) {
            toolCopy.createDiv({ cls: "codex-mcp-tool-policy-description", text: tool.description });
          }
          if (tool.readback) {
            toolCopy.createDiv({
              cls: "codex-mcp-tool-policy-readback",
              text: english
                ? `Readback: ${tool.readback.toolName}`
                : `Readback：${tool.readback.toolName}`
            });
          }
          const controls = toolRow.createDiv({ cls: "codex-mcp-tool-policy-controls" });
          this.renderMcpCompactToggle(controls, {
            label: english ? "Enabled" : "启用",
            checked: policy.enabled,
            focusKey: `resource:${resource.id}:tool:${tool.name}:enabled`,
            action: async (enabled) => await this.plugin.setEchoInkMcpToolPolicy(resource.id, tool.name, { enabled })
          });
          this.renderMcpCompactToggle(controls, {
            label: english ? "Trusted" : "信任",
            checked: policy.trusted,
            focusKey: `resource:${resource.id}:tool:${tool.name}:trusted`,
            action: async (trusted) => await this.plugin.setEchoInkMcpToolPolicy(resource.id, tool.name, { trusted })
          });
        }
      }
    }
  }

  private renderBuiltinSkillEditor(
    page: HTMLElement,
    resource: EchoInkResource,
    skillId: BuiltinSkillId
  ): void {
    const english = this.plugin.settings.settingsLanguage === "en";
    const section = createSettingsSection(page, {
      title: english ? "Skill instructions" : "Skill 指令",
      description: english
        ? "Edit the complete SKILL.md used by EchoInk. Saving marks this built-in Skill as customized."
        : "编辑 EchoInk 实际使用的完整 SKILL.md；保存后会标记为“已自定义”。",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    const editor = this.builtinSkillEditor;
    if (
      !editor
      || editor.resourceId !== resource.id
      || editor.skillId !== skillId
    ) {
      createSettingsState(
        group,
        english ? "Loading SKILL.md…" : "正在读取 SKILL.md…"
      );
      if (!editor || editor.resourceId !== resource.id) {
        this.loadBuiltinSkillEditor(resource.id, skillId);
      }
      return;
    }
    if (editor.loading) {
      createSettingsState(
        group,
        english ? "Loading SKILL.md…" : "正在读取 SKILL.md…"
      );
      return;
    }
    if (!editor.snapshot) {
      createSettingsState(
        group,
        english
          ? "SKILL.md could not be read. Reload it before editing so existing content is not overwritten."
          : "SKILL.md 暂时无法读取。为避免覆盖现有内容，请先重新加载。",
        "error",
        {
          label: english ? "Reload" : "重新加载",
          onActivate: () => this.loadBuiltinSkillEditor(resource.id, skillId)
        }
      );
      if (editor.error) {
        group.createDiv({
          cls: "codex-settings-inline-error is-visible",
          text: editor.error,
          attr: { role: "alert" }
        });
      }
      return;
    }

    const snapshot = editor.snapshot;
    if (snapshot.fileStatus !== "ready") {
      createSettingsState(
        group,
        builtinSkillFileStateText(snapshot.fileStatus, english),
        "error"
      );
    }
    const row = applySettingsRow(new OriginSetting(group)
      .setName("SKILL.md")
      .setDesc(english
        ? "This Vault file is the single source used for installation, editing, validation, and model runs."
        : "这份 Vault 文件是安装、编辑、有效性检查和模型运行共同使用的唯一真源。")
      .setClass("echoink-personalization-instruction-row")
      .setClass("echoink-builtin-skill-editor-row"));
    disposeOriginControls(row.controlEl);
    row.controlEl.empty();
    const textarea = row.controlEl.createEl("textarea", {
      cls: "echoink-personalization-textarea echoink-builtin-skill-textarea",
      attr: {
        rows: "20",
        maxlength: "200000",
        spellcheck: "false",
        "aria-label": english
          ? `${skillId} complete SKILL.md`
          : `${skillId} 完整 SKILL.md`,
        "data-echoink-focus-key": `resource:${resource.id}:skill-editor`
      }
    });
    textarea.value = editor.draftContent;
    const footer = row.controlEl.createDiv({ cls: "resources-editor-footer" });
    const status = footer.createDiv({
      cls: "echoink-knowledge-preference-status echoink-builtin-skill-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    const characters = footer.createEl("output", { cls: "echoink-skill-character-count" });
    const error = row.controlEl.createDiv({
      cls: "codex-settings-inline-error echoink-builtin-skill-error",
      attr: { role: "alert" }
    });
    const actions = row.controlEl.createDiv({
      cls: "echoink-personalization-actions echoink-skill-editor-actions"
    });
    const restore = createOriginButton(actions, {
      text: english ? "Restore EchoInk default" : "恢复 EchoInk 默认",
      attr: {
        type: "button",
        "data-echoink-focus-key": `resource:${resource.id}:skill-restore`
      }
    });
    const save = createOriginButton(actions, {
      cls: "echoink-settings-save-button",
      text: english ? "Save" : "保存",
      attr: {
        type: "button",
        "data-echoink-focus-key": `resource:${resource.id}:skill-save`
      }
    });

    const syncControls = (): void => {
      const current = this.builtinSkillEditor;
      if (!current || current.resourceId !== resource.id || !current.snapshot) return;
      const dirty = current.draftContent !== current.snapshot.content;
      characters.setText(english ? `${current.draftContent.length.toLocaleString("en-US")} characters` : `${current.draftContent.length.toLocaleString("zh-CN")} 字符`);
      const stateText = current.snapshot.fileStatus === "ready"
        ? current.snapshot.userModified
          ? (english ? "Customized" : "已自定义")
          : (english ? "EchoInk default" : "EchoInk 默认")
        : builtinSkillFileStateText(current.snapshot.fileStatus, english);
      status.setText([
        stateText,
        dirty ? (english ? "Unsaved changes" : "有未保存修改") : (english ? "Saved" : "已保存"),
        current.saving ? (english ? "Saving…" : "正在保存…") : ""
      ].filter(Boolean).join(" · "));
      error.setText(current.error);
      error.toggleClass("is-visible", Boolean(current.error));
      textarea.setAttr("aria-invalid", String(Boolean(current.error)));
      textarea.disabled = current.saving;
      save.disabled = current.saving
        || !dirty
        || current.snapshot.fileStatus === "missing";
      restore.disabled = current.saving
        || (
          current.snapshot.fileStatus === "ready"
          && !current.snapshot.userModified
          && !dirty
        );
      save.toggleClass("mod-cta", !save.disabled);
    };

    textarea.oninput = () => {
      const current = this.builtinSkillEditor;
      if (!current || current.resourceId !== resource.id || current.saving) return;
      current.draftContent = textarea.value;
      current.error = "";
      syncControls();
    };
    save.onclick = () => void this.saveBuiltinSkillEditor(resource.id);
    restore.onclick = () => void this.restoreBuiltinSkillEditor(resource.id);
    syncControls();
  }

  private async saveBuiltinSkillEditor(resourceId: string): Promise<void> {
    const editor = this.builtinSkillEditor;
    if (!editor || editor.resourceId !== resourceId || !editor.snapshot || editor.saving) return;
    editor.saving = true;
    editor.error = "";
    this.scheduleDisplay();
    try {
      const snapshot = await this.plugin.saveEchoInkBuiltinSkill(
        editor.skillId,
        editor.draftContent
      );
      if (this.builtinSkillEditor !== editor) return;
      editor.snapshot = snapshot;
      editor.draftContent = snapshot.content;
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Skill instructions saved."
        : "Skill 指令已保存。";
      new Notice(message);
      this.announceSettingsStatus(message);
      await this.loadWorkspaceResources(true, "skills");
    } catch (error) {
      if (this.builtinSkillEditor !== editor) return;
      editor.error = error instanceof Error ? error.message : String(error);
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Skill instructions were not saved. Check the document and try again."
        : "Skill 指令未保存。请检查文档后重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } finally {
      if (this.builtinSkillEditor === editor) {
        editor.saving = false;
        this.scheduleDisplay();
      }
    }
  }

  private async restoreBuiltinSkillEditor(resourceId: string): Promise<void> {
    const editor = this.builtinSkillEditor;
    if (!editor || editor.resourceId !== resourceId || !editor.snapshot || editor.saving) return;
    const english = this.plugin.settings.settingsLanguage === "en";
    const accepted = await confirmModal(
      this.app,
      english ? "Restore EchoInk default?" : "恢复 EchoInk 默认？",
      english
        ? "This replaces the current SKILL.md content with the default included in this EchoInk version. The Skill enable switch is not changed."
        : "这会把当前 SKILL.md 内容替换为本版本 EchoInk 自带的默认内容，不会改变 Skill 的启用开关。",
      english ? "Restore default" : "恢复默认",
      english ? "Cancel" : "取消"
    );
    if (!accepted || this.builtinSkillEditor !== editor) return;
    editor.saving = true;
    editor.error = "";
    this.scheduleDisplay();
    try {
      const snapshot = await this.plugin.restoreEchoInkBuiltinSkill(editor.skillId);
      if (this.builtinSkillEditor !== editor) return;
      editor.snapshot = snapshot;
      editor.draftContent = snapshot.content;
      const message = english
        ? "EchoInk default restored."
        : "已恢复 EchoInk 默认。";
      new Notice(message);
      this.announceSettingsStatus(message);
      await this.loadWorkspaceResources(true, "skills");
    } catch (error) {
      if (this.builtinSkillEditor !== editor) return;
      editor.error = error instanceof Error ? error.message : String(error);
      const message = english
        ? "The default Skill could not be restored."
        : "默认 Skill 恢复失败，请重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } finally {
      if (this.builtinSkillEditor === editor) {
        editor.saving = false;
        this.scheduleDisplay();
      }
    }
  }

  private renderMcpSettingsToggle(container: HTMLElement, options: {
    title: string;
    description: string;
    checked: boolean;
    focusKey: string;
    action: (checked: boolean) => Promise<void>;
  }): void {
    const row = container.createDiv({ cls: "codex-mcp-server-toggle-row" });
    const copy = row.createDiv({ cls: "codex-mcp-server-toggle-copy" });
    copy.createDiv({ cls: "codex-mcp-server-toggle-title", text: options.title });
    copy.createDiv({ cls: "codex-mcp-server-toggle-description", text: options.description });
    const toggle = createOriginSwitch(row, {
      attr: {
        type: "checkbox",
        "aria-label": options.title,
        "data-echoink-focus-key": options.focusKey
      }
    });
    toggle.checked = options.checked;
    toggle.onchange = () => void this.runMcpToggleAction(toggle, options.action);
  }

  private renderMcpCompactToggle(container: HTMLElement, options: {
    label: string;
    checked: boolean;
    focusKey: string;
    action: (checked: boolean) => Promise<void>;
  }): void {
    const label = container.createEl("label", { cls: "codex-mcp-tool-policy-toggle" });
    label.createSpan({ text: options.label });
    const toggle = createOriginSwitch(label, {
      attr: { type: "checkbox", "data-echoink-focus-key": options.focusKey }
    });
    toggle.checked = options.checked;
    toggle.onchange = () => void this.runMcpToggleAction(toggle, options.action);
  }

  private async runMcpToggleAction(
    toggle: OriginCheckElement,
    action: (checked: boolean) => Promise<void>
  ): Promise<void> {
    const next = toggle.checked;
    toggle.disabled = true;
    try {
      await action(next);
      this.scheduleDisplay();
    } catch {
      toggle.checked = !next;
      toggle.disabled = false;
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "The MCP setting was not saved."
        : "MCP 设置未保存，请重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    }
  }

  private async activateResourceTab(
    tabId: ResourceManagementTab,
    focus: boolean
  ): Promise<void> {
    if (this.plugin.settings.resourceManagementTab === tabId) return;
    this.resourceTabFocusId = focus ? tabId : null;
    this.suppressResourceTabFocusRestore = !focus;
    this.plugin.settings.resourceManagementTab = tabId;
    await this.plugin.saveSettings();
    this.scheduleDisplay();
  }

  private renderResourceSearch(container: HTMLElement, tab: ResourceManagementTab): void {
    const copy = this.copy;
    const searchWrap = container.createDiv({ cls: "codex-resource-search" });
    const icon = searchWrap.createSpan({ cls: "codex-resource-search-icon" });
    setIcon(icon, "search");
    const input = createOriginInput(searchWrap, {
      cls: "codex-resource-search-input",
      attr: {
        type: "search",
        placeholder: copy.resources.searchPlaceholder(copy.resources.tabs[tab]),
        "aria-label": copy.resources.searchAria,
        "data-echoink-focus-key": `resources:search:${tab}`
      }
    });
    input.value = this.resourceSearchQuery[tab];
    const clear = createOriginButton(searchWrap, {
      cls: "codex-resource-search-clear",
      attr: { type: "button", "aria-label": copy.resources.clearSearch, "data-echoink-focus-key": `resources:clear:${tab}` }
    });
    setIcon(clear, "x");
    clear.hidden = !input.value;
    input.oninput = () => {
      this.resourceSearchQuery[tab] = input.value;
      clear.hidden = !input.value;
      this.scheduleResourceSearchFilter(tab);
    };
    clear.onclick = () => {
      input.value = "";
      this.resourceSearchQuery[tab] = "";
      clear.hidden = true;
      this.clearResourceSearchDebounceTimer();
      this.applyResourceSearchFilter(tab);
      input.focus();
    };
  }

  private scheduleResourceSearchFilter(tab: ResourceManagementTab): void {
    this.clearResourceSearchDebounceTimer();
    this.resourceSearchDebounceTimer = (this.containerEl.ownerDocument.defaultView ?? window).setTimeout(() => {
      this.resourceSearchDebounceTimer = null;
      this.applyResourceSearchFilter(tab);
    }, 120);
  }

  private clearResourceSearchDebounceTimer(): void {
    if (this.resourceSearchDebounceTimer === null) return;
    (this.containerEl.ownerDocument.defaultView ?? window).clearTimeout(this.resourceSearchDebounceTimer);
    this.resourceSearchDebounceTimer = null;
  }

  private applyResourceSearchFilter(tab: ResourceManagementTab): void {
    if (this.plugin.settings.resourceManagementTab !== tab) return;
    const body = this.containerEl.querySelector<HTMLElement>(".codex-resource-body");
    if (!body) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".codex-resource-row[data-resource-key]")).map((row) => ({
      key: row.dataset.resourceKey ?? "",
      name: row.dataset.resourceName ?? "",
      meta: row.dataset.resourceMeta ?? "",
      desc: row.dataset.resourceDesc ?? "",
      row
    }));
    const query = this.resourceSearchQuery[tab];
    const visibleKeys = new Set(filterWorkspaceResourceRows(rows, query).map((row) => row.key));
    let visible = 0;
    for (const row of rows) {
      const shouldShow = visibleKeys.has(row.key);
      row.row.toggleClass("is-search-hidden", !shouldShow);
      if (shouldShow) visible += 1;
    }
    const summary = body.querySelector<HTMLElement>("[data-resource-summary]");
    const total = Number(summary?.dataset.resourceTotal ?? rows.length);
    const enabled = Number(summary?.dataset.resourceEnabled ?? 0);
    if (summary) {
      const label = this.copy.resources.tabs[tab];
      summary.querySelector<HTMLElement>(".codex-resource-summary-count")?.setText(resourceSummaryText(
        this.plugin.settings.settingsLanguage,
        label,
        enabled,
        total,
        visible,
        Boolean(query.trim())
      ));
    }
    if (summary) this.announceSettingsStatus(summary.textContent ?? "");
    const empty = body.querySelector<HTMLElement>("[data-resource-search-empty]");
    if (empty) empty.hidden = !query.trim() || visible > 0;
  }

  private currentEchoInkResourceCatalog(snapshot: WorkspaceResourceSnapshot | null = this.resourceSnapshot): EchoInkResource[] {
    void snapshot;
    return buildActiveEchoInkResourceCatalog({
      settings: this.plugin.settings.resources,
      manual: this.runtimeEchoInkResources
    });
  }

  private renderActiveResourceTab(container: HTMLElement, snapshot: WorkspaceResourceSnapshot): void {
    const catalog = this.currentEchoInkResourceCatalog(snapshot);
    if (this.plugin.settings.resourceManagementTab === "plugins") {
      this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "tool-bundle"), snapshot.errors.plugins);
      return;
    }
    if (this.plugin.settings.resourceManagementTab === "mcp") {
      this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "mcp-server"), snapshot.errors.mcp);
      return;
    }
    this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "skill"), snapshot.errors.skills);
  }

  private renderEchoInkResources(container: HTMLElement, resources: EchoInkResource[], error?: string): void {
    const copy = this.copy;
    const activeTab = this.plugin.settings.resourceManagementTab;
    const rows = resources.map((resource) => ({
      key: resource.id,
      name: resource.kind === "skill" ? `/${resource.name}` : resource.name,
      meta: resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage),
      desc: resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc,
      resource
    }));
    const query = this.resourceSearchQuery[activeTab];
    const enabled = resources.filter((resource) => resource.enabled).length;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(
      container,
      resources.length,
      enabled,
      error,
      filtered.length,
      query,
      copy.resources.tabs[activeTab]
    );
    if (!resources.length) {
      const emptyText = activeTab === "plugins" ? copy.resources.noPlugins : activeTab === "mcp" ? copy.resources.noMcp : copy.resources.noSkills;
      this.renderResourceEmpty(container, emptyText, resourceEmptyNextStep(activeTab, this.plugin.settings.settingsLanguage), "layers");
      return;
    }
    const emptyText = activeTab === "plugins" ? copy.resources.noPluginMatches : activeTab === "mcp" ? copy.resources.noMcpMatches : copy.resources.noSkillMatches;
    const empty = this.renderResourceEmpty(container, emptyText,
      this.plugin.settings.settingsLanguage === "en" ? "Try another keyword from the resource name or description." : "试试资源名称或描述中的另一个关键词。", "search");
    empty.setAttr("data-resource-search-empty", "true");
    empty.hidden = filtered.length > 0;
    const clear = createOriginButton(empty, { cls: "text-button", text: copy.resources.clearSearch });
    clear.onclick = () => this.containerEl.querySelector<HTMLButtonElement>(".codex-resource-search-clear")?.click();
    const visibleKeys = new Set(filtered.map((row) => row.key));
    for (const row of rows) this.renderResourceRow(container, row.resource, visibleKeys.has(row.key), row);
  }

  private renderResourceEmpty(container: HTMLElement, title: string, description: string, icon: string): HTMLElement {
    const empty = container.createDiv({ cls: "settings-empty resources-empty" });
    setIcon(empty.createSpan({ cls: "resources-empty-icon" }), icon);
    empty.createDiv({ cls: "settings-empty-title", text: title, attr: { role: "heading", "aria-level": "3" } });
    empty.createEl("p", { text: description });
    return empty;
  }

  private renderResourceSummary(
    container: HTMLElement,
    total: number,
    enabled: number,
    error?: string,
    visible = total,
    query = "",
    label = this.copy.tabs.resources
  ): void {
    const copy = this.copy;
    const searching = Boolean(query.trim());
    const summary = container.createDiv({
      cls: "codex-resource-summary resources-list-heading",
      attr: {
        "data-resource-summary": "true",
        "data-resource-total": String(total),
        "data-resource-enabled": String(enabled)
      }
    });
    summary.createSpan({ cls: "codex-resource-summary-count", text: resourceSummaryText(
      this.plugin.settings.settingsLanguage, label, enabled, total, visible, searching
    ) });
    summary.createSpan({ text: this.plugin.settings.settingsLanguage === "en" ? "Enabled" : "启用" });
    if (error) {
      createSettingsState(
        container,
        this.plugin.settings.settingsLanguage === "en"
          ? "Some resource entries could not be read. Refresh after checking the current Vault configuration."
          : "部分资源未能读取。请检查当前 Vault 配置后刷新。",
        "error"
      );
    }
  }

  private renderResourceRow(container: HTMLElement, resource: EchoInkResource, visible = true, searchRow?: { key: string; name: string; meta?: string; desc?: string }): void {
    const copy = this.copy;
    const resourceEnabled = resource.enabled;
    const row = container.createDiv({
      cls: `codex-resource-row ${resourceEnabled ? "is-enabled" : "is-disabled"} ${visible ? "" : "is-search-hidden"}`,
      attr: {
        "data-resource-key": searchRow?.key ?? resource.id,
        "data-resource-name": searchRow?.name ?? (resource.kind === "skill" ? `/${resource.name}` : resource.name),
        "data-resource-meta": searchRow?.meta ?? "",
        "data-resource-desc": searchRow?.desc ?? ""
      }
    });
    const icon = row.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, resource.kind === "skill" ? "sparkles" : resource.kind === "mcp-server" ? "blocks" : "package");
    const content = row.createDiv({ cls: "codex-resource-row-content" });
    const name = resource.kind === "skill" ? `/${resource.name}` : resource.name;
    const connectionStatus = resource.kind === "mcp-server" ? mcpConnectionStatus(resource, this.plugin.settings.resources) : "not-mcp";
    const meta = resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage);
    const title = content.createDiv({ cls: "codex-resource-row-title" });
    const nameButton = createOriginButton(title, {
      cls: "codex-resource-row-name",
      text: name,
      attr: {
        type: "button",
        "data-echoink-focus-key": `resource:${resource.id}:detail`,
        "aria-label": this.plugin.settings.settingsLanguage === "en"
          ? `Open ${name} details`
          : `打开 ${name} 详情`
      }
    });
    nameButton.onclick = () => this.openSettingsDetail({ kind: "resource", resourceId: resource.id });
    const builtinSkillId = builtinSkillIdForResource(resource);
    if (builtinSkillId) {
      title.createSpan({
        cls: "codex-resource-preset-badge",
        text: builtinSkillId === "daily-journal"
          ? (this.plugin.settings.settingsLanguage === "en" ? "EchoInk default" : "EchoInk 默认")
          : copy.resources.preset,
        attr: { "data-resource-preset": "true" }
      });
      if (resource.metadata?.userModified === true) {
        title.createSpan({
          cls: "codex-resource-state-badge is-customized",
          text: this.plugin.settings.settingsLanguage === "en" ? "Customized" : "已自定义",
          attr: { "data-resource-skill-state": "customized" }
        });
      }
      const fileStatus = builtinSkillFileStatus(resource);
      if (fileStatus && fileStatus !== "ready") {
        title.createSpan({
          cls: "codex-resource-state-badge is-error",
          text: builtinSkillFileStateText(
            fileStatus,
            this.plugin.settings.settingsLanguage === "en"
          ),
          attr: { "data-resource-skill-state": fileStatus }
        });
      }
    }
    const desc = resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc;
    const description = [desc, meta].filter(Boolean).join(" · ");
    if (description) content.createDiv({ cls: "codex-resource-row-desc", text: description });
    const toggle = createOriginSwitch(row, {
      cls: "codex-resource-toggle",
      attr: {
        type: "checkbox",
        "aria-label": copy.resources.toggleAria(name),
        "data-echoink-focus-key": `resource:${resource.id}:enabled`
      }
    });
    toggle.checked = resourceEnabled;
    toggle.onchange = async () => {
      const enabled = toggle.checked;
      try {
        if (resource.kind === "mcp-server") {
          await this.plugin.setEchoInkMcpServerEnabled(resource.id, enabled);
        } else {
          await this.plugin.setEchoInkSkillResourceEnabled(resource.id, enabled);
        }
        const authoritativeEnabled = this.plugin.settings.resources.catalog
          .find((candidate) => candidate.id === resource.id)?.enabled ?? false;
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        this.updateResourceSummaryCounts();
      } catch {
        const authoritativeEnabled = this.plugin.settings.resources.catalog
          .find((candidate) => candidate.id === resource.id)?.enabled ?? false;
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        const message = this.plugin.settings.settingsLanguage === "en"
          ? "The resource setting was not saved."
          : "资源开关未保存，请重试。";
        new Notice(message);
        this.announceSettingsStatus(message);
      }
    };
    void connectionStatus;
  }

  private updateResourceSummaryCounts(): void {
    const body = this.containerEl.querySelector<HTMLElement>(".codex-resource-body");
    const summary = body?.querySelector<HTMLElement>("[data-resource-summary]");
    if (!body || !summary) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".codex-resource-row[data-resource-key]"));
    const enabled = rows.filter((row) => row.hasClass("is-enabled")).length;
    const visible = rows.filter((row) => !row.hasClass("is-search-hidden")).length;
    summary.dataset.resourceEnabled = String(enabled);
    const activeTab = this.plugin.settings.resourceManagementTab;
    summary.querySelector<HTMLElement>(".codex-resource-summary-count")?.setText(resourceSummaryText(
      this.plugin.settings.settingsLanguage,
      this.copy.resources.tabs[activeTab],
      enabled,
      rows.length,
      visible,
      Boolean(this.resourceSearchQuery[activeTab].trim())
    ));
    this.announceSettingsStatus(summary.textContent ?? "");
  }

  private async copySettingsValue(value: string, button: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      const message = this.plugin.settings.settingsLanguage === "en" ? "Copied full value." : "已复制完整内容。";
      this.announceSettingsStatus(message);
      new Notice(message);
      confirmAmicroButton(button);
    } catch {
      this.settingsActionErrors.resources = this.plugin.settings.settingsLanguage === "en"
        ? "Could not copy the value. Select it from the visible field instead."
        : "无法复制该内容，请从可见字段中选择并复制。";
      button.focus();
      this.announceSettingsStatus(this.settingsActionErrors.resources);
      this.scheduleDisplay();
    }
  }

  private renderMcpConnectionActions(row: HTMLElement, resource: EchoInkResource, status: ReturnType<typeof mcpConnectionStatus>): void {
    const actions = row.createDiv({ cls: "echoink-settings-inline-actions" });
    const configure = createOriginButton(actions, {
      text: this.plugin.settings.settingsLanguage === "en"
        ? (status === "imported-only" || status === "missing-config" ? "Configure connection" : "Edit connection")
        : (status === "imported-only" || status === "missing-config" ? "补全连接配置" : "编辑连接配置"),
      attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:configure` }
    });
    configure.onclick = () => this.openMcpServerModal(resource);
    if (status === "connectable" || status === "verified" || status === "failed") {
      const test = createOriginButton(actions, {
        text: this.plugin.settings.settingsLanguage === "en" ? "Test connection" : "测试连接",
        attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:test` }
      });
      test.onclick = () => void this.testMcpConnection(resource, test);
    }
    if (resource.source === "manual") {
      const remove = createOriginButton(actions, {
        cls: "mod-warning",
        text: this.plugin.settings.settingsLanguage === "en" ? "Delete server" : "删除 Server",
        attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:delete` }
      });
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        message: this.plugin.settings.settingsLanguage === "en" ? `Delete ${resource.name} and its local connection settings? This does not execute any MCP tool.` : `删除 ${resource.name} 及其本地连接设置？此操作不会执行任何 MCP Tool。`,
        confirmLabel: this.plugin.settings.settingsLanguage === "en" ? "Confirm deletion" : "确认删除", cancelLabel: this.copy.common.cancel,
        onConfirm: () => this.deleteMcpServer(resource, remove)
      });
    }
  }

  private openMcpServerModal(resource?: EchoInkResource): void {
    const connection = resource
      ? resolveMcpConnectionRecord(resource, this.plugin.settings.resources) ?? undefined
      : undefined;
    const editor = new McpServerModal({
      app: this.app,
      language: this.plugin.settings.settingsLanguage,
      ...(resource ? { resource } : {}),
      ...(connection ? { connection } : {}),
      save: async (draft) => {
        const saved = await this.plugin.saveEchoInkMcpServer(draft);
        this.settingsDetail = { kind: "resource", resourceId: saved.id };
        await this.loadWorkspaceResources(true, "mcp");
        const message = this.plugin.settings.settingsLanguage === "en"
          ? `Saved MCP server ${saved.name}.`
          : `已保存 MCP Server：${saved.name}。`;
        new Notice(message);
        this.announceSettingsStatus(message);
      }
    });
    this.openInlineEditor(editor, "resources");
  }

  private async deleteMcpServer(resource: EchoInkResource, button: HTMLButtonElement): Promise<void> {
    const english = this.plugin.settings.settingsLanguage === "en";
    button.disabled = true;
    try {
      await this.plugin.deleteEchoInkMcpServer(resource.id);
      this.settingsDetail = null;
      await this.loadWorkspaceResources(true, "mcp");
      const message = english ? "MCP server deleted." : "MCP Server 已删除。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } catch {
      button.disabled = false;
      const message = english ? "The MCP server was not deleted." : "MCP Server 未删除，请重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    }
  }

  private async testMcpConnection(resource: EchoInkResource, button?: HTMLButtonElement): Promise<void> {
    if (button) button.disabled = true;
    try {
      const result = await this.plugin.refreshEchoInkMcpServer(resource.id, 30000);
      const message = this.plugin.settings.settingsLanguage === "en"
        ? `Connection verified: ${result.tools} tools.`
        : `连接已验证：${result.tools} 个工具。`;
      new Notice(message);
      this.announceSettingsStatus(message);
      await this.loadWorkspaceResources(true, "mcp");
    } catch (error) {
      const message = this.plugin.settings.settingsLanguage === "en"
        ? "Connection test did not finish. Review the visible error, then retry."
        : "连接测试未完成。请查看页面中的错误后重试。";
      new Notice(message);
      this.announceSettingsStatus(message);
    } finally {
      if (button?.isConnected) button.disabled = false;
      this.scheduleDisplay();
    }
  }

  private async loadWorkspaceResources(force = false, tab: ResourceManagementTab = this.plugin.settings.resourceManagementTab): Promise<void> {
    if (this.resourceLoadingTab === tab) return;
    if (this.resourceLoaded[tab] && !force) return;
    this.resourceLoadingTab = tab;
    delete this.resourceLoadErrors[tab];
    this.scheduleDisplay();
    try {
      this.runtimeEchoInkResources = await this.plugin.buildRuntimeEchoInkResourceCatalog();
      const scanError = this.plugin.settings.resources.lastError.trim();
      if (scanError) this.resourceLoadErrors[tab] = scanError;
      else this.resourceLoadErrors = {};
      this.resourceSnapshot = emptyWorkspaceResourceSnapshot();
      this.resourceLoaded[tab] = true;
    } catch (error) {
      this.resourceLoadErrors[tab] = error instanceof Error ? error.message : String(error);
      this.resourceSnapshot = emptyWorkspaceResourceSnapshot();
      this.resourceLoaded[tab] = true;
    } finally {
      this.resourceLoadingTab = null;
      this.scheduleDisplay();
    }
  }

  private decorateSetting(setting: Setting, iconName: string): Setting {
    void iconName;
    return applySettingsRow(setting);
  }
}

function appendAboutSvg(
  parent: HTMLElement,
  attributes: Readonly<Record<string, string>>,
  paths: readonly string[]
): void {
  const doc = parent.ownerDocument;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries(attributes)) {
    svg.setAttribute(name, value);
  }
  for (const d of paths) {
    const pathNode = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    pathNode.setAttribute("d", d);
    svg.appendChild(pathNode);
  }
  parent.appendChild(svg);
}

function providerModelSelectionValue(
  providerSettingsId: string,
  modelId: string
): string {
  return JSON.stringify([providerSettingsId, modelId]);
}

function parseProviderModelSelectionValue(value: string): Readonly<{
  providerSettingsId: string;
  modelId: string;
}> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || !parsed[0]
      || typeof parsed[1] !== "string"
      || !parsed[1]
    ) return null;
    return {
      providerSettingsId: parsed[0],
      modelId: parsed[1]
    };
  } catch {
    return null;
  }
}

function providerConfigurationFingerprint(provider: ApiProviderConfig): string {
  const model = getDefaultApiProviderModel(provider);
  return JSON.stringify({
    providerId: normalizeApiProviderId(
      provider.providerId,
      provider.baseUrl,
      provider.name
    ),
    runtimeProviderId: provider.runtimeProviderId,
    apiProtocol: provider.apiProtocol,
    baseUrl: provider.baseUrl,
    model,
    apiKeyConfigured: Boolean(provider.apiKey.trim())
  });
}

function describeQuickChatRegistration(
  result: QuickChatRegistrationResult,
  enabled: boolean,
  hotkey: string,
  zh: boolean
): string {
  if (!enabled) {
    return zh ? "未启用。" : "Disabled.";
  }
  const display = formatAcceleratorForDisplay(hotkey, Platform.isMacOS);
  if (result.ok) {
    return zh ? `已注册：${display}` : `Registered: ${display}`;
  }
  switch (result.reason) {
    case "unavailable":
      return zh
        ? "桌面能力不可用（移动端或受限环境），小窗无法注册。"
        : "Desktop capability unavailable; the quick window cannot register.";
    case "occupied":
      return zh
        ? `${display} 已被系统、其他应用或另一个笔记库占用，请更换。`
        : `${display} is taken by the system, another app, or another vault. Choose a different hotkey.`;
    case "invalid":
      return zh
        ? "快捷键格式无效，请重新录制。"
        : "Invalid hotkey format. Record it again.";
    default:
      return zh ? "未注册。" : "Not registered.";
  }
}

function labelSettingsToggle(
  toggle: { toggleEl: HTMLElement },
  label: string
): void {
  toggle.toggleEl.setAttr("aria-label", label);
  const inputEl = toggle.toggleEl.matches("input")
    ? toggle.toggleEl
    : toggle.toggleEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
  inputEl?.setAttr("aria-label", label);
}

const RESOURCE_TABS: Array<{ id: ResourceManagementTab; icon: string }> = [
  { id: "plugins", icon: "package" },
  { id: "mcp", icon: "blocks" },
  { id: "skills", icon: "sparkles" }
];

type VisibleSettingsTab = SettingsTab;

type SettingsActionContext = "knowledge" | "review" | "resources" | "providers";

type SettingsDetail =
  | "knowledge-preferences"
  | "knowledge-maintenance-history"
  | "review-archives"
  | "review-memory"
  | { readonly kind: "resource"; readonly resourceId: string }
  | {
      readonly kind: "review-memory-category";
      readonly category: PersonalMemoryCorrectionCategory;
    }
  | null;

type PersonalMemoryCorrectionCategory =
  | "facts"
  | "views"
  | "decisions"
  | "active"
  | "episodes";

interface PersonalMemoryCorrectionCategoryDefinition {
  readonly id: PersonalMemoryCorrectionCategory;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly descriptionZh: string;
  readonly descriptionEn: string;
  readonly kinds: readonly PersonalMemoryKind[];
}

const PERSONAL_MEMORY_CORRECTION_CATEGORIES: readonly PersonalMemoryCorrectionCategoryDefinition[] = Object.freeze([
  { id: "facts", labelZh: "事实", labelEn: "Facts", descriptionZh: "你确认过、目前仍然有效的客观信息。", descriptionEn: "Information you confirmed that is still current.", kinds: ["fact"] },
  { id: "views", labelZh: "观点", labelEn: "Views", descriptionZh: "你当前持有的看法、判断与偏好。", descriptionEn: "Views, judgments, and preferences you currently hold.", kinds: ["view"] },
  { id: "decisions", labelZh: "决定", labelEn: "Decisions", descriptionZh: "你已经决定、后续应该遵守的做法。", descriptionEn: "Decisions you made that should be followed going forward.", kinds: ["decision"] },
  { id: "active", labelZh: "进行中", labelEn: "Active", descriptionZh: "你正在推进的目标、任务与待处理事项。", descriptionEn: "Goals, tasks, and open items you are currently working on.", kinds: ["goal", "task", "open_loop"] },
  { id: "episodes", labelZh: "经历", labelEn: "Episodes", descriptionZh: "过去发生过、在类似情况下值得参考的经验。", descriptionEn: "Past experiences worth referring to in similar situations.", kinds: ["episode"] }
]);

function personalMemoryCorrectionCategory(
  category: PersonalMemoryCorrectionCategory
): PersonalMemoryCorrectionCategoryDefinition {
  return PERSONAL_MEMORY_CORRECTION_CATEGORIES.find((item) => item.id === category)!;
}

function personalMemoryKindLabel(kind: PersonalMemoryKind, zh: boolean): string {
  const labels: Record<PersonalMemoryKind, readonly [string, string]> = {
    fact: ["事实", "fact"],
    view: ["观点", "view"],
    decision: ["决定", "decision"],
    goal: ["目标", "goal"],
    task: ["任务", "task"],
    open_loop: ["待闭环", "open loop"],
    episode: ["经历", "episode"]
  };
  return labels[kind][zh ? 0 : 1];
}

function isPersonalMemoryRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "revision_conflict"
    || (typeof record.message === "string"
      && record.message.includes("revision_conflict"));
}

function knowledgeMaintenanceHistoryTitle(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  const modeLabels = zh
    ? {
        maintain: "知识提炼",
        lint: "知识体检",
        reingest: "重新提炼",
        outputs: "输出整理",
        inbox: "Inbox 整理",
        unknown: "知识维护"
      }
    : {
        maintain: "Knowledge refinement",
        lint: "Knowledge check",
        reingest: "Re-refinement",
        outputs: "Output organization",
        inbox: "Inbox organization",
        unknown: "Knowledge maintenance"
      };
  return `${formatKnowledgeMaintenanceTime(entry.at, entry.date, zh)} · ${modeLabels[entry.mode]}`;
}

function knowledgeMaintenanceHistoryDescription(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  const status = knowledgeMaintenanceHistoryStatus(entry, zh);
  const pending = entry.pendingSources?.length
    ? (zh
      ? `${entry.pendingSources.length} 项待处理`
      : `${entry.pendingSources.length} pending`)
    : "";
  const warnings = entry.warnings?.length
    ? (zh
      ? `${entry.warnings.length} 条提醒`
      : `${entry.warnings.length} warnings`)
    : "";
  return [status, pending, warnings, entry.reportPath].filter(Boolean).join(" · ");
}

function knowledgeMaintenanceHistoryStatus(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  if (entry.status === "failed") return zh ? "失败" : "Failed";
  if (entry.status === "canceled") return zh ? "已取消" : "Canceled";
  if (entry.completion === "partial") return zh ? "部分完成" : "Partially completed";
  if (entry.completion === "recovered") return zh ? "恢复后完成" : "Completed after recovery";
  if (entry.completion === "noop") return zh ? "已检查，无新内容" : "Checked, no new content";
  return zh ? "已完成" : "Completed";
}

function formatKnowledgeMaintenanceTime(at: number, date: string, zh: boolean): string {
  if (!Number.isFinite(at) || at <= 0) return date;
  return new Date(at).toLocaleString(zh ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

const SETTINGS_PANEL_ID = "echoink-settings-panel";
const SETTINGS_TITLE_ID = "echoink-settings-title";
const RESOURCE_PANEL_ID = "echoink-resource-panel";
const RESOURCE_TITLE_ID = "echoink-resource-title";
const SETTINGS_TAB_ICON_ANIMATION_WINDOW_MS = 1_250;

const SETTINGS_TABS: Array<{
  id: VisibleSettingsTab;
  icon: AnimatedSettingsTabIconName;
}> = [
  { id: "general", icon: "settings" },
  { id: "providers", icon: "key-round" },
  { id: "resources", icon: "layout-list" },
  { id: "knowledgeBase", icon: "book-open-check" },
  { id: "review", icon: "clipboard-check" },
  { id: "todos", icon: "list-todo" }
];

function visibleSettingsTab(tab: SettingsTab): VisibleSettingsTab {
  return tab;
}

function settingsTabDomId(tab: VisibleSettingsTab): string {
  return `echoink-settings-tab-${tab}`;
}

function resourceTabDomId(tab: ResourceManagementTab): string {
  return `echoink-resource-tab-${tab}`;
}

function tabIndexFromKeyboard(
  key: string,
  currentIndex: number,
  tabCount: number
): number | null {
  if (tabCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % tabCount;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + tabCount) % tabCount;
  }
  return null;
}

function resourceKindForResourceTab(tab: ResourceManagementTab): EchoInkResource["kind"] {
  return tab === "mcp" ? "mcp-server" : tab === "skills" ? "skill" : "tool-bundle";
}

function resourceDisplayMeta(
  resource: EchoInkResource,
  resourceSettings: Pick<typeof DEFAULT_SETTINGS.resources, "mcpConnections">,
  language: "zh-CN" | "en"
): string {
  const connectionStatus = resource.kind === "mcp-server"
    ? mcpConnectionStatus(resource, resourceSettings)
    : "not-mcp";
  return [
    resourceSourceLabel(resource.source, language),
    resource.kind === "mcp-server" ? mcpConnectionStatusLabel(connectionStatus, language) : "",
    resource.kind === "skill" ? builtinSkillResourceStatusText(resource, language === "en") : ""
  ].filter(Boolean).join(" · ");
}

function builtinSkillIdForResource(
  resource: EchoInkResource
): BuiltinSkillId | null {
  const skillId = resource.kind === "skill"
    ? resource.metadata?.resourceId
    : null;
  return isBuiltinSkillId(skillId) ? skillId : null;
}

function builtinSkillFileStatus(
  resource: EchoInkResource
): BuiltinSkillRuntimeSnapshot["fileStatus"] | null {
  const status = resource.metadata?.fileStatus;
  return status === "ready" || status === "missing" || status === "invalid"
    ? status
    : null;
}

function builtinSkillFileStateText(
  status: BuiltinSkillRuntimeSnapshot["fileStatus"],
  english: boolean
): string {
  if (status === "missing") return english ? "SKILL.md missing" : "SKILL.md 缺失";
  if (status === "invalid") return english ? "SKILL.md invalid" : "SKILL.md 损坏";
  return english ? "SKILL.md ready" : "SKILL.md 可用";
}

function builtinSkillResourceStatusText(
  resource: EchoInkResource,
  english: boolean
): string {
  const status = builtinSkillFileStatus(resource);
  if (!status || status === "ready") return "";
  return builtinSkillFileStateText(status, english);
}

function mcpConnectionSummary(connection: EchoInkMcpConnectionRecord, english: boolean): string {
  if (connection.transport === "http") {
    let endpoint = connection.url;
    try {
      const url = new URL(connection.url);
      endpoint = `${url.origin}${url.pathname}`;
    } catch {
      endpoint = english ? "Invalid HTTP endpoint" : "HTTP 地址无效";
    }
    return `HTTP · ${endpoint}`;
  }
  const argumentCount = connection.args?.length ?? 0;
  return english
    ? `stdio · ${connection.command} · ${argumentCount} arguments`
    : `stdio · ${connection.command} · ${argumentCount} 个参数`;
}

function mcpDiagnosticLabel(code: EchoInkMcpDiagnosticCode, english: boolean): string {
  const labels: Record<EchoInkMcpDiagnosticCode, [string, string]> = {
    connection_failed: ["连接失败", "Connection failed"],
    authentication_failed: ["认证失败", "Authentication failed"],
    schema_invalid: ["Schema 异常", "Schema invalid"],
    disconnected: ["连接中断", "Disconnected"],
    timeout: ["连接超时", "Timed out"],
    call_failed: ["Tool 调用失败", "Tool call failed"]
  };
  return labels[code][english ? 1 : 0];
}

function resourceSourceLabel(source: EchoInkResource["source"], language: "zh-CN" | "en"): string {
  if (language === "en") {
    if (source === "echoink-local") return "This vault";
    if (source === "manual") return "Added locally";
    return "Imported";
  }
  if (source === "echoink-local") return "当前 Vault";
  if (source === "manual") return "本地添加";
  return "已导入";
}

function resourceEmptyNextStep(tab: ResourceManagementTab, language: "zh-CN" | "en"): string {
  if (language === "en") {
    if (tab === "mcp") return "Add an MCP connection to this vault, then select Refresh.";
    if (tab === "skills") return "Add a Skill to this vault, then select Refresh.";
    return "Add a plugin tool bundle to this vault, then select Refresh.";
  }
  if (tab === "mcp") return "将 MCP 连接添加到当前 Vault 后，点击“刷新”。";
  if (tab === "skills") return "将 Skill 添加到当前 Vault 后，点击“刷新”。";
  return "将插件工具包添加到当前 Vault 后，点击“刷新”。";
}

function resourceSummaryText(
  language: "zh-CN" | "en",
  category: string,
  enabled: number,
  total: number,
  visible: number,
  searching: boolean
): string {
  if (language === "en") {
    return searching
      ? `${category} · ${enabled} of ${total} enabled · ${visible} shown`
      : `${category} · ${enabled} of ${total} enabled`;
  }
  return searching
    ? `${category} · 已启用 ${enabled} / ${total} · 显示 ${visible}`
    : `${category} · 已启用 ${enabled} / ${total}`;
}

function pluginInstallDir(plugin: CodexForObsidianPlugin): string {
  const dir = "dir" in plugin.manifest && typeof plugin.manifest.dir === "string"
    ? plugin.manifest.dir
    : "";
  return dir ? `${dir}/` : ".obsidian/plugins/codex-echoink/";
}

function formatQueryParams(params?: Record<string, string>): string {
  return Object.entries(params ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseQueryParams(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const paramValue = trimmed.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(key) && paramValue) params[key] = paramValue;
  }
  return params;
}
