import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { EnglishDiaryService } from "../../english-diary/service";
import { EnglishDiaryRepository, normalizeDiaryPath } from "../../english-diary/repository";
import { fingerprint, splitDiaryBlocks } from "../../english-diary/model";
import type { DiaryFilePort, DiaryGenerator, DiarySource } from "../../english-diary/types";
import { paidTestAccess } from "../membership-access";
import { unavailableCapabilityAccess } from "../../membership/access";
import { FileApprovalTicketStore } from "../../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../../harness/pi-native/domain-receipt-store";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { assertTaskResumeToolAllowed, prepareTaskResumeSafety, readTaskResumeSafety } from "../../plugin/task-resume-safety";
import { createPiEnglishDiaryToolDefinitions, normalizeEnglishDiaryToolRequest, PiEnglishDiaryToolSecurity, PI_ENGLISH_DIARY_TOOL_ID } from "../../harness/pi-native/pi-english-diary-tools";
import type { PiWorkspaceAccess } from "../../harness/pi-native/pi-workspace-access";

const SOURCE_PATH = "Daily/2026-10-19.md";
const SOURCE = "I finally 鼓起勇气 to ask.\nKEEP-THIS-ENGLISH.\nPRIVATE-MEDICAL-DETAIL";
function responseFor(prompt: string): string {
  const input = JSON.parse(prompt) as { blocks: Array<{ id: string; mode: string; text: string }> };
  return JSON.stringify({ blocks: input.blocks.filter(block => block.mode === "translate").map(block => ({ id: block.id,
    english: block.text.replace("鼓起勇气", "worked up the courage"), alignments: [] })), expressions: [] });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

class FixtureFiles implements DiaryFilePort {
  mutations = 0;
  failEnglishWrite = false;
  afterWrite?: (relative: string) => Promise<void>;
  constructor(readonly root: string) {}
  private absolute(relative: string) { return path.join(this.root, normalizeDiaryPath(relative)); }
  async read(relative: string): Promise<string | null> {
    try { return await readFile(this.absolute(relative), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async list(directory: string): Promise<string[]> {
    let entries;
    try { entries = await readdir(this.absolute(directory), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return (await Promise.all(entries.map(async entry => entry.isDirectory() ? await this.list(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]))).flat();
  }
  async write(relative: string, content: string, expected: string | null): Promise<void> {
    this.mutations++;
    if (this.failEnglishWrite && relative.startsWith("English/")) throw new Error("fixture-save-failure");
    assert.equal(await this.read(relative), expected, "real file expected-content check");
    await mkdir(path.dirname(this.absolute(relative)), { recursive: true });
    await writeFile(this.absolute(relative), content);
    await this.afterWrite?.(relative);
  }
  async move(from: string, to: string, expected?: string): Promise<void> {
    this.mutations++;
    if (expected !== undefined) assert.equal(await this.read(from), expected);
    assert.equal(await this.read(to), null);
    await mkdir(path.dirname(this.absolute(to)), { recursive: true });
    await rename(this.absolute(from), this.absolute(to));
  }
  async remove(relative: string, expected: string): Promise<void> { this.mutations++; assert.equal(await this.read(relative), expected); await unlink(this.absolute(relative)); }
  async set(relative: string, content: string): Promise<void> { await this.write(relative, content, await this.read(relative)); }
}

async function resumeInput(f: Awaited<ReturnType<typeof fixture>>, operationIdentity: string) {
  const operation = (await f.receipts.readOperation(operationIdentity))!;
  const catalog = new FileConversationCatalog({ storageRootPath: f.receipts.storageRootPath, vaultId: operation.vaultId });
  const productRuns = new FileProductRunStore({ storageRootPath: f.receipts.storageRootPath, vaultId: operation.vaultId, catalog });
  await catalog.initialize();
  const timestamp = Date.now();
  await catalog.upsert({ conversationId: operation.conversationId, piSessionId: operation.piSessionId, vaultId: operation.vaultId,
    title: "English diary recovery fixture", status: "active", defaultMemoryMode: "normal", createdAt: timestamp, updatedAt: timestamp });
  await productRuns.create({ productRunId: operation.productRunId, conversationId: operation.conversationId, piSessionId: operation.piSessionId,
    userEntryId: "original-diary-entry", toolCallIds: [operation.toolCallId], memoryMode: "normal", state: "product_run_settled",
    terminalState: "cancelled", activeLeafId: null, createdAt: timestamp, updatedAt: timestamp, agentSettledAt: timestamp, settledAt: timestamp });
  return { receipts: f.receipts, approvals: f.approvals, catalog, productRuns, vaultRootPath: f.files.root,
    conversationId: operation.conversationId, interruptedRunId: operation.productRunId };
}
async function fixture(root: string) {
  await mkdir(root, { recursive: true });
  const files = new FixtureFiles(root);
  await files.set(SOURCE_PATH, SOURCE);
  const source = async (relative: string): Promise<DiarySource> => {
    const content = await files.read(relative);
    if (content === null) throw new Error("fixture-source-missing");
    return { path: relative, content, title: "2026-10-19", date: "2026-10-19" };
  };
  let requests: Array<{ systemPrompt: string; userPrompt: string; signal: AbortSignal }> = [];
  let generate: DiaryGenerator["generate"] = async input => responseFor(input.userPrompt);
  let paid = true;
  const productAccess = { ...paidTestAccess,
    checkCapability: (capability: Parameters<typeof paidTestAccess.checkCapability>[0]) => paid ? paidTestAccess.checkCapability(capability) : unavailableCapabilityAccess.checkCapability(capability),
    requireCapability: (capability: Parameters<typeof paidTestAccess.requireCapability>[0]) => { if (!paid) unavailableCapabilityAccess.requireCapability(capability); } };
  const generator: DiaryGenerator = { skill: async () => "fixture English diary Skill", providerLabel: () => "fixture",
    generate: async input => { requests.push(input); return await generate(input); } };
  const repo = new EnglishDiaryRepository(files, { stateDirectory: ".diary-state", englishDirectory: "English", expressionDirectory: "Expressions" }, productAccess);
  const service = new EnglishDiaryService(repo, { ...generator, generate: async () => { throw new Error("default generator must never be used by Agent"); } }, source, productAccess);
  const initial = await service.load(SOURCE_PATH);
  await service.savePrivacy(SOURCE_PATH, { sourceFingerprint: fingerprint(SOURCE), rules: splitDiaryBlocks(SOURCE).map(block => ({ blockId: block.id,
    mode: block.text.includes("PRIVATE") ? "exclude" : block.text.includes("KEEP-THIS") ? "preserve" : "translate" })) });
  let access: PiWorkspaceAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
  let identity = { vaultId: "english-diary-fixture", conversationId: "conversation", piSessionId: "session", productRunId: "run-1" };
  let entry = { entryId: "entry-1", text: "请生成英文日记" };
  let request: { sourcePath: string; intentEntryId?: string } | null = { sourcePath: SOURCE_PATH, intentEntryId: entry.entryId };
  let accepted = true, confirms = 0, seq = 0, allowed = true, validations = 0, inspectFails = false;
  let confirmEffect: (() => Promise<void>) | undefined;
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".pi"), vaultId: identity.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".pi"), vaultId: identity.vaultId });
  await approvals.initialize(); await receipts.initialize();
  const options = { currentRequest: () => request, currentAccess: () => access,
    currentRunIdentity: () => ({ ...identity, userEntryText: "transient runtime context must not enter approval contract" }), currentUserEntry: () => entry,
    approvals, receipts, userId: "fixture-user", deviceId: "fixture-device",
    assertToolAllowed: async (tool: string, _args: unknown, target?: unknown, operation?: { productRunId: string; toolCallId: string }) => {
      assert.equal(tool, PI_ENGLISH_DIARY_TOOL_ID); assert.equal(operation?.productRunId, identity.productRunId);
      if (target) assert.equal((target as { sourcePath: string }).sourcePath, SOURCE_PATH);
      if (!allowed) throw new Error("agent_capability_denied");
    }, confirmation: { confirm: async (value: any) => {
      confirms++; assert.equal(value.target.sourcePath, SOURCE_PATH);
      assert.doesNotMatch(JSON.stringify(value.preview), /PRIVATE|courage|鼓起勇气/);
      await confirmEffect?.(); return accepted;
    } } };
  const port = { api: service, generator, inspect: async (relative: string) => {
    if (inspectFails) throw new Error("fixture inspection failure");
    return await repo.inspect(await source(relative));
  },
    validateSource: async (relative: string) => { validations++; assert.equal(relative, SOURCE_PATH); } };
  let security: PiEnglishDiaryToolSecurity, tools: ReturnType<typeof createPiEnglishDiaryToolDefinitions>;
  function restart() { security = new PiEnglishDiaryToolSecurity(options); tools = createPiEnglishDiaryToolDefinitions(port, security); }
  restart();
  function next() { identity = { ...identity, productRunId: `run-${++seq + 10}` }; entry = { ...entry, entryId: `entry-${seq + 10}` }; request = { sourcePath: SOURCE_PATH, intentEntryId: entry.entryId }; }
  function continueTask() { const intentEntryId = request?.intentEntryId ?? entry.entryId; next(); request = { sourcePath: SOURCE_PATH, intentEntryId }; }
  function nextConversation() { next(); identity = { ...identity, conversationId: `conversation-${seq}` }; }
  async function authorize(input: Record<string, unknown> = { sourcePath: SOURCE_PATH }, signal?: AbortSignal) {
    const event = { toolName: PI_ENGLISH_DIARY_TOOL_ID, toolCallId: `call-${++seq}`, input } as any;
    return { event, blocked: await security.handleToolCall(event, signal) };
  }
  async function execute(event: any, signal?: AbortSignal) {
    const raw = await tools[0].execute(event.toolCallId, event.input, signal, undefined);
    const result = await security.handleToolResult({ ...event, ...raw, isError: false } as any);
    return { ...JSON.parse(result.content[0].text), isError: result.isError } as any;
  }
  async function call(input: Record<string, unknown> = { sourcePath: SOURCE_PATH }, between?: () => Promise<void>, signal?: AbortSignal) {
    const auth = await authorize(input, signal);
    if (auth.blocked) return { blocked: true, reason: auth.blocked.reason } as any;
    await between?.();
    return await execute(auth.event, signal);
  }
  return { files, repo, service, generator, requests, approvals, receipts, initial, call, authorize, execute, next, continueTask, nextConversation, restart,
    counts: () => ({ calls: requests.length, confirms, validations }),
    mutate: (value: { access?: PiWorkspaceAccess; accepted?: boolean; allowed?: boolean; paid?: boolean; inspectFails?: boolean; request?: typeof request; userEntryId?: string; confirmEffect?: typeof confirmEffect }) => {
      if (value.access) access = value.access; if (value.accepted !== undefined) accepted = value.accepted;
      if (value.allowed !== undefined) allowed = value.allowed; if (value.paid !== undefined) paid = value.paid;
      if ("request" in value) request = value.request!; if ("confirmEffect" in value) confirmEffect = value.confirmEffect;
      if (value.userEntryId !== undefined) entry = { ...entry, entryId: value.userEntryId };
      if (value.inspectFails !== undefined) inspectFails = value.inspectFails;
    }, setGenerator: (fn: DiaryGenerator["generate"]) => { generate = fn; } };
}

export async function runEnglishDiaryToolTests(root: string): Promise<void> {
  let passed = 0;
  async function test(name: string, fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    await fn(await fixture(path.join(root, String(++passed)))); console.log(`English diary tool: PASS ${name}`);
  }
  for (const input of [{ sourcePath: "../outside.md" }, { sourcePath: SOURCE_PATH, extra: "another.md" }, { sourcePath: "Daily\\2026-10-19.md" }, { sourcePath: [SOURCE_PATH] }, {}]) {
    assert.throws(() => normalizeEnglishDiaryToolRequest(input));
  }
  await test("host intent and access fail closed", async f => {
    for (const request of [null, { sourcePath: "Daily/another.md" }, { sourcePath: SOURCE_PATH, intentEntryId: "" }]) {
      f.mutate({ request }); assert.equal((await f.call()).reason, "english_diary_request_mismatch");
    }
    f.next();
    f.mutate({ access: { permission: "read-only", mode: "agent", memoryMode: "normal" } }); assert.equal((await f.call()).reason, "tool_policy_blocked");
    f.mutate({ access: { permission: "workspace-write", mode: "plan", memoryMode: "normal" } }); assert.equal((await f.call()).reason, "tool_policy_blocked");
    f.mutate({ access: { permission: "workspace-write", mode: "agent", memoryMode: "normal" }, allowed: false }); assert.equal((await f.call()).reason, "agent_capability_denied");
    f.mutate({ allowed: true, paid: false }); assert.equal((await f.call()).blocked, true);
    assert.equal(f.counts().calls, 0); assert.equal(f.counts().confirms, 0);
  });
  await test("denial generates nothing; approval verifies persisted result and privacy", async f => {
    f.mutate({ accepted: false }); assert.equal((await f.call()).reason, "approval_denied"); assert.equal(f.counts().calls, 0);
    f.mutate({ accepted: true }); f.next();
    const result = await f.call(); assert.equal(result.status, "completed"); assert.equal(result.readbackVerified, true);
    assert.equal(f.counts().calls, 1); assert.equal(result.expressionCount, 0);
    assert.doesNotMatch(f.requests[0].userPrompt, /PRIVATE-MEDICAL-DETAIL/);
    const record = await f.service.load(SOURCE_PATH);
    assert.equal(record.result?.operationId, result.operationId);
    assert.match(record.result!.english, /KEEP-THIS-ENGLISH/);
    assert.match(record.result!.english, /PRIVATE-MEDICAL-DETAIL/);
    assert.equal(await f.files.read(SOURCE_PATH), SOURCE);
    const receipt = await f.receipts.readReceipt(result.operationIdentity);
    assert.equal(receipt?.status, "completed"); assert.equal(receipt?.readback.readbackVerified, true);
    assert.equal((receipt?.targetVersion as any).operationId, result.operationId);
    for (const safe of [result, receipt, await f.receipts.readOperation(result.operationIdentity)]) assert.doesNotMatch(JSON.stringify(safe), /PRIVATE|KEEP-THIS|worked up|鼓起勇气/);
    assert.equal((await f.call()).reason, "english_diary_operation_already_completed");
    f.next(); f.restart(); assert.equal((await f.call()).status, "completed"); assert.equal(f.counts().calls, 1);
    assert.equal((await f.repo.listGenerationActivity()).reduce((total, day) => total + day.generationCount, 0), 1);
  });
  await test("a new user entry can continue the same persisted intent after denial", async f => {
    f.mutate({ accepted: false }); assert.equal((await f.call()).reason, "approval_denied"); assert.equal(f.counts().calls, 0);
    f.continueTask(); f.restart(); f.mutate({ accepted: true });
    const result = await f.call(); assert.equal(result.status, "completed"); assert.equal(f.counts().calls, 1);
    const receipt = await f.receipts.readReceipt(result.operationIdentity);
    assert.equal((receipt?.targetVersion as any).intentEntryId, "entry-1", "receipt retains original host-owned task intent");
  });
  await test("a completed persisted intent cannot generate again in a resumed run", async f => {
    assert.equal((await f.call()).status, "completed");
    const confirmations = f.counts().confirms;
    f.continueTask(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_operation_already_completed");
    assert.equal(f.counts().calls, 1); assert.equal(f.counts().confirms, confirmations);
  });
  await test("an uncertain persisted intent stays blocked in a resumed run", async f => {
    f.files.failEnglishWrite = true;
    assert.equal((await f.call()).status, "uncertain");
    f.files.failEnglishWrite = false; f.continueTask(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_previous_result_uncertain_do_not_retry"); assert.equal(f.counts().calls, 1);
  });
  await test("current user and trusted task identity cannot change within one authorization", async f => {
    f.mutate({ confirmEffect: async () => { f.mutate({ userEntryId: "changed-while-confirming" }); } });
    assert.equal((await f.call()).reason, "english_diary_request_mismatch"); assert.equal(f.counts().calls, 0);
    f.mutate({ confirmEffect: undefined }); f.continueTask();
    const currentUserChanged = await f.call(undefined, async () => { f.mutate({ userEntryId: "changed-after-approval" }); });
    assert.equal(currentUserChanged.reason, "english_diary_request_mismatch"); assert.equal(f.counts().calls, 0);
    f.continueTask();
    const taskChanged = await f.call(undefined, async () => { f.mutate({ request: { sourcePath: SOURCE_PATH, intentEntryId: "another-task-intent" } }); });
    assert.equal(taskChanged.reason, "english_diary_request_mismatch"); assert.equal(f.counts().calls, 0);
  });
  await test("single consume, source/English/privacy versions and permission are rechecked", async f => {
    const auth = await f.authorize(); assert.equal(auth.blocked, undefined);
    await f.files.set(SOURCE_PATH, `${SOURCE}\nchanged`);
    assert.equal((await f.execute(auth.event)).reason, "english_diary_version_changed");
    assert.equal(f.counts().calls, 0);
    await assert.rejects(f.execute(auth.event), /english_diary_authorization_failed/);
    await f.files.set(SOURCE_PATH, SOURCE); f.next();
    const denied = await f.call(undefined, async () => { f.mutate({ allowed: false }); });
    assert.equal(denied.reason, "agent_capability_denied"); assert.equal(f.counts().calls, 0);
    f.mutate({ allowed: true }); f.next();
    const englishConflict = await f.call(undefined, async () => { await f.files.set(f.initial.englishPath, "a manual English draft"); });
    assert.equal(englishConflict.reason, "english_diary_version_changed"); assert.equal(f.counts().calls, 0);
  });
  await test("confirmation-time source change is never generated", async f => {
    f.mutate({ confirmEffect: async () => { await f.files.set(SOURCE_PATH, `${SOURCE}\nchanged`); } });
    assert.equal((await f.call()).reason, "english_diary_version_changed"); assert.equal(f.counts().calls, 0);
  });
  await test("privacy changes after approval invalidate the authorization", async f => {
    const result = await f.call(undefined, async () => {
      const record = await f.service.load(SOURCE_PATH);
      await f.service.savePrivacy(SOURCE_PATH, { ...record.privacy!, rules: record.privacy!.rules.map(rule => ({ ...rule, mode: "exclude" })) });
    });
    assert.equal(result.reason, "english_diary_version_changed"); assert.equal(f.counts().calls, 0);
  });
  await test("two authorized calls cannot generate the same source twice", async f => {
    const a = await f.authorize(), b = await f.authorize(); assert.equal(a.blocked, undefined); assert.equal(b.blocked, undefined);
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async input => { started.resolve(); return await finish.promise; });
    const first = f.execute(a.event); await started.promise;
    const second = await f.execute(b.event); assert.equal(second.reason, "english_diary_busy");
    finish.resolve(responseFor(f.requests[0].userPrompt)); assert.equal((await first).status, "completed"); assert.equal(f.counts().calls, 1);
  });
  await test("workspace close cannot cancel Agent; Agent signal cannot cancel workspace", async f => {
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const result = f.call(); await started.promise;
    f.service.cancel(SOURCE_PATH, "workspace"); assert.equal(f.requests[0].signal.aborted, false);
    const abort = new AbortController();
    await assert.rejects(f.service.generate(SOURCE_PATH, { owner: "workspace", signal: abort.signal, generator: f.generator }), (e: any) => e.code === "english_diary_busy");
    abort.abort(); assert.equal(f.requests[0].signal.aborted, false);
    finish.resolve(responseFor(f.requests[0].userPrompt)); assert.equal((await result).status, "completed");
    await f.files.set(SOURCE_PATH, `${SOURCE}\nA new line.`);
    const start2 = deferred<void>(), finish2 = deferred<string>();
    f.setGenerator(async () => { start2.resolve(); return await finish2.promise; });
    const workspace = f.service.generate(SOURCE_PATH, { generator: f.generator }); await start2.promise;
    const agentSignal = new AbortController();
    await assert.rejects(f.service.generate(SOURCE_PATH, { owner: "agent", signal: agentSignal.signal, generator: f.generator }), (e: any) => e.code === "english_diary_busy");
    agentSignal.abort(); f.service.cancel(SOURCE_PATH, "agent"); assert.equal(f.requests[1].signal.aborted, false);
    assert.equal(f.service.generate(SOURCE_PATH, { generator: f.generator }), workspace, "same-owner active reuse remains intact");
    f.service.cancel(SOURCE_PATH, "workspace"); assert.equal(f.requests[1].signal.aborted, true);
    finish2.resolve(responseFor(f.requests[1].userPrompt)); await assert.rejects(workspace, (e: any) => e.code === "english_diary_cancelled");
  });
  await test("a workspace race is a known busy failure, never an uncertain Agent write", async f => {
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const mark = f.receipts.markEffectStarted.bind(f.receipts);
    let workspace!: ReturnType<EnglishDiaryService["generate"]>;
    f.receipts.markEffectStarted = async operation => {
      workspace = f.service.generate(SOURCE_PATH, { generator: f.generator });
      await started.promise; return await mark(operation);
    };
    const result = await f.call(); assert.equal(result.reason, "english_diary_busy"); assert.equal(result.status, "failed");
    assert.equal(f.requests[0].signal.aborted, false);
    finish.resolve(responseFor(f.requests[0].userPrompt)); await workspace;
    assert.equal(f.counts().calls, 1);
  });
  await test("Agent abort verifies zero publication and permits a fresh approved retry", async f => {
    const started = deferred<void>(), finish = deferred<string>(), signal = new AbortController();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const running = f.call(undefined, undefined, signal.signal); await started.promise;
    signal.abort(); finish.resolve(responseFor(f.requests[0].userPrompt));
    const result = await running; assert.equal(result.status, "cancelled"); assert.equal(result.noPublicationVerified, true);
    assert.equal((await f.service.load(SOURCE_PATH)).result, null);
    f.continueTask(); f.restart(); f.setGenerator(async input => responseFor(input.userPrompt));
    assert.equal((await f.call()).status, "completed"); assert.equal(f.counts().calls, 2);
  });
  await test("generation-time revoke and source edits preserve existing files", async f => {
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const running = f.call(); await started.promise;
    f.mutate({ access: { permission: "read-only", mode: "agent", memoryMode: "normal" } });
    finish.resolve(responseFor(f.requests[0].userPrompt));
    const result = await running; assert.equal(result.status, "failed"); assert.equal(result.noPublicationVerified, true);
    assert.equal(await f.files.read(f.initial.englishPath), null);
  });
  await test("Provider failure with unchanged publication can retry despite privacy normalization", async f => {
    const statePath = `.diary-state/${f.initial.id}.json`;
    const state = JSON.parse((await f.files.read(statePath))!);
    state.privacy.sourceFingerprint = fingerprint("previous source before harmless privacy normalization");
    await f.files.set(statePath, JSON.stringify(state));
    f.setGenerator(async () => { throw new Error("fixture Provider failure: PRIVATE-MEDICAL-DETAIL"); });
    const result = await f.call(); assert.equal(result.status, "failed"); assert.equal(result.noPublicationVerified, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-MEDICAL-DETAIL/);
    const inspected = await f.repo.inspect(await f.service.readSource(SOURCE_PATH));
    assert.equal(inspected.result, null); assert.equal(inspected.pending, null); assert.equal(await f.files.read(f.initial.englishPath), null);
    assert.equal(inspected.privacy?.sourceFingerprint, fingerprint(SOURCE), "savePrivacy normalization is allowed without blessing an output change");
    const receipt = await f.receipts.readReceipt(result.operationIdentity);
    assert.equal(receipt?.status, "failed"); assert.equal((receipt?.safeSummary as any).noPublicationVerified, true);
    f.continueTask(); f.restart(); f.setGenerator(async input => responseFor(input.userPrompt));
    assert.equal((await f.call()).status, "completed"); assert.equal(f.counts().calls, 2);
  });
  await test("declined model recipient leaves no publication and can be confirmed on retry", async f => {
    let recipientAccepted = false, providerRequests = 0;
    f.setGenerator(async input => {
      if (!recipientAccepted) throw new Error("已取消，未发送日记内容。");
      providerRequests++; return responseFor(input.userPrompt);
    });
    const result = await f.call(); assert.equal(result.status, "failed"); assert.equal(result.noPublicationVerified, true);
    assert.equal(providerRequests, 0); assert.equal(await f.files.read(f.initial.englishPath), null);
    f.continueTask(); f.restart(); recipientAccepted = true;
    assert.equal((await f.call()).status, "completed"); assert.equal(providerRequests, 1);
  });
  await test("failed readback cannot prove a Provider failure had no publication", async f => {
    f.setGenerator(async () => { f.mutate({ inspectFails: true }); throw new Error("Provider failed"); });
    const result = await f.call(); assert.equal(result.status, "uncertain"); assert.equal(result.noPublicationVerified, undefined);
    f.mutate({ inspectFails: false }); f.continueTask(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_previous_result_uncertain_do_not_retry"); assert.equal(f.counts().calls, 1);
  });
  await test("a source edit while Provider runs is never published", async f => {
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const running = f.call(); await started.promise;
    await f.files.set(SOURCE_PATH, `${SOURCE}\nThe source changed while generating.`);
    finish.resolve(responseFor(f.requests[0].userPrompt));
    const result = await running; assert.equal(result.status, "uncertain"); assert.equal(result.reason, "english_diary_source_changed");
    assert.equal(await f.files.read(f.initial.englishPath), null);
  });
  await test("pending package resumes without a second Provider call", async f => {
    f.files.failEnglishWrite = true;
    await assert.rejects(f.service.generate(SOURCE_PATH, { generator: f.generator, operationId: "saved-pending-operation" }));
    assert.equal((await f.service.load(SOURCE_PATH)).pending?.operationId, "saved-pending-operation");
    f.files.failEnglishWrite = false;
    const result = await f.call(); assert.equal(result.status, "completed"); assert.equal(result.operationId, "saved-pending-operation"); assert.equal(f.counts().calls, 1);
  });
  await test("pending inspection and version rejection do not recover or write before confirmation", async f => {
    f.files.failEnglishWrite = true;
    await assert.rejects(f.service.generate(SOURCE_PATH, { generator: f.generator, operationId: "readonly-pending" }));
    f.files.failEnglishWrite = false;
    const statePath = `.diary-state/${f.initial.id}.json`;
    const state = JSON.parse((await f.files.read(statePath))!);
    state.transaction = { operationId: state.pending.operationId, changes: [], next: { ...state, transaction: undefined } };
    await f.files.set(statePath, JSON.stringify(state));
    const beforeRaw = await f.files.read(statePath), beforeWrites = f.files.mutations;
    f.mutate({ accepted: false }); assert.equal((await f.call()).reason, "approval_denied");
    assert.equal(f.files.mutations, beforeWrites); assert.equal(await f.files.read(statePath), beforeRaw);
    f.mutate({ accepted: true }); f.next();
    const auth = await f.authorize(); assert.equal(auth.blocked, undefined);
    assert.equal(f.files.mutations, beforeWrites); assert.equal(await f.files.read(statePath), beforeRaw);
    await f.files.set(SOURCE_PATH, `${SOURCE}\nchanged after approval`);
    const changedWrites = f.files.mutations;
    assert.equal((await f.execute(auth.event)).reason, "english_diary_version_changed");
    assert.equal(f.files.mutations, changedWrites); assert.equal(await f.files.read(statePath), beforeRaw);
    assert.equal(f.counts().calls, 1);
  });
  await test("tool save failure is uncertain and never automatically retried", async f => {
    f.files.failEnglishWrite = true;
    const result = await f.call(); assert.equal(result.status, "uncertain");
    f.files.failEnglishWrite = false; f.next(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_previous_result_uncertain_do_not_retry"); assert.equal(f.counts().calls, 1);
    assert.equal((await f.service.load(SOURCE_PATH)).pending?.operationId, result.operationId);
  });
  await test("partial publication followed by an outside edit stays uncertain and preserves the edit", async f => {
    f.files.afterWrite = async relative => {
      if (relative !== f.initial.englishPath) return;
      f.files.afterWrite = undefined;
      await f.files.set(relative, "USER EDIT DURING PARTIAL PUBLICATION");
      throw new Error("fixture write result lost after partial publication");
    };
    const result = await f.call(); assert.equal(result.status, "uncertain"); assert.equal(result.noPublicationVerified, undefined);
    assert.equal(await f.files.read(f.initial.englishPath), "USER EDIT DURING PARTIAL PUBLICATION");
    assert.ok((await f.repo.inspect(await f.service.readSource(SOURCE_PATH))).pending);
    f.continueTask(); f.restart();
    assert.equal((await f.call()).blocked, true); assert.equal(f.counts().calls, 1);
    assert.equal(await f.files.read(f.initial.englishPath), "USER EDIT DURING PARTIAL PUBLICATION");
  });
  await test("an older pending package cannot be overwritten by a changed source", async f => {
    f.files.failEnglishWrite = true;
    await assert.rejects(f.service.generate(SOURCE_PATH, { generator: f.generator, operationId: "older-pending" }));
    f.files.failEnglishWrite = false;
    await f.files.set(SOURCE_PATH, `${SOURCE}\nnew source`);
    assert.equal((await f.call()).reason, "english_diary_pending_source_changed"); assert.equal(f.counts().calls, 1);
    assert.equal((await f.service.load(SOURCE_PATH)).pending?.operationId, "older-pending");
  });
  await test("unchanged manually edited English is reused without being overwritten", async f => {
    assert.equal((await f.call()).status, "completed");
    await f.files.set(f.initial.englishPath, "USER MANUAL ENGLISH"); f.next();
    assert.equal((await f.call()).status, "completed"); assert.equal(f.counts().calls, 1);
    assert.equal(await f.files.read(f.initial.englishPath), "USER MANUAL ENGLISH");
  });
  await test("manual English during generation is preserved and requires panel confirmation", async f => {
    const started = deferred<void>(), finish = deferred<string>();
    f.setGenerator(async () => { started.resolve(); return await finish.promise; });
    const running = f.call(); await started.promise;
    await f.files.set(f.initial.englishPath, "USER MANUAL ENGLISH"); finish.resolve(responseFor(f.requests[0].userPrompt));
    assert.equal((await running).status, "uncertain"); assert.equal(await f.files.read(f.initial.englishPath), "USER MANUAL ENGLISH");
    f.next(); assert.equal((await f.call()).reason, "english_diary_overwrite_required"); assert.equal(f.counts().calls, 1);
  });
  await test("receipt persistence failure cannot trigger generation replay", async f => {
    const persist = f.receipts.persistReceipt.bind(f.receipts);
    f.receipts.persistReceipt = async () => { throw new Error("fixture receipt failure"); };
    const result = await f.call(); assert.equal(result.status, "uncertain");
    assert.ok((await f.service.load(SOURCE_PATH)).result);
    f.receipts.persistReceipt = persist; f.next(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_previous_result_uncertain_do_not_retry"); assert.equal(f.counts().calls, 1);
    f.nextConversation(); f.restart();
    assert.equal((await f.call()).reason, "english_diary_previous_result_uncertain_do_not_retry"); assert.equal(f.counts().calls, 1);
  });
  await test("P4 completed receipts track both exact file hashes and prohibit semantic replay", async f => {
    const result = await f.call(); assert.equal(result.status, "completed");
    const input = await resumeInput(f, result.operationIdentity);
    const snapshot = await readTaskResumeSafety(input);
    assert.deepEqual(snapshot.fileConflicts, []);
    assert.equal(snapshot.fileVersions.length, 2);
    const versions = new Map(snapshot.fileVersions.map(item => [item.relativePath, item.expectedVersion]));
    assert.equal(versions.get(SOURCE_PATH), fingerprint(SOURCE));
    assert.equal(versions.get(f.initial.englishPath), fingerprint((await f.files.read(f.initial.englishPath))!));
    await assert.rejects(assertTaskResumeToolAllowed({ ...input, snapshot, toolName: PI_ENGLISH_DIARY_TOOL_ID, arguments: { sourcePath: SOURCE_PATH } }), /already_completed/);
    await f.files.set(SOURCE_PATH, `${SOURCE}\nuser source edit`);
    await f.files.set(f.initial.englishPath, "user English edit");
    const changed = await readTaskResumeSafety(input);
    assert.deepEqual(changed.fileConflicts.map(item => item.relativePath).sort(), [SOURCE_PATH, f.initial.englishPath].sort());
    for (const relativePath of [SOURCE_PATH, f.initial.englishPath]) {
      await assert.rejects(assertTaskResumeToolAllowed({ ...input, snapshot, toolName: "note_update", arguments: { relativePath, content: "unrelated write" } }), /file_version_conflict/);
    }
    assert.equal(f.counts().calls, 1);
  });
  await test("P4 missing receipt remains unknown and never infers success from before hashes", async f => {
    f.receipts.persistReceipt = async () => { throw new Error("fixture lost receipt"); };
    const result = await f.call(); assert.equal(result.status, "uncertain");
    const input = await resumeInput(f, result.operationIdentity);
    const beforeWrites = f.files.mutations;
    const snapshot = await prepareTaskResumeSafety(input);
    assert.equal(snapshot.operations[0].status, "uncertain");
    assert.equal((await f.receipts.readReceipt(result.operationIdentity))?.readback.readbackVerified, false);
    assert.equal(snapshot.fileVersions.length, 2);
    assert.equal(f.files.mutations, beforeWrites);
    await assert.rejects(assertTaskResumeToolAllowed({ ...input, snapshot, toolName: PI_ENGLISH_DIARY_TOOL_ID, arguments: { sourcePath: SOURCE_PATH } }), /uncertain_no_replay/);
    assert.equal(f.counts().calls, 1);
  });
  console.log(`English diary tools: ${passed} scenarios PASS`);
}
