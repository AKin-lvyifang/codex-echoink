const KEYBOARD_EVENTS = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"] as const;
const NAVBAR_GAP = 8;

/** Adds only bottom space not already supplied by the host layout. */
export class MobileViewport {
  private frame = 0;
  private observer?: ResizeObserver;
  private win: Window;
  constructor(private root: HTMLElement, private spacingSource?: HTMLElement) {
    this.win = root.ownerDocument.defaultView!;
    this.win.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("scroll", this.schedule);
    for (const name of KEYBOARD_EVENTS) this.win.addEventListener(name, this.schedule);
    // The floating navbar slides with a CSS transition; re-measure once it settles.
    root.ownerDocument.addEventListener("transitionend", this.onTransition, true);
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(this.schedule); this.observer.observe(root); }
    this.update();
  }
  private onTransition = (event: Event) => { if ((event.target as Element | null)?.classList?.contains("mobile-navbar")) this.schedule(); };
  private schedule = () => { if (!this.frame) this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.update(); }); };
  private update() {
    if (this.spacingSource) this.root.style.setProperty("--view-bottom-spacing", this.win.getComputedStyle(this.spacingSource).getPropertyValue("--view-bottom-spacing") || "0px");
    const viewport = this.win.visualViewport;
    // Obsidian mobile publishes --keyboard-height and already shrinks .app-container by it.
    // Subtracting the visual viewport again would reserve the keyboard twice and squeeze the page empty.
    const hostKeyboard = Number.parseFloat(this.win.getComputedStyle(this.root.ownerDocument.documentElement).getPropertyValue("--keyboard-height")) || 0;
    let bottom = hostKeyboard > 0 ? Number.POSITIVE_INFINITY : viewport && viewport.scale === 1 ? viewport.offsetTop + viewport.height : this.win.innerHeight;
    const bounds = this.root.getBoundingClientRect();
    const navbarTop = this.floatingNavbarTop(bounds);
    if (navbarTop !== undefined) bottom = Math.min(bottom, navbarTop - NAVBAR_GAP);
    const probe = this.root.createDiv({ cls: "echoink-mobile-bottom-probe" });
    const required = Number.parseFloat(this.win.getComputedStyle(probe).height) || 0; probe.remove();
    const external = Math.max(0, this.win.innerHeight - bounds.bottom);
    const occlusion = Math.max(0, Math.ceil(bounds.bottom - bottom));
    this.root.style.setProperty("--em-viewport-occlusion", `${occlusion}px`);
    this.root.style.setProperty("--em-bottom-compensation", `${Math.max(0, Math.ceil(required - external), occlusion)}px`);
  }
  /** Top edge of Obsidian's floating navbar when it is visibly drawn over this root. */
  private floatingNavbarTop(bounds: DOMRect): number | undefined {
    const doc = this.root.ownerDocument;
    if (doc.body?.classList.contains("is-hidden-nav")) return undefined;
    const navbar = doc.querySelector<HTMLElement>(".mobile-navbar");
    if (!navbar || navbar.contains(this.root)) return undefined;
    const rect = navbar.getBoundingClientRect(), style = this.win.getComputedStyle(navbar);
    if (!rect.height || style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") < .05) return undefined;
    if (rect.top >= bounds.bottom || rect.bottom <= bounds.top || rect.right <= bounds.left || rect.left >= bounds.right) return undefined;
    // A modal or sheet stacked above the navbar hides it; only reserve space when the navbar is actually on top.
    const hit = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : navbar;
    return hit && navbar.contains(hit) ? rect.top : undefined;
  }
  dispose() {
    this.win.cancelAnimationFrame(this.frame); this.observer?.disconnect();
    for (const name of KEYBOARD_EVENTS) this.win.removeEventListener(name, this.schedule);
    this.root.ownerDocument.removeEventListener("transitionend", this.onTransition, true);
    this.win.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("scroll", this.schedule);
    this.root.style.removeProperty("--em-viewport-occlusion");
    this.root.style.removeProperty("--em-bottom-compensation");
    if (this.spacingSource) this.root.style.removeProperty("--view-bottom-spacing");
  }
}
