import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { paidTestAccess } from "./membership-access";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { createPiMcpToolSecurity } from "../harness/pi-native/pi-mcp-tool-security";
import { PiPdfReadingSecurity } from "../harness/pi-native/pi-pdf-reading-tools";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions } from "../harness/pi-native/pi-obsidian-tools";
import { createObsidianNativePort } from "../plugin/obsidian-native-tools";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { financeOperationsFixture } from "./finance-operations";
import { financeBudgetSnapshot } from "../lifestyle/finance-operation-types";
import type { PdfJob } from "../pdf-reading/types";
import { FileApprovalTicketStore, createMcpApprovalToolId, type ApprovalOperationContract, type JsonValue } from "../harness/pi-native/tool-authorization";
import { createPiVaultProductionWriteExecutionPort } from "../plugin/pi-vault-tool-production";
import { assertTaskResumeToolAllowed, prepareTaskResumeSafety, readTaskResumeSafety, type TaskResumeSafetySnapshot } from "../plugin/task-resume-safety";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export async function runTaskResumeSafetyTests(testRoot: string): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(path.join(testRoot, "p4-resume-safety-"));
  try {
    await fileVersionsAndFinalEffectGate(path.join(root, "files"));
    await todoReceiptsShareTheFileGuard(path.join(root, "todos"));
    await cliReceiptsShareTheFileGuard(path.join(root, "cli"));
    await financeRealPipelineSurvivesChangedRunAndVersion(path.join(root, "finance"));
    await uncertainMcpIsNeverDispatchedAgain(path.join(root, "mcp"));
    await localReadbackAndReadonlyInspection(path.join(root, "readonly"));
    await pdfSessionEvidenceIsReadonly(path.join(root, "pdf-evidence"));
    await pdfResumeReusesOriginalJob(path.join(root, "pdf-tool"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture(root: string) {
  await mkdir(root, { recursive: true });
  const vaultRootPath = path.join(root, "vault");
  await mkdir(vaultRootPath);
  const storageRootPath = path.join(root, "store");
  let clock = 1_800_000_000_000;
  const now = () => ++clock;
  const vaultId = "resume-test-vault";
  const catalog = new FileConversationCatalog({ storageRootPath, vaultId, now });
  const productRuns = new FileProductRunStore({ storageRootPath, vaultId, catalog, now });
  const receipts = new FileDomainReceiptStore({ storageRootPath, vaultId, now });
  const approvals = new FileApprovalTicketStore({ storageRootPath, vaultId, now });
  await catalog.initialize();
  await receipts.initialize();
  await approvals.initialize();
  await catalog.upsert({ conversationId: "task", piSessionId: "same-session", vaultId, title: "Task", status: "active", defaultMemoryMode: "normal", createdAt: now(), updatedAt: now() });
  const createRun = async (productRunId: string, completed = false) => { const timestamp = now(); return await productRuns.create({
    productRunId, conversationId: "task", piSessionId: "same-session", userEntryId: `user-${productRunId}`, toolCallIds: [], memoryMode: "normal",
    state: "product_run_settled", terminalState: completed ? "completed" : "cancelled", activeLeafId: null,
    createdAt: timestamp, updatedAt: timestamp, agentSettledAt: timestamp, settledAt: timestamp
  }); };
  await createRun("old-run");
  return { root, vaultRootPath, storageRootPath, catalog, productRuns, receipts, approvals, now, vaultId, createRun, conversationId: "task", interruptedRunId: "old-run" };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function authorized(f: Fixture, toolId: ApprovalOperationContract["toolId"], toolCallId: string, args: JsonValue, target: JsonValue, version: JsonValue, productRunId = "old-run") {
  const contract: ApprovalOperationContract = {
    productRunId, toolCallId, conversationId: "task", piSessionId: "same-session", userId: "user", vaultId: f.vaultId, deviceId: "device",
    toolId, toolVersion: "v1", policyVersion: "v1", normalizedArguments: args, resolvedTarget: target, targetVersion: version, preview: { operation: toolId }
  };
  const ticket = await f.approvals.issue({ ...contract, issuedAt: f.now(), expiresAt: f.now() + 60_000 });
  return await f.approvals.consume({ ticketId: ticket.ticketId, operationIdentity: ticket.operationIdentity, contract });
}

async function completedWrite(f: Fixture, content: string, before: string | null, call: string, productRunId = "old-run") {
  const authorization = await authorized(f, before === null ? "note_create" : "note_update", call,
    { relativePath: "task.md", content, ...(before === null ? {} : { expectedVersion: sha(before) }) },
    { relativePath: "task.md" }, { beforeVersion: before === null ? null : sha(before), expectedAfterSha256: sha(content) }, productRunId);
  await f.receipts.beginAuthorizedOperation(authorization);
  await f.receipts.markEffectStarted(authorization.operationIdentity);
  await writeFile(path.join(f.vaultRootPath, "task.md"), content);
  await f.receipts.markEffectCompleted(authorization.operationIdentity);
  await f.receipts.persistReceipt({ operationIdentity: authorization.operationIdentity, status: "completed", safeSummary: { operation: authorization.toolId },
    readback: { checkedAt: f.now(), readbackVerified: true, observedTargetVersion: { source: sha(content) }, safeSummary: { source: { contentSha256: sha(content) } } } });
}
function guard(f: Fixture, snapshot: TaskResumeSafetySnapshot | undefined, toolName: string, args: Readonly<Record<string, unknown>>, resolvedTarget?: unknown,
  currentOperation?: Readonly<{ productRunId: string; toolCallId: string }>) {
  return assertTaskResumeToolAllowed({ ...f, snapshot, toolName, arguments: args, resolvedTarget, currentOperation });
}

async function fileVersionsAndFinalEffectGate(root: string): Promise<void> {
  const f = await fixture(root);
  await completedWrite(f, "first", null, "a");
  await completedWrite(f, "second", "first", "b");
  const snapshot = await prepareTaskResumeSafety(f);
  assert.deepEqual(snapshot.fileConflicts, [], "latest task write, not first write, is the expected version");
  await assert.rejects(guard(f, snapshot, "note_update", { relativePath: "task.md", content: "first", expectedVersion: "fresh-version" }), /already_completed/u);
  await assert.rejects(guard(f, snapshot, "note_update", { relativePath: "task.md", content: "second", expectedVersion: "fresh-version" }), /already_completed/u);
  await guard(f, snapshot, "note_update", { relativePath: "task.md", content: "third", expectedVersion: sha("second") });
  await f.createRun("new-run", true);
  await completedWrite(f, "third", "second", "new-a", "new-run");
  await guard(f, snapshot, "note_update", { relativePath: "task.md", content: "fourth", expectedVersion: sha("third") });
  await writeFile(path.join(f.vaultRootPath, "task.md"), "outside edit");
  const externalSnapshot = await readTaskResumeSafety({ ...f, interruptedRunId: "new-run" });
  assert.equal(externalSnapshot.fileConflicts.length, 1, "preflight surfaces outside changes");
  await assert.rejects(guard(f, snapshot, "note_update", { relativePath: "task.md", content: "fourth", expectedVersion: sha("outside edit") }), /version_conflict/u);
  // The production write seam must check again after admission and before effect.
  const authorization = await authorized(f, "note_update", "new-b", { relativePath: "task.md", content: "fourth", expectedVersion: sha("outside edit") },
    { relativePath: "task.md" }, { beforeVersion: sha("outside edit"), expectedAfterSha256: sha("fourth") }, "new-run");
  let writes = 0;
  const port = createPiVaultProductionWriteExecutionPort({ receipts: f.receipts, domainService: { readback: async () => ({ status: "present", snapshot: {
    relativePath: "task.md", content: "outside edit", version: sha("outside edit"), contentSha256: sha("outside edit"), byteLength: 12, truncated: false
  } }) } as never,
    assertToolAllowed: async (name, args, target) => await guard(f, snapshot, name, args, target) });
  const blocked = await port.execute({ authorization, toolId: "note_update", arguments: authorization.normalizedArguments, onVerifying() {} } as never,
    async before => { await before(); writes++; throw new Error("must never execute"); });
  assert.equal(blocked.status, "failed"); assert.match(blocked.error!.message, /task_resume_file_version_conflict/u);
  assert.equal(writes, 0);
  assert.equal(await readFile(path.join(f.vaultRootPath, "task.md"), "utf8"), "outside edit");
  const afterRejectedApproval = await readTaskResumeSafety({ ...f, interruptedRunId: "new-run" });
  assert.equal(afterRejectedApproval.fileConflicts.length, 1, "a later rejected authorization must not bless the outside version on the next resume");
  await writeFile(path.join(f.vaultRootPath, "task.md"), "third");
  const gapAuthorization = await authorized(f, "note_update", "new-c", { relativePath: "task.md", content: "fourth", expectedVersion: sha("third") },
    { relativePath: "task.md" }, { beforeVersion: sha("third"), expectedAfterSha256: sha("fourth") }, "new-run");
  const changedAfterAdmission = await port.execute({ authorization: gapAuthorization, toolId: "note_update", arguments: gapAuthorization.normalizedArguments, onVerifying() {} } as never,
    async before => { await writeFile(path.join(f.vaultRootPath, "task.md"), "outside edit"); await before(); writes++; throw new Error("must never execute"); });
  assert.equal(changedAfterAdmission.status, "failed"); assert.equal(writes, 0, "the final gate catches edits made after the first admission check");
  await guard(f, undefined, "note_update", { relativePath: "task.md", content: "second" });
  await f.createRun("later-interrupted-run");
  const later = await readTaskResumeSafety({ ...f, interruptedRunId: "later-interrupted-run" });
  assert.deepEqual(later.taskRunIds, ["later-interrupted-run"], "completed earlier tasks cannot impose later replay bans");
  console.log("PASS task resume file versions, latest own writes, final effect gate, ordinary turn scope");
}

async function uncertainMcpIsNeverDispatchedAgain(root: string): Promise<void> {
  const f = await fixture(root);
  const descriptor = { name: "echoink_mcp_public_write", resourceId: "server", resourceName: "Server", toolName: "send", readOnly: false, destructive: false,
    approvalToolId: createMcpApprovalToolId({ resourceId: "server", toolName: "send" }), contractFingerprint: `sha256:${sha("contract")}` };
  const args = { destination: "draft", text: "one external effect" };
  const context = { vaultId: f.vaultId, conversationId: "task", piSessionId: "same-session", productRunId: "old-run" };
  const old = createPiMcpToolSecurity({ tools: [descriptor], currentExecutionContext: () => context, isToolAllowed: async () => true,
    approvals: f.approvals, receipts: f.receipts, confirmation: { confirm: async () => true }, userId: "user", deviceId: "device", now: f.now });
  const oldCall = { type: "tool_call", toolCallId: "external-old", toolName: descriptor.name, input: args };
  assert.equal(await old.handleToolCall(oldCall as never, undefined), undefined);
  let externalEffects = 0;
  const dispatch = async (security: ReturnType<typeof createPiMcpToolSecurity>, callId: string, executionContext: typeof context) => {
    await security.beginExecution({ toolCallId: callId, toolName: descriptor.name, arguments: args, executionContext });
    externalEffects++; // The server accepts the effect, then its result is lost.
  };
  await dispatch(old, oldCall.toolCallId, context);
  const snapshot = await prepareTaskResumeSafety(f);
  assert.equal(snapshot.operations[0]?.status, "uncertain");
  assert.equal(snapshot.pendingActions[0]?.resourceId, "server");
  assert.equal(snapshot.pendingActions[0]?.externalToolName, "send");
  assert.match(snapshot.recoveryInstructions, /Unknown effects/u);
  const newContext = { ...context, productRunId: "new-run" };
  const resumed = createPiMcpToolSecurity({ tools: [descriptor], currentExecutionContext: () => newContext,
    isToolAllowed: async (tool, value) => { await guard(f, snapshot, tool.approvalToolId, value); return true; },
    approvals: f.approvals, receipts: f.receipts, confirmation: { confirm: async () => true }, userId: "user", deviceId: "device", now: f.now });
  const repeated = { ...oldCall, toolCallId: "external-new" };
  assert.equal((await resumed.handleToolCall(repeated as never, undefined))?.block, true);
  await assert.rejects(dispatch(resumed, repeated.toolCallId, newContext));
  await guard(f, snapshot, descriptor.approvalToolId, { destination: "different", text: "unrelated continuation" });
  assert.equal(externalEffects, 1);
  // Production calls the broker guard AFTER beginExecution marks this new
  // operation started. It must exempt only this exact dispatch from replay.
  const freshArgs = { destination: "different", text: "unrelated continuation" };
  const freshCall = { ...oldCall, toolCallId: "external-fresh", input: freshArgs };
  assert.equal(await resumed.handleToolCall(freshCall as never, undefined), undefined);
  await resumed.beginExecution({ toolCallId: freshCall.toolCallId, toolName: descriptor.name, arguments: freshArgs, executionContext: newContext });
  await assert.rejects(guard(f, snapshot, descriptor.approvalToolId, freshArgs), /uncertain_no_replay/u, "reproduces the production broker self-block without its dispatch identity");
  const currentOperation = { productRunId: newContext.productRunId, toolCallId: freshCall.toolCallId };
  await guard(f, snapshot, descriptor.approvalToolId, freshArgs, undefined, currentOperation);
  externalEffects++;
  assert.equal(externalEffects, 2, "one old uncertain effect and exactly one newly permitted broker dispatch");
  await assert.rejects(guard(f, snapshot, descriptor.approvalToolId, freshArgs, undefined, { ...currentOperation, toolCallId: "other-call" }), /uncertain_no_replay/u);
  await assert.rejects(guard(f, snapshot, descriptor.approvalToolId, freshArgs, undefined, { ...currentOperation, productRunId: "other-run" }), /uncertain_no_replay/u);
  await assert.rejects(guard(f, snapshot, descriptor.approvalToolId, args, undefined, currentOperation), /uncertain_no_replay/u, "excluding the new dispatch must not permit replay of the old uncertain effect");
  const duplicateFresh = { ...freshCall, toolCallId: "external-fresh-duplicate" };
  assert.equal((await resumed.handleToolCall(duplicateFresh as never, undefined))?.block, true, "another current-run call still sees the first in-flight effect");
  await resumed.handleToolResult({ toolCallId: freshCall.toolCallId, toolName: descriptor.name, content: [{ type: "text", text: "accepted" }], isError: false,
    details: { source: "echoink-mcp", resourceId: descriptor.resourceId, resourceName: descriptor.resourceName, toolName: descriptor.toolName,
      status: "completed", effectType: "user_write", readbackRequired: false, protocolCompleted: true } } as never);
  await assert.rejects(guard(f, snapshot, descriptor.approvalToolId, freshArgs, undefined, currentOperation), /already_completed/u, "even the exact identity has no exemption after receipt finalization");
  console.log("PASS real MCP security/store uncertain replay blocking and exact broker dispatch identity after beginExecution");
}

async function cliReceiptsShareTheFileGuard(root: string): Promise<void> {
  const f = await fixture(root);
  await completedWrite(f, "first", null, "note-before-cli");
  const args = { command: "daily:append", content: "second", open: false };
  const target = { command: "daily:append", dailyPath: "task.md" };
  const authorization = await authorized(f, "obsidian_cli", "cli-write", args, target,
    { beforeVersion: sha("first"), effectArgumentsSha256: sha("daily-append-second") });
  await f.receipts.beginAuthorizedOperation(authorization);
  await f.receipts.markEffectStarted(authorization.operationIdentity);
  await writeFile(path.join(f.vaultRootPath, "task.md"), "first\nsecond");
  await f.receipts.markEffectCompleted(authorization.operationIdentity);
  await f.receipts.persistReceipt({ operationIdentity: authorization.operationIdentity, status: "completed", safeSummary: { command: args.command },
    readback: { checkedAt: f.now(), readbackVerified: true, observedTargetVersion: sha("first\nsecond"), safeSummary: { readbackVerified: true } } });
  const snapshot = await prepareTaskResumeSafety(f);
  assert.deepEqual(snapshot.fileConflicts, []);
  assert.equal(snapshot.fileVersions[0]?.expectedVersion, sha("first\nsecond"), "serialized CLI readback replaces earlier note tool version");
  await assert.rejects(guard(f, snapshot, "obsidian_cli", { ...args, open: true, inline: false }, target), /already_completed/u);
  await guard(f, snapshot, "obsidian_cli", { command: "daily:append", content: "third" }, target);
  await writeFile(path.join(f.vaultRootPath, "task.md"), "outside edit");
  assert.equal((await readTaskResumeSafety(f)).fileConflicts.length, 1);
  await assert.rejects(guard(f, snapshot, "obsidian_cli", { command: "daily:append", content: "third" }, target), /version_conflict/u);
  await assert.rejects(guard(f, snapshot, "obsidian_cli", { command: "history:restore", path: "task.md", version: "fresh-version" }, { command: "history:restore", path: "task.md" }), /version_conflict/u);
  await assert.rejects(guard(f, snapshot, "note_update", { relativePath: "task.md", content: "fourth", expectedVersion: sha("outside edit") }), /version_conflict/u);
  console.log("PASS serialized CLI receipt versions, UI-flag replay suppression, daily/history final targets and cross-tool writes");
}

async function financeRealPipelineSurvivesChangedRunAndVersion(root: string): Promise<void> {
  const base = await fixture(root);
  const f = { ...base,
    approvals: new FileApprovalTicketStore({ storageRootPath: base.storageRootPath, vaultId: base.vaultId }),
    receipts: new FileDomainReceiptStore({ storageRootPath: base.storageRootPath, vaultId: base.vaultId }) };
  const finance = await financeOperationsFixture(f.vaultRootPath);
  const adapter = new ObsidianVaultDomainAdapter(finance.app, f.vaultId, f.vaultRootPath);
  let identity = { vaultId: f.vaultId, conversationId: "task", piSessionId: "same-session", productRunId: "old-run" };
  let entry = { entryId: "user-old-run", text: "执行已确认的财务计划" };
  let snapshot: TaskResumeSafetySnapshot | undefined;
  const security = new PiObsidianToolSecurity({ currentAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }),
    currentRunIdentity: () => identity, currentUserEntry: () => entry, approvals: f.approvals, receipts: f.receipts,
    userId: "fixture", deviceId: "fixture", confirmation: { confirm: async () => true },
    assertToolAllowed: async (name, args, target) => await guard(f, snapshot, name, args, target) });
  const port = createObsidianNativePort(finance.app, adapter, () => "", { finance: finance.service });
  const tools = createPiObsidianToolDefinitions(port, security);
  const call = async (toolName: string, args: Record<string, unknown>, toolCallId: string) => {
    const event = { toolName, input: args, toolCallId };
    const blocked = await security.handleToolCall(event as never, undefined);
    if (blocked) return { blocked: true, reason: blocked.reason };
    const result = await tools.find(tool => tool.name === toolName)!.execute(toolCallId, args, undefined, undefined);
    const corrected = await security.handleToolResult({ ...event, ...result, isError: false } as never);
    return { blocked: false, ...JSON.parse(corrected.content[0]!.text) };
  };
  const createArgs = { action: "create", record: { date: "2026-10-18", amountCents: 1200, description: "早餐", category: "餐饮" } };
  assert.equal((await call("finance_record", createArgs, "finance-create-old")).status, "completed");
  const createTicket = (await f.approvals.listReadOnlyViews()).find(state => state.ticket.toolCallId === "finance-create-old")!.ticket;
  assert.deepEqual(createTicket.normalizedArguments, createArgs, "real approval contains business args, not the changing userEntry/call seed");
  const nextPrepared = await port.prepareFinance!("finance_record", createArgs, "task:user-new-run:finance-create-new");
  assert.notDeepEqual(nextPrepared.target, createTicket.resolvedTarget, "without the task guard the new seed produces another record target");
  await finance.store.update(data => { data.financeDefaultBudget = { totalCents: 500000, allocations: { 餐饮: 150000, 交通: 70000 } }; });
  const before = financeBudgetSnapshot(await finance.store.readFresh(), "default");
  const deltaArgs = { action: "update", scope: "default", expectedVersion: before.version, deltas: { 餐饮: 20000 } };
  assert.equal((await call("finance_budget", deltaArgs, "finance-delta-old")).status, "completed");
  let record = (await finance.service.readForConversation()).records[0]!;
  const updateArgs = { action: "update", targets: [{ id: record.entry.id, expectedVersion: record.version }], patch: { description: "工作早餐" } };
  assert.equal((await call("finance_record", updateArgs, "finance-update-old")).status, "completed");
  snapshot = await prepareTaskResumeSafety(f);
  await f.createRun("new-run");
  identity = { ...identity, productRunId: "new-run" };
  entry = { entryId: "user-new-run", text: "接着完成剩余工作" }; // Does not trigger the old retry-text heuristic.
  assert.equal((await call("finance_record", createArgs, "finance-create-new")).blocked, true);
  const after = financeBudgetSnapshot(await finance.store.readFresh(), "default");
  assert.notEqual(after.version, before.version);
  assert.equal((await call("finance_budget", { ...deltaArgs, expectedVersion: after.version }, "finance-delta-new")).blocked, true);
  assert.equal(financeBudgetSnapshot(await finance.store.readFresh(), "default").budget!.allocations.餐饮, 170000, "fresh version cannot apply the same +200 twice");
  record = (await finance.service.readForConversation()).records[0]!;
  assert.equal((await call("finance_record", { ...updateArgs, targets: [{ id: record.entry.id, expectedVersion: record.version }] }, "finance-update-new")).blocked, true);
  assert.equal((await finance.service.readForConversation()).records.length, 1);
  assert.equal((await call("finance_record", { ...createArgs, record: { ...createArgs.record, description: "午餐", amountCents: 2200 } }, "finance-unrelated-new")).status, "completed");
  assert.equal((await finance.service.readForConversation()).records.length, 2, "different business content remains allowed during continuation");
  snapshot = undefined;
  assert.equal((await call("finance_record", createArgs, "finance-intentional-later")).status, "completed");
  assert.equal((await finance.service.readForConversation()).records.length, 3, "ordinary later user intent is not banned by the resumed-task guard");
  console.log("PASS real finance approval/native-port/service pipeline: changed run/user/call seeds, fresh budget/record versions, unrelated writes and ordinary later intent");
}

async function localReadbackAndReadonlyInspection(root: string): Promise<void> {
  const f = await fixture(root);
  const a = await authorized(f, "note_create", "lost-receipt", { relativePath: "task.md", content: "saved" }, { relativePath: "task.md" }, { beforeVersion: null, expectedAfterSha256: sha("saved") });
  await f.receipts.beginAuthorizedOperation(a);
  await f.receipts.markEffectStarted(a.operationIdentity);
  await writeFile(path.join(f.vaultRootPath, "task.md"), "saved");
  const pendingContract = { productRunId: "old-run", toolCallId: "expired-pending", conversationId: "task", piSessionId: "same-session", userId: "user", vaultId: f.vaultId, deviceId: "device",
    toolId: "note_create" as const, toolVersion: "v1", policyVersion: "v1", normalizedArguments: { relativePath: "later.md", content: "later" }, resolvedTarget: { relativePath: "later.md" }, targetVersion: { beforeVersion: null, expectedAfterSha256: sha("later") }, preview: null };
  await f.approvals.issue({ ...pendingContract, issuedAt: f.now(), expiresAt: f.now() + 100 });
  for (let index = 0; index < 110; index++) f.now();
  const before = await treeContents(root);
  const inspected = await readTaskResumeSafety(f);
  assert.equal(inspected.operations[0]?.status, "uncertain");
  assert.deepEqual(await treeContents(root), before, "card inspection cannot expire tickets or write a recovered receipt");
  const recovered = await prepareTaskResumeSafety(f);
  assert.equal(recovered.operations.find(op => op.operationIdentity === a.operationIdentity)?.status, "completed");
  assert.deepEqual(recovered.fileConflicts, []);
  await assert.rejects(guard(f, recovered, "note_create", { relativePath: "task.md", content: "saved" }), /already_completed/u);
  const cold = new FileProductRunStore({ storageRootPath: path.join(root, "cold-store"), vaultId: f.vaultId, catalog: f.catalog });
  assert.deepEqual(await cold.listReadOnly(), []);
  await assert.rejects(lstat(path.join(root, "cold-store")), { code: "ENOENT" });
  console.log("PASS strict readonly inspection, local missing-receipt recovery, pending action descriptors");
}

async function treeContents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) for (const [key, value] of Object.entries(await treeContents(file))) result[`${item.name}/${key}`] = value;
    else result[item.name] = await readFile(file, "utf8");
  }
  return result;
}

async function pdfResumeReusesOriginalJob(root: string): Promise<void> {
  const approvals = new FileApprovalTicketStore({ storageRootPath: root, vaultId: "pdf-resume" });
  const receipts = new FileDomainReceiptStore({ storageRootPath: root, vaultId: "pdf-resume" });
  await approvals.initialize(); await receipts.initialize();
  const args = { path: "source.pdf", reading: false };
  const originalId = sha(`task:user-old-run\n${JSON.stringify(args)}`);
  let job: PdfJob = { version: 1, id: originalId, name: "source.pdf", createdAt: 1, options: { engine: "mineru", reading: false, translation: false, wiki: false },
    state: "completed", stage: "done", sourceFingerprint: sha("source-pdf"), rawDirectory: "Raw", artifacts: [{ kind: "raw", path: "Raw/source.md" }], pages: [], chunks: [], warnings: [], published: {} };
  let starts = 0, resumes = 0;
  const attachmentId = "pdf-00000000-0000-0000-0000-000000000001";
  const security = new PiPdfReadingSecurity({ host: () => ({ plugin: { app: {}, settings: { pdfReading: { engine: "mineru", translationLanguage: "中文" } } },
    api: { deps: { access: paidTestAccess, enabled: () => true }, files: { listJobs: async () => [originalId], exists: async () => true, read: async () => "# saved", readBinary: async () => new TextEncoder().encode("source-pdf") },
      prepareStartIntent: async (name: string, _bytes: Uint8Array, options: unknown, id: string) => ({ name, id, options, sourceFingerprint: sha("source-pdf"), byteLength: 10, rawDirectory: "Raw" }), load: async () => structuredClone(job),
      start: async () => { starts++; return job; }, resume: async (id: string) => { assert.equal(id, originalId); resumes++; return { ...job, state: "completed" }; },
      actualArtifacts: async () => job.artifacts }, processVault: async () => { starts++; return job; }
  }) as never, approvals, receipts, userId: "user", deviceId: "device",
    currentRunIdentity: () => ({ vaultId: "pdf-resume", conversationId: "task", piSessionId: "same-session", productRunId: "new-run" }), confirmation: { confirm: async () => true },
    access: () => ({ permission: "write", mode: "chat" }) as never, identity: () => "new-run", intentId: () => "task:user-new-run", resumeIntentId: () => "task:user-old-run",
    documents: () => [{ transport: "tool_reference", attachmentId, attachment: { name: "source.pdf" }, sha256: sha("source-pdf"), bytes: new TextEncoder().encode("source-pdf") }] as never,
    resumeOperations: () => [{ toolCallId: "original-pdf", userEntryId: "user-old-run", arguments: args, jobId: originalId }],
    consume: () => ({ conversationId: "task", userEntryId: "user-new-run" }), bindSources() {}, wikiPaths: async () => [] });
  const invoke = async (id: string, input: object) => {
    const event = { type: "tool_call", toolCallId: id, toolName: "pdf_reading_process", input };
    assert.equal(await security.handleToolCall(event as never), undefined);
    await security.execute(id, event.toolName, input);
    return await security.handleToolResult(event as never);
  };
  try {
    assert.equal((await invoke("pdf-completed", args)).isError, false);
    assert.equal(starts, 0); assert.equal(resumes, 0, "completed original job is read without restarting extraction/generation");
    job = { ...job, state: "partial" };
    assert.equal((await invoke("pdf-partial", args)).isError, false);
    assert.equal(starts, 0); assert.equal(resumes, 1, "partial work resumes the exact original job");
    const reuploaded = await invoke("pdf-new-attachment-id", { attachmentId, reading: false });
    assert.equal(reuploaded.isError, false, JSON.stringify(reuploaded));
    assert.equal(starts, 0); assert.equal(resumes, 2, "reuploaded same bytes use original job despite changed attachment ID");
    assert.equal((await invoke("pdf-changed-options", { path: "source.pdf", reading: true })).isError, false, "changed options resume old job");
    assert.equal(starts, 0); assert.equal(resumes, 3, "changed path-call options cannot create a duplicate extraction/upload");
    job = { ...job, state: "completed" };
    assert.equal((await invoke("pdf-new-step", { path: "next.pdf", reading: false })).isError, false, "new PDF step remains allowed");
    assert.equal(starts, 1, "first PDF step for a different source remains available in resumed tasks");
    console.log("PASS PDF original job/fingerprint reuse, changed options, and new resumed-task step");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function pdfSessionEvidenceIsReadonly(root: string): Promise<void> {
  const f = await fixture(root);
  const timestamp = new Date().toISOString();
  const sessionFile = path.join(f.catalog.sessionRootPath, "resume-evidence.jsonl");
  const entries = [
    { type: "session", version: 3, id: "same-session", timestamp, cwd: f.vaultRootPath },
    { type: "message", id: "user-old-run", parentId: null, timestamp, message: { role: "user", content: "Process source.pdf", timestamp: f.now() } },
    { type: "message", id: "assistant-pdf", parentId: "user-old-run", timestamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "original-pdf", name: "pdf_reading_process", arguments: { reading: false, path: "source.pdf" } }
    ], api: "openai-completions", provider: "offline", model: "offline", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: f.now() } }
  ];
  await writeFile(sessionFile, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const catalog = (await f.catalog.get("task"))!;
  await f.catalog.upsert({ ...catalog, sessionFile, updatedAt: f.now() });
  const before = await treeContents(root);
  const snapshot = await readTaskResumeSafety(f);
  assert.deepEqual(snapshot.pdfOperations, [{ toolCallId: "original-pdf", userEntryId: "user-old-run", arguments: { path: "source.pdf", reading: false },
    jobId: sha(`task:user-old-run\n${JSON.stringify({ path: "source.pdf", reading: false })}`) }]);
  assert.deepEqual(await treeContents(root), before);
  console.log("PASS original Pi JSONL provides scoped PDF operation evidence without writes");
}

async function todoReceiptsShareTheFileGuard(root: string): Promise<void> {
  const f = await fixture(root);
  await mkdir(path.join(f.vaultRootPath, "EchoInk"));
  const content = "- [ ] Book train tickets <!-- echoink-todo-id: train -->\n";
  const args = { title: "Book train tickets" };
  const target = { relativePath: "EchoInk/待办.md", todoId: "train" };
  const authorization = await authorized(f, "todo_add", "add", args, target, { beforeVersion: null });
  await f.receipts.beginAuthorizedOperation(authorization);
  await f.receipts.markEffectStarted(authorization.operationIdentity);
  await writeFile(path.join(f.vaultRootPath, "EchoInk/待办.md"), content);
  await f.receipts.markEffectCompleted(authorization.operationIdentity);
  await f.receipts.persistReceipt({ operationIdentity: authorization.operationIdentity, status: "completed", safeSummary: { action: "todo_add" }, readback: { checkedAt: f.now(), readbackVerified: true, observedTargetVersion: sha(content), safeSummary: "read back" } });
  const snapshot = await prepareTaskResumeSafety(f);
  assert.deepEqual(snapshot.fileConflicts, []);
  assert.equal(snapshot.fileVersions[0]?.expectedVersion, sha(content));
  await assert.rejects(guard(f, snapshot, "todo_add", args, target), /already_completed/u);
  await assert.rejects(guard(f, snapshot, "todo_add", { ...args, people: "", dueDate: "", dueTime: "", categoryName: "", project: "" }, target), /already_completed/u);
  await writeFile(path.join(f.vaultRootPath, "EchoInk/待办.md"), content + "- [ ] User edit\n");
  await assert.rejects(guard(f, snapshot, "todo_complete", { id: "train", done: true }, target), /file_version_conflict/u);
  const second = await authorized(f, "todo_update", "uncertain", { id: "train", patch: { dueDate: "2026-10-20" } }, target, { beforeVersion: sha(content) });
  await f.receipts.beginAuthorizedOperation(second); await f.receipts.markEffectStarted(second.operationIdentity);
  const recovered = await prepareTaskResumeSafety(f);
  assert.equal(recovered.operations.find(item => item.toolCallId === "uncertain")?.status, "uncertain");
  await assert.rejects(guard(f, recovered, "todo_update", { id: "train", patch: { dueDate: "2026-10-20" } }, target), /uncertain_no_replay/u);
  console.log("PASS todo durable receipts: resumed dedupe, written file version, external edit rejection, unknown effect retained");
}
