import { TFile, type EventRef } from "obsidian";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { journalStats, journalSummary } from "../home/journal-stats";
import { getTodoProjects } from "../home/todo-projects";
import { readFinanceBill } from "../lifestyle/finance-domain";
import { GENERAL_ASSISTANT_ID } from "../agents/types";
import type { TaskDraft } from "../agents/task-workspace";
import { newId } from "../core/new-id";
import type { MobileModulePort, MobileModuleId, MobileJournalPort, MobileTodoPort, MobileFinancePort } from "./module-contracts";
import { mobileModuleEnabled } from "./module-settings";
import type { MobileServices } from "./services";
import type { MobileStore } from "./store";

/** The shared business boundary; endpoint views own all layout and navigation. */
export class MobileModuleService implements MobileModulePort {
  readonly journal: MobileJournalPort;
  readonly todos: MobileTodoPort;
  readonly finance: MobileFinancePort;
  private readonly releases = new Set<() => void>();
  private categoryWrites: Promise<void> = Promise.resolve();
  constructor(private readonly services: MobileServices, private readonly store: MobileStore) {
    const data = new HomeWorkbenchDataService(services.app, () => services.settings.journalDirectory, services.homeActivity, undefined, () => services.settings.knowledgeBase.folderBindings);
    this.journal = {
      openSettings: () => {
        const settings = (services.app as unknown as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
        if (!settings?.open || !settings.openTabById) throw new Error("当前宿主无法打开原生日记设置，请在 Obsidian 设置中配置日记。");
        settings.open(); settings.openTabById("daily-notes");
      },
      readTemplate: choice => data.readTemplate(choice, services.settings.settingsLanguage),
      previewImportedTemplate: (name, content) => data.previewImportedTemplate(name, content, services.settings.settingsLanguage),
      saveImportedTemplate: (template, resolution) => { this.enabled("journal"); return data.saveImportedTemplate(template, resolution, services.settings.settingsLanguage); },
      read: async () => {
        this.enabled("journal");
        const { settings, records } = await data.buildJournalRecords();
        return { settings, records, stats: journalStats(records, settings.folder, settings.format), templates: data.listCustomTemplates(undefined, settings) };
      },
      readSummary: async path => {
        const snapshot = await this.journal.read();
        if (!snapshot.records.some(record => record.path === path)) throw new Error("日记不存在或位置已变化，请重新读取。");
        const file = services.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("日记原文不存在。");
        return journalSummary(await services.app.vault.read(file));
      },
      create: async (date, choice) => {
        this.enabled("journal");
        if (!Number.isFinite(date.getTime())) throw new Error("日记日期无效。");
        const result = await data.createOrOpenJournal(choice, date, services.settings.settingsLanguage);
        return { path: result.file.path, created: result.created };
      },
      subscribe: listener => this.watchJournal(listener)
    };
    const todos = services.getTodoStore();
    this.todos = {
      listSourceFiles: () => services.app.vault.getMarkdownFiles().map(file => file.path).sort((a, b) => a.localeCompare(b)),
      selectSource: async (path, expectedPath) => {
        if (!path || path !== path.trim() || path.startsWith("/") || /[\\:]/u.test(path) || [...path].some(character => character.charCodeAt(0) < 32) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("请选择当前笔记库中的 Markdown 文件。");
        const file = services.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error("所选文件已不存在，请重新选择。");
        await todos.changeSource(expectedPath, async () => {
          const before = services.settings.mobileUi.todoSourcePath; services.settings.mobileUi.todoSourcePath = path;
          try { await services.saveSettings(); }
          catch (error) { services.settings.mobileUi.todoSourcePath = before; throw error; }
        });
      },
      read: async () => {
        this.enabled("todos"); await todos.initialize();
        const snapshot = await todos.readOnlySnapshot();
        return { ...snapshot, projects: getTodoProjects(services), categories: structuredClone(services.settings.todoCategories), completion: todos.completionStatistics() };
      },
      add: async (input, version, sourcePath) => { this.enabled("todos"); await todos.addTodo(input, version, sourcePath); },
      update: async (target, patch, version, sourcePath) => { this.enabled("todos"); await todos.updateTodo(target, patch, version, sourcePath); },
      toggle: async (target, done, version, sourcePath) => { this.enabled("todos"); await todos.updateTodo(target, { done }, version, sourcePath); },
      remove: async (target, version, sourcePath) => { this.enabled("todos"); await todos.removeTodo(target, version, sourcePath); },
      addCategory: name => this.categoryWrite(async () => {
        name = this.categoryName(name);
        const category = { id: newId("todo-category"), name };
        services.settings.todoCategories.push(category);
        try { await services.saveSettings(); }
        catch (error) { const index = services.settings.todoCategories.indexOf(category); if (index >= 0) services.settings.todoCategories.splice(index, 1); throw error; }
      }),
      renameCategory: (oldName, name, version, sourcePath) => this.categoryWrite(async () => {
        if (oldName === name.trim()) return;
        name = this.categoryName(name);
        const category = services.settings.todoCategories.find(item => item.name === oldName);
        if (!category) throw new Error("分类已变化，请重新读取。");
        if (sourcePath !== undefined && todos.sourcePath !== sourcePath) throw new Error("待办数据文件已切换，请返回后重新打开；输入已保留。");
        if ((await todos.readOnlySnapshot()).contentVersion !== version) throw new Error("待办源文件已变化，请重新读取。");
        category.name = name;
        try { await services.saveSettings(); }
        catch (error) { if (category.name === name) category.name = oldName; throw error; }
        try { await todos.renameCategoryInSource(oldName, name, version, sourcePath); }
        catch (error) {
          if (category.name === name) { category.name = oldName; try { await services.saveSettings(); } catch (rollback) { throw new AggregateError([error, rollback], "分类未完成保存，请重新读取；原待办已保留。"); } }
          throw error;
        }
      }),
      subscribe: listener => todos.subscribe(listener)
    };
    this.finance = {
      get service() { if (!services.lifestyle) throw new Error("财务服务尚未就绪。"); return services.lifestyle.finance; },
      readData: async () => { this.enabled("finance"); return services.lifestyle.store.readFresh(); },
      readBill: readFinanceBill,
      saveCsv: (name, content) => services.saveFinanceCsv(name, content, () => { this.enabled("finance"); this.finance.service.access.requireCapability("finance.export"); })
    };
  }
  private enabled(module: MobileModuleId): void { if (!mobileModuleEnabled(this.services.settings, module)) throw new Error("此模块已停用。"); }
  owner(module: MobileModuleId) {
    const registry = this.services.settings.agentRegistry;
    const owner = registry.agents.find(agent => agent.id === registry.moduleOwners[module]) ?? registry.agents.find(agent => agent.id === GENERAL_ASSISTANT_ID);
    if (!owner) throw new Error("模块负责人不存在，请重新设置。");
    return structuredClone(owner);
  }
  async handoff(module: MobileModuleId, prompt: string, replaceDraft = false) {
    this.enabled(module); if (!prompt.trim()) throw new Error("交给 Agent 的内容不能为空。");
    let agentId = this.owner(module).id, conflict = false;
    await this.store.update(latest => {
      this.enabled(module); agentId = this.owner(module).id;
      const previous = latest.newTaskDrafts[agentId];
      const occupied = previous && (previous.text.trim() || previous.attachments.length || previous.noteMentions?.length || previous.annotations?.length || previous.selectedSkill);
      conflict = !!occupied && !replaceDraft;
      if (conflict) return;
      const draft: TaskDraft = { ...previous, text: prompt, attachments: [] };
      delete draft.noteMentions; delete draft.annotations; delete draft.selectedSkill; delete draft.englishDiarySourcePath; delete draft.prefillSource;
      latest.page = { kind: "list", agentId }; latest.newTaskDrafts[agentId] = draft;
    });
    return { agentId, conflict };
  }
  private categoryName(name: string): string {
    this.enabled("todos"); name = name.trim();
    if (!name || name.length > 60 || /[\r\n\0]/u.test(name) || this.services.settings.todoCategories.some(item => item.name === name)) throw new Error("请填写不重复的有效分类名称。");
    return name;
  }
  private categoryWrite(change: () => Promise<void>): Promise<void> {
    const next = this.categoryWrites.then(change, change); this.categoryWrites = next.catch(() => {}); return next;
  }
  private watchJournal(listener: () => void): () => void {
    const vault = this.services.app.vault, changed = () => { try { listener(); } catch { /* Views do not own source events. */ } };
    const refs: EventRef[] = [vault.on("create", changed), vault.on("modify", changed), vault.on("rename", changed), vault.on("delete", changed)];
    const cache = this.services.app.metadataCache, cacheRef = cache.on("changed", changed);
    const release = () => { refs.splice(0).forEach(ref => vault.offref(ref)); cache.offref(cacheRef); this.releases.delete(release); };
    this.releases.add(release); return release;
  }
  dispose(): void { for (const release of [...this.releases]) release(); }
}
