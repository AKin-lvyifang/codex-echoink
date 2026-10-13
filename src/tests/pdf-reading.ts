import { pdfReadingPage } from "../pdf-reading/reading-page";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { extractLocalPdf } from "../pdf-reading/local-extractor";
import { extractMinerPdf, parseMinerPackage, type MinerTransport } from "../pdf-reading/mineru";
import { PdfReadingService } from "../pdf-reading/service";
import type { PdfFiles, PdfJob, PdfOptions } from "../pdf-reading/types";
import { pdfNoteLink, pdfResultsTable } from "../pdf-reading/results";
import { splitVaultNoteLinkSegments } from "../core/vault-note-links";
import { splitMessageTableRow } from "../ui/render-message";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { piWorkspaceAllowsTool } from "../harness/pi-native/pi-workspace-access";
import { PiPdfReadingSecurity } from "../harness/pi-native/pi-pdf-reading-tools";
import { Modal } from "obsidian";
import { JSDOM } from "jsdom";
import { isPdfReadingIntent } from "../pdf-reading/intent";
import { pdfLanguage, pdfSourceLanguage } from "../pdf-reading/language";
import { buildPiDocumentContextMessage, buildPiDocumentProviderContext } from "../harness/pi-native/pi-document-context";
import { preparePiChatDocuments } from "../ui/codex-view/pi-document-input";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { recordPiDocumentReplayForEntry } from "../ui/codex-view/pi-conversation-support";

class MemoryFiles implements PdfFiles {
  data = new Map<string, string | Uint8Array>();
  async exists(path: string) { return this.data.has(path); }
  async read(path: string) { const value = this.data.get(path); if (typeof value !== "string") throw new Error("missing"); return value; }
  async create(path: string, value: string | Uint8Array) { assert(!this.data.has(path)); this.data.set(path, value); }
  async replace(path: string, value: string, expected?: string) { if (expected !== undefined) assert.equal(this.data.get(path), expected); this.data.set(path, value); }
  async listJobs() { return [...this.data.keys()].filter(path => path.startsWith("state/")).map(path => path.slice(6, -5)); }
  roots() { return ["原始资料（raw）", "输出（outputs）"]; }
}
const pdf = new TextEncoder().encode("%PDF- fixture");
const options: PdfOptions = { engine: "local", reading: false, translation: true, translationLanguage: "英文", wiki: false };
export async function runPdfReadingTests(): Promise<void> {
  const bytes = new Uint8Array(await readFile("src/tests/fixtures/pdf/bilingual-multipage.pdf"));
  const local = await extractLocalPdf(bytes, new AbortController().signal, () => {}, undefined, async () => new Uint8Array([1, 2]));
  assert.deepEqual(local.pages.map(page => page.number), [1, 2]);
  assert(local.pages[0].markdown.includes("中文第一页")); assert.equal(local.images.length, 2);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  console.log("PASS real PDF.js pagination (page rasterizer fixture, native rendering separate)");

  const packageBytes = zipSync({ "sample/sample_content_list.json": strToU8(JSON.stringify([
    { type: "text", page_idx: 0, text: "第一章" }, { type: "equation", page_idx: 0, img_path: "images/e.png" },
    { type: "chart", page_idx: 1, img_path: "images/e.png", chart_caption: ["图表"] },
    { type: "code", page_idx: 1, code_body: "x = 1", code_caption: ["code title"], code_footnote: ["code note"] }, { type: "table", page_idx: 1, table_body: "<table><tr><td>1</td></tr></table>" }
  ])), "sample/images/e.png": new Uint8Array([1, 2, 3]) });
  const parsed = parseMinerPackage(packageBytes);
  assert.equal(parsed.images.length, 1); assert(parsed.pages[0].markdown.includes("![]"));
  assert(parsed.pages[1].markdown.includes("x = 1")); assert(parsed.pages[1].markdown.includes("code title")); assert(parsed.pages[1].markdown.includes("code note")); assert(parsed.pages[1].markdown.includes("<table>"));
  assert.throws(() => parseMinerPackage(zipSync({ "full.md": strToU8("No pages") })), /真实页码/u);
  assert.throws(() => parseMinerPackage(zipSync({ "content_list.json": strToU8('[{"type":"text","text":"no page"}]') })), /真实页码/u);

  const files = new MemoryFiles(); let access = true, generated = 0, fail = true;
  const service = new PdfReadingService(files, "state", { enabled: () => true,
    access: { checkCapability: () => access, requireCapability: () => { if (!access) throw new Error("Pro expired"); }, subscribe: () => () => {} },
    local: async () => ({ pages: [{ number: 1, markdown: "One" }, { number: 2, markdown: "Two" }], images: [], warnings: [], engine: "local" }), enhanced: async () => parsed,
    generator: () => ({ maxSourceCharacters: 1000, generate: async () => { generated++; if (fail && generated === 2) throw new Error("fixture failure"); return "摘要与证据"; } }) });
  const job = await service.start("研究 中文.pdf", pdf, options, undefined, "operation-one");
  assert.equal(job.state, "partial"); assert.equal(job.artifacts.length, 2);
  assert.equal(generated, 2); assert.equal(new TextDecoder().decode(pdf), "%PDF- fixture");
  const firstOutput = job.artifacts.find(item => item.kind === "translation")!.path;
  files.data.set(firstOutput, "用户编辑"); fail = false;
  const resumed = await service.resume(job.id);
  assert.equal(resumed.state, "completed"); assert.equal(generated, 3, "successful chunks are not regenerated");
  assert.equal(await files.read(firstOutput), "用户编辑"); assert.notEqual(resumed.artifacts.find(item => item.kind === "translation")!.path, firstOutput);
  const before = files.data.size; await service.resume(job.id); assert.equal(files.data.size, before); assert.equal(generated, 3);
  await service.start("研究 中文.pdf", pdf, options, undefined, "operation-one"); assert.equal(files.data.size, before, "same agent intent returns durable receipt");
  access = false; await service.resume(job.id); assert.equal(generated, 3); assert((await service.history()).length > 0, "expired access remains readable without model");
  access = true; let calls = 0;
  service.deps.generator = () => ({ maxSourceCharacters: 1000, generate: async () => { calls++; access = false; return "授权请求已生成的结果"; } });
  const expired = await service.start("expired.pdf", pdf, options);
  assert.equal(calls, 1); assert.equal(expired.state, "partial"); assert(expired.artifacts.some(item => item.kind === "translation"));
  // A successful model chunk survives an output write failure, a fresh service,
  // expired Pro and a missing Provider. Only the saved chunk is recovered.
  const recoveryFiles = new MemoryFiles(); let saveFails = true, recoveryPaid = true, recoveryCalls = 0;
  const originalCreate = recoveryFiles.create.bind(recoveryFiles);
  recoveryFiles.create = async (path, value) => { if (saveFails && path.includes("译文")) throw new Error("disk write failed"); await originalCreate(path, value); };
  const recoveryDeps = { ...service.deps, access: { ...service.deps.access, checkCapability: () => recoveryPaid },
    local: async () => ({ pages: [{ number: 1, markdown: "original" }], images: [], warnings: [], engine: "local" as const }),
    generator: () => ({ maxSourceCharacters: 1000, generate: async () => { recoveryCalls++; return "saved generated chunk"; } }) };
  const interrupted = await new PdfReadingService(recoveryFiles, "state", recoveryDeps).start("recover.pdf", pdf, options);
  assert.equal(interrupted.state, "partial"); assert.equal(recoveryCalls, 1);
  saveFails = false; recoveryPaid = false;
  const reopened = new PdfReadingService(recoveryFiles, "state", { ...recoveryDeps, generator: () => { throw new Error("Provider unavailable"); } });
  const recovered = await reopened.resume(interrupted.id);
  assert.equal(recovered.state, "completed"); assert.equal(recoveryCalls, 1);
  const recoveredPath = recovered.artifacts.find(item => item.kind === "translation")!.path;
  assert((await recoveryFiles.read(recoveredPath)).includes("saved generated chunk"));
  await reopened.resume(interrupted.id); assert.equal(recoveryCalls, 1);
  const aborted = new AbortController(); aborted.abort();
  access = true;
  const cancelled = await service.start("cancel.pdf", pdf, options, aborted.signal);
  assert.equal(cancelled.state, "cancelled");
  assert.match((await service.resume(cancelled.id)).error!, /重新选择/u);
  const recoveredInput = await service.resume(cancelled.id, undefined, pdf);
  assert(recoveredInput.pages.length > 0); assert(recoveredInput.artifacts.some(item => item.kind === "raw"));
  await assert.rejects(service.resume(cancelled.id, undefined, new TextEncoder().encode("%PDF- different")), /同一 PDF/u);
  access = true;
  console.log("PASS save-only recovery after restart with expired Pro and unavailable Provider; cancelled task state");
  console.log("PASS save, partial retry, edited output preservation, duplicate receipt, Pro expiry and readable history");

  const sourceFiles = new MemoryFiles(); let sourceCalls = 0;
  const sourceService = new PdfReadingService(sourceFiles, "state", { ...recoveryDeps, access: service.deps.access,
    generator: () => ({ maxSourceCharacters: 1000, generate: async () => { sourceCalls++; throw new Error("pause before generation"); } }) });
  const changedSource = await sourceService.start("source.pdf", pdf, options);
  const sourcePath = changedSource.artifacts[0].path, originalSource = await sourceFiles.read(sourcePath);
  sourceFiles.data.set(sourcePath, originalSource.replace("original", "edited source"));
  const sourceRetry = await sourceService.resume(changedSource.id);
  assert.match(sourceRetry.error!, /正文已编辑/u); assert.equal(sourceCalls, 1);
  sourceFiles.data.delete(sourcePath);
  assert.match((await sourceService.resume(changedSource.id)).error!, /移动或删除/u); assert(!sourceFiles.data.has(sourcePath));
  sourceFiles.data.set(sourcePath, originalSource.replace("source_type:", "tags: [reviewed]\nsource_type:"));
  await sourceService.resume(changedSource.id); assert.equal(sourceCalls, 2, "Raw metadata maintenance does not invalidate unchanged source pages");
  console.log("PASS changed/deleted Raw blocks stale generation while metadata edits preserve source identity");

  const remote = { ...job, batchId: undefined, uploadUrl: undefined, uploadState: undefined } as PdfJob;
  const requests: { method: string; url: string; headers?: Record<string, string> }[] = [];
  const transport: MinerTransport = { wait: async () => {}, request: async (url, method, headers) => {
    requests.push({ url, method, headers });
    if (method === "POST") return { status: 200, json: { code: 0, data: { batch_id: "batch-1", file_urls: ["https://upload.example/file"] } } };
    if (method === "PUT") throw new Error("upload timeout");
    if (url.includes("extract-results")) return { status: 200, json: { code: 0, data: { extract_result: [{ state: "done", data_id: remote.id, full_zip_url: "https://download.example/result.zip" }] } } };
    return { status: 200, bytes: new Uint8Array(packageBytes).buffer };
  } };
  await assert.rejects(extractMinerPdf(remote, pdf, "dedicated-token", new AbortController().signal, async () => {}, () => {}, transport), /timeout/u);
  assert.equal(remote.uploadState, "uncertain");
  await extractMinerPdf(remote, undefined, "dedicated-token", new AbortController().signal, async () => {}, () => {}, transport);
  assert.equal(requests.filter(item => item.method === "PUT").length, 1);
  assert.equal(requests.filter(item => item.method === "POST").length, 1);
  for (const request of requests.filter(item => !item.url.startsWith("https://mineru.net/"))) assert.equal(request.headers?.Authorization, undefined);
  remote.uploadState = "prepared"; remote.uploadUrl = "https://upload.example/file";
  await assert.rejects(extractMinerPdf(remote, undefined, "token", new AbortController().signal, async () => {}, () => {}, transport), /重新选择同一/u);
  const preparedTransport: MinerTransport = { ...transport, request: async (url, method, headers, body) => method === "PUT" ? { status: 200 } : transport.request(url, method, headers, body) };
  await extractMinerPdf(remote, pdf, "token", new AbortController().signal, async () => {}, () => {}, preparedTransport);
  assert.equal(remote.uploadState, "uploaded");
  console.log("PASS MinerU protocol, protected upload headers, uncertain upload no retry, prepared task recovery, structure/image conversion");

  const path = "原始资料（raw）/PDF/中文 空格|管道 (draft)/译文（英文）.md";
  const table = pdfResultsTable([{ kind: "translation", path }]);
  const cells = splitMessageTableRow(table.split("\n")[2]); assert.equal(cells.length, 3); assert.equal(cells[2], `\`${path}\``);
  const link = splitVaultNoteLinkSegments(pdfNoteLink(path, "精读笔记")); assert.equal(link[0].kind, "noteLink");
  assert.equal(link[0].kind === "noteLink" && link[0].targetPath, path);
  const source = splitVaultNoteLinkSegments(pdfNoteLink("原始资料（raw）/PDF/中文/原文.md#第 2 页", "来源"))[0];
  assert.equal(source.kind === "noteLink" && source.heading, "第 2 页");

  const testRoot = process.env.ECHOINK_PDF_TEST_ROOT!;
  if (!testRoot || !testRoot.startsWith("/") || !testRoot.endsWith("/.tests/pdf-reading-index")) throw new Error("explicit disposable test root required");
  await mkdir(`${testRoot}/输出（outputs）/PDF/研究`, { recursive: true });
  await mkdir(`${testRoot}/原始资料（raw）/PDF/研究`, { recursive: true });
  const raw = "原始资料（raw）/PDF/研究/原文.md", output = "原始资料（raw）/PDF/研究/译文（英文）.md";
  await writeFile(`${testRoot}/${raw}`, "# 原文\n研究量子");
  await writeFile(`${testRoot}/${output}`, `---\nsource_type: ai_translation\n---\n# 量子研究\n${pdfNoteLink(raw, "来源")}\n生成成果`);
  const index = new KnowledgeAgentIndex({ vaultPath: testRoot, storageRootPath: `${testRoot}/.index` });
  await index.refresh(); const hits = await index.search({ query: "量子", kinds: ["raw"] });
  assert.equal(hits.hits.length, 2); assert(hits.hits.some(h => h.vaultRelativePath === output)); assert(hits.hits.every(h => h.kind === "raw"));
  await rm(testRoot, { recursive: true });
  const readAccess = { permission: "read-only" as const, mode: "chat" as const, memoryMode: "normal" as const, planToolNames: ["pdf_reading_query"], memoryToolNames: [], externalReadToolNames: [] };
  assert(!piWorkspaceAllowsTool({ ...readAccess, toolName: "pdf_reading_process" }));
  assert(piWorkspaceAllowsTool({ ...readAccess, toolName: "pdf_reading_query" }));
  const security = new PiPdfReadingSecurity({ host: () => null, access: () => readAccess, identity: () => "run", intentId: () => "intent", documents: () => [], consume: () => null, bindSources: () => {}, wikiPaths: async () => [] });
  const denied = await security.handleToolCall({ type: "tool_call", toolCallId: "denied", toolName: "pdf_reading_process", input: { path: "source.pdf" } } as never);
  assert(denied?.block);
  await runPdfSecurityTests(job);
  const internal = await service.start("reading.pdf", pdf, { ...options, reading: true, translation: false });
  assert.equal(internal.artifacts.length, 1); assert(internal.chunks.some(c => c.reading));
  assert(![...files.data.keys()].some(path => path.startsWith("输出")), "no Outputs reading or translation");
  await runPdfAttachmentTests();
  console.log("PASS actual bilingual links, headings, pipe table cells, Raw translation index/source nature, read-only tool guard");
}

async function runPdfSecurityTests(base: PdfJob): Promise<void> {
  const dom = new JSDOM(); const previousDocument = globalThis.document, originalOpen = Modal.prototype.open;
  globalThis.document = dom.window.document;
  let permission = "write", mode = "chat", approved = true, afterConfirm = () => {}, confirmation = "", executions = 0, readFails = false, missingArtifact = false;
  let current = structuredClone(base);
  // Drive the real confirmation boundary with an explicit user-decision fixture.
  Modal.prototype.open = function () { const modal = this as unknown as { bodyText: string; done(value: boolean): void }; confirmation = modal.bodyText; afterConfirm(); modal.done(approved); };
  const security = new PiPdfReadingSecurity({ host: () => ({ plugin: { app: {}, settings: { pdfReading: { engine: "local", translationLanguage: "中文" } } },
    api: { files: { exists: async () => true, read: async () => "# saved" }, load: async () => current, history: async () => [current], resume: async () => { executions++; return current; }, actualArtifacts: async () => { if (readFails) throw new Error("readback failed"); return missingArtifact ? current.artifacts.filter(a => a.kind !== "translation") : current.artifacts; } },
    processVault: async () => { executions++; return current; }
  }) as never, access: () => ({ permission, mode }) as never, identity: () => "run", intentId: () => "intent", documents: () => [], consume: () => null, bindSources: () => {}, wikiPaths: async () => [] });
  let sequence = 0;
  const call = (input: object, name = "pdf_reading_process") => ({ type: "tool_call", toolCallId: `case-${++sequence}`, toolName: name, input });
  const receipt = (event: ReturnType<typeof call>) => security.handleToolResult(event as never);
  try {
    for (const state of ["completed", "partial", "failed", "cancelled"] as const) {
      current = { ...structuredClone(base), state };
      const event = call({ path: "source.pdf" }); assert.equal(await security.handleToolCall(event as never), undefined);
      await security.execute(event.toolCallId, event.toolName, event.input);
      const result = await receipt(event); assert.equal(result.isError, state !== "completed");
      assert.equal(result.details.status, state); assert.equal(result.details.readbackVerified, true);
      await assert.rejects(security.execute(event.toolCallId, event.toolName, event.input), /authorization_failed/u);
    }
    current.options = { engine: "mineru", reading: true, translation: false, wiki: false };
    const resume = call({ jobId: current.id }); await security.handleToolCall(resume as never);
    assert.match(confirmation, /MinerU/u); assert.match(confirmation, /当前模型/u);
    assert((await security.handleToolCall(call({ jobId: current.id, enhanced: false }) as never))?.block);
    afterConfirm = () => { permission = "read-only"; };
    assert((await security.handleToolCall(call({ path: "source.pdf" }) as never))?.block);
    afterConfirm = () => {}; permission = "write";
    const delayed = call({ path: "source.pdf" }); await security.handleToolCall(delayed as never);
    const before = executions; permission = "read-only";
    await security.execute(delayed.toolCallId, delayed.toolName, delayed.input);
    assert.equal(executions, before); assert((await receipt(delayed)).isError);
    permission = "write"; mode = "plan";
    assert((await security.handleToolCall(call({ path: "source.pdf" }) as never))?.block);
    mode = "chat"; approved = false;
    assert((await security.handleToolCall(call({ path: "source.pdf" }) as never))?.block);
    approved = true; readFails = true;
    const unreadable = call({}, "pdf_reading_query"); await security.handleToolCall(unreadable as never);
    await security.execute(unreadable.toolCallId, unreadable.toolName, unreadable.input);
    const unreadableResult = await receipt(unreadable); assert(unreadableResult.isError); assert.equal(unreadableResult.details.readbackVerified, false);
    readFails = false; missingArtifact = true; current = { ...structuredClone(base), state: "completed" };
    const incompleteReadback = call({ path: "source.pdf" }); await security.handleToolCall(incompleteReadback as never);
    await security.execute(incompleteReadback.toolCallId, incompleteReadback.toolName, incompleteReadback.input);
    const incompleteResult = await receipt(incompleteReadback);
    assert(incompleteResult.isError); assert.equal(incompleteResult.details.readbackVerified, false);
    assert.match(incompleteResult.content[0].text, /未全部通过回读/u);
    missingArtifact = false; current.warnings = ["长正文".repeat(10000)];
    const long = call({}, "pdf_reading_query"); await security.handleToolCall(long as never);
    await security.execute(long.toolCallId, long.toolName, long.input);
    assert.equal((await receipt(long)).details.truncated, true);
    current.warnings = []; current.options.reading = true;
    current.chunks = [{ page: 1, part: 1, source: "fixture", reading: "长篇中文精读🧪".repeat(4500) }];
    const expectedReading = `第 1 页 · 片段 1\n${current.chunks[0].reading}`;
    let offset = 0, delivered = "";
    while (true) {
      const pageCall = call({ jobId: current.id, readingOffset: offset }, "pdf_reading_query");
      await security.handleToolCall(pageCall as never); await security.execute(pageCall.toolCallId, pageCall.toolName, pageCall.input);
      const pageResult = await receipt(pageCall); assert.equal(pageResult.details.truncated, false);
      const pageText = pageResult.content[0].text; delivered += pageText.slice(pageText.indexOf("\n\n") + 2);
      const next = /nextOffset=(\d+|null)/u.exec(pageText)![1]; if (next === "null") break; offset = Number(next);
    }
    assert.equal(delivered, expectedReading, "secured tool pages deliver complete Chinese reading including surrogate pairs");
    console.log("PASS Agent terminal status, historical recipient confirmation, permission rechecks, single consumption, readback failure and truncation metadata");
  } finally { Modal.prototype.open = originalOpen; globalThis.document = previousDocument; dom.window.close(); }
}

async function runPdfAttachmentTests(): Promise<void> {
  const longReading = "中文长篇精读🧪\n".repeat(4000);
  let offset = 0, reconstructed = "";
  do { const page = pdfReadingPage(longReading, offset); assert(Buffer.byteLength(page.text, "utf8") <= 10000); reconstructed += page.text; if (page.nextOffset === null) break; assert(page.nextOffset > offset); offset = page.nextOffset; } while (true);
  assert.equal(reconstructed, longReading, "UTF-8 pagination delivers every character without gaps");
  for (const text of ["提取这个", "帮我精读这篇论文", "翻译这份文档", "PDF 精读：提取原文", "extract this PDF"]) assert(isPdfReadingIntent(text, true), text);
  for (const text of ["这篇 PDF 的结论是什么？", "如何提取 PDF？", "不要翻译这份 PDF", "解释第三页"]) assert(!isPdfReadingIntent(text, true), text);
  assert(!isPdfReadingIntent("提取这个", false));
  assert.equal(pdfLanguage("English"), "英文");
  const english = "This is the book and the paper. The book is for the reader and the method is from this study.";
  assert.equal(pdfSourceLanguage(english), "英文");
  assert.equal(pdfSourceLanguage("研究方法実験結果論文資料分析知識原文日本語漢字二十個以上これは日本語です"), "未确定");
  const files = new MemoryFiles(); let generated = 0;
  const service = new PdfReadingService(files, "state", { enabled: () => true, access: { checkCapability: () => true } as never,
    local: async () => ({ pages: [{ number: 1, markdown: english }], images: [], warnings: [], engine: "local" }), enhanced: async () => { throw new Error("unused"); }, generator: () => ({ maxSourceCharacters: 1000, generate: async () => { generated++; return "unused"; } }) });
  let turnModelCalls = 0;
  const selectedTurnModel = () => ({ maxSourceCharacters: 1000, generate: async () => { turnModelCalls++; return "本轮 B 模型精读"; } });
  const selectedJob = await service.start("selected.pdf", pdf, { ...options, reading: true, translation: false }, undefined, undefined, selectedTurnModel);
  assert.equal(turnModelCalls, 1); assert.equal(generated, 0, "global model A is not used for the selected turn model B");
  assert(selectedJob.chunks[0].reading?.includes("B 模型"));
  const sameLanguage = await service.start("english.pdf", pdf, { ...options, translationLanguage: "English" });
  assert.equal(generated, 0); assert.equal(sameLanguage.artifacts.length, 1); assert.match(sameLanguage.warnings.join(""), /不重复/u);
  const scanPath = `${process.env.ECHOINK_PDF_TEST_ROOT}-scan.pdf`;
  await writeFile(scanPath, minimalBlankPdf());
  const japanese = "研究方法実験結果論文資料分析知識原文日本語漢字二十個以上これは日本語です";
  service.deps.local = async () => ({ pages: [{ number: 1, markdown: japanese }], images: [], warnings: [], engine: "local" });
  const translatedJapanese = await service.start("japanese.pdf", pdf, { ...options, translationLanguage: "中文" });
  assert.equal(generated, 1); assert(translatedJapanese.artifacts.some(a => a.kind === "translation" && a.path.endsWith("译文（中文）.md")));
  const attachment = { type: "file" as const, name: "scanned.pdf", path: scanPath, mimeType: "application/pdf" };
  // A real image-only PDF must reach the plugin without ordinary full-text extraction.
  const prepared = await preparePiChatDocuments([attachment], { pdfToolReference: true, availableInputTokens: 5000, capabilityTarget: { providerId: "custom", apiProtocol: "openai-completions", baseUrl: "https://example.invalid", modelId: "fixture", adapter: null } });
  await assert.rejects(preparePiChatDocuments([attachment], { availableInputTokens: 5000, capabilityTarget: { providerId: "custom", apiProtocol: "openai-completions", baseUrl: "https://example.invalid", modelId: "fixture", adapter: null } }), (error: any) => error.code === "textless");
  await rm(scanPath);
  const doc = prepared.documents[0]!;
  assert.equal(doc.transport, "tool_reference"); assert(!doc.text); assert(doc.attachmentId);
  const context = buildPiDocumentContextMessage(prepared.documents)!;
  assert(!JSON.stringify(context).includes(process.cwd()));
  assert(buildPiDocumentProviderContext(prepared.documents).includes(doc.attachmentId!));
  const session = { piDocumentReplay: {} } as never;
  recordPiDocumentReplayForEntry(session, "u", prepared.documents); assert.deepEqual((session as any).piDocumentReplay, {});
  const details = { source: "echoink-pdf-reading", status: "completed", readbackVerified: true, consumedAttachment: { conversationId: "c", userEntryId: "u", attachmentId: doc.attachmentId!, sha256: doc.sha256 } };
  const projector = new PiChatUiProjector();
  const entries: any[] = [{ type: "message", id: "u", message: { role: "user", content: "提取这个", timestamp: 1 } }, { type: "message", id: "context", message: context }];
  const before = projector.projectSessionBranch({ piSessionId: "s", activeLeafId: null, entries });
  assert.equal(before.messages.find(m => m.role === "user")!.attachments!.length, 1);
  const user = before.messages.find(m => m.role === "user")!;
  user.attachments!.push({ type: "file", name: "keep.md", path: "keep.md" });
  const live = projector.projectRuntimeEvent({ current: before, event: { type: "tool_execution_end", conversationId: "c", piSessionId: "s", productRunId: "r", toolCallId: "tool", toolName: "pdf_reading_process", result: { details }, isError: false, occurredAt: 2 } as never });
  assert.deepEqual(live.messages.find(m => m.role === "user")!.attachments!.map(a => a.path), ["keep.md"]);
  entries.push({ type: "message", id: "result", message: { role: "toolResult", toolCallId: "tool", toolName: "pdf_reading_process", details, isError: false, content: [{ type: "text", text: "done" }], timestamp: 2 } });
  const replay = projector.projectSessionBranch({ piSessionId: "s", activeLeafId: null, entries });
  assert.equal(replay.messages.find(m => m.role === "user")!.attachments!.length, 0);
  entries[2].message.isError = true;
  assert.equal(projector.projectSessionBranch({ piSessionId: "s", activeLeafId: null, entries }).messages.find(m => m.role === "user")!.attachments!.length, 1);
  console.log("PASS referring intent, ordinary questions, same-language skip, scan tool reference, private replay and exact live/history consumption");
}

function minimalBlankPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}
