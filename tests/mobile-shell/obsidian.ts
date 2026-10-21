/** Browser-only Obsidian DOM adapter. Never imported by a product entry point. */
type IconNode = [string, Record<string, string | number>, IconNode[]?];

declare global {
  interface Window { lucide?: { icons: Record<string, IconNode> }; }
}

export function setIcon(element: HTMLElement, name: string): void {
  const key = name.replace(/^lucide-/, "").split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  const source = element.ownerDocument.defaultView?.lucide?.icons[key];
  if (!source) throw new Error(`Missing bundled Lucide icon: ${name}`);
  const create = ([tag, attributes, children = []]: IconNode): SVGElement => {
    const node = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, String(value));
    for (const child of children) node.append(create(child));
    return node;
  };
  const svg = create(source);
  svg.classList.add("svg-icon");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("aria-hidden", "true");
  element.replaceChildren(svg);
}

// The real shell only needs setIcon. These methods support page-slot helpers that
// normally receive the DOM extensions provided by Obsidian itself.
const prototype = HTMLElement.prototype as HTMLElement & Record<string, unknown>;
Object.assign(prototype, {
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
  setText(this: HTMLElement, value: string) { this.textContent = value; },
  setAttr(this: HTMLElement, name: string, value: string) { this.setAttribute(name, value); },
  createEl(this: HTMLElement, tag: string, options: { cls?: string; text?: string; attr?: Record<string, string> } = {}) {
    const element = this.ownerDocument.createElement(tag);
    element.className = options.cls ?? "";
    element.textContent = options.text ?? "";
    for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
    this.append(element);
    return element;
  },
  createDiv(this: HTMLElement, options: string | { cls?: string; text?: string } = {}) {
    const element = this.ownerDocument.createElement("div");
    element.className = typeof options === "string" ? options : options.cls ?? "";
    if (typeof options !== "string") element.textContent = options.text ?? "";
    this.append(element);
    return element;
  }
});
