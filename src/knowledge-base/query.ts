import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseSource } from "./types";

export interface KnowledgeBaseAskMatch extends KnowledgeBaseSource {
  title: string;
  score: number;
  excerpt: string;
}

const WIKI_MATCH_LIMIT = 8;
const MAX_FILE_CHARS = 120_000;
const MAX_EXCERPT_CHARS = 1400;

export async function findKnowledgeBaseAskMatches(vaultPath: string, question: string, limit = WIKI_MATCH_LIMIT): Promise<KnowledgeBaseAskMatch[]> {
  const wikiRoot = path.join(vaultPath, "wiki");
  const files = await listMarkdownFiles(wikiRoot).catch(() => []);
  const terms = extractSearchTerms(question);
  const matches: KnowledgeBaseAskMatch[] = [];
  for (const absolutePath of files) {
    const relativePath = normalizeRelativePath(path.relative(vaultPath, absolutePath));
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const raw = await fsp.readFile(absolutePath, "utf8").catch(() => "");
    const text = raw.slice(0, MAX_FILE_CHARS);
    const title = titleForWikiFile(relativePath, text);
    const score = scoreWikiNote(question, terms, relativePath, title, text);
    if (score <= 0) continue;
    matches.push({
      relativePath,
      absolutePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      mime: "text/markdown",
      modality: "text",
      changed: false,
      title,
      score,
      excerpt: buildExcerpt(text, terms)
    });
  }
  return matches
    .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
    .slice(0, limit);
}

export function stripAskCommand(text: string): string {
  return text.replace(/^\/(?:ask|query|问|查询)(?:[\s:：?？]+)?/iu, "").trim() || text.trim();
}

export function formatAskMatchesForPrompt(matches: KnowledgeBaseAskMatch[]): string {
  if (!matches.length) return "- 未找到相关 wiki 笔记。";
  return matches.map((match, index) => {
    return [
      `### ${index + 1}. ${match.relativePath}`,
      `标题：${match.title}`,
      `相关度：${match.score}`,
      "摘录：",
      match.excerpt || "（无可用摘录）"
    ].join("\n");
  }).join("\n\n");
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) files.push(absolutePath);
  }
  return files;
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

function scoreWikiNote(question: string, terms: string[], relativePath: string, title: string, text: string): number {
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

function buildExcerpt(text: string, terms: string[]): string {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) return "";
  const lower = clean.toLowerCase();
  const term = terms.find((item) => lower.includes(item.toLowerCase()));
  const index = term ? lower.indexOf(term.toLowerCase()) : 0;
  const start = Math.max(0, index - Math.floor(MAX_EXCERPT_CHARS / 3));
  const excerpt = clean.slice(start, start + MAX_EXCERPT_CHARS).trim();
  return `${start > 0 ? "..." : ""}${excerpt}${start + MAX_EXCERPT_CHARS < clean.length ? "..." : ""}`;
}

function titleForWikiFile(relativePath: string, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  return path.basename(relativePath).replace(/\.(md|markdown)$/i, "");
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

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
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
    "should",
    "could",
    "can",
    "the",
    "and",
    "with"
  ]).has(value.toLowerCase());
}
