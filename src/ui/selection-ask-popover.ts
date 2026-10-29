import { ownedDiv } from "./owned-dom";
import { setIcon } from "obsidian";
export interface SelectionAskMenuAction { id: string; name: string; template: string }
export function createSelectionAskPopover(doc: Document, rect: DOMRect, actions: readonly SelectionAskMenuAction[], onChoose: (action: SelectionAskMenuAction) => void, onClose: () => void): { close(): void; reposition(rect: DOMRect): void } {
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
  function close() { menu.remove(); }
  function reposition(box: DOMRect) {
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(box.left + box.width / 2 - bounds.width / 2, win.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${box.top >= bounds.height + 14 ? box.top - bounds.height - 6 : Math.min(win.innerHeight - bounds.height - 8, box.bottom + 6)}px`;
  }
  reposition(rect); return { close, reposition };
}
