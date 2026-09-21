import { knowledgeRootRole, resolveKnowledgePath } from "./root-paths";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { TextDecoder } from "node:util";
import * as path from "path";
import type {
  KnowledgeBaseCitation,
  KnowledgeBaseCitationBucket,
  KnowledgeBaseCitationSummary,
  KnowledgeBaseEvidenceStatus,
  KnowledgeBaseSource,
  KnowledgeReference,
  KnowledgeReferenceVerificationResult,
  KnowledgeRetrievalRequest,
  KnowledgeRetrievalResult
} from "./types";
import { DEFAULT_KNOWLEDGE_BASE_MAX_FILE_READ_BYTES, readKnowledgeBaseTextPrefix } from "./io-budget";
import { refreshKnowledgeBaseIndex, type KnowledgeBaseIndexEntry, type KnowledgeBaseIndexRoot } from "./incremental-index";
import {
  KnowledgeAgentIndex,
  type KnowledgeAgentReadResult,
  type KnowledgeAgentSearchRequest,
  type KnowledgeAgentSearchResult
} from "./knowledge-agent-index";

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
export const MAX_KNOWLEDGE_REFERENCES = 20;
export const KNOWLEDGE_NO_EVIDENCE_RESPONSE = "当前 Vault 没有找到足够依据";
export const KNOWLEDGE_SOURCE_CHANGED_RESPONSE = "来源已变化，请重新执行";
export const KNOWLEDGE_NO_EVIDENCE_RESOURCE = [
  "本地预检暂未找到可引用的 Vault 依据；这是初次检索状态，不代表最终没有依据，也不应因此结束对话。",
  "可以换关键词、缩小范围或继续搜索，并读取相关正文。后续取得依据时，以实际读取结果形成回答和来源，不再声称没有找到。",
  "最终仍无本地依据时明确说明知识库没有找到；若用户未限定只依据 Vault，可按需使用已准入的只读外部工具或模型知识补答。",
  "没有可用外部工具或没有实际联网核验时，如实说明未联网核验，不把模型知识当作实时来源。",
  "用户要求只依据 Vault 时，不用模型常识代替缺失的本地依据。不要虚构引用。"
].join("\n");

const KNOWLEDGE_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const DEFAULT_REFERENCE_LIMIT = MAX_KNOWLEDGE_REFERENCES;
const CANDIDATE_SEARCH_CHAR_LIMIT = 120_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type KnowledgeRetrievalErrorCode =
  | "invalid-path"
  | "forbidden-path"
  | "not-found"
  | "not-markdown"
  | "not-regular-file"
  | "invalid-utf8"
  | "source-changed";

export class KnowledgeRetrievalError extends Error {
  readonly code: KnowledgeRetrievalErrorCode;
  readonly vaultRelativePath?: string;

  constructor(
    code: KnowledgeRetrievalErrorCode,
    message: string,
    vaultRelativePath?: string
  ) {
    super(message);
    this.name = "KnowledgeRetrievalError";
    this.code = code;
    this.vaultRelativePath = vaultRelativePath;
  }
}

export interface KnowledgeReferenceBuildInput {
  vaultRelativePath: string;
  question: string;
  /** True only for an explicitly named Raw/Inbox source or explicit unrefined scope. */
  allowUnrefined?: boolean;
  expectedContentRevision?: string;
}

interface KnowledgeSourceSnapshot {
  vaultRelativePath: string;
  title: string;
  bytes: Buffer;
  lines: string[];
  text: string;
  contentRevision: string;
  sourceType: "wiki" | "projects" | "raw";
  recordedAt: number;
  publishedAt?: string;
}

interface KnowledgeCandidate {
  vaultRelativePath: string;
  score: number;
  explicit: boolean;
}

/** Builds and revalidates exact local references without an index fallback. */
export class KnowledgeReferenceBuilder {
  readonly vaultPath: string;

  constructor(vaultPath: string) {
    if (typeof vaultPath !== "string" || !vaultPath.trim()) {
      throw new KnowledgeRetrievalError(
        "invalid-path",
        "KnowledgeReferenceBuilder 需要当前 Vault 的绝对路径"
      );
    }
    this.vaultPath = path.resolve(vaultPath);
  }

  async buildReference(
    input: Readonly<KnowledgeReferenceBuildInput>
  ): Promise<KnowledgeReference> {
    const question = normalizeKnowledgeQuestion(input.question);
    const snapshot = await readKnowledgeSourceSnapshot(
      this.vaultPath,
      input.vaultRelativePath,
      Boolean(input.allowUnrefined)
    );
    if (
      input.expectedContentRevision
      && snapshot.contentRevision !== input.expectedContentRevision
    ) {
      throw new KnowledgeRetrievalError(
        "source-changed",
        KNOWLEDGE_SOURCE_CHANGED_RESPONSE,
        snapshot.vaultRelativePath
      );
    }
    const lineRange = selectReferenceLineRange(snapshot.lines, question);
    const excerpt = snapshot.lines
      .slice(lineRange.lineStart - 1, lineRange.lineEnd)
      .join("\n");
    return freezeKnowledgeReference({
      referenceId: knowledgeReferenceId(
        snapshot.vaultRelativePath,
        snapshot.contentRevision,
        lineRange.lineStart,
        lineRange.lineEnd
      ),
      vaultRelativePath: snapshot.vaultRelativePath,
      title: snapshot.title,
      excerpt,
      contentRevision: snapshot.contentRevision,
      lineStart: lineRange.lineStart,
      lineEnd: lineRange.lineEnd,
      totalLines: snapshot.lines.length,
      hasMore: lineRange.lineStart > 1 || lineRange.lineEnd < snapshot.lines.length,
      sourceType: snapshot.sourceType,
      recordedAt: snapshot.recordedAt,
      ...(snapshot.publishedAt ? { publishedAt: snapshot.publishedAt } : {}),
      verificationStatus: "local_revision_verified"
    });
  }

  async verifyReferences(
    references: readonly KnowledgeReference[]
  ): Promise<KnowledgeReferenceVerificationResult> {
    const changedReferenceIds: string[] = [];
    const verified: KnowledgeReference[] = [];
    for (const reference of references.slice(0, MAX_KNOWLEDGE_REFERENCES)) {
      try {
        const normalized = normalizeKnowledgeReference(reference);
        const snapshot = await readKnowledgeSourceSnapshot(
          this.vaultPath,
          normalized.vaultRelativePath,
          true
        );
        const expectedExcerpt = snapshot.lines
          .slice(normalized.lineStart - 1, normalized.lineEnd)
          .join("\n");
        const expectedId = knowledgeReferenceId(
          snapshot.vaultRelativePath,
          snapshot.contentRevision,
          normalized.lineStart,
          normalized.lineEnd
        );
        if (
          snapshot.contentRevision !== normalized.contentRevision
          || normalized.lineStart > snapshot.lines.length
          || normalized.lineEnd > snapshot.lines.length
          || expectedExcerpt !== normalized.excerpt
          || expectedId !== normalized.referenceId
        ) {
          changedReferenceIds.push(normalized.referenceId);
          continue;
        }
        verified.push(freezeKnowledgeReference({
          ...normalized,
          sourceType: snapshot.sourceType,
          recordedAt: snapshot.recordedAt,
          ...(snapshot.publishedAt ? { publishedAt: snapshot.publishedAt } : {}),
          verificationStatus: "local_revision_verified"
        }));
      } catch {
        changedReferenceIds.push(reference.referenceId);
      }
    }
    if (
      references.length > MAX_KNOWLEDGE_REFERENCES
      || changedReferenceIds.length > 0
      || verified.length !== references.length
    ) {
      return {
        status: "source_changed",
        references: [],
        changedReferenceIds: Array.from(new Set(changedReferenceIds)),
        fixedResponse: KNOWLEDGE_SOURCE_CHANGED_RESPONSE
      };
    }
    return {
      status: "valid",
      references: verified.map(freezeKnowledgeReference)
    };
  }
}

/** Read-only Phase 3 retriever for the current Vault. */
export class KnowledgeRetriever {
  readonly vaultPath: string;
  readonly referenceBuilder: KnowledgeReferenceBuilder;
  readonly agentIndex?: KnowledgeAgentIndex;

  constructor(
    vaultPath: string,
    options: Readonly<{ agentIndex?: KnowledgeAgentIndex }> = {}
  ) {
    this.referenceBuilder = new KnowledgeReferenceBuilder(vaultPath);
    this.vaultPath = this.referenceBuilder.vaultPath;
    this.agentIndex = options.agentIndex;
    if (
      this.agentIndex
      && path.resolve(this.agentIndex.vaultPath) !== this.vaultPath
    ) {
      throw new KnowledgeRetrievalError(
        "invalid-path",
        "Knowledge Agent index belongs to another Vault"
      );
    }
  }

  async retrieve(
    request: Readonly<KnowledgeRetrievalRequest>
  ): Promise<KnowledgeRetrievalResult> {
    if (this.agentIndex) return await this.retrieveFromAgentIndex(request);
    const question = normalizeKnowledgeQuestion(request.question);
    const limit = normalizeKnowledgeReferenceLimit(request.limit);
    const explicitPaths = uniqueExplicitKnowledgePaths(request.explicitPaths ?? []);
    const includeUnrefined = Boolean(request.includeUnrefined);
    const candidates: KnowledgeCandidate[] = [];
    const explicitSet = new Set<string>();

    for (const explicitPath of explicitPaths) {
      const snapshot = await readKnowledgeSourceSnapshot(
        this.vaultPath,
        explicitPath,
        true
      );
      explicitSet.add(snapshot.vaultRelativePath);
      candidates.push({
        vaultRelativePath: snapshot.vaultRelativePath,
        score: Number.MAX_SAFE_INTEGER,
        explicit: true
      });
    }

    const discovered = await discoverKnowledgeMarkdownPaths(
      this.vaultPath,
      includeUnrefined
    );
    const searchQuestion = explicitPaths.reduce(
      (value, explicitPath) => value.replaceAll(explicitPath, " "),
      question
    );
    const terms = extractSearchTerms(searchQuestion);
    for (const relativePath of discovered) {
      if (explicitSet.has(relativePath)) continue;
      try {
        const snapshot = await readKnowledgeSourceSnapshot(
          this.vaultPath,
          relativePath,
          includeUnrefined
        );
        const score = scoreKnowledgeNote(
          question,
          terms,
          snapshot.vaultRelativePath,
          snapshot.title,
          snapshot.text.slice(0, CANDIDATE_SEARCH_CHAR_LIMIT)
        );
        if (score > 0) {
          candidates.push({
            vaultRelativePath: snapshot.vaultRelativePath,
            score,
            explicit: false
          });
        }
      } catch {
        // A failed live read invalidates this candidate; cached text is forbidden.
      }
    }

    const selected = candidates
      .sort((left, right) =>
        Number(right.explicit) - Number(left.explicit)
        || right.score - left.score
        || left.vaultRelativePath.localeCompare(right.vaultRelativePath)
      )
      .slice(0, limit);
    const references: KnowledgeReference[] = [];
    for (const candidate of selected) {
      try {
        references.push(await this.referenceBuilder.buildReference({
          vaultRelativePath: candidate.vaultRelativePath,
          question,
          allowUnrefined: candidate.explicit || includeUnrefined
        }));
      } catch (error) {
        if (candidate.explicit) throw error;
      }
    }

    if (references.length === 0) {
      return {
        status: "no_evidence",
        shouldInvokePi: false,
        references: [],
        fixedResponse: KNOWLEDGE_NO_EVIDENCE_RESPONSE
      };
    }
    return {
      status: "ready",
      shouldInvokePi: true,
      references
    };
  }

  async verifyReferences(
    references: readonly KnowledgeReference[]
  ): Promise<KnowledgeReferenceVerificationResult> {
    return await this.referenceBuilder.verifyReferences(references);
  }

  async refreshAgentIndex(): Promise<void> {
    await this.agentIndex?.refresh();
  }

  async searchAgentIndex(
    request: Readonly<KnowledgeAgentSearchRequest>
  ): Promise<KnowledgeAgentSearchResult> {
    if (!this.agentIndex) {
      throw new KnowledgeRetrievalError(
        "not-found",
        "Knowledge Agent index is not configured"
      );
    }
    return await this.agentIndex.search(request);
  }

  async readAgentIndex(input: Readonly<{
    vaultRelativePath: string;
    expectedContentRevision?: string;
  }>): Promise<KnowledgeAgentReadResult> {
    if (!this.agentIndex) {
      throw new KnowledgeRetrievalError(
        "not-found",
        "Knowledge Agent index is not configured"
      );
    }
    return await this.agentIndex.read(input);
  }

  private async retrieveFromAgentIndex(
    request: Readonly<KnowledgeRetrievalRequest>
  ): Promise<KnowledgeRetrievalResult> {
    const question = normalizeKnowledgeQuestion(request.question);
    const limit = normalizeKnowledgeReferenceLimit(request.limit);
    const explicitPaths = uniqueExplicitKnowledgePaths(
      request.explicitPaths ?? []
    );
    const references: KnowledgeReference[] = [];
    const localIssues: { vaultRelativePath: string; status: string }[] = [];
    const explicitSet = new Set<string>();
    for (const explicitPath of explicitPaths.slice(0, limit)) {
      try {
      const reference = await this.referenceBuilder.buildReference({
        vaultRelativePath: explicitPath,
        question,
        allowUnrefined: true
      });
      if (!explicitSet.has(reference.vaultRelativePath)) {
        explicitSet.add(reference.vaultRelativePath);
        if (!request.cursor) references.push(reference);
      }
      } catch (error) {
        if (!(error instanceof KnowledgeRetrievalError) || !["not-found", "source-changed", "not-markdown", "invalid-utf8"].includes(error.code)) throw error;
        localIssues.push({ vaultRelativePath: explicitPath, status: error.code });
      }
    }
    const indexedExplicitPaths = Array.from(explicitSet)
      .filter(isKnowledgeAgentIndexedPath);
    const searchQuestion = explicitPaths.reduce(
      (value, explicitPath) => value.replaceAll(explicitPath, " "),
      question
    ).trim();
    if (!searchQuestion && request.cursor) {
      throw new KnowledgeRetrievalError(
        "invalid-path",
        "Knowledge continuation requires the same non-empty search question"
      );
    }
    const search = searchQuestion
      ? await this.agentIndex!.search({
          query: searchQuestion,
          limit: request.cursor ? limit : limit - references.length,
          ...(indexedExplicitPaths.length
            ? { excludePaths: indexedExplicitPaths }
            : {}),
          ...(request.cursor ? { cursor: request.cursor } : {})
        })
      : emptyAgentIndexSearchResult();
    for (const hit of search.hits) {
      if (explicitSet.has(hit.vaultRelativePath)) continue;
      try {
        references.push(await this.referenceBuilder.buildReference({
          vaultRelativePath: hit.vaultRelativePath,
          question,
          allowUnrefined: hit.kind === "raw",
          expectedContentRevision: hit.contentRevision
        }));
      } catch (error) {
        if (!(error instanceof KnowledgeRetrievalError) || !["not-found", "source-changed", "not-markdown", "invalid-utf8"].includes(error.code)) throw error;
        localIssues.push({ vaultRelativePath: hit.vaultRelativePath, status: error.code });
      }
    }
    for (let i = 0; i < references.length; i += 1) {
      try {
        const related = await this.agentIndex!.related({ vaultRelativePath: references[i].vaultRelativePath, limit: 4 });
        if (related.contentRevision === references[i].contentRevision) references[i] = Object.freeze({ ...references[i], related, applicability: (() => { const hit = search.hits.find((candidate) => candidate.vaultRelativePath === references[i].vaultRelativePath); return hit ? { subjects: hit.subjects, applicableTime: hit.applicableTime, documentKind: hit.documentKind } : undefined; })() });
      } catch { /* A relationship enhancement never hides an already readable excerpt. */ }
    }
    const total = search.total + explicitSet.size;
    if (references.length === 0) {
      return {
        localIssues,
        status: "no_evidence",
        shouldInvokePi: true,
        references: [],
        fixedResponse: KNOWLEDGE_NO_EVIDENCE_RESPONSE,
        total,
        returned: 0,
        remaining: search.remaining,
        hasMore: search.hasMore,
        exhausted: search.exhausted,
        ...(search.continuationCursor
          ? { continuationCursor: search.continuationCursor }
          : {})
      };
    }
    return {
      localIssues,
      status: "ready",
      shouldInvokePi: true,
      references,
      total,
      returned: references.length,
      remaining: search.remaining,
      hasMore: search.hasMore,
      exhausted: search.exhausted,
      ...(search.continuationCursor
        ? { continuationCursor: search.continuationCursor }
        : {})
    };
  }
}

export function formatKnowledgeReferencesForPrompt(
  references: readonly KnowledgeReference[]
): string {
  return references.slice(0, MAX_KNOWLEDGE_REFERENCES).map(
    (reference, index) => [
      `### ${index + 1}. ${reference.title}`,
      `来源：${reference.vaultRelativePath}`,
      `行号：${reference.lineStart}-${reference.lineEnd}；${reference.totalLines === undefined ? "正文范围未完整核验" : `全文 ${reference.totalLines} 行`}；${reference.hasMore === false ? "已交付全文" : "仅交付片段，可按需 knowledge_read 续读"}`,
      `版本：${reference.contentRevision}`,
      `来源类型：${reference.sourceType ?? "unknown"}`,
      `记录时间：${reference.recordedAt === undefined ? "unknown" : new Date(reference.recordedAt).toISOString()}`,
      `发布时间：${reference.publishedAt ?? "未声明"}`,
      `核验状态：${reference.verificationStatus ?? "unknown"}；未表示已联网核验`,
      ...(reference.applicability ? [`适用信息（资料声明）：${JSON.stringify(reference.applicability)}`] : []),
      ...(reference.related ? [`关联候选（由整篇链接生成，不代表已读关联正文；mode=related 可续查）：${JSON.stringify(reference.related)}`] : []),
      "原文：",
      reference.excerpt
    ].join("\n")
  ).join("\n\n");
}

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

async function discoverKnowledgeMarkdownPaths(
  vaultPath: string,
  includeUnrefined: boolean
): Promise<string[]> {
  const vaultRoot = await resolveKnowledgeVaultRoot(vaultPath);
  const result: string[] = [];
  const walk = async (directoryPath: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (directoryPath === vaultRoot) throw error;
      return;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (isHiddenKnowledgeName(entry.name)) continue;
      const absolutePath = path.join(directoryPath, entry.name);
      let stat: Awaited<ReturnType<typeof fsp.lstat>>;
      try {
        stat = await fsp.lstat(absolutePath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      const relativePath = toVaultRelativePath(vaultRoot, absolutePath);
      if (stat.isDirectory()) {
        if (!includeUnrefined && isUnrefinedKnowledgePath(relativePath)) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!isKnowledgeMarkdownPath(relativePath)) continue;
      try {
        result.push(normalizeKnowledgeRelativePath(
          relativePath,
          includeUnrefined
        ));
      } catch {
        // Hidden, runtime or otherwise forbidden files never become candidates.
      }
    }
  };
  await walk(vaultRoot);
  return Array.from(new Set(result)).sort((left, right) =>
    left.localeCompare(right)
  );
}

async function readKnowledgeSourceSnapshot(
  vaultPath: string,
  requestedRelativePath: string,
  allowUnrefined: boolean
): Promise<KnowledgeSourceSnapshot> {
  const normalizedRequested = normalizeKnowledgeRelativePath(
    resolveKnowledgePath(vaultPath, requestedRelativePath, false),
    allowUnrefined
  );
  const vaultRoot = await resolveKnowledgeVaultRoot(vaultPath);
  const requestedAbsolutePath = path.resolve(
    vaultRoot,
    ...normalizedRequested.split("/")
  );
  assertPathWithinVault(vaultRoot, requestedAbsolutePath, normalizedRequested);
  await assertNoSymbolicLinkSegments(
    vaultRoot,
    normalizedRequested,
    requestedAbsolutePath
  );
  let realFilePath: string;
  try {
    realFilePath = await fsp.realpath(requestedAbsolutePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new KnowledgeRetrievalError(
        "not-found",
        `Vault 来源不存在：${normalizedRequested}`,
        normalizedRequested
      );
    }
    throw error;
  }
  assertPathWithinVault(vaultRoot, realFilePath, normalizedRequested);
  const canonicalRelativePath = normalizeKnowledgeRelativePath(
    toVaultRelativePath(vaultRoot, realFilePath),
    allowUnrefined
  );
  const stat = await fsp.lstat(realFilePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new KnowledgeRetrievalError(
      "not-regular-file",
      `Vault 来源不是普通文件：${canonicalRelativePath}`,
      canonicalRelativePath
    );
  }
  if (!isKnowledgeMarkdownPath(canonicalRelativePath)) {
    throw new KnowledgeRetrievalError(
      "not-markdown",
      `Knowledge Retrieval 只读取普通 Markdown：${canonicalRelativePath}`,
      canonicalRelativePath
    );
  }
  const bytes = await fsp.readFile(realFilePath);
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new KnowledgeRetrievalError(
      "invalid-utf8",
      `Markdown 不是合法 UTF-8：${canonicalRelativePath}`,
      canonicalRelativePath
    );
  }
  const lines = splitKnowledgeLines(text);
  return {
    vaultRelativePath: canonicalRelativePath,
    title: knowledgeReferenceTitle(canonicalRelativePath, lines),
    bytes,
    lines,
    text,
    contentRevision: knowledgeContentRevision(bytes),
    sourceType: knowledgeSourceType(canonicalRelativePath),
    recordedAt: stat.mtimeMs,
    ...(frontmatterPublishedAt(lines)
      ? { publishedAt: frontmatterPublishedAt(lines)! }
      : {})
  };
}

function knowledgeSourceType(
  relativePath: string
): "wiki" | "projects" | "raw" {
  const root = knowledgeRootRole(relativePath);
  if (root === "wiki" || root === "projects" || root === "raw") return root;
  return "raw";
}

function frontmatterPublishedAt(lines: readonly string[]): string | null {
  if (lines[0]?.trim() !== "---") return null;
  for (const line of lines.slice(1, 80)) {
    if (line.trim() === "---") break;
    const match = line.match(/^(?:published|publishedAt|date)\s*:\s*["']?([^"']+?)["']?\s*$/iu);
    if (match?.[1] && /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.+\-Z]+)?$/u.test(match[1].trim())) {
      return match[1].trim();
    }
  }
  return null;
}

async function assertNoSymbolicLinkSegments(
  vaultRoot: string,
  relativePath: string,
  absolutePath: string
): Promise<void> {
  const segments = relativePath.split("/");
  let candidate = vaultRoot;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    let stat: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      stat = await fsp.lstat(candidate);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        throw new KnowledgeRetrievalError(
          "not-found",
          `Vault 来源不存在：${relativePath}`,
          relativePath
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new KnowledgeRetrievalError(
        "not-regular-file",
        `拒绝符号链接 Knowledge 来源：${relativePath}`,
        relativePath
      );
    }
  }
  if (path.resolve(candidate) !== path.resolve(absolutePath)) {
    throw new KnowledgeRetrievalError(
      "forbidden-path",
      `拒绝不一致的 Knowledge 路径：${relativePath}`,
      relativePath
    );
  }
}

async function resolveKnowledgeVaultRoot(vaultPath: string): Promise<string> {
  const resolved = path.resolve(vaultPath);
  let realVaultPath: string;
  try {
    realVaultPath = await fsp.realpath(resolved);
  } catch (error) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      `当前 Vault 路径不可用：${resolved}`
    );
  }
  const stat = await fsp.lstat(realVaultPath);
  if (!stat.isDirectory()) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      `当前 Vault 路径不是目录：${resolved}`
    );
  }
  return realVaultPath;
}

function normalizeKnowledgeRelativePath(
  value: string,
  allowUnrefined: boolean
): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      "Knowledge 来源必须是非空 Vault 相对路径"
    );
  }
  const slashed = value.trim().replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(slashed)
    || /^[a-z]:\//iu.test(slashed)
  ) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      `拒绝绝对 Knowledge 路径：${value}`,
      value
    );
  }
  const segments = slashed.split("/");
  if (
    segments.some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      `拒绝越界或不规范 Knowledge 路径：${value}`,
      value
    );
  }
  if (segments.some(isHiddenKnowledgeName)) {
    throw new KnowledgeRetrievalError(
      "forbidden-path",
      `拒绝隐藏目录、插件数据或运行状态：${value}`,
      value
    );
  }
  const normalized = segments.join("/");
  if (!allowUnrefined && isUnrefinedKnowledgePath(normalized)) {
    throw new KnowledgeRetrievalError(
      "forbidden-path",
      `Raw/Inbox 只有用户明确点名时才可检索：${normalized}`,
      normalized
    );
  }
  if (!isKnowledgeMarkdownPath(normalized)) {
    throw new KnowledgeRetrievalError(
      "not-markdown",
      `Knowledge Retrieval 只读取普通 Markdown：${normalized}`,
      normalized
    );
  }
  return normalized;
}

function assertPathWithinVault(
  vaultRoot: string,
  candidatePath: string,
  relativePath: string
): void {
  const relative = path.relative(vaultRoot, candidatePath);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new KnowledgeRetrievalError(
      "forbidden-path",
      `拒绝 Vault 外路径或符号链接逃逸：${relativePath}`,
      relativePath
    );
  }
}

function toVaultRelativePath(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
}

function isHiddenKnowledgeName(name: string): boolean {
  return name.startsWith(".") || name === ".DS_Store";
}

function isUnrefinedKnowledgePath(relativePath: string): boolean {
  const first = knowledgeRootRole(relativePath);
  return first === "raw" || first === "inbox";
}

function isKnowledgeMarkdownPath(relativePath: string): boolean {
  return KNOWLEDGE_MARKDOWN_EXTENSIONS.has(
    path.posix.extname(relativePath).toLowerCase()
  );
}

function splitKnowledgeLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/u);
  return lines.length > 0 ? lines : [""];
}

function knowledgeReferenceTitle(
  relativePath: string,
  lines: readonly string[]
): string {
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1]) return match[1];
  }
  return path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function selectReferenceLineRange(
  lines: readonly string[],
  question: string
): { lineStart: number; lineEnd: number } {
  const terms = extractSearchTerms(question);
  const structuredAnswerIndex = lines.findIndex((line, index) =>
    /^\s*(?:answer|答案)\s*[:：]/iu.test(line)
    && index > 0
    && /^\s*(?:question|问题)\s*[:：]/iu.test(lines[index - 1] ?? "")
    && lineMatchesTerms(lines[index - 1] ?? "", terms)
  );
  let hitIndex = structuredAnswerIndex >= 0
    ? structuredAnswerIndex
    : lines.findIndex((line) => lineMatchesTerms(line, terms));
  if (hitIndex < 0) hitIndex = lines.findIndex((line) => line.trim().length > 0);
  if (hitIndex < 0) hitIndex = 0;
  if (
    /^\s*(?:question|问题)\s*[:：]/iu.test(lines[hitIndex] ?? "")
    && /^\s*(?:answer|答案)\s*[:：]/iu.test(lines[hitIndex + 1] ?? "")
  ) {
    hitIndex += 1;
  }
  return {
    lineStart: hitIndex + 1,
    lineEnd: hitIndex + 1
  };
}

function knowledgeContentRevision(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function knowledgeReferenceId(
  relativePath: string,
  contentRevision: string,
  lineStart: number,
  lineEnd: number
): string {
  const hash = createHash("sha256")
    .update(relativePath, "utf8")
    .update("\0", "utf8")
    .update(contentRevision, "utf8")
    .update("\0", "utf8")
    .update(`${lineStart}:${lineEnd}`, "utf8")
    .digest("hex");
  return `knowledge-reference:${hash}`;
}

function normalizeKnowledgeReference(
  reference: KnowledgeReference
): KnowledgeReference {
  if (
    !reference
    || typeof reference !== "object"
    || typeof reference.referenceId !== "string"
    || !/^knowledge-reference:[a-f0-9]{64}$/u.test(reference.referenceId)
    || typeof reference.vaultRelativePath !== "string"
    || typeof reference.title !== "string"
    || typeof reference.excerpt !== "string"
    || typeof reference.contentRevision !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(reference.contentRevision)
    || !Number.isSafeInteger(reference.lineStart)
    || !Number.isSafeInteger(reference.lineEnd)
    || reference.lineStart < 1
    || reference.lineEnd < reference.lineStart
    || (reference.sourceType !== undefined
      && reference.sourceType !== "wiki"
      && reference.sourceType !== "projects"
      && reference.sourceType !== "raw")
    || (reference.recordedAt !== undefined
      && (!Number.isFinite(reference.recordedAt) || reference.recordedAt < 0))
    || (reference.publishedAt !== undefined
      && (typeof reference.publishedAt !== "string"
        || reference.publishedAt.length > 100
        || /[\r\n]/u.test(reference.publishedAt)))
    || (reference.verificationStatus !== undefined
      && reference.verificationStatus !== "local_revision_verified"
      && reference.verificationStatus !== "source_link_changed")
  ) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      "KnowledgeReference 结构无效"
    );
  }
  return freezeKnowledgeReference({ ...reference });
}

function freezeKnowledgeReference(
  reference: KnowledgeReference
): KnowledgeReference {
  return Object.freeze({ ...reference });
}

function normalizeKnowledgeQuestion(question: string): string {
  if (typeof question !== "string" || !question.trim()) {
    throw new KnowledgeRetrievalError(
      "invalid-path",
      "Knowledge Retrieval 需要非空问题"
    );
  }
  return question.trim();
}

function normalizeKnowledgeReferenceLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_REFERENCE_LIMIT;
  }
  return Math.min(MAX_KNOWLEDGE_REFERENCES, Math.floor(limit));
}

function uniqueExplicitKnowledgePaths(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const relativePath of paths) {
    result.add(normalizeKnowledgeRelativePath(relativePath, true));
  }
  return Array.from(result);
}

function isKnowledgeAgentIndexedPath(relativePath: string): boolean {
  const root = knowledgeRootRole(relativePath);
  return root === "wiki" || root === "projects" || root === "raw";
}

function emptyAgentIndexSearchResult(): KnowledgeAgentSearchResult {
  return Object.freeze({
    generation: 0,
    total: 0,
    returned: 0,
    remaining: 0,
    hasMore: false,
    exhausted: true,
    hits: Object.freeze([]) as unknown as KnowledgeAgentSearchResult["hits"]
  });
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === code;
}
