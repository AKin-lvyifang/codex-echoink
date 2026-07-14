import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getAgentBackendDefinition } from "../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import type { AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind } from "../agent/types";
import { harnessKnowledgePromptUsesPreparedResources, harnessKnowledgeTaskPermission, harnessKnowledgeUsesEchoInkToolBridge, harnessMessageModelId } from "../harness/agents/backend-runtime-profile";
import { buildCallableMcpToolCatalog } from "../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources } from "../resources/registry";
import type { KnowledgeBaseManagedThreadKind, ReviewReportKind, StoredAttachment } from "../settings/settings";
import type { PermissionMode } from "../types/app-server";
import { handleKnowledgeBaseUserMessage, type KnowledgeBaseChatResult, type KnowledgeBaseTurnOptionOverrides } from "./command-router";
import {
  buildPromptWithPreparedResources,
  type KnowledgeAgentTaskOutput
} from "./agent-runner";
import { AGENTS_RULES_FILE } from "./constants";
import { KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { KnowledgeBaseScheduler } from "./scheduler";
import { appendScheduledMaintenanceMessage as appendScheduledMaintenanceMessageToSession } from "./scheduled-maintenance";
import {
  appendKnowledgeBaseWarning,
  saveSettingsSafely,
} from "./maintenance";
import type { KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";
import { KnowledgeBaseCaptureService } from "./capture";
import { KnowledgeBaseQueryJournalService } from "./query-journal";
import { KnowledgeBaseMaintenanceRunner } from "./maintenance-runner";
import { KnowledgeBaseAgentTaskService } from "./agent-task-service";
import { KnowledgeBaseRawDigestCalibrationRunner } from "./raw-digest-calibration-runner";
import { exists } from "./utils";
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5000;

export class KnowledgeBaseManager {
  private running = false;
  private readonly scheduler: KnowledgeBaseScheduler;
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly queryJournalService: KnowledgeBaseQueryJournalService;
  private readonly maintenanceRunner: KnowledgeBaseMaintenanceRunner;
  private readonly agentTaskService: KnowledgeBaseAgentTaskService;
  private readonly rawDigestCalibrationRunner: KnowledgeBaseRawDigestCalibrationRunner;
  private cancelRequested = false;
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
    const recoveryReason = "插件重新加载后，上次知识库任务没有正常结束，已恢复为空闲状态。";
    const recovered = this.recoverPersistedRunState(recoveryReason);
    void (async () => {
      if (recovered) await saveSettingsSafely(this.plugin, { flushKnowledgeBaseHistory: false });
      await this.plugin.failPendingNativeExecutionsForRecovery({
        reason: recoveryReason,
        surface: "knowledge"
      });
    })().catch((error) => console.error("EchoInk knowledge recovery failed", error));
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

  async unload(): Promise<void> {
    this.scheduler.unload();
    await this.agentTaskService.unload();
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
    if (!this.running && !this.agentTaskService.hasActiveTask) {
      new Notice("当前没有知识库任务");
      return;
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
    new Notice("已取消知识库任务");
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
    return this.rawDigestCalibrationRunner.calibrateRawDigestStatus();
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
    this.agentTaskService.clearActiveRuns();
    this.running = false;
    this.cancelRequested = false;
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库面板刷新失败", error);
    }
  }

  private finishRawDigestCalibrationRun(refreshSurfaces: boolean): void {
    this.running = false;
    this.cancelRequested = false;
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

  async settlePendingKnowledgeBaseNativeExecutions(): Promise<number> {
    return await this.agentTaskService.settlePendingNativeExecutions();
  }

  getLastNativeLifecycleSummary() {
    return this.agentTaskService.getLastNativeLifecycleSummary();
  }

  private recoverPersistedRunState(reason: string): number {
    const settings = this.plugin.settings.knowledgeBase;
    let recovered = 0;
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
  }): Promise<KnowledgeAgentTaskOutput> {
    const backend = this.resolveKnowledgeBackend();
    const resources = await this.prepareKnowledgeAgentResources(backend);
    const toolBridge = harnessKnowledgeUsesEchoInkToolBridge(backend) ? await this.prepareKnowledgeAgentToolBridge() : null;
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
      toolBridge
    });
  }

  private async prepareKnowledgeAgentResources(backend: AgentBackendKind): Promise<PreparedAgentResources> {
    const catalog = await this.runtimeEchoInkResourceCatalog();
    return prepareAgentResources(catalog, {
      scope: "knowledge",
      backendCapabilities: getAgentBackendDefinition(backend).capabilities,
      enabledByScope: this.plugin.settings.resources.enabledByScope,
      mcpConnections: this.plugin.settings.resources.mcpConnections
    });
  }

  private async prepareKnowledgeAgentToolBridge(): Promise<AgentToolBridgeRuntime | null> {
    const resourceSettings = this.plugin.settings.resources;
    const catalog = await this.runtimeEchoInkResourceCatalog();
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
      buildRuntimeEchoInkResourceCatalog?: () => Promise<ReturnType<typeof buildEchoInkResourceCatalog>>;
    };
    return typeof plugin.buildRuntimeEchoInkResourceCatalog === "function"
      ? await plugin.buildRuntimeEchoInkResourceCatalog()
      : buildEchoInkResourceCatalog({ settings: this.plugin.settings.resources });
  }

  private resolveKnowledgeBackend(): AgentBackendKind {
    const configured = this.plugin.settings.knowledgeBase.backend;
    return configured === "default" ? this.plugin.settings.agentBackend : configured;
  }

  private formatFailureContext(reportPath = ""): string {
    const backend = this.resolveKnowledgeBackend();
    const kb = this.plugin.settings.knowledgeBase;
    const modelLabel = harnessMessageModelId(this.plugin.settings, backend);
    return [
      `后端：${backend}`,
      modelLabel ? `模型：${modelLabel}` : "",
      `规则文件：${kb.useCustomRulesFile ? kb.rulesFilePath : AGENTS_RULES_FILE}`,
      reportPath ? `报告：${reportPath}` : ""
    ].filter(Boolean).join("\n");
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

  async captureLink(): Promise<string[]> {
    return this.captureService.captureLink();
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
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/") || AGENTS_RULES_FILE;
}
