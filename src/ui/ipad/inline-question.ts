import type { EchoInkQuestionAnswer } from "../../types/conversation-turn";
import type { MobileTaskInteraction } from "../../mobile/task-contracts";
import type { IPadPageContext } from "./workbench-contract";
import { shellElement } from "../mobile/shell-controls";

const flights = new WeakMap<object, Set<string>>();
const identity = (interaction: MobileTaskInteraction) => JSON.stringify([interaction.taskId, interaction.runId, interaction.questionId, interaction.createdAt, interaction.questions]);

/** The same inline answer surface is used in the workbench and the message stream. */
export function createInlineQuestion(ctx: IPadPageContext, taskId: string, onAnswered?: () => void | Promise<void>): { element: HTMLElement; dispose(): void } {
  const element = shellElement(ctx.document, "section", "pd-inline-question");
  element.setAttribute("aria-label", "等你回应");
  let interaction: MobileTaskInteraction | undefined;
  let key = "", disposed = false, error = "", sheet: HTMLElement | undefined, frame: number | undefined;
  const answers = new Map<string, { selected: Set<string>; supplement: string }>();
  const pending = flights.get(ctx.host.runtime) ?? new Set<string>();
  flights.set(ctx.host.runtime, pending);
  const current = () => {
    const state = ctx.host.runtime.stateFor(taskId);
    return state.busy && state.interaction?.status === "pending" && identity(state.interaction) === key;
  };
  const updateControls = () => {
    for (const surface of [element, sheet]) if (surface) {
      surface.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>("button, textarea").forEach(control => {
        control.disabled = pending.has(key) || !current();
        control.setAttribute("aria-busy", String(pending.has(key)));
      });
      surface.querySelectorAll<HTMLElement>(".pd-question-error").forEach(node => { node.textContent = error; node.hidden = !error; });
    }
  };
  const submit = async () => {
    if (disposed || !interaction || pending.has(key)) return;
    if (!current()) { error = "问题已失效。"; updateControls(); return; }
    const snapshot = structuredClone(interaction), submittedKey = key;
    const submitted: EchoInkQuestionAnswer[] = snapshot.questions.map(question => {
      const answer = answers.get(question.questionId)!;
      return { questionId: question.questionId, selectedOptionIds: [...answer.selected],
        ...(question.allowSupplement && answer.supplement.trim() ? { supplement: answer.supplement } : {}) };
    });
    if (submitted.some(answer => !answer.selectedOptionIds.length && !answer.supplement?.trim())) {
      error = "请完成选择或填写补充。"; updateControls(); return;
    }
    pending.add(submittedKey); error = ""; updateControls();
    let succeeded = false;
    try {
      await ctx.host.runtime.answerQuestion(taskId, snapshot.runId, snapshot.questionId, submitted);
      succeeded = true;
      if (!disposed && submittedKey === key) { if (sheet) ctx.shell.closeSheet(); element.hidden = true; }
    } catch (failure) {
      if (!disposed && submittedKey === key) { error = failure instanceof Error ? failure.message : String(failure); updateControls(); }
    } finally { pending.delete(submittedKey); if (!disposed) { refresh(); updateControls(); } }
    // Runtime notification can remove the waiting card before admission resolves.
    // The owning page decides whether its navigation callback is still current.
    if (succeeded && onAnswered) { try { await onAnswered(); } catch (failure) { ctx.error(failure); } }
  };
  const render = (surface: HTMLElement) => {
    surface.replaceChildren();
    if (!interaction) return;
    const immediate = interaction.questions.length === 1 && interaction.questions[0].selection === "single" && interaction.questions[0].options.length > 0;
    for (const question of interaction.questions) {
      const group = shellElement(ctx.document, "div", "pd-question-group");
      group.dataset.questionId = question.questionId;
      group.append(shellElement(ctx.document, "div", "pd-question-prompt", question.prompt));
      const choices = shellElement(ctx.document, "div", "pd-question-options");
      group.append(choices); surface.append(group);
      const draft = answers.get(question.questionId)!;
      for (const option of question.options) {
        const button = shellElement(ctx.document, "button", "pd-action pd-question-option"); button.type = "button";
        const label = shellElement(ctx.document, "span", "pd-action-visible");
        label.append(shellElement(ctx.document, "span", "", option.label));
        if (option.description) label.append(shellElement(ctx.document, "span", "pd-option-description", option.description));
        button.append(label); button.dataset.optionId = option.optionId;
        button.setAttribute("aria-pressed", String(draft.selected.has(option.optionId)));
        button.addEventListener("click", event => {
          event.stopPropagation(); if (pending.has(key)) return;
          if (!current()) { error = "问题已失效。"; updateControls(); return; }
          if (question.selection === "single") draft.selected = new Set([option.optionId]);
          else if (draft.selected.has(option.optionId)) draft.selected.delete(option.optionId); else draft.selected.add(option.optionId);
          for (const parent of [element, sheet]) parent?.querySelectorAll<HTMLButtonElement>(".pd-question-option").forEach(control => {
            if (control.closest<HTMLElement>(".pd-question-group")?.dataset.questionId === question.questionId) control.setAttribute("aria-pressed", String(draft.selected.has(control.dataset.optionId ?? "")));
          });
          if (immediate) void submit();
        });
        choices.append(button);
      }
      if (question.allowSupplement) {
        const input = shellElement(ctx.document, "textarea", "pd-question-supplement"); input.rows = 2;
        input.setAttribute("aria-label", `补充：${question.prompt}`); input.placeholder = "补充"; input.value = draft.supplement;
        input.addEventListener("input", () => { draft.supplement = input.value; }); group.append(input);
      }
    }
    const errorNode = shellElement(ctx.document, "p", "pd-question-error"); errorNode.setAttribute("role", "alert"); surface.append(errorNode);
    if (!immediate) {
      const actions = shellElement(ctx.document, "div", "pd-task-actions");
      const confirm = shellElement(ctx.document, "button", "pd-action pd-primary"); confirm.type = "button";
      confirm.append(shellElement(ctx.document, "span", "pd-action-visible", "确认选择"));
      confirm.addEventListener("click", event => { event.stopPropagation(); void submit(); }); actions.append(confirm); surface.append(actions);
    }
  };
  const refresh = () => {
    if (disposed) return;
    const state = ctx.host.runtime.stateFor(taskId), next = state.interaction;
    if (!next || next.taskId !== taskId || next.status !== "pending" || !state.busy) {
      if (interaction) {
        error = next?.status === "answered" && identity(next) === key ? "已回应" : "问题已失效。";
        element.hidden = !state.busy || next?.status === "answered";
        updateControls();
      } else element.hidden = true;
      return;
    }
    const nextKey = identity(next);
    if (nextKey !== key) {
      if (sheet) ctx.shell.closeSheet();
      key = nextKey; interaction = structuredClone(next); error = ""; answers.clear();
      for (const question of next.questions) answers.set(question.questionId, { selected: new Set(), supplement: "" });
      render(element);
      scheduleOverflow();
    }
    element.hidden = false; updateControls();
  };
  // A short screen may overflow vertically; ordinary two-option questions stay inline.
  const openOverflow = () => {
    if (disposed || !interaction || sheet || !element.isConnected || element.clientHeight === 0) return;
    const viewport = element.closest<HTMLElement>(".echoink-ipad-content")?.clientHeight
      || ctx.root.clientHeight || ctx.document.defaultView?.visualViewport?.height || ctx.document.documentElement.clientHeight;
    if (!viewport || element.clientHeight < viewport * .65) { element.querySelector(".pd-question-overflow")?.remove(); return; }
    if (element.querySelector(".pd-question-overflow")) return;
    const opener = shellElement(ctx.document, "button", "pd-action pd-question-overflow"); opener.type = "button";
    opener.append(shellElement(ctx.document, "span", "pd-action-visible", "展开问题"));
    opener.addEventListener("click", event => {
      event.stopPropagation(); if (!current()) return;
      sheet = shellElement(ctx.document, "div", "pd-question-sheet"); render(sheet); updateControls();
      ctx.shell.openSheet({ title: "等你回应", content: sheet, onClose: () => { sheet = undefined; } });
    });
    element.append(opener);
  };
  function scheduleOverflow() {
    if (frame !== undefined) ctx.document.defaultView?.cancelAnimationFrame(frame);
    frame = ctx.document.defaultView?.requestAnimationFrame(openOverflow);
  }
  refresh();
  const unsubscribe = ctx.host.runtime.subscribe(id => { if (id === taskId) refresh(); });
  ctx.document.defaultView?.addEventListener("resize", scheduleOverflow);
  const Resize = ctx.document.defaultView?.ResizeObserver;
  const resize = Resize ? new Resize(scheduleOverflow) : undefined; resize?.observe(ctx.root);
  return { element, dispose() { if (disposed) return; disposed = true; unsubscribe(); resize?.disconnect(); ctx.document.defaultView?.removeEventListener("resize", scheduleOverflow); if (frame !== undefined) ctx.document.defaultView?.cancelAnimationFrame(frame); if (sheet) ctx.shell.closeSheet(); } };
}
