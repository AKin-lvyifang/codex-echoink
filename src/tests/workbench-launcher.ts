import assert from "node:assert/strict";
import { launchWorkbenchSignal, answerWorkbenchQuestion, parseWorkbenchTaskSource } from "../home/task-launcher";
import type { WorkbenchSignal, WorkbenchSnapshot } from "../home/workbench-types";
import { defaultTaskWorkspace } from "../agents/task-workspace";
import { TaskNavigationState, consumeAcceptedTaskDraft } from "../ui/codex-view/task-navigation-state";
import { defaultAgentRegistry } from "../agents/registry";
import { PiTurnInteractionBroker } from "../plugin/pi-turn-interaction-broker";
import type { EchoInkQuestionInteraction } from "../types/conversation-turn";
import type CodexForObsidianPlugin from "../main";
import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";
import type { QueuedTurnItem } from "../ui/turn-queue";
import * as path from "node:path";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../harness/pi-native/controlled-resources";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { persistPiActiveLeaf } from "../harness/pi-native/pi-session-durability";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../harness/pi-native/vault-tool-result-safety";
import { freezeWorkbenchTaskSource, workbenchTaskSourceFromEntries, WORKBENCH_CONTEXT_TYPE } from "../home/workbench-context";

export async function runWorkbenchLauncherTests(root?: string): Promise<void> {
  const source = { version: 1 as const, signalId: 1 as const, moduleId: "todos" as const, businessKey: "workbench:todos:due:2026-10-18",
    objects: ["todo-a"], prompt: "排一下这件事", capturedAt: 1000 };
  const signal: WorkbenchSignal = { id: 1, key: source.businessKey, moduleId: "todos", icon: "list-todo", description: "1 件待办", prompt: source.prompt, source };
  let current = { ...signal, prompt: "排一下这两件事", source: { ...source, prompt: "排一下这两件事", objects: ["todo-a", "todo-b"] } };
  let visible = true;
  const data = { load: async (): Promise<WorkbenchSnapshot> => ({ generatedAt: 2000, signals: visible ? [current] : [], todayTodos: [], modules: ["todos"], issues: [] }) };
  const workspace = defaultTaskWorkspace();
  const navigation = new TaskNavigationState(() => workspace);
  const registry = defaultAgentRegistry();
  registry.agents.push({ ...registry.agents[0], id: "planner", name: "安排员" });
  registry.moduleOwners.todos = "planner";
  const opened: string[] = [];
  const plugin = {
    settings: { agentRegistry: registry, settingsLanguage: "zh-CN" },
    openAgentTaskList: async (agentId: string, text?: string, origin?: string) => {
      opened.push(agentId); navigation.navigate({ kind: "list", agentId });
      return text === undefined || navigation.prefill(agentId, text, origin);
    },
    createPiConversation: () => { throw new Error("Opening a signal must not create a task"); },
    resumeTask: () => { throw new Error("Opening a signal must not execute anything"); }
  } as unknown as CodexForObsidianPlugin;
  assert.equal(await launchWorkbenchSignal(plugin, signal, data), true);
  assert.deepEqual(opened, ["planner"]);
  assert.equal(navigation.draft().text, current.prompt, "use current count, not the stale row");
  const savedSource = parseWorkbenchTaskSource(navigation.draft().prefillSource);
  assert.deepEqual(savedSource?.objects, ["todo-a", "todo-b"]);
  navigation.save({ ...navigation.draft(), text: "用户修改的草稿", attachments: [{ type: "file", name: "note.md", path: "note.md" }] });
  assert.equal(await launchWorkbenchSignal(plugin, signal, data), false);
  assert.equal(navigation.draft().text, "用户修改的草稿");
  assert.equal(navigation.draft().attachments.length, 1);
  assert.equal(visible, true, "prefilling/conflict cannot consume the reminder");
  visible = false;
  assert.equal(await launchWorkbenchSignal(plugin, signal, data), false);
  assert.equal(opened.length, 2, "a stale row does not open another draft");
  assert.equal(parseWorkbenchTaskSource("not json"), null);
  assert.equal(parseWorkbenchTaskSource(JSON.stringify({ ...source, signalId: 12 })), null);

  navigation.save({ text: "相同文字", attachments: [], prefillSource: JSON.stringify(source) });
  const frozen = { text: "相同文字", composerTextSnapshot: "相同文字", attachments: [], prefillSource: JSON.stringify({ ...source, businessKey: "other" }) } as unknown as QueuedTurnItem;
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:planner", frozen), false, "late acceptance cannot erase a replacement intent with the same text");
  frozen.prefillSource = JSON.stringify(source);
  assert.equal(consumeAcceptedTaskDraft(workspace, "agent:planner", frozen), true);

  const broker = new PiTurnInteractionBroker();
  const question: EchoInkQuestionInteraction = { kind: "question", status: "pending", interactionId: "interaction-a", conversationId: "task-a",
    piSessionId: "pi-a", turnId: "run-a", createdAt: 1, updatedAt: 1,
    questions: [{ questionId: "question-a", prompt: "先做哪件？", selection: "single", allowSupplement: true,
      options: [{ optionId: "first", label: "第一件" }, { optionId: "second", label: "第二件" }] }] };
  const result = broker.waitForAnswers({ conversationId: "task-a", piSessionId: "pi-a", productRunId: "run-a", interactionId: "interaction-a", interaction: question });
  const entry = { conversationId: "task-a", piSessionId: "pi-a", status: "active", pendingResponse: { runId: "run-a", questionId: "question-a", kind: "question" } } as PiConversationCatalogEntry;
  let catalog = entry;
  const details: string[] = [];
  const questionPlugin = { settings: { settingsLanguage: "zh-CN", activeSessionId: "another-task" },
    readPiConversationCatalogEntry: async () => catalog,
    getConversationRunService: () => ({ pendingInteractions: new Map([["task-a", question]]) }),
    piTurnInteractionBinding: broker.bindingFor.bind(broker), openTaskDetail: async (id: string) => { details.push(id); }
  } as unknown as CodexForObsidianPlugin;
  assert.equal(await answerWorkbenchQuestion(questionPlugin, entry, "question-a", "second"), true);
  assert.deepEqual(await result, [{ questionId: "question-a", selectedOptionIds: ["second"] }]);
  assert.equal(await answerWorkbenchQuestion(questionPlugin, entry, "question-a", "first"), false, "same question cannot be answered twice");
  catalog = { ...entry, pendingResponse: { runId: "run-b", questionId: "question-b", kind: "question" } };
  assert.equal(await answerWorkbenchQuestion(questionPlugin, entry, "question-a", "first"), false, "old buttons cannot answer a newer question");
  assert.deepEqual(details, ["task-a", "task-a", "task-a"]);
  broker.dispose();
  if (root) await workbenchSourcePipeline(root);
  console.log("Workbench launcher: fresh prefill, draft/source isolation, no execution, and real question broker PASS");
}

async function workbenchSourcePipeline(root: string): Promise<void> {
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "runtime"), vaultId: "workbench-source-fixture" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, "runtime"), vaultId: catalog.vaultId, catalog });
  const contexts: Array<{ conversationId: string; systemPrompt: string; messages: unknown[] }> = [];
  const managers = new Map<string, SessionManager>();
  let sequence = 0;
  const runtime = new PiNativeConversationRuntime({
    catalog, productRuns, resolveConversationCwd: () => root, idFactory: () => `workbench-source-run-${++sequence}`,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, directory, cwd) => SessionManager.open(file, directory, cwd) },
    createAgentSession: async input => {
      managers.set(input.catalog.conversationId, input.sessionManager);
      const provider = fauxProvider({ provider: "offline-workbench", api: "openai-completions", models: [{ id: "workbench-model", contextWindow: 32000, maxTokens: 512, reasoning: false }] });
      provider.setResponses(Array.from({ length: 8 }, () => context => {
        contexts.push({ conversationId: input.catalog.conversationId, systemPrompt: context.systemPrompt ?? "", messages: structuredClone(context.messages) });
        return fauxAssistantMessage("已读取本地范围。");
      }));
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider.provider);
      const model = provider.getModel();
      const security = createPiVaultToolSecurityAdapter({ isToolAllowed: () => false,
        authorization: { async authorize() { throw new Error("No write is authorized by a local reminder scope"); } },
        resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()) });
      const loader = await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "workbench fixture system",
        inlineExtension: createPiKnowledgeInlineExtension({ vaultSecurity: security.inlineExtension, currentTurn: input.currentKnowledgeTurnContext,
          currentWorkspaceAccess: input.currentWorkspaceAccess, currentWorkbenchSource: input.currentWorkbenchSource }) });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: loader, ...createControlledPiToolRegistration([]) });
      return { session, planToolNames: [], externalReadToolNames: [], memoryToolNames: [] };
    }
  });
  try {
    await runtime.initialize();
    await runtime.createConversation({ conversationId: "selected-task", title: "整理选中的来源", cwd: root });
    await runtime.createConversation({ conversationId: "ordinary-task", title: "普通任务", cwd: root });
    const source = { version: 1 as const, signalId: 6 as const, moduleId: "knowledge-base" as const, businessKey: "workbench:knowledge-base:inbox:fixture",
      objects: ["inbox/所选一.md", "inbox/所选二.md"], versions: { "inbox/所选一.md": "frozen-v1", "inbox/所选二.md": "frozen-v2" }, capturedAt: 1000, prompt: "整理这些" };
    const handlers = new Map<string, (...args: any[]) => any>();
    const extension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {},
      currentTurn: () => ({ kind: "chat", providerResourceText: "已有知识材料：原文：\nKNOWLEDGE_ONLY", references: [] }) as never,
      currentWorkbenchSource: () => freezeWorkbenchTaskSource(source) });
    await extension.factory({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) } as never);
    const before = await handlers.get("before_agent_start")!({ systemPrompt: "unchanged system", prompt: "整理这些" });
    const mergedSource = workbenchTaskSourceFromEntries([{ type: "custom_message", ...before.message }]);
    assert.deepEqual(mergedSource?.objects, source.objects, "a Knowledge-primary resource entry retains its separate source details");
    const user = { role: "user", content: [{ type: "text", text: "整理这些" }], timestamp: 1 };
    const mixed = await handlers.get("context")!({ messages: [user, { role: "custom", timestamp: 1, ...before.message }] });
    const material = mixed.messages.find((message: any) => message.customType === WORKBENCH_CONTEXT_TYPE);
    assert.ok(material && material.display === false); assert.match(material.content, /所选一/u); assert.doesNotMatch(material.content, /KNOWLEDGE_ONLY/u);
    assert.equal(mixed.messages.at(-1), user, "scope and Knowledge remain background messages before the exact user input");
    const ordinaryHandlers = new Map<string, (...args: any[]) => any>();
    const ordinaryExtension = createPiKnowledgeInlineExtension({ vaultSecurity: () => {}, currentTurn: () => null });
    await ordinaryExtension.factory({ on: (name: string, handler: (...args: any[]) => any) => ordinaryHandlers.set(name, handler) } as never);
    assert.equal(await ordinaryHandlers.get("before_agent_start")!({ systemPrompt: "unchanged system", prompt: "ordinary" }), undefined);
    assert.deepEqual((await ordinaryHandlers.get("context")!({ messages: [user] })).messages, [user], "an ordinary extension turn gains no workbench materials");
    assert.equal(freezeWorkbenchTaskSource(undefined), null);
    const request = { conversationId: "selected-task", text: "整理这些", submittedAt: Date.now(), runtimeProviderId: "offline-workbench", modelId: "workbench-model", reasoning: "none" as const, permission: "read-only" as const, workbenchSource: source };
    const starting = runtime.submit(request);
    source.objects.push("inbox/迟到不应混入.md"); source.versions["inbox/所选一.md"] = "later-mutated";
    assert.equal((await (await starting).result).terminalState, "completed");
    const sent = contexts.at(-1)!;
    assert.match(JSON.stringify(sent.messages), /inbox\/所选一\.md/u); assert.match(JSON.stringify(sent.messages), /frozen-v1/u);
    assert.doesNotMatch(JSON.stringify(sent.messages), /迟到不应混入|later-mutated/u);
    assert.match(JSON.stringify(sent.messages), /可能已经过期/u); assert.match(JSON.stringify(sent.messages), /不授予权限/u);
    assert.doesNotMatch(sent.systemPrompt, /所选一|frozen-v1|capturedAt/u, "scope data never becomes a permanent system rule");
    assert.match(JSON.stringify(sent.messages), new RegExp(WORKBENCH_CONTEXT_TYPE));
    const durable = workbenchTaskSourceFromEntries(managers.get("selected-task")!.getBranch())!;
    assert.deepEqual(durable.objects, ["inbox/所选一.md", "inbox/所选二.md"]); assert.equal(durable.capturedAt, 1000);
    const projection = await runtime.readProjection("selected-task");
    assert.ok(projection.messages.every(message => !message.text.includes("frozen-v1") && !message.text.includes("capturedAt")), "internal source fields never become visible chat messages");
    const manager = managers.get("selected-task")!;
    const kept = [...manager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant")!;
    manager.appendCompaction("合成压缩摘要，没有所选来源对象。", kept.id, 1200);
    persistPiActiveLeaf({ sessionRoot: catalog.sessionRootPath, sessionManager: manager });
    await runtime.releaseConversation("selected-task");
    const resumed = await runtime.submit({ ...request, text: "继续核对这些对象", workbenchSource: undefined, submittedAt: Date.now() });
    assert.equal((await resumed.result).terminalState, "completed");
    const restored = contexts.at(-1)!;
    assert.match(JSON.stringify(restored.messages), /inbox\/所选二\.md/u); assert.match(JSON.stringify(restored.messages), /frozen-v2/u,
      "reopening a compacted task recovers the original selected objects from its durable resource context");
    const ordinary = await runtime.submit({ ...request, conversationId: "ordinary-task", text: "普通输入保持原样", workbenchSource: undefined, submittedAt: Date.now() });
    assert.equal((await ordinary.result).terminalState, "completed");
    const plain = contexts.at(-1)!;
    assert.doesNotMatch(JSON.stringify(plain.messages), /所选一|所选二|echoink-workbench-task|frozen-v/u, "another task cannot inherit the selected scope");
    assert.match(JSON.stringify(plain.messages), /普通输入保持原样/u);
    assert.equal(workbenchTaskSourceFromEntries(managers.get("ordinary-task")!.getBranch()), null);
    console.log("Workbench source: real Runtime → InlineExtension → offline Provider, frozen objects/versions, durable compaction/reopen, hidden UI and task isolation PASS");
  } finally { await runtime.shutdown(); }
}
