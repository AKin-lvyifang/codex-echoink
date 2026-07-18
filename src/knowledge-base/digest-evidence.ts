import * as path from "path";
import { normalizePath } from "obsidian";
import type { KnowledgeBaseProcessedSource } from "../settings/settings";
import { readFreshKnowledgeBaseReportExcerpt } from "./report";
import type { KnowledgeBaseSource } from "./types";
import {
  disposeKnowledgeTransactionSnapshot,
  readKnowledgeTransactionEntryContent,
  snapshotKnowledgeTransactionEntries,
  type KnowledgeTransactionSnapshot,
  type KnowledgeTransactionSnapshotEntry
} from "./transaction-snapshot-core";

export type { KnowledgeTransactionSnapshot, KnowledgeTransactionSnapshotEntry } from "./transaction-snapshot-core";

const DIGEST_EVIDENCE_DIFF_LINE_LIMIT = 5000;

export interface DigestEvidenceVerificationInput {
  vaultPath: string;
  reportPath: string;
  sources: KnowledgeBaseSource[];
  startedAt: number;
  previousReportMtime?: number | null;
  transactionBefore: KnowledgeTransactionSnapshot | null;
  processedSourcesBeforeRun: Record<string, KnowledgeBaseProcessedSource>;
}

export type DigestEvidencePendingReasonCode =
  | "maintenance-report-missing"
  | "maintenance-report-source-missing"
  | "transaction-snapshot-missing"
  | "structure-evidence-missing"
  | "shared-target-dependency";

export interface DigestEvidencePendingReason {
  code: DigestEvidencePendingReasonCode;
  message: string;
  relatedSources?: string[];
  targetPaths?: string[];
}

export interface DigestEvidencePendingSource {
  source: KnowledgeBaseSource;
  reason: DigestEvidencePendingReason;
}

export type DigestEvidenceGlobalIssueCode =
  | "maintenance-report-missing"
  | "transaction-snapshot-missing";

export interface DigestEvidenceGlobalIssue {
  code: DigestEvidenceGlobalIssueCode;
  message: string;
}

export interface DigestEvidenceVerificationResult {
  verifiedSources: KnowledgeBaseSource[];
  /**
   * Only contains sources that are safe to commit. Evidence discovered for a
   * deferred dependency group is deliberately withheld from this map.
   */
  evidencePaths: Record<string, string[]>;
  pendingSources: DigestEvidencePendingSource[];
  globalIssue?: DigestEvidenceGlobalIssue;
}

interface MaintenanceReportCoverage {
  available: boolean;
  coveredSources: Set<string>;
}

interface KnowledgeStructureDigestEvidence {
  available: boolean;
  evidencePaths: Record<string, string[]>;
  changedTargetPaths: Map<string, Set<string>>;
}

/**
 * Evaluates digest evidence per source. Unlike the legacy verifier this API
 * returns recoverable source-level failures, while keeping sources that share
 * a changed target file in one atomic dependency group.
 */
export async function evaluateDigestEvidence(input: DigestEvidenceVerificationInput): Promise<DigestEvidenceVerificationResult> {
  if (!input.sources.length) {
    return {
      verifiedSources: [],
      evidencePaths: {},
      pendingSources: []
    };
  }

  const reportCoverage = await inspectFreshMaintenanceReportCoverage(
    input.vaultPath,
    input.reportPath,
    input.sources,
    input.startedAt,
    { previousMtimeMs: input.previousReportMtime }
  );
  if (!reportCoverage.available || reportCoverage.coveredSources.size === 0) {
    const code: DigestEvidencePendingReasonCode = reportCoverage.available
      ? "maintenance-report-source-missing"
      : "maintenance-report-missing";
    return {
      verifiedSources: [],
      evidencePaths: {},
      pendingSources: input.sources.map((source) => ({
        source,
        reason: {
          code,
          message: reportCoverage.available
            ? `知识库维护报告缺少本轮来源证据：${source.relativePath}`
            : "知识库维护未写出本轮来源证据。"
        }
      })),
      ...(!reportCoverage.available ? {
        globalIssue: {
          code: "maintenance-report-missing" as const,
          message: "知识库维护未写出本轮来源证据，无法执行逐来源提交。"
        }
      } : {})
    };
  }
  if (!input.transactionBefore) {
    return {
      verifiedSources: [],
      evidencePaths: {},
      pendingSources: input.sources.map((source) => {
        if (!reportCoverage.coveredSources.has(source.relativePath)) {
          return {
            source,
            reason: {
              code: "maintenance-report-source-missing" as const,
              message: `知识库维护报告缺少本轮来源证据：${source.relativePath}`
            }
          };
        }
        return {
          source,
          reason: {
            code: "transaction-snapshot-missing" as const,
            message: "知识库维护缺少结构层事务快照，无法验证消化证据。"
          }
        };
      }),
      globalIssue: {
        code: "transaction-snapshot-missing",
        message: "知识库维护缺少结构层事务快照，无法执行安全的逐来源提交。"
      }
    };
  }
  const structureEvidence = await collectKnowledgeStructureDigestEvidence(
    input.vaultPath,
    input.transactionBefore,
    input.sources,
    { processedSourcesBeforeRun: input.processedSourcesBeforeRun }
  );
  const pendingReasons = new Map<string, DigestEvidencePendingReason>();
  for (const source of input.sources) {
    if (!reportCoverage.available) {
      pendingReasons.set(source.relativePath, {
        code: "maintenance-report-missing",
        message: "知识库维护未写出本轮来源证据。"
      });
      continue;
    }
    if (!reportCoverage.coveredSources.has(source.relativePath)) {
      pendingReasons.set(source.relativePath, {
        code: "maintenance-report-source-missing",
        message: `知识库维护报告缺少本轮来源证据：${source.relativePath}`,
        targetPaths: sortedSetValues(structureEvidence.changedTargetPaths.get(source.relativePath))
      });
      continue;
    }
    if (!structureEvidence.available) {
      pendingReasons.set(source.relativePath, {
        code: "transaction-snapshot-missing",
        message: "知识库维护缺少结构层事务快照，无法验证消化证据。"
      });
      continue;
    }
    if (!(structureEvidence.evidencePaths[source.relativePath]?.length)) {
      pendingReasons.set(source.relativePath, {
        code: "structure-evidence-missing",
        message: `知识库维护未写出结构层消化证据：${source.relativePath}`,
        targetPaths: sortedSetValues(structureEvidence.changedTargetPaths.get(source.relativePath))
      });
    }
  }

  deferSharedTargetDependencyGroups(
    input.sources,
    structureEvidence.evidencePaths,
    structureEvidence.changedTargetPaths,
    pendingReasons
  );

  const verifiedSources = input.sources.filter((source) => !pendingReasons.has(source.relativePath));
  const evidencePaths = Object.fromEntries(verifiedSources.map((source) => [
    source.relativePath,
    structureEvidence.evidencePaths[source.relativePath] ?? []
  ]));
  const pendingSources = input.sources
    .filter((source) => pendingReasons.has(source.relativePath))
    .map((source) => ({
      source,
      reason: pendingReasons.get(source.relativePath)!
    }));
  return {
    verifiedSources,
    evidencePaths,
    pendingSources
  };
}

/**
 * Compatibility wrapper for existing all-or-nothing callers.
 */
export async function verifyDigestEvidence(input: DigestEvidenceVerificationInput): Promise<Record<string, string[]>> {
  if (!input.sources.length) return {};
  const reportCoverage = await inspectFreshMaintenanceReportCoverage(
    input.vaultPath,
    input.reportPath,
    input.sources,
    input.startedAt,
    { previousMtimeMs: input.previousReportMtime }
  );
  if (!reportCoverage.available) {
    throw new Error("知识库维护未写出本轮来源证据，已停止提交 tracker。");
  }
  const missingReportSources = input.sources
    .filter((source) => !reportCoverage.coveredSources.has(source.relativePath))
    .map((source) => source.relativePath);
  if (missingReportSources.length) {
    throw new Error(`知识库维护报告缺少本轮来源证据，已停止提交 tracker：${missingReportSources.slice(0, 5).join("，")}`);
  }
  const structureEvidence = await collectKnowledgeStructureDigestEvidence(
    input.vaultPath,
    input.transactionBefore,
    input.sources,
    { processedSourcesBeforeRun: input.processedSourcesBeforeRun }
  );
  if (!structureEvidence.available) {
    throw new Error("知识库维护未写出结构层消化证据，已停止提交 tracker。");
  }
  const missingStructureSources = input.sources
    .filter((source) => !(structureEvidence.evidencePaths[source.relativePath]?.length))
    .map((source) => source.relativePath);
  if (missingStructureSources.length) {
    throw new Error(`知识库维护未写出结构层消化证据，已停止提交 tracker：${missingStructureSources.slice(0, 5).join("，")}`);
  }
  return structureEvidence.evidencePaths;
}

async function inspectFreshMaintenanceReportCoverage(
  vaultPath: string,
  reportPath: string,
  sources: KnowledgeBaseSource[],
  startedAt: number,
  options: { previousMtimeMs?: number | null } = {}
): Promise<MaintenanceReportCoverage> {
  if (!sources.length) return { available: true, coveredSources: new Set() };
  const report = await readFreshKnowledgeBaseReportExcerpt(vaultPath, reportPath, startedAt, {
    previousMtimeMs: options.previousMtimeMs,
    maxChars: 200_000
  });
  if (!report) return { available: false, coveredSources: new Set() };
  return {
    available: true,
    coveredSources: new Set(sources
      .filter((source) => maintenanceReportMentionsSource(report, source.relativePath))
      .map((source) => source.relativePath))
  };
}

async function collectKnowledgeStructureDigestEvidence(
  vaultPath: string,
  before: KnowledgeTransactionSnapshot | null,
  sources: KnowledgeBaseSource[],
  options: { processedSourcesBeforeRun?: Record<string, KnowledgeBaseProcessedSource> } = {}
): Promise<KnowledgeStructureDigestEvidence> {
  if (!sources.length) {
    return {
      available: true,
      evidencePaths: {},
      changedTargetPaths: new Map()
    };
  }
  if (!before) {
    return {
      available: false,
      evidencePaths: {},
      changedTargetPaths: new Map()
    };
  }
  const current = await snapshotDigestEvidenceTransaction(vaultPath, before.roots);
  try {
    const covered = new Set<string>();
    const evidencePaths = new Map<string, Set<string>>();
    const changedTargetPaths = new Map<string, Set<string>>();
    const addEvidence = (source: KnowledgeBaseSource, paths: string[]) => {
      if (!paths.length) return;
      covered.add(source.relativePath);
      const bucket = evidencePaths.get(source.relativePath) ?? new Set<string>();
      for (const item of paths) bucket.add(item);
      evidencePaths.set(source.relativePath, bucket);
    };
    const addChangedTarget = (source: KnowledgeBaseSource, targetPath: string) => {
      const bucket = changedTargetPaths.get(source.relativePath) ?? new Set<string>();
      bucket.add(targetPath);
      changedTargetPaths.set(source.relativePath, bucket);
    };
    for (const source of sources) {
      const previous = options.processedSourcesBeforeRun?.[source.relativePath];
      if (legacyProcessedSourceMatchesCurrent(previous, source)) {
        const beforePaths = await transactionSnapshotExistingSourceEvidencePaths(before, source);
        const currentPaths = await transactionSnapshotExistingSourceEvidencePathsAmong(current, source, beforePaths);
        addEvidence(source, intersectEvidencePaths(beforePaths, currentPaths));
        for (const removedPath of subtractEvidencePaths(beforePaths, currentPaths)) {
          if (transactionFileContentChanged(before.entries.get(removedPath), current.entries.get(removedPath))) {
            addChangedTarget(source, removedPath);
          }
        }
      }
      if (!covered.has(source.relativePath) && processedSourceCanUseRepairableExistingEvidence(previous)) {
        const beforePaths = await transactionSnapshotRepairableExistingSourceEvidencePaths(before, source);
        const currentPaths = await transactionSnapshotRepairableExistingSourceEvidencePathsAmong(current, source, beforePaths);
        addEvidence(source, intersectEvidencePaths(beforePaths, currentPaths));
        for (const removedPath of subtractEvidencePaths(beforePaths, currentPaths)) {
          if (transactionFileContentChanged(before.entries.get(removedPath), current.entries.get(removedPath))) {
            addChangedTarget(source, removedPath);
          }
        }
      }
    }
    const transactionPaths = new Set([...before.entries.keys(), ...current.entries.keys()]);
    for (const relativePath of transactionPaths) {
      if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
      const beforeEntry = before.entries.get(relativePath);
      const currentEntry = current.entries.get(relativePath);
      if (!transactionFileContentChanged(beforeEntry, currentEntry)) continue;
      for (const source of sources) {
        const assessment = await assessTransactionFileSourceChange(beforeEntry, currentEntry, source);
        if (assessment.participates) addChangedTarget(source, relativePath);
        if (assessment.introducesEvidence) addEvidence(source, [relativePath]);
      }
    }
    return {
      available: true,
      evidencePaths: Object.fromEntries(Array.from(evidencePaths.entries()).map(([key, value]) => [key, sortedSetValues(value)])),
      changedTargetPaths
    };
  } finally {
    await disposeKnowledgeTransactionSnapshot(current);
  }
}

function intersectEvidencePaths(beforePaths: string[], currentPaths: string[]): string[] {
  const current = new Set(currentPaths);
  return beforePaths.filter((item) => current.has(item));
}

function subtractEvidencePaths(beforePaths: string[], currentPaths: string[]): string[] {
  const current = new Set(currentPaths);
  return beforePaths.filter((item) => !current.has(item));
}

function deferSharedTargetDependencyGroups(
  sources: KnowledgeBaseSource[],
  evidencePaths: Record<string, string[]>,
  changedTargetPaths: Map<string, Set<string>>,
  pendingReasons: Map<string, DigestEvidencePendingReason>
): void {
  const sourcesByPath = new Map(sources.map((source) => [source.relativePath, source]));
  const changedTargets = new Set<string>();
  for (const targets of changedTargetPaths.values()) {
    for (const targetPath of targets) changedTargets.add(targetPath);
  }
  const dependencyTargetsBySource = new Map<string, Set<string>>();
  for (const source of sources) {
    const targets = new Set(changedTargetPaths.get(source.relativePath) ?? []);
    // A verified source can rely on evidence that already existed before this
    // run. If that same file now contains a pending source's changed block, the
    // file is still one atomic commit unit even though the verified source's
    // own block did not change. Include only verified evidence owners here:
    // an unchanged historical reference that is independently pending must not
    // block an otherwise safe current change.
    if (!pendingReasons.has(source.relativePath)) {
      for (const targetPath of evidencePaths[source.relativePath] ?? []) {
        if (changedTargets.has(targetPath)) targets.add(targetPath);
      }
    }
    if (targets.size) dependencyTargetsBySource.set(source.relativePath, targets);
  }
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const [sourcePath, targets] of dependencyTargetsBySource) {
    if (!sourcesByPath.has(sourcePath)) continue;
    for (const targetPath of targets) {
      const bucket = sourcesByTarget.get(targetPath) ?? new Set<string>();
      bucket.add(sourcePath);
      sourcesByTarget.set(targetPath, bucket);
    }
  }

  const visited = new Set<string>();
  for (const source of sources) {
    if (visited.has(source.relativePath)) continue;
    const componentSources = new Set<string>();
    const componentTargets = new Set<string>();
    const queue = [source.relativePath];
    while (queue.length) {
      const sourcePath = queue.shift()!;
      if (componentSources.has(sourcePath)) continue;
      componentSources.add(sourcePath);
      visited.add(sourcePath);
      for (const targetPath of dependencyTargetsBySource.get(sourcePath) ?? []) {
        componentTargets.add(targetPath);
        for (const relatedSource of sourcesByTarget.get(targetPath) ?? []) {
          if (!componentSources.has(relatedSource)) queue.push(relatedSource);
        }
      }
    }
    if (componentSources.size < 2) continue;
    const blockingSources = Array.from(componentSources)
      .filter((sourcePath) => pendingReasons.has(sourcePath))
      .sort();
    if (!blockingSources.length) continue;
    const targetPaths = sortedSetValues(componentTargets);
    for (const sourcePath of componentSources) {
      if (pendingReasons.has(sourcePath)) continue;
      pendingReasons.set(sourcePath, {
        code: "shared-target-dependency",
        message: `来源与未验证来源共用本轮知识目标文件，依赖组已整体延期：${sourcePath}`,
        relatedSources: blockingSources,
        targetPaths
      });
    }
  }
}

function sortedSetValues(values: Set<string> | undefined): string[] {
  return values ? Array.from(values).sort() : [];
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
  current: KnowledgeTransactionSnapshotEntry | undefined
): boolean {
  if (!current) return before?.kind === "file";
  if (current.kind !== "file") return before?.kind === "file";
  if (!before) return true;
  if (before.kind !== "file") return true;
  if (typeof before.size === "number" && typeof current.size === "number" && before.size !== current.size) return true;
  if (before.contentHash && current.contentHash) return before.contentHash !== current.contentHash;
  return Math.round(before.mtimeMs) !== Math.round(current.mtimeMs);
}

interface TransactionFileSourceChangeAssessment {
  introducesEvidence: boolean;
  participates: boolean;
}

export async function transactionFileIntroducesSourceEvidence(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry,
  source: KnowledgeBaseSource
): Promise<boolean> {
  return (await assessTransactionFileSourceChange(before, current, source)).introducesEvidence;
}

async function assessTransactionFileSourceChange(
  before: KnowledgeTransactionSnapshotEntry | undefined,
  current: KnowledgeTransactionSnapshotEntry | undefined,
  source: KnowledgeBaseSource
): Promise<TransactionFileSourceChangeAssessment> {
  const currentContent = await readKnowledgeTransactionEntryContent(current);
  const beforeContent = await readKnowledgeTransactionEntryContent(before);
  const currentText = currentContent?.toString("utf8") ?? "";
  const beforeText = beforeContent?.toString("utf8") ?? "";
  const currentLines = normalizedEvidenceLines(currentText);
  const beforeLines = beforeContent
    ? normalizedEvidenceLines(beforeText)
    : [];
  const introducedLines = introducedEvidenceLineFlags(beforeLines, currentLines);
  const introducesEvidence = Boolean(currentContent)
    && maintenanceReportMentionsSource(currentText, source.relativePath)
    && (sourceEvidenceBlocks(currentLines, introducedLines, source.relativePath)
    .some((block) => (block.hasSource || (block.hasExistingTargetSource && !block.hasOldDigestBeforeNewDigest)) && block.hasDigest)
    || transactionFileIntroducesPageLevelSourceEvidence(currentLines, introducedLines, source.relativePath, beforeLines.length === 0));
  const beforeContexts = sourceEvidenceChangeContexts(beforeLines, source.relativePath);
  const currentContexts = sourceEvidenceChangeContexts(currentLines, source.relativePath);
  return {
    introducesEvidence,
    participates: introducesEvidence || !stringArraysEqual(beforeContexts, currentContexts)
  };
}

function legacyProcessedSourceMatchesCurrent(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): boolean {
  if (!previous || previous.fingerprint) return false;
  return previous.size === source.size && Math.round(previous.mtime) === Math.round(source.mtime);
}

function processedSourceCanUseRepairableExistingEvidence(previous: KnowledgeBaseProcessedSource | undefined): boolean {
  return !previous || !previous.fingerprint;
}

export async function transactionSnapshotExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): Promise<string[]> {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (await transactionEntryHasExistingSourceEvidence(entry, source)) paths.push(relativePath);
  }
  return paths;
}

async function transactionSnapshotExistingSourceEvidencePathsAmong(
  snapshot: KnowledgeTransactionSnapshot,
  source: KnowledgeBaseSource,
  candidatePaths: string[]
): Promise<string[]> {
  const paths: string[] = [];
  for (const relativePath of candidatePaths) {
    const entry = snapshot.entries.get(relativePath);
    if (entry && await transactionEntryHasExistingSourceEvidence(entry, source)) paths.push(relativePath);
  }
  return paths;
}

async function transactionEntryHasExistingSourceEvidence(
  entry: KnowledgeTransactionSnapshotEntry,
  source: KnowledgeBaseSource
): Promise<boolean> {
  const content = await readKnowledgeTransactionEntryContent(entry);
  if (!content) return false;
  return fileHasSourceMentionAndDigest(normalizedEvidenceLines(content.toString("utf8")), source.relativePath);
}

export async function transactionSnapshotRepairableExistingSourceEvidencePaths(snapshot: KnowledgeTransactionSnapshot, source: KnowledgeBaseSource): Promise<string[]> {
  const paths: string[] = [];
  for (const [relativePath, entry] of snapshot.entries) {
    if (!isKnowledgeStructureDigestEvidencePath(relativePath)) continue;
    if (await transactionEntryHasRepairableExistingSourceEvidence(entry, source)) paths.push(relativePath);
  }
  return paths;
}

async function transactionSnapshotRepairableExistingSourceEvidencePathsAmong(
  snapshot: KnowledgeTransactionSnapshot,
  source: KnowledgeBaseSource,
  candidatePaths: string[]
): Promise<string[]> {
  const paths: string[] = [];
  for (const relativePath of candidatePaths) {
    const entry = snapshot.entries.get(relativePath);
    if (entry && await transactionEntryHasRepairableExistingSourceEvidence(entry, source)) paths.push(relativePath);
  }
  return paths;
}

async function transactionEntryHasRepairableExistingSourceEvidence(
  entry: KnowledgeTransactionSnapshotEntry,
  source: KnowledgeBaseSource
): Promise<boolean> {
  if (entry.kind !== "file") return false;
  if (!transactionEntryIsNotOlderThanSource(entry, source)) return false;
  const content = await readKnowledgeTransactionEntryContent(entry);
  if (!content) return false;
  const lines = normalizedEvidenceLines(content.toString("utf8"));
  return fileHasSinglePageLevelSourceEvidence(lines, source.relativePath)
    || fileHasDatedAggregateSourceEvidence(lines, source.relativePath)
    || fileHasInlineSourceDigestEvidence(lines, source.relativePath);
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
  if (beforeLength > DIGEST_EVIDENCE_DIFF_LINE_LIMIT || currentLength > DIGEST_EVIDENCE_DIFF_LINE_LIMIT) {
    return currentLines.map(() => true);
  }
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

function sourceEvidenceChangeContexts(lines: string[], relativePath: string): string[] {
  const sourceIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineMentionsTargetRawSource(line, relativePath))
    .map(({ index }) => index);
  if (!sourceIndexes.length) return [];

  const pageHeaderEnd = lines.findIndex((line) => /^##\s+/.test(line));
  const headerEnd = pageHeaderEnd === -1 ? lines.length : pageHeaderEnd;
  const pageLevelRawMentions = lines.slice(0, headerEnd).filter((line) => mentionsRawSource(line)).length;
  if (
    pageLevelRawMentions === 1
    && sourceIndexes.some((index) => isSinglePageLevelSourceLine(lines, index))
  ) {
    return [`page:${lines.join("\n")}`];
  }

  const contexts: string[] = [];
  for (const sourceIndex of sourceIndexes) {
    const block = [lines[sourceIndex]];
    for (let index = sourceIndex + 1; index < lines.length; index++) {
      const line = lines[index];
      if (isSourceEvidenceBlockBoundary(line) || mentionsRawSource(line)) break;
      block.push(line);
    }
    contexts.push(`block:${block.join("\n")}`);
  }

  const sourceDate = extractKnowledgeSourceDate(relativePath);
  if (sourceDate) {
    const datedContext = lines
      .filter((line, index) => evidenceTextCoversDate(line, sourceDate)
        || evidenceTextCoversDate(nearestEvidenceHeading(lines, index), sourceDate))
      .join("\n");
    if (datedContext) contexts.push(`date:${datedContext}`);
  }
  return Array.from(new Set(contexts)).sort();
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
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
  return snapshotKnowledgeTransactionEntries(vaultPath, digestEvidenceRoots(roots));
}

function digestEvidenceRoots(roots: string[]): string[] {
  return roots
    .map((root) => normalizePath(root))
    .filter((root) => root === "wiki" || root.startsWith("wiki/") || root === "projects" || root.startsWith("projects/"));
}
