import assert from "node:assert/strict";
import type { CaptureLinkKind } from "../ui/capture-link-modal";
import { openTestModals, type Modal } from "./obsidian-shim";
import { installComposerMenuDomHelpers } from "./composer-menu-dom-host";

function installCaptureModalDom(): void {
  installComposerMenuDomHelpers(document);
  const prototype = document.defaultView!.HTMLElement.prototype;
  const create = prototype.createEl;
  Object.assign(prototype, {
    createEl(this: HTMLElement, tag: keyof HTMLElementTagNameMap, options: DomElementInfo = {}) {
      const element = create.call(this, tag, options);
      if (options.value !== undefined) (element as HTMLInputElement).value = options.value;
      return element;
    },
    empty(this: HTMLElement) { this.replaceChildren(); },
    setText(this: HTMLElement, value: string) { this.textContent = value; },
    setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); }
  });
}

export async function waitForCaptureLinkModal(): Promise<Modal> {
  installCaptureModalDom();
  for (let attempt = 0; attempt < 100; attempt++) {
    const modal = openTestModals.find(modal => modal.contentEl.querySelector("[data-capture-link-input]"));
    if (modal) return modal;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Link confirmation did not open");
}

/** Drive the production modal in business tests, including its visible failure. */
export async function confirmCaptureLinkForTest(operation: Promise<string[]>, kind?: CaptureLinkKind): Promise<string[]> {
  const observed = operation.then(paths => ({ paths }), error => ({ error: error as Error }));
  const modal = await waitForCaptureLinkModal();
  if (kind) {
    const radio = modal.contentEl.querySelector<HTMLInputElement | HTMLButtonElement>(`[data-capture-link-kind="${kind}"]`);
    assert.ok(radio);
    radio.click();
  }
  modal.contentEl.querySelector<HTMLButtonElement>("[data-capture-link-submit]")!.click();
  for (let attempt = 0; attempt < 200; attempt++) {
    const error = modal.contentEl.querySelector<HTMLElement>("[data-capture-link-error]");
    if (error && !error.hidden && error.textContent) {
      const message = error.textContent;
      modal.close();
      await observed;
      throw new Error(message);
    }
    if (!openTestModals.includes(modal)) {
      const result = await observed;
      if ("error" in result) throw result.error;
      return result.paths;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Link capture did not finish");
}
