import { NEXT, errorText, failureText, rawErrorText, pickErrorCopy, type ErrorCopy } from "../core/error-copy";
import { loadKnowledgeMapData } from "./knowledge-map/data";
import { getDesktopFsPromises } from "../platform/desktop-filesystem";
import { getDesktopPath } from "../platform/desktop-paths";

import { classifyKnowledgePath, emptyKnowledgeFolderBindings, normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { knowledgePagePathStat } from "../knowledge-base/source-health";
import { mergeKnowledgeMaintenanceHistory } from "../knowledge-base/maintenance-history-core";
import {
  aggregateKnowledgePageActivity,
  type KnowledgePageDirectory,
  type KnowledgePageDirectoryRole,
  type KnowledgePageDirectoryRoot,
  type PageFile,
  type KnowledgePageHost,
  type KnowledgePageSnapshot as SharedKnowledgePageSnapshot,
} from "./knowledge-page-core";

const fsp = getDesktopFsPromises();
const path = getDesktopPath();
export * from "./knowledge-page-core";
export type KnowledgePageSnapshot = Omit<SharedKnowledgePageSnapshot, "dashboard" | "links" | "sources">;

interface DirectoryScan { directory: KnowledgePageDirectory; files: PageFile[]; }
const markdown = (file: string): boolean => /\.(?:md|markdown)$/iu.test(file);
const yieldFrame = (): Promise<void> => new Promise(resolve => window.setTimeout(resolve, 0));
const READ_FAILED: ErrorCopy = ["暂时无法读取。请稍后重试。", "Temporarily unavailable. Try again later."];
const HISTORY_READ_FAILED: ErrorCopy = ["暂时无法读取维护记录。", "Maintenance records are temporarily unavailable."];
const message = (error: unknown, language?: string): string => errorText(error, READ_FAILED, language);

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
      root.state = (error as NodeJS.ErrnoException).code === "ENOENT" || rawErrorText(error).includes("合法") ? "invalid" : "unavailable";
      root.error = root.state === "invalid" ? "位置已失效" : message(error); continue;
    }
    if (role !== "wiki" && role !== "inbox") continue;
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
          } else if (entry.isFile() && classifyKnowledgePath(bindings, relative) === role && markdown(relative)) {
            try {
              const stat = await fsp.lstat(path.join(vaultPath, relative));
              if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("文件位置已变化");
              root.latestMtime = Math.max(root.latestMtime, stat.mtimeMs);
              files.set(relative, { path: relative, mtime: stat.mtimeMs, birthtime: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : null });
              root.count++; counted.add(relative);
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
export async function loadKnowledgePageData(host: KnowledgePageHost, now = Date.now()): Promise<KnowledgePageSnapshot> {
  const bindings = structuredClone(host.settingsKnowledgeBindings?.() ?? host.settings.knowledgeBase?.folderBindings ?? emptyKnowledgeFolderBindings());
  const errors: KnowledgePageSnapshot["errors"] = {};
  const language = (host.settings as { settingsLanguage?: string }).settingsLanguage;
  let service: ReturnType<KnowledgePageHost["getKnowledgeSurfaceService"]> = null;
  try { service = host.getKnowledgeSurfaceService(); } catch (error) { errors.health = message(error, language); errors.history = message(error, language); errors.upgrade = message(error, language); }
  const [healthResult, recordsResult, upgradeResult, checkupResult] = await Promise.allSettled([
    Promise.resolve().then(() => { if (!service) throw new Error("暂时无法读取知识库状态。请稍后重试。"); return service.getHealthSnapshot(); }),
    Promise.resolve().then(() => { if (!service?.getMaintenanceRecords) throw new Error("暂时无法读取维护记录。请稍后重试。"); return service.getMaintenanceRecords(); }),
    Promise.resolve().then(() => service?.getUpgradeSnapshot?.() ?? null),
    Promise.resolve().then(async () => {
      if (!service?.checkup) return null;
      const [quick, deep] = await Promise.all([service.checkup.quick(), service.checkup.deep?.snapshot()]);
      return quick.issues.length + (deep?.findings.length ?? 0);
    })
  ]);
  const upgrade = upgradeResult.status === "fulfilled" ? upgradeResult.value : null;
  if (upgradeResult.status === "rejected") errors.upgrade = message(upgradeResult.reason, language);
  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  if (healthResult.status === "rejected") errors.health = message(healthResult.reason, language);
  const maintenanceRecords = recordsResult.status === "fulfilled" ? recordsResult.value : [];
  if (recordsResult.status === "rejected") errors.history = failureText(recordsResult.reason, HISTORY_READ_FAILED, NEXT.retryLater, language);
  const maintenanceHistory = mergeKnowledgeMaintenanceHistory(host.settings.knowledgeBase?.maintenanceHistory ?? [], maintenanceRecords);
  let vaultPath = "";
  try {
    const adapter = host.app.vault.adapter as typeof host.app.vault.adapter & { getBasePath?(): string };
    vaultPath = adapter.getBasePath?.() ?? "";
  } catch (error) { errors.directories = message(error, language); }
  const scans: DirectoryScan[] = [];
  for (const role of ["raw", "wiki", "projects", "inbox"] as const) {
    if (vaultPath) scans.push(await scanRole(vaultPath, bindings, role));
    else scans.push({ directory: { role, state: "unavailable", count: null, latestMtime: 0, roots: [], unit: ({ raw: "份", wiki: "篇", projects: "个", inbox: "条" } as const)[role] }, files: [] });
  }
  const wiki = scans.find(scan => scan.directory.role === "wiki")!;
  const activity = aggregateKnowledgePageActivity(wiki.files, maintenanceHistory, now);
  if (!["ready", "disabled", "unbound"].includes(wiki.directory.state)) {
    activity.weekly.added = null;
    errors.activity = pickErrorCopy(["知识成果统计尚未更新", "Knowledge statistics are not up to date"], language);
  }
  if (errors.history) {
    activity.weekly.organized = null;
    errors.activity = [errors.activity, pickErrorCopy(["维护活动记录尚未更新", "Maintenance activity is not up to date"], language)].filter(Boolean).join(language === "en" ? "; " : "；");
  }
  if (scans.some(scan => ["partial", "unavailable"].includes(scan.directory.state))) errors.directories ??= pickErrorCopy(["部分目录尚未读取完成。请重试。", "Some folders have not been read yet. Try again."], language);
  const map = await loadKnowledgeMapData(host.app, bindings).catch((error: unknown) => {
    errors.system = message(error, language);
    return { domains: [], reminders: [] };
  });
  return {
    mapDomains: map.domains,
    systemReminders: map.reminders,
    generatedAt: now,
    bindings,
    health,
    pendingCount: checkupResult.status === "fulfilled" ? checkupResult.value : null,
    ...activity,
    directories: scans.map(scan => scan.directory),
    maintenanceHistory,
    maintenanceRecords,
    upgrade,
    errors,
  };
}
