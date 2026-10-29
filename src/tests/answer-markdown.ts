import { installObsidianDom } from "./obsidian-dom";
import assert from "node:assert/strict";
import { Component, MarkdownRenderer, TFile, type App } from "obsidian";
import { normalizeMarkdownMath } from "../core/markdown-math";
import { splitVaultNoteLinkSegments } from "../core/vault-note-links";
import { AnswerMarkdownRenderer, prepareAnswerMarkdown } from "../ui/answer-markdown";
import { preserveTextSelectionDuringMutation } from "../ui/codex-view/message-list";

export async function runAnswerMarkdownTests(): Promise<void> {
  const math = String.raw`行内 \( a^2+b^2 \)，行间 \[\sum_{i=1}^n i\]；花了 $5 和 $10。`;
  assert.equal(normalizeMarkdownMath(math), "行内 $a^2+b^2$，行间 \n$$\n\\sum_{i=1}^n i\n$$\n；花了 $5 和 $10。");
  for (const example of ["`\\(code\\)`", "``code ` \\[x\\]``", "```tex\n\\(code\\)\n```", "~~~~\n\\[code\\]\n~~~\n~~~~", "```\n\\(unfinished\\)"]) {
    assert.equal(normalizeMarkdownMath(example), example, "code delimiters and unclosed fences stay literal");
  }
  assert.equal(normalizeMarkdownMath(String.raw`\\(escaped\\)`), String.raw`\\(escaped\\)`);
  assert.equal(normalizeMarkdownMath("`code\n\\(math\\)`"), "`code\n\\(math\\)`");
  assert.equal(normalizeMarkdownMath("``x` \\(y\\)"), "``x` $y$", "an unmatched code opener does not swallow later math");

  const file = new TFile("wiki/公式笔记.md");
  const sources: string[] = [];
  const app = {
    vault: { adapter: { getBasePath: () => "/test-vault" }, getAbstractFileByPath: (path: string) => path === file.path ? file : null },
    metadataCache: { getFirstLinkpathDest: (path: string, source: string) => { sources.push(source); return /^(?:公式笔记|\.\/公式笔记)(?:\.md)?$/u.test(path) && source === "wiki/会话.md" ? file : null; } }
  } as unknown as App;
  for (const input of ["wiki/公式笔记.md", "/test-vault/wiki/公式笔记.md", "[wiki/公式笔记.md]", "`wiki/公式笔记.md`", "[[公式笔记]]"]) {
    assert.equal(prepareAnswerMarkdown(app, input, "wiki/会话.md"), "[[wiki/公式笔记.md]]");
  }
  assert.equal(prepareAnswerMarkdown(app, "[[公式笔记#计算|别名]]", "wiki/会话.md"), "[[wiki/公式笔记.md#计算]]");
  assert.equal(prepareAnswerMarkdown(app, "[结果](./公式笔记.md#计算)", "wiki/会话.md"), "[[wiki/公式笔记.md#计算]]");
  assert.equal(prepareAnswerMarkdown(app, "[wiki/公式笔记.md](https://example.com)", ""), "[wiki/公式笔记.md](https://example.com)");
  assert.equal(prepareAnswerMarkdown(app, "![图](wiki/公式笔记.md)", ""), "![图](wiki/公式笔记.md)");
  assert.equal(prepareAnswerMarkdown(app, "```\nwiki/公式笔记.md\n```", ""), "```\nwiki/公式笔记.md\n```");
  assert.equal(prepareAnswerMarkdown(app, "`run wiki/公式笔记.md`", ""), "`run wiki/公式笔记.md`");
  assert.equal(prepareAnswerMarkdown(app, "missing.md", ""), "missing.md");
  const table = prepareAnswerMarkdown(app, "| 笔记 | 保存路径 |\n| --- | --- |\n| wiki/公式笔记.md | `wiki/公式笔记.md` |", "");
  assert.match(table, /\| \[\[wiki\/公式笔记.md\]\] \| ` wiki\/公式笔记.md ` \|/u);
  assert.ok(sources.includes("wiki/会话.md"), "native link lookup receives the real source context");
  assert.equal(splitVaultNoteLinkSegments("[[wiki/公式笔记#计算]]")[0].kind === "noteLink" && (splitVaultNoteLinkSegments("[[wiki/公式笔记#计算]]")[0] as { heading?: string }).heading, "计算");

  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>");
  installObsidianDom(dom.window);
  const document = dom.window.document as Document;
  const proto = dom.window.HTMLElement.prototype;
  Object.assign(proto, {
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    appendText(this: HTMLElement, text: string) { this.append(document.createTextNode(text)); },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
    createEl(this: HTMLElement, tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      const el = document.createElement(tag); if (options.text) el.textContent = options.text; if (options.cls) el.className = options.cls;
      for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value); this.append(el); return el;
    },
    createDiv(this: HTMLElement, options = {}) { return this.createEl("div", options); },
    createSpan(this: HTMLElement, options = {}) { return this.createEl("span", options); }
  });
  const pending: Array<{ done: () => void; component: Component; text: string; sourcePath: string; el: HTMLElement }> = [];
  const original = MarkdownRenderer.render;
  MarkdownRenderer.render = async (_app, text, el, sourcePath, component) => new Promise<void>(resolve => {
    pending.push({ done: () => { el.createEl("p", { text }); resolve(); }, component, text, sourcePath, el });
  });
  const renderer = new AnswerMarkdownRenderer();
  const host = document.body.createDiv();
  let commits = 0;
  const render = (text: string, streaming = false, container = host) => renderer.render({
    app, text, streaming, container, key: "answer", sourcePath: "wiki/会话.md",
    mutate: preserveTextSelectionDuringMutation, onCommit: () => { commits += 1; }
  });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
  try {
    render("alpha beta", true);
    assert.equal(pending.length, 0, "streaming never invokes the slow native path");
    render("alpha beta");
    assert.match(host.textContent!, /alpha beta/u, "old content remains readable during native render");
    const oldSlot = host.firstChild;
    const remounted = document.body.createDiv();
    renderer.beginRender(); render("alpha beta", false, remounted); renderer.endRender();
    assert.equal(remounted.firstChild, oldSlot, "virtual row rebuilds reuse the readable slot");
    assert.equal(pending.length, 1, "remeasurement does not launch duplicate native work");
    render("alpha beta gamma", false, remounted);
    pending[1].done(); await settle();
    assert.equal(remounted.textContent, "alpha beta gamma");
    pending[0].done(); await settle();
    assert.equal(remounted.textContent, "alpha beta gamma", "late old render cannot overwrite a newer result");
    assert.equal((pending[0].component as unknown as { unloaded: boolean }).unloaded, true);
    assert.equal(commits, 1);
    assert.equal(remounted.querySelector(".markdown-rendered"), pending[1].el, "postprocessor container stays attached");
    const selected = document.getSelection()!;
    const textNode = remounted.querySelector("p")!.firstChild!;
    selected.setBaseAndExtent(textNode, 1, textNode, 4);
    render("alpha beta gamma delta", false, remounted); pending[2].done(); await settle();
    assert.equal(selected.toString(), "lph", "selection survives the async native commit");
    assert.equal((pending[1].component as unknown as { unloaded: boolean }).unloaded, true);
    render("pending disposal", false, remounted); renderer.clear(); pending[3].done(); await settle();
    assert.equal(remounted.childElementCount, 0, "disposed/session-switched slots cannot reappear");
    assert.equal((pending[3].component as unknown as { unloaded: boolean }).unloaded, true);
    assert.equal(commits, 2);
  } finally {
    renderer.clear(); MarkdownRenderer.render = original; dom.window.close();
  }
  console.log("PASS answer Markdown: math/code compatibility, links/source/anchors/save-path cells, streaming gate, virtual remount, stale disposal and async selection");
}
