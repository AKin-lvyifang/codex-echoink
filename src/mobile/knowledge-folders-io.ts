import type { App, DataAdapter } from "obsidian";
import { emptyKnowledgeFolderBindings, normalizeKnowledgeDirectory, knowledgeFolderBindingsSignature } from "../knowledge-base/folder-bindings";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeModuleDirectories } from "../knowledge-base/folder-plan";
import { nativeRootJournalPaths, readNativeJournalSettings } from "../home/native-journal";
import { isEchoInkFinanceBase, isFinanceRootName, isLegacyFinancePath } from "../lifestyle/finance-paths";
import { sha256Hex } from "../utils/sha256";
import type { MobileServices } from "./services";
import { prepareKnowledgeModuleDirectories } from "../knowledge-base/module-directories";
import { resolveEnglishStoragePaths } from "../english-diary/storage-paths";

export interface FolderFile { path: string; size: number; mtime: number }
export interface FolderInventory { directories: string[]; files: FolderFile[] }
export const within = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);
export const parentPath = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export const digest = (value: unknown): string => sha256Hex(JSON.stringify(canonical(value)) ?? "undefined");
export const stopped = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Error("已停止，未继续目录操作。"); };
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function safePath(path: string): string {
  if (normalizeKnowledgeDirectory(path) !== path || path.split("/").some(segment => segment.toLowerCase() === "node_modules")) throw new Error("目录操作包含不安全路径。");
  return path;
}
export async function fileHash(adapter: DataAdapter, path: string): Promise<string> {
  const bytes = await adapter.readBinary(path);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function kind(adapter: DataAdapter, path: string): Promise<"folder" | "missing" | "other"> {
  const stat = await adapter.stat(path);
  return !stat ? "missing" : stat.type === "folder" ? "folder" : "other";
}
/** No recovery, mkdir, normalization save or file-body reads occur in an inventory read. */
export async function inventory(services: MobileServices): Promise<FolderInventory> {
  const { adapter, configDir } = services.app.vault;
  const privateRoot = services.directory.replace(/\/mobile$/u, "");
  const result: FolderInventory = { directories: [], files: [] };
  const skip = (path: string): boolean => within(path, configDir) || within(path, privateRoot)
    || path.split("/").some(segment => segment.startsWith(".") || segment.toLowerCase() === "node_modules");
  const visit = async (path: string): Promise<void> => {
    const listed = await adapter.list(path);
    for (const directory of [...listed.folders].sort()) {
      if (skip(directory)) continue;
      safePath(directory);
      if (await kind(adapter, directory) !== "folder") throw new Error(`目录正在变化，请重新读取：${directory}`);
      result.directories.push(directory); await visit(directory);
    }
    for (const file of [...listed.files].sort()) {
      if (skip(file)) continue;
      safePath(file);
      const stat = await adapter.stat(file);
      if (!stat || stat.type !== "file") throw new Error(`文件正在变化，请重新读取：${file}`);
      result.files.push({ path: file, size: stat.size, mtime: stat.mtime ?? 0 });
    }
  };
  await visit("");
  result.directories.sort(); result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
export function nativeJournalFolder(services: MobileServices): string | undefined {
  const internal = object((services.app as unknown as { internalPlugins?: unknown }).internalPlugins), plugins = object(internal.plugins);
  const folder = object(object(object(plugins["daily-notes"]).instance).options).folder;
  return typeof folder === "string" ? folder : undefined;
}
interface NativeStorage { loadData?(): Promise<unknown>; saveData?(value: Record<string, unknown>): Promise<void> }
interface NativeEntry extends NativeStorage {
  instance?: { options?: Record<string, unknown>; plugin?: NativeStorage; onExternalSettingsChange?(): Promise<void> };
}
/** Same native option save semantics, with the live guard at its actual save boundary. */
export async function saveJournalFolder(services: MobileServices, folder: string | undefined, expected: string | undefined, guard: () => void): Promise<void> {
  const plugins = (services.app as unknown as { internalPlugins?: { plugins?: Record<string, NativeEntry> } }).internalPlugins?.plugins;
  const entry = plugins?.["daily-notes"], instance = entry?.instance, storage = instance?.plugin ?? entry;
  if (!instance || !storage?.loadData || !storage.saveData) throw new Error("Obsidian 原生日记设置暂时不可用，未保存位置。");
  const saved = object(await storage.loadData());
  if (typeof saved.folder === "string" && saved.folder !== expected || instance.options?.folder !== expected) throw new Error("原生日记设置已变化，保留现状。");
  const next = { ...saved, ...instance.options, folder };
  guard(); await storage.saveData(next); instance.options = next;
  await instance.onExternalSettingsChange?.();
  if (object(await storage.loadData()).folder !== folder) throw new Error("原生日记位置保存回读未确认。");
}
export async function assertSavedBindings(services: MobileServices, bindings: KnowledgeFolderBindings | null): Promise<void> {
  const path = `${services.directory.replace(/\/mobile$/u, "")}/data.json`, adapter = services.app.vault.adapter;
  if (!await adapter.exists(path)) throw new Error("目录设置保存结果未确认，请重新读取。");
  const saved = object(object(JSON.parse(await adapter.read(path)) as unknown).knowledgeBase).folderBindings;
  const actual = saved === null || saved === undefined ? null : object(saved) as unknown as KnowledgeFolderBindings;
  if ((actual?.revision ?? 0) !== (bindings?.revision ?? 0) || knowledgeFolderBindingsSignature(actual) !== knowledgeFolderBindingsSignature(bindings)) throw new Error("目录设置保存回读不一致，请重新读取。");
}
export function moduleDirectories(services: MobileServices): KnowledgeModuleDirectories {
  const settings = services.settings;
  return prepareKnowledgeModuleDirectories(settings, settings.knowledgeBase.folderBindings,
    (services.app.vault.getRoot?.().children ?? []).map(file => file.path), {
      journal: nativeJournalFolder(services) ?? (settings.knowledgeBase.folderBindings ? readNativeJournalSettings(services.app, settings.journalDirectory, settings.knowledgeBase.folderBindings).folder : settings.journalDirectory)
    }).directories;
}
export async function settingsToken(services: MobileServices): Promise<string> {
  const settings = services.settings, adapter = services.app.vault.adapter;
  const pluginRoot = services.directory.replace(/\/mobile$/u, "");
  const native = ["daily-notes", "templates"].map(id => `${services.app.vault.configDir}/${id}.json`);
  const persisted = await Promise.all([`${pluginRoot}/data.json`, ...native].map(async path => await adapter.exists(path) ? await adapter.read(path) : null));
  const internal: unknown = (services.app as unknown as { internalPlugins?: unknown }).internalPlugins;
  const plugins = object(object(internal).plugins);
  return digest({ bindings: settings.knowledgeBase.folderBindings, journal: settings.journalDirectory,
    review: settings.review, english: settings.englishDiary, pdf: settings.pdfReading, finance: settings.lifestyle.finance,
    permission: settings.defaultPermission, modules: settings.mobileUi.moduleEnabled,
    native: ["daily-notes", "templates"].map(id => object(object(plugins[id]).instance).options ?? null), persisted });
}
export async function readBaseline(services: MobileServices) {
  const before = await settingsToken(services), files = await inventory(services), after = await settingsToken(services);
  if (before !== after) throw new Error("设置正在变化，请重新读取。");
  return { inventory: files, settings: before, token: digest({ settings: before, inventory: files,
    revision: services.settings.knowledgeBase.folderBindings?.revision ?? 0, bindings: knowledgeFolderBindingsSignature(services.settings.knowledgeBase.folderBindings) }) };
}
export async function protectedPaths(services: MobileServices, files: FolderInventory, modules?: KnowledgeModuleDirectories): Promise<string[]> {
  const settings = services.settings, native = readNativeJournalSettings(services.app, settings.journalDirectory, settings.knowledgeBase.folderBindings ?? emptyKnowledgeFolderBindings());
  const paths = new Set([services.app.vault.configDir, services.directory.replace(/\/mobile$/u, ""), services.getTodoStore().sourcePath,
    "EchoInk/待办-settings-backup.json", "EchoInk/财务", settings.lifestyle.finance.analysisDirectory, native.template]);
  if (services.lifestyle) paths.add(services.lifestyle.finance.ledger.paths().root);
  const values = (input: unknown): string[] => Object.values(object(input)).filter((value): value is string => typeof value === "string");
  const english = resolveEnglishStoragePaths(settings.englishDiary, settings.knowledgeBase.folderBindings, (services.app.vault.getRoot?.().children ?? []).map(file => file.path));
  // Protection is independent of enablement and includes stored and role-resolved paths.
  for (const path of [native.folder, settings.journalDirectory, settings.review.outputDir, settings.englishDiary.englishDirectory,
    settings.englishDiary.expressionDirectory, english.englishDirectory, english.expressionDirectory, object(settings.pdfReading).originalDirectory,
    ...(settings.knowledgeBase.folderBindings?.roles.outputs.readPaths ?? []).flatMap(root => [`${root}/英文日记`, `${root}/英文日记/表达库`]),
    ...values(modules), native.templatesFolder,
    ...(settings.englishDiary.legacyEnglishDirectories ?? []), ...(settings.englishDiary.legacyExpressionDirectories ?? [])]) if (typeof path === "string" && path) paths.add(path);
  for (const file of files.files) {
    if (isFinanceRootName(file.path.split("/")[0]) || isLegacyFinancePath(file.path)) paths.add(file.path.split("/")[0] === "EchoInk" ? "EchoInk/财务" : file.path.split("/")[0]);
    if (file.path.endsWith("/ledger.base") && isEchoInkFinanceBase(await services.app.vault.adapter.read(file.path))) paths.add(parentPath(file.path));
  }
  nativeRootJournalPaths(services.app, files.files.map(file => file.path)).forEach(path => paths.add(path));
  if (modules?.journal === "") {
    const internal = object((services.app as unknown as { internalPlugins?: unknown }).internalPlugins), plugins = object(internal.plugins);
    const daily = object(object(plugins["daily-notes"]).instance);
    const app = { internalPlugins: { plugins: { "daily-notes": { instance: { options: { ...object(daily.options), folder: "" } } } } } } as unknown as App;
    nativeRootJournalPaths(app, files.files.map(file => file.path)).forEach(path => paths.add(path));
  }
  return [...paths].filter((path): path is string => typeof path === "string" && Boolean(path));
}
