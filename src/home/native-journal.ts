import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { resolveKnowledgePathFromRoots, rebaseKnowledgePath } from "../knowledge-base/root-paths-core";
import { TFolder, TFile, type App } from "obsidian";
import { normalizeJournalDirectory, normalizedJournalDirectoryOrNull } from "./journal-directory";
import { journalMoment } from "./journal-moment";

import { DEFAULT_JOURNAL_DATE_FORMAT, NATIVE_JOURNAL_DATE_FORMAT, journalFormatError, journalPathForFormat, parseJournalDate, preferredJournalPath } from "./journal-format";
export { DEFAULT_JOURNAL_DATE_FORMAT } from "./journal-format";
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

const savedNativeOptions = new WeakMap<App, Map<string, Record<string, unknown>>>();
export async function loadNativeJournalSettings(app: App): Promise<void> {
  const values = new Map<string, Record<string, unknown>>();
  for (const id of ["daily-notes", "templates"]) {
    const record = corePlugin(app, id), storage = record?.instance?.plugin ?? record;
    const data = await storage?.loadData?.();
    values.set(id, data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {});
  }
  savedNativeOptions.set(app, values);
}
function optionsOf(app: App, id: string): Record<string, unknown> {
  const record = corePlugin(app, id), saved = savedNativeOptions.get(app)?.get(id) ?? {};
  return record?.enabled === false ? saved : { ...saved, ...record?.instance?.options };
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
    const record = corePlugin(app, id), instance = record?.instance;
    const storage = instance?.plugin ?? record;
    const data = await storage?.loadData?.();
    const saved = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    // A disabled core plugin has not necessarily loaded its options this run.
    // Its saved choices remain authoritative; an enabled plugin can have newer
    // live choices, while unknown saved options must survive either way.
    const options = record?.enabled === false ? saved : { ...saved, ...instance?.options };
    const next = { ...options };
    let changed = false;
    for (const key of keys) if (typeof options[key] === "string") {
      const rebased = rebaseKnowledgePath(options[key], from, to);
      if (rebased !== options[key]) { next[key] = rebased; changed = true; }
    }
    if (changed) {
      if (!storage?.saveData) throw new Error(`Obsidian 原生插件 ${id} 设置不可用。`);
      await storage.saveData(next);
      if (instance) {
        instance.options = next;
        await instance.onExternalSettingsChange?.();
      }
    }
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
  const selectedTemplate = nonempty(daily.template);
  const template = selectedTemplate ? bindings ? selectedTemplate : actualJournalPath(selectedTemplate, roots) : "";
  return Object.freeze({
    available, templatesAvailable: nativeTemplates !== undefined || !bindings || Boolean(mappedTemplates && app.vault.getAbstractFileByPath(mappedTemplates) instanceof TFolder),
    folder,
    format: nonempty(daily.format) ?? NATIVE_JOURNAL_DATE_FORMAT,
    formatHistory: Array.isArray(daily.echoInkJournalFormats) ? daily.echoInkJournalFormats.filter((v): v is string => typeof v === "string") : [],
    template: !template ? "" : /\.md$/iu.test(template) ? template : `${template}.md`,
    templatesFolder,
    templateDateFormat: nonempty(templates.dateFormat) ?? "YYYY-MM-DD",
    templateTimeFormat: nonempty(templates.timeFormat) ?? "HH:mm"
  });
}

export function nativeJournalPathForDate(app: App, date: Date, legacyDirectory?: string, bindings?: KnowledgeFolderBindings | null): string {
  const settings = readNativeJournalSettings(app, legacyDirectory, bindings);
  // Resolving a candidate path is read-only. Creation checks the actual folder.
  return journalPathForFormat(date, settings.folder, settings.format);
}

/** An empty native folder is the Vault root; protect matching notes, not the whole Vault. */
export function nativeRootJournalPaths(app: App, paths: readonly string[]): string[] {
  const daily = optionsOf(app, "daily-notes");
  if (typeof daily.folder !== "string" || daily.folder.trim() !== "") return [];
  const format = nonempty(daily.format) ?? NATIVE_JOURNAL_DATE_FORMAT;
  const history = Array.isArray(daily.echoInkJournalFormats) ? daily.echoInkJournalFormats.filter((v): v is string => typeof v === "string") : [];
  return paths.filter(path => parseJournalDate(path, "", format, history));
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
    journalMoment(date).format(format ?? (kind.toLowerCase() === "date" ? formats.templateDateFormat : formats.templateTimeFormat))
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
  const templateSource = source ?? (settings.template ? QUICK_JOURNAL_TEMPLATE : "");
  const title = targetPath.slice(targetPath.lastIndexOf("/") + 1, -3);
  const templateContent = renderNativeJournalTemplate(templateSource, now, title, settings);
  if (!target) prepareNativeJournalTemplate(app, targetPath, templateContent);
  return Object.freeze({
    ...settings,
    date: journalMoment(now).format("YYYY-MM-DD"),
    time: journalMoment(now).format("HH:mm"),
    targetPath,
    exists: target instanceof TFile,
    templateExists: source !== null,
    templateContent
  });
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (!folder) return;
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
  if (!storage?.loadData || !storage.saveData) {
    throw new Error(`Obsidian 原生插件 ${id} 设置不可用。`);
  }
  const data = await storage.loadData();
  const saved = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const next = { ...saved, ...(record?.enabled === false ? {} : instance?.options) };
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (onlyMissing && Object.hasOwn(next, key)) continue;
    if (next[key] !== value) { next[key] = value; changed = true; }
  }
  if (!changed) return;
  await storage.saveData(next);
  savedNativeOptions.get(app)?.set(id, next);
  if (instance) { instance.options = next; await instance.onExternalSettingsChange?.(); }
  const detail = app.vault as unknown as { trigger?(event: string): void };
  detail.trigger?.("echoink-journal-settings");
}

/** Called only by the user's initialize/restore operation, never at startup. */
export async function initializeNativeJournal(app: App, legacyDirectory?: string): Promise<void> {
  await loadNativeJournalSettings(app);
  const existing = optionsOf(app, "daily-notes");
  const hadConfiguration = Object.keys(savedNativeOptions.get(app)?.get("daily-notes") ?? {}).length > 0 || Boolean(nonempty(existing.folder) || nonempty(existing.format));
  const plugins = corePlugins(app);
  if (!plugins?.saveConfig) throw new Error("Obsidian 原生日记与模板插件不可用。");
  let enabled = false;
  for (const id of ["daily-notes", "templates"]) {
    const record = corePlugin(app, id);
    if (!record?.enable) throw new Error(`Obsidian 原生插件 ${id} 不可用。`);
    if (!record.enabled) { await record.enable(true); enabled = true; }
  }
  if (enabled) await plugins.saveConfig();
  const resolved = readNativeJournalSettings(app, legacyDirectory);
  const templateConfigured = Object.keys(savedNativeOptions.get(app)?.get("templates") ?? {}).length > 0;
  const roots = (app.vault.getRoot?.()?.children ?? app.vault.getAllLoadedFiles?.() ?? []).map(file => file.path.split("/")[0]);
  const before = { ...resolved,
    folder: hadConfiguration ? resolved.folder : actualJournalPath(normalizeJournalDirectory(legacyDirectory), roots),
    templatesFolder: templateConfigured ? resolved.templatesFolder : actualJournalPath(DEFAULT_TEMPLATES_DIRECTORY, roots) };
  await ensureFolder(app, before.folder);
  await ensureFolder(app, before.templatesFolder);
  const quickTemplatePath = `${before.templatesFolder ? `${before.templatesFolder}/` : ""}此刻速记.md`;
  const template = app.vault.getAbstractFileByPath(quickTemplatePath);
  if (template && !(template instanceof TFile)) throw new Error("此刻速记模板路径已被文件夹占用。");
  if (!template) await app.vault.create(quickTemplatePath, QUICK_JOURNAL_TEMPLATE);
  await updateCoreOptions(app, "templates", { folder: before.templatesFolder, dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" }, templateConfigured);
  await updateCoreOptions(app, "daily-notes", {
    folder: before.folder,
    format: hadConfiguration ? before.format : DEFAULT_JOURNAL_DATE_FORMAT,
    template: quickTemplatePath
  }, hadConfiguration);
  await ensureFolder(app, nativeJournalPathForDate(app, new Date(), legacyDirectory).split("/").slice(0, -1).join("/"));
}

export async function saveNativeJournalFolder(app: App, folder: string): Promise<void> {
  if (folder.trim()) await ensureFolder(app, folder);
  await updateCoreOptions(app, "daily-notes", { folder: folder.trim() === "" ? "" : relativePath(folder) }, false);
}

/** One native setting, shared by EchoInk and Daily notes. History is read-only compatibility metadata. */
export async function saveNativeJournalFormat(app: App, value: string): Promise<void> {
  const error = journalFormatError(value);
  if (error) throw new Error(`journal_format_${error}`);
  const before = readNativeJournalSettings(app);
  assertJournalTargetAvailable(app, nativeJournalTargetForFormat(before.folder, value.trim()));
  await updateCoreOptions(app, "daily-notes", { format: value.trim(), echoInkJournalFormats: [...new Set([...before.formatHistory, before.format, value.trim()])] }, false);
}
function nativeJournalTargetForFormat(folder: string, format: string): string { return journalPathForFormat(new Date(), folder, format); }
export function assertJournalTargetAvailable(app: App, path: string): void {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) if (app.vault.getAbstractFileByPath(parts.slice(0, i).join("/")) instanceof TFile) throw new Error("journal_parent_occupied");
  if (app.vault.getAbstractFileByPath(path) instanceof TFolder) throw new Error("journal_target_occupied");
}
export async function saveNativeJournalTemplate(app: App, path: string): Promise<void> {
  if (path === "__quick") {
    const settings = readNativeJournalSettings(app);
    const folder = settings.templatesAvailable ? settings.templatesFolder : DEFAULT_TEMPLATES_DIRECTORY;
    await ensureFolder(app, folder);
    path = `${folder ? `${folder}/` : ""}此刻速记.md`;
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof TFile)) throw new Error("journal_template_missing");
    if (!existing) await app.vault.create(path, QUICK_JOURNAL_TEMPLATE);
  } else if (path && !(app.vault.getAbstractFileByPath(relativePath(path)) instanceof TFile)) throw new Error("journal_template_missing");
  await updateCoreOptions(app, "daily-notes", { template: path }, false);
}
export function existingNativeJournalPath(app: App, date: Date, legacyDirectory?: string, bindings?: KnowledgeFolderBindings | null): string | null {
  const settings = readNativeJournalSettings(app, legacyDirectory, bindings);
  return preferredJournalPath(app.vault.getMarkdownFiles().map(file => file.path), date, settings.folder, settings.format, settings.formatHistory);
}
