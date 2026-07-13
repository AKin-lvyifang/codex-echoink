import type { TurnOptions } from "../core/codex-service";
import type { HarnessRunResult } from "../harness/contracts/run";
import type { ReviewReportKind, StoredAttachment, StoredSession } from "../settings/settings";
import { knowledgeBaseHelpText, parseKnowledgeBaseCommand } from "./commands";
import type { KnowledgeBaseInitializationPreview } from "./initializer";
import { buildKnowledgeBaseMaintainReportPayload, knowledgeBaseRunModeForCommandIntent, type KnowledgeBaseMessageUiPayload } from "./maintain-report-card";
import { labelForRunMode } from "./maintenance";
import type { KnowledgeBaseCitationSummary, KnowledgeBaseRunMode, KnowledgeBaseRunResult } from "./types";

export interface KnowledgeBaseChatResult {
  status: "success" | "failed" | "canceled";
  message: string;
  harnessResult?: HarnessRunResult;
  citations?: KnowledgeBaseCitationSummary;
  ui?: KnowledgeBaseMessageUiPayload;
  followUpCommand?: string;
}

export interface KnowledgeBaseTurnOptionOverrides extends Pick<TurnOptions, "model" | "reasoning" | "serviceTier" | "mcpEnabled" | "workspaceResources"> {
  codexInactivityTimeoutMs?: number;
  opencodeTaskTimeoutMs?: number;
  hermesTaskTimeoutMs?: number;
  harnessSession?: StoredSession;
}

export interface KnowledgeBaseCommandRouterContext {
  previewInitialization(): Promise<KnowledgeBaseInitializationPreview>;
  executeInitialization(preview: KnowledgeBaseInitializationPreview): Promise<{ summary: string; rulesFilePath: string }>;
  markInitializationFailed(): Promise<void>;
  cancelMaintenance(): Promise<void>;
  calibrateRawDigestStatus(): Promise<KnowledgeBaseRunResult>;
  runMaintenance(mode: KnowledgeBaseRunMode, userRequest: string, turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseRunResult>;
  answerQuestion(text: string, turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult>;
  runWeeklyReview(kind: ReviewReportKind): Promise<KnowledgeBaseChatResult>;
  writeDailyJournal(text: string, attachments: StoredAttachment[], turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides): Promise<KnowledgeBaseChatResult>;
  captureChatInput(target: "inbox" | "raw-articles" | "raw-attachments", text: string, attachments: StoredAttachment[]): Promise<string[]>;
  lastReportPath(): string;
  formatFailureContext(reportPath: string): string;
}

export async function handleKnowledgeBaseUserMessage(
  context: KnowledgeBaseCommandRouterContext,
  text: string,
  attachments: StoredAttachment[] = [],
  turnOptionOverrides?: KnowledgeBaseTurnOptionOverrides
): Promise<KnowledgeBaseChatResult> {
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
        const preview = await context.previewInitialization();
        const result = await context.executeInitialization(preview);
        return {
          status: "success",
          message: result.summary,
          followUpCommand: "/check 初始化后体检当前 vault，只报告问题，不移动文件，不删除文件。"
        };
      }
      const preview = await context.previewInitialization();
      return { status: "success", message: preview.summary };
    }
    if (command.intent === "cancel") {
      await context.cancelMaintenance();
      return { status: "success", message: "已请求取消当前知识库任务。" };
    }
    if (command.intent === "calibrate") {
      const result = await context.calibrateRawDigestStatus();
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
      const result = await context.runMaintenance(mode, text, turnOptionOverrides);
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
          context.formatFailureContext(result.reportPath)
        ].filter(Boolean).join("\n"),
        ui: buildKnowledgeBaseMaintainReportPayload(mode, result)
      };
    }
    if (command.intent === "ask") {
      return await context.answerQuestion(text, turnOptionOverrides);
    }
    if (command.intent === "review") {
      return await context.runWeeklyReview(command.reviewKind ?? "knowledge-base");
    }
    if (command.intent === "journal") {
      return await context.writeDailyJournal(text, attachments, turnOptionOverrides);
    }
    const target = command.target === "journal" ? "inbox" : command.target ?? (attachments.length ? "raw-attachments" : "inbox");
    const paths = await context.captureChatInput(target, text, attachments);
    return {
      status: "success",
      message: paths.length ? `已收集到：\n${paths.map((item) => `- ${item}`).join("\n")}` : "没有可收集的内容。"
    };
  } catch (error) {
    if (command.intent === "init") await context.markInitializationFailed();
    const message = error instanceof Error ? error.message : String(error);
    const mode = knowledgeBaseRunModeForCommandIntent(command.intent);
    if (mode) {
      return {
        status: "failed",
        message,
        ui: buildKnowledgeBaseMaintainReportPayload(mode, {
          status: "failed",
          reportPath: context.lastReportPath(),
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
