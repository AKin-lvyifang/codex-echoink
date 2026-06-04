import * as fsp from "fs/promises";
import * as path from "path";
import { mimeForKnowledgeFile, requiredModalityForMime } from "../core/opencode-models";
import { rawDigestFingerprint, rawDigestRecordFromMarkdown, rawDigestRecordIsTrusted, readRawDigestRegistry } from "./raw-digest";
import type { KnowledgeBaseDiscovery, KnowledgeBaseRunMode, KnowledgeBaseSource } from "./types";

export const SUPPORTED_RAW_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function discoverKnowledgeBaseSources(vaultPath: string, processed: Record<string, { size: number; mtime: number; fingerprint?: string }>, mode: KnowledgeBaseRunMode = "maintain"): Promise<KnowledgeBaseDiscovery> {
  const rawDir = path.join(vaultPath, "raw");
  const all = await walkExistingRawFiles(rawDir);
  const sources: KnowledgeBaseSource[] = [];
  const frontmatterProcessed: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  for (const file of all) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.has(ext)) continue;
    const stat = await fsp.stat(file);
    const relativePath = normalizeSlashes(path.relative(vaultPath, file));
    if (relativePath === "raw/index.md") continue;
    const lowerPath = relativePath.toLowerCase();
    if (lowerPath.endsWith(".base") || lowerPath.endsWith(".base.md") || lowerPath.includes(".assets/")) continue;
    const mime = mimeForKnowledgeFile(file);
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
      modality: requiredModalityForMime(mime),
      changed: true
    });
  }
  const trackerPath = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  const registry = await readRawDigestRegistry(vaultPath);
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
    reportPath: `outputs/maintenance/${reportFileNameForMode(mode, today)}`,
    trackerPath
  };
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
    return await walkFiles(rawDir);
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

async function walkFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function formatDateForFile(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}
