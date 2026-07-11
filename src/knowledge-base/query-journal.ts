import type CodexForObsidianPlugin from "../main";
import { OpenCodeBackend } from "../core/opencode-backend";
import type { PermissionMode } from "../types/app-server";
import type { AgentBackendKind } from "../agent/types";
import type { KnowledgeBaseManagedThreadKind, StoredAttachment } from "../settings/settings";
import type { KnowledgeBaseChatResult, KnowledgeBaseTurnOptionOverrides } from "./command-router";
import type { KnowledgeBaseCaptureService } from "./capture";
import { buildKnowledgeBaseJournalPrompt, ensureJournalTargetFolders, resolveJournalDailyTarget, stripJournalPrefix } from "./journal";
import { buildKnowledgeBaseAskPrompt } from "./prompt";
import { buildKnowledgeBaseCitationSummary, findKnowledgeBaseAskMatches, stripAskCommand } from "./query";
import type { KnowledgeBaseCitationSummary, KnowledgeBaseSource } from "./types";
import { exists } from "./utils";

export interface KnowledgeBaseQueryJournalContext {
  isRunning(): boolean;
  beginRun(): void;
  finishRun(): void;
  resolveRulesFile(): Promise<{ relativePath: string; exists: boolean; useCustomRulesFile: boolean }>;
  resolveKnowledgeBackend(): AgentBackendKind;
  runKnowledgeAgentTask(input: {
    prompt: string;
    sources: KnowledgeBaseSource[];
    permission: PermissionMode;
    codexWriteScope: "knowledge-base" | "knowledge-lint" | "journal";
    turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides;
    managedKind: KnowledgeBaseManagedThreadKind;
  }): Promise<string>;
}

export class KnowledgeBaseQueryJournalService {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly captureService: KnowledgeBaseCaptureService,
    private readonly context: KnowledgeBaseQueryJournalContext
  ) {}

  async answerQuestion(text: string, turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    if (this.context.isRunning()) {
      return { status: "failed", message: "已有知识库任务正在运行" };
    }
    this.context.beginRun();
    try {
      const question = stripAskCommand(text);
      const rules = await this.context.resolveRulesFile();
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
      const output = await this.context.runKnowledgeAgentTask({
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
      this.context.finishRun();
    }
  }

  async writeDailyJournal(text: string, attachments: StoredAttachment[], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult> {
    if (this.context.isRunning()) {
      return { status: "failed", message: "已有知识库任务正在运行" };
    }
    this.context.beginRun();
    try {
      const vaultPath = this.plugin.getVaultPath();
      const copiedAttachments = await this.captureService.copyAttachmentsToRaw(attachments);
      const request = stripJournalPrefix(text).trim() || "写日记";
      const backend = this.context.resolveKnowledgeBackend();
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
      const output = await this.context.runKnowledgeAgentTask({
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
      this.context.finishRun();
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
}

function formatAskAnswer(output: string, citations: KnowledgeBaseCitationSummary): string {
  const text = output.trim();
  if (!text) return citations.status === "none" ? "未找到相关本地依据，Agent 未返回回答。" : "Agent 未返回回答。";
  if (citations.status !== "none") return text;
  if (/未找到相关本地依据|无本地依据|未找到相关本地来源|未找到相关\s*(wiki|Wiki)\s*笔记/.test(text)) return text;
  return `未找到相关本地依据。\n\n${text}`;
}
