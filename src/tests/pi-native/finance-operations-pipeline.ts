import assert from "node:assert/strict";
import * as path from "node:path";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiNativeConversationRuntime } from "../../harness/pi-native/pi-native-conversation-runtime";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../../harness/pi-native/controlled-resources";
import { SkillRuntimeCoordinator } from "../../harness/resources/skill-runtime";
import { createPiKnowledgeInlineExtension } from "../../plugin/pi-production-runtime-composition";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions, PI_OBSIDIAN_TOOL_IDS } from "../../harness/pi-native/pi-obsidian-tools";
import { createObsidianNativePort } from "../../plugin/obsidian-native-tools";
import { ObsidianVaultDomainAdapter } from "../../plugin/obsidian-vault-domain-adapter";
import { FileApprovalTicketStore } from "../../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../../harness/pi-native/domain-receipt-store";
import { piWorkspaceAllowsTool } from "../../harness/pi-native/pi-workspace-access";
import { financeOperationsFixture } from "../finance-operations";

/** Same runtime, controlled-resource loader, production extension and real service
 * as daily-journal-pipeline; only host I/O and Provider responses are fixtures. */
export async function runFinanceOperationsPipelineTests(root: string) {
  const f = await financeOperationsFixture(root);
  const coordinator = new SkillRuntimeCoordinator(root); await coordinator.initialize();
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, ".pi"), vaultId: "finance-pipeline" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId, catalog });
  const approvals = new FileApprovalTicketStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId });
  await approvals.initialize(); await receipts.initialize();
  const contexts: any[] = [], callbacks: ((context: any) => any)[] = [];
  let runSequence = 0, confirmations = 0;
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `finance-run-${++runSequence}`,
    skills: { selectForTask: ({ text }) => coordinator.selectForTask({ text }), resolveById: ({ id }) => coordinator.resolveById(id), recordUse: (id, at) => coordinator.recordUse(id, at), reviewCompletedTask: async () => null },
    createAgentSession: async input => {
      const provider = fauxProvider({ provider: "offline-finance", api: "openai-completions", models: [{ id: "finance-model", contextWindow: 32000, maxTokens: 1024, reasoning: false }] });
      provider.setResponses(Array.from({ length: 20 }, () => (context: any) => { contexts.push(context); const respond = callbacks.shift(); assert.ok(respond, "no unplanned Provider call"); return respond(context); }));
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider); const model = provider.getModel();
      const nativeSecurity = new PiObsidianToolSecurity({ currentAccess: input.currentWorkspaceAccess, currentRunIdentity: () => {
        const context = input.currentToolExecutionContext();
        return { vaultId: context.vaultId, conversationId: context.conversationId, piSessionId: context.piSessionId, productRunId: context.productRunId };
      }, currentUserEntry: () => {
        const context = input.currentToolExecutionContext(); return { entryId: context.userEntryId, text: context.userEntryText };
      }, approvals, receipts, userId: "fixture", deviceId: "fixture", confirmation: { async confirm() { confirmations++; return false; } } });
      const security = createPiVaultToolSecurityAdapter({ isToolAllowed: toolName => piWorkspaceAllowsTool({ ...input.currentWorkspaceAccess()!, toolName, planToolNames: PI_OBSIDIAN_TOOL_IDS, memoryToolNames: [], externalReadToolNames: [] }),
        authorization: { async authorize() { throw new Error("ordinary note tools are outside this fixture"); } }, resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()), additionalToolSecurities: [nativeSecurity] });
      const tools = createPiObsidianToolDefinitions(createObsidianNativePort(f.app, new ObsidianVaultDomainAdapter(f.app, catalog.vaultId, root), () => "", { finance: f.service }), nativeSecurity);
      const loader = await createControlledVaultResourceLoader({ vaultRoot: root, skillPaths: input.skillPath ? [input.skillPath] : [...input.skillPaths ?? []], systemPrompt: "EchoInk finance production-chain fixture.",
        inlineExtension: createPiKnowledgeInlineExtension({ vaultSecurity: security.inlineExtension, currentWorkspaceAccess: input.currentWorkspaceAccess, currentTurn: input.currentKnowledgeTurnContext, currentSkillTurn: input.currentSkillTurnContext }) });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }), resourceLoader: loader, ...createControlledPiToolRegistration(tools) });
      session.setActiveToolsByName([...PI_OBSIDIAN_TOOL_IDS]);
      return { session, planToolNames: PI_OBSIDIAN_TOOL_IDS, ...(input.skillName ? { skillCommandName: loader.bindSelectedSkillCommand(input.skillName) } : input.skillNames?.length ? { skillPromptPrefix: await loader.renderSelectedSkillSetPrompt(input.skillNames) } : {}) };
    }
  });
  const tool = (name: string, args: unknown, id: string) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
  const lastResult = (context: any) => JSON.parse(context.messages.filter((m: any) => m.role === "toolResult").at(-1).content[0].text);
  try {
    await runtime.initialize(); await runtime.createConversation({ conversationId: "finance", title: "Synthetic finance", cwd: root });
    const submit = async (text: string, mode: "agent" | "plan" = "agent", permission = "workspace-write") => {
      const run = await runtime.submit({ conversationId: "finance", text, submittedAt: Date.now(), runtimeProviderId: "offline-finance", modelId: "finance-model", reasoning: "none", permission: permission as any, mode });
      const result = await run.result;
      assert.equal(result.terminalState, "completed", JSON.stringify({ state: result.terminalState, error: result.error?.slice(0, 1000), tools: result.toolCallIds }));
    };
    callbacks.push(context => {
      assert.match(JSON.stringify(context), /# 财务对话操作/);
      for (const name of ["finance_query", "finance_record", "finance_budget", "finance_bill"]) assert.ok(context.tools.some((t: any) => t.name === name));
      return tool("finance_record", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }, "breakfast");
    }, context => { assert.equal(lastResult(context).status, "completed"); assert.equal(lastResult(context).data.record.merchant, ""); return fauxAssistantMessage("已记：今天早餐，支出12元，餐饮。"); });
    await submit("记一下，我今天早餐吃了12块钱");
    assert.equal(confirmations, 0); assert.equal((await f.service.readForConversation()).records.length, 1);
    await f.store.update(d => { d.financeDefaultBudget = { totalCents: 500000, allocations: { 餐饮: 100000, 交通: 70000 } }; });
    callbacks.push(() => tool("finance_budget", { action: "get", scope: "current" }, "read-budget"), context => tool("finance_budget", { action: "update", scope: "current", expectedVersion: lastResult(context).data.expectedVersion, allocations: { 餐饮: 200000 } }, "change-budget"),
      context => { const result = lastResult(context); assert.equal(result.status, "completed"); assert.equal(result.data.after.unallocatedCents, 230000); return fauxAssistantMessage("餐饮预算1000→2000元，总额不变，未分配2300元。"); });
    await submit("把这个月餐饮预算调整到2000元");
    callbacks.push(() => tool("finance_record", { action: "create", record: { amountCents: 1200, category: "餐饮", description: "早餐" } }, "read-only-no-write"), () => fauxAssistantMessage("只读模式未保存。"));
    await submit("记一下早餐12元", "agent", "read-only");
    assert.equal((await f.service.readForConversation()).records.length, 1);
    assert.equal(callbacks.length, 0); assert.ok(contexts.length >= 7);
    console.log("PASS normal automatic Skill selection -> Pi runtime -> production security/extension -> tool continuation -> real finance readback; no skillPath/defaultSkillId/slash, direct command no repeated confirmation and read-only no write (offline Provider fixture)");
  } finally { await runtime.shutdown(); }
}
