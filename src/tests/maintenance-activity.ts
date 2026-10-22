import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fixture } from "./knowledge-maintain-p2";
import { KnowledgeActivityService } from "../plugin/knowledge-activity-service";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import { MaintenanceActivityController } from "../plugin/maintenance-activity-controller";
import { readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { maintenanceActivityText, maintenanceBatchContext, maintenanceStatusBarText, newMaintenanceProgress, projectMaintenanceActivity, type MaintenanceActivity } from "../knowledge-base/maintenance-activity";
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
    assert.match(maintenanceActivityText(current()), /第2\/3批.*第2\/5步.*拆知识点.*等你确认/u);
    assert.equal(maintenanceStatusBarText(current()), "EchoInk 等你确认");
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
