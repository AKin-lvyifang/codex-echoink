import { composerReadingLeadingSpace, composerReadingScrollTop, composerReadingSpace, conversationScrollProgress, CONVERSATION_SCROLL_DURATION_MS, MessageScrollFollowController } from "../conversation-scroll";
import { ownedEl } from "../owned-dom";
import { mobileScrollFrame, type MobileScrollFrame } from "./scroll-frame";
import type { MobileRuntime, MobileSubmissionScrollTarget } from "../../mobile/runtime";

type ScrollRuntime = Pick<MobileRuntime, "composerScrollTarget" | "pauseComposerScroll" | "clearComposerScroll">;

/** Runtime owns the turn; native gestures own reading. All geometry enters one frame. */
export class MobileSubmissionScroller {
  private readonly follow = new MessageScrollFollowController();
  private readonly frame: MobileScrollFrame;
  private sequence?: number;
  private spacer?: HTMLElement;
  private leadingSpacer?: HTMLElement;
  private scroller?: HTMLElement;
  private observer?: ResizeObserver;
  private rowObserver?: ResizeObserver;
  private observedRows: Element[] = [];
  private outputHeight = 0;
  private followingOutput = false;
  private animation?: { top: number; started: number };
  private touching = false;
  private userIntent = false;
  private readingLock = false;
  private automaticTop?: number;
  private previousHeight?: number;
  private previousMaximum?: number;
  private acknowledgedPause = false;
  private nativeScroll = false;
  private resumeAtBottom = false;
  private outputFollow = false;
  private genericInitialized = false;
  private disposed = false;
  private readonly win: Window;
  constructor(private runtime: ScrollRuntime, private owner: () => string, private content: () => HTMLElement | null,
    private container: () => HTMLElement | null, document: Document) {
    this.win = document.defaultView!; this.frame = mobileScrollFrame(document);
    this.win.addEventListener("resize", this.refresh);
    this.win.visualViewport?.addEventListener("resize", this.refresh);
  }
  get active(): boolean { return !!this.runtime.composerScrollTarget?.(this.owner()); }
  get userControlling(): boolean { return this.touching || this.follow.paused; }
  /** Compatibility hook: paused offsets are never restored over native scrolling. */
  capture(): void {}
  pauseForReading = (): void => {
    this.readingLock = true; this.pause();
  };
  private pause(): void {
    this.userIntent = true; this.animation = undefined; this.follow.pauseFromUser();
    this.frame.cancel(this); this.persistPause();
  }
  refreshOutput = (): void => { this.outputFollow = true; this.refresh(); };
  resumeIfAtBottom = (): void => { this.readingLock = false; this.resumeAtBottom = true; this.refresh(); };
  refresh = (): void => {
    if (this.disposed) return;
    const target = this.runtime.composerScrollTarget?.(this.owner()), content = this.content();
    if (target && content && !content.closest("[hidden],[inert]")) this.prepareNodes(content, target.owner !== this.owner());
    this.frame.request(this, this.read);
  };
  private prepareNodes(content: HTMLElement, handoff: boolean): void {
    const spacer = this.spacer ??= ownedEl(content.ownerDocument, "div");
    spacer.setAttribute("aria-hidden", "true"); spacer.dataset.composerReadingSpacer = "true";
    if (content.lastElementChild !== spacer) content.append(spacer);
    if (handoff) {
      const leading = this.leadingSpacer ??= ownedEl(content.ownerDocument, "div");
      leading.setAttribute("aria-hidden", "true"); leading.dataset.composerReadingLeading = "true";
      if (content.firstElementChild !== leading) content.prepend(leading);
    } else { this.leadingSpacer?.remove(); this.leadingSpacer = undefined; }
  }
  private bind(scroller: HTMLElement): void {
    if (this.scroller === scroller) return;
    this.unbind(); this.scroller = scroller;
    scroller.addEventListener("wheel", this.wheel, { passive: true });
    scroller.addEventListener("touchstart", this.touchStart, { passive: true });
    scroller.addEventListener("touchmove", this.touchMove, { passive: true });
    scroller.addEventListener("touchend", this.touchEnd, { passive: true });
    scroller.addEventListener("touchcancel", this.touchEnd, { passive: true });
    scroller.addEventListener("scroll", this.scrolled, { passive: true });
    if (typeof ResizeObserver !== "undefined") { this.observer = new ResizeObserver(this.refresh); this.observer.observe(scroller); }
  }
  private observeRows(content: HTMLElement): void {
    if (typeof ResizeObserver === "undefined") return;
    const rows = Array.from(content.children).filter(row => row !== this.spacer && row !== this.leadingSpacer);
    if (rows.length === this.observedRows.length && rows.every((row, index) => row === this.observedRows[index])) return;
    this.observedRows = rows;
    this.rowObserver ??= new ResizeObserver(this.refresh); this.rowObserver.disconnect();
    for (const row of rows) this.rowObserver.observe(row);
  }
  private wheel = (event: WheelEvent): void => {
    if (!(event.target as Element | null)?.closest?.('.ip-task-reasoning,.pd-task-reasoning')) this.readingLock = false;
    this.follow.handleWheel(event); if (this.follow.paused) this.pause();
    if (event.deltaY > 0) { this.resumeAtBottom = true; this.refresh(); }
  };
  private touchStart = (event: TouchEvent): void => {
    if (!(event.target as Element | null)?.closest?.('.ip-task-reasoning,.pd-task-reasoning')) this.readingLock = false;
    this.follow.handleTouchStart(event); this.touching = true; this.pause();
  };
  private touchMove = (event: TouchEvent): void => { this.follow.handleTouchMove(event); this.persistPause(); };
  private touchEnd = (): void => { this.touching = false; this.resumeAtBottom = true; this.refresh(); };
  private scrolled = (): void => { this.nativeScroll = true; this.refresh(); };
  private persistPause(): void {
    if (this.sequence !== undefined && this.follow.paused) { this.acknowledgedPause = true; this.runtime.pauseComposerScroll?.(this.sequence); }
  }
  private message(content: HTMLElement, target: MobileSubmissionScrollTarget): HTMLElement | undefined {
    const formal = Array.from(content.querySelectorAll<HTMLElement>("[data-submission-turn]"))
      .find(node => node.dataset.submissionTurn === target.turnId);
    const pending = Array.from(content.querySelectorAll<HTMLElement>("[data-composer-transfer]"))
      .find(node => node.dataset.composerTransfer === target.turnId);
    return formal ?? pending?.querySelector<HTMLElement>("article") ?? pending;
  }
  private read = (): (() => void) | void => {
    if (this.disposed) return;
    const target = this.runtime.composerScrollTarget?.(this.owner()), content = this.content(), scroller = this.container();
    if (!content?.isConnected || !scroller || content.closest("[hidden],[inert]")) return;
    if (!target && !this.outputFollow) { this.reset(); return; }
    this.bind(scroller); this.observeRows(content);
    const height = scroller.clientHeight, top = scroller.scrollTop, scrollHeight = scroller.scrollHeight;
    if (!height) return;
    const maximum = Math.max(0, scrollHeight - height);
    if (this.previousHeight !== undefined && (height !== this.previousHeight || maximum < (this.previousMaximum ?? maximum))) this.automaticTop = top;
    this.previousHeight = height; this.previousMaximum = maximum;
    const atBottom = scrollHeight - top - height <= 2;
    const message = target ? this.message(content, target) : undefined;
    if (target && !message) return;
    const first = !!target && target.sequence !== this.sequence;
    if (first) {
      if (this.sequence !== undefined && !this.touching) { this.userIntent = false; this.readingLock = false; }
      this.follow.reset(); this.sequence = target.sequence; this.outputHeight = 0; this.followingOutput = false;
      this.acknowledgedPause = false; this.animation = undefined;
      if (this.userIntent) this.follow.pauseFromUser();
    }
    if (target?.paused && !this.acknowledgedPause) { this.follow.pauseFromUser(); this.userIntent = true; this.acknowledgedPause = true; }
    if (!target && !this.genericInitialized) { this.genericInitialized = true; if (!atBottom) { this.follow.pauseFromUser(); this.userIntent = true; } }
    if ((this.nativeScroll || this.resumeAtBottom) && !this.touching) {
      const returned = this.resumeAtBottom && !this.readingLock || this.nativeScroll && top !== this.automaticTop;
      if (atBottom && this.userIntent && returned) { this.follow.reset(); this.userIntent = false; this.readingLock = false; this.acknowledgedPause = true; }
      else if (this.nativeScroll && !this.userIntent) { this.follow.handleScroll(atBottom, top); if (this.follow.paused) this.userIntent = true; }
      this.persistPause();
    }
    this.nativeScroll = false; this.resumeAtBottom = false;
    if (this.userControlling) { this.animation = undefined; return; }
    if (!target || !message) return () => { if (!this.disposed && !this.userControlling) this.write(scroller, Math.max(0, scrollHeight - height)); };
    const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const messageRect = message.getBoundingClientRect();
    const previousLeading = Number.parseFloat(this.leadingSpacer?.style.height ?? "") || 0;
    const leading = this.leadingSpacer ? composerReadingLeadingSpace(height, top + messageRect.top - viewportTop - previousLeading) : 0;
    const end = Math.max(messageRect.bottom, ...Array.from(content.children).filter(row => row !== this.spacer && row !== this.leadingSpacer && !(row as HTMLElement).hidden).map(row => row.getBoundingClientRect().bottom));
    const padding = Number.parseFloat(this.win.getComputedStyle(scroller).paddingBottom) || 0;
    const spacer = composerReadingSpace(height, end - messageRect.top, padding);
    const previousSpacer = Number.parseFloat(this.spacer?.style.height ?? "") || 0;
    const bottom = Math.max(0, scrollHeight + leading - previousLeading + spacer - previousSpacer - height);
    const landing = composerReadingScrollTop(top, messageRect.top + leading - previousLeading, viewportTop, height);
    const outputHeight = Array.from(content.querySelectorAll<HTMLElement>('[data-message-role="assistant"]'))
      .filter(node => !!(message.compareDocumentPosition(node) & message.DOCUMENT_POSITION_FOLLOWING))
      .reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
    if (outputHeight > this.outputHeight && this.outputHeight > 0) this.followingOutput = true;
    this.outputHeight = outputHeight;
    if (first && target.owner === this.owner()) this.animation = { top, started: this.win.performance.now() };
    let desired = first || messageRect.height > height * .75 && !this.followingOutput ? landing : bottom;
    if (this.animation) {
      const elapsed = this.win.performance.now() - this.animation.started;
      desired = this.animation.top + (landing - this.animation.top) * conversationScrollProgress(elapsed);
      if (elapsed >= CONVERSATION_SCROLL_DURATION_MS) this.animation = undefined;
    }
    return () => {
      if (this.disposed || this.userControlling) return;
      if (this.leadingSpacer && this.leadingSpacer.style.height !== `${leading}px`) this.leadingSpacer.style.height = `${leading}px`;
      if (this.spacer && this.spacer.style.height !== `${spacer}px`) this.spacer.style.height = `${spacer}px`;
      this.write(scroller, desired);
      if (this.animation) this.refresh();
    };
  };
  private write(scroller: HTMLElement, desired: number): void {
    const previous = scroller.scrollTop;
    if (Math.abs(previous - desired) < .5) return;
    scroller.scrollTop = desired;
    this.automaticTop = scroller.scrollTop; this.follow.recordAutomaticScroll(previous, this.automaticTop);
  }
  private reset(): void {
    this.follow.reset(); this.sequence = undefined; this.spacer?.remove(); this.spacer = undefined;
    this.leadingSpacer?.remove(); this.leadingSpacer = undefined; this.animation = undefined;
    this.userIntent = false; this.readingLock = false; this.automaticTop = undefined; this.acknowledgedPause = false;
    this.rowObserver?.disconnect(); this.observedRows = [];
  }
  leave(preserveTarget = false): void {
    const target = this.runtime.composerScrollTarget?.(this.owner()), content = this.content();
    const ownsTarget = target && (this.sequence === target.sequence || content?.isConnected && !content.closest("[hidden],[inert]"));
    if (!preserveTarget && ownsTarget) this.runtime.clearComposerScroll?.(target.turnId);
    this.frame.cancel(this); this.reset();
  }
  private unbind(): void {
    this.observer?.disconnect(); this.observer = undefined;
    this.rowObserver?.disconnect(); this.rowObserver = undefined; this.observedRows = [];
    this.scroller?.removeEventListener("wheel", this.wheel);
    this.scroller?.removeEventListener("touchstart", this.touchStart);
    this.scroller?.removeEventListener("touchmove", this.touchMove);
    this.scroller?.removeEventListener("touchend", this.touchEnd);
    this.scroller?.removeEventListener("touchcancel", this.touchEnd);
    this.scroller?.removeEventListener("scroll", this.scrolled);
    this.scroller = undefined;
  }
  dispose(): void {
    this.leave(); this.disposed = true; this.unbind();
    this.win.removeEventListener("resize", this.refresh);
    this.win.visualViewport?.removeEventListener("resize", this.refresh);
  }
}
