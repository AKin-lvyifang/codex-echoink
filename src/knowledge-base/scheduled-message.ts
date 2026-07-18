import type { KnowledgeBaseRunResult } from "./types";

export function buildScheduledKnowledgeBaseMessage(result: KnowledgeBaseRunResult, reportText = ""): string {
  const status = scheduledStatusLabel(result);
  const summary = result.status === "success"
    ? compactScheduledSummary([
      completionSummary(result),
      extractKnowledgeBaseReportConclusion(reportText) || compactScheduledSummary(result.summary),
      externalRawAdditionsSummary(result.externalRawAdditions),
      warningSummary(result)
    ].filter(Boolean).join(" "))
    : compactScheduledSummary(result.error || result.summary || "未知错误");
  return [
    scheduledIntro(result),
    "",
    "简短报告：",
    `- 状态：${status}`,
    result.reportPath ? `- 报告：${result.reportPath}` : "",
    result.failureCode ? `- 错误码：${result.failureCode}` : "",
    summary ? `- 摘要：${summary}` : ""
  ].filter(Boolean).join("\n");
}

function scheduledStatusLabel(result: KnowledgeBaseRunResult): string {
  if (result.status === "canceled") return "已取消";
  if (result.status === "failed") return "失败";
  if (result.completion === "partial") return "部分完成";
  if (result.completion === "recovered") return "恢复后完成";
  if (result.completion === "noop") return "已检查（无新来源）";
  return "成功";
}

function scheduledIntro(result: KnowledgeBaseRunResult): string {
  if (result.status === "canceled") return "每日维护已取消。";
  if (result.status === "failed") return "每日维护执行失败。";
  if (result.completion === "partial") return "每日维护已部分完成。";
  if (result.completion === "recovered") return "每日维护已自动恢复并完成。";
  if (result.completion === "noop") return "每日维护检查完毕，没有新来源需要调用 Agent。";
  return "每日维护执行完毕。";
}

function completionSummary(result: KnowledgeBaseRunResult): string {
  if (result.completion === "partial") {
    const completed = result.processedSources.length;
    const pending = result.pendingSources?.length ?? 0;
    return `已完成 ${completed} 个来源，${pending} 个来源已安全留待下轮。`;
  }
  if (result.completion === "recovered") {
    const attempts = result.attempts?.length ?? 0;
    return attempts > 1 ? `首选 Agent 未完成，已由备用 Agent 接续完成，共 ${attempts} 次尝试。` : "本轮经过自动恢复后完成。";
  }
  if (result.completion === "noop") return "没有待消化的新来源；Harness 已完成状态核对。";
  return "";
}

function warningSummary(result: KnowledgeBaseRunResult): string {
  if (!result.warnings?.length) return "";
  const messages = result.warnings.slice(0, 2).map((warning) => warning.message).join("；");
  return `另有 ${result.warnings.length} 条提醒：${messages}`;
}

function externalRawAdditionsSummary(additions: string[] | undefined): string {
  if (!additions?.length) return "";
  return `运行中新出现 ${additions.length} 个 raw，已保留，留到下次 /maintain。`;
}

export function extractKnowledgeBaseReportConclusion(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /(?:^|\n)##\s*一眼结论\s*\n+([\s\S]*?)(?=\n##\s+|$)/.exec(normalized);
  return compactScheduledSummary(match?.[1] ?? "");
}

function compactScheduledSummary(value: string, maxLength = 220): string {
  const compact = value
    .replace(/^---[\s\S]*?---/m, "")
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}
