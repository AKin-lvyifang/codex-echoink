import assert from "node:assert/strict";
import CodexForObsidianPlugin from "../main";
import { PersonalMemoryRecallHarness } from "../harness/memory/personal-memory-recall-harness";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { PI_MEMORY_SOURCES_ENTRY_TYPE, normalizeInjectedMemorySources } from "../harness/pi-native/pi-memory-sources";
import { createReasoningSummary, updateReasoningActivity, closeReasoningSummary } from "../harness/pi-native/pi-reasoning-summary";
import { ECHOINK_REASONING_SUMMARY_ENTRY_TYPE, reasoningSummaryEntryData } from "../types/reasoning-summary";
import type { InjectedPersonalMemorySourceReference } from "../settings/settings";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { buildAgentTurns } from "../ui/codex-view/agent-turn-process";
import { FakeElement, createTestContext, renderedText } from "./smooth-conversation-ui";
import { withPersonalMemoryFixture } from "./personal-memory-fixture";

export async function runMemorySourceTests(): Promise<void> {
  assert.deepEqual(normalizeInjectedMemorySources([
    null, 1, "source", { id: 1, title: "错误编号" }, { id: "invalid", title: 1 },
    { id: "  first  ", title: "  第一条  ", revision: 2 }, { id: "first", title: "重复项", revision: 3 },
    { id: "second", title: "第二条", revision: "2" }, { id: "third", title: "第三条", revision: 1.5 }
  ]), [{ id: "first", title: "第一条", revision: 2 }, { id: "second", title: "第二条" }, { id: "third", title: "第三条" }]);
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: new FakeElement("body"), createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag)
  } });
  try {
    await withPersonalMemoryFixture(async fixture => {
      const records = [];
      for (const [title, content] of [["银槐颜色", "银槐验收的首选颜色是湖蓝。"], ["银槐饮品", "银槐验收的首选饮品是无糖桂花乌龙。"]]) {
        const result = await fixture.repository.write({ operation: "create", kind: "fact", title, content,
          recallWhen: "询问银槐验收颜色或饮品", basis: "explicit" }, fixture.runtime());
        records.push(result.record!);
      }
      const recall = new PersonalMemoryRecallHarness(fixture.repository);
      const handlers = new Map<string, (event: any) => Promise<any>>();
      let workflow: "chat" | "ask" = "chat";
      let memoryMode: "normal" | "no_memory" = "normal";
      const snapshots: Array<{ productRunId: string; sources: readonly InjectedPersonalMemorySourceReference[] }> = [];
      const askSnapshots: unknown[] = [];
      const extension = createPiKnowledgeInlineExtension({
        vaultSecurity: { name: "memory-source-fixture", hidden: true, factory: async () => undefined } as never,
        currentTurn: () => ({ kind: workflow, references: [], providerResourceText: "" } as never),
        currentMemoryTurn: () => ({ ...fixture.runtime(), query: "银槐验收的首选颜色和饮品是什么？", memoryMode }),
        currentTaskPlanTurn: () => null,
        personalMemory: { loadFixedContext: input => fixture.repository.loadFixedContext(input),
          prepareTurnContext: input => recall.prepareTurnContext(input) },
        onPersonalMemorySourcesInjected: snapshot => { snapshots.push(snapshot); },
        onAskPersonalMemorySourcesInjected: snapshot => { askSnapshots.push(snapshot); }
      });
      await extension.factory({ on: (name: string, handler: (event: any) => Promise<any>) => { handlers.set(name, handler); } } as never);
      for (workflow of ["chat", "ask"] as const) {
        const previous = snapshots.length;
        const before = await handlers.get("before_agent_start")!({ systemPrompt: "SYSTEM", systemPromptOptions: { skills: [] } });
        assert.equal(snapshots.length, previous, "candidate preparation alone is not actual injection");
        const event = { messages: [{ role: "user", content: "银槐验收", timestamp: 1 },
          ...(before?.message ? [{ role: "custom", ...before.message, timestamp: 2 }] : [])] };
        const context = await handlers.get("context")!(event);
        assert.equal(snapshots.length, previous + 1);
        assert.match(JSON.stringify(context), /湖蓝/u); assert.match(JSON.stringify(context), /无糖桂花乌龙/u);
        assert.deepEqual(new Set(snapshots.at(-1)!.sources.map(source => source.id)), new Set(records.map(record => record.id)));
        assert.ok(snapshots.at(-1)!.sources.every(source => source.revision !== undefined));
        assert.doesNotMatch(JSON.stringify(snapshots.at(-1)), /湖蓝|乌龙|recallWhen|summary|content/u);
        await handlers.get("context")!(event);
        assert.equal(snapshots.length, previous + 1, "tool continuation must not duplicate injection receipts");
      }
      assert.equal(askSnapshots.length, 1, "legacy ask attribution remains ask-only");
      memoryMode = "no_memory";
      await handlers.get("before_agent_start")!({ systemPrompt: "SYSTEM", systemPromptOptions: { skills: [] } });
      const withoutMemory = await handlers.get("context")!({ messages: [{ role: "user", content: "普通问题", timestamp: 3 }] });
      assert.doesNotMatch(JSON.stringify(withoutMemory), /湖蓝|乌龙/u);
      assert.equal(snapshots.length, 2);

      const sources = snapshots[0].sources;
      const piSessionId = "memory-source-session", productRunId = "memory-source-run", conversationId = "memory-source-conversation";
      const summary = closeReasoningSummary({ terminalAt: 3, status: "completed", summary: updateReasoningActivity({
        summary: createReasoningSummary({ piSessionId, productRunId, conversationId, startedAt: 1 }),
        activity: { id: "memory:recall", kind: "memory", status: "completed", total: 2, completed: 2, startedAt: 1, updatedAt: 2 }
      }) });
      const entries = [
        { type: "message", id: "user", parentId: null, timestamp: "2026-10-20T00:00:00Z", message: { role: "user", content: "银槐验收" } },
        { type: "custom", id: "reasoning", parentId: "user", timestamp: "2026-10-20T00:00:01Z",
          customType: ECHOINK_REASONING_SUMMARY_ENTRY_TYPE, data: reasoningSummaryEntryData({ conversationId, piSessionId, summary }) },
        { type: "custom", id: "sources", parentId: "reasoning", timestamp: "2026-10-20T00:00:02Z",
          customType: PI_MEMORY_SOURCES_ENTRY_TYPE, data: { schemaVersion: 1, conversationId, piSessionId, productRunId, sources } },
        { type: "message", id: "answer", parentId: "sources", timestamp: "2026-10-20T00:00:03Z", message: { role: "assistant", content: "回答完成", stopReason: "stop" } }
      ];
      const projection = new PiChatUiProjector().projectSessionBranch({ piSessionId, activeLeafId: "answer", entries,
        runIdentities: [{ productRunId, userEntryId: "user", assistantEntryId: "answer" }] });
      const turn = buildAgentTurns(projection.messages)[0];
      const node = turn.processNodes.find(node => node.nodeId.endsWith(":memory:recall"))!;
      assert.ok(node);
      const plugin = Object.assign(Object.create(CodexForObsidianPlugin.prototype), { piLocalData: { personalMemory: fixture.repository } }) as CodexForObsidianPlugin;
      let reads = 0;
      const context = createTestContext();
      const render = () => {
        const renderer = new CodexMessageListRenderer();
        (renderer as unknown as { env: unknown }).env = { ...context, sessionId: conversationId, settingsLanguage: "zh-CN",
          messagesEl: new FakeElement("div"), virtualListEl: new FakeElement("div"), messages: projection.messages, options: {},
          readPersonalMemorySource: async (id: string, revision?: number) => { reads++; return await plugin.readEchoInkPersonalMemorySource(id, revision); },
          onScheduleMeasure: () => undefined };
        const process = new FakeElement("div"), footer = new FakeElement("div");
        (renderer as any).renderAssistantTurnProcessNode(process, turn, node);
        (renderer as any).renderAnswerSources(footer, turn);
        return { renderer, process, footer };
      };
      const initial = render();
      assert.equal(reads, 0, "collapsed details never read Memory bodies");
      assert.match(renderedText(initial.footer), /记忆：银槐颜色/u); assert.match(renderedText(initial.footer), /记忆：银槐饮品/u);
      assert.equal(initial.footer.findByClass("is-memory")!.querySelector("button"), null);
      const disclosure = initial.process.findByClass("codex-assistant-turn-resource")!;
      disclosure.open = true; await disclosure.ontoggle!({ isTrusted: true });
      assert.equal(reads, 2);
      assert.match(renderedText(initial.process), /首选颜色是湖蓝/u); assert.match(renderedText(initial.process), /首选饮品是无糖桂花乌龙/u);
      assert.equal(JSON.stringify(entries).includes("湖蓝"), false, "Session metadata contains identities, not copied originals");
      initial.renderer.dispose();
      await fixture.repository.write({ operation: "supersede", targetId: records[0].id, title: "银槐颜色更新", content: "改为绿色",
        recallWhen: "银槐颜色", basis: "explicit", reason: "fixture revision" }, fixture.runtime());
      await fixture.repository.write({ operation: "forget", targetId: records[1].id, explicitForget: true, reason: "fixture forget" }, fixture.runtime({ explicitlyAuthorized: true }));
      const changed = render();
      const reopened = changed.process.findByClass("codex-assistant-turn-resource")!;
      reopened.open = true; await reopened.ontoggle!({ isTrusted: true });
      assert.match(renderedText(changed.process), /已修订/u); assert.match(renderedText(changed.process), /已不存在或已被忘记/u);
      assert.doesNotMatch(renderedText(changed.process), /湖蓝|乌龙|改为绿色/u);
      changed.renderer.dispose();
    });
    console.log("PASS memory sources: real Recall -> actual chat/ask injection -> metadata -> cold projection -> lazy original read; changed/forgotten/no_memory stay truthful");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
}
