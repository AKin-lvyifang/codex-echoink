/** Plain snapshots only: DOM ranges and editor instances never enter a request. */
export interface SelectionAnchor {
  mode: "editor" | "reading";
  from: number;
  to: number;
  before: string;
  after: string;
  sectionStart?: number;
  sectionEnd?: number;
  source?: { from: number; to: number; text: string; before: string; after: string };
  invalid?: boolean;
  unresolved?: boolean;
}

export interface SelectionCapture {
  selectedText: string;
  vaultRelativePath: string;
  fileName: string;
  anchor: SelectionAnchor;
}

export interface SelectionAnnotation extends SelectionCapture {
  id: string;
  number: number;
  appliedActions: string[];
}

export function cloneSelectionAnnotations(values: readonly SelectionAnnotation[] = []): SelectionAnnotation[] {
  return values.map((value) => ({ ...value, anchor: { ...value.anchor, ...(value.anchor.source ? { source: { ...value.anchor.source } } : {}) }, appliedActions: [...value.appliedActions] }));
}

export function selectionAnnotationsMatch(left: readonly SelectionAnnotation[], right: readonly SelectionAnnotation[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    return candidate?.id === value.id && candidate.number === value.number
      && candidate.selectedText === value.selectedText
      && candidate.vaultRelativePath === value.vaultRelativePath
      && JSON.stringify(candidate.appliedActions) === JSON.stringify(value.appliedActions);
  });
}
