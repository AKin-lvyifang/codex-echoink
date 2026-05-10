import type { EditorPosition } from "obsidian";
import type { EditorActionCandidate, EditorActionSelectionSnapshot, EditorAiActionConfig, EditorAiActionSettings } from "./types";

export interface SelectionValidationInput {
  selectedText: string;
  selectionCount: number;
  maxSelectedChars: number;
}

export type SelectionValidationResult = { ok: true } | { ok: false; reason: string };

export function enabledEditorActionConfigs(settings: EditorAiActionSettings): EditorAiActionConfig[] {
  if (!settings.enabled) return [];
  return settings.actions.filter((action) => action.enabled && action.label.trim() && action.promptTemplate.trim());
}

export function validateEditorActionSelection(input: SelectionValidationInput): SelectionValidationResult {
  if (input.selectionCount !== 1) return { ok: false, reason: "暂不支持多个选区" };
  const selectedText = input.selectedText;
  if (!selectedText || !selectedText.trim()) return { ok: false, reason: "请先选中需要处理的文字" };
  if (selectedText.length > input.maxSelectedChars) return { ok: false, reason: `选中文字超过 ${input.maxSelectedChars} 字，请缩短后再试` };
  return { ok: true };
}

export function buildEditorActionSelectionSnapshot(input: {
  fullText: string;
  fromOffset: number;
  toOffset: number;
  contextCharsBefore: number;
  contextCharsAfter: number;
  filePath: string;
  articleUnderstanding?: string;
  noteSummary?: string;
  from?: EditorPosition;
  to?: EditorPosition;
}): EditorActionSelectionSnapshot {
  const fromOffset = Math.max(0, Math.min(input.fromOffset, input.fullText.length));
  const toOffset = Math.max(fromOffset, Math.min(input.toOffset, input.fullText.length));
  const beforeStart = Math.max(0, fromOffset - Math.max(0, input.contextCharsBefore));
  const afterEnd = Math.min(input.fullText.length, toOffset + Math.max(0, input.contextCharsAfter));
  const fallbackFrom = { line: 0, ch: fromOffset };
  const fallbackTo = { line: 0, ch: toOffset };
  return {
    filePath: input.filePath,
    fileName: fileNameFromPath(input.filePath),
    fromOffset,
    toOffset,
    from: input.from ?? fallbackFrom,
    to: input.to ?? fallbackTo,
    selectedText: input.fullText.slice(fromOffset, toOffset),
    beforeContext: input.fullText.slice(beforeStart, fromOffset),
    afterContext: input.fullText.slice(toOffset, afterEnd),
    articleUnderstanding: input.articleUnderstanding,
    noteSummary: input.noteSummary
  };
}

export function confirmEditorActionCandidate(documentText: string, candidate: EditorActionCandidate): { ok: true; text: string } | { ok: false; reason: string } {
  const current = documentText.slice(candidate.fromOffset, candidate.toOffset);
  if (current !== candidate.originalText) {
    return { ok: false, reason: "原文已变化，请重新选择后再试" };
  }
  const range = editorActionCandidateReplacementRange(candidate);
  return {
    ok: true,
    text: `${documentText.slice(0, range.fromOffset)}${candidate.candidateText}${documentText.slice(range.toOffset)}`
  };
}

export type EditorActionCandidateInvalidationReason = "document-changed" | "original-text-changed";

export function editorActionCandidateReplacementRange(candidate: Pick<EditorActionCandidate, "actionId" | "fromOffset" | "toOffset">): { fromOffset: number; toOffset: number } {
  if (candidate.actionId === "continue") return { fromOffset: candidate.toOffset, toOffset: candidate.toOffset };
  return { fromOffset: candidate.fromOffset, toOffset: candidate.toOffset };
}

export function editorActionCandidateInvalidationReason(documentText: string, candidate: EditorActionCandidate): EditorActionCandidateInvalidationReason | null {
  if (documentText.length !== candidate.documentLength) return "document-changed";
  const current = documentText.slice(candidate.fromOffset, candidate.toOffset);
  return current === candidate.originalText ? null : "original-text-changed";
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || filePath || "当前笔记";
}
