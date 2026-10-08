import { LifestyleFinanceService } from "../lifestyle/finance-service";
import { paidTestAccess } from "./membership-access";
import assert from "node:assert/strict";
import { FinanceCatalogPanel, type CatalogKind } from "../lifestyle/finance-catalog-dialog";
import { financeIconOptions, renderFinanceIcon } from "../lifestyle/finance-icon-picker";
import { FinanceWorkspace } from "../lifestyle/finance-view";
import { DEFAULT_LIFESTYLE_SETTINGS } from "../lifestyle/settings";
import type { LifestyleService } from "../lifestyle/service";
import type { FinanceEntry } from "../lifestyle/store";
import { openTestModals } from "./obsidian-shim";

/** Small Obsidian DOM adapter: exercise rendered controls and their click/submit handlers. */
export class ElementNode {
  children: ElementNode[] = [];
  parentElement: ElementNode | null = null;
  className = "";
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  style = { width: "", height: "", background: "", setProperty: (_name: string, _value: string) => undefined };
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  private ownText = "";
  private attributes = new Map<string, string>();
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  constructor(readonly tagName: string, readonly ownerDocument: TestDocument) {}
  get isConnected(): boolean { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  get textContent(): string { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.empty(); this.ownText = value; }
  get classList() { return {
    contains: (name: string) => this.className.split(" ").includes(name),
    add: (name: string) => this.toggleClass(name, true),
    toggle: (name: string, force?: boolean) => { const next = force ?? !this.className.split(" ").includes(name); this.toggleClass(name, next); return next; }
  }; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "class") this.className = value;
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  setAttr(name: string, value: string): void { this.setAttribute(name, value); }
  addClass(name: string): void { this.className = `${this.className} ${name}`.trim(); }
  toggleClass(name: string, force: boolean): void { this.className = [...new Set(this.className.split(" ").filter((item) => item && item !== name).concat(force ? [name] : []))].join(" "); }
  setText(value: string): void { this.textContent = value; }
  empty(): void { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = ""; }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  createEl(tag: string, options: { cls?: string; text?: string; value?: string; attr?: Record<string, string> } = {}): ElementNode {
    const child = new ElementNode(tag, this.ownerDocument);
    child.parentElement = this; this.children.push(child);
    if (options.cls) child.className = options.cls;
    if (options.text) child.textContent = options.text;
    if (options.value) child.value = options.value;
    for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
    return child;
  }
  createDiv(options?: Parameters<ElementNode["createEl"]>[1]): ElementNode { return this.createEl("div", options); }
  createSpan(options?: Parameters<ElementNode["createEl"]>[1]): ElementNode { return this.createEl("span", options); }
  appendChild(child: ElementNode): ElementNode { child.parentElement = this; this.children.push(child); return child; }
  querySelector<T extends ElementNode = ElementNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): ElementNode | null {
    for (let node: ElementNode | null = this; node; node = node.parentElement)
      if (selector.startsWith(".") && node.classList.contains(selector.slice(1))) return node;
    return null;
  }
  querySelectorAll<T extends ElementNode = ElementNode>(selector: string): T[] {
    const direct = selector.startsWith(":scope > ");
    const target = direct ? selector.slice(9) : selector;
    const matches = (node: ElementNode): boolean => {
      if (target.startsWith(".")) return node.classList.contains(target.slice(1));
      const attribute = target.match(/^\[data-catalog-index="(.*)"\]$/u);
      return attribute ? node.getAttribute("data-catalog-index") === attribute[1] : node.tagName === target;
    };
    const visit = (nodes: ElementNode[]): ElementNode[] => nodes.flatMap((node) => [node, ...visit(node.children)]);
    return (direct ? this.children : visit(this.children)).filter(matches) as T[];
  }
  click(): void { if (!this.disabled) this.onclick?.(); }
  focus(): void { this.ownerDocument.activeElement = this; }
  scrollIntoView(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  requestSubmit(): void { this.onsubmit?.({ preventDefault() {} }); }
}

export class TestDocument {
  activeElement: ElementNode | null = null;
  body = new ElementNode("body", this);
  defaultView = { innerHeight: 800, requestAnimationFrame: (callback: () => void) => { callback(); return 1; } };
  private listeners = new Map<string, Set<(event: { key: string }) => void>>();
  addEventListener(type: string, listener: (event: { key: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: { key: string }) => void): void { this.listeners.get(type)?.delete(listener); }
  dispatchKey(key: string): void { for (const listener of this.listeners.get("keydown") ?? []) listener({ key }); }
  listenerCount(type: string): number { return this.listeners.get(type)?.size ?? 0; }
  createElementNS(_namespace: string, tag: string): ElementNode { return new ElementNode(tag, this); }
}

export async function runLifestyleFinanceUiTests(): Promise<void> {
  const originalObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe(): void {} disconnect(): void {} } as typeof MutationObserver;
  try {
    const originalDocument = globalThis.document, originalReader = globalThis.FileReader;
    const helpDocument = new TestDocument();
    globalThis.document = Object.assign(helpDocument, { createElement: (tag: string) => {
      const node = new ElementNode(tag, helpDocument);
      Object.assign(node, { append: (...children: ElementNode[]) => children.forEach((child) => node.appendChild(child)) });
      return node;
    } }) as unknown as Document;
    globalThis.FileReader = class { static LOADING = 1; } as unknown as typeof FileReader;
    let importCalls = 0, modelCalls = 0;
    try {
      const workspace = new FinanceWorkspace({ plugin: { app: {} }, finance: {
        access: paidTestAccess, accessState: () => ({ canEnter: true, canToggle: true, canWrite: true, reason: null }),
        confirmImport: async () => { importCalls++; }, prepareImport: async () => { modelCalls++; }
      } } as unknown as LifestyleService);
      (workspace as unknown as { importDialog(): void }).importDialog();
      const modal = openTestModals.at(-1)!;
      const content = modal.contentEl as unknown as ElementNode;
      const help = content.querySelector(".echoink-finance-import-help")!;
      assert.equal(help.tagName, "details");
      assert.equal(help.getAttribute("open"), null, "help is initially collapsed");
      assert.equal(content.children.indexOf(help), content.children.indexOf(content.querySelector(".echoink-finance-import-intro")!) + 1);
      assert.equal(content.children.indexOf(content.querySelector(".echoink-finance-import-fields")!), content.children.indexOf(help) + 1);
      const summary = help.children[0];
      assert.equal(summary.tagName, "summary", "native summary retains browser keyboard semantics");
      assert.equal(summary.textContent, "如何获取账单流水？");
      assert.equal(summary.onclick, null, "help has no import or model click handler");
      summary.focus(); summary.click();
      assert.equal(helpDocument.activeElement, summary);
      assert.deepEqual([importCalls, modelCalls], [0, 0]);
      assert.match(help.textContent, /开具交易流水证明/u);
      assert.match(help.textContent, /ZIP 先解压/u);
      modal.close();
    } finally {
      for (const modal of [...openTestModals]) modal.close();
      globalThis.document = originalDocument; globalThis.FileReader = originalReader;
    }
    const options = financeIconOptions("entry");
    assert.equal(new Set(options.map((item) => item.id)).size, options.length);
    assert.ok(options.some((item) => item.group === "其他品牌"), "all brand resources have a visible group");
    const categoryIcons = financeIconOptions("category");
    assert.ok(categoryIcons.length >= 60 && categoryIcons.some((item) => item.id === "wallet"));
    assert.ok(categoryIcons.every((item) => !financeIconOptions("merchant").some((brand) => brand.id === item.id)), "category and brand ids are distinct");
    assert.ok(financeIconOptions("merchant").some((item) => item.id === "nike" && item.group === "餐饮与购物"));
    const iconHost = new TestDocument().body.createSpan();
    renderFinanceIcon(iconHost as unknown as HTMLElement, "nike");
    assert.ok(iconHost.classList.contains("has-light-backdrop"));
    renderFinanceIcon(iconHost as unknown as HTMLElement, "coffee");
    assert.equal(iconHost.classList.contains("has-light-backdrop"), false, "switching back to Lucide clears the brand backdrop");
    for (const kind of ["merchants", "accounts", "categories"] as CatalogKind[]) {
      const document = new TestDocument();
      const root = document.body.createDiv();
      const settings = structuredClone(DEFAULT_LIFESTYLE_SETTINGS);
      settings.finance.merchants.push({ name: "原商户", aliases: [], iconId: "auto", defaultCategory: "", active: true });
      settings.finance.accounts.push({ name: "原账户", aliases: [], active: true });
      let saveFails = false;
      let saveCalls = 0;
      const scopes: unknown[] = [];
      const plugin = { settings: { lifestyle: settings }, app: { scope: {}, keymap: {
        pushScope: (scope: unknown) => scopes.push(scope),
        popScope: (scope: unknown) => { const index = scopes.indexOf(scope); if (index >= 0) scopes.splice(index, 1); }
      } }, lifestyle: { refresh() {}, finance: null as unknown as LifestyleFinanceService }, saveSettings: async () => { saveCalls++; if (saveFails) throw new Error("保存失败"); } };
      plugin.lifestyle.finance = new LifestyleFinanceService({ plugin, refresh: () => plugin.lifestyle.refresh() } as never, paidTestAccess);
      let exits = 0;
      let panel: FinanceCatalogPanel;
      const draw = () => {
        root.empty();
        const page = root.createDiv({ cls: "echoink-life-settings-page" });
        const back = page.createEl("button", { cls: "echoink-life-settings-back", text: panel.backLabel() });
        back.onclick = () => panel.back();
        page.createEl("h2", { text: panel.title() });
        panel.render(page as unknown as HTMLElement);
      };
      panel = new FinanceCatalogPanel(plugin as never, kind, () => { exits++; }, draw);
      draw();
      const edit = root.querySelector<ElementNode>('[data-catalog-index="0"]')!;
      edit.click();
      assert.ok(root.querySelector("form"), `${kind} edit opens the form`);
      assert.equal(root.querySelector(".echoink-finance-catalog-list"), null, "list and form are mutually exclusive");
      assert.equal(root.querySelector<ElementNode>("input")?.value, kind === "merchants" ? "原商户" : kind === "accounts" ? "原账户" : settings.finance.categories[0].name);
      if (kind === "categories") {
        const swatches = root.querySelectorAll<ElementNode>(".echoink-finance-color-swatch");
        assert.equal(swatches.length, 21, "existing non-preset color stays selectable beside twenty presets");
        assert.equal(swatches[0].getAttribute("aria-pressed"), "true");
      }
      root.querySelector<ElementNode>(".echoink-life-settings-back")!.click();
      assert.ok(root.querySelector(".echoink-finance-catalog-list"), "back returns to the list");
      assert.equal(exits, 0);
      root.querySelector<ElementNode>(".echoink-finance-catalog-add")!.click();
      const form = root.querySelector<ElementNode>("form")!;
      const name = form.querySelector<ElementNode>("input")!;
      name.value = `新${kind}`;
      if (kind === "categories") {
        const swatches = form.querySelectorAll<ElementNode>(".echoink-finance-color-swatch");
        assert.equal(swatches.length, 20, "new categories show exactly twenty preset colors");
        swatches[3].click(); assert.equal(swatches[3].getAttribute("aria-pressed"), "true");
      }
      if (kind !== "accounts") {
        form.querySelector<ElementNode>(".echoink-finance-icon-trigger")!.click();
        assert.equal(root.querySelector<ElementNode>(".echoink-life-settings-back")!.hidden, true, "parent back is hidden inside picker");
        assert.equal(scopes.length, 1, "picker owns Escape scope");
        const group = root.querySelector<ElementNode>(".echoink-finance-icon-group")!;
        group.click();
        assert.ok(root.querySelector(".echoink-finance-icon-item"), "group shows real icon choices");
        assert.equal(document.activeElement, root.querySelector(".echoink-finance-icon-search"), "group entry moves focus into search");
        (scopes[0] as { dispatch(event: KeyboardEvent): unknown }).dispatch({ key: "Escape" } as KeyboardEvent);
        assert.ok(root.querySelector(".echoink-finance-icon-group"), "back returns to groups");
        assert.equal(document.activeElement?.dataset.iconGroup, group.dataset.iconGroup, "back restores focus to the selected group");
        const search = root.querySelector<ElementNode>(".echoink-finance-icon-search")!;
        const scope = kind === "merchants" ? "merchant" : "category";
        search.value = kind === "merchants" ? "耐克" : "钱包";
        search.oninput?.();
        assert.ok(root.querySelector(".echoink-finance-icon-item"), "top-level search finds matching icons");
        root.querySelector<ElementNode>(".echoink-finance-icon-item")!.click();
        assert.equal(scopes.length, 0, "closing picker releases Escape scope");
        assert.equal(name.value, `新${kind}`, "picker round-trip keeps the unsaved name");
        assert.equal(root.querySelector<ElementNode>(".echoink-life-settings-back")!.hidden, false, "parent back returns with the draft");
      }
      saveFails = true;
      form.requestSubmit();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(root.querySelector<ElementNode>("input")?.value, `新${kind}`, "failed save keeps the form draft");
      assert.match(root.querySelector(".echoink-life-error")?.textContent ?? "", /保存失败/u);
      saveFails = false;
      form.requestSubmit();
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(root.querySelector(".echoink-finance-catalog-list"), "successful save returns to list");
      if (kind === "categories") {
        assert.equal(settings.finance.categories.at(-1)?.color, "#5b95b0", "selected swatch is persisted only on save");
        assert.equal(settings.finance.categories.at(-1)?.icon, "wallet", "new category icon persists after picker round-trip");
      }
      if (kind === "merchants") assert.equal(settings.finance.merchants.at(-1)?.iconId, "nike", "new brand icon persists after picker round-trip");
      assert.equal(saveCalls, 2);
      panel.back(); assert.equal(exits, 1);
    }
    console.log("OK lifestyle finance catalog render/click navigation, picker draft, save failure");
  } finally { globalThis.MutationObserver = originalObserver; }
  runRecentSizerRegression();
}

function runRecentSizerRegression(): void {
  const originalObserver = globalThis.ResizeObserver;
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const win = {
    requestAnimationFrame(callback: () => void) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id: number) { frames.delete(id); }
  };
  const flush = (): void => {
    while (frames.size) {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id); callback();
    }
  };
  let observer: { trigger(): void; disconnected: boolean; targets: unknown[] } | null = null;
  class TestResizeObserver {
    disconnected = false;
    targets: unknown[] = [];
    constructor(private readonly callback: () => void) { observer = this; }
    observe(target: unknown): void { this.targets.push(target); }
    disconnect(): void { this.disconnected = true; }
    trigger(): void { this.callback(); }
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  try {
    const rows: Array<{ getBoundingClientRect(): { bottom: number }; remove(): void }> = [];
    let added = 0; let removed = 0; let sideBottom = 236; let sideLeft = 500;
    const list = {
      children: rows,
      get lastElementChild() { return rows.at(-1) ?? null; },
      getBoundingClientRect: () => ({ top: 0, width: 500, height: rows.length * 72 })
    };
    const workspace = new FinanceWorkspace({} as LifestyleService) as unknown as {
      host: HTMLElement; transactionRow(list: HTMLElement, entry: FinanceEntry, compact: boolean): void;
      sizeRecentTransactions(layout: HTMLElement, main: HTMLElement, side: HTMLElement, list: HTMLElement, entries: FinanceEntry[]): void;
      detach(): void;
    };
    workspace.host = { ownerDocument: { defaultView: win } } as unknown as HTMLElement;
    workspace.transactionRow = () => {
      let row: typeof rows[number];
      row = {
        getBoundingClientRect: () => ({ bottom: (rows.indexOf(row) + 1) * 72 }),
        remove: () => { removed++; rows.splice(rows.indexOf(row), 1); }
      };
      rows.push(row); added++;
    };
    const layout = { isConnected: true, ownerDocument: { defaultView: win }, getBoundingClientRect: () => ({ width: 1000 }) } as unknown as HTMLElement;
    const main = { getBoundingClientRect: () => ({ right: 500 }) } as unknown as HTMLElement;
    const side = { getBoundingClientRect: () => ({ left: sideLeft, bottom: sideBottom }) } as unknown as HTMLElement;
    const entries = Array.from({ length: 7 }, (_, index) => ({ id: String(index) } as FinanceEntry));
    workspace.transactionRow(list as unknown as HTMLElement, entries[0], true);
    workspace.sizeRecentTransactions(layout, main, side, list as unknown as HTMLElement, entries); flush();
    assert.equal(rows.length, 3, "wide layout fits three complete recent rows");
    const settled = { added, removed };
    observer!.trigger(); flush();
    assert.deepEqual({ added, removed }, settled, "same geometry must not append then remove an overflowing row again");
    sideBottom = 308; observer!.trigger(); flush();
    assert.equal(rows.length, 4, "more vertical space reveals another complete row");
    sideBottom = 164; observer!.trigger(); flush();
    assert.equal(rows.length, 2, "less vertical space removes overflowing rows");
    sideLeft = 400; observer!.trigger(); flush();
    assert.equal(rows.length, 5, "narrow layout uses its five-row cap");
    observer!.trigger();
    assert.ok(frames.size > 0, "resize schedules one frame");
    workspace.detach();
    assert.equal(observer!.disconnected, true, "detach disconnects the observer");
    assert.equal(frames.size, 0, "detach cancels pending measurements");
    console.log("OK finance recent rows converge across repeated and changed geometry");
  } finally { globalThis.ResizeObserver = originalObserver; }
}
