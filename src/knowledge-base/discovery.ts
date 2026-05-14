import * as fsp from "fs/promises";
import * as path from "path";
import { mimeForKnowledgeFile, requiredModalityForMime } from "../core/opencode-models";
import type { KnowledgeBaseDiscovery, KnowledgeBaseSource } from "./types";

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
    const mime = mimeForKnowledgeFile(file);
    const previous = processed[relativePath];
    sources.push({
      relativePath,
      absolutePath: file,
      size: stat.size,
      mtime: stat.mtimeMs,
      mime,
      modality: requiredModalityForMime(mime),
      changed: !previous || previous.size !== stat.size || previous.mtime !== stat.mtimeMs
    });
  }
  const today = formatDateForFile(new Date());
  return {
    vaultPath,
    sources,
    changedSources: sources.filter((source) => source.changed),
    reportPath: `outputs/kb-maintenance-${today}.md`,
    trackerPath: path.join(vaultPath, "outputs", ".ingest-tracker.md")
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
