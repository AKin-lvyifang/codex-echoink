import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { ContextManifest, ContextSection } from "../contracts/context";
import type { HarnessEvent, HarnessEventSink, HarnessEventSource, HarnessEventType } from "../contracts/event";
import type { BackendSessionBinding, HarnessRunRequest, HarnessRunResult } from "../contracts/run";
import type { AgentAdapter, AgentRunResult } from "../agents/adapter";
import type { NativeExecutionKind, NativeExecutionRef, NativeSessionLease } from "../contracts/native-execution";
import type { RunLedger } from "../ledger/run-ledger";
import type { MemoryProvider } from "../memory/provider";
import { resolveResourceContext } from "../resources/resource-resolver";
import { compileContextBundle } from "./context-compiler";
import { NativeSessionLeaseManager, type NativeSessionLeaseLimits } from "./native-session-lease-manager";
import { sessionBackendBinding } from "./session-service";

export type RunTerminalStatus = "completed" | "failed" | "cancelled";

export interface SettleRunTerminalInput {
  runId: string;
  status: RunTerminalStatus;
  backendId?: string;
  text?: string;
  error?: string;
}

export interface AppendRunEventInput {
  runId: string;
  source: HarnessEventSource;
  type: HarnessEventType;
  backendId?: string;
  text?: string;
  title?: string;
  status?: string;
  toolName?: string;
  resourceId?: string;
  error?: string;
  data?: Record<string, unknown>;
  createdAt?: number;
}

export interface RunOrchestratorOptions {
  adapters: AgentAdapter[];
  ledger: RunLedger;
  memoryProvider: MemoryProvider;
  sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null;
  corePolicySections?: ContextSection[];
  maxResourceBytes?: number;
  nativeSessionLeaseManager?: NativeSessionLeaseManager;
  now?: () => number;
}

export interface RunOrchestratorRunOptions {
  sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null;
}

interface RunLane {
  commitTail: Promise<void>;
  deliveryTail: Promise<void>;
  pendingCommits: number;
  pendingDeliveries: number;
  loaded: boolean;
  nextSequence: number;
  terminal: HarnessEvent | null;
}

type RunDeliveryResult =
  | { delivered: true }
  | { delivered: false; error: unknown };

interface AdapterRunStart {
  terminal: HarnessRunResult | null;
  result: Promise<AgentRunResult> | null;
  releaseTerminalEvents(): Promise<void>;
}

export class RunOrchestrator {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly runOwners = new Map<string, AgentAdapter>();
  private readonly cancelRequestedRuns = new Set<string>();
  private readonly leaseManager: NativeSessionLeaseManager;
  private readonly runLanes = new Map<string, RunLane>();
  private readonly runStarts = new Map<string, Promise<HarnessRunResult>>();
  private readonly now: () => number;

  constructor(private readonly options: RunOrchestratorOptions) {
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.manifest.id, adapter);
    }
    this.leaseManager = options.nativeSessionLeaseManager ?? new NativeSessionLeaseManager();
    this.now = options.now ?? Date.now;
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.manifest.id, adapter);
  }

  async appendRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    return await this.commitRunEvent(input, sink);
  }

  async settleRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<void> {
    await this.appendTerminalEvent(input, { sink });
  }

  async run(request: HarnessRunRequest, sink: HarnessEventSink = () => undefined, runOptions: RunOrchestratorRunOptions = {}): Promise<HarnessRunResult> {
    const existingStart = this.runStarts.get(request.runId);
    if (existingStart) return await existingStart;

    const start = this.executeRun(request, sink, runOptions);
    this.runStarts.set(request.runId, start);
    try {
      const result = await start;
      if (result.status !== "running" && this.runStarts.get(request.runId) === start) {
        this.runStarts.delete(request.runId);
      }
      return result;
    } catch (error) {
      if (this.runStarts.get(request.runId) === start) this.runStarts.delete(request.runId);
      throw error;
    }
  }

  private async executeRun(request: HarnessRunRequest, sink: HarnessEventSink, runOptions: RunOrchestratorRunOptions): Promise<HarnessRunResult> {
    const existingTerminal = await this.readTerminalResult(request.runId);
    if (existingTerminal) return existingTerminal;

    const emit = async (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }): Promise<HarnessEvent> => {
      return await this.appendRunEvent({
        runId: event.runId || request.runId,
        source: event.source,
        type: event.type,
        backendId: event.backendId,
        text: event.text,
        title: event.title,
        status: event.status,
        toolName: event.toolName,
        resourceId: event.resourceId,
        error: event.error,
        data: event.data,
        createdAt: event.createdAt
      }, sink);
    };
    const emitTerminal = async (terminal: Omit<SettleRunTerminalInput, "runId">): Promise<HarnessEvent> => {
      return await this.appendTerminalEvent({ runId: request.runId, ...terminal }, { sink });
    };

    const adapter = this.adapters.get(request.backendId);
    if (!adapter) {
      await emit({ type: "run.created", source: "kernel" });
      const message = `Unknown agent adapter: ${request.backendId}`;
      await emitTerminal({ status: "failed", error: message });
      return { runId: request.runId, status: "failed", error: message };
    }
    this.runOwners.set(request.runId, adapter);
    let keepOwner = false;
    const settleRequestedCancellation = async (): Promise<HarnessRunResult | null> => {
      const terminal = await this.readTerminalResult(request.runId);
      if (terminal) return terminal;
      if (this.cancelRequestedRuns.has(request.runId)) {
        const error = "Run cancelled";
        const cancelled = await emitTerminal({ status: "cancelled", backendId: adapter.manifest.id, error });
        return resultFromTerminalEvent(cancelled);
      }
      if (this.runOwners.has(request.runId)) return null;
      return await this.readTerminalResult(request.runId);
    };
    try {

      await emit({ type: "run.created", source: "kernel" });
      await emit({ type: "run.started", source: "kernel", backendId: adapter.manifest.id });
      await emit({ type: "agent.connecting", source: "agent", backendId: adapter.manifest.id });
      const connection = await adapter.connect({
        runId: request.runId,
        sessionId: request.sessionId,
        workspace: request.workspace
      });
      const cancelledAfterConnect = await settleRequestedCancellation();
      if (cancelledAfterConnect) return cancelledAfterConnect;
      await emit({
        type: "agent.connected",
        source: "agent",
        backendId: adapter.manifest.id,
        title: connection.label,
        data: { version: connection.version, errors: connection.errors }
      });

      const memory = await this.options.memoryProvider.retrieve({
        runId: request.runId,
        sessionId: request.sessionId,
        workspace: request.workspace,
        query: request.input.text,
        maxItems: request.memoryPolicy.maxItems
      });
      const cancelledAfterMemory = await settleRequestedCancellation();
      if (cancelledAfterMemory) return cancelledAfterMemory;
      const session = await this.resolveSession(request, runOptions.sessionProvider);
      const cancelledAfterSession = await settleRequestedCancellation();
      if (cancelledAfterSession) return cancelledAfterSession;
      let binding = sessionBackendBinding(session, request.backendId);
      const decisionNow = this.now();
      let leaseDecision = this.leaseManager.decide({
        request,
        binding,
        lease: leaseFromBinding(binding, request, decisionNow),
        sessionRevision: session.revision ?? 1,
        latestMessageId: lastMessageId(session.messages),
        requiresCatchUp: hasMessagesFromOtherBackendAfterCursor(session.messages, binding, request.backendId),
        now: decisionNow
      });
      const initialLeaseDecision = leaseDecision;
      const preparation = await adapter.prepareNativeSession?.({
        runId: request.runId,
        sessionId: request.sessionId,
        binding,
        action: !binding ? "none" : leaseDecision.reusable ? "resume" : "reset",
        reason: leaseDecision.reason
      });
      const cancelledAfterPreparation = await settleRequestedCancellation();
      if (cancelledAfterPreparation) return cancelledAfterPreparation;
      if (preparation?.status === "failed") {
        await emit({
          type: "agent.native_lease.recovery_failed",
          source: "agent",
          backendId: adapter.manifest.id,
          error: preparation.error,
          data: {
            reason: initialLeaseDecision.reason,
            leaseId: binding?.leaseId,
            nativeExecutionId: preparation.nativeExecutionId
          }
        });
        binding = null;
        leaseDecision = this.leaseManager.decide({
          request,
          binding: null,
          sessionRevision: session.revision ?? 1,
          latestMessageId: lastMessageId(session.messages),
          now: decisionNow
        });
      } else if (preparation?.status === "reset") {
        binding = null;
        leaseDecision = this.leaseManager.decide({
          request,
          binding: null,
          sessionRevision: session.revision ?? 1,
          latestMessageId: lastMessageId(session.messages),
          now: decisionNow
        });
      } else if (leaseDecision.reusable && adapter.manifest.capabilities.sessions.resume !== "native") {
        binding = null;
        leaseDecision = this.leaseManager.decide({
          request,
          binding: null,
          sessionRevision: session.revision ?? 1,
          latestMessageId: lastMessageId(session.messages),
          now: decisionNow
        });
      }
      if (leaseDecision.reusable) {
        await emit({
          type: "agent.native_lease.reused",
          source: "agent",
          backendId: adapter.manifest.id,
          data: {
            mode: leaseDecision.mode,
            reason: leaseDecision.reason,
            leaseId: binding?.leaseId
          }
        });
      } else if (leaseInvalidated(initialLeaseDecision.reason)) {
        await emit({
          type: "agent.native_lease.expired",
          source: "agent",
          backendId: adapter.manifest.id,
          data: {
            reason: initialLeaseDecision.reason,
            leaseId: sessionBackendBinding(session, request.backendId)?.leaseId
          }
        });
      }
      const context = compileContextBundle({
        runId: request.runId,
        session,
        backendId: request.backendId,
        workflow: request.workflow,
        userInput: request.input,
        memory,
        corePolicySections: this.options.corePolicySections ?? [],
        vaultProfileSections: request.vaultProfileSections,
        mode: leaseDecision.mode,
        cursor: leaseDecision.cursor,
        sessionRevision: session.revision ?? 1,
        now: this.now()
      });
      const resourceContext = await resolveResourceContext({
        workspace: request.workspace,
        backendId: request.backendId,
        selection: request.resourceSelection,
        maxSkillBytes: this.options.maxResourceBytes ?? 200_000
      });
      const cancelledAfterResources = await settleRequestedCancellation();
      if (cancelledAfterResources) return cancelledAfterResources;
      context.echoInkSkills = resourceContext.echoInkSkills;
      context.nativeResourceHints = resourceContext.nativeResourceHints;
      if (context.memoryContext.length) {
        await emit({
          type: "session.context.bootstrap.compiled",
          source: "kernel",
          backendId: adapter.manifest.id,
          data: {
            mode: context.manifest?.mode,
            sessionRevision: context.manifest?.sessionRevision,
            sections: context.manifest?.sections ?? [],
            memorySectionCount: context.memoryContext.length
          }
        });
      }

      const start = await this.startAdapterRun(request, adapter, context, binding, emit);
      if (start.terminal) return start.terminal;
      const result = await start.result!;
      if (this.cancelRequestedRuns.has(request.runId)) {
        const cancelledAfterRun = await settleRequestedCancellation();
        await start.releaseTerminalEvents();
        if (cancelledAfterRun) return cancelledAfterRun;
      }

      if (result.status === "running") {
        if (result.nativeExecution) await emitNativeExecutionCreated(emit, adapter.manifest.id, result.nativeExecution);
        const backendBinding = buildBackendBinding(adapter, request, result, context.manifest, binding, this.now(), this.leaseManager.limits, leaseDecision.reusable);
        await emitNativeLeaseCreatedIfNeeded(emit, adapter.manifest.id, backendBinding, leaseDecision.mode, leaseDecision.reusable);
        await start.releaseTerminalEvents();
        const settledAfterLease = await this.readTerminalResult(request.runId);
        if (settledAfterLease) {
          return {
            ...settledAfterLease,
            nativeExecution: result.nativeExecution,
            backendBinding,
            contextManifest: context.manifest,
            effectiveModel: result.effectiveModel
          };
        }
        keepOwner = true;
        return {
          runId: request.runId,
          status: "running",
          outputText: result.outputText,
          nativeExecution: result.nativeExecution,
          backendBinding,
          contextManifest: context.manifest,
          effectiveModel: result.effectiveModel
        };
      }

      if (result.status === "completed") {
        if (result.nativeExecution) await emitNativeExecutionCreated(emit, adapter.manifest.id, result.nativeExecution);
        const backendBinding = buildBackendBinding(adapter, request, result, context.manifest, binding, this.now(), this.leaseManager.limits, leaseDecision.reusable);
        await emitNativeLeaseCreatedIfNeeded(emit, adapter.manifest.id, backendBinding, leaseDecision.mode, leaseDecision.reusable);
        await start.releaseTerminalEvents();
        const terminal = await emitTerminal({ status: "completed", backendId: adapter.manifest.id, text: result.outputText });
        if (terminal.type !== "run.completed") return resultFromTerminalEvent(terminal);
        return {
          runId: request.runId,
          status: "completed",
          outputText: result.outputText,
          nativeExecution: result.nativeExecution,
          backendBinding,
          contextManifest: context.manifest,
          effectiveModel: result.effectiveModel
        };
      }

      if (result.status === "cancelled") {
        await start.releaseTerminalEvents();
        const terminal = await emitTerminal({ status: "cancelled", backendId: adapter.manifest.id, error: result.error });
        return resultFromTerminalEvent(terminal);
      }

      await start.releaseTerminalEvents();
      const terminal = await emitTerminal({ status: "failed", backendId: adapter.manifest.id, error: result.error });
      return resultFromTerminalEvent(terminal);
    } catch (error) {
      const existingTerminal = await this.readTerminalResult(request.runId);
      if (existingTerminal) return existingTerminal;
      const cancelled = this.cancelRequestedRuns.has(request.runId);
      const message = error instanceof Error ? error.message : String(error);
      const terminal = await emitTerminal({
        status: cancelled ? "cancelled" : "failed",
        backendId: adapter.manifest.id,
        error: message
      });
      return resultFromTerminalEvent(terminal);
    } finally {
      if (!keepOwner) this.releaseRun(request.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.cancelRequestedRuns.add(runId);
    const owner = this.runOwners.get(runId);
    if (typeof owner?.cancel === "function") await owner.cancel(runId);
  }

  private async resolveSession(
    request: HarnessRunRequest,
    sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null
  ): Promise<StoredSession> {
    const provided = await (sessionProvider ?? this.options.sessionProvider)?.(request.sessionId);
    if (provided) return provided;
    return {
      id: request.sessionId,
      title: request.workflow,
      cwd: request.workspace.cwd,
      messages: [],
      createdAt: this.now(),
      updatedAt: this.now()
    };
  }

  private async readTerminalResult(runId: string): Promise<HarnessRunResult | null> {
    return await this.enqueueRunCommit(runId, async (lane) => {
      await this.ensureRunLaneLoaded(runId, lane);
      return lane.terminal ? resultFromTerminalEvent(lane.terminal) : null;
    });
  }

  private async appendTerminalEvent(
    input: SettleRunTerminalInput,
    options: { sink?: HarnessEventSink } = {}
  ): Promise<HarnessEvent> {
    return await this.commitRunEvent({
      runId: input.runId,
      source: "kernel",
      type: terminalEventType(input.status),
      backendId: input.backendId,
      text: input.text,
      error: input.error
    }, options.sink);
  }

  private async commitRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    return await this.enqueueRunCommit(input.runId, async (lane) => {
      await this.ensureRunLaneLoaded(input.runId, lane);
      if (lane.terminal && !isPostTerminalLifecycleEventType(input.type)) return lane.terminal;
      const event = createRunEvent(input, lane.nextSequence, this.now);
      await this.options.ledger.append(event);
      lane.nextSequence = event.sequence + 1;
      this.scheduleRunDelivery(input.runId, lane, event, sink);
      if (isTerminalRunEventType(event.type)) {
        lane.terminal = event;
        this.releaseRun(input.runId);
      }
      return event;
    });
  }

  private async startAdapterRun(
    request: HarnessRunRequest,
    adapter: AgentAdapter,
    context: ReturnType<typeof compileContextBundle>,
    binding: BackendSessionBinding | null,
    emit: (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }) => Promise<HarnessEvent>
  ): Promise<AdapterRunStart> {
    const bufferedTerminalEvents: Array<Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }> = [];
    let terminalEventsReleased = false;
    const emitAdapterEvent = async (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }): Promise<void> => {
      const normalized = { ...event, source: event.source || "agent", backendId: event.backendId || adapter.manifest.id };
      if (!terminalEventsReleased && isTerminalRunEventType(normalized.type)) {
        bufferedTerminalEvents.push(normalized);
        return;
      }
      await emit(normalized);
    };
    const releaseTerminalEvents = async (): Promise<void> => {
      terminalEventsReleased = true;
      while (bufferedTerminalEvents.length) {
        await emit(bufferedTerminalEvents.shift()!);
      }
    };

    return await this.enqueueRunCommit(request.runId, async (lane) => {
      await this.ensureRunLaneLoaded(request.runId, lane);
      if (lane.terminal) {
        return { terminal: resultFromTerminalEvent(lane.terminal), result: null, releaseTerminalEvents };
      }

      this.runOwners.set(request.runId, adapter);
      const result = adapter.run({
        runId: request.runId,
        sessionId: request.sessionId,
        workflow: request.workflow,
        nativeSessionId: binding?.nativeSessionId,
        input: request.input,
        permissions: request.permissions,
        resources: request.resourceSelection,
        context,
        outputContract: request.outputContract
      }, emitAdapterEvent);
      return { terminal: null, result, releaseTerminalEvents };
    });
  }

  private async enqueueRunCommit<T>(runId: string, operation: (lane: RunLane) => Promise<T>): Promise<T> {
    const lane = this.getRunLane(runId);
    lane.pendingCommits += 1;
    const current = lane.commitTail
      .catch(() => undefined)
      .then(() => operation(lane));
    lane.commitTail = current.then(() => undefined, () => undefined);
    try {
      return await current;
    } finally {
      lane.pendingCommits -= 1;
      this.reclaimRunLane(runId, lane);
    }
  }

  private async ensureRunLaneLoaded(runId: string, lane: RunLane): Promise<void> {
    if (lane.loaded) return;
    const existing = await this.options.ledger.readRun(runId);
    lane.loaded = true;
    lane.nextSequence = nextSequence(existing);
    lane.terminal = existing.reduce<HarnessEvent | null>((latest, event) => {
      if (!isTerminalRunEventType(event.type)) return latest;
      if (!latest || event.sequence >= latest.sequence) return event;
      return latest;
    }, null);
  }

  private scheduleRunDelivery(runId: string, lane: RunLane, event: HarnessEvent, sink?: HarnessEventSink): void {
    if (!sink) return;
    lane.pendingDeliveries += 1;
    const delivery = lane.deliveryTail.then(async () => {
      await sink(event);
    });
    const controlled = delivery.then<RunDeliveryResult, RunDeliveryResult>(
      () => ({ delivered: true }),
      (error: unknown) => ({ delivered: false, error })
    );
    lane.deliveryTail = controlled.then(() => {
      lane.pendingDeliveries -= 1;
      this.reclaimRunLane(runId, lane);
    });
  }

  private getRunLane(runId: string): RunLane {
    let lane = this.runLanes.get(runId);
    if (!lane) {
      lane = {
        commitTail: Promise.resolve(),
        deliveryTail: Promise.resolve(),
        pendingCommits: 0,
        pendingDeliveries: 0,
        loaded: false,
        nextSequence: 1,
        terminal: null
      };
      this.runLanes.set(runId, lane);
    }
    return lane;
  }

  private reclaimRunLane(runId: string, lane: RunLane): void {
    if (!lane.terminal || lane.pendingCommits > 0 || lane.pendingDeliveries > 0) return;
    if (this.runLanes.get(runId) === lane) this.runLanes.delete(runId);
  }

  private releaseRun(runId: string): void {
    this.runOwners.delete(runId);
    this.cancelRequestedRuns.delete(runId);
    this.runStarts.delete(runId);
  }
}

async function emitNativeExecutionCreated(
  emit: (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }) => Promise<HarnessEvent>,
  backendId: string,
  nativeExecution: NativeExecutionRef
): Promise<void> {
  await emit({
    type: "agent.native_execution.created",
    source: "agent",
    backendId,
    data: {
      kind: nativeExecution.kind,
      persistence: nativeExecution.persistence
    }
  });
}

async function emitNativeLeaseCreatedIfNeeded(
  emit: (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }) => Promise<HarnessEvent>,
  backendId: string,
  binding: BackendSessionBinding,
  mode: ContextManifest["mode"],
  reused: boolean
): Promise<void> {
  if (reused || !binding.leaseId) return;
  await emit({
    type: "agent.native_lease.created",
    source: "agent",
    backendId,
    data: {
      mode,
      leaseId: binding.leaseId,
      nativeExecutionKind: binding.nativeExecutionKind
    }
  });
}

function buildBackendBinding(
  adapter: AgentAdapter,
  request: HarnessRunRequest,
  result: AgentRunResult,
  manifest: ContextManifest | undefined,
  previousBinding: BackendSessionBinding | null,
  lastUsedAt: number,
  leaseLimits: NativeSessionLeaseLimits,
  reusePreviousLease: boolean
): BackendSessionBinding {
  const nativeSessionId = result.nativeSessionId || (result.nativeExecution?.kind === "session" ? result.nativeExecution.id : undefined);
  const nativeThreadId = result.nativeThreadId || (result.nativeExecution?.kind === "thread" ? result.nativeExecution.id : undefined);
  const leaseId = leaseIdForResult(request, adapter.manifest.id, result, previousBinding, reusePreviousLease, lastUsedAt);
  const continuingLease = Boolean(leaseId && reusePreviousLease && previousBinding?.leaseId === leaseId);
  const contextChars = manifestIncludedChars(manifest);
  const leaseCreatedAt = continuingLease ? previousBinding?.leaseCreatedAt ?? previousBinding?.lastUsedAt ?? lastUsedAt : lastUsedAt;
  const previousContextChars = continuingLease ? previousBinding?.leaseContextChars ?? 0 : 0;
  const leaseMaxTurns = continuingLease ? previousBinding?.leaseMaxTurns ?? leaseLimits.maxTurns : leaseLimits.maxTurns;
  const leaseMaxContextChars = continuingLease ? previousBinding?.leaseMaxContextChars ?? leaseLimits.maxContextChars : leaseLimits.maxContextChars;
  return {
    backendId: adapter.manifest.id,
    nativeSessionId,
    nativeThreadId,
    ...(result.nativeExecution?.kind ? { nativeExecutionKind: result.nativeExecution.kind } : {}),
    ...(result.nativeExecution
      ? { nativeExecutionRef: result.nativeExecution }
      : continuingLease && previousBinding?.nativeExecutionRef
        ? { nativeExecutionRef: previousBinding.nativeExecutionRef }
        : {}),
    ...(leaseId ? {
      leaseId,
      leaseStatus: "active" as const,
      leaseCreatedAt,
      leaseLastUsedAt: lastUsedAt,
      leaseExpiresAt: lastUsedAt + leaseLimits.ttlMs,
      leaseTurnCount: (continuingLease ? previousBinding?.leaseTurnCount ?? 0 : 0) + 1,
      leaseMaxTurns,
      leaseContextChars: previousContextChars + contextChars,
      leaseMaxContextChars,
      contextCheckpointMessageId: manifest?.compiledThroughMessageId
    } : {}),
    syncedThroughMessageId: manifest?.compiledThroughMessageId,
    syncedSessionRevision: manifest?.sessionRevision ?? 1,
    snapshotVersion: manifest?.snapshotVersion,
    contextCursor: {
      syncedThroughMessageId: manifest?.compiledThroughMessageId,
      syncedSessionRevision: manifest?.sessionRevision ?? 1,
      snapshotVersion: manifest?.snapshotVersion
    },
    lastUsedAt,
    capabilitySnapshot: adapter.manifest.capabilities
  };
}

function leaseFromBinding(binding: BackendSessionBinding | null, request: HarnessRunRequest, now: number): NativeSessionLease | null {
  if (!binding?.leaseId) return null;
  const native = nativeExecutionFromBinding(binding, request, now);
  if (!native) return null;
  return {
    leaseId: binding.leaseId,
    echoInkSessionId: request.sessionId,
    backendId: binding.backendId,
    native,
    mode: "leased-conversation",
    status: binding.leaseStatus ?? "active",
    createdAt: binding.leaseCreatedAt ?? binding.lastUsedAt,
    lastUsedAt: binding.leaseLastUsedAt ?? binding.lastUsedAt,
    expiresAt: binding.leaseExpiresAt ?? Number.MAX_SAFE_INTEGER,
    turnCount: binding.leaseTurnCount ?? 0,
    maxTurns: binding.leaseMaxTurns ?? 20,
    contextCheckpointMessageId: binding.contextCheckpointMessageId ?? binding.syncedThroughMessageId,
    contextChars: binding.leaseContextChars,
    maxContextChars: binding.leaseMaxContextChars
  };
}

function nativeExecutionFromBinding(binding: BackendSessionBinding, request: HarnessRunRequest, now: number): NativeExecutionRef | null {
  const id = binding.nativeThreadId ?? binding.nativeSessionId;
  if (!id) return null;
  if (binding.nativeExecutionRef?.id === id && binding.nativeExecutionRef.backendId === binding.backendId) {
    return binding.nativeExecutionRef;
  }
  const kind: NativeExecutionKind = binding.nativeExecutionKind ?? (binding.nativeThreadId ? "thread" : "session");
  return {
    backendId: binding.backendId,
    id,
    kind,
    persistence: "provider-persistent",
    deviceKey: "local",
    vaultId: request.workspace.vaultPath,
    createdAt: binding.lastUsedAt || now
  };
}

function hasMessagesFromOtherBackendAfterCursor(messages: ChatMessage[], binding: BackendSessionBinding | null, backendId: string): boolean {
  if (!binding?.contextCursor?.syncedThroughMessageId) return false;
  return messagesAfter(messages, binding.contextCursor.syncedThroughMessageId).some((message) => {
    const messageBackend = (message as ChatMessage & { backendId?: string }).backendId;
    return Boolean(messageBackend && messageBackend !== backendId);
  });
}

function messagesAfter(messages: ChatMessage[], messageId: string): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  return messages.slice(index + 1);
}

function lastMessageId(messages: ChatMessage[]): string | undefined {
  return messages.length ? messages[messages.length - 1].id : undefined;
}

function leaseIdForResult(
  request: HarnessRunRequest,
  backendId: string,
  result: AgentRunResult,
  previousBinding: BackendSessionBinding | null,
  reusePreviousLease: boolean,
  createdAt: number
): string | undefined {
  if (request.workflow === "prompt.enhance") return undefined;
  if (request.surface !== "chat" && request.workflow !== "knowledge.ask") return undefined;
  const nativeId = result.nativeExecution?.id ?? result.nativeSessionId ?? result.nativeThreadId;
  if (!nativeId) return undefined;
  if (reusePreviousLease && previousBinding?.leaseId) return previousBinding.leaseId;
  return `lease-${request.sessionId}:${backendId}:${nativeId}:${createdAt}`;
}

function leaseInvalidated(reason: string): boolean {
  return reason === "expired" || reason === "max-turns" || reason === "context-capacity";
}

function manifestIncludedChars(manifest: ContextManifest | undefined): number {
  return manifest?.sections.reduce((sum, section) => sum + section.includedChars, 0) ?? 0;
}

function isTerminalRunEventType(type: HarnessEventType): type is "run.completed" | "run.failed" | "run.cancelled" {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
}

function isPostTerminalLifecycleEventType(type: HarnessEventType): boolean {
  return type === "run.local_commit.started"
    || type === "run.local_commit.completed"
    || type === "run.local_commit.failed"
    || type === "agent.native_cleanup.scheduled"
    || type === "agent.native_cleanup.started"
    || type === "agent.native_cleanup.completed"
    || type === "agent.native_cleanup.unsupported"
    || type === "agent.native_cleanup.failed"
    || type === "agent.native_cleanup.retained";
}

function resultFromTerminalEvent(event: HarnessEvent): HarnessRunResult {
  if (event.type === "run.completed") {
    return { runId: event.runId, status: "completed", outputText: event.text };
  }
  if (event.type === "run.cancelled") {
    return { runId: event.runId, status: "cancelled", error: event.error };
  }
  return { runId: event.runId, status: "failed", error: event.error };
}

function createRunEvent(input: AppendRunEventInput, sequence: number, now: () => number): HarnessEvent {
  return {
    eventId: `${input.runId}:${sequence}`,
    runId: input.runId,
    sequence,
    createdAt: input.createdAt || now(),
    source: input.source,
    type: input.type,
    backendId: input.backendId,
    text: input.text,
    title: input.title,
    status: input.status,
    toolName: input.toolName,
    resourceId: input.resourceId,
    error: input.error,
    data: input.data
  };
}

function nextSequence(events: HarnessEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
}

function terminalEventType(status: RunTerminalStatus): "run.completed" | "run.failed" | "run.cancelled" {
  switch (status) {
    case "completed":
      return "run.completed";
    case "failed":
      return "run.failed";
    case "cancelled":
      return "run.cancelled";
  }
}
