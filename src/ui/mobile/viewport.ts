/** Supplements the host's bottom spacing only when the visible viewport clips it. */
export class MobileViewport {
  private frame = 0;
  private observer?: ResizeObserver;
  private win: Window;
  constructor(private root: HTMLElement, private spacingSource?: HTMLElement) {
    this.win = root.ownerDocument.defaultView!;
    this.win.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("resize", this.schedule);
    this.win.visualViewport?.addEventListener("scroll", this.schedule);
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(this.schedule); this.observer.observe(root); }
    this.update();
  }
  private schedule = () => { if (!this.frame) this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.update(); }); };
  private update() {
    if (this.spacingSource) this.root.style.setProperty("--view-bottom-spacing", this.win.getComputedStyle(this.spacingSource).getPropertyValue("--view-bottom-spacing") || "0px");
    const viewport = this.win.visualViewport;
    const bottom = viewport && viewport.scale === 1 ? viewport.offsetTop + viewport.height : this.win.innerHeight;
    this.root.style.setProperty("--em-viewport-occlusion", `${Math.max(0, Math.ceil(this.root.getBoundingClientRect().bottom - bottom))}px`);
  }
  dispose() {
    this.win.cancelAnimationFrame(this.frame); this.observer?.disconnect();
    this.win.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("scroll", this.schedule);
    this.root.style.removeProperty("--em-viewport-occlusion");
    if (this.spacingSource) this.root.style.removeProperty("--view-bottom-spacing");
  }
}
