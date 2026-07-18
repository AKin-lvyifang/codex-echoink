import * as path from "path";
import { mimeForKnowledgeFile, requiredModalityForMime } from "../core/opencode-models";
import { createKnowledgeBaseIoBudget, shouldReadKnowledgeBaseFileContent } from "./io-budget";
import { isRawMarkdownPath, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry } from "./raw-digest";
import { refreshKnowledgeBaseIndex } from "./incremental-index";
import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseSkippedSource, KnowledgeBaseSource } from "./types";
import { formatDateForFile } from "./utils";

export const SUPPORTED_RAW_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface KnowledgeBaseDiscoveryOptions {
  maxRawFingerprintBytes?: number;
  maxTotalRawFingerprintBytes?: number;
}

export async function discoverKnowledgeBaseSources(
  vaultPath: string,
  processed: Record<string, { size: number; mtime: number; fingerprint?: string; confidence?: string }>,
  mode: KnowledgeBaseRunMode = "maintain",
  options: KnowledgeBaseDiscoveryOptions = {}
): Promise<KnowledgeBaseDiscovery> {
  const sources: KnowledgeBaseSource[] = [];
  const skippedSources: KnowledgeBaseSkippedSource[] = [];
  const frontmatterProcessed: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  const registry = await readRawDigestRegistry(vaultPath);
  const refresh = await refreshKnowledgeBaseIndex(vaultPath, {
    roots: ["raw"],
    seeds: {
      ...Object.fromEntries(Object.entries(processed ?? {})
        .filter(([relativePath, entry]) => {
          return !isRawMarkdownPath(relativePath)
            || entry.confidence === "verified"
            || entry.confidence === "repaired";
        })
        .map(([relativePath, entry]) => [relativePath, entry])),
      ...Object.fromEntries(Object.entries(registry.entries).map(([relativePath, entry]) => [relativePath, entry]))
    },
    validateRawSafety: true
  });
  const budget = createKnowledgeBaseIoBudget({
    maxFileBytes: options.maxRawFingerprintBytes,
    maxTotalBytes: options.maxTotalRawFingerprintBytes
  });
  for (const entry of refresh.entries) {
    const file = path.join(vaultPath, entry.path);
    const mime = mimeForKnowledgeFile(file);
    const modality = requiredModalityForMime(mime);
    const authoritative = authoritativeRawFingerprint(entry.path, entry, processed, registry.entries);
    if (authoritative) {
      sources.push({
        relativePath: entry.path,
        absolutePath: file,
        size: entry.size,
        mtime: entry.mtime,
        fingerprint: entry.fingerprint,
        mime,
        modality,
        changed: false
      });
      continue;
    }
    const readDecision = shouldReadKnowledgeBaseFileContent({ size: entry.size }, budget);
    if (!readDecision.ok) {
      skippedSources.push({
        relativePath: entry.path,
        absolutePath: file,
        size: entry.size,
        mtime: entry.mtime,
        mime,
        modality,
        reason: readDecision.reason ?? "文件超过读取预算"
      });
      continue;
    }
    if (isRawMarkdownPath(entry.path)) {
      const content = Buffer.from(entry.searchText, "utf8");
      const frontmatterRecord = rawDigestRecordFromMarkdown(content);
      if (rawDigestRecordIsTrusted(frontmatterRecord, entry.fingerprint)) {
        frontmatterProcessed[entry.path] = {
          size: entry.size,
          mtime: entry.mtime,
          fingerprint: entry.fingerprint
        };
      }
    }
    sources.push({
      relativePath: entry.path,
      absolutePath: file,
      size: entry.size,
      mtime: entry.mtime,
      fingerprint: entry.fingerprint,
      mime,
      modality,
      changed: true
    });
  }
  const trackerPath = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  // Registry entries are the non-Markdown equivalent of managed frontmatter.
  // A metadata match lets the index trust the seed without reading content;
  // if metadata drifted, refreshKnowledgeBaseIndex recomputes the fingerprint
  // first and this final comparison still detects real content changes.
  const mergedProcessed = { ...processed, ...registry.entries, ...frontmatterProcessed };
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
    reportPath: knowledgeBaseReportPathForMode(mode, today),
    trackerPath,
    indexStats: {
      reused: refresh.reusedCount,
      refreshed: refresh.indexedCount
    }
  };
}

export function knowledgeBaseReportPathForMode(mode: KnowledgeBaseRunMode, dateKey = formatDateForFile(new Date())): string {
  return `outputs/maintenance/${reportFileNameForMode(mode, dateKey)}`;
}

function authoritativeRawFingerprint(
  relativePath: string,
  entry: { size: number; mtime: number; fingerprint: string },
  processed: Record<string, { size: number; mtime: number; fingerprint?: string }>,
  registryEntries: Record<string, { size: number; mtime: number; fingerprint: string }>
): string {
  const registry = registryEntries[relativePath];
  if (registry?.fingerprint === entry.fingerprint && rawFileMetadataMatches(entry, registry)) return entry.fingerprint;
  const previous = processed[relativePath];
  if (previous?.fingerprint === entry.fingerprint && rawFileMetadataMatches(entry, previous)) return entry.fingerprint;
  return "";
}

function rawFileMetadataMatches(
  entry: { size: number; mtime: number },
  cached: { size: number; mtime: number }
): boolean {
  return entry.size === cached.size && Math.abs(entry.mtime - cached.mtime) < 1;
}

function reportFileNameForMode(mode: KnowledgeBaseRunMode, dateKey: string): string {
  const prefix = mode === "lint" ? "kb-check" : "kb-maintenance";
  return `${prefix}-${dateKey}.md`;
}

function isSourceChanged(source: KnowledgeBaseSource, previous?: { size: number; mtime: number; fingerprint?: string }): boolean {
  if (!previous) return true;
  if (previous.fingerprint) return previous.fingerprint !== source.fingerprint;
  return true;
}
