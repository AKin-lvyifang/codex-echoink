import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, setIcon, TFile, type FuzzyMatch } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { detectCodexCommand } from "../core/codex-service";
import { OpenCodeBackend } from "../core/opencode-backend";
import { detectOpenCodeCommand } from "../core/opencode-models";
import type { AgentModelInfo, AgentProfileInfo } from "../agent/types";
import {
  errorsFromWorkspaceResourceCache,
  loadedTabsFromWorkspaceResourceCache,
  mergeWorkspaceResourceSnapshot,
  snapshotFromWorkspaceResourceCache,
  updateWorkspaceResourceCache,
  type WorkspaceResourceKind
} from "../core/workspace-resources";
import { filterWorkspaceResourceRows, type WorkspaceResourceSearchRow } from "../core/workspace-resource-filter";
import {
  DEFAULT_SETTINGS,
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
  providerModelLabel,
  providerConnectionLabel,
  removeApiProvider,
  normalizeReviewOutputDir,
  normalizeSettingsLanguage,
  resourceEnabled,
  validateApiProvider,
  type ApiProviderConfig,
  type AgentBackendMode,
  type EditorActionQualityMode,
  type EditorAiActionConfig,
  type EditorAiStyleConfig,
  type KnowledgeBaseBackendMode,
  type ReviewReportKind,
  type ResourceManagementTab,
  type SettingsLanguage,
  type SettingsTab
} from "./settings";
import type { CodexPluginInfo, CodexSkill, CodexStatusSnapshot, McpServerStatus, PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode, WorkspaceResourceSnapshot } from "../types/app-server";
import { AGENTS_RULES_FILE, CODEX_MEMORY_LITE_URL, DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "../knowledge-base/constants";
import { repairKnowledgeBaseRulesFile } from "../knowledge-base/rules-repair";
import { confirmModal } from "../ui/modals";
import { SETTINGS_LANGUAGE_OPTIONS, settingsCopy, type SettingsCopy } from "./i18n";

export class CodexSettingTab extends PluginSettingTab {
  private resourceSnapshot: WorkspaceResourceSnapshot | null = null;
  private resourceLoadingTab: ResourceManagementTab | null = null;
  private resourceLoaded: Record<ResourceManagementTab, boolean> = { plugins: false, mcp: false, skills: false };
  private resourceLoadErrors: Partial<Record<ResourceManagementTab, string>> = {};
  private resourceSearchQuery: Record<ResourceManagementTab, string> = { plugins: "", mcp: "", skills: "" };
  private openCodeModelChoices: AgentModelInfo[] = [];
  private openCodeModelsLoaded = false;
  private openCodeModelsLoading = false;
  private openCodeModelsError = "";
  private openCodeAgentChoices: AgentProfileInfo[] = [];
  private openCodeAgentsLoaded = false;
  private openCodeAgentsLoading = false;
  private openCodeAgentsError = "";

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  private get copy(): SettingsCopy {
    return settingsCopy(this.plugin.settings.settingsLanguage);
  }

  display(): void {
    const { containerEl } = this;
    const copy = this.copy;
    containerEl.empty();
    new Setting(containerEl).setName(copy.title).setHeading();

    const status = this.plugin.lastStatus;
    const statusBox = containerEl.createDiv({ cls: "codex-settings-status" });
    this.addStatusRow(statusBox, "activity", copy.status.codexStatus, status?.connected ? copy.common.connected : copy.common.disconnected);
    this.addStatusRow(statusBox, "user-check", copy.status.accountStatus, status?.connected ? (status.accountLabel ?? copy.common.unknown) : copy.common.disconnected);
    this.addStatusRow(statusBox, "route", copy.status.agentBackend, agentBackendLabel(this.plugin.settings.agentBackend, copy));
    this.addStatusRow(statusBox, "key-round", copy.status.connection, providerConnectionLabel(this.plugin.settings, this.plugin.settings.settingsLanguage));
    this.addStatusRow(statusBox, "terminal", copy.status.cliPath, detectCliPath(this.plugin.settings.cliPath, copy));
    this.addStatusRow(statusBox, "terminal-square", copy.status.opencode, detectOpenCodePath(this.plugin.settings.opencode.cliPath, copy));
    this.addStatusRow(statusBox, "waypoints", copy.status.proxy, this.plugin.settings.proxyEnabled ? this.plugin.settings.proxyUrl : copy.common.disabled);
    this.addStatusRow(statusBox, "blocks", copy.status.chatMcp, this.plugin.settings.mcpEnabled ? copy.common.enabled : copy.common.disabled);
    this.addStatusRow(statusBox, "box", copy.status.modelCount, `${status?.models.length ?? 0}`);
    this.addStatusRow(statusBox, "sparkles", copy.status.skillsCount, `${status?.skills.length ?? 0}`);
    this.addStatusRow(statusBox, "blocks", copy.status.mcpCount, `${status?.mcpServers.length ?? 0}`);
    this.addStatusRow(statusBox, "package-check", copy.status.pluginDir, pluginInstallDir(this.plugin));
    this.addStatusErrors(statusBox, status?.errors ?? []);
    this.addStatusActions(statusBox);

    this.renderTopTabs(containerEl);
    if (this.plugin.settings.settingsTab === "providers") {
      this.renderApiProviderManager(containerEl);
      return;
    }
    if (this.plugin.settings.settingsTab === "resources") {
      this.renderWorkspaceResourceManager(containerEl);
      return;
    }
    if (this.plugin.settings.settingsTab === "editorActions") {
      this.renderEditorActionSettings(containerEl);
      return;
    }
    if (this.plugin.settings.settingsTab === "knowledgeBase") {
      this.renderKnowledgeBaseSettings(containerEl);
      return;
    }
    if (this.plugin.settings.settingsTab === "review") {
      this.renderReviewSettings(containerEl);
      return;
    }

    this.renderGeneralSettings(containerEl, status);
  }

  private renderGeneralSettings(containerEl: HTMLElement, status: CodexStatusSnapshot | null): void {
    const copy = this.copy;
    this.decorateSetting(new Setting(containerEl).setName(copy.general.settingsLanguage).setDesc(copy.general.settingsLanguageDesc).addDropdown((dropdown) => {
      for (const language of SETTINGS_LANGUAGE_OPTIONS) dropdown.addOption(language, copy.general.languageOptions[language]);
      dropdown.setValue(this.plugin.settings.settingsLanguage);
      dropdown.onChange(async (value) => {
        this.plugin.settings.settingsLanguage = normalizeSettingsLanguageForUi(value);
        await this.plugin.saveSettings(true);
        this.display();
      });
    }), "languages");

    this.decorateSetting(
      new Setting(containerEl)
      .setName(copy.general.agentBackend)
      .setDesc(copy.general.agentBackendDesc)
      .addDropdown((dropdown) => {
        const options: Record<AgentBackendMode, string> = {
          "codex-cli": "Codex CLI",
          opencode: "OpenCode API"
        };
        for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
        dropdown.setValue(this.plugin.settings.agentBackend);
        dropdown.onChange(async (value) => {
          this.plugin.settings.agentBackend = normalizeAgentBackendForUi(value);
          await this.plugin.saveSettings();
          this.display();
        });
      }),
      "route"
    );

    this.decorateSetting(
      new Setting(containerEl)
      .setName(copy.general.cliPath)
      .setDesc(copy.general.cliPathDesc)
      .addText((text) =>
        text.setPlaceholder("~/.npm-global/bin/codex").setValue(this.plugin.settings.cliPath).onChange(async (value) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        })
      ),
      "terminal"
    );

    this.decorateSetting(new Setting(containerEl).setName(copy.general.proxyEnabled).setDesc(copy.general.proxyEnabledDesc).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.proxyEnabled).onChange(async (value) => {
        this.plugin.settings.proxyEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "waypoints");

    this.decorateSetting(
      new Setting(containerEl)
        .setName(copy.general.proxyUrl)
        .setDesc(copy.general.proxyUrlDesc)
        .addText((text) =>
          text.setPlaceholder("http://127.0.0.1:7890").setValue(this.plugin.settings.proxyUrl).onChange(async (value) => {
            this.plugin.settings.proxyUrl = value.trim();
            await this.plugin.saveSettings();
          })
        ),
      "route"
    );

    this.decorateSetting(new Setting(containerEl).setName(copy.general.mcpEnabled).setDesc(copy.general.mcpEnabledDesc).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.mcpEnabled).onChange(async (value) => {
        this.plugin.settings.mcpEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "blocks");

    this.decorateSetting(
      new Setting(containerEl)
      .setName(copy.general.defaultModel)
      .setDesc(copy.general.defaultModelDesc)
      .addDropdown((dropdown) => {
        dropdown.addOption("", copy.general.auto);
        for (const model of ensureModelChoices(status?.models ?? [], this.plugin.settings.defaultModel, DEFAULT_SETTINGS.defaultModel)) {
          dropdown.addOption(model.model, model.displayName || model.model);
        }
        dropdown.setValue(this.plugin.settings.defaultModel);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultModel = value;
          await this.plugin.saveSettings();
          this.plugin.applyComposerDefaultsToView();
        });
      }),
      "box"
    );

    this.decorateSetting(new Setting(containerEl).setName(copy.general.defaultReasoning).addDropdown((dropdown) => {
      const options: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
      for (const option of options) dropdown.addOption(option, option);
      dropdown.setValue(this.plugin.settings.defaultReasoning);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultReasoning = value as ReasoningEffort;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "brain");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.defaultSpeed).addDropdown((dropdown) => {
      const options = copy.general.serviceTierOptions;
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultServiceTier);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultServiceTier = value as ServiceTierChoice;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "gauge");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.defaultPermission).addDropdown((dropdown) => {
      const options = copy.general.permissionOptions;
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultPermission);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultPermission = value as PermissionMode;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "shield-check");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.defaultMode).addDropdown((dropdown) => {
      const options = copy.general.modeOptions;
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultMode);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultMode = value as UiMode;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "route");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.autoOpen).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
        this.plugin.settings.autoOpen = value;
        await this.plugin.saveSettings();
      })
    ), "panel-right-open");

    this.decorateSetting(new Setting(containerEl).setName(copy.general.showContext).addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showContext).onChange(async (value) => {
        this.plugin.settings.showContext = value;
        await this.plugin.saveSettings();
      })
    ), "pie-chart");

    this.decorateSetting(new Setting(containerEl).addButton((button) =>
      button
        .setButtonText(copy.general.reconnect)
        .setCta()
        .onClick(async () => {
          await this.plugin.reconnectCodex();
          this.display();
        })
    ), "refresh-cw");
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.knowledgeBase;
    const opencode = this.plugin.settings.opencode;
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
    summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.initialization(knowledgeInitStatusLabel(settings.initialization.status, copy), settings.initialization.rulesFilePath) });
    summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.guide(settings.useCustomRulesFile ? settings.rulesFilePath : AGENTS_RULES_FILE, settings.useCustomRulesFile) });
    if (settings.lastReportPath) summary.createDiv({ cls: "codex-resource-note", text: copy.knowledge.recentReport(settings.lastReportPath) });
    if (settings.lastError) summary.createDiv({ cls: "codex-resource-error", text: settings.lastError });

    const actions = summary.createDiv({ cls: "codex-api-provider-actions" });
    const openChannel = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.openChannel, attr: { type: "button" } });
    openChannel.onclick = async () => {
      await this.plugin.activateKnowledgeBaseChannel();
      this.display();
    };
    const initChannel = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.initChannel, attr: { type: "button" } });
    initChannel.onclick = async () => {
      await this.plugin.activateKnowledgeBaseChannel();
      this.plugin.getCodexView()?.fillKnowledgeBaseCommand("/init ");
      this.display();
    };

    this.addKnowledgeBaseCommandGuide(wrapper);
    this.addKnowledgeBaseStoragePanel(wrapper);

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.enabled).setDesc(copy.knowledge.enabledDesc).addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.display();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.backend).setDesc(copy.knowledge.backendDesc).addDropdown((dropdown) => {
      const options: Record<KnowledgeBaseBackendMode, string> = {
        default: copy.knowledge.followGlobal(agentBackendLabel(this.plugin.settings.agentBackend, copy)),
        "codex-cli": "Codex CLI",
        opencode: "OpenCode API"
      };
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(settings.backend);
      dropdown.onChange(async (value) => {
        settings.backend = normalizeKnowledgeBackendForUi(value);
        await this.plugin.saveSettings();
        this.display();
      });
    }), "route");

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.customRules).setDesc(copy.knowledge.customRulesDesc(DEFAULT_KNOWLEDGE_BASE_RULES_FILE, AGENTS_RULES_FILE)).addToggle((toggle) =>
      toggle.setValue(settings.useCustomRulesFile).onChange(async (value) => {
        settings.useCustomRulesFile = value;
        if (value && (!settings.rulesFilePath || settings.rulesFilePath === AGENTS_RULES_FILE)) settings.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
        await this.plugin.saveSettings();
        this.display();
      })
    ), "file-cog");
    this.addKnowledgeBaseRulesFilePicker(wrapper);
    this.addKnowledgeBaseMemoryRecommendation(wrapper);

    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.dailyMaintenance).setDesc(copy.knowledge.dailyMaintenanceDesc).addToggle((toggle) =>
      toggle.setValue(settings.scheduleEnabled).onChange(async (value) => {
        settings.scheduleEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "calendar-clock");
    this.addProviderText(wrapper, copy.knowledge.scheduleTime, settings.scheduleTime, "09:00", async (value) => {
      settings.scheduleTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : settings.scheduleTime;
      await this.plugin.saveSettings();
      this.display();
    });
    this.decorateSetting(new Setting(wrapper).setName(copy.knowledge.catchUp).setDesc(copy.knowledge.catchUpDesc).addToggle((toggle) =>
      toggle.setValue(settings.catchUpOnStartup).onChange(async (value) => {
        settings.catchUpOnStartup = value;
        await this.plugin.saveSettings();
      })
    ), "history");

    const openCodeSection = wrapper.createDiv({ cls: "codex-editor-actions-section" });
    openCodeSection.createDiv({ cls: "codex-editor-actions-heading", text: copy.knowledge.opencodeMode });
    openCodeSection.createDiv({ cls: "codex-resource-note", text: copy.knowledge.detection(detectOpenCodePath(opencode.cliPath, copy)) });
    this.addProviderText(openCodeSection, copy.knowledge.opencodePath, opencode.cliPath, "/opt/homebrew/bin/opencode", async (value) => {
      opencode.cliPath = value.trim();
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(openCodeSection, copy.knowledge.serverUrl, opencode.serverUrl, "http://127.0.0.1:4096", async (value) => {
      opencode.serverUrl = value.trim().replace(/\/$/, "");
      await this.plugin.saveSettings();
    });
    this.decorateSetting(new Setting(openCodeSection).setName(copy.knowledge.autoStartServer).addToggle((toggle) =>
      toggle.setValue(opencode.autoStart).onChange(async (value) => {
        opencode.autoStart = value;
        await this.plugin.saveSettings();
      })
    ), "power");
    this.addProviderText(openCodeSection, copy.opencode.host, opencode.hostname, "127.0.0.1", async (value) => {
      opencode.hostname = value.trim() || "127.0.0.1";
      await this.plugin.saveSettings();
    });
    this.addProviderText(openCodeSection, copy.opencode.port, String(opencode.port), "4096", async (value) => {
      opencode.port = parseClampedInteger(value, 4096, 1024, 65535);
      await this.plugin.saveSettings();
      this.display();
    });
    this.addOpenCodeModelPicker(openCodeSection);
    this.addProviderText(openCodeSection, copy.opencode.providerId, opencode.providerId, "anthropic", async (value) => {
      opencode.providerId = value.trim();
      await this.plugin.saveSettings();
    });
    this.addProviderText(openCodeSection, copy.opencode.modelId, opencode.modelId, "claude-sonnet-4-20250514", async (value) => {
      opencode.modelId = value.trim();
      await this.plugin.saveSettings();
    });
    this.addOpenCodeAgentPicker(openCodeSection);
    openCodeSection.createDiv({
      cls: "codex-resource-note",
      text: copy.knowledge.modelCapabilities(opencode.textEnabled, opencode.imageEnabled, opencode.pdfEnabled)
    });
    if (opencode.lastError) openCodeSection.createDiv({ cls: "codex-resource-error", text: opencode.lastError });
    if (this.openCodeModelsError) openCodeSection.createDiv({ cls: "codex-resource-error", text: this.openCodeModelsError });
    if (this.openCodeAgentsError) openCodeSection.createDiv({ cls: "codex-resource-error", text: this.openCodeAgentsError });
    const openCodeActions = openCodeSection.createDiv({ cls: "codex-api-provider-actions" });
    const testOpenCode = openCodeActions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.testConnection, attr: { type: "button" } });
    testOpenCode.onclick = async () => {
      await this.refreshOpenCodeRuntimeOptions();
      this.display();
    };

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: copy.knowledge.channelNote
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
    const actions = section.createDiv({ cls: "codex-api-provider-actions" });
    const rebuild = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.rebuildHistory, attr: { type: "button" } });
    rebuild.onclick = async () => {
      rebuild.disabled = true;
      await this.plugin.rebuildKnowledgeBaseHistoryIndex();
      new Notice(copy.knowledge.historyRebuilt);
      this.display();
    };
    const exportButton = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.exportHistory, attr: { type: "button" } });
    exportButton.onclick = async () => {
      exportButton.disabled = true;
      const exported = await this.plugin.exportKnowledgeBaseHistory();
      new Notice(copy.knowledge.historyExported(exported));
      this.display();
    };
    const compact = actions.createEl("button", { cls: "codex-resource-tab", text: copy.knowledge.compactHistory, attr: { type: "button" } });
    compact.onclick = async () => {
      const accepted = await confirmModal(this.app, copy.knowledge.compactHistory, "只压缩旧日期的过程记录，不删除用户与助手正文。", "压缩", "取消");
      if (!accepted) return;
      compact.disabled = true;
      const count = await this.plugin.compactOldKnowledgeBaseProcessHistory();
      new Notice(copy.knowledge.historyCompacted(count));
      this.display();
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
      this.display();
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
      this.display();
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

  private addStatusActions(container: HTMLElement): void {
    const copy = this.copy;
    const actions = container.createDiv({ cls: "codex-settings-status-actions" });
    const refresh = actions.createEl("button", {
      cls: "codex-resource-refresh",
      attr: { type: "button", title: copy.status.refreshTitle }
    });
    const icon = refresh.createSpan({ cls: "codex-resource-refresh-icon" });
    setIcon(icon, "refresh-cw");
    const label = refresh.createSpan({ text: copy.status.refreshLogin });
    refresh.onclick = async () => {
      refresh.disabled = true;
      label.setText(copy.status.refreshing);
      const status = await this.plugin.reconnectCodex({ refreshLogin: true });
      if (status.connected) new Notice(copy.status.refreshSuccess(status.accountLabel));
      else new Notice(copy.status.refreshFailed(status.errors[0] ?? copy.common.unknown));
      this.display();
    };
  }

  private addStatusErrors(container: HTMLElement, errors: string[]): void {
    if (!errors.length) return;
    const copy = this.copy;
    for (const error of errors.slice(0, 3)) {
      const diagnostic = diagnoseCodexError(error, {
        model: this.plugin.settings.defaultModel,
        providerLabel: providerConnectionLabel(this.plugin.settings, this.plugin.settings.settingsLanguage),
        proxyEnabled: this.plugin.settings.proxyEnabled,
        proxyUrl: this.plugin.settings.proxyUrl,
        language: this.plugin.settings.settingsLanguage
      });
      const card = container.createDiv({ cls: "codex-settings-status-error" });
      const title = card.createDiv({ cls: "codex-settings-status-error-title" });
      const icon = title.createSpan({ cls: "codex-settings-status-icon" });
      setIcon(icon, "triangle-alert");
      title.createSpan({ text: copy.status.diagnostics });
      card.createEl("pre", { cls: "codex-settings-status-error-body", text: diagnostic.text });
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
        this.display();
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
      await this.plugin.saveSettings(true);
      await this.plugin.reconnectCodex();
      this.display();
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
      await this.plugin.saveSettings(true);
      this.display();
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

  private renderEditorActionSettings(container: HTMLElement): void {
    const copy = this.copy;
    const settings = this.plugin.settings.editorActions;

    this.decorateSetting(
      new Setting(container)
        .setName(copy.writing.requestMode)
        .setDesc(copy.writing.requestModeDesc),
      "terminal"
    );

    this.decorateSetting(new Setting(container).setName(copy.writing.enabled).setDesc(copy.writing.enabledDesc).addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.display();
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
        settings.qualityMode = normalizeEditorActionQualityModeForUi(value);
        await this.plugin.saveSettings();
        this.display();
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
        this.display();
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
          this.display();
        })
      );
      this.addProviderText(row, copy.writing.name, action.label, copy.writing.actionNamePlaceholder, async (value) => {
        action.label = value.trim() || action.id;
        await this.plugin.saveSettings();
        this.display();
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
    const modelChoices = ensureModelChoices(this.plugin.lastStatus?.models ?? [], "gpt-5.4-mini", "gpt-5.4", "gpt-5.5", DEFAULT_SETTINGS.defaultModel);
    for (const mode of EDITOR_ACTION_QUALITY_MODES) {
      const config = settings.modeConfigs[mode.id];
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-mode-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, mode.icon);
      title.createSpan({ text: copy.writing.qualityModes[mode.id].label });
      title.createSpan({ cls: "codex-resource-row-meta", text: copy.writing.qualityModes[mode.id].desc });

      this.decorateSetting(new Setting(row).setName(copy.writing.model).addDropdown((dropdown) => {
        for (const model of ensureModelChoices(modelChoices, config.model)) dropdown.addOption(model.model, model.displayName || model.model);
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
      this.display();
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
          this.display();
        };
      }
      this.addProviderText(row, copy.writing.name, style.label, copy.writing.styleNamePlaceholder, async (value) => {
        style.label = value.trim() || style.id;
        await this.plugin.saveSettings();
        this.display();
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
      await this.plugin.saveSettings(true);
      await this.plugin.reconnectCodex();
      this.display();
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
      await this.plugin.saveSettings(true);
      if (wasActive) await this.plugin.reconnectCodex();
      this.display();
    };

    this.addProviderText(row, copy.providers.name, provider.name, copy.providers.namePlaceholder, async (value) => {
      provider.name = value.trim();
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(row, copy.providers.baseUrl, provider.baseUrl, "https://api.openai.com/v1", async (value) => {
      provider.baseUrl = value.trim();
      await this.plugin.saveSettings();
    });
    row.createDiv({ cls: "codex-resource-note", text: copy.providers.responseApiRequirement });
    this.addProviderTextArea(row, copy.providers.models, getApiProviderModels(provider).join("\n"), "gpt-5.4\ngpt-5.5", async (value) => {
      const models = parseModelList(value);
      provider.models = models;
      provider.model = models[0] ?? "";
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(row, copy.providers.apiKey, provider.apiKey, "sk-...", async (value) => {
      provider.apiKey = value.trim();
      await this.plugin.saveSettings();
    }, "password");
    this.addProviderTextArea(row, copy.providers.queryParams, formatQueryParams(provider.queryParams), "api-version=2026-04-28", async (value) => {
      provider.queryParams = parseQueryParams(value);
      if (!Object.keys(provider.queryParams).length) delete provider.queryParams;
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
        await this.plugin.saveSettings(true);
        this.display();
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
        await this.plugin.saveSettings(true);
        this.display();
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
        await this.plugin.saveSettings(true);
        this.display();
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

  private async refreshOpenCodeRuntimeOptions(options: { models?: boolean; agents?: boolean } = { models: true, agents: true }): Promise<void> {
    const copy = this.copy;
    const shouldLoadModels = options.models !== false;
    const shouldLoadAgents = options.agents !== false;
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
    this.display();
    try {
      await backend.connect();
      const opencode = this.plugin.settings.opencode;
      if (shouldLoadModels) {
        const models = await backend.listModels();
        this.openCodeModelChoices = models;
        this.openCodeModelsLoaded = true;
        const current = models.find((model) => model.providerId === opencode.providerId && model.modelId === opencode.modelId);
        if (current) this.applyOpenCodeModelChoice(current);
      }
      if (shouldLoadAgents) {
        const agents = await backend.listAgents();
        this.openCodeAgentChoices = agents;
        this.openCodeAgentsLoaded = true;
        const current = agents.find((agent) => agent.name === opencode.agent);
        if (current) opencode.agent = current.name;
        if (!opencode.agent && agents[0]) opencode.agent = agents[0].name;
      }
      opencode.lastConnectedAt = Date.now();
      opencode.lastError = "";
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
      await backend.disconnect().catch(() => undefined);
      if (shouldLoadModels) this.openCodeModelsLoading = false;
      if (shouldLoadAgents) this.openCodeAgentsLoading = false;
      this.display();
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
    const currentPath = settings.useCustomRulesFile ? settings.rulesFilePath : AGENTS_RULES_FILE;
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
    resetButton.disabled = settings.useCustomRulesFile && currentPath === DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
    resetButton.onclick = async () => {
      settings.useCustomRulesFile = true;
      settings.rulesFilePath = DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
      await this.plugin.saveSettings();
      this.display();
    };

    const repairButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.repairRules,
      attr: { type: "button", title: copy.knowledge.repairRulesTitle }
    });
    repairButton.onclick = () => void this.repairKnowledgeBaseRulesFile();

    field.createDiv({
      cls: "codex-resource-note codex-rules-file-note",
      text: settings.useCustomRulesFile
        ? copy.knowledge.rulesFileNoteCustom(settings.rulesFilePath || DEFAULT_KNOWLEDGE_BASE_RULES_FILE, AGENTS_RULES_FILE)
        : copy.knowledge.rulesFileNoteLegacy(AGENTS_RULES_FILE, DEFAULT_KNOWLEDGE_BASE_RULES_FILE)
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
    const actions = section.createDiv({ cls: "codex-api-provider-actions" });
    const openMemorySkill = actions.createEl("button", {
      cls: "codex-resource-tab",
      text: copy.knowledge.openMemorySkill,
      attr: { type: "button", title: CODEX_MEMORY_LITE_URL }
    });
    openMemorySkill.onclick = () => window.open(CODEX_MEMORY_LITE_URL);
  }

  private async repairKnowledgeBaseRulesFile(): Promise<void> {
    const copy = this.copy;
    const settings = this.plugin.settings.knowledgeBase;
    try {
      const result = await repairKnowledgeBaseRulesFile(this.plugin.getVaultPath(), settings);
      if (settings.useCustomRulesFile) settings.rulesFilePath = result.rulesFilePath;
      else settings.rulesFilePath = AGENTS_RULES_FILE;
      await this.plugin.saveSettings();
      this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
      const detail = result.status === "patched" && result.missingRules.length
        ? copy.knowledge.repairPatchedDetail(result.missingRules.length)
        : "";
      new Notice(`${copy.knowledge.repairSummary(result.status, result.rulesFilePath)}${detail}`);
      this.display();
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
      this.display();
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
        this.display();
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
    if (this.resourceSnapshot && (this.resourceLoaded[activeTab] || isLoading)) this.renderActiveResourceTab(body, this.resourceSnapshot);
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
    input.oninput = () => {
      this.resourceSearchQuery[tab] = input.value;
      this.display();
      window.requestAnimationFrame(() => {
        const next = this.containerEl.querySelector<HTMLInputElement>(".codex-resource-search-input");
        next?.focus();
        next?.setSelectionRange(next.value.length, next.value.length);
      });
    };
    if (input.value) {
      const clear = searchWrap.createEl("button", {
        cls: "codex-resource-search-clear",
        attr: { type: "button", title: copy.resources.clearSearch, "aria-label": copy.resources.clearSearch }
      });
      setIcon(clear, "x");
      clear.onclick = () => {
        this.resourceSearchQuery[tab] = "";
        this.display();
      };
    }
  }

  private renderActiveResourceTab(container: HTMLElement, snapshot: WorkspaceResourceSnapshot): void {
    if (this.plugin.settings.resourceManagementTab === "plugins") {
      this.renderPluginResources(container, snapshot.plugins, snapshot.errors.plugins);
      return;
    }
    if (this.plugin.settings.resourceManagementTab === "mcp") {
      this.renderMcpResources(container, snapshot.mcpServers, snapshot.errors.mcp);
      return;
    }
    this.renderSkillResources(container, snapshot.skills, snapshot.errors.skills);
  }

  private renderPluginResources(container: HTMLElement, plugins: CodexPluginInfo[], error?: string): void {
    const copy = this.copy;
    const rows = plugins.map((plugin) => ({
      key: plugin.id,
      kind: "plugins" as const,
      name: plugin.displayName || plugin.name || plugin.id,
      meta: [plugin.category, plugin.marketplace, plugin.installed ? copy.resources.installed : copy.resources.notInstalled].filter(Boolean).join(" · "),
      desc: plugin.description || plugin.id,
      enabled: resourceEnabled(this.plugin.settings.workspaceResources.plugins, plugin.id, plugin.enabled !== false)
    }));
    const query = this.resourceSearchQuery.plugins;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(container, plugins.length, rows.filter((row) => row.enabled).length, error, filtered.length, query);
    if (!plugins.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noPlugins });
      return;
    }
    if (!filtered.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noPluginMatches });
      return;
    }
    for (const row of filtered) this.renderResourceRow(container, row);
  }

  private renderMcpResources(container: HTMLElement, servers: McpServerStatus[], error?: string): void {
    const copy = this.copy;
    const rows = servers.map((server) => ({
      key: server.name,
      kind: "mcpServers" as const,
      name: server.name,
      meta: `${copy.resources.toolsCount(Object.keys(server.tools ?? {}).length)} · ${server.authStatus ?? "unknown"}`,
      desc: copy.resources.mcpDesc,
      enabled: resourceEnabled(this.plugin.settings.workspaceResources.mcpServers, server.name, true)
    }));
    const query = this.resourceSearchQuery.mcp;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(container, servers.length, rows.filter((row) => row.enabled).length, error, filtered.length, query);
    if (!this.plugin.settings.mcpEnabled && servers.length) {
      container.createDiv({ cls: "codex-resource-warning", text: copy.resources.mcpDisabledWarning });
    }
    if (!servers.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noMcp });
      return;
    }
    if (!filtered.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noMcpMatches });
      return;
    }
    for (const row of filtered) this.renderResourceRow(container, row);
  }

  private renderSkillResources(container: HTMLElement, skills: CodexSkill[], error?: string): void {
    const copy = this.copy;
    const rows = skills.map((skill) => ({
      key: skill.path || skill.name,
      kind: "skills" as const,
      name: `/${skill.name}`,
      meta: [skill.scope, skill.path].filter(Boolean).join(" · "),
      desc: skill.description || copy.resources.noDesc,
      enabled: resourceEnabled(this.plugin.settings.workspaceResources.skills, skill.path || skill.name, skill.enabled !== false)
    }));
    const query = this.resourceSearchQuery.skills;
    const filtered = filterWorkspaceResourceRows(rows, query);
    this.renderResourceSummary(container, skills.length, rows.filter((row) => row.enabled).length, error, filtered.length, query);
    if (!skills.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noSkills });
      return;
    }
    if (!filtered.length) {
      container.createDiv({ cls: "codex-resource-empty", text: copy.resources.noSkillMatches });
      return;
    }
    for (const row of filtered) this.renderResourceRow(container, row);
  }

  private renderResourceSummary(container: HTMLElement, total: number, enabled: number, error?: string, visible = total, query = ""): void {
    const copy = this.copy;
    const searching = Boolean(query.trim());
    container.createDiv({ cls: "codex-resource-summary", text: copy.resources.summary(enabled, total, visible, searching) });
    if (error) container.createDiv({ cls: "codex-resource-error", text: copy.common.partialReadFailed(error) });
  }

  private renderResourceRow(
    container: HTMLElement,
    item: WorkspaceResourceSearchRow & {
      kind: "plugins" | "mcpServers" | "skills";
      enabled: boolean;
    }
  ): void {
    const copy = this.copy;
    const row = container.createDiv({ cls: `codex-resource-row ${item.enabled ? "is-enabled" : "is-disabled"}` });
    const icon = row.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, item.kind === "skills" ? "sparkles" : item.kind === "mcpServers" ? "blocks" : "package");
    const content = row.createDiv({ cls: "codex-resource-row-content" });
    content.createDiv({ cls: "codex-resource-row-name", text: item.name, attr: { title: item.name } });
    if (item.meta) content.createDiv({ cls: "codex-resource-row-meta", text: item.meta, attr: { title: item.meta } });
    if (item.desc) content.createDiv({ cls: "codex-resource-row-desc", text: item.desc, attr: { title: item.desc } });
    const toggle = row.createEl("input", {
      cls: "codex-resource-toggle",
      attr: { type: "checkbox", "aria-label": copy.resources.toggleAria(item.name) }
    }) as HTMLInputElement;
    toggle.checked = item.enabled;
    toggle.onchange = async () => {
      this.plugin.settings.workspaceResources[item.kind][item.key] = toggle.checked;
      await this.plugin.saveSettings(true);
      this.display();
    };
  }

  private async loadWorkspaceResources(force = false, tab: ResourceManagementTab = this.plugin.settings.resourceManagementTab): Promise<void> {
    if (this.resourceLoadingTab === tab) return;
    if (this.resourceLoaded[tab] && !force) return;
    this.resourceLoadingTab = tab;
    delete this.resourceLoadErrors[tab];
    this.display();
    try {
      const status = await this.plugin.ensureCodexConnected();
      if (!status.connected || !this.plugin.codex) throw new Error(this.copy.resources.codexDisconnected);
      const result = await this.loadResourceTab(tab);
      this.resourceSnapshot = mergeWorkspaceResourceSnapshot(this.resourceSnapshot, result.kind, result.data, result.error);
      this.resourceLoaded[tab] = true;
      this.plugin.settings.workspaceResourceCache = updateWorkspaceResourceCache(
        this.plugin.settings.workspaceResourceCache,
        result.kind,
        result.data,
        result.error
      );
      if (this.plugin.lastStatus) {
        if (tab === "skills") this.plugin.lastStatus.skills = this.resourceSnapshot.skills;
        if (tab === "mcp") this.plugin.lastStatus.mcpServers = this.resourceSnapshot.mcpServers;
      }
      await this.plugin.saveSettings(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.resourceLoadErrors[tab] = message;
      const kind = resourceKindForTab(tab);
      this.resourceSnapshot = mergeWorkspaceResourceSnapshot(this.resourceSnapshot, kind, [], message);
      this.resourceLoaded[tab] = true;
      this.plugin.settings.workspaceResourceCache = updateWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache, kind, [], message);
      await this.plugin.saveSettings(true);
    } finally {
      this.resourceLoadingTab = null;
      this.display();
    }
  }

  private async loadResourceTab(tab: ResourceManagementTab): Promise<{ kind: WorkspaceResourceKind; data: CodexPluginInfo[] | CodexSkill[] | McpServerStatus[]; error: string | null }> {
    if (!this.plugin.codex) throw new Error(this.copy.resources.codexDisconnected);
    if (tab === "plugins") {
      const result = await this.plugin.codex.refreshPluginResources();
      return { kind: "plugins", data: result.plugins, error: result.error };
    }
    if (tab === "mcp") {
      const result = await this.plugin.codex.refreshMcpStatus();
      return { kind: "mcp", data: result.servers, error: result.error };
    }
    const result = await this.plugin.codex.refreshSkillResources();
    return { kind: "skills", data: result.skills, error: result.error };
  }

  private addStatusRow(container: HTMLElement, iconName: string, label: string, value: string): void {
    const row = container.createDiv({ cls: "codex-settings-status-row" });
    const icon = row.createSpan({ cls: "codex-settings-status-icon" });
    setIcon(icon, iconName);
    row.createSpan({ cls: "codex-settings-status-label", text: label });
    row.createSpan({ cls: "codex-settings-status-value", text: value });
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

const SETTINGS_TABS: Array<{ id: SettingsTab; icon: string }> = [
  { id: "general", icon: "settings" },
  { id: "providers", icon: "key-round" },
  { id: "resources", icon: "blocks" },
  { id: "editorActions", icon: "wand-sparkles" },
  { id: "knowledgeBase", icon: "library" },
  { id: "review", icon: "bar-chart-3" }
];

const EDITOR_ACTION_QUALITY_MODES: Array<{ id: EditorActionQualityMode; icon: string }> = [
  { id: "fast", icon: "zap" },
  { id: "quality", icon: "file-search" },
  { id: "strict", icon: "shield-check" }
];

function normalizeEditorActionQualityModeForUi(value: string): EditorActionQualityMode {
  return value === "fast" || value === "quality" || value === "strict" ? value : "quality";
}

function editorActionIcon(actionId: string): string {
  if (actionId === "expand") return "text";
  if (actionId === "continue") return "forward";
  if (actionId === "translate") return "languages";
  return "sparkles";
}

function resourceKindForTab(tab: ResourceManagementTab): WorkspaceResourceKind {
  return tab === "mcp" ? "mcp" : tab === "skills" ? "skills" : "plugins";
}

function detectCliPath(customPath: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  const found = detectCodexCommand(customPath);
  return found ? copy.common.detected(found) : copy.common.notDetectedManual;
}

function detectOpenCodePath(customPath: string, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  const found = detectOpenCodeCommand(customPath);
  return found ? copy.common.detected(found) : copy.common.notDetectedManual;
}

function agentBackendLabel(value: AgentBackendMode, copy: SettingsCopy = settingsCopy("zh-CN")): string {
  return copy.backendLabels[value] ?? (value === "opencode" ? "OpenCode API" : "Codex CLI");
}

function normalizeSettingsLanguageForUi(value: string): SettingsLanguage {
  return normalizeSettingsLanguage(value);
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

function normalizeAgentBackendForUi(value: string): AgentBackendMode {
  return value === "opencode" ? "opencode" : "codex-cli";
}

function normalizeKnowledgeBackendForUi(value: string): KnowledgeBaseBackendMode {
  return value === "codex-cli" || value === "opencode" ? value : "default";
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
