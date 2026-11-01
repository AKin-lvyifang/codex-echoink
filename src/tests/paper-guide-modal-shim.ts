import type { PaperGuideModalOptions } from "../ui/paper-guide-modal";
/** Controller port only; native UI is covered in the disposable Obsidian instance. */
export class PaperGuideModal {
  static readonly instances: PaperGuideModal[] = [];
  opened = false;
  closed = false;
  constructor(_app: unknown, readonly options: PaperGuideModalOptions) { PaperGuideModal.instances.push(this); }
  open() { this.opened = true; }
  close() { if (!this.closed) { this.closed = true; this.options.onClosed(); } }
  dispose() { this.close(); }
}
