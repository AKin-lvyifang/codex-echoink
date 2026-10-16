import type { BodySearchDocument, BodySearchHit, BodySearchRequest, BodySearchResult } from "./contracts";
import { buildSearchDictionary, iterateSearchTokens, tokenizeSearchText } from "./tokenize";

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
interface Section {
  document: BodySearchDocument;
  contentRevision: string;
  sectionTitle: string;
  sectionStart: number;
  totalLines: number;
  journalDate?: string;
  length: number;
  frequencies: Map<string, number>;
  titleTerms: Set<string>;
  tagTerms: Set<string>;
  evidence: readonly Evidence[];
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

async function yieldToUi(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  checkAbort(signal);
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

async function buildSections(document: BodySearchDocument, content: string, contentRevision: string, dictionary: readonly string[], queries: readonly Set<string>[], union: Set<string>, signal?: AbortSignal): Promise<Section[]> {
  const lines = content.split(/\r\n|\n|\r/u);
  const headings = currentHeadings(document, lines);
  const ranges: { title: string; start: number; end: number }[] = [];
  if (!headings.length || headings[0].line > 1) ranges.push({ title: document.title, start: 1, end: headings[0] ? headings[0].line - 1 : lines.length });
  for (let index = 0; index < headings.length; index++) {
    ranges.push({ title: headings[index].heading, start: headings[index].line, end: headings[index + 1] ? headings[index + 1].line - 1 : lines.length });
  }
  const titleTerms = new Set<string>();
  for (const title of [document.title, ...(document.aliases ?? [])]) {
    for (const token of tokenizeSearchText(title, dictionary)) if (union.has(token)) titleTerms.add(token);
  }
  const tagTerms = new Set(tokenizeSearchText((document.tags ?? []).join("\n"), dictionary).filter((token) => union.has(token)));
  const sections: Section[] = [];
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
      if (!union.has(token)) continue;
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      const fragment = fragments[rangeIndex(fragments, start)];
      fragment.frequencies.set(token, (fragment.frequencies.get(token) ?? 0) + 1);
    }
    const fragmentFrequency = new Map<string, number>();
    for (const fragment of fragments) {
      for (const token of fragment.frequencies.keys()) fragmentFrequency.set(token, (fragmentFrequency.get(token) ?? 0) + 1);
    }
    const evidence = frequencies.size || titleTerms.size ? queries.map((query) => {
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
      return evidenceFor(text, best, range.start, range.end);
    }) : [];
    sections.push({ document, contentRevision, sectionTitle: range.title, sectionStart: range.start, totalLines: lines.length,
      journalDate: journalDate(document), length: Math.max(1, length), frequencies, titleTerms, tagTerms, evidence });
    if (sections.length % 16 === 0 || text.length >= 32_000) await yieldToUi(signal);
  }
  return sections;
}

function queryTexts(request: BodySearchRequest): string[] {
  const supplied = request.queries?.length ? request.queries : request.query ? [request.query] : [];
  if (supplied.length > 5) throw new Error("Knowledge search accepts at most five queries");
  return [...new Set(supplied.map((query) => query.trim()).filter(Boolean))];
}

function queryTermWeights(text: string, dictionary: readonly string[]): Map<string, number> {
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

/** A single, query-local scan. No Vault/Node dependency or persistent body index. */
export async function searchBodyDocuments(options: {
  documents: readonly BodySearchDocument[];
  request: BodySearchRequest;
  activePath?: string;
  recentPaths?: readonly string[];
}): Promise<BodySearchResult> {
  const { request } = options;
  checkAbort(request.signal);
  const texts = queryTexts(request);
  const dateFrom = calendarDate(request.dateFrom);
  const dateTo = calendarDate(request.dateTo);
  if ((request.dateFrom && !dateFrom) || (request.dateTo && !dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) throw new Error("Invalid knowledge search date range");
  const kinds = request.kinds ? new Set(request.kinds) : undefined;
  const excluded = new Set(request.excludePaths ?? []);
  const seen = new Set<string>();
  let unknownJournalDates = 0;
  const documents = options.documents.filter((document) => {
    if (seen.has(document.vaultRelativePath) || excluded.has(document.vaultRelativePath) || (kinds && !kinds.has(document.kind))) return false;
    seen.add(document.vaultRelativePath);
    const date = journalDate(document);
    if (document.kind === "journal" && !date) unknownJournalDates++;
    if (document.kind === "journal" && (dateFrom || dateTo)) {
      if (!date || (dateFrom && date < dateFrom) || (dateTo && date > dateTo)) return false;
    }
    return true;
  });
  const coverage = { totalFiles: documents.length, scannedFiles: 0, failedFiles: 0, complete: !(unknownJournalDates && (dateFrom || dateTo)), unknownJournalDates };
  const dictionary = buildSearchDictionary(documents);
  const queryWeights = texts.map((query) => queryTermWeights(query, dictionary)).filter((tokens) => tokens.size);
  const queries = queryWeights.map((weights) => new Set(weights.keys()));
  if (!queries.length) return { hits: [], total: 0, coverage: { ...coverage, complete: coverage.totalFiles === 0 && coverage.complete } };
  const union = new Set(queries.flatMap((query) => [...query]));
  const sections: Section[] = [];
  let scannedSections = 0;
  for (let index = 0; index < documents.length; index++) {
    checkAbort(request.signal);
    const document = documents[index];
    try {
      const { content, contentRevision } = await document.read();
      checkAbort(request.signal);
      const current = await buildSections(document, content, contentRevision, dictionary, queries, union, request.signal);
      sections.push(...current);
      scannedSections += current.length;
      coverage.scannedFiles++;
    } catch (error) {
      checkAbort(request.signal);
      if (isAbort(error)) throw error;
      coverage.failedFiles++;
      coverage.complete = false;
    }
    if ((index + 1) % 16 === 0 || scannedSections >= 64) {
      await yieldToUi(request.signal);
      scannedSections = 0;
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
    ...section.evidence[query],
    score,
    ...(section.journalDate ? { journalDate: section.journalDate } : {}),
  }));
  checkAbort(request.signal);
  return { hits, total: ordered.length, coverage };
}
