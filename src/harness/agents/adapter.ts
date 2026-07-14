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
  nativeSessionId?: string;
  input: HarnessUserInput;
  permissions: HarnessPermissionPolicy;
  resources: ResourceSelectionSnapshot;
  context: ContextBundle;
  outputContract: OutputContract;
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
