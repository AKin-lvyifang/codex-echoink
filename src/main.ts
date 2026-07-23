import { Plugin } from "obsidian";
import type { CodexService, TurnOptions } from "./core/codex-service";
import type { AgentBackendKind } from "./agent/types";
import { AgentRuntimeHealthStore } from "./core/agent-runtime-health";
import type { CodexRichAgentAdapterOptions } from "./harness/agents/adapters/codex-rich-adapter";
import type { HarnessEvent, HarnessEventSink } from "./harness/contracts/event";
import type { LocalRunCommitResult, NativeExecutionRecord } from "./harness/contracts/native-execution";
import type { ConversationMessageAuthorityProbe, ConversationMessageAuthorityProof } from "./harness/conversation/conversation-store";
import type { HarnessRunWithAdapterInput } from "./harness/kernel/harness-kernel";
import type { AppendRunEventInput, SettleRunTerminalInput } from "./harness/kernel/run-orchestrator";
import type { NativeCleanupResult, SettleNativeExecutionInput } from "./harness/native/native-execution-manager";
import type { NativeSessionLeaseCleanupExecutionResult } from "./harness/kernel/native-session-lease-manager";
import type { MaintenanceWorkflowSettingsHost } from "./harness/maintenance/workflow-wal";
import { closeMcpBrokerConnectionPool } from "./resources/mcp-broker";
import type { CallEchoInkMcpToolInput } from "./resources/mcp-broker-service";
import type { EchoInkResource } from "./resources/types";
import type { EditorActionController } from "./editor-actions/controller";
import type { KnowledgeBaseManager } from "./knowledge-base/manager";
import type { KnowledgeBaseHistoryIndex, KnowledgeBaseHistoryRemovalResult, KnowledgeBaseStorageStats } from "./knowledge-base/history-store";
import { maintenanceWorkflowStorageRootForVault } from "./knowledge-base/maintenance-workflow";
import type { ReviewManager } from "./review/manager";
import type { AgentBackendMode, ChatMessage, CodexForObsidianSettings, KnowledgeBaseSettings, ResourceManagementTab, StoredSession } from "./settings/settings";
import type { CodexNotification, CodexSkill, CodexStatusSnapshot, UserInput } from "./types/app-server";
import type { CodexView } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import { EchoInkConnectionService, type HermesConnectionTestResult } from "./plugin/connection-service";
import { EchoInkSettingsStore, type InterruptedRunRecoveryOptions, type SettingsSaveOptions } from "./plugin/settings-store";
import { EchoInkViewService } from "./plugin/view-service";
import { EchoInkHarnessService, type CommitChatSurfaceTerminalOptions } from "./plugin/harness-service";
import type { NativeStartupReconciliationOptions, NativeStartupReconciliationResult } from "./plugin/native-startup-reconciliation";
import { ensureEchoInkSessionContextIdentity, rotateEchoInkSessionContext, type EchoInkSessionContextRotationOptions, type EchoInkSessionContextRotationResult, type EchoInkSessionContextWorkspace } from "./plugin/session-context-lifecycle";
import { commitEchoInkConversationRecordMutation, previewEchoInkConversationRecordMutation, type ConversationRecordMutationDisposition, type ConversationRecordMutationPreview, type ConversationRecordMutationReceipt } from "./plugin/conversation-record-mutation-lifecycle";
import type { MemoryStoreStatus, CodexMemoryImportResult, CodexMemoryMigrationPreview, InitializeEchoInkMemoryResult } from "./harness/memory/file-memory";
import type { MemorySyncResult } from "./harness/memory/v2-engine";
export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  codex: CodexService | null = null;
  lastStatus: CodexStatusSnapshot | null = null;
  agentSetupTarget: AgentBackendMode | null = null;
  agentSetupAutoRepair = false;
  readonly agentRuntimeHealth = new AgentRuntimeHealthStore();
  private editorActions: EditorActionController | null = null;
  private knowledgeBase: KnowledgeBaseManager | null = null;
  private review: ReviewManager | null = null;
  private connectionService: EchoInkConnectionService | null = null;
  private settingsStore: EchoInkSettingsStore | null = null;
  private viewService: EchoInkViewService | null = null;
  private harnessService: EchoInkHarnessService | null = null;
  async onload(): Promise<void> {
    await this.loadSettings();
    const controllers = registerEchoInkPluginFeatures(this);
    this.editorActions = controllers.editorActions;
    this.knowledgeBase = controllers.knowledgeBase;
    this.review = controllers.review;
    registerEchoInkStartupTasks(this);
  }

  onunload(): void {
    void this.performUnload();
  }

  private async performUnload(): Promise<void> {
    this.editorActions?.cancelActiveCandidate("canceled", false);
    await this.knowledgeBase?.unload();
    this.review?.unload();
    const migrationRequired =
      this.getSettingsStore().isConversationStoreV2MigrationRequired();
    await this.saveSettings(
      true,
      migrationRequired
        ? {
          flushConversationStore: false,
          flushKnowledgeBaseHistory: false
        }
        : {}
    );
    await closeMcpBrokerConnectionPool();
    await this.codex?.disconnect();
  }

  async activateHomeAndSidebar(): Promise<void> { return this.getViewService().activateHomeAndSidebar(); }
  async activateHomeView(options: { keepRightSidebar?: boolean } = {}): Promise<void> { return this.getViewService().activateHomeView(options); }
  async activateView(): Promise<void> { return this.getViewService().activateView(); }
  async activateKnowledgeBaseChannel(): Promise<void> { return this.getViewService().activateKnowledgeBaseChannel(); }
  applyComposerDefaultsToView(): void { this.getViewService().applyComposerDefaultsToView(); }
  getCodexView(): CodexView | null { return this.getViewService().getCodexView(); }
  refreshKnowledgeBaseSurfaces(): void { this.getViewService().refreshKnowledgeBaseSurfaces(); }
  async openWorkspaceResourceSettings(tab: ResourceManagementTab = "plugins"): Promise<void> { return this.getViewService().openWorkspaceResourceSettings(tab); }
  async openCodexSetup(options: { autoRepair?: boolean } = {}): Promise<void> { return this.getViewService().openCodexSetup(options); }
  async openAgentSetup(options: { backend: AgentBackendMode; autoRepair?: boolean }): Promise<void> { return this.getViewService().openAgentSetup(options); }
  async openReviewHtmlPreview(relativePath: string): Promise<void> { return this.getViewService().openReviewHtmlPreview(relativePath); }
  async ensureCodexConnected(force = false, options: { silent?: boolean; refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> {
    return this.getConnectionService().ensureCodexConnected(force, options);
  }
  async ensureHarnessBackendConnected(backend: AgentBackendKind, options: { silent?: boolean; refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot | null> {
    if (backend !== "codex-cli") return null;
    const status = await this.ensureCodexConnected(false, options);
    if (!status.connected) throw new Error(status.errors[0] || "Codex 未连接");
    return status;
  }
  async ensureSkillsLoaded(force = false): Promise<CodexSkill[]> { return this.getConnectionService().ensureSkillsLoaded(force); }
  async ensureEchoInkSkillResourcesLoaded(force = false): Promise<EchoInkResource[]> { return this.getConnectionService().ensureEchoInkSkillResourcesLoaded(force); }
  async reconnectCodex(options: { refreshLogin?: boolean } = {}): Promise<CodexStatusSnapshot> { return this.getConnectionService().reconnectCodex(options); }
  async listEchoInkMcpTools(resourceId: string, timeoutMs = 30000): Promise<unknown[]> { return this.getConnectionService().listEchoInkMcpTools(resourceId, timeoutMs); }
  async callEchoInkMcpTool(input: CallEchoInkMcpToolInput): Promise<unknown> { return this.getConnectionService().callEchoInkMcpTool(input); }
  async testHermesConnection(options: { notify?: boolean; signal?: AbortSignal } = {}): Promise<HermesConnectionTestResult> {
    return this.getConnectionService().testHermesConnection(options);
  }
  async runHarnessWithAdapter(input: HarnessRunWithAdapterInput) { return await this.getHarnessService().runWithAdapter(input); }
  async settleHarnessRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<HarnessEvent> {
    return await this.getHarnessService().settleRunTerminal(input, sink);
  }
  async commitChatSurfaceTerminal(
    input: SettleRunTerminalInput,
    options?: CommitChatSurfaceTerminalOptions
  ): Promise<void> {
    await this.getHarnessService().commitChatSurfaceTerminal(input, options);
  }
  async appendHarnessRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink) { return await this.getHarnessService().appendRunEvent(input, sink); }
  async cancelHarnessRun(runId: string): Promise<void> { return await this.getHarnessService().cancelRun(runId); }
  isEchoInkConversationStoreV2MigrationRequired(): boolean { return this.getSettingsStore().isConversationStoreV2MigrationRequired(); }
  async migrateEchoInkConversationStoreToV2() {
    const settingsStore = this.getSettingsStore();
    const harnessService = this.getHarnessService();
    const nativeStoreMigration =
      await harnessService.migrateNativeExecutionStoreSchemaToV2();
    const conversationStoreActivation =
      await harnessService.migrateConversationStoreToV2({
        withMigrationPersistenceQuietWindow: async <T>(
          quietWindowId: string,
          action: () => Promise<T>
        ): Promise<T> =>
          await settingsStore.withMigrationPersistenceQuietWindow(
            quietWindowId,
            action
          )
      });
    if (
      conversationStoreActivation.status === "activated"
      || conversationStoreActivation.status === "already-active"
    ) {
      await settingsStore.markConversationStoreV2MigrationComplete();
    }
    return {
      nativeStoreMigration,
      conversationStoreActivation
    };
  }
  async getEchoInkMemoryStatus(): Promise<MemoryStoreStatus> { return await this.getHarnessService().getMemoryStatus(); }
  async initializeEchoInkMemory(): Promise<InitializeEchoInkMemoryResult> { return await this.getHarnessService().initializeMemory(); }
  async syncEchoInkMemoryNow(): Promise<MemorySyncResult> { return await this.getHarnessService().syncMemoryNow(); }
  async recoverEchoInkMemory(): Promise<unknown> { return await this.getHarnessService().recoverMemory(); }
  async previewCodexMemoryMigration(): Promise<CodexMemoryMigrationPreview> { return await this.getHarnessService().previewCodexMemoryMigration(); }
  async importCodexMemory(): Promise<CodexMemoryImportResult> { return await this.getHarnessService().importCodexMemory(); }
  async resolveEchoInkMemoryConfirmation(id: string, decision: "accept" | "dismiss"): Promise<boolean> { return await this.getHarnessService().resolveMemoryConfirmation(id, decision); }
  async dismissEchoInkMemoryTransaction(id: string, reason: string): Promise<boolean> { return await this.getHarnessService().dismissMemoryTransaction(id, reason); }
  async retryEchoInkMemoryTransaction(id: string): Promise<MemorySyncResult> { return await this.getHarnessService().retryMemoryTransaction(id); }
  async deleteEchoInkMemory(id: string, reason: string): Promise<boolean> { return await this.getHarnessService().deleteMemory(id, reason); }
  async recoverInterruptedHarnessRuns(sessionId?: string, options?: InterruptedRunRecoveryOptions): Promise<number> { return await this.getSettingsStore().recoverInterruptedHarnessRuns(sessionId, options); }
  getNativeExecutionRefContext(backendId?: AgentBackendKind) { return this.getHarnessService().getNativeExecutionRefContext(backendId); }
  async recordNativeExecution(record: NativeExecutionRecord): Promise<void> { return await this.getHarnessService().recordNativeExecution(record); }
  async settleNativeExecution(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> { return await this.getHarnessService().settleNativeExecution(input); }
  async cleanupDueNativeExecutions(limit = 20): Promise<NativeCleanupResult[]> { return await this.getHarnessService().cleanupDueNativeExecutions(limit); }
  async cleanupNativeExecutionRecord(recordId: string): Promise<NativeCleanupResult> { return await this.getHarnessService().cleanupNativeExecutionRecord(recordId); }
  async reconcileNativeExecutionsAtStartup(options: NativeStartupReconciliationOptions = {}): Promise<NativeStartupReconciliationResult> { const settingsStore = this.getSettingsStore(); return await this.getHarnessService().reconcileNativeExecutionStartup(async (probe) => await settingsStore.proveConversationSessionContextAuthority(probe), options, { recoverPendingRecordMutations: async () => await settingsStore.reconcileSessionContextRecordMutationsAtStartup(), recoverStartedRawGcQuarantines: async () => await settingsStore.recoverStartedRawGcQuarantines(), readRecordMutationAuthority: async (mutationId) => await settingsStore.readRecordMutationAuthority(mutationId) }); }
  registerEchoInkPristineConversationSession(session: StoredSession): void { this.getSettingsStore().registerPristineConversationSession(session); }
  async ensureEchoInkConversationSessionCreated(session: StoredSession): Promise<void> { return await this.getSettingsStore().ensureConversationSessionCreated(session); }
  async ensureEchoInkSessionContextIdentity(session: StoredSession, workspace: EchoInkSessionContextWorkspace): Promise<EchoInkSessionContextRotationResult | null> { return await ensureEchoInkSessionContextIdentity(this.getHarnessService(), this.getSettingsStore(), session, workspace); }
  async rotateEchoInkSessionContext(session: StoredSession, options: EchoInkSessionContextRotationOptions): Promise<EchoInkSessionContextRotationResult> { return await rotateEchoInkSessionContext(this.getHarnessService(), this.getSettingsStore(), session, options); }
  async enforceNativeSessionLeaseLimits(): Promise<NativeSessionLeaseCleanupExecutionResult[]> { return await this.getHarnessService().enforceNativeSessionLeaseLimits(); }
  async previewEchoInkSessionDeletion(session: StoredSession): Promise<ConversationRecordMutationPreview> { return await previewEchoInkConversationRecordMutation(this, session, "delete-conversation"); }
  async previewEchoInkConversationRecordClear(session: StoredSession): Promise<ConversationRecordMutationPreview> { return await previewEchoInkConversationRecordMutation(this, session, "clear-conversation-records"); }
  async commitEchoInkSessionDeletion(session: StoredSession, disposition: ConversationRecordMutationDisposition): Promise<ConversationRecordMutationReceipt> { return await commitEchoInkConversationRecordMutation({ plugin: this, settingsStore: this.getSettingsStore(), harnessService: this.getHarnessService(), session, operation: "delete-conversation", disposition }); }
  async clearEchoInkConversationRecords(session: StoredSession, disposition: ConversationRecordMutationDisposition): Promise<ConversationRecordMutationReceipt> { return await commitEchoInkConversationRecordMutation({ plugin: this, settingsStore: this.getSettingsStore(), harnessService: this.getHarnessService(), session, operation: "clear-conversation-records", disposition }); }
  async previewRawGcQuarantine() { return await this.getSettingsStore().previewRawGcQuarantine(); } async beginRawGcQuarantine(input: { transactionId: string; expectedPreviewDigest: string; selectedSubjectRefs: readonly string[]; confirmedAt: number }) { return await this.getSettingsStore().beginRawGcQuarantine(input); } async authorizeAndPurgeRawGcQuarantine(transactionId: string) { return await this.getSettingsStore().authorizeAndPurgeRawGcQuarantine(transactionId); }
  async snapshotPendingNativeExecutionRecordIdsForRecovery(input: { surface?: string; sessionId?: string }): Promise<string[]> { return await this.getHarnessService().snapshotPendingNativeExecutionRecordIdsForRecovery(input); }
  async failPendingNativeExecutionsForRecovery(input: { reason: string; surface?: string; sessionId?: string; recordIds?: readonly string[] }): Promise<number> { return await this.getHarnessService().failPendingNativeExecutionsForRecovery(input); }
  createCodexRichAgentAdapter(options: Omit<CodexRichAgentAdapterOptions, "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "archiveThread"> & Partial<Pick<CodexRichAgentAdapterOptions, "startThread" | "resumeThread" | "startTurn" | "interruptTurn" | "archiveThread">>) { return this.getHarnessService().createCodexRichAgentAdapter(options); }
  hasCodexHarnessTransport(): boolean { return Boolean(this.codex); }
  async startCodexHarnessThread(options?: TurnOptions) { return await this.getHarnessService().startCodexThread(options); }
  async resumeCodexHarnessThread(threadId: string, options?: TurnOptions): Promise<void> { return await this.getHarnessService().resumeCodexThread(threadId, options); }
  async startCodexHarnessTurn(threadId: string, input: UserInput[], options?: TurnOptions): Promise<string> { return await this.getHarnessService().startCodexTurn(threadId, input, options); }
  async setCodexHarnessThreadName(threadId: string, name: string): Promise<void> { await this.codex?.setThreadName?.(threadId, name); }
  async interruptCodexHarnessTurn(threadId: string, turnId: string): Promise<void> { return await this.getHarnessService().interruptCodexTurn(threadId, turnId); }
  canArchiveCodexHarnessThread(): boolean { return typeof this.codex?.archiveThread === "function"; }
  async archiveCodexHarnessThread(threadId: string): Promise<void> { return await this.getHarnessService().archiveCodexThread(threadId); }
  async refreshCodexHarnessMcpStatus() { if (!this.codex) throw new Error("Codex 未连接"); return await this.codex.refreshMcpStatus(); }
  async startCodexHarnessMcpOAuth(serverName: string) { return await this.codex?.startMcpOAuth(serverName) ?? null; }
  async buildRuntimeEchoInkResourceCatalog(): Promise<EchoInkResource[]> { return await this.getHarnessService().buildRuntimeEchoInkResourceCatalog(); }
  getVaultPath(): string { const adapter = this.app.vault.adapter as { basePath?: string; path?: string }; return adapter.basePath || adapter.path || ""; }
  getPluginDataDirName(): string { const dir = (this.manifest as { dir?: unknown }).dir; return typeof dir === "string" && dir.trim() ? dir : this.manifest.id; }
  async loadSettings(): Promise<void> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> { return this.getSettingsStore().saveSettings(force, options); }
  getKnowledgeBaseWorkflowSettingsHost(): MaintenanceWorkflowSettingsHost<KnowledgeBaseSettings> { return this.getSettingsStore(); }
  getKnowledgeBaseWorkflowStorageRoot(vaultPath = this.getVaultPath()): string { return maintenanceWorkflowStorageRootForVault(vaultPath); }
  async commitKnowledgeRunDurably(): Promise<LocalRunCommitResult> { return await this.getSettingsStore().commitKnowledgeRunDurably(); }
  async readEchoInkConversationSession(sessionId: string): Promise<StoredSession | null> { return await this.getSettingsStore().readConversationSession(sessionId); }
  async proveEchoInkConversationMessageAuthority(probe: ConversationMessageAuthorityProbe): Promise<ConversationMessageAuthorityProof> { return await this.getSettingsStore().proveConversationMessageAuthority(probe); }
  async withEchoInkConversationMutation<R>(conversationId: string, action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withConversationMutation(conversationId, action); }
  async withEchoInkSettingsPersistenceAuthorityGate<R>(action: () => Promise<R>): Promise<R> { return await this.getSettingsStore().withSettingsPersistenceAuthorityGate(action); }
  poisonEchoInkSettingsPersistenceForRecovery(message: string): void { this.getSettingsStore().poisonSettingsPersistenceForRecovery(message); }
  async externalizeMessageText(message: ChatMessage, fullText: string): Promise<void> { return this.getSettingsStore().externalizeMessageText(message, fullText); }
  async readRawMessageText(rawRef: string): Promise<string> { return this.getSettingsStore().readRawMessageText(rawRef); }
  async readKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> { return this.getSettingsStore().readKnowledgeBaseHistoryIndex(); }
  async readKnowledgeBaseHistoryDay(sessionId: string, date: string): Promise<ChatMessage[]> { return this.getSettingsStore().readKnowledgeBaseHistoryDay(sessionId, date); }
  async rebuildKnowledgeBaseHistoryIndex(): Promise<KnowledgeBaseHistoryIndex> { return this.getSettingsStore().rebuildKnowledgeBaseHistoryIndex(); }
  async getKnowledgeBaseStorageStats(): Promise<KnowledgeBaseStorageStats> { return this.getSettingsStore().getKnowledgeBaseStorageStats(); }
  async exportKnowledgeBaseHistory(): Promise<string> { return this.getSettingsStore().exportKnowledgeBaseHistory(); }
  async compactOldKnowledgeBaseProcessHistory(): Promise<number> { return this.getSettingsStore().compactOldKnowledgeBaseProcessHistory(); }
  async removeKnowledgeBaseHistory(): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().removeKnowledgeBaseHistory(); }
  async removeKnowledgeBaseHistoryDays(dates: string[]): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().removeKnowledgeBaseHistoryDays(dates); }
  async pruneKnowledgeBaseHistoryByRetention(): Promise<KnowledgeBaseHistoryRemovalResult> { return this.getSettingsStore().pruneKnowledgeBaseHistoryByRetention(); }
  async runDeferredStartupMaintenance(): Promise<void> { return this.getSettingsStore().runDeferredStartupMaintenance(); }
  async archivePendingKnowledgeBaseThreads(): Promise<number> {
    return this.knowledgeBase ? this.knowledgeBase.settlePendingKnowledgeBaseNativeExecutions() : 0;
  }
  async settlePendingKnowledgeBaseNativeExecutions(runIds?: readonly string[]): Promise<number> { return this.knowledgeBase ? this.knowledgeBase.settlePendingKnowledgeBaseNativeExecutions(runIds) : 0; }
  getKnowledgeBaseManager(): KnowledgeBaseManager | null { return this.knowledgeBase; } getReviewManager(): ReviewManager | null { return this.review; }
  getEditorActions(): EditorActionController | null { return this.editorActions; }
  private handleCodexNotification(notification: CodexNotification): void {
    if (notification.method === "error") this.agentRuntimeHealth.reportFailure("codex-cli", notification.params, { source: "codex-notification" });
    if (this.getHarnessService().handleCodexNotification(notification)) return;
    this.getCodexView()?.handleCodexNotification(notification);
  }
  private getConnectionService(): EchoInkConnectionService {
    if (!this.connectionService) this.connectionService = new EchoInkConnectionService(this, (notification) => this.handleCodexNotification(notification));
    return this.connectionService;
  }
  private getSettingsStore(): EchoInkSettingsStore {
    if (!this.settingsStore) this.settingsStore = new EchoInkSettingsStore(this);
    return this.settingsStore;
  }
  private getViewService(): EchoInkViewService {
    if (!this.viewService) this.viewService = new EchoInkViewService(this);
    return this.viewService;
  }
  private getHarnessService(): EchoInkHarnessService {
    if (!this.harnessService) this.harnessService = new EchoInkHarnessService(this);
    return this.harnessService;
  }
}
