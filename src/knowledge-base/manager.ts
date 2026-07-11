import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createAgentTaskRuntime } from "../agent/factory";
import { getAgentBackendDefinition } from "../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import type { AgentTaskRuntime, AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind } from "../agent/types";
import { OpenCodeBackend } from "../core/opencode-backend";
import { buildCallableMcpToolCatalog } from "../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources } from "../resources/registry";
import type { KnowledgeBaseManagedThreadKind, ReviewReportKind, StoredAttachment } from "../settings/settings";
import type { CodexNotification, PermissionMode } from "../types/app-server";
import { handleKnowledgeBaseUserMessage, type KnowledgeBaseChatResult, type KnowledgeBaseTurnOptionOverrides } from "./command-router";
import {
  buildPromptWithPreparedResources,
  selectOpenCodeModel
} from "./agent-runner";
import { AGENTS_RULES_FILE } from "./constants";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { runRawDigestCalibration } from "./raw-calibration";
import { KnowledgeBaseScheduler } from "./scheduler";
import { appendScheduledMaintenanceMessage as appendScheduledMaintenanceMessageToSession } from "./scheduled-maintenance";
import {
  appendKnowledgeBaseWarning,
  cloneProcessedSources,
  formatCancelResultMessage,
  saveSettingsSafely,
  writeKnowledgeBaseTracker
} from "./maintenance";
import type { KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";
import { KnowledgeBaseCaptureService } from "./capture";
import { KnowledgeBaseManagedThreadStore } from "./managed-threads";
import { KnowledgeBaseQueryJournalService } from "./query-journal";
import { KnowledgeBaseMaintenanceRunner } from "./maintenance-runner";
import { KnowledgeBaseAgentTaskService } from "./agent-task-service";
import { exists } from "./utils";
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5000;

export class KnowledgeBaseManager {
  private running = false;
  private readonly scheduler: KnowledgeBaseScheduler;
  private readonly captureService: KnowledgeBaseCaptureService;
  private readonly queryJournalService: KnowledgeBaseQueryJournalService;
  private readonly managedThreads: KnowledgeBaseManagedThreadStore;
  private readonly maintenanceRunner: KnowledgeBaseMaintenanceRunner;
  private readonly agentTaskService: KnowledgeBaseAgentTaskService;
  private cancelRequested = false;
  private dashboardSnapshotCache: { snapshot: KnowledgeBaseDashboardSnapshot; savedAt: number; signature: string } | null = null;
  private dashboardSnapshotPromise: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
    this.managedThreads = new KnowledgeBaseManagedThreadStore(plugin);
    this.agentTaskService = new KnowledgeBaseAgentTaskService(plugin, this.managedThreads, {
      isCancelRequested: () => this.cancelRequested,
      createKnowledgeAgentRuntime: (backend) => this.createKnowledgeAgentRuntime(backend)
    });
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
    this.agentTaskService.unload();
    this.cancelRequested = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private get codexWaiter(): unknown {
    return this.agentTaskService.codexWaiter;
  }

  private get activeCodexRun(): unknown {
    return this.agentTaskService.activeCodexRun;
  }

  private get activeOpenCode(): unknown {
    return this.agentTaskService.activeOpenCode;
  }

  private get activeHermes(): unknown {
    return this.agentTaskService.activeHermes;
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
    this.agentTaskService.clearActiveRuns();
    this.running = false;
    this.cancelRequested = false;
    try {
      this.refreshKnowledgeBaseSurfaces();
    } catch (error) {
      console.warn("知识库面板刷新失败", error);
    }
  }

  handleCodexNotification(notification: CodexNotification): boolean {
    return this.agentTaskService.handleCodexNotification(notification);
  }

  async archivePendingCodexKnowledgeThreads(): Promise<number> {
    return this.managedThreads.archivePending({
      recoverStaleReason: !this.running && !this.agentTaskService.hasActiveTask
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
    return this.agentTaskService.runCodexKnowledgeTask(prompt, sources, permission, writeScope, turnOptionOverrides, managedKind);
  }

  private async runOpenCodeKnowledgeTask(
    prompt: string,
    sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    return this.agentTaskService.runOpenCodeKnowledgeTask(prompt, sources, permission, resources, toolBridge, turnOptionOverrides);
  }

  private async runHermesKnowledgeTask(
    prompt: string,
    _sources: KnowledgeBaseSource[],
    permission: PermissionMode = "workspace-write",
    resources?: PreparedAgentResources,
    toolBridge?: AgentToolBridgeRuntime | null,
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    return this.agentTaskService.runHermesKnowledgeTask(prompt, _sources, permission, resources, toolBridge, turnOptionOverrides);
  }

  private createKnowledgeAgentRuntime(backend: AgentBackendKind): AgentTaskRuntime {
    return createAgentTaskRuntime({
      backend,
      settings: this.plugin.settings,
      vaultPath: this.plugin.getVaultPath(),
      codexBackend: this.plugin.codex ?? undefined
    });
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
