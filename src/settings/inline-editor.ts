import { type Modal, setIcon } from "obsidian";
import { createOriginButton, disposeOriginControls } from "./origin-controls";

export interface SettingsEditorHandle {
  (): void;
  readonly host: HTMLElement;
  readonly disposed: boolean;
  readonly suspended: boolean;
  suspend(): void;
  resume(parent: HTMLElement): void;
}

export interface SettingsEditorMountOptions {
  /** Returning changes location; only the form's own close discards its draft. */
  readonly onNavigateBack?: () => void;
}

type InlineEditor = Modal & {
  setInlineCloseHandler?: (handler: () => void) => void;
  onInlineSuspend?: () => void;
  onInlineResume?: () => void;
};

/** Mount the original form in Settings and retain its lifecycle while navigating. */
export function mountSettingsEditor(
  modal: Modal,
  host: HTMLElement,
  backLabel: string,
  onBack: () => void,
  options: SettingsEditorMountOptions = {}
): SettingsEditorHandle {
  host.addClass("echoink-settings-inline-editor");
  const back = createOriginButton(host, { cls: "settings-back text-button", attr: { type: "button" } });
  setIcon(back.createSpan(), "chevron-left");
  back.createSpan({ text: backLabel });
  const surface = host.createDiv({ cls: "echoink-settings-inline-surface echoink-settings-modal" });
  modal.containerEl = surface;
  modal.modalEl = surface;
  modal.titleEl = surface.createEl("h2", { cls: "echoink-settings-inline-title" });
  modal.contentEl = surface.createDiv({ cls: "echoink-settings-inline-content" });
  const inlineAware = modal as InlineEditor;
  const originalClose = modal.close.bind(modal) as Modal["close"];
  let disposed = false;
  let suspended = false;
  let focused: HTMLElement | null = null;
  let focusKey: string | null = null;
  let selection: [number | null, number | null] | null = null;
  const dispose = (() => {
    if (disposed) return;
    disposed = true;
    host.removeEventListener("keydown", handleKeydown);
    host.removeEventListener("focusin", rememberFocus);
    host.removeEventListener("focusout", rememberSelection);
    inlineAware.setInlineCloseHandler?.(() => undefined);
    if (!inlineAware.setInlineCloseHandler) modal.close = originalClose;
    modal.onClose();
    disposeOriginControls(host);
    host.remove();
    focused = null;
    selection = null;
  }) as SettingsEditorHandle;
  const close = () => { if (disposed) return; dispose(); onBack(); };
  if (inlineAware.setInlineCloseHandler) inlineAware.setInlineCloseHandler(close);
  else modal.close = close;
  Object.defineProperties(dispose, {
    host: { value: host },
    disposed: { get: () => disposed },
    suspended: { get: () => suspended }
  });
  dispose.suspend = () => {
    if (disposed || suspended) return;
    const active = host.ownerDocument.activeElement;
    if (active && active !== back && host.contains(active)) focused = active as HTMLElement;
    focusKey = focused?.getAttribute("data-modal-focus-key") ?? focused?.getAttribute("data-mcp-modal-focus-key") ?? null;
    selection = focused && "selectionStart" in focused
      ? [(focused as HTMLInputElement).selectionStart, (focused as HTMLInputElement).selectionEnd]
      : null;
    suspended = true;
    inlineAware.onInlineSuspend?.();
    host.remove();
  };
  dispose.resume = (parent) => {
    if (disposed) return;
    parent.append(host);
    if (!suspended) return;
    suspended = false;
    inlineAware.onInlineResume?.();
    const target = focused && host.contains(focused) ? focused : focusKey
      ? Array.from(host.querySelectorAll<HTMLElement>("[data-modal-focus-key], [data-mcp-modal-focus-key]"))
        .find((element) => (element.getAttribute("data-modal-focus-key") ?? element.getAttribute("data-mcp-modal-focus-key")) === focusKey)
      : null;
    target?.focus({ preventScroll: true });
    if (target && selection && selection[0] !== null && selection[1] !== null && "setSelectionRange" in target) {
      (target as HTMLInputElement).setSelectionRange(selection[0], selection[1]);
    }
  };
  const navigateBack = () => {
    if (options.onNavigateBack) {
      dispose.suspend();
      options.onNavigateBack();
    } else modal.close();
  };
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented || host.querySelector(".codex-provider-combobox.is-open, [data-slot=select-content][data-state=open]")) return;
    event.preventDefault();
    event.stopPropagation();
    navigateBack();
  }
  function rememberFocus(event: FocusEvent): void {
    if (event.target === back) return;
    focused = event.target as HTMLElement;
  }
  function rememberSelection(): void {
    if (focused && "selectionStart" in focused) {
      selection = [(focused as HTMLInputElement).selectionStart, (focused as HTMLInputElement).selectionEnd];
    }
  }
  back.onclick = navigateBack;
  host.addEventListener("focusin", rememberFocus);
  host.addEventListener("focusout", rememberSelection);
  host.addEventListener("keydown", handleKeydown);
  void modal.onOpen();
  return dispose;
}
