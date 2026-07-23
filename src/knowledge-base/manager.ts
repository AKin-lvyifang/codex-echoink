import { createHash } from "node:crypto";
import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getAgentBackendDefinition } from "../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind } from "../agent/types";
import { harnessKnowledgePromptUsesPreparedResources, harnessKnowledgeTaskPermission, harnessKnowledgeUsesEchoInkToolBridge, harnessMessageModelId } from "../harness/agents/backend-runtime-profile";
import { buildCallableMcpToolCatalog } from "../resources/mcp-tool-catalog";
import {
  buildActiveEchoInkResourceCatalog,
  MAINTENANCE_AGENT_RESOURCE_PROFILE,
  prepareAgentResources
} from "../resources/registry";
import type { EchoInkResource } from "../resources/types";
import {
  recordKnowledgeBaseMaintenanceRun,
  type ChatMessage,
  type KnowledgeBaseMaintenanceHistoryEntry,
  type KnowledgeBaseMaintenanceMode,
  type KnowledgeBaseManagedThreadKind,
  type KnowledgeBaseSettings,
  type ReviewReportKind,
  type StoredAttachment,
  type StoredSession
} from "../settings/settings";
import type { PermissionMode } from "../types/app-server";
import {
  handleKnowledgeBaseUserMessage,
  type KnowledgeBaseCancellationResult,
  type KnowledgeBaseChatResult,
  type KnowledgeBaseTurnOptionOverrides
} from "./command-router";
import {
  buildKnowledgeBaseMaintainReportPayload,
  buildKnowledgeBaseRunPayload,
  knowledgeBaseRunModeForCommandIntent
} from "./maintain-report-card";
import {
  buildPromptWithPreparedResources,
  type KnowledgeAgentTaskOutput
} from "./agent-runner";
import { DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "./constants";
import { KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { durableMaintenanceResultFromHistory } from "./maintenance-terminal";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { KnowledgeBaseScheduler } from "./scheduler";
import {
  settleScheduledMaintenanceLifecycle
} from "./scheduled-maintenance";
import {
  appendKnowledgeBaseWarning,
  saveSettingsSafely,
} from "./maintenance";
import type {
  KnowledgeBaseCommandUiMode,
  KnowledgeBaseRunMode,
  KnowledgeBaseRunResult,
  KnowledgeBaseRunWarning,
  KnowledgeBaseSource,
  KnowledgeRunAttemptRecord
} from "./types";
import { KnowledgeBaseCaptureService } from "./capture";
import { KnowledgeBaseQueryJournalService } from "./query-journal";
import { KnowledgeBaseMaintenanceRunner } from "./maintenance-runner";
import { KnowledgeBaseAgentTaskService } from "./agent-task-service";
import { KnowledgeBaseRawDigestCalibrationRunner } from "./raw-digest-calibration-runner";
import { exists } from "./utils";
import { loadKnowledgeBaseRulesContext } from "./rules-context";
import { resolveKnowledgeBaseRulesFilePath } from "./rules-repair";
import { recoverPendingMaintenanceWorkflows } from "./maintenance-workflow";
import {
  listActiveMaintenanceRunJournals,
  removeActiveMaintenanceRunJournal,
  type LoadedActiveMaintenanceRunJournal
} from "../harness/maintenance/active-run-journal";
import { parseKnowledgeBaseCommand, requiresMaintenanceAuthority } from "./commands";
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5000;
export type MaintenanceRecoveryState = "pending" | "ready" | "blocked";
type MaintenanceRecoveryKind = "startup" | "in-process";

export interface MaintenanceRecoveryStatus {
  state: MaintenanceRecoveryState;
  message: string;
}

type KnowledgeBaseRunCancellationPhase =
  | "idle"
  | "cancelable"
  | "commit-locked";

const MAINTENANCE_RECOVERY_PENDING_MESSAGE =
  "正在恢复上次知识库维护；尚未启动新的写入 Agent。普通对话、/ask、/history、/clear 和 /help 仍可使用。";
const MAINTENANCE_COMMIT_LOCKED_MESSAGE =
  "知识库维护已进入安全提交，不能取消。";

function snapshotKnowledgeBaseTurnOptionOverrides(
  input?: KnowledgeBaseTurnOptionOverrides
): KnowledgeBaseTurnOptionOverrides | undefined {
  if (!input) return undefined;
  return {
    ...input,
    ...(input.workspaceResources
      ? {
        workspaceResources: {
          plugins: { ...input.workspaceResources.plugins },
          mcpServers: { ...input.workspaceResources.mcpServers },
          skills: { ...input.workspaceResources.skills }
        }
      }
      : {}),
    ...(input.harnessSession
      ? { harnessSession: structuredClone(input.harnessSession) }
      : {})
  };
}

export class KnowledgeBaseManager {
  private running = false;
  private readonly scheduler: KnowledgeBaseScheduler;
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly queryJournalService: KnowledgeBaseQueryJournalService;
  private readonly maintenanceRunner: KnowledgeBaseMaintenanceRunner;
  private readonly agentTaskService: KnowledgeBaseAgentTaskService;
  private readonly rawDigestCalibrationRunner: KnowledgeBaseRawDigestCalibrationRunner;
  private cancelRequested = false;
  private cancellationPhase: KnowledgeBaseRunCancellationPhase = "idle";
  private maintenanceRecoveryGate: Promise<void> | null = null;
  private maintenanceRecoveryState: MaintenanceRecoveryState = "pending";
  private maintenanceRecoveryError = "";
  private maintenanceRecoveryKind: MaintenanceRecoveryKind = "startup";
  private maintenanceRecoveryNativeRunIds: string[] = [];
  private maintenanceStartupNativeRecordIds: Promise<string[]> | null = null;
  private maintenanceRecoveryGeneration = 0;
  private maintenanceManagerDisposed = false;
  private maintenanceWriteLeaseCount = 0;
  private readonly maintenanceWriteDrainWaiters = new Set<() => void>();
  private dashboardSnapshotCache: { snapshot: KnowledgeBaseDashboardSnapshot; savedAt: number; signature: string } | null = null;
  private dashboardSnapshotPromise: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.agentTaskService = new KnowledgeBaseAgentTaskService(plugin, {
      isCancelRequested: () => this.cancelRequested
    });
    this.rawDigestCalibrationRunner = new KnowledgeBaseRawDigestCalibrationRunner(plugin, {
      isRunning: () => this.running,
      beginRun: () => this.beginKnowledgeBaseRun(),
      finishRun: (refreshSurfaces) => this.finishRawDigestCalibrationRun(refreshSurfaces),
      isCancelRequested: () => this.cancelRequested
    });
    this.captureService = new KnowledgeBaseCaptureService(plugin);
    this.queryJournalService = new KnowledgeBaseQueryJournalService(plugin, this.captureService, {
      isRunning: () => this.running,
      beginRun: () => this.beginKnowledgeBaseRun(),
      finishRun: () => this.finishKnowledgeBaseRun(),
      resolveRulesFile: () => this.resolveRulesFile(),
      resolveKnowledgeBackend: () => this.resolveKnowledgeBackend(),
      collectNativeJournalHistory: (backend, window) => this.agentTaskService.collectNativeJournalHistory(backend, window),
      runKnowledgeAgentTask: (input) => this.runKnowledgeAgentTask(input)
    });
    this.maintenanceRunner = new KnowledgeBaseMaintenanceRunner(plugin, {
      isRunning: () => this.running,
      beginRun: () => this.beginKnowledgeBaseRun(),
      finishRun: () => this.finishKnowledgeBaseRun(),
      isCancelRequested: () => this.cancelRequested,
      tryEnterCommitPhase: () => this.tryEnterMaintenanceCommitPhase(),
      isCommitPhaseLocked: () => this.isMaintenanceCommitPhaseLocked(),
      resolveRulesFile: () => this.resolveRulesFile(),
      isMaintenanceBackendReady: (backend, sources) => this.agentTaskService.isMaintenanceBackendReady(backend, sources),
      runKnowledgeAgentTask: (input) => this.runKnowledgeAgentTask(input)
    });
    this.scheduler = new KnowledgeBaseScheduler({
      getSettings: () => this.plugin.settings.knowledgeBase,
      isRunning: () => this.running || this.maintenanceRecoveryState !== "ready",
      registerInterval: (intervalId) => this.plugin.registerInterval(intervalId),
      waitUntilMaintenanceReady: () => this.waitUntilMaintenanceReady(),
      persistSettings: async () => await this.plugin.saveSettings(true),
      runMaintenance: ({ workflowRunId, scheduledStartedAt }) =>
        this.runMaintenance("maintain", "", {
          workflowRunId,
          scheduledStartedAt
        }),
      settleScheduledMaintenance: (result) => this.settleScheduledMaintenance(result),
      refreshKnowledgeBaseSurfaces: () => this.refreshKnowledgeBaseSurfaces()
    });
  }

  register(): void {
    if (!this.plugin.isEchoInkConversationStoreV2MigrationRequired()) {
      void this.startMaintenanceRecovery().catch((error) => {
        console.error("EchoInk knowledge recovery blocked", error);
      });
    }
    this.plugin.addCommand({
      id: "knowledge-base-initialize",
      name: "知识库：初始化 LLM Wiki",
      callback: async () => {
        await this.plugin.activateKnowledgeBaseChannel();
        this.plugin.getCodexView()?.fillKnowledgeBaseCommand("/init ");
      }
    });
    this.plugin.addCommand({
      id: "knowledge-base-maintain-now",
      name: "知识库：立即维护",
      callback: () => void this.runMaintenance("maintain")
    });
    this.plugin.addCommand({
      id: "knowledge-base-calibrate-raw-digest",
      name: "知识库：校准 raw 提炼状态",
      callback: () => void this.calibrateRawDigestStatus()
    });
    this.plugin.addCommand({
      id: "knowledge-base-lint-now",
      name: "知识库：只体检",
      callback: () => void this.runMaintenance("lint")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-idea",
      name: "知识库：记录想法到 inbox",
      callback: () => void this.captureText("inbox").catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error));
      })
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-link",
      name: "知识库：收集链接到 raw",
      callback: () => void this.captureText("raw-articles").catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error));
      })
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-active-attachment",
      name: "知识库：收集当前图片或 PDF",
      callback: () => void this.captureActiveAttachment().catch((error) => {
        new Notice(error instanceof Error ? error.message : String(error));
      })
    });
    this.plugin.addCommand({
      id: "knowledge-base-cancel",
      name: "知识库：取消当前任务",
      callback: () => void this.cancelMaintenance()
    });
    this.plugin.addRibbonIcon("library", "知识库管理", () => void this.plugin.activateKnowledgeBaseChannel());
    if (!this.plugin.isEchoInkConversationStoreV2MigrationRequired()) {
      this.plugin.app.workspace.onLayoutReady(() => {
        void this.waitUntilMaintenanceReady()
          .then(() => this.scheduler.start())
          .catch((error) => {
            console.error("EchoInk scheduled knowledge recovery blocked", error);
          });
      });
    }
  }

  async unload(): Promise<void> {
    this.maintenanceManagerDisposed = true;
    this.scheduler.unload();
    await this.maintenanceRecoveryGate?.catch(() => undefined);
    await this.agentTaskService.unload();
    await this.waitForMaintenanceWriteAuthorityDrain();
    this.cancelRequested = false;
  }

  get isRunning(): boolean {
    return this.running || this.agentTaskService.hasActiveTask;
  }

  get maintenanceRecoveryStatus(): MaintenanceRecoveryStatus {
    if (this.maintenanceRecoveryState === "pending") {
      return {
        state: "pending",
        message: MAINTENANCE_RECOVERY_PENDING_MESSAGE
      };
    }
    if (this.maintenanceRecoveryState === "blocked") {
      return {
        state: "blocked",
        message: maintenanceRecoveryBlockedMessage(this.maintenanceRecoveryError)
      };
    }
    return { state: "ready", message: "" };
  }

  async getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> {
    const signature = dashboardSnapshotSignature(this.plugin.settings.knowledgeBase);
    const now = Date.now();
    if (
      this.dashboardSnapshotCache
      && this.dashboardSnapshotCache.signature === signature
      && now - this.dashboardSnapshotCache.savedAt <= DASHBOARD_SNAPSHOT_CACHE_TTL_MS
    ) {
      return this.dashboardSnapshotCache.snapshot;
    }
    if (this.dashboardSnapshotPromise) return this.dashboardSnapshotPromise;
    this.dashboardSnapshotPromise = buildKnowledgeBaseDashboardSnapshot(this.plugin.getVaultPath(), this.plugin.settings.knowledgeBase)
      .then((snapshot) => {
        this.dashboardSnapshotCache = {
          snapshot,
          savedAt: Date.now(),
          signature
        };
        return snapshot;
      })
      .finally(() => {
        this.dashboardSnapshotPromise = null;
      });
    return this.dashboardSnapshotPromise;
  }

  private refreshKnowledgeBaseSurfaces(): void {
    this.invalidateDashboardSnapshot();
    const plugin = this.plugin as CodexForObsidianPlugin & { refreshKnowledgeBaseSurfaces?: () => void };
    if (typeof plugin.refreshKnowledgeBaseSurfaces === "function") {
      plugin.refreshKnowledgeBaseSurfaces();
      return;
    }
    this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
  }

  private invalidateDashboardSnapshot(): void {
    this.dashboardSnapshotCache = null;
  }

  async cancelMaintenance(): Promise<KnowledgeBaseCancellationResult> {
    if (this.maintenanceRecoveryState === "pending") {
      const message = "知识库维护正在恢复上次任务，暂时不能取消";
      new Notice(message);
      return { accepted: false, message };
    }
    if (this.maintenanceRecoveryState === "blocked") {
      const message =
        `知识库维护恢复被阻断：${this.maintenanceRecoveryError || "请检查维护诊断"}`;
      new Notice(message);
      return { accepted: false, message };
    }
    if (!this.running && !this.agentTaskService.hasActiveTask) {
      const message = "当前没有知识库任务";
      new Notice(message);
      return { accepted: false, message };
    }
    if (this.isMaintenanceCommitPhaseLocked()) {
      new Notice(MAINTENANCE_COMMIT_LOCKED_MESSAGE);
      return {
        accepted: false,
        message: MAINTENANCE_COMMIT_LOCKED_MESSAGE
      };
    }
    this.cancelRequested = true;
    await this.agentTaskService.cancelActiveTasks();
    this.plugin.settings.knowledgeBase.lastRunStatus = "canceled";
    this.plugin.settings.knowledgeBase.lastError = "用户取消";
    const saveError = await saveSettingsSafely(this.plugin);
    if (saveError) {
      this.plugin.settings.knowledgeBase.lastError = `用户取消；状态保存失败：${saveError}`;
      await saveSettingsSafely(this.plugin);
    }
    const message = "已取消知识库任务";
    new Notice(message);
    return { accepted: true, message };
  }

  async handleUserMessage(text: string, attachments: StoredAttachment[] = [], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    const command = parseKnowledgeBaseCommand(text, attachments.length);
    const needsMaintenanceAuthority = requiresMaintenanceAuthority(command);
    if (
      this.maintenanceRecoveryState === "blocked"
      && needsMaintenanceAuthority
    ) {
      await this.retryMaintenanceRecovery().catch(() => undefined);
    }
    if (
      this.maintenanceRecoveryState !== "ready"
      && needsMaintenanceAuthority
    ) {
      const mode = knowledgeBaseRunModeForCommandIntent(command.intent);
      return {
        status: "failed",
        message: this.maintenanceRecoveryStatus.message,
        maintenanceRecoveryState: this.maintenanceRecoveryState,
        ...(mode ? { ui: buildKnowledgeBaseRunPayload(mode) } : {}),
        ...(turnOptionOverrides?.workflowRunId?.trim()
          ? { workflowRunId: turnOptionOverrides.workflowRunId.trim() }
          : {})
      };
    }
    // These commands are normally consumed by the local composer. Keep a
    // Manager-level guard so alternate callers cannot fall through to the
    // router's generic capture branch and accidentally write to inbox.
    if (command.intent === "history") {
      return { status: "success", message: "知识库历史由当前页面的本地历史视图打开。" };
    }
    if (command.intent === "clear") {
      return { status: "success", message: "知识库页面由当前会话在本地清空并开启新上下文。" };
    }
    const execute = async () => await handleKnowledgeBaseUserMessage({
      previewInitialization: () => this.previewInitialization(),
      executeInitialization: (preview) => this.executeInitialization(preview),
      markInitializationFailed: () => this.markInitializationFailed(),
      cancelMaintenance: () => this.cancelMaintenance(),
      calibrateRawDigestStatus: () => this.calibrateRawDigestStatus(),
      runMaintenance: (mode, userRequest, overrides) => this.runMaintenance(mode, userRequest, overrides),
      answerQuestion: (query, overrides) => this.answerQuestion(query, overrides),
      runWeeklyReview: (kind) => this.runWeeklyReview(kind),
      writeDailyJournal: (query, files, overrides) => this.writeDailyJournal(query, files, overrides),
      captureChatInput: (target, query, files) => this.captureChatInput(target, query, files),
      lastReportPath: () => this.plugin.settings.knowledgeBase.lastReportPath || "",
      formatFailureContext: (reportPath) => this.formatFailureContext(reportPath)
    }, text, attachments, turnOptionOverrides);
    return needsMaintenanceAuthority
      ? await this.withMaintenanceWriteAuthority(execute)
      : await execute();
  }

  private async markInitializationFailed(): Promise<void> {
    this.plugin.settings.knowledgeBase.initialization.status = "failed";
    await this.plugin.saveSettings(true);
  }

  async previewInitialization(): Promise<KnowledgeBaseInitializationPreview> {
    const preview = await buildKnowledgeBaseInitializationPreview(this.plugin.getVaultPath());
    const init = this.plugin.settings.knowledgeBase.initialization;
    init.status = "preview-ready";
    init.rulesFilePath = preview.rulesFilePath;
    init.templateVersion = preview.templateVersion;
    init.lastPreviewSummary = preview.summary.slice(0, 2000);
    await this.plugin.saveSettings(true);
    return preview;
  }

  private async runWeeklyReview(kind: ReviewReportKind): Promise<KnowledgeBaseChatResult> {
    const manager = this.plugin.getReviewManager();
    if (!manager) {
      return { status: "failed", message: "复盘管理器未初始化。" };
    }
    const result = await manager.runReview(kind);
    if (result.status !== "success") {
      return {
        status: "failed",
        message: `${reviewKindLabel(kind)}生成失败：${result.error || "未知错误"}`
      };
    }
    return {
      status: "success",
      message: [
        `${reviewKindLabel(kind)}已生成。`,
        `Markdown：${result.markdownPath}`,
        `HTML：${result.htmlPath}`
      ].join("\n")
    };
  }

  async executeInitialization(preview: KnowledgeBaseInitializationPreview): Promise<{ summary: string; rulesFilePath: string }> {
    const result = await executeKnowledgeBaseInitialization(this.plugin.getVaultPath(), preview);
    const settings = this.plugin.settings.knowledgeBase;
    settings.initialization.status = "initialized";
    settings.initialization.initializedAt = Date.now();
    settings.initialization.rulesFilePath = result.rulesFilePath;
    settings.initialization.templateVersion = result.templateVersion;
    settings.initialization.lastPreviewSummary = preview.summary.slice(0, 2000);
    settings.useCustomRulesFile = true;
    settings.rulesFilePath = result.rulesFilePath;
    await this.plugin.saveSettings(true);
    return { summary: result.summary, rulesFilePath: result.rulesFilePath };
  }

  async calibrateRawDigestStatus(): Promise<KnowledgeBaseRunResult> {
    let releaseAuthority: (() => void) | null = null;
    try {
      releaseAuthority = await this.acquireMaintenanceWriteAuthority();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`知识库维护恢复被阻断：${message}`);
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        terminalPhase: "recovery-blocked",
        commitState: "pre-wal",
        error: message,
        failureCode: "maintenance-recovery-blocked"
      };
    }
    try {
      return await this.rawDigestCalibrationRunner.calibrateRawDigestStatus();
    } finally {
      releaseAuthority();
    }
  }

  async runMaintenance(mode: KnowledgeBaseRunMode = "maintain", userRequest = "", turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseRunResult> {
    // Snapshot synchronously, before the first await in the workflow. Changing
    // the selector while a run is active affects only the next maintenance run.
    const selectedBackend = this.plugin.settings.agentBackend;
    const durableWorkflow = mode === "maintain" || mode === "reingest";
    const invocationStartedAt =
      turnOptionOverrides?.scheduledStartedAt ?? Date.now();
    const requestedWorkflowRunId =
      turnOptionOverrides?.workflowRunId?.trim() ?? "";
    const invocationWorkflowRunId =
      requestedWorkflowRunId
      && requestedWorkflowRunId.length <= 512
      && !requestedWorkflowRunId.includes("\0")
        ? requestedWorkflowRunId
        : `knowledge-${mode}-${invocationStartedAt}`;
    const snapshottedTurnOptions =
      snapshotKnowledgeBaseTurnOptionOverrides(turnOptionOverrides);
    const frozenTurnOptions = durableWorkflow
      ? {
        ...snapshottedTurnOptions,
        workflowRunId: invocationWorkflowRunId,
        ...(snapshottedTurnOptions?.scheduledStartedAt !== undefined
          ? { scheduledStartedAt: invocationStartedAt }
          : {})
      }
      : snapshottedTurnOptions;
    let releaseAuthority: (() => void) | null = null;
    try {
      releaseAuthority = await this.acquireMaintenanceWriteAuthority();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`知识库维护恢复被阻断：${message}`);
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        ...(durableWorkflow
          ? {
            workflowRunId: invocationWorkflowRunId,
            selectedBackend,
            winnerBackend: null,
            attempts: []
          }
          : {}),
        terminalPhase: "recovery-blocked",
        commitState: "pre-wal",
        error: message,
        failureCode: "maintenance-recovery-blocked"
      };
    }
    try {
      const result = await this.maintenanceRunner.runMaintenance(
        mode,
        userRequest,
        frozenTurnOptions,
        selectedBackend
      );
      if (durableWorkflow && result.commitState === "wal-persisted") {
        this.startInProcessMaintenanceRecovery(result);
      }
      return result;
    } finally {
      releaseAuthority();
    }
  }

  private async answerQuestion(text: string, turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    return this.queryJournalService.answerQuestion(text, turnOptionOverrides);
  }

  private async writeDailyJournal(text: string, attachments: StoredAttachment[], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    return this.queryJournalService.writeDailyJournal(text, attachments, turnOptionOverrides);
  }

  private beginKnowledgeBaseRun(): void {
    this.running = true;
    this.cancelRequested = false;
    this.cancellationPhase = "cancelable";
  }

  private tryEnterMaintenanceCommitPhase(): boolean {
    if (
      !this.running
      || this.cancellationPhase !== "cancelable"
      || this.cancelRequested
    ) {
      return false;
    }
    this.cancellationPhase = "commit-locked";
    return true;
  }

  private isMaintenanceCommitPhaseLocked(): boolean {
    return this.cancellationPhase === "commit-locked";
  }

  private finishKnowledgeBaseRun(): void {
    this.agentTaskService.clearActiveRuns();
    this.running = false;
    this.cancellationPhase = "idle";
    // Keep the cancellation latch set through terminal cleanup. A backend
    // abort can settle the Harness while cancelMaintenance() is still
    // awaiting its own persistence; clearing here lets the same run resume as
    // a recovered success. The next beginKnowledgeBaseRun() resets the latch.
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库面板刷新失败", error);
    }
  }

  private finishRawDigestCalibrationRun(refreshSurfaces: boolean): void {
    this.running = false;
    this.cancelRequested = false;
    this.cancellationPhase = "idle";
    if (!refreshSurfaces) return;
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库仪表盘刷新失败", error);
    }
  }

  async archivePendingCodexKnowledgeThreads(): Promise<number> {
    return await this.settlePendingKnowledgeBaseNativeExecutions();
  }

  async settlePendingKnowledgeBaseNativeExecutions(
    runIds?: readonly string[]
  ): Promise<number> {
    return await this.agentTaskService.settlePendingNativeExecutions(runIds);
  }

  getLastNativeLifecycleSummary() {
    return this.agentTaskService.getLastNativeLifecycleSummary();
  }

  private startMaintenanceRecovery(
    kind: MaintenanceRecoveryKind = this.maintenanceRecoveryKind,
    nativeRunIds: readonly string[] = this.maintenanceRecoveryNativeRunIds
  ): Promise<void> {
    if (this.maintenanceManagerDisposed) {
      return Promise.reject(new Error("知识库管理器已卸载"));
    }
    if (
      this.maintenanceRecoveryGate
      && this.maintenanceRecoveryState !== "ready"
    ) {
      return this.maintenanceRecoveryGate;
    }
    const generation = this.maintenanceRecoveryGeneration + 1;
    this.maintenanceRecoveryGeneration = generation;
    const recoveryNativeRunIds = Array.from(new Set(
      nativeRunIds.map((runId) => runId.trim()).filter(Boolean)
    ));
    // Queue the startup snapshot on the Native Store mutation lane before any
    // UI refresh can re-enter and register a new knowledge execution. The
    // later reconciliation therefore owns exact pre-start record identities,
    // not an ambiguous wall-clock boundary.
    const startupNativeRecordIds = kind === "startup"
      ? this.snapshotStartupNativeRecordIds()
      : Promise.resolve([] as string[]);
    let resolveRecovery!: () => void;
    let rejectRecovery!: (error: unknown) => void;
    const recovery = new Promise<void>((resolve, reject) => {
      resolveRecovery = resolve;
      rejectRecovery = reject;
    });
    // Publish the new generation's gate before any UI callback can re-enter
    // waitUntilMaintenanceReady() and observe the previous resolved gate.
    this.maintenanceRecoveryGate = recovery;
    this.maintenanceRecoveryKind = kind;
    this.maintenanceRecoveryNativeRunIds = [...recoveryNativeRunIds];
    this.maintenanceRecoveryState = "pending";
    this.maintenanceRecoveryError = "";
    this.markPendingMaintenanceUiRecoveryState(
      "recovery-pending",
      MAINTENANCE_RECOVERY_PENDING_MESSAGE
    );
    this.refreshSurfacesAfterRecoveryStateChange();
    void Promise.all([
      this.waitForMaintenanceWriteAuthorityDrain(),
      startupNativeRecordIds
    ])
      .then(([, recordIds]) =>
        this.recoverMaintenanceWorkflows(kind, recordIds)
      )
      .then(async () => {
        if (
          kind === "in-process"
          && recoveryNativeRunIds.length
        ) {
          const settlement = await this.agentTaskService
            .settlePendingNativeExecutionsForRunIds(
            recoveryNativeRunIds
          );
          const matchedRunIds = new Set(settlement.matchedRunIds);
          const missingRunIds = recoveryNativeRunIds.filter(
            (runId) => !matchedRunIds.has(runId)
          );
          if (
            settlement.localCommitStatus !== "committed"
            || missingRunIds.length
          ) {
            throw Object.assign(
              new Error(
                missingRunIds.length
                  ? `WAL 维护 Native lifecycle 缺少匹配记录：${missingRunIds.join(", ")}`
                  : "WAL 维护 Native lifecycle 本地终态尚未耐久"
              ),
              { code: "MAINTENANCE_NATIVE_SETTLEMENT_PENDING" }
            );
          }
        }
      })
      .then(
      () => {
        if (
          !this.maintenanceManagerDisposed
          && this.maintenanceRecoveryGeneration === generation
        ) {
          this.maintenanceRecoveryState = "ready";
          this.maintenanceRecoveryError = "";
          this.refreshSurfacesAfterRecoveryStateChange();
        }
        resolveRecovery();
      },
      (error) => {
        if (
          !this.maintenanceManagerDisposed
          && this.maintenanceRecoveryGeneration === generation
        ) {
          this.maintenanceRecoveryState = "blocked";
          this.maintenanceRecoveryError = error instanceof Error
            ? error.message
            : String(error);
          this.markPendingMaintenanceUiRecoveryState(
            "recovery-blocked",
            maintenanceRecoveryBlockedMessage(this.maintenanceRecoveryError)
          );
          this.refreshSurfacesAfterRecoveryStateChange();
        }
        rejectRecovery(error);
      }
    );
    return recovery;
  }

  private async waitUntilMaintenanceReady(): Promise<void> {
    this.assertMaintenanceManagerActive();
    if (this.maintenanceRecoveryState === "ready") return;
    await this.startMaintenanceRecovery();
    this.assertMaintenanceManagerActive();
  }

  private async retryMaintenanceRecovery(): Promise<void> {
    this.assertMaintenanceManagerActive();
    if (this.maintenanceRecoveryState === "ready") return;
    if (this.maintenanceRecoveryState === "pending") {
      await this.startMaintenanceRecovery();
      this.assertMaintenanceManagerActive();
      return;
    }
    // A rejected startup promise is intentionally cached to keep callers from
    // racing a second replay. A later explicit command is a safe retry point:
    // it creates one new shared gate and still never starts an Agent until the
    // previous WAL has been fully recovered.
    const kind = this.maintenanceRecoveryKind;
    const nativeRunIds = [...this.maintenanceRecoveryNativeRunIds];
    this.maintenanceRecoveryGate = null;
    await this.startMaintenanceRecovery(kind, nativeRunIds);
    this.assertMaintenanceManagerActive();
  }

  private async acquireMaintenanceAuthority(): Promise<void> {
    this.assertMaintenanceManagerActive();
    if (this.maintenanceRecoveryState === "ready") return;
    await (this.maintenanceRecoveryState === "blocked"
      ? this.retryMaintenanceRecovery()
      : this.waitUntilMaintenanceReady());
    this.assertMaintenanceManagerActive();
  }

  private async acquireMaintenanceWriteAuthority(): Promise<() => void> {
    this.assertMaintenanceManagerActive();
    await this.acquireMaintenanceAuthority();
    this.assertMaintenanceManagerActive();
    if (this.maintenanceRecoveryState !== "ready") {
      throw new Error(this.maintenanceRecoveryStatus.message);
    }
    return this.issueMaintenanceWriteAuthority();
  }

  private issueMaintenanceWriteAuthority(): () => void {
    this.assertMaintenanceManagerActive();
    this.maintenanceWriteLeaseCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.maintenanceWriteLeaseCount -= 1;
      if (this.maintenanceWriteLeaseCount !== 0) return;
      const waiters = [...this.maintenanceWriteDrainWaiters];
      this.maintenanceWriteDrainWaiters.clear();
      for (const resolve of waiters) resolve();
    };
  }

  private async withMaintenanceWriteAuthority<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    let releaseAuthority: (() => void) | null = null;
    if (this.maintenanceRecoveryState === "ready") {
      releaseAuthority = this.issueMaintenanceWriteAuthority();
    } else {
      try {
        releaseAuthority = await this.acquireMaintenanceWriteAuthority();
      } catch (error) {
        if (this.maintenanceManagerDisposed) throw error;
        throw new Error(this.maintenanceRecoveryStatus.message);
      }
    }
    try {
      return await operation();
    } finally {
      releaseAuthority();
    }
  }

  private waitForMaintenanceWriteAuthorityDrain(): Promise<void> {
    if (this.maintenanceWriteLeaseCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.maintenanceWriteDrainWaiters.add(resolve);
    });
  }

  private startInProcessMaintenanceRecovery(
    result: KnowledgeBaseRunResult
  ): void {
    if (this.maintenanceManagerDisposed) return;
    if (this.maintenanceRecoveryState === "pending") return;
    const nativeRunIds = maintenanceNativeRunIds(result);
    void this.startMaintenanceRecovery("in-process", nativeRunIds).catch((error) => {
      console.error(
        `EchoInk knowledge WAL recovery blocked (${result.workflowRunId ?? "unknown"})`,
        error
      );
    });
  }

  private refreshSurfacesAfterRecoveryStateChange(): void {
    if (this.maintenanceManagerDisposed) return;
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库维护恢复状态刷新失败", error);
    }
  }

  private markPendingMaintenanceUiRecoveryState(
    status: "recovery-pending" | "recovery-blocked",
    message: string
  ): void {
    const pendingRuns = this.pendingMaintenanceUiRuns();
    if (!pendingRuns.length) return;
    const runIds = new Set(pendingRuns.map((run) => run.runId));
    for (const run of pendingRuns) {
      if (run.message.runTerminalRecovered === true) continue;
      run.message.status = status;
      run.message.text = message;
      run.session.updatedAt = Date.now();
    }
    for (const session of this.plugin.settings.sessions) {
      for (const message of session.messages) {
        if (
          !message.runId
          || !runIds.has(message.runId)
          || message.itemType === "knowledgeBase"
          || !isMaintenanceRecoveryUiStatus(message.status)
          || message.runTerminalRecovered === true
        ) {
          continue;
        }
        message.status = status;
      }
    }
  }

  private assertMaintenanceManagerActive(): void {
    if (this.maintenanceManagerDisposed) {
      throw new Error("知识库管理器已卸载");
    }
  }

  private snapshotStartupNativeRecordIds(): Promise<string[]> {
    if (!this.maintenanceStartupNativeRecordIds) {
      this.maintenanceStartupNativeRecordIds =
        this.plugin.snapshotPendingNativeExecutionRecordIdsForRecovery({
          surface: "knowledge"
        }).then((recordIds) => Array.from(new Set(
          recordIds.map((recordId) => recordId.trim()).filter(Boolean)
        )));
    }
    return this.maintenanceStartupNativeRecordIds;
  }

  private async recoverMaintenanceWorkflows(
    kind: MaintenanceRecoveryKind,
    startupNativeRecordIds: readonly string[]
  ): Promise<void> {
    const vaultPath = this.plugin.getVaultPath();
    if (!vaultPath.trim()) throw new Error("知识库维护恢复无法确定当前 Vault 路径");
    const storageRootPath =
      this.plugin.getKnowledgeBaseWorkflowStorageRoot(vaultPath);
    const historyRunIdsBefore = new Set(
      this.plugin.settings.knowledgeBase.maintenanceHistory
        .filter((entry) =>
          durableMaintenanceResultFromHistory(entry) !== null
        )
        .map((entry) => entry.runId)
        .filter((runId): runId is string => Boolean(runId))
    );
    const recovery = await recoverPendingMaintenanceWorkflows({
      storageRootPath,
      liveVaultPath: vaultPath,
      settingsHost: this.plugin.getKnowledgeBaseWorkflowSettingsHost()
    });
    if (recovery.blocked > 0 || recovery.invalid > 0) {
      const details = recovery.issues.slice(0, 3).join("；") || "存在无法自动恢复的 workflow WAL";
      throw Object.assign(
        new Error(`知识库维护恢复被阻断：${details}`),
        {
          code: "MAINTENANCE_RECOVERY_BLOCKED",
          recovery
        }
      );
    }

    const recoveryReason = kind === "startup"
      ? "插件重新加载后，上次知识库任务没有正常结束，已恢复为空闲状态。"
      : "当前进程已接管 WAL 恢复，未再次运行 Agent。";
    const activeRunRecovery = this.recoverActiveMaintenanceRuns(
      await listActiveMaintenanceRunJournals(storageRootPath),
      recoveryReason
    );
    const newlyRecoveredHistoryRunIds = new Set(
      this.plugin.settings.knowledgeBase.maintenanceHistory
        .filter((entry) =>
          durableMaintenanceResultFromHistory(entry) !== null
        )
        .map((entry) => entry.runId)
        .filter((runId): runId is string =>
          typeof runId === "string" && !historyRunIdsBefore.has(runId))
    );
    for (const runId of activeRunRecovery.historyRunIds) {
      newlyRecoveredHistoryRunIds.add(runId);
    }
    const recoveredState = this.recoverPersistedRunState(recoveryReason);
    for (const runId of recoveredState.historyRunIds) {
      newlyRecoveredHistoryRunIds.add(runId);
    }
    const reconciledMessageCount = this.reconcileRecoveredMaintenanceMessages(
      newlyRecoveredHistoryRunIds,
      recoveryReason
    );
    if (
      activeRunRecovery.count
      || recoveredState.count
      || reconciledMessageCount
    ) {
      const saveError = await saveSettingsSafely(this.plugin, {
        flushConversationStore: true,
        flushKnowledgeBaseHistory: false
      });
      if (saveError) {
        throw new Error(`知识库遗留运行状态保存失败：${saveError}`);
      }
    }
    for (const active of activeRunRecovery.removeAfterSave) {
      await removeActiveMaintenanceRunJournal(active.handle, {
        expectedRevision: active.record.revision,
        expectedDigest: active.record.digest
      });
    }
    if (kind === "startup") {
      await this.plugin.failPendingNativeExecutionsForRecovery({
        reason: recoveryReason,
        surface: "knowledge",
        recordIds: startupNativeRecordIds
      });
    }
  }

  private recoverActiveMaintenanceRuns(
    activeRuns: readonly LoadedActiveMaintenanceRunJournal[],
    reason: string
  ): {
    count: number;
    historyRunIds: string[];
    removeAfterSave: LoadedActiveMaintenanceRunJournal[];
  } {
    const settings = this.plugin.settings.knowledgeBase;
    const terminalRunIds = new Set(
      settings.maintenanceHistory
        .filter((entry) =>
          durableMaintenanceResultFromHistory(entry) !== null
        )
        .map((entry) => entry.runId)
        .filter((runId): runId is string => Boolean(runId))
    );
    const unresolved = activeRuns.filter(
      (active) => !terminalRunIds.has(active.record.workflowRunId)
    );
    if (unresolved.length > 1) {
      throw Object.assign(
        new Error(
          `发现 ${unresolved.length} 个没有终态的 pre-WAL 维护运行，拒绝猜测恢复顺序`
        ),
        { code: "MAINTENANCE_ACTIVE_RUN_AMBIGUOUS" }
      );
    }

    const historyRunIds: string[] = [];
    for (const active of unresolved) {
      const at = Date.now();
      const failureCode = "orphaned-active-run-before-wal";
      const attempts = recoveredActiveRunAttempts(
        active.record.attempts,
        at,
        reason,
        failureCode
      );
      if (
        settings.lastRunStatus === "running"
      ) {
        settings.lastRunAt = at;
        settings.lastRunStatus = "failed";
        settings.lastError = reason;
        settings.lastSummary = "";
      }
      if (
        settings.lastScheduledRunStatus === "running"
        && settings.lastScheduledRunId === active.record.workflowRunId
      ) {
        settings.lastScheduledRunStatus = "failed";
      }
      recordKnowledgeBaseMaintenanceRun(settings, {
        status: "failed",
        mode: active.record.mode,
        at,
        runId: active.record.workflowRunId,
        reportPath: "",
        selectedBackend: active.record.selectedBackend,
        winnerBackend: null,
        attempts,
        failureCode,
        terminalPhase: "recovery-blocked",
        commitState: "pre-wal",
        errorCode: failureCode,
        warnings: [{
          id: "startup-active-run-recovery",
          message:
            `${reason}最后可信阶段：${active.record.terminalPhase}。`
        }]
      });
      historyRunIds.push(active.record.workflowRunId);
    }
    return {
      count: unresolved.length,
      historyRunIds,
      removeAfterSave: [...activeRuns]
    };
  }

  private recoverPersistedRunState(
    reason: string
  ): { count: number; historyRunIds: string[] } {
    const settings = this.plugin.settings.knowledgeBase;
    let recovered = 0;
    const lastRunWasRunning = settings.lastRunStatus === "running";
    const scheduledRunWasRunning =
      settings.lastScheduledRunStatus === "running";
    if (!lastRunWasRunning && !scheduledRunWasRunning) {
      return { count: 0, historyRunIds: [] };
    }

    const recoveredAt = Date.now();
    const startedAt = Math.max(
      lastRunWasRunning ? settings.lastRunAt : 0,
      scheduledRunWasRunning ? settings.lastScheduledRunAt : 0
    ) || recoveredAt;
    const pendingUiRuns = this.pendingMaintenanceUiRuns();
    const mode = orphanedMaintenanceMode(
      pendingUiRuns.length === 1
        ? pendingUiRuns[0].message.knowledgeBaseUi?.mode
        : undefined,
      scheduledRunWasRunning
    );
    const runId = this.orphanedMaintenanceRunId(
      pendingUiRuns,
      mode,
      startedAt,
      scheduledRunWasRunning ? settings.lastScheduledRunId : ""
    );
    const existingTerminal = scheduledRunWasRunning
      ? [...settings.maintenanceHistory]
        .reverse()
        .find((entry) =>
          entry.runId === runId
          && entry.mode === mode
          && entry.at >= startedAt
          && durableMaintenanceResultFromHistory(entry) !== null
        )
      : undefined;
    if (existingTerminal) {
      if (lastRunWasRunning) {
        settings.lastRunStatus = existingTerminal.status;
        recovered += 1;
      }
      settings.lastScheduledRunStatus = existingTerminal.status;
      settings.lastReportPath =
        existingTerminal.reportPath || settings.lastReportPath;
      settings.lastCompletion = existingTerminal.completion ?? "";
      settings.lastAttempts = existingTerminal.attempts ?? [];
      settings.lastPendingSources = existingTerminal.pendingSources ?? [];
      settings.lastFailureCode = existingTerminal.failureCode ?? "";
      settings.lastWarnings = existingTerminal.warnings ?? [];
      recovered += 1;
      return { count: recovered, historyRunIds: [runId] };
    }
    const errorCode = "orphaned-running-without-wal";
    const attempts = orphanedMaintenanceAttempts(
      settings.lastAttempts,
      recoveredAt,
      reason,
      errorCode
    );
    const phase = orphanedMaintenancePhase(
      attempts,
      scheduledRunWasRunning
    );
    const selectedBackend = persistedAgentBackendForRecovery(
      attempts[0]?.backend,
      pendingUiRuns.length === 1
        ? pendingUiRuns[0].message.backendId
        : undefined
    );
    const warnings: KnowledgeBaseRunWarning[] = [{
      id: "startup-orphan-recovery",
      message: reason
    }];

    if (lastRunWasRunning) {
      settings.lastRunStatus = "failed";
      settings.lastError = appendKnowledgeBaseWarning(settings.lastError, reason);
      settings.lastSummary = "";
      recovered += 1;
    }
    if (scheduledRunWasRunning) {
      settings.lastScheduledRunStatus = "failed";
      settings.lastError = appendKnowledgeBaseWarning(settings.lastError, reason);
      recovered += 1;
    }
    recordKnowledgeBaseMaintenanceRun(settings, {
      status: "failed",
      mode,
      at: recoveredAt,
      runId,
      reportPath: settings.lastReportPath,
      ...(selectedBackend ? { selectedBackend } : {}),
      winnerBackend: null,
      attempts,
      pendingSources: settings.lastPendingSources,
      failureCode: errorCode,
      terminalPhase: "recovery-blocked",
      commitState: "pre-wal",
      phase,
      errorCode,
      warnings
    });
    return { count: recovered, historyRunIds: [runId] };
  }

  private orphanedMaintenanceRunId(
    pendingUiRuns: PendingMaintenanceUiRun[],
    mode: KnowledgeBaseMaintenanceMode,
    startedAt: number,
    scheduledRunId = ""
  ): string {
    if (scheduledRunId.trim()) return scheduledRunId.trim().slice(0, 512);
    if (pendingUiRuns.length === 1) return pendingUiRuns[0].runId;
    const legacyRunning = Object.values(
      this.plugin.settings.knowledgeBase.legacyManagedThreads ?? {}
    ).filter((thread) =>
      thread.archiveState === "running"
      && Boolean(thread.runId.trim())
    );
    if (legacyRunning.length === 1) return legacyRunning[0].runId.trim();
    return `orphaned-knowledge-${mode}-${startedAt}`.slice(0, 200);
  }

  private pendingMaintenanceUiRuns(): PendingMaintenanceUiRun[] {
    const runs: PendingMaintenanceUiRun[] = [];
    for (const session of this.plugin.settings.sessions) {
      if (
        session.kind !== "knowledge-base"
        && session.id !== this.plugin.settings.knowledgeBase.sessionId
      ) {
        continue;
      }
      for (const message of session.messages) {
        if (
          !isMaintenanceRecoveryUiStatus(message.status)
          || message.itemType !== "knowledgeBase"
          || message.knowledgeBaseUi?.kind !== "maintain-run"
          || !message.runId?.trim()
        ) {
          continue;
        }
        runs.push({
          session,
          message,
          runId: message.runId.trim()
        });
      }
    }
    return runs;
  }

  private reconcileRecoveredMaintenanceMessages(
    newlyRecoveredHistoryRunIds: ReadonlySet<string>,
    recoveryReason: string
  ): number {
    const pending = this.pendingMaintenanceUiRuns();
    const settings = this.plugin.settings.knowledgeBase;
    const historyByRunId = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
    for (const entry of settings.maintenanceHistory) {
      if (
        !entry.runId
        || durableMaintenanceResultFromHistory(entry) === null
      ) {
        continue;
      }
      const existing = historyByRunId.get(entry.runId);
      if (!existing || existing.at <= entry.at) {
        historyByRunId.set(entry.runId, entry);
      }
    }

    const assignments = new Map<PendingMaintenanceUiRun, KnowledgeBaseMaintenanceHistoryEntry>();
    const usedHistoryRunIds = new Set<string>();
    for (const run of pending) {
      const exact = historyByRunId.get(run.runId);
      if (!exact) continue;
      assignments.set(run, exact);
      if (exact.runId) usedHistoryRunIds.add(exact.runId);
    }

    const unmatched = pending.filter((run) => !assignments.has(run));
    const fallbackCandidates = settings.maintenanceHistory.filter((entry) =>
      Boolean(entry.runId)
      && durableMaintenanceResultFromHistory(entry) !== null
      && newlyRecoveredHistoryRunIds.has(entry.runId!)
      && !usedHistoryRunIds.has(entry.runId!)
    );
    if (
      unmatched.length === 1
      && fallbackCandidates.length === 1
      && maintenanceHistoryMatchesUiMode(
        fallbackCandidates[0],
        unmatched[0].message.knowledgeBaseUi?.mode
      )
    ) {
      assignments.set(unmatched[0], fallbackCandidates[0]);
      usedHistoryRunIds.add(fallbackCandidates[0].runId!);
    }

    let changed = 0;
    const reconciledHistoryRunIds = new Set<string>();
    for (const run of pending) {
      let history = assignments.get(run);
      if (!history) {
        history = this.recordOrphanedMaintenanceUiRun(
          run,
          recoveryReason
        );
      }
      changed += this.projectMaintenanceHistoryToUiRun(run, history);
      if (history.runId) reconciledHistoryRunIds.add(history.runId);
    }
    const knowledgeSession = this.plugin.settings.sessions.find((session) =>
      session.kind === "knowledge-base"
      || session.id === settings.sessionId
    );
    if (knowledgeSession) {
      for (const runId of newlyRecoveredHistoryRunIds) {
        if (reconciledHistoryRunIds.has(runId)) continue;
        const history = historyByRunId.get(runId);
        if (!history) continue;
        changed += this.ensureRecoveredMaintenanceTerminal(
          knowledgeSession,
          history
        ).appended ? 1 : 0;
      }
    }
    return changed;
  }

  private recordOrphanedMaintenanceUiRun(
    run: PendingMaintenanceUiRun,
    recoveryReason: string
  ): KnowledgeBaseMaintenanceHistoryEntry {
    const settings = this.plugin.settings.knowledgeBase;
    const at = Date.now();
    const mode = orphanedMaintenanceMode(
      run.message.knowledgeBaseUi?.mode,
      false
    );
    const errorCode = "orphaned-ui-run-without-wal";
    const attempts = orphanedMaintenanceAttempts(
      [],
      at,
      recoveryReason,
      errorCode
    );
    const selectedBackend = persistedAgentBackendForRecovery(
      run.message.backendId
    );
    const shouldReplaceTerminal =
      settings.lastRunStatus === "running"
      || settings.lastRunAt <= run.message.createdAt;
    const terminalSnapshot = shouldReplaceTerminal
      ? null
      : maintenanceTerminalMetadataSnapshot(settings);
    if (shouldReplaceTerminal) {
      settings.lastRunAt = Math.max(run.message.createdAt, at);
      settings.lastRunStatus = "failed";
      settings.lastError = recoveryReason;
      settings.lastSummary = "";
    }
    recordKnowledgeBaseMaintenanceRun(settings, {
      status: "failed",
      mode,
      at,
      runId: run.runId,
      reportPath: "",
      ...(selectedBackend ? { selectedBackend } : {}),
      winnerBackend: null,
      attempts,
      failureCode: errorCode,
      terminalPhase: "recovery-blocked",
      commitState: "pre-wal",
      phase: "startup-ui-reconciliation",
      errorCode,
      warnings: [{
        id: "startup-ui-orphan-recovery",
        message: recoveryReason
      }]
    });
    if (terminalSnapshot) restoreMaintenanceTerminalMetadata(settings, terminalSnapshot);
    return settings.maintenanceHistory.find((entry) =>
      entry.runId === run.runId
    )!;
  }

  private projectMaintenanceHistoryToUiRun(
    run: PendingMaintenanceUiRun,
    history: KnowledgeBaseMaintenanceHistoryEntry
  ): number {
    const terminal = this.ensureRecoveredMaintenanceTerminal(
      run.session,
      history
    );
    for (const message of run.session.messages) {
      if (message.runId?.trim() !== run.runId) continue;
      projectMaintenanceMessageProvenance(message, history);
    }
    // Keep the original run card as a live-only projection. New run cards are
    // filtered before V2 commit; already-durable legacy cards remain an
    // immutable prefix. The append-only terminal above is the durable result.
    run.message.status = terminal.message.status;
    run.message.text = terminal.message.text;
    run.message.completedAt = terminal.message.completedAt;
    run.message.runTerminalRecovered = true;
    delete run.message.runTerminalRecoveryPending;
    run.session.updatedAt = Math.max(
      run.session.updatedAt,
      terminal.message.completedAt ?? terminal.message.createdAt
    );
    return 1;
  }

  private ensureRecoveredMaintenanceTerminal(
    session: StoredSession,
    history: KnowledgeBaseMaintenanceHistoryEntry
  ): {
    appended: boolean;
    message: ChatMessage;
  } {
    const runId = history.runId?.trim() ?? "";
    const messageId = recoveredMaintenanceMessageId(
      runId || `${history.mode}:${history.at}`
    );
    const existing = session.messages.find(
      (message) => message.id === messageId
    );
    if (existing) return { appended: false, message: existing };

    const recoveredMode = orphanedMaintenanceMode(history.mode, false);
    const mode: KnowledgeBaseCommandUiMode = recoveredMode === "unknown"
      ? "maintain"
      : recoveredMode;
    const settings = this.plugin.settings.knowledgeBase;
    const latestHistory = [...settings.maintenanceHistory]
      .reverse()
      .find((entry) =>
        durableMaintenanceResultFromHistory(entry) !== null
      );
    const isLatest = Boolean(
      history.runId
      && latestHistory?.runId === history.runId
    );
    const error = history.errorCode
      || history.failureCode
      || (history.status === "failed" ? "任务在插件重载时中断" : "");
    const result: KnowledgeBaseRunResult = {
      status: history.status,
      reportPath: history.reportPath,
      summary: isLatest ? settings.lastSummary : "",
      processedSources: [],
      ...(history.runId ? { workflowRunId: history.runId } : {}),
      ...(history.selectedBackend
        ? { selectedBackend: history.selectedBackend }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(history, "winnerBackend")
        ? { winnerBackend: history.winnerBackend ?? null }
        : {}),
      ...(history.terminalPhase
        ? { terminalPhase: history.terminalPhase }
        : {}),
      ...(history.commitState
        ? { commitState: history.commitState }
        : {}),
      ...(history.completion ? { completion: history.completion } : {}),
      ...(history.attempts ? { attempts: history.attempts } : {}),
      ...(history.pendingSources
        ? { pendingSources: history.pendingSources }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(history, "failureCode")
        ? { failureCode: history.failureCode ?? null }
        : {}),
      ...(history.warnings ? { warnings: history.warnings } : {}),
      ...(error ? { error } : {})
    };
    const now = Date.now();
    const message: ChatMessage = {
      id: messageId,
      role: "assistant",
      title: "知识库管理",
      itemType: "knowledgeBase",
      status: maintenanceUiMessageStatus(history.status),
      text: recoveredMaintenanceMessageText(mode, history, error),
      ...(runId ? { runId } : {}),
      knowledgeBaseUi:
        buildKnowledgeBaseMaintainReportPayload(mode, result),
      createdAt: now,
      completedAt: now,
      runTerminalRecovered: true
    };
    projectMaintenanceMessageProvenance(message, history);
    session.messages.push(message);
    session.updatedAt = Math.max(session.updatedAt, now);
    return { appended: true, message };
  }

  private async runKnowledgeAgentTask(input: {
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
    backend?: AgentBackendKind;
    workflowRunId?: string;
    attemptId?: string;
    attemptOrdinal?: number;
    maintenanceResourceProfile?: boolean;
    vaultPathOverride?: string;
    writableRootsOverride?: string[];
    exactWriteFence?: import("../agent/types").AgentExactWriteFenceContext;
    onExactWriteFenceConfigured?: import("../agent/types").AgentTaskInput["onExactWriteFenceConfigured"];
  }): Promise<KnowledgeAgentTaskOutput> {
    throwIfKnowledgeBaseCanceled(this.cancelRequested);
    const rules = await this.resolveRulesFile();
    const taskVaultPath = input.vaultPathOverride ?? this.plugin.getVaultPath();
    const rulesContext = await loadKnowledgeBaseRulesContext(taskVaultPath, rules.relativePath);
    throwIfKnowledgeBaseCanceled(this.cancelRequested);
    const backend = input.backend ?? this.resolveKnowledgeBackend();
    const maintenanceResourceProfile = input.maintenanceResourceProfile === true;
    const isolateExternalResources = maintenanceResourceProfile
      || input.turnOptionOverrides?.externalResources === "disabled";
    const resources = await this.prepareKnowledgeAgentResources(backend, isolateExternalResources);
    const toolBridge = !isolateExternalResources && harnessKnowledgeUsesEchoInkToolBridge(backend)
      ? await this.prepareKnowledgeAgentToolBridge()
      : null;
    const prompt = harnessKnowledgePromptUsesPreparedResources(backend)
      ? buildPromptWithPreparedResources(input.prompt, resources)
      : input.prompt;
    return await this.agentTaskService.runTask({
      backend,
      prompt,
      sources: input.sources,
      permission: harnessKnowledgeTaskPermission(backend, input.permission, input.codexWriteScope),
      codexWriteScope: input.codexWriteScope,
      turnOptionOverrides: input.turnOptionOverrides,
      managedKind: input.managedKind,
      resources,
      toolBridge,
      vaultProfileSections: [rulesContext.section],
      workflowRunId: input.workflowRunId,
      attemptId: input.attemptId,
      attemptOrdinal: input.attemptOrdinal,
      vaultPathOverride: input.vaultPathOverride,
      writableRootsOverride: input.writableRootsOverride,
      exactWriteFence: input.exactWriteFence,
      onExactWriteFenceConfigured: input.onExactWriteFenceConfigured
    });
  }

  private async prepareKnowledgeAgentResources(
    backend: AgentBackendKind,
    maintenanceResourceProfile = false
  ): Promise<PreparedAgentResources> {
    const catalog = knowledgeWorkflowResourceCatalog(await this.runtimeEchoInkResourceCatalog());
    return prepareAgentResources(catalog, {
      scope: "knowledge",
      backendCapabilities: getAgentBackendDefinition(backend).capabilities,
      enabledByScope: this.plugin.settings.resources.enabledByScope,
      mcpConnections: this.plugin.settings.resources.mcpConnections,
      ...(maintenanceResourceProfile ? MAINTENANCE_AGENT_RESOURCE_PROFILE : {})
    });
  }

  private async prepareKnowledgeAgentToolBridge(): Promise<AgentToolBridgeRuntime | null> {
    const resourceSettings = this.plugin.settings.resources;
    const catalog = knowledgeWorkflowResourceCatalog(await this.runtimeEchoInkResourceCatalog());
    if (!catalog.length) return null;
    const callableTools = await buildCallableMcpToolCatalog({
      resources: catalog,
      scope: "knowledge",
      enabledByScope: resourceSettings.enabledByScope,
      connections: resourceSettings.mcpConnections,
      listTools: async (resource) => await this.plugin.listEchoInkMcpTools(resource.id, 10000)
    });
    return createEchoInkMcpToolBridgeRuntime({
      catalog: callableTools,
      scope: "knowledge",
      callTool: async (request) => await this.plugin.callEchoInkMcpTool(request)
    });
  }

  private async runtimeEchoInkResourceCatalog() {
    const plugin = this.plugin as CodexForObsidianPlugin & {
      buildRuntimeEchoInkResourceCatalog?: () => Promise<ReturnType<typeof buildActiveEchoInkResourceCatalog>>;
    };
    return typeof plugin.buildRuntimeEchoInkResourceCatalog === "function"
      ? await plugin.buildRuntimeEchoInkResourceCatalog()
      : buildActiveEchoInkResourceCatalog({ settings: this.plugin.settings.resources });
  }

  private resolveKnowledgeBackend(): AgentBackendKind {
    const configured = this.plugin.settings.knowledgeBase.backend;
    return configured === "default" ? this.plugin.settings.agentBackend : configured;
  }

  private formatFailureContext(reportPath = ""): string {
    const kb = this.plugin.settings.knowledgeBase;
    const backend = kb.lastAttempts.at(-1)?.backend ?? this.plugin.settings.agentBackend;
    const modelLabel = harnessMessageModelId(this.plugin.settings, backend);
    return [
      `后端：${backend}`,
      modelLabel ? `模型：${modelLabel}` : "",
      `规则文件：${resolveKnowledgeBaseRulesFilePath(kb)}`,
      reportPath ? `报告：${reportPath}` : ""
    ].filter(Boolean).join("\n");
  }

  private async resolveRulesFile(): Promise<{ relativePath: string; absolutePath: string; exists: boolean; useCustomRulesFile: boolean }> {
    const settings = this.plugin.settings.knowledgeBase;
    const relativePath = normalizeRulesPath(resolveKnowledgeBaseRulesFilePath(settings));
    const absolutePath = path.join(this.plugin.getVaultPath(), relativePath);
    return {
      relativePath,
      absolutePath,
      exists: await exists(absolutePath),
      useCustomRulesFile: settings.useCustomRulesFile
    };
  }

  private async runScheduledIfDue(forceCatchUp = false): Promise<void> {
    await this.scheduler.runScheduledIfDue(forceCatchUp);
  }

  private async settleScheduledMaintenance(result: KnowledgeBaseRunResult): Promise<void> {
    await settleScheduledMaintenanceLifecycle(this.plugin, result, async () => {
      const nativeRunIds = maintenanceNativeRunIds(result);
      if (nativeRunIds.length) {
        await this.settlePendingKnowledgeBaseNativeExecutions(nativeRunIds);
      }
      return this.getLastNativeLifecycleSummary();
    });
  }

  async captureText(target: "inbox" | "raw-articles"): Promise<void> {
    await this.withMaintenanceWriteAuthority(async () => {
      await this.captureService.captureText(target);
    });
  }

  async captureWeChatArticle(): Promise<string[]> {
    return await this.withMaintenanceWriteAuthority(
      async () => await this.captureService.captureWeChatArticle()
    );
  }

  async captureWebPage(): Promise<string[]> {
    return await this.withMaintenanceWriteAuthority(
      async () => await this.captureService.captureWebPage()
    );
  }

  async captureLink(): Promise<string[]> {
    return await this.withMaintenanceWriteAuthority(
      async () => await this.captureService.captureLink()
    );
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return await this.withMaintenanceWriteAuthority(
      async () => await this.captureService.captureExternalFiles(files)
    );
  }

  private async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[]): Promise<string[]> {
    return this.captureService.captureChatInput(target, text, attachments);
  }

  async captureActiveAttachment(): Promise<void> {
    await this.withMaintenanceWriteAuthority(async () => {
      await this.captureService.captureActiveAttachment();
    });
  }
}

interface PendingMaintenanceUiRun {
  session: StoredSession;
  message: ChatMessage;
  runId: string;
}

type MaintenanceTerminalMetadataSnapshot = Pick<
  KnowledgeBaseSettings,
  | "lastCompletion"
  | "lastAttempts"
  | "lastPendingSources"
  | "lastFailureCode"
  | "lastWarnings"
  | "healthHistory"
>;

function orphanedMaintenanceMode(
  mode: unknown,
  scheduledRunWasRunning: boolean
): KnowledgeBaseMaintenanceMode {
  if (
    mode === "maintain"
    || mode === "lint"
    || mode === "reingest"
    || mode === "outputs"
    || mode === "inbox"
  ) {
    return mode;
  }
  return scheduledRunWasRunning ? "maintain" : "unknown";
}

function orphanedMaintenancePhase(
  attempts: KnowledgeRunAttemptRecord[],
  scheduledRunWasRunning: boolean
): string {
  const attempt = attempts.at(-1);
  if (attempt?.failure) return "attempt-failed-unsettled";
  if (attempt?.termination?.requestedAt) return "termination-pending";
  if (attempt?.staging?.promotedAt) return "staging-promoted";
  if (attempt?.staging?.preparedAt) return "staging-prepared";
  if (attempt?.submitted) return "agent-submitted";
  if (attempt?.native) return "native-created";
  return scheduledRunWasRunning ? "scheduled-running" : "run-started";
}

function orphanedMaintenanceAttempts(
  existing: KnowledgeRunAttemptRecord[],
  at: number,
  reason: string,
  errorCode: string
): KnowledgeRunAttemptRecord[] {
  const attempts = trustedPersistedMaintenanceAttempts(existing);
  return attempts.map((attempt) => ({
    ...attempt,
    terminal: attempt.terminal ?? {
      status: "failed",
      at,
      message: reason
    },
    failure: attempt.failure ?? {
      code: errorCode,
      at,
      message: reason,
      phase: "execution",
      retryable: false,
      failoverEligible: false
    }
  }));
}

function trustedPersistedMaintenanceAttempts(
  existing: readonly KnowledgeRunAttemptRecord[]
): KnowledgeRunAttemptRecord[] {
  if (!existing.length || existing.length > 3) return [];
  const seenBackends = new Set<AgentBackendKind>();
  const seenAttemptIds = new Set<string>();
  for (const [index, attempt] of existing.entries()) {
    if (
      typeof attempt.attemptId !== "string"
      || !attempt.attemptId.trim()
      || attempt.ordinal !== index + 1
      || !isAgentBackendKind(attempt.backend)
      || seenBackends.has(attempt.backend)
      || seenAttemptIds.has(attempt.attemptId)
    ) {
      return [];
    }
    seenBackends.add(attempt.backend);
    seenAttemptIds.add(attempt.attemptId);
  }
  return existing.map((attempt) =>
    JSON.parse(JSON.stringify(attempt)) as KnowledgeRunAttemptRecord);
}

function recoveredActiveRunAttempts(
  existing: readonly KnowledgeRunAttemptRecord[],
  at: number,
  reason: string,
  errorCode: string
): KnowledgeRunAttemptRecord[] {
  return existing.map((attempt) => {
    const cloned = JSON.parse(
      JSON.stringify(attempt)
    ) as KnowledgeRunAttemptRecord;
    if (cloned.terminal) return cloned;
    return {
      ...cloned,
      terminal: {
        status: "failed",
        at,
        message: reason
      },
      failure: cloned.failure ?? {
        code: errorCode,
        at,
        message: reason,
        phase: "execution",
        retryable: false,
        failoverEligible: false
      }
    };
  });
}

function persistedAgentBackendForRecovery(
  ...candidates: unknown[]
): AgentBackendKind | undefined {
  return candidates.find(isAgentBackendKind);
}

function isAgentBackendKind(
  candidate: unknown
): candidate is AgentBackendKind {
  return candidate === "codex-cli"
    || candidate === "opencode"
    || candidate === "hermes";
}

function projectMaintenanceMessageProvenance(
  message: ChatMessage,
  history: KnowledgeBaseMaintenanceHistoryEntry
): void {
  if (!Object.prototype.hasOwnProperty.call(history, "winnerBackend")) return;
  if (history.winnerBackend === null) {
    delete message.backendId;
    delete message.modelId;
    delete message.profileId;
    return;
  }
  if (!history.winnerBackend) return;
  if (message.backendId !== history.winnerBackend) {
    delete message.modelId;
    delete message.profileId;
  }
  message.backendId = history.winnerBackend;
}

function maintenanceHistoryMatchesUiMode(
  history: KnowledgeBaseMaintenanceHistoryEntry,
  mode: unknown
): boolean {
  const uiMode = orphanedMaintenanceMode(mode, false);
  return history.mode === uiMode
    || history.mode === "unknown"
    || uiMode === "unknown";
}

function maintenanceTerminalMetadataSnapshot(
  settings: KnowledgeBaseSettings
): MaintenanceTerminalMetadataSnapshot {
  return {
    lastCompletion: settings.lastCompletion,
    lastAttempts: JSON.parse(JSON.stringify(settings.lastAttempts)),
    lastPendingSources: [...settings.lastPendingSources],
    lastFailureCode: settings.lastFailureCode,
    lastWarnings: JSON.parse(JSON.stringify(settings.lastWarnings)),
    healthHistory: JSON.parse(JSON.stringify(settings.healthHistory))
  };
}

function restoreMaintenanceTerminalMetadata(
  settings: KnowledgeBaseSettings,
  snapshot: MaintenanceTerminalMetadataSnapshot
): void {
  settings.lastCompletion = snapshot.lastCompletion;
  settings.lastAttempts = snapshot.lastAttempts;
  settings.lastPendingSources = snapshot.lastPendingSources;
  settings.lastFailureCode = snapshot.lastFailureCode;
  settings.lastWarnings = snapshot.lastWarnings;
  settings.healthHistory = snapshot.healthHistory;
}

function maintenanceUiMessageStatus(
  status: KnowledgeBaseMaintenanceHistoryEntry["status"]
): string {
  if (status === "success") return "completed";
  if (status === "canceled") return "canceled";
  return "failed";
}

function recoveredMaintenanceMessageId(runId: string): string {
  return `knowledge-maintenance-recovery-${createHash("sha256")
    .update(runId, "utf8")
    .digest("hex")}`;
}

function recoveredMaintenanceMessageText(
  mode: KnowledgeBaseCommandUiMode,
  history: KnowledgeBaseMaintenanceHistoryEntry,
  error: string
): string {
  const label = recoveredMaintenanceModeLabel(mode);
  const report = history.reportPath ? `\n报告：${history.reportPath}` : "";
  if (history.status === "success") {
    return `知识库${label}已从上次中断中恢复。${report}`;
  }
  if (history.status === "canceled") {
    return `知识库${label}已取消。${report}`;
  }
  return `知识库${label}恢复后确认失败：${error || "任务未安全完成"}${report}`;
}

function recoveredMaintenanceModeLabel(mode: KnowledgeBaseCommandUiMode): string {
  switch (mode) {
    case "lint":
      return "体检";
    case "reingest":
      return "重新提炼";
    case "calibrate":
      return "Raw 状态校准";
    case "outputs":
      return "Outputs 整理";
    case "inbox":
      return "Inbox 分流";
    case "maintain":
    default:
      return "维护";
  }
}

function isMaintenanceRecoveryUiStatus(status: unknown): boolean {
  return status === "running"
    || status === "recovery-pending"
    || status === "recovery-blocked";
}

function maintenanceNativeRunIds(
  result: Pick<KnowledgeBaseRunResult, "attempts">
): string[] {
  return Array.from(new Set(
    (result.attempts ?? [])
      .map((attempt) => attempt.submitted?.harnessRunId?.trim() ?? "")
      .filter(Boolean)
  ));
}

function maintenanceRecoveryBlockedMessage(error: string): string {
  const detail = error
    .trim()
    .replace(/^知识库维护恢复被阻断[：:]\s*/, "")
    || "请检查维护诊断";
  return `上次知识库维护恢复被阻断；尚未启动新的写入 Agent。普通对话、/ask、/history、/clear 和 /help 仍可使用。原因：${detail}`;
}

function dashboardSnapshotSignature(settings: CodexForObsidianPlugin["settings"]["knowledgeBase"]): string {
  return [
    settings.lastRunAt,
    settings.lastRunStatus,
    settings.lastScheduledRunAt,
    settings.lastScheduledRunStatus,
    settings.lastScheduledRunId,
    settings.lastReportPath,
    settings.lastError,
    Object.keys(settings.processedSources ?? {}).length,
    (settings.healthHistory ?? []).length,
    (settings.maintenanceHistory ?? []).length,
    Object.keys(settings.legacyManagedThreads ?? {}).length,
    settings.initialization.status,
    settings.initialization.initializedAt
  ].join("|");
}

function throwIfKnowledgeBaseCanceled(cancelRequested: boolean): void {
  if (cancelRequested) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
}

function reviewKindLabel(kind: ReviewReportKind): string {
  return kind === "knowledge-base" ? "知识库周报" : "Agent 周报";
}

function normalizeRulesPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/") || DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
}

function knowledgeWorkflowResourceCatalog(catalog: EchoInkResource[]): EchoInkResource[] {
  return catalog;
}
