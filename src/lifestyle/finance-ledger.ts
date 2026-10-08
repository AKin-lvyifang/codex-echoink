import { createHash } from "node:crypto";
import { type App, TFile } from "obsidian";
import { parse, stringify } from "yaml";
import { classifyImport, parseYuan, type FinanceImportRow } from "./finance-domain";
import { FINANCE_BILINGUAL_ROOT, FINANCE_BILINGUAL_TRANSACTIONS, FINANCE_DEFAULT_ROOT, FINANCE_DEFAULT_TRANSACTIONS, FINANCE_LEGACY_ROOT, isEchoInkFinanceBase, isFinanceRootName } from "./finance-paths";
import type { FinanceEntry, LifestyleStore } from "./store";

export const FINANCE_DIRECTORY = `${FINANCE_DEFAULT_ROOT}/${FINANCE_DEFAULT_TRANSACTIONS}`;
export const FINANCE_BASE_PATH = `${FINANCE_DEFAULT_ROOT}/ledger.base`;
export const FINANCE_EMBED = `![[${FINANCE_BASE_PATH}#本笔账目]]`;
export interface FinanceAssociationResult { applied: string[]; failed: { id: string; error: string }[] }
export interface CreatedFinanceRow { entry: FinanceEntry; sourceFields?: FinanceImportRow["sourceFields"] }
export interface FinanceImportResult {
  added: number; updated: number; duplicates: number; invalid: number;
  created: CreatedFinanceRow[]; writeError?: string;
}
export interface FinanceImportWriteOptions {
  signal?: AbortSignal;
  onSaved?: (entry: FinanceEntry, kind: "added" | "updated") => void;
}
const LEGACY_DIRECTORY = `${FINANCE_LEGACY_ROOT}/账目`;
const LEGACY_BASE_PATH = `${FINANCE_LEGACY_ROOT}/账本.base`;

const knownSources = new Set(["manual", "wechat", "alipay"]);
const knownKinds = new Set(["expense", "income", "refund", "transfer"]);
const knownStatuses = new Set(["completed", "failed"]);

function stringField(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : "";
}

interface NoteIdentity { id: string; source: string; sourceId: string }
interface ParsedNote { entry: FinanceEntry | null; identity: NoteIdentity | null; issue: string | null; idHint?: string }

function normalizeDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/u.test(value)) return value.slice(0, 19).replace("T", " ");
  return value;
}

function parseFinanceDocument(markdown: string): ParsedNote {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return { entry: null, identity: null, issue: "缺少有效的属性区" };
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = parse(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entry: null, identity: null, issue: "属性格式无效" };
    fields = parsed as Record<string, unknown>;
  } catch { return { entry: null, identity: null, issue: "属性格式无效" }; }
  if (fields.echoink_type !== "finance_entry") return { entry: null, identity: null, issue: "缺少 EchoInk 账目标记" };
  const id = stringField(fields, "echoink_id");
  const source = stringField(fields, "source");
  const sourceId = typeof fields.source_id === "string" || typeof fields.source_id === "number" ? String(fields.source_id) : "";
  const identity = id && source && sourceId ? { id, source, sourceId } : null;
  if (!identity || !knownSources.has(source)) return { entry: null, identity, idHint: id, issue: "账目 ID 或来源属性无效" };
  const kind = stringField(fields, "type");
  const status = stringField(fields, "status");
  const date = normalizeDate(stringField(fields, "date"));
  const merchant = stringField(fields, "merchant").trim();
  const rawAmount = fields.amount;
  let amountCents: number;
  try { amountCents = parseYuan(typeof rawAmount === "number" || typeof rawAmount === "string" ? String(rawAmount) : ""); }
  catch { return { entry: null, identity, issue: "金额属性无效" }; }
  if (!knownKinds.has(kind) || !knownStatuses.has(status) || !merchant
    || !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/u.test(date)) return { entry: null, identity, issue: "日期、类型、状态或商户属性无效" };
  const entry: FinanceEntry = {
    id, source: source as FinanceEntry["source"], sourceId, date, merchant,
    category: stringField(fields, "category"), kind: kind as FinanceEntry["kind"], amountCents,
    status: status as FinanceEntry["status"], account: stringField(fields, "account"),
    description: stringField(fields, "description"), currency: stringField(fields, "currency") || "CNY",
    note: stringField(fields, "note"), icon: stringField(fields, "icon") || undefined,
    billPlanId: stringField(fields, "bill_plan_id").trim() || undefined
  };
  return { entry, identity, issue: null };
}

export function parseFinanceNote(markdown: string): FinanceEntry | null { return parseFinanceDocument(markdown).entry; }

function financeFields(entry: FinanceEntry, sourceFields?: FinanceImportRow["sourceFields"]): Record<string, string> {
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) throw new Error("账目金额无效");
  const fields = {
    echoink_type: "finance_entry", echoink_id: entry.id, source: entry.source, source_id: entry.sourceId,
    date: entry.date, amount: (entry.amountCents / 100).toFixed(2), type: entry.kind,
    category: entry.category, account: entry.account, merchant: entry.merchant,
    description: entry.description, currency: entry.currency, status: entry.status,
    note: entry.note, icon: entry.icon || "auto", ...(entry.billPlanId ? { bill_plan_id: entry.billPlanId } : {})
  };
  if (!sourceFields) return fields;
  return { ...fields,
    source_counterparty: sourceFields.counterparty,
    source_product: sourceFields.product,
    source_transaction_type: sourceFields.transactionType,
    source_payment_method: sourceFields.paymentMethod,
    source_direction: sourceFields.direction,
    source_state: sourceFields.state,
    source_merchant_order_id: sourceFields.merchantOrderId,
    source_note: sourceFields.note
  };
}

function fileName(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24) + ".md";
}

function folderFilterPaths(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(/file\.inFolder\("([^"]+)"\)/gu)].map((match) => match[1]);
  if (Array.isArray(value)) return value.flatMap(folderFilterPaths);
  if (value && typeof value === "object") return Object.values(value).flatMap(folderFilterPaths);
  return [];
}

export class FinanceLedger {
  private root = FINANCE_DEFAULT_ROOT;
  private directory = FINANCE_DIRECTORY;
  private basePath = FINANCE_BASE_PATH;
  private records: FinanceEntry[] = [];
  private files = new Map<string, TFile>();
  private allIds = new Set<string>();
  private blockedSources = new Set<string>();
  private unidentifiedNote = false;
  private problems: { path: string; reason: string }[] = [];
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private reloadScheduled = false;

  constructor(private readonly app: App, private readonly store: LifestyleStore) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  entries(): readonly FinanceEntry[] { return structuredClone(this.records); }
  issues(): readonly { path: string; reason: string }[] { return this.problems.slice(); }
  fileFor(id: string): TFile | null { return this.files.get(id) ?? null; }
  paths(): { directory: string; base: string; embed: string } {
    return { directory: this.directory, base: this.basePath, embed: `![[${this.basePath}#本笔账目]]` };
  }
  pathForNewEntry(id: string): string { return `${this.directory}/${fileName(id)}`; }
  watches(path: string): boolean { return path.startsWith(`${this.directory}/`) && path.endsWith(".md"); }

  onRename(oldPath: string, newPath: string): void {
    const rebase = (value: string) => value === oldPath ? newPath : value.startsWith(`${oldPath}/`) ? newPath + value.slice(oldPath.length) : value;
    const nextRoot = rebase(this.root), nextDirectory = rebase(this.directory), nextBase = rebase(this.basePath);
    if (nextRoot === this.root && nextDirectory === this.directory && nextBase === this.basePath) {
      if (this.watches(oldPath) || this.watches(newPath)) this.scheduleReload();
      return;
    }
    this.root = nextRoot; this.directory = nextDirectory; this.basePath = nextBase;
    void this.enqueue(async () => {
      await this.resolveLocation();
      await this.readDirect();
    }).catch((error) => console.error("EchoInk 财务目录引用更新失败", error));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async initialize(): Promise<void> {
    await this.resolveLocation();
    await this.reload();
    await this.ensureBaseFile();
    await this.migrateLegacy();
  }

  async reconcileLocation(): Promise<void> {
    await this.enqueue(async () => {
      await this.resolveLocation();
      await this.readDirect();
      await this.ensureBaseFile();
    });
  }

  private async resolveLocation(): Promise<void> {
    const vault = this.app.vault;
    const bases: TFile[] = [];
    for (const file of vault.getFiles().filter((item) => item.path.endsWith("/ledger.base") || item.path.endsWith("/账本.base"))) {
      const root = file.path.slice(0, file.path.lastIndexOf("/"));
      if (isFinanceRootName(root) || root === FINANCE_LEGACY_ROOT) { bases.push(file); continue; }
      try {
        if (isEchoInkFinanceBase(await vault.read(file))) bases.push(file);
      } catch { /* An unrelated Base is not an EchoInk finance ledger. */ }
    }
    if (bases.length > 1) throw new Error("发现多份财务账本，未猜测使用哪一份，也未创建新账本");
    const roots = [FINANCE_DEFAULT_ROOT, FINANCE_BILINGUAL_ROOT, FINANCE_LEGACY_ROOT]
      .filter((path) => vault.getAbstractFileByPath(path));
    if (!bases.length && roots.length > 1) throw new Error("发现多个财务目录，未合并或覆盖旧账目");
    this.root = bases.length ? bases[0].path.slice(0, bases[0].path.lastIndexOf("/")) : roots[0] ?? FINANCE_DEFAULT_ROOT;
    this.basePath = bases[0]?.path ?? `${this.root}/ledger.base`;
    const baseFilterPath = bases[0] ? await this.baseFilterDirectory(bases[0]) : null;
    this.directory = await this.resolveDirectory(baseFilterPath);
    const before = this.paths();
    await this.migrateOldLayout();
    await this.rewriteManagedReferences([before,
      { directory: LEGACY_DIRECTORY, base: LEGACY_BASE_PATH },
      { directory: FINANCE_DIRECTORY, base: FINANCE_BASE_PATH },
      { directory: `${FINANCE_BILINGUAL_ROOT}/${FINANCE_BILINGUAL_TRANSACTIONS}`, base: `${FINANCE_BILINGUAL_ROOT}/ledger.base` },
      { directory: `${this.root}/账目`, base: `${this.root}/账本.base` },
      ...(baseFilterPath ? [{ directory: baseFilterPath, base: this.basePath }] : [])]);
  }

  private async baseFilterDirectory(base: TFile): Promise<string | null> {
    try {
      const value = parse(await this.app.vault.read(base)) as Record<string, unknown>;
      return folderFilterPaths(value?.filters)[0] ?? null;
    } catch { return null; /* Existing Base validation happens in ensureBaseFile. */ }
  }

  private async resolveDirectory(baseFilterPath: string | null): Promise<string> {
    if (baseFilterPath?.startsWith(`${this.root}/`) && this.app.vault.getAbstractFileByPath(baseFilterPath)) return baseFilterPath;
    for (const name of [FINANCE_DEFAULT_TRANSACTIONS, FINANCE_BILINGUAL_TRANSACTIONS, "账目"]) {
      const candidate = `${this.root}/${name}`;
      if (this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
    if (this.directory.startsWith(`${this.root}/`) && this.app.vault.getAbstractFileByPath(this.directory)) return this.directory;
    return `${this.root}/${this.root === FINANCE_BILINGUAL_ROOT ? FINANCE_BILINGUAL_TRANSACTIONS : FINANCE_DEFAULT_TRANSACTIONS}`;
  }

  private async renameIfPresent(from: string, to: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(from);
    if (!file) return;
    if (this.app.vault.getAbstractFileByPath(to)) throw new Error(`财务目标路径已存在，保留原文件：${to}`);
    await this.app.fileManager.renameFile(file, to);
  }

  private async migrateOldLayout(): Promise<void> {
    if (this.root === FINANCE_LEGACY_ROOT) {
      await this.renameIfPresent(FINANCE_LEGACY_ROOT, FINANCE_DEFAULT_ROOT);
      this.root = FINANCE_DEFAULT_ROOT;
      this.basePath = this.basePath.replace(`${FINANCE_LEGACY_ROOT}/`, `${this.root}/`);
      this.directory = this.directory.replace(`${FINANCE_LEGACY_ROOT}/`, `${this.root}/`);
    }
    const standardBase = `${this.root}/ledger.base`;
    if (this.basePath !== standardBase) {
      await this.renameIfPresent(this.basePath, standardBase);
      this.basePath = standardBase;
    }
    const oldDirectory = `${this.root}/账目`;
    if (this.directory === oldDirectory) {
      const target = `${this.root}/${this.root === FINANCE_BILINGUAL_ROOT ? FINANCE_BILINGUAL_TRANSACTIONS : FINANCE_DEFAULT_TRANSACTIONS}`;
      await this.renameIfPresent(oldDirectory, target);
      this.directory = target;
    }
  }

  private async rewriteManagedReferences(previous: readonly { directory: string; base: string }[]): Promise<void> {
    const base = this.app.vault.getAbstractFileByPath(this.basePath);
    if (base instanceof TFile) {
      const update = (text: string): string => {
        let value: unknown;
        try { value = parse(text); } catch { throw new Error("现有 ledger.base 格式无效，未改写原文件"); }
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("现有 ledger.base 格式无效，未改写原文件");
        const config = value as Record<string, unknown>;
        const replace = (item: unknown): unknown => {
          if (typeof item === "string") {
            let changed = item;
            for (const old of previous) changed = changed.replaceAll(`file.inFolder("${old.directory}")`, `file.inFolder("${this.directory}")`);
            return changed;
          }
          if (Array.isArray(item)) return item.map(replace);
          if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child)]));
          return item;
        };
        const filters = replace(config.filters);
        const views = Array.isArray(config.views) ? config.views.map((view: unknown) => {
          if (!view || typeof view !== "object" || Array.isArray(view)) return view;
          const item = view as Record<string, unknown>;
          return { ...item, filters: replace(item.filters) };
        }) : config.views;
        return JSON.stringify(filters) === JSON.stringify(config.filters) && JSON.stringify(views) === JSON.stringify(config.views)
          ? text : stringify({ ...config, filters, views });
      };
      const before = await this.app.vault.read(base);
      if (update(before) !== before) await this.app.vault.process(base, update);
    }
    for (const file of this.app.vault.getMarkdownFiles().filter((item) => this.watches(item.path))) {
      const update = (text: string): string => {
        let changed = text;
        for (const old of previous) changed = changed.replaceAll(`![[${old.base}#本笔账目]]`, this.paths().embed);
        changed = changed.replace(/!\[\[([^\]]+\/(?:ledger|账本)\.base)#本笔账目\]\]/gu, (embed, path: string) =>
          path === this.basePath || this.app.vault.getAbstractFileByPath(path) ? embed : this.paths().embed);
        return changed;
      };
      const before = await this.app.vault.read(file);
      if (update(before) !== before) await this.app.vault.process(file, update);
    }
  }

  async ensureBaseFile(): Promise<TFile> {
    await this.ensureFolder();
    const config = {
      filters: `file.inFolder("${this.directory}")`,
      properties: {
        "note.echoink_id": { displayName: "账目 ID" },
        "note.merchant": { displayName: "商户 / 对方" },
        "note.description": { displayName: "消费说明" },
        "note.amount": { displayName: "金额 · 元" },
        "note.date": { displayName: "交易日期" },
        "note.type": { displayName: "类型" },
        "note.category": { displayName: "分类" },
        "note.account": { displayName: "账户" },
        "note.bill_plan_id": { displayName: "账单计划 ID" }
      },
      views: [
        { type: "table", name: "全部账目", order: ["note.date", "note.merchant", "note.description", "note.amount", "note.type", "note.category", "note.account", "note.echoink_id"] },
        { type: "table", name: "本笔账目", filters: "file.path == this.file.path", order: ["note.date", "note.merchant", "note.description", "note.amount", "note.type", "note.category", "note.account"] }
      ]
    };
    const existing = this.app.vault.getAbstractFileByPath(this.basePath);
    if (existing) {
      if (!(existing instanceof TFile)) throw new Error("账本.base 路径被目录占用");
      const mergeMissingViews = (text: string): string => {
        let parsed: unknown;
        try { parsed = parse(text); } catch { throw new Error("现有账本.base 格式无效，未改写原文件"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("现有账本.base 格式无效，未改写原文件");
        const current = parsed as Record<string, unknown>;
        const views = Array.isArray(current.views) ? current.views as Record<string, unknown>[] : [];
        const missing = config.views.filter((view) => !views.some((item) => item?.name === view.name));
        const properties = current.properties && typeof current.properties === "object" && !Array.isArray(current.properties)
          ? current.properties as Record<string, unknown> : { ...config.properties };
        const needsBillPlan = !current.properties || !Object.hasOwn(properties, "note.bill_plan_id");
        if (!missing.length && !needsBillPlan) return text;
        return stringify({ ...current, filters: current.filters ?? config.filters,
          properties: { ...properties, ...(needsBillPlan ? { "note.bill_plan_id": config.properties["note.bill_plan_id"] } : {}) },
          views: [...views, ...missing] });
      };
      const before = await this.app.vault.read(existing);
      if (mergeMissingViews(before) !== before) await this.app.vault.process(existing, mergeMissingViews);
      return existing;
    }
    return await this.app.vault.create(this.basePath, stringify(config));
  }

  reload(): Promise<void> { return this.enqueue(() => this.readDirect()); }

  scheduleReload(): void {
    if (this.reloadScheduled) return;
    this.reloadScheduled = true;
    void this.enqueue(async () => {
      this.reloadScheduled = false;
      await this.readDirect();
    }).catch((error) => console.error("EchoInk 财务账目刷新失败", error));
  }

  private async readDirect(): Promise<void> {
    const records: FinanceEntry[] = [];
    const files = new Map<string, TFile>();
    const allIds = new Set<string>();
    const blockedSources = new Set<string>();
    let unidentifiedNote = false;
    const problems: { path: string; reason: string }[] = [];
    const candidates: { file: TFile; parsed: ParsedNote }[] = [];
    const idCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles().filter((item) => this.watches(item.path))) {
      const parsed = parseFinanceDocument(await this.app.vault.read(file));
      candidates.push({ file, parsed });
      if (parsed.idHint) allIds.add(parsed.idHint);
      if (parsed.issue && !parsed.identity) unidentifiedNote = true;
      if (parsed.identity) {
        const { id, source, sourceId } = parsed.identity;
        allIds.add(id);
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
        const sourceKey = `${source}:${sourceId}`;
        sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
      }
    }
    for (const { file, parsed } of candidates) {
      const identity = parsed.identity;
      const sourceKey = identity ? `${identity.source}:${identity.sourceId}` : "";
      const conflict = identity && ((idCounts.get(identity.id) ?? 0) > 1 || (sourceCounts.get(sourceKey) ?? 0) > 1);
      if (parsed.issue || conflict) {
        problems.push({ path: file.path, reason: conflict ? "账目 ID 或来源标识与另一文件重复" : parsed.issue! });
        if (sourceKey) blockedSources.add(sourceKey);
        continue;
      }
      if (parsed.entry) { files.set(parsed.entry.id, file); records.push(parsed.entry); }
    }
    this.records = records;
    this.files = files;
    this.allIds = allIds;
    this.blockedSources = blockedSources;
    this.unidentifiedNote = unidentifiedNote;
    this.problems = problems;
    for (const listener of this.listeners) listener();
  }

  private async ensureFolder(): Promise<void> {
    for (const folder of [this.root, this.directory]) {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    }
  }

  private async createDirect(entry: FinanceEntry, sourceFields?: FinanceImportRow["sourceFields"]): Promise<void> {
    if (this.allIds.has(entry.id)) throw new Error(`账目已存在：${entry.id}`);
    await this.ensureFolder();
    const path = `${this.directory}/${fileName(entry.id)}`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`账目目标文件已被占用：${path}`);
    const file = await this.app.vault.create(path, `---\n${stringify(financeFields(entry, sourceFields))}---\n\n${this.paths().embed}\n`);
    this.files.set(entry.id, file);
    this.allIds.add(entry.id);
    this.records.push(entry);
  }

  private async patchDirect(id: string, changes: Record<string, string | null>): Promise<void> {
    const file = this.files.get(id);
    if (!file) throw new Error(`找不到账目：${id}`);
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete frontmatter[key]; else frontmatter[key] = value;
      }
    });
  }

  async add(entry: FinanceEntry): Promise<void> {
    await this.enqueue(async () => {
      await this.readDirect();
      await this.createDirect(entry);
      await this.readDirect();
    });
  }

  async updateDetails(id: string, merchant: string, description: string, icon: string, category?: string, account?: string, billPlanId?: string | null): Promise<FinanceEntry> {
    return await this.enqueue(async () => {
      await this.readDirect();
      const previous = this.records.find((entry) => entry.id === id);
      if (!previous) throw new Error("这笔账目已被删除或移出账目目录");
      const next = { ...previous, merchant: merchant.trim(), description: description.trim(), icon, category: category?.trim() || previous.category, account: account?.trim() || previous.account };
      if (!next.merchant || next.merchant.length > 60 || next.description.length > 200 || !next.category || !next.account) throw new Error("请检查商户、分类、账户和消费说明");
      await this.patchDirect(id, { merchant: next.merchant, description: next.description, icon: next.icon || "auto", category: next.category, account: next.account, ...(billPlanId === undefined ? {} : { bill_plan_id: billPlanId }) });
      await this.readDirect();
      return this.records.find((entry) => entry.id === id)!;
    });
  }

  async associateBillPlan(ids: readonly string[], billPlanId: string): Promise<FinanceAssociationResult> {
    return this.enqueue(async () => {
      await this.readDirect();
      const result: FinanceAssociationResult = { applied: [], failed: [] };
      try {
        for (const id of new Set(ids)) {
          try { await this.patchDirect(id, { bill_plan_id: billPlanId }); result.applied.push(id); }
          catch (error) { result.failed.push({ id, error: error instanceof Error ? error.message : String(error) }); }
        }
      } finally { await this.readDirect(); }
      return result;
    });
  }

  async importRows(rows: readonly FinanceImportRow[], options: FinanceImportWriteOptions = {}): Promise<FinanceImportResult> {
    return await this.enqueue(async () => {
      await this.readDirect();
      const result = this.previewImport(rows);
      const sources = new Map(rows.filter((row) => row.entry && row.sourceFields)
        .map((row) => [`${row.entry!.source}:${row.entry!.sourceId}`, row.sourceFields] as const));
      const created: CreatedFinanceRow[] = [];
      let updated = 0;
      let writeError: string | undefined;
      try {
        for (const entry of result.added) {
          if (options.signal?.aborted) break;
          const sourceFields = sources.get(`${entry.source}:${entry.sourceId}`);
          try { await this.createDirect(entry, sourceFields); }
          catch (error) { writeError = error instanceof Error ? error.message : String(error); break; }
          created.push({ entry: { ...entry, icon: entry.icon || "auto" }, sourceFields: sourceFields ? { ...sourceFields } : undefined });
          options.onSaved?.(entry, "added");
        }
        if (!writeError && !options.signal?.aborted) for (const entry of result.updated) {
          if (options.signal?.aborted) break;
          try { await this.patchDirect(entry.id, { status: entry.status }); }
          catch (error) { writeError = error instanceof Error ? error.message : String(error); break; }
          updated++;
          options.onSaved?.(entry, "updated");
        }
      } finally { await this.readDirect(); }
      return { added: created.length, updated, duplicates: result.duplicates, invalid: result.invalid, created, writeError };
    });
  }

  async applySuggestions(created: readonly CreatedFinanceRow[], suggestions: readonly FinanceImportRow[], signal: AbortSignal, onApplied?: (entry: FinanceEntry) => void, onSkipped?: (entry: FinanceEntry, reason: string) => void): Promise<{ applied: number; skipped: number }> {
    return await this.enqueue(async () => {
      await this.readDirect();
      let applied = 0; let skipped = 0;
      const proposed = new Map(suggestions.filter((row) => row.entry).map((row) => [row.entry!.id, row.entry!]));
      for (const snapshot of created) {
        if (signal.aborted) break;
        const next = proposed.get(snapshot.entry.id);
        const file = this.files.get(snapshot.entry.id);
        if (!next || !file) { skipped++; onSkipped?.(snapshot.entry, "账目已移走或整理结果缺失，未覆盖原内容"); continue; }
        const markdown = await this.app.vault.read(file);
        const current = parseFinanceNote(markdown);
        const original = snapshot.entry;
        const facts: (keyof FinanceEntry)[] = ["id", "source", "sourceId", "date", "amountCents", "kind", "status", "currency", "note"];
        const semantic: (keyof FinanceEntry)[] = ["merchant", "account", "category", "description", "icon"];
        const sourceValues = snapshot.sourceFields ? financeFields(original, snapshot.sourceFields) : {};
        const sourceChanged = (fields: Record<string, unknown>): boolean => Object.entries(sourceValues)
          .some(([key, value]) => {
            if (!key.startsWith("source_")) return false;
            const current = fields[key] ?? "";
            return (typeof current !== "string" && typeof current !== "number" && typeof current !== "boolean")
              || String(current) !== value;
          });
        let readFields: Record<string, unknown>;
        try { readFields = parse(markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] || "") as Record<string, unknown>; }
        catch { skipped++; onSkipped?.(original, "账目属性无法读取，未覆盖原内容"); continue; }
        if (!current || facts.some((key) => current[key] !== original[key]) || semantic.some((key) => current[key] !== original[key]) || sourceChanged(readFields)) { skipped++; onSkipped?.(original, "账目已被修改，未覆盖你的修改"); continue; }
        if (semantic.every((key) => next[key] === original[key])) continue;
        const before = applied;
        let saved: FinanceEntry | null = null;
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          const still = parseFinanceDocument(`---\n${stringify(frontmatter)}---\n`).entry;
          if (!still || facts.some((key) => still[key] !== original[key]) || semantic.some((key) => still[key] !== original[key]) || sourceChanged(frontmatter)) { skipped++; onSkipped?.(original, "账目已被修改，未覆盖你的修改"); return; }
          if (signal.aborted) { skipped++; return; }
          frontmatter.merchant = next.merchant;
          frontmatter.account = next.account;
          frontmatter.category = next.category;
          frontmatter.description = next.description;
          frontmatter.icon = next.icon || "auto";
          saved = { ...still, merchant: next.merchant, account: next.account, category: next.category, description: next.description, icon: next.icon || "auto" };
          applied++;
        });
        if (applied > before && saved) onApplied?.(saved);
      }
      await this.readDirect();
      return { applied, skipped };
    });
  }

  previewImport(rows: readonly FinanceImportRow[]): ReturnType<typeof classifyImport> {
    if (this.unidentifiedNote) throw new Error("有账目笔记缺少有效属性，请先修正，避免重复导入");
    const permitted = rows.filter((row) => !row.entry || !this.blockedSources.has(`${row.entry.source}:${row.entry.sourceId}`));
    const result = classifyImport(this.records, permitted);
    return { ...result, duplicates: result.duplicates + rows.length - permitted.length };
  }

  async migrateLegacy(): Promise<void> {
    await this.enqueue(async () => {
      const legacy = this.store.snapshot().financeEntries;
      if (!legacy.length) {
        if (this.store.hasLegacyFinanceField()) await this.store.update((draft) => { draft.financeEntries = []; });
        return;
      }
      const ids = new Set(legacy.map((entry) => entry.id));
      if (ids.size !== legacy.length) throw new Error("旧账目存在重复 ID，未清除旧数据");
      await this.readDirect();
      if (this.unidentifiedNote) throw new Error("账目目录存在缺少有效属性的笔记，旧账目已保留，修正后可重试迁移");
      const created: FinanceEntry[] = [];
      try {
        for (const entry of legacy) {
          if (this.allIds.has(entry.id)) continue;
          await this.createDirect(entry);
          created.push(entry);
        }
        await this.readDirect();
        const migrated = new Map(this.records.map((entry) => [entry.id, entry]));
        if (legacy.some((entry) => !migrated.has(entry.id))) throw new Error("旧账目迁移数量核对失败");
        const expectedCents = created.reduce((sum, entry) => sum + entry.amountCents, 0);
        const actualCents = created.reduce((sum, entry) => sum + migrated.get(entry.id)!.amountCents, 0);
        if (expectedCents !== actualCents) throw new Error("旧账目迁移金额核对失败");
        await this.store.retainLegacyFinanceBackup();
        await this.store.update((draft) => { draft.financeEntries = []; });
      } finally { await this.readDirect(); }
    });
  }
}
