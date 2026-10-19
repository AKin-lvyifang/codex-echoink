import { classifyKnowledgePath, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { App, TFolder, TFile, normalizePath } from "obsidian";
import type { SettingsLanguage } from "../settings/settings";
import type { HomeActivityCore } from "./home-activity-core";
import { homeCopy } from "./home-i18n";
import { isHomeNotePath, type HomeNoteVisibility } from "./home-note-visibility";
import { nativeJournalPathForDate, prepareNativeJournalTemplate, readNativeJournalContext, readNativeJournalSettings } from "./native-journal";
import {
  DEFAULT_JOURNAL_DIRECTORY,
} from "./journal-directory";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  HOME_ENTRY_IDS,
  JOURNAL_TEMPLATE_DIRECTORY,
  applyJournalTemplate,
  buildHomeJournalDays,
  countRecordsInFolder,
  importedTemplatePath,
  isKnowledgeBaseReviewPath,
  journalDateFromPath,
  mostRecentRecordInFolder,
  nextAvailableImportedTemplatePath,
  parseImportedJournalTemplate,
  type HomeActivityDay,
  type HomeEntryId,
  type HomeJournalDay,
  type HomeVaultFileRecord,
  type ImportedJournalTemplate,
  type JournalTemplateDefinition
} from "./home-workbench-model";

const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

export interface HomeEntrySummary {
  id: HomeEntryId;
  label: string;
  description: string;
  count: number;
  targetPath?: string;
}

export interface HomeCustomTemplateSummary {
  id: string;
  name: string;
  path: string;
}

export interface HomeWorkbenchData {
  records: HomeVaultFileRecord[];
  activity: HomeActivityDay[];
  journalDays: HomeJournalDay[];
  entries: HomeEntrySummary[];
  customTemplates: HomeCustomTemplateSummary[];
}

export type HomeJournalTemplateChoice =
  | { kind: "built-in"; template: JournalTemplateDefinition }
  | { kind: "custom"; path: string; name: string };

export interface HomeJournalCreateResult {
  file: TFile;
  created: boolean;
}

export interface HomeTemplateSaveResult {
  status: "saved" | "conflict";
  path: string;
  file?: TFile;
  safeCopyPath?: string;
}

export class HomeWorkbenchDataService {
  constructor(
    private readonly app: App,
    private readonly journalDirectoryProvider: () => string = () => DEFAULT_JOURNAL_DIRECTORY,
    private readonly activityService?: HomeActivityCore | null,
    private readonly includeNotePath: HomeNoteVisibility = isHomeNotePath,
    private readonly bindings: () => KnowledgeFolderBindings | null | undefined = () => undefined
  ) {}

  getJournalDirectory(): string {
    return readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings()).folder;
  }

  journalPathForDate(date: Date): string {
    return nativeJournalPathForDate(this.app, date, this.journalDirectoryProvider(), this.bindings());
  }

  existingJournalForDate(date: Date): TFile | null {
    if (!readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings()).available) return null;
    const preferred = this.app.vault.getAbstractFileByPath(this.journalPathForDate(date));
    if (preferred instanceof TFile) return preferred;
    const settings = readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings());
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return this.app.vault.getMarkdownFiles().find((file) => journalDateFromPath(file.path, settings.folder, settings.format) === key) ?? null;
  }

  async ensureJournalDirectory(language: SettingsLanguage = "zh-CN"): Promise<string> {
    if (!readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings()).available) throw new Error("请先选择日记位置。");
    const directory = this.getJournalDirectory();
    await this.ensureFolder(directory, language);
    return directory;
  }

  async build(visibleMonth = new Date()): Promise<HomeWorkbenchData> {
    const journalSettings = readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings());
    const journalDirectory = journalSettings.folder;
    const files = this.app.vault.getMarkdownFiles();
    const records = files.filter((file) => this.includeNotePath(file.path)).map((file) =>
      this.recordForFile(file, journalDirectory, journalSettings.format)
    );
    const byDate = new Map<string, HomeActivityDay>();
    for (const event of this.activityService?.snapshot().events ?? []) {
      if (!this.includeNotePath(event.path)) continue;
      const day = byDate.get(event.date) ?? { date: event.date, count: 0, fileCount: 0, checkCount: 0, level: "low" as const };
      day.count++; day.fileCount++;
      byDate.set(event.date, day);
    }
    const activity = [...byDate.values()];
    const journalDays = buildHomeJournalDays(records, activity, visibleMonth, journalDirectory,
      journalSettings.format);
    const customTemplates = this.listCustomTemplates(files, journalSettings);
    return {
      records,
      activity,
      journalDays,
      entries: buildEntrySummaries(records, journalDirectory, this.bindings()),
      customTemplates
    };
  }

  async createBlankInboxNote(language: SettingsLanguage = "zh-CN"): Promise<TFile> {
    const binding = this.bindings()?.roles.inbox;
    if (binding && (!binding.enabled || !binding.writePath || !(this.app.vault.getAbstractFileByPath(binding.writePath) instanceof TFolder))) throw new Error("请先选择有效的收件箱位置。");
    const directory = binding?.writePath ?? "inbox";
    await this.ensureFolder(directory, language);
    for (let suffix = 0; ; suffix++) {
      const path = `${directory}/未命名${suffix ? ` ${suffix}` : ""}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      try { return await this.app.vault.create(path, ""); }
      catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
    }
  }

  async readTemplate(choice: HomeJournalTemplateChoice, language: SettingsLanguage = "zh-CN"): Promise<string> {
    if (choice.kind === "built-in") return choice.template.content;
    const file = this.app.vault.getAbstractFileByPath(normalizePath(choice.path));
    if (!(file instanceof TFile)) throw new Error(homeCopy(language).template.templateNotFound(choice.path));
    return await this.app.vault.read(file);
  }

  async createOrOpenJournal(
    choice: HomeJournalTemplateChoice,
    date = new Date(),
    language: SettingsLanguage = "zh-CN"
  ): Promise<HomeJournalCreateResult> {
    const path = normalizePath(this.journalPathForDate(date));
    const existing = this.existingJournalForDate(date) ?? this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return { file: existing, created: false };
    if (existing) throw new Error(homeCopy(language).template.pathOccupiedByFolder(path));
    const content = choice.kind === "built-in" && choice.template.id === "quick"
      ? (await readNativeJournalContext(this.app, { now: date, legacyDirectory: this.journalDirectoryProvider(), bindings: this.bindings() })).templateContent
      : applyJournalTemplate(await this.readTemplate(choice, language), date);
    const slash = path.lastIndexOf("/");
    if (slash > 0) await this.ensureFolder(path.slice(0, slash), language);
    try {
      prepareNativeJournalTemplate(this.app, path, content);
      const file = await this.app.vault.create(path, content);
      return { file, created: true };
    } catch (error) {
      const concurrent = this.app.vault.getAbstractFileByPath(path);
      if (concurrent instanceof TFile) return { file: concurrent, created: false };
      throw error;
    }
  }

  previewImportedTemplate(
    fileName: string,
    content: string,
    language: SettingsLanguage = "zh-CN"
  ): ImportedJournalTemplate {
    return parseImportedJournalTemplate(fileName, content, language);
  }

  listCustomTemplates(files: readonly TFile[] = this.app.vault.getMarkdownFiles(), native = readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings())): HomeCustomTemplateSummary[] {
    if (!native.templatesAvailable) return [];
    const prefix = this.bindings() ? `${native.templatesFolder}${native.templatesFolder ? "/" : ""}` : `${JOURNAL_TEMPLATE_DIRECTORY}/`;
    return files
      .filter((file) => file.path.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()))
      .sort((left, right) => left.basename.localeCompare(right.basename, "zh-Hans"))
      .map((file) => ({ id: `custom:${file.path}`, name: file.basename, path: file.path }));
  }

  async saveImportedTemplate(
    template: ImportedJournalTemplate,
    conflictResolution: "cancel" | "safe-copy" = "cancel",
    language: SettingsLanguage = "zh-CN"
  ): Promise<HomeTemplateSaveResult> {
    const native = readNativeJournalSettings(this.app, this.journalDirectoryProvider(), this.bindings());
    if (!native.templatesAvailable) throw new Error("请先选择模板位置。");
    const directory = this.bindings() ? native.templatesFolder : JOURNAL_TEMPLATE_DIRECTORY;
    const templatePath = (value: string) => this.bindings() ? value.replace(`${JOURNAL_TEMPLATE_DIRECTORY}/`, directory ? `${directory}/` : "") : value;
    const knownTemplatePaths = new Set(this.app.vault.getMarkdownFiles().map((file) => this.bindings() && file.path.startsWith(directory ? `${directory}/` : "") ? `${JOURNAL_TEMPLATE_DIRECTORY}/${file.path.slice(directory ? directory.length + 1 : 0)}` : file.path));
    const path = normalizePath(templatePath(importedTemplatePath(template.name)));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && conflictResolution === "cancel") {
      const paths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
      return {
        status: "conflict",
        path,
        safeCopyPath: templatePath(nextAvailableImportedTemplatePath(template.name, knownTemplatePaths, language))
      };
    }
    const targetPath = existing
      ? normalizePath(templatePath(nextAvailableImportedTemplatePath(
          template.name,
        knownTemplatePaths,
        language
      )))
      : path;
    if (directory) await this.ensureFolder(directory, language);
    const file = await this.app.vault.create(targetPath, template.content);
    return { status: "saved", path: targetPath, file };
  }

  private recordForFile(file: TFile, journalDirectory: string, journalFormat: string): HomeVaultFileRecord {
    const cache = journalDateFromPath(file.path, journalDirectory, journalFormat)
      ? this.app.metadataCache.getFileCache(file)
      : null;
    const imageFile = (cache?.embeds ?? [])
      .filter((embed) => IMAGE_EXTENSION.test(embed.link.split(/[?#]/u)[0] ?? ""))
      .map((embed) => this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path))
      .find((candidate): candidate is TFile => candidate instanceof TFile);
    return {
      path: file.path,
      title: file.basename,
      folder: file.parent?.path || "根目录",
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      ...(imageFile instanceof TFile
        ? {
          firstImagePath: imageFile.path,
          firstImageUrl: this.app.vault.getResourcePath(imageFile)
        }
        : {})
    };
  }

  private async ensureFolder(path: string, language: SettingsLanguage): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(homeCopy(language).template.folderOccupiedByFile(current));
      if (existing) continue;
      try { await this.app.vault.createFolder(current); }
      catch (error) {
        const created = this.app.vault.getAbstractFileByPath(current);
        if (!created || created instanceof TFile) throw error;
      }
    }
  }
}

export function defaultJournalTemplateChoice(): HomeJournalTemplateChoice {
  return { kind: "built-in", template: BUILT_IN_JOURNAL_TEMPLATES[0] };
}

function buildEntrySummaries(
  records: readonly HomeVaultFileRecord[],
  journalDirectory = DEFAULT_JOURNAL_DIRECTORY,
  bindings?: KnowledgeFolderBindings | null
): HomeEntrySummary[] {
  const definitions: Record<HomeEntryId, Pick<HomeEntrySummary, "label" | "description"> & { folder?: string }> = {
    wiki: { label: "Wiki", description: "结构化长期知识", folder: "wiki" },
    outputs: { label: "Outputs", description: "维护记录与生成成果", folder: "outputs" },
    projects: { label: "Projects", description: "正在推进的项目知识", folder: "projects" },
    inbox: { label: "Inbox", description: "等待归类的输入", folder: "inbox" },
    journal: { label: "Journal", description: "日记、复盘与时间记录", folder: journalDirectory },
    review: { label: "Review", description: "知识库复盘与报告" }
  };
  return HOME_ENTRY_IDS.map((id) => {
    const definition = definitions[id];
    const role = id === "wiki" || id === "outputs" || id === "projects" || id === "inbox" ? id : null;
    const matching = bindings && role ? records.filter((record) => classifyKnowledgePath(bindings, record.path) === role) : records;
    const folder = bindings && role ? bindings.roles[role].enabled ? bindings.roles[role].writePath ?? undefined : undefined : definition.folder;
    const recent = bindings && role ? [...matching].sort((a, b) => b.mtime - a.mtime)[0] ?? null : folder ? mostRecentRecordInFolder(records, folder) : null;
    const reviews = id === "review"
      ? records.filter((record) => isKnowledgeBaseReviewPath(record.path)).sort((left, right) => right.mtime - left.mtime)
      : [];
    const review = reviews[0] ?? null;
    return {
      id,
      label: definition.label,
      description: definition.description,
      count: bindings && role ? matching.length : folder ? countRecordsInFolder(records, folder) : reviews.length,
      targetPath: recent?.path ?? review?.path
    };
  });
}
