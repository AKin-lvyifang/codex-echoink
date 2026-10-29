import type { DiaryCandidate, DiaryItem } from "./types";

/** Stable across reloads; includes length and two independent 32-bit accumulators. */
export function diaryFingerprint(text: string): string {
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const value = text.charCodeAt(i);
    a = Math.imul(a ^ value, 16777619);
    b = Math.imul(b ^ value, 2246822519);
  }
  return `${text.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

export function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "") : "";
}

function withoutAmount(value: string): string {
  return normalizedText(value).replace(/[\d零〇一二两三四五六七八九十百千万点]+/g, "#");
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pairs = (s: string) => {
    const result = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) result.add(s.slice(i, i + 2));
    return result;
  };
  const x = pairs(a);
  const y = pairs(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const key of x) if (y.has(key)) common++;
  return 2 * common / (x.size + y.size);
}

export function sameCandidate(a: DiaryCandidate, b: DiaryCandidate): boolean {
  if (a.type !== b.type || a.quote !== b.quote) return false;
  if (a.type === "todo" && b.type === "todo") {
    return a.text === b.text && (a.dueDate || "") === (b.dueDate || "") && (a.category || "") === (b.category || "");
  }
  if (a.type === "finance" && b.type === "finance") {
    return a.kind === b.kind && a.amountCents === b.amountCents && a.currency === b.currency
      && a.date === b.date && a.category === b.category && a.merchant === b.merchant
      && (a.description || "") === (b.description || "");
  }
  return false;
}

/** Never uses candidate order or journal path as an extraction identity. */
export function matchDiaryItem(candidate: DiaryCandidate, existing: DiaryItem[], used: Set<string>): { item?: DiaryItem; ambiguous: boolean } {
  const scored = existing.filter(item => !used.has(item.id) && item.candidate.type === candidate.type).map(item => {
    const old = item.candidate;
    let score = old.quote === candidate.quote && !!candidate.quote ? 1 : similarity(withoutAmount(old.quote || ""), withoutAmount(candidate.quote || ""));
    if (old.type === "todo" && candidate.type === "todo" && normalizedText(old.text) === normalizedText(candidate.text)) score = Math.max(score, 0.97);
    if (old.type === "finance" && candidate.type === "finance" && old.kind === candidate.kind
      && normalizedText(old.merchant) && normalizedText(old.merchant) === normalizedText(candidate.merchant)
      && old.date === candidate.date) score = Math.max(score, 0.7);
    return { item, score };
  }).filter(value => value.score >= 0.65).sort((a, b) => b.score - a.score);
  if (!scored.length) return { ambiguous: false };
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.06) return { ambiguous: true };
  return { item: scored[0].item, ambiguous: false };
}
