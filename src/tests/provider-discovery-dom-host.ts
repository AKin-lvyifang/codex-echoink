export { Scope } from "./origin-obsidian-dom-shim";
import { Scope } from "./origin-obsidian-dom-shim";

export function installProviderBrowserHost(): void {
  const create = function (this: HTMLElement, tag: string, value: { cls?: string; text?: string; attr?: Record<string, string> } | string = {}) {
    const options = typeof value === "string" ? { cls: value } : value;
    const element = this.ownerDocument.createElement(tag);
    if (options.cls) element.className = options.cls;
    if (options.text) element.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element); return element;
  };
  Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); },
    addClass(...tokens: string[]) { this.classList.add(...tokens); },
    removeClass(...tokens: string[]) { this.classList.remove(...tokens); },
    hasClass(token: string) { return this.classList.contains(token); },
    toggleClass(token: string, force: boolean) { this.classList.toggle(token, force); },
    setAttr(name: string, value: string) { this.setAttribute(name, value); },
    setText(value: string) { this.textContent = value; },
    createEl: create,
    createDiv(options: Parameters<typeof create>[1]) { return create.call(this, "div", options); },
    createSpan(options: Parameters<typeof create>[1]) { return create.call(this, "span", options); }
  });
}

export class App {
  scope = new Scope();
  keymap = { pushScope(_scope: Scope) {}, popScope(_scope: Scope) {} };
}
export class Modal {
  containerEl = document.createElement("div");
  modalEl = document.createElement("div");
  titleEl = document.createElement("div");
  contentEl = document.createElement("div");
  constructor(public app: App) {
    this.containerEl.className = "modal-container";
    this.modalEl.className = "modal";
    this.titleEl.className = "modal-title";
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.titleEl, this.contentEl); this.containerEl.append(this.modalEl);
  }
  setTitle(value: string) { this.titleEl.textContent = value; return this; }
  open() { document.body.append(this.containerEl); this.onOpen(); }
  close() { this.onClose(); this.containerEl.remove(); }
  onOpen() {}
  onClose() {}
}
export function setIcon(element: HTMLElement, _icon: string): void {
  // Host-service icon placeholder only; production Origin controls render their real icons.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "14"); svg.setAttribute("height", "14");
  svg.innerHTML = '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.5"/>';
  element.append(svg);
}
export function setTooltip(element: HTMLElement, text: string) { element.title = text; }
export function requestUrl() { throw new Error("No external requests in browser fixture"); }
export class Notice {}
