import * as fsp from "fs/promises";
import * as path from "path";
import { normalizePath } from "obsidian";
import type {
  MaintenanceWorkflowCasFile,
  MaintenanceWorkflowIndexCommitRecord,
  MaintenanceWorkflowManagedUpsertDraft
} from "../harness/maintenance/workflow-wal";
import type CodexForObsidianPlugin from "../main";
import type { KnowledgeBaseProcessedSource } from "../settings/settings";
import { isKnowledgeBaseCancelError } from "./failure";
import {
  asMaintenanceWorkflowManagedUpsertDraft,
  maintenanceContentFileCas,
  maintenanceContentUpsertPlan,
  readMaintenanceContentFileBaseline
} from "./maintenance-content-plan";
import { rawDigestFingerprint } from "./raw-digest";
import { readKnowledgeBaseReportText, writeKnowledgeBaseReportFile } from "./report";
import { rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";
import type { KnowledgeConflictDuplicateCleanup } from "./transaction-snapshot";
import type { KnowledgeBaseRunMode, KnowledgeBaseSource, StructureNormalizationPathRewrite, StructureNormalizationResult } from "./types";
import { writeFileAtomic } from "./utils";

const KNOWLEDGE_BASE_TRACKER_FALLBACK = "---\nupdated: \n---\n\n# Ingest Tracker\n";

export interface KnowledgeBaseRawIndexWritePlan
  extends MaintenanceWorkflowManagedUpsertDraft {
  kind: "index";
  result: MaintenanceWorkflowCasFile;
  sourcePaths: string[];
}

export function rawIndexCommitRecord(
  plan: KnowledgeBaseRawIndexWritePlan
): MaintenanceWorkflowIndexCommitRecord {
  return {
    relativePath: plan.relativePath,
    result: { ...plan.result },
    sourcePaths: [...plan.sourcePaths]
  };
}

export async function ensureKnowledgeBaseFolders(vaultPath: string, mode: KnowledgeBaseRunMode): Promise<void> {
  await fsp.mkdir(path.join(vaultPath, "outputs"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "maintenance"), { recursive: true });
  if (mode === "lint") return;
  await fsp.mkdir(path.join(vaultPath, "outputs", "reviews"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "publishing", "xiaohongshu"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "instructions"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "outputs", "migrations"), { recursive: true });
  await fsp.mkdir(path.join(vaultPath, "wiki"), { recursive: true });
}

export async function appendStructureNormalizationReport(vaultPath: string, reportPath: string, structure: StructureNormalizationResult): Promise<void> {
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  await writeKnowledgeBaseReportFile(
    vaultPath,
    reportPath,
    buildStructureNormalizationReportContent(current, structure)
  );
}

export function buildStructureNormalizationReportContent(
  current: string,
  structure: StructureNormalizationResult
): string {
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
  return next;
}

export async function appendConflictDuplicateCleanupReport(vaultPath: string, reportPath: string, cleanup: KnowledgeConflictDuplicateCleanup): Promise<void> {
  if (!cleanup.moved.length) return;
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  await writeKnowledgeBaseReportFile(
    vaultPath,
    reportPath,
    buildConflictDuplicateCleanupReportContent(current, cleanup)
  );
}

export function buildConflictDuplicateCleanupReportContent(
  current: string,
  cleanup: KnowledgeConflictDuplicateCleanup
): string {
  if (!cleanup.moved.length) return current;
  const markerStart = "<!-- codex-echoink-conflict-duplicates:start -->";
  const markerEnd = "<!-- codex-echoink-conflict-duplicates:end -->";
  const lines = [
    markerStart,
    "",
    "## 冲突副本预检",
    "",
    `一眼结论：维护开始前发现 ${cleanup.moved.length} 个数字后缀冲突副本，已从 live 知识区转移到 \`${cleanup.backupRoot}\`，正式页面保留原始无后缀文件。`,
    "",
    ...cleanup.moved.slice(0, 40).map((move) => `- ${move.from} -> ${move.to}（正式页：${move.canonical}）`),
    cleanup.moved.length > 40 ? `- 其余 ${cleanup.moved.length - 40} 个略。` : "",
    "",
    markerEnd,
    ""
  ].filter((line) => line !== "").join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current)
    ? current.replace(pattern, lines.trimEnd())
    : `${current.trimEnd()}\n\n${lines}`;
  return next;
}

export function collectExternalRawAdditions(target: Set<string>, additions: Array<{ file: string }>): void {
  for (const addition of additions) {
    target.add(addition.file);
  }
}

export async function appendExternalRawAdditionsReport(vaultPath: string, reportPath: string, additions: string[]): Promise<void> {
  const current = await readKnowledgeBaseReportText(vaultPath, reportPath);
  const next = buildExternalRawAdditionsReportContent(current, additions);
  if (next === current) return;
  await writeKnowledgeBaseReportFile(vaultPath, reportPath, next);
}

export function buildExternalRawAdditionsReportContent(
  current: string,
  additions: string[]
): string {
  const unique = Array.from(new Set(additions.map((item) => normalizePath(item)).filter(Boolean))).sort((left, right) => left.localeCompare(right));
  if (!unique.length) return current;
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
  return next;
}

export async function writeKnowledgeBaseTracker(vaultPath: string, processed: Record<string, KnowledgeBaseProcessedSource>, updatedAt: number): Promise<void> {
  const plan = await planKnowledgeBaseTrackerWrite(vaultPath, processed, updatedAt);
  const tracker = path.join(vaultPath, plan.relativePath);
  await fsp.mkdir(path.dirname(tracker), { recursive: true });
  await writeFileAtomic(tracker, plan.desiredContent);
  await fsp.chmod(tracker, plan.desiredMode);
}

export async function planKnowledgeBaseTrackerWrite(
  vaultPath: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  updatedAt: number
): Promise<MaintenanceWorkflowManagedUpsertDraft> {
  const baseline = await readMaintenanceContentFileBaseline(
    vaultPath,
    "outputs/.ingest-tracker.md"
  );
  const current = baseline.content?.toString("utf8") ?? KNOWLEDGE_BASE_TRACKER_FALLBACK;
  return asMaintenanceWorkflowManagedUpsertDraft(
    "tracker",
    maintenanceContentUpsertPlan(
      baseline,
      buildKnowledgeBaseTrackerContent(current, processed, updatedAt)
    )
  );
}

export function buildKnowledgeBaseTrackerContent(
  current: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  updatedAt: number
): string {
  const markerStart = "<!-- codex-echoink-kb:start -->";
  const markerEnd = "<!-- codex-echoink-kb:end -->";
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
  return pattern.test(current) ? current.replace(pattern, block) : `${current.trim()}\n\n${block}\n`;
}

export async function writeKnowledgeBaseRawIndex(
  vaultPath: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  updatedAt: number
): Promise<void> {
  const plan = await planKnowledgeBaseRawIndexWrite(vaultPath, processed, updatedAt);
  const rawIndex = path.join(vaultPath, plan.relativePath);
  await fsp.mkdir(path.dirname(rawIndex), { recursive: true });
  await writeFileAtomic(rawIndex, plan.desiredContent);
  await fsp.chmod(rawIndex, plan.desiredMode);
}

export async function planKnowledgeBaseRawIndexWrite(
  vaultPath: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  updatedAt: number,
  options: { verifiedSourcePaths?: readonly string[] } = {}
): Promise<KnowledgeBaseRawIndexWritePlan> {
  const baseline = await readMaintenanceContentFileBaseline(
    vaultPath,
    "raw/index.md"
  );
  const current = baseline.content?.toString("utf8") ?? "# Raw\n";
  const draft = asMaintenanceWorkflowManagedUpsertDraft(
    "index",
    maintenanceContentUpsertPlan(
      baseline,
      buildKnowledgeBaseRawIndexContent(current, processed, updatedAt)
    )
  );
  const result = maintenanceContentFileCas(
    draft.desiredContent,
    draft.desiredMode
  );
  const sourcePaths = Array.from(new Set(
    (options.verifiedSourcePaths ?? []).map((sourcePath) =>
      normalizePath(sourcePath))
  )).sort();
  for (const sourcePath of sourcePaths) {
    if (
      !sourcePath.startsWith("raw/")
      || !Object.prototype.hasOwnProperty.call(processed, sourcePath)
    ) {
      throw new Error(`Raw 托管索引 verified source 非法：${sourcePath}`);
    }
  }
  return {
    ...draft,
    kind: "index",
    result,
    sourcePaths
  };
}

export function buildKnowledgeBaseRawIndexContent(
  current: string,
  processed: Record<string, KnowledgeBaseProcessedSource>,
  updatedAt: number
): string {
  const markerStart = "<!-- codex-echoink-raw-index:start -->";
  const markerEnd = "<!-- codex-echoink-raw-index:end -->";
  const entries = Object.values(processed)
    .filter((item) => normalizePath(item.path).startsWith("raw/") && normalizePath(item.path) !== "raw/index.md")
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => `- [[${normalizePath(item.path).replace(/\.md$/i, "")}]]`);
  const block = [
    markerStart,
    "",
    `## EchoInk 已提炼来源（${new Date(updatedAt).toISOString()}）`,
    "",
    ...(entries.length ? entries : ["- 暂无"]),
    "",
    markerEnd
  ].join("\n");
  const pattern = new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`);
  const next = pattern.test(current)
    ? current.replace(pattern, block)
    : `${current.trimEnd()}\n\n${block}\n`;
  return next;
}

export function formatCancelResultMessage(message: string, saveError: string | null): string {
  const details: string[] = [];
  const normalized = message.trim();
  if (normalized && !isKnowledgeBaseCancelError(normalized) && normalized !== "用户取消") {
    details.push(`状态保存失败：${normalized}`);
  }
  if (saveError) details.push(`状态保存失败：${saveError}`);
  return details.length ? `用户取消；${details.join("；")}` : "用户取消";
}

export async function saveSettingsSafely(plugin: CodexForObsidianPlugin, options?: Parameters<CodexForObsidianPlugin["saveSettings"]>[1]): Promise<string | null> {
  try {
    await plugin.saveSettings(true, options);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function normalizeProcessedSources(vaultPath: string, sources: KnowledgeBaseSource[], rewrites: StructureNormalizationPathRewrite[]): Promise<KnowledgeBaseSource[]> {
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

export function rewriteProcessedSources(
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

export async function syncRewrittenRawProcessedSourceStats(
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

export function buildMaintenanceSummary(output: string, mode: KnowledgeBaseRunMode, structure?: StructureNormalizationResult, cleanup?: KnowledgeConflictDuplicateCleanup): string {
  const base = output.trim().slice(0, 800) || `知识库${labelForRunMode(mode)}完成`;
  const lines = [base];
  if (structure) {
    lines.push(`结构整理：移动 ${structure.moves.length} 项，更新引用 ${structure.updatedLinks.reduce((sum, item) => sum + item.replacements, 0)} 处，跳过 ${structure.skipped.length} 项。`);
  }
  if (cleanup?.moved.length) {
    lines.push(`冲突副本预检：转移 ${cleanup.moved.length} 个历史数字副本。`);
  }
  return lines.join("\n").slice(0, 1000);
}

export function shouldWriteKnowledgeBaseFailureReportForMode(mode: KnowledgeBaseRunMode): boolean {
  return mode !== "lint";
}

export function labelForRunMode(mode: KnowledgeBaseRunMode): string {
  if (mode === "lint") return "体检";
  if (mode === "reingest") return "重新提炼";
  if (mode === "outputs") return "outputs 处理";
  if (mode === "inbox") return "收件箱处理";
  return "维护";
}

export function appendKnowledgeBaseWarning(previous: string, warning: string): string {
  const normalized = previous.trim();
  if (!normalized) return warning;
  if (normalized.includes(warning)) return normalized;
  return `${normalized}；${warning}`;
}

export function cloneProcessedSources(processed: Record<string, KnowledgeBaseProcessedSource> | undefined): Record<string, KnowledgeBaseProcessedSource> {
  return Object.fromEntries(
    Object.entries(processed ?? {}).map(([key, source]) => [key, { ...source }])
  );
}

export function cloneList<T extends object>(items: T[] | undefined): T[] {
  return (items ?? []).map((item) => ({ ...item }));
}

function isRewrittenRawPath(relativePath: string, rewrites: StructureNormalizationPathRewrite[]): boolean {
  const normalized = normalizePath(relativePath);
  return rewrites.some((rewrite) => {
    if (!rewrite.to.startsWith("raw/")) return false;
    return normalized === rewrite.to || normalized.startsWith(`${rewrite.to}/`);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
