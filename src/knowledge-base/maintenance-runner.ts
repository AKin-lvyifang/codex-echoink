import * as path from "path";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { recordKnowledgeBaseMaintenanceRun, type KnowledgeBaseManagedThreadKind } from "../settings/settings";
import type { PermissionMode } from "../types/app-server";
import { verifyDigestEvidence } from "./digest-evidence";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import {
  ensureKnowledgeBaseFallbackReport,
  isLintOnlyKnowledgeBaseReport,
  readFreshKnowledgeBaseReportExcerpt,
  readKnowledgeBaseReportMtime,
  recoveredLintReportSummary,
  writeKnowledgeBaseFailureReport
} from "./report";
import { discoverKnowledgeBaseSources } from "./discovery";
import { buildKnowledgeBasePrompt } from "./prompt";
import {
  classifyRawSnapshotChanges,
  formatRawIntegrityError,
  isRawIntegrityErrorMessage,
  rawSnapshotChangeMessages,
  restoreRawMetadata,
  restoreRawSnapshot,
  snapshotRawFileContents
} from "./raw-integrity";
import type { RawContentSnapshot, RawSnapshot } from "./raw-integrity";
import {
  assertSafeRawEntries,
  assertSafeRawRoot,
  fingerprintKnowledgeRawContentSnapshot,
  snapshotKnowledgeRawFiles,
  writeRawDigestMetadataForSources
} from "./raw-calibration";
import { extractRequestedRawPaths, processedSourcesForRunMode, selectSourcesForRunMode } from "./source-selection";
import {
  appendConflictDuplicateCleanupReport,
  appendExternalRawAdditionsReport,
  appendKnowledgeBaseWarning,
  appendStructureNormalizationReport,
  buildMaintenanceSummary,
  cloneList,
  cloneProcessedSources,
  collectExternalRawAdditions,
  ensureKnowledgeBaseFolders,
  formatCancelResultMessage,
  labelForRunMode,
  normalizeProcessedSources,
  rewriteProcessedSources,
  saveSettingsSafely,
  shouldWriteKnowledgeBaseFailureReportForMode,
  syncRewrittenRawProcessedSourceStats,
  writeKnowledgeBaseTracker
} from "./maintenance";
import { normalizeKnowledgeBaseStructure, rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import {
  assertSafeKnowledgeTransactionCurrentState,
  assertSafeKnowledgeTransactionRoots,
  commitLintReportOnly,
  disposeKnowledgeTransactionSnapshot,
  knowledgeTransactionRootsForMode,
  quarantinePreexistingKnowledgeConflictDuplicates,
  restoreKnowledgeTransactionOnFailure,
  restoreOptionalFile,
  snapshotKnowledgeTransaction,
  snapshotOptionalFile,
  type KnowledgeConflictDuplicateCleanup,
  type KnowledgeTransactionSnapshot,
  type OptionalFileSnapshot
} from "./transaction-snapshot";
import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";
import { exists } from "./utils";
import type { KnowledgeBaseTurnOptionOverrides } from "./command-router";
import type { KnowledgeAgentTaskOutput } from "./agent-runner";

const MAX_ATTACHED_SOURCES = 20;

export interface KnowledgeBaseMaintenanceRunnerContext {
  isRunning(): boolean;
  beginRun(): void;
  finishRun(): void;
  isCancelRequested(): boolean;
  resolveRulesFile(): Promise<{ relativePath: string; absolutePath: string; exists: boolean; useCustomRulesFile: boolean }>;
  runKnowledgeAgentTask(input: {
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
  }): Promise<KnowledgeAgentTaskOutput>;
}

export class KnowledgeBaseMaintenanceRunner {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly context: KnowledgeBaseMaintenanceRunnerContext
  ) {}

  async runMaintenance(mode: KnowledgeBaseRunMode = "maintain", userRequest = "", turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseRunResult> {
    if (this.context.isRunning()) {
      new Notice("知识库维护正在运行");
      return {
        status: "failed",
        reportPath: this.plugin.settings.knowledgeBase.lastReportPath,
        summary: "",
        processedSources: [],
        error: "已有任务正在运行"
      };
    }
    this.context.beginRun();
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
      this.throwIfCanceled();
      const transactionRoots = knowledgeTransactionRootsForMode(mode);
      transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      this.throwIfCanceled();
      conflictDuplicateCleanup = await quarantinePreexistingKnowledgeConflictDuplicates(vaultPath, transactionBefore, startedAt, mode);
      if (conflictDuplicateCleanup.moved.length) {
        await disposeKnowledgeTransactionSnapshot(transactionBefore);
        transactionBefore = await snapshotKnowledgeTransaction(vaultPath, transactionRoots);
      }
      this.throwIfCanceled();
      assertSafeKnowledgeTransactionRoots(transactionBefore);
      trackerBeforeRun = await snapshotOptionalFile(path.join(vaultPath, "outputs", ".ingest-tracker.md"));
      this.throwIfCanceled();
      rawBeforeContents = await snapshotRawFileContents(vaultPath);
      this.throwIfCanceled();
      rawBefore = fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
      assertSafeRawRoot(rawBeforeContents);
      assertSafeRawEntries(rawBeforeContents);
      discovery = await discoverKnowledgeBaseSources(vaultPath, settings.processedSources, mode);
      this.throwIfCanceled();
      reportMtimeBefore = await readKnowledgeBaseReportMtime(vaultPath, discovery.reportPath);
      await ensureKnowledgeBaseFolders(vaultPath, mode);
      this.throwIfCanceled();
      const rules = await this.context.resolveRulesFile();
      if (rules.useCustomRulesFile && !rules.exists) {
        throw new Error(`知识库操作指南文件不存在：${rules.relativePath}。请在设置里修正路径。`);
      }
      this.throwIfCanceled();
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
      this.throwIfCanceled();

      lintReportRecoveryEligible = mode === "lint";
      const agentOutput = await this.context.runKnowledgeAgentTask({
        prompt,
        sources: runSources,
        permission: mode === "lint" ? "read-only" : "workspace-write",
        codexWriteScope: mode === "lint" ? "knowledge-lint" : "knowledge-base",
        turnOptionOverrides,
        managedKind: mode
      });
      const output = agentOutput.text;
      lintReportRecoveryEligible = false;
      this.throwIfCanceled();

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
      this.throwIfCanceled();

      const structure = mode === "maintain"
        ? await normalizeKnowledgeBaseStructure(vaultPath, { lastReportPath: settings.lastReportPath || discovery.reportPath })
        : undefined;
      this.throwIfCanceled();
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
      this.throwIfCanceled();

      let processedChangedSources = await normalizeProcessedSources(vaultPath, runSources, structure?.pathRewrites ?? []);
      this.throwIfCanceled();
      if (mode === "maintain" && structure?.pathRewrites.length) {
        nextProcessedSources = await syncRewrittenRawProcessedSourceStats(vaultPath, nextProcessedSources, structure.pathRewrites);
      }
      this.throwIfCanceled();
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
      this.throwIfCanceled();
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
      this.throwIfCanceled();
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
      this.throwIfCanceled();
      if (mode === "lint") {
        await commitLintReportOnly(vaultPath, transactionBefore, reportPath);
      }
      this.throwIfCanceled();
      if (structure) await appendStructureNormalizationReport(vaultPath, reportPath, structure);
      if (conflictDuplicateCleanup.moved.length) {
        await appendConflictDuplicateCleanupReport(vaultPath, reportPath, conflictDuplicateCleanup);
      }
      this.throwIfCanceled();
      if (externalRawAdditionsDuringRun.size) {
        await appendExternalRawAdditionsReport(vaultPath, reportPath, Array.from(externalRawAdditionsDuringRun));
      }
      this.throwIfCanceled();
      if (mode === "maintain" || mode === "reingest") {
        await writeKnowledgeBaseTracker(vaultPath, nextProcessedSources, startedAt);
        trackerWritten = true;
        this.throwIfCanceled();
        settings.processedSources = nextProcessedSources;
      }
      this.throwIfCanceled();
      settings.lastRunAt = Date.now();
      settings.lastRunStatus = "success";
      settings.lastReportPath = reportPath;
      settings.lastSummary = buildMaintenanceSummary(output, mode, structure, conflictDuplicateCleanup);
      recordKnowledgeBaseMaintenanceRun(settings, { status: "success", mode, reportPath });
      await this.plugin.saveSettings(true);
      this.throwIfCanceled();
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
      let canceled = this.context.isCancelRequested() || isKnowledgeBaseCancelError(message);
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
      canceled = canceled || this.context.isCancelRequested();
      if (canceled) {
        return await finishCanceledRun(message);
      }
      if (lintReportRecoveryEligible && mode === "lint" && discovery?.reportPath && !isRawIntegrityErrorMessage(message)) {
        try {
          const reportExcerpt = await readFreshKnowledgeBaseReportExcerpt(vaultPath, discovery.reportPath, startedAt, { previousMtimeMs: reportMtimeBefore });
          if (reportExcerpt && isLintOnlyKnowledgeBaseReport(reportExcerpt)) {
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            await commitLintReportOnly(vaultPath, transactionBefore, discovery.reportPath);
            if (externalRawAdditionsDuringRun.size) {
              await appendExternalRawAdditionsReport(vaultPath, discovery.reportPath, Array.from(externalRawAdditionsDuringRun));
            }
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
            trackerWritten = false;
            settings.lastRunAt = Date.now();
            settings.lastRunStatus = "success";
            settings.lastReportPath = discovery.reportPath;
            settings.lastError = "";
            settings.lastSummary = recoveredLintReportSummary(discovery.reportPath);
            recordKnowledgeBaseMaintenanceRun(settings, { status: "success", mode, reportPath: discovery.reportPath });
            const saveError = await saveSettingsSafely(this.plugin);
            if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR, saveError);
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
          if (this.context.isCancelRequested()) return await finishCanceledRun(KNOWLEDGE_BASE_CANCEL_ERROR);
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
      await disposeKnowledgeTransactionSnapshot(transactionBefore);
      this.context.finishRun();
    }
  }

  private throwIfCanceled(): void {
    if (this.context.isCancelRequested()) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
}
