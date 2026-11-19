import { diffChars, diffLines } from "diff";
import { sha256Hex } from "../utils/sha256";

export const MAINTENANCE_EVIDENCE_MAX_QUOTES = 4;
export const MAINTENANCE_EVIDENCE_MAX_CHARS = 400;
export const maintenanceQuoteLength = (text: string): number => Array.from(text).length;
export const MAINTENANCE_EVIDENCE_TOTAL_CHARS = MAINTENANCE_EVIDENCE_MAX_QUOTES * MAINTENANCE_EVIDENCE_MAX_CHARS;
export const MAINTENANCE_COPY_LIMITS = Object.freeze({ sourceMinimum: 400, matchMinimum: 48, continuous: 600, coveredMinimum: 300, coverage: 0.7, crossPageMinimum: 240, crossPageTotal: 800 });
type Span = [number, number];
export interface MaintenanceCopySummary { version: 1; sources: Record<string, { revision: string; spans: Span[] }> }
export class MaintenanceCopyError extends Error {
  constructor() { super("本页复制来源过多，尚未写入。请用自己的话提炼要点，只保留必要的短引用，再提交这一页；不要把原文拆散或重复放入多页。"); this.name = "MaintenanceCopyError"; }
}

/** Compare prose only. Code examples and Markdown decoration are not evidence of wholesale prose copying. */
export function maintenanceCopyProse(content: string): string {
  return content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n")
    .replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, "")
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gmu, "")
    .replace(/`[^`\n]+`/gu, "").replace(/<!--[\s\S]*?-->/gu, "")
    .normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
}

export function maintenanceChangedFragments(before: string | undefined, after: string): string[] {
  if (before === undefined) return [after];
  const lines = diffLines(before, after), fragments: string[] = [];
  for (const [index, part] of lines.entries()) if (part.added) {
    const removed = lines[index - 1];
    // A paragraph replacement can retain a user's long quote on the same line.
    // Count only its actual additions, rather than treating that whole line as new.
    fragments.push(...(removed?.removed ? diffChars(removed.value, part.value).filter(change => change.added).map(change => change.value) : [part.value]));
  }
  return fragments;
}

function mergeSpans(spans: readonly Span[]): Span[] {
  const result: Span[] = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else result.push([start, end]);
  }
  return result;
}
const length = (spans: readonly Span[]) => spans.reduce((sum, [a, b]) => sum + b - a, 0);

function copiedSpans(source: string, fragments: readonly string[]): Span[] {
  const seedSize = 24, stride = 16, seeds = new Map<string, number[]>();
  for (let i = 0; i <= source.length - seedSize; i += stride) {
    const seed = source.slice(i, i + seedSize), positions = seeds.get(seed) ?? [];
    if (positions.length < 8) positions.push(i);
    seeds.set(seed, positions);
  }
  const spans: Span[] = [];
  for (const fragment of fragments) for (let i = 0; i <= fragment.length - seedSize; i++) {
    let furthest = i;
    for (const at of seeds.get(fragment.slice(i, i + seedSize)) ?? []) {
      let left = 0, right = seedSize;
      while (at - left > 0 && i - left > 0 && source[at - left - 1] === fragment[i - left - 1]) left++;
      while (at + right < source.length && i + right < fragment.length && source[at + right] === fragment[i + right]) right++;
      if (left + right >= MAINTENANCE_COPY_LIMITS.matchMinimum) { spans.push([at - left, at + right]); furthest = Math.max(furthest, i + right - 1); }
    }
    i = furthest;
  }
  return mergeSpans(spans);
}

/** Called immediately before each page mutation. Previous summaries contain only spans, never source text. */
export function assertMaintenanceCopyBudget(fragments: readonly string[], sources: readonly { path: string; content: string }[], previous: readonly MaintenanceCopySummary[] = []): MaintenanceCopySummary {
  const prose = fragments.map(maintenanceCopyProse), summary: MaintenanceCopySummary = { version: 1, sources: {} };
  for (const source of sources) {
    const text = maintenanceCopyProse(source.content);
    if (text.length < MAINTENANCE_COPY_LIMITS.sourceMinimum) continue;
    const spans = copiedSpans(text, prose), copied = length(spans), revision = sha256Hex(text), key = sha256Hex(source.path);
    summary.sources[key] = { revision, spans };
    if (spans.some(([a, b]) => b - a >= MAINTENANCE_COPY_LIMITS.continuous)
      || copied >= MAINTENANCE_COPY_LIMITS.coveredMinimum && copied / text.length >= MAINTENANCE_COPY_LIMITS.coverage) throw new MaintenanceCopyError();
    const prior = previous.flatMap(page => page.version === 1 && page.sources[key]?.revision === revision ? [page.sources[key].spans] : []);
    const large = [...prior, spans].filter(page => length(page) >= MAINTENANCE_COPY_LIMITS.crossPageMinimum);
    if (copied >= MAINTENANCE_COPY_LIMITS.crossPageMinimum && large.length > 1 && large.reduce((sum, page) => sum + length(page), 0) >= MAINTENANCE_COPY_LIMITS.crossPageTotal) throw new MaintenanceCopyError();
    const combined = length(mergeSpans([...prior.flat(), ...spans]));
    if (copied && combined >= MAINTENANCE_COPY_LIMITS.coveredMinimum && combined / text.length >= MAINTENANCE_COPY_LIMITS.coverage) throw new MaintenanceCopyError();
  }
  return summary;
}
