import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { EditorState, type Extension, type StateField } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import { history, undo, redo, insertNewline } from "@codemirror/commands";
import { editorInfoField, editorLivePreviewField, mentionTestNotices } from "obsidian";
import { InlineMentionController, findInlineMention, inlineDraftText, inlineMentionKeyAction, mapInlineDraft, type InlineMentionDraft, type InlineDraftSubmission, type InlineMentionHost } from "../inline-agent/mention";
import type { AgentDefinition } from "../agents/types";

const browser = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
Object.assign(globalThis, { window: browser.window, document: browser.window.document,
  MutationObserver: browser.window.MutationObserver, HTMLElement: browser.window.HTMLElement, Node: browser.window.Node,
  getComputedStyle: browser.window.getComputedStyle });
Object.defineProperty(globalThis, "navigator", { value: browser.window.navigator, configurable: true });
browser.window.Range.prototype.getClientRects = () => [] as never;
browser.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

let checks = 0;
const check = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); checks++; console.log(`PASS ${name}`); };
const agents: AgentDefinition[] = [
  { id: "sol", name: "小墨", avatar: { kind: "preset", presetId: "sol" }, position: "总助", styleId: "execution" },
  { id: "nova", name: "小林", avatar: { kind: "default" }, position: "研究", styleId: "analysis" },
  { id: "aya", name: "Alice", avatar: { kind: "default" }, position: "写作", styleId: "creative" }
];
const draft = (document: string, from = document.indexOf("@"), to = document.length): InlineMentionDraft => ({ id: 1, from, to, agentId: "sol", agentName: "小墨", trigger: "@", pending: false });

function fixture(text = "前文 ", options: { send?: InlineMentionHost["send"]; document?: Document; extensions?: Extension[] } = {}) {
  let extension: Extension = [], field: StateField<{ drafts: InlineMentionDraft[]; composing: boolean }>;
  const submissions: InlineDraftSubmission[] = [], cleanups: (() => void)[] = [];
  const host = { plugin: { registerEditorExtension(value: Extension[]) { extension = value; field = value[0] as typeof field; }, register(fn: () => void) { cleanups.push(fn); } },
    agents: () => agents, trigger: () => "@", send: options.send ?? (async input => { submissions.push(input); }) } as unknown as InlineMentionHost;
  const controller = new InlineMentionController(host); controller.register();
  const document = options.document ?? browser.window.document;
  const view = new EditorView({ state: EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [editorInfoField, editorLivePreviewField, history(), extension, ...(options.extensions ?? [])] }), parent: document.body });
  const type = (text: string) => { const selection = view.state.selection.main; view.dispatch({ changes: { from: selection.from, to: selection.to, insert: text }, selection: { anchor: selection.from + text.length }, userEvent: "input.type" }); };
  const key = (key: string, extra: KeyboardEventInit = {}) => { const event = new (document.defaultView!.KeyboardEvent)("keydown", { key, bubbles: true, cancelable: true, ...extra }); view.contentDOM.dispatchEvent(event); return event; };
  const select = () => { type("@"); key("Enter"); };
  const button = () => view.dom.querySelector<HTMLButtonElement>(".echoink-inline-input-send")!;
  const drafts = () => view.state.field(field).drafts;
  const close = () => { controller.dispose(); view.destroy(); };
  return { view, controller, type, key, select, button, submissions, drafts, close };
}

await check("Markdown boundaries exclude addresses, code, links, URL and YAML while allowing prose", () => {
  const blocked = ["email@example", "user.name+tag@", "https://example.com/@", "www.example.com/@", "<https://host/@", "[说明 @", "[[链接@", "![图片@", "[链接](https://host/@", "`code @", "``some ` code @", "```ts\n@", "~~~\n@", "> ```\n> @", "    @", "---\nowner: @", "\\@"];
  for (const text of blocked) assert.equal(findInlineMention(text, text.length, "@"), null, text);
  for (const text of ["@", "正文@", "正文 @小", "`code` @", "[链接](https://host) @", "[[链接]] @", "---\nowner: me\n---\n@", "```\ncode\n```\n@", "\\\\@"])
    assert.ok(findInlineMention(text, text.length, "@"), text);
  assert.deepEqual(findInlineMention("前文 !小", 5, "!"), { from: 3, to: 5, query: "小" });
  assert.equal(findInlineMention("@小\n正文", 6, "@"), null);
});

await check("real CM transactions grow multiline draft and map edits outside without absorbing surrounding prose", () => {
  let state = EditorState.create({ doc: "头\n@小墨 要求\n原文", selection: { anchor: 8 } });
  let current = draft(state.doc.toString(), 2, 8);
  const edit = (from: number, to: number, insert: string, input = false) => { const tr = state.update({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, ...(input ? { userEvent: "input.type" } : {}) }); const mapped = mapInlineDraft(current, tr); assert.ok(mapped); current = mapped; state = tr.state; };
  edit(8, 8, "\n继续", true);
  assert.equal(inlineDraftText(state.doc.toString(), current), "要求\n继续");
  edit(0, 0, "前置");
  assert.equal(inlineDraftText(state.doc.toString(), current), "要求\n继续");
  edit(state.doc.length, state.doc.length, "外部新文");
  assert.equal(inlineDraftText(state.doc.toString(), current), "要求\n继续");
  state = state.update({ selection: { anchor: 0 } }).state;
  edit(current.to, current.to, "边界外文字");
  assert.equal(inlineDraftText(state.doc.toString(), current), "要求\n继续");
});

await check("CM change sets invalidate damaged mention and preserve exact command before suffix", () => {
  const text = "正文 @小墨 要求 后缀", initial = draft(text, 3, 9), state = EditorState.create({ doc: text });
  const tr = state.update({ changes: [{ from: 0, insert: "新" }, { from: 8, to: 9, insert: "新要求" }] });
  const mapped = mapInlineDraft(initial, tr)!;
  assert.equal(inlineDraftText(tr.newDoc.toString(), mapped), "要新要求");
  const broken = state.update({ changes: { from: 4, to: 5, insert: "林" } });
  assert.equal(mapInlineDraft(initial, broken), null);
  assert.equal(broken.newDoc.toString(), "正文 @林墨 要求 后缀");
});

await check("IME, keyCode 229 and modified Enter are never claimed by picker", () => {
  const event = { key: "Enter", isComposing: false, keyCode: 13, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(inlineMentionKeyAction(event, false), "select");
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) assert.equal(inlineMentionKeyAction({ ...event, ...extra }, false), null);
  assert.equal(inlineMentionKeyAction(event, true), null);
  assert.equal(inlineMentionKeyAction({ ...event, key: "ArrowDown" }, false), "next");
  assert.equal(inlineMentionKeyAction({ ...event, key: "Escape" }, false), "close");
});

await check("typing @ immediately shows real roster; prefix, arrows, Enter and Escape use native CM", () => {
  const f = fixture();
  f.type("@");
  assert.ok(f.view.state.facet(showTooltip)[0]);
  const popup = () => f.view.state.facet(showTooltip)[0]!.create(f.view).dom;
  assert.deepEqual([...popup().querySelectorAll('[role="option"]')].map(node => node.textContent), ["小墨", "小小林", "AAlice"]);
  f.type("小"); assert.equal(popup().querySelectorAll('[role="option"]').length, 2);
  f.key("ArrowDown"); assert.equal(popup().querySelector('[aria-selected="true"]')?.textContent, "小小林");
  assert.ok(f.key("Enter").defaultPrevented);
  assert.equal(f.view.state.doc.toString(), "前文 @小林 ");
  assert.equal(f.submissions.length, 0);
  assert.equal(f.view.dom.querySelector(".echoink-inline-input-name")?.textContent, "小林");
  assert.equal(f.view.dom.querySelectorAll('[contenteditable="true"]').length, 1);
  f.type("要求");
  f.view.dispatch({ selection: { anchor: 0 } }); f.type("@");
  assert.ok(f.view.state.facet(showTooltip)[0]); f.key("Escape");
  assert.equal(f.view.state.facet(showTooltip).filter(Boolean).length, 0); f.close();
});

await check("Enter after selection naturally extends draft; send receives full current note and exact multiline requirement", async () => {
  const f = fixture("前文 后缀");
  f.view.dispatch({ selection: { anchor: 3 } }); f.select(); f.type("第一行");
  assert.ok(insertNewline(f.view)); f.type("第二行");
  f.view.dispatch({ changes: { from: 0, insert: "新增前文" } });
  const current = f.drafts()[0], document = f.view.state.doc.toString();
  assert.equal(document.slice(current.from, current.to), "@小墨 第一行\n第二行");
  assert.equal(document.slice(current.to), "后缀");
  f.button().click(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.submissions, [{ path: "合成正文.md", agentId: "sol", from: current.from, to: current.to, document, text: "第一行\n第二行", trigger: "@" }]);
  assert.equal(f.drafts().length, 0); assert.equal(f.view.state.doc.toString(), document); f.close();
});

await check("pending suppresses duplicate send and failure preserves editable draft", async () => {
  let calls = 0, reject!: (error: Error) => void;
  const f = fixture("", { send: async () => { calls++; await new Promise<void>((_resolve, fail) => { reject = fail; }); } });
  f.select(); f.type("要求"); f.button().click(); f.button().click();
  assert.equal(calls, 1); assert.equal(f.button().disabled, true);
  reject(new Error("合成失败")); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.drafts().length, 1); assert.equal(f.button().disabled, false);
  assert.equal(f.view.state.doc.toString(), "@小墨 要求");
  assert.equal(mentionTestNotices.at(-1), "合成失败");
  f.type("补充"); assert.equal(inlineDraftText(f.view.state.doc.toString(), f.drafts()[0]), "要求补充"); f.close();
});

await check("selecting a name and whitespace-only requirement cannot dispatch", () => {
  const f = fixture(""); f.select();
  assert.equal(f.button().disabled, true); f.button().click();
  f.type(" \t\n"); assert.equal(f.button().disabled, true); f.button().click();
  assert.equal(f.submissions.length, 0);
  f.type("有要求"); assert.equal(f.button().disabled, false); f.close();
});

await check("composition closes picker, does not swallow Enter, and refuses mouse send", () => {
  const f = fixture(""); f.type("@");
  const event = new browser.window.CompositionEvent("compositionstart", { bubbles: true }); f.view.contentDOM.dispatchEvent(event);
  assert.equal(f.key("Enter", { isComposing: true }).defaultPrevented, false);
  assert.equal(f.drafts().length, 0);
  f.view.contentDOM.dispatchEvent(new browser.window.CompositionEvent("compositionend", { bubbles: true }));
  f.close();
  const g = fixture(""); g.select(); g.type("要求");
  const before = g.button();
  g.view.contentDOM.dispatchEvent(new browser.window.CompositionEvent("compositionstart", { bubbles: true }));
  before.click(); g.button().click();
  assert.equal(g.submissions.length, 0);
  g.view.contentDOM.dispatchEvent(new browser.window.CompositionEvent("compositionend", { bubbles: true })); g.close();
});

await check("IME keydown is ignored even before compositionstart reaches draft state", () => {
  const f = fixture(""); f.type("@");
  assert.equal(f.key("Enter", { isComposing: true }).defaultPrevented, false);
  assert.equal(f.drafts().length, 0);
  assert.equal(f.key("ArrowDown", { isComposing: true }).defaultPrevented, false);
  f.close();
});

await check("damaged names become ordinary text; undo and redo remain native and never dispatch", () => {
  const f = fixture(""); f.select(); f.type("要求");
  assert.ok(undo(f.view)); assert.ok(redo(f.view)); assert.equal(f.submissions.length, 0);
  const from = f.drafts()[0]?.from ?? f.view.state.doc.toString().indexOf("@");
  f.view.dispatch({ changes: { from: from + 1, to: from + 2, insert: "林" }, userEvent: "input.type" });
  assert.equal(f.drafts().length, 0); assert.equal(f.button(), null);
  assert.ok(f.view.state.doc.toString().includes("@林墨")); f.close();
});

await check("blur and save-like transactions never send; existing ordinary mentions do not activate", () => {
  const f = fixture("旧文 @小墨 要求");
  assert.equal(f.drafts().length, 0); assert.equal(f.view.state.facet(showTooltip).filter(Boolean).length, 0);
  f.type(" 新文 "); f.select(); f.type("新要求");
  f.view.contentDOM.dispatchEvent(new browser.window.FocusEvent("blur")); f.view.dispatch({});
  assert.equal(f.submissions.length, 0); assert.equal(f.drafts().length, 1); f.close();
});

await check("widgets and candidate DOM belong to editor's own window", () => {
  const other = browser.window.document.implementation.createHTMLDocument("另一个窗口");
  // A separate document with the same owning window is enough to catch accidental global document use.
  Object.defineProperty(other, "defaultView", { value: browser.window });
  const f = fixture("", { document: other });
  f.type("@"); const popup = f.view.state.facet(showTooltip)[0]!.create(f.view).dom;
  assert.equal(popup.ownerDocument, other); f.key("Enter");
  assert.equal(f.button().ownerDocument, other);
  assert.equal(f.view.dom.querySelector("img")!.ownerDocument, other);
  assert.equal(f.button().querySelector("svg")?.getAttribute("data-icon"), "arrow-up"); f.close();
});

await check("source mode and readonly editors stay inactive; dispose removes all decorations", () => {
  for (const extensions of [[editorLivePreviewField.init(() => false)], [EditorView.editable.of(false)]]) {
    const f = fixture("", { extensions }); f.type("@"); assert.equal(f.view.state.facet(showTooltip).filter(Boolean).length, 0); f.close();
  }
  const f = fixture(""); f.select(); assert.ok(f.button()); f.controller.dispose(); assert.equal(f.button(), null); f.close();
});

browser.window.close();
console.log(`${checks} inline mention checks passed`);
