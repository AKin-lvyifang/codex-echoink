import assert from "node:assert/strict";
import { TFile, TFolder, openTestNoticeMessages } from "./obsidian-shim";
import type { ChatMessage } from "../settings/settings";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { PI_ANSWER_SAVE_ENTRY_TYPE } from "../harness/pi-native/pi-answer-save";
import { CodexMessageListRenderer } from "../ui/codex-view/message-list";
import CodexForObsidianPlugin from "../main";
import type { withPiAnswerSaveUiFixture } from "./pi-native/pi-native-conversation-runtime";
import { createTestContext, FakeElement, renderedText } from "./smooth-conversation-ui";

const click = { isTrusted: true, preventDefault() {}, stopPropagation() {} };

export async function runAnswerSaveStateUiTests(
  fixture: Parameters<Parameters<typeof withPiAnswerSaveUiFixture>[0]>[0]
): Promise<void> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: new FakeElement("body"), createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createDocumentFragment: () => {
      const fragment = new FakeElement("fragment");
      const append = fragment.append.bind(fragment);
      fragment.append = (...nodes: unknown[]) => nodes.forEach(node =>
        typeof node === "string" ? fragment.appendText(node) : append(node));
      return fragment;
    }
  } });
  try {
    const context = createTestContext();
    const bindings = emptyKnowledgeFolderBindings();
    Object.assign(bindings.roles.outputs, { enabled: true, readPaths: ["outputs"], writePath: "outputs" });
    const files = new Map<string, TFile | TFolder>([["outputs", Object.assign(new TFolder(), { path: "outputs" })]]);
    let creates = 0;
    Object.assign(context.app.vault, {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => { const folder = Object.assign(new TFolder(), { path }); files.set(path, folder); return folder; },
      create: async (path: string) => { creates++; const file = new TFile(path); files.set(path, file); return file; }
    });
    const bind = (message: ChatMessage, onAnswerSaved?: (messageId: string, path: string) => Promise<void>) => {
      const renderer = new CodexMessageListRenderer();
      renderer.render = () => undefined;
      (renderer as unknown as { env: unknown }).env = {
        ...context, messagesEl: new FakeElement("div"), virtualListEl: new FakeElement("div"),
        sessionId: "saved-answer-ui", settingsLanguage: "zh-CN", messages: [
          { id: "question", role: "user", text: "这篇资料的重点？", createdAt: 1 }, message
        ], vaultPath: "/test-vault", knowledgeFolderBindings: bindings,
        readRawMessageText: async () => "", onAnswerSaved, options: {}
      };
      const host = new FakeElement("div");
      (renderer as unknown as { renderAnswerSaveAction(host: unknown, message: ChatMessage): void })
        .renderAnswerSaveAction(host, message);
      return { renderer, button: host.findByClass("codex-answer-save")! };
    };
    const projector = new PiChatUiProjector();
    const entries = [
      { type: "message", id: "answer", parentId: null, timestamp: "2026-10-20T00:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "重点" }], stopReason: "stop" } }
    ];
    const old = projector.projectSessionBranch({ piSessionId: "saved-session", activeLeafId: "answer", entries }).messages[0];
    const savedPath = "outputs/摘录/这篇资料的重点.md";
    let receipts = 0;
    const initial = bind(old, async (messageId, path) => {
      receipts++; assert.equal(messageId, old.id); assert.equal(path, "outputs/摘录/这篇资料的重点.md");
    });
    assert.equal(initial.button.getAttribute("title"), "存为笔记");
    const saving = initial.button.onclick!(click);
    assert.equal(initial.button.disabled, true);
    await initial.button.onclick!(click);
    await saving;
    assert.equal(creates, 1); assert.equal(receipts, 1);
    assert.equal(initial.button.getAttribute("title"), "已存为笔记，点击打开");
    initial.renderer.dispose();

    const reopened = projector.projectSessionBranch({ piSessionId: "saved-session", activeLeafId: "receipt", entries: [
      ...entries, { type: "custom", id: "receipt", parentId: "answer", timestamp: "2026-10-20T00:00:01Z",
        customType: PI_ANSWER_SAVE_ENTRY_TYPE,
        data: { schemaVersion: 1, piSessionId: "saved-session", assistantEntryId: "answer", path: savedPath } }
    ] }).messages[0];
    const cold = bind(reopened, async () => { throw new Error("open must not write another receipt"); });
    assert.equal(cold.button.getAttribute("title"), "已存为笔记，点击打开");
    await cold.button.onclick!(click);
    assert.deepEqual(context.openedPaths, [savedPath]);
    assert.equal(creates, 1, "a fresh renderer opens the original note without a second save");
    files.delete(reopened.savedNotePath!);
    await cold.button.onclick!(click);
    assert.equal(creates, 1, "a moved or deleted note never triggers a replacement save");
    assert.match(openTestNoticeMessages.at(-1)!, /不存在或已移动/u);
    cold.renderer.dispose();

    const failed = bind({ ...old, id: "legacy-answer", savedNotePath: undefined }, async () => { throw new Error("disk full"); });
    await failed.button.onclick!(click);
    assert.equal(failed.button.getAttribute("title"), "已存为笔记，点击打开");
    const failureNotice = openTestNoticeMessages.at(-1) as unknown as FakeElement;
    assert.match(renderedText(failureNotice), /保存状态未能写入对话.*disk full/u);
    const beforeOpen = creates;
    await failed.button.onclick!(click);
    assert.equal(creates, beforeOpen, "receipt failure retains the created note and does not retry saving");
    assert.equal(context.openedPaths.length, 2);
    failed.renderer.dispose();
    const plugin = Object.assign(Object.create(CodexForObsidianPlugin.prototype), {
      piRuntimeBundle: null, piLocalData: fixture.localData,
      piConversationActivationLane: Promise.resolve(), settings: { sessions: [] }
    }) as CodexForObsidianPlugin;
    const real = bind(fixture.message, (messageId, path) =>
      plugin.recordPiAnswerSave(fixture.conversationId, messageId, path));
    const createdBefore = creates;
    await real.button.onclick!(click);
    assert.equal(creates, createdBefore + 1);
    const realColdMessage = (await fixture.readCold()).messages.find(message => message.text === fixture.message.text)!;
    assert.ok(realColdMessage.savedNotePath, "the actual UI callback must reach the Provider-free plugin facade and durable Session");
    const realCold = bind(realColdMessage);
    await realCold.button.onclick!(click);
    assert.equal(creates, createdBefore + 1);
    assert.equal(context.openedPaths.at(-1), realColdMessage.savedNotePath);
    real.renderer.dispose(); realCold.renderer.dispose();
    console.log("PASS answer-save UI: old records, pending duplicate clicks, cold restore/open, missing notes and receipt-write failure");
    console.log("PASS answer-save UI: real click -> Provider-free plugin callback -> Session JSONL -> fresh projection and renderer -> same note");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
}
