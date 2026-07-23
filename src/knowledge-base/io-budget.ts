import * as fsp from "fs/promises";

export const DEFAULT_KNOWLEDGE_BASE_MAX_FILE_READ_BYTES = 262_144;
export const DEFAULT_KNOWLEDGE_BASE_MAX_TOTAL_READ_BYTES = 2_097_152;

export interface KnowledgeBaseIoBudgetOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface KnowledgeBaseIoBudget {
  maxFileBytes: number;
  maxTotalBytes: number;
  consumedBytes: number;
}

export interface KnowledgeBaseIoDecision {
  ok: boolean;
  reason?: string;
  strategy?: "whole-file" | "chunked-text";
  maxChunkBytes?: number;
}

export interface KnowledgeBaseTextPrefix {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

export function createKnowledgeBaseIoBudget(options: KnowledgeBaseIoBudgetOptions = {}): KnowledgeBaseIoBudget {
  return {
    maxFileBytes: normalizePositiveLimit(options.maxFileBytes, DEFAULT_KNOWLEDGE_BASE_MAX_FILE_READ_BYTES),
    maxTotalBytes: normalizePositiveLimit(options.maxTotalBytes, DEFAULT_KNOWLEDGE_BASE_MAX_TOTAL_READ_BYTES),
    consumedBytes: 0
  };
}

export function shouldReadKnowledgeBaseFileContent(
  file: { size: number },
  budget: KnowledgeBaseIoBudget,
  options: { allowChunkedText?: boolean } = {}
): KnowledgeBaseIoDecision {
  const size = normalizeFileSize(file.size);
  if (size > budget.maxFileBytes) {
    if (
      options.allowChunkedText === true
      && budget.consumedBytes + size <= budget.maxTotalBytes
    ) {
      budget.consumedBytes += size;
      return {
        ok: true,
        strategy: "chunked-text",
        maxChunkBytes: budget.maxFileBytes
      };
    }
    return { ok: false, reason: `文件超过单文件读取上限 ${budget.maxFileBytes} bytes` };
  }
  if (budget.consumedBytes + size > budget.maxTotalBytes) {
    return { ok: false, reason: `文件读取总量超过上限 ${budget.maxTotalBytes} bytes` };
  }
  budget.consumedBytes += size;
  return { ok: true, strategy: "whole-file" };
}

export async function readKnowledgeBaseTextPrefix(filePath: string, maxBytes: number): Promise<KnowledgeBaseTextPrefix> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const handle = await fsp.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (limit <= 0 || stat.size <= 0) {
      return { text: "", bytesRead: 0, truncated: stat.size > 0 };
    }
    const length = Math.min(limit, stat.size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      truncated: stat.size > bytesRead
    };
  } finally {
    await handle.close();
  }
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeFileSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
