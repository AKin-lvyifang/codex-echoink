import type { AgentBackendMode } from "../settings/settings";

export type AgentSetupBackend = AgentBackendMode;

export type AgentSetupPhase =
  | "detecting"
  | "missing"
  | "installed"
  | "installing"
  | "needs-auth"
  | "authorizing"
  | "connecting"
  | "ready"
  | "failed"
  | "cancelled";

export type AgentSetupNextAction = "install" | "authorize" | "connect" | "start" | "retry" | "cancel" | null;

export interface AgentSetupSnapshot {
  backend: AgentSetupBackend;
  phase: AgentSetupPhase;
  command: string | null;
  version: string | null;
  detail: string;
  logs: string;
  error: string;
  nextAction: AgentSetupNextAction;
  checkedAt: number;
}

export interface AgentSetupContext {
  signal?: AbortSignal;
  onProgress?: (detail: string, logs?: string) => void;
  openUrl?: (url: string) => void;
  requestSecret?: (input: { title: string; label: string }) => Promise<string | null>;
}

export interface AgentInstaller {
  readonly backend: AgentSetupBackend;
  detect(context?: AgentSetupContext): Promise<AgentSetupSnapshot>;
  install(context?: AgentSetupContext): Promise<AgentSetupSnapshot>;
  authorize?(context?: AgentSetupContext): Promise<AgentSetupSnapshot>;
  connect(context?: AgentSetupContext): Promise<AgentSetupSnapshot>;
}

export interface AgentSetupPrimaryState {
  action: AgentSetupNextAction;
  label: string;
  disabled: boolean;
  busy: boolean;
}

const BACKEND_LABELS: Record<AgentSetupBackend, string> = {
  "codex-cli": "Codex",
  opencode: "OpenCode",
  hermes: "Hermes"
};

export function createAgentSetupSnapshot(
  backend: AgentSetupBackend,
  phase: AgentSetupPhase = "detecting",
  patch: Partial<Omit<AgentSetupSnapshot, "backend" | "phase">> = {}
): AgentSetupSnapshot {
  return {
    backend,
    phase,
    command: null,
    version: null,
    detail: phase === "detecting" ? "正在检测本机环境…" : "",
    logs: "",
    error: "",
    nextAction: defaultNextAction(phase),
    checkedAt: 0,
    ...patch
  };
}

export function resolveAgentSetupPrimary(snapshot: AgentSetupSnapshot): AgentSetupPrimaryState {
  if (snapshot.phase === "detecting") return { action: null, label: "正在检测", disabled: true, busy: true };
  if (snapshot.phase === "installing") return { action: "cancel", label: "取消安装", disabled: false, busy: true };
  if (snapshot.phase === "authorizing") return { action: null, label: "正在授权", disabled: true, busy: true };
  if (snapshot.phase === "connecting" && snapshot.nextAction !== "connect") {
    return { action: null, label: "正在连接", disabled: true, busy: true };
  }
  const action = snapshot.nextAction ?? defaultNextAction(snapshot.phase);
  if (action === "install") return { action, label: `安装 ${BACKEND_LABELS[snapshot.backend]}`, disabled: false, busy: false };
  if (action === "authorize") return { action, label: snapshot.backend === "codex-cli" ? "登录 Codex" : `授权 ${BACKEND_LABELS[snapshot.backend]}`, disabled: false, busy: false };
  if (action === "connect") return { action, label: "连接", disabled: false, busy: false };
  if (action === "start") return { action, label: "开始使用", disabled: false, busy: false };
  if (action === "cancel") return { action, label: "取消", disabled: false, busy: true };
  return { action: "retry", label: "重试", disabled: false, busy: false };
}

export function agentSetupRowStatus(snapshot: AgentSetupSnapshot): string {
  if (snapshot.phase === "detecting") return "检测中";
  if (snapshot.phase === "missing") return "未安装";
  if (snapshot.phase === "installed") return "已安装";
  if (snapshot.phase === "installing") return "安装中";
  if (snapshot.phase === "needs-auth" || snapshot.phase === "authorizing") return "需授权";
  if (snapshot.phase === "ready") return "已就绪";
  if (snapshot.command && snapshot.phase === "connecting") return "已安装";
  if (snapshot.phase === "cancelled") return snapshot.command ? "已安装" : "未安装";
  if (snapshot.phase === "failed") return snapshot.command ? "需处理" : "安装失败";
  return snapshot.command ? "已安装" : "未安装";
}

export function limitedAgentSetupLog(value: string, maxChars = 8_000): string {
  const redacted = String(value ?? "")
    .replace(/(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s]+/gi, "$1=[已隐藏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [已隐藏]")
    .trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars))}\n…`;
}

function defaultNextAction(phase: AgentSetupPhase): AgentSetupNextAction {
  if (phase === "missing") return "install";
  if (phase === "installed") return "connect";
  if (phase === "installing") return "cancel";
  if (phase === "needs-auth") return "authorize";
  if (phase === "ready") return "start";
  if (phase === "failed" || phase === "cancelled") return "retry";
  return null;
}
