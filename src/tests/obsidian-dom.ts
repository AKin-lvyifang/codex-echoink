/** The public Obsidian DOM additions used by browser/JSDOM fixtures. */
export function installObsidianDom(value: unknown): void {
  const win = value as Window & typeof globalThis;
  if (!win?.document || !win.Node) return;
  type Options = DomElementInfo | SvgElementInfo | string;
  function configure<T extends Element>(element: T, options: Options = {}, callback?: (element: T) => void): T {
    const info = typeof options === "string" ? { cls: options } : options;
    if (info.cls) element.setAttribute("class", Array.isArray(info.cls) ? info.cls.join(" ") : info.cls);
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    const html = info as DomElementInfo;
    if (html.text !== undefined) {
      if (typeof html.text === "string") element.textContent = html.text;
      else element.appendChild(html.text);
    }
    for (const name of ["title", "value", "type", "placeholder", "href"] as const) {
      if (html[name] !== undefined) element.setAttribute(name, html[name]!);
    }
    if (info.parent) {
      if (info.prepend) info.parent.insertBefore(element, info.parent.firstChild);
      else info.parent.appendChild(element);
    }
    callback?.(element);
    return element;
  }
  const createEl = <K extends keyof HTMLElementTagNameMap>(tag: K, options?: DomElementInfo | string, callback?: (element: HTMLElementTagNameMap[K]) => void) => configure(win.document.createElement(tag), options, callback);
  const createSvg = <K extends keyof SVGElementTagNameMap>(tag: K, options?: SvgElementInfo | string, callback?: (element: SVGElementTagNameMap[K]) => void) => configure(win.document.createElementNS("http://www.w3.org/2000/svg", tag), options, callback);
  Object.assign(win, {
    createEl,
    createDiv: (options?: DomElementInfo | string, callback?: (element: HTMLDivElement) => void) => createEl("div", options, callback),
    createSpan: (options?: DomElementInfo | string, callback?: (element: HTMLSpanElement) => void) => createEl("span", options, callback),
    createSvg,
    createFragment: (callback?: (fragment: DocumentFragment) => void) => { const fragment = win.document.createDocumentFragment(); callback?.(fragment); return fragment; }
  });
  // DOMParser documents have no defaultView, but still belong to this realm.
  Object.defineProperty(win.Node.prototype, "win", { configurable: true, get(this: Node) {
    const document = this.nodeType === 9 ? this as Document : this.ownerDocument;
    return document?.defaultView ?? win;
  } });
  Object.defineProperty(win.Node.prototype, "instanceOf", { configurable: true, value(this: Node, constructor: typeof Node) { return this instanceof constructor; } });
}

/** Call at import and at host construction; late-created fixtures call the installer explicitly. */
export function installCurrentObsidianDom(): void {
  installObsidianDom((globalThis as { window?: unknown }).window);
}

/** Structural unit-test documents have their own node classes rather than a browser realm. */
export function installMockObsidianDom<T>(value: T): T {
  const document = value as T & {
    win?: unknown;
    createElement(tag: string): unknown;
    createElementNS?(namespace: string, tag: string): unknown;
    createDocumentFragment?(): unknown;
    adoptNode?: (node: unknown) => unknown;
  };
  document.win ??= {
    createEl: (tag: string) => document.createElement(tag),
    createDiv: () => document.createElement("div"),
    createSpan: () => document.createElement("span"),
    createSvg: (tag: string) => document.createElementNS?.("http://www.w3.org/2000/svg", tag) ?? document.createElement(tag),
    createFragment: () => document.createDocumentFragment?.() ?? document.createElement("fragment")
  };
  document.adoptNode ??= node => node;
  return value;
}
