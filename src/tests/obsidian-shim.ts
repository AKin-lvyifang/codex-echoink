export const apiVersion = "1.14.4";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { StateField } from "@codemirror/state";
import { installCurrentObsidianDom } from "./obsidian-dom";
export const editorInfoField = StateField.define({ create: () => ({ file: null }), update: value => value });
export const editorLivePreviewField = StateField.define({ create: () => false, update: value => value });
export { Scope } from "./origin-obsidian-dom-shim";
export { default as moment } from "moment";

const testGlobal = globalThis as unknown as { window?: Window };
if (!testGlobal.window) {
  testGlobal.window = globalThis as unknown as Window;
}
installCurrentObsidianDom();

export const openTestNoticeMessages: string[] = [];
export const openTestNotices: Notice[] = [];

export class Notice {
  hidden = false;
  readonly noticeEl?: HTMLElement;
  constructor(public readonly message: string, public readonly timeout?: number) {
    openTestNoticeMessages.push(message);
    openTestNotices.push(this);
    if (typeof document !== "undefined") {
      const wrapper = document.createElement("div"); wrapper.className = "notice";
      this.noticeEl = document.createElement("div"); this.noticeEl.className = "notice-message";
      this.noticeEl.textContent = message; wrapper.appendChild(this.noticeEl); document.body.appendChild(wrapper);
      wrapper.addEventListener("click", () => this.hide());
    }
  }
  // Real Notice begins a fade before detaching; retain connectivity to exercise that interval.
  hide(): void { this.hidden = true; }
}

export class TFolder { path = ""; name = ""; children: (TFile | TFolder)[] = []; }

export class TFile {
  constructor(public readonly path = "") {}
}

export class App {
  constructor() { installCurrentObsidianDom(); }
  vault = {
    getAllLoadedFiles: (): Array<TFile | TFolder> => []
  };
}

export class Plugin {}

export class PluginSettingTab {
  readonly app: App;
  readonly containerEl: HTMLElement;

  constructor(app: App, readonly plugin: unknown) {
    installCurrentObsidianDom();
    this.app = app;
    this.containerEl = document.createElement("div");
  }

  display(): void {}
  hide(): void {}
}

export class FileSystemAdapter {
  getFullPath(relativePath: string): string {
    return relativePath;
  }
}

export class Component {
  private readonly cleanups: Array<() => void> = [];
  loaded = false;
  unloaded = false;
  load(): void { this.loaded = true; }
  unload(): void { this.unloaded = true; for (const cleanup of this.cleanups.splice(0)) cleanup(); }
  registerDomEvent(element: HTMLElement, type: string, callback: EventListener): void {
    const fake = element as unknown as { listeners?: Map<string, EventListener> };
    if (typeof element.addEventListener === "function") {
      element.addEventListener(type, callback);
      this.cleanups.push(() => element.removeEventListener(type, callback));
    } else if (fake.listeners) {
      fake.listeners.set(type, callback);
      this.cleanups.push(() => { if (fake.listeners?.get(type) === callback) fake.listeners.delete(type); });
    }
  }
  registerEvent(): void {}
}

export const openTestMarkdownRenders: { markdown: string; element: HTMLElement; component: Component }[] = [];
export class MarkdownRenderer {
  static async render(_app: App, markdown: string, element: HTMLElement, _sourcePath: string, component: Component): Promise<void> {
    openTestMarkdownRenders.push({ markdown, element, component });
    // Preserve readable content in UI tests; this shim does not simulate the
    // host's Markdown parser or MathJax. Native formatting is verified in-app.
    element.setText(markdown);
  }
}

export class WorkspaceLeaf {
  view: unknown = null;
  async setViewState(): Promise<void> {}
  async openFile(): Promise<void> {}
}

/** Minimal stand-in: tests never host leaves in popout windows, so the
 * quick-chat controller's `instanceof WorkspaceWindow` checks fall through
 * to the sidebar path. */
export class WorkspaceWindow {
  win: Window | null = null;
  doc: Document | null = null;
}

/** Minimal stand-in for sidebar tab-group checks in tests. */
export class WorkspaceTabs {
  children: unknown[] = [];
}

export class View extends Component {
  containerEl = {
    children: [
      { empty: () => undefined },
      { empty: () => undefined }
    ]
  } as any;
  app = new App() as any;
  constructor(public readonly leaf: WorkspaceLeaf) {
    super();
    installCurrentObsidianDom();
  }
  getViewType(): string { return "test-view"; }
  getDisplayText(): string { return "Test View"; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class ItemView extends View {}
export class MarkdownView extends ItemView {}

export class Menu {
  setUseNativeMenu(): this { return this; }
  addItem(callback: (item: any) => void): this {
    callback({
      setTitle: () => ({
        setIcon: () => ({
          setChecked: () => ({
            onClick: () => undefined
          }),
          onClick: () => undefined
        }),
        setIsLabel: () => undefined,
        onClick: () => undefined
      })
    });
    return this;
  }
  showAtMouseEvent(): void {}
}

/** Modals currently open, in open order (test inspection hook). */
export const openTestModals: Modal[] = [];

export class Modal {
  containerEl = document.createElement("div");
  modalEl = document.createElement("div");
  titleEl = document.createElement("div");
  contentEl = document.createElement("div");
  private opened = false;
  constructor(public readonly app: App) {
    installCurrentObsidianDom();
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
  }
  setTitle(title: string): this { this.titleEl.setText(title); return this; }
  open(): void {
    if (this.opened) return;
    this.opened = true;
    openTestModals.push(this);
    this.containerEl.ownerDocument.body.appendChild(this.containerEl);
    this.onOpen();
  }
  close(): void {
    if (!this.opened) return;
    this.opened = false;
    const index = openTestModals.lastIndexOf(this);
    if (index >= 0) openTestModals.splice(index, 1);
    this.onClose();
    this.containerEl.remove();
  }
  onOpen(): void {}
  onClose(): void {}
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;

  constructor(public readonly containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(value: string): this { this.nameEl.setText(value); return this; }
  setDesc(value: string): this { this.descEl.setText(value); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  setClass(value: string): this { this.settingEl.addClass(value); return this; }
  addText(callback: (component: { inputEl: HTMLInputElement; setPlaceholder: (value: string) => any; setValue: (value: string) => any; getValue: () => string; onChange: (handler: (value: string) => any) => any }) => any): this {
    const inputEl = this.controlEl.createEl("input", {
      attr: { type: "text" }
    }) as HTMLInputElement;
    const component = {
      inputEl,
      setPlaceholder: (value: string) => {
        inputEl.placeholder = value;
        return component;
      },
      setValue: (value: string) => {
        inputEl.value = value;
        return component;
      },
      getValue: () => inputEl.value,
      onChange: (handler: (value: string) => any) => {
        inputEl.onchange = () => handler(inputEl.value);
        return component;
      }
    };
    callback(component);
    return this;
  }
  addToggle(callback: (component: { toggleEl: HTMLElement; inputEl: HTMLInputElement; setValue: (value: boolean) => any; onChange: (handler: (value: boolean) => any) => any }) => any): this {
    const toggleEl = this.controlEl.createDiv({
      cls: "checkbox-container"
    });
    const inputEl = toggleEl.createEl("input", {
      attr: { type: "checkbox", tabindex: "0" }
    }) as HTMLInputElement;
    const component = {
      toggleEl,
      inputEl,
      setValue: (value: boolean) => {
        inputEl.checked = value;
        return component;
      },
      onChange: (handler: (value: boolean) => any) => {
        inputEl.onchange = () => handler(inputEl.checked);
        return component;
      }
    };
    callback(component);
    return this;
  }
  addSlider(callback: (component: {
    sliderEl: HTMLElement;
    setLimits: (min: number, max: number, step?: number | "any") => any;
    setValue: (value: number) => any;
    setDynamicTooltip: (format?: (value: number) => string) => any;
    onChange: (handler: (value: number) => any) => any;
  }) => any): this {
    const sliderEl = this.controlEl.createEl("input", {
      attr: { type: "range" }
    });
    let value = 0;
    const component = {
      sliderEl,
      setLimits: (min: number, max: number, step?: number | "any") => {
        sliderEl.setAttr("min", String(min));
        sliderEl.setAttr("max", String(max));
        if (step !== undefined) sliderEl.setAttr("step", String(step));
        return component;
      },
      setValue: (next: number) => {
        value = next;
        sliderEl.setAttr("value", String(next));
        return component;
      },
      setDynamicTooltip: () => component,
      onChange: (handler: (value: number) => any) => {
        sliderEl.onchange = () => {
          value = Number((sliderEl as unknown as { value: string }).value ?? value);
          handler(value);
        };
        return component;
      }
    };
    callback(component);
    return this;
  }
  addDropdown(callback: (component: { selectEl: HTMLSelectElement; addOption: (value: string, label: string) => any; setValue: (value: string) => any; onChange: (handler: (value: string) => any) => any }) => any): this {
    const selectEl = this.controlEl.createEl("select") as HTMLSelectElement;
    const options: HTMLOptionElement[] = [];
    Object.defineProperty(selectEl, "options", { configurable: true, value: options });
    const component = {
      selectEl,
      addOption: (value: string, label: string) => {
        const option = selectEl.createEl("option", { text: label, attr: { value } });
        option.value = value;
        options.push(option);
        return component;
      },
      setValue: (value: string) => {
        selectEl.value = value;
        return component;
      },
      onChange: (handler: (value: string) => any) => {
        selectEl.onchange = () => handler(selectEl.value);
        return component;
      }
    };
    callback(component);
    return this;
  }
  addButton(callback: (component: {
    buttonEl: HTMLButtonElement;
    setButtonText: (value: string) => any;
    setTooltip: (value: string) => any;
    setDisabled: (value: boolean) => any;
    setWarning: () => any;
    setCta: () => any;
    onClick: (handler: () => any) => any;
  }) => any): this {
    const buttonEl = this.controlEl.createEl("button", {
      attr: { type: "button" }
    }) as HTMLButtonElement;
    const component = {
      buttonEl,
      setButtonText: (value: string) => {
        buttonEl.textContent = value;
        return component;
      },
      setTooltip: (value: string) => {
        buttonEl.title = value;
        return component;
      },
      setDisabled: (value: boolean) => {
        buttonEl.disabled = value;
        return component;
      },
      setWarning: () => {
        buttonEl.addClass("mod-warning");
        return component;
      },
      setCta: () => {
        buttonEl.addClass("mod-cta");
        return component;
      },
      onClick: (handler: () => any) => {
        buttonEl.onclick = handler;
        return component;
      }
    };
    callback(component);
    return this;
  }
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export const Platform = {
  isDesktop: true,
  isDesktopApp: false
};

export function getIcon(name: string): SVGSVGElement | null {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", `lucide lucide-${name}`);
  return icon;
}
export function setIcon(_element: Element, _icon: string): void {}

export function setTooltip(
  element: HTMLElement,
  tooltip: string,
  options?: { classes?: string[]; placement?: string }
): void {
  element.setAttribute("aria-label", tooltip);
  if (options?.classes) element.setAttribute("data-tooltip-class", options.classes.join(" "));
  if (options?.placement) element.setAttribute("data-tooltip-position", options.placement);
}

/** Records use of the public host API; native rendering/lifecycle need real-host acceptance. */
export const displayedTooltipsForTests = new WeakMap<HTMLElement, string | DocumentFragment>();
type TooltipDisplayForTests = (element: HTMLElement, content: string | DocumentFragment, options?: { classes?: string[]; placement?: string }) => void;
let tooltipDisplayForTests: TooltipDisplayForTests | undefined;
export function setTooltipDisplayForTests(handler: TooltipDisplayForTests): () => void {
  const previous = tooltipDisplayForTests;
  tooltipDisplayForTests = handler;
  return () => { tooltipDisplayForTests = previous; };
}
export function displayTooltip(element: HTMLElement, content: string | DocumentFragment, options?: { classes?: string[]; placement?: string }): void {
  displayedTooltipsForTests.set(element, content);
  tooltipDisplayForTests?.(element, content, options);
}

type RequestUrlHandler = (request: RequestUrlParam | string) => RequestUrlResponse | Promise<RequestUrlResponse>;
let requestUrlForTests: RequestUrlHandler | undefined;

export function setRequestUrlForTests(handler: RequestUrlHandler): () => void {
  const previous = requestUrlForTests;
  requestUrlForTests = handler;
  return () => { requestUrlForTests = previous; };
}

export async function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
  if (requestUrlForTests) return await requestUrlForTests(request);
  throw new Error("requestUrl is not available in unit tests");
}

let pdfJsForTests: unknown;

export function setPdfJsForTests(engine: unknown): void {
  pdfJsForTests = engine;
}

export async function loadPdfJs(): Promise<unknown> {
  if (pdfJsForTests) return pdfJsForTests;
  // Test engine only: production resolves the real Obsidian public API.
  const { getResolvedPDFJS } = await import("unpdf");
  return getResolvedPDFJS();
}

export function sanitizeHTMLToDom(html: string): DocumentFragment { return document.createRange().createContextualFragment(html); }
