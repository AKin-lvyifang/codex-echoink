import { ContainedShellSheet, shellElement, shellIconButton } from "../mobile/shell-controls";
import type { MobileShellOptions, MobileShellPage, MobileShellSheet } from "../mobile/shell-types";
import { MobileViewport } from "../mobile/viewport";

interface IPhonePageEntry {
  page: MobileShellPage;
  panel: HTMLElement;
  scroll: HTMLElement;
  backButton?: HTMLButtonElement;
  focus?: HTMLElement;
  scrollTop: number;
  scrollLeft: number;
}

/** An iPhone-only page stack. Slots remain mounted until their page is removed. */
export class IPhoneShell {
  private readonly pages: HTMLElement;
  private readonly sheet: ContainedShellSheet;
  private readonly viewport: MobileViewport;
  private readonly addedRootClass: boolean;
  private entries: IPhonePageEntry[] = [];
  private pending?: symbol;
  private disposed = false;

  constructor(private readonly root: HTMLElement, private readonly options: MobileShellOptions = {}) {
    this.addedRootClass = !root.classList.contains("echoink-iphone");
    root.classList.add("echoink-iphone");
    this.pages = shellElement(root.ownerDocument, "div", "eis-pages");
    root.append(this.pages);
    this.sheet = new ContainedShellSheet(root, this.pages);
    this.viewport = new MobileViewport(root);
    root.addEventListener("keydown", this.onKeyDown);
  }

  get activePageId(): string | undefined {
    return this.current?.page.id;
  }
  hasPage(id: string): boolean { return this.entries.some(entry => entry.page.id === id); }
  async backTo(id: string): Promise<boolean> {
    if (!this.hasPage(id)) return false;
    while (this.activePageId !== id) if (!await this.back()) return false;
    return true;
  }

  mount(initialPage: MobileShellPage): void {
    if (this.disposed) return;
    try {
      const entry = this.createEntry(initialPage, !!this.options.onRootBack, undefined, true);
      this.pending = undefined;
      this.closeSheet();
      if (this.disposed) return;
      const oldEntries = this.entries;
      this.entries = [entry];
      for (const old of oldEntries) this.release(old);
      if (this.disposed || this.current !== entry) return;
      this.pages.append(entry.panel);
      this.activate(entry);
    } catch (error) {
      this.reportError(error);
    }
  }

  push(page: MobileShellPage): Promise<boolean> {
    return this.navigate(() => {
      const entry = this.createEntry(page, true);
      this.hide(this.current!);
      this.entries.push(entry);
      this.pages.append(entry.panel);
      this.activate(entry, "forward");
    });
  }

  async back(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.closeSheet()) return true;
    if (this.entries.length <= 1 && !this.options.onRootBack) return false;
    return this.navigate(() => {
      if (this.entries.length === 1) {
        this.options.onRootBack?.();
        return;
      }
      const leaving = this.entries.pop()!;
      const target = this.current!;
      this.release(leaving);
      if (!this.disposed && this.current === target) this.activate(target, "back");
    });
  }

  replace(page: MobileShellPage): Promise<boolean> {
    return this.navigate(() => {
      const leaving = this.current!;
      const entry = this.createEntry(page, this.entries.length > 1 || !!this.options.onRootBack, leaving);
      this.entries[this.entries.length - 1] = entry;
      this.pages.append(entry.panel);
      this.release(leaving);
      if (!this.disposed && this.current === entry) this.activate(entry, "forward");
    });
  }

  openSheet(config: MobileShellSheet): void {
    if (this.disposed || !this.current) return;
    try {
      this.sheet.open(config);
    } catch (error) {
      this.reportError(error);
    }
  }

  closeSheet(): boolean {
    const wasOpen = this.sheet.isOpen;
    if (this.disposed || !wasOpen) return false;
    try {
      return this.sheet.close();
    } catch (error) {
      this.reportError(error);
      return wasOpen;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.root.removeEventListener("keydown", this.onKeyDown);
    try {
      this.sheet.dispose();
    } catch (error) {
      this.reportError(error);
    }
    this.viewport.dispose();
    const oldEntries = this.entries;
    this.entries = [];
    for (const entry of oldEntries) this.release(entry);
    this.pages.remove();
    if (this.addedRootClass) this.root.classList.remove("echoink-iphone");
  }

  private get current(): IPhonePageEntry | undefined {
    return this.entries.at(-1);
  }

  private async navigate(change: () => void): Promise<boolean> {
    const source = this.current;
    if (this.disposed || this.pending || !source) return false;
    const token = Symbol("iphone-navigation");
    this.pending = token;
    source.panel.setAttribute("aria-busy", "true");
    if (source.backButton) source.backButton.disabled = true;
    try {
      const allowed = source.page.canLeave ? await source.page.canLeave() : true;
      if (!allowed || !this.isCurrentNavigation(token, source)) return false;
      this.closeSheet();
      if (!this.isCurrentNavigation(token, source)) return false;
      change();
      return true;
    } catch (error) {
      if (!this.disposed && this.pending === token) this.reportError(error);
      return false;
    } finally {
      if (!this.disposed && this.pending === token) {
        this.pending = undefined;
        source.panel.removeAttribute("aria-busy");
        if (source.backButton) source.backButton.disabled = false;
      }
    }
  }

  private isCurrentNavigation(token: symbol, source: IPhonePageEntry): boolean {
    return !this.disposed && this.pending === token && this.current === source;
  }

  private createEntry(page: MobileShellPage, showBack: boolean, replacing?: IPhonePageEntry, remount = false): IPhonePageEntry {
    if (!remount && this.entries.some(entry => entry !== replacing && entry.page.id === page.id)) {
      throw new Error("该页面已经打开");
    }
    // A node cannot belong to two retained pages, even when their ids differ.
    const slots = [page.content, page.footer, page.actions].filter((slot): slot is HTMLElement => !!slot);
    if (slots.some(slot => this.entries.some(entry => entry.panel.contains(slot) || slot.contains(entry.panel))) ||
      slots.some(slot => slot.contains(this.root) || slot.contains(this.pages)) ||
      slots.some((slot, index) => slots.some((other, otherIndex) => index !== otherIndex && slot.contains(other)))) {
      throw new Error("页面内容已在使用中");
    }
    const document = this.root.ownerDocument;
    const panel = shellElement(document, "section", "eis-page");
    panel.dataset.pageId = page.id;
    panel.setAttribute("aria-label", page.title);
    panel.tabIndex = -1;
    const scroll = shellElement(document, "div", "eis-scroll scroll");
    const content = shellElement(document, "div", "eis-content");
    let backButton: HTMLButtonElement | undefined;
    if (page.header !== "content") {
      const header = shellElement(document, "header", "eis-header");
      if (showBack) {
        backButton = shellIconButton(document, "返回", "chevron-left", () => { void this.back(); });
        header.append(backButton);
      }
      const heading = shellElement(document, "div", "eis-heading");
      heading.append(shellElement(document, "h1", "eis-title", page.title));
      if (page.subtitle) heading.append(shellElement(document, "div", "eis-subtitle", page.subtitle));
      header.append(heading);
      if (page.actions) {
        const actions = shellElement(document, "div", "eis-actions");
        actions.append(page.actions);
        header.append(actions);
      }
      panel.append(header);
    }
    content.append(page.content);
    scroll.append(content);
    panel.append(scroll);
    if (page.footer) {
      const footer = shellElement(document, "div", "eis-footer");
      footer.append(page.footer);
      panel.append(footer);
    }
    panel.addEventListener("animationend", event => {
      if (event.target === panel) panel.classList.remove("eis-forward", "eis-back");
    });
    return { page, panel, scroll, backButton, scrollTop: 0, scrollLeft: 0 };
  }

  private hide(entry: IPhonePageEntry): void {
    const active = this.root.ownerDocument.activeElement;
    if (active && entry.panel.contains(active) && "focus" in active) entry.focus = active as HTMLElement;
    entry.scrollTop = entry.scroll.scrollTop;
    entry.scrollLeft = entry.scroll.scrollLeft;
    entry.panel.classList.remove("eis-forward", "eis-back");
    entry.panel.hidden = true;
    entry.panel.inert = true;
    entry.panel.setAttribute("aria-hidden", "true");
  }

  private activate(entry: IPhonePageEntry, motion?: "forward" | "back"): void {
    entry.panel.hidden = false;
    entry.panel.inert = false;
    entry.panel.removeAttribute("aria-hidden");
    entry.panel.classList.remove("eis-forward", "eis-back");
    if (motion) entry.panel.classList.add(`eis-${motion}`);
    entry.scroll.scrollTop = entry.scrollTop;
    entry.scroll.scrollLeft = entry.scrollLeft;
    const focus = entry.focus;
    if (focus?.isConnected && entry.panel.contains(focus) && !focus.matches(":disabled") && !focus.closest("[hidden], [inert]")) {
      focus.focus({ preventScroll: true });
    } else {
      entry.panel.focus({ preventScroll: true });
    }
  }

  private release(entry: IPhonePageEntry): void {
    entry.panel.remove();
    try {
      entry.page.dispose?.();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error presentation belongs to the caller; it must not break navigation.
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.sheet.isOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.closeSheet();
    }
  };
}
