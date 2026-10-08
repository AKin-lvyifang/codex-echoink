import { paidTestAccess } from "./membership-access";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TFile, type App } from "obsidian";
import { parse, stringify } from "yaml";
import { FinanceLedger, FINANCE_BASE_PATH, FINANCE_DIRECTORY } from "../lifestyle/finance-ledger";
import { organizeFinanceRows } from "../lifestyle/finance-import";
import { LifestyleFinanceService as ProductionFinanceService } from "../lifestyle/finance-service";
import type { LifestyleService } from "../lifestyle/service";
import { financeSummary, readFinanceBill, type FinanceImportRow } from "../lifestyle/finance-domain";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { LifestyleStore, type FinanceEntry } from "../lifestyle/store";

export class FakeVault {
  files = new Map<string, { file: TFile; text: string }>();
  folders = new Set<string>();
  createCount = 0;
  failMarkdownAfter = Infinity;
  reads = 0;
  on(): object { return {}; }
  getFiles(): TFile[] { return [...this.files.values()].map(({ file }) => file); }
  getMarkdownFiles(): TFile[] { return [...this.files.values()].filter(({ file }) => file.path.endsWith(".md")).map(({ file }) => file); }
  getAbstractFileByPath(target: string): TFile | object | null { return this.files.get(target)?.file || (this.folders.has(target) ? { path: target } : null); }
  async createFolder(target: string): Promise<void> { this.folders.add(target); }
  async create(target: string, text: string): Promise<TFile> {
    if (this.files.has(target)) throw new Error("file exists");
    if (target.endsWith(".md") && ++this.createCount > this.failMarkdownAfter) throw new Error("injected write failure");
    const file = new TFile(target);
    this.files.set(target, { file, text });
    return file;
  }
  async read(file: TFile): Promise<string> { this.reads++; return this.files.get(file.path)!.text; }
  async process(file: TFile, update: (text: string) => string): Promise<string> {
    const item = this.files.get(file.path)!;
    item.text = update(item.text);
    return item.text;
  }
  async processFrontMatter(file: TFile, update: (fields: Record<string, unknown>) => void): Promise<void> {
    const item = this.files.get(file.path)!;
    const match = item.text.match(/^---\n([\s\S]*?)\n---\n/u)!;
    const fields = parse(match[1]) as Record<string, unknown>;
    update(fields);
    item.text = `---\n${stringify(fields)}---\n${item.text.slice(match[0].length)}`;
  }
  async rename(file: TFile | object, target: string): Promise<void> {
    const oldPath = [...this.files.entries()].find(([, item]) => item.file === file)?.[0]
      ?? [...this.folders].find((name) => name === (file as { path?: string }).path);
    if (!oldPath || this.getAbstractFileByPath(target)) throw new Error(`rename conflict: ${target}`);
    for (const [name, item] of [...this.files]) {
      if (name !== oldPath && !name.startsWith(`${oldPath}/`)) continue;
      const next = target + name.slice(oldPath.length);
      this.files.delete(name);
      item.file.path = next;
      this.files.set(next, item);
    }
    for (const name of [...this.folders]) {
      if (name !== oldPath && !name.startsWith(`${oldPath}/`)) continue;
      this.folders.delete(name);
      this.folders.add(target + name.slice(oldPath.length));
    }
  }
}

function entry(id: string, amountCents: number): FinanceEntry {
  return { id, source: "wechat", sourceId: `raw-${id}`, date: "2026-09-20 10:00:00", merchant: "原商户", category: "餐饮",
    kind: "expense", amountCents, status: "completed", account: "微信", description: "原说明", currency: "CNY", note: "" };
}

export async function runLifestyleFinanceLedgerTests(): Promise<void> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-finance-ledger-"));
  try {
    const json = path.join(directory, "lifestyle.json");
    await fsp.writeFile(json, JSON.stringify({ version: 1, financeEntries: [entry("one", 1234), entry("two", 5678)] }));
    const store = new LifestyleStore(json);
    await store.initialize();
    const vault = new FakeVault();
    const app = { vault, fileManager: { processFrontMatter: vault.processFrontMatter.bind(vault), renameFile: vault.rename.bind(vault) } } as unknown as App;
    vault.failMarkdownAfter = 1;
    await assert.rejects(new FinanceLedger(app, store).initialize(), /injected write failure/u);
    assert.equal((JSON.parse(await fsp.readFile(json, "utf8")) as { financeEntries: FinanceEntry[] }).financeEntries.length, 2, "partial migration retains legacy data");
    vault.failMarkdownAfter = Infinity;
    const ledger = new FinanceLedger(app, store);
    await ledger.initialize();
    assert.equal(ledger.entries().length, 2, "restart resumes migration without creating duplicates");
    assert.equal(financeSummary(ledger.entries(), "2026-09").netExpenseCents, 6912);
    assert.equal("financeEntries" in JSON.parse(await fsp.readFile(json, "utf8")), false, "successful migration stops JSON account persistence");
    assert.equal((JSON.parse(await fsp.readFile(`${json}.finance-legacy-backup.json`, "utf8")) as { financeEntries: FinanceEntry[] }).financeEntries.length, 2);
    assert.equal([...vault.files.keys()].filter((name) => name.endsWith(".base")).length, 1);
    assert.ok(vault.files.has(FINANCE_BASE_PATH));
    const base = vault.files.get(FINANCE_BASE_PATH)!;
    const custom = parse(base.text) as { views: { name: string }[] };
    custom.views.push({ name: "我的自定义视图" });
    base.text = stringify(custom);
    await ledger.ensureBaseFile();
    assert.equal((parse(base.text) as { views: { name: string }[] }).views.length, 3, "opening the fixed Base preserves user views");
    assert.equal([...vault.files.keys()].filter((name) => name.endsWith(".base")).length, 1);

    const first = ledger.fileFor("one")!;
    const firstText = await vault.read(first);
    const copied = `${FINANCE_DIRECTORY}/copied.md`;
    await vault.create(copied, firstText);
    await ledger.reload();
    assert.equal(ledger.entries().length, 1, "duplicate IDs do not freeze the remaining ledger");
    assert.equal(ledger.issues().length, 2, "both conflicting paths are reported");
    vault.files.delete(copied);
    await ledger.reload();

    vault.files.get(first.path)!.text = firstText.replace(/amount: "12.34"/u, 'amount: ""');
    await ledger.reload();
    assert.equal(ledger.entries().length, 1, "invalid amount is excluded from totals");
    assert.match(ledger.issues()[0].reason, /金额/u);
    const importRow: FinanceImportRow = { entry: entry("new-import-id", 1234), error: "", raw: [] };
    importRow.entry!.sourceId = "raw-one";
    const result = await ledger.importRows([importRow]);
    assert.equal(result.added, 0, "invalid source identity still prevents reimport duplication");
    vault.files.get(first.path)!.text = firstText.replace(/2026-09-20 10:00:00/u, "2026-09-20T10:00:00Z");
    await ledger.reload();
    assert.equal(ledger.entries().length, 2, "native ISO date is accepted after property repair");

    vault.files.get(first.path)!.text += "\n人工正文不能丢。\n";
    vault.files.get(first.path)!.text = vault.files.get(first.path)!.text.replace(/^---\n/u, "---\ncustom_field: kept\n");
    const updated = await ledger.updateDetails("one", "人工商户", "人工说明", "coffee");
    assert.equal(updated.merchant, "人工商户");
    assert.equal(ledger.entries().find((item) => item.id === "one")?.icon, "coffee");
    assert.match(await vault.read(first), /人工说明/u);
    assert.match(await vault.read(first), /custom_field: kept/u);
    assert.match(await vault.read(first), /人工正文不能丢/u);
    vault.files.get(first.path)!.text = vault.files.get(first.path)!.text.replace(/amount: "12.34"/u, 'amount: "15.00"');
    await ledger.reload();
    assert.equal(ledger.entries().find((item) => item.id === "one")?.amountCents, 1500, "native property edit refreshes calculations");
    const source = ledger.entries().find((item) => item.id === "one")!;
    const changedStatus: FinanceImportRow = { entry: { ...source, status: "failed", merchant: "导入覆盖值", amountCents: 9999 }, error: "", raw: [] };
    const statusResult = await ledger.importRows([changedStatus]);
    assert.equal(statusResult.updated, 1);
    const kept = ledger.entries().find((item) => item.id === "one")!;
    assert.equal(kept.status, "failed");
    assert.deepEqual([kept.merchant, kept.description, kept.icon, kept.amountCents], ["人工商户", "人工说明", "coffee", 1500]);
    const renamed = `${FINANCE_DIRECTORY}/renamed.md`;
    const renamedText = vault.files.get(first.path)!.text;
    vault.files.delete(first.path);
    vault.files.set(renamed, { file: new TFile(renamed), text: renamedText });
    await ledger.reload();
    assert.equal(ledger.fileFor("one")?.path, renamed, "rename keeps the stable account ID");
    vault.files.delete(renamed);
    await ledger.reload();
    assert.equal(ledger.entries().length, 1, "native deletion removes the entry from all derived totals");
    vault.files.set(renamed, { file: new TFile(renamed), text: renamedText });
    await ledger.reload();
    vault.reads = 0;
    const batch = Array.from({ length: 60 }, (_, index): FinanceImportRow => ({ entry: entry(`bulk-${index}`, index + 100), error: "", raw: [],
      sourceFields: index === 0 ? { counterparty: "合成商户", product: "合成商品", transactionType: "商户消费", paymentMethod: "零钱", direction: "支出", state: "支付成功", merchantOrderId: "SYNTHETIC-MERCHANT-ORDER", note: "合成备注" } : undefined }));
    await ledger.importRows(batch);
    assert.ok(vault.reads < 200, `batch import should not rescan per row (reads=${vault.reads})`);
    assert.match(vault.files.get(ledger.fileFor("bulk-0")!.path)!.text, /source_counterparty: 合成商户/u, "原始对方字段保留在 Markdown 属性");
    assert.match(vault.files.get(ledger.fileFor("bulk-0")!.path)!.text, /source_merchant_order_id: SYNTHETIC-MERCHANT-ORDER/u);

    const sourceFields = { counterparty: "合成商户", product: "咖啡", transactionType: "商户消费", paymentMethod: "零钱", direction: "支出", state: "支付成功", merchantOrderId: "SYNTHETIC-ORDER", note: "" };
    const nextRow = (id: string): FinanceImportRow => ({ entry: entry(id, 1234), error: "", raw: [], sourceFields });
    const stopWriting = new AbortController();
    const savedIds: string[] = [];
    const stoppedWrite = await ledger.importRows([nextRow("stop-1"), nextRow("stop-2")], {
      signal: stopWriting.signal,
      onSaved: (saved) => { savedIds.push(saved.id); stopWriting.abort(); }
    });
    assert.deepEqual([stoppedWrite.added, stoppedWrite.created.length, ...savedIds], [1, 1, "stop-1"], "stop waits for the current atomic note and reports only saved notes");
    assert.equal(ledger.fileFor("stop-2"), null, "stop does not start the next note");
    assert.equal((await ledger.importRows([nextRow("stop-1"), nextRow("stop-2")])).added, 1, "retry imports only the remaining note");
    const imported = await ledger.importRows([nextRow("new-a"), nextRow("new-a")]);
    assert.equal(imported.added, 1, "only actually created notes enter the model batch");
    assert.equal(imported.created.length, 1);
    assert.ok(vault.files.has(FINANCE_BASE_PATH) && ledger.fileFor("new-a"), "Markdown and Base exist before model work");
    const initial = imported.created[0].entry;
    const initialFile = ledger.fileFor(initial.id)!;
    vault.files.get(initialFile.path)!.text += "\n人工正文保留。\n";
    vault.files.get(initialFile.path)!.text = vault.files.get(initialFile.path)!.text.replace(/^---\n/u, "---\ncustom_field: kept\n");
    const suggestion: FinanceImportRow = { entry: { ...initial, merchant: "整理商户", account: "银行卡", category: "购物", description: "整理说明", icon: "coffee", kind: "transfer", amountCents: 9999 }, error: "", raw: [] };
    const applied = await ledger.applySuggestions(imported.created, [suggestion], new AbortController().signal);
    assert.equal(applied.applied, 1);
    const updatedText = await vault.read(initialFile);
    assert.match(updatedText, /custom_field: kept/u);
    assert.match(updatedText, /人工正文保留/u);
    assert.match(updatedText, /source_counterparty: 合成商户/u);
    const after = ledger.entries().find((item) => item.id === initial.id)!;
    assert.deepEqual([after.merchant, after.account, after.category, after.description, after.icon], ["整理商户", "银行卡", "购物", "整理说明", "coffee"]);
    assert.deepEqual([after.kind, after.amountCents], ["expense", 1234], "model cannot change facts");
    assert.equal((await ledger.importRows([nextRow("new-a")])).created.length, 0, "reimport never schedules old notes");

    const guarded = await ledger.importRows([nextRow("guarded")]);
    await ledger.updateDetails("guarded", "人工改名", "原说明", "auto");
    const guardedSuggestion: FinanceImportRow = { entry: { ...guarded.created[0].entry, merchant: "模型改名" }, error: "", raw: [] };
    const conflictReasons: string[] = [];
    assert.equal((await ledger.applySuggestions(guarded.created, [guardedSuggestion], new AbortController().signal,
      undefined, (_entry, reason) => conflictReasons.push(reason))).skipped, 1);
    assert.match(conflictReasons[0], /已被修改/u);
    assert.equal(ledger.entries().find((item) => item.id === "guarded")?.merchant, "人工改名");
    const sourceGuard = await ledger.importRows([nextRow("source-guard")]);
    const sourceFile = ledger.fileFor("source-guard")!;
    vault.files.get(sourceFile.path)!.text = vault.files.get(sourceFile.path)!.text.replace("source_product: 咖啡", "source_product: 人工改过");
    assert.equal((await ledger.applySuggestions(sourceGuard.created, [{ entry: { ...sourceGuard.created[0].entry, merchant: "模型改名" }, raw: [], error: "" }], new AbortController().signal)).skipped, 1);
    const objectSourceRow = nextRow("source-object-guard");
    objectSourceRow.sourceFields = { ...objectSourceRow.sourceFields, product: "[object Object]" };
    const objectSourceGuard = await ledger.importRows([objectSourceRow]);
    const objectSourceFile = ledger.fileFor("source-object-guard")!;
    vault.files.get(objectSourceFile.path)!.text = vault.files.get(objectSourceFile.path)!.text
      .replace(/^source_product:.*$/mu, "source_product: { edited: true }");
    assert.equal((await ledger.applySuggestions(objectSourceGuard.created, [{ entry: { ...objectSourceGuard.created[0].entry, merchant: "模型改名" }, raw: [], error: "" }], new AbortController().signal)).skipped, 1,
      "a user-edited YAML object is not mistaken for the original string through default object stringification");
    const removed = await ledger.importRows([nextRow("removed")]);
    vault.files.delete(ledger.fileFor("removed")!.path);
    assert.equal((await ledger.applySuggestions(removed.created, [{ entry: { ...removed.created[0].entry, merchant: "模型改名" }, raw: [], error: "" }], new AbortController().signal)).skipped, 1);
    const cancelled = await ledger.importRows([nextRow("cancelled")]);
    const abort = new AbortController(); abort.abort();
    assert.equal((await ledger.applySuggestions(cancelled.created, [{ entry: { ...cancelled.created[0].entry, merchant: "模型改名" }, raw: [], error: "" }], abort.signal)).applied, 0);
    assert.equal(ledger.entries().find((item) => item.id === "cancelled")?.merchant, "原商户");
    vault.failMarkdownAfter = vault.createCount + 1;
    const partialWrite = await ledger.importRows([nextRow("partial-1"), nextRow("partial-2")]);
    assert.deepEqual([partialWrite.added, partialWrite.created.length], [1, 1], "partial write reports actual created batch");
    assert.match(partialWrite.writeError || "", /injected write failure/u);
    vault.failMarkdownAfter = Infinity;
    const modelBatch = await ledger.importRows([nextRow("model-batch")]);
    let modelCalled = 0;
    const organizedBatch = await organizeFinanceRows(modelBatch.created.map(({ entry: saved, sourceFields }): FinanceImportRow => ({ entry: saved, sourceFields, error: "", raw: [] })),
      DEFAULT_LIFESTYLE_SETTINGS.finance, [], { signal: new AbortController().signal, skillContent: "五字段整理",
        generate: async () => {
          modelCalled++;
          assert.ok(ledger.fileFor("model-batch") && vault.files.has(FINANCE_BASE_PATH), "model starts only after Markdown and Base exist");
          return JSON.stringify({ rows: [{ ref: 0, merchant: "模型整理商户", category: "餐饮", kind: "transfer", amount: "999.00" }] });
        } });
    assert.equal(modelCalled, 1);
    await ledger.applySuggestions(modelBatch.created, organizedBatch.rows, new AbortController().signal);
    assert.equal(ledger.entries().find((item) => item.id === "model-batch")?.kind, "expense");
    assert.equal(ledger.entries().find((item) => item.id === "model-batch")?.amountCents, 1234);
    const repeated = await ledger.importRows([nextRow("model-batch")]);
    assert.equal(repeated.created.length, 0, "duplicate rows do not call the model");
    const unavailable = await organizeFinanceRows([], DEFAULT_LIFESTYLE_SETTINGS.finance, [], { signal: new AbortController().signal });
    assert.equal(unavailable.rows.length, 0, "unavailable model leaves saved notes intact");
    let aiMode: "ready" | "disabled" | "failed" = "ready";
    let serviceCalls = 0;
    let activeServiceId = "service-ready";
    let rejectAccountSave = false;
    const fakeService = { store, refresh: () => undefined, plugin: {
      app, settings: { lifestyle: { finance: { ...DEFAULT_LIFESTYLE_SETTINGS.finance, importAiEnabled: true } } },
      saveSettings: async () => { if (rejectAccountSave) throw new Error("settings save failed"); },
      lifestyle: { refresh: () => undefined },
      registerEvent: () => undefined,
      getSkillRuntimeCoordinator: () => ({ resolveById: async () => undefined, recordUse: async () => undefined }),
      requireAvailableEchoInkSkill: async () => { if (aiMode === "disabled") throw new Error("Skill 已停用"); },
      readEchoInkBuiltinSkill: async () => ({ fileStatus: "ready", content: "五字段整理" }),
      generateLifestyleText: async (_system: string, prompt: string) => {
        serviceCalls++;
        if (aiMode === "ready" && activeServiceId !== "service-alipay") assert.equal(fakeService.plugin.settings.lifestyle.finance.accounts.length, 0,
          "model runs before imported accounts enter the configured catalog");
        assert.ok(vault.files.has(FINANCE_BASE_PATH), "Base exists before the service calls the model");
        const saved = finance.ledger.fileFor(activeServiceId);
        assert.ok(saved, "Markdown exists before the service calls the model");
        assert.match(await vault.read(saved), /source_counterparty: 合成商户/u, "source properties exist before model call");
        if (aiMode === "failed") throw new Error("模型不可用");
        if (activeServiceId === "service-alipay") {
          const input = JSON.parse(prompt);
          assert.deepEqual([input.rows[0].source, input.rows[0].transactionType, input.rows[0].product, input.rows[0].paymentMethod],
            ["alipay", "日用百货", "淘宝合成商品", "合成支付宝付款方式"]);
          assert.doesNotMatch(prompt, /SYNTHETIC-ALIPAY-ORDER|PRIVATE-ALIPAY-ACCOUNT|SYNTHETIC-ALIPAY-MERCHANT/u);
          return JSON.stringify({ rows: [{ ref: 0, merchant: "模型平台商户", account: "模型支付宝账户", category: "购物",
            description: "整理后的商品", iconId: "taobao", amountCents: 99999, kind: "transfer", status: "failed", date: "1999-01-01", sourceId: "changed" }] });
        }
        return JSON.stringify({ rows: [{ ref: 0, merchant: "服务整理商户", category: "餐饮", account: "模型账户" }] });
      }
    } } as unknown as LifestyleService;
    const finance = new LifestyleFinanceService(fakeService);
    const firstServiceImport = await finance.confirmImport([nextRow("service-ready")]);
    assert.equal(firstServiceImport.added, 1);
    const serviceResult = await finance.prepareImport(firstServiceImport.created, new AbortController().signal);
    assert.equal(serviceCalls, 1);
    await finance.applyImportSuggestions(firstServiceImport.created, serviceResult.rows, new AbortController().signal);
    assert.equal(finance.entries().find((item) => item.id === "service-ready")?.merchant, "服务整理商户");
    assert.equal(fakeService.plugin.settings.lifestyle.finance.accounts.length, 0, "catalog remains untouched until model suggestions are saved");
    assert.equal(await finance.finalizeImportedAccounts(new Set(firstServiceImport.created.map(({ entry }) => entry.id))), 1);
    assert.deepEqual(fakeService.plugin.settings.lifestyle.finance.accounts.map((item) => item.name), ["模型账户"], "catalog uses the final saved note value");
    assert.equal(await finance.finalizeImportedAccounts(new Set(["service-ready"])), 0, "repeated finalization does not duplicate accounts");
    aiMode = "disabled";
    activeServiceId = "service-disabled";
    const disabledImport = await finance.confirmImport([nextRow("service-disabled")]);
    const disabledResult = await finance.prepareImport(disabledImport.created, new AbortController().signal);
    assert.equal(serviceCalls, 1, "disabled Skill does not call the model");
    assert.match(disabledResult.warnings.join(""), /已停用/u);
    assert.ok(finance.entries().some((item) => item.id === "service-disabled"), "disabled Skill retains Markdown");
    const disabledAccount = finance.entries().find((item) => item.id === "service-disabled")!.account;
    fakeService.plugin.settings.lifestyle.finance.accounts.push({ name: "已有账户", aliases: [disabledAccount], active: false });
    assert.equal(await finance.finalizeImportedAccounts(new Set(["service-disabled", "never-saved-id"])), 0,
      "a disabled account alias and a note that was never saved do not create catalog entries");
    aiMode = "failed";
    activeServiceId = "service-failed";
    const failedImport = await finance.confirmImport([nextRow("service-failed")]);
    const failedResult = await finance.prepareImport(failedImport.created, new AbortController().signal);
    assert.match(failedResult.warnings.join(""), /模型不可用/u);
    assert.ok(finance.entries().some((item) => item.id === "service-failed"), "model failure retains Markdown");
    const accountRow = nextRow("service-new-account");
    accountRow.entry!.account = "银行卡 1234";
    const newAccount = await finance.confirmImport([accountRow]);
    await finance.updateDetails("service-new-account", "原商户", "原说明", "auto", "餐饮", "银行卡 1234");
    rejectAccountSave = true;
    await assert.rejects(finance.finalizeImportedAccounts(new Set(["service-new-account"])), /settings save failed/u);
    assert.ok(finance.entries().some((item) => item.id === "service-new-account"), "catalog failure keeps the saved note");
    assert.equal(fakeService.plugin.settings.lifestyle.finance.accounts.some((item) => item.name === "银行卡 1234"), false,
      "catalog failure restores previous settings");
    rejectAccountSave = false;
    assert.equal(await finance.finalizeImportedAccounts(new Set(newAccount.created.map(({ entry }) => entry.id))), 1);

    aiMode = "ready"; activeServiceId = "service-alipay";
    const alipayRows = await readFinanceBill(new TextEncoder().encode(
      "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n"
      + "2026-09-22 10:00:00,日用百货,合成商户,PRIVATE-ALIPAY-ACCOUNT,淘宝合成商品,支出,18.50,合成支付宝付款方式,等待发货,SYNTHETIC-ALIPAY-ORDER,SYNTHETIC-ALIPAY-MERCHANT,合成备注,\n"),
      "alipay.csv", "alipay");
    alipayRows[0].entry!.id = activeServiceId;
    const alipayImported = await finance.confirmImport(alipayRows);
    assert.equal(alipayImported.added, 1);
    const alipayFile = finance.ledger.fileFor(activeServiceId)!;
    const alipayBasic = await vault.read(alipayFile);
    assert.match(alipayBasic, /source_product: 淘宝合成商品/u);
    assert.match(alipayBasic, /source_transaction_type: 日用百货/u);
    assert.match(alipayBasic, /source_payment_method: 合成支付宝付款方式/u);
    assert.match(alipayBasic, /source_state: 等待发货/u);
    assert.doesNotMatch(alipayBasic, /PRIVATE-ALIPAY-ACCOUNT/u, "counterparty account is not persisted");
    const beforeAlipay = serviceCalls;
    const alipayOrganized = await finance.prepareImport(alipayImported.created, new AbortController().signal);
    assert.equal(serviceCalls, beforeAlipay + 1, "Alipay newly saved rows enter the same Skill organization chain");
    await finance.applyImportSuggestions(alipayImported.created, alipayOrganized.rows, new AbortController().signal);
    const alipaySaved = finance.entries().find((item) => item.id === activeServiceId)!;
    assert.deepEqual([alipaySaved.merchant, alipaySaved.account, alipaySaved.category, alipaySaved.description, alipaySaved.icon],
      ["模型平台商户", "模型支付宝账户", "购物", "整理后的商品", "taobao"]);
    assert.deepEqual([alipaySaved.amountCents, alipaySaved.kind, alipaySaved.status, alipaySaved.date, alipaySaved.sourceId],
      [1850, "expense", "completed", "2026-09-22 10:00:00", "SYNTHETIC-ALIPAY-ORDER"], "model output cannot alter source facts");
    assert.equal(await finance.finalizeImportedAccounts(new Set([activeServiceId])), 1, "Alipay final account joins the existing catalog");
    const alipayRepeated = await finance.confirmImport(alipayRows);
    assert.equal(alipayRepeated.added, 0);
    await finance.prepareImport(alipayRepeated.created, new AbortController().signal);
    assert.equal(serviceCalls, beforeAlipay + 1, "repeat import neither adds notes nor calls the model");

    const emptyStore = new LifestyleStore(path.join(directory, "empty.json"));
    await emptyStore.initialize();
    const pathsVault = new FakeVault();
    const pathsApp = { vault: pathsVault, fileManager: { processFrontMatter: pathsVault.processFrontMatter.bind(pathsVault), renameFile: pathsVault.rename.bind(pathsVault) } } as unknown as App;
    const pathsLedger = new FinanceLedger(pathsApp, emptyStore);
    await pathsLedger.initialize();
    assert.equal(pathsLedger.paths().directory, "finance/transactions", "first enable creates the English folder");
    assert.equal([...pathsVault.files.keys()].filter((name) => name.endsWith(".base")).length, 1);
    await pathsLedger.add(entry("folder-path", 2345));
    const customBase = parse(pathsVault.files.get("finance/ledger.base")!.text) as Record<string, unknown>;
    (customBase.views as Record<string, unknown>[]).push({ name: "分类视图", filters: ['file.inFolder("finance/transactions")', 'note.category == "餐饮"'], order: ["note.amount"] });
    pathsVault.files.get("finance/ledger.base")!.text = stringify(customBase);
    await pathsVault.rename(pathsVault.getAbstractFileByPath("finance/transactions")!, "finance/账目（transactions）");
    pathsLedger.onRename("finance/transactions", "finance/账目（transactions）");
    await pathsVault.rename(pathsVault.getAbstractFileByPath("finance")!, "财务（finance）");
    pathsLedger.onRename("finance", "财务（finance）");
    await pathsLedger.reload();
    assert.equal(pathsLedger.entries().length, 1);
    assert.equal(pathsLedger.paths().base, "财务（finance）/ledger.base");
    const bilingualBase = parse(pathsVault.files.get(pathsLedger.paths().base)!.text) as Record<string, unknown>;
    assert.match(JSON.stringify(bilingualBase.filters), /财务（finance）\/账目（transactions）/u);
    assert.match(JSON.stringify(bilingualBase.views), /note\.category/u, "custom view keeps its extra condition");
    assert.doesNotMatch(JSON.stringify(bilingualBase.views), /file\.inFolder\(\\?"finance\/transactions/u);
    assert.match(pathsVault.files.get(pathsLedger.fileFor("folder-path")!.path)!.text, /财务（finance）\/ledger\.base/u);
    const bilingualNotePath = pathsLedger.fileFor("folder-path")!.path;
    pathsVault.files.get(bilingualNotePath)!.text = pathsVault.files.get(bilingualNotePath)!.text
      .replace("![[财务（finance）/ledger.base#本笔账目]]", "![[finance/ledger.base#本笔账目]]");
    const restart = new FinanceLedger(pathsApp, emptyStore);
    await restart.initialize();
    assert.equal(restart.paths().directory, "财务（finance）/账目（transactions）", "restart reuses the bilingual folder");
    assert.equal(restart.entries().length, 1);
    assert.match(pathsVault.files.get(bilingualNotePath)!.text, /!\[\[财务（finance）\/ledger\.base#本笔账目\]\]/u, "restart repairs an embedded Base link left by an interrupted rename");
    pathsVault.folders.add("finance"); pathsVault.folders.add("finance/transactions");
    await pathsVault.rename(pathsVault.getAbstractFileByPath("财务（finance）/ledger.base")!, "finance/ledger.base");
    restart.onRename("财务（finance）/ledger.base", "finance/ledger.base");
    await pathsVault.rename(pathsVault.getAbstractFileByPath(bilingualNotePath)!, "finance/transactions/folder-path.md");
    restart.onRename(bilingualNotePath, "finance/transactions/folder-path.md");
    await restart.reconcileLocation();
    assert.equal(restart.entries().length, 1, "file-by-file restore keeps the same account");
    assert.equal(restart.paths().directory, "finance/transactions");
    assert.match(pathsVault.files.get("finance/transactions/folder-path.md")!.text, /!\[\[finance\/ledger\.base#本笔账目\]\]/u);
    assert.equal([...pathsVault.files.keys()].filter((name) => name.endsWith(".base")).length, 1);
    await pathsVault.rename(pathsVault.getAbstractFileByPath("finance")!, "my-money");
    restart.onRename("finance", "my-money");
    await restart.reload();
    assert.equal(restart.paths().directory, "my-money/transactions", "a user-chosen folder name retains the ledger location");
    assert.equal(restart.entries().length, 1);
    pathsVault.files.get("my-money/transactions/folder-path.md")!.text = pathsVault.files.get("my-money/transactions/folder-path.md")!.text
      .replace("![[my-money/ledger.base#本笔账目]]", "![[finance/ledger.base#本笔账目]]");
    const customRestart = new FinanceLedger(pathsApp, emptyStore);
    await customRestart.initialize();
    assert.equal(customRestart.entries().length, 1);
    assert.match(pathsVault.files.get("my-money/transactions/folder-path.md")!.text, /!\[\[my-money\/ledger\.base#本笔账目\]\]/u, "restart repairs a managed embed after custom folder rename");

    const oldVault = new FakeVault();
    const oldApp = { vault: oldVault, fileManager: { processFrontMatter: oldVault.processFrontMatter.bind(oldVault), renameFile: oldVault.rename.bind(oldVault) } } as unknown as App;
    oldVault.folders.add("EchoInk/财务"); oldVault.folders.add("EchoInk/财务/账目");
    const oldConfig = { filters: 'file.inFolder("EchoInk/财务/账目")', views: [{ name: "原视图", filters: ['file.inFolder("EchoInk/财务/账目")', 'note.category == "餐饮"'], order: ["note.amount"] }] };
    await oldVault.create("EchoInk/财务/账本.base", stringify(oldConfig));
    await oldVault.create("EchoInk/财务/账目/old.md", firstText);
    const oldLedger = new FinanceLedger(oldApp, emptyStore);
    await oldLedger.initialize();
    assert.equal(oldLedger.entries().length, 1);
    assert.equal(financeSummary(oldLedger.entries(), "2026-09").netExpenseCents, 1234);
    assert.equal(oldLedger.paths().base, "finance/ledger.base");
    assert.equal(oldVault.files.has("EchoInk/财务/账本.base"), false);
    assert.match(JSON.stringify((parse(oldVault.files.get("finance/ledger.base")!.text) as Record<string, unknown>).views), /note\.category/u);
    assert.doesNotMatch(oldVault.files.get("finance/ledger.base")!.text, /EchoInk\/财务/u);

    const interruptedVault = new FakeVault();
    const interruptedApp = { vault: interruptedVault, fileManager: { processFrontMatter: interruptedVault.processFrontMatter.bind(interruptedVault), renameFile: interruptedVault.rename.bind(interruptedVault) } } as unknown as App;
    interruptedVault.folders.add("finance"); interruptedVault.folders.add("finance/transactions");
    await interruptedVault.create("finance/ledger.base", stringify({ ...oldConfig, filters: 'file.inFolder("finance/账目")' }));
    await interruptedVault.create("finance/transactions/old.md", firstText);
    const resumed = new FinanceLedger(interruptedApp, emptyStore);
    await resumed.initialize();
    assert.equal(resumed.entries().length, 1);
    assert.match(interruptedVault.files.get("finance/ledger.base")!.text, /file\.inFolder\("finance\/transactions"\)/u, "interrupted migration repairs the intermediate Base filter");
    assert.doesNotMatch(interruptedVault.files.get("finance/ledger.base")!.text, /EchoInk\/财务/u, "custom view also follows the resumed move");

    const conflictVault = new FakeVault();
    const conflictApp = { vault: conflictVault, fileManager: { processFrontMatter: conflictVault.processFrontMatter.bind(conflictVault), renameFile: conflictVault.rename.bind(conflictVault) } } as unknown as App;
    conflictVault.folders.add("EchoInk/财务"); conflictVault.folders.add("finance");
    await conflictVault.create("EchoInk/财务/账本.base", stringify(oldConfig));
    await conflictVault.create("finance/ledger.base", "user-owned Base");
    await assert.rejects(new FinanceLedger(conflictApp, emptyStore).initialize(), /多份财务账本/u);
    assert.equal(conflictVault.files.get("finance/ledger.base")!.text, "user-owned Base", "conflict never overwrites the target");
    console.log("OK lifestyle finance Vault migration, invalid notes, native edits, import preservation, batch reads");
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

class LifestyleFinanceService extends ProductionFinanceService {
  constructor(service: ConstructorParameters<typeof ProductionFinanceService>[0]) { super(service, paidTestAccess); }
}
