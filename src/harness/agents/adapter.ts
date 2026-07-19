import type { AgentCapabilities } from "../contracts/capability";
import type { ContextBundle } from "../contracts/context";
import type { HarnessEventSink } from "../contracts/event";
import type { BackendSessionBinding, HarnessPermissionPolicy, HarnessRunRequest, HarnessUserInput, HarnessWorkflow, OutputContract, ResourceSelectionSnapshot } from "../contracts/run";
import type {
  NativeExecutionCapabilities,
  NativeExecutionDispositionRequest,
  NativeExecutionDispositionResult,
  NativeExecutionRef
} from "../contracts/native-execution";

export interface AgentManifest {
  id: string;
  displayName: string;
  version: string;
  capabilities: AgentCapabilities;
  nativeExecution?: NativeExecutionCapabilities;
}

export interface AgentConnectContext {
  runId: string;
  sessionId: string;
  workspace: HarnessRunRequest["workspace"];
}

export interface AgentConnectionStatus {
  connected: boolean;
  label: string;
  version?: string;
  errors: string[];
}

export interface NativeResourceSnapshot {
  backendId: string;
  resources: Array<{
    id: string;
    type: "skill" | "mcp" | "tool";
    name: string;
  }>;
  capturedAt: number;
}

export interface AgentNativeSessionPreparationRequest {
  runId: string;
  sessionId: string;
  binding: BackendSessionBinding | null;
  action: "none" | "resume" | "reset";
  reason: string;
}

export interface AgentNativeSessionPreparationResult {
  status: "not-applicable" | "resumed" | "reset" | "failed";
  nativeExecutionId?: string;
  error?: string;
}

export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  workflow?: HarnessWorkflow;
  /**
   * The workspace frozen by the Harness for this run. Production callers
   * always provide it; optionality only preserves compatibility for direct
   * adapter test doubles that do not execute workspace-scoped operations.
   */
  workspace?: HarnessRunRequest["workspace"];
  nativeSessionId?: string;
  nativeThreadId?: string;
  /**
   * True when the Harness owns the Conversation-to-Native binding for this
   * run. Managed adapters must use only the explicit native IDs above and
   * must not read or mutate a process-global "current" native session.
   */
  nativeBindingManagedByHarness?: boolean;
  /**
   * Durable registration barrier. Adapters call and await it immediately
   * after a Native ID is known and before any prompt is submitted.
   */
  registerNativeExecution?: (native: NativeExecutionRef) => Promise<void>;
  input: HarnessUserInput;
  permissions: HarnessPermissionPolicy;
  resources: ResourceSelectionSnapshot;
  context: ContextBundle;
  outputContract: OutputContract;
}

export const AGENT_NATIVE_SESSION_STALE_ERROR_CODE = "AGENT_NATIVE_SESSION_STALE";

export class AgentNativeSessionStaleError extends Error {
  readonly code = AGENT_NATIVE_SESSION_STALE_ERROR_CODE;

  constructor(
    message: string,
    readonly nativeExecutionId: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "AgentNativeSessionStaleError";
    if (cause !== undefined) Object.assign(this, { cause });
  }
}

export function isAgentNativeSessionStaleError(
  error: unknown
): error is AgentNativeSessionStaleError {
  return error instanceof AgentNativeSessionStaleError
    || (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === AGENT_NATIVE_SESSION_STALE_ERROR_CODE
    );
}

export interface AgentRunResult {
  status: "running" | "completed" | "failed" | "cancelled";
  outputText?: string;
  nativeExecution?: NativeExecutionRef;
  nativeSessionId?: string;
  nativeThreadId?: string;
  effectiveModel?: {
    providerId: string;
    modelId: string;
  };
  usage?: Record<string, unknown>;
  /** Diagnostics preserved on the canonical run.completed/run.failed/run.cancelled event. */
  terminalData?: Record<string, unknown>;
  error?: string;
}

export interface AgentAdapter {
  readonly manifest: AgentManifest;
  connect(context: AgentConnectContext): Promise<AgentConnectionStatus>;
  dispose(): Promise<void>;
  listModels(): Promise<Array<{ id: string; displayName: string }>>;
  listProfiles?(): Promise<Array<{ id: string; displayName: string }>>;
  prepareNativeSession?(request: AgentNativeSessionPreparationRequest): Promise<AgentNativeSessionPreparationResult>;
  listNativeResources?(): Promise<NativeResourceSnapshot>;
  disposeNativeExecution?(request: NativeExecutionDispositionRequest): Promise<NativeExecutionDispositionResult>;
  run(request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult>;
  awaitResult?(runId: string): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
}
