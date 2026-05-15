import * as fsp from "fs/promises";
import * as path from "path";

export interface KnowledgeBaseTrackableFile {
  path: string;
  size: number;
  mtime: number;
}

export interface KnowledgeBaseTrackerSnapshot {
  processedSources: Record<string, { size: number; mtime: number }>;
  updatedAt: number;
}

export async function readKnowledgeBaseTrackerSnapshot(vaultPath: string, trackerPath: string, files: KnowledgeBaseTrackableFile[]): Promise<KnowledgeBaseTrackerSnapshot> {
  const absolute = path.join(vaultPath, trackerPath);
  const [text, stat] = await Promise.all([
    fsp.readFile(absolute, "utf8").catch(() => ""),
    fsp.stat(absolute).catch(() => null)
  ]);
  if (!text.trim() || !stat) return { processedSources: {}, updatedAt: 0 };
  const processedSources: Record<string, { size: number; mtime: number }> = {};
  const byPath = new Map(files.map((file) => [file.path, file]));
  const trackerMtime = stat.mtimeMs;

  function mark(relativePath: string): void {
    const file = byPath.get(normalizeRelativePath(relativePath));
    if (!file || file.mtime > trackerMtime + 1000) return;
    processedSources[file.path] = { size: file.size, mtime: file.mtime };
  }

  for (const match of text.matchAll(/raw\/[^\]\n\r`]+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)\b/gi)) {
    mark(match[0]);
  }

  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading = "", ...bodyLines] = section.split(/\r?\n/);
    const body = bodyLines.join("\n");
    const prefixMatch = heading.match(/(raw\/[^—\n]+?\/)(?:\s|—|$)/);
    if (!prefixMatch) continue;
    const prefix = normalizeRelativePath(prefixMatch[1]);
    if (!prefix.startsWith("raw/")) continue;

    for (const item of body.matchAll(/^-\s+`?(.+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif))`?(?:\s|$)/gim)) {
      const itemPath = normalizeRelativePath(item[1]);
      mark(itemPath.startsWith("raw/") ? itemPath : `${prefix}${itemPath}`);
    }

    const sectionSignalsProcessed = /全部|已处理|处理时间|处理新增|已消化|知识库重建|共\s*\d+\s*个文件/.test(`${heading}\n${body}`);
    if (sectionSignalsProcessed) {
      for (const file of files) {
        if (file.path.startsWith(prefix) && file.mtime <= trackerMtime + 1000) mark(file.path);
      }
    }
  }

  return { processedSources, updatedAt: trackerMtime };
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}
