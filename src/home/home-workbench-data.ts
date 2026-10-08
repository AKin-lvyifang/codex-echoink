import { App, TFile, normalizePath } from "obsidian";
import type { SettingsLanguage } from "../settings/settings";
import type { HomeActivityService } from "./home-activity-service";
import { homeCopy } from "./home-i18n";
import { isHomeNotePath, type HomeNoteVisibility } from "./home-note-visibility";
import { nativeJournalPathForDate, readNativeJournalContext, readNativeJournalSettings } from "./native-journal";
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

export type HomeKnowledgeEntryId = Extract<HomeEntryId, "wiki" | "outputs" | "projects" | "inbox">;

export const HOME_ENTRY_INDEX_PATHS: Readonly<Record<HomeKnowledgeEntryId, string>> = Object.freeze({
  wiki: "wiki/index.md",
  outputs: "outputs/index.md",
  projects: "projects/index.md",
  inbox: "inbox/index.md"
});

export function homeEntryIndexPath(id: HomeEntryId): string | null {
  return HOME_ENTRY_INDEX_PATHS[id as HomeKnowledgeEntryId] ?? null;
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
    private readonly activityService?: HomeActivityService | null,
    private readonly includeNotePath: HomeNoteVisibility = isHomeNotePath
  ) {}

  getJournalDirectory(): string {
    return readNativeJournalSettings(this.app, this.journalDirectoryProvider()).folder;
  }

  journalPathForDate(date: Date): string {
    return nativeJournalPathForDate(this.app, date, this.journalDirectoryProvider());
  }

  existingJournalForDate(date: Date): TFile | null {
    const preferred = this.app.vault.getAbstractFileByPath(this.journalPathForDate(date));
    if (preferred instanceof TFile) return preferred;
    const settings = readNativeJournalSettings(this.app, this.journalDirectoryProvider());
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return this.app.vault.getMarkdownFiles().find((file) => journalDateFromPath(file.path, settings.folder, settings.format) === key) ?? null;
  }

  async ensureJournalDirectory(language: SettingsLanguage = "zh-CN"): Promise<string> {
    const directory = this.getJournalDirectory();
    await this.ensureFolder(directory, language);
    return directory;
  }

  async build(visibleMonth = new Date()): Promise<HomeWorkbenchData> {
    const journalDirectory = this.getJournalDirectory();
    const records = this.app.vault.getMarkdownFiles().filter((file) => this.includeNotePath(file.path)).map((file) =>
      this.recordForFile(file, journalDirectory)
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
      readNativeJournalSettings(this.app, this.journalDirectoryProvider()).format);
    const customTemplates = this.listCustomTemplates();
    return {
      records,
      activity,
      journalDays,
      entries: buildEntrySummaries(records, journalDirectory),
      customTemplates
    };
  }

  async createBlankInboxNote(language: SettingsLanguage = "zh-CN"): Promise<TFile> {
    await this.ensureFolder("inbox", language);
    for (let suffix = 0; ; suffix++) {
      const path = `inbox/未命名${suffix ? ` ${suffix}` : ""}.md`;
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
      ? (await readNativeJournalContext(this.app, { now: date, legacyDirectory: this.journalDirectoryProvider() })).templateContent
      : applyJournalTemplate(await this.readTemplate(choice, language), date);
    await this.ensureFolder(path.slice(0, path.lastIndexOf("/")), language);
    try {
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

  listCustomTemplates(): HomeCustomTemplateSummary[] {
    const prefix = `${JOURNAL_TEMPLATE_DIRECTORY}/`;
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.toLocaleLowerCase().startsWith(prefix))
      .sort((left, right) => left.basename.localeCompare(right.basename, "zh-Hans"))
      .map((file) => ({ id: `custom:${file.path}`, name: file.basename, path: file.path }));
  }

  async saveImportedTemplate(
    template: ImportedJournalTemplate,
    conflictResolution: "cancel" | "safe-copy" = "cancel",
    language: SettingsLanguage = "zh-CN"
  ): Promise<HomeTemplateSaveResult> {
    const path = normalizePath(importedTemplatePath(template.name));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && conflictResolution === "cancel") {
      const paths = new Set(this.app.vault.getMarkdownFiles().map((file) => file.path));
      return {
        status: "conflict",
        path,
        safeCopyPath: nextAvailableImportedTemplatePath(template.name, paths, language)
      };
    }
    const targetPath = existing
      ? normalizePath(nextAvailableImportedTemplatePath(
          template.name,
        new Set(this.app.vault.getMarkdownFiles().map((file) => file.path)),
        language
      ))
      : path;
    await this.ensureFolder(JOURNAL_TEMPLATE_DIRECTORY, language);
    const file = await this.app.vault.create(targetPath, template.content);
    return { status: "saved", path: targetPath, file };
  }

  private recordForFile(file: TFile, journalDirectory: string): HomeVaultFileRecord {
    const cache = journalDateFromPath(file.path, journalDirectory,
      readNativeJournalSettings(this.app, this.journalDirectoryProvider()).format)
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
  journalDirectory = DEFAULT_JOURNAL_DIRECTORY
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
    const folder = definition.folder;
    const recent = folder ? mostRecentRecordInFolder(records, folder) : null;
    const wikiIndex = id === "wiki" ? records.find((record) => record.path.toLocaleLowerCase() === "wiki/index.md") : null;
    const reviews = id === "review"
      ? records.filter((record) => isKnowledgeBaseReviewPath(record.path)).sort((left, right) => right.mtime - left.mtime)
      : [];
    const review = reviews[0] ?? null;
    return {
      id,
      label: definition.label,
      description: definition.description,
      count: folder ? countRecordsInFolder(records, folder) : reviews.length,
      targetPath: wikiIndex?.path ?? recent?.path ?? review?.path
    };
  });
}
