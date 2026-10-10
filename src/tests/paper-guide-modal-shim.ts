import type { PaperGuideModalOptions, PaperGuideScene } from "../ui/paper-guide-modal";

/** Controller test port only. Native Modal behavior is verified separately. */
export class PaperGuideModal {
  static readonly instances: PaperGuideModal[] = [];
  scenes: readonly PaperGuideScene[];
  opened = false;
  closed = false;
  disposed = false;
  updates = 0;

  constructor(_app: unknown, readonly options: PaperGuideModalOptions) {
    this.scenes = options.scenes;
    PaperGuideModal.instances.push(this);
  }
  open(): void { this.opened = true; }
  updateScenes(scenes: readonly PaperGuideScene[]): void { this.scenes = scenes; this.updates++; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onClosed();
  }
  dispose(): void { this.disposed = true; this.close(); }
}
