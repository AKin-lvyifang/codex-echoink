import { Modal, Setting, type App } from "obsidian";
import { createOriginButton, createOriginInput, createOriginRadioGroup, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { extractFirstUrl, isWeChatUrl } from "../knowledge-base/web-capture";

export type CaptureLinkKind = "web" | "wechat";
export interface CaptureLinkInput { input: string; url: string; kind: CaptureLinkKind }

export function captureLinkModal(app: App, initialValue: string, capture: (input: CaptureLinkInput) => Promise<string[]>): Promise<string[]> {
  return new Promise(resolve => new CaptureLinkModal(app, initialValue, capture, resolve).open());
}

/** Keep the task open until capture succeeds, so a failed source can be retried. */
export class CaptureLinkModal extends Modal {
  private kind: CaptureLinkKind;
  private url: string | null;
  private busy = false;
  private settled = false;
  private input!: HTMLInputElement;
  private types!: HTMLElement;
  private status!: HTMLElement;
  private submit!: HTMLButtonElement;
  private cancel!: HTMLButtonElement;

  constructor(app: App, private readonly initialValue: string, private readonly capture: (input: CaptureLinkInput) => Promise<string[]>, private readonly done: (paths: string[]) => void) {
    super(app);
    this.url = extractFirstUrl(initialValue);
    this.kind = this.url && isWeChatUrl(this.url) ? "wechat" : "web";
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary", "echoink-confirm-origin");
    this.contentEl.createEl("h2", { text: "收藏" });
    const field = new Setting(this.contentEl).setName("链接");
    this.input = createOriginInput(field.controlEl, { value: this.initialValue, attr: { placeholder: "粘贴网页或公众号链接", "aria-label": "链接", "data-capture-link-input": "" } });
    this.input.addEventListener("input", () => {
      const url = extractFirstUrl(this.input.value);
      if (url !== this.url) {
        this.url = url;
        this.kind = url && isWeChatUrl(url) ? "wechat" : "web";
        this.renderTypes();
      }
    });
    this.types = this.contentEl.createDiv();
    this.renderTypes();
    this.status = this.contentEl.createDiv({ attr: { role: "alert", "data-capture-link-error": "" } });
    this.status.hidden = true;
    const actions = new Setting(this.contentEl).controlEl;
    this.cancel = createOriginButton(actions, { text: "取消" });
    this.cancel.onclick = () => this.close();
    this.submit = createOriginButton(actions, { text: "收藏", cls: "mod-cta", attr: { "data-capture-link-submit": "" } });
    applyAmicroButton(this.submit, { variant: "primary" });
    this.submit.onclick = () => { void this.save(); };
    this.input.focus();
  }

  close(): void {
    if (!this.busy) super.close();
  }

  onClose(): void {
    this.finish([]);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private renderTypes(): void {
    disposeOriginControls(this.types);
    this.types.empty();
    const group = createOriginRadioGroup(this.types, this.kind, "收藏类型", value => { this.kind = value as CaptureLinkKind; });
    for (const [kind, label] of [["web", "网页"], ["wechat", "公众号"]] as const) {
      const row = new Setting(group.element).setName(label);
      const radio = group.addItem(row.controlEl, kind, false);
      radio.setAttribute("aria-label", label);
      radio.setAttribute("data-capture-link-kind", kind);
    }
  }

  private async save(): Promise<void> {
    if (this.busy || this.settled) return;
    const input = this.input.value.trim();
    const url = extractFirstUrl(input);
    this.status.hidden = true;
    if (!url) {
      this.showError("收藏只支持网页和公众号链接");
      return;
    }
    this.setBusy(true);
    try {
      const paths = await this.capture({ input, url, kind: this.kind });
      this.finish(paths);
      this.busy = false;
      super.close();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.settled) this.setBusy(false);
    }
  }

  private showError(message: string): void {
    this.status.setText(message);
    this.status.hidden = false;
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    this.input.disabled = value;
    this.cancel.disabled = value;
    for (const radio of Array.from(this.types.querySelectorAll<HTMLButtonElement | HTMLInputElement>("[data-capture-link-kind]"))) radio.disabled = value;
    this.submit.disabled = value;
    this.submit.setText(value ? "正在收藏…" : "收藏");
    setAmicroButtonPending(this.submit, value);
  }

  private finish(paths: string[]): void {
    if (this.settled) return;
    this.settled = true;
    this.done(paths);
  }
}
