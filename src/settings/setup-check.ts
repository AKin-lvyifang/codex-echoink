import type { AgentBackendMode, CodexForObsidianSettings, SetupSettings } from "./settings";
import type { CodexStatusSnapshot } from "../types/app-server";
import type { CodexInstallationDetection } from "../core/codex-service";

export type SetupCheckStatus = "ok" | "warning" | "blocking";
export type SetupRequirementId = "codex-cli" | "codex-login" | "opencode-cli" | "opencode-server" | "opencode-models" | "opencode-agent" | "hermes-cli" | "hermes-server" | "hermes-model";
export type SetupActionKind = "copy-command" | "open-url";

export interface SetupPlatform {
  os: string;
  codexCommand: string | null;
  openCodeCommand: string | null;
  hermesCommand: string | null;
  codexDetection?: CodexInstallationDetection | null;
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

export type SetupPrimaryAction = "checking" | "start" | "login" | "install" | "retry";

export interface SetupPrimaryState {
  action: SetupPrimaryAction;
  title: string;
  detail: string;
  buttonLabel: string;
  disabled: boolean;
  tone: "neutral" | "success" | "error";
  showTerminalFallback: boolean;
}

export interface SetupPrimaryCopy {
  checkingTitle: string;
  checkingDetail: string;
  checkingButton: string;
  retryTitle: string;
  retryButton: string;
  readyTitle: string;
  readyDetail: string;
  startButton: string;
  loginTitle: string;
  loginDetail: string;
  loginButton: string;
  installTitle: string;
  installDetail: string;
  installButton: string;
  backendTitle: string;
  backendDetail: string;
  fallbackCustom: (source: string, command: string) => string;
  sourceChatGpt: string;
  sourceCodexApp: string;
  sourceLocal: string;
}

const DEFAULT_SETUP_PRIMARY_COPY: SetupPrimaryCopy = {
  checkingTitle: "正在检测当前环境",
  checkingDetail: "检查当前后端需要的本机能力…",
  checkingButton: "正在连接…",
  retryTitle: "连接没有完成",
  retryButton: "重试",
  readyTitle: "环境已就绪",
  readyDetail: "必要环境已通过",
  startButton: "开始使用",
  loginTitle: "还差一步登录",
  loginDetail: "已找到 Codex。登录会在浏览器中完成。",
  loginButton: "登录 Codex",
  installTitle: "没有找到 Codex",
  installDetail: "可以由 EchoInk 安装官方 Codex CLI；安装前会再次确认。",
  installButton: "安装并连接",
  backendTitle: "环境还未就绪",
  backendDetail: "请检查当前 Agent 后端后重试。",
  fallbackCustom: (source, command) => `自定义路径已失效，已自动改用 ${source}：${command}`,
  sourceChatGpt: "ChatGPT 内置 Codex",
  sourceCodexApp: "Codex App",
  sourceLocal: "本机 Codex"
};

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
  const openCodeRequired = knowledgeBackend === "opencode" || settings.agentBackend === "opencode";
  const hermesRequired = knowledgeBackend === "hermes" || settings.agentBackend === "hermes";

  if (codexRequired) {
    const ready = codexInstalled && codexConnected && codexLoggedIn;
    requirements.push({
      id: "codex-cli",
      status: ready ? "ok" : "blocking",
      title: ready ? "Codex 已就绪" : codexInstalled ? "Codex 需要登录" : "缺少 Codex",
      message: ready
        ? lastStatus?.accountLabel || `已连接：${platform.codexCommand}`
        : codexInstalled
          ? `已找到：${platform.codexCommand}。在浏览器完成登录后会自动继续。`
          : "EchoInk 可以安全安装官方 Codex CLI；安装前会再次确认。",
      actions: ready ? [] : codexInstalled ? codexLoginActions() : codexInstallActions()
    });
  }

  if (openCodeRequired) {
    requirements.push({
      id: "opencode-cli",
      status: openCodeInstalled ? "ok" : "blocking",
      title: openCodeInstalled ? "OpenCode 已安装" : "缺少 OpenCode",
      message: openCodeInstalled ? `已检测到：${platform.openCodeCommand}` : "当前知识库后端使用 OpenCode API，需要本机 OpenCode runtime。",
      actions: openCodeInstalled ? [] : openCodeInstallActions(platform.os)
    });
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

  if (hermesRequired) {
    requirements.push({
      id: "hermes-cli",
      status: hermesInstalled ? "ok" : "blocking",
      title: hermesInstalled ? "Hermes CLI 已安装" : "缺少 Hermes CLI",
      message: hermesInstalled ? `已检测到：${platform.hermesCommand}` : "当前知识库后端使用 Hermes，需要本机 Hermes CLI。",
      actions: hermesInstalled ? [] : hermesInstallActions(platform.os)
    });
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

export function buildSetupPrimaryState(
  check: SetupCheckResult,
  input: { checking: boolean; error: string; status: CodexStatusSnapshot | null; platform: SetupPlatform; copy?: SetupPrimaryCopy }
): SetupPrimaryState {
  const copy = input.copy ?? DEFAULT_SETUP_PRIMARY_COPY;
  if (input.checking) {
    return {
      action: "checking",
      title: copy.checkingTitle,
      detail: copy.checkingDetail,
      buttonLabel: copy.checkingButton,
      disabled: true,
      tone: "neutral",
      showTerminalFallback: false
    };
  }
  if (input.error) {
    return {
      action: "retry",
      title: copy.retryTitle,
      detail: input.error,
      buttonLabel: copy.retryButton,
      disabled: false,
      tone: "error",
      showTerminalFallback: check.requirements.some((item) => item.id === "codex-cli")
    };
  }
  if (check.canStart) {
    return {
      action: "start",
      title: copy.readyTitle,
      detail: setupReadyDetail(check, input.status, input.platform.codexDetection, copy),
      buttonLabel: copy.startButton,
      disabled: false,
      tone: "success",
      showTerminalFallback: false
    };
  }
  const codex = check.requirements.find((item) => item.id === "codex-cli" && item.status !== "ok");
  if (codex && input.platform.codexCommand && input.status?.connected && !input.status.accountReadError) {
    return {
      action: "login",
      title: copy.loginTitle,
      detail: fallbackDetail(input.platform.codexDetection, copy) || copy.loginDetail,
      buttonLabel: copy.loginButton,
      disabled: false,
      tone: "neutral",
      showTerminalFallback: false
    };
  }
  if (codex && input.platform.codexCommand) {
    return {
      action: "retry",
      title: copy.retryTitle,
      detail: copy.backendDetail,
      buttonLabel: copy.retryButton,
      disabled: false,
      tone: "error",
      showTerminalFallback: false
    };
  }
  if (codex) {
    return {
      action: "install",
      title: copy.installTitle,
      detail: copy.installDetail,
      buttonLabel: copy.installButton,
      disabled: false,
      tone: "error",
      showTerminalFallback: true
    };
  }
  return {
    action: "retry",
    title: copy.backendTitle,
    detail: copy.backendDetail,
    buttonLabel: copy.retryButton,
    disabled: false,
    tone: "error",
    showTerminalFallback: false
  };
}

function setupReadyDetail(check: SetupCheckResult, status: CodexStatusSnapshot | null, detection: CodexInstallationDetection | null | undefined, copy: SetupPrimaryCopy): string {
  const codexRequired = check.requirements.some((item) => item.id === "codex-cli");
  const parts = [codexRequired ? status?.accountLabel || copy.readyDetail : copy.readyDetail];
  if (codexRequired && detection?.version) parts.push(detection.version);
  const fallback = codexRequired ? fallbackDetail(detection, copy) : "";
  if (fallback) parts.push(fallback);
  return parts.join(" · ");
}

function fallbackDetail(detection: CodexInstallationDetection | null | undefined, copy: SetupPrimaryCopy): string {
  if (!detection?.invalidCustomPath || !detection.command) return "";
  return copy.fallbackCustom(codexSourceLabel(detection, copy), detection.command);
}

function codexSourceLabel(detection: CodexInstallationDetection, copy: SetupPrimaryCopy): string {
  if (detection.source === "chatgpt-system" || detection.source === "chatgpt-user") return copy.sourceChatGpt;
  if (detection.source === "codex-system" || detection.source === "codex-user") return copy.sourceCodexApp;
  return copy.sourceLocal;
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
