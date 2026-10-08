import { Notice } from "obsidian";
import { createOriginButton } from "../settings/origin-controls";
import type { DiaryAlignment, DiaryRange } from "./types";

export function diaryButton(parent: HTMLElement, text: string, action: () => void | Promise<void>, options: { primary?: boolean; disabled?: boolean; label?: string; tertiary?: boolean } = {}): HTMLButtonElement {
  const button = createOriginButton(parent, { text, cls: `echoink-origin-button${options.primary ? " mod-cta" : ""}${options.tertiary ? " is-tertiary" : ""}` });
  button.disabled = options.disabled === true;
  if (options.label) button.setAttribute("aria-label", options.label);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!button.disabled) Promise.resolve().then(action).catch((error) => new Notice(diaryError(error)));
  });
  return button;
}

export function diaryError(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}

export function diaryField(parent: HTMLElement, label: string, value: string, className = ""): HTMLElement {
  const field = parent.createDiv({ cls: `echoink-diary-field ${className}` });
  field.createSpan({ cls: "echoink-diary-field-label", text: label });
  field.createDiv({ cls: "echoink-diary-field-value", text: value || "—" });
  return field;
}

/** Each segment is sliced from the actual text; overlapping mappings are never guessed. */
export function alignmentSegments(text: string, alignments: readonly DiaryAlignment[], side: "source" | "target"): Array<{ text: string; ids: string[]; kind?: DiaryAlignment["kind"] }> {
  const valid = alignments.filter((alignment) => alignment.status === "verified" && alignment[side].length > 0 && alignment[side].every((range) => validRange(text, range)));
  const points = new Set<number>([0, text.length]);
  for (const alignment of valid) for (const range of alignment[side]) { points.add(range.start); points.add(range.end); }
  const sorted = [...points].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1];
    const matches = valid.filter((alignment) => alignment[side].some((range) => range.start <= start && range.end >= end));
    return { text: text.slice(start, end), ids: matches.map((alignment) => alignment.id), kind: matches[0]?.kind };
  });
}

export function hasExactAlignment(alignment: DiaryAlignment, source: string, target: string): boolean {
  return alignment.status === "verified" && alignment.source.length > 0 && alignment.target.length > 0
    && alignment.source.every((range) => validRange(source, range))
    && alignment.target.every((range) => validRange(target, range));
}

function validRange(text: string, range: DiaryRange): boolean {
  return Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= text.length && text.slice(range.start, range.end) === range.text;
}
