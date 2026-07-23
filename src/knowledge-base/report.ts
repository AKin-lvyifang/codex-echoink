import * as fsp from "fs/promises";
import * as path from "path";
import { swallowError } from "../core/error-handling";
import type { AgentBackendKind } from "../agent/types";
import type {
  MaintenanceWorkflowFileCas,
  MaintenanceWorkflowManagedUpsertDraft
} from "../harness/maintenance/workflow-wal";
import type { DigestEvidencePendingSource } from "./digest-evidence";
import { normalizeMaintenanceContentMode } from "./maintenance-content-plan";
import { isRawIntegrityErrorMessage } from "./raw-integrity";
import type {
  KnowledgeBaseRunCompletion,
  KnowledgeBaseRunMode,
  KnowledgeBaseRunWarning,
  KnowledgeBaseSource
} from "./types";
import { formatDateForFile, pad } from "./utils";

const MAINTENANCE_FINAL_BLOCK_START = "<!-- echoink-maintenance-final:v1:start -->";
const MAINTENANCE_FINAL_BLOCK_END = "<!-- echoink-maintenance-final:v1:end -->";

export interface KnowledgeBaseFallbackReportInput {
  mode: KnowledgeBaseRunMode;
  output: string;
  sources: Pick<KnowledgeBaseSource, "relativePath">[];
  startedAt: number;
  previousMtimeMs?: number | null;
}

export interface KnowledgeBaseFailureReportInput {
  mode: KnowledgeBaseRunMode;
  error: string;
  sources: Pick<KnowledgeBaseSource, "relativePath">[];
  startedAt: number;
  rollbackRestored: boolean;
  rollbackError?: string;
  externalRawAdditions?: string[];
}

export interface KnowledgeBaseMaintenanceFinalBlockInput {
  completion: KnowledgeBaseRunCompletion;
  workflowRunId: string;
  attemptId?: string;
  backend?: AgentBackendKind;
  verifiedSources: Pick<KnowledgeBaseSource, "relativePath">[];
  pendingSources: DigestEvidencePendingSource[];
  warnings?: KnowledgeBaseRunWarning[];
}

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
  return `体检报告已生成。Agent 返回失败状态，但 lint-only 报告文件存在，已恢复为成功。${suffix}`;
}

export function shouldRecoverKnowledgeBaseLintFailure(errorMessage: string, reportText: string | null): boolean {
  if (isRawIntegrityErrorMessage(errorMessage)) return false;
  return Boolean(reportText && isLintOnlyKnowledgeBaseReport(reportText));
}

export async function ensureKnowledgeBaseFallbackReport(
  vaultPath: string,
  reportPath: string,
  input: KnowledgeBaseFallbackReportInput
): Promise<void> {
  const absolute = requireKnowledgeBaseReportPath(vaultPath, reportPath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const existing = await fsp.lstat(absolute).catch(() => null);
  const existingText = existing?.isFile()
    ? await fsp.readFile(absolute, "utf8").catch(() => "")
    : "";
  const next = buildKnowledgeBaseFallbackReportContent(
    existingText,
    existing?.isFile() ? existing.mtimeMs : null,
    input
  );
  if (next === null || next === existingText) return;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, next);
}

/**
 * Returns null when a fresh Agent report must be kept as-is. Otherwise returns
 * the exact bytes the Host should commit as the fallback/lint-normalized
 * report. This function performs no I/O and is safe to call before WAL prepare.
 */
export function buildKnowledgeBaseFallbackReportContent(
  existingText: string,
  existingMtimeMs: number | null,
  input: KnowledgeBaseFallbackReportInput
): string | null {
  const existingFresh = isFreshReportMtime(
    existingMtimeMs,
    input.startedAt,
    input.previousMtimeMs
  );
  let existingFreshNonLint = false;
  if (existingFresh) {
    if (input.mode !== "lint") return null;
    const excerpt = existingText.trim().slice(0, 4000).trim();
    if (excerpt && isLintOnlyKnowledgeBaseReport(excerpt)) {
      return buildLintOnlyReportModeMetadataContent(existingText);
    }
    existingFreshNonLint = true;
  }
  const reportStatus = existingFreshNonLint
    ? "- 同名报告存在但不是 lint-only 体检报告，已由插件生成 fallback，避免复用错误报告。"
    : existingMtimeMs !== null
      ? "- 同名报告存在但早于本轮任务开始时间，已由插件生成 fallback，避免复用旧报告。"
      : "- Agent 未写出报告；该报告只是过程记录，不代表 Raw 已提炼。";
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
    "- 该报告只是过程记录，不代表 Raw 已提炼。",
    "- 只有 Wiki / Projects 已有结构化知识和来源证据，并通过插件验证后，Raw 才能标记为已提炼。",
    ""
  ];
  return lines.join("\n");
}

export async function writeKnowledgeBaseNoopReport(
  vaultPath: string,
  reportPath: string,
  input: {
    mode: KnowledgeBaseRunMode;
    startedAt: number;
    checkedCount: number;
    scopeLabel: string;
    summary: string;
  }
): Promise<void> {
  const lines = [
    "---",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "source: codex-echoink",
    `mode: ${input.mode}`,
    "status: success",
    "incremental: true",
    "agent_called: false",
    "---",
    "",
    `# 知识库${labelForRunMode(input.mode)}报告 — ${formatDateForTitle(new Date(input.startedAt))}`,
    "",
    "## 一眼结论",
    "",
    input.summary,
    "",
    "## 本轮固定流程",
    "",
    `- 已检查范围：${input.scopeLabel}。`,
    `- 增量清单命中：${input.checkedCount} 个文件。`,
    "- 内容变化：0 个。",
    "- 没有变化时直接收口，不调用模型，也不重复扫描全部正文。",
    "",
    "## 未改动边界",
    "",
    "- 未改动 Raw 正文。",
    "- 未改动 Wiki / Projects 正文。",
    "- 未改动 tracker 和索引正文。",
    ""
  ];
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, lines.join("\n"));
}

export async function writeKnowledgeBaseFailureReport(
  vaultPath: string,
  reportPath: string,
  input: KnowledgeBaseFailureReportInput
): Promise<void> {
  await writeKnowledgeBaseReportFile(
    vaultPath,
    reportPath,
    buildKnowledgeBaseFailureReportContent(input)
  );
}

export function buildKnowledgeBaseFailureReportContent(
  input: KnowledgeBaseFailureReportInput
): string {
  const lines = [
    "---",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "source: codex-echoink",
    "status: failed",
    `mode: ${input.mode}`,
    "fallback: true",
    "---",
    "",
    `# 知识库${labelForRunMode(input.mode)}失败 — ${formatDateForTitle(new Date(input.startedAt))}`,
    "",
    "## 一眼结论",
    `知识库${labelForRunMode(input.mode)}失败，插件已停止提交 tracker。`,
    "",
    "## 失败原因",
    input.error.trim() || "未捕获到具体错误信息。",
    "",
    "## 本轮来源",
    ...(input.sources.length ? input.sources.map((source) => `- [[${source.relativePath}]]`) : ["- 无新增或变更 raw 文件"]),
    "",
    "## 回滚状态",
    input.rollbackRestored ? "- 已回滚本轮知识库写入。" : "- 未检测到需要回滚的知识库写入。",
    ...(input.rollbackError ? [`- 回滚警告：${input.rollbackError}`] : []),
    ...(input.externalRawAdditions?.length ? ["", "## 并发新增 Raw", ...input.externalRawAdditions.map((item) => `- [[${item}]]`)] : []),
    "",
    "## 下一步",
    "- 修复失败原因后重新运行知识库维护。",
    "- 只有 Wiki / Projects 已有结构化知识和来源证据，并通过插件验证后，Raw 才会标记为已提炼。",
    ""
  ];
  return lines.join("\n");
}

/**
 * Replaces the Harness-owned terminal section atomically. Agent prose is kept,
 * but this block is the deterministic truth used by people and UI when the
 * Agent's own report overstates a partial result.
 */
export async function writeKnowledgeBaseMaintenanceFinalBlock(
  vaultPath: string,
  reportPath: string,
  input: KnowledgeBaseMaintenanceFinalBlockInput
): Promise<void> {
  const existing = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const updated = appendKnowledgeBaseMaintenanceFinalBlockContent(existing, input);
  const block = buildKnowledgeBaseMaintenanceFinalBlock(input);
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, updated);
  const persisted = await readKnowledgeBaseReportText(vaultPath, reportPath);
  if (!persisted.includes(block)) {
    throw new Error("知识库维护终态写入后复验失败");
  }
}

export function appendKnowledgeBaseMaintenanceFinalBlockContent(
  existingText: string,
  input: KnowledgeBaseMaintenanceFinalBlockInput
): string {
  if (!existingText.trim()) {
    throw new Error("知识库维护终态无法写入：本轮报告不存在");
  }
  const block = buildKnowledgeBaseMaintenanceFinalBlock(input);
  return `${withoutKnowledgeBaseMaintenanceFinalBlock(existingText).trimEnd()}\n\n${block}\n`;
}

export function planKnowledgeBaseMaintenanceReportWrite(input: {
  reportPath: string;
  expected: MaintenanceWorkflowFileCas;
  baselineContent: Buffer;
  desiredMode: number;
  startedAt: number;
  completedAt: number;
  finalBlock: KnowledgeBaseMaintenanceFinalBlockInput;
}): MaintenanceWorkflowManagedUpsertDraft {
  const reportWithStableTimestamps = withMaintenanceReportTimestamps(
    input.baselineContent.toString("utf8"),
    input.startedAt,
    input.completedAt
  );
  return {
    kind: "report",
    operation: "upsert",
    relativePath: input.reportPath,
    expected: input.expected.kind === "missing"
      ? { kind: "missing" }
      : { ...input.expected },
    desiredContent: Buffer.from(
      appendKnowledgeBaseMaintenanceFinalBlockContent(
        reportWithStableTimestamps,
        input.finalBlock
      ),
      "utf8"
    ),
    desiredMode: normalizeMaintenanceContentMode(input.desiredMode)
  };
}

/**
 * Obsidian metadata plugins commonly react to a newly written Markdown file
 * by adding `created` / `updated` frontmatter. Durable maintenance reports
 * include those fields before the WAL is sealed so that reaction is a no-op
 * instead of becoming a post-commit byte-CAS conflict.
 */
export function withMaintenanceReportTimestamps(
  reportText: string,
  startedAt: number,
  completedAt: number
): string {
  if (
    !Number.isFinite(startedAt)
    || !Number.isFinite(completedAt)
    || completedAt < startedAt
  ) {
    throw new Error("知识库维护报告时间戳非法");
  }
  const created = formatMaintenanceReportTimestamp(startedAt);
  const updated = formatMaintenanceReportTimestamp(completedAt);
  const opening = reportText.match(/^---(\r\n|\n)/);
  const lineEnding = opening?.[1]
    ?? (reportText.includes("\r\n") ? "\r\n" : "\n");
  if (!opening) {
    return [
      "---",
      `created: ${created}`,
      `updated: ${updated}`,
      "---",
      "",
      reportText
    ].join(lineEnding);
  }
  const closingPattern = /^(?:---|\.\.\.)(?:\r\n|\n|$)/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(reportText);
  if (!closing) {
    throw new Error("知识库维护报告 frontmatter 未闭合");
  }
  const frontmatter = reportText
    .slice(opening[0].length, closing.index)
    .replace(/(?:\r\n|\n)$/, "");
  const lines = frontmatter ? frontmatter.split(/\r\n|\n/) : [];
  const next: string[] = [];
  let sawCreated = false;
  let sawUpdated = false;
  for (const line of lines) {
    if (isTopLevelFrontmatterKey(line, "created")) {
      if (!sawCreated) next.push(line);
      sawCreated = true;
      continue;
    }
    if (isTopLevelFrontmatterKey(line, "updated")) {
      if (!sawUpdated) next.push(`updated: ${updated}`);
      sawUpdated = true;
      continue;
    }
    next.push(line);
  }
  if (!sawCreated) next.push(`created: ${created}`);
  if (!sawUpdated) next.push(`updated: ${updated}`);
  return [
    `---${lineEnding}`,
    next.length ? `${next.join(lineEnding)}${lineEnding}` : "",
    reportText.slice(closing.index)
  ].join("");
}

function isTopLevelFrontmatterKey(line: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:${escaped}|["']${escaped}["'])\\s*:`, "i")
    .test(line);
}

function formatMaintenanceReportTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("知识库维护报告时间戳非法");
  }
  return `${formatDateForFile(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildKnowledgeBaseMaintenanceFinalBlock(
  input: KnowledgeBaseMaintenanceFinalBlockInput
): string {
  const lines = [
    MAINTENANCE_FINAL_BLOCK_START,
    "## EchoInk 验证终态",
    "",
    `- 结果：${input.completion}`,
    `- workflow：${inlineCode(input.workflowRunId)}`,
    ...(input.attemptId ? [`- attempt：${inlineCode(input.attemptId)}`] : []),
    ...(input.backend ? [`- Agent：${input.backend}`] : []),
    "",
    `### 已验证来源（${input.verifiedSources.length}）`,
    ...(input.verifiedSources.length
      ? input.verifiedSources.map((source) => `- ${inlineCode(source.relativePath)}`)
      : ["- 无"]),
    "",
    `### 待处理来源（${input.pendingSources.length}）`,
    ...(input.pendingSources.length
      ? input.pendingSources.map((item) =>
        `- ${inlineCode(item.source.relativePath)}：${singleLine(item.reason.message)}`)
      : ["- 无"]),
    ...(input.warnings?.length ? [
      "",
      `### 提醒（${input.warnings.length}）`,
      ...input.warnings.map((warning) => `- ${singleLine(warning.message)}`)
    ] : []),
    "",
    "> 本区块由 EchoInk Harness 在逐来源证据校验后写入；与 Agent 正文冲突时，以本区块为准。",
    MAINTENANCE_FINAL_BLOCK_END
  ];
  return lines.join("\n");
}

function withoutKnowledgeBaseMaintenanceFinalBlock(text: string): string {
  const start = text.indexOf(MAINTENANCE_FINAL_BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(MAINTENANCE_FINAL_BLOCK_END, start);
  if (end < 0) {
    throw new Error("知识库维护报告含损坏的 EchoInk 终态区块");
  }
  return `${text.slice(0, start)}${text.slice(end + MAINTENANCE_FINAL_BLOCK_END.length)}`;
}

function inlineCode(value: string): string {
  return `\`${singleLine(value).replace(/`/g, "\\`")}\``;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function buildLintOnlyReportModeMetadataContent(text: string): string {
  if (!text.trim()) return text;
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
        return `---\n${updatedLines.join("\n")}${normalized.slice(end)}`;
      }
      return text;
    }
  }
  if (/(^|\n)mode:\s*lint-only(\n|$)/i.test(normalized)) return text;
  return [
    "---",
    "mode: lint-only",
    "---",
    "",
    normalized
  ].join("\n");
}

export async function writeKnowledgeBaseReportFile(vaultPath: string, reportPath: string, content: string): Promise<void> {
  const absolute = requireKnowledgeBaseReportPath(vaultPath, reportPath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  const temp = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fsp.writeFile(temp, content, "utf8");
    await fsp.rename(temp, absolute);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(swallowError("remove failed report temp file"));
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
  return formatDateForFile(date);
}

function hasUnnegatedLintOnlySignal(text: string, signal: RegExp): boolean {
  const match = signal.exec(text);
  if (!match || typeof match.index !== "number") return false;
  const before = text.slice(Math.max(0, match.index - 24), match.index);
  return !/(不是|并非|非|不属于|不算|not|non)\s*$/i.test(before);
}
