import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PdfReadingService } from "../pdf-reading/service";
import { extractMinerPdf, type MinerTransport } from "../pdf-reading/mineru";
import type { PdfFiles, PdfJob, PdfOptions, PdfTaskRequest } from "../pdf-reading/types";
import { PiPdfReadingSecurity, createPdfReadingTools } from "../harness/pi-native/pi-pdf-reading-tools";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { assertTaskResumeToolAllowed, prepareTaskResumeSafety, readTaskResumeSafety, type TaskResumeSafetySnapshot } from "../plugin/task-resume-safety";
import { paidTestAccess } from "./membership-access";
import { unavailableCapabilityAccess } from "../membership/access";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";

const bytes = new TextEncoder().encode("%PDF- official PDF fixture");
const fingerprint = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
class FixtureFiles implements PdfFiles {
  writes: string[] = [];
  constructor(readonly root: string) {}
  absolute(relative: string) {
    if (relative.startsWith("/") || relative.split("/").some(part => part === ".." || part === ".") || relative.includes("\\")) throw new Error("unsafe fixture path");
    return path.join(this.root, relative);
  }
  async exists(relative: string) { try { await access(this.absolute(relative)); return true; } catch { return false; } }
  async read(relative: string) { return await readFile(this.absolute(relative), "utf8"); }
  async readBinary(relative: string) { return new Uint8Array(await readFile(this.absolute(relative))); }
  async create(relative: string, value: string | Uint8Array) {
    await mkdir(path.dirname(this.absolute(relative)), { recursive: true });
    await writeFile(this.absolute(relative), value, { flag: "wx" }); this.writes.push(relative);
  }
  async replace(relative: string, value: string, expected?: string) {
    if (expected !== undefined) assert.equal(await this.read(relative), expected);
    await writeFile(this.absolute(relative), value); this.writes.push(relative);
  }
  async listJobs() {
    try { return (await readdir(this.absolute("state"))).filter(name => name.endsWith(".json")).map(name => name.slice(0, -5)); }
    catch { return []; }
  }
  roots() { return ["Raw", "Wiki"]; }
}
export async function pdfToolFixture(root: string, selected: Partial<PdfOptions> = {}) {
  await mkdir(root, { recursive: true });
  const files = new FixtureFiles(root);
  const run = { vaultId: "pdf-tools", conversationId: "pdf-task", piSessionId: "pdf-session", productRunId: "run-1" };
  let paid = true, accepted = true, allowed = true, available = true, engineCalls = 0, modelCalls = 0, consumes = 0, confirms = 0;
  let localFailure = false, documentsAvailable = true;
  let permission: PiWorkspaceAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
  let onConfirm: (() => Promise<void>) | undefined;
  let remote: MinerTransport | undefined;
  let toolPolicy: ((name: string, args: Record<string, unknown>, target?: unknown) => void | Promise<void>) | undefined;
  const deliveryJobs: string[] = [];
  const sourceOptions: PdfOptions = { engine: "local", reading: false, summary: true, translation: false, translationLanguage: "中文", wiki: true, ...selected };
  let request: PdfTaskRequest | undefined = { jobId: "frozen-pdf-job", attachmentId: "pdf-00000000-0000-0000-0000-000000000001", name: "Selected.pdf",
    sourceFingerprint: fingerprint(bytes), byteLength: bytes.length, originalDirectory: "Raw", options: sourceOptions };
  const document = { transport: "tool_reference", attachmentId: request.attachmentId, attachment: { name: request.name }, sha256: fingerprint(bytes), bytes: new Uint8Array(bytes) };
  const productAccess = { ...paidTestAccess, checkCapability: (capability: Parameters<typeof paidTestAccess.checkCapability>[0]) => paid ? paidTestAccess.checkCapability(capability) : unavailableCapabilityAccess.checkCapability(capability),
    requireCapability: (capability: Parameters<typeof paidTestAccess.requireCapability>[0]) => { if (!paid) unavailableCapabilityAccess.requireCapability(capability); } };
  let service = new PdfReadingService(files, "state", { access: productAccess, enabled: () => available, sourceDirectory: () => "Raw", originalDirectory: () => "Raw",
    validateOriginalDirectory: async directory => { if (directory !== "Raw") throw new Error("agent_directory_scope_denied"); }, canWriteKnowledge: () => true,
    local: async () => { engineCalls++; if (localFailure) throw new Error("fixture extraction failed after original save"); return { pages: [{ number: 1, markdown: "The fixture document presents a single claim." }], images: [], warnings: [], engine: "local" }; },
    enhanced: async (job, input, signal, persist, progress) => {
      engineCalls++; return await extractMinerPdf(job, input, "fixture-token", signal, persist, progress, remote!);
    }, generator: () => ({ maxSourceCharacters: 1000, generate: async () => { modelCalls++; return "A concise analysis with evidence and limitations."; } }) });
  const storageRootPath = path.join(root, ".pi");
  const approvals = new FileApprovalTicketStore({ storageRootPath, vaultId: run.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath, vaultId: run.vaultId });
  await approvals.initialize(); await receipts.initialize();
  let safety: TaskResumeSafetySnapshot | undefined;
  let sequence = 0;
  const options = { host: () => ({ api: service, plugin: { settings: { pdfReading: { engine: "local", translationLanguage: "中文" } } } }) as never,
    access: () => permission, identity: () => run.productRunId, intentId: () => `${run.conversationId}:entry-1`, conversationId: () => run.conversationId,
    request: () => request, currentRunIdentity: () => run, approvals, receipts, userId: "user", deviceId: "device", documents: () => documentsAvailable ? [document] as never : [],
    consume: () => { consumes++; return { conversationId: run.conversationId, userEntryId: "entry-1" }; }, bindSources() {}, wikiPaths: async () => [],
    bindDeliveryJob: (id: string) => { deliveryJobs.push(id); },
    assertToolAllowed: async (name: string, args: Record<string, unknown>, target?: unknown, currentOperation?: { productRunId: string; toolCallId: string }) => {
      if (!allowed) throw new Error("agent_capability_denied");
      await toolPolicy?.(name, args, target);
      await assertTaskResumeToolAllowed({ snapshot: safety, receipts, approvals, vaultRootPath: root, toolName: name, arguments: args, resolvedTarget: target, currentOperation });
    }, confirmation: { confirm: async (input: any) => {
      confirms++; assert.equal(input.target.jobId, request?.jobId ?? input.target.jobId);
      if (input.target.originalPath) assert.equal(input.target.originalPath.split("/")[0], "Raw");
      assert.equal(input.preview.delivery.extract, true);
      assert.doesNotMatch(JSON.stringify(input), /official PDF fixture|fixture-token/);
      await onConfirm?.(); return accepted;
    } } };
  let security = new PiPdfReadingSecurity(options);
  let tools = createPdfReadingTools(security);
  const authorize = async (args: Record<string, unknown> = {}, name = "pdf_reading_process") => {
    const event = { type: "tool_call", toolCallId: `call-${++sequence}`, toolName: name, input: args } as any;
    return { event, blocked: await security.handleToolCall(event) };
  };
  const execute = async (event: any) => {
    const result = await tools[event.toolName === "pdf_reading_query" ? 0 : 1].execute(event.toolCallId, event.input, undefined, undefined);
    return await security.handleToolResult({ ...event, result } as never);
  };
  const invoke = async (args: Record<string, unknown> = {}, name = "pdf_reading_process") => {
    const call = await authorize(args, name); assert.equal(call.blocked, undefined, JSON.stringify(call.blocked)); return await execute(call.event);
  };
  const resumeInput = async () => {
    const catalog = new FileConversationCatalog({ storageRootPath, vaultId: run.vaultId });
    const productRuns = new FileProductRunStore({ storageRootPath, vaultId: run.vaultId, catalog });
    await catalog.initialize(); const timestamp = Date.now();
    await catalog.upsert({ vaultId: run.vaultId, conversationId: run.conversationId, piSessionId: run.piSessionId,
      title: "PDF task", status: "active", defaultMemoryMode: "normal", createdAt: timestamp, updatedAt: timestamp });
    await productRuns.create({ productRunId: run.productRunId, conversationId: run.conversationId, piSessionId: run.piSessionId,
      userEntryId: "entry-1", toolCallIds: [], memoryMode: "normal", state: "product_run_settled", terminalState: "cancelled",
      activeLeafId: null, createdAt: timestamp, updatedAt: timestamp, agentSettledAt: timestamp, settledAt: timestamp });
    return { receipts, approvals, catalog, productRuns, conversationId: run.conversationId, interruptedRunId: run.productRunId, vaultRootPath: root };
  };
  return { files, get service() { return service; }, approvals, receipts, run, document, options, authorize, execute, invoke, resumeInput, deliveryJobs,
    getSecurity: () => security, setToolPolicy: (value: typeof toolPolicy) => { toolPolicy = value; },
    counts: () => ({ engineCalls, modelCalls, consumes, confirms }), setPaid: (value: boolean) => { paid = value; }, setAvailable: (value: boolean) => { available = value; },
    setAccepted: (value: boolean) => { accepted = value; }, setAllowed: (value: boolean) => { allowed = value; },
    setPermission: (value: PiWorkspaceAccess) => { permission = value; }, setOnConfirm: (value?: () => Promise<void>) => { onConfirm = value; },
    setDocumentsAvailable: (value: boolean) => { documentsAvailable = value; }, setLocalFailure: (value: boolean) => { localFailure = value; },
    setRequest: (value: PdfTaskRequest | undefined) => { request = value; }, getRequest: () => structuredClone(request!), setTransport: (value: MinerTransport) => { remote = value; },
    restart: (snapshot?: TaskResumeSafetySnapshot) => { safety = snapshot; security = new PiPdfReadingSecurity(options); tools = createPdfReadingTools(security); },
    coldReopen: (snapshot?: TaskResumeSafetySnapshot) => { service = new PdfReadingService(files, "state", service.deps); safety = snapshot; security = new PiPdfReadingSecurity(options); tools = createPdfReadingTools(security); } };
}
const fixture = pdfToolFixture;

export async function runPdfNavigationToolTests(root: string): Promise<void> {
  const ordinary = await fixture(path.join(root, "ordinary-missing-job"), { reading: false, summary: false, wiki: false });
  ordinary.setRequest(undefined);
  assert.match((await ordinary.authorize({ jobId: "unknown-job" })).blocked!.reason, /PDF 任务不可用/);
  const missing = await ordinary.invoke({ jobId: "unknown-job" }, "pdf_reading_query");
  assert.equal(missing.isError, true); assert.doesNotMatch(missing.content[0].text, /ENOENT|\/Users\/|EchoInk-TestVaults/);
  assert.deepEqual(ordinary.files.writes, []);
  const denied = await fixture(path.join(root, "denied")); denied.setAccepted(false);
  assert.equal((await denied.authorize()).blocked?.reason, "approval_denied");
  assert.deepEqual(await denied.files.listJobs(), []); assert.deepEqual(denied.files.writes, []);
  assert.equal((await denied.receipts.listUiViews()).length, 0); assert.equal(denied.counts().engineCalls, 0);
  const pending = (await denied.approvals.listReadOnlyViews())[0]; assert.equal(pending.status, "denied");
  assert.match(JSON.stringify(pending.ticket.preview), /当前模型/);
  console.log("PASS official approval denial leaves no original, job, model or remote effect");

  const frozen = await fixture(path.join(root, "frozen"));
  for (const args of [{ reading: true }, { summary: false }, { jobId: frozen.getRequest().jobId, summary: false }, { translation: true }, { enhanced: true }, { attachmentId: "pdf-00000000-0000-0000-0000-000000000002" }, { path: "other.pdf" }]) {
    assert.match((await frozen.authorize(args)).blocked!.reason, /^pdf_task_(options|file)_mismatch$/);
  }
  assert.equal(frozen.counts().confirms, 0); assert.deepEqual(frozen.files.writes, []);
  frozen.setOnConfirm(async () => frozen.setRequest({ ...frozen.getRequest(), originalDirectory: "Outside" }));
  assert.equal((await frozen.authorize()).blocked?.reason, "pdf_task_context_changed"); assert.deepEqual(frozen.files.writes, []);
  console.log("PASS frozen file, independent outcomes and original directory cannot be silently overridden");

  for (const [index, reading, summary, translation] of [[0, false, false, false], [1, false, false, true], [2, true, false, false], [3, false, true, false], [4, true, true, false]] as const) {
    const f = await fixture(path.join(root, `outcome-${index}`), { reading, summary, translation, wiki: reading || summary });
    const result = await f.invoke(); assert.equal(result.isError, false, JSON.stringify(result));
    const job = await f.service.load(f.getRequest().jobId);
    assert.equal(job.options.reading, reading); assert.equal(job.options.summary, summary);
    assert.equal(f.counts().modelCalls, reading || summary || translation ? 1 : 0, "reading and summary share one internal analysis");
    assert.equal(await f.files.exists(job.original!.savedPath!), true);
    assert.deepEqual(await f.files.readBinary(job.original!.savedPath!), bytes);
    assert(job.artifacts.every(artifact => artifact.kind === "raw" || artifact.kind === "translation"), "no fabricated reading/summary artifact");
    if (reading || summary) assert.match(result.content[0].text, /尚未确认 Wiki，不能声称知识沉淀完成/);
    const receipt = (await f.receipts.listUiViews())[0].receipt!;
    assert.equal(receipt.status, "completed"); assert.equal(receipt.readback.readbackVerified, true);
    assert.match(JSON.stringify(receipt.readback.observedTargetVersion), new RegExp(fingerprint(bytes)));
    const originalWrites = f.files.writes.filter(name => name.endsWith(".pdf")).length;
    f.run.productRunId = "run-2"; f.restart(); await f.invoke();
    assert.equal(f.counts().engineCalls, 1); assert.equal(f.files.writes.filter(name => name.endsWith(".pdf")).length, originalWrites);
    assert.equal((await f.files.listJobs()).length, 1);
  }
  console.log("PASS extract/translation/reading/summary combinations, shared analysis, exact original receipt and same-job reuse");

  for (const includeOldAttachment of [false, true]) {
    const cold = await fixture(path.join(root, includeOldAttachment ? "cold-stale-attachment" : "cold-job-only"), { reading: false, summary: false, wiki: false });
    cold.setLocalFailure(true);
    assert.equal((await cold.invoke()).isError, true);
    const initial = await cold.service.load(cold.getRequest().jobId);
    assert.equal(initial.state, "failed"); assert(initial.original?.savedPath); assert.equal(initial.artifacts.length, 0);
    assert.equal((await cold.receipts.listUiViews())[0].receipt?.status, "completed", "the original receipt does not mean PDF processing completed");
    const coldSnapshot = await prepareTaskResumeSafety(await cold.resumeInput());
    assert.match(coldSnapshot.recoveryInstructions, /completed PDF receipt proves only the original and the files/);
    assert.match(coldSnapshot.recoveryInstructions, /pdf_reading_query\(jobId\)/);
    assert.match(coldSnapshot.recoveryInstructions, /same jobId to continue only unfinished stages/);
    assert.match(coldSnapshot.recoveryInstructions, /No temporary attachment is required/);
    assert.match(coldSnapshot.recoveryInstructions, /All other completed writes remain non-replayable/);
    cold.run.productRunId = "cold-run-2"; cold.setDocumentsAvailable(false); cold.document.bytes.fill(0); cold.setLocalFailure(false); cold.coldReopen(coldSnapshot);
    const before = cold.files.writes.length;
    const queried = await cold.invoke({ jobId: initial.id }, "pdf_reading_query");
    assert.equal(queried.isError, false); assert(queried.content[0].text.includes(initial.original.savedPath));
    assert.match(queried.content[0].text, /已保存并通过字节回读/);
    assert.match(queried.content[0].text, /pdf_reading_process\(\{"jobId":/);
    assert.match(queried.content[0].text, /不需要临时附件/);
    assert.equal(cold.files.writes.length, before, "query and original verification are read-only");
    const resumed = await cold.invoke({ jobId: initial.id, ...(includeOldAttachment ? { attachmentId: cold.getRequest().attachmentId } : {}) });
    assert.equal(resumed.isError, false, JSON.stringify(resumed));
    assert.equal((await cold.service.load(initial.id)).state, "completed"); assert.equal((await cold.files.listJobs()).length, 1);
    assert.equal(cold.files.writes.filter(name => name.endsWith(".pdf")).length, 1, "cold resume reuses the saved binary exactly once");
    assert.equal(cold.counts().consumes, 0, "no stale temporary attachment is consumed during original-only recovery");
    assert((await cold.authorize({ jobId: initial.id, attachmentId: "pdf-00000000-0000-0000-0000-000000000002" })).blocked);
    cold.setDocumentsAvailable(true); cold.document.bytes.set(bytes); cold.document.bytes[6] ^= 1;
    assert((await cold.authorize({ jobId: initial.id, attachmentId: cold.getRequest().attachmentId })).blocked, "real supplied bytes must still pass their fingerprint");
  }
  console.log("PASS cold P4 reopen: completed file-only receipt explains same-job continuation, query verifies original, no temporary bytes are required, stale exact attachment ID falls back safely");

  const p4 = await fixture(path.join(root, "p4")); await p4.invoke();
  const input = await p4.resumeInput(); const snapshot = await readTaskResumeSafety(input);
  assert(snapshot.fileVersions.some(file => file.relativePath.endsWith(".pdf") && file.expectedVersion === fingerprint(bytes)));
  assert(snapshot.pdfOperations.some(operation => operation.jobId === p4.getRequest().jobId), "durable approved job is discoverable without session arguments");
  p4.run.productRunId = "run-2"; p4.restart(snapshot); await p4.invoke();
  assert.equal(p4.counts().engineCalls, 1, "P4 permits same-job readback without re-extraction");
  const job = await p4.service.load(p4.getRequest().jobId);
  await writeFile(p4.files.absolute(job.original!.savedPath!), "%PDF- changed outside task");
  const changed = await readTaskResumeSafety(input); assert(changed.fileConflicts.some(file => file.relativePath === job.original!.savedPath));
  assert((await p4.authorize()).blocked); assert.equal(p4.counts().engineCalls, 1);
  console.log("PASS P4 records original/artifact versions, resumes exact job and blocks changed originals");

  const crash = await fixture(path.join(root, "crash-original"), { reading: false, summary: false, wiki: false });
  const authorized = await crash.authorize(); assert.equal(authorized.blocked, undefined);
  const row = (await crash.receipts.listUiViews())[0], journal = (await crash.receipts.readOperation(row.operationIdentity))!;
  const target = journal.resolvedTarget as { originalPath: string };
  await crash.receipts.markEffectStarted(row.operationIdentity);
  await crash.files.create(target.originalPath, bytes);
  const crashInput = await crash.resumeInput();
  const recovered = await prepareTaskResumeSafety(crashInput);
  assert.equal(recovered.operations[0].status, "completed");
  assert(recovered.fileVersions.some(file => file.relativePath === target.originalPath && file.expectedVersion === fingerprint(bytes)));
  assert.deepEqual(recovered.fileConflicts, []); assert.equal(crash.counts().engineCalls, 0, "recovery itself performs no extraction");
  console.log("PASS crash-window original receipt recovered by exact local readback, with no effect replay");

  const remote = await fixture(path.join(root, "unknown-upload"), { engine: "mineru", reading: false, summary: false, wiki: false });
  const methods: string[] = [];
  const archive = zipSync({ "content_list.json": strToU8(JSON.stringify([{ type: "text", page_idx: 0, text: "Remote evidence" }])) });
  remote.setTransport({ wait: async () => {}, request: async (url, method) => {
    methods.push(method);
    if (method === "POST") return { status: 200, json: { code: 0, data: { batch_id: "batch-only-once", file_urls: ["https://upload.example/pdf"] } } };
    if (method === "PUT") throw new Error("uncertain-upload-timeout");
    if (url.includes("extract-results")) return { status: 200, json: { code: 0, data: { extract_result: [{ state: "done", data_id: remote.getRequest().jobId, full_zip_url: "https://download.example/result" }] } } };
    return { status: 200, bytes: new Uint8Array(archive).buffer };
  } });
  const first = await remote.invoke(); assert.equal(first.isError, true);
  assert.equal((await remote.service.load(remote.getRequest().jobId)).uploadState, "uncertain");
  const remoteSnapshot = await readTaskResumeSafety(await remote.resumeInput()); remote.run.productRunId = "run-2"; remote.restart(remoteSnapshot);
  assert.equal((await remote.invoke()).isError, false); assert.equal(methods.filter(method => method === "POST").length, 1); assert.equal(methods.filter(method => method === "PUT").length, 1);
  assert.equal(remote.files.writes.filter(name => name.endsWith(".pdf")).length, 1);
  assert.match(JSON.stringify((await remote.approvals.listReadOnlyViews())[0].ticket.preview), /MinerU/);
  console.log("PASS uncertain enhanced upload resumes the saved batch with zero repeated POST/PUT");

  const legacy = await fixture(path.join(root, "legacy-unknown-upload"), { engine: "mineru", reading: false, summary: false, wiki: false });
  legacy.setRequest(undefined);
  const legacyJob: PdfJob = { version: 1, id: "legacy-unknown", name: "Legacy.pdf", createdAt: 1,
    options: { engine: "mineru", reading: false, summary: false, translation: false, translationLanguage: "中文", wiki: false },
    state: "failed", stage: "等待核对原上传", sourceFingerprint: fingerprint(bytes), batchId: "legacy-exact-batch", uploadState: "uncertain",
    rawDirectory: "Raw", artifacts: [], pages: [], chunks: [], warnings: [], published: {} };
  await legacy.files.create("state/legacy-unknown.json", JSON.stringify(legacyJob));
  let firstPoll = true; const legacyRequests: Array<{ url: string; method: string }> = [];
  legacy.setTransport({ wait: async () => {}, request: async (url, method) => {
    legacyRequests.push({ url, method }); assert.equal(method, "GET", "uncertain legacy upload may only query/download the saved batch");
    if (firstPoll) { firstPoll = false; throw new Error("query-temporarily-unavailable"); }
    if (url.includes("extract-results")) return { status: 200, json: { code: 0, data: { extract_result: [{ state: "done", data_id: legacyJob.id, full_zip_url: "https://download.example/legacy" }] } } };
    return { status: 200, bytes: new Uint8Array(archive).buffer };
  } });
  assert.equal((await legacy.invoke({ jobId: legacyJob.id })).isError, true);
  assert.equal((await legacy.receipts.listUiViews())[0].receipt?.status, "uncertain", "legacy job has neither original nor completed Raw proof");
  const legacySnapshot = await readTaskResumeSafety(await legacy.resumeInput()); legacy.run.productRunId = "run-2"; legacy.restart(legacySnapshot);
  assert.equal((await legacy.invoke({ jobId: legacyJob.id })).isError, false);
  assert(legacyRequests.filter(request => request.url.includes("extract-results")).every(request => request.url.endsWith("legacy-exact-batch")));
  assert.equal(legacy.files.writes.filter(name => name.endsWith(".pdf")).length, 0, "old jobs do not backfill an original");
  console.log("PASS uncertain legacy receipt permits only the exact durable MinerU batch poll; no original backfill or upload replay");

  for (const [name, mutate] of [
    ["readonly", (f: Awaited<ReturnType<typeof fixture>>) => f.setPermission({ permission: "read-only", mode: "agent", memoryMode: "normal" })],
    ["plan", (f: Awaited<ReturnType<typeof fixture>>) => f.setPermission({ permission: "workspace-write", mode: "plan", memoryMode: "normal" })],
    ["pro", (f: Awaited<ReturnType<typeof fixture>>) => f.setPaid(false)],
    ["capability", (f: Awaited<ReturnType<typeof fixture>>) => f.setAllowed(false)],
    ["disabled", (f: Awaited<ReturnType<typeof fixture>>) => f.setAvailable(false)]
  ] as const) {
    const f = await fixture(path.join(root, name)); mutate(f); assert((await f.authorize()).blocked); assert.deepEqual(f.files.writes, []);
    if (name !== "capability") assert.equal((await f.invoke({}, "pdf_reading_query")).isError, false, "history remains readable without write/model access");
  }
  const revoked = await fixture(path.join(root, "revoked")); const call = await revoked.authorize();
  assert.equal(call.blocked, undefined); revoked.setPaid(false); await revoked.execute(call.event); assert.deepEqual(revoked.files.writes, []);
  const moved = await fixture(path.join(root, "source-changed")); const approved = await moved.authorize();
  moved.document.bytes[6] ^= 1; assert.equal((await moved.execute(approved.event)).isError, true); assert.deepEqual(moved.files.writes, []);
  console.log("PASS permission/PRO/global switch and capability checks survive approval-to-write changes; histories remain read-only");

  // The old desktop chat path has no host navigation request, but still gets the
  // controller's desktop original policy and the official approval boundary.
  const chat = await fixture(path.join(root, "desktop-chat"), { reading: false, summary: false, wiki: false }); chat.setRequest(undefined);
  await chat.invoke({ attachmentId: chat.document.attachmentId, reading: false });
  const chatJob = (await chat.service.history())[0]; assert(chatJob.original?.savedPath); assert.equal(chatJob.conversationId, chat.run.conversationId);
  assert.deepEqual(chat.deliveryJobs, [chatJob.id], "legacy chat process participates in the formal delivery gate");
  await chat.invoke({}, "pdf_reading_query"); assert.equal(chat.deliveryJobs.length, 1, "listing history cannot bind unrelated delivery work");
  await chat.invoke({ jobId: chatJob.id }, "pdf_reading_query"); assert.equal(chat.deliveryJobs.length, 2, "explicit own-job query restores delivery verification");
  await chat.files.replace(`state/${chatJob.id}.json`, JSON.stringify({ ...chatJob, conversationId: "another-task" }));
  await chat.invoke({ jobId: chatJob.id }, "pdf_reading_query"); assert.equal(chat.deliveryJobs.length, 2, "querying another task never binds its work");
  console.log("PASS legacy desktop chat upload also saves its original through the formal policy");
}
