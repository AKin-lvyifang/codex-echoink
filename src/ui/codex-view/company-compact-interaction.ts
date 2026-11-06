import { setIcon } from "obsidian";
import { attachNativeTooltip, type NativeTooltipHandle } from "../native-tooltip";
import type { EchoInkQuestionPrompt } from "../../types/conversation-turn";
import type { SettingsLanguage } from "../../settings/settings";
import { companyApprovalSummary, renderApprovalPresentation, type ApprovalPresentation } from "./approval-presentation";
import type { SmoothAIApprovalCardElements } from "./smooth-chat-ui";
import { conversationUiText } from "./ui-i18n";

export interface CompanyCompactIdentity {
  readonly name: string;
  readonly avatarUrl?: string | null;
  /** Project name on the workbench; omitted on its own project page. */
  readonly context?: string;
}

const tooltipOwners = new WeakMap<HTMLElement, Set<NativeTooltipHandle>>();
function fullTextTooltip(root: HTMLElement, trigger: HTMLElement, text: string): void {
  trigger.setAttribute("aria-label", trigger.getAttribute("aria-label") ?? text);
  const handles = tooltipOwners.get(root) ?? new Set<NativeTooltipHandle>();
  handles.add(attachNativeTooltip(trigger, text)); tooltipOwners.set(root, handles);
}

/** Called by the owning Dock before redraw, hide and dispose, including detached old mounts. */
export function disposeCompanyCompactTooltips(container: HTMLElement): void {
  const roots = Array.from(container.querySelectorAll<HTMLElement>(".echoink-company-compact-card"));
  if (container.classList.contains("echoink-company-compact-card")) roots.push(container);
  for (const root of roots) {
    for (const handle of tooltipOwners.get(root) ?? []) handle.dispose();
    tooltipOwners.delete(root);
  }
}

function avatar(parent: HTMLElement, identity: CompanyCompactIdentity): void {
  const node = parent.createSpan({ cls: "echoink-company-compact-avatar", attr: { "aria-hidden": "true" } });
  if (identity.avatarUrl) node.createEl("img", { attr: { src: identity.avatarUrl, alt: "", draggable: "false" } });
  else setIcon(node, "bot");
}
const metadata = (identity: CompanyCompactIdentity, folder?: string) => [identity.name, identity.context, folder].filter(Boolean).join(" · ");

/** Repositions the existing approval buttons; the Dock keeps their original binding and decide handler. */
export function renderCompanyCompactApproval(elements: SmoothAIApprovalCardElements, presentation: ApprovalPresentation,
  identity: CompanyCompactIdentity, deleting: boolean, language: SettingsLanguage): void {
  const root = elements.root, summary = companyApprovalSummary(presentation);
  root.addClass("echoink-company-compact-card", "is-approval");
  root.toggleClass("is-danger", deleting);
  root.setAttribute("aria-label", [summary.verb, summary.target].filter(Boolean).join(" "));
  root.querySelector(".codex-smooth-ai-approval-header")?.remove();
  const actions = root.querySelector<HTMLElement>(".codex-smooth-ai-approval-actions");
  actions?.remove();
  const head = root.createDiv({ cls: "echoink-company-compact-head" });
  avatar(head, identity);
  const heading = head.createEl("h2", { cls: "echoink-company-compact-title" });
  heading.createSpan({ cls: "echoink-company-compact-verb", text: summary.verb });
  if (summary.target) heading.append(heading.ownerDocument.createTextNode(` ${summary.target}`));
  fullTextTooltip(root, heading, [summary.verb, summary.target].filter(Boolean).join(" "));
  if (actions) { actions.addClass("echoink-company-compact-actions"); head.append(actions); }
  const details = root.createEl("details", { cls: "echoink-company-compact-details" });
  const toggle = details.createEl("summary", { cls: "echoink-company-compact-summary" });
  const meta = metadata(identity, summary.folder);
  toggle.createSpan({ cls: "echoink-company-compact-meta", text: meta });
  toggle.setAttribute("aria-label", `${meta} · ${conversationUiText(language, "详情", "Details")}`);
  // One binding on the native summary covers both metadata hover and keyboard focus.
  fullTextTooltip(root, toggle, meta);
  const label = toggle.createSpan({ cls: "echoink-company-compact-detail-label", text: conversationUiText(language, "详情", "Details") });
  setIcon(label.createSpan({ cls: "echoink-company-compact-chevron", attr: { "aria-hidden": "true" } }), "chevron-right");
  renderApprovalPresentation(details.createDiv({ cls: "echoink-company-compact-body" }), presentation, { companyCompact: true });
}

/** Presentation only. Question drafts, validation, navigation and submit remain in InteractionDockController. */
export function renderCompanyCompactQuestion(card: HTMLElement, identity: CompanyCompactIdentity, question: Readonly<EchoInkQuestionPrompt>,
  language: SettingsLanguage): { choices: HTMLElement; input?: HTMLTextAreaElement; submit?: HTMLButtonElement; error: HTMLElement } {
  card.addClass("echoink-company-compact-card", "is-question");
  card.setAttribute("aria-label", question.prompt);
  const head = card.createDiv({ cls: "echoink-company-compact-head" });
  avatar(head, identity);
  fullTextTooltip(card, head.createEl("h2", { cls: "echoink-company-compact-title", text: question.prompt }), question.prompt);
  fullTextTooltip(card, card.createDiv({ cls: "echoink-company-compact-meta echoink-company-compact-question-meta", text: identity.name }), identity.name);
  const choices = card.createDiv({ cls: "echoink-company-compact-choices" });
  let input: HTMLTextAreaElement | undefined, submit: HTMLButtonElement | undefined;
  if (!question.options.length) {
    input = choices.createEl("textarea", { cls: "codex-interaction-supplement-input echoink-company-compact-answer",
      attr: { rows: "2", maxlength: "1000", "aria-label": conversationUiText(language, "你的回答", "Your answer"), placeholder: conversationUiText(language, "你的回答…", "Your answer…") } });
    submit = choices.createEl("button", { cls: "codex-interaction-action is-primary mod-cta echoink-company-compact-send", text: conversationUiText(language, "回答", "Answer"), attr: { type: "button" } });
  }
  const error = card.createDiv({ cls: "codex-interaction-error echoink-company-compact-error", attr: { role: "status", "aria-live": "polite" } });
  return { choices, input, submit, error };
}
