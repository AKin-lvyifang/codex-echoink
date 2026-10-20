import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createAgentRunFixture } from "./agent-runs";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { ConversationRunService } from "../plugin/conversation-run-service";
import type { QueuedTurnItem } from "../ui/turn-queue";
import type { PiChatSubmitRequest } from "../harness/pi-native/contracts";
import { SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createDurablePiSession, persistPiActiveLeaf } from "../harness/pi-native/pi-session-durability";

export async function runTaskResumeTests(root: string, createHost: (...args: any[]) => any, createStartup: (local: any) => any): Promise<void> {
  (globalThis as any).window = globalThis;
  const fixture = await createAgentRunFixture(path.join(root, "runtime"), (catalog, runtime, settings) => {
    const local = { catalog, productRuns: runtime.productRuns,
      receipts: new FileDomainReceiptStore({ storageRootPath: runtime.productRuns.storageRootPath, vaultId: catalog.vaultId }),
      approvals: new FileApprovalTicketStore({ storageRootPath: runtime.productRuns.storageRootPath, vaultId: catalog.vaultId }) };
    return createHost(local, settings, runtime, path.join(root, "runtime"));
  });
  const f = fixture;
  const plugin = f.plugin as any;
  plugin.app = { vault: { getAbstractFileByPath: () => null }, internalPlugins: { getPluginById: () => null } };
  const consumed: string[] = [];
  const acceptedItems: QueuedTurnItem[] = [];
  let requests = 0;
  let acceptingGate: ReturnType<typeof deferred> | undefined;
  plugin.acceptTestTurn = async (context: any, item: QueuedTurnItem, source: string) => {
    requests++;
    context.queueStartInProgress = true;
    await acceptingGate?.promise;
    if (context.lifecycleSignal?.aborted) return "cancelled";
    const handle = await f.runtime.submit(request(item));
    item.piUserEntryAccepted = true;
    if (source === "queue") f.service.turnQueue.acceptPiUserEntry(item.sessionId, item.id);
    context.running = true;
    context.activeRunId = handle.productRunId;
    context.activeRunSessionId = item.sessionId;
    await plugin.setPiConversationTaskMetadata(item.sessionId, { taskStatus: "running", taskInterruptedAt: undefined, pendingResponse: undefined });
    if (item.clearComposerAfterPiAcceptance) context.clearAcceptedComposerDraft(item);
    acceptedItems.push(item);
    context.onPiRunAccepted(item);
    const result = await handle.result;
    return result.terminalState === "completed" ? "completed" : result.terminalState === "cancelled" ? "cancelled" : "failed";
  };
  f.service.subscribe({ refresh() {}, isTaskVisible: () => false, clearAcceptedDraft: item => consumed.push(item.id) });
  try {
    await readonlyRunStore(root);
    const startup = createStartup({ catalog: { list: async () => [
      { conversationId: "running", status: "active", taskStatus: "running", updatedAt: 100 },
      { conversationId: "waiting", status: "active", taskStatus: "waiting", pendingResponse: { runId: "pending" }, updatedAt: 200 },
      { conversationId: "completed", status: "active", taskStatus: "completed", updatedAt: 300 }
    ] } });
    await startup.ensurePiLocalData();
    assert.deepEqual(startup.patches.map((entry: any) => entry.id), ["running", "waiting"]);
    assert.ok(startup.patches.every((entry: any) => entry.patch.taskStatus === "interrupted" && entry.patch.pendingResponse === undefined));
    assert.equal(requests, 0, "Cold restart only persists interruption and never executes");
    // Build real Pi history, compact it, then interrupt and explicitly resume the same Session.
    const initial = await f.runtime.submit(request(f.item("A", "P4-ORIGINAL-GOAL: keep the task decision")));
    await initial.result;
    const session = f.sessions.get("A");
    await session.compact("Keep P4-ORIGINAL-GOAL and its decision.");
    const sessionId = (await f.catalog.get("A"))!.piSessionId;
    const originalFile = (await f.catalog.get("A"))!.sessionFile!;
    const originalText = await readFile(originalFile, "utf8");
    assert.match(originalText, /"type":"compaction"/);
    await plugin.setPiConversationTaskMetadata("A", { taskStatus: "interrupted", taskInterruptedAt: 1234, taskStage: "核对结果" });
    const beforeReadRuns = await f.productRuns.listReadOnly("A");
    const interruption = await plugin.readTaskInterruption("A");
    assert.equal(interruption.reason, "process_unknown");
    assert.equal(interruption.stage, "核对结果");
    assert.equal(requests, 0, "Opening interruption information cannot invoke a run");
    assert.equal((await f.productRuns.listReadOnly("A")).length, beforeReadRuns.length);

    acceptingGate = deferred();
    const resume1 = plugin.resumeTask("A");
    const unrelated = f.item("A", "UNRELATED-UNSENT-DRAFT");
    unrelated.clearComposerAfterPiAcceptance = true;
    const resume2 = plugin.resumeTask("A", unrelated.text, unrelated);
    assert.strictEqual(resume1, resume2, "Concurrent entry points must share one acceptance flight before awaits");
    assert.equal(plugin.isTaskResuming("A"), true);
    await assert.rejects(f.service.run(f.item("A", "RACING-ORDINARY-TURN")), /正在核对恢复信息/);
    await until(() => requests === 1);
    assert.equal(f.service.runs.get("A")?.running, false, "Preflight and submission do not fake running");
    assert.equal((await f.catalog.get("A"))!.taskStatus, "interrupted");
    acceptingGate.resolve();
    assert.equal(await resume1, "running");
    await settle(f.service, "A");
    assert.equal(consumed.length, 0, "The button must preserve unrelated draft text and attachments");
    assert.equal((await f.catalog.get("A"))!.piSessionId, sessionId);
    assert.equal(f.sessions.get("A"), session, "Resume must reuse the original activated Session");
    assert.equal((await f.productRuns.listReadOnly("A")).length, beforeReadRuns.length + 1);
    assert.equal(f.service.activeResumeContexts.size, 0, "Recovery guard ends with its accepted resumed run");
    assert.ok(acceptedItems[0].resumeContext?.safety.recoveryInstructions);
    assert.doesNotMatch(acceptedItems[0].text, /P4-ORIGINAL-GOAL|UNRELATED-UNSENT-DRAFT/, "Resume does not inject the previous user message or a different draft");
    assert.match(f.requests.get("A")!.at(-1)!, /summary/i, "The next real Pi request uses native compaction");
    assert.match(await readFile(originalFile, "utf8"), /P4-ORIGINAL-GOAL/, "Full history remains on disk");

    await plugin.setPiConversationTaskMetadata("A", { taskStatus: "interrupted", taskInterruptedAt: 2000 });
    const attachment = { type: "file" as const, name: "kept.txt", path: path.join(root, "kept.txt") };
    const submitted = f.item("A", "P4-NEW-FOLLOWUP");
    submitted.attachments = [attachment]; submitted.clearComposerAfterPiAcceptance = true;
    const model = plugin.settings.apiProviders[0].models[0];
    const credential = plugin.settings.apiProviders[0].apiKey;
    plugin.settings.apiProviders[0].apiKey = "";
    const beforeFailureRequests = requests;
    await assert.rejects(plugin.resumeTask("A", submitted.text, submitted), /API Key|登录/);
    assert.equal(requests, beforeFailureRequests);
    assert.equal((await f.catalog.get("A"))!.taskStatus, "interrupted");
    assert.equal(submitted.attachments[0], attachment); assert.equal(submitted.text, "P4-NEW-FOLLOWUP");
    assert.equal(consumed.length, 0);
    assert.match(plugin.getTaskResumeError("A"), /API Key|登录/);
    plugin.settings.apiProviders[0].apiKey = credential;
    // Validate the exact frozen follow-up snapshot and keep it insulated from later edits.
    acceptingGate = deferred();
    const sending = plugin.resumeTask("A", submitted.text, submitted);
    submitted.text = "NEW-UNSENT-DRAFT"; submitted.attachments[0].name = "later-name.txt";
    await until(() => requests === beforeFailureRequests + 1);
    assert.equal(plugin.getTaskResumeError("A"), undefined);
    acceptingGate.resolve();
    await sending; await settle(f.service, "A");
    assert.equal(consumed.at(-1), submitted.id);
    assert.equal(acceptedItems.at(-1)!.text, "P4-NEW-FOLLOWUP");
    assert.equal(acceptedItems.at(-1)!.attachments[0].name, "kept.txt");
    assert.equal(model.id, acceptedItems.at(-1)!.turnOptions.model);
    await plugin.setPiConversationTaskMetadata("A", { taskStatus: "interrupted", taskInterruptedAt: 3000 });
    const general = plugin.settings.agentRegistry.agents.find((agent: any) => agent.id === "sol");
    general.disabledCapabilityIds = ["knowledge"];
    const beforeCapabilityFailure = requests;
    await assert.rejects(plugin.resumeTask("A"), /能力已被关闭/);
    assert.equal(requests, beforeCapabilityFailure);
    assert.equal((await f.catalog.get("A"))!.taskStatus, "interrupted");
    general.disabledCapabilityIds = [];

    // A button uses this task's selected model/access while preserving its unsent content.
    const alternate = structuredClone(plugin.settings.apiProviders[0]);
    alternate.id = "p4-alternate-provider";
    alternate.models[0].id = "p4-alternate-model";
    alternate.defaultModelId = alternate.models[0].id;
    plugin.settings.apiProviders.push(alternate);
    plugin.settings.taskWorkspace.replyDrafts.A = { text: "UNSENT-BUTTON-DRAFT", attachments: [attachment],
      selectedProviderSettingsId: alternate.id, selectedModel: alternate.models[0].id, selectedPermission: "read-only", selectedMode: "plan" };
    const buttonPrepared = await plugin.prepareTaskResume("A");
    assert.equal(buttonPrepared.turnOptions.providerSettingsId, alternate.id);
    assert.equal(buttonPrepared.turnOptions.model, alternate.models[0].id);
    assert.equal(buttonPrepared.turnOptions.permission, "read-only");
    assert.equal(buttonPrepared.turnOptions.mode, "plan");
    assert.equal(plugin.settings.taskWorkspace.replyDrafts.A.text, "UNSENT-BUTTON-DRAFT");
    assert.equal(buttonPrepared.attachments.length, 0);
    delete plugin.settings.taskWorkspace.replyDrafts.A;
    plugin.settings.apiProviders.pop();

    const queueItem = f.item("A", "P4-SAFE-QUEUE-HEAD");
    f.service.turnQueue.enqueue(queueItem);
    f.service.turnQueue.pauseSessionQueue("A");
    await assert.rejects(f.service.run(queueItem, "queue"), /请先核对恢复信息/);
    plugin.settings.apiProviders[0].apiKey = "";
    const beforeQueueFailure = requests;
    await assert.rejects(f.service.resumeQueuedTurns("A"), /API Key|登录/);
    assert.equal(requests, beforeQueueFailure);
    assert.equal(f.service.turnQueue.itemsForSession("A")[0].id, queueItem.id);
    assert.equal(f.service.turnQueue.isSessionQueuePaused("A"), true);
    plugin.settings.apiProviders[0].apiKey = credential;
    await f.service.resumeQueuedTurns("A"); await settle(f.service, "A");
    assert.equal(acceptedItems.at(-1)!.id, queueItem.id);
    assert.ok(acceptedItems.at(-1)!.resumeContext, "The queue's continue button uses the same recovery guard");
    assert.equal(f.service.turnQueue.itemsForSession("A").length, 0);

    // Stop/delete drains a preflight lease before handing the task to another Agent.
    const deletingAgent = "p4-deleting-agent", deletingTask = "p4-deleting-task";
    plugin.settings.agentRegistry.agents.push({ id: deletingAgent, name: "临时同事", position: "检查恢复", styleId: "analysis", avatar: { kind: "preset", presetId: "nova" }, capabilityIds: [] });
    const deletingEntry = await f.runtime.createConversation({ conversationId: deletingTask, title: deletingTask, cwd: f.root, agentId: deletingAgent });
    plugin.settings.sessions.push({ id: deletingTask, title: deletingTask, cwd: f.root, messages: [], agentId: deletingAgent, piSessionId: deletingEntry.piSessionId, createdAt: deletingEntry.createdAt, updatedAt: deletingEntry.updatedAt });
    await (await f.runtime.submit(request(f.item(deletingTask, "P4-DELETION-ORIGINAL")))).result;
    await plugin.setPiConversationTaskMetadata(deletingTask, { taskStatus: "interrupted" });
    const beforeDeletionRequests = f.requests.get(deletingTask)!.length;
    const projectionReader = plugin.readPiConversationProjection.bind(plugin);
    const entered = deferred(), release = deferred();
    plugin.readPiConversationProjection = async (id: string) => { if (id === deletingTask) { entered.resolve(); await release.promise; } return await projectionReader(id); };
    const resumingDeletedTask = plugin.resumeTask(deletingTask);
    await entered.promise;
    let deletionFinished = false;
    const deleting = plugin.deleteAgent(deletingAgent).then(() => { deletionFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(deletionFinished, false, "Ownership cannot change while cancelled preflight is still draining");
    release.resolve();
    assert.equal(await resumingDeletedTask, "cancelled");
    await deleting;
    assert.equal((await f.catalog.get(deletingTask))!.agentId, "sol");
    assert.equal(f.requests.get(deletingTask)!.length, beforeDeletionRequests, "A cancelled preflight cannot start under the new owner");
    plugin.readPiConversationProjection = projectionReader;

    const openGate = deferred(); const actualOpen = plugin.openTaskDetail.bind(plugin);
    plugin.openTaskDetail = async (id: string) => { await openGate.promise; await actualOpen(id); };
    let unhandled = false, detailResultSettled = false;
    const rejectionListener = () => { unhandled = true; };
    process.on("unhandledRejection", rejectionListener);
    const openingFailure = plugin.resumeTaskAndOpenDetail("missing-task");
    const observedOpeningFailure = openingFailure.then(() => { detailResultSettled = true; }, () => { detailResultSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(unhandled, false);
    assert.equal(detailResultSettled, false, "P5 reports preflight failure after opening the detail");
    openGate.resolve();
    await assert.rejects(openingFailure, /任务已不存在/); await observedOpeningFailure;
    assert.equal(plugin.opened, "missing-task");
    process.off("unhandledRejection", rejectionListener); plugin.openTaskDetail = actualOpen;

    // Real cancellation persists an evidenced cause. Unspecified aborts remain unknown.
    for (const reason of ["user_stopped", "app_closed", "plugin_disabled"] as const) {
      const id = reason === "user_stopped" ? "B" : reason === "app_closed" ? "C" : "unload-task";
      const started = deferred(); f.started.set(id, started); f.gates.set(id, deferred());
      const handle = await f.runtime.submit(request(f.item(id, `P4-STOP:${reason}`)));
      await started.promise;
      await f.runtime.recordTaskInterruption(id, reason);
      await f.runtime.abort(id); await handle.result;
      const last = (await f.productRuns.listReadOnly(id)).at(-1)!;
      assert.equal(last.interruption!.reason, reason);
      await plugin.setPiConversationTaskMetadata(id, { taskStatus: "interrupted", taskInterruptedAt: last.updatedAt });
      assert.equal((await plugin.readTaskInterruption(id)).reason, reason);
    }
    const id = "delete-task";
    const started = deferred(); f.started.set(id, started); f.gates.set(id, deferred());
    const unknown = await f.runtime.submit(request(f.item(id, "P4-UNKNOWN")));
    await started.promise; await f.runtime.abort(id); await unknown.result;
    assert.equal((await f.productRuns.listReadOnly(id)).at(-1)!.interruption!.reason, "process_unknown");
    // A legacy interrupted catalog without a run is still readable; continuing gives an actionable error.
    await plugin.setPiConversationTaskMetadata("delete-task", { taskStatus: "interrupted" });
    const local = plugin.piLocalData;
    const actualList = local.productRuns.listReadOnly.bind(local.productRuns);
    local.productRuns.listReadOnly = async () => [];
    assert.equal((await plugin.readTaskInterruption("delete-task")).reason, "process_unknown");
    await assert.rejects(plugin.resumeTask("delete-task"), /没有可核对的运行记录/);
    local.productRuns.listReadOnly = actualList;
    const shutdownRun = f.service.run(f.item("B", "P4-SHARED-SHUTDOWN"));
    await until(() => Boolean(f.service.runs.get("B")?.running));
    const firstShutdown = f.service.dispose("plugin_disabled");
    const secondShutdown = f.service.dispose("app_closed");
    assert.strictEqual(firstShutdown, secondShutdown, "Quit Tasks and plugin unload must await the same durable shutdown");
    await Promise.all([firstShutdown, secondShutdown, shutdownRun]);
    assert.equal(f.service.runs.size, 0);
    console.log("P4 runtime: singleflight/draft/preflight/same Session+compaction/readonly/stop reasons PASS (offline Pi)");
  } finally {
    await f.service.dispose(); await f.runtime.shutdown(); f.approvalBroker.dispose();
  }
}
function request(item: QueuedTurnItem): PiChatSubmitRequest {
  const o = item.turnOptions;
  return { conversationId: item.sessionId, text: item.text, submittedAt: Date.now(), runtimeProviderId: o.runtimeProviderId, providerSettingsId: o.providerSettingsId,
    modelId: o.model, reasoning: o.reasoning, mode: "agent", permission: o.permission, ...(item.resumeContext ? { resumeContext: item.resumeContext } : {}) };
}
async function readonlyRunStore(root: string): Promise<void> {
  const emptyRoot = path.join(root, "read-only-never-created");
  const store = new FileProductRunStore({ storageRootPath: emptyRoot, vaultId: "readonly", catalog: { get: async () => null } });
  assert.deepEqual(await store.listReadOnly(), []);
  await assert.rejects(access(emptyRoot), { code: "ENOENT" });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("Timed out awaiting the production runtime");
}
async function settle(service: ConversationRunService, id: string): Promise<void> {
  await service.runs.get(id)?.flight;
  assert.equal(service.runs.get(id)?.running ?? false, false);
}

export async function runTaskResumeStageTests(record: (active: any) => Promise<{ stage: string }>): Promise<void> {
  const active: any = {
    catalog: {}, currentRun: { productRunId: "current", toolCallIds: new Set() }, sessionManager: { getBranch: () => [], getLeafId: () => "leaf" },
    projection: { messages: [
      { role: "tool", runId: "current", title: "调用等待工具", status: "running", createdAt: 10, text: "PRIVATE TOOL ARGUMENTS", processInput: "PRIVATE TOOL ARGUMENTS" },
      { role: "tool", runId: "previous", title: "别的运行", status: "running", createdAt: 30 },
      { role: "tool", runId: "current", title: "已完成工具", status: "completed", createdAt: 40 }
    ] }
  };
  assert.equal((await record(active)).stage, "调用等待工具", "Persist the current live Tool title, not args or a previous run");
  active.projection.messages.push({ role: "system", assistantTurn: { turnId: "current", processNodes: [
    { kind: "tool", status: "waiting", title: "等待确认写入", updatedAt: 20 },
    { kind: "tool", status: "completed", title: "已结束节点", updatedAt: 50 }
  ] } });
  assert.equal((await record(active)).stage, "等待确认写入", "A pending Tool node is a recorded interruption step");
  active.projection.messages.at(-1).assistantTurn.turnId = "previous";
  active.projection.messages[0].status = "pending";
  assert.equal((await record(active)).stage, "调用等待工具", "Pending raw Tool messages are also supported");
  active.sessionManager.getBranch = () => [{ type: "custom", customType: "echoink.task-plan.v1", data: {
    schemaVersion: 1, conversationId: "task", piSessionId: "session", plan: { schemaVersion: 1, planId: "plan", title: "记录计划", status: "in_progress", version: 1,
      currentStepId: "step", steps: [{ stepId: "step", text: "计划中的当前步骤", status: "in_progress" }], source: "agent", createdAt: 1, updatedAt: 2 }
  } }];
  assert.equal((await record(active)).stage, "计划中的当前步骤", "Structured plan steps retain precedence");
  active.catalog.taskStage = "明确保存的步骤";
  assert.equal((await record(active)).stage, "明确保存的步骤");
  active.catalog.taskStage = ""; active.sessionManager.getBranch = () => []; active.currentRun = null;
  assert.equal(await record(active), null, "Do not record an interruption without an active run");
  console.log("P4 interruption stage: live/pending Tool title, current-run isolation, plan precedence PASS");
}

export async function runTaskResumeDurableStageTests(root: string, readInfo: (local: any, root: string) => Promise<any>): Promise<void> {
  const sessionRoot = path.join(root, "unstamped-stage-sessions");
  const opened = createDurablePiSession({ sessionRoot, cwd: root, api: {
    codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
    open: (file, dir, cwd) => SessionManager.open(file, dir, cwd)
  } });
  const manager = opened.sessionManager;
  const userEntryId = manager.appendMessage({ role: "user", content: "PRIVATE original task", timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("p4_finished_write", {}, { id: "finished" }), { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: "finished", toolName: "p4_finished_write", isError: false, content: [{ type: "text", text: "done" }], timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage(fauxToolCall("p4_wait", { privateArgument: "PRIVATE" }, { id: "pending" }), { stopReason: "toolUse" }));
  persistPiActiveLeaf({ sessionRoot, sessionManager: manager });
  const catalog = { conversationId: "task", piSessionId: opened.piSessionId, vaultId: "stage", title: "task", status: "active", defaultMemoryMode: "normal",
    taskStatus: "interrupted", createdAt: 1, updatedAt: 2, sessionFile: opened.sessionFile };
  const run = { productRunId: "current", conversationId: "task", piSessionId: opened.piSessionId, userEntryId, toolCallIds: [], memoryMode: "normal", state: "running", activeLeafId: manager.getLeafId(), createdAt: 3, updatedAt: 4 };
  const storeRoot = path.join(root, "unstamped-stage-store");
  const local = { catalog: { sessionRootPath: sessionRoot, get: async () => catalog }, productRuns: { listReadOnly: async () => [run] },
    receipts: new FileDomainReceiptStore({ storageRootPath: storeRoot, vaultId: "stage" }), approvals: new FileApprovalTicketStore({ storageRootPath: storeRoot, vaultId: "stage" }) };
  const before = await readFile(opened.sessionFile, "utf8");
  const info = await readInfo(local, root);
  assert.equal(info.reason, "process_unknown", "A missing quit stamp never becomes app_closed");
  assert.match(info.stage, /p4_wait/, "The durable pending Tool supplies the missing current-run step");
  assert.doesNotMatch(info.stage, /PRIVATE|finished/);
  assert.equal(await readFile(opened.sessionFile, "utf8"), before, "Reading interruption details cannot write the Session");
  await assert.rejects(access(storeRoot), { code: "ENOENT" });
  console.log("P4 unstamped interruption: readonly durable current-Tool stage + process_unknown reason PASS");
}
