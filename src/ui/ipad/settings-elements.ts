import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import type { ApiProviderConfig } from "../../settings/settings";
import type { MobileModelConfiguration } from "../../mobile/model-configuration";
import type { IPadWorkbenchHost } from "./workbench-contract";
import type { IPadSettingsShell } from "./settings-shell";
import type { MobileShellPage } from "../mobile/shell-types";
import { ipadElement as el, ipadIcon } from "./workbench-elements";
import { settingsText as t } from "./settings-i18n";

export interface IPadSettingsContext {
  root: HTMLElement; document: Document; host: IPadWorkbenchHost; shell: IPadSettingsShell;
  models: MobileModelConfiguration; error(error: unknown): void; refresh(): void;
  push(page: MobileShellPage): Promise<boolean>; back(): Promise<boolean>;
}
export { el };
export function settingsContent(ctx: IPadSettingsContext): HTMLElement { return el(ctx.document, "div", "pd-settings-content"); }
export function settingsGroup(ctx: IPadSettingsContext, parent: HTMLElement, title: string): HTMLElement {
  parent.append(el(ctx.document, "h2", "pd-settings-label", title));
  const group = el(ctx.document, "div", "pd-settings-group"); parent.append(group); return group;
}
export function settingsBrand(ctx: Pick<IPadSettingsContext, "document">, provider: Pick<ApiProviderConfig, "providerId">): HTMLElement {
  const brand = el(ctx.document, "span", "pd-settings-brand");
  renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom"); return brand;
}
export function settingsRow(ctx: IPadSettingsContext, parent: HTMLElement, title: string, value = "", action?: () => void | Promise<unknown>, lead?: HTMLElement, description?: string): HTMLElement {
  const row = action ? el(ctx.document, "button", "pd-settings-row") : el(ctx.document, "div", "pd-settings-row");
  if (row instanceof ctx.document.defaultView!.HTMLButtonElement) {
    row.type = "button"; row.addEventListener("click", () => { void Promise.resolve().then(action).catch(ctx.error); });
  }
  if (lead) row.append(lead);
  const copy = el(ctx.document, "span", "pd-settings-copy"); copy.append(el(ctx.document, "span", "pd-settings-name", title));
  if (description) copy.append(el(ctx.document, "span", "pd-settings-description", description)); row.append(copy);
  if (value) row.append(el(ctx.document, "span", "pd-settings-value", value));
  if (action) row.append(ipadIcon(ctx.document, "chevron-right")); parent.append(row); return row;
}
export function settingsAction(ctx: IPadSettingsContext, label: string, action: () => void | Promise<unknown>, primary = false): HTMLButtonElement {
  const button = el(ctx.document, "button", `pd-settings-action${primary ? " is-primary" : ""}`); button.type = "button";
  button.append(el(ctx.document, "span", "pd-settings-action-visible", t(ctx, label)));
  button.addEventListener("click", () => { if (!button.disabled) void Promise.resolve().then(action).catch(ctx.error); }); return button;
}
export function settingsField(ctx: IPadSettingsContext, parent: HTMLElement, name: string, value: string, change: (value: string) => void, type = "text"): HTMLInputElement {
  const field = el(ctx.document, "label", "pd-settings-field"), input = el(ctx.document, "input", "pd-settings-input");
  input.type = type; input.value = value; input.setAttribute("aria-label", name);
  input.addEventListener("input", () => change(input.value)); field.append(el(ctx.document, "span", "pd-settings-field-label", name), input); parent.append(field); return input;
}
export function settingsToggle(ctx: IPadSettingsContext, title: string, checked: boolean, change: (checked: boolean) => void | Promise<unknown>): HTMLInputElement {
  const input = el(ctx.document, "input", "pd-settings-switch"); input.type = "checkbox"; input.checked = checked;
  input.setAttribute("role", "switch"); input.setAttribute("aria-label", title);
  let persisted = checked;
  input.addEventListener("change", () => { if (input.disabled) return; const previous = persisted, requested = input.checked; input.disabled = true;
    void Promise.resolve().then(() => change(requested)).then(() => { persisted = requested; }).catch(error => { input.checked = previous; ctx.error(error); }).finally(() => { input.disabled = false; }); }); return input;
}
export function settingsSwitch(ctx: IPadSettingsContext, parent: HTMLElement, title: string, checked: boolean, change: (checked: boolean) => void | Promise<unknown>): HTMLInputElement {
  const row = el(ctx.document, "label", "pd-settings-row"), input = settingsToggle(ctx, title, checked, change);
  row.append(el(ctx.document, "span", "pd-settings-copy", title), input); parent.append(row); return input;
}
export function settingsError(ctx: IPadSettingsContext): HTMLElement { const error = el(ctx.document, "div", "pd-settings-error"); error.hidden = true; error.setAttribute("role", "alert"); return error; }
export function showSettingsError(node: HTMLElement, error: unknown): void { node.textContent = error instanceof Error ? error.message : String(error); node.hidden = false; }
export function liveSettingsPage(ctx: IPadSettingsContext, page: MobileShellPage, render: () => void): MobileShellPage {
  const originalTitle = page.title;
  const refresh = () => { page.title = t(ctx, originalTitle); render();
    const panel = page.content.closest(".echoink-ipad-page"), heading = panel?.querySelector(".echoink-ipad-title"); if (heading) heading.textContent = page.title;
  };
  refresh(); ctx.root.addEventListener("pd-settings-refresh", refresh); const dispose = page.dispose;
  page.dispose = () => { ctx.root.removeEventListener("pd-settings-refresh", refresh); dispose?.(); }; return page;
}
export function leaveSettingsConfirm(ctx: IPadSettingsContext, area: HTMLElement): Promise<boolean> {
  return new Promise(resolve => {
    const box = el(ctx.document, "section", "pd-settings-confirm", t(ctx, "还有未保存的修改。")), actions = el(ctx.document, "div", "pd-settings-actions");
    const done = (allowed: boolean) => { area.replaceChildren(); resolve(allowed); };
    const keep = settingsAction(ctx, "继续编辑", () => done(false));
    actions.append(keep, settingsAction(ctx, "放弃修改", () => done(true), true)); box.append(actions); area.replaceChildren(box); keep.focus();
  });
}
