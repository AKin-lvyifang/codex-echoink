import assert from "node:assert/strict";
import { buildAgentTurns } from "../ui/codex-view/agent-turn-process";
import { PiChatUiProjector, type PiSessionBranchEntryView, type PiSessionMessageView } from "../harness/pi-native/pi-chat-ui-projector";
import { maintenanceFailureText, maintenanceVisibleCopyIsSafe } from "../knowledge-base/maintenance-user-copy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fixture } from "./knowledge-maintain-p2";
import { KnowledgeActivityService } from "../plugin/knowledge-activity-service";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import { MaintenanceActivityController } from "../plugin/maintenance-activity-controller";
import { readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { maintenanceActivityText, maintenanceBatchContext, maintenanceCompletionText, maintenanceTaskStateLabel, maintenanceStatusBarText, newMaintenanceProgress, projectMaintenanceActivity, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
import { applyMaintenanceSectionPatches, assertMaintenanceQuoteSectionsPreserved, createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
import { applyMaintenanceRelatedEntries } from "../knowledge-base/maintenance-p2-planning";
import type { MaintenanceP1Action } from "../knowledge-base/maintenance-p1-contract";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { maintenanceKnowledgeTypePrompt, MAINTENANCE_QUOTE_HARD_RULE } from "../knowledge-base/maintenance-knowledge-types";
import { ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES, KnowledgeMaintenancePreferenceRepository } from "../knowledge-base/knowledge-maintenance-preferences";

function linkingSource() {
  let listener = (_task: KnowledgeLinkingTask | null) => {};
  return { ready: Promise.resolve(), subscribe(fn: typeof listener) { listener = fn; fn(null); return () => { listener = () => {}; }; }, emit(task: KnowledgeLinkingTask) { listener(structuredClone(task)); } };
}
const page = (title: string) => `---\n类型: 概念\naliases: []\n---\n# ${title}\n${title}的独立定义。\n\n## 要点\n说明适用边界与使用方式。\n`;

export async function runMaintenanceActivityTests(root: string): Promise<void> {
  assertMaintenanceUserPresentation();
  await fs.mkdir(root, { recursive: true });
  let now = 1_800_000_000_000;
  const links = linkingSource(), source = new KnowledgeActivityService(links, async () => []), notices: string[] = [];
  await source.ready;
  const f = await fixture(path.join(root, "production"), { now: () => now, activitySource: source, notice: message => notices.push(message) });
  const paths = ["raw/one.md", "raw/two.md", "raw/three.md"];
  for (const [index, file] of paths.entries()) await f.write(file, `# 来源${index + 1}\n知识点${index + 1}有独立范围和用途。\n`);
  const units = await Promise.all(paths.map((file, index) => f.unit(`unit-${index}`, file, `知识点${index + 1}`)));
  let runId = "p3-live", sequence = 0;
  const call = async (p1: MaintenanceP1Action) => {
    const fingerprints: Record<string, string> = {};
    for (const file of paths) fingerprints[file] = rawDigestFingerprint(file, Buffer.from(await f.observe(file)));
    return f.port.execute({ vaultId: "p2-vault", conversationId: "p2-fixture", piSessionId: "fixture", productRunId: runId, toolCallId: `p3-${++sequence}`, mode: "maintain", request: "用户已确认从工作台整理资料，本批 2/3。", sourcePaths: paths, sourceBodyFingerprints: fingerprints, p1,
      preferenceSnapshot: { profileVersion: "fixture", state: "default", revision: `sha256:${"a".repeat(64)}` } });
  };
  const current = () => source.snapshot().maintenance.find(activity => !activity.id.startsWith("run:"))!;
  const count = (stage: string) => current().steps.find(step => step.stage === stage)!.completed;
  try {
    f.ok(await call({ stage: "decompose", decompositions: [{ sourcePath: paths[0], summary: "第一篇", units: [units[0]] }] }));
    assert.equal(count("decompose"), 1); assert.equal(current().etaMs, null);
    assert.deepEqual(current().batch, { index: 2, total: 3 });
    assert.equal(source.snapshot().maintenance.length, 1, "first record replaces, rather than duplicates, initial ProductRun activity");
    now += 20_000;
    f.ok(await call({ stage: "decompose", decompositions: [{ sourcePath: paths[1], summary: "第二篇", units: [units[1]] }] }));
    assert.equal(count("decompose"), 2); assert.equal(current().etaMs, 10_000);
    f.ok(await call({ stage: "decompose", decompositions: [{ sourcePath: paths[1], summary: "第二篇", units: [units[1]] }] }));
    assert.equal(count("decompose"), 2, "validated replay cannot double-count a source");
    const early = await call({ stage: "plan", writingPlan: [] });
    assert.equal(early.status, "failed"); assert.match(early.message, /全部来源校验/u);
    const duplicate = await call({ stage: "decompose", decompositions: [{ sourcePath: paths[2], summary: "第三篇", units: [{ ...units[2], id: units[0].id }] }] });
    assert.equal(duplicate.status, "failed"); assert.equal(count("decompose"), 2, "global ID validation precedes the next checkpoint");
    // Retry only the rejected unit, retaining the same frozen batch.
    await call({ stage: "inspect", view: "units" });
    const wait = (reason: string, waiting: boolean) => f.port.maintenanceActivity({ type: "waiting", conversationId: "p2-fixture", productRunId: runId, reason, waiting });
    await wait("question:real-question-id", true);
    const elapsedBeforeWait = current().activeElapsedMs;
    assert.equal(current().status, "waiting"); assert.equal(current().etaMs, null);
    assert.match(maintenanceActivityText(current()), /等你回应.*已读完 2 篇.*还剩 1 篇.*共 3 篇/u);
    assert.equal(maintenanceStatusBarText(current()), "EchoInk 整理知识：等你回应 · 拆知识点 2/3 篇");
    const broker = new PiAgentApprovalBroker((input, waiting) => wait(`approval:${input.requestId}`, waiting));
    const approval = { requestId: "approve-1", conversationId: "p2-fixture", piSessionId: "fixture", productRunId: runId, toolCallId: "approval-call", target: "fixture", preview: "fixture" };
    const decision = broker.waitForDecision(approval);
    await wait("question:real-question-id", false);
    now += 120_000;
    assert.equal(current().status, "waiting", "answering a question cannot resume an overlapping approval wait");
    assert.equal(broker.bindingFor(approval)!.decide("approve"), true); await decision;
    assert.equal(current().status, "running"); assert.equal(current().activeElapsedMs, elapsedBeforeWait);
    now += 3_000;
    await f.port.maintenanceActivity({ type: "stop", conversationId: "p2-fixture", productRunId: runId });
    const stoppedElapsed = current().activeElapsedMs;
    assert.equal(current().status, "interrupted");
    await f.port.dispose(); now += 3_600_000; await f.restart(); runId = "p3-resume";
    assert.equal(count("decompose"), 2); assert.equal(current().activeElapsedMs, stoppedElapsed);
    await call({ stage: "resume" });
    assert.equal(current().activeElapsedMs, stoppedElapsed, "offline and stopped time is never inferred from a timestamp");
    f.ok(await call({ stage: "decompose", decompositions: [{ sourcePath: paths[2], summary: "第三篇", units: [units[2]] }] }));
    assert.equal(current().stage, "plan"); assert.equal(current().steps.find(step => step.stage === "plan")!.total, null);
    assert.doesNotMatch(maintenanceActivityText(current()), /汇总查重.*汇总查重/u);
    const items = paths.map((file, index) => f.item(`page-${index}`, `wiki/知识点${index + 1}.md`, [file], [units[index].id]));
    f.ok(await call({ stage: "plan", writingPlan: items }));
    f.ok(await call({ stage: "write", pageId: "page-0", content: page("知识点1") }));
    assert.equal(count("write"), 1); assert.equal(current().etaMs, null);
    now += 20_000; f.fail(items[1].targetPath);
    assert.equal((await call({ stage: "write", pageId: "page-1", content: page("知识点2") })).status, "failed");
    assert.equal(count("write"), 1); assert.equal(current().failures.some(failure => failure.key === "write:page-1"), true);
    f.fail(null); now += 20_000;
    f.ok(await call({ stage: "resume" }));
    assert.equal(count("write"), 2); assert.equal(current().failures.some(failure => failure.key === "write:page-1"), false, "resume removes a resolved page failure");
    assert.ok(current().etaMs! > 0);
    const firstWrites = f.writes.filter(file => file === items[0].targetPath).length;
    now += 10_000;
    f.ok(await call({ stage: "write", pageId: "page-2", content: page("知识点3") }));
    assert.equal(current().status, "completed"); assert.equal(count("write"), 3); assert.equal(current().completedAt, now);
    assert.equal(f.writes.filter(file => file === items[0].targetPath).length, firstWrites);
    assert.equal(notices.length, 1);
    assert.deepEqual(current().pageCounts, { written: 3, created: 3, updated: 0 });
    assert.equal(notices[0], maintenanceCompletionText(current()));
    assert.equal(notices[0], "整理完 3 篇资料，生成 3 页 Wiki（新建 3 页，更新 0 页）");
    await f.port.maintenanceActivity({ type: "settled", conversationId: "p2-fixture", productRunId: runId });
    const unsub = source.subscribe(() => {}); unsub(); assert.equal(notices.length, 1, "settlement and remount cannot repeat the terminal Notice");
    const records = await readPrivateMaintenanceRecords(f.privateRoot);
    assert.equal(records.length, 1); assert.equal(records[0].progress!.completedAt, now);
    const beforeNoop = JSON.stringify(records);
    // Same formal read-only no-op in another source Conversation never creates a maintenance record or leaves run: activity.
    const noop = await f.port.execute({ vaultId: "p2-vault", conversationId: "noop-conversation", piSessionId: "fixture", productRunId: "noop-run", toolCallId: "noop-tool", mode: "maintain", request: "", sourcePaths: paths, p1: { stage: "inspect", view: "pages" } });
    assert.equal(noop.maintenanceResult?.status, "noop");
    assert.equal(JSON.stringify(await readPrivateMaintenanceRecords(f.privateRoot)), beforeNoop);
    assert.equal(source.snapshot().maintenance.some(activity => activity.id === "run:noop-run"), false);
    await fs.writeFile(path.join(root, "p3-production.json"), JSON.stringify({ passed: true, snapshot: current(), notices, recordId: records[0].recordId, stoppedElapsed }, null, 2));
    broker.dispose();
  } finally { await f.port.dispose(); f.release(); source.dispose(); }

  assertProtectedQuoteSections();
  await assertInitialFailureSettlement();
  const oldDefault = ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES.replace(`${MAINTENANCE_QUOTE_HARD_RULE}\n`, "");
  for (const customized of [false, true]) {
    const repository = new KnowledgeMaintenancePreferenceRepository(path.join(root, customized ? "custom-pref" : "previous-p2-default"));
    await fs.mkdir(path.dirname(repository.filePath), { recursive: true });
    const content = customized ? oldDefault + "\n用户偏好：保留批判性分析。\n" : oldDefault;
    await fs.writeFile(repository.filePath, content);
    const snapshot = await repository.read();
    assert.equal(snapshot.state, customized ? "custom" : "default");
    assert.equal(await fs.readFile(repository.filePath, "utf8"), customized ? content : ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES);
  }
  await assertCoordinatorRestoreAndHandoff(root);
  console.log("P3 maintenance activity: PASS (incremental production checkpoints, unique counts/ETA, question+approval pause, stop/cold resume, failed-write recovery, one Notice, noop, protected user sections, coordinator restore/handoff)");
}

function assertProtectedQuoteSections(): void {
  const protectedBytes = "## 关键原句\r\n\r\n用户手写原句，不能动。  \r\n### 用户子节\r\n仍是用户内容。  ";
  const before = `# 用户页\r\n旧导语。\r\n\r\n## 正文\r\n可改正文。\r\n\r\n## 来源\r\n保留来源。\r\n\r\n${protectedBytes}`;
  const snapshot = createMaintenanceSectionSnapshot(before);
  assert.throws(() => createMaintenanceSectionSnapshot(before, ["关键原句"]), /关键原句/u);
  assert.throws(() => assertMaintenanceQuoteSectionsPreserved(undefined, "# 新页\n\n## 关键原句\n原句。\n"), /关键原句/u);
  for (const title of ["关键原句", "用户子节"]) assert.throws(() => applyMaintenanceSectionPatches(before, snapshot, [{ regionId: snapshot.regions.find(region => region.title === title)!.id, operation: "append", content: "错误改写。" }]), /逐字保留/u);
  const updated = applyMaintenanceSectionPatches(before, snapshot, [{ regionId: snapshot.regions.find(region => region.title === "正文")!.id, operation: "append", content: "新增正文。" }]);
  const related = applyMaintenanceRelatedEntries(updated, [{ targetPath: "wiki/另一个概念.md", reason: "说明使用边界" }], before);
  assert.ok(related.endsWith(protectedBytes)); assert.ok(related.indexOf("## 相关条目") < related.indexOf("## 关键原句"));
  assertMaintenanceQuoteSectionsPreserved(before, related);
  const withoutManagedSections = `# 用户页\r\n旧导语。\r\n\r\n## 正文\r\n可改正文。\r\n\r\n${protectedBytes}`;
  const insertion = createMaintenanceSectionSnapshot(withoutManagedSections, ["适用边界"]);
  const inserted = applyMaintenanceSectionPatches(withoutManagedSections, insertion, [{ regionId: insertion.regions.find(region => region.kind === "new-section")!.id, operation: "append", content: "新增适用边界。" }]);
  assert.ok(inserted.endsWith(protectedBytes), "a new semantic H2 before the protected EOF section preserves every protected byte");
  assert.ok(inserted.indexOf("## 适用边界") < inserted.indexOf("## 关键原句"));
  assertMaintenanceQuoteSectionsPreserved(withoutManagedSections, inserted);
  const fake = "# 正文\n\n```md\n## 关键原句\n代码示例。\n```\n";
  assert.doesNotThrow(() => assertMaintenanceQuoteSectionsPreserved(undefined, fake), "a fenced example is not a real generated section");
  assert.match(maintenanceKnowledgeTypePrompt(), /硬规则高于模板与用户内容偏好/u);
  assert.deepEqual(maintenanceBatchContext("/maintain 用户已确认知识库初始化，本批 3/5。"), { index: 3, total: 5 });
}

async function assertInitialFailureSettlement(): Promise<void> {
  let saved: import("../knowledge-base/maintenance-activity").MaintenanceInitialActivity | undefined, current: Readonly<MaintenanceActivity> | undefined;
  const notices: string[] = [];
  const controller = new MaintenanceActivityController({ now: () => 100, records: async () => [],
    state: { saveP1Record: async () => { throw new Error("initial failures must not create a maintenance record"); }, updateP1Progress: async () => { throw new Error("no record exists before strict validation"); } },
    runs: { read: async () => null, list: async () => [], setMaintenanceActivity: async (_id, activity) => { saved = structuredClone(activity); } },
    onInitial: activity => { current = activity; }, notice: message => notices.push(message) });
  const input = { vaultId: "fixture", conversationId: "initial-failure", piSessionId: "fixture", productRunId: "initial-run", toolCallId: "first-tool", mode: "maintain" as const, request: "", sourcePaths: ["raw/first.md"], p1: { stage: "decompose" as const, decompositions: [{ sourcePath: "raw/first.md", summary: "first", units: [] }] } };
  await controller.beforeTool(input);
  await controller.afterTool(input, true, "首篇原句校验未通过。");
  assert.equal(current!.status, "running", "a recoverable rejection keeps the live run active");
  assert.equal(saved!.progress.failures.length, 1);
  await controller.afterTool(input, false, "修正后通过。"); assert.equal(saved!.progress.failures.length, 0);
  await controller.afterTool(input, true, "首篇结构仍需修正。");
  await controller.lifecycle({ type: "settled", conversationId: input.conversationId, productRunId: input.productRunId, failed: true });
  assert.equal(current!.status, "failed"); assert.equal(saved!.progress.failures.length, 1);
  assert.deepEqual(saved!.progress.notified, ["settled:initial-run"]); assert.equal(notices.length, 1);
  await controller.lifecycle({ type: "settled", conversationId: input.conversationId, productRunId: input.productRunId, failed: true });
  assert.equal(notices.length, 1, "repeated terminal settlement cannot repeat an initial-run Notice");
  await controller.dispose();
}

async function assertCoordinatorRestoreAndHandoff(root: string): Promise<void> {
  const progress = newMaintenanceProgress(100, "write"); progress.updatedAt = 200;
  const record: KnowledgeMaintenanceRecord = { schemaVersion: 1, recordId: "maintenance-coordinator", originConversationId: "conversation", runId: "run:call", at: 100, date: "2026-10-22", summary: "fixture", sources: [], result: { status: "partial", notes: [], issues: [], linkingStatus: "not_requested" } as any,
    progress, p1: { version: 1, phase: "write", sourceFingerprints: {}, decompositions: [], writingPlan: [], drafts: {}, committedPages: {}, finalizedSources: [] } };
  const projected = projectMaintenanceActivity(record)!;
  const initial = { ...projected, id: "run:initial", updatedAt: 150 };
  for (const reverse of [false, true]) {
    const attempts = [initial, { ...initial, id: "run:resumed-before-first-checkpoint", updatedAt: 180 }];
    const service = new KnowledgeActivityService(linkingSource(), async () => [], async () => reverse ? attempts.reverse() : attempts);
    await service.ready;
    assert.equal(service.snapshot().maintenance.length, 1, "repeated stops before the first source checkpoint restore one Conversation activity");
    assert.equal(service.snapshot().primary?.id, "run:resumed-before-first-checkpoint");
    assert.equal(service.snapshot().other, null, "the older unbound ProductRun cannot revive as a duplicate entry");
    service.dispose();
  }
  for (const initialFirst of [true, false]) {
    const links = linkingSource(); let resolveRecords!: (value: KnowledgeMaintenanceRecord[]) => void, resolveInitial!: (value: MaintenanceActivity[]) => void;
    const records = new Promise<KnowledgeMaintenanceRecord[]>(resolve => { resolveRecords = resolve; }), pending = new Promise<MaintenanceActivity[]>(resolve => { resolveInitial = resolve; });
    const service = new KnowledgeActivityService(links, () => records, () => pending);
    if (initialFirst) { resolveInitial([initial]); await Promise.resolve(); resolveRecords([record]); }
    else { resolveRecords([record]); await Promise.resolve(); resolveInitial([initial]); }
    await service.ready;
    assert.equal(service.snapshot().maintenance.length, 1, "record/first-run bind crash is reconciled after both restore reads");
    let notifications = 0; const unsubscribe = service.subscribe(() => { notifications++; });
    service.update(record); const afterFirst = notifications;
    service.update({ ...record, progress: { ...progress, elapsedMs: { write: 1_000 }, updatedAt: 201 } });
    assert.equal(notifications, afterFirst, "elapsed-only heartbeat cannot rebuild visible task cards");
    const linking = { schemaVersion: 1, id: "linking", mode: "automatic", phase: "awaiting-confirmation", processed: 0, total: null, proposals: [], patches: [], results: [], bindingSignature: "fixture", createdAt: 200, updatedAt: 200, originConversationId: "other-conversation" } as KnowledgeLinkingTask;
    links.emit(linking); assert.equal(service.snapshot().primary?.kind, "linking"); assert.equal(service.snapshot().other?.kind, "maintenance");
    service.update({ ...record, progress: { ...progress, status: "waiting" } }); assert.equal(service.snapshot().primary?.kind, "maintenance");
    const seen: (string | null)[] = []; const off = service.subscribe(snapshot => seen.push(snapshot.primary?.kind ?? null));
    const done = { ...record, p1: { ...record.p1!, phase: "completed" as const }, progress: { ...progress, status: "completed" as const, completedAt: 300 } };
    service.update(done, true); links.emit({ ...linking, phase: "judging" }); service.settle(record.recordId);
    assert.equal(seen.includes(null), false, "maintenance hands off to persisted linking without an empty-slot frame");
    assert.equal(service.snapshot().primary?.kind, "linking");
    assert.equal(Object.isFrozen(linking), false, "readonly snapshots never freeze the linking service's live task");
    unsubscribe(); off(); service.dispose();
  }
  assert.equal(projectMaintenanceActivity({ ...record, p1: { ...record.p1!, phase: "completed" }, progress: undefined }), null, "old completed records cannot override the Catalog using their start time");
  let delayedTask: KnowledgeLinkingTask | null = null, delayedListener = (_task: KnowledgeLinkingTask | null) => {};
  const delayed = { ready: Promise.resolve(), snapshot: () => delayedTask ? structuredClone(delayedTask) : null, subscribe(listener: typeof delayedListener) { delayedListener = listener; listener(null); return () => { delayedListener = () => {}; }; } };
  const delayedService = new KnowledgeActivityService(delayed, async () => []); await delayedService.ready;
  delayedService.update(record);
  const trajectory: (string | null)[] = [];
  const unsubscribe = delayedService.subscribe(snapshot => trajectory.push(snapshot.primary?.kind ?? null));
  delayedService.update({ ...record, p1: { ...record.p1!, phase: "completed" }, progress: { ...progress, status: "completed", completedAt: 300 } }, true);
  delayedTask = { schemaVersion: 1, id: "persisted-before-notification", mode: "automatic", phase: "judging", processed: 0, total: null, proposals: [], patches: [], results: [], bindingSignature: "fixture", createdAt: 300, updatedAt: 300 };
  const notification = new Promise<void>(resolve => setTimeout(() => { delayedListener(structuredClone(delayedTask)); resolve(); }, 80));
  delayedService.settle(record.recordId);
  assert.equal(delayedService.snapshot().primary?.kind, "linking", "handoff reads the persisted LinkingService snapshot before its 80ms notification");
  await notification; assert.equal(trajectory.includes(null), false, "delayed subscriber publication cannot create an empty handoff frame");
  unsubscribe(); delayedService.dispose();
  await fs.writeFile(path.join(root, "p3-coordinator.json"), JSON.stringify({ passed: true, restoreOrders: 2, sameSource: true, noEmptyHandoff: true }));
}


export function assertMaintenanceUserPresentation(): void {
  assertMaintenanceColdReadPrivacy();
  for (const [status, label] of [["running", "进行中"], ["waiting", "等你回应"], ["interrupted", "没做完"], ["partial", "没做完"], ["failed", "没做完"], ["completed", "已完成"]] as const) assert.equal(maintenanceTaskStateLabel({ status }), label);
  const raw = 'pendingPageCount expectedTarget writingPlan decompositions sectionPatches contentRevision sourcePath sourcePaths targetPath regionId unitIds nextOffset resume stage revision CAS 清单 wiki/指数退避.md';
  assert.equal(maintenanceVisibleCopyIsSafe(raw), false);
  for (const token of ['recordId', 'toolCallId', 'productRunId', 'maintenanceStage', 'aliases', 'writingPlan', 'decompositions', 'sectionPatches', 'contentRevision', 'sourcePath', 'sourcePaths', 'targetPath', 'candidatePath', 'reverseReason', 'knowledge.decision', 'pendingPageCount', 'expectedTarget', 'regionId', 'unitIds', 'nextOffset', 'resume', 'stage', 'revision', 'CAS', '清单']) assert.equal(maintenanceVisibleCopyIsSafe(token), false, token);
  const friendly = maintenanceFailureText('目标并发编辑冲突：wiki/指数退避.md；resume expectedTarget contentRevision');
  assert.equal(friendly, '《指数退避》在整理时被改过。为了不覆盖你的修改，这一页先跳过了；点继续会重新读取后再写。');
  assert.ok(maintenanceVisibleCopyIsSafe(friendly));
  const visibleQuestion = { questionId: 'stage-internal-id', prompt: '放在哪个目录更合适？', options: [{ optionId: 'resume', label: '工程工具', description: '侧重实际使用。' }, { optionId: 'writingPlan', label: '软件架构', description: '侧重设计取舍。' }] };
  assert.ok([visibleQuestion.prompt, ...visibleQuestion.options.flatMap(option => [option.label, option.description])].every(text => maintenanceVisibleCopyIsSafe(text, true)), 'machine option/question IDs are not visible copy');
  assert.equal(maintenanceVisibleCopyIsSafe('继续原清单 7/12', true), false);
  const projector = new PiChatUiProjector(), identity = { piSessionId: 'p31-session', productRunId: 'p31-run', conversationId: 'p31-task', activeLeafId: null };
  let view = projector.createEmpty(identity);
  view = projector.projectRuntimeEvent({ current: view, event: { ...identity, type: 'tool_execution_start', occurredAt: 1, toolCallId: 'p31-tool', toolName: 'knowledge_maintain', args: { stage: 'inspect', offset: 2, expectedTarget: raw } } });
  assert.ok(view.messages.filter(message => message.role === 'tool').every(message => !message.processInput));
  const result = { content: [{ type: 'text' as const, text: raw }], details: { source: 'echoink-knowledge-maintenance', status: 'completed', userReceipt: { version: 1, text: '已写好 7 页，还剩 5 页（共 12 页）' } } };
  const untouched = JSON.stringify(result);
  view.messages.find(message => message.role === 'tool')!.processInput = raw;
  view = projector.projectRuntimeEvent({ current: view, event: { ...identity, type: 'tool_execution_end', occurredAt: 2, toolCallId: 'p31-tool', toolName: 'knowledge_maintain', result, isError: false } });
  const check = (messages: typeof view.messages) => { const tool = messages.find(message => message.role === 'tool')!; assert.equal(tool.text, result.details.userReceipt.text); assert.equal(tool.processInput, undefined); assert.ok([tool.title, tool.text, tool.details, tool.processOutput].filter(Boolean).every(text => maintenanceVisibleCopyIsSafe(text!))); };
  check(view.messages);
  const cold = projector.projectSessionBranch({ ...identity, entries: [{ type: 'message', id: 'tool-call', parentId: null, timestamp: new Date(1).toISOString(), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'p31-tool', name: 'knowledge_maintain', arguments: { stage: 'sections', regionId: raw } }] } }, { type: 'message', id: 'tool-result', parentId: 'tool-call', timestamp: new Date(2).toISOString(), message: { role: 'toolResult', toolCallId: 'p31-tool', toolName: 'knowledge_maintain', content: result.content, details: result.details, isError: false } }] });
  check(cold.messages);
  const thought = 'I will submit decompositions then knowledge.decision candidatePath reverseReason';
  for (const event of [{ ...identity, maintenanceContext: true, type: 'provider_reasoning_start' as const, occurredAt: 3, messageKey: 'thinking', reasoningId: 'provider-thought' }, { ...identity, maintenanceContext: true, type: 'provider_reasoning_delta' as const, occurredAt: 4, messageKey: 'thinking', reasoningId: 'provider-thought', textDelta: thought }, { ...identity, maintenanceContext: true, type: 'provider_reasoning_end' as const, occurredAt: 5, messageKey: 'thinking', reasoningId: 'provider-thought', text: thought, status: 'completed' as const }]) view = projector.projectRuntimeEvent({ current: view, event });
  const thinking = view.messages.flatMap(message => message.assistantTurn?.providerReasoningSegments ?? []);
  assert.ok(thinking.length > 0); assert.ok(thinking.every(segment => segment.text === '正在理解资料并核对已有知识。'));
  const storedThought = { type: 'message' as const, id: 'thought', parentId: null, timestamp: new Date(5).toISOString(), message: { role: 'assistant', content: [{ type: 'thinking', thinking: thought }] } };
  const stopped = { type: 'message' as const, id: 'stopped', parentId: 'thought', timestamp: new Date(6).toISOString(), message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'provider_request_failed', content: [] } };
  const coldThought = projector.projectSessionBranch({ ...identity, entries: [storedThought, stopped], runIdentities: [{ productRunId: identity.productRunId, userEntryId: 'user', assistantEntryId: 'thought', knowledgeWorkflow: 'maintain' }] });
  assert.ok(coldThought.messages.flatMap(message => message.assistantTurn?.providerReasoningSegments ?? []).every(segment => maintenanceVisibleCopyIsSafe(segment.text)));
  assert.ok(coldThought.messages.some(message => message.text.includes('这次生成已停止')));
  assert.ok(!coldThought.messages.some(message => message.text.includes('模型服务请求失败')));
  assert.equal(storedThought.message.content[0].thinking, thought, 'full provider thinking stays untouched in Session');
  view = projector.projectRuntimeEvent({ current: view, event: { ...identity, maintenanceContext: true, type: 'tool_execution_end', occurredAt: 7, toolCallId: 'cli', toolName: 'obsidian_cli', result: { error: raw }, isError: true } });
  const cli = view.messages.find(message => message.title?.startsWith('检查笔记'))!;
  assert.ok(cli); assert.ok(maintenanceVisibleCopyIsSafe(cli.text)); assert.equal(cli.processInput, undefined);
  const summary = { schemaVersion: 1 as const, conversationId: identity.conversationId, piSessionId: identity.piSessionId, productRunId: identity.productRunId, status: 'running' as const, startedAt: 1, updatedAt: 8, activities: [{ id: 'unknown-tool', kind: 'tool' as const, name: 'unregistered_internal_tool', status: 'failed' as const, startedAt: 1, updatedAt: 8 }] };
  view = projector.projectRuntimeEvent({ current: view, event: { ...identity, maintenanceContext: true, type: 'reasoning_summary', occurredAt: 8, summary } });
  const processTitles = buildAgentTurns(view.messages).flatMap(turn => turn.processNodes.map(node => node.title));
  assert.ok(processTitles.includes('这一步没完成'));
  assert.ok(!processTitles.some(title => title.includes('unregistered_internal_tool')));
  assert.equal(summary.activities[0].name, 'unregistered_internal_tool', 'the original registered tool identity stays internal');
  assert.equal(JSON.stringify(result), untouched, 'UI projection must preserve the full model-facing JSON and tool arguments');
}

function assertMaintenanceColdReadPrivacy(): void {
  const entry = (id: string, message: PiSessionMessageView): PiSessionBranchEntryView => ({ type: "message", id, parentId: null, timestamp: new Date(1).toISOString(), message });
  const raw = "sourcePath targetPath nextOffset contentRevision CAS writingPlan";
  const details = { source: "echoink-knowledge", status: "completed", total: 1, returned: 1, references: [{ vaultRelativePath: "wiki/架构决策记录.md", lineStart: 1, lineEnd: 3 }], content: raw };
  const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { sourcePath: "wiki/架构决策记录.md", query: raw } });
  const result = (id: string, name: string) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: JSON.stringify(details) }], details });
  const entries = [
    entry("maintenance-user", { role: "user", content: [{ type: "text", text: "整理已选资料" }] }),
    entry("maintenance-calls", { role: "assistant", content: [call("old-search", "knowledge_search"), call("old-read", "note_read"), call("late-read", "note_read")] }),
    entry("old-search-result", result("old-search", "knowledge_search")),
    entry("old-read-result", result("old-read", "note_read")),
    entry("ordinary-user", { role: "user", content: [{ type: "text", text: "普通后续任务" }] }),
    entry("ordinary-calls", { role: "assistant", content: [call("ordinary-read", "note_read")] }),
    entry("ordinary-result", result("ordinary-read", "note_read")),
    // An old tool result cannot acquire the next user's workflow just because it arrives later.
    entry("late-read-result", result("late-read", "note_read"))
  ];
  const before = JSON.stringify(entries);
  const view = new PiChatUiProjector().projectSessionBranch({ piSessionId: "cold-private-session", activeLeafId: null, productRunId: "ordinary-run", entries,
    runIdentities: [{ productRunId: "old-maintenance-run", userEntryId: "maintenance-user", toolCallIds: [], knowledgeWorkflow: "maintain" }, { productRunId: "ordinary-run", userEntryId: "ordinary-user", toolCallIds: [] }] });
  const tools = view.messages.filter(message => message.role === "tool");
  for (const index of [0, 1, 2]) {
    const message = tools[index];
    assert.equal(message.runId, "old-maintenance-run", "Session assistant calls retain their actual run without persisted tool IDs");
    assert.equal(message.processInput, undefined, "old maintenance tools must hide raw arguments on cold rebuild");
    assert.ok([message.title, message.text, message.details, message.processOutput, ...(message.files ?? []).map(file => file.displayPath)].filter(Boolean).every(text => maintenanceVisibleCopyIsSafe(text!)), "old maintenance search/read results must use safe visible copy");
    assert.equal(message.files?.[0]?.path, "wiki/架构决策记录.md", "real navigation payload is retained");
  }
  const ordinary = tools[3];
  assert.equal(ordinary.runId, "ordinary-run");
  assert.equal(ordinary.processOutput, JSON.stringify(details), "a later ordinary run keeps its existing tool presentation");
  assert.equal(JSON.stringify(entries), before, "cold UI rebuilding never rewrites Session or full model-facing results");
}
