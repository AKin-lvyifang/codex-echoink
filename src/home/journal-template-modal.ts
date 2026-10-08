import { Modal, Notice, TFile, type App } from "obsidian";
import {
  BUILT_IN_JOURNAL_TEMPLATES,
  DEFAULT_JOURNAL_TEMPLATE_ID,
  decodeImportedMarkdown,
  type ImportedJournalTemplate
} from "./home-workbench-model";
import {
  HomeWorkbenchDataService,
  type HomeCustomTemplateSummary,
  type HomeJournalTemplateChoice
} from "./home-workbench-data";
import { homeCopy } from "./home-i18n";
import type { SettingsLanguage } from "../settings/settings";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { getProPluginAccess, requireProPlugin, unavailableCapabilityAccess } from "../membership/access";
import type { CapabilityAccess } from "../membership/types";
import { ProPluginControls } from "../ui/pro-plugin-controls";

interface JournalTemplateModalOptions {
  service: HomeWorkbenchDataService;
  customTemplates: HomeCustomTemplateSummary[];
  date: Date;
  language: SettingsLanguage;
  onCreated?: (file: TFile) => void;
  onEnglish?: (file: TFile) => Promise<void>;
  englishAccess?: CapabilityAccess;
  englishEnabled?: () => boolean;
}

export class JournalTemplateModal extends Modal {
  private selected: HomeJournalTemplateChoice = {
    kind: "built-in",
    template: BUILT_IN_JOURNAL_TEMPLATES.find((template) => template.id === DEFAULT_JOURNAL_TEMPLATE_ID)!
  };
  private imported: ImportedJournalTemplate | null = null;
  private importState: "idle" | "reading" | "ready" | "saving" | "saved" | "failed" | "conflict" = "idle";
  private status = "";
  private safeCopyPath = "";
  private submitting = false;
  private englishControls: ProPluginControls | null = null;

  constructor(app: App, private readonly options: JournalTemplateModalOptions) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("echoink-journal-template-modal");
    this.render();
  }

  onClose(): void {
    this.englishControls?.dispose();
    this.englishControls = null;
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
  }

  private render(focusChoice?: string): void {
    this.englishControls?.dispose();
    this.englishControls = null;
    const copy = this.copy;
    const { contentEl } = this;
    disposeOriginControls(contentEl);
    contentEl.empty();
    const head = contentEl.createDiv({ cls: "echoink-journal-modal-head" });
    const headCopy = head.createDiv();
    headCopy.createEl("h2", { text: copy.modal.title });
    headCopy.createEl("p", { text: copy.modal.introduction });
    const close = head.createEl("button", {
      cls: "echoink-journal-modal-close",
      text: copy.modal.close,
      attr: { type: "button", "aria-label": copy.modal.closeTemplatePicker }
    });
    close.onclick = () => this.close();

    contentEl.createEl("h3", { text: copy.modal.builtInTemplates });
    const builtIns = contentEl.createDiv({ cls: "echoink-journal-template-grid" });
    for (const template of BUILT_IN_JOURNAL_TEMPLATES) {
      const active = this.selected.kind === "built-in" && this.selected.template.id === template.id;
      const button = builtIns.createEl("button", {
        cls: `echoink-journal-template-card ${active ? "is-selected" : ""}`,
        attr: { type: "button", "aria-pressed": String(active), "data-template-choice": `built-in:${template.id}` }
      });
      const display = copy.template.display(template.id);
      button.createEl("strong", { text: display.name });
      button.createSpan({ text: display.description });
      if (template.id === DEFAULT_JOURNAL_TEMPLATE_ID) button.createEl("small", { text: copy.modal.systemDefault });
      button.onclick = () => {
        this.selected = { kind: "built-in", template };
        this.render(`built-in:${template.id}`);
      };
    }

    const customHead = contentEl.createDiv({ cls: "echoink-journal-custom-head" });
    customHead.createEl("h3", { text: copy.modal.myTemplates });
    customHead.createSpan({ text: copy.modal.templateCount(this.options.customTemplates.length) });
    const custom = contentEl.createDiv({ cls: "echoink-journal-custom-list" });
    if (!this.options.customTemplates.length) {
      custom.createDiv({ cls: "echoink-journal-empty", text: copy.modal.noImportedTemplates });
    }
    for (const template of this.options.customTemplates) {
      const active = this.selected.kind === "custom" && this.selected.path === template.path;
      const button = custom.createEl("button", {
        cls: `echoink-journal-custom-template ${active ? "is-selected" : ""}`,
        attr: { type: "button", "aria-pressed": String(active), "data-template-choice": `custom:${template.path}` }
      });
      button.createEl("strong", { text: template.name });
      button.createSpan({ text: template.path });
      button.onclick = () => {
        this.selected = { kind: "custom", path: template.path, name: template.name };
        this.render(`custom:${template.path}`);
      };
    }

    const importPanel = contentEl.createDiv({ cls: "echoink-journal-import-panel" });
    const importCopy = importPanel.createDiv();
    importCopy.createEl("strong", { text: copy.modal.importMarkdown });
    importCopy.createSpan({ text: copy.modal.importDescription });
    const choose = importPanel.createEl("button", {
      cls: "mod-cta",
      text: this.importState === "reading" ? copy.modal.reading : copy.modal.chooseMarkdownFile,
      attr: { type: "button" }
    });
    choose.disabled = this.importState === "reading" || this.importState === "saving";
    const input = importPanel.createEl("input", {
      cls: "echoink-journal-file-input",
      attr: { type: "file", accept: ".md,text/markdown" }
    });
    choose.onclick = () => input.click();
    input.onchange = () => void this.readImport(input.files?.[0] ?? null);

    if (this.imported) this.renderImportPreview(contentEl);
    if (this.status) {
      contentEl.createDiv({
        cls: `echoink-journal-status is-${this.importState}`,
        text: this.status,
        attr: { role: this.importState === "failed" ? "alert" : "status", "aria-live": "polite" }
      });
    }

    const actions = contentEl.createDiv({ cls: "echoink-journal-modal-actions" });
    const cancel = actions.createEl("button", { text: copy.modal.cancel, attr: { type: "button" } });
    cancel.onclick = () => this.close();
    const use = actions.createEl("button", {
      cls: "mod-cta",
      text: this.submitting ? copy.modal.creating : copy.modal.useTemplate(this.choiceDisplayName()),
      attr: { type: "button" }
    });
    use.disabled = this.submitting || this.importState === "reading" || this.importState === "saving";
    use.onclick = () => void this.createJournal();
    if (this.options.onEnglish) {
      const english = createOriginButton(actions, {
        text: this.options.language === "en" ? "Write English diary" : "写英文日记",
        attr: { "aria-label": this.options.language === "en" ? "Write an English diary using the selected template" : "使用当前模板写英文日记" }
      });
      const access = this.options.englishAccess ?? unavailableCapabilityAccess;
      this.englishControls = new ProPluginControls(access, () => getProPluginAccess(access, this.options.englishEnabled?.() ?? false));
      this.englishControls.bind(english, { businessDisabled: () => this.submitting || this.importState === "reading" || this.importState === "saving" || !this.options.englishEnabled?.() });
      english.onclick = () => void this.createJournal(true);
    }
    if (focusChoice) {
      window.requestAnimationFrame(() => {
        this.contentEl.querySelector<HTMLButtonElement>(`[data-template-choice="${CSS.escape(focusChoice)}"]`)?.focus();
      });
    }
  }

  private renderImportPreview(container: HTMLElement): void {
    if (!this.imported) return;
    const copy = this.copy;
    const preview = container.createDiv({ cls: "echoink-journal-import-preview" });
    const meta = preview.createDiv({ cls: "echoink-journal-import-meta" });
    meta.createEl("strong", { text: this.imported.name });
    meta.createSpan({ text: copy.modal.previewMeta(this.imported.lineCount, this.imported.frontmatterKeys.length) });
    preview.createEl("pre", { text: this.imported.content.split(/\r?\n/u).slice(0, 12).join("\n") || copy.modal.blankTemplate });
    const save = preview.createEl("button", {
      text: this.importState === "saving" ? copy.modal.saving : copy.modal.saveToMyTemplates,
      attr: { type: "button" }
    });
    save.disabled = this.importState === "saving" || this.importState === "saved";
    save.onclick = () => void this.saveImport("cancel");
    if (this.importState === "conflict" && this.safeCopyPath) {
      const safeCopyButton = preview.createEl("button", {
        cls: "mod-cta",
        text: copy.modal.keepAs(basename(this.safeCopyPath)),
        attr: { type: "button" }
      });
      safeCopyButton.onclick = () => void this.saveImport("safe-copy");
    }
  }

  private async readImport(file: File | null): Promise<void> {
    if (!file) return;
    this.importState = "reading";
    this.status = this.copy.modal.readingFile(file.name);
    this.imported = null;
    this.safeCopyPath = "";
    this.render();
    try {
      const content = decodeImportedMarkdown(await file.arrayBuffer(), this.options.language);
      this.imported = this.options.service.previewImportedTemplate(file.name, content, this.options.language);
      this.importState = "ready";
      this.status = this.copy.modal.importReadComplete;
    } catch (error) {
      this.importState = "failed";
      this.status = this.copy.modal.readFailed(errorMessage(error));
    }
    this.render();
  }

  private async saveImport(resolution: "cancel" | "safe-copy"): Promise<void> {
    if (!this.imported) return;
    this.importState = "saving";
    this.status = this.copy.modal.savingLocalTemplate;
    this.render();
    try {
      const result = await this.options.service.saveImportedTemplate(this.imported, resolution, this.options.language);
      if (result.status === "conflict") {
        this.importState = "conflict";
        this.safeCopyPath = result.safeCopyPath ?? "";
        this.status = this.copy.modal.duplicateTemplate(result.path);
      } else {
        this.importState = "saved";
        this.status = this.copy.modal.saved(result.path);
        this.safeCopyPath = "";
        this.selected = { kind: "custom", path: result.path, name: this.imported.name };
        if (!this.options.customTemplates.some((template) => template.path === result.path)) {
          this.options.customTemplates.push({ id: `custom:${result.path}`, name: basename(result.path), path: result.path });
        }
      }
    } catch (error) {
      this.importState = "failed";
      this.status = this.copy.modal.saveFailed(errorMessage(error));
    }
    this.render();
  }

  private async createJournal(english = false): Promise<void> {
    if (this.submitting) return;
    if (english) {
      try {
        requireProPlugin(this.options.englishAccess ?? unavailableCapabilityAccess);
        if (!this.options.englishEnabled?.()) throw new Error("英文日记已停用。");
      } catch (error) { new Notice(errorMessage(error)); return; }
    }
    this.submitting = true;
    this.status = this.copy.modal.creatingJournal;
    this.render();
    try {
      const result = await this.options.service.createOrOpenJournal(this.selected, this.options.date, this.options.language);
      if (english && this.options.onEnglish) await this.options.onEnglish(result.file);
      else await this.app.workspace.getLeaf("tab").openFile(result.file, { active: true });
      new Notice(result.created ? this.copy.modal.journalCreated(result.file.path) : this.copy.modal.journalAlreadyExists(result.file.path));
      this.options.onCreated?.(result.file);
      this.close();
    } catch (error) {
      this.submitting = false;
      this.importState = "failed";
      this.status = this.copy.modal.createFailed(errorMessage(error));
      this.render();
    }
  }

  private get copy() {
    return homeCopy(this.options.language);
  }

  private choiceDisplayName(): string {
    return this.selected.kind === "built-in"
      ? this.copy.template.display(this.selected.template.id).name
      : this.selected.name;
  }
}

function basename(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/iu, "") ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
