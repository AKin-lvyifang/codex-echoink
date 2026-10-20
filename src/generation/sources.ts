import { lstat, readFile } from "node:fs/promises";
import * as path from "node:path";
import type { ChatMessage } from "../settings/settings";
import { knowledgeUsageMessageData } from "../knowledge-base/usage";
import type { GenerationReadFailure, GenerationSource } from "./types";

export const GENERATION_MAX_NOTES = 20;
export const GENERATION_MAX_NOTE_BYTES = 32_000;
// The normal 20K recent-context allocation leaves room for prompts and output.
// Bytes are a conservative bound for Chinese text; the runtime budget still applies.
export const GENERATION_MAX_TOTAL_BYTES = 64_000;
export interface GenerationSourceAssessment {
  sources: GenerationSource[];
  readFailures: GenerationReadFailure[];
  totalBytes: number;
  error?: string;
}
export function normalizeGenerationPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized)
    || normalized.split("/").some(part => !part || part === "." || part === ".." || part.startsWith("."))
    || /[\p{C}#^|\[\]]/u.test(normalized)) throw new Error("资料路径无效，请重新选择笔记。");
  return normalized;
}
export function isGenerationSourcePath(value: string, outputRoots: readonly string[] = []): boolean {
  try {
    const relative = normalizeGenerationPath(value);
    return /\.md$/iu.test(relative) && !outputRoots.some(root => relative === root || relative.startsWith(`${root}/`));
  } catch { return false; }
}
export function generationSourcesFromMessages(messages: readonly ChatMessage[], outputRoots: readonly string[] = []): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.status === "failed" || message.status === "cancelled") continue;
    for (const source of message.generationResult?.sourcePaths ?? []) paths.add(source);
    for (const mention of message.noteMentions ?? []) paths.add(mention.vaultRelativePath);
    for (const reference of knowledgeUsageMessageData(message).references) paths.add(reference.vaultRelativePath);
    for (const citation of message.citations?.citations ?? []) paths.add(citation.path);
  }
  return [...paths].filter(value => isGenerationSourcePath(value, outputRoots));
}
export async function assertGenerationPathSafe(vaultRoot: string, relativePath: string, allowMissingLeaf = false): Promise<void> {
  const relative = normalizeGenerationPath(relativePath);
  const parts = relative.split("/");
  let cursor = vaultRoot;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]!);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()) throw new Error("资料或目录路径已失效。");
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
export async function readGenerationSources(vaultRoot: string, sourcePaths: readonly string[], outputRoots: readonly string[] = [], signal?: AbortSignal): Promise<GenerationSourceAssessment> {
  const result: GenerationSourceAssessment = { sources: [], readFailures: [], totalBytes: 0 };
  const unique = [...new Set(sourcePaths)];
  if (!unique.length) return { ...result, error: "请先选择资料。" };
  if (unique.length > GENERATION_MAX_NOTES) return { ...result, error: "资料太多，请缩小范围（最多 20 篇）。" };
  for (const relative of unique) {
    signal?.throwIfAborted();
    if (!isGenerationSourcePath(relative, outputRoots)) return { ...result, error: "只能选择输出目录以外的 Markdown 笔记。" };
    try {
      await assertGenerationPathSafe(vaultRoot, relative);
      const stat = await lstat(path.join(vaultRoot, relative));
      if (!stat.isFile()) throw new Error("笔记已不存在或不是文件");
      if (stat.size > GENERATION_MAX_NOTE_BYTES) return { ...result, error: "资料太多，请缩小范围（单篇上限 32,000 字节）。" };
      const content = await readFile(path.join(vaultRoot, relative), "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > GENERATION_MAX_NOTE_BYTES || result.totalBytes + bytes > GENERATION_MAX_TOTAL_BYTES) return { ...result, error: "资料太多，请缩小范围（总量上限 64,000 字节）。" };
      result.sources.push({ path: relative, content, bytes }); result.totalBytes += bytes;
    } catch (error) {
      if (signal?.aborted) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === "ENOENT" ? "笔记已不存在或已移动" : code === "EACCES" || code === "EPERM" ? "没有读取权限" : "笔记或路径无法读取";
      result.readFailures.push({ path: relative, reason });
    }
  }
  if (!result.sources.length) result.error = "所选资料均未读到正文，请检查笔记。";
  return result;
}
