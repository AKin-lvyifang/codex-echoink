import { Modal } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { StoredAttachment } from "../settings/settings";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import type { PdfNavigationStart, PdfOptions } from "../pdf-reading/types";
import { workbenchModuleOwner } from "./module-navigation";

let nextModalId = 0;

/** A selection is only local metadata. The task admission owns binary preparation. */
export class PdfReadingUploadModal extends Modal {
  private readonly formId = `echoink-pdf-upload-${++nextModalId}`;
  private attachment: Readonly<StoredAttachment> | null = null;
  private directory = "";
  private translation = true;
  private reading = true;
  private summary = true;
  private language: string;
  private busy = false;
  private closed = true;
  private error = "";
  private fileInput!: HTMLInputElement;
  private startButton!: HTMLButtonElement;
  private fileArea!: HTMLElement;
  private status!: HTMLElement;
  private owner!: HTMLElement;
  private releases: Array<() => void> = [];
  private lockedControls: Array<{ disabled: boolean }> = [];
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly returnFocus?: HTMLElement) {
    super(plugin.app);
    this.language = plugin.settings.pdfReading.translationLanguage;
    this.directory = plugin.pdfReading?.defaultOriginalDirectory() ?? "";
  }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private options(): PdfOptions {
    return { engine: this.plugin.settings.pdfReading.engine, translation: this.translation, translationLanguage: this.language.trim(), reading: this.reading, summary: this.summary, wiki: this.reading || this.summary };
  }
  private button(host: HTMLElement, text: string, action: () => unknown, variant = "secondary"): HTMLButtonElement {
    const button = createOriginButton(host, { text, cls: `pdf-page-button is-${variant}` });
    button.onclick = () => { if (!button.disabled) action(); };
    return button;
  }
  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("echoink-pdf-upload-modal", "echoink-theme-boundary");
    this.setTitle(this.t("上传 PDF", "Upload PDF"));
    const content = this.contentEl; content.addClass("pdf-upload-content"); content.empty();
    const body = content.createDiv({ cls: "pdf-upload-body" });
    this.fileInput = body.createEl("input", { attr: { type: "file", accept: ".pdf,application/pdf", "aria-label": this.t("选择 PDF 文件", "Choose a PDF file") } });
    this.fileInput.hidden = true;
    this.fileInput.onchange = () => { const files = Array.from(this.fileInput.files ?? []); if (files.length) this.selectFiles(files); this.fileInput.value = ""; };
    const drop = body.createDiv({ cls: "pdf-upload-file" });
    this.fileArea = drop.createDiv({ cls: "pdf-upload-file-info" });
    this.button(drop, this.t("选择文件", "Choose file"), () => this.fileInput.click()).dataset.pdfUpload = "choose";
    drop.ondragover = event => { event.preventDefault(); };
    drop.ondrop = event => { event.preventDefault(); if (!this.busy) this.selectFiles(Array.from(event.dataTransfer?.files ?? [])); };
    const directory = body.createDiv({ cls: "pdf-upload-field" });
    const directoryLabel = directory.createEl("label", { text: this.t("原 PDF 保存位置", "Save original PDF to"), attr: { id: `${this.formId}-directory-label` } });
    const directories = this.plugin.pdfReading?.originalDirectories() ?? [];
    if (!directories.includes(this.directory)) this.directory = "";
    if (directories.length) {
      const choices = [...(!this.directory ? [{ value: "", label: this.t("请选择资料来源位置", "Choose a source folder"), disabled: true }] : []), ...directories.map(value => ({ value, label: value }))];
      const select = createOriginSelect(directory, { attr: { "aria-labelledby": directoryLabel.id }, cls: "pdf-upload-directory" }, choices, this.directory, this.app).element;
      select.onchange = () => { this.directory = select.value; this.error = ""; this.update(); };
      this.lockedControls.push(select);
    } else {
      directory.createDiv({ cls: "pdf-page-message", text: this.t("还没有可写的资料来源位置", "No writable source folder is configured") });
      this.button(directory, this.t("去设置资料来源", "Configure source folders"), () => { this.close(); void this.plugin.openEchoInkKnowledgeSettings(); }, "tertiary");
    }
    const outputs = body.createEl("fieldset", { cls: "pdf-upload-outputs" });
    outputs.createEl("legend", { text: this.t("要哪些成果", "Outputs") });
    this.checkbox(outputs, "raw", this.t("提取原文（用于引用来源）", "Extract source text (for citations)"), true, () => {}, true);
    this.checkbox(outputs, "translation", this.t("翻译", "Translation"), this.translation, value => { this.translation = value; language.disabled = !value; });
    const languageField = outputs.createDiv({ cls: "pdf-upload-field pdf-upload-language" });
    languageField.createEl("label", { text: this.t("翻译语言", "Translation language"), attr: { for: `${this.formId}-language` } });
    const language = createOriginInput(languageField, { value: this.language, attr: { id: `${this.formId}-language` } });
    language.oninput = () => { this.language = language.value; this.error = ""; this.update(); };
    language.disabled = !this.translation;
    this.lockedControls.push(language);
    this.checkbox(outputs, "reading", this.t("精读", "Close reading"), this.reading, value => { this.reading = value; });
    this.checkbox(outputs, "summary", this.t("摘要", "Summary"), this.summary, value => { this.summary = value; });
    this.owner = body.createDiv({ cls: "pdf-upload-owner" });
    this.status = body.createDiv({ cls: "pdf-page-message", attr: { role: "status", "aria-live": "polite", id: `${this.formId}-status` } });
    const footer = content.createDiv({ cls: "pdf-upload-footer" });
    this.button(footer, this.t("取消", "Cancel"), () => this.close(), "tertiary").dataset.pdfUpload = "cancel";
    this.startButton = this.button(footer, this.t("开始研究", "Start research"), () => { void this.start(); }, "primary");
    this.startButton.dataset.pdfUpload = "start";
    this.startButton.setAttribute("aria-describedby", this.status.id);
    applyAmicroButton(this.startButton, { variant: "primary" });
    const host = this.plugin.pdfReading;
    if (host) {
      this.releases.push(host.api.subscribe(() => this.update()));
      this.releases.push(host.api.deps.access.subscribe(() => this.update()));
    }
    this.update();
  }
  private checkbox(host: HTMLElement, key: string, text: string, checked: boolean, change: (value: boolean) => void, fixed = false): void {
    const row = host.createDiv({ cls: "pdf-upload-check" });
    const labelId = `${this.formId}-${key}-label`;
    const check = createOriginCheck(row, { attr: { id: `${this.formId}-${key}`, "aria-labelledby": labelId } });
    check.checked = checked; check.disabled = fixed; check.dataset.pdfUpload = key;
    check.onchange = () => { if (fixed || this.busy) return; change(check.checked); this.error = ""; this.update(); };
    row.createEl("label", { text, attr: { id: labelId, for: check.id } });
    if (!fixed) this.lockedControls.push(check);
  }
  private selectFiles(files: File[]): void {
    if (this.busy || this.closed) return;
    this.attachment = null; this.error = "";
    const file = files[0];
    if (files.length !== 1) this.error = this.t("一次请选择一份 PDF", "Choose one PDF at a time");
    else if (!/\.pdf$/iu.test(file.name)) this.error = this.t("请选择 PDF 文件", "Choose a PDF file");
    else if (!file.size) this.error = this.t("这个 PDF 是空文件", "This PDF is empty");
    else if (file.size > 20 * 1024 * 1024) this.error = this.t("PDF 不能超过 20 MiB", "PDF must be no larger than 20 MiB");
    else {
      let path = (file as File & { path?: string }).path;
      if (!path) {
        const electronRequire = window.require ?? globalThis.require;
        try { path = (electronRequire?.("electron") as { webUtils?: { getPathForFile(file: File): string } } | undefined)?.webUtils?.getPathForFile(file); }
        catch { /* A missing host path is shown inline; no binary is read here. */ }
      }
      if (!path) this.error = this.t("无法读取这个 PDF 的本地路径，请重新选择", "The PDF's local path is unavailable. Choose it again");
      else this.attachment = Object.freeze({ type: "file", name: file.name, path, mimeType: "application/pdf", sizeBytes: file.size });
    }
    this.update();
  }
  private unavailable(): string {
    if (!this.attachment) return this.t("请先选择一份 PDF", "Choose a PDF first");
    if (!(this.plugin.pdfReading?.originalDirectories() ?? []).includes(this.directory)) return this.t("请先设置可写的资料来源位置", "Configure a writable source folder first");
    if (this.translation && !this.language.trim()) return this.t("请填写翻译语言", "Enter a translation language");
    return this.plugin.pdfNavigationStartReason(this.options());
  }
  private update(): void {
    if (this.closed || !this.startButton) return;
    this.fileArea.empty();
    this.fileArea.createEl("strong", { text: this.attachment?.name ?? this.t("选择或拖入一份 PDF", "Choose or drop one PDF") });
    if (this.attachment?.sizeBytes !== undefined) this.fileArea.createSpan({ text: pdfFileSize(this.attachment.sizeBytes) });
    const choose = this.contentEl.querySelector<HTMLButtonElement>('[data-pdf-upload="choose"]')!;
    choose.setText(this.attachment ? this.t("换一个", "Replace") : this.t("选择文件", "Choose file")); choose.disabled = this.busy;
    const owner = workbenchModuleOwner(this.plugin, "pdf-reading");
    this.owner.setText(this.t(`交给 ${owner.name}`, `Assigned to ${owner.name}`));
    const reason = this.unavailable();
    this.status.setText(this.busy ? this.t("正在准备…", "Preparing…") : this.error || reason);
    this.status.toggleClass("is-error", Boolean(this.error));
    this.startButton.disabled = this.busy || Boolean(reason);
    this.startButton.setText(this.busy ? this.t("正在准备…", "Preparing…") : this.t("开始研究", "Start research"));
    setAmicroButtonPending(this.startButton, this.busy);
  }
  private async start(): Promise<void> {
    if (this.busy || this.closed || this.unavailable() || !this.attachment) return;
    const input: PdfNavigationStart = Object.freeze({ attachment: this.attachment, originalDirectory: this.directory, options: Object.freeze(this.options()) });
    this.busy = true; this.error = "";
    const previous = this.lockedControls.map(control => control.disabled);
    this.lockedControls.forEach(control => { control.disabled = true; }); this.update();
    try {
      await this.plugin.validatePdfNavigationStart(input);
      // Closing while validating is a cancellation of this unsubmitted form.
      if (this.closed) return;
      await this.plugin.startPdfNavigationTask(input);
      if (!this.closed) this.close();
    } catch (error) {
      if (!this.closed) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (!this.closed) { this.lockedControls.forEach((control, index) => { control.disabled = previous[index]; }); this.update(); }
    }
  }
  onClose(): void {
    this.closed = true;
    for (const release of this.releases.splice(0)) release();
    this.attachment = null;
    disposeOriginControls(this.contentEl);
    this.lockedControls = [];
    this.contentEl.empty();
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}

export function pdfFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
