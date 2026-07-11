import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { isKnowledgeBaseCancelError, KNOWLEDGE_BASE_CANCEL_ERROR } from "./failure";
import { runRawDigestCalibration } from "./raw-calibration";
import {
  cloneProcessedSources,
  formatCancelResultMessage,
  saveSettingsSafely,
  writeKnowledgeBaseTracker
} from "./maintenance";
import type { KnowledgeBaseRunResult } from "./types";

export interface KnowledgeBaseRawDigestCalibrationRunnerContext {
  isRunning(): boolean;
  beginRun(): void;
  finishRun(refreshSurfaces: boolean): void;
  isCancelRequested(): boolean;
}

export class KnowledgeBaseRawDigestCalibrationRunner {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly context: KnowledgeBaseRawDigestCalibrationRunnerContext
  ) {}

  async calibrateRawDigestStatus(): Promise<KnowledgeBaseRunResult> {
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
          this.throwIfCanceled();
        },
        writeTracker: async (processed, updatedAt) => {
          this.throwIfCanceled();
          await writeKnowledgeBaseTracker(vaultPath, processed, updatedAt);
          this.throwIfCanceled();
        },
        commit: async (commit) => {
          this.throwIfCanceled();
          settings.processedSources = commit.nextProcessedSources;
          settings.lastRunStatus = "success";
          settings.lastReportPath = commit.reportPath;
          settings.lastSummary = commit.summary;
          settings.lastRunAt = Date.now();
          await this.plugin.saveSettings(true);
          this.throwIfCanceled();
        }
      });
      new Notice("Raw 状态校准完成");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const canceled = this.context.isCancelRequested() || isKnowledgeBaseCancelError(message);
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
      this.context.finishRun(Boolean(vaultPath));
    }
  }

  private throwIfCanceled(): void {
    if (this.context.isCancelRequested()) throw new Error(KNOWLEDGE_BASE_CANCEL_ERROR);
  }
}
