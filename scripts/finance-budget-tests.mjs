import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root,".tmp"),{ recursive:true });
const directory = await mkdtemp(path.join(root,".tmp", "finance-budget-test-"));
try {
  const target = path.join(directory, "budget.mjs");
  await esbuild.build({ stdin: { contents: 'export { paidTestAccess } from "./src/tests/membership-access"; export * from "./src/lifestyle/finance-budget"; export { LifestyleStore, EMPTY_LIFESTYLE_DATA } from "./src/lifestyle/store"; export { LifestyleFinanceService } from "./src/lifestyle/finance-service";', resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: target, external: ["read-excel-file/node", "yaml", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"], loader: { ".md": "text", ".svg": "dataurl" }, banner: { js: `import {createRequire} from "node:module"; const require = createRequire(${JSON.stringify(path.join(root,"package.json"))});` }, alias: { obsidian: path.join(root, "src/tests/obsidian-shim.ts") } });
  const api = await import(pathToFileURL(target).href);
  const file = path.join(directory,"lifestyle.json");
  const old = { ...structuredClone(api.EMPTY_LIFESTYLE_DATA), budgets: [{ month: "2026-10", totalCents: 100000, allocations: { "餐饮": 20000 } }], places: [{ id: "map-preserved" }], healthRecords: [{ id: "health-preserved" }], futurePlugin: { keep: true } }; delete old.financeDefaultBudget;
  await writeFile(file,JSON.stringify(old)); const store = new api.LifestyleStore(file); await store.initialize();
  assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-11"), null);
  assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-10").totalCents,100000);
  await assert.rejects(new api.LifestyleFinanceService({ store, plugin:{ app:{}, accountService: api.paidTestAccess } }).saveBudgetChanges({ overrides:[],removedMonths:["2026-10"] }),/先设置/);
  let writes = 0; const originalUpdate = store.update.bind(store); store.update = mutate => { writes++; return originalUpdate(mutate); };
  const service = new api.LifestyleFinanceService({ store, plugin: { app: {}, accountService: api.paidTestAccess } });
  const changes = { defaultBudget: { totalCents: 300000, allocations: { "餐饮": 40000, "交通": 20000 } }, overrides: [{ month: "2026-12", totalCents: 500000, allocations: { "旅行": 100000 } }], removedMonths: [] };
  await service.saveBudgetChanges(changes); assert.equal(writes,1);
  const effective = api.effectiveFinanceBudget(store.snapshot(),"2026-11"); assert.equal(effective.month,"2026-11"); assert.equal(effective.totalCents,300000); effective.allocations["餐饮"] = 1; assert.equal(store.snapshot().financeDefaultBudget.allocations["餐饮"],40000);
  assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-12").allocations["餐饮"],undefined,"override is complete, never merged");
  const reloaded = new api.LifestyleStore(file); await reloaded.initialize(); assert.deepEqual(reloaded.snapshot().financeDefaultBudget,changes.defaultBudget); assert.deepEqual(JSON.parse(await readFile(file,"utf8")).futurePlugin,{ keep: true }); assert.equal(reloaded.snapshot().places[0].id,"map-preserved"); assert.equal(reloaded.snapshot().healthRecords[0].id,"health-preserved");
  service.entries = () => []; const input = service.analysisInput("2026-11"); assert.equal(input.facts.budget_total,"¥ 3,000.00"); assert.equal(input.facts.budget_allocated,"¥ 600.00");
  await service.saveBudgetChanges({ overrides: [], removedMonths: ["2026-10"] }); assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-10").totalCents,300000);
  await service.saveBudgetChanges({ defaultBudget: { totalCents:400000, allocations:{} }, overrides: [], removedMonths: [] }); assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-10").totalCents,400000); assert.equal(api.effectiveFinanceBudget(store.snapshot(),"2026-12").totalCents,500000);
  const before = await readFile(file,"utf8"); await assert.rejects(service.saveBudgetChanges({ defaultBudget: { totalCents:100000, allocations:{} }, overrides:[{ month:"2026-13", totalCents:100000, allocations:{} }], removedMonths:[] }),/月份/); assert.equal(await readFile(file,"utf8"),before); assert.equal(store.snapshot().financeDefaultBudget.totalCents,400000);
  const noDefault = new api.FinanceBudgetEditor(old,"2026-10"); assert.equal(noDefault.canRestore,false); assert.throws(() => noDefault.restore("2026-10"),/先设置/); assert.ok(noDefault.months.has("2026-10")); noDefault.defaultDraft.total = "3500"; noDefault.defaultDraft.dirty = true; assert.equal(noDefault.canRestore,true); noDefault.restore("2026-10"); assert.equal(noDefault.changes().defaultBudget.totalCents,350000);
  const editor = new api.FinanceBudgetEditor(store.snapshot(),"2026-10"); editor.defaultDraft.total = "5000.01"; editor.defaultDraft.dirty = true; editor.defaultDraft.values["餐饮"] = "1200.01"; editor.add("2027-01"); assert.equal(editor.months.get("2027-01").total,"5000.01"); assert.throws(() => editor.add("2027-01"),/已有/); editor.months.get("2027-01").total = "6000.01"; editor.restore("2026-12"); const patch = editor.changes(); assert.equal(patch.overrides[0].totalCents,600001); assert.equal(patch.defaultBudget.totalCents,500001); assert.deepEqual(patch.removedMonths,["2026-12"]);
  editor.months.get("2027-01").total = ""; assert.throws(() => editor.changes(),/2027-01/); assert.equal(editor.defaultDraft.total,"5000.01"); assert.equal(await readFile(file,"utf8"),before,"drafts/cancel have no writes");
  const percent = { total:"0.03", values:{ "餐饮":"33.33", "交通":"33.33" }, mode:"percent", dirty:true }; assert.throws(() => api.parseFinanceBudgetDraft(percent,"2026-10"),/总预算/); percent.total="100.01"; const budget = api.parseFinanceBudgetDraft(percent,"2026-10"); assert.ok(Object.values(budget.allocations).every(Number.isInteger));
  // A real filesystem failure leaves the store's prior snapshot and all drafts intact.
  const failing = new api.LifestyleStore(path.join(directory,"blocked","store.json")); await writeFile(path.join(directory,"blocked"),"file"); const failingService = new api.LifestyleFinanceService({ store:failing, plugin:{ app:{}, accountService: api.paidTestAccess } }); await assert.rejects(failingService.saveBudgetChanges(patch)); assert.equal(failing.snapshot().financeDefaultBudget,null); assert.equal(editor.months.get("2027-01").total,"");
  console.log("PASS budgets: legacy monthly overrides, complete default precedence/copy/month, persistent reload/other plugin fields, AI effective input, restore/update default, one atomic batch, validation/failure rollback, independent raw drafts/duplicate/add/remove/precision/cancel.");
} finally { await rm(directory,{ recursive:true, force:true }); }
