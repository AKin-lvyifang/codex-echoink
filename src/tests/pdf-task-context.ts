import { installObsidianDom } from "./obsidian-dom";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { JSDOM } from "jsdom";
import CodexPlugin from "../main";
import { freezePdfTaskRequest, buildPdfTaskContextMessage, pdfTaskRequestFromEntries, PDF_TASK_CONTEXT_TYPE, PDF_TASK_CONTEXT_KEY } from "../pdf-reading/task-context";
import { assertPdfTaskDelivery } from "../pdf-reading/delivery";
import { PdfReadingController } from "../pdf-reading/controller";
import { pdfToolFixture } from "./pdf-navigation-tools";
import type { PdfTaskRequest } from "../pdf-reading/types";
import { RuntimeTurnQueue, type QueuedTurnItem } from "../ui/turn-queue";
import { checkAgentCapability, checkAgentTool, type AgentCapabilityContext } from "../agents/capability-policy";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { formatKnowledgeRawSourceMarker } from "../knowledge-base/knowledge-agent-index";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { createKnowledgeMaintenanceResultEnvelope } from "../knowledge-base/knowledge-maintenance-result";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../harness/pi-native/controlled-resources";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { persistPiActiveLeaf } from "../harness/pi-native/pi-session-durability";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { formatApprovalPresentation, renderApprovalPresentation } from "../ui/codex-view/approval-presentation";
import { createPdfReadingTools } from "../harness/pi-native/pi-pdf-reading-tools";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";
import { paidTestAccess } from "./membership-access";
import { unavailableCapabilityAccess } from "../membership/access";

const CONTENT = new TextEncoder().encode("%PDF- frozen task data");
const SHA = createHash("sha256").update(CONTENT).digest("hex");
const OTHER_TASK = "ANOTHER_TASK_PRIVATE_TEXT_MUST_NOT_APPEAR";
function request(): PdfTaskRequest {
  return { jobId: "pdf-frozen-context", attachmentId: "pdf-00000000-0000-0000-0000-000000000010", name: "User choice.pdf", sourceFingerprint: SHA,
    byteLength: CONTENT.length, originalDirectory: "Raw", options: { engine: "local", reading: true, summary: true, translation: false, translationLanguage: "中文", wiki: true } };
}
function freezeAndQueue(): void {
  const choice = request(), frozen = freezePdfTaskRequest({ ...choice, privateText: OTHER_TASK })!;
  assert(Object.isFrozen(frozen)); assert(Object.isFrozen(frozen.options));
  choice.options.summary = false; choice.originalDirectory = "Elsewhere";
  assert.equal(frozen.options.summary, true); assert.equal(frozen.originalDirectory, "Raw"); assert.doesNotMatch(JSON.stringify(frozen), new RegExp(OTHER_TASK));
  for (const invalid of [null, { ...request(), jobId: "../job" }, { ...request(), originalDirectory: "../outside" }, { ...request(), originalDirectory: "/absolute" },
    { ...request(), options: { ...request().options, summary: undefined } }, { ...request(), options: { ...request().options, wiki: false } }, { ...request(), sourceFingerprint: "not-sha" }]) {
    assert.equal(freezePdfTaskRequest(invalid), null);
  }
  const queue = new RuntimeTurnQueue();
  const item: QueuedTurnItem = { id: "pdf-queued", sessionId: "pdf-task", text: "开始研究", attachments: [], pdfTaskRequest: structuredClone(frozen),
    preparedDocuments: [{ attachmentId: frozen.attachmentId, transport: "tool_reference", attachment: { name: frozen.name }, sha256: SHA, bytes: new Uint8Array(CONTENT) }] as never,
    skill: null, kind: "chat", createdAt: 1, turnOptions: { providerSettingsId: "offline", runtimeProviderId: "offline", model: "offline", reasoning: "none", permission: "workspace-write", mode: "agent", mcpEnabled: false } };
  const accepted = queue.enqueue(item); item.pdfTaskRequest!.options.reading = false; item.preparedDocuments![0].bytes[0] = 0;
  accepted.pdfTaskRequest!.options.summary = false; accepted.preparedDocuments![0].bytes[1] = 0;
  const peek = queue.peekNext("pdf-task")!;
  assert.equal(peek.pdfTaskRequest!.options.reading, true); assert.equal(peek.pdfTaskRequest!.options.summary, true);
  assert.deepEqual(peek.preparedDocuments![0].bytes, CONTENT);
  peek.pdfTaskRequest!.originalDirectory = "Outside";
  assert.equal(queue.consumeNext("pdf-task")!.pdfTaskRequest!.originalDirectory, "Raw");
  assert.equal(queue.peekNext("other-task"), null);
  const built = buildPdfTaskContextMessage(frozen)!;
  assert.deepEqual(pdfTaskRequestFromEntries([{ type: "custom_message", ...built }]), frozen);
  assert.equal(pdfTaskRequestFromEntries([{ type: "custom_message", customType: PDF_TASK_CONTEXT_TYPE, details: { request: { ...request(), originalDirectory: "../invalid" } } }]), null);
  assert.equal(pdfTaskRequestFromEntries([{ type: "custom_message", customType: "unrelated", details: { request: frozen } }]), null);
  console.log("PASS frozen PDF choices and RuntimeTurnQueue deep-copy options, source bytes and directory; invalid scope and unrelated entries are rejected");
}

function capabilities(root: string): AgentCapabilityContext {
  const settings = structuredClone(DEFAULT_SETTINGS); settings.pdfReading.enabled = true;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.raw = { ...bindings.roles.raw, enabled: true, readPaths: ["Raw"], writePath: "Raw" };
  bindings.roles.wiki = { ...bindings.roles.wiki, enabled: true, readPaths: ["Wiki"], writePath: "Wiki" };
  settings.knowledgeBase.folderBindings = bindings;
  settings.agentRegistry.agents.push({ ...settings.agentRegistry.agents[0], id: "pdf-only", name: "PDF负责人", capabilityIds: ["pdf-reading"], disabledCapabilityIds: [] });
  const context: AgentCapabilityContext = { settings, agentId: "pdf-only", vaultRoot: root, resources: [], proAccess: paidTestAccess,
    access: { permission: "workspace-write", mode: "agent", memoryMode: "normal" } };
  assert.equal(checkAgentCapability(context, "knowledge").allowed, false);
  const target = (reading: boolean, summary: boolean) => ({ originalPath: "Raw/original.pdf", rawDirectory: "Raw", options: { reading, summary, translation: true } });
  assert.equal(checkAgentTool(context, "pdf_reading_process", {}, target(false, false)).allowed, true, "PDF-only Agent can extract or translate without general Knowledge writes");
  assert.equal(checkAgentTool(context, "pdf_reading_process", {}, target(true, false)).reason, "agent_disabled");
  assert.equal(checkAgentTool(context, "pdf_reading_process", {}, target(false, true)).reason, "agent_disabled");
  const off = structuredClone(settings); off.pdfReading.enabled = false;
  assert.equal(checkAgentTool({ ...context, settings: off }, "pdf_reading_process", {}, target(false, false)).reason, "module_disabled");
  assert.equal(checkAgentTool({ ...context, proAccess: unavailableCapabilityAccess }, "pdf_reading_process", {}, target(false, false)).reason, "pro_required");
  assert.equal(checkAgentTool({ ...context, access: { permission: "read-only", mode: "agent", memoryMode: "normal" } }, "pdf_reading_process", {}, target(false, false)).reason, "read_only");
  assert.equal(checkAgentTool({ ...context, access: { permission: "workspace-write", mode: "plan", memoryMode: "normal" } }, "pdf_reading_process", {}, target(false, false)).reason, "read_only");
  assert.equal(checkAgentTool({ ...context, proAccess: unavailableCapabilityAccess }, "pdf_reading_query", {}).allowed, true);
  assert.equal(checkAgentTool(context, "pdf_reading_process", {}, { ...target(false, false), originalPath: "../outside.pdf" }).allowed, false);
  console.log("PASS real PDF capability policy: PDF-only extraction/translation, separate Knowledge requirement, global/PRO/Plan/read-only denial and readable history");
  return context;
}

async function outerAdapter(root: string, policyContext: AgentCapabilityContext): Promise<void> {
  for (const translation of [false, true]) {
    const f = await pdfToolFixture(path.join(root, translation ? "translate" : "extract"), { reading: false, summary: false, translation, wiki: false });
    let context = policyContext;
    const policy = (name: string, args: Record<string, unknown>, target?: unknown) => {
      const frozenTarget = target ?? (name === "pdf_reading_process" ? { options: f.getRequest().options } : undefined);
      const decision = checkAgentTool(context, name, args, frozenTarget);
      if (!decision.allowed) throw new Error(`agent_capability_${decision.reason}`);
    };
    f.setToolPolicy(policy);
    const security = f.getSecurity(), tools = createPdfReadingTools(security);
    const handlers = new Map<string, (...args: any[]) => any>();
    const adapter = createPiVaultToolSecurityAdapter({ isToolAllowed: async (name, args) => { try { policy(name, { ...args }); return true; } catch { return false; } },
      authorization: { async authorize() { throw new Error("PDF uses its official additional-tool Ticket authorization"); } },
      resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()), additionalToolSecurity: security });
    await adapter.inlineExtension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    const chosen = f.getRequest();
    const query = { type: "tool_call", toolCallId: "outer-before-start-query", toolName: "pdf_reading_query", input: { jobId: chosen.jobId } } as const;
    assert.equal(await handlers.get("tool_call")!(query, {}), undefined);
    const queried = await tools[0].execute(query.toolCallId, query.input, undefined, undefined);
    const notStarted = await handlers.get("tool_result")!({ ...query, result: queried });
    assert.equal(notStarted.isError, false); assert.equal(notStarted.details.status, "not_started");
    assert.match(notStarted.content[0].text, /尚未开始.*pdf_reading_process/);
    assert.doesNotMatch(notStarted.content[0].text, /ENOENT|\/Users\/|EchoInk-TestVaults/);
    assert.deepEqual(await f.files.listJobs(), []); assert.deepEqual(f.files.writes, []);
    const input = { attachmentId: chosen.attachmentId, jobId: chosen.jobId, reading: false, summary: false, translation };
    for (const [suffix, invalid] of [["unknown-job", { ...input, jobId: "not-the-frozen-job" }], ["conflicting-reading", { ...input, reading: true }], ["conflicting-translation", { ...input, translation: !translation }]] as const) {
      assert((await handlers.get("tool_call")!({ type: "tool_call", toolCallId: suffix, toolName: "pdf_reading_process", input: invalid }, {}))?.block);
    }
    assert.deepEqual(f.files.writes, []); assert.equal(f.counts().confirms, 0, "wrong identity/choices cannot reach approval or create the pending job");
    const event = { type: "tool_call", toolCallId: "outer-pdf", toolName: "pdf_reading_process", input } as const;
    assert.equal(await handlers.get("tool_call")!(event, {}), undefined, "outer wrapper respects host-frozen extraction/translation instead of defaulting reading=true");
    const raw = await tools[1].execute(event.toolCallId, event.input, undefined, undefined);
    const result = await handlers.get("tool_result")!({ ...event, result: raw }); assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(f.counts().engineCalls, 1); assert.equal(f.counts().modelCalls, translation ? 1 : 0);
    assert.deepEqual(await f.files.listJobs(), [chosen.jobId]); assert.equal(f.files.writes.filter(path => path.endsWith(".pdf")).length, 1);
    const repeated = { ...event, toolCallId: "outer-same-job-retry" };
    assert.equal(await handlers.get("tool_call")!(repeated, {}), undefined);
    const reused = await tools[1].execute(repeated.toolCallId, repeated.input, undefined, undefined);
    assert.equal((await handlers.get("tool_result")!({ ...repeated, result: reused })).isError, false);
    assert.equal(f.counts().engineCalls, 1); assert.equal(f.files.writes.filter(path => path.endsWith(".pdf")).length, 1, "same frozen job and matching flags write the original once");
    const writes = f.files.writes.length;
    for (const options of [{ reading: true, summary: false }, { reading: false, summary: true }]) {
      f.setRequest({ ...f.getRequest(), options: { ...f.getRequest().options, ...options, wiki: true } });
      assert((await handlers.get("tool_call")!({ ...event, toolCallId: `no-knowledge-${options.reading}` }, {}))?.block);
    }
    f.setRequest({ ...f.getRequest(), options: { ...f.getRequest().options, reading: false, summary: false, wiki: false } });
    context = { ...context, proAccess: unavailableCapabilityAccess };
    assert((await handlers.get("tool_call")!({ ...event, toolCallId: "outer-no-pro" }, {}))?.block);
    context = { ...policyContext, access: { permission: "read-only", mode: "agent", memoryMode: "normal" } };
    assert((await handlers.get("tool_call")!({ ...event, toolCallId: "outer-read-only" }, {}))?.block);
    const disabled = structuredClone(policyContext.settings); disabled.pdfReading.enabled = false;
    context = { ...policyContext, settings: disabled };
    assert((await handlers.get("tool_call")!({ ...event, toolCallId: "outer-global-disabled" }, {}))?.block);
    assert.equal(f.files.writes.length, writes, "outer denials cannot reach PDF writes");
  }
  console.log("PASS complete outer Vault security adapter plus real capability policy/official PDF Ticket: extraction/translation work for PDF-only Agent; Knowledge/global/PRO/read-only denials write nothing");
}

async function sessionPipeline(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const handlers = new Map<string, (...args: any[]) => any>();
  const selected = freezePdfTaskRequest(request())!;
  const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentTurn: () => ({ kind: "chat", providerResourceText: "CURRENT_TASK_SOURCE_ONLY", references: [] }) as never,
    currentPdfTaskRequest: () => selected, currentWorkspaceAccess: () => ({ permission: "workspace-write", mode: "agent", memoryMode: "normal" }) });
  await extension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
  const before = await handlers.get("before_agent_start")!({ systemPrompt: "PDF fixture system", prompt: "开始研究" });
  assert.notEqual(before.message.customType, PDF_TASK_CONTEXT_TYPE, "the real merge retains its primary Knowledge message");
  assert.deepEqual(before.message.details[PDF_TASK_CONTEXT_KEY].request, selected);
  assert.deepEqual(pdfTaskRequestFromEntries([{ type: "custom_message", ...before.message }]), selected);
  const user = { role: "user", content: [{ type: "text", text: "开始研究" }], timestamp: 1 };
  const material = await handlers.get("context")!({ messages: [user, { role: "custom", timestamp: 1, ...before.message }] });
  const pdfPart = material.messages.find((message: any) => message.customType === PDF_TASK_CONTEXT_TYPE);
  assert(pdfPart); assert.match(pdfPart.content, /User choice.pdf/); assert.doesNotMatch(pdfPart.content, /CURRENT_TASK_SOURCE_ONLY/);
  assert.equal(material.messages.at(-1), user);

  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "runtime"), vaultId: "pdf-context-vault" });
  const productRuns = new FileProductRunStore({ storageRootPath: catalog.storageRootPath, vaultId: catalog.vaultId, catalog });
  const managers = new Map<string, SessionManager>();
  const contexts: Array<{ conversationId: string; messages: unknown[] }> = [];
  const deliveries: Array<{ scope: Readonly<PdfTaskRequest>; noNew: readonly string[] }> = [];
  const legacyDeliveries: string[] = [];
  let sequence = 0, rejectDelivery = false;
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns, resolveConversationCwd: () => root, idFactory: () => `pdf-context-run-${++sequence}`,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, directory, cwd) => SessionManager.open(file, directory, cwd) },
    verifyPdfTaskDelivery: async (scope, noNew) => { if (rejectDelivery) throw new Error("精读尚未保存到知识成果"); if (typeof scope === "string") legacyDeliveries.push(scope); else deliveries.push({ scope, noNew }); },
    createAgentSession: async input => {
      managers.set(input.catalog.conversationId, input.sessionManager);
      const provider = fauxProvider({ provider: "offline-pdf", api: "openai-completions", models: [{ id: "pdf-model", contextWindow: 32000, maxTokens: 512, reasoning: false }] });
      provider.setResponses(Array.from({ length: 12 }, () => context => {
        if (input.catalog.conversationId === "legacy-chat-task") input.bindPdfDeliveryJob?.("legacy-real-job");
        contexts.push({ conversationId: input.catalog.conversationId, messages: structuredClone(context.messages) }); return fauxAssistantMessage("已核对这份PDF。");
      }));
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider); const model = provider.getModel();
      const security = createPiVaultToolSecurityAdapter({ isToolAllowed: () => false, authorization: { async authorize() { throw new Error("No write authorized by task scope"); } },
        resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()) });
      const resourceLoader = await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "PDF fixture system", inlineExtension: createPiKnowledgeInlineExtension({
        vaultSecurity: security.inlineExtension, currentTurn: input.currentKnowledgeTurnContext, currentWorkspaceAccess: input.currentWorkspaceAccess, currentPdfTaskRequest: input.currentPdfTaskRequest }) });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false },
          packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }), resourceLoader, ...createControlledPiToolRegistration([]) });
      return { session, planToolNames: [], externalReadToolNames: [], memoryToolNames: [] };
    } });
  try {
    await runtime.initialize();
    for (const id of ["pdf-task", "ordinary-task", "wrong-file-task", "invalid-scope-task", "read-only-task", "legacy-chat-task", "incomplete-delivery-task"]) await runtime.createConversation({ conversationId: id, title: id, cwd: root });
    const document = { kind: "pdf", transport: "tool_reference", attachmentId: selected.attachmentId,
      attachment: { type: "file", name: selected.name, path: "fixture.pdf", mimeType: "application/pdf", sizeBytes: CONTENT.length, availability: "available" },
      sha256: SHA, bytes: new Uint8Array(CONTENT), text: null };
    const base = { text: "开始研究", submittedAt: Date.now(), runtimeProviderId: "offline-pdf", modelId: "pdf-model", reasoning: "none" as const, permission: "workspace-write" as const, mode: "agent" as const };
    const choice = structuredClone(selected);
    const first = await runtime.submit({ ...base, conversationId: "pdf-task", pdfTaskRequest: choice, documents: [document] as never });
    choice.options.summary = false;
    assert.equal((await first.result).terminalState, "completed"); assert.equal(deliveries.at(-1)!.scope.options.summary, true);
    rejectDelivery = true;
    const incomplete = await runtime.submit({ ...base, conversationId: "incomplete-delivery-task", pdfTaskRequest: selected, documents: [document] as never });
    const failedDelivery = await incomplete.result;
    assert.equal(failedDelivery.state, "product_run_settled", "missing PDF results settle instead of leaving a finalizing run");
    assert.equal(failedDelivery.terminalState, "failed");
    assert.equal(failedDelivery.interruption?.detail, "精读尚未保存到知识成果");
    rejectDelivery = false;
    const fixedDelivery = await runtime.submit({ ...base, conversationId: "incomplete-delivery-task", text: "继续" });
    assert.equal((await fixedDelivery.result).terminalState, "completed");
    const manager = managers.get("pdf-task")!;
    const entry = manager.getBranch().find(entry => entry.type === "custom_message")!;
    assert(entry); assert.deepEqual(pdfTaskRequestFromEntries(manager.getBranch()), selected);
    const assistant = [...manager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
    manager.appendCompaction("压缩内容不包含PDF文件/选项", assistant.id, 1500);
    persistPiActiveLeaf({ sessionRoot: catalog.sessionRootPath, sessionManager: manager });
    await runtime.releaseConversation("pdf-task");
    const resumed = await runtime.submit({ ...base, conversationId: "pdf-task", text: "继续", pdfTaskRequest: undefined, documents: undefined });
    assert.equal((await resumed.result).terminalState, "completed");
    assert.deepEqual(deliveries.at(-1)!.scope, selected); assert.match(JSON.stringify(contexts.at(-1)!.messages), /User choice.pdf/);
    const oldScope = structuredClone(selected); oldScope.options.summary = false;
    await assert.rejects(runtime.submit({ ...base, conversationId: "pdf-task", pdfTaskRequest: oldScope, documents: [document] as never }), /PDF任务的文件和成果已固定/);
    await assert.rejects(runtime.submit({ ...base, conversationId: "wrong-file-task", pdfTaskRequest: selected, documents: [{ ...document, attachmentId: "pdf-00000000-0000-0000-0000-000000000011" }] as never }), /附件与本次选择不一致/);
    await assert.rejects(runtime.submit({ ...base, conversationId: "invalid-scope-task", pdfTaskRequest: { ...selected, originalDirectory: "../outside" }, documents: [document] as never }), /PDF任务的文件和成果已固定/);
    await assert.rejects(runtime.submit({ ...base, conversationId: "read-only-task", permission: "read-only", pdfTaskRequest: selected, documents: [document] as never }), /需要可写工作区/);
    const ordinary = await runtime.submit({ ...base, conversationId: "ordinary-task", text: OTHER_TASK }); assert.equal((await ordinary.result).terminalState, "completed");
    assert.doesNotMatch(JSON.stringify(contexts.at(-1)!.messages), /User choice.pdf|pdf-frozen-context/);
    const back = await runtime.submit({ ...base, conversationId: "pdf-task", text: "继续原任务" }); assert.equal((await back.result).terminalState, "completed");
    assert.doesNotMatch(JSON.stringify(contexts.at(-1)!.messages), new RegExp(OTHER_TASK));

    // Real Pi tool-result entries carry formal no-op evidence; arbitrary text or
    // another Tool's similarly named fields do not enter the completion port.
    const reopened = managers.get("pdf-task")!;
    const noop = createKnowledgeMaintenanceResultEnvelope({ status: "noop" });
    for (const [name, isError, raw, formal] of [["knowledge_maintain", false, "Raw/matching.md", true], ["knowledge_maintain", false, "Raw/other.md", true],
      ["fake_tool", false, "Raw/not-a-formal-tool.md", true], ["knowledge_maintain", true, "Raw/failed.md", true], ["knowledge_maintain", false, "Raw/text-only.md", false]] as const) {
      reopened.appendMessage({ role: "toolResult", toolCallId: `noop-${raw}`, toolName: name, isError, content: [{ type: "text", text: "nothing new" }], timestamp: Date.now(),
        details: { processedSourcePaths: [raw], ...(formal ? { maintenanceResult: noop } : {}) } });
    }
    const noopTurn = await runtime.submit({ ...base, conversationId: "pdf-task", text: "核对交付" }); assert.equal((await noopTurn.result).terminalState, "completed");
    assert.deepEqual([...deliveries.at(-1)!.noNew].sort(), ["Raw/matching.md", "Raw/other.md"]);
    const legacy = await runtime.submit({ ...base, conversationId: "legacy-chat-task", text: "旧聊天入口处理PDF" });
    assert.equal((await legacy.result).terminalState, "completed"); assert.deepEqual(legacyDeliveries, ["legacy-real-job"]);
    const stored = await readFile((await catalog.get("pdf-task"))!.sessionFile!, "utf8");
    assert.doesNotMatch(stored, new RegExp(OTHER_TASK));
    console.log("PASS actual production merge and Pi runtime: compact/reopen restores frozen PDF scope, new/ordinary tasks stay isolated, mismatched files/scopes and read-only reject before sending");
    console.log("PASS runtime completion forwards only successful formal knowledge-maintain no-op source paths");
  } finally { await runtime.shutdown(); }
}

async function deliveryAndApproval(root: string): Promise<void> {
  const f = await pdfToolFixture(root, { reading: true, summary: true });
  await f.invoke(); const choice = f.getRequest();
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.raw = { ...bindings.roles.raw, enabled: true, readPaths: ["Raw"], writePath: "Raw" };
  bindings.roles.wiki = { ...bindings.roles.wiki, enabled: true, readPaths: ["Wiki"], writePath: "Wiki" };
  const unregister = registerKnowledgeFolderBindings(root, () => bindings);
  const controller = Object.create(PdfReadingController.prototype) as PdfReadingController;
  const taskCatalog = (await f.resumeInput()).catalog;
  const plugin = Object.assign(Object.create(CodexPlugin.prototype), { pdfReading: controller, settings: { knowledgeBase: { folderBindings: bindings } },
    getVaultPath: () => root, ensurePiLocalData: async () => ({ piNativeStorageRootPath: path.join(root, ".index") }),
    readPiConversationCatalogEntry: taskCatalog.get.bind(taskCatalog),
    app: { metadataCache: { getFirstLinkpathDest: () => null } } });
  Object.assign(controller, { api: f.service, plugin });
  try {
    let entry = (await controller.navigationData(choice.jobId)).entries[0];
    assert(entry.job.chunks.every(chunk => !!chunk.reading));
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice, []), /精读尚未保存/);
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice.jobId, []), /精读尚未保存/);
    const raw = entry.artifacts.find(artifact => artifact.kind === "raw")!.path;
    const rawText = await f.files.read(raw), marker = formatKnowledgeRawSourceMarker(raw, `sha256:${rawDigestFingerprint(raw, Buffer.from(rawText)).split(":").at(-1)}`);
    await f.files.create("Wiki/Topic.md", `# Topic\n来源：[[${raw}]]\n${marker}\n\n分析已完成但没有所选交付段落。`);
    const knowledgeArtifacts = await plugin.readPdfKnowledgeArtifacts(raw);
    entry = (await controller.navigationData(choice.jobId)).entries[0];
    assert(entry.artifacts.some(artifact => artifact.kind === "wiki"), JSON.stringify({ knowledgeArtifacts, entry, navigation: await controller.navigationData(choice.jobId) }));
    assert(!entry.artifacts.some(artifact => artifact.kind === "reading" || artifact.kind === "summary"));
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice, []), /精读尚未保存/);
    await f.files.replace("Wiki/Topic.md", `# 精读与摘要\n来源：[[${raw}]]\n${marker}\n\n只是正文，没有所选成果段落。`);
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice, []), /精读尚未保存/);
    await f.files.replace("Wiki/Topic.md", `# Topic\n来源：[[${raw}]]\n${marker}\n\n## 精读\n\n## 摘要\n简明结论。`);
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice, []), /精读尚未保存/);
    await f.files.replace("Wiki/Topic.md", `# Topic\n来源：[[${raw}]]\n${marker}\n\n## 精读\n可核实的证据分析。`);
    await assert.rejects(plugin.verifyPdfTaskDelivery(choice, []), /摘要尚未保存/);
    await f.files.replace("Wiki/Topic.md", `# Topic\n来源：[[${raw}]]\n${marker}\n\n## 精读\n证据与限制。\n\n## 摘要\n简明结论。`);
    await plugin.verifyPdfTaskDelivery(choice, []);
    await plugin.verifyPdfTaskDelivery(choice.jobId, []);
    entry = (await controller.navigationData(choice.jobId)).entries[0];
    assert(entry.artifacts.some(artifact => artifact.kind === "reading" && artifact.path === "Wiki/Topic.md#精读"));
    assert(entry.artifacts.some(artifact => artifact.kind === "summary" && artifact.path === "Wiki/Topic.md#摘要"));
    const legacyJob = { ...structuredClone(entry.job), id: "legacy-delivery-no-original" };
    delete legacyJob.original; delete legacyJob.conversationId;
    await f.files.create("state/legacy-delivery-no-original.json", JSON.stringify(legacyJob));
    await plugin.verifyPdfTaskDelivery(legacyJob.id, []);
    await assert.rejects(plugin.verifyPdfTaskDelivery({ ...choice, jobId: legacyJob.id }, []), /原 PDF 未通过回读/);
    assert.equal((await f.service.load(legacyJob.id)).original, undefined, "legacy delivery does not backfill an original");
    const rawOnly = { ...choice, options: { ...choice.options, reading: false, summary: false, wiki: false } };
    const noWiki = { ...entry, artifacts: entry.artifacts.filter(artifact => !["wiki", "reading", "summary"].includes(artifact.kind)) };
    assert.doesNotThrow(() => assertPdfTaskDelivery(rawOnly, noWiki));
    assert.throws(() => assertPdfTaskDelivery(choice, noWiki, ["Raw/another-task.md"]), /精读尚未保存/);
    assert.doesNotThrow(() => assertPdfTaskDelivery(choice, noWiki, [raw]));
    const translation = { ...rawOnly, options: { ...rawOnly.options, translation: true } };
    assert.throws(() => assertPdfTaskDelivery(translation, { ...noWiki, job: { ...noWiki.job, options: { ...noWiki.job.options, translation: true } } }), /译文尚未保存/);
    assert.doesNotThrow(() => assertPdfTaskDelivery(translation, { ...noWiki, job: { ...noWiki.job, sourceLanguage: "中文", options: { ...noWiki.job.options, translation: false } } }));
    console.log("PASS real controller and Knowledge index: complete chunks/Wiki without headings cannot finish, selected heading anchors deliver, unselected results are optional, same-language translation and exact-Raw formal no-op work");

    const ticket = (await f.approvals.listReadOnlyViews())[0].ticket;
    const presentation = formatApprovalPresentation({ target: JSON.stringify(ticket.resolvedTarget), preview: JSON.stringify(ticket.preview) });
    const visible = JSON.stringify({ action: presentation.action, destination: presentation.destination, changes: presentation.changes, notices: presentation.notices });
    assert.match(visible, /保存原 PDF|提取原文|精读|摘要|当前模型/); assert.doesNotMatch(visible, /sourceFingerprint|jobId|SHA|"files"/);
    assert.doesNotMatch(visible, new RegExp(choice.sourceFingerprint));
    const dom = new JSDOM("<!doctype html><body></body>"); installComposerMenuDomHelpers(dom.window.document);
    installObsidianDom(dom.window);
    try {
      const host = dom.window.document.body.createDiv(); renderApprovalPresentation(host, presentation);
      assert.equal(host.querySelector("details")!.open, false);
      const fields = [...host.querySelectorAll(".codex-approval-field-value")].filter(node => !node.closest("details")).map(node => node.textContent).join("\n");
      assert.match(fields, /Raw|精读|摘要/); assert.doesNotMatch(fields, /sourceFingerprint|jobId|SHA/);
    } finally { dom.window.close(); }
    console.log("PASS actual PDF approval projection/card shows target/outcomes/model disclosure with internal job/hash fields confined to collapsed technical details");
  } finally { unregister(); }
}

async function settingsRoundTrip(root: string): Promise<void> {
  const selected = "Sources/保留旧深层目录/PDF originals";
  const settings = normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), pdfReading: { ...DEFAULT_SETTINGS.pdfReading, originalDirectory: selected } }).settings;
  const file = path.join(root, "pdf-settings-roundtrip.json");
  await writeFile(file, JSON.stringify(settings));
  const restored = normalizeSettingsData(JSON.parse(await readFile(file, "utf8"))).settings;
  assert.equal(restored.pdfReading.originalDirectory, selected, "the actual settings whitelist must preserve the chosen original directory across save/reload");
  assert.equal(Object.hasOwn(normalizeSettingsData(DEFAULT_SETTINGS).settings.pdfReading, "originalDirectory"), false, "old settings are not auto-filled or relocated");
  console.log("PASS real settings save/reload normalization preserves explicit original directory and leaves legacy unset choices unchanged");
}

export async function runPdfTaskContextTests(root: string): Promise<void> {
  await settingsRoundTrip(root);
  freezeAndQueue(); const context = capabilities(root);
  await outerAdapter(path.join(root, "outer-adapter"), context);
  await sessionPipeline(path.join(root, "session"));
  await deliveryAndApproval(path.join(root, "delivery"));
  console.log("P10 PDF task-context integration: PASS (offline real runtime/service/store/controller; no native/remote Provider acceptance claimed)");
}
