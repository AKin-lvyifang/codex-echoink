import { ownedDiv } from "./owned-dom";
import { createPluginEditionBadge } from "../settings/plugin-edition-badge";
import { setIcon } from "obsidian";
export interface SelectionAskMenuAction { id: string; name: string; template: string }
/** Buttons another feature adds after the Ask actions (e.g. note comments). */
export interface SelectionToolbarExtras {
  buttons: readonly { id: string; name: string; icon: string }[];
  /** Locked buttons stay visible; choosing one calls onLocked instead of closing. */
  locked: boolean;
  language: "zh-CN" | "en";
  onChoose(id: string): void;
  onLocked?(menu: HTMLElement): void;
}
export function createSelectionAskPopover(doc: Document, rect: DOMRect, actions: readonly SelectionAskMenuAction[], onChoose: (action: SelectionAskMenuAction) => void, onClose: () => void, extras?: SelectionToolbarExtras): { close(): void; reposition(rect: DOMRect): void; element: HTMLElement } {
  const win = doc.defaultView!;
  const menu = ownedDiv(doc); menu.className = "echoink-selection-menu";
  const english = actions[0]?.name === "Ask";
  menu.classList.toggle("is-dark", doc.body.classList.contains("theme-dark")); menu.setAttribute("role", "toolbar");
  menu.setAttribute("aria-label", english ? "Selection Ask" : "选文提问");
  const makeButton = (action: SelectionAskMenuAction) => {
    const button = menu.createEl("button", { attr: { type: "button" } });
    const icon = button.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(icon, "pencil"); button.append(doc.createTextNode(action.name));
    button.onclick = () => { const frozen = { ...action }; close(); onChoose(frozen); }; return button;
  };
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  actions.forEach(makeButton);
  if (extras?.buttons.length) {
    for (const item of extras.buttons) {
      const button = menu.createEl("button", { cls: extras.locked ? "is-locked" : "", attr: { type: "button", "data-toolbar-action": item.id, ...(extras.locked ? { "aria-disabled": "true" } : {}) } });
      const icon = button.createSpan({ attr: { "aria-hidden": "true" } }); setIcon(icon, item.icon); button.append(doc.createTextNode(item.name));
      button.onclick = (event) => {
        if (extras.locked) { event.preventDefault(); extras.onLocked?.(menu); return; }
        close(); extras.onChoose(item.id);
      };
    }
    if (extras.locked) createPluginEditionBadge(menu, "pro", extras.language).addClass("echoink-selection-pro-tag");
  }
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); onClose(); }
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
    if (event.key === "Enter" && buttons.includes(doc.activeElement as HTMLButtonElement)) { event.preventDefault(); (doc.activeElement as HTMLButtonElement).click(); }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const index = buttons.indexOf(doc.activeElement as HTMLButtonElement), backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
      const next = index < 0 ? (backward ? buttons.length - 1 : 0) : (index + (backward ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  doc.body.append(menu);
  function close() { menu.remove(); if (extras) doc.querySelectorAll(".echoink-selection-pro-popover").forEach(node => node.remove()); }
  function reposition(box: DOMRect) {
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left + box.width / 2 - bounds.width / 2, win.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${box.top >= bounds.height + 14 ? box.top - bounds.height - 6 : Math.min(win.innerHeight - bounds.height - 8, box.bottom + 6)}px`;
  }
  reposition(rect); return { close, reposition, element: menu };
}
