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
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(this.schedule); this.observer.observe(root); }
    this.update();
  }
  private schedule = () => { if (!this.frame) this.frame = this.win.requestAnimationFrame(() => { this.frame = 0; this.update(); }); };
  private update() {
    if (this.spacingSource) this.root.style.setProperty("--view-bottom-spacing", this.win.getComputedStyle(this.spacingSource).getPropertyValue("--view-bottom-spacing") || "0px");
    const viewport = this.win.visualViewport;
    const bottom = viewport && viewport.scale === 1 ? viewport.offsetTop + viewport.height : this.win.innerHeight;
    const bounds = this.root.getBoundingClientRect();
    const probe = this.root.createDiv({ cls: "echoink-mobile-bottom-probe" });
    const required = Number.parseFloat(this.win.getComputedStyle(probe).height) || 0; probe.remove();
    const external = Math.max(0, this.win.innerHeight - bounds.bottom);
    const occlusion = Math.max(0, Math.ceil(bounds.bottom - bottom));
    this.root.style.setProperty("--em-viewport-occlusion", `${occlusion}px`);
    this.root.style.setProperty("--em-bottom-compensation", `${Math.max(0, Math.ceil(required - external), occlusion)}px`);
  }
  dispose() {
    this.win.cancelAnimationFrame(this.frame); this.observer?.disconnect();
    this.win.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("resize", this.schedule);
    this.win.visualViewport?.removeEventListener("scroll", this.schedule);
    this.root.style.removeProperty("--em-viewport-occlusion");
    this.root.style.removeProperty("--em-bottom-compensation");
    if (this.spacingSource) this.root.style.removeProperty("--view-bottom-spacing");
  }
}
