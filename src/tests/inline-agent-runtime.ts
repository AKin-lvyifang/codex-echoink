import "./inline-timer-host";
import assert from "node:assert/strict";
import { runInlineProGateTests } from "./inline-agent-pro";
import { paidTestAccess } from "./membership-access";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChangeSet } from "@codemirror/state";
import {
  CURRENT_SESSION_VERSION, VERSION, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, Type, type Context } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { createControlledPiToolRegistration, createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { createInlineProposalDispatchGuard, createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";
import { freezeInlineModelRequest, inlineProposalContextContent, INLINE_PROPOSAL_SYSTEM_PROMPT, parseInlineModelOutput, type InlineModelRequest } from "../inline-agent/protocol";
import { InlineAgentRuntimeController } from "../inline-agent/orchestrator";
import { InlineRequestService, type InlineEditorPort } from "../inline-agent/service";
import { applyChanges } from "../inline-agent/document";
import { createApiProviderConfig, DEFAULT_SETTINGS } from "../settings/settings";
import type CodexForObsidianPlugin from "../main";
import type { InlineRequest } from "../inline-agent/types";
import type { PiChatRuntimeEvent, PiChatSubmitRequest, PiProductRunRecord } from "../harness/pi-native/contracts";
import type { SelectionAnnotation } from "../types/selection-annotations";

const annotations: SelectionAnnotation[] = [{ id: "quoted-other-note", number: 1, selectedText: "R5_OTHER_NOTE_EXCLUSIVE_鹭岛42", vaultRelativePath: "其他材料.md", fileName: "其他材料.md",
  anchor: { mode: "editor", from: 0, to: 28, before: "", after: "" }, appliedActions: [] }];

const proposal = { kind: "proposal", candidateId: "paragraph", original: "原文片段", text: "修改后的段落" } as const;
const rangeProposal = { kind: "proposal", startCandidateId: "paragraph", endCandidateId: "paragraph-end", text: "连续多段的新稿" } as const;
const request: InlineModelRequest = { requestId: "inline-request", context: "全文开头\n" + "全文中间完整保留。".repeat(700) + "\n全文末尾",
  candidates: [{ id: "paragraph", kind: "replace", text: "前句。原文片段。后句。", label: "当前段落", boundaryGroup: "body-0" },
    { id: "paragraph-end", kind: "replace", text: "末段保留负责人。", label: "下一步", boundaryGroup: "body-0" }, { id: "end", kind: "insert", text: "", label: "文末" }],
  previousDraft: "上一稿内容", questionAnswers: ["保留专业用语"] };

function assertProtocol(): void {
  assert.deepEqual(parseInlineModelOutput(JSON.stringify(proposal), request), proposal);
  assert.deepEqual(parseInlineModelOutput('{"kind":"proposal","candidateId":"end","original":"","text":"新增"}', request),
    { kind: "proposal", candidateId: "end", original: "", text: "新增" });
  const clarification = { kind: "clarification", question: "修改哪一处？", options: [{ id: "a", label: "当前段落" }, { id: "b", label: "全文" }] };
  assert.deepEqual(parseInlineModelOutput(JSON.stringify(clarification), request), clarification);
  for (const raw of ["not json", "```json\n" + JSON.stringify(proposal) + "\n```", JSON.stringify({ ...proposal, candidateId: "missing" }),
    JSON.stringify({ ...proposal, original: "不存在的原文" }), JSON.stringify({ ...proposal, candidateId: "end", original: "原文片段" }),
    JSON.stringify({ ...proposal, offset: 123 }), JSON.stringify({ ...proposal, original: "" }), JSON.stringify({ ...clarification, options: [{ id: "a", label: "甲" }, { id: "a", label: "乙" }] }),
    JSON.stringify({ ...clarification, options: [] }), JSON.stringify(proposal) + " trailing"]) {
    assert.throws(() => parseInlineModelOutput(raw, request));
  }
  for (const reason of ["length", "aborted", "error", "toolUse"]) assert.throws(() => parseInlineModelOutput(JSON.stringify(proposal), request, reason));
  assert.throws(() => freezeInlineModelRequest({ ...request, candidates: [...request.candidates, request.candidates[0]] }));
  const mutable = structuredClone(request);
  const frozen = freezeInlineModelRequest(mutable);
  (mutable.candidates as Array<{ text: string }>)[0].text = "被后来更改";
  assert.equal(frozen.candidates[0].text, request.candidates[0].text);
  const guard = createInlineProposalDispatchGuard({ currentRequest: () => request, effectiveInputBudget: 30_000 });
  const context: Context = { systemPrompt: INLINE_PROPOSAL_SYSTEM_PROMPT, messages: [{ role: "user", content: inlineProposalContextContent(request), timestamp: 1 }], tools: [] };
  assert.throws(() => guard({ ...context, tools: [{ name: "note_read", description: "read", parameters: Type.Object({}) }] }, { runId: "guard" }), /工具列表/u);
  assert.throws(() => guard({ ...context, messages: [] }, { runId: "guard" }), /快照不完整/u);
  assert.throws(() => guard({ ...context, systemPrompt: "ordinary-chat" }, { runId: "guard" }), /未正确初始化/u);
  const tooLarge = createInlineProposalDispatchGuard({ currentRequest: () => request, effectiveInputBudget: 1_000 });
  assert.throws(() => tooLarge(context, { runId: "budget" }), /全文与记忆/u);
  assert.throws(() => createInlineProposalDispatchGuard({ currentRequest: () => request, effectiveInputBudget: 30_000 })({ ...context,
    messages: [...context.messages, { role: "user", content: annotations[0].selectedText.repeat(40_000), timestamp: 2 }] }, { runId: "annotation-budget" }), /预算/u);
  guard(context, { runId: "guard" });
  assert.throws(() => guard(context, { runId: "guard" }), /不能自动/u);
  console.log("PASS inline protocol: strict complete JSON, bounded candidate/original, insert, clarification, immutable request");
}

type Scenario = "normal" | "no_memory" | "clarification" | "range" | "invalid_range" | "range_length" | "invalid" | "length" | "unknown_tool" | "oversize";

async function runScenario(scenario: Scenario): Promise<void> {
  await withPersonalMemoryFixture(async memory => {
    await memory.repository.write({ operation: "create", kind: "fact", title: "银槐写作偏好", content: "银槐写作偏好是湖蓝短句。",
      recallWhen: "银槐写作偏好或润色正文", basis: "explicit" }, memory.runtime());
    const root = await mkdtemp(path.join(tmpdir(), "inline-runtime-vault-"));
    const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "runtime"), vaultId: memory.vaultId });
    const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, "runtime"), vaultId: memory.vaultId, catalog });
    const contexts: Context[] = [];
    const compaction: boolean[] = [];
    const memoryModes: string[] = [];
    const allEvents: PiChatRuntimeEvent[] = [];
    let currentSession: AgentSession | undefined;
    let providerCalls = 0, toolExecutions = 0, knowledgeCalls = 0, skillCalls = 0, reviews = 0, dreamCalls = 0;
    const recall = new PersonalMemoryRecallHarness(memory.repository);
    const runtime = new PiNativeConversationRuntime({
      catalog, productRuns,
      sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
        open: (file, sessionRoot, cwd) => SessionManager.open(file, sessionRoot, cwd) },
      resolveConversationCwd: () => root,
      knowledge: { retrieveChat: async () => { knowledgeCalls++; throw new Error("inline must not retrieve knowledge"); },
        maintenanceActivity: async () => { knowledgeCalls++; throw new Error("inline must not touch maintenance activity"); },
        retrieveAsk: async () => { knowledgeCalls++; throw new Error("inline must not retrieve knowledge"); },
        resolveMaintenanceScope: async () => { knowledgeCalls++; throw new Error("inline must not select maintenance"); },
        prepareMaintenancePreferences: async () => { knowledgeCalls++; throw new Error("inline must not prepare maintenance"); }
      } as never,
      skills: { selectForTask: async () => { skillCalls++; return null; }, resolveById: async () => { skillCalls++; throw new Error("inline must not load default skill"); },
        recordUse: async () => { skillCalls++; }, reviewCompletedTask: async () => { reviews++; } },
      recordDreamExperience: async () => { dreamCalls++; },
      createAgentSession: async input => {
        // Deliberately keep old private branch material; inline must remove it at the Provider boundary.
        input.sessionManager.appendMessage({ role: "user", content: "OLD_BRANCH_USER_PRIVATE", timestamp: 1 });
        input.sessionManager.appendMessage(fauxAssistantMessage("OLD_BRANCH_ASSISTANT_PRIVATE", { timestamp: 2 }));
        const budget = scenario === "oversize" ? 2_000 : 30_000;
        const guard = createInlineProposalDispatchGuard({ currentRequest: () => input.currentInlineProposalRequest?.() ?? null, effectiveInputBudget: budget });
        const provider = fauxProvider({ provider: "inline-offline", api: "openai-completions",
          models: [{ id: "inline-model", reasoning: false, contextWindow: 64_000, maxTokens: 2_000 }] });
        const respond = (context: Context) => {
          guard(context, input.currentExecutionContext());
          providerCalls++;
          contexts.push(structuredClone(context));
          if (scenario === "unknown_tool") return fauxAssistantMessage(fauxToolCall("user_question", { question: "不应执行" }, { id: "forbidden-call" }), { stopReason: "toolUse" });
          return fauxAssistantMessage(scenario === "invalid" ? JSON.stringify({ ...proposal, original: "不存在" })
            : scenario === "invalid_range" ? JSON.stringify({ ...rangeProposal, endCandidateId: "end" })
            : scenario === "range" || scenario === "range_length" ? JSON.stringify(rangeProposal)
            : scenario === "clarification" ? JSON.stringify({ kind: "clarification", question: "保留什么语气？", options: [{ id: "concise", label: "简短" }, { id: "formal", label: "正式" }] })
              : JSON.stringify(proposal), { stopReason: scenario === "length" || scenario === "range_length" ? "length" : "stop" });
        };
        provider.setResponses([respond, respond]);
        const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
        modelRuntime.registerNativeProvider(provider.provider);
        const model = provider.getModel();
        const extension = createPiKnowledgeInlineExtension({
          vaultSecurity: { name: "inline-noop-security", hidden: true, factory: async pi => {
            pi.on("tool_call", async () => undefined);
            pi.on("tool_result", async () => undefined);
          } },
          currentInlineProposalRequest: () => input.currentInlineProposalRequest?.() ?? null,
          currentSelectionAnnotations: () => input.currentSelectionAnnotationTurnContext?.() ?? [],
          currentTurn: () => input.currentKnowledgeTurnContext(),
          currentSkillTurn: () => input.currentSkillTurnContext?.() ?? null,
          currentTaskPlanTurn: () => input.currentTaskPlanTurnContext(),
          currentMemoryTurn: () => input.currentMemoryTurnContext?.() ?? null,
          currentWorkspaceAccess: () => input.currentWorkspaceAccess?.() ?? null,
          currentAgentSnapshot: () => ({ agentId: "writer", name: "银槐编辑", position: "正文润色", styleId: "creative" }),
          personalMemory: { loadFixedContext: value => memory.repository.loadFixedContext(value),
            prepareTurnContext: value => { memoryModes.push(value.memoryMode); assert.deepEqual(value.recentConversation, []); return recall.prepareTurnContext(value); } },
          onPersonalMemoryRecallProgress: value => input.reportMemoryRecallProgress?.(value),
          onPersonalMemorySourcesInjected: value => input.reportPersonalMemorySourcesInjected?.(value)
        });
        const tools = ["note_read", "memory_read", "user_question", "knowledge_maintain"].map(name => ({ name, label: name, description: name,
          parameters: Type.Object({}), execute: async () => { toolExecutions++; return { content: [{ type: "text" as const, text: "must not execute" }], details: {} }; } }));
        const agentDir = path.join(root, "agent"); await mkdir(agentDir);
        const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model,
          sessionManager: input.sessionManager,
          settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off",
            compaction: { enabled: true }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
          resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "ORDINARY_CHAT_AND_WEB_TOOLS_PRIVATE", inlineExtension: extension }),
          ...createControlledPiToolRegistration(tools)
        });
        currentSession = session;
        const setCompaction = session.setAutoCompactionEnabled.bind(session);
        session.setAutoCompactionEnabled = enabled => { compaction.push(enabled); setCompaction(enabled); };
        return { session, generationInputBudget: budget, memoryToolNames: ["memory_read"], planToolNames: ["note_read"], skillPromptPrefix: "OLD_SKILL_PREFIX_PRIVATE" };
      }
    });
    await runtime.initialize();
    try {
      await runtime.createConversation({ conversationId: scenario, title: "正文离线提案", cwd: root, defaultSkillId: "must-not-resolve" });
      const text = "/maintain 银槐写作偏好，请按知识库和Skill润色正文";
      const submit = () => runtime.submit({ conversationId: scenario, text, selectionAnnotations: annotations, submittedAt: Date.now(), inlineProposalRequest: request,
        memoryMode: scenario === "no_memory" ? "no_memory" : "normal", permission: "read-only", runtimeProviderId: "inline-offline", modelId: "inline-model", reasoning: "none" });
      if (scenario === "oversize") {
        await assert.rejects(submit(), /正文全文超出/u);
        assert.equal(providerCalls, 0);
        assert.equal((await productRuns.list(scenario)).length, 0);
        assert.deepEqual(compaction, [false, true]);
      } else {
        const handle = await submit();
        const subscription = runtime.subscribeProductRun(handle.productRunId, event => { allEvents.push(structuredClone(event)); });
        const result = await handle.result;
        subscription.unsubscribe();
        const successful = ["normal", "no_memory", "clarification", "range"].includes(scenario);
        assert.equal(result.terminalState, successful ? "completed" : "failed", `${scenario}: ${result.error}`);
        assert.equal(result.inlineProposalResult?.kind, scenario === "clarification" ? "clarification" : successful ? "proposal" : undefined);
        if (scenario === "range") assert.deepEqual(result.inlineProposalResult, rangeProposal);
        assert.equal(providerCalls, 1, "invalid/truncated/tool-call output must not cause another Provider call");
        assert.deepEqual(contexts[0].tools ?? [], []);
        const sent = JSON.stringify(contexts[0]);
        assert.doesNotMatch(sent, /OLD_BRANCH_|ORDINARY_CHAT_AND_WEB_TOOLS_PRIVATE|OLD_SKILL_PREFIX_PRIVATE|knowledge_maintain|user_question/u);
        assert.match(String(contexts[0].systemPrompt), /银槐编辑/u);
        assert.ok(contexts[0].messages.some(message => message.role === "user" && (typeof message.content === "string" ? message.content.includes(inlineProposalContextContent(request))
          : message.content.some(part => part.type === "text" && part.text.includes(inlineProposalContextContent(request))))), "full exact snapshot, previous draft and answers reach the Provider");
        assert.ok(sent.includes(text), "latest user instruction stays separate and unexpanded");
        assert.equal(sent.split(annotations[0].selectedText).length - 1, 1, "other-note selected snapshot reaches the Provider exactly once");
        assert.ok(sent.includes("其他材料.md"), "selection source metadata uses the ordinary selection context format");
        assert.equal(sent.includes("湖蓝短句"), scenario !== "no_memory", "real local Recall follows the submitted memory mode");
        assert.deepEqual(memoryModes, [scenario === "no_memory" ? "no_memory" : "normal"]);
        assert.equal(result.memoryRecall?.result, scenario === "no_memory" ? "skipped_no_memory" : "completed");
        if (scenario !== "no_memory") assert.ok(result.memoryRecall!.injected > 0);
        assert.deepEqual(compaction, [false, true]);
        assert.equal(currentSession!.autoCompactionEnabled, true);
        assert.equal((await productRuns.read(handle.productRunId))?.inlineProposalResult, undefined, "structured completion does not copy body into the pointer-only store");
      }
      assert.equal(toolExecutions, 0); assert.equal(knowledgeCalls, 0); assert.equal(skillCalls, 0); assert.equal(reviews, 0); assert.equal(dreamCalls, 0);
      console.log(`PASS inline runtime ${scenario}: actual Pi Session, local Recall, empty tools, isolated whole snapshot, no automatic repair`);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function assertOrchestratorRunLifecycle(): Promise<void> {
  const settings = structuredClone(DEFAULT_SETTINGS), provider = createApiProviderConfig("deepseek", "inline-lifecycle-provider");
  provider.models[0].reasoning = false; provider.models[0].reasoningEnabled = false;
  settings.apiProviders = [provider]; settings.activeApiProviderId = provider.id; settings.defaultModel = provider.models[0].id;
  const agent = settings.agentRegistry.agents[0], instruction = `@${agent.name} 改写这一段`;
  let document = `# 生命周期回归\n\n原文段落。\n\n${instruction}\n`;
  let persisted: InlineRequest[] = [];
  const reports: unknown[] = [];
  let service: InlineRequestService;
  const editor: InlineEditorPort = {
    read: () => document,
    apply: (changes, _history, requestId) => {
      const before = document;
      document = applyChanges(before, changes);
      service.observe("正文.md", ChangeSet.of(changes, before.length), before, document, requestId);
    },
    save: async () => undefined
  };
  service = new InlineRequestService("inline-lifecycle-vault", {
    load: async () => structuredClone(persisted),
    save: async records => { persisted = structuredClone([...records]); }
  }, { editor: async () => editor, changed() {}, report: error => { reports.push(error); } });
  await service.initialize();
  type ManualRun = { request: PiChatSubmitRequest; id: string; resolve(result: Readonly<PiProductRunRecord>): void; settled: boolean };
  const runs: ManualRun[] = [], busy = new Map<string, string>(), released: string[] = [], subscriptions = new Set<string>(), aborted = new Set<string>();
  let blockedSubmissions = 0;
  let createdConversations = 0;
  const plugin = {
    accountService: paidTestAccess,
    settings,
    getVaultPath: () => tmpdir(),
    createPiConversation: async input => { createdConversations++; return { conversationId: input.conversationId, piSessionId: "inline-lifecycle-session", vaultId: "inline-lifecycle-vault",
      title: input.title, agentId: input.agentId, status: "active" as const, defaultMemoryMode: input.defaultMemoryMode ?? "normal", createdAt: Date.now(), updatedAt: Date.now() }; },
    submitPiChat: async request => {
      // Match main.ts: settling a result never clears this map. Only release does.
      if ([...busy.values()].includes(request.conversationId)) { blockedSubmissions++; throw new Error("当前会话正在处理请求，请等待本轮完成。"); }
      const id = `inline-lifecycle-run-${runs.length + 1}`;
      let resolve!: ManualRun["resolve"];
      const result = new Promise<Readonly<PiProductRunRecord>>(done => { resolve = done; });
      runs.push({ request, id, resolve, settled: false }); busy.set(id, request.conversationId);
      return { productRunId: id, conversationId: request.conversationId, piSessionId: "inline-lifecycle-session", userEntryId: `${id}-user`, result };
    },
    subscribePiRun: runId => {
      assert.ok(busy.has(runId)); subscriptions.add(runId);
      return { unsubscribe: () => { subscriptions.delete(runId); } };
    },
    releasePiProductionRun: runId => { assert.ok(busy.delete(runId), "release must target a held run exactly once"); released.push(runId); },
    // Native abort may return at Agent idle while the ProductRun is still flushing.
    abortPiConversation: async taskId => { aborted.add(taskId); }
  } satisfies Pick<CodexForObsidianPlugin, "settings" | "getVaultPath" | "createPiConversation" | "submitPiChat" | "subscribePiRun" | "releasePiProductionRun" | "abortPiConversation">;
  const controller = new InlineAgentRuntimeController(plugin as unknown as CodexForObsidianPlugin, service, { editor: async () => editor, openTask: async () => undefined });
  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let turn = 0; turn < 1_000; turn++) {
      if (predicate()) return;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(`${label}; latest request=${JSON.stringify(service.list().at(-1))}`);
  };
  const finish = (index: number, terminalState: "completed" | "failed" | "cancelled", text = `第${index + 1}稿。`) => {
    const run = runs[index]; assert.ok(run, "expected a submitted run"); assert.equal(run.settled, false); run.settled = true;
    const candidate = run.request.inlineProposalRequest?.candidates.find(item => item.kind === "replace" && !item.text.startsWith("#"));
    assert.ok(candidate);
    run.resolve({ productRunId: run.id, conversationId: run.request.conversationId, piSessionId: "inline-lifecycle-session", userEntryId: `${run.id}-user`,
      toolCallIds: [], memoryMode: run.request.memoryMode ?? "normal", permission: "read-only", state: "product_run_settled", terminalState,
      activeLeafId: `${run.id}-assistant`, createdAt: run.request.submittedAt, updatedAt: Date.now(), settledAt: Date.now(),
      ...(terminalState === "completed" ? { inlineProposalResult: { kind: "proposal", candidateId: candidate.id, original: candidate.text, text } as const }
        : terminalState === "failed" ? { error: "synthetic Provider failure" } : {}) });
    assert.ok(busy.has(run.id), "the fake result must not silently clear the host's busy map");
  };
  const waitForRelease = (count: number) => waitFor(() => released.length === count && subscriptions.size === 0, `run ${count} must settle, unsubscribe, and release host ownership`);
  try {
    const from = document.indexOf(instruction);
    await controller.sendDraft({ path: "正文.md", agentId: agent.id, trigger: "@", from, to: from + instruction.length, document, text: "改写这一段" });
    await waitFor(() => runs.length === 1, "first draft must submit");
    const taskId = runs[0].request.conversationId, firstRequestId = service.latestForTask(taskId)!.id;
    finish(0, "completed", "第一稿。"); await waitForRelease(1);
    assert.equal(service.get(firstRequestId)?.status, "pending");
    assert.equal(createdConversations, 1);
    await controller.reply(taskId, "再短一点", annotations);
    assert.deepEqual(service.get(firstRequestId)?.selectionAnnotations, annotations);
    assert.deepEqual(persisted.find(item => item.id === firstRequestId)?.thread?.at(-1)?.selectionAnnotations, annotations);
    await waitFor(() => runs.length === 2 || service.get(firstRequestId)?.status === "failed", "follow-up must submit after the first result");
    assert.equal(runs.length, 2, "host ownership from the first result must not block a consecutive follow-up");
    assert.equal(runs[1].request.inlineProposalRequest?.previousDraft, "第一稿。");
    assert.deepEqual(runs[1].request.selectionAnnotations, annotations);
    finish(1, "completed", "第二稿。"); await waitForRelease(2);
    assert.deepEqual(service.get(firstRequestId)?.versions.map(version => version.text), ["第一稿。", "第二稿。"]);
    const second = service.get(firstRequestId)!;
    await service.confirm(second.id, second.currentVersionId);
    assert.equal(service.get(firstRequestId)?.status, "confirmed"); assert.match(document, /第二稿。/u);

    await controller.reply(taskId, "确认后继续润色");
    await waitFor(() => runs.length === 3 || service.latestForTask(taskId)?.status === "failed", "confirmed task must accept an immediate follow-up");
    assert.equal(runs.length, 3); assert.notEqual(service.latestForTask(taskId)?.id, firstRequestId);
    finish(2, "completed", "确认后的新稿。"); await waitForRelease(3);
    assert.equal(service.latestForTask(taskId)?.status, "pending");

    await controller.reply(taskId, "模拟服务商失败"); await waitFor(() => runs.length === 4, "failure run must submit");
    finish(3, "failed"); await waitForRelease(4);
    assert.equal(service.latestForTask(taskId)?.status, "failed");
    await controller.retry(taskId); await waitFor(() => runs.length === 5, "failed result must release ownership before retry");
    assert.deepEqual(runs[4].request.selectionAnnotations, annotations, "retry retains the frozen selected snapshot");
    finish(4, "completed", "失败后重试成功。"); await waitForRelease(5);
    assert.equal(service.latestForTask(taskId)?.status, "pending");

    await controller.reply(taskId, "模拟用户停止"); await waitFor(() => runs.length === 6, "interrupted run must submit");
    let stopFinished = false;
    const stopping = controller.stop(taskId).then(() => { stopFinished = true; });
    await waitFor(() => aborted.has(taskId), "stop must call the native abort");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopFinished, false, "stop must wait beyond native abort until ProductRun completion releases host ownership");
    assert.equal(busy.size, 1); assert.equal(runs.length, 6);
    finish(5, "cancelled"); await stopping;
    assert.equal(busy.size, 0); assert.equal(service.latestForTask(taskId)?.status, "interrupted");
    await controller.retry(taskId); await waitFor(() => runs.length === 7, "retry immediately after stop must submit without a stale host lock");
    finish(6, "completed", "停止后重试成功。"); await waitForRelease(7);
    assert.equal(service.latestForTask(taskId)?.status, "pending");
    assert.equal(blockedSubmissions, 0); assert.equal(busy.size, 0); assert.equal(subscriptions.size, 0); assert.deepEqual(reports, []);
    assert.deepEqual(released, runs.map(run => run.id));
    console.log("PASS inline orchestrator lifecycle: first draft, follow-up, confirm then immediate follow-up, failure/retry, delayed abort settlement then immediate retry all release host busy ownership");
  } finally {
    controller.dispose(); await service.dispose();
  }
}

assertProtocol();
for (const scenario of ["normal", "no_memory", "clarification", "range", "invalid_range", "range_length", "invalid", "length", "unknown_tool", "oversize"] as const) await runScenario(scenario);
await assertOrchestratorRunLifecycle();

await runInlineProGateTests();
