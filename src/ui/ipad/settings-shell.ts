import { setIcon } from "obsidian";
import { createStaticSettingsTabIcon } from "../../settings/animated-settings-tab-icon";
import { ContainedShellSheet, shellElement, shellIconButton } from "../mobile/shell-controls";
import type { MobileShellCategory, MobileShellOptions, MobileShellPage, MobileShellSheet } from "../mobile/shell-types";
import { MobileViewport } from "../mobile/viewport";
import { IPadShell } from "./shell";

interface CategoryPane { root: HTMLElement; shell: IPadShell; }

/** Central settings content only; the workspace adapter owns tab reuse/closure. */
export class IPadSettingsShell {
  private readonly layout: HTMLElement;
  private readonly navigation: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly error: HTMLElement;
  private readonly categoryButtons = new Map<string, HTMLButtonElement>();
  private readonly panes = new Map<string, CategoryPane>();
  private readonly viewport: MobileViewport;
  private readonly sheet: ContainedShellSheet;
  private readonly window: Window;
  private observer?: ResizeObserver;
  private currentCategory?: string;
  private wide = false;
  private detailShown = false;
  private navigating = false;
  private disposed = false;
  private mounted = false;
  private defaultAttempted = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly categories: readonly MobileShellCategory[],
    private readonly options: MobileShellOptions = {}
  ) {
    const document = root.ownerDocument;
    this.window = document.defaultView!;
    root.classList.add("echoink-ipad", "echoink-ipad-settings");
    this.error = shellElement(document, "div", "echoink-ipad-settings-error");
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.layout = shellElement(document, "div", "echoink-ipad-settings-layout");
    this.navigation = shellElement(document, "nav", "echoink-ipad-settings-categories");
    this.navigation.setAttribute("aria-label", "设置分类");
    const header = shellElement(document, "header", "echoink-ipad-settings-heading");
    if (options.onRootBack) header.append(shellIconButton(document, "返回", "chevron-left", () => { void this.back(); }));
    header.append(shellElement(document, "h1", "echoink-ipad-settings-title", "EchoInk 设置"));
    this.navigation.append(header);
    for (const category of categories) {
      const button = shellElement(document, "button", "echoink-ipad-settings-category");
      button.type = "button";
      button.dataset.categoryId = category.id;
      const icon = shellElement(document, "span", "echoink-ipad-settings-category-icon");
      icon.setAttribute("aria-hidden", "true");
      if (category.icon === "blocks") icon.append(createStaticSettingsTabIcon(document, "blocks"));
      else setIcon(icon, category.icon);
      button.append(icon, shellElement(document, "span", "echoink-ipad-settings-category-label", category.label));
      button.addEventListener("click", () => { void this.selectCategory(category.id); });
      this.categoryButtons.set(category.id, button);
      this.navigation.append(button);
    }
    this.detail = shellElement(document, "div", "echoink-ipad-settings-main");
    this.layout.append(this.navigation, this.detail);
    root.append(this.error, this.layout);
    this.sheet = new ContainedShellSheet(root, this.layout);
    this.viewport = new MobileViewport(root);
    const Observer = document.defaultView?.ResizeObserver;
    if (Observer) { this.observer = new Observer(this.onResize); this.observer.observe(root); }
    this.window.addEventListener("resize", this.onResize);
    root.addEventListener("keydown", this.onKeyDown);
    this.onResize();
  }

  get activeCategoryId(): string | undefined { return this.currentCategory; }
  get activePageShell(): IPadShell | undefined { return this.activePane?.shell; }
  get activePageId(): string | undefined {
    return this.wide || this.detailShown ? this.activePane?.shell.activePageId : "ipad-settings-categories";
  }

  async mount(initialCategoryId?: string): Promise<boolean> {
    if (this.disposed) return false;
    this.onResize();
    this.mounted = true;
    if (initialCategoryId !== undefined) { this.defaultAttempted = true; return this.selectCategory(initialCategoryId); }
    if (this.currentCategory) return true;
    if (this.wide && this.categories[0] && !this.defaultAttempted) {
      this.defaultAttempted = true;
      return this.selectCategory(this.categories[0].id);
    }
    this.applyLayout();
    return true;
  }

  selectCategory(id: string): Promise<boolean> {
    const category = this.categories.find(item => item.id === id);
    if (!category) return Promise.resolve(false);
    return this.navigate(async () => {
      if (id === this.currentCategory) { this.detailShown = true; this.applyLayout(); return true; }
      const activate = async (): Promise<boolean> => {
        let pane = this.panes.get(id);
        if (!pane) {
          const page = await category.createPage();
          if (this.disposed) { page.dispose?.(); return false; }
          const paneRoot = shellElement(this.root.ownerDocument, "div", "echoink-ipad-settings-detail");
          const shell = new IPadShell(paneRoot, {
            onError: error => this.reportError(error),
            onRootBack: () => this.onDetailRootBack(id)
          });
          pane = { root: paneRoot, shell };
          shell.setVisible(false);
          this.detail.append(paneRoot);
          shell.mount(page);
          this.panes.set(id, pane);
        }
        if (this.disposed) return false;
        this.closeSheet();
        this.currentCategory = id;
        this.detailShown = true;
        this.applyLayout();
        return true;
      };
      return this.activePane ? this.activePane.shell.requestLeave(activate) : activate();
    });
  }

  push(page: MobileShellPage): Promise<boolean> {
    return this.navigate(() => this.activePane?.shell.push(page) ?? false);
  }

  back(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.closeSheet()) return Promise.resolve(true);
    return this.navigate(() => {
      const pane = this.activePane;
      if (pane && (this.wide || this.detailShown)) {
        if (pane.shell.hasBack) return pane.shell.back();
        return pane.shell.requestLeave(() => {
          if (!this.wide) { this.showCategories(); return true; }
          if (!this.options.onRootBack) return false;
          this.options.onRootBack();
          return true;
        });
      }
      if (!this.options.onRootBack) return false;
      this.options.onRootBack();
      return true;
    });
  }

  openSheet(sheet: MobileShellSheet): void {
    if (this.disposed) return;
    if (this.activePane && (this.wide || this.detailShown)) { this.activePane.shell.openSheet(sheet); return; }
    try { this.sheet.open(sheet); } catch (error) { this.reportError(error); }
  }

  closeSheet(): boolean {
    try { return this.sheet.close() || (this.activePane?.shell.closeSheet() ?? false); }
    catch (error) { this.reportError(error); return true; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.window.removeEventListener("resize", this.onResize);
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.viewport.dispose();
    try { this.sheet.dispose(); } catch (error) { this.options.onError?.(error); }
    for (const pane of this.panes.values()) { pane.shell.dispose(); pane.root.remove(); }
    this.panes.clear();
    this.categoryButtons.clear();
    this.layout.remove();
    this.error.remove();
    this.currentCategory = undefined;
    this.root.classList.remove("echoink-ipad", "echoink-ipad-settings", "echoink-ipad-settings-wide");
    this.root.removeAttribute("aria-busy");
  }

  private get activePane(): CategoryPane | undefined { return this.currentCategory ? this.panes.get(this.currentCategory) : undefined; }

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const wide = this.root.getBoundingClientRect().width >= 760;
    if (this.wide && !wide && this.currentCategory) this.detailShown = true;
    this.wide = wide;
    this.applyLayout();
    if (wide && this.mounted && !this.currentCategory && !this.defaultAttempted && this.categories[0]) {
      this.defaultAttempted = true;
      void this.selectCategory(this.categories[0].id);
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || !this.navigation.contains(event.target as Node)) return;
    event.preventDefault(); event.stopPropagation();
    void this.back();
  };

  private applyLayout(): void {
    this.root.classList.toggle("echoink-ipad-settings-wide", this.wide);
    for (const [id, pane] of this.panes) {
      if (id !== this.currentCategory || (!this.wide && !this.detailShown)) pane.shell.setVisible(false);
    }
    this.setHidden(this.navigation, !this.wide && this.detailShown);
    this.setHidden(this.detail, !this.wide && !this.detailShown);
    for (const [id, pane] of this.panes) {
      pane.shell.setRootBackVisible(!this.wide || !!this.options.onRootBack);
      pane.shell.setVisible(id === this.currentCategory && (this.wide || this.detailShown));
    }
    for (const [id, button] of this.categoryButtons) {
      if (id === this.currentCategory) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  private showCategories(): void {
    this.detailShown = false;
    this.applyLayout();
    const button = this.currentCategory ? this.categoryButtons.get(this.currentCategory) : Array.from(this.categoryButtons.values())[0];
    button?.focus({ preventScroll: true });
  }

  private onDetailRootBack(id: string): void {
    if (this.disposed || this.currentCategory !== id) return;
    if (!this.wide) this.showCategories();
    else this.options.onRootBack?.();
  }

  private setHidden(element: HTMLElement, hidden: boolean): void {
    const active = this.root.ownerDocument.activeElement;
    if (hidden && active && element.contains(active) && "blur" in active) (active as HTMLElement).blur();
    element.hidden = hidden;
    element.inert = hidden;
    element.setAttribute("aria-hidden", String(hidden));
  }

  private async navigate(action: () => boolean | Promise<boolean>): Promise<boolean> {
    if (this.disposed || this.navigating) return false;
    this.navigating = true;
    this.error.hidden = true;
    this.error.textContent = "";
    this.root.setAttribute("aria-busy", "true");
    for (const button of this.categoryButtons.values()) button.disabled = true;
    try { const result = await action(); return !this.disposed && result; }
    catch (error) { if (!this.disposed) this.reportError(error); return false; }
    finally {
      this.navigating = false;
      if (!this.disposed) {
        this.root.setAttribute("aria-busy", "false");
        for (const button of this.categoryButtons.values()) button.disabled = false;
      }
    }
  }

  private reportError(error: unknown): void {
    if (!this.disposed) {
      this.error.textContent = error instanceof Error ? error.message : "无法打开设置，请重试。";
      this.error.hidden = false;
    }
    this.options.onError?.(error);
  }
}
