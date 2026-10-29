import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { resolveKnowledgePathFromRoots, rebaseKnowledgePath } from "../knowledge-base/root-paths-core";
import { moment, TFolder, TFile, type App } from "obsidian";
import { normalizeJournalDirectory, normalizedJournalDirectoryOrNull } from "./journal-directory";

export const DEFAULT_JOURNAL_DATE_FORMAT = "YYYY-MM/YYYY-MM-DD";
export const DEFAULT_TEMPLATES_DIRECTORY = "templates";
export const DEFAULT_QUICK_JOURNAL_TEMPLATE_PATH = "templates/此刻速记.md";
export const QUICK_JOURNAL_TEMPLATE = [
  "---",
  'date: "{{date:YYYY-MM-DD}}"',
  "template: 此刻速记",
  "tags:",
  "  - journal",
  "---", "",
  "# {{date:YYYY-MM-DD}} 此刻速记", "",
  "## 现在发生了什么", "", "",
  "## 想记住的一点", "", ""
].join("\n");

const preparedJournalTemplates = new WeakMap<App, Map<string, string>>();
export function prepareNativeJournalTemplate(app: App, targetPath: string, content: string): void {
  const pending = preparedJournalTemplates.get(app) ?? new Map<string, string>();
  pending.set(targetPath, content);
  preparedJournalTemplates.set(app, pending);
}
/** A prepared context is only a candidate; callers must observe and read back an actual creation. */
export function takePreparedNativeJournalTemplate(app: App, targetPath: string): string | undefined {
  const pending = preparedJournalTemplates.get(app), content = pending?.get(targetPath);
  pending?.delete(targetPath);
  return content;
}

interface NativeCoreInstance {
  options?: Record<string, unknown>;
  plugin?: NativeCorePlugin;
  onExternalSettingsChange?(): Promise<void>;
}
interface NativeCorePlugin {
  enabled?: boolean;
  enable?(userInitiated?: boolean): Promise<void>;
  instance?: NativeCoreInstance;
  loadData?(): Promise<unknown>;
  saveData?(options: Record<string, unknown>): Promise<void>;
}
interface NativeCorePlugins {
  plugins?: Record<string, NativeCorePlugin>;
  getPluginById?(id: string): NativeCorePlugin | undefined;
  saveConfig?(): Promise<void> | void;
}

function corePlugins(app: App): NativeCorePlugins | undefined {
  return (app as unknown as { internalPlugins?: NativeCorePlugins }).internalPlugins;
}

function corePlugin(app: App, id: string): NativeCorePlugin | undefined {
  const plugins = corePlugins(app);
  return plugins?.getPluginById?.(id) ?? plugins?.plugins?.[id];
}

function optionsOf(app: App, id: string): Record<string, unknown> {
  return corePlugin(app, id)?.instance?.options ?? {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function relativePath(value: string): string {
  const normalized = normalizedJournalDirectoryOrNull(value);
  if (!normalized || normalized.split("/").some((part) => part.startsWith(".") || /[\0\r\n]/u.test(part))) {
    throw new Error("Obsidian 日记或模板设置包含无效的 Vault 相对路径。");
  }
  return normalized;
}

function actualJournalPath(value: string, roots: readonly string[]): string {
  return resolveKnowledgePathFromRoots(relativePath(value), roots);
}

export async function rebaseNativeJournalPaths(app: App, from: string, to: string): Promise<void> {
  for (const [id, keys] of [["daily-notes", ["folder", "template"]], ["templates", ["folder"]]] as const) {
    const options = optionsOf(app, id);
    const patch: Record<string, unknown> = {};
    for (const key of keys) if (typeof options[key] === "string") {
      const next = rebaseKnowledgePath(options[key], from, to);
      if (next !== options[key]) patch[key] = next;
    }
    if (Object.keys(patch).length) await updateCoreOptions(app, id, patch, false);
  }
  const vault = app.vault as unknown as { getConfig?(key: string): unknown; setConfig?(key: string, value: string): void };
  const attachments = vault.getConfig?.("attachmentFolderPath");
  if (typeof attachments === "string") {
    const next = rebaseKnowledgePath(attachments, from, to);
    if (next !== attachments) vault.setConfig?.("attachmentFolderPath", next);
  }
}

export function readNativeJournalSettings(app: App, legacyDirectory?: string, bindings?: KnowledgeFolderBindings | null) {
  const daily = optionsOf(app, "daily-notes");
  const templates = optionsOf(app, "templates");
  // Resolve against one current root snapshot, without walking every descendant.
  const entries = app.vault.getRoot?.()?.children ?? app.vault.getAllLoadedFiles?.() ?? [];
  const roots = [...new Set(entries.map((file) => file.path.split("/")[0]).filter(Boolean))];
  const nativeFolder = typeof daily.folder === "string" ? daily.folder : undefined;
  const nativeTemplates = typeof templates.folder === "string" ? templates.folder : undefined;
  const mapped = (role: "journal" | "templates") => bindings?.roles[role].enabled ? bindings.roles[role].writePath : null;
  // An empty native folder explicitly means the Vault root. A fallback is
  // only a candidate location until its folder actually exists.
  const folder = nativeFolder !== undefined
    ? nativeFolder === "" || bindings ? nativeFolder : actualJournalPath(nativeFolder, roots)
    : mapped("journal") ?? actualJournalPath(normalizeJournalDirectory(legacyDirectory), roots);
  const mappedTemplates = mapped("templates");
  const available = folder === "" ? nativeFolder !== undefined : app.vault.getAbstractFileByPath(folder) instanceof TFolder;
  const templatesFolder = nativeTemplates ?? (bindings ? mapped("templates") ?? "" : actualJournalPath(DEFAULT_TEMPLATES_DIRECTORY, roots));
  const template = bindings ? nonempty(daily.template) ?? "" : actualJournalPath(nonempty(daily.template) ?? `${templatesFolder}/此刻速记.md`, roots);
  return Object.freeze({
    available, templatesAvailable: nativeTemplates !== undefined || !bindings || Boolean(mappedTemplates && app.vault.getAbstractFileByPath(mappedTemplates) instanceof TFolder),
    folder,
    format: nonempty(daily.format) ?? DEFAULT_JOURNAL_DATE_FORMAT,
    template: !template ? "" : /\.md$/iu.test(template) ? template : `${template}.md`,
    templatesFolder,
    templateDateFormat: nonempty(templates.dateFormat) ?? "YYYY-MM-DD",
    templateTimeFormat: nonempty(templates.timeFormat) ?? "HH:mm"
  });
}

export function nativeJournalPathForDate(app: App, date: Date, legacyDirectory?: string, bindings?: KnowledgeFolderBindings | null): string {
  const settings = readNativeJournalSettings(app, legacyDirectory, bindings);
  // Resolving a candidate path is read-only. Creation checks the actual folder.
  return relativePath(`${settings.folder ? `${settings.folder}/` : ""}${moment(date).format(settings.format)}.md`);
}

/** An empty native folder is the Vault root; protect matching notes, not the whole Vault. */
export function nativeRootJournalPaths(app: App, paths: readonly string[]): string[] {
  const daily = optionsOf(app, "daily-notes");
  if (typeof daily.folder !== "string" || daily.folder.trim() !== "") return [];
  // Obsidian's own fallback differs from EchoInk's recommended month layout.
  const format = nonempty(daily.format) ?? "YYYY-MM-DD";
  return paths.filter(relative => {
    if (!relative.endsWith(".md")) return false;
    const title = relative.slice(0, -3);
    const date = moment(title, format, true);
    return date.isValid() && date.format(format) === title;
  });
}

/** Native template tokens also serve direct creation and Agent saves. */
export function renderNativeJournalTemplate(
  source: string,
  date: Date,
  title: string,
  formats: { templateDateFormat: string; templateTimeFormat: string } = {
    templateDateFormat: "YYYY-MM-DD", templateTimeFormat: "HH:mm"
  }
): string {
  return source.replace(/\{\{(date|time)(?::([^}]+))?\}\}/giu, (_match, kind: string, format?: string) =>
    moment(date).format(format ?? (kind.toLowerCase() === "date" ? formats.templateDateFormat : formats.templateTimeFormat))
  ).replace(/\{\{title\}\}/giu, title);
}

export async function readNativeJournalContext(
  app: App,
  options: { now?: Date; legacyDirectory?: string; bindings?: KnowledgeFolderBindings | null; readTemplate?: (path: string) => Promise<string | null> } = {}
) {
  const now = options.now ?? new Date();
  const settings = readNativeJournalSettings(app, options.legacyDirectory, options.bindings);
  const targetPath = nativeJournalPathForDate(app, now, options.legacyDirectory, options.bindings);
  const target = app.vault.getAbstractFileByPath(targetPath);
  if (target && !(target instanceof TFile)) throw new Error("当天日记路径已被文件夹占用。");
  const templateFile = app.vault.getAbstractFileByPath(settings.template);
  const source = options.readTemplate
    ? await options.readTemplate(settings.template)
    : templateFile instanceof TFile ? await app.vault.read(templateFile) : null;
  if (source === null && settings.template && settings.template !== `${settings.templatesFolder}/此刻速记.md`) {
    throw new Error("Obsidian 配置的日记模板不存在，请在原生日记设置中修正模板。");
  }
  const templateSource = source ?? QUICK_JOURNAL_TEMPLATE;
  const title = targetPath.slice(targetPath.lastIndexOf("/") + 1, -3);
  const templateContent = renderNativeJournalTemplate(templateSource, now, title, settings);
  if (!target) prepareNativeJournalTemplate(app, targetPath, templateContent);
  return Object.freeze({
    ...settings,
    date: moment(now).format("YYYY-MM-DD"),
    time: moment(now).format("HH:mm"),
    targetPath,
    exists: target instanceof TFile,
    templateExists: source !== null,
    templateContent
  });
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of relativePath(folder).split("/")) {
    current = current ? `${current}/${part}` : part;
    const entry = app.vault.getAbstractFileByPath(current);
    if (entry instanceof TFile) throw new Error(`文件占用了目录：${current}`);
    if (!entry) await app.vault.createFolder(current);
  }
}

async function updateCoreOptions(
  app: App, id: string, patch: Record<string, unknown>, onlyMissing: boolean
): Promise<void> {
  const record = corePlugin(app, id);
  const instance = record?.instance;
  const storage = instance?.plugin ?? record;
  if (!instance || !storage?.loadData || !storage.saveData) {
    throw new Error(`Obsidian 原生插件 ${id} 设置不可用。`);
  }
  const data = await storage.loadData();
  const saved = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const next = { ...saved, ...instance.options };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (onlyMissing && nonempty(next[key])) continue;
    if (next[key] !== value) { next[key] = value; changed = true; }
  }
  if (!changed) return;
  await storage.saveData(next);
  instance.options = next;
  await instance.onExternalSettingsChange?.();
}

/** Called only by the user's initialize/restore operation, never at startup. */
export async function initializeNativeJournal(app: App, legacyDirectory?: string): Promise<void> {
  const plugins = corePlugins(app);
  if (!plugins?.saveConfig) throw new Error("Obsidian 原生日记与模板插件不可用。");
  let enabled = false;
  for (const id of ["daily-notes", "templates"]) {
    const record = corePlugin(app, id);
    if (!record?.enable) throw new Error(`Obsidian 原生插件 ${id} 不可用。`);
    if (!record.enabled) { await record.enable(true); enabled = true; }
  }
  if (enabled) await plugins.saveConfig();
  const before = readNativeJournalSettings(app, legacyDirectory);
  await ensureFolder(app, before.folder);
  await ensureFolder(app, before.templatesFolder);
  const quickTemplatePath = `${before.templatesFolder}/此刻速记.md`;
  const template = app.vault.getAbstractFileByPath(quickTemplatePath);
  if (template && !(template instanceof TFile)) throw new Error("此刻速记模板路径已被文件夹占用。");
  if (!template) await app.vault.create(quickTemplatePath, QUICK_JOURNAL_TEMPLATE);
  await updateCoreOptions(app, "templates", { folder: before.templatesFolder, dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" }, true);
  await updateCoreOptions(app, "daily-notes", {
    folder: before.folder,
    format: DEFAULT_JOURNAL_DATE_FORMAT,
    template: quickTemplatePath
  }, true);
  await ensureFolder(app, nativeJournalPathForDate(app, new Date(), legacyDirectory).split("/").slice(0, -1).join("/"));
}

export async function saveNativeJournalFolder(app: App, folder: string): Promise<void> {
  if (folder.trim()) await ensureFolder(app, folder);
  await updateCoreOptions(app, "daily-notes", { folder: folder.trim() === "" ? "" : relativePath(folder) }, false);
}
