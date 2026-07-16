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
export type AgentInstallerAction = "install" | "authorize" | "connect";

export type AgentSetupDashboardTone = "ready" | "failed" | "missing" | "attention" | "busy";

export interface AgentSetupDashboardState {
  status: AgentSetupPhase;
  tone: AgentSetupDashboardTone;
  busy: boolean;
  installed: boolean;
  primaryAction: AgentSetupNextAction;
  retryTarget: AgentInstallerAction | null;
}

export interface AgentSetupSnapshot {
  backend: AgentSetupBackend;
  phase: AgentSetupPhase;
  command: string | null;
  version: string | null;
  detail: string;
  logs: string;
  error: string;
  nextAction: AgentSetupNextAction;
  /** In-memory operation context used to retry a failed or cancelled action directly. */
  lastAction?: AgentInstallerAction | null;
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
    lastAction: defaultLastAction(phase),
    checkedAt: 0,
    ...patch
  };
  return {
    ...snapshot,
    logs: limitedAgentSetupLog(snapshot.logs),
    error: limitedAgentSetupLog(snapshot.error, 2_000)
  };
}

/**
 * Resolves the setup snapshot into presentation-agnostic dashboard semantics.
 * Labels remain in the settings i18n layer; this function only decides state,
 * tone and actions. `lastAction` is intentionally transient and is never part
 * of the persisted plugin settings schema.
 */
export function resolveAgentSetupDashboardState(snapshot: AgentSetupSnapshot): AgentSetupDashboardState {
  const status = snapshot.phase;
  const busy = status === "detecting"
    || status === "installing"
    || status === "authorizing"
    || status === "connecting";

  let tone: AgentSetupDashboardTone;
  if (busy) tone = "busy";
  else if (status === "ready") tone = "ready";
  else if (status === "failed") tone = "failed";
  else if (status === "missing") tone = "missing";
  else if (status === "cancelled") tone = snapshot.command ? "attention" : "missing";
  else tone = "attention";

  let primaryAction: AgentSetupNextAction;
  if (status === "detecting" || status === "connecting") primaryAction = null;
  else if (status === "installing" || status === "authorizing") primaryAction = "cancel";
  else if (status === "missing") primaryAction = "install";
  else if (status === "installed") primaryAction = "connect";
  else if (status === "needs-auth") primaryAction = "authorize";
  else if (status === "ready") primaryAction = "start";
  else primaryAction = "retry";

  return {
    status,
    tone,
    busy,
    installed: isAgentSetupInstalled(snapshot),
    primaryAction,
    retryTarget: resolveAgentSetupRetryTarget(snapshot)
  };
}

export function isAgentSetupDetectionRevisionCurrent(startRevision: number, currentRevision: number): boolean {
  return startRevision === currentRevision;
}

export function resolveAgentSetupProviderModelLabel(input: {
  providerId: string;
  modelId: string;
  suffix?: string;
  defaultVerified: boolean;
  defaultVerifiedLabel: string;
  unavailableLabel: string;
}): string {
  const providerModel = [input.providerId.trim(), input.modelId.trim()].filter(Boolean).join(" / ");
  const suffix = input.suffix ?? "";
  if (providerModel) return `${providerModel}${suffix}`;
  if (input.defaultVerified) return `${input.defaultVerifiedLabel}${suffix}`;
  return input.unavailableLabel;
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
  let snapshot: AgentSetupSnapshot;
  if (action === "install") snapshot = await installer.install(context);
  else if (action === "connect") snapshot = await installer.connect(context);
  else {
    if (!installer.authorize) throw new Error(`${BACKEND_LABELS[backend]} 不支持自动授权。`);
    snapshot = await installer.authorize(context);
  }
  return { ...snapshot, lastAction: action };
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

function defaultLastAction(phase: AgentSetupPhase): AgentInstallerAction | null {
  if (phase === "installing") return "install";
  if (phase === "authorizing") return "authorize";
  if (phase === "connecting") return "connect";
  return null;
}

function isAgentSetupInstalled(snapshot: AgentSetupSnapshot): boolean {
  if (snapshot.phase === "installed"
    || snapshot.phase === "needs-auth"
    || snapshot.phase === "authorizing"
    || snapshot.phase === "connecting"
    || snapshot.phase === "ready") return true;
  return Boolean(snapshot.command);
}

function resolveAgentSetupRetryTarget(snapshot: AgentSetupSnapshot): AgentInstallerAction | null {
  if (snapshot.lastAction) return snapshot.lastAction;
  if (snapshot.nextAction === "install" || snapshot.nextAction === "authorize" || snapshot.nextAction === "connect") {
    return snapshot.nextAction;
  }
  if (snapshot.phase === "missing" || snapshot.phase === "installing") return "install";
  if (snapshot.phase === "needs-auth" || snapshot.phase === "authorizing") return "authorize";
  if (snapshot.phase === "installed" || snapshot.phase === "connecting") return "connect";
  if (snapshot.phase === "failed" || snapshot.phase === "cancelled") return null;
  return null;
}
