import { Setting, type App } from "obsidian";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginSelect, type OriginCheckElement, type OriginSelectElement } from "./origin-controls";

/** EchoInk-only adapters. Obsidian still owns the row; Origin owns its controls. */
export class OriginSetting extends Setting {
  addOriginToggle(callback: (control: OriginToggleControl) => unknown): this { callback(new OriginToggleControl(this.controlEl)); return this; }
  addOriginText(callback: (control: OriginTextControl) => unknown): this { callback(new OriginTextControl(this.controlEl)); return this; }
  addOriginDropdown(app: App, callback: (control: OriginDropdownControl) => unknown): this { callback(new OriginDropdownControl(this.controlEl, app)); return this; }
  addOriginButton(callback: (control: OriginButtonControl) => unknown): this { callback(new OriginButtonControl(this.controlEl)); return this; }
}

class OriginToggleControl {
  readonly toggleEl: OriginCheckElement;
  constructor(parent: HTMLElement) { this.toggleEl = createOriginCheck(parent, {}, "switch"); }
  getValue(): boolean { return this.toggleEl.checked; }
  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  setDisabled(value: boolean): this { this.toggleEl.disabled = value; return this; }
  onChange(callback: (value: boolean) => unknown): this { this.toggleEl.onchange = () => { callback(this.toggleEl.checked); }; return this; }
}

class OriginTextControl {
  readonly inputEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.inputEl = createOriginInput(parent); }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.oninput = () => { callback(this.inputEl.value); }; return this; }
}

class OriginDropdownControl {
  readonly selectEl: OriginSelectElement;
  private readonly select: ReturnType<typeof createOriginSelect>;
  constructor(parent: HTMLElement, app: App) { this.select = createOriginSelect(parent, {}, [], "", app); this.selectEl = this.select.element; }
  addOption(value: string, label: string, renderIcon?: (container: HTMLElement) => void): this { this.select.addOption(value, label, renderIcon); return this; }
  addOptions(options: Record<string, string>): this { for (const [value, label] of Object.entries(options)) this.select.addOption(value, label); return this; }
  setOptionDisabled(value: string, disabled: boolean): this { this.select.setOptionDisabled(value, disabled); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  setDisabled(value: boolean): this { this.selectEl.disabled = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.selectEl.onchange = () => { callback(this.selectEl.value); }; return this; }
}

class OriginButtonControl {
  readonly buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) { this.buttonEl = createOriginButton(parent); }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  setCta(): this { this.buttonEl.classList.add("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.classList.add("mod-warning"); return this; }
  setClass(value: string): this { this.buttonEl.classList.add(value); return this; }
  onClick(callback: (event: MouseEvent) => unknown): this { this.buttonEl.onclick = (event) => { callback(event); }; return this; }
}
