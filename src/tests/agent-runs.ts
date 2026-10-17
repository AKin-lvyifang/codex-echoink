import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime } from "../harness/pi-native/pi-native-conversation-runtime";
import { normalizeSettingsData, DEFAULT_SETTINGS, createApiProviderConfig, createApiProviderModelConfig, activateApiProviderModel } from "../settings/settings";
import type { ConversationRunService } from "../plugin/conversation-run-service";
import type { QueuedTurnItem } from "../ui/turn-queue";
import { applyConversationTaskMetadata } from "../agents/task-metadata";

export async function runAgentRunTests(root: string, createHost: (catalog: any, runtime: any, settings: any) => any, createView: (plugin: any, detach: () => void) => any): Promise<void> {
  const fixture = await createFixture(root, createHost);
  try {
    await metadataInterleaving(fixture);
    await viewLifetimeAndConcurrency(fixture, createView);
    await compressionAndHistory(fixture);
    await deletionStopsBeforeHandoff(fixture);
    await failureIsNotCompletion(fixture);
    await unloadingStopsAll(fixture);
    console.log("Agent runs: metadata/lifecycle/concurrency/deletion/compaction PASS (offline Pi AgentSession)");
  } finally {
    await fixture.service.dispose();
    await fixture.runtime.shutdown();
  }
}

async function createFixture(root: string, createHost: (catalog: any, runtime: any, settings: any) => any) {
  const storage = path.join(root, "pi-store");
  await mkdir(storage, { recursive: true });
  const catalog = new FileConversationCatalog({ storageRootPath: storage, vaultId: "agent-runs" });
  const productRuns = new FileProductRunStore({ storageRootPath: storage, vaultId: catalog.vaultId, catalog });
  const sessions = new Map<string, any>();
  const requests = new Map<string, string[]>();
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started = new Map<string, ReturnType<typeof deferred>>();
  const failures = new Set<string>();
  let linkingStop: (origins: readonly string[]) => Promise<void> = async () => undefined;
  const settings = normalizeSettingsData(structuredClone(DEFAULT_SETTINGS)).settings;
  settings.agentRegistry.legacyMigrationVersion = 1;
  settings.agentRegistry.agents.push({ id: "colleague", name: "整理员", avatar: { kind: "preset", presetId: "nova" }, position: "整理资料", styleId: "analysis", capabilityIds: ["knowledge"] });
  const provider = createApiProviderConfig("custom", "offline-agent-runs");
  provider.baseUrl = "https://offline.example/v1"; provider.apiKey = "offline-fixture";
  const model = createApiProviderModelConfig("custom", "agent-runs-model");
  model.reasoning = false; model.reasoningEnabled = false;
  provider.models = [model]; provider.defaultModelId = model.id;
  settings.apiProviders = [provider]; activateApiProviderModel(settings, provider, model.id);
  let sequence = 0;
  const runtime = new PiNativeConversationRuntime({ catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `agent-run-${++sequence}`,
    resolveAgentRunSnapshot: entry => {
      const agent = settings.agentRegistry.agents.find(agent => agent.id === entry.agentId)!;
      return { agentId: agent.id, name: agent.name, position: agent.position, styleId: agent.styleId,
        ...(agent.capabilityIds ? { capabilityIds: [...agent.capabilityIds] } : { disabledCapabilityIds: [...agent.disabledCapabilityIds ?? []] }) };
    },
    createAgentSession: async input => {
      const task = input.catalog.conversationId;
      const faux = fauxProvider({ provider: input.runtimeProviderId!, api: "openai-completions", models: [{ id: input.modelId!, contextWindow: 32_000, maxTokens: 1024, reasoning: false }] });
      let responses = 0;
      faux.setResponses(Array.from({ length: 40 }, () => async (context: any, options: any) => {
        const history = requests.get(task) ?? []; history.push(JSON.stringify(context)); requests.set(task, history);
        started.get(task)?.resolve();
        const gate = gates.get(task);
        if (gate) {
          const aborted = deferred(); const onAbort = () => aborted.resolve();
          options?.signal?.addEventListener("abort", onAbort, { once: true });
          if (options?.signal?.aborted) aborted.resolve();
          try { await Promise.race([gate.promise, aborted.promise]); } finally { options?.signal?.removeEventListener("abort", onAbort); }
        }
        if (failures.has(task)) throw new Error("offline_fixture_provider_failed");
        return fauxAssistantMessage(`RESULT:${task}:${++responses} ` + "Original task evidence. ".repeat(150));
      }));
      const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      models.registerNativeProvider(faux.provider);
      const selected = faux.getModel();
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models, model: selected, noTools: "all", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: selected.provider, defaultModel: selected.id, defaultThinkingLevel: "off", compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 128 }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: `Offline task ${task}.` }) });
      sessions.set(task, session); return { session };
    }
  });
  await runtime.initialize();
  for (const id of ["A", "B", "C", "delete-task", "unload-task"]) {
    const entry = await runtime.createConversation({ conversationId: id, title: id, cwd: root, agentId: id === "delete-task" || id === "C" ? "colleague" : "sol" });
    settings.sessions.push({ id, title: id, cwd: root, messages: [], piSessionId: entry.piSessionId, bodyAuthority: "pi_session_only", createdAt: entry.createdAt, updatedAt: entry.updatedAt });
    applyConversationTaskMetadata(settings.sessions.at(-1)!, entry);
  }
  const plugin = createHost(catalog, runtime, settings);
  const dataPath = path.join(root, "settings-projection.json");
  Object.assign(plugin, {
    getVaultPath: () => root, app: {},
    saveSettings: async () => { await writeFile(dataPath, JSON.stringify(settings)); },
    persistPiNativeSettings: async () => { await writeFile(dataPath, JSON.stringify(settings)); },
    externalizeMessageText: async () => undefined,
    submitPiChat: (request: any) => runtime.submit(request),
    readPiConversationProjection: (id: string) => runtime.readProjection(id),
    subscribePiRun: (id: string, listener: any) => runtime.subscribeProductRun(id, listener),
    subscribePiAgentApproval: () => ({ unsubscribe() {} }),
    isPiProductionRun: () => true, releasePiProductionRun: (id: string) => runtime.releaseProductRun(id),
    releasePiConversationIfInactive: async () => undefined,
    releasePiConversation: (id: string) => runtime.releaseConversation(id),
    abortPiConversation: (id: string) => runtime.abort(id),
    requireKnowledgeSurfaceService: () => ({ linking: { stopForOrigins: (origins: readonly string[]) => linkingStop(origins) } })
  });
  const service: ConversationRunService = plugin.getConversationRunService();
  const item = (task: string, text = `PRIVATE-${task}`): QueuedTurnItem => ({ id: `queued-${task}-${Date.now()}`, sessionId: task, text, attachments: [], skill: null, kind: "chat", createdAt: Date.now(),
    turnOptions: { providerSettingsId: provider.id, runtimeProviderId: provider.runtimeProviderId, model: model.id, reasoning: "none", permission: "read-only", mode: "agent", mcpEnabled: false } });
  return { root, catalog, productRuns, runtime, plugin, settings, service, sessions, requests, gates, started, failures, item, dataPath, setLinkingStop: (stop: typeof linkingStop) => { linkingStop = stop; } };
}
type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function metadataInterleaving(f: Fixture): Promise<void> {
  const original = (await f.catalog.get("A"))!;
  await Promise.all([
    f.plugin.setPiConversationTaskMetadata("A", { taskStatus: "running", taskStage: "真实运行步骤" }),
    f.plugin.setPiConversationTaskMetadata("A", { unreadAnswerAt: undefined, lastReadAt: 123 })
  ]);
  const result = (await f.catalog.get("A"))!;
  assert.equal(result.taskStatus, "running"); assert.equal(result.taskStage, "真实运行步骤"); assert.equal(result.lastReadAt, 123);
  assert.equal(result.agentId, "sol"); assert.equal(result.updatedAt, original.updatedAt);
  await f.catalog.upsert({ ...original, title: "A renamed from a stale full-entry writer" });
  assert.equal((await f.catalog.get("A"))!.taskStage, "真实运行步骤", "A late non-task upsert must retain newer task fields");
  await f.plugin.setPiConversationTaskMetadata("C", { unreadAnswerAt: 333 });
  await f.plugin.setPiConversationTaskMetadata("C", { taskStage: "仍由同事负责" });
  assert.equal((await f.catalog.get("C"))!.agentId, "colleague", "A partial patch cannot default the task back to sol");
  await f.plugin.setPiConversationTaskMetadata("C", { unreadAnswerAt: undefined });
  assert.equal((await f.catalog.get("C"))!.unreadAnswerAt, undefined);
}

async function viewLifetimeAndConcurrency(f: Fixture, createView: (plugin: any, detach: () => void) => any): Promise<void> {
  for (const task of ["A", "B", "C"]) { f.gates.set(task, deferred()); f.started.set(task, deferred()); }
  let renders = 0;
  const detach = f.service.subscribe({ refresh: () => { renders++; }, clearAcceptedDraft() {}, isTaskVisible: id => id === "A" });
  const accepted = await Promise.all(["A", "B", "C"].map(task => f.service.start(f.item(task, `PRIVATE-${task} ` + "old context ".repeat(300)), "composer")));
  assert.deepEqual(accepted, ["running", "running", "running"]);
  const tasks = ["A", "B", "C"].map(task => f.service.runs.get(task)!.flight!);
  await Promise.all(["A", "B", "C"].map(task => f.started.get(task)!.promise));
  await assert.rejects(f.service.run(f.item("A", "duplicate")), /already_running/);
  const queueStarted = deferred(); f.started.set("A", queueStarted);
  f.service.turnQueue.enqueue(f.item("A", "A-QUEUED-FROZEN"));
  const a = f.service.runs.get("A")!;
  const now = Date.now();
  a.context!.setPendingInteraction("A", { kind: "question", interactionId: "interaction-A", conversationId: "A", piSessionId: (await f.catalog.get("A"))!.piSessionId,
    turnId: a.activeTurnId, status: "pending", createdAt: now, updatedAt: now,
    questions: [{ questionId: "question-A", prompt: "确认本任务范围？", selection: "single", allowSupplement: true, options: [{ optionId: "yes", label: "确认" }] }] });
  await f.plugin.setPiConversationTaskMetadata("A", { taskStage: "waiting-fixture" });
  assert.equal((await f.catalog.get("A"))!.taskStatus, "waiting");
  assert.equal((await f.catalog.get("A"))!.pendingResponse!.questionId, "question-A");
  await createView(f.plugin, detach).onClose();
  const reopened = createView(f.plugin, () => undefined);
  assert.equal(reopened.pendingInteractionsBySession.get("A").questions[0].prompt, "确认本任务范围？");
  assert.equal(reopened.pendingInteractionsBySession.get("A").questions[0].options[0].optionId, "yes", "Closing a real View lifecycle cannot clear plugin-owned pending questions");
  a.context!.setPendingInteraction("A", { ...f.service.pendingInteractions.get("A")!, status: "answered" } as any);
  await f.plugin.setPiConversationTaskMetadata("A", { taskStage: "after-answer-fixture" });
  assert.equal((await f.catalog.get("A"))!.taskStatus, "running");
  const renderedBefore = renders;
  for (const task of ["A", "B", "C"]) f.gates.get(task)!.resolve();
  assert.deepEqual(await Promise.all(tasks), ["completed", "completed", "completed"]);
  await queueStarted.promise;
  await f.service.runs.get("A")?.flight;
  assert.equal(renders, renderedBefore, "Closed views cannot be retained by runtime callbacks");
  for (const task of ["A", "B", "C"]) {
    f.gates.delete(task);
    assert.equal((await f.catalog.get(task))!.taskStatus, "completed");
    assert.ok((await f.catalog.get(task))!.unreadAnswerAt, "Completion after all Views close stays unread");
    const before = (await f.productRuns.list(task)).length;
    const reattach = f.service.subscribe({ refresh() {}, clearAcceptedDraft() {}, isTaskVisible: () => false });
    assert.ok((await f.runtime.readProjection(task)).messages.some(message => message.text.includes(`PRIVATE-${task}`)));
    reattach();
    assert.equal((await f.productRuns.list(task)).length, before, "Reopening subscribes without executing again");
    assert.ok(f.requests.get(task)!.every(request => !["A", "B", "C"].some(other => other !== task && request.includes(`PRIVATE-${other}`))));
  }
  assert.equal((await f.productRuns.list("A")).length, 2, "The plugin-owned queue must continue after View detach");
  assert.ok(JSON.parse(await readFile(f.dataPath, "utf8")).sessions.length >= 3);
}

async function compressionAndHistory(f: Fixture): Promise<void> {
  const session = f.sessions.get("A");
  await session.compact("Preserve only task A and its key decisions.");
  const entries = session.sessionManager.getEntries();
  const compaction = entries.find((entry: any) => entry.type === "compaction");
  assert.ok(compaction, "Use real Pi compaction, not a second task summary store");
  assert.equal(await f.service.run(f.item("A", "AFTER-COMPACTION-A")), "completed");
  const latest = f.requests.get("A")!.at(-1)!;
  assert.ok(requestText(JSON.parse(latest)).includes(compaction.summary), "The actual next Provider request must contain the Pi summary");
  assert.ok(latest.includes("AFTER-COMPACTION-A"));
  assert.equal(latest.includes("PRIVATE-B"), false);
  assert.equal(latest.includes("PRIVATE-C"), false);
  const projection = await f.runtime.readProjection("A");
  assert.ok(projection.messages.some(message => message.text.includes("PRIVATE-A")), "Full historical messages remain projectable after compaction");
  const runs = await f.productRuns.list("A");
  assert.ok(runs.every(run => run.agentSnapshot?.agentId === "sol"));
  assert.ok(runs.every(run => !Object.hasOwn(run.agentSnapshot!, "avatar")));
}

async function deletionStopsBeforeHandoff(f: Fixture): Promise<void> {
  f.gates.set("delete-task", deferred()); f.started.set("delete-task", deferred());
  const entryBefore = (await f.catalog.get("delete-task"))!;
  const flight = f.service.run(f.item("delete-task", "DELETE-TASK-CONTEXT"));
  await f.started.get("delete-task")!.promise;
  f.service.turnQueue.enqueue(f.item("delete-task", "MUST-NOT-AUTO-RERUN"));
  const update = f.catalog.updateTaskMetadata.bind(f.catalog);
  f.catalog.updateTaskMetadata = async (...args) => {
    if (args[0] === "delete-task" && args[1].agentId === "sol") throw new Error("injected_handoff_save_failure");
    return await update(...args);
  };
  const linkingStopped = deferred(); const releaseLinking = deferred();
  let lateCreated = false;
  f.setLinkingStop(async origins => {
    if (!origins.includes("delete-task")) { assert.ok(origins.includes("late-colleague-judge")); return; }
    assert.equal((await f.productRuns.list("delete-task"))[0].terminalState, "cancelled", "Ordinary runs settle before hidden business writes are drained");
    linkingStopped.resolve(); await releaseLinking.promise;
    if (!lateCreated) {
      lateCreated = true;
      await f.runtime.createConversation({ conversationId: "late-colleague-judge", title: "late judge", cwd: f.root, agentId: "colleague" });
    }
  });
  const deleting = f.plugin.deleteAgent("colleague");
  await linkingStopped.promise;
  assert.equal((await f.catalog.get("delete-task"))!.agentId, "colleague", "No ownership transfer before hidden in-flight writes finish");
  assert.equal(f.settings.agentRegistry.agents.some(agent => agent.id === "colleague"), true);
  releaseLinking.resolve();
  await assert.rejects(deleting, /injected_handoff_save_failure/);
  assert.equal(f.settings.agentRegistry.agents.some(agent => agent.id === "colleague"), true, "A failed handoff must keep the Agent definition retryable");
  assert.equal((await f.catalog.get("delete-task"))!.agentId, "colleague");
  f.catalog.updateTaskMetadata = update;
  await f.plugin.deleteAgent("colleague");
  assert.equal(await flight, "cancelled");
  const after = (await f.catalog.get("delete-task"))!;
  assert.equal(after.agentId, "sol"); assert.equal(after.piSessionId, entryBefore.piSessionId);
  assert.equal((await f.catalog.get("late-colleague-judge"))!.agentId, "sol", "Handoff must include internal Conversations created by the just-drained business write");
  assert.equal(f.settings.agentRegistry.agents.some(agent => agent.id === "colleague"), false);
  assert.equal(f.service.turnQueue.isSessionQueuePaused("delete-task"), true);
  const runs = await f.productRuns.list("delete-task");
  assert.equal(runs.length, 1); assert.equal(runs[0].agentSnapshot!.agentId, "colleague"); assert.equal(runs[0].terminalState, "cancelled");
  assert.ok((await f.runtime.readProjection("delete-task")).messages.some(message => message.text.includes("DELETE-TASK-CONTEXT")));
  await assert.rejects(f.plugin.deleteAgent("sol"), /cannot_be_deleted/);
}

async function unloadingStopsAll(f: Fixture): Promise<void> {
  f.gates.set("unload-task", deferred()); f.started.set("unload-task", deferred());
  assert.equal(await f.service.start(f.item("unload-task"), "composer"), "running", "A UI start returns at acceptance without retaining its View until task completion");
  const flight = f.service.runs.get("unload-task")!.flight!;
  await f.started.get("unload-task")!.promise;
  await f.service.dispose();
  assert.equal(await flight, "cancelled");
  assert.equal((await f.catalog.get("unload-task"))!.taskStatus, "interrupted");
  assert.equal((await f.productRuns.list("unload-task"))[0].terminalState, "cancelled");
}

async function failureIsNotCompletion(f: Fixture): Promise<void> {
  f.failures.add("C");
  assert.equal(await f.service.run(f.item("C", "FORCED-FAILURE")), "failed");
  const run = (await f.productRuns.list("C")).at(-1)!;
  assert.equal(run.terminalState, "failed");
  assert.ok(run.error, "The real Provider error must remain on the durable run");
  assert.equal((await f.catalog.get("C"))!.taskStatus, "interrupted");
  assert.equal((await f.catalog.get("C"))!.taskCompletedAt, undefined);
  f.failures.delete("C");
}

function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
function requestText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(requestText).join("\n");
  return value && typeof value === "object" ? Object.values(value).map(requestText).join("\n") : "";
}
