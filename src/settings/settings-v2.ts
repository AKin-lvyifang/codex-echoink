import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { Platform, Setting, displayTooltip, setIcon, setTooltip } from "obsidian";
import { applyAmicroButton, applyDeleteButton } from "./amicro-buttons";

export type SettingsStateTone = "neutral" | "error" | "success";

export interface SettingsPageOptions {
  readonly title: string;
  readonly headingId?: string;
  readonly description?: string;
  readonly detail?: boolean;
  readonly onBack?: () => void;
  readonly backLabel?: string;
  /** Keep a top-level heading available to assistive technology without duplicating the tab label. */
  readonly titleVisibility?: "visible" | "screen-reader";
}

export interface SettingsSectionOptions {
  readonly title?: string;
  readonly description?: string;
  readonly surface?: "flat" | "group";
}

export interface SettingsNavigationRowOptions {
  readonly title: string;
  readonly description?: string;
  readonly value?: string;
  /** A fixed suffix, such as a total count, kept beside the visual value. */
  readonly valueSuffix?: string;
  /** The complete value when the visual summary omits other items. */
  readonly valueDescription?: string;
  readonly explanation?: string;
  readonly actionLabel?: string;
  readonly showChevron?: boolean;
  readonly focusKey?: string;
  readonly onActivate: () => void;
}

export function createSettingsPage(
  container: HTMLElement,
  options: SettingsPageOptions
): HTMLElement {
  const page = container.createDiv({
    cls: `echoink-settings-page${options.detail ? " is-detail" : ""}`
  });
  if (options.onBack) {
    const back = createOriginButton(page, {
      cls: "echoink-settings-back settings-back text-button",
      attr: {
        type: "button",
        "aria-label": options.backLabel ?? "Back",
        "data-echoink-focus-key": "settings-detail:back"
      }
    });
    setIcon(back.createSpan(), "chevron-left");
    back.createSpan({ text: options.backLabel ?? "Back" });
    applyAmicroButton(back, { variant: "tertiary" });
    back.onclick = options.onBack;
  }
  const header = page.createDiv({ cls: "echoink-settings-page-header page-intro" });
  if (options.titleVisibility === "screen-reader") header.addClass("is-title-hidden");
  const heading = header.createDiv({ cls: "echoink-settings-page-heading" });
  heading.createEl("h2", {
    text: options.title,
    attr: options.headingId ? { id: options.headingId } : undefined
  });
  if (options.description) {
    heading.createDiv({
      cls: "echoink-settings-page-description",
      text: options.description
    });
  }
  return page;
}

export function createSettingsSection(
  page: HTMLElement,
  options: SettingsSectionOptions = {}
): HTMLElement {
  const section = page.createEl("section", {
    cls: `echoink-settings-section is-${options.surface ?? "flat"}${options.surface === "group" ? " settings-card" : ""}`
  });
  if (options.title || options.description) {
    const header = section.createDiv({ cls: "echoink-settings-section-header settings-card-header" });
    if (options.title) header.createEl("h3", { text: options.title });
    if (options.description) {
      header.createDiv({
        cls: "echoink-settings-section-description",
        text: options.description
      });
    }
  }
  return section;
}

export function createSettingsGroup(section: HTMLElement): HTMLElement {
  return section.createDiv({ cls: "echoink-settings-group settings-stack" });
}

export function applySettingsRow(setting: Setting): Setting {
  const settingEl = (setting as unknown as { settingEl?: HTMLElement }).settingEl;
  settingEl?.addClass("echoink-settings-row", "setting-row");
  setting.infoEl?.addClass("setting-copy");
  setting.controlEl?.addClass("setting-controls");
  return setting;
}

let settingsHelpSequence = 0;

export function addSettingsHelp(setting: Setting, summary: string, explanation: string): void {
  setting.setDesc(summary);
  const name = setting.nameEl.textContent ?? "";
  const helpLabel = /[\u4e00-\u9fff]/u.test(name) ? `${name}说明` : `${name} information`;
  const wrapper = setting.nameEl.createSpan({ cls: "echoink-settings-help" });
  const button = wrapper.createEl("button", {
    cls: "echoink-settings-help-trigger", text: "?",
    attr: { type: "button", "aria-label": helpLabel }
  });
  attachSettingsHelpTooltip(button, explanation, wrapper);
}

/** Setting explanations use the host tooltip on desktop and remain tappable on mobile. */
export function attachSettingsHelpTooltip(
  trigger: HTMLElement,
  explanation: string,
  wrapper = trigger,
  options: { readonly interactive?: boolean } = {}
): void {
  if (!Platform.isDesktopApp || trigger.ownerDocument.body.classList.contains("is-mobile")) {
    attachSettingsTooltip(trigger, explanation, wrapper, options);
    return;
  }
  const marker = `echoink-settings-native-help-${++settingsHelpSequence}`;
  const tooltipOptions = { placement: "top" as const, classes: [marker] };
  const document = trigger.ownerDocument, view = document.defaultView;
  let focused = false, hovered = false, active = false;
  let detachObserver: MutationObserver | undefined;
  let nativeRefresh: number | undefined;
  const cancelNativeRefresh = () => { if (nativeRefresh !== undefined) view?.clearTimeout(nativeRefresh); nativeRefresh = undefined; };
  const hide = () => {
    cancelNativeRefresh();
    // The host exposes displayTooltip but no hide API. Only remove this help's native node.
    document.querySelectorAll(`.tooltip.${marker}`).forEach(tooltip => tooltip.remove());
    if (!active) return;
    active = false;
    view?.removeEventListener("scroll", dismiss, true);
    view?.removeEventListener("resize", dismiss);
    view?.removeEventListener("keydown", onEscape, true);
    detachObserver?.disconnect(); detachObserver = undefined;
  };
  const dismiss = () => { focused = false; hovered = false; hide(); };
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    dismiss(); event.preventDefault(); event.stopPropagation();
  };
  const watch = () => {
    if (active || !trigger.isConnected) return;
    active = true;
    view?.addEventListener("scroll", dismiss, true);
    view?.addEventListener("resize", dismiss);
    view?.addEventListener("keydown", onEscape, true);
    if (view?.MutationObserver) {
      detachObserver = new view.MutationObserver(() => { if (!trigger.isConnected) dismiss(); });
      detachObserver.observe(document.body, { childList: true, subtree: true });
    }
  };
  const scheduleNativeTooltip = () => {
    cancelNativeRefresh();
    nativeRefresh = view?.setTimeout(() => {
      nativeRefresh = undefined;
      if (active && (focused || hovered) && trigger.isConnected) displayTooltip(trigger, explanation, tooltipOptions);
    }, 0);
  };
  setTooltip(trigger, explanation, tooltipOptions);
  trigger.addEventListener("mouseenter", () => {
    hovered = true; watch();
    // Replace the host's delayed hover show so dismissal cannot leave a pending native tooltip.
    scheduleNativeTooltip();
  });
  trigger.addEventListener("mouseleave", () => {
    hovered = false;
    if (!focused) { hide(); return; }
    // Refresh after pointerout so the host cancels its pending hover hide.
    scheduleNativeTooltip();
  });
  trigger.addEventListener("focus", () => {
    focused = true; watch();
    displayTooltip(trigger, explanation, tooltipOptions);
  });
  trigger.addEventListener("blur", () => { focused = false; if (!hovered) hide(); });
}

export function attachSettingsTooltip(
  trigger: HTMLElement,
  explanation: string,
  wrapper = trigger,
  options: { readonly interactive?: boolean; readonly describeTrigger?: boolean; readonly shouldShow?: () => boolean } = {}
): void {
  const interactive = options.interactive ?? true;
  const id = `echoink-settings-help-${++settingsHelpSequence}`;
  if (options.describeTrigger !== false) trigger.setAttr("aria-describedby", id);
  const panel = wrapper.createDiv({ cls: "echoink-settings-help-panel", text: explanation, attr: { id, role: "tooltip" } });
  panel.hidden = true;
  // Short directory labels must not intercept the next row during a pointer sweep.
  // Long help panels keep their hover grace period so their content can be scrolled.
  if (!interactive) panel.addClass("is-noninteractive");
  const view = wrapper.ownerDocument.defaultView;
  let hideTimer: number | undefined;
  let detachObserver: MutationObserver | undefined;
  const cancelHide = () => { if (hideTimer !== undefined) view?.clearTimeout(hideTimer); hideTimer = undefined; };
  const hide = () => {
    cancelHide(); panel.hidden = true; panel.remove();
    view?.removeEventListener("scroll", hideOnScroll, true);
    view?.removeEventListener("resize", hide);
    detachObserver?.disconnect(); detachObserver = undefined;
  };
  const hideOnScroll = (event: Event) => { if (!panel.contains(event.target as Node)) hide(); };
  const show = () => {
    if (options.shouldShow && !options.shouldShow()) { hide(); return; }
    // Obsidian setting names and legacy groups can clip their descendants.
    // Keep the themed tooltip in the settings surface, outside those rows.
    const surface = wrapper.closest<HTMLElement>(".echoink-settings-demo") ?? wrapper;
    surface.appendChild(panel);
    cancelHide(); panel.hidden = false;
    panel.style.removeProperty("max-height");
    panel.style.removeProperty("left"); panel.style.removeProperty("top");
    const anchor = wrapper.getBoundingClientRect();
    const root = surface.getBoundingClientRect();
    const viewport = view?.visualViewport;
    const header = wrapper.closest(".echoink-settings-demo")?.querySelector(".codex-settings-tabs-slot")?.getBoundingClientRect();
    const top = Math.max((viewport?.offsetTop ?? 0) + 8, (root?.top ?? 0) + 8, (header?.bottom ?? 0) + 8);
    const bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? view?.innerHeight ?? 700) - 8, (root?.bottom ?? Infinity) - 8);
    const left = Math.max(8, (root?.left ?? 0) + 8);
    const right = Math.min((view?.innerWidth ?? 1000) - 8, (root?.right ?? Infinity) - 8);
    panel.style.width = `${Math.max(0, Math.min(300, right - left))}px`;
    const bounds = panel.getBoundingClientRect();
    const below = Math.max(0, bottom - anchor.bottom - 9);
    const above = Math.max(0, anchor.top - top - 9);
    const upwards = bounds.height > below && above > below;
    const height = Math.min(bounds.height, upwards ? above : below);
    panel.style.maxHeight = `${upwards ? above : below}px`;
    panel.style.left = `${Math.max(left, Math.min(anchor.left - 14, right - bounds.width)) - root.left}px`;
    panel.style.top = `${(upwards ? anchor.top - height - 9 : anchor.bottom + 9) - root.top}px`;
    view?.addEventListener("scroll", hideOnScroll, true);
    view?.addEventListener("resize", hide);
    if (!detachObserver && view?.MutationObserver) {
      detachObserver = new view.MutationObserver(() => { if (!wrapper.isConnected) hide(); });
      detachObserver.observe(wrapper.ownerDocument.documentElement, { childList: true, subtree: true });
    }
  };
  wrapper.onmouseenter = show;
  const scheduleHide = () => { cancelHide(); hideTimer = view?.setTimeout(hide, 120); };
  wrapper.onmouseleave = interactive ? scheduleHide : hide;
  panel.onmouseenter = interactive ? cancelHide : null;
  panel.onmouseleave = interactive ? scheduleHide : null;
  trigger.onfocus = show;
  trigger.onblur = hide;
  trigger.onclick = show;
  wrapper.onkeydown = (event) => {
    if (event.key !== "Escape") return;
    hide(); event.preventDefault(); event.stopPropagation();
  };
}

const inlineConfirmations = new WeakMap<HTMLElement, () => void>();

export function showSettingsInlineConfirmation(container: HTMLElement, trigger: HTMLButtonElement, options: {
  message: string; confirmLabel: string; cancelLabel: string; onConfirm: () => Promise<void>; deleteAction?: boolean; danger?: boolean;
}): void {
  const root = container.closest<HTMLElement>(".echoink-settings-demo") ?? container;
  inlineConfirmations.get(root)?.();
  const panel = container.createDiv({ cls: "echoink-settings-inline-confirm review-confirm", attr: { role: "group", "aria-label": options.confirmLabel } });
  panel.createEl("p", { text: options.message });
  const actions = panel.createDiv({ cls: "settings-inline" });
  const cancel = createOriginButton(actions, { cls: "button", text: options.cancelLabel, attr: { type: "button" } });
  const confirm = createOriginButton(actions, { cls: options.danger === false ? "button" : "button settings-danger", text: options.confirmLabel, attr: { type: "button" } });
  if (options.deleteAction) applyDeleteButton(confirm);
  const close = () => { disposeOriginControls(panel); panel.remove(); if (inlineConfirmations.get(root) === close) inlineConfirmations.delete(root); trigger.setAttr("aria-expanded", "false"); };
  inlineConfirmations.set(root, close);
  trigger.setAttr("aria-expanded", "true");
  cancel.onclick = () => { close(); trigger.focus({ preventScroll: true }); };
  panel.onkeydown = (event) => {
    if (event.key !== "Escape" || confirm.disabled) return;
    event.preventDefault(); event.stopPropagation(); cancel.click();
  };
  confirm.onclick = () => {
    if (confirm.disabled || !panel.isConnected) return;
    confirm.disabled = true; cancel.disabled = true; trigger.disabled = true;
    void options.onConfirm().finally(() => { close(); trigger.disabled = false; if (trigger.isConnected) trigger.focus({ preventScroll: true }); });
  };
  cancel.focus({ preventScroll: true });
}

export function createSettingsFeatureCard(
  section: HTMLElement,
  title: string,
  description?: string
): HTMLElement {
  const card = section.createDiv({ cls: "echoink-settings-feature-card settings-card" });
  const copy = card.createDiv({ cls: "echoink-settings-feature-copy" });
  copy.createDiv({ cls: "echoink-settings-feature-title", text: title });
  if (description) {
    copy.createDiv({ cls: "echoink-settings-feature-description", text: description });
  }
  return card;
}

export function createSettingsNavigationRow(
  section: HTMLElement,
  options: SettingsNavigationRowOptions
): HTMLButtonElement {
  const desktopSummary = Platform.isDesktopApp && !section.ownerDocument.body.classList.contains("is-mobile") && Boolean(options.value);
  const visibleValue = [options.value, options.valueSuffix].filter(Boolean).join(" ");
  const fullValue = options.valueDescription ?? visibleValue;
  const row = createOriginButton(section, {
    cls: `echoink-settings-navigation-row setting-row${desktopSummary ? " has-value-summary" : ""}`,
    attr: {
      type: "button",
      "aria-label": `${options.title}，${desktopSummary && fullValue ? `${fullValue}，` : ""}${options.actionLabel || "进入"}`,
      "data-echoink-focus-key": options.focusKey ?? `navigation:${options.title}`
    }
  });
  const copy = row.createDiv({ cls: "echoink-settings-navigation-copy setting-copy" });
  const title = copy.createDiv({ cls: "echoink-settings-navigation-title", text: options.title });
  if (options.description) {
    copy.createDiv({
      cls: "echoink-settings-navigation-description",
      text: options.description
    });
  }
  const trailing = row.createDiv({ cls: "echoink-settings-navigation-trailing setting-controls" });
  if (options.value) {
    const value = trailing.createSpan({ cls: "echoink-settings-navigation-value", text: options.value });
    if (options.valueSuffix) trailing.createSpan({ cls: "echoink-settings-navigation-value-suffix", text: options.valueSuffix });
    if (desktopSummary) attachSettingsTooltip(row, fullValue, row, {
      interactive: false,
      describeTrigger: false,
      // An existing purpose/help tooltip takes precedence over the summary.
      shouldShow: () => !row.hasAttribute("aria-describedby") && (fullValue !== visibleValue || value.scrollWidth > value.clientWidth)
    });
  }
  if (options.actionLabel) trailing.createSpan({ cls: "echoink-settings-navigation-action", text: options.actionLabel });
  if (options.showChevron !== false) {
    const icon = trailing.createSpan({ cls: "echoink-settings-navigation-icon" });
    setIcon(icon, "chevron-right");
  }
  if (options.explanation) {
    const help = title.createSpan({ cls: "echoink-settings-navigation-help echoink-settings-help", attr: { role: "button", tabindex: "0", "aria-label": `${options.title}说明` } });
    setIcon(help, "circle-alert");
    attachSettingsHelpTooltip(help, options.explanation, help, { interactive: false });
    const show = help.onclick, hideSummary = row.onmouseleave;
    help.onclick = event => { event.preventDefault(); event.stopPropagation(); show?.call(help, event); };
    help.addEventListener("mouseenter", event => { hideSummary?.call(row, event); });
    help.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); event.stopPropagation(); help.click();
    });
  }
  applyAmicroButton(row, { variant: "tertiary", motion: "slide" });
  // Tooltip setup owns its click handler; navigation must remain authoritative.
  row.onclick = options.onActivate;
  return row;
}

export function createSettingsCompactList(section: HTMLElement): HTMLElement {
  return section.createDiv({ cls: "echoink-settings-compact-list" });
}

/** Rebuild an asynchronously changed row so its value, tooltip and accessible name agree. */
export function replaceSettingsNavigationRow(row: HTMLButtonElement, options: SettingsNavigationRowOptions): HTMLButtonElement {
  const parent = row.parentElement;
  if (!parent || !row.isConnected) return row;
  const focused = row.ownerDocument.activeElement === row;
  const next = createSettingsNavigationRow(parent, options);
  parent.insertBefore(next, row);
  // Origin portals must unmount while their button is still in the owning parent.
  disposeOriginControls(row); row.remove();
  if (focused) next.focus({ preventScroll: true });
  return next;
}

export function createSettingsState(
  container: HTMLElement,
  message: string,
  tone: SettingsStateTone = "neutral",
  action?: { label: string; onActivate: () => void }
): HTMLElement {
  const state = container.createDiv({
    cls: `echoink-settings-state is-${tone}`,
    attr: tone === "error"
      ? { role: "alert" }
      : { role: "status", "aria-live": "polite" }
  });
  state.createDiv({ cls: "echoink-settings-state-message", text: message });
  if (action) {
    const button = createOriginButton(state, {
      cls: "echoink-settings-state-action",
      text: action.label,
      attr: { type: "button" }
    });
    applyAmicroButton(button, { variant: "secondary" });
    button.onclick = action.onActivate;
  }
  return state;
}
