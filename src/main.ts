import { Plugin } from "obsidian";
import type { CodexService, TurnOptions } from "./core/codex-service";
import type { AgentBackendKind } from "./agent/types";
import type { CodexRichAgentAdapterOptions } from "./harness/agents/adapters/codex-rich-adapter";
import type { HarnessEventSink } from "./harness/contracts/event";
import type { LocalRunCommitResult, NativeExecutionRecord } from "./harness/contracts/native-execution";
import type { HarnessRunWithAdapterInput } from "./harness/kernel/harness-kernel";
import type { AppendRunEventInput, SettleRunTerminalInput } from "./harness/kernel/run-orchestrator";
import type { NativeCleanupResult, SettleNativeExecutionInput } from "./harness/native/native-execution-manager";
import type { NativeSessionLeaseCleanupExecutionResult } from "./harness/kernel/native-session-lease-manager";
import { closeMcpBrokerConnectionPool } from "./resources/mcp-broker";
import type { CallEchoInkMcpToolInput } from "./resources/mcp-broker-service";
import type { EchoInkResource } from "./resources/types";
import type { EditorActionController } from "./editor-actions/controller";
import type { KnowledgeBaseManager } from "./knowledge-base/manager";
import type {
  KnowledgeBaseHistoryIndex,
  KnowledgeBaseHistoryRemovalResult,
  KnowledgeBaseStorageStats
} from "./knowledge-base/history-store";
import type { ReviewManager } from "./review/manager";
import type { ChatMessage, CodexForObsidianSettings, ResourceManagementTab, StoredSession } from "./settings/settings";
import type { CodexNotification, CodexSkill, CodexStatusSnapshot, UserInput } from "./types/app-server";
import type { CodexView } from "./ui/codex-view";
import { registerEchoInkPluginFeatures, registerEchoInkStartupTasks } from "./plugin/bootstrap";
import { EchoInkConnectionService } from "./plugin/connection-service";
import { EchoInkSettingsStore, type SettingsSaveOptions } from "./plugin/settings-store";
import { EchoInkViewService } from "./plugin/view-service";
import { EchoInkHarnessService } from "./plugin/harness-service";

export interface HermesConnectionTestResult {
  connected: boolean;
  providerConfigured: boolean;
  message: string;
  version: string;
}

export default class CodexForObsidianPlugin extends Plugin {
  settings!: CodexForObsidianSettings;
  codex: CodexService | null = null;
  lastStatus: CodexStatusSnapshot | null = null;
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

  async onunload(): Promise<void> {
    this.editorActions?.cancelActiveCandidate("canceled", false);
    await this.knowledgeBase?.unload();
    this.review?.unload();
    await this.saveSettings(true);
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
  async testHermesConnection(options: { notify?: boolean } = {}): Promise<HermesConnectionTestResult> { return this.getConnectionService().testHermesConnection(options); }

  async runHarnessWithAdapter(input: HarnessRunWithAdapterInput) { return await this.getHarnessService().runWithAdapter(input); }
  async settleHarnessRunTerminal(input: SettleRunTerminalInput, sink?: HarnessEventSink): Promise<void> { return await this.getHarnessService().settleRunTerminal(input, sink); }
  async appendHarnessRunEvent(input: AppendRunEventInput, sink?: HarnessEventSink) { return await this.getHarnessService().appendRunEvent(input, sink); }
  async cancelHarnessRun(runId: string): Promise<void> { return await this.getHarnessService().cancelRun(runId); }
  async recoverInterruptedHarnessRuns(sessionId?: string): Promise<number> { return await this.getSettingsStore().recoverInterruptedHarnessRuns(sessionId); }
  getNativeExecutionRefContext(backendId?: AgentBackendKind) { return this.getHarnessService().getNativeExecutionRefContext(backendId); }
  async recordNativeExecution(record: NativeExecutionRecord): Promise<void> { return await this.getHarnessService().recordNativeExecution(record); }
  async settleNativeExecution(input: SettleNativeExecutionInput): Promise<NativeExecutionRecord | null> { return await this.getHarnessService().settleNativeExecution(input); }
  async cleanupDueNativeExecutions(limit = 20): Promise<NativeCleanupResult[]> { return await this.getHarnessService().cleanupDueNativeExecutions(limit); }
  async enforceNativeSessionLeaseLimits(): Promise<NativeSessionLeaseCleanupExecutionResult[]> { return await this.getHarnessService().enforceNativeSessionLeaseLimits(); }
  async commitEchoInkSessionDeletion(session: StoredSession): Promise<NativeCleanupResult[]> { return await this.getHarnessService().commitEchoInkSessionDeletion(session); }
  async resetEchoInkSessionNativeCache(session: StoredSession): Promise<NativeCleanupResult[]> { return await this.getHarnessService().resetEchoInkSessionNativeCache(session); }
  async failPendingNativeExecutionsForRecovery(input: { reason: string; surface?: string; sessionId?: string }): Promise<number> { return await this.getHarnessService().failPendingNativeExecutionsForRecovery(input); }
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

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string; path?: string };
    return adapter.basePath || adapter.path || "";
  }

  getPluginDataDirName(): string {
    const dir = (this.manifest as { dir?: unknown }).dir;
    return typeof dir === "string" && dir.trim() ? dir : this.manifest.id;
  }

  async loadSettings(): Promise<void> { return this.getSettingsStore().loadSettings(); }
  async saveSettings(force = false, options: SettingsSaveOptions = {}): Promise<void> { return this.getSettingsStore().saveSettings(force, options); }
  async commitKnowledgeRunDurably(): Promise<LocalRunCommitResult> { return await this.getSettingsStore().commitKnowledgeRunDurably(); }
  async deleteStoredConversationSession(sessionId: string): Promise<boolean> { return await this.getSettingsStore().deleteConversationSession(sessionId); }
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
  async settlePendingKnowledgeBaseNativeExecutions(): Promise<number> { return this.knowledgeBase ? this.knowledgeBase.settlePendingKnowledgeBaseNativeExecutions() : 0; }
  getKnowledgeBaseManager(): KnowledgeBaseManager | null { return this.knowledgeBase; }
  getReviewManager(): ReviewManager | null { return this.review; }
  getEditorActions(): EditorActionController | null { return this.editorActions; }

  private handleCodexNotification(notification: CodexNotification): void {
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
