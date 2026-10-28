import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { knowledgeLinkingProgressText, mountKnowledgeLinkingProgress } from "../ui/codex-view/knowledge-linking-progress";
import type { KnowledgeLinkingTask } from "../knowledge-base/knowledge-linking-types";

export async function runKnowledgeLinkingProgressTests(): Promise<void> {
  const dom = new JSDOM("<!doctype html><body><div id='mount'></div></body>");
  const create = function (this: Element, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element);
    return element;
  };
  Object.assign(dom.window.Element.prototype, {
    createEl: create,
    createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); },
    createSpan(options: Parameters<typeof create>[1]) { return create.call(this, "span", options); }
  });
  const mount = dom.window.document.getElementById("mount")!; let listener: (task: KnowledgeLinkingTask | null) => void = () => undefined; let subscriptions = 0; let opened = 0; let openedTask: string | undefined;
  const task: KnowledgeLinkingTask = { schemaVersion: 1, id: "job", mode: "manual", phase: "scanning", bindingSignature: "scope", createdAt: 1, updatedAt: 1, processed: 840, total: 3200, proposals: [], patches: [], results: [] };
  const source = { subscribe(fn: typeof listener) { subscriptions++; listener = fn; fn(task); return () => subscriptions--; } };
  const dispose = mountKnowledgeLinkingProgress(mount, source, taskId => { opened++; openedTask = taskId; });
  assert.ok([...mount.querySelectorAll("*")].every(element => element.ownerDocument === dom.window.document), "nodes stay in the host window");
  assert.match(mount.textContent!, /扫描笔记 840 \/ 3200/u); assert.equal(mount.querySelector("progress")!.max, 3200);
  mount.querySelector("button")!.click(); assert.equal(opened, 1); assert.equal(openedTask, task.id);
  task.phase = "judging"; task.total = null; listener(task); assert.equal(mount.querySelector("progress")!.hasAttribute("value"), false);
  task.phase = "awaiting-confirmation"; listener(task); assert.equal(mount.hidden, false); assert.equal(mount.querySelector("progress")!.hidden, true);
  task.phase = "partial"; listener(task); assert.equal(mount.hidden, false); assert.match(mount.textContent!, /部分完成/u);
  task.phase = "completed"; listener(task); assert.equal(mount.hidden, true);
  task.phase = "interrupted"; listener(task); assert.equal(knowledgeLinkingProgressText(task), "可继续");
  dispose(); assert.equal(subscriptions, 0); assert.equal(task.phase, "interrupted", "view destruction never cancels the Vault task");
  const reopen = mountKnowledgeLinkingProgress(mount, source, () => opened++); assert.equal(subscriptions, 1); assert.equal(mount.hidden, false); reopen();
  dom.window.close(); console.log("PASS knowledge-linking progress lifecycle (cross-conversation source, confirmation, completion, partial, reopen).");
}
