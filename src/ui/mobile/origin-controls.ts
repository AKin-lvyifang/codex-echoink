import type { App } from "obsidian";

/** Native controls for the mobile build of Home dialogs. Desktop keeps React. */
const cleanups = new Map<HTMLElement, () => void>();
type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string | number | boolean> };
type OriginSelectOption = { value: string; label: string; disabled?: boolean };
export function createOriginSelect(parent: HTMLElement, options: ElementOptions,
  choices: readonly OriginSelectOption[], initialValue = "", _app?: Pick<App, "keymap" | "scope">) {
  const element = parent.ownerDocument.createElement("select");
  element.className = `echoink-origin-control ${options.cls ?? ""}`;
  element.dataset.slot = "select-trigger";
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  const appendOption = (value: string, label: string, disabled = false) => {
    const option = parent.ownerDocument.createElement("option");
    option.value = value; option.textContent = label; option.disabled = disabled;
    element.append(option);
  };
  for (const choice of choices) appendOption(choice.value, choice.label, choice.disabled);
  element.value = initialValue || choices[0]?.value || "";
  parent.append(element);
  return { element, addOption(value: string, label: string) {
    const selectNew = !element.value;
    appendOption(value, label);
    if (selectNew) element.value = value;
  } };
}
export type OriginCheckElement = HTMLButtonElement & { checked: boolean; indeterminate: boolean };
export function createOriginCheck(parent: HTMLElement, options: ElementOptions = {}, kind: "switch" | "checkbox" = "checkbox"): OriginCheckElement {
  const button = createOriginButton(parent, options) as OriginCheckElement;
  button.dataset.slot = kind; button.setAttribute("role", kind);
  const thumb = kind === "switch" ? button.appendChild(parent.ownerDocument.createElement("span")) : undefined;
  if (thumb) thumb.dataset.slot = "switch-thumb";
  let checked = false, indeterminate = false;
  const render = () => { button.setAttribute("aria-checked", indeterminate ? "mixed" : String(checked)); button.dataset.state = indeterminate ? "indeterminate" : checked ? "checked" : "unchecked"; if (thumb) thumb.dataset.state = button.dataset.state; else button.textContent = indeterminate ? "−" : checked ? "✓" : ""; };
  Object.defineProperty(button, "checked", { get: () => checked, set: (value: boolean) => { checked = Boolean(value); render(); } });
  Object.defineProperty(button, "indeterminate", { get: () => indeterminate, set: (value: boolean) => { indeterminate = kind === "checkbox" && Boolean(value); render(); } });
  button.addEventListener("click", () => { checked = !checked; indeterminate = false; render(); button.dispatchEvent(new parent.ownerDocument.defaultView!.Event("change", { bubbles: true })); });
  render(); return button;
}
export function createOriginSwitch(parent: HTMLElement, options: ElementOptions = {}) { return createOriginCheck(parent, options, "switch"); }
export function createOriginPagination(parent: HTMLElement, page: number, pages: number, onChange: (page: number) => void): HTMLElement {
  const nav = parent.ownerDocument.createElement("nav"); nav.className = "echoink-origin-pagination"; nav.dataset.slot = "pagination"; nav.setAttribute("aria-label", "分页"); parent.append(nav);
  const list = parent.ownerDocument.createElement("ul"); list.dataset.slot = "pagination-content"; nav.append(list);
  const start = Math.max(2, Math.min(page - 1, pages - 3)), end = Math.min(pages - 1, start + 2);
  const items: (number | string)[] = pages <= 7 ? Array.from({ length: pages }, (_, i) => i + 1) : [1, ...(start > 2 ? start === 3 ? [2] : ["…"] : []), ...Array.from({ length: end - start + 1 }, (_, i) => start + i), ...(end < pages - 1 ? end === pages - 2 ? [pages - 1] : ["…"] : []), pages];
  const add = (label: string, target: number, disabled = false) => { const item = list.appendChild(parent.ownerDocument.createElement("li")); item.dataset.slot = "pagination-item"; const button = createOriginButton(item, { text: label, attr: { "aria-label": label === "‹" ? "上一页" : label === "›" ? "下一页" : `第 ${target} 页` } }); button.dataset.slot = "pagination-link"; button.disabled = disabled; if (target === page && label !== "‹" && label !== "›") button.setAttribute("aria-current", "page"); button.onclick = () => onChange(target); };
  add("‹", page - 1, page <= 1);
  for (const item of items) if (typeof item === "number") add(String(item), item); else { const span = list.appendChild(parent.ownerDocument.createElement("li")).appendChild(parent.ownerDocument.createElement("span")); span.textContent = item; span.dataset.slot = "pagination-ellipsis"; span.setAttribute("aria-hidden", "true"); }
  add("›", page + 1, page >= pages); return nav;
}
export function createOriginInput(parent: HTMLElement, options: { cls?: string; attr?: Record<string, string | number | boolean>; value?: string; type?: string } = {}): HTMLInputElement {
  const input = parent.ownerDocument.createElement("input");
  input.className = `echoink-origin-control ${options.cls ?? ""}`;
  input.type = String(options.attr?.type ?? options.type ?? "text");
  for (const [key, value] of Object.entries(options.attr ?? {})) input.setAttribute(key, String(value));
  input.dataset.slot = "input"; input.value = options.value ?? "";
  parent.append(input); return input;
}
export function createOriginButton(parent: HTMLElement, options: ElementOptions = {}, onDispose?: () => void): HTMLButtonElement {
  const button = parent.ownerDocument.createElement("button");
  button.type = "button";
  button.dataset.slot = "button";
  button.className = `echoink-origin-control ${options.cls ?? "echoink-origin-button"}`;
  button.textContent = options.text ?? "";
  for (const [key, value] of Object.entries(options.attr ?? {})) button.setAttribute(key, String(value));
  parent.append(button);
  if (onDispose) cleanups.set(button, onDispose);
  return button;
}
export function disposeOriginControls(container: HTMLElement): void {
  for (const [button, cleanup] of cleanups) if (container.contains(button)) { cleanup(); cleanups.delete(button); }
}
