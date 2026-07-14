import { noCapabilities } from "../../contracts/capability";
import type { HarnessEventSink } from "../../contracts/event";
import type { AgentAdapter, AgentConnectContext, AgentConnectionStatus, AgentManifest, AgentRunRequest, AgentRunResult } from "../adapter";

export class FakeFourthAgentAdapter implements AgentAdapter {
  readonly manifest: AgentManifest = {
    id: "fake-fourth",
    displayName: "Fake Fourth Agent",
    version: "test",
    capabilities: {
      ...noCapabilities(),
      sessions: { resume: "emulated", fork: "none" },
      output: { streaming: "emulated", reasoningSummary: "none", thinkingTrace: "none", planEvents: "none", usage: "none" },
      input: { text: "native", image: "none", pdf: "none" },
      cancellation: "emulated"
    }
  };

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
    return [{ id: "fake-fourth-model", displayName: "Fake Fourth Model" }];
  }

  async run(_request: AgentRunRequest, emit: HarnessEventSink): Promise<AgentRunResult> {
    await emit({
      eventId: "",
      runId: "",
      sequence: 0,
      createdAt: 0,
      source: "agent",
      type: "agent.message.completed",
      backendId: this.manifest.id,
      text: "fake-fourth:pong"
    });
    return {
      status: "completed",
      outputText: "fake-fourth:pong",
      nativeSessionId: "fake-fourth-session"
    };
  }

  async cancel(_runId: string): Promise<void> {
    return undefined;
  }
}
