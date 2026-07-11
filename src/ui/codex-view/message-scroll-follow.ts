export interface MessageRenderScheduleOptions {
  forceBottom?: boolean;
  fromScroll?: boolean;
  preserveScroll?: boolean;
}

export type AnimationFrameScheduler = (callback: () => void) => number;

export class MessageScrollFollowController {
  paused = false;
  private renderScheduled = false;
  private pendingRenderForceBottom = false;
  private pendingRenderFromScroll = false;
  private measureScheduled = false;
  private pendingMeasureForceBottom = false;
  private touchStartY = 0;

  handleScroll(atBottom: boolean): MessageRenderScheduleOptions {
    this.paused = !atBottom;
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
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    scheduleFrame(() => {
      const forceBottom = this.pendingRenderForceBottom && !this.paused;
      const fromScroll = this.pendingRenderFromScroll && !forceBottom;
      this.pendingRenderForceBottom = false;
      this.pendingRenderFromScroll = false;
      this.renderScheduled = false;
      render({ forceBottom, fromScroll, preserveScroll: this.paused && !forceBottom });
    });
  }

  scheduleMeasure(forceBottom: boolean, scheduleFrame: AnimationFrameScheduler, measure: (forceBottom: boolean) => void): void {
    this.pendingMeasureForceBottom = this.pendingMeasureForceBottom || forceBottom;
    if (this.measureScheduled) return;
    this.measureScheduled = true;
    scheduleFrame(() => {
      const shouldForceBottom = this.pendingMeasureForceBottom && !this.paused;
      this.pendingMeasureForceBottom = false;
      this.measureScheduled = false;
      measure(shouldForceBottom);
    });
  }

  pauseFromUser(): void {
    this.paused = true;
    this.pendingRenderForceBottom = false;
    this.pendingMeasureForceBottom = false;
  }

  reset(): void {
    this.paused = false;
    this.pendingRenderForceBottom = false;
    this.pendingRenderFromScroll = false;
    this.pendingMeasureForceBottom = false;
  }
}
