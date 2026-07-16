import type { Editor } from "obsidian";
import type { Extension } from "@codemirror/state";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorActionCandidate } from "./types";
import { editorActionCandidateReplacementRange } from "./selection";

export const setEditorActionCandidateEffect = StateEffect.define<EditorActionCandidate | null>();

export const editorActionCandidateField = StateField.define<EditorActionCandidate | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    if (transaction.docChanged && next) next = null;
    for (const effect of transaction.effects) {
      if (effect.is(setEditorActionCandidateEffect)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, candidateDecorations)
});

export function createEditorActionExtension(handlers: {
  confirm: (candidate: EditorActionCandidate) => boolean;
  cancel: (candidate: EditorActionCandidate) => boolean;
}): Extension {
  const confirmCandidate = (view: EditorView): boolean => {
    const candidate = view.state.field(editorActionCandidateField, false);
    return candidate ? handlers.confirm(candidate) : false;
  };
  const cancelCandidate = (view: EditorView): boolean => {
    const candidate = view.state.field(editorActionCandidateField, false);
    return candidate ? handlers.cancel(candidate) : false;
  };
  return [
    editorActionCandidateField,
    // Obsidian installs its own Enter handler at a high precedence. Handle the
    // candidate before the shared keymap so Enter cannot insert a newline and
    // invalidate the candidate before our command gets a chance to run.
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
        if (event.key === "Enter") return confirmCandidate(view);
        if (event.key === "Escape") return cancelCandidate(view);
        return false;
      }
    })),
    Prec.highest(keymap.of([
      {
        key: "Enter",
        run: confirmCandidate
      },
      {
        key: "Escape",
        run: cancelCandidate
      }
    ]))
  ];
}

export function setEditorActionCandidate(editor: Editor, candidate: EditorActionCandidate | null): boolean {
  const view = editorViewFromEditor(editor);
  if (!view) return false;
  const range = candidate ? editorActionCandidateReplacementRange(candidate) : null;
  view.dispatch({
    effects: setEditorActionCandidateEffect.of(candidate),
    ...(range ? { selection: { anchor: range.fromOffset }, scrollIntoView: true } : {})
  });
  const stored = view.state.field(editorActionCandidateField, false);
  return candidate ? stored?.id === candidate.id : !stored;
}

function candidateDecorations(candidate: EditorActionCandidate | null): DecorationSet {
  if (!candidate) return Decoration.none;
  const range = editorActionCandidateReplacementRange(candidate);
  const widget = new EditorActionCandidateWidget(candidate);
  if (range.fromOffset === range.toOffset) {
    return Decoration.set([
      Decoration.widget({
        widget,
        side: 1
      }).range(range.fromOffset)
    ]);
  }
  return Decoration.set([
    Decoration.replace({
      widget,
      inclusive: false
    }).range(range.fromOffset, range.toOffset)
  ]);
}

export function editorViewFromEditor(editor: Editor): EditorView | null {
  const view = (editor as any)?.cm;
  return view && typeof view.dispatch === "function" && view.state ? view as EditorView : null;
}

class EditorActionCandidateWidget extends WidgetType {
  constructor(private readonly candidate: EditorActionCandidate) {
    super();
  }

  eq(other: EditorActionCandidateWidget): boolean {
    return other.candidate.id === this.candidate.id && other.candidate.candidateText === this.candidate.candidateText;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "codex-editor-action-candidate";
    span.textContent = this.candidate.candidateText;
    span.title = "Agent 候选文本：Enter 确认，Esc 取消";
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
