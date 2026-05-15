import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseSettings } from "../settings/settings";

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
  };
  wiki: KnowledgeBaseDashboardDirectory & {
    indexExists: boolean;
    domainCount: number;
  };
  outputs: KnowledgeBaseDashboardDirectory & {
    latestReportPath: string;
    latestReportExists: boolean;
  };
  inbox: KnowledgeBaseDashboardDirectory;
  warnings: string[];
}

const MAX_DASHBOARD_FILES = 3000;
const RECENT_FILE_LIMIT = 6;

export async function buildKnowledgeBaseDashboardSnapshot(vaultPath: string, settings: KnowledgeBaseSettings): Promise<KnowledgeBaseDashboardSnapshot> {
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
  const warnings = buildWarnings({
    rulesFileExists,
    rawExists: raw.exists,
    wikiExists: wiki.exists,
    trackerExists,
    lastError: settings.lastError,
    scanLimited: raw.limited || wiki.limited || outputs.limited || inbox.limited
  });

  return {
    generatedAt: Date.now(),
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
      changedCount: countChangedProcessed(raw.files.filter((file) => file.path !== "raw/index.md"), processedSources)
    },
    wiki: {
      ...stripLimited(wiki),
      indexExists: wikiIndexExists,
      domainCount: await countImmediateDirectories(path.join(vaultPath, "wiki"))
    },
    outputs: {
      ...stripLimited(outputs),
      latestReportPath: reportPath,
      latestReportExists: reportExists
    },
    inbox: stripLimited(inbox),
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
