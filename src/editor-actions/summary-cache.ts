import type { ArticleUnderstandingCache, ArticleUnderstandingEntry, EditorActionQualityMode, EditorActionSummaryCache, EditorActionSummaryCacheEntry } from "./types";

export interface EditorActionSummarySource {
  filePath: string;
  fileName: string;
  text: string;
  mtime: number;
  size: number;
}

const MAX_SUMMARY_SOURCE_CHARS = 12000;

export function editorActionContentHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function makeEditorActionSummaryCacheEntry(source: EditorActionSummarySource, summary: string, now = Date.now()): EditorActionSummaryCacheEntry {
  return {
    filePath: source.filePath,
    mtime: source.mtime,
    size: source.size,
    contentHash: editorActionContentHash(source.text),
    summary: summary.trim(),
    updatedAt: now,
    lastUsedAt: now
  };
}

export function getFreshEditorActionSummary(cache: EditorActionSummaryCache, source: EditorActionSummarySource, now = Date.now()): string | null {
  const entry = cache[source.filePath];
  if (!entry) return null;
  if (entry.mtime !== source.mtime || entry.size !== source.size) return null;
  if (entry.contentHash !== editorActionContentHash(source.text)) return null;
  entry.lastUsedAt = now;
  return entry.summary.trim() || null;
}

export function upsertEditorActionSummaryCache(
  cache: EditorActionSummaryCache,
  entry: EditorActionSummaryCacheEntry,
  maxEntries = 200
): EditorActionSummaryCache {
  const next: EditorActionSummaryCache = { ...cache, [entry.filePath]: entry };
  const entries = Object.values(next);
  if (entries.length <= maxEntries) return next;
  entries
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.updatedAt - right.updatedAt)
    .slice(0, Math.max(0, entries.length - maxEntries))
    .forEach((stale) => delete next[stale.filePath]);
  return next;
}

export function makeArticleUnderstandingCacheEntry(
  source: EditorActionSummarySource,
  understanding: string,
  mode: EditorActionQualityMode,
  model: string,
  now = Date.now()
): ArticleUnderstandingEntry {
  return {
    filePath: source.filePath,
    mtime: source.mtime,
    size: source.size,
    contentHash: editorActionContentHash(source.text),
    model,
    mode,
    understanding: understanding.trim(),
    updatedAt: now,
    lastUsedAt: now
  };
}

export function getFreshArticleUnderstanding(
  cache: ArticleUnderstandingCache,
  source: EditorActionSummarySource,
  mode: EditorActionQualityMode,
  model: string,
  now = Date.now()
): ArticleUnderstandingEntry | null {
  const entry = cache[source.filePath];
  if (!entry) return null;
  if (entry.mtime !== source.mtime || entry.size !== source.size) return null;
  if (entry.contentHash !== editorActionContentHash(source.text)) return null;
  if (entry.mode !== mode || entry.model !== model) return null;
  entry.lastUsedAt = now;
  return entry.understanding.trim() ? entry : null;
}

export function upsertArticleUnderstandingCache(
  cache: ArticleUnderstandingCache,
  entry: ArticleUnderstandingEntry,
  maxEntries = 200
): ArticleUnderstandingCache {
  const next: ArticleUnderstandingCache = { ...cache, [entry.filePath]: entry };
  const entries = Object.values(next);
  if (entries.length <= maxEntries) return next;
  entries
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.updatedAt - right.updatedAt)
    .slice(0, Math.max(0, entries.length - maxEntries))
    .forEach((stale) => delete next[stale.filePath]);
  return next;
}

export function buildArticleUnderstandingPrompt(source: EditorActionSummarySource): string {
  return [
    "请为这篇 Obsidian 笔记生成一份“文章理解”，供后续局部改写、扩写、续写使用。",
    "你只需要理解文章，不要生成改写正文。",
    "要求：",
    "1. 不要新增原文没有的信息。",
    "2. 如果信息不足，用“未明确”表达。",
    "3. 保留主题、受众、写作目的、结构、关键事实、风格和禁编造边界。",
    "4. 只返回下面这 8 个栏目，不解释，不使用代码块。",
    "",
    "主题：",
    "受众：",
    "写作目的：",
    "文章结构：",
    "关键事实：",
    "风格特征：",
    "禁止编造：",
    "局部写作建议：",
    "",
    `文件：${source.fileName} (${source.filePath})`,
    "",
    "笔记正文：",
    `<<<\n${truncateSummarySource(source.text)}\n>>>`
  ].join("\n");
}

export function buildEditorActionSummaryPrompt(source: EditorActionSummarySource): string {
  return [
    "请为这篇 Obsidian 笔记生成一份简洁摘要，用于后续局部改写、扩写、续写时理解全文语境。",
    "要求：",
    "1. 只返回摘要正文，不解释。",
    "2. 控制在 300-500 字以内。",
    "3. 保留主题、人物、场景、关键事实、语气和写作目的。",
    "4. 不要新增原文没有的信息。",
    "",
    `文件：${source.fileName} (${source.filePath})`,
    "",
    "笔记正文：",
    `<<<\n${truncateSummarySource(source.text)}\n>>>`
  ].join("\n");
}

function truncateSummarySource(text: string): string {
  if (text.length <= MAX_SUMMARY_SOURCE_CHARS) return text;
  const headLength = Math.floor(MAX_SUMMARY_SOURCE_CHARS * 0.65);
  const tailLength = MAX_SUMMARY_SOURCE_CHARS - headLength;
  return `${text.slice(0, headLength)}\n\n...[中间内容已截断]...\n\n${text.slice(-tailLength)}`;
}
