import type { Editor } from "obsidian";
import type { SelectionCapture } from "../types/selection-annotations";
export function captureEditorSelection(editor: Editor, path: string, fileName: string): SelectionCapture | null {
  const selections = editor.listSelections();
  if (selections.length !== 1) return null;
  const { anchor, head } = selections[0];
  const a = editor.posToOffset(anchor), b = editor.posToOffset(head);
  const from = Math.min(a, b), to = Math.max(a, b), text = editor.getValue();
  const selectedText = text.slice(from, to);
  if (!selectedText.trim()) return null;
  return { selectedText, vaultRelativePath: path, fileName, anchor: { mode: "editor", from, to, before: text.slice(Math.max(0, from - 48), from), after: text.slice(to, to + 48) } };
}
