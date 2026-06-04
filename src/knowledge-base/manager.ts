import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFile } from "child_process";
import { Notice, normalizePath, requestUrl, TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentInputModality, AgentModelInfo, AgentPromptOptions, AgentPromptPart } from "../agent/types";
import { diagnoseCodexError } from "../core/codex-diagnostics";
import type { TurnOptions } from "../core/codex-service";
import { OpenCodeBackend } from "../core/opencode-backend";
import { ensureOpenCodeModelSupportsFiles, requiredModalityForMime } from "../core/opencode-models";
import { resolveRawRef } from "../core/raw-message-store";
import { ensureKnowledgeBaseSession, newId, providerConnectionLabel, recordKnowledgeBaseMaintenanceRun, type ChatMessage, type KnowledgeBaseManagedThreadKind, type KnowledgeBaseProcessedSource, type ReviewReportKind, type StoredAttachment, type StoredSession } from "../settings/settings";
import type { CodexNotification, PermissionMode, UserInput } from "../types/app-server";
import { knowledgeBaseHelpText, parseKnowledgeBaseCommand } from "./commands";
import { AGENTS_RULES_FILE } from "./constants";
import { extractKnowledgeBaseNotificationIds, routeKnowledgeBaseCodexNotification } from "./codex-route";
import { formatKnowledgeBaseCodexFailureSignal, isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { ensureKnowledgeBaseFallbackReport, isLintOnlyKnowledgeBaseReport, readFreshKnowledgeBaseReportExcerpt, readKnowledgeBaseReportExcerpt, readKnowledgeBaseReportMtime, readKnowledgeBaseReportText, recoveredLintReportSummary, writeKnowledgeBaseReportFile } from "./report";
import { SUPPORTED_RAW_EXTENSIONS, discoverKnowledgeBaseSources } from "./discovery";
import { buildKnowledgeBaseDashboardSnapshot, type KnowledgeBaseDashboardSnapshot } from "./dashboard";
import { buildKnowledgeBaseInitializationPreview, executeKnowledgeBaseInitialization, type KnowledgeBaseInitializationPreview } from "./initializer";
import { buildKnowledgeBaseJournalPrompt, ensureJournalTargetFolders, resolveJournalDailyTarget, stripJournalPrefix } from "./journal";
import { buildKnowledgeBaseAskPrompt, buildKnowledgeBasePrompt } from "./prompt";
import { buildKnowledgeBaseCitationSummary, findKnowledgeBaseAskMatches, stripAskCommand } from "./query";
import { applyRawDigestFrontmatter, isRawMarkdownPath, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry, RAW_DIGEST_REGISTRY_PATH, writeRawDigestRegistry, type RawDigestConfidence, type RawDigestRegistryEntry } from "./raw-digest";
import { classifyRawSnapshotChanges, contentFingerprint, fingerprintRawContentSnapshot, formatRawIntegrityError, isRawIntegrityErrorMessage, rawSnapshotChangeMessages, restoreRawMetadata, restoreRawSnapshot, snapshotRawFileContents, snapshotRawFiles } from "./raw-integrity";
import type { RawContentSnapshot, RawSnapshot } from "./raw-integrity";
import { shouldRunScheduledKnowledgeBaseMaintenance } from "./schedule";
import { buildScheduledKnowledgeBaseMessage } from "./scheduled-message";
import { normalizeKnowledgeBaseStructure, rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import { buildCodexKnowledgeTurnOptions } from "./turn-options";
import type { KnowledgeBaseCitationSummary, KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource, StructureNormalizationPathRewrite, StructureNormalizationResult } from "./types";

type CodexKbWaiter = {
  threadId: string;
  turnId: string;
  itemIds: Set<string>;
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  model: string;
  startTurnPending: boolean;
  inactivityTimeoutMs: number;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  pendingTerminal?: { method: "turn/completed" | "error"; params: any };
};

type ActiveOpenCodeRun = {
  backend: OpenCodeBackend;
  sessionId: string;
  cancel?: (error: Error) => void;
};

interface OptionalFileSnapshot {
  absolutePath: string;
  existed: boolean;
  content?: Buffer;
  atimeMs?: number;
  mtimeMs?: number;
  mode?: number;
}

interface KnowledgeTransactionSnapshot {
  vaultPath: string;
  roots: string[];
  entries: Map<string, KnowledgeTransactionSnapshotEntry>;
}

interface KnowledgeTransactionSnapshotEntry {
  kind: "file" | "directory" | "symlink" | "special";
  content?: Buffer;
  target?: string;
  nlink?: number;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

export interface KnowledgeBaseChatResult {
  status: "success" | "failed" | "canceled";
  message: string;
  citations?: KnowledgeBaseCitationSummary;
  followUpCommand?: string;
}

export interface KnowledgeBaseTurnOptionOverrides extends Pick<TurnOptions, "model" | "reasoning" | "serviceTier" | "mcpEnabled" | "workspaceResources"> {
  codexInactivityTimeoutMs?: number;
  opencodeTaskTimeoutMs?: number;
}

const MAX_ATTACHED_SOURCES = 20;
const CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS = 20 * 60 * 1000;
const OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS = 20 * 60 * 1000;
const KNOWLEDGE_FILE_CAPTURE_EXTENSIONS = new Set([".pdf", ".docx", ".md", ".markdown", ".txt"]);
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;

export class KnowledgeBaseManager {
  private running = false;
  private scheduleTimer: number | null = null;
  private schedulerStartedAt = 0;
  private codexWaiter: CodexKbWaiter | null = null;
  private activeCodexRun: { threadId: string; turnId: string; cancel?: (error: Error) => void } | null = null;
  private activeOpenCode: ActiveOpenCodeRun | null = null;
  private cancelRequested = false;

  constructor(private readonly plugin: CodexForObsidianPlugin) {}

  register(): void {
    const recovered = this.recoverStaleRunningCodexKnowledgeThreads("插件重新加载后恢复为待归档");
    if (recovered) void saveSettingsSafely(this.plugin);
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
      this.schedulerStartedAt = Date.now();
      this.armSchedule();
      void this.runCatchUpIfNeeded();
    });
  }

  unload(): void {
    if (this.scheduleTimer) {
      window.clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.codexWaiter) {
      this.codexWaiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiter = null;
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
    this.cancelRequested = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot> {
    return buildKnowledgeBaseDashboardSnapshot(this.plugin.getVaultPath(), this.plugin.settings.knowledgeBase);
  }

  async cancelMaintenance(): Promise<void> {
    const codexRun = this.activeCodexRun;
    const openCodeRun = this.activeOpenCode;
    if (!this.running && !this.codexWaiter && !codexRun && !openCodeRun) {
      new Notice("当前没有知识库任务");
      return;
    }
    this.cancelRequested = true;
    const waiter = this.codexWaiter;
    if (codexRun?.threadId && codexRun.turnId && this.plugin.codex) {
      await this.plugin.codex.interruptTurn(codexRun.threadId, codexRun.turnId).catch(() => undefined);
    }
    if (codexRun?.cancel) codexRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
    if (openCodeRun?.sessionId) {
      if (openCodeRun.cancel) openCodeRun.cancel(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      else void openCodeRun.backend.abort(openCodeRun.sessionId).catch(() => undefined);
    }
    if (waiter && this.codexWaiter === waiter) {
      waiter.reject(new Error(KNOWLEDGE_BASE_CANCEL_ERROR));
      this.codexWaiter = null;
    }
    this.activeCodexRun = null;
    this.activeOpenCode = null;
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
            ].filter(Boolean).join("\n")
          };
        }
        return {
          status: "failed",
          message: `Raw 状态校准失败：${result.error || "未知错误"}`
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
            ].filter(Boolean).join("\n")
          };
        }
        if (result.status === "canceled") {
          return {
            status: "canceled",
            message: [
              `知识库${labelForRunMode(mode)}已取消。`,
              result.error ? `原因：${result.error}` : "",
              result.reportPath ? `报告：${result.reportPath}` : ""
            ].filter(Boolean).join("\n")
          };
        }
        return {
          status: "failed",
          message: [
            `知识库${labelForRunMode(mode)}失败：${result.error || "未知错误"}`,
            this.formatFailureContext(result.reportPath)
          ].filter(Boolean).join("\n")
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
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
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
        if (previous?.fingerprint && previous.fingerprint !== source.fingerprint) {
          if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, previous.fingerprint)) {
            evidencePaths[source.relativePath] = existingEvidence;
            marked.push(source);
            continue;
          }
          changed.push(source);
          continue;
        }
        if (registryEntry?.fingerprint && registryEntry.fingerprint !== source.fingerprint) {
          if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, registryEntry.fingerprint)) {
            evidencePaths[source.relativePath] = existingEvidence;
            marked.push(source);
            continue;
          }
          changed.push(source);
          continue;
        }
        if (await rawMarkdownHasTrustedDigestFrontmatter(vaultPath, source)) continue;
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
        if (previous || trackerHints.paths.has(source.relativePath)) review.push(source);
      }
      const refreshedMarked = await writeRawDigestMetadataForSources(vaultPath, marked, {
        reportPath,
        startedAt,
        evidencePaths,
        confidence: "repaired"
      });
      const rawAfterDigestMetadata = await snapshotKnowledgeRawFiles(vaultPath);
      const rawDigestChanges = classifyRawSnapshotChanges(rawBefore, rawAfterDigestMetadata, [], {
        allowedManagedFrontmatterPaths: new Set(refreshedMarked.map((source) => source.relativePath))
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
        processedSources
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
          this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
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
    let trackerWritten = false;
    let lintReportRecoveryEligible = false;
    const externalRawAdditionsDuringRun = new Set<string>();
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
      const promptSources = selectSourcesForRunMode(mode, discovery);
      const runSources = promptSources.slice(0, MAX_ATTACHED_SOURCES);
      const prompt = buildKnowledgeBasePrompt({
        vaultPath,
        mode,
        userRequest,
        reportPath: discovery.reportPath,
        sources: runSources,
        remainingSourceCount: Math.max(0, promptSources.length - runSources.length),
        rulesFilePath: rules.relativePath,
        rulesFileExists: rules.exists,
        useCustomRulesFile: rules.useCustomRulesFile,
        hasRawIndex: await exists(path.join(vaultPath, "raw", "index.md")),
        hasWikiIndex: await exists(path.join(vaultPath, "wiki", "index.md")),
        hasTracker: await exists(discovery.trackerPath)
      });
      throwIfKnowledgeBaseCanceled(this.cancelRequested);

      const backend = this.resolveKnowledgeBackend();
      lintReportRecoveryEligible = mode === "lint";
      const output = backend === "opencode"
        ? await this.runOpenCodeKnowledgeTask(prompt, runSources, mode === "lint" ? "read-only" : "workspace-write", turnOptionOverrides)
        : await this.runCodexKnowledgeTask(prompt, runSources, "workspace-write", mode === "lint" ? "knowledge-lint" : "knowledge-base", turnOptionOverrides, mode);
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
        await assertFreshMaintenanceReportCoversSources(vaultPath, reportPath, runSources, startedAt, {
          previousMtimeMs: reportPath === discovery.reportPath ? reportMtimeBefore : null
        });
        digestEvidencePaths = await assertKnowledgeStructureDigestsSources(vaultPath, transactionBefore, runSources, {
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
      settings.lastSummary = buildMaintenanceSummary(output, mode, structure);
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
        externalRawAdditions: Array.from(externalRawAdditionsDuringRun)
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
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "failed";
      settings.lastError = message;
      settings.lastSummary = "";
      settings.processedSources = processedSourcesBeforeRun;
      settings.healthHistory = cloneList(healthHistoryBeforeRun);
      settings.maintenanceHistory = cloneList(maintenanceHistoryBeforeRun);
      if (discovery?.reportPath) settings.lastReportPath = discovery.reportPath;
      recordKnowledgeBaseMaintenanceRun(settings, { status: "failed", mode, reportPath: discovery?.reportPath ?? "" });
      message = await saveFailureStatusWithRetry(message);
      new Notice(`知识库${labelForRunMode(mode)}失败：${message}`);
      return {
        status: "failed",
        reportPath: discovery?.reportPath ?? "",
        summary: "",
        processedSources: [],
        error: message
      };
    } finally {
      this.activeCodexRun = null;
      this.activeOpenCode = null;
      this.running = false;
      this.cancelRequested = false;
      try {
        this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
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
      const backend = this.resolveKnowledgeBackend();
      const output = backend === "opencode"
        ? await this.runOpenCodeKnowledgeTask(prompt, matches, "read-only", turnOptionOverrides)
        : await this.runCodexKnowledgeTask(prompt, matches, "read-only", "knowledge-base", turnOptionOverrides, "ask");
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
      this.running = false;
      this.cancelRequested = false;
      this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
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
      const output = backend === "opencode"
        ? await this.runOpenCodeKnowledgeTask(prompt, [], "workspace-write", turnOptionOverrides)
        : await this.runCodexKnowledgeTask(prompt, [], "workspace-write", "journal", turnOptionOverrides, "journal");
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
      this.running = false;
      this.cancelRequested = false;
      this.plugin.getCodexView()?.refreshKnowledgeBaseDashboard();
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
    if (route.collectAssistantDelta) waiter.text += params?.delta ?? "";
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
      else waiter.resolve(waiter.text);
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
    if (!this.running && !this.codexWaiter && !this.activeCodexRun && !this.activeOpenCode) {
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
      waiterRef = { threadId: started.threadId, turnId: "", itemIds: new Set<string>(), text: "", resolve, reject, model: options.model, startTurnPending: true, inactivityTimeoutMs, inactivityTimer: null };
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
          waiter.text = "";
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
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
  ): Promise<string> {
    const backend = new OpenCodeBackend({
      ...this.plugin.settings.opencode,
      vaultPath: this.plugin.getVaultPath()
    });
    try {
      await backend.connect();
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      const info = backend.getConnectionInfo();
      this.plugin.settings.opencode.lastConnectedAt = Date.now();
      this.plugin.settings.opencode.lastError = "";
      const models = await backend.listModels();
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
      const session = await backend.startSession({
        title: permission === "read-only" ? "Obsidian 知识库问答" : "Obsidian 知识库维护",
        agent: this.plugin.settings.opencode.agent,
        permission,
        ...(selectedModel ? { model: { providerId: selectedModel.providerId, modelId: selectedModel.modelId } } : {})
      });
      throwIfKnowledgeBaseCanceled(this.cancelRequested);
      this.activeOpenCode = { backend, sessionId: session.sessionId };
      return await this.sendOpenCodePromptWithGuards(backend, {
        sessionId: session.sessionId,
        parts,
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
      await backend.disconnect();
    }
  }

  private async sendOpenCodePromptWithGuards(backend: OpenCodeBackend, options: AgentPromptOptions, timeoutMs: number): Promise<string> {
    const activeRun = this.activeOpenCode;
    if (!activeRun || activeRun.backend !== backend || activeRun.sessionId !== options.sessionId) {
      return await backend.sendPrompt(options);
    }
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeOpenCode === activeRun) activeRun.cancel = undefined;
        callback();
      };
      const fail = (error: Error): void => finish(() => reject(error));
      timer = setTimeout(() => {
        void backend.abort(options.sessionId).catch(() => undefined);
        fail(new Error(`OpenCode 长时间没有返回（${formatDurationForError(timeoutMs)}），已请求中断。`));
      }, Math.max(1, timeoutMs));
      activeRun.cancel = (error: Error) => {
        void backend.abort(options.sessionId).catch(() => undefined);
        fail(error);
      };
      try {
        backend.sendPrompt(options).then(
          (output) => finish(() => resolve(output)),
          (error) => fail(error instanceof Error ? error : new Error(String(error)))
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolveKnowledgeBackend(): "codex-cli" | "opencode" {
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

  private armSchedule(): void {
    if (this.scheduleTimer) window.clearInterval(this.scheduleTimer);
    this.scheduleTimer = window.setInterval(() => void this.runScheduledIfDue(), 60 * 1000);
    this.plugin.registerInterval(this.scheduleTimer);
  }

  private async runCatchUpIfNeeded(): Promise<void> {
    if (!this.plugin.settings.knowledgeBase.catchUpOnStartup) return;
    await this.runScheduledIfDue(true);
  }

  private async runScheduledIfDue(forceCatchUp = false): Promise<void> {
    const settings = this.plugin.settings.knowledgeBase;
    if (this.running) return;
    if (shouldRunScheduledKnowledgeBaseMaintenance(settings, new Date(), this.schedulerStartedAt, forceCatchUp)) {
      const scheduledStartedAt = Date.now();
      settings.lastScheduledRunAt = scheduledStartedAt;
      settings.lastScheduledRunStatus = "running";
      const result = await this.runMaintenance("maintain");
      settings.lastScheduledRunAt = scheduledStartedAt;
      settings.lastScheduledRunStatus = result.status;
      await this.appendScheduledMaintenanceMessage(result);
    }
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
    if (/环境异常|wappoc_appmsgcaptcha|完成验证后即可继续访问|captcha/i.test(html)) {
      throw new Error(`${source}收藏失败：网页需要验证或登录，插件不会绕过验证。`);
    }
    const article = extractArticleMarkdown(html, url);
    const now = new Date();
    const title = article.title || source;
    const fileName = `${formatDateTimeForFile(now)} ${sanitizeFileName(title)}.md`;
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

function buildCodexKnowledgeInput(prompt: string, sources: KnowledgeBaseSource[]): UserInput[] {
  const input: UserInput[] = [{ type: "text", text: prompt, text_elements: [] }];
  for (const source of sources.slice(0, MAX_ATTACHED_SOURCES)) {
    if (source.modality === "image") {
      input.push({ type: "localImage", path: source.absolutePath });
    } else {
      input.push({ type: "mention", name: path.basename(source.absolutePath), path: source.absolutePath });
    }
  }
  return input;
}

function buildOpenCodeKnowledgeParts(prompt: string, sources: KnowledgeBaseSource[]): AgentPromptPart[] {
  return [
    { type: "text", text: prompt },
    ...sources.slice(0, MAX_ATTACHED_SOURCES).map((source): AgentPromptPart => ({
      type: "file",
      path: source.absolutePath,
      filename: path.basename(source.absolutePath),
      mime: source.mime
    }))
  ];
}

function requiredModalities(parts: AgentPromptPart[]): AgentInputModality[] {
  const modalities = new Set<AgentInputModality>(["text"]);
  for (const part of parts) {
    if (part.type === "file") modalities.add(requiredModalityForMime(part.mime));
  }
  return Array.from(modalities);
}

function selectOpenCodeModel(models: AgentModelInfo[], providerId: string, modelId: string, required: AgentInputModality[]): AgentModelInfo | null {
  const configured = models.find((model) => model.providerId === providerId && model.modelId === modelId);
  if (configured) return configured;
  return models.find((model) => required.every((modality) => model.inputModalities.includes(modality))) ?? models[0] ?? null;
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

async function rawMarkdownHasTrustedDigestFrontmatter(vaultPath: string, source: KnowledgeBaseSource): Promise<boolean> {
  if (!isRawMarkdownPath(source.relativePath)) return false;
  const content = await fsp.readFile(path.join(vaultPath, source.relativePath)).catch(() => null);
  if (!content) return false;
  return rawDigestRecordIsTrusted(rawDigestRecordFromMarkdown(content), source.fingerprint);
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

async function snapshotOptionalFile(absolutePath: string): Promise<OptionalFileSnapshot> {
  const stat = await fsp.lstat(absolutePath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return { absolutePath, existed: false };
  if (!stat.isFile()) return { absolutePath, existed: true };
  return {
    absolutePath,
    existed: true,
    content: await fsp.readFile(absolutePath),
    atimeMs: stat.atimeMs,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode
  };
}

async function restoreOptionalFile(snapshot: OptionalFileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await fsp.rm(snapshot.absolutePath, { force: true, recursive: true });
    return;
  }
  if (!snapshot.content) return;
  await fsp.mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
  await writeFileAtomic(snapshot.absolutePath, snapshot.content);
  if (typeof snapshot.mode === "number") await fsp.chmod(snapshot.absolutePath, snapshot.mode).catch(() => undefined);
  if (typeof snapshot.atimeMs === "number" && typeof snapshot.mtimeMs === "number") {
    await fsp.utimes(snapshot.absolutePath, new Date(snapshot.atimeMs), new Date(snapshot.mtimeMs)).catch(() => undefined);
  }
}

async function writeFileAtomic(absolutePath: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  const temp = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content);
    await fsp.rename(temp, absolutePath);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function selectSourcesForRunMode(mode: KnowledgeBaseRunMode, discovery: KnowledgeBaseDiscovery): KnowledgeBaseSource[] {
  if (mode === "lint" || mode === "inbox" || mode === "outputs") return [];
  if (mode === "reingest") {
    const changed = discovery.changedSources;
    if (changed.length) return changed;
    return [...discovery.sources].sort((left, right) => right.mtime - left.mtime).slice(0, MAX_ATTACHED_SOURCES);
  }
  return discovery.changedSources;
}

function processedSourcesForRunMode(mode: KnowledgeBaseRunMode, sources: KnowledgeBaseSource[]): KnowledgeBaseSource[] {
  return mode === "maintain" || mode === "reingest" ? sources : [];
}

async function assertFreshMaintenanceReportCoversSources(
  vaultPath: string,
  reportPath: string,
  sources: KnowledgeBaseSource[],
  startedAt: number,
  options: { previousMtimeMs?: number | null } = {}
): Promise<void> {
  if (!sources.length) return;
  const report = await readFreshKnowledgeBaseReportExcerpt(vaultPath, reportPath, startedAt, {
    previousMtimeMs: options.previousMtimeMs,
    maxChars: 200_000
  });
  if (!report) {
    throw new Error("知识库维护未写出本轮来源证据，已停止提交 tracker。");
  }
  const missing = sources.filter((source) => !maintenanceReportMentionsSource(report, source.relativePath));
  if (missing.length) {
    throw new Error(`知识库维护报告缺少本轮来源证据，已停止提交 tracker：${missing.slice(0, 5).map((source) => source.relativePath).join("，")}`);
  }
}

async function assertKnowledgeStructureDigestsSources(
  vaultPath: string,
  before: KnowledgeTransactionSnapshot | null,
  sources: KnowledgeBaseSource[],
  options: { processedSourcesBeforeRun?: Record<string, KnowledgeBaseProcessedSource> } = {}
): Promise<Record<string, string[]>> {
  if (!sources.length) return {};
  if (!before) {
    throw new Error("知识库维护未写出结构层消化证据，已停止提交 tracker。");
  }
  const current = await snapshotKnowledgeTransaction(vaultPath, before.roots);
  const covered = new Set<string>();
  const evidencePaths = new Map<string, Set<string>>();
  const addEvidence = (source: KnowledgeBaseSource, paths: string[]) => {
    if (!paths.length) return;
    covered.add(source.relativePath);
    const bucket = evidencePaths.get(source.relativePath) ?? new Set<string>();
    for (const item of paths) bucket.add(item);
    evidencePaths.set(source.relativePath, bucket);
  };
  for (const source of sources) {
    const previous = options.processedSourcesBeforeRun?.[source.relativePath];
    if (legacyProcessedSourceMatchesCurrent(previous, source)) {
      addEvidence(source, transactionSnapshotExistingSourceEvidencePaths(before, source));
    }
    if (!covered.has(source.relativePath) && processedSourceCanUseRepairableExistingEvidence(previous)) {
      addEvidence(source, transactionSnapshotRepairableExistingSourceEvidencePaths(before, source));
    }
  }
  for (const [relativePath, currentEntry] of current.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (!transactionFileContentChanged(before.entries.get(relativePath), currentEntry)) continue;
    const beforeEntry = before.entries.get(relativePath);
    for (const source of sources) {
      if (transactionFileIntroducesSourceEvidence(beforeEntry, currentEntry, source)) addEvidence(source, [relativePath]);
    }
  }
  const missing = sources.filter((source) => !covered.has(source.relativePath));
  if (missing.length) {
    throw new Error(`知识库维护未写出结构层消化证据，已停止提交 tracker：${missing.slice(0, 5).map((source) => source.relativePath).join("，")}`);
  }
  return Object.fromEntries(Array.from(evidencePaths.entries()).map(([key, value]) => [key, Array.from(value).sort()]));
}

function isKnowledgeStructureDigestEvidencePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  if (!(normalized.startsWith("wiki/") || normalized.startsWith("projects/"))) return false;
  return !isKnowledgeIndexEvidencePath(normalized);
}

function isKnowledgeIndexEvidencePath(relativePath: string): boolean {
  const baseName = path.basename(normalizePath(relativePath)).toLowerCase();
  return baseName === "index.md"
    || baseName === "readme.md"
    || baseName === "00-索引.md"
    || baseName === "索引.md";
}

function transactionFileContentChanged(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry
): boolean {
  if (current.kind !== "file" || !current.content) return false;
  if (!before) return true;
  if (before.kind !== "file" || !before.content) return true;
  return !before.content.equals(current.content);
}

function transactionFileIntroducesSourceEvidence(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry,
  source: KnowledgeBaseSource
): boolean {
  if (current.kind !== "file" || !current.content) return false;
  const currentText = current.content.toString("utf8");
  if (!maintenanceReportMentionsSource(currentText, source.relativePath)) return false;
  const currentLines = normalizedEvidenceLines(currentText);
  const beforeLines = before?.kind === "file" && before.content
    ? normalizedEvidenceLines(before.content.toString("utf8"))
    : [];
  const introducedLines = introducedEvidenceLineFlags(beforeLines, currentLines);
  return sourceEvidenceBlocks(currentLines, introducedLines, source.relativePath)
    .some((block) => (block.hasSource || (block.hasExistingTargetSource && !block.hasOldDigestBeforeNewDigest)) && block.hasDigest)
    || transactionFileIntroducesPageLevelSourceEvidence(currentLines, introducedLines, source.relativePath, beforeLines.length === 0);
}

function legacyProcessedSourceMatchesCurrent(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): boolean {
  if (!previous || previous.fingerprint) return false;
  return previous.size === source.size && Math.round(previous.mtime) === Math.round(source.mtime);
}

function processedSourceCanUseRepairableExistingEvidence(previous: KnowledgeBaseProcessedSource | undefined): boolean {
  return !previous || !previous.fingerprint;
}

function transactionSnapshotExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): string[] {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (entry.kind !== "file" || !entry.content) continue;
    const lines = normalizedEvidenceLines(entry.content.toString("utf8"));
    if (fileHasSourceMentionAndDigest(lines, source.relativePath)) paths.push(relativePath);
  }
  return paths;
}

function transactionSnapshotRepairableExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): string[] {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (entry.kind !== "file" || !entry.content) continue;
    if (!transactionEntryIsNotOlderThanSource(entry, source)) continue;
    const lines = normalizedEvidenceLines(entry.content.toString("utf8"));
    if (fileHasSinglePageLevelSourceEvidence(lines, source.relativePath) || fileHasDatedAggregateSourceEvidence(lines, source.relativePath)) paths.push(relativePath);
  }
  return paths;
}

function transactionEntryIsNotOlderThanSource(entry: KnowledgeTransactionSnapshotEntry, source: KnowledgeBaseSource): boolean {
  return entry.mtimeMs + 1000 >= source.mtime;
}

function transactionFileIntroducesPageLevelSourceEvidence(
  lines: string[],
  introducedLines: boolean[],
  relativePath: string,
  isNewFile: boolean
): boolean {
  const introducedSourceLineIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => introducedLines[index] && lineMentionsTargetRawSource(line, relativePath))
    .map(({ index }) => index);
  if (!introducedSourceLineIndexes.length) return false;
  if (isNewFile) {
    return introducedSourceLineIndexes.some((index) => isPageLevelSourceLine(lines, index)) && fileHasIntroducedDigest(lines, introducedLines);
  }
  return fileHasIntroducedDatedDigest(lines, introducedLines, relativePath);
}

function fileHasSourceMentionAndDigest(lines: string[], relativePath: string): boolean {
  return lines.some((line) => lineMentionsTargetRawSource(line, relativePath))
    && lines.some((line) => isSubstantiveDigestLine(line));
}

function fileHasSinglePageLevelSourceEvidence(lines: string[], relativePath: string): boolean {
  const sourceIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => isSinglePageLevelSourceLine(lines, index) && lineMentionsTargetRawSource(line, relativePath))
    .map(({ index }) => index);
  if (!sourceIndexes.length) return false;
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const pageHeaderEnd = firstSection === -1 ? lines.length : firstSection;
  const pageLevelRawMentions = lines.slice(0, pageHeaderEnd).filter((line) => mentionsRawSource(line)).length;
  return pageLevelRawMentions === 1 && fileHasSourceMentionAndDigest(lines, relativePath);
}

function fileHasDatedAggregateSourceEvidence(lines: string[], relativePath: string): boolean {
  const sourceDate = extractKnowledgeSourceDate(relativePath);
  if (!sourceDate) return false;
  const hasSourceInQuotedList = lines.some((line) => /^>\s*[-*+]\s+/.test(line.trim()) && lineMentionsTargetRawSource(line, relativePath));
  if (!hasSourceInQuotedList) return false;
  return lines.some((line, index) => {
    if (!isSubstantiveDigestLine(line)) return false;
    return evidenceTextCoversDate(line, sourceDate) || evidenceTextCoversDate(nearestEvidenceHeading(lines, index), sourceDate);
  });
}

function fileHasIntroducedDigest(lines: string[], introducedLines: boolean[]): boolean {
  return lines.some((line, index) => introducedLines[index] && isSubstantiveDigestLine(line));
}

function fileHasIntroducedDatedDigest(lines: string[], introducedLines: boolean[], relativePath: string): boolean {
  const sourceDate = extractKnowledgeSourceDate(relativePath);
  if (!sourceDate) return false;
  return lines.some((line, index) => {
    if (!introducedLines[index] || !isSubstantiveDigestLine(line)) return false;
    return evidenceTextCoversDate(line, sourceDate) || evidenceTextCoversDate(nearestEvidenceHeading(lines, index), sourceDate);
  });
}

function lineMentionsTargetRawSource(line: string, relativePath: string): boolean {
  return mentionsRawSource(line) && maintenanceReportMentionsSource(line, relativePath);
}

function isPageLevelSourceLine(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  if (!/^>\s*(?:来源[:：]|[-*+]\s+)?/.test(line)) return false;
  const firstSection = lines.findIndex((item) => /^##\s+/.test(item));
  return firstSection === -1 || index < firstSection;
}

function isSinglePageLevelSourceLine(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  if (!/^>\s*来源[:：]/.test(line)) return false;
  return isPageLevelSourceLine(lines, index);
}

function extractKnowledgeSourceDate(relativePath: string): string | null {
  return relativePath.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] ?? null;
}

function nearestEvidenceHeading(lines: string[], index: number): string {
  for (let current = index; current >= 0; current--) {
    if (/^#{1,6}\s+/.test(lines[current])) return lines[current];
  }
  return "";
}

function evidenceTextCoversDate(text: string, date: string): boolean {
  if (!text) return false;
  if (text.includes(date)) return true;
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) return false;
  for (const match of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|-|—|–)\s*(20\d{2}-\d{2}-\d{2})\b/g)) {
    const start = Date.parse(`${match[1]}T00:00:00Z`);
    const end = Date.parse(`${match[2]}T00:00:00Z`);
    if (Number.isFinite(start) && Number.isFinite(end) && target >= Math.min(start, end) && target <= Math.max(start, end)) return true;
  }
  return false;
}

function introducedEvidenceLineFlags(beforeLines: string[], currentLines: string[]): boolean[] {
  if (!currentLines.length) return [];
  if (!beforeLines.length) return currentLines.map(() => true);
  const beforeLength = beforeLines.length;
  const currentLength = currentLines.length;
  const maxDistance = beforeLength + currentLength;
  const trace: Array<Map<number, number>> = [];
  const vector = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= maxDistance; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const goDown = diagonal === -distance
        || (diagonal !== distance && evidenceVectorValue(vector, diagonal - 1) <= evidenceVectorValue(vector, diagonal + 1));
      let beforeIndex = goDown
        ? evidenceVectorValue(vector, diagonal + 1)
        : evidenceVectorValue(vector, diagonal - 1) + 1;
      let currentIndex = beforeIndex - diagonal;
      while (
        beforeIndex < beforeLength
        && currentIndex < currentLength
        && beforeLines[beforeIndex] === currentLines[currentIndex]
      ) {
        beforeIndex++;
        currentIndex++;
      }
      vector.set(diagonal, beforeIndex);
      if (beforeIndex >= beforeLength && currentIndex >= currentLength) {
        trace.push(new Map(vector));
        return reconstructIntroducedEvidenceLineFlags(trace, beforeLength, currentLength);
      }
    }
    trace.push(new Map(vector));
  }
  return currentLines.map(() => true);
}

function evidenceVectorValue(vector: Map<number, number>, diagonal: number): number {
  return vector.get(diagonal) ?? -1;
}

function reconstructIntroducedEvidenceLineFlags(trace: Array<Map<number, number>>, beforeLength: number, currentLength: number): boolean[] {
  const introduced = Array.from({ length: currentLength }, () => true);
  let beforeIndex = beforeLength;
  let currentIndex = currentLength;
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const previousVector = trace[distance - 1];
    const diagonal = beforeIndex - currentIndex;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance && evidenceVectorValue(previousVector, diagonal - 1) <= evidenceVectorValue(previousVector, diagonal + 1))
      ? diagonal + 1
      : diagonal - 1;
    const previousBeforeIndex = evidenceVectorValue(previousVector, previousDiagonal);
    const previousCurrentIndex = previousBeforeIndex - previousDiagonal;
    while (beforeIndex > previousBeforeIndex && currentIndex > previousCurrentIndex) {
      beforeIndex--;
      currentIndex--;
      introduced[currentIndex] = false;
    }
    if (currentIndex === previousCurrentIndex) {
      beforeIndex--;
    } else {
      currentIndex--;
    }
  }
  while (beforeIndex > 0 && currentIndex > 0) {
    beforeIndex--;
    currentIndex--;
    introduced[currentIndex] = false;
  }
  return introduced;
}

function normalizedEvidenceLines(text: string): string[] {
  return stripNonBodyEvidenceLines(text.replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim()));
}

function stripNonBodyEvidenceLines(lines: string[]): string[] {
  const stripped = [...lines];
  if (stripped[0] === "---") {
    const frontmatterEnd = stripped.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
    if (frontmatterEnd > 0) {
      for (let index = 0; index <= frontmatterEnd; index++) stripped[index] = "";
    }
  }
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < stripped.length; index++) {
    const line = stripped[index];
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      stripped[index] = "";
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length
      };
      stripped[index] = "";
    }
  }
  return stripped;
}

function sourceEvidenceBlocks(lines: string[], introducedLines: boolean[], relativePath: string): Array<{ hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean }> {
  const blocks: Array<{ hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean }> = [];
  let active: { hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean } | null = null;
  for (const [index, line] of lines.entries()) {
    if (isSourceEvidenceBlockBoundary(line)) {
      if (active) blocks.push(active);
      active = null;
      continue;
    }
    const introduced = introducedLines[index] ?? true;
    const mentionsTarget = introduced && maintenanceReportMentionsSource(line, relativePath);
    const mentionsExistingTarget = !introduced && maintenanceReportMentionsSource(line, relativePath) && mentionsRawSource(line);
    const mentionsAnyRaw = introduced && mentionsRawSource(line) || mentionsExistingTarget;
    if (mentionsAnyRaw) {
      if (active) blocks.push(active);
      active = {
        hasSource: mentionsTarget,
        hasDigest: introduced && isSubstantiveSourceEvidenceLine(line, relativePath),
        hasExistingTargetSource: mentionsExistingTarget,
        hasOldDigestBeforeNewDigest: false
      };
      continue;
    }
    if (active && introduced && isSubstantiveDigestLine(line)) {
      active.hasDigest = true;
    } else if (active && !introduced && isSubstantiveDigestLine(line)) {
      active.hasOldDigestBeforeNewDigest = true;
    }
  }
  if (active) blocks.push(active);
  return blocks;
}

function isSourceEvidenceBlockBoundary(line: string): boolean {
  const normalized = line.trim();
  return !normalized
    || /^#{1,6}\s+/.test(normalized)
    || /^---+$/.test(normalized);
}

function isSubstantiveSourceEvidenceLine(line: string, relativePath: string): boolean {
  if (!maintenanceReportMentionsSource(line, relativePath)) return false;
  const withoutSource = stripRawSourceMentions(line)
    .replace(/^(本轮)?来源[:：]/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
  return isSubstantiveDigestLine(withoutSource);
}

function mentionsRawSource(line: string): boolean {
  return /\[\[raw\//i.test(line)
    || /(^|[^A-Za-z0-9_\-.%\u4e00-\u9fff])(?:\/[^\s`)\]）】]+\/)?raw\//i.test(line);
}

function stripRawSourceMentions(line: string): string {
  return line
    .replace(/\[\[raw\/[^\]]+\]\]/gi, "")
    .replace(/\[[^\]]*\]\(\s*<?(?:\.\/|\/)?raw\/[^)\s>]+>?(?:\s+["'][^"']*["'])?\s*\)/gi, "")
    .replace(/`raw\/[^`]+`/gi, "")
    .replace(/(^|[^A-Za-z0-9_\-.%\u4e00-\u9fff])\/[^\s`)\]）】,，;；:：!！?？。]+\/raw\/[^\s`)\]）】,，;；:：!！?？。]+/gi, "$1")
    .replace(/(^|[^A-Za-z0-9_\-./%\u4e00-\u9fff])raw\/[^\s`)\]）】,，;；:：!！?？。]+/gi, "$1");
}

function isSubstantiveDigestLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  if (/^#{1,6}\s+/.test(normalized)) return false;
  if (/^---+$/.test(normalized)) return false;
  if (/^[-*+]\s*\[\[?raw\//i.test(normalized)) return false;
  if (/^[-*+]\s*`?raw\//i.test(normalized)) return false;
  if (/^(本轮)?来源[:：]/.test(normalized)) return false;
  if (mentionsRawSource(normalized)) return false;
  const text = normalized
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/[*_`>#\[\]()（）:：，。,.!！?？\s-]/g, "");
  return text.length >= 12 && /[A-Za-z0-9\u4e00-\u9fff]/.test(text);
}

function maintenanceReportMentionsSource(report: string, relativePath: string): boolean {
  const normalizedReport = report.replace(/\\/g, "/");
  return knowledgePathMentionVariants(relativePath)
    .some((variant) => containsKnowledgePathMention(normalizedReport, variant) || containsKnowledgeAbsolutePathSegment(normalizedReport, variant));
}

function knowledgePathMentionVariants(relativePath: string): string[] {
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutExtension = normalizedPath.replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/i, "");
  const encodedPath = encodeKnowledgeRelativePath(normalizedPath);
  const encodedWithoutExtension = encodeKnowledgeRelativePath(withoutExtension);
  return uniqueKnowledgePathVariants([
    normalizedPath,
    withoutExtension,
    encodedPath,
    lowercasePercentEscapes(encodedPath),
    encodedWithoutExtension,
    lowercasePercentEscapes(encodedWithoutExtension)
  ]);
}

function uniqueKnowledgePathVariants(paths: string[]): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const current of paths) {
    if (!current || seen.has(current)) continue;
    seen.add(current);
    variants.push(current);
  }
  return variants;
}

function encodeKnowledgeRelativePath(relativePath: string): string {
  return relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function lowercasePercentEscapes(relativePath: string): string {
  return relativePath.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function containsKnowledgePathMention(text: string, relativePath: string): boolean {
  if (!relativePath) return false;
  let start = text.indexOf(relativePath);
  while (start !== -1) {
    const before = start > 0 ? text[start - 1] : "";
    const beforePrevious = start > 1 ? text[start - 2] : "";
    const afterIndex = start + relativePath.length;
    const after = text[afterIndex] ?? "";
    const afterNext = text[afterIndex + 1] ?? "";
    if (isKnowledgePathBoundaryBefore(before, beforePrevious) && isKnowledgePathBoundaryAfter(after, afterNext)) return true;
    start = text.indexOf(relativePath, start + 1);
  }
  return false;
}

function containsKnowledgeAbsolutePathSegment(text: string, relativePath: string): boolean {
  const absoluteSegment = `/${relativePath}`;
  let start = text.indexOf(absoluteSegment);
  while (start !== -1) {
    const afterIndex = start + absoluteSegment.length;
    const after = text[afterIndex] ?? "";
    const afterNext = text[afterIndex + 1] ?? "";
    if (isKnowledgePathBoundaryAfter(after, afterNext)) return true;
    start = text.indexOf(absoluteSegment, start + 1);
  }
  return false;
}

function isKnowledgePathBoundaryBefore(char: string, previousChar = ""): boolean {
  if (char === "/") return !previousChar || !/[A-Za-z0-9_\-.%\u4e00-\u9fff]/.test(previousChar);
  return !char || !/[A-Za-z0-9_\-./%\u4e00-\u9fff]/.test(char);
}

function isKnowledgePathBoundaryAfter(char: string, nextChar = ""): boolean {
  if (!char) return true;
  if (char === ".") {
    return !nextChar || /[\s\])}）】』」》,，;；:：!！?？]/.test(nextChar);
  }
  return !/[A-Za-z0-9_\-./%\u4e00-\u9fff]/.test(char);
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

function throwIfKnowledgeBaseCanceled(cancelRequested: boolean): void {
  if (cancelRequested) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
}

function normalizeCodexInactivityTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return CODEX_KNOWLEDGE_INACTIVITY_TIMEOUT_MS;
}

function rejectAfterTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      onTimeout();
      reject(new Error(message));
    }, Math.max(1, timeoutMs));
    promise.then((value) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(value);
    }, (error) => {
      if (timer) clearTimeout(timer);
      timer = null;
      reject(error);
    });
  });
}

function normalizeOpenCodeTaskTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return OPENCODE_KNOWLEDGE_TASK_TIMEOUT_MS;
}

function formatDurationForError(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${Math.round(ms / 1000)} 秒`;
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

async function saveSettingsSafely(plugin: CodexForObsidianPlugin): Promise<string | null> {
  try {
    await plugin.saveSettings(true);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function knowledgeTransactionRootsForMode(mode: KnowledgeBaseRunMode): string[] {
  if (mode === "lint") return ["outputs"];
  return ["raw/index.md", "wiki", "outputs", "inbox", "projects"];
}

function assertSafeKnowledgeTransactionRoots(snapshot: KnowledgeTransactionSnapshot, options: { allowedUnsafePaths?: Set<string> } = {}): void {
  for (const [relativePath, entry] of snapshot.entries) {
    if (options.allowedUnsafePaths?.has(normalizePath(relativePath))) continue;
    if (entry.kind === "symlink") {
      throw new Error(`知识库写入区不能包含 symlink：${relativePath}`);
    }
    if (entry.kind === "special") {
      throw new Error(`知识库写入区不能包含特殊文件：${relativePath}`);
    }
    if (entry.kind === "file" && typeof entry.nlink === "number" && entry.nlink > 1) {
      throw new Error(`知识库写入区不能包含 hardlink：${relativePath}`);
    }
  }
  for (const root of snapshot.roots) {
    const entry = snapshot.entries.get(root);
    if (!entry) continue;
    const rootIsFile = path.extname(root) !== "";
    if (rootIsFile && entry.kind !== "file") {
      throw new Error(`知识库写入区不是普通文件：${root}`);
    }
    if (!rootIsFile && entry.kind !== "directory") {
      throw new Error(`知识库写入区不是普通目录：${root}`);
    }
  }
}

async function assertSafeKnowledgeTransactionCurrentState(
  vaultPath: string,
  roots: string[],
  options: { allowedUnsafePaths?: Set<string> } = {}
): Promise<void> {
  assertSafeKnowledgeTransactionRoots(await snapshotKnowledgeTransaction(vaultPath, roots), options);
}

async function snapshotKnowledgeTransaction(vaultPath: string, roots: string[]): Promise<KnowledgeTransactionSnapshot> {
  const entries: KnowledgeTransactionSnapshot["entries"] = new Map();
  for (const root of roots) {
    const absolute = path.join(vaultPath, root);
    const paths = await walkExistingKnowledgeTransactionEntries(absolute);
    for (const entryPath of paths) {
      const relativePath = normalizePath(path.relative(vaultPath, entryPath));
      const stat = await fsp.lstat(entryPath);
      if (stat.isDirectory()) {
        entries.set(relativePath, {
          kind: "directory",
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else if (stat.isSymbolicLink()) {
        entries.set(relativePath, {
          kind: "symlink",
          target: await fsp.readlink(entryPath),
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else if (stat.isFile()) {
        entries.set(relativePath, {
          kind: "file",
          content: await fsp.readFile(entryPath),
          nlink: stat.nlink,
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else {
        entries.set(relativePath, {
          kind: "special",
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
  return { vaultPath, roots: roots.map((root) => normalizePath(root)), entries };
}

async function restoreKnowledgeTransaction(snapshot: KnowledgeTransactionSnapshot): Promise<void> {
  const currentEntries = (await snapshotKnowledgeTransaction(snapshot.vaultPath, snapshot.roots)).entries;
  for (const [relativePath] of sortedTransactionEntries(currentEntries).reverse()) {
    if (snapshot.entries.has(relativePath)) continue;
    if (!isTransactionPath(relativePath)) continue;
    await fsp.rm(path.join(snapshot.vaultPath, relativePath), { force: true, recursive: true });
  }
  for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries)) {
    if (!isTransactionPath(relativePath)) continue;
    const currentEntry = currentEntries.get(relativePath);
    if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
    await restoreKnowledgeTransactionEntry(snapshot.vaultPath, relativePath, entry);
  }
  for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries).reverse()) {
    if (entry.kind !== "directory" || !isTransactionPath(relativePath)) continue;
    const currentEntry = currentEntries.get(relativePath);
    if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
    await fsp.utimes(path.join(snapshot.vaultPath, relativePath), new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
  }
}

async function restoreKnowledgeTransactionOnFailure(snapshot: KnowledgeTransactionSnapshot | null): Promise<{ restored: boolean; error?: string }> {
  if (!snapshot) return { restored: false };
  try {
    await restoreKnowledgeTransaction(snapshot);
    return { restored: true };
  } catch (error) {
    return {
      restored: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function restoreKnowledgeTransactionEntry(vaultPath: string, relativePath: string, entry: KnowledgeTransactionSnapshotEntry): Promise<void> {
  const absolute = path.join(vaultPath, relativePath);
  if (entry.kind === "directory") {
    const current = await fsp.lstat(absolute).catch(() => null);
    if (current && !current.isDirectory()) {
      await fsp.rm(absolute, { force: true, recursive: true });
    }
    await fsp.mkdir(absolute, { recursive: true });
    await fsp.chmod(absolute, entry.mode).catch(() => undefined);
    await fsp.utimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
  } else if (entry.kind === "symlink" && entry.target !== undefined) {
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.rm(absolute, { force: true, recursive: true }).catch(() => undefined);
    await fsp.symlink(entry.target, absolute);
    await fsp.lutimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
  } else if (entry.kind === "file" && entry.content) {
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.rm(absolute, { force: true, recursive: true }).catch(() => undefined);
    await fsp.writeFile(absolute, entry.content);
    await fsp.chmod(absolute, entry.mode).catch(() => undefined);
    await fsp.utimes(absolute, new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
  }
}

async function commitLintReportOnly(vaultPath: string, snapshot: KnowledgeTransactionSnapshot | null, reportPath: string): Promise<void> {
  if (!snapshot) return;
  const reportSnapshot = await snapshotOptionalFile(path.join(vaultPath, reportPath));
  if (!reportSnapshot.existed || !reportSnapshot.content) return;
  await restoreKnowledgeTransactionChanges(snapshot, new Set([normalizePath(reportPath)]));
  await restoreOptionalFile(reportSnapshot);
}

async function restoreKnowledgeTransactionChanges(snapshot: KnowledgeTransactionSnapshot, keepPaths: Set<string>): Promise<void> {
  const keep = normalizeKeepPaths(keepPaths);
  const current = await snapshotKnowledgeTransaction(snapshot.vaultPath, snapshot.roots);
  for (const [relativePath] of sortedTransactionEntries(current.entries).reverse()) {
    if (snapshot.entries.has(relativePath)) continue;
    if (shouldKeepTransactionPath(relativePath, keep)) continue;
    if (!isTransactionPath(relativePath)) continue;
    await fsp.rm(path.join(snapshot.vaultPath, relativePath), { force: true, recursive: true });
  }
  for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries)) {
    if (!isTransactionPath(relativePath) || shouldKeepTransactionPath(relativePath, keep)) continue;
    const currentEntry = current.entries.get(relativePath);
    if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
    await restoreKnowledgeTransactionEntry(snapshot.vaultPath, relativePath, entry);
  }
  for (const [relativePath, entry] of sortedTransactionEntries(snapshot.entries).reverse()) {
    if (entry.kind !== "directory" || !isTransactionPath(relativePath) || shouldKeepTransactionPath(relativePath, keep)) continue;
    const currentEntry = current.entries.get(relativePath);
    if (currentEntry && sameTransactionEntry(entry, currentEntry)) continue;
    await fsp.utimes(path.join(snapshot.vaultPath, relativePath), new Date(entry.atimeMs), new Date(entry.mtimeMs)).catch(() => undefined);
  }
}

function normalizeKeepPaths(keepPaths: Set<string>): Set<string> {
  const keep = new Set<string>();
  for (const item of keepPaths) {
    const normalized = normalizePath(item);
    if (!normalized) continue;
    keep.add(normalized);
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index++) {
      keep.add(parts.slice(0, index).join("/"));
    }
  }
  return keep;
}

function shouldKeepTransactionPath(relativePath: string, keepPaths: Set<string>): boolean {
  return keepPaths.has(normalizePath(relativePath));
}

function sameTransactionEntry(left: KnowledgeTransactionSnapshotEntry, right: KnowledgeTransactionSnapshotEntry): boolean {
  if (left.kind !== right.kind) return false;
  if (left.mode !== right.mode) return false;
  if (Math.round(left.mtimeMs) !== Math.round(right.mtimeMs)) return false;
  if (left.kind === "file") return Boolean(left.content && right.content && left.content.equals(right.content));
  if (left.kind === "symlink") return left.target === right.target;
  if (left.kind === "special") return true;
  return true;
}

async function walkExistingKnowledgeTransactionEntries(rootPath: string): Promise<string[]> {
  const stat = await fsp.lstat(rootPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) return [rootPath];
  const result = [rootPath];
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    result.push(...await walkExistingKnowledgeTransactionEntries(path.join(rootPath, entry.name)));
  }
  return result;
}

function sortedTransactionEntries(entries: Map<string, KnowledgeTransactionSnapshotEntry>): Array<[string, KnowledgeTransactionSnapshotEntry]> {
  return Array.from(entries.entries()).sort(([left], [right]) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

function isTransactionPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return normalized === "raw/index.md"
    || normalized === "wiki"
    || normalized.startsWith("wiki/")
    || normalized === "outputs"
    || normalized.startsWith("outputs/")
    || normalized === "inbox"
    || normalized.startsWith("inbox/")
    || normalized === "projects"
    || normalized.startsWith("projects/");
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

function buildMaintenanceSummary(output: string, mode: KnowledgeBaseRunMode, structure?: StructureNormalizationResult): string {
  const base = output.trim().slice(0, 800) || `知识库${labelForRunMode(mode)}完成`;
  if (!structure) return base;
  const line = `结构整理：移动 ${structure.moves.length} 项，更新引用 ${structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0)} 处，跳过 ${structure.skipped.length} 项。`;
  return `${base}\n${line}`.slice(0, 1000);
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

function extractFirstUrl(value: string): string | null {
  return value.match(URL_PATTERN)?.[0] ?? null;
}

function isWeChatUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function stripCollectPrefix(value: string): string {
  return value.replace(/^(收集|收藏|剪藏|保存到\s*raw|网页收藏|公众号收集)[:：\s]*/i, "").trim();
}

function extractArticleMarkdown(html: string, url: string): { title: string; markdown: string } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  for (const selector of ["script", "style", "noscript", "svg", "iframe"]) {
    for (const node of Array.from(doc.querySelectorAll(selector))) node.remove();
  }
  const title = cleanInlineText(
    doc.querySelector("meta[property='og:title']")?.getAttribute("content")
    || doc.querySelector("title")?.textContent
    || new URL(url).hostname
  );
  const content = doc.querySelector("#js_content") || doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const markdown = content ? domNodeToMarkdown(content).replace(/\n{3,}/g, "\n\n").trim() : "";
  return { title, markdown };
}

function domNodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return cleanTextNode(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const children = Array.from(el.childNodes).map(domNodeToMarkdown).join("");
  if (tag === "br") return "\n";
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag.slice(1)))} ${cleanInlineText(children)}\n\n`;
  if (tag === "p" || tag === "section" || tag === "div" || tag === "article") return children.trim() ? `\n\n${children.trim()}\n\n` : "";
  if (tag === "li") return `\n- ${children.trim()}`;
  if (tag === "blockquote") return children.trim().split("\n").map((line) => `> ${line.trim()}`).join("\n");
  if (tag === "a") {
    const href = el.getAttribute("href");
    const text = cleanInlineText(children) || href || "";
    return href ? `[${text}](${href})` : text;
  }
  if (tag === "img") {
    const src = el.getAttribute("data-src") || el.getAttribute("src");
    const alt = el.getAttribute("alt") || "image";
    return src ? `\n\n![${alt}](${src})\n\n` : "";
  }
  if (tag === "pre" || tag === "code") return `\n\n\`\`\`\n${el.textContent?.trim() ?? ""}\n\`\`\`\n\n`;
  return children;
}

function cleanTextNode(value: string): string {
  return value.replace(/\s+/g, " ");
}

function cleanInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeFileName(value: string): string {
  return cleanInlineText(value).replace(/[\\/:*?"<>|#\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "未命名资料";
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
