import { Menu, Notice, Platform, editorInfoField, editorLivePreviewField, type Editor, type MarkdownFileInfo, type Plugin } from "obsidian";
import { StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { clearGalleryMarkup, observeGalleryMarkup, validateGalleryMarkup } from "./markup";
import { readCompanionTheme } from "../ui/appearance-theme";
import { changeGalleryLayout, galleryAt, groupImages, imagesInSelection, insertGallery, splitGallery, standaloneImages, type GalleryEdit, type ImageSpan } from "./model";

const touchOnly = Platform.isMobileApp || Platform.isMobile;

export const clearGallerySelection = StateEffect.define<void>();
export const toggleGalleryImage = StateEffect.define<ImageSpan>();
export const gallerySelection = StateField.define<readonly ImageSpan[]>({
  create: () => [],
  update(selected, tr) {
    if (tr.docChanged) selected = selected.flatMap(image => {
      const from = tr.changes.mapPos(image.from, 1), to = tr.changes.mapPos(image.to, -1);
      return to > from && tr.state.doc.sliceString(from, to) === image.raw ? [{ ...image, from, to }] : [];
    });
    for (const effect of tr.effects) {
      if (effect.is(clearGallerySelection)) selected = [];
      if (effect.is(toggleGalleryImage) && tr.state.doc.sliceString(effect.value.from, effect.value.to) === effect.value.raw) {
        const found = selected.some(image => image.from === effect.value.from);
        selected = found ? selected.filter(image => image.from !== effect.value.from) : selected.length < 3 ? [...selected, effect.value] : selected;
      }
    }
    return selected;
  }
});
/** One isolated source edit, with no Vault write or attachment operation. */
export function applyGalleryEdit(view: EditorView, expected: string, edit: GalleryEdit): void {
  if (view.state.doc.toString() !== expected) throw new Error("图片内容已变化，请重新选择");
  view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.cursor ?? edit.from }, effects: clearGallerySelection.of(), annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.echoink-gallery")] });
  view.focus();
}
type GalleryHost = Plugin & { settings: { settingsLanguage: string } };
type Action = "insert" | "group" | "split" | "row" | "mosaic";
interface ImageBox { image: ImageSpan; left: number; top: number; width: number; height: number; picked: boolean }

class GalleryEditor {
  readonly overlay: HTMLElement | null;
  private hover: number | null = null;
  private path: string | undefined;
  private imageDocument: EditorView["state"]["doc"] | null = null;
  private images: ImageSpan[] = [];
  private disposed = false;
  private readonly context: (event: MouseEvent) => void;
  private readonly move: (event: MouseEvent) => void;
  private readonly scroll: () => void;
  private readonly leave: () => void;
  constructor(readonly view: EditorView, readonly controller: GalleryController) {
    this.path = this.info()?.file?.path;
    controller.editors.add(this);
    controller.observeDocument(view.dom.ownerDocument);
    this.overlay = touchOnly ? null : view.dom.ownerDocument.createElement("div");
    if (this.overlay) { this.overlay.className = "echoink-gallery-layer"; view.dom.append(this.overlay); }
    this.context = event => this.contextMenu(event);
    this.move = event => {
      if ((event.target as Element)?.closest?.(".echoink-gallery-layer")) return;
      const image = this.imageAt(event.target as Element);
      const next = image?.from ?? null;
      if (this.hover !== next) { this.hover = next; this.paint(); }
    };
    this.scroll = () => this.paint();
    this.leave = () => { this.hover = null; this.paint(); };
    if (!touchOnly) {
      view.dom.addEventListener("contextmenu", this.context, true);
      view.dom.addEventListener("mousemove", this.move);
      view.dom.addEventListener("mouseleave", this.leave);
      view.scrollDOM.addEventListener("scroll", this.scroll, { passive: true });
    }
    this.paint();
  }
  info(): MarkdownFileInfo | undefined { return this.view.state.field(editorInfoField, false); }
  selected(): readonly ImageSpan[] { return this.view.state.field(gallerySelection); }
  enabled(): boolean { return readCompanionTheme(this.view.dom.ownerDocument).gallery; }
  live(): boolean { return !touchOnly && this.info()?.file?.extension === "md" && !!this.view.dom.closest(".markdown-source-view") && this.enabled() && this.view.state.field(editorLivePreviewField, false) === true; }
  clear(): void {
    this.hover = null; this.overlay?.replaceChildren();
    if (this.selected().length) this.view.dispatch({ effects: clearGallerySelection.of() });
  }
  update(update: ViewUpdate): void {
    const path = this.info()?.file?.path;
    if (path !== this.path || !this.live()) {
      this.path = path; this.hover = null; this.overlay?.replaceChildren();
      if (this.selected().length) queueMicrotask(() => { if (!this.disposed) this.clear(); });
    }
    if (update.docChanged) this.hover = null;
    this.paint();
  }
  docViewUpdate(): void {
    if (this.enabled()) validateGalleryMarkup(this.view.contentDOM, true);
    this.paint();
  }
  refresh(): void {
    if (!this.live() || this.view.dom.closest(".markdown-source-view")?.getClientRects().length === 0) this.clear();
    else this.paint();
  }
  private imageAt(target: Element | null): ImageSpan | undefined {
    const embed = target?.closest?.(".image-embed");
    if (!embed || !this.view.contentDOM.contains(embed) || embed.closest('.callout[data-callout="gallery"],.markdown-embed')) return;
    try {
      const position = this.view.posAtDOM(embed), doc = this.view.state.doc;
      const line = doc.lineAt(Math.min(position, doc.length));
      if (this.imageDocument !== doc) { this.imageDocument = doc; this.images = standaloneImages(doc.toString()); }
      const candidates = this.images.filter(image => image.from >= line.from && image.to <= line.to);
      const parent = embed.closest(".cm-line") ?? embed.parentElement;
      const siblings = Array.from(parent?.querySelectorAll(".image-embed") ?? []);
      return candidates[siblings.indexOf(embed)];
    } catch { return; }
  }
  private toggle(image: ImageSpan): void {
    if (!this.live()) return;
    if (this.selected().length >= 3 && !this.selected().some(item => item.from === image.from)) { new Notice("一组最多 3 张"); return; }
    this.view.dispatch({ effects: toggleGalleryImage.of(image) });
  }
  private contextMenu(event: MouseEvent): void {
    if (!this.live()) return;
    const target = event.target as Element;
    const groupNode = target.closest?.('.callout[data-callout="gallery"]');
    if (groupNode && this.view.contentDOM.contains(groupNode)) {
      try {
        const position = this.view.posAtDOM(groupNode), group = galleryAt(this.view.state.doc.toString(), position);
        if (group) this.controller.groupMenu(Menu.forEvent(event), this, group.from);
      } catch { /* Native menu remains available when a widget has no source position. */ }
      return;
    }
    const image = this.imageAt(target); if (!image) return;
    if (!this.selected().length) this.toggle(image);
    if (!this.selected().some(item => item.from === image.from)) return;
    this.controller.selectionMenu(Menu.forEvent(event), this);
  }
  paint(): void {
    if (!this.overlay || this.disposed) return;
    if (!this.live()) { this.overlay.replaceChildren(); return; }
    this.view.requestMeasure({ key: this,
      read: () => {
        const host = this.view.dom.getBoundingClientRect(), viewport = this.view.scrollDOM.getBoundingClientRect(), chosen = this.selected();
        const boxes: ImageBox[] = [];
        for (const element of Array.from(this.view.contentDOM.querySelectorAll<HTMLElement>(".image-embed"))) {
          const image = this.imageAt(element); if (!image) continue;
          const picked = chosen.some(item => item.from === image.from);
          if (!picked && this.hover !== image.from) continue;
          const bounds = (element.querySelector("img") ?? element).getBoundingClientRect();
          if (!bounds.width || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
          boxes.push({ image, left: bounds.left - host.left, top: bounds.top - host.top, width: bounds.width, height: bounds.height, picked });
        }
        return boxes;
      },
      write: boxes => {
        if (this.disposed || !this.live()) return;
        const overlay = this.overlay!; overlay.replaceChildren();
        for (const box of boxes) {
          const mark = overlay.ownerDocument.createElement("div"); mark.className = "echoink-gallery-image-control";
          mark.classList.toggle("is-selected", box.picked);
          Object.assign(mark.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
          const button = mark.createEl("button", { cls: "echoink-gallery-pick", attr: { type: "button" } });
          button.setAttribute("aria-label", box.picked ? "取消选择图片" : "选择图片"); button.setAttribute("aria-pressed", String(box.picked));
          button.textContent = box.picked ? "✓" : "";
          button.addEventListener("mousedown", event => event.preventDefault());
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.toggle(box.image); });
          overlay.append(mark);
        }
        const selected = this.selected();
        if (selected.length >= 2) {
          const bar = overlay.ownerDocument.createElement("div"); bar.className = "echoink-gallery-toolbar"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "图片组操作");
          bar.createSpan({ text: `已选 ${selected.length} 张图片`, attr: { role: "status" } });
          const add = (label: string, run: () => void) => { const button = bar.createEl("button", { text: label, attr: { type: "button" } }); button.addEventListener("mousedown", event => event.preventDefault()); button.addEventListener("click", event => { event.stopPropagation(); run(); }); };
          if (selected.length === 2) add("排成图片组（并排）", () => this.controller.run(this, "group"));
          else { add("排成一大两小", () => this.controller.run(this, "mosaic")); add("排成一排三张", () => this.controller.run(this, "row")); }
          add("取消", () => this.clear()); overlay.append(bar);
        }
      }
    });
  }
  destroy(): void {
    this.disposed = true; this.controller.editors.delete(this); this.overlay?.remove();
    this.view.dom.removeEventListener("contextmenu", this.context, true); this.view.dom.removeEventListener("mousemove", this.move); this.view.dom.removeEventListener("mouseleave", this.leave); this.view.scrollDOM.removeEventListener("scroll", this.scroll);
  }
}
export class GalleryController {
  readonly editors = new Set<GalleryEditor>();
  private readonly menus = new WeakSet<Menu>();
  private readonly documents = new Map<Document, () => void>();
  constructor(private readonly plugin: GalleryHost) {}
  observeDocument(doc: Document): void {
    if (!doc.defaultView?.closed && doc.body && !this.documents.has(doc)) this.documents.set(doc, observeGalleryMarkup(doc.body, () => readCompanionTheme(doc).gallery));
  }
  private syncDocuments(): void {
    const active = new Set<Document>([this.plugin.app.workspace.containerEl.ownerDocument]);
    this.plugin.app.workspace.iterateAllLeaves?.(leaf => active.add(leaf.view.containerEl.ownerDocument));
    for (const editor of this.editors) active.add(editor.view.dom.ownerDocument);
    for (const [doc, dispose] of this.documents) if (!active.has(doc) || doc.defaultView?.closed) { dispose(); this.documents.delete(doc); }
    for (const doc of active) this.observeDocument(doc);
  }
  register(): void {
    this.syncDocuments();
    this.plugin.registerEditorExtension([gallerySelection, ViewPlugin.define(view => new GalleryEditor(view, this), { eventHandlers: { keydown: (event, view) => { if (event.key !== "Escape") return false; const editor = [...this.editors].find(item => item.view === view); if (!editor?.selected().length) return false; editor.clear(); return true; } } })]);
    for (const [id, name, action] of [["insert-gallery", "插入图片组", "insert"], ["group-selected-images", "把选中的图片排成图片组", "group"], ["split-gallery", "拆开图片组", "split"]] as const) {
      this.plugin.addCommand({ id, name, editorCallback: (editor, info) => this.command(editor, info, action) });
    }
    this.plugin.registerMarkdownPostProcessor(element => { if (readCompanionTheme(element.ownerDocument).gallery) validateGalleryMarkup(element); });
    this.plugin.registerEvent(this.plugin.app.workspace.on("css-change", () => {
      for (const editor of this.editors) editor.refresh();
      this.syncDocuments();
      for (const doc of this.documents.keys()) { if (readCompanionTheme(doc).gallery) validateGalleryMarkup(doc.body); else clearGalleryMarkup(doc.body); }
    }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => { this.syncDocuments(); for (const editor of this.editors) editor.refresh(); }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor) => {
      const current = this.find(editor); if (!current?.enabled() || !editor.getSelection()) return;
      this.selectionMenu(menu, current, true);
    }));
    this.plugin.register(() => { for (const dispose of this.documents.values()) dispose(); this.documents.clear(); for (const editor of [...this.editors]) editor.destroy(); });
  }
  private find(editor: Editor): GalleryEditor | undefined { return [...this.editors].find(item => item.info()?.editor === editor); }
  private command(editor: Editor, _info: MarkdownFileInfo, action: Action): void {
    const current = this.find(editor);
    const doc = current?.view.dom.ownerDocument ?? this.plugin.app.workspace.containerEl.ownerDocument;
    if (!readCompanionTheme(doc).gallery) { new Notice("需要配套主题 echoink-theme 才能拼排"); return; }
    if (!current) { new Notice("请先打开笔记编辑器"); return; }
    this.run(current, action);
  }
  run(current: GalleryEditor, action: Action, position?: number, textSelection = false): void {
    try {
      if (!current.enabled()) throw new Error("需要配套主题 echoink-theme 才能拼排");
      const view = current.view, source = view.state.doc.toString(), cursor = position ?? view.state.selection.main.head;
      const range = view.state.selection.main;
      const chosen = !textSelection && current.selected().length ? current.selected() : imagesInSelection(source, range.from, range.to);
      const edit = action === "insert" ? insertGallery(source, cursor) : action === "split" ? splitGallery(source, cursor)
        : (action === "row" || action === "mosaic") && position !== undefined ? changeGalleryLayout(source, cursor, action === "row")
        : groupImages(source, chosen, action === "row");
      applyGalleryEdit(view, source, edit);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  selectionMenu(menu: Menu, current: GalleryEditor, textSelection = false): void {
    const snapshot = current.view.state.doc.toString();
    if (this.menus.has(menu)) return; this.menus.add(menu);
    const range = current.view.state.selection.main;
    const count = textSelection ? imagesInSelection(current.view.state.doc.toString(), range.from, range.to).length : current.selected().length;
    if (!count) return;
    const add = (title: string, action: Action, disabled = false) => menu.addItem(item => item.setSection("echoink-gallery").setTitle(title).setIcon("images").setDisabled(disabled).onClick(() => { if (current.view.state.doc.toString() !== snapshot) { new Notice("图片内容已变化，请重新选择"); return; } this.run(current, action, undefined, textSelection); }));
    if (count < 2) add("排成图片组 · 再选 1 张", "group", true);
    else if (count === 2) add("排成图片组 · 两张并排", "group");
    else if (count === 3) { add("排成图片组 · 一大两小", "mosaic"); add("排成图片组 · 一排三张", "row"); }
    else add("一组最多 3 张", "group", true);
  }
  groupMenu(menu: Menu, current: GalleryEditor, position: number): void {
    const snapshot = current.view.state.doc.toString();
    const run = (action: Action) => { if (current.view.state.doc.toString() !== snapshot) { new Notice("图片内容已变化，请重新选择"); return; } this.run(current, action, position); };
    if (this.menus.has(menu)) return; this.menus.add(menu);
    menu.addItem(item => item.setSection("echoink-gallery").setTitle("拆开图片组").setIcon("ungroup").onClick(() => run("split")));
    const group = galleryAt(current.view.state.doc.toString(), position);
    if (group?.valid && group.images.length === 3) menu.addItem(item => item.setSection("echoink-gallery").setTitle(group.row ? "改为一大两小" : "改为一排三张").setIcon("images").onClick(() => run(group.row ? "mosaic" : "row")));
  }
}
export function registerGalleryFeature(plugin: GalleryHost): void { new GalleryController(plugin).register(); }
