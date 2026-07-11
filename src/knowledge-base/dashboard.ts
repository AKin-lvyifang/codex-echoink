import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { emptyArrayOnMissingPathOrWarn } from "../core/error-handling";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseMaintenanceMode, KnowledgeBaseSettings } from "../settings/settings";
import { AGENTS_RULES_FILE } from "./constants";
import { rawDigestStateForRecord, rawDigestStateLabel } from "./digest-status";
import { createKnowledgeBaseIoBudget, shouldReadKnowledgeBaseFileContent, type KnowledgeBaseIoBudget } from "./io-budget";
import { isRawMarkdownPath, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry, type RawDigestFrontmatterRecord, type RawDigestRegistryEntry } from "./raw-digest";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import type { KnowledgeBaseRawDigestState, KnowledgeBaseRawDigestStatus } from "./types";
import { exists, normalizeSlashes } from "./utils";

export interface KnowledgeBaseDashboardFile {
  path: string;
  size: number;
  mtime: number;
  fingerprint?: string;
  rawDigest?: RawDigestFrontmatterRecord | null;
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

export interface KnowledgeBaseDashboardHealthScoreReason {
  label: string;
  count: number;
  penalty: number;
  explanation: string;
}

export interface KnowledgeBaseDashboardHealth {
  status: KnowledgeBaseDashboardHealthStatus;
  label: string;
  score: number;
  reasons: string[];
  scoreSummary: string;
  scoreReasons: KnowledgeBaseDashboardHealthScoreReason[];
  scoreCheckNote: string;
  scoreThresholdText: string;
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

export type KnowledgeBaseDashboardActivityLevel = "none" | "low" | "mid" | "high" | "bad";
export type KnowledgeBaseDashboardCardKind = "raw" | "wiki" | "inbox" | "outputs";
export type KnowledgeBaseDashboardLogTone = "green" | "blue" | "orange" | "purple" | "red" | "muted";

export interface KnowledgeBaseDashboardActivityDay {
  date: string;
  raw: number;
  wiki: number;
  inbox: number;
  outputs: number;
  checks: number;
  failures: number;
  total: number;
  status: KnowledgeBaseDashboardCheckStatus;
}

export interface KnowledgeBaseDashboardHeatmapCell {
  startDate: string;
  endDate: string;
  count: number;
  level: KnowledgeBaseDashboardActivityLevel;
  status: KnowledgeBaseDashboardCheckStatus;
}

export interface KnowledgeBaseDashboardHeatmapRow {
  id: "health" | "wiki" | "raw" | "maintenance";
  label: string;
  cells: KnowledgeBaseDashboardHeatmapCell[];
}

export interface KnowledgeBaseDashboardActivityLog {
  id: string;
  label: string;
  text: string;
  at: number;
  tone: KnowledgeBaseDashboardLogTone;
  path?: string;
}

export interface KnowledgeBaseDashboardRecommendationCard {
  id: string;
  title: string;
  path: string;
  kind: KnowledgeBaseDashboardCardKind;
  summary: string;
  tags: string[];
  status: string;
  touchedAt: number;
  score: number;
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
    digestStatus: KnowledgeBaseRawDigestStatus;
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
    latestReportTitle: string;
    latestReportSummary: string;
    latestReportMtime: number;
  };
  inbox: KnowledgeBaseDashboardDirectory & {
    todayCount: number;
  };
  health: KnowledgeBaseDashboardHealth;
  checkFreshness: KnowledgeBaseDashboardCheckFreshness;
  checkHeatmap: KnowledgeBaseDashboardHeatmapDay[];
  activity: {
    days: KnowledgeBaseDashboardActivityDay[];
    heatmapRows: KnowledgeBaseDashboardHeatmapRow[];
    logs: KnowledgeBaseDashboardActivityLog[];
  };
  recommendations: {
    cards: KnowledgeBaseDashboardRecommendationCard[];
  };
  warnings: string[];
}

export interface KnowledgeBaseDashboardOptions {
  maxRawFingerprintBytes?: number;
  maxTotalRawFingerprintBytes?: number;
}

const MAX_DASHBOARD_FILES = 3000;
const RECENT_FILE_LIMIT = 18;
const RECOMMENDATION_PREVIEW_LIMIT = 96;
const RAW_PROCESSING_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const HEALTH_SCORE_THRESHOLD_TEXT = "85+ 健康，60-84 风险，低于 60 异常。";
const HEALTH_SCORE_CHECK_NOTE = "体检成功只代表检查完成；健康分反映检查发现的结构问题。";
const CRITICAL_HEALTH_PENALTY = 24;
const RISK_HEALTH_PENALTY = 2;

export async function buildKnowledgeBaseDashboardSnapshot(vaultPath: string, settings: KnowledgeBaseSettings, options: KnowledgeBaseDashboardOptions = {}): Promise<KnowledgeBaseDashboardSnapshot> {
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
  const rawSourceFiles = raw.files.filter(isRawProcessingSource);
  const registry = await readRawDigestRegistry(vaultPath);
  const rawContentFiles = await attachRawFingerprints(
    vaultPath,
    rawSourceFiles,
    processedSources,
    registry.entries,
    createKnowledgeBaseIoBudget({
      maxFileBytes: options.maxRawFingerprintBytes,
      maxTotalBytes: options.maxTotalRawFingerprintBytes
    })
  );
  const trackerHints = await readKnowledgeBaseTrackerHints(vaultPath, trackerPath, rawContentFiles);
  const rawDigestStatus = buildRawDigestStatus(rawContentFiles, processedSources, registry.entries, trackerHints.paths);
  const mergedProcessedSources = authoritativeProcessedSources(rawContentFiles, processedSources, registry.entries);
  const reportFindings = await readReportFindings(vaultPath, reportPath);
  const maintenanceHistory = normalizeMaintenanceHistory(settings.maintenanceHistory ?? [], settings.healthHistory ?? []);
  const rawChangedCount = rawDigestStatus.pending + rawDigestStatus.changed;
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
  const activityDays = buildActivityDays({
    generatedAt,
    rawFiles: rawContentFiles,
    wikiFiles: wiki.files.filter((file) => file.path !== "wiki/index.md"),
    inboxFiles: inbox.files,
    outputFiles: visibleDashboardCardFiles(outputs.files),
    healthHistory: settings.healthHistory ?? [],
    maintenanceHistory
  });
  const recommendationCards = await buildRecommendationCards(vaultPath, {
    rawFiles: rawContentFiles,
    wikiFiles: wiki.files,
    inboxFiles: inbox.files,
    outputFiles: outputs.files,
    generatedAt,
    latestReportPath: reportPath,
    latestReportSummary: reportFindings.summary,
    processedSources,
    registryEntries: registry.entries,
    trackerHints: trackerHints.paths
  });
  const health = buildHealth({
    settings,
    generatedAt,
    latestExternalCheckAt: 0,
    maintenanceHistory,
    latestReportFindings: reportFindings,
    rulesFileExists,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    wikiIndexExists,
    trackerExists,
    rawChangedCount,
    rawDigestStatus,
    inboxCount: inbox.fileCount,
    warnings
  });
  const checkFreshness = buildCheckFreshness(settings.healthHistory ?? [], generatedAt, 0, maintenanceHistory);

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
      ...stripLimited(raw, rawContentFiles),
      changedCount: rawChangedCount,
      todayCount: rawTodayCount,
      digestStatus: rawDigestStatus
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
      latestReportExists: reportExists,
      latestReportTitle: reportFindings.title,
      latestReportSummary: reportFindings.summary,
      latestReportMtime: reportFindings.checkedAt
    },
    inbox: {
      ...stripLimited(inbox),
      todayCount: inboxTodayCount
    },
    health,
    checkFreshness,
    checkHeatmap: buildCheckHeatmap(settings.healthHistory ?? [], generatedAt, maintenanceHistory),
    activity: {
      days: activityDays,
      heatmapRows: buildActivityHeatmapRows(activityDays),
      logs: buildActivityLogs({
        generatedAt,
        rawChangedCount,
        rawTodayCount,
        wikiTodayCount,
        inboxCount: inbox.fileCount,
        inboxTodayCount,
        latestReportPath: reportPath,
        latestReportTitle: reportFindings.title,
        latestReportMtime: reportFindings.checkedAt,
        latestMaintenance: latestMaintenanceEntry(maintenanceHistory),
        health,
        warnings
      })
    },
    recommendations: {
      cards: recommendationCards
    },
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
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn(`read dashboard directory ${path.relative(vaultPath, current) || "."}`));
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

function stripLimited(input: DashboardScanResult, files: KnowledgeBaseDashboardFile[] = input.files): KnowledgeBaseDashboardDirectory {
  const recentFiles = files === input.files
    ? input.recentFiles
    : [...files].sort((left, right) => right.mtime - left.mtime).slice(0, RECENT_FILE_LIMIT);
  return {
    path: input.path,
    exists: input.exists,
    fileCount: files.length,
    folderCount: input.folderCount,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    recentFiles
  };
}

async function attachRawFingerprints(
  vaultPath: string,
  files: KnowledgeBaseDashboardFile[],
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, RawDigestRegistryEntry>,
  budget: KnowledgeBaseIoBudget
): Promise<KnowledgeBaseDashboardFile[]> {
  const result: KnowledgeBaseDashboardFile[] = [];
  for (const file of files) {
    const cachedFingerprint = cachedRawFingerprint(file, processed, registryEntries);
    if (cachedFingerprint) {
      result.push({ ...file, fingerprint: cachedFingerprint, rawDigest: null });
      continue;
    }
    if (!shouldReadKnowledgeBaseFileContent(file, budget).ok) {
      result.push(file);
      continue;
    }
    const content = await fsp.readFile(path.join(vaultPath, file.path)).catch(() => null);
    result.push({
      ...file,
      ...(content !== null ? {
        fingerprint: rawDigestFingerprint(file.path, content),
        rawDigest: rawDigestRecordFromMarkdown(content)
      } : {})
    });
  }
  return result;
}

function cachedRawFingerprint(
  file: KnowledgeBaseDashboardFile,
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, RawDigestRegistryEntry>
): string {
  const registry = registryEntries[file.path];
  if (registry?.fingerprint && rawFileMetadataMatches(file, registry)) return registry.fingerprint;
  if (isRawMarkdownPath(file.path)) return "";
  const previous = processed[file.path];
  if (previous?.fingerprint && rawFileMetadataMatches(file, previous)) return previous.fingerprint;
  return "";
}

function rawFileMetadataMatches(file: KnowledgeBaseDashboardFile, cached: { size: number; mtime: number }): boolean {
  return file.size === cached.size && Math.abs(file.mtime - cached.mtime) < 1;
}

function buildRawDigestStatus(
  files: KnowledgeBaseDashboardFile[],
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, RawDigestRegistryEntry>,
  trackerHints: Set<string>
): KnowledgeBaseRawDigestStatus {
  const status: KnowledgeBaseRawDigestStatus = { digested: 0, pending: 0, changed: 0, calibration: 0, failed: 0 };
  for (const file of files) {
    const state = rawDigestStateForRecord({
      fingerprint: file.fingerprint ?? "",
      frontmatter: file.rawDigest ?? null,
      previous: processed[file.path],
      registry: registryEntries[file.path],
      hasTrackerHint: trackerHints.has(file.path)
    });
    status[state] += 1;
  }
  return status;
}

function authoritativeProcessedSources(
  files: KnowledgeBaseDashboardFile[],
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, RawDigestRegistryEntry>
): Record<string, { size: number; mtime: number; fingerprint?: string }> {
  const result: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  for (const file of files) {
    if (!file.fingerprint) continue;
    const previous = processed[file.path];
    const registry = registryEntries[file.path];
    if (
      rawDigestRecordIsTrusted(file.rawDigest ?? null, file.fingerprint)
      || registry?.fingerprint === file.fingerprint
      || previous?.fingerprint === file.fingerprint
    ) {
      result[file.path] = { size: file.size, mtime: file.mtime, fingerprint: file.fingerprint };
    }
  }
  return result;
}

interface ActivityDaysInput {
  generatedAt: number;
  rawFiles: KnowledgeBaseDashboardFile[];
  wikiFiles: KnowledgeBaseDashboardFile[];
  inboxFiles: KnowledgeBaseDashboardFile[];
  outputFiles: KnowledgeBaseDashboardFile[];
  healthHistory: KnowledgeBaseHealthHistoryEntry[];
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
}

function buildActivityDays(input: ActivityDaysInput): KnowledgeBaseDashboardActivityDay[] {
  const year = new Date(input.generatedAt).getFullYear();
  const cursor = parseDateKey(`${year}-01-01`);
  const byDate = new Map<string, KnowledgeBaseDashboardActivityDay>();
  while (cursor.getFullYear() === year) {
    const date = formatLocalDateKey(cursor.getTime());
    byDate.set(date, { date, raw: 0, wiki: 0, inbox: 0, outputs: 0, checks: 0, failures: 0, total: 0, status: "none" });
    cursor.setDate(cursor.getDate() + 1);
  }

  const addFiles = (files: KnowledgeBaseDashboardFile[], bucket: "raw" | "wiki" | "inbox" | "outputs") => {
    for (const file of files) {
      const day = byDate.get(formatLocalDateKey(file.mtime));
      if (!day) continue;
      day[bucket] += 1;
    }
  };
  addFiles(input.rawFiles, "raw");
  addFiles(visibleDashboardCardFiles(input.wikiFiles), "wiki");
  addFiles(visibleDashboardCardFiles(input.inboxFiles), "inbox");
  addFiles(visibleDashboardCardFiles(input.outputFiles), "outputs");

  for (const [date, status] of statusByCheckDate(input.healthHistory, input.maintenanceHistory)) {
    const day = byDate.get(date);
    if (!day) continue;
    day.checks = 1;
    day.failures = status === "failed" ? 1 : 0;
    day.status = status;
  }

  for (const day of byDate.values()) {
    day.total = day.raw + day.wiki + day.inbox + day.outputs + day.checks;
  }
  return Array.from(byDate.values());
}

function buildActivityHeatmapRows(days: KnowledgeBaseDashboardActivityDay[]): KnowledgeBaseDashboardHeatmapRow[] {
  return [
    { id: "health", label: "知识健康度", cells: buildWeeklyCells(days, (day) => day.checks, true) },
    { id: "wiki", label: "Wiki 变更", cells: buildWeeklyCells(days, (day) => day.wiki, false) },
    { id: "raw", label: "Raw 变更", cells: buildWeeklyCells(days, (day) => day.raw, false) },
    { id: "maintenance", label: "维护完成", cells: buildWeeklyCells(days, (day) => day.checks, true) }
  ];
}

function buildWeeklyCells(
  days: KnowledgeBaseDashboardActivityDay[],
  countForDay: (day: KnowledgeBaseDashboardActivityDay) => number,
  includeStatus: boolean
): KnowledgeBaseDashboardHeatmapCell[] {
  const result: KnowledgeBaseDashboardHeatmapCell[] = [];
  const cellCount = 52;
  for (let index = 0; index < cellCount; index += 1) {
    const start = Math.floor((index * days.length) / cellCount);
    const end = Math.max(start + 1, Math.floor(((index + 1) * days.length) / cellCount));
    const slice = days.slice(start, end);
    const count = slice.reduce((sum, day) => sum + countForDay(day), 0);
    const failed = includeStatus && slice.some((day) => day.failures > 0);
    const success = includeStatus && slice.some((day) => day.checks > 0);
    result.push({
      startDate: slice[0]?.date ?? "",
      endDate: slice.at(-1)?.date ?? "",
      count,
      level: failed ? "bad" : activityLevelForCount(count),
      status: failed ? "failed" : success ? "success" : "none"
    });
  }
  return result;
}

function activityLevelForCount(count: number): KnowledgeBaseDashboardActivityLevel {
  if (count >= 6) return "high";
  if (count >= 3) return "mid";
  if (count >= 1) return "low";
  return "none";
}

interface ActivityLogsInput {
  generatedAt: number;
  rawChangedCount: number;
  rawTodayCount: number;
  wikiTodayCount: number;
  inboxCount: number;
  inboxTodayCount: number;
  latestReportPath: string;
  latestReportTitle: string;
  latestReportMtime: number;
  latestMaintenance: KnowledgeBaseMaintenanceHistoryEntry | null;
  health: KnowledgeBaseDashboardHealth;
  warnings: string[];
}

function buildActivityLogs(input: ActivityLogsInput): KnowledgeBaseDashboardActivityLog[] {
  const logs: KnowledgeBaseDashboardActivityLog[] = [];
  const add = (log: Omit<KnowledgeBaseDashboardActivityLog, "id">) => {
    logs.push({ ...log, id: `${log.label}:${log.at}:${logs.length}` });
  };

  if (input.latestMaintenance) {
    const failed = input.latestMaintenance.status === "failed";
    add({
      label: failed ? "任务失败" : maintenanceModeDoneLabel(input.latestMaintenance.mode),
      text: input.latestMaintenance.reportPath || `知识健康度 ${input.health.score}/100`,
      at: input.latestMaintenance.at,
      tone: failed ? "red" : "green",
      path: input.latestMaintenance.reportPath || undefined
    });
  }
  if (input.rawChangedCount > 0) {
    add({
      label: "Raw 待提炼",
      text: `${input.rawChangedCount} 条来源需要进入维护；今日新增 ${input.rawTodayCount} 条。`,
      at: input.generatedAt,
      tone: "orange"
    });
  }
  if (input.wikiTodayCount > 0) {
    add({
      label: "Wiki 更新",
      text: `今天更新 ${input.wikiTodayCount} 条结构化知识。`,
      at: input.generatedAt,
      tone: "blue"
    });
  }
  if (input.inboxCount > 0) {
    add({
      label: "Inbox 待分流",
      text: `${input.inboxCount} 条临时输入待归位；今日新增 ${input.inboxTodayCount} 条。`,
      at: input.generatedAt,
      tone: "purple"
    });
  }
  if (input.latestReportPath && input.latestReportMtime) {
    add({
      label: "维护报告",
      text: input.latestReportTitle || titleFromDashboardPath(input.latestReportPath),
      at: input.latestReportMtime,
      tone: input.warnings.length ? "orange" : "blue",
      path: input.latestReportPath
    });
  }
  if (!logs.length) {
    add({
      label: "等待扫描",
      text: "还没有可展示的知识库行动记录。",
      at: input.generatedAt,
      tone: "muted"
    });
  }
  return logs.sort((left, right) => right.at - left.at).slice(0, 6);
}

function maintenanceModeDoneLabel(mode: KnowledgeBaseMaintenanceMode): string {
  if (mode === "maintain") return "维护完成";
  if (mode === "reingest") return "重新提炼完成";
  if (mode === "outputs") return "输出整理完成";
  if (mode === "inbox") return "Inbox 整理完成";
  return "体检完成";
}

interface RecommendationInput {
  rawFiles: KnowledgeBaseDashboardFile[];
  wikiFiles: KnowledgeBaseDashboardFile[];
  inboxFiles: KnowledgeBaseDashboardFile[];
  outputFiles: KnowledgeBaseDashboardFile[];
  generatedAt: number;
  latestReportPath: string;
  latestReportSummary: string;
  processedSources: Record<string, { size: number; mtime: number; fingerprint?: string }>;
  registryEntries: Record<string, RawDigestRegistryEntry>;
  trackerHints: Set<string>;
}

async function buildRecommendationCards(vaultPath: string, input: RecommendationInput): Promise<KnowledgeBaseDashboardRecommendationCard[]> {
  const candidates: RecommendationCandidate[] = [];
  const addCandidates = (files: KnowledgeBaseDashboardFile[], kind: KnowledgeBaseDashboardCardKind) => {
    for (const file of visibleDashboardCardFiles(files)) {
      const rawState = kind === "raw"
        ? rawDigestStateForRecord({
          fingerprint: file.fingerprint ?? "",
          frontmatter: file.rawDigest ?? null,
          previous: input.processedSources[file.path],
          registry: input.registryEntries[file.path],
          hasTrackerHint: input.trackerHints.has(file.path)
        })
        : null;
      const status = dashboardCardStatus(kind, rawState, file, input.generatedAt);
      candidates.push({
        file,
        kind,
        rawState,
        status,
        score: dashboardCardScore(kind, file, status, input)
      });
    }
  };
  addCandidates(input.rawFiles, "raw");
  addCandidates(input.wikiFiles, "wiki");
  addCandidates(input.inboxFiles, "inbox");
  addCandidates(input.outputFiles, "outputs");
  candidates.sort((left, right) => right.score - left.score || right.file.mtime - left.file.mtime);
  const previewPaths = new Set(candidates.slice(0, RECOMMENDATION_PREVIEW_LIMIT).map((candidate) => candidate.file.path));
  const cards: KnowledgeBaseDashboardRecommendationCard[] = [];
  for (const candidate of candidates) {
    cards.push(await dashboardFileToCard(vaultPath, candidate, input, previewPaths.has(candidate.file.path)));
  }
  return cards;
}

interface RecommendationCandidate {
  file: KnowledgeBaseDashboardFile;
  kind: KnowledgeBaseDashboardCardKind;
  rawState: KnowledgeBaseRawDigestState | null;
  status: string;
  score: number;
}

async function dashboardFileToCard(
  vaultPath: string,
  candidate: RecommendationCandidate,
  input: RecommendationInput,
  shouldReadPreview: boolean
): Promise<KnowledgeBaseDashboardRecommendationCard> {
  const { file, kind, status, score } = candidate;
  const preview = shouldReadPreview ? await readDashboardTextPreview(vaultPath, file) : "";
  const reportSummary = kind === "outputs" && file.path === input.latestReportPath ? input.latestReportSummary : "";
  return {
    id: `${kind}:${file.path}`,
    title: markdownTitle(preview, titleFromDashboardPath(file.path)),
    path: file.path,
    kind,
    summary: reportSummary || markdownSummary(preview, dashboardCardFallbackSummary(kind, status)),
    tags: dashboardCardTags(file.path, kind),
    status,
    touchedAt: file.mtime,
    score
  };
}

function dashboardCardStatus(kind: KnowledgeBaseDashboardCardKind, rawState: KnowledgeBaseRawDigestState | null, file: KnowledgeBaseDashboardFile, generatedAt: number): string {
  if (kind === "raw") return rawDigestStateLabel(rawState ?? "pending");
  if (kind === "inbox") return "Inbox 待分流";
  if (kind === "outputs") return "维护报告";
  return isSameLocalDay(file.mtime, generatedAt) ? "Wiki 更新" : "Wiki 笔记";
}

function dashboardCardScore(kind: KnowledgeBaseDashboardCardKind, file: KnowledgeBaseDashboardFile, status: string, input: RecommendationInput): number {
  const days = Math.max(0, daysBetweenDateKeys(formatLocalDateKey(file.mtime), formatLocalDateKey(input.generatedAt)));
  const recency = Math.max(0, 30 - Math.min(30, days * 3));
  if (kind === "raw") return recency + (status === "提炼失败" ? 96 : status === "Raw 待提炼" ? 90 : status === "待重新提炼" ? 86 : status === "待校准" ? 58 : 28);
  if (kind === "inbox") return recency + 70;
  if (kind === "wiki") return recency + (status === "Wiki 更新" ? 80 : 38);
  return recency + (file.path === input.latestReportPath ? 62 : 34);
}

function dashboardCardFallbackSummary(kind: KnowledgeBaseDashboardCardKind, status: string): string {
  if (kind === "raw") {
    if (status === "已提炼") return "原始来源已登记，可作为后续引用和复盘依据。";
    if (status === "待校准") return "历史记录显示可能已提炼，但仍需要校准可信证据。";
    if (status === "待重新提炼") return "这条来源内容变化，需要重新进入四步提炼。";
    if (status === "提炼失败") return "上次提炼失败，需要重新写入 Wiki / Projects 并验证来源证据。";
    return "这条来源还需要进入 Wiki / Projects 的结构化知识。";
  }
  if (kind === "wiki") return "结构化知识页，可作为问答、复盘和关联推荐依据。";
  if (kind === "inbox") return "临时收集内容，需要判断进入 Raw、Wiki、Journal 还是项目区。";
  return "近期输出记录，可用于复盘、沉淀和追踪 Agent 工作结果。";
}

function dashboardCardTags(relativePath: string, kind: KnowledgeBaseDashboardCardKind): string[] {
  const parts = relativePath.split("/").filter(Boolean);
  const tags = [kind === "outputs" ? "Output" : kind[0].toUpperCase() + kind.slice(1)];
  if (parts.length > 1) tags.push(parts[1].replace(/\.(md|markdown)$/i, ""));
  if (/reddit|github|wechat|公众号|小红书|xhs/i.test(relativePath)) tags.push("来源");
  return tags.slice(0, 3);
}

function visibleDashboardCardFiles(files: KnowledgeBaseDashboardFile[]): KnowledgeBaseDashboardFile[] {
  return files.filter((file) => !isDashboardSystemFile(file.path));
}

function isDashboardSystemFile(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? relativePath;
  if (parts.some((part) => part.startsWith("."))) return true;
  if (basename.startsWith(".")) return true;
  if (/^(index|raw\/index|wiki\/index)\.(md|markdown|json)$/i.test(relativePath)) return true;
  if (/^(index|00-索引)\.(md|markdown)$/i.test(basename)) return true;
  if (/(\.ingest-tracker|\.raw-digest-registry)\.(md|json)$/i.test(basename)) return true;
  return false;
}

async function readDashboardTextPreview(vaultPath: string, file: KnowledgeBaseDashboardFile): Promise<string> {
  const ext = path.extname(file.path).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown" && ext !== ".txt") return "";
  if (file.size > 262_144) return "";
  return fsp.readFile(path.join(vaultPath, file.path), "utf8").catch(() => "");
}

function markdownTitle(text: string, fallback: string): string {
  const body = stripFrontmatter(text);
  for (const line of body.split(/\r?\n/)) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim().replace(/\s+#*$/, "") || fallback;
  }
  return fallback;
}

function markdownSummary(text: string, fallback: string): string {
  const frontmatterSummary = frontmatterTextValue(text, ["summary", "摘要", "description", "描述"]);
  if (frontmatterSummary) return truncateText(frontmatterSummary, 96);
  const body = stripFrontmatter(text);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s+/.test(line) || /^\|?\s*:?-{3,}/.test(line) || /^\|/.test(line)) continue;
    const clean = line.replace(/^[-*+]\s+/, "").replace(/^>\s*/, "").trim();
    if (clean) return truncateText(clean, 96);
  }
  return fallback;
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function frontmatterTextValue(text: string, keys: string[]): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return "";
  for (const key of keys) {
    const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.+)$`, "im");
    const value = pattern.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  return "";
}

function titleFromDashboardPath(relativePath: string): string {
  const basename = relativePath.split("/").pop() ?? relativePath;
  return basename.replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/i, "") || relativePath;
}

function truncateText(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ReportFindings {
  checkedAt: number;
  title: string;
  summary: string;
  brokenLinks: number;
  orphanPages: number;
  staleItems: number;
  indexInvalid: boolean;
}

async function readReportFindings(vaultPath: string, reportPath: string): Promise<ReportFindings> {
  const empty: ReportFindings = { checkedAt: 0, title: "", summary: "", brokenLinks: 0, orphanPages: 0, staleItems: 0, indexInvalid: false };
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
    title: markdownTitle(text, titleFromDashboardPath(normalized)),
    summary: markdownSummary(text, "最近维护报告已生成，可打开查看完整结果。"),
    brokenLinks: firstNumber(text, [
      /\|\s*全\s*wiki\s*(?:实质性断链|硬断链|断链)出现次数\s*\|\s*(\d+)\s*\|/i,
      /(?:实质性断链|硬断链|断链)出现次数[^\d\n]*(\d+)/i,
      /(?:实质性断链|硬断链|断链)[：:]\s*(\d+)/i,
      /(?:实质性断链|硬断链|断链)[^\d\n]*(\d+)\s*处/i
    ]),
    orphanPages: firstNumber(text, [
      /\|\s*孤儿页面\s*\|\s*(\d+)\s*\|/i,
      /孤儿页面[：:]\s*(\d+)/i,
      /孤儿页面[^\d\n]*(\d+)\s*个/i
    ]),
    staleItems: firstNumber(text, [
      /\|\s*draft\s*\/\s*TODO\s*\/\s*待补等命中文件\s*\|\s*(\d+)\s*\|/i,
      /draft\s*\/\s*TODO\s*\/\s*待补等命中文件[^\d\n]*(\d+)/i,
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
    .filter((file) => /^outputs\/(?:maintenance\/)?kb-(?:maintenance|check)-.+\.md$/i.test(file.path))
    .sort((left, right) => right.mtime - left.mtime)[0];
  return latest?.path ?? normalized;
}

async function countImmediateDirectories(root: string): Promise<number> {
  const entries: fs.Dirent[] = await fsp.readdir(root, { withFileTypes: true }).catch(emptyArrayOnMissingPathOrWarn("read dashboard report directory"));
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
}

interface HealthInput {
  settings: KnowledgeBaseSettings;
  generatedAt: number;
  latestExternalCheckAt: number;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  latestReportFindings: ReportFindings;
  rulesFileExists: boolean;
  rawExists: boolean;
  wikiExists: boolean;
  wikiIndexExists: boolean;
  trackerExists: boolean;
  rawChangedCount: number;
  rawDigestStatus: KnowledgeBaseRawDigestStatus;
  inboxCount: number;
  warnings: string[];
}

function buildHealth(input: HealthInput): KnowledgeBaseDashboardHealth {
  const critical: string[] = [];
  const risk: string[] = [];
  const scoreReasons: KnowledgeBaseDashboardHealthScoreReason[] = [];
  const addReason = (
    severity: "critical" | "risk",
    reason: string,
    label: string,
    count: number,
    explanation: string,
    extraPenalty = 0
  ) => {
    if (severity === "critical") critical.push(reason);
    else risk.push(reason);
    scoreReasons.push({
      label,
      count,
      penalty: (severity === "critical" ? CRITICAL_HEALTH_PENALTY : RISK_HEALTH_PENALTY) + extraPenalty,
      explanation
    });
  };

  if (!input.rulesFileExists) addReason("critical", "规则文件缺失", "规则文件缺失", 1, "说明知识库边界规则无法确认。");
  if (!input.rawExists) addReason("critical", "raw 目录缺失", "raw 目录缺失", 1, "说明原始来源区不可用。");
  if (!input.wikiExists) addReason("critical", "wiki 目录缺失", "wiki 目录缺失", 1, "说明沉淀后的知识区不可用。");
  if (!input.wikiIndexExists) addReason("critical", "wiki/index.md 缺失", "wiki/index.md 缺失", 1, "说明知识库入口页不存在。");
  if (!input.trackerExists) addReason("critical", "tracker 缺失", "tracker 缺失", 1, "说明来源消化登记无法确认。");

  const history = normalizeHealthHistory(input.settings.healthHistory ?? []);
  const latestHistory = latestHealthEntry(history);
  const latestMaintenance = latestMaintenanceEntry(input.maintenanceHistory);
  const latestRecordedAt = Math.max(latestHistory?.at ?? 0, latestMaintenance?.at ?? 0);
  const latestRecordedStatus = latestMaintenance && latestMaintenance.at >= (latestHistory?.at ?? 0) ? latestMaintenance.status : latestHistory?.status;
  const latestCheckAt = Math.max(latestRecordedAt, input.latestExternalCheckAt);
  const latestCheckFailed = Boolean(latestRecordedStatus === "failed" && latestRecordedAt >= input.latestExternalCheckAt);
  if (latestCheckFailed) addReason("critical", "最近体检失败", "最近体检失败", 1, "说明最近一次维护或体检没有成功完成。");

  const rawPenalty = input.rawChangedCount > 20 ? 20 : input.rawChangedCount > 5 ? 10 : 0;
  if (input.rawChangedCount > 20) {
    addReason("critical", `Raw 待提炼 ${input.rawChangedCount} 个`, "Raw 待提炼", input.rawChangedCount, "来源还没有进入 Wiki / Projects 的结构化知识，或缺少可信来源证据。", rawPenalty);
  } else if (input.rawChangedCount > 5) {
    addReason("risk", `Raw 待提炼 ${input.rawChangedCount} 个`, "Raw 待提炼", input.rawChangedCount, "来源还没有进入 Wiki / Projects 的结构化知识，或缺少可信来源证据。", rawPenalty);
  }
  if (input.rawDigestStatus.calibration > 0) {
    addReason("risk", `Raw 状态待校准 ${input.rawDigestStatus.calibration} 个`, "Raw 状态待校准", input.rawDigestStatus.calibration, "说明历史记录显示可能已提炼，但还缺少可信机器标记。", input.rawDigestStatus.calibration > 20 ? 8 : 2);
  }

  const inboxPenalty = input.inboxCount > 30 ? 20 : input.inboxCount > 10 ? 10 : 0;
  if (input.inboxCount > 30) {
    addReason("critical", `Inbox 积压 ${input.inboxCount} 个`, "Inbox 积压", input.inboxCount, "说明临时输入区积压较多，尚未整理归位。", inboxPenalty);
  } else if (input.inboxCount > 10) {
    addReason("risk", `Inbox 积压 ${input.inboxCount} 个`, "Inbox 积压", input.inboxCount, "说明临时输入区积压较多，尚未整理归位。", inboxPenalty);
  }

  if (input.latestReportFindings.indexInvalid) addReason("critical", "索引链接异常", "索引链接异常", 1, "说明核心索引中存在不可用链接。");
  if (input.latestReportFindings.brokenLinks > 0) {
    addReason(
      "risk",
      `断链 ${input.latestReportFindings.brokenLinks} 处`,
      "断链",
      input.latestReportFindings.brokenLinks,
      "说明 wiki 中有链接目标不存在。",
      Math.min(24, input.latestReportFindings.brokenLinks * 6)
    );
  }
  if (input.latestReportFindings.orphanPages > 0) {
    addReason(
      "risk",
      `孤儿页面 ${input.latestReportFindings.orphanPages} 个`,
      "孤儿页面",
      input.latestReportFindings.orphanPages,
      "说明页面缺少有效入口或引用。",
      Math.min(12, input.latestReportFindings.orphanPages * 4)
    );
  }
  if (input.latestReportFindings.staleItems > 0) {
    addReason(
      "risk",
      `过时/草稿 ${input.latestReportFindings.staleItems} 处`,
      "过时/草稿",
      input.latestReportFindings.staleItems,
      "说明存在待补、TODO、draft 等内容。",
      Math.min(8, input.latestReportFindings.staleItems * 2)
    );
  }

  const nonCriticalWarnings = input.warnings.filter((warning) => !critical.includes(warning));
  if (nonCriticalWarnings.length) addReason("risk", `存在警告：${nonCriticalWarnings.join("，")}`, "警告", nonCriticalWarnings.length, "说明存在需要人工确认的结构风险。");

  const score = healthScore(scoreReasons);
  const scoreStatus = healthStatusForScore(score, critical.length > 0);
  const status = scoreStatus;
  const label = status === "healthy" ? "健康" : status === "risk" ? "风险" : "异常";
  const reasonTexts = [...critical, ...risk];
  const reasons = reasonTexts.length ? reasonTexts : ["知识库结构正常，待处理数量在安全范围"];
  return {
    status,
    label,
    score,
    reasons,
    scoreSummary: healthScoreSummary(score, status, critical.length > 0),
    scoreReasons,
    scoreCheckNote: HEALTH_SCORE_CHECK_NOTE,
    scoreThresholdText: HEALTH_SCORE_THRESHOLD_TEXT,
    lastCheckAt: latestCheckAt,
    streakDays: countHealthStreakDays(history, input.maintenanceHistory),
  };
}

function buildCheckFreshness(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number, externalCheckAt = 0, maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[] = []): KnowledgeBaseDashboardCheckFreshness {
  const normalized = normalizeHealthHistory(history);
  const latestHistory = latestHealthEntry(normalized);
  const latestMaintenance = latestMaintenanceEntry(maintenanceHistory);
  const latestCheckAt = Math.max(latestHistory?.at ?? 0, latestMaintenance?.at ?? 0, externalCheckAt);
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

function healthScore(reasons: KnowledgeBaseDashboardHealthScoreReason[]): number {
  const totalPenalty = reasons.reduce((sum, reason) => sum + reason.penalty, 0);
  return Math.max(0, Math.min(100, 100 - totalPenalty));
}

function healthStatusForScore(score: number, hasCritical: boolean): KnowledgeBaseDashboardHealthStatus {
  if (hasCritical || score < 60) return "bad";
  if (score < 85) return "risk";
  return "healthy";
}

function healthScoreSummary(score: number, status: KnowledgeBaseDashboardHealthStatus, hasCritical: boolean): string {
  if (status === "bad" && hasCritical && score >= 60) return `当前 ${score} 分，存在关键问题，显示异常。`;
  if (score < 60) return `当前 ${score} 分，低于 60，显示异常。`;
  if (score < 85) return `当前 ${score} 分，位于 60-84，显示风险。`;
  return `当前 ${score} 分，达到 85+，显示健康。`;
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

function normalizeMaintenanceHistory(history: KnowledgeBaseMaintenanceHistoryEntry[], legacyHistory: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseMaintenanceHistoryEntry[] {
  const byDate = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
  const add = (entry: KnowledgeBaseMaintenanceHistoryEntry) => {
    if (!isKnowledgeBaseHeatmapMode(entry.mode)) return;
    const current = byDate.get(entry.date);
    if (current && current.at > entry.at) return;
    byDate.set(entry.date, entry);
  };
  for (const entry of normalizeHealthHistory(legacyHistory)) {
    add({ ...entry, mode: "lint", reportPath: "" });
  }
  for (const entry of history) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || (entry.status !== "success" && entry.status !== "failed")) continue;
    add(entry);
  }
  return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function isKnowledgeBaseHeatmapMode(mode: string): boolean {
  return mode === "lint" || mode === "maintain" || mode === "reingest";
}

function statusByCheckDate(history: KnowledgeBaseHealthHistoryEntry[], maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[]): Map<string, KnowledgeBaseDashboardCheckStatus> {
  const byDate = new Map<string, KnowledgeBaseDashboardCheckStatus>();
  for (const entry of normalizeMaintenanceHistory(maintenanceHistory, [])) {
    byDate.set(entry.date, entry.status);
  }
  for (const entry of normalizeHealthHistory(history)) {
    byDate.set(entry.date, entry.status);
  }
  return byDate;
}

function buildCheckHeatmap(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number, maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[] = []): KnowledgeBaseDashboardHeatmapDay[] {
  const byDate = statusByCheckDate(history, maintenanceHistory);
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

function countHealthStreakDays(history: KnowledgeBaseHealthHistoryEntry[], maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[] = []): number {
  const byDate = statusByCheckDate(history, maintenanceHistory);
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

function latestMaintenanceEntry(history: KnowledgeBaseMaintenanceHistoryEntry[]): KnowledgeBaseMaintenanceHistoryEntry | null {
  const normalized = normalizeMaintenanceHistory(history, []);
  return normalized.length ? normalized[normalized.length - 1] : null;
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
