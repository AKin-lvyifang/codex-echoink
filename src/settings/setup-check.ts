import type { AgentBackendMode, CodexForObsidianSettings, SetupSettings } from "./settings";
import type { CodexStatusSnapshot } from "../types/app-server";

export type SetupCheckStatus = "ok" | "warning" | "blocking";
export type SetupRequirementId = "codex-cli" | "codex-login" | "opencode-cli" | "opencode-server" | "opencode-models" | "opencode-agent";
export type SetupActionKind = "copy-command" | "open-url";

export interface SetupPlatform {
  os: string;
  codexCommand: string | null;
  openCodeCommand: string | null;
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

export function buildSetupCheck(
  settings: CodexForObsidianSettings,
  lastStatus: CodexStatusSnapshot | null,
  platform: SetupPlatform
): SetupCheckResult {
  const knowledgeBackend = resolveKnowledgeBackend(settings);
  const requirements: SetupRequirement[] = [];
  const codexInstalled = Boolean(platform.codexCommand);
  const openCodeInstalled = Boolean(platform.openCodeCommand);
  const codexConnected = Boolean(lastStatus?.connected);
  const codexLoggedIn = Boolean(lastStatus?.loggedIn);
  const openCodeRequired = knowledgeBackend === "opencode";

  requirements.push({
    id: "codex-cli",
    status: codexInstalled ? "ok" : "blocking",
    title: codexInstalled ? "Codex CLI 已安装" : "缺少 Codex CLI",
    message: codexInstalled
      ? `已检测到：${platform.codexCommand}`
      : "普通聊天和 Codex CLI 后端需要本机 Codex CLI。安装后先在终端运行 codex 完成登录。",
    actions: codexInstalled ? [] : codexInstallActions()
  });

  requirements.push({
    id: "codex-login",
    status: codexInstalled && codexConnected && codexLoggedIn ? "ok" : "blocking",
    title: codexInstalled && codexConnected && codexLoggedIn ? "Codex 登录态可用" : "Codex 还未连接或未登录",
    message: codexInstalled && codexConnected && codexLoggedIn
      ? lastStatus?.accountLabel || "Codex 已连接"
      : codexInstalled
        ? "安装后需要点击重新检测；如果仍失败，请在终端运行 codex 并完成登录。"
        : "先安装 Codex CLI，再回来重新检测。",
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

function formatSetupTime(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}
