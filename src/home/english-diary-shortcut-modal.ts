import { Modal, type App } from "obsidian";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import type { SettingsLanguage } from "../settings/settings";

type HomeShortcutChoice = "english-diary" | "quick-record";

export function chooseEnglishDiaryHomeShortcut(app: App, language: SettingsLanguage, signal?: AbortSignal): Promise<HomeShortcutChoice | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: HomeShortcutChoice | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(choice);
    };
    const modal = new EnglishDiaryShortcutModal(app, language, finish);
    const abort = () => { finish(null); modal.close(); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(null); return; }
    modal.open();
  });
}

class EnglishDiaryShortcutModal extends Modal {
  private readonly ownerDocument: Document;
  private readonly opener: HTMLElement | null;

  constructor(app: App, private readonly language: SettingsLanguage, private readonly done: (choice: HomeShortcutChoice | null) => void) {
    super(app);
    this.ownerDocument = typeof activeDocument === "undefined" ? this.modalEl.ownerDocument : activeDocument;
    this.opener = this.ownerDocument.activeElement as HTMLElement | null;
  }

  onOpen(): void {
    const doc = this.ownerDocument;
    if (this.modalEl.ownerDocument !== doc) doc.body.appendChild(doc.adoptNode(this.containerEl));
    this.modalEl.addClass("echoink-diary-modal", "echoink-diary-shortcut-modal");
    const zh = this.language !== "en";
    this.setTitle(zh ? "选择首页快捷入口" : "Choose a home shortcut");
    this.modalEl.querySelector<HTMLElement>(".modal-close-button, .modal-header-button")?.setAttribute("aria-label", zh ? "关闭" : "Close");
    this.contentEl.createEl("p", {
      cls: "echoink-diary-description",
      text: zh ? "检测到英文日记已启用。选择首页要显示的快捷入口，也可以稍后在英文日记设置中修改。"
        : "English Diary is enabled. Choose the shortcut to show on Home. You can change it later in English Diary settings."
    });
    const actions = this.contentEl.createDiv({ cls: "echoink-diary-actions" });
    const keep = createOriginButton(actions, {
      text: zh ? "保留快速记录" : "Keep quick note",
      attr: { "data-home-shortcut-choice": "quick-record" }
    });
    const diary = createOriginButton(actions, {
      text: zh ? "写英文日记" : "Write English diary",
      attr: { "data-home-shortcut-choice": "english-diary" }
    });
    keep.onclick = () => { this.done("quick-record"); this.close(); };
    diary.onclick = () => { this.done("english-diary"); this.close(); };
    doc.defaultView?.requestAnimationFrame(() => { if (keep.isConnected) keep.focus({ preventScroll: true }); });
  }

  onClose(): void {
    this.done(null);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  }
}
