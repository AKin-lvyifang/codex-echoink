import { Scope, setIcon, type App } from "obsidian";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, MagnifyingGlassIcon, PlusIcon } from "@radix-ui/react-icons";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Input } from "../ui/components/origin/input";
import { isImeKeyEvent, watchImeComposition } from "../ui/ime-composition";
import { initializationFolderIssues } from "../knowledge-base/initialization-choices";
import { attachNativeTooltip, type NativeTooltipHandle } from "../ui/native-tooltip";

export type KnowledgeFolderChoice = { path: string; create: boolean };
export type KnowledgeFolderPickerOptions = {
  folders(): string[];
  values: KnowledgeFolderChoice[];
  multiple: boolean;
  required?: boolean;
  /** Capture destinations may only select an already bound source. */
  allowCreate?: boolean;
  label: string;
  /** Optional single-value choice, e.g. a native journal stored at the Vault root. */
  emptyLabel?: string;
  language?: string;
  disabled?: boolean;
  app?: Pick<App, "keymap" | "scope">;
  onChange(values: KnowledgeFolderChoice[]): void;
  /** Unconfirmed or invalid drafts must block the containing form's submit. */
  onEditingChange?(editing: boolean): void;
};
export type KnowledgeFolderPicker = {
  element: HTMLElement;
  setDisabled(disabled: boolean): void;
  setError(message?: string): void;
  setValues(values: KnowledgeFolderChoice[]): void;
  dispose(): void;
};

type Entry = KnowledgeFolderChoice & { id: number };
type Draft = { id: number; path: string };
let pickerSequence = 0;

/** One Origin-styled searchable control; new-folder drafts never leave this island. */
export function createKnowledgeFolderPicker(parent: HTMLElement, options: KnowledgeFolderPickerOptions): KnowledgeFolderPicker {
  const t = (zh: string, en: string) => options.language === "en" ? en : zh;
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
  let draft: Draft | null = null;
  let disabled = Boolean(options.disabled);
  let error = "";
  let draftError = "";
  let open = false;
  let query = "";
  let disposed = false;
  let trigger: HTMLButtonElement | null = null;
  let content: HTMLDivElement | null = null;
  let search: HTMLInputElement | null = null;
  let draftInput: HTMLInputElement | null = null;
  let popupTheme: CSSProperties = {};
  let folderItems: { path: string; search: string }[] = [];
  const escapeScope = options.app ? new Scope(options.app.scope) : null;
  let scopeActive = false;
  const tooltipNodes = new Map<HTMLElement, { path: string; handle: NativeTooltipHandle }>();
  const pathTooltip = (node: HTMLElement | null, path: string) => {
    if (!node || tooltipNodes.get(node)?.path === path) return;
    tooltipNodes.get(node)?.handle.dispose();
    tooltipNodes.set(node, { path, handle: attachNativeTooltip(node, path) });
  };

  const folders = () => [...new Set(options.folders().filter(Boolean))];
  const normalize = (values: KnowledgeFolderChoice[]): Entry[] => {
    return (options.multiple ? values : values.slice(0, 1))
      .filter(value => value.path.trim() !== "")
      .map(value => ({ ...value, id: ++nextEntry }));
  };
  entries = normalize(options.values);
  const values = () => entries.map(({ path, create }) => ({ path, create }));
  const notify = () => options.onChange(values());
  const focusTrigger = () => { if (!draft && trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  const clearOpenListeners = () => {
    ownerDocument.removeEventListener("pointerdown", outside, true);
    ownerDocument.removeEventListener("keydown", escape, true);
    if (scopeActive && options.app && escapeScope) options.app.keymap.popScope(escapeScope);
    scopeActive = false;
  };
  const syncOpenListeners = () => {
    ownerDocument.removeEventListener("pointerdown", outside, true);
    ownerDocument.removeEventListener("keydown", escape, true);
    if (open) ownerDocument.addEventListener("pointerdown", outside, true);
    if (open || draft) {
      ownerDocument.addEventListener("keydown", escape, true);
      if (!scopeActive && options.app && escapeScope) {
        options.app.keymap.pushScope(escapeScope);
        scopeActive = true;
      }
    } else clearOpenListeners();
  };
  const captureTheme = () => {
    if (!trigger) return;
    const computed = ownerWindow.getComputedStyle(trigger);
    const properties = ["--accent", "--accent-bg", "--line", "--bg", "--text", "--soft", "--secondary", "--origin-accent", "--origin-soft", "--origin-line", "--origin-bg", "--origin-text", "--font-interface", "--font-text-size"];
    popupTheme = { ...Object.fromEntries(properties.map(name => [name, computed.getPropertyValue(name)]).filter(([, value]) => value.trim())), fontFamily: computed.fontFamily, colorScheme: computed.colorScheme } as CSSProperties;
  };
  const setOpen = (next: boolean, restoreFocus = false) => {
    if (disposed || (next && (disabled || draft)) || open === next) return;
    open = next;
    if (open) {
      query = "";
      // Cache the Vault traversal and lowercase keys once per opening.
      folderItems = folders().map(path => ({ path, search: path.toLocaleLowerCase() }));
      captureTheme();
    }
    syncOpenListeners();
    render();
    if (!open && restoreFocus) focusTrigger();
  };
  function outside(event: PointerEvent): void {
    const path = event.composedPath();
    if ((trigger && path.includes(trigger)) || (content && path.includes(content))) return;
    setOpen(false, true);
  }
  const cancelDraft = () => {
    if (!draft) return;
    // Consume before unmount/blur so Escape cannot submit the same draft later.
    draft = null;
    draftError = "";
    syncOpenListeners();
    render();
    options.onEditingChange?.(false);
    focusTrigger();
  };
  const closeCurrent = () => { if (draft) cancelDraft(); else setOpen(false, true); };
  function escape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || isImeKeyEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    closeCurrent();
  }
  escapeScope?.register(null, "Escape", event => {
    if (isImeKeyEvent(event)) return;
    closeCurrent();
    return false;
  });

  const remove = (entry: Entry) => {
    if (disabled || disposed) return;
    entries = entries.filter(value => value.id !== entry.id);
    render();
    notify();
    focusTrigger();
  };
  const choose = (path: string | null) => {
    if (disabled || disposed) return;
    if (path !== null && !folders().includes(path)) {
      error = t("文件夹不存在", "Folder does not exist");
      setOpen(false, true);
      return;
    }
    error = "";
    if (path === null) {
      if (options.required || options.multiple) return;
      entries = [];
    } else if (options.multiple) {
      if (entries.some(entry => entry.path === path)) return;
      entries = [...entries, { path, create: false, id: ++nextEntry }];
    } else entries = [{ path, create: false, id: ++nextEntry }];
    setOpen(false, true);
    notify();
  };
  const startCreate = () => {
    if (disabled || disposed) return;
    open = false;
    draft = { path: "", id: ++nextEntry };
    draftError = "";
    error = "";
    syncOpenListeners();
    render();
    options.onEditingChange?.(true);
    draftInput?.focus({ preventScroll: true });
  };
  const validateDraft = (path: string) => {
    const issues = initializationFolderIssues([{ key: "draft", title: options.label, values: [{ path, create: true }] }], folders());
    if (options.multiple && entries.some(entry => entry.path.toLocaleLowerCase() === path.toLocaleLowerCase())) return `${path} 文件夹重名，请修改`;
    const issue = issues.get("draft")?.join("；") ?? "";
    return issue && options.language === "en" ? "Enter a valid Vault-relative folder path" : issue;
  };
  const finishCreate = (id: number, path: string) => {
    if (disposed || disabled || draft?.id !== id) return;
    const next = path.trim();
    draftError = validateDraft(next);
    if (draftError) { render(); return; }
    // Enter may cause blur. The consumed draft makes that second event a no-op.
    draft = null;
    error = "";
    const entry = { path: next, create: true, id: ++nextEntry };
    entries = options.multiple ? [...entries, entry] : [entry];
    syncOpenListeners();
    render();
    notify();
    options.onEditingChange?.(false);
  };
  const navigate = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (isImeKeyEvent(event.nativeEvent) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
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
  const selectOnKey = (event: ReactKeyboardEvent<HTMLElement>, path: string | null) => {
    if ((event.key === "Enter" || event.key === " ") && !isImeKeyEvent(event.nativeEvent)) { event.preventDefault(); choose(path); }
  };
  const overlayClass = parent.closest(".echoink-paper-guide-modal") ? " echoink-paper-guide-select-overlay" : parent.closest(".echoink-settings-demo,.echoink-settings-modal") && !ownerDocument.body.classList.contains("is-mobile") ? " echoink-settings-overlay" : "";
  const render = () => {
    if (disposed) return;
    const selected = new Set(entries.map(entry => entry.path));
    const term = query.toLocaleLowerCase();
    const visible = folderItems.filter(item => (!options.multiple || !selected.has(item.path)) && item.search.includes(term));
    const single = !options.multiple ? entries[0] : undefined;
    const currentDraft = draft;
    const message = draftError || error;
    flushSync(() => root.render(createPortal(<>
      <div className={`echoink-folder-picker-values${options.multiple ? " is-multiple" : ""}`}>
        {options.multiple && entries.map(entry => <span key={entry.id} className="echoink-folder-picker-tag" ref={node => pathTooltip(node, entry.path)}>
          <span className="echoink-folder-picker-tag-path">{entry.path}</span>
          {entry.create && <span className="echoink-folder-picker-new">新建</span>}
          <button type="button" className="echoink-origin-control echoink-folder-picker-remove" disabled={disabled} aria-label={`移除${entry.path}`} onClick={() => remove(entry)}>
            <span aria-hidden="true" ref={node => { if (node) setIcon(node, "x"); }} />
          </button>
        </span>)}
        <div className={`echoink-folder-picker-controls${currentDraft ? " is-editing" : ""}`}>
          {currentDraft ? <Input key="draft" ref={node => { draftInput = node; }} className="echoink-origin-control echoink-folder-picker-draft" value={currentDraft.path} data-folder-draft={currentDraft.id} aria-label={options.label} aria-invalid={Boolean(message)} aria-describedby={message ? errorId : undefined} disabled={disabled} placeholder={t("新文件夹名称", "New folder path")}
            onInput={event => { if (draft?.id === currentDraft.id) { draft.path = event.currentTarget.value; if (draftError) draftError = validateDraft(draft.path.trim()); render(); } }}
            onBlur={event => finishCreate(currentDraft.id, event.currentTarget.value)}
            onKeyDown={event => {
              if (isImeKeyEvent(event.nativeEvent)) return;
              if (event.key === "Enter") { event.preventDefault(); finishCreate(currentDraft.id, event.currentTarget.value); focusTrigger(); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDraft(); }
            }} /> : <Popover.Root open={open} onOpenChange={next => setOpen(next)}>
            {/* Origin Select's shared trigger/value slots supply the same visual.
                Popover preserves the search field's native editing semantics. */}
            <Popover.Trigger ref={node => { trigger = node; }} type="button" data-slot="select-trigger" className="echoink-origin-control echoink-folder-picker-trigger" role="combobox" aria-label={options.label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-required={options.required || undefined} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} disabled={disabled}
              onKeyDown={event => {
                if (["ArrowDown", "ArrowUp"].includes(event.key) && !isImeKeyEvent(event.nativeEvent)) { event.preventDefault(); setOpen(true); }
              }}>
              <span data-slot="select-value" className="echoink-folder-picker-trigger-value"><span className="echoink-folder-picker-trigger-text">{options.multiple ? t("添加", "Add") : single?.path ?? (options.required ? t("选择文件夹", "Choose a folder") : options.emptyLabel ?? t("不设置", "Not set"))}</span>{single?.create && <span className="echoink-folder-picker-new">{t("新建", "New")}</span>}</span>
              <ChevronDownIcon className="shrink-0 in-aria-invalid:text-destructive/80 text-muted-foreground/80" aria-hidden="true" width={16} height={16} />
            </Popover.Trigger>
            <Popover.Portal container={ownerDocument.body}>
              <Popover.Content ref={node => { content = node; }} data-slot="select-content" className={`echoink-origin-control echoink-folder-picker-popover echoink-theme-overlay${overlayClass}`} style={popupTheme} align="end" sideOffset={4} collisionPadding={12}
                onOpenAutoFocus={event => { event.preventDefault(); search?.focus(); }}
                onCloseAutoFocus={event => { event.preventDefault(); focusTrigger(); }}
                onEscapeKeyDown={event => { if (isImeKeyEvent(event)) { event.preventDefault(); return; } event.preventDefault(); event.stopPropagation(); setOpen(false, true); }}
                onKeyDown={navigate}>
                <div className="echoink-folder-picker-search"><MagnifyingGlassIcon aria-hidden="true" /><Input ref={node => { search = node; }} type="search" className="echoink-origin-control" value={query} aria-label={t(`搜索${options.label}`, `Search ${options.label}`)} placeholder={t("搜索文件夹", "Search folders")} aria-controls={listId} autoComplete="off" onInput={event => { query = event.currentTarget.value; render(); }} /></div>
                <div id={listId} role="listbox" aria-label={options.label} aria-multiselectable={options.multiple || undefined} className="echoink-folder-picker-options">
                  {!options.multiple && !options.required && <div role="option" aria-selected={!single} tabIndex={-1} data-slot="select-item" data-folder-option="" className={`echoink-origin-control echoink-folder-picker-option${!single ? " is-selected" : ""}`} onClick={() => choose(null)} onKeyDown={event => selectOnKey(event, null)}>
                    <span className="echoink-folder-picker-check">{!single && <CheckIcon aria-hidden="true" />}</span><span>{options.emptyLabel ?? t("不设置", "Not set")}</span>
                  </div>}
                  {visible.map(({ path }) => <div key={path} role="option" aria-selected={!options.multiple && single?.path === path} tabIndex={-1} data-slot="select-item" data-folder-option="" className={`echoink-origin-control echoink-folder-picker-option${!options.multiple && single?.path === path ? " is-selected" : ""}`} onClick={() => choose(path)} onKeyDown={event => selectOnKey(event, path)}>
                    <span className="echoink-folder-picker-check">{!options.multiple && single?.path === path && <CheckIcon aria-hidden="true" />}</span><span>{path}</span>
                  </div>)}
                  {!visible.length && <div className="echoink-folder-picker-empty" role="status">{t("没有匹配的文件夹", "No matching folders")}</div>}
                </div>
                {options.allowCreate !== false && <button type="button" data-slot="select-item" className="echoink-origin-control echoink-folder-picker-option echoink-folder-picker-create" data-folder-option="" onClick={startCreate}><span className="echoink-folder-picker-check"><PlusIcon aria-hidden="true" /></span><span>{t("新建文件夹…", "New folder…")}</span></button>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>}
        </div>
      </div>
      {message && <div className="echoink-folder-picker-error" id={errorId} role="alert">{message}</div>}
    </>, element)));
    for (const [node, tooltip] of tooltipNodes) if (!node.isConnected) { tooltip.handle.dispose(); tooltipNodes.delete(node); }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const wasEditing = Boolean(draft);
    draft = null;
    clearOpenListeners();
    stopIme();
    ownerWindow.removeEventListener("pagehide", dispose);
    ownerWindow.removeEventListener("beforeunload", dispose);
    root.unmount();
    tooltipNodes.forEach(tooltip => tooltip.handle.dispose()); tooltipNodes.clear();
    element.remove();
    if (wasEditing) options.onEditingChange?.(false);
  };
  ownerWindow.addEventListener("pagehide", dispose);
  ownerWindow.addEventListener("beforeunload", dispose);
  render();
  return {
    element,
    setDisabled(next) {
      if (disposed) return;
      disabled = next;
      const wasEditing = Boolean(draft);
      if (disabled) { open = false; draft = null; draftError = ""; syncOpenListeners(); }
      render();
      if (disabled && wasEditing) options.onEditingChange?.(false);
    },
    setError(message = "") { if (disposed || error === message) return; error = message; render(); },
    setValues(next) {
      if (disposed) return;
      const wasEditing = Boolean(draft);
      entries = normalize(next); open = false; draft = null; draftError = ""; syncOpenListeners(); render();
      if (wasEditing) options.onEditingChange?.(false);
    },
    dispose
  };
}
