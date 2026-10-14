import { knowledgeRoleStatus, knowledgeRolePath } from "../knowledge-base/root-paths";
import { getProPluginAccess, requireProPluginAction, requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import { Notice, TFile, TFolder } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { confirmModal } from "../ui/modals";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { BUILT_IN_JOURNAL_TEMPLATES, DEFAULT_JOURNAL_TEMPLATE_ID, journalDateFromPath } from "../home/home-workbench-model";
import { readNativeJournalSettings } from "../home/native-journal";
import { resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths";
import { EnglishDiaryRepository } from "./repository";
import { EnglishDiaryService } from "./service";
import { EnglishDiaryVaultPort, readDiarySource, saveDiarySource } from "./vault-port";
import { DEFAULT_ENGLISH_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY, LEGACY_ENGLISH_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, ENGLISH_DIARY_SKILL, ENGLISH_DIARY_VIEW, ENGLISH_EXPRESSION_VIEW, type DiaryRecord, type GenerateDiaryOptions } from "./types";
import type { EnglishDiaryViewHost } from "./view-host";
import { EnglishDiaryView } from "./view";
import { EnglishExpressionView } from "./expression-view";
import { fingerprint } from "./model";

export class EnglishDiaryController implements EnglishDiaryViewHost {
  readonly api: EnglishDiaryService;
  private readonly activePaths = new Set<string>();
  private readonly storageSettingsChanged: boolean;
  private mappedEnglish: string | null = null;
  private mappedExpressions: string | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin) {
    const settings = plugin.settings.englishDiary;
    const previous = JSON.stringify(settings);
    const rootNames = (plugin.app.vault.getRoot?.().children ?? [])
      .filter((file) => file instanceof TFolder).map((folder) => folder.path);
    const output = plugin.settings.knowledgeBase.folderBindings?.roles.outputs;
    const useEnglishDefault = settings.englishDirectoryMode === "role" || (!settings.englishDirectoryMode && knowledgeRolePath(settings.englishDirectory) === DEFAULT_ENGLISH_DIRECTORY);
    settings.englishDirectoryMode = useEnglishDefault ? "role" : "custom";
    const useExpressionDefault = settings.expressionDirectoryMode === "role" || (!settings.expressionDirectoryMode && knowledgeRolePath(settings.expressionDirectory) === DEFAULT_EXPRESSION_DIRECTORY);
    settings.expressionDirectoryMode = useExpressionDefault ? "role" : "custom";
    const englishDirectory = useEnglishDefault ? (output?.enabled && output.writePath ? `${output.writePath}/英文日记` : plugin.settings.knowledgeBase.folderBindings ? settings.englishDirectory : resolveKnowledgePathFromRoots(DEFAULT_ENGLISH_DIRECTORY, rootNames)) : settings.englishDirectory;
    const expressionDirectory = useExpressionDefault ? (output?.enabled && output.writePath ? `${output.writePath}/表达库` : plugin.settings.knowledgeBase.folderBindings ? settings.expressionDirectory : resolveKnowledgePathFromRoots(DEFAULT_EXPRESSION_DIRECTORY, rootNames)) : settings.expressionDirectory;
    this.mappedEnglish = useEnglishDefault ? englishDirectory : null;
    this.mappedExpressions = useExpressionDefault ? expressionDirectory : null;
    settings.legacyEnglishDirectories = [...new Set([...(settings.legacyEnglishDirectories ?? []), settings.englishDirectory, LEGACY_ENGLISH_DIRECTORY, DEFAULT_ENGLISH_DIRECTORY])]
      .filter((directory) => directory && directory !== englishDirectory);
    settings.legacyExpressionDirectories = [...new Set([...(settings.legacyExpressionDirectories ?? []), settings.expressionDirectory, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY])]
      .filter((directory) => directory && directory !== expressionDirectory);
    settings.englishDirectory = englishDirectory;
    settings.expressionDirectory = expressionDirectory;
    this.storageSettingsChanged = previous !== JSON.stringify(settings);
    const stateDirectory = `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/english-diary`;
    const roots = [...new Set([englishDirectory, expressionDirectory, DEFAULT_ENGLISH_DIRECTORY, DEFAULT_EXPRESSION_DIRECTORY,
      LEGACY_ENGLISH_DIRECTORY, LEGACY_EXPRESSION_DIRECTORY, LEGACY_HIDDEN_EXPRESSION_DIRECTORY,
      ...settings.legacyEnglishDirectories, ...settings.legacyExpressionDirectories, stateDirectory])];
    const repository = new EnglishDiaryRepository(new EnglishDiaryVaultPort(plugin.app, () => [...new Set([...roots, plugin.settings.englishDiary.englishDirectory, plugin.settings.englishDiary.expressionDirectory, ...(plugin.settings.englishDiary.legacyEnglishDirectories ?? []), ...(plugin.settings.englishDiary.legacyExpressionDirectories ?? [])])], (target, exists) => {
      if (target.startsWith(`${stateDirectory}/`) || exists) return;
      const bindings = plugin.settings.knowledgeBase.folderBindings;
      if (!bindings) return;
      const mapped = [this.mappedEnglish, this.mappedExpressions].filter((value): value is string => !!value);
      if (mapped.some((directory) => target.startsWith(`${directory}/`))) {
        if (knowledgeRoleStatus(plugin.getVaultPath(), "outputs") !== "ready") throw new Error("请先选择可用的输出位置；已有英文日记仍可查看。");
        const output = bindings.roles.outputs;
        const directory = mapped.find((directory) => target.startsWith(`${directory}/`))!;
        const child = directory.slice((output.writePath?.length ?? 0) + 1);
        if (!plugin.app.vault.getAbstractFileByPath(directory) && !output.allowedSubdirectories.includes(child)) throw new Error(`请在目录方案中确认子目录：${child}`);
      }
    }), { ...settings, stateDirectory, migrateLegacy: !plugin.settings.knowledgeBase.folderBindings, flatExpressions: Boolean(plugin.settings.knowledgeBase.folderBindings) }, plugin.accountService ?? unavailableCapabilityAccess);
    this.api = new EnglishDiaryService(repository, {
      generate: (input) => plugin.generateEnglishDiaryText(input),
      providerLabel: () => plugin.englishDiaryProviderLabel(),
      skill: async () => {
        await plugin.requireAvailableEchoInkSkill(ENGLISH_DIARY_SKILL);
        return (await plugin.readEchoInkBuiltinSkill(ENGLISH_DIARY_SKILL)).content;
      }
    }, async (path) => {
      const source = await readDiarySource(plugin.app, path);
      const native = readNativeJournalSettings(plugin.app, plugin.settings.journalDirectory);
      const file = plugin.app.vault.getAbstractFileByPath(path);
      const property = file instanceof TFile ? plugin.app.metadataCache.getFileCache(file)?.frontmatter?.date as unknown : undefined;
      const propertyDate = typeof property === "string" && /^\d{4}-\d{2}-\d{2}$/.test(property) ? property : null;
      return { ...source, date: journalDateFromPath(path, native.folder, native.format) ?? propertyDate ?? source.title };
    }, plugin.accountService ?? unavailableCapabilityAccess);
  }
  refreshStoragePaths(): void {
    const settings = this.plugin.settings.englishDiary;
    const output = this.plugin.settings.knowledgeBase.folderBindings?.roles.outputs;
    if (output?.enabled && output.writePath) {
      if (settings.englishDirectoryMode === "role") { settings.legacyEnglishDirectories = [...new Set([...(settings.legacyEnglishDirectories ?? []), settings.englishDirectory])]; this.mappedEnglish = settings.englishDirectory = `${output.writePath}/英文日记`; }
      if (settings.expressionDirectoryMode === "role") { settings.legacyExpressionDirectories = [...new Set([...(settings.legacyExpressionDirectories ?? []), settings.expressionDirectory])]; this.mappedExpressions = settings.expressionDirectory = `${output.writePath}/表达库`; }
    }
    (this.api.repository as EnglishDiaryRepository).setStorageDirectories(settings.englishDirectory, settings.expressionDirectory);
  }

  register(): void {
    const { plugin } = this;
    if (this.storageSettingsChanged) void plugin.saveSettings(true, { flushConversationStore: false }).catch(showError);
    plugin.registerView(ENGLISH_DIARY_VIEW, (leaf) => new EnglishDiaryView(leaf, this));
    plugin.registerView(ENGLISH_EXPRESSION_VIEW, (leaf) => new EnglishExpressionView(leaf, this));
    plugin.addCommand({ id: "open-english-diary", name: "英文日记：打开今天的日记", checkCallback: (checking) => {
      if (!this.enabled()) return false;
      if (!checking) void this.openToday().catch(showError);
      return true;
    } });
    plugin.addCommand({ id: "open-english-expressions", name: "英文日记：打开表达库", checkCallback: (checking) => {
      if (!this.enabled()) return false;
      if (!checking) void this.openLibrary().catch(showError);
      return true;
    } });
    plugin.registerEvent(plugin.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      this.api.cancel(oldPath);
      void this.api.repository.renameSource(oldPath, file.path).catch(showError);
    }));
    plugin.registerEvent(plugin.app.workspace.on("editor-change", (_editor, view) => { if (view.file) this.api.cancel(view.file.path); }));
    plugin.registerEvent(plugin.app.vault.on("modify", (file) => {
      this.api.cancel(file.path);
    }));
    plugin.registerEvent(plugin.app.vault.on("delete", (file) => this.api.cancel(file.path)));
  }
  enabled(): boolean { return this.plugin.settings.englishDiary.enabled; }
  private requireEnabled(): void { requireProPluginAction(this.api.access, this.enabled(), "enter"); if (!this.enabled()) throw new Error("请先在设置 → 插件中启用英文日记。"); }
  async setEnabled(enabled: boolean): Promise<void> {
    requireProPluginAction(this.api.access, this.enabled(), "toggle");
    const previous = this.enabled();
    this.plugin.settings.englishDiary.enabled = enabled;
    try { await this.plugin.saveSettings(true); }
    catch (error) { this.plugin.settings.englishDiary.enabled = previous; throw error; }
    if (!enabled) {
      this.dispose();
      this.plugin.app.workspace.detachLeavesOfType(ENGLISH_DIARY_VIEW);
      this.plugin.app.workspace.detachLeavesOfType(ENGLISH_EXPRESSION_VIEW);
    }
    this.plugin.notifyHomeSurfacesChanged();
  }
  async openToday(): Promise<void> {
    this.requireEnabled();
    const data = new HomeWorkbenchDataService(this.plugin.app, () => this.plugin.settings.journalDirectory, this.plugin.homeActivity, undefined, () => this.plugin.settings.knowledgeBase.folderBindings);
    if (!getProPluginAccess(this.api.access, this.enabled()).canWrite) {
      const existing = data.existingJournalForDate(new Date());
      if (existing) await this.openDiary(existing.path);
      else await this.openLibrary();
      return;
    }
    const template = BUILT_IN_JOURNAL_TEMPLATES.find((item) => item.id === DEFAULT_JOURNAL_TEMPLATE_ID)!;
    const { file } = await data.createOrOpenJournal({ kind: "built-in", template }, new Date(), this.plugin.settings.settingsLanguage);
    await this.openDiary(file.path);
  }
  async setHomeShortcut(value: "quick-record" | "english-diary"): Promise<void> {
    const settings = this.plugin.settings.englishDiary;
    const previous = settings.homeShortcut;
    settings.homeShortcut = value;
    try {
      await this.plugin.saveSettings(true, { flushConversationStore: false });
    } catch (error) {
      if (settings.homeShortcut === value) settings.homeShortcut = previous;
      throw error;
    }
    this.plugin.notifyHomeSurfacesChanged();
  }
  async openDiary(path: string): Promise<void> {
    this.requireEnabled();
    const workspace = this.plugin.app.workspace;
    const leaf = workspace.getLeavesOfType(ENGLISH_DIARY_VIEW).find((item) => item.view.getState().sourcePath === path) ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: ENGLISH_DIARY_VIEW, active: true, state: { sourcePath: path } });
    await workspace.revealLeaf(leaf);
  }
  async openLibrary(): Promise<void> {
    this.requireEnabled();
    const workspace = this.plugin.app.workspace;
    const leaf = workspace.getLeavesOfType(ENGLISH_EXPRESSION_VIEW)[0] ?? workspace.getLeaf("tab");
    await leaf.setViewState({ type: ENGLISH_EXPRESSION_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  }
  async openFile(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("文件已移动或不存在。");
    await this.plugin.app.workspace.getLeaf("tab").openFile(file);
  }
  async generate(path: string, options: GenerateDiaryOptions = {}): Promise<DiaryRecord> {
    this.requireEnabled();
    const source = await this.api.readSource(path), record = await this.api.load(path);
    const sourceHash = fingerprint(source.content);
    if (record.englishModified && (record.result?.sourceFingerprint !== sourceHash || record.pending?.sourceFingerprint === sourceHash)) {
      const accepted = await confirmModal(this.plugin.app, "英文稿有手工修改", "检测到插件维护文件被外部修改。更新会替换该文件，请先备份需要保留的手工内容。日记原稿保持不变。", "确认替换", "取消");
      if (!accepted) throw new Error("已取消更新，手工修改已保留。");
      options = { ...options, overwriteModified: true, expectedEnglishFingerprint: record.observedFileFingerprint };
    }
    this.activePaths.add(path);
    try { return await this.api.generate(path, options); }
    finally { this.activePaths.delete(path); }
  }
  async saveSource(path: string, content: string, expected: string): Promise<void> {
    this.requireEnabled();
    requireProPlugin(this.api.access);
    this.api.cancel(path);
    await saveDiarySource(this.plugin.app, path, content, expected);
  }
  async organizeThoughts(path: string): Promise<void> {
    this.requireEnabled();
    await this.plugin.activateView();
    const view = this.plugin.getCodexView();
    if (!view) throw new Error("无法打开 EchoInk 对话，请重试。");
    const prepared = view.prepareComposerDraft(`请帮我整理接下来提供的零散想法，用于日记 ${JSON.stringify(path)}。只使用我在本次对话中主动提供的内容，不要自动读取日记或其他笔记。先给我中文预览，经过我确认后再写入日记，不生成英文。\n\n我的想法：`);
    if (!prepared) new Notice("已打开当前对话，输入框中原有草稿已保留。");
  }
  dispose(): void { this.api.cancelAll(); }
}
function showError(error: unknown): void { new Notice(error instanceof Error ? error.message : String(error)); }
