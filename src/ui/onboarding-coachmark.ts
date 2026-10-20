import { Scope, setIcon, type App } from "obsidian";
import {
  renderAnimatedSettingsTabIcon,
  type AnimatedSettingsTabIconName
} from "../settings/animated-settings-tab-icon";
import type { EchoInkOnboardingStep } from "../settings/onboarding";

export interface EchoInkOnboardingCoachmarkOptions {
  readonly app?: Pick<App, "keymap" | "scope">;
  readonly anchor: HTMLElement;
  readonly highlightAnchor?: HTMLElement;
  readonly stepClass: string;
  readonly stepLabel: string;
  readonly title: string;
  readonly description: string;
  readonly tip?: string;
  readonly icon?: AnimatedSettingsTabIconName;
  readonly tone?: "purple" | "green" | "gold";
  readonly complete?: boolean;
  readonly steps?: readonly Readonly<{ key: EchoInkOnboardingStep; label: string }>[];
  readonly progressLabel?: string;
  readonly previousLabel?: string;
  readonly dismissLabel?: string;
  readonly actionLabel?: string | null;
  readonly restoreFocusEl?: HTMLElement | null;
  readonly initialFocus?: "coachmark" | "anchor";
  readonly onAction?: () => void | Promise<void>;
  readonly onPrevious?: () => void | Promise<void>;
  readonly onStep?: (step: EchoInkOnboardingStep) => void | Promise<void>;
  readonly onDismiss?: () => void | boolean | Promise<void | boolean>;
  readonly onActionError?: (error: unknown) => void;
}

export interface EchoInkOnboardingCoachmarkHandle {
  readonly element: HTMLElement;
  destroy(restoreFocus?: boolean): void;
}

// A removed card leaves only a short-lived geometry snapshot, never an orphan
// overlay or listener. The next step can animate from it in the same window.
const previousSpotlights = new WeakMap<Document, { rect: DOMRect; time: number }>();
const previousGuideSteps = new WeakMap<Document, string>();

/** One guide in the target's own window; callbacks retain product navigation. */
export function mountEchoInkOnboardingCoachmark(
  options: Readonly<EchoInkOnboardingCoachmarkOptions>
): EchoInkOnboardingCoachmarkHandle {
  const { anchor } = options;
  const highlightAnchor = options.highlightAnchor ?? anchor;
  const ownerDocument = anchor.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  // Protect the whole form, not just its title. The slot lives beside that
  // surface so an Agent preset can repaint the editor without deleting it.
  // The card stays on body, outside settings' descendant button rules.
  const protectedSurface = highlightAnchor.closest<HTMLElement>(".echoink-settings-page")
    ?? highlightAnchor.closest<HTMLElement>(".echoink-agent-editor")
    ?? highlightAnchor.closest<HTMLElement>(".echoink-agent-tasks");
  let currentHighlight = highlightAnchor;
  let reservedSpace: HTMLElement | null = null;
  const active = ownerDocument.activeElement;
  const restoreFocusEl = options.restoreFocusEl
    ?? (active instanceof (ownerWindow.HTMLElement ?? HTMLElement) ? active : null);
  const spotlight = options.complete ? null : ownerDocument.body.createDiv({
    cls: "echoink-onboarding-spotlight",
    attr: { "aria-hidden": "true" }
  });
  const previousSpotlight = previousSpotlights.get(ownerDocument);
  previousSpotlights.delete(ownerDocument);
  if (spotlight && previousSpotlight && Date.now() - previousSpotlight.time < 1000) {
    const rect = previousSpotlight.rect;
    spotlight.setCssStyles({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    // Resolve the inherited geometry before assigning the new target below.
    spotlight.getBoundingClientRect();
  }
  const coachmark = ownerDocument.body.createDiv({
    cls: `echoink-onboarding-coachmark is-${options.stepClass}`,
    attr: { role: "dialog", "aria-modal": "false", "aria-label": options.title, tabindex: "-1" }
  });
  coachmark.dataset.tone = options.tone ?? "purple";
  coachmark.toggleClass("is-repaint", previousGuideSteps.get(ownerDocument) === options.stepClass);
  previousGuideSteps.set(ownerDocument, options.stepClass);
  coachmark.toggleClass("is-complete", Boolean(options.complete));
  if (spotlight) highlightAnchor.addClass("is-echoink-onboarding-target");
  let destroyed = false;
  let pending = false;
  const buttons: HTMLButtonElement[] = [];
  // Serialize all controls, including Escape, until persistence settles. Failed
  // saves leave this card open with every control usable for another attempt.
  const run = async (callback: () => void | Promise<void>) => {
    if (destroyed || pending) return;
    pending = true;
    coachmark.setAttr("aria-busy", "true");
    buttons.forEach(button => { button.disabled = true; });
    try { await callback(); }
    catch (error) { options.onActionError?.(error); }
    finally {
      pending = false;
      if (!destroyed) {
        coachmark.setAttr("aria-busy", "false");
        buttons.forEach(button => { button.disabled = false; });
      }
    }
  };
  const button = (parent: HTMLElement, cls: string, label: string, callback: () => void | Promise<void>) => {
    const element = parent.createEl("button", {
      cls, attr: { type: "button", "aria-label": label }
    });
    buttons.push(element);
    element.onclick = () => { void run(callback); };
    return element;
  };
  const icon = (parent: HTMLElement, name: string, cls = "") => {
    const element = parent.createSpan({ cls, attr: { "aria-hidden": "true", "data-echoink-icon": name } });
    setIcon(element, name);
    return element;
  };
  const dismiss = async () => {
    if (await options.onDismiss?.() === false) return;
    destroy(true);
  };
  const top = options.complete ? coachmark : coachmark.createDiv({ cls: "echoink-onboarding-topline" });
  const tile = top.createSpan({ cls: "echoink-onboarding-step-icon", attr: { "aria-hidden": "true" } });
  if (options.complete) setIcon(tile, "check");
  else {
    const animated = tile.createSpan({ cls: "settings-motion-icon" });
    renderAnimatedSettingsTabIcon(animated, options.icon ?? "sparkles", 0);
    top.createSpan({ cls: "echoink-onboarding-step", text: options.stepLabel });
    if (options.dismissLabel) icon(button(top, "echoink-onboarding-dismiss", options.dismissLabel, dismiss), "x");
  }
  coachmark.createEl("h2", { cls: "echoink-onboarding-title", text: options.title });
  coachmark.createEl("p", { cls: "echoink-onboarding-copy", text: options.description });
  if (options.tip) {
    const tip = coachmark.createDiv({ cls: "echoink-onboarding-tip" });
    icon(tip, "circle-help");
    tip.createSpan({ text: options.tip });
  }
  if (options.steps) {
    const progress = coachmark.createDiv({
      cls: "echoink-onboarding-progress",
      attr: { role: "group", "aria-label": options.progressLabel ?? options.stepLabel }
    });
    const index = options.steps.findIndex(step => step.key === options.stepClass);
    options.steps.forEach((step, i) => {
      const dot = button(progress, "echoink-onboarding-progress-step", step.label, async () => {
        if (i !== index) await options.onStep?.(step.key);
      });
      dot.dataset.tourStep = step.key;
      dot.toggleClass("is-done", i < index);
      dot.toggleClass("is-current", i === index);
      if (i === index) dot.setAttr("aria-current", "step");
    });
  }
  const actions = coachmark.createDiv({ cls: "echoink-onboarding-actions" });
  if (options.previousLabel) {
    const previous = button(actions, "echoink-onboarding-previous", options.previousLabel, options.onPrevious ?? dismiss);
    if (!options.complete && options.stepClass !== "sidebar") icon(previous, "chevron-left");
    previous.createSpan({ text: options.previousLabel });
  }
  const action = options.actionLabel && options.onAction
    ? button(actions, "echoink-onboarding-action", options.actionLabel, options.onAction)
    : null;
  if (action) {
    action.createSpan({ cls: "echoink-onboarding-action-label", text: options.actionLabel ?? "" });
    icon(action, "arrow-right", "echoink-onboarding-action-icon");
  }

  const releaseReservedSpace = () => {
    if (!reservedSpace) return;
    reservedSpace.remove(); reservedSpace = null;
    coachmark.removeClass("is-reserved");
    coachmark.style.removeProperty("max-height");
    coachmark.style.removeProperty("clip-path");
  };
  const position = () => {
    if (destroyed) return;
    if (protectedSurface && !protectedSurface.isConnected) { destroy(); return; }
    if (!currentHighlight.isConnected && protectedSurface) {
      const replacement = protectedSurface.querySelector<HTMLElement>(".echoink-agent-editor-header");
      if (replacement) {
        observer?.unobserve(currentHighlight); currentHighlight.removeClass("is-echoink-onboarding-target");
        currentHighlight = replacement; currentHighlight.addClass("is-echoink-onboarding-target"); observer?.observe(currentHighlight);
      }
    }
    const bounds = protectedSurface?.getBoundingClientRect();
    const width = Math.min(ownerWindow.innerWidth <= 650 ? ownerWindow.innerWidth - 24 : 348, ownerWindow.innerWidth - 24);
    const fitsBeside = !bounds || bounds.right + width + 26 <= ownerWindow.innerWidth || bounds.left - width - 26 >= 0;
    if (spotlight && protectedSurface?.parentElement && !fitsBeside) {
      if (!reservedSpace) {
        reservedSpace = ownerDocument.createElement("div"); reservedSpace.className = "echoink-onboarding-space";
        protectedSurface.parentElement.insertBefore(reservedSpace, protectedSurface);
        coachmark.addClass("is-reserved");
      }
      const availableHeight = protectedSurface.parentElement.getBoundingClientRect().height || ownerWindow.innerHeight;
      const editor = protectedSurface.matches(".echoink-agent-editor, .echoink-agent-tasks");
      coachmark.style.maxHeight = `${Math.max(80, Math.min(ownerWindow.innerHeight - 24, availableHeight - (editor ? 220 : 24)))}px`;
    } else releaseReservedSpace();
    positionOnboardingCoachmark(coachmark, spotlight, currentHighlight, ownerWindow, protectedSurface, reservedSpace);
  };
  const observer = typeof ownerWindow.ResizeObserver === "undefined"
    ? null : new ownerWindow.ResizeObserver(position);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const openOverlay = Array.from(ownerDocument.querySelectorAll<HTMLElement>("[role=listbox], [role=menu], [data-state=open][role=dialog], .echoink-settings-inline-confirm"))
      .some(element => element.getClientRects().length > 0 && ownerWindow.getComputedStyle(element).visibility !== "hidden");
    if (openOverlay) return;
    event.preventDefault();
    // Obsidian's settings Escape handler must not also close the host before
    // the tutorial's dismissal has been saved (or reported as failed).
    event.stopImmediatePropagation();
    void run(dismiss);
  };
  // Obsidian 1.13.7 handles keys at window capture through a per-window
  // Scope stack, before document listeners. Use that same stack, as our Origin
  // Select does. pushScope targets activeWindow; a background settings render
  // waits for its owning window to focus instead of claiming another window.
  let escapeScope: Scope | null = null;
  const activateEscapeScope = () => {
    if (destroyed || escapeScope || !options.app?.keymap || !ownerDocument.hasFocus()) return;
    escapeScope = new Scope(options.app.scope);
    escapeScope.register(null, "Escape", (event) => {
      onKeyDown(event);
      return event.defaultPrevented ? false : undefined;
    });
    options.app.keymap.pushScope(escapeScope);
  };
  const frames: number[] = [];
  const destroy = (restoreFocus = false) => {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    ownerWindow.removeEventListener("focus", activateEscapeScope);
    if (escapeScope) options.app?.keymap.popScope(escapeScope);
    escapeScope = null;
    frames.forEach(frame => ownerWindow.cancelAnimationFrame(frame));
    ownerWindow.removeEventListener("resize", position);
    ownerDocument.removeEventListener("scroll", position, true);
    ownerDocument.removeEventListener("keydown", onKeyDown, true);
    if (spotlight) currentHighlight.removeClass("is-echoink-onboarding-target");
    if (spotlight && !restoreFocus) {
      previousSpotlights.set(ownerDocument, { rect: spotlight.getBoundingClientRect(), time: Date.now() });
    } else previousSpotlights.delete(ownerDocument);
    spotlight?.remove();
    coachmark.remove();
    reservedSpace?.remove(); reservedSpace = null;
    if (restoreFocus && restoreFocusEl?.isConnected) restoreFocusEl.focus({ preventScroll: true });
  };
  if (spotlight) observer?.observe(highlightAnchor);
  if (protectedSurface) observer?.observe(protectedSurface);
  observer?.observe(coachmark);
  ownerWindow.addEventListener("resize", position);
  ownerWindow.addEventListener("focus", activateEscapeScope);
  ownerDocument.addEventListener("scroll", position, true);
  ownerDocument.addEventListener("keydown", onKeyDown, true);
  // Settings restores scroll after render; settle two layout frames before
  // considering the target revealed. Destroy cancels any outstanding frames.
  const revealAnchor = () => {
    if (destroyed || !anchor.isConnected && !protectedSurface?.isConnected) return;
    position();
    if (spotlight) (reservedSpace ?? currentHighlight).scrollIntoView({ behavior: "auto", block: reservedSpace ? "nearest" : "center", inline: "nearest" });
    position();
  };
  revealAnchor();
  frames.push(ownerWindow.requestAnimationFrame(() => {
    revealAnchor();
    if (!destroyed) frames.push(ownerWindow.requestAnimationFrame(revealAnchor));
  }));
  if (options.initialFocus === "anchor") anchor.focus({ preventScroll: true });
  else (action ?? coachmark).focus({ preventScroll: true });
  activateEscapeScope();
  return Object.freeze({ element: coachmark, destroy });
}

function positionOnboardingCoachmark(
  coachmark: HTMLElement,
  spotlight: HTMLElement | null,
  anchor: HTMLElement,
  ownerWindow: Window,
  protectedSurface: HTMLElement | null,
  reservedSpace: HTMLElement | null
): void {
  const margin = 12;
  const viewportWidth = ownerWindow.innerWidth;
  const viewportHeight = ownerWindow.innerHeight;
  const width = Math.min(viewportWidth <= 650 ? viewportWidth - 24 : 348, viewportWidth - 24);
  const slot = reservedSpace?.getBoundingClientRect();
  coachmark.style.width = `${slot ? Math.max(0, Math.min(348, slot.width - 24, viewportWidth - 24)) : width}px`;
  const height = coachmark.getBoundingClientRect().height;
  if (reservedSpace) reservedSpace.style.height = `${height + 24}px`;
  if (!spotlight) {
    coachmark.setCssStyles({ left: `${Math.max(margin, (viewportWidth - width) / 2)}px`, top: `${Math.max(margin, (viewportHeight - height) / 2)}px` });
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const r = {
    left: Math.max(4, rect.left - 5), top: Math.max(4, rect.top - 5),
    right: Math.min(viewportWidth - 4, rect.right + 5), bottom: Math.min(viewportHeight - 4, rect.bottom + 5)
  };
  spotlight.setCssStyles({ left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(0, r.right - r.left)}px`, height: `${Math.max(0, r.bottom - r.top)}px` });
  if (reservedSpace && slot) {
    const left = slot.left + 12, top = slot.top + 12;
    let clipTop = 0, clipBottom = viewportHeight, clipLeft = 0, clipRight = viewportWidth;
    for (let parent = reservedSpace.parentElement; parent; parent = parent.parentElement) {
      const style = ownerWindow.getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) { clipTop = Math.max(clipTop, bounds.top); clipBottom = Math.min(clipBottom, bounds.bottom); }
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX}`)) { clipLeft = Math.max(clipLeft, bounds.left); clipRight = Math.min(clipRight, bounds.right); }
    }
    coachmark.setCssStyles({ left: `${left}px`, top: `${top}px`, clipPath: `inset(${Math.max(0, clipTop - top)}px ${Math.max(0, left + coachmark.getBoundingClientRect().width - clipRight)}px ${Math.max(0, top + height - clipBottom)}px ${Math.max(0, clipLeft - left)}px)` });
    coachmark.dataset.placement = "reserved";
    return;
  }
  if (protectedSurface) {
    const surface = protectedSurface.getBoundingClientRect();
    const right = surface.right + width + 26 <= viewportWidth;
    coachmark.setCssStyles({ left: `${right ? surface.right + 14 : surface.left - width - 14}px`, top: `${Math.max(margin, Math.min(r.top, viewportHeight - height - margin))}px` });
    coachmark.dataset.placement = right ? "right" : "left";
    return;
  }
  const candidates = [
    { x: r.right + 14, y: r.top, placement: "right" },
    { x: r.left - width - 14, y: r.top, placement: "left" },
    { x: r.left, y: r.bottom + 14, placement: "below" },
    { x: r.left, y: r.top - height - 14, placement: "above" }
  ].map(p => ({ ...p,
    x: Math.max(margin, Math.min(p.x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(p.y, viewportHeight - height - margin))
  }));
  const overlap = (p: { x: number; y: number }) => Math.max(0, Math.min(p.x + width, r.right) - Math.max(p.x, r.left))
    * Math.max(0, Math.min(p.y + height, r.bottom) - Math.max(p.y, r.top));
  const best = viewportWidth <= 650
    ? { x: margin, y: Math.max(margin, viewportHeight - height - margin), placement: "bottom-sheet" }
    : candidates.sort((a, b) => overlap(a) - overlap(b))[0];
  coachmark.setCssStyles({ left: `${best.x}px`, top: `${best.y}px` });
  coachmark.dataset.placement = best.placement;
}
