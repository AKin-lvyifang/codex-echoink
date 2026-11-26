import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as path from "node:path";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, CURRENT_SESSION_VERSION, VERSION } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiNativeConversationRuntime } from "../../harness/pi-native/pi-native-conversation-runtime";
import { FileConversationCatalog } from "../../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../../harness/pi-native/file-product-run-store";
import { createControlledVaultResourceLoader, createControlledPiToolRegistration } from "../../harness/pi-native/controlled-resources";
import { createPiKnowledgeInlineExtension } from "../../plugin/pi-production-runtime-composition";
import { createPiVaultToolSecurityAdapter, createSecurePiVaultToolResultCorrectionPort } from "../../harness/pi-native/pi-vault-tool-security-extension";
import { EchoInkVaultToolEgressPolicy } from "../../harness/pi-native/vault-tool-result-safety";
import { PiObsidianToolSecurity, createPiObsidianToolDefinitions } from "../../harness/pi-native/pi-obsidian-tools";
import { createObsidianNativePort } from "../../plugin/obsidian-native-tools";
import { createOfficialObsidianCliTransport, type ObsidianCliProcessResult } from "../../plugin/obsidian-official-cli";
import { ObsidianVaultDomainAdapter } from "../../plugin/obsidian-vault-domain-adapter";
import { nativeJournalFixture } from "../native-journal-fixture";

type Scenario = "prepare" | "child" | "watchdog" | "help" | "queued";

export async function runObsidianCliPipelineTests(root: string): Promise<void> {
  const checks = (["prepare", "child", "watchdog", "help", "queued"] satisfies Scenario[]).map(scenario =>
    () => runScenario(path.join(root, scenario), scenario));
  const errors: unknown[] = [];
  for (const check of checks) {
    try { await check(); } catch (error) { errors.push(error); console.error(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Obsidian CLI pipeline regressions");
}

async function runScenario(root: string, scenario: Scenario) {
  const fixture = await nativeJournalFixture(root);
  const folders = Array.from({ length: 11 }, (_, index) => `folder-${index + 1}`);
  for (const folder of folders) await fixture.write(`${folder}/sample.md`, "# Fixture");
  const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, ".pi"), vaultId: "cli-pipeline" });
  const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, ".pi"), vaultId: catalog.vaultId, catalog });
  const provider = fauxProvider({ provider: "offline-cli", api: "openai-completions", models: [{ id: "cli", contextWindow: 32_000, maxTokens: 1024, reasoning: false }] });
  let providerCalls = 0;
  let modelResults: { id: string; status: string }[] = [];
  const timings: { stage: string; ms: number }[] = [];
  const started = performance.now();
  const mark = (stage: string) => timings.push({ stage, ms: Math.round(performance.now() - started) });
  provider.setResponses([
    () => {
      providerCalls++;
      mark("assistant:batch");
      return fauxAssistantMessage(folders.map((folder, i) =>
        fauxToolCall("obsidian_cli", { command: "folder", path: folder, info: "files" }, { id: `cli-${i + 1}` })), { stopReason: "toolUse" });
    },
    context => {
      providerCalls++;
      mark("assistant:continued");
      modelResults = context.messages.flatMap(message => {
        if (message.role !== "toolResult") return [];
        const content = message.content[0];
        const raw = content?.type === "text" ? content.text : "";
        let status = raw;
        try { const result = JSON.parse(raw); status = result.reason ?? result.status; } catch { /* Pi can return a plain policy reason. */ }
        return [{ id: message.toolCallId, status }];
      });
      return fauxAssistantMessage("Done");
    },
    () => { providerCalls++; return fauxAssistantMessage("Still ready"); }
  ]);
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(provider.provider);
  const model = provider.getModel();
  let operationReady!: () => void;
  const entered = new Promise<void>(resolve => { operationReady = resolve; });
  let releasePending: (() => void) | undefined;
  let childKilled = false;
  let preflights = 0, helpCalls = 0, runSequence = 0;
  const ok = (output: string): ObsidianCliProcessResult => ({ status: "completed", started: true, output });
  const official = createOfficialObsidianCliTransport(root, {
    timeoutMs: 35,
    findExecutable: async () => "/fixture/obsidian-cli",
    executeFile: ((_executable: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      mark("child:spawn");
      const child = Object.assign(new EventEmitter(), {
        kill() { childKilled = true; mark("child:kill"); return true; },
        stdout: null,
        stderr: null
      });
      queueMicrotask(() => { child.emit("spawn"); operationReady(); });
      releasePending = () => { mark("child:late-callback"); callback(null, "late fixture output", ""); };
      return child;
    }) as NonNullable<Parameters<typeof createOfficialObsidianCliTransport>[1]>["executeFile"]
  });
  const port = createObsidianNativePort(fixture.app, new ObsidianVaultDomainAdapter(fixture.app, catalog.vaultId, root), () => "", {
    transport: { async run(argv, signal) {
      const command = argv[0];
      const stage = command === "vault" ? `vault-${++preflights}` : command === "help" ? `help-${++helpCalls}` : argv[1] ?? command;
      mark(`${stage}:start`);
      try {
        if (command === "help" && scenario === "help") return { status: "failed", started: true, output: "", reason: "obsidian_cli_timeout" };
        if (command === "folder" && argv.includes("path=folder-3") && scenario === "child") return await official.run(argv, signal);
        return ok(command === "vault" ? root : command === "help" ? "folder" : "sample.md");
      } finally { mark(`${stage}:end`); }
    } }
  });
  const runtime = new PiNativeConversationRuntime({
    catalog, productRuns,
    sessionApi: { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION, open: (file, dir, cwd) => SessionManager.open(file, dir, cwd) },
    resolveConversationCwd: () => root, idFactory: () => `cli-run-${++runSequence}`,
    createAgentSession: async input => {
      let gated = false;
      const nativeSecurity = new PiObsidianToolSecurity({
        currentAccess: input.currentWorkspaceAccess,
        readTimeoutMs: 550,
        async assertToolAllowed(_tool, args) {
          if (args.path !== "folder-3" || gated || (scenario !== "prepare" && scenario !== "watchdog")) return;
          gated = true;
          mark("cli-3:authorize:start");
          await new Promise<void>(resolve => { releasePending = resolve; operationReady(); });
          mark("cli-3:authorize:end");
        }
      });
      const security = createPiVaultToolSecurityAdapter({
        isToolAllowed: () => true,
        obsidianReadSignal: id => nativeSecurity.readDeadline.signalForCall(id),
        authorization: { async authorize() { throw new Error("ordinary note tools are outside this fixture"); } },
        resultCorrection: createSecurePiVaultToolResultCorrectionPort(new EchoInkVaultToolEgressPolicy()),
        additionalToolSecurities: [nativeSecurity]
      });
      const tools = createPiObsidianToolDefinitions(port, nativeSecurity).filter(tool => tool.name === "obsidian_cli")
        .map(tool => scenario === "watchdog" ? { ...tool, executionMode: "sequential" as const } : tool);
      const registration = createControlledPiToolRegistration(tools);
      const resourceLoader = await createControlledVaultResourceLoader({ vaultRoot: root, skillPaths: [], systemPrompt: "EchoInk Obsidian CLI fixture.",
        inlineExtension: createPiKnowledgeInlineExtension({ vaultSecurity: security.inlineExtension, currentWorkspaceAccess: input.currentWorkspaceAccess, currentTurn: input.currentKnowledgeTurnContext, currentSkillTurn: input.currentSkillTurnContext }) });
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model, thinkingLevel: "off", sessionManager: input.sessionManager,
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader, ...registration, customTools: registration.customTools?.map(tool => nativeSecurity.readDeadline.wrapTool(tool)) });
      nativeSecurity.readDeadline.install(session.agent);
      session.subscribe(event => { if (event.type === "queue_update") mark(`queue:${event.steering.length}:${event.followUp.length}`); });
      if (scenario === "queued") session.agent.subscribe(async event => {
        if (event.type === "tool_execution_start" && event.toolCallId === "cli-1") await delay(650);
      });
      session.setActiveToolsByName(["obsidian_cli"]);
      return { session, planToolNames: ["obsidian_cli"] };
    }
  });
  const conversationId = "cli";
  const submit = () => runtime.submit({ conversationId, text: "List fixture folders", submittedAt: Date.now(), runtimeProviderId: "offline-cli", modelId: "cli", reasoning: "none", permission: "read-only", mode: "agent" });
  let result: Promise<unknown> | undefined;
  try {
    await runtime.initialize();
    await runtime.createConversation({ conversationId, title: "CLI fixture", cwd: root });
    const run = await submit();
    result = run.result;
    void run.result.catch(() => undefined);
    if (scenario === "watchdog") {
      await Promise.race([entered, delay(1000).then(() => assert.fail("third preparation did not start"))]);
      await runtime.steer(conversationId, "Preserve this queued input");
      await runtime.followUp(conversationId, "Preserve the follow-up");
      mark("inputs:queued");
      mark("watchdog:interrupt");
      await runtime.recordTaskInterruption(conversationId, "watchdog");
      await runtime.abort(conversationId);
      assert.equal((await run.result).terminalState, "cancelled");
      const projection = await runtime.readProjection(conversationId);
      const toolCards = projection.messages.filter(message => message.role === "tool");
      assert.equal(toolCards.length, 11);
      assert.ok(toolCards.every(message => ["completed", "failed", "interrupted", "cancelled"].includes(message.status ?? "")));
      assert.deepEqual(projection.drafts.filter(draft => draft.source === "abort").map(draft => draft.text).sort(),
        ["Preserve the follow-up", "Preserve this queued input"]);
      assert.ok(projection.drafts.every(draft => draft.source === "abort"));
      assert.equal(projection.diagnostics.some(entry => entry.message.includes("projection_unsettled")), false);
      assert.equal((await (await submit()).result).terminalState, "completed");
      assert.ok(providerCalls >= 2);
      return;
    }
    const outcome = await Promise.race([run.result, delay(1250).then(() => "still_waiting" as const)]);
    assert.notEqual(outcome, "still_waiting", `${scenario}: no model continuation with bounded fault`);
    if (outcome === "still_waiting") return;
    assert.equal(outcome.terminalState, "completed", outcome.error);
    assert.equal(providerCalls, 2);
    assert.equal(modelResults.length, 11);
    assert.equal(modelResults[2]?.status, "obsidian_cli_timeout");
    const expectedPeer = scenario === "help" || scenario === "queued" ? "obsidian_cli_timeout" : "completed";
    assert.equal(modelResults[0]?.status, expectedPeer);
    assert.equal(modelResults[10]?.status, expectedPeer);
    if (scenario === "child") assert.equal(childKilled, true);
    if (scenario === "queued") assert.equal(preflights, 0, "Expired queued calls must never start the CLI");
  } finally {
    releasePending?.();
    console.log("CLI pipeline trace", JSON.stringify({ scenario, providerCalls, modelResults, timings }));
    await result?.catch(() => undefined);
    await runtime.shutdown();
  }
}
