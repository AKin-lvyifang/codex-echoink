import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "path";
import type CodexForObsidianPlugin from "../main";
import type { AgentRunResult } from "../harness/agents/adapter";
import { HermesProposalHostAgentAdapter } from "../harness/agents/adapters/hermes-proposal-host-adapter";
import {
  harnessBackendDisplayName,
  harnessKnowledgeTaskNativeExecutionKind,
  harnessKnowledgeTaskNativeExecutionPersistence,
  harnessKnowledgeTaskTimeoutMs,
  harnessMessageModelId
} from "../harness/agents/backend-runtime-profile";
import {
  isHermesProposalHostExecutionRef,
  type LocalRunCommitResult,
  type NativeCleanupStatus,
  type NativeExecutionRecord,
  type NativeExecutionRef,
  type NativeRunOutcome,
  type NativeSessionPolicy
} from "../harness/contracts/native-execution";
import type { HarnessRunResult, HarnessWorkflow } from "../harness/contracts/run";
import type { ContextSection } from "../harness/contracts/context";
import type { SettleRunTerminalInput } from "../harness/kernel/run-orchestrator";
import { updateSessionBackendBinding } from "../harness/kernel/session-service";
import type { NativeCleanupResult } from "../harness/native/native-execution-manager";
import { memoryRequestPolicy } from "../harness/memory/workflow-policy";
import { resourceSelectionFromPreparedResources } from "../resources/registry";
import {
  ensureKnowledgeBaseSession,
  newId,
  providerConnectionLabel,
  type KnowledgeBaseManagedThread,
  type KnowledgeBaseManagedThreadKind
} from "../settings/settings";
import type {
  AgentBackendKind,
  AgentExactWriteFenceContext,
  AgentExactWriteFenceReceipt,
  AgentTaskInput
} from "../agent/types";
import { NativeRunRegistrationError } from "../agent/types";
import {
  assertExactWriteFenceRequest,
  createExactWriteFenceReceipt,
  deliverExactWriteFenceReceipt
} from "../agent/write-fence";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { PermissionMode } from "../types/app-server";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { resolveHermesCommand } from "../core/hermes-models";
import {
  createHermesProposalLease,
  hermesProposalInvocationInputDigest,
  HermesProposalRuntimeError,
  probeHermesVaultNoWriteCapability,
  revokeHermesProposalLease,
  runHermesProposalInvocation,
  type HermesProposalCredentialFile,
  type HermesProposalLaunchInspector,
  type HermesProposalProcessRunner,
  type HermesProposalProjectResolver,
  type HermesVaultNoWriteCapability,
  type HermesVaultNoWriteAuthorityReceipt
} from "../core/hermes-proposal-runtime";
import { materializeHermesMaintenanceProposal } from "../harness/maintenance/hermes-proposal-materializer";
import { prepareHermesMaintenanceProposalInput } from "../harness/maintenance/hermes-proposal-input";
import {
  buildCodexKnowledgeInput,
  collectKnowledgeJournalHistoryForBackend,
  formatDurationForError,
  KnowledgeAgentRuntimeController,
  normalizeCodexInactivityTimeoutMs,
  normalizeHermesTaskTimeoutMs,
  rejectAfterTimeout,
  type KnowledgeAgentArtifactRecovery,
  type KnowledgeJournalNativeHistory,
  type KnowledgeAgentTaskOutput
} from "./agent-runner";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseTurnOptionOverrides } from "./command-router";
import type { KnowledgeBaseSource } from "./types";
import {
  issueKnowledgeAgentNativeTerminationReceipt,
  nativeTerminationReceiptFrom,
  type KnowledgeAgentNativeTerminationReceipt
} from "./native-termination";

type PendingNativeExecutionCommit = {
  runId: string;
  runOutcome: NativeRunOutcome;
  recoveryRecord: NativeExecutionRecord;
  missingReceiptWarning?: string;
};

const SETTLED_NATIVE_EXECUTION_RUN_RECEIPT_LIMIT = 256;

export interface KnowledgeBaseNativeLifecycleSummary {
  localCommitStatus?: "committed" | "failed";
  cleanupStatuses: NativeCleanupStatus[];
  cleanupAttempted: boolean;
  disposedCount: number;
  recordIds: string[];
  recoveryRequired: boolean;
  warning?: string;
}

export interface KnowledgeBaseScopedNativeSettlement {
  requestedRunIds: string[];
  matchedRunIds: string[];
  matchedRecordCount: number;
  localCommitStatus: "committed" | "failed" | "not-applicable";
  cleanupRecoveryRequired: boolean;
  disposedCount: number;
}

export interface KnowledgeBaseAgentTaskServiceContext {
  isCancelRequested(): boolean;
}

export interface KnowledgeBaseAgentTaskServiceDependencies {
  /** Test-only Hermes proposal probe seams; production callers omit all. */
  hermesProposalCommand?: string;
  hermesProposalProcessRunner?: HermesProposalProcessRunner;
  hermesProposalProjectResolver?: HermesProposalProjectResolver;
  hermesProposalLaunchInspector?: HermesProposalLaunchInspector;
  hermesProposalIsolationRootPath?: string;
  hermesProposalCredentialEnvironment?: Readonly<Record<string, string>>;
  hermesProposalCredentialFiles?: readonly HermesProposalCredentialFile[];
  hermesProposalCredentialFilesResolver?: (
    signal: AbortSignal
  ) => Promise<readonly HermesProposalCredentialFile[]>;
  hermesProposalIsolationRootResolver?: (signal: AbortSignal) => Promise<string>;
  hermesProposalProbeCommandTimeoutMs?: number;
  hermesProposalTerminationGraceMs?: number;
  /**
   * Test-only: injected runners do not prove that a real child process closed
   * unless the fixture explicitly opts into that contract.
   */
  hermesProposalTrustInjectedRunnerTerminationForTests?: boolean;
}

export interface KnowledgeBaseHarnessTaskInput {
  backend: AgentBackendKind;
  prompt: string;
  sources: KnowledgeBaseSource[];
  permission: PermissionMode;
  codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
  turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
  managedKind: KnowledgeBaseManagedThreadKind;
  resources?: PreparedAgentResources;
  toolBridge?: AgentToolBridgeRuntime | null;
  artifactRecovery?: KnowledgeAgentArtifactRecovery;
  vaultProfileSections?: ContextSection[];
  /** Present only for the selected-first maintenance Harness. */
  workflowRunId?: string;
  attemptId?: string;
  attemptOrdinal?: number;
  /** Shadow Vault root for this attempt; sources must already be remapped into it. */
  vaultPathOverride?: string;
  writableRootsOverride?: string[];
  exactWriteFence?: AgentExactWriteFenceContext;
  onExactWriteFenceConfigured?: (receipt: AgentExactWriteFenceReceipt) => void | Promise<void>;
}

export type KnowledgeAgentAttemptPhase = "preflight" | "execution";

export class KnowledgeAgentAttemptError extends Error {
  readonly code: string;

  constructor(
    readonly phase: KnowledgeAgentAttemptPhase,
    readonly backend: AgentBackendKind,
    readonly workflowRunId: string,
    readonly attemptId: string,
    readonly attemptOrdinal: number,
    readonly harnessRunId: string,
    readonly submittedAt: number | undefined,
    cause: unknown,
    readonly terminationConfirmedAt: number | undefined = undefined,
    readonly nativeExecutionId: string = "",
    readonly nativeTerminationReceipt?: KnowledgeAgentNativeTerminationReceipt
  ) {
    super(errorMessage(cause));
    this.name = "KnowledgeAgentAttemptError";
    const causeCode = cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "").trim()
      : "";
    this.code = causeCode;
  }
}

export class KnowledgeBaseAgentTaskService {
  private readonly runtimeController: KnowledgeAgentRuntimeController;
  private activeHarnessRunId: string | null = null;
  private activeHermesProposalAbortController: AbortController | null = null;
  private readonly pendingNativeExecutionCommits = new Map<string, PendingNativeExecutionCommit>();
  private readonly settledNativeExecutionRunIds = new Map<string, true>();
  private readonly pendingHarnessTerminalSettlements = new Map<string, SettleRunTerminalInput>();
  private readonly activeTaskSettlements = new Set<Promise<void>>();
  private nativeExecutionSettlementTail: Promise<void> = Promise.resolve();
  private lastNativeLifecycleSummary: KnowledgeBaseNativeLifecycleSummary | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly context: KnowledgeBaseAgentTaskServiceContext,
    private readonly dependencies: KnowledgeBaseAgentTaskServiceDependencies = {}
  ) {
    this.runtimeController = new KnowledgeAgentRuntimeController({
      settings: this.plugin.settings,
      vaultPath: () => this.plugin.getVaultPath(),
      saveSettings: async () => await this.plugin.saveSettings(),
      isCanceled: () => this.context.isCancelRequested(),
      harness: (vaultPathOverride) => this.knowledgeHarnessOptions(vaultPathOverride),
      runCodexTask: async (input) => await this.runCodexKnowledgeTask({
        harnessRunId: input.harnessRunId,
        prompt: input.prompt,
        sources: input.sources,
        permission: input.permission ?? "workspace-write",
        writeScope: input.writeScope,
        turnOptionOverrides: input.turnOptionOverrides as KnowledgeBaseTurnOptionOverrides | undefined,
        managedKind: input.managedKind as KnowledgeBaseManagedThreadKind,
        resources: input.resources,
        artifactRecovery: input.artifactRecovery,
        vaultProfileSections: input.vaultProfileSections,
        onSubmitted: input.onSubmitted,
        vaultPathOverride: input.vaultPathOverride,
        writableRootsOverride: input.writableRootsOverride,
        requireExactWriteFence: input.requireExactWriteFence,
        exactWriteFence: input.exactWriteFence,
        onExactWriteFenceConfigured: input.onExactWriteFenceConfigured
      })
    });
  }

  get hasActiveTask(): boolean {
    return Boolean(this.activeHarnessRunId || this.runtimeController.hasActiveRun);
  }

  get activeRunId(): string | null {
    return this.activeHarnessRunId;
  }

  async collectNativeJournalHistory(
    backend: AgentBackendKind,
    window: { startMs: number; endMs: number }
  ): Promise<KnowledgeJournalNativeHistory> {
    return await collectKnowledgeJournalHistoryForBackend({
      backend,
      settings: this.plugin.settings,
      vaultPath: this.plugin.getVaultPath(),
      startMs: window.startMs,
      endMs: window.endMs,
      saveSettings: async () => await this.plugin.saveSettings()
    });
  }

  async isMaintenanceBackendReady(
    backend: AgentBackendKind,
    sources: KnowledgeBaseSource[]
  ): Promise<boolean> {
    this.throwIfCanceled();
    try {
      if (backend === "hermes") {
        return await this.isHermesProposalBackendReady(sources);
      }
      if (backend === "opencode") {
        await this.runtimeController.preflight({ backend, sources });
        return true;
      }
      let status = await this.plugin.ensureCodexConnected(false, { silent: true });
      if (!status.connected) {
        status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
      }
      if (!status.connected || !this.plugin.hasCodexHarnessTransport()) return false;
      const required = new Set<string>(["text"]);
      for (const source of sources) {
        if (source.modality === "image") required.add("image");
        else if (source.mime === "application/pdf") required.add("pdf");
      }
      return status.models.some((model) => {
        const modalities = model.inputModalities?.filter((item): item is string => typeof item === "string") ?? [];
        return modalities.length === 0 || Array.from(required).every((item) => modalities.includes(item));
      });
    } catch (error) {
      if (this.context.isCancelRequested() || isKnowledgeBaseCancelError(errorMessage(error))) throw error;
      return false;
    }
  }

  async unload(): Promise<void> {
    await this.cancelActiveTasks().catch(() => undefined);
    await Promise.allSettled(Array.from(this.activeTaskSettlements));
    this.runtimeController.clear();
  }

  clearActiveRuns(): void {
    this.activeHarnessRunId = null;
    this.runtimeController.clear();
  }

  async cancelActiveTasks(): Promise<void> {
    const errors: string[] = [];
    const runId = this.activeHarnessRunId;
    const hermesProposalController = this.activeHermesProposalAbortController;
    if (hermesProposalController) {
      const activeSettlements = Array.from(this.activeTaskSettlements);
      hermesProposalController.abort(KNOWLEDGE_BASE_CANCEL_ERROR);
      // Hermes proposal execution is owned by this Service rather than the
      // generic runtime controller. Do not publish a terminal state merely
      // because AbortSignal was sent: wait until the task has observed the
      // abort and the native runner has either settled or exhausted its
      // bounded termination grace.
      await Promise.allSettled(activeSettlements);
      return;
    }
    if (runId) {
      const runtimeCancelled = await this.runtimeController.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR)).catch((error) => {
        errors.push(errorMessage(error));
        return false;
      });
      if (runtimeCancelled) {
        await this.plugin.settleHarnessRunTerminal({
          runId,
          status: "cancelled",
          error: KNOWLEDGE_BASE_CANCEL_ERROR
        }).catch((error) => errors.push(errorMessage(error)));
      } else {
        await this.plugin.cancelHarnessRun(runId).catch((error) => {
          errors.push(errorMessage(error));
        });
      }
    } else {
      await this.runtimeController.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR)).catch((error) => {
        errors.push(errorMessage(error));
      });
    }
    if (errors.length) throw new Error(errors.join("; "));
  }

  async runTask(input: KnowledgeBaseHarnessTaskInput): Promise<KnowledgeAgentTaskOutput> {
    if (input.managedKind === "unknown") {
      throw Object.assign(
        new Error("Knowledge task managedKind=unknown is not executable"),
        { code: "UNSAFE_VAULT" }
      );
    }
    const maintenanceAttempt = isMaintenanceManagedKind(input.managedKind);
    if (maintenanceAttempt) assertCompleteMaintenanceAttemptIdentity(input);
    let releaseTaskSettlement!: () => void;
    const taskSettlement = new Promise<void>((resolve) => { releaseTaskSettlement = resolve; });
    this.activeTaskSettlements.add(taskSettlement);
    const harnessRunId = newId(`knowledge-${input.backend}`);
    let writableRootsOverride = input.writableRootsOverride;
    let submittedAt: number | undefined;
    let nativeExecutionId = "";
    let nativeRecordPromise: Promise<NativeExecutionRecord | null> | null = null;
    let nativeRegistrationFailure: NativeRunRegistrationError | null = null;
    const recordNativeReference = async (
      native: NativeExecutionRef,
      backendLabel: string
    ): Promise<NativeExecutionRecord> => {
      if (input.managedKind === "ask") {
        throw new NativeRunRegistrationError(
          `${backendLabel} isolated execution cannot be registered as a leased Knowledge ask`
        );
      }
      if (
        native.backendId !== input.backend
        && !(
          input.backend === "hermes"
          && isHermesProposalHostExecutionRef(native)
        )
      ) {
        throw new NativeRunRegistrationError(
          `${backendLabel} Native execution registration received an identity from ${native.backendId}`
        );
      }
      const nextNativeExecutionId = native.id.trim();
      if (!nextNativeExecutionId) {
        throw new NativeRunRegistrationError(
          `${backendLabel} Native execution registration failed: runtime returned no Native ID`
        );
      }
      if (
        nativeExecutionId
        && nativeExecutionId !== nextNativeExecutionId
      ) {
        throw new NativeRunRegistrationError(
          `${backendLabel} Native execution registration failed: runtime changed Native ID before prompt submission`
        );
      }
      nativeExecutionId = nextNativeExecutionId;
      nativeRecordPromise ??= this.recordNativeExecution({
        runId: harnessRunId,
        native,
        managedKind: input.managedKind
      });
      try {
        return await requireNativeExecutionRegistration(
          nativeRecordPromise,
          backendLabel,
          nextNativeExecutionId
        );
      } catch (error) {
        nativeRegistrationFailure = nativeRunRegistrationError(
          error,
          backendLabel,
          nextNativeExecutionId
        );
        throw nativeRegistrationFailure;
      }
    };
    const recordNativeRun = async (
      backend: AgentBackendKind,
      nativeId: string,
      native: NativeExecutionRef
    ): Promise<void> => {
      if (
        input.managedKind === "ask"
        || backend === "codex-cli"
      ) {
        if (nativeId) nativeExecutionId = nativeId;
        return;
      }
      await recordNativeReference(
        native,
        harnessBackendDisplayName(backend)
      );
    };
    const queueNativeCommit = async (outcome: NativeRunOutcome, result?: HarnessRunResult): Promise<void> => {
      if (input.managedKind === "ask") {
        this.queueHarnessNativeExecutionCommits(
          harnessRunId,
          outcome,
          result,
          input.backend,
          input.managedKind
        );
        return;
      }
      if (!nativeRecordPromise && result?.nativeExecution) {
        nativeRecordPromise = this.recordNativeExecution({
          runId: harnessRunId,
          native: result.nativeExecution,
          managedKind: input.managedKind
        });
      }
      const recoveryRecord = await nativeRecordPromise?.catch(() => null);
      if (recoveryRecord) {
        this.pendingNativeExecutionCommits.set(recoveryRecord.id, {
          runId: harnessRunId,
          runOutcome: outcome,
          recoveryRecord
        });
      }
    };
    const markSubmitted = (): void => {
      if (submittedAt === undefined) submittedAt = Date.now();
    };

    try {
      if (maintenanceAttempt) {
        assertMaintenanceAttemptUsesShadow(input, this.plugin.getVaultPath());
        writableRootsOverride = maintenanceAttemptWritableRoots(input, this.plugin.getVaultPath());
        assertAttemptSourcesStayInsideVault(input.sources, input.vaultPathOverride);
        await this.preflightMaintenanceTask(input, writableRootsOverride);
        this.throwIfCanceled();
      }
      this.activeHarnessRunId = harnessRunId;
      const output = maintenanceAttempt && input.backend === "hermes"
        ? await this.runHermesMaintenanceProposalTask({
          input,
          harnessRunId,
          writableRoots: writableRootsOverride ?? [],
          registerNativeExecution: async (native) =>
            await recordNativeReference(native, "Hermes proposal host process"),
          onSubmitted: markSubmitted
        })
        : await this.runtimeController.run({
          harnessRunId,
          backend: input.backend,
          prompt: input.prompt,
          sources: input.sources,
          permission: input.permission,
          codexWriteScope: input.codexWriteScope,
          resources: input.resources,
          toolBridge: input.toolBridge ?? undefined,
          timeoutMs: harnessKnowledgeTaskTimeoutMs(input.backend, input.turnOptionOverrides),
          turnOptionOverrides: input.turnOptionOverrides,
          workflow: knowledgeWorkflowForManagedKind(input.managedKind),
          outputKind: input.managedKind === "ask" ? "plain-text" : "knowledge-ledger",
          managedKind: input.managedKind,
          artifactRecovery: input.artifactRecovery,
          vaultProfileSections: input.vaultProfileSections,
          vaultPathOverride: input.vaultPathOverride,
          writableRootsOverride,
          requireExactWriteFence: maintenanceAttempt,
          exactWriteFence: input.exactWriteFence,
          onExactWriteFenceConfigured: input.onExactWriteFenceConfigured,
          onSubmitted: markSubmitted,
          onNativeRunId: recordNativeRun
        });
      if (input.backend !== "codex-cli") await queueNativeCommit("success", output.harnessResult);
      return {
        ...output,
        ...(maintenanceAttempt ? {
          harnessRunId,
          workflowRunId: input.workflowRunId,
          attemptId: input.attemptId,
          backend: input.backend,
          ...(submittedAt !== undefined ? { submittedAt } : {})
        } : {})
      };
    } catch (error) {
      const taskError: unknown = nativeRegistrationFailure ?? error;
      if (input.backend !== "codex-cli") {
        await queueNativeCommit(
          isKnowledgeBaseCancelError(errorMessage(taskError)) ? "cancelled" : "failed",
          harnessResultFromError(taskError)
        );
      }
      if (!maintenanceAttempt || taskError instanceof KnowledgeAgentAttemptError) throw taskError;
      const nativeTerminationReceipt = nativeTerminationReceiptFrom(taskError);
      throw new KnowledgeAgentAttemptError(
        submittedAt === undefined ? "preflight" : "execution",
        input.backend,
        input.workflowRunId!,
        input.attemptId!,
        input.attemptOrdinal!,
        harnessRunId,
        submittedAt,
        taskError,
        terminationConfirmedAtFrom(taskError),
        nativeTerminationReceipt?.nativeExecutionId || nativeExecutionId,
        nativeTerminationReceipt
      );
    } finally {
      if (this.activeHarnessRunId === harnessRunId) this.activeHarnessRunId = null;
      releaseTaskSettlement();
      this.activeTaskSettlements.delete(taskSettlement);
    }
  }

  private async preflightMaintenanceTask(
    input: KnowledgeBaseHarnessTaskInput,
    writableRoots: readonly string[]
  ): Promise<void> {
    if (input.backend === "hermes") {
      assertHermesMaintenanceProposalTask(input, writableRoots);
      return;
    }
    if (input.backend !== "codex-cli") {
      await this.runtimeController.preflight({
        backend: input.backend,
        sources: input.sources,
        vaultPathOverride: input.vaultPathOverride
      });
      return;
    }

    let status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected) {
      status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
    }
    if (!status.connected) {
      if (!status.loggedIn) {
        throw Object.assign(
          new Error(status.errors[0] || "Codex 未登录，需要登录后才能执行维护。"),
          { code: "AUTH_REQUIRED" }
        );
      }
      throw Object.assign(
        new Error(status.errors[0] || "Codex Agent backend unavailable：连接预检失败"),
        { code: "BACKEND_UNAVAILABLE" }
      );
    }
    if (!this.plugin.hasCodexHarnessTransport()) {
      throw Object.assign(
        new Error("Codex Agent backend unavailable：Harness transport 未加载"),
        { code: "BACKEND_UNAVAILABLE" }
      );
    }

    const options = buildCodexKnowledgeTurnOptions({
      settings: this.plugin.settings,
      availableModels: status.models,
      vaultPath: input.vaultPathOverride ?? this.plugin.getVaultPath(),
      permission: input.permission,
      writeScope: input.codexWriteScope,
      overrides: input.turnOptionOverrides,
      disableExternalResources:
        isMaintenanceManagedKind(input.managedKind)
    });
    const model = status.models.find((item) => item.model === options.model || item.id === options.model);
    if (!options.model || !model) {
      throw Object.assign(
        new Error(`Codex Agent backend unavailable：模型预检失败${options.model ? `（${options.model} 不可用）` : "（没有可用模型）"}`),
        { code: "BACKEND_UNAVAILABLE" }
      );
    }
    const declaredModalities = model.inputModalities?.filter((item): item is string => typeof item === "string") ?? [];
    if (declaredModalities.length) {
      const requiredModalities = new Set<string>(["text"]);
      for (const source of input.sources) {
        if (source.modality === "image") requiredModalities.add("image");
        else if (source.mime === "application/pdf") requiredModalities.add("pdf");
      }
      const missing = Array.from(requiredModalities).filter((modality) => !declaredModalities.includes(modality));
      if (missing.length) {
        throw Object.assign(
          new Error(`Codex Agent backend unavailable：模型 ${model.displayName || model.model} 不支持 ${missing.join(" / ")} 输入`),
          { code: "BACKEND_UNAVAILABLE" }
        );
      }
    }
  }

  private async isHermesProposalBackendReady(
    sources: readonly KnowledgeBaseSource[]
  ): Promise<boolean> {
    if (sources.some((source) =>
      source.modality !== "text"
      || source.readStrategy?.kind === "chunked-text"
      || (source.relativePath !== "raw" && !source.relativePath.startsWith("raw/"))
    )) {
      return false;
    }
    let capability: HermesVaultNoWriteCapability | undefined;
    const abortController = new AbortController();
    this.activeHermesProposalAbortController = abortController;
    try {
      const probe = await this.probeHermesProposalCapability({
        attemptId: `maintenance-readiness-${newId("hermes")}`,
        sources,
        abortSignal: abortController.signal
      });
      if (probe.ready) capability = probe.capability;
      if (abortController.signal.aborted || this.context.isCancelRequested()) {
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
      if (!probe.ready) return false;
      return true;
    } catch {
      if (abortController.signal.aborted || this.context.isCancelRequested()) {
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
      return false;
    } finally {
      if (this.activeHermesProposalAbortController === abortController) {
        this.activeHermesProposalAbortController = null;
      }
      if (capability) {
        await cleanupHermesProposalIsolation(capability).catch(() => undefined);
      }
    }
  }

  private async runHermesMaintenanceProposalTask(input: {
    input: KnowledgeBaseHarnessTaskInput;
    harnessRunId: string;
    writableRoots: readonly string[];
    registerNativeExecution(
      native: NativeExecutionRef
    ): Promise<NativeExecutionRecord>;
    onSubmitted(): void;
  }): Promise<KnowledgeAgentTaskOutput> {
    const task = input.input;
    assertHermesMaintenanceProposalTask(task, input.writableRoots);
    this.throwIfCanceled();
    const attemptId = task.attemptId!;
    const shadowVaultPath = path.resolve(task.vaultPathOverride!);
    const timeoutMs = normalizeHermesTaskTimeoutMs(
      harnessKnowledgeTaskTimeoutMs("hermes", task.turnOptionOverrides)
    );
    const abortController = new AbortController();
    this.activeHermesProposalAbortController = abortController;
    let executionError: unknown;
    let registeredHostRecord: NativeExecutionRecord | null = null;
    const adapter = new HermesProposalHostAgentAdapter({
      attemptId,
      modelId: this.plugin.settings.agents.hermes.modelId,
      externalAbortSignal: abortController.signal,
      nativeRefContext: this.plugin.getNativeExecutionRefContext(),
      persistProcessDisposition: async ({ native, receipt }) => {
        const record = registeredHostRecord;
        if (
          !record
          || record.native.id !== native.id
          || record.native.backendId !== native.backendId
          || record.id !== `knowledge-native:${input.harnessRunId}:${native.backendId}`
        ) {
          throw new NativeRunRegistrationError(
            "Hermes proposal host disposition has no matching durable Native registration"
          );
        }
        const observedRecord: NativeExecutionRecord = {
          ...record,
          observedDisposition: receipt
        };
        await this.plugin.recordNativeExecution(observedRecord);
        registeredHostRecord = observedRecord;
      },
      isCancellation: (error, signal) =>
        signal.aborted
        || this.context.isCancelRequested()
        || isKnowledgeBaseCancelError(errorMessage(error))
        || (
          error instanceof HermesProposalRuntimeError
          && error.code === "canceled"
        ),
      execute: async (execution) => {
        const { native, abortSignal } = execution;
        let capability: HermesVaultNoWriteCapability | undefined;
        let lease: ReturnType<typeof createHermesProposalLease> | undefined;
        let onLeaseAbort: (() => void) | undefined;
        let nativeSubmitted = false;
        let retainIsolation = false;
        try {
          const probe = await this.probeHermesProposalCapability({
            attemptId,
            sources: task.sources,
            abortSignal
          });
          if (probe.ready) capability = probe.capability;
          if (abortSignal.aborted || this.context.isCancelRequested()) {
            throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
          }
          if (!probe.ready) {
            throw Object.assign(
              new Error(`EXACT_WRITE_FENCE_UNAVAILABLE: Hermes proposal preflight 失败（${probe.code}）：${probe.reason}`),
              { code: "EXACT_WRITE_FENCE_UNAVAILABLE" }
            );
          }
          const prepared = await prepareHermesMaintenanceProposalInput({
            attemptId,
            shadowVaultPath,
            originalPrompt: task.prompt,
            sources: task.sources,
            hostMaterializerRoots: input.writableRoots,
            vaultProfileSections: task.vaultProfileSections,
            resourcePromptPrefix: task.resources?.promptPrefix,
            resourceWarnings: task.resources?.warnings
          });
          this.throwIfCanceled();
          const inputDigest = hermesProposalInvocationInputDigest({
            prompt: prepared.prompt,
            systemPrompt: prepared.systemPrompt,
            validation: prepared.validation
          });
          lease = createHermesProposalLease({
            attemptId,
            inputDigest,
            leaseId: task.exactWriteFence!.leaseToken
          });
          onLeaseAbort = () => {
            try {
              revokeHermesProposalLease(lease!, "canceled");
            } catch {
              // A concurrent timeout, process error or successful
              // materialization may already have revoked this exact lease.
            }
          };
          abortSignal.addEventListener("abort", onLeaseAbort, { once: true });
          if (abortSignal.aborted) onLeaseAbort();
          let exactWriteFenceReceipt: AgentExactWriteFenceReceipt | undefined;
          const invocation = await runHermesProposalInvocation({
            capability: probe.capability,
            lease,
            prompt: prepared.prompt,
            systemPrompt: prepared.systemPrompt,
            validation: prepared.validation,
            deniedLivePaths: task.exactWriteFence!.deniedLivePaths,
            deniedControlPaths: task.exactWriteFence!.deniedControlPaths,
            hostMaterializerRoots: input.writableRoots,
            timeoutMs,
            terminationGraceMs: this.dependencies.hermesProposalTerminationGraceMs,
            abortSignal,
            onAuthorityConfigured: async (authorityReceipt) => {
              await assertHermesAuthorityMatchesFenceRequest({
                authorityReceipt,
                task,
                writableRoots: input.writableRoots
              });
              const fenceTask: AgentTaskInput = {
                prompt: prepared.prompt,
                permission: task.permission,
                writableRoots: [...input.writableRoots],
                requireExactWriteFence: true,
                exactWriteFence: task.exactWriteFence,
                onExactWriteFenceConfigured: task.onExactWriteFenceConfigured
              };
              assertExactWriteFenceRequest("hermes", fenceTask, shadowVaultPath);
              const receipt = createExactWriteFenceReceipt({
                backend: "hermes",
                task: fenceTask,
                transport: "hermes-proposal-v1-host-materializer",
                transportAck: {
                  authority: authorityReceipt.authority,
                  scope: authorityReceipt.scope,
                  osSandbox: authorityReceipt.osSandbox,
                  attemptId: authorityReceipt.attemptId,
                  leaseId: authorityReceipt.leaseId,
                  inputDigest: authorityReceipt.inputDigest,
                  promptDigest: authorityReceipt.promptDigest,
                  outputSchemaDigest: authorityReceipt.outputSchemaDigest,
                  capabilityProbeDigest: authorityReceipt.capabilityProbeDigest,
                  argvDigest: authorityReceipt.argvDigest,
                  environmentDigest: authorityReceipt.environmentDigest,
                  hostMaterializerRoots: authorityReceipt.hostMaterializerRoots
                },
                configuredAt: authorityReceipt.configuredAt
              });
              await deliverExactWriteFenceReceipt(fenceTask, receipt);
              exactWriteFenceReceipt = receipt;
            },
            onSubmitted: () => {
              nativeSubmitted = true;
              input.onSubmitted();
            }
          });
          await execution.recordProcessDisposition("exited");
          if (!exactWriteFenceReceipt) {
            throw Object.assign(
              new Error("POLICY_DENIED: Hermes proposal 未签发 trusted exact-write-fence receipt"),
              { code: "POLICY_DENIED" }
            );
          }
          if (abortSignal.aborted || this.context.isCancelRequested()) {
            throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
          }
          const materialized = await materializeHermesMaintenanceProposal({
            shadowVaultPath,
            proposal: invocation.proposal,
            authorityReceipt: invocation.authorityReceipt,
            lease
          });
          return {
            text: [
              `Hermes proposal 已由 EchoInk 宿主写入当前 Shadow：${materialized.materializedPaths.length} 个文件。`,
              invocation.proposal.rejectedOperations.length
                ? `另有 ${invocation.proposal.rejectedOperations.length} 个 operation 未通过边界校验。`
                : "",
              `proposalDigest=${materialized.proposalDigest}`
            ].filter(Boolean).join("\n"),
            terminalData: {
              proposalDigest: materialized.proposalDigest,
              materializedPathCount: materialized.materializedPaths.length
            }
          };
        } catch (error) {
          const dispositionState = hermesProposalHostDispositionStateAfterError({
            error,
            nativeSubmitted,
            trustInjectedTermination:
              !this.dependencies.hermesProposalProcessRunner
              || this.dependencies.hermesProposalTrustInjectedRunnerTerminationForTests === true
          });
          if (dispositionState) {
            await execution.recordProcessDisposition(
              dispositionState,
              error instanceof HermesProposalRuntimeError
                && error.terminationConfirmedAt
                ? error.terminationConfirmedAt
                : Date.now()
            );
          }
          if (
            nativeSubmitted
            && error instanceof HermesProposalRuntimeError
            && error.terminationConfirmedAt
            && (
              !this.dependencies.hermesProposalProcessRunner
              || this.dependencies.hermesProposalTrustInjectedRunnerTerminationForTests === true
            )
          ) {
            Object.assign(error, {
              nativeTerminationReceipt: issueKnowledgeAgentNativeTerminationReceipt({
                backend: "hermes",
                harnessRunId: input.harnessRunId,
                nativeExecutionId: native.id,
                kind: "abort-ack",
                confirmedAt: error.terminationConfirmedAt
              })
            });
          }
          if (
            error instanceof HermesProposalRuntimeError
            && error.code === "canceled"
          ) {
            error.message = KNOWLEDGE_BASE_CANCEL_ERROR;
          }
          if (lease) {
            try {
              revokeHermesProposalLease(lease, "service_failed");
            } catch {
              // The materializer/runtime may already have revoked the same
              // lease.
            }
          }
          retainIsolation = nativeSubmitted
            && shouldRetainHermesProposalIsolation(error);
          executionError = error;
          throw error;
        } finally {
          if (onLeaseAbort) {
            abortSignal.removeEventListener("abort", onLeaseAbort);
          }
          if (capability && !retainIsolation) {
            await cleanupHermesProposalIsolation(capability).catch(() => undefined);
          }
        }
      }
    });
    try {
      const result = await this.plugin.runHarnessWithAdapter({
        adapter,
        registerNativeExecution: async ({ native }) => {
          if (!isHermesProposalHostExecutionRef(native)) {
            throw new NativeRunRegistrationError(
              "Hermes proposal adapter did not provide an EchoInk host-process identity"
            );
          }
          const record = await input.registerNativeExecution(native);
          registeredHostRecord = record;
          return { recordId: record.id };
        },
        request: {
          runId: input.harnessRunId,
          sessionId: this.plugin.settings.knowledgeBase.sessionId
            || "knowledge-maintenance",
          surface: "knowledge",
          workflow: knowledgeWorkflowForManagedKind(task.managedKind),
          backendId: "hermes",
          workspace: {
            vaultPath: shadowVaultPath,
            cwd: shadowVaultPath
          },
          input: {
            text: task.prompt,
            attachments: task.sources.map((source) => ({
              type: source.modality === "image"
                ? "image" as const
                : source.mime === "application/pdf"
                  ? "pdf" as const
                  : "file" as const,
              path: source.absolutePath,
              name: path.basename(source.absolutePath),
              mime: source.mime
            }))
          },
          permissions: {
            mode: task.permission,
            writableRoots: [...input.writableRoots],
            requireApproval: true
          },
          resourceSelection: task.resources
            ? resourceSelectionFromPreparedResources(task.resources, "hermes")
            : {
              selected: [],
              resolvedAt: Date.now(),
              warnings: []
            },
          memoryPolicy: memoryRequestPolicy(
            knowledgeWorkflowForManagedKind(task.managedKind)
          ),
          outputContract: { kind: "knowledge-ledger" },
          vaultProfileSections: task.vaultProfileSections
        }
      });
      if (result.status === "failed" || result.status === "cancelled") {
        const error = executionError instanceof Error
          ? executionError
          : new Error(
            result.status === "cancelled"
              ? KNOWLEDGE_BASE_CANCEL_ERROR
              : result.error || "Hermes proposal Harness run failed"
          );
        Object.assign(error, { harnessResult: result });
        throw error;
      }
      return {
        text: result.outputText ?? "",
        harnessResult: result
      };
    } finally {
      if (this.activeHermesProposalAbortController === abortController) {
        this.activeHermesProposalAbortController = null;
      }
      await adapter.dispose().catch(() => undefined);
    }
  }

  private async probeHermesProposalCapability(input: {
    attemptId: string;
    sources: readonly KnowledgeBaseSource[];
    abortSignal: AbortSignal;
  }) {
    const settings = this.plugin.settings.agents.hermes;
    const providerId = settings.providerId.trim().toLowerCase();
    const modelId = settings.modelId.trim();
    if (!providerId || !modelId) {
      return {
        ready: false as const,
        code: "unsafe_provider" as const,
        reason: "Hermes proposal 缺少 provider 或 model"
      };
    }
    let command: string;
    try {
      command = this.dependencies.hermesProposalCommand
        ?? resolveHermesCommand(settings.cliPath);
    } catch (error) {
      throw Object.assign(
        new Error(`Hermes Agent backend unavailable：${errorMessage(error)}`),
        { code: "BACKEND_UNAVAILABLE" }
      );
    }
    const credentialEnvironment = this.dependencies.hermesProposalCredentialEnvironment
      ?? hermesProposalCredentialEnvironment(providerId, settings.apiKey);
    const probeOperationTimeoutMs = normalizeHermesProbeOperationTimeoutMs(
      this.dependencies.hermesProposalProbeCommandTimeoutMs
    );
    const credentialFiles = this.dependencies.hermesProposalCredentialFiles
      ?? await runHermesServiceProbeOperation({
        label: "Hermes credential discovery",
        timeoutMs: probeOperationTimeoutMs,
        externalSignal: input.abortSignal,
        operation: async (signal) => await (
          this.dependencies.hermesProposalCredentialFilesResolver
            ? this.dependencies.hermesProposalCredentialFilesResolver(signal)
            : hermesProposalCredentialFiles()
        )
      });
    if (input.abortSignal.aborted || this.context.isCancelRequested()) {
      throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
    }
    const isolationRootPath = this.dependencies.hermesProposalIsolationRootPath
      ?? await runHermesServiceProbeOperation({
        label: "Hermes isolation root preparation",
        timeoutMs: probeOperationTimeoutMs,
        externalSignal: input.abortSignal,
        operation: async (signal) => await (
          this.dependencies.hermesProposalIsolationRootResolver
            ? this.dependencies.hermesProposalIsolationRootResolver(signal)
            : hermesProposalIsolationRoot()
        )
      });
    return await runHermesServiceProbeOperation({
      label: "Hermes capability preflight",
      timeoutMs: scaledHermesProbeTimeoutMs(probeOperationTimeoutMs, 8),
      externalSignal: input.abortSignal,
      operation: async (signal) => await probeHermesVaultNoWriteCapability({
        attemptId: input.attemptId,
        command,
        providerId,
        modelId,
        inputModalities: Array.from(new Set(input.sources.map((source) => source.modality))),
        isolationRootPath,
        credentialEnvironment,
        credentialFiles,
        processRunner: this.dependencies.hermesProposalProcessRunner,
        projectResolver: this.dependencies.hermesProposalProjectResolver,
        launchInspector: this.dependencies.hermesProposalLaunchInspector,
        abortSignal: signal,
        probeCommandTimeoutMs: this.dependencies.hermesProposalProbeCommandTimeoutMs
      })
    });
  }

  async settlePendingNativeExecutions(
    runIds?: readonly string[]
  ): Promise<number> {
    const result = await this.enqueueNativeExecutionSettlement(
      async () => await this.settlePendingNativeExecutionsInternal(runIds)
    );
    return result.disposedCount;
  }

  async settlePendingNativeExecutionsForRunIds(
    runIds: readonly string[]
  ): Promise<KnowledgeBaseScopedNativeSettlement> {
    return await this.enqueueNativeExecutionSettlement(
      async () => await this.settlePendingNativeExecutionsInternal(runIds)
    );
  }

  private async settlePendingNativeExecutionsInternal(
    runIds?: readonly string[]
  ): Promise<KnowledgeBaseScopedNativeSettlement> {
    this.lastNativeLifecycleSummary = null;
    const requestedRunIds = runIds === undefined
      ? []
      : Array.from(new Set(
        runIds.map((runId) => runId.trim()).filter(Boolean)
      ));
    if (!this.hasNativeExecutionLifecycle()) {
      return {
        requestedRunIds,
        matchedRunIds: [],
        matchedRecordCount: 0,
        localCommitStatus: requestedRunIds.length
          ? "not-applicable"
          : "committed",
        cleanupRecoveryRequired: false,
        disposedCount: 0
      };
    }
    await this.migrateLegacyManagedThreads();
    const matchingRunIds = runIds === undefined
      ? null
      : new Set(requestedRunIds);
    const pending = Array.from(this.pendingNativeExecutionCommits.entries())
      .filter(([, item]) =>
        matchingRunIds === null || matchingRunIds.has(item.runId)
      );
    const matchedRunIds = Array.from(new Set([
      ...pending.map(([, item]) => item.runId),
      ...requestedRunIds.filter((runId) =>
        this.hasSettledNativeExecutionRunReceipt(runId)
      )
    ]));
    const localCommit = pending.length
      ? await this.commitKnowledgeRunDurably(pending.map(([, item]) => item.runId))
      : localDurableCommitResult(true);
    const settledStatuses: NativeCleanupStatus[] = [];
    const settlementWarnings: string[] = [];
    for (const [recordId, item] of pending) {
      let settled = await this.plugin.settleNativeExecution({
        recordId,
        runOutcome: item.runOutcome,
        localCommit: item.missingReceiptWarning
          ? localDurableCommitResult(false, item.missingReceiptWarning)
          : localCommit
      });
      if (!settled) {
        const recovery = await this.retainMissingNativeExecutionReceipt(
          recordId,
          item
        );
        settled = recovery.settled;
        settlementWarnings.push(recovery.warning);
      } else if (item.missingReceiptWarning) {
        settlementWarnings.push(item.missingReceiptWarning);
      }
      if (settled?.cleanup) settledStatuses.push(settled.cleanup);
      if (!settled) settledStatuses.push("retained-for-recovery");
      if (
        settled
        && localCommit.committed
        && !item.missingReceiptWarning
      ) {
        this.pendingNativeExecutionCommits.delete(recordId);
      }
    }
    if (localCommit.committed) {
      for (const runId of new Set(pending.map(([, item]) => item.runId))) {
        if (
          !Array.from(this.pendingNativeExecutionCommits.values())
            .some((item) => item.runId === runId)
        ) {
          this.rememberSettledNativeExecutionRunReceipt(runId);
        }
      }
    }
    const unresolvedRequestedRunIds = requestedRunIds.filter((runId) =>
      Array.from(this.pendingNativeExecutionCommits.values())
        .some((item) => item.runId === runId)
    );
    const scopedLocalCommitStatus = unresolvedRequestedRunIds.length
      ? "failed" as const
      : "committed" as const;
    if (!localCommit.committed) {
      const warning = joinNativeLifecycleWarnings([
        `Native Execution 本地提交待恢复${localCommit.error ? `：${localCommit.error}` : ""}`,
        ...settlementWarnings
      ]);
      this.lastNativeLifecycleSummary = {
        localCommitStatus: "failed",
        cleanupStatuses: settledStatuses.length ? settledStatuses : ["retained-for-recovery"],
        cleanupAttempted: false,
        disposedCount: 0,
        recordIds: pending.map(([recordId]) => recordId),
        recoveryRequired: true,
        warning
      };
      return {
        requestedRunIds,
        matchedRunIds,
        matchedRecordCount: pending.length,
        localCommitStatus: "failed",
        cleanupRecoveryRequired: true,
        disposedCount: 0
      };
    }
    let cleanup: NativeCleanupResult[];
    try {
      if (matchingRunIds === null) {
        cleanup = await this.plugin.cleanupDueNativeExecutions(20);
      } else {
        cleanup = [];
        for (const [recordId] of pending) {
          cleanup.push(
            await this.plugin.cleanupNativeExecutionRecord(recordId)
          );
        }
      }
    } catch (error) {
      const warning = joinNativeLifecycleWarnings([
        ...settlementWarnings,
        `Native Execution 清理待恢复：${errorMessage(error)}`
      ]);
      console.warn("知识库 Native Execution 清理待恢复", error);
      this.lastNativeLifecycleSummary = {
        ...(pending.length ? { localCommitStatus: "committed" as const } : {}),
        cleanupStatuses: Array.from(new Set([
          ...settledStatuses,
          "retained-for-recovery" as const
        ])),
        cleanupAttempted: false,
        disposedCount: 0,
        recordIds: pending.map(([recordId]) => recordId),
        recoveryRequired: true,
        warning
      };
      return {
        requestedRunIds,
        matchedRunIds,
        matchedRecordCount: pending.length,
        localCommitStatus: scopedLocalCommitStatus,
        cleanupRecoveryRequired: true,
        disposedCount: 0
      };
    }
    const disposedCount = cleanup.filter((result) => result.cleanup === "disposed").length;
    const recoveryWarning = joinNativeLifecycleWarnings([
      ...settlementWarnings,
      nativeCleanupRecoveryWarning(cleanup)
    ]);
    const cleanupStatuses = cleanup.length
      ? cleanup.map((result) => result.cleanup)
      : settledStatuses;
    this.lastNativeLifecycleSummary = {
      ...(pending.length ? { localCommitStatus: "committed" as const } : {}),
      cleanupStatuses: settlementWarnings.length
        ? Array.from(new Set([...settledStatuses, ...cleanupStatuses]))
        : cleanupStatuses,
      cleanupAttempted: cleanup.some((result) => result.attempted),
      disposedCount,
      recordIds: Array.from(new Set([
        ...pending.map(([recordId]) => recordId),
        ...cleanup.map((result) => result.recordId)
      ])),
      recoveryRequired: Boolean(recoveryWarning),
      ...(recoveryWarning ? { warning: recoveryWarning } : {})
    };
    return {
      requestedRunIds,
      matchedRunIds,
      matchedRecordCount: pending.length,
      localCommitStatus: scopedLocalCommitStatus,
      cleanupRecoveryRequired: Boolean(recoveryWarning),
      disposedCount
    };
  }

  private async enqueueNativeExecutionSettlement<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const run = this.nativeExecutionSettlementTail.then(
      operation,
      operation
    );
    this.nativeExecutionSettlementTail = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  private hasSettledNativeExecutionRunReceipt(runId: string): boolean {
    if (!this.settledNativeExecutionRunIds.delete(runId)) return false;
    this.settledNativeExecutionRunIds.set(runId, true);
    return true;
  }

  private rememberSettledNativeExecutionRunReceipt(runId: string): void {
    this.settledNativeExecutionRunIds.delete(runId);
    this.settledNativeExecutionRunIds.set(runId, true);
    while (
      this.settledNativeExecutionRunIds.size
      > SETTLED_NATIVE_EXECUTION_RUN_RECEIPT_LIMIT
    ) {
      const oldestEntry = this.settledNativeExecutionRunIds.keys().next();
      if (oldestEntry.done) break;
      this.settledNativeExecutionRunIds.delete(oldestEntry.value);
    }
  }

  getLastNativeLifecycleSummary(): KnowledgeBaseNativeLifecycleSummary | null {
    return this.lastNativeLifecycleSummary;
  }

  private async runCodexKnowledgeTask(input: {
    harnessRunId?: string;
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    writeScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
    resources?: PreparedAgentResources;
    artifactRecovery?: KnowledgeAgentArtifactRecovery;
    vaultProfileSections?: ContextSection[];
    onSubmitted?: () => void;
    vaultPathOverride?: string;
    writableRootsOverride?: string[];
    requireExactWriteFence?: boolean;
    exactWriteFence?: AgentExactWriteFenceContext;
    onExactWriteFenceConfigured?: (receipt: AgentExactWriteFenceReceipt) => void | Promise<void>;
  }): Promise<KnowledgeAgentTaskOutput> {
    let status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected) status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
    if (!status.connected || !this.plugin.hasCodexHarnessTransport()) {
      throw new Error(this.formatCodexDiagnostic(status.errors[0] || "Codex 未连接", this.plugin.settings.defaultModel));
    }
    this.throwIfCanceled();
    const taskVaultPath = input.vaultPathOverride ?? this.plugin.getVaultPath();
    assertAttemptSourcesStayInsideVault(input.sources, input.vaultPathOverride);
    const baseOptions = buildCodexKnowledgeTurnOptions({
      settings: this.plugin.settings,
      availableModels: status.models,
      vaultPath: taskVaultPath,
      permission: input.permission,
      writeScope: input.writeScope,
      overrides: input.turnOptionOverrides,
      disableExternalResources:
        isMaintenanceManagedKind(input.managedKind)
    });
    const options = input.writableRootsOverride === undefined
      ? baseOptions
      : { ...baseOptions, writableRoots: [...input.writableRootsOverride] };
    const inactivityTimeoutMs = normalizeCodexInactivityTimeoutMs(input.turnOptionOverrides?.codexInactivityTimeoutMs);
    const harnessSession = input.managedKind === "ask"
      ? input.turnOptionOverrides?.harnessSession ?? ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath())
      : undefined;
    const harnessSessionId = harnessSession?.id || this.plugin.settings.knowledgeBase.sessionId || "knowledge";
    let threadId = "";
    const harnessRunId = input.harnessRunId || newId("knowledge-codex");
    let nativeRecordPromise: Promise<NativeExecutionRecord | null> | null = null;
    let registeredNativeExecutionId = "";
    let nativeRegistrationFailure: NativeRunRegistrationError | null = null;
    let harnessResult: HarnessRunResult | undefined;
    const queueNativeCommit = async (outcome: NativeRunOutcome): Promise<void> => {
      if (input.managedKind === "ask") {
        this.queueHarnessNativeExecutionCommits(
          harnessRunId,
          outcome,
          harnessResult,
          "codex-cli",
          input.managedKind
        );
        return;
      }
      const recoveryRecord = await nativeRecordPromise?.catch(() => null);
      if (recoveryRecord) {
        this.pendingNativeExecutionCommits.set(recoveryRecord.id, {
          runId: harnessRunId,
          runOutcome: outcome,
          recoveryRecord
        });
      }
    };
    const adapter = this.plugin.createCodexRichAgentAdapter({
      displayName: "Codex",
      version: "rich-runtime",
      artifactRecovery: input.artifactRecovery ? async () => await input.artifactRecovery?.() ?? null : undefined,
      inactivityTimeoutMs,
      turnOptions: options,
      requireExactWriteFence: input.requireExactWriteFence,
      exactWriteFence: input.exactWriteFence,
      onExactWriteFenceConfigured: input.onExactWriteFenceConfigured,
      getNativeThreadId: () => threadId || undefined,
      setNativeThreadId: (nextThreadId) => { threadId = nextThreadId; },
      nativeRefContext: this.plugin.getNativeExecutionRefContext("codex-cli"),
      buildInput: async (currentThreadId) => {
        threadId = currentThreadId;
        await this.plugin.setCodexHarnessThreadName(threadId, `Codex EchoInk KB: ${input.managedKind}`).catch(() => undefined);
        this.throwIfCanceled();
        return buildCodexKnowledgeInput(input.prompt, input.sources);
      },
      startThread: async (requestOptions) => {
        try {
          return await this.plugin.startCodexHarnessThread(requestOptions ?? options);
        } catch (error) {
          status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
          if (!status.connected || !this.plugin.hasCodexHarnessTransport()) throw error;
          return await this.plugin.startCodexHarnessThread(requestOptions ?? options);
        }
      },
      resumeThread: async (currentThreadId, requestOptions) => await this.plugin.resumeCodexHarnessThread(currentThreadId, requestOptions ?? options),
      startTurn: async (currentThreadId, requestInput, requestOptions) => await rejectAfterTimeout(
        (async () => {
          input.onSubmitted?.();
          return await this.plugin.startCodexHarnessTurn(currentThreadId, requestInput, requestOptions ?? options);
        })(),
        inactivityTimeoutMs,
        () => undefined,
        `长时间没有收到 Codex turn id（${formatDurationForError(inactivityTimeoutMs)}），已结束本轮知识库任务。`
      )
    });

    try {
      harnessResult = await this.plugin.runHarnessWithAdapter({
        adapter,
        ...(harnessSession ? { sessionProvider: () => harnessSession } : {}),
        ...(input.managedKind !== "ask"
          ? {
            registerNativeExecution: async ({ native }: {
              native: NativeExecutionRef;
            }) => {
              if (native.backendId !== "codex-cli" || !native.id.trim()) {
                throw new NativeRunRegistrationError(
                  "Codex Native execution registration received an invalid thread reference"
                );
              }
              if (
                registeredNativeExecutionId
                && registeredNativeExecutionId !== native.id
              ) {
                throw new NativeRunRegistrationError(
                  "Codex Native execution changed before the structured Knowledge prompt was submitted"
                );
              }
              registeredNativeExecutionId = native.id;
              nativeRecordPromise ??= this.recordNativeExecution({
                runId: harnessRunId,
                native,
                managedKind: input.managedKind
              });
              let record: NativeExecutionRecord;
              try {
                record = await requireNativeExecutionRegistration(
                  nativeRecordPromise,
                  "Codex",
                  native.id
                );
              } catch (error) {
                nativeRegistrationFailure = nativeRunRegistrationError(
                  error,
                  "Codex",
                  native.id
                );
                throw nativeRegistrationFailure;
              }
              return { recordId: record.id };
            }
          }
          : {}),
        request: {
          runId: harnessRunId,
          sessionId: harnessSessionId,
          surface: "knowledge",
          workflow: knowledgeWorkflowForManagedKind(input.managedKind),
          backendId: "codex-cli",
          workspace: { vaultPath: taskVaultPath, cwd: taskVaultPath },
          input: {
            text: input.prompt,
            attachments: input.sources.map((source) => ({
              type: source.modality === "image" ? "image" as const : source.mime === "application/pdf" ? "pdf" as const : "file" as const,
              path: source.absolutePath,
              name: path.basename(source.absolutePath),
              mime: source.mime
            }))
          },
          permissions: {
            mode: input.permission,
            writableRoots: options.writableRoots ?? [],
            requireApproval: true
          },
          resourceSelection: input.resources
            ? resourceSelectionFromPreparedResources(input.resources, "codex-cli")
            : { selected: [], resolvedAt: Date.now(), warnings: [] },
          memoryPolicy: memoryRequestPolicy(knowledgeWorkflowForManagedKind(input.managedKind)),
          outputContract: { kind: input.managedKind === "ask" ? "plain-text" : "knowledge-ledger" },
          vaultProfileSections: input.vaultProfileSections
        }
      });
      if (harnessResult.status === "cancelled") throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      if (harnessResult.status !== "running") throw new Error(harnessResult.error || "Codex 知识库任务未启动");
      if (input.managedKind === "ask" && harnessSession && harnessResult.backendBinding) {
        updateSessionBackendBinding(harnessSession, harnessResult.backendBinding);
      }
      if (input.managedKind !== "ask" && !nativeRecordPromise) {
        throw new NativeRunRegistrationError(
          "Codex structured Knowledge run crossed the adapter boundary without a durable Native registration"
        );
      }
      const text = this.resolveCodexKnowledgeRunText(await adapter.awaitResult(harnessRunId), options.model);
      await this.settleKnowledgeHarnessRun({ runId: harnessRunId, status: "completed", backendId: "codex-cli", text });
      await queueNativeCommit("success");
      return { text, harnessResult: { ...harnessResult, status: "completed", outputText: text } };
    } catch (error) {
      const taskError: unknown = nativeRegistrationFailure ?? error;
      const cancelled = isKnowledgeBaseCancelError(errorMessage(taskError));
      if (harnessResult?.status === "running") {
        await this.settleKnowledgeHarnessRun({
          runId: harnessRunId,
          status: cancelled ? "cancelled" : "failed",
          backendId: "codex-cli",
          error: errorMessage(taskError)
        }).catch(() => undefined);
      }
      await queueNativeCommit(cancelled ? "cancelled" : "failed");
      throw taskError;
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  }

  private async recordNativeExecution(input: {
    runId: string;
    native: NativeExecutionRef;
    managedKind: KnowledgeBaseManagedThreadKind;
  }): Promise<NativeExecutionRecord | null> {
    if (typeof (this.plugin as unknown as { recordNativeExecution?: unknown }).recordNativeExecution !== "function") return null;
    const recordId = `knowledge-native:${input.runId}:${input.native.backendId}`;
    const now = Date.now();
    const record: NativeExecutionRecord = {
      id: recordId,
      runId: input.runId,
      sessionId: this.plugin.settings.knowledgeBase.sessionId || "knowledge",
      surface: "knowledge",
      workflow: knowledgeWorkflowForManagedKind(input.managedKind),
      native: input.native,
      policy: knowledgeNativeSessionPolicy(input.managedKind),
      localCommit: "pending",
      cleanup: "not-needed",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
      createdAt: now,
      settledAt: 0,
      committedAt: 0,
      disposedAt: 0
    };
    await this.plugin.recordNativeExecution(record);
    return record;
  }

  private queueHarnessNativeExecutionCommits(
    runId: string,
    runOutcome: NativeRunOutcome,
    result: HarnessRunResult | undefined,
    backend: AgentBackendKind,
    managedKind: KnowledgeBaseManagedThreadKind
  ): void {
    const recordIds = harnessNativeExecutionRecordIds(result);
    for (const recordId of recordIds) {
      const native = recordIds.length === 1
        ? result?.nativeExecution
        : undefined;
      this.pendingNativeExecutionCommits.set(recordId, {
        runId,
        runOutcome,
        recoveryRecord: this.nativeExecutionRecoveryRecord({
          recordId,
          runId,
          backend,
          managedKind,
          native
        })
      });
    }
  }

  private nativeExecutionRecoveryRecord(input: {
    recordId: string;
    runId: string;
    backend: AgentBackendKind;
    managedKind?: KnowledgeBaseManagedThreadKind;
    native?: NativeExecutionRef;
  }): NativeExecutionRecord {
    const now = Date.now();
    const native = input.native ?? {
      backendId: input.backend,
      id: "unknown",
      kind: input.backend === "codex-cli"
        ? "thread" as const
        : harnessKnowledgeTaskNativeExecutionKind(input.backend),
      persistence: input.backend === "codex-cli"
        ? "provider-persistent" as const
        : harnessKnowledgeTaskNativeExecutionPersistence(input.backend),
      deviceKey: "unknown",
      vaultId: "unknown",
      createdAt: now
    };
    return {
      id: input.recordId,
      runId: input.runId,
      sessionId: this.plugin.settings.knowledgeBase.sessionId || "knowledge",
      surface: "knowledge",
      workflow: input.managedKind
        ? knowledgeWorkflowForManagedKind(input.managedKind)
        : "knowledge.recovery",
      native,
      policy: input.managedKind
        ? knowledgeNativeSessionPolicy(input.managedKind)
        : {
          historyAuthority: "echoink",
          mode: "ephemeral-run",
          preferredDisposition: ["retain"],
          retainWhenLocalCommitFails: true,
          cleanupRequiredForTaskSuccess: false
        },
      localCommit: "pending",
      cleanup: "not-needed",
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
      createdAt: native.createdAt || now,
      settledAt: 0,
      committedAt: 0,
      disposedAt: 0
    };
  }

  private async retainMissingNativeExecutionReceipt(
    recordId: string,
    item: PendingNativeExecutionCommit
  ): Promise<{ settled: NativeExecutionRecord | null; warning: string }> {
    const warning = item.missingReceiptWarning
      ?? `Native Execution 结算回执缺失，已保留恢复记录：${recordId}`;
    item.missingReceiptWarning = warning;
    const recoveryRecord = item.recoveryRecord;
    let registrationError = "";
    try {
      await this.plugin.recordNativeExecution(recoveryRecord);
    } catch (error) {
      registrationError = errorMessage(error);
    }
    try {
      const settled = await this.plugin.settleNativeExecution({
        recordId,
        runOutcome: item.runOutcome,
        localCommit: localDurableCommitResult(false, warning)
      });
      if (settled) return { settled, warning };
      return {
        settled: null,
        warning: joinNativeLifecycleWarnings([
          warning,
          registrationError
            ? `Native Execution 恢复记录登记失败：${registrationError}`
            : "Native Execution 恢复记录仍无法读取"
        ])
      };
    } catch (error) {
      return {
        settled: null,
        warning: joinNativeLifecycleWarnings([
          warning,
          registrationError
            ? `Native Execution 恢复记录登记失败：${registrationError}`
            : "",
          `Native Execution 恢复记录结算失败：${errorMessage(error)}`
        ])
      };
    }
  }

  private buildCodexNativeExecutionRef(threadId: string): NativeExecutionRef {
    return {
      backendId: "codex-cli",
      id: threadId,
      kind: "thread",
      persistence: "provider-persistent",
      ...this.plugin.getNativeExecutionRefContext("codex-cli"),
      createdAt: Date.now()
    };
  }

  private knowledgeHarnessOptions(vaultPathOverride?: string) {
    const session = vaultPathOverride
      ? null
      : ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath());
    const taskVaultPath = vaultPathOverride ?? this.plugin.getVaultPath();
    return {
      vaultPath: taskVaultPath,
      cwd: taskVaultPath,
      sessionId: session?.id || this.plugin.settings.knowledgeBase.sessionId || "knowledge-maintenance",
      ...(session
        ? { sessionProvider: (sessionId: string) => sessionId === session.id ? session : null }
        : {}),
      nativeRefContextForBackend: (backendId: AgentBackendKind) => this.plugin.getNativeExecutionRefContext(backendId),
      runWithAdapter: (input: Parameters<CodexForObsidianPlugin["runHarnessWithAdapter"]>[0]) => this.plugin.runHarnessWithAdapter(input)
    };
  }

  private async commitKnowledgeRunDurably(runIds: string[]): Promise<LocalRunCommitResult> {
    const terminalErrors = await this.flushPendingHarnessTerminalSettlements();
    if (terminalErrors.length) return localDurableCommitResult(false, terminalErrors.join("; "));
    const startedError = await this.emitLocalCommitEvents(runIds, "run.local_commit.started");
    if (startedError) return localDurableCommitResult(false, startedError);
    const committed = await this.plugin.commitKnowledgeRunDurably();
    if (!committed.committed) {
      await this.emitLocalCommitEvents(runIds, "run.local_commit.failed", committed.error);
      return committed;
    }
    const completedError = await this.emitLocalCommitEvents(runIds, "run.local_commit.completed");
    return completedError ? { ...committed, committed: false, runLedgerCommitted: false, error: completedError } : committed;
  }

  private async emitLocalCommitEvents(
    runIds: string[],
    type: "run.local_commit.started" | "run.local_commit.completed" | "run.local_commit.failed",
    error?: string
  ): Promise<string> {
    try {
      for (const runId of new Set(runIds.filter(Boolean))) {
        await this.plugin.appendHarnessRunEvent({ runId, source: "workflow", type, error });
      }
      return "";
    } catch (eventError) {
      return errorMessage(eventError);
    }
  }

  private async settleKnowledgeHarnessRun(input: SettleRunTerminalInput): Promise<void> {
    const settlement = this.pendingHarnessTerminalSettlements.get(input.runId) ?? input;
    this.pendingHarnessTerminalSettlements.set(input.runId, settlement);
    await this.plugin.settleHarnessRunTerminal(settlement);
    this.pendingHarnessTerminalSettlements.delete(input.runId);
  }

  private async flushPendingHarnessTerminalSettlements(): Promise<string[]> {
    const errors: string[] = [];
    for (const settlement of this.pendingHarnessTerminalSettlements.values()) {
      await this.settleKnowledgeHarnessRun(settlement).catch((error) => errors.push(errorMessage(error)));
    }
    return errors;
  }

  private async migrateLegacyManagedThreads(): Promise<number> {
    const settings = this.plugin.settings.knowledgeBase as typeof this.plugin.settings.knowledgeBase & {
      managedThreads?: Record<string, KnowledgeBaseManagedThread>;
      legacyManagedThreads?: Record<string, KnowledgeBaseManagedThread>;
    };
    const managed = settings.legacyManagedThreads ?? settings.managedThreads ?? {};
    const entries = Object.values(managed);
    if (!entries.length) return 0;
    for (const thread of entries) {
      await this.plugin.recordNativeExecution(this.legacyManagedThreadRecord(thread));
      delete managed[thread.threadId];
    }
    delete settings.legacyManagedThreads;
    delete settings.managedThreads;
    await this.plugin.saveSettings(true, { strictConversationStore: true });
    return entries.length;
  }

  private hasNativeExecutionLifecycle(): boolean {
    const plugin = this.plugin as unknown as Record<string, unknown>;
    return typeof plugin.recordNativeExecution === "function"
      && typeof plugin.settleNativeExecution === "function"
      && typeof plugin.cleanupDueNativeExecutions === "function";
  }

  private legacyManagedThreadRecord(thread: KnowledgeBaseManagedThread): NativeExecutionRecord {
    const now = Date.now();
    const committed = thread.archiveState !== "running";
    return {
      id: `legacy-codex-thread:${thread.threadId}`,
      runId: thread.runId || `legacy:${thread.threadId}`,
      sessionId: this.plugin.settings.knowledgeBase.sessionId || "knowledge",
      surface: "knowledge",
      workflow: knowledgeWorkflowForManagedKind(thread.kind),
      native: this.buildCodexNativeExecutionRef(thread.threadId),
      policy: knowledgeNativeSessionPolicy(thread.kind),
      runOutcome: "success",
      localCommit: committed ? "committed" : "failed",
      cleanup: committed ? "pending" : "retained-for-recovery",
      requestedDisposition: "archive",
      attempts: thread.attempts,
      nextAttemptAt: committed ? now : 0,
      lastError: thread.lastError,
      createdAt: thread.createdAt || now,
      settledAt: thread.settledAt || now,
      committedAt: committed ? (thread.settledAt || now) : 0,
      disposedAt: thread.archivedAt || 0
    };
  }

  private resolveCodexKnowledgeRunText(result: AgentRunResult, model: string): string {
    if (result.status === "completed") return result.outputText ?? "";
    if (result.status === "cancelled") throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
    throw new Error(this.formatCodexDiagnostic(result.error || "Codex 知识库任务失败", model));
  }

  private formatCodexDiagnostic(error: unknown, model: string): string {
    return diagnoseCodexError(error, {
      model,
      providerLabel: providerConnectionLabel(this.plugin.settings),
      proxyEnabled: this.plugin.settings.proxyEnabled,
      proxyUrl: this.plugin.settings.proxyUrl
    }).text;
  }

  private throwIfCanceled(): void {
    if (this.context.isCancelRequested()) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
}

export function knowledgeWorkflowForManagedKind(kind: KnowledgeBaseManagedThreadKind): HarnessWorkflow {
  if (kind === "ask") return "knowledge.ask";
  if (kind === "lint") return "knowledge.check";
  if (kind === "reingest") return "knowledge.reingest";
  if (kind === "outputs") return "knowledge.outputs";
  if (kind === "inbox") return "knowledge.inbox";
  if (kind === "journal") return "knowledge.journal";
  if (kind === "review") return "review.weekly";
  return "knowledge.maintain";
}

function knowledgeNativeSessionPolicy(kind: KnowledgeBaseManagedThreadKind): NativeSessionPolicy {
  const ask = kind === "ask";
  return {
    historyAuthority: "echoink",
    mode: ask ? "leased-conversation" : "ephemeral-run",
    preferredDisposition: ask ? ["retain"] : ["delete", "archive", "process-exit", "retain"],
    retainWhenLocalCommitFails: true,
    cleanupRequiredForTaskSuccess: false
  };
}

function localDurableCommitResult(committed: boolean, error = ""): LocalRunCommitResult {
  return {
    committed,
    conversationCommitted: committed,
    runLedgerCommitted: committed,
    artifactsCommitted: committed,
    historyIndexCommitted: committed,
    ...(error ? { error } : {})
  };
}

async function requireNativeExecutionRegistration(
  registration: Promise<NativeExecutionRecord | null> | null,
  backendLabel: string,
  nativeExecutionId: string
): Promise<NativeExecutionRecord> {
  if (!registration) {
    throw new NativeRunRegistrationError(
      `${backendLabel} Native execution registration did not start before prompt submission: ${nativeExecutionId}`
    );
  }
  try {
    const record = await registration;
    if (!record) {
      throw new NativeRunRegistrationError(
        `${backendLabel} Native execution registration is unavailable before prompt submission: ${nativeExecutionId}`
      );
    }
    return record;
  } catch (error) {
    if (error instanceof NativeRunRegistrationError) throw error;
    throw new NativeRunRegistrationError(
      `${backendLabel} Native execution registration failed before prompt submission: ${errorMessage(error)}`,
      error
    );
  }
}

function nativeRunRegistrationError(
  error: unknown,
  backendLabel: string,
  nativeExecutionId: string
): NativeRunRegistrationError {
  return error instanceof NativeRunRegistrationError
    ? error
    : new NativeRunRegistrationError(
      `${backendLabel} Native execution registration failed before prompt submission: ${nativeExecutionId}: ${errorMessage(error)}`,
      error
    );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinNativeLifecycleWarnings(warnings: readonly string[]): string {
  return Array.from(new Set(
    warnings
      .map((warning) => warning.trim())
      .filter(Boolean)
  )).join("；");
}

function nativeCleanupRecoveryWarning(
  cleanup: Awaited<ReturnType<CodexForObsidianPlugin["cleanupDueNativeExecutions"]>>
): string {
  const recovery = cleanup.filter((result) =>
    result.cleanup === "failed"
    || result.cleanup === "retained-for-recovery"
    || result.cleanup === "quarantined"
    || result.cleanup === "aborted"
  );
  if (!recovery.length) return "";
  const messages = Array.from(new Set(
    recovery
      .map((result) => result.message?.trim() ?? "")
      .filter(Boolean)
  ));
  return `Native Execution 清理待恢复${messages.length ? `：${messages.slice(0, 3).join("；")}` : ""}`;
}

function harnessResultFromError(error: unknown): HarnessRunResult | undefined {
  if (!error || typeof error !== "object") return undefined;
  const result = (error as { harnessResult?: unknown }).harnessResult;
  if (!result || typeof result !== "object") return undefined;
  const candidate = result as Partial<HarnessRunResult>;
  return typeof candidate.runId === "string" && typeof candidate.status === "string"
    ? result as HarnessRunResult
    : undefined;
}

function harnessNativeExecutionRecordIds(
  result: HarnessRunResult | undefined
): string[] {
  if (!result?.nativeExecutionRecordIds?.length) return [];
  return Array.from(new Set(
    result.nativeExecutionRecordIds
      .map((recordId) => recordId.trim())
      .filter(Boolean)
  ));
}

function terminationConfirmedAtFrom(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { terminationConfirmedAt?: unknown }).terminationConfirmedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function hermesProposalHostDispositionStateAfterError(input: {
  error: unknown;
  nativeSubmitted: boolean;
  trustInjectedTermination: boolean;
}): "not-started" | "exited" | null {
  if (!input.nativeSubmitted) return "not-started";
  if (
    input.error instanceof HermesProposalRuntimeError
    && (
      input.error.code === "timeout"
      || input.error.code === "canceled"
    )
  ) {
    return input.error.terminationConfirmedAt
      && input.trustInjectedTermination
      ? "exited"
      : null;
  }
  // A non-abort runtime rejection is observed only after the child Promise
  // settled; validation and materialization failures occur even later.
  return "exited";
}

function assertAttemptSourcesStayInsideVault(
  sources: KnowledgeBaseSource[],
  vaultPathOverride: string | undefined
): void {
  if (!vaultPathOverride) return;
  const root = path.resolve(vaultPathOverride);
  for (const source of sources) {
    const absolutePath = path.resolve(source.absolutePath);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))) {
      continue;
    }
    throw Object.assign(
      new Error(`Maintenance shadow attachment escaped isolated Vault: ${source.absolutePath}`),
      { code: "UNSAFE_VAULT" }
    );
  }
}

function assertMaintenanceAttemptUsesShadow(
  input: KnowledgeBaseHarnessTaskInput,
  liveVaultPath: string
): void {
  const shadowVaultPath = input.vaultPathOverride?.trim();
  if (!shadowVaultPath || path.resolve(shadowVaultPath) === path.resolve(liveVaultPath)) {
    throw Object.assign(
      new Error("Maintenance attempt requires an isolated Shadow Vault"),
      { code: "UNSAFE_VAULT" }
    );
  }
}

function isMaintenanceManagedKind(
  kind: KnowledgeBaseManagedThreadKind
): kind is Exclude<KnowledgeBaseManagedThreadKind, "ask" | "journal" | "review" | "unknown"> {
  return kind === "maintain"
    || kind === "reingest"
    || kind === "lint"
    || kind === "outputs"
    || kind === "inbox";
}

function assertCompleteMaintenanceAttemptIdentity(
  input: KnowledgeBaseHarnessTaskInput
): void {
  if (
    !input.workflowRunId
    || input.workflowRunId !== input.workflowRunId.trim()
    || !input.attemptId
    || input.attemptId !== input.attemptId.trim()
    || !Number.isSafeInteger(input.attemptOrdinal)
    || (input.attemptOrdinal ?? 0) <= 0
  ) {
    throw Object.assign(
      new Error(
        `Maintenance managedKind=${input.managedKind} requires a complete workflowRunId/attemptId/attemptOrdinal identity`
      ),
      { code: "UNSAFE_VAULT" }
    );
  }
}

function maintenanceAttemptWritableRoots(
  input: KnowledgeBaseHarnessTaskInput,
  liveVaultPath: string
): string[] {
  if (input.permission === "read-only") return [];
  const vaultRoot = path.resolve(input.vaultPathOverride ?? liveVaultPath);
  const allowedRelativeRoots = input.codexWriteScope === "knowledge-lint"
    ? new Set(["outputs/maintenance"])
    : input.codexWriteScope === "knowledge-base"
      ? new Set(["wiki", "projects", "outputs/maintenance", "inbox"])
      : new Set<string>();
  const roots = input.writableRootsOverride ?? (
    input.codexWriteScope === "knowledge-lint"
      ? [path.join(vaultRoot, "outputs", "maintenance")]
      : [
        path.join(vaultRoot, "wiki"),
        path.join(vaultRoot, "projects"),
        path.join(vaultRoot, "outputs", "maintenance"),
        path.join(vaultRoot, "inbox")
      ]
  );
  for (const candidate of roots) {
    const absolutePath = path.resolve(candidate);
    const relativePath = path.relative(vaultRoot, absolutePath);
    const escaped = relativePath === ".."
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath);
    const normalizedRelativePath = relativePath.split(path.sep).join("/");
    if (escaped || !allowedRelativeRoots.has(normalizedRelativePath)) {
      throw Object.assign(
        new Error(`Unsafe maintenance writable root: ${candidate}`),
        { code: "UNSAFE_VAULT" }
      );
    }
  }
  return Array.from(new Set(roots.map((root) => path.resolve(root))));
}

function assertHermesMaintenanceProposalTask(
  input: KnowledgeBaseHarnessTaskInput,
  writableRoots: readonly string[]
): void {
  if (
    input.backend !== "hermes"
    || !input.workflowRunId?.trim()
    || !input.attemptId?.trim()
    || !input.attemptOrdinal
    || !input.vaultPathOverride?.trim()
  ) {
    throw Object.assign(
      new Error("Hermes maintenance proposal 缺少 workflow/attempt/Shadow 身份"),
      { code: "UNSAFE_VAULT" }
    );
  }
  if (!input.sources.length) {
    throw Object.assign(
      new Error("Hermes Agent backend unavailable：proposal v1 需要至少一个 raw 文本来源"),
      { code: "BACKEND_UNAVAILABLE" }
    );
  }
  for (const source of input.sources) {
    if (
      source.modality !== "text"
      || (source.relativePath !== "raw" && !source.relativePath.startsWith("raw/"))
    ) {
      throw Object.assign(
        new Error(`Hermes Agent backend unavailable：proposal v1 不支持来源 ${source.relativePath} (${source.modality})`),
        { code: "BACKEND_UNAVAILABLE" }
      );
    }
  }
  const fenceTask: AgentTaskInput = {
    prompt: input.prompt,
    permission: input.permission,
    writableRoots: [...writableRoots],
    requireExactWriteFence: true,
    exactWriteFence: input.exactWriteFence,
    onExactWriteFenceConfigured: input.onExactWriteFenceConfigured
  };
  assertExactWriteFenceRequest(
    "hermes",
    fenceTask,
    path.resolve(input.vaultPathOverride)
  );
}

async function assertHermesAuthorityMatchesFenceRequest(input: {
  authorityReceipt: HermesVaultNoWriteAuthorityReceipt;
  task: KnowledgeBaseHarnessTaskInput;
  writableRoots: readonly string[];
}): Promise<void> {
  const fence = input.task.exactWriteFence;
  if (
    !fence
    || input.authorityReceipt.backend !== "hermes"
    || input.authorityReceipt.attemptId !== input.task.attemptId
    || input.authorityReceipt.leaseId !== fence.leaseToken
  ) {
    throw Object.assign(
      new Error("POLICY_DENIED: Hermes authority receipt 与当前 attempt/lease 不匹配"),
      { code: "POLICY_DENIED" }
    );
  }
  const [expectedRoots, expectedLive, expectedControl] = await Promise.all([
    canonicalExistingPathSet(input.writableRoots),
    canonicalExistingPathSet(fence.deniedLivePaths),
    canonicalExistingPathSet(fence.deniedControlPaths)
  ]);
  if (
    !sameStringSets(expectedRoots, input.authorityReceipt.hostMaterializerRoots)
    || !sameStringSets(expectedLive, input.authorityReceipt.deniedLivePaths)
    || !sameStringSets(expectedControl, input.authorityReceipt.deniedControlPaths)
  ) {
    throw Object.assign(
      new Error("POLICY_DENIED: Hermes authority receipt 的 materializer/拒写路径与当前 Shadow 不一致"),
      { code: "POLICY_DENIED" }
    );
  }
}

async function canonicalExistingPathSet(values: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const value of values) {
    if (!path.isAbsolute(value)) {
      throw Object.assign(
        new Error(`POLICY_DENIED: Hermes fence 路径不是绝对路径：${value}`),
        { code: "POLICY_DENIED" }
      );
    }
    result.push(path.resolve(await fsp.realpath(path.resolve(value))));
  }
  return Array.from(new Set(result)).sort();
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  const normalizedRight = Array.from(new Set(right.map((value) => path.resolve(value)))).sort();
  return left.length === normalizedRight.length
    && left.every((value, index) => value === normalizedRight[index]);
}

function normalizeHermesProbeOperationTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 15_000;
}

function scaledHermesProbeTimeoutMs(value: number, multiplier: number): number {
  return Math.min(
    2_147_483_647,
    Math.max(1, Math.trunc(value)) * Math.max(1, Math.trunc(multiplier))
  );
}

async function runHermesServiceProbeOperation<T>(input: {
  label: string;
  timeoutMs: number;
  externalSignal: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  if (input.externalSignal.aborted) {
    throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
  const controller = new AbortController();
  let rejectGate!: (error: Error) => void;
  const abortGate = new Promise<never>((_resolve, reject) => {
    rejectGate = reject;
  });
  const abort = (kind: "canceled" | "timeout"): void => {
    if (controller.signal.aborted) return;
    controller.abort(kind);
    rejectGate(kind === "canceled"
      ? new Error(KNOWLEDGE_BASE_CANCEL_ERROR)
      : Object.assign(
        new Error(`${input.label} 超过 ${input.timeoutMs}ms`),
        { code: "BACKEND_UNAVAILABLE" }
      ));
  };
  const onExternalAbort = (): void => abort("canceled");
  input.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  if (input.externalSignal.aborted) abort("canceled");
  const timeout = setTimeout(() => abort("timeout"), input.timeoutMs);
  try {
    const operationPromise = Promise.resolve().then(() =>
      input.operation(controller.signal)
    );
    return await Promise.race([operationPromise, abortGate]);
  } finally {
    clearTimeout(timeout);
    input.externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

function hermesProposalCredentialEnvironment(
  providerId: string,
  configuredApiKey: string
): Readonly<Record<string, string>> {
  const credentialKey = providerId === "openrouter"
    ? "OPENROUTER_API_KEY"
    : providerId === "deepseek"
      ? "DEEPSEEK_API_KEY"
      : "";
  if (!credentialKey) return Object.freeze({});
  const value = configuredApiKey.trim() || process.env[credentialKey]?.trim() || "";
  return Object.freeze(value ? { [credentialKey]: value } : {});
}

async function hermesProposalCredentialFiles(): Promise<readonly {
  sourcePath: string;
  destinationName: "auth.json";
}[]> {
  const sourcePath = path.join(os.homedir(), ".hermes", "auth.json");
  try {
    await fsp.lstat(sourcePath);
    return Object.freeze([Object.freeze({
      sourcePath,
      destinationName: "auth.json" as const
    })]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

async function hermesProposalIsolationRoot(): Promise<string> {
  const realTempPath = path.resolve(await fsp.realpath(os.tmpdir()));
  const rootPath = path.join(realTempPath, "echoink-hermes-proposal");
  await fsp.mkdir(rootPath, { recursive: true, mode: 0o700 });
  return rootPath;
}

async function cleanupHermesProposalIsolation(
  capability: HermesVaultNoWriteCapability
): Promise<void> {
  const attemptRoot = path.dirname(capability.isolatedHomePath);
  if (!path.basename(attemptRoot).startsWith("hermes-proposal-")) {
    throw new Error("Refusing to clean an unexpected Hermes proposal isolation root");
  }
  await fsp.rm(attemptRoot, { recursive: true, force: true });
}

function shouldRetainHermesProposalIsolation(error: unknown): boolean {
  return error instanceof HermesProposalRuntimeError
    && (
      error.code === "timeout"
      || error.code === "canceled"
      || error.code === "late_output_rejected"
    );
}

export function knowledgeBackendModelLabel(plugin: CodexForObsidianPlugin, backend: AgentBackendKind): string {
  return harnessMessageModelId(plugin.settings, backend);
}
