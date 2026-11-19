import { diffLines } from "diff";

/**
 * Three-way merge for notes both devices edited: base is the version both started from, mine and theirs are the two
 * edits. Changes to different lines combine; changes to the same lines are a conflict, and the caller keeps mine and
 * writes theirs beside it as a conflict copy. Line-based, like Obsidian Sync's behaviour for Markdown.
 */
export interface MergeHunk { readonly start: number; readonly end: number; readonly lines: readonly string[] }
export type MergeResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly conflicts: number };

const split = (text: string): string[] => text === "" ? [] : text.split("\n");

/** Hunks that replace base[start, end) with `lines`, from a jsdiff line diff. */
export function hunks(base: string, edited: string): MergeHunk[] {
  const out: MergeHunk[] = [];
  let position = 0, pendingStart = -1, pendingEnd = -1, pendingLines: string[] = [];
  const flush = () => { if (pendingStart >= 0) { out.push({ start: pendingStart, end: pendingEnd, lines: pendingLines }); pendingStart = -1; pendingLines = []; } };
  for (const change of diffLines(base, edited)) {
    const lines = change.value.split("\n"); if (lines[lines.length - 1] === "") lines.pop();
    if (change.added) { if (pendingStart < 0) { pendingStart = position; pendingEnd = position; } pendingLines.push(...lines); continue; }
    if (change.removed) { if (pendingStart < 0) { pendingStart = position; pendingEnd = position; } pendingEnd += lines.length; position += lines.length; continue; }
    flush(); position += lines.length;
  }
  flush();
  return out;
}

export function threeWayMerge(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: theirs };
  if (theirs === base) return { ok: true, text: mine };
  const a = hunks(base, mine), b = hunks(base, theirs), baseLines = split(base);
  const overlaps = (x: MergeHunk, y: MergeHunk) => x.start < y.end && y.start < x.end || (x.start === x.end && y.start === y.end && x.start === y.start) || (x.start === y.start && (x.start === x.end || y.start === y.end));
  let conflicts = 0;
  const all: (MergeHunk & { side: "a" | "b" })[] = [...a.map(h => ({ ...h, side: "a" as const })), ...b.map(h => ({ ...h, side: "b" as const }))].sort((x, y) => x.start - y.start || x.end - y.end || (x.side === "a" ? -1 : 1));
  const same = (x: MergeHunk, y: MergeHunk) => x.start === y.start && x.end === y.end && x.lines.length === y.lines.length && x.lines.every((line, i) => line === y.lines[i]);
  const skip = new Set<number>();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].side === all[j].side || !overlaps(all[i], all[j])) continue;
    if (same(all[i], all[j])) { skip.add(j); continue; } // both sides made the identical change
    conflicts++;
  }
  if (conflicts) return { ok: false, conflicts };
  const out: string[] = []; let position = 0;
  for (const [index, hunk] of all.entries()) { if (skip.has(index)) continue; out.push(...baseLines.slice(position, hunk.start), ...hunk.lines); position = Math.max(position, hunk.end); }
  out.push(...baseLines.slice(position));
  return { ok: true, text: out.join("\n") };
}

/** Exclude blank terminal lines while keeping the last content line byte for byte. */
function trailingWhitespaceStart(text: string): number {
  let end = text.length;
  while (end > 0) {
    let lineEnd = end;
    while (lineEnd > 0 && (text[lineEnd - 1] === " " || text[lineEnd - 1] === "\t")) lineEnd--;
    if (lineEnd === 0) return 0;
    const separator = text[lineEnd - 1];
    if (separator !== "\n" && separator !== "\r") break;
    end = lineEnd - 1;
    if (separator === "\n" && text[end - 1] === "\r") end--;
  }
  return end;
}

function canIgnoreTrailingBlankLines(body: string): boolean {
  let openFence = "";
  for (const line of body.split(/\r\n|[\r\n]/u)) {
    const candidate = /^([ \t]*(?:(?:>[ \t]*|(?:[-+*]|\d{1,9}[.)])[ \t]+))*)(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!candidate) continue;
    const [, prefix, marker, info] = candidate;
    const topLevel = /^ {0,3}$/u.test(prefix);
    if (openFence) {
      if (topLevel && marker[0] === openFence[0] && marker.length >= openFence.length && /^[ \t]*$/u.test(info)) openFence = "";
      continue;
    }
    if (marker[0] === "`" && info.includes("`")) continue;
    // An indented or container-prefixed opener may belong to a list or quote.
    if (prefix) return false;
    openFence = marker;
  }
  return !openFence;
}

export function mergeCloudText(base: string | null, mine: string, theirs: string): MergeResult {
  const exact = base === null ? { ok: false as const, conflicts: 1 } : threeWayMerge(base, mine, theirs);
  if (exact.ok) return exact;

  const mineEnd = trailingWhitespaceStart(mine), theirsEnd = trailingWhitespaceStart(theirs);
  const mineBody = mine.slice(0, mineEnd), theirBody = theirs.slice(0, theirsEnd);
  if (base === null) {
    if (mineBody !== theirBody || !canIgnoreTrailingBlankLines(mineBody)) return exact;
  } else {
    const baseBody = base.slice(0, trailingWhitespaceStart(base));
    const mineTailOnly = mineBody === baseBody, theirTailOnly = theirBody === baseBody;
    if ((!mineTailOnly && !theirTailOnly) || !canIgnoreTrailingBlankLines(baseBody)) return exact;
    if (!mineTailOnly) return { ok: true, text: mine };
    if (!theirTailOnly) return { ok: true, text: theirs };
  }

  // The body is identical, and the suffix is ASCII, so lengths and string order match byte order.
  const mineTail = mine.length - mineEnd, theirTail = theirs.length - theirsEnd;
  const preferMine = mineTail < theirTail || (mineTail === theirTail && mine < theirs);
  return { ok: true, text: preferMine ? mine : theirs };
}

/** "笔记 (冲突 iPhone 11-07 14-05).md" beside the original. */
export function conflictCopyPath(path: string, deviceName: string, at: number, sequence = 0): string {
  const dot = path.lastIndexOf("."), slash = path.lastIndexOf("/");
  const stem = dot > slash ? path.slice(0, dot) : path, ext = dot > slash ? path.slice(dot) : "";
  const d = new Date(at), stamp = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
  return `${stem} (冲突 ${deviceName.replace(/[\\/:*?"<>|]/gu, " ").trim() || "设备"} ${stamp}${sequence ? ` ${sequence + 1}` : ""})${ext}`;
}
