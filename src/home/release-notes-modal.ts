import { Component, MarkdownRenderer, Modal, type App } from "obsidian";
import type { ReleaseNotes } from "../settings/release-update";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";

export class ReleaseNotesModal extends Modal {
  private readonly markdownComponent = new Component();
  private showing = false;

  constructor(app: App, private readonly notes: ReleaseNotes, private readonly english: boolean, private readonly onRead: () => void) {
    super(app);
  }

  onOpen(): void {
    this.showing = true;
    this.modalEl.addClass("echoink-theme-boundary", "echoink-release-notes-modal");
    this.setTitle(this.notes.title);
    this.markdownComponent.load();
    const body = this.contentEl.createDiv({ cls: "echoink-release-notes-body markdown-rendered" });
    const actions = this.contentEl.createDiv({ cls: "echoink-release-notes-actions" });
    const done = createOriginButton(actions, { text: this.english ? "Got it" : "知道了" });
    applyAmicroButton(done, { variant: "primary" });
    done.onclick = () => this.close();
    void MarkdownRenderer.render(this.app, this.notes.markdown, body, "", this.markdownComponent).then(() => {
      if (this.showing) this.onRead();
    }).catch(() => {
      if (this.showing) body.setText(this.english ? "Could not display release notes." : "暂时无法显示版本说明。");
    });
  }

  onClose(): void {
    this.showing = false;
    this.markdownComponent.unload();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }
}
