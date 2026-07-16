import type { AgentBackendMode } from "../settings/settings";
import type { SettingsCopy } from "../settings/i18n";

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

export type AgentInstallerRegistry = Readonly<Record<AgentSetupBackend, AgentInstaller>>;
export type AgentInstallerAction = "install" | "authorize" | "connect";
export type AgentInstallerCopy = SettingsCopy["setup"]["agentInstaller"];

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
  const snapshot: AgentSetupSnapshot = {
    backend,
    phase,
    command: null,
    version: null,
    detail: "",
    logs: "",
    error: "",
    nextAction: defaultNextAction(phase),
    checkedAt: 0,
    ...patch
  };
  return {
    ...snapshot,
    logs: limitedAgentSetupLog(snapshot.logs),
    error: limitedAgentSetupLog(snapshot.error, 2_000)
  };
}

export function resolveAgentSetupPrimary(snapshot: AgentSetupSnapshot, copy: AgentInstallerCopy): AgentSetupPrimaryState {
  if (snapshot.phase === "detecting") return { action: null, label: copy.primary.detecting, disabled: true, busy: true };
  if (snapshot.phase === "installing") return { action: "cancel", label: copy.primary.cancelInstall, disabled: false, busy: true };
  if (snapshot.phase === "authorizing") return { action: "cancel", label: copy.primary.cancelAuthorization, disabled: false, busy: true };
  if (snapshot.phase === "connecting" && snapshot.nextAction !== "connect") {
    return { action: null, label: copy.primary.connecting, disabled: true, busy: true };
  }
  const action = snapshot.nextAction ?? defaultNextAction(snapshot.phase);
  if (action === "install") return { action, label: copy.primary.install(BACKEND_LABELS[snapshot.backend]), disabled: false, busy: false };
  if (action === "authorize") return { action, label: snapshot.backend === "codex-cli" ? copy.primary.codexLogin : copy.primary.authorize(BACKEND_LABELS[snapshot.backend]), disabled: false, busy: false };
  if (action === "connect") return { action, label: copy.primary.connect, disabled: false, busy: false };
  if (action === "start") return { action, label: copy.primary.start, disabled: false, busy: false };
  if (action === "cancel") return { action, label: copy.primary.cancel, disabled: false, busy: true };
  return { action: "retry", label: copy.primary.retry, disabled: false, busy: false };
}

export function agentSetupRowStatus(snapshot: AgentSetupSnapshot, copy: AgentInstallerCopy): string {
  if (snapshot.phase === "detecting") return copy.rowStatus.detecting;
  if (snapshot.phase === "missing") return copy.rowStatus.missing;
  if (snapshot.phase === "installed") return copy.rowStatus.installed;
  if (snapshot.phase === "installing") return copy.rowStatus.installing;
  if (snapshot.phase === "needs-auth" || snapshot.phase === "authorizing") return copy.rowStatus.needsAuth;
  if (snapshot.phase === "ready") return copy.rowStatus.ready;
  if (snapshot.command && snapshot.phase === "connecting") return copy.rowStatus.installed;
  if (snapshot.phase === "cancelled") return snapshot.command ? copy.rowStatus.installed : copy.rowStatus.missing;
  if (snapshot.phase === "failed") return snapshot.command ? copy.rowStatus.needsAttention : copy.rowStatus.installFailed;
  return snapshot.command ? copy.rowStatus.installed : copy.rowStatus.missing;
}

export function limitedAgentSetupLog(value: string, maxChars = 8_000): string {
  const redacted = String(value ?? "")
    .replace(/([?&](?:api(?:[+_-]|%20)*key|access(?:[+_-]|%20)*token|refresh(?:[+_-]|%20)*token|authorization(?:[+_-]|%20)*code|device(?:[+_-]|%20)*code|user(?:[+_-]|%20)*code|client(?:[+_-]|%20)*secret|authorization|password|token|secret)=)[^&#\s]*/gi, "$1[已隐藏]")
    .replace(/\b(Bearer|Basic)\s+["']?[A-Za-z0-9._~+/=-]{4,}["']?/gi, "$1 [已隐藏]")
    .replace(/(^|[^A-Za-z0-9_?&])(["']?(?:api[ _-]*key|access[ _-]*token|refresh[ _-]*token|authorization[ _-]*code|device[ _-]*code|user[ _-]*code|client[ _-]*secret|authorization|password|token|secret)["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\r\n]+)/gim, "$1$2[已隐藏]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[已隐藏密钥]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/gi, "[已隐藏密钥]")
    .trim();
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars))}\n…`;
}

export async function runAgentInstallerAction(
  installers: AgentInstallerRegistry,
  backend: AgentSetupBackend,
  action: AgentInstallerAction,
  context: AgentSetupContext = {}
): Promise<AgentSetupSnapshot> {
  const installer = installers[backend];
  if (installer.backend !== backend) throw new Error(`Agent installer backend mismatch: ${backend}`);
  if (action === "install") return await installer.install(context);
  if (action === "connect") return await installer.connect(context);
  if (!installer.authorize) throw new Error(`${BACKEND_LABELS[backend]} 不支持自动授权。`);
  return await installer.authorize(context);
}

export function readyAgentBackendToCommit(
  selectedBackend: AgentSetupBackend,
  snapshot: AgentSetupSnapshot
): AgentSetupBackend | null {
  return snapshot.backend === selectedBackend && snapshot.phase === "ready" ? selectedBackend : null;
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
