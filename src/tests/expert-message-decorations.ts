import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { AgentDefinition } from "../agents/types";
import type { ChatMessage, StoredSession } from "../settings/settings";
import { renderExpertConversationDecorations } from "../ui/codex-view/expert-decorations";
import { mobileExpertEvents } from "../ui/mobile/expert-ui";
import { renderMessages, type CodexMessageHost } from "../ui/codex-view/message-controller";
import { CodexMessageListRenderer, type MessageListRenderedRow } from "../ui/codex-view/message-list";
import { installObsidianDom } from "./obsidian-dom";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import type { PiChatRuntimeEvent } from "../harness/pi-native/contracts";
import { Component } from "obsidian";

const workspaceResultDetails = { source: "echoink-workspace", toolCallId: "workspace-call", status: "completed", path: "EchoInk/工作区/demo.html", previewPath: "EchoInk/工作区/demo.html", contentRevision: `sha256:${"a".repeat(64)}`, truncated: false };
function projectWorkspaceResult(details: unknown = workspaceResultDetails, toolName = "workspace_create", isError = false): ChatMessage[] {
  return new PiChatUiProjector().projectSessionBranch({ piSessionId: "fixture-session", activeLeafId: "answer-entry", productRunId: "run", entries: [
    { type: "message", id: "user-entry", parentId: null, timestamp: new Date(100).toISOString(), message: { role: "user", content: "制作一个 Demo", timestamp: 100 } },
    { type: "message", id: "tool-entry", parentId: "user-entry", timestamp: new Date(150).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "workspace-call", name: toolName, arguments: { path: workspaceResultDetails.path, content: "PRIVATE_HTML_BODY_SENTINEL" } }], timestamp: 150 } },
    { type: "message", id: "result-entry", parentId: "tool-entry", timestamp: new Date(200).toISOString(), message: { role: "toolResult", toolCallId: "workspace-call", toolName, details,
      content: [{ type: "text", text: JSON.stringify({ ...workspaceResultDetails, content: "PRIVATE_HTML_BODY_SENTINEL", secret: "PRIVATE_SECRET_SENTINEL" }) }], isError, timestamp: 200 } },
    { type: "message", id: "answer-entry", parentId: "result-entry", timestamp: new Date(300).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop", timestamp: 300 } }
  ] }).messages;
}

function assertWorkspaceProjectionBoundary(): void {
  for (const [tool, title] of [["workspace_create", "新建工作区文件"], ["workspace_read", "读取工作区"], ["workspace_update", "修改工作区文件"]]) {
    const messages = projectWorkspaceResult({ ...workspaceResultDetails, content: "PRIVATE_HTML_BODY_SENTINEL", token: "PRIVATE_SECRET_SENTINEL" }, tool);
    const projected = messages.find(message => message.role === "tool")!;
    assert.equal(projected.title, title);
    assert.deepEqual(projected.workspaceArtifact, { source: "echoink-workspace", path: workspaceResultDetails.path, previewPath: workspaceResultDetails.previewPath });
    assert.equal(JSON.stringify(messages).includes("PRIVATE_HTML_BODY_SENTINEL"), false);
    assert.equal(JSON.stringify(messages).includes("PRIVATE_SECRET_SENTINEL"), false);
    assert.equal(projected.processInput, undefined);
  }
  for (const details of [
    { ...workspaceResultDetails, source: "untrusted" }, { ...workspaceResultDetails, status: "failed" },
    { ...workspaceResultDetails, path: "../private.html", previewPath: "../private.html" },
    { ...workspaceResultDetails, path: "outside.html", previewPath: "outside.html" },
    { ...workspaceResultDetails, path: "/tmp/demo.html", previewPath: "/tmp/demo.html" },
    { ...workspaceResultDetails, path: "EchoInk/工作区/.obsidian/demo.html", previewPath: "EchoInk/工作区/.obsidian/demo.html" },
    { ...workspaceResultDetails, previewPath: "EchoInk/工作区/other.html" },
    { ...workspaceResultDetails, toolCallId: "other-call" }, { ...workspaceResultDetails, truncated: true }
  ]) assert.equal(projectWorkspaceResult(details).find(message => message.role === "tool")!.workspaceArtifact, undefined);
  assert.equal(projectWorkspaceResult(workspaceResultDetails, "workspace_create", true).find(message => message.role === "tool")!.workspaceArtifact, undefined);
  assert.equal(projectWorkspaceResult(workspaceResultDetails, "untrusted_tool").find(message => message.role === "tool")!.workspaceArtifact, undefined);

  const projector = new PiChatUiProjector();
  let current = projector.createEmpty({ piSessionId: "runtime-session" });
  const apply = (fields: Record<string, unknown>) => { current = projector.projectRuntimeEvent({ current, event: { ...fields, conversationId: "conversation", piSessionId: "runtime-session", productRunId: "run", activeLeafId: null, occurredAt: 200 } as PiChatRuntimeEvent }); };
  apply({ type: "tool_execution_start", toolCallId: "workspace-call", toolName: "workspace_create", args: { content: "PRIVATE_HTML_BODY_SENTINEL" }, privacySafe: true });
  apply({ type: "tool_execution_end", toolCallId: "workspace-call", toolName: "workspace_create", isError: false, privacySafe: true,
    result: { content: [{ type: "text", text: "PRIVATE_SECRET_SENTINEL" }], details: workspaceResultDetails } });
  assert.equal(current.messages.find(message => message.role === "tool")!.workspaceArtifact?.previewPath, workspaceResultDetails.previewPath);
  assert.equal(JSON.stringify(current.messages).includes("PRIVATE_SECRET_SENTINEL"), false);
  apply({ type: "tool_execution_end", toolCallId: "workspace-call", toolName: "workspace_create", isError: true, privacySafe: true, result: { details: workspaceResultDetails } });
  assert.equal(current.messages.find(message => message.role === "tool")!.workspaceArtifact, undefined, "a failed replacement must clear an older successful preview action");
}

export async function runExpertMessageDecorationsTests(): Promise<void> {
  assertWorkspaceProjectionBoundary();
  const dom = new JSDOM("<!doctype html><body></body>");
  const win = dom.window, document = win.document;
  const previous = Object.fromEntries(["window", "document", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, { window: { configurable: true, value: win }, document: { configurable: true, value: document }, HTMLElement: { configurable: true, value: win.HTMLElement } });
  installObsidianDom(win); installComposerMenuDomHelpers(document);
  Object.assign(win.HTMLElement.prototype, {
    empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    appendText(this: HTMLElement, text: string) { this.append(text); },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); }
  });
  const frames: FrameRequestCallback[] = [];
  win.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  win.cancelAnimationFrame = () => {};
  const observers: Array<{ targets: Element[]; callback(): void; disconnected: boolean }> = [];
  class ResizeObserverFixture {
    targets: Element[] = []; disconnected = false;
    constructor(readonly callback: () => void) { observers.push(this); }
    observe(target: Element) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  Object.assign(win, { ResizeObserver: ResizeObserverFixture });
  const flushFrames = () => { for (let count = 0; frames.length && count < 40; count++) frames.shift()!(0); assert.equal(frames.length, 0); };
  const messagesEl = document.createElement("div"), virtualListEl = document.createElement("div");
  messagesEl.append(virtualListEl); document.body.append(messagesEl);
  let width = 400;
  Object.defineProperties(messagesEl, { clientHeight: { get: () => 200 }, clientWidth: { get: () => width }, scrollHeight: { get: () => parseInt(virtualListEl.style.height, 10) || 0 } });
  Object.defineProperty(virtualListEl, "scrollHeight", { get: () => parseInt(virtualListEl.style.height, 10) || 0 });
  let measuredDecoratedRows = 0;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    const height = this.classList.contains("codex-virtual-row") ? 70 + this.querySelectorAll(".echoink-expert-event").length * 20 : 200;
    if (this.classList.contains("codex-virtual-row") && this.querySelector(".echoink-expert-event")) measuredDecoratedRows++;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() { return {}; } };
  };
  const agent: AgentDefinition = { id: "expert-fixture", kind: "expert", name: "测试专家", position: "产品", styleId: "execution", avatar: { kind: "builtin", id: "sol" } as never,
    expert: { expertId: "fixture", hired: true, packageVersion: "1", summary: "Public", disclosureShown: true, events: [{ id: "disclosure", at: 150, conversationId: "conversation" }, { id: "rehired", at: 250, conversationId: "conversation" }] } };
  const defaultDesktopOpening = "我以测试专家的视角和你聊，基于公开著作推断。";
  const defaultMobileOpening = "我以测试专家的视角和你聊，依据公开著作与资料推断。";
  const customOpening = "我以自己的视角聊：<img src=x onerror=alert(1)> **原样** & 𠮷";
  const invalidOpenings: unknown[] = [undefined, "", " \n\t　 ", "😀".repeat(81), 123, null, false, { text: "开场" }, ["开场"]];
  const publicEvents = JSON.stringify(agent.expert!.events);
  for (const disclosure of [customOpening, ...invalidOpenings]) {
    const mobile = { ...agent, expert: { ...agent.expert!, disclosure } } as unknown as AgentDefinition;
    const events = mobileExpertEvents(mobile, "conversation");
    assert.equal(events.length, 2); assert.equal(events[0].text, disclosure === customOpening ? customOpening : defaultMobileOpening);
    assert.deepEqual(mobileExpertEvents(mobile, "conversation"), events, "mobile redraw is stable without adding lifecycle events");
    assert.deepEqual(mobileExpertEvents(mobile, "other-conversation"), []);
    assert.equal(JSON.stringify(mobile.expert!.events), publicEvents);
  }
  const messages = projectWorkspaceResult();
  const toolMessageId = messages.find(message => message.role === "tool")!.id;
  const session = { id: "conversation", title: "Fixture", messages, createdAt: 100, updatedAt: 310 } as StoredSession;
  const renderer = new CodexMessageListRenderer();
  // Keep the real row projection, virtualization, resize and measurement path;
  // only the unrelated message body markup is replaced with a closed fold.
  const internals = renderer as unknown as { renderVirtualRow(element: HTMLElement, row: { message?: ChatMessage; turn?: { messages?: ChatMessage[]; processMessages?: ChatMessage[]; finalAnswer?: ChatMessage } }): void };
  internals.renderVirtualRow = (element, row) => {
    const fold = document.createElement("details"); fold.className = "codex-ai-elements-chain-of-thought"; fold.open = false; element.append(fold);
    const content = row.message ? [row.message] : row.turn?.messages ?? [...row.turn?.processMessages ?? [], ...(row.turn?.finalAnswer ? [row.turn.finalAnswer] : [])];
    for (const message of content) { const node = document.createElement("div"); node.dataset.messageId = message.id; fold.append(node); }
  };
  const opened: string[] = [];
  let calls = 0;
  const host = {
    app: {}, plugin: { settings: { settingsLanguage: "zh-CN", knowledgeBase: { folderBindings: null } }, getEchoInkAgentIdentityView: () => undefined, getVaultPath: () => "/fixture" },
    messagesEl, virtualListEl, messageListRenderer: renderer, messagesBottomFollowPaused: true, running: false,
    ensureSession: () => session, renderTaskPlanDock() {}, renderInteractionDock() {},
    scheduleMeasureVirtualRows() {}, scheduleKnowledgeBaseRunProgress() {},
    renderExpertDecorations(current: StoredSession, root: HTMLElement, rows: readonly MessageListRenderedRow[]) {
      calls++; renderExpertConversationDecorations(root, agent, current.id, current.messages, async path => { opened.push(path); }, rows);
    }
  } as unknown as CodexMessageHost;
  let expectedOpening = defaultDesktopOpening;
  const assertDecorations = () => {
    const events = [...virtualListEl.querySelectorAll<HTMLElement>(".echoink-expert-event")];
    assert.equal(events.length, 2);
    assert.equal(events[0].textContent, expectedOpening); assert.equal(events[0].childElementCount, 0, "the opening remains plain text rather than rendered HTML or Markdown");
    assert.match(events[1].textContent ?? "", /重新聘请/u);
    assert.equal(JSON.stringify(agent.expert!.events), publicEvents, "rendering never mutates or duplicates lifecycle events");
    for (const event of events) { assert(event.parentElement?.classList.contains("codex-virtual-row")); assert.equal(event.closest("details"), null); }
    assert.equal(virtualListEl.querySelectorAll(".echoink-workspace-preview-action").length, 1);
  };
  try {
    renderMessages(host, { preserveScroll: true }); assertDecorations();
    assert(measuredDecoratedRows > 0, "public events must already exist when their virtual row is measured");
    const beforeMeasureRerender = calls; flushFrames(); assert(calls > beforeMeasureRerender); assertDecorations();
    for (const disclosure of invalidOpenings) {
      Object.assign(agent.expert!, { disclosure });
      renderExpertConversationDecorations(virtualListEl, agent, session.id, messages, async () => {});
      assertDecorations();
    }
    agent.expert!.disclosure = customOpening; expectedOpening = customOpening;
    renderMessages(host, { preserveScroll: true }); flushFrames(); assertDecorations();
    renderExpertConversationDecorations(virtualListEl, agent, session.id, messages, async () => {}); assertDecorations();
    const firstButton = virtualListEl.querySelector<HTMLButtonElement>(".echoink-workspace-preview-action")!;
    firstButton.click(); await Promise.resolve(); assert.deepEqual(opened, ["EchoInk/工作区/demo.html"]);
    const viewportObserver = observers.find(observer => observer.targets.includes(messagesEl))!;
    width = 500; const beforeResize = calls; viewportObserver.callback(); flushFrames();
    assert(calls > beforeResize); assertDecorations();
    assert.notEqual(virtualListEl.querySelector(".echoink-workspace-preview-action"), firstButton, "resize reconstructed the rows and their preview action");
    renderer.resetVirtualWindow(); renderMessages(host, { preserveScroll: true }); flushFrames(); assertDecorations();

    // A tool/reasoning item can be absent from the folded DOM but still belongs
    // to its real projected row; metadata keeps the declaration visible there.
    const rows = [...virtualListEl.querySelectorAll<HTMLElement>(".codex-virtual-row")].map(element => ({ element, messageIds: [...element.querySelectorAll<HTMLElement>("[data-message-id]")].map(node => node.dataset.messageId!) }));
    [...virtualListEl.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => node.dataset.messageId === toolMessageId)?.remove();
    renderExpertConversationDecorations(virtualListEl, agent, session.id, messages, async () => {}, rows);
    assert.equal(virtualListEl.querySelectorAll(".echoink-expert-event").length, 2);

    const lateMessages: ChatMessage[] = Array.from({ length: 50 }, (_, index) => ({ id: `late-${index}`, role: "user", text: `Later ${index}`, createdAt: 1_000 + index }));
    session.messages = [...messages, ...lateMessages]; messagesEl.scrollTop = 3_500;
    renderMessages(host, { preserveScroll: true }); flushFrames();
    assert.equal([...virtualListEl.querySelectorAll<HTMLElement>("[data-message-id]")].some(node => node.dataset.messageId === toolMessageId), false);
    assert.equal(virtualListEl.querySelectorAll(".echoink-expert-event").length, 0, "an offscreen old event must not be appended at the visible conversation end");
    assert([...virtualListEl.children].every(row => row.classList.contains("codex-virtual-row")));
    messagesEl.scrollTop = 0; renderer.resetVirtualWindow();
    renderMessages(host, { preserveScroll: true }); flushFrames(); assertDecorations();

    // This pass uses the unmodified body renderer as well as the real Pi
    // projection and decorations: the public artifact must reach the actual
    // dynamicToolCall card, without exposing its private result body.
    renderer.dispose(); frames.length = 0; virtualListEl.replaceChildren(); messagesEl.scrollTop = 0;
    const actualRenderer = new CodexMessageListRenderer();
    const component = new Component();
    try {
      actualRenderer.render({ app: { vault: { adapter: { getBasePath: () => "/fixture" }, getAbstractFileByPath: () => null }, metadataCache: { getFirstLinkpathDest: () => null } } as never,
        component, messagesEl, virtualListEl, sessionId: "actual-workspace-card", settingsLanguage: "zh-CN", messages,
        vaultPath: "/fixture", readRawMessageText: async () => "", onScheduleMeasure() {}, onScheduleRunProgress() {},
        onAfterRenderRows(root, rows) { renderExpertConversationDecorations(root, undefined, "conversation", messages, async path => { opened.push(path); }, rows); }, options: { preserveScroll: true } });
      flushFrames();
      const preview = virtualListEl.querySelector<HTMLButtonElement>(".echoink-workspace-preview-action");
      assert(preview, "the actual projected dynamicToolCall card has a preview action");
      assert.match(virtualListEl.textContent ?? "", /新建工作区文件/u);
      assert.doesNotMatch(virtualListEl.textContent ?? "", /PRIVATE_HTML_BODY_SENTINEL|PRIVATE_SECRET_SENTINEL/u);
      preview.click(); await Promise.resolve(); assert.equal(opened.at(-1), workspaceResultDetails.previewPath);
    } finally { actualRenderer.dispose(); component.unload(); }
    console.log("expert message decorations: custom plain-text openings, separate desktop/mobile defaults and invalid fallbacks; real Pi projection, private-body isolation, measurement/redraw, resize, reopen, scroll-away/return and preview action passed");
  } finally {
    renderer.dispose(); dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
