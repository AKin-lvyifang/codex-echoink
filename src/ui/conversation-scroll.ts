/** Shared with the turn navigator so conversation jumps use one motion. */
export const CONVERSATION_SCROLL_DURATION_MS = 260;

export function conversationScrollProgress(elapsed: number): number {
  const progress = Math.min(1, Math.max(0, elapsed / CONVERSATION_SCROLL_DURATION_MS));
  return 1 - Math.pow(1 - progress, 3);
}


/** Space consumed by this turn as its process and answer grow. */
export function composerReadingSpace(viewportHeight: number, turnHeight: number, paddingBottom = 0): number {
  return Math.max(viewportHeight * 0.75 - turnHeight - paddingBottom, 0);
}

/** Coordinates are relative to the actual message scroller, below its header. */
export function composerReadingScrollTop(scrollTop: number, messageTop: number, viewportTop: number, viewportHeight: number): number {
  return Math.max(0, scrollTop + messageTop - viewportTop - viewportHeight * 0.25);
}

export function composerReadingLeadingSpace(viewportHeight: number, messageOffset: number): number {
  return Math.max(0, viewportHeight * 0.25 - messageOffset);
}


export interface MessageRenderScheduleOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

export type AnimationFrameScheduler = (callback: () => void) => number;

export class MessageScrollFollowController {
  paused = false;
  private pendingRenderForceBottom = false;
  private pendingRenderFromScroll = false;
  private pendingMeasureForceBottom = false;
  private frameScheduled = false;
  private renderWork: ((options: MessageRenderScheduleOptions) => void) | null = null;
  private measureWork: ((forceBottom: boolean) => void) | null = null;
  private touchStartY = 0;
  private scrollAnimation = 0;
  private animationWindow: Window | null = null;
  private automaticScrollTop: number | null = null;
  get animating(): boolean { return this.scrollAnimation !== 0; }

  recordAutomaticScroll(previous: number, current: number): void {
    if (previous !== current) this.automaticScrollTop = current;
  }

  handleScroll(atBottom: boolean, scrollTop?: number): MessageRenderScheduleOptions {
    // Native scroll events arrive later than a layout write. More content may
    // already have grown below that exact position; that is not a user gesture.
    if (!this.animating && (scrollTop === undefined || scrollTop !== this.automaticScrollTop)) {
      this.automaticScrollTop = null;
      this.paused = !atBottom;
    }
    return { fromScroll: true };
  }

  handleWheel(event: Pick<WheelEvent, "deltaY">): void {
    if (event.deltaY < 0) this.pauseFromUser();
  }

  handleTouchStart(event: Pick<TouchEvent, "touches">): void {
    this.touchStartY = event.touches[0]?.clientY ?? 0;
  }

  handleTouchMove(event: Pick<TouchEvent, "touches">): void {
    const currentY = event.touches[0]?.clientY ?? this.touchStartY;
    if (currentY > this.touchStartY + 2) this.pauseFromUser();
  }

  scheduleRender(options: MessageRenderScheduleOptions, scheduleFrame: AnimationFrameScheduler, render: (options: MessageRenderScheduleOptions) => void): void {
    this.pendingRenderForceBottom = this.pendingRenderForceBottom || (Boolean(options.forceBottom) && !this.paused);
    if (options.fromScroll && !this.pendingRenderForceBottom) this.pendingRenderFromScroll = true;
    else if (!options.fromScroll) this.pendingRenderFromScroll = false;
    this.renderWork = render;
    this.scheduleFrame(scheduleFrame);
  }

  private scheduleFrame(scheduleFrame: AnimationFrameScheduler, afterContentFrame = false): void {
    if (this.frameScheduled) return;
    this.frameScheduled = true;
    const flush = () => {
      this.frameScheduled = false;
      const render = this.renderWork, measure = this.measureWork;
      const shouldMeasure = this.pendingMeasureForceBottom && !this.paused && !this.animating;
      this.renderWork = null;
      this.measureWork = null;
      this.pendingMeasureForceBottom = false;
      const forceBottom = (this.pendingRenderForceBottom || shouldMeasure) && !this.paused && !this.animating;
      const fromScroll = this.pendingRenderFromScroll && !forceBottom;
      this.pendingRenderForceBottom = false;
      this.pendingRenderFromScroll = false;
      // Rendering measures the newly mounted rows itself. A queued measure is
      // only needed when this frame contains incremental content updates.
      if (render) render({ forceBottom, fromScroll, preserveScroll: (this.paused || this.animating) && !forceBottom });
      else measure?.(shouldMeasure);
    };
    scheduleFrame(() => {
      // A structural render owns its measurements and must not wait an extra
      // frame. Only incremental measurement waits for the browser content frame.
      if (afterContentFrame && !this.renderWork) scheduleFrame(flush);
      else flush();
    });
  }

  scheduleMeasure(forceBottom: boolean, scheduleFrame: AnimationFrameScheduler, measure: (forceBottom: boolean) => void): void {
    this.pendingMeasureForceBottom = this.pendingMeasureForceBottom || forceBottom;
    this.measureWork = measure;
    this.scheduleFrame(scheduleFrame, true);
  }

  pauseFromUser(): void {
    this.cancelAnimation();
    this.paused = true;
    this.pendingRenderForceBottom = false;
    this.pendingMeasureForceBottom = false;
  }

  reset(): void {
    this.cancelAnimation();
    this.paused = false;
    this.pendingRenderForceBottom = false;
    this.pendingRenderFromScroll = false;
    this.pendingMeasureForceBottom = false;
    this.automaticScrollTop = null;
  }

  /** Virtual renders restore scrollTop, so use the navigator's frame motion. */
  followLatest(messages: HTMLElement, render: (options: MessageRenderScheduleOptions) => void, targetTop = () => Math.max(0, messages.scrollHeight - messages.clientHeight)): void {
    this.reset();
    const win = messages.ownerDocument.defaultView!;
    this.animationWindow = win;
    const start = messages.scrollTop, startedAt = win.performance.now();
    const step = (now: number): void => {
      const target = targetTop();
      messages.scrollTop = start + (target - start) * conversationScrollProgress(now - startedAt);
      if (now - startedAt < CONVERSATION_SCROLL_DURATION_MS) {
        this.scrollAnimation = win.requestAnimationFrame(step);
        render({ fromScroll: true, preserveScroll: true });
      } else {
        this.scrollAnimation = 0;
        this.animationWindow = null;
        render({ forceBottom: true });
      }
    };
    if (win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.animationWindow = null;
      render({ forceBottom: true });
    } else {
      this.scrollAnimation = win.requestAnimationFrame(step);
      render({ preserveScroll: true });
    }
  }

  private cancelAnimation(): void {
    if (this.scrollAnimation) this.animationWindow?.cancelAnimationFrame(this.scrollAnimation);
    this.scrollAnimation = 0;
    this.animationWindow = null;
  }
}
