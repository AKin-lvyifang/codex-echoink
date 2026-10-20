import type { SettingsLanguage } from "../../settings/settings";
import { Platform } from "obsidian";
import { conversationCopy } from "../../settings/i18n";
import { applyDeleteButton } from "../../settings/amicro-buttons";
import { formatApprovalPresentation, renderApprovalPresentation } from "./approval-presentation";

export const SMOOTH_BLUR_OUT_UP_DURATION_MS = 560;
export const SMOOTH_BLUR_OUT_UP_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
export const SMOOTH_BLUR_OUT_UP_STAGGER_MS = 28;

export type SmoothAIStatus = "pending" | "running" | "success" | "error";
export type SmoothAIApprovalState = "waiting_approval" | "approved" | "denied" | "cancelled" | "expired";

export interface SmoothAISuggestion {
  id: string;
  label: string;
}

interface SmoothBlurOutUpOptions {
  delay?: number;
  stagger?: number;
}

interface SmoothReasoningOptions {
  bodyId: string;
  open: boolean;
  status?: SmoothAIStatus;
  summary: string;
}

export interface SmoothAILoaderOptions {
  accessibleLabel?: string;
  language?: SettingsLanguage;
  labelClass?: string;
  visualLabelAriaHidden?: boolean;
}

export interface SmoothReasoningElements {
  body: HTMLElement;
  root: HTMLDetailsElement;
  summary: HTMLElement;
}

export interface SmoothArtifactElements {
  body: HTMLElement;
  root: HTMLElement;
}

export interface AIElementsDocumentSourcesElements {
  body: HTMLElement;
  root: HTMLDetailsElement;
  summary: HTMLElement;
}

export interface AIElementsTaskElements {
  body: HTMLElement;
  root: HTMLDetailsElement;
  summary: HTMLElement;
}

export interface SmoothAIApprovalCardElements {
  readonly root: HTMLElement;
  readonly approveButton?: HTMLButtonElement;
  readonly rejectButton?: HTMLButtonElement;
}

/**
 * Native DOM adaptations of the SmoothUI AI and Blur Out Up patterns.
 *
 * EchoInk keeps its existing Obsidian renderers and interactions; these
 * helpers only provide the small structural primitives shared by the
 * Conversation message body, reasoning, tool, task, and artifact surfaces.
 */
export function renderSmoothBlurOutUp(
  container: HTMLElement,
  text: string,
  options: SmoothBlurOutUpOptions = {}
): HTMLElement {
  const delay = finiteNonNegative(options.delay, 0);
  const stagger = finiteNonNegative(options.stagger, SMOOTH_BLUR_OUT_UP_STAGGER_MS);
  const root = container.createSpan({
    cls: "codex-smooth-blur-out-up",
    attr: {
      "aria-label": text,
      "data-duration-ms": String(SMOOTH_BLUR_OUT_UP_DURATION_MS),
      "data-easing": SMOOTH_BLUR_OUT_UP_EASING,
      "data-smooth-ui-pattern": "blur-out-up",
      "data-stagger-ms": String(stagger)
    }
  });

  let animatedIndex = 0;
  for (const unit of blurOutUpUnits(text)) {
    if (/^\s+$/u.test(unit)) {
      root.createSpan({
        cls: "codex-smooth-blur-out-up-space",
        text: unit,
        attr: { "aria-hidden": "true" }
      });
      continue;
    }
    root.createSpan({
      cls: "codex-smooth-blur-out-up-unit",
      text: unit,
      attr: {
        "aria-hidden": "true",
        style: `--codex-smooth-blur-delay: ${delay + animatedIndex * stagger}ms`
      }
    });
    animatedIndex += 1;
  }
  return root;
}

export function createSmoothAIMessageBody(container: HTMLElement): HTMLElement {
  markSmoothPattern(container, "ai-message", "codex-smooth-ai-message");
  return container.createDiv({ cls: "codex-smooth-ai-message-body" });
}

export function createSmoothAIReasoning(
  container: HTMLElement,
  options: SmoothReasoningOptions
): SmoothReasoningElements {
  const status = options.status ?? "pending";
  const root = container.createEl("details", {
    cls: `codex-smooth-ai-reasoning is-${status}`,
    attr: {
      "data-smooth-status": status,
      "data-smooth-ui-pattern": "ai-reasoning"
    }
  });
  root.open = options.open;
  const summary = root.createEl("summary", {
    cls: "codex-smooth-ai-reasoning-summary",
    attr: {
      "aria-controls": options.bodyId,
      "aria-expanded": String(options.open)
    }
  });
  summary.createSpan({
    cls: "codex-smooth-ai-reasoning-caret",
    attr: { "aria-hidden": "true" }
  });
  summary.createSpan({ cls: "codex-smooth-ai-reasoning-label", text: options.summary });
  const body = root.createDiv({
    cls: "codex-smooth-ai-reasoning-body",
    attr: { id: options.bodyId }
  });
  return { body, root, summary };
}

export function markSmoothAIReasoning(container: HTMLElement, status?: string): void {
  markSmoothPattern(container, "ai-reasoning", "codex-smooth-ai-reasoning");
  container.setAttribute("data-smooth-status", smoothAIStatus(status));
}

export function markSmoothAIToolCall(container: HTMLElement, status?: string): SmoothAIStatus {
  const mappedStatus = smoothAIStatus(status);
  markSmoothPattern(container, "ai-tool-call", "codex-smooth-ai-tool-call");
  container.setAttribute("data-smooth-status", mappedStatus);
  container.addClass(`is-${mappedStatus}`);
  return mappedStatus;
}

export function renderSmoothAIToolStatus(
  container: HTMLElement,
  status?: string
): HTMLElement {
  const mappedStatus = smoothAIStatus(status);
  return container.createSpan({
    cls: `codex-smooth-ai-tool-status is-${mappedStatus}`,
    attr: {
      "aria-hidden": "true",
      "data-smooth-status": mappedStatus
    }
  });
}

export function markSmoothAITaskList(container: HTMLElement): void {
  markSmoothPattern(container, "ai-task-list", "codex-smooth-ai-task-list");
}

export function createAIElementsTask(
  container: HTMLElement,
  options: Readonly<{
    bodyId: string;
    label: string;
    open: boolean;
  }>
): AIElementsTaskElements {
  const root = container.createEl("details", {
    cls: "codex-ai-elements-task",
    attr: {
      "aria-label": options.label,
      "data-ai-elements-pattern": "task"
    }
  });
  root.open = options.open;
  const summary = root.createEl("summary", {
    cls: "codex-ai-elements-task-trigger",
    attr: {
      "aria-controls": options.bodyId,
      "aria-expanded": String(options.open)
    }
  });
  const body = root.createDiv({
    cls: "codex-ai-elements-task-content",
    attr: { id: options.bodyId }
  });
  return { body, root, summary };
}

export function createSmoothAIArtifact(
  container: HTMLElement,
  title: string
): SmoothArtifactElements {
  const root = container.createDiv({
    cls: "codex-smooth-ai-artifact",
    attr: { "data-smooth-ui-pattern": "ai-artifact" }
  });
  const header = root.createDiv({ cls: "codex-smooth-ai-artifact-header" });
  header.createSpan({ cls: "codex-smooth-ai-artifact-title", text: title });
  const body = root.createDiv({ cls: "codex-smooth-ai-artifact-body" });
  return { body, root };
}

export function markSmoothAIArtifact(container: HTMLElement): void {
  markSmoothPattern(container, "ai-artifact", "codex-smooth-ai-artifact");
}

export function markSmoothAIDiff(container: HTMLElement): void {
  markSmoothPattern(container, "ai-diff", "codex-smooth-ai-diff");
}

export function markSmoothAIApproval(container: HTMLElement, state: SmoothAIApprovalState): void {
  markSmoothPattern(container, "ai-approval", "codex-smooth-ai-approval");
  container.addClass(`is-${state.replace("_", "-")}`);
  container.setAttribute("data-approval-state", state);
}

/** Native Obsidian DOM marker for Vercel AI Elements Question semantics. */
export function markAIElementsQuestion(container: HTMLElement): void {
  container.addClass("codex-ai-elements-question");
  container.setAttribute("data-ai-elements-pattern", "question");
}

export type AIElementsAttachmentVariant = "grid" | "inline" | "list";

/** Native Obsidian DOM marker for Vercel AI Elements Attachments semantics. */
export function markAIElementsAttachments(
  container: HTMLElement,
  variant: AIElementsAttachmentVariant,
  accessibleLabel: string
): void {
  container.addClass("codex-ai-elements-attachments");
  container.addClass(`is-${variant}`);
  container.setAttribute("data-ai-elements-pattern", "attachments");
  container.setAttribute("data-attachment-variant", variant);
  container.setAttribute("role", "list");
  container.setAttribute("aria-label", accessibleLabel);
}

export function markAIElementsAttachmentItem(
  container: HTMLElement,
  mediaCategory: "image" | "document"
): void {
  container.addClass("codex-ai-elements-attachment");
  container.setAttribute("data-attachment-media", mediaCategory);
  container.setAttribute("role", "listitem");
}

export function createSmoothAIApprovalCard(
  container: HTMLElement,
  options: Readonly<{
    state: SmoothAIApprovalState;
    target?: string;
    preview?: string;
    controlled?: boolean;
    deleteAction?: boolean;
    language?: SettingsLanguage;
  }>
): SmoothAIApprovalCardElements {
  const copy = conversationCopy(options.language ?? "zh-CN");
  const root = container.createDiv({
    cls: "codex-smooth-ai-approval-card",
    attr: {
      "aria-label": copy.approval.stateLabel(options.state),
      "aria-busy": "false",
      role: "group"
    }
  });
  markSmoothAIApproval(root, options.state);
  const header = root.createDiv({ cls: "codex-smooth-ai-approval-header" });
  header.createSpan({
    cls: "codex-smooth-ai-approval-state",
    text: copy.approval.stateLabel(options.state)
  });
  if (options.target?.trim()) {
    const target = root.createDiv({ cls: "codex-smooth-ai-approval-section" });
    target.createSpan({ cls: "codex-smooth-ai-approval-label", text: copy.approval.target });
    target.createEl("pre", {
      cls: "codex-smooth-ai-approval-content",
      text: options.target
    });
  }
  if (options.preview?.trim()) {
    const preview = root.createDiv({ cls: "codex-smooth-ai-approval-section" });
    preview.createSpan({ cls: "codex-smooth-ai-approval-label", text: copy.approval.preview });
    preview.createEl("pre", {
      cls: "codex-smooth-ai-approval-content",
      text: options.preview
    });
  }
  if (options.state !== "waiting_approval" || options.controlled !== true) {
    return { root };
  }
  const actions = root.createDiv({ cls: "codex-smooth-ai-approval-actions" });
  const rejectButton = actions.createEl("button", {
    cls: "codex-smooth-ai-approval-button is-reject",
    text: copy.approval.reject,
    attr: { type: "button" }
  });
  const approveButton = actions.createEl("button", {
    cls: "codex-smooth-ai-approval-button is-approve mod-cta",
    text: copy.approval.approve,
    attr: { type: "button" }
  });
  if (options.deleteAction === true) applyDeleteButton(approveButton);
  return { root, approveButton, rejectButton };
}

/** AI Elements Confirmation semantics with EchoInk's existing Smooth approval motion. */
export function createAIElementsConfirmation(
  container: HTMLElement,
  options: Readonly<{
    state: SmoothAIApprovalState;
    target?: string;
    preview?: string;
    controlled?: boolean;
    deleteAction?: boolean;
    language?: SettingsLanguage;
  }>
): SmoothAIApprovalCardElements {
  const elements = createSmoothAIApprovalCard(container, Platform.isMobile ? options : { ...options, target: undefined, preview: undefined });
  elements.root.addClass("codex-ai-elements-confirmation");
  elements.root.setAttribute("data-ai-elements-pattern", "confirmation");
  if (Platform.isMobile) return elements;
  elements.root.addClass("has-readable-approval");
  // Move the original action node after the new body; callers still bind these exact buttons.
  const actions = elements.root.querySelector<HTMLElement>(".codex-smooth-ai-approval-actions");
  actions?.remove();
  renderApprovalPresentation(elements.root, formatApprovalPresentation(options));
  if (actions) elements.root.append(actions);
  return elements;
}

export function markSmoothAISources(container: HTMLElement): void {
  markSmoothPattern(container, "ai-sources", "codex-smooth-ai-sources");
}

/** Native Obsidian DOM adaptation of Vercel AI Elements Sources for local documents. */
export function createAIElementsDocumentSources(
  container: HTMLElement,
  count: number,
  open: boolean,
  language: SettingsLanguage = "en"
): AIElementsDocumentSourcesElements {
  const copy = conversationCopy(language);
  const documentCount = Math.max(0, Math.trunc(count));
  const root = container.createEl("details", {
    cls: "codex-ai-elements-sources",
    attr: { "data-ai-elements-pattern": "sources" }
  });
  root.open = open;
  const summary = root.createEl("summary", {
    cls: "codex-ai-elements-sources-trigger",
    attr: { "aria-expanded": String(open) }
  });
  summary.createSpan({
    cls: "codex-ai-elements-sources-label",
    text: copy.sources.usedDocuments(documentCount)
  });
  summary.createSpan({
    cls: "codex-ai-elements-sources-chevron",
    attr: { "aria-hidden": "true" }
  });
  const body = root.createDiv({ cls: "codex-ai-elements-sources-content" });
  return { body, root, summary };
}

export function renderSmoothAILoader(
  container: HTMLElement,
  label: string,
  options: SmoothAILoaderOptions = {}
): HTMLElement {
  const visualLabel = label.trim();
  const accessibleLabel = options.accessibleLabel?.trim()
    || visualLabel
    || ((options.language ?? "zh-CN") === "en" ? "Loading" : "正在加载");
  const root = container.createSpan({
    cls: "codex-smooth-ai-loader",
    attr: {
      "aria-label": accessibleLabel,
      "aria-live": "polite",
      "data-smooth-ui-pattern": "ai-loader",
      role: "status"
    }
  });
  if (visualLabel) {
    const labelClass = options.labelClass?.trim();
    root.createSpan({
      cls: `codex-smooth-ai-loader-label${labelClass ? ` ${labelClass}` : ""}`,
      text: label,
      ...(options.visualLabelAriaHidden
        ? { attr: { "aria-hidden": "true" } }
        : {})
    });
  }
  const dots = root.createSpan({
    cls: "codex-smooth-ai-loader-dots",
    attr: { "aria-hidden": "true" }
  });
  for (let index = 0; index < 3; index += 1) {
    dots.createSpan({
      cls: "codex-smooth-ai-loader-dot",
      attr: { style: `--codex-smooth-loader-index: ${index}` }
    });
  }
  return root;
}

export function markSmoothAIResponse(container: HTMLElement, isStreaming: boolean): void {
  markSmoothPattern(container, "ai-response", "codex-smooth-ai-response");
  container.toggleClass("is-streaming", isStreaming);
  container.setAttribute("data-streaming", String(isStreaming));
  if (isStreaming) {
    container.createSpan({
      cls: "codex-smooth-ai-response-caret",
      attr: { "aria-hidden": "true" }
    });
  }
}

export function renderSmoothAISuggestions(
  container: HTMLElement,
  suggestions: readonly SmoothAISuggestion[],
  onSelect: (suggestion: SmoothAISuggestion) => void,
  accessibleLabel?: string,
  language: SettingsLanguage = "zh-CN"
): HTMLElement {
  const root = container.createDiv({
    cls: "codex-smooth-ai-suggestions",
    attr: {
      "aria-label": accessibleLabel?.trim()
        || conversationCopy(language).message.suggestionsAria,
      "data-smooth-ui-pattern": "ai-suggestions"
    }
  });
  const list = root.createEl("ul", { cls: "codex-smooth-ai-suggestions-list" });
  const middle = (suggestions.length - 1) / 2;
  suggestions.forEach((suggestion, index) => {
    const item = list.createEl("li", {
      cls: "codex-smooth-ai-suggestion-item",
      attr: {
        style: `--codex-smooth-suggestion-order: ${Math.abs(index - middle)}`
      }
    });
    const button = item.createEl("button", {
      cls: "codex-smooth-ai-suggestion",
      text: suggestion.label,
      attr: { type: "button" }
    });
    button.onclick = () => onSelect(suggestion);
  });
  return root;
}

export function smoothAIStatus(status?: string): SmoothAIStatus {
  if (status === "running" || status === "in_progress" || status === "inProgress"
    || status === "waiting_approval" || status === "approved" || status === "verifying"
    || status === "blocked") return "running";
  if (status === "completed" || status === "success" || status === "done") return "success";
  if (status === "error" || status === "failed" || status === "denied"
    || status === "uncertain" || status === "recovery-blocked") return "error";
  return "pending";
}

function markSmoothPattern(container: HTMLElement, pattern: string, className: string): void {
  container.addClass(className);
  container.setAttribute("data-smooth-ui-pattern", pattern);
}

function blurOutUpUnits(text: string): string[] {
  if (!text.trim() || !/\s/u.test(text.trim())) return [text];
  return text.split(/(\s+)/u).filter(Boolean);
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}
