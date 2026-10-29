import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { createSettingsPage, showSettingsInlineConfirmation } from "../settings/settings-v2";
import { applyDeleteButton } from "../settings/amicro-buttons";
import { App, Modal, Setting } from "obsidian";

export function confirmModal(
  app: App,
  title: string,
  body: string,
  acceptText = "允许",
  declineText = "拒绝",
  options: { signal?: AbortSignal; preformatted?: boolean; originControls?: boolean; deleteAction?: boolean } = {}
): Promise<boolean> {
  if (options.signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let modal!: ConfirmModal;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolve(accepted);
    };
    const abort = () => {
      finish(false);
      modal.close();
    };
    modal = new ConfirmModal(
      app,
      title,
      body,
      acceptText,
      declineText,
      options.preformatted === true,
      finish,
      options.originControls === true,
      options.deleteAction === true
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      finish(false);
      return;
    }
    modal.open();
  });
}

export function textInputModal(app: App, title: string, label: string, initialValue = "", options: { secret?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new TextInputModal(app, title, label, initialValue, options.secret === true, resolve);
    modal.open();
  });
}

export interface MemoryCorrectionModalRecord {
  readonly memoryType: string;
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
}

export interface MemoryCorrectionModalPreview {
  readonly title: string;
  readonly content: string;
  readonly recallWhen: string;
}

export interface MemoryCorrectionModalActions {
  generate(
    correction: string,
    signal: AbortSignal
  ): Promise<Readonly<MemoryCorrectionModalPreview>>;
  save(
    preview: Readonly<MemoryCorrectionModalPreview>,
    correction: string
  ): Promise<void>;
}

export type MemoryCorrectionModalResult = "saved" | "cancelled" | "conflict";

export function memoryCorrectionModal(
  app: App,
  record: Readonly<MemoryCorrectionModalRecord>,
  language: "zh-CN" | "en",
  actions: Readonly<MemoryCorrectionModalActions>,
  mount?: (modal: MemoryCorrectionModal) => void
): Promise<MemoryCorrectionModalResult> {
  return new Promise((resolve) => {
    const modal = new MemoryCorrectionModal(
      app,
      record,
      language,
      actions,
      resolve
    );
    if (mount) mount(modal);
    else modal.open();
  });
}

export function selectInputModal(
  app: App,
  title: string,
  label: string,
  options: Array<{ value: string; label: string }>
): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new SelectInputModal(app, title, label, options, resolve);
    modal.open();
  });
}

interface RequestInputQuestion {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string }> | null;
  isSecret?: boolean;
}

export function requestUserInputModal(app: App, questions: RequestInputQuestion[]): Promise<Record<string, { answers: string[] }>> {
  return new Promise((resolve) => {
    const modal = new RequestInputModal(app, questions, resolve);
    modal.open();
  });
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly bodyText: string,
    private readonly acceptText: string,
    private readonly declineText: string,
    private readonly preformatted: boolean,
    private readonly done: (accepted: boolean) => void,
    private readonly originControls = false,
    private readonly deleteAction = false
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    if (this.preformatted) {
      contentEl.createDiv({
        cls: "echoink-confirm-modal-preformatted",
        text: this.bodyText
      });
    } else {
      contentEl.createEl("p", { text: this.bodyText });
    }
    if (this.originControls) {
      this.modalEl.addClass("echoink-confirm-origin");
      const actions = new Setting(contentEl).controlEl;
      const decline = createOriginButton(actions, { text: this.declineText });
      const accept = createOriginButton(actions, { text: this.acceptText, cls: "mod-cta" });
      if (this.deleteAction) applyDeleteButton(accept);
      decline.onclick = () => { this.finish(false); this.close(); };
      accept.onclick = () => { this.finish(true); this.close(); };
      return;
    }
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(this.declineText).onClick(() => {
          this.finish(false);
          this.close();
        })
      )
      .addButton((button) => {
        button
          .setButtonText(this.acceptText)
          .setCta()
          .onClick(() => {
            this.finish(true);
            this.close();
          });
        if (this.deleteAction) applyDeleteButton(button.buttonEl);
      });
  }

  onClose(): void {
    this.finish(false);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private finish(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }
}

class TextInputModal extends Modal {
  private value: string;
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly label: string,
    initialValue: string,
    private readonly secret: boolean,
    private readonly done: (value: string | null) => void
  ) {
    super(app);
    this.value = initialValue;
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    new Setting(contentEl).setName(this.label).addText((text) => {
      if (this.secret) text.inputEl.type = "password";
      text.setValue(this.value).onChange((value) => {
        this.value = value;
      });
      text.inputEl.focus();
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.finish(null);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("保存")
          .setCta()
          .onClick(() => {
            this.finish(this.value.trim());
            this.close();
          })
      );
  }

  onClose(): void {
    this.finish(null);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }
}

export class MemoryCorrectionModal extends Modal {
  private static inlineSequence = 0;
  private readonly inlineInputId = `echoink-memory-correction-inline-${++MemoryCorrectionModal.inlineSequence}`;
  private embedded = false;
  private inlineEl: HTMLElement | null = null;
  private pendingInlineLeave: (() => void) | null = null;
  private inlineOptions: { onCancel?: () => void; onConflict?: () => void } = {};
  private settingsPageOptions: {
    backLabel: string;
    unavailable?: string;
    onNavigate: () => void;
  } | null = null;
  private pageStep: "editing" | "preview" = "editing";
  private inlineExitButton: HTMLButtonElement | null = null;
  private inlineConflict = false;
  private completed = false;
  private statusMessage = "";
  private statusError = false;
  private correction = "";
  private settled = false;
  private disposed = false;
  private saving = false;
  private generation = 0;
  private generationController: AbortController | null = null;
  private state: "editing" | "generating" | "preview" | "saving" | "error" = "editing";
  private preview: Readonly<MemoryCorrectionModalPreview> | null = null;
  private textarea!: HTMLTextAreaElement;
  private previewEl!: HTMLElement;
  private previewBodyEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private correctButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;

  constructor(
    app: App,
    private record: Readonly<MemoryCorrectionModalRecord>,
    private readonly language: "zh-CN" | "en",
    private readonly actions: Readonly<MemoryCorrectionModalActions>,
    private readonly done: (value: MemoryCorrectionModalResult) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    this.modalEl.addClass("echoink-memory-correction-modal");
    this.renderContent(this.contentEl);
  }

  get hasDraft(): boolean { return !this.completed && (!!this.correction.trim() || this.preview !== null); }
  get submitting(): boolean { return this.saving || this.state === "generating"; }
  get settingsPageStep(): "editing" | "preview" { return this.pageStep; }
  updateSettingsRecord(record: Readonly<MemoryCorrectionModalRecord>): void { this.record = record; }
  mountSettingsPage(container: HTMLElement, options: {
    backLabel: string;
    unavailable?: string;
    onNavigate: () => void;
  }): void {
    this.settingsPageOptions = options;
    this.mountEmbedded(container);
  }
  mountInline(container: HTMLElement, options?: { onCancel?: () => void; onConflict?: () => void }): void {
    this.settingsPageOptions = null;
    if (options) this.inlineOptions = options;
    this.mountEmbedded(container);
  }
  private mountEmbedded(container: HTMLElement): void {
    this.suspend(); this.embedded = true; this.disposed = false;
    this.inlineEl = container.createDiv({ cls: "echoink-memory-correction-inline" });
    this.renderContent(this.inlineEl);
    if (this.pendingInlineLeave) {
      const done = this.pendingInlineLeave; this.pendingInlineLeave = null;
      this.requestLeave(done);
    }
  }
  requestLeave(done: () => void): void {
    if (this.submitting) return;
    if (!this.hasDraft) { done(); return; }
    if (!this.inlineEl) { this.pendingInlineLeave = done; return; }
    const trigger = this.settingsPageOptions && this.pageStep === "preview" ? this.cancelButton : this.inlineExitButton ?? this.cancelButton;
    showSettingsInlineConfirmation(this.inlineEl, trigger, {
      message: this.language !== "en" ? "还有未保存的修正，要放弃吗？" : "Discard this unsaved correction?",
      confirmLabel: this.language !== "en" ? "放弃修改" : "Discard", cancelLabel: this.language !== "en" ? "继续编辑" : "Keep editing",
      onConfirm: async () => { this.correction = ""; this.preview = null; this.inlineConflict = false; this.state = "editing"; this.finish("cancelled"); done(); }
    });
    const panel = this.inlineEl.querySelector<HTMLElement>(".echoink-settings-inline-confirm");
    this.inlineEl.ownerDocument.defaultView?.requestAnimationFrame(() => { if (panel?.isConnected) panel.scrollIntoView?.({ block: "nearest" }); });
  }
  suspend(): void {
    if (this.inlineEl) { disposeOriginControls(this.inlineEl); this.inlineEl.remove(); this.inlineEl = null; }
    this.inlineExitButton = null;
  }
  private exitInline(): void {
    this.requestLeave(() => { this.finish("cancelled"); this.suspend(); this.inlineOptions.onCancel?.(); });
  }
  private backSettingsPage(): void {
    if (this.submitting) return;
    if (this.pageStep === "preview") this.setSettingsPageStep("editing");
    else this.exitInline();
  }
  private setSettingsPageStep(step: "editing" | "preview"): void {
    this.pageStep = step;
    if (!this.settingsPageOptions) return;
    // Let the settings host capture the previous page's scroll before remounting.
    this.settingsPageOptions.onNavigate();
  }
  private renderContent(contentEl: HTMLElement): void {
    const zh = this.language !== "en";
    const settingsPage = this.settingsPageOptions;
    const previewPage = !!settingsPage && this.pageStep === "preview";
    contentEl.empty();
    if (settingsPage) {
      const page = createSettingsPage(contentEl, {
        title: previewPage ? (zh ? "预览修正" : "Preview correction") : (zh ? "修正记忆" : "Correct memory"),
        detail: true,
        backLabel: previewPage ? (zh ? "修正记忆" : "Correct memory") : settingsPage.backLabel,
        onBack: () => this.backSettingsPage()
      });
      page.addClass("echoink-memory-correction-page");
      if (settingsPage.unavailable) page.createDiv({ cls: "echoink-memory-correction-status is-error", text: settingsPage.unavailable });
      contentEl = page.createDiv({ cls: "echoink-memory-correction-page-card" });
    }
    if (!this.embedded) {
      contentEl.createEl("h2", {
        text: zh
          ? `修正${this.record.memoryType}记忆`
          : `Correct ${this.record.memoryType} memory`
      });
      contentEl.createEl("p", {
        cls: "echoink-memory-correction-intro",
        text: zh
          ? "说明哪里不准确，以及正确内容是什么"
          : "Explain what is inaccurate and what the correct information is"
      });
    }
    if (!this.embedded || settingsPage) {
      const current = contentEl.createDiv({
        cls: "echoink-memory-correction-card echoink-memory-correction-current"
      });
      current.createDiv({
        cls: "echoink-memory-correction-card-title",
        text: zh ? "原记忆" : "Original memory"
      });
      this.addReadOnlyField(current, zh ? "标题" : "Title", this.record.title);
      this.addReadOnlyField(current, zh ? "正文" : "Content", this.record.content);
      this.addReadOnlyField(
        current,
        zh ? (settingsPage ? "召回时机" : "何时可能想起") : "When it may be recalled",
        this.record.recallWhen
      );
    }

    const editor = contentEl.createDiv({ cls: "echoink-memory-correction-card echoink-memory-correction-editor" });
    editor.hidden = previewPage;
    if (!settingsPage) editor.createDiv({ cls: "echoink-memory-correction-card-title", text: zh ? "你的修正" : "Your correction" });
    const label = editor.createEl("label", {
      cls: "echoink-memory-correction-label",
      text: zh ? "修正说明" : "Correction"
    });
    this.textarea = editor.createEl("textarea", {
      cls: "echoink-memory-correction-textarea",
      attr: {
        rows: settingsPage ? "2" : "7",
        placeholder: zh
          ? "可分多行说明：哪些内容不准确、正确事实是什么、何时需要想起。"
          : "You can use multiple lines to explain what is inaccurate, the correct information, and when it matters.",
        "aria-label": zh ? "修正说明" : "Correction"
      }
    });
    this.textarea.id = this.embedded ? this.inlineInputId : "echoink-memory-correction-input";
    if (settingsPage) this.textarea.setAttribute("data-echoink-focus-key", "memory-correction:input");
    label.setAttribute("for", this.textarea.id);
    this.textarea.value = this.correction;
    if (previewPage) {
      const instruction = contentEl.createDiv({ cls: "echoink-memory-correction-instruction" });
      instruction.createDiv({ cls: "echoink-memory-correction-card-title", text: zh ? "你的修正" : "Your correction" });
      instruction.createDiv({ cls: "echoink-memory-correction-field-value", text: this.correction });
    }
    this.previewEl = contentEl.createDiv({
      cls: "echoink-memory-correction-card echoink-memory-correction-preview is-hidden",
      attr: { role: "region", "aria-label": zh ? "修正后预览" : "Corrected preview" }
    });
    this.previewBodyEl = this.previewEl.createDiv({ cls: settingsPage ? "echoink-memory-correction-preview-body" : undefined });

    this.statusEl = (settingsPage ? contentEl : editor).createDiv({
      cls: "echoink-memory-correction-status",
      attr: {
        role: "status",
        "aria-live": "polite"
      }
    });

    const actions = editor.createDiv({ cls: "echoink-memory-correction-actions" });
    if (this.embedded) {
      this.inlineExitButton = createOriginButton(actions, { text: zh ? "取消" : "Cancel", attr: { type: "button" } });
      if (settingsPage) this.inlineExitButton.setAttribute("data-echoink-focus-key", "memory-correction:cancel");
      this.inlineExitButton.onclick = () => this.exitInline();
      this.inlineEl!.onkeydown = event => { if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (settingsPage) this.backSettingsPage(); else this.exitInline(); } };
    }
    this.correctButton = createOriginButton(actions, {
      cls: "mod-cta",
      text: zh ? "生成预览" : "Generate preview",
      attr: { type: "button" }
    });
    if (settingsPage) this.correctButton.setAttribute("data-echoink-focus-key", "memory-correction:generate");
    const previewActions = this.previewEl.createDiv({ cls: "echoink-memory-correction-actions" });
    this.cancelButton = createOriginButton(previewActions, { text: settingsPage ? (zh ? "返回修改" : "Back to edit") : zh ? "取消" : "Cancel", attr: { type: "button" } });
    if (settingsPage) this.cancelButton.setAttribute("data-echoink-focus-key", "memory-correction:edit");
    this.cancelButton.onclick = () => { if (!this.saving) { if (settingsPage) this.backSettingsPage(); else if (this.embedded) this.exitInline(); else this.close(); } };
    this.saveButton = createOriginButton(previewActions, {
      cls: "mod-cta",
      text: zh ? "确认保存" : "Confirm save",
      attr: { type: "button" }
    });
    if (settingsPage) this.saveButton.setAttribute("data-echoink-focus-key", "memory-correction:save");
    if (settingsPage) {
      const activeActions = previewPage ? previewActions : actions;
      activeActions.before(this.statusEl);
    }
    this.textarea.oninput = () => {
      if (this.state === "generating" || this.saving) return;
      this.correction = this.textarea.value;
      if (this.preview) {
        this.preview = null;
        this.state = "editing";
        this.setStatus(zh
          ? "修正说明已变化，请重新修正后再保存。"
          : "The correction changed. Generate a new preview before saving.");
      } else if (this.state === "error") {
        this.state = "editing";
        this.setStatus("");
      }
      this.renderState();
    };
    this.correctButton.onclick = () => {
      if (this.state === "generating") {
        this.stopGeneration();
        return;
      }
      if (this.saving || !this.correction.trim()) return;
      void this.generatePreview();
    };
    this.saveButton.onclick = () => {
      if (this.saving || !this.preview) return;
      void this.savePreview();
    };
    this.setStatus(this.statusMessage, this.statusError);
    this.renderState();
    if (settingsPage) {
      if (previewPage) this.cancelButton.focus({ preventScroll: true });
      else this.textarea.focus({ preventScroll: true });
    } else this.textarea.focus();
  }

  onClose(): void {
    this.disposed = true;
    this.generation += 1;
    this.generationController?.abort();
    this.generationController = null;
    if (!this.saving) this.finish("cancelled");
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private async generatePreview(): Promise<void> {
    const correction = this.correction.trim();
    if (!correction || this.saving || this.state === "generating") return;
    const controller = new AbortController();
    const generation = this.generation + 1;
    this.generation = generation;
    this.generationController = controller;
    this.preview = null;
    this.inlineConflict = false;
    this.state = "generating";
    this.setStatus(this.language !== "en"
      ? "正在生成修正后预览…"
      : "Generating corrected preview…");
    this.renderState();
    try {
      const preview = await this.actions.generate(correction, controller.signal);
      if (
        this.disposed
        || generation !== this.generation
        || controller.signal.aborted
      ) return;
      this.preview = preview;
      this.state = "preview";
      this.setStatus(this.language !== "en"
        ? "修正后预览已生成，确认无误后可保存。"
        : "The corrected preview is ready. Review it before saving.");
      if (this.settingsPageOptions) { this.setStatus(""); this.setSettingsPageStep("preview"); }
    } catch (error) {
      if (
        this.disposed
        || generation !== this.generation
        || controller.signal.aborted
      ) return;
      this.state = "error";
      this.setStatus(memoryCorrectionGenerationError(error, this.language), true);
    } finally {
      if (generation === this.generation) this.generationController = null;
      if (!this.disposed) this.renderState();
    }
  }

  private stopGeneration(): void {
    if (this.state !== "generating") return;
    this.generation += 1;
    const controller = this.generationController;
    this.generationController = null;
    this.state = "editing";
    this.setStatus(this.language !== "en"
      ? "已停止生成，尚未保存任何修改。"
      : "Generation stopped. No changes were saved.");
    controller?.abort();
    this.renderState();
  }

  private async savePreview(): Promise<void> {
    const preview = this.preview;
    if (!preview || this.saving) return;
    this.saving = true;
    this.state = "saving";
    this.setStatus(this.language !== "en"
      ? "正在保存新版本…"
      : "Saving the new version…");
    this.renderState();
    try {
      await this.actions.save(preview, this.correction.trim());
      if (this.embedded) { this.completed = true; this.correction = ""; this.preview = null; this.state = "editing"; this.setStatus(this.language !== "en" ? "已保存新版本。" : "New version saved."); }
      this.finish("saved");
      if (!this.disposed && !this.embedded) this.close();
    } catch (error) {
      if (isMemoryCorrectionRevisionConflict(error)) {
        if (this.embedded) {
          this.inlineConflict = true; this.state = "preview";
          this.setStatus(this.language !== "en" ? "记忆已变化，你的输入已保留；请重新核对后生成预览。" : "Memory changed. Your input is retained; review it and generate a new preview.", true);
          this.inlineOptions.onConflict?.(); return;
        }
        this.finish("conflict");
        if (!this.disposed) this.close();
        return;
      }
      if (this.disposed) {
        this.finish("cancelled");
        return;
      }
      this.state = "preview";
      this.setStatus(this.language !== "en"
        ? "保存失败，未写入任何修改；请重试。"
        : "Save failed. No changes were written. Try again.", true);
    } finally {
      this.saving = false;
      if (!this.disposed) this.renderState();
    }
  }

  private renderState(): void {
    if (this.embedded && !this.inlineEl) return;
    const zh = this.language !== "en";
    const generating = this.state === "generating";
    this.textarea.disabled = generating || this.saving || this.completed;
    if (this.inlineExitButton) this.inlineExitButton.disabled = this.submitting;
    this.cancelButton.disabled = this.saving;
    this.correctButton.disabled = this.saving || this.completed
      || (!generating && (!this.correction.trim() || !!this.settingsPageOptions?.unavailable));
    this.saveButton.disabled = this.saving
      || this.state !== "preview"
      || !this.preview || this.inlineConflict || this.completed || !!this.settingsPageOptions?.unavailable;
    this.correctButton.empty();
    if (generating) {
      this.correctButton.createSpan({
        cls: "echoink-memory-correction-spinner",
        attr: { "aria-hidden": "true" }
      });
      this.correctButton.createSpan({ text: zh ? "停止" : "Stop" });
    } else {
      this.correctButton.setText(this.preview ? (zh ? "重新生成预览" : "Regenerate preview") : (zh ? "生成预览" : "Generate preview"));
    }
    this.saveButton.setText(this.saving
      ? (zh ? "保存中…" : "Saving…")
      : (zh ? "确认保存" : "Confirm save"));
    if (this.embedded) this.correctButton.toggleClass("mod-cta", !!this.settingsPageOptions || !this.preview);
    this.modalEl.toggleClass("is-generating", generating);
    this.modalEl.toggleClass("is-saving", this.saving);
    this.renderPreview();
  }

  private renderPreview(): void {
    const preview = this.preview;
    this.previewBodyEl.empty();
    this.previewEl.toggleClass("is-hidden", !preview || !!this.settingsPageOptions && this.pageStep !== "preview");
    if (!preview) return;
    const zh = this.language !== "en";
    this.previewBodyEl.createDiv({
      cls: "echoink-memory-correction-card-title",
      text: this.settingsPageOptions ? (zh ? "修正后" : "After correction") : zh ? "修正后预览" : "Corrected preview"
    });
    this.addReadOnlyField(this.previewBodyEl, zh ? "标题" : "Title", preview.title);
    this.addReadOnlyField(this.previewBodyEl, zh ? "正文" : "Content", preview.content);
    this.addReadOnlyField(
      this.previewBodyEl,
      zh ? (this.settingsPageOptions ? "召回时机" : "何时可能想起") : "When it may be recalled",
      preview.recallWhen
    );
  }

  private setStatus(message: string, error = false): void {
    this.statusMessage = message; this.statusError = error;
    if (this.embedded && !this.inlineEl) return;
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", error);
  }

  private addReadOnlyField(container: HTMLElement, label: string, value: string): void {
    const field = container.createDiv({ cls: "echoink-memory-correction-field" });
    field.createDiv({ cls: "echoink-memory-correction-field-label", text: label });
    field.createDiv({ cls: "echoink-memory-correction-field-value", text: value });
  }

  private finish(value: MemoryCorrectionModalResult): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }
}

function memoryCorrectionGenerationError(
  error: unknown,
  language: "zh-CN" | "en"
): string {
  const message = error instanceof Error ? error.message : String(error);
  const zh = language !== "en";
  if (message.includes("provider_text_generation_timeout")) {
    return zh ? "生成超时，请重试。" : "Generation timed out. Try again.";
  }
  if (message.includes("provider_text_generation_aborted")) {
    return zh ? "生成已停止，尚未保存任何修改。" : "Generation stopped. No changes were saved.";
  }
  return zh ? "生成失败，请检查当前模型后重试。" : "Generation failed. Check the current model and try again.";
}

function isMemoryCorrectionRevisionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === "revision_conflict"
    || (typeof record.message === "string"
      && record.message.includes("revision_conflict"));
}

class SelectInputModal extends Modal {
  private value: string;
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly label: string,
    private readonly options: Array<{ value: string; label: string }>,
    private readonly done: (value: string | null) => void
  ) {
    super(app);
    this.value = options[0]?.value ?? "";
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.titleText });
    new Setting(contentEl).setName(this.label).addDropdown((dropdown) => {
      for (const option of this.options) dropdown.addOption(option.value, option.label);
      dropdown.setValue(this.value).onChange((value) => {
        this.value = value;
      });
    });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.finish(null);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("继续")
          .setCta()
          .onClick(() => {
            this.finish(this.value);
            this.close();
          })
      );
  }

  onClose(): void {
    this.finish(null);
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private finish(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }
}

class RequestInputModal extends Modal {
  private answers: Record<string, string[]> = {};
  private settled = false;

  constructor(app: App, private readonly questions: RequestInputQuestion[], private readonly done: (answers: Record<string, { answers: string[] }>) => void) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-theme-boundary");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Codex 需要你的选择" });
    for (const question of this.questions) {
      const options = Array.isArray(question.options) ? question.options : [];
      const setting = new Setting(contentEl).setName(question.header || question.question).setDesc(question.question || "");
      if (options.length > 0) {
        this.answers[question.id] = [options[0].label];
        setting.addDropdown((dropdown) => {
          for (const option of options) dropdown.addOption(option.label, option.label);
          dropdown.onChange((value) => {
            this.answers[question.id] = [value];
          });
        });
      } else {
        this.answers[question.id] = [""];
        setting.addText((text) => {
          if (question.isSecret) text.inputEl.type = "password";
          text.onChange((value) => {
            this.answers[question.id] = [value];
          });
        });
      }
    }
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.finish({});
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("提交")
          .setCta()
          .onClick(() => {
            const result = Object.fromEntries(Object.entries(this.answers).map(([key, value]) => [key, { answers: value }]));
            this.finish(result);
            this.close();
          })
      );
  }

  onClose(): void {
    this.finish({});
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private finish(value: Record<string, { answers: string[] }>): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }
}
