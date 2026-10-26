import { cloneSelectionAnnotations, type SelectionAnnotation, type SelectionCapture } from "../types/selection-annotations";

/** Persist every field: edited spans retain ownership, but never regain deletion authority. */
export interface AutoQuestionFragment { annotationId: string; actionKey?: string; from: number; to: number; text: string; intact: boolean }
export interface SelectionDraft { annotations: SelectionAnnotation[]; nextNumber: number; fragments: AutoQuestionFragment[]; text: string }
const drafts = new WeakMap<HTMLTextAreaElement, SelectionDraft>();
const editQuestionActionKey = "edit-annotation-question";
export function emptySelectionDraft(text = ""): SelectionDraft { return { annotations: [], nextNumber: 1, fragments: [], text }; }
export function selectionDraft(input: HTMLTextAreaElement): SelectionDraft {
  let draft = drafts.get(input);
  if (!draft) { draft = emptySelectionDraft(input.value); drafts.set(input, draft); }
  reconcileQuestionFragments(draft, input.value);
  return draft;
}
export function snapshotSelectionDraft(input: HTMLTextAreaElement): SelectionDraft {
  const draft = selectionDraft(input);
  return { ...draft, annotations: cloneSelectionAnnotations(draft.annotations), fragments: draft.fragments.map((fragment) => ({ ...fragment })) };
}
export function restoreSelectionDraft(input: HTMLTextAreaElement, draft: SelectionDraft): void {
  drafts.set(input, { ...draft, annotations: cloneSelectionAnnotations(draft.annotations), fragments: draft.fragments.map((fragment) => ({ ...fragment })) });
  reconcileQuestionFragments(drafts.get(input)!, input.value);
}
export function clearSelectionDraft(input: HTMLTextAreaElement): void { drafts.set(input, emptySelectionDraft(input.value)); }
export function composerSelectionAnnotations(input: HTMLTextAreaElement): SelectionAnnotation[] {
  return cloneSelectionAnnotations(selectionDraft(input).annotations);
}
export function addSelectionAnnotation(input: HTMLTextAreaElement, capture: SelectionCapture, action: { id: string; template: string }, english = false): SelectionAnnotation {
  const draft = selectionDraft(input);
  const identity = (value: SelectionCapture) => JSON.stringify([value.vaultRelativePath, value.anchor.source ? "source" : value.anchor.mode, value.anchor.source?.from ?? value.anchor.from, value.anchor.source?.to ?? value.anchor.to, value.selectedText]);
  const key = identity(capture);
  let annotation = draft.annotations.find((value) => identity(value) === key);
  if (!annotation) {
    const number = Math.max(0, ...draft.annotations.map((value) => value.number)) + 1;
    annotation = { ...capture, anchor: { ...capture.anchor, ...(capture.anchor.source ? { source: { ...capture.anchor.source } } : {}) }, id: `selection-${Date.now()}-${Math.random().toString(36).slice(2)}`, number, appliedActions: [] };
    draft.annotations.push(annotation);
    draft.nextNumber = number + 1;
  }
  const actionKey = JSON.stringify([action.id, action.template]);
  const fragments = draft.fragments.filter((value) => value.annotationId === annotation.id);
  const existing = fragments.find((value) => value.actionKey === actionKey)
    ?? (annotation.appliedActions.includes(actionKey) ? fragments.find((value) => value.actionKey === undefined) : undefined);
  if (existing) focusQuestion(input, existing);
  else {
    if (!annotation.appliedActions.includes(actionKey)) annotation.appliedActions.push(actionKey);
    const fragment = appendQuestion(input, draft, annotation, `${english ? `Annotation ${annotation.number}, ` : `注释${annotation.number}，`}${action.template.trim() ? action.template : ""}`, actionKey);
    input.focus(); input.setSelectionRange(fragment.to, fragment.to);
  }
  return annotation;
}
function appendQuestion(input: HTMLTextAreaElement, draft: SelectionDraft, annotation: SelectionAnnotation, question: string, actionKey: string): AutoQuestionFragment {
  const addition = `${input.value && !input.value.endsWith("\n") ? "\n" : ""}${question}`;
  const fragment = { annotationId: annotation.id, actionKey, from: input.value.length, to: input.value.length + addition.length, text: addition, intact: true };
  input.value += addition; draft.text = input.value; draft.fragments.push(fragment);
  return fragment;
}
function focusQuestion(input: HTMLTextAreaElement, fragment: AutoQuestionFragment): void {
  input.focus(); input.setSelectionRange(fragment.from + (input.value[fragment.from] === "\n" ? 1 : 0), fragment.to);
}
export function editAnnotationQuestion(input: HTMLTextAreaElement, id: string, english = false): void {
  const draft = selectionDraft(input);
  const annotation = draft.annotations.find((value) => value.id === id);
  if (!annotation) return;
  let fragment = draft.fragments.find((value) => value.annotationId === id);
  if (!fragment) {
    fragment = appendQuestion(input, draft, annotation, english ? `Annotation ${annotation.number}, ` : `注释${annotation.number}，`, editQuestionActionKey);
    input.focus(); input.setSelectionRange(fragment.to, fragment.to); return;
  }
  focusQuestion(input, fragment);
}
export function removeSelectionAnnotation(input: HTMLTextAreaElement, id: string): boolean {
  const draft = selectionDraft(input);
  let preserved = false;
  for (const fragment of draft.fragments.filter((value) => value.annotationId === id).sort((a, b) => b.from - a.from)) {
    if (!fragment.intact || input.value.slice(fragment.from, fragment.to) !== fragment.text) { preserved = true; continue; }
    input.value = input.value.slice(0, fragment.from) + input.value.slice(fragment.to);
    for (const other of draft.fragments) if (other.from >= fragment.to) { other.from -= fragment.text.length; other.to -= fragment.text.length; }
  }
  draft.annotations = draft.annotations.filter((value) => value.id !== id);
  draft.nextNumber = Math.max(0, ...draft.annotations.map((value) => value.number)) + 1;
  draft.fragments = draft.fragments.filter((value) => value.annotationId !== id);
  draft.text = input.value;
  return preserved;
}
/** Map owned spans through the actual textarea edit; touched spans lose deletion authority. */
export function reconcileQuestionFragments(draft: SelectionDraft, next: string): void {
  const previous = draft.text;
  if (previous === next) return;
  let from = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from++;
  let oldEnd = previous.length, newEnd = next.length;
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  for (const fragment of draft.fragments) {
    if (from === oldEnd && from === fragment.to && !next.slice(from, newEnd).startsWith("\n")) { fragment.to += delta; fragment.intact = false; }
    else if (from === oldEnd && from === fragment.from && previous[from] !== "\n" && !next.slice(from, newEnd).includes("\n")) { fragment.to += delta; fragment.intact = false; }
    else if (oldEnd <= fragment.from && !(from === oldEnd && from === fragment.to)) { fragment.from += delta; fragment.to += delta; }
    else if (from < fragment.to && oldEnd > fragment.from || from === oldEnd && from > fragment.from && from < fragment.to) {
      fragment.from = fragment.from < from ? fragment.from : from;
      fragment.to = fragment.to >= oldEnd ? fragment.to + delta : newEnd;
      fragment.intact = false;
    }
    if (fragment.intact && next.slice(fragment.from, fragment.to) !== fragment.text) fragment.intact = false;
  }
  draft.fragments = draft.fragments.filter((fragment) => next.slice(fragment.from, fragment.to).replace(/^\n/, "").length > 0);
  draft.text = next;
}
