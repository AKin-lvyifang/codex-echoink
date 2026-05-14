import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, setIcon, TFile, type FuzzyMatch } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { detectCodexCommand } from "../core/codex-service";
import { detectOpenCodeCommand } from "../core/opencode-models";
import {
  errorsFromWorkspaceResourceCache,
  loadedTabsFromWorkspaceResourceCache,
  mergeWorkspaceResourceSnapshot,
  snapshotFromWorkspaceResourceCache,
  updateWorkspaceResourceCache,
  type WorkspaceResourceKind
} from "../core/workspace-resources";
import {
  DEFAULT_SETTINGS,
  ensureModelChoices,
  getActiveApiProvider,
  getApiProviderModels,
  getKnowledgeBaseRulesFileChoices,
  newId,
  providerModelLabel,
  providerConnectionLabel,
  removeApiProvider,
  resourceEnabled,
  validateApiProvider,
  type ApiProviderConfig,
  type AgentBackendMode,
  type EditorActionQualityMode,
  type EditorAiActionConfig,
  type EditorAiStyleConfig,
  type KnowledgeBaseBackendMode,
  type ResourceManagementTab,
  type SettingsTab
} from "./settings";
import type { CodexPluginInfo, CodexSkill, CodexStatusSnapshot, McpServerStatus, PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode, WorkspaceResourceSnapshot } from "../types/app-server";

export class CodexSettingTab extends PluginSettingTab {
  private resourceSnapshot: WorkspaceResourceSnapshot | null = null;
  private resourceLoadingTab: ResourceManagementTab | null = null;
  private resourceLoaded: Record<ResourceManagementTab, boolean> = { plugins: false, mcp: false, skills: false };
  private resourceLoadErrors: Partial<Record<ResourceManagementTab, string>> = {};

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    super(plugin.app, plugin);
    this.resourceSnapshot = snapshotFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoaded = loadedTabsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
    this.resourceLoadErrors = errorsFromWorkspaceResourceCache(this.plugin.settings.workspaceResourceCache);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Codex for Obsidian 设置" });

    const status = this.plugin.lastStatus;
    const statusBox = containerEl.createDiv({ cls: "codex-settings-status" });
    this.addStatusRow(statusBox, "activity", "Codex 状态", status?.connected ? "已连接" : "未连接");
    this.addStatusRow(statusBox, "user-check", "账号状态", status?.accountLabel ?? "未知");
    this.addStatusRow(statusBox, "route", "Agent 后端", agentBackendLabel(this.plugin.settings.agentBackend));
    this.addStatusRow(statusBox, "key-round", "连接方式", providerConnectionLabel(this.plugin.settings));
    this.addStatusRow(statusBox, "terminal", "CLI 路径", detectCliPath(this.plugin.settings.cliPath));
    this.addStatusRow(statusBox, "terminal-square", "OpenCode", detectOpenCodePath(this.plugin.settings.opencode.cliPath));
    this.addStatusRow(statusBox, "waypoints", "代理", this.plugin.settings.proxyEnabled ? this.plugin.settings.proxyUrl : "关闭");
    this.addStatusRow(statusBox, "blocks", "聊天 MCP", this.plugin.settings.mcpEnabled ? "启用" : "关闭");
    this.addStatusRow(statusBox, "box", "模型数量", `${status?.models.length ?? 0}`);
    this.addStatusRow(statusBox, "sparkles", "Skills 数量", `${status?.skills.length ?? 0}`);
    this.addStatusRow(statusBox, "blocks", "MCP 数量", `${status?.mcpServers.length ?? 0}`);
    this.addStatusRow(statusBox, "package-check", "插件目录", pluginInstallDir(this.plugin));
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

    this.renderGeneralSettings(containerEl, status);
  }

  private renderGeneralSettings(containerEl: HTMLElement, status: CodexStatusSnapshot | null): void {
    this.decorateSetting(
      new Setting(containerEl)
      .setName("Agent 后端")
      .setDesc("Codex CLI 复用登录态；OpenCode API 用本机 OpenCode runtime 和自配 Provider。普通聊天暂继续走 Codex，知识库管理可选择 OpenCode。")
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
      .setName("Codex CLI 路径")
      .setDesc("必须先安装并登录 Codex CLI。自定义 API 也通过 Codex CLI app-server 调用，不是插件直连 API。留空时自动查找。")
      .addText((text) =>
        text.setPlaceholder("~/.npm-global/bin/codex").setValue(this.plugin.settings.cliPath).onChange(async (value) => {
          this.plugin.settings.cliPath = value.trim();
          await this.plugin.saveSettings();
        })
      ),
      "terminal"
    );

    this.decorateSetting(new Setting(containerEl).setName("启用本地代理").setDesc("只影响插件启动的 Codex，不改全局配置。").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.proxyEnabled).onChange(async (value) => {
        this.plugin.settings.proxyEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "waypoints");

    this.decorateSetting(
      new Setting(containerEl)
        .setName("代理地址")
        .setDesc("如需本机代理，可填写 Clash 等代理地址。")
        .addText((text) =>
          text.setPlaceholder("http://127.0.0.1:7890").setValue(this.plugin.settings.proxyUrl).onChange(async (value) => {
            this.plugin.settings.proxyUrl = value.trim();
            await this.plugin.saveSettings();
          })
        ),
      "route"
    );

    this.decorateSetting(new Setting(containerEl).setName("启用 MCP 工具").setDesc("默认关闭以加快普通聊天；只影响聊天线程。").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.mcpEnabled).onChange(async (value) => {
        this.plugin.settings.mcpEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "blocks");

    this.decorateSetting(
      new Setting(containerEl)
      .setName("默认模型")
      .setDesc("留空时使用 Codex 返回的默认模型。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", "自动");
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

    this.decorateSetting(new Setting(containerEl).setName("默认思考强度").addDropdown((dropdown) => {
      const options: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
      for (const option of options) dropdown.addOption(option, option);
      dropdown.setValue(this.plugin.settings.defaultReasoning);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultReasoning = value as ReasoningEffort;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "brain");

    this.decorateSetting(new Setting(containerEl).setName("默认速度").addDropdown((dropdown) => {
      const options: Record<ServiceTierChoice, string> = {
        standard: "标准",
        fast: "快速",
        flex: "弹性"
      };
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultServiceTier);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultServiceTier = value as ServiceTierChoice;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "gauge");

    this.decorateSetting(new Setting(containerEl).setName("默认文件权限").addDropdown((dropdown) => {
      const options: Record<PermissionMode, string> = {
        "read-only": "只读",
        "workspace-write": "工作区可写",
        "danger-full-access": "完全放开"
      };
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultPermission);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultPermission = value as PermissionMode;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "shield-check");

    this.decorateSetting(new Setting(containerEl).setName("默认模式").addDropdown((dropdown) => {
      const options: Record<UiMode, string> = {
        agent: "Agent",
        plan: "Plan"
      };
      for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
      dropdown.setValue(this.plugin.settings.defaultMode);
      dropdown.onChange(async (value) => {
        this.plugin.settings.defaultMode = value as UiMode;
        await this.plugin.saveSettings();
        this.plugin.applyComposerDefaultsToView();
      });
    }), "route");

    this.decorateSetting(new Setting(containerEl).setName("启动时自动打开侧栏").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => {
        this.plugin.settings.autoOpen = value;
        await this.plugin.saveSettings();
      })
    ), "panel-right-open");

    this.decorateSetting(new Setting(containerEl).setName("显示上下文容量").addToggle((toggle) =>
      toggle.setValue(this.plugin.settings.showContext).onChange(async (value) => {
        this.plugin.settings.showContext = value;
        await this.plugin.saveSettings();
      })
    ), "pie-chart");

    this.decorateSetting(new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("重新连接 Codex")
        .setCta()
        .onClick(async () => {
          await this.plugin.reconnectCodex();
          this.display();
        })
    ), "refresh-cw");
  }

  private renderKnowledgeBaseSettings(container: HTMLElement): void {
    const settings = this.plugin.settings.knowledgeBase;
    const opencode = this.plugin.settings.opencode;
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager codex-knowledge-settings" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "library");
    title.createSpan({ text: "知识库管理" });

    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: "安全边界：允许写 wiki/ 和 outputs/；禁止修改 raw/ 原始资料、删除文件或自动归档。OpenCode 模式需要先外部安装 OpenCode。"
    });

    const summary = wrapper.createDiv({ cls: "codex-api-provider-row" });
    summary.createDiv({ cls: "codex-editor-actions-heading", text: "运行状态" });
    summary.createDiv({ cls: "codex-resource-note", text: `最近状态：${knowledgeStatusLabel(settings.lastRunStatus)}${settings.lastRunAt ? ` · ${new Date(settings.lastRunAt).toLocaleString()}` : ""}` });
    summary.createDiv({ cls: "codex-resource-note", text: `操作指南：${settings.useCustomRulesFile ? settings.rulesFilePath : "AGENTS.md"}${settings.useCustomRulesFile ? "（自定义）" : "（默认）"}` });
    if (settings.lastReportPath) summary.createDiv({ cls: "codex-resource-note", text: `最近报告：${settings.lastReportPath}` });
    if (settings.lastError) summary.createDiv({ cls: "codex-resource-error", text: settings.lastError });

    const actions = summary.createDiv({ cls: "codex-api-provider-actions" });
    const openChannel = actions.createEl("button", { cls: "codex-resource-tab", text: "打开知识库频道", attr: { type: "button" } });
    openChannel.onclick = async () => {
      await this.plugin.activateKnowledgeBaseChannel();
      this.display();
    };

    this.decorateSetting(new Setting(wrapper).setName("启用知识库管理").setDesc("开启后，插件才会按下面的每日自动维护和启动补跑设置自动运行；关闭后不会自动跑任务，但仍可打开右侧知识库频道手动对话、收集和维护。").addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.display();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(wrapper).setName("知识库后端").setDesc("默认跟随基础设置里的 Agent 后端；也可以单独固定为 Codex 或 OpenCode。").addDropdown((dropdown) => {
      const options: Record<KnowledgeBaseBackendMode, string> = {
        default: `跟随全局（${agentBackendLabel(this.plugin.settings.agentBackend)}）`,
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

    this.decorateSetting(new Setting(wrapper).setName("使用自定义指南文件").setDesc("关闭时默认读取 Vault 根目录 AGENTS.md；开启后只读取下面填写的文件，不合并 AGENTS.md。").addToggle((toggle) =>
      toggle.setValue(settings.useCustomRulesFile).onChange(async (value) => {
        settings.useCustomRulesFile = value;
        if (value && (!settings.rulesFilePath || settings.rulesFilePath === "AGENTS.md")) settings.rulesFilePath = "CLAUDE.md";
        await this.plugin.saveSettings();
        this.display();
      })
    ), "file-cog");
    this.addKnowledgeBaseRulesFilePicker(wrapper);

    this.decorateSetting(new Setting(wrapper).setName("每日自动维护").setDesc("仅在 Obsidian 打开时运行；错过后下次打开可补跑。").addToggle((toggle) =>
      toggle.setValue(settings.scheduleEnabled).onChange(async (value) => {
        settings.scheduleEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "calendar-clock");
    this.addProviderText(wrapper, "每日运行时间", settings.scheduleTime, "09:00", async (value) => {
      settings.scheduleTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim()) ? value.trim() : settings.scheduleTime;
      await this.plugin.saveSettings();
      this.display();
    });
    this.decorateSetting(new Setting(wrapper).setName("启动补跑").setDesc("当天错过维护时间时，下次打开 Obsidian 自动补跑。").addToggle((toggle) =>
      toggle.setValue(settings.catchUpOnStartup).onChange(async (value) => {
        settings.catchUpOnStartup = value;
        await this.plugin.saveSettings();
      })
    ), "history");

    const openCodeSection = wrapper.createDiv({ cls: "codex-editor-actions-section" });
    openCodeSection.createDiv({ cls: "codex-editor-actions-heading", text: "OpenCode API 模式" });
    openCodeSection.createDiv({ cls: "codex-resource-note", text: `检测结果：${detectOpenCodePath(opencode.cliPath)}` });
    this.addProviderText(openCodeSection, "OpenCode 路径", opencode.cliPath, "/opt/homebrew/bin/opencode", async (value) => {
      opencode.cliPath = value.trim();
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(openCodeSection, "已有 Server 地址", opencode.serverUrl, "http://127.0.0.1:4096", async (value) => {
      opencode.serverUrl = value.trim().replace(/\/$/, "");
      await this.plugin.saveSettings();
    });
    this.decorateSetting(new Setting(openCodeSection).setName("自动启动 OpenCode server").addToggle((toggle) =>
      toggle.setValue(opencode.autoStart).onChange(async (value) => {
        opencode.autoStart = value;
        await this.plugin.saveSettings();
      })
    ), "power");
    this.addProviderText(openCodeSection, "Host", opencode.hostname, "127.0.0.1", async (value) => {
      opencode.hostname = value.trim() || "127.0.0.1";
      await this.plugin.saveSettings();
    });
    this.addProviderText(openCodeSection, "Port", String(opencode.port), "4096", async (value) => {
      opencode.port = parseClampedInteger(value, 4096, 1024, 65535);
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(openCodeSection, "Provider ID", opencode.providerId, "anthropic", async (value) => {
      opencode.providerId = value.trim();
      await this.plugin.saveSettings();
    });
    this.addProviderText(openCodeSection, "Model ID", opencode.modelId, "claude-sonnet-4-20250514", async (value) => {
      opencode.modelId = value.trim();
      await this.plugin.saveSettings();
    });
    this.addProviderText(openCodeSection, "Agent", opencode.agent, "build", async (value) => {
      opencode.agent = value.trim() || "build";
      await this.plugin.saveSettings();
    });
    openCodeSection.createDiv({
      cls: "codex-resource-note",
      text: `模型能力：文本 ${opencode.textEnabled ? "✓" : "×"} · 图片 ${opencode.imageEnabled ? "✓" : "×"} · PDF ${opencode.pdfEnabled ? "✓" : "×"}`
    });
    if (opencode.lastError) openCodeSection.createDiv({ cls: "codex-resource-error", text: opencode.lastError });
    const openCodeActions = openCodeSection.createDiv({ cls: "codex-api-provider-actions" });
    const testOpenCode = openCodeActions.createEl("button", { cls: "codex-resource-tab", text: "测试连接", attr: { type: "button" } });
    testOpenCode.onclick = async () => {
      await this.plugin.getKnowledgeBaseManager()?.testOpenCodeConnection();
      this.display();
    };

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: "维护、体检、收集链接、记录想法、收集图片/PDF 都在右侧“知识库管理”频道里用自然语言执行；设置页只负责配置和状态。"
    });
  }

  private addStatusActions(container: HTMLElement): void {
    const actions = container.createDiv({ cls: "codex-settings-status-actions" });
    const refresh = actions.createEl("button", {
      cls: "codex-resource-refresh",
      attr: { type: "button", title: "重启 Codex，并读取最新登录状态" }
    });
    const icon = refresh.createSpan({ cls: "codex-resource-refresh-icon" });
    setIcon(icon, "refresh-cw");
    const label = refresh.createSpan({ text: "刷新登录状态" });
    refresh.onclick = async () => {
      refresh.disabled = true;
      label.setText("刷新中");
      const status = await this.plugin.reconnectCodex({ refreshLogin: true });
      if (status.connected) new Notice(`Codex 已刷新：${status.accountLabel}`);
      else new Notice(`Codex 连接失败：${status.errors[0] ?? "未知错误"}`);
      this.display();
    };
  }

  private renderTopTabs(container: HTMLElement): void {
    const tabs = container.createDiv({ cls: "codex-settings-tabs" });
    for (const tab of SETTINGS_TABS) {
      const button = tabs.createEl("button", {
        cls: `codex-settings-tab ${this.plugin.settings.settingsTab === tab.id ? "is-active" : ""}`,
        attr: { type: "button" }
      });
      const icon = button.createSpan({ cls: "codex-settings-tab-icon" });
      setIcon(icon, tab.icon);
      button.createSpan({ text: tab.label });
      button.onclick = async () => {
        this.plugin.settings.settingsTab = tab.id;
        await this.plugin.saveSettings();
        this.display();
      };
    }
  }

  private renderApiProviderManager(container: HTMLElement): void {
    const wrapper = container.createDiv({ cls: "codex-api-provider-manager" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "key-round");
    title.createSpan({ text: "API Provider" });

    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: "API key 会明文保存在 Obsidian 插件数据里；只建议本机使用，不建议同步或提交。"
    });
    wrapper.createDiv({
      cls: "codex-resource-warning",
      text: "自定义 API 仍需要本机 Codex CLI。Base URL 必须兼容 OpenAI Responses API；只支持 /v1/chat/completions 的通用 OpenAI 格式通常不可用。"
    });

    const modeRow = wrapper.createDiv({ cls: "codex-api-provider-mode" });
    modeRow.createDiv({
      cls: "codex-resource-summary",
      text: `当前：${providerConnectionLabel(this.plugin.settings)}`
    });
    const loginButton = modeRow.createEl("button", {
      cls: `codex-resource-tab ${this.plugin.settings.providerMode === "codex-login" ? "is-active" : ""}`,
      text: "Codex 登录态",
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
      text: "新增",
      attr: { type: "button", title: "新增 API Provider" }
    });
    add.onclick = async () => {
      const provider: ApiProviderConfig = {
        id: newId("provider").replace(/[^A-Za-z0-9_-]/g, "_"),
        name: "自定义 API",
        baseUrl: "https://api.openai.com/v1",
        model: this.plugin.settings.defaultModel || DEFAULT_SETTINGS.defaultModel,
        models: [this.plugin.settings.defaultModel || DEFAULT_SETTINGS.defaultModel],
        apiKey: ""
      };
      this.plugin.settings.apiProviders.push(provider);
      this.plugin.settings.activeApiProviderId = provider.id;
      await this.plugin.saveSettings(true);
      this.display();
    };

    if (!this.plugin.settings.apiProviders.length) {
      wrapper.createDiv({ cls: "codex-resource-empty", text: "还没有自定义 API Provider。" });
      return;
    }

    const body = wrapper.createDiv({ cls: "codex-api-provider-list" });
    for (const provider of this.plugin.settings.apiProviders) {
      this.renderApiProviderRow(body, provider);
    }
  }

  private renderEditorActionSettings(container: HTMLElement): void {
    const settings = this.plugin.settings.editorActions;

    this.decorateSetting(
      new Setting(container)
        .setName("写作请求方式")
        .setDesc("通过当前 Codex CLI 发起请求；自定义 API 仍需本机 Codex CLI 支持 Responses API。"),
      "terminal"
    );

    this.decorateSetting(new Setting(container).setName("启用写作操作").setDesc("开启后，编辑区选中文字右键可选择改写、扩写、续写。").addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.plugin.saveSettings();
        this.display();
      })
    ), "toggle-right");

    this.decorateSetting(new Setting(container).setName("显示侧栏写作状态").setDesc("只在右键写作操作运行时显示等待和确认状态。").addToggle((toggle) =>
      toggle.setValue(settings.statusSlotEnabled).onChange(async (value) => {
        settings.statusSlotEnabled = value;
        await this.plugin.saveSettings();
      })
    ), "activity");

    this.decorateSetting(new Setting(container).setName("显示写作上下文面板").setDesc("点击侧栏顶部写作状态时，展示文章理解、模式和模型信息。").addToggle((toggle) =>
      toggle.setValue(settings.showContextPanel).onChange(async (value) => {
        settings.showContextPanel = value;
        await this.plugin.saveSettings();
      })
    ), "file-search");

    this.decorateSetting(new Setting(container).setName("默认写作质量").setDesc("快速直接生成；质量会先理解文章；严格会额外审校候选。").addDropdown((dropdown) => {
      for (const mode of EDITOR_ACTION_QUALITY_MODES) dropdown.addOption(mode.id, mode.label);
      dropdown.setValue(settings.qualityMode);
      dropdown.onChange(async (value) => {
        settings.qualityMode = normalizeEditorActionQualityModeForUi(value);
        await this.plugin.saveSettings();
        this.display();
      });
    }), "gauge");

    this.decorateSetting(new Setting(container).setName("默认写作风格").addDropdown((dropdown) => {
      for (const style of settings.styles) dropdown.addOption(style.id, style.label || style.id);
      dropdown.setValue(settings.defaultStyleId);
      dropdown.onChange(async (value) => {
        settings.defaultStyleId = value;
        await this.plugin.saveSettings();
      });
    }), "palette");

    this.addEditorActionNumber(container, "最大选区字数", settings.maxSelectedChars, 200, 20000, async (value) => {
      settings.maxSelectedChars = value;
      await this.plugin.saveSettings();
    });
    this.addEditorActionNumber(container, "超时时间（秒）", Math.round(settings.timeoutMs / 1000), 10, 300, async (value) => {
      settings.timeoutMs = value * 1000;
      await this.plugin.saveSettings();
    });

    this.renderEditorActionModeConfigs(container);

    this.decorateSetting(new Setting(container).setName("文章理解缓存").setDesc(`当前缓存 ${Object.keys(settings.articleUnderstandingCache).length} 篇文章理解。`).addButton((button) =>
      button.setButtonText("清空").setIcon("trash-2").onClick(async () => {
        settings.articleUnderstandingCache = {};
        await this.plugin.saveSettings();
        this.display();
      })
    ), "database");

    this.renderEditorActionList(container, settings.actions);
    this.renderEditorStyleList(container, settings.styles);
  }

  private renderEditorActionList(container: HTMLElement, actions: EditorAiActionConfig[]): void {
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: "右键动作" });
    for (const action of actions) {
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-action-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, "sparkles");
      title.createSpan({ text: action.label || action.id });
      title.createSpan({ cls: "codex-resource-row-meta", text: action.enabled ? "已启用" : "已关闭" });
      const toggleWrap = head.createDiv({ cls: "codex-api-provider-actions" });
      new Setting(toggleWrap).addToggle((toggle) =>
        toggle.setValue(action.enabled).onChange(async (value) => {
          action.enabled = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );
      this.addProviderText(row, "名称", action.label, "改写", async (value) => {
        action.label = value.trim() || action.id;
        await this.plugin.saveSettings();
        this.display();
      });
      this.addProviderTextArea(row, "Prompt 模板", action.promptTemplate, "请处理：{{selected_text}}", async (value) => {
        action.promptTemplate = value.trim();
        await this.plugin.saveSettings();
      });
    }
  }

  private renderEditorActionModeConfigs(container: HTMLElement): void {
    const settings = this.plugin.settings.editorActions;
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    section.createDiv({ cls: "codex-editor-actions-heading", text: "写作质量模式" });
    const modelChoices = ensureModelChoices(this.plugin.lastStatus?.models ?? [], "gpt-5.4-mini", "gpt-5.4", "gpt-5.5", DEFAULT_SETTINGS.defaultModel);
    for (const mode of EDITOR_ACTION_QUALITY_MODES) {
      const config = settings.modeConfigs[mode.id];
      const row = section.createDiv({ cls: "codex-api-provider-row codex-editor-mode-row" });
      const head = row.createDiv({ cls: "codex-api-provider-head" });
      const title = head.createDiv({ cls: "codex-api-provider-title" });
      const icon = title.createSpan({ cls: "codex-resource-row-icon" });
      setIcon(icon, mode.icon);
      title.createSpan({ text: mode.label });
      title.createSpan({ cls: "codex-resource-row-meta", text: mode.desc });

      this.decorateSetting(new Setting(row).setName("模型").addDropdown((dropdown) => {
        for (const model of ensureModelChoices(modelChoices, config.model)) dropdown.addOption(model.model, model.displayName || model.model);
        dropdown.setValue(config.model);
        dropdown.onChange(async (value) => {
          config.model = value;
          await this.plugin.saveSettings();
        });
      }), "box");
      this.addEditorActionNumber(row, "选区前文字符数", config.contextCharsBefore, 0, 10000, async (value) => {
        config.contextCharsBefore = value;
        if (mode.id === "fast") settings.contextCharsBefore = value;
        await this.plugin.saveSettings();
      });
      this.addEditorActionNumber(row, "选区后文字符数", config.contextCharsAfter, 0, 10000, async (value) => {
        config.contextCharsAfter = value;
        if (mode.id === "fast") settings.contextCharsAfter = value;
        await this.plugin.saveSettings();
      });
    }
  }

  private renderEditorStyleList(container: HTMLElement, styles: EditorAiStyleConfig[]): void {
    const section = container.createDiv({ cls: "codex-editor-actions-section" });
    const header = section.createDiv({ cls: "codex-resource-manager-header" });
    header.createDiv({ cls: "codex-editor-actions-heading", text: "写作风格" });
    const add = header.createEl("button", {
      cls: "codex-resource-refresh",
      text: "新增风格",
      attr: { type: "button" }
    });
    add.onclick = async () => {
      const id = `style_${Date.now()}`;
      styles.push({ id, label: "自定义风格", instruction: "按我的个人表达习惯改写。" });
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
        const remove = actions.createEl("button", { cls: "codex-resource-tab", text: "删除", attr: { type: "button" } });
        remove.onclick = async () => {
          this.plugin.settings.editorActions.styles = styles.filter((item) => item.id !== style.id);
          if (this.plugin.settings.editorActions.defaultStyleId === style.id) this.plugin.settings.editorActions.defaultStyleId = "clear";
          await this.plugin.saveSettings(true);
          this.display();
        };
      }
      this.addProviderText(row, "名称", style.label, "清楚", async (value) => {
        style.label = value.trim() || style.id;
        await this.plugin.saveSettings();
        this.display();
      });
      this.addProviderTextArea(row, "风格说明", style.instruction, "表达清楚、准确、自然。", async (value) => {
        style.instruction = value.trim();
        await this.plugin.saveSettings();
      });
    }
  }

  private renderApiProviderRow(container: HTMLElement, provider: ApiProviderConfig): void {
    const activeProvider = getActiveApiProvider(this.plugin.settings);
    const row = container.createDiv({
      cls: `codex-api-provider-row ${activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api" ? "is-active" : ""}`
    });
    const head = row.createDiv({ cls: "codex-api-provider-head" });
    const title = head.createDiv({ cls: "codex-api-provider-title" });
    const icon = title.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, "key-round");
    title.createSpan({ text: provider.name || "未命名 Provider" });
    title.createSpan({ cls: "codex-resource-row-meta", text: providerModelLabel(provider) });

    const actions = head.createDiv({ cls: "codex-api-provider-actions" });
    const enable = actions.createEl("button", {
      cls: "codex-resource-tab",
      text: activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api" ? "已启用" : "启用并重连",
      attr: { type: "button" }
    });
    enable.onclick = async () => {
      const errors = validateApiProvider(provider);
      if (errors.length) {
        new Notice(`无法启用：${errors.join("，")}`);
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
      text: "删除",
      attr: { type: "button" }
    });
    remove.onclick = async () => {
      if (!window.confirm(`删除 ${provider.name || "这个 Provider"}？`)) return;
      const wasActive = this.plugin.settings.providerMode === "custom-api" && this.plugin.settings.activeApiProviderId === provider.id;
      removeApiProvider(this.plugin.settings, provider.id);
      await this.plugin.saveSettings(true);
      if (wasActive) await this.plugin.reconnectCodex();
      this.display();
    };

    this.addProviderText(row, "名称", provider.name, "例如 OpenAI API", async (value) => {
      provider.name = value.trim();
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(row, "Base URL", provider.baseUrl, "https://api.openai.com/v1", async (value) => {
      provider.baseUrl = value.trim();
      await this.plugin.saveSettings();
    });
    row.createDiv({ cls: "codex-resource-note", text: "要求：服务端需支持 Responses API，例如 /v1/responses；只支持 Chat Completions 的服务可能无法使用。" });
    this.addProviderTextArea(row, "模型", getApiProviderModels(provider).join("\n"), `${DEFAULT_SETTINGS.defaultModel}\ngpt-5.4`, async (value) => {
      const models = parseModelList(value);
      provider.models = models;
      provider.model = models[0] ?? "";
      await this.plugin.saveSettings();
      this.display();
    });
    this.addProviderText(row, "API key", provider.apiKey, "sk-...", async (value) => {
      provider.apiKey = value.trim();
      await this.plugin.saveSettings();
    }, "password");
    this.addProviderTextArea(row, "Query Params", formatQueryParams(provider.queryParams), "api-version=2026-04-28", async (value) => {
      provider.queryParams = parseQueryParams(value);
      if (!Object.keys(provider.queryParams).length) delete provider.queryParams;
      await this.plugin.saveSettings();
    });

    const errors = validateApiProvider(provider);
    if (errors.length) row.createDiv({ cls: "codex-resource-error", text: `缺少：${errors.join("，")}` });
    if (activeProvider?.id === provider.id && this.plugin.settings.providerMode === "custom-api") {
      row.createDiv({ cls: "codex-resource-note", text: "修改配置后，需要再次点击“启用并重连”才会让当前 Codex 进程生效。" });
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

  private addKnowledgeBaseRulesFilePicker(container: HTMLElement): void {
    const settings = this.plugin.settings.knowledgeBase;
    const currentPath = settings.useCustomRulesFile ? settings.rulesFilePath : "AGENTS.md";
    const field = container.createDiv({ cls: "codex-api-provider-field" });
    field.createDiv({ cls: "codex-api-provider-label", text: "知识库操作指南文件" });
    const picker = field.createDiv({ cls: "codex-rules-file-picker" });
    const valueButton = picker.createEl("button", {
      cls: "codex-rules-file-value",
      attr: { type: "button", title: "从当前 Vault 选择 Markdown 文件" }
    });
    const valueIcon = valueButton.createSpan({ cls: "codex-rules-file-icon" });
    setIcon(valueIcon, "file-cog");
    valueButton.createSpan({ text: currentPath });
    valueButton.onclick = () => this.openKnowledgeBaseRulesFilePicker();

    const chooseButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: "选择文件",
      attr: { type: "button" }
    });
    chooseButton.onclick = () => this.openKnowledgeBaseRulesFilePicker();

    const resetButton = picker.createEl("button", {
      cls: "codex-resource-tab",
      text: "使用 AGENTS.md",
      attr: { type: "button" }
    });
    resetButton.disabled = !settings.useCustomRulesFile && currentPath === "AGENTS.md";
    resetButton.onclick = async () => {
      settings.useCustomRulesFile = false;
      settings.rulesFilePath = "AGENTS.md";
      await this.plugin.saveSettings();
      this.display();
    };

    field.createDiv({
      cls: "codex-resource-note codex-rules-file-note",
      text: settings.useCustomRulesFile
        ? "已启用自定义指南。任务只读取这个文件，不合并 AGENTS.md。"
        : "默认读取 Vault 根目录 AGENTS.md；选择文件后会自动启用自定义指南。"
    });
  }

  private openKnowledgeBaseRulesFilePicker(): void {
    const filesByPath = new Map(this.app.vault.getMarkdownFiles().map((file) => [file.path, file]));
    const files = getKnowledgeBaseRulesFileChoices(Array.from(filesByPath.keys()))
      .map((filePath) => filesByPath.get(filePath))
      .filter((file): file is TFile => file instanceof TFile);
    if (!files.length) {
      new Notice("当前 Vault 没有可选的 Markdown 文件。");
      return;
    }
    new KnowledgeBaseRulesFileSuggestModal(this.app, files, async (file) => {
      const settings = this.plugin.settings.knowledgeBase;
      settings.useCustomRulesFile = true;
      settings.rulesFilePath = sanitizeRelativeSettingsPath(file.path);
      await this.plugin.saveSettings();
      new Notice(`已选择知识库指南：${settings.rulesFilePath}`);
      this.display();
    }).open();
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
    const wrapper = container.createDiv({ cls: "codex-resource-manager" });
    const header = wrapper.createDiv({ cls: "codex-resource-manager-header" });
    const title = header.createDiv({ cls: "codex-resource-manager-title" });
    const icon = title.createSpan({ cls: "codex-setting-icon" });
    setIcon(icon, "blocks");
    title.createSpan({ text: "工作区能力管理" });

    wrapper.createDiv({
      cls: "codex-resource-note",
      text: "这里只改当前 Obsidian 仓库的线程配置，不写入桌面端 Codex 全局配置。"
    });

    const tabs = wrapper.createDiv({ cls: "codex-resource-tabs" });
    for (const tab of RESOURCE_TABS) {
      const button = tabs.createEl("button", {
        cls: `codex-resource-tab ${this.plugin.settings.resourceManagementTab === tab.id ? "is-active" : ""}`,
        attr: { type: "button" }
      });
      const tabIcon = button.createSpan({ cls: "codex-resource-tab-icon" });
      setIcon(tabIcon, tab.icon);
      button.createSpan({ text: tab.label });
      button.onclick = async () => {
        this.plugin.settings.resourceManagementTab = tab.id;
        await this.plugin.saveSettings();
        this.display();
      };
    }
    const refresh = tabs.createEl("button", {
      cls: "codex-resource-refresh",
      attr: { type: "button", title: "刷新当前列表" }
    });
    const refreshIcon = refresh.createSpan({ cls: "codex-resource-refresh-icon" });
    setIcon(refreshIcon, "refresh-cw");
    refresh.createSpan({ text: this.resourceLoadingTab === this.plugin.settings.resourceManagementTab ? "读取中" : "刷新" });
    refresh.disabled = this.resourceLoadingTab === this.plugin.settings.resourceManagementTab;
    refresh.onclick = () => void this.loadWorkspaceResources(true, this.plugin.settings.resourceManagementTab);

    const body = wrapper.createDiv({ cls: "codex-resource-body" });
    const activeTab = this.plugin.settings.resourceManagementTab;
    const activeMeta = RESOURCE_TABS.find((tab) => tab.id === activeTab);
    const isLoading = this.resourceLoadingTab === activeTab;
    const loadError = this.resourceLoadErrors[activeTab] ?? "";
    if (isLoading) {
      body.createDiv({ cls: "codex-resource-empty", text: `正在读取 Codex ${activeMeta?.label ?? "能力"}...` });
    }
    if (loadError) {
      body.createDiv({ cls: "codex-resource-error", text: `读取失败：${loadError}` });
    }
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) {
      body.createDiv({ cls: "codex-resource-empty", text: "尚未读取能力列表。" });
    }
    if (this.resourceSnapshot && (this.resourceLoaded[activeTab] || isLoading)) this.renderActiveResourceTab(body, this.resourceSnapshot);
    if (!this.resourceLoaded[activeTab] && !isLoading && !loadError) void this.loadWorkspaceResources(false, activeTab);
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
    this.renderResourceSummary(container, plugins.length, plugins.filter((plugin) => resourceEnabled(this.plugin.settings.workspaceResources.plugins, plugin.id, plugin.enabled !== false)).length, error);
    if (!plugins.length) {
      container.createDiv({ cls: "codex-resource-empty", text: "没有读取到插件。" });
      return;
    }
    for (const plugin of plugins) {
      this.renderResourceRow(container, {
        key: plugin.id,
        kind: "plugins",
        name: plugin.displayName || plugin.name || plugin.id,
        meta: [plugin.category, plugin.marketplace, plugin.installed ? "已安装" : "未安装"].filter(Boolean).join(" · "),
        desc: plugin.description || plugin.id,
        enabled: resourceEnabled(this.plugin.settings.workspaceResources.plugins, plugin.id, plugin.enabled !== false)
      });
    }
  }

  private renderMcpResources(container: HTMLElement, servers: McpServerStatus[], error?: string): void {
    this.renderResourceSummary(container, servers.length, servers.filter((server) => resourceEnabled(this.plugin.settings.workspaceResources.mcpServers, server.name, true)).length, error);
    if (!this.plugin.settings.mcpEnabled && servers.length) {
      container.createDiv({ cls: "codex-resource-warning", text: "聊天 MCP 总开关当前关闭；单项开关会保存，打开总开关后生效。" });
    }
    if (!servers.length) {
      container.createDiv({ cls: "codex-resource-empty", text: "没有读取到 MCP 服务器。" });
      return;
    }
    for (const server of servers) {
      this.renderResourceRow(container, {
        key: server.name,
        kind: "mcpServers",
        name: server.name,
        meta: `${Object.keys(server.tools ?? {}).length} 个工具 · ${server.authStatus ?? "unknown"}`,
        desc: "来自 Codex MCP 配置",
        enabled: resourceEnabled(this.plugin.settings.workspaceResources.mcpServers, server.name, true)
      });
    }
  }

  private renderSkillResources(container: HTMLElement, skills: CodexSkill[], error?: string): void {
    this.renderResourceSummary(container, skills.length, skills.filter((skill) => resourceEnabled(this.plugin.settings.workspaceResources.skills, skill.path || skill.name, skill.enabled !== false)).length, error);
    if (!skills.length) {
      container.createDiv({ cls: "codex-resource-empty", text: "没有读取到 Skills。" });
      return;
    }
    for (const skill of skills) {
      this.renderResourceRow(container, {
        key: skill.path || skill.name,
        kind: "skills",
        name: `/${skill.name}`,
        meta: [skill.scope, skill.path].filter(Boolean).join(" · "),
        desc: skill.description || "无描述",
        enabled: resourceEnabled(this.plugin.settings.workspaceResources.skills, skill.path || skill.name, skill.enabled !== false)
      });
    }
  }

  private renderResourceSummary(container: HTMLElement, total: number, enabled: number, error?: string): void {
    container.createDiv({ cls: "codex-resource-summary", text: `已允许 ${enabled} / ${total}` });
    if (error) container.createDiv({ cls: "codex-resource-error", text: `部分读取失败：${error}` });
  }

  private renderResourceRow(
    container: HTMLElement,
    item: {
      key: string;
      kind: "plugins" | "mcpServers" | "skills";
      name: string;
      meta: string;
      desc: string;
      enabled: boolean;
    }
  ): void {
    const row = container.createDiv({ cls: `codex-resource-row ${item.enabled ? "is-enabled" : "is-disabled"}` });
    const icon = row.createSpan({ cls: "codex-resource-row-icon" });
    setIcon(icon, item.kind === "skills" ? "sparkles" : item.kind === "mcpServers" ? "blocks" : "package");
    const content = row.createDiv({ cls: "codex-resource-row-content" });
    content.createDiv({ cls: "codex-resource-row-name", text: item.name });
    if (item.meta) content.createDiv({ cls: "codex-resource-row-meta", text: item.meta });
    if (item.desc) content.createDiv({ cls: "codex-resource-row-desc", text: item.desc });
    const toggle = row.createEl("input", {
      cls: "codex-resource-toggle",
      attr: { type: "checkbox", "aria-label": `${item.name} 开关` }
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
      if (!status.connected || !this.plugin.codex) throw new Error("Codex 未连接");
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
    if (!this.plugin.codex) throw new Error("Codex 未连接");
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

const RESOURCE_TABS: Array<{ id: ResourceManagementTab; label: string; icon: string }> = [
  { id: "plugins", label: "插件", icon: "package" },
  { id: "mcp", label: "MCP", icon: "blocks" },
  { id: "skills", label: "Skills", icon: "sparkles" }
];

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: "general", label: "基础设置", icon: "settings" },
  { id: "providers", label: "API Provider", icon: "key-round" },
  { id: "resources", label: "工作区能力", icon: "blocks" },
  { id: "editorActions", label: "写作操作", icon: "wand-sparkles" },
  { id: "knowledgeBase", label: "知识库管理", icon: "library" }
];

const EDITOR_ACTION_QUALITY_MODES: Array<{ id: EditorActionQualityMode; label: string; icon: string; desc: string }> = [
  { id: "fast", label: "快速", icon: "zap", desc: "短句润色，直接生成" },
  { id: "quality", label: "质量", icon: "file-search", desc: "先理解文章，再生成" },
  { id: "strict", label: "严格", icon: "shield-check", desc: "理解、生成、审校" }
];

function normalizeEditorActionQualityModeForUi(value: string): EditorActionQualityMode {
  return value === "fast" || value === "quality" || value === "strict" ? value : "quality";
}

function resourceKindForTab(tab: ResourceManagementTab): WorkspaceResourceKind {
  return tab === "mcp" ? "mcp" : tab === "skills" ? "skills" : "plugins";
}

function detectCliPath(customPath: string): string {
  const found = detectCodexCommand(customPath);
  return found ? `已检测：${found}` : "未检测到，可手动填写";
}

function detectOpenCodePath(customPath: string): string {
  const found = detectOpenCodeCommand(customPath);
  return found ? `已检测：${found}` : "未检测到，可手动填写";
}

function agentBackendLabel(value: AgentBackendMode): string {
  return value === "opencode" ? "OpenCode API" : "Codex CLI";
}

class KnowledgeBaseRulesFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly files: TFile[], private readonly onChoose: (file: TFile) => Promise<void>) {
    super(app);
    this.setPlaceholder("选择知识库操作指南 Markdown 文件");
    this.emptyStateText = "当前 Vault 没有匹配的 Markdown 文件";
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

function knowledgeStatusLabel(value: string): string {
  if (value === "running") return "运行中";
  if (value === "success") return "成功";
  if (value === "failed") return "失败";
  if (value === "canceled") return "已取消";
  return "未运行";
}

function pluginInstallDir(plugin: CodexForObsidianPlugin): string {
  const dir = (plugin.manifest as any).dir;
  return dir ? `${dir}/` : ".obsidian/plugins/obsidian-codex/";
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
  return clean || "AGENTS.md";
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
