import type { AgentAdapter } from "../agents/adapter";
import type { HarnessEvent, HarnessEventSink } from "../contracts/event";
import type { HarnessRunRequest, HarnessRunResult } from "../contracts/run";
import type { RunLedger } from "../ledger/run-ledger";
import type { MemoryProvider } from "../memory/provider";
import type { ContextSection } from "../contracts/context";
import type { StoredSession } from "../../settings/settings";
import { RunOrchestrator, type AppendRunEventInput, type SettleRunTerminalInput } from "./run-orchestrator";

export interface EchoInkHarnessKernelOptions {
  ledger: RunLedger;
  memoryProvider: MemoryProvider;
  corePolicySections?: ContextSection[];
  maxResourceBytes?: number;
  now?: () => number;
  sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null;
}

export interface HarnessRunWithAdapterInput {
  adapter: AgentAdapter;
  request: HarnessRunRequest;
  sink?: HarnessEventSink;
  sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null;
}

export class EchoInkHarnessKernel {
  private readonly orchestrator: RunOrchestrator;

  constructor(private readonly options: EchoInkHarnessKernelOptions) {
    this.orchestrator = new RunOrchestrator({
      adapters: [],
      ledger: this.options.ledger,
      memoryProvider: this.options.memoryProvider,
      corePolicySections: this.options.corePolicySections,
      maxResourceBytes: this.options.maxResourceBytes,
      now: this.options.now,
      sessionProvider: this.options.sessionProvider
    });
  }

  async runWithAdapter(input: HarnessRunWithAdapterInput): Promise<HarnessRunResult> {
    this.orchestrator.registerAdapter(input.adapter);
    return await this.orchestrator.run(input.request, input.sink, { sessionProvider: input.sessionProvider });
  }

  async settleRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<void> {
    await this.orchestrator.settleRunTerminal(input, sink);
  }

  async appendRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    return await this.orchestrator.appendRunEvent(input, sink);
  }

  async cancelRun(runId: string): Promise<void> {
    await this.orchestrator.cancel(runId);
  }
}
