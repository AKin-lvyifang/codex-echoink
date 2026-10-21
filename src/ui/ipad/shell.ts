import { ContainedShellSheet, shellElement, shellIconButton } from "../mobile/shell-controls";
import type { MobileShellOptions, MobileShellPage, MobileShellSheet } from "../mobile/shell-types";
import { MobileViewport } from "../mobile/viewport";

interface PageState {
  page: MobileShellPage;
  element: HTMLElement;
  content: HTMLElement;
  title: HTMLElement;
  back: HTMLButtonElement;
  scrollTop: number;
  scrollLeft: number;
  focus?: HTMLElement;
}

/** One iPad content pane. Its host owns the leaf, sidebar width and visibility. */
export class IPadShell {
  private readonly pages: HTMLElement;
  private readonly sheet: ContainedShellSheet;
  private readonly viewport: MobileViewport;
  private stack: PageState[] = [];
  private disposed = false;
  private navigating = false;
  private generation = 0;
  private visible = true;
  private rootBackVisible: boolean;

  constructor(private readonly root: HTMLElement, private readonly options: MobileShellOptions = {}) {
    this.rootBackVisible = !!options.onRootBack;
    root.classList.add("echoink-ipad", "echoink-ipad-shell");
    this.pages = shellElement(root.ownerDocument, "div", "echoink-ipad-pages");
    root.append(this.pages);
    this.sheet = new ContainedShellSheet(root, this.pages);
    this.viewport = new MobileViewport(root);
    root.addEventListener("keydown", this.onKeyDown);
  }

  get activePageId(): string | undefined { return this.stack.at(-1)?.page.id; }
  get hasBack(): boolean { return this.stack.length > 1; }
  hasPage(id: string): boolean { return this.stack.some(state => state.page.id === id); }
  async backTo(id: string): Promise<boolean> {
    if (!this.hasPage(id)) return false;
    while (this.activePageId !== id) if (!await this.back()) return false;
    return true;
  }

  /** Wide settings keeps its category list visible, so only deeper pages need back. */
  setRootBackVisible(visible: boolean): void {
    this.rootBackVisible = visible;
    const current = this.stack.at(-1);
    if (current) current.back.hidden = !this.hasBack && !visible;
  }

  /** Initial attachment/reset. Normal route changes use push, replace or back. */
  mount(page: MobileShellPage): void {
    if (this.disposed) return;
    if (this.stack.length === 1 && this.stack[0].page === page) return;
    let state: PageState;
    try {
      if (!this.canAttachPage(page)) throw new Error("页面内容仍在使用中，无法重复打开。");
      state = this.createPage(page);
    } catch (error) { this.reportError(error); return; }
    this.generation++;
    this.setNavigating(false);
    this.closeSheet();
    this.clearPages();
    this.stack.push(state);
    this.pages.append(state.element);
    this.showPage(state, false);
  }

  push(page: MobileShellPage): Promise<boolean> {
    return this.requestLeave(() => {
      if (!this.canAttachPage(page)) return false;
      const state = this.createPage(page);
      this.closeSheet();
      this.hidePage(this.stack.at(-1));
      this.stack.push(state);
      this.pages.append(state.element);
      this.showPage(state, true);
      return true;
    });
  }

  back(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.closeSheet()) return Promise.resolve(true);
    return this.requestLeave(() => {
      if (this.stack.length <= 1) {
        if (!this.options.onRootBack) return false;
        this.options.onRootBack();
        return true;
      }
      const previous = this.stack.pop();
      this.hidePage(previous);
      if (previous) this.destroyPage(previous);
      this.showPage(this.stack.at(-1)!, false);
      return true;
    });
  }

  replace(page: MobileShellPage): Promise<boolean> {
    return this.requestLeave(() => {
      const current = this.stack.at(-1);
      if (!this.canAttachPage(page, current)) return false;
      const state = this.createPage(page);
      this.closeSheet();
      this.hidePage(current);
      if (current) { this.stack.pop(); this.destroyPage(current); }
      this.stack.push(state);
      this.pages.append(state.element);
      this.showPage(state, true);
      return true;
    });
  }

  /** Settings uses the same guard while changing the owning category. */
  async requestLeave(transition: () => boolean | Promise<boolean>): Promise<boolean> {
    if (this.disposed || this.navigating) return false;
    const generation = this.generation;
    this.setNavigating(true);
    try {
      const allowed = await (this.stack.at(-1)?.page.canLeave?.() ?? true);
      if (this.disposed || generation !== this.generation || !allowed) return false;
      const result = await transition();
      return !this.disposed && generation === this.generation && result;
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.reportError(error);
      return false;
    } finally {
      if (!this.disposed && generation === this.generation) this.setNavigating(false);
    }
  }

  /** Hides a cached category pane without replacing its page/input nodes. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    if (!visible) {
      this.closeSheet();
      this.savePage(this.stack.at(-1));
      this.blurInside(this.root);
    }
    this.visible = visible;
    this.root.hidden = !visible;
    this.root.inert = !visible;
    this.root.setAttribute("aria-hidden", String(!visible));
    if (visible) this.restorePage(this.stack.at(-1));
  }

  openSheet(sheet: MobileShellSheet): void {
    if (this.disposed || !this.visible) return;
    try { this.sheet.open(sheet); } catch (error) { this.reportError(error); }
  }

  closeSheet(): boolean {
    try { return this.sheet.close(); }
    catch (error) { this.reportError(error); return true; }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.root.removeEventListener("keydown", this.onKeyDown);
    this.viewport.dispose();
    try { this.sheet.dispose(); } catch (error) { this.reportError(error); }
    this.clearPages();
    this.pages.remove();
    this.root.classList.remove("echoink-ipad", "echoink-ipad-shell");
    this.root.removeAttribute("aria-busy");
    this.root.removeAttribute("aria-hidden");
    this.root.inert = false;
    this.root.hidden = false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || !this.visible) return;
    event.preventDefault();
    event.stopPropagation();
    void this.back();
  };

  private createPage(page: MobileShellPage): PageState {
    const document = this.root.ownerDocument;
    const element = shellElement(document, "section", "echoink-ipad-page");
    element.dataset.pageId = page.id;
    element.setAttribute("aria-label", page.title);
    const header = shellElement(document, "header", "echoink-ipad-header");
    const back = shellIconButton(document, "返回", "chevron-left", () => { void this.back(); });
    back.classList.add("echoink-ipad-back");
    const headings = shellElement(document, "div", "echoink-ipad-headings");
    const title = shellElement(document, "h1", "echoink-ipad-title", page.title);
    title.tabIndex = -1;
    headings.append(title);
    if (page.subtitle) headings.append(shellElement(document, "div", "echoink-ipad-subtitle", page.subtitle));
    header.append(back, headings);
    if (page.actions) {
      const actions = shellElement(document, "div", "echoink-ipad-actions");
      actions.append(page.actions);
      header.append(actions);
    }
    if (page.header === "content") {
      element.classList.add("echoink-ipad-page-content-header");
      header.hidden = true;
    }
    const content = shellElement(document, "div", "echoink-ipad-content");
    content.append(page.content);
    element.append(header, content);
    if (page.footer) {
      const footer = shellElement(document, "footer", "echoink-ipad-footer");
      footer.append(page.footer);
      element.append(footer);
    }
    return { page, element, content, title, back, scrollTop: 0, scrollLeft: 0 };
  }

  private canAttachPage(page: MobileShellPage, replacing?: PageState): boolean {
    const slots = [page.content, page.footer, page.actions].filter((slot): slot is HTMLElement => !!slot);
    if (slots.some(slot => slot.contains(this.root) || slot.contains(this.pages)) ||
      slots.some((slot, index) => slots.some((other, otherIndex) => index !== otherIndex && slot.contains(other)))) return false;
    return !this.stack.some(state => (state !== replacing && state.page.id === page.id) ||
      [state.page.content, state.page.footer, state.page.actions].some(existing => existing &&
        slots.some(slot => existing === slot || existing.contains(slot) || slot.contains(existing))));
  }

  private showPage(state: PageState, animate: boolean): void {
    state.element.hidden = false;
    state.element.inert = false;
    state.element.removeAttribute("aria-hidden");
    state.back.hidden = !this.hasBack && !this.rootBackVisible;
    state.back.disabled = this.navigating;
    state.element.classList.toggle("echoink-ipad-page-push", animate);
    if (this.visible) this.restorePage(state);
  }

  private hidePage(state?: PageState): void {
    if (!state) return;
    this.savePage(state);
    this.blurInside(state.element);
    state.element.hidden = true;
    state.element.inert = true;
    state.element.setAttribute("aria-hidden", "true");
    state.element.classList.remove("echoink-ipad-page-push");
  }

  private savePage(state?: PageState): void {
    if (!state) return;
    state.scrollTop = state.content.scrollTop;
    state.scrollLeft = state.content.scrollLeft;
    const active = this.root.ownerDocument.activeElement;
    if (active && state.element.contains(active) && "focus" in active) state.focus = active as HTMLElement;
  }

  private restorePage(state?: PageState): void {
    if (!state) return;
    state.content.scrollTop = state.scrollTop;
    state.content.scrollLeft = state.scrollLeft;
    const focus = state.focus?.isConnected ? state.focus : state.title;
    if (!focus.closest("[hidden], [inert]")) focus.focus({ preventScroll: true });
  }

  private blurInside(element: HTMLElement): void {
    const active = this.root.ownerDocument.activeElement;
    if (active && element.contains(active) && "blur" in active) (active as HTMLElement).blur();
  }

  private setNavigating(navigating: boolean): void {
    this.navigating = navigating;
    this.root.setAttribute("aria-busy", String(navigating));
    for (const state of this.stack) state.back.disabled = navigating;
  }

  private destroyPage(state: PageState): void {
    state.element.remove();
    try { state.page.dispose?.(); } catch (error) { this.reportError(error); }
  }

  private clearPages(): void {
    for (const state of this.stack) this.destroyPage(state);
    this.stack = [];
  }

  private reportError(error: unknown): void { this.options.onError?.(error); }
}
