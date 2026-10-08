import { setIcon } from "obsidian";

/** Shared financial toolbar action, including its icon and primary variant. */
export function financeActionButton(parent: HTMLElement, label: string, icon: string, run: () => void, primary = false): HTMLButtonElement {
  const control = parent.createEl("button", { cls: `echoink-finance-action-button${primary ? " echoink-finance-primary" : ""}`, attr: { type: "button" } });
  control.onclick = run;
  setIcon(control.createSpan({ cls: "echoink-finance-action-icon", attr: { "aria-hidden": "true" } }), icon);
  control.createSpan({ text: label });
  return control;
}
