import type { EventRef } from "obsidian";
import type { MobileServices } from "./services";
import type { MobileEnglishDiaryPort } from "./english-diary-contracts";
import { mobileGenerateText, type MobileRequest } from "./transport";
import { requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import { EnglishDiaryRepository, normalizeDiaryPath } from "../english-diary/repository";
import { EnglishDiaryService } from "../english-diary/service";
import { EnglishDiaryVaultPort, readDiarySource } from "../english-diary/vault-port";
import { renderDiaryMarkdown } from "../english-diary/markdown";
import { fingerprint, normalizePrivacy, splitDiaryBlocks } from "../english-diary/model";
import { ENGLISH_DIARY_SKILL, type EnglishDiaryApi, type EnglishDiarySettings, type DiarySource, type GenerateDiaryOptions, type DiaryPrivacy } from "../english-diary/types";
import { loadEnglishDiaryPageData } from "../home/english-diary-page-data";
import { journalDateFromPath } from "../home/home-workbench-model";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { mobileEnglishStorage, assertMobileEnglishStorage } from "./english-diary-storage";
import { mobileEnglishProvider, assertMobileEnglishProvider } from "./english-diary-provider";

/** The existing English repository/transactions, with a mobile host and explicit consent. */
export class MobileEnglishDiaryService implements MobileEnglishDiaryPort {
  readonly api: EnglishDiaryApi;
  private readonly engine: EnglishDiaryService;
  private readonly repository: EnglishDiaryRepository;
  private readonly files: EnglishDiaryVaultPort;
  private readonly data: HomeWorkbenchDataService;
  private readonly refs: EventRef[];
  private readonly releaseRepository: () => void;
  private readonly paths = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private notificationPending = false;
  private observedSettings = "";
  private readonly access: CapabilityAccess;
  constructor(private readonly services: MobileServices, private readonly request: MobileRequest) {
    // Account initialization follows service construction. Never capture its initial undefined value.
    this.access = {
      checkCapability: capability => (services.accountService ?? unavailableCapabilityAccess).checkCapability(capability),
      requireCapability: capability => (services.accountService ?? unavailableCapabilityAccess).requireCapability(capability),
      subscribe: listener => (services.accountService ?? unavailableCapabilityAccess).subscribe(listener)
    };
    const initial = mobileEnglishStorage(services), stateDirectory = `${services.directory.replace(/\/mobile$/u, "")}/english-diary`;
    const roots = [...new Set([stateDirectory, initial.englishDirectory, initial.expressionDirectory, ...initial.legacyEnglishDirectories, ...initial.legacyExpressionDirectories])];
    this.files = new EnglishDiaryVaultPort(services.app, () => {
      const current = mobileEnglishStorage(services);
      return [...new Set([...roots, current.englishDirectory, current.expressionDirectory, ...current.legacyEnglishDirectories, ...current.legacyExpressionDirectories])];
    }, () => this.assertWrite());
    this.files.readSource = path => this.readSource(path).then(source => source.content, () => null);
    this.repository = new EnglishDiaryRepository(this.files, { ...initial, stateDirectory, migrateLegacy: false, recoverInterrupted: false, canMigrate: () => {
      try { this.assertWrite(); return true; } catch { return false; }
    } }, this.access);
    this.data = new HomeWorkbenchDataService(services.app, () => services.settings.journalDirectory, undefined, undefined, () => services.settings.knowledgeBase.folderBindings);
    this.engine = new EnglishDiaryService(this.repository, {
      skill: () => services.requireAvailableEchoInkSkill(ENGLISH_DIARY_SKILL),
      providerLabel: () => mobileEnglishProvider(services.settings).label,
      generate: async input => {
        this.assertWrite();
        const active = assertMobileEnglishProvider(services.settings), version = active.version;
        return mobileGenerateText(active.provider, active.model, async params => {
          this.assertWrite();
          if (input.signal.aborted || assertMobileEnglishProvider(services.settings).version !== version) throw new Error("英文日记模型或批准已变化，本次未发送。");
          return this.request(params);
        }, input.systemPrompt, input.userPrompt, 12_000, input.signal, services.usageObserver, "background");
      }
    }, path => this.readSource(path), this.access);
    this.api = {
      repository: this.repository, access: this.access,
      readSource: path => this.readSource(path), load: path => this.engine.load(path),
      generate: (path, options) => this.generate(path, options),
      savePrivacy: (path, privacy) => { this.assertWrite(); this.refreshStorage(); return this.engine.savePrivacy(path, privacy); },
      restore: path => { this.assertWrite(); this.refreshStorage(); return this.engine.restore(path); },
      cancel: (path, owner) => this.engine.cancel(path, owner), cancelAll: () => this.engine.cancelAll(),
      isGenerating: (path, owner) => this.engine.isGenerating(path, owner)
    };
    const changed = () => this.notify();
    this.refs = [services.app.vault.on("create", changed), services.app.vault.on("modify", changed), services.app.vault.on("delete", changed), services.app.vault.on("rename", changed)];
    this.releaseRepository = this.repository.subscribe(changed);
    this.observedSettings = this.version();
  }
  private active(): void { if (this.disposed) throw new Error("英文日记页面已关闭。"); }
  private assertWrite(): void {
    this.active(); requireProPlugin(this.access);
    if (!this.services.settings.englishDiary.enabled) throw new Error("英文日记已停用；已有资料仍可查看。");
    this.access.requireCapability("diary.explanation.generate");
    if (!this.services.skills().some(skill => skill.id === ENGLISH_DIARY_SKILL && skill.enabled)) throw new Error("英文日记 Skill 已停用或不存在。");
    assertMobileEnglishStorage(this.services);
  }
  private refreshStorage(): void {
    const current = mobileEnglishStorage(this.services);
    this.repository.setStorageDirectories(current.englishDirectory, current.expressionDirectory);
  }
  private version(): string {
    return fingerprint(JSON.stringify([this.services.settings.englishDiary, this.services.settings.apiProviders, this.services.settings.activeApiProviderId, this.services.settings.defaultModel, this.services.settings.knowledgeBase.folderBindings, this.services.settings.journalDirectory, this.services.settings.mobileUi.moduleEnabled?.journal, this.services.settings.resources]));
  }
  private async sources() {
    this.active();
    if (this.services.settings.mobileUi.moduleEnabled?.journal === false) return [];
    const { settings, records } = await this.data.buildJournalRecords(); this.active();
    return records.map(record => ({ path: record.path, title: record.title, date: journalDateFromPath(record.path, settings.folder, settings.format)! }));
  }
  listSources: MobileEnglishDiaryPort["listSources"] = () => this.sources();
  private async readSource(path: string): Promise<DiarySource> {
    this.active(); normalizeDiaryPath(path);
    const candidate = (await this.sources()).find(source => source.path === path);
    if (!candidate) throw new Error("原文不在当前授权的原生日记位置，或文件已失效。");
    const source = await readDiarySource(this.services.app, path); this.active();
    if (!(await this.sources()).some(item => item.path === path)) throw new Error("日记来源或位置已变化，请重新选择。");
    return { ...source, date: candidate.date };
  }
  private generate(path: string, options: GenerateDiaryOptions = {}) {
    this.active(); this.refreshStorage();
    const version = this.version();
    const pending = this.engine.generate(path, { ...options, generator: undefined, assertCanPublish: async () => {
      this.assertWrite();
      if (this.version() !== version) throw new Error("英文日记设置或模型已变化，已保留已有成果，请重新开始。");
      await this.services.requireAvailableEchoInkSkill(ENGLISH_DIARY_SKILL);
      this.assertWrite();
      if (this.version() !== version) throw new Error("英文日记设置已变化，本次结果未发布。");
      await options.assertCanPublish?.();
    } });
    this.paths.add(path);
    const finish = () => { if (!this.engine.isGenerating(path)) this.paths.delete(path); this.notify(); };
    void pending.then(finish, finish);
    return pending;
  }
  inspectSource: MobileEnglishDiaryPort["inspectSource"] = async path => {
    this.active(); this.refreshStorage();
    const source = await this.readSource(path), record = await this.repository.inspect(source), blocks = splitDiaryBlocks(source.content);
    let privacy: DiaryPrivacy, privacyReviewRequired = false;
    try { privacy = normalizePrivacy(blocks, fingerprint(source.content), record.privacy); }
    catch { privacyReviewRequired = true; privacy = { sourceFingerprint: fingerprint(source.content), rules: blocks.map(block => ({ blockId: block.id, mode: "exclude" as const })) }; }
    this.active(); return { source, record, blocks, privacy, privacyReviewRequired };
  };
  readPage: MobileEnglishDiaryPort["readPage"] = async () => {
    this.active(); this.refreshStorage();
    const expressions = this.repository.readExpressionsWithVersions();
    // Both the visible fields and their save versions come from one repository queue turn.
    const repository = Object.create(this.repository) as EnglishDiaryRepository;
    repository.listExpressions = async () => (await expressions).entries;
    repository.listSavedDiaries = () => this.repository.listSavedDiaries();
    repository.listGenerationActivity = options => this.repository.listGenerationActivity(options);
    const data = await loadEnglishDiaryPageData({ repository });
    const expressionVersions = await expressions.then(value => value.versions, () => ({}));
    this.active(); return { ...data, expressionVersions };
  };
  readSaved: MobileEnglishDiaryPort["readSaved"] = async id => {
    this.active(); this.refreshStorage();
    const record = await this.repository.inspectSaved(id), errors: string[] = [];
    let source: DiarySource | null = null, englishMarkdown: string | null = null;
    try { source = await this.readSource(record.sourcePath); } catch { errors.push("原文不可用，暂不显示精确对照。"); }
    try { englishMarkdown = await this.files.read(record.englishPath); } catch { errors.push("英文文件暂时无法读取。"); }
    const unchangedEnglish = englishMarkdown !== null && fingerprint(englishMarkdown) === record.savedFileFingerprint;
    const unchangedSource = source !== null && fingerprint(source.content) === record.result?.sourceFingerprint;
    if (englishMarkdown === null) errors.push("英文文件不存在或尚未同步。");
    if (englishMarkdown !== null && !unchangedEnglish) errors.push("英文稿有手工修改，已显示实际文件，暂不显示精确对照。");
    if (source !== null && !unchangedSource) errors.push("原文已变化，暂不显示精确对照。");
    let resultMatches = false;
    try { resultMatches = !!record.result && Array.isArray(record.result.alignments) && fingerprint(record.result.english) === record.result.englishFingerprint && fingerprint(renderDiaryMarkdown(record.result)) === record.savedFileFingerprint; } catch { /* Keep the actual Markdown readable when saved associations are inconsistent. */ }
    if (record.result && !resultMatches) errors.push("已存对照与英文文件无法核实，暂不显示精确对照。");
    this.active(); return { record, source, englishMarkdown, canAlign: resultMatches && unchangedEnglish && unchangedSource, errors };
  };
  saveExpression: MobileEnglishDiaryPort["saveExpression"] = async (id, changes, expectedVersion) => {
    this.assertWrite(); this.access.requireCapability("diary.expression.write"); this.refreshStorage();
    if (!/^[a-f0-9]{64}$/u.test(expectedVersion) || typeof changes.category !== "string" || typeof changes.note !== "string") throw new Error("表达版本或编辑内容无效，请重新读取。");
    await this.services.requireAvailableEchoInkSkill(ENGLISH_DIARY_SKILL); this.assertWrite();
    return this.repository.updateExpression(id, changes, expectedVersion);
  };
  readSettings: MobileEnglishDiaryPort["readSettings"] = async () => {
    this.active(); return { settings: structuredClone(this.services.settings.englishDiary), version: this.version() };
  };
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(action, action); this.writes = pending.catch(() => {}); return pending;
  }
  private async persist(next: EnglishDiarySettings, expectedVersion: string): Promise<void> {
    this.active(); if (this.version() !== expectedVersion) throw new Error("英文日记设置已变化，已保留你的草稿，请重新读取。");
    const previous = this.services.settings.englishDiary;
    this.services.settings.englishDiary = next;
    try { await this.services.saveSettings(); }
    catch (error) { if (this.services.settings.englishDiary === next) this.services.settings.englishDiary = previous; throw error; }
    if (this.services.settings.englishDiary !== next) throw new Error("保存期间设置已变化，请重新读取核对。");
    this.settingsChanged();
  }
  saveSettings: MobileEnglishDiaryPort["saveSettings"] = (patch, expectedVersion) => this.exclusive(async () => {
    this.active(); requireProPlugin(this.access);
    if (Object.hasOwn(patch, "approvedProvider")) throw new Error("模型批准只能通过本次接收方确认保存。");
    const previous = this.services.settings.englishDiary;
    const allowed = ["enabled", "homeShortcut", "providerSettingsId", "modelId", "englishDirectory", "expressionDirectory", "englishDirectoryMode", "expressionDirectoryMode"];
    if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("此设置字段不能在这里修改。");
    const next = { ...previous, ...patch };
    if (typeof next.enabled !== "boolean" || !["ask", "quick-record", "english-diary"].includes(next.homeShortcut) || typeof next.providerSettingsId !== "string" || typeof next.modelId !== "string") throw new Error("英文日记设置无效。");
    next.providerSettingsId = next.providerSettingsId.trim(); next.modelId = next.modelId.trim();
    if (next.providerSettingsId || next.modelId) mobileEnglishProvider({ ...this.services.settings, englishDiary: next });
    if (next.providerSettingsId !== previous.providerSettingsId || next.modelId !== previous.modelId) next.approvedProvider = "";
    for (const key of ["englishDirectory", "expressionDirectory"] as const) {
      next[key] = normalizeDiaryPath(next[key]);
      if (next[key].split("/").some(part => part.startsWith("."))) throw new Error("输出目录不能使用隐藏或插件配置目录。");
    }
    if (next.englishDirectory === next.expressionDirectory) throw new Error("英文日记和表达库不能使用同一目录。");
    if (next.englishDirectoryMode !== undefined && !["role", "custom"].includes(next.englishDirectoryMode) || next.expressionDirectoryMode !== undefined && !["role", "custom"].includes(next.expressionDirectoryMode)) throw new Error("目录用途无效。");
    if (previous.englishDirectory !== next.englishDirectory) next.legacyEnglishDirectories = [...new Set([...(previous.legacyEnglishDirectories ?? []), previous.englishDirectory])];
    if (previous.expressionDirectory !== next.expressionDirectory) next.legacyExpressionDirectories = [...new Set([...(previous.legacyExpressionDirectories ?? []), previous.expressionDirectory])];
    if (["englishDirectory", "expressionDirectory", "englishDirectoryMode", "expressionDirectoryMode"].some(key => Object.hasOwn(patch, key))) assertMobileEnglishStorage({ app: this.services.app, settings: { ...this.services.settings, englishDiary: next } } as MobileServices);
    await this.persist(next, expectedVersion);
  });
  readProvider: MobileEnglishDiaryPort["readProvider"] = async () => {
    this.active(); const current = mobileEnglishProvider(this.services.settings);
    return { version: current.version, label: current.label, recipient: current.recipient, approved: this.services.settings.englishDiary.approvedProvider === current.identity };
  };
  approveProvider: MobileEnglishDiaryPort["approveProvider"] = expectedVersion => this.exclusive(async () => {
    this.active(); requireProPlugin(this.access);
    const current = mobileEnglishProvider(this.services.settings);
    if (current.version !== expectedVersion) throw new Error("模型或接收方已变化，请重新确认。");
    await this.persist({ ...this.services.settings.englishDiary, approvedProvider: current.identity }, this.version());
  });
  subscribe: MobileEnglishDiaryPort["subscribe"] = listener => { if (this.disposed) return () => {}; this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void {
    if (this.disposed || this.notificationPending) return;
    this.notificationPending = true;
    void Promise.resolve().then(() => { this.notificationPending = false; if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot interrupt a committed transaction. */ } } });
  }
  settingsChanged(): void { if (this.disposed) return; const current = this.version(); if (current !== this.observedSettings) this.cancelWorkspace(); this.observedSettings = current; try { this.refreshStorage(); } catch { /* Invalid external settings remain visible as read errors. */ } this.notify(); }
  cancelWorkspace(): void { for (const path of this.paths) this.engine.cancel(path, "workspace"); }
  dispose(): void {
    if (this.disposed) return;
    this.engine.cancelAll(); this.disposed = true; this.releaseRepository();
    this.refs.forEach(ref => this.services.app.vault.offref(ref)); this.listeners.clear();
  }
}
