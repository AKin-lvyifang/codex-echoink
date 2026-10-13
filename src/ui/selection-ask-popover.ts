import { setIcon } from "obsidian";
export interface SelectionAskMenuAction { id: string; name: string; template: string }
export function createSelectionAskPopover(doc: Document, rect: DOMRect, actions: readonly SelectionAskMenuAction[], onChoose: (action: SelectionAskMenuAction) => void, onClose: () => void): { close(): void; reposition(rect: DOMRect): void } {
  const win = doc.defaultView!;
  const menu = doc.createElement("div"); menu.className = "echoink-selection-menu";
  const english = actions[0]?.name === "Ask";
  menu.classList.toggle("is-dark", doc.body.classList.contains("theme-dark")); menu.setAttribute("role", "toolbar");
  menu.setAttribute("aria-label", english ? "Selection Ask" : "选文提问");
  const makeButton = (action: SelectionAskMenuAction) => {
    const button = doc.createElement("button"); button.type = "button";
    const icon = doc.createElement("span"); setIcon(icon, "pencil"); button.append(icon, doc.createTextNode(action.name));
    button.onclick = () => { const frozen = { ...action }; close(); onChoose(frozen); }; return button;
  };
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.append(makeButton(actions[0]));
  let list: HTMLElement | undefined;
  if (actions.length > 1) {
    const arrow = doc.createElement("button"); arrow.type = "button"; arrow.setAttribute("aria-label", english ? "Ask options" : "提问选项"); arrow.setAttribute("aria-haspopup", "menu"); arrow.setAttribute("aria-expanded", "false"); setIcon(arrow, "chevron-down"); menu.append(arrow);
    list = doc.createElement("div"); list.className = "echoink-selection-options"; list.hidden = true; list.setAttribute("role", "menu"); menu.append(list);
    actions.forEach((action) => { const button = makeButton(action); button.setAttribute("role", "menuitem"); list!.append(button); });
    arrow.onclick = () => {
      list!.hidden = !list!.hidden; arrow.setAttribute("aria-expanded", String(!list!.hidden));
      if (!list!.hidden) {
        const box = menu.getBoundingClientRect(), below = win.innerHeight - box.bottom - 12, above = box.top - 12;
        const downward = below >= Math.min(list!.scrollHeight || 120, above);
        list!.style.top = downward ? "calc(100% + 4px)" : "auto"; list!.style.bottom = downward ? "auto" : "calc(100% + 4px)";
        list!.style.maxHeight = `${Math.max(0, downward ? below : above)}px`;
        list!.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
  }
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); onClose(); }
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      const buttons = Array.from((list && !list.hidden ? list : menu).querySelectorAll<HTMLButtonElement>("button")).filter((button) => !button.closest("[hidden]"));
      const index = buttons.indexOf(doc.activeElement as HTMLButtonElement); buttons[(index + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length]?.focus();
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
