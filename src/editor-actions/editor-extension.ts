import type { Editor } from "obsidian";
import type { Extension } from "@codemirror/state";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorActionCandidate } from "./types";

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
  return [
    editorActionCandidateField,
    Prec.highest(keymap.of([
      {
        key: "Enter",
        run(view) {
          const candidate = view.state.field(editorActionCandidateField, false);
          return candidate ? handlers.confirm(candidate) : false;
        }
      },
      {
        key: "Escape",
        run(view) {
          const candidate = view.state.field(editorActionCandidateField, false);
          return candidate ? handlers.cancel(candidate) : false;
        }
      }
    ]))
  ];
}

export function setEditorActionCandidate(editor: Editor, candidate: EditorActionCandidate | null): boolean {
  const view = editorViewFromEditor(editor);
  if (!view) return false;
  view.dispatch({
    effects: setEditorActionCandidateEffect.of(candidate),
    ...(candidate ? { selection: { anchor: candidate.fromOffset }, scrollIntoView: true } : {})
  });
  const stored = view.state.field(editorActionCandidateField, false);
  return candidate ? stored?.id === candidate.id : !stored;
}

function candidateDecorations(candidate: EditorActionCandidate | null): DecorationSet {
  if (!candidate) return Decoration.none;
  return Decoration.set([
    Decoration.replace({
      widget: new EditorActionCandidateWidget(candidate),
      inclusive: false
    }).range(candidate.fromOffset, candidate.toOffset)
  ]);
}

function editorViewFromEditor(editor: Editor): EditorView | null {
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
    span.title = "Codex 候选文本：Enter 确认，Esc 取消";
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
