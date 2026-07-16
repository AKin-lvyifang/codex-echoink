import type { AgentBackendMode } from "../settings/settings";

export interface AgentRuntimeHealthSnapshot {
  unavailable: boolean;
  error: string;
  updatedAt: number;
}

export type AgentRuntimeFailureSource =
  | "explicit"
  | "setup-connect"
  | "adapter-runtime"
  | "terminal"
  | "codex-notification"
  | "persisted";

export interface AgentRuntimeFailureContext {
  source?: AgentRuntimeFailureSource;
  backend?: AgentBackendMode;
}

export class AgentRuntimeHealthStore {
  private readonly snapshots = createAgentRuntimeHealthRecord();

  get(backend: AgentBackendMode): AgentRuntimeHealthSnapshot {
    return this.snapshots[backend];
  }

  reportHealthy(backend: AgentBackendMode): void {
    this.snapshots[backend] = healthyAgentRuntimeSnapshot();
  }

  reset(backend: AgentBackendMode): void {
    this.snapshots[backend] = emptyAgentRuntimeHealth();
  }

  reportFailure(
    backend: AgentBackendMode,
    error: unknown,
    context: Omit<AgentRuntimeFailureContext, "backend"> = {}
  ): boolean {
    const snapshot = unavailableAgentRuntimeSnapshot(error, Date.now(), { ...context, backend });
    if (!snapshot) return false;
    this.snapshots[backend] = snapshot;
    return true;
  }
}

export function createAgentRuntimeHealthRecord(): Record<AgentBackendMode, AgentRuntimeHealthSnapshot> {
  return {
    "codex-cli": emptyAgentRuntimeHealth(),
    opencode: emptyAgentRuntimeHealth(),
    hermes: emptyAgentRuntimeHealth()
  };
}

export function healthyAgentRuntimeSnapshot(now = Date.now()): AgentRuntimeHealthSnapshot {
  return { unavailable: false, error: "", updatedAt: now };
}

export function unavailableAgentRuntimeSnapshot(
  error: unknown,
  now = Date.now(),
  context: AgentRuntimeFailureContext = {}
): AgentRuntimeHealthSnapshot | null {
  const message = agentRuntimeErrorMessage(error);
  if (!isAgentRuntimeAvailabilityError(error, context)) return null;
  return { unavailable: true, error: message.slice(0, 2_000), updatedAt: now };
}

export function isAgentRuntimeAvailabilityError(
  value: unknown,
  context: AgentRuntimeFailureContext = {}
): boolean {
  if (isRetryingAgentRuntimeError(value)) return false;
  const message = agentRuntimeErrorMessage(value);
  if (!message) return false;
  const source = context.source ?? "explicit";
  const structuredCode = agentRuntimeErrorCode(value);
  const backendBoundSource = source === "adapter-runtime" || source === "terminal" || source === "codex-notification";
  if (structuredCode === "APP_SERVER_EXIT") {
    return !backendBoundSource || context.backend === "codex-cli";
  }

  const explicitProcessMessage = /\bAPP_SERVER_EXIT\b|app[- ]server[^\n]*(?:exit|closed|terminated)|JSON-RPC transport (?:is )?closed|(?:Codex|OpenCode|Hermes)[^\n]*(?:process|server|transport)[^\n]*(?:exit|closed|terminated|unavailable|ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)|(?:Codex|OpenCode|Hermes)[^\n]*(?:进程|服务|传输)[^\n]*(?:退出|关闭|不可用|拒绝连接)/i.test(message);
  if (explicitProcessMessage) {
    return !backendBoundSource || runtimeMessageNamesBackend(message, context.backend);
  }

  const nodeProcessMessage = /^(?:Error:\s*)?spawn\s+[^\n]+\s+ENOENT(?:\s|$)|^(?:Error:\s*)?connect\s+ECONNREFUSED\b|^(?:Error:\s*)?(?:read|write|connect)\s+(?:ECONNRESET|EPIPE)\b/i.test(message);
  if (source === "setup-connect" || source === "explicit" || source === "persisted") {
    return nodeProcessMessage
      || /无法连接到(?:本地|\s*Agent|\s*Codex|\s*OpenCode|\s*Hermes)|(?:Codex|OpenCode|Hermes)[^\n]*(?:拒绝连接|启动失败|进程(?:已)?退出|传输(?:已)?关闭)/i.test(message);
  }

  if (source === "adapter-runtime" || source === "terminal") {
    if (!nodeProcessMessage) return false;
    return runtimeMessageNamesBackend(message, context.backend);
  }

  return false;
}

export function agentRuntimeErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message.trim();
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = [record.message, record.error, record.code].find((item) => typeof item === "string" && item.trim());
    if (typeof direct === "string") return direct.trim();
    if (record.error && typeof record.error === "object") {
      const nested = agentRuntimeErrorMessage(record.error);
      if (nested) return nested;
    }
    try {
      return JSON.stringify(value).slice(0, 2_000);
    } catch {
      return String(value).trim();
    }
  }
  return String(value ?? "").trim();
}

function emptyAgentRuntimeHealth(): AgentRuntimeHealthSnapshot {
  return { unavailable: false, error: "", updatedAt: 0 };
}

function agentRuntimeErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.code === "string") return record.code.trim().toUpperCase();
  return agentRuntimeErrorCode(record.error);
}

function isRetryingAgentRuntimeError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.willRetry === true) return true;
  return isRetryingAgentRuntimeError(record.error);
}

function runtimeMessageNamesBackend(message: string, backend: AgentBackendMode | undefined): boolean {
  if (!backend) return false;
  const explicitlyNamedBackends: AgentBackendMode[] = [];
  if (/\bcodex\b|app[- ]server/i.test(message)) explicitlyNamedBackends.push("codex-cli");
  if (/\bopencode\b/i.test(message)) explicitlyNamedBackends.push("opencode");
  if (/\bhermes\b|\bACP\b/i.test(message)) explicitlyNamedBackends.push("hermes");
  if (explicitlyNamedBackends.length > 0) return explicitlyNamedBackends.includes(backend);
  const marker = backend === "codex-cli" ? /\bcodex\b|app[- ]server|JSON-RPC/i
    : backend === "opencode" ? /\bopencode\b/i
      : /\bhermes\b|\bACP\b|JSON-RPC/i;
  return marker.test(message);
}
