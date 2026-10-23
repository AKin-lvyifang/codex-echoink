import { maintenanceSourceState } from "./maintenance-source-state";
import { buildKnowledgeStructureHealth } from "./health-core";
import { getKnowledgeFolderBindings, knowledgePrivateRoot, knowledgePathRole, knowledgeRoleStatus, knowledgeRolePath, resolveKnowledgePath, knowledgeRoleRoots, type KnowledgeRootRole } from "./root-paths";
import { latestMaintenanceSourceStates, type KnowledgeMaintenanceRecord } from "./maintenance-record";
import { wikiCategoryLabel } from "./wiki-folder-names";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { emptyArrayOnMissingPathOrWarn } from "../core/error-handling";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseMaintenanceMode, KnowledgeBaseSettings } from "../settings/settings";
import { rawDigestStateForRecord, rawDigestStateLabel } from "./digest-status";
import { createKnowledgeBaseIoBudget, shouldReadKnowledgeBaseFileContent, type KnowledgeBaseIoBudget } from "./io-budget";
import { isKnowledgeMaintenanceSourcePath, isRawMarkdownPath, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry, type RawDigestFrontmatterRecord, type RawDigestRegistryEntry } from "./raw-digest";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import type { KnowledgeBaseRawDigestState, KnowledgeBaseRawDigestStatus, KnowledgeBaseRunCompletion } from "./types";
import { isMissingPathError, exists, normalizeSlashes, walkFiles } from "./utils";

export interface KnowledgeBaseDashboardFile {
  path: string;
  size: number;
  mtime: number;
  createdAt?: number;
  fingerprint?: string;
  rawDigest?: RawDigestFrontmatterRecord | null;
  refinementProcessed?: boolean;
  refinementState?: KnowledgeBaseRawDigestState;
}

export interface KnowledgeBaseDashboardDirectory {
  path: string;
  exists: boolean;
  fileCount: number;
  folderCount: number;
  totalSize: number;
  recentFiles: KnowledgeBaseDashboardFile[];
}

export type KnowledgeBaseDashboardHealthStatus = "healthy" | "risk" | "bad" | "unknown";
export type KnowledgeBaseDashboardCheckStatus = "success" | "failed" | "none";
export type KnowledgeBaseDashboardCheckFreshnessStatus = "fresh" | "stale" | "bad" | "missing";

export interface KnowledgeBaseDashboardHealthScoreReason {
  label: string;
  count: number;
  penalty: number;
  explanation: string;
}

export interface KnowledgeBaseDashboardHealth {
  assessment: "local-structure" | "limited" | "uninitialized" | "unavailable";
  coverage: string;
  unchecked: readonly string[];
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

export type KnowledgeBaseDashboardCardKind = "raw" | "wiki" | "inbox" | "outputs";
export type KnowledgeBaseDashboardLogTone = "green" | "blue" | "orange" | "purple" | "red" | "muted";

export interface KnowledgeBaseDashboardActivityDay {
  date: string;
  raw: number;
  wiki: number;
  inbox: number;
  outputs: number;
  checks: number;
  maintenance?: number;
  failures: number;
  total: number;
  status: KnowledgeBaseDashboardCheckStatus;
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
  lastRun: {
    status: string;
    completion: KnowledgeBaseRunCompletion | "";
    attemptCount: number;
    pendingSourceCount: number;
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
  checkActivity?: KnowledgeBaseDashboardHeatmapDay[];
  activity: {
    days: KnowledgeBaseDashboardActivityDay[];
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

export async function buildKnowledgeBaseDashboardSnapshot(vaultPath: string, settings: KnowledgeBaseSettings, options: KnowledgeBaseDashboardOptions = {}): Promise<KnowledgeBaseDashboardSnapshot> {
  const generatedAt = Date.now();
  const readErrors: string[] = [];
  const structureExists = async (relative: string, directory = false): Promise<boolean> => {
    try {
      const stat = await fsp.stat(path.join(vaultPath, relative));
      return directory ? stat.isDirectory() : stat.isFile();
    } catch (error) {
      if (!isMissingPathError(error)) readErrors.push(relative);
      return false;
    }
  };
  const processedSources = settings.processedSources ?? {};
  const bindings = getKnowledgeFolderBindings(vaultPath);
  const raw = await scanDashboardRole(vaultPath, "raw", { skipHidden: true });
  const wiki = await scanDashboardRole(vaultPath, "wiki", { skipHidden: true });
  const outputs = await scanDashboardRole(vaultPath, "outputs", { skipHidden: false, ignoreNames: new Set([".DS_Store"]) });
  const inbox = await scanDashboardRole(vaultPath, "inbox", { skipHidden: true });
  const reportPath = await resolveLatestReportPath(vaultPath, settings.lastReportPath, outputs.files);
  const trackerPath = bindings ? "" : resolveKnowledgePath(vaultPath, "outputs/.ingest-tracker.md");
  const trackerExists = bindings ? true : await structureExists(trackerPath);
  const reportExists = reportPath ? await exists(path.join(vaultPath, reportPath)) : false;
  const wikiIndexPath = bindings?.roles.wiki.writePath ? `${bindings.roles.wiki.writePath}/index.md` : resolveKnowledgePath(vaultPath, "wiki/index.md");
  const wikiIndexExists = await structureExists(wikiIndexPath);
  const rawSourceFiles = [...raw.files, ...inbox.files].filter(file => isKnowledgeMaintenanceSourcePath(file.path));
  const registry = await readRawDigestRegistry(vaultPath, true).catch(() => {
    readErrors.push("来源处理记录");
    return { schemaVersion: 1, updatedAt: "", entries: {} };
  });
  const privateRoot = knowledgePrivateRoot(vaultPath);
  const latestSources = latestMaintenanceSourceStates(privateRoot ? await (await import("../plugin/pi-knowledge-maintenance-production")).readPrivateMaintenanceRecords(privateRoot) : []);
  const fingerprintCoverage = { limited: 0, failed: 0 };
  const rawContentFiles = await attachRawFingerprints(
    vaultPath,
    rawSourceFiles,
    processedSources,
    registry.entries,
    createKnowledgeBaseIoBudget({
      maxFileBytes: options.maxRawFingerprintBytes,
      maxTotalBytes: options.maxTotalRawFingerprintBytes
    }), fingerprintCoverage, latestSources
  );
  const trackerHints = bindings ? { paths: new Set<string>(), updatedAt: 0 } : await readKnowledgeBaseTrackerHints(vaultPath, trackerPath, rawContentFiles, true).catch(() => {
    readErrors.push(trackerPath);
    return { paths: new Set<string>(), updatedAt: 0 };
  });
  const rawDigestStatus = buildRawDigestStatus(rawContentFiles, processedSources, registry.entries, trackerHints.paths, latestSources);
  const mergedProcessedSources = authoritativeProcessedSources(rawContentFiles, processedSources, registry.entries);
  const reportFindings = await readReportFindings(vaultPath, reportPath);
  const maintenanceHistory = normalizeMaintenanceHistory(settings.maintenanceHistory ?? [], settings.healthHistory ?? []);
  const rawChangedCount = rawDigestStatus.pending + rawDigestStatus.changed + rawDigestStatus.failed + rawDigestStatus.calibration;
  const wikiGroups = buildWikiGroups(wiki.files, generatedAt, vaultPath);
  const rawTodayCount = countFilesChangedToday(rawContentFiles, generatedAt);
  const inboxTodayCount = countFilesChangedToday(inbox.files, generatedAt);
  const wikiTodayCount = wiki.files.filter((file) => knowledgeRolePath(file.path) !== "wiki/index.md" && isSameLocalDay(file.createdAt ?? file.mtime, generatedAt)).length;
  const warnings = buildWarnings({
    rawExists: bindings && !bindings.roles.raw.enabled ? true : raw.exists,
    wikiExists: bindings && !bindings.roles.wiki.enabled ? true : wiki.exists,
    trackerExists,
    lastError: settings.lastError,
    scanLimited: raw.limited || wiki.limited || outputs.limited || inbox.limited
  });
  const activityDays = buildActivityDays({
    generatedAt,
    rawFiles: rawContentFiles,
    wikiFiles: wiki.files.filter((file) => knowledgeRolePath(file.path) !== "wiki/index.md"),
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
    readFailed: readErrors.length > 0 || fingerprintCoverage.failed > 0 || [raw, wiki, outputs, inbox].some((scan) => scan.failed),
    limited: fingerprintCoverage.limited > 0 || [raw, wiki, outputs, inbox].some((scan) => scan.limited),
    latestExternalCheckAt: 0,
    maintenanceHistory,
    latestReportFindings: reportFindings,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    wikiIndexExists,
    mappedFolders: !!bindings,
    bindingIssues: bindings ? Object.entries(bindings.roles).filter(([role, binding]) => binding.enabled && !["ready", "disabled"].includes(knowledgeRoleStatus(vaultPath, role as KnowledgeRootRole))).map(([role]) => `${role} 位置尚未绑定或已失效`) : [],
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
    lastRun: {
      status: settings.lastRunStatus,
      completion: settings.lastCompletion ?? "",
      attemptCount: 0,
      pendingSourceCount: settings.lastPendingSources?.length ?? 0,
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
      domainCount: (await Promise.all(knowledgeRoleRoots(vaultPath, "wiki").map((root) => countImmediateDirectories(path.join(vaultPath, root))))).reduce((sum, count) => sum + count, 0),
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
    checkActivity: Array.from(statusByCheckDate(settings.healthHistory ?? [], maintenanceHistory), ([date, status]) => ({ date, status })),
    activity: {
      days: activityDays,
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
  failed: boolean;
}

async function scanDashboardRole(vaultPath: string, role: KnowledgeRootRole, options: DashboardScanOptions): Promise<DashboardScanResult> {
  const roots = knowledgeRoleRoots(vaultPath, role);
  const scans = await Promise.all(roots.map((root) => scanDashboardDirectory(vaultPath, root, options)));
  const bindings = getKnowledgeFolderBindings(vaultPath);
  const files = [...new Map(scans.flatMap(scan => scan.files).filter(file => knowledgePathRole(vaultPath, file.path) === role).map(file => [file.path, file])).values()];
  return {
    path: bindings ? bindings.roles[role].writePath ?? roots.join("、") : resolveKnowledgePath(vaultPath, role), exists: scans.some((scan) => scan.exists),
    fileCount: files.length, folderCount: scans.reduce((sum, scan) => sum + scan.folderCount, 0),
    totalSize: files.reduce((sum, file) => sum + file.size, 0), files,
    recentFiles: [...files].sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_FILE_LIMIT),
    limited: scans.some((scan) => scan.limited), failed: scans.some((scan) => scan.failed)
  };
}

async function scanDashboardDirectory(vaultPath: string, relativeDir: string, options: DashboardScanOptions): Promise<DashboardScanResult> {
  const root = path.join(vaultPath, relativeDir);
  const files: KnowledgeBaseDashboardFile[] = [];
  const folderPaths = new Set<string>();
  let failed = false;
  const rootStat = await fsp.stat(root).catch((error) => { if (!isMissingPathError(error)) failed = true; return null; });
  const rootExists = rootStat?.isDirectory() ?? false;
  let limited = false;
  if (!rootExists) return { path: relativeDir, exists: false, fileCount: 0, folderCount: 0, totalSize: 0, recentFiles: [], files, limited, failed };

  const filePaths = await walkFiles(root, {
    maxFiles: MAX_DASHBOARD_FILES,
    shouldSkipEntry: (entry) => Boolean(options.ignoreNames?.has(entry.name) || (options.skipHidden && entry.name.startsWith("."))),
    onDirectory: (_entry, full) => {
      folderPaths.add(normalizeSlashes(path.relative(vaultPath, full)));
    },
    onReadDirError: (error, current) => {
      failed = true;
      emptyArrayOnMissingPathOrWarn(`read dashboard directory ${path.relative(vaultPath, current) || "."}`)(error);
    }
  });
  limited = filePaths.length >= MAX_DASHBOARD_FILES;
  for (const full of filePaths) {
    const stat = await fsp.stat(full).catch(() => { failed = true; return null; });
    if (!stat) continue;
    files.push({
      path: normalizeSlashes(path.relative(vaultPath, full)),
      size: stat.size,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      mtime: stat.mtimeMs
    });
  }
  const recentFiles = [...files].sort((left, right) => right.mtime - left.mtime).slice(0, RECENT_FILE_LIMIT);
  return {
    path: relativeDir,
    exists: true,
    fileCount: files.length,
    folderCount: folderPaths.size,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    recentFiles,
    files,
    limited,
    failed
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
  budget: KnowledgeBaseIoBudget,
  coverage: { limited: number; failed: number },
  maintenance: ReadonlyMap<string, KnowledgeMaintenanceRecord["sources"][number]>
): Promise<KnowledgeBaseDashboardFile[]> {
  const result: KnowledgeBaseDashboardFile[] = [];
  for (const file of files) {
    const content = await fsp.readFile(path.join(vaultPath, file.path)).catch(() => { coverage.failed += 1; return null; });
    let fingerprint: string | undefined;
    const state = content === null ? "pending" : maintenanceSourceState(content.toString("utf8"), { fingerprint: () => fingerprint = rawDigestFingerprint(file.path, content), registry: registryEntries[file.path], maintenance: maintenance.get(file.path), previous: processed[file.path] });
    result.push({
      ...file,
      ...(fingerprint ? { fingerprint } : {}),
      refinementState: state,
      ...(content !== null ? {
        refinementProcessed: state === "digested",
        rawDigest: rawDigestRecordFromMarkdown(content)
      } : {})
    });
  }
  return result;
}

function isDashboardRawTextPath(relativePath: string): boolean {
  return isRawMarkdownPath(relativePath) || /\.txt$/i.test(relativePath);
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
  trackerHints: Set<string>,
  maintenance: ReadonlyMap<string, KnowledgeMaintenanceRecord["sources"][number]>
): KnowledgeBaseRawDigestStatus {
  const status: KnowledgeBaseRawDigestStatus = { digested: 0, pending: 0, changed: 0, calibration: 0, failed: 0 };
  for (const file of files) {
    const state = file.refinementState ?? "pending";
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

  for (const entry of input.maintenanceHistory) {
    const day = byDate.get(entry.date);
    if (day && entry.status !== "canceled") day.maintenance = (day.maintenance ?? 0) + 1;
  }
  for (const day of byDate.values()) {
    day.total = day.raw + day.wiki + day.inbox + day.outputs + day.checks + (day.maintenance ?? 0);
  }
  return Array.from(byDate.values());
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
    const canceled = input.latestMaintenance.status === "canceled";
    add({
      label: failed
        ? "任务失败"
        : canceled
          ? maintenanceModeCanceledLabel(input.latestMaintenance.mode)
          : maintenanceCompletionDoneLabel(input.latestMaintenance),
      text: input.latestMaintenance.reportPath
        || (canceled ? "本轮没有继续改动知识库" : `知识健康度 ${input.health.score}/100`),
      at: input.latestMaintenance.at,
      tone: failed ? "red" : canceled ? "muted" : "green",
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

function maintenanceModeCanceledLabel(mode: KnowledgeBaseMaintenanceMode): string {
  if (mode === "maintain") return "维护已取消";
  if (mode === "reingest") return "重新提炼已取消";
  if (mode === "outputs") return "输出整理已取消";
  if (mode === "inbox") return "Inbox 整理已取消";
  return "体检已取消";
}

function maintenanceCompletionDoneLabel(entry: KnowledgeBaseMaintenanceHistoryEntry): string {
  if (entry.completion === "partial") return "维护部分完成";
  if (entry.completion === "recovered") return "维护恢复后完成";
  if (entry.completion === "noop") return "维护已检查（无新来源）";
  return maintenanceModeDoneLabel(entry.mode);
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
      const rawState = kind === "raw" ? file.refinementState ?? "pending" : null;
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
}

// A report is display content, never host-verified structural evidence.
async function readReportFindings(vaultPath: string, reportPath: string): Promise<ReportFindings> {
  const empty = { checkedAt: 0, title: "", summary: "" };
  const normalized = normalizeRelativePath(reportPath, "");
  if (!normalized) return empty;
  const absolute = path.join(vaultPath, normalized);
  const [text, stat] = await Promise.all([fsp.readFile(absolute, "utf8").catch(() => ""), fsp.stat(absolute).catch(() => null)]);
  if (!text.trim() || !stat) return empty;
  return { checkedAt: stat.mtimeMs, title: markdownTitle(text, titleFromDashboardPath(normalized)), summary: markdownSummary(text, "最近维护报告已生成，可打开查看完整结果。") };
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
  mappedFolders?: boolean;
  bindingIssues?: string[];
  readFailed: boolean;
  limited: boolean;
  settings: KnowledgeBaseSettings;
  generatedAt: number;
  latestExternalCheckAt: number;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  latestReportFindings: ReportFindings;
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
  return buildKnowledgeStructureHealth(input);
}

function buildCheckFreshness(history: KnowledgeBaseHealthHistoryEntry[], generatedAt: number, externalCheckAt = 0, maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[] = []): KnowledgeBaseDashboardCheckFreshness {
  const normalized = normalizeHealthHistory(history);
  const latestHistory = latestHealthEntry(normalized.filter((entry) => entry.status === "success"));
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

function buildWikiGroups(files: KnowledgeBaseDashboardFile[], generatedAt: number, vaultPath: string): KnowledgeBaseDashboardWikiGroup[] {
  const groups = new Map<string, KnowledgeBaseDashboardWikiGroup>();
  for (const file of files) {
    if (knowledgePathRole(vaultPath, file.path) !== "wiki") continue;
    const root = knowledgeRoleRoots(vaultPath, "wiki").filter(directory => file.path.startsWith(`${directory}/`)).sort((a, b) => b.length - a.length)[0];
    if (!root) continue;
    const parts = file.path.slice(root.length + 1).split("/");
    const folder = parts.length > 1 ? parts[0] : root.split("/").at(-1)!;
    if (!folder || folder.startsWith(".")) continue;
    const groupPath = parts.length > 1 ? `${root}/${folder}` : root;
    const group = groups.get(groupPath) ?? { path: groupPath, label: wikiCategoryLabel(folder), totalCount: 0, sharePercent: 0, todayCount: 0 };
    group.totalCount += 1;
    if (isSameLocalDay(file.createdAt ?? file.mtime, generatedAt)) group.todayCount += 1;
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

function normalizeMaintenanceHistory(history: KnowledgeBaseMaintenanceHistoryEntry[], _legacyHistory: KnowledgeBaseHealthHistoryEntry[]): KnowledgeBaseMaintenanceHistoryEntry[] {
  const byRun = new Map<string, KnowledgeBaseMaintenanceHistoryEntry>();
  for (const entry of history) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !["success", "failed", "canceled"].includes(entry.status)) continue;
    byRun.set(entry.runId || `${entry.at}:${entry.mode}:${entry.status}`, entry);
  }
  return [...byRun.values()].sort((a, b) => a.at - b.at);
}

function statusByCheckDate(history: KnowledgeBaseHealthHistoryEntry[], maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[]): Map<string, KnowledgeBaseDashboardCheckStatus> {
  const byDate = new Map<string, KnowledgeBaseDashboardCheckStatus>();
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
  return isKnowledgeMaintenanceSourcePath(file.path);
}

function buildWarnings(input: { rawExists: boolean; wikiExists: boolean; trackerExists: boolean; lastError: string; scanLimited: boolean }): string[] {
  const warnings: string[] = [];
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
