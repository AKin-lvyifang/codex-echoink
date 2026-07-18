import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, setIcon, TFile, type FuzzyMatch } from "obsidian";
import { execFile } from "child_process";
import type CodexForObsidianPlugin from "../main";
import { swallowError } from "../core/error-handling";
import { isAgentRuntimeAvailabilityError } from "../core/agent-runtime-health";
import { detectCodexCommand, detectCodexInstallation, inspectCodexInstallation } from "../core/codex-service";
import { CodexLoginError } from "../core/codex-login";
import { HermesBackend } from "../core/hermes-backend";
import { detectHermesCommand } from "../core/hermes-models";
import { OpenCodeBackend } from "../core/opencode-backend";
import { detectOpenCodeCommand, resolveOpenCodeLaunch, selectOpenCodeConnectionModel } from "../core/opencode-models";
import {
  AGENT_SETUP_PROGRESS_STAGES,
  createAgentSetupSnapshot,
  isAgentSetupDetectionRevisionCurrent,
  limitedAgentSetupLog,
  readyAgentBackendToCommit,
  reconcileTerminalAgentInstallDetection,
  resolveAgentCommandObservation,
  resolveAgentSetupDashboardState,
  resolveAgentSetupProviderModelLabel,
  runAgentInstallerAction,
  type AgentInstaller,
  type AgentInstallerAction,
  type AgentInstallerRegistry,
  type AgentSetupContext,
  type AgentSetupNextAction,
  type AgentSetupProgress,
  type AgentSetupSnapshot
} from "../core/agent-setup";
import { installNpmCli } from "../core/npm-cli-installer";
import { installHermesCli } from "../core/hermes-installer";
import { authorizeHermesNous, HERMES_NOUS_PROVIDER, inspectHermesModelConfig } from "../core/hermes-setup";
import {
  openCodeApiCredential,
  openCodeAuthorizationConnectionOverrides,
  openCodeAutomaticOAuthInstructions,
  redactOpenCodeAuthSecrets,
  shouldRequestOpenCodeAuthPrompt
} from "../core/opencode-auth";
import { AGENT_BACKEND_DEFINITIONS } from "../agent/registry";
import type { AgentModelInfo, AgentProfileInfo } from "../agent/types";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import { mcpConnectionStatus, mcpConnectionStatusLabel } from "../resources/mcp-connections";
import type { EchoInkResource, EchoInkResourceScope } from "../resources/types";
import {
  emptyWorkspaceResourceSnapshot,
  errorsFromWorkspaceResourceCache,
  loadedTabsFromWorkspaceResourceCache,
  snapshotFromWorkspaceResourceCache
} from "../core/workspace-resources";
import { filterWorkspaceResourceRows } from "../core/workspace-resource-filter";
import {
  DEFAULT_CODEX_UTILITY_MODEL,
  DEFAULT_HERMES_UTILITY_MODEL,
  DEFAULT_OPENCODE_UTILITY_MODEL,
  DEFAULT_SETTINGS,
  DEFAULT_PROMPT_ENHANCER_MODEL,
  ensureModelChoices,
  getActiveApiProvider,
  getApiProviderModels,
  getKnowledgeBaseRulesFileChoices,
  newId,
  openCodeAgentChoiceLabel,
  openCodeAgentChoiceValue,
  openCodeAgentModeLabel,
  openCodeModelCapabilityLabel,
  openCodeModelChoiceLabel,
  openCodeModelChoiceValue,
  parseOpenCodeAgentChoiceValue,
  parseOpenCodeModelChoiceValue,
  parsePromptEnhancerModelId,
  promptEnhancerModelId,
  providerModelLabel,
  providerConnectionLabel,
  removeApiProvider,
  normalizeEditorActionQualityMode,
  normalizeKnowledgeBaseBackendMode,
  normalizeKnowledgeBaseHistoryRetentionDays,
  normalizeReviewOutputDir,
  normalizeSettingsLanguage,
  validateApiProvider,
  type ApiProviderConfig,
  type AgentBackendMode,
  type EditorActionQualityMode,
  type EditorAiActionConfig,
  type EditorAiStyleConfig,
  type KnowledgeBaseBackendMode,
  type ReviewReportKind,
  type ResourceManagementTab,
  type SettingsTab,
  type WorkspaceResourceToggles
} from "./settings";
import { ENHANCE_META_PROMPT, ENHANCE_PROMPT_AGENT_NAME } from "../prompt-enhancer/meta-prompt";
import {
  promptEnhancerBackendCapabilities,
  promptEnhancerModelChoices,
  resolvePromptEnhancerBackend,
  resolvePromptEnhancerModel
} from "../prompt-enhancer/service";
import type { CodexModel, CodexStatusSnapshot, PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode, WorkspaceResourceSnapshot } from "../types/app-server";
import { AGENTS_RULES_FILE, CODEX_MEMORY_LITE_URL, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../knowledge-base/constants";
import { repairKnowledgeBaseRulesFile, resolveKnowledgeBaseRulesFilePath } from "../knowledge-base/rules-repair";
import { confirmModal, selectInputModal, textInputModal } from "../ui/modals";
import { openExternalInElectron, openPathInElectron } from "../core/electron";
import { SETTINGS_LANGUAGE_OPTIONS, settingsCopy, type SettingsCopy } from "./i18n";
import { captureSettingsScrollSnapshot, restoreSettingsScrollSnapshot } from "./settings-scroll";
import { CODEX_CLI_INSTALL_COMMAND, HERMES_DOCS_URL, OPENCODE_DOCS_URL, completeSetupState } from "./setup-check";
import type { CodexMemoryMigrationPreview, MemoryStoreStatus } from "../harness/memory/file-memory";

export class CodexSettingTab extends PluginSettingTab {
  private resourceSnapshot: WorkspaceResourceSnapshot | null = null;
  private runtimeEchoInkResources: EchoInkResource[] = [];
  private resourceLoadingTab: ResourceManagementTab | null = null;
  private resourceLoaded: Record<ResourceManagementTab, boolean> = { plugins: false, mcp: false, skills: false };
  private resourceLoadErrors: Partial<Record<ResourceManagementTab, string>> = {};
  private resourceSearchQuery: Record<ResourceManagementTab, string> = { plugins: "", mcp: "", skills: "" };
  private resourceSearchDebounceTimer: number | null = null;
  private openCodeModelChoices: AgentModelInfo[] = [];
  private openCodeModelsLoaded = false;
  private openCodeModelsLoading = false;
  private openCodeModelsError = "";
  private openCodeAgentChoices: AgentProfileInfo[] = [];
  private openCodeAgentsLoaded = false;
  private openCodeAgentsLoading = false;
  private openCodeAgentsError = "";
  private setupSelectedBackend: AgentBackendMode;
  private setupSnapshots: Record<AgentBackendMode, AgentSetupSnapshot>;
  private setupInstallConfirmBackend: AgentBackendMode | null = null;
  private setupBusy = false;
  private setupActiveBackend: AgentBackendMode | null = null;
  private setupAutoCheckStarted = false;
  private setupAutoRepairPending = false;
  private setupDetectionPending = false;
  private setupPendingConnectSelected = false;
  private setupDetectionDrainActive = false;
  private setupDetectionDrainGeneration: number | null = null;
  private setupSessionGeneration = 0;
  private setupSessionActive = false;
  private setupOperationGeneration = 0;
  private setupDetectionTimer: number | null = null;
  private setupAbort: AbortController | null = null;
  private readonly setupDeepCheckedBackends = new Set<AgentBackendMode>();
  private readonly setupPendingInvalidations = new Set<AgentBackendMode>();
  private readonly setupCommandsAwaitingVerification = new Set<AgentBackendMode>();
  private readonly setupObservedCommands: Record<AgentBackendMode, string | null | undefined> = {
    "codex-cli": undefined,
    opencode: undefined,
    hermes: undefined
  };
  private readonly setupConfigRevisions: Record<AgentBackendMode, number> = {
    "codex-cli": 0,
    opencode: 0,
    hermes: 0
  };
  private readonly setupVerifiedRevisions: Record<AgentBackendMode, number> = {
    "codex-cli": -1,
    opencode: -1,
    hermes: -1
  };
  private setupTabFocusTarget: AgentBackendMode | null = null;
  private setupDashboardActionFocusPending = false;
  private setupAdvancedOpen = false;
  private memoryStatus: MemoryStoreStatus | null = null;
  private memoryStatusLoading = false;
  private memoryStatusError: string | null = null;
  private memoryActionRunning = false;
  private memoryMigrationPreview: CodexMemoryMigrationPreview | null = null;
  private displayFrame: number | null = null;
  private settingsTitleEl: HTMLElement | null = null;
  private settingsStatusEl: HTMLElement | null = null;
  private settingsTabsEl: HTMLElement | null = null;
  private settingsBodyEl: HTMLElement | null = null;
  private settingsAgentLiveEl: HTMLElement | null = null;
  private settingsAgentLiveText = "";

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    this.setupSelectedBackend = plugin.settings.agentBackend;
    this.setupSnapshots = {
      "codex-cli": createAgentSetupSnapshot("codex-cli"),
      opencode: createAgentSetupSnapshot("opencode"),
      hermes: createAgentSetupSnapshot("hermes")
    };
    this.reconcileAgentSetupSnapshotsForDisplay();
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  private get copy(): SettingsCopy {
    return settingsCopy(this.plugin.settings.settingsLanguage);
  }

  private get agentInstallers(): AgentInstallerRegistry {
    const createInstaller = (backend: AgentBackendMode): AgentInstaller => ({
      backend,
      detect: (context) => this.detectAgentBackend(backend, context),
      install: (context) => this.performAgentInstall(backend, context),
      authorize: (context) => this.performAgentAuthorization(backend, context),
      connect: (context) => this.performAgentConnection(backend, context)
    });
    return {
      "codex-cli": createInstaller("codex-cli"),
      opencode: createInstaller("opencode"),
      hermes: createInstaller("hermes")
    };
  }

  display(): void {
    if (!this.setupSessionActive) {
      this.setupSessionActive = true;
      this.setupSessionGeneration += 1;
    }
    if (this.plugin.agentSetupTarget) {
      this.setupSelectedBackend = this.plugin.agentSetupTarget;
      this.setupAutoRepairPending = this.plugin.agentSetupAutoRepair;
      if (this.setupAutoRepairPending) this.setupDeepCheckedBackends.delete(this.setupSelectedBackend);
      this.plugin.agentSetupTarget = null;
      this.plugin.agentSetupAutoRepair = false;
      this.setupAutoCheckStarted = false;
    }
    this.reconcileAgentSetupSnapshotsForDisplay();
    if (this.displayFrame !== null) {
      window.cancelAnimationFrame(this.displayFrame);
      this.displayFrame = null;
    }
    this.renderSettingsShell();
    this.renderSettingsContent();
    if (!this.setupAutoCheckStarted) {
      this.setupAutoCheckStarted = true;
      if (this.shouldShowSetupGuide() || this.setupAutoRepairPending) {
        const sessionGeneration = this.setupSessionGeneration;
        this.setupDetectionTimer = window.setTimeout(() => {
          this.setupDetectionTimer = null;
          if (!this.isSetupSessionCurrent(sessionGeneration)) return;
          void this.detectAllAgents(true, sessionGeneration);
        }, 0);
      }
    }
  }

  hide(): void {
    this.setupSessionActive = false;
    this.setupSessionGeneration += 1;
    this.setupOperationGeneration += 1;
    if (this.setupDetectionTimer !== null) {
      window.clearTimeout(this.setupDetectionTimer);
      this.setupDetectionTimer = null;
    }
    if (this.displayFrame !== null) {
      window.cancelAnimationFrame(this.displayFrame);
      this.displayFrame = null;
    }
    const setupAbort = this.setupAbort;
    this.setupAbort = null;
    setupAbort?.abort();
    this.setupBusy = false;
    this.setupActiveBackend = null;
    this.setupDetectionDrainActive = false;
    this.setupDetectionDrainGeneration = null;
    this.setupAutoCheckStarted = false;
    this.setupAutoRepairPending = false;
    this.setupDetectionPending = false;
    this.setupPendingConnectSelected = false;
    this.setupTabFocusTarget = null;
    this.setupDashboardActionFocusPending = false;
    this.setupSelectedBackend = this.plugin.settings.agentBackend;
    this.setupInstallConfirmBackend = null;
    this.setupAdvancedOpen = false;
    super.hide();
  }

  private renderSettingsShell(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.onpointerdown = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".codex-agent-dashboard-tab")) {
        this.setupTabFocusTarget = null;
      }
    };
    this.settingsTitleEl = containerEl.createDiv({ cls: "codex-settings-title" });
    this.settingsStatusEl = containerEl.createDiv({ cls: "codex-settings-status" });
    this.settingsTabsEl = containerEl.createDiv({ cls: "codex-settings-tabs-slot" });
    this.settingsBodyEl = containerEl.createDiv({ cls: "codex-settings-body" });
    this.settingsAgentLiveText = "";
    this.settingsAgentLiveEl = containerEl.createDiv({
      cls: "codex-agent-dashboard-live",
      attr: {
        "aria-live": "polite",
        "aria-atomic": "true",
        "aria-label": this.copy.setup.agentInstaller.dashboard.liveRegionLabel
      }
    });
  }

  private ensureSettingsShell(): void {
    if (this.settingsBodyEl && this.containerEl.contains(this.settingsBodyEl)) return;
    this.renderSettingsShell();
  }

  private renderSettingsContent(): void {
    this.ensureSettingsShell();
    const copy = this.copy;
    const settingsScrollSnapshot = captureSettingsScrollSnapshot(this.containerEl);
    try {
      this.clearResourceSearchDebounceTimer();
      const titleEl = this.settingsTitleEl;
      const statusEl = this.settingsStatusEl;
      const tabsEl = this.settingsTabsEl;
      const bodyEl = this.settingsBodyEl;
      if (!titleEl || !statusEl || !tabsEl || !bodyEl) return;
      this.captureAgentDashboardTabFocus();
      titleEl.empty();
      statusEl.empty();
      tabsEl.empty();
      bodyEl.empty();
      new Setting(titleEl).setName(copy.title).setHeading();

      const status = this.plugin.lastStatus;
      const statusBox = statusEl;
      this.renderAgentDashboard(statusBox);
      if (this.shouldShowSetupGuide()) {
        statusBox.createDiv({
          cls: "codex-agent-dashboard-first-run-gate",
          text: copy.setup.agentInstaller.dashboard.firstRunGate
        });
        return;
      }

      this.renderTopTabs(tabsEl);
      if (this.plugin.settings.settingsTab === "providers") {
        this.renderApiProviderManager(bodyEl);
        return;
      }
      if (this.plugin.settings.settingsTab === "resources") {
        this.renderWorkspaceResourceManager(bodyEl);
        return;
      }
      if (this.plugin.settings.settingsTab === "promptEnhancer") {
        this.renderPromptEnhancerSettings(bodyEl, status);
        return;
      }
      if (this.plugin.settings.settingsTab === "editorActions") {
        this.renderEditorActionSettings(bodyEl);
        return;
      }
      if (this.plugin.settings.settingsTab === "knowledgeBase") {
        this.renderKnowledgeBaseSettings(bodyEl);
        return;
      }
      if (this.plugin.settings.settingsTab === "review") {
        this.renderReviewSettings(bodyEl);
        return;
      }

      this.renderGeneralSettings(bodyEl, status);
    } finally {
      restoreSettingsScrollSnapshot(settingsScrollSnapshot);
    }
  }

  private scheduleDisplay(): void {
    if (!this.setupSessionActive) return;
    this.captureAgentDashboardTabFocus();
    if (this.displayFrame !== null) return;
    this.displayFrame = window.requestAnimationFrame(() => {
      this.displayFrame = null;
      this.renderSettingsContent();
    });
  }

  private isSetupSessionCurrent(sessionGeneration: number): boolean {
    return this.setupSessionActive && sessionGeneration === this.setupSessionGeneration;
  }

  private beginAgentSetupOperation(
    backend: AgentBackendMode | null,
    controller: AbortController | null
  ): number {
    const operationGeneration = ++this.setupOperationGeneration;
    this.setupBusy = true;
    this.setupActiveBackend = backend;
    this.setupAbort = controller;
    return operationGeneration;
  }

  private isAgentSetupOperationOwner(
    operationGeneration: number,
    controller: AbortController | null
  ): boolean {
    return this.setupOperationGeneration === operationGeneration
      && this.setupAbort === controller;
  }

  private finishAgentSetupOperation(
    operationGeneration: number,
    controller: AbortController | null
  ): boolean {
    if (!this.isAgentSetupOperationOwner(operationGeneration, controller)) return false;
    this.setupAbort = null;
    this.setupBusy = false;
    this.setupActiveBackend = null;
    return true;
  }

  private captureAgentDashboardTabFocus(): void {
    const activeElement = this.containerEl.ownerDocument.activeElement;
    if (activeElement instanceof HTMLElement
      && activeElement.matches("[data-agent-dashboard-action='primary']")) {
      this.setupDashboardActionFocusPending = true;
      this.setupTabFocusTarget = null;
      return;
    }
    const focusedDefinition = activeElement instanceof HTMLElement
      ? this.agentDashboardDefinitions().find(
        (definition) => activeElement.id === this.agentDashboardTabId(definition.backend)
      )
      : undefined;
    if (this.setupTabFocusTarget !== null) {
      if (focusedDefinition) return;
      const document = this.containerEl.ownerDocument;
      if (activeElement instanceof HTMLElement
        && activeElement.isConnected
        && activeElement !== document.body
        && activeElement !== document.documentElement) {
        this.setupTabFocusTarget = null;
      }
      return;
    }
    if (focusedDefinition) this.setupTabFocusTarget = focusedDefinition.backend;
  }

  private renderAgentSettings(containerEl: HTMLElement, status: CodexStatusSnapshot | null): void {
    const copy = this.copy;
    const settings = this.plugin.settings;
    const dashboardCopy = copy.setup.agentInstaller.dashboard;
    const wrapper = containerEl.createDiv({ cls: "codex-agent-settings" });

    const definition = this.agentDashboardDefinitions().find((item) => item.backend === this.setupSelectedBackend);
    const advanced = wrapper.createEl("details", { cls: "codex-agent-advanced" });
    advanced.open = this.setupAdvancedOpen;
    advanced.ontoggle = () => {
      this.setupAdvancedOpen = advanced.open;
    };
    advanced.createEl("summary", {
      cls: "codex-agent-advanced-summary",
      text: `${definition?.label ?? "Agent"} · ${dashboardCopy.advancedTitle}`
    });
    const advancedBody = advanced.createEl("fieldset", { cls: "codex-agent-advanced-body" }) as HTMLFieldSetElement;
    advancedBody.disabled = this.isAgentDashboardBusy();

    if (this.setupSelectedBackend === "codex-cli") {
      const codexSection = advancedBody.createDiv({ cls: "codex-editor-actions-section" });
      codexSection.createDiv({ cls: "codex-resource-note", text: detectCliPath(settings.cliPath, copy) });
      this.addProviderText(codexSection, copy.general.cliPath, settings.cliPath, "~/.npm-global/bin/codex", async (value) => {
        settings.cliPath = value.trim();
        settings.agents.codex.cliPath = settings.cliPath;
        this.invalidateAgentSetupReadiness("codex-cli");
        await this.plugin.saveSettings();
        await this.detectAllAgents(true);
      });
      this.decorateSetting(new Setting(codexSection).setName(copy.general.proxyEnabled).setDesc(copy.general.proxyEnabledDesc).addToggle((toggle) =>
        toggle.setValue(settings.proxyEnabled).onChange(async (value) => {
        settings.proxyEnabled = value;
        settings.agents.codex.proxyEnabled = value;
        this.invalidateAgentSetupReadiness("codex-cli");
        await this.plugin.saveSettings();
        })
      ), "waypoints");
      this.addProviderText(codexSection, copy.general.proxyUrl, settings.proxyUrl, "http://127.0.0.1:7890", async (value) => {
      settings.proxyUrl = value.trim();
      settings.agents.codex.proxyUrl = settings.proxyUrl;
      this.invalidateAgentSetupReadiness("codex-cli");
      await this.plugin.saveSettings();
      });
      this.decorateSetting(
        new Setting(codexSection)
          .setName(copy.general.defaultModel)
          .setDesc(copy.general.defaultModelDesc)
          .addDropdown((dropdown) => {
            dropdown.addOption("", copy.general.auto);
            for (const model of ensureModelChoices(status?.models ?? [], settings.defaultModel, DEFAULT_SETTINGS.defaultModel)) {
              dropdown.addOption(model.model, model.displayName || model.model);
            }
            dropdown.setValue(settings.defaultModel);
            dropdown.onChange(async (value) => {
              settings.defaultModel = value;
              settings.agents.codex.defaultModel = value;
              this.invalidateAgentSetupReadiness("codex-cli");
              await this.plugin.saveSettings();
              this.plugin.applyComposerDefaultsToView();
            });
          }),
        "box"
      );
      return;
    }

    if (this.setupSelectedBackend === "opencode") {
      const openCodeSection = advancedBody.createDiv({ cls: "codex-editor-actions-section" });
      this.renderOpenCodeAgentSettings(openCodeSection);
      return;
    }

    const hermes = settings.agents.hermes;
    const hermesSection = advancedBody.createDiv({ cls: "codex-editor-actions-section" });
    hermesSection.createDiv({ cls: "codex-resource-note", text: detectHermesPath(hermes.cliPath, copy) });
    if (hermes.lastConnectedAt) {
      hermesSection.createDiv({ cls: "codex-resource-note", text: `最近检测：${formatSetupTime(hermes.lastConnectedAt)}${hermes.version ? ` · ${hermes.version}` : ""}` });
    }
    if (hermes.lastProviderCheckAt) {
      hermesSection.createDiv({
        cls: hermes.providerConfigured ? "codex-resource-note" : "codex-resource-error",
        text: hermes.providerConfigured
          ? `推理 provider 已验证：${formatSetupTime(hermes.lastProviderCheckAt)}`
          : `推理 provider 未通过：${hermes.lastProviderError || "未配置"}`
      });
    }
    if (hermes.lastError) hermesSection.createDiv({ cls: "codex-resource-error", text: hermes.lastError });
    this.addProviderText(hermesSection, "Hermes CLI 路径", hermes.cliPath, "~/.local/bin/hermes", async (value) => {
      hermes.cliPath = value.trim();
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
      await this.detectAllAgents(true);
    });
    this.addProviderText(hermesSection, "API Server URL", hermes.serverUrl, "http://127.0.0.1:8642/v1", async (value) => {
      hermes.serverUrl = value.trim().replace(/\/$/, "");
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.decorateSetting(new Setting(hermesSection).setName("自动启动 Hermes").setDesc("第一版只记录偏好；正式启动优先使用 API server，CLI one-shot 只做兜底。").addToggle((toggle) =>
      toggle.setValue(hermes.autoStart).onChange(async (value) => {
        hermes.autoStart = value;
        this.invalidateAgentSetupReadiness("hermes");
        await this.plugin.saveSettings();
      })
    ), "power");
    this.addProviderText(hermesSection, "Host", hermes.hostname, "127.0.0.1", async (value) => {
      hermes.hostname = value.trim() || "127.0.0.1";
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.addProviderText(hermesSection, "Port", String(hermes.port), "8642", async (value) => {
      hermes.port = parseClampedInteger(value, 8642, 1024, 65535);
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.addProviderText(hermesSection, "Profile", hermes.profile, "default", async (value) => {
      hermes.profile = value.trim();
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.addProviderText(hermesSection, "Provider", hermes.providerId, "deepseek", async (value) => {
      hermes.providerId = value.trim();
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.addProviderText(hermesSection, "Model", hermes.modelId, "deepseek-chat", async (value) => {
      hermes.modelId = value.trim();
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    });
    this.addProviderText(hermesSection, "API Server Key", hermes.apiKey, "API_SERVER_KEY", async (value) => {
      hermes.apiKey = value.trim();
      this.invalidateAgentSetupReadiness("hermes");
      await this.plugin.saveSettings();
    }, "password");
    hermesSection.createDiv({
      cls: "codex-resource-note",
      text: "DeepSeek 等第三方 provider 仍建议先用 Hermes 官方 hermes model / ~/.hermes/.env 配置；插件会用最小 prompt 验证 provider 是否真的可用。"
    });
    const hermesActions = hermesSection.createDiv({ cls: "codex-api-provider-actions" });
    const testHermes = hermesActions.createEl("button", { cls: "codex-resource-tab", text: "检测 Hermes", attr: { type: "button" } });
    testHermes.onclick = () => void this.connectAgent("hermes");
    const copyHermesModel = hermesActions.createEl("button", { cls: "codex-resource-tab", text: "复制 hermes model", attr: { type: "button" } });
    copyHermesModel.onclick = async () => {
      await navigator.clipboard?.writeText("hermes model").catch(swallowError("copy Hermes model command"));
      new Notice("已复制：hermes model");
    };
  }

  private renderOpenCodeAgentSettings(container: HTMLElement): void {
    const copy = this.copy;
    const opencode = this.plugin.settings.opencode;
    container.createDiv({ cls: "codex-resource-note", text: copy.knowledge.detection(detectOpenCodePath(opencode.cliPath, copy)) });
    this.addProviderText(container, copy.knowledge.opencodePath, opencode.cliPath, "/opt/homebrew/bin/opencode", async (value) => {
      opencode.cliPath = value.trim();
      this.plugin.settings.agents.opencode = opencode;
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
      await this.detectAllAgents(true);
    });
    this.addProviderText(container, copy.knowledge.serverUrl, opencode.serverUrl, "http://127.0.0.1:4096", async (value) => {
      opencode.serverUrl = value.trim().replace(/\/$/, "");
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
    });
    this.decorateSetting(new Setting(container).setName(copy.knowledge.autoStartServer).addToggle((toggle) =>
      toggle.setValue(opencode.autoStart).onChange(async (value) => {
        opencode.autoStart = value;
        this.invalidateAgentSetupReadiness("opencode");
        await this.plugin.saveSettings();
      })
    ), "power");
    this.addProviderText(container, copy.opencode.host, opencode.hostname, "127.0.0.1", async (value) => {
      opencode.hostname = value.trim() || "127.0.0.1";
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
    });
    this.addProviderText(container, copy.opencode.port, String(opencode.port), "4096", async (value) => {
      opencode.port = parseClampedInteger(value, 4096, 1024, 65535);
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
    });
    this.addOpenCodeModelPicker(container);
    this.addProviderText(container, copy.opencode.providerId, opencode.providerId, "anthropic", async (value) => {
      opencode.providerId = value.trim();
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
    });
    this.addProviderText(container, copy.opencode.modelId, opencode.modelId, "claude-sonnet-4-20250514", async (value) => {
      opencode.modelId = value.trim();
      this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings();
    });
    this.addOpenCodeAgentPicker(container);
    if (opencode.lastError) container.createDiv({ cls: "codex-resource-error", text: opencode.lastError });
    const actions = container.createDiv({ cls: "codex-api-provider-actions" });
    const testOpenCode = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.testConnection, attr: { type: "button" } });
    testOpenCode.onclick = () => void this.connectAgent("opencode");
  }

  private renderGeneralSettings(containerEl: HTMLElement, status: CodexStatusSnapshot | null): void {
    const copy = this.copy;
    this.decorateSetting(new Setting(containerEl).setName(copy.general.settingsLanguage).setDesc(copy.general.settingsLanguageDesc).addDropdown((dropdown) => {
      for (const language of SETTINGS_LANGUAGE_OPTIONS) dropdown.addOption(language, copy.general.languageOptions[language]);
      dropdown.setValue(this.plugin.settings.settingsLanguage);
      dropdown.onChange(async (value) => {
        this.plugin.settings.settingsLanguage = normalizeSettingsLanguage(value);
        await this.plugin.saveSettings(true);
        this.scheduleDisplay();
      });
    }), "languages");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.autoOpen).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
        this.plugin.settings.autoOpen = value;
        await this.plugin.saveSettings();
      })
    ), "panel-right-open");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.autoOpenHome).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoOpenHome).onChange(async (value) => {
        this.plugin.settings.autoOpenHome = value;
        await this.plugin.saveSettings();
      })
    ), "layout-dashboard");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.showContext).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showContext).onChange(async (value) => {
        this.plugin.settings.showContext = value;
        await this.plugin.saveSettings();
      })
    ), "pie-chart");
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.knowledgeBase;
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager codex-knowledge-settings" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "library");
    title.createSpan({ text: copy.knowledge.title });

    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: copy.knowledge.safety
    });

    const summary = wrapper.createDiv({ cls: "codex-api-provider-row" });
    summary.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.statusHeading });
    summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.recentStatus(knowledgeStatusLabel(settings.lastRunStatus, copy), settings.lastRunAt ? new Date(settings.lastRunAt).toLocaleString() : "") });
    if (settings.lastCompletion) {
      summary.createDiv({
        cls: "codex-resource-note",
        text: copy.knowledge.recentCompletion(
          copy.knowledge.completionLabels[settings.lastCompletion],
          settings.lastAttempts?.length ?? 0,
          settings.lastPendingSources?.length ?? 0
        )
      });
    }
    summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.initialization(knowledgeInitStatusLabel(settings.initialization.status, copy), settings.initialization.rulesFilePath) });
    summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.guide(resolveKnowledgeBaseRulesFilePath(settings), true) });
    if (settings.lastReportPath) summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.recentReport(settings.lastReportPath) });
    if (settings.lastError) summary.createDiv({ cls: "codex-resource-error", text: settings.lastError });

    const actions = summary.createDiv({ cls: "codex-api-provider-actions" });
    const openChannel = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.openChannel, attr: { type: "button" } });
    openChannel.onclick = async () => {
      await this.plugin.activateKnowledgeBaseChannel();
      this.scheduleDisplay();
    };
    const initChannel = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.initChannel, attr: { type: "button" } });
    initChannel.onclick = async () => {
      await this.plugin.activateKnowledgeBaseChannel();
      this.plugin.getCodexView()?.fillKnowledgeBaseCommand("/init ");
      this.scheduleDisplay();
    };

    this.addKnowledgeBaseCommandGuide(wrapper);
    this.addKnowledgeBaseStoragePanel(wrapper);

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.enabled).setDesc(copy.knowledge.enabledDesc).addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.backend).setDesc(copy.knowledge.backendDesc).addDropdown((dropdown) => {
      const options: Record<KnowledgeBaseBackendMode, string> = {
        default: copy.knowledge.followGlobal(agentBackendLabel(this.plugin.settings.agentBackend, copy)),
        "codex-cli": "Codex CLI",
        opencode: "OpenCode API",
        hermes: "Hermes"
      };
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(settings.backend);
      dropdown.onChange(async (value) => {
        settings.backend = normalizeKnowledgeBaseBackendMode(value);
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
    }), "route");

    this.addKnowledgeBaseRulesFilePicker(wrapper);
    this.addKnowledgeBaseMemoryRecommendation(wrapper);

    this.addProviderText(wrapper, copy.knowledge.scheduleTime, settings.scheduleTime, "09:00", async (value) => {
      settings.scheduleTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : settings.scheduleTime;
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    });
    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.catchUp).setDesc(copy.knowledge.catchUpDesc).addToggle((toggle) =>
      toggle.setValue(settings.catchUpOnStartup).onChange(async (value) => {
        settings.catchUpOnStartup = value;
        await this.plugin.saveSettings();
      })
    ), "history");

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: `${copy.knowledge.channelNote} Agent 连接、模型、profile 和 provider 请在 Agent 设置页统一配置。`
    });
  }

  private addKnowledgeBaseCommandGuide(container: HTMLElement): void {
    const copy = this.copy;
    const section = container.createDiv({ cls: "codex-api-provider-row codex-kb-command-guide" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.commandHeading });
    for (const item of copy.knowledge.commandGuide) {
      const row = section.createDiv({ cls: "codex-kb-command-row" });
      row.createEl("code", { text: item.command });
      row.createSpan({ text: item.description });
    }
  }

  private addKnowledgeBaseStoragePanel(container: HTMLElement): void {
    const copy = this.copy;
    const section = container.createDiv({ cls: "codex-api-provider-row codex-kb-storage-panel" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.storageHeading });
    const statsEl = section.createDiv({ cls: "codex-resource-note", text: copy.knowledge.storageLoading });
    void this.plugin.getKnowledgeBaseStorageStats()
      .then((stats) => {
        statsEl.setText(copy.knowledge.storageStats(
          formatStorageBytes(stats.dataJsonBytes),
          formatStorageBytes(stats.historyBytes),
          formatStorageBytes(stats.rawBytes),
          stats.messageCount,
          stats.dayCount
        ));
      })
      .catch((error) => {
        statsEl.setText(copy.common.readFailed(error instanceof Error ? error.message : String(error)));
      });
    this.decorateSetting(new Setting(section)
      .setName(copy.knowledge.retentionDays)
      .setDesc(copy.knowledge.retentionDaysDesc)
      .addDropdown((dropdown) => {
        const options = [7, 30, 90, 0];
        for (const days of options) {
          dropdown.addOption(String(days), days === 0 ? copy.knowledge.retentionForever : copy.knowledge.retentionDaysOption(days));
        }
        dropdown.setValue(String(this.plugin.settings.knowledgeBase.historyRetentionDays));
        dropdown.onChange(async (value) => {
          this.plugin.settings.knowledgeBase.historyRetentionDays = normalizeKnowledgeBaseHistoryRetentionDays(value, DEFAULT_SETTINGS.knowledgeBase.historyRetentionDays);
          await this.plugin.saveSettings();
          this.scheduleDisplay();
        });
      }), "calendar-clock");
    const actions = section.createDiv({ cls: "codex-api-provider-actions" });
    const rebuild = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.rebuildHistory, attr: { type: "button" } });
    rebuild.onclick = async () => {
      rebuild.disabled = true;
      await this.plugin.rebuildKnowledgeBaseHistoryIndex();
      new Notice(copy.knowledge.historyRebuilt);
      this.scheduleDisplay();
    };
    const exportButton = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.exportHistory, attr: { type: "button" } });
    exportButton.onclick = async () => {
      exportButton.disabled = true;
      const exported = await this.plugin.exportKnowledgeBaseHistory();
      new Notice(copy.knowledge.historyExported(exported));
      this.scheduleDisplay();
    };
    const compact = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.compactHistory, attr: { type: "button" } });
    compact.onclick = async () => {
      const accepted = await confirmModal(this.app, copy.knowledge.compactHistory, "只压缩旧日期的过程记录，不删除用户与助手正文。", "压缩", "取消");
      if (!accepted) return;
      compact.disabled = true;
      const count = await this.plugin.compactOldKnowledgeBaseProcessHistory();
      new Notice(copy.knowledge.historyCompacted(count));
      this.scheduleDisplay();
    };
    const prune = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.pruneHistory, attr: { type: "button" } });
    prune.onclick = async () => {
      const accepted = await confirmModal(this.app, copy.knowledge.pruneHistory, copy.knowledge.retentionDaysDesc, copy.knowledge.pruneHistory, "取消");
      if (!accepted) return;
      prune.disabled = true;
      const result = await this.plugin.pruneKnowledgeBaseHistoryByRetention();
      new Notice(copy.knowledge.historyPruned(result.removedDayCount, result.removedMessageCount));
      this.scheduleDisplay();
    };
    const deleteDate = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.deleteHistoryDate, attr: { type: "button" } });
    deleteDate.onclick = async () => {
      const input = await textInputModal(this.app, copy.knowledge.deleteHistoryDate, copy.knowledge.deleteHistoryDatePrompt);
      if (!input) return;
      const dates = parseHistoryDateSelection(input);
      if (!dates.length) {
        new Notice(copy.knowledge.deleteHistoryDateInvalid);
        return;
      }
      deleteDate.disabled = true;
      const result = await this.plugin.removeKnowledgeBaseHistoryDays(dates);
      new Notice(copy.knowledge.historyPruned(result.removedDayCount, result.removedMessageCount));
      this.scheduleDisplay();
    };
    const clear = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.clearHistory, attr: { type: "button" } });
    clear.onclick = async () => {
      const accepted = await confirmModal(this.app, copy.knowledge.clearHistory, copy.knowledge.clearHistoryConfirm, copy.knowledge.clearHistory, "取消");
      if (!accepted) return;
      clear.disabled = true;
      const result = await this.plugin.removeKnowledgeBaseHistory();
      new Notice(copy.knowledge.historyCleared(result.removedDayCount, result.removedMessageCount));
      this.scheduleDisplay();
    };
  }

  private renderReviewSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager codex-review-settings" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "bar-chart-3");
    title.createSpan({ text: copy.review.title });

    const summary = wrapper.createDiv({ cls: "codex-api-provider-row" });
    summary.createDiv({ cls: "codex-editor-actions-heading", text: copy.review.generateHeading });
    const actions = summary.createDiv({ cls: "codex-api-provider-actions" });
    this.addReviewAction(actions, copy.review.generateAgent, "agent-chat");
    this.addReviewAction(actions, copy.review.generateKnowledge, "knowledge-base");

    const paths = wrapper.createDiv({ cls: "codex-api-provider-row" });
    paths.createDiv({ cls: "codex-editor-actions-heading", text: copy.review.pathsHeading });
    this.addProviderText(paths, copy.review.outputDir, settings.outputDir, DEFAULT_SETTINGS.review.outputDir, async (value) => {
      settings.outputDir = normalizeReviewOutputDir(value, DEFAULT_SETTINGS.review.outputDir);
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    });
    this.addReviewPath(paths, copy.review.knowledgeMarkdown, settings.reports.knowledgeBase.lastMarkdownPath);
    this.addReviewPath(paths, copy.review.knowledgeHtml, settings.reports.knowledgeBase.lastHtmlPath);
    this.addReviewPath(paths, copy.review.agentMarkdown, settings.reports.agentChat.lastMarkdownPath);
    this.addReviewPath(paths, copy.review.agentHtml, settings.reports.agentChat.lastHtmlPath);

    const reviewOptions = wrapper.createDiv({ cls: "codex-api-provider-row" });
    reviewOptions.createDiv({ cls: "codex-editor-actions-heading", text: copy.review.settingsHeading });
    this.addReviewRangeMode(reviewOptions);
    this.addReviewOpenAfterRun(reviewOptions);
  }

  private addReviewPath(container: HTMLElement, label: string, value: string): void {
    if (!value) return;
    container.createDiv({ cls: "codex-resource-note", text: `${label}：${value}` });
  }

  private addReviewAction(container: HTMLElement, label: string, kind: ReviewReportKind): void {
    const copy = this.copy;
    const button = container.createEl("button", { cls: "codex-resource-tab", text: label, attr: { type: "button" } });
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
      button.disabled = true;
      await this.plugin.getReviewManager()?.runReview(kind);
      this.scheduleDisplay();
    };
  }

  private addReviewRangeMode(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.review;
    this.decorateSetting(new Setting(container).setName(copy.review.rangeMode).addDropdown((dropdown) => {
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
    this.decorateSetting(new Setting(container).setName(copy.review.openHtmlAfterRun).addToggle((toggle) =>
      toggle.setValue(settings.openHtmlAfterRun).onChange(async (value) => {
        settings.openHtmlAfterRun = value;
        await this.plugin.saveSettings();
      })
    ), "panel-right-open");
  }

  private shouldShowSetupGuide(): boolean {
    return this.plugin.settings.setup.completedAt <= 0;
  }

  /**
   * Reconciles the in-memory dashboard with synchronously discoverable CLI paths.
   * This deliberately does not execute a CLI, start a server, or run a probe. The
   * last trusted connection result remains visible until an explicit repair,
   * configuration change, enable action, or runtime availability error replaces it.
   */
  private reconcileAgentSetupSnapshotsForDisplay(): void {
    const commands: Record<AgentBackendMode, string | null> = {
      "codex-cli": detectCodexCommand(this.plugin.settings.cliPath),
      opencode: detectOpenCodeCommand(this.plugin.settings.opencode.cliPath),
      hermes: detectHermesCommand(this.plugin.settings.agents.hermes.cliPath)
    };
    const checkedAtByBackend: Record<AgentBackendMode, number> = {
      "codex-cli": this.plugin.settings.setup.lastCheckedAt,
      opencode: this.plugin.settings.opencode.lastConnectedAt || this.plugin.settings.setup.lastCheckedAt,
      hermes: this.plugin.settings.agents.hermes.lastProviderCheckAt
        || this.plugin.settings.agents.hermes.lastConnectedAt
        || this.plugin.settings.setup.lastCheckedAt
    };

    for (const backend of ["codex-cli", "opencode", "hermes"] as const) {
      const previous = this.setupSnapshots[backend];
      const command = commands[backend];
      const observedCommand = this.setupObservedCommands[backend];
      const activeOperation = this.setupBusy
        && ((this.setupActiveBackend === backend
          && (previous.phase === "installing"
          || previous.phase === "authorizing"
          || previous.phase === "connecting"))
          || (this.setupActiveBackend === null && previous.phase === "detecting"));
      const observation = resolveAgentCommandObservation(observedCommand, command, activeOperation);
      if (observation.deferred) continue;
      const commandChanged = observation.changed;
      this.setupObservedCommands[backend] = observation.nextObserved;
      if (!command) {
        if (previous.command || commandChanged) {
          this.clearAgentSetupVerification(backend);
          this.setupCommandsAwaitingVerification.delete(backend);
          this.plugin.agentRuntimeHealth.reset(backend);
        }
        this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "missing", {
          detail: this.copy.setup.agentInstaller.detection.cliMissing(this.copy.setup.agentInstaller.agents[backend].label),
          checkedAt: checkedAtByBackend[backend]
        });
        continue;
      }

      if (commandChanged) {
        this.clearAgentSetupVerification(backend);
        this.setupCommandsAwaitingVerification.add(backend);
        this.plugin.agentRuntimeHealth.reset(backend);
        this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "installed", {
          command,
          detail: this.copy.setup.agentInstaller.detection.cliInstalled
        });
        continue;
      }

      if (this.setupCommandsAwaitingVerification.has(backend)) {
        const activeOperation = this.setupBusy && (previous.phase === "detecting"
          || previous.phase === "installing"
          || previous.phase === "authorizing"
          || previous.phase === "connecting");
        if (activeOperation
          || previous.phase === "failed"
          || previous.phase === "cancelled"
          || previous.phase === "needs-auth") {
          this.setupSnapshots[backend] = previous;
        } else {
          this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "installed", {
            command,
            detail: this.copy.setup.agentInstaller.detection.cliInstalled
          });
        }
        continue;
      }

      const availabilityError = this.agentRuntimeAvailabilityError(backend);
      const runtimeHealth = this.plugin.agentRuntimeHealth.get(backend);
      const checkedAt = previous.checkedAt || checkedAtByBackend[backend];
      const version = !commandChanged && previous.version
        ? previous.version
        : backend === "hermes"
          ? this.plugin.settings.agents.hermes.version || null
          : null;
      if (availabilityError) {
        this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "failed", {
          command,
          version,
          detail: this.copy.setup.agentInstaller.dashboard.description.failed,
          error: availabilityError,
          lastAction: "connect",
          checkedAt
        });
        continue;
      }

      const recoveredAfterFailure = previous.phase === "failed"
        && !runtimeHealth.unavailable
        && runtimeHealth.updatedAt > previous.checkedAt;
      if (previous.phase === "failed" && !recoveredAfterFailure) {
        this.setupSnapshots[backend] = { ...previous, command };
        continue;
      }

      if (backend === "codex-cli" && this.plugin.codex?.isConnected() && this.plugin.lastStatus?.connected) {
        const phase = this.plugin.lastStatus.loggedIn ? "ready" : "needs-auth";
        this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, phase, {
          command,
          version,
          detail: this.plugin.lastStatus.loggedIn
            ? this.copy.setup.agentInstaller.connection.codexReady
            : this.copy.setup.agentInstaller.connection.codexNeedsAuth,
          checkedAt
        });
        continue;
      }

      const canKeepPrevious = !commandChanged
        && previous.command === command
        && previous.phase !== "detecting"
        && previous.phase !== "installing"
        && previous.phase !== "authorizing"
        && previous.phase !== "connecting"
        && previous.phase !== "failed";
      if (canKeepPrevious) {
        this.setupSnapshots[backend] = {
          ...previous,
          command,
          checkedAt
        };
        continue;
      }

      let phase: "installed" | "needs-auth" | "ready" = "installed";
      if (backend === "codex-cli") {
        if (this.plugin.settings.setup.completedAt > 0 && backend === this.plugin.settings.agentBackend) phase = "ready";
      } else if (backend === "opencode") {
        if (this.plugin.settings.opencode.lastConnectedAt > 0) phase = "ready";
      } else {
        const hermes = this.plugin.settings.agents.hermes;
        if (hermes.providerConfigured && hermes.lastProviderCheckAt > 0) phase = "ready";
        else if (hermes.lastConnectedAt > 0 || hermes.lastProviderCheckAt > 0) phase = "needs-auth";
      }
      this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, phase, {
        command,
        version,
        detail: this.copy.setup.agentInstaller.dashboard.description[phase],
        checkedAt
      });
    }
  }

  private agentRuntimeAvailabilityError(backend: AgentBackendMode): string {
    const runtimeHealth = this.plugin.agentRuntimeHealth.get(backend);
    if (runtimeHealth.unavailable) return runtimeHealth.error;
    if (backend === "codex-cli") {
      if (this.plugin.codex && !this.plugin.codex.isConnected() && this.plugin.lastStatus?.connected) {
        return this.plugin.settings.settingsLanguage === "en"
          ? "The Codex process disconnected."
          : "Codex 进程已断开。";
      }
      const error = this.plugin.lastStatus?.errors.join("\n") ?? "";
      return isAgentRuntimeAvailabilityError(error, { source: "persisted", backend }) ? error : "";
    }
    const error = backend === "opencode"
      ? this.plugin.settings.opencode.lastError
      : this.plugin.settings.agents.hermes.lastError;
    return isAgentRuntimeAvailabilityError(error, { source: "persisted", backend }) ? error : "";
  }

  private renderAgentDashboard(container: HTMLElement): void {
    container.addClass("codex-settings-status--dashboard");
    const copy = this.copy.setup.agentInstaller;
    const dashboardCopy = copy.dashboard;
    const selected = this.setupSnapshots[this.setupSelectedBackend];
    const selectedState = resolveAgentSetupDashboardState(selected);
    const installConfirming = selectedState.status === "missing"
      && this.setupInstallConfirmBackend === this.setupSelectedBackend;
    const dashboardBusy = this.isAgentDashboardBusy();
    const definitions = this.agentDashboardDefinitions();
    const selectedDefinition = definitions.find((item) => item.backend === this.setupSelectedBackend) ?? definitions[0];
    const selectedStatusLabel = selected.progress
      ? dashboardCopy.installFlow.progressAria(
        dashboardCopy.installFlow.step[selected.progress.stage],
        selected.progress.step,
        selected.progress.total
      )
      : dashboardCopy.status[selectedState.status];
    const selectedEnabled = !this.shouldShowSetupGuide()
      && selected.backend === this.plugin.settings.agentBackend;
    const liveText = dashboardCopy.tabAria(
      selectedDefinition.label,
      selectedStatusLabel,
      selectedEnabled,
      selectedState.installed
    );
    if (liveText !== this.settingsAgentLiveText) {
      this.settingsAgentLiveText = liveText;
      this.settingsAgentLiveEl?.setText(liveText);
    }
    const isProgressing = selectedState.status === "installing"
      || selectedState.status === "authorizing"
      || selectedState.status === "connecting";
    const root = container.createDiv({
      cls: [
        "codex-agent-dashboard",
        `is-${selectedState.tone}`,
        dashboardBusy ? "is-busy" : "",
        isProgressing ? "is-progressing" : ""
      ].filter(Boolean).join(" "),
      attr: {
        "aria-busy": dashboardBusy ? "true" : "false"
      }
    });
    const header = root.createDiv({ cls: "codex-agent-dashboard-header" });
    header.createDiv({
      cls: "codex-setup-heading",
      text: this.shouldShowSetupGuide() ? dashboardCopy.firstRunHeading : copy.compactHeading
    });
    header.createDiv({
      cls: "codex-setup-subtitle",
      text: this.shouldShowSetupGuide() ? dashboardCopy.firstRunSubtitle : copy.subtitle
    });

    const tabList = root.createDiv({
      cls: "codex-agent-dashboard-tabs",
      attr: { role: "tablist", "aria-label": dashboardCopy.ariaLabel }
    });
    for (const definition of definitions) {
      const snapshot = this.setupSnapshots[definition.backend];
      const state = resolveAgentSetupDashboardState(snapshot);
      const isSelected = definition.backend === this.setupSelectedBackend;
      const isEnabled = !this.shouldShowSetupGuide()
        && definition.backend === this.plugin.settings.agentBackend;
      const isDisconnected = isEnabled
        && !state.busy
        && state.status !== "ready";
      const isWorking = isEnabled && state.busy;
      const statusLabel = dashboardCopy.status[state.status];
      const tab = tabList.createEl("button", {
        cls: [
          "codex-agent-dashboard-tab",
          `is-${state.tone}`,
          isSelected ? "is-selected" : "",
          isEnabled ? "is-enabled" : "",
          isDisconnected ? "is-disconnected" : "",
          isWorking ? "is-working" : "",
          state.installed ? "is-installed" : ""
        ].filter(Boolean).join(" "),
        attr: {
          id: this.agentDashboardTabId(definition.backend),
          type: "button",
          role: "tab",
          tabindex: isSelected ? "0" : "-1",
          "aria-selected": isSelected ? "true" : "false",
          "aria-controls": this.agentDashboardPanelId(definition.backend),
          "aria-label": dashboardCopy.tabAria(definition.label, statusLabel, isEnabled, state.installed)
        }
      });
      tab.disabled = dashboardBusy && !isSelected;
      tab.createSpan({ cls: "codex-agent-dashboard-dot", attr: { "aria-hidden": "true" } });
      tab.createSpan({ cls: "codex-agent-dashboard-tab-label", text: definition.label });
      const installCheck = tab.createSpan({
        cls: "codex-agent-dashboard-install-check",
        attr: { "aria-hidden": "true" }
      });
      if (state.installed) setIcon(installCheck, "check");
      tab.onclick = () => this.selectAgentDashboardBackend(definition.backend, true);
      tab.onfocus = () => {
        this.setupTabFocusTarget = definition.backend;
      };
      tab.onkeydown = (event) => this.handleAgentDashboardKeydown(event, definition.backend);
    }

    for (const definition of definitions) {
      if (definition.backend === this.setupSelectedBackend) continue;
      root.createDiv({
        cls: "codex-agent-dashboard-panel",
        attr: {
          id: this.agentDashboardPanelId(definition.backend),
          role: "tabpanel",
          hidden: "true",
          "aria-labelledby": this.agentDashboardTabId(definition.backend)
        }
      });
    }

    const panel = root.createDiv({
      cls: "codex-agent-dashboard-panel",
      attr: {
        id: this.agentDashboardPanelId(this.setupSelectedBackend),
        role: "tabpanel",
        tabindex: "0",
        "aria-labelledby": this.agentDashboardTabId(this.setupSelectedBackend),
        "aria-label": dashboardCopy.panelAria(selectedDefinition.label)
      }
    });
    const detail = panel.createDiv({ cls: "codex-agent-dashboard-detail" });
    const detailHeader = detail.createDiv({ cls: "codex-agent-dashboard-detail-header" });
    const detailCopy = detailHeader.createDiv({ cls: "codex-agent-dashboard-detail-copy" });
    const detailTitle = installConfirming
      ? dashboardCopy.installFlow.confirmTitle(selectedDefinition.label)
      : this.agentDashboardDetailTitle(selected, selectedDefinition.label);
    const detailDescription = installConfirming
      ? dashboardCopy.installFlow.confirmDescription
      : selectedState.status === "missing"
        ? dashboardCopy.installFlow.missingDescription
        : selected.detail || dashboardCopy.description[selectedState.status];
    detailCopy.createDiv({ cls: "codex-agent-dashboard-title", text: detailTitle });
    detailCopy.createDiv({
      cls: "codex-agent-dashboard-description",
      text: detailDescription
    });
    if (selectedState.status === "ready") {
      const enable = detailHeader.createEl("button", {
        cls: `codex-agent-dashboard-enable${selectedEnabled ? " is-on" : ""}`,
        attr: {
          type: "button",
          role: "switch",
          "aria-checked": selectedEnabled ? "true" : "false",
          "aria-label": `${dashboardCopy.enable} ${selectedDefinition.label}`,
          "data-agent-dashboard-action": "primary"
        }
      });
      enable.createSpan({ text: dashboardCopy.enable });
      const track = enable.createSpan({ cls: "codex-agent-dashboard-enable-track", attr: { "aria-hidden": "true" } });
      track.createSpan({ cls: "codex-agent-dashboard-enable-thumb" });
      const enabledAndReady = selectedEnabled && selectedState.status === "ready";
      enable.disabled = dashboardBusy || enabledAndReady;
      enable.onclick = async () => {
        if (this.isAgentDashboardBusy() || enabledAndReady) return;
        const backend = this.setupSelectedBackend;
        const sessionGeneration = this.setupSessionGeneration;
        if (!this.isAgentSetupVerificationCurrent(backend)) {
          await this.connectAgent(backend, sessionGeneration);
        }
        if (!this.isSetupSessionCurrent(sessionGeneration)) return;
        const current = this.setupSnapshots[backend];
        if (current.phase === "ready" && this.isAgentSetupVerificationCurrent(backend)) {
          await this.completeAgentSetup();
        }
      };
    } else {
      const actionButton = detailHeader.createEl("button", {
        cls: [
          "codex-agent-dashboard-action",
          "is-header-action",
          selectedState.status === "missing" ? "is-primary" : ""
        ].filter(Boolean).join(" "),
        text: this.agentDashboardPrimaryLabel(selected, selectedDefinition.label),
        attr: {
          type: "button",
          "data-agent-dashboard-action": "primary"
        }
      });
      const actionDisabled = selectedState.primaryAction === null
        || (this.setupBusy && selectedState.primaryAction !== "cancel");
      actionButton.setAttr("aria-disabled", actionDisabled ? "true" : "false");
      actionButton.onclick = () => {
        if (actionDisabled || !selectedState.primaryAction) return;
        actionButton.disabled = true;
        actionButton.setAttr("aria-disabled", "true");
        void this.runAgentSetupAction(
          selectedState.primaryAction,
          selectedState.retryTarget,
          installConfirming
        );
      };
    }

    if (installConfirming || selectedState.status === "installing") {
      this.renderAgentInstallFlow(detail, selected, selectedDefinition.label, installConfirming);
    } else if (selectedState.status === "needs-auth"
      || selectedState.status === "authorizing"
      || selectedState.status === "connecting"
      || selectedState.status === "failed"
      || selectedState.status === "cancelled") {
      this.renderAgentOperationFlow(detail, selected, selectedDefinition.label);
    }

    if (selectedState.installed) {
      const path = detail.createDiv({ cls: "codex-agent-dashboard-path" });
      path.createSpan({ text: dashboardCopy.meta.cliPath });
      path.createEl("code", { text: selected.command || dashboardCopy.meta.unavailable });
      const meta = detail.createDiv({ cls: "codex-agent-dashboard-meta" });
      for (const item of this.agentDashboardMeta(selected)) {
        const row = meta.createDiv({ cls: "codex-agent-dashboard-meta-row" });
        row.createSpan({ cls: "codex-agent-dashboard-meta-label", text: item.label });
        row.createSpan({ cls: "codex-agent-dashboard-meta-value", text: item.value });
      }
    } else {
      this.renderAgentInstallFacts(detail, selected.backend);
    }

    const hideFirstRunDiagnostics = this.shouldShowSetupGuide()
      && selectedState.status !== "failed"
      && selectedState.status !== "cancelled";
    if (!hideFirstRunDiagnostics) {
      const diagnostics = detail.createEl("details", { cls: "codex-agent-dashboard-diagnostics" });
      diagnostics.createEl("summary", { text: dashboardCopy.diagnosticsSummary });
      const diagnosticBody = diagnostics.createDiv({ cls: "codex-agent-dashboard-diagnostics-body" });
      diagnosticBody.createDiv({ text: `${this.copy.status.pluginDir}：${pluginInstallDir(this.plugin)}` });
      if (selected.error) diagnosticBody.createEl("pre", { text: selected.error });
      if (selected.logs) diagnosticBody.createEl("pre", { text: selected.logs });
      const recheck = diagnosticBody.createEl("button", {
        cls: "codex-agent-dashboard-secondary",
        text: dashboardCopy.recheck,
        attr: { type: "button" }
      });
      recheck.disabled = dashboardBusy;
      recheck.onclick = () => {
        if (this.isAgentDashboardBusy()) return;
        this.clearAgentSetupVerification(this.setupSelectedBackend);
        void this.detectAllAgents(true);
      };
    }

    const shouldRenderFallback = selected.phase === "failed"
      || selected.phase === "cancelled";
    const actions = shouldRenderFallback
      ? panel.createDiv({ cls: "codex-agent-dashboard-actions" })
      : null;
    if (actions && shouldRenderFallback) {
      if (selected.backend === "hermes") {
        const fallback = actions.createEl("a", {
          cls: "codex-agent-dashboard-secondary codex-agent-dashboard-fallback",
          text: dashboardCopy.officialDocs,
          href: HERMES_DOCS_URL,
          attr: { target: "_blank", rel: "noopener noreferrer" }
        });
        fallback.onclick = (event) => {
          event.preventDefault();
          void this.openAgentTerminalFallback("hermes");
        };
      } else {
        const fallback = actions.createEl("button", {
          cls: "codex-agent-dashboard-secondary codex-agent-dashboard-fallback",
          text: dashboardCopy.terminalFallback,
          attr: { type: "button" }
        });
        fallback.onclick = () => {
          void this.openAgentTerminalFallback(selected.backend);
        };
      }
    }

    const hideFirstRunAdvanced = this.shouldShowSetupGuide() && !selected.command;
    if (!hideFirstRunAdvanced) this.renderAgentSettings(panel, this.plugin.lastStatus);

    if (this.setupDashboardActionFocusPending) {
      const target = root.querySelector<HTMLElement>("[data-agent-dashboard-action='primary']");
      this.setupDashboardActionFocusPending = false;
      target?.focus();
    } else if (this.setupTabFocusTarget) {
      const target = root.querySelector<HTMLElement>(`#${this.agentDashboardTabId(this.setupTabFocusTarget)}`);
      this.setupTabFocusTarget = null;
      target?.focus();
    }
  }

  private renderAgentInstallFlow(
    container: HTMLElement,
    snapshot: AgentSetupSnapshot,
    label: string,
    confirming: boolean
  ): void {
    const copy = this.copy.setup.agentInstaller;
    const flowCopy = copy.dashboard.installFlow;
    const flow = container.createDiv({
      cls: `codex-agent-dashboard-install-flow${confirming ? " codex-agent-dashboard-install-confirm" : ""}`
    });
    if (confirming) {
      flow.createDiv({ cls: "codex-agent-dashboard-install-flow-title", text: flowCopy.confirmFlowTitle });
      flow.createDiv({
        cls: "codex-agent-dashboard-install-flow-copy",
        text: snapshot.backend === "hermes"
          ? copy.install.confirmHermes
          : copy.install.confirmNpm(
            label,
            snapshot.backend === "opencode" ? copy.install.userDirectory : copy.install.globalNpmDirectory
          )
      });
      const safety = flow.createDiv({ cls: "codex-agent-dashboard-install-safety" });
      safety.createSpan({ cls: "codex-agent-dashboard-install-safety-mark", text: "✓", attr: { "aria-hidden": "true" } });
      safety.createSpan({ text: flowCopy.safety });
      const back = flow.createEl("button", {
        cls: "codex-agent-dashboard-secondary",
        text: flowCopy.back,
        attr: { type: "button" }
      });
      back.onclick = () => {
        this.setupInstallConfirmBackend = null;
        this.setupDashboardActionFocusPending = true;
        this.scheduleDisplay();
      };
      return;
    }

    const progress = snapshot.progress ?? {
      stage: "checking-environment",
      step: 1,
      total: 3
    } satisfies AgentSetupProgress;
    const progressLabel = flowCopy.step[progress.stage];
    flow.createDiv({
      cls: "codex-agent-dashboard-install-flow-title",
      text: flowCopy.progressTitle(progress.step, progress.total)
    });
    flow.createDiv({ cls: "codex-agent-dashboard-install-flow-copy", text: flowCopy.progressDescription });
    const progressBar = flow.createDiv({
      cls: `codex-agent-dashboard-install-progress is-step-${progress.step}`,
      attr: {
        role: "progressbar",
        "aria-valuemin": "1",
        "aria-valuemax": String(snapshot.progress?.total ?? progress.total),
        "aria-valuenow": String(snapshot.progress?.step ?? progress.step),
        "aria-valuetext": flowCopy.progressAria(progressLabel, progress.step, progress.total)
      }
    });
    progressBar.createDiv({ cls: "codex-agent-dashboard-install-progress-fill" });
    const steps = flow.createEl("ol", { cls: "codex-agent-dashboard-install-steps" });
    AGENT_SETUP_PROGRESS_STAGES.forEach((stage, index) => {
      const stepNumber = index + 1;
      const item = steps.createEl("li", {
        cls: [
          "codex-agent-dashboard-install-step",
          stepNumber < progress.step ? "is-complete" : "",
          stepNumber === progress.step ? "is-current" : ""
        ].filter(Boolean).join(" ")
      });
      const mark = item.createSpan({
        cls: "codex-agent-dashboard-install-step-mark",
        text: String(stepNumber),
        attr: { "aria-hidden": "true" }
      });
      if (stepNumber < progress.step) {
        mark.empty();
        setIcon(mark, "check");
      }
      item.createSpan({ text: flowCopy.step[stage] });
    });
  }

  private agentDashboardDetailTitle(snapshot: AgentSetupSnapshot, label: string): string {
    const copy = this.copy.setup.agentInstaller.dashboard;
    if (snapshot.phase === "missing") return copy.installFlow.missingTitle(label);
    if (snapshot.phase === "installing") return copy.installFlow.installingTitle(label);
    if (snapshot.phase === "needs-auth") return copy.installFlow.needsAuthTitle(label);
    if (snapshot.phase === "authorizing") return copy.installFlow.authorizingTitle(label);
    if (snapshot.phase === "connecting") return copy.installFlow.connectingTitle(label);
    if (snapshot.phase === "failed") return copy.installFlow.failedTitle(label);
    if (snapshot.phase === "cancelled") return copy.installFlow.cancelledTitle(label);
    return copy.title[snapshot.phase];
  }

  private renderAgentOperationFlow(
    container: HTMLElement,
    snapshot: AgentSetupSnapshot,
    label: string
  ): void {
    const copy = this.copy.setup.agentInstaller.dashboard.installFlow;
    let title = "";
    let description = "";
    let tone = "";
    let indeterminate = false;
    if (snapshot.phase === "needs-auth") {
      title = copy.authorizationReadyTitle(label);
      description = copy.authorizationReadyDescription;
      tone = " is-attention";
    } else if (snapshot.phase === "authorizing") {
      title = copy.authorizingFlowTitle;
      description = copy.authorizingFlowDescription;
      indeterminate = true;
    } else if (snapshot.phase === "connecting") {
      title = copy.connectingFlowTitle;
      description = copy.connectingFlowDescription;
      indeterminate = true;
    } else if (snapshot.phase === "failed") {
      title = copy.failedFlowTitle;
      description = copy.failedFlowDescription;
      tone = " is-error";
    } else {
      title = copy.cancelledFlowTitle;
      description = snapshot.command
        ? copy.cancelledInstalledDescription
        : copy.cancelledMissingDescription;
    }
    const flow = container.createDiv({
      cls: `codex-agent-dashboard-install-flow codex-agent-dashboard-operation-flow${tone}${indeterminate ? " is-indeterminate" : ""}`
    });
    flow.createDiv({ cls: "codex-agent-dashboard-install-flow-title", text: title });
    flow.createDiv({ cls: "codex-agent-dashboard-install-flow-copy", text: description });
    if (indeterminate) {
      const progress = flow.createDiv({
        cls: "codex-agent-dashboard-install-progress is-indeterminate",
        attr: {
          role: "progressbar",
          "aria-label": title
        }
      });
      progress.createDiv({ cls: "codex-agent-dashboard-install-progress-fill" });
    }
  }

  private renderAgentInstallFacts(container: HTMLElement, backend: AgentBackendMode): void {
    const copy = this.copy.setup.agentInstaller.dashboard.installFlow;
    const facts = container.createDiv({ cls: "codex-agent-dashboard-install-facts" });
    const rows = [
      { label: copy.fact.source, value: copy.source[backend], code: true },
      { label: copy.fact.location, value: copy.location[backend], code: false },
      { label: copy.fact.next, value: copy.next[backend], code: false }
    ];
    for (const row of rows) {
      const item = facts.createDiv({ cls: "codex-agent-dashboard-install-fact" });
      item.createSpan({ cls: "codex-agent-dashboard-meta-label", text: row.label });
      if (row.code) item.createEl("code", { text: row.value });
      else item.createSpan({ cls: "codex-agent-dashboard-meta-value", text: row.value });
    }
  }

  private agentDashboardDefinitions(): Array<{ backend: AgentBackendMode; label: string; description: string }> {
    const agents = this.copy.setup.agentInstaller.agents;
    return [
      { backend: "codex-cli", ...agents["codex-cli"] },
      { backend: "opencode", ...agents.opencode },
      { backend: "hermes", ...agents.hermes }
    ];
  }

  private agentDashboardTabId(backend: AgentBackendMode): string {
    return `codex-agent-dashboard-tab-${backend}`;
  }

  private agentDashboardPanelId(backend: AgentBackendMode): string {
    return `codex-agent-dashboard-panel-${backend}`;
  }

  private isAgentDashboardBusy(): boolean {
    return this.setupBusy || Object.values(this.setupSnapshots).some((snapshot) => resolveAgentSetupDashboardState(snapshot).busy);
  }

  private selectAgentDashboardBackend(backend: AgentBackendMode, focus = false): void {
    if (this.isAgentDashboardBusy()) return;
    this.setupDashboardActionFocusPending = false;
    if (focus) this.setupTabFocusTarget = backend;
    if (backend === this.setupSelectedBackend) return;
    this.setupInstallConfirmBackend = null;
    this.setupSelectedBackend = backend;
    this.scheduleDisplay();
  }

  private handleAgentDashboardKeydown(event: KeyboardEvent, backend: AgentBackendMode): void {
    if (event.key === "Tab") {
      this.setupTabFocusTarget = null;
      return;
    }
    if (this.isAgentDashboardBusy()) return;
    const backends = this.agentDashboardDefinitions().map((item) => item.backend);
    const currentIndex = Math.max(0, backends.indexOf(backend));
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % backends.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + backends.length) % backends.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = backends.length - 1;
    else return;
    event.preventDefault();
    this.selectAgentDashboardBackend(backends[nextIndex], true);
  }

  private agentDashboardMeta(snapshot: AgentSetupSnapshot): Array<{ label: string; value: string }> {
    const copy = this.copy.setup.agentInstaller.dashboard.meta;
    const unavailable = copy.unavailable;
    const rows: Array<{ label: string; value: string }> = [];
    rows.push({ label: copy.version, value: snapshot.version || unavailable });
    if (snapshot.backend === "codex-cli") {
      const status = this.plugin.lastStatus;
      rows.push({ label: copy.account, value: status?.loggedIn ? (status.accountLabel || this.copy.common.connected) : unavailable });
    } else if (snapshot.backend === "opencode") {
      const settings = this.plugin.settings.opencode;
      const agent = settings.agent ? ` · ${settings.agent}` : "";
      rows.push({
        label: copy.providerModel,
        value: resolveAgentSetupProviderModelLabel({
          providerId: settings.providerId,
          modelId: settings.modelId,
          suffix: agent,
          defaultVerified: false,
          defaultVerifiedLabel: copy.defaultVerified,
          unavailableLabel: unavailable
        })
      });
    } else {
      const settings = this.plugin.settings.agents.hermes;
      const profile = settings.profile ? ` · ${settings.profile}` : "";
      const defaultVerified = snapshot.phase === "ready"
        && settings.providerConfigured
        && this.isAgentSetupVerificationCurrent("hermes");
      rows.push({
        label: copy.providerModel,
        value: resolveAgentSetupProviderModelLabel({
          providerId: settings.providerId,
          modelId: settings.modelId,
          suffix: profile,
          defaultVerified,
          defaultVerifiedLabel: copy.defaultVerified,
          unavailableLabel: unavailable
        })
      });
    }
    const checkedAt = snapshot.checkedAt || this.plugin.settings.setup.lastCheckedAt;
    rows.push({ label: copy.lastChecked, value: checkedAt > 0 ? formatSetupTime(checkedAt) : unavailable });
    return rows;
  }

  private agentDashboardPrimaryLabel(snapshot: AgentSetupSnapshot, label: string): string {
    const copy = this.copy.setup.agentInstaller.dashboard.primary;
    const state = resolveAgentSetupDashboardState(snapshot);
    if (state.status === "detecting") return copy.detecting;
    if (state.status === "missing") {
      return this.setupInstallConfirmBackend === snapshot.backend
        ? this.copy.setup.agentInstaller.dashboard.installFlow.confirmAction
        : copy.install(label);
    }
    if (state.status === "installing") return copy.cancelInstall;
    if (state.status === "installed") return copy.connect;
    if (state.status === "connecting") return copy.connecting;
    if (state.status === "needs-auth") return snapshot.backend === "codex-cli" ? copy.codexLogin : copy.authorize(label);
    if (state.status === "authorizing") return copy.cancelAuthorization;
    if (state.status === "ready") {
      return this.shouldShowSetupGuide() || snapshot.backend === this.plugin.settings.agentBackend
        ? copy.start
        : copy.setDefault;
    }
    return copy.retry;
  }

  private async runAgentSetupAction(
    action: AgentSetupNextAction,
    retryTarget: AgentInstallerAction | null = null,
    installConfirmed = false
  ): Promise<void> {
    if (action === "cancel") {
      this.setupAbort?.abort();
      return;
    }
    if (this.setupBusy || !action) return;
    const sessionGeneration = this.setupSessionGeneration;
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    const effectiveAction = action === "retry" ? retryTarget : action;
    if (effectiveAction === "install") {
      if (action === "install" && this.setupSnapshots[this.setupSelectedBackend].phase === "missing") {
        if (!installConfirmed || this.setupInstallConfirmBackend !== this.setupSelectedBackend) {
          this.setupInstallConfirmBackend = this.setupSelectedBackend;
          this.scheduleDisplay();
          return;
        }
      }
      this.setupInstallConfirmBackend = null;
      return this.installAgent(this.setupSelectedBackend, sessionGeneration);
    }
    this.setupInstallConfirmBackend = null;
    if (effectiveAction === "authorize") return this.authorizeAgent(this.setupSelectedBackend, sessionGeneration);
    if (effectiveAction === "connect") return this.connectAgent(this.setupSelectedBackend, sessionGeneration);
    if (action === "start") return this.completeAgentSetup();
    if (action === "retry") return this.detectAllAgents(true);
  }

  private async deepCheckAgentOnce(
    backend: AgentBackendMode,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    if (this.setupBusy || this.setupDeepCheckedBackends.has(backend)) return;
    if (backend !== this.setupSelectedBackend || this.setupSnapshots[backend].phase !== "installed") return;
    this.setupDeepCheckedBackends.add(backend);
    try {
      await this.connectAgent(backend, sessionGeneration);
    } catch (error) {
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      const current = this.setupSnapshots[backend];
      this.setupSnapshots[backend] = this.failedAgentSnapshot(backend, current.command, error, current.version, "connect");
      this.scheduleDisplay();
    }
  }

  private invalidateAgentSetupReadiness(backend: AgentBackendMode): void {
    this.setupConfigRevisions[backend] += 1;
    this.clearAgentSetupVerification(backend);
    const current = this.setupSnapshots[backend];
    if (resolveAgentSetupDashboardState(current).busy) {
      this.setupPendingInvalidations.add(backend);
      this.scheduleDisplay();
      return;
    }
    this.applyAgentSetupInvalidation(backend);
    this.scheduleDisplay();
  }

  private recordAgentSetupVerification(
    backend: AgentBackendMode,
    snapshot: AgentSetupSnapshot,
    configRevision: number,
    sessionGeneration: number
  ): void {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    if (this.setupConfigRevisions[backend] !== configRevision) return;
    this.clearAgentSetupVerification(backend);
    if (snapshot.phase !== "ready") return;
    this.setupVerifiedRevisions[backend] = configRevision;
    this.setupDeepCheckedBackends.add(backend);
  }

  private clearAgentSetupVerification(backend: AgentBackendMode): void {
    this.setupVerifiedRevisions[backend] = -1;
    this.setupDeepCheckedBackends.delete(backend);
  }

  private isAgentSetupVerificationCurrent(backend: AgentBackendMode): boolean {
    return this.setupVerifiedRevisions[backend] === this.setupConfigRevisions[backend];
  }

  private downgradeUnverifiedReadySnapshots(): void {
    for (const backend of this.agentDashboardDefinitions().map((definition) => definition.backend)) {
      const current = this.setupSnapshots[backend];
      if (current.phase !== "ready" || this.isAgentSetupVerificationCurrent(backend)) continue;
      this.setupSnapshots[backend] = createAgentSetupSnapshot(
        backend,
        current.command ? "installed" : "missing",
        {
          command: current.command,
          version: current.version,
          detail: current.command
            ? this.copy.setup.agentInstaller.detection.cliInstalled
            : this.copy.setup.agentInstaller.detection.cliMissing(this.copy.setup.agentInstaller.agents[backend].label),
          checkedAt: current.checkedAt
        }
      );
    }
  }

  private canPreserveReadyAgentAfterDetection(
    backend: AgentBackendMode,
    previous: AgentSetupSnapshot,
    detected: AgentSetupSnapshot
  ): boolean {
    return previous.phase === "ready"
      && detected.phase === "installed"
      && previous.command === detected.command
      && previous.version === detected.version
      && this.setupDeepCheckedBackends.has(backend)
      && this.isAgentSetupVerificationCurrent(backend);
  }

  private applyAgentSetupInvalidation(backend: AgentBackendMode): void {
    const current = this.setupSnapshots[backend];
    if (!current.command) return;
    this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "installed", {
      command: current.command,
      version: current.version,
      detail: this.copy.setup.agentInstaller.detection.cliInstalled,
      checkedAt: current.checkedAt
    });
  }

  private flushPendingAgentSetupInvalidations(): void {
    for (const backend of Array.from(this.setupPendingInvalidations)) {
      this.setupPendingInvalidations.delete(backend);
      this.applyAgentSetupInvalidation(backend);
    }
  }

  private invalidateActiveCodexProvider(providerId: string): void {
    if (this.plugin.settings.providerMode !== "custom-api") return;
    if (this.plugin.settings.activeApiProviderId !== providerId) return;
    this.invalidateAgentSetupReadiness("codex-cli");
  }

  private async runPendingAgentAutoRepair(sessionGeneration = this.setupSessionGeneration): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    if (!this.setupAutoRepairPending || this.setupBusy || this.setupDetectionPending) return;
    this.setupAutoRepairPending = false;
    const snapshot = this.setupSnapshots[this.setupSelectedBackend];
    const state = resolveAgentSetupDashboardState(snapshot);
    const retryAction = state.primaryAction === "retry" ? state.retryTarget : state.primaryAction;
    try {
      if (state.primaryAction === "install" || state.primaryAction === "authorize" || state.primaryAction === "connect") {
        await this.runAgentSetupAction(state.primaryAction, state.retryTarget);
        return;
      }
      if (state.primaryAction === "retry" && state.retryTarget) {
        await this.runAgentSetupAction("retry", state.retryTarget);
      }
    } catch (error) {
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      const current = this.setupSnapshots[this.setupSelectedBackend];
      const lastAction = retryAction === "install" || retryAction === "authorize" || retryAction === "connect"
        ? retryAction
        : null;
      this.setupSnapshots[this.setupSelectedBackend] = this.failedAgentSnapshot(
        this.setupSelectedBackend,
        current.command,
        error,
        current.version,
        lastAction
      );
    } finally {
      if (this.isSetupSessionCurrent(sessionGeneration)) this.scheduleDisplay();
    }
  }

  private async drainPendingSetupDetection(sessionGeneration = this.setupSessionGeneration): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)
      || (this.setupDetectionDrainActive && this.setupDetectionDrainGeneration === sessionGeneration)) return;
    this.setupDetectionDrainActive = true;
    this.setupDetectionDrainGeneration = sessionGeneration;
    try {
      while (this.isSetupSessionCurrent(sessionGeneration) && !this.setupBusy && this.setupDetectionPending) {
        const connectSelected = this.setupPendingConnectSelected;
        this.setupDetectionPending = false;
        this.setupPendingConnectSelected = false;
        if (connectSelected) this.clearAgentSetupVerification(this.setupSelectedBackend);
        try {
          await this.runAgentDetectionCycle(connectSelected, sessionGeneration);
        } catch (error) {
          if (!this.isSetupSessionCurrent(sessionGeneration)) return;
          const current = this.setupSnapshots[this.setupSelectedBackend];
          this.setupSnapshots[this.setupSelectedBackend] = this.failedAgentSnapshot(
            this.setupSelectedBackend,
            current.command,
            error,
            current.version
          );
          this.scheduleDisplay();
        }
      }
    } finally {
      if (this.setupDetectionDrainGeneration === sessionGeneration) {
        this.setupDetectionDrainActive = false;
        this.setupDetectionDrainGeneration = null;
      }
      if (this.setupSessionActive
        && this.setupDetectionPending
        && this.setupSessionGeneration !== sessionGeneration) {
        void this.drainPendingSetupDetection(this.setupSessionGeneration);
      }
    }
  }

  private async detectAllAgents(
    connectSelected: boolean,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    this.setupDetectionPending = true;
    this.setupPendingConnectSelected = this.setupPendingConnectSelected || connectSelected;
    if (this.setupBusy
      || (this.setupDetectionDrainActive && this.setupDetectionDrainGeneration === sessionGeneration)) return;
    await this.drainPendingSetupDetection(sessionGeneration);
  }

  private async runAgentDetectionCycle(
    connectSelected: boolean,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    const backends = ["codex-cli", "opencode", "hermes"] as const;
    const previousSnapshots = { ...this.setupSnapshots };
    const detectionRevisions = { ...this.setupConfigRevisions };
    let selectedDetectionIsCurrent = true;
    const operationGeneration = this.beginAgentSetupOperation(null, null);
    for (const backend of backends) {
      this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "detecting");
    }
    this.scheduleDisplay();
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => this.agentInstallers["codex-cli"].detect()),
        Promise.resolve().then(() => this.agentInstallers.opencode.detect()),
        Promise.resolve().then(() => this.agentInstallers.hermes.detect())
      ]);
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      const nextSnapshots = { ...this.setupSnapshots };
      results.forEach((result, index) => {
        const backend = backends[index];
        const previous = previousSnapshots[backend];
        if (!isAgentSetupDetectionRevisionCurrent(detectionRevisions[backend], this.setupConfigRevisions[backend])) {
          nextSnapshots[backend] = createAgentSetupSnapshot(backend, "detecting");
          this.setupDetectionPending = true;
          if (backend === this.setupSelectedBackend) {
            selectedDetectionIsCurrent = false;
            this.setupPendingConnectSelected = this.setupPendingConnectSelected || connectSelected;
          }
          return;
        }
        const detected = result.status === "fulfilled"
          ? result.value
          : this.failedAgentSnapshot(backend, previous.command, result.reason, previous.version);
        if (this.canPreserveReadyAgentAfterDetection(backend, previous, detected)) {
          nextSnapshots[backend] = {
            ...previous,
            checkedAt: detected.checkedAt || previous.checkedAt
          };
          return;
        }
        if (previous.command !== detected.command || previous.version !== detected.version) {
          this.setupDeepCheckedBackends.delete(backend);
          this.setupVerifiedRevisions[backend] = -1;
        }
        nextSnapshots[backend] = detected;
      });
      this.setupSnapshots = nextSnapshots;
      this.plugin.settings.setup.lastCheckedAt = Date.now();
      try {
        await this.plugin.saveSettings(true);
      } catch (error) {
        if (!this.isSetupSessionCurrent(sessionGeneration)) return;
        const current = this.setupSnapshots[this.setupSelectedBackend];
        this.setupSnapshots[this.setupSelectedBackend] = this.failedAgentSnapshot(
          this.setupSelectedBackend,
          current.command,
          error,
          current.version,
          current.lastAction ?? null
        );
      }
    } catch (error) {
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      const current = this.setupSnapshots[this.setupSelectedBackend];
      this.setupSnapshots[this.setupSelectedBackend] = this.failedAgentSnapshot(
        this.setupSelectedBackend,
        current.command,
        error,
        current.version,
        current.lastAction ?? null
      );
    } finally {
      const operationFinished = this.finishAgentSetupOperation(operationGeneration, null);
      if (operationFinished && this.isSetupSessionCurrent(sessionGeneration)) {
        this.flushPendingAgentSetupInvalidations();
        this.scheduleDisplay();
      }
    }
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    try {
      if (connectSelected && selectedDetectionIsCurrent) {
        await this.deepCheckAgentOnce(this.setupSelectedBackend, sessionGeneration);
      }
      await this.runPendingAgentAutoRepair(sessionGeneration);
    } catch (error) {
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      const current = this.setupSnapshots[this.setupSelectedBackend];
      this.setupSnapshots[this.setupSelectedBackend] = this.failedAgentSnapshot(
        this.setupSelectedBackend,
        current.command,
        error,
        current.version,
        current.lastAction ?? null
      );
    } finally {
      if (this.isSetupSessionCurrent(sessionGeneration)) {
        this.flushPendingAgentSetupInvalidations();
        this.scheduleDisplay();
      }
    }
  }

  private async detectAgentBackend(backend: AgentBackendMode, _context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    if (backend === "codex-cli") return this.detectCodexAgent();
    if (backend === "opencode") {
      return this.detectSimpleCli("opencode", detectOpenCodeCommand(this.plugin.settings.opencode.cliPath));
    }
    return this.detectSimpleCli("hermes", detectHermesCommand(this.plugin.settings.agents.hermes.cliPath));
  }

  private async detectCodexAgent(): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.detection;
    try {
      const detection = await inspectCodexInstallation(this.plugin.settings.cliPath);
      if (!detection.command) return createAgentSetupSnapshot("codex-cli", "missing", { detail: copy.codexMissing, checkedAt: Date.now() });
      if (detection.versionError) {
        return createAgentSetupSnapshot("codex-cli", "failed", {
          command: detection.command,
          version: detection.version,
          detail: copy.codexVersionFailed,
          error: detection.versionError,
          checkedAt: Date.now()
        });
      }
      const detail = detection.invalidCustomPath
        ? copy.codexFallback(detection.command)
        : copy.codexFound;
      return createAgentSetupSnapshot("codex-cli", "installed", { command: detection.command, version: detection.version, detail, checkedAt: Date.now() });
    } catch (error) {
      return this.failedAgentSnapshot("codex-cli", null, error);
    }
  }

  private async detectSimpleCli(backend: "opencode" | "hermes", command: string | null): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller;
    const label = copy.agents[backend].label;
    if (!command) return createAgentSetupSnapshot(backend, "missing", { detail: copy.detection.cliMissing(label), checkedAt: Date.now() });
    try {
      const launch = backend === "opencode" ? resolveOpenCodeLaunch(command) : { command, argsPrefix: [] as string[] };
      const version = await inspectCliVersion(launch.command, launch.argsPrefix);
      return createAgentSetupSnapshot(backend, "installed", { command, version, detail: copy.detection.cliInstalled, checkedAt: Date.now() });
    } catch (error) {
      return this.failedAgentSnapshot(backend, command, error);
    }
  }

  private async installAgent(
    backend: AgentBackendMode,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    const copy = this.copy.setup.agentInstaller;
    const label = copy.agents[backend].label;
    if (this.setupBusy) return;
    const controller = new AbortController();
    const operationGeneration = this.beginAgentSetupOperation(backend, controller);
    const previous = this.setupSnapshots[backend];
    this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "installing", {
      command: previous.command,
      version: previous.version,
      progress: {
        stage: "checking-environment",
        step: 1,
        total: 3
      },
      detail: copy.install.installing(label)
    });
    this.scheduleDisplay();
    let installed = false;
    let latestProgressStep = 1;
    let verifiedInstallSnapshot: AgentSetupSnapshot | null = null;
    try {
      let snapshot = await runAgentInstallerAction(this.agentInstallers, backend, "install", {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!this.isSetupSessionCurrent(sessionGeneration)
            || !this.isAgentSetupOperationOwner(operationGeneration, controller)
            || controller.signal.aborted
            || this.setupActiveBackend !== backend
            || this.setupSnapshots[backend].phase !== "installing"
            || progress.step < latestProgressStep) {
            return;
          }
          latestProgressStep = progress.step;
          this.setupSnapshots[backend] = {
            ...this.setupSnapshots[backend],
            progress,
            detail: copy.dashboard.installFlow.step[progress.stage]
          };
          this.scheduleDisplay();
        }
      });
      verifiedInstallSnapshot = snapshot.phase === "installed" ? snapshot : null;
      if (snapshot.phase !== "failed") throwIfAgentSetupAborted(controller.signal);
      if (!this.isSetupSessionCurrent(sessionGeneration)
        || !this.isAgentSetupOperationOwner(operationGeneration, controller)) return;
      snapshot = await this.reconcileTerminalAgentInstallReality(backend, snapshot, sessionGeneration);
      if (!this.isSetupSessionCurrent(sessionGeneration)
        || !this.isAgentSetupOperationOwner(operationGeneration, controller)) return;
      const recoveredInstalledCommand = Boolean(snapshot.command && snapshot.command !== previous.command);
      if (snapshot.command && (snapshot.phase === "installed" || recoveredInstalledCommand)) {
        this.writeAgentCliPath(backend, snapshot.command);
        if (snapshot.phase !== "installed") this.setupCommandsAwaitingVerification.add(backend);
        await this.plugin.saveSettings(true);
        throwIfAgentSetupAborted(controller.signal);
        if (!this.isSetupSessionCurrent(sessionGeneration)
          || !this.isAgentSetupOperationOwner(operationGeneration, controller)) return;
      }
      this.setupSnapshots[backend] = snapshot;
      installed = snapshot.phase === "installed";
    } catch (error) {
      if (this.isSetupSessionCurrent(sessionGeneration)
        && this.isAgentSetupOperationOwner(operationGeneration, controller)) {
        const terminal = controller.signal.aborted || isAgentSetupAbortError(error)
          ? this.cancelledAgentSnapshot(backend, previous, copy.install.cancelled, "install")
          : this.failedAgentSnapshot(backend, previous.command, error, previous.version, "install");
        if (verifiedInstallSnapshot?.command) {
          terminal.command = verifiedInstallSnapshot.command;
          terminal.version = verifiedInstallSnapshot.version;
          terminal.lastAction = "connect";
        }
        const reconciled = await this.reconcileTerminalAgentInstallReality(
          backend,
          terminal,
          sessionGeneration
        );
        if (this.isSetupSessionCurrent(sessionGeneration)
          && this.isAgentSetupOperationOwner(operationGeneration, controller)) {
          if (reconciled.command && reconciled.lastAction === "connect") {
            this.writeAgentCliPath(backend, reconciled.command);
            this.setupCommandsAwaitingVerification.add(backend);
          }
          this.setupSnapshots[backend] = reconciled;
        }
      }
    } finally {
      const operationFinished = this.finishAgentSetupOperation(operationGeneration, controller);
      if (operationFinished && this.isSetupSessionCurrent(sessionGeneration)) {
        this.flushPendingAgentSetupInvalidations();
        this.scheduleDisplay();
      }
    }
    if (installed && this.isSetupSessionCurrent(sessionGeneration)) {
      await this.connectAgent(backend, sessionGeneration);
    }
    if (this.isSetupSessionCurrent(sessionGeneration)) {
      await this.drainPendingSetupDetection(sessionGeneration);
    }
  }

  private async performAgentInstall(backend: AgentBackendMode, context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.install;
    const previous = this.setupSnapshots[backend];
    const result = backend === "hermes"
      ? await installHermesCli({ signal: context.signal, onProgress: context.onProgress })
      : await installNpmCli(
        backend === "codex-cli" ? "codex" : "opencode",
        { signal: context.signal, onProgress: context.onProgress }
      );
    if (result.status === "cancelled") {
      return createAgentSetupSnapshot(backend, "cancelled", {
        command: previous.command,
        detail: copy.cancelled,
        logs: limitedAgentSetupLog(result.logs)
      });
    }
    if (result.status === "failed" || !result.command) {
      return createAgentSetupSnapshot(backend, "failed", {
        command: previous.command,
        detail: copy.failed,
        error: result.error || copy.failedError,
        logs: limitedAgentSetupLog(result.logs)
      });
    }
    return createAgentSetupSnapshot(backend, "installed", {
      command: result.command,
      version: result.version,
      detail: copy.completed,
      logs: limitedAgentSetupLog(result.logs),
      checkedAt: Date.now()
    });
  }

  private async reconcileTerminalAgentInstallReality(
    backend: AgentBackendMode,
    terminal: AgentSetupSnapshot,
    sessionGeneration: number
  ): Promise<AgentSetupSnapshot> {
    if (terminal.phase !== "cancelled" && terminal.phase !== "failed") return terminal;
    try {
      const detected = await this.agentInstallers[backend].detect();
      if (!this.isSetupSessionCurrent(sessionGeneration)) return terminal;
      return reconcileTerminalAgentInstallDetection(terminal, detected);
    } catch {
      return terminal;
    }
  }

  private async connectAgent(
    backend: AgentBackendMode,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration) || this.setupBusy) return;
    let current = this.setupSnapshots[backend];
    if (!current.command) {
      await this.detectAllAgents(false, sessionGeneration);
      if (!this.isSetupSessionCurrent(sessionGeneration)) return;
      if (!this.setupSnapshots[backend].command) return;
      current = this.setupSnapshots[backend];
    }
    this.clearAgentSetupVerification(backend);
    this.plugin.agentRuntimeHealth.reset(backend);
    const configRevision = this.setupConfigRevisions[backend];
    const controller = new AbortController();
    const operationGeneration = this.beginAgentSetupOperation(backend, controller);
    this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "connecting", {
      command: this.setupSnapshots[backend].command,
      version: this.setupSnapshots[backend].version,
      detail: this.copy.setup.agentInstaller.connection.checking,
      nextAction: null
    });
    this.scheduleDisplay();
    try {
      const snapshot = await runAgentInstallerAction(this.agentInstallers, backend, "connect", {
        signal: controller.signal
      });
      throwIfAgentSetupAborted(controller.signal);
      if (!this.isSetupSessionCurrent(sessionGeneration)
        || !this.isAgentSetupOperationOwner(operationGeneration, controller)) return;
      this.setupCommandsAwaitingVerification.delete(backend);
      this.setupSnapshots[backend] = snapshot;
      this.plugin.agentRuntimeHealth.reportHealthy(backend);
      this.recordAgentSetupVerification(backend, snapshot, configRevision, sessionGeneration);
    } catch (error) {
      const cancelled = controller.signal.aborted || isAgentSetupAbortError(error);
      if (this.isSetupSessionCurrent(sessionGeneration)
        && this.isAgentSetupOperationOwner(operationGeneration, controller)) {
        this.setupCommandsAwaitingVerification.delete(backend);
        if (!cancelled) {
          this.plugin.agentRuntimeHealth.reportFailure(backend, error, { source: "setup-connect" });
        }
        this.setupSnapshots[backend] = cancelled
          ? this.cancelledAgentSnapshot(backend, current, this.copy.setup.agentInstaller.connection.cancelled, "connect")
          : this.failedAgentSnapshot(backend, current.command, error, current.version, "connect");
      }
    } finally {
      const operationFinished = this.finishAgentSetupOperation(operationGeneration, controller);
      if (operationFinished && this.isSetupSessionCurrent(sessionGeneration)) {
        this.flushPendingAgentSetupInvalidations();
        this.scheduleDisplay();
      }
    }
    if (this.isSetupSessionCurrent(sessionGeneration)) {
      await this.drainPendingSetupDetection(sessionGeneration);
    }
  }

  private async performAgentConnection(backend: AgentBackendMode, context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    if (backend === "codex-cli") return this.connectCodexAgent(context);
    if (backend === "opencode") return this.connectOpenCodeAgent(context);
    return this.connectHermesAgent(context);
  }

  private async connectCodexAgent(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.connection;
    const current = this.setupSnapshots["codex-cli"];
    throwIfAgentSetupAborted(context.signal);
    if (current.command) this.writeAgentCliPath("codex-cli", current.command);
    const status = await this.plugin.ensureCodexConnected(true, { silent: true, refreshLogin: true });
    throwIfAgentSetupAborted(context.signal);
    if (status.connected) this.plugin.agentRuntimeHealth.reportHealthy("codex-cli");
    if (!status.connected || status.accountReadError) throw new Error(status.accountReadError ?? status.errors[0] ?? this.copy.setup.loginErrors.connection);
    if (!status.loggedIn) {
      const snapshot = createAgentSetupSnapshot("codex-cli", "needs-auth", {
        command: current.command,
        version: current.version,
        detail: copy.codexNeedsAuth,
        checkedAt: Date.now()
      });
      await this.plugin.saveSettings(true);
      return snapshot;
    }
    const snapshot = createAgentSetupSnapshot("codex-cli", "ready", {
      command: current.command,
      version: current.version,
      detail: copy.codexReady,
      checkedAt: Date.now()
    });
    await this.plugin.saveSettings(true);
    return snapshot;
  }

  private async connectOpenCodeAgent(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.connection;
    const current = this.setupSnapshots.opencode;
    throwIfAgentSetupAborted(context.signal);
    if (current.command) this.writeAgentCliPath("opencode", current.command);
    const backend = this.createOpenCodeSetupBackend(current.command || this.plugin.settings.opencode.cliPath);
    let probeSessionId = "";
    try {
      await backend.connect();
      this.plugin.agentRuntimeHealth.reportHealthy("opencode");
      throwIfAgentSetupAborted(context.signal);
      const [models, agents] = await Promise.all([backend.listModels(), backend.listAgents()]);
      throwIfAgentSetupAborted(context.signal);
      const configuredProvider = this.plugin.settings.opencode.providerId.trim();
      const configuredModel = this.plugin.settings.opencode.modelId.trim();
      const hasExistingProvider = Boolean(configuredProvider || configuredModel);
      const model = selectOpenCodeConnectionModel(models, {
        providerId: configuredProvider,
        modelId: configuredModel
      });
      if (!model) {
        const snapshot = createAgentSetupSnapshot("opencode", hasExistingProvider ? "failed" : "needs-auth", {
          command: current.command,
          version: backend.getConnectionInfo().version || current.version,
          detail: hasExistingProvider
            ? copy.opencodeExistingUnavailable
            : copy.opencodeNoFreeModel,
          error: hasExistingProvider ? copy.opencodeExistingError : "",
          checkedAt: Date.now()
        });
        await this.plugin.saveSettings(true);
        return snapshot;
      }
      const agent = agents.find((item) => item.id.toLowerCase() === this.plugin.settings.opencode.agent.toLowerCase())
        ?? agents.find((item) => item.id.toLowerCase() === "build")
        ?? agents[0];
      const probe = await backend.runCliTask({
        prompt: "只回复 OPENCODE_PONG",
        model: { providerId: model.providerId, modelId: model.modelId },
        agent: agent?.id || "build",
        timeoutMs: 60_000,
        abortSignal: context.signal
      });
      throwIfAgentSetupAborted(context.signal);
      probeSessionId = probe.runId || "";
      if (!/\bOPENCODE_PONG\b/i.test(probe.text.trim())) throw new Error(copy.opencodeProbeFailed);
      const info = backend.getConnectionInfo();
      this.plugin.settings.opencode.cliPath = current.command || info.command || this.plugin.settings.opencode.cliPath;
      this.plugin.settings.agents.opencode = this.plugin.settings.opencode;
      this.plugin.settings.opencode.providerId = model.providerId;
      this.plugin.settings.opencode.modelId = model.modelId;
      this.plugin.settings.opencode.agent = agent?.id || "build";
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      await this.plugin.saveSettings(true);
      return createAgentSetupSnapshot("opencode", "ready", {
        command: current.command,
        version: info.version || current.version,
        detail: copy.opencodeReady(model.id),
        checkedAt: Date.now()
      });
    } finally {
      if (probeSessionId) await backend.deleteSession(probeSessionId).catch(swallowError("delete OpenCode setup probe session"));
      await backend.disconnect().catch(swallowError("disconnect OpenCode setup backend"));
    }
  }

  private async connectHermesAgent(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.connection;
    const current = this.setupSnapshots.hermes;
    throwIfAgentSetupAborted(context.signal);
    if (current.command) {
      this.writeAgentCliPath("hermes", current.command);
      await this.plugin.saveSettings(true);
    }
    const result = await this.plugin.testHermesConnection({ notify: false, signal: context.signal });
    throwIfAgentSetupAborted(context.signal);
    if (result.connected) this.plugin.agentRuntimeHealth.reportHealthy("hermes");
    if (!result.connected) throw new Error(result.message);
    if (!result.providerConfigured) {
      const savedProvider = this.plugin.settings.agents.hermes.providerId.trim();
      const savedModel = this.plugin.settings.agents.hermes.modelId.trim();
      let canResumeIncompleteNousConfig = savedProvider === HERMES_NOUS_PROVIDER && !savedModel;
      let hasExistingProvider = Boolean(savedProvider || savedModel) && !canResumeIncompleteNousConfig;
      let inspectionError = "";
      if (!hasExistingProvider && current.command) {
        try {
          const inspected = await inspectHermesModelConfig({
            command: current.command,
            cwd: this.plugin.getVaultPath()
          });
          canResumeIncompleteNousConfig = inspected.provider === HERMES_NOUS_PROVIDER && !inspected.defaultModel;
          hasExistingProvider = inspected.hasExistingModelConfig && !canResumeIncompleteNousConfig;
        } catch (error) {
          hasExistingProvider = true;
          inspectionError = error instanceof Error ? error.message : String(error);
        }
      }
      return createAgentSetupSnapshot("hermes", hasExistingProvider ? "failed" : "needs-auth", {
        command: current.command,
        version: result.version || current.version,
        detail: hasExistingProvider
          ? copy.hermesExistingInvalid
          : canResumeIncompleteNousConfig
            ? copy.hermesResumeNous
            : copy.hermesNeedsAuth,
        error: hasExistingProvider ? (inspectionError || this.plugin.settings.agents.hermes.lastProviderError) : "",
        checkedAt: Date.now()
      });
    }
    return createAgentSetupSnapshot("hermes", "ready", {
      command: current.command,
      version: result.version || current.version,
      detail: copy.hermesReady,
      checkedAt: Date.now()
    });
  }

  private async authorizeAgent(
    backend: AgentBackendMode,
    sessionGeneration = this.setupSessionGeneration
  ): Promise<void> {
    if (!this.isSetupSessionCurrent(sessionGeneration) || this.setupBusy) return;
    const current = this.setupSnapshots[backend];
    if (backend === "hermes" && !current.command) return;
    const controller = new AbortController();
    const operationGeneration = this.beginAgentSetupOperation(backend, controller);
    const configRevision = this.setupConfigRevisions[backend];
    const copy = this.copy.setup.agentInstaller.authorization;
    this.setupSnapshots[backend] = createAgentSetupSnapshot(backend, "authorizing", {
      command: current.command,
      version: current.version,
      detail: backend === "codex-cli"
        ? copy.progressCodex
        : backend === "opencode"
          ? copy.progressOpenCode
          : copy.progressHermes
    });
    this.scheduleDisplay();
    let shouldConnect = false;
    let completedAuthorizationSnapshot: AgentSetupSnapshot | null = null;
    try {
      const snapshot = await runAgentInstallerAction(this.agentInstallers, backend, "authorize", {
        signal: controller.signal
      });
      if (snapshot.phase === "installed") completedAuthorizationSnapshot = snapshot;
      if (snapshot.phase !== "failed") throwIfAgentSetupAborted(controller.signal);
      if (!this.isSetupSessionCurrent(sessionGeneration)
        || !this.isAgentSetupOperationOwner(operationGeneration, controller)) return;
      this.setupSnapshots[backend] = snapshot;
      this.recordAgentSetupVerification(backend, snapshot, configRevision, sessionGeneration);
      shouldConnect = snapshot.phase === "installed";
    } catch (error) {
      if (this.isSetupSessionCurrent(sessionGeneration)
        && this.isAgentSetupOperationOwner(operationGeneration, controller)) {
        const cancelled = controller.signal.aborted || isAgentSetupAbortError(error);
        this.setupSnapshots[backend] = cancelled
          ? this.cancelledAgentSnapshot(
            backend,
            completedAuthorizationSnapshot ?? current,
            copy.cancelled,
            completedAuthorizationSnapshot ? "connect" : "authorize"
          )
          : this.failedAgentSnapshot(backend, current.command, error, current.version, "authorize");
      }
    } finally {
      const operationFinished = this.finishAgentSetupOperation(operationGeneration, controller);
      if (operationFinished && this.isSetupSessionCurrent(sessionGeneration)) {
        this.flushPendingAgentSetupInvalidations();
        this.scheduleDisplay();
      }
    }
    if (shouldConnect && this.isSetupSessionCurrent(sessionGeneration)) {
      await this.connectAgent(backend, sessionGeneration);
    }
    if (this.isSetupSessionCurrent(sessionGeneration)) {
      await this.drainPendingSetupDetection(sessionGeneration);
    }
  }

  private async performAgentAuthorization(backend: AgentBackendMode, context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    if (backend === "codex-cli") return this.performCodexAuthorization(context);
    if (backend === "opencode") return this.performOpenCodeAuthorization(context);
    return this.performHermesAuthorization(context);
  }

  private async performCodexAuthorization(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.authorization;
    const current = this.setupSnapshots["codex-cli"];
    throwIfAgentSetupAborted(context.signal);
    if (!this.plugin.codex?.isConnected()) await this.plugin.ensureCodexConnected(true, { silent: true });
    throwIfAgentSetupAborted(context.signal);
    if (!this.plugin.codex?.isConnected()) throw new Error(this.plugin.lastStatus?.errors[0] ?? this.copy.setup.loginErrors.connection);
    await this.plugin.codex.login({
      signal: context.signal,
      openUrl: (url) => openExternalInElectron(url)
    });
    throwIfAgentSetupAborted(context.signal);
    this.plugin.lastStatus = await this.plugin.codex.refreshStatus({ refreshToken: true });
    throwIfAgentSetupAborted(context.signal);
    if (this.plugin.lastStatus.accountReadError) throw new Error(this.plugin.lastStatus.accountReadError);
    if (!this.plugin.lastStatus.loggedIn) throw new CodexLoginError("failed", this.copy.setup.loginErrors.failed);
    return createAgentSetupSnapshot("codex-cli", "installed", {
      command: current.command,
      version: current.version,
      detail: this.plugin.lastStatus.accountLabel || copy.codexLoggedIn,
      checkedAt: Date.now()
    });
  }

  private async performOpenCodeAuthorization(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.authorization;
    const current = this.setupSnapshots.opencode;
    const backend = this.createOpenCodeAuthorizationBackend(current.command || this.plugin.settings.opencode.cliPath);
    const sensitiveInputs = new Set<string>();
    try {
      throwIfAgentSetupAborted(context.signal);
      await backend.connect();
      throwIfAgentSetupAborted(context.signal);
      const authMethods = await backend.listProviderAuthMethods(context.signal);
      const providerIds = Object.keys(authMethods).filter((providerId) => (authMethods[providerId]?.length ?? 0) > 0);
      if (!providerIds.length) throw new Error(copy.noOpenCodeProviders);
      const configuredProvider = this.plugin.settings.opencode.providerId;
      const orderedProviderIds = configuredProvider && providerIds.includes(configuredProvider)
        ? [configuredProvider, ...providerIds.filter((providerId) => providerId !== configuredProvider)]
        : providerIds;
      const providerId = orderedProviderIds.length === 1
        ? orderedProviderIds[0]
        : await selectInputModal(this.app, copy.configureProvider, copy.selectProvider, orderedProviderIds.map((value) => ({ value, label: value })));
      if (providerId === null) return this.cancelledAgentSnapshot("opencode", current, copy.providerCancelled);
      throwIfAgentSetupAborted(context.signal);
      const methods = authMethods[providerId] ?? [];
      if (!methods.length) throw new Error(copy.noProviderMethods(providerId));
      const methodChoice = methods.length === 1
        ? "0"
        : await selectInputModal(this.app, copy.configureNamedProvider(providerId), copy.authMethod, methods.map((method, index) => ({
          value: String(index),
          label: `${method.label} · ${method.type === "oauth" ? copy.browserAuth : copy.apiKey}`
        })));
      if (methodChoice === null) return this.cancelledAgentSnapshot("opencode", current, copy.openCodeCancelled);
      throwIfAgentSetupAborted(context.signal);
      const methodIndex = Number.parseInt(methodChoice, 10);
      const method = methods[methodIndex];
      if (!method) throw new Error(copy.noProviderMethods(providerId));
      const inputs: Record<string, string> = {};
      for (const prompt of method.prompts ?? []) {
        if (!shouldRequestOpenCodeAuthPrompt(prompt, inputs)) continue;
        const isSecretPrompt = method.type === "api" || /(?:key|token|secret|password)/i.test(prompt.key);
        const value = prompt.type === "select"
          ? await selectInputModal(this.app, method.label, prompt.message, prompt.options.map((option) => ({
            value: option.value,
            label: option.hint ? `${option.label} · ${option.hint}` : option.label
          })))
          : await textInputModal(this.app, method.label, prompt.message, "", {
            secret: isSecretPrompt
          });
        if (value === null) return this.cancelledAgentSnapshot("opencode", current, copy.openCodeCancelled);
        throwIfAgentSetupAborted(context.signal);
        inputs[prompt.key] = value;
        if (isSecretPrompt && value) sensitiveInputs.add(value);
      }
      if (method.type === "oauth") {
        const authorization = await backend.beginProviderOAuth(providerId, methodIndex, inputs, context.signal);
        throwIfAgentSetupAborted(context.signal);
        if (!await openExternalInElectron(authorization.url)) throw new Error(copy.invalidOpenCodeUrl);
        const automaticInstructions = openCodeAutomaticOAuthInstructions(authorization);
        if (automaticInstructions !== null) {
          const completed = await confirmModal(
            this.app,
            copy.completeOpenCodeOauth,
            automaticInstructions,
            copy.completed,
            copy.cancel
          );
          if (!completed) return this.cancelledAgentSnapshot("opencode", current, copy.oauthCancelled);
          throwIfAgentSetupAborted(context.signal);
        }
        const code = authorization.method === "code"
          ? await textInputModal(this.app, copy.completeOpenCodeOauth, authorization.instructions || copy.pasteCode, "", { secret: true })
          : undefined;
        if (authorization.method === "code" && code === null) return this.cancelledAgentSnapshot("opencode", current, copy.oauthCancelled);
        if (authorization.method === "code" && !code) throw new Error(copy.missingOauthCode);
        if (code) sensitiveInputs.add(code);
        throwIfAgentSetupAborted(context.signal);
        if (!await backend.completeProviderOAuth(providerId, methodIndex, code ?? undefined, context.signal)) {
          throw new Error(copy.oauthFailed);
        }
      } else {
        let credential = openCodeApiCredential(method, inputs);
        if (!credential) {
          const key = await textInputModal(this.app, copy.configureNamedProvider(providerId), copy.apiKey, "", { secret: true });
          if (key === null) return this.cancelledAgentSnapshot("opencode", current, copy.apiKeyCancelled);
          if (!key) throw new Error(copy.missingApiKey);
          credential = { key, metadata: { ...inputs } };
        }
        sensitiveInputs.add(credential.key);
        if (!await backend.setProviderApiKey(providerId, credential.key, credential.metadata, context.signal)) {
          throw new Error(copy.apiKeySaveFailed);
        }
      }
      throwIfAgentSetupAborted(context.signal);
      const connected = await backend.listConnectedProviders(context.signal);
      if (!connected.includes(providerId)) throw new Error(copy.providerVerifyFailed(providerId));
      const previousProviderId = this.plugin.settings.opencode.providerId.trim();
      if (previousProviderId !== providerId) this.plugin.settings.opencode.modelId = "";
      this.plugin.settings.opencode.providerId = providerId;
      await this.plugin.saveSettings(true);
      return createAgentSetupSnapshot("opencode", "installed", {
        command: current.command,
        version: current.version,
        detail: copy.providerAuthorized(providerId)
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new Error(redactOpenCodeAuthSecrets(rawMessage, sensitiveInputs));
    } finally {
      await backend.disconnect().catch(swallowError("disconnect OpenCode authorization backend"));
    }
  }

  private async performHermesAuthorization(context: AgentSetupContext = {}): Promise<AgentSetupSnapshot> {
    const copy = this.copy.setup.agentInstaller.authorization;
    const current = this.setupSnapshots.hermes;
    if (!current.command) throw new Error(copy.hermesMissing);
    const result = await authorizeHermesNous({ command: current.command, cwd: this.plugin.getVaultPath(), signal: context.signal });
    if (result.status === "cancelled") {
      return createAgentSetupSnapshot("hermes", "cancelled", { command: current.command, version: current.version, detail: copy.cancelled });
    }
    if (result.status === "failed") {
      return createAgentSetupSnapshot("hermes", "failed", {
        command: current.command,
        version: current.version,
        detail: copy.hermesFailed,
        error: result.error || copy.failed,
        logs: result.logs
      });
    }
    this.plugin.settings.agents.hermes.providerId = result.providerId;
    this.plugin.settings.agents.hermes.modelId = result.modelId;
    await this.plugin.saveSettings(true);
    return createAgentSetupSnapshot("hermes", "installed", {
      command: current.command,
      version: current.version,
      detail: copy.hermesAuthorized,
      logs: result.logs
    });
  }

  private cancelledAgentSnapshot(
    backend: AgentBackendMode,
    current: AgentSetupSnapshot,
    detail: string,
    lastAction: AgentInstallerAction | null = current.lastAction ?? null
  ): AgentSetupSnapshot {
    return createAgentSetupSnapshot(backend, "cancelled", {
      command: current.command,
      version: current.version,
      detail,
      lastAction,
      checkedAt: Date.now()
    });
  }

  private createOpenCodeSetupBackend(command: string): OpenCodeBackend {
    return new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      cliPath: command,
      vaultPath: this.plugin.getVaultPath()
    });
  }

  private createOpenCodeAuthorizationBackend(command: string): OpenCodeBackend {
    return new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      cliPath: command,
      vaultPath: this.plugin.getVaultPath(),
      ...openCodeAuthorizationConnectionOverrides()
    });
  }

  private failedAgentSnapshot(
    backend: AgentBackendMode,
    command: string | null,
    error: unknown,
    version: string | null = null,
    lastAction: AgentInstallerAction | null = null
  ): AgentSetupSnapshot {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = limitedAgentSetupLog(rawMessage, 2_000);
    return createAgentSetupSnapshot(backend, "failed", {
      command,
      version,
      detail: this.copy.setup.agentInstaller.genericFailure,
      error: message,
      logs: limitedAgentSetupLog(rawMessage),
      lastAction,
      checkedAt: Date.now()
    });
  }

  private writeAgentCliPath(backend: AgentBackendMode, command: string): void {
    this.setupObservedCommands[backend] = command;
    if (backend === "codex-cli") {
      this.plugin.settings.cliPath = command;
      this.plugin.settings.agents.codex.cliPath = command;
      return;
    }
    if (backend === "opencode") {
      this.plugin.settings.opencode.cliPath = command;
      this.plugin.settings.agents.opencode = this.plugin.settings.opencode;
      return;
    }
    this.plugin.settings.agents.hermes.cliPath = command;
  }

  private async openAgentTerminalFallback(backend: AgentBackendMode): Promise<void> {
    if (backend === "hermes") {
      if (!await openExternalInElectron(HERMES_DOCS_URL)) new Notice(this.copy.setup.agentInstaller.hermesDocsOpenFailed);
      return;
    }
    const command = backend === "codex-cli"
      ? CODEX_CLI_INSTALL_COMMAND
      : "npm install --global --prefix ~/.npm-global opencode-ai";
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        copied = true;
      }
    } catch {
      copied = false;
    }
    const opened = await openTerminalForSetup(process.platform);
    const notice = opened
      ? copied
        ? this.copy.setup.terminalOpened
        : this.copy.setup.terminalOpenedWithoutCopy
      : copied
        ? this.copy.setup.terminalCopied
        : this.copy.setup.terminalUnavailable;
    new Notice(notice);
  }

  private async completeAgentSetup(): Promise<void> {
    if (this.setupBusy) return;
    const sessionGeneration = this.setupSessionGeneration;
    if (!this.isSetupSessionCurrent(sessionGeneration)) return;
    const selected = this.setupSnapshots[this.setupSelectedBackend];
    const backend = readyAgentBackendToCommit(this.setupSelectedBackend, selected);
    if (!backend || !this.isAgentSetupVerificationCurrent(backend)) {
      new Notice(this.copy.setup.startBlocked);
      return;
    }
    const previousAgentBackend = this.plugin.settings.agentBackend;
    const previousDefaultBackend = this.plugin.settings.agents.defaultBackend;
    const previousSetup = this.plugin.settings.setup;
    const completingFirstSetup = previousSetup.completedAt <= 0;
    const nextSetup = completingFirstSetup
      ? completeSetupState(previousSetup, Date.now(), this.plugin.manifest.version)
      : previousSetup;
    const operationGeneration = this.beginAgentSetupOperation(null, null);
    this.scheduleDisplay();
    try {
      this.plugin.settings.agentBackend = backend;
      this.plugin.settings.agents.defaultBackend = backend;
      if (completingFirstSetup) {
        this.plugin.settings.setup = nextSetup;
      }
      try {
        await this.plugin.saveSettings(true);
      } catch {
        const setupMutationStillOwned = this.plugin.settings.agentBackend === backend
          && this.plugin.settings.agents.defaultBackend === backend
          && this.plugin.settings.setup === nextSetup;
        if (setupMutationStillOwned) {
          this.plugin.settings.agentBackend = previousAgentBackend;
          this.plugin.settings.agents.defaultBackend = previousDefaultBackend;
          this.plugin.settings.setup = previousSetup;
        }
        if (this.isSetupSessionCurrent(sessionGeneration)
          && this.isAgentSetupOperationOwner(operationGeneration, null)) {
          new Notice(this.copy.setup.startSaveFailed);
        }
        return;
      }
      if (completingFirstSetup
        && this.isSetupSessionCurrent(sessionGeneration)
        && this.isAgentSetupOperationOwner(operationGeneration, null)) {
        try {
          await this.plugin.activateView();
        } catch {
          new Notice(this.copy.setup.startActivateFailed);
        }
      }
    } finally {
      if (this.finishAgentSetupOperation(operationGeneration, null)) {
        this.scheduleDisplay();
      }
    }
  }

  private renderTopTabs(container: HTMLElement): void {
    const copy = this.copy;
    const tabs = container.createDiv({ cls: "codex-settings-tabs" });
    for (const tab of SETTINGS_TABS) {
      const button = tabs.createEl("button", {
        cls: `codex-settings-tab ${this.plugin.settings.settingsTab === tab.id ? "is-active" : ""}`,
        attr: { type: "button" }
      });
      const icon = button.createSpan({ cls: "codex-settings-tab-icon" });
      setIcon(icon, tab.icon);
      button.createSpan({ text: copy.tabs[tab.id] });
      button.onclick = async () => {
        this.plugin.settings.settingsTab = tab.id;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      };
    }
  }

  private renderApiProviderManager(container: HTMLElement): void {
    const copy = this.copy;
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "key-round");
    title.createSpan({ text: copy.providers.title });

    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: copy.providers.warningKey
    });
    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: copy.providers.warningApi
    });

    const modeRow = wrapper.createDiv({ cls: "codex-api-provider-mode" });
    modeRow.createDiv({
      cls: "codex-resource-summary",
      text: copy.common.current(providerConnectionLabel(this.plugin.settings, this.plugin.settings.settingsLanguage))
    });
    const loginButton = modeRow.createEl("button", {
      cls: `codex-resource-tab ${this.plugin.settings.providerMode === "codex-login" ? "is-active" : ""}`,
      text: copy.providers.loginMode,
      attr: { type: "button" }
    });
    loginButton.onclick = async () => {
      this.plugin.settings.providerMode = "codex-login";
      this.invalidateAgentSetupReadiness("codex-cli");
      await this.plugin.saveSettings(true);
      await this.plugin.reconnectCodex();
      this.scheduleDisplay();
    };

    const add = header.createEl("button", {
      cls: "codex-resource-refresh",
      text: copy.providers.add,
      attr: { type: "button", title: copy.providers.addTitle }
    });
    add.onclick = async () => {
      const defaultProviderModel = this.plugin.settings.defaultModel
        || this.plugin.lastStatus?.models.find((model) => model.isDefault)?.model
        || this.plugin.lastStatus?.models[0]?.model
        || "gpt-5.4";
      const provider: ApiProviderConfig = {
        id: newId("provider").replace(/[^A-Za-z0-9_-]/g, "_"),
        name: copy.providers.defaultName,
        baseUrl: "https://api.openai.com/v1",
        model: defaultProviderModel,
        models: [defaultProviderModel],
        apiKey: ""
      };
      this.plugin.settings.apiProviders.push(provider);
      this.plugin.settings.activeApiProviderId = provider.id;
      this.invalidateActiveCodexProvider(provider.id);
      await this.plugin.saveSettings(true);
      this.scheduleDisplay();
    };

    if (!this.plugin.settings.apiProviders.length) {
      wrapper.createDiv({ cls: "codex-resource-empty", text: copy.providers.empty });
      return;
    }

    const body = wrapper.createDiv({ cls: "codex-api-provider-list" });
    for (const provider of this.plugin.settings.apiProviders) {
      this.renderApiProviderRow(body, provider);
    }
  }

  private renderPromptEnhancerSettings(container: HTMLElement, status: CodexStatusSnapshot | null): void {
    const settings = this.plugin.settings.promptEnhancer;
    const effectiveBackend = resolvePromptEnhancerBackend(this.plugin.settings);
    const usesCodex = effectiveBackend === "codex-cli";
    const capabilities = promptEnhancerBackendCapabilities(effectiveBackend);
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager codex-prompt-enhancer-settings" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "sparkles");
    title.createSpan({ text: "提示词增强" });

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: `内置子代理 ${ENHANCE_PROMPT_AGENT_NAME} 只处理侧边栏输入框文字：无工具、无文件上下文、无写作候选确认。结果会回填输入框，发送前仍可编辑。`
    });

    this.decorateSetting(new Setting(wrapper).setName("启用增强提示词").setDesc("控制侧边栏左下角星号按钮。").addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(wrapper).setName("增强 Agent 后端").setDesc("独立于顶部主 Agent，只用于提示词增强。").addDropdown((dropdown) => {
      dropdown.addOption("codex-cli", "默认（Codex）");
      for (const definition of AGENT_BACKEND_DEFINITIONS) {
        if (definition.kind !== "codex-cli") dropdown.addOption(definition.kind, definition.label);
      }
      dropdown.setValue(effectiveBackend);
      dropdown.onChange(async (value) => {
        const nextBackend = value === "opencode" || value === "hermes" ? value : "codex-cli";
        if (nextBackend !== effectiveBackend) {
          settings.providerId = "";
          settings.model = "";
          settings.agent = "";
        }
        settings.backend = nextBackend;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
    }), "route");

    const backendModels = effectiveBackend === "opencode" ? this.openCodeModelChoices : [];
    const modelChoices = promptEnhancerModelChoices(
      this.plugin.settings,
      status?.models.map((model) => model.model) ?? [],
      backendModels
    );
    const configuredModelId = promptEnhancerModelId(effectiveBackend, settings.providerId, settings.model);
    const automaticModelLabel = `自动（${resolvePromptEnhancerModel(this.plugin.settings, effectiveBackend)}）`;
    const modelSetting = new Setting(wrapper).setName("增强模型").setDesc("这是提示词增强自己的模型设置，不影响普通聊天或编辑区写作。").addDropdown((dropdown) => {
      dropdown.addOption("", automaticModelLabel);
      for (const model of modelChoices) dropdown.addOption(model, model);
      dropdown.setValue(configuredModelId && modelChoices.includes(configuredModelId) ? configuredModelId : DEFAULT_PROMPT_ENHANCER_MODEL);
      dropdown.onChange(async (value) => {
        if (!value) {
          settings.providerId = "";
          settings.model = "";
          await this.plugin.saveSettings();
          return;
        }
        const parsed = parsePromptEnhancerModelId(effectiveBackend, value);
        if (!parsed) {
          new Notice("模型 ID 格式无效，请重新新增");
          this.scheduleDisplay();
          return;
        }
        settings.providerId = parsed.providerId;
        settings.model = parsed.modelId;
        await this.plugin.saveSettings();
      });
    }).addButton((button) => {
      button
        .setButtonText("新增模型")
        .setIcon("plus")
        .setTooltip("输入模型 ID 并加入增强模型列表")
        .onClick(() => void this.addPromptEnhancerModel(effectiveBackend));
      button.buttonEl.createSpan({ text: "新增模型" });
    });
    modelSetting.settingEl.addClass("codex-prompt-enhancer-choice-setting");
    this.decorateSetting(modelSetting, "box");

    if (capabilities.reasoning) {
      this.decorateSetting(new Setting(wrapper).setName("思考强度").setDesc("控制提示词增强的推理深度；建议使用中等，兼顾质量与速度。").addDropdown((dropdown) => {
        dropdown.addOption("low", "低");
        dropdown.addOption("medium", "中等（推荐）");
        dropdown.addOption("high", "高");
        dropdown.addOption("xhigh", "极高");
        dropdown.setValue(settings.reasoning);
        dropdown.onChange(async (value) => {
          settings.reasoning = value as ReasoningEffort;
          await this.plugin.saveSettings();
        });
      }), "brain");
    }

    if (capabilities.serviceTier) {
      this.decorateSetting(new Setting(wrapper).setName("响应速度").setDesc("控制 Codex 提示词增强的响应档位；建议使用快速。").addDropdown((dropdown) => {
        dropdown.addOption("standard", "标准");
        dropdown.addOption("fast", "快速（推荐）");
        dropdown.addOption("flex", "弹性");
        dropdown.setValue(settings.serviceTier);
        dropdown.onChange(async (value) => {
          settings.serviceTier = value as ServiceTierChoice;
          await this.plugin.saveSettings();
        });
      }), "gauge");
    }

    if (!usesCodex) this.renderPromptEnhancerAgentPicker(wrapper, effectiveBackend);

    this.renderPromptEnhancerMetaPrompt(wrapper);

    this.addEditorActionNumber(wrapper, "输入长度上限", settings.maxInputChars, 100, 20000, async (value) => {
      settings.maxInputChars = value;
      await this.plugin.saveSettings();
    });
    this.addEditorActionNumber(wrapper, "超时秒数", Math.round(settings.timeoutMs / 1000), 10, 300, async (value) => {
      settings.timeoutMs = value * 1000;
      await this.plugin.saveSettings();
    });
  }

  private async addPromptEnhancerModel(backend: AgentBackendMode): Promise<void> {
    const hint = backend === "codex-cli"
      ? "输入 Codex 模型 ID，例如 gpt-5.6-terra"
      : backend === "opencode"
        ? "输入完整模型 ID，例如 opencode/deepseek-v4-flash-free"
        : "输入完整模型 ID，例如 deepseek/deepseek-v4-flash";
    const value = await textInputModal(this.app, "新增增强模型", hint);
    if (value === null) return;
    const parsed = parsePromptEnhancerModelId(backend, value);
    if (!parsed) {
      new Notice(backend === "codex-cli"
        ? "模型 ID 无效，请输入不含空格的模型 ID"
        : "模型 ID 无效，请使用 provider/model 格式");
      return;
    }

    const settings = this.plugin.settings.promptEnhancer;
    const models = settings.customModelIds[backend];
    if (!models.includes(parsed.id)) models.push(parsed.id);
    settings.providerId = parsed.providerId;
    settings.model = parsed.modelId;
    await this.plugin.saveSettings();
    this.scheduleDisplay();
    new Notice(`已新增并选择增强模型：${parsed.id}`);
  }

  private renderPromptEnhancerAgentPicker(container: HTMLElement, backend: Exclude<AgentBackendMode, "codex-cli">): void {
    const settings = this.plugin.settings.promptEnhancer;
    const current = settings.agent.trim();
    if (backend === "opencode") {
      const choices = this.openCodeAgentChoices.filter((agent) => agent.mode !== "subagent");
      const values = new Set(choices.map((agent) => openCodeAgentChoiceValue(agent)));
      const setting = new Setting(container)
        .setName("增强 Agent")
        .setDesc(`自动模式使用隔离的内置 ${ENHANCE_PROMPT_AGENT_NAME}；只允许选择可直接运行的 primary/all Agent。`)
        .addDropdown((dropdown) => {
          dropdown.addOption("", `自动（内置 ${ENHANCE_PROMPT_AGENT_NAME}）`);
          if (current && !values.has(current)) dropdown.addOption(current, `当前配置：${current}`);
          for (const agent of choices) {
            dropdown.addOption(openCodeAgentChoiceValue(agent), openCodeAgentChoiceLabel(agent, this.plugin.settings.settingsLanguage));
          }
          dropdown.setValue(current);
          dropdown.onChange(async (value) => {
            settings.agent = parseOpenCodeAgentChoiceValue(value) ?? "";
            await this.plugin.saveSettings();
          });
        })
        .addButton((button) => {
          const label = this.openCodeAgentsLoading ? "读取中" : "刷新";
          button
            .setButtonText(label)
            .setIcon("refresh-cw")
            .setTooltip("读取 OpenCode 可直接运行的 Agent 和模型")
            .setDisabled(this.openCodeAgentsLoading || this.openCodeModelsLoading)
            .onClick(() => void this.refreshPromptEnhancerOpenCodeOptions());
          button.buttonEl.createSpan({ text: label });
        });
      setting.settingEl.addClass("codex-prompt-enhancer-choice-setting");
      this.decorateSetting(setting, "bot");
      return;
    }

    const topProfile = this.plugin.settings.agents.hermes.profile.trim();
    const profiles = Array.from(new Set([topProfile, current].filter(Boolean)));
    const automaticLabel = topProfile ? `自动（跟随顶部：${topProfile}）` : "自动（跟随顶部 Hermes Profile）";
    const setting = new Setting(container)
      .setName("增强 Profile")
      .setDesc("复用顶部 Hermes 已配置的 Profile，不在这里重复输入连接或登录信息。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", automaticLabel);
        for (const profile of profiles) dropdown.addOption(profile, profile);
        dropdown.setValue(current);
        dropdown.onChange(async (value) => {
          settings.agent = value.trim();
          await this.plugin.saveSettings();
        });
      });
    setting.settingEl.addClass("codex-prompt-enhancer-choice-setting");
    this.decorateSetting(setting, "user-round");
  }

  private renderPromptEnhancerMetaPrompt(container: HTMLElement): void {
    const details = container.createEl("details", { cls: "codex-prompt-enhancer-meta" });
    const summary = details.createEl("summary", { cls: "codex-prompt-enhancer-meta-summary" });
    const icon = summary.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "file-text");
    summary.createSpan({ text: "查看内置 Meta-Prompt" });
    details.createDiv({
      cls: "codex-resource-note",
      text: "这是提示词增强的默认提示词。它不是外部文件；当前版本内置在插件代码里。"
    });
    const actions = details.createDiv({ cls: "codex-prompt-enhancer-meta-actions" });
    const copyButton = actions.createEl("button", {
      cls: "codex-resource-refresh",
      text: "复制",
      attr: { type: "button" }
    });
    copyButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(ENHANCE_META_PROMPT);
        new Notice("已复制内置 Meta-Prompt");
      } catch (error) {
        new Notice(`复制失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const textarea = details.createEl("textarea", {
      cls: "codex-api-provider-textarea codex-prompt-enhancer-meta-text",
      attr: { readonly: "true" }
    }) as HTMLTextAreaElement;
    textarea.value = ENHANCE_META_PROMPT;
  }

  private renderEditorActionSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.editorActions;

    this.decorateSetting(
      new Setting(container)
        .setName(copy.writing.requestMode)
        .setDesc(copy.writing.requestModeDesc),
      "terminal"
    );

    const configuredBackend = this.plugin.settings.capabilities.editorActionBackend;
    const editorBackend = configuredBackend === "default" ? "codex-cli" : configuredBackend;
    this.decorateSetting(new Setting(container).setName("写作 Agent 后端").setDesc("独立于顶部主 Agent，只用于改写、扩写、续写等编辑区小功能。").addDropdown((dropdown) => {
      for (const definition of AGENT_BACKEND_DEFINITIONS) dropdown.addOption(definition.kind, definition.label);
      dropdown.setValue(editorBackend);
      dropdown.onChange(async (value) => {
        this.plugin.settings.capabilities.editorActionBackend = value === "opencode" || value === "hermes" ? value : "codex-cli";
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
    }), "route");

    this.decorateSetting(new Setting(container).setName(copy.writing.enabled).setDesc(copy.writing.enabledDesc).addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(container).setName(copy.writing.statusSlot).setDesc(copy.writing.statusSlotDesc).addToggle((toggle) =>
      toggle.setValue(settings.statusSlotEnabled).onChange(async (value) => {
        settings.statusSlotEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "activity");

    this.decorateSetting(new Setting(container).setName(copy.writing.contextPanel).setDesc(copy.writing.contextPanelDesc).addToggle((toggle) =>
      toggle.setValue(settings.showContextPanel).onChange(async (value) => {
        settings.showContextPanel = value;
        await this.plugin.saveSettings();
      })
    ), "file-search");

    this.decorateSetting(new Setting(container).setName(copy.writing.quality).setDesc(copy.writing.qualityDesc).addDropdown((dropdown) => {
      for (const mode of EDITOR_ACTION_QUALITY_MODES) dropdown.addOption(mode.id, copy.writing.qualityModes[mode.id].label);
      dropdown.setValue(settings.qualityMode);
      dropdown.onChange(async (value) => {
        settings.qualityMode = normalizeEditorActionQualityMode(value, "quality");
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
    }), "gauge");

    this.decorateSetting(new Setting(container).setName(copy.writing.style).addDropdown((dropdown) => {
      for (const style of settings.styles) dropdown.addOption(style.id, style.label || style.id);
      dropdown.setValue(settings.defaultStyleId);
      dropdown.onChange(async (value) => {
        settings.defaultStyleId = value;
        await this.plugin.saveSettings();
      });
    }), "palette");

    this.addEditorActionNumber(container, copy.writing.maxSelectedChars, settings.maxSelectedChars, 200, 20000, async (value) => {
      settings.maxSelectedChars = value;
      await this.plugin.saveSettings();
    });
    this.addEditorActionNumber(container, copy.writing.timeoutSeconds, Math.round(settings.timeoutMs / 1000), 10, 300, async (value) => {
      settings.timeoutMs = value * 1000;
      await this.plugin.saveSettings();
    });

    this.renderEditorActionModeConfigs(container);

    this.decorateSetting(new Setting(container).setName(copy.writing.cache).setDesc(copy.writing.cacheDesc(Object.keys(settings.articleUnderstandingCache).length)).addButton((button) =>
      button.setButtonText(copy.common.clear).setIcon("trash-2").onClick(async () => {
        settings.articleUnderstandingCache = {};
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      })
    ), "database");

    this.renderEditorActionList(container, settings.actions);
    this.renderEditorStyleList(container, settings.styles);
  }

  private renderEditorActionList(container: HTMLElement, actions: EditorAiActionConfig[]): void {
    const copy = this.copy;
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: copy.writing.actionsHeading });
    for (const action of actions) {
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-action-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, editorActionIcon(action.id));
      title.createSpan({ text: action.label || action.id });
      title.createSpan({ cls: "codex-resource-row-meta", text: action.enabled ? copy.writing.enabledMeta : copy.writing.disabledMeta });
      const toggleWrap = head.createDiv({ cls: "codex-api-provider-actions" });
      new Setting(toggleWrap).addToggle((toggle) =>
        toggle.setValue(action.enabled).onChange(async (value) => {
          action.enabled = value;
          await this.plugin.saveSettings();
          this.scheduleDisplay();
        })
      );
      this.addProviderText(row, copy.writing.name, action.label, copy.writing.actionNamePlaceholder, async (value) => {
        action.label = value.trim() || action.id;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
      this.addProviderTextArea(row, copy.writing.promptTemplate, action.promptTemplate, copy.writing.promptPlaceholder, async (value) => {
        action.promptTemplate = value.trim();
        await this.plugin.saveSettings();
      });
    }
  }

  private renderEditorActionModeConfigs(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.editorActions;
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: copy.writing.qualityModesHeading });
    const modelChoices = this.editorActionModelChoices();
    for (const mode of EDITOR_ACTION_QUALITY_MODES) {
      const config = settings.modeConfigs[mode.id];
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-mode-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, mode.icon);
      title.createSpan({ text: copy.writing.qualityModes[mode.id].label });
      title.createSpan({ cls: "codex-resource-row-meta", text: copy.writing.qualityModes[mode.id].desc });

      const backend = this.plugin.settings.capabilities.editorActionBackend === "default"
        ? "codex-cli"
        : this.plugin.settings.capabilities.editorActionBackend;
      const autoLabel = backend === "codex-cli"
        ? `自动（${DEFAULT_CODEX_UTILITY_MODEL}）`
        : backend === "opencode"
          ? `自动（${DEFAULT_OPENCODE_UTILITY_MODEL}）`
          : `自动（${DEFAULT_HERMES_UTILITY_MODEL}）`;
      this.decorateSetting(new Setting(row).setName(copy.writing.model).setDesc("该档位自己的模型覆盖；留空使用写作 Agent 的小能力默认模型。").addDropdown((dropdown) => {
        dropdown.addOption("", autoLabel);
        for (const model of ensureModelChoices(modelChoices, config.model)) {
          if (model.model) dropdown.addOption(model.model, model.displayName || model.model);
        }
        dropdown.setValue(config.model);
        dropdown.onChange(async (value) => {
          config.model = value;
          await this.plugin.saveSettings();
        });
      }), "box");
      this.addEditorActionNumber(row, copy.writing.contextBefore, config.contextCharsBefore, 0, 10000, async (value) => {
        config.contextCharsBefore = value;
        if (mode.id === "fast") settings.contextCharsBefore = value;
        await this.plugin.saveSettings();
      });
      this.addEditorActionNumber(row, copy.writing.contextAfter, config.contextCharsAfter, 0, 10000, async (value) => {
        config.contextCharsAfter = value;
        if (mode.id === "fast") settings.contextCharsAfter = value;
        await this.plugin.saveSettings();
      });
    }
  }

  private editorActionModelChoices(): CodexModel[] {
    const configured = this.plugin.settings.capabilities.editorActionBackend;
    const backend = configured === "opencode" || configured === "hermes" ? configured : "codex-cli";
    if (backend === "opencode") {
      const models = this.openCodeModelChoices.map((model) => ({
        id: model.id,
        model: model.modelId,
        displayName: model.displayName || `${model.providerId}/${model.modelId}`
      }));
      return ensureModelChoices(models, DEFAULT_OPENCODE_UTILITY_MODEL, this.plugin.settings.opencode.modelId);
    }
    if (backend === "hermes") {
      const model = this.plugin.settings.agents.hermes.modelId;
      return ensureModelChoices([], model);
    }
    return ensureModelChoices(this.plugin.lastStatus?.models ?? [], DEFAULT_CODEX_UTILITY_MODEL);
  }

  private renderEditorStyleList(container: HTMLElement, styles: EditorAiStyleConfig[]): void {
    const copy = this.copy;
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    const header = section.createDiv({ cls: "codex-resource-manager-header" });
    header.createDiv({ cls: "codex-editor-actions-heading", text: copy.writing.stylesHeading });
    const add = header.createEl("button", {
      cls: "codex-resource-refresh",
      text: copy.writing.addStyle,
      attr: { type: "button" }
    });
    add.onclick = async () => {
      const id = `style_${Date.now()}`;
      styles.push({ id, label: copy.writing.defaultStyleLabel, instruction: copy.writing.defaultStyleInstruction });
      this.plugin.settings.editorActions.defaultStyleId = id;
      await this.plugin.saveSettings(true);
      this.scheduleDisplay();
    };

    for (const style of styles) {
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-style-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, "palette");
      title.createSpan({ text: style.label || style.id });
      title.createSpan({ cls: "codex-resource-row-meta", text: style.id });
      const actions = head.createDiv({ cls: "codex-api-provider-actions" });
      if (!DEFAULT_SETTINGS.editorActions.styles.some((item) => item.id === style.id)) {
        const remove = actions.createEl("button", { cls: "codex-resource-tab", text: copy.common.delete, attr: { type: "button" } });
        remove.onclick = async () => {
          this.plugin.settings.editorActions.styles = styles.filter((item) => item.id !== style.id);
          if (this.plugin.settings.editorActions.defaultStyleId === style.id) this.plugin.settings.editorActions.defaultStyleId = "clear";
          await this.plugin.saveSettings(true);
          this.scheduleDisplay();
        };
      }
      this.addProviderText(row, copy.writing.name, style.label, copy.writing.styleNamePlaceholder, async (value) => {
        style.label = value.trim() || style.id;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      });
      this.addProviderTextArea(row, copy.writing.styleInstruction, style.instruction, copy.writing.styleInstructionPlaceholder, async (value) => {
        style.instruction = value.trim();
        await this.plugin.saveSettings();
      });
    }
  }

  private renderApiProviderRow(container: HTMLElement, provider: ApiProviderConfig): void {
    const copy = this.copy;
    const activeProvider = getActiveApiProvider(this.plugin.settings);
    const row = container.createDiv({
      cls: `codex-api-provider-row ${activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api" ? "is-active" : ""}`
    });
    const head = row.createDiv({ cls: "codex-api-provider-head" });
    const title = head.createDiv({ cls: "codex-api-provider-title" });
    const icon = title.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, "key-round");
    title.createSpan({ text: provider.name || copy.providers.unnamed });
    title.createSpan({ cls: "codex-resource-row-meta", text: providerModelLabel(provider, this.plugin.settings.settingsLanguage) });

    const actions = head.createDiv({ cls: "codex-api-provider-actions" });
    const enable = actions.createEl("button", {
      cls: "codex-resource-tab",
      text: activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api" ? copy.providers.active : copy.providers.enableReconnect,
      attr: { type: "button" }
    });
    enable.onclick = async () => {
      const errors = validateApiProvider(provider, this.plugin.settings.settingsLanguage);
      if (errors.length) {
        new Notice(copy.common.enableFailed(errors));
        return;
      }
      this.plugin.settings.providerMode = "custom-api";
      this.plugin.settings.activeApiProviderId = provider.id;
      this.invalidateAgentSetupReadiness("codex-cli");
      await this.plugin.saveSettings(true);
      await this.plugin.reconnectCodex();
      this.scheduleDisplay();
    };

    const remove = actions.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.common.delete,
      attr: { type: "button" }
    });
    remove.onclick = async () => {
      if (!window.confirm(copy.providers.deleteConfirm(provider.name))) return;
      const wasActive = this.plugin.settings.providerMode === "custom-api" && this.plugin.settings.activeApiProviderId === provider.id;
      removeApiProvider(this.plugin.settings, provider.id);
      if (wasActive) this.invalidateAgentSetupReadiness("codex-cli");
      await this.plugin.saveSettings(true);
      if (wasActive) await this.plugin.reconnectCodex();
      this.scheduleDisplay();
    };

    this.addProviderText(row, copy.providers.name, provider.name, copy.providers.namePlaceholder, async (value) => {
      provider.name = value.trim();
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    });
    this.addProviderText(row, copy.providers.baseUrl, provider.baseUrl, "https://api.openai.com/v1", async (value) => {
      provider.baseUrl = value.trim();
      this.invalidateActiveCodexProvider(provider.id);
      await this.plugin.saveSettings();
    });
    row.createDiv({ cls: "codex-resource-note", text: copy.providers.responseApiRequirement });
    this.addProviderTextArea(row, copy.providers.models, getApiProviderModels(provider).join("\n"), "gpt-5.4\ngpt-5.5", async (value) => {
      const models = parseModelList(value);
      provider.models = models;
      provider.model = models[0] ?? "";
      this.invalidateActiveCodexProvider(provider.id);
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    });
    this.addProviderText(row, copy.providers.apiKey, provider.apiKey, "sk-...", async (value) => {
      provider.apiKey = value.trim();
      this.invalidateActiveCodexProvider(provider.id);
      await this.plugin.saveSettings();
    }, "password");
    this.addProviderTextArea(row, copy.providers.queryParams, formatQueryParams(provider.queryParams), "api-version=2026-04-28", async (value) => {
      provider.queryParams = parseQueryParams(value);
      if (!Object.keys(provider.queryParams).length) delete provider.queryParams;
      this.invalidateActiveCodexProvider(provider.id);
      await this.plugin.saveSettings();
    });

    const errors = validateApiProvider(provider, this.plugin.settings.settingsLanguage);
    if (errors.length) row.createDiv({ cls: "codex-resource-error", text: copy.common.missing(errors) });
    if (activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api") {
      row.createDiv({ cls: "codex-resource-note", text: copy.providers.configChanged });
    }
  }

  private addProviderText(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => Promise<void>,
    type: "text" | "password" = "text"
  ): void {
    const field = container.createDiv({ cls: "codex-api-provider-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: label });
    const input = field.createEl("input", {
      cls: "codex-api-provider-input",
      attr: { type, placeholder, value }
    }) as HTMLInputElement;
    input.onchange = () => void onChange(input.value);
  }

  private addOpenCodeModelPicker(container: HTMLElement): void {
    const copy = this.copy;
    const opencode = this.plugin.settings.opencode;
    const currentValue = opencode.providerId && opencode.modelId
      ? openCodeModelChoiceValue({ providerId: opencode.providerId, modelId: opencode.modelId })
      : "";
    const field = container.createDiv({ cls: "codex-api-provider-field codex-opencode-model-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: copy.opencode.model });
    const controls = field.createDiv({ cls: "codex-opencode-model-picker" });
    const values = new Set(this.openCodeModelChoices.map((model) => openCodeModelChoiceValue(model)));

    if (this.openCodeModelsLoaded && this.openCodeModelChoices.length) {
      const select = controls.createEl("select", {
        cls: "codex-api-provider-input codex-opencode-model-select",
        attr: { "aria-label": copy.opencode.chooseModel, title: copy.opencode.chooseModel }
      }) as HTMLSelectElement;
      if (!currentValue) {
        select.createEl("option", { text: copy.opencode.chooseModel, value: "" });
      } else if (!values.has(currentValue)) {
        select.createEl("option", { text: copy.opencode.currentModelMissing(opencode.providerId, opencode.modelId), value: currentValue });
      }
      for (const model of this.openCodeModelChoices) {
        select.createEl("option", { text: openCodeModelChoiceLabel(model, this.plugin.settings.settingsLanguage), value: openCodeModelChoiceValue(model) });
      }
      select.value = currentValue && (values.has(currentValue) || opencode.providerId) ? currentValue : "";
      select.onchange = async () => {
        const parsed = parseOpenCodeModelChoiceValue(select.value);
        if (!parsed) return;
        const selected = this.openCodeModelChoices.find((model) => model.providerId === parsed.providerId && model.modelId === parsed.modelId);
        if (!selected) return;
        this.applyOpenCodeModelChoice(selected);
        this.invalidateAgentSetupReadiness("opencode");
        await this.plugin.saveSettings(true);
      };
    } else {
      controls.createDiv({
        cls: "codex-resource-note codex-opencode-model-empty",
        text: this.openCodeModelsLoading ? copy.opencode.modelLoading : copy.opencode.refreshModelHint
      });
    }

    const refresh = controls.createEl("button", {
      cls: "codex-resource-tab",
      text: this.openCodeModelsLoading ? copy.common.loading : copy.opencode.refreshModels,
      attr: { type: "button" }
    });
    refresh.disabled = this.openCodeModelsLoading;
    refresh.onclick = () => void this.refreshOpenCodeModels();

    const selectedModel = this.openCodeModelChoices.find((model) => model.providerId === opencode.providerId && model.modelId === opencode.modelId);
    field.createDiv({
      cls: "codex-resource-note codex-opencode-model-note",
      text: selectedModel
        ? copy.opencode.selectedModel(selectedModel.displayName, openCodeModelCapabilityLabel(selectedModel, this.plugin.settings.settingsLanguage))
        : copy.opencode.modelNote
    });
  }

  private addOpenCodeAgentPicker(container: HTMLElement): void {
    const copy = this.copy;
    const opencode = this.plugin.settings.opencode;
    const currentValue = opencode.agent?.trim() || "build";
    const field = container.createDiv({ cls: "codex-api-provider-field codex-opencode-agent-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: copy.opencode.agent });
    const controls = field.createDiv({ cls: "codex-opencode-model-picker" });
    const values = new Set(this.openCodeAgentChoices.map((agent) => openCodeAgentChoiceValue(agent)));

    if (this.openCodeAgentsLoaded && this.openCodeAgentChoices.length) {
      const select = controls.createEl("select", {
        cls: "codex-api-provider-input codex-opencode-model-select",
        attr: { "aria-label": copy.opencode.chooseAgent, title: copy.opencode.chooseAgent }
      }) as HTMLSelectElement;
      if (!values.has(currentValue)) {
        select.createEl("option", { text: copy.opencode.currentAgentMissing(currentValue), value: currentValue });
      }
      for (const agent of this.openCodeAgentChoices) {
        select.createEl("option", { text: openCodeAgentChoiceLabel(agent, this.plugin.settings.settingsLanguage), value: openCodeAgentChoiceValue(agent) });
      }
      select.value = currentValue;
      select.onchange = async () => {
        const selectedName = parseOpenCodeAgentChoiceValue(select.value);
        if (!selectedName) return;
        const selected = this.openCodeAgentChoices.find((agent) => agent.name === selectedName);
        opencode.agent = selected?.name ?? selectedName;
        this.invalidateAgentSetupReadiness("opencode");
        await this.plugin.saveSettings(true);
      };
    } else {
      const input = controls.createEl("input", {
        cls: "codex-api-provider-input codex-opencode-model-select",
        attr: {
          type: "text",
          placeholder: "build",
          value: currentValue,
          "aria-label": copy.opencode.manualAgent
        }
      }) as HTMLInputElement;
      input.onchange = async () => {
        opencode.agent = input.value.trim() || "build";
        this.invalidateAgentSetupReadiness("opencode");
        await this.plugin.saveSettings(true);
      };
    }

    const refresh = controls.createEl("button", {
      cls: "codex-resource-tab",
      text: this.openCodeAgentsLoading ? copy.common.loading : copy.opencode.refreshAgent,
      attr: { type: "button" }
    });
    refresh.disabled = this.openCodeAgentsLoading;
    refresh.onclick = () => void this.refreshOpenCodeAgents();

    const selectedAgent = this.openCodeAgentChoices.find((agent) => agent.name === currentValue);
    field.createDiv({
      cls: "codex-resource-note codex-opencode-model-note",
      text: selectedAgent
        ? copy.opencode.selectedAgent(selectedAgent.name, openCodeAgentModeLabel(selectedAgent, this.plugin.settings.settingsLanguage), selectedAgent.description ?? "")
        : this.openCodeAgentsLoaded
          ? copy.opencode.agentMissing(currentValue)
          : copy.opencode.agentHint
    });
  }

  private async refreshOpenCodeModels(): Promise<void> {
    await this.refreshOpenCodeRuntimeOptions({ models: true, agents: false });
  }

  private async refreshOpenCodeAgents(): Promise<void> {
    await this.refreshOpenCodeRuntimeOptions({ models: false, agents: true });
  }

  private async refreshPromptEnhancerOpenCodeOptions(): Promise<void> {
    await this.refreshOpenCodeRuntimeOptions({ models: true, agents: true, syncConfiguredSelection: false });
  }

  private async refreshOpenCodeRuntimeOptions(options: {
    models?: boolean;
    agents?: boolean;
    syncConfiguredSelection?: boolean;
  } = { models: true, agents: true }): Promise<void> {
    const copy = this.copy;
    const setupConfigBeforeRefresh = [
      this.plugin.settings.opencode.providerId,
      this.plugin.settings.opencode.modelId,
      this.plugin.settings.opencode.agent
    ].join("\u0000");
    const shouldLoadModels = options.models !== false;
    const shouldLoadAgents = options.agents !== false;
    const syncConfiguredSelection = options.syncConfiguredSelection !== false;
    if ((shouldLoadModels && this.openCodeModelsLoading) || (shouldLoadAgents && this.openCodeAgentsLoading)) return;
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    if (shouldLoadModels) {
      this.openCodeModelsLoading = true;
      this.openCodeModelsError = "";
    }
    if (shouldLoadAgents) {
      this.openCodeAgentsLoading = true;
      this.openCodeAgentsError = "";
    }
    this.scheduleDisplay();
    try {
      await backend.connect();
      const opencode = this.plugin.settings.opencode;
      if (shouldLoadModels) {
        const models = await backend.listModels();
        this.openCodeModelChoices = models;
        this.openCodeModelsLoaded = true;
        if (syncConfiguredSelection) {
          const current = models.find((model) => model.providerId === opencode.providerId && model.modelId === opencode.modelId);
          if (current) this.applyOpenCodeModelChoice(current);
        }
      }
      if (shouldLoadAgents) {
        const agents = await backend.listAgents();
        this.openCodeAgentChoices = agents;
        this.openCodeAgentsLoaded = true;
        if (syncConfiguredSelection) {
          const current = agents.find((agent) => agent.name === opencode.agent);
          if (current) opencode.agent = current.name;
          if (!opencode.agent && agents[0]) opencode.agent = agents[0].name;
        }
      }
      opencode.lastConnectedAt = Date.now();
      opencode.lastError = "";
      const setupConfigAfterRefresh = [opencode.providerId, opencode.modelId, opencode.agent].join("\u0000");
      if (setupConfigAfterRefresh !== setupConfigBeforeRefresh) this.invalidateAgentSetupReadiness("opencode");
      await this.plugin.saveSettings(true);
      const notices: string[] = [];
      if (shouldLoadModels) notices.push(copy.opencode.modelsCount(this.openCodeModelChoices.length));
      if (shouldLoadAgents) notices.push(copy.opencode.agentsCount(this.openCodeAgentChoices.length));
      new Notice(copy.opencode.readSuccess(notices));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldLoadModels) this.openCodeModelsError = message;
      if (shouldLoadAgents) this.openCodeAgentsError = message;
      this.plugin.settings.opencode.lastError = message;
      await this.plugin.saveSettings(true);
      new Notice(copy.opencode.readFailed(message));
    } finally {
      await backend.disconnect().catch(swallowError("disconnect OpenCode settings backend"));
      if (shouldLoadModels) this.openCodeModelsLoading = false;
      if (shouldLoadAgents) this.openCodeAgentsLoading = false;
      this.scheduleDisplay();
    }
  }

  private applyOpenCodeModelChoice(model: AgentModelInfo): void {
    const opencode = this.plugin.settings.opencode;
    opencode.providerId = model.providerId;
    opencode.modelId = model.modelId;
    opencode.textEnabled = model.inputModalities.includes("text");
    opencode.imageEnabled = model.inputModalities.includes("image");
    opencode.pdfEnabled = model.inputModalities.includes("pdf");
  }

  private addKnowledgeBaseRulesFilePicker(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.knowledgeBase;
    const currentPath = resolveKnowledgeBaseRulesFilePath(settings);
    const field = container.createDiv({ cls: "codex-api-provider-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: copy.knowledge.rulesFile });
    const picker = field.createDiv({ cls: "codex-rules-file-picker" });
    const valueButton = picker.createEl("button", {
      cls: "codex-rules-file-value",
      attr: { type: "button", title: copy.knowledge.chooseRulesTitle }
    });
    const valueIcon = valueButton.createSpan({ cls: "codex-rules-file-icon" });
    setIcon(valueIcon, "file-cog");
    valueButton.createSpan({ text: currentPath });
    valueButton.onclick = () => this.openKnowledgeBaseRulesFilePicker();

    const chooseButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.chooseFile,
      attr: { type: "button" }
    });
    chooseButton.onclick = () => this.openKnowledgeBaseRulesFilePicker();

    const resetButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.useRulesFile(DEFAULT_KNOWLEDGE_BASE_RULES_FILE),
      attr: { type: "button" }
    });
    resetButton.disabled = currentPath === DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
    resetButton.onclick = async () => {
      settings.useCustomRulesFile = true;
      settings.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
      await this.plugin.saveSettings();
      this.scheduleDisplay();
    };

    const repairButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.repairRules,
      attr: { type: "button", title: copy.knowledge.repairRulesTitle }
    });
    repairButton.onclick = () => void this.repairKnowledgeBaseRulesFile();

    field.createDiv({
      cls: "codex-resource-note codex-rules-file-note",
      text: copy.knowledge.rulesFileNoteCustom(currentPath, AGENTS_RULES_FILE)
    });
  }

  private addKnowledgeBaseMemoryRecommendation(container: HTMLElement): void {
    const copy = this.copy;
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.memoryHeading });
    section.createDiv({
      cls: "codex-resource-note",
      text: copy.knowledge.memoryNote1
    });
    section.createDiv({
      cls: "codex-resource-note",
      text: copy.knowledge.memoryNote2
    });

    this.decorateSetting(new Setting(section).setName(copy.knowledge.memoryEnabled).setDesc(copy.knowledge.memoryEnabledDesc).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.memory.enabled).onChange(async (value) => {
        this.plugin.settings.memory.enabled = value;
        await this.plugin.saveSettings(true);
        this.scheduleDisplay();
      })
    ), "brain-circuit");

    this.decorateSetting(new Setting(section).setName(copy.knowledge.memoryAutoSync).setDesc(copy.knowledge.memoryAutoSyncDesc).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.memory.autoSync).onChange(async (value) => {
        this.plugin.settings.memory.autoSync = value;
        await this.plugin.saveSettings(true);
        this.scheduleDisplay();
      })
    ), "refresh-cw");

    this.decorateSetting(new Setting(section).setName(copy.knowledge.memoryCuratorBackend).setDesc(copy.knowledge.memoryCuratorBackendDesc).addDropdown((dropdown) => {
      dropdown.addOption("default", copy.knowledge.followGlobal(agentBackendLabel(this.plugin.settings.agentBackend, copy)));
      for (const definition of AGENT_BACKEND_DEFINITIONS) dropdown.addOption(definition.kind, definition.label);
      dropdown.setValue(this.plugin.settings.memory.curatorBackend);
      dropdown.onChange(async (value) => {
        this.plugin.settings.memory.curatorBackend = value === "codex-cli" || value === "opencode" || value === "hermes" ? value : "default";
        await this.plugin.saveSettings(true);
        this.scheduleDisplay();
      });
    }), "route");

    this.decorateSetting(new Setting(section).setName(copy.knowledge.memoryCuratorModel).setDesc(copy.knowledge.memoryCuratorModelDesc).addText((text) => {
      text.setPlaceholder(DEFAULT_CODEX_UTILITY_MODEL).setValue(this.plugin.settings.memory.curatorModel).onChange(async (value) => {
        this.plugin.settings.memory.curatorModel = value.trim();
        await this.plugin.saveSettings();
      });
    }), "box");

    const status = section.createDiv({ cls: "codex-api-provider-row" });
    if (!this.memoryStatus && !this.memoryStatusLoading && !this.memoryStatusError) void this.loadMemoryStatus();
    if (this.memoryStatusLoading && !this.memoryStatus) {
      status.createDiv({ cls: "codex-resource-note", text: copy.common.loading });
    } else if (this.memoryStatus) {
      status.createDiv({
        cls: "codex-resource-note",
        text: copy.knowledge.memoryStatusLine(
          this.memoryStatus.initialized,
          this.memoryStatus.revision,
          this.memoryStatus.pendingEventCount,
          this.memoryStatus.confirmations.length,
          this.memoryStatus.transactionIssues.length
        )
      });
      status.createDiv({
        cls: this.memoryStatus.lastError ? "codex-resource-error" : "codex-resource-note",
        text: copy.knowledge.memoryLastSync(
          this.memoryStatus.lastOutcome,
          this.memoryStatus.lastSyncAt ? new Date(this.memoryStatus.lastSyncAt).toLocaleString() : ""
        )
      });
      if (this.memoryStatus.lastError) status.createDiv({ cls: "codex-resource-error", text: this.memoryStatus.lastError });
    }
    if (this.memoryStatusError) {
      status.createDiv({ cls: "codex-resource-error", text: copy.knowledge.memoryStatusFailed(this.memoryStatusError) });
    }

    const actions = section.createDiv({ cls: "codex-api-provider-actions" });
    const reload = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryReload, attr: { type: "button" } });
    reload.disabled = this.memoryStatusLoading || this.memoryActionRunning;
    reload.onclick = () => void this.loadMemoryStatus(true);

    const initialize = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryInitialize, attr: { type: "button" } });
    initialize.disabled = this.memoryActionRunning;
    initialize.onclick = () => void this.runMemoryAction(async () => {
      await this.plugin.initializeEchoInkMemory();
      new Notice(copy.knowledge.memoryInitialize);
    });

    const sync = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memorySync, attr: { type: "button" } });
    sync.disabled = this.memoryActionRunning || !this.memoryStatus?.initialized;
    sync.onclick = () => void this.runMemoryAction(async () => {
      const result = await this.plugin.syncEchoInkMemoryNow();
      if (result.outcome !== "no-pending" && result.outcome !== "no-op") new Notice(`${copy.knowledge.memorySync}: ${result.outcome}`);
    });

    const recover = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryRecover, attr: { type: "button" } });
    recover.disabled = this.memoryActionRunning || (!this.memoryStatusError && !this.memoryStatus?.initialized);
    recover.onclick = () => void this.runMemoryAction(async () => {
      await this.plugin.recoverEchoInkMemory();
      new Notice(copy.knowledge.memoryRecover);
    });

    const previewMigration = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryPreviewMigration, attr: { type: "button" } });
    previewMigration.disabled = this.memoryActionRunning;
    previewMigration.onclick = () => void this.runMemoryAction(async () => {
      this.memoryMigrationPreview = await this.plugin.previewCodexMemoryMigration();
      new Notice(this.memoryMigrationPreview.mappings.length
        ? copy.knowledge.memoryPreviewSummary(
          this.memoryMigrationPreview.mappings.length,
          this.memoryMigrationPreview.markdownFileCount,
          formatStorageBytes(this.memoryMigrationPreview.totalBytes)
        )
        : copy.knowledge.memoryNoMigration);
    }, false);

    const importMigration = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryImportMigration, attr: { type: "button" } });
    importMigration.disabled = this.memoryActionRunning || this.memoryMigrationPreview?.mappings.length === 0 || this.memoryMigrationPreview?.blocked === true;
    importMigration.onclick = () => void this.runMemoryAction(async () => {
      const preview = this.memoryMigrationPreview ?? await this.plugin.previewCodexMemoryMigration();
      if (!preview.mappings.length) {
        new Notice(copy.knowledge.memoryNoMigration);
        return;
      }
      if (preview.blocked) {
        new Notice(copy.knowledge.memoryMigrationBlocked(
          preview.markdownFileCount,
          formatStorageBytes(preview.totalBytes),
          preview.maxMarkdownFiles,
          formatStorageBytes(preview.maxTotalBytes)
        ));
        return;
      }
      const accepted = await confirmModal(
        this.app,
        copy.knowledge.memoryImportMigration,
        copy.knowledge.memoryImportConfirm(preview.markdownFileCount, formatStorageBytes(preview.totalBytes)),
        copy.knowledge.memoryImportMigration,
        copy.common.cancel
      );
      if (!accepted) return;
      const result = await this.plugin.importCodexMemory();
      new Notice(copy.knowledge.memoryImported(result.imported.length, result.skipped.length));
    });

    if (this.memoryMigrationPreview) {
      section.createDiv({
        cls: "codex-resource-note",
        text: copy.knowledge.memoryPreviewSummary(
          this.memoryMigrationPreview.mappings.length,
          this.memoryMigrationPreview.markdownFileCount,
          formatStorageBytes(this.memoryMigrationPreview.totalBytes)
        )
      });
      for (const mapping of this.memoryMigrationPreview.mappings) {
        section.createDiv({
          cls: "codex-resource-note",
          text: copy.knowledge.memoryMigrationMapping(mapping.kind, mapping.markdownFileCount, formatStorageBytes(mapping.totalBytes))
        });
      }
      if (this.memoryMigrationPreview.blocked) {
        section.createDiv({
          cls: "codex-resource-error",
          text: copy.knowledge.memoryMigrationBlocked(
            this.memoryMigrationPreview.markdownFileCount,
            formatStorageBytes(this.memoryMigrationPreview.totalBytes),
            this.memoryMigrationPreview.maxMarkdownFiles,
            formatStorageBytes(this.memoryMigrationPreview.maxTotalBytes)
          )
        });
      }
    }

    if (this.memoryStatus?.confirmations.length) {
      section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.memoryConfirmations });
      for (const confirmation of this.memoryStatus.confirmations.slice(0, 20)) {
        const row = section.createDiv({ cls: "codex-api-provider-row" });
        row.createDiv({ cls: "codex-resource-note", text: confirmation.candidate.statement });
        if (confirmation.conflictsWith.length) row.createDiv({ cls: "codex-resource-error", text: copy.knowledge.memoryConflicts(confirmation.conflictsWith.join(", ")) });
        const rowActions = row.createDiv({ cls: "codex-api-provider-actions" });
        const accept = rowActions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryAccept, attr: { type: "button" } });
        accept.onclick = () => void this.runMemoryAction(async () => { await this.plugin.resolveEchoInkMemoryConfirmation(confirmation.id, "accept"); });
        const dismiss = rowActions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryDismiss, attr: { type: "button" } });
        dismiss.onclick = () => void this.runMemoryAction(async () => { await this.plugin.resolveEchoInkMemoryConfirmation(confirmation.id, "dismiss"); });
      }
    }

    if (this.memoryStatus?.transactionIssues.length) {
      section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.memoryIssues });
      for (const issue of this.memoryStatus.transactionIssues.slice(0, 20)) {
        const row = section.createDiv({ cls: "codex-api-provider-row" });
        row.createDiv({ cls: "codex-resource-note", text: `${issue.state} · ${issue.transactionId}` });
        if (issue.error) row.createDiv({ cls: "codex-resource-error", text: issue.error });
        const rowActions = row.createDiv({ cls: "codex-api-provider-actions" });
        const retry = rowActions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryRetry, attr: { type: "button" } });
        retry.onclick = () => void this.runMemoryAction(async () => { await this.plugin.retryEchoInkMemoryTransaction(issue.transactionId); });
        const drop = rowActions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.memoryDrop, attr: { type: "button" } });
        drop.onclick = async () => {
          const accepted = await confirmModal(this.app, copy.knowledge.memoryDrop, issue.error || issue.transactionId, copy.knowledge.memoryDrop, copy.common.cancel);
          if (!accepted) return;
          await this.runMemoryAction(async () => { await this.plugin.dismissEchoInkMemoryTransaction(issue.transactionId, "settings dismissal"); });
        };
      }
    }

    if (this.memoryStatus?.active.length) {
      section.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.memoryItems });
      for (const item of this.memoryStatus.active.slice(0, 30)) {
        const row = section.createDiv({ cls: "codex-api-provider-row" });
        row.createDiv({ cls: "codex-resource-note", text: `${item.kind} · ${item.statement}` });
        const rowActions = row.createDiv({ cls: "codex-api-provider-actions" });
        const remove = rowActions.createEl("button", { cls: "codex-resource-tab", text: copy.common.delete, attr: { type: "button" } });
        remove.onclick = async () => {
          const accepted = await confirmModal(this.app, copy.common.delete, copy.knowledge.memoryDeleteConfirm(item.statement), copy.common.delete, copy.common.cancel);
          if (!accepted) return;
          await this.runMemoryAction(async () => { await this.plugin.deleteEchoInkMemory(item.id, "settings deletion"); });
        };
      }
    }

    section.createDiv({ cls: "codex-resource-note", text: copy.knowledge.memoryExternalCompatibility });
    const compatibilityActions = section.createDiv({ cls: "codex-api-provider-actions" });
    const openMemorySkill = compatibilityActions.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.openMemorySkill,
      attr: { type: "button", title: CODEX_MEMORY_LITE_URL }
    });
    openMemorySkill.onclick = () => window.open(CODEX_MEMORY_LITE_URL);
  }

  private async loadMemoryStatus(force = false): Promise<void> {
    if (this.memoryStatusLoading || (!force && this.memoryStatusError)) return;
    this.memoryStatusLoading = true;
    try {
      this.memoryStatus = await this.plugin.getEchoInkMemoryStatus();
      this.memoryStatusError = null;
    } catch (error) {
      this.memoryStatusError = error instanceof Error ? error.message : String(error);
      new Notice(this.copy.knowledge.memoryActionFailed(this.memoryStatusError));
    } finally {
      this.memoryStatusLoading = false;
      this.scheduleDisplay();
    }
  }

  private async runMemoryAction(action: () => Promise<void>, reload = true): Promise<void> {
    if (this.memoryActionRunning) return;
    this.memoryActionRunning = true;
    try {
      await action();
      if (reload) {
        this.memoryStatus = await this.plugin.getEchoInkMemoryStatus();
        this.memoryStatusError = null;
      }
    } catch (error) {
      this.memoryStatusError = error instanceof Error ? error.message : String(error);
      new Notice(this.copy.knowledge.memoryActionFailed(this.memoryStatusError));
    } finally {
      this.memoryActionRunning = false;
      this.scheduleDisplay();
    }
  }

  private async repairKnowledgeBaseRulesFile(): Promise<void> {
    const copy = this.copy;
    const settings = this.plugin.settings.knowledgeBase;
    try {
      const result = await repairKnowledgeBaseRulesFile(this.plugin.getVaultPath(), settings);
      settings.useCustomRulesFile = true;
      settings.rulesFilePath = result.rulesFilePath;
      await this.plugin.saveSettings();
      this.plugin.refreshKnowledgeBaseSurfaces();
      const detail = result.status === "patched" && result.missingRules.length
        ? copy.knowledge.repairPatchedDetail(result.missingRules.length)
        : "";
      new Notice(`${copy.knowledge.repairSummary(result.status, result.rulesFilePath)}${detail}`);
      this.scheduleDisplay();
    } catch (error) {
      new Notice(copy.knowledge.repairFailed(error instanceof Error ? error.message : String(error)));
    }
  }

  private openKnowledgeBaseRulesFilePicker(): void {
    const copy = this.copy;
    const filesByPath = new Map(this.app.vault.getMarkdownFiles().map((file) => [file.path, file]));
    const files = getKnowledgeBaseRulesFileChoices(Array.from(filesByPath.keys()))
      .map((filePath) => filesByPath.get(filePath))
      .filter((file): file is TFile => file instanceof TFile);
    if (!files.length) {
      new Notice(copy.knowledge.noMarkdownFiles);
      return;
    }
    new KnowledgeBaseRulesFileSuggestModal(this.app, files, async (file) => {
      const settings = this.plugin.settings.knowledgeBase;
      settings.useCustomRulesFile = true;
      settings.rulesFilePath = sanitizeRelativeSettingsPath(file.path);
      await this.plugin.saveSettings();
      new Notice(copy.knowledge.selectedRulesFile(settings.rulesFilePath));
      this.scheduleDisplay();
    }, copy).open();
  }

  private addProviderTextArea(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => Promise<void>
  ): void {
    const field = container.createDiv({ cls: "codex-api-provider-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: label });
    const input = field.createEl("textarea", {
      cls: "codex-api-provider-textarea",
      attr: { placeholder }
    }) as HTMLTextAreaElement;
    input.value = value;
    input.onchange = () => void onChange(input.value);
  }

  private addEditorActionNumber(container: HTMLElement, label: string, value: number, min: number, max: number, onChange: (value: number) => Promise<void>): void {
    this.decorateSetting(
      new Setting(container)
        .setName(label)
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = String(min);
          text.inputEl.max = String(max);
          text.setValue(String(value)).onChange(async (raw) => {
            const next = parseClampedInteger(raw, value, min, max);
            await onChange(next);
          });
        }),
      "sliders-horizontal"
    );
  }

  private renderWorkspaceResourceManager(container: HTMLElement): void {
    const copy = this.copy;
    const wrapper = container.createDiv({ cls: "codex-resource-manager" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "blocks");
    title.createSpan({ text: copy.resources.title });

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: copy.resources.note
    });
    const tabs = wrapper.createDiv({ cls: "codex-resource-tabs" });
    for (const tab of RESOURCE_TABS) {
      const button = tabs.createEl("button", {
        cls: `codex-resource-tab ${this.plugin.settings.resourceManagementTab === tab.id ? "is-active" : ""}`,
        attr: { type: "button" }
      });
      const tabIcon = button.createSpan({ cls: "codex-resource-tab-icon" });
      setIcon(tabIcon, tab.icon);
      button.createSpan({ text: copy.resources.tabs[tab.id] });
      button.onclick = async () => {
        this.plugin.settings.resourceManagementTab = tab.id;
        await this.plugin.saveSettings();
        this.scheduleDisplay();
      };
    }
    const refresh = tabs.createEl("button", {
      cls: "codex-resource-refresh",
      attr: { type: "button", title: copy.resources.refreshTitle }
    });
    const refreshIcon = refresh.createSpan({ cls: "codex-resource-refresh-icon" });
    setIcon(refreshIcon, "refresh-cw");
    refresh.createSpan({ text: this.resourceLoadingTab === this.plugin.settings.resourceManagementTab ? copy.common.loading : copy.common.refresh });
    refresh.disabled = this.resourceLoadingTab === this.plugin.settings.resourceManagementTab;
    refresh.onclick = () => void this.loadWorkspaceResources(true, this.plugin.settings.resourceManagementTab);

    const activeTab = this.plugin.settings.resourceManagementTab;
    this.renderResourceSearch(wrapper, activeTab);

    const body = wrapper.createDiv({ cls: "codex-resource-body" });
    const activeMeta = RESOURCE_TABS.find((tab) => tab.id === activeTab);
    const isLoading = this.resourceLoadingTab === activeTab;
    const loadError = this.resourceLoadErrors[activeTab] ?? "";
    if (isLoading) {
      body.createDiv({ cls: "codex-resource-empty", text: copy.resources.loadingTab(activeMeta ? copy.resources.tabs[activeMeta.id] : copy.tabs.resources) });
    }
    if (loadError) {
      body.createDiv({ cls: "codex-resource-error", text: copy.common.readFailed(loadError) });
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) {
      body.createDiv({ cls: "codex-resource-empty", text: copy.resources.notLoaded });
    }
    const hasSavedCatalog = this.currentEchoInkResourceCatalog(this.resourceSnapshot).some((resource) => resource.kind === resourceKindForResourceTab(activeTab));
    if ((this.resourceSnapshot || hasSavedCatalog) && (this.resourceLoaded[activeTab] || isLoading || hasSavedCatalog)) {
      this.renderActiveResourceTab(body, this.resourceSnapshot ?? emptyWorkspaceResourceSnapshot());
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) void this.loadWorkspaceResources(false, activeTab);
  }

  private renderResourceSearch(container: HTMLElement, tab: ResourceManagementTab): void {
    const copy = this.copy;
    const searchWrap = container.createDiv({ cls: "codex-resource-search" });
    const icon = searchWrap.createSpan({ cls: "codex-resource-search-icon" });
    setIcon(icon, "search");
    const input = searchWrap.createEl("input", {
      cls: "codex-resource-search-input",
      attr: {
        type: "search",
        placeholder: copy.resources.searchPlaceholder(copy.resources.tabs[tab]),
        "aria-label": copy.resources.searchAria
      }
    }) as HTMLInputElement;
    input.value = this.resourceSearchQuery[tab];
    const clear = searchWrap.createEl("button", {
      cls: "codex-resource-search-clear",
      attr: { type: "button", title: copy.resources.clearSearch, "aria-label": copy.resources.clearSearch }
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
    this.resourceSearchDebounceTimer = window.setTimeout(() => {
      this.resourceSearchDebounceTimer = null;
      this.applyResourceSearchFilter(tab);
    }, 120);
  }

  private clearResourceSearchDebounceTimer(): void {
    if (this.resourceSearchDebounceTimer === null) return;
    window.clearTimeout(this.resourceSearchDebounceTimer);
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
    if (summary) summary.setText(this.copy.resources.summary(enabled, total, visible, Boolean(query.trim())));
    const empty = body.querySelector<HTMLElement>("[data-resource-search-empty]");
    empty?.toggleClass("is-hidden", !query.trim() || visible > 0);
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
      meta: [resource.source, resource.bridgeMode, resource.kind === "mcp-server" ? mcpConnectionStatusLabel(mcpConnectionStatus(resource, this.plugin.settings.resources), this.plugin.settings.settingsLanguage) : "", resource.scopes.join("/")].filter(Boolean).join(" · "),
      desc: resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc,
      resource
    }));
    const query = this.resourceSearchQuery[activeTab];
    const enabled = resources.filter((resource) => resourceScopeEnabled(this.plugin.settings.resources.enabledByScope, resource, "knowledge")).length;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(container, resources.length, enabled, error, filtered.length, query);
    if (activeTab === "mcp" && resources.length) {
      container.createDiv({ cls: "codex-resource-warning", text: "MCP 已导入 EchoInk 资源目录；只有 Codex native passthrough，或带 broker 连接配置的 MCP，才会标记为可直接调用。" });
    }
    if (!resources.length) {
      const emptyText = activeTab === "plugins" ? copy.resources.noPlugins : activeTab === "mcp" ? copy.resources.noMcp : copy.resources.noSkills;
      container.createDiv({ cls: "codex-resource-empty", text: emptyText });
      return;
    }
    if (!filtered.length) {
      const emptyText = activeTab === "plugins" ? copy.resources.noPluginMatches : activeTab === "mcp" ? copy.resources.noMcpMatches : copy.resources.noSkillMatches;
      container.createDiv({ cls: "codex-resource-empty", text: emptyText, attr: { "data-resource-search-empty": "true" } });
    }
    const visibleKeys = new Set(filtered.map((row) => row.key));
    for (const row of rows) this.renderResourceRow(container, row.resource, visibleKeys.has(row.key), row);
  }

  private renderResourceSummary(container: HTMLElement, total: number, enabled: number, error?: string, visible = total, query = ""): void {
    const copy = this.copy;
    const searching = Boolean(query.trim());
    container.createDiv({
      cls: "codex-resource-summary",
      text: copy.resources.summary(enabled, total, visible, searching),
      attr: {
        "data-resource-summary": "true",
        "data-resource-total": String(total),
        "data-resource-enabled": String(enabled)
      }
    });
    if (error) container.createDiv({ cls: "codex-resource-error", text: copy.common.partialReadFailed(error) });
  }

  private renderResourceRow(container: HTMLElement, resource: EchoInkResource, visible = true, searchRow?: { key: string; name: string; meta?: string; desc?: string }): void {
    const copy = this.copy;
    const knowledgeEnabled = resourceScopeEnabled(this.plugin.settings.resources.enabledByScope, resource, "knowledge");
    const row = container.createDiv({
      cls: `codex-resource-row ${knowledgeEnabled ? "is-enabled" : "is-disabled"} ${visible ? "" : "is-search-hidden"}`,
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
    const meta = [resource.source, resource.bridgeMode, resource.kind === "mcp-server" ? mcpConnectionStatusLabel(connectionStatus, this.plugin.settings.settingsLanguage) : "", resource.scopes.join("/")].filter(Boolean).join(" · ");
    content.createDiv({ cls: "codex-resource-row-name", text: name, attr: { title: name } });
    if (meta) content.createDiv({ cls: "codex-resource-row-meta", text: meta, attr: { title: meta } });
    const desc = resource.description || resource.contentPath || resource.configPath || copy.resources.noDesc;
    if (desc) content.createDiv({ cls: "codex-resource-row-desc", text: desc, attr: { title: desc } });
    const scopes = row.createDiv({ cls: "codex-resource-scope-toggles" });
    for (const scope of RESOURCE_SCOPES_FOR_UI) {
      const label = scopes.createEl("label", { cls: "codex-resource-scope-toggle" });
      const toggle = label.createEl("input", {
        cls: "codex-resource-toggle",
        attr: { type: "checkbox", "aria-label": copy.resources.toggleAria(`${name} ${resourceScopeLabel(scope)}`) }
      }) as HTMLInputElement;
      toggle.checked = resourceScopeEnabled(this.plugin.settings.resources.enabledByScope, resource, scope);
      toggle.disabled = !resource.scopes.includes(scope);
      label.createSpan({ text: resourceScopeLabel(scope) });
      toggle.onchange = async () => {
        this.plugin.settings.resources.enabledByScope[scope][resource.id] = toggle.checked;
        syncLegacyWorkspaceResourceToggle(this.plugin.settings.workspaceResources, resource, scope, toggle.checked);
        await this.plugin.saveSettings(true);
        const enabled = resourceScopeEnabled(this.plugin.settings.resources.enabledByScope, resource, "knowledge");
        row.toggleClass("is-enabled", enabled);
        row.toggleClass("is-disabled", !enabled);
        this.updateResourceSummaryCounts();
      };
    }
    if (resource.kind === "mcp-server") this.renderMcpConnectionActions(row, resource, connectionStatus);
  }

  private updateResourceSummaryCounts(): void {
    const body = this.containerEl.querySelector<HTMLElement>(".codex-resource-body");
    const summary = body?.querySelector<HTMLElement>("[data-resource-summary]");
    if (!body || !summary) return;
    const rows = Array.from(body.querySelectorAll<HTMLElement>(".codex-resource-row[data-resource-key]"));
    const enabled = rows.filter((row) => row.hasClass("is-enabled")).length;
    const visible = rows.filter((row) => !row.hasClass("is-search-hidden")).length;
    summary.dataset.resourceEnabled = String(enabled);
    summary.setText(this.copy.resources.summary(enabled, rows.length, visible, Boolean(this.resourceSearchQuery[this.plugin.settings.resourceManagementTab].trim())));
  }

  private renderMcpConnectionActions(row: HTMLElement, resource: EchoInkResource, status: ReturnType<typeof mcpConnectionStatus>): void {
    const actions = row.createDiv({ cls: "codex-resource-scope-toggles" });
    if (status === "imported-only" || status === "missing-config") {
      const configure = actions.createEl("button", { text: this.plugin.settings.settingsLanguage === "en" ? "Configure connection" : "补全连接配置" });
      configure.onclick = () => void this.configureMcpConnection(resource);
    }
    if (status === "connectable" || status === "verified" || status === "failed") {
      const test = actions.createEl("button", { text: this.plugin.settings.settingsLanguage === "en" ? "Test connection" : "测试连接" });
      test.onclick = () => void this.testMcpConnection(resource);
    }
  }

  private async configureMcpConnection(resource: EchoInkResource): Promise<void> {
    const value = await textInputModal(this.app, "补全连接配置", "输入 stdio command 或 http(s) MCP URL", "");
    const raw = value?.trim();
    if (!raw) return;
    this.plugin.settings.resources.mcpConnections[resource.id] = /^https?:\/\//i.test(raw)
      ? { transport: "http", url: raw }
      : { transport: "stdio", command: raw };
    await this.plugin.saveSettings(true);
    this.scheduleDisplay();
  }

  private async testMcpConnection(resource: EchoInkResource): Promise<void> {
    try {
      const tools = await this.plugin.listEchoInkMcpTools(resource.id, 10000);
      new Notice(`测试连接成功：${tools.length} tools`);
    } catch (error) {
      new Notice(`测试连接失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
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
    const nameEl = (setting as any).nameEl as HTMLElement | undefined;
    if (!nameEl) return setting;
    const settingEl = (setting as any).settingEl as HTMLElement | undefined;
    settingEl?.addClass("codex-setting-with-icon");
    nameEl.addClass("codex-setting-name-with-icon");
    const icon = document.createElement("span");
    icon.addClass("codex-setting-icon");
    setIcon(icon, iconName);
    nameEl.prepend(icon);
    return setting;
  }
}

const RESOURCE_TABS: Array<{ id: ResourceManagementTab; icon: string }> = [
  { id: "plugins", icon: "package" },
  { id: "mcp", icon: "blocks" },
  { id: "skills", icon: "sparkles" }
];

const RESOURCE_SCOPES_FOR_UI: EchoInkResourceScope[] = ["chat", "knowledge", "editor-actions"];

const SETTINGS_TABS: Array<{ id: SettingsTab; icon: string }> = [
  { id: "general", icon: "settings" },
  { id: "providers", icon: "key-round" },
  { id: "resources", icon: "blocks" },
  { id: "promptEnhancer", icon: "sparkles" },
  { id: "editorActions", icon: "wand-sparkles" },
  { id: "knowledgeBase", icon: "library" },
  { id: "review", icon: "bar-chart-3" }
];

const EDITOR_ACTION_QUALITY_MODES: Array<{ id: EditorActionQualityMode; icon: string }> = [
  { id: "fast", icon: "zap" },
  { id: "quality", icon: "file-search" },
  { id: "strict", icon: "shield-check" }
];

function editorActionIcon(actionId: string): string {
  if (actionId === "expand") return "text";
  if (actionId === "continue") return "forward";
  if (actionId === "translate") return "languages";
  return "sparkles";
}

function resourceKindForResourceTab(tab: ResourceManagementTab): EchoInkResource["kind"] {
  return tab === "mcp" ? "mcp-server" : tab === "skills" ? "skill" : "tool-bundle";
}

function resourceScopeLabel(scope: EchoInkResourceScope): string {
  if (scope === "chat") return "聊天";
  if (scope === "editor-actions") return "写作";
  return "知识库";
}

function resourceScopeEnabled(enabledByScope: Record<EchoInkResourceScope, Record<string, boolean>>, resource: EchoInkResource, scope: EchoInkResourceScope): boolean {
  if (!resource.scopes.includes(scope)) return false;
  const override = enabledByScope[scope]?.[resource.id];
  return typeof override === "boolean" ? override : resource.enabled;
}

function syncLegacyWorkspaceResourceToggle(workspaceResources: WorkspaceResourceToggles, resource: EchoInkResource, scope: EchoInkResourceScope, enabled: boolean): void {
  if (scope !== "knowledge" || resource.source !== "codex-import") return;
  if (resource.kind === "skill") {
    workspaceResources.skills[resource.contentPath || resource.name] = enabled;
    return;
  }
  if (resource.kind === "mcp-server") {
    workspaceResources.mcpServers[resource.name] = enabled;
    return;
  }
  if (resource.kind === "tool-bundle") {
    const pluginId = typeof resource.metadata?.pluginId === "string" ? resource.metadata.pluginId : resource.name;
    workspaceResources.plugins[pluginId] = enabled;
  }
}

function detectCliPath(customPath: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  const found = detectCodexCommand(customPath);
  return found ? copy.common.detected(found) : copy.common.notDetectedManual;
}

function detectOpenCodePath(customPath: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  const found = detectOpenCodeCommand(customPath);
  return found ? copy.common.detected(found) : copy.common.notDetectedManual;
}

function detectHermesPath(customPath: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  const found = detectHermesCommand(customPath);
  return found ? copy.common.detected(found) : copy.common.notDetectedManual;
}

function setupRequirementIcon(status: string): string {
  if (status === "ok") return "check-circle-2";
  if (status === "warning") return "circle-alert";
  return "circle-x";
}

function inspectCliVersion(command: string, argsPrefix: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...argsPrefix, "--version"], { shell: false, timeout: 10_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([error.message, stderr].filter(Boolean).join("\n")));
        return;
      }
      resolve(String(stdout || stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "");
    });
  });
}

async function openTerminalForSetup(platform: NodeJS.Platform | string): Promise<boolean> {
  const candidates = platform === "darwin"
    ? ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"]
    : platform === "win32"
      ? [`${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`]
      : ["/usr/bin/x-terminal-emulator", "/usr/bin/gnome-terminal", "/usr/bin/konsole"];
  for (const candidate of candidates) {
    try {
      if (await openPathInElectron(candidate)) return true;
    } catch {
      // Try the next known terminal path without running a shell command.
    }
  }
  return false;
}

function throwIfAgentSetupAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Agent 授权已取消");
  error.name = "AbortError";
  throw error;
}

function isAgentSetupAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const kind = "kind" in error ? String((error as Error & { kind?: unknown }).kind ?? "") : "";
  return error.name === "AbortError" || kind === "cancelled" || /(?:已取消|cancelled|canceled|aborted|aborterror)/i.test(error.message);
}

function formatSetupTime(value: number): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function agentBackendLabel(value: AgentBackendMode, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  return copy.backendLabels[value] ?? (value === "hermes" ? "Hermes" : value === "opencode" ? "OpenCode API" : "Codex CLI");
}

class KnowledgeBaseRulesFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => Promise<void>, copy: SettingsCopy) {
    super(app);
    this.setPlaceholder(copy.knowledge.filePickerPlaceholder);
    this.emptyStateText = copy.knowledge.filePickerEmpty;
    this.limit = 40;
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(item: FuzzyMatch<TFile>, el: HTMLElement): void {
    const path = item.item.path;
    const name = path.split("/").pop() ?? path;
    el.createDiv({ cls: "suggestion-title", text: name });
    el.createDiv({ cls: "suggestion-note", text: path });
  }

  onChooseItem(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
    void this.onChoose(file);
  }
}

function parseHistoryDateSelection(value: string): string[] {
  const dates = new Set<string>();
  for (const part of value.split(/[,\s，、]+/).map((item) => item.trim()).filter(Boolean)) {
    const rangeMatch = part.match(/^(\d{4}-\d{2}-\d{2})(?:\.\.|~|至|到)(\d{4}-\d{2}-\d{2})$/);
    if (rangeMatch) {
      for (const date of expandHistoryDateRange(rangeMatch[1], rangeMatch[2])) dates.add(date);
      continue;
    }
    if (isHistoryDateKey(part)) dates.add(part);
  }
  return [...dates].sort();
}

function expandHistoryDateRange(start: string, end: string): string[] {
  const startMs = historyDateKeyToUtcMs(start);
  const endMs = historyDateKeyToUtcMs(end);
  if (startMs === null || endMs === null || startMs > endMs) return [];
  const dates: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  for (let current = startMs; current <= endMs && dates.length <= 366; current += dayMs) {
    dates.push(historyDateKeyFromUtcMs(current));
  }
  return dates;
}

function historyDateKeyToUtcMs(value: string): number | null {
  if (!isHistoryDateKey(value)) return null;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const ms = Date.UTC(year, month - 1, day);
  const normalized = historyDateKeyFromUtcMs(ms);
  return normalized === value ? ms : null;
}

function historyDateKeyFromUtcMs(value: number): string {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isHistoryDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function knowledgeStatusLabel(value: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  return copy.knowledge.statusLabels[value as keyof typeof copy.knowledge.statusLabels] ?? copy.knowledge.statusLabels.idle;
}

function knowledgeInitStatusLabel(value: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  return copy.knowledge.initStatusLabels[value as keyof typeof copy.knowledge.initStatusLabels] ?? copy.knowledge.initStatusLabels["not-started"];
}

function pluginInstallDir(plugin: CodexForObsidianPlugin): string {
  const dir = (plugin.manifest as any).dir;
  return dir ? `${dir}/` : ".obsidian/plugins/codex-echoink/";
}

function formatStorageBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
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

function sanitizeRelativeSettingsPath(value: string): string {
  const clean = value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  return clean || DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
}

function parseModelList(value: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const model = line.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }
  return models;
}

function parseClampedInteger(value: string, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
