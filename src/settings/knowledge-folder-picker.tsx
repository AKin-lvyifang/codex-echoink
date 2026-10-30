import { Scope, type App } from "obsidian";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, Cross2Icon, MagnifyingGlassIcon, PlusIcon } from "@radix-ui/react-icons";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "../ui/components/origin/button";
import { Input } from "../ui/components/origin/input";
import { Checkbox } from "../ui/components/origin/checkbox";
import { isImeKeyEvent, watchImeComposition } from "../ui/ime-composition";

export type KnowledgeFolderChoice = { path: string; create: boolean };
export type KnowledgeFolderPickerOptions = {
  folders(): string[];
  values: KnowledgeFolderChoice[];
  multiple: boolean;
  label: string;
  disabled?: boolean;
  app?: Pick<App, "keymap" | "scope">;
  onChange(values: KnowledgeFolderChoice[]): void;
};
export type KnowledgeFolderPicker = {
  element: HTMLElement;
  setDisabled(disabled: boolean): void;
  setError(message?: string): void;
  setValues(values: KnowledgeFolderChoice[]): void;
  dispose(): void;
};

type Entry = KnowledgeFolderChoice & { id: number; previous?: Entry[] };
let pickerSequence = 0;

/** Owns one React root, including the searchable list and its owning-window portal. */
export function createKnowledgeFolderPicker(parent: HTMLElement, options: KnowledgeFolderPickerOptions): KnowledgeFolderPicker {
  const ownerDocument = parent.ownerDocument;
  const ownerWindow = ownerDocument.defaultView!;
  const element = parent.createDiv({ cls: "echoink-folder-picker" });
  const root = createRoot(new ownerWindow.DocumentFragment());
  const stopIme = watchImeComposition(ownerDocument.documentElement);
  const prefix = `echoink-folder-picker-${++pickerSequence}`;
  const listId = `${prefix}-list`;
  const errorId = `${prefix}-error`;
  let nextEntry = 0;
  let entries: Entry[] = [];
  let disabled = Boolean(options.disabled);
  let error = "";
  let open = false;
  let query = "";
  let disposed = false;
  let trigger: HTMLButtonElement | null = null;
  let content: HTMLDivElement | null = null;
  let search: HTMLInputElement | null = null;
  let popupTheme: CSSProperties = {};
  const escapeScope = options.app ? new Scope(options.app.scope) : null;
  let scopeActive = false;

  const folders = () => [...new Set(options.folders().filter(Boolean))];
  const normalize = (values: KnowledgeFolderChoice[]): Entry[] => {
    const existing = new Set(folders());
    return (options.multiple ? values : values.slice(0, 1))
      .filter(value => value.create || value.path !== "")
      .map(value => ({ path: value.path, create: value.create || !existing.has(value.path), id: ++nextEntry }));
  };
  entries = normalize(options.values);
  const values = () => entries.map(({ path, create }) => ({ path, create }));
  const notify = () => options.onChange(values());
  const focusTrigger = () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  const clearOpenListeners = () => {
    ownerDocument.removeEventListener("pointerdown", outside, true);
    ownerDocument.removeEventListener("keydown", escape, true);
    if (scopeActive && options.app && escapeScope) options.app.keymap.popScope(escapeScope);
    scopeActive = false;
  };
  const captureTheme = () => {
    if (!trigger) return;
    const computed = ownerWindow.getComputedStyle(trigger);
    const properties = ["--accent", "--accent-bg", "--line", "--bg", "--text", "--soft", "--secondary", "--origin-accent", "--origin-soft", "--origin-line", "--origin-bg", "--origin-text", "--font-interface", "--font-text-size"];
    popupTheme = { ...Object.fromEntries(properties.map(name => [name, computed.getPropertyValue(name)]).filter(([, value]) => value.trim())), fontFamily: computed.fontFamily, colorScheme: computed.colorScheme } as CSSProperties;
  };
  const setOpen = (next: boolean, restoreFocus = false) => {
    if (disposed || (next && disabled) || open === next) return;
    clearOpenListeners();
    open = next;
    if (open) {
      query = "";
      captureTheme();
      ownerDocument.addEventListener("pointerdown", outside, true);
      ownerDocument.addEventListener("keydown", escape, true);
      if (options.app && escapeScope) {
        options.app.keymap.pushScope(escapeScope);
        scopeActive = true;
      }
    }
    render();
    if (!open && restoreFocus) focusTrigger();
  };
  function outside(event: PointerEvent): void {
    const path = event.composedPath();
    if ((trigger && path.includes(trigger)) || (content && path.includes(content))) return;
    setOpen(false, true);
  }
  function escape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || isImeKeyEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false, true);
  }
  escapeScope?.register(null, "Escape", event => {
    if (isImeKeyEvent(event)) return;
    setOpen(false, true);
    return false;
  });

  const change = () => { render(); notify(); };
  const remove = (entry: Entry, cancel = false) => {
    if (disabled) return;
    entries = cancel && !options.multiple && entry.previous ? entry.previous : entries.filter(value => value.id !== entry.id);
    change();
    focusTrigger();
  };
  const choose = (path: string) => {
    if (disabled) return;
    const selected = entries.find(entry => !entry.create && entry.path === path);
    if (options.multiple) entries = selected ? entries.filter(entry => entry !== selected) : [...entries, { path, create: false, id: ++nextEntry }];
    else entries = [{ path, create: false, id: ++nextEntry }];
    change();
    if (!options.multiple) setOpen(false, true);
  };
  const startCreate = () => {
    if (disabled) return;
    const entry: Entry = { path: "", create: true, id: ++nextEntry, previous: options.multiple ? undefined : entries };
    entries = options.multiple ? [...entries, entry] : [entry];
    setOpen(false);
    change();
    element.querySelector<HTMLInputElement>(`[data-folder-draft="${entry.id}"]`)?.focus();
  };
  const navigate = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (isImeKeyEvent(event.nativeEvent) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    // Home/End in the search field retain native text editing.
    if (event.target === search && (event.key === "Home" || event.key === "End")) return;
    const items = Array.from(content?.querySelectorAll<HTMLElement>("[data-folder-option]") ?? []);
    const current = items.indexOf(ownerDocument.activeElement as HTMLElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    items[index]?.focus();
    items[index]?.scrollIntoView({ block: "nearest" });
  };
  const overlayClass = parent.closest(".echoink-settings-demo,.echoink-settings-modal") && !ownerDocument.body.classList.contains("is-mobile") ? " echoink-settings-overlay" : "";
  const render = () => {
    if (disposed) return;
    const visible = folders().filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const single = !options.multiple ? entries[0] : undefined;
    flushSync(() => root.render(createPortal(<>
      <div className="echoink-folder-picker-controls" hidden={Boolean(single?.create)}>
        <Popover.Root open={open} onOpenChange={next => setOpen(next)}>
          <Popover.Trigger asChild>
            <Button ref={node => { trigger = node; }} type="button" variant="outline" className="echoink-origin-control echoink-folder-picker-trigger" role="combobox" aria-label={options.label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} disabled={disabled}>
              <span className="echoink-folder-picker-trigger-text">{single && !single.create ? single.path : "选择文件夹"}</span><ChevronDownIcon aria-hidden="true" />
            </Button>
          </Popover.Trigger>
          <Popover.Portal container={ownerDocument.body}>
            <Popover.Content ref={node => { content = node; }} className={`echoink-folder-picker-popover echoink-theme-overlay${overlayClass}`} style={popupTheme} align="start" sideOffset={4} collisionPadding={12}
              onOpenAutoFocus={event => { event.preventDefault(); search?.focus(); }}
              onCloseAutoFocus={event => { event.preventDefault(); focusTrigger(); }}
              onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false, true); }}
              onKeyDown={navigate}>
              <div className="echoink-folder-picker-search"><MagnifyingGlassIcon aria-hidden="true" /><Input ref={node => { search = node; }} type="search" className="echoink-origin-control" value={query} aria-label={`搜索${options.label}`} placeholder="搜索文件夹" aria-controls={listId} autoComplete="off" onInput={event => { query = event.currentTarget.value; render(); }} /></div>
              <div id={listId} role="listbox" aria-label={options.label} aria-multiselectable={options.multiple || undefined} className="echoink-folder-picker-options">
                {visible.map(path => {
                  const selected = entries.some(entry => !entry.create && entry.path === path);
                  return <div key={path} role="option" aria-selected={selected} tabIndex={-1} data-folder-option="" className={`echoink-folder-picker-option${selected ? " is-selected" : ""}`} onClick={() => choose(path)} onKeyDown={event => {
                    if ((event.key === "Enter" || event.key === " ") && !isImeKeyEvent(event.nativeEvent)) { event.preventDefault(); choose(path); }
                  }}>
                    {options.multiple ? <Checkbox className="echoink-origin-control" checked={selected} tabIndex={-1} aria-hidden="true" /> : <span className="echoink-folder-picker-check">{selected && <CheckIcon aria-hidden="true" />}</span>}
                    <span>{path}</span>
                  </div>;
                })}
                {!visible.length && <div className="echoink-folder-picker-empty" role="status">没有匹配的文件夹</div>}
              </div>
              <Button type="button" variant="ghost" className="echoink-origin-control echoink-folder-picker-create" data-folder-option="" onClick={startCreate}><PlusIcon aria-hidden="true" />新建文件夹…</Button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {single && !single.create && <Button type="button" variant="ghost" className="echoink-origin-control echoink-folder-picker-remove" disabled={disabled} aria-label={`移除${single.path}`} onClick={() => remove(single)}><Cross2Icon aria-hidden="true" /></Button>}
      </div>
      {entries.length > 0 && <div className="echoink-folder-picker-values">
        {entries.map(entry => entry.create ? <div key={entry.id} className="echoink-folder-picker-draft">
          <Input className="echoink-origin-control" value={entry.path} data-folder-draft={entry.id} aria-label={options.label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} disabled={disabled} placeholder="文件夹路径" onInput={event => { entry.path = event.currentTarget.value; change(); }} />
          <span className="echoink-folder-picker-new">新建</span>
          <Button type="button" variant="ghost" className="echoink-origin-control echoink-folder-picker-remove" disabled={disabled} aria-label="取消新建" onClick={() => remove(entry, true)}><Cross2Icon aria-hidden="true" /></Button>
        </div> : options.multiple ? <span key={entry.id} className="echoink-folder-picker-tag"><span>{entry.path}</span><Button type="button" variant="ghost" className="echoink-origin-control echoink-folder-picker-remove" disabled={disabled} aria-label={`移除${entry.path}`} onClick={() => remove(entry)}><Cross2Icon aria-hidden="true" /></Button></span> : null)}
      </div>}
      {error && <div className="echoink-folder-picker-error" id={errorId} role="alert">{error}</div>}
    </>, element)));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearOpenListeners();
    stopIme();
    ownerWindow.removeEventListener("pagehide", dispose);
    ownerWindow.removeEventListener("beforeunload", dispose);
    root.unmount();
    element.remove();
  };
  ownerWindow.addEventListener("pagehide", dispose);
  ownerWindow.addEventListener("beforeunload", dispose);
  render();
  // Inform the owner when a saved default no longer exists in this Vault.
  if (entries.some((entry, index) => entry.create !== options.values[index]?.create)) queueMicrotask(() => { if (!disposed) notify(); });
  return {
    element,
    setDisabled(next) { if (disposed) return; disabled = next; if (disabled && open) setOpen(false, true); else render(); },
    setError(message = "") { if (error === message) return; error = message; render(); },
    setValues(next) { entries = normalize(next); render(); },
    dispose
  };
}
