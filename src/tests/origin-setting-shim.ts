/** Preserve existing Node business fixtures; browser tests use the real adapter. */
import { Setting } from "obsidian";
export class OriginSetting extends Setting {
  addOriginToggle(callback: any): this {
    return this.addToggle((toggle) => {
      const adapter = Object.assign(toggle, { setDisabled(disabled: boolean) {
        toggle.inputEl.disabled = disabled;
        return adapter;
      } });
      callback(adapter);
    });
  }
  addOriginText(callback: any): this { return this.addText(callback); }
  addOriginButton(callback: any): this { return this.addButton(callback); }
  addOriginDropdown(_app: unknown, callback: any): this {
    return this.addDropdown((dropdown) => {
      const adapter = Object.assign(dropdown, { setOptionDisabled(value: string, disabled: boolean) {
        for (const option of Array.from(dropdown.selectEl.options)) if (option.value === value) option.disabled = disabled;
        return adapter;
      } });
      callback(adapter);
    });
  }
}
