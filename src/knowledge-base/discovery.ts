import * as fsp from "fs/promises";
import * as path from "path";
import { mimeForKnowledgeFile, requiredModalityForMime } from "../core/opencode-models";
import type { KnowledgeBaseDiscovery, KnowledgeBaseSource } from "./types";
import { readKnowledgeBaseTrackerSnapshot } from "./tracker";

export const SUPPORTED_RAW_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function discoverKnowledgeBaseSources(vaultPath: string, processed: Record<string, { size: number; mtime: number }>): Promise<KnowledgeBaseDiscovery> {
  const rawDir = path.join(vaultPath, "raw");
  const all = await walkFiles(rawDir).catch(() => []);
  const sources: KnowledgeBaseSource[] = [];
  for (const file of all) {
    const ext = path.extname(file).toLowerCase();
    if (!SUPPORTED_RAW_EXTENSIONS.has(ext)) continue;
    const stat = await fsp.stat(file);
    const relativePath = normalizeSlashes(path.relative(vaultPath, file));
    if (relativePath === "raw/index.md") continue;
    const lowerPath = relativePath.toLowerCase();
    if (lowerPath.endsWith(".base") || lowerPath.endsWith(".base.md") || lowerPath.includes(".assets/")) continue;
    const mime = mimeForKnowledgeFile(file);
    sources.push({
      relativePath,
      absolutePath: file,
      size: stat.size,
      mtime: stat.mtimeMs,
      mime,
      modality: requiredModalityForMime(mime),
      changed: true
    });
  }
  const trackerPath = path.join(vaultPath, "outputs", ".ingest-tracker.md");
  const trackerSnapshot = await readKnowledgeBaseTrackerSnapshot(vaultPath, "outputs/.ingest-tracker.md", sources.map((source) => ({
    path: source.relativePath,
    size: source.size,
    mtime: source.mtime
  })));
  const mergedProcessed = { ...processed, ...trackerSnapshot.processedSources };
  const resolvedSources = sources.map((source) => {
    const previous = mergedProcessed[source.relativePath];
    return {
      ...source,
      changed: !previous || previous.size !== source.size || previous.mtime !== source.mtime
    };
  });
  const today = formatDateForFile(new Date());
  return {
    vaultPath,
    sources: resolvedSources,
    changedSources: resolvedSources.filter((source) => source.changed),
    reportPath: `outputs/kb-maintenance-${today}.md`,
    trackerPath
  };
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
