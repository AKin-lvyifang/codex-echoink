import { Modal, Notice, setIcon, type App } from "obsidian";
import { createOriginButton, createOriginInput, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { apiProviderPresetDisplayName, getApiProviderPreset, type ApiProviderId } from "../settings/provider-presets";
import { providerServiceCategories } from "../settings/provider-service-categories";
import { renderProviderBrandIcon } from "../settings/provider-brand-icons";
import type { OnboardingSetupPlan } from "../knowledge-base/onboarding-setup-plan";
import type { KnowledgeDirectoryApplyResult } from "../knowledge-base/folder-plan";

export interface PaperGuideModelResult { available: boolean; message: string }
export type PaperGuideProgress = (step: "folders" | "bindings", completed: number, total: number) => void;
export interface PaperGuideModalOptions {
  language: "zh-CN" | "en";
  preview(): Promise<OnboardingSetupPlan>;
  apply(plan: OnboardingSetupPlan, progress: PaperGuideProgress): Promise<KnowledgeDirectoryApplyResult>;
  model(): string | null;
  connect(provider: ApiProviderId, key: string): Promise<PaperGuideModelResult>;
  onManual(): Promise<void>;
  onTry(): Promise<boolean>;
  onDismiss(): Promise<void>;
  onClosed(): void;
}
type View = "choose" | "confirm" | "running" | "done" | "connect";

/** One native modal; only explicit confirmation writes folders or provider settings. */
export class PaperGuideModal extends Modal {
  private view: View = "choose";
  private plan: OnboardingSetupPlan | null = null;
  private result: KnowledgeDirectoryApplyResult | null = null;
  private busy = false;
  private disposed = false;
  private closed = false;
  private error = "";
  private modelError = "";
  private key = "";
  private provider: ApiProviderId = "deepseek";
  private progress: { step: "folders" | "bindings" | "model"; completed: number; total: number } | null = null;
  private body!: HTMLElement;
  private footer!: HTMLElement;

  constructor(app: App, private readonly options: PaperGuideModalOptions) { super(app); }
  private label(zh: string, en: string): string { return this.options.language === "en" ? en : zh; }

  onOpen(): void {
    this.modalEl.addClass("echoink-paper-guide-modal");
    this.contentEl.addClass("echoink-paper-guide-content");
    this.render();
  }

  close(): void {
    if (this.busy || this.closed || this.disposed) return;
    void this.navigate();
  }
  dispose(): void { this.disposed = true; this.key = ""; super.close(); }
  onClose(): void {
    if (this.closed) return;
    this.closed = true; this.key = "";
    disposeOriginControls(this.contentEl); this.contentEl.empty(); this.options.onClosed();
  }

  private render(): void {
    if (this.closed || this.disposed) return;
    disposeOriginControls(this.contentEl); this.contentEl.empty();
    this.modalEl.toggleClass("is-setup-detail", this.view !== "choose");
    this.modalEl.setAttribute("data-setup-view", this.view);
    this.setTitle(this.label(this.view === "choose" ? "你想怎么开始？" : this.view === "confirm" ? "确认后我会做这些" : this.view === "running" ? "正在设置…" : this.view === "connect" ? "连接模型" : "目录已设置完成",
      this.view === "choose" ? "How would you like to start?" : this.view === "confirm" ? "Review your setup" : this.view === "running" ? "Setting up…" : this.view === "connect" ? "Connect a model" : "Directories are ready"));
    if (this.view === "choose") {
      const mascot = this.titleEl.createSpan({ cls: "echoink-paper-guide-mascot", attr: { "aria-hidden": "true" } });
      for (const part of ["eyes", "mouth", "feet"]) mascot.createSpan({ cls: `echoink-paper-guide-${part}` });
      this.titleEl.prepend(mascot);
    }
    this.body = this.contentEl.createDiv({ cls: "echoink-setup-body" });
    this.footer = this.contentEl.createDiv({ cls: "echoink-setup-footer" });
    if (this.view === "choose") this.renderChoices();
    else if (this.view === "confirm") this.renderConfirmation();
    else if (this.view === "running") this.renderProgress();
    else if (this.view === "connect") {
      this.renderModel(this.body);
      this.action(this.label("返回", "Back"), () => { this.error = ""; this.view = "done"; this.render(); });
      this.action(this.label("连接并保存", "Connect and save"), () => this.connectModel(), true, !this.key.trim());
    } else this.renderDone();
    if (this.error) this.body.createDiv({ cls: "echoink-setup-error", text: this.error, attr: { role: "alert" } });
    this.setBusyState();
  }

  private action(text: string, action: () => void | Promise<void>, primary = false, disabled = false): HTMLButtonElement {
    const button = createOriginButton(this.footer, { text, cls: primary ? "button mod-cta is-primary" : "text-button is-tertiary", attr: { type: "button" } });
    applyAmicroButton(button, { variant: primary ? "primary" : "tertiary", motion: primary ? "slide" : "none", icon: primary ? "arrow-right" : undefined });
    button.disabled = disabled; if (disabled) button.dataset.setupDisabled = "true";
    button.onclick = () => { if (!this.busy) void action(); };
    return button;
  }

  private group(title?: string): HTMLElement {
    const group = this.body.createEl("section", { cls: "echoink-setup-group" });
    if (title) group.createEl("h3", { text: title });
    return group.createDiv({ cls: "echoink-setup-rows" });
  }
  private row(host: HTMLElement, icon: string, text: string, count?: string): HTMLElement {
    const row = host.createDiv({ cls: "echoink-setup-row" });
    setIcon(row.createSpan({ cls: "echoink-setup-icon", attr: { "aria-hidden": "true" } }), icon);
    row.createSpan({ cls: "echoink-setup-copy", text });
    if (count !== undefined) row.createSpan({ cls: "echoink-setup-count", text: count });
    return row;
  }

  private renderChoices(): void {
    const choices = this.body.createDiv({ cls: "echoink-paper-guide-choices" });
    for (const [id, icon, title, description] of [
      ["auto", "zap", this.label("全自动", "Automatic"), this.label("我是新手，一键设好就能用", "Set things up for me")],
      ["guided", "sliders-horizontal", this.label("半自动", "Guided"), this.label("先看看建议的设置", "Review the suggested setup")],
      ["manual", "wrench", this.label("手动", "Manual"), this.label("我喜欢 DIY，自己一项项设置", "Configure each setting myself")]
    ]) {
      const button = createOriginButton(choices, { cls: "echoink-paper-guide-choice", attr: { "data-setup-choice": id } });
      setIcon(button.createSpan({ cls: "echoink-paper-guide-icon" }), icon);
      const copy = button.createSpan({ cls: "echoink-paper-guide-copy" });
      copy.createSpan({ cls: "echoink-paper-guide-choice-title", text: title });
      copy.createSpan({ cls: "echoink-paper-guide-description", text: description });
      setIcon(button.createSpan({ cls: "echoink-paper-guide-arrow" }), "arrow-right");
      button.onclick = () => { if (!this.busy) void (id === "manual" ? this.navigate(() => this.options.onManual()) : this.scan()); };
    }
    this.action(this.label("以后再说", "Maybe later"), () => this.navigate());
  }

  private async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = ""; this.view = "confirm"; this.plan = null; this.render();
    try { this.plan = await this.options.preview(); }
    catch (error) { this.error = this.errorText(error); }
    finally { this.busy = false; this.render(); }
  }

  private renderConfirmation(): void {
    const plan = this.plan;
    if (!plan) this.body.createDiv({ text: this.busy ? this.label("正在扫描仓库…", "Scanning your vault…") : this.label("未能生成设置清单。", "Couldn't prepare your setup."), attr: { role: "status" } });
    else {
      const create = this.group(this.label("新建文件夹", "New folders"));
      this.row(create, "folder-plus", plan.directoryPlan.create.length ? plan.directoryPlan.create.join(this.label("、", ", ")) : this.label("无需新建", "No new folders needed"), String(plan.directoryPlan.create.length));
      const notes = this.group(this.label("你的笔记", "Your notes"));
      for (const source of plan.sources) this.row(notes, "folder", source.path, this.label(`${source.noteCount} 篇`, `${source.noteCount} notes`));
      if (plan.rootNotes.count) this.row(notes, "files", this.label("根目录笔记留在原位（对话能搜到，/ask 默认不含）", "Root notes stay in place (searchable in chat, excluded from /ask by default)"), this.label(`${plan.rootNotes.count} 篇`, `${plan.rootNotes.count} notes`));
      const outputs = this.group(this.label("产出位置", "Saved content"));
      if (plan.outputLocations.answer === plan.outputLocations.generation) this.row(outputs, "folder-output", this.label(`回答和生成内容 → ${plan.outputLocations.answer}`, `Answers and generated content → ${plan.outputLocations.answer}`));
      else {
        this.row(outputs, "folder-output", this.label(`回答 → ${plan.outputLocations.answer}`, `Answers → ${plan.outputLocations.answer}`));
        this.row(outputs, "folder-output", this.label(`生成内容 → ${plan.outputLocations.generation}`, `Generated content → ${plan.outputLocations.generation}`));
      }
      if (plan.skipped.length) {
        const details = this.body.createEl("details", { cls: "echoink-setup-skipped" });
        details.createEl("summary", { text: this.label(`已跳过 ${plan.skipped.length} 个文件夹`, `${plan.skipped.length} folders skipped`) });
        for (const item of plan.skipped) details.createDiv({ cls: "echoink-setup-skipped-row", text: `${item.path} · ${item.reason}` });
      }
      this.renderModel(this.group(this.label("模型", "Model")));
      this.body.createEl("p", { cls: "echoink-setup-safety", text: this.label("不删除文件，不移动、不改你的笔记，不用模型处理笔记。", "No files deleted or moved. Your notes stay unchanged and are not processed by a model.") });
      if (plan.directoryPlan.issues.length) this.body.createDiv({ cls: "echoink-setup-error", text: plan.directoryPlan.issues.join("；"), attr: { role: "alert" } });
    }
    this.action(this.label("返回", "Back"), () => { this.error = ""; this.view = "choose"; this.render(); });
    this.action(this.label("重新扫描", "Scan again"), () => this.scan());
    this.action(this.label("确认，开始", "Confirm and start"), () => this.run(), true, !plan || !!plan.directoryPlan.issues.length);
  }

  private renderModel(host: HTMLElement): void {
    const configured = this.options.model();
    if (configured) { this.row(host, "circle-check", configured, this.label("已配置", "Configured")); return; }
    const fields = host.createDiv({ cls: "echoink-setup-model-fields" });
    const choices = providerServiceCategories(this.options.language).flatMap(category => category.presets.filter(preset => preset.apiKeyRequired && preset.model).map(preset => ({ value: preset.id,
      label: apiProviderPresetDisplayName(preset.id, this.options.language), group: category.label, renderIcon: (container: HTMLElement) => renderProviderBrandIcon(container, preset.id) })));
    const select = createOriginSelect(fields, { cls: "echoink-setup-provider", attr: { "aria-label": this.label("模型服务", "Model service") } }, choices, this.provider, this.app);
    const key = createOriginInput(fields, { cls: "echoink-setup-key", value: this.key, attr: { type: "password", autocomplete: "off", placeholder: this.label("粘贴 API Key（可留空）", "API key (optional)"), "aria-label": "API Key" } });
    const link = fields.createEl("a", { cls: "echoink-setup-key-link", text: this.label("获取 Key", "Get a key"), href: getApiProviderPreset(this.provider).docsUrl, attr: { target: "_blank", rel: "noopener noreferrer" } });
    select.element.addEventListener("change", () => { this.provider = select.element.value as ApiProviderId; this.key = ""; key.value = ""; link.href = getApiProviderPreset(this.provider).docsUrl; key.dispatchEvent(new (key.ownerDocument.defaultView!.Event)("input", { bubbles: true })); });
    key.addEventListener("input", () => {
      this.key = key.value;
      if (this.view === "connect") {
        const button = this.footer.querySelector<HTMLButtonElement>(".mod-cta");
        if (button) { button.disabled = !this.key.trim(); button.dataset.setupDisabled = String(!this.key.trim()); }
      }
    });
    host.createEl("p", { cls: "echoink-setup-safety", text: this.label("可先跳过。填写后会调用一次模型测试连接。", "You can skip this. Testing a key makes one model request.") });
  }

  private renderProgress(): void {
    const rows = this.group();
    const steps = ["folders", "bindings", ...(this.key.trim() ? ["model"] : [])];
    const current = steps.indexOf(this.progress?.step ?? "folders");
    for (const [index, step] of steps.entries()) {
      const done = index < current || (index === current && this.progress && this.progress.completed === this.progress.total);
      const text = step === "folders" ? this.label("新建文件夹", "Create folders") : step === "bindings" ? this.label("绑定资料", "Bind sources") : this.label("测试模型连接", "Test model connection");
      const row = this.row(rows, done ? "circle-check" : index === current ? "loader-circle" : "circle", text,
        index === current && this.progress ? `${this.progress.completed} / ${this.progress.total}` : undefined);
      if (!done && index === current) row.addClass("is-running");
    }
  }

  private async run(): Promise<void> {
    if (this.busy || !this.plan || this.plan.directoryPlan.issues.length) return;
    this.busy = true; this.error = ""; this.view = "running"; this.progress = null; this.render();
    try {
      this.result = await this.options.apply(this.plan, (step, completed, total) => { this.progress = { step, completed, total }; this.render(); });
      if (this.key.trim()) {
        this.progress = { step: "model", completed: 0, total: 1 }; this.render();
        await this.testModel();
      }
      this.view = "done";
    } catch (error) { this.error = this.errorText(error); this.view = this.result ? "done" : "confirm"; }
    finally { this.busy = false; this.render(); }
  }

  private async testModel(): Promise<void> {
    try {
      const result = await this.options.connect(this.provider, this.key);
      this.modelError = result.available ? "" : result.message;
      if (result.available) this.key = "";
    } catch (error) { this.modelError = this.errorText(error); }
  }
  private async connectModel(): Promise<void> {
    if (this.busy || !this.key.trim()) return;
    this.busy = true; this.error = ""; this.setBusyState();
    await this.testModel();
    this.view = this.modelError ? "connect" : "done";
    this.error = this.modelError; this.busy = false; this.render();
  }
  private renderDone(): void {
    const rows = this.group();
    if (this.result) this.row(rows, "folder-check", this.label("新建文件夹", "New folders"), String(this.result.created.length));
    if (this.plan) this.row(rows, "search-check", this.label("已纳入知识库，以后改动自动反映到搜索", "Included in Knowledge; future changes update search automatically"), this.label(`${this.plan.noteCount} 篇`, `${this.plan.noteCount} notes`));
    const model = this.options.model();
    if (model) this.row(rows, "circle-check", model, this.label("已配置", "Configured"));
    else this.row(rows, "key-round", this.label("还差模型，连上才能提问", "Connect a model to ask questions"));
    if (this.modelError) this.body.createDiv({ cls: "echoink-setup-error", text: this.modelError, attr: { role: "alert" } });
    this.action(this.label("关闭", "Close"), () => this.navigate());
    this.action(model ? this.label("问一句试试", "Try a question") : this.label("连接模型", "Connect a model"),
      () => model ? this.navigate(async () => { if (!await this.options.onTry()) throw new Error(this.label("未能打开总助，问题没有预填，请从工作台重试。", "Couldn't open the assistant. No question was inserted; try again from Home.")); })
        : (() => { this.view = "connect"; this.error = ""; this.render(); })(), true);
  }

  private errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.key.trim() ? text.replaceAll(this.key.trim(), this.label("[已隐藏凭据]", "[credential hidden]")) : text;
  }
  private setBusyState(): void {
    this.modalEl.setAttribute("aria-busy", String(this.busy));
    for (const control of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input"))) control.disabled = this.busy || control.dataset.setupDisabled === "true";
    this.modalEl.querySelector(".modal-close-button")?.setAttribute("aria-disabled", String(this.busy));
  }
  private async navigate(afterClose?: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed || this.disposed) return;
    this.busy = true; this.setBusyState();
    try {
      await this.options.onDismiss();
      if (this.closed || this.disposed) return;
      super.close();
      if (afterClose && !this.disposed) await afterClose();
    } catch (error) {
      const text = this.errorText(error);
      if (this.closed) new Notice(text);
      else { this.error = text; this.busy = false; this.render(); }
    } finally { this.busy = false; }
  }
}
