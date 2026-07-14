import type { AgentEvent, AgentEventSink as LegacyAgentEventSink } from "../../../agent/events";
import type { AgentEventTaskRuntime, AgentTaskRuntime, AgentToolBridgeRuntime, PreparedAgentResources } from "../../../agent/runtime";
import { runAgentTaskWithToolBridge } from "../../../agent/tool-bridge";
import type { AgentTaskInput, AgentTaskResult } from "../../../agent/types";
import type { EchoInkResource } from "../../../resources/types";
import { noCapabilities, type AgentCapabilities } from "../../contracts/capability";
import type { HarnessEvent, HarnessEventSink, HarnessEventType } from "../../contracts/event";
import type { NativeExecutionDispositionRequest, NativeExecutionDispositionResult, NativeExecutionKind, NativeExecutionPersistence, NativeExecutionRef } from "../../contracts/native-execution";
import type { AgentAdapter, AgentConnectContext, AgentConnectionStatus, AgentManifest, AgentRunRequest, AgentRunResult, NativeResourceSnapshot } from "../adapter";

export interface TaskRuntimeAgentAdapterOptions {
  backendId: string;
  displayName: string;
  version: string;
  runtime: AgentTaskRuntime;
  nativeRefContext?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">;
  capabilities: AgentCapabilities | "legacy";
  legacyTaskDefaults?: {
    system?: string;
    resources?: PreparedAgentResources;
    toolBridge?: AgentToolBridgeRuntime | null;
    timeoutMs?: number;
    tools?: Record<string, boolean>;
    model?: AgentTaskInput["model"];
    agent?: string;
    profile?: string;
    requireDirectAgent?: boolean;
    abortSignal?: AbortSignal;
    onRunId?: (runId: string) => void;
  };
  listNativeResources?: () => Promise<NativeResourceSnapshot> | NativeResourceSnapshot;
}

export class TaskRuntimeAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;
  private readonly activeNativeRunIds = new Map<string, string>();

  constructor(private readonly options: TaskRuntimeAgentAdapterOptions) {
    this.manifest = {
      id: options.backendId,
      displayName: options.displayName,
      version: options.version,
      capabilities: options.capabilities === "legacy" ? legacyTaskRuntimeCapabilities(options.backendId) : options.capabilities,
      nativeExecution: nativeExecutionCapabilitiesForRuntime(options.backendId, options.runtime)
    };
  }

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    const status = await this.options.runtime.connect();
    return {
      connected: status.connected,
      label: status.label,
      version: status.version,
      errors: status.errors
    };
  }

  async dispose(): Promise<void> {
    await this.options.runtime.disconnect?.();
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return (await this.options.runtime.listModels()).map((model) => ({
      id: model.id,
      displayName: model.displayName
    }));
  }

  async disposeNativeExecution(request: NativeExecutionDispositionRequest): Promise<NativeExecutionDispositionResult> {
    if (request.ref.backendId !== this.manifest.id) {
      return { outcome: "retained", message: "Native execution does not belong to this session adapter" };
    }
    if (request.ref.kind !== "session") {
      return { outcome: "unsupported", message: `${this.manifest.displayName} does not support cleanup for ${request.ref.kind}` };
    }
    if (request.requested !== "delete" || !this.options.runtime.deleteNativeSession) {
      return { outcome: "unsupported", message: `${this.manifest.displayName} does not support ${request.requested}` };
    }
    const mismatch = nativeRefContextMismatch(request.ref, this.options.nativeRefContext);
    if (mismatch) return { outcome: "retained", message: mismatch };
    const deleted = await this.options.runtime.deleteNativeSession(request.ref.id);
    return { outcome: deleted ? "disposed" : "already-disposed", applied: "delete" };
  }

  async listNativeResources(): Promise<NativeResourceSnapshot> {
    if (this.options.listNativeResources) return await this.options.listNativeResources();
    return {
      backendId: this.manifest.id,
      resources: nativeResourcesForBackend(this.manifest.id, this.options.legacyTaskDefaults?.resources?.enabledResources ?? []),
      capturedAt: Date.now()
    };
  }

  async prepareNativeSession(request: Parameters<NonNullable<AgentAdapter["prepareNativeSession"]>>[0]) {
    if (request.action === "none") return { status: "not-applicable" as const };
    const nativeSessionId = request.binding?.nativeSessionId;
    if (request.action === "reset") return { status: "reset" as const, nativeExecutionId: nativeSessionId };
    if (!nativeSessionId || !this.options.runtime.hasNativeSession) {
      return { status: "failed" as const, nativeExecutionId: nativeSessionId, error: "Native session resume is unavailable" };
    }
    try {
      const exists = await this.options.runtime.hasNativeSession(nativeSessionId);
      return exists
        ? { status: "resumed" as const, nativeExecutionId: nativeSessionId }
        : { status: "failed" as const, nativeExecutionId: nativeSessionId, error: "Native session not found" };
    } catch (error) {
      return {
        status: "failed" as const,
        nativeExecutionId: nativeSessionId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async run(request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
    let nativeRunId = "";
    const taskInput: AgentTaskInput & { toolBridge?: AgentToolBridgeRuntime | null } = {
      prompt: buildPrompt(request),
      system: this.options.legacyTaskDefaults?.system,
      nativeSessionId: request.nativeSessionId,
      sources: request.input.attachments.map((attachment) => ({
        type: "file",
        path: attachment.path,
        filename: attachment.name,
        mime: attachment.mime ?? "application/octet-stream"
      })),
      permission: request.permissions.mode,
      writableRoots: request.permissions.writableRoots,
      resources: this.options.legacyTaskDefaults?.resources,
      toolBridge: this.options.legacyTaskDefaults?.toolBridge ?? null,
      timeoutMs: this.options.legacyTaskDefaults?.timeoutMs,
      tools: this.options.legacyTaskDefaults?.tools,
      model: this.options.legacyTaskDefaults?.model,
      agent: this.options.legacyTaskDefaults?.agent,
      profile: this.options.legacyTaskDefaults?.profile,
      requireDirectAgent: this.options.legacyTaskDefaults?.requireDirectAgent,
      abortSignal: this.options.legacyTaskDefaults?.abortSignal,
      onRunId: (runId) => {
        nativeRunId = runId;
        this.activeNativeRunIds.set(request.runId, runId);
        this.options.legacyTaskDefaults?.onRunId?.(runId);
      }
    };

    const runtime = this.options.runtime as AgentTaskRuntime & Partial<AgentEventTaskRuntime>;
    try {
      const result = await runAgentTaskWithToolBridge(runtime, taskInput, legacyEventSink(emit, this.manifest));

      if (!runtime.runTaskEvents) {
        await emit(incompleteHarnessEvent("agent.message.completed", this.manifest.id, result.text));
      }
      return mapTaskResult(this.manifest.id, result, nativeRunId, this.options.nativeRefContext);
    } finally {
      this.activeNativeRunIds.delete(request.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    const nativeRunId = this.activeNativeRunIds.get(runId);
    if (nativeRunId) await this.options.runtime.abort(nativeRunId);
  }
}

function buildPrompt(request: AgentRunRequest): string {
  if (request.workflow === "prompt.enhance") return request.input.text;
  const context = [
    ...request.context.corePolicy,
    ...request.context.workflowContract,
    ...request.context.vaultProfile,
    ...request.context.sessionContext,
    ...request.context.memoryContext,
    ...request.context.knowledgeEvidence,
    ...request.context.echoInkSkills,
    ...request.context.nativeResourceHints,
    ...request.context.turnInstruction
  ]
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join("\n\n");
  return context || request.input.text;
}

function legacyEventSink(emit: HarnessEventSink, manifest: AgentManifest): LegacyAgentEventSink {
  return async (event: AgentEvent) => {
    const mapped = mapLegacyEvent(event, manifest);
    if (mapped) await emit(mapped);
  };
}

function mapLegacyEvent(event: AgentEvent, manifest: AgentManifest): HarnessEvent | null {
  const backendId = manifest.id;
  switch (event.type) {
    case "fallback_started":
      return incompleteHarnessEvent("adapter.fallback.started", backendId, undefined, event.error, undefined, undefined, event.data);
    case "message_delta":
      return incompleteHarnessEvent("agent.message.delta", backendId, event.text, undefined, undefined, undefined, event.data);
    case "message_completed":
    case "completed":
      return incompleteHarnessEvent("agent.message.completed", backendId, event.text, undefined, undefined, undefined, event.data);
    case "thinking_delta":
      if (manifest.capabilities.output.reasoningSummary !== "none") {
        return incompleteHarnessEvent("agent.reasoning.summary.delta", backendId, event.text, undefined, undefined, undefined, event.data);
      }
      if (manifest.capabilities.output.thinkingTrace !== "none") {
        return incompleteHarnessEvent("agent.thinking.delta", backendId, event.text, undefined, undefined, undefined, event.data);
      }
      return null;
    case "thinking_completed":
      if (manifest.capabilities.output.reasoningSummary !== "none") {
        return incompleteHarnessEvent("agent.reasoning.summary.completed", backendId, event.text, undefined, undefined, undefined, event.data);
      }
      if (manifest.capabilities.output.thinkingTrace !== "none") {
        return incompleteHarnessEvent("agent.thinking.completed", backendId, event.text, undefined, undefined, undefined, event.data);
      }
      return null;
    case "tool_call_requested":
      return incompleteHarnessEvent("tool.requested", backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "tool_call_delta":
    case "terminal_output":
      return incompleteHarnessEvent("tool.output.delta", backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "permission_requested":
      return incompleteHarnessEvent("tool.approval.requested", backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "tool_call_completed":
      return incompleteHarnessEvent("tool.completed", backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "tool_call_failed":
      return incompleteHarnessEvent("tool.failed", backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "file_status":
      return incompleteHarnessEvent(legacyFileStatusEventType(event), backendId, event.text, event.error, event.toolName, event.resourceId, event.data);
    case "plan_updated":
      return incompleteHarnessEvent("agent.plan.updated", backendId, event.text, undefined, undefined, undefined, event.data);
    case "usage":
      return incompleteHarnessEvent("usage.updated", backendId, event.text, undefined, undefined, undefined, event.data);
    default:
      return null;
  }
}

function legacyFileStatusEventType(event: AgentEvent): HarnessEventType {
  const status = normalizeLegacyFileStatus(event.status)
    || normalizeLegacyFileStatus(event.data?.status);
  switch (status) {
    case "updated":
    case "completed":
    case "applied":
    case "success":
      return "file.change.applied";
    case "reverted":
    case "rolledback":
    case "rollback":
      return "file.change.reverted";
    default:
      return "file.change.proposed";
  }
}

function normalizeLegacyFileStatus(status: unknown): string {
  return typeof status === "string"
    ? status.trim().toLowerCase().replace(/[-_]/g, "")
    : "";
}

function incompleteHarnessEvent(type: HarnessEventType, backendId: string, text?: string, error?: string, toolName?: string, resourceId?: string, data?: Record<string, unknown>): HarnessEvent {
  return {
    eventId: "",
    runId: "",
    sequence: 0,
    createdAt: 0,
    source: type.startsWith("tool.") ? "tool" : "agent",
    type,
    backendId,
    text,
    error,
    toolName,
    resourceId,
    data
  };
}

function mapTaskResult(
  backendId: string,
  result: AgentTaskResult,
  nativeRunId: string,
  nativeRefContext?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">
): AgentRunResult {
  const nativeId = result.runId ?? (nativeRunId || undefined);
  return {
    status: "completed",
    outputText: result.text,
    nativeExecution: nativeId ? nativeExecutionRefForRuntime(backendId, nativeId, nativeRefContext) : undefined,
    nativeSessionId: nativeId,
    effectiveModel: result.effectiveModel,
    usage: result.usage
  };
}

function nativeExecutionCapabilitiesForRuntime(backendId: string, runtime: AgentTaskRuntime) {
  return {
    persistence: nativeExecutionPersistenceForRuntime(backendId),
    dispositions: {
      processExit: false,
      archive: false,
      delete: backendId === "opencode" && typeof runtime.deleteNativeSession === "function"
    },
    idempotentDisposition: true,
    canInspectExistence: typeof runtime.hasNativeSession === "function"
  };
}

function nativeResourcesForBackend(backendId: string, resources: EchoInkResource[]): NativeResourceSnapshot["resources"] {
  const source = nativeResourceSourceForBackend(backendId);
  return resources
    .filter((resource) => resource.source === source)
    .filter((resource) => resource.kind === "skill" || resource.kind === "mcp-server")
    .map((resource) => ({
      id: resource.id,
      type: resource.kind === "mcp-server" ? "mcp" as const : "skill" as const,
      name: resource.name || resource.id
    }));
}

function nativeResourceSourceForBackend(backendId: string): EchoInkResource["source"] | "" {
  if (backendId === "codex-cli") return "codex-import";
  if (backendId === "opencode") return "opencode-import";
  if (backendId === "hermes") return "hermes-import";
  return "";
}

function nativeExecutionRefForRuntime(
  backendId: string,
  nativeId: string,
  context?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">
): NativeExecutionRef {
  return {
    backendId,
    id: nativeId,
    kind: nativeExecutionKindForRuntime(backendId),
    persistence: nativeExecutionPersistenceForRuntime(backendId),
    providerEndpoint: context?.providerEndpoint,
    deviceKey: context?.deviceKey ?? "unknown",
    vaultId: context?.vaultId ?? "unknown",
    createdAt: Date.now()
  };
}

function nativeRefContextMismatch(
  ref: NativeExecutionRef,
  context?: Pick<NativeExecutionRef, "deviceKey" | "vaultId" | "providerEndpoint">
): string {
  if (!context) return "Native execution context is unavailable";
  if (ref.deviceKey !== context.deviceKey) return "Native execution belongs to another device";
  if (ref.vaultId !== context.vaultId) return "Native execution belongs to another Vault";
  if ((ref.providerEndpoint ?? "") !== (context.providerEndpoint ?? "")) return "Native execution belongs to another provider endpoint";
  return "";
}

function nativeExecutionKindForRuntime(backendId: string): NativeExecutionKind {
  return backendId === "opencode" ? "session" : backendId === "hermes" ? "run" : "run";
}

function nativeExecutionPersistenceForRuntime(backendId: string): NativeExecutionPersistence {
  if (backendId === "opencode") return "provider-persistent";
  if (backendId === "hermes") return "unknown";
  return "unknown";
}

function legacyTaskRuntimeCapabilities(backendId: string): AgentCapabilities {
  return {
    ...noCapabilities(),
    sessions: { resume: backendId === "opencode" ? "native" : "emulated", fork: "none" },
    output: {
      streaming: backendId === "hermes" ? "native" : "emulated",
      reasoningSummary: "none",
      thinkingTrace: backendId === "hermes" ? "native" : "none",
      planEvents: "emulated",
      usage: "emulated"
    },
    tools: { structuredCalls: "none", nativeMcp: "none", nativeSkills: "none", approvals: "emulated" },
    files: { read: "emulated", write: "emulated", diffEvents: "none" },
    input: { text: "native", image: "emulated", pdf: "emulated" },
    cancellation: "emulated"
  };
}
