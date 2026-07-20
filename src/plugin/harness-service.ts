import * as path from "path";
import { createHash } from "node:crypto";
import type CodexForObsidianPlugin from "../main";
import type { TurnOptions } from "../core/codex-service";
import {
  applyChatRunTerminalWinner,
  chatRunTerminalPayloadHash,
  chatRunTerminalProjectedText,
  createEchoInkChatRunTerminalRecovery,
  echoInkChatTerminalCommitId,
  echoInkChatTerminalRawRef,
  findStoredSessionForChatRun,
  normalizeChatRunTerminal,
  resolveEchoInkChatRunTerminalRecovery,
  type PendingRunTerminalRecovery,
  type ResolvedEchoInkChatRunTerminalRecovery
} from "../core/message-state";
import {
  LARGE_MESSAGE_THRESHOLD,
  pluginDataDir
} from "../core/raw-message-store";
import type { AgentBackendKind } from "../agent/types";
import { isAgentBackendKind } from "../agent/registry";
import type { AgentAdapter } from "../harness/agents/adapter";
import { createHarnessAgentAdapter } from "../harness/agents/adapter-factory";
import { CodexRichAgentAdapter, type CodexRichAgentAdapterOptions } from "../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../harness/agents/adapters/codex-rich-notification-hub";
import type { HarnessEvent, HarnessEventSink } from "../harness/contracts/event";
import type { BackendSessionBinding, HarnessRunRequest } from "../harness/contracts/run";
import type {
  LocalRunCommitResult,
  MemoryTransactionAuthorityReceipt,
  NativeExecutionRecord,
  NativeExecutionRef,
  NativeRunOutcome
} from "../harness/contracts/native-execution";
import {
  hasTrustedNativeExecutionIdentity,
  isHermesProposalHostExecutionRef,
  isValidEchoInkHostProcessDispositionReceipt,
  nativeRetirementSourceIdentityState
} from "../harness/contracts/native-execution";
import type {
  SessionNativeRetirement
} from "../harness/conversation/context-rotation";
import type {
  ConversationAuthorityProbe,
  ConversationAuthorityProof
} from "../harness/conversation/conversation-store";
import type {
  RecordMutationRevision
} from "../harness/lifecycle/record-mutation-contract";
import { EchoInkHarnessKernel, type HarnessRunWithAdapterInput } from "../harness/kernel/harness-kernel";
import {
  NativeSessionLeaseManager,
  type NativeSessionLeaseCleanupExecutionResult,
  type NativeSessionLeaseRetirementInput
} from "../harness/kernel/native-session-lease-manager";
import { sessionGeneration } from "../harness/kernel/session-service";
import type {
  AppendRunEventInput,
  BeforeBindingReplacementInput,
  RunTerminalStatus,
  SettleRunTerminalInput
} from "../harness/kernel/run-orchestrator";
import { FileRunLedger } from "../harness/ledger/run-ledger";
import {
  recoverStartedRunRecordRetentionSweeps,
  type RunRecordRetentionRetirementRoots
} from "../harness/ledger/run-record-retention";
import {
  createRunRecordRetentionRecoveryEvidenceAuthority
} from "../harness/ledger/run-record-retention-recovery-evidence";
import {
  ECHOINK_RECORD_MUTATION_ROOT_IDS,
  echoInkRecordMutationRootPath,
  prepareEchoInkRecordMutationRuntimeRoots,
  type EchoInkRecordMutationRootId
} from "../harness/lifecycle/record-mutation-production";
import {
  buildCodexMemoryMigrationPreview,
  FileMemoryProvider,
  type CodexMemoryImportResult,
  type CodexMemoryMigrationPreview,
  type InitializeEchoInkMemoryResult,
  type MemoryStoreStatus
} from "../harness/memory/file-memory";
import {
  recoverAndResolveMemoryTransactionAuthority,
  type MemorySyncResult
} from "../harness/memory/v2-engine";
import { NoopMemoryProvider } from "../harness/memory/noop-provider";
import { BackendNeutralMemoryCurator } from "../harness/memory/backend-curator";
import {
  assertRecoverableEphemeralUtilityNativeRecord,
  isEphemeralUtilityWorkflow,
  nativeRunOutcomeForUtilityTerminal,
  resolveEphemeralUtilityStartupTerminal,
  utilityLocalCommit
} from "../harness/native/ephemeral-utility-lifecycle";
import { NativeExecutionManager, type NativeCleanupResult, type SettleNativeExecutionInput } from "../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../harness/native/native-execution-store";
import { canonicalProviderEndpointIdentity } from "../harness/native/provider-endpoint-identity";
import { buildActiveEchoInkResourceCatalog } from "../resources/registry";
import { loadVaultEchoInkResources } from "../resources/vault-resource-catalog";
import type { EchoInkResource } from "../resources/types";
import {
  getActiveApiProvider,
  type ChatMessage,
  type EchoInkChatRunTerminalRecovery,
  type StoredSession
} from "../settings/settings";
import type { CodexNotification, UserInput } from "../types/app-server";
import {
  assertNativeRetirementRecordMutationAuthority,
  reconcileNativeExecutionsAtStartup,
  type NativeStartupReconciliationOptions,
  type NativeStartupReconciliationResult
} from "./native-startup-reconciliation";

const CHAT_STARTUP_LOCAL_COMMIT_RECOVERY_REASON =
  "EchoInk restarted before the Chat surface durable commit was proven";
const EDITOR_STARTUP_LOCAL_COMMIT_MISSING_REASON =
  "EchoInk restarted before a durable Run Ledger terminal committed the Editor result";
const HERMES_PROPOSAL_STARTUP_LOCAL_COMMIT_MISSING_REASON =
  "EchoInk restarted before a durable Knowledge local-commit receipt settled the Hermes proposal";
const HERMES_PROPOSAL_STARTUP_TERMINAL_MISSING_REASON =
  "EchoInk restarted before the Hermes proposal Harness run reached a terminal";
const NATIVE_CLEANUP_AUTHORITY_BLOCKED_REASON =
  "Native cleanup is blocked until startup reconciliation succeeds";
const CHAT_NATIVE_BINDING_RECOVERY_REASON =
  "Chat terminal committed, but the leased Native execution has no durable Conversation binding";
const CHAT_NATIVE_SETTLEMENT_MAX_ATTEMPTS = 3;
const CHAT_NATIVE_SETTLEMENT_RETRY_DELAY_MS = 5;
const MAX_CHAT_NATIVE_RECEIPT_STATES = 256;

interface ChatNativeExecutionReceipt {
  recordId: string;
  sessionId: string;
  native: NativeExecutionRef;
}

interface ChatNativeSettlementIntent {
  status: RunTerminalStatus;
  runOutcome: "success" | "failed" | "cancelled";
  terminalCommitId: string;
}

interface ChatNativeReceiptState {
  receipts: Map<string, ChatNativeExecutionReceipt>;
  settledRecordIds: Set<string>;
  registrationsClosed: boolean;
  strictSettlement: boolean;
  liveTerminalMarkerCommitId?: string;
  intent?: ChatNativeSettlementIntent;
  settlementTail: Promise<void>;
}

interface ChatStartupSettlementPlan {
  runId: string;
  records: NativeExecutionRecord[];
  status: RunTerminalStatus;
  authority: ResolvedEchoInkChatRunTerminalRecovery;
}

interface EditorStartupSettlementPlan {
  runId: string;
  records: NativeExecutionRecord[];
  terminal: HarnessEvent | null;
}

interface EphemeralUtilityStartupSettlementPlan {
  runId: string;
  records: NativeExecutionRecord[];
  terminal: HarnessEvent | null;
  memoryTransactionId?: string;
  memoryAuthority?: MemoryTransactionAuthorityReceipt | null;
}

interface HermesProposalHostStartupSettlementPlan {
  runId: string;
  record: NativeExecutionRecord;
  terminal: HarnessEvent | null;
  localCommitCompleted: boolean;
}

export interface CommitChatSurfaceTerminalOptions {
  mode?: "live" | "recovery-live" | "recovery-restart";
  persistConversation?: (
    winner: SettleRunTerminalInput
  ) => Promise<void>;
}

export interface RecordMutationStartupAuthority {
  recoverPendingRecordMutations(): Promise<number>;
  recoverStartedRawGcQuarantines?(): Promise<number>;
  readRecordMutationAuthority(
    mutationId: string
  ): Promise<RecordMutationRevision>;
}

export class EchoInkHarnessService {
  private harnessKernel: EchoInkHarnessKernel | null = null;
  private harnessKernelKey = "";
  private fileMemoryProvider: FileMemoryProvider | null = null;
  private fileMemoryProviderKey = "";
  private nativeExecutionManager: NativeExecutionManager | null = null;
  private nativeExecutionManagerKey = "";
  private nativeExecutionDeviceKey = "";
  private readonly nativeSessionLeaseManager = new NativeSessionLeaseManager();
  private nativeLeaseCleanupQueue: Promise<NativeSessionLeaseCleanupExecutionResult[]> = Promise.resolve([]);
  private readonly codexRichNotificationHub = new CodexRichNotificationHub();
  private nativeCleanupAuthorityReady = false;
  private nativeCleanupAuthorityFailure: Error | null = null;
  private nativeStartupReconciliationFlight: Promise<NativeStartupReconciliationResult> | null = null;
  private readonly chatNativeReceipts = new Map<string, ChatNativeReceiptState>();
  private readonly chatTerminalAuthorityTails = new Map<string, Promise<void>>();

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async runWithAdapter(input: HarnessRunWithAdapterInput) {
    const backend = isAgentBackendKind(input.adapter.manifest.id) ? input.adapter.manifest.id : null;
    const registeredRecordIds = new Set<string>();
    let persistentChat = false;
    try {
      const persistentSession = await this.preparePersistentConversationRun(input);
      persistentChat = Boolean(
        persistentSession
        && input.request.workflow === "chat.generic"
      );
      const registerNativeExecution = persistentSession
        ? async (registration: Parameters<NonNullable<HarnessRunWithAdapterInput["registerNativeExecution"]>>[0]) => {
          const recordId = await this.registerPersistentRunNativeExecution(
            registration.request,
            registration.native
          );
          registeredRecordIds.add(recordId);
          if (persistentChat) {
            await this.captureChatNativeExecutionReceipt({
              recordId,
              sessionId: registration.request.sessionId,
              native: registration.native
            }, registration.request.runId);
          }
          return { recordId };
        }
        : input.registerNativeExecution;
      const result = await this.getHarnessKernel().runWithAdapter({
        ...input,
        ...(persistentSession
          ? { sessionProvider: () => persistentSession }
          : {}),
        beforeBindingReplacement: async (replacement) =>
          await this.retireBindingBeforeReplacement(replacement),
        registerNativeExecution,
        ...(persistentChat ? { terminalAuthority: "surface" as const } : {})
      });
      if (backend && result.status === "completed") this.plugin.agentRuntimeHealth.reportHealthy(backend);
      else if (backend && result.status === "failed") {
        this.plugin.agentRuntimeHealth.reportFailure(backend, result.error, { source: "terminal" });
      }
      return result;
    } catch (error) {
      if (!persistentChat) {
        await this.failUndeliveredPersistentNativeExecutions(
          registeredRecordIds,
          error
        );
      }
      if (backend) this.plugin.agentRuntimeHealth.reportFailure(backend, error, { source: "adapter-runtime" });
      throw error;
    } finally {
      if (persistentChat) {
        await this.closeChatNativeExecutionRegistrations(input.request.runId);
      }
    }
  }

  async settleRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    const terminal = await this.getHarnessKernel().settleRunTerminal(input, sink);
    this.reportRunTerminalHealth(terminal);
    return terminal;
  }

  private reportRunTerminalHealth(terminal: HarnessEvent): void {
    if (terminal.backendId && isAgentBackendKind(terminal.backendId)) {
      if (terminal.type === "run.completed") {
        this.plugin.agentRuntimeHealth.reportHealthy(terminal.backendId);
      } else if (terminal.type === "run.failed") {
        this.plugin.agentRuntimeHealth.reportFailure(terminal.backendId, terminal.error, { source: "terminal" });
      }
    }
  }

  async commitChatSurfaceTerminal(
    input: SettleRunTerminalInput,
    options: CommitChatSurfaceTerminalOptions = {}
  ): Promise<void> {
    const mode = options.mode ?? "live";
    if (mode !== "live" && !options.persistConversation) {
      throw new Error(
        "Recovered Chat terminal commit requires an atomic Conversation persistence callback"
      );
    }
    const candidate = normalizeChatRunTerminal(input);
    await this.enqueueChatTerminalAuthority(candidate.runId, async () => {
      const session = findStoredSessionForChatRun(
        this.plugin.settings.sessions,
        candidate.runId
      );
      if (!session) {
        throw new Error(
          `Chat terminal commit requires a Conversation marker for ${candidate.runId}`
        );
      }
      const durableAuthority = await this.resolveChatTerminalAuthority(
        session,
        candidate.runId,
        false
      );
      const authorityInput = durableAuthority?.terminal ?? candidate;
      const terminal = await this.getHarnessKernel().commitSurfaceRunTerminal(
        authorityInput,
        async (winner) => {
          const winnerInput = normalizeChatRunTerminal(
            settleRunTerminalInputForEvent(winner)
          );
          if (
            durableAuthority
            && chatRunTerminalPayloadHash(winnerInput)
              !== durableAuthority.marker.payloadHash
          ) {
            throw new Error(
              `Run Ledger terminal conflicts with durable Conversation authority for ${candidate.runId}`
            );
          }
          await this.persistChatTerminalAuthority(
            session,
            winnerInput,
            durableAuthority,
            options.persistConversation
          );
        }
      );
      this.reportRunTerminalHealth(terminal);
      const actualTerminal = normalizeChatRunTerminal(
        settleRunTerminalInputForEvent(terminal)
      );
      const committedAuthority = await this.resolveChatTerminalAuthority(
        session,
        actualTerminal.runId,
        true
      );
      if (
        !committedAuthority
        || committedAuthority.marker.payloadHash
          !== chatRunTerminalPayloadHash(actualTerminal)
      ) {
        throw new Error(
          `Chat terminal authority is not durable for ${actualTerminal.runId}`
        );
      }
      const actualStatus = actualTerminal.status;
      try {
        await this.recordChatNativeSettlementIntent(actualTerminal.runId, {
          status: actualStatus,
          runOutcome: chatRunOutcome(actualStatus),
          terminalCommitId: committedAuthority.marker.terminalCommitId
        }, mode);
      } catch (error) {
        if (mode !== "live") throw error;
        console.error("EchoInk Chat Native settlement remains pending", error);
        const state = this.chatNativeReceipts.get(actualTerminal.runId.trim());
        if (state?.registrationsClosed) {
          this.chatNativeReceipts.delete(actualTerminal.runId.trim());
        }
      }
    });
  }

  async appendRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink) {
    return await this.getHarnessKernel().appendRunEvent(input, sink);
  }

  async cancelRun(runId: string): Promise<void> {
    await this.getHarnessKernel().cancelRun(runId);
  }

  async getMemoryStatus(): Promise<MemoryStoreStatus> {
    return await this.getFileMemoryProvider().status();
  }

  async initializeMemory(): Promise<InitializeEchoInkMemoryResult> {
    return await this.getFileMemoryProvider().initialize();
  }

  async syncMemoryNow(): Promise<MemorySyncResult> {
    return await this.getFileMemoryProvider().syncPending();
  }

  async recoverMemory(): Promise<unknown> {
    const provider = this.getFileMemoryProvider();
    const transactions = await provider.recover();
    const ledger = this.createRunLedger();
    const lifecycle = await provider.reconcileRunLedger(async (runId) => await ledger.readRun(runId));
    return { transactions, lifecycle };
  }

  async previewCodexMemoryMigration(): Promise<CodexMemoryMigrationPreview> {
    return await buildCodexMemoryMigrationPreview({ vaultPath: this.plugin.getVaultPath() });
  }

  async importCodexMemory(): Promise<CodexMemoryImportResult> {
    return await this.getFileMemoryProvider().importCodexMemory();
  }

  async resolveMemoryConfirmation(confirmationId: string, decision: "accept" | "dismiss"): Promise<boolean> {
    return await this.getFileMemoryProvider().resolveConfirmation(confirmationId, decision);
  }

  async dismissMemoryTransaction(transactionId: string, reason: string): Promise<boolean> {
    return await this.getFileMemoryProvider().dismissTransaction(transactionId, reason);
  }

  async retryMemoryTransaction(transactionId: string): Promise<MemorySyncResult> {
    return await this.getFileMemoryProvider().retryTransaction(transactionId);
  }

  async deleteMemory(memoryId: string, reason: string): Promise<boolean> {
    return await this.getFileMemoryProvider().remove(memoryId, reason);
  }

  getNativeExecutionRefContext(backendId?: AgentBackendKind): { deviceKey: string; vaultId: string; providerEndpoint?: string } {
    let rawProviderEndpoint = "";
    if (backendId === "opencode") {
      rawProviderEndpoint = this.plugin.settings.opencode.serverUrl.trim()
        || `http://${this.plugin.settings.opencode.hostname || "127.0.0.1"}:${this.plugin.settings.opencode.port || 4096}`;
    } else if (backendId === "hermes") {
      rawProviderEndpoint =
        this.plugin.settings.agents.hermes.serverUrl.trim();
    } else if (
      backendId === "codex-cli"
      && this.plugin.settings.providerMode === "custom-api"
    ) {
      rawProviderEndpoint =
        getActiveApiProvider(this.plugin.settings)?.baseUrl.trim() ?? "";
    }
    const providerEndpoint = canonicalProviderEndpointIdentity(
      rawProviderEndpoint
    );
    return {
      deviceKey: this.getNativeExecutionDeviceKey(),
      vaultId: this.plugin.getVaultPath(),
      ...(providerEndpoint ? { providerEndpoint } : {})
    };
  }

  async recordNativeExecution(record: NativeExecutionRecord): Promise<void> {
    await this.getNativeExecutionManager().recordCreated(record);
  }

  async settleNativeExecution(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> {
    return await this.getNativeExecutionManager().settleRun(input);
  }

  async cleanupDueNativeExecutions(limit = 20): Promise<NativeCleanupResult[]> {
    await this.requireNativeCleanupAuthority();
    return await this.getNativeExecutionManager().cleanupDue(limit);
  }

  async cleanupNativeExecutionRecord(recordId: string): Promise<NativeCleanupResult> {
    await this.requireNativeCleanupAuthority();
    return await this.getNativeExecutionManager().cleanupById(recordId);
  }

  async recoverStartedRunRecordRetentions(): Promise<number> {
    const vaultPath = this.plugin.getVaultPath();
    const pluginDir = this.plugin.getPluginDataDirName();
    const storageRootPath = pluginDataDir(vaultPath, pluginDir);
    const recoveryEvidenceAuthority =
      createRunRecordRetentionRecoveryEvidenceAuthority({
        storageRootPath,
        artifactRootPath: echoInkRecordMutationRootPath({
          vaultPath,
          pluginDir,
          rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.artifact
        })
      });
    return await recoverStartedRunRecordRetentionSweeps({
      storageRootPath,
      recoveryEvidenceAuthority,
      resolveRetirementRoots: async () =>
        await this.prepareRunRecordRetentionRetirementRoots(
          vaultPath,
          pluginDir
        )
    });
  }

  reconcileNativeExecutionStartup(
    proveConversationAuthority: (
      probe: ConversationAuthorityProbe
    ) => Promise<ConversationAuthorityProof>,
    options: NativeStartupReconciliationOptions = {},
    recordMutationAuthority?: RecordMutationStartupAuthority
  ): Promise<NativeStartupReconciliationResult> {
    if (this.nativeStartupReconciliationFlight) {
      return this.nativeStartupReconciliationFlight;
    }
    this.nativeCleanupAuthorityReady = false;
    this.nativeCleanupAuthorityFailure = null;
    const manager = this.getNativeExecutionManager();
    const reconciliation = reconcileNativeExecutionsAtStartup({
      ...(recordMutationAuthority
        ? {
          recoverPendingRecordMutations: async () =>
            await recordMutationAuthority.recoverPendingRecordMutations(),
          readRecordMutationAuthority: async (mutationId: string) =>
            await recordMutationAuthority.readRecordMutationAuthority(
              mutationId
            )
        }
        : {}),
      recoverPendingChatLocalCommits: async () =>
        await this.recoverPendingChatNativeSettlementIntents(),
      recoverPendingEditorLocalCommits: async () =>
        await this.recoverPendingEditorNativeExecutions(),
      recoverPendingEphemeralUtilityLocalCommits: async () =>
        await this.recoverPendingEphemeralUtilityNativeExecutions(),
      recoverPendingHermesProposalLocalCommits: async () =>
        await this.recoverPendingHermesProposalHostNativeExecutions(),
      ...(recordMutationAuthority?.recoverStartedRawGcQuarantines
        ? {
          recoverStartedRawGcQuarantines: async () =>
            await recordMutationAuthority
              .recoverStartedRawGcQuarantines!()
        }
        : {}),
      recoverStartedRunRecordRetentions: async () =>
        await this.recoverStartedRunRecordRetentions(),
      listAwaitingRetirements: async () =>
        await manager.listAwaitingLocalCommitRetirements(),
      proveConversationAuthority,
      promoteRetirement: async (record) => {
        const promoted = await manager.promoteRetirement(record.id, record);
        if (!promoted) {
          throw new Error(`Native binding retirement not found: ${record.id}`);
        }
      },
      abortRetirement: async (record, reason) => {
        const aborted = await manager.abortRetirement(record.id, reason, record);
        if (!aborted) {
          throw new Error(`Native binding retirement not found: ${record.id}`);
        }
      },
      quarantineRetirement: async (record, reason) => {
        const quarantined = await manager.quarantineRetirement(
          record.id,
          reason,
          record
        );
        if (!quarantined) {
          throw new Error(`Native binding retirement not found: ${record.id}`);
        }
      },
      cleanupDue: async (limit) => await manager.cleanupDue(limit)
    }, options);
    const flight = reconciliation.then(
      (result) => {
        if (this.nativeStartupReconciliationFlight === flight) {
          this.nativeCleanupAuthorityReady = true;
          this.nativeCleanupAuthorityFailure = null;
        }
        return result;
      },
      (error: unknown) => {
        if (this.nativeStartupReconciliationFlight === flight) {
          this.nativeCleanupAuthorityReady = false;
          this.nativeCleanupAuthorityFailure = normalizeError(error);
          // A failed gate remains closed, but a later explicit startup
          // reconciliation may retry the proof and unlock cleanup.
          this.nativeStartupReconciliationFlight = null;
        }
        throw error;
      }
    );
    this.nativeStartupReconciliationFlight = flight;
    return flight;
  }

  async registerNativeExecutionRetirements(
    retirements: readonly SessionNativeRetirement[]
  ): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const records = this.nativeExecutionRetirementRecords(retirements);
    for (const record of records) {
      await manager.registerRetirement(record);
    }
  }

  async listAwaitingNativeExecutionRetirements(): Promise<NativeExecutionRecord[]> {
    return await this.getNativeExecutionManager().listAwaitingLocalCommitRetirements();
  }

  async promoteNativeExecutionRetirements(
    retirements: readonly SessionNativeRetirement[],
    readRecordMutationAuthority?: (
      mutationId: string
    ) => Promise<RecordMutationRevision>
  ): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const records = this.nativeExecutionRetirementRecords(retirements);
    for (const record of records) {
      const mutationId = record.retirement?.recordMutationId;
      if (!mutationId) continue;
      if (!readRecordMutationAuthority) {
        throw new Error(
          `Native retirement RecordMutation authority reader is unavailable: ${record.id}`
        );
      }
      const mutation = await readRecordMutationAuthority(mutationId);
      assertNativeRetirementRecordMutationAuthority(
        record.id,
        record.retirement!,
        mutation
      );
      if (mutation.state !== "committed") {
        throw new Error(
          `Native retirement RecordMutation Journal is not committed: ${record.id}/${mutation.state}`
        );
      }
    }
    for (const expected of records) {
      const promoted = await manager.promoteRetirement(expected.id, expected);
      if (!promoted) throw new Error(`Native binding retirement not found: ${expected.id}`);
    }
  }

  async abortNativeExecutionRetirements(
    retirements: readonly SessionNativeRetirement[],
    reason: string
  ): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const records = this.nativeExecutionRetirementRecords(retirements);
    for (const expected of records) {
      await manager.abortRetirement(expected.id, reason, expected);
    }
  }

  async quarantineNativeExecutionRetirements(
    retirements: readonly SessionNativeRetirement[],
    reason: string
  ): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const records = this.nativeExecutionRetirementRecords(retirements);
    for (const expected of records) {
      await manager.quarantineRetirement(expected.id, reason, expected);
    }
  }

  async enforceNativeSessionLeaseLimits(): Promise<NativeSessionLeaseCleanupExecutionResult[]> {
    const run = this.nativeLeaseCleanupQueue
      .catch(() => [])
      .then(async () => await this.nativeSessionLeaseManager.cleanupSessions({
        sessions: this.plugin.settings.sessions,
        now: Date.now(),
        retire: async (retirement) => await this.retireLeaseBinding(retirement)
      }));
    this.nativeLeaseCleanupQueue = run;
    return await run;
  }

  async failPendingNativeExecutionsForRecovery(input: { reason: string; surface?: string; sessionId?: string }): Promise<number> {
    const manager = this.getNativeExecutionManager();
    const filter = { surface: input.surface, sessionId: input.sessionId };
    // Knowledge workflow recovery starts as soon as its controller registers,
    // while the global Native reconciliation waits for Obsidian layoutReady.
    // Preserve Hermes proposal host records for their stricter receipt + Run
    // Ledger resolver regardless of which startup task wins that race.
    const pending = (await manager.listPendingLocalCommits(filter)).filter(
      (record) => !isHermesProposalHostExecutionRef(record.native)
    );
    for (const record of pending) {
      await this.settleRunTerminal({
        runId: record.runId,
        status: "failed",
        backendId: record.native.backendId,
        error: input.reason
      }).catch(() => undefined);
    }
    let retained = 0;
    for (const record of pending) {
      retained += await manager.markPendingLocalCommitsFailed(input.reason, {
        ...filter,
        recordId: record.id
      });
    }
    return retained;
  }

  private async recoverPendingEditorNativeExecutions(): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const pending = await manager.listPendingLocalCommits({ surface: "editor" });
    if (!pending.length) return;

    const recordsByRunId = new Map<string, NativeExecutionRecord[]>();
    for (const record of pending) {
      assertRecoverableEditorNativeRecord(record);
      const runId = record.runId.trim();
      const records = recordsByRunId.get(runId) ?? [];
      records.push(record);
      recordsByRunId.set(runId, records);
    }

    // Read and validate every Ledger authority before mutating any Native
    // record. One corrupt run therefore closes the global cleanup gate without
    // partially promoting another run into executable cleanup.
    const ledger = this.createRunLedger();
    const plans: EditorStartupSettlementPlan[] = [];
    for (const runId of Array.from(recordsByRunId.keys()).sort()) {
      const records = recordsByRunId.get(runId)!;
      let events: HarnessEvent[];
      try {
        events = await ledger.readRun(runId);
      } catch (error) {
        throw new Error(
          `Editor Run Ledger authority read failed for ${runId}: ${normalizeError(error).message}`,
          { cause: error }
        );
      }
      plans.push({
        runId,
        records,
        terminal: resolveEditorStartupTerminal(runId, records, events)
      });
    }

    for (const plan of plans) {
      const runOutcome: NativeRunOutcome = plan.terminal
        ? nativeRunOutcomeForTerminal(plan.terminal)
        : "failed";
      const localCommit: LocalRunCommitResult = plan.terminal
        ? {
          committed: true,
          conversationCommitted: true,
          runLedgerCommitted: true,
          artifactsCommitted: true,
          historyIndexCommitted: true
        }
        : {
          committed: false,
          conversationCommitted: false,
          runLedgerCommitted: false,
          artifactsCommitted: false,
          historyIndexCommitted: false,
          error: EDITOR_STARTUP_LOCAL_COMMIT_MISSING_REASON
        };
      for (const record of plan.records) {
        const settled = await manager.settleRun({
          recordId: record.id,
          runOutcome,
          localCommit
        });
        if (!settled) {
          throw new Error(
            `Editor Native execution record disappeared during startup recovery: ${record.id}`
          );
        }
        const expectedLocalCommit = plan.terminal ? "committed" : "failed";
        const expectedCleanup = plan.terminal ? "pending" : "retained-for-recovery";
        if (
          settled.runOutcome !== runOutcome
          || settled.localCommit !== expectedLocalCommit
          || settled.cleanup !== expectedCleanup
        ) {
          throw new Error(
            `Editor Native startup settlement is not authoritative for ${record.id}: `
            + `${settled.runOutcome ?? "pending"}/${settled.localCommit}/${settled.cleanup}`
          );
        }
      }
    }
  }

  private async recoverPendingEphemeralUtilityNativeExecutions(): Promise<void> {
    const manager = this.getNativeExecutionManager();
    const pending = (await manager.listPendingLocalCommits())
      .filter((record) => isEphemeralUtilityWorkflow(record.workflow));
    if (!pending.length) return;

    const recordsByRunId = new Map<string, NativeExecutionRecord[]>();
    for (const record of pending) {
      assertRecoverableEphemeralUtilityNativeRecord(record);
      if (
        record.workflow === "prompt.enhance"
        && record.localCommitAuthority !== undefined
      ) {
        throw new Error(
          `Prompt Enhancer Native record has an unexpected Memory authority: ${record.id}`
        );
      }
      const runId = record.runId.trim();
      const records = recordsByRunId.get(runId) ?? [];
      records.push(record);
      recordsByRunId.set(runId, records);
    }

    // Read and validate every affected Run Ledger before changing any Native
    // record. Prompt Enhancer uses that terminal as its local authority, while
    // Memory Curator additionally requires its exact formal transaction.
    const ledger = this.createRunLedger();
    const plans: EphemeralUtilityStartupSettlementPlan[] = [];
    for (const runId of Array.from(recordsByRunId.keys()).sort()) {
      const records = recordsByRunId.get(runId)!;
      let events: HarnessEvent[];
      try {
        events = await ledger.readRun(runId);
      } catch (error) {
        throw new Error(
          `Ephemeral utility Run Ledger authority read failed for ${runId}: ${normalizeError(error).message}`,
          { cause: error }
        );
      }
      const workflow = records[0]?.workflow;
      plans.push({
        runId,
        records,
        terminal: resolveEphemeralUtilityStartupTerminal(
          runId,
          records,
          events
        ),
        ...(workflow === "memory.curate"
          ? {
            memoryTransactionId:
              memoryTransactionAuthorityIdForUtilityRecords(records)
          }
          : {})
      });
    }

    // Recover and prove all formal Memory transactions before the first Native
    // settlement. A prepared/applied transaction deliberately returns null and
    // leaves the Native record pending; a committing transaction is first
    // rolled forward/back under the Memory mutation lane.
    const authorityByTransaction = new Map<
      string,
      MemoryTransactionAuthorityReceipt | null
    >();
    const runByTransaction = new Map<string, string>();
    for (const plan of plans) {
      const transactionId = plan.memoryTransactionId;
      if (!transactionId) continue;
      const existingRunId = runByTransaction.get(transactionId);
      if (existingRunId && existingRunId !== plan.runId) {
        throw new Error(
          `Memory transaction ${transactionId} is linked to multiple Native runs: `
          + `${existingRunId}, ${plan.runId}`
        );
      }
      runByTransaction.set(transactionId, plan.runId);
      let authority = authorityByTransaction.get(transactionId);
      if (!authorityByTransaction.has(transactionId)) {
        authority = await recoverAndResolveMemoryTransactionAuthority(
          this.plugin.getVaultPath(),
          transactionId
        );
        authorityByTransaction.set(transactionId, authority);
      }
      plan.memoryAuthority = authority;
    }

    for (const plan of plans) {
      if (plan.memoryTransactionId) {
        if (!plan.memoryAuthority) continue;
        if (
          !plan.terminal
          || (
            plan.memoryAuthority.state !== "durable-failed"
            && plan.terminal.type !== "run.completed"
          )
        ) {
          throw new Error(
            `Memory Curator transaction ${plan.memoryTransactionId} is durable `
            + `but Run Ledger terminal is ${plan.terminal?.type ?? "missing"}`
          );
        }
      }
      const runOutcome: NativeRunOutcome = plan.terminal
        ? nativeRunOutcomeForUtilityTerminal(plan.terminal)
        : "failed";
      const localCommit = plan.memoryTransactionId
        ? utilityLocalCommit(true)
        : plan.terminal
        ? utilityLocalCommit(true)
        : utilityLocalCommit(
          false,
          "EchoInk restarted before a durable Run Ledger terminal committed the utility result"
        );
      for (const record of plan.records) {
        const settled = await manager.settleRun({
          recordId: record.id,
          runOutcome,
          localCommit
        });
        if (!settled) {
          throw new Error(
            `Ephemeral utility Native execution record disappeared during startup recovery: ${record.id}`
          );
        }
        const durableAuthority = Boolean(
          plan.memoryTransactionId
            ? plan.memoryAuthority
            : plan.terminal
        );
        const expectedLocalCommit = durableAuthority ? "committed" : "failed";
        const expectedCleanup = durableAuthority
          ? "pending"
          : "retained-for-recovery";
        if (
          settled.runOutcome !== runOutcome
          || settled.localCommit !== expectedLocalCommit
          || settled.cleanup !== expectedCleanup
        ) {
          throw new Error(
            `Ephemeral utility Native startup settlement is not authoritative for ${record.id}: `
            + `${settled.runOutcome ?? "pending"}/${settled.localCommit}/${settled.cleanup}`
          );
        }
      }
    }
  }

  private async recoverPendingHermesProposalHostNativeExecutions(): Promise<number> {
    const manager = this.getNativeExecutionManager();
    const pending = (await manager.listPendingLocalCommits({
      surface: "knowledge"
    })).filter((record) => isHermesProposalHostExecutionRef(record.native));
    if (!pending.length) return 0;

    const recordsByRunId = new Map<string, NativeExecutionRecord[]>();
    for (const record of pending) {
      assertRecoverableHermesProposalHostNativeRecord(record);
      const records = recordsByRunId.get(record.runId) ?? [];
      records.push(record);
      recordsByRunId.set(record.runId, records);
    }

    // Validate every affected Ledger before appending a recovery terminal or
    // changing a Native record. One corrupt run therefore keeps the global
    // provider-cleanup gate closed without partially promoting another run.
    const ledger = this.createRunLedger();
    const plans: HermesProposalHostStartupSettlementPlan[] = [];
    for (const runId of Array.from(recordsByRunId.keys()).sort()) {
      const records = recordsByRunId.get(runId)!;
      if (records.length !== 1) {
        throw new Error(
          `Hermes proposal host run has conflicting Native registrations: ${runId}`
        );
      }
      let events: HarnessEvent[];
      try {
        events = await ledger.readRun(runId);
      } catch (error) {
        throw new Error(
          `Hermes proposal Run Ledger authority read failed for ${runId}: ${normalizeError(error).message}`,
          { cause: error }
        );
      }
      plans.push(resolveHermesProposalHostStartupPlan(
        runId,
        records[0],
        events
      ));
    }

    // A registered host process can survive a crash between run.started and
    // the Harness terminal. Append exactly one failed terminal only after all
    // ledgers above passed structural validation.
    for (const plan of plans) {
      if (plan.terminal) continue;
      const terminal = await this.settleRunTerminal({
        runId: plan.runId,
        status: "failed",
        backendId: "hermes",
        error: HERMES_PROPOSAL_STARTUP_TERMINAL_MISSING_REASON
      });
      if (
        terminal.type !== "run.failed"
        || terminal.source !== "kernel"
        || terminal.backendId !== "hermes"
      ) {
        throw new Error(
          `Hermes proposal startup failed to append an authoritative terminal for ${plan.runId}`
        );
      }
      plan.terminal = terminal;
    }

    for (const plan of plans) {
      const terminal = plan.terminal;
      if (!terminal) {
        throw new Error(
          `Hermes proposal startup terminal remained missing for ${plan.runId}`
        );
      }
      const runOutcome = nativeRunOutcomeForTerminal(terminal);
      const localCommit: LocalRunCommitResult = plan.localCommitCompleted
        ? {
          committed: true,
          conversationCommitted: true,
          runLedgerCommitted: true,
          artifactsCommitted: true,
          historyIndexCommitted: true
        }
        : {
          committed: false,
          conversationCommitted: false,
          runLedgerCommitted: false,
          artifactsCommitted: false,
          historyIndexCommitted: false,
          error: HERMES_PROPOSAL_STARTUP_LOCAL_COMMIT_MISSING_REASON
        };
      const settled = await manager.settleRun({
        recordId: plan.record.id,
        runOutcome,
        localCommit
      });
      if (!settled) {
        throw new Error(
          `Hermes proposal Native execution disappeared during startup recovery: ${plan.record.id}`
        );
      }
      const expectedLocalCommit = plan.localCommitCompleted
        ? "committed"
        : "failed";
      const expectedCleanup = plan.localCommitCompleted
        ? plan.record.observedDisposition
          ? "disposed"
          : "quarantined"
        : "retained-for-recovery";
      if (
        settled.runOutcome !== runOutcome
        || settled.localCommit !== expectedLocalCommit
        || settled.cleanup !== expectedCleanup
      ) {
        throw new Error(
          `Hermes proposal Native startup settlement is not authoritative for ${plan.record.id}: `
          + `${settled.runOutcome ?? "pending"}/${settled.localCommit}/${settled.cleanup}`
        );
      }
    }
    return pending.length;
  }

  private async recoverPendingChatNativeSettlementIntents(): Promise<number> {
    const manager = this.getNativeExecutionManager();
    const pending = await manager.listPendingLocalCommits({ surface: "chat" });
    const runIds = Array.from(new Set(pending
      .filter((record) => record.workflow === "chat.generic")
      .map((record) => record.runId))).sort();
    const ledger = this.createRunLedger();
    const plans: ChatStartupSettlementPlan[] = [];

    // Read and validate every Chat authority before settling the first Native
    // record. A corrupt later Run Ledger must close the global cleanup gate
    // without partially committing an earlier run.
    for (const runId of runIds) {
      const runRecords = pending.filter((record) =>
        record.runId === runId
        && record.workflow === "chat.generic"
      );
      let events: HarnessEvent[];
      try {
        events = await ledger.readRun(runId);
      } catch (error) {
        throw new Error(
          `Chat Run Ledger authority read failed for ${runId}: ${normalizeError(error).message}`,
          { cause: error }
        );
      }
      const terminal = resolveChatStartupTerminal(runId, events);
      if (!terminal) continue;
      const status = runTerminalStatusForEvent(terminal);
      const authority = await this.hasDurableChatTerminalRecoveryMarker(
        runId,
        terminal,
        runRecords
      );
      if (!authority) {
        continue;
      }
      plans.push({ runId, records: runRecords, status, authority });
    }

    let replayed = 0;
    for (const plan of plans) {
      await this.recordChatNativeSettlementIntent(plan.runId, {
        status: plan.status,
        runOutcome: chatRunOutcome(plan.status),
        terminalCommitId: plan.authority.marker.terminalCommitId
      }, "recovery-restart");
      replayed += plan.records.length;
    }
    const retained = await manager.markPendingLocalCommitsFailed(
      CHAT_STARTUP_LOCAL_COMMIT_RECOVERY_REASON,
      { surface: "chat", workflow: "chat.generic" }
    );
    return replayed + retained;
  }

  private async hasDurableChatTerminalRecoveryMarker(
    runId: string,
    terminal: HarnessEvent,
    records: readonly NativeExecutionRecord[]
  ): Promise<ResolvedEchoInkChatRunTerminalRecovery | null> {
    const sessionIds = new Set(records.map((record) => record.sessionId));
    if (sessionIds.size !== 1) return null;
    const sessionId = sessionIds.values().next().value as string | undefined;
    const session = sessionId
      ? this.plugin.settings.sessions.find((candidate) => candidate.id === sessionId)
      : undefined;
    if (!session) return null;
    try {
      const authority = await this.resolveChatTerminalAuthority(
        session,
        runId,
        true
      );
      if (!authority) return null;
      const ledgerTerminal = normalizeChatRunTerminal(
        settleRunTerminalInputForEvent(terminal)
      );
      if (
        authority.marker.payloadHash
          !== chatRunTerminalPayloadHash(ledgerTerminal)
        || authority.marker.terminalCommitId
          !== echoInkChatTerminalCommitId(
            ledgerTerminal,
            authority.marker.carrierMessageId
          )
        || records.some(
          (record) =>
            record.native.backendId !== authority.marker.backendId
        )
      ) {
        return null;
      }
      return authority;
    } catch {
      return null;
    }
  }

  createCodexRichAgentAdapter(
    options: Omit<CodexRichAgentAdapterOptions, "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "archiveThread">
      & Partial<Pick<CodexRichAgentAdapterOptions, "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "archiveThread">>
  ): CodexRichAgentAdapter {
    return new CodexRichAgentAdapter({
      ...options,
      notificationHub: options.notificationHub ?? this.codexRichNotificationHub,
      startThread: options.startThread ?? (async (turnOptions) => await this.startCodexThread(turnOptions)),
      resumeThread: options.resumeThread ?? (async (threadId, turnOptions) => await this.resumeCodexThread(threadId, turnOptions)),
      startTurn: options.startTurn ?? (async (threadId, input, turnOptions) => await this.startCodexTurn(threadId, input, turnOptions)),
      interruptTurn: options.interruptTurn ?? (async (threadId, turnId) => await this.interruptCodexTurn(threadId, turnId)),
      archiveThread: options.archiveThread ?? (async (threadId) => await this.archiveCodexThread(threadId))
    });
  }

  handleCodexNotification(notification: CodexNotification): boolean {
    return this.codexRichNotificationHub.dispatch(notification);
  }

  async startCodexThread(options?: TurnOptions): Promise<{ threadId: string; title: string }> {
    if (!this.plugin.codex) throw new Error("Codex 未连接");
    if (!options) throw new Error("Codex turn options missing");
    return await this.plugin.codex.startThread(options);
  }

  async resumeCodexThread(threadId: string, options?: TurnOptions): Promise<void> {
    if (!this.plugin.codex) throw new Error("Codex 未连接");
    if (!options) throw new Error("Codex turn options missing");
    await this.plugin.codex.resumeThread(threadId, options);
  }

  async startCodexTurn(threadId: string, input: UserInput[], options?: TurnOptions): Promise<string> {
    if (!this.plugin.codex) throw new Error("Codex 未连接");
    if (!options) throw new Error("Codex turn options missing");
    return await this.plugin.codex.startTurn(threadId, input, options);
  }

  async interruptCodexTurn(threadId: string, turnId: string): Promise<void> {
    if (!this.plugin.codex) throw new Error("Codex 未连接");
    await this.plugin.codex.interruptTurn(threadId, turnId);
  }

  async archiveCodexThread(threadId: string): Promise<void> {
    if (!this.plugin.codex?.archiveThread) throw new Error("Codex 不支持归档线程");
    await this.plugin.codex.archiveThread(threadId);
  }

  async buildRuntimeEchoInkResourceCatalog(): Promise<EchoInkResource[]> {
    const vaultResources = await loadVaultEchoInkResources({
      vaultPath: this.plugin.getVaultPath(),
      maxSkillBytes: 200_000
    }).catch((error) => {
      this.plugin.settings.resources.lastError = error instanceof Error ? error.message : String(error);
      return { resources: [], warnings: [] };
    });
    return buildActiveEchoInkResourceCatalog({
      settings: this.plugin.settings.resources,
      manual: vaultResources.resources
    });
  }

  private getHarnessKernel(): EchoInkHarnessKernel {
    const vaultPath = this.plugin.getVaultPath();
    const pluginDir = this.plugin.getPluginDataDirName();
    const key = JSON.stringify({
      vaultPath,
      pluginDir,
      memoryEnabled: this.plugin.settings.memory.enabled,
      memoryAutoSync: this.plugin.settings.memory.autoSync,
      memoryBackend: this.plugin.settings.memory.curatorBackend,
      memoryModel: this.plugin.settings.memory.curatorModel
    });
    if (this.harnessKernel && this.harnessKernelKey === key) return this.harnessKernel;
    this.harnessKernelKey = key;
    this.harnessKernel = new EchoInkHarnessKernel({
      ledger: this.createRunLedger(),
      memoryProvider: this.plugin.settings.memory.enabled ? this.getFileMemoryProvider() : new NoopMemoryProvider(),
      nativeSessionLeaseManager: this.nativeSessionLeaseManager
    });
    return this.harnessKernel;
  }

  private createRunLedger(): FileRunLedger {
    return new FileRunLedger({
      rootPath: path.join(pluginDataDir(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName()), "harness-runs")
    });
  }

  private async prepareRunRecordRetentionRetirementRoots(
    vaultPath: string,
    pluginDir: string
  ): Promise<RunRecordRetentionRetirementRoots> {
    const rootIds: EchoInkRecordMutationRootId[] = [
      ECHOINK_RECORD_MUTATION_ROOT_IDS.run,
      ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    ].sort((left, right) => left.localeCompare(right));
    const prepared = await prepareEchoInkRecordMutationRuntimeRoots({
      vaultPath,
      pluginDir,
      rootIds,
      createdAt: Date.now()
    });
    const source = prepared.roots.find(
      (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.run
    );
    const trash = prepared.roots.find(
      (root) => root.rootId === ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
    );
    if (!source || !trash) {
      throw new Error(
        "Run retention production Root Binding catalog is incomplete"
      );
    }
    return {
      sourceRootPath: echoInkRecordMutationRootPath({
        vaultPath,
        pluginDir,
        rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.run
      }),
      sourceBoundaryRootPath: prepared.storageRootPath,
      sourceRootBinding: source.rootBinding,
      trashRootPath: echoInkRecordMutationRootPath({
        vaultPath,
        pluginDir,
        rootId: ECHOINK_RECORD_MUTATION_ROOT_IDS.trash
      }),
      trashBoundaryRootPath: prepared.storageRootPath,
      trashRootBinding: trash.rootBinding
    };
  }

  private getFileMemoryProvider(): FileMemoryProvider {
    const vaultPath = this.plugin.getVaultPath();
    const key = JSON.stringify({
      vaultPath,
      autoSync: this.plugin.settings.memory.autoSync,
      backend: this.plugin.settings.memory.curatorBackend,
      model: this.plugin.settings.memory.curatorModel
    });
    if (this.fileMemoryProvider && this.fileMemoryProviderKey === key) return this.fileMemoryProvider;
    this.fileMemoryProviderKey = key;
    this.fileMemoryProvider = new FileMemoryProvider({
      vaultPath,
      pluginDir: this.plugin.getPluginDataDirName(),
      autoSync: this.plugin.settings.memory.autoSync,
      curator: new BackendNeutralMemoryCurator(this.plugin)
    });
    return this.fileMemoryProvider;
  }

  private getNativeExecutionManager(): NativeExecutionManager {
    const vaultPath = this.plugin.getVaultPath();
    const pluginDir = this.plugin.getPluginDataDirName();
    const rootPath = path.join(pluginDataDir(vaultPath, pluginDir), "harness-native-executions");
    const key = JSON.stringify({
      rootPath,
      codex: this.getNativeExecutionRefContext("codex-cli").providerEndpoint ?? "",
      opencode: this.getNativeExecutionRefContext("opencode").providerEndpoint ?? "",
      hermes: this.getNativeExecutionRefContext("hermes").providerEndpoint ?? ""
    });
    if (this.nativeExecutionManager && this.nativeExecutionManagerKey === key) return this.nativeExecutionManager;
    this.nativeExecutionManagerKey = key;
    this.nativeExecutionManager = new NativeExecutionManager({
      store: new NativeExecutionStore({ rootPath }),
      adapters: [
        this.createNativeCleanupAdapter("codex-cli"),
        this.createNativeCleanupAdapter("opencode"),
        this.createNativeCleanupAdapter("hermes")
      ],
      emitRunEvent: async (event) => {
        await this.appendRunEvent(event);
      }
    });
    return this.nativeExecutionManager;
  }

  private createNativeCleanupAdapter(backendId: AgentBackendKind): AgentAdapter {
    if (backendId === "codex-cli") {
      return new CodexRichAgentAdapter({
        displayName: "Codex",
        version: "rich-runtime",
        ensureConnected: async () => {
          const status = await this.plugin.ensureHarnessBackendConnected(
            "codex-cli",
            { silent: true }
          );
          return {
            connected: status?.connected === true,
            label: "Codex",
            version: "rich-runtime",
            errors: status?.errors ?? ["Codex cleanup transport is unavailable"]
          };
        },
        getNativeThreadId: () => undefined,
        setNativeThreadId: () => undefined,
        buildInput: () => [],
        startThread: async () => { throw new Error("Cleanup adapter cannot start Codex threads"); },
        resumeThread: async () => undefined,
        startTurn: async () => { throw new Error("Cleanup adapter cannot start Codex turns"); },
        archiveThread: async (threadId) => await this.archiveCodexThread(threadId),
        nativeRefContext: this.getNativeExecutionRefContext("codex-cli")
      });
    }
    return createHarnessAgentAdapter({
      backendId,
      settings: this.plugin.settings,
      vaultPath: this.plugin.getVaultPath(),
      nativeRefContext: this.getNativeExecutionRefContext(backendId)
    });
  }

  private nativeExecutionRetirementRecord(retirement: SessionNativeRetirement): NativeExecutionRecord {
    const backendId = retirement.backendId.trim();
    if (!backendId || retirement.binding.backendId.trim() !== backendId) {
      throw new Error(`Native binding retirement backend mismatch: ${retirement.retirementId}`);
    }
    if (nativeRetirementSourceIdentityState(retirement) === "invalid") {
      throw new Error(
        `Native binding retirement source identity is partial or invalid: ${retirement.retirementId}`
      );
    }
    const native = this.nativeExecutionRefForRetirement(retirement);
    const createdAt = native.createdAt;
    return {
      id: retirement.retirementId,
      runId: retirement.targetStatus === "deleted"
        ? `conversation-deletion:${retirement.recordMutationId}`
        : `context-retirement:${retirement.targetCommitId}`,
      sessionId: retirement.targetConversationId,
      surface: "chat",
      workflow: `session.context-rotation.${retirement.reason}`,
      native,
      policy: {
        historyAuthority: "echoink",
        mode: "leased-conversation",
        preferredDisposition: hasTrustedNativeExecutionIdentity(native)
          ? ["delete", "archive", "process-exit", "retain"]
          : ["retain"],
        retainWhenLocalCommitFails: true,
        cleanupRequiredForTaskSuccess: false
      },
      localCommit: "pending",
      cleanup: "awaiting-local-commit",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
      createdAt,
      settledAt: 0,
      committedAt: 0,
      disposedAt: 0,
      retirement: {
        ...(retirement.recordMutationId
          ? { recordMutationId: retirement.recordMutationId }
          : {}),
        targetConversationId: retirement.targetConversationId,
        ...(Object.prototype.hasOwnProperty.call(
          retirement,
          "sourceGeneration"
        )
          ? { sourceGeneration: retirement.sourceGeneration }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(
          retirement,
          "sourceCommitId"
        )
          ? { sourceCommitId: retirement.sourceCommitId }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(
          retirement,
          "sourceContextId"
        )
          ? { sourceContextId: retirement.sourceContextId }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(
          retirement,
          "sourceWorkspaceFingerprint"
        )
          ? {
            sourceWorkspaceFingerprint:
              retirement.sourceWorkspaceFingerprint
          }
          : {}),
        ...(retirement.targetStatus === "deleted"
          ? {
            targetStatus: "deleted" as const,
            targetTombstoneId: retirement.targetTombstoneId,
            targetTombstoneDigest: retirement.targetTombstoneDigest
          }
          : {
            targetGeneration: retirement.targetGeneration,
            targetCommitId: retirement.targetCommitId,
            ...(retirement.targetContextId
              ? { targetContextId: retirement.targetContextId }
              : {}),
            ...(retirement.targetWorkspaceFingerprint
              ? {
                targetWorkspaceFingerprint:
                  retirement.targetWorkspaceFingerprint
              }
              : {})
          }),
        reason: retirement.reason
      },
      emitEvents: false,
      dispositionReason: "manual"
    };
  }

  private nativeExecutionRetirementRecords(
    retirements: readonly SessionNativeRetirement[]
  ): NativeExecutionRecord[] {
    return uniqueRetirements(retirements).map((retirement) => (
      this.nativeExecutionRetirementRecord(retirement)
    ));
  }

  private nativeExecutionRefForRetirement(retirement: SessionNativeRetirement): NativeExecutionRef {
    const backendId = retirement.backendId.trim();
    const existing = retirement.binding.nativeExecutionRef;
    if (existing) {
      if (existing.backendId.trim() !== backendId) {
        throw new Error(`Native binding retirement ref backend mismatch: ${retirement.retirementId}`);
      }
      if (
        retirement.binding.nativeExecutionKind
        && retirement.binding.nativeExecutionKind !== existing.kind
      ) {
        throw new Error(`Native binding retirement ref kind mismatch: ${retirement.retirementId}`);
      }
      const matchingBindingId = existing.kind === "thread"
        ? retirement.binding.nativeThreadId?.trim()
        : retirement.binding.nativeSessionId?.trim();
      if (matchingBindingId && matchingBindingId !== existing.id.trim()) {
        throw new Error(`Native binding retirement ref id mismatch: ${retirement.retirementId}`);
      }
      return { ...existing, backendId };
    }
    const threadId = retirement.binding.nativeThreadId?.trim() ?? "";
    const sessionId = retirement.binding.nativeSessionId?.trim() ?? "";
    if (threadId && sessionId && threadId !== sessionId) {
      throw new Error(`Native binding retirement has ambiguous native ids: ${retirement.retirementId}`);
    }
    const id = threadId || sessionId;
    if (!id) throw new Error(`Native binding retirement has no native id: ${retirement.retirementId}`);
    return {
      backendId,
      id,
      kind: retirement.binding.nativeExecutionKind
        ?? (retirement.binding.nativeThreadId ? "thread" : "session"),
      persistence: "unknown",
      deviceKey: "unknown",
      vaultId: "unknown",
      createdAt: retirement.binding.leaseCreatedAt ?? retirement.binding.lastUsedAt
    };
  }

  private async retireBindingBeforeReplacement(
    input: BeforeBindingReplacementInput
  ): Promise<void> {
    if (
      input.request.sessionId !== input.session.id
      || input.request.backendId !== input.binding.backendId
    ) {
      throw new Error(
        "Conversation recovery required: Native binding replacement target is inconsistent"
      );
    }
    const authoritative = this.authoritativeSessionForRetirement(input.session);
    if (
      sessionGeneration(authoritative) !== input.expectedIdentity.sessionGeneration
      || normalizedIdentity(authoritative.contextId)
        !== normalizedIdentity(input.expectedIdentity.contextId)
      || normalizedIdentity(authoritative.workspaceFingerprint)
        !== normalizedIdentity(input.expectedIdentity.workspaceFingerprint)
    ) {
      throw new Error(
        "Conversation recovery required: session identity changed before Native binding retirement"
      );
    }
    await this.retireCurrentBackendBinding(authoritative, input.binding);
  }

  private async preparePersistentConversationRun(
    input: HarnessRunWithAdapterInput
  ): Promise<StoredSession | null> {
    if (
      input.request.workflow !== "chat.generic"
      && input.request.workflow !== "knowledge.ask"
    ) {
      return null;
    }
    const authoritative = this.plugin.settings.sessions.find(
      (candidate) => candidate.id === input.request.sessionId
    );
    if (!authoritative) {
      throw new Error(
        `Conversation recovery required: persistent session ${input.request.sessionId} is missing`
      );
    }
    if (input.sessionProvider) {
      const provided = await input.sessionProvider(input.request.sessionId);
      if (provided !== authoritative) {
        throw new Error(
          "Conversation recovery required: persistent run did not resolve the authoritative live session"
        );
      }
    }
    await this.plugin.ensureEchoInkConversationSessionCreated(authoritative);
    await this.plugin.ensureEchoInkSessionContextIdentity(
      authoritative,
      input.request.workspace
    );
    return authoritative;
  }

  private async registerPersistentRunNativeExecution(
    request: HarnessRunRequest,
    native: NativeExecutionRef
  ): Promise<string> {
    const recordId = harnessRunNativeRecordId(request.runId, native);
    const createdAt = native.createdAt || Date.now();
    await this.recordNativeExecution({
      id: recordId,
      runId: request.runId,
      sessionId: request.sessionId,
      surface: request.surface,
      workflow: request.workflow,
      native,
      policy: {
        historyAuthority: "echoink",
        mode: "leased-conversation",
        preferredDisposition: ["retain"],
        retainWhenLocalCommitFails: true,
        cleanupRequiredForTaskSuccess: false
      },
      localCommit: "pending",
      cleanup: "not-needed",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
      createdAt,
      settledAt: 0,
      committedAt: 0,
      disposedAt: 0
    });
    return recordId;
  }

  private async captureChatNativeExecutionReceipt(
    receipt: ChatNativeExecutionReceipt,
    runId: string
  ): Promise<void> {
    const state = this.chatNativeReceiptState(runId);
    const existing = state.receipts.get(receipt.recordId);
    if (existing && !sameChatNativeExecutionReceipt(existing, receipt)) {
      throw new Error(
        `Chat Native execution receipt conflicts for ${receipt.recordId}`
      );
    }
    state.receipts.set(receipt.recordId, receipt);
    if (state.intent) {
      try {
        await this.settleChatNativeReceiptState(runId, state);
        await this.finalizeChatNativeReceiptState(runId, state);
      } catch (error) {
        if (state.strictSettlement) throw error;
        console.error("EchoInk late Chat Native settlement remains pending", error);
      }
    }
  }

  private async closeChatNativeExecutionRegistrations(runId: string): Promise<void> {
    const state = this.chatNativeReceiptState(runId);
    state.registrationsClosed = true;
    if (state.intent) {
      try {
        await this.settleChatNativeReceiptState(runId, state);
        await this.finalizeChatNativeReceiptState(runId, state);
      } catch (error) {
        if (state.strictSettlement) throw error;
        console.error("EchoInk Chat Native registration close remains pending", error);
        this.chatNativeReceipts.delete(runId.trim());
      }
    }
  }

  private async recordChatNativeSettlementIntent(
    runId: string,
    intent: ChatNativeSettlementIntent,
    mode: NonNullable<CommitChatSurfaceTerminalOptions["mode"]> = "live"
  ): Promise<void> {
    const state = this.chatNativeReceiptState(runId);
    if (mode !== "live") state.strictSettlement = true;
    if (state.intent && !sameChatNativeSettlementIntent(state.intent, intent)) {
      throw new Error(
        `Chat Native settlement intent conflicts for ${runId}`
      );
    }
    if (mode === "recovery-restart") {
      await this.hydrateChatNativeExecutionReceipts(runId, state);
      state.registrationsClosed = true;
    }
    if (mode === "live") {
      state.liveTerminalMarkerCommitId = intent.terminalCommitId;
    }
    state.intent = intent;
    await this.settleChatNativeReceiptState(runId, state);
    await this.finalizeChatNativeReceiptState(runId, state);
    if (mode === "recovery-live" && !state.registrationsClosed) {
      throw new Error(
        `Chat Native registrations are still open for ${runId}`
      );
    }
  }

  private async hydrateChatNativeExecutionReceipts(
    runId: string,
    state: ChatNativeReceiptState
  ): Promise<void> {
    const pending = await this.getNativeExecutionManager()
      .listPendingLocalCommits({ surface: "chat" });
    for (const record of pending) {
      if (
        record.runId !== runId
        || record.workflow !== "chat.generic"
      ) continue;
      const receipt: ChatNativeExecutionReceipt = {
        recordId: record.id,
        sessionId: record.sessionId,
        native: record.native
      };
      const existing = state.receipts.get(record.id);
      if (existing && !sameChatNativeExecutionReceipt(existing, receipt)) {
        throw new Error(
          `Chat Native execution receipt conflicts for ${record.id}`
        );
      }
      state.receipts.set(record.id, receipt);
    }
  }

  private async settleChatNativeReceiptState(
    runId: string,
    state: ChatNativeReceiptState
  ): Promise<void> {
    const settlement = state.settlementTail
      .catch(() => undefined)
      .then(async () => {
        const intent = state.intent;
        if (!intent) return;
        const failures: Error[] = [];
        for (const receipt of state.receipts.values()) {
          if (state.settledRecordIds.has(receipt.recordId)) continue;
          const bindingCommitted = this.isChatNativeExecutionDurablyBound(receipt);
          const settlement = {
            recordId: receipt.recordId,
            runOutcome: intent.runOutcome,
            localCommit: bindingCommitted
              ? {
                committed: true as const,
                conversationCommitted: true,
                runLedgerCommitted: true,
                artifactsCommitted: true,
                historyIndexCommitted: true
              }
              : {
                committed: false as const,
                conversationCommitted: true,
                runLedgerCommitted: true,
                artifactsCommitted: true,
                historyIndexCommitted: true,
                error: CHAT_NATIVE_BINDING_RECOVERY_REASON
              }
          };
          let lastError: unknown;
          for (
            let attempt = 1;
            attempt <= CHAT_NATIVE_SETTLEMENT_MAX_ATTEMPTS;
            attempt += 1
          ) {
            try {
              const settled = await this.getNativeExecutionManager()
                .settleRun(settlement);
              if (!settled) {
                throw new Error(
                  `Native execution record not found: ${receipt.recordId}`
                );
              }
              state.settledRecordIds.add(receipt.recordId);
              lastError = undefined;
              break;
            } catch (error) {
              lastError = error;
              if (attempt < CHAT_NATIVE_SETTLEMENT_MAX_ATTEMPTS) {
                await delayChatNativeSettlementRetry();
              }
            }
          }
          if (lastError !== undefined) {
            failures.push(
              new Error(
                `EchoInk Chat Native settlement failed: ${receipt.recordId}`,
                { cause: lastError }
              )
            );
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            `EchoInk Chat Native settlement failed for ${runId}`
          );
        }
      });
    state.settlementTail = settlement;
    await settlement;
  }

  private isChatNativeExecutionDurablyBound(
    receipt: ChatNativeExecutionReceipt
  ): boolean {
    const session = this.plugin.settings.sessions.find(
      (candidate) => candidate.id === receipt.sessionId
    );
    if (!session) return false;
    const binding = session.backendBindings?.[receipt.native.backendId];
    if (!binding) return false;
    if (
      binding.nativeExecutionRef
      && sameNativeExecutionRefIdentity(binding.nativeExecutionRef, receipt.native)
    ) {
      return true;
    }
    if (
      receipt.native.kind === "thread"
      && binding.nativeThreadId?.trim() === receipt.native.id.trim()
    ) {
      return true;
    }
    return receipt.native.kind === "session"
      && binding.nativeSessionId?.trim() === receipt.native.id.trim();
  }

  private async enqueueChatTerminalAuthority<T>(
    runId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error("Chat terminal authority lane requires a runId");
    }
    const previous = this.chatTerminalAuthorityTails.get(normalizedRunId)
      ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    const tail = current.then(
      () => undefined,
      () => undefined
    );
    this.chatTerminalAuthorityTails.set(normalizedRunId, tail);
    try {
      return await current;
    } finally {
      if (this.chatTerminalAuthorityTails.get(normalizedRunId) === tail) {
        this.chatTerminalAuthorityTails.delete(normalizedRunId);
      }
    }
  }

  private async resolveChatTerminalAuthority(
    session: StoredSession,
    runId: string,
    strictProjection: boolean
  ): Promise<ResolvedEchoInkChatRunTerminalRecovery | null> {
    return await resolveEchoInkChatRunTerminalRecovery(
      session.messages,
      runId,
      async (rawRef) => await this.plugin.readRawMessageText(rawRef),
      { strictProjection }
    );
  }

  private async persistChatTerminalAuthority(
    session: StoredSession,
    terminal: PendingRunTerminalRecovery,
    durableAuthority: ResolvedEchoInkChatRunTerminalRecovery | null,
    persistConversation?: (
      winner: SettleRunTerminalInput
    ) => Promise<void>
  ): Promise<void> {
    const snapshot = snapshotChatMessages(session.messages);
    let preserveCommittedReadback = false;
    try {
      applyChatRunTerminalWinner(session.messages, terminal);
      const carrier = chatTerminalCarrier(
        session.messages,
        terminal.runId,
        durableAuthority?.marker.carrierMessageId
      );
      if (!carrier) {
        throw new Error(
          `Chat terminal commit requires a Conversation marker for ${terminal.runId}`
        );
      }
      const projectedText = chatRunTerminalProjectedText(terminal);
      if (projectedText.length > LARGE_MESSAGE_THRESHOLD) {
        carrier.rawRef = echoInkChatTerminalRawRef(terminal, carrier.id);
      }
      if (typeof this.plugin.externalizeMessageText === "function") {
        await this.plugin.externalizeMessageText(carrier, projectedText);
      } else if (projectedText.length > LARGE_MESSAGE_THRESHOLD) {
        throw new Error(
          `Chat terminal Raw persistence is unavailable for ${terminal.runId}`
        );
      }
      const marker = createEchoInkChatRunTerminalRecovery(
        terminal,
        carrier
      );
      if (
        durableAuthority
        && marker.terminalCommitId
          !== durableAuthority.marker.terminalCommitId
      ) {
        throw new Error(
          `Chat terminal authority replacement was rejected for ${terminal.runId}`
        );
      }
      this.setChatTerminalRecoveryMarker(
        session.messages,
        carrier,
        marker
      );
      if (persistConversation) {
        try {
          await persistConversation(terminal);
        } catch (error) {
          const readback = await this.reconcileChatTerminalPersistFailure(
            session,
            terminal.runId,
            marker.terminalCommitId
          );
          if (readback === "not-committed") throw error;
          preserveCommittedReadback = true;
          if (readback === "unknown") {
            throw new Error(
              `Chat terminal Conversation readback is indeterminate for ${terminal.runId}; recovery required`,
              { cause: error }
            );
          }
          if (readback === "conflict") {
            throw new Error(
              `Chat terminal authority conflicts with committed Conversation state for ${terminal.runId}`,
              { cause: error }
            );
          }
        }
      } else {
        try {
          await this.plugin.saveSettings(true);
        } catch (error) {
          const readback = await this.reconcileChatTerminalPersistFailure(
            session,
            terminal.runId,
            marker.terminalCommitId
          );
          if (readback === "not-committed") throw error;
          preserveCommittedReadback = true;
          if (readback === "unknown") {
            throw new Error(
              `Chat terminal Conversation readback is indeterminate for ${terminal.runId}; recovery required`,
              { cause: error }
            );
          }
          if (readback === "conflict") {
            throw new Error(
              `Chat terminal authority conflicts with committed Conversation state for ${terminal.runId}`,
              { cause: error }
            );
          }
        }
      }
      const readback = await this.resolveChatTerminalAuthority(
        session,
        terminal.runId,
        true
      );
      if (
        !readback
        || readback.marker.terminalCommitId !== marker.terminalCommitId
      ) {
        throw new Error(
          `Chat terminal authority readback failed for ${terminal.runId}`
        );
      }
    } catch (error) {
      if (!preserveCommittedReadback) {
        restoreChatMessages(session.messages, snapshot);
      }
      throw error;
    }
  }

  private async reconcileChatTerminalPersistFailure(
    session: StoredSession,
    runId: string,
    terminalCommitId: string
  ): Promise<"committed" | "not-committed" | "conflict" | "unknown"> {
    if (typeof this.plugin.readEchoInkConversationSession !== "function") {
      return "unknown";
    }
    let committedSession: StoredSession | null;
    try {
      committedSession = await this.plugin.readEchoInkConversationSession(
        session.id
      );
    } catch {
      return "unknown";
    }
    if (!committedSession) return "unknown";
    let committedAuthority: ResolvedEchoInkChatRunTerminalRecovery | null;
    try {
      committedAuthority = await this.resolveChatTerminalAuthority(
        committedSession,
        runId,
        true
      );
    } catch {
      return "unknown";
    }
    if (!committedAuthority) return "not-committed";
    applyCommittedChatMessages(
      session.messages,
      committedSession.messages
    );
    return committedAuthority.marker.terminalCommitId === terminalCommitId
      ? "committed"
      : "conflict";
  }

  private setChatTerminalRecoveryMarker(
    messages: ChatMessage[],
    carrier: ChatMessage,
    marker: EchoInkChatRunTerminalRecovery
  ): void {
    const runMessages = messages.filter(
      (message) => message.runId === marker.runId
    );
    if (!runMessages.includes(carrier)) {
      throw new Error(
        `Chat terminal carrier is missing for ${marker.runId}`
      );
    }
    for (const message of runMessages) {
      delete message.runTerminalRecoveryPending;
      delete message.echoInkRunTerminalRecovery;
    }
    carrier.runTerminalRecoveryPending = marker.status;
    carrier.echoInkRunTerminalRecovery = marker;
    delete carrier.runTerminalRecovered;
  }

  private async clearChatTerminalRecoveryPending(
    runId: string,
    terminalCommitId: string
  ): Promise<void> {
    const markerSessions = this.plugin.settings.sessions
      .filter((session) => session.messages.some((message) =>
        message.runId === runId
        && (
          message.runTerminalRecoveryPending !== undefined
          || message.echoInkRunTerminalRecovery !== undefined
        )
      ));
    const markers = markerSessions
      .flatMap((session) => session.messages)
      .filter((message) =>
        message.runId === runId
        && (
          message.runTerminalRecoveryPending !== undefined
          || message.echoInkRunTerminalRecovery !== undefined
        )
      );
    if (!markers.length) return;
    if (markerSessions.length !== 1) {
      throw new Error(
        `Chat terminal recovery marker spans multiple Conversations for ${runId}`
      );
    }
    const session = markerSessions[0];
    const conflict = markers.find((message) =>
      !message.echoInkRunTerminalRecovery
      || message.runTerminalRecoveryPending
        !== message.echoInkRunTerminalRecovery.status
      || message.echoInkRunTerminalRecovery.terminalCommitId
        !== terminalCommitId
    );
    if (conflict) {
      throw new Error(
        `Chat terminal recovery marker conflict for ${runId}: expected ${terminalCommitId}`
      );
    }
    const previous = markers.map((message) => ({
      message,
      pending: message.runTerminalRecoveryPending,
      authority: message.echoInkRunTerminalRecovery,
      recovered: message.runTerminalRecovered
    }));
    for (const marker of markers) {
      delete marker.runTerminalRecoveryPending;
      delete marker.echoInkRunTerminalRecovery;
      marker.runTerminalRecovered = true;
    }
    try {
      await this.plugin.saveSettings(true);
    } catch (error) {
      const readback = await this.reconcileChatTerminalClearFailure(
        session,
        runId,
        terminalCommitId,
        previous.map((snapshot) => snapshot.message.id)
      );
      if (readback === "cleared") return;
      if (readback === "unknown") {
        throw new Error(
          `Chat terminal recovery clear readback is indeterminate for ${runId}; recovery required`,
          { cause: error }
        );
      }
      if (readback === "conflict") {
        throw new Error(
          `Chat terminal recovery clear conflicts with committed Conversation state for ${runId}`,
          { cause: error }
        );
      }
      for (const snapshot of previous) {
        snapshot.message.runTerminalRecoveryPending = snapshot.pending;
        snapshot.message.echoInkRunTerminalRecovery = snapshot.authority;
        if (snapshot.recovered === undefined) {
          delete snapshot.message.runTerminalRecovered;
        } else {
          snapshot.message.runTerminalRecovered = snapshot.recovered;
        }
      }
      throw error;
    }
  }

  private async reconcileChatTerminalClearFailure(
    session: StoredSession,
    runId: string,
    terminalCommitId: string,
    clearedMessageIds: readonly string[]
  ): Promise<"cleared" | "not-cleared" | "conflict" | "unknown"> {
    if (typeof this.plugin.readEchoInkConversationSession !== "function") {
      return "unknown";
    }
    let committedSession: StoredSession | null;
    try {
      committedSession = await this.plugin.readEchoInkConversationSession(
        session.id
      );
    } catch {
      return "unknown";
    }
    if (!committedSession) return "unknown";
    const committedRunMessages = committedSession.messages.filter(
      (message) => message.runId === runId
    );
    const hasRecoveryMarker = committedRunMessages.some((message) =>
      message.runTerminalRecoveryPending !== undefined
      || message.echoInkRunTerminalRecovery !== undefined
    );
    if (!hasRecoveryMarker) {
      const clearedProjectionIsCommitted = clearedMessageIds.every(
        (messageId) => {
          const message = committedRunMessages.find(
            (candidate) => candidate.id === messageId
          );
          return Boolean(
            message
            && message.runTerminalRecovered === true
            && message.runTerminalRecoveryPending === undefined
            && message.echoInkRunTerminalRecovery === undefined
          );
        }
      );
      applyCommittedChatMessages(
        session.messages,
        committedSession.messages
      );
      return clearedProjectionIsCommitted ? "cleared" : "conflict";
    }
    let committedAuthority: ResolvedEchoInkChatRunTerminalRecovery | null;
    try {
      committedAuthority = await this.resolveChatTerminalAuthority(
        committedSession,
        runId,
        true
      );
    } catch {
      return "unknown";
    }
    if (!committedAuthority) return "unknown";
    applyCommittedChatMessages(
      session.messages,
      committedSession.messages
    );
    return committedAuthority.marker.terminalCommitId === terminalCommitId
      ? "not-cleared"
      : "conflict";
  }

  private chatNativeReceiptState(runId: string): ChatNativeReceiptState {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error("Chat Native receipt requires a runId");
    }
    let state = this.chatNativeReceipts.get(normalizedRunId);
    if (!state) {
      while (this.chatNativeReceipts.size >= MAX_CHAT_NATIVE_RECEIPT_STATES) {
        const oldestRunId = this.chatNativeReceipts.keys().next().value as string | undefined;
        if (!oldestRunId) break;
        this.chatNativeReceipts.delete(oldestRunId);
      }
      state = {
        receipts: new Map(),
        settledRecordIds: new Set(),
        registrationsClosed: false,
        strictSettlement: false,
        settlementTail: Promise.resolve()
      };
      this.chatNativeReceipts.set(normalizedRunId, state);
    }
    return state;
  }

  private async finalizeChatNativeReceiptState(
    runId: string,
    state: ChatNativeReceiptState
  ): Promise<void> {
    if (
      !state.registrationsClosed
      || !state.intent
      || state.settledRecordIds.size !== state.receipts.size
    ) return;
    if (state.liveTerminalMarkerCommitId) {
      try {
        await this.clearChatTerminalRecoveryPending(
          runId,
          state.liveTerminalMarkerCommitId
        );
      } catch (error) {
        console.error(
          `EchoInk Chat terminal recovery marker remains pending: ${runId}`,
          error
        );
      }
    }
    if (this.chatNativeReceipts.get(runId.trim()) === state) {
      this.chatNativeReceipts.delete(runId.trim());
    }
  }

  private async failUndeliveredPersistentNativeExecutions(
    recordIds: ReadonlySet<string>,
    error: unknown
  ): Promise<void> {
    if (!recordIds.size) return;
    const manager = this.getNativeExecutionManager();
    const message = error instanceof Error ? error.message : String(error);
    for (const recordId of recordIds) {
      await manager.settleRun({
        recordId,
        runOutcome: "failed",
        localCommit: {
          committed: false,
          conversationCommitted: false,
          runLedgerCommitted: false,
          artifactsCommitted: false,
          historyIndexCommitted: false,
          error: `Harness result was not delivered to the surface: ${message}`
        }
      }).catch((settlementError) => {
        console.error("EchoInk undelivered Native execution settlement failed", settlementError);
      });
    }
  }

  private async retireLeaseBinding(
    input: NativeSessionLeaseRetirementInput
  ): Promise<void> {
    if (
      input.lease.echoInkSessionId !== input.session.id
      || input.lease.backendId !== input.binding.backendId
      || input.binding.leaseId !== input.lease.leaseId
    ) {
      throw new Error(
        "Conversation recovery required: Native lease retirement target is inconsistent"
      );
    }
    const authoritative = this.authoritativeSessionForRetirement(input.session);
    await this.retireCurrentBackendBinding(authoritative, input.binding);
  }

  private authoritativeSessionForRetirement(session: StoredSession): StoredSession {
    const authoritative = this.plugin.settings.sessions.find(
      (candidate) => candidate.id === session.id
    );
    if (!authoritative || authoritative !== session) {
      throw new Error(
        "Conversation recovery required: Native binding is not attached to the authoritative live session"
      );
    }
    return authoritative;
  }

  private async retireCurrentBackendBinding(
    session: StoredSession,
    capturedBinding: BackendSessionBinding
  ): Promise<void> {
    const backendId = capturedBinding.backendId.trim();
    const currentBinding = session.backendBindings?.[backendId];
    if (
      !backendId
      || !currentBinding
      || bindingIdentityKey(currentBinding) !== bindingIdentityKey(capturedBinding)
    ) {
      throw new Error(
        "Conversation recovery required: Native binding changed before durable retirement"
      );
    }
    await this.plugin.rotateEchoInkSessionContext(session, {
      reason: "lease-rollover",
      advanceContext: false,
      retireBackendIds: [backendId]
    });
  }

  private async requireNativeCleanupAuthority(): Promise<void> {
    if (this.nativeCleanupAuthorityReady) return;
    const reconciliation = this.nativeStartupReconciliationFlight;
    if (reconciliation) {
      await reconciliation;
      if (this.nativeCleanupAuthorityReady) return;
    }
    throw new Error(
      this.nativeCleanupAuthorityFailure
        ? `${NATIVE_CLEANUP_AUTHORITY_BLOCKED_REASON}: ${this.nativeCleanupAuthorityFailure.message}`
        : NATIVE_CLEANUP_AUTHORITY_BLOCKED_REASON,
      this.nativeCleanupAuthorityFailure
        ? { cause: this.nativeCleanupAuthorityFailure }
        : undefined
    );
  }

  private getNativeExecutionDeviceKey(): string {
    if (this.nativeExecutionDeviceKey) return this.nativeExecutionDeviceKey;
    const storageKey = `codex-echoink:native-device:${this.plugin.getVaultPath()}`;
    try {
      const stored = globalThis.localStorage?.getItem(storageKey)?.trim();
      if (stored) return (this.nativeExecutionDeviceKey = stored);
    } catch {
      // Local storage can be unavailable in headless tests.
    }
    const generated = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try {
      globalThis.localStorage?.setItem(storageKey, generated);
    } catch {
      // Keep the in-memory key for this plugin process.
    }
    return (this.nativeExecutionDeviceKey = generated);
  }
}

function uniqueRetirements(
  retirements: readonly SessionNativeRetirement[]
): SessionNativeRetirement[] {
  const unique = new Map<string, SessionNativeRetirement>();
  for (const retirement of retirements) {
    const existing = unique.get(retirement.retirementId);
    if (existing && retirementIdentityKey(existing) !== retirementIdentityKey(retirement)) {
      throw new Error(
        `Native binding retirement batch identity conflict: ${retirement.retirementId}`
      );
    }
    if (!existing) unique.set(retirement.retirementId, retirement);
  }
  return Array.from(unique.values());
}

interface ChatMessagesSnapshot {
  entries: Array<{
    message: ChatMessage;
    value: ChatMessage;
  }>;
}

function snapshotChatMessages(
  messages: ChatMessage[]
): ChatMessagesSnapshot {
  return {
    entries: messages.map((message) => ({
      message,
      value: structuredClone(message)
    }))
  };
}

function restoreChatMessages(
  messages: ChatMessage[],
  snapshot: ChatMessagesSnapshot
): void {
  for (const entry of snapshot.entries) {
    const target = entry.message as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(entry.value));
  }
  messages.splice(
    0,
    messages.length,
    ...snapshot.entries.map((entry) => entry.message)
  );
}

function applyCommittedChatMessages(
  messages: ChatMessage[],
  committedMessages: readonly ChatMessage[]
): void {
  const reusableById = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const reusable = reusableById.get(message.id) ?? [];
    reusable.push(message);
    reusableById.set(message.id, reusable);
  }
  const nextMessages = committedMessages.map((committed) => {
    const reusable = reusableById.get(committed.id);
    const target = reusable?.shift() ?? structuredClone(committed);
    const record = target as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, structuredClone(committed));
    return target;
  });
  messages.splice(0, messages.length, ...nextMessages);
}

function assertRecoverableHermesProposalHostNativeRecord(
  record: NativeExecutionRecord
): void {
  if (
    record.surface !== "knowledge"
    || record.policy.mode !== "ephemeral-run"
    || record.localCommit !== "pending"
    || record.cleanup !== "not-needed"
    || record.retirement !== undefined
    || !record.id.trim()
    || !record.runId.trim()
    || !record.sessionId.trim()
    || !record.workflow.trim()
    || !isHermesProposalHostExecutionRef(record.native)
    || (
      record.observedDisposition !== undefined
      && !isValidEchoInkHostProcessDispositionReceipt(
        record.native,
        record.observedDisposition
      )
    )
  ) {
    throw new Error(
      `Hermes proposal Native startup recovery found an invalid pending record: ${record.id || "<missing-id>"}`
    );
  }
}

function resolveHermesProposalHostStartupPlan(
  runId: string,
  record: NativeExecutionRecord,
  events: readonly HarnessEvent[]
): HermesProposalHostStartupSettlementPlan {
  if (record.runId !== runId) {
    throw new Error(
      `Hermes proposal Native record has a conflicting run identity: ${record.id}`
    );
  }
  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSequence = index + 1;
    if (
      event.runId !== runId
      || !event.eventId?.trim()
      || !Number.isSafeInteger(event.sequence)
      || event.sequence !== expectedSequence
      || !Number.isFinite(event.createdAt)
      || event.createdAt < 0
      || typeof event.type !== "string"
      || typeof event.source !== "string"
    ) {
      throw new Error(
        `Hermes proposal Run Ledger has an invalid event sequence or identity for ${runId}`
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(
        `Hermes proposal Run Ledger has a duplicate event identity for ${runId}: ${event.eventId}`
      );
    }
    eventIds.add(event.eventId);
  }

  const created = events.filter((event) => event.type === "run.created");
  const started = events.filter((event) => event.type === "run.started");
  if (
    created.length !== 1
    || started.length !== 1
    || events[0] !== created[0]
    || events[1] !== started[0]
    || created[0].source !== "kernel"
    || started[0].source !== "kernel"
    || started[0].backendId !== "hermes"
  ) {
    throw new Error(
      `Hermes proposal Run Ledger must begin with one run.created then one run.started for ${runId}`
    );
  }
  const startedData = started[0].data;
  if (
    startedData?.sessionId !== record.sessionId
    || startedData?.surface !== record.surface
    || startedData?.workflow !== record.workflow
  ) {
    throw new Error(
      `Hermes proposal run.started authority does not match Native identity for ${runId}`
    );
  }

  const nativeCreated = events.filter(
    (event) => event.type === "agent.native_execution.created"
  );
  if (nativeCreated.length > 1) {
    throw new Error(
      `Hermes proposal Run Ledger has ambiguous Native creation authority for ${runId}`
    );
  }
  if (nativeCreated.length === 1) {
    const nativeEvent = nativeCreated[0];
    const data = nativeEvent.data;
    if (
      nativeEvent.source !== "agent"
      || nativeEvent.backendId !== "hermes"
      || data?.nativeExecutionId !== record.native.id
      || data?.nativeExecutionKind !== "process"
      || data?.nativeExecutionPersistence !== "process-local"
      || data?.identityAuthority !== "echoink-host"
      || data?.targetBackendId !== "hermes"
      || data?.backendNativeIdentity !== "unavailable-before-prompt"
    ) {
      throw new Error(
        `Hermes proposal Native creation event does not match the host identity for ${runId}`
      );
    }
  }

  const terminals = events.filter(isRunTerminalEvent);
  if (terminals.length > 1) {
    throw new Error(
      `Hermes proposal Run Ledger has ambiguous terminal authority for ${runId}`
    );
  }
  const terminal = terminals[0] ?? null;
  const terminalIndex = terminal ? events.indexOf(terminal) : -1;
  if (
    terminal
    && (
      terminalIndex <= 1
      || terminal.source !== "kernel"
      || terminal.backendId !== "hermes"
    )
  ) {
    throw new Error(
      `Hermes proposal Run Ledger terminal authority is invalid for ${runId}`
    );
  }
  if (terminal) {
    assertHermesProposalTerminalHostAuthority(runId, record, terminal);
  }

  const localCommitStarted = events.filter(
    (event) => event.type === "run.local_commit.started"
  );
  const localCommitCompleted = events.filter(
    (event) => event.type === "run.local_commit.completed"
  );
  const localCommitFailed = events.filter(
    (event) => event.type === "run.local_commit.failed"
  );
  if (
    localCommitStarted.length > 1
    || localCommitCompleted.length > 1
    || localCommitFailed.length > 1
    || (
      localCommitCompleted.length
      && localCommitFailed.length
    )
  ) {
    throw new Error(
      `Hermes proposal Run Ledger has conflicting local-commit authority for ${runId}`
    );
  }
  const localCommitEvents = [
    ...localCommitStarted,
    ...localCommitCompleted,
    ...localCommitFailed
  ];
  if (localCommitEvents.some((event) => event.source !== "workflow")) {
    throw new Error(
      `Hermes proposal local-commit authority has an invalid source for ${runId}`
    );
  }
  if (!terminal && localCommitEvents.length) {
    throw new Error(
      `Hermes proposal Run Ledger has local-commit evidence before a terminal for ${runId}`
    );
  }
  if (localCommitEvents.length) {
    const startedIndex = localCommitStarted.length
      ? events.indexOf(localCommitStarted[0])
      : -1;
    const outcomeEvent =
      localCommitCompleted[0] ?? localCommitFailed[0];
    const outcomeIndex = outcomeEvent
      ? events.indexOf(outcomeEvent)
      : -1;
    if (
      startedIndex <= terminalIndex
      || (
        outcomeEvent
        && outcomeIndex <= startedIndex
      )
    ) {
      throw new Error(
        `Hermes proposal local-commit events are out of order for ${runId}`
      );
    }
  }
  if (terminal) {
    const trailing = events.slice(terminalIndex + 1);
    if (trailing.some((event) => (
      event.type !== "run.local_commit.started"
      && event.type !== "run.local_commit.completed"
      && event.type !== "run.local_commit.failed"
    ))) {
      throw new Error(
        `Hermes proposal Run Ledger has events after terminal outside local commit for ${runId}`
      );
    }
  }

  return {
    runId,
    record,
    terminal,
    localCommitCompleted: localCommitCompleted.length === 1
  };
}

function assertHermesProposalTerminalHostAuthority(
  runId: string,
  record: NativeExecutionRecord,
  terminal: HarnessEvent
): void {
  const data = terminal.data;
  const hostAuthorityValues = [
    data?.hostExecutionId,
    data?.identityAuthority,
    data?.backendNativeIdentity,
    data?.hostProcessDisposition,
    data?.hostProcessDispositionObservedAt
  ];
  const hasAnyHostAuthority = hostAuthorityValues.some(
    (value) => value !== undefined
  );
  const hasCompleteHostAuthority = hostAuthorityValues.every(
    (value) => value !== undefined
  );
  const receipt = record.observedDisposition;

  if (terminal.type === "run.completed") {
    if (!receipt || receipt.state !== "exited") {
      throw new Error(
        `Hermes proposal completed terminal requires an exited host process receipt for ${runId}`
      );
    }
    if (!hasCompleteHostAuthority) {
      throw new Error(
        `Hermes proposal completed terminal is missing exact host disposition authority for ${runId}`
      );
    }
  } else if (!hasAnyHostAuthority) {
    // Failed/cancelled runs can terminate before the adapter returns terminal
    // host metadata. The Native receipt, when present, remains orthogonal
    // durable evidence and is never inferred from the terminal.
    return;
  } else if (!hasCompleteHostAuthority) {
    throw new Error(
      `Hermes proposal terminal has partial host disposition authority for ${runId}`
    );
  }

  if (
    data?.hostExecutionId !== record.native.id
    || data.identityAuthority !== "echoink-host"
    || data.backendNativeIdentity !== "unavailable-before-prompt"
  ) {
    throw new Error(
      `Hermes proposal terminal host identity does not match Native authority for ${runId}`
    );
  }
  if (
    !receipt
    || data.hostProcessDisposition !== receipt.state
    || data.hostProcessDispositionObservedAt !== receipt.observedAt
  ) {
    throw new Error(
      `Hermes proposal terminal host disposition does not match Native receipt for ${runId}`
    );
  }
}

function chatTerminalCarrier(
  messages: ChatMessage[],
  runId: string,
  preferredMessageId?: string
): ChatMessage | null {
  const runMessages = messages.filter(
    (message) => message.runId === runId
  );
  if (preferredMessageId) {
    const preferred = runMessages.find(
      (message) => message.id === preferredMessageId
    );
    if (!preferred) {
      throw new Error(
        `Chat terminal carrier ${preferredMessageId} is missing for ${runId}`
      );
    }
    return preferred;
  }
  return [...runMessages].reverse().find((message) =>
    message.role === "assistant"
    && (!message.itemType || message.itemType === "assistant")
  ) ?? runMessages.at(-1) ?? null;
}

function assertRecoverableEditorNativeRecord(
  record: NativeExecutionRecord
): void {
  if (
    record.surface !== "editor"
    || record.policy.mode !== "ephemeral-run"
    || record.localCommit !== "pending"
    || record.cleanup !== "not-needed"
    || record.retirement !== undefined
    || !record.id.trim()
    || !record.runId.trim()
    || !record.sessionId.trim()
    || !record.workflow.trim()
    || !record.native.backendId.trim()
  ) {
    throw new Error(
      `Editor Native startup recovery found an invalid pending record: ${record.id || "<missing-id>"}`
    );
  }
}

function resolveEditorStartupTerminal(
  runId: string,
  records: readonly NativeExecutionRecord[],
  events: readonly HarnessEvent[]
): HarnessEvent | null {
  const sessionIds = new Set(records.map((record) => record.sessionId.trim()));
  const workflows = new Set(records.map((record) => record.workflow.trim()));
  const backendIds = new Set(records.map((record) => record.native.backendId.trim()));
  if (sessionIds.size !== 1 || workflows.size !== 1 || backendIds.size !== 1) {
    throw new Error(
      `Editor Native records have conflicting authority identity for ${runId}`
    );
  }

  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSequence = index + 1;
    if (
      event.runId !== runId
      || !event.eventId?.trim()
      || !Number.isSafeInteger(event.sequence)
      || event.sequence !== expectedSequence
      || !Number.isFinite(event.createdAt)
      || event.createdAt < 0
      || typeof event.type !== "string"
      || typeof event.source !== "string"
    ) {
      throw new Error(
        `Editor Run Ledger has an invalid event sequence or identity for ${runId}`
      );
    }
    if (eventIds.has(event.eventId)) {
      throw new Error(
        `Editor Run Ledger has a duplicate event identity for ${runId}: ${event.eventId}`
      );
    }
    eventIds.add(event.eventId);
  }

  const terminals = events.filter(isRunTerminalEvent);
  if (!terminals.length) return null;
  if (terminals.length !== 1) {
    throw new Error(
      `Editor Run Ledger has ambiguous terminal authority for ${runId}`
    );
  }
  const terminal = terminals[0];
  const expectedBackendId = backendIds.values().next().value as string;
  if (
    terminal.source !== "kernel"
    || terminal.backendId?.trim() !== expectedBackendId
  ) {
    throw new Error(
      `Editor Run Ledger terminal authority does not match Native backend for ${runId}`
    );
  }
  return terminal;
}

function memoryTransactionAuthorityIdForUtilityRecords(
  records: readonly NativeExecutionRecord[]
): string {
  const transactionIds = new Set<string>();
  for (const record of records) {
    const authority = record.localCommitAuthority;
    if (
      record.workflow !== "memory.curate"
      || authority?.kind !== "memory-transaction"
      || !authority.transactionId.trim()
    ) {
      throw new Error(
        `Memory Curator Native record is missing formal transaction authority: ${record.id}`
      );
    }
    transactionIds.add(authority.transactionId.trim());
  }
  if (transactionIds.size !== 1) {
    throw new Error(
      `Memory Curator Native records have conflicting transaction authority for ${records[0]?.runId ?? "<missing-run>"}`
    );
  }
  return transactionIds.values().next().value as string;
}

function nativeRunOutcomeForTerminal(event: HarnessEvent): NativeRunOutcome {
  if (event.type === "run.completed") return "success";
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "run.failed") return "failed";
  throw new Error(`Editor Run Ledger event is not terminal: ${event.type}`);
}

function runTerminalStatusForEvent(event: HarnessEvent): RunTerminalStatus {
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "run.failed") return "failed";
  throw new Error(
    `Chat surface terminal commit returned a non-terminal event: ${event.type}`
  );
}

function isRunTerminalEvent(event: HarnessEvent): boolean {
  return event.type === "run.completed"
    || event.type === "run.failed"
    || event.type === "run.cancelled";
}

function resolveChatStartupTerminal(
  runId: string,
  events: readonly HarnessEvent[]
): HarnessEvent | null {
  const terminals = events.filter(isRunTerminalEvent);
  if (terminals.length > 1) {
    throw new Error(
      `Chat Run Ledger has ambiguous terminal authority for ${runId}`
    );
  }
  const terminal = terminals[0] ?? null;
  if (!terminal) return null;
  if (terminal.runId !== runId || terminal.source !== "kernel") {
    throw new Error(
      `Chat Run Ledger terminal authority is invalid for ${runId}`
    );
  }
  const terminalIndex = events.indexOf(terminal);
  const trailing = events.slice(terminalIndex + 1);
  if (trailing.some((event) => !isChatPostTerminalLifecycleEvent(event))) {
    throw new Error(
      `Chat Run Ledger has events after terminal outside post-terminal lifecycle for ${runId}`
    );
  }
  return terminal;
}

function isChatPostTerminalLifecycleEvent(event: HarnessEvent): boolean {
  return event.type === "run.local_commit.started"
    || event.type === "run.local_commit.completed"
    || event.type === "run.local_commit.failed"
    || event.type === "run.surface_terminal.ignored"
    || event.type === "agent.native_cleanup.scheduled"
    || event.type === "agent.native_cleanup.started"
    || event.type === "agent.native_cleanup.completed"
    || event.type === "agent.native_cleanup.unsupported"
    || event.type === "agent.native_cleanup.failed"
    || event.type === "agent.native_cleanup.retained"
    || event.type === "agent.native_cleanup.quarantined";
}

function settleRunTerminalInputForEvent(
  event: HarnessEvent
): SettleRunTerminalInput {
  return {
    runId: event.runId,
    status: runTerminalStatusForEvent(event),
    ...(event.backendId ? { backendId: event.backendId } : {}),
    ...(event.text !== undefined ? { text: event.text } : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
    ...(event.data ? { data: event.data } : {})
  };
}

function chatRunOutcome(
  status: RunTerminalStatus
): ChatNativeSettlementIntent["runOutcome"] {
  if (status === "completed") return "success";
  return status;
}

async function delayChatNativeSettlementRetry(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, CHAT_NATIVE_SETTLEMENT_RETRY_DELAY_MS);
  });
}

function sameChatNativeExecutionReceipt(
  left: ChatNativeExecutionReceipt,
  right: ChatNativeExecutionReceipt
): boolean {
  return left.recordId === right.recordId
    && left.sessionId === right.sessionId
    && sameNativeExecutionRefIdentity(left.native, right.native);
}

function sameChatNativeSettlementIntent(
  left: ChatNativeSettlementIntent,
  right: ChatNativeSettlementIntent
): boolean {
  return left.status === right.status
    && left.runOutcome === right.runOutcome
    && left.terminalCommitId === right.terminalCommitId;
}

function sameNativeExecutionRefIdentity(
  left: NativeExecutionRef,
  right: NativeExecutionRef
): boolean {
  return left.backendId.trim() === right.backendId.trim()
    && left.id.trim() === right.id.trim()
    && left.kind === right.kind
    && left.persistence === right.persistence
    && normalizedIdentity(left.providerEndpoint)
      === normalizedIdentity(right.providerEndpoint)
    && left.deviceKey.trim() === right.deviceKey.trim()
    && left.vaultId.trim() === right.vaultId.trim();
}

function retirementIdentityKey(retirement: SessionNativeRetirement): string {
  return JSON.stringify(canonicalIdentityValue(retirement));
}

function bindingIdentityKey(binding: BackendSessionBinding): string {
  return JSON.stringify(canonicalIdentityValue(binding));
}

function normalizedIdentity(value: string | undefined): string {
  return value?.trim() || "";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function canonicalIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIdentityValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalIdentityValue(entry)])
  );
}

function harnessRunNativeRecordId(
  runId: string,
  native: NativeExecutionRef
): string {
  const identity = JSON.stringify([
    native.backendId,
    native.id,
    native.kind,
    native.providerEndpoint ?? null,
    native.deviceKey,
    native.vaultId
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `harness-native:${runId}:${native.backendId}:${digest}`;
}
