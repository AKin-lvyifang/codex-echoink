/** Node business fixtures use a minimal DOM. Real Origin/Radix behavior is covered
 * by origin-controls-dom in the browser; this shim is never bundled in the plugin. */
type Options = { cls?: string; text?: string; attr?: Record<string, unknown>; value?: string };
export function createOriginInput(parent: any, options: Options = {}) { return parent.createEl("input", options); }
export function createOriginButton(parent: any, options: Options = {}) { return parent.createEl("button", options); }
export function createOriginPagination(parent: any, _page: number, pages: number, onChange: (page: number) => void) {
  const nav = parent.createEl("nav");
  for (let page = 1; page <= pages; page++) {
    const button = nav.createEl("button", { text: String(page) });
    button.onclick = () => onChange(page);
  }
  return nav;
}
export function createOriginCheck(parent: any, options: Options = {}) { return parent.createEl("input", { ...options, attr: { ...options.attr, type: "checkbox" } }); }
export const createOriginSwitch = createOriginCheck;
export function disposeOriginControls(_container: unknown): void {}
export function createOriginSelect(parent: any, options: Options, choices: readonly { value: string; label: string; disabled?: boolean }[], value = "") {
  const element = parent.createEl("select", options);
  const addOption = (value: string, label: string) => element.createEl("option", { value, text: label });
  for (const choice of choices) addOption(choice.value, choice.label).disabled = Boolean(choice.disabled);
  element.value = value || choices[0]?.value || "";
  return { element, addOption, setOptionDisabled(value: string, disabled: boolean) { for (const item of element.options) if (item.value === value) item.disabled = disabled; } };
}
export function createOriginSlider(parent: any, options: { value: number; min: number; max: number; step: number; label: string; onValueChange(value: number): void; onValueCommit(value: number): void }) {
  const element = parent.createEl("input", { attr: { type: "range", min: String(options.min), max: String(options.max), step: String(options.step), "aria-label": options.label } });
  element.value = String(options.value);
  element.oninput = () => options.onValueChange(Number(element.value));
  element.onchange = () => { options.onValueChange(Number(element.value)); options.onValueCommit(Number(element.value)); };
  return element;
}
export function createOriginRadioGroup(parent: any, value: string, label: string, onChange: (value: string) => void) {
  const element = parent.createDiv({ attr: { role: "radiogroup", "aria-label": label } });
  return { element, addItem(parent: any, itemValue: string, disabled: boolean) {
    const radio = parent.createEl("input", { attr: { type: "radio" } });
    radio.checked = itemValue === value; radio.disabled = disabled;
    radio.onchange = () => { if (radio.checked) onChange(itemValue); };
    return radio;
  } };
}
