import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { WorkspaceLeaf } from "obsidian";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiNativeConversationRuntime } from "../../harness/pi-native/pi-native-conversation-runtime";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../../harness/pi-native/controlled-resources";
import { getBuiltinSkillDefinition, renderBuiltinSkill } from "../../harness/resources/builtin-skills";
import { createPiKnowledgeInlineExtension } from "../../plugin/pi-production-runtime-composition";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions, PI_OBSIDIAN_TOOL_IDS } from "../../harness/pi-native/pi-obsidian-tools";
import { createObsidianNativePort } from "../../plugin/obsidian-native-tools";
import { ObsidianVaultDomainAdapter } from "../../plugin/obsidian-vault-domain-adapter";
import { piWorkspaceAllowsTool } from "../../harness/pi-native/pi-workspace-access";
import { startChatTurn } from "../../ui/codex-view/turn-runner";
import { attachTestConversationRunService } from "../conversation-run-host";
import { EchoInkHomeView } from "../../home/home-view";
import { nativeJournalFixture } from "../native-journal-fixture";
import { openTestNoticeMessages } from "../obsidian-shim";

export async function runDailyJournalPipelineTests(): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-journal-pipeline-")));
  const fixture = await nativeJournalFixture(root);
  const skillPath = path.join(root, "skills/daily-journal/SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, renderBuiltinSkill(getBuiltinSkillDefinition("daily-journal")!));
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, ".test-pi"), vaultId: "journal-pipeline" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, ".test-pi"), vaultId: catalog.vaultId, catalog });
  const requests: any[] = [];
  const providerContexts: any[] = [];
  const providerErrors: string[] = [];
  const sessions: any[] = [];
  const callbacks: Array<(context: any) => any> = [];
  let nativeContextCalls = 0;
  let runId = 0;
  let activeConversationId = "";
  let homeOutcome = "";
  const runtime = new PiNativeConversationRuntime({
    catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root,
    idFactory: () => `journal-pipeline-run-${++runId}`,
    skills: {
      selectForTask: async () => null,
      resolveById: async ({ id }) => ({ id, skillPath, skillName: id, revision: "a".repeat(64), skills: [{ id, skillPath, skillName: id }], applicableSkillIds: [id], requiresFreshnessVerification: false }),
      recordUse: async () => {}, reviewCompletedTask: async () => null
    },
    createAgentSession: async (input) => {
      const provider = fauxProvider({ provider: "offline-journal", api: "openai-completions", models: [{ id: "journal-model", contextWindow: 32_000, maxTokens: 1_024, reasoning: false }] });
      provider.setResponses(Array.from({ length: 8 }, () => (context: any) => {
        providerContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
        const respond = callbacks.shift();
        assert.ok(respond, "no unplanned Provider request");
        try { return respond(context); }
        catch (error) { providerErrors.push(String(error)); throw error; }
      }));
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider);
      const model = provider.getModel();
      const nativeSecurity = new PiObsidianToolSecurity();
      const security = createPiVaultToolSecurityAdapter({
        isToolAllowed: (toolName) => piWorkspaceAllowsTool({ ...input.currentWorkspaceAccess()!, toolName, planToolNames: PI_OBSIDIAN_TOOL_IDS, memoryToolNames: [], externalReadToolNames: [] }),
        authorization: { async authorize() { throw new Error("No ordinary Vault tool in this context-only test"); } },
        resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()),
        additionalToolSecurities: [nativeSecurity]
      });
      const port = createObsidianNativePort(fixture.app, new ObsidianVaultDomainAdapter(fixture.app, catalog.vaultId, root), () => "OLD-CATALOG-DIRECTORY");
      const tools = createPiObsidianToolDefinitions({ ...port, async context() { nativeContextCalls += 1; return await port.context(); } }, nativeSecurity);
      const loader = await createControlledVaultResourceLoader({
        vaultRoot: root,
        skillPaths: input.skillPath ? [input.skillPath] : [...(input.skillPaths ?? [])],
        systemPrompt: "EchoInk offline journal production-chain acceptance.",
        inlineExtension: createPiKnowledgeInlineExtension({
          vaultSecurity: security.inlineExtension,
          currentWorkspaceAccess: input.currentWorkspaceAccess,
          currentTurn: input.currentKnowledgeTurnContext,
          currentSkillTurn: input.currentSkillTurnContext
        })
      });
      const { session } = await createAgentSession({
        cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: loader, ...createControlledPiToolRegistration(tools)
      });
      session.setActiveToolsByName([...PI_OBSIDIAN_TOOL_IDS]);
      sessions.push(session);
      return {
        session, planToolNames: PI_OBSIDIAN_TOOL_IDS,
        ...(input.skillName ? { skillCommandName: loader.bindSelectedSkillCommand(input.skillName) }
          : { skillPromptPrefix: await loader.renderSelectedSkillSetPrompt(input.skillNames ?? []) })
      };
    }
  });
  try {
    await runtime.initialize();
    fixture.plugin.settings.memory.useLongTermMemory = false;
    fixture.plugin.requireAvailableEchoInkSkill = async () => {};
    fixture.plugin.activateView = async () => {};
    fixture.plugin.getCodexView = () => ({ async startHomeConversation(start: any) {
      assert.equal(start.journalDirectory, undefined);
      const entry = await runtime.createConversation({ conversationId: "home-journal", title: start.title, cwd: root, defaultSkillId: start.defaultSkillId });
      activeConversationId = entry.conversationId;
      const shell: any = { id: entry.conversationId, title: entry.title, cwd: root, piSessionId: entry.piSessionId, defaultSkillId: entry.defaultSkillId, messages: [], createdAt: entry.createdAt, updatedAt: entry.updatedAt };
      fixture.plugin.settings.sessions = [shell]; fixture.plugin.settings.activeSessionId = shell.id;
      const plugin = {
        ...fixture.plugin,
        buildRuntimeEchoInkResourceCatalog: async () => [{ id: "echoink-local:skill:daily-journal", kind: "skill", source: "echoink-local", name: "daily-journal", description: "Journal", enabled: true, contentPath: skillPath, metadata: { resourceId: "daily-journal" } }],
        submitPiChat: async (request: any) => { requests.push(request); return await runtime.submit(request); },
        subscribePiRun: (id: string, listener: any) => runtime.subscribeProductRun(id, listener),
        getEchoInkAgentIdentityView: () => ({ displayName: "EchoInk", avatarUrl: null }),
        subscribePiAgentApproval: () => ({ unsubscribe() {} }),
        piAgentApprovalBinding: () => null,
        readPiConversationProjection: (id: string) => runtime.readProjection(id),
        persistPiNativeSettings: async () => {},
        releasePiProductionRun() {}, releasePiConversationIfInactive: async () => false,
        abortPiConversation: (id: string) => runtime.abort(id)
      };
      const view: any = {
        plugin, running: false, activeRunId: "", activeTurnId: "", activeRunKind: "", activeRunSessionId: "", turnStartedAt: 0,
        inputEl: { value: start.message }, attachments: [], selectedSkill: null, messagesBottomFollowPaused: false,
        setPendingInteraction() {}, setSessionTaskPlan() {}, renderTaskPlanDock() {}, renderInteractionDock() {},
        clearComposerDraft() {}, renderTabs() {}, renderMessages() {}, renderMessagesIfActive() {}, renderToolbar() {}, applyStatus() {}, armTurnWatchdog() {}, clearTurnWatchdog() {}, clearActiveRun() { this.activeRunId = ""; }
      };
      const service = attachTestConversationRunService(plugin);
      const detach = service.subscribe({ refresh() {}, clearAcceptedDraft() {}, isTaskVisible: id => plugin.settings.activeSessionId === id });
      try {
      homeOutcome = await startChatTurn(view, shell, {
        id: "home-turn", sessionId: shell.id, text: start.message, attachments: [], skill: null, kind: "chat", createdAt: Date.now(),
        turnOptions: { runtimeProviderId: "offline-journal", model: "journal-model", reasoning: "none", permission: "read-only", mode: "agent", mcpEnabled: false }
      } as never, "composer");
      } finally { detach(); }
    } });
    callbacks.push((context) => {
      const text = JSON.stringify(context);
      assert.match(text, /obsidian_context/);
      assert.match(text, /当前使用 daily-journal Skill/);
      assert.match(text, /## 交谈/);
      assert.doesNotMatch(text, /会话固定日记目录|当前日期：|目标文件：|OLD-CATALOG-DIRECTORY/);
      assert.equal(nativeContextCalls, 0);
      return fauxAssistantMessage("今天有什么想留下的？");
    });
    const home: any = new EchoInkHomeView(new WorkspaceLeaf(), fixture.plugin);
    await home.openConversationAction("daily");
    assert.equal(homeOutcome, "completed", JSON.stringify({ notice: openTestNoticeMessages.at(-1), errors: providerErrors, requests: providerContexts.length, assistantErrors: sessions.flatMap((session) => session.messages.filter((message: any) => message.errorMessage).map((message: any) => message.errorMessage)) }));
    assert.equal(requests[0]?.skillPath, undefined, "homepage default is resolved by runtime, not mislabeled as an explicit selection");
    assert.equal(nativeContextCalls, 0);

    callbacks.push((context) => { assert.match(JSON.stringify(context), /当前使用 daily-journal Skill/); return fauxAssistantMessage("继续聊这件事。"); });
    const explicit = await runtime.submit({ conversationId: activeConversationId, text: "继续聊聊", submittedAt: Date.now(), runtimeProviderId: "offline-journal", modelId: "journal-model", reasoning: "none", permission: "read-only", skillId: "daily-journal", skillPath, skillName: "daily-journal" });
    assert.equal((await explicit.result).terminalState, "completed");
    assert.equal(nativeContextCalls, 0, "explicit daily-journal also has no opening file probes");
    fixture.records["daily-notes"].instance.options = { folder: "current-notes", format: "YYYY-MM/YYYY-MM-DD", template: "templates/current.md" };
    await fixture.write("templates/current.md", '# {{date:YYYY-MM-DD}}\nCURRENT_TEMPLATE');
    callbacks.push(() => fauxAssistantMessage(fauxToolCall("obsidian_context", {}, { id: "save-context" }), { stopReason: "toolUse" }));
    callbacks.push((context) => {
      const text = JSON.stringify(context);
      assert.match(text, /current-notes/);
      assert.match(text, /CURRENT_TEMPLATE/);
      assert.doesNotMatch(text, /OLD-CATALOG-DIRECTORY/);
      assert.equal(nativeContextCalls, 1);
      return fauxAssistantMessage("已取得当前保存位置和模板。");
    });
    const save = await runtime.submit({ conversationId: activeConversationId, text: "准备保存这段日记", submittedAt: Date.now(), runtimeProviderId: "offline-journal", modelId: "journal-model", reasoning: "none", permission: "workspace-write" });
    assert.equal((await save.result).terminalState, "completed");
    assert.equal(callbacks.length, 0);
    // Requests above came from Pi's actual extension/context/convertToLlm lifecycle and reached the faux transport.
    assert.ok(providerContexts[0].messages.length > 0);
    console.log("PASS Home submit -> runtime default/explicit Skill -> production extension/context -> real Pi model request and tool continuation (offline)");
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
}
