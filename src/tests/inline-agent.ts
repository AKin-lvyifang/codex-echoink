import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { ChangeSet, EditorState, Transaction } from "@codemirror/state";
import { history, isolateHistory, undo, redo } from "@codemirror/commands";
import { anchorAt, cleanDocument, commitChanges, applyChanges, instructionDeletion, intersects, mapAnchor, sourceSpanForContext } from "../inline-agent/document";
import { FileInlineRepository, type InlineRepository } from "../inline-agent/store";
import { InlineRequestService, type InlineEditorPort } from "../inline-agent/service";
import type { InlineRequest, InlineProposalInput } from "../inline-agent/types";
import { buildInlineCandidates, proposalTarget } from "../inline-agent/candidates";

let checks = 0;
const check = (name: string, fn: () => void | Promise<void>) => Promise.resolve().then(fn).then(() => { checks++; console.log(`PASS ${name}`); });
class MemoryRepository implements InlineRepository {
  records: InlineRequest[] = [];
  fail = false;
  async load() { return structuredClone(this.records); }
  async save(records: readonly InlineRequest[]) { if (this.fail) throw new Error("disk unavailable"); this.records = structuredClone([...records]); }
}
function fixture(document = "前文不动\n原文第一行\n原文第二行\n\n用户前文 @小墨 改写这段 后缀", repository: InlineRepository = new MemoryRepository()) {
  let service: InlineRequestService;
  let state = EditorState.create({ doc: document, extensions: [history()] });
  let failSave = false, applies = 0;
  const dispatch = (tr: Transaction) => { const previous = state.doc.toString(); state = tr.state; service.observe("正文.md", tr.changes, previous, state.doc.toString()); };
  const port: InlineEditorPort = {
    read: () => state.doc.toString(),
    apply: (changes, mode) => { applies++; dispatch(state.update({ changes, annotations: mode === "system" ? Transaction.addToHistory.of(false) : isolateHistory.of("full") })); },
    save: async () => { if (failSave) throw new Error("save failed"); }
  };
  service = new InlineRequestService("vault-test", repository, { editor: async () => port, changed() {}, report() {} });
  const input = (): InlineProposalInput => {
    const text = port.read(), from = text.indexOf("@小墨"), to = text.indexOf(" 后缀");
    return { path: "正文.md", taskId: "existing-task", agentId: "sol", agentName: "小墨", trigger: "@", instruction: { from, to }, target: { kind: "replace", from: text.indexOf("原文第一行"), to: text.indexOf("原文第二行") + 6 }, text: "新稿第一行\n新稿第二行" };
  };
  return { service, repository, port, input, edit: (from: number, to: number, insert: string) => dispatch(state.update({ changes: { from, to, insert } })),
    history: (direction: "undo" | "redo") => (direction === "undo" ? undo : redo)({ state, dispatch } as never),
    setSaveFailure: (value: boolean) => { failSave = value; }, applies: () => applies };
}
await check("B17 control substring deletion preserves prefix, suffix and multi-line text", () => {
  for (const trigger of ["@", "!"]) for (const action of ["confirm", "revoke"]) {
    const command = `${trigger}小墨 改写\n第二行要求 %%echoink:r%%`, doc = `保留前文 ${command} 保留后文\n下一行`;
    const from = doc.indexOf(trigger), to = from + command.length;
    const changes = action === "revoke" ? [instructionDeletion(doc, { from, to })] : commitChanges(doc, { from, to }, { from: doc.indexOf("下一行"), to: doc.length }, "新稿");
    assert.equal(applyChanges(doc, changes), `保留前文 保留后文\n${action === "confirm" ? "新稿" : "下一行"}`);
  }
});
await check("empty line removal is bounded and preserves whitespace-only user content", () => {
  for (const [doc, expected] of [["头\n@命令\n尾", "头\n尾"], ["头\n@命令", "头"], ["@命令\n尾", "尾"], ["@命令", ""], [" @命令 ", " "], ["中文@命令后文", "中文后文"]]) {
    const from = doc.indexOf("@"); assert.equal(applyChanges(doc, [instructionDeletion(doc, { from, to: from + 3 })]), expected);
  }
});
const model = { providerSettingsId: "provider", runtimeProviderId: "openai", modelId: "model", reasoning: "none" as const, memoryMode: "normal" as const };
await check("a thinking request has no fake proposal, clarifies, and revokes without a version", async () => {
  const f = fixture(), input = f.input(); const { target: _target, text: _text, ...base } = input;
  const r = await f.service.beginRequest(base, "重写这一段"); assert.equal(r.status, "thinking"); assert.equal(r.versions.length, 0);
  const source = await f.service.readSource(r.id), token = await f.service.startRun(r.id, "重写这一段", model, source.context, false);
  assert.ok(!source.context.text.includes("%%echoink:")); assert.ok(source.context.text.includes("用户前文"));
  await f.service.clarify(r.id, token, { question: "哪一段？", options: [{ id: "a", label: "第一段" }, { id: "b", label: "第二段" }] }, { toolCalls: 0 });
  assert.equal(f.service.get(r.id)?.status, "clarifying"); await f.service.revoke(r.id, "");
  assert.ok(f.port.read().includes("用户前文 后缀")); assert.equal(f.service.get(r.id)?.status, "revoked"); await f.service.dispose();
});
await check("new versions retain the file instruction and reject an old run or old confirmation", async () => {
  const f = fixture(), input = f.input(); const { target: _target, text: _text, ...base } = input;
  const r = await f.service.beginRequest(base, "重写这一段"), source = await f.service.readSource(r.id);
  const candidates = buildInlineCandidates(source.document, source.context, r), candidate = candidates.find(c => c.text.includes("原文第一行"))!;
  const target = proposalTarget(source.document, candidates, { kind: "proposal", candidateId: candidate.id, original: "原文第一行\n原文第二行", text: "第一版" });
  const first = await f.service.startRun(r.id, "重写这一段", model, source.context, false);
  await f.service.completeProposal(r.id, first, source.document, target, "第一版", "重写这一段", "正文", { toolCalls: 0 });
  const oldVersion = f.service.get(r.id)!.currentVersionId;
  const second = await f.service.startRun(r.id, "再短一点", model, source.context, true);
  await f.service.completeProposal(r.id, first, source.document, target, "过期结果", "重写这一段", "正文", {});
  assert.equal(f.service.get(r.id)?.status, "thinking"); assert.equal(f.service.get(r.id)?.versions.length, 1);
  await f.service.completeProposal(r.id, second, source.document, target, "第二版", "再短一点", "正文", { toolCalls: 0 });
  assert.equal(f.service.get(r.id)?.versions.length, 2); assert.equal(f.service.get(r.id)?.instruction.text, r.instruction.text);
  await assert.rejects(f.service.confirm(r.id, oldVersion), /版本已变化/u);
  await f.service.confirm(r.id, f.service.get(r.id)!.currentVersionId); assert.ok(f.port.read().includes("第二版")); await f.service.dispose();
});
await check("a deleted instruction cannot be revived by a late model response", async () => {
  const f = fixture(), input = f.input(); const { target: _target, text: _text, ...base } = input;
  const r = await f.service.beginRequest(base, "重写这一段"), source = await f.service.readSource(r.id), token = await f.service.startRun(r.id, "重写这一段", model, source.context, false);
  const target = { ...anchorAt(source.document, input.target), kind: "replace" as const };
  f.edit(r.instruction.from, r.instruction.to, ""); const before = f.port.read();
  await f.service.completeProposal(r.id, token, source.document, target, "晚到的稿", "重写这一段", "正文", {});
  assert.equal(f.service.get(r.id)?.status, "missing"); assert.equal(f.port.read(), before); await f.service.dispose();
});
await check("clean whole-note mapping preserves surrounding prose and rejects ranges across controls", () => {
  const context = cleanDocument("前文@命令后文", [{ from: 2, to: 5 }]);
  assert.equal(context.text, "前文后文");
  assert.deepEqual(sourceSpanForContext(context, { from: 2, to: 4 }), { from: 5, to: 7 });
  assert.equal(sourceSpanForContext(context, { from: 1, to: 3 }), null);
});
await check("empty control-line cleanup merges a shared newline with the adjacent replacement", () => {
  assert.equal(applyChanges("原文\n@命令", commitChanges("原文\n@命令", { from: 3, to: 6 }, { from: 0, to: 3 }, "新稿\n")), "新稿\n");
  assert.equal(applyChanges("@命令\n原文", commitChanges("@命令\n原文", { from: 0, to: 3 }, { from: 3, to: 6 }, "\n新稿")), "\n新稿");
  assert.throws(() => commitChanges("原文@命令", { from: 2, to: 5 }, { from: 0, to: 3 }, "新稿"), /包含本次指令/u);
});
await check("range and insertion boundary typing follows explicit association", () => {
  const base = "abcd", range = anchorAt(base, { from: 1, to: 3 }), point = anchorAt(base, { from: 1, to: 1 });
  const changes = ChangeSet.of([{ from: 1, insert: "X" }, { from: 3, insert: "Y" }], base.length), next = applyChanges(base, [{ from: 1, to: 1, insert: "X" }, { from: 3, to: 3, insert: "Y" }]);
  assert.equal(mapAnchor(range, changes, next).text, "bc"); assert.equal(mapAnchor(point, changes, next).from, 1);
  assert.ok(intersects({ from: 1, to: 1 }, { from: 1, to: 1 })); assert.ok(!intersects({ from: 0, to: 1 }, { from: 1, to: 2 }));
});
await check("one CM6 history event confirms both edits, Undo/Redo never reruns a request", async () => {
  const f = fixture(); await f.service.initialize(); const r = await f.service.stageProposal(f.input());
  const before = f.port.read(), applied = f.applies(); await Promise.all([f.service.confirm(r.id, r.currentVersionId), f.service.confirm(r.id, r.currentVersionId)]);
  const after = f.port.read(); assert.equal(f.applies(), applied + 1); assert.ok(after.includes("用户前文 后缀")); assert.ok(!after.includes("%%echoink:"));
  assert.ok(f.history("undo")); assert.equal(f.port.read(), before); assert.equal(f.service.get(r.id)?.status, "withdrawn");
  assert.ok(f.history("redo")); assert.equal(f.port.read(), after); assert.equal(f.service.get(r.id)?.status, "confirmed"); await f.service.dispose();
});
await check("compare original blocks shared confirmation", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.service.compare(r.id);
  await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /切回新稿/u); f.service.compare(r.id);
  await f.service.revoke(r.id, r.currentVersionId); assert.ok(f.port.read().includes("原文第一行\n原文第二行")); assert.ok(f.port.read().includes("用户前文 后缀")); await f.service.dispose();
});
await check("manual edits remain modified after later unrelated typing and after cold restore", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); await f.service.confirm(r.id, r.currentVersionId);
  const result = f.service.get(r.id)!.commit!.result; f.edit(result.from, result.from + 1, "手");
  assert.equal(f.service.get(r.id)?.status, "modified"); f.edit(0, 0, "前面新增\n");
  assert.equal(f.service.get(r.id)?.status, "modified"); await f.service.dispose();
  const g = fixture(f.port.read(), f.repository); await g.service.initialize(); g.service.reconcile("正文.md", g.port.read());
  assert.equal(g.service.get(r.id)?.status, "modified"); await g.service.dispose();
});
await check("unrelated typing maps a pending target and preserves a confirmed result", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.edit(0, 0, "新增一行\n");
  await f.service.confirm(r.id, r.currentVersionId); assert.ok(f.port.read().startsWith("新增一行\n前文不动"));
  f.edit(0, 0, "再新增\n"); assert.equal(f.service.get(r.id)?.status, "confirmed"); await f.service.dispose();
  const g = fixture(f.port.read(), f.repository); await g.service.initialize(); g.service.reconcile("正文.md", g.port.read()); assert.equal(g.service.get(r.id)?.status, "confirmed"); await g.service.dispose();
});
await check("target edits block confirmation while revoke preserves manual changes", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.edit(r.target.from, r.target.from + 2, "手写");
  await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /目标/u); assert.equal(f.service.get(r.id)?.status, "conflict");
  await f.service.revoke(r.id, r.currentVersionId); assert.ok(f.port.read().includes("手写第一行")); await f.service.dispose();
});
await check("damaged instruction is missing and cannot be resurrected by similar text", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.edit(r.instruction.from, r.instruction.from + 1, "");
  assert.equal(f.service.get(r.id)?.status, "missing"); await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /位置/u); await f.service.dispose();
});
await check("save failure retries saving without applying another edit", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.setSaveFailure(true);
  await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /save failed/u); const text = f.port.read(), count = f.applies();
  assert.equal(f.service.get(r.id)?.status, "save_failed"); f.setSaveFailure(false); await f.service.confirm(r.id, r.currentVersionId);
  assert.equal(f.applies(), count); assert.equal(f.port.read(), text); assert.equal(f.service.get(r.id)?.status, "confirmed"); await f.service.dispose();
});
await check("result-record write failure preserves commit intent and retry never repeats the edit", async () => {
  class FinalWriteFailure extends MemoryRepository {
    writes = 0; allow = false;
    async save(records: readonly InlineRequest[]) { if (++this.writes >= 4 && !this.allow) throw new Error("result record failed"); await super.save(records); }
  }
  const repository = new FinalWriteFailure(), f = fixture(undefined, repository), r = await f.service.stageProposal(f.input());
  await assert.rejects(f.service.confirm(r.id, r.currentVersionId), /result record/u);
  assert.equal(f.service.get(r.id)?.status, "save_failed"); assert.ok(f.service.storageError); const count = f.applies(), text = f.port.read();
  repository.allow = true; await f.service.confirm(r.id, r.currentVersionId);
  assert.equal(f.applies(), count); assert.equal(f.port.read(), text); assert.equal(f.service.get(r.id)?.status, "confirmed"); assert.equal(f.service.storageError, undefined); await f.service.dispose();
});
await check("cold restore retains pending despite unrelated task completion", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); await f.service.dispose(); const g = fixture(f.port.read(), f.repository);
  await g.service.initialize(); g.service.reconcile("正文.md", g.port.read()); assert.equal(g.service.get(r.id)?.status, "pending");
  await g.service.confirm(r.id, r.currentVersionId); assert.equal(g.service.get(r.id)?.status, "confirmed"); await g.service.dispose();
});
await check("duplicate markers and foreign paths do not become executable", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.edit(f.port.read().length, f.port.read().length, `\n${r.instruction.text}`);
  assert.equal(f.service.get(r.id)?.status, "missing"); assert.equal(f.service.list("复制.md").length, 0); await f.service.dispose();
});
await check("empty paragraph, end-of-note and otherwise empty document support insertion", async () => {
  for (const doc of ["@小墨 补写", "正文\n\n@小墨 补写", "@小墨 补写\n\n"]) {
    const f = fixture(doc); const from = doc.indexOf("@"); const point = doc.startsWith("正文") ? 2 : doc.length;
    const r = await f.service.stageProposal({ path: "正文.md", taskId: "existing-task", agentId: "sol", agentName: "小墨", trigger: "@", instruction: { from, to: from + 6 }, target: { kind: "insert", from: point, to: point }, text: "补写新稿" });
    await f.service.confirm(r.id, r.currentVersionId); assert.ok(f.port.read().includes("补写新稿")); assert.ok(!f.port.read().includes("%%echoink:")); await f.service.dispose();
  }
});
await check("file journal reconciles both sides of an interrupted commit without replay", async () => {
  const f = fixture(); const r = await f.service.stageProposal(f.input()); f.setSaveFailure(true); await assert.rejects(f.service.confirm(r.id, r.currentVersionId)); await f.service.dispose();
  for (const side of ["beforeDocument", "afterDocument"] as const) {
    const repository = new MemoryRepository(); repository.records = [f.service.get(r.id)!];
    const g = fixture(f.service.get(r.id)!.commit![side], repository); await g.service.initialize(); g.service.reconcile("正文.md", g.port.read());
    assert.equal(g.service.get(r.id)?.status, side === "beforeDocument" ? "pending" : "confirmed"); assert.equal(g.applies(), 0); await g.service.dispose();
  }
});
await check("interrupted send without marker is retained as missing, never auto-appended", async () => {
  const repo = new MemoryRepository(), f = fixture(undefined, repo); const r = await f.service.stageProposal(f.input()); await f.service.dispose(); repo.records[0].status = "preparing";
  const g = fixture(r.versions[0].sourceDocument.replace(` ${r.instruction.marker}`, ""), repo); await g.service.initialize(); g.service.reconcile("正文.md", g.port.read());
  assert.equal(g.service.get(r.id)?.status, "missing"); assert.equal(g.applies(), 0); await g.service.dispose();
});
await check("real repository persists, validates scope and refuses corrupt data", async () => {
  const base = path.join(homedir(), "EchoInk-TestVaults/90-任务临时"); await mkdir(base, { recursive: true }); const dir = await mkdtemp(path.join(base, "inline-round1-tests-"));
  try {
    const file = path.join(dir, "requests.json"), repo = new FileInlineRepository(file, "vault-test"), f = fixture(undefined, repo);
    await f.service.initialize(); const r = await f.service.stageProposal(f.input()); await f.service.dispose(); assert.equal((await repo.load())[0].id, r.id);
    const queueRepo = new FileInlineRepository(path.join(dir, "queued.json"), "vault-test");
    const queued = fixture("甲段\n\n乙段\n\n@小墨 先改\n\n@小墨 后改", queueRepo); await queued.service.initialize();
    const begin = async (command: string) => { const from = queued.port.read().indexOf(command); return queued.service.beginRequest({ path: "正文.md", taskId: command, agentId: "sol", agentName: "小墨", trigger: "@", instruction: { from, to: from + command.length } }, command); };
    const first = await begin("@小墨 先改"), second = await begin("@小墨 后改"), source = await queued.service.readSource(second.id);
    const token = await queued.service.startRun(second.id, "后改", model, source.context, false), at = source.document.indexOf("乙段");
    await queued.service.completeProposal(second.id, token, source.document, { ...anchorAt(source.document, { from: at, to: at + 2 }), kind: "replace" }, "乙段新稿", "后改", "正文", { toolCalls: 0 });
    await queued.service.dispose(); const saved = (await queueRepo.load()).find(item => item.id === second.id)!;
    assert.deepEqual(saved.queue?.blockedBy, [first.id]); assert.equal(saved.preparedProposal?.sourceDocument, source.document);
    assert.equal(saved.preparedProposal?.sourceTarget.text, "乙段");
    const restored = fixture(queued.port.read(), queueRepo); await restored.service.initialize();
    assert.equal(restored.service.get(first.id)?.status, "interrupted"); assert.equal(restored.service.get(second.id)?.status, "queued");
    await restored.service.revoke(first.id, ""); const ready = restored.service.get(second.id)!;
    assert.equal(ready.status, "pending"); assert.equal(ready.order, saved.order);
    assert.equal(ready.versions[0].sourceDocument, source.document); await restored.service.confirm(ready.id, ready.currentVersionId);
    assert.ok(restored.port.read().includes("乙段新稿")); await restored.service.dispose();
    await assert.rejects(new FileInlineRepository(file, "other-vault").load(), /当前仓库/u);
    const raw = await readFile(file, "utf8"); await writeFile(file, raw.replace('"status": "pending"', '"status": "unknown"')); await assert.rejects(repo.load(), /损坏/u);
    assert.ok((await readFile(file, "utf8")).includes("unknown"));
  } finally { await rm(dir, { recursive: true }); }
});
console.log(`Inline agent: ${checks} groups passed.`);
