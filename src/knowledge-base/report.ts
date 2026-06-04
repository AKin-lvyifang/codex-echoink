import * as fsp from "fs/promises";
import * as path from "path";
import { isRawIntegrityErrorMessage } from "./raw-integrity";
import type { KnowledgeBaseRunMode, KnowledgeBaseSource } from "./types";

export async function readKnowledgeBaseReportExcerpt(vaultPath: string, reportPath: string, maxChars = 1000): Promise<string | null> {
  const text = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const excerpt = text.trim().slice(0, maxChars).trim();
  return excerpt || null;
}

export async function readKnowledgeBaseReportText(vaultPath: string, reportPath: string): Promise<string> {
  const absolute = resolveKnowledgeBaseReportPath(vaultPath, reportPath);
  if (!absolute) return "";
  const stat = await fsp.lstat(absolute).catch(() => null);
  if (!stat?.isFile()) return "";
  return fsp.readFile(absolute, "utf8").catch(() => "");
}

export async function readKnowledgeBaseReportMtime(vaultPath: string, reportPath: string): Promise<number | null> {
  const absolute = resolveKnowledgeBaseReportPath(vaultPath, reportPath);
  if (!absolute) return null;
  const stat = await fsp.lstat(absolute).catch(() => null);
  return stat?.isFile() ? stat.mtimeMs : null;
}

export async function readFreshKnowledgeBaseReportExcerpt(
  vaultPath: string,
  reportPath: string,
  minimumMtimeMs: number,
  options: { previousMtimeMs?: number | null; maxChars?: number } = {}
): Promise<string | null> {
  const absolute = resolveKnowledgeBaseReportPath(vaultPath, reportPath);
  if (!absolute) return null;
  const stat = await fsp.lstat(absolute).catch(() => null);
  if (!isFreshReportMtime(stat?.isFile() ? stat.mtimeMs : null, minimumMtimeMs, options.previousMtimeMs)) return null;
  return readKnowledgeBaseReportExcerpt(vaultPath, reportPath, options.maxChars ?? 1000);
}

export function isLintOnlyKnowledgeBaseReport(text: string): boolean {
  return /mode:\s*lint-only/i.test(text)
    || hasUnnegatedLintOnlySignal(text, /\blint-only\b/i)
    || hasUnnegatedLintOnlySignal(text, /只执行\s*Lint/i)
    || hasUnnegatedLintOnlySignal(text, /只执行[^\n\r]{0,40}体检/);
}

export function recoveredLintReportSummary(reportPath: string): string {
  const suffix = reportPath.trim() ? `报告：${reportPath.trim()}` : "报告已生成。";
  return `体检报告已生成。Codex 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。${suffix}`;
}

export function shouldRecoverKnowledgeBaseLintFailure(errorMessage: string, reportText: string | null): boolean {
  if (isRawIntegrityErrorMessage(errorMessage)) return false;
  return Boolean(reportText && isLintOnlyKnowledgeBaseReport(reportText));
}

export async function ensureKnowledgeBaseFallbackReport(
  vaultPath: string,
  reportPath: string,
  input: { mode: KnowledgeBaseRunMode; output: string; sources: Pick<KnowledgeBaseSource, "relativePath">[]; startedAt: number; previousMtimeMs?: number | null }
): Promise<void> {
  const absolute = requireKnowledgeBaseReportPath(vaultPath, reportPath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await fsp.lstat(absolute).catch(() => null);
  const existingFresh = isFreshReportMtime(existing?.isFile() ? existing.mtimeMs : null, input.startedAt, input.previousMtimeMs);
  let existingFreshNonLint = false;
  if (existingFresh) {
    if (input.mode !== "lint") return;
    const existingText = await readKnowledgeBaseReportExcerpt(vaultPath, reportPath, 4000);
    if (existingText && isLintOnlyKnowledgeBaseReport(existingText)) {
      await ensureLintOnlyReportModeMetadata(vaultPath, reportPath);
      return;
    }
    existingFreshNonLint = true;
  }
  const reportStatus = existingFreshNonLint
    ? "- 同名报告存在但不是 lint-only 体检报告，已由插件生成 fallback，避免复用错误报告。"
    : existing?.isFile()
      ? "- 同名报告存在但早于本轮任务开始时间，已由插件生成 fallback，避免复用旧报告。"
      : "- Agent 未写出报告，已由插件生成 fallback。";
  const lines = [
    "---",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "source: codex-echoink",
    ...(input.mode === "lint" ? ["mode: lint-only"] : []),
    "fallback: true",
    "---",
    "",
    `# 知识库${labelForRunMode(input.mode)}报告 — ${formatDateForTitle(new Date(input.startedAt))}`,
    "",
    "## 一眼结论",
    input.output.trim() || "任务已完成，但 Agent 未返回摘要或未更新本轮报告。",
    "",
    "## 本轮来源",
    ...(input.sources.length ? input.sources.map((source) => `- [[${source.relativePath}]]`) : ["- 无新增或变更 raw 文件"]),
    "",
    "## 报告状态",
    reportStatus,
    ""
  ];
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, lines.join("\n"));
}

async function ensureLintOnlyReportModeMetadata(vaultPath: string, reportPath: string): Promise<void> {
  const text = await readKnowledgeBaseReportText(vaultPath, reportPath);
  if (!text.trim()) return;
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end !== -1) {
      const frontmatter = normalized.slice(4, end);
      const lines = frontmatter ? frontmatter.split("\n") : [];
      let sawMode = false;
      let changed = false;
      const updatedLines: string[] = [];
      for (const line of lines) {
        if (/^mode\s*:/i.test(line)) {
          if (!sawMode) {
            updatedLines.push("mode: lint-only");
            sawMode = true;
            if (!/^mode:\s*lint-only\s*$/i.test(line)) changed = true;
          } else {
            changed = true;
          }
          continue;
        }
        updatedLines.push(line);
      }
      if (!sawMode) {
        updatedLines.push("mode: lint-only");
        changed = true;
      }
      if (changed) {
        const updated = `---\n${updatedLines.join("\n")}${normalized.slice(end)}`;
        await writeKnowledgeBaseReportFile(vaultPath, reportPath, updated);
      }
      return;
    }
  }
  if (/(^|\n)mode:\s*lint-only(\n|$)/i.test(normalized)) return;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, [
    "---",
    "mode: lint-only",
    "---",
    "",
    normalized
  ].join("\n"));
}

export async function writeKnowledgeBaseReportFile(vaultPath: string, reportPath: string, content: string): Promise<void> {
  const absolute = requireKnowledgeBaseReportPath(vaultPath, reportPath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content, "utf8");
    await fsp.rename(temp, absolute);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requireKnowledgeBaseReportPath(vaultPath: string, reportPath: string): string {
  const absolute = resolveKnowledgeBaseReportPath(vaultPath, reportPath);
  if (!absolute) throw new Error("知识库报告路径为空");
  return absolute;
}

function resolveKnowledgeBaseReportPath(vaultPath: string, reportPath: string): string | null {
  const trimmed = reportPath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) throw new Error(`知识库报告路径越界：${reportPath}`);
  const root = path.resolve(vaultPath);
  const absolute = path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`知识库报告路径越界：${reportPath}`);
  }
  return absolute;
}

function labelForRunMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "体检";
  if (mode === "reingest") return "重新提炼";
  if (mode === "outputs") return "处理 outputs";
  if (mode === "inbox") return "处理 inbox";
  return "维护";
}

function isFreshReportMtime(mtimeMs: number | null | undefined, minimumMtimeMs: number, previousMtimeMs?: number | null): boolean {
  if (typeof mtimeMs !== "number") return false;
  if (mtimeMs < minimumMtimeMs) return false;
  if (typeof previousMtimeMs === "number" && mtimeMs <= previousMtimeMs) return false;
  return true;
}

function formatDateForTitle(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function hasUnnegatedLintOnlySignal(text: string, signal: RegExp): boolean {
  const match = signal.exec(text);
  if (!match || typeof match.index !== "number") return false;
  const before = text.slice(Math.max(0, match.index - 24), match.index);
  return !/(不是|并非|非|不属于|不算|not|non)\s*$/i.test(before);
}
