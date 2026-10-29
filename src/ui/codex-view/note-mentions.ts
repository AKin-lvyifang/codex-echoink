import { isImeKeyEvent } from "../ime-composition";
import { pinyin } from "pinyin-pro";
import { TFile, type App } from "obsidian";

export interface NoteMentionSelection {
  readonly vaultRelativePath: string;
  readonly fileName: string;
}

export interface NoteMentionSnapshot extends NoteMentionSelection {
  readonly content: string;
}

export interface NoteMentionCatalogInput extends NoteMentionSelection {
  readonly aliases?: unknown;
}

export interface NoteMentionCatalogEntry extends NoteMentionSelection {
  readonly aliases: readonly string[];
  readonly normalizedPath: string;
  readonly directKeys: Readonly<{
    fileName: string;
    aliases: readonly string[];
    path: string;
  }>;
  readonly pinyinKeys: Readonly<{
    fileName: readonly string[];
    aliases: readonly string[];
    path: readonly string[];
  }>;
}

export interface NoteMentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

interface RankedNoteMention {
  readonly entry: NoteMentionCatalogEntry;
  readonly tier: number;
  readonly score: number;
}

export interface NoteMentionLeadingAction { label: string; select(): void }

interface ComposerNoteMentionState {
  leadingAction?: Readonly<NoteMentionLeadingAction>;
  selections: NoteMentionSelection[];
  catalog: readonly Readonly<NoteMentionCatalogEntry>[] | null;
  results: readonly Readonly<NoteMentionCatalogEntry>[];
  activeIndex: number;
  open: boolean;
  onSelect?: (entry: Readonly<NoteMentionCatalogEntry>) => void;
  onRender?: () => void;
  onClose?: () => void;
}

const NOTE_MENTION_LIMIT = 20;
const composerState = new WeakMap<HTMLTextAreaElement, ComposerNoteMentionState>();

export function buildVaultNoteMentionCatalog(
  app: Pick<App, "vault" | "metadataCache">
): readonly Readonly<NoteMentionCatalogEntry>[] {
  return buildNoteMentionCatalog(app.vault.getMarkdownFiles().map((file) => ({
    vaultRelativePath: file.path,
    fileName: file.name,
    aliases: noteAliasesFromFrontmatter(
      app.metadataCache.getFileCache(file)?.frontmatter
    )
  })));
}

function noteAliasesFromFrontmatter(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Readonly<Record<string, unknown>>).aliases;
}

export function buildNoteMentionCatalog(
  inputs: readonly Readonly<NoteMentionCatalogInput>[]
): readonly Readonly<NoteMentionCatalogEntry>[] {
  const byPath = new Map<string, NoteMentionCatalogEntry>();
  for (const input of inputs) {
    const vaultRelativePath = normalizeVaultRelativePath(input.vaultRelativePath);
    const fileName = input.fileName.trim();
    if (!vaultRelativePath || !fileName || !/\.md$/iu.test(vaultRelativePath)) continue;
    const pathKey = vaultRelativePath;
    const normalizedPath = normalizeSearchText(vaultRelativePath);
    if (byPath.has(pathKey)) continue;
    const aliases = normalizeNoteAliases(input.aliases);
    const pinyinKeysFor = (sources: readonly string[]) => uniqueStrings(
      sources.flatMap((source) => [
        pinyinSearchKey(source, false),
        pinyinSearchKey(source, true)
      ]).filter(Boolean)
    );
    byPath.set(pathKey, Object.freeze({
      vaultRelativePath,
      fileName,
      aliases: Object.freeze(aliases),
      normalizedPath,
      directKeys: Object.freeze({
        fileName: normalizeSearchText(fileName),
        aliases: Object.freeze(aliases.map(normalizeSearchText).filter(Boolean)),
        path: normalizedPath
      }),
      pinyinKeys: Object.freeze({
        fileName: Object.freeze(pinyinKeysFor([fileName])),
        aliases: Object.freeze(pinyinKeysFor(aliases)),
        path: Object.freeze(pinyinKeysFor([vaultRelativePath]))
      })
    }));
  }
  return Object.freeze([...byPath.values()].sort(compareCatalogEntries));
}

export function searchNoteMentionCatalog(
  catalog: readonly Readonly<NoteMentionCatalogEntry>[],
  queryValue: string,
  limit = NOTE_MENTION_LIMIT
): readonly Readonly<NoteMentionCatalogEntry>[] {
  const query = normalizeSearchText(queryValue);
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(NOTE_MENTION_LIMIT, Math.trunc(limit)))
    : NOTE_MENTION_LIMIT;
  if (!boundedLimit) return Object.freeze([]);
  if (!query) return Object.freeze([...catalog].sort(compareCatalogEntries).slice(0, boundedLimit));
  const ranked: RankedNoteMention[] = [];
  for (const entry of catalog) {
    const match = bestCatalogMatch(entry, query);
    if (match) ranked.push({ entry, ...match });
  }
  ranked.sort((left, right) =>
    left.tier - right.tier
    || left.score - right.score
    || compareCatalogEntries(left.entry, right.entry)
  );
  return Object.freeze(ranked.slice(0, boundedLimit).map(({ entry }) => entry));
}

export function noteMentionQueryAtCursor(
  value: string,
  cursorValue: number | null | undefined
): NoteMentionQuery | null {
  const cursor = Number.isSafeInteger(cursorValue)
    ? Math.max(0, Math.min(value.length, cursorValue as number))
    : value.length;
  const prefix = value.slice(0, cursor);
  const match = /@([^\s@]*)$/u.exec(prefix);
  if (!match || match.index < 0) return null;
  if (match.index > 0 && !/\s/u.test(prefix[match.index - 1] ?? "")) return null;
  return Object.freeze({
    start: match.index,
    end: cursor,
    query: match[1] ?? ""
  });
}

export function removeNoteMentionQuery(
  value: string,
  query: Readonly<Pick<NoteMentionQuery, "start" | "end">>
): Readonly<{ value: string; cursor: number }> {
  const start = Math.max(0, Math.min(value.length, query.start));
  const end = Math.max(start, Math.min(value.length, query.end));
  const next = `${value.slice(0, start)}${value.slice(end)}`;
  return Object.freeze({ value: next, cursor: start });
}

export function composerNoteMentionSelections(
  input: HTMLTextAreaElement
): readonly Readonly<NoteMentionSelection>[] {
  return requireComposerState(input).selections.map((selection) => ({ ...selection }));
}

export async function snapshotComposerNoteMentions(
  app: Pick<App, "vault">,
  input: HTMLTextAreaElement,
  selections: readonly Readonly<NoteMentionSelection>[] = composerNoteMentionSelections(input)
): Promise<readonly Readonly<NoteMentionSnapshot>[]> {
  const snapshots: Readonly<NoteMentionSnapshot>[] = [];
  for (const selection of selections) {
    const file = app.vault.getAbstractFileByPath(selection.vaultRelativePath);
    if (!(file instanceof TFile) || !/\.md$/iu.test(file.path)) {
      throw new Error(`找不到提及的笔记：${selection.fileName}`);
    }
    snapshots.push(Object.freeze({
      ...selection,
      content: await app.vault.read(file)
    }));
  }
  return Object.freeze(snapshots);
}

export function addComposerNoteMentionSelection(
  input: HTMLTextAreaElement,
  selection: Readonly<NoteMentionSelection>
): boolean {
  const state = requireComposerState(input);
  const normalizedPath = normalizeVaultRelativePath(selection.vaultRelativePath);
  const fileName = selection.fileName.trim();
  if (!normalizedPath || !fileName) return false;
  if (state.selections.some((item) => item.vaultRelativePath === normalizedPath)) return false;
  state.selections.push(Object.freeze({ vaultRelativePath: normalizedPath, fileName }));
  return true;
}

export function removeComposerNoteMentionSelection(
  input: HTMLTextAreaElement,
  vaultRelativePath: string
): void {
  const state = requireComposerState(input);
  state.selections = state.selections.filter((selection) =>
    selection.vaultRelativePath !== vaultRelativePath
  );
}

export function clearComposerNoteMentions(input: HTMLTextAreaElement): void {
  const state = requireComposerState(input);
  state.selections = [];
  closeComposerNoteMentionMenu(input);
}

export function setComposerNoteMentionMenu(input: HTMLTextAreaElement, options: Readonly<{
  leadingAction?: Readonly<NoteMentionLeadingAction>;
  results: readonly Readonly<NoteMentionCatalogEntry>[];
  onSelect: (entry: Readonly<NoteMentionCatalogEntry>) => void;
  onRender: () => void;
  onClose: () => void;
}>): void {
  const state = requireComposerState(input);
  state.leadingAction = options.leadingAction;
  state.results = options.results;
  state.activeIndex = Math.min(state.activeIndex, Math.max(0, options.results.length + (options.leadingAction ? 1 : 0) - 1));
  state.open = true;
  state.onSelect = options.onSelect;
  state.onRender = options.onRender;
  state.onClose = options.onClose;
}

export function composerNoteMentionMenuState(input: HTMLTextAreaElement): Readonly<{
  leadingAction?: Readonly<NoteMentionLeadingAction>;
  results: readonly Readonly<NoteMentionCatalogEntry>[];
  activeIndex: number;
  open: boolean;
}> {
  const state = requireComposerState(input);
  return Object.freeze({
    leadingAction: state.leadingAction,
    results: state.results,
    activeIndex: state.activeIndex,
    open: state.open
  });
}

export function cachedComposerNoteMentionCatalog(
  input: HTMLTextAreaElement,
  build: () => readonly Readonly<NoteMentionCatalogEntry>[]
): readonly Readonly<NoteMentionCatalogEntry>[] {
  const state = requireComposerState(input);
  state.catalog ??= build();
  return state.catalog;
}

export function closeComposerNoteMentionMenu(input: HTMLTextAreaElement): void {
  const state = requireComposerState(input);
  state.catalog = null;
  if (!state.open) return;
  state.open = false;
  input.removeAttribute("aria-activedescendant");
  state.onClose?.();
}

export function reconcileComposerNoteMentionMenuAtCursor(
  input: HTMLTextAreaElement
): boolean {
  const state = requireComposerState(input);
  if (!state.open) return false;
  if (noteMentionQueryAtCursor(input.value, input.selectionStart)) return true;
  closeComposerNoteMentionMenu(input);
  return false;
}

export function handleComposerNoteMentionKeyDown(
  event: KeyboardEvent,
  input: HTMLTextAreaElement
): boolean {
  const state = requireComposerState(input);
  if (!reconcileComposerNoteMentionMenuAtCursor(input)) return false;
  if (isImeKeyEvent(event)) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeComposerNoteMentionMenu(input);
    return true;
  }
  if (event.key === "Enter") {
    if (state.leadingAction && state.activeIndex === 0) {
      event.preventDefault(); event.stopPropagation(); state.leadingAction.select(); return true;
    }
    const selected = state.results[state.activeIndex - (state.leadingAction ? 1 : 0)];
    if (!selected) return false;
    event.preventDefault();
    event.stopPropagation();
    state.onSelect?.(selected);
    return true;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  const count = state.results.length + (state.leadingAction ? 1 : 0);
  if (!count) return true;
  event.preventDefault();
  event.stopPropagation();
  state.activeIndex = event.key === "ArrowDown"
    ? (state.activeIndex + 1) % count
    : (state.activeIndex - 1 + count) % count;
  state.onRender?.();
  return true;
}

export function normalizeNoteAliases(value: unknown): string[] {
  const candidates = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return uniqueStrings(candidates.map((item) => item.trim()).filter(Boolean));
}

function bestCatalogMatch(
  entry: Readonly<NoteMentionCatalogEntry>,
  query: string
): Readonly<{ tier: number; score: number }> | null {
  const fields: ReadonlyArray<readonly [number, readonly string[]]> = [
    [0, [entry.directKeys.fileName]],
    [1, entry.directKeys.aliases],
    [2, [entry.directKeys.path]],
    [3, entry.pinyinKeys.fileName],
    [4, entry.pinyinKeys.aliases],
    [5, entry.pinyinKeys.path]
  ];
  let best: { tier: number; score: number } | null = null;
  for (const [tier, keys] of fields) {
    for (const key of keys) {
      const score = fuzzyMatchScore(key, query);
      if (score === null) continue;
      if (!best || tier < best.tier || (tier === best.tier && score < best.score)) {
        best = { tier, score };
      }
    }
    if (best?.tier === tier) break;
  }
  return best ? Object.freeze(best) : null;
}

function fuzzyMatchScore(value: string, query: string): number | null {
  if (!value || !query) return null;
  if (value === query) return 0;
  if (value.startsWith(query)) return 1 + (value.length - query.length) / 10_000;
  const index = value.indexOf(query);
  if (index >= 0) return 2 + index / 1_000 + (value.length - query.length) / 100_000;
  let queryIndex = 0;
  let firstIndex = -1;
  let previousIndex = -1;
  let gapCount = 0;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstIndex < 0) firstIndex = valueIndex;
    if (previousIndex >= 0) gapCount += valueIndex - previousIndex - 1;
    previousIndex = valueIndex;
    queryIndex += 1;
  }
  if (queryIndex !== query.length) return null;
  return 3 + firstIndex / 100 + gapCount / 1_000 + (value.length - query.length) / 100_000;
}

function pinyinSearchKey(value: string, initials: boolean): string {
  return normalizeSearchText(pinyin(value, {
    type: "array",
    toneType: "none",
    nonZh: "consecutive",
    ...(initials ? { pattern: "first" as const } : {})
  }).join(""));
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/[\s\\/_\-.]+/gu, "");
}

function normalizeVaultRelativePath(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareCatalogEntries(
  left: Readonly<Pick<NoteMentionCatalogEntry, "normalizedPath">>,
  right: Readonly<Pick<NoteMentionCatalogEntry, "normalizedPath">>
): number {
  return left.normalizedPath < right.normalizedPath
    ? -1
    : left.normalizedPath > right.normalizedPath
      ? 1
      : 0;
}

function requireComposerState(input: HTMLTextAreaElement): ComposerNoteMentionState {
  let state = composerState.get(input);
  if (!state) {
    state = {
      selections: [],
      catalog: null,
      results: Object.freeze([]),
      activeIndex: 0,
      open: false
    };
    composerState.set(input, state);
  }
  return state;
}
