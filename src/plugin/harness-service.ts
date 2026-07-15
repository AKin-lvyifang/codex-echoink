import * as path from "path";
import type CodexForObsidianPlugin from "../main";
import type { TurnOptions } from "../core/codex-service";
import { pluginDataDir } from "../core/raw-message-store";
import type { AgentBackendKind } from "../agent/types";
import type { AgentAdapter } from "../harness/agents/adapter";
import { createHarnessAgentAdapter } from "../harness/agents/adapter-factory";
import { CodexRichAgentAdapter, type CodexRichAgentAdapterOptions } from "../harness/agents/adapters/codex-rich-adapter";
import { CodexRichNotificationHub } from "../harness/agents/adapters/codex-rich-notification-hub";
import type { HarnessEventSink } from "../harness/contracts/event";
import type { NativeExecutionRecord } from "../harness/contracts/native-execution";
import type { NativeExecutionDispositionResult, NativeSessionLease } from "../harness/contracts/native-execution";
import { EchoInkHarnessKernel, type HarnessRunWithAdapterInput } from "../harness/kernel/harness-kernel";
import { NativeSessionLeaseManager, type NativeSessionLeaseCleanupExecutionResult } from "../harness/kernel/native-session-lease-manager";
import { sessionNativeExecutionRefs } from "../harness/kernel/session-service";
import type { AppendRunEventInput, SettleRunTerminalInput } from "../harness/kernel/run-orchestrator";
import { FileRunLedger } from "../harness/ledger/run-ledger";
import {
  buildCodexMemoryMigrationPreview,
  FileMemoryProvider,
  type CodexMemoryImportResult,
  type CodexMemoryMigrationPreview,
  type InitializeEchoInkMemoryResult,
  type MemoryStoreStatus
} from "../harness/memory/file-memory";
import type { MemorySyncResult } from "../harness/memory/v2-engine";
import { NoopMemoryProvider } from "../harness/memory/noop-provider";
import { BackendNeutralMemoryCurator } from "../harness/memory/backend-curator";
import { NativeExecutionManager, type NativeCleanupResult, type SettleNativeExecutionInput } from "../harness/native/native-execution-manager";
import { NativeExecutionStore } from "../harness/native/native-execution-store";
import { buildEchoInkResourceCatalog } from "../resources/registry";
import { loadVaultEchoInkResources } from "../resources/vault-resource-catalog";
import type { EchoInkResource } from "../resources/types";
import type { StoredSession } from "../settings/settings";
import type { CodexNotification, UserInput } from "../types/app-server";

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

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  async runWithAdapter(input: HarnessRunWithAdapterInput) {
    return await this.getHarnessKernel().runWithAdapter(input);
  }

  async settleRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<void> {
    await this.getHarnessKernel().settleRunTerminal(input, sink);
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
    const providerEndpoint = backendId === "opencode"
      ? this.plugin.settings.opencode.serverUrl.trim() || `http://${this.plugin.settings.opencode.hostname || "127.0.0.1"}:${this.plugin.settings.opencode.port || 4096}`
      : backendId === "hermes"
        ? this.plugin.settings.agents.hermes.serverUrl.trim()
        : "";
    return {
      deviceKey: this.getNativeExecutionDeviceKey(),
      vaultId: this.plugin.getVaultPath(),
      ...(providerEndpoint ? { providerEndpoint: providerEndpoint.replace(/\/$/, "") } : {})
    };
  }

  async recordNativeExecution(record: NativeExecutionRecord): Promise<void> {
    await this.getNativeExecutionManager().recordCreated(record);
  }

  async settleNativeExecution(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> {
    return await this.getNativeExecutionManager().settleRun(input);
  }

  async cleanupDueNativeExecutions(limit = 20): Promise<NativeCleanupResult[]> {
    return await this.getNativeExecutionManager().cleanupDue(limit);
  }

  async enforceNativeSessionLeaseLimits(): Promise<NativeSessionLeaseCleanupExecutionResult[]> {
    const run = this.nativeLeaseCleanupQueue
      .catch(() => [])
      .then(async () => await this.nativeSessionLeaseManager.cleanupSessions({
        sessions: this.plugin.settings.sessions,
        now: Date.now(),
        commit: async () => await this.plugin.saveSettings(true, { strictConversationStore: true }),
        dispose: async (lease, reason) => await this.disposeNativeSessionLease(lease, reason)
      }));
    this.nativeLeaseCleanupQueue = run;
    return await run;
  }

  async commitEchoInkSessionDeletion(session: StoredSession): Promise<NativeCleanupResult[]> {
    await this.plugin.saveSettings(true, { strictConversationStore: true });
    await this.plugin.deleteStoredConversationSession(session.id);
    return await this.cleanupSessionNativeExecutions(session, "session.delete");
  }

  async resetEchoInkSessionNativeCache(session: StoredSession): Promise<NativeCleanupResult[]> {
    const previousBindings = session.backendBindings;
    const previousThreadId = session.threadId;
    const cleanupSession: StoredSession = { ...session, backendBindings: previousBindings, threadId: previousThreadId };
    if (!sessionNativeExecutionRefs(cleanupSession).length) return [];
    session.backendBindings = Object.fromEntries(Object.entries(previousBindings ?? {}).map(([backendId, binding]) => [
      backendId,
      { ...binding, leaseStatus: "cleanup-pending" as const }
    ]));
    delete session.threadId;
    try {
      await this.plugin.saveSettings(true, { strictConversationStore: true });
    } catch (error) {
      session.backendBindings = previousBindings;
      session.threadId = previousThreadId;
      throw error;
    }
    const results = await this.cleanupSessionNativeExecutions(cleanupSession, "session.cache-reset");
    delete session.backendBindings;
    await this.plugin.saveSettings(true, { strictConversationStore: true });
    return results;
  }

  async failPendingNativeExecutionsForRecovery(input: { reason: string; surface?: string; sessionId?: string }): Promise<number> {
    const manager = this.getNativeExecutionManager();
    const filter = { surface: input.surface, sessionId: input.sessionId };
    const pending = await manager.listPendingLocalCommits(filter);
    for (const record of pending) {
      await this.settleRunTerminal({
        runId: record.runId,
        status: "failed",
        backendId: record.native.backendId,
        error: input.reason
      }).catch(() => undefined);
    }
    return await manager.markPendingLocalCommitsFailed(input.reason, filter);
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
    return buildEchoInkResourceCatalog({
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
      memoryProvider: this.plugin.settings.memory.enabled ? this.getFileMemoryProvider() : new NoopMemoryProvider()
    });
    return this.harnessKernel;
  }

  private createRunLedger(): FileRunLedger {
    return new FileRunLedger({
      rootPath: path.join(pluginDataDir(this.plugin.getVaultPath(), this.plugin.getPluginDataDirName()), "harness-runs")
    });
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

  private async disposeNativeSessionLease(
    lease: NativeSessionLease,
    _reason: string
  ): Promise<NativeExecutionDispositionResult> {
    const adapter = this.createNativeCleanupAdapter(lease.backendId as AgentBackendKind);
    const capabilities = adapter.manifest.nativeExecution?.dispositions;
    const requested = capabilities?.delete
      ? "delete" as const
      : capabilities?.archive
        ? "archive" as const
        : capabilities?.processExit
          ? "process-exit" as const
          : "retain" as const;
    if (requested === "retain" || !adapter.disposeNativeExecution) {
      return { outcome: "retained", message: `${adapter.manifest.displayName} does not expose native cache cleanup` };
    }
    try {
      await adapter.connect({
        runId: `lease-cleanup:${lease.leaseId}`,
        sessionId: lease.echoInkSessionId,
        workspace: { vaultPath: this.plugin.getVaultPath(), cwd: this.plugin.getVaultPath() }
      });
      return await adapter.disposeNativeExecution({ ref: lease.native, requested, reason: "manual" });
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  }

  private async cleanupSessionNativeExecutions(session: StoredSession, workflow: string): Promise<NativeCleanupResult[]> {
    const manager = this.getNativeExecutionManager();
    const now = Date.now();
    const results: NativeCleanupResult[] = [];
    for (const native of sessionNativeExecutionRefs(session)) {
      const recordId = `${workflow}:${session.id}:${native.backendId}`;
      try {
        results.push(await manager.cleanupCommitted({
          id: recordId,
          runId: `${workflow}:${session.id}`,
          sessionId: session.id,
          surface: "chat",
          workflow,
          native,
          policy: {
            historyAuthority: "echoink",
            mode: "leased-conversation",
            preferredDisposition: ["delete", "archive", "process-exit", "retain"],
            retainWhenLocalCommitFails: true,
            cleanupRequiredForTaskSuccess: false
          },
          localCommit: "committed",
          cleanup: "pending",
          attempts: 0,
          nextAttemptAt: now,
          lastError: "",
          createdAt: now,
          settledAt: now,
          committedAt: now,
          disposedAt: 0,
          emitEvents: false,
          dispositionReason: "manual"
        }));
      } catch (error) {
        console.error("EchoInk session native cleanup scheduling failed", error);
        results.push({
          recordId,
          cleanup: "failed",
          attempted: false,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return results;
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
