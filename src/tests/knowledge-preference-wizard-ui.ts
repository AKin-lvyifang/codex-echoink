import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { App } from "obsidian";
import { installObsidianDom } from "./obsidian-dom";
import { KnowledgePreferenceWizard } from "../ui/knowledge-preference-wizard";
import type { KnowledgeMaintenancePreferenceSnapshot } from "../knowledge-base/knowledge-maintenance-preferences";

export async function runKnowledgePreferenceWizardUiTests() {
  const dom = new JSDOM("<body><main></main></body>", { pretendToBeVisual: true });
  const win = dom.window;
  installObsidianDom(win);
  Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
  Object.assign(win.HTMLElement.prototype, {
    empty() { this.replaceChildren(); },
    addClass(...names: string[]) { this.classList.add(...names); },
    removeClass(...names: string[]) { this.classList.remove(...names); },
    toggleClass(name: string, value: boolean) { this.classList.toggle(name, value); },
    setAttr(name: string, value: string) { this.setAttribute(name, value); },
    setText(text: string) { this.textContent = text; },
    createEl(tag: string, options: any = {}) { return (win as any).createEl(tag, { ...options, parent: this }); },
    createDiv(options: any = {}) { return this.createEl("div", options); },
    createSpan(options: any = {}) { return this.createEl("span", options); },
  });
  const baseline: KnowledgeMaintenancePreferenceSnapshot = {
    state: "default", content: "# 偏好\n\n## 颗粒度与组织\n原文。\n\n## 表达风格\n原文。\n",
    revision: "sha256:" + "a".repeat(64), profileVersion: "echoink-knowledge-preference-profile-v1",
  };
  const root = win.document.querySelector("main")!;
  let requests = 0, writes = 0;
  const wizard = new KnowledgePreferenceWizard({
    read: async () => baseline, save: async () => { writes++; return baseline; }, available: () => true,
    generate: async prompt => {
      requests++;
      assert.ok(prompt.includes("研究写论文"));
      return JSON.stringify({ granularity: ["分清论点与证据。", "保留方法限制。"], expression: ["保留引用依据。", "明确研究范围。"] });
    },
  }, baseline, { language: "zh-CN", changed: () => render(), done: () => {} });
  const render = () => { root.replaceChildren(); wizard.render(root, {} as App); };
  try {
    render();
    assert.equal(root.querySelectorAll('input[type="radio"]:checked').length, 0);
    assert.equal((root.querySelector('[data-preference-action="generate"]') as HTMLButtonElement).disabled, true);
    await (wizard as any).generate();
    assert.equal(requests, 0, "An empty choice also blocks a direct generation call");
    (root.querySelector('[aria-label="研究写论文"]') as HTMLInputElement).click();
    assert.equal((root.querySelector('[data-preference-action="generate"]') as HTMLButtonElement).disabled, false);
    (root.querySelector('[data-preference-action="generate"]') as HTMLButtonElement).click();
    for (let i = 0; i < 20 && !root.querySelector('[data-preference-step="review"]'); i++)
      await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(requests, 1);
    assert.ok(root.querySelector('[data-preference-step="review"]'));
    wizard.cancel();
    assert.equal(writes, 0, "Viewing or cancelling the generated preference never writes it");
  } finally { wizard.dispose(); dom.window.close(); }
  console.log("PASS purpose UI: no preset, disabled and method-level zero requests, explicit choice enables generation, cancel never writes.");
}
