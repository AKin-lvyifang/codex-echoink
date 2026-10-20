import type {
  EchoInkQuestionAnswer,
  EchoInkQuestionInteraction,
  EchoInkQuestionPrompt
} from "../../types/conversation-turn";
import type { SettingsLanguage } from "../../settings/settings";
import type { PiAgentApprovalDecisionBinding } from "../../plugin/pi-agent-approval-broker";
import type { PiTurnInteractionDecisionBinding } from "../../plugin/pi-turn-interaction-broker";
import {
  createAIElementsConfirmation,
  markAIElementsQuestion
} from "./smooth-chat-ui";
import { conversationUiText } from "./ui-i18n";

export interface InteractionDockRenderInput {
  readonly sessionId: string;
  readonly language?: SettingsLanguage;
  readonly question?: Readonly<{
    binding: Readonly<PiTurnInteractionDecisionBinding>;
    onResolved(): void;
  }>;
  readonly confirmation?: Readonly<{
    binding: Readonly<PiAgentApprovalDecisionBinding>;
    onResolved(): void;
  }>;
  readonly onStale: () => void;
  readonly onScheduleMeasure: () => void;
}

interface QuestionDraft {
  activeIndex: number;
  readonly selectedByQuestion: Map<string, Set<string>>;
  readonly supplementByQuestion: Map<string, string>;
  invalidQuestionId: string | null;
  submitting: boolean;
}

interface LastRender {
  readonly container: HTMLElement;
  readonly input: Readonly<InteractionDockRenderInput>;
}

/**
 * The one complete Question/Confirmation control surface above Composer.
 * Drafts are live-only and keyed to an exact session + interaction identity.
 */
export class InteractionDockController {
  private readonly questionDrafts = new Map<string, QuestionDraft>();
  private lastRender: LastRender | null = null;
  private activeSurfaceKey = "";

  render(
    container: HTMLElement,
    input: Readonly<InteractionDockRenderInput>
  ): void {
    this.lastRender = { container, input };
    const question = input.question?.binding.interaction;
    if (question?.kind === "question" && question.status === "pending") {
      this.renderQuestion(container, input, input.question!.binding, question, input.language ?? "zh-CN");
      return;
    }
    if (input.confirmation) {
      this.renderConfirmation(container, input, input.confirmation.binding, input.language ?? "zh-CN");
      return;
    }
    this.hide(container);
  }

  dispose(): void {
    this.questionDrafts.clear();
    this.lastRender = null;
    this.activeSurfaceKey = "";
  }

  private renderQuestion(
    container: HTMLElement,
    input: Readonly<InteractionDockRenderInput>,
    binding: Readonly<PiTurnInteractionDecisionBinding>,
    interaction: Readonly<EchoInkQuestionInteraction>,
    language: SettingsLanguage
  ): void {
    const key = questionStateKey(input.sessionId, interaction);
    const state = this.questionState(key, interaction);
    const index = clampQuestionIndex(state.activeIndex, interaction.questions.length);
    state.activeIndex = index;
    const question = interaction.questions[index];
    const firstPresentation = this.activeSurfaceKey !== key;
    this.activeSurfaceKey = key;

    container.empty();
    container.addClass("is-visible");
    container.addClass("is-question");
    container.removeClass("is-confirmation");
    container.dataset.interactionId = interaction.interactionId;
    const card = container.createDiv({
      cls: "codex-interaction-card codex-interaction-question-card",
      attr: {
        "aria-busy": String(state.submitting),
        "aria-label": conversationUiText(language, "需要你的选择", "Your input is needed"),
        role: "region"
      }
    });
    markAIElementsQuestion(card);
    const header = card.createDiv({ cls: "codex-interaction-header" });
    const heading = header.createEl("h2", {
      cls: "codex-interaction-heading"
    });
    heading.createSpan({
      cls: "codex-interaction-heading-primary",
      text: conversationUiText(language, "需要你的选择", "Your input is needed")
    });
    if (interaction.questions.length > 1) {
      header.createSpan({
        cls: "codex-interaction-progress",
        text: `${index + 1}/${interaction.questions.length}`,
        attr: {
          "aria-label": conversationUiText(
            language,
            `第 ${index + 1} 个问题，共 ${interaction.questions.length} 个`,
            `Question ${index + 1} of ${interaction.questions.length}`
          )
        }
      });
    }

    const errorId = `codex-interaction-error-${safeDomIdentity(interaction.interactionId)}-${safeDomIdentity(question.questionId)}`;
    const fieldset = card.createEl("fieldset", {
      cls: "codex-interaction-question",
      attr: {
        ...(state.invalidQuestionId === question.questionId
          ? { "aria-describedby": errorId }
          : {})
      }
    });
    const legend = fieldset.createEl("legend", {
      cls: "codex-interaction-prompt",
      text: question.prompt
    });
    legend.id = `codex-interaction-prompt-${safeDomIdentity(interaction.interactionId)}-${safeDomIdentity(question.questionId)}`;
    const instruction = question.allowSupplement
      ? question.selection === "multiple"
        ? conversationUiText(
            language,
            "选择一项或多项，或填写自己的回答，也可以两者都填。",
            "Select one or more options, or write your own answer. You can also do both."
          )
        : conversationUiText(
            language,
            "选择一项或填写自己的回答，也可以两者都填。",
            "Select an option or write your own answer. You can also do both."
          )
      : question.selection === "multiple"
        ? conversationUiText(language, "可选择多项。", "Select one or more options.")
        : conversationUiText(language, "请选择一项。", "Select one option.");
    fieldset.createDiv({
      cls: "codex-interaction-instruction",
      text: instruction
    });
    const options = fieldset.createDiv({ cls: "codex-interaction-options" });
    const selected = state.selectedByQuestion.get(question.questionId)!;
    let firstControl: HTMLInputElement | null = null;
    for (const option of question.options) {
      const optionId = `codex-interaction-option-${safeDomIdentity(interaction.interactionId)}-${safeDomIdentity(question.questionId)}-${safeDomIdentity(option.optionId)}`;
      const label = options.createEl("label", {
        cls: `codex-interaction-option${selected.has(option.optionId) ? " is-selected" : ""}`,
        attr: { for: optionId }
      });
      const control = label.createEl("input", {
        cls: "codex-interaction-option-control",
        attr: {
          id: optionId,
          name: `codex-interaction-${safeDomIdentity(interaction.interactionId)}-${safeDomIdentity(question.questionId)}`,
          type: question.selection === "multiple" ? "checkbox" : "radio",
          value: option.optionId
        }
      });
      control.checked = selected.has(option.optionId);
      control.disabled = state.submitting;
      firstControl ??= control;
      const copy = label.createSpan({ cls: "codex-interaction-option-copy" });
      copy.createSpan({ cls: "codex-interaction-option-label", text: option.label });
      if (option.description) {
        copy.createSpan({
          cls: "codex-interaction-option-description",
          text: option.description
        });
      }
      control.onchange = () => {
        if (state.submitting) return;
        if (question.selection === "single") {
          selected.clear();
          for (const candidate of Array.from(
            options.querySelectorAll<HTMLInputElement>(".codex-interaction-option-control")
          )) {
            candidate.checked = candidate === control;
            candidate.closest("label")?.toggleClass("is-selected", candidate === control);
          }
        }
        if (control.checked) selected.add(option.optionId);
        else selected.delete(option.optionId);
        label.toggleClass("is-selected", control.checked);
        state.invalidQuestionId = null;
        fieldset.removeAttribute("aria-invalid");
        fieldset.removeAttribute("aria-describedby");
        error.textContent = "";
      };
    }

    let supplement: HTMLTextAreaElement | null = null;
    if (question.allowSupplement) {
      const supplementId = `codex-interaction-supplement-${safeDomIdentity(interaction.interactionId)}-${safeDomIdentity(question.questionId)}`;
      const supplementGroup = fieldset.createDiv({ cls: "codex-interaction-supplement" });
      supplementGroup.createEl("label", {
        cls: "codex-interaction-supplement-label",
        text: conversationUiText(language, "补充说明（可选）", "Additional details (optional)"),
        attr: { for: supplementId }
      });
      supplement = supplementGroup.createEl("textarea", {
        cls: "codex-interaction-supplement-input",
        attr: {
          id: supplementId,
          maxlength: "1000",
          rows: "2"
        }
      });
      supplement.value = state.supplementByQuestion.get(question.questionId) ?? "";
      supplement.disabled = state.submitting;
      supplement.oninput = () => {
        state.supplementByQuestion.set(question.questionId, supplement!.value);
        if (supplement!.value.trim()) {
          state.invalidQuestionId = null;
          fieldset.removeAttribute("aria-invalid");
          fieldset.removeAttribute("aria-describedby");
          const error = card.querySelector<HTMLElement>(`#${errorId}`);
          if (error) error.textContent = "";
        }
      };
    }

    const error = fieldset.createDiv({
      cls: "codex-interaction-error",
      attr: { id: errorId, "aria-live": "polite", role: "status" }
    });
    if (state.invalidQuestionId === question.questionId) {
      fieldset.setAttribute("aria-invalid", "true");
      error.textContent = question.allowSupplement
        ? conversationUiText(language, "请选择至少一项，或填写补充说明后继续。", "Select at least one option or add details to continue.")
        : question.selection === "multiple"
          ? conversationUiText(language, "请至少选择一项后继续。", "Select at least one option to continue.")
          : conversationUiText(language, "请选择一项后继续。", "Select one option to continue.");
    }

    const actions = card.createDiv({ cls: "codex-interaction-actions" });
    if (index > 0) {
      const previous = actions.createEl("button", {
        cls: "codex-interaction-action is-secondary",
        text: conversationUiText(language, "上一步", "Back"),
        attr: { type: "button" }
      });
      previous.disabled = state.submitting;
      previous.onclick = () => {
        if (state.submitting) return;
        state.activeIndex -= 1;
        state.invalidQuestionId = null;
        this.rerenderAndFocusQuestion();
      };
    }
    const primary = actions.createEl("button", {
      cls: "codex-interaction-action is-primary mod-cta",
      text: index + 1 < interaction.questions.length
        ? conversationUiText(language, "下一步", "Next")
        : conversationUiText(language, "提交回答", "Submit answers"),
      attr: { type: "button" }
    });
    primary.disabled = state.submitting;
    primary.onclick = () => {
      if (state.submitting) return;
      if (!questionHasAnswer(state, question)) {
        state.invalidQuestionId = question.questionId;
        this.rerender();
        window.setTimeout(() => {
          const refreshed = container.querySelector<HTMLInputElement>(
            ".codex-interaction-option-control"
          ) ?? container.querySelector<HTMLTextAreaElement>(
            ".codex-interaction-supplement-input"
          );
          refreshed?.focus();
        }, 0);
        return;
      }
      if (index + 1 < interaction.questions.length) {
        state.activeIndex += 1;
        state.invalidQuestionId = null;
        this.rerenderAndFocusQuestion();
        return;
      }
      const answers = interaction.questions.map((item) => questionAnswer(state, item));
      state.submitting = true;
      this.rerender();
      let accepted = false;
      try {
        accepted = binding.submit(answers);
      } catch {
        accepted = false;
      }
      if (accepted) {
        this.questionDrafts.delete(key);
        this.hide(container);
        input.question?.onResolved();
        input.onScheduleMeasure();
        return;
      }
      state.submitting = false;
      input.onStale();
      this.rerender();
    };

    if (firstPresentation) {
      window.setTimeout(() => firstControl?.focus(), 0);
    }
    input.onScheduleMeasure();
  }

  private renderConfirmation(
    container: HTMLElement,
    input: Readonly<InteractionDockRenderInput>,
    binding: Readonly<PiAgentApprovalDecisionBinding>,
    language: SettingsLanguage
  ): void {
    const key = `confirmation\0${input.sessionId}\0${binding.target}\0${binding.preview}`;
    const firstPresentation = this.activeSurfaceKey !== key;
    this.activeSurfaceKey = key;
    container.empty();
    container.addClass("is-visible");
    container.addClass("is-confirmation");
    container.removeClass("is-question");
    delete container.dataset.interactionId;
    const card = container.createDiv({
      cls: "codex-interaction-card codex-interaction-confirmation-card"
    });
    const elements = createAIElementsConfirmation(card, {
      state: "waiting_approval",
      target: binding.target,
      preview: binding.preview,
      ...(binding.deleteAction === true ? { deleteAction: true } : {}),
      controlled: true,
      language
    });
    if (!elements.approveButton || !elements.rejectButton) return;
    let deciding = false;
    const buttons = [elements.rejectButton, elements.approveButton];
    const decide = (decision: "approve" | "reject") => () => {
      if (deciding) return;
      deciding = true;
      elements.root.setAttribute("aria-busy", "true");
      for (const button of buttons) button.disabled = true;
      let accepted = false;
      try {
        accepted = binding.decide(decision);
      } catch {
        accepted = false;
      }
      if (accepted) {
        this.hide(container);
        input.confirmation?.onResolved();
        input.onScheduleMeasure();
        return;
      }
      deciding = false;
      elements.root.setAttribute("aria-busy", "false");
      for (const button of buttons) button.disabled = false;
      input.onStale();
    };
    elements.rejectButton.onclick = decide("reject");
    elements.approveButton.onclick = decide("approve");
    if (firstPresentation) {
      window.setTimeout(() => elements.approveButton?.focus(), 0);
    }
    input.onScheduleMeasure();
  }

  private questionState(
    key: string,
    interaction: Readonly<EchoInkQuestionInteraction>
  ): QuestionDraft {
    const existing = this.questionDrafts.get(key);
    if (existing) return existing;
    const state: QuestionDraft = {
      activeIndex: interaction.activeQuestionIndex ?? 0,
      selectedByQuestion: new Map(interaction.questions.map((question) => [
        question.questionId,
        new Set<string>()
      ])),
      supplementByQuestion: new Map(),
      invalidQuestionId: null,
      submitting: false
    };
    this.questionDrafts.set(key, state);
    return state;
  }

  private rerender(): void {
    if (!this.lastRender) return;
    this.render(this.lastRender.container, this.lastRender.input);
  }

  private rerenderAndFocusQuestion(): void {
    this.rerender();
    window.setTimeout(() => {
      this.lastRender?.container
        .querySelector<HTMLInputElement>(".codex-interaction-option-control")
        ?.focus();
    }, 0);
  }

  private hide(container: HTMLElement): void {
    container.empty();
    container.removeClass("is-visible");
    container.removeClass("is-question");
    container.removeClass("is-confirmation");
    delete container.dataset.interactionId;
    this.activeSurfaceKey = "";
  }
}

function questionStateKey(
  sessionId: string,
  interaction: Readonly<EchoInkQuestionInteraction>
): string {
  return `question\0${sessionId}\0${interaction.piSessionId}\0${interaction.turnId}\0${interaction.interactionId}`;
}

function questionHasAnswer(
  state: Readonly<QuestionDraft>,
  question: Readonly<EchoInkQuestionPrompt>
): boolean {
  return Boolean(
    state.selectedByQuestion.get(question.questionId)?.size
    || state.supplementByQuestion.get(question.questionId)?.trim()
  );
}

function questionAnswer(
  state: Readonly<QuestionDraft>,
  question: Readonly<EchoInkQuestionPrompt>
): Readonly<EchoInkQuestionAnswer> {
  const supplement = state.supplementByQuestion.get(question.questionId)?.trim();
  return Object.freeze({
    questionId: question.questionId,
    selectedOptionIds: Object.freeze([
      ...(state.selectedByQuestion.get(question.questionId) ?? [])
    ]),
    ...(supplement ? { supplement } : {})
  });
}

function clampQuestionIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), Math.trunc(index)));
}

function safeDomIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 96) || "item";
}
