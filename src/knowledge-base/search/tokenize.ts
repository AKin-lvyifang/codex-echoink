import type { BodySearchDocument } from "./contracts";

interface DictionaryNode {
  readonly children: Map<string, DictionaryNode>;
  word?: string;
}

const dictionaries = new WeakMap<readonly string[], DictionaryNode>();
const han = /\p{Script=Han}/u;
const wordCharacter = /[\p{Script=Latin}\p{N}_]/u;

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Metadata only: a new allowed document set also gets a fresh dictionary. */
export function buildSearchDictionary(documents: readonly Pick<BodySearchDocument, "title" | "aliases" | "tags">[]): string[] {
  const words = new Set<string>();
  const add = (value: string) => {
    const word = normalize(value).trim().replace(/^#+/u, "");
    if (word) words.add(word);
  };
  for (const document of documents) {
    const title = document.title.trim();
    const length = Array.from(title).length;
    const sentence = /^(?:我(?:们)?|你(?:们)?|他(?:们)?|她(?:们)?|如何|为什么|怎么|怎样|是否|关于)/u.test(title)
      || /(?:的看法|的想法|的时候|是什么|怎么办|怎么样|吗|呢|吧)$/u.test(title);
    if (length >= 2 && length <= 12 && /^[\p{L}\p{N}]+$/u.test(title) && !sentence) add(title);
    for (const alias of document.aliases ?? []) add(alias);
    for (const tag of document.tags ?? []) add(tag);
  }
  return [...words];
}

function dictionaryTree(dictionary: readonly string[]): DictionaryNode {
  const cached = dictionaries.get(dictionary);
  if (cached) return cached;
  const root: DictionaryNode = { children: new Map() };
  for (const value of dictionary) {
    const word = normalize(value).trim();
    if (!word) continue;
    let node = root;
    for (const character of word) {
      let child = node.children.get(character);
      if (!child) {
        child = { children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.word = word;
  }
  dictionaries.set(dictionary, root);
  return root;
}

type SearchTokenVisitor = (token: string, start: number, end: number) => void;
interface SearchTextToken { token: string; start: number; end: number; kind: "word" | "bigram" }
interface WordSegment { segment: string; index: number; isWordLike?: boolean }
interface WordSegmenter { segment(text: string): Iterable<WordSegment> }
type SegmenterConstructor = new (locale: string, options: { granularity: "word" }) => WordSegmenter;
let segmenterConstructor: SegmenterConstructor | undefined;
let segmenter: WordSegmenter | undefined;

/** Undefined entries are cooperative checkpoints for very long individual sections. */
export function* iterateSearchTokens(text: string, dictionary: readonly string[]): Generator<SearchTextToken | undefined> {
  const source = normalize(text);
  let originalPositions: number[] | undefined;
  if (source.length !== text.length) {
    originalPositions = [];
    // Keep excerpt offsets tied to the original body when compatibility glyphs expand.
    for (const match of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
      for (let index = 0; index < normalize(match[0]).length; index++) originalPositions.push(match.index);
    }
  }
  const emitted = new Set<string>();
  const covered: { start: number; end: number }[] = [];
  const emit = (token: string, start: number, end: number, kind: SearchTextToken["kind"] = "word") => {
    const key = `${start}:${end}:${token}`;
    if (!emitted.has(key)) {
      emitted.add(key);
      return { token, start: originalPositions?.[start] ?? start, end: originalPositions?.[end] ?? Math.min(end, text.length), kind };
    }
  };
  // Versions are recognized before word segmentation and never reduced to digits.
  for (const match of source.matchAll(/\bv?\d+(?:\.\d+)+(?:[-+][a-z0-9]+(?:[.-][a-z0-9]+)*)?\b/gu)) {
    const start = match.index;
    const token = emit(match[0], start, start + match[0].length);
    if (token) yield token;
    covered.push({ start, end: start + match[0].length });
    if (match[0].startsWith("v")) {
      const bareVersion = emit(match[0].slice(1), start + 1, start + match[0].length);
      if (bareVersion) yield bareVersion;
    }
  }
  const tree = dictionaryTree(dictionary);
  let checkpoint = 16_384;
  for (let start = 0; start < source.length;) {
    if (start >= checkpoint) { yield undefined; checkpoint = start + 16_384; }
    let node: DictionaryNode | undefined = tree;
    let found: { word: string; end: number } | undefined;
    let end = start;
    for (const character of source.slice(start)) {
      node = node.children.get(character);
      if (!node) break;
      end += character.length;
      if (node.word) {
        const previous = source[start - 1] ?? "";
        const next = source[end] ?? "";
        const first = node.word[0];
        const last = node.word[node.word.length - 1];
        const leftBoundary = han.test(first) || !wordCharacter.test(previous);
        const rightBoundary = han.test(last) || !wordCharacter.test(next);
        if (leftBoundary && rightBoundary) found = { word: node.word, end };
      }
    }
    if (found) {
      const token = emit(found.word, start, found.end);
      if (token) yield token;
      covered.push({ start, end: found.end });
      start = found.end;
    } else {
      start += (source.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
    }
  }
  covered.sort((left, right) => left.start - right.start);
  let merged = 0;
  for (const current of covered) {
    const previous = covered[merged - 1];
    if (previous && current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else covered[merged++] = current;
  }
  covered.length = merged;
  const overlapsRecognizedWord = (start: number, end: number) => {
    // The intervals are disjoint except for version/dictionary matches at the same place.
    let low = 0;
    let high = covered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (covered[middle].start < end) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0 && covered[index].end > start; index--) {
      if (covered[index].start < end) return true;
    }
    return false;
  };
  for (const match of source.matchAll(/[\p{Script=Latin}\p{N}]+(?:[_'-][\p{Script=Latin}\p{N}]+)*/gu)) {
    if (!overlapsRecognizedWord(match.index, match.index + match[0].length)) {
      const token = emit(match[0], match.index, match.index + match[0].length);
      if (token) yield token;
    }
  }
  try {
    const constructor = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
    if (constructor) {
      if (constructor !== segmenterConstructor) {
        segmenterConstructor = constructor;
        segmenter = new constructor("zh", { granularity: "word" });
      }
      for (const part of segmenter!.segment(source)) {
        if (part.isWordLike !== false && han.test(part.segment) && Array.from(part.segment).length >= 2
          && !overlapsRecognizedWord(part.index, part.index + part.segment.length)) {
          const token = emit(part.segment, part.index, part.index + part.segment.length);
          if (token) yield token;
        }
      }
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") throw error;
    // Old mobile engines may expose Intl without a usable word segmenter.
  }
  // Always include partial Chinese matches, including inside recognized dictionary words.
  for (const match of source.matchAll(/\p{Script=Han}+/gu)) {
    const characters = Array.from(match[0]);
    let start = match.index;
    for (let index = 0; index + 1 < characters.length; index++) {
      const token = characters[index] + characters[index + 1];
      const result = emit(token, start, start + token.length, "bigram");
      if (result) yield result;
      start += characters[index].length;
    }
  }
}

export function visitSearchTokens(text: string, dictionary: readonly string[], visit: SearchTokenVisitor): void {
  for (const result of iterateSearchTokens(text, dictionary)) {
    if (result) visit(result.token, result.start, result.end);
  }
}

export function tokenizeSearchText(text: string, dictionary: readonly string[] = []): string[] {
  const tokens: string[] = [];
  visitSearchTokens(text, dictionary, (token) => tokens.push(token));
  return tokens;
}
