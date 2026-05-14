import * as fsp from "fs/promises";
import * as path from "path";

export async function readKnowledgeBaseReportExcerpt(vaultPath: string, reportPath: string, maxChars = 1000): Promise<string | null> {
  if (!reportPath.trim()) return null;
  const absolute = path.join(vaultPath, reportPath);
  const text = await fsp.readFile(absolute, "utf8").catch(() => "");
  const excerpt = text.trim().slice(0, maxChars).trim();
  return excerpt || null;
}

export function isLintOnlyKnowledgeBaseReport(text: string): boolean {
  return /mode:\s*lint-only/i.test(text) || /lint-only/i.test(text) || /只执行\s*Lint/.test(text) || /只执行.*体检/.test(text);
}

export function recoveredLintReportSummary(reportPath: string): string {
  const suffix = reportPath.trim() ? `报告：${reportPath.trim()}` : "报告已生成。";
  return `体检报告已生成。Codex 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。${suffix}`;
}
