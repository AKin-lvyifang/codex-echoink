import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TFile, type EventRef } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { AgentModuleId } from "../agents/types";
import { hasProPluginAccess } from "../membership/access";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeLinkHealthService, validWorkbenchBindingRoots, type KnowledgeLinkHealth } from "../knowledge-base/link-health";
import { rawDigestFingerprint, rawDigestRecordFromMarkdown, readRawDigestRegistry, type RawDigestFrontmatterRecord } from "../knowledge-base/raw-digest";
import { rawDigestStateForRecord } from "../knowledge-base/digest-status";
import type { DomainReceipt } from "../harness/pi-native/domain-receipt-store";
import { parseTodoMarkdown } from "./todo-markdown";
import { nativeJournalPathForDate, readNativeJournalSettings, takePreparedNativeJournalTemplate } from "./native-journal";
import { journalContentLines, readWorkbenchJournalDay, recordWorkbenchJournalTemplate, type WorkbenchJournalDay } from "./workbench-journal";
import { calculateWorkbenchSignals, nextWorkbenchRefreshAt, type WorkbenchFacts, type WorkbenchSourceFile } from "./workbench-signals";
import { getWorkbenchRecordStore, localWorkbenchDate, validWorkbenchDate, workbenchFingerprint, workbenchWeekKey, type WorkbenchRecordStore, type WorkbenchRecords } from "./workbench-records";
import type { WorkbenchDataPort, WorkbenchSnapshot, WorkbenchTaskSource } from "./workbench-types";

type WorkbenchHost = Pick<CodexForObsidianPlugin, "app" | "settings" | "manifest" | "accountService" | "lifestyle" | "pdfReading" | "getVaultPath" | "getPluginDataDirName" | "listPiConversations" | "readPiConversationCatalogEntry" | "getKnowledgeSurfaceService"> & {
  readWorkbenchTaskReceipts?(taskId: string): Promise<readonly DomainReceipt[]>;
};
const instances = new WeakMap<object, WorkbenchDataService>();
const visiblePath = (target: string): boolean => !target.split("/").some(part => part.startsWith("."));
const sourceExtension = /\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/iu;
const safeRelativePath = (value: unknown): value is string => typeof value === "string" && !!value && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => part === "." || part === ".." || !part);
const scopeKey = (roots: readonly string[]): string => workbenchFingerprint([...roots].sort().join("\n")).slice(0, 24);
interface CachedSourceContent {
  fingerprint: string;
  rawFingerprint: string;
  rawDigest: RawDigestFrontmatterRecord | null;
}

export function getWorkbenchDataService(plugin: WorkbenchHost): WorkbenchDataService {
  let service = instances.get(plugin);
  if (!service) { service = new WorkbenchDataService(plugin); instances.set(plugin, service); }
  return service;
}

export class WorkbenchDataService implements WorkbenchDataPort {
  private readonly records: WorkbenchRecordStore;
  private readonly links: KnowledgeLinkHealthService;
  private readonly ready: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly releases: Array<() => void> = [];
  private readonly subscribed = new WeakSet<object>();
  private readonly eventRefs: Array<{ offref(ref: EventRef): void; ref: EventRef }> = [];
  private initializationError: unknown;
  private eventError: string | undefined;
  private disposed = false;
  private observationQueue: Promise<unknown> = Promise.resolve();
  private readonly sourceContent = new Map<string, { mtime: number; size: number; result: Promise<CachedSourceContent> }>();
  constructor(private readonly plugin: WorkbenchHost) {
    this.records = getWorkbenchRecordStore(plugin.getVaultPath(), plugin.getPluginDataDirName());
    this.links = new KnowledgeLinkHealthService(plugin.app);
    this.ready = this.initialize().catch(error => { this.initializationError = error; });
  }
  loadKnowledgeLinkHealth(bindings: KnowledgeFolderBindings): Promise<KnowledgeLinkHealth> { return this.links.load(bindings); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed = (): void => { if (!this.disposed) for (const listener of this.listeners) listener(); };
  private get bindings(): KnowledgeFolderBindings | null { return this.plugin.settings.knowledgeBase.folderBindings ?? null; }
  private roots(role: keyof KnowledgeFolderBindings["roles"]): string[] {
    return this.bindings ? validWorkbenchBindingRoots(this.plugin.app, this.bindings, role) : [];
  }
  private inboxFiles(): TFile[] {
    return this.plugin.app.vault.getFiles().filter(file => this.isInboxPath(file.path));
  }
  private isInboxPath(target: string): boolean {
    const bindings = this.bindings;
    return !!bindings && visiblePath(target) && this.roots("inbox").some(root => target.startsWith(`${root}/`))
      && classifyKnowledgePath(bindings, target) === "inbox" && !bindings.roles.assets.readPaths.some(root => target.startsWith(`${root}/`));
  }
  private async fingerprint(file: TFile): Promise<string> {
    return (await this.readSourceContent(file)).fingerprint;
  }
  private async readSourceContent(file: TFile): Promise<CachedSourceContent> {
    const target = file.path, { mtime, size } = file.stat, previous = this.sourceContent.get(target);
    if (previous?.mtime === mtime && previous.size === size) return previous.result;
    const result = this.plugin.app.vault.readBinary(file).then(content => {
      const bytes = Buffer.from(content);
      return { fingerprint: workbenchFingerprint(bytes), rawFingerprint: rawDigestFingerprint(target, bytes),
        rawDigest: /\.(?:md|markdown)$/iu.test(target) ? rawDigestRecordFromMarkdown(bytes) : null };
    });
    const cached = { mtime, size, result };
    this.sourceContent.set(target, cached);
    try { return await result; }
    catch (error) { if (this.sourceContent.get(target) === cached) this.sourceContent.delete(target); throw error; }
  }
  private invalidateSourceContent(target: string, subtree = false): void {
    this.sourceContent.delete(target);
    if (subtree) for (const cached of this.sourceContent.keys()) if (cached.startsWith(`${target}/`)) this.sourceContent.delete(cached);
  }
  private async initialize(): Promise<void> {
    await this.records.snapshot();
    await this.observeInbox(Date.now());
    if (this.disposed) return;
    const vault = this.plugin.app.vault, cache = this.plugin.app.metadataCache;
    const addVaultEvent = (ref: EventRef) => this.eventRefs.push({ offref: value => vault.offref(value), ref });
    const enqueue = (work: () => Promise<void>) => {
      const run = async () => { await work(); this.eventError = undefined; this.changed(); };
      this.observationQueue = this.observationQueue.then(run, run).catch(error => {
        this.eventError = `收件箱观察失败：${message(error)}`; this.changed();
      });
    };
    const onFile = (file: { path: string }, kind: "create" | "modify" | "delete") => {
      const observedAt = Date.now(), target = file.path;
      this.invalidateSourceContent(target, !(file instanceof TFile));
      if (this.roots("inbox").some(root => target === root || target.startsWith(`${root}/`) || root.startsWith(`${target}/`))) enqueue(() => this.observeInboxFile(target, kind, observedAt));
      else this.changed();
    };
    addVaultEvent(vault.on("create", file => {
      const template = takePreparedNativeJournalTemplate(this.plugin.app, file.path);
      if (template !== undefined) enqueue(async () => {
        if (!(file instanceof TFile)) return;
        const content = await vault.read(file), actual = journalContentLines(content, true);
        const expected = journalContentLines(template, true);
        for (const line of expected) {
          const index = actual.indexOf(line);
          if (index < 0) return; // The created file did not preserve this exact template context.
          actual.splice(index, 1);
        }
        await recordWorkbenchJournalTemplate(this.plugin.app, file.path, template);
      });
      onFile(file, "create");
    }));
    addVaultEvent(vault.on("modify", file => onFile(file, "modify")));
    addVaultEvent(vault.on("delete", file => onFile(file, "delete")));
    addVaultEvent(vault.on("rename", (file, oldPath) => {
      const newPath = file.path, observedAt = Date.now();
      this.invalidateSourceContent(oldPath, !(file instanceof TFile));
      this.invalidateSourceContent(newPath, !(file instanceof TFile));
      enqueue(async () => {
        await this.observeInboxRename(oldPath, newPath);
        await this.observeInboxFile(oldPath, "delete", observedAt);
        await this.observeInboxFile(newPath, "create", observedAt);
      });
    }));
    this.eventRefs.push({ offref: ref => cache.offref(ref), ref: cache.on("resolved", this.changed) });
    this.subscribeSources();
  }
  private subscribeSources(): void {
    if (this.disposed) return;
    const bind = (source: object | null | undefined, subscribe: () => () => void) => {
      if (!source || this.subscribed.has(source)) return;
      this.subscribed.add(source); this.releases.push(subscribe());
    };
    bind(this.plugin.accountService, () => this.plugin.accountService!.subscribe(this.changed));
    // Lifestyle can still be initializing when the desktop plugin constructs this service.
    bind(this.plugin.lifestyle?.store, () => this.plugin.lifestyle.store.subscribe(this.changed));
    bind(this.plugin.lifestyle?.finance, () => this.plugin.lifestyle.finance.subscribeEntries(this.changed));
    bind(this.plugin.pdfReading?.api, () => this.plugin.pdfReading!.api.subscribe(this.changed));
  }
  private async observeInbox(now: number): Promise<WorkbenchSourceFile[]> {
    if (!this.plugin.app.workspace.layoutReady) return [];
    const roots = this.roots("inbox");
    if (!roots.length) return [];
    const files: WorkbenchSourceFile[] = [];
    // A failed read cannot establish absence or a first-observation baseline.
    for (const file of this.inboxFiles()) files.push({ path: file.path, fingerprint: await this.fingerprint(file) });
    const scope = scopeKey(roots);
    await this.records.update(draft => {
      const previous = draft.inbox[scope], initial = !previous;
      const state = previous ?? { observedAt: now, entries: {} };
      const oldPresence = new Set(Object.entries(state.entries).filter(([, item]) => item.present).map(([target]) => target));
      for (const entry of Object.values(state.entries)) entry.present = false;
      for (const file of files) {
        const old = state.entries[file.path];
        state.entries[file.path] = old && oldPresence.has(file.path)
          ? { ...old, present: true, fingerprint: file.fingerprint }
          : { fingerprint: file.fingerprint, present: true, ...(!initial ? { enteredAt: now } : {}),
            ...(old?.processed?.fingerprint === file.fingerprint ? { processed: old.processed } : {}) };
      }
      draft.inbox[scope] = state;
    });
    const saved = (await this.records.snapshot()).inbox[scope];
    return files.filter(file => saved.entries[file.path].enteredAt !== undefined && saved.entries[file.path].processed?.fingerprint !== file.fingerprint)
      .map(file => ({ ...file, enteredAt: saved.entries[file.path].enteredAt }));
  }
  /** Native events touch only their file/subtree; full reconciliation runs on foreground load. */
  private async observeInboxFile(target: string, kind: "create" | "modify" | "delete", observedAt: number): Promise<void> {
    if (!this.plugin.app.workspace.layoutReady) return;
    const scope = scopeKey(this.roots("inbox"));
    if (!(await this.records.snapshot()).inbox[scope]) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(target);
    const affected = kind === "delete" ? [] : file instanceof TFile ? [file] : this.plugin.app.vault.getFiles().filter(item => item.path.startsWith(`${target}/`));
    const incoming: WorkbenchSourceFile[] = [];
    for (const item of affected) if (this.isInboxPath(item.path)) incoming.push({ path: item.path, fingerprint: await this.fingerprint(item) });
    await this.records.update(draft => {
      const state = draft.inbox[scope];
      if (!state) return;
      if (kind === "delete") for (const [relative, entry] of Object.entries(state.entries)) if (relative === target || relative.startsWith(`${target}/`)) entry.present = false;
      for (const item of incoming) {
        const previous = state.entries[item.path];
        state.entries[item.path] = { ...previous, fingerprint: item.fingerprint, present: true,
          ...(!previous?.present ? { enteredAt: observedAt } : {}) };
      }
    });
  }
  private async observeInboxRename(oldPath: string, newPath: string): Promise<void> {
    const now = Date.now(), snapshot = await this.records.snapshot(), roots = this.roots("inbox"), scope = scopeKey(roots);
    const state = snapshot.inbox[scope];
    if (!state) return;
    const bindings = this.bindings;
    const stillInbox = bindings && classifyKnowledgePath(bindings, newPath) === "inbox";
    for (const [old, entry] of Object.entries(state.entries)) {
      if (!entry.present || old !== oldPath && !old.startsWith(`${oldPath}/`)) continue;
      const target = newPath + old.slice(oldPath.length), file = this.plugin.app.vault.getAbstractFileByPath(target);
      if (!(file instanceof TFile) || await this.fingerprint(file) !== entry.fingerprint) continue;
      await this.records.update(draft => {
        const original = draft.inbox[scope]?.entries[old];
        if (!original || original.fingerprint !== entry.fingerprint) return;
        original.present = false;
        if (stillInbox) draft.inbox[scope].entries[target] = { ...original, present: true };
        else original.processed = { fingerprint: entry.fingerprint, completedAt: now, resultPath: target };
      });
    }
  }
  async load(now = Date.now()): Promise<WorkbenchSnapshot> {
    await this.ready; await this.observationQueue;
    this.subscribeSources();
    const issues: string[] = [], today = localWorkbenchDate(now), modules: AgentModuleId[] = ["todos", "review"];
    const attempt = async <T>(label: string, fallback: T, read: () => Promise<T>): Promise<T> => {
      try { return await read(); } catch (error) { issues.push(`${label}：${message(error)}`); return fallback; }
    };
    if (!this.plugin.app.workspace.layoutReady) issues.push("工作区仍在加载，部分本地数据尚未就绪");
    if (this.initializationError) issues.push(`工作台观察记录：${message(this.initializationError)}`);
    if (this.eventError) issues.push(this.eventError);
    const records = await attempt<WorkbenchRecords | null>("本地记录读取失败", null, () => this.records.snapshot());
    const pro = this.plugin.accountService ? hasProPluginAccess(this.plugin.accountService) : false;
    const bindings = this.bindings;
    let journalAvailable = false;
    try { journalAvailable = (!bindings || bindings.roles.journal.enabled) && readNativeJournalSettings(this.plugin.app, this.plugin.settings.journalDirectory, bindings).available; }
    catch (error) { issues.push(`日记配置：${message(error)}`); }
    if (journalAvailable) modules.push("journal");
    if (["raw", "wiki", "projects", "inbox"].some(role => this.roots(role as "raw").length)) modules.push("knowledge-base");
    if (pro && this.plugin.settings.lifestyle.finance.enabled) modules.push("finance");
    if (pro && this.plugin.settings.englishDiary.enabled) modules.push("english-diary");
    if (pro && this.plugin.settings.pdfReading.enabled) modules.push("pdf-reading");
    const tasks = await attempt("任务读取失败", [], () => this.plugin.listPiConversations(["active"]));
    const todos = await attempt("待办读取失败", [], async () => {
      const file = this.plugin.app.vault.getAbstractFileByPath("EchoInk/待办.md");
      return file instanceof TFile ? parseTodoMarkdown(await this.plugin.app.vault.read(file)).records : [];
    });
    const facts: WorkbenchFacts = { now, modules, tasks, todos, journals: [], englishMissing: null, inbox: [],
      inboxScope: scopeKey(this.roots("inbox")), raw: [], rawScope: scopeKey(this.roots("raw")), pdfJobs: [], reviewComplete: null,
      isolated: null, knowledgeScope: scopeKey([...this.roots("wiki"), ...this.roots("projects")]), language: this.plugin.settings.settingsLanguage };
    if (modules.includes("finance") && this.plugin.app.workspace.layoutReady) facts.finance = await attempt("财务读取失败", undefined, async () => {
      const records = await this.plugin.lifestyle.finance.ledger.readSnapshots(), data = await this.plugin.lifestyle.store.readFresh();
      const errors = this.plugin.lifestyle.finance.ledger.issues();
      issues.push(...errors.map(error => `财务：${error.path}：${error.reason}`));
      return { entries: records.map(record => record.entry), data };
    });
    if (journalAvailable && this.plugin.app.workspace.layoutReady) {
      const dates = [0, 1, 2].map(offset => { const date = new Date(now); date.setDate(date.getDate() - offset); return date; });
      for (const date of dates) {
        const day = await attempt<WorkbenchJournalDay>("日记配置读取失败", { state: "unknown", path: "", text: "", reason: "日期配置无法读取" }, async () => {
          const targetPath = nativeJournalPathForDate(this.plugin.app, date, this.plugin.settings.journalDirectory, bindings);
          return readWorkbenchJournalDay(this.plugin.app, date, { legacyDirectory: this.plugin.settings.journalDirectory, bindings, baseline: records?.journals[targetPath] });
        });
        facts.journals = [...facts.journals, day];
        if (day.state === "unknown" && day.reason !== "旧日记缺少可核实的初始模板") issues.push(`日记：${day.reason}`);
      }
      if (new Set(facts.journals.map(day => day.path)).size !== 3) {
        facts.journals = []; issues.push("日记日期格式无法区分日期");
      }
    }
    if (modules.includes("english-diary") && facts.journals[0]?.state === "body") facts.englishMissing = await attempt("英文日记关联读取失败", null,
      () => this.readEnglishMissing(facts.journals[0].path));
    if (modules.includes("knowledge-base") && !this.initializationError) facts.inbox = await attempt("收件箱读取失败", [], () => this.observeInbox(now));
    if (modules.includes("knowledge-base")) {
      facts.raw = await attempt("来源状态读取失败", [], () => this.readPendingRaw(issues));
      if (bindings) {
        const health = await attempt<KnowledgeLinkHealth | null>("笔记链接读取失败", null, () => this.loadKnowledgeLinkHealth(bindings));
        if (health?.state === "ready") facts.isolated = health.isolatedPaths;
        else if (health?.reason) issues.push(health.reason);
      }
    }
    if (modules.includes("pdf-reading")) facts.pdfJobs = await attempt("PDF 历史读取失败", [], async () => {
      if (!this.plugin.pdfReading) throw new Error("PDF 本地服务尚未就绪");
      return this.plugin.pdfReading.api.history();
    });
    if (records) facts.reviewComplete = await attempt("复盘记录读取失败", null, () => this.hasReviewThisWeek(records, now));
    return { generatedAt: now, signals: calculateWorkbenchSignals(facts), todayTodos: todos.filter(todo => !todo.done && todo.dueDate === today),
      modules, issues, nextRefreshAt: nextWorkbenchRefreshAt(facts) };
  }
  private async readPendingRaw(issues: string[]): Promise<WorkbenchSourceFile[]> {
    const bindings = this.bindings, roots = this.roots("raw");
    if (!bindings || !roots.length) return [];
    const registry = await readRawDigestRegistry(this.plugin.getVaultPath(), true);
    const maintenance = await this.plugin.getKnowledgeSurfaceService()?.getMaintenanceRecords() ?? [];
    const sources = new Map<string, { fingerprint: string; status: string }>();
    for (const record of [...maintenance].sort((a, b) => b.at - a.at)) for (const source of record.sources) if (!sources.has(source.path)) sources.set(source.path, source);
    const result: WorkbenchSourceFile[] = [];
    let batch = 0;
    for (const file of this.plugin.app.vault.getFiles()) {
      if (!visiblePath(file.path) || !sourceExtension.test(file.path) || /(?:^|\/)index\.(?:md|markdown)$/iu.test(file.path) || /\.base\.md$/iu.test(file.path)
        || classifyKnowledgePath(bindings, file.path) !== "raw" || !roots.some(root => file.path.startsWith(`${root}/`))
        || bindings.roles.assets.readPaths.some(root => file.path.startsWith(`${root}/`))) continue;
      try {
        const content = await this.readSourceContent(file), fingerprint = content.rawFingerprint;
        const state = rawDigestStateForRecord({ fingerprint, frontmatter: content.rawDigest,
          previous: this.plugin.settings.knowledgeBase.processedSources[file.path], registry: registry.entries[file.path], hasTrackerHint: false });
        const latest = sources.get(file.path), same = latest?.fingerprint === fingerprint;
        if (same ? latest.status !== "processed" : state !== "digested") result.push({ path: file.path, fingerprint });
      } catch (error) { issues.push(`来源暂不可读取：${file.path}：${message(error)}`); }
      if (++batch % 32 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return result;
  }
  private async readEnglishMissing(sourcePath: string): Promise<boolean> {
    const directory = path.join(this.plugin.getVaultPath(), this.plugin.app.vault.configDir, "plugins", this.plugin.manifest.id, "english-diary");
    let files: string[];
    try { files = await fsp.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    for (const name of files.filter(name => /^[a-f0-9]{24}\.json$/u.test(name))) {
      const saved = JSON.parse(await fsp.readFile(path.join(directory, name), "utf8")) as { schema?: number; sourcePath?: string; englishPath?: string; result?: unknown; transaction?: unknown };
      if (saved.schema !== 1 || !safeRelativePath(saved.sourcePath) || !safeRelativePath(saved.englishPath)) throw new Error("英文稿关联记录格式无效");
      if (saved.sourcePath !== sourcePath) continue;
      if (saved.transaction) throw new Error("英文稿保存正在核对");
      if (!saved.result) continue;
      let english: string;
      try { english = await fsp.readFile(path.join(this.plugin.getVaultPath(), saved.englishPath), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (journalContentLines(english).length) return false;
    }
    return true;
  }
  private async hasReviewThisWeek(records: WorkbenchRecords, now: number): Promise<boolean> {
    const week = workbenchWeekKey(now);
    if (records.reviews[week]) return true;
    for (const [kind, state] of [["knowledge-base", this.plugin.settings.review.reports.knowledgeBase], ["agent-chat", this.plugin.settings.review.reports.agentChat]] as const) {
      const range = /^(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})$/u.exec(state.lastRangeKey);
      if (!range || range[1] !== week || !validWorkbenchDate(range[2]) || workbenchWeekKey(new Date(`${range[2]}T12:00:00`)) !== week) continue;
      const root = this.plugin.settings.review.outputDir.trim().replace(/^\.\/$/u, "").replace(/\/$/u, "");
      const target = `${root ? `${root}/` : ""}${kind}-review-${state.lastRangeKey}.md`;
      if (!safeRelativePath(target)) throw new Error("复盘输出路径无效");
      let report: string;
      try { report = await fsp.readFile(path.join(this.plugin.getVaultPath(), target), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (report.trim()) {
        await this.records.update(draft => { draft.reviews[week] = { outputPath: target, completedAt: now }; });
        return true;
      }
    }
    return false;
  }
  async recordTaskAccepted(taskId: string, source: WorkbenchTaskSource): Promise<void> {
    await this.ready;
    if (!taskId || source.version !== 1) throw new Error("工作台任务来源无效");
    await this.records.update(draft => { draft.tasks[taskId] = { source: structuredClone(source), acceptedAt: source.capturedAt }; });
    this.changed();
  }
  async recordTaskCompleted(taskId: string): Promise<void> {
    await this.ready; await this.observationQueue;
    const saved = (await this.records.snapshot()).tasks[taskId];
    if (!saved) return;
    const task = await this.plugin.readPiConversationCatalogEntry(taskId);
    if (task?.taskStatus !== "completed") return;
    const source = saved.source, receipts = await this.plugin.readWorkbenchTaskReceipts?.(taskId) ?? [];
    if (source.signalId === 9 && source.moduleId === "review") {
      const week = source.objects[0];
      if (validWorkbenchDate(week)) for (const receipt of receipts) {
        const target = receiptOutputPath(receipt);
        if (!target || !/\.(?:md|markdown)$/iu.test(target) || receipt.recordedAt < saved.acceptedAt) continue;
        const file = this.plugin.app.vault.getAbstractFileByPath(target);
        if (file instanceof TFile && journalContentLines(await this.plugin.app.vault.read(file)).length) {
          await this.records.update(draft => { draft.reviews[week] = { completedAt: receipt.recordedAt, outputPath: target, taskId }; });
          break;
        }
      }
    }
    if (source.signalId === 6) {
      // A task ending does not process all its inputs. Only a verified move can close each exact version.
      for (const original of source.objects) {
        const fingerprint = source.versions?.[original];
        if (!fingerprint) continue;
        const current = this.plugin.app.vault.getAbstractFileByPath(original);
        if (current instanceof TFile && await this.fingerprint(current) === fingerprint) continue;
        for (const receipt of receipts) {
          const target = receiptOutputPath(receipt, true);
          const file = target ? this.plugin.app.vault.getAbstractFileByPath(target) : null;
          if (!(file instanceof TFile) || !target || receipt.recordedAt < saved.acceptedAt || await this.fingerprint(file) !== fingerprint
            || this.bindings && classifyKnowledgePath(this.bindings, target) === "inbox") continue;
          await this.records.update(draft => {
            for (const state of Object.values(draft.inbox)) {
              const entry = state.entries[original];
              if (entry?.fingerprint === fingerprint) entry.processed = { fingerprint, completedAt: receipt.recordedAt, resultPath: target };
            }
          });
        }
      }
    }
    this.changed();
  }
  dispose(): void {
    this.disposed = true;
    this.links.dispose();
    this.releases.splice(0).forEach(release => release());
    this.eventRefs.splice(0).forEach(({ offref, ref }) => offref(ref));
    this.listeners.clear(); instances.delete(this.plugin);
    this.sourceContent.clear();
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function receiptOutputPath(receipt: DomainReceipt, allowMove = false): string | null {
  if (receipt.status !== "completed" || !receipt.readback.readbackVerified) return null;
  if (!["note_create", "note_update", "obsidian_cli", ...(allowMove ? ["note_move"] : [])].includes(receipt.toolId)) return null;
  const target = receipt.resolvedTarget as Record<string, unknown> | null;
  const observed = receipt.readback.observedTargetVersion as Record<string, unknown> | null;
  const candidates: unknown[] = [];
  if (target && typeof target === "object" && !Array.isArray(target)) {
    if (typeof target.command === "string" && !["create", "append", "prepend", "daily:append", "daily:prepend", ...(allowMove ? ["rename", "move"] : [])].includes(target.command)) return null;
    candidates.push(target.path, target.dailyPath, target.to, target.destinationPath);
  }
  if (observed && typeof observed === "object" && !Array.isArray(observed)) candidates.push(observed.path, observed.recordPath);
  return candidates.find(safeRelativePath) ?? null;
}
