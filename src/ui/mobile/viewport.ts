import { bindMobilePressFeedback } from "./press-feedback";

const KEYBOARD_EVENTS = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"] as const;
const NAVBAR_GAP = 8;

/** Adds only bottom space not already supplied by the host layout. */
export class MobileViewport {
  private frame = 0;
  private observer?: ResizeObserver;
  private mutations: MutationObserver;
  private navbarTransitions = new Set<string>();
  private win: Window;
  private releasePress: () => void;
  constructor(private root: HTMLElement, private spacingSource?: HTMLElement) {
    this.win = root.ownerDocument.defaultView!;
    this.releasePress = bindMobilePressFeedback(root);
    this.win.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("scroll", this.schedule);
    for (const name of KEYBOARD_EVENTS) this.win.addEventListener(name, this.schedule);
    // Host navigation may attach/detach without resizing the pane or animating.
    this.mutations = new root.ownerDocument.defaultView!.MutationObserver(this.onHostMutation);
    this.mutations.observe(root.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class", "style"], childList: true, subtree: true });
    // Measure throughout the slide as well as its endpoints, keeping the input clear.
    root.ownerDocument.addEventListener("transitionrun", this.onTransition, true);
    root.ownerDocument.addEventListener("transitionend", this.onTransition, true);
    root.ownerDocument.addEventListener("transitioncancel", this.onTransition, true);
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(this.schedule); this.observer.observe(root); }
    this.update();
  }
  private onHostMutation = (records: MutationRecord[]) => {
    const doc = this.root.ownerDocument;
    const changed = records.some(record => {
      if (record.type === "attributes") return record.target === doc.body || record.target === doc.documentElement || (record.target as Element).classList.contains("mobile-navbar");
      return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node.nodeType === 1 &&
        ((node as Element).matches(".mobile-navbar") || (node as Element).querySelector(".mobile-navbar")));
    });
    if (changed) this.schedule();
  };
  private onTransition = (event: Event) => {
    if (!(event.target as Element | null)?.classList?.contains("mobile-navbar")) return;
    const property = (event as TransitionEvent).propertyName;
    if (event.type === "transitionrun") this.navbarTransitions.add(property);
    else this.navbarTransitions.delete(property);
    this.schedule();
  };
  private schedule = () => { if (!this.frame) this.frame = this.win.requestAnimationFrame(() => {
    this.frame = 0; this.update();
    if (this.navbarTransitions.size && this.root.ownerDocument.querySelector(".mobile-navbar")) this.schedule();
    else this.navbarTransitions.clear();
  }); };
  private update() {
    if (this.spacingSource) this.root.style.setProperty("--view-bottom-spacing", this.win.getComputedStyle(this.spacingSource).getPropertyValue("--view-bottom-spacing") || "0px");
    const viewport = this.win.visualViewport;
    // Obsidian already shrinks .app-container by --keyboard-height. Reuse that
    // boundary: central/pinned panes need no extra inset, but fixed iPad drawers
    // can still extend below it. Never subtract the keyboard a second time.
    const hostKeyboard = Number.parseFloat(this.win.getComputedStyle(this.root.ownerDocument.documentElement).getPropertyValue("--keyboard-height")) || 0;
    const hostBottom = this.root.ownerDocument.querySelector(".app-container")?.getBoundingClientRect().bottom;
    let bottom = hostKeyboard > 0 ? hostBottom ?? Number.POSITIVE_INFINITY : viewport && viewport.scale === 1 ? viewport.offsetTop + viewport.height : this.win.innerHeight;
    const bounds = this.root.getBoundingClientRect();
    const navbarTop = this.floatingNavbarTop(bounds);
    if (navbarTop !== undefined) bottom = Math.min(bottom, navbarTop - NAVBAR_GAP);
    const probe = this.root.createDiv({ cls: "echoink-mobile-bottom-probe" });
    // On phones the host includes the floating navbar in --view-bottom-spacing,
    // even after hiding/detaching it. Its actual geometry is already counted above.
    // Keep only the safe area here; the keyboard's host layout already includes it.
    if (this.root.ownerDocument.body.matches(".is-phone.is-floating-nav, .is-phone.auto-full-screen")) {
      probe.style.height = hostKeyboard > 0 ? "0px" : "max(var(--safe-area-inset-bottom, 0px), env(safe-area-inset-bottom, 0px))";
    }
    const required = Number.parseFloat(this.win.getComputedStyle(probe).height) || 0; probe.remove();
    const external = Math.max(0, this.win.innerHeight - bounds.bottom);
    const occlusion = Math.max(0, Math.ceil(bounds.bottom - bottom));
    this.root.style.setProperty("--em-viewport-occlusion", `${occlusion}px`);
    this.root.style.setProperty("--em-bottom-compensation", `${Math.max(0, Math.ceil(required - external), occlusion)}px`);
  }
  /** Top edge of Obsidian's floating navbar when it is visibly drawn over this root. */
  private floatingNavbarTop(bounds: DOMRect): number | undefined {
    const doc = this.root.ownerDocument;
    // is-hidden-nav starts a transition; the bar can still cover the input until it leaves.
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
    this.releasePress();
    this.win.cancelAnimationFrame(this.frame); this.observer?.disconnect(); this.mutations.disconnect(); this.navbarTransitions.clear();
    for (const name of KEYBOARD_EVENTS) this.win.removeEventListener(name, this.schedule);
    this.root.ownerDocument.removeEventListener("transitionrun", this.onTransition, true);
    this.root.ownerDocument.removeEventListener("transitionend", this.onTransition, true);
    this.root.ownerDocument.removeEventListener("transitioncancel", this.onTransition, true);
    this.win.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("scroll", this.schedule);
    this.root.style.removeProperty("--em-viewport-occlusion");
    this.root.style.removeProperty("--em-bottom-compensation");
    if (this.spacingSource) this.root.style.removeProperty("--view-bottom-spacing");
  }
}
