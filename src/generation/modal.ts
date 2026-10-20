import { Modal, Notice, setIcon } from "obsidian";
import type EchoInkPlugin from "../main";
import type { TurnOptions } from "../ui/turn-options";
import type { GenerationService } from "./service";
import type { GenerationRequest, GenerationTemplate } from "./types";
import { normalizeGenerationTemplates, uniqueGenerationTemplateName } from "../settings/generation-templates";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginRadioGroup, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { buildVaultNoteMentionCatalog } from "../ui/codex-view/note-mentions";
import { mountGenerationNotePicker } from "./note-picker";

export type GenerationModalService = Pick<GenerationService, "availableNotes" | "assessSources" | "disabledReason" | "createRequest" | "outputDirectory" | "recommend">;
export interface GenerationModalOptions {
  sourcePaths: readonly string[];
  sessionId?: string;
  templateId?: string;
  service: GenerationModalService;
  turnOptions(): TurnOptions;
  onSubmit(request: GenerationRequest, turnOptions: TurnOptions): Promise<void>;
}

export function openGenerationTemplateSettings(plugin: EchoInkPlugin, id: string): void {
  plugin.prepareDesktopSettingsRoute({ tab: "modules", section: "knowledgeBase", focus: `knowledge:generation-template:${id}` });
  const setting = (plugin.app as { setting?: { open?(): void; openTabById?(id: string): void } }).setting;
  if (!setting?.open || !setting.openTabById) { new Notice("无法打开 EchoInk 设置页"); return; }
  setting.open(); setting.openTabById(plugin.manifest.id);
}

/** A fresh modal owns its selections and temporary recommendations for one invocation. */
export class GenerationModal extends Modal {
  private readonly paths: string[];
  private readonly selectedPaths: Set<string>;
  private readonly templates: GenerationTemplate[];
  private selectedTemplateId: string;
  private temporaryTemplates: GenerationTemplate[] = [];
  private active = false;
  private submitting = false;
  private assessing = false;
  private assessmentError = "";
  private submitError = "";
  private recommendationError = "";
  private recommending = false;
  private assessmentVersion = 0;
  private recommendationVersion = 0;
  private assessmentAbort: AbortController | null = null;
  private recommendationAbort: AbortController | null = null;
  private sourceSummary!: HTMLElement;
  private sourcesEl!: HTMLElement;
  private sourceListEl!: HTMLElement;
  private templateEl!: HTMLElement;
  private customEl!: HTMLElement;
  private recommendationsEl!: HTMLElement;
  private destinationEl!: HTMLElement;
  private reasonEl!: HTMLElement;
  private generateButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private recommendationButton!: HTMLButtonElement;
  private recommendationLabel!: HTMLElement;
  private recommendationStatus!: HTMLElement;
  private pickerDispose: (() => void) | null = null;
  private sourceExpanded = false;
  private customInstructions = "";
  private saveCustom = false;
  private customName: string;

  constructor(private readonly plugin: EchoInkPlugin, private readonly options: GenerationModalOptions) {
    super(plugin.app);
    this.paths = [...new Set(options.sourcePaths)]; this.selectedPaths = new Set(this.paths);
    this.templates = normalizeGenerationTemplates(plugin.settings.generationTemplates);
    this.selectedTemplateId = this.templates.some(item => item.id === options.templateId) ? options.templateId! : this.templates[0].id;
    this.customName = uniqueGenerationTemplateName(this.templates);
    this.sourceExpanded = !this.paths.length;
  }

  onOpen(): void {
    this.active = true;
    this.plugin.applyAppearanceTheme(this.modalEl.ownerDocument);
    this.modalEl.addClass("echoink-generation-modal", "echoink-theme-boundary"); this.setTitle("从资料生成");
    const content = this.contentEl; content.empty();
    const body = content.createDiv({ cls: "echoink-generation-modal-body" });
    const sourceHeader = body.createDiv({ cls: "echoink-generation-source-heading" });
    sourceHeader.createSpan({ cls: "echoink-generation-label", text: "资料" });
    this.sourceSummary = sourceHeader.createSpan({ cls: "echoink-generation-source-summary" });
    const change = createOriginButton(sourceHeader, { cls: "text-button", text: this.sourceExpanded ? "收起" : "更改", attr: { "aria-expanded": String(this.sourceExpanded) } });
    this.sourcesEl = body.createDiv({ cls: "echoink-generation-sources" }); this.sourcesEl.hidden = !this.sourceExpanded;
    change.onclick = () => { this.sourceExpanded = !this.sourceExpanded; this.sourcesEl.hidden = !this.sourceExpanded; change.setAttr("aria-expanded", String(this.sourceExpanded)); change.setText(this.sourceExpanded ? "收起" : "更改"); };
    this.sourceListEl = this.sourcesEl.createDiv({ cls: "echoink-generation-source-list" });
    this.renderSources();
    body.createDiv({ cls: "echoink-generation-label", text: "模板" });
    this.templateEl = body.createDiv();
    this.customEl = body.createDiv({ cls: "echoink-generation-custom" });
    body.createDiv({ cls: "echoink-generation-label", text: "根据这批资料" });
    const recommendRow = body.createDiv({ cls: "echoink-generation-recommend-row" });
    this.recommendationButton = createOriginButton(recommendRow, { cls: "text-button" });
    applyAmicroButton(this.recommendationButton, { variant: "tertiary", motion: "rotate", icon: "sparkles" });
    this.recommendationLabel = this.recommendationButton.createSpan({ text: "让 AI 推荐模板" });
    this.recommendationButton.onclick = () => { void this.recommend(); };
    this.recommendationStatus = recommendRow.createSpan({ cls: "echoink-generation-recommend-status", attr: { role: "status", "aria-live": "polite" } });
    this.recommendationsEl = body.createDiv();
    const destination = body.createDiv({ cls: "echoink-generation-destination" });
    destination.createSpan({ cls: "echoink-generation-label", text: "保存到" }); this.destinationEl = destination.createSpan();
    const footer = content.createDiv({ cls: "echoink-generation-modal-footer" });
    this.reasonEl = footer.createDiv({ cls: "echoink-generation-disabled-reason", attr: { role: "status", "aria-live": "polite" } });
    const actions = footer.createDiv({ cls: "echoink-generation-modal-actions" });
    this.cancelButton = createOriginButton(actions, { cls: "button", text: "取消" }); this.cancelButton.onclick = () => { if (!this.submitting) this.close(); };
    this.generateButton = createOriginButton(actions, { cls: "button mod-cta", text: "生成" }); this.generateButton.onclick = () => { void this.submit(); };
    this.renderTemplates(); this.renderCustom(); this.updateSummary(); this.updateFooter();
    void this.assess();
  }

  onClose(): void {
    this.active = false; this.assessmentVersion++; this.recommendationVersion++;
    this.assessmentAbort?.abort(); this.recommendationAbort?.abort(); this.pickerDispose?.(); this.pickerDispose = null;
    disposeOriginControls(this.contentEl); this.contentEl.empty();
  }

  private selected(): GenerationTemplate {
    if (this.selectedTemplateId === "custom") return { id: "custom", name: this.customName.trim() || "我的格式", description: "自制格式", instructions: this.customInstructions.trim(), outputKind: "markdown" };
    return [...this.templates, ...this.temporaryTemplates].find(item => item.id === this.selectedTemplateId) ?? this.templates[0];
  }
  private selectedSourcePaths(): string[] { return this.paths.filter(path => this.selectedPaths.has(path)); }
  private updateSummary(): void { this.sourceSummary.setText(this.selectedPaths.size ? `已选 ${this.selectedPaths.size} 篇笔记` : "没有已选资料"); }

  private renderSources(): void {
    this.pickerDispose?.(); this.pickerDispose = null;
    disposeOriginControls(this.sourceListEl); this.sourceListEl.empty();
    if (!this.paths.length) this.sourceListEl.createDiv({ cls: "echoink-generation-empty", text: "暂无资料，可以添加 Markdown 笔记。" });
    for (const path of this.paths) {
      const row = this.sourceListEl.createDiv({ cls: "echoink-generation-source-row" });
      const check = createOriginCheck(row, { attr: { "aria-label": path } }); check.checked = this.selectedPaths.has(path);
      const label = row.createSpan({ text: path }); label.onclick = () => check.click();
      check.onchange = () => { if (this.submitting) { check.checked = this.selectedPaths.has(path); return; } if (check.checked) this.selectedPaths.add(path); else this.selectedPaths.delete(path); this.sourcesChanged(); };
    }
    const add = createOriginButton(this.sourceListEl, { cls: "text-button echoink-generation-add-note", text: "添加笔记" });
    setIcon(add.createSpan({ attr: { "aria-hidden": "true" } }), "plus");
    add.onclick = () => {
      if (this.pickerDispose || this.submitting) return;
      const available = new Set(this.options.service.availableNotes());
      const catalog = buildVaultNoteMentionCatalog(this.plugin.app).filter(item => available.has(item.vaultRelativePath));
      this.pickerDispose = mountGenerationNotePicker(this.sourceListEl, { catalog, excludedPaths: this.paths, app: this.app, scope: this.scope,
        onSelect: path => { if (!this.paths.includes(path)) this.paths.push(path); this.selectedPaths.add(path); this.renderSources(); this.sourcesChanged(); this.sourceListEl.querySelector<HTMLButtonElement>(".echoink-generation-add-note")?.focus(); },
        onClose: () => { this.pickerDispose?.(); this.pickerDispose = null; add.focus(); } });
    };
  }

  private sourcesChanged(): void {
    this.submitError = ""; this.updateSummary();
    this.recommendationVersion++; this.recommendationAbort?.abort(); this.recommending = false; this.recommendationError = "";
    if (this.temporaryTemplates.some(item => item.id === this.selectedTemplateId)) this.selectedTemplateId = this.templates[0].id;
    this.temporaryTemplates = []; this.renderTemplates(); this.updateRecommendation(); void this.assess();
  }

  private renderTemplates(): void {
    const render = (container: HTMLElement, templates: GenerationTemplate[], custom = false) => {
      disposeOriginControls(container); container.empty();
      const radio = createOriginRadioGroup(container, this.selectedTemplateId, "生成模板", id => {
        if (this.submitting) return;
        this.selectedTemplateId = id; this.submitError = ""; this.renderTemplates(); this.renderCustom(); this.updateFooter();
        this.contentEl.querySelector<HTMLButtonElement>(`[role="radio"][data-state="checked"]`)?.focus();
      });
      radio.element.addClass("echoink-generation-template-grid");
      const cards = custom ? [...templates, { id: "custom", name: "自制格式", description: "写下本次的结构、风格和语气", instructions: "", outputKind: "markdown" as const }] : templates;
      for (const template of cards) {
        const card = radio.element.createDiv({ cls: "echoink-generation-template-card" });
        const selector = radio.addItem(card, template.id, this.submitting); selector.setAttr("aria-label", template.name);
        const copy = card.createDiv({ cls: "echoink-generation-template-card-copy" });
        const title = copy.createDiv({ cls: "echoink-generation-template-card-title", text: template.name });
        if (template.outputKind === "canvas") title.createSpan({ cls: "echoink-generation-canvas-badge", text: "Canvas" });
        if (template.description) copy.createDiv({ cls: "echoink-generation-template-card-description", text: template.description });
        if (this.temporaryTemplates.some(item => item.id === template.id)) {
          const instructions = copy.createEl("details", { cls: "echoink-generation-template-card-instructions" });
          instructions.createEl("summary", { text: "写作要求" }); instructions.createDiv({ text: template.instructions });
        }
        if (template.id !== "custom" && this.templates.some(item => item.id === template.id)) {
          const edit = createOriginButton(card, { cls: "icon-button echoink-generation-template-edit", attr: { "aria-label": `编辑模板「${template.name}」` } });
          setIcon(edit, "pencil"); edit.onclick = () => { if (this.submitting) return; this.close(); openGenerationTemplateSettings(this.plugin, template.id); };
        }
        card.onclick = event => { if (!(event.target as HTMLElement).closest("button")) selector.click(); };
      }
    };
    render(this.templateEl, this.templates, true);
    render(this.recommendationsEl, this.temporaryTemplates);
  }

  private renderCustom(): void {
    disposeOriginControls(this.customEl); this.customEl.empty(); this.customEl.hidden = this.selectedTemplateId !== "custom";
    if (this.customEl.hidden) return;
    const textarea = this.customEl.createEl("textarea", { attr: { "aria-label": "自制格式写作要求", placeholder: "想要什么结构、风格和语气" } });
    textarea.value = this.customInstructions; textarea.oninput = () => { this.customInstructions = textarea.value; this.submitError = ""; this.updateFooter(); };
    const saveRow = this.customEl.createDiv({ cls: "echoink-generation-save-template" });
    const check = createOriginCheck(saveRow, { attr: { "aria-label": "存为模板" } }); check.checked = this.saveCustom;
    const label = saveRow.createSpan({ text: "存为模板，下次直接用" }); label.onclick = () => check.click();
    const nameRow = this.customEl.createDiv({ cls: "echoink-generation-custom-name" }); nameRow.hidden = !this.saveCustom;
    nameRow.createEl("label", { text: "模板名称", attr: { for: "echoink-generation-custom-name" } });
    const name = createOriginInput(nameRow, { value: this.customName, attr: { id: "echoink-generation-custom-name", "aria-label": "模板名称" } });
    name.oninput = () => { this.customName = name.value; };
    check.onchange = () => { this.saveCustom = check.checked; nameRow.hidden = !this.saveCustom; };
  }

  private async assess(): Promise<void> {
    this.assessmentAbort?.abort(); const controller = new AbortController(); this.assessmentAbort = controller;
    const version = ++this.assessmentVersion; this.assessing = true; this.assessmentError = ""; this.updateFooter();
    try {
      const result = await this.options.service.assessSources(this.selectedSourcePaths(), controller.signal);
      if (!this.active || version !== this.assessmentVersion) return;
      this.assessmentError = result.error ?? "";
    } catch (error) {
      if (!this.active || version !== this.assessmentVersion || controller.signal.aborted) return;
      this.assessmentError = error instanceof Error ? error.message : "无法检查资料，请重试。";
    } finally { if (this.active && version === this.assessmentVersion) { this.assessing = false; this.updateFooter(); this.updateRecommendation(); } }
  }

  private disabledReason(): string {
    const turnOptions = this.options.turnOptions();
    return this.options.service.disabledReason({ sessionId: this.options.sessionId, permission: turnOptions.permission, mode: turnOptions.mode })
      || (this.selectedPaths.size ? "" : "请先选择资料。") || (this.assessing ? "正在检查资料…" : this.assessmentError)
      || (!this.selected().instructions.trim() ? "请填写写作要求。" : "");
  }
  private updateFooter(): void {
    if (!this.generateButton) return;
    let reason = "";
    try { reason = this.disabledReason(); } catch (error) { reason = error instanceof Error ? error.message : "暂时无法生成。"; }
    this.reasonEl.setText(this.submitError || reason); this.generateButton.disabled = this.submitting || Boolean(reason);
    this.cancelButton.disabled = this.submitting; setAmicroButtonPending(this.generateButton, this.submitting);
    this.generateButton.setText(this.submitting ? "提交中…" : "生成");
    try { this.destinationEl.setText(this.options.service.outputDirectory(this.selected().outputKind)); }
    catch { this.destinationEl.setText("请先绑定输出目录"); }
  }

  private updateRecommendation(): void {
    if (!this.recommendationButton) return;
    this.recommendationButton.disabled = this.recommending || this.submitting || this.assessing || !this.selectedPaths.size || Boolean(this.assessmentError);
    setAmicroButtonPending(this.recommendationButton, this.recommending);
    this.recommendationLabel.setText(this.recommending ? "正在看资料…" : this.temporaryTemplates.length ? "重新推荐模板" : "让 AI 推荐模板");
    this.recommendationStatus.setText(this.recommendationError); this.recommendationStatus.toggleClass("is-error", Boolean(this.recommendationError));
  }

  private async recommend(): Promise<void> {
    if (this.recommendationButton.disabled || !this.active) return;
    this.recommendationAbort?.abort(); const controller = new AbortController(); this.recommendationAbort = controller;
    const version = ++this.recommendationVersion; this.recommending = true; this.recommendationError = ""; this.updateRecommendation();
    try {
      const templates = await this.options.service.recommend(this.selectedSourcePaths(), controller.signal, this.options.sessionId);
      if (!this.active || version !== this.recommendationVersion) return;
      if (this.temporaryTemplates.some(item => item.id === this.selectedTemplateId)) this.selectedTemplateId = this.templates[0].id;
      this.temporaryTemplates = templates; this.renderTemplates(); this.updateFooter();
    } catch (error) {
      if (!this.active || version !== this.recommendationVersion || controller.signal.aborted) return;
      this.recommendationError = error instanceof Error ? error.message : "推荐失败，请重试或选择已有模板。";
    } finally { if (this.active && version === this.recommendationVersion) { this.recommending = false; this.updateRecommendation(); } }
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.active) return;
    this.updateFooter(); if (this.generateButton.disabled) return;
    this.submitting = true; this.submitError = ""; this.updateFooter(); this.updateRecommendation();
    try {
      const template = { ...this.selected() };
      const request = this.options.service.createRequest(template, this.selectedSourcePaths());
      const turnOptions = { ...this.options.turnOptions() };
      if (this.selectedTemplateId === "custom" && this.saveCustom) {
        const previous = this.plugin.settings.generationTemplates;
        const templates = normalizeGenerationTemplates(previous);
        const saved = { ...template, id: `custom-${crypto.randomUUID()}`, name: uniqueGenerationTemplateName(templates, this.customName) };
        const updated = [...templates, saved]; this.plugin.settings.generationTemplates = updated;
        try { await this.plugin.saveSettings(); new Notice(`已存为模板「${saved.name}」`); this.saveCustom = false; if (this.active) this.renderCustom(); }
        catch (error) { if (this.plugin.settings.generationTemplates === updated) this.plugin.settings.generationTemplates = previous; new Notice(`模板未保存：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!this.active) return;
      await this.options.onSubmit(request, turnOptions);
      if (this.active) this.close();
    } catch (error) { if (this.active) this.submitError = error instanceof Error ? error.message : "生成尚未提交，请重试。"; }
    finally { this.submitting = false; if (this.active) { this.updateFooter(); this.updateRecommendation(); } }
  }
}
