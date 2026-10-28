import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { Platform, Setting, setIcon } from "obsidian";
import { attachNativeTooltip, type NativeTooltipHandle } from "../ui/native-tooltip";
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

const settingsTooltips = new WeakMap<HTMLElement, NativeTooltipHandle>();

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

/** Pure help is a native tooltip on desktop and a persistent native Notice on touch. */
export function attachSettingsHelpTooltip(
  trigger: HTMLElement,
  explanation: string,
  _wrapper = trigger,
  _options: { readonly interactive?: boolean } = {}
): void {
  settingsTooltips.set(trigger, attachNativeTooltip(trigger, explanation, { preserveLabel: false, touch: "notice" }));
}

/** Compatibility entry for complete settings values; business clicks remain untouched. */
export function attachSettingsTooltip(
  trigger: HTMLElement,
  explanation: string,
  _wrapper = trigger,
  options: { readonly interactive?: boolean; readonly describeTrigger?: boolean; readonly shouldShow?: () => boolean } = {}
): void {
  settingsTooltips.set(trigger, attachNativeTooltip(trigger, explanation, { shouldShow: options.shouldShow }));
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
      shouldShow: () => {
        const help = row.querySelector<HTMLElement>(".echoink-settings-navigation-help");
        return !(help && (help.matches(":hover") || help === row.ownerDocument.activeElement))
          && (fullValue !== visibleValue || value.scrollWidth > value.clientWidth);
      }
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
    help.onclick = event => { event.preventDefault(); event.stopPropagation(); };
    const hideSummary = () => settingsTooltips.get(row)?.hide();
    help.addEventListener("mouseenter", hideSummary);
    help.addEventListener("focus", hideSummary);
    help.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault(); event.stopPropagation(); help.click();
    });
  }
  applyAmicroButton(row, { variant: "tertiary", motion: "slide" });
  // Reading a tooltip never changes navigation activation.
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
