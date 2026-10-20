import type { ApiProviderId } from "../../settings/provider-presets";
import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneButton, iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { settingsMessage, settingsText } from "./settings-language";

export function settingsBody(ctx: IPhonePageContext): HTMLElement { return el(ctx.document, "div", "ip-settings"); }
export function settingsGroup(ctx: IPhonePageContext, body: HTMLElement, title?: string, literal = false): HTMLElement {
  if (title) { const heading = el(ctx.document, "h2", "ip-settings-heading", title); if (!literal) settingsMessage(ctx, heading, title); body.append(heading); }
  const group = el(ctx.document, "section", "ip-settings-group"); body.append(group); return group;
}
export function settingsBrand(ctx: IPhonePageContext, id?: ApiProviderId): HTMLElement {
  const brand = el(ctx.document, "span", "ip-settings-brand"); brand.setAttribute("aria-hidden", "true");
  renderProviderBrandIcon(brand, id === "openai" ? "openai-codex" : id ?? "custom"); return brand;
}
export function settingsRow(ctx: IPhonePageContext, parent: HTMLElement, name: string, options: {
  value?: string; detail?: string; icon?: string; leading?: HTMLElement; valueLeading?: HTMLElement; action?: () => void | Promise<void>; selected?: boolean; literal?: boolean; literalValue?: boolean; literalDetail?: boolean; navigation?: boolean;
} = {}): HTMLElement {
  const row = options.action ? el(ctx.document, "button", "ip-settings-row") : el(ctx.document, "div", "ip-settings-row");
  if (options.action) (row as HTMLButtonElement).type = "button";
  if (options.leading) row.append(options.leading); else if (options.icon) row.append(iphoneIcon(ctx.document, options.icon));
  const label = el(ctx.document, "span", "ip-settings-label"), text = el(ctx.document, "span", "ip-settings-name", name); if (!options.literal) settingsMessage(ctx, text, name); label.append(text);
  if (options.detail) label.append(el(ctx.document, "span", "ip-settings-detail", options.literalDetail ? options.detail : settingsText(ctx, options.detail))); row.append(label);
  if (options.value) {
    const value = el(ctx.document, "span", "ip-settings-value"), text = el(ctx.document, "span", "", options.value);
    if (!options.literalValue) settingsMessage(ctx, text, options.value); if (options.valueLeading) value.append(options.valueLeading); value.append(text); row.append(value);
  }
  if (options.selected !== undefined) {
    row.classList.toggle("is-selected", options.selected); row.setAttribute("aria-pressed", String(options.selected));
    if (options.selected) row.append(iphoneIcon(ctx.document, "check"));
  } else if (options.action && options.navigation !== false) row.append(iphoneIcon(ctx.document, "chevron-right"));
  if (options.action) row.addEventListener("click", () => {
    if (row.matches(":disabled")) return;
    void Promise.resolve().then(options.action).catch(ctx.error);
  });
  parent.append(row); return row;
}
export function settingsError(ctx: IPhonePageContext, parent: HTMLElement): { element: HTMLElement; show: (failure?: unknown) => void } {
  const element = el(ctx.document, "div", "ip-settings-error"); element.hidden = true; element.setAttribute("role", "alert"); parent.append(element);
  return { element, show: failure => { element.textContent = failure === undefined ? "" : failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "操作失败，请重试。"; element.hidden = failure === undefined; } };
}
export function settingsField(ctx: IPhonePageContext, parent: HTMLElement, name: string, value: string, change: (value: string) => void, type = "text"): HTMLInputElement {
  const label = el(ctx.document, "label", "ip-settings-field"), input = el(ctx.document, "input", "ip-settings-input");
  label.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-field-label"), name)); input.type = type; input.value = value; input.setAttribute("aria-label", settingsText(ctx, name));
  input.addEventListener("input", () => change(input.value)); label.append(input); parent.append(label); return input;
}
export function settingsCheck(ctx: IPhonePageContext, parent: HTMLElement, name: string, checked: boolean, change: (checked: boolean) => void, leading?: HTMLElement, literal = false): HTMLInputElement {
  const label = el(ctx.document, "label", "ip-settings-row ip-settings-choice"), input = el(ctx.document, "input", "ip-settings-check"); input.type = "checkbox"; input.checked = checked;
  const text = el(ctx.document, "span", "ip-settings-label", name); if (!literal) settingsMessage(ctx, text, name);
  if (leading) label.append(leading); label.append(text, input);
  input.addEventListener("change", () => change(input.checked)); parent.append(label); return input;
}
export function settingsSwitch(ctx: IPhonePageContext, parent: HTMLElement, name: string, read: () => boolean, write: (value: boolean) => Promise<void>, icon?: string, existingRow?: HTMLElement): HTMLInputElement {
  const row = existingRow ?? el(ctx.document, "label", "ip-settings-row"), input = el(ctx.document, "input", "ip-settings-switch"); input.type = "checkbox"; input.setAttribute("role", "switch"); input.setAttribute("aria-label", settingsText(ctx, name));
  if (existingRow) input.setAttribute("aria-label", ctx.host.settings().settingsLanguage === "en" ? `Enable ${settingsText(ctx, name)}` : `启用${name}`);
  if (!existingRow) { if (icon) row.append(iphoneIcon(ctx.document, icon)); row.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-label"), name)); parent.append(row); row.append(input); }
  else { const hit = el(ctx.document, "label", "ip-settings-switch-hit"); hit.append(input); row.append(hit); }
  const error = settingsError(ctx, parent); let busy = false;
  const sync = () => { input.checked = read(); input.setAttribute("aria-checked", String(input.checked)); input.disabled = busy; };
  input.addEventListener("change", () => {
    if (busy) { sync(); return; } const value = input.checked; busy = true; input.disabled = true; input.setAttribute("aria-checked", String(value)); input.setAttribute("aria-busy", "true"); error.show();
    void Promise.resolve().then(() => write(value)).catch(error.show).finally(() => { busy = false; input.removeAttribute("aria-busy"); sync(); });
  }); input.addEventListener("click", event => event.stopPropagation()); sync(); return input;
}
export async function pushSettingsPage(ctx: IPhonePageContext, page: MobileShellPage): Promise<void> {
  page.title = settingsText(ctx, page.title);
  if (ctx.shell.hasPage(page.id)) { page.dispose?.(); await ctx.shell.backTo(page.id); return; }
  if (!await ctx.shell.push(page)) page.dispose?.();
}
export function settingsButton(ctx: IPhonePageContext, label: string, action: () => void, variant = ""): HTMLButtonElement {
  const button = iphoneButton(ctx.document, settingsText(ctx, label), action, variant);
  settingsMessage(ctx, button.querySelector<HTMLElement>(".ip-button-visible > span:last-child")!, label); return button;
}
