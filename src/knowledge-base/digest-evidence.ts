import * as fsp from "fs/promises";
import * as path from "path";
import { normalizePath } from "obsidian";
import type { KnowledgeBaseProcessedSource } from "../settings/settings";
import { readFreshKnowledgeBaseReportExcerpt } from "./report";
import type { KnowledgeBaseSource } from "./types";

export interface KnowledgeTransactionSnapshot {
  vaultPath: string;
  roots: string[];
  entries: Map<string, KnowledgeTransactionSnapshotEntry>;
}

export interface KnowledgeTransactionSnapshotEntry {
  kind: "file" | "directory" | "symlink" | "special";
  content?: Buffer;
  target?: string;
  nlink?: number;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

export async function verifyDigestEvidence(input: {
  vaultPath: string;
  reportPath: string;
  sources: KnowledgeBaseSource[];
  startedAt: number;
  previousReportMtime?: number | null;
  transactionBefore: KnowledgeTransactionSnapshot | null;
  processedSourcesBeforeRun: Record<string, KnowledgeBaseProcessedSource>;
}): Promise<Record<string, string[]>> {
  await assertFreshMaintenanceReportCoversSources(input.vaultPath, input.reportPath, input.sources, input.startedAt, {
    previousMtimeMs: input.previousReportMtime
  });
  return assertKnowledgeStructureDigestsSources(input.vaultPath, input.transactionBefore, input.sources, {
    processedSourcesBeforeRun: input.processedSourcesBeforeRun
  });
}

async function assertFreshMaintenanceReportCoversSources(
  vaultPath: string,
  reportPath: string,
  sources: KnowledgeBaseSource[],
  startedAt: number,
  options: { previousMtimeMs?: number | null } = {}
): Promise<void> {
  if (!sources.length) return;
  const report = await readFreshKnowledgeBaseReportExcerpt(vaultPath, reportPath, startedAt, {
    previousMtimeMs: options.previousMtimeMs,
    maxChars: 200_000
  });
  if (!report) {
    throw new Error("知识库维护未写出本轮来源证据，已停止提交 tracker。");
  }
  const missing = sources.filter((source) => !maintenanceReportMentionsSource(report, source.relativePath));
  if (missing.length) {
    throw new Error(`知识库维护报告缺少本轮来源证据，已停止提交 tracker：${missing.slice(0, 5).map((source) => source.relativePath).join("，")}`);
  }
}

async function assertKnowledgeStructureDigestsSources(
  vaultPath: string,
  before: KnowledgeTransactionSnapshot | null,
  sources: KnowledgeBaseSource[],
  options: { processedSourcesBeforeRun?: Record<string, KnowledgeBaseProcessedSource> } = {}
): Promise<Record<string, string[]>> {
  if (!sources.length) return {};
  if (!before) {
    throw new Error("知识库维护未写出结构层消化证据，已停止提交 tracker。");
  }
  const current = await snapshotDigestEvidenceTransaction(vaultPath, before.roots);
  const covered = new Set<string>();
  const evidencePaths = new Map<string, Set<string>>();
  const addEvidence = (source: KnowledgeBaseSource, paths: string[]) => {
    if (!paths.length) return;
    covered.add(source.relativePath);
    const bucket = evidencePaths.get(source.relativePath) ?? new Set<string>();
    for (const item of paths) bucket.add(item);
    evidencePaths.set(source.relativePath, bucket);
  };
  for (const source of sources) {
    const previous = options.processedSourcesBeforeRun?.[source.relativePath];
    if (legacyProcessedSourceMatchesCurrent(previous, source)) {
      addEvidence(source, transactionSnapshotExistingSourceEvidencePaths(before, source));
    }
    if (!covered.has(source.relativePath) && processedSourceCanUseRepairableExistingEvidence(previous)) {
      addEvidence(source, transactionSnapshotRepairableExistingSourceEvidencePaths(before, source));
    }
  }
  for (const [relativePath, currentEntry] of current.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (!transactionFileContentChanged(before.entries.get(relativePath), currentEntry)) continue;
    const beforeEntry = before.entries.get(relativePath);
    for (const source of sources) {
      if (transactionFileIntroducesSourceEvidence(beforeEntry, currentEntry, source)) addEvidence(source, [relativePath]);
    }
  }
  const missing = sources.filter((source) => !covered.has(source.relativePath));
  if (missing.length) {
    throw new Error(`知识库维护未写出结构层消化证据，已停止提交 tracker：${missing.slice(0, 5).map((source) => source.relativePath).join("，")}`);
  }
  return Object.fromEntries(Array.from(evidencePaths.entries()).map(([key, value]) => [key, Array.from(value).sort()]));
}

export function isKnowledgeStructureDigestEvidencePath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  if (!(normalized.startsWith("wiki/") || normalized.startsWith("projects/"))) return false;
  return !isKnowledgeIndexEvidencePath(normalized);
}

function isKnowledgeIndexEvidencePath(relativePath: string): boolean {
  const baseName = path.basename(normalizePath(relativePath)).toLowerCase();
  return baseName === "index.md"
    || baseName === "readme.md"
    || baseName === "00-索引.md"
    || baseName === "索引.md";
}

function transactionFileContentChanged(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry
): boolean {
  if (current.kind !== "file" || !current.content) return false;
  if (!before) return true;
  if (before.kind !== "file" || !before.content) return true;
  return !before.content.equals(current.content);
}

export function transactionFileIntroducesSourceEvidence(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry,
  source: KnowledgeBaseSource
): boolean {
  if (current.kind !== "file" || !current.content) return false;
  const currentText = current.content.toString("utf8");
  if (!maintenanceReportMentionsSource(currentText, source.relativePath)) return false;
  const currentLines = normalizedEvidenceLines(currentText);
  const beforeLines = before?.kind === "file" && before.content
    ? normalizedEvidenceLines(before.content.toString("utf8"))
    : [];
  const introducedLines = introducedEvidenceLineFlags(beforeLines, currentLines);
  return sourceEvidenceBlocks(currentLines, introducedLines, source.relativePath)
    .some((block) => (block.hasSource || (block.hasExistingTargetSource && !block.hasOldDigestBeforeNewDigest)) && block.hasDigest)
    || transactionFileIntroducesPageLevelSourceEvidence(currentLines, introducedLines, source.relativePath, beforeLines.length === 0);
}

function legacyProcessedSourceMatchesCurrent(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): boolean {
  if (!previous || previous.fingerprint) return false;
  return previous.size === source.size && Math.round(previous.mtime) === Math.round(source.mtime);
}

function processedSourceCanUseRepairableExistingEvidence(previous: KnowledgeBaseProcessedSource | undefined): boolean {
  return !previous || !previous.fingerprint;
}

export function transactionSnapshotExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): string[] {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (entry.kind !== "file" || !entry.content) continue;
    const lines = normalizedEvidenceLines(entry.content.toString("utf8"));
    if (fileHasSourceMentionAndDigest(lines, source.relativePath)) paths.push(relativePath);
  }
  return paths;
}

export function transactionSnapshotRepairableExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): string[] {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (entry.kind !== "file" || !entry.content) continue;
    if (!transactionEntryIsNotOlderThanSource(entry, source)) continue;
    const lines = normalizedEvidenceLines(entry.content.toString("utf8"));
    if (
      fileHasSinglePageLevelSourceEvidence(lines, source.relativePath)
      || fileHasDatedAggregateSourceEvidence(lines, source.relativePath)
      || fileHasInlineSourceDigestEvidence(lines, source.relativePath)
    ) {
      paths.push(relativePath);
    }
  }
  return paths;
}

function transactionEntryIsNotOlderThanSource(entry: KnowledgeTransactionSnapshotEntry, source: KnowledgeBaseSource): boolean {
  return entry.mtimeMs + 1000 >= source.mtime;
}

function transactionFileIntroducesPageLevelSourceEvidence(
  lines: string[],
  introducedLines: boolean[],
  relativePath: string,
  isNewFile: boolean
): boolean {
  const introducedSourceLineIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => introducedLines[index] && lineMentionsTargetRawSource(line, relativePath))
    .map(({ index }) => index);
  if (!introducedSourceLineIndexes.length) return false;
  if (isNewFile) {
    return introducedSourceLineIndexes.some((index) => isPageLevelSourceLine(lines, index)) && fileHasIntroducedDigest(lines, introducedLines);
  }
  return fileHasIntroducedDatedDigest(lines, introducedLines, relativePath);
}

function fileHasSourceMentionAndDigest(lines: string[], relativePath: string): boolean {
  return lines.some((line) => lineMentionsTargetRawSource(line, relativePath))
    && lines.some((line) => isSubstantiveDigestLine(line));
}

function fileHasSinglePageLevelSourceEvidence(lines: string[], relativePath: string): boolean {
  const sourceIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => isSinglePageLevelSourceLine(lines, index) && lineMentionsTargetRawSource(line, relativePath))
    .map(({ index }) => index);
  if (!sourceIndexes.length) return false;
  const firstSection = lines.findIndex((line) => /^##\s+/.test(line));
  const pageHeaderEnd = firstSection === -1 ? lines.length : firstSection;
  const pageLevelRawMentions = lines.slice(0, pageHeaderEnd).filter((line) => mentionsRawSource(line)).length;
  return pageLevelRawMentions === 1 && fileHasSourceMentionAndDigest(lines, relativePath);
}

function fileHasDatedAggregateSourceEvidence(lines: string[], relativePath: string): boolean {
  const sourceDate = extractKnowledgeSourceDate(relativePath);
  if (!sourceDate) return false;
  const hasSourceInQuotedList = lines.some((line) => /^>\s*[-*+]\s+/.test(line.trim()) && lineMentionsTargetRawSource(line, relativePath));
  if (!hasSourceInQuotedList) return false;
  return lines.some((line, index) => {
    if (!isSubstantiveDigestLine(line)) return false;
    return evidenceTextCoversDate(line, sourceDate) || evidenceTextCoversDate(nearestEvidenceHeading(lines, index), sourceDate);
  });
}

function fileHasInlineSourceDigestEvidence(lines: string[], relativePath: string): boolean {
  return lines.some((line) => isSubstantiveSourceEvidenceLine(line, relativePath));
}

function fileHasIntroducedDigest(lines: string[], introducedLines: boolean[]): boolean {
  return lines.some((line, index) => introducedLines[index] && isSubstantiveDigestLine(line));
}

function fileHasIntroducedDatedDigest(lines: string[], introducedLines: boolean[], relativePath: string): boolean {
  const sourceDate = extractKnowledgeSourceDate(relativePath);
  if (!sourceDate) return false;
  return lines.some((line, index) => {
    if (!introducedLines[index] || !isSubstantiveDigestLine(line)) return false;
    return evidenceTextCoversDate(line, sourceDate) || evidenceTextCoversDate(nearestEvidenceHeading(lines, index), sourceDate);
  });
}

function lineMentionsTargetRawSource(line: string, relativePath: string): boolean {
  return mentionsRawSource(line) && maintenanceReportMentionsSource(line, relativePath);
}

function isPageLevelSourceLine(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  if (!/^>\s*(?:来源[:：]|[-*+]\s+)?/.test(line)) return false;
  const firstSection = lines.findIndex((item) => /^##\s+/.test(item));
  return firstSection === -1 || index < firstSection;
}

function isSinglePageLevelSourceLine(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() ?? "";
  if (!/^>\s*来源[:：]/.test(line)) return false;
  return isPageLevelSourceLine(lines, index);
}

function extractKnowledgeSourceDate(relativePath: string): string | null {
  return relativePath.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] ?? null;
}

function nearestEvidenceHeading(lines: string[], index: number): string {
  for (let current = index; current >= 0; current--) {
    if (/^#{1,6}\s+/.test(lines[current])) return lines[current];
  }
  return "";
}

function evidenceTextCoversDate(text: string, date: string): boolean {
  if (!text) return false;
  if (text.includes(date)) return true;
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) return false;
  for (const match of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\s*(?:至|到|~|-|—|–)\s*(20\d{2}-\d{2}-\d{2})\b/g)) {
    const start = Date.parse(`${match[1]}T00:00:00Z`);
    const end = Date.parse(`${match[2]}T00:00:00Z`);
    if (Number.isFinite(start) && Number.isFinite(end) && target >= Math.min(start, end) && target <= Math.max(start, end)) return true;
  }
  return false;
}

function introducedEvidenceLineFlags(beforeLines: string[], currentLines: string[]): boolean[] {
  if (!currentLines.length) return [];
  if (!beforeLines.length) return currentLines.map(() => true);
  const beforeLength = beforeLines.length;
  const currentLength = currentLines.length;
  const maxDistance = beforeLength + currentLength;
  const trace: Array<Map<number, number>> = [];
  const vector = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= maxDistance; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const goDown = diagonal === -distance
        || (diagonal !== distance && evidenceVectorValue(vector, diagonal - 1) <= evidenceVectorValue(vector, diagonal + 1));
      let beforeIndex = goDown
        ? evidenceVectorValue(vector, diagonal + 1)
        : evidenceVectorValue(vector, diagonal - 1) + 1;
      let currentIndex = beforeIndex - diagonal;
      while (
        beforeIndex < beforeLength
        && currentIndex < currentLength
        && beforeLines[beforeIndex] === currentLines[currentIndex]
      ) {
        beforeIndex++;
        currentIndex++;
      }
      vector.set(diagonal, beforeIndex);
      if (beforeIndex >= beforeLength && currentIndex >= currentLength) {
        trace.push(new Map(vector));
        return reconstructIntroducedEvidenceLineFlags(trace, beforeLength, currentLength);
      }
    }
    trace.push(new Map(vector));
  }
  return currentLines.map(() => true);
}

function evidenceVectorValue(vector: Map<number, number>, diagonal: number): number {
  return vector.get(diagonal) ?? -1;
}

function reconstructIntroducedEvidenceLineFlags(trace: Array<Map<number, number>>, beforeLength: number, currentLength: number): boolean[] {
  const introduced = Array.from({ length: currentLength }, () => true);
  let beforeIndex = beforeLength;
  let currentIndex = currentLength;
  for (let distance = trace.length - 1; distance > 0; distance--) {
    const previousVector = trace[distance - 1];
    const diagonal = beforeIndex - currentIndex;
    const previousDiagonal = diagonal === -distance
      || (diagonal !== distance && evidenceVectorValue(previousVector, diagonal - 1) <= evidenceVectorValue(previousVector, diagonal + 1))
      ? diagonal + 1
      : diagonal - 1;
    const previousBeforeIndex = evidenceVectorValue(previousVector, previousDiagonal);
    const previousCurrentIndex = previousBeforeIndex - previousDiagonal;
    while (beforeIndex > previousBeforeIndex && currentIndex > previousCurrentIndex) {
      beforeIndex--;
      currentIndex--;
      introduced[currentIndex] = false;
    }
    if (currentIndex === previousCurrentIndex) {
      beforeIndex--;
    } else {
      currentIndex--;
    }
  }
  while (beforeIndex > 0 && currentIndex > 0) {
    beforeIndex--;
    currentIndex--;
    introduced[currentIndex] = false;
  }
  return introduced;
}

function normalizedEvidenceLines(text: string): string[] {
  return stripNonBodyEvidenceLines(text.replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim()));
}

function stripNonBodyEvidenceLines(lines: string[]): string[] {
  const stripped = [...lines];
  if (stripped[0] === "---") {
    const frontmatterEnd = stripped.findIndex((line, index) => index > 0 && (line === "---" || line === "..."));
    if (frontmatterEnd > 0) {
      for (let index = 0; index <= frontmatterEnd; index++) stripped[index] = "";
    }
  }
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < stripped.length; index++) {
    const line = stripped[index];
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      stripped[index] = "";
      if (fenceMatch && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length
      };
      stripped[index] = "";
    }
  }
  return stripped;
}

function sourceEvidenceBlocks(lines: string[], introducedLines: boolean[], relativePath: string): Array<{ hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean }> {
  const blocks: Array<{ hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean }> = [];
  let active: { hasSource: boolean; hasDigest: boolean; hasExistingTargetSource: boolean; hasOldDigestBeforeNewDigest: boolean } | null = null;
  for (const [index, line] of lines.entries()) {
    if (isSourceEvidenceBlockBoundary(line)) {
      if (active) blocks.push(active);
      active = null;
      continue;
    }
    const introduced = introducedLines[index] ?? true;
    const mentionsTarget = introduced && maintenanceReportMentionsSource(line, relativePath);
    const mentionsExistingTarget = !introduced && maintenanceReportMentionsSource(line, relativePath) && mentionsRawSource(line);
    const mentionsAnyRaw = introduced && mentionsRawSource(line) || mentionsExistingTarget;
    if (mentionsAnyRaw) {
      if (active) blocks.push(active);
      active = {
        hasSource: mentionsTarget,
        hasDigest: introduced && isSubstantiveSourceEvidenceLine(line, relativePath),
        hasExistingTargetSource: mentionsExistingTarget,
        hasOldDigestBeforeNewDigest: false
      };
      continue;
    }
    if (active && introduced && isSubstantiveDigestLine(line)) {
      active.hasDigest = true;
    } else if (active && !introduced && isSubstantiveDigestLine(line)) {
      active.hasOldDigestBeforeNewDigest = true;
    }
  }
  if (active) blocks.push(active);
  return blocks;
}

function isSourceEvidenceBlockBoundary(line: string): boolean {
  const normalized = line.trim();
  return !normalized
    || /^#{1,6}\s+/.test(normalized)
    || /^---+$/.test(normalized);
}

function isSubstantiveSourceEvidenceLine(line: string, relativePath: string): boolean {
  if (!maintenanceReportMentionsSource(line, relativePath)) return false;
  const withoutSource = stripInlineSourceEvidenceBoilerplate(stripRawSourceMentions(line)
    .replace(/^(本轮)?来源[:：]/, "")
    .replace(/^[-*+]\s+/, "")
    .trim());
  return isSubstantiveDigestLine(withoutSource);
}

function mentionsRawSource(line: string): boolean {
  return /\[\[raw\//i.test(line)
    || /(^|[^A-Za-z0-9_\-.%\u4e00-\u9fff])(?:\/[^\s`)\]）】]+\/)?raw\//i.test(line);
}

function stripRawSourceMentions(line: string): string {
  return line
    .replace(/\[\[raw\/[^\]]+\]\]/gi, "")
    .replace(/\[[^\]]*\]\(\s*<?(?:\.\/|\/)?raw\/[^)\s>]+>?(?:\s+["'][^"']*["'])?\s*\)/gi, "")
    .replace(/`raw\/[^`]+`/gi, "")
    .replace(/(^|[^A-Za-z0-9_\-.%\u4e00-\u9fff])\/[^\s`)\]）】,，;；:：!！?？。]+\/raw\/[^\s`)\]）】,，;；:：!！?？。]+/gi, "$1")
    .replace(/(^|[^A-Za-z0-9_\-./%\u4e00-\u9fff])raw\/[^\s`)\]）】,，;；:：!！?？。]+/gi, "$1");
}

function stripInlineSourceEvidenceBoilerplate(line: string): string {
  return line
    .replace(/本系列页唯一承载/g, "")
    .replace(/本页直接承载/g, "")
    .replace(/唯一承载/g, "")
    .replace(/直接承载/g, "")
    .replace(/本轮来源/g, "")
    .replace(/历史来源/g, "")
    .replace(/来源/g, "")
    .replace(/状态/g, "")
    .trim();
}

function isSubstantiveDigestLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return false;
  if (/^#{1,6}\s+/.test(normalized)) return false;
  if (/^---+$/.test(normalized)) return false;
  if (/^[-*+]\s*\[\[?raw\//i.test(normalized)) return false;
  if (/^[-*+]\s*`?raw\//i.test(normalized)) return false;
  if (/^(本轮)?来源[:：]/.test(normalized)) return false;
  if (mentionsRawSource(normalized)) return false;
  const text = normalized
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/[*_`>#\[\]()（）:：，。,.!！?？\s|\-]/g, "");
  return text.length >= 12 && /[A-Za-z0-9\u4e00-\u9fff]/.test(text);
}

function maintenanceReportMentionsSource(report: string, relativePath: string): boolean {
  const normalizedReport = report.replace(/\\/g, "/");
  return knowledgePathMentionVariants(relativePath)
    .some((variant) => containsKnowledgePathMention(normalizedReport, variant) || containsKnowledgeAbsolutePathSegment(normalizedReport, variant));
}

function knowledgePathMentionVariants(relativePath: string): string[] {
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const withoutExtension = normalizedPath.replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)$/i, "");
  const encodedPath = encodeKnowledgeRelativePath(normalizedPath);
  const encodedWithoutExtension = encodeKnowledgeRelativePath(withoutExtension);
  return uniqueKnowledgePathVariants([
    normalizedPath,
    withoutExtension,
    encodedPath,
    lowercasePercentEscapes(encodedPath),
    encodedWithoutExtension,
    lowercasePercentEscapes(encodedWithoutExtension)
  ]);
}

function uniqueKnowledgePathVariants(paths: string[]): string[] {
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const current of paths) {
    if (!current || seen.has(current)) continue;
    seen.add(current);
    variants.push(current);
  }
  return variants;
}

function encodeKnowledgeRelativePath(relativePath: string): string {
  return relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function lowercasePercentEscapes(relativePath: string): string {
  return relativePath.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

function containsKnowledgePathMention(text: string, relativePath: string): boolean {
  if (!relativePath) return false;
  let start = text.indexOf(relativePath);
  while (start !== -1) {
    const before = start > 0 ? text[start - 1] : "";
    const beforePrevious = start > 1 ? text[start - 2] : "";
    const afterIndex = start + relativePath.length;
    const after = text[afterIndex] ?? "";
    const afterNext = text[afterIndex + 1] ?? "";
    if (isKnowledgePathBoundaryBefore(before, beforePrevious) && isKnowledgePathBoundaryAfter(after, afterNext)) return true;
    start = text.indexOf(relativePath, start + 1);
  }
  return false;
}

function containsKnowledgeAbsolutePathSegment(text: string, relativePath: string): boolean {
  const absoluteSegment = `/${relativePath}`;
  let start = text.indexOf(absoluteSegment);
  while (start !== -1) {
    const afterIndex = start + absoluteSegment.length;
    const after = text[afterIndex] ?? "";
    const afterNext = text[afterIndex + 1] ?? "";
    if (isKnowledgePathBoundaryAfter(after, afterNext)) return true;
    start = text.indexOf(absoluteSegment, start + 1);
  }
  return false;
}

function isKnowledgePathBoundaryBefore(char: string, previousChar = ""): boolean {
  if (char === "/") return !previousChar || !/[A-Za-z0-9_\-.%\u4e00-\u9fff]/.test(previousChar);
  return !char || !/[A-Za-z0-9_\-./%\u4e00-\u9fff]/.test(char);
}

function isKnowledgePathBoundaryAfter(char: string, nextChar = ""): boolean {
  if (!char) return true;
  if (char === ".") {
    return !nextChar || /[\s\])}）】』」》,，;；:：!！?？]/.test(nextChar);
  }
  return !/[A-Za-z0-9_\-./%\u4e00-\u9fff]/.test(char);
}

async function snapshotDigestEvidenceTransaction(vaultPath: string, roots: string[]): Promise<KnowledgeTransactionSnapshot> {
  const entries: KnowledgeTransactionSnapshot["entries"] = new Map();
  for (const root of roots) {
    const absolute = path.join(vaultPath, root);
    const paths = await walkExistingDigestEvidenceEntries(absolute);
    for (const entryPath of paths) {
      const relativePath = normalizePath(path.relative(vaultPath, entryPath));
      const stat = await fsp.lstat(entryPath);
      if (stat.isDirectory()) {
        entries.set(relativePath, {
          kind: "directory",
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else if (stat.isSymbolicLink()) {
        entries.set(relativePath, {
          kind: "symlink",
          target: await fsp.readlink(entryPath),
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else if (stat.isFile()) {
        entries.set(relativePath, {
          kind: "file",
          content: await fsp.readFile(entryPath),
          nlink: stat.nlink,
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      } else {
        entries.set(relativePath, {
          kind: "special",
          mode: stat.mode,
          atimeMs: stat.atimeMs,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  }
  return { vaultPath, roots: roots.map((root) => normalizePath(root)), entries };
}

async function walkExistingDigestEvidenceEntries(rootPath: string): Promise<string[]> {
  const stat = await fsp.lstat(rootPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory()) return [rootPath];
  const result = [rootPath];
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    result.push(...await walkExistingDigestEvidenceEntries(path.join(rootPath, entry.name)));
  }
  return result;
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
