import * as fsp from "fs/promises";
import * as path from "path";
import { mimeForKnowledgeFile, requiredModalityForMime } from "../core/opencode-models";
import { createKnowledgeBaseIoBudget, shouldReadKnowledgeBaseFileContent } from "./io-budget";
import { isRawMarkdownPath, rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry } from "./raw-digest";
import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseSkippedSource, KnowledgeBaseSource } from "./types";
import { formatDateForFile, isMissingPathError, normalizeSlashes, walkFiles } from "./utils";

export const SUPPORTED_RAW_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface KnowledgeBaseDiscoveryOptions {
  maxRawFingerprintBytes?: number;
  maxTotalRawFingerprintBytes?: number;
}

export async function discoverKnowledgeBaseSources(
  vaultPath: string,
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  mode: KnowledgeBaseRunMode = "maintain",
  options: KnowledgeBaseDiscoveryOptions = {}
): Promise<KnowledgeBaseDiscovery> {
  const rawDir = path.join(vaultPath, "raw");
  const all = await walkExistingRawFiles(rawDir);
  const sources: KnowledgeBaseSource[] = [];
  const skippedSources: KnowledgeBaseSkippedSource[] = [];
  const frontmatterProcessed: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  const registry = await readRawDigestRegistry(vaultPath);
  const budget = createKnowledgeBaseIoBudget({
    maxFileBytes: options.maxRawFingerprintBytes,
    maxTotalBytes: options.maxTotalRawFingerprintBytes
  });
  for (const file of all) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.has(ext)) continue;
    const stat = await fsp.stat(file);
    const relativePath = normalizeSlashes(path.relative(vaultPath, file));
    if (isRawRootIndexPath(relativePath)) continue;
    const lowerPath = relativePath.toLowerCase();
    if (lowerPath.endsWith(".base") || lowerPath.endsWith(".base.md") || lowerPath.includes(".assets/")) continue;
    const mime = mimeForKnowledgeFile(file);
    const modality = requiredModalityForMime(mime);
    const cachedFingerprint = cachedRawFingerprint(relativePath, stat, processed, registry.entries);
    if (cachedFingerprint) {
      sources.push({
        relativePath,
        absolutePath: file,
        size: stat.size,
        mtime: stat.mtimeMs,
        fingerprint: cachedFingerprint,
        mime,
        modality,
        changed: false
      });
      continue;
    }
    const readDecision = shouldReadKnowledgeBaseFileContent({ size: stat.size }, budget);
    if (!readDecision.ok) {
      skippedSources.push({
        relativePath,
        absolutePath: file,
        size: stat.size,
        mtime: stat.mtimeMs,
        mime,
        modality,
        reason: readDecision.reason ?? "文件超过读取预算"
      });
      continue;
    }
    const content = await fsp.readFile(file);
    const fingerprint = rawDigestFingerprint(relativePath, content);
    const frontmatterRecord = rawDigestRecordFromMarkdown(content);
    if (rawDigestRecordIsTrusted(frontmatterRecord, fingerprint)) {
      frontmatterProcessed[relativePath] = {
        size: stat.size,
        mtime: stat.mtimeMs,
        fingerprint
      };
    }
    sources.push({
      relativePath,
      absolutePath: file,
      size: stat.size,
      mtime: stat.mtimeMs,
      fingerprint,
      mime,
      modality,
      changed: true
    });
  }
  const trackerPath = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  const registryProcessed = processedSourcesFromRawDigestRegistry(sources, registry.entries);
  const mergedProcessed = { ...processed, ...registryProcessed, ...frontmatterProcessed };
  const resolvedSources = sources.map((source) => {
    const previous = mergedProcessed[source.relativePath];
    return {
      ...source,
      changed: isSourceChanged(source, previous)
    };
  });
  const today = formatDateForFile(new Date());
  return {
    vaultPath,
    sources: resolvedSources,
    changedSources: resolvedSources.filter((source) => source.changed),
    skippedSources,
    reportPath: `outputs/maintenance/${reportFileNameForMode(mode, today)}`,
    trackerPath
  };
}

function cachedRawFingerprint(
  relativePath: string,
  stat: { size: number; mtimeMs: number },
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, { size: number; mtime: number; fingerprint: string }>
): string {
  const registry = registryEntries[relativePath];
  if (registry?.fingerprint && rawFileMetadataMatches(stat, registry)) return registry.fingerprint;
  if (isRawMarkdownPath(relativePath)) return "";
  const previous = processed[relativePath];
  if (previous?.fingerprint && rawFileMetadataMatches(stat, previous)) return previous.fingerprint;
  return "";
}

function rawFileMetadataMatches(stat: { size: number; mtimeMs: number }, cached: { size: number; mtime: number }): boolean {
  return stat.size === cached.size && Math.abs(stat.mtimeMs - cached.mtime) < 1;
}

function processedSourcesFromRawDigestRegistry(
  sources: KnowledgeBaseSource[],
  entries: Record<string, { fingerprint: string }>
): Record<string, { size: number; mtime: number; fingerprint?: string }> {
  const processed: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  for (const source of sources) {
    const entry = entries[source.relativePath];
    if (!entry || entry.fingerprint !== source.fingerprint) continue;
    processed[source.relativePath] = {
      size: source.size,
      mtime: source.mtime,
      fingerprint: source.fingerprint
    };
  }
  return processed;
}

function reportFileNameForMode(mode: KnowledgeBaseRunMode, dateKey: string): string {
  const prefix = mode === "lint" ? "kb-check" : "kb-maintenance";
  return `${prefix}-${dateKey}.md`;
}

async function walkExistingRawFiles(rawDir: string): Promise<string[]> {
  try {
    return await walkFiles(rawDir, {
      shouldSkipEntry: (entry) => entry.name.startsWith(".")
    });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function isSourceChanged(source: KnowledgeBaseSource, previous?: { size: number; mtime: number; fingerprint?: string }): boolean {
  if (!previous) return true;
  if (previous.fingerprint) return previous.fingerprint !== source.fingerprint;
  return true;
}

function isRawRootIndexPath(relativePath: string): boolean {
  return relativePath === "raw/index.md" || /^raw\/index \d+\.md$/i.test(relativePath);
}
