import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, VERSION, CURRENT_SESSION_VERSION, type AgentSession } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";
import { FileProductRunStore } from "../harness/pi-native/file-product-run-store";
import { PiNativeConversationRuntime, type PiNativeAgentSessionFactoryInput, readDurablePiConversationProjection } from "../harness/pi-native/pi-native-conversation-runtime";
import { createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { withToolRoundLimit } from "../harness/pi-native/pi-tool-round-limit";
import { TOOL_ROUND_STOP_MESSAGE, TOOL_ROUND_BLOCK_MESSAGE } from "../agents/tool-round-budget";
import { taskInterruptionExplanation } from "../agents/task-interruption-copy";

const api = { codingAgentVersion: VERSION, currentSessionVersion: CURRENT_SESSION_VERSION,
  open: (file: string, root: string, cwd?: string) => SessionManager.open(file, root, cwd) };

export async function runToolRoundLimitTests(): Promise<void> {
  for (const scenario of ["repeat", "changing", "invalid", "unknown", "multiple", "finish", "retry", "steer", "upgrade", "extended", "compaction"]) {
    if (process.env.TOOL_ROUND_CASE && process.env.TOOL_ROUND_CASE !== scenario) continue;
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "echoink-tool-round-")));
    const catalog = new FileConversationCatalog({ storageRootPath: path.join(root, "pi"), vaultId: "tool-round-fixture" });
    const productRuns = new FileProductRunStore({ storageRootPath: path.join(root, "pi"), vaultId: catalog.vaultId, catalog });
    let id = 0, executed = 0, authorized = 0, toolRounds = 0, retried = false, compactions = 0, starts = 0;
    let session!: AgentSession, input!: PiNativeAgentSessionFactoryInput, resume = false;
    const events: string[] = [];
    const runtime = new PiNativeConversationRuntime({ catalog, productRuns, sessionApi: api,
      resolveConversationCwd: () => root, idFactory: () => `round-${++id}`,
      createAgentSession: async factoryInput => {
        input = factoryInput;
        const provider = fauxProvider({ provider: "round-fixture", api: "openai-completions", models: [{ id: "round-model", contextWindow: 200_000, maxTokens: 1024 }] });
        const respond = async (context: { messages: readonly unknown[]; tools?: readonly unknown[] }, options: { signal?: AbortSignal } | undefined) => {
          if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
          if (resume) { assert.equal(input.currentToolRoundBudget?.()?.block(), undefined); return fauxAssistantMessage("已继续，额度重新计算。"); }
          if ((scenario === "retry" || scenario === "compaction") && toolRounds === 20 && !retried) {
            retried = true;
            return fauxAssistantMessage("", { stopReason: "error", errorMessage: scenario === "retry" ? "overloaded" : "context_length_exceeded" });
          }
          // Native compaction uses a separate request without the original tools.
          if (scenario === "compaction" && retried && !context.tools?.length && compactions === 0) {
            compactions++; return fauxAssistantMessage("User asked to inspect the note. No writes were performed.");
          }
          if (scenario === "steer" && toolRounds === 50) await runtime.steer("task", "新的用户要求，继续核对");
          if (scenario === "upgrade" && toolRounds === 50) {
            // Simulate the existing maintenance router activating its live commandKind.
            const active = (runtime as unknown as { active: Map<string, { currentRun: { commandKind: string } }> }).active.get("task")!;
            active.currentRun.commandKind = "maintain";
          }
          if (scenario === "finish" && JSON.stringify(context.messages.at(-1)).includes(TOOL_ROUND_BLOCK_MESSAGE)) return fauxAssistantMessage("资料没有查到，我只能确认已有信息。");
          return fauxAssistantMessage(Array.from({ length: scenario === "multiple" ? 3 : 1 }, (_, index) => fauxToolCall(scenario === "unknown" ? "missing_tool" : "note_read",
            scenario === "invalid" ? {} : { path: scenario === "changing" ? `note-${toolRounds}.md` : "note.md" }, { id: `call-${provider.state.callCount}-${index}` })), { stopReason: "toolUse" });
        };
        provider.setResponses(Array.from({ length: 300 }, () => respond));
        const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
        modelRuntime.registerNativeProvider(provider.provider); const model = provider.getModel();
        const loader = await createControlledVaultResourceLoader({ vaultRoot: root, systemPrompt: "Offline fixture.",
          inlineExtension: withToolRoundLimit({ name: "round-security", factory: pi => {
            pi.on("tool_call", () => { authorized++; }); pi.on("tool_result", () => undefined);
          } }, () => { const budget = input.currentToolRoundBudget?.(); budget?.upgrade(scenario === "extended"); return budget; }, () => input.stopToolRoundLimit?.()) });
        ({ session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: input.sessionManager, modelRuntime, model, noTools: "all", tools: ["note_read"],
          customTools: [{ name: "note_read", label: "read", description: "read a note", parameters: Type.Object({ path: Type.String() }),
            async execute() { executed++; return { content: [{ type: "text", text: "empty" }] }; } }], resourceLoader: loader,
          settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off",
            compaction: { enabled: scenario === "compaction", reserveTokens: 1024, keepRecentTokens: 64 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }) }));
        session.subscribe(event => { events.push(event.type); if (event.type === "agent_start") starts++; if (event.type === "turn_end" && event.message.role === "assistant" && Array.isArray(event.message.content) && event.message.content.some(part => part.type === "toolCall")) toolRounds++; });
        return { session };
      } });
    try {
      await runtime.initialize(); await runtime.createConversation({ conversationId: "task", title: scenario, cwd: root });
      if (scenario === "compaction") {
        await runtime.activateConversation("task", { runtimeProviderId: "round-fixture", modelId: "round-model" });
        input.sessionManager.appendMessage({ role: "user", content: "Old request ".repeat(1500), timestamp: Date.now() - 1000 });
        input.sessionManager.appendMessage(fauxAssistantMessage("Old answer ".repeat(1500)));
        session.agent.state.messages = input.sessionManager.buildSessionContext().messages;
      }
      const handle = await runtime.submit({ reasoning: "none", runtimeProviderId: "round-fixture", modelId: "round-model", conversationId: "task", text: "读取来源", submittedAt: Date.now(), permission: "read-only" });
      const result = await handle.result;
      const limit = scenario === "extended" || scenario === "upgrade" ? 150 : scenario === "steer" ? 110 : 60;
      assert.equal(toolRounds, scenario === "finish" ? 61 : limit + 3, scenario);
      assert.equal(executed, scenario === "invalid" || scenario === "unknown" ? 0 : limit * (scenario === "multiple" ? 3 : 1), scenario);
      assert.equal(authorized, executed, "blocked calls never enter authorization");
      if (scenario === "retry") assert.ok(starts >= 2 && retried, "native retry resumed without a fresh budget");
      if (scenario === "compaction") { console.log(JSON.stringify({ events: [...new Set(events)], starts, compactions })); assert.ok(events.includes("compaction_end") && compactions > 0 && starts >= 2, "native compaction continued the run"); }
      if (scenario === "finish") assert.equal(result.terminalState, "completed");
      else {
        assert.equal(result.interruption?.reason, "tool_loop_limit"); assert.equal(result.terminalState, "cancelled");
        assert.equal(taskInterruptionExplanation(result.interruption, "zh"), TOOL_ROUND_STOP_MESSAGE);
        await runtime.releaseConversation("task");
        const cold = await readDurablePiConversationProjection({ catalog, productRuns, sessionApi: api, conversationId: "task", resolveConversationCwd: () => root });
        assert.ok(cold.messages.some(message => message.text === TOOL_ROUND_STOP_MESSAGE), "cold projection retains the exact stop copy");
        assert.ok(!cold.messages.some(message => message.role !== "tool" && /网络错误|被你停止|provider_network_error/.test(message.text)));
        resume = true;
        const continued = await runtime.submit({ reasoning: "none", runtimeProviderId: "round-fixture", modelId: "round-model", conversationId: "task", text: "继续", submittedAt: Date.now() });
        assert.equal((await continued.result).terminalState, "completed");
        assert.equal(input.currentToolRoundBudget?.()?.block(), undefined, "explicit continuation starts a fresh allowance");
        const afterContinue = await runtime.readProjection("task");
        assert.ok(afterContinue.messages.findIndex(message => message.text === TOOL_ROUND_STOP_MESSAGE) < afterContinue.messages.findIndex(message => message.text === "已继续，额度重新计算。"), "historical stop stays before the new answer");
      }
      console.log(JSON.stringify({ platform: "desktop", scenario, toolRounds, executed, authorized, starts, compactions, terminalState: result.terminalState, reason: result.interruption?.reason, status: "PASS" }));
    } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
  }
}
