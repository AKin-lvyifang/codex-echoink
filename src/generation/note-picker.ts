import { Scope, setIcon, type App } from "obsidian";
import { createOriginButton, createOriginInput, disposeOriginControls } from "../settings/origin-controls";
import { searchNoteMentionCatalog, type NoteMentionCatalogEntry } from "../ui/codex-view/note-mentions";

let pickerId = 0;

/** Reuse @-mention ranking, aliases and pinyin without binding to the Composer draft. */
export function mountGenerationNotePicker(parent: HTMLElement, options: {
  catalog: readonly Readonly<NoteMentionCatalogEntry>[];
  excludedPaths: readonly string[];
  app?: Pick<App, "keymap">;
  scope?: Scope;
  onSelect(path: string): void;
  onClose(): void;
}): () => void {
  const root = parent.createDiv({ cls: "echoink-generation-note-picker" });
  const search = root.createDiv({ cls: "echoink-generation-note-search" });
  setIcon(search.createSpan({ attr: { "aria-hidden": "true" } }), "search");
  const listId = `echoink-generation-notes-${++pickerId}`;
  const input = createOriginInput(search, { attr: { placeholder: "搜索笔记", "aria-label": "搜索笔记", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": listId } });
  const list = root.createDiv({ cls: "echoink-generation-note-results", attr: { id: listId, role: "listbox", "aria-label": "可添加的笔记" } });
  const excluded = new Set(options.excludedPaths);
  const scope = options.app && options.scope ? new Scope(options.scope) : null;
  if (scope) { scope.register(null, "Escape", () => { options.onClose(); return false; }); options.app!.keymap.pushScope(scope); }
  const catalog = options.catalog.filter(item => !excluded.has(item.vaultRelativePath));
  let active = 0;
  let results: readonly Readonly<NoteMentionCatalogEntry>[] = [];
  const select = (index: number) => {
    active = index;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    rows.forEach((row, rowIndex) => { row.toggleClass("is-selected", rowIndex === active); row.setAttr("aria-selected", String(rowIndex === active)); });
    if (rows[active]) { input.setAttr("aria-activedescendant", rows[active].id); rows[active].scrollIntoView({ block: "nearest" }); }
    else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    disposeOriginControls(list); list.empty();
    results = searchNoteMentionCatalog(catalog, input.value);
    results.forEach((entry, index) => {
      const row = createOriginButton(list, { cls: "echoink-generation-note-option", attr: { id: `${listId}-${index}`, role: "option", tabindex: "-1", "aria-selected": "false" } });
      setIcon(row.createSpan({ attr: { "aria-hidden": "true" } }), "file-text");
      const copy = row.createSpan({ cls: "echoink-generation-note-copy" });
      copy.createSpan({ text: entry.fileName.replace(/\.md$/iu, "") });
      copy.createSpan({ cls: "echoink-generation-note-path", text: entry.vaultRelativePath });
      row.onmouseenter = () => select(index);
      row.onmousedown = event => event.preventDefault();
      row.onclick = () => options.onSelect(entry.vaultRelativePath);
    });
    if (!results.length) list.createDiv({ cls: "echoink-generation-empty", text: "没有可添加的笔记" });
    select(0);
  };
  input.oninput = render;
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); options.onClose(); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && results.length) {
      event.preventDefault(); event.stopPropagation();
      select(event.key === "Home" ? 0 : event.key === "End" ? results.length - 1 : (active + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter" && results[active]) { event.preventDefault(); event.stopPropagation(); options.onSelect(results[active].vaultRelativePath); }
  };
  render(); input.focus();
  return () => { if (scope) options.app!.keymap.popScope(scope); disposeOriginControls(root); root.remove(); };
}
