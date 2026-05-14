import type { ArticleUnderstandingCache, ArticleUnderstandingCacheState, ArticleUnderstandingEntry, ArticleUnderstandingFingerprint, EditorActionQualityMode, EditorActionSummaryCache, EditorActionSummaryCacheEntry } from "./types";

export interface EditorActionSummarySource {
  filePath: string;
  fileName: string;
  text: string;
  mtime: number;
  size: number;
}

const MAX_SUMMARY_SOURCE_CHARS = 12000;
const ARTICLE_UNDERSTANDING_REUSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ARTICLE_UNDERSTANDING_REUSE_RATIO = 0.12;
const ARTICLE_UNDERSTANDING_REUSE_MIN_DELTA = 600;
const ARTICLE_UNDERSTANDING_REUSE_MAX_DELTA = 3000;
const MAX_STABLE_LINE_HASHES = 12;

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
    fingerprint: makeArticleUnderstandingFingerprint(source.text),
    updatedAt: now,
    lastUsedAt: now
  };
}

export interface ArticleUnderstandingCacheResolution {
  state: ArticleUnderstandingCacheState;
  entry: ArticleUnderstandingEntry | null;
}

export function getFreshArticleUnderstanding(
  cache: ArticleUnderstandingCache,
  source: EditorActionSummarySource,
  mode: EditorActionQualityMode,
  model: string,
  now = Date.now()
): ArticleUnderstandingEntry | null {
  const resolved = resolveArticleUnderstandingCache(cache, source, mode, model, now);
  return resolved.state === "fresh" ? resolved.entry : null;
}

export function resolveArticleUnderstandingCache(
  cache: ArticleUnderstandingCache,
  source: EditorActionSummarySource,
  mode: EditorActionQualityMode,
  model: string,
  now = Date.now()
): ArticleUnderstandingCacheResolution {
  const entry = cache[source.filePath] ?? null;
  if (!entry) return { state: "missing", entry: null };
  if (!entry.understanding.trim()) return { state: "stale", entry };
  if (entry.mode !== mode || entry.model !== model) return { state: "stale", entry };
  if (entry.mtime === source.mtime && entry.size === source.size && entry.contentHash === editorActionContentHash(source.text)) {
    entry.lastUsedAt = now;
    return { state: "fresh", entry };
  }
  if (isReusableArticleUnderstanding(entry, source, now)) {
    entry.lastUsedAt = now;
    return { state: "reusable", entry };
  }
  return { state: "stale", entry };
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
    "请为这篇 Obsidian 笔记生成一份“文章理解”，供后续局部改写、扩写、续写、翻译使用。",
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

export function makeArticleUnderstandingFingerprint(text: string): ArticleUnderstandingFingerprint {
  const normalized = normalizeArticleTextForFingerprint(text);
  const title = firstHeading(normalized) ?? firstNonEmptyLine(normalized) ?? "";
  const blocks = paragraphBlocks(normalized);
  const stableLines = normalized
    .split("\n")
    .map((line) => normalizeFingerprintLine(line))
    .filter((line) => line.length >= 20 && !line.startsWith("#"))
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, MAX_STABLE_LINE_HASHES);
  return {
    textLength: text.length,
    titleHash: title ? editorActionContentHash(title) : "",
    firstBlockHash: blocks[0] ? editorActionContentHash(blocks[0]) : "",
    lastBlockHash: blocks.length ? editorActionContentHash(blocks[blocks.length - 1]) : "",
    stableLineHashes: stableLines.map((line) => editorActionContentHash(line))
  };
}

export function buildEditorActionSummaryPrompt(source: EditorActionSummarySource): string {
  return [
    "请为这篇 Obsidian 笔记生成一份简洁摘要，用于后续局部改写、扩写、续写、翻译时理解全文语境。",
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

function isReusableArticleUnderstanding(entry: ArticleUnderstandingEntry, source: EditorActionSummarySource, now: number): boolean {
  if (!entry.fingerprint) return false;
  if (now - entry.updatedAt > ARTICLE_UNDERSTANDING_REUSE_MAX_AGE_MS) return false;
  const oldLength = Math.max(1, entry.fingerprint.textLength || entry.size || 1);
  const changedChars = Math.abs(source.text.length - oldLength);
  const maxChangedChars = Math.max(
    ARTICLE_UNDERSTANDING_REUSE_MIN_DELTA,
    Math.min(ARTICLE_UNDERSTANDING_REUSE_MAX_DELTA, Math.round(oldLength * ARTICLE_UNDERSTANDING_REUSE_RATIO))
  );
  if (changedChars > maxChangedChars) return false;
  return sharedFingerprintAnchors(entry.fingerprint, makeArticleUnderstandingFingerprint(source.text)) > 0;
}

function sharedFingerprintAnchors(left: ArticleUnderstandingFingerprint, right: ArticleUnderstandingFingerprint): number {
  let matches = 0;
  if (left.titleHash && left.titleHash === right.titleHash) matches++;
  if (left.firstBlockHash && left.firstBlockHash === right.firstBlockHash) matches++;
  if (left.lastBlockHash && left.lastBlockHash === right.lastBlockHash) matches++;
  const rightStable = new Set(right.stableLineHashes);
  if (left.stableLineHashes.some((hash) => rightStable.has(hash))) matches++;
  return matches;
}

function normalizeArticleTextForFingerprint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .trim();
}

function firstHeading(text: string): string | null {
  const heading = text.split("\n").map((line) => line.trim()).find((line) => /^#{1,6}\s+\S/.test(line));
  return heading ? normalizeFingerprintLine(heading.replace(/^#{1,6}\s+/, "")) : null;
}

function firstNonEmptyLine(text: string): string | null {
  const line = text.split("\n").map((item) => normalizeFingerprintLine(item)).find(Boolean);
  return line ?? null;
}

function paragraphBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/g)
    .map((block) => block.split("\n").map((line) => normalizeFingerprintLine(line)).filter(Boolean).join("\n"))
    .filter(Boolean);
}

function normalizeFingerprintLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}
