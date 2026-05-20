import * as fsp from "fs/promises";
import * as path from "path";
import type { StructureNormalizationPathRewrite } from "./types";
import { rewriteKnowledgeBaseRelativePath } from "./structure-normalizer";

export type RawSnapshot = Map<string, string>;

export async function snapshotRawFiles(vaultPath: string): Promise<RawSnapshot> {
  const rawDir = path.join(vaultPath, "raw");
  const files = await walkFiles(rawDir).catch(() => []);
  const snapshot: RawSnapshot = new Map();
  for (const file of files) {
    const relativePath = normalizeSlashes(path.relative(vaultPath, file));
    const content = await fsp.readFile(file);
    snapshot.set(relativePath, contentFingerprint(content));
  }
  return snapshot;
}

export function contentFingerprint(content: Buffer): string {
  let hash = 0x811c9dc5;
  for (const byte of content) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${content.length}:${hash.toString(16).padStart(8, "0")}`;
}

export function diffRawSnapshot(before: RawSnapshot, after: RawSnapshot, rewrites: StructureNormalizationPathRewrite[] = []): string[] {
  const changed: string[] = [];
  const expectedAfterPaths = new Set<string>();
  for (const [file, hash] of sortedSnapshotEntries(before)) {
    if (isRawIndex(file)) continue;
    const mapped = rewriteKnowledgeBaseRelativePath(file, rewrites);
    expectedAfterPaths.add(mapped);
    const afterHash = after.get(mapped);
    const label = file === mapped ? file : `${file} -> ${mapped}`;
    if (!afterHash) {
      changed.push(`${label} 内容缺失或被改写`);
      continue;
    }
    if (afterHash !== hash) changed.push(`${label} 内容被改写`);
  }
  for (const [file] of sortedSnapshotEntries(after)) {
    if (isRawIndex(file) || expectedAfterPaths.has(file) || before.has(file)) continue;
    changed.push(`${file} 新增或内容异常`);
  }
  return changed;
}

function sortedSnapshotEntries(snapshot: RawSnapshot): Array<[string, string]> {
  return Array.from(snapshot.entries()).sort(([left], [right]) => left.localeCompare(right));
}

function isRawIndex(file: string): boolean {
  return normalizeSlashes(file) === "raw/index.md";
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

function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}
