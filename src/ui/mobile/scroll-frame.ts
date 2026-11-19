type Read = () => (() => void) | void;
const frames = new WeakMap<Window, MobileScrollFrame>();

/** Collect every mobile scroller's geometry before committing any offsets. */
export class MobileScrollFrame {
  private frame = 0;
  private pending = new Map<object, Read>();
  constructor(private win: Window) {}
  request(key: object, read: Read): void {
    this.pending.set(key, read);
    if (!this.frame) this.frame = this.win.requestAnimationFrame(() => {
      this.frame = 0;
      const reads = [...this.pending.values()]; this.pending.clear();
      const writes = reads.map(work => work());
      for (const write of writes) write?.();
    });
  }
  cancel(key: object): void {
    this.pending.delete(key);
    if (!this.pending.size && this.frame) { this.win.cancelAnimationFrame(this.frame); this.frame = 0; }
  }
}

export function mobileScrollFrame(document: Document): MobileScrollFrame {
  const win = document.defaultView!;
  let frame = frames.get(win);
  if (!frame) { frame = new MobileScrollFrame(win); frames.set(win, frame); }
  return frame;
}
