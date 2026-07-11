import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { normalizePath } from "obsidian";
import { swallowError } from "../core/error-handling";
import type { KnowledgeBaseProcessedSource } from "../settings/settings";
import { transactionSnapshotExistingSourceEvidencePaths, transactionSnapshotRepairableExistingSourceEvidencePaths } from "./digest-evidence";
import { discoverKnowledgeBaseSources } from "./discovery";
import { writeKnowledgeBaseReportFile } from "./report";
import {
  applyRawDigestFrontmatter,
  applyRawDigestStatusFrontmatter,
  isRawMarkdownPath,
  rawDigestFingerprint,
  rawDigestRecordFromMarkdown,
  rawDigestRecordIsTrusted,
  readRawDigestRegistry,
  RAW_DIGEST_REGISTRY_PATH,
  RAW_DIGEST_STATUS_PENDING_CALIBRATION,
  RAW_DIGEST_STATUS_PENDING_REINGEST,
  writeRawDigestRegistry,
  type RawDigestConfidence,
  type RawDigestRegistryEntry
} from "./raw-digest";
import {
  classifyRawSnapshotChanges,
  contentFingerprint,
  fingerprintRawContentSnapshot,
  formatRawIntegrityError,
  restoreRawFileContents,
  rawSnapshotChangeMessages,
  restoreRawSnapshot,
  snapshotRawFileContents,
  snapshotRawFiles,
  type RawContentSnapshot,
  type RawSnapshot
} from "./raw-integrity";
import { readKnowledgeBaseTrackerHints } from "./tracker";
import {
  assertSafeKnowledgeTransactionRoots,
  disposeKnowledgeTransactionSnapshot,
  restoreKnowledgeTransactionOnFailure,
  snapshotKnowledgeTransaction,
  type KnowledgeTransactionSnapshot
} from "./transaction-snapshot";
import type { KnowledgeBaseRawCalibrationResult, KnowledgeBaseRunResult, KnowledgeBaseSource } from "./types";
import { formatDateForFile } from "./utils";

export interface RawDigestCalibrationCommit {
  nextProcessedSources: Record<string, KnowledgeBaseProcessedSource>;
  reportPath: string;
  summary: string;
  processedSources: KnowledgeBaseSource[];
  calibration: KnowledgeBaseRawCalibrationResult;
}

export interface RawDigestCalibrationOptions {
  vaultPath: string;
  startedAt: number;
  processedSources: Record<string, KnowledgeBaseProcessedSource>;
  checkCanceled?: () => void;
  writeTracker(processed: Record<string, KnowledgeBaseProcessedSource>, updatedAt: number): Promise<void>;
  commit(commit: RawDigestCalibrationCommit): Promise<void>;
}

export async function runRawDigestCalibration(options: RawDigestCalibrationOptions): Promise<KnowledgeBaseRunResult> {
  const { vaultPath, startedAt } = options;
  const checkCanceled = options.checkCanceled ?? (() => undefined);
  const processedSourcesBeforeRun = cloneProcessedSources(options.processedSources);
  let rawBeforeContents: RawContentSnapshot | null = null;
  let rawBefore: RawSnapshot = new Map();
  let outputsBefore: KnowledgeTransactionSnapshot | null = null;
  let structureSnapshot: KnowledgeTransactionSnapshot | null = null;
  const processedSources: KnowledgeBaseSource[] = [];
  const marked: KnowledgeBaseSource[] = [];
  const review: KnowledgeBaseSource[] = [];
  const changed: KnowledgeBaseSource[] = [];
  const statusUpdates: Array<{ source: KnowledgeBaseSource; status: typeof RAW_DIGEST_STATUS_PENDING_CALIBRATION | typeof RAW_DIGEST_STATUS_PENDING_REINGEST; evidencePaths?: string[] }> = [];
  try {
    checkCanceled();
    rawBeforeContents = await snapshotRawFileContents(vaultPath);
    checkCanceled();
    rawBefore = fingerprintKnowledgeRawContentSnapshot(rawBeforeContents);
    assertSafeRawRoot(rawBeforeContents);
    assertSafeRawEntries(rawBeforeContents);
    outputsBefore = await snapshotKnowledgeTransaction(vaultPath, ["outputs"]);
    checkCanceled();
    assertSafeKnowledgeTransactionRoots(outputsBefore, { allowedUnsafePaths: new Set([RAW_DIGEST_REGISTRY_PATH, "outputs/.ingest-tracker.md"]) });
    const discovery = await discoverKnowledgeBaseSources(vaultPath, options.processedSources, "maintain");
    checkCanceled();
    structureSnapshot = await snapshotKnowledgeTransaction(vaultPath, ["wiki", "projects"]);
    checkCanceled();
    const registryBeforeRun = await readRawDigestRegistry(vaultPath);
    const trackerHints = await readKnowledgeBaseTrackerHints(vaultPath, "outputs/.ingest-tracker.md", discovery.sources.map((source) => ({
      path: source.relativePath,
      size: source.size,
      mtime: source.mtime,
      fingerprint: source.fingerprint
    })));
    const reportPath = `outputs/maintenance/kb-raw-calibration-${formatDateForFile(new Date(startedAt))}.md`;
    const nextProcessedSources = cloneProcessedSources(options.processedSources);
    const evidencePaths: Record<string, string[]> = {};
    for (const source of discovery.sources) {
      checkCanceled();
      const previous = processedSourcesBeforeRun[source.relativePath];
      const registryEntry = registryBeforeRun.entries[source.relativePath];
      const existingEvidence = await transactionSnapshotExistingSourceEvidencePaths(structureSnapshot, source);
      const rawDigestRecord = await rawMarkdownDigestFrontmatterRecord(vaultPath, source);
      if (rawDigestRecord?.fingerprint && rawDigestRecord.fingerprint !== source.fingerprint) {
        changed.push(source);
        statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
        delete nextProcessedSources[source.relativePath];
        continue;
      }
      if (previous?.fingerprint && previous.fingerprint !== source.fingerprint) {
        if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, previous.fingerprint)) {
          evidencePaths[source.relativePath] = existingEvidence;
          marked.push(source);
          continue;
        }
        changed.push(source);
        statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
        delete nextProcessedSources[source.relativePath];
        continue;
      }
      if (registryEntry?.fingerprint && registryEntry.fingerprint !== source.fingerprint) {
        if (existingEvidence.length && await legacyWholeFileFingerprintMatchesSource(vaultPath, source, registryEntry.fingerprint)) {
          evidencePaths[source.relativePath] = existingEvidence;
          marked.push(source);
          continue;
        }
        changed.push(source);
        statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_REINGEST, evidencePaths: existingEvidence });
        delete nextProcessedSources[source.relativePath];
        continue;
      }
      if (rawDigestRecordIsTrusted(rawDigestRecord, source.fingerprint)) {
        if (await rawDigestRecordEvidenceExists(vaultPath, rawDigestRecord)) continue;
        review.push(source);
        statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_CALIBRATION, evidencePaths: rawDigestRecord?.evidencePaths ?? [] });
        delete nextProcessedSources[source.relativePath];
        continue;
      }
      const existingMachineEvidence = rawDigestEvidenceFromProcessedSource(previous, source)
        || rawDigestEvidenceFromRegistryEntry(registryEntry, source);
      if (existingMachineEvidence) {
        evidencePaths[source.relativePath] = existingMachineEvidence;
        marked.push(source);
        continue;
      }
      const exactEvidence = existingEvidence;
      let repairableEvidence = exactEvidence;
      if (!repairableEvidence.length && legacyProcessedSourceMatchesCurrent(previous, source) && existingEvidence.length) {
        repairableEvidence = existingEvidence;
      }
      if (!repairableEvidence.length) {
        repairableEvidence = await transactionSnapshotRepairableExistingSourceEvidencePaths(structureSnapshot, source);
      }
      if (repairableEvidence.length) {
        evidencePaths[source.relativePath] = repairableEvidence;
        marked.push(source);
        continue;
      }
      if (previous || trackerHints.paths.has(source.relativePath)) {
        review.push(source);
        statusUpdates.push({ source, status: RAW_DIGEST_STATUS_PENDING_CALIBRATION });
        delete nextProcessedSources[source.relativePath];
      }
    }
    checkCanceled();
    const refreshedMarked = await writeRawDigestMetadataForSources(vaultPath, marked, {
      reportPath,
      startedAt,
      evidencePaths,
      confidence: "repaired",
      checkCanceled
    });
    checkCanceled();
    const refreshedStatusUpdates = await writeRawDigestStatusMetadataForSources(vaultPath, statusUpdates, {
      reportPath,
      startedAt,
      checkCanceled
    });
    checkCanceled();
    const rawAfterDigestMetadata = await snapshotKnowledgeRawFiles(vaultPath);
    const rawDigestChanges = classifyRawSnapshotChanges(rawBefore, rawAfterDigestMetadata, [], {
      allowedManagedFrontmatterPaths: new Set([...refreshedMarked, ...refreshedStatusUpdates].map((source) => source.relativePath))
    });
    if (rawDigestChanges.blockingChanges.length) {
      const messages = rawSnapshotChangeMessages(rawDigestChanges.blockingChanges);
      await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfterDigestMetadata, [], { removeAdded: "unsafe" });
      throw new Error(formatRawIntegrityError(messages, true));
    }
    for (const source of refreshedMarked) {
      checkCanceled();
      nextProcessedSources[source.relativePath] = {
        path: source.relativePath,
        size: source.size,
        mtime: source.mtime,
        fingerprint: source.fingerprint,
        digestedAt: startedAt,
        reportPath,
        evidencePaths: evidencePaths[source.relativePath] ?? [],
        runId: String(startedAt),
        confidence: "repaired"
      };
      processedSources.push(source);
    }
    checkCanceled();
    await options.writeTracker(nextProcessedSources, startedAt);
    checkCanceled();
    await writeKnowledgeBaseReportFile(vaultPath, reportPath, buildRawDigestCalibrationReport({
      startedAt,
      marked: refreshedMarked,
      review,
      changed,
      evidencePaths
    }));
    checkCanceled();
    const summary = `Raw 状态校准完成：已登记 ${refreshedMarked.length} 个，待复核 ${review.length} 个，内容变更 ${changed.length} 个。`;
    const calibration = {
      marked: refreshedMarked,
      review,
      changed,
      evidencePaths
    };
    checkCanceled();
    await options.commit({
      nextProcessedSources,
      reportPath,
      summary,
      processedSources,
      calibration
    });
    checkCanceled();
    return {
      status: "success",
      reportPath,
      summary,
      processedSources,
      calibration
    };
  } catch (error) {
    if (rawBeforeContents) {
      await restoreRawFileContents(vaultPath, rawBeforeContents).catch(swallowError("restore raw contents after calibration failure"));
      const rawAfter = await snapshotKnowledgeRawFiles(vaultPath).catch(() => null);
      if (rawAfter) await restoreRawSnapshot(vaultPath, rawBeforeContents, rawBefore, rawAfter, [], { removeAdded: "unsafe" }).catch(swallowError("restore raw snapshot after calibration failure"));
    }
    await restoreKnowledgeTransactionOnFailure(outputsBefore);
    throw error;
  } finally {
    await disposeKnowledgeTransactionSnapshot(structureSnapshot);
    await disposeKnowledgeTransactionSnapshot(outputsBefore);
  }
}

export async function writeRawDigestMetadataForSources(
  vaultPath: string,
  sources: KnowledgeBaseSource[],
  options: {
    reportPath: string;
    startedAt: number;
    evidencePaths: Record<string, string[]>;
    confidence: RawDigestConfidence;
    checkCanceled?: () => void;
  }
): Promise<KnowledgeBaseSource[]> {
  if (!sources.length) return sources;
  const registry = await readRawDigestRegistry(vaultPath);
  const updated: KnowledgeBaseSource[] = [];
  for (const source of sources) {
    options.checkCanceled?.();
    const absolutePath = path.join(vaultPath, source.relativePath);
    const content = await fsp.readFile(absolutePath);
    const fingerprint = rawDigestFingerprint(source.relativePath, content);
    if (fingerprint !== source.fingerprint) {
      throw new Error(`raw 已在维护后处理前发生变化，停止登记提炼状态：${source.relativePath}`);
    }
    const evidencePaths = (options.evidencePaths[source.relativePath] ?? []).map(normalizePath).filter(Boolean);
    const stat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const entryForFrontmatter = rawDigestRegistryEntryForSource({ ...source, size: stat.size, mtime: stat.mtimeMs, fingerprint }, {
      reportPath: options.reportPath,
      startedAt: options.startedAt,
      evidencePaths,
      confidence: options.confidence
    });
    if (isRawMarkdownPath(source.relativePath)) {
      const nextContent = applyRawDigestFrontmatter(content, entryForFrontmatter);
      const nextFingerprint = rawDigestFingerprint(source.relativePath, nextContent);
      if (nextFingerprint !== fingerprint) {
        throw new Error(`raw 提炼状态写入后指纹不稳定：${source.relativePath}`);
      }
      if (!nextContent.equals(content)) {
        options.checkCanceled?.();
        await fsp.writeFile(absolutePath, nextContent);
      }
    }
    const refreshedStat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const refreshed: KnowledgeBaseSource = {
      ...source,
      size: refreshedStat.size,
      mtime: refreshedStat.mtimeMs,
      fingerprint
    };
    registry.entries[source.relativePath] = rawDigestRegistryEntryForSource(refreshed, {
      reportPath: options.reportPath,
      startedAt: options.startedAt,
      evidencePaths,
      confidence: options.confidence
    });
    updated.push(refreshed);
  }
  options.checkCanceled?.();
  registry.updatedAt = new Date(options.startedAt).toISOString();
  await writeRawDigestRegistry(vaultPath, registry);
  return updated;
}

export function fingerprintKnowledgeRawContentSnapshot(snapshot: RawContentSnapshot): RawSnapshot {
  return fingerprintRawContentSnapshot(snapshot, { fileFingerprint: rawDigestFingerprint });
}

export async function snapshotKnowledgeRawFiles(vaultPath: string): Promise<RawSnapshot> {
  return snapshotRawFiles(vaultPath, { fileFingerprint: rawDigestFingerprint });
}

export function assertSafeRawRoot(snapshot: RawContentSnapshot): void {
  const root = snapshot.get("raw");
  if (root && root.kind !== "directory") {
    throw new Error("raw/ 不是普通目录，知识库任务不会扫描或处理该路径。");
  }
}

export function assertSafeRawEntries(snapshot: RawContentSnapshot): void {
  for (const [relativePath, entry] of snapshot) {
    if (relativePath === "raw") continue;
    if (entry.kind === "symlink") {
      throw new Error(`raw/ 不能包含 symlink：${relativePath}`);
    }
    if (entry.kind === "special") {
      throw new Error(`raw/ 不能包含特殊文件：${relativePath}`);
    }
    if (entry.kind === "file" && entry.nlink > 1) {
      throw new Error(`raw/ 不能包含 hardlink：${relativePath}`);
    }
  }
}

async function writeRawDigestStatusMetadataForSources(
  vaultPath: string,
  updates: Array<{ source: KnowledgeBaseSource; status: typeof RAW_DIGEST_STATUS_PENDING_CALIBRATION | typeof RAW_DIGEST_STATUS_PENDING_REINGEST; evidencePaths?: string[] }>,
  options: {
    reportPath: string;
    startedAt: number;
    checkCanceled?: () => void;
  }
): Promise<KnowledgeBaseSource[]> {
  if (!updates.length) return [];
  const registry = await readRawDigestRegistry(vaultPath);
  const updated: KnowledgeBaseSource[] = [];
  const seen = new Set<string>();
  for (const update of updates) {
    options.checkCanceled?.();
    const source = update.source;
    if (seen.has(source.relativePath)) continue;
    seen.add(source.relativePath);
    delete registry.entries[source.relativePath];
    if (!isRawMarkdownPath(source.relativePath)) continue;
    const absolutePath = path.join(vaultPath, source.relativePath);
    const stat = await assertSafeRawDigestTarget(absolutePath, source.relativePath);
    const content = await fsp.readFile(absolutePath);
    const fingerprint = rawDigestFingerprint(source.relativePath, content);
    if (fingerprint !== source.fingerprint) {
      throw new Error(`raw 已在校准后处理前发生变化，停止写入待处理状态：${source.relativePath}`);
    }
    const nextContent = applyRawDigestStatusFrontmatter(content, {
      status: update.status,
      fingerprint,
      reportPath: options.reportPath,
      evidencePaths: normalizeEvidencePaths(update.evidencePaths ?? []),
      digestedAt: options.startedAt
    });
    const nextFingerprint = rawDigestFingerprint(source.relativePath, nextContent);
    if (nextFingerprint !== fingerprint) {
      throw new Error(`raw 待处理状态写入后指纹不稳定：${source.relativePath}`);
    }
    if (!nextContent.equals(content)) {
      options.checkCanceled?.();
      await fsp.writeFile(absolutePath, nextContent);
    }
    updated.push({
      ...source,
      size: stat.size,
      mtime: stat.mtimeMs,
      fingerprint
    });
  }
  options.checkCanceled?.();
  registry.updatedAt = new Date(options.startedAt).toISOString();
  await writeRawDigestRegistry(vaultPath, registry);
  return updated;
}

async function rawMarkdownDigestFrontmatterRecord(vaultPath: string, source: KnowledgeBaseSource): Promise<ReturnType<typeof rawDigestRecordFromMarkdown> | null> {
  if (!isRawMarkdownPath(source.relativePath)) return null;
  const content = await fsp.readFile(path.join(vaultPath, source.relativePath)).catch(() => null);
  if (!content) return null;
  return rawDigestRecordFromMarkdown(content);
}

async function rawDigestRecordEvidenceExists(vaultPath: string, record: ReturnType<typeof rawDigestRecordFromMarkdown> | null): Promise<boolean> {
  if (!record?.reportPath || !record.evidencePaths.length) return false;
  const requiredPaths = [record.reportPath, ...record.evidencePaths].map(normalizePath).filter(Boolean);
  if (!requiredPaths.length) return false;
  for (const relativePath of requiredPaths) {
    const stat = await fsp.lstat(path.join(vaultPath, relativePath)).catch(() => null);
    if (!stat?.isFile() || stat.nlink > 1) return false;
  }
  return true;
}

async function legacyWholeFileFingerprintMatchesSource(vaultPath: string, source: KnowledgeBaseSource, fingerprint: string): Promise<boolean> {
  if (!fingerprint || !isRawMarkdownPath(source.relativePath)) return false;
  const content = await fsp.readFile(path.join(vaultPath, source.relativePath)).catch(() => null);
  if (!content) return false;
  return contentFingerprint(content) === fingerprint;
}

function rawDigestEvidenceFromProcessedSource(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): string[] | null {
  if (!previous?.fingerprint || previous.fingerprint !== source.fingerprint) return null;
  if (!previous.reportPath || !previous.evidencePaths?.length) return null;
  return normalizeEvidencePaths(previous.evidencePaths);
}

function rawDigestEvidenceFromRegistryEntry(entry: RawDigestRegistryEntry | undefined, source: KnowledgeBaseSource): string[] | null {
  if (!entry || entry.fingerprint !== source.fingerprint) return null;
  if (!entry.reportPath || !entry.evidencePaths.length) return null;
  return normalizeEvidencePaths(entry.evidencePaths);
}

function normalizeEvidencePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizePath).filter(Boolean))).sort();
}

async function assertSafeRawDigestTarget(absolutePath: string, relativePath: string): Promise<fs.Stats> {
  const stat = await fsp.lstat(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`raw 提炼状态只能登记普通文件：${relativePath}`);
  }
  if (stat.nlink > 1) {
    throw new Error(`raw 提炼状态拒绝登记 hardlink 文件：${relativePath}`);
  }
  return stat;
}

function rawDigestRegistryEntryForSource(
  source: Pick<KnowledgeBaseSource, "relativePath" | "fingerprint" | "size" | "mtime">,
  options: { reportPath: string; startedAt: number; evidencePaths: string[]; confidence: RawDigestConfidence }
): RawDigestRegistryEntry {
  return {
    rawPath: source.relativePath,
    fingerprint: source.fingerprint,
    size: source.size,
    mtime: source.mtime,
    digestedAt: options.startedAt,
    runId: String(options.startedAt),
    reportPath: options.reportPath,
    evidencePaths: options.evidencePaths,
    confidence: options.confidence
  };
}

function buildRawDigestCalibrationReport(input: {
  startedAt: number;
  marked: KnowledgeBaseSource[];
  review: KnowledgeBaseSource[];
  changed: KnowledgeBaseSource[];
  evidencePaths: Record<string, string[]>;
}): string {
  return [
    "---",
    "source: codex-echoink",
    "mode: raw-digest-calibration",
    `created: ${new Date(input.startedAt).toISOString()}`,
    "---",
    "",
    "# Raw 状态校准报告",
    "",
    "## 一眼结论",
    "",
    `- 已登记：${input.marked.length} 个。`,
    `- 待复核：${input.review.length} 个。`,
    `- 内容变更：${input.changed.length} 个。`,
    "- 本轮不重新提炼，不调用 Agent；Markdown raw 写入托管元属性，非 Markdown raw 写入 registry，并同步 tracker / settings。",
    "",
    "## 已登记",
    "",
    ...(input.marked.length
      ? input.marked.map((source) => `- \`${source.relativePath}\` | 证据：${(input.evidencePaths[source.relativePath] ?? []).map((item) => `\`${item}\``).join("，") || "无"}`)
      : ["- 无"]),
    "",
    "## 待复核",
    "",
    ...(input.review.length
      ? input.review.map((source) => `- \`${source.relativePath}\``)
      : ["- 无"]),
    "",
    "## 内容变更",
    "",
    ...(input.changed.length
      ? input.changed.map((source) => `- \`${source.relativePath}\``)
      : ["- 无"]),
    ""
  ].join("\n");
}

function legacyProcessedSourceMatchesCurrent(previous: KnowledgeBaseProcessedSource | undefined, source: KnowledgeBaseSource): boolean {
  if (!previous || previous.fingerprint) return false;
  return previous.size === source.size && Math.round(previous.mtime) === Math.round(source.mtime);
}

function cloneProcessedSources(processed: Record<string, KnowledgeBaseProcessedSource> | undefined): Record<string, KnowledgeBaseProcessedSource> {
  return Object.fromEntries(
    Object.entries(processed ?? {}).map(([key, source]) => [key, { ...source }])
  );
}
