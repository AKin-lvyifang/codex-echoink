import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { FileApprovalTicketStore } from "../harness/pi-native/tool-authorization";
import { FileDomainReceiptStore } from "../harness/pi-native/domain-receipt-store";
import { PersonalMemoryRepository } from "../harness/memory/personal-memory-repository";
import { FileKnowledgeUsageStore } from "../knowledge-base/usage";
import { devicePiCanonicalStoreRoots } from "../harness/pi/pi-store-layout";
import { createPiProductionRuntimeBundle } from "../plugin/pi-production-runtime-composition";
import { readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { DEFAULT_SETTINGS, createApiProviderConfig } from "../settings/settings";
import { emptyKnowledgeFolderBindings, registerKnowledgeFolderBindings, registerKnowledgePrivateRoot } from "../knowledge-base/root-paths";
import { parsePiContextLedger, PI_CONTEXT_LEDGER_CUSTOM_TYPE } from "../harness/pi-native/pi-context-budget";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { persistPiActiveLeaf } from "../harness/pi-native/pi-session-durability";
import { readTaskResumeSafety } from "../plugin/task-resume-safety";
import type { PiChatRuntimeEvent } from "../harness/pi-native/contracts";
import { diskApp } from "./workbench-maintenance-chain";

type Outcome = "continue" | "over-budget" | "summary-failed";
type Start = "new-message" | "resume" | "auto-retry" | "within-budget";
type ServiceOverflow = "xiaoecho" | "other";

export async function runPiMidrunCompactionTests(root: string): Promise<void> {
  const scenarios: { outcome: Outcome; start?: Start; overflow?: ServiceOverflow }[] = [
    { outcome: "continue" }, { outcome: "over-budget" }, { outcome: "summary-failed" },
    { outcome: "continue", start: "new-message" }, { outcome: "continue", start: "resume" },
    { outcome: "continue", start: "auto-retry" },
    { outcome: "over-budget", start: "new-message" }, { outcome: "summary-failed", start: "new-message" },
    { outcome: "continue", start: "within-budget" },
    { outcome: "continue", start: "within-budget", overflow: "xiaoecho" },
    { outcome: "over-budget", start: "within-budget", overflow: "xiaoecho" },
    { outcome: "summary-failed", start: "within-budget", overflow: "xiaoecho" },
    { outcome: "over-budget", start: "new-message", overflow: "xiaoecho" },
    { outcome: "continue", start: "within-budget", overflow: "other" }
  ];
  for (const { outcome, start, overflow } of scenarios) {
    const vault = await mkdtemp(path.join(root, "midrun-compaction-"));
    try {
      await runScenario(vault, outcome, start, overflow);
    } finally {
      await rm(vault, { force: true, recursive: true });
    }
  }
}

async function runScenario(vault: string, outcome: Outcome, start?: Start, overflow?: ServiceOverflow): Promise<void> {
  const source = "raw/第一份.md", second = "raw/第二份.md", sourcePaths = [source, second];
  await mkdir(path.join(vault, "raw"));
  await mkdir(path.join(vault, "wiki"));
  await writeFile(path.join(vault, source), "# 第一份\n第一份是合成资料。\n");
  await writeFile(path.join(vault, second), "# 第二份\n第二份是合成资料。\n");
  const pluginRoot = path.join(vault, ".obsidian/plugins/echoink");
  const storage = path.join(pluginRoot, "pi-agent-product-v1");
  const privateRoot = path.join(storage, "knowledge");
  const device = path.join(vault, "device");
  await mkdir(storage, { recursive: true });
  await mkdir(device);
  registerKnowledgePrivateRoot(vault, privateRoot);
  const vaultId = "midrun-fixture";
  const catalog = new FileConversationCatalog({ storageRootPath: storage, vaultId });
  const productRuns = new FileProductRunStore({ storageRootPath: storage, vaultId, catalog });
  const approvals = new FileApprovalTicketStore({ storageRootPath: storage, vaultId });
  const receipts = new FileDomainReceiptStore({ storageRootPath: storage, vaultId });
  const knowledgeUsageStore = new FileKnowledgeUsageStore({ storageRootPath: storage, vaultId });
  const personalMemory = new PersonalMemoryRepository({ vaultPath: storage, vaultId });
  await Promise.all([catalog.initialize(), productRuns.initialize(), approvals.initialize(), receipts.initialize(), knowledgeUsageStore.initialize(), personalMemory.initialize()]);
  const entries = async (): Promise<SessionEntry[]> => {
    const file = await catalog.sessionFile("midrun");
    if (!file) return [];
    return (await readFile(file, "utf8")).trim().split("\n").slice(1).map(line => JSON.parse(line));
  };
  const call = (id: string, name: string, input: object, index = 0) => ({
    id, index, type: "function", function: { name, arguments: JSON.stringify(input) }
  });
  const decompose = (sourcePath: string) => ({ stage: "decompose", sourcePaths, decompositions: [{ sourcePath, summary: "测试摘要", units: [] }] });
  const filler = "青鸟飞过山川，星光落进海里。".repeat(165);
  const turns = overflow ? [{ content: "超限后已完整回复。" }] : start ? [
    { tool_calls: [call("read-current", "note_read", { relativePath: source })] },
    { content: "已读测试资料。" }
  ] : [
    { tool_calls: [call("read-first", "note_read", { relativePath: source })] },
    { content: filler, tool_calls: [call("save-first", "knowledge_maintain", decompose(source))] },
    { content: filler, tool_calls: [call("read-second", "note_read", { relativePath: second })] },
    { tool_calls: [call("inspect", "knowledge_maintain", { stage: "inspect", sourcePaths })] },
    { tool_calls: [call("save-second", "knowledge_maintain", decompose(second))] },
    { tool_calls: [call("plan", "knowledge_maintain", { stage: "plan", sourcePaths, writingPlan: [] })] },
    { content: "原批次已整理完成。" }
  ];
  const events: PiChatRuntimeEvent[] = [];
  const requests: { kind: string; messages: { role: string; content: unknown }[] }[] = [];
  let firstCheckpointAtSummary = false, toolResultAtSummary = false, runningAtSummary = false;
  let next = 0, summaryCalls = 0, serverError: unknown;
  const server = createServer(async (req, res) => {
    try {
      let input = "";
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      const normal = !!body.tools?.length;
      requests.push({ kind: normal ? "agent" : "summary", messages: body.messages });
      if (normal && overflow && (outcome !== "continue" || requests.filter(request => request.kind === "agent").length === 1)) {
        const error = overflow === "xiaoecho" ? "CONTENT_TOO_LONG" : { code: "context_length_exceeded", message: "This model's maximum context length was exceeded." };
        const status = overflow === "xiaoecho" && outcome === "over-budget" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
        return;
      }
      if (normal && start === "auto-retry" && requests.filter(request => request.kind === "agent").length === 1) {
        res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic rate limit" } }));
        return;
      }
      if (!normal && start) summaryCalls++;
      if (!normal && !start && summaryCalls++ === 0) {
        const records = await readPrivateMaintenanceRecords(privateRoot, { vaultId });
        firstCheckpointAtSummary = records.some(record => record.p1?.decompositions.some(item => item.sourcePath === source));
        toolResultAtSummary = (await entries()).some(entry =>
          entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "read-second");
        for (let attempt = 0; attempt < 100 && !events.some(event => event.type === "compaction_start"); attempt++) await delay(10);
        runningAtSummary = (await bundle?.runtime.readProjection("midrun"))?.messages.some(message =>
          message.itemType === "contextCompaction" && message.status === "running" && message.title === "正在压缩上下文") ?? false;
      }
      if (!normal && outcome === "summary-failed") {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic summary rejection" } }));
        return;
      }
      const reply = normal ? turns[next++] : { content: outcome === "over-budget" && !overflow ? filler.repeat(14)
        : start ? "已压缩旧测试记录。" : "第一份资料已拆解。按维护检查点继续第二份资料。" };
      assert.ok(reply, "unexpected extra conversation request");
      const chunk = { id: `midrun-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "deepseek-chat" };
      const event = (delta: object, finish: string | null) => ({ ...chunk, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(event({ role: "assistant", ...reply }, null))}\n\ndata: ${JSON.stringify(event({}, "tool_calls" in reply ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      serverError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.memory.useLongTermMemory = false;
  const provider = createApiProviderConfig(overflow === "xiaoecho" ? "xiaoecho" : "deepseek", "midrun-fixture");
  provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  provider.apiKey = "synthetic-test-only";
  provider.models[0].capabilityOverrides = { toolCalling: true };
  provider.models[0].toolCalling = true;
  provider.models[0].contextWindow = 30_000;
  provider.models[0].maxOutputTokens = 2_000;
  provider.models[0].modelMaxTokens = 2_000;
  provider.models[0].limitsOverride = { contextWindow: 30_000, maxOutputTokens: 2_000 };
  settings.apiProviders = [provider];
  settings.activeApiProviderId = provider.id;
  const bindings = emptyKnowledgeFolderBindings();
  for (const role of ["raw", "wiki"] as const) bindings.roles[role] = { enabled: true, readPaths: [role], writePath: role, allowedSubdirectories: [] };
  settings.knowledgeBase.folderBindings = bindings;
  const unbind = registerKnowledgeFolderBindings(vault, () => bindings);
  const plugin = {
    app: diskApp(vault), getWorkspaceFiles: () => ({}), settings, getVaultPath: () => vault, getPluginDataDirName: () => "echoink", persistPiNativeSettings: async () => {},
    resolveOpenAICodexAccessToken: async () => "", resolveEchoInkAccountToken: async () => "synthetic-account-token",
    buildRuntimeEchoInkResourceCatalog: async () => [], readPersistedEchoInkResourceSnapshot: async () => settings.resources,
    listEchoInkMcpTools: async () => [], callEchoInkMcpTool: async () => { throw new Error("unused MCP"); },
    callEchoInkMcpToolFromResourceSnapshot: async () => { throw new Error("unused MCP"); },
    getTodoStore: () => ({}), createSkillReviewLlmPort: () => null
  } as never;
  const localData = {
    vaultRootPath: vault, pluginDataRootPath: pluginRoot, piNativeStorageRootPath: storage,
    deviceScope: { stateRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    storeScope: { pluginDataRootPath: pluginRoot, vaultRootPath: vault, deviceControlRootPath: device, vaultIdDigest: vaultId, deviceIdDigest: "fixture-device" },
    roots: devicePiCanonicalStoreRoots(pluginRoot), catalog, productRuns, approvals, receipts, knowledgeUsageStore, personalMemory,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file: string, directory: string, cwd: string) => SessionManager.open(file, directory, cwd) }
  } as never;
  let bundle: Awaited<ReturnType<typeof createPiProductionRuntimeBundle>> | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  try {
    bundle = await createPiProductionRuntimeBundle(plugin, localData);
    const conversation = await bundle.runtime.createConversation({ conversationId: "midrun", title: "轮内压缩测试", cwd: vault });
    const text = start ? "本轮输入只出现一次，请读第一份资料。" : "/maintain";
    const createdAt = Date.now();
    let resumeContext;
    if (start) {
      const file = await catalog.sessionFile(conversation.conversationId);
      assert.ok(file);
      const manager = SessionManager.open(file, catalog.sessionRootPath, vault);
      const oldHistory = start === "within-budget" ? overflow ? `旧历史标记${filler.repeat(2)}` : "短历史" : `旧历史标记${filler.repeat(9)}`;
      // Even when Pi's older usage threshold would trigger before prompt,
      // a failed summary is handled once by the outgoing request check.
      const used = outcome === "summary-failed" ? 24_000 : 1000;
      const usage = { input: used, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: used + 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const assistant = { role: "assistant", api: "openai-completions", provider: provider.runtimeProviderId,
        model: provider.models[0].id, content: [], usage, stopReason: "stop", timestamp: createdAt - 5 } as const;
      manager.appendMessage({ role: "user", content: oldHistory, timestamp: createdAt - 6 });
      manager.appendMessage({ ...assistant, content: [{ type: "text", text: "已处理旧记录。" }] });
      const userEntryId = !overflow && manager.appendMessage({ role: "user", content: "上一项任务。", timestamp: createdAt - 4 });
      const assistantEntryId = !overflow && manager.appendMessage({ ...assistant, timestamp: createdAt - 3, content: [],
        usage: { ...usage, input: 0, output: 0, totalTokens: 0 }, stopReason: "error", errorMessage: "provider_request_rejected" });
      persistPiActiveLeaf({ sessionRoot: catalog.sessionRootPath, sessionManager: manager });
      if (start === "resume") {
        assert.ok(userEntryId && assistantEntryId);
        const interruption = { at: createdAt - 2, reason: "run_failed", stage: "模型回复" } as const;
        const interrupted = await productRuns.create({
          productRunId: "interrupted-run", conversationId: conversation.conversationId, piSessionId: conversation.piSessionId,
          userEntryId, assistantEntryId, toolCallIds: [], memoryMode: "no_memory", permission: "workspace-write",
          state: "product_run_settled", terminalState: "failed", activeLeafId: assistantEntryId,
          agentSettledAt: createdAt - 2, settledAt: createdAt - 2, createdAt: createdAt - 4, updatedAt: createdAt - 2, interruption
        });
        const safety = await readTaskResumeSafety({ receipts, approvals, productRuns, catalog, vaultRootPath: vault,
          conversationId: conversation.conversationId, interruptedRunId: interrupted.productRunId });
        resumeContext = { safety, interruption };
      }
    }
    const handle = await bundle.runtime.submit({
      conversationId: conversation.conversationId, text, permission: "workspace-write",
      submittedAt: Date.now(), runtimeProviderId: provider.runtimeProviderId, modelId: provider.models[0].id,
      reasoning: "none", memoryMode: "no_memory", ...(start ? { resumeContext } : { maintenanceScope: { mode: "batch", sourcePaths } })
    });
    subscription = bundle.runtime.subscribeProductRun(handle.productRunId, event => { events.push(event); });
    const result = await handle.result;
    if (serverError) throw serverError;
    const branch = await entries();
    const ledger = branch.flatMap(entry => entry.type === "custom" && entry.customType === PI_CONTEXT_LEDGER_CUSTOM_TYPE
      ? [parsePiContextLedger(entry.data)] : []).filter(entry => entry !== null);
    const compactions = branch.filter(entry => entry.type === "compaction");
    const summarizeAt = requests.findIndex(request => request.kind === "summary");
    if (overflow) {
      const order = requests.map(request => request.kind);
      const failCode = outcome === "summary-failed" ? "provider_history_compaction_failed" : "provider_history_still_too_long";
      const agentLedger = ledger.filter(entry => entry.requestKind === "agent");
      console.log(JSON.stringify({ overflow, start, outcome, status: result.terminalState, order, input: agentLedger.map(entry => entry.totalInputTokens) }));
      assert.deepEqual(order, start === "new-message" ? ["summary", "agent"]
        : outcome === "summary-failed" ? ["agent", "summary"] : ["agent", "summary", "agent"]);
      assert.ok(agentLedger.length > 0 && agentLedger.every(entry => entry.overBudgetTokens === 0));
      assert.equal(events.filter(event => event.type === "compaction_start").length, 1);
      assert.equal(compactions.length, outcome === "summary-failed" ? 0 : 1);
      assert.equal(events.filter(event => event.type === "agent_end").length, 1, "recover without ending the chat attempt");
      assert.equal(result.terminalState, outcome === "continue" ? "completed" : "failed");
      if (outcome !== "continue") assert.equal(result.interruption?.detail, failCode);
      const visibleErrors = (await bundle.runtime.readProjection(conversation.conversationId))?.messages
        .filter(message => message.role === "assistant" && message.itemType === "error");
      assert.equal(visibleErrors?.length, outcome === "continue" ? 0 : 1, "only a final failure is visible");
      const sent = requests.filter(request => request.kind === "agent");
      const finalWire = JSON.stringify(sent.at(-1)?.messages);
      assert.equal(finalWire.split(text).length - 1, 1);
      if (outcome !== "summary-failed") assert.ok(!finalWire.includes("旧历史标记"));
      return;
    }
    if (start) {
      const agentRequests = requests.filter(request => request.kind === "agent");
      console.log(JSON.stringify({ start, outcome, state: result.terminalState, summaryCalls, summarizeAt,
        input: ledger.map(entry => [entry.requestKind, entry.totalInputTokens, entry.budget.effectiveInputBudget]) }));
      assert.equal(summarizeAt, start === "within-budget" ? -1 : 0, "oversized opening must summarize before the provider sees an agent request");
      assert.equal(compactions.length, start === "within-budget" || outcome === "summary-failed" ? 0 : 1);
      assert.equal(events.filter(event => event.type === "compaction_start").length, start === "within-budget" ? 0 : 1);
      if (outcome === "continue") {
        assert.equal(result.terminalState, "completed");
        assert.equal(agentRequests.length, start === "auto-retry" ? 3 : 2);
        assert.ok(ledger.filter(entry => entry.requestKind === "agent").every(entry => entry.overBudgetTokens === 0));
        for (const request of agentRequests) {
          const wire = JSON.stringify(request.messages);
          assert.equal(wire.split(text).length - 1, 1, "preserve current user input exactly once");
          assert.ok(!wire.includes("旧历史标记"), "later requests must also use the compacted history");
        }
        assert.ok(agentRequests.at(-1)?.messages.some(message => message.role === "tool"));
      } else {
        assert.equal(result.terminalState, "failed");
        assert.equal(agentRequests.length, 0);
        assert.ok(summaryCalls <= 2, "one compaction can summarize both history and a turn prefix");
        assert.equal(result.interruption?.detail, outcome === "over-budget" ? "provider_history_still_too_long" : "provider_history_compaction_failed");
        const projection = await bundle.runtime.readProjection(conversation.conversationId);
        assert.ok(projection?.messages.some(message => message.itemType === "error" && message.text?.includes(
          outcome === "over-budget" ? "对话压缩后仍太长" : "对话太长，暂时没能压缩")));
      }
      return;
    }
    console.log(JSON.stringify({ outcome, state: result.terminalState, summaryCalls, summarizeAt,
      input: ledger.map(entry => [entry.requestKind, entry.totalInputTokens, entry.budget.effectiveInputBudget]),
      persisted: firstCheckpointAtSummary, toolResultAtSummary, runningAtSummary, compactions: compactions.length, interruption: result.interruption }));
    assert.ok(summarizeAt >= 0, "input above the threshold must trigger compaction without a provider overflow response");
    assert.ok(firstCheckpointAtSummary && toolResultAtSummary && runningAtSummary, "maintenance and tool results must already be durable when compaction starts");
    assert.equal(events.filter(event => event.type === "agent_end").length, 1, "same Pi run");
    assert.equal(events.filter(event => event.type === "compaction_start").length, 1, "one compaction for this boundary");
    assert.ok(summaryCalls <= 2, "Pi may separately summarize history and the split turn");
    assert.equal(compactions.length, outcome === "summary-failed" ? 0 : 1, "only a successful native compaction exists on disk");
    if (outcome !== "continue") {
      assert.equal(result.terminalState, "failed");
      assert.equal(requests.slice(summarizeAt + 1).filter(request => request.kind === "agent").length, 0, "no over-budget conversation request after compaction");
      assert.equal(result.interruption?.detail, outcome === "over-budget" ? "provider_history_still_too_long" : "provider_history_compaction_failed");
      const saved = await readPrivateMaintenanceRecords(privateRoot, { vaultId });
      assert.deepEqual(saved[0]?.p1?.decompositions.map(item => item.sourcePath), [source]);
      if (outcome === "summary-failed") {
        const end = events.find(event => event.type === "compaction_end");
        assert.ok(end?.error && !end.entryId);
        const projector = new PiChatUiProjector();
        const current = projector.projectSessionBranch({ piSessionId: end.piSessionId, activeLeafId: end.activeLeafId,
          entries: [{ type: "compaction", id: "older-compaction", parentId: null, timestamp: new Date().toISOString(), summary: "旧摘要", tokensBefore: 1024 }] });
        const { messages } = projector.projectRuntimeEvent({ current, event: end });
        assert.ok(messages.some(message => message.title === "上下文压缩未完成" && message.status === "failed"));
        assert.ok(messages.some(message => message.id.includes("older-compaction") && message.status === "completed"));
      }
    } else {
      const after = ledger.find(entry => entry.requestKind === "agent" && entry.compaction?.summaryEntryId === compactions[0].id);
      assert.ok(after && after.overBudgetTokens === 0 && after.productRunId === handle.productRunId);
      assert.equal(after.compaction?.firstKeptEntryId, compactions[0].firstKeptEntryId);
      const resumed = requests.slice(summarizeAt + 1).find(request => request.kind === "agent");
      const checkpoint = resumed?.messages.map(({ content }) => typeof content === "string" ? content
        : Array.isArray(content) ? content.map(block => block.text ?? "").join("") : "")
        .find(content => content.includes("维护检查点（压缩时从本批记录读取）"));
      assert.ok(checkpoint?.includes(JSON.stringify({ path: source, complete: true })));
      assert.ok(checkpoint.includes(JSON.stringify({ path: second, complete: false, nextOffset: 0 })));
      assert.equal(result.terminalState, "completed");
      const saved = await readPrivateMaintenanceRecords(privateRoot, { vaultId });
      assert.equal(saved[0]?.p1?.phase, "completed");
      assert.deepEqual(saved[0]?.p1?.decompositions.map(item => item.sourcePath), sourcePaths);
    }
  } finally {
    subscription?.unsubscribe();
    await bundle?.runtime.shutdown();
    unbind();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
