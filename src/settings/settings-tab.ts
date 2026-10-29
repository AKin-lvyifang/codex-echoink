import { renderMcpServerSettings } from "./mcp-server-settings";
import { isOfficialRemoteSkill, remoteSkillLocked, skillDeliveryNotice } from "../resources/remote-skill-presentation";
import { safeSkillCompareUrl } from "../membership/skill-delivery";
import { ownedDiv } from "../ui/owned-dom";
import { isImeKeyEvent } from "../ui/ime-composition";
import { attachNativeTooltip } from "../ui/native-tooltip";
import { skillIcon } from "../agents/skill-icons";
import { DesktopAgentSettings } from "./agent-settings";
import { renderInlineAgentSettings } from "./inline-agent-settings";
import { DesktopMemorySettings } from "./desktop-memory-settings";
import { UserProfileSettingsController } from "./user-profile-settings";
import { renderKnowledgeLinkingSection } from "./knowledge-linking-section";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { PdfReadingSettingsPanel } from "../pdf-reading/settings-panel";
import { renderSelectionAskPluginRow, renderSelectionAnnotationSettings, type SelectionAnnotationSettingsController } from "./selection-annotation-settings";
import { renderDesktopModuleSettings as mountDesktopModuleSettings, type DesktopModuleId } from "./desktop-module-settings";
import { DesktopKnowledgeSettings } from "./desktop-knowledge-settings";
import { GenerationTemplatesSection } from "./generation-templates-section";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { JournalTemplateModal } from "../home/journal-template-modal";
import { BUILT_IN_JOURNAL_TEMPLATES } from "../home/home-workbench-model";
import { hasProPluginAccess, getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { ProPluginControls } from "../ui/pro-plugin-controls";
import { mountAccountMembership } from "./account-membership";
import { mountDesktopAccountMembership, type DesktopAccountMembershipHandle } from "./desktop-account-membership";
import { createUnavailableAccountAdapter } from "./account-membership-model";
import { renderTavilySettings, renderProviderTabs } from "./tavily-settings";
import { renderTodoStatistics } from "./todo-statistics";
import { renderTodoReminderSettings } from "./todo-reminder-settings";
import { renderEnglishDiaryActivity } from "./english-diary-activity";
import { renderCompanionThemeRecommendation } from "../ui/appearance-theme";
import { renderAppearancePicker } from "./appearance-picker";
import { renderObsidianCliStatus } from "./obsidian-cli-status";
import { DESKTOP_SETTINGS_TAB_ICONS, SETTINGS_TAB_ICONS } from "./settings-tab-icons";
import { OriginSetting } from "./origin-setting";
import { mergeKnowledgeMaintenanceHistory, renderKnowledgeMaintenanceHistoryList, renderKnowledgeMaintenanceRecordDetail, openKnowledgeMaintenancePath } from "./knowledge-maintenance-history";
import { createOriginInput, createOriginButton, createOriginCheck, createOriginSwitch, disposeOriginControls, type OriginCheckElement, type OriginSelectElement } from "./origin-controls";
import { mountSettingsEditor, type SettingsEditorHandle } from "./inline-editor";
import { renderProviderServicePicker } from "./provider-service-picker";
import { renderCompactAbout } from "./about-section";
import { ReleaseUpdateController } from "./release-update";
import { DESKTOP_SETTINGS_TABS, desktopSettingsTabLabel, normalizeDesktopSettingsRoute, resolveDesktopSettingsRoute, resolveDesktopSettingsSearchRoute, type DesktopSettingsRoute, type DesktopSettingsTab } from "./desktop-settings-route";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import { checkAgentSkill, mcpToolCapabilityId } from "../agents/capability-policy";
import { Component, MarkdownRenderer, Modal, Notice, Platform, PluginSettingTab, Setting, setIcon, setTooltip } from "obsidian";
import type { SettingGroup, SettingsCategoryGroupDefinition } from "../types/obsidian-settings";
import { desktopSettingsCategoryDefinitions, settingsCategoryDefinitions } from "./settings-search";
import type CodexForObsidianPlugin from "../main";
import { DeveloperModePanel } from "./developer-mode-panel";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import {
  type PersonalMemoryKind,
  type PersonalMemoryRecord
} from "../harness/memory/personal-memory-contracts";
import {
  isBuiltinSkillId,
  type BuiltinSkillId
} from "../harness/resources/builtin-skills";
import type {
  BuiltinSkillRuntimeSnapshot
} from "../harness/resources/skill-runtime";
import { normalizeJournalDirectory } from "../home/journal-directory";
import { LifestyleSettingsPanel } from "../lifestyle/settings-panel";
import { createPluginEditionBadge } from "./plugin-edition-badge";
import type { LifestyleKind } from "../lifestyle/settings";
import { TODO_SOURCE_PATH } from "../home/todo-store";
import { formatAcceleratorForDisplay, normalizeAccelerator, recordAcceleratorFromEvent } from "../core/quick-hotkey";
import type { QuickChatRegistrationResult } from "../plugin/quick-chat-window";
import { readNativeJournalSettings, saveNativeJournalFolder } from "../home/native-journal";
import {
  mountEchoInkOnboardingCoachmark,
  type EchoInkOnboardingCoachmarkHandle
} from "../ui/onboarding-coachmark";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import { builtinPluginPresentation, resourcePresentation } from "../resources/resource-presentation";
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
  normalizeAutoArchiveDays,
  normalizeSettingsLanguage,
  validateApiProvider,
  type ApiProviderConfig,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type ReviewReportKind,
  type ResourceManagementTab,
  type SettingsTab
} from "./settings";
import {
  apiProviderApiKeyRequired,
  apiProviderConfiguredDisplayName,
  getApiProviderPreset,
  normalizeApiProviderBaseUrl,
  normalizeApiProviderId
} from "./provider-presets";
import type { WorkspaceResourceSnapshot } from "../types/app-server";
import {
  ECHOINK_KNOWLEDGE_MAINTENANCE_PROTOCOL_STEPS
} from "../knowledge-base/knowledge-maintenance-protocol";
import {
  applyAmicroButton,
  applyDeleteButton,
  confirmAmicroButton,
  setAmicroButtonPending
} from "./amicro-buttons";
import {
  confirmModal,
  memoryCorrectionModal,
  MemoryCorrectionModal,
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
  attachSettingsHelpTooltip,
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

type PersonalMemoryControlState = Awaited<
  ReturnType<CodexForObsidianPlugin["getEchoInkPersonalMemoryState"]>
>;

type KnowledgeMaintenancePreferenceControlState = Awaited<
  ReturnType<CodexForObsidianPlugin[
    "getEchoInkKnowledgeMaintenancePreferenceState"
  ]>
>;

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
  private knowledgeLinkingTaskId: string | null = null;
  private knowledgeLinkingCleanup: (() => void) | null = null;
  private knowledgePreferenceClosePromptRunning = false;
  private displayFrame: number | null = null;
  private displayFrameWindow: Window | null = null;
  private settingsTitleEl: HTMLElement | null = null;
  private settingsTabsEl: HTMLElement | null = null;
  private settingsBodyEl: HTMLElement | null = null;
  private settingsStatusEl: HTMLElement | null = null;
  private settingsTabFocusId: VisibleSettingsTab | null = null;
  private resourceTabFocusId: ResourceNavigationTab | null = null;
  private settingsTabPointerActivated = false;
  private resourceTabPointerActivated = false;
  private suppressSettingsTabFocusRestore = false;
  private suppressResourceTabFocusRestore = false;
  private settingsFocusIntent: string | null = null;
  private settingsActionErrors: Partial<Record<SettingsActionContext, string>> = {};
  private settingsDetail: SettingsDetail = null;
  private membershipRowsDisposers: (() => void)[] = [];
  private lifestyleSettingsPanel: LifestyleSettingsPanel | null = null;

  openPdfReadingDetail(): void {
    if (!this.plugin.pdfReading?.policy().canEnter) return;
    if (Platform.isDesktopApp) {
      this.openDesktopRoute({ tab: "modules", focus: "pdf-reading:settings" }); return;
    }
    this.openSettingsDetail("pdf-reading");
  }
  private pdfSettingsPanel: PdfReadingSettingsPanel | null = null;

  openLifestyleDetail(kind: LifestyleKind): void {
    const enabled = this.plugin.settings.lifestyle[kind].enabled;
    if (!getProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess, enabled).canEnter) return;
    if (Platform.isDesktopApp) { this.desktopRoute = { tab: "modules" }; this.desktopModuleExpanded.add("finance"); this.settingsDetail = null; this.settingsFocusIntent = "explicit:module:finance"; this.scheduleDisplay(); return; }
    this.lifestyleSettingsPanel?.dispose();
    this.settingsDetail = { kind: "lifestyle", lifeKind: kind };
    this.lifestyleSettingsPanel = new LifestyleSettingsPanel(this.plugin, kind, () => void this.closeSettingsDetail(), () => this.scheduleDisplay());
    this.scheduleDisplay();
  }
  private knowledgeMaintenanceHistoryDate = "";
  private knowledgeMaintenanceHistoryPage = 1;
  private knowledgeMaintenanceListScroll = 0;
  private knowledgeMaintenanceListCleanup: (() => void) | null = null;
  private knowledgeMaintenanceSelectedRecord: KnowledgeMaintenanceRecord | null = null;
  private knowledgeMaintenanceRecords: KnowledgeMaintenanceRecord[] = [];
  private knowledgeMaintenanceRecordsLoaded = false;
  private knowledgeMaintenanceRecordsLoading = false;
  private knowledgeMaintenanceHistoryScroll: ReturnType<typeof captureSettingsScrollSnapshot> = [];
  private pendingKnowledgeHistoryScroll: ReturnType<typeof captureSettingsScrollSnapshot> | null = null;
  private knowledgeMaintenanceRecordsError = "";
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
  private onboardingNavigationPending = false;
  private developerPanel: DeveloperModePanel | null = null;
  private accountPage: { dispose: () => void } | null = null;
  private desktopAccount: DesktopAccountMembershipHandle | null = null;
  private disposeTodoStatistics: (() => void) | null = null;
  private disposeTodoReminders: (() => void) | null = null;
  private disposeDiaryActivity: (() => void) | null = null;
  private inlineEditor: { tab: VisibleSettingsTab; host: HTMLElement; dispose: SettingsEditorHandle; key: string } | null = null;
  private readonly editorDrafts = new Map<string, { tab: VisibleSettingsTab; host: HTMLElement; dispose: SettingsEditorHandle; key: string }>();
  private desktopRoute: DesktopSettingsRoute | null = null;
  private readonly desktopRouteHistory = new Map<DesktopSettingsTab, DesktopSettingsRoute>();
  private providerPickerOpen = false;
  private quickChatExpanded: boolean | null = null;
  private readonly desktopModuleExpanded = new Set<DesktopModuleId>();
  private desktopModuleCleanup: (() => void) | null = null;
  private desktopKnowledge: DesktopKnowledgeSettings | null = null;
  private desktopAgents: DesktopAgentSettings | null = null;
  private pendingDesktopAgentEditor: string | null = null;
  private desktopMemory: DesktopMemorySettings | null = null;
  private desktopProfile: UserProfileSettingsController | null = null;
  private desktopProfileOpen = false;
  private desktopCorrection: { id: string; category: PersonalMemoryCorrectionCategory; invalidated: boolean; controller: MemoryCorrectionModal } | null = null;
  private desktopSelection: { host: HTMLElement; controller: SelectionAnnotationSettingsController | undefined } | null = null;
  private desktopTemplate: { host: HTMLElement; dispose: () => void } | null = null;
  private desktopGenerationTemplates: GenerationTemplatesSection | null = null;
  private preserveDesktopCloseDraft = false;
  private pendingDesktopClosePrompt = false;
  private settingsViewUnloaded = false;
  private desktopCloseReopenTimer: { owner: Window; id: number } | null = null;
  private readonly moduleInputDrafts = new Map<string, string>();
  private readonly moduleInputBaselines = new WeakMap<HTMLElement, string>();
  private readonly suspendedTabEditors = new Map<VisibleSettingsTab, string>();
  private readonly locationScroll = new Map<string, number>();
  private readonly releaseUpdate = new ReleaseUpdateController();

  openDesktopRoute(route: DesktopSettingsRoute): void {
    if (!Platform.isDesktopApp) return;
    if (this.leaveDesktopAccount(() => this.openDesktopRoute(route))) return;
    if (this.leaveDesktopAgentDetail(() => this.openDesktopRoute(route))) return;
    if (this.desktopSelection?.controller?.hasUnsavedChanges()) { this.desktopSelection.controller.requestBack(() => { this.clearDesktopSelection(); this.openDesktopRoute(route); }); return; }
    if (this.leaveKnowledgePreference(() => this.openDesktopRoute(route))) return;
    if (this.desktopKnowledge?.isDetail) { this.desktopKnowledge.requestLeave(() => this.openDesktopRoute(route)); return; }
    this.clearDesktopSelection();
    this.suspendActiveEditor(false);
    if (this.desktopRoute) this.desktopRouteHistory.set(this.desktopRoute.tab, this.desktopRoute);
    route = normalizeDesktopSettingsRoute(route, this.plugin.settings.resourceManagementTab, this.desktopRouteHistory.get("capabilities")?.capabilityTab);
    this.desktopRoute = route;
    this.pendingDesktopAgentEditor = null;
    this.desktopRouteHistory.set(route.tab, this.desktopRoute);
    this.suspendedTabEditors.delete(route.tab);
    if (route.capabilityTab && route.capabilityTab !== "tools") this.plugin.settings.resourceManagementTab = route.capabilityTab;
    if (route.tab === "modules") this.plugin.settings.resourceManagementTab = "plugins";
    this.settingsDetail = null;
    if (route.focus === "providers:add" && this.plugin.isEchoInkOnboardingRequested() && this.plugin.getEchoInkOnboardingStep() === "provider") this.providerPickerOpen = true;
    if (route.focus) this.settingsFocusIntent = `explicit:${route.focus.replace(/^explicit:/u, "")}`;
    if (/^knowledge:generation-template:/u.test(route.focus ?? "")) this.openGenerationTemplateEditor(route.focus!.slice("knowledge:generation-template:".length));
    else if (route.focus === "knowledge:generation-templates") this.openSettingsDetail("generation-templates");
    else if (/journal:templates/u.test(route.focus ?? "")) this.openSettingsDetail("journal-templates");
    else if (/todo:categories/u.test(route.focus ?? "")) this.openSettingsDetail("todo-categories");
    else if (/knowledge:sources/u.test(route.focus ?? "")) { this.desktopModuleExpanded.add("knowledge"); this.ensureDesktopKnowledge().open("sources"); }
    else if (/^knowledge:(?:collections|permissions|management)$/u.test(route.focus ?? "")) {
      this.desktopModuleExpanded.add("knowledge"); this.ensureDesktopKnowledge().open(route.focus!.slice("knowledge:".length) as "collections" | "permissions" | "management");
    }
    else if (route.resourceId) this.openSettingsDetail({ kind: "resource", resourceId: route.resourceId });
    else if (/knowledge:(?:preferences|preference)/u.test(route.focus ?? "")) this.openSettingsDetail("knowledge-preferences");
    else if (/knowledge:(?:folders|onboarding)/u.test(route.focus ?? "")) this.openSettingsDetail("knowledge-folders");
    else if (/knowledge:linking/u.test(route.focus ?? "")) this.openSettingsDetail("knowledge-linking");
    else if (/knowledge:restore/u.test(route.focus ?? "")) { this.desktopModuleExpanded.add("knowledge"); this.ensureDesktopKnowledge().open("management"); this.settingsFocusIntent = "explicit:knowledge:restore"; }
    else if (/^inline-agent/u.test(route.focus ?? "")) {
      this.desktopModuleExpanded.add("inline-agent");
      if (!this.plugin.settings.inlineAgent.enabled || !hasProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess)) this.settingsFocusIntent = "explicit:module:inline-agent";
    }
    else if (/^pdf-reading/u.test(route.focus ?? "")) {
      if (this.plugin.pdfReading?.policy().canEnter && this.plugin.settings.pdfReading.enabled && hasProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess)) this.openSettingsDetail("pdf-reading");
      else this.settingsFocusIntent = "explicit:module:pdf";
    }
    else if (/^finance/u.test(route.focus ?? "")) this.openLifestyleDetail("finance");
    else if (/^english-diary/u.test(route.focus ?? "")) {
      this.openSettingsDetail("english-diary");
      if (route.focus === "english-diary:home-shortcut") this.settingsFocusIntent = "explicit:english-diary:home-shortcut";
    }
    else if (/^selection-ask/u.test(route.focus ?? "")) this.openSettingsDetail("selection-ask");
    else if (/review:archives/u.test(route.focus ?? "")) this.openSettingsDetail("review-archives");
    else if (/agent:profile/u.test(route.focus ?? "")) { this.ensureDesktopProfile().refreshWhenOpened(); this.desktopProfileOpen = true; }
    else if (/general:personality-template/u.test(route.focus ?? "")) this.pendingDesktopAgentEditor = GENERAL_ASSISTANT_ID;
    else if (/review:memory/u.test(route.focus ?? "")) this.openSettingsDetail("review-memory");
    this.scheduleDisplay();
  }

  private activeSettingsTab(): VisibleSettingsTab {
    if (!Platform.isDesktopApp) return this.plugin.settings.settingsTab;
    this.desktopRoute ??= resolveDesktopSettingsRoute(this.plugin.settings.settingsTab, { resourceTab: this.plugin.settings.resourceManagementTab });
    return this.desktopRoute.tab;
  }

  private settingsTabs(): typeof SETTINGS_TABS {
    return Platform.isDesktopApp ? DESKTOP_SETTINGS_TABS.map(id => ({ id, icon: DESKTOP_SETTINGS_TAB_ICONS[id] })) : SETTINGS_TABS;
  }

  private settingsTabLabel(tab: VisibleSettingsTab): string {
    return Platform.isDesktopApp ? desktopSettingsTabLabel(tab as DesktopSettingsTab, this.plugin.settings.settingsLanguage) : this.copy.tabs[tab as SettingsTab];
  }
  private nativeSettingsNavigation: NativeSettingsNavigation | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    plugin.register(plugin.onAgentRegistryChanged?.(() => {
      if (this.containerEl.isConnected && ["agent", "capabilities"].includes(this.activeSettingsTab())) this.scheduleDisplay();
    }) ?? (() => {}));
    plugin.register(plugin.onConversationCatalogChanged(() => {
      this.archivedConversations = null;
      if (this.settingsDetail === "review-archives") void this.loadArchivedConversations(true);
    }));
    this.plugin.register(() => {
      this.settingsViewUnloaded = true;
      this.cancelDesktopCloseReopen();
      this.preserveDesktopCloseDraft = false;
      this.pendingDesktopClosePrompt = false;
      this.disposeSettingsView();
    });
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  private get copy(): SettingsCopy {
    return settingsCopy(this.plugin.settings.settingsLanguage);
  }

  getSettingDefinitions(): SettingsCategoryGroupDefinition[] {
    const render = (tab: VisibleSettingsTab, setting: Setting, group: SettingGroup) => this.renderNativeSettingsCategory(tab, setting, group);
    return Platform.isDesktopApp
      ? desktopSettingsCategoryDefinitions(this.plugin.settings.settingsLanguage, render)
      : settingsCategoryDefinitions(this.plugin.settings.settingsLanguage, render);
  }

  private renderNativeSettingsCategory(
    tab: VisibleSettingsTab,
    setting: Setting,
    group: SettingGroup
  ): () => void {
    this.plugin.applyAppearanceTheme(group.listEl.ownerDocument);
    if (this.nativeSettingsNavigation?.listEl !== group.listEl) {
      this.disposeSettingsView();
      const workspaceEl = group.listEl.parentElement;
      if (!workspaceEl) return () => undefined;
      this.containerEl.addClass("echoink-settings-host");
      workspaceEl.addClass("echoink-settings-demo", "echoink-native-settings-workspace");
      workspaceEl.toggleClass("echoink-settings-desktop", Platform.isDesktopApp);
      workspaceEl.toggleClass("echoink-settings-aligned", Platform.isDesktopApp);
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
    const onNativeSearchFocus = (event: FocusEvent) => {
      if (!Platform.isDesktopApp || event.target !== setting.settingEl) return;
      const query = (this.app as unknown as { setting?: { searchComponent?: { inputEl?: HTMLInputElement } } }).setting?.searchComponent?.inputEl?.value ?? "";
      if (!query.trim()) return;
      const category = tab as DesktopSettingsTab;
      this.openDesktopRoute(resolveDesktopSettingsSearchRoute(category, query) ?? this.desktopRouteHistory.get(category) ?? { tab: category });
    };
    setting.settingEl.addEventListener("focus", onNativeSearchFocus);
    // Keep the host's row and name elements: search can still focus/highlight
    // this real visible boundary. Only the original button lives inside it.
    this.renderTopTabs(this.settingsTabsEl!, this.activeSettingsTab());
    this.scheduleDisplay();
    return () => {
      setting.settingEl.removeEventListener("focus", onNativeSearchFocus);
      if (setting.nameEl.parentElement === row.button) setting.infoEl.appendChild(setting.nameEl);
      disposeOriginControls(setting.settingEl);
      if (navigation.rows.get(tab) !== row) return;
      navigation.rows.delete(tab);
      if (this.nativeSettingsNavigation === navigation && navigation.rows.size === 0) {
        // Native Settings destroys definition rows before invoking hide().
        // Keep data/selection hosts available until that close decision runs.
        if (this.hasDesktopCloseDraft()) this.preserveDesktopCloseDraft = true;
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
    if (!this.pendingDesktopClosePrompt) this.preserveDesktopCloseDraft = false;
    this.settingsVisible = true;
    this.knowledgeMaintenanceRecordsLoaded = false;
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
    if (this.settingsViewUnloaded) { this.disposeSettingsView(); super.hide(); return; }
    if (this.hasDesktopCloseDraft()) {
      this.preserveDesktopCloseDraft = true;
      this.pendingDesktopClosePrompt = true;
      this.disposeSettingsView(); super.hide();
      this.scheduleDesktopCloseReopen();
      return;
    }
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

  private hasDesktopCloseDraft(): boolean {
    return !this.settingsViewUnloaded && Platform.isDesktopApp && Boolean(
      this.desktopAccount?.hasDraft || this.desktopAccount?.submitting
      || this.desktopSelection?.controller?.hasUnsavedChanges() || this.desktopKnowledge?.hasDraft
      || this.desktopAgents?.hasDraft || this.desktopAgents?.submitting || this.desktopProfile?.hasDraft || this.desktopProfile?.submitting
      || this.desktopCorrection?.controller.hasDraft || this.desktopCorrection?.controller.submitting || this.desktopMemory?.submitting
      || this.settingsDetail === "knowledge-preferences" && knowledgeMaintenancePreferenceIsDirty(this.knowledgePreferenceEditor)
    );
  }

  private cancelDesktopCloseReopen(): void {
    if (!this.desktopCloseReopenTimer) return;
    this.desktopCloseReopenTimer.owner.clearTimeout(this.desktopCloseReopenTimer.id);
    this.desktopCloseReopenTimer = null;
  }

  private scheduleDesktopCloseReopen(): void {
    this.cancelDesktopCloseReopen();
    // The settings document can be a closing popout. Schedule on the durable
    // workspace renderer, after the host finishes its current close cycle.
    const workspace = (this.app as unknown as { workspace?: { containerEl?: HTMLElement } }).workspace;
    const owner = workspace?.containerEl?.ownerDocument.defaultView ?? window;
    const id = owner.setTimeout(() => {
      this.desktopCloseReopenTimer = null;
      if (this.settingsViewUnloaded || !this.pendingDesktopClosePrompt) return;
      const settings = (this.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
      settings?.open?.(); settings?.openTabById?.(this.plugin.manifest.id);
    }, 0);
    this.desktopCloseReopenTimer = { owner, id };
  }

  private disposeSettingsView(): void {
    this.desktopModuleCleanup?.(); this.desktopModuleCleanup = null;
    this.desktopMemory?.suspend(); this.desktopAccount?.suspend();
    this.desktopAgents?.suspend(); this.desktopProfile?.suspend(); this.desktopCorrection?.controller.suspend();
    if (!this.preserveDesktopCloseDraft) {
      this.desktopAccount?.dispose(); this.desktopAccount = null;
      this.desktopAgents?.dispose(); this.desktopAgents = null;
      this.desktopProfile?.dispose(); this.desktopProfile = null; this.desktopProfileOpen = false;
      this.desktopCorrection?.controller.close(); this.desktopCorrection = null;
    }
    if (this.preserveDesktopCloseDraft) { this.desktopKnowledge?.suspend(); this.desktopSelection?.host.remove(); }
    else { this.desktopKnowledge?.dispose(); this.desktopKnowledge = null; this.clearDesktopSelection(); }
    this.desktopTemplate?.dispose(); this.desktopTemplate = null;
    this.knowledgeLinkingCleanup?.(); this.knowledgeLinkingCleanup = null;
    this.knowledgeMaintenanceListCleanup?.();
    this.knowledgeMaintenanceListCleanup = null;
    this.membershipRowsDisposers.splice(0).forEach(dispose => dispose());
    this.pdfSettingsPanel?.dispose();
    this.lifestyleSettingsPanel?.dispose();
    this.disposeDiaryActivity?.();
    this.disposeDiaryActivity = null;
    this.accountPage?.dispose();
    this.accountPage = null;
    this.disposeTodoStatistics?.();
    this.disposeTodoStatistics = null;
    this.disposeTodoReminders?.();
    this.disposeTodoReminders = null;
    const navigation = this.nativeSettingsNavigation;
    for (const { setting, button } of navigation?.rows.values() ?? []) {
      if (setting.nameEl.parentElement === button) setting.infoEl.appendChild(setting.nameEl);
    }
    for (const editor of this.editorDrafts.values()) editor.dispose();
    this.editorDrafts.clear();
    this.suspendedTabEditors.clear();
    this.inlineEditor = null;
    this.developerPanel?.dispose();
    this.developerPanel = null;
    this.settingsVisible = false;
    this.clearOnboardingCoachmark(true);
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
    this.plugin.applyAppearanceTheme(containerEl.ownerDocument);
    containerEl.removeClass("echoink-settings-demo");
    containerEl.addClass("echoink-settings-host");
    disposeOriginControls(containerEl);
    containerEl.empty();
    const workspace = containerEl.createDiv({ cls: "echoink-settings-demo" });
    workspace.toggleClass("echoink-settings-desktop", Platform.isDesktopApp);
    workspace.toggleClass("echoink-settings-aligned", Platform.isDesktopApp);
    this.settingsTitleEl = workspace.createDiv({ cls: "codex-settings-title" });
    this.settingsTabsEl = workspace.createDiv({ cls: "codex-settings-tabs-slot" });
    this.createSettingsBody(workspace);
  }

  private createSettingsBody(workspace: HTMLElement): void {
    this.settingsBodyEl = workspace.createDiv({ cls: "codex-settings-body" });
    this.settingsBodyEl.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented || !Platform.isDesktopApp) return;
      if (!this.desktopAgents?.isDetail && !this.desktopProfileOpen && !this.desktopCorrection) return;
      event.preventDefault(); event.stopPropagation();
      const key = this.desktopAgents?.isDetail ? this.desktopAgents.returnFocusKey : this.desktopProfileOpen ? "agent:profile" : "review:memory";
      this.leaveDesktopAgentDetail(() => { this.settingsFocusIntent = `explicit:${key}`; this.scheduleDisplay(); });
    });
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
    const correctionScrollSnapshot = this.desktopCorrection ? captureSettingsScrollSnapshot(this.containerEl) : null;
    if (this.desktopCorrection) this.captureSettingsFocusIntent();
    this.captureModuleInputs();
    this.pdfSettingsPanel?.dispose();
    this.knowledgeLinkingCleanup?.(); this.knowledgeLinkingCleanup = null;
    this.desktopModuleCleanup?.(); this.desktopModuleCleanup = null;
    this.desktopKnowledge?.suspend(); this.desktopAccount?.suspend();
    this.desktopAgents?.suspend(); this.desktopMemory?.suspend(); this.desktopProfile?.suspend(); this.desktopCorrection?.controller.suspend();
    this.membershipRowsDisposers.splice(0).forEach(dispose => dispose());
    this.disposeDiaryActivity?.();
    this.disposeDiaryActivity = null;
    this.accountPage?.dispose();
    this.accountPage = null;
    this.disposeTodoStatistics?.();
    this.disposeTodoStatistics = null;
    this.disposeTodoReminders?.();
    this.disposeTodoReminders = null;
    this.developerPanel?.dispose();
    this.developerPanel = null;
    this.ensureSettingsShell();
    this.captureTabFocusIntent();
    this.captureSettingsFocusIntent();
    const copy = this.copy;
    const settingsScrollSnapshot = correctionScrollSnapshot ?? captureSettingsScrollSnapshot(this.containerEl);
    try {
      this.clearResourceSearchDebounceTimer();
      const titleEl = this.settingsTitleEl;
      const tabsEl = this.settingsTabsEl;
      const bodyEl = this.settingsBodyEl;
      if (!titleEl || !tabsEl || !bodyEl) return;
      disposeOriginControls(titleEl);
      titleEl.empty();
      if (!this.nativeSettingsNavigation) {
        disposeOriginControls(tabsEl);
        tabsEl.empty();
      }
      const resumableKey = this.suspendedTabEditors.get(this.activeSettingsTab());
      const resumableEditor = resumableKey ? this.editorDrafts.get(resumableKey) : undefined;
      if (!this.inlineEditor && resumableEditor && !resumableEditor.dispose.disposed) this.inlineEditor = resumableEditor;
      const activeInline = this.inlineEditor;
      if (activeInline && activeInline.tab === this.activeSettingsTab()) activeInline.host.remove();
      else if (activeInline) { activeInline.dispose.suspend(); this.inlineEditor = null; }
      this.desktopSelection?.host.remove();
      this.desktopTemplate?.host.remove();
      disposeOriginControls(bodyEl);
      bodyEl.empty();
      const pageTitle = new OriginSetting(titleEl)
        .setName(Platform.isDesktopApp ? "EchoInk" : copy.title)
        .setHeading();
      pageTitle.settingEl.addClass("echoink-settings-page-title-row");
      pageTitle.nameEl.addClass("codex-settings-page-title");
      pageTitle.nameEl.id = SETTINGS_TITLE_ID;

      const activeTab = this.activeSettingsTab();
      if (!Platform.isDesktopApp) this.plugin.settings.settingsTab = activeTab as SettingsTab;
      this.renderTopTabs(tabsEl, activeTab);
      bodyEl.setAttr("id", SETTINGS_PANEL_ID);
      bodyEl.setAttr("role", "tabpanel");
      bodyEl.setAttr("aria-labelledby", settingsTabDomId(activeTab));
      bodyEl.setAttr("tabindex", "0");

      bodyEl.setAttr("aria-busy", String(
        ((activeTab === "resources" || activeTab === "capabilities" || activeTab === "modules") && this.resourceLoadingTab === this.plugin.settings.resourceManagementTab)
        || this.memoryActionRunning
      ));

      if (this.inlineEditor) {
        this.inlineEditor.dispose.resume(bodyEl);
      } else if (Platform.isDesktopApp && activeTab === "models") {
        this.renderProviderModelManager(bodyEl);
      } else if (Platform.isDesktopApp && activeTab === "agent") {
        this.renderDesktopAgentSettings(bodyEl);
      } else if (Platform.isDesktopApp && activeTab === "modules") {
        this.renderDesktopModuleSettings(bodyEl);
      } else if (Platform.isDesktopApp && activeTab === "capabilities") {
        this.renderWorkspaceResourceManager(bodyEl);
      } else if (activeTab === "providers") {
        this.renderProviderModelManager(bodyEl);
      } else if (activeTab === "layout") {
        this.renderGeneralSettings(bodyEl);
      } else if (activeTab === "resources") {
        this.renderWorkspaceResourceManager(bodyEl);
      } else if (activeTab === "knowledgeBase") {
        this.renderKnowledgeBaseSettings(bodyEl);
      } else if (activeTab === "review") {
        this.renderReviewSettings(bodyEl);
      } else if (activeTab === "account") {
        const provider = getActiveApiProvider(this.plugin.settings);
        const adapter = this.plugin.accountService ?? createUnavailableAccountAdapter(
          provider && apiProviderHasUsableCredential(provider, this.plugin.settings.openAICodexCredential)
            ? "configured" : "missing"
        );
        const options = {
          app: this.app, viewModel: adapter.read(), actions: adapter.actions,
          subscribe: adapter.subscribe ? (listener: () => void) => adapter.subscribe!(listener) : undefined, read: () => adapter.read(),
          language: this.plugin.settings.settingsLanguage,
          openProviders: () => { void this.activateSettingsTab(Platform.isDesktopApp ? "models" : "providers", true); }
        };
        if (Platform.isDesktopApp) {
          if (this.desktopAccount) this.desktopAccount.mount(bodyEl);
          else this.desktopAccount = mountDesktopAccountMembership(bodyEl, options);
        } else this.accountPage = mountAccountMembership(bodyEl, options);
      } else if (activeTab === "todos") {
        this.renderTodosSettings(bodyEl);
      } else {
        this.renderGeneralSettings(bodyEl);
      }
      if (this.pendingDesktopClosePrompt) {
        this.pendingDesktopClosePrompt = false; this.preserveDesktopCloseDraft = false;
        const leave = () => (this.app as unknown as { setting?: { close?(): void } }).setting?.close?.();
        if (this.leaveDesktopAccount(leave)) { /* Account forms preserve their own drafts. */ }
        else if (this.leaveDesktopAgentDetail(leave)) { /* The active form owns its leave prompt. */ }
        else if (this.desktopSelection?.controller?.hasUnsavedChanges()) this.desktopSelection.controller.requestBack(leave);
        else if (this.desktopKnowledge?.hasDraft) this.desktopKnowledge.requestLeave(leave);
        else if (this.settingsDetail === "knowledge-preferences") void this.confirmKnowledgePreferenceDiscard().then(discard => { if (discard) { this.resetKnowledgePreferenceDraft(); leave(); } });
      }
    } finally {
      const tab = this.activeSettingsTab();
      const location = JSON.stringify([tab, this.desktopAgents?.isDetail, this.desktopProfileOpen, this.settingsDetail, this.desktopCorrection?.controller.settingsPageStep ?? null, this.knowledgeMaintenanceSelectedRecord?.recordId ?? null,
        tab === "resources" || tab === "capabilities" ? this.plugin.settings.resourceManagementTab : null,
        this.desktopRoute?.section ?? null, this.desktopRoute?.capabilityTab ?? null, this.providerPickerOpen, this.inlineEditor?.key ?? null,
        tab === "modules" && !this.settingsDetail ? this.desktopKnowledge?.navigationKey() ?? null : null,
        this.settingsDetail === "generation-template" ? this.desktopGenerationTemplates?.editorFocusKey() : null,
        typeof this.settingsDetail === "object" && this.settingsDetail?.kind === "lifestyle"
          ? this.lifestyleSettingsPanel?.navigationKey() : null]);
      const inlineHost = this.inlineEditor?.host ?? null;
      if (location !== this.renderedSettingsLocation || inlineHost !== this.renderedInlineHost) {
        // A new page starts at its heading; background refreshes keep their position.
        const rootScroll = settingsScrollSnapshot.find((entry) => entry.element === this.containerEl);
        if (this.renderedSettingsLocation && rootScroll) this.locationScroll.set(this.renderedSettingsLocation, rootScroll.top);
        const top = Platform.isDesktopApp ? this.locationScroll.get(location) ?? 0 : 0;
        if (rootScroll) { rootScroll.top = top; rootScroll.left = 0; }
        else settingsScrollSnapshot.unshift({ element: this.containerEl, top, left: 0 });
      }
      this.renderedSettingsLocation = location;
      this.renderedInlineHost = inlineHost;
      if (this.pendingKnowledgeHistoryScroll) {
        for (const saved of this.pendingKnowledgeHistoryScroll) { const target = settingsScrollSnapshot.find((item) => item.element === saved.element); if (target) { target.top = saved.top; target.left = saved.left; } else settingsScrollSnapshot.push(saved); }
        this.pendingKnowledgeHistoryScroll = null;
      }
      restoreSettingsScrollSnapshot(settingsScrollSnapshot);
      this.restoreSettingsFocusIntent();
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
      && this.settingsTabs().some((tab) => tab.id === settingsTabId)
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
      && (RESOURCE_TABS.some((tab) => tab.id === resourceTabId) || Platform.isDesktopApp && resourceTabId === "tools")
    ) {
      this.resourceTabFocusId = resourceTabId as ResourceNavigationTab;
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
          "button, input, select, textarea, a[href], [tabindex]"
        )).find((element) => this.settingsFocusKey(element) === sharedKey);
        if (!focusable?.isConnected) return;
        if (sharedKey === "explicit:account:login" || sharedKey === "explicit:account:benefits" || sharedKey === "explicit:general:appearance") focusable.scrollIntoView({ block: "center" });
        focusable.focus({ preventScroll: true });
        if (this.containerEl.ownerDocument.activeElement !== focusable) return;
        settingsContainerFocusIntents.delete(this.containerEl);
        this.settingsFocusIntent = null;
      });
      return;
    }
    const focusable = Array.from(this.containerEl.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex]"
    )).find((element) => this.settingsFocusKey(element) === key);
    if (!focusable) return;
    const focusTarget = () => {
      if (!focusable.isConnected || focusable.closest("[hidden], [inert]")) return;
      if (key === "explicit:account:login" || key === "explicit:account:benefits" || key === "explicit:general:appearance") focusable.scrollIntoView({ block: "center" });
      focusable.focus({ preventScroll: true });
    };
    focusTarget();
    (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(focusTarget);
    this.settingsFocusIntent = null;
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
    if (step === "sidebar" || step === "settings" || step === "colleague") {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const requiredTab = echoInkOnboardingTab(step);
    const requiredDesktop = step === "personality" ? "agent" : resolveDesktopSettingsRoute(requiredTab).tab;
    if ((Platform.isDesktopApp ? this.activeSettingsTab() !== requiredDesktop : this.plugin.settings.settingsTab !== requiredTab)) {
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
    if (step === "sidebar" || step === "settings" || step === "colleague") {
      this.clearOnboardingCoachmark(false);
      return;
    }
    const anchorKey = step === "provider"
      ? "providers:add"
      : step === "knowledge"
        ? "knowledge:onboarding"
        : "general:personality-template";
    const anchor = (step === "personality" ? this.containerEl.querySelector<HTMLElement>(".echoink-agent-editor-header") : null)
      ?? this.containerEl.querySelector<HTMLElement>(`[data-echoink-focus-key="${anchorKey}"]`)
      ?? this.settingsBodyEl?.querySelector<HTMLElement>(".settings-page-header, .settings-header, h2")
      ?? this.settingsBodyEl;
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
      onDismiss: () => {
        void this.runOnboardingAfterLeave(async () => { await this.plugin.dismissEchoInkOnboarding(); this.clearOnboardingCoachmark(true); });
        return false;
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

  private async runOnboardingAfterLeave(action: () => Promise<void>): Promise<void> {
    if (this.onboardingNavigationPending) return;
    let pending: Promise<void> | undefined;
    const run = () => {
      if (this.onboardingNavigationPending) return;
      this.onboardingNavigationPending = true;
      const card = this.onboardingCoachmarkHandle?.element;
      card?.setAttribute("aria-busy", "true"); card?.querySelectorAll("button").forEach(button => { button.disabled = true; });
      pending = this.plugin.runEchoInkOnboardingNavigation(action).catch(error => { console.warn("EchoInk onboarding navigation failed", error); new Notice(this.plugin.settings.settingsLanguage === "en" ? "Tutorial progress could not be saved. Try again." : "引导进度保存失败，请重试。"); })
        .finally(() => { this.onboardingNavigationPending = false; card?.setAttribute("aria-busy", "false"); card?.querySelectorAll("button").forEach(button => { button.disabled = false; }); });
    };
    if (this.leaveDesktopAgentDetail(run)) { await pending; return; }
    if (this.desktopKnowledge?.isDetail) { this.desktopKnowledge.requestLeave(run); await pending; return; }
    this.suspendActiveEditor(); run(); await pending;
  }
  private async advanceOnboardingTutorial(step: EchoInkOnboardingStep): Promise<void> {
    await this.runOnboardingAfterLeave(async () => {
      const nextStep = await this.plugin.advanceEchoInkOnboarding(step);
      if (!nextStep) { this.showOnboardingCompletion(); return; }
      await this.showOnboardingTutorialStep(nextStep);
    });
  }
  private async selectOnboardingTutorialStep(step: EchoInkOnboardingStep, nextStep: EchoInkOnboardingStep): Promise<void> {
    await this.runOnboardingAfterLeave(async () => {
      if (await this.plugin.selectEchoInkOnboardingStep(step, nextStep)) await this.showOnboardingTutorialStep(nextStep);
    });
  }
  private async showOnboardingTutorialStep(nextStep: EchoInkOnboardingStep): Promise<void> {
    await this.plugin.openPendingEchoInkOnboarding();
    if (nextStep === "sidebar" || nextStep === "settings" || nextStep === "colleague") {
      this.clearOnboardingCoachmark(false); this.onboardingRestoreFocusEl = null;
      (this.app as unknown as { setting?: { close(): void } }).setting?.close();
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
      await this.plugin.openPaperGuideAfterOnboarding();
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
      title: zh ? (Platform.isDesktopApp ? "通用" : "基础设置") : "General",
      titleVisibility: Platform.isDesktopApp ? "screen-reader" : "visible",
      description: Platform.isDesktopApp ? undefined : zh
        ? "调整 EchoInk 的界面语言、启动方式、长期记忆和个性化。"
        : "Choose EchoInk's language, startup behavior, long-term memory, and personalization."
    });
    page.addClass("echoink-general-page");
    const appearanceSection = createSettingsSection(page, { title: Platform.isDesktopApp ? (zh ? "外观" : "Appearance") : undefined, surface: "group" });
    appearanceSection.addClass("echoink-appearance-section");
    appearanceSection.setAttribute("data-echoink-focus-key", "general:appearance");
    appearanceSection.setAttribute("tabindex", "-1");
    const appearanceRow = applySettingsRow(new OriginSetting(Platform.isDesktopApp ? createSettingsGroup(appearanceSection) : appearanceSection)
      .setName(Platform.isDesktopApp ? (zh ? "配色" : "Color theme") : zh ? "外观" : "Appearance")
      .setDesc(Platform.isDesktopApp ? "" : zh
        ? "选择主题颜色，浅色与深色跟随 Obsidian。"
        : "Choose a color theme. Light and dark modes follow Obsidian."));
    renderAppearancePicker(appearanceRow.controlEl, this.plugin, zh);
    renderCompanionThemeRecommendation(appearanceSection, zh, this.app.vault.configDir);
    const interfaceSection = createSettingsSection(page, {
      title: zh ? "界面与启动" : "Interface and startup",
      surface: "group"
    });
    const interfaceGroup = createSettingsGroup(interfaceSection);
    applySettingsRow(new OriginSetting(interfaceGroup).setName(copy.general.settingsLanguage).setDesc(Platform.isDesktopApp ? "" : copy.general.settingsLanguageDesc).addOriginDropdown(this.app, (dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.general.settingsLanguage);
      for (const language of SETTINGS_LANGUAGE_OPTIONS) dropdown.addOption(language, copy.general.languageOptions[language]);
      dropdown.setValue(this.plugin.settings.settingsLanguage);
      dropdown.onChange(async (value) => {
        const previous = this.plugin.settings.settingsLanguage;
        this.plugin.settings.settingsLanguage = normalizeSettingsLanguage(value);
        try { await this.plugin.saveSettings(true); }
        catch { this.plugin.settings.settingsLanguage = previous; dropdown.setValue(previous); new Notice(zh ? "界面语言未保存，请重试" : "Language was not saved. Try again."); return; }
        await this.plugin.refreshLanguageSurfaces();
        // Refresh native labels/index as well as the existing content. The
        // method is absent on old hosts, which continue through display().
        (this as CodexSettingTab & { update?: () => void }).update?.();
        this.scheduleDisplay();
      });
    }));

    const workbenchStartup = applySettingsRow(new OriginSetting(interfaceGroup)
      .setName(Platform.isDesktopApp ? (zh ? "启动时打开工作台" : "Open workbench on startup") : copy.general.autoOpenHome)
      .setDesc(Platform.isDesktopApp ? "" : (zh ? "Obsidian 启动后显示 EchoInk 首页概览。" : "Show the EchoInk home overview when Obsidian starts."))
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, Platform.isDesktopApp ? (zh ? "启动时打开工作台" : "Open workbench on startup") : copy.general.autoOpenHome);
        toggle.setValue(this.plugin.settings.autoOpenHome).onChange(async (value) => {
          const previous = this.plugin.settings.autoOpenHome;
          this.plugin.settings.autoOpenHome = value;
          try { await this.plugin.saveSettings(); }
          catch { this.plugin.settings.autoOpenHome = previous; toggle.setValue(previous); new Notice(zh ? "启动设置未保存，请重试" : "Startup setting was not saved. Try again."); }
        });
      }));

    const sidebarStartup = applySettingsRow(new OriginSetting(interfaceGroup)
      .setName(Platform.isDesktopApp ? (zh ? "启动时打开 Agent 侧栏" : "Open Agent sidebar on startup") : copy.general.autoOpen)
      .setDesc(Platform.isDesktopApp ? "" : zh ? "Obsidian 启动后自动打开 EchoInk 侧栏。" : "Open the EchoInk sidebar when Obsidian starts.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, Platform.isDesktopApp ? (zh ? "启动时打开 Agent 侧栏" : "Open Agent sidebar on startup") : copy.general.autoOpen);
        toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
          const previous = this.plugin.settings.autoOpen;
          this.plugin.settings.autoOpen = value;
          try { await this.plugin.saveSettings(); }
          catch { this.plugin.settings.autoOpen = previous; toggle.setValue(previous); new Notice(zh ? "启动设置未保存，请重试" : "Startup setting was not saved. Try again."); }
        });
      }));

    if (!Platform.isDesktopApp) interfaceGroup.insertBefore(sidebarStartup.settingEl, workbenchStartup.settingEl);
    renderObsidianCliStatus(interfaceGroup, zh);

    const quickChatSection = createSettingsSection(page, { title: zh ? "快捷 AI 小窗" : "Quick AI window", surface: "group" });
    const quickDrawer = Platform.isDesktopApp ? quickChatSection.createEl("details", { cls: "echoink-quick-chat-drawer" }) : quickChatSection;
    if (quickDrawer.instanceOf(this.containerEl.ownerDocument.defaultView!.HTMLDetailsElement)) {
      quickDrawer.open = this.plugin.settings.quickChat.enabled && (this.quickChatExpanded ?? true);
      quickDrawer.addEventListener("toggle", () => { this.quickChatExpanded = quickDrawer.open; });
    }
    const quickHeader = Platform.isDesktopApp ? quickDrawer.createEl("summary") : quickDrawer;
    const quickChatGroup = createSettingsGroup(quickHeader);
    const quickChatToggleLabel = Platform.isDesktopApp ? (zh ? "快捷 AI 小窗" : "Quick AI window") : zh ? "全局快捷键唤起 AI 小窗" : "Global quick AI window hotkey";
    applySettingsRow(new OriginSetting(quickChatGroup)
      .setName(quickChatToggleLabel)
      .setDesc(Platform.isDesktopApp ? this.plugin.settings.quickChat.enabled ? formatAcceleratorForDisplay(this.plugin.settings.quickChat.hotkey, Platform.isMacOS) : (zh ? "未启用" : "Not enabled") : zh
        ? "在任意应用前台时按快捷键，EchoInk 对话小窗浮现在当前屏幕上，直接提问；再次按下收起，按 Esc 关闭。收起保留草稿与正在生成的回答。需要 Obsidian 桌面端保持运行。"
        : "From any app, press the hotkey to float the EchoInk chat window over the current screen and ask directly. Press again or hit Esc to collapse; drafts and running generations survive. Requires the Obsidian desktop app to stay running.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, quickChatToggleLabel);
        toggle.setValue(this.plugin.settings.quickChat.enabled).onChange(async (value) => {
          const previous = this.plugin.settings.quickChat.enabled;
          this.plugin.settings.quickChat.enabled = value;
          try { await this.plugin.saveSettings(); }
          catch {
            this.plugin.settings.quickChat.enabled = previous;
            toggle.setValue(previous);
            new Notice(zh ? "快捷 AI 小窗设置未保存，请重试" : "Quick AI window settings were not saved. Try again.");
            return;
          }
          this.quickChatExpanded = value;
          const result = this.plugin.applyQuickChatSettings();
          if (value && !result.ok) {
            new Notice(describeQuickChatRegistration(result, true, this.plugin.settings.quickChat.hotkey, zh));
          }
          this.scheduleDisplay();
        });
      }));

    if (Platform.isDesktopApp) {
      const row = quickChatGroup.querySelector<HTMLElement>(".setting-item");
      if (row) {
        const icon = row.createSpan({ cls: "echoink-quick-chat-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, "zap");
        row.prepend(icon);
      }
    }
    if (Platform.isDesktopApp) quickHeader.addEventListener("click", event => {
      if ((event.target as HTMLElement).closest("[role=switch]")) { event.preventDefault(); return; }
      if (!this.plugin.settings.quickChat.enabled) event.preventDefault();
    });
    const quickChatOptions = Platform.isDesktopApp ? createSettingsGroup(quickDrawer.createDiv({ cls: "echoink-quick-chat-options" })) : quickChatGroup;
    applySettingsRow(new OriginSetting(quickChatOptions)
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
          if (isImeKeyEvent(event)) return;
          const recorded = recordAcceleratorFromEvent(event);
          if (!recorded.valid) return;
          const normalized = normalizeAccelerator(recorded.accelerator);
          if (!normalized) return;
          const previous = settings.quickChat.hotkey;
          settings.quickChat.hotkey = normalized;
          void (async () => {
            try { await this.plugin.saveSettings(); }
            catch { settings.quickChat.hotkey = previous; renderHotkey(); new Notice(zh ? "快捷键未保存，请重试" : "Hotkey was not saved. Try again."); return; }
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
    applySettingsRow(new OriginSetting(quickChatOptions)
      .setName(zh ? "注册状态" : "Registration status")
      .setDesc(describeQuickChatRegistration(
        quickChatRegistration,
        this.plugin.settings.quickChat.enabled,
        this.plugin.settings.quickChat.hotkey,
        zh
      )));

    if (!Platform.isDesktopApp) {
      this.renderJournalSettings(page);
    }
    this.renderDeveloperModeSettings(page);
    this.renderAboutSection(page);
  }

  private renderJournalSettings(page: HTMLElement, embedded = false): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const journalSection = createSettingsSection(page, {
      title: embedded ? undefined : zh ? "日记" : "Journal",
      surface: embedded ? "flat" : "group"
    });
    const journalGroup = createSettingsGroup(journalSection);
    applySettingsRow(new OriginSetting(journalGroup)
      .setName(zh ? "日记保存文件夹" : "Journal folder")
      .setDesc(zh
        ? embedded ? "与 Obsidian 原生日记共用文件夹、日期格式和模板。" : "与 Obsidian 原生日记共用文件夹。日期格式和模板可在原生日记设置中调整；默认按月存放，每天一篇。"
        : embedded ? "Shares the Obsidian Daily notes folder, date format, and template." : "Shared with Obsidian Daily notes. Set the date format and template there; the default is one note per day in monthly folders.")
      .addOriginText((text) => {
        const label = zh ? "日记保存文件夹" : "Journal folder";
        text.setPlaceholder("Journal").setValue(readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory).folder);
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

    if (Platform.isDesktopApp) {
      const automatic = new OriginSetting(journalGroup)
        .setName(zh ? "从日记自动整理待办和账单" : "Organize to-dos and finances from journals")
        .setDesc(zh ? "日记内容会发给你当前配置的模型服务，并消耗它的额度。停笔满 1 小时后整理；收支需要 PRO。"
          : "Journal content is sent to your configured model service and uses its quota. Runs after one hour without changes; finances require PRO.")
        .addOriginToggle(toggle => toggle.setValue(this.plugin.settings.diaryOrganizerEnabled).onChange(async value => {
          toggle.setDisabled(true);
          try {
            if (!this.plugin.diaryOrganizer) throw new Error(zh ? "日记整理尚未就绪，请稍后重试。" : "Journal organizer is not ready yet.");
            await this.plugin.diaryOrganizer.setEnabled(value);
          } catch (error) {
            toggle.setValue(this.plugin.settings.diaryOrganizerEnabled);
            new Notice(error instanceof Error ? error.message : String(error));
          } finally { toggle.setDisabled(false); }
        }));
      automatic.settingEl.dataset.diaryOrganizer = "setting";
    }

  }

  private ensureDesktopAgents(): DesktopAgentSettings {
    const plugin = this.plugin;
    let resources: readonly EchoInkResource[] = [];
    return this.desktopAgents ??= new DesktopAgentSettings({
      get settings() { return plugin.settings; }, app: this.app, draftCacheKey: plugin,
      loadResources: async () => resources = await plugin.buildRuntimeEchoInkResourceCatalog(),
      saveAgent: (agent, modules, baseline) => plugin.saveAgentDefinition(agent, modules, baseline),
      deleteAgent: id => plugin.deleteAgent(id), getDeleteCounts: id => plugin.getAgentDeleteCounts(id),
      getCapabilityAvailability: id => plugin.getAgentCapabilityAvailability(id, resources),
      setAgentModuleOwner: (module, id) => plugin.setAgentModuleOwner(module, id)
    }, { redraw: () => this.scheduleDisplay(), restoreFocus: key => { this.settingsFocusIntent = `explicit:${key}`; } });
  }
  private ensureDesktopProfile(): UserProfileSettingsController {
    return this.desktopProfile ??= new UserProfileSettingsController({
      read: () => this.plugin.readEchoInkUserProfile(),
      update: input => this.plugin.saveEchoInkUserProfile(input),
      confirm: async input => {
        const state = await this.plugin.readEchoInkUserProfile();
        if (state.revision !== input.expectedRevision) throw new Error("revision_conflict");
        const item = state.items.find(item => item.profileKey === input.profileKey);
        if (!item) throw new Error("profile_item_missing");
        return this.plugin.saveEchoInkUserProfile({ ...input, text: item.text });
      },
      remove: input => this.plugin.deleteEchoInkUserProfile(input),
      back: () => { this.desktopProfileOpen = false; this.settingsFocusIntent = "explicit:agent:profile"; this.scheduleDisplay(); }
    }, this.plugin.settings.settingsLanguage);
  }
  private renderDesktopAgentSettings(container: HTMLElement): void {
    const agents = this.ensureDesktopAgents();
    if (this.pendingDesktopAgentEditor) {
      const agentId = this.pendingDesktopAgentEditor; this.pendingDesktopAgentEditor = null;
      agents.open(agentId);
    }
    if (agents.isDetail) { agents.renderDetail(container); return; }
    if (this.desktopProfileOpen) { this.ensureDesktopProfile().render(container); return; }
    if (this.desktopCorrection) { this.renderDesktopMemoryCorrection(container); return; }
    if (this.settingsDetail === "review-archives" || this.settingsDetail === "review-memory"
      || typeof this.settingsDetail === "object" && this.settingsDetail?.kind === "review-memory-category") {
      this.renderReviewSettings(container); return;
    }
    const page = createSettingsPage(container, { title: "Agent", titleVisibility: "screen-reader" });
    page.addClass("echoink-desktop-agent-page");
    agents.renderSummary(page);
    this.desktopMemory ??= new DesktopMemorySettings(this.plugin, {
      redraw: () => this.scheduleDisplay(), openCorrection: () => this.openSettingsDetail("review-memory"),
      openProfile: () => { this.ensureDesktopProfile().refreshWhenOpened(); this.desktopProfileOpen = true; this.scheduleDisplay(); }
    });
    this.desktopMemory.render(page);
    this.renderReviewManagement(page);
    if (!this.archivedConversations && !this.archivedConversationsLoading && !this.archivedConversationsError) void this.loadArchivedConversations();
  }
  private leaveDesktopAccount(done: () => void): boolean {
    if (!Platform.isDesktopApp || !this.desktopAccount) return false;
    this.desktopAccount.requestLeave(() => {
      this.desktopAccount?.dispose(); this.desktopAccount = null; done();
    });
    return true;
  }

  private leaveDesktopAgentDetail(done: () => void): boolean {
    if (!Platform.isDesktopApp) return false;
    if (this.desktopAgents?.isDetail) { this.desktopAgents.requestLeave(done); return true; }
    if (this.desktopProfileOpen) {
      this.desktopProfile?.requestLeave(() => { this.desktopProfileOpen = false; done(); }); return true;
    }
    if (this.desktopCorrection) {
      const controller = this.desktopCorrection.controller;
      controller.requestLeave(() => { controller.suspend(); this.desktopCorrection = null; done(); }); return true;
    }
    if (this.desktopMemory?.submitting) return true;
    return false;
  }

  private renderDesktopModuleSettings(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const knowledge = this.ensureDesktopKnowledge();
    if (this.settingsDetail === "generation-template") { this.ensureGenerationTemplates().renderEditor(container); return; }
    if (this.settingsDetail === "generation-templates") { this.ensureGenerationTemplates().renderList(container); return; }
    if (this.plugin.consumeKnowledgeLinkingFocus()) { this.knowledgeLinkingTaskId = this.plugin.consumeKnowledgeLinkingTaskId(); this.openSettingsDetail("knowledge-linking"); }
    if (this.settingsDetail === "knowledge-preferences") { this.desktopModuleExpanded.add("knowledge"); this.renderKnowledgeMaintenancePreferences(container); return; }
    if (this.settingsDetail === "knowledge-linking") { this.desktopModuleExpanded.add("knowledge"); this.knowledgeLinkingCleanup = renderKnowledgeLinkingSection(container, this.plugin, () => { void this.closeSettingsDetail(); }, this.knowledgeLinkingTaskId ?? undefined); return; }
    if (typeof this.settingsDetail === "object" && this.settingsDetail?.kind === "resource") {
      const resourceId = this.settingsDetail.resourceId;
      const resource = this.currentEchoInkResourceCatalog().find(item => item.id === resourceId);
      if (resource) { this.renderResourceDetail(container, resource); return; }
    }
    if (this.settingsDetail === "knowledge-folders") { this.desktopModuleExpanded.add("knowledge"); this.settingsDetail = null; knowledge.open("initialize"); return; }
    if (this.settingsDetail === "pdf-reading") {
      const page = createSettingsPage(container, { title: zh ? "PDF 精读 · 提取" : "PDF reading and extraction", detail: true,
        backLabel: zh ? "返回模块" : "Back to modules", onBack: () => { void this.closeSettingsDetail(); } });
      this.pdfSettingsPanel ??= new PdfReadingSettingsPanel(this.plugin, () => { void this.closeSettingsDetail(); });
      this.pdfSettingsPanel.render(page, { embedded: true });
      this.restoreModuleInputs(page, "pdf");
      return;
    }
    if (knowledge.isDetail) { knowledge.renderDetail(container); return; }
    if (this.settingsDetail === "selection-ask") {
      if (!this.desktopSelection) {
        const host = container.createDiv();
        const controller = renderSelectionAnnotationSettings(host, this.plugin, () => { void this.closeSettingsDetail(); });
        this.desktopSelection = { host, controller };
      } else container.appendChild(this.desktopSelection.host);
      return;
    }
    if (this.settingsDetail === "journal-templates") {
      if (!this.desktopTemplate) {
        const host = createSettingsPage(container, { title: zh ? "日记模板" : "Journal templates", detail: true, backLabel: zh ? "返回模块" : "Back to modules", onBack: () => { void this.closeSettingsDetail(); } });
        const service = this.journalTemplateService();
        const modal = new JournalTemplateModal(this.app, { service, customTemplates: service.listCustomTemplates(), date: new Date(), language: this.plugin.settings.settingsLanguage });
        this.desktopTemplate = { host, dispose: modal.mountManagement(host) };
      } else container.appendChild(this.desktopTemplate.host);
      return;
    }
    if (this.settingsDetail === "todo-categories") {
      const page = createSettingsPage(container, { title: zh ? "待办分类" : "To-do categories", detail: true, backLabel: zh ? "返回模块" : "Back to modules", onBack: () => { void this.closeSettingsDetail(); } });
      this.renderTodosSettings(page, true); return;
    }
    const section = this.desktopRoute?.section;
    if (section) {
      const module: DesktopModuleId = section === "knowledgeBase" ? "knowledge" : section === "todos" ? "todo" : section;
      this.desktopModuleExpanded.add(module);
      this.desktopRoute = { ...this.desktopRoute!, section: undefined };
    }
    if (this.settingsDetail === "english-diary") {
      this.desktopModuleExpanded.add("english"); this.settingsDetail = null;
      if (this.settingsFocusIntent !== "explicit:english-diary:home-shortcut") this.settingsFocusIntent = "explicit:module:english";
    }
    if (typeof this.settingsDetail === "object" && this.settingsDetail?.kind === "lifestyle") { this.desktopModuleExpanded.add("finance"); this.settingsDetail = null; }
    this.plugin.settings.resourceManagementTab = "plugins";
    const page = createSettingsPage(container, { title: zh ? "模块" : "Modules", titleVisibility: "screen-reader" });
    this.desktopModuleCleanup = mountDesktopModuleSettings(page, {
      plugin: this.plugin, expanded: this.desktopModuleExpanded,
      details: { pdf: () => this.openPdfReadingDetail() },
      summary: module => {
        if (module === "knowledge") {
          const count = this.plugin.settings.knowledgeBase.folderBindings?.roles.raw.readPaths.length ?? 0;
          const registry = this.plugin.settings.agentRegistry;
          const owner = registry?.agents.find(agent => agent.id === registry.moduleOwners["knowledge-base"]) ?? registry?.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID);
          return zh ? `资料来源 ${count} 个 · 负责人 ${owner?.name || "未分配"}` : `${count} source folders · Owner ${owner?.name || "Unassigned"}`;
        }
        return module === "journal" ? readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory).folder : module === "review" ? this.plugin.settings.review.outputDir : module === "todo" ? TODO_SOURCE_PATH : module === "finance" ? this.plugin.lifestyle.finance.ledger.paths().root : module === "english" ? this.plugin.settings.englishDiary.englishDirectory : module === "pdf" ? this.plugin.settings.pdfReading.engine === "mineru" ? "MinerU" : zh ? "本地文字提取" : "Local text extraction" : "";
      },
      onProBenefits: () => { this.openDesktopRoute({ tab: "account", focus: "account:benefits" }); },
      renderContent: (module, parent) => {
        try {
        if (module === "knowledge") { const summary = knowledge.renderSummary(parent); this.ensureGenerationTemplates().renderNavigation(summary); }
        else if (module === "journal") {
          this.renderJournalSettings(parent, true);
          const count = BUILT_IN_JOURNAL_TEMPLATES.length + this.journalTemplateService().listCustomTemplates().length;
          createSettingsNavigationRow(parent, { title: zh ? "日记模板" : "Journal templates", value: zh ? `${count} 个` : String(count), focusKey: "journal:templates", onActivate: () => this.openSettingsDetail("journal-templates") });
        } else if (module === "review") this.renderReviewSettings(parent, true);
        else if (module === "todo") this.renderDesktopTodoSummary(parent);
        else if (module === "selection") createSettingsNavigationRow(parent, { title: zh ? "提问选项" : "Question actions", value: String(this.plugin.settings.selectionAsk.actions.length), focusKey: "selection-ask:settings", onActivate: () => this.openSettingsDetail("selection-ask") });
        else if (module === "finance") {
          this.lifestyleSettingsPanel ??= new LifestyleSettingsPanel(this.plugin, "finance", () => { void this.closeSettingsDetail(); }, () => this.scheduleDisplay());
          this.lifestyleSettingsPanel.render(parent, { embedded: true }); return () => this.lifestyleSettingsPanel?.dispose();
        } else if (module === "inline-agent") renderInlineAgentSettings(parent, this.plugin);
        else this.renderEnglishDiarySettings(parent, true);
        } finally {
          const location = module === "finance" ? this.lifestyleSettingsPanel?.navigationKey() ?? "finance:root" : module;
          this.restoreModuleInputs(parent, location);
        }
      }
    });
  }

  private ensureDesktopKnowledge(): DesktopKnowledgeSettings {
    return this.desktopKnowledge ??= new DesktopKnowledgeSettings(this.plugin, { redraw: () => this.scheduleDisplay(), openPreferences: () => this.openSettingsDetail("knowledge-preferences"), openLinking: () => this.openSettingsDetail("knowledge-linking"), openEditor: editor => this.openInlineEditor(editor, "modules", () => this.ensureDesktopKnowledge().open("management")) });
  }

  private ensureGenerationTemplates(): GenerationTemplatesSection {
    return this.desktopGenerationTemplates ??= new GenerationTemplatesSection(this.plugin, {
      openList: () => this.openSettingsDetail("generation-templates"), closeList: () => { void this.closeSettingsDetail(); },
      openEditor: id => this.openGenerationTemplateEditor(id), closeEditor: () => { void this.closeSettingsDetail(); }, redraw: () => this.scheduleDisplay()
    });
  }

  private openGenerationTemplateEditor(id: string | null): void {
    this.desktopModuleExpanded.add("knowledge");
    this.ensureGenerationTemplates().open(id);
    this.openSettingsDetail("generation-template");
  }

  private moduleInputFields(parent: HTMLElement): Array<[string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | OriginSelectElement]> {
    return Array.from(parent.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | OriginSelectElement>(`input:not([type=file]):not([type=checkbox]):not([type=hidden]),textarea,select${parent.dataset.moduleDraftLocation === "pdf" ? ",button[role=combobox]" : ""}`))
      .map((field, index): [string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | OriginSelectElement] => [field.getAttribute("aria-label") || field.closest("label")?.querySelector(".echoink-pdf-setting-name")?.textContent?.trim() || field.id || field.closest("label")?.textContent?.trim() || String(index), field]);
  }

  private restoreModuleInputs(parent: HTMLElement, location: string): void {
    parent.dataset.moduleDraftLocation = location;
    this.moduleInputFields(parent).forEach(([key, field]) => {
      this.moduleInputBaselines.set(field, field.value);
      const value = this.moduleInputDrafts.get(`${location}:${key}`);
      if (value !== undefined) field.value = value;
    });
  }

  private captureModuleInputs(): void {
    this.settingsBodyEl?.querySelectorAll<HTMLElement>("[data-module-draft-location]").forEach(parent => {
      const location = parent.dataset.moduleDraftLocation!;
      if (location.startsWith("finance:") && location !== this.lifestyleSettingsPanel?.navigationKey()) {
        for (const key of this.moduleInputDrafts.keys()) if (key.startsWith(`${location}:`)) this.moduleInputDrafts.delete(key);
        return;
      }
      for (const [key, field] of this.moduleInputFields(parent)) {
        const pdf = this.plugin.settings.pdfReading;
        const baseline = location === "pdf" && !field.disabled ? ({ "解析方式": pdf.engine, "MinerU 专用 Token": pdf.mineruToken, "默认翻译语言": pdf.translationLanguage,
          "原 PDF 保存位置": this.plugin.pdfReading?.defaultOriginalDirectory() ?? pdf.originalDirectory } as Record<string, string>)[key] ?? this.moduleInputBaselines.get(field) : this.moduleInputBaselines.get(field);
        if (field.value === baseline) this.moduleInputDrafts.delete(`${location}:${key}`);
        else this.moduleInputDrafts.set(`${location}:${key}`, field.value);
      }
    });
  }

  private journalTemplateService(): HomeWorkbenchDataService {
    return new HomeWorkbenchDataService(this.app, () => this.plugin.settings.journalDirectory, this.plugin.homeActivity, undefined, () => this.plugin.settings.knowledgeBase.folderBindings);
  }

  private clearDesktopSelection(): void {
    if (!this.desktopSelection) return;
    disposeOriginControls(this.desktopSelection.host); this.desktopSelection.host.remove(); this.desktopSelection = null;
  }

  private renderDesktopTodoSummary(parent: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    createSettingsNavigationRow(parent, { title: zh ? "待办源文件" : "To-do source file", value: TODO_SOURCE_PATH, actionLabel: zh ? "打开" : "Open", onActivate: () => { void this.plugin.getTodoStore().openSourceFile(); } });
    this.disposeTodoReminders = renderTodoReminderSettings(parent, this.plugin, { embedded: true });
    createSettingsNavigationRow(parent, { title: zh ? "分类" : "Categories", value: String(this.plugin.settings.todoCategories.length), focusKey: "todo:categories", onActivate: () => this.openSettingsDetail("todo-categories") });
  }

  private renderTodosSettings(page: HTMLElement, categoriesOnly = false): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const store = this.plugin.getTodoStore();
    this.disposeTodoStatistics?.();
    this.disposeTodoReminders?.();
    this.disposeTodoStatistics = null;
    if (!categoriesOnly && !Platform.isDesktopApp) {
      const statistics = page.createDiv();
      const renderStats = () => renderTodoStatistics(statistics, store, this.plugin.settings.settingsLanguage, this.app);
      renderStats();
      this.disposeTodoStatistics = store.subscribe(() => {
        if (statistics.isConnected) renderStats();
      });
    }
    if (!categoriesOnly) {
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
    const openButton = createOriginButton(sourceRow.controlEl, {
      cls: "button",
      attr: { type: "button", "aria-label": zh ? "打开待办源文件" : "Open to-do source file" }
    });
    setIcon(openButton.createSpan({ attr: { "aria-hidden": "true" } }), "file-text");
    openButton.createSpan({ text: zh ? "打开源文件" : "Open source file" });
    openButton.onclick = () => void store.openSourceFile();
    this.disposeTodoReminders = renderTodoReminderSettings(page, this.plugin);
    }

    const section = createSettingsSection(page, {
      title: zh ? "待办分类" : "To-do categories",
      surface: "group"
    });
    const group = createSettingsGroup(section);
    applySettingsRow(new OriginSetting(group)
      .setName(zh ? "分类与待办的关系" : "Categories and to-dos")
      .setDesc(zh
        ? "分类以名称写入源文件；重命名后已有待办同步显示新名称；删除分类不会删除待办，相关事项转为「未分类」。"
        : "Categories are stored by name in the source file; renames apply to existing to-dos. Deleting a category keeps its to-dos, which become uncategorized."));
    for (const category of this.plugin.settings.todoCategories) {
      const row = group.createDiv({ cls: "echoink-settings-compact-row" });
      const rowCopy = row.createDiv({ cls: "echoink-settings-compact-copy" });
      rowCopy.createDiv({ cls: "echoink-settings-compact-title", text: category.name });
      const rowActions = row.createDiv({ cls: "echoink-settings-compact-actions" });
      const renameButton = createOriginButton(rowActions, {
        cls: "icon-button",
        attr: { type: "button", "aria-label": zh ? `重命名分类 ${category.name}` : `Rename category ${category.name}` }
      });
      setIcon(renameButton, "pencil");
      renameButton.onclick = () => void (async () => {
        const next = await this.moduleTextInput(
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
        try {
          await store.renameCategoryInSource(previous, trimmed);
        } catch {
          category.name = previous;
        }
        await this.plugin.saveSettings();
        this.plugin.notifyHomeSurfacesChanged();
        this.scheduleDisplay();
      })();
      const deleteButton = createOriginButton(rowActions, {
        cls: "icon-button settings-danger",
        attr: { type: "button", "aria-label": zh ? `删除分类 ${category.name}` : `Delete category ${category.name}`, "aria-expanded": "false" }
      });
      if (Platform.isDesktopApp) applyDeleteButton(deleteButton, { iconOnly: true }); else setIcon(deleteButton, "trash-2");
      deleteButton.onclick = () => showSettingsInlineConfirmation(row, deleteButton, {
        deleteAction: Platform.isDesktopApp,
        message: zh
          ? `删除「${category.name}」后，${store.snapshot().filter((record) => record.categoryName === category.name).length} 条相关待办将转为「未分类」；待办本身不会被删除。`
          : `Deleting "${category.name}" moves ${store.snapshot().filter((record) => record.categoryName === category.name).length} to-do(s) to Uncategorized. The to-dos themselves are kept.`,
        confirmLabel: zh ? "确认删除" : "Confirm deletion",
        cancelLabel: zh ? "取消" : "Cancel",
        onConfirm: async () => {
          const index = this.plugin.settings.todoCategories.findIndex((entry) => entry.id === category.id);
          if (index >= 0) this.plugin.settings.todoCategories.splice(index, 1);
          try {
            await store.removeCategoryFromSource(category.name);
          } catch {
            if (index >= 0) this.plugin.settings.todoCategories.splice(index, 0, category);
          }
          await this.plugin.saveSettings();
          this.plugin.notifyHomeSurfacesChanged();
          this.scheduleDisplay();
        }
      });
    }
    const addRow = group.createDiv({ cls: "echoink-settings-compact-row" });
    const addCopy = addRow.createDiv({ cls: "echoink-settings-compact-copy" });
    addCopy.createDiv({ cls: "echoink-settings-compact-title", text: zh ? "新增分类" : "Add category" });
    addCopy.createDiv({
      cls: "echoink-settings-compact-description",
      text: zh ? "名称不能为空，也不能与已有分类同名。" : "Names cannot be empty or duplicate an existing category."
    });
    const addActions = addRow.createDiv({ cls: "echoink-settings-compact-actions" });
    const addButton = createOriginButton(addActions, {
      cls: "button",
      attr: { type: "button", "aria-label": zh ? "新增分类" : "Add category" }
    });
    setIcon(addButton.createSpan({ attr: { "aria-hidden": "true" } }), "plus");
    addButton.createSpan({ text: zh ? "新增" : "Add" });
    addButton.onclick = () => void (async () => {
      const name = await this.moduleTextInput(
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

  private renderModuleCheckbox(parent: HTMLElement, title: string, checked: boolean, hint: string, save: (value: boolean) => Promise<void>, pro = false, focusKey?: string): void {
    const row = applySettingsRow(new OriginSetting(parent).setName(title));
    if (hint) {
      const wrapper = row.nameEl.createSpan({ cls: "echoink-settings-help" });
      const help = createOriginButton(wrapper, { cls: "is-icon", attr: { "aria-label": `${title}说明` } }); setIcon(help, "circle-alert"); attachSettingsHelpTooltip(help, hint, wrapper);
    }
    const check = createOriginCheck(row.controlEl, { attr: { "aria-label": title } }); check.checked = checked;
    if (focusKey) check.dataset.echoinkFocusKey = focusKey;
    let pending = false;
    const access = this.plugin.accountService ?? unavailableCapabilityAccess;
    const controls = pro ? new ProPluginControls(access, () => getProPluginAccess(access, true)) : null;
    controls?.bind(check, { businessDisabled: () => pending });
    if (controls) this.membershipRowsDisposers.push(() => controls.dispose());
    check.onchange = () => {
      if (pending) return;
      const previous = !check.checked, next = check.checked;
      if (pro && !getProPluginAccess(access, true).canWrite) { check.checked = previous; return; }
      pending = true; check.disabled = true;
      void save(next).catch(error => { check.checked = previous; new Notice(error instanceof Error ? error.message : String(error)); })
        .finally(() => { pending = false; if (controls) controls.refresh(); else check.disabled = false; });
    };
  }

  private moduleTextInput(app: import("obsidian").App, title: string, label: string, initialValue = ""): Promise<string | null> {
    if (!Platform.isDesktopApp) return textInputModal(app, title, label, initialValue);
    return new Promise(resolve => {
      const editor = new Modal(app);
      editor.onOpen = () => {
        editor.titleEl.setText(title);
        const field = editor.contentEl.createEl("label", { text: label });
        const input = createOriginInput(field, { value: initialValue, attr: { "aria-label": label } });
        const actions = editor.contentEl.createDiv({ cls: "settings-inline" });
        createOriginButton(actions, { text: this.copy.common.cancel }).onclick = () => editor.close();
        const save = createOriginButton(actions, { cls: "mod-cta", text: this.plugin.settings.settingsLanguage === "en" ? "Save" : "保存" });
        save.onclick = () => { resolve(input.value); editor.close(); };
        input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); save.click(); } };
      };
      editor.onClose = () => resolve(null);
      this.openInlineEditor(editor, "modules");
    });
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
        && this.activeSettingsTab() === "general",
      () => { if (access.enabled) this.scheduleDisplay(); });
    this.developerPanel = panel;
    void panel.render();
  }

  private renderAboutSection(page: HTMLElement): void{
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const version = this.plugin.manifest.version ?? "unknown";
    const section = createSettingsSection(page, { title: zh ? "关于" : "About", surface: "flat" });
    this.membershipRowsDisposers.push(renderCompactAbout(section, {
      version, language: this.plugin.settings.settingsLanguage,
      websiteUrl: membershipWebsiteLink("plugin.about"),
      update: this.releaseUpdate,
      onLogoClick: altKey => { if (this.plugin.developerMode.click(altKey)) this.renderSettingsContent(); }
    }));
  }

  private async openKnowledgeDataPage(page: "overview" | "health" | "history"): Promise<void> {
    (this.app as unknown as { setting?: { close(): void } }).setting?.close();
    await this.plugin.activateKnowledgeView(page);
  }

  private renderKnowledgeMaintenanceHistory(page: HTMLElement, zh: boolean): void {
    if (Platform.isDesktopApp) {
      createSettingsNavigationRow(createSettingsGroup(createSettingsSection(page, { surface: "flat" })), {
        title: zh ? "维护记录" : "Maintenance records", value: zh ? "知识库数据页" : "Knowledge data",
        actionLabel: zh ? "查看" : "View", focusKey: "knowledge:maintenance-history",
        onActivate: () => void this.openKnowledgeDataPage("history")
      });
      return;
    }
    if (!this.knowledgeMaintenanceRecordsLoaded && !this.knowledgeMaintenanceRecordsLoading && !this.knowledgeMaintenanceRecordsError) void this.loadKnowledgeMaintenanceRecords();
    const section = createSettingsSection(page, {
      title: zh ? "维护记录" : "Maintenance records",
      surface: "flat"
    });
    section.addClass("standard-section");
    const group = createSettingsGroup(section);
    group.addClass("settings-card");
    const count = this.mergedKnowledgeMaintenanceHistory().length;
    createSettingsNavigationRow(group, {
      title: zh ? "维护记录" : "Maintenance records",
      description: zh
        ? "打开完整记录，按日期查看每次知识维护。"
        : "Open the complete history and view Knowledge maintenance by date.",
      value: this.knowledgeMaintenanceRecordsError ? (zh ? "读取失败" : "Read failed") : this.knowledgeMaintenanceRecordsLoading || !this.knowledgeMaintenanceRecordsLoaded ? (zh ? "正在读取" : "Loading") : zh
        ? `${count} 条记录`
        : `${count} ${count === 1 ? "record" : "records"}`,
      actionLabel: zh ? "查看" : "View",
      focusKey: "knowledge:maintenance-history",
      onActivate: () => this.openSettingsDetail("knowledge-maintenance-history")
    });
  }

  private renderKnowledgeMaintenanceHistoryDetail(container: HTMLElement, zh: boolean): void {
    this.knowledgeMaintenanceListCleanup?.();
    this.knowledgeMaintenanceListCleanup = null;
    if (this.knowledgeMaintenanceSelectedRecord) {
      this.knowledgeMaintenanceListCleanup = renderKnowledgeMaintenanceRecordDetail(container, {
        zh, record: this.knowledgeMaintenanceSelectedRecord,
        onBack: () => {
          this.knowledgeMaintenanceSelectedRecord = null;
          this.pendingKnowledgeHistoryScroll = this.knowledgeMaintenanceHistoryScroll;
          this.scheduleDisplay();
        },
        onOpenPath: (path) => this.openKnowledgeMaintenanceReport(path)
      });
      return;
    }
    const state = { date: this.knowledgeMaintenanceHistoryDate, page: this.knowledgeMaintenanceHistoryPage, listScroll: this.knowledgeMaintenanceListScroll };
    const syncState = () => {
      this.knowledgeMaintenanceHistoryDate = state.date;
      this.knowledgeMaintenanceHistoryPage = state.page;
      this.knowledgeMaintenanceListScroll = state.listScroll;
    };
    const cleanup = renderKnowledgeMaintenanceHistoryList(container, {
      zh, state, entries: this.mergedKnowledgeMaintenanceHistory(), records: this.knowledgeMaintenanceRecords,
      loading: this.knowledgeMaintenanceRecordsLoading || (!this.knowledgeMaintenanceRecordsLoaded && !this.knowledgeMaintenanceRecordsError),
      error: this.knowledgeMaintenanceRecordsError,
      onBack: () => { syncState(); void this.closeSettingsDetail(); },
      onChange: () => { syncState(); this.scheduleDisplay(); },
      onClearFocus: () => { this.settingsFocusIntent = "explicit:knowledge:maintenance-history:date"; },
      onOpenPath: (path) => this.openKnowledgeMaintenanceReport(path),
      onUnavailable: () => { new Notice(zh ? "维护记录尚未读取或已缺失" : "Maintenance record is unavailable"); },
      onSelectRecord: (record) => {
        syncState();
        this.knowledgeMaintenanceHistoryScroll = captureSettingsScrollSnapshot(this.containerEl);
        this.knowledgeMaintenanceSelectedRecord = record;
        this.scheduleDisplay();
      }
    });
    syncState();
    this.knowledgeMaintenanceListCleanup = () => { syncState(); cleanup(); };
  }

  private mergedKnowledgeMaintenanceHistory(): KnowledgeBaseMaintenanceHistoryEntry[] {
    return mergeKnowledgeMaintenanceHistory(this.plugin.settings.knowledgeBase.maintenanceHistory, this.knowledgeMaintenanceRecords);
  }

  private async loadKnowledgeMaintenanceRecords(): Promise<void> {
    if (this.knowledgeMaintenanceRecordsLoading) return;
    this.knowledgeMaintenanceRecordsLoading = true;
    this.knowledgeMaintenanceRecordsError = "";
    try {
      this.knowledgeMaintenanceRecords = await this.plugin.getKnowledgeSurfaceService()?.getMaintenanceRecords() ?? [];
      this.knowledgeMaintenanceRecordsLoaded = true;
    } catch (error) {
      this.knowledgeMaintenanceRecords = [];
      this.knowledgeMaintenanceRecordsError = String(error);
    } finally {
      this.knowledgeMaintenanceRecordsLoading = false;
      this.scheduleDisplay();
    }
  }

  private renderHistoryEmpty(container: HTMLElement, title: string, description: string): void {
    const empty = container.createDiv({ cls: "settings-empty history-empty" });
    setIcon(empty.createSpan({ cls: "history-empty-icon" }), "history");
    empty.createDiv({ cls: "settings-empty-title", text: title, attr: { role: "heading", "aria-level": "3" } });
    empty.createEl("p", { text: description });
  }

  private async openKnowledgeMaintenanceReport(relativePath: string): Promise<void> {
    await openKnowledgeMaintenancePath(this.app, relativePath, this.plugin.settings.settingsLanguage !== "en");
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void{
    this.renderDesktopModuleSettings(container);
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
      attachNativeTooltip(item, zh ? step.instruction : protocolEnglish[index][1]);
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

  private renderReviewSettings(container: HTMLElement, embedded = false): void {
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
    const page = embedded ? container : createSettingsPage(container, {
      title: copy.review.title,
      description: zh
        ? "生成本地周报，并管理从聊天列表移出的历史会话。"
        : "Generate local weekly summaries and manage conversations removed from chat."
    });
    page.addClass("codex-review-settings");
    this.renderSettingsActionError(page, "review");

    const generation = createSettingsSection(page, { surface: "flat" });
    const summary = embedded ? generation : createSettingsFeatureCard(
      generation,
      copy.review.generateHeading,
      zh
        ? "选择来源、统计周期和保存文件夹；生成结果只保留在所选目录。"
        : "Choose the source, date range, and destination folder. Generated files stay in that folder."
    );
    if (!embedded) {
    const actions = summary.createDiv({ cls: "review-generation" });
    this.addReviewAction(actions, copy.review.generateAgent, "agent-chat");
    this.addReviewAction(actions, copy.review.generateKnowledge, "knowledge-base");
    }
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
    this.addReviewRangeMode(controls, embedded);
    this.addReviewOpenAfterRun(controls, embedded);

    if (!Platform.isDesktopApp) this.renderReviewManagement(page);
  }

  private renderReviewManagement(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const management = createSettingsSection(page, {
      title: Platform.isDesktopApp ? (zh ? "会话" : "Conversations") : (zh ? "管理" : "Management"),
      surface: "group"
    });
    const managementGroup = createSettingsGroup(management);
    const autoArchive = applySettingsRow(new OriginSetting(managementGroup)
      .setName(zh ? "自动归档" : "Automatically archive")
      .setDesc(Platform.isDesktopApp
        ? (zh ? "多久没更新的对话自动归档" : "How long conversations stay inactive before archiving")
        : (zh ? "归档超过指定天数未更新的对话；跳过使用中或有待发送内容的对话，可在下方恢复。" : "Archive conversations with no updates for the selected period. Conversations in use or with pending drafts are skipped. Restore them below."))
      .addOriginDropdown(this.app, dropdown => {
        dropdown.selectEl.setAttr("aria-label", zh ? "自动归档" : "Automatically archive");
        dropdown.selectEl.setAttr("data-echoink-focus-key", "review:auto-archive");
        dropdown.addOption("0", zh ? "关闭" : "Off");
        for (const days of [7, 14, 30, 90]) dropdown.addOption(String(days), zh ? `${days} 天` : `${days} days`);
        dropdown.setValue(String(this.plugin.settings.autoArchiveDays));
        dropdown.onChange(async value => {
          const previous = this.plugin.settings.autoArchiveDays;
          this.plugin.settings.autoArchiveDays = normalizeAutoArchiveDays(Number(value));
          try { await this.plugin.saveSettings(true); }
          catch { this.plugin.settings.autoArchiveDays = previous; dropdown.setValue(String(previous)); new Notice(zh ? "自动归档设置未保存" : "Archive setting was not saved"); }
        });
      }));
    if (Platform.isDesktopApp) {
      const wrapper = autoArchive.nameEl.createSpan({ cls: "echoink-settings-help" });
      const help = createOriginButton(wrapper, { cls: "echoink-settings-help-trigger is-icon", attr: { "aria-label": zh ? "自动归档说明" : "Automatic archive information" } });
      setIcon(help, "circle-alert");
      attachSettingsHelpTooltip(help, zh ? "跳过使用中或有待发送内容的对话" : "Conversations in use or with pending drafts are skipped.", wrapper);
    }
    createSettingsNavigationRow(managementGroup, {
      title: zh ? "已归档会话" : "Archived conversations",
      description: Platform.isDesktopApp
        ? undefined
        : (zh ? "搜索、恢复或删除已归档会话；删除后无法在设置中恢复。" : "Search, restore, or delete archived conversations. Deleted conversations cannot be restored in Settings."),
      value: this.archivedConversations
        ? String(this.archivedConversations.length)
        : (zh ? "查看" : "View"),
      actionLabel: Platform.isDesktopApp ? undefined : (zh ? "打开" : "Open"),
      explanation: Platform.isDesktopApp ? (zh ? "删除后无法在设置中恢复" : "Deleted conversations cannot be restored in Settings.") : undefined,
      focusKey: "review:archives",
      onActivate: () => this.openSettingsDetail("review-archives")
    });
    if (!Platform.isDesktopApp) createSettingsNavigationRow(managementGroup, {
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
      picker.modalEl.addClass("echoink-theme-boundary");
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
      backLabel: Platform.isDesktopApp ? (zh ? "返回 Agent" : "Back to Agent") : (zh ? "返回复盘" : "Back to Review"),
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
      if (Platform.isDesktopApp) applyDeleteButton(remove);
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        deleteAction: Platform.isDesktopApp,
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
      description: undefined,
      detail: true,
      backLabel: Platform.isDesktopApp ? (zh ? "返回 Agent" : "Back to Agent") : (zh ? "返回复盘" : "Back to Review"),
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
        const back = () => { this.settingsDetail = "review-memory"; this.settingsFocusIntent = `explicit:review:memory:${category.id}`; this.scheduleDisplay(); };
        if (!this.leaveDesktopAgentDetail(back)) back();
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
    const records = [...this.currentPersonalMemoryRecords(category.id)];
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
          "data-echoink-focus-key": `review:memory:${category.id}:correct:${Platform.isDesktopApp ? record.id : recordIndex}`
        }
      });
      correct.disabled = this.memoryActionRunning;
      correct.onclick = () => {
        if (Platform.isDesktopApp) this.openDesktopMemoryCorrection(record, category.id);
        else void this.correctPersonalMemoryRecord(record);
      };
      correct.disabled = this.memoryActionRunning || !!this.desktopCorrection && this.desktopCorrection.id !== record.id;
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
      if (Platform.isDesktopApp) applyDeleteButton(forget);
      forget.onclick = () => showSettingsInlineConfirmation(row, forget, {
        deleteAction: Platform.isDesktopApp,
        message: zh ? `忘掉“${record.title}”后，它不会再被召回；相关用户画像与关联记忆会同步更新。` : `After “${record.title}” is forgotten, it will no longer be recalled. Related user-profile and memory projections will be updated too.`,
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

  private renderDesktopMemoryCorrection(container: HTMLElement): void {
    const editing = this.desktopCorrection;
    if (!editing) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const category = personalMemoryCorrectionCategory(editing.category);
    editing.controller.mountSettingsPage(container, {
      backLabel: zh ? category.labelZh : category.labelEn,
      unavailable: editing.invalidated ? (zh ? "这条记忆已失效，无法保存修正；你的文字已保留。" : "This memory is no longer current. Your correction cannot be saved; your text is retained.") : undefined,
      onNavigate: () => {
        this.settingsFocusIntent = `explicit:memory-correction:${editing.controller.settingsPageStep === "preview" ? "save" : "input"}`;
        this.scheduleDisplay();
      }
    });
  }

  private openDesktopMemoryCorrection(record: Readonly<PersonalMemoryRecord>, categoryId: PersonalMemoryCorrectionCategory = "facts"): void {
    if (this.desktopCorrection || this.memoryActionRunning || !this.personalMemoryState) return;
    const zh = this.plugin.settings.settingsLanguage !== "en";
    let expectedRevision = this.personalMemoryState.revision;
    let targetId = record.id;
    const originalIndex = this.currentPersonalMemoryRecords(categoryId).findIndex(item => item.id === record.id);
    const latestRecord = (state: PersonalMemoryControlState) => {
      let candidate = state.records.find(item => item.id === record.id);
      const seen = new Set<string>();
      while (candidate && candidate.status !== "current" && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        candidate = state.records.find(item => item.supersedes === candidate!.id);
      }
      return candidate?.status === "current" ? candidate : undefined;
    };
    const refreshTarget = async () => {
      const state = await this.plugin.getEchoInkPersonalMemoryState();
      this.personalMemoryState = state;
      const latest = latestRecord(state);
      if (this.desktopCorrection) {
        this.desktopCorrection.invalidated = !latest;
        if (latest) {
          this.desktopCorrection.id = latest.id;
          this.desktopCorrection.controller.updateSettingsRecord({ memoryType: personalMemoryKindLabel(latest.kind, zh), title: latest.title, content: latest.content, recallWhen: latest.recallWhen });
        }
      }
      this.scheduleDisplay();
      return { state, latest };
    };
    const controller = new MemoryCorrectionModal(this.app, {
      memoryType: personalMemoryKindLabel(record.kind, zh), title: record.title,
      content: record.content, recallWhen: record.recallWhen
    }, this.plugin.settings.settingsLanguage, {
      generate: async (correction, signal) => {
        const { state, latest } = await refreshTarget();
        if (!latest) throw new Error(zh ? "这条记忆已失效，无法保存修正；你的文字已保留。" : "This memory is no longer current. Your text has been retained.");
        expectedRevision = state.revision; targetId = latest.id;
        return this.plugin.generateEchoInkPersonalMemoryCorrection({ kind: latest.kind, title: latest.title, content: latest.content, recallWhen: latest.recallWhen }, correction, signal);
      },
      save: async (preview, correction) => {
        try {
          await this.plugin.applyEchoInkPersonalMemoryCorrection({ targetId, title: preview.title, content: preview.content, recallWhen: preview.recallWhen,
            reason: `${zh ? "用户明确修正" : "User correction"}：${correction}`.slice(0, 1900), expectedRevision });
        } catch (error) {
          if (isPersonalMemoryRevisionConflict(error)) await refreshTarget().catch(() => undefined);
          throw error;
        }
        try { this.personalMemoryState = await this.plugin.getEchoInkPersonalMemoryState(); }
        catch { this.personalMemoryState = null; this.personalMemoryError = zh ? "已保存，暂时读不到新内容" : "Saved; new content is temporarily unavailable"; }
      }
    }, result => {
      if (this.desktopCorrection?.controller === controller) {
        this.desktopCorrection = null;
        this.settingsDetail = { kind: "review-memory-category", category: categoryId };
        const records = this.currentPersonalMemoryRecords(categoryId);
        const latest = this.personalMemoryState ? latestRecord(this.personalMemoryState) : undefined;
        const target = records.find(item => item.id === latest?.id) ?? records[Math.max(0, Math.min(originalIndex, records.length - 1))];
        this.settingsFocusIntent = target ? `explicit:review:memory:${categoryId}:correct:${target.id}` : "explicit:settings-detail:back";
      }
      if (result === "saved") new Notice(zh ? "记忆已保存为新版本" : "Memory saved as a new version");
      this.scheduleDisplay();
    });
    this.desktopCorrection = { id: record.id, category: categoryId, invalidated: false, controller };
    this.settingsFocusIntent = "explicit:memory-correction:input";
    this.scheduleDisplay();
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

  private addReviewRangeMode(container: HTMLElement, embedded = false): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    const setting = new OriginSetting(container).setName(copy.review.rangeMode).addOriginDropdown(this.app, (dropdown) => {
      dropdown.selectEl.setAttr("aria-label", copy.review.rangeMode);
      dropdown
        .addOption("previous-week", copy.review.rangeOptions["previous-week"])
        .addOption("current-week", copy.review.rangeOptions["current-week"])
        .setValue(settings.rangeMode)
        .onChange(async (value) => {
          const previous = settings.rangeMode;
          settings.rangeMode = value === "current-week" ? "current-week" : "previous-week";
          if (!embedded) await this.plugin.saveSettings();
          else try { await this.plugin.saveSettings(); } catch (error) { settings.rangeMode = previous; dropdown.setValue(previous); new Notice(error instanceof Error ? error.message : String(error)); }
        });
    });
    if (!embedded) this.decorateSetting(setting, "calendar-days");
  }

  private addReviewOpenAfterRun(container: HTMLElement, embedded = false): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    if (embedded) {
      this.renderModuleCheckbox(container, copy.review.openHtmlAfterRun, settings.openHtmlAfterRun, "", async value => {
        const previous = settings.openHtmlAfterRun; settings.openHtmlAfterRun = value;
        try { await this.plugin.saveSettings(); } catch (error) { settings.openHtmlAfterRun = previous; throw error; }
      }); return;
    }
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
    const flatNavigation = Boolean(tabs.closest(".echoink-settings-aligned"));
    const reducedMotion = Boolean(
      container.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    const justSwitched = this.lastRenderedSettingsTab !== null
      && this.lastRenderedSettingsTab !== activeTab;
    if (justSwitched) {
      // Bookmark rise finishes first (transitionend below), then the icon's own
      // animation starts. Reduced motion skips straight to the final state.
      this.settingsTabIconAnimation = reducedMotion || flatNavigation
        ? { tabId: activeTab, startedAtMs: now }
        : null;
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
    const settingsTabs = this.settingsTabs();
    settingsTabs.forEach((tab, index) => {
      const nativeRow = navigation?.rows.get(tab.id);
      if (navigation && !nativeRow) return;
      const label = this.settingsTabLabel(tab.id);
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
      button.setAttr("data-tab-name", label);
      // Native Obsidian tooltip: independent floating layer, not clipped by
      // the nav strip's overflow (a ::after pseudo-element was clipped flat).
      setTooltip(button, label, { placement: "top" });
      const icon = button.querySelector<HTMLElement>(".codex-settings-tab-icon")
        ?? button.createSpan({ cls: "codex-settings-tab-icon settings-motion-icon" });
      renderAnimatedSettingsTabIcon(
        icon,
        tab.icon,
        isActive ? activeAnimationProgress : null
      );
      if (isActive && justSwitched && !reducedMotion && !flatNavigation) {
        // Sequential handoff: play the icon's own animation only after the
        // bookmark rise transition completes; stale switches self-cancel.
        // NOTE: no `{ once: true }` — earlier background/color transitionend
        // events would consume a once-listener before transform ends.
        const onRiseEnd = (event: TransitionEvent): void => {
          if (event.target !== button || event.propertyName !== "transform") return;
          button.removeEventListener("transitionend", onRiseEnd);
          if (this.lastRenderedSettingsTab !== tab.id) return;
          this.settingsTabIconAnimation = { tabId: tab.id, startedAtMs: Date.now() };
          renderAnimatedSettingsTabIcon(icon, tab.icon, 0);
        };
        button.addEventListener("transitionend", onRiseEnd);
      }
      const labelEl = nativeRow?.setting.nameEl
        ?? button.createSpan({ cls: "codex-settings-tab-label" });
      labelEl.addClass("codex-settings-tab-label");
      if (labelEl.parentElement !== button) button.appendChild(labelEl);
      labelEl.empty();
      labelEl.createSpan().setText(label);
      if (isActive) {
        activeButton = button;
      }
      button.onpointerdown = () => {
        this.settingsTabPointerActivated = true;
      };
      button.onclick = () => {
        const restoreKeyboardFocus = !this.settingsTabPointerActivated;
        this.settingsTabPointerActivated = false;
        if (Platform.isDesktopApp && navigation) {
          const query = (this.app as unknown as { setting?: { searchComponent?: { inputEl?: HTMLInputElement } } }).setting?.searchComponent?.inputEl?.value ?? "";
          const searchRoute = resolveDesktopSettingsSearchRoute(tab.id as DesktopSettingsTab, query);
          if (searchRoute) { this.openDesktopRoute(searchRoute); this.settingsTabFocusId = restoreKeyboardFocus ? searchRoute.tab : null; return; }
        }
        if (activeTab === tab.id) return;
        void this.activateSettingsTab(tab.id, restoreKeyboardFocus);
      };
      button.onkeydown = (event) => {
        const nextIndex = tabIndexFromKeyboard(event.key, index, settingsTabs.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateSettingsTab(settingsTabs[nextIndex].id, true);
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
    if (this.activeSettingsTab() === tabId && !this.desktopRoute?.section && !this.settingsDetail && !this.desktopKnowledge?.isDetail && !this.desktopAgents?.isDetail && !this.desktopProfileOpen) return;
    if (this.leaveDesktopAccount(() => { void this.activateSettingsTab(tabId, focus); })) return;
    if (this.leaveDesktopAgentDetail(() => { void this.activateSettingsTab(tabId, focus); })) return;
    if (Platform.isDesktopApp && this.desktopSelection?.controller?.hasUnsavedChanges()) {
      this.desktopSelection.controller.requestBack(() => { this.clearDesktopSelection(); void this.activateSettingsTab(tabId, focus); }); return;
    }
    if (this.leaveKnowledgePreference(() => { void this.activateSettingsTab(tabId, focus); })) return;
    if (Platform.isDesktopApp && this.desktopKnowledge?.isDetail) {
      this.desktopKnowledge.requestLeave(() => { void this.activateSettingsTab(tabId, focus); }); return;
    }
    this.clearDesktopSelection();
    this.settingsDetail = null;
    this.announceSettingsStatus("");
    this.settingsTabFocusId = focus ? tabId : null;
    this.suppressSettingsTabFocusRestore = !focus;
    this.suspendActiveEditor();
    if (Platform.isDesktopApp) {
      if (this.desktopRoute) this.desktopRouteHistory.set(this.desktopRoute.tab, this.desktopRoute);
      const route = DESKTOP_SETTINGS_TABS.includes(tabId as DesktopSettingsTab)
        ? this.desktopRouteHistory.get(tabId as DesktopSettingsTab) ?? resolveDesktopSettingsRoute(tabId, { resourceTab: this.plugin.settings.resourceManagementTab })
        : resolveDesktopSettingsRoute(tabId, { resourceTab: this.plugin.settings.resourceManagementTab });
      this.desktopRoute = route;
      this.settingsTabFocusId = focus ? route.tab : null;
      if (route.capabilityTab && route.capabilityTab !== "tools") this.plugin.settings.resourceManagementTab = route.capabilityTab;
      if (route.tab === "modules") this.plugin.settings.resourceManagementTab = "plugins";
      if (route.tab === "capabilities" && this.plugin.settings.resourceManagementTab === "plugins") this.plugin.settings.resourceManagementTab = "skills";
    } else {
      this.plugin.settings.settingsTab = tabId as SettingsTab;
      await this.plugin.saveSettings();
    }
    this.scheduleDisplay();
  }

  private leaveKnowledgePreference(done: () => void): boolean {
    if (this.settingsDetail !== "knowledge-preferences" || !knowledgeMaintenancePreferenceIsDirty(this.knowledgePreferenceEditor)) return false;
    void this.confirmKnowledgePreferenceDiscard().then(discard => {
      if (discard) { this.resetKnowledgePreferenceDraft(); done(); }
      else { this.settingsFocusIntent = "explicit:knowledge:preferences:editor"; this.scheduleDisplay(); }
    });
    return true;
  }

  private openSettingsDetail(detail: Exclude<SettingsDetail, null>): void {
    if (Platform.isDesktopApp && typeof detail === "object" && detail.kind === "resource") {
      if (detail.resourceId === "echoink:english-diary") detail = "english-diary";
      else if (detail.resourceId === "echoink:selection-ask") detail = "selection-ask";
    }
    if (Platform.isDesktopApp && detail === "knowledge-maintenance-history") {
      void this.openKnowledgeDataPage("history");
      return;
    }
    if (Platform.isDesktopApp && (detail === "knowledge-preferences" || detail === "knowledge-linking")) this.ensureDesktopKnowledge().open("permissions");
    if (Platform.isDesktopApp && (detail === "generation-templates" || detail === "generation-template")) this.desktopModuleExpanded.add("knowledge");
    this.settingsDetail = detail;
    this.settingsFocusIntent = "explicit:settings-detail:back";
    if (typeof detail === "object" && detail.kind === "resource") {
      const resource = this.currentEchoInkResourceCatalog().find(
        (candidate) => candidate.id === detail.resourceId
      );
      const skillId = resource && !isOfficialRemoteSkill(resource) ? builtinSkillIdForResource(resource) : null;
      if (skillId) this.loadBuiltinSkillEditor(detail.resourceId, skillId);
      else this.clearBuiltinSkillEditor();
    } else {
      this.clearBuiltinSkillEditor();
    }
    if (detail === "knowledge-maintenance-history") {
      this.knowledgeMaintenanceHistoryDate = "";
      this.knowledgeMaintenanceHistoryPage = 1;
      this.knowledgeMaintenanceListScroll = 0;
      this.knowledgeMaintenanceSelectedRecord = null;
      void this.loadKnowledgeMaintenanceRecords();
    }
    if (detail === "knowledge-preferences") {
      void this.loadKnowledgePreferenceState();
    }
    if (detail === "review-archives") {
      void this.loadArchivedConversations(true);
    }
    if (detail === "review-memory") {
      void this.loadPersonalMemoryState(true);
    }
    this.scheduleDisplay();
  }

  private async closeSettingsDetail(): Promise<void> {
    const detail = this.settingsDetail;
    if (this.leaveDesktopAgentDetail(() => { void this.closeSettingsDetail(); })) return;
    if (Platform.isDesktopApp && this.desktopSelection?.controller?.hasUnsavedChanges()) {
      this.desktopSelection.controller.requestBack(() => { this.clearDesktopSelection(); void this.closeSettingsDetail(); }); return;
    }
    this.clearDesktopSelection();
    if (detail === "journal-templates") { this.desktopTemplate?.dispose(); this.desktopTemplate = null; }
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
    if (Platform.isDesktopApp && (detail === "knowledge-preferences" || detail === "knowledge-linking")) this.ensureDesktopKnowledge().open("permissions");
    this.settingsDetail = null;
    this.lifestyleSettingsPanel?.dispose();
    this.lifestyleSettingsPanel = null;
    this.clearBuiltinSkillEditor();
    if (typeof detail === "object" && detail?.kind === "resource") {
      this.settingsFocusIntent = `explicit:resource:${detail.resourceId}:detail`;
    } else if (
      typeof detail === "object"
      && detail?.kind === "review-memory-category"
    ) {
      this.settingsFocusIntent = `explicit:review:memory:${detail.category}`;
    } else if (detail === "selection-ask") {
      this.desktopModuleExpanded.add("selection");
      this.settingsFocusIntent = "explicit:selection-ask:settings";
    } else if (detail === "generation-template") {
      this.settingsDetail = "generation-templates";
      this.settingsFocusIntent = `explicit:${this.ensureGenerationTemplates().editorFocusKey()}`;
    } else if (detail === "generation-templates") {
      this.desktopModuleExpanded.add("knowledge"); this.settingsFocusIntent = "explicit:knowledge:generation-templates";
    } else if (detail === "pdf-reading") {
      this.settingsFocusIntent = "explicit:module:pdf";
    } else if (detail === "journal-templates") {
      this.desktopModuleExpanded.add("journal"); this.settingsFocusIntent = "explicit:journal:templates";
    } else if (detail === "todo-categories") {
      this.desktopModuleExpanded.add("todo"); this.settingsFocusIntent = "explicit:todo:categories";
    } else if (detail === "english-diary") {
      this.settingsFocusIntent = "explicit:english-diary:settings";
    } else if (detail === "knowledge-folders") {
      this.settingsFocusIntent = "explicit:knowledge:onboarding";
    } else if (detail === "knowledge-preferences") {
      this.settingsFocusIntent = "explicit:knowledge:preferences";
    } else if (detail === "knowledge-linking") {
      this.settingsFocusIntent = "explicit:knowledge:linking";
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

  private renderDefaultModelSelector(page: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const copy = this.copy;
    const runSection = createSettingsSection(page, {
      title: Platform.isDesktopApp ? (zh ? "默认模型" : "Default model") : (zh ? "模型" : "Model"),
      surface: "flat"
    });
    runSection.addClass("standard-section");
    const runGroup = createSettingsGroup(runSection);
    if (!Platform.isDesktopApp) runGroup.addClass("settings-card");
    const availableTargets = this.plugin.settings.apiProviders.flatMap(
      (provider) => apiProviderHasUsableCredential(
        provider,
        this.plugin.settings.openAICodexCredential
      )
        ? provider.models.map((model) => ({ provider, model }))
        : []
    );
    const modelSetting = applySettingsRow(new OriginSetting(runGroup)
      .setName(Platform.isDesktopApp ? (zh ? "EchoInk 默认模型" : "EchoInk default model") : (zh ? "EchoInk 当前模型" : "Current EchoInk model"))
      .setDesc(Platform.isDesktopApp ? "" : zh
        ? "普通聊天、/ask、/maintain 与选区翻译共用这个模型。"
        : "Chat, /ask, /maintain, and selection translation share this model.")
      .addOriginDropdown(this.app, (dropdown) => {
        dropdown.selectEl.setAttr("aria-label", Platform.isDesktopApp ? (zh ? "EchoInk 默认模型" : "EchoInk default model") : (zh ? "EchoInk 当前模型" : "Current EchoInk model"));
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
          const providerId = normalizeApiProviderId(provider.providerId, provider.baseUrl, provider.name);
          const providerDisplayName = apiProviderConfiguredDisplayName(
            providerId,
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
              )}`,
              (container) => { renderProviderBrandIcon(container, getApiProviderPreset(providerId).id); },
              Platform.isDesktopApp ? providerDisplayName : undefined
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
      );
    modelSetting.settingEl.dataset.echoinkFocusKey = "models:default";
    if (!Platform.isDesktopApp) {
      const manage = createOriginButton(modelSetting.controlEl, { text: zh ? "管理模型" : "Manage models" });
      manage.onclick = () => void this.activateSettingsTab("providers", true);
    }

  }

  private providerSubTab: "models" | "tools" = "models";

  private renderProviderModelManager(container: HTMLElement): void {
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const label = (chinese: string, english: string) => zh ? chinese : english;
    if (Platform.isDesktopApp && this.providerPickerOpen) {
      const page = createSettingsPage(container, { title: label("添加模型服务", "Add model service"), detail: true,
        backLabel: label("返回模型", "Back to models"), onBack: () => { this.providerPickerOpen = false; this.settingsFocusIntent = "explicit:providers:add"; this.scheduleDisplay(); } });
      renderProviderServicePicker(page, { language: this.plugin.settings.settingsLanguage,
        addedProviderIds: this.plugin.settings.apiProviders.map(provider => normalizeApiProviderId(provider.providerId, provider.baseUrl, provider.name)),
        onSelect: preset => this.openProviderModelModal(createApiProviderConfig(preset.id), false) });
      for (const card of Array.from(page.querySelectorAll<HTMLElement>("[data-provider-service]"))) card.setAttr("data-echoink-focus-key", `provider-service:${card.dataset.providerService}`);
      return;
    }
    const page = createSettingsPage(container, {
      title: Platform.isDesktopApp ? label("模型", "Models") : label("模型与提供商", "Models and providers"),
      titleVisibility: Platform.isDesktopApp ? "screen-reader" : "visible"
    });
    page.addClass("codex-provider-model-manager");
    this.renderSettingsActionError(page, "providers");
    if (Platform.isDesktopApp) this.renderDefaultModelSelector(page);
    const wrapper = Platform.isDesktopApp ? page : renderProviderTabs(page, this.providerSubTab, !zh, (tab, focus) => {
      this.providerSubTab = tab;
      disposeOriginControls(container); container.empty(); this.renderProviderModelManager(container);
      const active = container.querySelector<HTMLElement>(`#echoink-provider-tab-${tab}`);
      if (focus) active?.focus();
      active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    if (!Platform.isDesktopApp && this.providerSubTab === "tools") { renderTavilySettings(wrapper, this.plugin); return; }

    const savedSection = wrapper.createDiv({ cls: "codex-provider-saved-section settings-card provider-list-card" });
    const addSection = savedSection.createDiv({
      cls: "codex-provider-add-section"
    });
    const addCopy = addSection.createDiv({ cls: "codex-provider-add-copy" });
    addCopy.createDiv({
      cls: "codex-provider-add-title",
      text: Platform.isDesktopApp ? label("模型服务", "Model services") : label("已保存模型", "Saved models")
    });
    const addButton = createOriginButton(addSection, {
      cls: "codex-provider-add-button",
      attr: { type: "button", "data-echoink-focus-key": "providers:add" }
    });
    applyAmicroButton(addButton, { variant: Platform.isDesktopApp ? "tertiary" : "primary", icon: "plus" });
    if (Platform.isDesktopApp) { addButton.setAttr("aria-label", label("添加模型服务", "Add model service")); addButton.addClass("icon-button"); }
    else addButton.createSpan({ text: label("添加模型", "Add model") });
    addButton.onclick = () => {
      if (Platform.isDesktopApp) { this.providerPickerOpen = true; this.scheduleDisplay(); }
      else this.openProviderModelModal(createApiProviderConfig(), false);
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
      if (Platform.isDesktopApp) {
        const verified = this.verifiedProviderConnections.get(saved.id) === providerConfigurationFingerprint(saved);
        const signedIn = saved.authMode === "oauth" && apiProviderHasUsableCredential(saved, this.plugin.settings.openAICodexCredential);
        const status = verified ? "connected" : signedIn ? "signed-in" : "unverified";
        const statusLabel = verified ? label("连接正常", "Connection verified")
          : signedIn ? label("已登录", "Signed in") : label("未验证", "Not verified");
        const modelCount = label(`${saved.models.length} 个模型`, `${saved.models.length} models`);
        const row = createOriginButton(savedList, {
          cls: `codex-provider-saved-row codex-provider-service-row is-provider-${providerId}`,
          attr: { type: "button", "data-echoink-focus-key": `provider:${saved.id}:edit`, "aria-label": `${providerDisplayName} · ${modelCount} · ${statusLabel}` }
        });
        const identity = row.createSpan({ cls: "codex-provider-saved-identity" });
        renderProviderBrandIcon(identity.createSpan({ cls: `codex-provider-saved-icon is-${providerId}`, attr: { "aria-hidden": "true" } }), providerId);
        const copy = identity.createSpan({ cls: "codex-provider-saved-copy" });
        copy.createSpan({ cls: "codex-provider-saved-model" }).createEl("strong", { text: providerDisplayName });
        copy.createSpan({ cls: "codex-provider-saved-details", text: modelCount });
        const connection = row.createSpan({ cls: `codex-provider-connection-badge is-${status}` });
        setIcon(connection.createSpan({ attr: { "aria-hidden": "true" } }), verified || signedIn ? "check-circle-2" : "circle-help");
        connection.createSpan({ text: statusLabel });
        setIcon(row.createSpan({ cls: "codex-provider-saved-arrow", attr: { "aria-hidden": "true" } }), "chevron-right");
        row.onclick = () => this.openProviderModelModal(saved, true);
        continue;
      }
      const defaultModel = getDefaultApiProviderModel(saved);
      const modelDisplayName = defaultModel
        ? defaultModel.displayName
        : label("未设置模型", "No model set");
      const row = savedList.createDiv({
        cls: `codex-provider-saved-row is-provider-${providerId}${saved.id === active?.id ? " is-current" : ""}`
      });
      const identity = Platform.isDesktopApp ? createOriginButton(row, {
        cls: "codex-provider-saved-identity text-button",
        attr: { type: "button", "data-echoink-focus-key": `provider:${saved.id}:open`, "aria-label": `${providerDisplayName} · ${modelDisplayName}` }
      }) : row.createDiv({ cls: "codex-provider-saved-identity", attr: { "aria-label": `${modelDisplayName} · ${providerDisplayName}` } });
      if (Platform.isDesktopApp) identity.onclick = () => this.openProviderModelModal(saved, true);
      const rowIcon = identity.createSpan({
        cls: `codex-provider-saved-icon is-${providerId}`
      });
      renderProviderBrandIcon(rowIcon, providerId);
      const savedCopy = identity.createDiv({
        cls: "codex-provider-saved-copy"
      });
      const modelHeading = savedCopy.createDiv({ cls: "codex-provider-saved-model" });
      modelHeading.createEl("strong", { text: Platform.isDesktopApp ? providerDisplayName : modelDisplayName });
      if (Platform.isDesktopApp ? saved.models.length > 0 : saved.models.length > 1) {
        modelHeading.createSpan({ cls: "codex-provider-model-count", text: Platform.isDesktopApp ? label(`${saved.models.length} 个模型`, `${saved.models.length} models`) : `+ ${saved.models.length - 1}` });
      }
      if (saved.id === active?.id) {
        modelHeading.createSpan({ cls: "codex-provider-active-badge", text: label("当前选择", "Current selection") });
      }
      const metadata = savedCopy.createEl("p", { cls: "codex-provider-saved-details" });
      const savedProvider = metadata.createSpan({
        cls: "codex-provider-saved-provider",
        text: Platform.isDesktopApp ? modelDisplayName : providerDisplayName,
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
        attachNativeTooltip(savedProvider, saved.baseUrl, { touch: "notice" });
      }

      if (Platform.isDesktopApp) setIcon(identity.createSpan({ cls: "codex-provider-saved-arrow", attr: { "aria-hidden": "true" } }), "chevron-right");
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
          ? label("已登录", "Signed in")
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
          "aria-label": label(`删除 ${providerDisplayName} · ${modelDisplayName}`, `Delete ${providerDisplayName} · ${modelDisplayName}`),
          "data-echoink-focus-key": `provider:${saved.id}:delete`
        }
      });
      if (Platform.isDesktopApp) applyDeleteButton(remove, { iconOnly: true }); else setIcon(remove, "trash-2");
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        deleteAction: Platform.isDesktopApp,
        message: `${this.copy.providers.deleteConfirm(providerDisplayName)} ${saved.id === active?.id
          ? label("将删除当前使用中的模型。EchoInk 会切换到下一项；若没有其他项，则进入未配置状态。", "The active model will be removed. EchoInk will switch to the next saved model, or become unconfigured if none remains.")
          : label("这会删除已保存的模型配置。", "This removes the saved model configuration.")}`,
        confirmLabel: label("确认删除", "Confirm deletion"), cancelLabel: this.copy.common.cancel,
        onConfirm: async () => { await this.deleteSavedProviderModel(saved.id); }
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
        text: (Platform.isDesktopApp ? label("还没有模型服务", "No model services yet") : label("还没有已保存模型", "No saved models yet"))
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

  private suspendActiveEditor(resumeOnReturn = true): void {
    if (!this.inlineEditor) return;
    if (resumeOnReturn) this.suspendedTabEditors.set(this.inlineEditor.tab, this.inlineEditor.key);
    this.inlineEditor.dispose.suspend();
    this.inlineEditor = null;
  }

  private openInlineEditor(editor: Modal, tab: VisibleSettingsTab, onBack?: () => void, key = "editor"): void {
    if (Platform.isDesktopApp) tab = this.activeSettingsTab();
    if (key === "editor") key = newId("settings-editor");
    const retainsDraft = key.startsWith("provider:") || key.startsWith("mcp:");
    this.suspendActiveEditor(false);
    const cached = this.editorDrafts.get(key);
    if (cached && !cached.dispose.disposed) {
      this.inlineEditor = cached;
      this.renderSettingsContent();
      return;
    }
    const host = ownedDiv(this.containerEl.ownerDocument);
    host.toggleClass("echoink-settings-aligned", Platform.isDesktopApp);
    const modelEditor = tab === "providers" || tab === "models";
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const backLabel = modelEditor ? (zh ? "返回模型" : "Back to models") : (zh ? "返回设置" : "Back to settings");
    const dispose = mountSettingsEditor(editor, host, backLabel, () => {
      this.editorDrafts.delete(key);
      if (this.suspendedTabEditors.get(tab) === key) this.suspendedTabEditors.delete(tab);
      if (!this.settingsVisible || this.inlineEditor?.host !== host) return;
      this.inlineEditor = null;
      if (modelEditor) this.providerPickerOpen = false;
      if (retainsDraft) this.settingsFocusIntent = key.startsWith("provider:edit:") ? `explicit:provider:${key.slice("provider:edit:".length)}:edit` : modelEditor ? "explicit:providers:add" : "explicit:resources:mcp:add";
      this.renderSettingsContent();
      onBack?.();
    }, Platform.isDesktopApp && retainsDraft ? { onNavigateBack: () => {
      if (this.inlineEditor?.host !== host) return;
      this.inlineEditor = null;
      this.suspendedTabEditors.delete(tab);
      this.providerPickerOpen = key.startsWith("provider:new:");
      this.settingsFocusIntent = key.startsWith("provider:new:") ? `explicit:provider-service:${key.slice("provider:new:".length)}` : key.startsWith("provider:edit:") ? `explicit:provider:${key.slice("provider:edit:".length)}:edit` : modelEditor ? "explicit:providers:add" : "explicit:resources:mcp:add";
      this.renderSettingsContent();
      onBack?.();
    } } : {});
    this.inlineEditor = { tab, host, dispose, key };
    this.editorDrafts.set(key, this.inlineEditor);
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
      remove: Platform.isDesktopApp && editing ? {
        message: `${this.copy.providers.deleteConfirm(apiProviderConfiguredDisplayName(normalizeApiProviderId(source.providerId, source.baseUrl, source.name), source.name, this.plugin.settings.settingsLanguage))} ${source.id === this.plugin.settings.activeApiProviderId
          ? (this.plugin.settings.settingsLanguage === "en" ? "The active model will be removed. EchoInk will switch to the next saved model, or become unconfigured if none remains." : "将删除当前使用中的模型。EchoInk 会切换到下一项；若没有其他项，则进入未配置状态。")
          : (this.plugin.settings.settingsLanguage === "en" ? "This removes the saved model configuration." : "这会删除已保存的模型配置。")}`,
        action: () => this.deleteSavedProviderModel(source.id)
      } : undefined,
      save: async (draft, apiKey, connectionVerified) =>
        await this.saveAndActivateProviderModel(
          draft,
          apiKey,
          connectionVerified,
          editing ? source : null
        )
    });
    this.openInlineEditor(editor, Platform.isDesktopApp ? "models" : "providers", undefined, editing ? `provider:edit:${source.id}` : `provider:new:${source.providerId}`);
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

  private async deleteSavedProviderModel(providerId: string): Promise<boolean> {
    const provider = this.plugin.settings.apiProviders.find(
      (item) => item.id === providerId
    );
    if (!provider) return false;
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
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : this.copy.providers.saveFailed);
      return false;
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
    if (Platform.isDesktopApp && this.settingsBodyEl) return new Promise(resolve => {
      const host = this.settingsBodyEl!;
      const trigger = host.querySelector<HTMLButtonElement>(".settings-back") ?? createOriginButton(host, { text: zh ? "返回" : "Back" });
      showSettingsInlineConfirmation(host, trigger, { message: zh ? "还有未保存的知识提炼偏好。" : "Refinement preferences have not been saved.", confirmLabel: zh ? "舍弃修改" : "Discard changes", cancelLabel: zh ? "继续编辑" : "Keep editing", onConfirm: async () => { resolve(true); } });
      host.querySelector<HTMLButtonElement>(".echoink-settings-inline-confirm button")?.addEventListener("click", () => resolve(false), { once: true });
    });
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
    if (this.settingsDetail === "pdf-reading") {
      this.pdfSettingsPanel ??= new PdfReadingSettingsPanel(this.plugin, () => void this.closeSettingsDetail());
      this.pdfSettingsPanel.render(container);
      return;
    }
    if (this.settingsDetail === "selection-ask") {
      renderSelectionAnnotationSettings(container, this.plugin, () => { void this.closeSettingsDetail(); }); return;
    }
    if (this.settingsDetail === "english-diary") {
      this.renderEnglishDiarySettings(container);
      return;
    }
    if (typeof this.settingsDetail === "object" && this.settingsDetail?.kind === "lifestyle") {
      if (!this.lifestyleSettingsPanel) this.lifestyleSettingsPanel = new LifestyleSettingsPanel(this.plugin, this.settingsDetail.lifeKind, () => void this.closeSettingsDetail(), () => this.scheduleDisplay());
      this.lifestyleSettingsPanel.render(container);
      return;
    }
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
    const desktopModules = Platform.isDesktopApp && this.activeSettingsTab() === "modules";
    const page = createSettingsPage(container, {
      title: Platform.isDesktopApp ? this.settingsTabLabel(desktopModules ? "modules" : "capabilities") : copy.resources.title,
      headingId: RESOURCE_TITLE_ID,
      titleVisibility: Platform.isDesktopApp ? "screen-reader" : "visible",
      description: Platform.isDesktopApp ? undefined : copy.resources.note
    });
    if (desktopModules) {
      const group = createSettingsGroup(createSettingsSection(page, { surface: "group" }));
      const zh = this.plugin.settings.settingsLanguage !== "en";
      for (const [section, title] of [["knowledgeBase", zh ? "知识库" : "Knowledge base"], ["todos", zh ? "待办" : "To-dos"], ["review", zh ? "复盘" : "Review"], ["journal", zh ? "日记" : "Journal"]] as const) {
        createSettingsNavigationRow(group, { title, focusKey: `modules:${section}`, onActivate: () => { this.desktopRoute = { tab: "modules", section }; this.settingsDetail = null; this.scheduleDisplay(); } });
      }
    }
    page.addClass("echoink-resources-page");
    this.renderSettingsActionError(page, "resources");
    const wrapper = page.createDiv({ cls: "codex-resource-manager" });
    const activeTab: ResourceNavigationTab = Platform.isDesktopApp && !desktopModules ? this.desktopRoute?.capabilityTab ?? (this.plugin.settings.resourceManagementTab === "plugins" ? "skills" : this.plugin.settings.resourceManagementTab) : this.plugin.settings.resourceManagementTab;
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
    const resourceTabs: Array<{ id: ResourceNavigationTab }> = Platform.isDesktopApp ? desktopModules ? [] : [{ id: "skills" }, { id: "mcp" }, { id: "tools" }] : RESOURCE_TABS;
    resourceTabs.forEach((tab, index) => {
      const label = tab.id === "tools" ? (this.plugin.settings.settingsLanguage === "en" ? "Tools" : "工具") : copy.resources.tabs[tab.id];
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
        const nextIndex = tabIndexFromKeyboard(event.key, index, resourceTabs.length);
        if (nextIndex === null) return;
        event.preventDefault();
        void this.activateResourceTab(resourceTabs[nextIndex].id, true);
      };
    });
    if (activeTab === "tools") {
      toolbar.remove();
      const tools = wrapper.createDiv({ cls: "codex-capability-tools", attr: { id: RESOURCE_PANEL_ID, role: "tabpanel", "aria-labelledby": resourceTabDomId("tools"), tabindex: "0" } });
      const count = this.plugin.settings.agentRegistry.agents.filter(agent => agent.id === GENERAL_ASSISTANT_ID ? !agent.disabledCapabilityIds?.includes("web-search") : agent.capabilityIds?.includes("web-search")).length;
      tools.createDiv({ cls: "codex-resource-assignment", text: this.agentAssignmentLabel(count) });
      renderTavilySettings(tools, this.plugin);
      const toolsButton = activeButton as HTMLButtonElement | null;
      if (!this.suppressResourceTabFocusRestore && this.resourceTabFocusId === "tools") (this.containerEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => { toolsButton?.focus({ preventScroll: true }); this.resourceTabFocusId = null; });
      this.suppressResourceTabFocusRestore = false;
      return;
    }
    const desktopMcp = Platform.isDesktopApp && activeTab === "mcp";
    const showSearch = !desktopMcp || this.currentEchoInkResourceCatalog().filter(resource => resource.kind === "mcp-server").length > 8;
    if (showSearch) this.renderResourceSearch(toolbar, activeTab);
    else {
      this.resourceSearchQuery.mcp = "";
      toolbar.remove();
    }
    const toolbarActions = toolbar.createDiv({ cls: "codex-resource-toolbar-actions" });
    if (activeTab === "mcp" && !Platform.isDesktopApp) {
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
    const renderRefresh = (parent: HTMLElement, iconOnly = false) => {
      const refresh = createOriginButton(parent, {
        cls: `codex-resource-refresh${iconOnly ? " icon-button" : ""}`,
        attr: { type: "button", "aria-label": iconOnly ? copy.common.refresh : copy.resources.refreshTitle, "data-echoink-focus-key": "resources:refresh" }
      });
      applyAmicroButton(refresh, { variant: iconOnly ? "tertiary" : "secondary", motion: "rotate", icon: "refresh-cw" });
      const loading = this.resourceLoadingTab === activeTab;
      if (iconOnly) {
        setTooltip(refresh, copy.common.refresh);
        setAmicroButtonPending(refresh, loading);
      } else refresh.createSpan({ text: loading ? copy.common.loading : copy.common.refresh });
      refresh.disabled = loading;
      refresh.onclick = () => void this.loadWorkspaceResources(true, activeTab);
    };
    if (!desktopMcp) renderRefresh(toolbarActions);
    else toolbarActions.remove();

    const english = this.plugin.settings.settingsLanguage === "en";
    if (!Platform.isDesktopApp) wrapper.createEl("p", {
      cls: "settings-note resources-tab-hint",
      text: activeTab === "plugins"
        ? (english ? "Manage EchoInk plugins." : "管理 EchoInk 的插件。")
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
        "aria-labelledby": desktopModules ? RESOURCE_TITLE_ID : resourceTabDomId(activeTab),
        tabindex: "0",
        "aria-busy": String(isLoading)
      }
    });
    if (Platform.isDesktopApp && activeTab === "mcp") {
      this.membershipRowsDisposers.push(renderMcpServerSettings(body, this.plugin, () => this.openDesktopRoute({ tab: "account", focus: "account:benefits" })));
      const header = body.createDiv({ cls: "codex-resource-list-header" });
      const heading = new OriginSetting(header).setName(this.plugin.settings.settingsLanguage === "en" ? "Added" : "已添加").setHeading();
      heading.settingEl.addClass("codex-resource-group-title");
      const actions = header.createDiv({ cls: "codex-resource-header-actions" });
      renderRefresh(actions, true);
      const add = createOriginButton(actions, { cls: "codex-resource-add icon-button", attr: {
        type: "button", "aria-label": this.plugin.settings.settingsLanguage === "en" ? "Add MCP server" : "新增 MCP Server",
        "data-echoink-focus-key": "resources:mcp:add"
      } });
      setIcon(add, "plus"); add.onclick = () => this.openMcpServerModal();
    }
    if (isLoading && activeTab !== "plugins") {
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
    if (activeTab !== "plugins" && !this.resourceLoaded[activeTab] && !isLoading && !loadError) {
      createSettingsState(body, copy.resources.notLoaded);
    }
    const hasSavedCatalog = this.currentEchoInkResourceCatalog(this.resourceSnapshot).some((resource) => resource.kind === resourceKindForResourceTab(activeTab));
    if (activeTab === "plugins" || ((this.resourceSnapshot || hasSavedCatalog) && (this.resourceLoaded[activeTab] || isLoading || hasSavedCatalog))) {
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
    const presentation = resourcePresentation(resource, this.plugin.settings.settingsLanguage);
    const metadata = isOfficialRemoteSkill(resource) ? this.plugin.getSkillContentResolver?.().catalogEntry(
      typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id
    ) : undefined;
    const page = createSettingsPage(container, {
      title: presentation.name,
      description: (metadata ? english ? metadata.summaryEn : metadata.summary : presentation.description) || (english ? "Resource details" : "资源详情"),
      detail: true,
      backLabel: english ? "Back to Skills and MCP" : "返回 Skills 与 MCP",
      onBack: () => {
        void this.closeSettingsDetail();
      }
    });
    page.addClass("echoink-resource-detail");
    if (isOfficialRemoteSkill(resource)) {
      const locked = remoteSkillLocked(resource, this.plugin.accountService);
      const id = (typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id);
      createPluginEditionBadge(page, "pro", this.plugin.settings.settingsLanguage);
      if (locked) createSettingsState(createSettingsSection(page), english ? "An active PRO membership and an enabled device are required." : "需要有效 PRO，并在账号与会员中启用本机。");
      const comparison = createSettingsSection(page, { title: english ? "Skill access" : "Skill 使用范围", surface: "group" });
      const info = createSettingsGroup(comparison);
      new OriginSetting(info).setName(english ? "Free" : "免费").setDesc(english ? "Built-in basic Skills and basic knowledge review" : "内置基础 Skill 与知识复盘基础版");
      new OriginSetting(info).setName("PRO").setDesc(english ? "7 official methodology Skills, enhanced knowledge review and ongoing updates" : "7 个官方方法论 Skill、知识复盘增强版及持续更新");
      const examples = new OriginSetting(info).setName(english ? "Comparison examples" : "对比示例");
      const compareUrl = typeof metadata?.compareUrl === "string" ? safeSkillCompareUrl(metadata.compareUrl) : null;
      if (compareUrl) {
        const link = createOriginButton(examples.controlEl, { cls: "text-button", text: english ? "View" : "查看" });
        link.onclick = () => window.open(compareUrl, "_blank", "noopener,noreferrer");
      } else examples.setDesc(english ? "Not available yet" : "尚未提供");
      const help = new OriginSetting(info).setName(english ? "Downloads and offline use" : "下载与离线使用");
      const helpButton = createOriginButton(help.controlEl, { cls: "is-icon", attr: { "aria-label": english ? "Downloads and offline use" : "下载与离线使用" } });
      setIcon(helpButton, "circle-alert");
      attachSettingsHelpTooltip(helpButton, skillDeliveryNotice(english));
      if (!locked) {
        const read = createOriginButton(page, { cls: "text-button", text: english ? "Read official instructions" : "查看官方指令" });
        const body = page.createDiv({ cls: "markdown-rendered" });
        const component = new Component(); component.load();
        this.membershipRowsDisposers.push(() => component.unload());
        this.membershipRowsDisposers.push((this.plugin.accountService ?? unavailableCapabilityAccess).subscribe(() => {
          if (remoteSkillLocked(resource, this.plugin.accountService)) { body.empty(); read.disabled = true; }
        }));
        read.onclick = async () => {
          read.disabled = true;
          try {
            const selected = await this.plugin.getSkillContentResolver().resolve(id);
            selected.assertAvailable();
            if (body.isConnected) { body.empty(); await MarkdownRenderer.render(this.app, selected.content, body, "", component); }
          } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
          finally { read.disabled = false; }
        };
      }
      return;
    }
    this.renderSettingsActionError(page, "resources");
    const connectionStatus = resource.kind === "mcp-server"
      ? mcpConnectionStatus(resource, this.plugin.settings.resources)
      : "not-mcp";
    if (resource.kind !== "mcp-server") {
      const status = createSettingsSection(page, {
        title: presentation.name,
        description: resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage),
        surface: "group"
      });
      status.addClass("resources-detail-status");
      const statusActions = status.querySelector<HTMLElement>(".settings-card-header")!.createDiv({ cls: "resources-status-actions" });
      statusActions.createSpan({ cls: `status ${resource.enabled ? "healthy" : "neutral"}`, text: resource.enabled
        ? (english ? "Enabled" : "已启用") : (english ? "Disabled" : "已停用") });
      if (resource.kind === "skill") {
        const toggle = createOriginSwitch(statusActions, { cls: "codex-resource-toggle", attr: {
          type: "checkbox", "aria-label": english ? `Enable ${presentation.name}` : `启用 ${presentation.name}`,
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
    tabId: ResourceNavigationTab,
    focus: boolean
  ): Promise<void> {
    if (Platform.isDesktopApp) {
      if (this.desktopRoute?.capabilityTab === tabId) return;
      this.suspendActiveEditor();
      this.suspendedTabEditors.delete("capabilities");
      this.desktopRoute = { tab: "capabilities", capabilityTab: tabId === "plugins" ? "skills" : tabId };
      this.settingsDetail = null;
    } else if (this.plugin.settings.resourceManagementTab === tabId) return;
    this.resourceTabFocusId = focus ? tabId : null;
    this.suppressResourceTabFocusRestore = !focus;
    if (tabId !== "tools") {
      this.plugin.settings.resourceManagementTab = tabId;
      await this.plugin.saveSettings();
    }
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
      aliases: [row.dataset.resourceAliases ?? ""],
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
      const bundles = catalog.filter((resource) => resource.kind === "tool-bundle");
      const diary = builtinPluginPresentation("english-diary", this.plugin.settings.settingsLanguage);
      this.renderEchoInkResources(container, [{
        id: "echoink:english-diary", kind: "tool-bundle", source: "echoink-local", bridgeMode: "plugin-tool",
        name: "English Diary",
        description: diary.description,
        enabled: this.plugin.settings.englishDiary.enabled
      }, { id: "echoink:selection-ask", kind: "tool-bundle", source: "echoink-local", bridgeMode: "plugin-tool", name: "Selection Ask", description: builtinPluginPresentation("selection-ask", this.plugin.settings.settingsLanguage).description, enabled: this.plugin.settings.selectionAsk.enabled }, ...bundles], snapshot.errors.plugins);
      return;
    }
    if (this.plugin.settings.resourceManagementTab === "mcp") {
      this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "mcp-server"), snapshot.errors.mcp);
      return;
    }
    this.renderEchoInkResources(container, catalog.filter((resource) => resource.kind === "skill"), snapshot.errors.skills);
  }

  private renderEnglishDiarySettings(container: HTMLElement, embedded = false): void {
    const diary = builtinPluginPresentation("english-diary", this.plugin.settings.settingsLanguage);
    const page = embedded ? container : createSettingsPage(container, {
      title: diary.name, description: diary.description,
      detail: true, backLabel: "返回插件", onBack: () => { void this.closeSettingsDetail(); }
    });
    page.addClass("echoink-english-settings");
    if (!embedded && Platform.isDesktopApp) {
      createSettingsNavigationRow(createSettingsGroup(createSettingsSection(page, { surface: "flat" })), { title: "日记足迹", value: "英文日记数据页", actionLabel: "查看", focusKey: "english-diary:activity", onActivate: () => {
        (this.app as unknown as { setting: { close(): void } }).setting.close(); void this.plugin.activateEnglishDiaryPage();
      } });
    } else if (!embedded) {
      const activity = createSettingsSection(page, { title: "日记足迹", surface: "flat" });
      const statistics = activity.createDiv();
      const repository = this.plugin.englishDiary?.api.repository;
      const renderStatistics = () => { if (statistics.isConnected) void renderEnglishDiaryActivity(statistics, repository, this.app); };
      void renderEnglishDiaryActivity(statistics, repository, this.app);
      this.disposeDiaryActivity = repository?.subscribe?.(renderStatistics) ?? null;
    }
    const section = createSettingsSection(page, { title: embedded ? undefined : "模型", surface: "flat" });
    const group = createSettingsGroup(section);
    const current = this.plugin.settings.englishDiary;
    const value = current.providerSettingsId ? providerModelSelectionValue(current.providerSettingsId, current.modelId) : "";
    let modelPending = false;
    let modelControls: ProPluginControls | null = null;
    const modelSetting = applySettingsRow(new OriginSetting(group)
      .setName("英文生成模型")
      .setDesc(embedded ? "右侧普通对话沿用对话栏选择的模型。" : `当前：${this.plugin.englishDiaryProviderLabel().replace(/[。.!！]+$/u, "")}。右侧普通对话沿用对话栏选择的模型。`)
      .addOriginDropdown(this.app, (dropdown) => {
        if (embedded) {
          const access = this.plugin.accountService ?? unavailableCapabilityAccess;
          const controls = modelControls = new ProPluginControls(access, () => getProPluginAccess(access, current.enabled));
          controls.bind(dropdown.selectEl, { businessDisabled: () => modelPending }); this.membershipRowsDisposers.push(() => controls.dispose());
        }
        dropdown.selectEl.setAttr("aria-label", "英文生成模型");
        dropdown.addOption("", "跟随 EchoInk 默认模型");
        let found = !value;
        for (const provider of this.plugin.settings.apiProviders) {
          const ready = apiProviderHasUsableCredential(provider, this.plugin.settings.openAICodexCredential);
          const providerName = apiProviderConfiguredDisplayName(normalizeApiProviderId(provider.providerId, provider.baseUrl, provider.name), provider.name, this.plugin.settings.settingsLanguage);
          for (const model of provider.models) {
            const key = providerModelSelectionValue(provider.id, model.id);
            if (key === value) found = true;
            dropdown.addOption(key, `${providerName} · ${model.displayName}${ready ? "" : "（需配置授权）"}`);
            dropdown.setOptionDisabled(key, !ready);
          }
        }
        if (!found) dropdown.addOption(value, "原模型已移除，请重新选择");
        dropdown.setValue(value).onChange(async (next) => {
          if (embedded && !getProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess, current.enabled).canWrite) { dropdown.setValue(value); return; }
          const selection = next ? parseProviderModelSelectionValue(next) : { providerSettingsId: "", modelId: "" };
          if (!selection) return;
          modelPending = true; dropdown.setDisabled(true);
          try {
            await this.plugin.setEnglishDiaryModel(selection.providerSettingsId, selection.modelId);
            this.scheduleDisplay();
          } catch (error) {
            dropdown.setValue(value);
            new Notice(error instanceof Error ? error.message : String(error));
          } finally { modelPending = false; if (modelControls) modelControls.refresh(); else dropdown.setDisabled(false); }
        });
      }));
    if (!embedded) this.decorateSetting(modelSetting, "brain-circuit");
    const files = createSettingsGroup(createSettingsSection(page, { title: embedded ? undefined : "文件与内容", description: embedded ? undefined : "原稿、英文稿和词条都是可从文件夹查看的 Markdown 笔记。分类与备注可在表达库内修改。", surface: "flat" }));
    const native = readNativeJournalSettings(this.app, this.plugin.settings.journalDirectory);
    applySettingsRow(new OriginSetting(files).setName("日记原稿").setDesc(`沿用 Obsidian 日记：${native.folder || "Vault 根目录"}，可正常编辑。在英文面板更多菜单的“发送范围”中选择允许生成的段落。`));
    for (const [name, value] of [["英文稿位置", current.englishDirectory], ["表达库位置", current.expressionDirectory]]) {
      const row = new OriginSetting(files);
      row.setName(name); applySettingsRow(row);
      if (Platform.isDesktopApp && embedded) row.addOriginText(text => { text.setValue(value); text.inputEl.readOnly = true; text.inputEl.setAttr("aria-label", name); });
      else row.setDesc(value);
    }
    const openLibrary = async () => {
      try {
        if (!current.enabled) { new Notice("请先在插件列表中启用英文日记。"); return; }
        await this.plugin.englishDiary?.openLibrary();
        (this.app as unknown as { setting: { close(): void } }).setting.close();
      } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    };
    if (!embedded) createSettingsNavigationRow(files, { title: "表达库", description: "搜索已收录的表达，查看出处、修改分类与备注。", actionLabel: "打开", onActivate: () => { void openLibrary(); } });
    const zh = this.plugin.settings.settingsLanguage !== "en";
    const shortcutLabel = Platform.isDesktopApp
      ? (zh ? "移动端英文日记快捷入口" : "English diary shortcut on mobile")
      : (zh ? "首页快捷入口" : "Home shortcut");
    const shortcutHint = Platform.isDesktopApp
      ? (zh ? "将移动端的快速记录入口改为写英文日记" : "Replace Quick note on mobile with Write English diary")
      : (zh ? "将首页“快速记录”替换为“写英文日记”。" : "Replace Quick note on Home with Write English diary.");
    if (embedded) {
      this.renderModuleCheckbox(files, shortcutLabel, current.homeShortcut === "english-diary", shortcutHint, async enabled => {
        if (!this.plugin.englishDiary) throw new Error(zh ? "英文日记尚未就绪" : "English Diary is not ready");
        await this.plugin.englishDiary.setHomeShortcut(enabled ? "english-diary" : "quick-record");
      }, true, "english-diary:home-shortcut");
      return;
    }
    applySettingsRow(new OriginSetting(files)
      .setName(shortcutLabel)
      .setDesc(zh ? "将首页“快速记录”替换为“写英文日记”。" : "Replace “Quick note” on Home with “Write English diary”.")
      .addOriginToggle((toggle) => {
        labelSettingsToggle(toggle, shortcutLabel);
        toggle.toggleEl.setAttr("data-echoink-focus-key", "english-diary:home-shortcut");
        toggle.setValue(this.plugin.settings.englishDiary.homeShortcut === "english-diary").onChange(async (enabled) => {
          toggle.setDisabled(true);
          try {
            if (!this.plugin.englishDiary) throw new Error(zh ? "英文日记尚未就绪，请稍后重试。" : "English Diary is not ready. Please try again.");
            await this.plugin.englishDiary.setHomeShortcut(enabled ? "english-diary" : "quick-record");
          } catch (error) {
            const message = error instanceof Error ? error.message : (zh ? "首页快捷入口未保存，请重试。" : "The home shortcut was not saved. Please try again.");
            new Notice(message);
            this.announceSettingsStatus(message);
          } finally {
            toggle.setValue(this.plugin.settings.englishDiary.homeShortcut === "english-diary");
            toggle.setDisabled(false);
          }
        });
      }));
  }

  private renderBuiltinPluginRow(
    container: HTMLElement,
    kind: LifestyleKind | "pdf",
    visible: boolean,
    searchRow: { key: string; name: string; meta: string; desc: string; aliases?: readonly string[] }
  ): void {
    const english = this.plugin.settings.settingsLanguage === "en";
    const row = container.createDiv({
      cls: `codex-resource-row codex-resource-builtin-plugin ${visible ? "" : "is-search-hidden"}`,
      attr: {
        "data-resource-key": searchRow.key,
        "data-resource-name": searchRow.name,
        "data-resource-meta": searchRow.meta,
        "data-resource-desc": searchRow.desc,
        "data-resource-aliases": searchRow.aliases?.join("\n") ?? ""
      }
    });
    setIcon(row.createSpan({ cls: "codex-resource-row-icon" }), kind === "pdf" ? "file-text" : "wallet");
    const content = row.createDiv({ cls: "codex-resource-row-content" });
    const title = content.createDiv({ cls: "codex-resource-row-title" });
    const name = createOriginButton(title, {
      cls: "codex-resource-row-name", text: searchRow.name,
      attr: { type: "button", "data-echoink-focus-key": `${searchRow.key}:detail` }
    });
    name.onclick = () => { if (kind === "pdf") this.openPdfReadingDetail(); else this.openLifestyleDetail(kind); };
    createPluginEditionBadge(title, "pro", this.plugin.settings.settingsLanguage);
    content.createDiv({ cls: "codex-resource-row-desc", text: searchRow.desc });
    const actions = row.createDiv({ cls: "codex-resource-row-actions" });
    const settings = createOriginButton(actions, {
      cls: "text-button",
      text: english ? "Settings" : "设置",
      attr: { type: "button", "data-echoink-focus-key": `${searchRow.key}:settings` }
    });
    settings.onclick = () => { if (kind === "pdf") this.openPdfReadingDetail(); else this.openLifestyleDetail(kind); };
    const toggle = createOriginSwitch(row, {
      cls: "codex-resource-toggle",
      attr: { "aria-label": this.copy.resources.toggleAria(searchRow.name), "data-echoink-focus-key": `${searchRow.key}:enabled` }
    });
    let pending = false;
    const access = this.plugin.accountService ?? unavailableCapabilityAccess;
    const updateState = () => {
      const enabled = kind === "pdf" ? this.plugin.settings.pdfReading.enabled : this.plugin.settings.lifestyle[kind].enabled;
      const policy = getProPluginAccess(access, enabled);
      toggle.disabled = pending || !policy.canToggle;
      toggle.checked = enabled;
      row.toggleClass("is-enabled", enabled);
      row.toggleClass("is-disabled", !enabled);
      name.disabled = settings.disabled = pending || !policy.canEnter;
    };
    updateState();
    this.membershipRowsDisposers.push(access.subscribe(updateState));
    toggle.onchange = async () => {
      pending = true;
      const enabled = toggle.checked;
      toggle.disabled = true;
      name.disabled = settings.disabled = true;
      try {
        if (kind === "pdf") await this.plugin.pdfReading?.setEnabled(enabled);
        else await this.plugin.lifestyle.setEnabled(kind, enabled);
      } catch (error) {
        const message = error instanceof Error ? error.message : (english ? "The plugin setting was not saved." : "插件状态保存失败");
        new Notice(message);
        this.announceSettingsStatus(message);
      } finally {
        pending = false;
        updateState();
        this.updateResourceSummaryCounts();
      }
    };
  }

  private renderEchoInkResources(container: HTMLElement, resources: EchoInkResource[], error?: string): void {
    const copy = this.copy;
    const activeTab = this.plugin.settings.resourceManagementTab;
    const rows: Array<{ key: string; name: string; meta: string; desc: string; aliases: readonly string[]; enabled: boolean; resource?: EchoInkResource; lifeKind?: LifestyleKind | "pdf" }> = resources.map((resource) => {
      const presentation = resourcePresentation(resource, this.plugin.settings.settingsLanguage);
      return {
        key: resource.id,
        name: presentation.name,
        aliases: presentation.aliases,
        meta: [resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage), resource.id === "echoink:selection-ask" ? (this.plugin.settings.settingsLanguage === "en" ? "Basic" : "基础") : resource.kind === "tool-bundle" ? "PRO" : ""].filter(Boolean).join(" "),
        desc: presentation.description || resource.contentPath || resource.configPath || copy.resources.noDesc,
        enabled: resource.enabled,
        resource
      };
    });
    if (activeTab === "plugins") {
      const english = this.plugin.settings.settingsLanguage === "en";
      rows.unshift({ key: "builtin-plugin:pdf", name: "PDF 精读 · 提取", aliases: ["PDF reading", "提取", "翻译"], meta: "PRO", desc: english ? "Extract, read and translate a PDF into linked notes" : "提取单篇 PDF，生成精读笔记与按需译文", enabled: this.plugin.settings.pdfReading.enabled, lifeKind: "pdf" });
      const finance = builtinPluginPresentation("finance", this.plugin.settings.settingsLanguage);
      rows.unshift({
        key: "builtin-plugin:finance",
        name: finance.name,
        aliases: finance.aliases,
        meta: english ? "Built-in plugin PRO" : "内置插件 PRO",
        desc: finance.description,
        enabled: this.plugin.settings.lifestyle.finance.enabled,
        lifeKind: "finance"
      });
    }
    const query = this.resourceSearchQuery[activeTab];
    const enabled = rows.filter((row) => row.enabled).length;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(
      container,
      rows.length,
      enabled,
      error,
      filtered.length,
      query,
      copy.resources.tabs[activeTab]
    );
    if (!rows.length) {
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
    const groups = new Map<string, HTMLElement>();
    const groupFor = (row: typeof rows[number]): HTMLElement => {
      if (!Platform.isDesktopApp || activeTab === "plugins") return container;
      const key = activeTab === "mcp" ? "mcp" : row.resource && isOfficialRemoteSkill(row.resource) ? "pro" : row.resource && builtinSkillIdForResource(row.resource) ? "builtin" : "custom";
      let group = groups.get(key);
      if (!group) {
        const section = createSettingsSection(container, { title: key === "mcp" ? undefined : key === "pro" ? "PRO" : key === "builtin"
          ? (this.plugin.settings.settingsLanguage === "en" ? "Built-in" : "内置")
          : (this.plugin.settings.settingsLanguage === "en" ? "My Skills" : "我的 Skill"), surface: "flat" });
        section.setAttr("data-resource-group", key);
        group = createSettingsGroup(section); groups.set(key, group);
      }
      return group;
    };
    const ordered = Platform.isDesktopApp && activeTab === "skills"
      ? [...rows.filter(row => row.resource && !isOfficialRemoteSkill(row.resource) && builtinSkillIdForResource(row.resource)),
        ...rows.filter(row => row.resource && isOfficialRemoteSkill(row.resource)),
        ...rows.filter(row => !row.resource || !isOfficialRemoteSkill(row.resource) && !builtinSkillIdForResource(row.resource))] : rows;
    for (const row of ordered) {
      const target = groupFor(row);
      if (row.lifeKind) this.renderBuiltinPluginRow(target, row.lifeKind, visibleKeys.has(row.key), row);
      else if (row.resource) this.renderResourceRow(target, row.resource, visibleKeys.has(row.key), row);
    }
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

  private agentAssignmentLabel(count: number): string {
    return this.plugin.settings.settingsLanguage === "en" ? count ? `Used by ${count} Agents` : "Unassigned" : count ? `${count} 个 Agent 在用` : "未分配";
  }

  private resourceAssignedAgentCount(resource: EchoInkResource): number {
    const settings = this.plugin.settings;
    if (resource.kind === "mcp-server") {
      const tools = resolveMcpConnectionRecord(resource, settings.resources)?.tools ?? [];
      const capabilities = tools.map(tool => mcpToolCapabilityId(resource.id, tool.name));
      return settings.agentRegistry.agents.filter(agent => capabilities.some(capability => agent.id === GENERAL_ASSISTANT_ID
        ? !agent.disabledCapabilityIds?.includes(capability) : agent.capabilityIds?.includes(capability))).length;
    }
    if (resource.kind !== "skill") return 0;
    const catalog = this.currentEchoInkResourceCatalog().map(item => item.id === resource.id ? { ...item, enabled: true } : item);
    return settings.agentRegistry.agents.filter(agent => {
      const skillId = typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id;
      const result = checkAgentSkill({ settings, agentId: agent.id, vaultRoot: "", resources: catalog }, skillId);
      return !["agent_disabled", "agent_missing", "unknown_resource"].includes(result.reason);
    }).length;
  }

  private renderResourceRow(container: HTMLElement, resource: EchoInkResource, visible = true, searchRow?: { key: string; name: string; meta?: string; desc?: string; aliases?: readonly string[] }): void {
    const copy = this.copy;
    const presentation = resourcePresentation(resource, this.plugin.settings.settingsLanguage);
    const builtinSkillId = builtinSkillIdForResource(resource);
    if (resource.id === "echoink:selection-ask") {
      renderSelectionAskPluginRow(container, this.plugin, visible, () => this.openSettingsDetail("selection-ask")); return;
    }
    const isEnglishDiary = resource.id === "echoink:english-diary";
    const resourceEnabled = resource.enabled;
    const row = container.createDiv({
      cls: `codex-resource-row ${resourceEnabled ? "is-enabled" : "is-disabled"} ${visible ? "" : "is-search-hidden"}`,
      attr: {
        "data-resource-key": searchRow?.key ?? resource.id,
        "data-resource-name": searchRow?.name ?? presentation.name,
        "data-resource-meta": searchRow?.meta ?? "",
        "data-resource-desc": searchRow?.desc ?? "",
        "data-resource-aliases": (searchRow?.aliases ?? presentation.aliases).join("\n")
      }
    });
    const openArea = Platform.isDesktopApp ? createOriginButton(row, {
      cls: "codex-resource-row-open codex-resource-row-name text-button",
      attr: { type: "button", "data-echoink-focus-key": `resource:${resource.id}:detail`,
        "aria-label": this.plugin.settings.settingsLanguage === "en" ? `Open ${presentation.name} details` : `打开 ${presentation.name} 详情` }
    }) : row;
    const icon = openArea.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, isEnglishDiary ? "languages" : resource.kind === "skill"
      ? Platform.isDesktopApp ? builtinSkillId ? DESKTOP_BUILTIN_SKILL_ICONS[builtinSkillId] ?? "sparkles" : "sparkles" : skillIcon(typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id)
      : resource.kind === "mcp-server" ? "blocks" : "package");
    const content = openArea.createDiv({ cls: "codex-resource-row-content" });
    const name = presentation.name;
    const connectionStatus = resource.kind === "mcp-server" ? mcpConnectionStatus(resource, this.plugin.settings.resources) : "not-mcp";
    const meta = resourceDisplayMeta(resource, this.plugin.settings.resources, this.plugin.settings.settingsLanguage);
    const title = content.createDiv({ cls: "codex-resource-row-title" });
    const nameButton = Platform.isDesktopApp ? openArea as HTMLButtonElement : createOriginButton(title, {
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
    if (Platform.isDesktopApp) title.createSpan({ text: name });
    nameButton.onclick = () => this.openSettingsDetail(isEnglishDiary ? "english-diary" : { kind: "resource", resourceId: resource.id });
    if (resource.kind === "tool-bundle") {
      createPluginEditionBadge(title, isEnglishDiary && resource.metadata?.edition === "basic" ? "basic" : "pro", this.plugin.settings.settingsLanguage);
    }
    if (builtinSkillId) {
      if (!Platform.isDesktopApp) title.createSpan({
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
    const desc = presentation.description || resource.contentPath || resource.configPath || copy.resources.noDesc;
    const description = Platform.isDesktopApp ? desc : [desc, meta].filter(Boolean).join(" · ");
    if (Platform.isDesktopApp) setTooltip(icon, resourceSourceLabel(resource.source, this.plugin.settings.settingsLanguage));
    if (description) content.createDiv({ cls: "codex-resource-row-desc", text: description });
    let diarySettings: HTMLButtonElement | undefined;
    if (isEnglishDiary) {
      const actions = row.createDiv({ cls: "codex-resource-row-actions" });
      const settings = createOriginButton(actions, { cls: "text-button", text: this.plugin.settings.settingsLanguage === "en" ? "Settings" : "设置", attr: { type: "button", "data-echoink-focus-key": "english-diary:settings" } });
      diarySettings = settings;
      settings.onclick = () => this.openSettingsDetail("english-diary");
    }
    if (Platform.isDesktopApp && resource.kind === "mcp-server") {
      const status = row.createSpan({ cls: `codex-resource-connection-state is-${connectionStatus}` });
      setIcon(status.createSpan({ attr: { "aria-hidden": "true" } }), connectionStatus === "verified" ? "check-circle-2" : connectionStatus === "failed" ? "circle-alert" : "circle-help");
      status.createSpan({ text: mcpConnectionStatusLabel(connectionStatus, this.plugin.settings.settingsLanguage) });
    }
    if (Platform.isDesktopApp && resource.kind !== "tool-bundle") {
      // Assignment presence is fixed for this row; rebuilding/removing the row owns cleanup.
      row.classList.add("has-agent-assignment");
      row.createSpan({ cls: "codex-resource-assignment", text: this.agentAssignmentLabel(this.resourceAssignedAgentCount(resource)) });
    }
    const toggle = createOriginSwitch(row, {
      cls: "codex-resource-toggle",
      attr: {
        type: "checkbox",
        "aria-label": copy.resources.toggleAria(name),
        "data-echoink-focus-key": `resource:${resource.id}:enabled`
      }
    });
    toggle.checked = resourceEnabled;
    if (isOfficialRemoteSkill(resource)) {
      const badge = title.createSpan({ cls: "codex-resource-state-badge" });
      const update = () => {
        const locked = remoteSkillLocked(resource, this.plugin.accountService);
        badge.empty();
        if (locked) setIcon(badge.createSpan({ attr: { "aria-hidden": "true" } }), "lock");
        badge.setAttr("aria-label", this.plugin.settings.settingsLanguage === "en" ? "PRO required" : "需要 PRO");
        badge.hidden = !locked;
        toggle.disabled = locked;
        toggle.hidden = locked;
      };
      update();
      this.membershipRowsDisposers.push((this.plugin.accountService ?? unavailableCapabilityAccess).subscribe(update));
    }
    const currentEnabled = () => isEnglishDiary ? this.plugin.settings.englishDiary.enabled
      : this.plugin.settings.resources.catalog.find((candidate) => candidate.id === resource.id)?.enabled ?? false;
    let diaryPending = false;
    const updateDiaryAccess = () => {
      if (!isEnglishDiary) return;
      const enabled = currentEnabled();
      const policy = getProPluginAccess(this.plugin.accountService ?? unavailableCapabilityAccess, enabled);
      toggle.checked = enabled;
      toggle.disabled = diaryPending || !policy.canToggle;
      nameButton.disabled = !!diaryPending || !policy.canEnter;
      if (diarySettings) diarySettings.disabled = nameButton.disabled;
      row.toggleClass("is-enabled", enabled); row.toggleClass("is-disabled", !enabled);
    };
    updateDiaryAccess();
    if (isEnglishDiary) this.membershipRowsDisposers.push((this.plugin.accountService ?? unavailableCapabilityAccess).subscribe(updateDiaryAccess));
    toggle.onchange = async () => {
      const enabled = toggle.checked;
      if (isEnglishDiary) { diaryPending = true; updateDiaryAccess(); }
      try {
        if (isEnglishDiary) {
          await this.plugin.englishDiary!.setEnabled(enabled);
        } else if (resource.kind === "mcp-server") {
          await this.plugin.setEchoInkMcpServerEnabled(resource.id, enabled);
        } else {
          if (remoteSkillLocked(resource, this.plugin.accountService)) throw new Error(this.plugin.settings.settingsLanguage === "en" ? "An active PRO membership is required." : "此 Skill 需要有效 PRO。");
          await this.plugin.setEchoInkSkillResourceEnabled(resource.id, enabled);
        }
        const authoritativeEnabled = currentEnabled();
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        this.updateResourceSummaryCounts();
      } catch {
        const authoritativeEnabled = currentEnabled();
        toggle.checked = authoritativeEnabled;
        row.toggleClass("is-enabled", authoritativeEnabled);
        row.toggleClass("is-disabled", !authoritativeEnabled);
        const message = this.plugin.settings.settingsLanguage === "en"
          ? "The resource setting was not saved."
          : "资源开关未保存，请重试。";
        new Notice(message);
        this.announceSettingsStatus(message);
      } finally {
        if (isEnglishDiary) { diaryPending = false; updateDiaryAccess(); }
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
      if (Platform.isDesktopApp) applyDeleteButton(remove);
      remove.onclick = () => showSettingsInlineConfirmation(row, remove, {
        deleteAction: Platform.isDesktopApp,
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
        const editorKey = resource ? `mcp:edit:${resource.id}` : "mcp:new";
        if (this.inlineEditor?.key === editorKey) this.settingsDetail = { kind: "resource", resourceId: saved.id };
        await this.loadWorkspaceResources(true, "mcp");
        const message = this.plugin.settings.settingsLanguage === "en"
          ? `Saved MCP server ${saved.name}.`
          : `已保存 MCP Server：${saved.name}。`;
        new Notice(message);
        this.announceSettingsStatus(message);
      }
    });
    this.openInlineEditor(editor, Platform.isDesktopApp ? "capabilities" : "resources", undefined, resource ? `mcp:edit:${resource.id}` : "mcp:new");
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
    } catch {
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

type ResourceNavigationTab = ResourceManagementTab | "tools";

type VisibleSettingsTab = SettingsTab | DesktopSettingsTab;

type SettingsActionContext = "knowledge" | "review" | "resources" | "providers";

type SettingsDetail =
  | "generation-templates"
  | "generation-template"
  | "journal-templates"
  | "todo-categories"
  | "pdf-reading"
  | "english-diary"
  | "selection-ask"
  | "knowledge-linking"
  | "knowledge-folders"
  | "knowledge-preferences"
  | "knowledge-maintenance-history"
  | "review-archives"
  | "review-memory"
  | { readonly kind: "resource"; readonly resourceId: string }
  | { readonly kind: "lifestyle"; readonly lifeKind: LifestyleKind }
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

const SETTINGS_PANEL_ID = "echoink-settings-panel";
const SETTINGS_TITLE_ID = "echoink-settings-title";
const RESOURCE_PANEL_ID = "echoink-resource-panel";
const RESOURCE_TITLE_ID = "echoink-resource-title";
const SETTINGS_TAB_ICON_ANIMATION_WINDOW_MS = 1_250;

const SETTINGS_TABS: Array<{
  id: VisibleSettingsTab;
  icon: AnimatedSettingsTabIconName;
}> = [
  { id: "general", icon: SETTINGS_TAB_ICONS.general },
  { id: "layout", icon: SETTINGS_TAB_ICONS.layout },
  { id: "providers", icon: SETTINGS_TAB_ICONS.providers },
  { id: "resources", icon: SETTINGS_TAB_ICONS.resources },
  { id: "knowledgeBase", icon: SETTINGS_TAB_ICONS.knowledgeBase },
  { id: "review", icon: SETTINGS_TAB_ICONS.review },
  { id: "todos", icon: SETTINGS_TAB_ICONS.todos },
  { id: "account", icon: SETTINGS_TAB_ICONS.account }
];

function settingsTabDomId(tab: VisibleSettingsTab): string {
  return `echoink-settings-tab-${tab}`;
}

function resourceTabDomId(tab: ResourceNavigationTab): string {
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

/** The desktop Demo maps these stable built-in IDs to existing Lucide icons. */
const DESKTOP_BUILTIN_SKILL_ICONS: Readonly<Record<string, string>> = {
  "clarify-real-question": "circle-help", "two-layer-explanation": "layers",
  "deep-understanding": "microscope", "evidence-freshness-audit": "badge-check",
  "multi-lens-problem-solving": "shapes", "minimum-real-world-experiment": "flask-conical",
  "knowledge-review": "graduation-cap", "self-discovery-life-design": "sprout",
  "daily-journal": "book-open", "english-diary": "languages",
  "finance-bill-import": "receipt", "finance-analysis": "chart-pie", "finance-operations": "wallet",
  "obsidian-markdown": "hash", "obsidian-bases": "table", "json-canvas": "layout-dashboard", "obsidian-cli": "terminal"
};

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
  return resource.metadata?.builtin === false ? null : isBuiltinSkillId(skillId) ? skillId : null;
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

import { membershipWebsiteLink } from "../membership/website-links";
