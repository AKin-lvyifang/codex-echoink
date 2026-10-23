import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { App } from "obsidian";
import { setRequestUrlForTests } from "./obsidian-shim";
import { emptyKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { KnowledgeBaseCaptureService } from "../knowledge-base/capture";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { knowledgeMayCreateCategoryDirectory, knowledgeMayOrganizeMove } from "../knowledge-base/folder-organization";
import { ObsidianVaultDomainAdapter } from "../plugin/obsidian-vault-domain-adapter";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { createPiVaultProductionAuthorizationPort, createPiVaultProductionWriteExecutionPort } from "../plugin/pi-vault-tool-production";
import { createPiVaultToolDefinitions, PI_VAULT_TOOL_POLICIES, PI_VAULT_TOOL_VERSION, PI_VAULT_TOOL_POLICY_VERSION, type PiVaultToolId } from "../harness/pi-native/pi-vault-tool-contracts";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import type { PiWorkspaceAccess } from "../harness/pi-native/pi-workspace-access";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { createProductionPiKnowledgeRuntime, createProductionPiKnowledgeToolRetriever } from "../plugin/pi-production-runtime-composition";
import { PiKnowledgeReadToolSecurity, createPiKnowledgeReadToolDefinitions } from "../harness/pi-native/pi-knowledge-read-tools";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { ProductionPiKnowledgeMaintenanceToolPort, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { KnowledgeLinkingService, type KnowledgeLinkingHost } from "../plugin/knowledge-linking-service";
import { KnowledgeLinkingStateStore } from "../knowledge-base/knowledge-linking-state";
import { createProductionKnowledgeLinkingHost } from "../plugin/knowledge-linking-production";
import { readKnowledgeLinkingDocument } from "../knowledge-base/knowledge-linking";
import { rawDigestFingerprint } from "../knowledge-base/raw-digest";
import { nativeJournalFixture } from "./native-journal-fixture";
import { createObsidianNativePort } from "../plugin/obsidian-native-tools";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions } from "../harness/pi-native/pi-obsidian-tools";
import { runVaultBodySearchWorkflowNavigationTests } from "./vault-body-search";

export async function runModuleRuntimeTests(root: string): Promise<void> {
  await collectionTargets(path.join(root, "collection"));
  await directoryExecution(path.join(root, "directories"), path.join(root, "state"));
  await chatRecall(path.join(root, "recall"));
  await runVaultBodySearchWorkflowNavigationTests(path.join(root, "workflow-navigation"));
  await automaticLinking(path.join(root, "automatic-linking"));
  await automaticQueue(path.join(root, "automatic-queue"));
  await vaultSearchRecall(path.join(root, "vault-search-recall"));
  console.log("P12 production Inbox scope, collection targets, live parent-directory policy, automatic linking gate, approval and receipts: PASS");
}

async function vaultSearchRecall(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root);
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.inbox, { enabled: true, searchEnabled: true, readPaths: ["Inbox"], writePath: "Inbox" });
  Object.assign(bindings.roles.projects, { enabled: true, searchEnabled: true, readPaths: ["Projects"], writePath: "Projects" });
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const secret = "RETIRED_INBOX_SECRET_Only_In_Inbox";
  for (let index = 0; index < 24; index++) await fixture.write(`Inbox/${index}.md`, `SCOPED_TOKEN ${secret}`);
  await fixture.write("Notes/public.md", "SCOPED_TOKEN 普通笔记保留");
  await fixture.write("Projects/project.md", "SCOPED_TOKEN 项目保留");
  const adapter = new ObsidianVaultDomainAdapter(fixture.app, "p12-vault-search", root), domain = new VaultDomainService(adapter);
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".approvals"), vaultId: adapter.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".receipts"), vaultId: adapter.vaultId });
  await approvals.initialize(); await receipts.initialize();
  const identity = { vaultId: adapter.vaultId, conversationId: "p12-full-search", piSessionId: "p12-session", productRunId: "p12-run" };
  const security = createPiVaultToolSecurityAdapter({ isToolAllowed: () => true,
    authorization: createPiVaultProductionAuthorizationPort({ approvals, adapter, currentRunIdentity: () => identity, userId: "synthetic-user", deviceId: "synthetic-device", confirmation: { confirm: async () => true } }),
    resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()) });
  const handlers = new Map<string, (...args: any[]) => any>();
  await security.inlineExtension.factory({ on: (name: string, callback: (...args: any[]) => any) => handlers.set(name, callback) } as never);
  const tools = createPiVaultToolDefinitions({ domainService: domain, security, writeExecution: createPiVaultProductionWriteExecutionPort({ receipts, domainService: domain, adapter }) });
  let sequence = 0;
  const call = async (toolName: "vault_search" | "note_read", input: Record<string, unknown>) => {
    const event = { toolName, input, toolCallId: `p12-search-${++sequence}` };
    assert.equal(await handlers.get("tool_call")!(event, {}), undefined, "P2 broad tool admission is retained");
    const raw = await tools.find(tool => tool.name === toolName)!.execute(event.toolCallId, input, undefined, undefined);
    const result = await handlers.get("tool_result")!({ ...event, ...raw, isError: false });
    assert.equal(result.isError, false);
    return { value: JSON.parse(result.content[0].text), text: result.content[0].text };
  };
  const cliCalls: string[][] = [];
  let malformed = false, duringCli: (() => void) | undefined;
  const cliPort = createObsidianNativePort(fixture.app, adapter, () => "journal", { knowledgeBindings: () => bindings, transport: { async run(argv) {
    cliCalls.push([...argv]); const command = argv[0];
    let output: string;
    if (command === "vault") output = root;
    else if (command === "help") output = "search\nsearch:context\nread";
    else if (command === "read") output = await fs.readFile(path.join(root, argv.find(value => value.startsWith("path="))!.slice(5)), "utf8");
    else {
      duringCli?.();
      const rows = ["Inbox/0.md", "Projects/project.md", "Notes/public.md"];
      output = malformed ? secret : JSON.stringify(command === "search:context" ? rows.map(file => ({ file, matches: [{ line: 1, text: file.startsWith("Inbox/") ? secret : "SCOPED_TOKEN" }] })) : rows);
    }
    return { status: "completed" as const, started: true, output };
  } } });
  const cliSecurity = new PiObsidianToolSecurity({ currentRunIdentity: () => identity, currentAccess: () => ({ permission: "read-only", mode: "agent", memoryMode: "normal" }), assertToolAllowed: async () => undefined });
  const cliTools = createPiObsidianToolDefinitions(cliPort, cliSecurity);
  const cli = async (input: Record<string, unknown>) => {
    const event = { toolName: "obsidian_cli", toolCallId: `p12-cli-${++sequence}`, input };
    assert.equal(await cliSecurity.handleToolCall(event as never), undefined);
    const raw = await cliTools.find(tool => tool.name === "obsidian_cli")!.execute(event.toolCallId, input, undefined, undefined);
    const result = await cliSecurity.handleToolResult({ ...event, ...raw, isError: false } as never);
    return { ...result, value: JSON.parse(result.content[0].text) };
  };
  try {
    assert((await call("vault_search", { query: secret })).text.includes(secret));
    bindings.roles.inbox.enabled = false;
    let found = await call("vault_search", { query: "SCOPED_TOKEN" });
    assert(!found.text.includes(secret)); assert.deepEqual(found.value.items.map((item: { relativePath: string }) => item.relativePath), ["Notes/public.md", "Projects/project.md"]);
    assert.equal((await call("vault_search", { query: secret, scopePath: "Inbox" })).value.items.length, 0);
    assert((await call("note_read", { relativePath: "Inbox/0.md" })).text.includes(secret), "explicit path reads retain the existing broad tool authority");
    bindings.roles.inbox.enabled = true; bindings.roles.inbox.searchEnabled = false;
    assert.equal((await call("vault_search", { query: secret })).value.items.length, 0);
    bindings.roles.inbox.readPaths = []; bindings.roles.inbox.writePath = null; bindings.inboxRecallExclusions = ["Inbox"];
    assert.equal((await call("vault_search", { query: secret })).value.items.length, 0, "unbound Inbox does not reappear through vault_search");
    for (const command of ["search", "search:context"]) {
      const result = await cli({ command, query: "SCOPED_TOKEN", format: "json", limit: 20 });
      assert.equal(result.isError, false, `${command}: ${JSON.stringify(result.value)}`); assert(!JSON.stringify(result.value).includes(secret)); assert(!result.value.output.includes("Inbox/"));
      assert(result.value.output.includes("Notes/public.md")); assert(result.value.output.includes("Projects/project.md"));
      assert(cliCalls.at(-1)?.some(argument => argument.startsWith("query=") && argument.includes("-path:/^")), "official query excludes candidates before its result cap");
    }
    assert((await cli({ command: "read", path: "Inbox/0.md" })).value.output.includes(secret));
    malformed = true;
    const unsafe = await cli({ command: "search:context", query: "SCOPED_TOKEN" });
    assert.equal(unsafe.isError, true); assert(!JSON.stringify(unsafe).includes(secret), "unstructured CLI output is never returned when candidate scope cannot be verified");
    malformed = false;
    bindings.roles.projects.readPaths.push("Inbox");
    assert((await call("vault_search", { query: secret })).text.includes(secret), "a separately enabled shared project retains its prior search authority");
    bindings.roles.projects.readPaths = ["Projects"];
    bindings.roles.inbox.enabled = true; bindings.roles.inbox.searchEnabled = true; bindings.roles.inbox.readPaths = ["Inbox"]; bindings.inboxRecallExclusions = [];
    duringCli = () => { bindings.roles.inbox.enabled = false; };
    const changed = await cli({ command: "search:context", query: "SCOPED_TOKEN" });
    assert.equal(changed.isError, true); assert(!JSON.stringify(changed).includes(secret), "closing Inbox while a CLI search is running prevents stale result delivery");
    duringCli = undefined;
    bindings.roles.inbox.enabled = true;
    assert((await call("vault_search", { query: secret })).text.includes(secret));
  } finally { release(); }
}

async function automaticLinking(root: string): Promise<void> {
  assert.equal(DEFAULT_SETTINGS.knowledgeBase.autoLinkEnabled, true);
  assert.equal(normalizeSettingsData({}).settings.knowledgeBase.autoLinkEnabled, true);
  assert.equal(normalizeSettingsData({ knowledgeBase: { autoLinkEnabled: false } }).settings.knowledgeBase.autoLinkEnabled, false);
  const fixture = await nativeJournalFixture(root);
  const productionHost = createProductionKnowledgeLinkingHost(fixture.plugin);
  assert.equal(productionHost.automaticEnabled?.(), true);
  fixture.plugin.settings.knowledgeBase.autoLinkEnabled = false;
  assert.equal(productionHost.automaticEnabled?.(), false, "the production host reads the live saved setting");
  fixture.plugin.settings.knowledgeBase.autoLinkEnabled = true;
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["raw"], writePath: "raw" });
  Object.assign(bindings.roles.wiki, { enabled: true, readPaths: ["wiki"], writePath: "wiki" });
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const raw = "# Source\nAgent 是人工智能系统。\n";
  await fixture.write("raw/source.md", raw); await fixture.write("wiki/AI.md", "# AI\n人工智能系统。\n");
  await fixture.write("raw/other.md", "---\n提炼状态: 已提炼\n---\n# Other\n另一个已处理来源。\n");
  const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".index") });
  await index.refresh();
  let refreshes = 0, starts = 0, enabled = false;
  const refresh = index.refresh.bind(index);
  index.refresh = async () => { refreshes++; return await refresh(); };
  const stateRoot = path.join(root, ".maintenance");
  const options = { vaultRootPath: root, privateKnowledgeRootPath: stateRoot, vaultId: "p12-linking", userId: "synthetic-user", deviceId: "synthetic-device",
    domainService: new VaultDomainService(new ObsidianVaultDomainAdapter(fixture.app, "p12-linking", root), { allowMissingParentDirectories: true }),
    knowledgeAgentIndex: index, linkingOwnsDraftLinks: true, automaticLinkingEnabled: () => enabled,
    onCommitted: async () => { starts++; return "p12-auto-task"; } };
  const port = new ProductionPiKnowledgeMaintenanceToolPort(options);
  const input: Parameters<typeof port.execute>[0] = { vaultId: "p12-linking", conversationId: "p12-linking-conversation", piSessionId: "p12-session", productRunId: "p12-linking-run", toolCallId: "maintain", mode: "maintain", request: "",
    sourcePaths: ["raw/source.md"], sourceBodyFingerprints: { "raw/source.md": rawDigestFingerprint("raw/source.md", Buffer.from(raw)) },
    preferenceSnapshot: { profileVersion: "echoink-knowledge-preference-profile-v1", state: "default", revision: `sha256:${"a".repeat(64)}` } };
  const writeInput: Parameters<typeof port.execute>[0] = { ...input, p1: { stage: "write", pageId: "gate", content: "---\n类型: 概念\naliases: [Agent]\n---\n# Gate\nAgent 是人工智能系统。\n\n## 定义\nAgent 是人工智能系统。\n" } };
  try {
    await port.initialize();
    const decomposed = await port.execute({ ...input, toolCallId: "decompose", p1: { stage: "decompose", decompositions: [{ sourcePath: "raw/source.md", summary: "Agent 是人工智能系统。", units: [{ id: "gate-unit", title: "Gate", type: "概念", domain: "知识管理", aliases: ["Agent"], points: ["Agent 是人工智能系统。"], evidence: [{ sourcePath: "raw/source.md", sourceRevision: `sha256:${createHash("sha256").update(raw).digest("hex")}`, quote: "Agent 是人工智能系统。" }] }] }] } });
    assert.equal(decomposed.status, "completed", decomposed.message);
    const planned = await port.execute({ ...input, toolCallId: "plan", p1: { stage: "plan", writingPlan: [{ id: "gate", targetPath: "wiki/Gate.md", sourcePaths: ["raw/source.md"], expectedTarget: { kind: "missing" }, knowledge: { unitIds: ["gate-unit"], decision: { kind: "new", reason: "独立的合成知识条目，用于验证后台关联开关。" } } }] } });
    assert.equal(planned.status, "completed", planned.message);
    const result = await port.execute(writeInput);
    assert.equal(result.status, "completed", result.message);
    assert.equal(starts, 0, "disabled automatic linking never submits a new linking task");
    assert(refreshes > 0, "knowledge index refresh remains enabled after commit");
    assert((await fs.readFile(path.join(root, "wiki/Gate.md"), "utf8")).includes("Agent"));
    const committedPage = await fs.readFile(path.join(root, "wiki/Gate.md"), "utf8");
    const committedSource = await fs.readFile(path.join(root, "raw/source.md"), "utf8");
    let record = (await readPrivateMaintenanceRecords(stateRoot)).find(value => value.recordId === result.recordId)!;
    assert(record.pendingLinking, "intentional disable retains the durable pending record");
    assert(!record.result.issues.some(issue => issue.code === "linking_start_failed"));
    const recovered = new ProductionPiKnowledgeMaintenanceToolPort(options);
    await recovered.initialize();
    assert.equal(starts, 0, "reload does not bypass the disabled setting");
    record = (await readPrivateMaintenanceRecords(stateRoot)).find(value => value.recordId === result.recordId)!;
    assert(record.pendingLinking); assert(!record.result.issues.some(issue => issue.code === "linking_start_failed"));
    const resumeInput: Parameters<typeof port.execute>[0] = { ...input, p1: { stage: "resume" } };
    assert.equal((await recovered.execute(resumeInput)).status, "completed");
    assert.equal(starts, 0, "continuation does not bypass the disabled setting");
    enabled = true;
    assert.equal((await recovered.execute({ ...resumeInput, conversationId: "another-conversation" })).status, "completed");
    assert.equal(starts, 0, "another conversation cannot resume this saved linking task");
    assert.equal((await recovered.execute({ ...resumeInput, sourcePaths: ["raw/other.md"] })).status, "completed");
    assert.equal(starts, 0, "a different selected source scope cannot resume this saved linking task");
    assert.equal((await recovered.execute(resumeInput)).status, "completed");
    assert.equal(starts, 1, "the existing saved-execution path resumes pending linking after enable");
    record = (await readPrivateMaintenanceRecords(stateRoot)).find(value => value.recordId === result.recordId)!;
    assert.equal(record.pendingLinking, undefined);
    assert.equal(record.result.linkingTaskId, "p12-auto-task");
    assert.equal((await recovered.execute(resumeInput)).status, "completed");
    assert.equal(starts, 1, "settled linking does not get duplicated");
    assert.equal(await fs.readFile(path.join(root, "wiki/Gate.md"), "utf8"), committedPage, "linking-only continuation never rewrites the successful page");
    assert.equal(await fs.readFile(path.join(root, "raw/source.md"), "utf8"), committedSource, "linking-only continuation never rewrites source status or backlinks");
  } finally { release(); }
}

async function automaticQueue(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const contents = new Map([
    ["wiki/AI.md", "---\naliases: [人工智能]\n---\n# AI\n概念说明。\n"],
    ["wiki/Source.md", "# Source\n人工智能系统。\n"]
  ]);
  let enabled = true, writes = 0, releaseWrite!: () => void, enteredWrite!: () => void;
  const writeEntered = new Promise<void>(resolve => { enteredWrite = resolve; });
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let gateFirstWrite = true;
  const host: KnowledgeLinkingHost = {
    automaticEnabled: () => enabled,
    bindingSignature: () => "p12-bindings", canWrite: () => true,
    async *documents() { for (const [relative, text] of contents) yield readKnowledgeLinkingDocument(relative, text, `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`); },
    read: async relative => { const text = contents.get(relative); if (text === undefined) throw new Error("missing"); return text; },
    write: async (relative, before, after) => {
      assert.equal(contents.get(relative), before);
      if (gateFirstWrite) { gateFirstWrite = false; enteredWrite(); await writeGate; }
      writes++; contents.set(relative, after);
    },
    judge: async input => input.documents.map(document => ({ path: document.path, version: document.version, mentions: input.candidates.filter(candidate => candidate.path === document.path) }))
  };
  const state = new KnowledgeLinkingStateStore(path.join(root, "state.json"));
  let service = new KnowledgeLinkingService(host, state);
  try {
    await service.ready;
    await service.start("automatic", ["wiki/AI.md"], "p12-first", ["wiki/Source.md"], "p12-origin");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([writeEntered, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Automatic write did not start: ${JSON.stringify(service.snapshot())}`)), 1000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    const queued = await service.start("automatic", ["wiki/AI.md"], "p12-queued", ["wiki/Source.md"], "p12-origin");
    assert.equal(queued.phase, "queued");
    enabled = false; releaseWrite(); await service.waitForIdle();
    assert(writes > 0, "disabling does not interrupt a write already underway");
    assert.equal(service.snapshot()?.phase, "completed");
    assert.equal(service.snapshot()?.queuedAutomatic?.[0].id, "p12-queued", "disabled queues remain persisted without automatic advancement");
    await service.dispose();
    service = new KnowledgeLinkingService(host, state); await service.ready;
    const before = writes;
    await assert.rejects(() => service.start("automatic", ["wiki/AI.md"]), /自动补链已关闭/u);
    assert.equal(writes, before);
    assert.equal(service.snapshot()?.queuedAutomatic?.[0].id, "p12-queued", "reload preserves the blocked queue");
    contents.set("wiki/Manual.md", "# Manual\n人工智能系统。\n");
    await service.start(); await service.waitForIdle();
    assert.equal(service.snapshot()?.mode, "manual");
    assert.equal(service.snapshot()?.phase, "awaiting-confirmation");
    await service.confirm(); await service.waitForIdle();
    assert.equal(service.snapshot()?.phase, "completed");
    assert(contents.get("wiki/Manual.md")?.includes("[[wiki/AI.md|人工智能]]"), "manual linking remains available while automatic linking is disabled");
    enabled = true;
    await service.start("automatic", ["wiki/AI.md"], "p12-queued", ["wiki/Source.md"], "p12-origin");
    for (let attempt = 0; attempt < 50 && (service.snapshot()?.id !== "p12-queued" || service.snapshot()?.phase !== "completed"); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.snapshot()?.id, "p12-queued");
    assert.equal(service.snapshot()?.phase, "completed", "the next formal start advances the enabled queue");
  } finally { releaseWrite(); await service.dispose(); }
}

async function chatRecall(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, directory] of [["wiki", "知识"], ["projects", "项目"], ["raw", "资料"], ["inbox", "收件箱"]] as const) {
    Object.assign(bindings.roles[role], { enabled: true, readPaths: [directory], writePath: directory });
  }
  const bodies = new Map([
    ["收件箱/想法.md", "# 想法\nINBOX_ONLY_TOKEN 独立收件箱线索"],
    ["项目/原结果.md", "# 项目\nPROJECT_STABLE_TOKEN 保持原项目结果"],
    ["普通笔记/已有.md", "# 笔记\nPUBLIC_NOTES_TOKEN 普通笔记仍可召回"],
    ["资料/来源.md", "# 来源\nRAW_ONLY_TOKEN 资料原文"],
    ["私有/记忆.md", "INBOX_ONLY_TOKEN PRIVATE_ONLY_TOKEN"],
    [".echoink/隐藏.md", "INBOX_ONLY_TOKEN HIDDEN_ONLY_TOKEN"]
  ]);
  for (let index = 0; index < 9; index++) bodies.set(`收件箱/分页${index}.md`, "PAGINATION_TOKEN");
  bodies.set("普通笔记/分页.md", "PAGINATION_TOKEN");
  for (const [relative, content] of bodies) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  const file = (relative: string) => ({ path: relative, basename: path.basename(relative, ".md"), extension: "md", stat: { mtime: 1, ctime: 1, size: bodies.get(relative)?.length ?? 0 } });
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (relative: string) => bodies.has(relative) ? file(relative) : null,
    read: async (source: { path: string }) => fs.readFile(path.join(root, source.path), "utf8")
  }, metadataCache: { getFileCache: () => null }, workspace: { getActiveFile: () => null, getLastOpenFiles: () => [] } } as unknown as App;
  const bodySearch = new VaultBodySearch(app, () => bindings, { excludedRoots: () => ["私有"] });
  const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, ".test-state"), bodySearch });
  index.refresh = async () => { throw new Error("chat must use the existing body search without expanding the maintenance index"); };
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const runtime = createProductionPiKnowledgeRuntime({ vaultRootPath: root, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never });
  const request = (question: string, explicitPaths: string[] = []) => ({ conversationId: "p12-chat", question, explicitPaths, includeUnrefined: false });
  const chat = (question: string, paths: string[] = []) => runtime.retrieveChat!(request(question, paths) as never);
  try {
    const inbox = await chat("INBOX_ONLY_TOKEN");
    assert.deepEqual(inbox.references.map(source => source.vaultRelativePath), ["收件箱/想法.md"]);
    assert.equal(inbox.references[0].sourceType, "inbox");
    assert.equal(JSON.parse(inbox.providerResourceText).sources[0].excerpt, inbox.references[0].excerpt);
    const project = await chat("PROJECT_STABLE_TOKEN");
    assert.equal(project.references[0].vaultRelativePath, "项目/原结果.md");
    const ask = await runtime.retrieveAsk(request("INBOX_ONLY_TOKEN", ["收件箱/想法.md"]) as never);
    assert.equal(ask.references.length, 0, "/ask excludes Inbox including an explicit Inbox path");
    assert.equal((await runtime.retrieveAsk(request("PROJECT_STABLE_TOKEN") as never)).references[0].vaultRelativePath, "项目/原结果.md");
    const inboxMaintenance = await runtime.resolveMaintenanceScope!("INBOX_ONLY_TOKEN");
    assert.equal(inboxMaintenance.mode, "query");
    if (inboxMaintenance.mode !== "query") throw new Error("expected Inbox query scope");
    assert.deepEqual(inboxMaintenance.candidatePaths, ["收件箱/想法.md"]);
    assert.deepEqual((await runtime.resolveMaintenanceScope!("资料/来源.md 收件箱/想法.md") as { sourcePaths: readonly string[] }).sourcePaths, ["资料/来源.md", "收件箱/想法.md"], "explicit Raw and Inbox sources are both allowed");
    const maintenance = await runtime.resolveMaintenanceScope!("RAW_ONLY_TOKEN");
    assert.equal(maintenance.mode, "query");
    if (maintenance.mode !== "query") throw new Error("expected query scope");
    assert.deepEqual(maintenance.candidatePaths, ["资料/来源.md"]);
    // Enabled retrieval purposes do not grant source-maintenance authority.
    for (const [role, directory, token] of [["projects", "项目", "PROJECT_STABLE_TOKEN"], ["journal", "日记", "JOURNAL_MAINTENANCE_TOKEN"], ["outputs", "财务", "FINANCE_MAINTENANCE_TOKEN"], ["assets", "附件", "ASSET_MAINTENANCE_TOKEN"], ["templates", "模板", "TEMPLATE_MAINTENANCE_TOKEN"], ["wiki", "知识", "WIKI_MAINTENANCE_TOKEN"]] as const) {
      Object.assign(bindings.roles[role], { enabled: true, searchEnabled: true, readPaths: [directory], writePath: directory });
      const relative = role === "projects" ? "项目/原结果.md" : `${directory}/范围检查.md`;
      if (role !== "projects") {
        bodies.set(relative, `# 范围检查\n${token}`);
        await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await fs.writeFile(path.join(root, relative), bodies.get(relative)!);
      }
      if (role !== "assets" && role !== "templates") assert.ok((await chat(token)).references.some(reference => reference.vaultRelativePath === relative), `${role} can be retrieved without becoming a maintenance source`);
      await assert.rejects(() => runtime.resolveMaintenanceScope!(token), /没有找到/u, `${role} query cannot become a source`);
      await assert.rejects(() => runtime.resolveMaintenanceScope!(relative), /指定来源不在当前资料目录/u, `${role} explicit path cannot become a source`);
    }
    bindings.roles.raw.enabled = false;
    await assert.rejects(() => runtime.resolveMaintenanceScope!("RAW_ONLY_TOKEN"), /没有找到/u, "revoked Raw must stop being a maintenance candidate");
    await assert.rejects(() => runtime.resolveMaintenanceScope!("资料/来源.md"), /指定来源不在当前资料目录/u);
    bindings.roles.raw.enabled = true;
    bindings.roles.inbox.searchEnabled = false;
    assert.equal((await chat("INBOX_ONLY_TOKEN")).references.length, 0);
    bindings.roles.inbox.searchEnabled = true; bindings.roles.inbox.enabled = false;
    assert.equal((await chat("INBOX_ONLY_TOKEN")).references.length, 0);
    await assert.rejects(() => runtime.resolveMaintenanceScope!("INBOX_ONLY_TOKEN"), /没有找到/u, "revoked Inbox must stop being a maintenance candidate");
    await assert.rejects(() => runtime.resolveMaintenanceScope!("收件箱/想法.md"), /指定来源不在当前资料目录/u);
    bindings.inboxRecallExclusions = ["收件箱"];
    bindings.roles.inbox.readPaths = []; bindings.roles.inbox.writePath = null;
    assert.equal((await chat("INBOX_ONLY_TOKEN")).references.length, 0, "withdrawn Inbox must not reappear as ordinary notes");
    assert.equal((await chat("INBOX_ONLY_TOKEN", ["收件箱/想法.md"])).references[0].vaultRelativePath, "收件箱/想法.md", "manual explicit reads retain the existing path");
    const page = await chat("PAGINATION_TOKEN");
    assert.deepEqual(page.references.map(source => source.vaultRelativePath), ["普通笔记/分页.md"], "removed candidates do not hide remaining public notes behind the first page");
    assert.deepEqual((await chat("PROJECT_STABLE_TOKEN")).references, project.references);
    assert.equal((await chat("PUBLIC_NOTES_TOKEN")).references[0].vaultRelativePath, "普通笔记/已有.md");
    assert.equal((await chat("PRIVATE_ONLY_TOKEN")).references.length, 0);
    assert.equal((await chat("HIDDEN_ONLY_TOKEN")).references.length, 0);
    bindings.roles.projects.readPaths.push("收件箱");
    assert.equal((await chat("INBOX_ONLY_TOKEN")).references[0].sourceType, "projects", "a separate enabled purpose retains its own authority");
    bindings.roles.projects.readPaths = ["项目"];
    bindings.roles.inbox.enabled = true; bindings.roles.inbox.readPaths = ["收件箱"]; bindings.roles.inbox.writePath = "收件箱";
    bindings.inboxRecallExclusions = [];
    assert.equal((await chat("INBOX_ONLY_TOKEN")).references[0].sourceType, "inbox");
    const deniedRuntime = createProductionPiKnowledgeRuntime({ vaultRootPath: root, knowledgeAgentIndex: index, knowledgePreferences: {} as never, usage: {} as never, isConversationKnowledgeAllowed: async () => false });
    assert.equal((await deniedRuntime.retrieveChat!(request("INBOX_ONLY_TOKEN") as never)).references.length, 0, "Inbox never bypasses the Agent/global capability intersection");
    await assert.rejects(() => deniedRuntime.retrieveAsk(request("PROJECT_STABLE_TOKEN") as never), /agent_capability_knowledge_denied/u);
    await knowledgeTools(root, index, bindings, inbox.references[0].contentRevision);
  } finally { release(); bodySearch.dispose(); }
}

async function knowledgeTools(root: string, index: KnowledgeAgentIndex, bindings: KnowledgeFolderBindings, inboxRevision: string): Promise<void> {
  let workflow: "chat" | "ask" | "maintain" | "none" = "chat";
  const retriever = createProductionPiKnowledgeToolRetriever(root, index, () => workflow);
  const security = new PiKnowledgeReadToolSecurity({
    currentRunIdentity: () => ({ vaultId: "p12-vault", conversationId: "p12-tools", piSessionId: "p12-session", productRunId: "p12-run" }),
    currentWorkflow: () => workflow,
    egress: new EchoInkVaultToolEgressPolicy()
  });
  const tools = createPiKnowledgeReadToolDefinitions({ retriever, security });
  let sequence = 0;
  const call = async (toolName: "knowledge_search" | "knowledge_read", input: Record<string, unknown>) => {
    const toolCallId = `p12-knowledge-${++sequence}`;
    const blocked = await security.handleToolCall({ toolName, toolCallId, input } as never, undefined);
    assert.equal(blocked, undefined);
    let isError = false;
    try { await tools.find(tool => tool.name === toolName)!.execute(toolCallId, input, undefined, undefined); }
    catch { isError = true; }
    const result = await security.handleToolResult({ toolName, toolCallId, isError } as never);
    return { ...result, resource: (result.isError ? {} : JSON.parse(result.content[0].text)) as { hits?: { vaultRelativePath: string; contentRevision: string }[]; sourceType?: string } };
  };
  const search = (query: string, extra: Record<string, unknown> = {}) => call("knowledge_search", { query, ...extra });
  const inboxRead = () => call("knowledge_read", { vaultRelativePath: "收件箱/想法.md", expectedContentRevision: inboxRevision });
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.[0].vaultRelativePath, "收件箱/想法.md");
  for (const restricted of ["ask", "maintain"] as const) {
    workflow = restricted;
    assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.length, 0, `${restricted} tool search excludes Inbox`);
    assert.equal((await search("INBOX_ONLY_TOKEN", { kinds: ["inbox"] })).resource.hits?.length, 0, "tool arguments cannot override workflow scope");
    assert.equal((await search("PUBLIC_NOTES_TOKEN")).resource.hits?.length, 0);
    assert.equal((await inboxRead()).isError, true, `${restricted} tool read excludes Inbox`);
    assert.equal((await call("knowledge_search", { mode: "related", vaultRelativePath: "收件箱/想法.md" })).isError, true);
    const project = await search("PROJECT_STABLE_TOKEN");
    assert.equal(project.resource.hits?.[0].vaultRelativePath, "项目/原结果.md");
    const source = (await search("RAW_ONLY_TOKEN")).resource.hits?.[0];
    assert(source);
    assert.equal((await call("knowledge_read", { vaultRelativePath: source.vaultRelativePath, expectedContentRevision: source.contentRevision })).isError, false);
    const recent = await call("knowledge_search", { mode: "recent", limit: 20 });
    assert(recent.resource.hits?.every(hit => /^(知识|项目|资料)\//u.test(hit.vaultRelativePath)));
  }
  workflow = "chat";
  bindings.roles.inbox.enabled = false;
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.length, 0);
  bindings.inboxRecallExclusions = ["收件箱"];
  bindings.roles.inbox.readPaths = []; bindings.roles.inbox.writePath = null;
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.length, 0, "chat tool search cannot rediscover withdrawn Inbox as notes");
  assert.equal((await inboxRead()).isError, false, "chat explicit tool read keeps the prior public path authority");
  const page = await search("PAGINATION_TOKEN", { limit: 1 });
  assert.deepEqual(page.resource.hits?.map(hit => hit.vaultRelativePath), ["普通笔记/分页.md"]);
  assert.equal((await search("PUBLIC_NOTES_TOKEN")).resource.hits?.[0].vaultRelativePath, "普通笔记/已有.md");
  assert.equal((await search("PRIVATE_ONLY_TOKEN")).resource.hits?.length, 0);
  assert.equal((await search("HIDDEN_ONLY_TOKEN")).resource.hits?.length, 0);
  bindings.roles.projects.readPaths.push("收件箱");
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.[0].vaultRelativePath, "收件箱/想法.md", "separate purpose authority is retained in tool searches");
  bindings.roles.inbox.readPaths = ["收件箱"]; bindings.roles.inbox.writePath = "收件箱";
  bindings.roles.inbox.enabled = false; bindings.roles.inbox.searchEnabled = true;
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.[0].vaultRelativePath, "收件箱/想法.md", "turning off a shared Inbox keeps the independent project authority");
  bindings.roles.inbox.enabled = true; bindings.roles.inbox.searchEnabled = false;
  assert.equal((await search("INBOX_ONLY_TOKEN")).resource.hits?.[0].vaultRelativePath, "收件箱/想法.md", "turning off Inbox search keeps the independent project authority");
}

async function collectionTargets(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const directory of ["网页资料", "公众号资料", "旧资料"]) await fs.mkdir(path.join(root, directory));
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.raw, { enabled: true, readPaths: ["网页资料", "公众号资料", "旧资料"], writePath: "旧资料" });
  bindings.collectionTargets = { web: "网页资料", wechat: "公众号资料" };
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const capture = new KnowledgeBaseCaptureService({ getVaultPath: () => root } as never);
  let requests = 0;
  let onRequest: (() => void) | undefined;
  const restore = setRequestUrlForTests(async () => {
    requests++; onRequest?.();
    return { status: 200, text: `<html><title>收藏${requests}</title><article><p>这是独立合成正文。</p></article></html>`, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) };
  });
  const collect = (url: string) => capture.captureChatInput("raw-articles", url, []);
  try {
    assert((await collect("https://example.invalid/article"))[0].startsWith("网页资料/"));
    assert((await collect("https://mp.weixin.qq.com/s/synthetic"))[0].startsWith("公众号资料/"));
    assert.equal((await fs.readdir(path.join(root, "旧资料"))).length, 0);
    delete bindings.collectionTargets;
    assert((await collect("https://example.invalid/legacy"))[0].startsWith("旧资料/"));
    bindings.collectionTargets = { web: "已解绑", wechat: null };
    const before = requests;
    await assert.rejects(() => collect("https://example.invalid/invalid"), /收藏位置/u);
    await assert.rejects(() => collect("https://mp.weixin.qq.com/s/invalid"), /收藏位置/u);
    assert.equal(requests, before, "invalid targets fail before fetching");
    bindings.collectionTargets.web = "网页资料";
    bindings.collectionTargets.wechat = "消失资料";
    bindings.roles.raw.readPaths.push("消失资料");
    await assert.rejects(() => collect("https://mp.weixin.qq.com/s/gone"), /已失效/u);
    await assert.rejects(() => fs.stat(path.join(root, "消失资料")), { code: "ENOENT" });
    onRequest = () => { bindings.collectionTargets!.web = "旧资料"; };
    await assert.rejects(() => collect("https://example.invalid/rebound"), /已更改/u);
    onRequest = () => { bindings.roles.raw.readPaths = []; };
    await assert.rejects(() => collect("https://example.invalid/unbound"), /收藏位置/u);
    assert.equal((await fs.readdir(path.join(root, "网页资料"))).length, 1, "in-flight rebinding never writes the previous target");
  } finally { restore(); release(); }
}

async function directoryExecution(root: string, stateRoot: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  for (const directory of ["知识", "项目", "资料", "收件箱"]) await fs.mkdir(path.join(root, directory));
  const bindings = emptyKnowledgeFolderBindings();
  for (const [role, directory] of [["wiki", "知识"], ["projects", "项目"], ["raw", "资料"], ["inbox", "收件箱"]] as const) {
    Object.assign(bindings.roles[role], { enabled: true, readPaths: [directory], writePath: directory });
  }
  const release = registerKnowledgeFolderBindings(root, () => bindings);
  const app = { vault: {
    createFolder: async (relative: string) => { await fs.mkdir(path.join(root, relative)); },
    create: async (relative: string, content: string) => { await fs.writeFile(path.join(root, relative), content, { flag: "wx" }); },
    getFileByPath: (relative: string) => ({ path: relative }),
    getAbstractFileByPath: (relative: string) => ({ path: relative })
  } } as unknown as App;
  const adapter = new ObsidianVaultDomainAdapter(app, "p12-vault", root);
  const domain = new VaultDomainService(adapter);
  const identity = { vaultId: adapter.vaultId, conversationId: "p12-conversation", piSessionId: "p12-session", productRunId: "p12-run" };
  const approvals = new FileApprovalTicketStore({ storageRootPath: stateRoot, vaultId: adapter.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: stateRoot, vaultId: adapter.vaultId });
  await approvals.initialize(); await receipts.initialize();
  let allowed = true, confirmations = 0, sequence = 0;
  let access: PiWorkspaceAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" };
  const authorization = createPiVaultProductionAuthorizationPort({ approvals, adapter, currentRunIdentity: () => identity, currentWorkspaceAccess: () => access, userId: "synthetic-user", deviceId: "synthetic-device", confirmation: { confirm: async () => { confirmations++; return allowed; } } });
  const authorize = (toolId: PiVaultToolId, args: Record<string, unknown>) => authorization.authorize({ toolId, arguments: args, toolCallId: `p12-${++sequence}`, policy: PI_VAULT_TOOL_POLICIES[toolId], toolVersion: PI_VAULT_TOOL_VERSION, policyVersion: PI_VAULT_TOOL_POLICY_VERSION, signal: undefined });
  const createArgs = { relativePath: "知识/新分类/笔记.md", content: "正式写入" };
  try {
    await assert.rejects(() => authorize("note_create", createArgs), /tool_policy_blocked/u);
    bindings.allowAgentSubfolders = false;
    await assert.rejects(() => authorize("note_create", createArgs), /tool_policy_blocked/u);
    bindings.allowAgentSubfolders = true;
    assert(knowledgeMayCreateCategoryDirectory(bindings, "知识/新分类"));
    assert(knowledgeMayCreateCategoryDirectory(bindings, "项目/新分类"));
    assert(!knowledgeMayCreateCategoryDirectory(bindings, "资料/新分类"));
    assert(!knowledgeMayCreateCategoryDirectory(bindings, "收件箱/新分类"));
    assert(!knowledgeMayCreateCategoryDirectory(bindings, "未绑定/新分类"));
    assert(!knowledgeMayOrganizeMove(bindings, "知识/原文.md", "知识/新分类/原文.md"));
    await fs.writeFile(path.join(root, "知识/原文.md"), "原文");
    await assert.rejects(() => authorize("note_move", { sourcePath: "知识/原文.md", targetPath: "知识/新分类/原文.md", expectedVersion: "unused" }), /tool_policy_blocked/u);
    access = { ...access, permission: "read-only" };
    await assert.rejects(() => authorize("note_create", createArgs), /tool_policy_blocked/u);
    await assert.rejects(() => authorize("note_delete", { relativePath: "知识/原文.md", expectedVersion: "unused" }), /tool_policy_blocked/u);
    access = { ...access, permission: "workspace-write", mode: "plan" };
    await assert.rejects(() => authorize("note_create", createArgs), /tool_policy_blocked/u);
    access = { ...access, mode: "agent" };
    allowed = false;
    await assert.rejects(() => authorize("note_create", createArgs), /approval_denied/u);
    assert.equal(confirmations, 1, "flag retains write confirmation");
    await assert.rejects(() => fs.stat(path.join(root, "知识/新分类")), { code: "ENOENT" });
    allowed = true;
    const ticket = await authorize("note_create", createArgs);
    assert.equal(ticket.authorizationKind, "approval_ticket");
    if (ticket.authorizationKind !== "approval_ticket") throw new Error("missing write ticket");
    const execution = createPiVaultProductionWriteExecutionPort({ receipts, domainService: domain, adapter });
    const result = await execution.execute({ toolId: "note_create", toolCallId: ticket.toolCallId, arguments: createArgs, authorization: ticket, signal: undefined, onVerifying: () => undefined }, beforeSideEffect => domain.noteCreate({ vaultId: adapter.vaultId, operationIdentity: ticket.operationIdentity, ...createArgs, beforeSideEffect }));
    assert.equal(result.status, "completed");
    assert.equal(result.readbackVerified, true);
    assert.equal(await fs.readFile(path.join(root, createArgs.relativePath), "utf8"), createArgs.content);
    assert.equal((await receipts.readReceipt(ticket.operationIdentity))?.status, "completed", "write has a persisted P4 receipt");
    // Final adapter guard also rejects implicit creation if consent is revoked after authorization.
    const target = { vaultId: adapter.vaultId, vaultRootPath: root, relativePath: "项目/撤销/笔记.md", absolutePath: path.join(root, "项目/撤销/笔记.md") };
    bindings.allowAgentSubfolders = false;
    const denied = await domain.noteCreate({ vaultId: adapter.vaultId, operationIdentity: "revoked-parent", relativePath: target.relativePath, content: "拒绝" });
    assert.notEqual(denied.status, "completed");
    await assert.rejects(() => fs.stat(path.dirname(target.absolutePath)), { code: "ENOENT" });
    bindings.roles.wiki.allowedSubdirectories = ["旧分类/叶子"];
    assert(knowledgeMayCreateCategoryDirectory(bindings, "知识/旧分类"));
    assert(knowledgeMayCreateCategoryDirectory(bindings, "知识/旧分类/叶子"));
    bindings.roles.raw.autoOrganizePaths = ["资料"];
    assert(knowledgeMayCreateCategoryDirectory(bindings, "资料/旧整理"));
    assert(knowledgeMayOrganizeMove(bindings, "资料/原文.md", "资料/旧整理/原文.md"));
  } finally { release(); }
}
