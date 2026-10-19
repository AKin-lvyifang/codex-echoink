import { setIcon } from "obsidian";
import type { MobileShellSheet } from "./shell-types";

/** These primitives have no knowledge of a device, page, task or provider. */
export function shellElement<K extends keyof HTMLElementTagNameMap>(
  document: Document, tag: K, className: string, text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function shellIconButton(document: Document, label: string, icon: string, action: () => void): HTMLButtonElement {
  const button = shellElement(document, "button", "echoink-shell-icon");
  button.type = "button";
  button.setAttribute("aria-label", label);
  setIcon(button, icon);
  button.addEventListener("click", action);
  return button;
}

/** A short task stays inside its owning pane and does not replace its input nodes. */
export class ContainedShellSheet {
  private layer?: HTMLElement;
  private previousFocus?: HTMLElement;
  private previousInert = false;
  private previousHidden: string | null = null;
  private onClose?: () => void;

  constructor(private readonly root: HTMLElement, private readonly background: HTMLElement) {}

  get isOpen(): boolean { return !!this.layer; }

  open(sheet: MobileShellSheet): void {
    const originalFocus = this.previousFocus;
    this.close(false);
    const document = this.root.ownerDocument;
    const active = document.activeElement;
    this.previousFocus = originalFocus?.isConnected ? originalFocus : active && "focus" in active ? active as HTMLElement : undefined;
    this.previousInert = this.background.inert;
    this.previousHidden = this.background.getAttribute("aria-hidden");
    this.background.inert = true;
    this.background.setAttribute("aria-hidden", "true");
    this.onClose = sheet.onClose;
    const layer = shellElement(document, "div", "echoink-shell-sheet-layer");
    const backdrop = shellElement(document, "div", "echoink-shell-sheet-backdrop");
    backdrop.addEventListener("click", () => this.close());
    const dialog = shellElement(document, "section", "echoink-shell-sheet");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", sheet.title);
    dialog.tabIndex = -1;
    const handle = shellElement(document, "div", "echoink-shell-sheet-handle");
    handle.setAttribute("aria-hidden", "true");
    const header = shellElement(document, "div", "echoink-shell-sheet-header");
    header.append(shellElement(document, "span", "echoink-shell-sheet-title", sheet.title));
    header.append(shellIconButton(document, "关闭", "x", () => this.close()));
    const content = shellElement(document, "div", "echoink-shell-sheet-content");
    content.append(sheet.content);
    dialog.append(handle, header, content);
    if (sheet.footer) {
      const footer = shellElement(document, "div", "echoink-shell-sheet-footer");
      footer.append(sheet.footer);
      dialog.append(footer);
    }
    layer.append(backdrop, dialog);
    this.layer = layer;
    this.root.append(layer);
    dialog.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); this.close();
      } else if (event.key === "Tab") {
        const items = Array.from(dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"
        )).filter(item => !item.hidden && !item.closest("[hidden], [inert], [aria-hidden='true']"));
        const first = items[0], last = items.at(-1);
        if (!first) { event.preventDefault(); dialog.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    });
    (dialog.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']") ?? dialog).focus({ preventScroll: true });
  }

  close(restoreFocus = true): boolean {
    if (!this.layer) return false;
    this.layer.remove(); this.layer = undefined;
    this.background.inert = this.previousInert;
    if (this.previousHidden === null) this.background.removeAttribute("aria-hidden");
    else this.background.setAttribute("aria-hidden", this.previousHidden);
    const focus = this.previousFocus, callback = this.onClose;
    this.previousFocus = undefined; this.onClose = undefined;
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true });
    callback?.();
    return true;
  }

  dispose(): void { this.close(false); }
}
