import { MarkdownRenderer, type App, Component } from "obsidian";
import {
  createOriginButton,
  createOriginRadioGroup,
} from "../settings/origin-controls";
import {
  applyAmicroButton,
  setAmicroButtonPending,
} from "../settings/amicro-buttons";
import {
  KNOWLEDGE_PURPOSES,
  proposeKnowledgePreferences,
  type KnowledgePurpose,
  type KnowledgePreferenceProposal,
  type KnowledgePreferenceWizardHost,
} from "../knowledge-base/knowledge-preference-wizard";
import type { KnowledgeMaintenancePreferenceSnapshot } from "../knowledge-base/knowledge-maintenance-preferences";

interface WizardOptions {
  language: "zh-CN" | "en";
  changed(): void;
  done(saved?: Readonly<KnowledgeMaintenancePreferenceSnapshot>): void;
}

/** Shared presentation state; the existing repository owns validation and writes. */
export class KnowledgePreferenceWizard {
  private purpose: KnowledgePurpose | "" = "";
  private proposal?: KnowledgePreferenceProposal;
  private phase: "choose" | "generating" | "review" | "saving" = "choose";
  private error = "";
  private controller?: AbortController;
  private disposed = false;
  private readonly markdown = new Component();
  constructor(
    private readonly host: KnowledgePreferenceWizardHost,
    private readonly baseline: Readonly<KnowledgeMaintenancePreferenceSnapshot>,
    private readonly options: WizardOptions,
  ) {}
  private label(zh: string, en: string) {
    return this.options.language === "en" ? en : zh;
  }
  get title() {
    return this.proposal
      ? this.label("确认整理偏好", "Review your preferences")
      : this.label("主要用知识库做什么？", "What is your knowledge base for?");
  }
  get saving() {
    return this.phase === "saving";
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.markdown.unload();
  }
  cancel() {
    if (this.saving) return;
    this.dispose();
    this.options.done();
  }
  render(parent: HTMLElement, app: App, actionParent?: HTMLElement) {
    this.markdown.unload();
    this.markdown.load();
    const root = parent.createDiv({
      cls: "knowledge-preference-wizard",
      attr: {
        "data-preference-step": this.proposal ? "review" : "choose",
        "aria-busy": String(this.phase === "generating" || this.saving),
      },
    });
    if (this.proposal) {
      for (const section of this.proposal.sections) {
        const group = root.createEl("section", {
          cls: "knowledge-preference-section",
        });
        group.createEl("h3", { text: section.title });
        void MarkdownRenderer.render(
          app,
          section.content,
          group.createDiv(),
          "",
          this.markdown,
        );
      }
    } else {
      const choices = root.createDiv({ cls: "knowledge-preference-purposes" });
      const group = createOriginRadioGroup(
        choices,
        this.purpose,
        this.title,
        (value) => {
          this.purpose = value as KnowledgePurpose;
          this.options.changed();
        },
      );
      for (const purpose of KNOWLEDGE_PURPOSES) {
        const row = choices.createEl("label", {
          cls: "knowledge-preference-purpose",
        });
        const radio = group.addItem(
          row,
          purpose.id,
          this.phase === "generating",
        );
        radio.setAttribute("aria-label", this.label(purpose.zh, purpose.en));
        row.createSpan({ text: this.label(purpose.zh, purpose.en) });
        row.onclick = (event) => {
          if (!radio.contains(event.target as Node)) radio.click();
        };
        row.toggleClass("is-selected", purpose.id === this.purpose);
      }
      if (!this.host.available())
        root.createDiv({
          cls: "knowledge-preference-error",
          text: this.label(
            "请先连接模型，也可以跳过，以后在设置里做。",
            "Connect a model, or skip and do this later in settings.",
          ),
        });
    }
    if (this.error)
      root.createDiv({
        cls: "knowledge-preference-error",
        text: this.error,
        attr: { role: "alert" },
      });
    const actions = (actionParent ?? root).createDiv({
      cls: "knowledge-preference-actions",
    });
    const button = (text: string, action: () => void, primary = false) => {
      const control = createOriginButton(actions, {
        text,
        cls: primary ? "button mod-cta is-primary" : "text-button is-tertiary",
      });
      applyAmicroButton(control, { variant: primary ? "primary" : "tertiary" });
      control.disabled = this.saving;
      control.onclick = action;
      return control;
    };
    if (this.proposal)
      button(this.label("返回", "Back"), () => {
        if (this.saving) return;
        this.proposal = undefined;
        this.error = "";
        this.phase = "choose";
        this.options.changed();
      });
    button(this.label("跳过", "Skip"), () => this.cancel());
    const primary = button(
      this.proposal
        ? this.label("保存并继续", "Save and continue")
        : this.label("生成偏好", "Generate preferences"),
      () => {
        void (this.proposal ? this.save() : this.generate());
      },
      true,
    );
    primary.dataset.preferenceAction = this.proposal ? "save" : "generate";
    if (!this.proposal && (!this.purpose || !this.host.available())) primary.disabled = true;
    if (this.phase === "generating" || this.saving) {
      primary.disabled = true;
      setAmicroButtonPending(primary, true);
    }
  }
  private async generate() {
    if (!this.purpose || this.phase === "generating" || this.saving) return;
    this.controller = new AbortController();
    this.phase = "generating";
    this.error = "";
    this.options.changed();
    try {
      this.proposal = await proposeKnowledgePreferences(
        this.host,
        this.baseline,
        this.purpose,
        this.options.language,
        this.controller.signal,
      );
      this.phase = "review";
    } catch {
      this.error = this.label(
        "偏好没生成好，可以重试或跳过。",
        "Generation failed. Retry or skip.",
      );
      this.phase = "choose";
    }
    if (!this.disposed) this.options.changed();
  }
  private async save() {
    if (this.saving || !this.proposal) return;
    this.phase = "saving";
    this.error = "";
    this.options.changed();
    try {
      const saved = await this.host.save(
        this.proposal.content,
        this.proposal.expectedRevision,
      );
      if (!this.disposed) this.options.done(saved);
    } catch (error) {
      const conflict =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "revision_conflict";
      this.error = conflict
        ? this.label(
            "偏好已有新修改，原内容保留。请返回设置重新读取。",
            "Preferences changed. Existing content was kept; reopen from settings.",
          )
        : this.label(
            "偏好没有保存，请重试或跳过。",
            "Preferences were not saved. Retry or skip.",
          );
      this.phase = "review";
      if (!this.disposed) this.options.changed();
    }
  }
}
