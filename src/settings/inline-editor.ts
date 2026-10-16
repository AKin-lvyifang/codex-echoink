import { type Modal, setIcon } from "obsidian";
import { disposeOriginControls } from "./origin-controls";

/** Mount an existing form lifecycle inside Settings without opening another window. */
export function mountSettingsEditor(modal: Modal, host: HTMLElement, backLabel: string, onBack: () => void): () => void {
  host.addClass("echoink-settings-inline-editor");
  const back = host.createEl("button", { cls: "settings-back text-button", attr: { type: "button" } });
  setIcon(back.createSpan(), "chevron-left");
  back.createSpan({ text: backLabel });
  const surface = host.createDiv({ cls: "echoink-settings-inline-surface echoink-settings-modal" });
  modal.containerEl = surface;
  modal.modalEl = surface;
  modal.titleEl = surface.createEl("h2", { cls: "echoink-settings-inline-title" });
  modal.contentEl = surface.createDiv({ cls: "echoink-settings-inline-content" });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    modal.onClose();
    disposeOriginControls(host);
    host.remove();
  };
  const close = () => { if (disposed) return; dispose(); onBack(); };
  const inlineAware = modal as Modal & { setInlineCloseHandler?: (handler: () => void) => void };
  if (inlineAware.setInlineCloseHandler) inlineAware.setInlineCloseHandler(close);
  else modal.close = close;
  back.onclick = () => modal.close();
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || host.querySelector(".codex-provider-combobox.is-open, [data-slot=select-content][data-state=open]")) return;
    event.preventDefault(); event.stopPropagation(); modal.close();
  });
  void modal.onOpen();
  return dispose;
}
