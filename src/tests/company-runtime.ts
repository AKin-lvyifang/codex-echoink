import assert from "node:assert/strict";
import { CURRENT_SESSION_VERSION, VERSION, SessionManager, ModelRuntime, SettingsManager, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createControlledPiToolRegistration, createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { normalizeAgentRegistry } from "../agents/registry";
import { checkAgentTool, resolveAgentRunSnapshot } from "../agents/capability-policy";
import { companyHumanTurnBackground, createCompanyRuntimeContext } from "../company/runtime-context";
import { companyRouterPrompt, companyWorkerPrompt } from "../company/prompts";
import { CompanyService, type CompanyHost } from "../company/service";
import { CompanyStore } from "../company/store";
import { recordDirectStaffActivity, startCompanyService } from "../company/plugin-host";
import { CompanyApprovalCoordinator } from "../company/approval-coordinator";
import { PiAgentApprovalBroker } from "../plugin/pi-agent-approval-broker";
import CodexForObsidianPlugin from "../main";
import { ConversationRunService } from "../plugin/conversation-run-service";
import { applyConversationTaskMetadata } from "../agents/task-metadata";
import { activateApiProviderModel, createApiProviderConfig, createApiProviderModelConfig, type StoredSession } from "../settings/settings";
import { Platform } from "obsidian";
import type { QueuedTurnItem } from "../ui/turn-queue";
import { ExpertContentService } from "../experts/service";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import type { PiMcpToolSecurityDescriptor } from "../harness/pi-native/pi-mcp-custom-tool-adapter";
import { piWorkspaceAllowsTool } from "../harness/pi-native/pi-workspace-access";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { registerKnowledgeFolderBindings } from "../knowledge-base/root-paths";
import { DesktopExpertController } from "../plugin/expert-controller";
import { checkPiKnowledgeAction, createPiAgentCapabilityContext, createPiKnowledgeCapabilityPolicy, createPiKnowledgeInlineExtension,
  createProductionPiKnowledgeRuntime, isPiAgentToolPublished, type PiProductionPluginHost } from "../plugin/pi-production-runtime-composition";
import type { EchoInkResource } from "../resources/types";
import { createExpertAccountFixture, expertFixtureFiles, fixtureExpertId } from "./expert-delivery-fixture";
import { nativeJournalFixture } from "./native-journal-fixture";

const writeAccess = { permission: "workspace-write", mode: "agent", memoryMode: "normal" } as const;

export async function runCompanyRuntimeTests(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-company-runtime-")));
  try {
    await knowledgeAndToolPolicies(path.join(root, "vault"));
    await expertWorkerContext(path.join(root, "expert"));
    await programmaticTurnBoundaries(path.join(root, "turns"));
    await legacyRouterTakeover(path.join(root, "legacy"));
    console.log("PASS company runtime: role-aware Knowledge preflight, MCP publication, narrow router reads and expert worker context");
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function knowledgeAndToolPolicies(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root), settings = fixture.plugin.settings;
  settings.agentRegistry = normalizeAgentRegistry(settings.agentRegistry);
  settings.memory.useLongTermMemory = true;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.wiki = { ...bindings.roles.wiki, enabled: true, readPaths: ["Wiki"], writePath: "Wiki" };
  settings.knowledgeBase.folderBindings = bindings;
  const releaseBindings = registerKnowledgeFolderBindings(root, () => bindings);
  const resources: EchoInkResource[] = [{ id: "company-mcp", name: "Fixture MCP", kind: "mcp-server", source: "manual", enabled: true,
    bridgeMode: "structured-tools", description: "Offline test fixture" }];
  const host = { ...fixture.plugin, buildRuntimeEchoInkResourceCatalog: async () => resources } as PiProductionPluginHost;
  const context = (companyRole?: "router" | "worker", agentId = companyRole === "worker" ? "generalist" : "sol") => ({
    ...createPiAgentCapabilityContext(host, agentId, resources, writeAccess), ...(companyRole ? { companyRole } : {})
  });
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "private"), vaultId: "company-runtime" });
  await catalog.initialize();
  for (const [id, agentId, role] of [["router", "sol", "router"], ["worker", "generalist", "worker"], ["classic", "sol", undefined]] as const) {
    await catalog.upsert({ conversationId: id, piSessionId: `session-${id}`, vaultId: catalog.vaultId, title: id, status: "active",
      defaultMemoryMode: "normal", agentId, ...(role ? { companyRole: role } : {}), createdAt: 1, updatedAt: 1 });
  }
  try {
    await fixture.write("Wiki/evidence.md", "---\ntype: concept\n---\n# 计划测试 COMPANY_RUNTIME_EVIDENCE\n计划测试的明确依据。\n");
    const index = new KnowledgeAgentIndex({ vaultPath: root, storageRootPath: path.join(root, "private", "knowledge") });
    let indexCalls = 0;
    const search = index.search.bind(index), read = index.read.bind(index);
    index.search = async request => { indexCalls++; return await search(request); };
    index.read = async request => { indexCalls++; return await read(request); };
    const policy = createPiKnowledgeCapabilityPolicy(host, catalog);
    const knowledge = createProductionPiKnowledgeRuntime({ vaultRootPath: root, knowledgeAgentIndex: index,
      knowledgePreferences: {} as never, usage: {} as never, ...policy });
    const request = { vaultId: catalog.vaultId, conversationId: "router", piSessionId: "session-router", productRunId: "preflight",
      question: "计划测试", explicitPaths: ["Wiki/evidence.md"], includeUnrefined: false };
    const chat = await knowledge.retrieveChat!(request);
    assert.match(chat.providerResourceText, /COMPANY_RUNTIME_EVIDENCE/u);
    assert.match((await knowledge.retrieveAsk(request)).providerResourceText, /COMPANY_RUNTIME_EVIDENCE/u);
    assert.ok(indexCalls > 0, "router user requests reach real Knowledge retrieval");
    assert.equal(checkPiKnowledgeAction(context("router"), "read").allowed, true);
    for (const effect of ["resource", "write"] as const) assert.equal(checkPiKnowledgeAction(context("router"), effect).reason, "router_only");
    for (const id of ["worker", "classic"]) {
      assert.equal(await policy.isConversationKnowledgeAllowed(id, false), true);
      const result = await knowledge.retrieveAsk({ ...request, conversationId: id, piSessionId: `session-${id}` });
      assert.equal(result.status, "ready", `${id} retains the real Knowledge retrieval path`);
      assert.match(result.providerResourceText, /COMPANY_RUNTIME_EVIDENCE/u);
    }
    assert.ok(indexCalls > 0, "worker and classic requests actually reach production retrieval");
    const classic = (await catalog.get("classic"))!;
    await catalog.updateTaskMetadata("classic", { companyRole: "router" }, classic.taskMetadataUpdatedAt);
    assert.equal(await policy.isConversationKnowledgeAllowed("classic", false), true, "router retains read-only Knowledge");
    assert.equal(await policy.isConversationKnowledgeAllowed("classic", true), false, "writes read current catalog metadata");

    const router = context("router");
    for (const tool of ["note_read", "memory_search", "memory_read", "knowledge_search", "knowledge_read", "explore_concept"]) {
      assert.equal(isPiAgentToolPublished(router, tool), true, tool);
      assert.equal(checkAgentTool(router, tool, tool === "note_read" ? { relativePath: "Wiki/evidence.md" } : {}).allowed, true, tool);
    }
    for (const tool of ["memory_write", "note_create", "knowledge_maintain", "vault_search", "web_search", "project_start", "approval_decide"]) {
      assert.equal(isPiAgentToolPublished(router, tool), false, tool);
      assert.equal(checkAgentTool(router, tool, {}).allowed, false, tool);
    }
    for (const tool of ["task_dispatch", "company_roster", "task_status", "project_propose", "knowledge_read"]) {
      assert.equal(checkAgentTool(context("router", "generalist"), tool).allowed, false, "user-created Agents cannot impersonate the router");
    }
    assert.equal(checkAgentTool({ ...router, access: { ...writeAccess, memoryMode: "no_memory" } }, "memory_read", {}).reason, "memory_disabled");
    assert.equal(piWorkspaceAllowsTool({ ...writeAccess, permission: "read-only", toolName: "project_start", planToolNames: [], memoryToolNames: [], externalReadToolNames: [] }), false);
    for (const role of [undefined, "worker", "router"] as const) assert.equal(checkAgentTool(context(role), "project_start").allowed, false);

    const descriptor: PiMcpToolSecurityDescriptor = { name: "company_mcp_read", resourceId: resources[0].id, resourceName: resources[0].name,
      toolName: "read", readOnly: true, destructive: false, approvalToolId: "mcp_fixture" as PiMcpToolSecurityDescriptor["approvalToolId"],
      contractFingerprint: "fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
    const writeDescriptor = { ...descriptor, name: "company_mcp_write", toolName: "write", readOnly: false };
    for (const target of [descriptor, writeDescriptor]) {
      assert.equal(isPiAgentToolPublished(router, target.name, target), false, "router never receives MCP definitions");
      assert.equal(isPiAgentToolPublished(context("worker"), target.name, target), true, "workers keep admitted MCP tools");
      assert.equal(isPiAgentToolPublished(context(), target.name, target), true, "classic tasks keep admitted MCP tools");
    }
    assert.equal(isPiAgentToolPublished({ ...context("worker"), access: { ...writeAccess, permission: "read-only" } }, writeDescriptor.name, writeDescriptor), false);
    resources[0].enabled = false;
    assert.equal(isPiAgentToolPublished(context("worker"), descriptor.name, descriptor), false, "full publication checks the MCP resource state");
    resources[0].enabled = true;
    settings.agentRegistry.agents.find(agent => agent.id === "generalist")!.disabledCapabilityIds = ["mcp:company-mcp:read"];
    assert.equal(isPiAgentToolPublished(context("worker"), descriptor.name, descriptor), false, "Agent MCP revocation still applies");
    assert.equal(fixture.providerCalls(), 0);
  } finally { releaseBindings(); }
}

async function expertWorkerContext(root: string): Promise<void> {
  const hadWindow = "window" in globalThis, previousWindow = globalThis.window;
  if (!hadWindow) Object.assign(globalThis, { window: globalThis });
  const fixture = await nativeJournalFixture(root);
  const account = await createExpertAccountFixture();
  try {
    const host = { ...fixture.plugin, manifest: { dir: ".obsidian/plugins/company-runtime", version: "2.8.10" }, accountService: account.service,
      mutateExpertRegistry: async (mutate: (registry: typeof fixture.plugin.settings.agentRegistry) => void) => mutate(fixture.plugin.settings.agentRegistry) };
    const content = new ExpertContentService({ files: expertFixtureFiles(root), cacheRoot: "expert-cache", account: () => account.service,
      pluginVersion: "2.8.10", platform: "desktop", now: account.now });
    const controller = new DesktopExpertController(host as never);
    Object.defineProperty(controller, "content", { value: content });
    const agentId = await controller.hire(fixtureExpertId);
    account.version("fixture-2");
    let preparations = 0;
    const runtime = createCompanyRuntimeContext({ prepareExpertRuntime: async (id, conversationId, text) => {
      preparations++; assert.equal(id, agentId); assert.equal(conversationId, "expert-worker"); assert.equal(text, "项目计划");
      return await controller.prepare(id, conversationId, text);
    } });
    const agent = () => host.settings.agentRegistry.agents.find((candidate: { id: string }) => candidate.id === agentId)!;
    const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentTurn: () => null, currentWorkspaceAccess: () => writeAccess,
      currentAgentSnapshot: () => resolveAgentRunSnapshot(host.settings, agentId),
      privateAgentContext: text => runtime.prepare({ agent: agent(), conversationId: "expert-worker", text, companyPrompt: companyWorkerPrompt() }) });
    const events = new Map<string, (...args: any[]) => any>();
    const factory = typeof extension === "function" ? extension : extension.factory;
    await factory({ on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler) } as never);
    const result = await events.get("before_agent_start")!({ prompt: "项目计划", systemPrompt: "Base product rules" });
    assert.equal(preparations, 1, "company worker context must invoke the production expert controller");
    assert.match(result.systemPrompt, /echoink_company_worker/u);
    assert.match(result.systemPrompt, /SYNTHETIC PRIVATE PERSONA fixture-2/u);
    assert.match(result.systemPrompt, /SYNTHETIC PRIVATE PLAN fixture-2/u);
    assert.equal(agent().expert.packageVersion, "fixture-2", "production preparation refreshes the public expert package version");
    assert.equal(agent().expert.lastConversationId, "expert-worker");
    assert.doesNotMatch(JSON.stringify(host.settings.agentRegistry), /SYNTHETIC PRIVATE/u, "private package content stays transient");
    runtime.assertAvailable();
    agent().expert.packageVersion = "changed";
    assert.throws(() => runtime.assertAvailable(), /版本已变化/u);
    agent().expert.packageVersion = "fixture-2";
    agent().expert.hired = false;
    assert.throws(() => runtime.assertAvailable(), /解聘/u);
    await assert.rejects(events.get("before_agent_start")!({ prompt: "项目计划", systemPrompt: "Base product rules" }), /agent_capability_agent_missing/u);
    await assert.rejects(runtime.prepare({ agent: agent(), conversationId: "expert-worker", text: "项目计划", companyPrompt: companyWorkerPrompt() }), /解聘/u);
    agent().expert.hired = true;
    await runtime.prepare({ agent: agent(), conversationId: "expert-worker", text: "项目计划", companyPrompt: companyWorkerPrompt() });
    await account.service.actions.signOut();
    assert.throws(() => runtime.assertAvailable(), "expired expert authorization must block later output/tool boundaries");
    await assert.rejects(createCompanyRuntimeContext({}).prepare({ agent: agent(), conversationId: "expert-worker", text: "项目计划", companyPrompt: companyWorkerPrompt() }), /尚未就绪/u);
    const ordinary = host.settings.agentRegistry.agents[0];
    assert.equal(await createCompanyRuntimeContext({}).prepare({ agent: ordinary, conversationId: "classic", text: "hello", companyPrompt: "" }), "");
    assert.equal(fixture.providerCalls(), 0);
  } finally {
    account.service.dispose();
    if (!hadWindow) Reflect.deleteProperty(globalThis, "window"); else Object.assign(globalThis, { window: previousWindow });
  }
}

/** Real durable Pi sessions and native faux transport verify the submitted-turn boundary offline. */
async function programmaticTurnBoundaries(root: string): Promise<void> {
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "private"), vaultId: "company-programmatic" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, "private"), vaultId: catalog.vaultId, catalog });
  let retrievals = 0, memoryPreparations = 0, providers = 0, sequence = 0;
  const scopes: Array<string | undefined> = [], publications: string[][] = [], providerContexts: string[] = [];
  let approvalCoordinator: CompanyApprovalCoordinator | undefined;
  const approvalBroker = new PiAgentApprovalBroker();
  const noBackgroundAction = async () => { throw new Error("staff background must not start work"); };
  const backgroundHost: CompanyHost = { now: () => 1, newId: () => "unused", agents: () => [{ id: "generalist", name: "通才", position: "", hired: true }], routerPermission: () => "read-only",
    createWorker: noBackgroundAction, startTurn: noBackgroundAction, isRunning: () => false, steer: noBackgroundAction, stop: noBackgroundAction,
    lastAssistantText: noBackgroundAction, latestUserText: noBackgroundAction, setRouterMetadata: noBackgroundAction, ensureFolder: noBackgroundAction, notifyDecision: noBackgroundAction };
  const backgroundCompany = new CompanyService(new CompanyStore(path.join(root, "company.v1.json")), backgroundHost);
  const retrieve = async () => { retrievals++; return { status: "no_evidence" as const, references: [], providerResourceText: "" }; };
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
      open: (file, sessionRoot, cwd) => SessionManager.open(file, sessionRoot, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `program-run-${++sequence}`,
    knowledge: { retrieveAsk: retrieve, retrieveChat: retrieve, recordUsage: async () => undefined,
      verifyAskReferences: async (input: { references: readonly unknown[] }) => ({ status: "verified", references: input.references }) } as never,
    createAgentSession: async input => {
      scopes.push(input.companyApprovalKey);
      const provider = fauxProvider({ provider: "company-offline", api: "openai-completions",
        models: [{ id: "company-offline-model", reasoning: false, contextWindow: 32000, maxTokens: 1024 }] });
      provider.setResponses(Array.from({ length: 6 }, () => async (context: { tools?: readonly { name: string }[] }) => {
        providers++; publications.push((context.tools ?? []).map(tool => tool.name)); providerContexts.push(JSON.stringify(context)); return fauxAssistantMessage("离线测试完成。");
      }));
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider);
      const model = provider.getModel();
      const approval = input.companyApprovalKey ? approvalCoordinator?.decisionTool("router-turns", input.companyApprovalKey) : undefined;
      const inlineExtension = createPiKnowledgeInlineExtension({ vaultSecurity: pi => { pi.on("tool_call", () => {}); pi.on("tool_result", event => ({ content: event.content, details: event.details, isError: event.isError })); }, currentTurn: input.currentKnowledgeTurnContext,
        privateAgentContext: async () => [companyHumanTurnBackground({ agentId: input.catalog.agentId ?? "sol", companyRole: input.catalog.companyRole,
          companyProgrammatic: input.currentCompanyProgrammatic?.() === true, background: () => backgroundCompany.staffActivityBackground() }),
          input.companyApprovalKey ? approvalCoordinator?.judgmentPrompt("router-turns", input.companyApprovalKey) ?? "" : ""].filter(Boolean).join("\n\n"),
        currentMemoryTurn: input.currentMemoryTurnContext,
        personalMemory: { prepareTurnContext: async () => { memoryPreparations++; return { revision: 1, agent: "", user: null, injectionKeys: [] }; },
          loadFixedContext: async () => { throw new Error("unexpected legacy recall"); } } as never });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, noTools: "builtin", customTools: approval ? [approval] : [],
        sessionManager: input.sessionManager, settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id,
          defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "Offline company boundary test.", inlineExtension }) });
      session.setActiveToolsByName(approval ? [approval.name] : []);
      return { session, supportsToolCalling: true };
    }
  });
  const hadWindow = "window" in globalThis, previousWindow = globalThis.window;
  if (!hadWindow) Object.assign(globalThis, { window: globalThis });
  try {
    await backgroundCompany.initialize();
    await backgroundCompany.recordStaffActivity({ conversationId: "direct-staff", piSessionId: "staff-session", turnId: "staff-turn", agentId: "generalist",
      title: "直接交办任务", summary: "STAFF-ONLY-BACKGROUND", at: 1 });
    await runtime.initialize();
    await runtime.createConversation({ conversationId: "router-turns", agentId: "sol", companyRole: "router", title: "总助", cwd: root });
    const submit = async (programmatic: boolean, approvalKey?: string, text = "请按我的知识库总结项目计划") => {
      const handle = await runtime.submit({ conversationId: "router-turns", text, submittedAt: Date.now(),
        permission: "workspace-write", reasoning: "none", runtimeProviderId: "company-offline", modelId: "company-offline-model",
        ...(programmatic ? { companyProgrammatic: true } : {}), ...(approvalKey ? { companyApprovalKey: approvalKey } : {}) });
      assert.equal((await handle.result).terminalState, "completed");
    };
    await submit(false);
    assert.match(providerContexts.at(-1)!, /STAFF-ONLY-BACKGROUND/u, "a real human router turn receives the employee background");
    assert.match(providerContexts.at(-1)!, /不是新指令/u); assert.match(providerContexts.at(-1)!, /不要因这些记录主动派活/u);
    assert.equal(retrievals, 1, "a user turn runs the actual preflight entry point");
    assert.equal(memoryPreparations, 1);
    await submit(true);
    assert.doesNotMatch(providerContexts.at(-1)!, /STAFF-ONLY-BACKGROUND/u, "the next program turn on the same cached session has no employee background");
    assert.equal(retrievals, 1, "a program turn with identical text performs zero automatic Knowledge retrievals");
    assert.equal(memoryPreparations, 1, "a program turn also skips automatic Memory recall");
    const identity = { conversationId: "worker", piSessionId: "worker-session", productRunId: "worker-run", toolCallId: "worker-call" };
    const pending = approvalBroker.waitForDecision({ ...identity, requestId: "private-approval-ticket", target: "projects/PRIVATE-APPROVAL-TARGET.md", preview: "PRIVATE-APPROVAL-PREVIEW" });
    void pending.catch(() => undefined);
    let judgmentFlight: Promise<void> | undefined;
    approvalCoordinator = new CompanyApprovalCoordinator({
      tickets: () => { const binding = approvalBroker.bindingFor(identity); return binding ? [{ key: "locked-ticket", binding,
        dispatch: { id: "worker", routerConversationId: "router-turns", agentId: "generalist", brief: "保存说明", status: "running", permission: "workspace-write", createdAt: 1, turns: 1 } }] : []; },
      canJudge: () => true, isRunning: () => false, changed() {}, subscribe: () => () => {}, record: async () => undefined,
      run: async (_router, key, text) => { judgmentFlight = submit(true, key, text); await judgmentFlight; }
    });
    approvalCoordinator.start(); await judgmentFlight;
    assert.deepEqual(publications.at(-1), ["approval_decide"]);
    assert.doesNotMatch(providerContexts.at(-1)!, /STAFF-ONLY-BACKGROUND/u, "approval turns do not inject employee background");
    assert.match(providerContexts.at(-1)!, /PRIVATE-APPROVAL-PREVIEW/u, "the real provider receives the private ticket preview");
    assert.match(providerContexts.at(-1)!, /PRIVATE-APPROVAL-TARGET/u);
    const publicApproval = (await runtime.readProjection("router-turns")).messages.filter(message => message.role === "user").at(-1)!;
    assert.equal(publicApproval.text, "请判断「保存说明」的员工操作。");
    assert.doesNotMatch(publicApproval.text, /approval_decide|PRIVATE-APPROVAL|permission|preview|target|\{/u);
    const persisted = await readFile((await catalog.get("router-turns"))!.sessionFile!, "utf8");
    assert.doesNotMatch(persisted, /PRIVATE-APPROVAL-PREVIEW|PRIVATE-APPROVAL-TARGET/u, "transient ticket details never enter the durable user conversation");
    await submit(false);
    assert.match(providerContexts.at(-1)!, /STAFF-ONLY-BACKGROUND/u);
    assert.doesNotMatch(await readFile((await catalog.get("router-turns"))!.sessionFile!, "utf8"), /STAFF-ONLY-BACKGROUND/u, "employee background never becomes a conversation message");
    assert.deepEqual(publications.at(-1), [], "the next everyday turn has no approval tool");
    assert.deepEqual(scopes, [undefined, "locked-ticket", undefined], "entering and leaving approval scope refreshes the real session registry");
    assert.equal(retrievals, 2); assert.equal(memoryPreparations, 2); assert.equal(providers, 4);
  } finally { approvalCoordinator?.dispose(); approvalBroker.dispose(); await runtime.shutdown(); if (!hadWindow) Reflect.deleteProperty(globalThis, "window"); else Object.assign(globalThis, { window: previousWindow }); }
}

/** A legacy card goes through the real run owner, metadata patch and cached native session. */
async function legacyRouterTakeover(root: string): Promise<void> {
  const fixture = await nativeJournalFixture(root), settings = fixture.plugin.settings;
  settings.agentRegistry = normalizeAgentRegistry(settings.agentRegistry);
  const provider = createApiProviderConfig("custom", "company-legacy-offline");
  provider.baseUrl = "https://offline.example/v1"; provider.apiKey = "synthetic-offline-fixture";
  const selected = createApiProviderModelConfig("custom", "company-legacy-model");
  selected.reasoning = false; selected.reasoningEnabled = false;
  provider.models = [selected]; provider.defaultModelId = selected.id;
  settings.apiProviders = [provider]; activateApiProviderModel(settings, provider, selected.id);
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "private"), vaultId: "legacy-company" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, "private"), vaultId: catalog.vaultId, catalog });
  const sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>["session"]>();
  const activations = new Map<string, number>(), contexts = new Map<string, string[]>(), answers = new Map<string, string>();
  const gates = new Map<string, { promise: Promise<void>; resolve(): void }>();
  let plugin: CodexForObsidianPlugin, sequence = 0;
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `legacy-company-${++sequence}`,
    createAgentSession: async input => {
      const id = input.catalog.conversationId;
      activations.set(id, (activations.get(id) ?? 0) + 1);
      const faux = fauxProvider({ provider: provider.runtimeProviderId, api: "openai-completions",
        models: [{ id: selected.id, reasoning: false, contextWindow: 32000, maxTokens: 1024 }] });
      faux.setResponses(Array.from({ length: 20 }, () => async (context, options) => {
        const recorded = contexts.get(id) ?? []; recorded.push(JSON.stringify(context)); contexts.set(id, recorded);
        const gate = gates.get(id);
        if (gate) {
          const aborted = new Promise<void>(resolve => { if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener("abort", () => resolve(), { once: true }); });
          await Promise.race([gate.promise, aborted]);
        }
        return fauxAssistantMessage(answers.get(id) ?? `OFFLINE-ANSWER:${id}`);
      }));
      const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      models.registerNativeProvider(faux.provider); const model = faux.getModel();
      const context = { ...createPiAgentCapabilityContext(plugin, input.catalog.agentId ?? "sol", [], writeAccess),
        ...(input.catalog.companyRole ? { companyRole: input.catalog.companyRole } : {}) };
      const tools = ["note_read", "memory_write", "workspace_update", "task_dispatch"].filter(name => isPiAgentToolPublished(context, name)).map(name =>
        defineTool({ name, label: name, description: "Offline publication fixture; never executed.", parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text" as const, text: "offline" }], details: {} }) }));
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models, model, ...createControlledPiToolRegistration(tools),
        sessionManager: input.sessionManager, settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off",
          compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: root,
          systemPrompt: input.catalog.companyRole === "router" ? companyRouterPrompt() : "Legacy classic assistant.",
          inlineExtension: createPiKnowledgeInlineExtension({ vaultSecurity: pi => { pi.on("tool_call", () => {}); pi.on("tool_result", event => ({ content: event.content, details: event.details, isError: event.isError })); },
            currentTurn: input.currentKnowledgeTurnContext, privateAgentContext: async () => companyHumanTurnBackground({
              agentId: input.catalog.agentId ?? "sol", companyRole: input.catalog.companyRole,
              companyProgrammatic: input.currentCompanyProgrammatic?.() === true, background: () => plugin.companyService?.staffActivityBackground() ?? "" }) }) }) });
      session.setActiveToolsByName(tools.map(tool => tool.name)); sessions.set(id, session); return { session };
    }
  });
  const local = { catalog };
  plugin = Object.assign(Object.create(CodexForObsidianPlugin.prototype), { settings, app: fixture.app, piRuntimeBundle: { runtime },
    piTaskMetadataWriteTails: new Map(), piTaskMetadataSyncTail: Promise.resolve(), conversationCatalogListeners: new Set(),
    companyService: {}, ensurePiLocalData: async () => local, getVaultPath: () => root, getCodexView: () => null,
    getKnowledgeActivitySource: () => null, buildRuntimeEchoInkResourceCatalog: async () => [],
    saveSettings: async () => undefined, persistPiNativeSettings: async () => undefined, externalizeMessageText: async () => undefined,
    onWorkbenchMessageAccepted: async () => undefined, notifyHomeSurfacesChanged() {},
    submitPiChat: (request: Parameters<PiNativeConversationRuntime["submit"]>[0]) => runtime.submit(request),
    readPiConversationProjection: (id: string) => runtime.readProjection(id),
    subscribePiRun: (id: string, listener: Parameters<PiNativeConversationRuntime["subscribeProductRun"]>[1]) => runtime.subscribeProductRun(id, listener),
    subscribePiAgentApproval: () => ({ unsubscribe() {} }), piAgentApprovalBinding: () => null,
    isPiProductionRun: () => true, releasePiProductionRun: (id: string) => runtime.releaseProductRun(id),
    releasePiConversationIfInactive: async () => undefined, abortPiConversation: (id: string) => runtime.abort(id) });
  const releases: Array<() => void> = [];
  Object.assign(plugin, { getPluginDataDirName: () => ".obsidian/plugins/company-staff-fixture", register: (release: () => void) => { releases.push(release); } });
  const service = plugin.getConversationRunService();
  const item = (id: string, text: string): QueuedTurnItem => ({ id: `turn-${id}-${++sequence}`, sessionId: id, text, attachments: [], skill: null, kind: "chat", createdAt: Date.now(),
    turnOptions: { providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId, model: selected.id, reasoning: "none", permission: "workspace-write", mode: "agent", mcpEnabled: false } });
  const request = (id: string, text: string) => ({ conversationId: id, text, submittedAt: Date.now(), providerSettingsId: provider.id,
    runtimeProviderId: provider.runtimeProviderId, modelId: selected.id, permission: "workspace-write" as const, reasoning: "none" as const });
  const create = async (id: string, agentId = "sol") => {
    const entry = await runtime.createConversation({ conversationId: id, agentId, title: id, cwd: root });
    const shell: StoredSession = { id, title: id, cwd: root, messages: [], bodyAuthority: "pi_session_only", piSessionId: entry.piSessionId, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    applyConversationTaskMetadata(shell, entry); settings.sessions.push(shell); return entry;
  };
  const previousDesktop = Platform.isDesktopApp, hadWindow = "window" in globalThis, previousWindow = globalThis.window;
  Platform.isDesktopApp = true;
  if (!hadWindow) Object.assign(globalThis, { window: globalThis });
  try {
    await runtime.initialize();
    const company = await startCompanyService(plugin); assert.ok(company);
    const original = await create("legacy-sol");
    await (await runtime.submit(request("legacy-sol", "LEGACY-HISTORY-MUST-STAY"))).result;
    const oldSession = sessions.get("legacy-sol")!;
    assert.ok(oldSession.getActiveToolNames().includes("memory_write"));
    assert.ok(oldSession.getActiveToolNames().includes("workspace_update"));
    assert.equal(await service.run(item("legacy-sol", "请继续处理这件事")), "completed");
    const upgraded = (await catalog.get("legacy-sol"))!;
    assert.equal(upgraded.companyRole, "router");
    assert.equal(upgraded.piSessionId, original.piSessionId); assert.equal(upgraded.sessionFile, original.sessionFile);
    assert.equal(settings.sessions.find((shell: StoredSession) => shell.id === "legacy-sol")!.companyRole, "router");
    assert.equal(activations.get("legacy-sol"), 2, "an already-open classic session is recreated before this continuation");
    assert.notEqual(sessions.get("legacy-sol"), oldSession);
    assert.deepEqual(sessions.get("legacy-sol")!.getActiveToolNames(), ["note_read", "task_dispatch"], "cached direct write tools cannot survive adoption");
    const delivered = contexts.get("legacy-sol")!.at(-1)!;
    assert.match(delivered, /LEGACY-HISTORY-MUST-STAY/u); assert.match(delivered, /echoink_company_router/u);
    assert.match(await readFile(upgraded.sessionFile!, "utf8"), /LEGACY-HISTORY-MUST-STAY/u);
    assert.equal((await runtime.readProjection("legacy-sol")).messages.filter(message => message.role === "user").length, 2);

    await create("old-employee", "generalist");
    const employeeInstruction = "给这句话改不超过15字标题：一只小鸟站在雨后的窗台上，附青松47，只回一行";
    const employeeAnswer = "雨后窗台小鸟 青松47";
    answers.set("old-employee", employeeAnswer);
    // Reproduce an automatic conversation title that is identical to the generated answer.
    await runtime.renameConversation("old-employee", employeeAnswer);
    settings.sessions.find((shell: StoredSession) => shell.id === "old-employee")!.title = employeeAnswer;
    assert.equal(await service.run(item("old-employee", employeeInstruction)), "completed");
    assert.equal((await catalog.get("old-employee"))!.companyRole, undefined);
    assert.ok(sessions.get("old-employee")!.getActiveToolNames().includes("memory_write"));
    for (let attempt = 0; attempt < 100 && company.doc.staffActivities?.length !== 1; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(company.doc.staffActivities!.length, 1, "the actual settled observer records a directly assigned employee task");
    const activity = company.doc.staffActivities![0], employeeRun = (await productRuns.list("old-employee")).at(-1)!;
    assert.equal(activity.turnId, employeeRun.productRunId, "activity identity comes from the saved Pi projection");
    assert.equal(activity.piSessionId, employeeRun.piSessionId); assert.equal(activity.agentId, "generalist");
    assert.equal(activity.title, employeeInstruction, "an answer-shaped automatic title cannot replace the original user request");
    assert.equal(activity.summary, employeeAnswer);
    assert.notEqual(activity.title, activity.summary);
    const employeeStart = settings.sessions.find((shell: StoredSession) => shell.id === "old-employee")!.messages.find(message => message.role === "user")!.createdAt;
    await recordDirectStaffActivity(plugin, company, "old-employee", "completed", employeeStart);
    assert.equal(company.doc.staffActivities!.length, 1, "duplicate settled callbacks for the same formal turn are ignored");
    const employeeTask = settings.sessions.find((shell: StoredSession) => shell.id === "old-employee")!;
    await recordDirectStaffActivity(plugin, company, "old-employee", "failed", employeeStart);
    employeeTask.taskStatus = "waiting"; await recordDirectStaffActivity(plugin, company, "old-employee", "completed", employeeStart); employeeTask.taskStatus = "completed";
    assert.equal(company.doc.staffActivities!.length, 1, "failed and waiting turns cannot create a completed employee activity");
    assert.equal(contexts.get("legacy-sol")!.length, 2, "recording employee completion never wakes the router model");
    assert.equal(company.doc.dispatches.length, 0, "recording a direct task does not dispatch follow-up work");
    assert.equal(await service.run(item("legacy-sol", "通才刚做了什么？")), "completed");
    const humanRouterContext = contexts.get("legacy-sol")!.at(-1)!;
    assert.ok(humanRouterContext.includes(employeeInstruction), "the next real human provider context receives what the employee was asked to do");
    assert.ok(humanRouterContext.includes(employeeAnswer), "the same provider context also receives the actual result");
    assert.match(company.staffActivityBackground(), /"task":/u); assert.match(company.staffActivityBackground(), /"summary":/u);
    assert.doesNotMatch(await readFile(upgraded.sessionFile!, "utf8"), /青松47/u, "employee activity stays hidden background and creates no conversation message");
    assert.equal(company.doc.dispatches.length, 0);
    assert.equal(await service.run(item("old-employee", "同一员工任务的下一次人工交办")), "completed");
    for (let attempt = 0; attempt < 100 && company.doc.staffActivities?.length !== 2; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    const nextEmployeeRun = (await productRuns.list("old-employee")).at(-1)!;
    assert.equal(company.doc.staffActivities!.length, 2, "a distinct completed turn in the same conversation is retained");
    assert.notEqual(nextEmployeeRun.productRunId, employeeRun.productRunId);
    assert.equal(company.doc.staffActivities!.at(-1)!.turnId, nextEmployeeRun.productRunId);
    await create("direct-program-employee", "generalist");
    const directProgram = item("direct-program-employee", "程序发起的员工轮次"); directProgram.turnOptions.companyProgrammatic = true;
    assert.equal(await service.run(directProgram), "completed");
    assert.equal(company.doc.staffActivities!.length, 2, "a programmatic employee turn is not a directly assigned human task");
    assert.equal(contexts.get("legacy-sol")!.length, 3, "only the explicit human question, not either employee completion, wakes the router");
    await create("old-programmatic");
    const program = item("old-programmatic", "程序汇报"); program.turnOptions.companyProgrammatic = true;
    assert.equal(await service.run(program), "completed");
    assert.equal((await catalog.get("old-programmatic"))!.companyRole, "router");

    // Exercise every structured exclusion in the real run owner without invoking its module workflow.
    const guarded = new ConversationRunService(plugin);
    let moduleStarts = 0;
    Object.assign(guarded, { createHost: () => ({ startQueuedTurnItem: async () => { moduleStarts++; return "completed"; } }) });
    const structured: Array<Partial<QueuedTurnItem>> = [
      { prefillSource: "structured-module-source" }, { maintenanceScope: { mode: "exact", sourcePaths: ["Raw/input.md"] } },
      { pdfTaskRequest: {} as never }, { generationRequest: {} as never }, { englishDiarySourcePath: "Diary/source.md" }
    ];
    for (let index = 0; index < structured.length; index++) {
      const id = `old-module-${index}`; await create(id);
      assert.equal(await guarded.run({ ...item(id, "模块任务"), ...structured[index] }), "completed");
      assert.equal((await catalog.get(id))!.companyRole, "router", "all legacy sol turns adopt the router identity");
    }
    assert.equal(moduleStarts, structured.length); await guarded.dispose();

    const resumeEntry = await create("old-resume");
    let releaseResume!: () => void;
    gates.set("old-resume", { promise: new Promise<void>(resolve => { releaseResume = resolve; }), resolve: () => releaseResume() });
    const interruptedHandle = await runtime.submit(request("old-resume", "INTERRUPTED-ORDINARY-SOL-HISTORY"));
    await runtime.abort("old-resume");
    const interrupted = await interruptedHandle.result;
    assert.equal(interrupted.terminalState, "cancelled"); assert.ok(interrupted.userEntryId);
    gates.get("old-resume")!.resolve(); gates.delete("old-resume");
    const oldResumeSession = sessions.get("old-resume")!;
    assert.ok(oldResumeSession.getActiveToolNames().includes("memory_write"));
    await plugin.setPiConversationTaskMetadata("old-resume", { taskStatus: "interrupted", taskInterruptedAt: Date.now() });
    const resumed = item("old-resume", "继续原来的任务");
    resumed.resumeContext = { interruption: { at: Date.now(), reason: "user_stopped", stage: "" }, safety: {
      conversationId: "old-resume", piSessionId: resumeEntry.piSessionId, interruptedRunId: interrupted.productRunId,
      interruptedUserEntryId: interrupted.userEntryId, originalUserEntryId: interrupted.userEntryId,
      taskRunIds: [interrupted.productRunId], preparedAt: Date.now(), operations: [], pendingActions: [], fileVersions: [], fileConflicts: [], pdfOperations: [],
      recoveryInstructions: "继续原来的任务，保留已完成的内容。" } };
    assert.equal(await service.run(resumed), "completed");
    assert.equal((await catalog.get("old-resume"))!.companyRole, "router", "recovery facts do not exempt an ordinary sol continuation from router adoption");
    assert.equal((await catalog.get("old-resume"))!.piSessionId, resumeEntry.piSessionId);
    assert.notEqual(sessions.get("old-resume"), oldResumeSession);
    assert.deepEqual(sessions.get("old-resume")!.getActiveToolNames(), ["note_read", "task_dispatch"]);
    assert.match(contexts.get("old-resume")!.at(-1)!, /INTERRUPTED-ORDINARY-SOL-HISTORY/u);

    await create("busy-role");
    let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); gates.set("busy-role", { promise, resolve });
    const busy = await runtime.submit(request("busy-role", "等待中的旧任务"));
    const current = (await catalog.get("busy-role"))!;
    await assert.rejects(runtime.setConversationTaskMetadata("busy-role", { agentId: "sol", companyRole: "router" }, current.taskMetadataUpdatedAt), /运行期间不能更换公司角色/u);
    assert.equal((await catalog.get("busy-role"))!.companyRole, undefined, "busy role changes never modify the catalog");
    resolve(); await busy.result;
  } finally {
    for (const gate of gates.values()) gate.resolve();
    for (const release of releases.reverse()) release();
    await service.dispose(); await runtime.shutdown(); Platform.isDesktopApp = previousDesktop;
    if (!hadWindow) Reflect.deleteProperty(globalThis, "window"); else Object.assign(globalThis, { window: previousWindow });
  }
}
