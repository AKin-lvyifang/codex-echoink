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
  renderer.dispose();
  console.log("PASS generation messages: expandable frozen sources, private template body, native open, persistent result cards, deleted files, uncertain writes and hidden Save as note");
  } finally { if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete (globalThis as { document?: unknown }).document; }
}
