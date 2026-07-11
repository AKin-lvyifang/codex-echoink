import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createAgentTaskRuntime } from "../agent/factory";
import { getAgentBackendDefinition } from "../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import type { AgentTaskRuntime, AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentTaskInput } from "../agent/types";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import { swallowError } from "../core/error-handling";
import type { TurnOptions } from "../core/codex-service";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles } from "../core/opencode-models";
import { buildCallableMcpToolCatalog } from "../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources } from "../resources/registry";
import { newId, providerConnectionLabel, type KnowledgeBaseManagedThreadKind, type ReviewReportKind, type StoredAttachment } from "../settings/settings";
import type { CodexNotification, PermissionMode } from "../types/app-server";
import { handleKnowledgeBaseUserMessage, type KnowledgeBaseChatResult, type KnowledgeBaseTurnOptionOverrides } from "./command-router";
import {
  buildCodexKnowledgeInput,
  buildOpenCodeKnowledgeParts,
  buildPromptWithPreparedResources,
  formatAgentTaskGuardError,
  formatDurationForError,
  normalizeCodexInactivityTimeoutMs,
  normalizeHermesTaskTimeoutMs,
  normalizeOpenCodeTaskTimeoutMs,
  rejectAfterTimeout,
  requiredModalities,
  runKnowledgeAgentTask,
  selectAgentModel,
  selectOpenCodeModel
} from "./agent-runner";
import { AGENTS_RULES_FILE } from "./constants";
import { extractKnowledgeBaseNotificationIds, routeKnowledgeBaseCodexNotification } from "./codex-route";
import { formatAgentTaskFailureContext, formatKnowledgeBaseCodexFailureSignal, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { runRawDigestCalibration } from "./raw-calibration";
import { KnowledgeBaseScheduler } from "./scheduler";
import { appendScheduledMaintenanceMessage as appendScheduledMaintenanceMessageToSession } from "./scheduled-maintenance";
import type { KnowledgeBaseMessageUiPayload } from "./maintain-report-card";
import {
  appendKnowledgeBaseWarning,
  cloneProcessedSources,
  formatCancelResultMessage,
  saveSettingsSafely,
  writeKnowledgeBaseTracker
} from "./maintenance";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";
import { KnowledgeBaseCaptureService } from "./capture";
import { KnowledgeBaseManagedThreadStore } from "./managed-threads";
import { KnowledgeBaseQueryJournalService } from "./query-journal";
import { KnowledgeBaseMaintenanceRunner } from "./maintenance-runner";
import { exists } from "./utils";

type CodexKbWaiter = {
  threadId: string;
  turnId: string;
  itemIds: Set<string>;
  assistantItems: Map<string, string>;
  assistantItemOrder: string[];
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  model: string;
  startTurnPending: boolean;
  inactivityTimeoutMs: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  pendingTerminal?: { method: "turn/completed" | "error"; params: unknown };
};

type ActiveOpenCodeRun = {
  runtime: AgentTaskRuntime;
  runId: string;
  cancel?: (error: Error) => void;
};

type ActiveHermesRun = {
  runtime: AgentTaskRuntime;
  runId: string;
  abortController: AbortController;
  cancel?: (error: Error) => void;
};

type GuardedAgentBackend = Extract<AgentBackendKind, "opencode" | "hermes">;
type GuardedAgentRun = ActiveOpenCodeRun | ActiveHermesRun;

const MAX_ATTACHED_SOURCES = 20;
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5000;

export class KnowledgeBaseManager {
  private running = false;
  private readonly scheduler: KnowledgeBaseScheduler;
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly queryJournalService: KnowledgeBaseQueryJournalService;
  private readonly managedThreads: KnowledgeBaseManagedThreadStore;
  private readonly maintenanceRunner: KnowledgeBaseMaintenanceRunner;
  private codexWaiter: CodexKbWaiter | null = null;
  private activeCodexRun: { threadId: string; turnId: string; cancel?: (error: Error) => void } | null = null;
  private activeOpenCode: ActiveOpenCodeRun | null = null;
  private activeHermes: ActiveHermesRun | null = null;
  private cancelRequested = false;
  private dashboardSnapshotCache: { snapshot: KnowledgeBaseDashboardSnapshot; savedAt: number; signature: string } | null = null;
  private dashboardSnapshotPromise: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.managedThreads = new KnowledgeBaseManagedThreadStore(plugin);
    this.captureService = new KnowledgeBaseCaptureService(plugin);
    this.queryJournalService = new KnowledgeBaseQueryJournalService(plugin, this.captureService, {
      isRunning: () => this.running,
      beginRun: () => this.beginKnowledgeBaseRun(),
      finishRun: () => this.finishKnowledgeBaseRun(),
      resolveRulesFile: () => this.resolveRulesFile(),
      resolveKnowledgeBackend: () => this.resolveKnowledgeBackend(),
      runKnowledgeAgentTask: (input) => this.runKnowledgeAgentTask(input)
    });
    this.maintenanceRunner = new KnowledgeBaseMaintenanceRunner(plugin, {
      isRunning: () => this.running,
      beginRun: () => this.beginKnowledgeBaseRun(),
      finishRun: () => this.finishKnowledgeBaseRun(),
      isCancelRequested: () => this.cancelRequested,
      resolveRulesFile: () => this.resolveRulesFile(),
      runKnowledgeAgentTask: (input) => this.runKnowledgeAgentTask(input)
    });
    this.scheduler = new KnowledgeBaseScheduler({
      getSettings: () => this.plugin.settings.knowledgeBase,
      isRunning: () => this.running,
      registerInterval: (intervalId) => this.plugin.registerInterval(intervalId),
      runMaintenance: () => this.runMaintenance("maintain"),
      appendScheduledMaintenanceMessage: (result) => this.appendScheduledMaintenanceMessage(result),
      refreshKnowledgeBaseSurfaces: () => this.refreshKnowledgeBaseSurfaces()
    });
  }

  register(): void {
    const recovered = this.recoverPersistedRunState("插件重新加载后，上次知识库任务没有正常结束，已恢复为空闲状态。");
    if (recovered) void saveSettingsSafely(this.plugin, { flushKnowledgeBaseHistory: false });
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
      callback: () => void this.captureText("inbox")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-link",
      name: "知识库：收集链接到 raw",
      callback: () => void this.captureText("raw-articles")
    });
    this.plugin.addCommand({
      id: "knowledge-base-capture-active-attachment",
      name: "知识库：收集当前图片或 PDF",
      callback: () => void this.captureActiveAttachment()
    });
    this.plugin.addCommand({
      id: "knowledge-base-cancel",
      name: "知识库：取消当前任务",
      callback: () => void this.cancelMaintenance()
    });
    this.plugin.addRibbonIcon("library", "知识库管理", () => void this.plugin.activateKnowledgeBaseChannel());
    this.plugin.app.workspace.onLayoutReady(() => {
      this.scheduler.start();
    });
  }

  unload(): void {
    this.scheduler.unload();
    if (this.codexWaiter) {
      this.codexWaiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiter = null;
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
    this.activeHermes = null;
    this.cancelRequested = false;
  }

  get isRunning(): boolean {
    return this.running;
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

  async cancelMaintenance(): Promise<void> {
    const codexRun = this.activeCodexRun;
    const openCodeRun = this.activeOpenCode;
    const hermesRun = this.activeHermes;
    if (!this.running && !this.codexWaiter && !codexRun && !openCodeRun && !hermesRun) {
      new Notice("当前没有知识库任务");
      return;
    }
    this.cancelRequested = true;
    const waiter = this.codexWaiter;
    if (codexRun?.threadId && codexRun.turnId && this.plugin.codex) {
      await this.plugin.codex.interruptTurn(codexRun.threadId, codexRun.turnId).catch(swallowError("cancel knowledge base Codex turn"));
    }
    if (codexRun?.cancel) codexRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
    if (openCodeRun?.runId) {
      if (openCodeRun.cancel) openCodeRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void openCodeRun.runtime.abort(openCodeRun.runId).catch(swallowError("cancel knowledge base OpenCode run"));
    }
    if (hermesRun?.runId) {
      hermesRun.abortController.abort();
      if (hermesRun.cancel) hermesRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void hermesRun.runtime.abort(hermesRun.runId).catch(swallowError("cancel knowledge base Hermes run"));
    }
    if (waiter && this.codexWaiter === waiter) {
      waiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiter = null;
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
    this.activeHermes = null;
    this.plugin.settings.knowledgeBase.lastRunStatus = "canceled";
    this.plugin.settings.knowledgeBase.lastError = "用户取消";
    const saveError = await saveSettingsSafely(this.plugin);
    if (saveError) {
      this.plugin.settings.knowledgeBase.lastError = `用户取消；状态保存失败：${saveError}`;
      await saveSettingsSafely(this.plugin);
    }
    new Notice("已取消知识库任务");
  }

  async testOpenCodeConnection(): Promise<void> {
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      const models = await backend.listModels();
      const selected = selectOpenCodeModel(
        models,
        this.plugin.settings.opencode.providerId,
        this.plugin.settings.opencode.modelId,
        ["text"]
      );
      if (selected) {
        this.plugin.settings.opencode.providerId = selected.providerId;
        this.plugin.settings.opencode.modelId = selected.modelId;
        this.plugin.settings.opencode.textEnabled = selected.inputModalities.includes("text");
        this.plugin.settings.opencode.imageEnabled = selected.inputModalities.includes("image");
        this.plugin.settings.opencode.pdfEnabled = selected.inputModalities.includes("pdf");
      }
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      await this.plugin.saveSettings(true);
      new Notice(`OpenCode 已连接，读取到 ${models.length} 个模型`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.settings.opencode.lastError = message;
      await this.plugin.saveSettings(true);
      new Notice(`OpenCode 连接失败：${message}`);
    } finally {
      await backend.disconnect();
    }
  }

  async handleUserMessage(text: string, attachments: StoredAttachment[] = [], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    return handleKnowledgeBaseUserMessage({
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
    settings.useCustomRulesFile = result.rulesFilePath !== AGENTS_RULES_FILE;
    settings.rulesFilePath = result.rulesFilePath;
    await this.plugin.saveSettings(true);
    return { summary: result.summary, rulesFilePath: result.rulesFilePath };
  }

  async calibrateRawDigestStatus(): Promise<KnowledgeBaseRunResult> {
    if (this.running) {
      new Notice("知识库维护正在运行");
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        error: "已有任务正在运行"
      };
    }
    this.running = true;
    this.cancelRequested = false;
    const startedAt = Date.now();
    const settings = this.plugin.settings.knowledgeBase;
    const processedSourcesBeforeRun = cloneProcessedSources(settings.processedSources);
    let vaultPath = "";
    try {
      vaultPath = this.plugin.getVaultPath();
      settings.lastRunStatus = "running";
      settings.lastError = "";
      settings.lastSummary = "";
      settings.lastRunAt = startedAt;
      await this.plugin.saveSettings(true);
      const result = await runRawDigestCalibration({
        vaultPath,
        startedAt,
        processedSources: settings.processedSources,
        checkCanceled: () => {
          throwIfKnowledgeBaseCanceled(this.cancelRequested);
        },
        writeTracker: async (processed, updatedAt) => {
          throwIfKnowledgeBaseCanceled(this.cancelRequested);
          await writeKnowledgeBaseTracker(vaultPath, processed, updatedAt);
          throwIfKnowledgeBaseCanceled(this.cancelRequested);
        },
        commit: async (commit) => {
          throwIfKnowledgeBaseCanceled(this.cancelRequested);
          settings.processedSources = commit.nextProcessedSources;
          settings.lastRunStatus = "success";
          settings.lastReportPath = commit.reportPath;
          settings.lastSummary = commit.summary;
          settings.lastRunAt = Date.now();
          await this.plugin.saveSettings(true);
          throwIfKnowledgeBaseCanceled(this.cancelRequested);
        }
      });
      new Notice("Raw 状态校准完成");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canceled = this.cancelRequested || isKnowledgeBaseCancelError(message);
      settings.processedSources = processedSourcesBeforeRun;
      settings.lastRunStatus = canceled ? "canceled" : "failed";
      settings.lastError = canceled ? formatCancelResultMessage(message, null) : message;
      settings.lastSummary = "";
      const saveError = await saveSettingsSafely(this.plugin);
      if (canceled && saveError) {
        settings.lastError = formatCancelResultMessage(message, saveError);
        await saveSettingsSafely(this.plugin);
      }
      return {
        status: canceled ? "canceled" : "failed",
        reportPath: "",
        summary: "",
        processedSources: [],
        error: settings.lastError
      };
    } finally {
      this.running = false;
      this.cancelRequested = false;
      if (vaultPath) {
        try {
          this.refreshKnowledgeBaseSurfaces();
        } catch (error) {
          console.warn("知识库仪表盘刷新失败", error);
        }
      }
    }
  }

  async runMaintenance(mode: KnowledgeBaseRunMode = "maintain", userRequest = "", turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseRunResult> {
    return this.maintenanceRunner.runMaintenance(mode, userRequest, turnOptionOverrides);
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
  }

  private finishKnowledgeBaseRun(): void {
    this.activeCodexRun = null;
    this.activeOpenCode = null;
    this.activeHermes = null;
    this.running = false;
    this.cancelRequested = false;
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库面板刷新失败", error);
    }
  }

  handleCodexNotification(notification: CodexNotification): boolean {
    const waiter = this.codexWaiter;
    if (!waiter) return false;
    const { method, params } = notification;
    const ids = extractKnowledgeBaseNotificationIds(params);
    const route = routeKnowledgeBaseCodexNotification(method, params, {
      threadId: waiter.threadId,
      turnId: waiter.turnId,
      itemIds: waiter.itemIds
    });
    const retryingError = method === "error" && isRetryingCodexError(params);
    if (!route.swallow) {
      if (retryingError && waiter.startTurnPending && ids.threadId === waiter.threadId) {
        this.markCodexWaiterActivity(waiter);
        return true;
      }
      return false;
    }
    this.markCodexWaiterActivity(waiter);
    if (method === "turn/started" && ids.turnId) waiter.turnId = ids.turnId;
    if (route.rememberItemId) waiter.itemIds.add(route.rememberItemId);
    if (ids.itemId && ids.turnId && ids.turnId === waiter.turnId) waiter.itemIds.add(ids.itemId);
    if (route.collectAssistantDelta) appendCodexWaiterAssistantDelta(waiter, ids.itemId, codexNotificationDelta(params));
    if (method === "turn/completed") {
      if (waiter.startTurnPending) {
        waiter.pendingTerminal = { method, params };
        return true;
      }
      this.finishCodexWaiter(waiter, method, params);
    }
    if (method === "error") {
      if (retryingError) return true;
      if (waiter.startTurnPending) {
        waiter.pendingTerminal = { method, params };
        return true;
      }
      this.finishCodexWaiter(waiter, method, params);
    }
    return true;
  }

  private finishCodexWaiter(waiter: CodexKbWaiter, method: "turn/completed" | "error", params: unknown): void {
    if (method === "error" && isRetryingCodexError(params)) return;
    this.clearCodexWaiterTimer(waiter);
    if (this.codexWaiter === waiter) this.codexWaiter = null;
    if (method === "turn/completed" && codexNotificationTurnStatus(params) !== "failed") {
      if (this.cancelRequested) waiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else waiter.resolve(finalCodexWaiterAssistantText(waiter));
      return;
    }
    waiter.reject(new Error(this.formatCodexDiagnostic(formatKnowledgeBaseCodexFailureSignal(method, params, "Codex 知识库任务失败"), waiter.model)));
  }

  private markCodexWaiterActivity(waiter: CodexKbWaiter): void {
    if (waiter.startTurnPending || this.codexWaiter !== waiter) return;
    this.armCodexWaiterInactivityTimer(waiter);
  }

  private armCodexWaiterInactivityTimer(waiter: CodexKbWaiter): void {
    this.clearCodexWaiterTimer(waiter);
    waiter.inactivityTimer = setTimeout(() => {
      if (this.codexWaiter !== waiter) return;
      this.clearCodexWaiterTimer(waiter);
      this.codexWaiter = null;
      const threadId = waiter.threadId;
      const turnId = waiter.turnId;
      if (this.activeCodexRun?.threadId === threadId && this.activeCodexRun.turnId === turnId) {
        this.activeCodexRun = null;
      }
      if (threadId && turnId) {
        void this.plugin.codex?.interruptTurn(threadId, turnId).catch(swallowError("interrupt inactive knowledge base Codex turn"));
      }
      waiter.reject(new Error(`长时间没有收到 Codex 终态（${formatDurationForError(waiter.inactivityTimeoutMs)}），已请求中断。`));
    }, Math.max(1, waiter.inactivityTimeoutMs));
  }

  private clearCodexWaiterTimer(waiter: CodexKbWaiter): void {
    if (!waiter.inactivityTimer) return;
    clearTimeout(waiter.inactivityTimer);
    waiter.inactivityTimer = null;
  }

  async archivePendingCodexKnowledgeThreads(): Promise<number> {
    return this.managedThreads.archivePending({
      recoverStaleReason: !this.running && !this.codexWaiter && !this.activeCodexRun && !this.activeOpenCode && !this.activeHermes
        ? "归档前恢复遗留 running 状态"
        : undefined
    });
  }

  private recoverPersistedRunState(reason: string): number {
    const settings = this.plugin.settings.knowledgeBase;
    let recovered = this.managedThreads.recoverStaleRunning(reason);
    if (settings.lastRunStatus === "running") {
      settings.lastRunStatus = "failed";
      settings.lastError = appendKnowledgeBaseWarning(settings.lastError, reason);
      settings.lastSummary = "";
      recovered += 1;
    }
    if (settings.lastScheduledRunStatus === "running") {
      settings.lastScheduledRunStatus = "failed";
      settings.lastError = appendKnowledgeBaseWarning(settings.lastError, reason);
      recovered += 1;
    }
    return recovered;
  }

  private async runKnowledgeAgentTask(input: {
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
  }): Promise<string> {
    const backend = this.resolveKnowledgeBackend();
    const resources = this.prepareKnowledgeAgentResources(backend);
    const toolBridge = backend === "codex-cli" ? null : await this.prepareKnowledgeAgentToolBridge();
    const prompt = buildPromptWithPreparedResources(input.prompt, resources);
    if (backend === "opencode") {
      return await this.runOpenCodeKnowledgeTask(prompt, input.sources, input.permission, resources, toolBridge, input.turnOptionOverrides);
    }
    if (backend === "hermes") {
      return await this.runHermesKnowledgeTask(input.prompt, input.sources, input.permission, resources, toolBridge, input.turnOptionOverrides);
    }
    return await this.runCodexKnowledgeTask(
      prompt,
      input.sources,
      input.permission === "read-only" && input.codexWriteScope !== "knowledge-lint" ? "read-only" : "workspace-write",
      input.codexWriteScope,
      input.turnOptionOverrides,
      input.managedKind
    );
  }

  private prepareKnowledgeAgentResources(backend: AgentBackendKind): PreparedAgentResources {
    const catalog = buildEchoInkResourceCatalog({ settings: this.plugin.settings.resources });
    return prepareAgentResources(catalog, {
      scope: "knowledge",
      backendCapabilities: getAgentBackendDefinition(backend).capabilities,
      enabledByScope: this.plugin.settings.resources.enabledByScope,
      mcpConnections: this.plugin.settings.resources.mcpConnections
    });
  }

  private async prepareKnowledgeAgentToolBridge(): Promise<AgentToolBridgeRuntime | null> {
    const resourceSettings = this.plugin.settings.resources;
    const catalog = buildEchoInkResourceCatalog({ settings: resourceSettings });
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

  private async runCodexKnowledgeTask(
    prompt: string,
    sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    writeScope: "knowledge-base" | "knowledge-lint" | "journal" = "knowledge-base",
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides,
    managedKind: KnowledgeBaseManagedThreadKind = "unknown"
  ): Promise<string> {
    let status = await this.plugin.ensureCodexConnected(false, { silent: true });
    if (!status.connected) {
      status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
    }
    if (!status.connected || !this.plugin.codex) throw new Error(this.formatCodexDiagnostic(status.errors[0] || "Codex 未连接", this.plugin.settings.defaultModel));
    throwIfKnowledgeBaseCanceled(this.cancelRequested);
    const options = buildCodexKnowledgeTurnOptions({
      settings: this.plugin.settings,
      availableModels: status.models,
      vaultPath: this.plugin.getVaultPath(),
      permission,
      writeScope,
      overrides: turnOptionOverrides
    });
    let started: { threadId: string; title: string };
    try {
      started = await this.plugin.codex.startThread(options);
    } catch (error) {
      status = await this.plugin.ensureCodexConnected(true, { silent: true }).catch(() => status);
      if (!status.connected || !this.plugin.codex) throw error;
      started = await this.plugin.codex.startThread(options);
    }
    const managedRunId = this.managedThreads.remember(started.threadId, managedKind);
    await this.plugin.codex.setThreadName?.(started.threadId, `Codex EchoInk KB: ${managedKind}`).catch(swallowError("rename knowledge base Codex thread"));
    throwIfKnowledgeBaseCanceled(this.cancelRequested);
    const inactivityTimeoutMs = normalizeCodexInactivityTimeoutMs(turnOptionOverrides?.codexInactivityTimeoutMs);
    let waiterRef: CodexKbWaiter | null = null;
    const result = new Promise<string>((resolve, reject) => {
      waiterRef = { threadId: started.threadId, turnId: "", itemIds: new Set<string>(), assistantItems: new Map<string, string>(), assistantItemOrder: [], resolve, reject, model: options.model, startTurnPending: true, inactivityTimeoutMs, inactivityTimer: null };
      this.codexWaiter = waiterRef;
    });
    try {
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      let startTurnAbandoned = false;
      let cancelStartTurn: ((error: Error) => void) | null = null;
      const cancelStartTurnPromise = new Promise<never>((_, reject) => {
        cancelStartTurn = (error: Error) => {
          startTurnAbandoned = true;
          reject(error);
        };
      });
      this.activeCodexRun = { threadId: started.threadId, turnId: "", cancel: cancelStartTurn ?? undefined };
      const startTurnPromise = this.plugin.codex.startTurn(started.threadId, buildCodexKnowledgeInput(prompt, sources), options).then((turnId) => {
        if (startTurnAbandoned) void this.plugin.codex?.interruptTurn(started.threadId, turnId).catch(swallowError("interrupt abandoned knowledge base Codex turn"));
        return turnId;
      });
      const turnId = await rejectAfterTimeout(
        Promise.race([startTurnPromise, cancelStartTurnPromise]),
        inactivityTimeoutMs,
        () => { startTurnAbandoned = true; },
        `长时间没有收到 Codex turn id（${formatDurationForError(inactivityTimeoutMs)}），已结束本轮知识库任务。`
      );
      this.activeCodexRun = { threadId: started.threadId, turnId };
      if (this.codexWaiter) {
        const waiter = this.codexWaiter;
        if (waiter.turnId && waiter.turnId !== turnId) {
          waiter.itemIds.clear();
          waiter.assistantItems.clear();
          waiter.assistantItemOrder = [];
          waiter.pendingTerminal = undefined;
        }
        waiter.turnId = turnId;
        waiter.startTurnPending = false;
        const pendingTerminal = waiter.pendingTerminal;
        waiter.pendingTerminal = undefined;
        if (pendingTerminal) this.finishCodexWaiter(waiter, pendingTerminal.method, pendingTerminal.params);
        else this.armCodexWaiterInactivityTimer(waiter);
      }
      if (this.cancelRequested) {
        await this.plugin.codex.interruptTurn(started.threadId, turnId).catch(swallowError("interrupt canceled knowledge base Codex turn"));
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
    } catch (error) {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      this.codexWaiter = null;
      this.managedThreads.markPendingArchive(started.threadId, managedRunId);
      throw error;
    }
    try {
      return await result;
    } finally {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      if (this.codexWaiter === waiterRef) this.codexWaiter = null;
      this.managedThreads.markPendingArchive(started.threadId, managedRunId);
    }
  }

  private async runOpenCodeKnowledgeTask(
    prompt: string,
    sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    const runtime = this.createKnowledgeAgentRuntime("opencode");
    try {
      await runtime.connect();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      const models = await runtime.listModels();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const parts = buildOpenCodeKnowledgeParts(prompt, sources);
      const selectedModel = selectOpenCodeModel(models, this.plugin.settings.opencode.providerId, this.plugin.settings.opencode.modelId, requiredModalities(parts));
      ensureOpenCodeModelSupportsFiles(selectedModel, parts);
      if (selectedModel) {
        this.plugin.settings.opencode.providerId = selectedModel.providerId;
        this.plugin.settings.opencode.modelId = selectedModel.modelId;
        this.plugin.settings.opencode.textEnabled = selectedModel.inputModalities.includes("text");
        this.plugin.settings.opencode.imageEnabled = selectedModel.inputModalities.includes("image");
        this.plugin.settings.opencode.pdfEnabled = selectedModel.inputModalities.includes("pdf");
      }
      await this.plugin.saveSettings();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      return await this.sendOpenCodeTaskWithGuards(runtime, {
        prompt,
        sources: parts.filter((part) => part.type === "file"),
        permission,
        resources,
        toolBridge,
        timeoutMs: normalizeOpenCodeTaskTimeoutMs(turnOptionOverrides?.opencodeTaskTimeoutMs),
        agent: this.plugin.settings.opencode.agent,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        tools: {
          write: permission !== "read-only",
          edit: permission !== "read-only",
          read: true,
          bash: false
        }
      }, normalizeOpenCodeTaskTimeoutMs(turnOptionOverrides?.opencodeTaskTimeoutMs));
    } catch (error) {
      if (!this.cancelRequested && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.plugin.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  private async runHermesKnowledgeTask(
    prompt: string,
    _sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    const runtime = this.createKnowledgeAgentRuntime("hermes");
    try {
      const status = await runtime.connect();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const hermes = this.plugin.settings.agents.hermes;
      hermes.lastConnectedAt = Date.now();
      hermes.lastError = "";
      if (status.version) hermes.version = status.version;
      const models = await runtime.listModels();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const selectedModel = selectAgentModel(models, hermes.providerId, hermes.modelId);
      if (selectedModel) {
        hermes.providerId = selectedModel.providerId;
        hermes.modelId = selectedModel.modelId;
      }
      await this.plugin.saveSettings();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      return await this.sendHermesTaskWithGuards(runtime, {
        prompt,
        permission,
        resources,
        toolBridge,
        timeoutMs: normalizeHermesTaskTimeoutMs(turnOptionOverrides?.hermesTaskTimeoutMs),
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {}),
        profile: hermes.profile,
        tools: {
          write: permission !== "read-only",
          edit: permission !== "read-only",
          read: true,
          bash: false
        }
      }, normalizeHermesTaskTimeoutMs(turnOptionOverrides?.hermesTaskTimeoutMs));
    } catch (error) {
      if (!this.cancelRequested && !isKnowledgeBaseCancelError(error instanceof Error ? error.message : String(error))) {
        this.plugin.settings.agents.hermes.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      await runtime.disconnect?.();
    }
  }

  private createKnowledgeAgentRuntime(backend: AgentBackendKind): AgentTaskRuntime {
    return createAgentTaskRuntime({
      backend,
      settings: this.plugin.settings,
      vaultPath: this.plugin.getVaultPath(),
      codexBackend: this.plugin.codex ?? undefined
    });
  }

  private async sendHermesTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    return this.sendAgentTaskWithGuards("hermes", runtime, input, timeoutMs);
  }

  private async sendOpenCodeTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    return this.sendAgentTaskWithGuards("opencode", runtime, input, timeoutMs);
  }

  private async sendAgentTaskWithGuards(backend: GuardedAgentBackend, runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    const abortController = new AbortController();
    const activeRun: GuardedAgentRun = backend === "hermes"
      ? { runtime, runId: `hermes-${Date.now()}`, abortController }
      : { runtime, runId: "" };
    const backendLabel = backend === "hermes" ? "Hermes" : "OpenCode";
    let lastPhase = "starting";
    this.setActiveGuardedRun(backend, activeRun);
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.clearActiveGuardedRun(backend, activeRun);
        activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(error));
      timer = setTimeout(() => {
        abortController.abort();
        const timeoutError = new Error(formatAgentTaskFailureContext({
          backend,
          phase: lastPhase,
          runId: activeRun.runId,
          message: `${backendLabel} 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        }));
        if (backend === "hermes" || activeRun.runId) {
          void runtime.abort(activeRun.runId).catch(swallowError(`abort timed out ${backend} knowledge base run`));
          fail(timeoutError);
          return;
        }
        setTimeout(() => {
          if (activeRun.runId) void runtime.abort(activeRun.runId).catch(swallowError(`abort delayed ${backend} knowledge base run`));
          fail(timeoutError);
        }, 20);
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        abortController.abort();
        if (backend === "hermes" || activeRun.runId) void runtime.abort(activeRun.runId).catch(swallowError(`abort canceled ${backend} knowledge base run`));
        fail(error);
      };
      try {
        runKnowledgeAgentTask(runtime, {
          ...input,
          abortSignal: abortController.signal,
          onRunId: (runId) => {
            activeRun.runId = runId;
            input.onRunId?.(runId);
          }
        }, (event) => {
          lastPhase = event.type;
          if (event.runId) activeRun.runId = event.runId;
        }).then(
          (output) => finish(() => resolve(output.text)),
          (error) => fail(formatAgentTaskGuardError(backend, lastPhase, activeRun.runId, error))
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private setActiveGuardedRun(backend: GuardedAgentBackend, activeRun: GuardedAgentRun): void {
    if (backend === "hermes") {
      this.activeHermes = activeRun as ActiveHermesRun;
      return;
    }
    this.activeOpenCode = activeRun as ActiveOpenCodeRun;
  }

  private clearActiveGuardedRun(backend: GuardedAgentBackend, activeRun: GuardedAgentRun): void {
    if (backend === "hermes") {
      if (this.activeHermes === activeRun) this.activeHermes = null;
      return;
    }
    if (this.activeOpenCode === activeRun) this.activeOpenCode = null;
  }

  private resolveKnowledgeBackend(): AgentBackendKind {
    const configured = this.plugin.settings.knowledgeBase.backend;
    return configured === "default" ? this.plugin.settings.agentBackend : configured;
  }

  private formatFailureContext(reportPath = ""): string {
    const backend = this.resolveKnowledgeBackend();
    const opencode = this.plugin.settings.opencode;
    const kb = this.plugin.settings.knowledgeBase;
    return [
      `后端：${backend}`,
      backend === "opencode" && opencode.providerId && opencode.modelId ? `模型：${opencode.providerId}/${opencode.modelId}` : "",
      backend === "hermes" && this.plugin.settings.agents.hermes.providerId && this.plugin.settings.agents.hermes.modelId
        ? `模型：${this.plugin.settings.agents.hermes.providerId}/${this.plugin.settings.agents.hermes.modelId}`
        : "",
      `规则文件：${kb.useCustomRulesFile ? kb.rulesFilePath : AGENTS_RULES_FILE}`,
      reportPath ? `报告：${reportPath}` : ""
    ].filter(Boolean).join("\n");
  }

  private formatCodexDiagnostic(error: unknown, model: string): string {
    return diagnoseCodexError(error, {
      model,
      providerLabel: providerConnectionLabel(this.plugin.settings),
      proxyEnabled: this.plugin.settings.proxyEnabled,
      proxyUrl: this.plugin.settings.proxyUrl
    }).text;
  }

  private async resolveRulesFile(): Promise<{ relativePath: string; absolutePath: string; exists: boolean; useCustomRulesFile: boolean }> {
    const settings = this.plugin.settings.knowledgeBase;
    const relativePath = normalizeRulesPath(settings.useCustomRulesFile ? settings.rulesFilePath : AGENTS_RULES_FILE);
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

  private async appendScheduledMaintenanceMessage(result: KnowledgeBaseRunResult): Promise<void> {
    await appendScheduledMaintenanceMessageToSession(this.plugin, result, async () => {
      await this.archivePendingCodexKnowledgeThreads();
    });
  }

  async captureText(target: "inbox" | "raw-articles"): Promise<void> {
    await this.captureService.captureText(target);
  }

  async captureWeChatArticle(): Promise<string[]> {
    return this.captureService.captureWeChatArticle();
  }

  async captureWebPage(): Promise<string[]> {
    return this.captureService.captureWebPage();
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return this.captureService.captureExternalFiles(files);
  }

  private async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[]): Promise<string[]> {
    return this.captureService.captureChatInput(target, text, attachments);
  }

  async captureActiveAttachment(): Promise<void> {
    await this.captureService.captureActiveAttachment();
  }
}

function isRetryingCodexError(params: unknown): boolean {
  const record = codexNotificationRecord(params);
  const error = codexNotificationRecord(record.error);
  return record.willRetry === true || error.willRetry === true;
}

function codexNotificationDelta(params: unknown): string {
  const delta = codexNotificationRecord(params).delta;
  return typeof delta === "string" ? delta : "";
}

function codexNotificationTurnStatus(params: unknown): string {
  const turn = codexNotificationRecord(codexNotificationRecord(params).turn);
  return typeof turn.status === "string" ? turn.status : "";
}

function codexNotificationRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
}

function appendCodexWaiterAssistantDelta(waiter: CodexKbWaiter, itemId: string, delta: string): void {
  if (!delta) return;
  const id = itemId || "__assistant__";
  if (!waiter.assistantItems.has(id)) waiter.assistantItemOrder.push(id);
  waiter.assistantItems.set(id, `${waiter.assistantItems.get(id) ?? ""}${delta}`);
}

function finalCodexWaiterAssistantText(waiter: CodexKbWaiter): string {
  for (let index = waiter.assistantItemOrder.length - 1; index >= 0; index -= 1) {
    const text = (waiter.assistantItems.get(waiter.assistantItemOrder[index]) ?? "").trim();
    if (text) return text;
  }
  return "";
}

function dashboardSnapshotSignature(settings: CodexForObsidianPlugin["settings"]["knowledgeBase"]): string {
  return [
    settings.lastRunAt,
    settings.lastRunStatus,
    settings.lastScheduledRunAt,
    settings.lastScheduledRunStatus,
    settings.lastReportPath,
    settings.lastError,
    Object.keys(settings.processedSources ?? {}).length,
    (settings.healthHistory ?? []).length,
    (settings.maintenanceHistory ?? []).length,
    Object.keys(settings.managedThreads ?? {}).length,
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
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/") || AGENTS_RULES_FILE;
}
