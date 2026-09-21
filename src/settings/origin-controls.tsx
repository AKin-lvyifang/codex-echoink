import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { CSSProperties, ReactNode } from "react";
import { Scope, type App } from "obsidian";
import { Button } from "../ui/components/origin/button";
import { Input } from "../ui/components/origin/input";
import { Switch } from "../ui/components/origin/switch";
import { Checkbox } from "../ui/components/origin/checkbox";
import { Slider } from "../ui/components/origin/slider";
import { RadioGroup, RadioGroupItem } from "../ui/components/origin/radio-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/components/origin/select";

type ElementOptions = { cls?: string; text?: string; attr?: Record<string, string | number | boolean>; type?: string; value?: string };
type Island = { root: Root; element: HTMLElement | null; document: Document; disposed: boolean; cleanup?: () => void };
const islands = new Set<Island>();
const windowCleanup = new Map<Document, () => void>();

/** Portals keep the existing DOM hierarchy, labels and direct-child layout. */
function createIsland(parent: HTMLElement) {
  const document = parent.ownerDocument;
  const fragment = new document.defaultView!.DocumentFragment();
  const island: Island = { root: createRoot(fragment), element: null, document, disposed: false };
  islands.add(island);
  if (!windowCleanup.has(document)) {
    const cleanup = () => disposeOriginControls(document.documentElement);
    document.defaultView?.addEventListener("pagehide", cleanup);
    document.defaultView?.addEventListener("beforeunload", cleanup);
    windowCleanup.set(document, cleanup);
  }
  return {
    ref: (element: HTMLElement | null) => { island.element = element; },
    render: (node: ReactNode) => { if (!island.disposed) flushSync(() => island.root.render(createPortal(node, parent))); },
    onDispose: (cleanup: () => void) => { island.cleanup = cleanup; },
    element: () => island.element!
  };
}

/** Call before empty/remove and on the owning view's close/unload. */
export function disposeOriginControls(container: HTMLElement): void {
  for (const island of [...islands].reverse()) {
    if (island.document !== container.ownerDocument || !island.element || !container.contains(island.element)) continue;
    islands.delete(island);
    island.disposed = true;
    island.cleanup?.();
    island.root.unmount();
  }
  const document = container.ownerDocument;
  if (![...islands].some((island) => island.document === document)) {
    const cleanup = windowCleanup.get(document);
    if (cleanup) {
      document.defaultView?.removeEventListener("pagehide", cleanup);
      document.defaultView?.removeEventListener("beforeunload", cleanup);
      windowCleanup.delete(document);
    }
  }
}

function decorate(element: HTMLElement, options: ElementOptions): void {
  if (options.cls) element.classList.add(...options.cls.split(/\s+/u).filter(Boolean));
  for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, String(value));
  if (options.text) element.textContent = options.text;
}

/** Uncontrolled native fields preserve the existing input/IME/selection handlers. */
export function createOriginInput(parent: HTMLElement, options: ElementOptions = {}): HTMLInputElement {
  const island = createIsland(parent);
  island.render(<Input ref={island.ref} className="echoink-origin-control" type={String(options.attr?.type ?? options.type ?? "text")} />);
  const element = island.element() as HTMLInputElement;
  decorate(element, options);
  if (options.value !== undefined) element.value = options.value;
  return element;
}

export function createOriginButton(parent: HTMLElement, options: ElementOptions = {}): HTMLButtonElement {
  const island = createIsland(parent);
  island.render(<Button ref={island.ref} className={`echoink-origin-control${options.cls ? "" : " echoink-origin-button"}`} type="button" variant="outline" />);
  const element = island.element() as HTMLButtonElement;
  decorate(element, options);
  return element;
}

export type OriginCheckElement = HTMLButtonElement & { checked: boolean; indeterminate: boolean };

export function createOriginSwitch(parent: HTMLElement, options: ElementOptions = {}) {
  return createOriginCheck(parent, options, "switch");
}

/** The real Radix button owns state; programmatic rollback updates that same control. */
export function createOriginCheck(parent: HTMLElement, options: ElementOptions = {}, kind: "switch" | "checkbox" = "checkbox"): OriginCheckElement {
  const island = createIsland(parent);
  let checked = false;
  let indeterminate = false;
  let disabled = false;
  const onCheckedChange = (value: boolean | "indeterminate") => {
    checked = value === true;
    indeterminate = value === "indeterminate";
    render();
    const element = island.element();
    element.dispatchEvent(new (element.ownerDocument.defaultView!.Event)("change", { bubbles: true }));
  };
  const render = () => island.render(kind === "switch"
    ? <Switch ref={island.ref} className="echoink-origin-control" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    : <Checkbox ref={island.ref} className="echoink-origin-control" checked={indeterminate ? "indeterminate" : checked} disabled={disabled} onCheckedChange={onCheckedChange} />);
  render();
  const element = island.element() as OriginCheckElement;
  Object.defineProperty(element, "checked", { get: () => checked, set: (value: boolean) => { checked = Boolean(value); render(); } });
  Object.defineProperty(element, "indeterminate", { get: () => indeterminate, set: (value: boolean) => { indeterminate = kind === "checkbox" && Boolean(value); render(); } });
  Object.defineProperty(element, "disabled", { get: () => disabled, set: (value: boolean) => { disabled = Boolean(value); render(); } });
  decorate(element, { ...options, attr: Object.fromEntries(Object.entries(options.attr ?? {}).filter(([key]) => key !== "type" && key !== "role")) });
  return element;
}

export type OriginSelectElement = HTMLButtonElement & { value: string };
type OriginSelectOption = { value: string; label: string; disabled?: boolean; renderIcon?: (container: HTMLElement) => void };
export function createOriginSelect(parent: HTMLElement, options: ElementOptions,
  choices: readonly OriginSelectOption[], initialValue = "", app?: Pick<App, "keymap" | "scope">) {
  const island = createIsland(parent);
  let value = initialValue || choices[0]?.value || "";
  let disabled = false;
  const items = [...choices];
  let open = false;
  let popupElement: HTMLDivElement | null = null;
  const ownerDocument = parent.ownerDocument;
  const setPopupElement = (element: HTMLDivElement | null) => { popupElement = element; };
  const onOutsidePointerDown = (event: PointerEvent) => {
    // Radix's outside handler uses the main realm's Node constructor. A node
    // from an independent settings window fails that check. Capture in the
    // owning document also survives a host handler stopping the bubble phase.
    const path = event.composedPath();
    if (path.includes(island.element()) || (popupElement && path.includes(popupElement))) return;
    setOpen(false);
  };
  // Restore Origin/Radix's body portal, explicitly bound to the owning window.
  // Settings' size containment and native scrollport must not clip fixed content.
  const portalHost = parent.ownerDocument.body;
  let popupTheme: CSSProperties = {};
  const capturePopupTheme = () => {
    const computed = parent.ownerDocument.defaultView!.getComputedStyle(island.element());
    const properties = ["--accent", "--accent-bg", "--line", "--bg", "--text", "--soft", "--secondary", "--font-text-size", "--font-interface"];
    popupTheme = Object.fromEntries(properties.map((name) => [name, computed.getPropertyValue(name)]).filter(([, value]) => value.trim())) as CSSProperties;
  };
  const escapeScope = app ? new Scope(app.scope) : null;
  let scopeActive = false;
  const clearEscapeScope = () => {
    if (!scopeActive || !app || !escapeScope) return;
    app.keymap.popScope(escapeScope);
    scopeActive = false;
  };
  const closePopup = () => {
    setOpen(false);
    const trigger = island.element();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  escapeScope?.register(null, "Escape", () => {
    closePopup();
    return false;
  });
  const setOpen = (next: boolean) => {
    if (open === next) return;
    clearEscapeScope();
    ownerDocument.removeEventListener("pointerdown", onOutsidePointerDown, true);
    open = next;
    if (next) {
      ownerDocument.addEventListener("pointerdown", onOutsidePointerDown, true);
      capturePopupTheme();
      // Obsidian dispatches its window capture listener through the active
      // Scope first. Match native popovers instead of racing that listener.
      if (app && escapeScope) {
        app.keymap.pushScope(escapeScope);
        scopeActive = true;
      }
    }
    render();
  };
  island.onDispose(() => {
    clearEscapeScope();
    ownerDocument.removeEventListener("pointerdown", onOutsidePointerDown, true);
    popupElement = null;
  });
  const emptyValue = "__echoink_empty_selection__";
  const render = () => island.render(<Select value={value || emptyValue} disabled={disabled} open={open} onOpenChange={setOpen} onValueChange={(next) => {
    value = next === emptyValue ? "" : next; render();
    const element = island.element();
    element.dispatchEvent(new (element.ownerDocument.defaultView!.Event)("change", { bubbles: true }));
  }}>
    <SelectTrigger ref={island.ref} className="echoink-origin-control"><SelectValue /></SelectTrigger>
    <SelectContent ref={setPopupElement} container={portalHost} className="echoink-origin-control" position="popper" style={popupTheme}
      onFocusCapture={(event) => {
        const content = event.currentTarget;
        // Radix's fallback focus loop reads the main document. In a detached
        // Obsidian window that loop falls through from the selected item to the
        // listbox; keep its real selected item focused in the owning document.
        if (content.ownerDocument !== document && event.target === content) {
          (content.querySelector<HTMLElement>('[role=option][data-state=checked]:not([data-disabled])')
            ?? content.querySelector<HTMLElement>('[role=option]:not([data-disabled])'))?.focus();
        }
      }}
      onKeyDown={(event) => {
        const content = event.currentTarget;
        if (content.ownerDocument === document || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const options = Array.from(content.querySelectorAll<HTMLElement>('[role=option]:not([data-disabled])'));
        const current = options.indexOf(content.ownerDocument.activeElement as HTMLElement);
        const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : Math.max(0, Math.min(options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        event.preventDefault();
        options[index]?.focus();
        options[index]?.scrollIntoView({ block: "nearest" });
      }}
      onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); closePopup(); }}>
      {items.map((item) => <SelectItem className="echoink-origin-control" key={item.value} value={item.value || emptyValue} disabled={item.disabled} textValue={item.label}>
        {item.renderIcon ? <span className="echoink-origin-select-label">
          <span className="echoink-origin-select-icon" aria-hidden="true" ref={(container) => { if (container) item.renderIcon!(container); }} />
          <span className="echoink-origin-select-text">{item.label}</span>
        </span> : item.label}
      </SelectItem>)}
    </SelectContent>
  </Select>);
  render();
  const element = island.element() as OriginSelectElement;
  Object.defineProperty(element, "value", { get: () => value, set: (next: string) => { value = next; render(); } });
  Object.defineProperty(element, "disabled", { get: () => disabled, set: (next: boolean) => { disabled = Boolean(next); render(); } });
  decorate(element, options);
  return { element,
    addOption(next: string, label: string, renderIcon?: OriginSelectOption["renderIcon"]) { items.push({ value: next, label, renderIcon }); if (!value) value = next; render(); },
    setOptionDisabled(next: string, disabled: boolean) { const item = items.find((item) => item.value === next); if (item) { item.disabled = disabled; render(); } }
  };
}

export function createOriginSlider(parent: HTMLElement, options: {
  value: number; min: number; max: number; step: number; label: string;
  onValueChange(value: number): void; onValueCommit(value: number): void;
}) {
  const island = createIsland(parent);
  let value = options.value;
  island.render(<Slider ref={island.ref} className="echoink-origin-control" defaultValue={[value]}
    min={options.min} max={options.max} step={options.step} aria-label={options.label}
    onValueChange={(values) => { value = values[0]; options.onValueChange(value); }}
    onValueCommit={(values) => options.onValueCommit(values[0])} />);
  const element = island.element();
  element.querySelector("[role=slider]")?.setAttribute("aria-label", options.label);
  return element;
}

/** One Root for the whole list; portals keep every item inside its DOM collection. */
export function createOriginRadioGroup(parent: HTMLElement, value: string, label: string, onChange: (value: string) => void) {
  const island = createIsland(parent);
  const items: { parent: HTMLElement; value: string; disabled: boolean; ref: (element: HTMLButtonElement | null) => void }[] = [];
  const render = () => island.render(<RadioGroup ref={island.ref} className="echoink-origin-radio-group" value={value} aria-label={label}
    onKeyDownCapture={(event) => {
      const group = event.currentTarget;
      if (group.ownerDocument === document || !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const items = Array.from(group.querySelectorAll<HTMLButtonElement>('[data-slot=radio-group-item]:not(:disabled)'));
      const current = items.indexOf(event.target as HTMLButtonElement);
      if (current < 0 || group.ownerDocument.activeElement !== items[current]) return;
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
      const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (forward ? 1 : -1) + items.length) % items.length;
      event.preventDefault(); event.stopPropagation();
      // Radix's roving-focus and arrow-key ref read the main document. Keep its
      // real radio activation while resolving keyboard focus in this window.
      items[index].focus();
      items[index].click();
    }}
    onValueChange={(next) => { value = next; render(); onChange(next); }}>
    {items.map((item) => createPortal(<RadioGroupItem ref={item.ref} className="echoink-origin-control" value={item.value} disabled={item.disabled} />, item.parent, item.value))}
  </RadioGroup>);
  render();
  return { element: island.element(), addItem(parent: HTMLElement, itemValue: string, disabled: boolean): HTMLButtonElement {
    let element: HTMLButtonElement | null = null;
    items.push({ parent, value: itemValue, disabled, ref: (node) => { element = node; } });
    render();
    return element!;
  } };
}
