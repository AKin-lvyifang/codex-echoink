import * as path from "path";
import type { KnowledgeBaseCitation, KnowledgeBaseCitationBucket, KnowledgeBaseCitationSummary, KnowledgeBaseEvidenceStatus, KnowledgeBaseSource } from "./types";
import { DEFAULT_KNOWLEDGE_BASE_MAX_FILE_READ_BYTES, readKnowledgeBaseTextPrefix } from "./io-budget";
import { refreshKnowledgeBaseIndex, type KnowledgeBaseIndexEntry, type KnowledgeBaseIndexRoot } from "./incremental-index";

export interface KnowledgeBaseAskMatch extends KnowledgeBaseSource {
  bucket: KnowledgeBaseCitationBucket;
  title: string;
  score: number;
  excerpt: string;
  excerptLines: string[];
  relevance: Exclude<KnowledgeBaseEvidenceStatus, "none">;
  reason: string;
}

const WIKI_MATCH_LIMIT = 8;
const MAX_FILE_CHARS = 120_000;
const MAX_EXCERPT_LINES = 4;

export interface KnowledgeBaseAskSearchOptions {
  maxFileReadBytes?: number;
  maxFilesPerRoot?: number;
}

const ASK_SOURCE_ROOTS: Array<{ bucket: KnowledgeBaseCitationBucket; dir: string }> = [
  { bucket: "wiki", dir: "wiki" },
  { bucket: "journal", dir: "journal" },
  { bucket: "outputs", dir: "outputs" }
];

export async function findKnowledgeBaseAskMatches(vaultPath: string, question: string, limit = WIKI_MATCH_LIMIT, options: KnowledgeBaseAskSearchOptions = {}): Promise<KnowledgeBaseAskMatch[]> {
  const terms = extractSearchTerms(question);
  const maxFileReadBytes = normalizePositiveLimit(options.maxFileReadBytes, DEFAULT_KNOWLEDGE_BASE_MAX_FILE_READ_BYTES);
  const maxFilesPerRoot = normalizePositiveLimit(options.maxFilesPerRoot, Number.POSITIVE_INFINITY);
  const refresh = await refreshKnowledgeBaseIndex(vaultPath, {
    roots: ASK_SOURCE_ROOTS.map((root) => root.dir as KnowledgeBaseIndexRoot),
    maxFilesPerRoot,
    maxSearchChars: MAX_FILE_CHARS
  });
  const candidates = refresh.entries
    .map((entry) => scoreIndexedKnowledgeEntry(entry, question, terms, maxFileReadBytes))
    .filter((candidate): candidate is NonNullable<ReturnType<typeof scoreIndexedKnowledgeEntry>> => Boolean(candidate))
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
    .slice(0, limit);
  const matches: KnowledgeBaseAskMatch[] = [];
  for (const candidate of candidates) {
    const { entry, bucket, score, indexedText } = candidate;
    const absolutePath = path.join(vaultPath, entry.path);
    const text = await readKnowledgeBaseTextPrefix(absolutePath, maxFileReadBytes)
      .then((result) => result.text.slice(0, MAX_FILE_CHARS), () => indexedText);
    const excerptLines = buildExcerptLines(text, terms);
    const relevance = relevanceForMatch(bucket, score);
    matches.push({
      relativePath: entry.path,
      absolutePath,
      size: entry.size,
      mtime: entry.mtime,
      fingerprint: entry.fingerprint,
      mime: "text/markdown",
      modality: "text",
      changed: false,
      bucket,
      title: entry.title,
      score,
      excerpt: excerptLines.join("\n"),
      excerptLines,
      relevance,
      reason: reasonForMatch(bucket, score, question, terms, entry.path, entry.title, indexedText)
    });
  }
  return matches;
}

export function buildKnowledgeBaseCitationSummary(matches: KnowledgeBaseAskMatch[]): KnowledgeBaseCitationSummary {
  const counts: Record<KnowledgeBaseCitationBucket, number> = { wiki: 0, journal: 0, outputs: 0 };
  const citations: KnowledgeBaseCitation[] = matches.map((match) => {
    counts[match.bucket] += 1;
    return {
      bucket: match.bucket,
      title: match.title,
      path: match.relativePath,
      excerptLines: match.excerptLines.slice(0, MAX_EXCERPT_LINES),
      relevance: match.relevance,
      reason: match.reason,
      score: match.score
    };
  });
  return {
    status: evidenceStatusForCitations(citations),
    counts,
    citations
  };
}

export function stripAskCommand(text: string): string {
  return text.replace(/^\/(?:ask|query|问|查询)(?:[\s:：?？]+)?/iu, "").trim() || text.trim();
}

export function formatAskMatchesForPrompt(matches: KnowledgeBaseAskMatch[]): string {
  if (!matches.length) return "- 未找到相关本地来源。";
  return matches.map((match, index) => {
    return [
      `### ${index + 1}. ${match.relativePath}`,
      `来源集合：${bucketLabel(match.bucket)}`,
      `标题：${match.title}`,
      `相关度：${match.score}`,
      `证据强度：${match.relevance === "strong" ? "强证据" : "弱相关"}`,
      `为什么相关：${match.reason}`,
      "引用片段：",
      match.excerpt || "（无可用摘录）"
    ].join("\n");
  }).join("\n\n");
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return fallback;
  return Math.floor(value);
}

function extractSearchTerms(question: string): string[] {
  const terms = new Set<string>();
  const lower = question.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    if (!isStopWord(match[0])) terms.add(match[0]);
  }
  for (const match of question.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const text = match[0];
    if (!isStopWord(text)) terms.add(text);
    for (let size = 2; size <= Math.min(4, text.length); size++) {
      for (let index = 0; index <= text.length - size; index++) {
        const term = text.slice(index, index + size);
        if (!isStopWord(term)) terms.add(term);
      }
    }
  }
  return Array.from(terms).slice(0, 80);
}

function scoreKnowledgeNote(question: string, terms: string[], relativePath: string, title: string, text: string): number {
  const normalizedQuestion = normalizeForSearch(question);
  const normalizedPath = normalizeForSearch(relativePath);
  const normalizedTitle = normalizeForSearch(title);
  const normalizedText = normalizeForSearch(text);
  let score = 0;
  if (normalizedQuestion.length >= 4 && normalizedText.includes(normalizedQuestion)) score += 80;
  for (const term of terms) {
    const normalizedTerm = normalizeForSearch(term);
    if (!normalizedTerm) continue;
    if (normalizedPath.includes(normalizedTerm)) score += 18;
    if (normalizedTitle.includes(normalizedTerm)) score += 24;
    const hits = countOccurrences(normalizedText, normalizedTerm);
    if (hits) score += Math.min(hits, 8) * Math.max(2, Math.min(normalizedTerm.length, 8));
  }
  return score;
}

function buildExcerptLines(text: string, terms: string[]): string[] {
  const lines = text.replace(/\r/g, "").split("\n").map((line) => line.trimEnd());
  const nonEmpty = lines.findIndex((line) => line.trim());
  if (nonEmpty < 0) return [];
  const hitIndex = lines.findIndex((line) => lineMatchesTerms(line, terms));
  const start = Math.max(0, (hitIndex >= 0 ? hitIndex : nonEmpty) - 1);
  const excerpt = lines
    .slice(start, start + MAX_EXCERPT_LINES)
    .map((line) => line.trim())
    .filter(Boolean);
  if (excerpt.length >= 2 || start + MAX_EXCERPT_LINES >= lines.length) return excerpt;
  for (let index = start + MAX_EXCERPT_LINES; index < lines.length && excerpt.length < 2; index++) {
    const line = lines[index].trim();
    if (line) excerpt.push(line);
  }
  return excerpt;
}

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = text.indexOf(term);
  while (index >= 0 && count < 20) {
    count++;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function scoreIndexedKnowledgeEntry(
  entry: KnowledgeBaseIndexEntry,
  question: string,
  terms: string[],
  maxFileReadBytes: number
): { entry: KnowledgeBaseIndexEntry; bucket: KnowledgeBaseCitationBucket; score: number; indexedText: string; relativePath: string } | null {
  const bucket = bucketForIndexRoot(entry.root);
  if (!bucket) return null;
  const indexedText = entry.searchText.slice(0, Math.min(MAX_FILE_CHARS, maxFileReadBytes));
  const score = scoreKnowledgeNote(question, terms, entry.path, entry.title, indexedText);
  if (score <= 0) return null;
  return { entry, bucket, score, indexedText, relativePath: entry.path };
}

function bucketForIndexRoot(root: KnowledgeBaseIndexRoot): KnowledgeBaseCitationBucket | null {
  if (root === "wiki" || root === "journal" || root === "outputs") return root;
  return null;
}

function relevanceForMatch(bucket: KnowledgeBaseCitationBucket, score: number): Exclude<KnowledgeBaseEvidenceStatus, "none"> {
  if (bucket === "wiki" && score >= 32) return "strong";
  if (score >= 72) return "strong";
  return "weak";
}

function evidenceStatusForCitations(citations: KnowledgeBaseCitation[]): KnowledgeBaseEvidenceStatus {
  if (!citations.length) return "none";
  return citations.some((citation) => citation.relevance === "strong") ? "strong" : "weak";
}

function reasonForMatch(bucket: KnowledgeBaseCitationBucket, score: number, question: string, terms: string[], relativePath: string, title: string, text: string): string {
  const normalizedQuestion = normalizeForSearch(question);
  const normalizedPath = normalizeForSearch(relativePath);
  const normalizedTitle = normalizeForSearch(title);
  const normalizedText = normalizeForSearch(text);
  const matchedTerms = terms.filter((term) => normalizedText.includes(normalizeForSearch(term)));
  const titleOrPathHit = terms.some((term) => {
    const normalizedTerm = normalizeForSearch(term);
    return normalizedPath.includes(normalizedTerm) || normalizedTitle.includes(normalizedTerm);
  });
  if (normalizedQuestion.length >= 4 && normalizedText.includes(normalizedQuestion)) return "问题原文在正文中直接出现。";
  if (titleOrPathHit && matchedTerms.length >= 2) return "标题或路径与正文同时命中问题关键词。";
  if (bucket === "wiki" && matchedTerms.length >= 2) return "Wiki 笔记正文多处命中问题关键词。";
  if (matchedTerms.length >= 2) return "正文命中多个问题关键词，可作为背景依据。";
  if (titleOrPathHit) return "标题或路径命中问题关键词。";
  return score >= 32 ? "正文命中问题关键词。" : "只有少量关键词命中，相关性较弱。";
}

function lineMatchesTerms(line: string, terms: string[]): boolean {
  const normalizedLine = normalizeForSearch(line);
  return terms.some((term) => {
    const normalizedTerm = normalizeForSearch(term);
    return normalizedTerm && normalizedLine.includes(normalizedTerm);
  });
}

function bucketLabel(bucket: KnowledgeBaseCitationBucket): string {
  if (bucket === "wiki") return "Wiki";
  if (bucket === "journal") return "Journal";
  return "Outputs";
}

function isStopWord(value: string): boolean {
  return new Set([
    "什么",
    "怎么",
    "怎样",
    "如何",
    "是否",
    "是不是",
    "能不能",
    "有没有",
    "关系",
    "区别",
    "今天",
    "知识库",
    "where",
    "what",
    "why",
    "how",
    "answer",
    "base",
    "check",
    "citation",
    "citations",
    "context",
    "evidence",
    "file",
    "files",
    "knowledge",
    "local",
    "note",
    "notes",
    "question",
    "related",
    "source",
    "sources",
    "should",
    "test",
    "testing",
    "totally",
    "unrelated",
    "vault",
    "could",
    "can",
    "the",
    "and",
    "with"
  ]).has(value.toLowerCase());
}
