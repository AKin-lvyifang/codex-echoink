import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { Notice, normalizePath, requestUrl, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createAgentTaskRuntime } from "../agent/factory";
import { getAgentBackendDefinition } from "../agent/registry";
import { createEchoInkMcpToolBridgeRuntime } from "../agent/tool-bridge";
import type { AgentTaskRuntime, AgentToolBridgeRuntime, PreparedAgentResources } from "../agent/runtime";
import type { AgentBackendKind, AgentTaskInput } from "../agent/types";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import type { TurnOptions } from "../core/codex-service";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles } from "../core/opencode-models";
import { resolveRawRef } from "../core/raw-message-store";
import { buildCallableMcpToolCatalog } from "../resources/mcp-tool-catalog";
import { buildEchoInkResourceCatalog, prepareAgentResources } from "../resources/registry";
import { ensureKnowledgeBaseSession, newId, providerConnectionLabel, recordKnowledgeBaseMaintenanceRun, type ChatMessage, type KnowledgeBaseManagedThreadKind, type KnowledgeBaseProcessedSource, type ReviewReportKind, type StoredAttachment, type StoredSession } from "../settings/settings";
import type { CodexNotification, PermissionMode } from "../types/app-server";
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
import { knowledgeBaseHelpText, parseKnowledgeBaseCommand } from "./commands";
import { AGENTS_RULES_FILE } from "./constants";
import { extractKnowledgeBaseNotificationIds, routeKnowledgeBaseCodexNotification } from "./codex-route";
import { transactionSnapshotExistingSourceEvidencePaths, transactionSnapshotRepairableExistingSourceEvidencePaths, verifyDigestEvidence } from "./digest-evidence";
import { formatAgentTaskFailureContext, formatKnowledgeBaseCodexFailureSignal, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { ensureKnowledgeBaseFallbackReport, isLintOnlyKnowledgeBaseReport, readFreshKnowledgeBaseReportExcerpt, readKnowledgeBaseReportExcerpt, readKnowledgeBaseReportMtime, readKnowledgeBaseReportText, recoveredLintReportSummary, writeKnowledgeBaseFailureReport, writeKnowledgeBaseReportFile } from "./report";
import { SUPPORTED_RAW_EXTENSIONS, discoverKnowledgeBaseSources } from "./discovery";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { buildKnowledgeBaseJournalPrompt, ensureJournalTargetFolders, resolveJournalDailyTarget, stripJournalPrefix } from "./journal";
import { buildKnowledgeBaseAskPrompt, buildKnowledgeBasePrompt } from "./prompt";
import { buildKnowledgeBaseCitationSummary, findKnowledgeBaseAskMatches, stripAskCommand } from "./query";
import { applyRawDigestFrontmatter, applyRawDigestStatusFrontmatter, isRawMarkdownPath, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry, RAW_DIGEST_REGISTRY_PATH, RAW_DIGEST_STATUS_DIGESTED, RAW_DIGEST_STATUS_PENDING_CALIBRATION, RAW_DIGEST_STATUS_PENDING_REINGEST, writeRawDigestRegistry, type RawDigestConfidence, type RawDigestRegistryEntry } from "./raw-digest";
import { classifyRawSnapshotChanges, contentFingerprint, fingerprintRawContentSnapshot, formatRawIntegrityError, isRawIntegrityErrorMessage, rawSnapshotChangeMessages, restoreRawMetadata, restoreRawSnapshot, snapshotRawFileContents, snapshotRawFiles } from "./raw-integrity";
import type { RawContentSnapshot, RawSnapshot } from "./raw-integrity";
import { KnowledgeBaseScheduler } from "./scheduler";
import { buildScheduledKnowledgeBaseMessage } from "./scheduled-message";
import { extractRequestedRawPaths, processedSourcesForRunMode, selectSourcesForRunMode } from "./source-selection";
import { buildKnowledgeBaseMaintainReportPayload, knowledgeBaseRunModeForCommandIntent, type KnowledgeBaseMessageUiPayload } from "./maintain-report-card";
import { normalizeKnowledgeBaseStructure, rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import {
  assertSafeKnowledgeTransactionCurrentState,
  assertSafeKnowledgeTransactionRoots,
  commitLintReportOnly,
  knowledgeTransactionRootsForMode,
  quarantinePreexistingKnowledgeConflictDuplicates,
  restoreKnowledgeTransactionOnFailure,
  restoreOptionalFile,
  snapshotKnowledgeTransaction,
  snapshotOptionalFile,
  writeFileAtomic,
  type KnowledgeConflictDuplicateCleanup,
  type KnowledgeTransactionSnapshot,
  type OptionalFileSnapshot
} from "./transaction-snapshot";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseCitationSummary, KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource, StructureNormalizationPathRewrite, StructureNormalizationResult } from "./types";
import { extractArticleMarkdown, extractFirstUrl, isHtmlVerificationBlocked, isWeChatUrl, sanitizeWebCaptureFileName, stripCollectPrefix } from "./web-capture";

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
  pendingTerminal?: { method: "turn/completed" | "error"; params: any };
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

export interface KnowledgeBaseChatResult {
  status: "success" | "failed" | "canceled";
  message: string;
  citations?: KnowledgeBaseCitationSummary;
  ui?: KnowledgeBaseMessageUiPayload;
  followUpCommand?: string;
}

export interface KnowledgeBaseTurnOptionOverrides extends Pick<TurnOptions, "model" | "reasoning" | "serviceTier" | "mcpEnabled" | "workspaceResources"> {
  codexInactivityTimeoutMs?: number;
  opencodeTaskTimeoutMs?: number;
  hermesTaskTimeoutMs?: number;
}

const MAX_ATTACHED_SOURCES = 20;
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 5000;
const KNOWLEDGE_FILE_CAPTURE_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".markdown", ".txt"]);

export class KnowledgeBaseManager {
  private running = false;
  private readonly scheduler: KnowledgeBaseScheduler;
  private codexWaiter: CodexKbWaiter | null = null;
  private activeCodexRun: { threadId: string; turnId: string; cancel?: (error: Error) => void } | null = null;
  private activeOpenCode: ActiveOpenCodeRun | null = null;
  private activeHermes: ActiveHermesRun | null = null;
  private cancelRequested = false;
  private dashboardSnapshotCache: { snapshot: KnowledgeBaseDashboardSnapshot; savedAt: number; signature: string } | null = null;
  private dashboardSnapshotPromise: Promise<KnowledgeBaseDashboardSnapshot> | null = null;

  constructor(private readonly plugin: CodexForObsidianPlugin) {
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
      await this.plugin.codex.interruptTurn(codexRun.threadId, codexRun.turnId).catch(() => undefined);
    }
    if (codexRun?.cancel) codexRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
    if (openCodeRun?.runId) {
      if (openCodeRun.cancel) openCodeRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void openCodeRun.runtime.abort(openCodeRun.runId).catch(() => undefined);
    }
    if (hermesRun?.runId) {
      hermesRun.abortController.abort();
      if (hermesRun.cancel) hermesRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void hermesRun.runtime.abort(hermesRun.runId).catch(() => undefined);
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
    const command = parseKnowledgeBaseCommand(text, attachments.length);
    try {
      if (command.intent === "help") {
        return { status: "success", message: knowledgeBaseHelpText() };
      }
      if (command.intent === "chat") {
        return { status: "success", message: "这条消息会按普通 Agent 对话处理；需要查询知识库时请使用 `/ask ...`。" };
      }
      if (command.intent === "init") {
        if (command.confirm) {
          const preview = await this.previewInitialization();
          const result = await this.executeInitialization(preview);
          return {
            status: "success",
            message: result.summary,
            followUpCommand: "/check 初始化后体检当前 vault，只报告问题，不移动文件，不删除文件。"
          };
        }
        const preview = await this.previewInitialization();
        return { status: "success", message: preview.summary };
      }
      if (command.intent === "cancel") {
        await this.cancelMaintenance();
        return { status: "success", message: "已请求取消当前知识库任务。" };
      }
      if (command.intent === "calibrate") {
        const result = await this.calibrateRawDigestStatus();
        if (result.status === "success") {
          return {
            status: "success",
            message: [
              "Raw 状态校准完成。",
              result.reportPath ? `报告：${result.reportPath}` : "",
              result.summary ? `\n${result.summary}` : ""
            ].filter(Boolean).join("\n"),
            ui: buildKnowledgeBaseMaintainReportPayload("calibrate", result)
          };
        }
        return {
          status: "failed",
          message: `Raw 状态校准失败：${result.error || "未知错误"}`,
          ui: buildKnowledgeBaseMaintainReportPayload("calibrate", result)
        };
      }
      if (command.intent === "lint" || command.intent === "maintain" || command.intent === "reingest" || command.intent === "process-outputs" || command.intent === "process-inbox") {
        const mode = command.intent === "process-inbox" ? "inbox" : command.intent === "process-outputs" ? "outputs" : command.intent;
        const result = await this.runMaintenance(mode, text, turnOptionOverrides);
        if (result.status === "success") {
          return {
            status: "success",
            message: [
              `知识库${labelForRunMode(mode)}完成。`,
              result.reportPath ? `报告：${result.reportPath}` : "",
              result.summary ? `\n${result.summary}` : ""
            ].filter(Boolean).join("\n"),
            ui: buildKnowledgeBaseMaintainReportPayload(mode, result)
          };
        }
        if (result.status === "canceled") {
          return {
            status: "canceled",
            message: [
              `知识库${labelForRunMode(mode)}已取消。`,
              result.error ? `原因：${result.error}` : "",
              result.reportPath ? `报告：${result.reportPath}` : ""
            ].filter(Boolean).join("\n"),
            ui: buildKnowledgeBaseMaintainReportPayload(mode, result)
          };
        }
        return {
          status: "failed",
          message: [
            `知识库${labelForRunMode(mode)}失败：${result.error || "未知错误"}`,
            this.formatFailureContext(result.reportPath)
          ].filter(Boolean).join("\n"),
          ui: buildKnowledgeBaseMaintainReportPayload(mode, result)
        };
      }
      if (command.intent === "ask") {
        return await this.answerQuestion(text, turnOptionOverrides);
      }
      if (command.intent === "review") {
        return await this.runWeeklyReview(command.reviewKind ?? "knowledge-base");
      }
      if (command.intent === "journal") {
        return await this.writeDailyJournal(text, attachments, turnOptionOverrides);
      }
      const target = command.target === "journal" ? "inbox" : command.target ?? (attachments.length ? "raw-attachments" : "inbox");
      const paths = await this.captureChatInput(target, text, attachments);
      return {
        status: "success",
        message: paths.length ? `已收集到：\n${paths.map((item) => `- ${item}`).join("\n")}` : "没有可收集的内容。"
      };
    } catch (error) {
      if (command.intent === "init") {
        this.plugin.settings.knowledgeBase.initialization.status = "failed";
        await this.plugin.saveSettings(true);
      }
      const message = error instanceof Error ? error.message : String(error);
      const mode = knowledgeBaseRunModeForCommandIntent(command.intent);
      if (mode) {
        return {
          status: "failed",
          message,
          ui: buildKnowledgeBaseMaintainReportPayload(mode, {
            status: "failed",
            reportPath: this.plugin.settings.knowledgeBase.lastReportPath || "",
            summary: "",
            processedSources: [],
            error: message
          })
        };
      }
      return {
        status: "failed",
        message
      };
    }
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
    let rawBeforeContents: RawContentSnapshot | null = null;
    let rawBefore: RawSnapshot = new Map();
    let outputsBefore: KnowledgeTransactionSnapshot | null = null;
    const processedSources: KnowledgeBaseSource[] = [];
    const marked: KnowledgeBaseSource[] = [];
    const review: KnowledgeBaseSource[] = [];
    const changed: KnowledgeBaseSource[] = [];
    const statusUpdates: Array<{ source: KnowledgeBaseSource; status: typeof RAW_DIGEST_STATUS_PENDING_CALIBRATION | typeof RAW_DIGEST_STATUS_PENDING_REINGEST; evidencePaths?: string[] }> = [];
    try {
      vaultPath = this.plugin.getVaultPath();
      settings.lastRunStatus = "running";
      settings.lastError = "";
      settings.lastSummary = "";
      settings.lastRunAt = startedAt;
      await this.plugin.saveSettings(true);
      rawBeforeContents = await snapshotRawFileContents(vaultPath);
      rawBefore = fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
      assertSafeRawRoot(rawBeforeContents);
      assertSafeRawEntries(rawBeforeContents);
      outputsBefore = await snapshotKnowledgeTransaction(vaultPath, ["outputs"]);
      assertSafeKnowledgeTransactionRoots(outputsBefore, { allowedUnsafePaths: new Set([RAW_DIGEST_REGISTRY_PATH, "outputs/.ingest-tracker.md"]) });
      const discovery = await discoverKnowledgeBaseSources(vaultPath, settings.processedSources, "maintain");
      const structureSnapshot = await snapshotKnowledgeTransaction(vaultPath, ["wiki", "projects"]);
      const registryBeforeRun = await readRawDigestRegistry(vaultPath);
      const trackerHints = await readKnowledgeBaseTrackerHints(vaultPath, "outputs/.ingest-tracker.md", discovery.sources.map((source) => ({
        path: source.relativePath,
        size: source.size,
        mtime: source.mtime,
        fingerprint: source.fingerprint
      })));
      const reportPath = `outputs/maintenance/kb-raw-calibration-${formatDateForFile(new Date(startedAt))}.md`;
      const nextProcessedSources = cloneProcessedSources(settings.processedSources);
      const evidencePaths: Record<string, string[]> = {};
      for (const source of discovery.sources) {
        const previous = processedSourcesBeforeRun[source.relativePath];
        const registryEntry = registryBeforeRun.entries[source.relativePath];
        const existingEvidence = transactionSnapshotExistingSourceEvidencePaths(structureSnapshot, source);
        const rawDigestRecord = await rawMarkdownDigestFrontmatterRecord(vaultPath, source);
        if (rawDigestRecord?.fingerprint && rawDigestRecord.fingerprint !== source.fingerprint) {
          changed.push(source);
          statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
          delete nextProcessedSources[source.relativePath];
          continue;
        }
        if (previous?.fingerprint && previous.fingerprint !== source.fingerprint) {
          if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, previous.fingerprint)) {
            evidencePaths[source.relativePath] = existingEvidence;
            marked.push(source);
            continue;
          }
          changed.push(source);
          statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
          delete nextProcessedSources[source.relativePath];
          continue;
        }
        if (registryEntry?.fingerprint && registryEntry.fingerprint !== source.fingerprint) {
          if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, registryEntry.fingerprint)) {
            evidencePaths[source.relativePath] = existingEvidence;
            marked.push(source);
            continue;
          }
          changed.push(source);
          statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
          delete nextProcessedSources[source.relativePath];
          continue;
        }
        if (rawDigestRecordIsTrusted(rawDigestRecord, source.fingerprint)) {
          if (await rawDigestRecordEvidenceExists(vaultPath, rawDigestRecord)) continue;
          review.push(source);
          statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_CALIBRATION, evidencePaths: rawDigestRecord?.evidencePaths ?? [] });
          delete nextProcessedSources[source.relativePath];
          continue;
        }
        const existingMachineEvidence = rawDigestEvidenceFromProcessedSource(previous, source)
          || rawDigestEvidenceFromRegistryEntry(registryEntry, source);
        if (existingMachineEvidence) {
          evidencePaths[source.relativePath] = existingMachineEvidence;
          marked.push(source);
          continue;
        }
        const exactEvidence = existingEvidence;
        let repairableEvidence = exactEvidence;
        if (!repairableEvidence.length && legacyProcessedSourceMatchesCurrent(previous, source) && existingEvidence.length) {
          repairableEvidence = existingEvidence;
        }
        if (!repairableEvidence.length) {
          repairableEvidence = transactionSnapshotRepairableExistingSourceEvidencePaths(structureSnapshot, source);
        }
        if (repairableEvidence.length) {
          evidencePaths[source.relativePath] = repairableEvidence;
          marked.push(source);
          continue;
        }
        if (previous || trackerHints.paths.has(source.relativePath)) {
          review.push(source);
          statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_CALIBRATION });
          delete nextProcessedSources[source.relativePath];
        }
      }
      const refreshedMarked = await writeRawDigestMetadataForSources(vaultPath, marked, {
        reportPath,
        startedAt,
        evidencePaths,
        confidence: "repaired"
      });
      const refreshedStatusUpdates = await writeRawDigestStatusMetadataForSources(vaultPath, statusUpdates, {
        reportPath,
        startedAt
      });
      const rawAfterDigestMetadata = await snapshotKnowledgeRawFiles(vaultPath);
      const rawDigestChanges = classifyRawSnapshotChanges(rawBefore, rawAfterDigestMetadata, [], {
        allowedManagedFrontmatterPaths: new Set([...refreshedMarked, ...refreshedStatusUpdates].map((source) => source.relativePath))
      });
      if (rawDigestChanges.blockingChanges.length) {
        const messages = rawSnapshotChangeMessages(rawDigestChanges.blockingChanges);
        await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterDigestMetadata, [], { removeAdded: "unsafe" });
        throw new Error(formatRawIntegrityError(messages, true));
      }
      for (const source of refreshedMarked) {
        nextProcessedSources[source.relativePath] = {
          path: source.relativePath,
          size: source.size,
          mtime: source.mtime,
          fingerprint: source.fingerprint,
          digestedAt: startedAt,
          reportPath,
          evidencePaths: evidencePaths[source.relativePath] ?? [],
          runId: String(startedAt),
          confidence: "repaired"
        };
        processedSources.push(source);
      }
      settings.processedSources = nextProcessedSources;
      await writeKnowledgeBaseTracker(vaultPath, nextProcessedSources, startedAt);
      await writeKnowledgeBaseReportFile(vaultPath, reportPath, buildRawDigestCalibrationReport({
        startedAt,
        marked: refreshedMarked,
        review,
        changed,
        evidencePaths
      }));
      settings.lastRunStatus = "success";
      settings.lastReportPath = reportPath;
      settings.lastSummary = `Raw 状态校准完成：已登记 ${refreshedMarked.length} 个，待复核 ${review.length} 个，内容变更 ${changed.length} 个。`;
      settings.lastRunAt = Date.now();
      await this.plugin.saveSettings(true);
      new Notice("Raw 状态校准完成");
      return {
        status: "success",
        reportPath,
        summary: settings.lastSummary,
        processedSources,
        calibration: {
          marked: refreshedMarked,
          review,
          changed,
          evidencePaths
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (vaultPath && rawBeforeContents) {
        const rawAfter = await snapshotKnowledgeRawFiles(vaultPath).catch(() => null);
        if (rawAfter) await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfter, [], { removeAdded: "unsafe" }).catch(() => undefined);
      }
      await restoreKnowledgeTransactionOnFailure(outputsBefore);
      settings.processedSources = processedSourcesBeforeRun;
      settings.lastRunStatus = "failed";
      settings.lastError = message;
      settings.lastSummary = "";
      await saveSettingsSafely(this.plugin);
      return {
        status: "failed",
        reportPath: "",
        summary: "",
        processedSources: [],
        error: message
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
    const healthHistoryBeforeRun = cloneList(settings.healthHistory);
    const maintenanceHistoryBeforeRun = cloneList(settings.maintenanceHistory);
    let vaultPath = "";
    let rawBeforeContents: RawContentSnapshot | null = null;
    let rawBefore: RawSnapshot = new Map();
    let discovery: KnowledgeBaseDiscovery | null = null;
    let reportMtimeBefore: number | null = null;
    let trackerBeforeRun: OptionalFileSnapshot | null = null;
    let transactionBefore: KnowledgeTransactionSnapshot | null = null;
    let runSourcesForFailureReport: KnowledgeBaseSource[] = [];
    let trackerWritten = false;
    let lintReportRecoveryEligible = false;
    const externalRawAdditionsDuringRun = new Set<string>();
    let conflictDuplicateCleanup: KnowledgeConflictDuplicateCleanup = { moved: [], backupRoot: "" };
    try {
      vaultPath = this.plugin.getVaultPath();
      settings.lastRunStatus = "running";
      settings.lastError = "";
      settings.lastSummary = "";
      settings.lastRunAt = startedAt;
      await this.plugin.saveSettings(true);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const transactionRoots = knowledgeTransactionRootsForMode(mode);
      transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      conflictDuplicateCleanup = await quarantinePreexistingKnowledgeConflictDuplicates(vaultPath, transactionBefore, startedAt, mode);
      if (conflictDuplicateCleanup.moved.length) {
        transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      assertSafeKnowledgeTransactionRoots(transactionBefore);
      trackerBeforeRun = await snapshotOptionalFile(path.join(vaultPath, "outputs", ".ingest-tracker.md"));
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      rawBeforeContents = await snapshotRawFileContents(vaultPath);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      rawBefore = fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
      assertSafeRawRoot(rawBeforeContents);
      assertSafeRawEntries(rawBeforeContents);
      discovery = await discoverKnowledgeBaseSources(vaultPath, settings.processedSources, mode);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      reportMtimeBefore = await readKnowledgeBaseReportMtime(vaultPath, discovery.reportPath);
      await ensureKnowledgeBaseFolders(vaultPath, mode);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const rules = await this.resolveRulesFile();
      if (rules.useCustomRulesFile && !rules.exists) {
        throw new Error(`知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`);
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const requestedRawPaths = extractRequestedRawPaths(userRequest);
      const promptSources = selectSourcesForRunMode(mode, discovery, userRequest);
      const runSources = promptSources.slice(0, MAX_ATTACHED_SOURCES);
      runSourcesForFailureReport = runSources;
      const prompt = buildKnowledgeBasePrompt({
        vaultPath,
        mode,
        userRequest,
        requestedRawPaths,
        reportPath: discovery.reportPath,
        sources: runSources,
        skippedSources: discovery.skippedSources,
        remainingSourceCount: Math.max(0, promptSources.length - runSources.length),
        rulesFilePath: rules.relativePath,
        rulesFileExists: rules.exists,
        useCustomRulesFile: rules.useCustomRulesFile,
        hasRawIndex: await exists(path.join(vaultPath, "raw", "index.md")),
        hasWikiIndex: await exists(path.join(vaultPath, "wiki", "index.md")),
        hasTracker: await exists(discovery.trackerPath)
      });
      throwIfKnowledgeBaseCanceled(this.cancelRequested);

      lintReportRecoveryEligible = mode === "lint";
      const output = await this.runKnowledgeAgentTask({
        prompt,
        sources: runSources,
        permission: mode === "lint" ? "read-only" : "workspace-write",
        codexWriteScope: mode === "lint" ? "knowledge-lint" : "knowledge-base",
        turnOptionOverrides,
        managedKind: mode
      });
      lintReportRecoveryEligible = false;
      throwIfKnowledgeBaseCanceled(this.cancelRequested);

      await assertSafeKnowledgeTransactionCurrentState(vaultPath, transactionRoots, {
        allowedUnsafePaths: mode === "maintain" || mode === "reingest" ? new Set(["outputs/.ingest-tracker.md"]) : undefined
      });

      const rawAfterAgent = await snapshotKnowledgeRawFiles(vaultPath);
      const rawAgentChanges = classifyRawSnapshotChanges(rawBefore, rawAfterAgent);
      collectExternalRawAdditions(externalRawAdditionsDuringRun, rawAgentChanges.externalAdditions);
      if (rawAgentChanges.blockingChanges.length) {
        const messages = rawSnapshotChangeMessages(rawAgentChanges.blockingChanges);
        if (mode === "lint") throw new Error(formatRawIntegrityError(messages, false));
        await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterAgent, [], { removeAdded: "unsafe" });
        throw new Error(formatRawIntegrityError(messages, true));
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);

      const structure = mode === "maintain"
        ? await normalizeKnowledgeBaseStructure(vaultPath, { lastReportPath: settings.lastReportPath || discovery.reportPath })
        : undefined;
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      let nextProcessedSources = cloneProcessedSources(settings.processedSources);
      if (structure?.pathRewrites.length) {
        nextProcessedSources = rewriteProcessedSources(nextProcessedSources, structure.pathRewrites);
      }
      const reportPath = structure ? rewriteKnowledgeBaseRelativePath(discovery.reportPath, structure.pathRewrites) : discovery.reportPath;
      const rawAfter = await snapshotKnowledgeRawFiles(vaultPath);
      const rawChanges = classifyRawSnapshotChanges(rawBefore, rawAfter, structure?.pathRewrites ?? []);
      collectExternalRawAdditions(externalRawAdditionsDuringRun, rawChanges.externalAdditions);
      if (rawChanges.blockingChanges.length) {
        const messages = rawSnapshotChangeMessages(rawChanges.blockingChanges);
        await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfter, structure?.pathRewrites ?? [], { removeAdded: "unsafe" });
        throw new Error(formatRawIntegrityError(messages, true));
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);

      let processedChangedSources = await normalizeProcessedSources(vaultPath, runSources, structure?.pathRewrites ?? []);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (mode === "maintain" && structure?.pathRewrites.length) {
        nextProcessedSources = await syncRewrittenRawProcessedSourceStats(vaultPath, nextProcessedSources, structure.pathRewrites);
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      let digestEvidencePaths: Record<string, string[]> = {};
      if (mode === "maintain" || mode === "reingest") {
        digestEvidencePaths = await verifyDigestEvidence({
          vaultPath,
          reportPath,
          sources: runSources,
          startedAt,
          previousReportMtime: reportPath === discovery.reportPath ? reportMtimeBefore : null,
          transactionBefore,
          processedSourcesBeforeRun
        });
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (mode === "maintain" || mode === "reingest") {
        processedChangedSources = await writeRawDigestMetadataForSources(vaultPath, processedChangedSources, {
          reportPath,
          startedAt,
          evidencePaths: digestEvidencePaths,
          confidence: "verified"
        });
        const rawAfterDigestMetadata = await snapshotKnowledgeRawFiles(vaultPath);
        const rawDigestChanges = classifyRawSnapshotChanges(rawBefore, rawAfterDigestMetadata, structure?.pathRewrites ?? [], {
          allowedManagedFrontmatterPaths: new Set(processedChangedSources.map((source) => source.relativePath))
        });
        collectExternalRawAdditions(externalRawAdditionsDuringRun, rawDigestChanges.externalAdditions);
        if (rawDigestChanges.blockingChanges.length) {
          const messages = rawSnapshotChangeMessages(rawDigestChanges.blockingChanges);
          await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterDigestMetadata, structure?.pathRewrites ?? [], { removeAdded: "unsafe" });
          throw new Error(formatRawIntegrityError(messages, true));
        }
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (mode === "maintain" || mode === "reingest") {
        for (const source of processedChangedSources) {
          nextProcessedSources[source.relativePath] = {
            path: source.relativePath,
            size: source.size,
            mtime: source.mtime,
            fingerprint: source.fingerprint,
            digestedAt: startedAt,
            reportPath,
            evidencePaths: digestEvidencePaths[source.relativePath] ?? [],
            runId: String(startedAt),
            confidence: "verified"
          };
        }
      }
      const reportedSources = processedSourcesForRunMode(mode, processedChangedSources);
      await ensureKnowledgeBaseFallbackReport(vaultPath, reportPath, {
        mode,
        output,
        sources: reportedSources,
        startedAt,
        previousMtimeMs: reportPath === discovery.reportPath ? reportMtimeBefore : null
      });
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (mode === "lint") {
        await commitLintReportOnly(vaultPath, transactionBefore, reportPath);
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (structure) await appendStructureNormalizationReport(vaultPath, reportPath, structure);
      if (conflictDuplicateCleanup.moved.length) {
        await appendConflictDuplicateCleanupReport(vaultPath, reportPath, conflictDuplicateCleanup);
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (externalRawAdditionsDuringRun.size) {
        await appendExternalRawAdditionsReport(vaultPath, reportPath, Array.from(externalRawAdditionsDuringRun));
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      if (mode === "maintain" || mode === "reingest") {
        await writeKnowledgeBaseTracker(vaultPath, nextProcessedSources, startedAt);
        trackerWritten = true;
        throwIfKnowledgeBaseCanceled(this.cancelRequested);
        settings.processedSources = nextProcessedSources;
      }
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "success";
      settings.lastReportPath = reportPath;
      settings.lastSummary = buildMaintenanceSummary(output, mode, structure, conflictDuplicateCleanup);
      recordKnowledgeBaseMaintenanceRun(settings, { status: "success", mode, reportPath });
      await this.plugin.saveSettings(true);
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      new Notice(`知识库${labelForRunMode(mode)}完成`);
      return {
        status: "success",
        reportPath,
        summary: settings.lastSummary,
        processedSources: reportedSources,
        structure,
        externalRawAdditions: Array.from(externalRawAdditionsDuringRun),
        digestEvidencePaths
      };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      let canceled = this.cancelRequested || isKnowledgeBaseCancelError(message);
      let rawAfterOnError: RawSnapshot | null = null;
      let rawSnapshotError: unknown = null;
      if (vaultPath) {
        try {
          rawAfterOnError = await snapshotKnowledgeRawFiles(vaultPath);
        } catch (error) {
          rawSnapshotError = error;
        }
      }
      if (rawBeforeContents && rawSnapshotError && !isRawIntegrityErrorMessage(message)) {
        const rawContents = rawBeforeContents;
        const restored = mode === "lint" ? false : await restoreRawMetadata(vaultPath, rawContents).then(async () => {
          const rawAfterRestore = await snapshotKnowledgeRawFiles(vaultPath).catch(() => rawBefore);
          const remainingChanges = classifyRawSnapshotChanges(rawBefore, rawAfterRestore);
          collectExternalRawAdditions(externalRawAdditionsDuringRun, remainingChanges.externalAdditions);
          if (remainingChanges.blockingChanges.length) await restoreRawSnapshot(vaultPath, rawContents, rawBefore, rawAfterRestore, [], { removeAdded: "unsafe" });
          return true;
        }, () => false);
        message = formatRawIntegrityError([`raw/ 文件权限被改写或无法读取（${rawSnapshotError instanceof Error ? rawSnapshotError.message : String(rawSnapshotError)}）`], restored);
        canceled = false;
      } else {
        const rawErrorChanges = classifyRawSnapshotChanges(rawBefore, rawAfterOnError ?? rawBefore);
        collectExternalRawAdditions(externalRawAdditionsDuringRun, rawErrorChanges.externalAdditions);
        if (rawBeforeContents && rawErrorChanges.blockingChanges.length && !isRawIntegrityErrorMessage(message)) {
          const messages = rawSnapshotChangeMessages(rawErrorChanges.blockingChanges);
          const restored = mode === "lint" ? false : await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterOnError ?? rawBefore, [], { removeAdded: "unsafe" }).then(() => true, () => false);
          message = formatRawIntegrityError(messages, restored);
          canceled = false;
        }
      }
      if (trackerWritten && trackerBeforeRun && !transactionBefore) {
        try {
          await restoreOptionalFile(trackerBeforeRun);
          trackerWritten = false;
        } catch (restoreError) {
          const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
          message = `${message}；tracker 回滚失败：${restoreMessage}`;
          canceled = false;
        }
      }
      const finishCanceledRun = async (cancelSourceMessage: string, priorSaveError: string | null = null): Promise<KnowledgeBaseRunResult> => {
        const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
        let cancelMessage = formatCancelResultMessage(cancelSourceMessage, priorSaveError);
        if (restored.error) {
          cancelMessage = `${cancelMessage}；知识库写入回滚失败：${restored.error}`;
        }
        if (restored.restored) trackerWritten = false;
        settings.processedSources = processedSourcesBeforeRun;
        settings.healthHistory = cloneList(healthHistoryBeforeRun);
        settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
        settings.lastRunAt = Date.now();
        settings.lastRunStatus = "canceled";
        if (discovery?.reportPath) settings.lastReportPath = discovery.reportPath;
        settings.lastError = cancelMessage;
        settings.lastSummary = "";
        const saveError = await saveSettingsSafely(this.plugin);
        if (saveError) {
          cancelMessage = appendKnowledgeBaseWarning(cancelMessage, `状态保存失败：${saveError}`);
          settings.lastError = cancelMessage;
          await saveSettingsSafely(this.plugin);
        }
        new Notice(`知识库${labelForRunMode(mode)}已取消`);
        return {
          status: "canceled",
          reportPath: discovery?.reportPath ?? "",
          summary: "",
          processedSources: [],
          error: cancelMessage
        };
      };
      const saveFailureStatusWithRetry = async (failureMessage: string): Promise<string> => {
        const saveError = await saveSettingsSafely(this.plugin);
        if (!saveError) return failureMessage;
        let nextMessage = `${failureMessage}；状态保存失败：${saveError}`;
        settings.lastError = nextMessage;
        const retryError = await saveSettingsSafely(this.plugin);
        if (retryError) {
          nextMessage = `${nextMessage}；状态保存重试失败：${retryError}`;
          settings.lastError = nextMessage;
        }
        return nextMessage;
      };
      canceled = canceled || this.cancelRequested;
      if (canceled) {
        return await finishCanceledRun(message);
      }
      if (lintReportRecoveryEligible && mode === "lint" && discovery?.reportPath && !isRawIntegrityErrorMessage(message)) {
        try {
          const reportExcerpt = await readFreshKnowledgeBaseReportExcerpt(vaultPath, discovery.reportPath, startedAt, { previousMtimeMs: reportMtimeBefore });
          if (reportExcerpt && isLintOnlyKnowledgeBaseReport(reportExcerpt)) {
            if (this.cancelRequested) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            await commitLintReportOnly(vaultPath, transactionBefore, discovery.reportPath);
            if (externalRawAdditionsDuringRun.size) {
              await appendExternalRawAdditionsReport(vaultPath, discovery.reportPath, Array.from(externalRawAdditionsDuringRun));
            }
            if (this.cancelRequested) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            trackerWritten = false;
            settings.lastRunAt = Date.now();
            settings.lastRunStatus = "success";
            settings.lastReportPath = discovery.reportPath;
            settings.lastError = "";
            settings.lastSummary = recoveredLintReportSummary(discovery.reportPath);
            recordKnowledgeBaseMaintenanceRun(settings, { status: "success", mode, reportPath: discovery.reportPath });
            const saveError = await saveSettingsSafely(this.plugin);
            if (this.cancelRequested) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR, saveError);
            if (saveError) {
              let recoveredSaveMessage = `${message}；状态保存失败：${saveError}`;
              const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
              if (restored.error) {
                recoveredSaveMessage = `${recoveredSaveMessage}；知识库写入回滚失败：${restored.error}`;
              }
              if (restored.restored) trackerWritten = false;
              settings.lastRunStatus = "failed";
              settings.lastError = recoveredSaveMessage;
              settings.processedSources = processedSourcesBeforeRun;
              settings.healthHistory = cloneList(healthHistoryBeforeRun);
              settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
              recoveredSaveMessage = await saveFailureStatusWithRetry(recoveredSaveMessage);
              new Notice(`知识库${labelForRunMode(mode)}失败：${recoveredSaveMessage}`);
              return {
                status: "failed",
                reportPath: discovery.reportPath,
                summary: "",
                processedSources: [],
                error: recoveredSaveMessage
              };
            }
            new Notice("知识库体检完成，Codex 状态有警告");
            return {
              status: "success",
              reportPath: discovery.reportPath,
              summary: settings.lastSummary,
              processedSources: [],
              externalRawAdditions: Array.from(externalRawAdditionsDuringRun)
            };
          }
        } catch (recoveryError) {
          if (this.cancelRequested) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
          const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          message = `${message}；体检报告恢复失败：${recoveryMessage}`;
          canceled = false;
        }
      }
      const restored = await restoreKnowledgeTransactionOnFailure(transactionBefore);
      if (restored.error) {
        message = `${message}；知识库写入回滚失败：${restored.error}`;
      }
      if (restored.restored) trackerWritten = false;
      let failureReportPath = "";
      if (vaultPath && discovery?.reportPath && shouldWriteKnowledgeBaseFailureReportForMode(mode)) {
        const reportError = await writeKnowledgeBaseFailureReport(vaultPath, discovery.reportPath, {
          mode,
          error: message,
          sources: runSourcesForFailureReport,
          startedAt,
          rollbackRestored: restored.restored,
          rollbackError: restored.error,
          externalRawAdditions: Array.from(externalRawAdditionsDuringRun)
        }).then(() => null, (error) => error instanceof Error ? error.message : String(error));
        if (reportError) {
          message = appendKnowledgeBaseWarning(message, `失败报告写入失败：${reportError}`);
        } else {
          failureReportPath = discovery.reportPath;
        }
      }
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "failed";
      settings.lastError = message;
      settings.lastSummary = "";
      settings.processedSources = processedSourcesBeforeRun;
      settings.healthHistory = cloneList(healthHistoryBeforeRun);
      settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
      if (failureReportPath) settings.lastReportPath = failureReportPath;
      recordKnowledgeBaseMaintenanceRun(settings, { status: "failed", mode, reportPath: failureReportPath });
      message = await saveFailureStatusWithRetry(message);
      new Notice(`知识库${labelForRunMode(mode)}失败：${message}`);
      return {
        status: "failed",
        reportPath: failureReportPath,
        summary: "",
        processedSources: [],
        error: message
      };
    } finally {
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
  }

  private async answerQuestion(text: string, turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    if (this.running) {
      return { status: "failed", message: "已有知识库任务正在运行" };
    }
    this.running = true;
    this.cancelRequested = false;
    try {
      const question = stripAskCommand(text);
      const rules = await this.resolveRulesFile();
      if (rules.useCustomRulesFile && !rules.exists) {
        throw new Error(`知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`);
      }
      const matches = await findKnowledgeBaseAskMatches(this.plugin.getVaultPath(), question);
      const citations = buildKnowledgeBaseCitationSummary(matches);
      const prompt = buildKnowledgeBaseAskPrompt({
        vaultPath: this.plugin.getVaultPath(),
        userRequest: question,
        rulesFilePath: rules.relativePath,
        rulesFileExists: rules.exists,
        useCustomRulesFile: rules.useCustomRulesFile,
        matches
      });
      const output = await this.runKnowledgeAgentTask({
        prompt,
        sources: matches,
        permission: "read-only",
        codexWriteScope: "knowledge-base",
        turnOptionOverrides,
        managedKind: "ask"
      });
      return {
        status: "success",
        message: formatAskAnswer(output, citations),
        citations
      };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.activeCodexRun = null;
      this.activeOpenCode = null;
      this.activeHermes = null;
      this.running = false;
      this.cancelRequested = false;
      this.refreshKnowledgeBaseSurfaces();
    }
  }

  private async writeDailyJournal(text: string, attachments: StoredAttachment[], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    if (this.running) {
      return { status: "failed", message: "已有知识库任务正在运行" };
    }
    this.running = true;
    this.cancelRequested = false;
    try {
      const vaultPath = this.plugin.getVaultPath();
      const copiedAttachments = await this.copyAttachmentsToRaw(attachments);
      const request = stripJournalPrefix(text).trim() || "写日记";
      const backend = this.resolveKnowledgeBackend();
      const target = await resolveJournalDailyTarget(vaultPath, text);
      await ensureJournalTargetFolders(vaultPath, target);
      const openCodeHistory = backend === "opencode" ? await this.collectOpenCodeJournalHistory(target) : null;
      const prompt = buildKnowledgeBaseJournalPrompt({
        vaultPath,
        userRequest: copiedAttachments.length
          ? [
            request,
            "",
            "本次附带附件已复制到 raw/attachments：",
            ...copiedAttachments.map((item) => `- ${item}`)
          ].join("\n")
          : request,
        target,
        backend,
        openCodeHistory
      });
      const output = await this.runKnowledgeAgentTask({
        prompt,
        sources: [],
        permission: "workspace-write",
        codexWriteScope: "journal",
        turnOptionOverrides,
        managedKind: "journal"
      });
      if (!await exists(target.absolutePath)) {
        throw new Error(`日记任务结束，但未找到目标文件：${target.relativePath}${output.trim() ? `\n\nAgent 输出：${output.trim().slice(0, 800)}` : ""}`);
      }
      return {
        status: "success",
        message: [`已写入日记：`, `- ${target.relativePath}`, output.trim() ? `\n${output.trim().slice(0, 800)}` : ""].filter(Boolean).join("\n")
      };
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.activeCodexRun = null;
      this.activeOpenCode = null;
      this.activeHermes = null;
      this.running = false;
      this.cancelRequested = false;
      this.refreshKnowledgeBaseSurfaces();
    }
  }

  private async collectOpenCodeJournalHistory(target: { evidenceWindow: { startMs: number; endMs: number } }) {
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      await this.plugin.saveSettings();
      return await backend.collectHistoryMessages({
        startMs: target.evidenceWindow.startMs,
        endMs: target.evidenceWindow.endMs
      });
    } catch (error) {
      this.plugin.settings.opencode.lastError = error instanceof Error ? error.message : String(error);
      await this.plugin.saveSettings();
      throw error;
    } finally {
      await backend.disconnect();
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
    if (route.collectAssistantDelta) appendCodexWaiterAssistantDelta(waiter, ids.itemId, params?.delta ?? "");
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

  private finishCodexWaiter(waiter: CodexKbWaiter, method: "turn/completed" | "error", params: any): void {
    if (method === "error" && isRetryingCodexError(params)) return;
    this.clearCodexWaiterTimer(waiter);
    if (this.codexWaiter === waiter) this.codexWaiter = null;
    if (method === "turn/completed" && params?.turn?.status !== "failed") {
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
        void this.plugin.codex?.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      waiter.reject(new Error(`长时间没有收到 Codex 终态（${formatDurationForError(waiter.inactivityTimeoutMs)}），已请求中断。`));
    }, Math.max(1, waiter.inactivityTimeoutMs));
  }

  private clearCodexWaiterTimer(waiter: CodexKbWaiter): void {
    if (!waiter.inactivityTimer) return;
    clearTimeout(waiter.inactivityTimer);
    waiter.inactivityTimer = null;
  }

  private rememberCodexKnowledgeThread(threadId: string, kind: KnowledgeBaseManagedThreadKind): string {
    const id = threadId.trim();
    const runId = newId("kb-codex-thread");
    if (!id) return runId;
    const now = Date.now();
    this.plugin.settings.knowledgeBase.managedThreads[id] = {
      threadId: id,
      runId,
      kind,
      vaultPath: this.plugin.getVaultPath(),
      archiveState: "running",
      createdAt: now,
      settledAt: 0,
      archivedAt: 0,
      attempts: 0,
      lastError: ""
    };
    return runId;
  }

  private markCodexKnowledgeThreadPendingArchive(threadId: string, runId: string): void {
    const id = threadId.trim();
    if (!id) return;
    const existing = this.plugin.settings.knowledgeBase.managedThreads[id];
    if (!existing || existing.runId !== runId || existing.archiveState === "archived") return;
    existing.archiveState = "pending-archive";
    existing.settledAt = Date.now();
    existing.lastError = "";
  }

  async archivePendingCodexKnowledgeThreads(): Promise<number> {
    let recovered = 0;
    if (!this.running && !this.codexWaiter && !this.activeCodexRun && !this.activeOpenCode && !this.activeHermes) {
      recovered = this.recoverStaleRunningCodexKnowledgeThreads("归档前恢复遗留 running 状态");
    }
    const codex = this.plugin.codex;
    if (!codex?.archiveThread) {
      if (recovered) await saveSettingsSafely(this.plugin);
      return 0;
    }
    const managed = this.plugin.settings.knowledgeBase.managedThreads;
    const pending = Object.values(managed)
      .filter((thread) => thread.archiveState === "pending-archive" || thread.archiveState === "archive-failed")
      .sort((left, right) => (left.settledAt || left.createdAt) - (right.settledAt || right.createdAt));
    let archived = 0;
    for (const thread of pending) {
      try {
        thread.attempts += 1;
        await codex.archiveThread(thread.threadId);
        thread.archiveState = "archived";
        thread.archivedAt = Date.now();
        thread.lastError = "";
        archived += 1;
      } catch (error) {
        thread.archiveState = "archive-failed";
        thread.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (pending.length || recovered) await saveSettingsSafely(this.plugin);
    return archived;
  }

  private recoverPersistedRunState(reason: string): number {
    const settings = this.plugin.settings.knowledgeBase;
    let recovered = this.recoverStaleRunningCodexKnowledgeThreads(reason);
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

  private recoverStaleRunningCodexKnowledgeThreads(reason: string): number {
    const managed = this.plugin.settings.knowledgeBase.managedThreads;
    const now = Date.now();
    let recovered = 0;
    for (const thread of Object.values(managed)) {
      if (thread.archiveState !== "running") continue;
      thread.archiveState = "pending-archive";
      thread.settledAt = thread.settledAt || now;
      thread.lastError = reason;
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
    const managedRunId = this.rememberCodexKnowledgeThread(started.threadId, managedKind);
    await this.plugin.codex.setThreadName?.(started.threadId, `Codex EchoInk KB: ${managedKind}`).catch(() => undefined);
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
        if (startTurnAbandoned) void this.plugin.codex?.interruptTurn(started.threadId, turnId).catch(() => undefined);
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
        await this.plugin.codex.interruptTurn(started.threadId, turnId).catch(() => undefined);
        throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
      }
    } catch (error) {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      this.codexWaiter = null;
      this.markCodexKnowledgeThreadPendingArchive(started.threadId, managedRunId);
      throw error;
    }
    try {
      return await result;
    } finally {
      if (waiterRef) this.clearCodexWaiterTimer(waiterRef);
      if (this.codexWaiter === waiterRef) this.codexWaiter = null;
      this.markCodexKnowledgeThreadPendingArchive(started.threadId, managedRunId);
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
      vaultPath: this.plugin.getVaultPath()
    });
  }

  private async sendHermesTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    const abortController = new AbortController();
    const localRunId = `hermes-${Date.now()}`;
    const activeRun: ActiveHermesRun = { runtime, runId: localRunId, abortController };
    let lastPhase = "starting";
    this.activeHermes = activeRun;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeHermes === activeRun) this.activeHermes = null;
        activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(error));
      timer = setTimeout(() => {
        abortController.abort();
        void runtime.abort(activeRun.runId).catch(() => undefined);
        fail(new Error(formatAgentTaskFailureContext({
          backend: "hermes",
          phase: lastPhase,
          runId: activeRun.runId,
          message: `Hermes 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        })));
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        abortController.abort();
        void runtime.abort(activeRun.runId).catch(() => undefined);
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
          (error) => fail(formatAgentTaskGuardError("hermes", lastPhase, activeRun.runId, error))
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async sendOpenCodeTaskWithGuards(runtime: AgentTaskRuntime, input: AgentTaskInput, timeoutMs: number): Promise<string> {
    const abortController = new AbortController();
    const activeRun: ActiveOpenCodeRun = { runtime, runId: "" };
    let lastPhase = "starting";
    this.activeOpenCode = activeRun;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeOpenCode === activeRun) this.activeOpenCode = null;
        activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(error));
      timer = setTimeout(() => {
        abortController.abort();
        const timeoutError = new Error(formatAgentTaskFailureContext({
          backend: "opencode",
          phase: lastPhase,
          runId: activeRun.runId,
          message: `OpenCode 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`
        }));
        if (activeRun.runId) {
          void runtime.abort(activeRun.runId).catch(() => undefined);
          fail(timeoutError);
          return;
        }
        setTimeout(() => {
          if (activeRun.runId) void runtime.abort(activeRun.runId).catch(() => undefined);
          fail(timeoutError);
        }, 20);
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        abortController.abort();
        if (activeRun.runId) void runtime.abort(activeRun.runId).catch(() => undefined);
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
          (error) => fail(formatAgentTaskGuardError("opencode", lastPhase, activeRun.runId, error))
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
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
    const settings = this.plugin.settings;
    const sessionsBefore = cloneStoredSessions(settings.sessions);
    const sessionIdBefore = settings.knowledgeBase.sessionId;
    const lastErrorBefore = settings.knowledgeBase.lastError;
    let vaultPath = "";
    let scheduledSessionId: string | null = null;
    let scheduledMessageId: string | null = null;
    let scheduledRawRef: string | null = null;
    try {
      vaultPath = this.plugin.getVaultPath();
      const session = ensureKnowledgeBaseSession(settings, vaultPath);
      scheduledSessionId = session.id;
      const reportText = result.reportPath
        ? await readKnowledgeBaseReportExcerpt(vaultPath, result.reportPath, 3000).catch(() => null)
        : null;
      const message: ChatMessage = {
        id: newId("msg"),
        role: "assistant",
        title: "每日知识库维护",
        itemType: "knowledgeBase",
        status: result.status === "success" ? "completed" : result.status === "canceled" ? "canceled" : "failed",
        text: buildScheduledKnowledgeBaseMessage(result, reportText ?? ""),
        createdAt: Date.now()
      };
      scheduledMessageId = message.id;
      await this.plugin.externalizeMessageText(message, message.text);
      scheduledRawRef = message.rawRef ?? null;
      session.messages.push(message);
      session.title = "知识库管理";
      session.updatedAt = message.createdAt;
      await this.plugin.saveSettings(true);
      await this.archivePendingCodexKnowledgeThreads();
      await this.plugin.pruneKnowledgeBaseHistoryByRetention().catch((cleanupError) => console.warn("知识库历史清理失败", cleanupError));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rollbackScheduledMaintenanceMessage(settings, {
        sessionsBefore,
        sessionIdBefore,
        scheduledSessionId,
        scheduledMessageId
      });
      const cleanupError = scheduledRawRef
        ? await removeUnreferencedScheduledRawMessage(vaultPath, scheduledRawRef, this.plugin.getPluginDataDirName(), settings)
        : null;
      const warning = cleanupError
        ? `自动维护消息保存失败：${message}；外置原文清理失败：${cleanupError}`
        : `自动维护消息保存失败：${message}`;
      settings.knowledgeBase.lastError = appendKnowledgeBaseWarning(lastErrorBefore, warning);
      await saveSettingsSafely(this.plugin);
      new Notice(`每日维护消息保存失败：${message}`);
      return;
    }
    try {
      this.plugin.getCodexView()?.refreshAfterBackgroundKnowledgeMessage();
    } catch (error) {
      console.warn("每日维护消息刷新失败", error);
    }
  }

  async captureText(target: "inbox" | "raw-articles"): Promise<void> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, target === "inbox" ? "记录知识库想法" : "收集链接到 raw", "输入内容或链接");
    if (!value?.trim()) return;
    const paths = target === "raw-articles"
      ? await this.captureRawArticleInput(value.trim())
      : [await this.writeCollectedText(target, value.trim())];
    new Notice(`已写入 ${paths.join("，")}`);
  }

  async captureWeChatArticle(): Promise<string[]> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "公众号收集", "粘贴 mp.weixin.qq.com 链接");
    if (!value?.trim()) return [];
    const url = extractFirstUrl(value);
    if (!url || !isWeChatUrl(url)) throw new Error("请输入微信公众号文章链接");
    return this.captureWeChatUrl(url);
  }

  async captureWebPage(): Promise<string[]> {
    const { textInputModal } = await import("../ui/modals");
    const value = await textInputModal(this.plugin.app, "网页收藏", "粘贴公开网页链接");
    if (!value?.trim()) return [];
    const url = extractFirstUrl(value);
    if (!url) throw new Error("请输入网页链接");
    return this.captureWebUrl(url);
  }

  async captureExternalFiles(files: StoredAttachment[]): Promise<string[]> {
    return this.copyFilesToRaw(files);
  }

  private async captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[]): Promise<string[]> {
    const paths: string[] = [];
    const copiedAttachments = await this.copyAttachmentsToRaw(attachments);
    paths.push(...copiedAttachments);
    const trimmed = text.trim();
    if (target === "raw-articles" && trimmed && !copiedAttachments.length) {
      paths.push(...await this.captureRawArticleInput(trimmed));
      return paths;
    }
    if (trimmed || copiedAttachments.length) {
      const textTarget = target === "inbox" && !copiedAttachments.length ? "inbox" : "raw-articles";
      const body = copiedAttachments.length
        ? [
          trimmed,
          "",
          "## 附件",
          ...copiedAttachments.map((item) => `- [[${item}]]`)
        ].join("\n").trim()
        : trimmed;
      if (body) paths.push(await this.writeCollectedText(textTarget, body));
    }
    return paths;
  }

  private async captureRawArticleInput(value: string): Promise<string[]> {
    const url = extractFirstUrl(value);
    if (!url) return [await this.writeCollectedText("raw-articles", stripCollectPrefix(value))];
    if (isWeChatUrl(url)) return this.captureWeChatUrl(url);
    return this.captureWebUrl(url, value);
  }

  private async writeCollectedText(target: "inbox" | "raw-articles", value: string): Promise<string> {
    const vaultPath = this.plugin.getVaultPath();
    const now = new Date();
    const stamp = formatDateTimeForFile(now);
    const dir = target === "inbox" ? path.join(vaultPath, "inbox") : path.join(vaultPath, "raw", "articles", "手动收集");
    await fsp.mkdir(dir, { recursive: true });
    const fileName = target === "inbox" ? `${stamp} 知识库想法.md` : `${stamp} 手动收集.md`;
    const body = [
      "---",
      `created: ${now.toISOString()}`,
      `source: ${target}`,
      "---",
      "",
      value.trim(),
      ""
    ].join("\n");
    const absolute = path.join(dir, fileName);
    await fsp.writeFile(absolute, body, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async captureWeChatUrl(url: string): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = path.join(vaultPath, "raw", "articles", "微信公众号");
    await fsp.mkdir(dest, { recursive: true });
    const skillScript = path.join(process.env.HOME || "", ".codex", "skills", "wechat-article-to-obsidian-raw", "scripts", "wechat_capture.mjs");
    if (await exists(skillScript)) {
      try {
        const { stdout } = await execFilePromise("node", [skillScript, url, "--dest", dest], {
          maxBuffer: 30 * 1024 * 1024
        });
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.notePath) return [normalizePath(path.relative(vaultPath, parsed.notePath))];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/verification|captcha|环境异常|验证/i.test(message)) throw new Error(`公众号收集失败：微信验证拦截。${message}`);
      }
    }
    return [await this.captureHtmlLikePage(url, dest, "微信公众号")];
  }

  private async captureWebUrl(url: string, originalInput = ""): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const dest = path.join(vaultPath, "raw", "articles", "网页收藏");
    await fsp.mkdir(dest, { recursive: true });
    return [await this.captureHtmlLikePage(url, dest, "web", originalInput)];
  }

  private async captureHtmlLikePage(url: string, dest: string, source: string, originalInput = ""): Promise<string> {
    const vaultPath = this.plugin.getVaultPath();
    const response = await requestUrl({
      url,
      method: "GET",
      headers: {
        "User-Agent": source === "微信公众号"
          ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50"
          : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }
    });
    const html = response.text;
    if (isHtmlVerificationBlocked(html)) {
      throw new Error(`${source}收藏失败：网页需要验证或登录，插件不会绕过验证。`);
    }
    const article = extractArticleMarkdown(html, url);
    const now = new Date();
    const title = article.title || source;
    const fileName = `${formatDateTimeForFile(now)} ${sanitizeWebCaptureFileName(title)}.md`;
    const absolute = path.join(dest, fileName);
    const body = [
      "---",
      `created: ${now.toISOString()}`,
      `source: ${source}`,
      `url: ${url}`,
      "---",
      "",
      `# ${title}`,
      "",
      `> 原文：${url}`,
      originalInput && originalInput.trim() !== url ? `> 收集说明：${originalInput.trim()}` : "",
      "",
      article.markdown || "正文提取失败，仅保留来源链接。",
      ""
    ].filter((line) => line !== "").join("\n");
    await fsp.writeFile(absolute, body, "utf8");
    return normalizePath(path.relative(vaultPath, absolute));
  }

  private async copyFilesToRaw(files: StoredAttachment[]): Promise<string[]> {
    const vaultPath = this.plugin.getVaultPath();
    const copied: string[] = [];
    for (const file of files) {
      const ext = path.extname(file.path).toLowerCase();
      if (!KNOWLEDGE_FILE_CAPTURE_EXTENSIONS.has(ext)) continue;
      const textLike = [".md", ".markdown", ".txt"].includes(ext);
      const targetDir = textLike
        ? path.join(vaultPath, "raw", "articles", "文件收藏")
        : path.join(vaultPath, "raw", "attachments");
      await fsp.mkdir(targetDir, { recursive: true });
      const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
      await fsp.copyFile(file.path, target);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    if (!copied.length) throw new Error("请选择 PDF、DOCX、Markdown 或 TXT 文件。");
    return copied;
  }

  private async copyAttachmentsToRaw(attachments: StoredAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const vaultPath = this.plugin.getVaultPath();
    const targetDir = path.join(vaultPath, "raw", "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const copied: string[] = [];
    for (const attachment of attachments) {
      const ext = path.extname(attachment.path).toLowerCase();
      if (!SUPPORTED_RAW_EXTENSIONS.has(ext) || [".md", ".markdown", ".txt"].includes(ext)) continue;
      const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(attachment.path)}`);
      await fsp.copyFile(attachment.path, target);
      copied.push(normalizePath(path.relative(vaultPath, target)));
    }
    return copied;
  }

  async captureActiveAttachment(): Promise<void> {
    const file = this.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("没有可收集的当前文件");
      return;
    }
    const ext = path.extname(file.path).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.has(ext) || [".md", ".markdown", ".txt"].includes(ext)) {
      new Notice("当前文件不是图片或 PDF");
      return;
    }
    const vaultPath = this.plugin.getVaultPath();
    const source = path.join(vaultPath, file.path);
    const targetDir = path.join(vaultPath, "raw", "attachments");
    await fsp.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, `${formatDateTimeForFile(new Date())}-${path.basename(file.path)}`);
    await fsp.copyFile(source, target);
    new Notice(`已收集到 ${normalizePath(path.relative(vaultPath, target))}`);
  }
}

function isRetryingCodexError(params: any): boolean {
  return params?.willRetry === true || params?.error?.willRetry === true;
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

function formatAskAnswer(output: string, citations: KnowledgeBaseCitationSummary): string {
  const text = output.trim();
  if (!text) return citations.status === "none" ? "未找到相关本地依据，Agent 未返回回答。" : "Agent 未返回回答。";
  if (citations.status !== "none") return text;
  if (/未找到相关本地依据|无本地依据|未找到相关本地来源|未找到相关\s*(wiki|Wiki)\s*笔记/.test(text)) return text;
  return `未找到相关本地依据。\n\n${text}`;
}

async function ensureKnowledgeBaseFolders(vaultPath: string, mode: KnowledgeBaseRunMode): Promise<void> {
  await fsp.mkdir(path.join(vaultPath, "outputs"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "maintenance"), { recursive: true });
  if (mode === "lint") return;
  await fsp.mkdir(path.join(vaultPath, "outputs", "reviews"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "publishing", "xiaohongshu"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "instructions"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "migrations"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "wiki"), { recursive: true });
}

async function appendStructureNormalizationReport(vaultPath: string, reportPath: string, structure: StructureNormalizationResult): Promise<void> {
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const markerStart = "<!-- codex-echoink-structure:start -->";
  const markerEnd = "<!-- codex-echoink-structure:end -->";
  const lines = [
    markerStart,
    "",
    "## 结构整理",
    "",
    `一眼结论：自动移动 ${structure.moves.length} 项，更新引用 ${structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0)} 处，跳过风险项 ${structure.skipped.length} 项。`,
    "",
    "### 已自动整理",
    ...(structure.moves.length
      ? structure.moves.slice(0, 30).map((move) => `- ${move.from} -> ${move.to}（${move.reason}）`)
      : ["- 无"]),
    structure.moves.length > 30 ? `- 其余 ${structure.moves.length - 30} 项略。` : "",
    "",
    "### 引用同步",
    ...(structure.updatedLinks.length
      ? structure.updatedLinks.slice(0, 30).map((item) => `- ${item.path}：${item.replacements} 处`)
      : ["- 无"]),
    structure.updatedLinks.length > 30 ? `- 其余 ${structure.updatedLinks.length - 30} 个文件略。` : "",
    "",
    "### 跳过 / 需确认",
    ...(structure.skipped.length
      ? structure.skipped.map((item) => `- ${item.from}${item.to ? ` -> ${item.to}` : ""}：${item.reason}`)
      : ["- 无"]),
    "",
    "### 残留结构问题",
    ...(structure.remainingRootNotes.length ? ["- 根目录散落笔记：", ...structure.remainingRootNotes.map((item) => `  - ${item}`)] : ["- 根目录散落笔记：无"]),
    ...(structure.remainingChineseDirs.length ? ["- 中文目录残留：", ...structure.remainingChineseDirs.map((item) => `  - ${item}`)] : ["- 中文目录残留：无"]),
    "",
    markerEnd,
    ""
  ].filter((line) => line !== "").join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current)
    ? current.replace(pattern, lines.trimEnd())
    : `${current.trimEnd()}\n\n${lines}`;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, next);
}

async function appendConflictDuplicateCleanupReport(vaultPath: string, reportPath: string, cleanup: KnowledgeConflictDuplicateCleanup): Promise<void> {
  if (!cleanup.moved.length) return;
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const markerStart = "<!-- codex-echoink-conflict-duplicates:start -->";
  const markerEnd = "<!-- codex-echoink-conflict-duplicates:end -->";
  const lines = [
    markerStart,
    "",
    "## 冲突副本预检",
    "",
    `一眼结论：维护开始前发现 ${cleanup.moved.length} 个数字后缀冲突副本，已从 live 知识区转移到 \`${cleanup.backupRoot}\`，正式页面保留原始无后缀文件。`,
    "",
    ...cleanup.moved.slice(0, 40).map((move) => `- ${move.from} -> ${move.to}（正式页：${move.canonical}）`),
    cleanup.moved.length > 40 ? `- 其余 ${cleanup.moved.length - 40} 个略。` : "",
    "",
    markerEnd,
    ""
  ].filter((line) => line !== "").join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current)
    ? current.replace(pattern, lines.trimEnd())
    : `${current.trimEnd()}\n\n${lines}`;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, next);
}

function collectExternalRawAdditions(target: Set<string>, additions: Array<{ file: string }>): void {
  for (const addition of additions) {
    target.add(addition.file);
  }
}

async function appendExternalRawAdditionsReport(vaultPath: string, reportPath: string, additions: string[]): Promise<void> {
  const unique = Array.from(new Set(additions.map((item) => normalizePath(item)).filter(Boolean))).sort((left, right) => left.localeCompare(right));
  if (!unique.length) return;
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const markerStart = "<!-- codex-echoink-external-raw:start -->";
  const markerEnd = "<!-- codex-echoink-external-raw:end -->";
  const lines = [
    markerStart,
    "",
    "## 运行中新出现的 raw",
    "",
    "以下 raw 是维护任务运行期间由外部流程新增的普通文件或目录；本轮只记录，不消化、不移动、不写入 tracker，留到下次 /maintain。",
    "",
    ...unique.map((item) => `- ${item}`),
    "",
    markerEnd,
    ""
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}\\n?`, "m");
  const next = pattern.test(current)
    ? current.replace(pattern, lines.trimEnd())
    : `${current.trimEnd()}\n\n${lines}`;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, next);
}

async function writeKnowledgeBaseTracker(vaultPath: string, processed: Record<string, KnowledgeBaseProcessedSource>, updatedAt: number): Promise<void> {
  const tracker = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  await fsp.mkdir(path.dirname(tracker), { recursive: true });
  const markerStart = "<!-- codex-echoink-kb:start -->";
  const markerEnd = "<!-- codex-echoink-kb:end -->";
  const current = await readExistingTrackerText(tracker);
  const entries = Object.values(processed)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `- \`${item.path}\` | size=${item.size} | mtime=${Math.round(item.mtime)}${item.fingerprint ? ` | fingerprint=${item.fingerprint}` : ""} | digested=${new Date(item.digestedAt).toISOString()}`);
  const block = [
    markerStart,
    "",
    `## Codex EchoInk 处理记录（${new Date(updatedAt).toISOString()}）`,
    "",
    ...(entries.length ? entries : ["- 暂无"]),
    "",
    markerEnd
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current) ? current.replace(pattern, block) : `${current.trim()}\n\n${block}\n`;
  await writeFileAtomic(tracker, next);
}

async function writeRawDigestMetadataForSources(
  vaultPath: string,
  sources: KnowledgeBaseSource[],
  options: {
    reportPath: string;
    startedAt: number;
    evidencePaths: Record<string, string[]>;
    confidence: RawDigestConfidence;
  }
): Promise<KnowledgeBaseSource[]> {
  if (!sources.length) return sources;
  const registry = await readRawDigestRegistry(vaultPath);
  const updated: KnowledgeBaseSource[] = [];
  for (const source of sources) {
    const absolutePath = path.join(vaultPath, source.relativePath);
    const content = await fsp.readFile(absolutePath);
    const fingerprint = rawDigestFingerprint(source.relativePath, content);
    if (fingerprint !== source.fingerprint) {
      throw new Error(`raw 已在维护后处理前发生变化，停止登记提炼状态：${source.relativePath}`);
    }
    const evidencePaths = (options.evidencePaths[source.relativePath] ?? []).map(normalizePath).filter(Boolean);
    const stat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const entryForFrontmatter = rawDigestRegistryEntryForSource({ ...source, size: stat.size, mtime: stat.mtimeMs, fingerprint }, {
      reportPath: options.reportPath,
      startedAt: options.startedAt,
      evidencePaths,
      confidence: options.confidence
    });
    if (isRawMarkdownPath(source.relativePath)) {
      const nextContent = applyRawDigestFrontmatter(content, entryForFrontmatter);
      const nextFingerprint = rawDigestFingerprint(source.relativePath, nextContent);
      if (nextFingerprint !== fingerprint) {
        throw new Error(`raw 提炼状态写入后指纹不稳定：${source.relativePath}`);
      }
      if (!nextContent.equals(content)) {
        await fsp.writeFile(absolutePath, nextContent);
      }
    }
    const refreshedStat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const refreshed: KnowledgeBaseSource = {
      ...source,
      size: refreshedStat.size,
      mtime: refreshedStat.mtimeMs,
      fingerprint
    };
    registry.entries[source.relativePath] = rawDigestRegistryEntryForSource(refreshed, {
      reportPath: options.reportPath,
      startedAt: options.startedAt,
      evidencePaths,
      confidence: options.confidence
    });
    updated.push(refreshed);
  }
  registry.updatedAt = new Date(options.startedAt).toISOString();
  await writeRawDigestRegistry(vaultPath, registry);
  return updated;
}

async function writeRawDigestStatusMetadataForSources(
  vaultPath: string,
  updates: Array<{ source: KnowledgeBaseSource; status: typeof RAW_DIGEST_STATUS_PENDING_CALIBRATION | typeof RAW_DIGEST_STATUS_PENDING_REINGEST; evidencePaths?: string[] }>,
  options: {
    reportPath: string;
    startedAt: number;
  }
): Promise<KnowledgeBaseSource[]> {
  if (!updates.length) return [];
  const registry = await readRawDigestRegistry(vaultPath);
  const updated: KnowledgeBaseSource[] = [];
  const seen = new Set<string>();
  for (const update of updates) {
    const source = update.source;
    if (seen.has(source.relativePath)) continue;
    seen.add(source.relativePath);
    delete registry.entries[source.relativePath];
    if (!isRawMarkdownPath(source.relativePath)) continue;
    const absolutePath = path.join(vaultPath, source.relativePath);
    const stat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const content = await fsp.readFile(absolutePath);
    const fingerprint = rawDigestFingerprint(source.relativePath, content);
    if (fingerprint !== source.fingerprint) {
      throw new Error(`raw 已在校准后处理前发生变化，停止写入待处理状态：${source.relativePath}`);
    }
    const nextContent = applyRawDigestStatusFrontmatter(content, {
      status: update.status,
      fingerprint,
      reportPath: options.reportPath,
      evidencePaths: normalizeEvidencePaths(update.evidencePaths ?? []),
      digestedAt: options.startedAt
    });
    const nextFingerprint = rawDigestFingerprint(source.relativePath, nextContent);
    if (nextFingerprint !== fingerprint) {
      throw new Error(`raw 待处理状态写入后指纹不稳定：${source.relativePath}`);
    }
    if (!nextContent.equals(content)) {
      await fsp.writeFile(absolutePath, nextContent);
    }
    updated.push({
      ...source,
      size: stat.size,
      mtime: stat.mtimeMs,
      fingerprint
    });
  }
  registry.updatedAt = new Date(options.startedAt).toISOString();
  await writeRawDigestRegistry(vaultPath, registry);
  return updated;
}

async function rawMarkdownDigestFrontmatterRecord(vaultPath: string, source: KnowledgeBaseSource): Promise<ReturnType<typeof rawDigestRecordFromMarkdown> | null> {
  if (!isRawMarkdownPath(source.relativePath)) return null;
  const content = await fsp.readFile(path.join(vaultPath, source.relativePath)).catch(() => null);
  if (!content) return null;
  return rawDigestRecordFromMarkdown(content);
}

async function rawDigestRecordEvidenceExists(vaultPath: string, record: ReturnType<typeof rawDigestRecordFromMarkdown> | null): Promise<boolean> {
  if (!record?.reportPath || !record.evidencePaths.length) return false;
  const requiredPaths = [record.reportPath, ...record.evidencePaths].map(normalizePath).filter(Boolean);
  if (!requiredPaths.length) return false;
  for (const relativePath of requiredPaths) {
    const stat = await fsp.lstat(path.join(vaultPath, relativePath)).catch(() => null);
    if (!stat?.isFile() || stat.nlink > 1) return false;
  }
  return true;
}

async function legacyWholeFileFingerprintMatchesSource(vaultPath: string, source: KnowledgeBaseSource, fingerprint: string): Promise<boolean> {
  if (!fingerprint || !isRawMarkdownPath(source.relativePath)) return false;
  const content = await fsp.readFile(path.join(vaultPath, source.relativePath)).catch(() => null);
  if (!content) return false;
  return contentFingerprint(content) === fingerprint;
}

function rawDigestEvidenceFromProcessedSource(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): string[] | null {
  if (!previous?.fingerprint || previous.fingerprint !== source.fingerprint) return null;
  if (!previous.reportPath || !previous.evidencePaths?.length) return null;
  return normalizeEvidencePaths(previous.evidencePaths);
}

function rawDigestEvidenceFromRegistryEntry(entry: RawDigestRegistryEntry | undefined, source: KnowledgeBaseSource): string[] | null {
  if (!entry || entry.fingerprint !== source.fingerprint) return null;
  if (!entry.reportPath || !entry.evidencePaths.length) return null;
  return normalizeEvidencePaths(entry.evidencePaths);
}

function normalizeEvidencePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean))).sort();
}

function fingerprintKnowledgeRawContentSnapshot(snapshot: RawContentSnapshot): RawSnapshot {
  return fingerprintRawContentSnapshot(snapshot, { fileFingerprint: rawDigestFingerprint });
}

async function snapshotKnowledgeRawFiles(vaultPath: string): Promise<RawSnapshot> {
  return snapshotRawFiles(vaultPath, { fileFingerprint: rawDigestFingerprint });
}

async function assertSafeRawDigestTarget(absolutePath: string, relativePath: string): Promise<fs.Stats> {
  const stat = await fsp.lstat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`raw 提炼状态只能登记普通文件：${relativePath}`);
  }
  if (stat.nlink > 1) {
    throw new Error(`raw 提炼状态拒绝登记 hardlink 文件：${relativePath}`);
  }
  return stat;
}

function rawDigestRegistryEntryForSource(
  source: Pick<KnowledgeBaseSource, "relativePath" | "fingerprint" | "size" | "mtime">,
  options: { reportPath: string; startedAt: number; evidencePaths: string[]; confidence: RawDigestConfidence }
): RawDigestRegistryEntry {
  return {
    rawPath: source.relativePath,
    fingerprint: source.fingerprint,
    size: source.size,
    mtime: source.mtime,
    digestedAt: options.startedAt,
    runId: String(options.startedAt),
    reportPath: options.reportPath,
    evidencePaths: options.evidencePaths,
    confidence: options.confidence
  };
}

function buildRawDigestCalibrationReport(input: {
  startedAt: number;
  marked: KnowledgeBaseSource[];
  review: KnowledgeBaseSource[];
  changed: KnowledgeBaseSource[];
  evidencePaths: Record<string, string[]>;
}): string {
  return [
    "---",
    "source: codex-echoink",
    "mode: raw-digest-calibration",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "---",
    "",
    "# Raw 状态校准报告",
    "",
    "## 一眼结论",
    "",
    `- 已登记：${input.marked.length} 个。`,
    `- 待复核：${input.review.length} 个。`,
    `- 内容变更：${input.changed.length} 个。`,
    "- 本轮不重新提炼，不调用 Agent；Markdown raw 写入托管元属性，非 Markdown raw 写入 registry，并同步 tracker / settings。",
    "",
    "## 已登记",
    "",
    ...(input.marked.length
      ? input.marked.map((source) => `- \`${source.relativePath}\` | 证据：${(input.evidencePaths[source.relativePath] ?? []).map((item) => `\`${item}\``).join("，") || "无"}`)
      : ["- 无"]),
    "",
    "## 待复核",
    "",
    ...(input.review.length
      ? input.review.map((source) => `- \`${source.relativePath}\``)
      : ["- 无"]),
    "",
    "## 内容变更",
    "",
    ...(input.changed.length
      ? input.changed.map((source) => `- \`${source.relativePath}\``)
      : ["- 无"]),
    ""
  ].join("\n");
}

async function readExistingTrackerText(tracker: string): Promise<string> {
  const fallback = "---\nupdated: \n---\n\n# Ingest Tracker\n";
  const stat = await fsp.lstat(tracker).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return fallback;
  if (!stat.isFile()) {
    if (!stat.isSymbolicLink()) await fsp.rm(tracker, { recursive: true, force: true }).catch(() => undefined);
    return fallback;
  }
  if (stat.nlink > 1) return fallback;
  return fsp.readFile(tracker, "utf8").catch(() => fallback);
}

function legacyProcessedSourceMatchesCurrent(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): boolean {
  if (!previous || previous.fingerprint) return false;
  return previous.size === source.size && Math.round(previous.mtime) === Math.round(source.mtime);
}

function cloneProcessedSources(processed: Record<string, KnowledgeBaseProcessedSource> | undefined): Record<string, KnowledgeBaseProcessedSource> {
  return Object.fromEntries(
    Object.entries(processed ?? {}).map(([key, source]) => [key, { ...source }])
  );
}

function cloneList<T extends object>(items: T[] | undefined): T[] {
  return (items ?? []).map((item) => ({ ...item }));
}

function cloneStoredSessions(sessions: StoredSession[] | undefined): StoredSession[] {
  return JSON.parse(JSON.stringify(sessions ?? [])) as StoredSession[];
}

function rollbackScheduledMaintenanceMessage(
  settings: CodexForObsidianPlugin["settings"],
  options: {
    sessionsBefore: StoredSession[];
    sessionIdBefore: string;
    scheduledSessionId: string | null;
    scheduledMessageId: string | null;
  }
): void {
  const beforeById = new Map(options.sessionsBefore.map((session) => [session.id, session]));
  const scheduledSession = options.scheduledSessionId
    ? settings.sessions.find((session) => session.id === options.scheduledSessionId)
    : null;
  if (scheduledSession && options.scheduledMessageId) {
    scheduledSession.messages = scheduledSession.messages.filter((message) => message.id !== options.scheduledMessageId);
    const beforeSession = beforeById.get(scheduledSession.id);
    if (!beforeSession) {
      if (scheduledSession.messages.length === 0) {
        settings.sessions = settings.sessions.filter((session) => session.id !== scheduledSession.id);
      }
    } else if (sameSessionMessageIds(scheduledSession, beforeSession)) {
      Object.assign(scheduledSession, cloneStoredSessions([beforeSession])[0]);
    } else {
      scheduledSession.updatedAt = Math.max(
        beforeSession.updatedAt,
        scheduledSession.createdAt,
        ...scheduledSession.messages.map((message) => message.createdAt)
      );
    }
  }
  if (settings.knowledgeBase.sessionId === options.scheduledSessionId) {
    const scheduledStillExists = Boolean(options.scheduledSessionId && settings.sessions.some((session) => session.id === options.scheduledSessionId));
    settings.knowledgeBase.sessionId = scheduledStillExists ? options.scheduledSessionId! : options.sessionIdBefore;
  }
}

async function removeUnreferencedScheduledRawMessage(
  vaultPath: string,
  rawRef: string | null,
  pluginDir: string,
  settings: CodexForObsidianPlugin["settings"]
): Promise<string | null> {
  if (!vaultPath || !rawRef) return null;
  const stillReferenced = settings.sessions.some((session) => session.messages.some((message) => message.rawRef === rawRef));
  if (stillReferenced) return null;
  try {
    await fsp.rm(resolveRawRef(vaultPath, rawRef, pluginDir), { force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function sameSessionMessageIds(left: StoredSession, right: StoredSession): boolean {
  if (left.messages.length !== right.messages.length) return false;
  return left.messages.every((message, index) => message.id === right.messages[index]?.id);
}

function appendKnowledgeBaseWarning(previous: string, warning: string): string {
  const normalized = previous.trim();
  if (!normalized) return warning;
  if (normalized.includes(warning)) return normalized;
  return `${normalized}；${warning}`;
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

function formatCancelResultMessage(message: string, saveError: string | null): string {
  const details: string[] = [];
  const normalized = message.trim();
  if (normalized && !isKnowledgeBaseCancelError(normalized) && normalized !== "用户取消") {
    details.push(`状态保存失败：${normalized}`);
  }
  if (saveError) details.push(`状态保存失败：${saveError}`);
  return details.length ? `用户取消；${details.join("；")}` : "用户取消";
}

function assertSafeRawRoot(snapshot: RawContentSnapshot): void {
  const root = snapshot.get("raw");
  if (root && root.kind !== "directory") {
    throw new Error("raw/ 不是普通目录，知识库任务不会扫描或处理该路径。");
  }
}

function assertSafeRawEntries(snapshot: RawContentSnapshot): void {
  for (const [relativePath, entry] of snapshot) {
    if (relativePath === "raw") continue;
    if (entry.kind === "symlink") {
      throw new Error(`raw/ 不能包含 symlink：${relativePath}`);
    }
    if (entry.kind === "special") {
      throw new Error(`raw/ 不能包含特殊文件：${relativePath}`);
    }
    if (entry.kind === "file" && entry.nlink > 1) {
      throw new Error(`raw/ 不能包含 hardlink：${relativePath}`);
    }
  }
}

async function saveSettingsSafely(plugin: CodexForObsidianPlugin, options?: Parameters<CodexForObsidianPlugin["saveSettings"]>[1]): Promise<string | null> {
  try {
    await plugin.saveSettings(true, options);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function normalizeProcessedSources(vaultPath: string, sources: KnowledgeBaseSource[], rewrites: StructureNormalizationPathRewrite[]): Promise<KnowledgeBaseSource[]> {
  if (!rewrites.length) return sources;
  const normalized: KnowledgeBaseSource[] = [];
  for (const source of sources) {
    const relativePath = rewriteKnowledgeBaseRelativePath(source.relativePath, rewrites);
    const absolutePath = path.join(vaultPath, relativePath);
    const stat = await fsp.stat(absolutePath).catch(() => null);
    normalized.push({
      ...source,
      relativePath,
      absolutePath,
      ...(stat ? { size: stat.size, mtime: stat.mtimeMs } : {})
    });
  }
  return normalized;
}

function rewriteProcessedSources(
  processed: Record<string, KnowledgeBaseProcessedSource>,
  rewrites: StructureNormalizationPathRewrite[]
): Record<string, KnowledgeBaseProcessedSource> {
  if (!rewrites.length) return processed;
  const next: Record<string, KnowledgeBaseProcessedSource> = {};
  for (const [key, source] of Object.entries(processed ?? {})) {
    const rewritten = rewriteKnowledgeBaseRelativePath(source.path || key, rewrites);
    next[rewritten] = { ...source, path: rewritten };
  }
  return next;
}

async function syncRewrittenRawProcessedSourceStats(
  vaultPath: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  rewrites: StructureNormalizationPathRewrite[]
): Promise<Record<string, KnowledgeBaseProcessedSource>> {
  if (!rewrites.length) return processed;
  const next: Record<string, KnowledgeBaseProcessedSource> = {};
  for (const [key, source] of Object.entries(processed ?? {})) {
    const relativePath = source.path || key;
    if (!isRewrittenRawPath(relativePath, rewrites)) {
      next[key] = source;
      continue;
    }
    const stat = await fsp.stat(path.join(vaultPath, relativePath)).catch(() => null);
    if (!stat?.isFile()) {
      next[key] = source;
      continue;
    }
    const content = await fsp.readFile(path.join(vaultPath, relativePath)).catch(() => null);
    next[key] = {
      ...source,
      path: relativePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      ...(content ? { fingerprint: rawDigestFingerprint(relativePath, content) } : {})
    };
  }
  return next;
}

function isRewrittenRawPath(relativePath: string, rewrites: StructureNormalizationPathRewrite[]): boolean {
  const normalized = normalizePath(relativePath);
  return rewrites.some((rewrite) => {
    if (!rewrite.to.startsWith("raw/")) return false;
    return normalized === rewrite.to || normalized.startsWith(`${rewrite.to}/`);
  });
}

function buildMaintenanceSummary(output: string, mode: KnowledgeBaseRunMode, structure?: StructureNormalizationResult, cleanup?: KnowledgeConflictDuplicateCleanup): string {
  const base = output.trim().slice(0, 800) || `知识库${labelForRunMode(mode)}完成`;
  const lines = [base];
  if (structure) {
    lines.push(`结构整理：移动 ${structure.moves.length} 项，更新引用 ${structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0)} 处，跳过 ${structure.skipped.length} 项。`);
  }
  if (cleanup?.moved.length) {
    lines.push(`冲突副本预检：转移 ${cleanup.moved.length} 个历史数字副本。`);
  }
  return lines.join("\n").slice(0, 1000);
}

function shouldWriteKnowledgeBaseFailureReportForMode(mode: KnowledgeBaseRunMode): boolean {
  return mode !== "lint";
}

function labelForRunMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "体检";
  if (mode === "reingest") return "重新提炼";
  if (mode === "outputs") return "outputs 处理";
  if (mode === "inbox") return "收件箱处理";
  return "维护";
}

function reviewKindLabel(kind: ReviewReportKind): string {
  return kind === "knowledge-base" ? "知识库周报" : "Agent 周报";
}

function normalizeRulesPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/") || AGENTS_RULES_FILE;
}

function execFilePromise(command: string, args: string[], options: { maxBuffer: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const message = stderr || error.message;
        reject(new Error(message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function formatDateForFile(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTimeForFile(date: Date): string {
  return `${formatDateForFile(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
