import { Notice, setIcon } from "obsidian";
import type { GenerationOutputKind, GenerationTemplate } from "../generation/types";
import { applyAmicroButton, applyDeleteButton, setAmicroButtonPending } from "./amicro-buttons";
import { createOriginButton, createOriginInput, createOriginRadioGroup } from "./origin-controls";
import { createSettingsGroup, createSettingsNavigationRow, createSettingsPage, createSettingsSection, showSettingsInlineConfirmation } from "./settings-v2";
import { defaultGenerationTemplates, generationTemplateIsEdited, normalizeGenerationTemplates, uniqueGenerationTemplateName, validateGenerationTemplate } from "./generation-templates";

interface GenerationTemplateSettingsHost {
  settings: { settingsLanguage: string; generationTemplates: GenerationTemplate[] };
  saveSettings(): Promise<void>;
}
interface SectionOptions { openList(): void; closeList(): void; openEditor(id: string | null): void; closeEditor(): void; redraw(): void }

/** The settings tab owns navigation; this controller owns unsaved fields across redraws. */
export class GenerationTemplatesSection {
  private draft: GenerationTemplate | null = null;
  private editingId: string | null = null;
  private pending = false;
  constructor(private readonly plugin: GenerationTemplateSettingsHost, private readonly options: SectionOptions) {}
  private get english(): boolean { return this.plugin.settings.settingsLanguage === "en"; }
  private text(zh: string, en: string): string { return this.english ? en : zh; }
  private templates(): GenerationTemplate[] { return normalizeGenerationTemplates(this.plugin.settings.generationTemplates); }

  open(id: string | null): void {
    this.editingId = id;
    const saved = id ? this.templates().find(item => item.id === id) : null;
    this.draft = saved ? { ...saved } : { id: `custom-${crypto.randomUUID()}`, name: "", description: "", instructions: "", outputKind: "markdown" };
  }

  editorFocusKey(): string { return this.editingId ? `knowledge:generation-template:${this.editingId}` : "knowledge:generation-template:add"; }

  renderNavigation(parent: HTMLElement): void {
    const templates = this.templates();
    createSettingsNavigationRow(parent, { title: this.text("生成模板", "Generation templates"),
      value: this.text(`${templates.length} 个`, String(templates.length)), focusKey: "knowledge:generation-templates", onActivate: () => this.options.openList() });
  }

  renderList(parent: HTMLElement): void {
    const page = createSettingsPage(parent, { title: this.text("生成模板", "Generation templates"), detail: true,
      backLabel: this.text("返回模块", "Back to modules"), onBack: () => this.options.closeList() });
    page.addClass("echoink-generation-templates-page");
    const heading = page.querySelector<HTMLElement>(".echoink-settings-page-header")!;
    const add = createOriginButton(heading, { cls: "icon-button is-icon", attr: { "aria-label": this.text("新增模板", "Add template"), "data-echoink-focus-key": "knowledge:generation-template:add" } });
    setIcon(add, "plus"); add.onclick = () => this.options.openEditor(null);
    const body = createSettingsGroup(createSettingsSection(page, { surface: "flat" }));
    body.addClass("echoink-generation-template-list");
    for (const template of this.templates()) {
      const row = createSettingsNavigationRow(body, { title: template.name, description: template.description || undefined,
        focusKey: `knowledge:generation-template:${template.id}`, onActivate: () => this.options.openEditor(template.id) });
      row.addClass("echoink-generation-template-row");
      const icon = row.createSpan({ cls: "echoink-generation-template-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, template.outputKind === "canvas" ? "layout-dashboard" : "file-text"); row.prepend(icon);
      if (generationTemplateIsEdited(template)) row.querySelector(".echoink-settings-navigation-title")?.createSpan({ cls: "echoink-generation-template-edited", text: this.text("已修改", "Edited") });
    }
  }

  renderEditor(parent: HTMLElement): void {
    if (!this.draft) this.open(this.editingId);
    const draft = this.draft!;
    const page = createSettingsPage(parent, { title: this.editingId ? draft.name : this.text("新模板", "New template"), detail: true,
      backLabel: this.text("返回生成模板", "Back to templates"), onBack: () => { if (!this.pending) this.options.closeEditor(); } });
    page.addClass("echoink-generation-template-editor");
    const form = page.createDiv({ cls: "echoink-generation-template-form" });
    const name = this.input(form, "name", this.text("名称", "Name"), draft.name, value => { draft.name = value; });
    const description = this.input(form, "description", this.text("说明", "Description"), draft.description, value => { draft.description = value; });
    description.input.placeholder = this.text("一句话，显示在模板卡片上", "One sentence shown on the template card");
    const output = form.createDiv({ cls: "echoink-generation-template-field" });
    output.createDiv({ cls: "echoink-generation-template-label", text: this.text("输出", "Output") });
    const segments = createOriginRadioGroup(output, draft.outputKind, this.text("输出类型", "Output type"), value => {
      draft.outputKind = value as GenerationOutputKind; segments.element.dataset.outputKind = value;
    });
    segments.element.addClass("echoink-generation-output-segments"); segments.element.dataset.outputKind = draft.outputKind;
    for (const [value, label] of [["markdown", "Markdown"], ["canvas", "Canvas 导图"]]) {
      const item = segments.element.createDiv({ cls: "echoink-generation-output-segment" });
      item.createSpan({ text: label, attr: { "aria-hidden": "true" } });
      segments.addItem(item, value, false).setAttr("aria-label", label);
    }
    const instructions = form.createDiv({ cls: "echoink-generation-template-field" });
    instructions.createEl("label", { cls: "echoink-generation-template-label", text: this.text("写作要求", "Writing instructions"), attr: { for: `generation-${draft.id}-instructions` } });
    const textarea = instructions.createEl("textarea", { cls: "echoink-generation-template-instructions", attr: { id: `generation-${draft.id}-instructions`, "aria-label": this.text("写作要求", "Writing instructions") } });
    textarea.value = draft.instructions; textarea.oninput = () => { draft.instructions = textarea.value; };
    const requirementsError = instructions.createDiv({ cls: "echoink-generation-field-error", attr: { id: `generation-${draft.id}-instructions-error`, role: "alert" } });
    const status = form.createDiv({ cls: "echoink-generation-field-error", attr: { role: "alert" } });
    const footer = form.createDiv({ cls: "echoink-generation-template-actions" });
    const secondary = footer.createDiv({ cls: "echoink-generation-template-secondary" });
    const saved = this.editingId ? this.templates().find(item => item.id === this.editingId) : null;
    if (saved?.builtin && generationTemplateIsEdited(saved)) {
      const restore = createOriginButton(secondary, { cls: "text-button", text: this.text("恢复默认", "Restore defaults") });
      restore.onclick = () => showSettingsInlineConfirmation(form, restore, { message: this.text("恢复这个模板的默认内容？", "Restore this template's default content?"), confirmLabel: this.text("恢复", "Restore"), cancelLabel: this.text("不恢复", "Cancel"), danger: false, onConfirm: async () => {
        const original = defaultGenerationTemplates().find(item => item.id === saved.id)!;
        const errors = validateGenerationTemplate(original, this.templates());
        if (errors.name) { status.setText(this.text("默认名称已被其他模板使用，请先修改重名模板", "The default name is used by another template. Rename it first.")); return; }
        await this.persist(this.templates().map(item => item.id === saved.id ? original : item), status, () => { this.open(saved.id); this.options.redraw(); });
      } });
    }
    if (saved && !saved.builtin) {
      const duplicate = createOriginButton(secondary, { cls: "button", text: this.text("复制", "Duplicate") });
      duplicate.onclick = () => { if (this.pending) return; this.editingId = null; this.draft = { ...draft, id: `custom-${crypto.randomUUID()}`, name: uniqueGenerationTemplateName(this.templates(), draft.name), builtin: false }; this.options.redraw(); };
      const remove = createOriginButton(secondary, { cls: "button settings-danger", text: this.text("删除", "Delete") }); applyDeleteButton(remove);
      remove.onclick = () => showSettingsInlineConfirmation(form, remove, { message: this.text(`删除模板「${saved.name}」？`, `Delete “${saved.name}”?`), confirmLabel: this.text("删除", "Delete"), cancelLabel: this.text("取消", "Cancel"), deleteAction: true,
        onConfirm: () => this.persist(this.templates().filter(item => item.id !== saved.id), status, () => { this.editingId = null; this.options.closeEditor(); }) });
    }
    const primary = footer.createDiv({ cls: "echoink-generation-template-primary" });
    const cancel = createOriginButton(primary, { cls: "button", text: this.text("取消", "Cancel") }); cancel.onclick = () => { if (!this.pending) this.options.closeEditor(); };
    const save = createOriginButton(primary, { cls: "button mod-cta", text: this.text("保存", "Save") }); applyAmicroButton(save, { variant: "primary" });
    save.onclick = () => {
      if (this.pending) return;
      const errors = validateGenerationTemplate(draft, this.templates());
      name.error.setText(errors.name ? this.english ? errors.name === "名称不能为空" ? "Name is required" : "A template with this name already exists" : errors.name : "");
      requirementsError.setText(errors.instructions ? this.text(errors.instructions, "Writing instructions are required") : "");
      name.input.setAttr("aria-invalid", String(Boolean(errors.name))); name.input.setAttr("aria-describedby", name.error.id);
      textarea.setAttr("aria-invalid", String(Boolean(errors.instructions))); textarea.setAttr("aria-describedby", requirementsError.id);
      if (errors.name || errors.instructions) { (errors.name ? name.input : textarea).focus(); return; }
      const next = { ...draft, name: draft.name.trim(), description: draft.description.trim(), instructions: draft.instructions.trim() };
      const templates = this.templates();
      const updated = templates.some(item => item.id === next.id) ? templates.map(item => item.id === next.id ? next : item) : [...templates, next];
      save.disabled = true; save.setText(this.text("保存中…", "Saving…")); setAmicroButtonPending(save, true);
      void this.persist(updated, status, () => { this.editingId = next.id; new Notice(this.text(`已保存模板「${next.name}」`, `Saved “${next.name}”`)); this.options.closeEditor(); }).finally(() => { save.disabled = false; save.setText(this.text("保存", "Save")); setAmicroButtonPending(save, false); });
    };
  }

  private input(parent: HTMLElement, key: string, label: string, value: string, change: (value: string) => void) {
    const field = parent.createDiv({ cls: "echoink-generation-template-field" });
    const id = `generation-${this.draft!.id}-${key}`;
    field.createEl("label", { cls: "echoink-generation-template-label", text: label, attr: { for: id } });
    const input = createOriginInput(field, { value, attr: { id, "aria-label": label } }); input.oninput = () => change(input.value);
    const error = field.createDiv({ cls: "echoink-generation-field-error", attr: { id: `${id}-error`, role: "alert" } });
    return { input, error };
  }

  private async persist(templates: GenerationTemplate[], status: HTMLElement, done: () => void): Promise<void> {
    if (this.pending) return;
    this.pending = true; status.setText("");
    const previous = this.plugin.settings.generationTemplates;
    this.plugin.settings.generationTemplates = templates;
    try { await this.plugin.saveSettings(); this.pending = false; done(); }
    catch (error) {
      if (this.plugin.settings.generationTemplates === templates) this.plugin.settings.generationTemplates = previous;
      status.setText(this.text("保存失败：", "Save failed: ") + (error instanceof Error ? error.message : String(error)));
    } finally { this.pending = false; }
  }
}
