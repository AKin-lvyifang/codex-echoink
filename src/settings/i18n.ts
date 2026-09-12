
import type {
  KnowledgeBaseInitStatus,
  KnowledgeBaseRunStatus,
  ResourceManagementTab,
  ReviewRangeMode,
  ReviewReportKind,
  SettingsLanguage,
  SettingsTab,
} from "./settings";
import type { PermissionMode, UiMode } from "../types/app-server";
import type { KnowledgeBaseRunCompletion } from "../knowledge-base/types";

const ZH_CN = {
  languageName: "中文",
  title: "EchoInk Agent 设置",
  common: {
    enabled: "启用",
    disabled: "关闭",
    connected: "已连接",
    disconnected: "未连接",
    unknown: "未知",
    current: (value: string) => `当前：${value}`,
    readFailed: (error: string) => `读取失败：${error}`,
    partialReadFailed: (error: string) => `部分读取失败：${error}`,
    detected: (value: string) => `已检测：${value}`,
    notDetectedManual: "未检测到，可手动填写",
    missing: (items: string[]) => `缺少：${items.join("，")}`,
    enableFailed: (items: string[]) => `无法启用：${items.join("，")}`,
    refresh: "刷新",
    loading: "读取中",
    cancel: "取消",
    delete: "删除",
    clear: "清空"
  },
  tabs: {
    general: "基础设置",
    providers: "API Provider",
    resources: "Skills & MCP",
    knowledgeBase: "知识库管理",
    review: "复盘",
    todos: "待办"
  } satisfies Record<SettingsTab, string>,
  general: {
    settingsLanguage: "设置语言",
    settingsLanguageDesc: "控制 EchoInk 界面语言；不会改写 Prompt、会话内容或用户自定义名称。",
    auto: "自动",
    defaultPermission: "默认文件权限",
    defaultMode: "默认模式",
    autoOpen: "启动时自动打开侧栏",
    autoOpenHome: "启动时自动打开首页",
    customWelcome: "自定义加载欢迎语",
    customWelcomeDesc: "开启后可修改空会话里的标题和问候语；关闭时使用默认文案。不会写入对话，也不占用模型 Token。",
    welcomeTitle: "欢迎标题",
    welcomeTitleDesc: "空会话中显示的大标题；留空时使用默认标题。",
    welcomeGreeting: "问候语",
    welcomeGreetingDesc: "标题下方的小字；留空时使用默认问候语。",
    languageOptions: {
      "zh-CN": "中文",
      en: "English"
    } satisfies Record<SettingsLanguage, string>,
    permissionOptions: {
      "read-only": "只读",
      "workspace-write": "工作区可写",
      "danger-full-access": "完全放开"
    } satisfies Record<PermissionMode, string>,
    modeOptions: {
      agent: "Agent",
      plan: "Plan"
    } satisfies Record<UiMode, string>
  },
  knowledge: {
    title: "知识库管理",
    safety: "EchoInk 只响应显式 /maintain，在同一轮核对来源、安全写入并回读验证；原始资料保持不变。",
    lastRunIncomplete: "上一次知识库运行未完成。请检查当前模型设置和操作指南后，从知识库面板重试。",
    statusHeading: "运行状态",
    recentStatus: (status: string, time: string) => `最近状态：${status}${time ? ` · ${time}` : ""}`,
    recentCompletion: (completion: string, attempts: number, pending: number) => [
      `结果：${completion}`,
      attempts > 1 ? `${attempts} 次 Agent 尝试` : "",
      pending ? `${pending} 项留待下轮` : ""
    ].filter(Boolean).join(" · "),
    completionLabels: {
      full: "完整完成",
      partial: "部分完成",
      recovered: "恢复后完成",
      noop: "已检查（无新来源）"
    } satisfies Record<KnowledgeBaseRunCompletion, string>,
    initialization: (status: string, path: string) => `初始化：${status}${path ? ` · ${path}` : ""}`,
    recentReport: (path: string) => `最近报告：${path}`,
    openChannel: "打开当前 Conversation",
    initChannel: "初始化知识库",
    commandHeading: "快捷命令",
    commandGuide: [
      { command: "/ask ...", description: "对知识库发问" },
      { command: "/maintain ...", description: "一次完成知识提炼、安全写入和回读验证" }
    ],
    enabled: "启用知识库管理",
    backend: "知识库使用模型",
    backendDesc: "统一继承当前启用的 Provider 与 Model；请在 API Provider 中修改。",
    followGlobal: (backend: string) => `跟随全局（${backend}）`,
    detection: (value: string) => `检测结果：${value}`,
    modelCapabilities: (text: boolean, image: boolean, pdf: boolean) => `模型能力：文本 ${text ? "✓" : "×"} · 图片 ${image ? "✓" : "×"} · PDF ${pdf ? "✓" : "×"}`,
    testConnection: "测试连接",
    channelNote: "在当前 Pi Conversation 使用 /ask 或 /maintain；设置页负责初始化、维护偏好和运行状态。",
    memoryHeading: "EchoInk 文件化 Memory",
    memoryNote1: "Markdown 是当前 Vault 长期 Memory 的内容真源；身份、用户画像和历史记录按固定路径隔离保存。",
    memoryNote2: "AGENT.md、USER.md 与 MEMORY.md 在每次请求重新读取；历史记录只通过受控 Memory Tool 渐进访问。",
    memoryEnabled: "启用长期记忆",
    memoryEnabledDesc: "普通 Chat 和 /ask 会读取提炼记忆，并获得仍在保留期内的本地记录查询入口；维护类 workflow 只在本地提交成功后记录结果。",
    memoryStatusLine: (initialized: boolean, revision: number, pending: number, confirmations: number, issues: number) => `状态：${initialized ? "已初始化" : "未初始化"} · revision ${revision} · pending ${pending} · 待确认 ${confirmations} · 异常 ${issues}`,
    memoryLastSync: (outcome: string, time: string) => `最近同步：${outcome}${time ? ` · ${time}` : ""}`,
    memoryStatusFailed: (_error: string) => "Memory 状态暂时无法读取。请重新加载；若仍未恢复，请使用“恢复事务”。",
    memoryReload: "重新加载状态",
    memoryInitialize: "初始化",
    memorySync: "立即同步",
    memoryRecover: "恢复事务",
    memoryConfirmations: "待确认 / 冲突",
    memoryConflicts: (ids: string) => `冲突项：${ids}`,
    memoryAccept: "接受",
    memoryDismiss: "忽略",
    memoryIssues: "未解决事务",
    memoryRetry: "重试同步",
    memoryDrop: "放弃 pending",
    memoryItems: "已记录项",
    memoryDeleteConfirm: (statement: string) => `删除这条 EchoInk 长期记忆？\n\n${statement}`,
    memoryActionFailed: (_error: string) => "Memory 操作未完成。请重新加载状态后重试。",
    statusLabels: {
      idle: "未运行",
      running: "运行中",
      success: "成功",
      failed: "失败",
      canceled: "已取消"
    } satisfies Record<KnowledgeBaseRunStatus, string>,
    initStatusLabels: {
      "not-started": "未初始化",
      "preview-ready": "已生成预览",
      initialized: "已初始化",
      failed: "失败"
    } satisfies Record<KnowledgeBaseInitStatus, string>
  },
  review: {
    title: "复盘",
    generateHeading: "生成周报",
    generateAgent: "生成 Agent 周报",
    generateKnowledge: "生成知识库周报",
    pathsHeading: "存放路径",
    outputDir: "输出目录",
    knowledgeMarkdown: "知识库 Markdown",
    knowledgeHtml: "知识库 HTML",
    agentMarkdown: "Agent Markdown",
    agentHtml: "Agent HTML",
    settingsHeading: "周报设置",
    confirmTitle: (label: string) => label,
    confirmBody: (report: string, outputDir: string) => `确定生成${report}？\n\n输出目录：${outputDir}`,
    generate: "生成",
    cancel: "取消",
    reportLabels: {
      "knowledge-base": "知识库周报",
      "agent-chat": "Agent 周报"
    } satisfies Record<ReviewReportKind, string>,
    rangeMode: "统计周期",
    rangeOptions: {
      "previous-week": "上一完整周",
      "current-week": "本周至今"
    } satisfies Record<ReviewRangeMode, string>,
    openHtmlAfterRun: "生成后打开 HTML"
  },
  providers: {
    title: "API Provider",
    simpleSetup: "选择服务商，确认 API URL，输入 API Key 后保存即可聊天。API Key 直接保存在当前 Vault 的插件设置中。",
    provider: "Provider",
    protocol: "API 协议",
    protocolOptions: {
      "openai-responses": "OpenAI Responses",
      "openai-completions": "OpenAI 兼容（Chat Completions）",
      "anthropic-messages": "Anthropic Messages"
    },
    modelPreset: (model: string) => `默认模型：${model}`,
    modelId: "Model ID",
    modelPlaceholder: "请获取或添加模型",
    addCustomModel: "添加自定义 Model ID",
    customModelPrompt: "输入 Model ID，例如 provider/model",
    invalidModel: "Model ID 无效，请输入不含空格的有效 ID",
    fetchModels: "获取模型",
    refreshModels: "刷新模型",
    modelListIdle: "未获取模型列表",
    modelListLoading: "正在获取模型列表…",
    modelListAvailable: (count: number) => `已获取 ${count} 个模型，请从下拉列表选择`,
    modelListUnsupported: "该服务未提供可读取的模型列表，请使用右侧 + 添加 Model ID",
    modelListApiKeyError: "API Key 无效或没有模型列表权限，请检查后重试",
    modelListRateOrServiceError: "Provider 正在限流或服务暂时异常，请稍后重试。已保存模型不会受影响。",
    modelListNetworkError: "无法连接 Provider，请检查网络与接口地址后重试。",
    modelListResponseFormatError: "Provider 返回了无法识别的模型列表格式，请手动输入准确的 Model ID。",
    modelListFailed: "本次获取失败。已保存模型仍会保留，也可在下拉中手动输入模型 ID。",
    keyPlaceholder: "输入 API Key",
    savedKeyPlaceholder: "API Key 已保存；留空表示继续使用",
    showKey: "显示当前输入",
    hideKey: "隐藏当前输入",
    testConnection: "测试连接",
    testingConnection: "测试中…",
    connectionIdle: "尚未测试连接；测试会产生一次极少量 API 费用",
    connectionAvailable: "连接可用",
    connectionFailures: {
      auth: "API Key 无效或没有权限",
      protocol: "Base URL 与所选协议可能不匹配",
      model: "当前 Model ID 不可用",
      rate_limit: "已连接，但当前额度不足或正在限流",
      network: "无法连接服务",
      provider: "Provider 暂时异常"
    },
    saveAndUse: "保存并使用",
    saving: "保存中…",
    missingKey: "请输入 API Key。",
    saved: (provider: string) => `${provider} 已保存，可以直接聊天。`,
    saveFailed: "Provider 未能保存或启用。请检查 Endpoint、API Key、协议与网络后重试。",
    warningKey: "API Key 输入会被遮挡，并直接保存在当前 Vault 的 EchoInk 插件设置中。",
    warningApi: "API URL 需要兼容所选的 API 协议。",
    add: "新增",
    addTitle: "新增 API Provider",
    defaultName: "自定义 API",
    empty: "还没有自定义 API Provider。",
    unnamed: "未命名 Provider",
    active: "已启用",
    enableReconnect: "启用并重连",
    deleteConfirm: (name: string) => `删除 ${name || "这个 Provider"}？`,
    name: "名称",
    namePlaceholder: "例如 OpenAI API",
    baseUrl: "Base URL",
    apiKey: "API key",
    queryParams: "Query Params",
    responseApiRequirement: "要求：服务端需支持 OpenAI Chat Completions。",
    models: "模型"
  },
  resources: {
    title: "Skills & MCP",
    note: "用列表开关控制 EchoInk 可用的插件、MCP 与 Skills。",
    tabs: {
      plugins: "插件",
      mcp: "MCP",
      skills: "Skills"
    } satisfies Record<ResourceManagementTab, string>,
    refreshTitle: "刷新当前列表",
    loadingTab: (label: string) => `正在同步 ${label}…`,
    notLoaded: "资源尚未同步。请刷新后重试。",
    searchPlaceholder: (label: string) => `搜索 ${label}`,
    searchAria: "搜索当前能力列表",
    clearSearch: "清空搜索",
    installed: "已安装",
    notInstalled: "未安装",
    noPlugins: "没有读取到插件。",
    noPluginMatches: "没有匹配的插件。",
    toolsCount: (count: number) => `${count} 个工具`,
    mcpDesc: "已导入到 EchoInk 资源目录",
    noMcp: "没有读取到 MCP 服务器。",
    noMcpMatches: "没有匹配的 MCP 服务器。",
    noDesc: "无描述",
    noSkills: "没有读取到 Skills。",
    noSkillMatches: "没有匹配的 Skill。",
    preset: "预设",
    summary: (label: string, enabled: number, total: number, visible: number, searching: boolean) => searching ? `${label}：已启用 ${enabled} / ${total} · 显示 ${visible}` : `${label}：已启用 ${enabled} / ${total}`,
    toggleAria: (name: string) => `${name} 开关`,
    codexDisconnected: "资源尚未连接"
  },
};

export type SettingsCopy = typeof ZH_CN;

const EN: SettingsCopy = {
  languageName: "English",
  title: "EchoInk Agent Settings",
  common: {
    enabled: "Enabled",
    disabled: "Off",
    connected: "Connected",
    disconnected: "Disconnected",
    unknown: "Unknown",
    current: (value) => `Current: ${value}`,
    readFailed: (error) => `Failed to load: ${error}`,
    partialReadFailed: (error) => `Some items failed: ${error}`,
    detected: (value) => `Detected: ${value}`,
    notDetectedManual: "Not found. Enter manually.",
    missing: (items) => `Missing: ${items.join(", ")}`,
    enableFailed: (items) => `Cannot enable: ${items.join(", ")}`,
    refresh: "Refresh",
    loading: "Loading",
    cancel: "Cancel",
    delete: "Delete",
    clear: "Clear"
  },
  tabs: {
    general: "General",
    providers: "API Provider",
    resources: "Skills & MCP",
    knowledgeBase: "Knowledge",
    review: "Review",
    todos: "To-dos"
  },
  general: {
    settingsLanguage: "Settings language",
    settingsLanguageDesc: "Controls the EchoInk interface language. Prompts, chats, and custom names are unchanged.",
    auto: "Auto",
    defaultPermission: "Default file access",
    defaultMode: "Default mode",
    autoOpen: "Open sidebar on startup",
    autoOpenHome: "Open homepage on startup",
    customWelcome: "Customize welcome message",
    customWelcomeDesc: "Turn this on to edit the empty-chat title and greeting. When off, EchoInk uses the default copy. It is never added to the conversation or model tokens.",
    welcomeTitle: "Welcome title",
    welcomeTitleDesc: "The large heading shown in an empty conversation. Leave blank to use the default.",
    welcomeGreeting: "Greeting",
    welcomeGreetingDesc: "The smaller line below the title. Leave blank to use the default.",
    languageOptions: {
      "zh-CN": "中文",
      en: "English"
    },
    permissionOptions: {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Full access"
    },
    modeOptions: {
      agent: "Agent",
      plan: "Plan"
    }
  },
  knowledge: {
    title: "Knowledge",
    safety: "EchoInk responds only to explicit /maintain, checks sources, writes safely, and verifies readback in one turn while leaving source material unchanged.",
    lastRunIncomplete: "The last Knowledge run did not finish. Check the current Provider and guide, then retry from the Knowledge panel.",
    statusHeading: "Run status",
    recentStatus: (status, time) => `Latest: ${status}${time ? ` · ${time}` : ""}`,
    recentCompletion: (completion, attempts, pending) => [
      `Result: ${completion}`,
      attempts > 1 ? `${attempts} Agent attempts` : "",
      pending ? `${pending} deferred` : ""
    ].filter(Boolean).join(" · "),
    completionLabels: {
      full: "Complete",
      partial: "Partially complete",
      recovered: "Recovered",
      noop: "Checked (no new sources)"
    },
    initialization: (status, path) => `Initialization: ${status}${path ? ` · ${path}` : ""}`,
    recentReport: (path) => `Latest report: ${path}`,
    openChannel: "Open current Conversation",
    initChannel: "Initialize Knowledge",
    commandHeading: "Shortcuts",
    commandGuide: [
      { command: "/ask ...", description: "Ask the knowledge base" },
      { command: "/maintain ...", description: "Refine, write safely, and verify readback in one turn" }
    ],
    enabled: "Enable Knowledge",
    backend: "Knowledge model",
    backendDesc: "Inherits the active Provider and model. Change it from API Provider.",
    followGlobal: (backend) => `Follow global (${backend})`,
    detection: (value) => `Detection: ${value}`,
    modelCapabilities: (text, image, pdf) => `Model capabilities: Text ${text ? "✓" : "×"} · Images ${image ? "✓" : "×"} · PDF ${pdf ? "✓" : "×"}`,
    testConnection: "Test connection",
    channelNote: "Use /ask or /maintain in the current Pi Conversation. Settings manages initialization, maintenance preferences, and run status.",
    memoryHeading: "EchoInk file-based Memory",
    memoryNote1: "Markdown is the content source of truth for this Vault's long-term Memory, with fixed paths for identity, user profile, and history.",
    memoryNote2: "AGENT.md, USER.md, and MEMORY.md are reloaded for each request; history is accessed progressively through controlled Memory Tools.",
    memoryEnabled: "Enable long-term memory",
    memoryEnabledDesc: "Chat and /ask retrieve curated memory and receive a lookup entry for local records that remain within retention. Maintenance workflows record results only after the local commit succeeds.",
    memoryStatusLine: (initialized, revision, pending, confirmations, issues) => `Status: ${initialized ? "initialized" : "not initialized"} · revision ${revision} · pending ${pending} · confirmations ${confirmations} · issues ${issues}`,
    memoryLastSync: (outcome, time) => `Latest sync: ${outcome}${time ? ` · ${time}` : ""}`,
    memoryStatusFailed: (_error) => "Memory status is temporarily unavailable. Reload it, or use Recover transactions if it does not return.",
    memoryReload: "Reload status",
    memoryInitialize: "Initialize",
    memorySync: "Sync now",
    memoryRecover: "Recover transactions",
    memoryConfirmations: "Confirmations and conflicts",
    memoryConflicts: (ids) => `Conflicts: ${ids}`,
    memoryAccept: "Accept",
    memoryDismiss: "Dismiss",
    memoryIssues: "Unresolved transactions",
    memoryRetry: "Retry sync",
    memoryDrop: "Drop pending",
    memoryItems: "Recorded memories",
    memoryDeleteConfirm: (statement) => `Delete this EchoInk long-term memory?\n\n${statement}`,
    memoryActionFailed: (_error) => "The Memory action did not finish. Reload the status, then try again.",
    statusLabels: {
      idle: "Not run",
      running: "Running",
      success: "Success",
      failed: "Failed",
      canceled: "Canceled"
    },
    initStatusLabels: {
      "not-started": "Not initialized",
      "preview-ready": "Preview ready",
      initialized: "Initialized",
      failed: "Failed"
    }
  },
  review: {
    title: "Review",
    generateHeading: "Generate weekly review",
    generateAgent: "Generate Agent review",
    generateKnowledge: "Generate Knowledge review",
    pathsHeading: "Output paths",
    outputDir: "Output directory",
    knowledgeMarkdown: "Knowledge Markdown",
    knowledgeHtml: "Knowledge HTML",
    agentMarkdown: "Agent Markdown",
    agentHtml: "Agent HTML",
    settingsHeading: "Review settings",
    confirmTitle: (label) => label,
    confirmBody: (report, outputDir) => `Generate ${report}?\n\nOutput directory: ${outputDir}`,
    generate: "Generate",
    cancel: "Cancel",
    reportLabels: {
      "knowledge-base": "Knowledge review",
      "agent-chat": "Agent review"
    },
    rangeMode: "Date range",
    rangeOptions: {
      "previous-week": "Previous full week",

      "current-week": "Current week to date"
    },
    openHtmlAfterRun: "Open HTML after run"
  },
  providers: {
    title: "API Provider",
    simpleSetup: "Choose a provider, confirm the API URL, enter an API key, and save. The key is stored directly in this Vault's EchoInk plugin settings.",
    provider: "Provider",
    protocol: "API protocol",
    protocolOptions: {
      "openai-responses": "OpenAI Responses",
      "openai-completions": "OpenAI compatible (Chat Completions)",
      "anthropic-messages": "Anthropic Messages"
    },
    modelPreset: (model) => `Default model: ${model}`,
    modelId: "Model ID",
    modelPlaceholder: "Get or add a model",
    addCustomModel: "Add custom Model ID",
    customModelPrompt: "Enter a Model ID, for example provider/model",
    invalidModel: "Enter a valid Model ID without spaces",
    fetchModels: "Get models",
    refreshModels: "Refresh models",
    modelListIdle: "Model list not loaded",
    modelListLoading: "Loading models…",
    modelListAvailable: (count) => `${count} models loaded; choose one from the list`,
    modelListUnsupported: "This service does not expose a readable model list. Use + to add a Model ID.",
    modelListApiKeyError: "The API key is invalid or cannot list models. Check it and retry.",
    modelListRateOrServiceError: "The provider is rate-limited or temporarily unavailable. Try again later; saved models are unchanged.",
    modelListNetworkError: "Could not reach the provider. Check the network and endpoint URL, then retry.",
    modelListResponseFormatError: "The provider returned an unrecognized model-list format. Enter an exact Model ID manually.",
    modelListFailed: "Could not load models this time. The saved model is preserved, and you can enter a Model ID in the dropdown.",
    keyPlaceholder: "Enter API key",
    savedKeyPlaceholder: "API key saved; leave blank to keep using it",
    showKey: "Show current input",
    hideKey: "Hide current input",
    testConnection: "Test connection",
    testingConnection: "Testing…",
    connectionIdle: "Connection not tested. A test may incur a very small API charge.",
    connectionAvailable: "Connection available",
    connectionFailures: {
      auth: "The API key is invalid or lacks permission",
      protocol: "The Base URL may not match the selected protocol",
      model: "The current Model ID is unavailable",
      rate_limit: "Connected, but the account is rate-limited or out of quota",
      network: "Could not connect to the service",
      provider: "The provider is temporarily unavailable"
    },
    saveAndUse: "Save and use",
    saving: "Saving…",
    missingKey: "Enter an API key.",
    saved: (provider) => `${provider} is ready for chat.`,
    saveFailed: "The provider was not saved or activated. Check the endpoint, API key, protocol, and network, then retry.",
    warningKey: "API key input is masked and stored directly in this Vault's EchoInk plugin settings.",
    warningApi: "The API URL must support the selected API protocol.",
    add: "Add",
    addTitle: "Add API Provider",
    defaultName: "Custom API",
    empty: "No custom API providers yet.",
    unnamed: "Unnamed provider",
    active: "Enabled",
    enableReconnect: "Enable and reconnect",
    deleteConfirm: (name) => `Delete ${name || "this provider"}?`,
    name: "Name",
    namePlaceholder: "Example: OpenAI API",
    baseUrl: "Base URL",
    apiKey: "API key",
    queryParams: "Query Params",
    responseApiRequirement: "Required: the server must support OpenAI Chat Completions.",
    models: "Models"
  },
  resources: {
    title: "Skills & MCP",
    note: "Use the list switches to control which plugins, MCP servers, and Skills are available to EchoInk.",
    tabs: {
      plugins: "Plugins",
      mcp: "MCP",
      skills: "Skills"
    },
    refreshTitle: "Refresh current list",
    loadingTab: (label) => `Syncing ${label}…`,
    notLoaded: "Resources have not been synced. Refresh to try again.",
    searchPlaceholder: (label) => `Search ${label}`,
    searchAria: "Search current capability list",
    clearSearch: "Clear search",
    installed: "Installed",
    notInstalled: "Not installed",
    noPlugins: "No plugins loaded.",
    noPluginMatches: "No matching plugins.",
    toolsCount: (count) => `${count} tools`,
    mcpDesc: "Imported into the EchoInk resource catalog",
    noMcp: "No MCP servers loaded.",
    noMcpMatches: "No matching MCP servers.",
    noDesc: "No description",
    noSkills: "No Skills loaded.",
    noSkillMatches: "No matching Skills.",
    preset: "Preset",
    summary: (label, enabled, total, visible, searching) => searching ? `${label}: ${enabled} / ${total} enabled · Showing ${visible}` : `${label}: ${enabled} / ${total} enabled`,
    toggleAria: (name) => `${name} toggle`,
    codexDisconnected: "Resources disconnected"
  },
};

export const SETTINGS_COPY = {
  "zh-CN": ZH_CN,
  en: EN
} satisfies Record<SettingsLanguage, SettingsCopy>;

export const SETTINGS_LANGUAGE_OPTIONS: SettingsLanguage[] = ["zh-CN", "en"];

export function settingsCopy(language: SettingsLanguage): SettingsCopy {
  return SETTINGS_COPY[language] ?? SETTINGS_COPY["zh-CN"];
}

export type ConversationSectionKind = "process" | "reasoning" | "tools" | "answer";
export type ConversationActionKind =
  | "read"
  | "search"
  | "command"
  | "edit"
  | "tool"
  | "agent"
  | "plan"
  | "verify"
  | "system";
export type ConversationToolAction =
  | "search"
  | "read"
  | "create"
  | "edit"
  | "move"
  | "delete"
  | "command"
  | "call";
export type ConversationActionStatus =
  | "running"
  | "waiting_approval"
  | "approved"
  | "verifying"
  | "completed"
  | "failed"
  | "denied"
  | "uncertain"
  | "blocked"
  | "canceled"
  | "unconfirmed"
  | "interrupted"
  | "recovery-pending"
  | "recovery-blocked";

export interface ConversationCopy {
  readonly sections: Readonly<Record<ConversationSectionKind, string>>;
  readonly turn: Readonly<{
    processed: (duration: string) => string;
    waitingForUser: string;
    processing: (current?: string) => string;
    terminalPrefix: (status: string) => string;
    stepCount: (count: number) => string;
    toolCount: (count: number) => string;
  }>;
  readonly process: Readonly<{
    reasoningTitle: string;
    providerReasoningRunning: string;
    providerReasoningEnded: string;
    providerReasoningDuration: (duration: string) => string;
    questionAnswered: string;
    interactionOutcome: (outcome: string) => string;
    sourcesTitle: string;
    verifiableSources: (count: number) => string;
    noDisplayableSources: string;
    artifactsTitle: string;
    fileCount: (count: number) => string;
    artifactCount: (count: number) => string;
    fallbackTitle: (kind: string) => string;
    activityTitle: (kind: string, name?: string) => string;
    activityCompleted: (count: number) => string;
    activityStage: (stage: string) => string;
    publicReasoningRunning: string;
    publicReasoningCompleted: string;
    publicReasoningDuration: (duration: string) => string;
    receivingPublicReasoning: string;
    taskAria: (title: string, completed: number, total: number) => string;
    taskProgress: (completed: number, total: number) => string;
    nodeStatus: (status: string) => string;
  }>;
  readonly action: Readonly<{
    commandFallback: string;
    completedTitle: (kind: ConversationActionKind, target: string) => string;
    agentFailed: string;
    agentFallback: string;
    fallbackTitle: (kind: ConversationActionKind) => string;
    summary: (count: number, status: ConversationActionStatus) => string;
    active: (kind: ConversationActionKind, status: ConversationActionStatus, target: string) => string;
    recoveryPending: string;
    recoveryBlocked: string;
    statusUnconfirmed: string;
    processInterrupted: string;
    processCancelled: string;
    countLabel: (kind: ConversationActionKind, count: number) => string;
    groupTitle: (
      kind: ConversationActionKind,
      status: ConversationActionStatus,
      count: number,
      fileCount: number,
      hasFailure: boolean
    ) => string;
    detailLabel: (kind: ConversationActionKind, failed: boolean) => string;
    verb: (
      kind: ConversationActionKind,
      status: ConversationActionStatus,
      confirmationExpired: boolean
    ) => string;
    toolVerb: (
      action: ConversationToolAction,
      status: ConversationActionStatus,
      confirmationExpired: boolean
    ) => string;
    moreFiles: (count: number) => string;
    itemTypeTitle: (itemType?: string) => string;
    statusLabel: (status: string) => string;
  }>;
  readonly sources: Readonly<{
    usedDocuments: (count: number) => string;
    noEvidence: string;
    personalMemoryCount: (count: number) => string;
    noPersonalMemory: string;
    noVaultPath: string;
    openNote: (label: string) => string;
    openInObsidian: (path: string) => string;
    missingInVault: (path: string) => string;
    lineRange: (start: number, end: number) => string;
    bucketLabel: (bucket: string) => string;
    evidenceStatus: (status: string) => string;
  }>;
  readonly details: Readonly<{
    input: string;
    output: string;
    contentUnavailable: string;
    waitingForToolOutput: string;
    receivingContent: string;
    noContent: string;
    emptyContent: string;
    fileChanges: string;
    loadingFileChanges: string;
    fileChangesLoadFailed: (error: string) => string;
    loadingCommandOutput: string;
    commandOutputLoadFailed: (error: string) => string;
    changedFiles: (count: number) => string;
    previousPath: (path: string) => string;
    diffKind: (kind: string) => string;
    noDiff: string;
    editedPrefix: string;
    cannotOpenPath: (path: string) => string;
    open: (label: string) => string;
    loadingFullText: string;
    fullTextLoadFailed: (error: string) => string;
    rawOutput: string;
    lineCount: (count: number) => string;
    fullTextPreserved: string;
    target: string;
    preview: string;
    openFullNote: string;
    query: string;
    scope: string;
    searchMatches: (count: number) => string;
    sourcePath: string;
    destinationPath: string;
    deletedRecoverably: string;
    deleted: string;
    result: string;
    errorReason: string;
    parameters: string;
    terminal: string;
  }>;
  readonly approval: Readonly<{
    stateLabel: (state: string) => string;
    target: string;
    preview: string;
    reject: string;
    approve: string;
  }>;
  readonly task: Readonly<{
    planLabel: (title: string) => string;
    statusLabel: (status: string) => string;
    historyStatus: (status: string, completed: number, total: number) => string;
  }>;
  readonly message: Readonly<{
    preparingReply: string;
    generatingReply: string;
    generatingReplyCopies: (personalityTemplateId?: string | null) => readonly string[];
    organizingContext: string;
    thinkingLiveCopies: readonly string[];
    thinking: string;
    thinkingProcess: string;
    thinkingComplete: string;
    deriveConversation: string;
    copyMessage: string;
    copyAnswer: string;
    messageCopied: string;
    answerCopied: string;
    copyMessageFailed: string;
    copyAnswerFailed: string;
    copied: string;
    copyFailed: string;
    suggestionsAria: string;
    suggestions: readonly Readonly<{ id: string; label: string }>[];
  }>;
}

const ZH_ACTION_COUNT_LABELS: Record<ConversationActionKind, string> = {
  read: "读取",
  search: "搜索",
  command: "命令",
  edit: "编辑",
  tool: "调用",
  agent: "智能体",
  plan: "计划",
  verify: "验证",
  system: "系统"
};

const EN_ACTION_COUNT_LABELS: Record<ConversationActionKind, string> = {
  read: "Reads",
  search: "Searches",
  command: "Commands",
  edit: "Edits",
  tool: "Calls",
  agent: "Agents",
  plan: "Plans",
  verify: "Checks",
  system: "System"
};

const ZH_ACTION_BASE_LABELS: Record<ConversationActionKind, string> = {
  read: "读取",
  search: "搜索",
  command: "运行",
  edit: "编辑",
  tool: "工具调用",
  agent: "智能体动作",
  plan: "计划更新",
  verify: "验证",
  system: "系统动作"
};

const EN_ACTION_BASE_LABELS: Record<ConversationActionKind, string> = {
  read: "Read",
  search: "Search",
  command: "Command",
  edit: "Edit",
  tool: "Tool call",
  agent: "Agent action",
  plan: "Plan update",
  verify: "Verification",
  system: "System action"
};

const ZH_TOOL_ACTION_LABELS: Readonly<Record<
ConversationToolAction,
Readonly<{ base: string; running: string; completed: string }>
>> = Object.freeze({
  search: { base: "搜索", running: "正在搜索", completed: "已搜索" },
  read: { base: "读取", running: "正在读取", completed: "已读取" },
  create: { base: "创建", running: "正在创建", completed: "已创建" },
  edit: { base: "编辑", running: "正在编辑", completed: "已编辑" },
  move: { base: "移动", running: "正在移动", completed: "已移动" },
  delete: { base: "删除", running: "正在删除", completed: "已删除" },
  command: { base: "运行", running: "正在运行", completed: "已运行" },
  call: { base: "调用", running: "正在调用", completed: "已调用" }
});

const EN_TOOL_ACTION_LABELS: Readonly<Record<
ConversationToolAction,
Readonly<{ base: string; running: string; completed: string }>
>> = Object.freeze({
  search: { base: "Search", running: "Searching", completed: "Searched" },
  read: { base: "Read", running: "Reading", completed: "Read" },
  create: { base: "Create", running: "Creating", completed: "Created" },
  edit: { base: "Edit", running: "Editing", completed: "Edited" },
  move: { base: "Move", running: "Moving", completed: "Moved" },
  delete: { base: "Delete", running: "Deleting", completed: "Deleted" },
  command: { base: "Run", running: "Running", completed: "Ran" },
  call: { base: "Call", running: "Calling", completed: "Called" }
});

function zhToolActionVerb(
  action: ConversationToolAction,
  status: ConversationActionStatus,
  confirmationExpired: boolean
): string {
  const labels = ZH_TOOL_ACTION_LABELS[action];
  if (confirmationExpired) return `${labels.base}确认已过期`;
  const statusLabels: Partial<Record<ConversationActionStatus, string>> = {
    unconfirmed: "状态未回传",
    interrupted: "已中断",
    canceled: "已取消",
    waiting_approval: "等待确认",
    approved: "已批准",
    verifying: "验证中",
    denied: "已拒绝",
    uncertain: "结果不确定",
    "recovery-pending": "等待恢复",
    "recovery-blocked": "恢复受阻",
    failed: "失败"
  };
  const suffix = statusLabels[status];
  if (suffix) return `${labels.base}${suffix}`;
  if (status === "running" || status === "blocked") return labels.running;
  return labels.completed;
}

function enToolActionVerb(
  action: ConversationToolAction,
  status: ConversationActionStatus,
  confirmationExpired: boolean
): string {
  const labels = EN_TOOL_ACTION_LABELS[action];
  if (confirmationExpired) return `${labels.base} confirmation expired`;
  const statusLabels: Partial<Record<ConversationActionStatus, string>> = {
    unconfirmed: "status not reported",
    interrupted: "interrupted",
    canceled: "cancelled",
    waiting_approval: "awaiting confirmation",
    approved: "approved",
    verifying: "verifying",
    denied: "denied",
    uncertain: "result uncertain",
    "recovery-pending": "awaiting recovery",
    "recovery-blocked": "recovery blocked",
    failed: "failed"
  };
  const suffix = statusLabels[status];
  if (suffix) return `${labels.base} ${suffix}`;
  if (status === "running" || status === "blocked") return labels.running;
  return labels.completed;
}

const ZH_GENERATING_REPLY_COPIES: Readonly<Record<string, readonly string[]>> = {
  executor: ["正在直奔问题核心", "正在快速收拢结论", "正在风风火火推进", "正在整理行动要点"],
  advisor: ["正在核对关键前提", "正在逐项梳理依据", "正在检查逻辑细节", "正在推敲稳妥结论"],
  butler: ["正在按序整理回复", "正在仔细核对细节", "正在沉稳组织答案", "正在为你梳理要点"],
  companion: ["正在顺着你的问题想", "正在和你一起梳理", "正在细心理清思路", "正在把答案理得更顺"],
  steward: ["正在统筹回复结构", "正在把复杂问题理清", "正在核对有没有遗漏", "正在将要点一一归位"],
  enthusiast: ["正在让思路跑起来", "正在带着劲头推进", "正在试试不同办法", "正在把想法串起来"],
  creative: ["正在展开更多可能", "正在换几个角度想", "正在把灵感串起来", "正在收拢创意回答"],
  pragmatist: ["正在筛选可行方案", "正在去掉多余废话", "正在把话说清楚", "正在核对落地细节"]
};

const ZH_GENERATING_REPLY_FALLBACK = [
  "正在理解你的问题",
  "正在整理关键信息",
  "正在组织回复",
  "正在检查答案"
] as const;

const EN_GENERATING_REPLY_COPIES: Readonly<Record<string, readonly string[]>> = {
  executor: ["Going straight to the point", "Closing in on the answer", "Moving fast on this", "Lining up the next steps"],
  advisor: ["Checking the key assumptions", "Reviewing the evidence", "Testing the logic", "Shaping a careful answer"],
  butler: ["Arranging the reply in order", "Checking the finer details", "Composing a measured answer", "Organizing the key points"],
  companion: ["Thinking this through with you", "Following your train of thought", "Gently untangling the idea", "Smoothing out the answer"],
  steward: ["Organizing the reply", "Untangling the complexity", "Checking for anything missed", "Putting each point in place"],
  enthusiast: ["Getting the ideas moving", "Building momentum", "Trying a few approaches", "Connecting the dots"],
  creative: ["Opening up more possibilities", "Looking from a few angles", "Connecting the sparks", "Shaping the creative answer"],
  pragmatist: ["Filtering for what works", "Cutting the extra words", "Making the answer clear", "Checking the practical details"]
};

const EN_GENERATING_REPLY_FALLBACK = [
  "Understanding your question",
  "Organizing the key information",
  "Composing the reply",
  "Checking the answer"
] as const;

function generatingReplyCopies(
  copies: Readonly<Record<string, readonly string[]>>,
  fallback: readonly string[],
  personalityTemplateId?: string | null
): readonly string[] {
  const templateId = personalityTemplateId?.trim();
  return templateId ? copies[templateId] ?? fallback : fallback;
}

function formatZhDuration(duration: string): string {
  const units: Readonly<Record<string, string>> = { h: "小时", m: "分", s: "秒" };
  return duration
    .replace(/(\d+)(h|m|s)/gu, (_match, amount: string, unit: string) =>
      `${Number.parseInt(amount, 10)} ${units[unit] ?? unit}`)
    .replace(/\s+/gu, " ")
    .trim();
}

const ZH_CONVERSATION_COPY: ConversationCopy = {
  sections: {
    process: "处理过程",
    reasoning: "模型推理",
    tools: "执行动作",
    answer: "最终回答"
  },
  turn: {
    processed: (duration) => `已处理 ${duration}`,
    waitingForUser: "等待用户回应",
    processing: (current) => current ? `正在处理 · ${current}` : "正在处理",
    terminalPrefix: (status) => status === "completed"
      ? "处理完成"
      : status === "failed"
        ? "处理失败"
        : status === "cancelled"
          ? "已取消"
          : "已中断",
    stepCount: (count) => `${count} 个步骤`,
    toolCount: (count) => `${count} 个工具`
  },
  process: {
    reasoningTitle: "模型推理",
    providerReasoningRunning: "思考中",
    providerReasoningEnded: "思考完成",
    providerReasoningDuration: (duration) => `思考了 ${formatZhDuration(duration)}`,
    questionAnswered: "用户已回答",
    interactionOutcome: (outcome) => outcome === "approved"
      ? "用户已批准"
      : outcome === "denied"
        ? "用户已拒绝"
        : outcome === "completed"
          ? "确认已执行"
          : outcome === "failed"
            ? "交互失败"
            : outcome === "expired"
              ? "交互已过期"
              : "交互已取消",
    sourcesTitle: "检索与来源",
    verifiableSources: (count) => `${count} 个可验证来源`,
    noDisplayableSources: "未命中可展示来源",
    artifactsTitle: "本轮产物",
    fileCount: (count) => `${count} 个文件`,
    artifactCount: (count) => `${count} 个产物`,
    fallbackTitle: (kind) => ({
      task: "更新任务",
      retrieval: "检索资料",
      diff: "文件改动",
      artifact: "生成产物",
      tool: "执行工具",
      interaction: "等待用户操作",
      process: "处理上下文"
    }[kind] ?? "处理上下文"),
    activityTitle: (kind, name) => kind === "knowledge"
      ? "检索本地知识"
      : kind === "memory"
        ? "核对个人记忆"
        : kind === "task"
          ? "推进任务"
          : kind === "tool"
            ? name ? `调用 ${name}` : "调用工具"
            : "连接模型",
    activityCompleted: (count) => `已完成 ${count}`,
    activityStage: (stage) => ({
      requesting: "请求模型",
      searching: "检索中",
      continuing_search: "继续检索",
      reading_knowledge: "阅读知识",
      comparing_memory: "比较记忆",
      checking_conflicts_freshness: "核对冲突与时效",
      refining_knowledge: "整理知识",
      writing_and_readback: "写入并回读",
      loading: "加载中",
      catalog: "读取目录",
      matching: "匹配中",
      budgeting: "分配上下文",
      assembling: "组装上下文",
      pending: "等待开始",
      in_progress: "进行中",
      paused: "已暂停",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消"
    } as Record<string, string>)[stage] ?? stage,
    publicReasoningRunning: "思考中",
    publicReasoningCompleted: "思考完成",
    publicReasoningDuration: (duration) => `思考了 ${formatZhDuration(duration)}`,
    receivingPublicReasoning: "思考中",
    taskAria: (title, completed, total) => `任务 ${title}，${completed}/${total} 已完成`,
    taskProgress: (completed, total) => `${completed}/${total} 已完成`,
    nodeStatus: (status) => ({
      running: "进行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      skipped: "已跳过",
      waiting: "等待中"
    } as Record<string, string>)[status] ?? "等待中"
  },
  action: {
    commandFallback: "命令",
    completedTitle: (kind, target) => ({
      command: `已运行 ${target}`,
      edit: `已编辑 ${target}`,
      read: `已读取 ${target}`
    } as Partial<Record<ConversationActionKind, string>>)[kind] ?? target,
    agentFailed: "创建智能体失败",
    agentFallback: "智能体动作",
    fallbackTitle: (kind) => ({
      read: "已读取文件",
      search: "已搜索",
      command: "已运行命令",
      edit: "已编辑文件",
      tool: "已调用工具",
      agent: "智能体动作",
      plan: "更新计划",
      verify: "运行验证",
      system: "系统动作"
    })[kind],
    summary: (count, status) => status === "running"
      ? `正在处理 ${count} 个动作`
      : status === "waiting_approval" || status === "blocked"
        ? `${count} 个动作等待确认`
        : status === "approved"
          ? `${count} 个动作已批准`
          : status === "verifying"
            ? `${count} 个动作正在验证`
            : status === "recovery-pending"
              ? `${count} 个动作等待恢复`
              : status === "recovery-blocked"
                ? `${count} 个动作恢复受阻`
                : status === "failed"
                  ? `${count} 个动作失败`
                  : status === "denied"
                    ? `${count} 个动作已拒绝`
                    : status === "uncertain"
                      ? `${count} 个动作结果不确定`
                      : status === "unconfirmed"
                        ? `${count} 个动作状态未回传`
                        : status === "interrupted"
                          ? `${count} 个动作已中断`
                          : status === "canceled"
                            ? `${count} 个动作已取消`
                            : count === 1 ? "已处理 1 个动作" : `已处理 ${count} 个动作`,
    active: (kind, status, target) => {
      const suffix = target ? ` ${target}` : "";
      if (status === "failed") {
        if (kind === "command") return `命令失败${suffix}`;
        if (kind === "edit") return `文件改动失败${suffix}`;
        if (kind === "agent") return `智能体动作失败${suffix}`;
        return `动作失败${suffix}`;
      }
      if (status === "waiting_approval" || status === "blocked") return `等待确认${suffix}`;
      if (status === "approved") return `已批准，等待执行${suffix}`;
      if (status === "verifying") return `正在核对结果${suffix}`;
      if (status === "denied") return `已拒绝${suffix}`;
      if (status === "uncertain") return `结果不确定${suffix}`;
      const labels: Record<ConversationActionKind, string> = {
        read: "正在读取",
        search: "正在检索",
        command: "正在运行",
        edit: "正在整理文件改动",
        tool: "正在调用工具",
        agent: "正在等待智能体",
        plan: "正在更新计划",
        verify: "正在验证",
        system: "正在处理"
      };
      return `${labels[kind]}${suffix}`;
    },
    recoveryPending: "等待恢复上次维护过程",
    recoveryBlocked: "上次维护恢复受阻",
    statusUnconfirmed: "工具状态未回传",
    processInterrupted: "过程已中断",
    processCancelled: "过程已取消",
    countLabel: (kind, count) => `${ZH_ACTION_COUNT_LABELS[kind]} ${count}`,
    groupTitle: (kind, status, count, fileCount, hasFailure) => {
      const label = ZH_ACTION_COUNT_LABELS[kind];
      if (status === "unconfirmed") return count === 1 ? `${label}状态未回传` : `${label}状态未回传（${count}）`;
      if (status === "interrupted" || status === "canceled") return count === 1 ? `${label}已中断` : `${label}已中断（${count}）`;
      if (kind === "read") return `已读取 ${fileCount || count} 个文件`;
      if (kind === "search") return `搜索了 ${count} 次`;
      if (kind === "command") return count > 1 ? "运行了多个命令" : "已运行命令";
      if (kind === "edit") return `已编辑 ${fileCount || count} 个文件`;
      if (kind === "tool") return `调用了 ${count} 个工具`;
      if (kind === "agent") return hasFailure ? `创建失败 ${count} 个智能体` : `处理了 ${count} 个智能体动作`;
      if (kind === "plan") return count === 1 ? "更新了计划" : `更新了 ${count} 次计划`;
      if (kind === "verify") return `运行了 ${count} 个验证`;
      return count === 1 ? "系统动作" : `${count} 个系统动作`;
    },
    detailLabel: (kind, failed) => kind === "command"
      ? failed ? "查看错误输出" : "查看 Shell 输出"
      : kind === "edit"
        ? "查看文件改动"
        : kind === "tool" || kind === "agent"
          ? "查看工具详情"
          : "查看详情",
    verb: (kind, status, confirmationExpired) => {
      if (confirmationExpired) return `${ZH_ACTION_BASE_LABELS[kind]}确认已过期`;
      const statusLabels: Partial<Record<ConversationActionStatus, string>> = {
        unconfirmed: "状态未回传",
        interrupted: "已中断",
        canceled: "已取消",
        waiting_approval: "等待确认",
        approved: "已批准",
        verifying: "验证中",
        denied: "已拒绝",
        uncertain: "结果不确定",
        "recovery-pending": "等待恢复",
        "recovery-blocked": "恢复受阻",
        failed: "失败"
      };
      const suffix = statusLabels[status];
      if (suffix) return `${ZH_ACTION_BASE_LABELS[kind]}${suffix}`;
      if (status === "running" || status === "blocked") {
        return ({
          read: "正在读取",
          search: "正在搜索",
          command: "正在运行",
          edit: "正在编辑",
          tool: "正在调用",
          agent: "正在处理",
          plan: "正在更新",
          verify: "正在验证",
          system: "正在处理"
        } as Record<ConversationActionKind, string>)[kind];
      }
      return ({
        read: "已读取",
        search: "已搜索",
        command: "已运行",
        edit: "已编辑",
        tool: "已调用",
        agent: "已处理",
        plan: "已更新",
        verify: "已验证",
        system: "已记录"
      } as Record<ConversationActionKind, string>)[kind];
    },
    toolVerb: zhToolActionVerb,
    moreFiles: (count) => ` 等 ${count} 个文件`,
    itemTypeTitle: (itemType) => ({
      plan: "更新计划",
      commandExecution: "使用命令",
      fileChange: "编辑文件",
      mcpToolCall: "使用工具",
      dynamicToolCall: "使用工具",
      collabAgentToolCall: "使用工具"
    } as Record<string, string>)[itemType ?? ""] ?? "工具",
    statusLabel: (status) => ({
      running: "进行中",
      waiting_approval: "等待确认",
      approved: "已批准",
      verifying: "验证中",
      completed: "完成",
      error: "失败",
      failed: "失败",
      denied: "已拒绝",
      uncertain: "结果不确定",
      canceled: "已取消",
      cancelled: "已取消",
      expired: "确认已过期",
      blocked: "等待确认",
      interrupted: "中断",
      unconfirmed: "状态未回传",
      "recovery-pending": "等待恢复",
      "recovery-blocked": "恢复受阻"
    } as Record<string, string>)[status] ?? status
  },
  sources: {
    usedDocuments: (count) => `使用了 ${count} 个文档`,
    noEvidence: "知识库没有找到可引用依据。",
    personalMemoryCount: (count) => count > 0 ? `${count} 条 Personal Memory` : "Personal Memory 来源",
    noPersonalMemory: "未记录可展示的 Personal Memory 来源。",
    noVaultPath: "Personal Memory 没有 Vault 路径，无法打开",
    openNote: (label) => `打开笔记 ${label}`,
    openInObsidian: (path) => `在 Obsidian 中打开 ${path}`,
    missingInVault: (path) => `当前 Vault 中找不到 ${path}，无法打开`,
    lineRange: (start, end) => `第 ${start}-${end} 行`,
    bucketLabel: (bucket) => ({ wiki: "知识", journal: "日志", outputs: "产物" } as Record<string, string>)[bucket] ?? bucket,
    evidenceStatus: (status) => status === "strong" ? "强证据" : status === "weak" ? "弱相关" : "无本地依据"
  },
  details: {
    input: "输入",
    output: "输出",
    contentUnavailable: "后端未提供可展示内容",
    waitingForToolOutput: "正在等待工具输出",
    receivingContent: "正在接收过程内容...",
    noContent: "暂无内容",
    emptyContent: "后端返回空内容",
    fileChanges: "文件改动",
    loadingFileChanges: "正在加载文件改动",
    fileChangesLoadFailed: (error) => `文件改动加载失败：${error}`,
    loadingCommandOutput: "正在加载命令输出",
    commandOutputLoadFailed: (error) => `命令输出加载失败：${error}`,
    changedFiles: (count) => `${count} 个文件已更改`,
    previousPath: (path) => `原路径 ${path}`,
    diffKind: (kind) => ({ add: "新增", delete: "删除", update: "修改", move: "移动", unknown: "改动" } as Record<string, string>)[kind] ?? "改动",
    noDiff: "没有可展示的 diff 内容",
    editedPrefix: "已编辑 ",
    cannotOpenPath: (path) => `${path}（无法打开）`,
    open: (label) => `打开 ${label}`,
    loadingFullText: "正在加载全文",
    fullTextLoadFailed: (error) => `全文加载失败：${error}`,
    rawOutput: "原始输出",
    lineCount: (count) => `${count} 行`,
    fullTextPreserved: "展开后已保留全文",
    target: "目标",
    preview: "预览",
    openFullNote: "在 Obsidian 中查看全文",
    query: "查询",
    scope: "范围",
    searchMatches: (count) => `${count} 条结果`,
    sourcePath: "原路径",
    destinationPath: "新路径",
    deletedRecoverably: "已移到 Obsidian 回收站，可恢复",
    deleted: "删除已完成",
    result: "结果",
    errorReason: "失败原因",
    parameters: "参数摘要",
    terminal: "终端"
  },
  approval: {
    stateLabel: (state) => state === "waiting_approval"
      ? "等待批准本次执行"
      : state === "approved"
        ? "已批准本次执行"
        : state === "denied"
          ? "已拒绝本次执行"
          : state === "expired"
            ? "审批已过期"
            : "审批已取消",
    target: "目标",
    preview: "预览",
    reject: "拒绝",
    approve: "批准"
  },
  task: {
    planLabel: (title) => `任务计划：${title}`,
    statusLabel: (status) => ({
      pending: "待执行",
      in_progress: "进行中",
      completed: "已完成",
      failed: "失败",
      paused: "已暂停",
      interrupted: "已中断",
      cancelled: "已取消"
    } as Record<string, string>)[status] ?? status,
    historyStatus: (status, completed, total) => status === "completed"
      ? `${total}/${total} 已完成`
      : status === "failed"
        ? "任务失败"
        : status === "cancelled"
          ? "已取消"
          : status === "paused"
            ? "已中断，可继续"
            : status === "pending"
              ? "等待开始"
              : `${completed}/${total} 已完成`
  },
  message: {
    preparingReply: "正在准备回复",
    generatingReply: "正在生成回复",
    generatingReplyCopies: (personalityTemplateId) => generatingReplyCopies(
      ZH_GENERATING_REPLY_COPIES,
      ZH_GENERATING_REPLY_FALLBACK,
      personalityTemplateId
    ),
    organizingContext: "正在整理上下文",
    thinkingLiveCopies: ["先把问题看明白", "等模型接上话", "把上下文放到手边"],
    thinking: "思考中",
    thinkingProcess: "思考过程",
    thinkingComplete: "思考完成",
    deriveConversation: "从这条回复新建会话",
    copyMessage: "复制消息",
    copyAnswer: "复制回答",
    messageCopied: "消息已复制",
    answerCopied: "回答已复制",
    copyMessageFailed: "消息复制失败",
    copyAnswerFailed: "回答复制失败",
    copied: "已复制",
    copyFailed: "复制失败",
    suggestionsAria: "推荐问题",
    suggestions: [
      { id: "organize-knowledge-base", label: "整理知识库" },
      { id: "summarize-current-note", label: "总结当前笔记" },
      { id: "search-knowledge-base", label: "从知识库找答案" }
    ]
  }
};

const EN_CONVERSATION_COPY: ConversationCopy = {
  sections: {
    process: "Process",
    reasoning: "Reasoning",
    tools: "Tools & Sources",
    answer: "Final Answer"
  },
  turn: {
    processed: (duration) => `Processed in ${duration}`,
    waitingForUser: "Waiting for your response",
    processing: (current) => current ? `Processing · ${current}` : "Processing",
    terminalPrefix: (status) => status === "completed"
      ? "Completed"
      : status === "failed"
        ? "Failed"
        : status === "cancelled"
          ? "Cancelled"
          : "Interrupted",
    stepCount: (count) => `${count} ${count === 1 ? "step" : "steps"}`,
    toolCount: (count) => `${count} ${count === 1 ? "tool" : "tools"}`
  },
  process: {
    reasoningTitle: "Reasoning",
    providerReasoningRunning: "Thinking",
    providerReasoningEnded: "Thinking complete",
    providerReasoningDuration: (duration) => `Thought for ${duration}`,
    questionAnswered: "User answered",
    interactionOutcome: (outcome) => outcome === "approved"
      ? "User approved"
      : outcome === "denied"
        ? "User denied"
        : outcome === "completed"
          ? "Confirmation completed"
          : outcome === "failed"
            ? "Interaction failed"
            : outcome === "expired"
              ? "Interaction expired"
              : "Interaction cancelled",
    sourcesTitle: "Search and sources",
    verifiableSources: (count) => `${count} verifiable ${count === 1 ? "source" : "sources"}`,
    noDisplayableSources: "No displayable sources",
    artifactsTitle: "Turn artifacts",
    fileCount: (count) => `${count} ${count === 1 ? "file" : "files"}`,
    artifactCount: (count) => `${count} ${count === 1 ? "artifact" : "artifacts"}`,
    fallbackTitle: (kind) => ({
      task: "Update task",
      retrieval: "Search sources",
      diff: "File changes",
      artifact: "Create artifacts",
      tool: "Run tool",
      interaction: "Wait for user action",
      process: "Process context"
    }[kind] ?? "Process context"),
    activityTitle: (kind, name) => kind === "knowledge"
      ? "Search local knowledge"
      : kind === "memory"
        ? "Check personal memory"
        : kind === "task"
          ? "Advance task"
          : kind === "tool"
            ? name ? `Call ${name}` : "Call tool"
            : "Connect to model",
    activityCompleted: (count) => `${count} completed`,
    activityStage: (stage) => ({
      requesting: "Requesting model",
      searching: "Searching",
      continuing_search: "Continuing search",
      reading_knowledge: "Reading knowledge",
      comparing_memory: "Comparing memory",
      checking_conflicts_freshness: "Checking conflicts and freshness",
      refining_knowledge: "Refining knowledge",
      writing_and_readback: "Writing and verifying readback",
      loading: "Loading",
      catalog: "Reading catalog",
      matching: "Matching",
      budgeting: "Allocating context",
      assembling: "Assembling context",
      pending: "Waiting to start",
      in_progress: "In progress",
      paused: "Paused",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled"
    } as Record<string, string>)[stage] ?? stage,
    publicReasoningRunning: "Thinking",
    publicReasoningCompleted: "Thinking complete",
    publicReasoningDuration: (duration) => `Thought for ${duration}`,
    receivingPublicReasoning: "Thinking",
    taskAria: (title, completed, total) => `Task ${title}, ${completed} of ${total} completed`,
    taskProgress: (completed, total) => `${completed}/${total} completed`,
    nodeStatus: (status) => ({
      running: "In progress",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      skipped: "Skipped",
      waiting: "Waiting"
    } as Record<string, string>)[status] ?? "Waiting"
  },
  action: {
    commandFallback: "Command",
    completedTitle: (kind, target) => ({
      command: `Ran ${target}`,
      edit: `Edited ${target}`,
      read: `Read ${target}`
    } as Partial<Record<ConversationActionKind, string>>)[kind] ?? target,
    agentFailed: "Failed to create agent",
    agentFallback: "Agent action",
    fallbackTitle: (kind) => ({
      read: "Read files",
      search: "Searched",
      command: "Ran command",
      edit: "Edited files",
      tool: "Called tool",
      agent: "Agent action",
      plan: "Updated plan",
      verify: "Ran verification",
      system: "System action"
    })[kind],
    summary: (count, status) => {
      const actions = `${count} ${count === 1 ? "action" : "actions"}`;
      if (status === "running") return `Processing ${actions}`;
      if (status === "waiting_approval" || status === "blocked") return `${actions} awaiting confirmation`;
      if (status === "approved") return `${actions} approved`;
      if (status === "verifying") return `Verifying ${actions}`;
      if (status === "recovery-pending") return `${actions} awaiting recovery`;
      if (status === "recovery-blocked") return `${actions} recovery blocked`;
      if (status === "failed") return `${actions} failed`;
      if (status === "denied") return `${actions} denied`;
      if (status === "uncertain") return `${actions} uncertain`;
      if (status === "unconfirmed") return `${actions} status not reported`;
      if (status === "interrupted") return `${actions} interrupted`;
      if (status === "canceled") return `${actions} cancelled`;
      return `${actions} completed`;
    },
    active: (kind, status, target) => {
      const suffix = target ? ` ${target}` : "";
      if (status === "failed") {
        if (kind === "command") return `Command failed${suffix}`;
        if (kind === "edit") return `File change failed${suffix}`;
        if (kind === "agent") return `Agent action failed${suffix}`;
        return `Action failed${suffix}`;
      }
      if (status === "waiting_approval" || status === "blocked") return `Awaiting confirmation${suffix}`;
      if (status === "approved") return `Approved, awaiting execution${suffix}`;
      if (status === "verifying") return `Verifying result${suffix}`;
      if (status === "denied") return `Denied${suffix}`;
      if (status === "uncertain") return `Result uncertain${suffix}`;
      const labels: Record<ConversationActionKind, string> = {
        read: "Reading",
        search: "Searching",
        command: "Running",
        edit: "Preparing file changes",
        tool: "Calling tool",
        agent: "Waiting for agent",
        plan: "Updating plan",
        verify: "Verifying",
        system: "Processing"
      };
      return `${labels[kind]}${suffix}`;
    },
    recoveryPending: "Waiting to recover the previous process",
    recoveryBlocked: "Previous process recovery blocked",
    statusUnconfirmed: "Tool status not reported",
    processInterrupted: "Process interrupted",
    processCancelled: "Process cancelled",
    countLabel: (kind, count) => `${EN_ACTION_COUNT_LABELS[kind]} ${count}`,
    groupTitle: (kind, status, count, fileCount, hasFailure) => {
      const label = EN_ACTION_COUNT_LABELS[kind];
      if (status === "unconfirmed") return count === 1 ? `${label} status not reported` : `${label} status not reported (${count})`;
      if (status === "interrupted" || status === "canceled") return count === 1 ? `${label} interrupted` : `${label} interrupted (${count})`;
      if (kind === "read") {
        const files = fileCount || count;
        return `Read ${files} ${files === 1 ? "file" : "files"}`;
      }
      if (kind === "search") return `Searched ${count} ${count === 1 ? "time" : "times"}`;
      if (kind === "command") return count > 1 ? "Ran multiple commands" : "Ran command";
      if (kind === "edit") {
        const files = fileCount || count;
        return `Edited ${files} ${files === 1 ? "file" : "files"}`;
      }
      if (kind === "tool") return `Called ${count} ${count === 1 ? "tool" : "tools"}`;
      if (kind === "agent") return hasFailure
        ? `Failed to create ${count} ${count === 1 ? "agent" : "agents"}`
        : `Processed ${count} agent ${count === 1 ? "action" : "actions"}`;
      if (kind === "plan") return count === 1 ? "Updated plan" : `Updated plan ${count} times`;
      if (kind === "verify") return `Ran ${count} ${count === 1 ? "check" : "checks"}`;
      return count === 1 ? "System action" : `${count} system actions`;
    },
    detailLabel: (kind, failed) => kind === "command"
      ? failed ? "View error output" : "View Shell output"
      : kind === "edit"
        ? "View file changes"
        : kind === "tool" || kind === "agent"
          ? "View tool details"
          : "View details",
    verb: (kind, status, confirmationExpired) => {
      if (confirmationExpired) return `${EN_ACTION_BASE_LABELS[kind]} confirmation expired`;
      const statusLabels: Partial<Record<ConversationActionStatus, string>> = {
        unconfirmed: "status not reported",
        interrupted: "interrupted",
        canceled: "cancelled",
        waiting_approval: "awaiting confirmation",
        approved: "approved",
        verifying: "verifying",
        denied: "denied",
        uncertain: "result uncertain",
        "recovery-pending": "awaiting recovery",
        "recovery-blocked": "recovery blocked",
        failed: "failed"
      };
      const suffix = statusLabels[status];
      if (suffix) return `${EN_ACTION_BASE_LABELS[kind]} ${suffix}`;
      if (status === "running" || status === "blocked") {
        return ({
          read: "Reading",
          search: "Searching",
          command: "Running",
          edit: "Editing",
          tool: "Calling",
          agent: "Processing",
          plan: "Updating",
          verify: "Verifying",
          system: "Processing"
        } as Record<ConversationActionKind, string>)[kind];
      }
      return ({
        read: "Read",
        search: "Searched",
        command: "Ran",
        edit: "Edited",
        tool: "Called",
        agent: "Processed",
        plan: "Updated",
        verify: "Verified",
        system: "Recorded"
      } as Record<ConversationActionKind, string>)[kind];
    },
    toolVerb: enToolActionVerb,
    moreFiles: (count) => ` and ${count - 1} more ${count === 2 ? "file" : "files"}`,
    itemTypeTitle: (itemType) => ({
      plan: "Update plan",
      commandExecution: "Run command",
      fileChange: "Edit files",
      mcpToolCall: "Use tool",
      dynamicToolCall: "Use tool",
      collabAgentToolCall: "Use tool"
    } as Record<string, string>)[itemType ?? ""] ?? "Tool",
    statusLabel: (status) => ({
      running: "In progress",
      waiting_approval: "Awaiting confirmation",
      approved: "Approved",
      verifying: "Verifying",
      completed: "Completed",
      error: "Failed",
      failed: "Failed",
      denied: "Denied",
      uncertain: "Result uncertain",
      canceled: "Cancelled",
      cancelled: "Cancelled",
      expired: "Confirmation expired",
      blocked: "Awaiting confirmation",
      interrupted: "Interrupted",
      unconfirmed: "Status not reported",
      "recovery-pending": "Awaiting recovery",
      "recovery-blocked": "Recovery blocked"
    } as Record<string, string>)[status] ?? status
  },
  sources: {
    usedDocuments: (count) => `Used ${count} ${count === 1 ? "document" : "documents"}`,
    noEvidence: "No citable evidence was found in the knowledge base.",
    personalMemoryCount: (count) => count > 0 ? `${count} Personal Memory ${count === 1 ? "source" : "sources"}` : "Personal Memory sources",
    noPersonalMemory: "No displayable Personal Memory sources were recorded.",
    noVaultPath: "Personal Memory has no Vault path and cannot be opened",
    openNote: (label) => `Open note ${label}`,
    openInObsidian: (path) => `Open ${path} in Obsidian`,
    missingInVault: (path) => `${path} was not found in the current Vault and cannot be opened`,
    lineRange: (start, end) => `Lines ${start}-${end}`,
    bucketLabel: (bucket) => ({ wiki: "Knowledge", journal: "Journal", outputs: "Outputs" } as Record<string, string>)[bucket] ?? bucket,
    evidenceStatus: (status) => status === "strong" ? "Strong evidence" : status === "weak" ? "Weak match" : "No local evidence"
  },
  details: {
    input: "Input",
    output: "Output",
    contentUnavailable: "The backend did not provide displayable content",
    waitingForToolOutput: "Waiting for tool output",
    receivingContent: "Receiving process content...",
    noContent: "No content",
    emptyContent: "The backend returned empty content",
    fileChanges: "File changes",
    loadingFileChanges: "Loading file changes",
    fileChangesLoadFailed: (error) => `Failed to load file changes: ${error}`,
    loadingCommandOutput: "Loading command output",
    commandOutputLoadFailed: (error) => `Failed to load command output: ${error}`,
    changedFiles: (count) => `${count} ${count === 1 ? "file" : "files"} changed`,
    previousPath: (path) => `Previous path ${path}`,
    diffKind: (kind) => ({ add: "Added", delete: "Deleted", update: "Modified", move: "Moved", unknown: "Changed" } as Record<string, string>)[kind] ?? "Changed",
    noDiff: "No displayable diff content",
    editedPrefix: "Edited ",
    cannotOpenPath: (path) => `${path} (cannot open)`,
    open: (label) => `Open ${label}`,
    loadingFullText: "Loading full text",
    fullTextLoadFailed: (error) => `Failed to load full text: ${error}`,
    rawOutput: "Raw output",
    lineCount: (count) => `${count} ${count === 1 ? "line" : "lines"}`,
    fullTextPreserved: "Full text is available when expanded",
    target: "Target",
    preview: "Preview",
    openFullNote: "View full note in Obsidian",
    query: "Query",
    scope: "Scope",
    searchMatches: (count) => `${count} ${count === 1 ? "result" : "results"}`,
    sourcePath: "From",
    destinationPath: "To",
    deletedRecoverably: "Moved to Obsidian trash and can be recovered",
    deleted: "Deletion completed",
    result: "Result",
    errorReason: "Reason",
    parameters: "Parameters",
    terminal: "Terminal"
  },
  approval: {
    stateLabel: (state) => state === "waiting_approval"
      ? "Awaiting approval to run"
      : state === "approved"
        ? "Approved to run"
        : state === "denied"
          ? "Run denied"
          : state === "expired"
            ? "Approval expired"
            : "Approval cancelled",
    target: "Target",
    preview: "Preview",
    reject: "Reject",
    approve: "Approve"
  },
  task: {
    planLabel: (title) => `Task plan: ${title}`,
    statusLabel: (status) => ({
      pending: "Pending",
      in_progress: "In progress",
      completed: "Completed",
      failed: "Failed",
      paused: "Paused",
      interrupted: "Interrupted",
      cancelled: "Cancelled"
    } as Record<string, string>)[status] ?? status,
    historyStatus: (status, completed, total) => status === "completed"
      ? `${total}/${total} completed`
      : status === "failed"
        ? "Task failed"
        : status === "cancelled"
          ? "Cancelled"
          : status === "paused"
            ? "Interrupted, can continue"
            : status === "pending"
              ? "Waiting to start"
              : `${completed}/${total} completed`
  },
  message: {
    preparingReply: "Preparing reply",
    generatingReply: "Generating reply",
    generatingReplyCopies: (personalityTemplateId) => generatingReplyCopies(
      EN_GENERATING_REPLY_COPIES,
      EN_GENERATING_REPLY_FALLBACK,
      personalityTemplateId
    ),
    organizingContext: "Organizing context",
    thinkingLiveCopies: ["Reading the question", "Connecting to the model", "Bringing context together"],
    thinking: "Thinking",
    thinkingProcess: "Thinking process",
    thinkingComplete: "Thinking complete",
    deriveConversation: "Start a new conversation from this reply",
    copyMessage: "Copy message",
    copyAnswer: "Copy answer",
    messageCopied: "Message copied",
    answerCopied: "Answer copied",
    copyMessageFailed: "Failed to copy message",
    copyAnswerFailed: "Failed to copy answer",
    copied: "Copied",
    copyFailed: "Copy failed",
    suggestionsAria: "Suggested questions",
    suggestions: [
      { id: "organize-knowledge-base", label: "Organize knowledge" },
      { id: "summarize-current-note", label: "Summarize current note" },
      { id: "search-knowledge-base", label: "Search knowledge" }
    ]
  }
};

export const CONVERSATION_COPY = {
  "zh-CN": ZH_CONVERSATION_COPY,
  en: EN_CONVERSATION_COPY
} satisfies Record<SettingsLanguage, ConversationCopy>;

export function conversationCopy(language: SettingsLanguage): ConversationCopy {
  return CONVERSATION_COPY[language] ?? CONVERSATION_COPY["zh-CN"];
}
