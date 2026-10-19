import { TFile, parseYaml, type App, type EventRef } from "obsidian";
import { GENERAL_ASSISTANT_ID, type AgentModuleId } from "../agents/types";
import type { TaskDraft } from "../agents/task-workspace";
import { classifyKnowledgePath } from "../knowledge-base/folder-bindings";
import { resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import { KnowledgeLinkHealthService, validWorkbenchBindingRoots } from "../knowledge-base/link-health";
import { hasProPluginAccess } from "../membership/access";
import { nativeJournalPathForDate, readNativeJournalContext, readNativeJournalSettings } from "../home/native-journal";
import { calculateWorkbenchSignals, nextWorkbenchRefreshAt, type WorkbenchFacts, type WorkbenchSourceFile } from "../home/workbench-signals";
import { localWorkbenchDate, parseMobileWorkbenchSource, validWorkbenchDate, workbenchWeekKey } from "../home/workbench-source";
import type { WorkbenchSnapshot, WorkbenchSignal } from "../home/workbench-types";
import type { WorkbenchJournalDay } from "../home/workbench-journal";
import type { WorkbenchRecords } from "../home/workbench-records";
import { sha256Hex } from "../utils/sha256";
import type { MobileWorkbenchPort } from "./workbench-contract";
import type { MobileStore } from "./store";
import type { MobileSettings } from "./settings";
import type { MobileServices } from "./services";
import type { MobileRuntime } from "./runtime";
import { readMobileFile, replaceMobileFile } from "./replace-file";

/** Null is deliberately preserved at the acquisition boundary; it never becomes a count of zero. */
export interface MobileWorkbenchFacts extends Omit<WorkbenchFacts, "todos" | "inbox" | "raw" | "finance"> {
  todos: WorkbenchFacts["todos"] | null;
  inbox: WorkbenchFacts["inbox"] | null;
  raw: WorkbenchFacts["raw"] | null;
  finance: NonNullable<WorkbenchFacts["finance"]> | null;
  issues: string[];
  versions: Record<string, string>;
}
type Observations = { version: 1; scopes: Record<string, { entries: Record<string, { fingerprint: string; enteredAt?: number }> }> };
type InboxEvent = { scope: string; at: number } & ({ kind: "create" | "delete"; path: string }
  | { kind: "rename"; from: string; to: string; preserve: boolean; entered: boolean });
const visible = (path: string) => !path.split("/").some(part => part.startsWith("."));
const safePath = (path: unknown): path is string => typeof path === "string" && !!path && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => !part || part === "." || part === "..");
const scopeKey = (paths: readonly string[]) => sha256Hex([...paths].sort().join("\n")).slice(0, 24);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const objectRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
// Same content semantics as workbench-journal; the desktop reader owns a Node record store.
function contentLines(content: string, keepHeadings = false): string[] {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, "")
    .replace(/<!--[\s\S]*?-->/gu, "").split("\n").map(line => line.trim())
    .filter(line => line && (keepHeadings ? !/^#{1,6}\s*\d{4}[-/]\d{2}[-/]\d{2}\s*$/u.test(line) : !/^#{1,6}(?:\s|$)/u.test(line))
      && !/^(?:[-*_]\s*){3,}$/u.test(line) && !/^[-+*]\s*(?:\[[ xX]\])?\s*$/u.test(line) && !/^\|[\s:|-]*\|$/u.test(line));
}
function canonicalRaw(text: string): string {
  const normalized = text.replace(/\r\n/gu, "\n");
  const match = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/u.exec(normalized);
  return (match ? normalized.slice(match[0].length) : text).replace(/^\r?\n/u, "");
}

/** Mobile facts and unsent handoff. Task admission remains exclusively in MobileRuntime. */
export class MobileWorkbenchService implements MobileWorkbenchPort {
  refreshTasks(): void { this.notify(); }
  private readonly listeners = new Set<() => void>();
  private readonly releases: Array<() => void> = [];
  private readonly refs: Array<{ offref(ref: EventRef): void; ref: EventRef }> = [];
  private readonly bound = new WeakSet<object>();
  private readonly links: KnowledgeLinkHealthService;
  private cached?: { signature: string; until: number; facts: MobileWorkbenchFacts };
  private flight?: Promise<MobileWorkbenchFacts>;
  private generation = 0;
  private disposed = false;
  private taskProjection = "";
  private observationQueue: Promise<unknown> = Promise.resolve();
  private readonly inboxEvents: InboxEvent[] = [];
  constructor(private readonly app: App, private readonly store: MobileStore,
    private readonly settings: () => MobileSettings, private readonly services: () => MobileServices,
    runtime?: Pick<MobileRuntime, "subscribe">) {
    this.links = new KnowledgeLinkHealthService(app);
    if (runtime) this.releases.push(runtime.subscribe(() => {
      const next = JSON.stringify(store.state.sessions.map(task => [task.id, task.businessKey, task.taskStatus, task.pendingResponse, task.archivedAt]));
      if (next !== this.taskProjection) { this.taskProjection = next; this.notify(); }
    }));
    const vault = app.vault, cache = app.metadataCache;
    const event = (ref: EventRef) => this.refs.push({ offref: value => vault.offref(value), ref });
    event(vault.on("create", file => {
      if (this.inRole(file.path, "inbox")) this.inboxEvents.push({ kind: "create", path: file.path, scope: scopeKey(this.roots("inbox")), at: Date.now() });
      this.invalidate();
    }));
    event(vault.on("modify", file => { if (!file.path.includes("/mobile/") || file.path.endsWith("lifestyle.json")) this.invalidate(); }));
    event(vault.on("delete", file => {
      if (this.inRole(file.path, "inbox")) this.inboxEvents.push({ kind: "delete", path: file.path, scope: scopeKey(this.roots("inbox")), at: Date.now() });
      this.invalidate();
    }));
    event(vault.on("rename", (file, old) => {
      const before = this.inRole(old, "inbox"), entered = this.inRole(file.path, "inbox");
      if (before || entered) this.inboxEvents.push({ kind: "rename", from: old, to: file.path,
        preserve: before && entered, entered, scope: scopeKey(this.roots("inbox")), at: Date.now() });
      this.invalidate();
    }));
    const metadataEvent = (ref: EventRef) => this.refs.push({ offref: value => cache.offref(value), ref });
    metadataEvent(cache.on("resolved", () => this.invalidate()));
    metadataEvent(cache.on("changed", () => this.invalidate()));
    metadataEvent(cache.on("deleted", () => this.invalidate()));
    this.bindSources();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* Other views still receive invalidation. */ } } }
  /** Host calls on foreground/settings changes; file and domain updates also invalidate. */
  invalidate(): void { this.generation++; this.cached = undefined; this.notify(); }
  private bindSources(): void {
    const service = this.services();
    const bind = (source: object | undefined, subscribe: () => () => void) => {
      if (!source || this.bound.has(source)) return; this.bound.add(source); this.releases.push(subscribe());
    };
    bind(service.accountService, () => service.accountService!.subscribe(() => this.invalidate()));
    bind(service.getTodoStore(), () => service.getTodoStore().subscribe(() => this.invalidate()));
    bind(service.lifestyle?.store, () => service.lifestyle.store.subscribe(() => this.invalidate()));
    bind(service.lifestyle?.finance, () => {
      const finance = service.lifestyle.finance;
      // Reading snapshots also emits. Only a changed durable projection invalidates facts.
      const projection = () => JSON.stringify([
        [...finance.ledger.entries()].sort((a, b) => a.id.localeCompare(b.id)),
        [...finance.ledger.issues()].sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason))
      ]);
      let previous = projection();
      return finance.subscribeEntries(() => {
        const current = projection();
        if (current === previous) return;
        previous = current; this.invalidate();
      });
    });
  }
  private get root(): string { return this.services().preferencesPath.replace(/\/pi-agent-product-v1\/knowledge\/preferences\.md$/u, ""); }
  private roots(role: "raw" | "wiki" | "projects" | "inbox"): string[] {
    const bindings = this.settings().knowledgeBase.folderBindings;
    if (bindings) return validWorkbenchBindingRoots(this.app, bindings, role);
    if (role === "projects") return [];
    try { return [this.services().knowledgePath(role)]; } catch { return []; }
  }
  private inRole(path: string, role: "raw" | "inbox"): boolean {
    const bindings = this.settings().knowledgeBase.folderBindings;
    return visible(path) && this.roots(role).some(root => path.startsWith(`${root}/`))
      && (!bindings || classifyKnowledgePath(bindings, path) === role)
      && !bindings?.roles.assets.readPaths.some(root => path.startsWith(`${root}/`));
  }
  private async readRecords(): Promise<WorkbenchRecords | null> {
    const text = await readMobileFile(this.app.vault.adapter, `${this.root}/workbench-records.json`);
    if (text === null) return null;
    const value = JSON.parse(text) as WorkbenchRecords;
    if (value?.version !== 1 || !value.inbox || !value.journals || !value.reviews || !value.tasks) throw new Error("工作台记录无法读取，原文件已保留。");
    return value;
  }
  private async source(file: TFile): Promise<WorkbenchSourceFile> {
    const bytes = await this.app.vault.readBinary(file);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return { path: file.path, fingerprint: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
  }
  private observeInbox(now: number): Promise<WorkbenchSourceFile[]> {
    const run = async () => {
      const eventCount = this.inboxEvents.length;
      const adapter = this.app.vault.adapter, path = `${this.services().directory}/workbench-${this.store.state.instanceId}.json`;
      const backupPath = `${path}.replace-backup.json`;
      if (!await adapter.exists(path) && await adapter.exists(backupPath)) await adapter.rename(backupPath, path);
      const text = await readMobileFile(adapter, path), saved = text === null ? { version: 1 as const, scopes: {} } : JSON.parse(text) as Observations;
      if (saved?.version !== 1 || !saved.scopes || typeof saved.scopes !== "object") throw new Error("收件箱观察记录无法读取，原文件已保留。");
      for (const scope of Object.values(saved.scopes)) {
        if (!scope || !scope.entries || typeof scope.entries !== "object") throw new Error("收件箱观察范围无法读取。");
        for (const entry of Object.values(scope.entries)) if (!entry || typeof entry.fingerprint !== "string"
          || entry.enteredAt !== undefined && (!Number.isFinite(entry.enteredAt) || entry.enteredAt < 0)) throw new Error("收件箱观察时间无法读取。");
      }
      const scope = scopeKey(this.roots("inbox")), previous = saved.scopes[scope];
      const observed = new Map(Object.entries(previous?.entries ?? {}).map(([path, entry]) => [path, { entry, moved: false }]));
      const arrivals = new Map<string, number>();
      const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
      // Replay only witnessed changes, in order. A folder rename rebases every observed child.
      for (const event of this.inboxEvents.slice(0, eventCount)) {
        if (event.scope !== scope) continue;
        const from = event.kind === "rename" ? event.from : event.path;
        const moved = [...observed].filter(([path]) => within(path, from));
        const arriving = [...arrivals].filter(([path]) => within(path, from));
        for (const [path] of moved) observed.delete(path);
        for (const [path] of arriving) arrivals.delete(path);
        if (event.kind === "create") arrivals.set(event.path, event.at);
        if (event.kind !== "rename") continue;
        if (event.preserve) {
          for (const [path, value] of moved) observed.set(event.to + path.slice(event.from.length), { entry: value.entry, moved: true });
          for (const [path, at] of arriving) arrivals.set(event.to + path.slice(event.from.length), at);
        }
        if (event.entered && !arriving.length) arrivals.set(event.to, event.at);
      }
      const files = await Promise.all(this.app.vault.getFiles().filter(file => this.inRole(file.path, "inbox")).map(file => this.source(file)));
      const entries: Observations["scopes"][string]["entries"] = {};
      for (const file of files) {
        const observation = observed.get(file.path);
        const old = observation && (!observation.moved || observation.entry.fingerprint === file.fingerprint) ? observation.entry : undefined;
        const arrival = [...arrivals].filter(([path]) => within(file.path, path)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
        entries[file.path] = { fingerprint: file.fingerprint, ...(old?.enteredAt !== undefined ? { enteredAt: old.enteredAt }
          : !old && previous ? { enteredAt: arrival ?? now } : {}) };
      }
      saved.scopes[scope] = { entries }; const bytes = JSON.stringify(saved);
      if (bytes !== text) {
        const backup = text === null ? undefined : backupPath;
        if (await adapter.exists(backupPath)) await adapter.remove(backupPath);
        await replaceMobileFile(adapter, path, bytes, text, backup, () => new Error("收件箱观察记录已变化，请重新读取。"));
        try { if (backup && await adapter.exists(backup)) await adapter.remove(backup); } catch { /* Main copy was installed; leave recovery evidence. */ }
      }
      this.inboxEvents.splice(0, eventCount);
      return files.flatMap(file => entries[file.path].enteredAt === undefined ? [] : [{ ...file, enteredAt: entries[file.path].enteredAt }]);
    };
    const pending = this.observationQueue.then(run, run); this.observationQueue = pending.catch(() => {}); return pending;
  }
  private async journal(date: Date, records: WorkbenchRecords | null, versions: Record<string, string>): Promise<WorkbenchJournalDay> {
    const settings = this.settings(), bindings = settings.knowledgeBase.folderBindings;
    const path = nativeJournalPathForDate(this.app, date, settings.journalDirectory, bindings);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) { versions[path] = "missing"; return { state: "empty", path, text: "" }; }
    if (!(file instanceof TFile)) throw new Error("日记路径被目录占用。");
    const text = await this.app.vault.read(file), lines = contentLines(text, true); versions[path] = sha256Hex(text);
    if (!lines.length) return { state: "empty", path, text: "" };
    const baseline = records?.journals[path];
    if (!baseline) {
      const context = await readNativeJournalContext(this.app, { now: date, legacyDirectory: settings.journalDirectory, bindings });
      const fingerprints = contentLines(context.templateContent, true).map(sha256Hex);
      if (sha256Hex(lines.map(sha256Hex).join("\n")) === sha256Hex(fingerprints.join("\n"))) return { state: "empty", path, text: "" };
      return { state: "unknown", path, text: "", reason: "旧日记缺少可核实的初始模板" };
    }
    if (!Array.isArray(baseline.lines) || baseline.lines.some(line => typeof line !== "string")) throw new Error("日记模板记录无效。");
    const remaining = [...baseline.lines], extra = lines.filter(line => {
      const index = remaining.indexOf(sha256Hex(line)); if (index < 0) return true; remaining.splice(index, 1); return false;
    });
    const prose = extra.join("\n").replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/gu, "").replace(/^#{1,6}\s*/gmu, "")
      .replace(/^\s*(?:[-+*]\s*(?:\[[ xX]\])?|\d+[.)])\s*$/gmu, "").replace(/[|\s]/gu, " ").trim();
    const image = extra.some(line => [...line.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/gu)]
      .some(match => { const target = (match[1] ?? match[2] ?? match[3]).split(/[?#]/u)[0];
        const resolved = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(target) ? this.app.metadataCache.getFirstLinkpathDest(target, path) : null;
        return resolved instanceof TFile; }));
    return { state: prose || image ? "body" : "empty", path, text: prose };
  }
  private async englishMissing(sourcePath: string): Promise<boolean | null> {
    const adapter = this.app.vault.adapter, directory = `${this.root}/english-diary`;
    if (!await adapter.exists(directory)) return null; // No connected English evidence is not proof of no draft.
    for (const path of (await adapter.list(directory)).files.filter(path => /\/[a-f0-9]{24}\.json$/u.test(path))) {
      const record: unknown = JSON.parse(await adapter.read(path));
      if (!objectRecord(record) || record.schema !== 1 || !safePath(record.sourcePath) || !safePath(record.englishPath)) throw new Error("英文稿关联记录无效。");
      if (record.sourcePath !== sourcePath) continue;
      if (record.transaction) throw new Error("英文稿保存正在核对。");
      if (record.result && await adapter.exists(record.englishPath) && contentLines(await adapter.read(record.englishPath)).length) return false;
    }
    return true;
  }
  private async reviewComplete(records: WorkbenchRecords | null, now: number): Promise<boolean | null> {
    const week = workbenchWeekKey(now), settings = this.settings();
    const saved = records?.reviews[week];
    if (saved) {
      if (!safePath(saved.outputPath)) throw new Error("复盘成果路径无效。");
      const text = await readMobileFile(this.app.vault.adapter, saved.outputPath);
      if (text && contentLines(text).length) return true;
    }
    for (const [kind, state] of [["knowledge-base", settings.review.reports.knowledgeBase], ["agent-chat", settings.review.reports.agentChat]] as const) {
      const match = /^(\d{4}-\d{2}-\d{2})-to-(\d{4}-\d{2}-\d{2})$/u.exec(state.lastRangeKey);
      if (!match || match[1] !== week || !validWorkbenchDate(match[2]) || workbenchWeekKey(new Date(`${match[2]}T12:00:00`)) !== week) continue;
      const path = `${settings.review.outputDir.replace(/\/$/u, "")}/${kind}-review-${state.lastRangeKey}.md`;
      if (!safePath(path)) throw new Error("复盘成果路径无效。");
      const text = await readMobileFile(this.app.vault.adapter, path); if (text?.trim()) return true;
    }
    return records ? false : null;
  }
  private async pendingRaw(): Promise<WorkbenchSourceFile[] | null> {
    const registryPath = `${this.root}/pi-agent-product-v1/knowledge/processed-sources.json`;
    const adapter = this.app.vault.adapter;
    const legacy = resolveKnowledgePathFromRoots("outputs/.raw-digest-registry.json", this.app.vault.getRoot().children.map(file => file.name));
    const bytes = await readMobileFile(adapter, registryPath) ?? (safePath(legacy) ? await readMobileFile(adapter, legacy) : null);
    const envelope: unknown = bytes === null ? null : JSON.parse(bytes);
    if (envelope !== null && (!objectRecord(envelope) || envelope.schemaVersion !== 1 || !objectRecord(envelope.entries))) throw new Error("资料处理记录无效。");
    const registry = objectRecord(envelope) && objectRecord(envelope.entries) ? envelope.entries : null;
    const latest = new Map<string, { fingerprint: string; status: string }>();
    for (const history of [...this.settings().knowledgeBase.maintenanceHistory].sort((a, b) => b.at - a.at)) if (history.recordId) {
      const record = await this.services().readMaintenanceRecord(history.recordId);
      for (const source of record.sources) if (!latest.has(source.path)) latest.set(source.path, source);
    }
    const files = this.app.vault.getFiles().filter(file => this.inRole(file.path, "raw") && /\.(?:md|markdown|txt)$/iu.test(file.path)
      && !/(?:^|\/)index\.(?:md|markdown)$/iu.test(file.path) && !/\.base\.md$/iu.test(file.path));
    // Binary ingestion state needs the desktop extractor. Do not infer it from a file count.
    const result: WorkbenchSourceFile[] = [];
    for (const file of files) {
      const text = await this.app.vault.read(file), canonical = /\.(?:md|markdown)$/iu.test(file.path) ? canonicalRaw(text) : text;
      const fingerprint = `sha256:${new TextEncoder().encode(canonical).length}:${sha256Hex(canonical)}`;
      const previous = this.settings().knowledgeBase.processedSources[file.path];
      const maintenance = latest.get(file.path);
      if (maintenance?.fingerprint === fingerprint) {
        if (maintenance.status !== "processed") result.push(await this.source(file));
        continue;
      }
      const normalized = text.replace(/\r\n/gu, "\n"), frontmatter = /^---\n([\s\S]*?)\n(?:---|\.\.\.)(?:\n|$)/u.exec(normalized);
      if (/^---\n/u.test(normalized) && !frontmatter) throw new Error(`资料元数据未闭合：${file.path}`);
      // Parse the just-read bytes. A stale metadata cache cannot establish processed state.
      const metadata = frontmatter ? parseYaml(frontmatter[1]) as Record<string, unknown> | null : null;
      if (metadata && (typeof metadata !== "object" || Array.isArray(metadata))) throw new Error(`资料元数据无效：${file.path}`);
      const failed = metadata?.["提炼状态"] === "提炼失败";
      const trusted = metadata?.["已处理"] === true && metadata?.["提炼状态"] === "已提炼" && metadata?.["提炼指纹"] === fingerprint
        && typeof metadata?.["提炼报告"] === "string" && metadata["提炼报告"].trim() && Array.isArray(metadata?.["提炼证据"]) && metadata["提炼证据"].length;
      const registered = registry?.[file.path];
      if (!failed && (trusted || previous?.fingerprint === fingerprint || objectRecord(registered) && registered.fingerprint === fingerprint)) continue;
      // Without a processed-source or metadata observation, this is a real unprocessed text source.
      result.push(await this.source(file));
    }
    return result;
  }
  private signalFacts(facts: MobileWorkbenchFacts, now: number): WorkbenchFacts {
    return { ...facts, now, tasks: this.store.state.sessions.filter(task => !task.archivedAt),
      todos: facts.todos ?? [], inbox: facts.inbox ?? [], raw: facts.raw ?? [], finance: facts.finance ?? undefined };
  }
  /** Read-only diagnostic boundary used by tests; callers can distinguish unknown from empty. */
  async readFacts(now = Date.now(), force = false): Promise<MobileWorkbenchFacts> {
    if (this.disposed) throw new Error("工作台已关闭。");
    this.bindSources();
    const settings = this.settings(), service = this.services();
    const pro = !!service.accountService && hasProPluginAccess(service.accountService);
    const signature = JSON.stringify([settings.journalDirectory, settings.englishDiary.enabled, settings.lifestyle.finance.enabled,
      settings.knowledgeBase, settings.review, settings.mobileUi.knowledgePaths, settings.settingsLanguage, pro]);
    if (!force && this.cached?.signature === signature && now < this.cached.until) return { ...this.cached.facts, now, tasks: this.store.state.sessions };
    if (this.flight) { await this.flight; return this.readFacts(now, force); }
    const generation = this.generation;
    const pending = this.collect(now, pro); this.flight = pending;
    try {
      const facts = await pending;
      if (generation === this.generation) this.cached = { signature, until: nextWorkbenchRefreshAt(this.signalFacts(facts, now)), facts };
      return facts;
    } finally { if (this.flight === pending) this.flight = undefined; }
  }
  private async collect(now: number, pro: boolean): Promise<MobileWorkbenchFacts> {
    const settings = this.settings(), issues: string[] = [], modules: AgentModuleId[] = ["todos", "review"];
    const attempt = async <T>(label: string, fallback: T, read: () => Promise<T>): Promise<T> => {
      try { return await read(); } catch (error) { issues.push(`${label}：${errorText(error)}`); return fallback; }
    };
    const facts: MobileWorkbenchFacts = { now, modules, tasks: this.store.state.sessions, todos: null, finance: null,
      journals: [], englishMissing: null, inbox: null, inboxScope: scopeKey(this.roots("inbox")), raw: null,
      rawScope: scopeKey(this.roots("raw")), pdfJobs: [], reviewComplete: null, isolated: null,
      knowledgeScope: scopeKey([...this.roots("wiki"), ...this.roots("projects")]), language: settings.settingsLanguage, issues, versions: {} };
    if (!this.app.workspace.layoutReady) return facts;
    const records = await attempt("工作台记录读取失败", null, () => this.readRecords());
    facts.todos = await attempt("待办读取失败", null, async () => {
      const snapshot = await this.services().getTodoStore().readOnlySnapshot();
      facts.versions[snapshot.sourcePath] = snapshot.contentVersion ?? "missing"; return snapshot.records;
    });
    if (pro && settings.lifestyle.finance.enabled) {
      modules.push("finance");
      facts.finance = await attempt("财务读取失败", null, async () => {
        const lifestyle = this.services().lifestyle; if (!lifestyle) throw new Error("财务服务尚未就绪。");
        const snapshots = await lifestyle.finance.ledger.readSnapshots(), data = await lifestyle.store.readFresh();
        const errors = lifestyle.finance.ledger.issues(); if (errors.length) throw new Error(errors.map(error => `${error.path}：${error.reason}`).join("；"));
        return { entries: snapshots.map(snapshot => snapshot.entry), data };
      });
    }
    const journalAvailable = await attempt("日记配置读取失败", false, async () => (!settings.knowledgeBase.folderBindings || settings.knowledgeBase.folderBindings.roles.journal.enabled)
      && readNativeJournalSettings(this.app, settings.journalDirectory, settings.knowledgeBase.folderBindings).available);
    if (journalAvailable) {
      modules.push("journal");
      for (let offset = 0; offset < 3; offset++) {
        const date = new Date(now); date.setDate(date.getDate() - offset);
        const day = await attempt<WorkbenchJournalDay>("日记读取失败", { state: "unknown", path: "", text: "" }, () => this.journal(date, records, facts.versions));
        facts.journals = [...facts.journals, day];
      }
      if (new Set(facts.journals.map(day => day.path)).size !== 3) { facts.journals = []; issues.push("日记日期格式无法区分日期"); }
    }
    if (pro && settings.englishDiary.enabled) {
      modules.push("english-diary");
      if (facts.journals[0]?.state === "body") facts.englishMissing = await attempt("英文稿关联读取失败", null, () => this.englishMissing(facts.journals[0].path));
    }
    if (["raw", "wiki", "projects", "inbox"].some(role => this.roots(role as "raw").length)) {
      modules.push("knowledge-base");
      facts.inbox = await attempt("收件箱读取失败", null, () => this.observeInbox(now));
      facts.raw = await attempt("资料处理状态读取失败", null, () => this.pendingRaw());
      const bindings = settings.knowledgeBase.folderBindings;
      if (bindings) {
        const health = await attempt("笔记关联读取失败", null, () => this.links.load(bindings));
        if (health?.state === "ready") {
          facts.isolated = health.isolatedPaths;
          const versioned = await attempt("笔记版本读取失败", false, async () => {
            for (const path of health.isolatedPaths) { const file = this.app.vault.getAbstractFileByPath(path); if (file instanceof TFile) facts.versions[path] = (await this.source(file)).fingerprint; }
            return true;
          });
          if (!versioned) facts.isolated = null;
        }
      }
    }
    facts.reviewComplete = await attempt("复盘状态读取失败", null, () => this.reviewComplete(records, now));
    return facts;
  }
  private signals(facts: MobileWorkbenchFacts, now: number): WorkbenchSignal[] {
    return calculateWorkbenchSignals(this.signalFacts(facts, now)).map(signal => {
      const version = signal.moduleId === "finance" ? facts.finance
        : signal.id === 9 ? [facts.reviewComplete, this.settings().review]
        : signal.id === 14 ? [facts.isolated, facts.versions]
        : signal.id === 5 ? [facts.journals, facts.englishMissing, facts.versions]
        : signal.moduleId === "journal" ? [facts.journals, facts.versions]
        : signal.moduleId === "todos" ? [facts.todos, facts.versions["EchoInk/待办.md"]]
        : null;
      if (version) signal.source.versions = { ...signal.source.versions, "$facts": sha256Hex(JSON.stringify(version)) };
      return signal;
    });
  }
  async load(now = Date.now()): Promise<WorkbenchSnapshot> {
    const facts = await this.readFacts(now), input = this.signalFacts(facts, now), today = localWorkbenchDate(now);
    return { generatedAt: now, modules: [...facts.modules], signals: this.signals(facts, now),
      todayTodos: facts.todos?.filter(todo => !todo.done && todo.dueDate === today) ?? [], issues: [...facts.issues], nextRefreshAt: nextWorkbenchRefreshAt(input) };
  }
  async handoff(signal: WorkbenchSignal, replaceDraft = false): Promise<{ agentId: string; conflict: boolean }> {
    // Force current versions even when a file event hasn't arrived yet.
    const before = this.generation, facts = await this.readFacts(Date.now(), true), generation = this.generation;
    const current = this.signals(facts, facts.now).find(item => item.id === signal.id && item.key === signal.key);
    if (before !== generation) throw new Error("这条提醒已更新，请刷新后再交给 Agent。");
    if (!current || JSON.stringify(current.source.objects) !== JSON.stringify(signal.source.objects)
      || JSON.stringify(current.source.versions ?? {}) !== JSON.stringify(signal.source.versions ?? {})
      || current.prompt !== signal.prompt) throw new Error("这条提醒已更新，请刷新后再交给 Agent。");
    let agentId = GENERAL_ASSISTANT_ID, conflict = false;
    await this.store.update(latest => {
      if (this.disposed || generation !== this.generation) throw new Error("这条提醒已更新，请刷新后再交给 Agent。");
      if (latest.sessions.some(task => !task.archivedAt && task.businessKey === current.key && (task.taskStatus === "running" || task.taskStatus === "waiting" || task.pendingResponse))) throw new Error("这件事已经交给 Agent。");
      const registry = this.settings().agentRegistry, assigned = registry.moduleOwners[current.moduleId];
      agentId = registry.agents.some(agent => agent.id === assigned) ? assigned : GENERAL_ASSISTANT_ID;
      const previous = latest.newTaskDrafts[agentId], source = JSON.stringify(current.source);
      const same = previous?.text === current.prompt && parseMobileWorkbenchSource(previous.prefillSource)?.businessKey === current.key;
      const occupied = previous && (previous.text.trim() || previous.attachments.length || previous.noteMentions?.length || previous.annotations?.length || previous.selectedSkill);
      conflict = !!occupied && !same && !replaceDraft;
      if (conflict) return;
      // Retain model/permission selections; replace only the explicit old task context.
      const draft: TaskDraft = { ...previous, text: current.prompt, attachments: [], prefillSource: source };
      delete draft.noteMentions; delete draft.annotations; delete draft.selectedSkill; delete draft.englishDiarySourcePath;
      latest.newTaskDrafts[agentId] = draft; latest.page = { kind: "list", agentId };
    });
    return { agentId, conflict };
  }
  dispose(): void {
    this.disposed = true; this.links.dispose(); this.releases.splice(0).forEach(release => release());
    this.refs.splice(0).forEach(entry => entry.offref(entry.ref)); this.listeners.clear(); this.cached = undefined;
  }
}
