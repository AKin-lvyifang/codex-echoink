import { noCapabilities } from "../../contracts/capability";
import type { HarnessEventSink } from "../../contracts/event";
import type { NativeExecutionDispositionRequest, NativeExecutionDispositionResult, NativeExecutionRef } from "../../contracts/native-execution";
import type { AgentAdapter, AgentConnectContext, AgentConnectionStatus, AgentManifest, AgentRunRequest, AgentRunResult } from "../adapter";

export interface FakeAgentAdapterOptions {
  backendId: string;
  responseText: string;
  nativeSessionId?: string;
  nativeExecution?: NativeExecutionRef;
  resumeCapability?: "native" | "emulated" | "none";
  onDisposeNativeExecution?: (request: NativeExecutionDispositionRequest) => NativeExecutionDispositionResult | Promise<NativeExecutionDispositionResult>;
  onRun?: (request: AgentRunRequest) => void;
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest;

  constructor(private readonly options: FakeAgentAdapterOptions) {
    this.manifest = {
      id: options.backendId,
      displayName: "Fake Agent",
      version: "test",
      capabilities: {
        ...noCapabilities(),
        sessions: {
          resume: options.resumeCapability ?? (options.nativeSessionId || options.nativeExecution?.kind === "session" || options.nativeExecution?.kind === "thread" ? "native" : "emulated"),
          fork: "none"
        },
        output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "emulated" },
        input: { text: "native", image: "none", pdf: "none" },
        cancellation: "emulated"
      },
      nativeExecution: {
        persistence: options.nativeExecution?.persistence ?? "process-local",
        dispositions: {
          processExit: true,
          archive: false,
          delete: false
        },
        idempotentDisposition: true,
        canInspectExistence: false
      }
    };
  }

  async connect(_context: AgentConnectContext): Promise<AgentConnectionStatus> {
    return {
      connected: true,
      label: this.manifest.displayName,
      version: this.manifest.version,
      errors: []
    };
  }

  async dispose(): Promise<void> {
    return undefined;
  }

  async listModels(): Promise<Array<{ id: string; displayName: string }>> {
    return [{ id: "fake-model", displayName: "Fake Model" }];
  }

  async disposeNativeExecution(request: NativeExecutionDispositionRequest): Promise<NativeExecutionDispositionResult> {
    if (this.options.onDisposeNativeExecution) return await this.options.onDisposeNativeExecution(request);
    return {
      outcome: "disposed",
      applied: request.requested
    };
  }

  async run(request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
    this.options.onRun?.(request);
    await emit({
      eventId: "",
      runId: "",
      sequence: 0,
      createdAt: 0,
      source: "agent",
      type: "agent.message.delta",
      backendId: this.manifest.id,
      text: this.options.responseText
    });
    await emit({
      eventId: "",
      runId: "",
      sequence: 0,
      createdAt: 0,
      source: "agent",
      type: "agent.message.completed",
      backendId: this.manifest.id,
      text: this.options.responseText
    });
    return {
      status: "completed",
      outputText: this.options.responseText,
      nativeExecution: this.options.nativeExecution,
      nativeSessionId: this.options.nativeSessionId
    };
  }

  async cancel(_runId: string): Promise<void> {
    return undefined;
  }
}
