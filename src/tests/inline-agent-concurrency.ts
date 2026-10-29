import "./inline-timer-host";
import assert from "node:assert/strict";
import { paidTestAccess } from "./membership-access";
import { tmpdir } from "node:os";
import { ChangeSet, EditorState } from "@codemirror/state";
import type CodexForObsidianPlugin from "../main";
import { InlineAgentRuntimeController } from "../inline-agent/orchestrator";
import { InlineRequestService, type InlineEditorPort } from "../inline-agent/service";
import { locateInstruction } from "../inline-agent/document";
import type { InlineChange, InlineRequest } from "../inline-agent/types";
import type { InlineModelOutput } from "../inline-agent/protocol";
import { createApiProviderConfig, DEFAULT_SETTINGS } from "../settings/settings";
import type { PiChatSubmitRequest, PiProductRunRecord } from "../harness/pi-native/contracts";

const NOTE = "并发正文.md";
const ORIGINAL_A = `甲段原文：${"晨间先整理写作思路，再决定当天的重点。".repeat(8)}甲段结束。`;
const ORIGINAL_B = `乙段原文：${"午后核对项目事实，逐项补齐可靠的来源。".repeat(8)}乙段结束。`;
const ORIGINAL_C = `丙段原文：${"晚间回顾行动结果，留下可供明日参考的事实。".repeat(8)}丙段结束。`;
const LATEST_C = "丙段最新事实：排队期间人工新增了不可丢失的决定。";
type Label = "甲" | "乙" | "丙";
const MULTI_B = `  ${ORIGINAL_B}  `, MULTI_C = `\t${ORIGINAL_C}  `;
const MULTI_ORIGINAL = `${MULTI_B}\n\n\n### 核对\n\n${MULTI_C}`;
const MULTI_SECTION = "并发正文 › 乙节 › 并发正文 › 乙节 › 核对";
const multiDocument = (commands: Record<Label, string>) => `# 并发正文\n\n${ORIGINAL_A}\n\n## 乙节\n\n${MULTI_ORIGINAL}\n\n---\n\n${commands.甲}\n\n${commands.乙}\n\n${commands.丙}\n`;
type ManualRun = {
  id: string;
  request: PiChatSubmitRequest;
  settled: boolean;
  resolve(result: Readonly<PiProductRunRecord>): void;
};

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  assert.fail(label);
}
async function drain(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve));
}

async function fixture(documentFor: (commands: Record<Label, string>) => string = commands => `# 并发正文\n\n${ORIGINAL_A}\n\n${ORIGINAL_B}\n\n${ORIGINAL_C}\n\n---\n\n${commands.甲}\n\n${commands.乙}\n\n${commands.丙}\n`) {
  const settings = structuredClone(DEFAULT_SETTINGS), provider = createApiProviderConfig("deepseek", "concurrency-provider");
  provider.models[0].reasoning = false; provider.models[0].reasoningEnabled = false;
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = provider.models[0].id;
  const agent = settings.agentRegistry.agents[0];
  const commands: Record<Label, string> = { 甲: `@${agent.name} 处理甲段`, 乙: `@${agent.name} 处理乙段`, 丙: `@${agent.name} 处理丙段` };
  let state = EditorState.create({ doc: documentFor(commands) });
  let records: InlineRequest[] = [];
  let service: InlineRequestService;
  const reports: unknown[] = [], editorPaths: string[] = [];
  const transactions: Array<{ requestId: string; history: "normal" | "system"; before: string; after: string }> = [];
  const edit = (changes: readonly InlineChange[], requestId?: string) => {
    const before = state.doc.toString(), transaction = state.update({ changes: ChangeSet.of(changes, before.length) }); state = transaction.state;
    service.observe(NOTE, transaction.changes, before, state.doc.toString(), requestId);
  };
  const editor: InlineEditorPort = {
    read: () => state.doc.toString(),
    apply: (changes, history, requestId) => {
      const before = state.doc.toString(); edit(changes, requestId);
      transactions.push({ requestId, history, before, after: state.doc.toString() });
    },
    save: async () => undefined
  };
  const openEditor = async (notePath: string) => { editorPaths.push(notePath); assert.equal(notePath, NOTE, "all reads and follow-ups must stay on the original note"); return editor; };
  service = new InlineRequestService("concurrency-vault", {
    load: async () => structuredClone(records),
    save: async next => { records = structuredClone([...next]); }
  }, { editor: openEditor, changed() {}, report: error => { reports.push(error); } });
  await service.initialize();
  const runs: ManualRun[] = [], busy = new Map<string, string>(), released = new Set<string>(), subscriptions = new Set<string>(), aborted = new Set<string>();
  let busyRejects = 0;
  const plugin = {
    accountService: paidTestAccess,
    settings,
    getVaultPath: () => tmpdir(),
    createPiConversation: async input => ({ conversationId: input.conversationId, piSessionId: `session-${input.conversationId}`, vaultId: "concurrency-vault",
      title: input.title, agentId: input.agentId, status: "active" as const, defaultMemoryMode: input.defaultMemoryMode ?? "normal", createdAt: Date.now(), updatedAt: Date.now() }),
    submitPiChat: async request => {
      if ([...busy.values()].includes(request.conversationId)) { busyRejects++; throw new Error("当前会话仍被上一轮占用。"); }
      const id = `concurrency-run-${runs.length + 1}`;
      let resolve!: ManualRun["resolve"];
      const result = new Promise<Readonly<PiProductRunRecord>>(done => { resolve = done; });
      runs.push({ id, request, resolve, settled: false }); busy.set(id, request.conversationId);
      return { productRunId: id, conversationId: request.conversationId, piSessionId: `session-${request.conversationId}`, userEntryId: `${id}-user`, result };
    },
    subscribePiRun: runId => { assert.ok(busy.has(runId)); subscriptions.add(runId); return { unsubscribe: () => { subscriptions.delete(runId); } }; },
    releasePiProductionRun: runId => {
      assert.ok(busy.delete(runId), "only an explicit, single release may clear the host busy map");
      assert.equal(released.has(runId), false); released.add(runId);
    },
    abortPiConversation: async taskId => { for (const [runId, conversationId] of busy) if (conversationId === taskId) aborted.add(runId); }
  } satisfies Pick<CodexForObsidianPlugin, "settings" | "getVaultPath" | "createPiConversation" | "submitPiChat" | "subscribePiRun" | "releasePiProductionRun" | "abortPiConversation">;
  const controller = new InlineAgentRuntimeController(plugin as unknown as CodexForObsidianPlugin, service, { editor: openEditor, openTask: async () => undefined });
  const get = (id: string) => { const record = service.get(id); assert.ok(record); return record; };
  const runsFor = (id: string) => runs.filter(run => run.request.inlineProposalRequest?.requestId === id);
  const waitForRuns = async (id: string, count: number) => {
    await until(() => runsFor(id).length >= count, `${id} did not submit run ${count}; ${JSON.stringify(get(id))}`);
    assert.equal(runsFor(id).length, count, get(id).error); return runsFor(id)[count - 1];
  };
  const settle = (run: ManualRun, terminalState: "completed" | "failed" | "cancelled", output?: InlineModelOutput) => {
    assert.equal(run.settled, false); run.settled = true;
    run.resolve({ productRunId: run.id, conversationId: run.request.conversationId, piSessionId: `session-${run.request.conversationId}`, userEntryId: `${run.id}-user`,
      toolCallIds: [], memoryMode: run.request.memoryMode ?? "normal", permission: "read-only", state: "product_run_settled", terminalState,
      activeLeafId: `${run.id}-assistant`, createdAt: run.request.submittedAt, updatedAt: Date.now(), settledAt: Date.now(),
      ...(output ? { inlineProposalResult: output } : {}), ...(terminalState === "failed" ? { error: "synthetic failure before target resolution" } : {}) });
    assert.ok(busy.has(run.id), "result settlement must not implicitly release the host busy map");
  };
  const proposal = (run: ManualRun, original: string, text: string) => {
    const candidates = run.request.inlineProposalRequest?.candidates.filter(candidate => candidate.kind === "replace" && candidate.text.includes(original));
    assert.equal(candidates?.length, 1, `the exact original must belong to one candidate: ${original}`);
    settle(run, "completed", { kind: "proposal", candidateId: candidates![0].id, original, text });
  };
  const rangeProposal = (run: ManualRun, start: string, end: string, text: string) => {
    const candidates = run.request.inlineProposalRequest?.candidates;
    const first = candidates?.find(candidate => candidate.kind === "replace" && candidate.text === start);
    const last = candidates?.find(candidate => candidate.kind === "replace" && candidate.text === end);
    assert.ok(first && last, "both full paragraphs must be independently selectable in the model request");
    assert.notEqual(first.id, last.id); assert.ok(first.boundaryGroup); assert.equal(first.boundaryGroup, last.boundaryGroup);
    settle(run, "completed", { kind: "proposal", startCandidateId: first.id, endCandidateId: last.id, text });
  };
  const done = async (run: ManualRun) => { await until(() => released.has(run.id) && !subscriptions.has(run.id), `${run.id} never released`); await drain(); };
  const send = async (label: Label) => {
    const document = editor.read(), command = commands[label], from = document.indexOf(command), previous = new Set(service.list().map(record => record.id));
    assert.ok(from >= 0); assert.equal(document.indexOf(command, from + 1), -1);
    await controller.sendDraft({ path: NOTE, agentId: agent.id, trigger: "@", from, to: from + command.length, document, text: `处理${label}段` });
    const record = service.list().find(item => !previous.has(item.id)); assert.ok(record);
    await waitForRuns(record.id, 1); return get(record.id);
  };
  const confirm = async (id: string, duplicate = false) => {
    const record = get(id), calls = [service.confirm(id, record.currentVersionId)];
    if (duplicate) calls.push(service.confirm(id, record.currentVersionId));
    await Promise.all(calls); await drain(); assert.equal(get(id).status, "confirmed");
  };
  return {
    service, controller, editor, runs, busy, released, subscriptions, aborted, reports, editorPaths, transactions, get, runsFor, waitForRuns, settle, proposal, rangeProposal, done, send, edit, confirm,
    switchGlobalModel() {
      const later = structuredClone(provider); later.id = "later-provider"; later.runtimeProviderId = "later-runtime";
      later.models[0].id = "later-model"; later.defaultModelId = later.models[0].id;
      settings.apiProviders = [later]; settings.activeApiProviderId = later.id; settings.defaultModel = later.models[0].id;
    },
    assertHealthy() { assert.equal(busyRejects, 0); assert.deepEqual(reports, []); },
    async close() {
      controller.dispose();
      for (const run of runs) if (!run.settled) settle(run, "cancelled");
      await drain(); await service.dispose();
    }
  };
}

async function nonOverlapping(first: "甲" | "乙"): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    assert.ok(typeof a.order === "number" && typeof b.order === "number" && a.order < b.order); assert.equal(f.get(a.id).targetResolved, false);
    const source = f.editor.read();
    f.proposal(bRun, ORIGINAL_B, "乙段新稿：短句。"); await f.done(bRun);
    assert.equal(f.get(b.id).status, "queued"); assert.equal(f.get(b.id).queue?.reason, "unresolved");
    assert.ok(f.get(b.id).queue?.blockedBy.includes(a.id)); assert.equal(f.get(b.id).queue?.regenerate, false);
    assert.ok(f.get(b.id).preparedProposal); assert.equal(f.get(b.id).versions.length, 0); assert.equal(f.editor.read(), source);
    f.proposal(aRun, ORIGINAL_A, "甲段新稿：经过确认的重点。"); await f.done(aRun);
    await until(() => f.get(a.id).status === "pending" && f.get(b.id).status === "pending", "non-overlapping prepared proposals did not both become pending");
    assert.equal(f.runs.length, 2, "disjoint prepared output must publish without another model call");
    const firstId = first === "甲" ? a.id : b.id, otherId = first === "甲" ? b.id : a.id, otherOriginal = first === "甲" ? ORIGINAL_B : ORIGINAL_A;
    await f.confirm(firstId);
    const remaining = f.get(otherId), current = f.editor.read();
    assert.equal(remaining.status, "pending", `unrelated block changed state after ${first} confirmation: ${JSON.stringify({ queue: remaining.queue, runs: f.runs.length, target: [remaining.target.from, remaining.target.to] })}`); assert.equal(remaining.target.from, current.indexOf(otherOriginal));
    assert.equal(current.slice(remaining.target.from, remaining.target.to), otherOriginal, "the other block must map through the first confirmation transaction");
    await f.confirm(otherId, true);
    assert.match(f.editor.read(), /甲段新稿：经过确认的重点。/u); assert.match(f.editor.read(), /乙段新稿：短句。/u);
    assert.ok(f.editor.read().includes(ORIGINAL_C)); assert.equal(f.editor.read().includes(ORIGINAL_A), false); assert.equal(f.editor.read().includes(ORIGINAL_B), false);
    for (const id of [a.id, b.id]) assert.equal(f.transactions.filter(transaction => transaction.requestId === id && transaction.history === "normal").length, 1);
    assert.equal(f.busy.size, 0); f.assertHealthy();
    console.log(`PASS inline concurrency: later disjoint result queues until first target resolves; ${first} confirms first and both anchors map correctly`);
  } finally { await f.close(); }
}

async function overlapping(action: "confirm" | "revoke" | "missing"): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    f.proposal(aRun, ORIGINAL_A, "甲段已确认的新原文。"); await f.done(aRun);
    f.proposal(bRun, ORIGINAL_A, "不得发布的旧快照稿。"); await f.done(bRun);
    assert.equal(f.get(a.id).status, "pending"); assert.equal(f.get(b.id).status, "queued");
    assert.equal(f.get(b.id).queue?.reason, "overlap"); assert.equal(f.get(b.id).queue?.regenerate, true); assert.ok(f.get(b.id).queue?.blockedBy.includes(a.id));
    const frozen = f.get(b.id).model; assert.ok(frozen);
    const from = f.editor.read().indexOf(ORIGINAL_C); f.edit([{ from, to: from + ORIGINAL_C.length, insert: LATEST_C }]);
    f.switchGlobalModel();
    if (action === "confirm") await f.confirm(a.id);
    else if (action === "revoke") { await f.service.revoke(a.id, f.get(a.id).currentVersionId); assert.equal(f.get(a.id).status, "revoked"); }
    else {
      const instruction = locateInstruction(f.editor.read(), f.get(a.id)); assert.ok(instruction);
      f.edit([{ from: instruction.from, to: instruction.to, insert: "" }]);
      assert.equal(f.get(a.id).status, "missing");
    }
    const regenerated = await f.waitForRuns(b.id, 2), latestOriginal = action === "confirm" ? "甲段已确认的新原文。" : ORIGINAL_A;
    const reread = regenerated.request.inlineProposalRequest?.context; assert.ok(reread);
    assert.ok(reread.includes(latestOriginal)); assert.ok(reread.includes(LATEST_C), "automatic regeneration must reread the changed document");
    assert.equal(reread.includes("不得发布的旧快照稿。"), false); assert.equal(f.get(b.id).readContext?.text, reread);
    assert.equal(regenerated.request.providerSettingsId, frozen.providerSettingsId); assert.equal(regenerated.request.runtimeProviderId, frozen.runtimeProviderId);
    assert.equal(regenerated.request.modelId, frozen.modelId); assert.equal(regenerated.request.reasoning, frozen.reasoning); assert.equal(regenerated.request.memoryMode, frozen.memoryMode);
    assert.equal(f.get(b.id).versions.length, 0, "a known-overlap prepared draft must never become a published version");
    f.proposal(regenerated, latestOriginal, `乙段重新生成：前块${action}后使用最新原文。`); await f.done(regenerated);
    assert.equal(f.get(b.id).status, "pending"); assert.equal(f.get(b.id).versions.length, 1);
    await f.confirm(b.id); assert.ok(f.editor.read().includes(`乙段重新生成：前块${action}后使用最新原文。`));
    assert.ok(f.editor.read().includes(LATEST_C)); assert.equal(f.editor.read().includes("不得发布的旧快照稿。"), false);
    f.assertHealthy(); console.log(`PASS inline concurrency: overlap waits for predecessor ${action}, then automatically rereads and regenerates with frozen model`);
  } finally { await f.close(); }
}

async function retryKeepsPriority(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), firstOrder = a.order; assert.equal(typeof firstOrder, "number");
    f.proposal(f.runsFor(b.id)[0], ORIGINAL_A, "后块不能插队。"); await f.done(f.runsFor(b.id)[0]);
    f.settle(f.runsFor(a.id)[0], "failed"); await f.done(f.runsFor(a.id)[0]);
    assert.equal(f.get(b.id).status, "queued");
    await f.controller.retry(a.taskId); const retry = await f.waitForRuns(a.id, 2);
    assert.equal(f.get(a.id).order, firstOrder); assert.equal(f.get(a.id).id, a.id); assert.equal(f.get(a.id).targetResolved, false);
    assert.equal(f.get(b.id).status, "queued"); assert.equal(f.runsFor(b.id).length, 1);
    f.proposal(retry, ORIGINAL_A, "前块重试稿。"); await f.done(retry);
    assert.equal(f.get(a.id).status, "pending"); assert.equal(f.get(b.id).status, "queued"); assert.equal(f.get(b.id).queue?.reason, "overlap");
    assert.ok(f.get(b.id).queue?.blockedBy.includes(a.id)); assert.equal(f.runsFor(b.id).length, 1, "retry must not move the predecessor behind the queued request");
    await f.service.revoke(a.id, f.get(a.id).currentVersionId);
    const second = await f.waitForRuns(b.id, 2); f.proposal(second, ORIGINAL_A, "前块撤销后后块新稿。"); await f.done(second);
    assert.equal(f.get(b.id).status, "pending"); assert.equal(f.get(a.id).order, firstOrder);
    f.assertHealthy(); console.log("PASS inline concurrency: failed predecessor retries under the same order and never lets its overlapping successor jump ahead");
  } finally { await f.close(); }
}

async function versionsStopAndDuplicateConfirm(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), first = f.runsFor(a.id)[0];
    f.proposal(first, ORIGINAL_A, "第一版。"); await f.done(first);
    await f.controller.reply(a.taskId, "改成第二版"); const second = await f.waitForRuns(a.id, 2);
    assert.equal(f.get(a.id).order, a.order); assert.equal(f.get(a.id).targetResolved, false); assert.equal(second.request.inlineProposalRequest?.previousDraft, "第一版。");
    f.proposal(second, ORIGINAL_A, "第二版。"); await f.done(second);
    assert.equal(f.service.latestForTask(a.taskId)?.id, a.id); assert.deepEqual(f.get(a.id).versions.map(version => version.text), ["第一版。", "第二版。"]);
    await f.confirm(a.id, true); assert.equal(f.transactions.filter(transaction => transaction.requestId === a.id && transaction.history === "normal").length, 1);
    await f.controller.reply(a.taskId, "确认后再写一版");
    const later = f.service.latestForTask(a.taskId); assert.ok(later); assert.notEqual(later.id, a.id); assert.equal(later.path, NOTE); assert.equal(later.taskId, a.taskId);
    assert.ok(typeof later.order === "number" && typeof a.order === "number" && later.order > a.order); const lateRun = await f.waitForRuns(later.id, 1), beforeLate = f.editor.read();
    let stopped = false;
    const stopping = f.controller.stop(a.taskId).then(() => { stopped = true; });
    await until(() => f.aborted.has(lateRun.id), "stop never reached the active ProductRun"); await drain();
    assert.equal(stopped, false, "stop must await the host release even if native abort has already returned");
    f.proposal(lateRun, "第二版。", "停止后晚到的旧回答不得进入正文。"); await stopping; await f.done(lateRun);
    assert.equal(f.get(later.id).status, "interrupted"); assert.equal(f.get(later.id).versions.length, 0); assert.equal(f.editor.read(), beforeLate);
    await f.controller.retry(a.taskId); const replacement = await f.waitForRuns(later.id, 2);
    assert.equal(f.get(later.id).order, later.order);
    f.proposal(replacement, "第二版。", "停止后重新生成的有效稿。"); await f.done(replacement);
    assert.equal(f.get(later.id).versions.length, 1); await f.confirm(later.id, true);
    assert.equal(f.transactions.filter(transaction => transaction.requestId === later.id && transaction.history === "normal").length, 1);
    assert.equal(f.editor.read().includes("停止后晚到的旧回答"), false); assert.equal(f.editor.read().split("停止后重新生成的有效稿。").length - 1, 1);
    assert.equal(f.busy.size, 0); assert.equal(f.subscriptions.size, 0); f.assertHealthy();
    console.log("PASS inline concurrency: pre-confirm reply versions stay on one request; post-confirm reply creates a new request on the same task/path; stopped late output and duplicate confirms never double-apply");
  } finally { await f.close(); }
}

async function threeBlocksConfirmTogether(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), c = await f.send("丙");
    assert.ok(typeof a.order === "number" && typeof b.order === "number" && typeof c.order === "number" && a.order < b.order && b.order < c.order);
    const aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0], cRun = f.runsFor(c.id)[0];
    f.proposal(cRun, ORIGINAL_C, "丙段并发确认稿。"); await f.done(cRun);
    assert.equal(f.get(c.id).status, "queued"); assert.deepEqual(f.get(c.id).queue?.blockedBy, [a.id, b.id]);
    f.proposal(bRun, ORIGINAL_B, "乙段并发确认稿。"); await f.done(bRun);
    assert.equal(f.get(b.id).status, "queued"); assert.deepEqual(f.get(c.id).queue?.blockedBy, [a.id]);
    f.proposal(aRun, ORIGINAL_A, "甲段并发确认稿。"); await f.done(aRun);
    await until(() => [a, b, c].every(record => f.get(record.id).status === "pending"), "three disjoint requests did not become independently confirmable");
    // These calls deliberately race on one document, including a duplicate click.
    await Promise.all([f.confirm(a.id), f.confirm(b.id), f.confirm(c.id), f.confirm(b.id)]);
    assert.equal(f.runs.length, 3, "serialized confirmations must not regenerate unrelated blocks");
    for (const [record, text, original] of [[a, "甲段并发确认稿。", ORIGINAL_A], [b, "乙段并发确认稿。", ORIGINAL_B], [c, "丙段并发确认稿。", ORIGINAL_C]] as const) {
      assert.equal(f.get(record.id).status, "confirmed"); assert.equal(f.editor.read().split(text).length - 1, 1); assert.equal(f.editor.read().includes(original), false);
      assert.equal(f.transactions.filter(transaction => transaction.requestId === record.id && transaction.history === "normal").length, 1);
    }
    const commits = f.transactions.filter(transaction => transaction.history === "normal");
    assert.equal(commits.length, 3);
    assert.equal(commits[1].before, commits[0].after); assert.equal(commits[2].before, commits[1].after, "every confirmation must read the previous transaction's document");
    assert.equal(f.busy.size, 0); f.assertHealthy();
    console.log("PASS inline concurrency: three reverse-order results preserve request priority; simultaneous confirms serialize against the latest document without regeneration or duplicate edits");
  } finally { await f.close(); }
}

async function sameInsertionPoint(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    const insert = (run: ManualRun, text: string) => {
      const candidate = run.request.inlineProposalRequest?.candidates.find(item => item.id === "insert-end");
      assert.ok(candidate); assert.equal(candidate.kind, "insert");
      f.settle(run, "completed", { kind: "proposal", candidateId: candidate.id, original: "", text });
    };
    insert(bRun, "不得发布的同点旧插入稿。"); await f.done(bRun);
    assert.equal(f.get(b.id).queue?.reason, "unresolved");
    insert(aRun, "\n甲块先插入。\n"); await f.done(aRun);
    assert.equal(f.get(a.id).status, "pending"); assert.equal(f.get(b.id).status, "queued");
    assert.equal(f.get(a.id).target.from, f.get(b.id).target.from); assert.equal(f.get(b.id).queue?.reason, "overlap"); assert.equal(f.get(b.id).queue?.regenerate, true);
    await f.confirm(a.id);
    const regenerated = await f.waitForRuns(b.id, 2);
    assert.ok(regenerated.request.inlineProposalRequest?.context.includes("甲块先插入。"), "same-point successor must reread the committed insertion");
    assert.equal(f.get(b.id).versions.length, 0); insert(regenerated, "\n乙块重生后插入。\n"); await f.done(regenerated);
    assert.equal(f.get(b.id).status, "pending"); assert.equal(f.get(b.id).target.from, f.editor.read().length);
    await f.confirm(b.id, true);
    const document = f.editor.read();
    assert.ok(document.indexOf("甲块先插入。") < document.indexOf("乙块重生后插入。"));
    assert.equal(document.split("甲块先插入。").length - 1, 1); assert.equal(document.split("乙块重生后插入。").length - 1, 1);
    assert.equal(document.includes("不得发布的同点旧插入稿。"), false); assert.ok(document.includes(ORIGINAL_A) && document.includes(ORIGINAL_B) && document.includes(ORIGINAL_C));
    assert.equal(f.runs.length, 3); assert.equal(f.transactions.filter(transaction => transaction.requestId === b.id && transaction.history === "normal").length, 1);
    f.assertHealthy(); console.log("PASS inline concurrency: equal insertion points queue as overlap and regenerate after the predecessor commits, preserving insertion order and single application");
  } finally { await f.close(); }
}

async function inFlightGenerationSnapshotStaysConsistent(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    const sentDocument = f.editor.read(), sentContext = bRun.request.inlineProposalRequest?.context;
    assert.ok(sentContext); assert.equal(f.get(b.id).readContext?.text, sentContext);
    const originalOffset = sentDocument.indexOf(ORIGINAL_B); assert.ok(originalOffset >= 0);
    f.proposal(aRun, ORIGINAL_A, "甲段先确认，显著缩短正文。"); await f.done(aRun); await f.confirm(a.id);
    const movedDocument = f.editor.read();
    assert.equal(bRun.settled, false, "the second model must still be running when the first block changes the document");
    assert.notEqual(movedDocument.length, sentDocument.length); assert.notEqual(movedDocument.indexOf(ORIGINAL_B), originalOffset);
    f.proposal(bRun, ORIGINAL_B, "乙段根据原始生成快照完成的新稿。"); await f.done(bRun);
    const pending = f.get(b.id), version = pending.versions.find(item => item.id === pending.currentVersionId); assert.ok(version);
    assert.equal(pending.status, "pending"); assert.equal(f.runs.length, 2, "a non-overlapping document shift must not trigger regeneration");
    assert.equal(version.sourceDocument, sentDocument, "version sourceDocument must preserve the exact document used by the model");
    assert.equal(version.context.text, sentContext, "version context must preserve the model-facing cleaned text");
    assert.equal(version.target.from, originalOffset);
    assert.equal(version.sourceDocument.slice(version.target.from, version.target.to), version.target.text);
    assert.equal(version.target.text, ORIGINAL_B);
    for (const segment of version.context.segments) {
      assert.equal(version.sourceDocument.slice(segment.sourceFrom, segment.sourceTo), version.context.text.slice(segment.cleanFrom, segment.cleanTo), "every context segment must refer to the immutable generation document");
    }
    assert.equal(pending.target.from, movedDocument.indexOf(ORIGINAL_B)); assert.notEqual(pending.target.from, version.target.from);
    assert.equal(movedDocument.slice(pending.target.from, pending.target.to), ORIGINAL_B, "the live request target must follow current editor coordinates separately");
    await f.confirm(b.id);
    assert.ok(f.editor.read().includes("甲段先确认，显著缩短正文。")); assert.ok(f.editor.read().includes("乙段根据原始生成快照完成的新稿。"));
    assert.equal(f.editor.read().includes(ORIGINAL_B), false); assert.deepEqual(f.get(b.id).versions.find(item => item.id === version.id), version, "confirming at the mapped target must not rewrite the generation snapshot");
    f.assertHealthy(); console.log("PASS inline concurrency: an in-flight result retains a consistent immutable source/context/target snapshot after an earlier confirmation moves its live target");
  } finally { await f.close(); }
}

async function multiParagraphGenerationSnapshot(): Promise<void> {
  const f = await fixture(multiDocument);
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    const sentDocument = f.editor.read(), sentContext = bRun.request.inlineProposalRequest!.context;
    const candidates = bRun.request.inlineProposalRequest!.candidates;
    const heading = candidates.find(candidate => candidate.text === "### 核对"); assert.ok(heading);
    assert.equal(heading.label, "并发正文 › 乙节 › 核对"); assert.ok(heading.boundaryGroup);
    assert.ok(candidates.filter(candidate => candidate.kind === "replace").every(candidate => candidate.boundaryGroup && !("from" in candidate) && !("to" in candidate)));
    f.proposal(aRun, ORIGINAL_A, "甲段先确认的短稿。"); await f.done(aRun); await f.confirm(a.id);
    assert.equal(bRun.settled, false); const beforeResult = f.editor.read();
    f.rangeProposal(bRun, MULTI_B, MULTI_C, "乙节与核对一并整理的新稿。"); await f.done(bRun);
    const pending = f.get(b.id), version = pending.versions.find(item => item.id === pending.currentVersionId); assert.ok(version);
    assert.equal(pending.status, "pending"); assert.equal(pending.section, MULTI_SECTION); assert.equal(f.runs.length, 2);
    assert.equal(f.editor.read(), beforeResult, "publishing a multi-paragraph proposal must not write any target text");
    assert.equal(version.target.text, MULTI_ORIGINAL, "the full snapshot slice must retain headings, blank lines, indentation and trailing spaces");
    assert.equal(version.sourceDocument, sentDocument); assert.equal(version.context.text, sentContext);
    assert.equal(version.target.from, sentDocument.indexOf(MULTI_B));
    assert.equal(version.sourceDocument.slice(version.target.from, version.target.to), MULTI_ORIGINAL);
    for (const segment of version.context.segments) assert.equal(version.sourceDocument.slice(segment.sourceFrom, segment.sourceTo), version.context.text.slice(segment.cleanFrom, segment.cleanTo));
    assert.equal(pending.target.from, beforeResult.indexOf(MULTI_B)); assert.notEqual(pending.target.from, version.target.from);
    assert.equal(beforeResult.slice(pending.target.from, pending.target.to), MULTI_ORIGINAL);
    f.service.compare(b.id); await assert.rejects(f.service.confirm(b.id, version.id), /切回新稿/u); assert.equal(f.editor.read(), beforeResult);
    f.service.compare(b.id); await f.confirm(b.id, true);
    assert.ok(f.editor.read().includes("甲段先确认的短稿。")); assert.ok(f.editor.read().includes("乙节与核对一并整理的新稿。"));
    assert.equal(f.editor.read().includes("### 核对"), false); assert.equal(f.editor.read().includes(ORIGINAL_B), false); assert.equal(f.editor.read().includes(ORIGINAL_C), false);
    assert.deepEqual(f.get(b.id).versions[0], version); f.assertHealthy();
    console.log("PASS inline concurrency: multi-paragraph output keeps the full immutable source and cross-section label while its live target maps through an earlier confirmation");
  } finally { await f.close(); }
}

async function multiParagraphOverlapRegenerates(): Promise<void> {
  const f = await fixture(multiDocument);
  try {
    const a = await f.send("甲"), b = await f.send("乙"), aRun = f.runsFor(a.id)[0], bRun = f.runsFor(b.id)[0];
    f.rangeProposal(bRun, MULTI_B, MULTI_C, "不可复用的多段旧稿。"); await f.done(bRun);
    assert.equal(f.get(b.id).queue?.reason, "unresolved"); assert.equal(f.get(b.id).preparedProposal?.original, MULTI_ORIGINAL);
    f.proposal(aRun, ORIGINAL_B, "乙段已由前块确认的新事实。"); await f.done(aRun);
    assert.equal(f.get(b.id).status, "queued"); assert.equal(f.get(b.id).queue?.reason, "overlap"); assert.equal(f.get(b.id).queue?.regenerate, true);
    const at = f.editor.read().indexOf("### 核对"); f.edit([{ from: at, to: at + "### 核对".length, insert: "### 最新核对" }]);
    await f.confirm(a.id); const regenerated = await f.waitForRuns(b.id, 2), request = regenerated.request.inlineProposalRequest!;
    assert.ok(request.context.includes("乙段已由前块确认的新事实。")); assert.ok(request.context.includes("### 最新核对"));
    assert.equal(request.previousDraft?.includes("不可复用的多段旧稿。") ?? false, false);
    assert.equal(f.get(b.id).versions.length, 0, "the stale multi-paragraph proposal must never become a version");
    const first = request.candidates.find(candidate => candidate.text.includes("乙段已由前块确认的新事实。")); assert.ok(first);
    f.rangeProposal(regenerated, first.text, MULTI_C, "按最新小节和前块事实生成的多段稿。"); await f.done(regenerated);
    const pending = f.get(b.id), current = f.editor.read();
    assert.equal(pending.status, "pending"); assert.equal(pending.versions.length, 1);
    assert.ok(pending.target.text.includes("### 最新核对")); assert.ok(pending.target.text.includes("乙段已由前块确认的新事实。"));
    assert.equal(pending.versions[0].sourceDocument, current); assert.equal(current.includes("不可复用的多段旧稿。"), false);
    await f.confirm(b.id); assert.ok(f.editor.read().includes("按最新小节和前块事实生成的多段稿。"));
    assert.equal(f.editor.read().includes("不可复用的多段旧稿。"), false); f.assertHealthy();
    console.log("PASS inline concurrency: an overlapping queued multi-paragraph draft is discarded and regenerated from the latest paragraphs and heading");
  } finally { await f.close(); }
}

async function multiParagraphChangesBlockConfirmation(change: "paragraph" | "heading" | "blank"): Promise<void> {
  const f = await fixture(multiDocument);
  try {
    const b = await f.send("乙"), run = f.runsFor(b.id)[0]; f.rangeProposal(run, MULTI_B, MULTI_C, "不得覆盖人工修改的多段稿。"); await f.done(run);
    const record = f.get(b.id), prefix = "范围外新增\n";
    f.edit([{ from: 0, to: 0, insert: prefix }]);
    assert.equal(f.get(b.id).status, "pending"); assert.equal(f.get(b.id).target.from, record.target.from + prefix.length);
    const document = f.editor.read(), needle = change === "paragraph" ? ORIGINAL_C : change === "heading" ? "### 核对" : "\n\n\n### 核对";
    const at = document.indexOf(needle); assert.ok(at >= 0);
    const from = change === "blank" ? at + 1 : at + 2, to = change === "blank" ? from : from + 1;
    f.edit([{ from, to, insert: change === "blank" ? " " : "改" }]);
    const modified = f.editor.read(); assert.equal(f.get(b.id).status, "conflict");
    await assert.rejects(f.service.confirm(b.id, record.currentVersionId), /变动|变化|定位/u);
    assert.equal(f.editor.read(), modified); assert.equal(f.transactions.filter(transaction => transaction.requestId === b.id && transaction.history === "normal").length, 0);
    f.assertHealthy(); console.log(`PASS inline concurrency: an outside edit only moves a multi-paragraph target, while a middle ${change} edit blocks confirmation`);
  } finally { await f.close(); }
}

async function multiParagraphControlBoundary(control: "own" | "other"): Promise<void> {
  const f = await fixture(commands => `# 并发正文\n\n${ORIGINAL_A}\n\n${commands.甲}\n\n${ORIGINAL_B}\n\n${commands.乙}\n\n${ORIGINAL_C}\n\n${commands.丙}`);
  try {
    const a = await f.send("甲"), b = control === "other" ? await f.send("乙") : a, run = f.runsFor(b.id)[0];
    const request = run.request.inlineProposalRequest!, first = request.candidates.find(candidate => candidate.text === ORIGINAL_A), last = request.candidates.find(candidate => candidate.text === ORIGINAL_B);
    assert.ok(first && last); assert.notEqual(first.boundaryGroup, last.boundaryGroup, "removing a control must leave a model-visible boundary");
    const before = f.editor.read();
    f.settle(run, "completed", { kind: "proposal", startCandidateId: first.id, endCandidateId: last.id, text: "绝不能吞掉指令的跨段稿。" }); await f.done(run);
    const failed = f.get(b.id); assert.equal(failed.status, "failed"); assert.match(failed.error ?? "", /把 @ 指令移到.*范围外/u);
    assert.equal(failed.queue, undefined); assert.equal(failed.preparedProposal, undefined); assert.equal(failed.versions.length, 0); assert.equal(f.editor.read(), before);
    console.log(`PASS inline concurrency: a range crossing the ${control} control is rejected before queueing with a move-instruction hint`);
  } finally { await f.close(); }
}

async function overlappingSelectionSnapshot(): Promise<void> {
  const f = await fixture();
  try {
    const a = await f.send("甲"), b = await f.send("乙");
    for (const [record, original] of [[a, ORIGINAL_A], [b, ORIGINAL_B]] as const) {
      const run = f.runsFor(record.id)[0]; f.proposal(run, original, "各自第一稿"); await f.done(run);
    }
    const selectedText = "R5_QUEUE_OTHER_NOTE_ONLY", annotations = [{ id: "queue-selection", number: 1, selectedText, vaultRelativePath: "引用.md", fileName: "引用.md",
      anchor: { mode: "editor" as const, from: 0, to: selectedText.length, before: "", after: "" }, appliedActions: [] }];
    await f.controller.reply(b.taskId, "注释1，结合选段改甲段", annotations);
    const run = f.runsFor(b.id).at(-1)!; f.proposal(run, ORIGINAL_A, "重叠等待稿"); await f.done(run);
    assert.equal(f.get(b.id).status, "queued"); annotations[0].selectedText = "后来改过的草稿";
    await f.confirm(a.id);
    const regenerated = await f.waitForRuns(b.id, 3);
    assert.equal(regenerated.request.selectionAnnotations?.[0].selectedText, selectedText);
    assert.deepEqual(f.get(b.id).thread?.filter(message => message.role === "user").at(-1)?.selectionAnnotations, run.request.selectionAnnotations);
    f.proposal(regenerated, "各自第一稿", "引用仍保留的重生稿"); await f.done(regenerated); f.assertHealthy();
  } finally { await f.close(); }
}

const cases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
  ["overlap-selection-snapshot", overlappingSelectionSnapshot],
  ["disjoint-confirm-first", () => nonOverlapping("甲")],
  ["disjoint-confirm-second", () => nonOverlapping("乙")],
  ...(["confirm", "revoke", "missing"] as const).map(action => [`overlap-${action}`, () => overlapping(action)] as const),
  ["retry-order", retryKeepsPriority], ["versions-stop-duplicate", versionsStopAndDuplicateConfirm],
  ["three-blocks-simultaneous-confirm", threeBlocksConfirmTogether], ["same-insertion-point", sameInsertionPoint],
  ["in-flight-generation-snapshot", inFlightGenerationSnapshotStaysConsistent],
  ["multi-paragraph-generation-snapshot", multiParagraphGenerationSnapshot], ["multi-paragraph-overlap-regenerates", multiParagraphOverlapRegenerates],
  ...(["paragraph", "heading", "blank"] as const).map(change => [`multi-paragraph-change-${change}`, () => multiParagraphChangesBlockConfirmation(change)] as const),
  ...(["own", "other"] as const).map(control => [`multi-paragraph-control-${control}`, () => multiParagraphControlBoundary(control)] as const)
];
const failures: Error[] = [];
for (const [name, run] of cases) {
  try { await run(); }
  catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); failures.push(failure); console.error(`FAIL inline concurrency ${name}:`, failure); }
}
if (failures.length) throw new AggregateError(failures, `${failures.length}/${cases.length} inline concurrency cases failed`);
