import type { BodySearchCoverage, BodySearchDocument, BodySearchHit, BodySearchMemoryOptions, BodySearchMemoryPort, BodySearchOptions, BodySearchRequest, BodySearchResult } from "./contracts";
import { buildSearchDictionary, iterateSearchTokens, tokenizeSearchText } from "./tokenize";
import { yieldSearchTask as yieldToUi } from "./scheduling";

interface Heading { heading: string; line: number; level: number }
interface Fragment {
  start: number;
  end: number;
  frequencies: Map<string, number>;
}
interface Evidence {
  lineStart: number;
  lineEnd: number;
  columnStart?: number;
  columnEnd?: number;
  excerpt: string;
}
interface IndexedSection {
  sectionTitle: string;
  sectionStart: number;
  sectionEnd: number;
  totalLines: number;
  text: string;
  fragments: readonly Fragment[];
  fragmentFrequency: Map<string, number>;
  length: number;
  frequencies: Map<string, number>;
}
interface DocumentStatistics {
  contentRevision: string;
  sections: readonly IndexedSection[];
  titleTerms: Set<string>;
  tagTerms: Set<string>;
  characters: number;
  tokenEntries: number;
}
interface Section extends IndexedSection {
  document: BodySearchDocument;
  contentRevision: string;
  journalDate?: string;
  titleTerms: Set<string>;
  tagTerms: Set<string>;
}
interface PreparedSearch {
  documents: readonly BodySearchDocument[];
  dictionary: readonly string[];
  queryWeights: readonly Map<string, number>[];
  queries: readonly Set<string>[];
  union: Set<string>;
  coverage: BodySearchCoverage;
}
interface SearchCacheHooks {
  get(document: BodySearchDocument): DocumentStatistics | undefined;
  stage(document: BodySearchDocument, statistics: DocumentStatistics): void;
  check(document?: BodySearchDocument): void;
}
interface CachedDocument {
  key: string;
  statistics: DocumentStatistics;
}

const MAX_FRAGMENT_CHARACTERS = 2400;
const MAX_FRAGMENT_LINES = 24;
const EMPTY_DICTIONARY: readonly string[] = [];

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Knowledge search aborted");
    error.name = "AbortError";
    throw error;
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function calendarDate(value?: string): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function journalDate(document: BodySearchDocument): string | undefined {
  if (document.kind !== "journal") return undefined;
  const basename = document.vaultRelativePath.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  return calendarDate(basename.match(/^(\d{4}-\d{2}-\d{2})(?:\.md|[ _].*\.md)$/iu)?.[1]);
}

function parseHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: { character: string; length: number } | undefined;
  let frontmatter = lines[0]?.trim() === "---";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line)) frontmatter = false;
      continue;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const atx = line.match(/^ {0,3}(#{1,6})(?:[\t ]+(.+?)|[\t ]*)$/u);
    if (atx) {
      headings.push({ heading: (atx[2] ?? "").replace(/[\t ]+#+[\t ]*$/u, "").trim(), line: index + 1, level: atx[1].length });
      continue;
    }
    if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/u.test(line) && lines[index - 1].trim()
      && !/^\s*(?:[-*+]>?|>|#{1,6}\s|`{3,}|~{3,})/u.test(lines[index - 1])
      && headings.at(-1)?.line !== index) {
      headings.push({ heading: lines[index - 1].trim(), line: index, level: line.trim()[0] === "=" ? 1 : 2 });
    }
  }
  return headings;
}

function currentHeadings(document: BodySearchDocument, lines: readonly string[]): readonly Heading[] {
  // A structural pass also catches omitted/new headings and headings inside code fences.
  const parsed = parseHeadings(lines);
  const cached = document.headings;
  if (cached?.length === parsed.length && cached.every((heading, index) => {
    const actual = parsed[index];
    return heading.line === actual.line && heading.level === actual.level && heading.heading === actual.heading;
  })) return cached;
  return parsed;
}

function fragmentRanges(text: string): Fragment[] {
  const fragments: Fragment[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + MAX_FRAGMENT_CHARACTERS);
    let lineCount = 0;
    let lastNewline = -1;
    for (let index = start; index < end; index++) {
      if (text[index] === "\n") {
        lastNewline = index;
        if (++lineCount === MAX_FRAGMENT_LINES) { end = index + 1; break; }
      }
    }
    if (end < text.length && lastNewline > start && lineCount < MAX_FRAGMENT_LINES) end = lastNewline + 1;
    fragments.push({ start, end, frequencies: new Map() });
    start = end;
  }
  return fragments;
}

function rangeIndex(ranges: readonly { start: number }[], position: number): number {
  let low = 0;
  let high = ranges.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].start <= position) low = middle;
    else high = middle;
  }
  return low;
}

function evidenceFor(text: string, fragment: Fragment, sectionStart: number, sectionEnd: number): Evidence {
  // Include immediate neighbours, while bounding long single-line notes on both sides.
  let start = fragment.start;
  let end = fragment.end;
  for (let count = 0; count < 2 && start > 0; count++) {
    const preceding = text.lastIndexOf("\n", Math.max(0, start - 2));
    start = Math.max(fragment.start - 400, preceding < 0 ? 0 : preceding + 1);
  }
  for (let count = 0; count < 2 && end < text.length; count++) {
    const following = text.indexOf("\n", end);
    end = Math.min(fragment.end + 400, following < 0 ? text.length : following + 1);
  }
  const before = text.slice(0, start).match(/\n/gu)?.length ?? 0;
  const lineStart = sectionStart + before;
  const actualEnd = text[end - 1] === "\n" ? end - 1 : end;
  const excerpt = text.slice(start, actualEnd);
  const lineEnd = Math.min(sectionEnd, lineStart + (excerpt.match(/\n/gu)?.length ?? 0));
  const columnStart = start === 0 ? 0 : start - (text.lastIndexOf("\n", start - 1) + 1);
  const columnEnd = actualEnd - (text.lastIndexOf("\n", actualEnd - 1) + 1);
  const wholeLines = columnStart === 0 && (actualEnd === text.length || text[actualEnd] === "\n");
  return { lineStart, lineEnd, excerpt, ...(!wholeLines ? { columnStart, columnEnd } : {}) };
}

async function buildDocumentStatistics(document: BodySearchDocument, content: string, contentRevision: string, dictionary: readonly string[], signal?: AbortSignal): Promise<DocumentStatistics> {
  const lines = content.split(/\r\n|\n|\r/u);
  const headings = currentHeadings(document, lines);
  const ranges: { title: string; start: number; end: number }[] = [];
  if (!headings.length || headings[0].line > 1) ranges.push({ title: document.title, start: 1, end: headings[0] ? headings[0].line - 1 : lines.length });
  for (let index = 0; index < headings.length; index++) {
    ranges.push({ title: headings[index].heading, start: headings[index].line, end: headings[index + 1] ? headings[index + 1].line - 1 : lines.length });
  }
  const titleTerms = new Set<string>();
  for (const title of [document.title, ...(document.aliases ?? [])]) {
    for (const token of tokenizeSearchText(title, dictionary)) titleTerms.add(token);
  }
  const tagTerms = new Set(tokenizeSearchText((document.tags ?? []).join("\n"), dictionary));
  const sections: IndexedSection[] = [];
  let characters = 0;
  let tokenEntries = titleTerms.size + tagTerms.size;
  for (const range of ranges) {
    checkAbort(signal);
    const text = lines.slice(range.start - 1, range.end).join("\n");
    if (!text.trim()) continue;
    const fragments = fragmentRanges(text);
    const frequencies = new Map<string, number>();
    let length = 0;
    for (const result of iterateSearchTokens(text, dictionary)) {
      if (!result) { await yieldToUi(signal); continue; }
      if ((++length & 255) === 0) checkAbort(signal);
      if ((length & 8191) === 0) await yieldToUi(signal);
      const { token, start } = result;
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      const fragment = fragments[rangeIndex(fragments, start)];
      fragment.frequencies.set(token, (fragment.frequencies.get(token) ?? 0) + 1);
    }
    const fragmentFrequency = new Map<string, number>();
    for (const fragment of fragments) {
      for (const token of fragment.frequencies.keys()) fragmentFrequency.set(token, (fragmentFrequency.get(token) ?? 0) + 1);
    }
    sections.push({ sectionTitle: range.title, sectionStart: range.start, sectionEnd: range.end, totalLines: lines.length,
      text, fragments, fragmentFrequency, length: Math.max(1, length), frequencies });
    characters += text.length;
    tokenEntries += frequencies.size + fragmentFrequency.size + fragments.reduce((count, fragment) => count + fragment.frequencies.size, 0);
    if (sections.length % 16 === 0 || text.length >= 32_000) await yieldToUi(signal);
  }
  return { contentRevision, sections, titleTerms, tagTerms, characters, tokenEntries };
}

function sectionEvidence(section: IndexedSection, query: ReadonlySet<string>): Evidence {
  const { fragments, fragmentFrequency } = section;
  let best = fragments[0];
  let bestScore = -1;
  for (const fragment of fragments) {
    let score = 0;
    for (const token of query) {
      const count = fragment.frequencies.get(token) ?? 0;
      if (count) {
        const frequency = fragmentFrequency.get(token) ?? 0;
        const rarity = Math.log(1 + (fragments.length - frequency + 0.5) / (frequency + 0.5));
        score += rarity * count * 2.2 / (count + 1.2);
      }
    }
    if (score > bestScore) { bestScore = score; best = fragment; }
  }
  return evidenceFor(section.text, best, section.sectionStart, section.sectionEnd);
}

function queryTexts(request: BodySearchRequest): string[] {
  const supplied = request.queries?.length ? request.queries : request.query ? [request.query] : [];
  if (supplied.length > 5) throw new Error("Knowledge search accepts at most five queries");
  return [...new Set(supplied.map((query) => query.trim()).filter(Boolean))];
}

function tokenTermWeights(text: string, dictionary: readonly string[]): Map<string, number> {
  const tokens = [...iterateSearchTokens(text, dictionary)].filter((token) => token !== undefined);
  const chineseWords = tokens.filter((token) => token.kind === "word" && /\p{Script=Han}/u.test(token.token));
  const weights = new Map<string, number>();
  for (const token of tokens) {
    let weight = 1;
    if (token.kind === "bigram" && chineseWords.length) {
      const word = chineseWords.find((word) => token.start >= word.start && token.end <= word.end);
      // Bigrams inside one word share a fallback budget. Cross-word pairs still recall
      // material, but cannot each act as a separate rare topic (e.g. a suffix + noun).
      weight = word ? 1 / Math.max(1, (word.token.match(/\p{Script=Han}/gu)?.length ?? 2) - 1) : 0.1;
    }
    weights.set(token.token, Math.max(weights.get(token.token) ?? 0, weight));
  }
  // With no Chinese segmenter/dictionary words, retain full Chinese fallback weight;
  // an English word or dotted version in a mixed query must not weaken that fallback.
  return weights;
}

function normalizedSearchName(text: string): string { return text.normalize("NFKC").trim().toLowerCase(); }

function queryTermWeights(text: string, dictionary: readonly string[], exactNames: ReadonlySet<string>): Map<string, number> {
  const weights = tokenTermWeights(text, dictionary);
  const name = normalizedSearchName(text);
  if (exactNames.has(name) || exactNames.has(name.replace(/[?？。.!！]+$/u, "").trim())) return weights;
  const boilerplate = ["我", "我的", "关于", "有关", "的", "笔记", "记录", "资料", "文章", "哪些", "什么", "有没有", "找一下", "相关", "方面"];
  const signals = new Set(boilerplate);
  const weakenBoilerplate = (input: string, inputWeights: Map<string, number>) => {
    const tokens = [...iterateSearchTokens(input, dictionary)].filter(token => token !== undefined);
    const names = tokens.filter(token => token.kind === "word" && Array.from(token.token).length > 2 && !signals.has(token.token));
    const protectedTerms = new Set(tokens.filter(token => names.some(word => token.start >= word.start && token.end <= word.end)).map(token => token.token));
    const covered = new Set<number>();
    for (const phrase of boilerplate) {
      for (let start = input.indexOf(phrase); start >= 0; start = input.indexOf(phrase, start + 1)) {
        for (let offset = start; offset < start + phrase.length; offset++) covered.add(offset);
      }
    }
    const weakTerms = new Set<string>();
    for (const token of tokens) {
      if (protectedTerms.has(token.token)) continue;
      let coveredCharacters = 0;
      for (let offset = token.start; offset < token.end; offset++) if (covered.has(offset)) coveredCharacters++;
      if (signals.has(token.token) || coveredCharacters === token.end - token.start
        || (token.kind === "bigram" && coveredCharacters > 0)) weakTerms.add(token.token);
    }
    // Keep every signal searchable. A short phrase must not weaken the complete
    // recognized name containing it (or that name's necessary partial-match terms).
    for (const token of weakTerms) inputWeights.set(token, inputWeights.get(token)! * 0.1);
    return inputWeights;
  };
  const adjusted = weakenBoilerplate(text, new Map(weights));
  const topic = text.trim().match(/^(?:我(?:的)?\s*)?(?:关于|有关)\s*(.+?)\s*的\s*(?:笔记|记录|资料|文章)\s*(?:有哪些)?\s*[?？。.!！]*$/u)?.[1]?.trim();
  if (!topic) return adjusted;
  const originalTopicWeights = tokenTermWeights(topic, dictionary);
  if (!originalTopicWeights.size) return adjusted;
  // This optional syntax also disambiguates an explicitly requested topic such as
  // "notes" itself; the general signal handling above does not depend on word order.
  const topicWeights = boilerplate.includes(normalizedSearchName(topic)) ? originalTopicWeights : weakenBoilerplate(topic, originalTopicWeights);
  // The wording around a requested topic describes the lookup, rather than a second
  // subject. Preserve it as weak fallback evidence; names and topic parts use the
  // same tokenizer and weights as a direct topic query.
  for (const [token, weight] of weights) adjusted.set(token, Math.min(adjusted.get(token) ?? weight, weight * 0.1));
  for (const [token, weight] of topicWeights) adjusted.set(token, Math.max(weight, adjusted.get(token) ?? 0));
  return adjusted;
}

function prepareSearch(options: BodySearchOptions): PreparedSearch {
  const { request } = options;
  checkAbort(request.signal);
  const texts = queryTexts(request);
  const dateFrom = calendarDate(request.dateFrom);
  const dateTo = calendarDate(request.dateTo);
  if ((request.dateFrom && !dateFrom) || (request.dateTo && !dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) throw new Error("Invalid knowledge search date range");
  const kinds = request.kinds ? new Set(request.kinds) : undefined;
  const excluded = new Set(request.excludePaths ?? []);
  const seen = new Set<string>();
  const exactNames = new Set<string>();
  let unknownJournalDates = 0;
  const documents = options.documents.filter((document) => {
    if (seen.has(document.vaultRelativePath) || excluded.has(document.vaultRelativePath) || (kinds && !kinds.has(document.kind))) return false;
    seen.add(document.vaultRelativePath);
    const date = journalDate(document);
    if (document.kind === "journal" && !date) unknownJournalDates++;
    if (document.kind === "journal" && (dateFrom || dateTo)) {
      if (!date || (dateFrom && date < dateFrom) || (dateTo && date > dateTo)) return false;
    }
    for (const title of [document.title, ...(document.aliases ?? [])]) exactNames.add(normalizedSearchName(title));
    return true;
  });
  const coverage: BodySearchCoverage = { totalFiles: documents.length, scannedFiles: 0, readFiles: 0, cachedFiles: 0, indexedFiles: 0,
    failedFiles: 0, complete: !(unknownJournalDates && (dateFrom || dateTo)), unknownJournalDates };
  const dictionary = buildSearchDictionary(documents);
  const queryWeights = texts.map((query) => queryTermWeights(query, dictionary, exactNames)).filter((tokens) => tokens.size);
  const queries = queryWeights.map((weights) => new Set(weights.keys()));
  const union = new Set(queries.flatMap((query) => [...query]));
  return { documents, dictionary, queryWeights, queries, union, coverage };
}

async function executeSearch(options: BodySearchOptions, prepared: PreparedSearch, cache?: SearchCacheHooks): Promise<BodySearchResult> {
  const { request } = options;
  const { documents, dictionary, queryWeights, queries, union } = prepared;
  const coverage = { ...prepared.coverage };
  if (!queries.length) return { hits: [], total: 0, coverage: { ...coverage, complete: coverage.totalFiles === 0 && coverage.complete } };
  const sections: Section[] = [];
  let scannedSections = 0;
  let freshFilesSinceYield = 0;
  let filesSinceYield = 0;
  for (let index = 0; index < documents.length; index++) {
    checkAbort(request.signal);
    cache?.check();
    const document = documents[index];
    try {
      let statistics = cache?.get(document);
      if (statistics) coverage.cachedFiles++;
      else {
        coverage.readFiles++;
        const { content, contentRevision } = await document.read();
        checkAbort(request.signal);
        cache?.check(document);
        coverage.scannedFiles++;
        statistics = await buildDocumentStatistics(document, content, contentRevision, dictionary, request.signal);
        cache?.check(document);
        cache?.stage(document, statistics);
        scannedSections += statistics.sections.length;
        freshFilesSinceYield++;
      }
      for (const section of statistics.sections) sections.push({ ...section, document, contentRevision: statistics.contentRevision,
        journalDate: journalDate(document), titleTerms: statistics.titleTerms, tagTerms: statistics.tagTerms });
      coverage.indexedFiles++;
    } catch (error) {
      checkAbort(request.signal);
      if (isAbort(error) || isIndexStateError(error)) throw error;
      coverage.failedFiles++;
      coverage.complete = false;
    }
    if (++filesSinceYield >= 256 || freshFilesSinceYield >= 16 || scannedSections >= 64) {
      await yieldToUi(request.signal);
      scannedSections = 0;
      freshFilesSinceYield = 0;
      filesSinceYield = 0;
    }
  }
  const df = new Map<string, number>();
  const collectionFrequency = new Map<string, number>();
  let totalLength = 0;
  for (let index = 0; index < sections.length; index++) {
    checkAbort(request.signal);
    const section = sections[index];
    totalLength += section.length;
    for (const term of union) {
      if (section.frequencies.has(term) || section.titleTerms.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
      collectionFrequency.set(term, (collectionFrequency.get(term) ?? 0) + (section.frequencies.get(term) ?? 0));
    }
    if ((index + 1) % 256 === 0) await yieldToUi(request.signal);
  }
  const averageLength = totalLength / Math.max(1, sections.length);
  const recentPaths = new Set(options.recentPaths ?? EMPTY_DICTIONARY);
  const ranked: { section: Section; score: number; query: number }[][] = [];
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
    const query = queries[queryIndex];
    const results: { section: Section; score: number; query: number }[] = [];
    for (let index = 0; index < sections.length; index++) {
      checkAbort(request.signal);
      const section = sections[index];
      let score = 0;
      let tagMatches = 0;
      for (const term of query) {
        const frequency = (section.frequencies.get(term) ?? 0) + (section.titleTerms.has(term) ? 1.5 : 0);
        const inverseFrequency = Math.log(1 + (sections.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        if (frequency) {
          // DF alone mistakes terms repeated many times in a few sections for rare
          // evidence. Discount that burstiness using only this scan's query statistics.
          // One heading occurrence plus one body occurrence is ordinary evidence,
          // rather than the concentrated repetition this discount is meant to resist.
          const repetitionsPerSection = (collectionFrequency.get(term) ?? 0) / (2 * Math.max(1, df.get(term) ?? 0));
          const burstWeight = 1 / (1 + Math.log(Math.max(1, repetitionsPerSection)));
          score += (queryWeights[queryIndex].get(term) ?? 1) * burstWeight * inverseFrequency * frequency * 2.2
            / (frequency + 1.2 * (0.25 + 0.75 * section.length / Math.max(1, averageLength)));
          // A named topic in a title/alias is independent of the chapter's length.
          // Keep this field bonus bounded and equal for titles and aliases.
          if (section.titleTerms.has(term)) score += 0.5 * (queryWeights[queryIndex].get(term) ?? 1) * inverseFrequency;
        }
        if (section.tagTerms.has(term)) tagMatches++;
      }
      if (score > 0) {
        // Contextual hints have a combined ceiling below 5%; category and mtime never boost rank.
        score *= 1 + 0.02 * tagMatches / query.size + (options.activePath === section.document.vaultRelativePath ? 0.015 : 0)
          + (recentPaths.has(section.document.vaultRelativePath) ? 0.01 : 0);
        results.push({ section, score, query: queryIndex });
      }
      if ((index + 1) % 128 === 0) await yieldToUi(request.signal);
    }
    results.sort((left, right) => right.score - left.score || left.section.document.vaultRelativePath.localeCompare(right.section.document.vaultRelativePath) || left.section.sectionStart - right.section.sectionStart);
    ranked.push(results);
  }
  const fused = new Map<Section, { section: Section; score: number; query: number; bestRank: number }>();
  for (const ranking of ranked) {
    for (let rank = 0; rank < ranking.length; rank++) {
      checkAbort(request.signal);
      const result = ranking[rank];
      const existing = fused.get(result.section);
      const score = ranked.length === 1 ? result.score : 1 / (60 + rank + 1);
      if (existing) {
        existing.score += score;
        if (rank < existing.bestRank) { existing.query = result.query; existing.bestRank = rank; }
      } else fused.set(result.section, { ...result, score, bestRank: rank });
    }
  }
  const ordered = [...fused.values()].sort((left, right) => right.score - left.score || left.bestRank - right.bestRank
    || left.section.document.vaultRelativePath.localeCompare(right.section.document.vaultRelativePath) || left.section.sectionStart - right.section.sectionStart);
  const offset = Number.isFinite(request.offset) ? Math.max(0, Math.trunc(request.offset!)) : 0;
  const limit = Number.isFinite(request.limit) ? Math.max(0, Math.min(100, Math.trunc(request.limit!))) : 8;
  const hits: BodySearchHit[] = ordered.slice(offset, offset + limit).map(({ section, score, query }) => ({
    vaultRelativePath: section.document.vaultRelativePath,
    title: section.document.title,
    kind: section.document.kind,
    recordedAt: section.document.recordedAt,
    contentRevision: section.contentRevision,
    sectionTitle: section.sectionTitle,
    totalLines: section.totalLines,
    ...sectionEvidence(section, queries[query]),
    score,
    ...(section.journalDate ? { journalDate: section.journalDate } : {}),
  }));
  checkAbort(request.signal);
  cache?.check();
  coverage.complete = coverage.complete && coverage.indexedFiles === coverage.totalFiles && coverage.failedFiles === 0;
  return { hits, total: ordered.length, coverage };
}

/** A single scan with no statistics retained across calls. */
export async function searchBodyDocuments(options: BodySearchOptions): Promise<BodySearchResult> {
  return executeSearch(options, prepareSearch(options));
}

function indexStateError(code: "search_index_stale" | "search_index_disposed"): Error {
  return Object.assign(new Error(code === "search_index_disposed" ? "Knowledge search index was disposed" : "Knowledge search changed while indexing"), { code });
}

function isIndexStateError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "search_index_stale" || error.code === "search_index_disposed");
}

function documentKey(document: BodySearchDocument): string {
  return JSON.stringify([document.revisionKey, document.title, document.aliases ?? [], document.tags ?? [], document.headings ?? []]);
}

function memoryLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

/** One Vault-local dictionary view, bounded in memory and never persisted. */
export class BodySearchMemoryIndex implements BodySearchMemoryPort {
  private readonly records = new Map<string, CachedDocument>();
  private readonly activeSearches = new Set<{ paths: ReadonlySet<string>; keys: ReadonlyMap<string, string>; invalidated: boolean }>();
  private readonly maxCharacters: number;
  private readonly maxTokenEntries: number;
  private readonly maxDocuments: number;
  private characters = 0;
  private tokenEntries = 0;
  private epoch = 0;
  private viewVersion = 0;
  private disposed = false;
  private dictionarySignature?: string;
  private segmenterIdentity: unknown;

  constructor(options: BodySearchMemoryOptions = {}) {
    this.maxCharacters = memoryLimit(options.maxCachedCharacters, 16_000_000);
    this.maxTokenEntries = memoryLimit(options.maxCachedTokenEntries, 1_000_000);
    this.maxDocuments = memoryLimit(options.maxCachedDocuments, 10_000);
  }

  async search(options: BodySearchOptions): Promise<BodySearchResult> {
    this.assertActive();
    const prepared = prepareSearch(options);
    const signature = JSON.stringify([...prepared.dictionary].sort());
    const identity = (Intl as typeof Intl & { Segmenter?: unknown }).Segmenter;
    if (this.dictionarySignature !== signature || this.segmenterIdentity !== identity) {
      // Cache ownership changes are not source changes. Existing callers keep their
      // own dictionary/statistics and may finish, but cannot publish into this view.
      this.resetRecords();
      this.viewVersion++;
      this.dictionarySignature = signature;
      this.segmenterIdentity = identity;
    }
    const keys = new Map(prepared.documents.map((document) => [document.vaultRelativePath, documentKey(document)]));
    // A newly observed revision is real evidence of change, unlike a different
    // request's kind/date filter or dictionary view. Reject overlapping old reads.
    for (const running of this.activeSearches) {
      for (const [path, key] of keys) {
        if (running.keys.has(path) && running.keys.get(path) !== key) { running.invalidated = true; break; }
      }
    }
    for (const path of this.records.keys()) if (!keys.has(path)) this.remove(path);
    const epoch = this.epoch;
    const viewVersion = this.viewVersion;
    const active = { paths: new Set(keys.keys()), keys, invalidated: false };
    this.activeSearches.add(active);
    const staged = new Map<string, CachedDocument>();
    const check = (document?: BodySearchDocument) => {
      this.assertActive();
      if (epoch !== this.epoch || active.invalidated || (document && keys.get(document.vaultRelativePath) !== documentKey(document))) throw indexStateError("search_index_stale");
    };
    try {
      const result = await executeSearch(options, prepared, {
        check,
        get: (document) => {
          check(document);
          if (document.revisionKey === undefined || viewVersion !== this.viewVersion) return undefined;
          const record = this.records.get(document.vaultRelativePath);
          return record && record.key === keys.get(document.vaultRelativePath) ? record.statistics : undefined;
        },
        stage: (document, statistics) => {
          check(document);
          if (document.revisionKey !== undefined) staged.set(document.vaultRelativePath, { key: keys.get(document.vaultRelativePath)!, statistics });
        },
      });
      checkAbort(options.request.signal);
      check();
      for (const document of prepared.documents) check(document);
      // A cancelled/failed/invalidated build never publishes partial state as complete.
      if (result.coverage.complete && viewVersion === this.viewVersion) for (const [path, record] of staged) this.retain(path, record);
      return result;
    } finally { this.activeSearches.delete(active); }
  }

  invalidate(path?: string): void {
    if (path === undefined) { this.clear(); return; }
    const prefix = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
    const matches = (key: string) => !prefix || key === prefix || key.startsWith(`${prefix}/`);
    for (const key of this.records.keys()) if (matches(key)) this.remove(key);
    for (const active of this.activeSearches) {
      if ([...active.paths].some(matches)) active.invalidated = true;
    }
  }

  clear(): void {
    this.epoch++;
    this.viewVersion++;
    this.resetRecords();
    this.activeSearches.clear();
    this.dictionarySignature = undefined;
    this.segmenterIdentity = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw indexStateError("search_index_disposed");
  }

  private resetRecords(): void {
    this.records.clear();
    this.characters = 0;
    this.tokenEntries = 0;
  }

  private remove(path: string): void {
    const previous = this.records.get(path);
    if (!previous) return;
    this.characters -= previous.statistics.characters + previous.key.length;
    this.tokenEntries -= previous.statistics.tokenEntries;
    this.records.delete(path);
  }

  private retain(path: string, record: CachedDocument): void {
    const characters = record.statistics.characters + record.key.length;
    const tokenEntries = record.statistics.tokenEntries;
    this.remove(path);
    if (!this.maxDocuments || characters > this.maxCharacters || tokenEntries > this.maxTokenEntries) return;
    while (this.records.size && (this.records.size >= this.maxDocuments || this.characters + characters > this.maxCharacters || this.tokenEntries + tokenEntries > this.maxTokenEntries)) {
      this.remove(this.records.keys().next().value!);
    }
    this.records.set(path, record);
    this.characters += characters;
    this.tokenEntries += tokenEntries;
  }
}
