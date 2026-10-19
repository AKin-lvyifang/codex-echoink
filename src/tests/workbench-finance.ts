import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { parse, stringify } from "yaml";
import { nativeJournalFixture } from "./native-journal-fixture";
import { paidTestAccess } from "./membership-access";
import { LifestyleStore } from "../lifestyle/store";
import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { parseFinanceNote } from "../lifestyle/finance-ledger";
import { readFinanceBill, type FinanceImportRow } from "../lifestyle/finance-domain";
import type { FinanceEntry } from "../lifestyle/store-core";

const manual = (id: string): FinanceEntry => ({ id, source: "manual", sourceId: id,
  date: "2026-10-18", merchant: "合成商户", category: "其他", kind: "expense", amountCents: 1200,
  status: "completed", account: "合成账户", description: "合成消费", currency: "CNY", note: "" });

async function bill(ids: string[]): Promise<FinanceImportRow[]> {
  const csv = ["交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注",
    ...ids.map(id => `2026-10-18 12:00:00,商户消费,合成商户${id},合成商品,支出,12.00,合成账户,支付成功,${id},订单${id},`)].join("\n");
  return readFinanceBill(new TextEncoder().encode(csv), "synthetic.csv", "wechat");
}

async function fixture(root: string, seed?: Record<string, unknown>) {
  const f = await nativeJournalFixture(root);
  const storePath = path.join(root, ".finance-store.json");
  if (seed) await writeFile(storePath, JSON.stringify(seed));
  const store = new LifestyleStore(storePath); await store.initialize();
  const settings = f.plugin.settings.lifestyle.finance;
  settings.enabled = true; settings.importAiEnabled = false;
  (f.app.fileManager as any).processFrontMatter = async (file: any, change: (fields: Record<string, unknown>) => void) => f.app.vault.process(file, markdown => {
    const match = markdown.match(/^---\n([\s\S]*?)\n---\n/u)!;
    const fields = parse(match[1]); change(fields);
    return `---\n${stringify(fields)}---\n${markdown.slice(match[0].length)}`;
  });
  let calls = 0;
  let reply: (input: any) => string = input => JSON.stringify({ rows: input.rows.map((row: any) => ({ ref: row.ref, category: "其他" })) });
  f.plugin.getSkillRuntimeCoordinator = () => ({ async resolveById() {}, async recordUse() {} });
  f.plugin.requireAvailableEchoInkSkill = async () => {};
  f.plugin.readEchoInkBuiltinSkill = async () => ({ fileStatus: "ready", content: "合成财务整理规则" });
  f.plugin.generateLifestyleText = async (_system: string, prompt: string) => { calls++; return reply(JSON.parse(prompt)); };
  const service = new LifestyleFinanceService({ plugin: f.plugin, store, refresh() {} } as any, paidTestAccess);
  return { ...f, root, store, storePath, settings, service, calls: () => calls, setReply: (value: typeof reply) => { reply = value; } };
}

async function reload(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new LifestyleStore(f.storePath); await store.initialize();
  const service = new LifestyleFinanceService({ plugin: f.plugin, store, refresh() {} } as any, paidTestAccess);
  return { store, records: await service.ledger.readSnapshots() };
}

async function finish(f: Awaited<ReturnType<typeof fixture>>, result: Awaited<ReturnType<LifestyleFinanceService["confirmImport"]>>, signal = new AbortController().signal) {
  const organization = await f.service.prepareImport(result.created, signal);
  const suggestions = await f.service.applyImportSuggestions(result.created, organization.rows, signal);
  await f.service.finalizeImportedAccounts(new Set(result.created.map(row => row.entry.id)));
  return { organization, suggestions, completed: await f.service.completeImport(result, { signal, organization, suggestions }) };
}

export async function runWorkbenchFinanceTests(root: string): Promise<void> {
  const legacyEntry = manual("legacy");
  const old = await fixture(path.join(root, "legacy"), { version: 1, financeEntries: [legacyEntry],
    lastSuccessfulImportAt: "2026-10-01", futureField: { preserved: true } });
  const beforeRead = await readFile(old.storePath, "utf8");
  assert.equal(old.store.snapshot().lastSuccessfulImportAt, undefined);
  assert.equal((await old.store.readFresh()).financeEntries[0].classificationPending, undefined);
  assert.equal(await readFile(old.storePath, "utf8"), beforeRead, "normalization must not write or invent history");
  await old.service.initialize();
  assert.equal(old.service.entries()[0].classificationPending, undefined, "legacy migration must not infer from 其他");
  assert.equal((await reload(old)).records[0].entry.classificationPending, undefined);
  await old.service.addManual({ ...manual("manual"), classificationPending: true });
  assert.ok(old.service.entries().every(entry => !entry.classificationPending), "manual selection of 其他 is classified");
  assert.equal(old.store.snapshot().lastSuccessfulImportAt, undefined);
  assert.deepEqual((await old.store.readFresh()).futureField, { preserved: true });

  const f = await fixture(path.join(root, "classification"));
  const rows = await bill(["unknown", "configured"]);
  assert.ok(rows.every(row => row.entry?.classificationPending));
  f.settings.merchants.push({ name: "合成商户configured", aliases: [], active: true, defaultCategory: "其他", iconId: "auto" });
  f.service.previewImport(rows);
  assert.equal(f.store.snapshot().lastSuccessfulImportAt, undefined, "preview does not complete an import");
  const first = await f.service.confirmImport(rows);
  const unknownId = rows[0].entry!.id;
  const configuredId = rows[1].entry!.id;
  assert.equal(first.added, 2);
  assert.equal(f.store.snapshot().lastSuccessfulImportAt, undefined, "base writes are not the full successful pipeline");
  let reopened = await reload(f);
  assert.equal(reopened.records.find(record => record.entry.id === unknownId)!.entry.classificationPending, true);
  assert.equal(reopened.records.find(record => record.entry.id === configuredId)!.entry.classificationPending, undefined,
    "an explicit merchant rule choosing 其他 clears the marker");
  const unknown = f.service.ledger.fileFor(unknownId)!;
  assert.match(await f.app.vault.read(unknown), /classification_pending: true/u);
  assert.equal(parseFinanceNote((await f.app.vault.read(unknown)).replace("classification_pending: true", 'classification_pending: "true"'))!.classificationPending, undefined);
  const start = Date.now();
  const success = await finish(f, first);
  assert.equal(success.completed, true);
  const firstTime = f.store.snapshot().lastSuccessfulImportAt!;
  assert.ok(firstTime >= start && firstTime <= Date.now());
  assert.equal((await reload(f)).store.snapshot().lastSuccessfulImportAt, firstTime);
  assert.equal(await f.service.completeImport(first), true);
  assert.equal(f.store.snapshot().lastSuccessfulImportAt, firstTime, "repeated completion must not write a second time");
  await f.service.updateDetails(unknownId, "改名", "合成商品", "auto");
  assert.equal(f.service.entries().find(entry => entry.id === unknownId)!.classificationPending, true, "an unrelated edit does not classify");
  await f.service.updateDetails(unknownId, "改名", "合成商品", "auto", "其他");
  reopened = await reload(f);
  assert.equal(reopened.records.find(record => record.entry.id === unknownId)!.entry.classificationPending, undefined);
  assert.doesNotMatch(await f.app.vault.read(unknown), /classification_pending/u, "same-name 其他 selection deletes the persisted marker");

  const agentRows = await bill(["agent"]);
  await f.service.confirmImport(agentRows);
  const record = (await f.service.ledger.readSnapshots()).find(record => record.entry.id === agentRows[0].entry!.id)!;
  await f.service.patchConversationRecord(record.entry.id, record.version, { category: "其他" });
  assert.equal((await reload(f)).records.find(value => value.entry.id === record.entry.id)!.entry.classificationPending, undefined,
    "Agent categorization also clears a same-name category");
  const repeated = await f.service.confirmImport(rows);
  assert.deepEqual([repeated.added, repeated.updated, repeated.duplicates], [0, 0, 2]);
  assert.equal(f.service.entries().find(entry => entry.id === unknownId)!.classificationPending, undefined);
  const notesBefore = await Promise.all(f.service.entries().map(entry => f.app.vault.read(f.service.ledger.fileFor(entry.id)!)));
  let updates = 0; const unsubscribe = f.store.subscribe(() => { updates++; });
  const results = await Promise.all([f.service.completeImport(repeated), f.service.completeImport(repeated)]);
  unsubscribe();
  assert.deepEqual(results, [true, true]); assert.equal(updates, 1, "duplicate reconciliation records completion exactly once");
  assert.equal(f.calls(), 0, "basic import and duplicate reconciliation require no model");
  assert.deepEqual(await Promise.all(f.service.entries().map(entry => f.app.vault.read(f.service.ledger.fileFor(entry.id)!))), notesBefore,
    "duplicate reconciliation does not rewrite classified notes");
  const statusRows = rows.map(row => ({ ...row, entry: { ...row.entry!, status: "failed" as const } }));
  const statusResult = await f.service.confirmImport(statusRows);
  assert.equal(statusResult.updated, 2);
  assert.equal(f.service.entries().find(entry => entry.id === unknownId)!.classificationPending, undefined, "status updates never re-mark a classified duplicate");
  const duplicateStop = new AbortController();
  const stoppedDuplicate = await f.service.confirmImport(statusRows, { signal: duplicateStop.signal });
  const beforeDuplicateStop = f.store.snapshot().lastSuccessfulImportAt;
  duplicateStop.abort();
  assert.equal(await f.service.completeImport(stoppedDuplicate), false);
  assert.equal(f.store.snapshot().lastSuccessfulImportAt, beforeDuplicateStop);

  const ai = await fixture(path.join(root, "ai")); ai.settings.importAiEnabled = true;
  const aiResult = await ai.service.confirmImport(await bill(["ai-other"]));
  const aiDone = await finish(ai, aiResult);
  assert.equal(aiDone.suggestions.applied, 1, "clearing the marker is a change even when the category stays 其他");
  assert.equal(aiDone.completed, true);
  assert.equal((await reload(ai)).records[0].entry.classificationPending, undefined);
  const aiTime = ai.store.snapshot().lastSuccessfulImportAt;
  ai.setReply(input => JSON.stringify({ rows: input.rows.map((row: any) => ({ ref: row.ref, merchant: "只有商户建议" })) }));
  const incomplete = await finish(ai, await ai.service.confirmImport(await bill(["missing-category"])));
  assert.equal(incomplete.organization.incomplete, true); assert.equal(incomplete.completed, false);
  assert.equal(ai.store.snapshot().lastSuccessfulImportAt, aiTime);
  assert.equal(ai.service.entries().find(entry => entry.sourceId === "missing-category")!.classificationPending, true);
  ai.setReply(() => { throw new Error("synthetic_model_failure"); });
  const failedAi = await finish(ai, await ai.service.confirmImport(await bill(["ai-failed"])));
  assert.ok(failedAi.organization.warnings.length); assert.equal(failedAi.completed, false);
  assert.equal(ai.store.snapshot().lastSuccessfulImportAt, aiTime);
  ai.setReply(input => JSON.stringify({ rows: input.rows.map((row: any) => ({ ref: row.ref, category: "餐饮" })) }));
  const conflict = await ai.service.confirmImport(await bill(["conflict"]));
  const organized = await ai.service.prepareImport(conflict.created, new AbortController().signal);
  await ai.service.updateDetails(conflict.created[0].entry.id, "用户改名", "保留修改", "auto");
  const skipped = await ai.service.applyImportSuggestions(conflict.created, organized.rows, new AbortController().signal);
  await ai.service.finalizeImportedAccounts(new Set(conflict.created.map(row => row.entry.id)));
  assert.equal(skipped.skipped, 1);
  assert.equal(await ai.service.completeImport(conflict, { organization: organized, suggestions: skipped }), false);
  assert.equal(ai.store.snapshot().lastSuccessfulImportAt, aiTime);

  const faults = await fixture(path.join(root, "faults"), { version: 1, lastSuccessfulImportAt: 12345 });
  const stopped = new AbortController(); stopped.abort();
  const cancelled = await faults.service.confirmImport(await bill(["cancelled"]), { signal: stopped.signal });
  assert.equal(cancelled.added, 0); assert.equal(await faults.service.completeImport(cancelled), false);
  const during = new AbortController();
  const partialCancel = await faults.service.confirmImport(await bill(["stop-one", "stop-two"]), { signal: during.signal, onSaved: () => during.abort() });
  assert.equal(partialCancel.added, 1); assert.equal(await faults.service.completeImport(partialCancel), false);
  assert.ok(faults.service.entries().some(entry => entry.sourceId === "stop-one"), "cancel preserves already written notes");
  const afterWrite = await faults.service.confirmImport(await bill(["cancel-after-write"]));
  assert.equal((await finish(faults, afterWrite, stopped.signal)).completed, false);
  assert.equal(await faults.service.completeImport(await faults.service.confirmImport([])), false);
  const invalid = await faults.service.confirmImport([{ entry: null, raw: [], error: "synthetic_parse_error" }]);
  assert.equal(await faults.service.completeImport(invalid), false);
  const mixed = await faults.service.confirmImport([...(await bill(["partial-parse"])), { entry: null, raw: [], error: "synthetic_parse_error" }]);
  assert.equal(mixed.added, 1); assert.equal((await finish(faults, mixed)).completed, false);
  await assert.rejects(readFinanceBill(new TextEncoder().encode("bad header"), "bad.csv", "wechat"), /表头/u);
  assert.equal(faults.store.snapshot().lastSuccessfulImportAt, 12345);
  const originalCreate = faults.app.vault.create.bind(faults.app.vault);
  let writes = 0;
  faults.app.vault.create = async (name, text) => { if (name.endsWith(".md") && ++writes === 2) throw new Error("synthetic_disk_full"); return originalCreate(name, text); };
  const partialWrite = await faults.service.confirmImport(await bill(["disk-one", "disk-two"]));
  assert.equal(partialWrite.added, 1); assert.match(partialWrite.writeError!, /disk_full/u);
  assert.equal(await faults.service.completeImport(partialWrite), false);
  faults.app.vault.create = originalCreate;
  const accountFailure = await faults.service.confirmImport(await bill(["account-failed"]));
  await faults.service.updateDetails(accountFailure.created[0].entry.id, "商户", "消费", "auto", undefined, "新账户");
  faults.plugin.saveSettings = async () => { throw new Error("synthetic_settings_failure"); };
  await assert.rejects(faults.service.finalizeImportedAccounts(new Set(accountFailure.created.map(row => row.entry.id))), /settings_failure/u);
  assert.equal(await faults.service.completeImport(accountFailure, { failed: true }), false);
  assert.equal((await reload(faults)).store.snapshot().lastSuccessfulImportAt, 12345, "every cancellation/failure preserves prior successful import time");

  const normalize = await fixture(path.join(root, "normalize"), { version: 1, financeEntries: [{ ...manual("flag"), classificationPending: "true" }], lastSuccessfulImportAt: -1 });
  assert.equal(normalize.store.snapshot().financeEntries[0].classificationPending, undefined);
  assert.equal(normalize.store.snapshot().lastSuccessfulImportAt, undefined);
  console.log("PASS workbench finance: real CSV/service/Markdown/store reload; legacy/manual/explicit-other; Agent/AI clearing; duplicate reconciliation once/no-model; cancel/parse/write/AI/conflict/account failures preserve timestamp");
}
