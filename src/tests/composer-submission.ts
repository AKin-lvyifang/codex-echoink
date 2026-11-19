import * as assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installObsidianDom } from "./obsidian-dom";
import { preparationActivity, THINKING_NODE_ID, type PreparationUpdate, ComposerSubmissions, preparationText, reportPreparation, submissionFailureText, uniqueNotePaths } from "../types/composer-submission";
import { conversationCopy } from "../settings/i18n";
import { localizeKnownConversationSystemCopy } from "../ui/codex-view/ui-i18n";
import { renderComposerSubmission } from "../ui/composer-submission-renderer";
import { buildAgentTurns, buildPreparationProcessNodes } from "../ui/codex-view/agent-turn-process";
import { shouldShowThinkingLive } from "../ui/codex-view/message-list";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import type { PiChatRuntimeEvent } from "../harness/pi-native/contracts";
import { createReasoningSummary, updateReasoningActivity, closeReasoningSummary } from "../harness/pi-native/pi-reasoning-summary";
import { mobileSearchNotePaths, renderMobileSearchResult } from "../ui/mobile/preparation";

export function runComposerSubmissionTests(): void {
  assertUnifiedPreparationChain();
  const dom = new JSDOM("<!doctype html><body></body>");
  installObsidianDom(dom.window);
  try {
    assert.equal(submissionFailureText("所选 Provider 或模型已不可用，请检查 Provider 设置后重试。"), "所选模型服务或模型已不可用，请检查模型服务设置后重试。");
    assert.equal(submissionFailureText("队列所选 Provider 或模型已不可用；队首已保留并暂停，请检查 Provider 设置后继续。"), "消息未能发送，内容已保留。请重新发送；如问题持续，请在 设置 → 模型服务 中点击“测试连接”。");
    assert.equal(submissionFailureText("请检查 OpenAI Provider 和 API Key，再运行 OpenAI SDK。"), "请检查 OpenAI 模型服务和 API Key，再运行 OpenAI SDK。");
    const parent = dom.window.document.body;
    const submissions = new ComposerSubmissions<{ text: string }, { text: string }>();
    const record = submissions.begin("send-1", "task-1", { text: "原始问题" }, { text: "原始问题" });
    assert.equal(submissions.captureFailure("missing", "无承载"), false);
    assert.equal(submissions.captureFailure(record.id, "有气泡承载"), true);
    record.queued = true; assert.equal(submissions.captureFailure(record.id, "队列保留通知"), false); delete record.queued;
    record.phase = "review"; assert.equal(submissions.captureFailure(record.id, "核对保留通知"), false); record.phase = "preparing";
    const render = () => {
      parent.replaceChildren();
      renderComposerSubmission(parent, record, { text: record.snapshot.text, language: "zh-CN", userClass: "user",
        retry: () => { submissions.retry(record.id); }, edit: () => {}, button: (target, label, action) => {
          const button = target.ownerDocument.createElement("button"); button.textContent = label; button.onclick = () => { void action(); }; target.append(button);
        } });
    };
    render();
    assert.equal(parent.querySelectorAll("article").length, 1);
    assert.match(parent.textContent!, /原始问题.*思考中/su);
    assert.doesNotMatch(parent.textContent!, /发送中/u);
    submissions.stage(record.id, { stage: "thinking", status: "completed" });
    submissions.stage(record.id, { stage: "knowledge", status: "active" }); render();
    assert.equal(parent.querySelectorAll('[data-preparation-stage="knowledge"]').length, 1);
    submissions.stage(record.id, { stage: "knowledge", status: "completed", notePaths: ["资料/A.md", "资料/A.md", "资料/B.md"] }); render();
    assert.match(parent.textContent!, /读了 2 篇相关笔记/u);
    assert.equal(parent.querySelectorAll('[data-preparation-stage="knowledge"]').length, 1);
    // Empty/blank paths must show an inert empty result before and after acceptance.
    submissions.stage(record.id, { stage: "knowledge", status: "completed", notePaths: ["", " "] }); render();
    const emptyKnowledge = parent.querySelector('[data-preparation-stage="knowledge"]')!;
    assert.equal(emptyKnowledge.textContent, "没有找到相关笔记");
    assert.equal(emptyKnowledge.querySelector("details, summary, button, [aria-expanded]"), null);
    assert.equal(preparationText(record.stages.find(stage => stage.stage === "knowledge")!, "en"), "No related notes found");
    for (const language of ["zh-CN", "en"] as const) {
      assert.equal(conversationCopy(language).process.knowledgeResult(1330, 0), language === "en" ? "No related notes found" : "没有找到相关笔记");
    }
    assert.equal(localizeKnownConversationSystemCopy("en", "检索知识库 · 没有找到相关笔记"), "Search knowledge · No related notes found");
    parent.replaceChildren(); renderMobileSearchResult(parent, { hits: [], total: 1330 }, "en", () => {});
    assert.equal(parent.textContent, "No related notes found");
    assert.equal(parent.querySelector("details, summary, button, [aria-expanded]"), null);
    submissions.fail(record.id, "network offline"); render();
    assert.match(parent.textContent!, /网络/u); assert.equal(parent.querySelectorAll("button").length, 2);
    assert.ok(submissions.retry(record.id)); assert.equal(submissions.retry(record.id), undefined, "retry has one owner even across renders");
    submissions.accept(record.id, { userEntryId: "actual-user-entry" }); submissions.fail(record.id, "late failure");
    assert.equal(record.phase, "accepted", "a failure after durable acceptance cannot offer resend");
    assert.equal(submissions.captureFailure(record.id, "受理后保留原报错"), false);
    assert.equal(record.userEntryId, "actual-user-entry");
    reportPreparation(() => { throw new Error("broken view"); }, { stage: "memory", status: "active" });
    const result = { hits: [{ vaultRelativePath: "资料/A.md" }, { vaultRelativePath: "资料/A.md" }, { vaultRelativePath: "资料/B.md" }], total: 1330 };
    assert.deepEqual(mobileSearchNotePaths(result), ["资料/A.md", "资料/B.md"]);
    assert.deepEqual(uniqueNotePaths(["资料\\A.md", "资料/A.md"]), ["资料/A.md"]);
    parent.replaceChildren(); renderMobileSearchResult(parent, result, "en", () => {});
    assert.match(parent.textContent!, /Read 2 relevant notes/u); assert.doesNotMatch(parent.textContent!, /1330/u);
    assert.equal(parent.querySelectorAll("button").length, 2);
  } finally { dom.window.close(); }
  console.log("PASS instant submission: immediate display, stage replacement, note deduplication, retry ownership and accepted-failure boundary");
}

function assertUnifiedPreparationChain(): void {
  const projector = new PiChatUiProjector();
  let view = projector.createEmpty({ piSessionId: "chain-pi", activeLeafId: null, now: 1 });
  const event = (payload: Record<string, unknown>, at = 10) => ({ conversationId: "chain", piSessionId: "chain-pi", productRunId: "chain-run", activeLeafId: null, occurredAt: at, ...payload }) as PiChatRuntimeEvent;
  view.messages.push({ id: "user", role: "user", text: "问题", runId: "chain-run", createdAt: 1 });
  for (const payload of [
    { type: "knowledge_progress", status: "active", stage: "searching" },
    { type: "knowledge_progress", status: "active", stage: "selecting_knowledge" },
    { type: "knowledge_progress", status: "completed", stage: "searching" },
    { type: "knowledge_progress", status: "active", stage: "comparing_memory" },
    { type: "knowledge_progress", status: "completed", stage: "comparing_memory" },
    { type: "memory_recall_progress", status: "active", stage: "loading" },
    { type: "memory_recall_progress", status: "completed", stage: "assembling" }
  ]) view = projector.projectRuntimeEvent({ current: view, event: event(payload) });
  assert.equal(view.messages.some(message => message.itemType === "thinking"), false);
  assert.equal(view.messages[0].id, "user");
  let summary = createReasoningSummary({ conversationId: "chain", piSessionId: "chain-pi", productRunId: "chain-run", startedAt: 1 });
  const stages: PreparationUpdate[] = [];
  const observe = (update: PreparationUpdate) => {
    const index = stages.findIndex(stage => stage.stage === update.stage);
    if (index < 0) stages.push(update); else stages[index] = update;
    const activity = preparationActivity(update);
    if (activity) summary = updateReasoningActivity({ summary, activity });
    view = projector.projectRuntimeEvent({ current: view, event: event({ type: "reasoning_summary", summary }, summary.updatedAt) });
    const turn = buildAgentTurns(view.messages)[0];
    assert.deepEqual(turn.processNodes.map(node => node.nodeId), buildPreparationProcessNodes(stages, "zh-CN").map(node => node.nodeId), "acceptance preserves semantic node count and order");
    return turn;
  };
  observe({ stage: "judgment", status: "active", startedAt: 2, updatedAt: 2 });
  observe({ stage: "judgment", status: "completed", knowledgeDecision: true, skillName: "写作", startedAt: 2, updatedAt: 3 });
  observe({ stage: "knowledge", status: "active", detail: "selecting_knowledge", startedAt: 4, updatedAt: 4 });
  observe({ stage: "knowledge", status: "completed", notePaths: ["A.md", "A.md", "B.md"], startedAt: 4, updatedAt: 5 });
  observe({ stage: "memory", status: "active", startedAt: 6, updatedAt: 6 });
  observe({ stage: "memory", status: "completed", memoriesUsed: 2, startedAt: 6, updatedAt: 7 });
  summary = updateReasoningActivity({ summary, activity: { id: "provider", kind: "provider", status: "active", startedAt: 8, updatedAt: 8 } });
  const waiting = observe({ stage: "thinking", status: "active", readyForModel: true, startedAt: 8, updatedAt: 8 });
  assert.equal(waiting.processNodes.at(-1)?.nodeId, THINKING_NODE_ID);
  assert.equal(shouldShowThinkingLive(waiting), true, "the waiting node does not suppress its own copy");
  view = projector.projectRuntimeEvent({ current: view, event: event({ type: "provider_reasoning_start", messageKey: "assistant", reasoningId: "reasoning-1" }, 9) });
  view = projector.projectRuntimeEvent({ current: view, event: event({ type: "provider_reasoning_delta", messageKey: "assistant", reasoningId: "reasoning-1", textDelta: "先核对笔记" }, 10) });
  const thinking = buildAgentTurns(view.messages)[0];
  assert.equal(thinking.processNodes.filter(node => node.nodeId === THINKING_NODE_ID).length, 1);
  assert.deepEqual(thinking.processNodes.map(node => node.nodeId), waiting.processNodes.map(node => node.nodeId), "public thinking takes over the existing waiting node");
  assert.equal(shouldShowThinkingLive(thinking), false);
  assert.equal(shouldShowThinkingLive({ ...waiting, messages: [...waiting.messages, { id: "tool", role: "tool", itemType: "dynamicToolCall", text: "", status: "running", createdAt: 9 }] }), false);
  assert.equal(shouldShowThinkingLive({ ...waiting, messages: [...waiting.messages, { id: "answer", role: "assistant", text: "答", createdAt: 9 }] }), false);
  for (const status of ["failed", "cancelled", "interrupted"] as const) {
    const closed = closeReasoningSummary({ summary, status, terminalAt: 12 });
    assert.ok(closed.activities.every(activity => activity.status !== "active"));
    assert.equal(shouldShowThinkingLive({ ...waiting, status }), false);
  }
  for (const disabled of ["judgment", "knowledge", "memory"] as const) {
    const remaining = stages.filter(stage => stage.stage !== disabled);
    assert.ok(!buildPreparationProcessNodes(remaining, "zh-CN").some(node => node.nodeId === `process-activity:${disabled === "judgment" ? "preparation:judgment" : disabled === "knowledge" ? "knowledge:retrieval" : "memory:recall"}`));
  }
  assert.deepEqual(buildPreparationProcessNodes([{ stage: "thinking", status: "active", readyForModel: true }], "zh-CN").map(node => node.nodeId), [THINKING_NODE_ID], "a free/no-knowledge/no-memory turn still has its immediate waiting node");
  console.log("PASS unified preparation: selecting cleanup, acceptance identity/order, no judgment/search/memory, public reasoning takeover, first text/tool and terminal copy cleanup");
}
