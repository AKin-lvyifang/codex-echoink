import * as path from "path";
import type CodexForObsidianPlugin from "../main";
import type { AgentRunResult } from "../harness/agents/adapter";
import {
  harnessKnowledgeTaskNativeExecutionKind,
  harnessKnowledgeTaskNativeExecutionPersistence,
  harnessKnowledgeTaskTimeoutMs,
  harnessMessageModelId
} from "../harness/agents/backend-runtime-profile";
import type {
  LocalRunCommitResult,
  NativeCleanupStatus,
  NativeExecutionRecord,
  NativeExecutionRef,
  NativeRunOutcome,
  NativeSessionPolicy
} from "../harness/contracts/native-execution";
import type { HarnessRunResult, HarnessWorkflow } from "../harness/contracts/run";
import type { SettleRunTerminalInput } from "../harness/kernel/run-orchestrator";
import { sessionBackendBinding, updateSessionBackendBinding } from "../harness/kernel/session-service";
import { memoryRequestPolicy } from "../harness/memory/workflow-policy";
import { resourceSelectionFromPreparedResources } from "../resources/registry";
import {
  ensureKnowledgeBaseSession,
  newId,
  providerConnectionLabel,
  type KnowledgeBaseManagedThread,
  type KnowledgeBaseManagedThreadKind
} from "../settings/settings";
import type { AgentBackendKind } from "../agent/types";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { PermissionMode } from "../types/app-server";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import {
  buildCodexKnowledgeInput,
  collectKnowledgeJournalHistoryForBackend,
  formatDurationForError,
  KnowledgeAgentRuntimeController,
  normalizeCodexInactivityTimeoutMs,
  rejectAfterTimeout,
  type KnowledgeAgentArtifactRecovery,
  type KnowledgeJournalNativeHistory,
  type KnowledgeAgentTaskOutput
} from "./agent-runner";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseTurnOptionOverrides } from "./command-router";
import type { KnowledgeBaseSource } from "./types";

type PendingNativeExecutionCommit = {
  runId: string;
  runOutcome: NativeRunOutcome;
};

export interface KnowledgeBaseNativeLifecycleSummary {
  localCommitStatus?: "committed" | "failed";
  cleanupStatuses: NativeCleanupStatus[];
  cleanupAttempted: boolean;
  disposedCount: number;
  recordIds: string[];
}

export interface KnowledgeBaseAgentTaskServiceContext {
  isCancelRequested(): boolean;
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
}

export class KnowledgeBaseAgentTaskService {
  private readonly runtimeController: KnowledgeAgentRuntimeController;
  private activeHarnessRunId: string | null = null;
  private readonly pendingNativeExecutionCommits = new Map<string, PendingNativeExecutionCommit>();
  private readonly pendingHarnessTerminalSettlements = new Map<string, SettleRunTerminalInput>();
  private readonly activeTaskSettlements = new Set<Promise<void>>();
  private lastNativeLifecycleSummary: KnowledgeBaseNativeLifecycleSummary | null = null;

  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly context: KnowledgeBaseAgentTaskServiceContext
  ) {
    this.runtimeController = new KnowledgeAgentRuntimeController({
      settings: this.plugin.settings,
      vaultPath: () => this.plugin.getVaultPath(),
      saveSettings: async () => await this.plugin.saveSettings(),
      isCanceled: () => this.context.isCancelRequested(),
      harness: () => this.knowledgeHarnessOptions(),
      runCodexTask: async (input) => await this.runCodexKnowledgeTask({
        harnessRunId: input.harnessRunId,
        prompt: input.prompt,
        sources: input.sources,
        permission: input.permission ?? "workspace-write",
        writeScope: input.writeScope,
        turnOptionOverrides: input.turnOptionOverrides as KnowledgeBaseTurnOptionOverrides | undefined,
        managedKind: input.managedKind as KnowledgeBaseManagedThreadKind,
        resources: input.resources,
        artifactRecovery: input.artifactRecovery
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
    let releaseTaskSettlement!: () => void;
    const taskSettlement = new Promise<void>((resolve) => { releaseTaskSettlement = resolve; });
    this.activeTaskSettlements.add(taskSettlement);
    const harnessRunId = newId(`knowledge-${input.backend}`);
    this.activeHarnessRunId = harnessRunId;
    let nativeRecordPromise: Promise<string> | null = null;
    const recordNativeRun = (backend: AgentBackendKind, nativeId: string): void => {
      if (backend === "codex-cli" || !nativeId || nativeRecordPromise) return;
      nativeRecordPromise = this.recordNativeExecution({
        runId: harnessRunId,
        native: this.buildTaskNativeExecutionRef(backend, nativeId),
        managedKind: input.managedKind
      });
    };
    const queueNativeCommit = async (outcome: NativeRunOutcome, result?: HarnessRunResult): Promise<void> => {
      if (!nativeRecordPromise && result?.nativeExecution) {
        nativeRecordPromise = this.recordNativeExecution({
          runId: harnessRunId,
          native: result.nativeExecution,
          managedKind: input.managedKind
        });
      }
      const recordId = await nativeRecordPromise?.catch(() => "");
      if (recordId) this.pendingNativeExecutionCommits.set(recordId, { runId: harnessRunId, runOutcome: outcome });
    };

    try {
      const output = await this.runtimeController.run({
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
        onNativeRunId: recordNativeRun
      });
      if (input.backend !== "codex-cli") await queueNativeCommit("success", output.harnessResult);
      return output;
    } catch (error) {
      if (input.backend !== "codex-cli") {
        await queueNativeCommit(isKnowledgeBaseCancelError(errorMessage(error)) ? "cancelled" : "failed");
      }
      throw error;
    } finally {
      if (this.activeHarnessRunId === harnessRunId) this.activeHarnessRunId = null;
      releaseTaskSettlement();
      this.activeTaskSettlements.delete(taskSettlement);
    }
  }

  async settlePendingNativeExecutions(): Promise<number> {
    this.lastNativeLifecycleSummary = null;
    if (!this.hasNativeExecutionLifecycle()) return 0;
    await this.migrateLegacyManagedThreads();
    const pending = Array.from(this.pendingNativeExecutionCommits.entries());
    const localCommit = pending.length
      ? await this.commitKnowledgeRunDurably(pending.map(([, item]) => item.runId))
      : localDurableCommitResult(true);
    const settledStatuses: NativeCleanupStatus[] = [];
    for (const [recordId, item] of pending) {
      const settled = await this.plugin.settleNativeExecution({
        recordId,
        runOutcome: item.runOutcome,
        localCommit
      });
      if (settled?.cleanup) settledStatuses.push(settled.cleanup);
      if (settled && localCommit.committed) this.pendingNativeExecutionCommits.delete(recordId);
    }
    if (!localCommit.committed) {
      this.lastNativeLifecycleSummary = {
        localCommitStatus: "failed",
        cleanupStatuses: settledStatuses.length ? settledStatuses : ["retained-for-recovery"],
        cleanupAttempted: false,
        disposedCount: 0,
        recordIds: pending.map(([recordId]) => recordId)
      };
      return 0;
    }
    const cleanup = await this.plugin.cleanupDueNativeExecutions(20);
    const disposedCount = cleanup.filter((result) => result.cleanup === "disposed").length;
    this.lastNativeLifecycleSummary = {
      ...(pending.length ? { localCommitStatus: "committed" as const } : {}),
      cleanupStatuses: cleanup.length ? cleanup.map((result) => result.cleanup) : settledStatuses,
      cleanupAttempted: cleanup.some((result) => result.attempted),
      disposedCount,
      recordIds: Array.from(new Set([
        ...pending.map(([recordId]) => recordId),
        ...cleanup.map((result) => result.recordId)
      ]))
    };
    return disposedCount;
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
  }): Promise<KnowledgeAgentTaskOutput> {
    let status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected) status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
    if (!status.connected || !this.plugin.hasCodexHarnessTransport()) {
      throw new Error(this.formatCodexDiagnostic(status.errors[0] || "Codex 未连接", this.plugin.settings.defaultModel));
    }
    this.throwIfCanceled();
    const options = buildCodexKnowledgeTurnOptions({
      settings: this.plugin.settings,
      availableModels: status.models,
      vaultPath: this.plugin.getVaultPath(),
      permission: input.permission,
      writeScope: input.writeScope,
      overrides: input.turnOptionOverrides
    });
    const inactivityTimeoutMs = normalizeCodexInactivityTimeoutMs(input.turnOptionOverrides?.codexInactivityTimeoutMs);
    const harnessSession = input.turnOptionOverrides?.harnessSession ?? (
      input.managedKind === "ask" ? ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath()) : undefined
    );
    const harnessSessionId = harnessSession?.id || this.plugin.settings.knowledgeBase.sessionId || "knowledge";
    let threadId = input.managedKind === "ask" && harnessSession
      ? sessionBackendBinding(harnessSession, "codex-cli")?.nativeThreadId ?? ""
      : "";
    const harnessRunId = input.harnessRunId || newId("knowledge-codex");
    let nativeRecordPromise: Promise<string> | null = null;
    let harnessResult: HarnessRunResult | undefined;
    const queueNativeCommit = async (outcome: NativeRunOutcome): Promise<void> => {
      const recordId = await nativeRecordPromise?.catch(() => "");
      if (recordId) this.pendingNativeExecutionCommits.set(recordId, { runId: harnessRunId, runOutcome: outcome });
    };
    const adapter = this.plugin.createCodexRichAgentAdapter({
      displayName: "Codex",
      version: "rich-runtime",
      artifactRecovery: input.artifactRecovery ? async () => await input.artifactRecovery?.() ?? null : undefined,
      inactivityTimeoutMs,
      turnOptions: options,
      getNativeThreadId: () => threadId || undefined,
      setNativeThreadId: (nextThreadId) => { threadId = nextThreadId; },
      nativeRefContext: this.plugin.getNativeExecutionRefContext("codex-cli"),
      buildInput: async (currentThreadId) => {
        threadId = currentThreadId;
        if (!nativeRecordPromise) {
          nativeRecordPromise = this.recordNativeExecution({
            runId: harnessRunId,
            native: this.buildCodexNativeExecutionRef(threadId),
            managedKind: input.managedKind
          });
        }
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
      resumeThread: async () => undefined,
      startTurn: async (currentThreadId, requestInput, requestOptions) => await rejectAfterTimeout(
        this.plugin.startCodexHarnessTurn(currentThreadId, requestInput, requestOptions ?? options),
        inactivityTimeoutMs,
        () => undefined,
        `长时间没有收到 Codex turn id（${formatDurationForError(inactivityTimeoutMs)}），已结束本轮知识库任务。`
      )
    });

    try {
      harnessResult = await this.plugin.runHarnessWithAdapter({
        adapter,
        ...(harnessSession ? { sessionProvider: () => harnessSession } : {}),
        request: {
          runId: harnessRunId,
          sessionId: harnessSessionId,
          surface: "knowledge",
          workflow: knowledgeWorkflowForManagedKind(input.managedKind),
          backendId: "codex-cli",
          workspace: { vaultPath: this.plugin.getVaultPath(), cwd: this.plugin.getVaultPath() },
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
            writableRoots: [this.plugin.getVaultPath()],
            requireApproval: true
          },
          resourceSelection: input.resources
            ? resourceSelectionFromPreparedResources(input.resources, "codex-cli")
            : { selected: [], resolvedAt: Date.now(), warnings: [] },
          memoryPolicy: memoryRequestPolicy(knowledgeWorkflowForManagedKind(input.managedKind)),
          outputContract: { kind: input.managedKind === "ask" ? "plain-text" : "knowledge-ledger" }
        }
      });
      if (harnessResult.status === "cancelled") throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      if (harnessResult.status !== "running") throw new Error(harnessResult.error || "Codex 知识库任务未启动");
      if (input.managedKind === "ask" && harnessSession && harnessResult.backendBinding) {
        updateSessionBackendBinding(harnessSession, harnessResult.backendBinding);
      }
      if (!nativeRecordPromise && harnessResult.nativeExecution) {
        nativeRecordPromise = this.recordNativeExecution({
          runId: harnessRunId,
          native: harnessResult.nativeExecution,
          managedKind: input.managedKind
        });
      }
      const text = this.resolveCodexKnowledgeRunText(await adapter.awaitResult(harnessRunId), options.model);
      await this.settleKnowledgeHarnessRun({ runId: harnessRunId, status: "completed", backendId: "codex-cli", text });
      await queueNativeCommit("success");
      return { text, harnessResult: { ...harnessResult, status: "completed", outputText: text } };
    } catch (error) {
      const cancelled = isKnowledgeBaseCancelError(errorMessage(error));
      if (harnessResult?.status === "running") {
        await this.settleKnowledgeHarnessRun({
          runId: harnessRunId,
          status: cancelled ? "cancelled" : "failed",
          backendId: "codex-cli",
          error: errorMessage(error)
        }).catch(() => undefined);
      }
      await queueNativeCommit(cancelled ? "cancelled" : "failed");
      throw error;
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  }

  private async recordNativeExecution(input: {
    runId: string;
    native: NativeExecutionRef;
    managedKind: KnowledgeBaseManagedThreadKind;
  }): Promise<string> {
    if (typeof (this.plugin as unknown as { recordNativeExecution?: unknown }).recordNativeExecution !== "function") return "";
    const recordId = `knowledge-native:${input.runId}:${input.native.backendId}`;
    const now = Date.now();
    await this.plugin.recordNativeExecution({
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
    });
    return recordId;
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

  private buildTaskNativeExecutionRef(backend: Exclude<AgentBackendKind, "codex-cli">, nativeId: string): NativeExecutionRef {
    return {
      backendId: backend,
      id: nativeId,
      kind: harnessKnowledgeTaskNativeExecutionKind(backend),
      persistence: harnessKnowledgeTaskNativeExecutionPersistence(backend),
      ...this.plugin.getNativeExecutionRefContext(backend),
      createdAt: Date.now()
    };
  }

  private knowledgeHarnessOptions() {
    const session = ensureKnowledgeBaseSession(this.plugin.settings, this.plugin.getVaultPath());
    return {
      vaultPath: this.plugin.getVaultPath(),
      sessionId: session.id,
      sessionProvider: (sessionId: string) => sessionId === session.id ? session : null,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function knowledgeBackendModelLabel(plugin: CodexForObsidianPlugin, backend: AgentBackendKind): string {
  return harnessMessageModelId(plugin.settings, backend);
}
