import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditorState, Transaction, type Transaction as EditorTransaction } from "@codemirror/state";
import { history, isolateHistory, undo, redo } from "@codemirror/commands";
import type CodexForObsidianPlugin from "../main";
import { InlineRequestService, type InlineEditorPort } from "../inline-agent/service";
import { InlineAgentRuntimeController } from "../inline-agent/orchestrator";
import { FileInlineRepository, type InlineRepository } from "../inline-agent/store";
import { anchorAt } from "../inline-agent/document";
import { createApiProviderConfig, DEFAULT_SETTINGS } from "../settings/settings";
import type { InlineRequest, InlineProposalInput } from "../inline-agent/types";
import type { PiChatSubmitRequest, PiProductRunRecord } from "../harness/pi-native/contracts";

const BODY = "原文第一行\n原文第二行", COMMAND = "@小墨 改写这段", DOCUMENT = `${BODY}\n\n${COMMAND}`;
const MODEL = { providerSettingsId: "recovery-provider", runtimeProviderId: "deepseek", modelId: "fixture-model", reasoning: "none" as const, memoryMode: "normal" as const };
class Repository implements InlineRepository {
  records: InlineRequest[] = [];
  fault: (records: readonly InlineRequest[]) => boolean = () => false;
  async load() { return structuredClone(this.records); }
  async save(records: readonly InlineRequest[]) { if (this.fault(records)) throw new Error("synthetic record write failure"); this.records = structuredClone([...records]); }
}
async function drain() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise<void>(resolve => setTimeout(resolve, 1)); }
  assert.fail(message);
}
async function fixture(repository: InlineRepository = new Repository(), document = DOCUMENT, runtime = false) {
  let state = EditorState.create({ doc: document, extensions: [history()] }), notePath = "正文.md", attached = true, failSave = false, applies = 0;
  let service: InlineRequestService;
  const reports: unknown[] = [], paths: string[] = [];
  const dispatch = (transaction: EditorTransaction, ownId?: string, duplicate = false) => {
    const previous = state.doc.toString(); state = transaction.state;
    service.observe(notePath, transaction.changes, previous, state.doc.toString(), ownId);
    if (duplicate) service.observe(notePath, transaction.changes, previous, state.doc.toString(), ownId);
  };
  const editor: InlineEditorPort = {
    read: () => state.doc.toString(),
    apply: (changes, mode, requestId) => { applies++; dispatch(state.update({ changes, annotations: mode === "system" ? Transaction.addToHistory.of(false) : isolateHistory.of("full") }), requestId); },
    save: async () => { if (failSave) throw new Error("synthetic editor save failure"); }
  };
  const openEditor = async (requested: string) => { paths.push(requested); assert.equal(requested, notePath); if (!attached) throw new Error("tab is closed"); return editor; };
  service = new InlineRequestService("recovery-vault", repository, { editor: openEditor, changed() {}, report: error => { reports.push(error); } });
  const settings = structuredClone(DEFAULT_SETTINGS), provider = createApiProviderConfig("deepseek", MODEL.providerSettingsId);
  provider.models[0].reasoning = false; provider.models[0].reasoningEnabled = false; settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = provider.models[0].id;
  const calls: Array<{ request: PiChatSubmitRequest; id: string; settled: boolean; resolve(record: Readonly<PiProductRunRecord>): void }> = [];
  const busy = new Map<string, string>();
  const plugin = {
    settings, getVaultPath: () => tmpdir(),
    createPiConversation: async input => ({ conversationId: input.conversationId, piSessionId: "recovery-session", vaultId: "recovery-vault", title: input.title,
      status: "active" as const, defaultMemoryMode: "normal" as const, createdAt: Date.now(), updatedAt: Date.now() }),
    submitPiChat: async request => {
      assert.equal([...busy.values()].includes(request.conversationId), false);
      const id = `recovery-run-${calls.length + 1}`; let resolve!: (record: Readonly<PiProductRunRecord>) => void;
      const result = new Promise<Readonly<PiProductRunRecord>>(done => { resolve = done; }); calls.push({ request, id, resolve, settled: false }); busy.set(id, request.conversationId);
      return { productRunId: id, conversationId: request.conversationId, piSessionId: "recovery-session", userEntryId: `${id}-user`, result };
    },
    subscribePiRun: () => ({ unsubscribe() {} }),
    releasePiProductionRun: id => { assert.ok(busy.delete(id)); },
    abortPiConversation: async () => undefined
  } satisfies Pick<CodexForObsidianPlugin, "settings" | "getVaultPath" | "createPiConversation" | "submitPiChat" | "subscribePiRun" | "releasePiProductionRun" | "abortPiConversation">;
  // Production constructs the subscriber before loading the durable requests.
  const controller = runtime ? new InlineAgentRuntimeController(plugin as unknown as CodexForObsidianPlugin, service, { editor: openEditor, openTask: async () => undefined }) : undefined;
  await service.initialize();
  const input = (command = COMMAND, taskId = "recovery-task"): InlineProposalInput => {
    const value = editor.read(), from = value.indexOf(command), at = value.indexOf(BODY);
    return { path: notePath, taskId, agentId: "sol", agentName: "小墨", trigger: "@", instruction: { from, to: from + command.length }, target: { kind: "replace", from: at, to: at + BODY.length }, text: "新稿第一行\n新稿第二行" };
  };
  const begin = async (command = COMMAND, taskId = "recovery-task") => { const { target: _target, text: _text, ...base } = input(command, taskId); return service.beginRequest(base, command); };
  const finish = (index: number, cancelled = false) => {
    const call = calls[index]; assert.ok(call); assert.equal(call.settled, false); call.settled = true;
    const candidate = call.request.inlineProposalRequest?.candidates.find(item => item.kind === "replace" && item.text.includes(BODY));
    call.resolve({ productRunId: call.id, conversationId: call.request.conversationId, piSessionId: "recovery-session", userEntryId: `${call.id}-user`, toolCallIds: [],
      memoryMode: "normal", state: "product_run_settled", terminalState: cancelled ? "cancelled" : "completed", activeLeafId: null, createdAt: Date.now(), updatedAt: Date.now(),
      ...(!cancelled && candidate ? { inlineProposalResult: { kind: "proposal", candidateId: candidate.id, original: BODY, text: "恢复后生成的新稿" } as const } : {}) });
  };
  return { service, controller, editor, calls, busy, reports, paths, input, begin, finish, applies: () => applies,
    saveFailure(value: boolean) { failSave = value; },
    edit(from: number, to: number, insert: string, duplicate = false) { dispatch(state.update({ changes: { from, to, insert } }), undefined, duplicate); },
    history(direction: "undo" | "redo") { return (direction === "undo" ? undo : redo)({ state, dispatch: transaction => dispatch(transaction, undefined, true) }); },
    closeTab() { attached = false; }, reopenTab() { attached = true; service.reconcile(notePath, editor.read()); },
    rename(next: string) { const previous = notePath; notePath = next; service.rename(previous, next); },
    async close() { controller?.dispose(); for (let i = 0; i < calls.length; i++) if (!calls[i].settled) finish(i, true); await drain(); await service.dispose(); }
  };
}

const cases: Array<readonly [string, () => Promise<void>]> = [];
cases.push(["cold states retain drafts and never replay a ready regeneration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inline-recovery-"));
  try {
    for (const status of ["thinking", "pending", "clarifying"] as const) {
      const file = path.join(directory, `${status}.json`), repository = new FileInlineRepository(file, "recovery-vault"), seed = await fixture(repository);
      const request = status === "pending" ? await seed.service.stageProposal(seed.input()) : await seed.begin();
      if (status === "clarifying") { const source = await seed.service.readSource(request.id), token = await seed.service.startRun(request.id, COMMAND, MODEL, source.context, false); await seed.service.clarify(request.id, token, { question: "改成什么语气？", options: [{ id: "a", label: "简短" }] }, {}); }
      const text = seed.editor.read(); await seed.close();
      const restored = await fixture(new FileInlineRepository(file, "recovery-vault"), text, true);
      try { await drain(); assert.equal(restored.service.get(request.id)?.status, status === "thinking" ? "interrupted" : status); assert.equal(restored.calls.length, 0); assert.equal(restored.applies(), 0); }
      finally { await restored.close(); }
    }
    const file = path.join(directory, "queued.json"), repository = new FileInlineRepository(file, "recovery-vault");
    const seed = await fixture(repository, `${DOCUMENT}\n\n@小墨 后改`);
    const first = await seed.service.stageProposal(seed.input()), second = await seed.begin("@小墨 后改", "queued-task"), source = await seed.service.readSource(second.id);
    const token = await seed.service.startRun(second.id, "后改", MODEL, source.context, false), from = source.document.indexOf(BODY);
    await seed.service.completeProposal(second.id, token, source.document, { ...anchorAt(source.document, { from, to: from + BODY.length }), kind: "replace" }, "旧快照稿", "后改", "正文", {});
    await seed.service.revoke(first.id, first.currentVersionId); assert.equal(seed.service.get(second.id)?.queue?.regenerate, true); assert.deepEqual(seed.service.get(second.id)?.queue?.blockedBy, []);
    const text = seed.editor.read(); await seed.close();
    const restored = await fixture(new FileInlineRepository(file, "recovery-vault"), text, true);
    try {
      await drain(); assert.equal(restored.calls.length, 0, "cold initialization must not dispatch a ready queued regeneration"); assert.equal(restored.service.get(second.id)?.status, "queued");
      restored.service.compare(second.id); restored.rename("改名后的正文.md"); await drain(); assert.equal(restored.calls.length, 0, "unrelated notifications must not bypass manual cold resume");
      await restored.controller!.retry(second.taskId); await until(() => restored.calls.length === 1, "explicit retry must resume the queued request");
      restored.finish(0); await until(() => restored.busy.size === 0, "resumed run did not settle"); assert.equal(restored.service.get(second.id)?.status, "pending");
    } finally { await restored.close(); }
    const blockedFile = path.join(directory, "blocked-queued.json"), blockedRepository = new FileInlineRepository(blockedFile, "recovery-vault");
    const blocked = await fixture(blockedRepository, `${DOCUMENT}\n\n@小墨 后改`);
    const predecessor = await blocked.service.stageProposal(blocked.input()), successor = await blocked.begin("@小墨 后改", "blocked-task"), snapshot = await blocked.service.readSource(successor.id);
    const blockedToken = await blocked.service.startRun(successor.id, "后改", MODEL, snapshot.context, false), at = snapshot.document.indexOf(BODY);
    await blocked.service.completeProposal(successor.id, blockedToken, snapshot.document, { ...anchorAt(snapshot.document, { from: at, to: at + BODY.length }), kind: "replace" }, "被阻塞的旧稿", "后改", "正文", {});
    const blockedText = blocked.editor.read(); await blocked.close();
    const resumed = await fixture(new FileInlineRepository(blockedFile, "recovery-vault"), blockedText, true);
    try {
      await drain(); assert.equal(resumed.calls.length, 0); assert.deepEqual(resumed.service.get(successor.id)?.queue?.blockedBy, [predecessor.id]);
      await resumed.service.revoke(predecessor.id, predecessor.currentVersionId);
      await until(() => resumed.calls.length === 1, "an explicitly handled predecessor must unblock its restored successor automatically");
      resumed.finish(0); await until(() => resumed.busy.size === 0, "unblocked successor did not settle"); assert.equal(resumed.service.get(successor.id)?.status, "pending");
    } finally { await resumed.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}]);

cases.push(["three commit failures retain intent and retry without double application", async () => {
  for (const stage of ["intent", "editor", "receipt"] as const) {
    const repository = new Repository(), f = await fixture(repository);
    try {
      const request = await f.service.stageProposal(f.input()), before = f.editor.read(), count = f.applies();
      if (stage === "editor") f.saveFailure(true);
      else repository.fault = records => records.some(record => record.id === request.id && record.status === (stage === "intent" ? "saving" : "confirmed"));
      await assert.rejects(f.service.confirm(request.id, request.currentVersionId), /synthetic/u);
      assert.equal(f.service.get(request.id)?.status, "save_failed", `${stage} failure must leave a retryable state`);
      assert.ok(f.service.get(request.id)?.commit); assert.equal(f.applies(), count + (stage === "intent" ? 0 : 1));
      if (stage === "intent") assert.equal(f.editor.read(), before);
      repository.fault = () => false; f.saveFailure(false);
      await Promise.all([f.service.confirm(request.id, request.currentVersionId), f.service.confirm(request.id, request.currentVersionId)]);
      assert.equal(f.service.get(request.id)?.status, "confirmed"); assert.equal(f.applies(), count + 1); assert.equal(f.editor.read().split("新稿第一行").length - 1, 1);
    } finally { repository.fault = () => false; f.saveFailure(false); await f.close(); }
  }
}]);

cases.push(["missing records and duplicate markers preserve note text and stop execution", async () => {
  const unknown = await fixture(new Repository(), `${BODY}\n${COMMAND} %%echoink:unknown-record%%`, true);
  try { const before = unknown.editor.read(); await assert.rejects(unknown.service.confirm("unknown-record", "version")); await assert.rejects(unknown.controller!.retry("unknown-task")); assert.equal(unknown.editor.read(), before); assert.equal(unknown.calls.length, 0); assert.equal(unknown.applies(), 0); }
  finally { await unknown.close(); }
  const f = await fixture(new Repository(), DOCUMENT, true);
  try {
    const request = await f.service.stageProposal(f.input()); f.edit(f.editor.read().length, f.editor.read().length, `\n${request.instruction.text}`);
    const before = f.editor.read(); assert.equal(f.service.get(request.id)?.status, "missing"); assert.match(f.service.get(request.id)?.error ?? "", /编号重复/u);
    await assert.rejects(f.service.confirm(request.id, request.currentVersionId)); await f.controller!.retry(request.taskId); await drain();
    assert.equal(f.calls.length, 0); assert.equal(f.editor.read(), before);
  } finally { await f.close(); }
}]);

cases.push(["rename while model is running uses the current note path", async () => {
  const f = await fixture(new Repository(), DOCUMENT, true);
  try {
    const request = await f.service.stageProposal(f.input()); await f.controller!.reply(request.taskId, "按当前正文重新改写"); await until(() => f.calls.length === 1, "reply did not submit");
    const seen = f.paths.length; f.rename("新目录/改名.md"); f.finish(0); await until(() => f.busy.size === 0, "renamed request did not settle");
    const pending = f.service.get(request.id)!; assert.equal(pending.path, "新目录/改名.md"); assert.equal(pending.status, "pending");
    await f.service.confirm(request.id, pending.currentVersionId); assert.ok(f.editor.read().includes("恢复后生成的新稿")); assert.ok(f.paths.slice(seen).every(value => value === "新目录/改名.md"));
  } finally { await f.close(); }
}]);

cases.push(["tab close, duplicate split-pane observation, Undo and Redo never replay", async () => {
  const f = await fixture(new Repository(), DOCUMENT, true);
  try {
    const request = await f.service.stageProposal(f.input()); f.edit(0, 0, "人工前缀\n", true); const pending = f.service.get(request.id)!;
    assert.equal(pending.target.from, "人工前缀\n".length); f.closeTab(); await drain(); assert.equal(f.service.get(request.id)?.status, "pending"); f.reopenTab();
    const before = f.editor.read(); await f.service.confirm(request.id, request.currentVersionId); const after = f.editor.read(), applies = f.applies();
    assert.ok(f.history("undo")); assert.equal(f.editor.read(), before); assert.equal(f.service.get(request.id)?.status, "withdrawn");
    assert.ok(f.history("redo")); assert.equal(f.editor.read(), after); assert.equal(f.service.get(request.id)?.status, "confirmed");
    assert.equal(f.applies(), applies); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
  const early = await fixture(new Repository(), `${BODY}\n\n`, true);
  try {
    early.edit(early.editor.read().length, early.editor.read().length, COMMAND); const request = await early.begin();
    assert.ok(early.history("undo")); assert.ok(early.editor.read().includes(request.instruction.marker)); assert.equal(early.service.get(request.id)?.status, "missing");
    await early.controller!.retry(request.taskId); await drain(); assert.equal(early.calls.length, 0); assert.ok(early.history("redo")); assert.equal(early.calls.length, 0);
  } finally { await early.close(); }
}]);

const failures: Error[] = [];
for (const [name, run] of cases) { try { await run(); console.log(`PASS inline recovery: ${name}`); } catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); failures.push(failure); console.error(`FAIL inline recovery: ${name}`, failure); } }
if (failures.length) throw new AggregateError(failures, `${failures.length}/${cases.length} inline recovery groups failed`);
