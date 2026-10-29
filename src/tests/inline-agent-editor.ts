import { installObsidianDom } from "./obsidian-dom";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse, type Rule } from "postcss";
import { JSDOM } from "jsdom";
import { EditorState, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, MarkdownView, TFile } from "obsidian";
import { InlineAgentController, inlineDisplayRange } from "../inline-agent/controller";
import { anchorAt, markerFor } from "../inline-agent/document";
import type { InlineRequest, InlineRequestStatus } from "../inline-agent/types";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
installObsidianDom(dom.window);
for (const key of ["window", "document", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MutationObserver", "navigator", "Event", "getComputedStyle"]) Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
dom.window.Range.prototype.getClientRects = () => [] as never;
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;
const create = function(this: HTMLElement, tag: string, options: any = {}) { const element = this.ownerDocument.createElement(tag); if (options.cls) element.className = options.cls; if (options.text !== undefined) element.textContent = options.text; for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value)); this.append(element); return element; };
Object.assign(dom.window.Element.prototype, { createEl: create, createDiv(options: unknown) { return create.call(this, "div", options); }, createSpan(options: unknown) { return create.call(this, "span", options); }, addClass(...tokens: string[]) { this.classList.add(...tokens); }, empty() { this.replaceChildren(); } });
const id = "editor-r1", marker = markerFor(id), command = `@小墨 改写这段 ${marker}`;
const agent = { id: "sol", name: "小墨", avatar: { kind: "preset", presetId: "sol" } };
let checks = 0;
const check = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); checks++; console.log(`PASS ${name}`); };

function record(text: string, status: InlineRequestStatus = "pending", original = "原文第一行\n原文第二行", draft = "新稿"): InlineRequest {
  const from = text.indexOf(command), targetFrom = text.indexOf(original), targetTo = targetFrom + original.length;
  const target = { ...anchorAt(text, { from: targetFrom, to: targetTo }), kind: "replace" as const };
  return { id, vaultId: "synthetic", path: "合成正文.md", taskId: "task-1", agentId: "sol", agentName: "小墨", status,
    instruction: { ...anchorAt(text, { from, to: from + command.length }), trigger: "@", marker }, target, observedDocument: text, currentVersionId: "v1",
    versions: [{ id: "v1", number: 1, text: draft, requirement: "改写这段", sourceDocument: text, context: { text, segments: [] }, target, createdAt: 1 }], followups: [], createdAt: 1, updatedAt: 1 };
}
function controllerFor(requests: InlineRequest[]) {
  const controller = Object.create(InlineAgentController.prototype) as any, opened: string[] = [];
  Object.assign(controller, { plugin: { app: {}, settings: { agentRegistry: { agents: [agent] } } }, service: { list: () => structuredClone(requests), get: (id: string) => requests.find(request => request.id === id), comparingOriginal: new Set(), compare() {}, async confirm() {}, async revoke() {} }, async openTask(id: string) { opened.push(id); }, refresh() {}, report(error: unknown) { throw error; }, disposed: false });
  return { controller, opened };
}
function editor(text: string, requests: InlineRequest[], legacy = false) {
  const { controller, opened } = controllerFor(requests);
  class Card extends WidgetType { toDOM() { const element = document.createElement("section"); element.className = "legacy-card"; element.textContent = "新稿"; return element; } }
  const field = StateField.define({ create: state => legacy ? Decoration.set([
    Decoration.replace({ inclusive: false }).range(requests[0].instruction.from, requests[0].instruction.to),
    Decoration.replace({ widget: new Card(), block: true, inclusive: false }).range(requests[0].target.from, requests[0].target.to)
  ], true) : controller.decorations(state), update: (_value, tr) => controller.decorations(tr.state), provide: field => EditorView.decorations.from(field) });
  const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [editorInfoField, editorLivePreviewField, field] }), parent: document.body });
  return { view, controller, opened, lines: () => [...view.contentDOM.querySelectorAll(".cm-line")].map(line => line.textContent ?? ""), close: () => view.destroy() };
}

await check("actual CM block DOM removes synthetic target/control lines and only the owned whitespace gap", () => {
  const text = `前文\n\n原文第一行\n原文第二行\n\n${command}\n\n后文`, request = record(text);
  const before = editor(text, [request], true), after = editor(text, [request]);
  assert.ok(before.lines().filter(line => !line).length > after.lines().filter(line => !line).length);
  // The block itself carries its following line break, so it needs no empty text line after it.
  assert.deepEqual(after.lines(), ["前文", "", "后文"]);
  assert.equal(after.view.contentDOM.querySelectorAll(".echoink-inline-block").length, 1);
  assert.equal(after.view.state.doc.toString(), text); assert.equal(before.view.state.doc.toString(), text);
  before.close(); after.close();
});

await check("full-line display expansion preserves inline prefix/suffix and all ordinary paragraph gaps", () => {
  const text = `前文 原文第一行\n原文第二行 后缀\n\n保留段落\n\n\n${command}\n尾段`, request = record(text), state = EditorState.create({ doc: text });
  const display = inlineDisplayRange(state, request.target);
  assert.equal(display.from, request.target.from); assert.equal(display.to, request.target.to);
  const f = editor(text, [request]);
  assert.ok(f.lines().some(line => line.includes("前文 "))); assert.ok(f.lines().some(line => line.includes(" 后缀")));
  assert.ok(f.lines().includes("保留段落")); assert.ok(f.lines().includes("尾段"));
  assert.equal(f.lines().filter(line => !line).length, 3);
  assert.equal(f.view.state.doc.toString(), text); f.close();
});

await check("a multi-paragraph block covers every original line and heading; compare renders the whole source and disables confirm", () => {
  const original = `  原文首段：${"保留完整内容。".repeat(240)}  \n\n\n## 范围内标题\n\n\t原文末段：尾部也必须保留。  `;
  const draft = "多段新稿\n\n## 整理后的标题\n\n整理后的末段。";
  const text = `前文\n\n${original}\n\n${command}\n\n后文`, request = record(text, "pending", original, draft), f = editor(text, [request]);
  let confirms = 0;
  f.controller.service.compare = (requestId: string) => {
    const comparing = f.controller.service.comparingOriginal;
    if (comparing.has(requestId)) comparing.delete(requestId); else comparing.add(requestId);
  };
  f.controller.service.confirm = async () => { confirms++; };
  const button = (label: string) => [...f.view.contentDOM.querySelectorAll<HTMLButtonElement>(".echoink-inline-block button")].find(element => element.textContent === label)!;
  try {
    assert.deepEqual(f.lines(), ["前文", "", "后文"], "the complete selected range, internal heading and owned control gap must be replaced by one block");
    assert.equal(f.view.contentDOM.querySelectorAll(".echoink-inline-block").length, 1);
    assert.equal(f.view.contentDOM.querySelector(".echoink-inline-body")?.textContent, draft);
    button("对比").click(); f.view.dispatch({});
    assert.ok(f.controller.service.comparingOriginal.has(id));
    assert.equal(f.view.contentDOM.querySelector(".echoink-inline-body")?.textContent, original, "comparison must preserve the full multi-paragraph source, including whitespace at both ends");
    assert.ok(original.length > 1600); assert.equal(button("确认").disabled, true); button("确认").click(); assert.equal(confirms, 0);
    assert.deepEqual(f.lines(), ["前文", "", "后文"]); assert.equal(f.view.state.doc.toString(), text);
    button("看新稿").click(); f.view.dispatch({}); assert.equal(button("确认").disabled, false);
    assert.equal(f.view.contentDOM.querySelector(".echoink-inline-body")?.textContent, draft); assert.equal(f.view.state.doc.toString(), text);
  } finally { f.close(); }
});

await check("queued request keeps one status followed by a native keyboard-accessible full instruction button", async () => {
  const text = `原文第一行\n原文第二行\n\n${command}`, f = editor(text, [record(text, "queued")]);
  const root = f.view.contentDOM.querySelector(".echoink-inline-request-state")!, instruction = root.querySelector<HTMLButtonElement>(".echoink-inline-sent-instruction")!;
  assert.equal(root.children.length, 2); assert.ok(root.firstElementChild?.textContent?.includes("等待前一块处理") || root.firstElementChild?.textContent?.includes("等前一块处理"));
  assert.equal(instruction.tagName, "BUTTON"); assert.equal(instruction.tabIndex, 0); assert.equal(instruction.textContent, "@小墨 改写这段");
  assert.equal(instruction.querySelector(".echoink-inline-sent-name")?.textContent, "小墨");
  assert.ok(instruction.querySelector(".echoink-inline-sent-avatar img")); instruction.focus(); assert.equal(document.activeElement, instruction);
  instruction.click(); await Promise.resolve(); assert.deepEqual(f.opened, ["task-1"]);
  assert.equal(f.view.state.doc.toString(), text); f.close();
});

await check("duplicated known markers show an explicit invalid state at both copies without choosing a target", () => {
  const original = `原文第一行\n原文第二行\n${command}`, request = record(original), text = `${original}\n${command}`;
  const f = editor(text, [request]);
  assert.equal(f.view.contentDOM.querySelector(".echoink-inline-block"), null);
  assert.equal(f.view.contentDOM.querySelectorAll(".echoink-inline-missing").length, 2);
  for (const warning of f.view.contentDOM.querySelectorAll(".echoink-inline-missing")) assert.equal(warning.textContent, "正文编号重复，位置已失效");
  assert.equal(f.view.state.doc.toString(), text); f.close();
});

await check("damaged known instructions keep edited prose visible and identify the missing anchor", () => {
  const original = `原文第一行\n原文第二行\n${command}`, request = record(original), text = original.replace("改写这段", "用户修改后的要求");
  request.status = "missing"; request.error = "指令不完整，位置已失效。";
  const f = editor(text, [request]);
  assert.ok(f.view.contentDOM.textContent?.includes("用户修改后的要求")); assert.ok(f.view.contentDOM.textContent?.includes(request.error));
  assert.equal(f.view.state.doc.toString(), text); f.close();
});

function leafFor(text: string) {
  const cm = new EditorView({ state: EditorState.create({ doc: text }), parent: document.body });
  const markdown = Object.assign(new MarkdownView(), { containerEl: document.body, file: new TFile("合成正文.md"), editor: { cm, offsetToPos: (offset: number) => ({ line: 0, ch: offset }), setCursor() {}, scrollIntoView() {}, focus() {} }, getMode: () => "source", getState: () => ({ source: false }), async save() {} });
  return { leaf: { view: markdown }, cm, markdown };
}
function splitController(first: ReturnType<typeof leafFor>, second: ReturnType<typeof leafFor>, requests: InlineRequest[] = []) {
  const { controller } = controllerFor(requests);
  let revealed: unknown;
  controller.plugin.app = { vault: { getAbstractFileByPath: () => new TFile("合成正文.md") }, workspace: { containerEl: document.body, activeEditor: { editor: second.markdown.editor }, getLeavesOfType: () => [first.leaf, second.leaf], async revealLeaf(leaf: unknown) { revealed = leaf; } } };
  return { controller, revealed: () => revealed };
}

await check("same-note split selection prefers its active editor and source jumps reveal that same leaf", async () => {
  const text = `原文第一行\n原文第二行\n${command}`, first = leafFor(text), second = leafFor(text), request = record(text), f = splitController(first, second, [request]);
  assert.equal((await f.controller.sourceEditor("合成正文.md")).cm, second.cm);
  await f.controller.openSource(id); assert.equal(f.revealed(), second.leaf);
  const port = await f.controller.editor("合成正文.md"); port.apply([{ from: 0, to: 0, insert: "本次修改" }], "user", id);
  assert.equal(second.cm.state.doc.toString(), `本次修改${text}`); assert.equal(first.cm.state.doc.toString(), text);
  // An unchanged sibling may still be waiting for Obsidian's own save broadcast.
  assert.equal(port.read(), `本次修改${text}`); await port.save();
  first.cm.destroy(); second.cm.destroy();
});

await check("different unsaved split documents are rejected without synchronizing or changing either input", async () => {
  const first = leafFor("甲分栏未保存"), second = leafFor("乙分栏未保存"), f = splitController(first, second);
  await assert.rejects(f.controller.editor("合成正文.md"), /不同分栏中的内容不一致/u);
  assert.equal(first.cm.state.doc.toString(), "甲分栏未保存"); assert.equal(second.cm.state.doc.toString(), "乙分栏未保存");
  first.cm.destroy(); second.cm.destroy();
});

await check("a new sibling edit after acquiring a port blocks apply and a later edit blocks save", async () => {
  const first = leafFor("相同正文"), second = leafFor("相同正文"), f = splitController(first, second), port = await f.controller.editor("合成正文.md");
  first.cm.dispatch({ changes: { from: 0, insert: "用户新增" } });
  assert.throws(() => port.apply([{ from: 0, to: 0, insert: "不应写入" }], "user", id), /不同分栏/u);
  assert.equal(second.cm.state.doc.toString(), "相同正文");
  first.cm.dispatch({ changes: { from: 0, to: first.cm.state.doc.length, insert: "相同正文" } });
  port.apply([{ from: 0, to: 0, insert: "自己的修改" }], "user", id);
  first.cm.dispatch({ changes: { from: 0, insert: "另一次用户新增" } });
  await assert.rejects(port.save(), /不同分栏/u);
  assert.equal(first.cm.state.doc.toString(), "另一次用户新增相同正文"); assert.equal(second.cm.state.doc.toString(), "自己的修改相同正文");
  first.cm.destroy(); second.cm.destroy();
});

await check("openFile may resolve before mounting; the port waits and captures the next-frame CM", async () => {
  const initial = leafFor("初始化正文"), leaves: unknown[] = [], { controller } = controllerFor([]);
  initial.cm.dom.remove(); let opened = 0, mounted!: EditorView;
  const leaf = Object.assign(initial.leaf, { async openFile() {
    leaves.push(leaf);
    dom.window.requestAnimationFrame(() => {
      mounted = new EditorView({ state: EditorState.create({ doc: "初始化正文" }), parent: document.body });
      initial.markdown.editor.cm = mounted;
    });
  } });
  controller.plugin.app = { vault: { getAbstractFileByPath: () => new TFile("合成正文.md") }, workspace: { containerEl: document.body, getLeavesOfType: () => leaves, getLeaf() { opened++; return leaf; } } };
  const port = await controller.editor("合成正文.md");
  assert.equal(opened, 1); assert.equal(mounted.dom.isConnected, true); assert.equal(port.read(), "初始化正文");
  port.apply([{ from: 0, to: 0, insert: "当前CM：" }], "user", id);
  assert.equal(mounted.state.doc.toString(), "当前CM：初始化正文"); assert.equal(initial.cm.state.doc.toString(), "初始化正文");
  initial.cm.destroy(); mounted.destroy();
});

await check("an existing pending leaf is awaited without opening another tab", async () => {
  const initial = leafFor("待挂载正文"), { controller } = controllerFor([]);
  initial.cm.dom.remove(); let mounted!: EditorView;
  controller.plugin.app = { vault: { getAbstractFileByPath: () => new TFile("合成正文.md") }, workspace: { containerEl: document.body, activeEditor: { editor: initial.markdown.editor }, getLeavesOfType: () => [initial.leaf], getLeaf() { assert.fail("must not create a second tab"); } } };
  dom.window.requestAnimationFrame(() => {
    mounted = new EditorView({ state: EditorState.create({ doc: "待挂载正文" }), parent: document.body });
    initial.markdown.editor.cm = mounted;
  });
  const port = await controller.editor("合成正文.md"); assert.equal(port.read(), "待挂载正文");
  // Once returned, even a still-mounted old CM cannot be used after Obsidian replaces it.
  initial.markdown.editor.cm = initial.cm;
  assert.throws(() => port.read(), /来源编辑器已变化/u);
  initial.cm.destroy(); mounted.destroy();
});

await check("changing the initializing leaf to another file refuses the port without editing either file", async () => {
  const initial = leafFor("原文件输入"), { controller } = controllerFor([]);
  initial.cm.dom.remove();
  controller.plugin.app = { vault: { getAbstractFileByPath: () => new TFile("合成正文.md") }, workspace: { containerEl: document.body, getLeavesOfType: () => [initial.leaf] } };
  dom.window.requestAnimationFrame(() => { initial.markdown.file = new TFile("另一篇.md"); });
  await assert.rejects(controller.editor("合成正文.md"), /来源编辑器已变化/u);
  assert.equal(initial.cm.state.doc.toString(), "原文件输入"); initial.cm.destroy();
});

await check("a leaf that never mounts fails within a bounded wait and leaves source untouched", async () => {
  const initial = leafFor("尚未挂载的原文"), { controller } = controllerFor([]);
  initial.cm.dom.remove();
  controller.plugin.app = { vault: { getAbstractFileByPath: () => new TFile("合成正文.md") }, workspace: { containerEl: document.body, getLeavesOfType: () => [initial.leaf], getLeaf() { assert.fail("must not create a second tab"); } } };
  const start = Date.now();
  await assert.rejects(controller.editor("合成正文.md"), /来源编辑器仍在初始化，请稍后重试；正文未改动/u);
  assert.ok(Date.now() - start < 3500); assert.equal(initial.cm.state.doc.toString(), "尚未挂载的原文"); initial.cm.destroy();
});

await check("all six existing main palettes reach inline blocks, gray drafts and plain status labels", async () => {
  const main = parse(await readFile("styles.css", "utf8")), paletteRules: Rule[] = [], localRules: Rule[] = [];
  main.walkRules(rule => { if (rule.nodes.some(node => node.type === "decl" && /^(?:--echoink-theme-|--echoink-control-)/u.test(node.prop))) paletteRules.push(rule); });
  for (const file of ["inline-agent.css", "inline-agent-input.css", "inline-agent-tasks.css"]) parse(await readFile(`src/styles/${file}`, "utf8")).walkRules(rule => { localRules.push(rule); });
  for (const rule of localRules) for (const node of rule.nodes) if (node.type === "decl") assert.equal(/^(?:--echoink-theme-|--echoink-control-)/u.test(node.prop), false, "inline styles must consume main tokens without defining another palette");
  const fixture = document.createElement("div"), cm = fixture.createDiv({ cls: "cm-editor" }), reference = fixture.createDiv({ cls: "echoink-agent-tasks" }); document.body.append(fixture);
  const classes = ["echoink-inline-block", "echoink-inline-request-state", "echoink-inline-input", "echoink-inline-input-start", "echoink-inline-input-end"];
  const elements = classes.map(cls => cm.createDiv({ cls }));
  const state = elements[1].createEl("button", { cls: "echoink-inline-state-label" }), sent = elements[1].createEl("button", { cls: "echoink-inline-sent-instruction" });
  const tokens = (element: Element): Record<string, string> => {
    const result: Record<string, string> = { "--text-normal": "host-text", "--text-muted": "host-muted", "--background-primary": "host-bg", "--background-secondary": "host-raised", "--text-warning": "host-warning" };
    const ancestors: Element[] = []; for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
    for (const ancestor of ancestors) for (const rule of paletteRules) if (ancestor.matches(rule.selector)) for (const node of rule.nodes) if (node.type === "decl" && node.prop.startsWith("--")) result[node.prop] = node.value;
    return result;
  };
  const resolve = (value: string, variables: Record<string, string>, depth = 0): string => {
    assert.ok(depth < 20, "CSS token references must not cycle");
    const start = value.indexOf("var("); if (start < 0) return value;
    let end = start + 4, nested = 1;
    for (; end < value.length && nested; end++) { if (value[end] === "(") nested++; else if (value[end] === ")") nested--; }
    const expression = value.slice(start + 4, end - 1), separator = expression.indexOf(","), name = (separator < 0 ? expression : expression.slice(0, separator)).trim();
    const replacement = variables[name] ?? (separator < 0 ? `unresolved:${name}` : expression.slice(separator + 1).trim());
    return resolve(value.slice(0, start) + replacement + value.slice(end), variables, depth + 1);
  };
  const local = (element: Element, property: string): string => {
    const variables = tokens(element); let value = "";
    for (const rule of localRules) if (!rule.selector.includes("::") && element.matches(rule.selector)) for (const node of rule.nodes) if (node.type === "decl") {
      if (node.prop.startsWith("--")) variables[node.prop] = node.value;
      if (node.prop === property) value = node.value;
    }
    return resolve(value, variables);
  };
  const before = document.body.className, theme = document.body.dataset.echoinkTheme;
  try {
    for (const dark of [false, true]) for (const palette of ["minimal", "highlighter", "manifesto"]) {
      document.body.classList.toggle("theme-dark", dark); document.body.dataset.echoinkTheme = palette;
      const expected = tokens(reference); assert.ok(expected["--echoink-theme-raised"]);
      for (const element of elements) {
        const actual = tokens(element);
        for (const key of ["--echoink-theme-text", "--echoink-theme-raised", "--echoink-theme-secondary", "--echoink-theme-hover"]) assert.equal(actual[key], expected[key], `${palette}/${dark}/${element.className}/${key}`);
      }
      for (const element of [elements[0], ...elements.slice(2), sent]) { assert.equal(local(element, "background"), expected["--echoink-theme-raised"]); assert.equal(local(element, "color"), expected["--echoink-theme-text"]); }
      assert.equal(local(state, "background"), "transparent"); assert.equal(local(state, "color"), expected["--echoink-theme-secondary"]);
      state.classList.add("is-waiting"); assert.equal(local(state, "color"), expected["--echoink-theme-warn"] ?? "host-warning"); state.classList.remove("is-waiting");
    }
  } finally { document.body.className = before; if (theme === undefined) delete document.body.dataset.echoinkTheme; else document.body.dataset.echoinkTheme = theme; fixture.remove(); }
});

dom.window.close(); console.log(`${checks} inline editor checks passed`);
