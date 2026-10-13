import { Scope, type App } from "obsidian";
import { EchoInkViewService } from "../plugin/view-service";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { piProjectedEntryMessageId } from "../harness/pi-native/pi-chat-ui-projector";
import { enqueueComposerDraft, createQueuedTurnFromComposer } from "../ui/codex-view/turn-runner";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ChangeSet } from "@codemirror/state";
import { addSelectionAnnotation, composerSelectionAnnotations, removeSelectionAnnotation, editAnnotationQuestion, snapshotSelectionDraft, restoreSelectionDraft, selectionDraft, clearSelectionDraft } from "../selection-ask/draft";
import { normalizeSelectionAskSettings, visibleCharacters } from "../selection-ask/settings";
import { captureReadingSelection, readingBodyProjection, resolveReadingRange, resolveProjectedReadingRange } from "../selection-ask/reading";
import { attachSourceAnchor, resolveSourceSpan, renderedSpanForSource, mapSelectionSource, mapSourceChangeOnce } from "../selection-ask/anchors";
import { captureEditorSelection } from "../editor-actions/selection-ask";
import { buildPiSelectionAnnotationContextMessage, selectionAnnotationsFromPiContext } from "../harness/pi-native/pi-selection-annotations";
import { createPiKnowledgeInlineExtension } from "../plugin/pi-production-runtime-composition";
import { PiChatUiProjector } from "../harness/pi-native/pi-chat-ui-projector";
import { RuntimeTurnQueue } from "../ui/turn-queue";
import { renderSelectionAnnotationSummary } from "../ui/codex-view/selection-annotations";
import { CodexView } from "../ui/codex-view";
import { DEFAULT_SETTINGS, normalizeSettingsData } from "../settings/settings";
import { addComposerNoteMentionSelection, composerNoteMentionSelections } from "../ui/codex-view/note-mentions";
import { createSession, activateSession, derivePiConversationFromMessage } from "../ui/codex-view/session-controller";
import { prepareDocument } from "./settings-search-dom";
import { renderSelectionAnnotationSettings, renderSelectionAskPluginRow } from "../settings/selection-annotation-settings";
import { disposeOriginControls } from "../settings/origin-controls";
import type { SelectionAnnotation, SelectionCapture } from "../types/selection-annotations";

export function annotationFixture(number = 1): SelectionAnnotation {
  return { id: `annotation-${number}`, number, selectedText: "SELECTED_SNAPSHOT", vaultRelativePath: "notes/source.md", fileName: "source.md", anchor: { mode: "editor", from: 0, to: 17, before: "", after: "" }, appliedActions: [] };
}
const capture = (path = "notes/source.md", from = 0): SelectionCapture => ({ selectedText: "选中文本", vaultRelativePath: path, fileName: path.split("/").at(-1)!, anchor: { mode: "editor", from, to: from + 4, before: "", after: "" } });
export async function runSelectionAnnotationTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
  const win = dom.window as unknown as Window & typeof globalThis;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "HTMLElement", "HTMLFormElement", "HTMLInputElement", "HTMLButtonElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "navigator", "getComputedStyle", "ResizeObserver"]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value: (win as any)[key] ?? win });
  }
  prepareDocument(win);
  Object.assign(win.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  try {
    draftBehavior(win.document);
    sourceAnchors(win.document);
    queueAndProjection();
    await queueOnlyAnnotations(win.document);
    await mergedContext();
    await summaryBehavior(win);
    await adoptedSummaryUsesItsCurrentWindow(win);
    await hoverEscapeDoesNotDismissQuickWindow(win);
    await relayedEscapeKeepsQuickWindowFocus(win);
    await conversationDrafts(win.document);
    await summaryFocusIsNotStolenByViewActivation();
    await settingsBehavior(win);
    console.log("PASS selection-annotations: draft ownership, safe deletion, cross-mode anchors, queue snapshots, Pi context/history, hover and free settings");
  } finally {
    disposeOriginControls(win.document.body);
    dom.window.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}
function draftBehavior(doc: Document): void {
  const input = doc.createElement("textarea"); doc.body.append(input);
  input.value = "手写问题";
  const first = addSelectionAnnotation(input, capture(), { id: "default", template: "" });
  assert.equal(input.value, "手写问题", "empty template adds neither hidden question nor orphan prefix");
  addSelectionAnnotation(input, capture(), { id: "other", template: "解释\n并举例" });
  assert.equal(input.value, "手写问题\n注释1，解释\n并举例");
  addSelectionAnnotation(input, capture(), { id: "other", template: "解释\n并举例" });
  assert.equal(composerSelectionAnnotations(input).length, 1);
  const second = addSelectionAnnotation(input, capture("other.md"), { id: "default", template: "总结" });
  const third = addSelectionAnnotation(input, capture("notes/source.md", 20), { id: "default", template: "总结" });
  removeSelectionAnnotation(input, second.id);
  assert.deepEqual(composerSelectionAnnotations(input).map((value) => value.number), [1, 3]);
  assert.equal(addSelectionAnnotation(input, capture("third.md"), { id: "default", template: "" }).number, 4);
  removeSelectionAnnotation(input, first.id);
  assert.equal(input.value, "手写问题\n注释3，总结");
  input.value += "我修改了问题";
  assert.equal(removeSelectionAnnotation(input, third.id), true);
  assert.equal(input.value, "手写问题\n注释3，总结我修改了问题", "an end-of-line edit preserves the whole owned question");
  clearSelectionDraft(input); input.value = "";
  const newline = addSelectionAnnotation(input, capture(), { id: "default", template: "解释" });
  input.value += "\n另起一行";
  assert.equal(removeSelectionAnnotation(input, newline.id), false);
  assert.equal(input.value, "\n另起一行", "an independent handwritten line is not part of the automatic question");
  clearSelectionDraft(input); input.value = "注释1，用户自己写的";
  const owned = addSelectionAnnotation(input, capture(), { id: "default", template: "解释" });
  input.value = "前面新写\n" + input.value;
  removeSelectionAnnotation(input, owned.id);
  assert.equal(input.value, "前面新写\n注释1，用户自己写的", "matching user prefixes must not gain automatic deletion authority");
  const noQuestion = addSelectionAnnotation(input, capture(), { id: "default", template: "" });
  editAnnotationQuestion(input, noQuestion.id);
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(input.selectionEnd, input.value.length, "new question leaves the caret after its prefix");
  const snapshot = snapshotSelectionDraft(input); const other = doc.createElement("textarea"); other.value = input.value; restoreSelectionDraft(other, snapshot);
  selectionDraft(other).annotations[0].anchor.from = 999;
  assert.notEqual(selectionDraft(input).annotations[0].anchor.from, 999);
}
function sourceAnchors(doc: Document): void {
  const root = doc.createElement("div"); root.innerHTML = "<div class='mod-header mod-ui'>笔记属性添加笔记属性</div><div class='markdown-preview-pusher'>宿主占位</div><p>前文 <strong>重点</strong>，<a href='/link'>链接</a></p><p>后文</p>"; doc.body.append(root);
  const range = doc.createRange(); range.setStart(root.querySelector("strong")!.firstChild!, 0); range.setEnd(root.querySelectorAll("p")[1].firstChild!, 2);
  const selection = doc.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const result = captureReadingSelection(root, selection, "source.md", "source.md")!;
  assert.equal(result.capture.selectedText, "重点，链接后文");
  assert.equal(result.capture.anchor.before.includes("笔记属性"), false);
  assert.equal(readingBodyProjection(root).text.includes("宿主占位"), false);
  const original = root.innerHTML;
  assert.equal(resolveReadingRange(root, result.capture.anchor, result.capture.selectedText)?.toString(), result.capture.selectedText);
  assert.equal(root.innerHTML, original, "capture and restore must not rewrite rendered or source text");
  const markdown = "前文 **重点**，[链接](/link)\n\n后文";
  attachSourceAnchor(markdown, result.capture.anchor, result.capture.selectedText, readingBodyProjection(root).text);
  const span = resolveSourceSpan(markdown, result.capture.anchor)!; assert.ok(span);
  assert.equal(markdown.slice(span.from, span.to), "重点**，[链接](/link)\n\n后文");
  assert.equal(resolveProjectedReadingRange(root, renderedSpanForSource(markdown, result.capture.anchor)!)?.toString(), result.capture.selectedText);
  const changed = "新行\n" + markdown;
  const changes = ChangeSet.of({ from: 0, insert: "新行\n" }, markdown.length);
  const versions = new Map([["source", markdown]]);
  mapSourceChangeOnce(versions, "source", result.capture.anchor, changes, markdown, changed);
  assert.equal(result.capture.anchor.source!.from, span.from + 3);
  mapSourceChangeOnce(versions, "source", result.capture.anchor, changes, markdown, changed);
  assert.equal(result.capture.anchor.source!.from, span.from + 3, "second editor update cannot map the shared anchor twice");
  const altered = changed.replace("重点", "改文"); const replace = ChangeSet.of({ from: span.from + 3, to: span.from + 5, insert: "改文" }, changed.length);
  mapSelectionSource(result.capture.anchor, replace, changed, altered);
  assert.equal(result.capture.anchor.invalid, true);
  assert.equal(result.capture.selectedText, "重点，链接后文", "source changes retain the captured user material");
  const duplicateSource = "A".repeat(160);
  const duplicate = { mode: "editor" as const, from: 70, to: 75, before: "A".repeat(48), after: "A".repeat(48) };
  attachSourceAnchor(duplicateSource, duplicate, "AAAAA");
  assert.equal(resolveSourceSpan(duplicateSource, duplicate), null);
  assert.deepEqual(resolveSourceSpan(duplicateSource, duplicate, true), { from: 70, to: 75 }, "an unchanged known document validates its original exact position");
  const removed = ChangeSet.of({ from: 70, to: 75 }, duplicateSource.length);
  mapSelectionSource(duplicate, removed, duplicateSource, duplicateSource.slice(0, 70) + duplicateSource.slice(75));
  assert.equal(duplicate.invalid, true, "a deleted selection is not retargeted onto an identical surviving passage");
  const repeated = doc.createElement("div"); repeated.textContent = "重复重复";
  assert.equal(resolveReadingRange(repeated, { mode: "reading", from: 0, to: 2, before: "", after: "" }, "重复"), null, "ambiguous positions cannot be guessed");
  const editor: any = { listSelections: () => [{ anchor: { line: 0, ch: 6 }, head: { line: 0, ch: 1 } }], posToOffset: (pos: any) => pos.ch, getValue: () => "abcdefg" };
  const editorCapture = captureEditorSelection(editor, "source.md", "source.md")!;
  assert.equal(editorCapture.selectedText, "bcdef"); assert.equal(editorCapture.anchor.from, 1);
}
function queueAndProjection(): void {
  const annotations = [annotationFixture()]; const queue = new RuntimeTurnQueue();
  const item: any = { id: "q", sessionId: "A", text: "question", attachments: [], skill: null, turnOptions: {}, kind: "chat", createdAt: 1, selectionAnnotations: annotations };
  queue.enqueue(item); annotations[0].selectedText = "changed"; annotations[0].anchor.from = 10;
  assert.equal(queue.peekNext("A")!.selectionAnnotations![0].selectedText, "SELECTED_SNAPSHOT");
  assert.equal(queue.peekNext("A")!.selectionAnnotations![0].anchor.from, 0);
  const snapshot = queue.peekNext("A")!.selectionAnnotations!;
  const context = buildPiSelectionAnnotationContextMessage(snapshot)!;
  assert.deepEqual(selectionAnnotationsFromPiContext(context.customType, context.details), snapshot);
  const entries: any[] = [{ type: "message", id: "user", parentId: null, timestamp: "2026-10-14T00:00:00.000Z", message: { role: "user", content: "question", timestamp: 1 } }, { type: "message", id: "context", parentId: "user", timestamp: "2026-10-14T00:00:01.000Z", message: context }];
  const projection = new PiChatUiProjector().projectSessionBranch({ piSessionId: "p", activeLeafId: "context", entries, runState: "completed", now: 3 });
  assert.deepEqual(projection.messages.find((message) => message.role === "user")!.selectionAnnotations, snapshot);
  assert.equal(projection.messages.some((message) => message.text.includes("SELECTED_SNAPSHOT")), false);
  entries[1] = { ...entries[1], type: "custom_message", ...context, message: undefined };
  const alternate = new PiChatUiProjector().projectSessionBranch({ piSessionId: "p", activeLeafId: "context", entries, runState: "completed", now: 3 });
  assert.deepEqual(alternate.messages.find((message) => message.role === "user")!.selectionAnnotations, snapshot);
}
async function queueOnlyAnnotations(doc: Document): Promise<void> {
  const input = doc.createElement("textarea");
  addSelectionAnnotation(input, capture(), { id: "default", template: "" });
  let workspaceCalls = 0;
  const empty: any = { inputEl: input, attachments: [], selectedSkill: null, ensureSession: () => ({ id: "A" }), currentTurnOptions: () => ({}), plugin: { settings: DEFAULT_SETTINGS }, ensureChatWorkspaceSelected: async () => { workspaceCalls++; return true; } };
  assert.equal(await createQueuedTurnFromComposer(empty, { allowLocalKnowledgeCommands: false }), null);
  assert.equal(workspaceCalls, 0, "reference-only input waits for a question without Provider validation");
  const queue = new RuntimeTurnQueue(); let followUp = 0;
  const session = { id: "A", kind: "chat", bodyAuthority: "pi_session_only", piSessionId: "p" };
  const item: any = { id: "q", sessionId: "A", text: "question", selectionAnnotations: [annotationFixture()], attachments: [], noteMentions: [], skill: null, turnOptions: {}, kind: "chat", createdAt: 1 };
  const view: any = { plugin: { followUpPiConversation: async () => { followUp++; } }, running: true, activeRunKind: "chat", activeRunSessionId: "A", turnQueue: queue, createQueuedTurnFromComposer: async () => item, sessionById: () => session, clearComposerDraft() {}, renderQueue() {}, renderToolbar() {} };
  await enqueueComposerDraft(view); await enqueueComposerDraft(view);
  assert.equal(followUp, 0); assert.equal(queue.itemsForSession("A").length, 1);
  assert.deepEqual(queue.peekNext("A")!.selectionAnnotations, item.selectionAnnotations);
}
async function mergedContext(): Promise<void> {
  for (const kind of [null, "chat", "ask"] as const) for (const memory of [false, true]) {
    const handlers = new Map<string, (...args: any[]) => any>();
    let annotations: SelectionAnnotation[] = [annotationFixture()];
    const extension = createPiKnowledgeInlineExtension({ vaultSecurity: { name: "fixture", factory() {} }, currentTurn: () => kind ? { kind, providerResourceText: "来源：Read.md\n原文：\n# 官方 CLI 实机验收\n", references: [] } as never : null, currentMemoryTurn: () => memory ? { vaultId: "v", conversationId: "c", piSessionId: "p", productRunId: "r", memoryMode: "normal", query: "question" } : null, personalMemory: { async loadFixedContext() { return { revision: 1, agent: "PROFILE", user: null, memory: "MEMORY", injectionKeys: [] } as never; } }, currentSelectionAnnotations: () => annotations, currentSkillTurn: () => ({ skillId: "fixture", content: "SKILL" }), currentNoteMentionTurn: () => ({ noteMentions: [{ vaultRelativePath: "whole.md", fileName: "whole.md", content: "WHOLE_NOTE" }] }) });
    await extension.factory({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
    const before = await handlers.get("before_agent_start")!({ systemPrompt: "system", prompt: "question" });
    assert.equal(before.message.content.split("SELECTED_SNAPSHOT").length - 1, 1, "each merge branch injects one snapshot");
    assert.equal(before.systemPrompt?.includes("SELECTED_SNAPSHOT") ?? false, false, "selection text never becomes a system instruction");
    assert.deepEqual(selectionAnnotationsFromPiContext(before.message.customType, before.message.details), annotations);
    const user = { role: "user", content: [{ type: "text", text: "question" }], timestamp: 1 };
    const hidden = { role: "custom", timestamp: 1, ...before.message };
    const context = await handlers.get("context")!({ messages: [user, hidden] });
    const text = context.messages.map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    assert.equal(text.split("SELECTED_SNAPSHOT").length - 1, 1);
    const partitions = context.messages.filter((message: any) => typeof message.content === "string" && message.content.includes("echoink.turn-material.v1"));
    assert.equal(partitions.length, kind ? 4 : 3);
    const selectionPartition = partitions.find((message: any) => message.customType === "echoink-selection-annotations-v1")!;
    assert.ok(selectionPartition);
    assert.equal(JSON.parse(selectionPartition.content).contextType, "echoink-selection-annotations-v1");
    assert.equal(JSON.parse(selectionPartition.content).content.includes("Read.md"), false);
    assert.equal(context.messages.filter((message: any) => message.role === "user").at(-1), user, "the real user question remains its own user message after all typed background sections");
    const llm = convertToLlm(context.messages);
    const questionIndices = llm.map((message: any, index: number) => message.role === "user" && Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && part.text === "question") ? index : -1).filter((index: number) => index >= 0);
    assert.equal(questionIndices.length, 1);
    const sentMaterials = llm.filter((message: any) => JSON.stringify(message.content).includes("echoink.turn-material.v1"));
    assert.ok(sentMaterials.every((message: any) => message.role === "user"));
    const quoteIndex = llm.findIndex((message: any) => JSON.stringify(message.content).includes("SELECTED_SNAPSHOT"));
    assert.ok(quoteIndex < questionIndices[0]);
    assert.equal(llm.filter((message: any) => JSON.stringify(message.content).includes("SELECTED_SNAPSHOT")).length, 1, "actual Pi LLM conversion keeps one independent selected-passage message");
    assert.ok(context.messages.findIndex((message: any) => typeof message.content === "string" && message.content.includes("SELECTED_SNAPSHOT")) < context.messages.indexOf(user), "quoted background precedes the current question");
    annotations = []; const next = await handlers.get("before_agent_start")!({ systemPrompt: "system", prompt: "next" });
    assert.equal(next.message.content.includes("SELECTED_SNAPSHOT"), false, "new turns do not reinject old annotations");
  }
}
async function summaryBehavior(win: Window & typeof globalThis): Promise<void> {
  const host = win.document.createElement("div"); win.document.body.append(host);
  renderSelectionAnnotationSummary(host, [annotationFixture()], "zh-CN", { onSource() {} });
  const trigger = host.querySelector<HTMLButtonElement>("button")!, wrapper = trigger.parentElement!;
  assert.equal(win.document.querySelector(".echoink-annotation-popover"), null);
  wrapper.dispatchEvent(new win.MouseEvent("mouseenter"));
  const panel = win.document.querySelector<HTMLElement>(".echoink-annotation-popover")!; assert.equal(panel.hidden, false);
  wrapper.dispatchEvent(new win.MouseEvent("mouseleave")); panel.dispatchEvent(new win.MouseEvent("mouseenter"));
  await new Promise((resolve) => win.setTimeout(resolve, 150)); assert.equal(panel.hidden, false, "moving from label to card keeps the panel open");
  wrapper.dispatchEvent(new win.MouseEvent("mouseleave")); await new Promise((resolve) => win.setTimeout(resolve, 150)); assert.equal(panel.hidden, true);
  trigger.focus(); assert.equal(panel.hidden, false);
  trigger.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  const source = panel.querySelector<HTMLButtonElement>("button")!; assert.equal(win.document.activeElement, source);
  source.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(panel.hidden, true); assert.equal(win.document.activeElement, trigger);
  host.remove();
}
async function adoptedSummaryUsesItsCurrentWindow(first: Window & typeof globalThis): Promise<void> {
  const secondDom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const second = secondDom.window;
  const host = first.document.createElement("div"); first.document.body.append(host);
  renderSelectionAnnotationSummary(host, [annotationFixture()], "zh-CN", { onSource() {} });
  const trigger = host.querySelector<HTMLButtonElement>("button")!, wrapper = trigger.parentElement!;
  wrapper.dispatchEvent(new first.MouseEvent("mouseenter")); assert.ok(first.document.querySelector(".echoink-annotation-popover"));
  second.document.body.append(second.document.adoptNode(host));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first.document.querySelector(".echoink-annotation-popover"), null, "adopting the same DOM closes the old-window panel and listeners");
  wrapper.dispatchEvent(new second.MouseEvent("mouseenter"));
  const panel = second.document.querySelector<HTMLElement>(".echoink-annotation-popover")!;
  assert.ok(panel); assert.equal(panel.ownerDocument, second.document);
  trigger.focus(); trigger.dispatchEvent(new second.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  const source = panel.querySelector<HTMLButtonElement>("button")!; assert.equal(second.document.activeElement, source);
  source.dispatchEvent(new second.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(second.document.activeElement, trigger); assert.equal(second.document.querySelector(".echoink-annotation-popover"), null);
  first.document.body.append(first.document.adoptNode(host));
  wrapper.dispatchEvent(new first.MouseEvent("mouseenter")); assert.ok(first.document.querySelector(".echoink-annotation-popover"));
  host.remove(); await Promise.resolve(); secondDom.window.close();
}
async function hoverEscapeDoesNotDismissQuickWindow(win: Window & typeof globalThis): Promise<void> {
  let dismissals = 0;
  const quickWindowListener = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) dismissals++; };
  win.document.addEventListener("keydown", quickWindowListener);
  const input = win.document.createElement("textarea"), host = win.document.createElement("div"); win.document.body.append(input, host); input.focus();
  renderSelectionAnnotationSummary(host, [annotationFixture()], "zh-CN", { onSource() {} });
  const trigger = host.querySelector<HTMLButtonElement>("button")!;
  trigger.parentElement!.dispatchEvent(new win.MouseEvent("mouseenter"));
  assert.equal(win.document.activeElement, input, "hover does not steal Composer focus");
  const escape = new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); input.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(dismissals, 0); assert.equal(win.document.querySelector(".echoink-annotation-popover"), null); assert.equal(win.document.activeElement, trigger);
  input.focus(); input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(dismissals, 1, "the normal quick-window Escape handler is restored after the card closes");
  win.document.removeEventListener("keydown", quickWindowListener); host.remove(); input.remove();
}
async function relayedEscapeKeepsQuickWindowFocus(main: Window & typeof globalThis): Promise<void> {
  const childDom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const child = childDom.window as unknown as Window & typeof globalThis;
  const host = main.document.createElement("div"), mainInput = main.document.createElement("textarea");
  main.document.body.append(host, mainInput);
  let activeWindow: Window = child;
  const originalHasFocus = Object.getOwnPropertyDescriptor(main.document, "hasFocus");
  Object.defineProperty(main.document, "hasFocus", { configurable: true, value: () => activeWindow === main });
  Object.defineProperty(child.document, "hasFocus", { configurable: true, value: () => activeWindow === child });
  const base = new Scope(), stacks = new Map<Window, Scope[]>(), scopeWindows = new WeakMap<Scope, Window>();
  const stack = (owner: Window) => { let value = stacks.get(owner); if (!value) { value = [base]; stacks.set(owner, value); } return value; };
  const app = { scope: base, keymap: {
    pushScope(scope: Scope) { stack(activeWindow).push(scope); scopeWindows.set(scope, activeWindow); },
    // Real popScope uses the window remembered on push, not activeWindow.
    popScope(scope: Scope) { const owner = scopeWindows.get(scope); if (owner) { const values = stack(owner), index = values.indexOf(scope); if (index >= 0) values.splice(index, 1); scopeWindows.delete(scope); } }
  } } as unknown as Pick<App, "keymap" | "scope">;
  let mainActivations = 0, dismissals = 0, lateCaptureEnabled = true;
  const keymap = (event: KeyboardEvent) => {
    const current = stack(activeWindow).at(-1)! as Scope & { dispatch(event: KeyboardEvent): unknown };
    if (current.dispatch(event) === false) { event.preventDefault(); event.stopPropagation(); }
  };
  const workspace = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) mainActivations++; };
  const lateCapture = (event: KeyboardEvent) => { if (lateCaptureEnabled && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } };
  // Native Window AT_TARGET runs listeners in registration order. JSDOM
  // incorrectly puts later capture first, so model this verified order directly.
  const mainListeners = [keymap, workspace, lateCapture];
  const relay = (event: KeyboardEvent) => {
    const clone = new main.KeyboardEvent("keydown", event);
    Object.defineProperties(clone, { isRelayed: { value: true }, target: { get: () => event.target }, currentTarget: { get: () => event.currentTarget } });
    const prevent = clone.preventDefault.bind(clone), stop = clone.stopPropagation.bind(clone);
    clone.preventDefault = () => { prevent(); event.preventDefault(); };
    clone.stopPropagation = () => { stop(); event.stopPropagation(); };
    mainListeners.forEach(listener => listener(clone));
  };
  const quickFallback = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) dismissals++; };
  child.addEventListener("keydown", relay, true); child.document.addEventListener("keydown", quickFallback);
  renderSelectionAnnotationSummary(host, [annotationFixture()], "zh-CN", { onSource() {} }, app);
  child.document.body.append(child.document.adoptNode(host));
  const trigger = host.querySelector<HTMLButtonElement>("button")!, wrapper = trigger.parentElement!;
  const escape = () => { const event = new child.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); trigger.dispatchEvent(event); return event; };
  try {
    assert.equal(escape().defaultPrevented, true); assert.equal(mainActivations, 1, "later capture cancels child Escape after Workspace has already activated main");
    lateCaptureEnabled = false;
    escape(); assert.equal(mainActivations, 2); assert.equal(dismissals, 1, "without a card ordinary Escape remains intact");
    wrapper.dispatchEvent(new child.MouseEvent("mouseenter")); trigger.focus();
    const panel = child.document.querySelector<HTMLElement>(".echoink-annotation-popover")!, source = panel.querySelector<HTMLButtonElement>("button")!;
    assert.equal(stack(child).length, 2);
    trigger.dispatchEvent(new child.KeyboardEvent("keydown", { key: "Tab", bubbles: true })); assert.equal(child.document.activeElement, source);
    activeWindow = main;
    const otherWindowEscape = new main.KeyboardEvent("keydown", { key: "Escape", cancelable: true }); Object.defineProperty(otherWindowEscape, "target", { value: mainInput });
    mainListeners.forEach(listener => listener(otherWindowEscape));
    assert.equal(mainActivations, 3); assert.equal(panel.hidden, false, "main-window Escape does not close a child card");
    activeWindow = child;
    let removals = 0; const remove = panel.remove.bind(panel);
    panel.remove = () => { removals++; source.dispatchEvent(new child.FocusEvent("focusout", { bubbles: true })); remove(); };
    assert.equal(escape().defaultPrevented, true); assert.equal(mainActivations, 3, "Scope consumes Escape in the first listener before Workspace");
    assert.equal(dismissals, 1); assert.equal(child.document.activeElement, trigger); assert.equal(stack(child).length, 1);
    assert.equal(child.document.querySelector(".echoink-annotation-popover"), null); assert.equal(removals, 1);
    escape(); assert.equal(mainActivations, 4); assert.equal(dismissals, 2);
    wrapper.dispatchEvent(new child.MouseEvent("mouseenter")); assert.equal(stack(child).length, 2);
    activeWindow = main; renderSelectionAnnotationSummary(host, [], "zh-CN", { onSource() {} }, app);
    assert.equal(stack(child).length, 1, "rerender after another window activates still pops the owning window's Scope");
    assert.equal(stack(main).length, 1);
    wrapper.dispatchEvent(new child.MouseEvent("mouseenter")); assert.equal(stack(child).length, 1, "background hover never pushes onto the active main window");
    activeWindow = child; child.dispatchEvent(new child.FocusEvent("focus")); assert.equal(stack(child).length, 2);
    main.document.body.append(main.document.adoptNode(host)); await Promise.resolve(); await Promise.resolve();
    assert.equal(stack(child).length, 1, "migration releases the old window Scope");
    assert.equal(child.document.querySelector(".echoink-annotation-popover"), null);
    activeWindow = main; wrapper.dispatchEvent(new main.MouseEvent("mouseenter")); assert.equal(stack(main).length, 2);
    host.remove(); await Promise.resolve(); assert.equal(stack(main).length, 1, "removing the host releases Scope");
  } finally {
    renderSelectionAnnotationSummary(host, [], "zh-CN", { onSource() {} }, app);
    child.removeEventListener("keydown", relay, true); child.document.removeEventListener("keydown", quickFallback);
    host.remove(); mainInput.remove(); childDom.window.close();
    if (originalHasFocus) Object.defineProperty(main.document, "hasFocus", originalHasFocus); else Reflect.deleteProperty(main.document, "hasFocus");
  }
}

function createView(doc: Document, settings: any): any {
  const view: any = new CodexView({} as never, { settings } as never);
  Object.assign(view, { inputEl: doc.createElement("textarea"), attachments: [], selectedSkill: null, renderAttachments() {}, renderQueue() {}, renderTabs() {}, renderMessages() {}, renderToolbar() {}, applyStatus() {}, resetVirtualWindow() {}, updateInputPlaceholder() {}, closeComposerMenus() {}, sessionById: () => null, clearComposerDraft() { this.inputEl.value = ""; clearSelectionDraft(this.inputEl); this.attachments = []; } });
  return view;
}
async function conversationDrafts(doc: Document): Promise<void> {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), activeSessionId: "A", sessions: [{ id: "A", kind: "chat", messages: [], bodyAuthority: "pi_session_only", cwd: "/fixture", title: "A", createdAt: 1, updatedAt: 1 }] };
  const view = createView(doc, settings); view.composerDraftOwner = "A";
  view.inputEl.value = "手写";
  addComposerNoteMentionSelection(view.inputEl, { vaultRelativePath: "whole.md", fileName: "whole.md" });
  const a = addSelectionAnnotation(view.inputEl, capture(), { id: "default", template: "解释" });
  const accepted: any = { sessionId: "A", text: view.inputEl.value, composerTextSnapshot: view.inputEl.value, attachments: [], skill: null, selectionAnnotations: composerSelectionAnnotations(view.inputEl), noteMentions: composerNoteMentionSelections(view.inputEl) };
  view.switchComposerDraft("B"); settings.activeSessionId = "B"; view.inputEl.value = "B手写";
  view.clearAcceptedComposerDraft(accepted);
  assert.equal(view.inputEl.value, "B手写");
  view.switchComposerDraft("A"); settings.activeSessionId = "A";
  assert.equal(view.inputEl.value, ""); assert.equal(composerSelectionAnnotations(view.inputEl).length, 0, "delayed A acceptance consumes the matching hidden draft");
  addSelectionAnnotation(view.inputEl, capture(), { id: "default", template: "解释" });
  const concurrent: any = { ...accepted, text: view.inputEl.value, composerTextSnapshot: view.inputEl.value, noteMentions: [], selectionAnnotations: composerSelectionAnnotations(view.inputEl) };
  view.inputEl.value += " 新增内容";
  view.switchComposerDraft("B"); settings.activeSessionId = "B";
  view.clearAcceptedComposerDraft(concurrent); view.switchComposerDraft("A"); settings.activeSessionId = "A";
  assert.ok(view.inputEl.value.endsWith("新增内容")); assert.equal(composerSelectionAnnotations(view.inputEl).length, 1);
  const migrated = createView(doc, settings); migrated.importMigrationState(view.exportMigrationState());
  assert.equal(migrated.inputEl.value, view.inputEl.value); assert.deepEqual(composerSelectionAnnotations(migrated.inputEl), composerSelectionAnnotations(view.inputEl));
  migrated.switchComposerDraft("B"); assert.equal(migrated.inputEl.value, "B手写", "all session drafts survive window migration");
  migrated.switchComposerDraft("A"); settings.activeSessionId = "A";
  const prior = migrated.inputEl.value;
  migrated.plugin.createPiConversation = async (request: any) => ({ ...request, piSessionId: "failed", status: "active", createdAt: 1, updatedAt: 1 });
  migrated.plugin.getVaultPath = () => "/fixture";
  migrated.plugin.switchPiConversation = async () => { throw new Error("fixture activation failure"); };
  migrated.plugin.setPiConversationStatus = async () => {};
  migrated.plugin.readPiConversationSupport = async () => { throw new Error("unavailable"); };
  migrated.plugin.saveRuntimeSessionShells = async () => {};
  migrated.plugin.saveSettings = async () => {};
  await assert.rejects(createSession(migrated), /fixture activation failure/);
  assert.equal(settings.activeSessionId, "A"); assert.equal(migrated.composerDraftOwner, "A"); assert.equal(migrated.inputEl.value, prior);
  assert.equal(composerSelectionAnnotations(migrated.inputEl).length, 1, "failed new conversation restores annotation and question together");
  const source = settings.sessions.find((session: any) => session.id === "A")!;
  source.messages = [{ id: piProjectedEntryMessageId("p", null, "original-user"), role: "user", text: "original question", selectionAnnotations: [annotationFixture()] }] as never;
  migrated.plugin.derivePiConversation = async () => ({ sourceConversationId: "A", anchorRole: "user", editorText: "original question", projection: { catalog: { conversationId: "D", piSessionId: "derived", status: "active", title: "D", createdAt: 1, updatedAt: 1, cwd: "/fixture", defaultMemoryMode: "normal" }, messages: [], diagnostics: [], drafts: [], activeLeafId: null, runState: "idle" }, activation: { status: "active" } });
  await derivePiConversationFromMessage(migrated, source, "original-user");
  assert.equal(settings.activeSessionId, "D"); assert.equal(migrated.inputEl.value, "original question");
  assert.equal(composerSelectionAnnotations(migrated.inputEl)[0].selectedText, "SELECTED_SNAPSHOT", "editing a user message restores its own snapshot beyond the derived prefix");
  assert.ok(a.id);
}
async function summaryFocusIsNotStolenByViewActivation(): Promise<void> {
  let inputFocusCalls = 0;
  const leaf = { view: Object.create(CodexView.prototype) };
  const service: any = Object.create(EchoInkViewService.prototype);
  service.plugin = { getQuickChatWindowController: () => null, app: { workspace: { getLeavesOfType: () => [leaf], rightSplit: { collapsed: false }, setActiveLeaf() {} } } };
  service.getCodexView = () => ({ focusInput() { inputFocusCalls++; } });
  await service.activateView({ focusInput: false }); assert.equal(inputFocusCalls, 0, "source-number navigation must not schedule a later textarea focus over the summary label");
  await service.activateView(); assert.equal(inputFocusCalls, 1, "ordinary sidebar activation keeps its established input focus");
}
async function settingsBehavior(win: Window & typeof globalThis): Promise<void> {
  assert.equal(visibleCharacters("👨‍👩‍👧‍👦é中文").length, 4);
  const normalized = normalizeSelectionAskSettings({ enabled: false, actions: [{ id: "default", name: "改名", template: "解释" }, { id: "a", name: "第二", template: "" }, { id: "b", name: "第二", template: "" }, { id: "c", name: "第四" }] });
  assert.equal(normalized.actions.length, 3); assert.equal(normalized.actions[0].name, "提问"); assert.equal(normalized.actions[2].name, "选项3");
  assert.deepEqual(normalizeSettingsData({ ...structuredClone(DEFAULT_SETTINGS), selectionAsk: normalized }).settings.selectionAsk, normalized, "settings whitelist retains normalized free actions");
  let fail = true; const saved: any[] = [];
  const plugin: any = { settings: structuredClone(DEFAULT_SETTINGS), async saveSettings() { if (fail) throw new Error("disk failure"); saved.push(structuredClone(this.settings.selectionAsk)); } };
  const host = win.document.createElement("div"); win.document.body.append(host);
  renderSelectionAnnotationSettings(host, plugin, () => {});
  const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button"));
  const find = (text: string) => buttons().find((button) => button.textContent === text)!;
  assert.equal(host.querySelector<HTMLInputElement>("input")!.disabled, true);
  find("新增选项").click();
  const secondName = host.querySelectorAll<HTMLInputElement>("input")[1]; secondName.value = "解释"; secondName.dispatchEvent(new win.InputEvent("input"));
  find("新增选项").click();
  assert.equal(host.querySelectorAll<HTMLInputElement>("input")[2].value, "选项3");
  assert.equal(find("最多3个").disabled, true);
  const input = host.querySelectorAll<HTMLInputElement>("input")[1];
  const validityBeforeComposition = input.getAttribute("aria-invalid");
  input.dispatchEvent(new win.CompositionEvent("compositionstart")); input.value = "正在组字中"; input.dispatchEvent(new win.InputEvent("input", { isComposing: true }));
  assert.equal(input.getAttribute("aria-invalid"), validityBeforeComposition, "IME is not validated mid-composition");
  input.dispatchEvent(new win.CompositionEvent("compositionend")); assert.equal(input.getAttribute("aria-invalid"), "true");
  input.value = "解释"; input.dispatchEvent(new win.InputEvent("input"));
  const template = host.querySelector<HTMLTextAreaElement>("textarea")!; template.value = "请解释"; template.dispatchEvent(new win.Event("input"));
  await (find("保存").onclick as any)(new win.MouseEvent("click")); assert.equal(template.value, "请解释"); assert.match(host.textContent!, /disk failure/);
  assert.equal(plugin.settings.selectionAsk.actions.length, 1, "save failure restores applied settings and retains form content");
  fail = false; await (find("保存").onclick as any)(new win.MouseEvent("click"));
  assert.equal(saved[0].actions.length, 3); assert.equal(saved[0].actions[0].template, "请解释");
  const row = win.document.createElement("div"); win.document.body.append(row); renderSelectionAskPluginRow(row, plugin, true, () => {});
  assert.match(row.textContent!, /基础/); assert.equal(row.textContent!.includes("PRO"), false); assert.equal(row.querySelectorAll("button:disabled").length, 0);
  disposeOriginControls(host); disposeOriginControls(row); host.remove(); row.remove();
}
