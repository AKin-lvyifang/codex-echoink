export const apiVersion = "1.14.4";
const paths: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  "circle-help": '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
  "calendar-days": '<path d="M8 2v4M16 2v4M3 10h18"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  "arrow-up": '<path d="m5 12 7-7 7 7M12 5v14"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>', "chevron-right": '<path d="m9 18 6-6-6-6"/>', "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m4 12 5 5L20 6"/>', square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  "shield-check": '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z"/><path d="m8 12 3 3 5-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="m6 6 12 12M6 18 18 6"/>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  "settings-2": '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 3v5M8 13v2M16 13v2M1 12v4M23 12v4"/>',
  "square-pen": '<path d="M21 14v6H4V3h9M14 5l4 4M10 15l1-5L19 2l4 4-8 8-5 1Z"/>',
  "notebook-pen": '<rect x="4" y="3" width="15" height="18" rx="2"/><path d="M8 3v18M11 14l5-5 3 3-5 5-3 1Z"/>',
  brain: '<path d="M12 5c-4-6-11 1-7 5-6 2-3 11 3 9 1 4 4 2 4-1V5Zm0 0c4-6 11 1 7 5 6 2 3 11-3 9-1 4-4 2-4-1"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
type IconNode = [string, Record<string, string | number>, IconNode[]?];
type LucideWindow = Window & { lucide?: { icons: Record<string, IconNode> } };
function fixtureIcon(doc: Document, name: string): SVGElement | null {
  const canonical = name.replace(/^lucide-/, "");
  const key = canonical.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  const icons = (doc.defaultView as LucideWindow | null)?.lucide?.icons;
  const source = icons?.[key];
  let svg: SVGElement;
  if (source) {
    const create = ([tag, attributes, children = []]: IconNode): SVGElement => {
      const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [attribute, value] of Object.entries(attributes)) node.setAttribute(attribute, String(value));
      for (const child of children) node.append(create(child));
      return node;
    };
    svg = create(source);
  } else {
    if (icons) return null;
    // JSDOM tests without the browser asset retain their original lightweight paths.
    const parsed = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[canonical] ?? '<circle cx="12" cy="12" r="8"/>'}</svg>`, "image/svg+xml");
    svg = doc.importNode(parsed.documentElement, true) as unknown as SVGElement;
  }
  svg.classList.add("svg-icon"); svg.setAttribute("data-icon", name); svg.setAttribute("aria-hidden", "true");
  return svg;
}
export function getIcon(name: string): SVGElement | null { return fixtureIcon(document, name); }
export function setIcon(element: HTMLElement, name: string) {
  const svg = fixtureIcon(element.ownerDocument, name);
  if (!svg) throw new Error(`Missing bundled Lucide icon: ${name}`);
  element.replaceChildren(svg);
}

export function setTooltip(element: HTMLElement, content: string, options?: { placement?: string; classes?: string[] }): void {
  element.setAttribute("aria-label", content);
  if (options?.placement) element.setAttribute("data-tooltip-position", options.placement);
  if (options?.classes) element.setAttribute("data-tooltip-class", options.classes.join(" "));
}
// Mobile help uses its tappable panel. Desktop native rendering requires Obsidian.
export function displayTooltip(_element: HTMLElement, _content: string | DocumentFragment): void {}

export { FixtureTFile as TFile } from "./host.mjs";
export { parse as parseYaml } from "yaml";
export class TFolder {
  path = ""; name = ""; children: unknown[] = [];
  static [Symbol.hasInstance](value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const folder = value as { path?: unknown; children?: unknown; extension?: unknown };
    return typeof folder.path === "string" && Array.isArray(folder.children) && folder.extension === undefined;
  }
}
export class Component { addChild() {} removeChild() {} register() {} load() {} unload() {} }
export class Plugin extends Component {
  private domEvents: (() => void)[] = [];
  constructor(public app: any, public manifest: any) { super(); }
  registerView(type: string, factory: unknown) { this.app.workspace.registerView(type, factory); }
  registerEditorExtension() {}
  registerMarkdownPostProcessor() {}
  async saveData(_data: unknown) {}
  registerDomEvent(target: Document | Window, name: string, listener: EventListener) {
    target.addEventListener(name, listener); this.domEvents.push(() => target.removeEventListener(name, listener));
  }
  unload() { this.domEvents.forEach(remove => remove()); this.domEvents = []; }
}
export class ItemView {
  app: any; containerEl: HTMLElement; contentEl: HTMLElement;
  constructor(public leaf: any) { this.app = leaf.app; this.containerEl = leaf.containerEl; this.contentEl = leaf.contentEl; }
  registerEvent() {} register() {} addChild() {} removeChild() {}
  registerDomEvent(element: any, name: string, cb: any, options?: any) { element.addEventListener(name, cb, options); }
}
export class Modal {
  contentEl: HTMLElement; modalEl: HTMLElement; titleEl: HTMLElement; containerEl: HTMLElement;
  constructor(public app: unknown) { this.containerEl = document.createElement("div"); this.containerEl.className = "modal-container"; this.modalEl = this.containerEl.appendChild(document.createElement("div")); this.modalEl.className = "modal"; this.titleEl = document.createElement("h2"); this.contentEl = document.createElement("div"); this.contentEl.className = "modal-content"; this.modalEl.append(this.titleEl, this.contentEl); }
  open() {
    if (document.body.classList.contains("fixture-host")) {
      const close = this.modalEl.appendChild(document.createElement("div"));
      close.className = "modal-close-button"; close.textContent = "×"; close.setAttribute("role", "button"); close.setAttribute("aria-label", "关闭宿主弹窗"); close.tabIndex = 0;
      close.onclick = () => this.close(); close.onkeydown = event => { if (event.key === "Enter" || event.key === "Escape") this.close(); };
    }
    document.body.append(this.containerEl); (this as any).onOpen?.();
  }
  close() { (this as any).onClose?.(); this.containerEl.remove(); }
  setTitle(text: string) { this.titleEl.textContent = text; }
  register() {} registerDomEvent(element: HTMLElement, name: string, cb: EventListener) { element.addEventListener(name, cb); }
}
export const Platform = { isMobileApp: true, isMobile: true, isTablet: false };
export class Scope { constructor(_parent?: unknown) {} register() {} }
export const MarkdownRenderer = { async render(_app: unknown, text: string, element: HTMLElement) { element.textContent = text; } };
export async function requestUrl() { throw new Error("Browser fixture cannot call a real Provider"); }
export class Notice { constructor(text: string, _timeout?: number) { console.info("Fixture notice", text); } hide() {} }
export function sanitizeHTMLToDom(html: string) { const template = document.createElement("template"); template.innerHTML = html; return template.content; }
const prototype = HTMLElement.prototype as any;
(SVGElement.prototype as any).addClass = function(...names: string[]) { this.classList.add(...names); };
prototype.empty = function() { this.replaceChildren(); };
prototype.addClass = function(...names: string[]) { this.classList.add(...names); };
prototype.removeClass = function(...names: string[]) { this.classList.remove(...names); };
prototype.setText = function(text: string) { this.textContent = text; };
prototype.createEl = function(tag: string, opts: any = {}) { const element = document.createElement(tag); element.className = opts.cls ?? ""; element.textContent = opts.text ?? ""; if (opts.value !== undefined) (element as HTMLInputElement).value = opts.value; for (const [key, value] of Object.entries(opts.attr ?? {})) element.setAttribute(key, String(value)); this.append(element); return element; };
prototype.createDiv = function(opts: any = {}) { return this.createEl("div", typeof opts === "string" ? { cls: opts } : opts); };
prototype.createSpan = function(opts: any = {}) { return this.createEl("span", opts); };
export { default as moment } from "moment";

prototype.toggleClass = function(name: string, force: boolean) { this.classList.toggle(name, force); };
prototype.setAttr = function(name: string, value: string) { this.setAttribute(name, value); };
export function normalizePath(path: string) { return path.replace(/\\/g, "/").replace(/\/+/g, "/"); }
export class WorkspaceLeaf {}
export class Setting {
  settingEl: HTMLElement;
  constructor(parent: HTMLElement) { this.settingEl = parent.createDiv({cls:"setting-item"}); }
  setName(text: string) { this.settingEl.createSpan({text}); return this; }
  setDesc(text: string) { this.settingEl.createSpan({text}); return this; }
  addButton(callback: (button: any) => void) { const element = this.settingEl.createEl("button"); const button = { buttonEl: element, setButtonText(text: string) { element.textContent = text; return this; }, setCta() { element.classList.add("mod-cta"); return this; }, onClick(fn: () => void) { element.onclick = fn; return this; } }; callback(button); return this; }
}

/** Native editor type boundary; browser preview does not emulate a real editor. */
export class MarkdownView {}
