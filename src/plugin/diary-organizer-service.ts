import { TFile } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { DiaryOrganizerEngine } from "../diary-organizer/engine";
import { DiaryOrganizerScheduler } from "../diary-organizer/scheduler";
import { diaryFingerprint } from "../diary-organizer/identity";
import type { DiaryCandidate, DiaryFinanceCandidate, DiaryOrganizerOptions, DiaryOrganizerPorts, DiaryWrittenRecord, DiaryWriteInput } from "../diary-organizer/types";
import type { FinanceRecordSnapshot } from "../lifestyle/finance-operation-types";
import type { TodoDiaryRecord } from "../home/todo-store";
import { HomeWorkbenchDataService } from "../home/home-workbench-data";
import { journalDateFromPath } from "../home/home-workbench-model";
import { hasProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { atomicWriteJsonFile, readJsonFileIfPresent, serializePiNativeFileWrite } from "../harness/pi-native/file-store-utils";
import { pluginDataDir } from "./plugin-data-paths";
import { getDesktopPath } from "../platform/desktop-paths";

const financeReceipt = (record: FinanceRecordSnapshot): DiaryWrittenRecord => ({
  id: record.entry.id, version: record.version,
  summary: `${record.entry.date} · ${record.entry.merchant} · ${record.entry.currency} ${(record.entry.amountCents / 100).toFixed(2)} · ${record.entry.category}`
});
const todoReceipt = ({ record, version }: TodoDiaryRecord): DiaryWrittenRecord => ({
  id: record.id, version, summary: `${record.done ? "☑" : "☐"} ${record.title}${record.dueDate ? ` · ${record.dueDate}` : ""}`
});

/** Only desktop constructs this adapter. The engine itself stays independent of the host. */
export class DiaryOrganizerService {
  readonly engine: DiaryOrganizerEngine;
  private scheduler: DiaryOrganizerScheduler | null = null;
  private disposed = false;
  hasJournals = false;
  private sourceGenerations = new Map<string, number>();
  private readonly data: HomeWorkbenchDataService;
  readonly ports: DiaryOrganizerPorts;

  constructor(private readonly plugin: CodexForObsidianPlugin, options: DiaryOrganizerOptions = {}, now?: () => number) {
    const app = plugin.app;
    const file = getDesktopPath().join(pluginDataDir(plugin.getVaultPath(), plugin.getPluginDataDirName()), "diary-organizer.v1.json");
    this.data = new HomeWorkbenchDataService(app, () => plugin.settings.journalDirectory, plugin.homeActivity, undefined, () => plugin.settings.knowledgeBase.folderBindings);
    const finance = plugin.lifestyle.finance;
    const readDiary = async (path: string) => {
      const source = app.vault.getAbstractFileByPath(path);
      return source instanceof TFile ? app.vault.read(source) : null;
    };
    const guard = () => {
      if (this.disposed || !plugin.settings.diaryOrganizerEnabled) throw new Error("日记自动整理已关闭。");
    };
    this.ports = {
      loadState: () => readJsonFileIfPresent(file, "日记整理进度"),
      saveState: state => serializePiNativeFileWrite(file, async () => { await atomicWriteJsonFile(file, state, "日记整理进度", value => value); }),
      listDiaries: async () => {
        const { settings, records } = await this.data.buildJournalRecords();
        return records.flatMap(record => {
          const date = journalDateFromPath(record.path, settings.folder, settings.format);
          const source = app.vault.getAbstractFileByPath(record.path);
          return date && source instanceof TFile ? [{ path: record.path, date, mtime: source.stat.mtime }] : [];
        });
      },
      readDiary,
      isEnabled: () => !this.disposed && plugin.settings.diaryOrganizerEnabled,
      hasFinanceAccess: () => plugin.settings.lifestyle.finance.enabled && hasProPluginAccess(plugin.accountService ?? unavailableCapabilityAccess),
      isBusy: () => plugin.diaryOrganizerBusy(),
      generateText: request => plugin.generateDiaryOrganizerText(request.system, request.prompt, request.signal),
      readFinanceSnapshot: async () => {
        const snapshot = await finance.readDiarySnapshot();
        return { entries: snapshot.records.map(record => ({ ...record.entry, version: record.version })),
          categories: snapshot.categories.filter(category => category.active).map(category => ({ name: category.name })) };
      },
      readTodoSnapshot: async () => (await plugin.getTodoStore().snapshotForDiary()).records.map(record => ({
        id: record.id, text: record.title, completed: record.done, completedAt: record.completedAt
      })),
      writeFinance: async input => financeReceipt(await finance.writeDiaryRecord(input.extractionId, input.diaryPath, this.financeInput(input), await this.sourceGuard(input))),
      writeTodo: async input => todoReceipt(await plugin.getTodoStore().addFromDiary(input.extractionId, input.diaryPath,
        { title: input.candidate.text, dueDate: input.candidate.dueDate ?? undefined, categoryName: input.candidate.category }, await this.sourceGuard(input))),
      updateFinance: async (id, version, input) => {
        const after = await finance.updateDiaryRecord(id, version, {
          kind: input.candidate.kind, amountCents: input.candidate.amountCents, date: input.candidate.date,
          merchant: input.candidate.merchant, category: input.candidate.category, description: input.candidate.description ?? ""
        }, await this.sourceGuard(input));
        return financeReceipt(after);
      },
      updateTodo: async (_id, version, input) => todoReceipt(await plugin.getTodoStore().updateFromDiary(input.extractionId, version,
        { title: input.candidate.text, dueDate: input.candidate.dueDate ?? undefined, categoryName: input.candidate.category }, await this.sourceGuard(input))),
      findFinance: async extractionId => { const record = await finance.findDiaryRecord(extractionId); return record ? financeReceipt(record) : null; },
      findTodo: async extractionId => { const record = await plugin.getTodoStore().getByDiaryEntryId(extractionId); return record ? todoReceipt(record) : null; },
      undoFinance: async (id, version) => {
        guard();
        const record = (await finance.readDiarySnapshot()).records.find(record => record.entry.id === id);
        if (!record) return { deleted: true };
        if (record.version !== version) return { deleted: false, current: financeReceipt(record) };
        await finance.undoDiaryRecord(id, version, false, guard);
        return { deleted: !(await finance.readDiarySnapshot()).records.some(record => record.entry.id === id) };
      },
      undoTodo: async (id, version) => {
        guard();
        const record = (await plugin.getTodoStore().readOnlySnapshot()).records.find(record => record.id === id);
        if (!record) return { deleted: true };
        if (!record.diaryEntryId) throw new Error("这条待办缺少日记来源。");
        const current = await plugin.getTodoStore().getByDiaryEntryId(record.diaryEntryId);
        if (!current) return { deleted: true };
        if (current.version !== version) return { deleted: false, current: todoReceipt(current) };
        const result = await plugin.getTodoStore().undoFromDiary(record.diaryEntryId, version, false, guard);
        return { deleted: result.removed };
      },
      now, onChange: () => plugin.notifyHomeSurfacesChanged(),
      log: (message, error) => console.warn(`EchoInk journal organizer: ${message}`, error instanceof Error ? error.message : "")
    };
    this.engine = new DiaryOrganizerEngine(this.ports, options);
    const changed = (path: string) => this.sourceGenerations.set(path, (this.sourceGenerations.get(path) ?? 0) + 1);
    plugin.registerEvent(app.vault.on("modify", file => changed(file.path)));
    plugin.registerEvent(app.vault.on("create", () => { void this.refreshJournalAvailability(); }));
    plugin.registerEvent(app.vault.on("delete", file => changed(file.path)));
    plugin.registerEvent(app.vault.on("rename", (file, oldPath) => {
      changed(oldPath); changed(file.path);
      if (file instanceof TFile) void this.engine.renameDiary(oldPath, file.path).catch(error => console.warn("Journal rename could not be saved", error));
    }));
  }

  get running(): boolean { return this.engine.running; }
  async initialize(): Promise<void> {
    await this.engine.initialize();
    if (this.plugin.settings.diaryOrganizerEnabled) await this.engine.enable();
    await this.refreshJournalAvailability();
    this.scheduler = new DiaryOrganizerScheduler(this.engine, { onError: error => console.warn("Journal organizer check failed", error instanceof Error ? error.message : "") });
    this.scheduler.start();
  }
  async setEnabled(enabled: boolean): Promise<void> {
    const previous = this.plugin.settings.diaryOrganizerEnabled;
    this.plugin.settings.diaryOrganizerEnabled = enabled;
    try { await this.plugin.saveSettings(); }
    catch (error) { this.plugin.settings.diaryOrganizerEnabled = previous; throw error; }
    if (enabled) await this.engine.enable();
    this.plugin.notifyHomeSurfacesChanged();
  }
  dispose(): void { this.disposed = true; this.scheduler?.stop(); this.engine.dispose(); }

  private async refreshJournalAvailability(): Promise<void> {
    try { this.hasJournals = (await this.data.buildJournalRecords()).records.length > 0; this.plugin.notifyHomeSurfacesChanged(); }
    catch { /* The existing journal settings surface explains an invalid directory. */ }
  }

  private financeInput(input: DiaryWriteInput<DiaryFinanceCandidate>) {
    const item = input.candidate;
    return { kind: item.kind, date: item.date, amountCents: item.amountCents, currency: item.currency,
      merchant: item.merchant, category: item.category, description: item.description ?? "", note: item.quote,
      account: "", status: "completed" as const, reviewedDistinct: input.reviewedDistinct };
  }
  private async sourceGuard(input: DiaryWriteInput<DiaryCandidate>): Promise<() => void> {
    const generation = this.sourceGenerations.get(input.diaryPath) ?? 0;
    const source = await this.ports.readDiary(input.diaryPath);
    if (source === null || diaryFingerprint(source) !== input.sourceFingerprint) throw new Error("日记已改变，等待重新整理。");
    return () => {
      if (this.disposed || !this.plugin.settings.diaryOrganizerEnabled) throw new Error("日记自动整理已关闭。");
      if ((this.sourceGenerations.get(input.diaryPath) ?? 0) !== generation) throw new Error("日记已改变，等待重新整理。");
    };
  }
}
