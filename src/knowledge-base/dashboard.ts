import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";

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

export interface KnowledgeBaseDashboardHealth {
  status: KnowledgeBaseDashboardHealthStatus;
  label: string;
  score: number;
  reasons: string[];
  lastCheckAt: number;
  streakDays: number;
}

export interface KnowledgeBaseDashboardWikiGroup {
  path: string;
  label: string;
  totalCount: number;
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
  checkHeatmap: KnowledgeBaseDashboardHeatmapDay[];
  warnings: string[];
}

const MAX_DASHBOARD_FILES = 3000;
const RECENT_FILE_LIMIT = 6;

export async function buildKnowledgeBaseDashboardSnapshot(vaultPath: string, settings: KnowledgeBaseSettings): Promise<KnowledgeBaseDashboardSnapshot> {
  const generatedAt = Date.now();
  const rulesFilePath = normalizeRelativePath(settings.useCustomRulesFile ? settings.rulesFilePath : "AGENTS.md", "AGENTS.md");
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
  const rawContentFiles = raw.files.filter((file) => file.path !== "raw/index.md");
  const rawChangedCount = countChangedProcessed(rawContentFiles, processedSources);
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
    rulesFileExists,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    wikiIndexExists,
    trackerExists,
    rawChangedCount,
    inboxCount: inbox.fileCount,
    warnings
  });

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
      trackedCount: Object.keys(processedSources).length
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
    checkHeatmap: buildCheckHeatmap(settings.healthHistory ?? [], generatedAt),
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
  const latestCheck = latestHealthEntry(history);
  if (!latestCheck) {
    critical.push("从未体检");
  } else {
    if (latestCheck.status === "failed") critical.push("最近体检失败");
    const days = daysBetweenDateKeys(latestCheck.date, formatLocalDateKey(input.generatedAt));
    if (latestCheck.status === "success" && days >= 5) critical.push(`${days} 天未体检`);
    else if (latestCheck.status === "success" && days >= 3) risk.push(`${days} 天未体检`);
  }

  if (input.rawChangedCount > 20) critical.push(`Raw 待提炼 ${input.rawChangedCount} 个`);
  else if (input.rawChangedCount > 5) risk.push(`Raw 待提炼 ${input.rawChangedCount} 个`);

  if (input.inboxCount > 30) critical.push(`Inbox 积压 ${input.inboxCount} 个`);
  else if (input.inboxCount > 10) risk.push(`Inbox 积压 ${input.inboxCount} 个`);

  const nonCriticalWarnings = input.warnings.filter((warning) => !critical.includes(warning));
  if (nonCriticalWarnings.length) risk.push(`存在警告：${nonCriticalWarnings.join("，")}`);

  const status: KnowledgeBaseDashboardHealthStatus = critical.length ? "bad" : risk.length ? "risk" : "healthy";
  const label = status === "healthy" ? "健康" : status === "risk" ? "有风险" : "需处理";
  const reasons = critical.length ? critical : risk.length ? risk : ["2 天内完成体检，待处理数量正常"];
  const score = healthScore(critical.length, risk.length, input.rawChangedCount, input.inboxCount);
  return {
    status,
    label,
    score,
    reasons,
    lastCheckAt: latestCheck?.at ?? 0,
    streakDays: countHealthStreakDays(history),
  };
}

function healthScore(criticalCount: number, riskCount: number, rawChangedCount: number, inboxCount: number): number {
  const rawPenalty = rawChangedCount > 20 ? 20 : rawChangedCount > 5 ? 10 : 0;
  const inboxPenalty = inboxCount > 30 ? 20 : inboxCount > 10 ? 10 : 0;
  return Math.max(0, Math.min(100, 100 - criticalCount * 24 - riskCount * 12 - rawPenalty - inboxPenalty));
}

function buildWikiGroups(files: KnowledgeBaseDashboardFile[], generatedAt: number): KnowledgeBaseDashboardWikiGroup[] {
  const groups = new Map<string, KnowledgeBaseDashboardWikiGroup>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts.length < 3 || parts[0] !== "wiki") continue;
    const folder = parts[1];
    if (!folder || folder.startsWith(".")) continue;
    const groupPath = `wiki/${folder}`;
    const group = groups.get(groupPath) ?? { path: groupPath, label: folder, totalCount: 0, todayCount: 0 };
    group.totalCount += 1;
    if (isSameLocalDay(file.mtime, generatedAt)) group.todayCount += 1;
    groups.set(groupPath, group);
  }
  return Array.from(groups.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function countFilesChangedToday(files: KnowledgeBaseDashboardFile[], generatedAt: number): number {
  return files.filter((file) => isSameLocalDay(file.mtime, generatedAt)).length;
}

function isSameLocalDay(leftMs: number, rightMs: number): boolean {
  return formatLocalDateKey(leftMs) === formatLocalDateKey(rightMs);
}

function buildCheckHeatmap(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number): KnowledgeBaseDashboardHeatmapDay[] {
  const normalized = normalizeHealthHistory(history);
  const byDate = new Map(normalized.map((entry) => [entry.date, entry.status]));
  const days: KnowledgeBaseDashboardHeatmapDay[] = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = shiftDate(formatLocalDateKey(generatedAt), -offset);
    days.push({
      date,
      status: byDate.get(date) ?? "none"
    });
  }
  return days;
}

function countHealthStreakDays(history: KnowledgeBaseHealthHistoryEntry[]): number {
  const normalized = normalizeHealthHistory(history);
  const latest = latestHealthEntry(normalized);
  if (!latest || latest.status !== "success") return 0;
  const byDate = new Map(normalized.map((entry) => [entry.date, entry.status]));
  let count = 0;
  let cursor = latest.date;
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
