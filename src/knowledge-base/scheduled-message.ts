import type { KnowledgeBaseRunResult } from "./types";

export function buildScheduledKnowledgeBaseMessage(result: KnowledgeBaseRunResult, reportText = ""): string {
  const status = result.status === "success" ? "成功" : result.status === "canceled" ? "已取消" : "失败";
  const summary = result.status === "success"
    ? compactScheduledSummary([
      extractKnowledgeBaseReportConclusion(reportText) || compactScheduledSummary(result.summary),
      externalRawAdditionsSummary(result.externalRawAdditions)
    ].filter(Boolean).join(" "))
    : compactScheduledSummary(result.error || result.summary || "未知错误");
  return [
    result.status === "success" ? "每日维护执行完毕。" : result.status === "canceled" ? "每日维护已取消。" : "每日维护执行失败。",
    "",
    "简短报告：",
    `- 状态：${status}`,
    result.reportPath ? `- 报告：${result.reportPath}` : "",
    summary ? `- 摘要：${summary}` : ""
  ].filter(Boolean).join("\n");
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
