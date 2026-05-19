import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";
import { AGENTS_RULES_FILE } from "./constants";
import { readKnowledgeBaseTrackerSnapshot } from "./tracker";

export interface KnowledgeBaseDashboardFile {
  path: string;
  size: number;
  mtime: number;
}

export interface KnowledgeBaseDashboardDirectory {
  path: string;
  exists: boolean;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  recentFiles: KnowledgeBaseDashboardFile[];
}

export type KnowledgeBaseDashboardHealthStatus = "healthy" | "risk" | "bad";
export type KnowledgeBaseDashboardCheckStatus = "success" | "failed" | "none";
export type KnowledgeBaseDashboardCheckFreshnessStatus = "fresh" | "stale" | "bad" | "missing";

export interface KnowledgeBaseDashboardHealth {
  status: KnowledgeBaseDashboardHealthStatus;
  label: string;
  score: number;
  reasons: string[];
  lastCheckAt: number;
  streakDays: number;
}

export interface KnowledgeBaseDashboardCheckFreshness {
  status: KnowledgeBaseDashboardCheckFreshnessStatus;
  label: string;
  score: number;
  lastCheckAt: number;
  daysSinceCheck: number;
  reasons: string[];
}

export interface KnowledgeBaseDashboardWikiGroup {
  path: string;
  label: string;
  totalCount: number;
  sharePercent: number;
  todayCount: number;
}

export interface KnowledgeBaseDashboardHeatmapDay {
  date: string;
  status: KnowledgeBaseDashboardCheckStatus;
}

export interface KnowledgeBaseDashboardSnapshot {
  generatedAt: number;
  vaultName: string;
  vaultPath: string;
  rulesFilePath: string;
  rulesFileExists: boolean;
  initialization: {
    status: string;
    rulesFilePath: string;
    templateVersion: string;
    initializedAt: number;
  };
  lastRun: {
    status: string;
    at: number;
    reportPath: string;
    reportExists: boolean;
    error: string;
  };
  tracker: {
    path: string;
    exists: boolean;
    trackedCount: number;
  };
  raw: KnowledgeBaseDashboardDirectory & {
    changedCount: number;
    todayCount: number;
  };
  wiki: KnowledgeBaseDashboardDirectory & {
    indexExists: boolean;
    domainCount: number;
    todayCount: number;
    groups: KnowledgeBaseDashboardWikiGroup[];
  };
  outputs: KnowledgeBaseDashboardDirectory & {
    latestReportPath: string;
    latestReportExists: boolean;
  };
  inbox: KnowledgeBaseDashboardDirectory & {
    todayCount: number;
  };
  health: KnowledgeBaseDashboardHealth;
  checkFreshness: KnowledgeBaseDashboardCheckFreshness;
  checkHeatmap: KnowledgeBaseDashboardHeatmapDay[];
  warnings: string[];
}

const MAX_DASHBOARD_FILES = 3000;
const RECENT_FILE_LIMIT = 6;
const RAW_PROCESSING_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function buildKnowledgeBaseDashboardSnapshot(vaultPath: string, settings: KnowledgeBaseSettings): Promise<KnowledgeBaseDashboardSnapshot> {
  const generatedAt = Date.now();
  const rulesFilePath = normalizeRelativePath(settings.useCustomRulesFile ? settings.rulesFilePath : AGENTS_RULES_FILE, AGENTS_RULES_FILE);
  const processedSources = settings.processedSources ?? {};
  const raw = await scanDashboardDirectory(vaultPath, "raw", { skipHidden: true });
  const wiki = await scanDashboardDirectory(vaultPath, "wiki", { skipHidden: true });
  const outputs = await scanDashboardDirectory(vaultPath, "outputs", { skipHidden: false, ignoreNames: new Set([".DS_Store"]) });
  const inbox = await scanDashboardDirectory(vaultPath, "inbox", { skipHidden: true });
  const reportPath = await resolveLatestReportPath(vaultPath, settings.lastReportPath, outputs.files);
  const trackerPath = "outputs/.ingest-tracker.md";
  const rulesFileExists = await exists(path.join(vaultPath, rulesFilePath));
  const trackerExists = await exists(path.join(vaultPath, trackerPath));
  const reportExists = reportPath ? await exists(path.join(vaultPath, reportPath)) : false;
  const wikiIndexExists = await exists(path.join(vaultPath, "wiki/index.md"));
  const rawContentFiles = raw.files.filter(isRawProcessingSource);
  const trackerSnapshot = await readKnowledgeBaseTrackerSnapshot(vaultPath, trackerPath, rawContentFiles);
  const mergedProcessedSources = { ...processedSources, ...trackerSnapshot.processedSources };
  const reportFindings = await readReportFindings(vaultPath, reportPath);
  const latestExternalCheckAt = Math.max(reportFindings.checkedAt, trackerSnapshot.updatedAt);
  const externalHealthHistory = buildExternalHealthHistory(outputs.files, latestExternalCheckAt);
  const rawChangedCount = countChangedProcessed(rawContentFiles, mergedProcessedSources);
  const wikiGroups = buildWikiGroups(wiki.files, generatedAt);
  const rawTodayCount = countFilesChangedToday(rawContentFiles, generatedAt);
  const inboxTodayCount = countFilesChangedToday(inbox.files, generatedAt);
  const wikiTodayCount = countFilesChangedToday(wiki.files.filter((file) => file.path !== "wiki/index.md"), generatedAt);
  const warnings = buildWarnings({
    rulesFileExists,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    trackerExists,
    lastError: settings.lastError,
    scanLimited: raw.limited || wiki.limited || outputs.limited || inbox.limited
  });
  const health = buildHealth({
    settings,
    generatedAt,
    latestExternalCheckAt,
    externalHealthHistory,
    latestReportFindings: reportFindings,
    rulesFileExists,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    wikiIndexExists,
    trackerExists,
    rawChangedCount,
    inboxCount: inbox.fileCount,
    warnings
  });
  const checkFreshness = buildCheckFreshness(settings.healthHistory ?? [], generatedAt, latestExternalCheckAt);

  return {
    generatedAt,
    vaultName: path.basename(vaultPath),
    vaultPath,
    rulesFilePath,
    rulesFileExists,
    initialization: {
      status: settings.initialization.status,
      rulesFilePath: settings.initialization.rulesFilePath,
      templateVersion: settings.initialization.templateVersion,
      initializedAt: settings.initialization.initializedAt
    },
    lastRun: {
      status: settings.lastRunStatus,
      at: settings.lastRunAt,
      reportPath,
      reportExists,
      error: settings.lastError
    },
    tracker: {
      path: trackerPath,
      exists: trackerExists,
      trackedCount: Object.keys(mergedProcessedSources).length
    },
    raw: {
      ...stripLimited(raw),
      changedCount: rawChangedCount,
      todayCount: rawTodayCount
    },
    wiki: {
      ...stripLimited(wiki),
      indexExists: wikiIndexExists,
      domainCount: await countImmediateDirectories(path.join(vaultPath, "wiki")),
      todayCount: wikiTodayCount,
      groups: wikiGroups
    },
    outputs: {
      ...stripLimited(outputs),
      latestReportPath: reportPath,
      latestReportExists: reportExists
    },
    inbox: {
      ...stripLimited(inbox),
      todayCount: inboxTodayCount
    },
    health,
    checkFreshness,
    checkHeatmap: buildCheckHeatmap(settings.healthHistory ?? [], generatedAt, externalHealthHistory),
    warnings
  };
}

interface DashboardScanOptions {
  skipHidden: boolean;
  ignoreNames?: Set<string>;
}

interface DashboardScanResult extends KnowledgeBaseDashboardDirectory {
  files: KnowledgeBaseDashboardFile[];
  limited: boolean;
}

async function scanDashboardDirectory(vaultPath: string, relativeDir: string, options: DashboardScanOptions): Promise<DashboardScanResult> {
  const root = path.join(vaultPath, relativeDir);
  const files: KnowledgeBaseDashboardFile[] = [];
  const folderPaths = new Set<string>();
  const rootExists = await exists(root);
  let limited = false;
  if (!rootExists) return { path: relativeDir, exists: false, fileCount: 0, folderCount: 0, totalSize: 0, recentFiles: [], files, limited };

  async function walk(current: string): Promise<void> {
    if (files.length >= MAX_DASHBOARD_FILES) {
      limited = true;
      return;
    }
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_DASHBOARD_FILES) {
        limited = true;
        return;
      }
      if (options.ignoreNames?.has(entry.name)) continue;
      if (options.skipHidden && entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      const relative = normalizeSlashes(path.relative(vaultPath, full));
      if (entry.isDirectory()) {
        folderPaths.add(relative);
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        files.push({ path: relative, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  }

  await walk(root);
  const recentFiles = [...files].sort((left, right) => right.mtime - left.mtime).slice(0, RECENT_FILE_LIMIT);
  return {
    path: relativeDir,
    exists: true,
    fileCount: files.length,
    folderCount: folderPaths.size,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    recentFiles,
    files,
    limited
  };
}

function stripLimited(input: DashboardScanResult): KnowledgeBaseDashboardDirectory {
  return {
    path: input.path,
    exists: input.exists,
    fileCount: input.fileCount,
    folderCount: input.folderCount,
    totalSize: input.totalSize,
    recentFiles: input.recentFiles
  };
}

function countChangedProcessed(files: KnowledgeBaseDashboardFile[], processed: Record<string, { size: number; mtime: number }>): number {
  return files.filter((file) => {
    const previous = processed[file.path];
    return !previous || previous.size !== file.size || previous.mtime !== file.mtime;
  }).length;
}

interface ReportFindings {
  checkedAt: number;
  brokenLinks: number;
  orphanPages: number;
  staleItems: number;
  indexInvalid: boolean;
}

async function readReportFindings(vaultPath: string, reportPath: string): Promise<ReportFindings> {
  const empty: ReportFindings = { checkedAt: 0, brokenLinks: 0, orphanPages: 0, staleItems: 0, indexInvalid: false };
  const normalized = normalizeRelativePath(reportPath, "");
  if (!normalized) return empty;
  const absolute = path.join(vaultPath, normalized);
  const [text, stat] = await Promise.all([
    fsp.readFile(absolute, "utf8").catch(() => ""),
    fsp.stat(absolute).catch(() => null)
  ]);
  if (!text.trim() || !stat) return empty;
  return {
    checkedAt: stat.mtimeMs,
    brokenLinks: firstNumber(text, [
      /(?:实质性断链|硬断链|断链)[：:]\s*(\d+)/i,
      /(?:实质性断链|硬断链|断链)[^\d\n]*(\d+)\s*处/i
    ]),
    orphanPages: firstNumber(text, [
      /孤儿页面[：:]\s*(\d+)/i,
      /孤儿页面[^\d\n]*(\d+)\s*个/i
    ]),
    staleItems: firstNumber(text, [
      /(?:过时\/草稿内容|过时内容|过时或草稿内容)[：:]\s*(\d+)/i,
      /(?:过时|draft|草稿)[^\d\n]*(\d+)\s*处/i
    ]),
    indexInvalid: /索引链接[：:](?!\s*全部有效)/.test(text) || /wiki\/index\.md[^\n]*(缺失|无效|不存在)/i.test(text)
  };
}

function firstNumber(text: string, patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return Number(match[1]) || 0;
  }
  return 0;
}

async function resolveLatestReportPath(vaultPath: string, configuredPath: string, outputFiles: KnowledgeBaseDashboardFile[]): Promise<string> {
  const normalized = normalizeRelativePath(configuredPath, "");
  if (normalized && await exists(path.join(vaultPath, normalized))) return normalized;
  const latest = outputFiles
    .filter((file) => /^outputs\/kb-maintenance-.+\.md$/i.test(file.path))
    .sort((left, right) => right.mtime - left.mtime)[0];
  return latest?.path ?? normalized;
}

async function countImmediateDirectories(root: string): Promise<number> {
  const entries: fs.Dirent[] = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
}

interface HealthInput {
  settings: KnowledgeBaseSettings;
  generatedAt: number;
  latestExternalCheckAt: number;
  externalHealthHistory: KnowledgeBaseHealthHistoryEntry[];
  latestReportFindings: ReportFindings;
  rulesFileExists: boolean;
  rawExists: boolean;
  wikiExists: boolean;
  wikiIndexExists: boolean;
  trackerExists: boolean;
  rawChangedCount: number;
  inboxCount: number;
  warnings: string[];
}

function buildHealth(input: HealthInput): KnowledgeBaseDashboardHealth {
  const critical: string[] = [];
  const risk: string[] = [];
  if (!input.rulesFileExists) critical.push("规则文件缺失");
  if (!input.rawExists) critical.push("raw 目录缺失");
  if (!input.wikiExists) critical.push("wiki 目录缺失");
  if (!input.wikiIndexExists) critical.push("wiki/index.md 缺失");
  if (!input.trackerExists) critical.push("tracker 缺失");

  const history = normalizeHealthHistory(input.settings.healthHistory ?? []);
  const latestHistory = latestHealthEntry(history);
  const latestCheckAt = Math.max(latestHistory?.at ?? 0, input.latestExternalCheckAt);
  const latestCheckFailed = Boolean(latestHistory && latestHistory.status === "failed" && latestHistory.at >= input.latestExternalCheckAt);
  if (latestCheckFailed) critical.push("最近体检失败");

  if (input.rawChangedCount > 20) critical.push(`Raw 待提炼 ${input.rawChangedCount} 个`);
  else if (input.rawChangedCount > 5) risk.push(`Raw 待提炼 ${input.rawChangedCount} 个`);

  if (input.inboxCount > 30) critical.push(`Inbox 积压 ${input.inboxCount} 个`);
  else if (input.inboxCount > 10) risk.push(`Inbox 积压 ${input.inboxCount} 个`);

  if (input.latestReportFindings.indexInvalid) critical.push("索引链接异常");
  if (input.latestReportFindings.brokenLinks > 0) risk.push(`断链 ${input.latestReportFindings.brokenLinks} 处`);
  if (input.latestReportFindings.orphanPages > 0) risk.push(`孤儿页面 ${input.latestReportFindings.orphanPages} 个`);
  if (input.latestReportFindings.staleItems > 0) risk.push(`过时/草稿 ${input.latestReportFindings.staleItems} 处`);

  const nonCriticalWarnings = input.warnings.filter((warning) => !critical.includes(warning));
  if (nonCriticalWarnings.length) risk.push(`存在警告：${nonCriticalWarnings.join("，")}`);

  const score = healthScore({
    criticalCount: critical.length,
    riskCount: risk.length,
    rawChangedCount: input.rawChangedCount,
    inboxCount: input.inboxCount,
    brokenLinks: input.latestReportFindings.brokenLinks,
    orphanPages: input.latestReportFindings.orphanPages,
    staleItems: input.latestReportFindings.staleItems
  });
  const scoreStatus: KnowledgeBaseDashboardHealthStatus = critical.length || score < 60 ? "bad" : risk.length || score < 85 ? "risk" : "healthy";
  const status = scoreStatus;
  const label = status === "healthy" ? "健康" : status === "risk" ? "风险" : "异常";
  const scoreReasons = [...critical, ...risk];
  const reasons = scoreReasons.length ? scoreReasons : ["知识库结构正常，待处理数量在安全范围"];
  return {
    status,
    label,
    score,
    reasons,
    lastCheckAt: latestCheckAt,
    streakDays: countHealthStreakDays(history, input.externalHealthHistory),
  };
}

function buildCheckFreshness(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number, externalCheckAt = 0): KnowledgeBaseDashboardCheckFreshness {
  const normalized = normalizeHealthHistory(history);
  const latestHistory = latestHealthEntry(normalized);
  const latestCheckAt = Math.max(latestHistory?.at ?? 0, externalCheckAt);
  if (!latestCheckAt) {
    return {
      status: "missing",
      label: "无检",
      score: 0,
      lastCheckAt: 0,
      daysSinceCheck: -1,
      reasons: ["没有体检记录；这只代表缺少确认，不代表知识库已经坏了"]
    };
  }
  const days = daysBetweenDateKeys(formatLocalDateKey(latestCheckAt), formatLocalDateKey(generatedAt));
  const score = Math.max(0, Math.min(100, 100 - days * 8));
  const status: KnowledgeBaseDashboardCheckFreshnessStatus = score >= 80 ? "fresh" : score >= 50 ? "stale" : "bad";
  const label = status === "fresh" ? "新鲜" : status === "stale" ? "待检" : "过期";
  return {
    status,
    label,
    score,
    lastCheckAt: latestCheckAt,
    daysSinceCheck: days,
    reasons: [days === 0 ? "今天已确认" : `${days} 天前确认；这不影响知识库健康分`]
  };
}

function healthScore(input: { criticalCount: number; riskCount: number; rawChangedCount: number; inboxCount: number; brokenLinks: number; orphanPages: number; staleItems: number }): number {
  const rawPenalty = input.rawChangedCount > 20 ? 20 : input.rawChangedCount > 5 ? 10 : 0;
  const inboxPenalty = input.inboxCount > 30 ? 20 : input.inboxCount > 10 ? 10 : 0;
  const reportPenalty = Math.min(24, input.brokenLinks * 6) + Math.min(12, input.orphanPages * 4) + Math.min(8, input.staleItems * 2);
  return Math.max(0, Math.min(100, 100 - input.criticalCount * 24 - input.riskCount * 2 - rawPenalty - inboxPenalty - reportPenalty));
}

function buildWikiGroups(files: KnowledgeBaseDashboardFile[], generatedAt: number): KnowledgeBaseDashboardWikiGroup[] {
  const groups = new Map<string, KnowledgeBaseDashboardWikiGroup>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length < 3 || parts[0] !== "wiki") continue;
    const folder = parts[1];
    if (!folder || folder.startsWith(".")) continue;
    const groupPath = `wiki/${folder}`;
    const group = groups.get(groupPath) ?? { path: groupPath, label: folder, totalCount: 0, sharePercent: 0, todayCount: 0 };
    group.totalCount += 1;
    if (isSameLocalDay(file.mtime, generatedAt)) group.todayCount += 1;
    groups.set(groupPath, group);
  }
  const result = Array.from(groups.values()).sort((left, right) => left.path.localeCompare(right.path));
  const total = result.reduce((sum, group) => sum + group.totalCount, 0);
  for (const group of result) {
    group.sharePercent = total ? Math.round((group.totalCount / total) * 100) : 0;
  }
  return result;
}

function countFilesChangedToday(files: KnowledgeBaseDashboardFile[], generatedAt: number): number {
  return files.filter((file) => isSameLocalDay(file.mtime, generatedAt)).length;
}

function isSameLocalDay(leftMs: number, rightMs: number): boolean {
  return formatLocalDateKey(leftMs) === formatLocalDateKey(rightMs);
}

function buildExternalHealthHistory(outputFiles: KnowledgeBaseDashboardFile[], externalCheckAt = 0): KnowledgeBaseHealthHistoryEntry[] {
  const entries: KnowledgeBaseHealthHistoryEntry[] = [];
  for (const file of outputFiles) {
    const match = file.path.match(/^outputs\/kb-maintenance-(\d{4}-\d{2}-\d{2})\.md$/i);
    if (!match?.[1]) continue;
    entries.push({ date: match[1], status: "success", at: file.mtime });
  }
  if (externalCheckAt) {
    entries.push({ date: formatLocalDateKey(externalCheckAt), status: "success", at: externalCheckAt });
  }
  return normalizeHealthHistory(entries);
}

function statusByCheckDate(history: KnowledgeBaseHealthHistoryEntry[], externalHistory: KnowledgeBaseHealthHistoryEntry[]): Map<string, KnowledgeBaseDashboardCheckStatus> {
  const byDate = new Map<string, KnowledgeBaseDashboardCheckStatus>();
  for (const entry of normalizeHealthHistory(externalHistory)) {
    byDate.set(entry.date, entry.status);
  }
  for (const entry of normalizeHealthHistory(history)) {
    byDate.set(entry.date, entry.status);
  }
  return byDate;
}

function buildCheckHeatmap(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number, externalHistory: KnowledgeBaseHealthHistoryEntry[] = []): KnowledgeBaseDashboardHeatmapDay[] {
  const byDate = statusByCheckDate(history, externalHistory);
  const year = new Date(generatedAt).getFullYear();
  const cursor = parseDateKey(`${year}-01-01`);
  const days: KnowledgeBaseDashboardHeatmapDay[] = [];
  while (cursor.getFullYear() === year) {
    const date = formatLocalDateKey(cursor.getTime());
    days.push({
      date,
      status: byDate.get(date) ?? "none"
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function countHealthStreakDays(history: KnowledgeBaseHealthHistoryEntry[], externalHistory: KnowledgeBaseHealthHistoryEntry[] = []): number {
  const byDate = statusByCheckDate(history, externalHistory);
  const latest = Array.from(byDate.entries()).sort((left, right) => left[0].localeCompare(right[0])).at(-1);
  if (!latest || latest[1] !== "success") return 0;
  let count = 0;
  let cursor = latest[0];
  while (byDate.get(cursor) === "success") {
    count += 1;
    cursor = shiftDate(cursor, -1);
  }
  return count;
}

function latestHealthEntry(history: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseHealthHistoryEntry | null {
  return history.length ? history[history.length - 1] : null;
}

function normalizeHealthHistory(history: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseHealthHistoryEntry[] {
  return history
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && (entry.status === "success" || entry.status === "failed"))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function daysBetweenDateKeys(left: string, right: string): number {
  const leftDate = parseDateKey(left);
  const rightDate = parseDateKey(right);
  return Math.max(0, Math.round((rightDate.getTime() - leftDate.getTime()) / 86400000));
}

function shiftDate(dateKey: string, days: number): string {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return formatLocalDateKey(date.getTime());
}

function parseDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatLocalDateKey(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isRawProcessingSource(file: KnowledgeBaseDashboardFile): boolean {
  if (file.path === "raw/index.md") return false;
  const lower = file.path.toLowerCase();
  if (lower.endsWith(".base") || lower.endsWith(".base.md")) return false;
  if (lower.includes(".assets/")) return false;
  return RAW_PROCESSING_EXTENSIONS.has(path.extname(lower));
}

function buildWarnings(input: { rulesFileExists: boolean; rawExists: boolean; wikiExists: boolean; trackerExists: boolean; lastError: string; scanLimited: boolean }): string[] {
  const warnings: string[] = [];
  if (!input.rulesFileExists) warnings.push("规则文件缺失");
  if (!input.rawExists) warnings.push("raw 目录缺失");
  if (!input.wikiExists) warnings.push("wiki 目录缺失");
  if (!input.trackerExists) warnings.push("tracker 缺失");
  if (input.lastError.trim()) warnings.push("最近任务有错误");
  if (input.scanLimited) warnings.push("文件较多，仅统计前 3000 个");
  return warnings;
}

function normalizeRelativePath(value: string, fallback: string): string {
  const clean = value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  return clean || fallback;
}

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}
