import { openSelectionAnnotationSource } from "./navigation";
import { attachSourceAnchor, resolveSourceSpan, renderedSpanForSource, mapSelectionSource, mapSourceChangeOnce } from "./anchors";
import { MarkdownView, Notice, Platform } from "obsidian";
import * as Obsidian from "obsidian";
import { ChangeSet, StateEffect, type StateEffectType } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type CodexForObsidianPlugin from "../main";
import type { SelectionAnnotation, SelectionCapture } from "../types/selection-annotations";
import { captureEditorSelection } from "../editor-actions/selection-ask";
import { captureReadingSelection, resolveReadingRange, resolveProjectedReadingRange, readingBodyProjection } from "./reading";
import { createSelectionAskPopover } from "../ui/selection-ask-popover";

class AnnotationNumber extends WidgetType {
  constructor(readonly annotation: SelectionAnnotation, readonly controller: SelectionAskController) { super(); }
  eq(other: AnnotationNumber): boolean { return other.annotation.id === this.annotation.id && other.annotation.number === this.annotation.number; }
  toDOM(view: EditorView): HTMLElement {
    const button = view.dom.ownerDocument.createElement("button"); button.className = "echoink-selection-tag"; button.type = "button";
    button.textContent = String(this.annotation.number); button.setAttribute("aria-label", this.controller.annotationLabel(this.annotation.number));
    button.onclick = () => this.controller.focusAnnotation(); return button;
  }
  ignoreEvent(): boolean { return false; }
}
export class SelectionAskController {
  private readonly documents = new Map<Document, () => void>();
  private readonly editors = new Set<EditorView>();
  private readonly overlays = new Map<Document, HTMLElement>();
  private menu: ReturnType<typeof createSelectionAskPopover> | null = null;
  private menuRange: Range | null = null;
  private menuEditor: EditorView | null = null;
  private paintTimer = 0;
  private lastStatus = "";
  private redrawEffect: StateEffectType<number> | null = null;
  private readonly sourceVersions = new Map<string, string>();
  private readonly initialReadingRanges = new Map<string, { range: Range; root: HTMLElement; rendered: string }>();
  constructor(private readonly plugin: CodexForObsidianPlugin) {}
  register(): void {
    if (Platform.isMobile) return;
    this.redrawEffect = StateEffect.define<number>();
    const createEditorPlugin = (controller: SelectionAskController) => ViewPlugin.fromClass(class {
      decorations: DecorationSet = Decoration.none;
      constructor(readonly view: EditorView) { controller.editors.add(view); this.build(); }
      update(update: ViewUpdate) {
        const path = this.view.state.field(Obsidian.editorInfoField, false)?.file?.path;
        if (update.docChanged && path) {
          for (const annotation of controller.records(true)) {
            if (annotation.vaultRelativePath !== path || annotation.anchor.invalid) continue;
            const previous = update.startState.doc.toString(), next = update.state.doc.toString();
            attachSourceAnchor(previous, annotation.anchor, annotation.selectedText);
            mapSourceChangeOnce(controller.sourceVersions, annotation.id, annotation.anchor, update.changes, previous, next);
          }
          controller.schedulePaint();
        }
        this.build();
      }
      build() {
        const path = this.view.state.field(Obsidian.editorInfoField, false)?.file?.path;
        if (!controller.enabled()) { this.decorations = Decoration.none; return; }
        const markdown = this.view.state.doc.toString();
        const marks = controller.records().filter((annotation) => annotation.vaultRelativePath === path && !annotation.anchor.invalid)
          .flatMap((annotation) => {
            attachSourceAnchor(markdown, annotation.anchor, annotation.selectedText);
            controller.synchronizeSourceVersion(annotation, markdown);
            const span = resolveSourceSpan(markdown, annotation.anchor, controller.sourceVersions.get(annotation.id) === markdown);
            annotation.anchor.unresolved = !span;
            return span ? [Decoration.mark({ class: "echoink-selection-mark" }).range(span.from, span.to), Decoration.widget({ widget: new AnnotationNumber(annotation, controller), side: 1 }).range(span.to)] : [];
          });
        this.decorations = Decoration.set(marks, true);
      }
      destroy() { controller.editors.delete(this.view); }
    }, { decorations: (instance) => instance.decorations });
    this.plugin.registerEditorExtension(createEditorPlugin(this));
    this.plugin.registerMarkdownPostProcessor((element, context) => {
      const section = context.getSectionInfo(element);
      if (section) { element.dataset.echoinkSectionStart = String(section.lineStart); element.dataset.echoinkSectionEnd = String(section.lineEnd); }
      this.schedulePaint();
    });
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => { this.syncDocuments(); this.closeMenu(); this.schedulePaint(); }));
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.closeMenu()));
    this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
      if (!this.enabled() || !info.file || !/\.md$/iu.test(info.file.path)) return;
      const capture = captureEditorSelection(editor, info.file.path, info.file.name);
      if (!capture) return;
      menu.addItem((item) => item.setTitle(this.english() ? "Ask about selection" : "选文提问").setIcon("pencil").onClick(() => { void this.add(capture, this.actions()[0]); }));
    }));
    this.syncDocuments(); this.plugin.register(() => this.dispose());
  }
  private enabled(): boolean { return !Platform.isMobile && this.plugin.settings.selectionAsk?.enabled !== false; }
  private english(): boolean { return this.plugin.settings.settingsLanguage === "en"; }
  private actions() { return (this.plugin.settings.selectionAsk?.actions ?? [{ id: "default", name: "提问", template: "" }]).map((action) => ({ ...action, name: action.id === "default" ? this.english() ? "Ask" : "提问" : action.name })); }
  private records(includeHidden = false): SelectionAnnotation[] { return this.plugin.getCodexView()?.selectionAnnotationRecords(includeHidden) ?? []; }
  private synchronizeSourceVersion(annotation: SelectionAnnotation, markdown: string): void {
    const previous = this.sourceVersions.get(annotation.id);
    if (previous === undefined || previous === markdown || annotation.anchor.invalid) return;
    let from = 0, oldEnd = previous.length, newEnd = markdown.length;
    while (from < oldEnd && from < newEnd && previous[from] === markdown[from]) from++;
    while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === markdown[newEnd - 1]) { oldEnd--; newEnd--; }
    const changes = ChangeSet.of({ from, to: oldEnd, insert: markdown.slice(from, newEnd) }, previous.length);
    mapSelectionSource(annotation.anchor, changes, previous, markdown);
    this.sourceVersions.set(annotation.id, markdown);
  }
  private syncDocuments(): void {
    const current = new Set<Document>([this.plugin.app.workspace.containerEl.ownerDocument]);
    this.plugin.app.workspace.iterateAllLeaves((leaf) => current.add(leaf.view.containerEl.ownerDocument));
    for (const [doc, cleanup] of this.documents) if (!current.has(doc)) { cleanup(); this.documents.delete(doc); this.overlays.get(doc)?.remove(); this.overlays.delete(doc); }
    for (const doc of current) if (!this.documents.has(doc)) {
      let selecting = false, timer: number | undefined;
      const win = doc.defaultView!;
      const inspect = () => { if (timer !== undefined) win.clearTimeout(timer); timer = win.setTimeout(() => { if (!selecting) this.inspectSelection(doc); }, 80); };
      const down = (event: MouseEvent) => { if ((event.target as Element)?.closest?.(".echoink-selection-menu")) return; selecting = true; this.closeMenu(); };
      const up = () => { selecting = false; inspect(); };
      const key = (event: KeyboardEvent) => { if (event.key === "Escape") this.closeMenu(); else if (event.shiftKey || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) inspect(); };
      const scroll = () => { this.repositionMenu(doc); this.schedulePaint(); };
      const blur = () => { if (timer !== undefined) win.clearTimeout(timer); this.closeMenu(); };
      doc.addEventListener("mousedown", down); doc.addEventListener("mouseup", up); doc.addEventListener("selectionchange", inspect); doc.addEventListener("keyup", key);
      doc.addEventListener("scroll", scroll, true); win.addEventListener("resize", scroll); win.addEventListener("blur", blur);
      this.documents.set(doc, () => { if (timer !== undefined) win.clearTimeout(timer); doc.removeEventListener("mousedown", down); doc.removeEventListener("mouseup", up); doc.removeEventListener("selectionchange", inspect); doc.removeEventListener("keyup", key); doc.removeEventListener("scroll", scroll, true); win.removeEventListener("resize", scroll); win.removeEventListener("blur", blur); });
    }
  }
  private inspectSelection(doc: Document): void {
    if (!this.enabled() || !doc.hasFocus() || doc.activeElement?.closest(".echoink-selection-menu")) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { this.closeMenu(); return; }
    let capture: SelectionCapture | null = null, range: Range | null = null, editor: EditorView | null = null;
    for (const view of this.editors) {
      if (view.dom.ownerDocument !== doc || !view.dom.contains(selection.anchorNode)) continue;
      const selected = view.state.selection;
      const file = view.state.field(Obsidian.editorInfoField, false)?.file;
      if (!file || selected.ranges.length !== 1 || selected.main.empty) continue;
      const { from, to } = selected.main, text = view.state.doc.toString();
      capture = { vaultRelativePath: file.path, fileName: file.name, selectedText: text.slice(from, to), anchor: { mode: "editor", from, to, before: text.slice(Math.max(0, from - 48), from), after: text.slice(to, to + 48) } }; editor = view; break;
    }
    if (!capture) for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file || leaf.view.containerEl.ownerDocument !== doc || leaf.view.getMode() !== "preview") continue;
      const root = leaf.view.containerEl.querySelector<HTMLElement>(".markdown-preview-section");
      if (!root) continue;
      const result = captureReadingSelection(root, selection, leaf.view.file.path, leaf.view.file.name);
      if (result) { capture = result.capture; range = result.range; break; }
    }
    if (!capture?.selectedText.trim()) { this.closeMenu(); return; }
    const visible = Array.from((range ?? selection.getRangeAt(0)).getClientRects()).filter((rect) => rect.height > 0 && rect.bottom > 0 && rect.top < doc.defaultView!.innerHeight);
    const rect = visible[0]; if (!rect) { this.closeMenu(); return; }
    this.closeMenu(); this.menuRange = range ?? selection.getRangeAt(0).cloneRange(); this.menuEditor = editor;
    const frozen = { ...capture, anchor: { ...capture.anchor } };
    this.menu = createSelectionAskPopover(doc, rect, this.actions(), (action) => { void this.add(frozen, action); }, () => { editor?.focus(); this.closeMenu(); });
  }
  private repositionMenu(doc: Document): void {
    if (!this.menuRange || this.menuRange.startContainer.ownerDocument !== doc) return;
    const rect = Array.from(this.menuRange.getClientRects()).find((box) => box.height && box.bottom > 0 && box.top < doc.defaultView!.innerHeight);
    if (!rect) this.closeMenu(); else this.menu?.reposition(rect);
  }
  private async add(capture: SelectionCapture, action: { id: string; template: string }): Promise<void> {
    const initialRange = capture.anchor.mode === "reading" ? this.menuRange?.cloneRange() : null;
    const initialRoot = initialRange?.startContainer.parentElement?.closest<HTMLElement>(".markdown-preview-section");
    const initialRendered = initialRoot ? readingBodyProjection(initialRoot).text : "";
    this.closeMenu();
    try {
      let sourceVersion: string | undefined;
      const file = this.plugin.app.vault.getFileByPath(capture.vaultRelativePath);
      if (file) {
        const markdown = await this.plugin.app.vault.cachedRead(file);
        attachSourceAnchor(markdown, capture.anchor, capture.selectedText, initialRoot ? initialRendered : undefined);
        sourceVersion = markdown;
      }
      await this.plugin.activateView();
      const annotation = this.plugin.getCodexView()?.addSelectionAnnotation(capture, action);
      if (annotation) {
        if (sourceVersion !== undefined) this.sourceVersions.set(annotation.id, sourceVersion);
        if (initialRange && initialRoot) this.initialReadingRanges.set(annotation.id, { range: initialRange, root: initialRoot, rendered: initialRendered });
      }
      this.refresh();
    }
    catch (error) { new Notice(error instanceof Error ? error.message : this.english() ? "Could not add selection" : "添加选段失败"); }
  }
  annotationLabel(number: number): string { return this.english() ? `Annotation ${number}` : `注释 ${number}`; }
  focusAnnotation(): void { void this.plugin.activateView({ focusInput: false }).then(() => this.plugin.getCodexView()?.focusSelectionAnnotations()).catch((error) => new Notice(String(error))); }
  refresh(): void {
    if (!this.enabled()) this.closeMenu();
    const ids = new Set(this.records(true).map((annotation) => annotation.id));
    for (const id of this.sourceVersions.keys()) if (!ids.has(id)) this.sourceVersions.delete(id);
    for (const id of this.initialReadingRanges.keys()) if (!ids.has(id)) this.initialReadingRanges.delete(id);
    if (this.redrawEffect) for (const editor of this.editors) editor.dispatch({ effects: this.redrawEffect.of(Date.now()) });
    this.schedulePaint();
  }
  private schedulePaint(): void {
    if (this.paintTimer) return;
    const win = this.plugin.app.workspace.containerEl.ownerDocument.defaultView!;
    this.paintTimer = win.setTimeout(() => { this.paintTimer = 0; this.paintReadingMarks(); }, 30);
  }
  private paintReadingMarks(): void {
    for (const overlay of this.overlays.values()) overlay.replaceChildren();
    if (!this.enabled()) return;
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView) || !leaf.view.file || leaf.view.getMode() !== "preview") continue;
      const root = leaf.view.containerEl.querySelector<HTMLElement>(".markdown-preview-section"), doc = leaf.view.containerEl.ownerDocument;
      if (!root || !root.isConnected || !root.getBoundingClientRect().height) continue;
      let overlay = this.overlays.get(doc);
      if (!overlay) { overlay = doc.createElement("div"); overlay.className = "echoink-selection-overlay"; doc.body.append(overlay); this.overlays.set(doc, overlay); }
      const filePath = leaf.view.file.path;
      const markdown = leaf.view.editor?.getValue();
      for (const annotation of this.records().filter((value) => value.vaultRelativePath === filePath)) {
        if (markdown !== undefined) this.synchronizeSourceVersion(annotation, markdown);
        if (annotation.anchor.invalid) continue;
        const projected = markdown === undefined ? null : renderedSpanForSource(markdown, annotation.anchor, this.sourceVersions.get(annotation.id) === markdown);
        const initial = this.initialReadingRanges.get(annotation.id);
        const precise = initial?.root === root && initial.range.startContainer.isConnected && readingBodyProjection(root).text === initial.rendered && initial.range.toString() === annotation.selectedText ? initial.range : null;
        const range = precise ?? (projected ? resolveProjectedReadingRange(root, projected) : resolveReadingRange(root, annotation.anchor, annotation.selectedText));
        const unresolved = !range;
        annotation.anchor.unresolved = unresolved;
        if (!range) continue;
        const rootBounds = root.getBoundingClientRect();
        const boxes = Array.from(range.getClientRects()).map((box) => ({ left: Math.max(0, rootBounds.left, box.left), right: Math.min(doc.defaultView!.innerWidth, rootBounds.right, box.right), top: Math.max(0, rootBounds.top, box.top), bottom: Math.min(doc.defaultView!.innerHeight, rootBounds.bottom, box.bottom) }))
          .filter((box) => box.right > box.left && box.bottom > box.top).map((box) => ({ ...box, width: box.right - box.left, height: box.bottom - box.top }));
        for (const box of boxes) { const mark = doc.createElement("span"); mark.className = "echoink-selection-mark"; Object.assign(mark.style, { position: "absolute", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }); overlay.append(mark); }
        const last = boxes.at(-1); if (!last) continue;
        const tag = doc.createElement("button"); tag.type = "button"; tag.className = "echoink-selection-tag"; tag.textContent = String(annotation.number); tag.onclick = () => this.focusAnnotation();
        tag.setAttribute("aria-label", this.annotationLabel(annotation.number));
        tag.style.left = `${Math.max(rootBounds.left, Math.min(last.right, rootBounds.right - 18, doc.defaultView!.innerWidth - 24))}px`; tag.style.top = `${last.top}px`; overlay.append(tag);
      }
    }
    const status = JSON.stringify(this.records().map((annotation) => [annotation.id, annotation.anchor.invalid, annotation.anchor.unresolved]));
    if (status !== this.lastStatus) { this.lastStatus = status; this.plugin.getCodexView()?.refreshSelectionAnnotationSummary(); }
  }
  async openSource(annotation: SelectionAnnotation): Promise<void> {
    await openSelectionAnnotationSource(this.plugin.app, annotation, this.plugin.settings.settingsLanguage, this.sourceVersions.get(annotation.id));
  }
  private closeMenu(): void { this.menu?.close(); this.menu = null; this.menuRange = null; this.menuEditor = null; }
  private dispose(): void { this.closeMenu(); for (const cleanup of this.documents.values()) cleanup(); this.documents.clear(); for (const overlay of this.overlays.values()) overlay.remove(); this.overlays.clear(); this.editors.clear(); this.sourceVersions.clear(); this.initialReadingRanges.clear(); if (this.paintTimer) this.plugin.app.workspace.containerEl.ownerDocument.defaultView?.clearTimeout(this.paintTimer); }
}
