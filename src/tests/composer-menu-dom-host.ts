/** Browser-only substitutes for Obsidian services; DOM events remain native. */
export class Menu {}
export class Notice {}
export function setIcon(container: HTMLElement, icon: string): void { container.dataset.icon = icon; }

export function installComposerMenuDomHelpers(owner: Document): void {
  const prototype = owner.defaultView!.HTMLElement.prototype;
  const create = function (this: HTMLElement, tag: string, options: {
    cls?: string; text?: string; attr?: Record<string, string>;
  } = {}): HTMLElement {
    const child = this.ownerDocument.createElement(tag);
    if (options.cls) child.className = options.cls;
    if (options.text) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
    this.append(child); return child;
  };
  Object.assign(prototype, {
    createEl: create,
    createDiv(this: HTMLElement, options: unknown) { return create.call(this, "div", options as never); },
    createSpan(this: HTMLElement, options: unknown) { return create.call(this, "span", options as never); },
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
    setCssStyles(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); }
  });
}
