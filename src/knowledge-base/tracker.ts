import { resolveKnowledgePath, knowledgeRolePath } from "./root-paths";
import { isMissingPathError } from "./utils";
import * as fsp from "fs/promises";
import * as path from "path";

export interface KnowledgeBaseTrackableFile {
  path: string;
  size: number;
  mtime: number;
  fingerprint?: string;
}

export interface KnowledgeBaseTrackerSnapshot {
  processedSources: Record<string, { size: number; mtime: number; fingerprint?: string }>;
  updatedAt: number;
}

export interface KnowledgeBaseTrackerHints {
  paths: Set<string>;
  updatedAt: number;
}

const UNPROCESSED_TRACKER_TEXT = /(未处理|待处理|未消化|待消化|跳过|风险)/;
const PROCESSED_LINE_METADATA = /\b(?:size|mtime|fingerprint|digested)=/;

export async function readKnowledgeBaseTrackerSnapshot(vaultPath: string, trackerPath: string, files: KnowledgeBaseTrackableFile[]): Promise<KnowledgeBaseTrackerSnapshot> {
  const absolute = resolveKnowledgeBaseTrackerPath(vaultPath, resolveKnowledgePath(vaultPath, trackerPath));
  const stat = await fsp.lstat(absolute).catch(() => null);
  if (!stat?.isFile()) return { processedSources: {}, updatedAt: 0 };
  const text = await fsp.readFile(absolute, "utf8").catch(() => "");
  if (!text.trim() || !stat) return { processedSources: {}, updatedAt: 0 };
  const processedSources: Record<string, { size: number; mtime: number; fingerprint?: string }> = {};
  const byPath = new Map(files.map((file) => [file.path, file]));

  function mark(relativePath: string, options: { expectedSize?: number; expectedMtime?: number; expectedFingerprint?: string } = {}): void {
    const file = byPath.get(resolveKnowledgePath(vaultPath, normalizeRelativePath(relativePath)));
    if (!file) return;
    if (!options.expectedFingerprint) return;
    if (typeof options.expectedSize === "number" && options.expectedSize !== file.size) return;
    if (options.expectedFingerprint && options.expectedFingerprint !== file.fingerprint) return;
    processedSources[file.path] = {
      size: file.size,
      mtime: file.mtime,
      ...(file.fingerprint ? { fingerprint: file.fingerprint } : {})
    };
  }

  let inUnprocessedSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#+\s+/.test(line)) inUnprocessedSection = headingHasUnprocessedSignal(line);
    if (!/(?:raw|（raw）)\//u.test(line)) continue;
    if (inUnprocessedSection) continue;
    if (!PROCESSED_LINE_METADATA.test(line) && lineHasUnprocessedSignalOutsideTrackablePath(line)) continue;
    const meta = parseTrackerLineMetadata(line);
    for (const match of line.matchAll(/(?:raw|[^/\s`\[\]（）]+（raw）)\/[^\]\n\r`]+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)\b/gi)) {
      mark(match[0], meta);
    }
  }

  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading = "", ...bodyLines] = section.split(/\r?\n/);
    if (headingHasUnprocessedSignal(heading)) continue;
    const prefixes = rawSectionPrefixes(heading);
    if (!prefixes.length) continue;
    const bodyHasUnprocessedSignal = bodyLines.some(lineHasUnprocessedSignalOutsideTrackablePath);

    if (!bodyHasUnprocessedSignal) {
      for (const line of bodyLines) {
        const meta = parseTrackerLineMetadata(line);
        for (const item of line.matchAll(/^-\s+`?(.+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif))`?(?=$|[\s|,，。;；:：)）\]】])/gim)) {
          const itemPath = normalizeRelativePath(item[1]);
          if (knowledgeRolePath(itemPath).startsWith("raw/")) {
            mark(itemPath, meta);
            continue;
          }
          for (const prefix of prefixes) mark(`${prefix}${itemPath}`, meta);
        }
      }
    }
  }

  return { processedSources, updatedAt: stat.mtimeMs };
}

export async function readKnowledgeBaseTrackerHints(vaultPath: string, trackerPath: string, files: KnowledgeBaseTrackableFile[], strict = false): Promise<KnowledgeBaseTrackerHints> {
  const absolute = resolveKnowledgeBaseTrackerPath(vaultPath, resolveKnowledgePath(vaultPath, trackerPath));
  const stat = await fsp.lstat(absolute).catch((error) => { if (strict && !isMissingPathError(error)) throw error; return null; });
  if (strict && stat && !stat.isFile()) throw new Error("Tracker is not a readable regular file");
  if (!stat?.isFile()) return { paths: new Set(), updatedAt: 0 };
  const text = await fsp.readFile(absolute, "utf8").catch((error) => { if (strict) throw error; return ""; });
  if (!text.trim()) return { paths: new Set(), updatedAt: 0 };
  const paths = new Set<string>();
  const byPath = new Map(files.map((file) => [file.path, file]));
  const mark = (relativePath: string) => {
    const normalized = resolveKnowledgePath(vaultPath, normalizeRelativePath(relativePath));
    if (byPath.has(normalized)) paths.add(normalized);
  };

  let inUnprocessedSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#+\s+/.test(line)) inUnprocessedSection = headingHasUnprocessedSignal(line);
    if (!/(?:raw|（raw）)\//u.test(line) || inUnprocessedSection) continue;
    if (lineHasUnprocessedSignalOutsideTrackablePath(line)) continue;
    for (const match of line.matchAll(/(?:raw|[^/\s`\[\]（）]+（raw）)\/[^\]\n\r`]+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)\b/gi)) {
      mark(match[0]);
    }
  }

  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const [heading = "", ...bodyLines] = section.split(/\r?\n/);
    if (headingHasUnprocessedSignal(heading)) continue;
    const prefixes = rawSectionPrefixes(heading);
    if (!prefixes.length) continue;
    const bodyHasUnprocessedSignal = bodyLines.some(lineHasUnprocessedSignalOutsideTrackablePath);
    if (bodyHasUnprocessedSignal) continue;
    for (const line of bodyLines) {
      for (const item of line.matchAll(/^-\s+`?(.+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif))`?(?=$|[\s|,，。;；:：)）\]】])/gim)) {
        const itemPath = normalizeRelativePath(item[1]);
        if (knowledgeRolePath(itemPath).startsWith("raw/")) {
          mark(itemPath);
          continue;
        }
        for (const prefix of prefixes) mark(`${prefix}${itemPath}`);
      }
    }
  }

  return { paths, updatedAt: stat.mtimeMs };
}

function resolveKnowledgeBaseTrackerPath(vaultPath: string, trackerPath: string): string {
  const trimmed = trackerPath.trim();
  if (!trimmed || path.isAbsolute(trimmed)) throw new Error(`知识库 tracker 路径越界：${trackerPath}`);
  const root = path.resolve(vaultPath);
  const absolute = path.resolve(root, trimmed);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`知识库 tracker 路径越界：${trackerPath}`);
  }
  return absolute;
}

function parseTrackerLineMetadata(line: string): { expectedSize?: number; expectedMtime?: number; expectedFingerprint?: string } {
  const sizeMatch = line.match(/\bsize=(\d+)\b/);
  const mtimeMatch = line.match(/\bmtime=(\d+(?:\.\d+)?)\b/);
  const fingerprintMatch = line.match(/\bfingerprint=([^\s|]+)/);
  return {
    ...(sizeMatch ? { expectedSize: Number(sizeMatch[1]) } : {}),
    ...(mtimeMatch ? { expectedMtime: Number(mtimeMatch[1]) } : {}),
    ...(fingerprintMatch ? { expectedFingerprint: fingerprintMatch[1] } : {})
  };
}

function lineHasUnprocessedSignalOutsideTrackablePath(line: string): boolean {
  if (!UNPROCESSED_TRACKER_TEXT.test(line)) return false;
  const withoutTrackablePaths = line
    .replace(/(?:raw|[^/\s`\[\]（）]+（raw）)\/[^\]\n\r`]+?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)\b/gi, "")
    .replace(/`?[^`\n\r]*?\.(?:md|markdown|txt|pdf|docx|png|jpe?g|webp|gif)\b`?/gi, "");
  return UNPROCESSED_TRACKER_TEXT.test(withoutTrackablePaths);
}

function headingHasUnprocessedSignal(heading: string): boolean {
  if (!UNPROCESSED_TRACKER_TEXT.test(heading)) return false;
  const withoutRawPrefixes = heading.replace(/(?:raw|[^/\s`\[\]（）]+（raw）)\/[^、，,;；—\n]+\//g, "");
  return UNPROCESSED_TRACKER_TEXT.test(withoutRawPrefixes);
}

function rawSectionPrefixes(heading: string): string[] {
  const prefixes = new Set<string>();
  for (const match of heading.matchAll(/(?:raw|[^/\s`\[\]（）]+（raw）)\/[^、，,;；—\n]+\//g)) {
    const prefix = ensureTrailingSlash(normalizeRelativePath(match[0]));
    if (knowledgeRolePath(prefix).startsWith("raw/")) prefixes.add(prefix);
  }
  return Array.from(prefixes);
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
