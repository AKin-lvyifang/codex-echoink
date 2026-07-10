import type { AgentBackendMode, CodexForObsidianSettings, SetupSettings } from "./settings";
import type { CodexStatusSnapshot } from "../types/app-server";

export type SetupCheckStatus = "ok" | "warning" | "blocking";
export type SetupRequirementId = "codex-cli" | "codex-login" | "opencode-cli" | "opencode-server" | "opencode-models" | "opencode-agent" | "hermes-cli" | "hermes-server" | "hermes-model";
export type SetupActionKind = "copy-command" | "open-url";

export interface SetupPlatform {
  os: string;
  codexCommand: string | null;
  openCodeCommand: string | null;
  hermesCommand: string | null;
}

export interface SetupAction {
  kind: SetupActionKind;
  label: string;
  value: string;
}

export interface SetupRequirement {
  id: SetupRequirementId;
  status: SetupCheckStatus;
  title: string;
  message: string;
  actions: SetupAction[];
}

export interface SetupCheckResult {
  status: SetupCheckStatus;
  canStart: boolean;
  blockingCount: number;
  warningCount: number;
  knowledgeBackend: AgentBackendMode;
  requirements: SetupRequirement[];
}

export const CODEX_CLI_INSTALL_COMMAND = "npm i -g @openai/codex";
export const CODEX_CLI_DOCS_URL = "https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started";
export const OPENCODE_DOCS_URL = "https://opencode.ai/docs";
export const HERMES_DOCS_URL = "https://hermes-agent.nousresearch.com/docs/getting-started/installation";
export const HERMES_MODEL_SETUP_COMMAND = "hermes model";

export function buildSetupCheck(
  settings: CodexForObsidianSettings,
  lastStatus: CodexStatusSnapshot | null,
  platform: SetupPlatform
): SetupCheckResult {
  const knowledgeBackend = resolveKnowledgeBackend(settings);
  const requirements: SetupRequirement[] = [];
  const codexInstalled = Boolean(platform.codexCommand);
  const openCodeInstalled = Boolean(platform.openCodeCommand);
  const hermesInstalled = Boolean(platform.hermesCommand);
  const codexConnected = Boolean(lastStatus?.connected);
  const codexLoggedIn = Boolean(lastStatus?.loggedIn);
  const codexRequired = knowledgeBackend === "codex-cli" || settings.agentBackend === "codex-cli";
  const openCodeRequired = knowledgeBackend === "opencode";
  const hermesRequired = knowledgeBackend === "hermes";

  requirements.push({
    id: "codex-cli",
    status: codexInstalled ? "ok" : codexRequired ? "blocking" : "warning",
    title: codexInstalled ? "Codex CLI 已安装" : codexRequired ? "缺少 Codex CLI" : "Codex CLI 未配置",
    message: codexInstalled
      ? `已检测到：${platform.codexCommand}`
      : codexRequired
        ? "当前 Agent 后端需要本机 Codex CLI。安装后先在终端运行 codex 完成登录。"
      : "普通聊天和 Codex CLI 后端需要本机 Codex CLI。安装后先在终端运行 codex 完成登录。",
    actions: codexInstalled ? [] : codexInstallActions()
  });

  requirements.push({
    id: "codex-login",
    status: codexInstalled && codexConnected && codexLoggedIn ? "ok" : codexRequired ? "blocking" : "warning",
    title: codexInstalled && codexConnected && codexLoggedIn ? "Codex 登录态可用" : "Codex 还未连接或未登录",
    message: codexInstalled && codexConnected && codexLoggedIn
      ? lastStatus?.accountLabel || "Codex 已连接"
      : codexInstalled && codexRequired
        ? "安装后需要点击重新检测；如果仍失败，请在终端运行 codex 并完成登录。"
        : codexRequired ? "先安装 Codex CLI，再回来重新检测。" : "当前能力不依赖 Codex 登录态。",
    actions: codexInstalled && (!codexConnected || !codexLoggedIn) ? codexLoginActions() : []
  });

  requirements.push({
    id: "opencode-cli",
    status: openCodeInstalled ? "ok" : openCodeRequired ? "blocking" : "warning",
    title: openCodeInstalled ? "OpenCode 已安装" : openCodeRequired ? "缺少 OpenCode" : "OpenCode 未配置",
    message: openCodeInstalled
      ? `已检测到：${platform.openCodeCommand}`
      : openCodeRequired
        ? "当前知识库后端使用 OpenCode API，需要本机 OpenCode runtime。"
        : "普通聊天可以先用 Codex CLI；只有选择 OpenCode 知识库后端时才需要安装。",
    actions: openCodeInstalled ? [] : openCodeInstallActions(platform.os)
  });

  if (openCodeRequired) {
    const serverReady = openCodeInstalled && settings.opencode.lastConnectedAt > 0 && !settings.opencode.lastError;
    requirements.push({
      id: "opencode-server",
      status: serverReady ? "ok" : "blocking",
      title: serverReady ? "OpenCode server 可用" : "OpenCode server 未验证",
      message: serverReady
        ? `最近连接：${formatSetupTime(settings.opencode.lastConnectedAt)}`
        : settings.opencode.lastError || "点击重新检测后，插件会尝试连接或启动 opencode serve。",
      actions: openCodeInstalled ? [{ kind: "open-url", label: "OpenCode 文档", value: OPENCODE_DOCS_URL }] : []
    });

    const modelReady = serverReady && Boolean(settings.opencode.providerId && settings.opencode.modelId);
    requirements.push({
      id: "opencode-models",
      status: modelReady ? "ok" : "blocking",
      title: modelReady ? "OpenCode 模型已选择" : "OpenCode 模型未读取",
      message: modelReady
        ? `${settings.opencode.providerId}/${settings.opencode.modelId}`
        : "重新检测会读取 OpenCode 模型列表；读取成功后选择可用模型。",
      actions: []
    });

    requirements.push({
      id: "opencode-agent",
      status: serverReady && settings.opencode.agent.trim() ? "ok" : "warning",
      title: serverReady && settings.opencode.agent.trim() ? "OpenCode Agent 已选择" : "OpenCode Agent 未确认",
      message: serverReady && settings.opencode.agent.trim()
        ? settings.opencode.agent
        : "未确认 Agent 时默认使用 build；建议重新检测后从列表选择。",
      actions: []
    });
  }

  requirements.push({
    id: "hermes-cli",
    status: hermesInstalled ? "ok" : hermesRequired ? "blocking" : "warning",
    title: hermesInstalled ? "Hermes CLI 已安装" : hermesRequired ? "缺少 Hermes CLI" : "Hermes 未配置",
    message: hermesInstalled
      ? `已检测到：${platform.hermesCommand}`
      : hermesRequired
        ? "当前知识库后端使用 Hermes，需要本机 Hermes CLI。"
        : "只有选择 Hermes 后端时才需要安装。",
    actions: hermesInstalled ? [] : hermesInstallActions(platform.os)
  });

  if (hermesRequired) {
    const hermes = settings.agents.hermes;
    const serverReady = hermesInstalled && hermes.lastConnectedAt > 0 && !hermes.lastError;
    requirements.push({
      id: "hermes-server",
      status: serverReady ? "ok" : "blocking",
      title: serverReady ? "Hermes 后端已验证" : "Hermes 后端未验证",
      message: serverReady
        ? `最近连接：${formatSetupTime(hermes.lastConnectedAt)}${hermes.version ? ` · ${hermes.version}` : ""}`
        : hermes.lastError || "点击重新检测后，插件会读取 Hermes doctor/model/API 状态。",
      actions: hermesInstalled ? [{ kind: "open-url", label: "Hermes 文档", value: HERMES_DOCS_URL }] : []
    });

    const modelReady = serverReady && hermes.providerConfigured;
    requirements.push({
      id: "hermes-model",
      status: modelReady ? "ok" : "blocking",
      title: modelReady ? "Hermes provider 可用" : "Hermes provider 未验证",
      message: modelReady
        ? [
          [hermes.providerId, hermes.modelId].filter(Boolean).join("/"),
          hermes.lastProviderCheckAt ? `最近验证：${formatSetupTime(hermes.lastProviderCheckAt)}` : ""
        ].filter(Boolean).join(" · ") || "最近已通过真实 prompt 验证"
        : hermes.lastProviderError || "Hermes CLI 已安装，但推理 provider 还未通过真实 prompt 验证。请在终端运行 hermes model 或配置 ~/.hermes/.env。",
      actions: hermesInstalled ? [{ kind: "copy-command", label: "复制 hermes model", value: HERMES_MODEL_SETUP_COMMAND }] : []
    });
  }

  const blockingCount = requirements.filter((item) => item.status === "blocking").length;
  const warningCount = requirements.filter((item) => item.status === "warning").length;
  return {
    status: blockingCount ? "blocking" : warningCount ? "warning" : "ok",
    canStart: blockingCount === 0,
    blockingCount,
    warningCount,
    knowledgeBackend,
    requirements
  };
}

export function completeSetupState(setup: SetupSettings, completedAt: number, version = ""): SetupSettings {
  return {
    ...setup,
    completedAt,
    lastCheckedAt: setup.lastCheckedAt || completedAt,
    dismissedVersion: version
  };
}

function resolveKnowledgeBackend(settings: CodexForObsidianSettings): AgentBackendMode {
  const configured = settings.knowledgeBase.backend;
  return configured === "default" ? settings.agentBackend : configured;
}

function codexInstallActions(): SetupAction[] {
  return [
    { kind: "copy-command", label: "复制安装命令", value: CODEX_CLI_INSTALL_COMMAND },
    { kind: "open-url", label: "打开 Codex 文档", value: CODEX_CLI_DOCS_URL }
  ];
}

function codexLoginActions(): SetupAction[] {
  return [
    { kind: "copy-command", label: "复制登录命令", value: "codex" },
    { kind: "open-url", label: "打开 Codex 文档", value: CODEX_CLI_DOCS_URL }
  ];
}

function openCodeInstallActions(os: string): SetupAction[] {
  if (os === "win32") {
    return [
      { kind: "copy-command", label: "复制 npm 命令", value: "npm install -g opencode-ai" },
      { kind: "open-url", label: "打开 OpenCode 文档", value: OPENCODE_DOCS_URL }
    ];
  }
  if (os === "darwin") {
    return [
      { kind: "copy-command", label: "复制 npm 命令", value: "npm install -g opencode-ai" },
      { kind: "copy-command", label: "复制安装脚本", value: "curl -fsSL https://opencode.ai/install | bash" },
      { kind: "copy-command", label: "复制 Homebrew 命令", value: "brew install anomalyco/tap/opencode" },
      { kind: "open-url", label: "打开 OpenCode 文档", value: OPENCODE_DOCS_URL }
    ];
  }
  return [
    { kind: "copy-command", label: "复制 npm 命令", value: "npm install -g opencode-ai" },
    { kind: "copy-command", label: "复制安装脚本", value: "curl -fsSL https://opencode.ai/install | bash" },
    { kind: "open-url", label: "打开 OpenCode 文档", value: OPENCODE_DOCS_URL }
  ];
}

function hermesInstallActions(os: string): SetupAction[] {
  const command = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser";
  if (os === "win32") {
    return [
      { kind: "open-url", label: "打开 Hermes 文档", value: HERMES_DOCS_URL }
    ];
  }
  return [
    { kind: "copy-command", label: "复制安装脚本", value: command },
    { kind: "open-url", label: "打开 Hermes 文档", value: HERMES_DOCS_URL }
  ];
}

function formatSetupTime(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}
