import type { ChatMessage, StoredSession } from "../../settings/settings";
import type { ContextManifest, ContextSection } from "../contracts/context";
import type { HarnessEvent, HarnessEventSink, HarnessEventSource, HarnessEventType } from "../contracts/event";
import type { BackendSessionBinding, HarnessRunRequest, HarnessRunResult } from "../contracts/run";
import {
  isAgentNativeSessionStaleError,
  type AgentAdapter,
  type AgentRunResult
} from "../agents/adapter";
import type { NativeExecutionKind, NativeExecutionRef, NativeSessionLease } from "../contracts/native-execution";
import {
  resolveRunLedgerAppendReadbackReceipt,
  type RunLedger
} from "../ledger/run-ledger";
import type { MemoryBundle, MemoryProvider } from "../memory/provider";
import { resolveResourceContext } from "../resources/resource-resolver";
import { compileContextBundle } from "./context-compiler";
import {
  NativeSessionLeaseManager,
  type NativeSessionLeaseDecision,
  type NativeSessionLeaseLimits
} from "./native-session-lease-manager";
import {
  messagesInCurrentSessionContext,
  sessionBackendBinding,
  sessionGeneration,
  vaultProfileFingerprint,
  workspaceFingerprint
} from "./session-service";

export type RunTerminalStatus = "completed" | "failed" | "cancelled";
export type RunTerminalAuthority = "kernel" | "surface";

export interface SettleRunTerminalInput {
  runId: string;
  status: RunTerminalStatus;
  backendId?: string;
  text?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export type BeforeSurfaceTerminalCommit = (
  winner: HarnessEvent
) => Promise<void>;

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
  /**
   * Adapter captured by the caller for this exact run. Dynamic callers must
   * pass it directly instead of publishing it through the backend registry,
   * because another same-backend run may register a different adapter while
   * this run is awaiting its ledger preflight.
   */
  adapter?: AgentAdapter;
  sessionProvider?: (sessionId: string) => Promise<StoredSession | null> | StoredSession | null;
  beforeBindingReplacement?: BeforeBindingReplacement;
  registerNativeExecution?: RegisterNativeExecution;
  /**
   * Persistent Chat owns its product terminal at the surface because the
   * Conversation must be durable before the Run Ledger terminal is appended.
   * Other workflows keep the historical kernel-owned behavior.
   */
  terminalAuthority?: RunTerminalAuthority;
}

export interface RegisterNativeExecutionInput {
  request: HarnessRunRequest;
  native: NativeExecutionRef;
}

export interface NativeExecutionRegistrationReceipt {
  recordId: string;
}

export type RegisterNativeExecution = (
  input: RegisterNativeExecutionInput
) => Promise<NativeExecutionRegistrationReceipt>;

export type NativeBindingReplacementReason =
  | "context-identity-missing"
  | "context-identity-mismatch"
  | "vault-profile-mismatch"
  | "revision-mismatch"
  | "no-lease"
  | "expired"
  | "max-turns"
  | "context-capacity"
  | "resume-failed"
  | "resume-reset"
  | "resume-unsupported";

export interface NativeBindingContextIdentity {
  workspaceFingerprint: string;
  sessionGeneration: number;
  contextId?: string;
}

export interface BeforeBindingReplacementInput {
  request: HarnessRunRequest;
  session: StoredSession;
  binding: BackendSessionBinding;
  reason: NativeBindingReplacementReason;
  expectedIdentity: NativeBindingContextIdentity;
}

export type BeforeBindingReplacement = (
  input: BeforeBindingReplacementInput
) => Promise<void>;

interface RunLane {
  commitTail: Promise<void>;
  deliveryTail: Promise<void>;
  pendingCommits: number;
  pendingDeliveries: number;
  loaded: boolean;
  events: HarnessEvent[];
  nextSequence: number;
  terminal: HarnessEvent | null;
  poisoned: Error | null;
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
  private readonly memoryObservationTails = new Map<string, Promise<void>>();
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

  async settleRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    const terminal = await this.appendTerminalEvent(input, { sink });
    if (isTerminalRunEventType(terminal.type)) {
      this.releaseRun(input.runId);
    }
    return terminal;
  }

  async commitSurfaceRunTerminal(
    input: SettleRunTerminalInput,
    beforeTerminalCommit: BeforeSurfaceTerminalCommit,
    sink?: HarnessEventSink
  ): Promise<HarnessEvent> {
    return await this.enqueueRunCommit(input.runId, async (lane) => {
      await this.ensureRunLaneLoaded(input.runId, lane);
      const existing = lane.terminal;
      const winner = existing ?? createRunEvent({
        runId: input.runId,
        source: "kernel",
        type: terminalEventType(input.status),
        backendId: input.backendId,
        text: input.text,
        error: input.error,
        data: input.data
      }, lane.nextSequence, this.now);
      await beforeTerminalCommit(winner);
      if (existing) return existing;

      await this.appendLedgerEventWithReceipt(input.runId, lane, winner);
      this.scheduleRunDelivery(input.runId, lane, winner, sink);
      lane.terminal = winner;
      this.releaseRun(input.runId);
      this.scheduleMemoryRunEvent(winner);
      return winner;
    });
  }

  async run(request: HarnessRunRequest, sink: HarnessEventSink = () => undefined, runOptions: RunOrchestratorRunOptions = {}): Promise<HarnessRunResult> {
    const existingStart = this.runStarts.get(request.runId);
    if (existingStart) return await existingStart;

    // Capture before executeRun reaches its first await. The registry is only a
    // default for statically configured orchestrators; per-run adapters are
    // immutable run input.
    const adapter = runOptions.adapter ?? this.adapters.get(request.backendId);
    const start = this.executeRun(request, adapter, sink, runOptions);
    this.runStarts.set(request.runId, start);
    try {
      const result = await start;
      const surfaceTerminalPending = runOptions.terminalAuthority === "surface"
        && result.status !== "running"
        && !await this.readTerminalResult(request.runId);
      if (
        result.status !== "running"
        && !surfaceTerminalPending
        && this.runStarts.get(request.runId) === start
      ) {
        this.runStarts.delete(request.runId);
      }
      return result;
    } catch (error) {
      if (this.runStarts.get(request.runId) === start) this.runStarts.delete(request.runId);
      throw error;
    }
  }

  private async executeRun(
    request: HarnessRunRequest,
    adapter: AgentAdapter | undefined,
    sink: HarnessEventSink,
    runOptions: RunOrchestratorRunOptions
  ): Promise<HarnessRunResult> {
    const existingTerminal = await this.readTerminalResult(request.runId);
    if (existingTerminal) return existingTerminal;
    const surfaceOwnsTerminal = runOptions.terminalAuthority === "surface";
    const nativeExecutionRecordIds = new Set<string>();
    const withNativeExecutionRecords = (
      result: HarnessRunResult
    ): HarnessRunResult => nativeExecutionRecordIds.size
      ? {
        ...result,
        nativeExecutionRecordIds: Array.from(nativeExecutionRecordIds)
      }
      : result;

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
    const settleExecutionTerminal = async (
      terminal: Omit<SettleRunTerminalInput, "runId">
    ): Promise<HarnessRunResult> => {
      if (surfaceOwnsTerminal) {
        return await this.readTerminalResult(request.runId)
          ?? resultFromTerminalInput(request.runId, terminal);
      }
      return resultFromTerminalEvent(
        await this.appendTerminalEvent(
          { runId: request.runId, ...terminal },
          { sink }
        )
      );
    };

    if (!adapter || adapter.manifest.id !== request.backendId) {
      await emit({ type: "run.created", source: "kernel" });
      const message = `Unknown agent adapter: ${request.backendId}`;
      return await settleExecutionTerminal({ status: "failed", error: message });
    }
    this.runOwners.set(request.runId, adapter);
    let keepOwner = false;
    const settleRequestedCancellation = async (): Promise<HarnessRunResult | null> => {
      const terminal = await this.readTerminalResult(request.runId);
      if (terminal) return terminal;
      if (this.cancelRequestedRuns.has(request.runId)) {
        const error = "Run cancelled";
        return await settleExecutionTerminal({
          status: "cancelled",
          backendId: adapter.manifest.id,
          error
        });
      }
      if (this.runOwners.has(request.runId)) return null;
      return await this.readTerminalResult(request.runId);
    };
    try {

      await emit({ type: "run.created", source: "kernel" });
      await emit({
        type: "run.started",
        source: "kernel",
        backendId: adapter.manifest.id,
        text: request.input.text,
        data: {
          sessionId: request.sessionId,
          surface: request.surface,
          workflow: request.workflow,
          attachments: request.input.attachments.map((attachment) => ({
            type: attachment.type,
            path: attachment.path,
            ...(attachment.name ? { name: attachment.name } : {}),
            ...(attachment.mime ? { mime: attachment.mime } : {})
          }))
        }
      });
      await this.beginMemoryRun(request);
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

      const memory: MemoryBundle = request.memoryPolicy.enabled
        ? await this.options.memoryProvider.retrieve({
          runId: request.runId,
          sessionId: request.sessionId,
          workspace: request.workspace,
          workflow: request.workflow,
          query: request.input.text,
          maxItems: request.memoryPolicy.maxItems
        })
        : { providerId: "disabled", items: [], sections: [] };
      const cancelledAfterMemory = await settleRequestedCancellation();
      if (cancelledAfterMemory) return cancelledAfterMemory;
      const session = await this.resolveSession(request, runOptions.sessionProvider);
      const cancelledAfterSession = await settleRequestedCancellation();
      if (cancelledAfterSession) return cancelledAfterSession;
      const persistentConversation = isPersistentConversationRun(request);
      const requestWorkspaceFingerprint = workspaceFingerprint(request.workspace);
      const durableWorkspaceFingerprint = session.workspaceFingerprint?.trim() ?? "";
      const expectedVaultProfileFingerprint = vaultProfileFingerprint(
        request.vaultProfileSections
      );
      if (
        persistentConversation
        && (
          !durableWorkspaceFingerprint
          || durableWorkspaceFingerprint !== requestWorkspaceFingerprint
        )
      ) {
        throw new Error(
          "Conversation recovery required: persistent run workspace does not match the durable Conversation identity"
        );
      }
      const storedBinding = sessionBackendBinding(session, request.backendId);
      let binding = storedBinding;
      const currentMessages = messagesInCurrentSessionContext(session);
      const expectedIdentity: NativeBindingContextIdentity = {
        workspaceFingerprint: durableWorkspaceFingerprint || requestWorkspaceFingerprint,
        sessionGeneration: sessionGeneration(session),
        ...(session.contextId?.trim() ? { contextId: session.contextId.trim() } : {})
      };
      const decisionNow = this.now();
      const decideBinding = (
        candidate: BackendSessionBinding | null
      ): NativeSessionLeaseDecision => this.leaseManager.decide({
        request,
        binding: candidate,
        lease: leaseFromBinding(candidate, request, decisionNow),
        expectedWorkspaceFingerprint: expectedIdentity.workspaceFingerprint,
        expectedSessionGeneration: expectedIdentity.sessionGeneration,
        expectedContextId: expectedIdentity.contextId,
        expectedVaultProfileFingerprint,
        sessionRevision: session.revision ?? 1,
        currentContextMessageIds: currentMessages.map((message) => message.id),
        latestMessageId: lastMessageId(currentMessages),
        requiresCatchUp: hasMessagesFromOtherBackendAfterCursor(
          currentMessages,
          candidate,
          request.backendId
        ),
        now: decisionNow
      });
      let leaseDecision = decideBinding(binding);
      const initialLeaseDecision = leaseDecision;
      const originalLegacyThreadId = session.threadId;
      if (binding?.leaseId && leaseDecision.reusable) {
        this.leaseManager.reserveLeaseForRun(request.runId, binding.leaseId);
      }

      if (leaseDecision.reason === "workflow") {
        binding = null;
        await adapter.prepareNativeSession?.({
          runId: request.runId,
          sessionId: request.sessionId,
          binding: null,
          action: "none",
          reason: leaseDecision.reason
        });
      } else if (binding && !leaseDecision.reusable) {
        const retiredBinding = binding;
        await this.retireBindingBeforeReplacement({
          request,
          session,
          binding: retiredBinding,
          reason: decisionReplacementReason(leaseDecision),
          expectedIdentity,
          hook: runOptions.beforeBindingReplacement
        });
        binding = null;
        assertCompleteBindingContextIdentity(expectedIdentity);
        const preparation = await adapter.prepareNativeSession?.({
          runId: request.runId,
          sessionId: request.sessionId,
          binding: retiredBinding,
          action: "reset",
          reason: leaseDecision.reason
        });
        if (preparation?.status === "failed") {
          throw new Error(
            preparation.error
              ? `Native session reset failed: ${preparation.error}`
              : "Native session reset failed"
          );
        }
        leaseDecision = decideBinding(null);
      } else if (
        binding
        && leaseDecision.reusable
        && adapter.manifest.capabilities.sessions.resume !== "native"
      ) {
        await this.retireBindingBeforeReplacement({
          request,
          session,
          binding,
          reason: "resume-unsupported",
          expectedIdentity,
          hook: runOptions.beforeBindingReplacement
        });
        binding = null;
        leaseDecision = decideBinding(null);
      } else if (
        binding
        && leaseDecision.reusable
        && adapter.prepareNativeSession
      ) {
        const preparation = await adapter.prepareNativeSession({
          runId: request.runId,
          sessionId: request.sessionId,
          binding,
          action: "resume",
          reason: leaseDecision.reason
        });
        if (preparation.status !== "resumed") {
          restoreBindingForRetirement(
            session,
            binding,
            originalLegacyThreadId
          );
          const replacementReason: NativeBindingReplacementReason = preparation.status === "failed"
            ? "resume-failed"
            : preparation.status === "reset"
              ? "resume-reset"
              : "resume-unsupported";
          if (preparation.status === "failed") {
            await emit({
              type: "agent.native_lease.recovery_failed",
              source: "agent",
              backendId: adapter.manifest.id,
              error: preparation.error,
              data: {
                reason: initialLeaseDecision.reason,
                leaseId: binding.leaseId,
                nativeExecutionId: preparation.nativeExecutionId
              }
            });
          }
          await this.retireBindingBeforeReplacement({
            request,
            session,
            binding,
            reason: replacementReason,
            expectedIdentity,
            hook: runOptions.beforeBindingReplacement
          });
          binding = null;
          leaseDecision = decideBinding(null);
        }
      } else {
        assertCompleteBindingContextIdentity(expectedIdentity);
        await adapter.prepareNativeSession?.({
          runId: request.runId,
          sessionId: request.sessionId,
          binding: null,
          action: "none",
          reason: leaseDecision.reason
        });
      }
      const cancelledAfterPreparation = await settleRequestedCancellation();
      if (cancelledAfterPreparation) return cancelledAfterPreparation;
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
            leaseId: storedBinding?.leaseId
          }
        });
      }
      const resourceContext = await resolveResourceContext({
        workspace: request.workspace,
        backendId: request.backendId,
        selection: request.resourceSelection,
        maxSkillBytes: this.options.maxResourceBytes ?? 200_000
      });
      const cancelledAfterResources = await settleRequestedCancellation();
      if (cancelledAfterResources) return cancelledAfterResources;
      const compileAndReportContext = async () => {
        const compiled = compileContextBundle({
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
        assertContextManifestIdentity(
          compiled.manifest,
          expectedIdentity,
          expectedVaultProfileFingerprint,
          persistentConversation
        );
        compiled.echoInkSkills = resourceContext.echoInkSkills;
        compiled.nativeResourceHints = resourceContext.nativeResourceHints;
        if (compiled.memoryContext.length) {
          await emit({
            type: "session.context.bootstrap.compiled",
            source: "kernel",
            backendId: adapter.manifest.id,
            data: {
              mode: compiled.manifest?.mode,
              sessionRevision: compiled.manifest?.sessionRevision,
              sections: compiled.manifest?.sections ?? [],
              memorySectionCount: compiled.memoryContext.length
            }
          });
        }
        return compiled;
      };
      let context = await compileAndReportContext();

      let start = await this.startAdapterRun(
        request,
        adapter,
        context,
        binding,
        emit,
        runOptions.registerNativeExecution,
        nativeExecutionRecordIds,
        surfaceOwnsTerminal
      );
      if (start.terminal) return withNativeExecutionRecords(start.terminal);
      let result: AgentRunResult;
      try {
        result = await start.result!;
      } catch (error) {
        if (
          !isAgentNativeSessionStaleError(error)
          || !persistentConversation
          || !binding
        ) {
          throw error;
        }
        const staleBinding = binding;
        await emit({
          type: "agent.native_lease.recovery_failed",
          source: "agent",
          backendId: adapter.manifest.id,
          error: error.message,
          data: {
            reason: "start-turn-missing",
            leaseId: staleBinding.leaseId,
            nativeExecutionId: error.nativeExecutionId
          }
        });
        await this.retireBindingBeforeReplacement({
          request,
          session,
          binding: staleBinding,
          reason: "resume-failed",
          expectedIdentity,
          hook: runOptions.beforeBindingReplacement
        });
        binding = null;
        leaseDecision = decideBinding(null);
        assertCompleteBindingContextIdentity(expectedIdentity);
        context = await compileAndReportContext();
        start = await this.startAdapterRun(
          request,
          adapter,
          context,
          null,
          emit,
          runOptions.registerNativeExecution,
          nativeExecutionRecordIds,
          surfaceOwnsTerminal
        );
        if (start.terminal) return withNativeExecutionRecords(start.terminal);
        result = await start.result!;
      }
      if (this.cancelRequestedRuns.has(request.runId)) {
        const cancelledAfterRun = await settleRequestedCancellation();
        await start.releaseTerminalEvents();
        if (cancelledAfterRun) {
          return withNativeExecutionRecords(cancelledAfterRun);
        }
      }

      if (result.status === "running") {
        if (result.nativeExecution) await emitNativeExecutionCreated(emit, adapter.manifest.id, result.nativeExecution);
        const backendBinding = leaseDecision.mode === "workflow"
          ? undefined
          : buildBackendBinding(adapter, request, result, context.manifest, expectedIdentity, expectedVaultProfileFingerprint, binding, this.now(), this.leaseManager.limits, leaseDecision.reusable);
        if (backendBinding) {
          if (backendBinding.leaseId) {
            this.leaseManager.reserveLeaseForRun(request.runId, backendBinding.leaseId);
          }
          await emitNativeLeaseCreatedIfNeeded(emit, adapter.manifest.id, backendBinding, leaseDecision.mode, leaseDecision.reusable);
        }
        await start.releaseTerminalEvents();
        const settledAfterLease = await this.readTerminalResult(request.runId);
        if (settledAfterLease) {
          return withNativeExecutionRecords({
            ...settledAfterLease,
            nativeExecution: result.nativeExecution,
            backendBinding,
            contextManifest: context.manifest,
            effectiveModel: result.effectiveModel
          });
        }
        keepOwner = true;
        return withNativeExecutionRecords({
          runId: request.runId,
          status: "running",
          outputText: result.outputText,
          nativeExecution: result.nativeExecution,
          backendBinding,
          contextManifest: context.manifest,
          effectiveModel: result.effectiveModel
        });
      }

      if (result.status === "completed") {
        if (result.nativeExecution) await emitNativeExecutionCreated(emit, adapter.manifest.id, result.nativeExecution);
        const backendBinding = leaseDecision.mode === "workflow"
          ? undefined
          : buildBackendBinding(adapter, request, result, context.manifest, expectedIdentity, expectedVaultProfileFingerprint, binding, this.now(), this.leaseManager.limits, leaseDecision.reusable);
        if (backendBinding) {
          if (backendBinding.leaseId) {
            this.leaseManager.reserveLeaseForRun(request.runId, backendBinding.leaseId);
          }
          await emitNativeLeaseCreatedIfNeeded(emit, adapter.manifest.id, backendBinding, leaseDecision.mode, leaseDecision.reusable);
        }
        await start.releaseTerminalEvents();
        const terminal = await settleExecutionTerminal({
          status: "completed",
          backendId: adapter.manifest.id,
          text: result.outputText,
          data: result.terminalData
        });
        if (terminal.status !== "completed") {
          return withNativeExecutionRecords(terminal);
        }
        return withNativeExecutionRecords({
          runId: request.runId,
          status: "completed",
          outputText: result.outputText,
          nativeExecution: result.nativeExecution,
          backendBinding,
          contextManifest: context.manifest,
          effectiveModel: result.effectiveModel
        });
      }

      if (result.status === "cancelled") {
        await start.releaseTerminalEvents();
        return withNativeExecutionRecords(await settleExecutionTerminal({
          status: "cancelled",
          backendId: adapter.manifest.id,
          error: result.error
        }));
      }

      await start.releaseTerminalEvents();
      return withNativeExecutionRecords(await settleExecutionTerminal({
        status: "failed",
        backendId: adapter.manifest.id,
        error: result.error
      }));
    } catch (error) {
      const existingTerminal = await this.readTerminalResult(request.runId);
      if (existingTerminal) return withNativeExecutionRecords(existingTerminal);
      const cancelled = this.cancelRequestedRuns.has(request.runId);
      const message = error instanceof Error ? error.message : String(error);
      return withNativeExecutionRecords(await settleExecutionTerminal({
        status: cancelled ? "cancelled" : "failed",
        backendId: adapter.manifest.id,
        error: message
      }));
    } finally {
      if (!keepOwner) {
        this.releaseRun(request.runId, { preserveStart: surfaceOwnsTerminal });
      }
    }
  }

  async cancel(runId: string): Promise<void> {
    this.cancelRequestedRuns.add(runId);
    const owner = this.runOwners.get(runId);
    if (typeof owner?.cancel === "function") await owner.cancel(runId);
  }

  private async retireBindingBeforeReplacement(input: {
    request: HarnessRunRequest;
    session: StoredSession;
    binding: BackendSessionBinding;
    reason: NativeBindingReplacementReason;
    expectedIdentity: NativeBindingContextIdentity;
    hook?: BeforeBindingReplacement;
  }): Promise<void> {
    if (!input.hook) {
      throw new Error(
        `Refusing to replace Native binding without durable retirement: ${input.reason}`
      );
    }
    await input.hook({
      request: input.request,
      session: input.session,
      binding: input.binding,
      reason: input.reason,
      expectedIdentity: input.expectedIdentity
    });
    if (sessionBackendBinding(input.session, input.binding.backendId)) {
      throw new Error(
        `Durable Native binding retirement did not remove ${input.binding.backendId} binding`
      );
    }
    if (
      input.binding.backendId === "codex-cli"
      && input.session.threadId?.trim()
    ) {
      throw new Error(
        "Durable Native binding retirement did not clear the legacy Codex thread binding"
      );
    }
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
      error: input.error,
      data: input.data
    }, options.sink);
  }

  private async commitRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    return await this.enqueueRunCommit(input.runId, async (lane) => {
      await this.ensureRunLaneLoaded(input.runId, lane);
      if (lane.terminal && !isPostTerminalLifecycleEventType(input.type)) return lane.terminal;
      const event = createRunEvent(input, lane.nextSequence, this.now);
      await this.appendLedgerEventWithReceipt(input.runId, lane, event);
      this.scheduleRunDelivery(input.runId, lane, event, sink);
      if (isTerminalRunEventType(event.type)) {
        lane.terminal = event;
        this.releaseRun(input.runId);
      }
      this.scheduleMemoryRunEvent(event);
      return event;
    });
  }

  private async beginMemoryRun(request: HarnessRunRequest): Promise<void> {
    try {
      await this.options.memoryProvider.beginRun?.(request);
    } catch (error) {
      console.warn("EchoInk Memory run capture failed", error);
    }
  }

  private async observeMemoryRunEvent(event: HarnessEvent): Promise<void> {
    try {
      await this.options.memoryProvider.observeRunEvent?.(event);
    } catch (error) {
      console.warn("EchoInk Memory lifecycle event failed", error);
    }
  }

  private scheduleMemoryRunEvent(event: HarnessEvent): void {
    const previous = this.memoryObservationTails.get(event.runId) ?? Promise.resolve();
    const observation = previous
      .catch(() => undefined)
      .then(async () => await this.observeMemoryRunEvent(event));
    this.memoryObservationTails.set(event.runId, observation);
    void observation.finally(() => {
      if (this.memoryObservationTails.get(event.runId) === observation) {
        this.memoryObservationTails.delete(event.runId);
      }
    });
  }

  private async startAdapterRun(
    request: HarnessRunRequest,
    adapter: AgentAdapter,
    context: ReturnType<typeof compileContextBundle>,
    binding: BackendSessionBinding | null,
    emit: (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }) => Promise<HarnessEvent>,
    registerNativeExecution?: RegisterNativeExecution,
    nativeExecutionRecordIds?: Set<string>,
    surfaceOwnsTerminal = false
  ): Promise<AdapterRunStart> {
    const bufferedTerminalEvents: Array<Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }> = [];
    let terminalEventsReleased = false;
    const emitAdapterEvent = async (event: Partial<HarnessEvent> & { type: HarnessEventType; source: HarnessEventSource }): Promise<void> => {
      const normalized = { ...event, source: event.source || "agent", backendId: event.backendId || adapter.manifest.id };
      if (surfaceOwnsTerminal && isTerminalRunEventType(normalized.type)) {
        return;
      }
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
        workspace: request.workspace,
        nativeSessionId: binding?.nativeSessionId,
        nativeThreadId: binding?.nativeThreadId
          || (
            binding?.nativeExecutionRef?.kind === "thread"
              ? binding.nativeExecutionRef.id
              : undefined
          ),
        nativeBindingManagedByHarness: true,
        registerNativeExecution: registerNativeExecution
          ? async (native) => {
            const receipt = await registerNativeExecution({ request, native });
            const recordId = receipt.recordId?.trim();
            if (!recordId) {
              throw new Error("Native execution registration did not return a record ID");
            }
            nativeExecutionRecordIds?.add(recordId);
          }
          : undefined,
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
    if (lane.poisoned) throw lane.poisoned;
    if (lane.loaded) return;
    const existing = await this.options.ledger.readRun(runId);
    this.hydrateRunLane(lane, existing);
  }

  private async appendLedgerEventWithReceipt(
    runId: string,
    lane: RunLane,
    candidate: HarnessEvent
  ): Promise<void> {
    const previousEvents = [...lane.events];
    try {
      await this.options.ledger.append(candidate);
    } catch (appendError) {
      this.invalidateRunLane(lane);
      let observedEvents: HarnessEvent[];
      try {
        observedEvents = await this.options.ledger.readRun(runId);
      } catch (readbackError) {
        throw this.poisonRunLane(
          lane,
          runLedgerReadbackFailure(
            candidate,
            appendError,
            readbackError
          )
        );
      }

      let receipt: ReturnType<typeof resolveRunLedgerAppendReadbackReceipt>;
      try {
        receipt = resolveRunLedgerAppendReadbackReceipt({
          previousEvents,
          candidate,
          observedEvents
        });
      } catch (readbackConflict) {
        throw this.poisonRunLane(
          lane,
          runLedgerReadbackConflict(
            candidate,
            appendError,
            readbackConflict
          )
        );
      }
      if (receipt.status === "absent") {
        throw appendError;
      }
      this.hydrateRunLane(lane, receipt.events);
      return;
    }

    lane.events.push(candidate);
    lane.nextSequence = candidate.sequence + 1;
  }

  private hydrateRunLane(
    lane: RunLane,
    events: readonly HarnessEvent[]
  ): void {
    lane.events = [...events];
    lane.loaded = true;
    lane.nextSequence = nextSequence(events);
    lane.terminal = events.reduce<HarnessEvent | null>((latest, event) => {
      if (!isTerminalRunEventType(event.type)) return latest;
      if (!latest || event.sequence >= latest.sequence) return event;
      return latest;
    }, null);
  }

  private invalidateRunLane(lane: RunLane): void {
    lane.loaded = false;
    lane.events = [];
    lane.nextSequence = 1;
    lane.terminal = null;
  }

  private poisonRunLane(lane: RunLane, error: Error): Error {
    this.invalidateRunLane(lane);
    lane.poisoned = error;
    return error;
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
        events: [],
        nextSequence: 1,
        terminal: null,
        poisoned: null
      };
      this.runLanes.set(runId, lane);
    }
    return lane;
  }

  private reclaimRunLane(runId: string, lane: RunLane): void {
    if (!lane.terminal || lane.pendingCommits > 0 || lane.pendingDeliveries > 0) return;
    if (this.runLanes.get(runId) === lane) this.runLanes.delete(runId);
  }

  private releaseRun(
    runId: string,
    options: { preserveStart?: boolean } = {}
  ): void {
    this.leaseManager.releaseLeaseForRun(runId);
    this.runOwners.delete(runId);
    this.cancelRequestedRuns.delete(runId);
    if (!options.preserveStart) this.runStarts.delete(runId);
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
  expectedIdentity: NativeBindingContextIdentity,
  expectedVaultProfileFingerprint: string,
  previousBinding: BackendSessionBinding | null,
  lastUsedAt: number,
  leaseLimits: NativeSessionLeaseLimits,
  reusePreviousLease: boolean
): BackendSessionBinding {
  assertContextManifestIdentity(
    manifest,
    expectedIdentity,
    expectedVaultProfileFingerprint,
    isPersistentConversationRun(request)
  );
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
    workspaceFingerprint: expectedIdentity.workspaceFingerprint,
    ...(manifest.vaultProfileFingerprint
      ? { vaultProfileFingerprint: manifest.vaultProfileFingerprint }
      : {}),
    contextCursor: {
      syncedThroughMessageId: manifest?.compiledThroughMessageId,
      syncedSessionRevision: manifest?.sessionRevision ?? 1,
      sessionGeneration: manifest.sessionGeneration,
      ...(manifest.contextId ? { contextId: manifest.contextId } : {}),
      workspaceFingerprint: expectedIdentity.workspaceFingerprint,
      snapshotVersion: manifest?.snapshotVersion
    },
    lastUsedAt,
    capabilitySnapshot: adapter.manifest.capabilities
  };
}

function assertContextManifestIdentity(
  manifest: ContextManifest | undefined,
  expectedIdentity: NativeBindingContextIdentity,
  expectedVaultProfileFingerprint: string,
  requireWorkspaceFingerprint = false
): asserts manifest is ContextManifest {
  if (
    !manifest
    || manifest.sessionGeneration !== expectedIdentity.sessionGeneration
    || (manifest.contextId?.trim() || undefined) !== expectedIdentity.contextId
    || (
      (manifest.vaultProfileFingerprint?.trim() ?? "")
      !== expectedVaultProfileFingerprint
    )
    || (
      requireWorkspaceFingerprint
        ? manifest.workspaceFingerprint !== expectedIdentity.workspaceFingerprint
        : (
          manifest.workspaceFingerprint !== undefined
          && manifest.workspaceFingerprint !== expectedIdentity.workspaceFingerprint
        )
    )
  ) {
    throw new Error("Compiled context manifest does not match the current Conversation identity");
  }
}

function assertCompleteBindingContextIdentity(
  identity: NativeBindingContextIdentity
): asserts identity is NativeBindingContextIdentity & { contextId: string } {
  if (
    !identity.workspaceFingerprint.trim()
    || !Number.isSafeInteger(identity.sessionGeneration)
    || identity.sessionGeneration <= 0
    || !identity.contextId?.trim()
  ) {
    throw new Error(
      "Conversation identity must be durably initialized before creating a Native binding"
    );
  }
}

function isPersistentConversationRun(
  request: Pick<HarnessRunRequest, "workflow">
): boolean {
  return request.workflow === "chat.generic" || request.workflow === "knowledge.ask";
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

function decisionReplacementReason(
  decision: NativeSessionLeaseDecision
): NativeBindingReplacementReason {
  switch (decision.reason) {
    case "context-identity-missing":
    case "context-identity-mismatch":
    case "vault-profile-mismatch":
    case "revision-mismatch":
    case "no-lease":
    case "expired":
    case "max-turns":
    case "context-capacity":
      return decision.reason;
    default:
      throw new Error(
        `Lease decision ${decision.reason} does not replace a Native binding`
      );
  }
}

function restoreBindingForRetirement(
  session: StoredSession,
  binding: BackendSessionBinding,
  legacyThreadId: string | undefined
): void {
  session.backendBindings = {
    ...(session.backendBindings ?? {}),
    [binding.backendId]: binding
  };
  if (binding.backendId !== "codex-cli") return;
  if (legacyThreadId?.trim()) session.threadId = legacyThreadId;
  else delete session.threadId;
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
    || type === "run.surface_terminal.ignored"
    || type === "agent.native_cleanup.scheduled"
    || type === "agent.native_cleanup.started"
    || type === "agent.native_cleanup.completed"
    || type === "agent.native_cleanup.unsupported"
    || type === "agent.native_cleanup.failed"
    || type === "agent.native_cleanup.retained"
    || type === "agent.native_cleanup.quarantined";
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

function resultFromTerminalInput(
  runId: string,
  input: Omit<SettleRunTerminalInput, "runId">
): HarnessRunResult {
  if (input.status === "completed") {
    return {
      runId,
      status: "completed",
      ...(input.text !== undefined ? { outputText: input.text } : {})
    };
  }
  return {
    runId,
    status: input.status,
    ...(input.error !== undefined ? { error: input.error } : {})
  };
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

function nextSequence(events: readonly HarnessEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
}

function runLedgerReadbackFailure(
  candidate: HarnessEvent,
  appendError: unknown,
  readbackError: unknown
): Error {
  return new AggregateError(
    [appendError, readbackError],
    `Run Ledger append outcome is unavailable for ${candidate.eventId}; commit lane is poisoned and recovery is required`
  );
}

function runLedgerReadbackConflict(
  candidate: HarnessEvent,
  appendError: unknown,
  readbackConflict: unknown
): Error {
  return new AggregateError(
    [appendError, readbackConflict],
    `Run Ledger append readback conflicts for ${candidate.eventId}; commit lane is poisoned and recovery is required`
  );
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
