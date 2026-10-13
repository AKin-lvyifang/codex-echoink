import { MarkdownView, Notice, TFile, type App } from "obsidian";
import type { SelectionAnnotation } from "../types/selection-annotations";
import type { SettingsLanguage } from "../settings/settings";
import { conversationUiText } from "../ui/codex-view/ui-i18n";
import { resolveSourceSpan, renderedSpanForSource } from "./anchors";
import { resolveProjectedReadingRange, resolveReadingRange } from "./reading";
export async function openSelectionAnnotationSource(app: App, annotation: SelectionAnnotation, language: SettingsLanguage, knownSource?: string): Promise<void> {
  const changed = () => new Notice(conversationUiText(language, "原文位置已变化", "The source position has changed"));
  const file = app.vault.getAbstractFileByPath(annotation.vaultRelativePath);
  if (!(file instanceof TFile)) { new Notice(conversationUiText(language, `找不到笔记：${annotation.fileName}`, `Note not found: ${annotation.fileName}`)); return; }
  await app.workspace.openLinkText(annotation.vaultRelativePath, "", false);
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || view.file?.path !== annotation.vaultRelativePath) return;
  if (annotation.anchor.invalid) { changed(); return; }
  const markdown = view.editor?.getValue() ?? "";
  if (view.getMode() === "source") {
    const span = resolveSourceSpan(markdown, annotation.anchor, knownSource === markdown);
    if (span) { const from = view.editor.offsetToPos(span.from), to = view.editor.offsetToPos(span.to); view.editor.setSelection(from, to); view.editor.scrollIntoView({ from, to }, true); return; }
  } else {
    const root = view.containerEl.querySelector<HTMLElement>(".markdown-preview-section");
    const projected = renderedSpanForSource(markdown, annotation.anchor, knownSource === markdown);
    const range = root ? projected ? resolveProjectedReadingRange(root, projected) : resolveReadingRange(root, annotation.anchor, annotation.selectedText) : null;
    if (range) { range.startContainer.parentElement?.scrollIntoView({ block: "center" }); return; }
  }
  changed();
}
