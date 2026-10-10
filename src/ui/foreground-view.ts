import type { ItemView } from "obsidian";

/** A visible split may refresh even when another leaf is active. No polling. */
export class ForegroundView {
  private ownerDocument: Document | null = null;
  private active = false;
  private disposed = false;
  private readonly events = () => this.check();

  constructor(private readonly view: ItemView, private readonly onChange: (active: boolean) => void) {
    view.registerEvent(view.app.workspace.on("active-leaf-change", this.events));
    view.registerEvent(view.app.workspace.on("layout-change", this.events));
    view.register(() => this.dispose());
    this.bindDocument();
    this.active = this.isActive();
  }

  isActive(): boolean {
    const element = this.view.containerEl;
    const doc = element.ownerDocument;
    return !this.disposed && element.isConnected && !doc.hidden && doc.hasFocus() && element.getClientRects().length > 0;
  }

  private bindDocument(): void {
    const doc = this.view.containerEl.ownerDocument;
    if (doc === this.ownerDocument) return;
    this.unbindDocument();
    this.ownerDocument = doc;
    doc.addEventListener("visibilitychange", this.events);
    doc.defaultView?.addEventListener("focus", this.events);
    doc.defaultView?.addEventListener("blur", this.events);
  }

  private unbindDocument(): void {
    this.ownerDocument?.removeEventListener("visibilitychange", this.events);
    this.ownerDocument?.defaultView?.removeEventListener("focus", this.events);
    this.ownerDocument?.defaultView?.removeEventListener("blur", this.events);
    this.ownerDocument = null;
  }

  private check(): void {
    if (this.disposed) return;
    this.bindDocument();
    const active = this.isActive();
    if (active === this.active) return;
    this.active = active;
    this.onChange(active);
  }

  dispose(): void { this.disposed = true; this.unbindDocument(); }
}
