import type { PermissionMode, ReasoningEffort, ServiceTierChoice, UiMode } from "../types/app-server";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "./runtime";

export type AgentBackendKind = "codex-cli" | "opencode" | "hermes";
export type AgentInputModality = "text" | "image" | "pdf";

export interface AgentBackendCapabilities {
  chat: boolean;
  knowledgeTasks: boolean;
  editorActions: boolean;
  listModels: boolean;
  listAgents: boolean;
  fileStatus: boolean;
  richEvents: boolean;
  structuredToolCalls: boolean;
  nativeMcpPassThrough: boolean;
  promptInstructionInjection: boolean;
  customProviderConfig: "codex-responses" | "opencode-provider" | "hermes-model" | "external";
}

export interface AgentConnectionStatus {
  connected: boolean;
  label: string;
  version?: string;
  errors: string[];
}

export interface AgentModelInfo {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  inputModalities: AgentInputModality[];
}

export type AgentProfileMode = "subagent" | "primary" | "all";

export interface AgentProfileInfo {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  mode: AgentProfileMode;
  native?: boolean;
}

export interface AgentSessionOptions {
  title: string;
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  permission?: PermissionMode;
  reasoning?: ReasoningEffort;
  serviceTier?: ServiceTierChoice;
  mode?: UiMode;
  writableRoots?: string[];
}

export interface AgentTextPart {
  type: "text";
  text: string;
}

export interface AgentFilePart {
  type: "file";
  path: string;
  filename?: string;
  mime: string;
}

export type AgentPromptPart = AgentTextPart | AgentFilePart;

export interface AgentPromptOptions {
  sessionId: string;
  parts: AgentPromptPart[];
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  system?: string;
  tools?: Record<string, boolean>;
}

export interface AgentFileStatus {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

export interface AgentBackend {
  kind: AgentBackendKind;
  connect(): Promise<void | AgentConnectionStatus>;
  disconnect(): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  listAgents?(): Promise<AgentProfileInfo[]>;
  startSession(options: AgentSessionOptions): Promise<{ sessionId: string; title: string }>;
  sendPrompt(options: AgentPromptOptions): Promise<string>;
  sendPromptAsync?(options: AgentPromptOptions): Promise<void>;
  abort(sessionId: string): Promise<void>;
  fileStatus?(): Promise<AgentFileStatus[]>;
}

export interface AgentExactWriteFenceContext {
  /** Attempt identity issued by the maintenance orchestrator. */
  attemptToken: string;
  /** Same-lease identity used to reject receipts from another native run. */
  leaseToken: string;
  /** Live Vault paths that the configured transport must keep read-only. */
  deniedLivePaths: string[];
  /** Shadow control-plane paths that the configured transport must not write. */
  deniedControlPaths: string[];
}

export interface AgentExactWriteFenceReceipt {
  readonly version: 1;
  readonly backend: AgentBackendKind;
  readonly attemptToken: string;
  readonly leaseToken: string;
  readonly enforcedWritableRoots: readonly string[];
  readonly deniedLivePaths: readonly string[];
  readonly deniedControlPaths: readonly string[];
  readonly transport: string;
  readonly configAckDigest: string;
  readonly configuredAt: string;
}

export interface AgentNativeExecutionDescriptor {
  kind: "thread" | "session" | "run" | "process";
  persistence:
    | "none"
    | "process-local"
    | "provider-persistent"
    | "unknown";
  transport: string;
}

export interface AgentTaskInput {
  prompt: string;
  system?: string;
  nativeSessionId?: string;
  sources?: AgentPromptPart[];
  permission?: PermissionMode;
  writableRoots?: string[];
  /**
   * Requires the backend transport to prove that writes are limited to the
   * exact writableRoots before submitting the prompt. A runtime that cannot
   * preserve that fence must fail closed instead of using a broader fallback.
   */
  requireExactWriteFence?: boolean;
  exactWriteFence?: AgentExactWriteFenceContext;
  /**
   * Runs after the native transport acknowledges its scoped configuration and
   * before the prompt is submitted. EchoInk code generates this receipt.
   */
  onExactWriteFenceConfigured?: (receipt: AgentExactWriteFenceReceipt) => void | Promise<void>;
  model?: {
    providerId: string;
    modelId: string;
  };
  agent?: string;
  profile?: string;
  requireDirectAgent?: boolean;
  resources?: PreparedAgentResources;
  toolBridge?: AgentToolBridgeRuntime | null;
  timeoutMs?: number;
  tools?: Record<string, boolean>;
  abortSignal?: AbortSignal;
  requireNativeRegistrationBeforePrompt?: boolean;
  /**
   * The supplied nativeSessionId is a Harness-owned durable binding. A runtime
   * must either resume that exact session or report it stale; it may not
   * silently create a replacement below the Harness retirement boundary.
   */
  requireNativeSessionResume?: boolean;
  onRunId?: (
    runId: string,
    native?: AgentNativeExecutionDescriptor
  ) => void | Promise<void>;
}

export const NATIVE_RUN_REGISTRATION_ERROR_CODE = "NATIVE_EXECUTION_REGISTRATION_FAILED";

export class NativeRunRegistrationError extends Error {
  readonly code = NATIVE_RUN_REGISTRATION_ERROR_CODE;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NativeRunRegistrationError";
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

export function isNativeRunRegistrationError(error: unknown): error is NativeRunRegistrationError {
  return error instanceof NativeRunRegistrationError
    || (typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === NATIVE_RUN_REGISTRATION_ERROR_CODE);
}

export const NATIVE_SESSION_STALE_ERROR_CODE = "AGENT_NATIVE_SESSION_STALE";

export class NativeSessionStaleError extends Error {
  readonly code = NATIVE_SESSION_STALE_ERROR_CODE;

  constructor(
    message: string,
    readonly nativeExecutionId: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "NativeSessionStaleError";
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

export function isNativeSessionStaleError(error: unknown): error is NativeSessionStaleError {
  return error instanceof NativeSessionStaleError
    || (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === NATIVE_SESSION_STALE_ERROR_CODE
      && typeof (error as { nativeExecutionId?: unknown }).nativeExecutionId === "string"
    );
}

export interface AgentTaskResult {
  text: string;
  runId?: string;
  /** Backend-neutral diagnostics to merge into the canonical Harness terminal event. */
  terminalData?: Record<string, unknown>;
  effectiveModel?: {
    providerId: string;
    modelId: string;
  };
  usage?: Record<string, unknown>;
}
