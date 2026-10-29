import assert from "node:assert/strict";
import { DiaryOrganizerEngine } from "../diary-organizer/engine";
import { diaryFingerprint } from "../diary-organizer/identity";
import { validateDiaryCandidate, financeDuplicateCandidates } from "../diary-organizer/validation";
import { classifyImport, financeEntryCsv, filterFinanceEntries } from "../lifestyle/finance-domain";
import { FinanceLedger, parseFinanceNote } from "../lifestyle/finance-ledger";
import { LifestyleStoreCore, type FinanceEntry } from "../lifestyle/store-core";
import { FakeVault } from "./lifestyle-finance-ledger";
import type { App } from "obsidian";
import type { DiaryCandidate, DiaryOrganizerPorts, DiaryOrganizerState, DiaryWrittenRecord } from "../diary-organizer/types";

export async function runDiaryOrganizerTests() {
  let checks = 0;
  const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };
  const base = { type: "finance", quote: "今天我在梧桐咖啡买了一杯拿铁，自己付了35元。", confidence: "high", occurred: true, ownership: "self", concerns: [], kind: "expense", amountCents: 3500, currency: "CNY", date: "2026-10-28", merchant: "梧桐咖啡", category: "餐饮", description: "拿铁" } as const;
  const categories = { entries: [], categories: [{ name: "餐饮" }] };
  check(validateDiaryCandidate({ ...base }, base.quote, categories).reasons.length === 0, "clear personal expense qualifies");
  for (const quote of ["我打算买35元的拿铁。", "朋友请客，今天他付了35元。", "帮同事付了35元咖啡钱。", "花了一百多元。", "付了35美元。"])
    check(validateDiaryCandidate({ ...base, quote }, quote, categories).reasons.length > 0, quote);
  for (const patch of [{ amountCents: 0 }, { amountCents: 3500.5 }, { date: "2026-02-30" }, { quote: "捏造引用" }, { category: "不存在" }, { confidence: "low" }])
    check(validateDiaryCandidate({ ...base, ...patch } as DiaryCandidate, base.quote, categories).reasons.length > 0, "hard/auto condition fails");
  let now = new Date("2026-10-28T12:00:00").getTime(), enabled = true, pro = true, busy = false, calls = 0;
  let text = base.quote, path = "journal/2026-10-28.md", state: DiaryOrganizerState | null = null;
  let candidates: DiaryCandidate[] = [{ ...base }];
  const written = new Map<string, DiaryWrittenRecord>();
  const ports: DiaryOrganizerPorts = {
    loadState: async () => structuredClone(state), saveState: async value => { state = structuredClone(value); },
    listDiaries: async () => [{ path, date: "2026-10-28", mtime: 0 }], readDiary: async target => target === path ? text : null,
    isEnabled: () => enabled, hasFinanceAccess: () => pro, isBusy: () => busy, now: () => now,
    generateText: async request => { calls++; if (request.purpose === "extract") return JSON.stringify({ candidates });
      const rows = JSON.parse(request.prompt.slice(request.prompt.indexOf("候选与程序筛出的有效近似记录JSON：") + "候选与程序筛出的有效近似记录JSON：".length));
      return JSON.stringify({ decisions: rows.map((row: { id: string }) => ({ id: row.id, decision: "distinct", matchedIds: [], reason: "different" })) }); },
    readFinanceSnapshot: async () => categories, readTodoSnapshot: async () => [],
    writeFinance: async input => { const row = { id: input.extractionId, version: "v1", summary: String(input.candidate.amountCents) }; written.set(input.extractionId, row); return row; },
    writeTodo: async input => { const row = { id: input.extractionId, version: "v1", summary: input.candidate.text }; written.set(input.extractionId, row); return row; },
    updateFinance: async (id, _version, input) => { const row = { id, version: "v2", summary: String(input.candidate.amountCents) }; written.set(input.extractionId, row); return row; },
    findFinance: async id => written.get(id) ?? null, findTodo: async id => written.get(id) ?? null,
    undoFinance: async id => ({ deleted: written.delete(id) }), undoTodo: async id => ({ deleted: written.delete(id) })
  };
  let engine = new DiaryOrganizerEngine(ports);
  await engine.enable(); await engine.runOnce(); now += 3599999; await engine.runOnce();
  check(calls === 0 && written.size === 0, "default one hour must not write early");
  now++; await engine.runOnce(); check(written.size === 1 && calls === 1, "write after stable hour without redundant duplicate model call");
  const id = engine.getState().items[0].id;
  await engine.renameDiary(path, "journal/renamed.md"); path = "journal/renamed.md";
  text = "新增无关段落。\n" + text; await engine.runOnce(); now += 3600000; await engine.runOnce();
  check(engine.getState().items[0].id === id && written.size === 1, "insertion and rename keep extraction identity");
  text = base.quote.replace("35", "30"); candidates = [{ ...base, quote: text, amountCents: 3000 }];
  await engine.runOnce(); now += 3600000; await engine.runOnce();
  check(engine.getState().items[0].status === "review" && written.size === 1 && written.get(id)?.summary === "3500", "changed amount goes to review without editing ledger");
  const changed = engine.getState().items[0]; await engine.confirm(id, { expectedRevision: changed.revision });
  check(written.get(id)?.summary === "3000" && written.size === 1, "confirm updates original record");
  written.set(id, { id, version: "user-edit", summary: "changed by user" });
  const undo = await engine.undo(id); check(undo.status === "needs_confirmation" && written.size === 1, "edited record needs confirmation before undo");
  written.set(id, { id, version: "newer-edit", summary: "edited again" });
  const again = await engine.undo(id, { acknowledgedRevision: engine.getState().items[0].revision });
  check(again.status === "needs_confirmation" && written.size === 1, "new edit after prompt requires fresh confirmation");
  await engine.undo(id, { acknowledgedRevision: engine.getState().items[0].revision });
  engine = new DiaryOrganizerEngine(ports); await engine.runOnce(); check(written.size === 0 && engine.getState().items[0].status === "undone", "restart does not resurrect undone item");
  state = null; written.clear(); candidates = [{ ...base }]; text = base.quote; pro = false;
  engine = new DiaryOrganizerEngine(ports); await engine.runOnce(); now += 3600000; await engine.runOnce();
  check(engine.getState().documents[0].financePending && written.size === 0, "free finance remains pending");
  pro = true; await engine.runOnce(); check(written.size === 1, "PRO upgrade extracts unchanged diary");
  state = null; written.clear(); let fail = true; const goodModel = ports.generateText;
  ports.generateText = async request => { if (fail) throw new Error("provider failed"); return goodModel(request); };
  engine = new DiaryOrganizerEngine(ports); await engine.runOnce(); now += 3600000; await engine.runOnce(); fail = false;
  await engine.runOnce(); check(written.size === 0, "failure is not empty success and waits six hours");
  now += 6 * 3600000; await engine.runOnce(); check(written.size === 1, "failure retry preserves work");
  enabled = false; const savedCalls = calls; await engine.runOnce(); check(calls === savedCalls, "disabled does not call model"); enabled = true; busy = true; await engine.runOnce(); check(calls === savedCalls, "foreground/Dream gets priority"); busy = false;
  check(diaryFingerprint(text) !== diaryFingerprint(text + "x"), "content fingerprint changes");

  const entry: FinanceEntry = { kind: base.kind, amountCents: base.amountCents, currency: base.currency, date: base.date, merchant: base.merchant, category: base.category, icon: "auto", source: "diary", sourceId: "extract-one", id: "diary-one", status: "completed", account: "", description: "拿铁咖啡一杯", note: "", journalPath: path };
  const imported = { ...entry, id: "wechat-one", source: "wechat" as const, sourceId: "wechat-raw", date: "2026-10-28 12:30:00" };
  check(financeDuplicateCandidates({ ...base }, [{ ...entry, version: "v1", date: imported.date }]).length === 1, "timestamped imported record retrieved for diary dedupe");
  const same = classifyImport([entry], [{ entry: imported, duplicateDecision: { action: "same", id: entry.id } }]); check(same.linked.length === 1 && same.added.length === 0, "import links same diary transaction without adding");
  const vague = classifyImport([entry], [{ entry: { ...imported, description: "", merchant: "" } }]); check(vague.pending.length === 1 && !vague.added.length, "uncertain import goes to review");
  check(financeEntryCsv([entry]).includes("来源") && financeEntryCsv([entry]).includes("日记（AI）"), "CSV source column");
  check(filterFinanceEntries([entry, imported], "2026-10", { source: "diary", search: "", merchant: "", category: "", kind: "all", account: "", excludedCategories: [], excludedIds: [] }).length === 1, "source filter");
  const vault = new FakeVault(); let json: string | null = null;
  const store = new LifestyleStoreCore({ read: async () => json, write: async value => { json = value; }, backup: async () => {} }); await store.initialize();
  const app = { vault, fileManager: { processFrontMatter: vault.processFrontMatter.bind(vault), trashFile: async (file: {path:string}) => { vault.files.delete(file.path); } } } as unknown as App;
  const ledger = new FinanceLedger(app, store); await ledger.initialize();
  const saved = await ledger.addDiary(entry, [], () => {});
  check(parseFinanceNote(await vault.read(vault.files.get(saved.path)!.file))?.source === "diary", "diary parser round trip");
  const retry = await ledger.addDiary(entry, [], () => {}); check(retry.entry.id === saved.entry.id && ledger.entries().length === 1, "crash retry stable ID is idempotent");
  await assert.rejects(ledger.addDiary({ ...entry, id: "second", sourceId: "extract-two" }, [], () => {})); checks++;
  const linked = await ledger.importRows([{ entry: imported, duplicateDecision: { action: "same", id: entry.id } }]); check(linked.linked === 1 && ledger.entries().length === 1 && ledger.entries()[0].sourceLinks?.[0].sourceId === "wechat-raw", "real ledger writes import association without duplicate");
  const repeated = await ledger.importRows([{ entry: imported }]); check(repeated.duplicates === 1 && ledger.entries().length === 1, "repeat imported associated identity is idempotent");
  const reload = new FinanceLedger(app, store); await reload.initialize(); check(reload.entries()[0].source === "diary", "old JSON/Markdown diary source stays parseable");
  console.log(`Diary organizer regression tests: PASS (${checks} checks)`);
}
