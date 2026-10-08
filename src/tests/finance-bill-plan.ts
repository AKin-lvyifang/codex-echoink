import { paidTestAccess } from "./membership-access";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "obsidian";
import { parse, stringify } from "yaml";
import { LifestyleStore, type FinanceEntry } from "../lifestyle/store";
import { LifestyleFinanceService as ProductionFinanceService } from "../lifestyle/finance-service";
import type { LifestyleService } from "../lifestyle/service";
import { FakeVault } from "./lifestyle-finance-ledger";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import { financeEntryCsv, financeSummary } from "../lifestyle/finance-domain";
import { financeBillPlanStats, filterFinanceBillPlanEntries, emptyFinanceBillPlanFilters, reconcileFinanceBillPlanSelection, sortFinanceBillPlanEntries } from "../lifestyle/finance-bill-plan";
import { parseFinanceNote } from "../lifestyle/finance-ledger";

const entry = (id: string, amountCents: number, patch: Partial<FinanceEntry> = {}): FinanceEntry => ({ id, source: "manual", sourceId: id,
  date: "2026-09-30", merchant: `商户${id}`, category: "交通", account: "银行卡", amountCents, status: "completed", kind: "expense", currency: "CNY", description: "车票", note: "", ...patch });
export async function runFinanceBillPlanTests(): Promise<void> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-bill-plan-"));
  try {
    const json = path.join(directory, "lifestyle.json");
    const store = new LifestyleStore(json); await store.initialize();
    assert.deepEqual(store.snapshot().financeBillPlans, []);
    const vault = new FakeVault();
    const app = { vault, fileManager: { processFrontMatter: vault.processFrontMatter.bind(vault), renameFile: vault.rename.bind(vault) } } as unknown as App;
    const service = new LifestyleFinanceService({ store, plugin: { app, settings: { lifestyle: structuredClone(DEFAULT_LIFESTYLE_SETTINGS) }, registerEvent() {} } } as unknown as LifestyleService);
    await service.initialize();
    await Promise.all([service.saveBillPlan({ id: "trip", name: "旅行", budgetCents: 10000 }), service.saveBillPlan({ id: "party", name: "聚会", budgetCents: 20000 })]);
    await assert.rejects(service.saveBillPlan({ id: "bad", name: "", budgetCents: 0 }));
    const rows = [entry("a", 8000, { billPlanId: "trip" }), entry("b", 4000, { date: "2026-10-01", billPlanId: "trip", category: "餐饮" }),
      entry("refund", 3000, { kind: "refund", date: "2026-10-02", billPlanId: "trip" }), entry("income", 99999, { kind: "income", billPlanId: "trip" }),
      entry("transfer", 99999, { kind: "transfer", billPlanId: "trip" }), entry("failed", 99999, { status: "failed", billPlanId: "trip" }),
      entry("foreign", 99999, { currency: "USD", billPlanId: "trip" }), entry("future", 99999, { date: "2099-01-01", billPlanId: "trip" }), entry("free", 5000)];
    for (const row of rows) await service.ledger.add(row);
    const plan = service.billPlans()[0];
    const stats = financeBillPlanStats(plan, service.entries(), "2026-10-06");
    assert.equal(stats.entries.length, 8); assert.equal(stats.grossCents, 12000); assert.equal(stats.refundsCents, 3000);
    assert.equal(stats.netCents, 9000); assert.equal(stats.remainingCents, 1000); assert.equal(stats.progress, .9);
    assert.equal(stats.largest?.id, "a"); assert.equal(stats.smallest?.id, "b"); assert.equal(stats.averageCents, 6000);
    assert.deepEqual(stats.categories.map(([category, value]) => [category, value.amountCents]), [["交通", 8000], ["餐饮", 4000]]);
    assert.equal(financeSummary(service.entries(), "2026-09").grossExpenseCents, 13000, "monthly reporting remains monthly");
    assert.equal(financeBillPlanStats(plan, [], "2026-10-06").largest, null);
    assert.equal(financeBillPlanStats({ ...plan, budgetCents: 1000 }, rows, "2026-10-06").remainingCents, -8000);
    assert.equal(financeBillPlanStats(plan, [rows[2]], "2026-10-06").netCents, -3000);
    await service.saveBillPlan({ ...plan, name: "跨月旅行" });
    const reloaded = new LifestyleStore(json); await reloaded.initialize();
    assert.equal(reloaded.snapshot().financeBillPlans.find(p => p.id === "trip")!.name, "跨月旅行");
    assert.equal(reloaded.snapshot().financePlans.length, 0);
    const a = service.ledger.fileFor("a")!;
    const raw = vault.files.get(a.path)!;
    raw.text += "\n人工正文\n";
    await vault.processFrontMatter(a, fields => { fields.custom = "保留"; });
    await service.updateDetails("a", "改商户", "改说明", "auto");
    assert.equal(parseFinanceNote(raw.text)!.billPlanId, "trip", "undefined preserves association");
    await service.updateDetails("a", "改商户", "改说明", "auto", undefined, undefined, "party");
    assert.equal(parseFinanceNote(raw.text)!.billPlanId, "party");
    await service.updateDetails("a", "改商户", "改说明", "auto", undefined, undefined, null);
    assert.equal(parseFinanceNote(raw.text)!.billPlanId, undefined);
    assert.ok(raw.text.includes("人工正文")); assert.ok(raw.text.includes("custom: 保留"));
    const originalProcess = app.fileManager.processFrontMatter;
    app.fileManager.processFrontMatter = async (file, callback) => { if (file === service.ledger.fileFor("b")) throw new Error("injected patch failure"); return originalProcess(file, callback); };
    const partial = await service.associateBillPlan(["a", "b", "free"], "party");
    assert.deepEqual(partial.applied, ["a", "free"]); assert.equal(partial.failed[0].id, "b");
    assert.equal(service.entries().find(e => e.id === "b")!.billPlanId, "trip");
    app.fileManager.processFrontMatter = originalProcess;
    await service.associateBillPlan(["b"], "party");
    const legacySnapshot = { ...service.entries().find(e => e.id === "free")! };
    await service.associateBillPlan(["free"], "trip");
    const callback: FinanceEntry[] = [];
    await service.applyImportSuggestions([{ entry: legacySnapshot }], [{ entry: { ...legacySnapshot, merchant: "模型商户" }, raw: [], error: "" }], new AbortController().signal, e => callback.push(e));
    assert.equal(callback[0].billPlanId, "trip", "old AI callback snapshot must retain latest manual binding");
    assert.equal(service.entries().find(e => e.id === "free")!.billPlanId, "trip");
    const duplicate = await service.confirmImport([{ entry: { ...legacySnapshot, billPlanId: undefined }, error: "", raw: [] }]);
    assert.equal(duplicate.duplicates, 1); assert.equal(service.entries().find(e => e.id === "free")!.billPlanId, "trip");
    const base = await service.ledger.ensureBaseFile();
    const baseRecord = vault.files.get(base.path)!;
    const custom = parse(baseRecord.text); delete custom.properties["note.bill_plan_id"]; custom.filters = "USER FILTER"; custom.views[0].order = ["note.amount", "note.merchant"]; custom.properties.custom = { displayName: "自定义" };
    baseRecord.text = stringify(custom); await service.ledger.ensureBaseFile();
    const merged = parse(baseRecord.text); assert.equal(merged.filters, "USER FILTER"); assert.deepEqual(merged.views[0].order, custom.views[0].order); assert.ok(merged.properties.custom); assert.ok(merged.properties["note.bill_plan_id"]);
    const noProperties = { ...merged }; delete noProperties.properties;
    baseRecord.text = stringify(noProperties); await service.ledger.ensureBaseFile();
    const restored = parse(baseRecord.text);
    assert.ok(restored.properties["note.merchant"]); assert.ok(restored.properties["note.date"]);
    assert.ok(restored.properties["note.bill_plan_id"]); assert.equal(restored.filters, "USER FILTER");
    assert.deepEqual(restored.views[0].order, custom.views[0].order);
    await service.ledger.reload(); assert.equal(service.entries().find(e => e.id === "free")!.billPlanId, "trip");
    assert.ok(financeEntryCsv(service.entries()).includes('"账单计划 ID"')); assert.ok(financeEntryCsv(service.entries()).includes('"trip"'));
    const filters = { ...emptyFinanceBillPlanFilters(), from: "2026-10-01", to: "2026-10-02", search: "商户", category: "餐饮", merchant: "商户b", account: "银行卡", kind: "expense" as const };
    assert.deepEqual(filterFinanceBillPlanEntries(rows, filters).map(e => e.id), ["b"]);
    const selection = new Set(["a", "b", "free"]); reconcileFinanceBillPlanSelection(selection, [rows[1], rows[8]], "trip"); assert.deepEqual([...selection], ["free"]);
    assert.deepEqual(sortFinanceBillPlanEntries([rows[0], rows[1]], "amount-asc").map(e => e.id), ["b", "a"]);
    console.log("PASS bill plans: Store reload/rename, full lifecycle/refunds/validity, Markdown patch/unbind/partial retry, duplicate/AI protection, Base preservation and filters");
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

/** Real jsdom nodes and Origin/Radix checkboxes; the financial host remains in memory. */
export async function runFinanceBillPlanDomTests(win: Window & typeof globalThis): Promise<void> {
  const create = function(this: HTMLElement, tag: string, options: any = {}) {
    if (typeof options === "string") options = { cls: options };
    const el = this.ownerDocument.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
    for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
    this.appendChild(el); return el;
  };
  Object.assign(win.Element.prototype, { createEl: create, createDiv(options: any) { return create.call(this, "div", options); }, createSpan(options: any) { return create.call(this, "span", options); },
    empty() { this.replaceChildren(); }, addClass(...tokens: string[]) { this.classList.add(...tokens); }, removeClass(...tokens: string[]) { this.classList.remove(...tokens); },
    toggleClass(token: string, force: boolean) { this.classList.toggle(token, force); }, hasClass(token: string) { return this.classList.contains(token); },
    setText(text: string) { this.textContent = text; }, setAttr(key: string, value: string) { this.setAttribute(key, value); }, scrollIntoView() {} });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const { FinanceWorkspace } = await import("../lifestyle/finance-view");
  const { openTestModals } = await import("./obsidian-shim");
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "echoink-bill-plan-dom-"));
  const parent = win.document.body.createDiv({ cls: "echoink-lifestyle-view" });
  const host = parent.createDiv();
  let workspace: InstanceType<typeof FinanceWorkspace> | null = null;
  try {
    const store = new LifestyleStore(path.join(directory, "lifestyle.json")); await store.initialize();
    const vault = new FakeVault();
    const plugin = { app: { vault, fileManager: { processFrontMatter: vault.processFrontMatter.bind(vault), renameFile: vault.rename.bind(vault) } },
      settings: { lifestyle: structuredClone(DEFAULT_LIFESTYLE_SETTINGS) }, registerEvent() {} };
    plugin.settings.lifestyle.finance.enabled = true;
    const service = { store, plugin } as unknown as LifestyleService;
    const finance = new LifestyleFinanceService(service); Object.assign(service, { finance }); await finance.initialize();
    await finance.saveBillPlan({ id: "trip", name: "跨月旅行", budgetCents: 20000 }); await finance.saveBillPlan({ id: "party", name: "聚会", budgetCents: 10000 });
    for (const row of [entry("first", 8000), entry("second", 6000, { date: "2026-10-01", billPlanId: "party" }), entry("third", 3000, { category: "餐饮", billPlanId: "trip" })]) await finance.ledger.add(row);
    workspace = new FinanceWorkspace(service); const state = workspace as any; state.state.page = "billPlans";
    workspace.render(host);
    const click = (label: string, root: ParentNode = host): void => {
      const control = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(control => control.textContent === label);
      assert.ok(control, `missing action ${label}`); control.click();
    };
    const toggle = (id: string) => host.querySelector<HTMLButtonElement & { checked: boolean; indeterminate: boolean }>(`[data-plan-entry-id="${id}"]`)!;
    const all = () => host.querySelector<HTMLButtonElement & { checked: boolean; indeterminate: boolean }>("[data-plan-select-all]")!;
    const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    assert.equal(tabs().length, 4); assert.equal(host.querySelector(".echoink-finance-month"), null);
    parent.scrollTop = 124;
    host.querySelector<HTMLButtonElement>('[data-plan-focus="plan:trip"]')!.click();
    assert.equal(parent.scrollTop, 0); assert.ok(host.querySelector(".echoink-finance-bill-donut svg"));
    parent.scrollTop = 66; click("关联已有记录");
    assert.equal(toggle("third").disabled, true); assert.ok(host.textContent?.includes("来自：聚会"));
    toggle("first").focus(); toggle("first").click(); assert.equal(all().indeterminate, true); assert.equal(win.document.activeElement?.getAttribute("data-plan-entry-id"), "first");
    all().click(); assert.equal(all().checked, true); assert.ok(host.textContent?.includes("将有 1 笔从其他账单移入"));
    const search = host.querySelector<HTMLInputElement>('[data-plan-filter="search"]')!; search.value = "商户first"; search.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.ok(host.textContent?.includes("已选 1 笔")); click("取消");
    assert.equal(parent.scrollTop, 66); assert.equal(finance.entries().find(e => e.id === "first")!.billPlanId, undefined);
    assert.equal(finance.entries().find(e => e.id === "second")!.billPlanId, "party");
    assert.equal((win.document.activeElement as HTMLElement).dataset.planFocus, "associate");
    click("关联已有记录");
    const from = host.querySelector<HTMLInputElement>('[data-plan-filter="from"]')!; from.value = "2026-10-01"; from.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(toggle("first"), null); assert.ok(toggle("second"));
    const to = host.querySelector<HTMLInputElement>('[data-plan-filter="to"]')!; to.value = "2026-09-01"; to.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(all().disabled, true); assert.equal(Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(e => e.textContent === "确认关联 0 笔")!.disabled, true);
    click("取消"); click("关联已有记录"); all().click();
    const originalAssociate = finance.associateBillPlan.bind(finance); let finish!: () => void; let called = 0;
    finance.associateBillPlan = async (ids, id) => { called++; await new Promise<void>(resolve => { finish = resolve; }); return originalAssociate(ids, id); };
    const originalPatch = plugin.app.fileManager.processFrontMatter;
    plugin.app.fileManager.processFrontMatter = async (file, update) => { if (file === finance.ledger.fileFor("second")) throw new Error("DOM partial failure"); return originalPatch(file, update); };
    click("确认关联 2 笔"); assert.equal(all().disabled, true); assert.ok(tabs().every(tab => tab.disabled));
    click("保存中…"); assert.equal(called, 1); finish(); await flush();
    assert.ok(host.textContent?.includes("已关联 1 笔，1 笔未成功")); assert.equal(toggle("second").checked, true); assert.equal(toggle("first").disabled, true);
    plugin.app.fileManager.processFrontMatter = originalPatch; finance.associateBillPlan = originalAssociate;
    click("确认关联 1 笔"); await flush(); assert.ok(host.querySelector(".echoink-finance-bill-summary"));
    assert.equal(finance.entries().filter(e => e.billPlanId === "trip").length, 3);
    const segment = host.querySelector<SVGElement>('.echoink-finance-bill-category-target[data-category="餐饮"]')!;
    segment.dispatchEvent(new win.Event("focus")); assert.equal(host.querySelector<HTMLElement>(".echoink-finance-bill-tooltip")!.hidden, false);
    assert.ok(host.querySelector(".echoink-finance-bill-tooltip")!.textContent?.includes("17.6%"));
    segment.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); assert.equal(host.querySelectorAll(".echoink-finance-transaction").length, 1);
    segment.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    segment.dispatchEvent(new win.Event("blur")); assert.equal(host.querySelector<HTMLElement>(".echoink-finance-bill-tooltip")!.hidden, true);

    const category = host.querySelector<HTMLButtonElement>('button[data-category="餐饮"]')!; category.click();
    assert.equal(host.querySelectorAll(".echoink-finance-transaction").length, 1); category.click();
    const sort = host.querySelector<HTMLSelectElement>(".echoink-finance-bill-details select")!; sort.value = "amount-asc"; sort.dispatchEvent(new win.Event("change", { bubbles: true }));
    assert.ok(host.querySelector(".echoink-finance-transaction")!.textContent?.includes("商户third"));
    click("记一笔"); const manual = openTestModals.at(-1)!;
    const fields = Array.from(manual.contentEl.querySelectorAll<HTMLInputElement>("input")); fields[0].value = "11.25"; fields[1].value = "手记商户";
    manual.contentEl.querySelector<HTMLFormElement>("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await flush();
    assert.equal(finance.entries().find(e => e.merchant === "手记商户")!.billPlanId, "trip"); assert.equal(state.state.page, "billPlans");
    host.querySelector<HTMLElement>(".echoink-finance-transaction")!.click(); const detail = openTestModals.at(-1)!;
    const planSelect = Array.from(detail.contentEl.querySelectorAll<HTMLSelectElement>("select")).at(-1)!; planSelect.value = "";
    click("保存修改", detail.contentEl); await flush(); assert.equal(finance.entries().find(e => e.merchant === "手记商户")!.billPlanId, undefined);
    click("‹ 返回"); assert.equal(parent.scrollTop, 124); assert.equal((win.document.activeElement as HTMLElement).dataset.planFocus, "plan:trip");
    click("新建账单"); const creation = openTestModals.at(-1)!; const inputs = Array.from(creation.contentEl.querySelectorAll<HTMLInputElement>("input"));
    assert.equal(inputs.length, 2); inputs[0].value = "生日活动"; inputs[1].value = "200";
    creation.contentEl.querySelector<HTMLFormElement>("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await flush();
    assert.ok(host.textContent?.includes("生日活动"));
    state.go("budget"); assert.ok(host.querySelector(".echoink-finance-month"));
    tabs()[2].dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); assert.equal(state.state.page, "billPlans");
    state.go("ledger"); click("记一笔"); const plain = openTestModals.at(-1)!; const plainFields = Array.from(plain.contentEl.querySelectorAll<HTMLInputElement>("input")); plainFields[0].value = "2"; plainFields[1].value = "普通记账";
    plain.contentEl.querySelector<HTMLFormElement>("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); await flush();
    assert.equal(finance.entries().find(e => e.merchant === "普通记账")!.billPlanId, undefined);
    state.go("billPlans"); state.billPlanView.showPlan("trip");
    const standardAdd = host.querySelector<HTMLButtonElement>(".echoink-finance-action-button.echoink-finance-primary")!;
    assert.equal(standardAdd.querySelectorAll(".echoink-finance-action-icon").length, 1);
    assert.ok(host.textContent?.includes("修改预算")); assert.ok(!host.textContent?.includes("调整账单"));
    click("修改预算"); const editing = openTestModals.at(-1)!;
    assert.equal(editing.titleEl.textContent, "修改预算");
    const editFields = Array.from(editing.contentEl.querySelectorAll<HTMLInputElement>("input"));
    assert.equal(editFields.length, 2); editFields[1].value = "250";
    const savePlan = finance.saveBillPlan.bind(finance); let savedBudget: Promise<void> | undefined;
    finance.saveBillPlan = plan => (savedBudget = savePlan(plan));
    assert.ok(Array.from(editing.contentEl.querySelectorAll<HTMLButtonElement>("button")).some(button => button.textContent === "保存预算"));
    // Modal shim remains detached: dispatch submission as the existing creation fixtures do.
    editing.contentEl.querySelector<HTMLFormElement>("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    assert.ok(savedBudget); await savedBudget; await flush();
    finance.saveBillPlan = savePlan; assert.equal(finance.billPlans().find(p => p.id === "trip")!.budgetCents, 25000);
    const originalEntries = finance.entries.bind(finance);
    const many = Array.from({ length: 120 }, (_, index) => entry(`long-${index}`, 100 + index));
    finance.entries = () => [...originalEntries(), ...many];
    click("关联已有记录");
    const longRows = () => host.querySelector<HTMLElement>(".echoink-finance-bill-association-content")!;
    assert.ok(longRows().querySelectorAll(".echoink-finance-bill-select-row").length >= 120);
    assert.ok(longRows().querySelector(".echoink-finance-bill-association-controls"));
    assert.ok(!longRows().querySelector(".echoink-finance-bill-association-footer"));
    assert.equal(host.querySelector(".echoink-finance-bill-association-footer")!.contains(all()), true);
    longRows().scrollTop = 1700; toggle("long-70").focus({ preventScroll: true }); toggle("long-70").click();
    assert.equal(longRows().scrollTop, 1700); assert.equal(win.document.activeElement?.getAttribute("data-plan-entry-id"), "long-70");
    all().click(); assert.equal(longRows().scrollTop, 1700); assert.equal(all().checked, true);
    const longSearch = host.querySelector<HTMLInputElement>('[data-plan-filter="search"]')!;
    longSearch.focus({ preventScroll: true });
    longSearch.value = "商户long-119"; longSearch.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(longRows().scrollTop, 1700); assert.equal(win.document.activeElement, longSearch); assert.ok(host.textContent?.includes("已选 1 笔"));
    click("取消"); assert.equal(finance.entries().find(e => e.id === "long-119")!.billPlanId, undefined);
    finance.entries = originalEntries;
    console.log("PASS bill-plan DOM: four tabs, internal navigation/scroll/focus, Origin partial/all selection/filter pruning/cancel, partial-save retry/disabled, dashboard sorting/category, creation and ordinary/plan defaults, shared action/edit wording, 120-row selection and filter scroll/focus");
  } finally { workspace?.detach(); for (const modal of [...openTestModals]) modal.close(); parent.remove(); await fsp.rm(directory, { recursive: true, force: true }); }
}

class LifestyleFinanceService extends ProductionFinanceService {
  constructor(service: ConstructorParameters<typeof ProductionFinanceService>[0]) { super(service, paidTestAccess); }
}
