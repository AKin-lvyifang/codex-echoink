import { appendRequestContext, applyPromptCacheBoundary, providerCacheKey, stableToolOrder } from "../harness/pi/prompt-cache";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { createAgentSession, defineTool, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, Type, type Context, type Model, type Api } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appendCurrentDateContext } from "../harness/current-date-context";
import { createPiNativeControlledProvider } from "../harness/pi-native/pi-native-controlled-provider";
import { createControlledVaultResourceLoader } from "../harness/pi-native/controlled-resources";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { knowledgeSystemInlineExtension } from "../harness/pi-native/pi-knowledge-system-tools";
import { companyRouterPrompt, companyWorkerPrompt } from "../company/prompts";

export function assertDatePrompt(prompt: string, date: string, weekday: string, zone: string): void {
  assert.equal(prompt.split("<echoink_current_date>").length - 1, 1);
  assert.ok(prompt.endsWith("</echoink_current_date>"));
  assert.ok(prompt.includes(`当前本地日期：${date}，${weekday}；时区：${zone}。`), prompt);
}

export async function runCurrentDateContextTests(root: string): Promise<void> {
  const first = applyPromptCacheBoundary({ system: [{ type: "text", text: appendRequestContext("stable", "old date") }] }, true);
  const next = applyPromptCacheBoundary({ system: [{ type: "text", text: appendRequestContext("stable", "new date") }] }, true);
  assert.deepEqual((first as any).system[0], { type: "text", text: "stable", cache_control: { type: "ephemeral" } });
  assert.equal(JSON.stringify((first as any).system[0]), JSON.stringify((next as any).system[0]));
  assert.deepEqual((next as any).system[1], { type: "text", text: "new date" });
  assert.deepEqual(applyPromptCacheBoundary({ messages: [{ role: "system", content: appendRequestContext("stable", "date") }] }, false),
    { messages: [{ role: "system", content: "stable\n\ndate" }] });
  assert.deepEqual(stableToolOrder([{ name: "z" }, { name: "a" }]).map(tool => tool.name), ["a", "z"]);
  assert.notEqual(providerCacheKey("a"), providerCacheKey("b"));

  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const oldNow = Date.now;
  let now = new Date(2026, 10, 17, 23, 59).getTime();
  Date.now = () => now;
  try {
    assertDatePrompt(appendCurrentDateContext(undefined), "2026-11-17", "星期二", zone);
    // Same local day has byte-identical environment text, regardless of minute.
    assert.equal(appendCurrentDateContext("stable", now), appendCurrentDateContext("stable", now - 60_000));
    for (const role of ["ordinary", "router", "worker", "module-background"] as const) {
      now = new Date(2026, 10, 17, 23, 59).getTime();
      const directory = path.join(root, role); await mkdir(directory, { recursive: true });
      const faux = fauxProvider({ api: "openai-completions", provider: "date-fixture",
        models: [{ id: "date-model", reasoning: false, contextWindow: 32000, maxTokens: 1024 }], tokensPerSecond: 100_000 });
      const model = faux.getModel() as Model<Api>;
      const requests: Context[] = [];
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("knowledge_system_read", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("tool continuation"), fauxAssistantMessage("next user turn")
      ]);
      const provider = createPiNativeControlledProvider({ model,
        config: { read: async () => ({ providerId: model.provider, modelRef: model.id, baseUrl: "http://127.0.0.1:1/v1", apiProtocol: "openai-completions", authMode: "api-key" }) },
        currentExecutionContext: () => ({ runId: role, conversationId: role, turnId: role, correlationId: role }),
        controlledStream: { authorityId: "date-test", storeSetId: "date-test", stream: input => {
          requests.push(structuredClone(input.context));
          return faux.provider.stream(input.model, input.context, input.options);
        } }
      });
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
      modelRuntime.registerNativeProvider(provider);
      const rolePrompt = role === "router" ? companyRouterPrompt() : role === "worker" ? companyWorkerPrompt() : "";
      const extension = role === "module-background"
        ? knowledgeSystemInlineExtension({ ready: Promise.resolve(), forConversation: () => ({ domain: "日期测试", documents: [], coverage: {} }) } as never, role, async () => "模块负责人")
        : createPiKnowledgeInlineExtension({ vaultSecurity: pi => { pi.on("tool_call", () => {}); pi.on("tool_result", () => {}); },
          currentTurn: () => null, privateAgentContext: async () => rolePrompt });
      const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model,
        noTools: "builtin", customTools: [defineTool({ name: "knowledge_system_read", label: "跨午夜", description: "Offline clock advance", parameters: Type.Object({}),
          execute: async () => { now = new Date(2026, 10, 18, 0, 1).getTime(); return { content: [{ type: "text", text: "clock advanced" }], details: {} }; } })],
        sessionManager: SessionManager.create(directory, directory),
        settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false }, retry: { enabled: false }, packages: [], extensions: [], skills: [], prompts: [], themes: [], enableAnalytics: false }),
        resourceLoader: await createControlledVaultResourceLoader({ vaultRoot: directory, systemPrompt: "Stable global rules", inlineExtension: extension }) });
      try {
        await session.prompt("明天下午三点给小王回电话");
        assert.equal(requests.length, 2, `${role}: actual tool continuation ${JSON.stringify(session.messages.at(-1))}`);
        assert.equal(now, new Date(2026, 10, 18, 0, 1).getTime(), JSON.stringify(requests[1].messages));
        assertDatePrompt(requests[0].systemPrompt!, "2026-11-17", "星期二", zone);
        assertDatePrompt(requests[1].systemPrompt!, "2026-11-18", "星期三", zone);
        await session.prompt("同一会话继续");
        assertDatePrompt(requests[2].systemPrompt!, "2026-11-18", "星期三", zone);
        assert.ok(requests.every(request => request.systemPrompt!.startsWith("Stable global rules")));
        assert.ok(!session.systemPrompt.includes("<echoink_current_date>"), "request-local date must not accumulate in the session");
        if (role === "router" || role === "worker") assert.ok(requests[0].systemPrompt!.includes(`<echoink_company_${role}`));
        if (role === "module-background") assert.ok(requests[0].systemPrompt!.includes("正在梳理「日期测试」"));
        console.log(`PASS desktop ${role}: ${zone}, midnight tool continuation + next turn, one tail block`);
      } finally { session.dispose(); }
    }
  } finally { Date.now = oldNow; }
}
