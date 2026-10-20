import type { App } from "obsidian";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { classifyKnowledgePath, emptyKnowledgeFolderBindings, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeBaseDashboardHealth, KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import type { KnowledgeLinkHealth } from "../knowledge-base/link-health";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { knowledgePagePathStat, loadKnowledgeSourceHealth, type KnowledgeSourceHealth } from "../knowledge-base/source-health";
import type { KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";
import { mergeKnowledgeMaintenanceHistory } from "../settings/knowledge-maintenance-history";

export type KnowledgePageDirectoryRole = "raw" | "wiki" | "projects" | "inbox";
export type KnowledgePageDirectoryState = "ready" | "partial" | "disabled" | "unbound" | "invalid" | "unavailable";
export interface KnowledgePageDirectoryRoot {
  path: string;
  state: KnowledgePageDirectoryState;
  count: number | null;
  latestMtime: number;
  error?: string;
}
export interface KnowledgePageDirectory {
  role: KnowledgePageDirectoryRole;
  state: KnowledgePageDirectoryState;
  count: number | null;
  unit: "份" | "篇" | "个" | "条";
  latestMtime: number;
  roots: KnowledgePageDirectoryRoot[];
}
export interface KnowledgePageActivityDay { date: string; added: number; organized: number; total: number; }
export interface KnowledgePageHost {
  app: Pick<App, "vault">;
  settings: { knowledgeBase?: KnowledgeBaseSettings };
  settingsKnowledgeBindings?(): KnowledgeFolderBindings | null | undefined;
  getKnowledgeSurfaceService(): {
    getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot>;
    getMaintenanceRecords?(): Promise<KnowledgeMaintenanceRecord[]>;
  } | null;
}
export interface KnowledgePageSnapshot {
  generatedAt: number;
  bindings: KnowledgeFolderBindings;
  dashboard: KnowledgeBaseDashboardSnapshot | null;
  health: KnowledgeBaseDashboardHealth | null;
  weekly: { added: number | null; organized: number | null; weekStart: number; unknownCreatedAtCount: number };
  activityDays: KnowledgePageActivityDay[];
  directories: KnowledgePageDirectory[];
  links: KnowledgeLinkHealth;
  sources: KnowledgeSourceHealth;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  maintenanceRecords: KnowledgeMaintenanceRecord[];
  errors: Partial<Record<"health" | "activity" | "directories" | "links" | "sources" | "history", string>>;
}

interface PageFile { path: string; mtime: number; birthtime: number | null; }
interface DirectoryScan { directory: KnowledgePageDirectory; files: PageFile[]; }
const RAW_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const markdown = (file: string): boolean => /\.(?:md|markdown)$/iu.test(file);
const yieldFrame = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Local calendar dates retain the year, including ranges crossing New Year's Day. */
export function knowledgePageLocalDate(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function localWeekStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date.getTime();
}
function maintenanceAt(entry: KnowledgeBaseMaintenanceHistoryEntry): number | null {
  if (Number.isFinite(entry.at) && entry.at > 0) return entry.at;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(entry.date);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return knowledgePageLocalDate(date.getTime()) === entry.date ? date.getTime() : null;
}
function completedMaintenance(entry: KnowledgeBaseMaintenanceHistoryEntry): boolean {
  // Legacy Outputs and Inbox runs also executed organization and recorded formal terminal batches.
  if (entry.mode !== "maintain" && entry.mode !== "reingest" && entry.mode !== "inbox" && entry.mode !== "outputs") return false;
  if (entry.status !== "success") return false;
  if (entry.resultStatus) return entry.resultStatus === "completed" || entry.resultStatus === "noop";
  return !entry.completion || entry.completion === "full" || entry.completion === "noop";
}

/** Shared event collection for the weekly figures and every heatmap range. */
export function aggregateKnowledgePageActivity(files: readonly PageFile[], history: readonly KnowledgeBaseMaintenanceHistoryEntry[], now: number): {
  weekly: KnowledgePageSnapshot["weekly"]; activityDays: KnowledgePageActivityDay[];
} {
  const weekStart = localWeekStart(now), days = new Map<string, KnowledgePageActivityDay>();
  let added = 0, organized = 0, unknownCreatedAtCount = 0;
  const add = (at: number, kind: "added" | "organized"): void => {
    if (!Number.isFinite(at) || at <= 0 || at > now) return;
    const date = knowledgePageLocalDate(at), day = days.get(date) ?? { date, added: 0, organized: 0, total: 0 };
    day[kind]++; day.total++; days.set(date, day);
    if (at >= weekStart) { if (kind === "added") added++; else organized++; }
  };
  for (const file of new Map(files.map(file => [file.path, file])).values()) {
    if (file.birthtime === null || !Number.isFinite(file.birthtime) || file.birthtime <= 0 || file.birthtime > now) unknownCreatedAtCount++;
    else add(file.birthtime, "added");
  }
  // The history merger owns private-record precedence and run/record identity.
  for (const entry of mergeKnowledgeMaintenanceHistory(history, [])) if (completedMaintenance(entry)) {
    const at = maintenanceAt(entry);
    if (at !== null) add(at, "organized");
  }
  return { weekly: { added, organized, weekStart, unknownCreatedAtCount }, activityDays: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

async function scanRole(vaultPath: string, bindings: KnowledgeFolderBindings, role: KnowledgePageDirectoryRole): Promise<DirectoryScan> {
  const binding = bindings.roles[role];
  const unit = ({ raw: "份", wiki: "篇", projects: "个", inbox: "条" } as const)[role];
  const roots: KnowledgePageDirectoryRoot[] = [], files = new Map<string, PageFile>(), counted = new Set<string>();
  if (!binding.enabled || !binding.readPaths.length) return {
    directory: { role, unit, state: binding.enabled ? "unbound" : "disabled", count: null, latestMtime: 0, roots }, files: []
  };
  let batch = 0;
  for (const savedRoot of new Set(binding.readPaths)) {
    const root: KnowledgePageDirectoryRoot = { path: savedRoot, state: "ready", count: null, latestMtime: 0 };
    roots.push(root);
    let rootPath: string;
    try {
      rootPath = normalizeKnowledgeDirectory(savedRoot);
      if (!(await knowledgePagePathStat(vaultPath, rootPath)).isDirectory()) { root.state = "invalid"; root.error = "位置已失效"; continue; }
    } catch (error) {
      root.state = (error as NodeJS.ErrnoException).code === "ENOENT" || message(error).includes("合法") ? "invalid" : "unavailable";
      root.error = root.state === "invalid" ? "位置已失效" : message(error); continue;
    }
    root.count = 0;
    const pending = [rootPath];
    while (pending.length) {
      const current = pending.pop()!;
      try {
        const entries = await fsp.readdir(path.join(vaultPath, current), { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const relative = `${current}/${entry.name}`;
          if (entry.isSymbolicLink()) { root.state = "partial"; root.error = "部分位置包含符号链接，尚未读取"; continue; }
          if (entry.isDirectory()) {
            pending.push(relative);
            if (role === "projects" && current === rootPath) { root.count++; counted.add(relative); }
          } else if (entry.isFile() && (role === "projects" || classifyKnowledgePath(bindings, relative) === role)
            && (role === "projects" || (role === "raw" ? RAW_EXTENSIONS.has(path.extname(relative).toLowerCase()) : markdown(relative)))) {
            try {
              const stat = await fsp.lstat(path.join(vaultPath, relative));
              if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("文件位置已变化");
              root.latestMtime = Math.max(root.latestMtime, stat.mtimeMs);
              files.set(relative, { path: relative, mtime: stat.mtimeMs, birthtime: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null });
              if (role !== "projects") { root.count++; counted.add(relative); }
            } catch (error) { root.state = "partial"; root.error = message(error); }
          }
          if (++batch % 100 === 0) await yieldFrame();
        }
      } catch (error) { root.state = "partial"; root.error = message(error); }
    }
  }
  const readable = roots.some(root => root.count !== null), complete = roots.every(root => root.state === "ready");
  return { directory: { role, unit, roots, state: complete ? "ready" : readable ? "partial" : roots.some(root => root.state === "unavailable") ? "unavailable" : "invalid",
    count: readable ? counted.size : null, latestMtime: Math.max(0, ...roots.map(root => root.latestMtime)) }, files: [...files.values()] };
}

/** No model, write, timer subscription, index rebuild or synthetic fallback is involved. */
export async function loadKnowledgePageData(host: KnowledgePageHost, loadLinks: (bindings: KnowledgeFolderBindings) => Promise<KnowledgeLinkHealth>, now = Date.now()): Promise<KnowledgePageSnapshot> {
  const bindings = structuredClone(host.settingsKnowledgeBindings?.() ?? host.settings.knowledgeBase?.folderBindings ?? emptyKnowledgeFolderBindings());
  const errors: KnowledgePageSnapshot["errors"] = {};
  let service: ReturnType<KnowledgePageHost["getKnowledgeSurfaceService"]> = null;
  try { service = host.getKnowledgeSurfaceService(); } catch (error) { errors.health = message(error); errors.history = message(error); }
  const [dashboardResult, recordsResult, linksResult] = await Promise.allSettled([
    Promise.resolve().then(() => { if (!service) throw new Error("知识库状态暂时读不到"); return service.getDashboardSnapshot(); }),
    Promise.resolve().then(() => { if (!service?.getMaintenanceRecords) throw new Error("维护记录暂时读不到"); return service.getMaintenanceRecords(); }),
    Promise.resolve().then(() => loadLinks(bindings))
  ]);
  const dashboard = dashboardResult.status === "fulfilled" ? dashboardResult.value : null;
  if (dashboardResult.status === "rejected") errors.health = message(dashboardResult.reason);
  const maintenanceRecords = recordsResult.status === "fulfilled" ? recordsResult.value : [];
  if (recordsResult.status === "rejected") errors.history = message(recordsResult.reason);
  const maintenanceHistory = mergeKnowledgeMaintenanceHistory(host.settings.knowledgeBase?.maintenanceHistory ?? [], maintenanceRecords);
  const links: KnowledgeLinkHealth = linksResult.status === "fulfilled" ? linksResult.value : { state: "unknown", candidatePaths: [], isolatedPaths: [], reason: message(linksResult.reason) };
  if (linksResult.status === "rejected") errors.links = message(linksResult.reason);
  let vaultPath = "";
  try {
    const adapter = host.app.vault.adapter as typeof host.app.vault.adapter & { getBasePath?(): string };
    vaultPath = adapter.getBasePath?.() ?? "";
  } catch (error) { errors.directories = message(error); }
  const scans: DirectoryScan[] = [];
  for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
    if (vaultPath) scans.push(await scanRole(vaultPath, bindings, role));
    else scans.push({ directory: { role, state: "unavailable", count: null, latestMtime: 0, roots: [], unit: ({ raw: "份", wiki: "篇", projects: "个", inbox: "条" } as const)[role] }, files: [] });
  }
  const wiki = scans.find(scan => scan.directory.role === "wiki")!;
  const activity = aggregateKnowledgePageActivity(wiki.files, maintenanceHistory, now);
  if (wiki.directory.state !== "ready") {
    activity.weekly.added = null;
    errors.activity = wiki.directory.state === "disabled" || wiki.directory.state === "unbound" ? "尚未设置知识成果位置" : "知识成果统计尚未更新";
  }
  if (errors.history) {
    activity.weekly.organized = null;
    errors.activity = [errors.activity, "维护活动记录尚未更新"].filter(Boolean).join("；");
  }
  if (scans.some(scan => ["partial", "unavailable"].includes(scan.directory.state))) errors.directories ??= "部分目录尚未读完，请重试";
  let sources: KnowledgeSourceHealth = { state: "unknown", missing: [], unknownCount: wiki.files.length, checkedCount: 0 };
  try { if (vaultPath) sources = await loadKnowledgeSourceHealth(vaultPath, bindings, wiki.files.map(file => file.path)); }
  catch (error) { errors.sources = message(error); }
  if (wiki.directory.state === "partial" || wiki.directory.state === "unavailable") { sources.state = "partial"; errors.sources = "部分知识成果尚未读取"; }
  return { generatedAt: now, bindings, dashboard, health: dashboard?.health ?? null, ...activity, directories: scans.map(scan => scan.directory), links, sources, maintenanceHistory, maintenanceRecords, errors };
}
