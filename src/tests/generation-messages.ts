import { PiChatUiProjector, piProjectedEntryMessageId, type PiChatUiViewModel } from "../harness/pi-native/pi-chat-ui-projector";
import { GENERATION_REQUEST_ENTRY, GENERATION_RESULT_ENTRY } from "../generation/request";
import { GENERATION_STAGE_ENTRY } from "../generation/projection";
import type { PiChatRuntimeEvent } from "../harness/pi-native/contracts";
import assert from "node:assert/strict";
import type { ChatMessage } from "../settings/settings";
import { createGenerationRequest } from "../generation/request";
import { renderGenerationResultCard } from "../generation/message-ui";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import { buildAgentTurns } from "../ui/codex-view/agent-turn-process";
import { FakeElement, createTestContext, renderedText } from "./smooth-conversation-ui";

export async function runGenerationMessageTests(): Promise<void> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: new FakeElement("body"), createElement: (tag: string) => new FakeElement(tag), createElementNS: (_namespace: string, tag: string) => new FakeElement(tag), createDocumentFragment: () => new FakeElement("fragment") } });
  try {
  const context = createTestContext();
  const request = createGenerationRequest({ id: "brief", name: "简报", description: "重点", instructions: "PRIVATE_TEMPLATE_SNAPSHOT_NOT_CHAT_BODY", outputKind: "markdown" }, ["projects/Alpha.md"], "outputs");
  const result = { requestId: request.id, outputKind: "markdown" as const, writeState: "verified" as const, path: "outputs/Result.md", characterCount: 1240, readFailures: [] };
  const user: ChatMessage = { id: "gen-user", role: "user", text: "用「简报」生成 · 1 篇资料", generationRequest: request, runId: "gen-run", createdAt: 1 };
  const answer: ChatMessage = { id: "gen-answer", role: "assistant", text: "已生成并核对文件。", generationRequest: request, generationResult: result, runId: "gen-run", status: "completed", createdAt: 2, completedAt: 3 };
  const renderer = new CodexMessageListRenderer();
  (renderer as unknown as { env: unknown }).env = { ...context, messagesEl: new FakeElement("div"), virtualListEl: new FakeElement("div"), sessionId: "generation-message-test", settingsLanguage: "zh-CN", messages: [user, answer], vaultPath: "/test-vault", readRawMessageText: async () => "", onDerivePiConversation: async () => undefined, onScheduleMeasure: () => undefined, onScheduleRunProgress: () => undefined, options: {} };
  const render = (message: ChatMessage) => {
    const host = new FakeElement("div");
    (renderer as unknown as { renderMessage(host: unknown, message: ChatMessage, options: unknown): void }).renderMessage(host, message, { showAgentHeader: false, showAgentFooter: message.role === "assistant" });
    return host;
  };
  let rendered = render(user);
  const disclosure = rendered.findByClass("codex-generation-request")!;
  assert.ok(disclosure); assert.equal(disclosure.open, false);
  assert.match(renderedText(rendered), /projects\/Alpha.md/u); assert.match(renderedText(rendered), /模板：简报/u);
  assert.equal(renderedText(rendered).includes("PRIVATE_TEMPLATE_SNAPSHOT_NOT_CHAT_BODY"), false);
  disclosure.open = true; disclosure.ontoggle?.({ isTrusted: true });
  assert.equal(render(user).findByClass("codex-generation-request")?.open, true, "a transcript redraw preserves the user's expanded source list");
  await rendered.findByClass("codex-generation-source")?.onclick?.({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  await Promise.resolve(); assert.deepEqual(context.openedPaths, ["projects/Alpha.md"]);
  rendered = render(answer);
  assert.ok(rendered.findByClass("codex-generation-result")); assert.equal(rendered.findByClass("codex-answer-save"), null);
  assert.match(renderedText(rendered), /outputs\/Result.md · 1,240 字/u);
  await rendered.findByClass("codex-generation-open")?.onclick?.({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(context.openedPaths, ["projects/Alpha.md", "outputs/Result.md"]);
  const turnHost = new FakeElement("div");
  (renderer as unknown as { renderAssistantTurn(host: unknown, turn: unknown, showAgentHeader: boolean): void }).renderAssistantTurn(turnHost, buildAgentTurns([user, answer])[0], false);
  assert.ok(turnHost.findByClass("codex-generation-result"), "a completed assistant turn keeps the result card outside the work-record fold");
  assert.equal(turnHost.findByClass("codex-answer-save"), null);
  assert.ok(render({ ...answer, generationRequest: undefined, generationResult: undefined }).findByClass("codex-answer-save"), "ordinary answers retain Save as note");
  const failed = render({ ...answer, generationResult: { ...result, writeState: "not_written", path: undefined, error: "尚未写入文件" } });
  assert.equal(failed.findByClass("codex-generation-result"), null); assert.equal(failed.findByClass("codex-answer-save"), null);
  const missing = new FakeElement("div");
  renderGenerationResultCard(missing as never, { app: context.app as never, language: "zh-CN", result: { ...result, path: "outputs/Moved.canvas", outputKind: "canvas", branchCount: 3 } });
  assert.equal(missing.findByClass("codex-generation-open")?.disabled, true); assert.match(renderedText(missing), /文件已不存在或已移动/u); assert.match(renderedText(missing), /3 个分支/u);
  const uncertain = new FakeElement("div"); renderGenerationResultCard(uncertain as never, { app: context.app as never, language: "zh-CN", result: { ...result, writeState: "unconfirmed" } }); assert.match(renderedText(uncertain), /核对文件/u);
  const app = context.app as { vault: { getAbstractFileByPath(path: string): unknown } };
  const lookup = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = () => null;
  await rendered.findByClass("codex-generation-open")?.onclick?.({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  assert.match(renderedText(rendered), /文件已不存在或已移动/u);
  assert.equal(context.openedPaths.length, 2, "deletion after render cannot open another file or silently report success");
  app.vault.getAbstractFileByPath = lookup;
  await assertGenerationNativeGrouping(context, request);
  renderer.dispose();
  console.log("PASS generation messages: expandable frozen sources, private template body, native open, persistent result cards, deleted files, uncertain writes and hidden Save as note");
  } finally { if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete (globalThis as { document?: unknown }).document; }
}

async function assertGenerationNativeGrouping(context: ReturnType<typeof createTestContext>, request: ReturnType<typeof createGenerationRequest>): Promise<void> {
  const runId = "native-generation-group", piSessionId = "native-generation-session";
  const projector = new PiChatUiProjector();
  let projection = projector.createEmpty({ piSessionId });
  projection.productRunId = runId; projection.runState = "running";
  projection.messages = [{ id: piProjectedEntryMessageId(piSessionId, null, "accepted-user"), role: "user", text: "用「简报」生成 · 1 篇资料", generationRequest: request, runId, turnId: runId, createdAt: 1 }];
  let at = 2;
  const apply = (event: Record<string, unknown>) => { projection = projector.projectRuntimeEvent({ current: projection, event: { ...event, productRunId: runId, conversationId: "native-conversation", piSessionId, activeLeafId: null, occurredAt: at++ } as PiChatRuntimeEvent }); };
  // The actual subscription replays preflight phases before the user event.
  // That event replaces/repositions the canonical accepted-user seed.
  apply({ type: "generation_progress", requestId: request.id, stage: "reading", status: "running" });
  apply({ type: "generation_progress", requestId: request.id, stage: "reading", status: "completed" });
  apply({ type: "generation_progress", requestId: request.id, stage: "writing", status: "running" });
  apply({ type: "message_start", messageKey: "real-user-key", role: "user" });
  apply({ type: "message_end", messageKey: "real-user-key", role: "user", text: "用「简报」生成 · 1 篇资料", status: "completed" });
  apply({ type: "generation_progress", requestId: request.id, stage: "approval", status: "running" });
  const approval = projection.messages.find(message => message.id.includes(":tool:generation-"))!;
  const target = JSON.stringify({ relativePath: "outputs/Result.md" });
  const diff = "--- a/outputs/Result.md\n+++ b/outputs/Result.md\n@@ -0,0 +1,2 @@\n+# 实际报告\n+第一行真实正文\n";
  const preview = JSON.stringify({ operation: "note_create", byteLength: 123, change: { added: 2, removed: 0, kind: "add", diff, truncated: false } });
  approval.status = "waiting_approval"; approval.approval = { status: "pending", target, preview }; approval.title = "等待确认 简报";
  const renderer = new CodexMessageListRenderer(); let approved = 0;
  const env = { ...context, messagesEl: new FakeElement("div"), virtualListEl: new FakeElement("div"), sessionId: "generation-native-ui-test", settingsLanguage: "zh-CN", messages: projection.messages, vaultPath: "/test-vault", readRawMessageText: async () => "", onScheduleMeasure: () => undefined, onScheduleRunProgress: () => undefined, options: {}, resolveApprovalDecision: (message: ChatMessage) => message.id === approval.id ? { target, preview, decide: () => { approved++; return true; } } : null };
  (renderer as unknown as { env: unknown }).env = env;
  const rows = (renderer as unknown as { buildVirtualRows(messages: ChatMessage[]): Array<{ kind: string; message?: ChatMessage }> }).buildVirtualRows(projection.messages);
  assert.deepEqual(rows.map(row => row.kind), ["message", "assistantTurn"], "real user-event replay must produce one user row followed by one work-record turn");
  assert.equal(rows[0].message?.role, "user");
  const host = new FakeElement("div");
  for (const row of rows) (renderer as unknown as { renderVirtualRow(host: unknown, row: unknown): void }).renderVirtualRow(host, { ...row, showAgentHeader: false });
  assert.equal(host.findAllByClass("codex-ai-elements-chain-of-thought").length, 1);
  assert.equal(host.findByClass("codex-process"), null, "generation stages must not fall back to empty expanded process cards");
  const text = renderedText(host);
  assert.match(text, /读取资料/u); assert.match(text, /按模板写作/u); assert.match(text, /等你确认写入/u);
  assert.doesNotMatch(text, /暂无内容|正在接收过程内容|调用等待确认/u);
  assert.match(text, /outputs\/Result.md/u); assert.match(text, /第一行真实正文/u);
  assert.doesNotMatch(text, /relativePath|byteLength|"diff"|\\n/u, "generation approval exposes readable file/diff content, not serialized plumbing");
  await host.findByClass("is-approve")?.onclick?.({ isTrusted: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(approved, 1, "the readable card retains the exact live approval callback");
  const genericApproval = new FakeElement("div");
  (renderer as unknown as { renderApprovalCard(host: unknown, message: ChatMessage): void }).renderApprovalCard(genericApproval, { ...approval, id: "ordinary:tool:note-create", title: "普通工具审批" });
  assert.match(renderedText(genericApproval), /relativePath/u, "ordinary tool approval presentation remains unchanged");
  const result = { requestId: request.id, outputKind: "markdown", writeState: "verified", path: "outputs/Result.md", characterCount: 8, readFailures: [] };
  const cold = projector.projectSessionBranch({ piSessionId, activeLeafId: "final-entry", productRunId: runId, runState: "completed", runIdentities: [{ productRunId: runId, userEntryId: "accepted-user", assistantEntryId: "final-entry", toolCallIds: [], updatedAt: 20 }], entries: [
    { type: "message", id: "accepted-user", timestamp: "2026-10-20T00:00:00.000Z", message: { role: "user", content: "用「简报」生成 · 1 篇资料", timestamp: 1 } },
    { type: "custom", id: "request-entry", timestamp: "2026-10-20T00:00:00.001Z", customType: GENERATION_REQUEST_ENTRY, data: { productRunId: runId, request } },
    { type: "message", id: "final-entry", timestamp: "2026-10-20T00:00:00.002Z", message: { role: "assistant", content: [{ type: "text", text: '{"title":"PRIVATE_MODEL_JSON","markdown":"正文"}' }], timestamp: 2, stopReason: "stop" } },
    ...(["reading", "writing", "approval", "saving"] as const).map((stage, index) => ({ type: "custom", id: `stage-${stage}`, timestamp: "2026-10-20T00:00:00.003Z", customType: GENERATION_STAGE_ENTRY, data: { productRunId: runId, requestId: request.id, stage, status: "completed", at: 3 + index } })),
    { type: "custom", id: "result-entry", timestamp: "2026-10-20T00:00:00.004Z", customType: GENERATION_RESULT_ENTRY, data: { productRunId: runId, result } }
  ] as never });
  env.messages = cold.messages;
  const reopenedRows = (renderer as unknown as { buildVirtualRows(messages: ChatMessage[]): Array<{ kind: string; message?: ChatMessage }> }).buildVirtualRows(cold.messages);
  assert.deepEqual(reopenedRows.map(row => row.kind), ["message", "assistantTurn"]);
  const reopened = new FakeElement("div");
  for (const row of reopenedRows) (renderer as unknown as { renderVirtualRow(host: unknown, row: unknown): void }).renderVirtualRow(reopened, { ...row, showAgentHeader: false });
  assert.equal(reopened.findByClass("codex-ai-elements-chain-of-thought")?.open, false, "a reopened completed result uses the ordinary collapsed work record");
  assert.ok(reopened.findByClass("codex-generation-result")); assert.equal(reopened.findByClass("codex-process"), null);
  assert.doesNotMatch(renderedText(reopened), /暂无内容|正在接收过程内容|PRIVATE_MODEL_JSON/u);
  renderer.dispose();
  console.log("PASS generation native grouping: preflight/user replay order, one ordinary work record, no empty details, readable exact approval and live decision");
}
