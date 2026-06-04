import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseHealthHistoryEntry, KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";
import { AGENTS_RULES_FILE } from "./constants";
import { rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry, type RawDigestFrontmatterRecord, type RawDigestRegistryEntry } from "./raw-digest";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import type { KnowledgeBaseRawDigestStatus } from "./types";

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
const HEALTH_SCORE_THRESHOLD_TEXT = "85+ 健康，60-84 风险，低于 60 异常。";
const HEALTH_SCORE_CHECK_NOTE = "体检成功只代表检查完成；健康分反映检查发现的结构问题。";
const CRITICAL_HEALTH_PENALTY = 24;
const RISK_HEALTH_PENALTY = 2;

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
  const rawSourceFiles = raw.files.filter(isRawProcessingSource);
  const rawContentFiles = await attachRawFingerprints(vaultPath, rawSourceFiles);
  const trackerHints = await readKnowledgeBaseTrackerHints(vaultPath, trackerPath, rawContentFiles);
  const registry = await readRawDigestRegistry(vaultPath);
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
      latestReportExists: reportExists
    },
    inbox: {
      ...stripLimited(inbox),
      todayCount: inboxTodayCount
    },
    health,
    checkFreshness,
    checkHeatmap: buildCheckHeatmap(settings.healthHistory ?? [], generatedAt, maintenanceHistory),
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

async function attachRawFingerprints(vaultPath: string, files: KnowledgeBaseDashboardFile[]): Promise<KnowledgeBaseDashboardFile[]> {
  const result: KnowledgeBaseDashboardFile[] = [];
  for (const file of files) {
    const content = await fsp.readFile(path.join(vaultPath, file.path)).catch(() => null);
    result.push({
      ...file,
      ...(content ? {
        fingerprint: rawDigestFingerprint(file.path, content),
        rawDigest: rawDigestRecordFromMarkdown(content)
      } : {})
    });
  }
  return result;
}

function buildRawDigestStatus(
  files: KnowledgeBaseDashboardFile[],
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, RawDigestRegistryEntry>,
  trackerHints: Set<string>
): KnowledgeBaseRawDigestStatus {
  const status: KnowledgeBaseRawDigestStatus = { digested: 0, pending: 0, changed: 0, calibration: 0 };
  for (const file of files) {
    if (!file.fingerprint) {
      status.pending += 1;
      continue;
    }
    const previous = processed[file.path];
    const registry = registryEntries[file.path];
    const trusted = rawDigestRecordIsTrusted(file.rawDigest ?? null, file.fingerprint)
      || registry?.fingerprint === file.fingerprint
      || previous?.fingerprint === file.fingerprint;
    if (trusted) {
      status.digested += 1;
      continue;
    }
    const changed = Boolean(
      (file.rawDigest?.fingerprint && file.rawDigest.fingerprint !== file.fingerprint)
      || (registry?.fingerprint && registry.fingerprint !== file.fingerprint)
      || (previous?.fingerprint && previous.fingerprint !== file.fingerprint)
    );
    if (changed) {
      status.changed += 1;
      continue;
    }
    if (previous || trackerHints.has(file.path) || file.rawDigest?.processed) {
      status.calibration += 1;
      continue;
    }
    status.pending += 1;
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
  const entries: fs.Dirent[] = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
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
    addReason("critical", `Raw 待提炼 ${input.rawChangedCount} 个`, "Raw 待提炼", input.rawChangedCount, "说明仍有来源未被确认消化或登记。", rawPenalty);
  } else if (input.rawChangedCount > 5) {
    addReason("risk", `Raw 待提炼 ${input.rawChangedCount} 个`, "Raw 待提炼", input.rawChangedCount, "说明仍有来源未被确认消化或登记。", rawPenalty);
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

async function exists(filePath: string): Promise<boolean> {
  return fsp.access(filePath, fs.constants.F_OK).then(() => true, () => false);
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}
