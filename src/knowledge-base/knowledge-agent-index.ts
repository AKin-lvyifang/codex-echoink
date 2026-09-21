import { extractKnowledgeLinks, extractKnowledgeApplicability, resolveKnowledgeLink, type KnowledgeLink, type KnowledgeApplicability, type KnowledgeLinkResolver, type KnowledgeRelation, type KnowledgeRelationPage } from "./knowledge-relations";
import { knowledgeRootRole, knowledgeRolePath, knowledgeRoleRoots, resolveKnowledgePath } from "./root-paths";
import { isRawMarkdownPath, rawDigestFingerprint } from "./raw-digest";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isMissingPathError, writeFileAtomic } from "./utils";

export const KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION = 1 as const;
export const KNOWLEDGE_AGENT_INDEX_FILE = "index-v1.json" as const;
export const KNOWLEDGE_AGENT_SOURCE_MARKER = "echoink-source" as const;

const KNOWLEDGE_ROOTS = ["wiki", "projects", "raw"] as const;
const KNOWLEDGE_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const RAW_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const MAX_PAGE_SIZE = 50;
const REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type KnowledgeAgentKind = typeof KNOWLEDGE_ROOTS[number];
export type KnowledgeAgentRawSourceStatus = "available" | "changed" | "missing";
export type KnowledgeAgentIndexErrorCode =
  | "cursor_invalid"
  | "cursor_stale"
  | "invalid_path"
  | "invalid_query"
  | "not_found"
  | "source_changed"
  | "unsafe_path"
  | "unsupported_content";

export class KnowledgeAgentIndexError extends Error {
  constructor(
    readonly code: KnowledgeAgentIndexErrorCode,
    safeMessage: string
  ) {
    super(safeMessage);
    this.name = "KnowledgeAgentIndexError";
  }
}

export interface KnowledgeAgentRawSource {
  vaultRelativePath: string;
  /** Raw revision used when this Knowledge entry was derived. */
  contentRevision?: string;
  /** Present only when the current Raw differs from the derivation revision. */
  currentContentRevision?: string;
  status: KnowledgeAgentRawSourceStatus;
}

export interface KnowledgeAgentSearchHit extends KnowledgeApplicability {
  entryId: string;
  vaultRelativePath: string;
  kind: KnowledgeAgentKind;
  title: string;
  contentRevision: string;
  recordedAt: number;
  verificationStatus: "local_revision_verified" | "source_link_changed";
  rawSources: KnowledgeAgentRawSource[];
}

export interface KnowledgeAgentSearchRequest {
  /** Omitted only when mode=recent. */
  query?: string;
  /** Default keyword relevance search remains unchanged. */
  mode?: "search" | "recent" | "related";
  vaultRelativePath?: string;
  kinds?: readonly KnowledgeAgentKind[];
  /** Internal dedupe for exact paths already disclosed outside the index page. */
  excludePaths?: readonly string[];
  /** Zero is reserved for an internal metadata-only page that starts at offset 0. */
  limit?: number;
  cursor?: string;
}

export interface KnowledgeAgentSearchResult {
  generation: number;
  total: number;
  returned: number;
  remaining: number;
  hasMore: boolean;
  exhausted: boolean;
  continuationCursor?: string;
  hits: KnowledgeAgentSearchHit[];
  related?: KnowledgeRelationPage;
}

export interface KnowledgeAgentReadResult extends KnowledgeAgentSearchHit {
  content: string;
  related?: KnowledgeRelationPage;
}

export interface KnowledgeAgentReliableRawKnowledge {
  rawPath: string;
  rawContentRevision: string;
  entries: readonly Readonly<{
    vaultRelativePath: string;
    title: string;
    content: string;
  }>[];
}

export interface KnowledgeAgentIndexRefreshResult {
  generation: number;
  entries: number;
  indexed: number;
  reused: number;
  changedPaths: string[];
  deletedPaths: string[];
  indexPath: string;
}

interface StoredRawSource {
  vaultRelativePath: string;
  contentRevision: string | null;
}

interface StoredKnowledgeEntry {
  entryId: string;
  vaultRelativePath: string;
  kind: KnowledgeAgentKind;
  title: string;
  contentRevision: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  pathTokens: Record<string, number>;
  titleTokens: Record<string, number>;
  bodyTokens: Record<string, number>;
  rawSources: StoredRawSource[];
  links?: KnowledgeLink[];
  applicability?: KnowledgeApplicability;
  relationSchema?: 1;
}

interface StoredKnowledgeAgentIndex {
  schemaVersion: typeof KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION;
  generation: number;
  /** Cursor generation for result sets ordered by recordedAt metadata. */
  recentGeneration: number;
  updatedAt: number;
  entries: Record<string, StoredKnowledgeEntry>;
}

interface CandidateEntry extends Omit<StoredKnowledgeEntry, "rawSources"> {
  rawLinks: Array<{
    vaultRelativePath: string;
    markerRevision: string | null;
  }>;
}

interface CursorPayload {
  v: 1;
  mode?: "recent";
  generation: number;
  queryHash: string;
  offset: number;
}

export class KnowledgeAgentIndex {
  readonly vaultPath: string;
  readonly storageRootPath: string;
  readonly indexPath: string;
  private current: StoredKnowledgeAgentIndex | null = null;
  private relations = new Map<string, KnowledgeRelation[]>();
  private readonly linkResolver?: KnowledgeLinkResolver;
  private refreshInFlight: Promise<KnowledgeAgentIndexRefreshResult> | null = null;
  private invalidationVersion = 0;
  private refreshedVersion = -1;

  constructor(input: Readonly<{
    vaultPath: string;
    storageRootPath: string;
    linkResolver?: KnowledgeLinkResolver;
  }>) {
    if (!input.vaultPath.trim() || !input.storageRootPath.trim()) {
      throw new KnowledgeAgentIndexError(
        "invalid_path",
        "Knowledge index requires a Vault path and a private storage path."
      );
    }
    this.linkResolver = input.linkResolver;
    this.vaultPath = path.resolve(input.vaultPath);
    this.storageRootPath = path.resolve(input.storageRootPath);
    this.indexPath = path.join(this.storageRootPath, KNOWLEDGE_AGENT_INDEX_FILE);
  }

  /** Hosts call this for create/modify/rename/delete and committed local writes. */
  invalidate(relativePath?: string): void {
    if (relativePath !== undefined) {
      const root = knowledgeRootRole(relativePath);
      if (!KNOWLEDGE_ROOTS.includes(root as KnowledgeAgentKind)) return;
    }
    this.invalidationVersion += 1;
  }

  async refresh(): Promise<KnowledgeAgentIndexRefreshResult> {
    this.invalidate();
    return await this.refreshInvalidated();
  }

  private async ensureFresh(): Promise<void> {
    while (!this.current || this.refreshedVersion !== this.invalidationVersion) {
      await this.refreshInvalidated();
    }
  }

  private async refreshInvalidated(): Promise<KnowledgeAgentIndexRefreshResult> {
    if (this.refreshInFlight) return await this.refreshInFlight;
    const running = (async () => {
      let result: KnowledgeAgentIndexRefreshResult;
      do {
        const version = this.invalidationVersion;
        result = await this.performRefresh();
        // A file event received during the scan must survive its completion.
        this.refreshedVersion = version;
      } while (this.refreshedVersion !== this.invalidationVersion);
      return result;
    })();
    this.refreshInFlight = running;
    try {
      return await running;
    } finally {
      if (this.refreshInFlight === running) this.refreshInFlight = null;
    }
  }

  async search(
    request: Readonly<KnowledgeAgentSearchRequest>
  ): Promise<KnowledgeAgentSearchResult> {
    await this.ensureFresh();
    const index = this.requireCurrent();
    const mode = request.mode ?? "search";
    if (mode === "related") {
      const related = await this.related({ vaultRelativePath: request.vaultRelativePath ?? "", cursor: request.cursor, limit: request.limit });
      return Object.freeze({ generation: index.generation, total: related.total, returned: related.returned, remaining: related.remaining, hasMore: related.hasMore, exhausted: related.exhausted, continuationCursor: related.continuationCursor, hits: [], related });
    }
    if (mode === "recent" && request.query !== undefined) {
      throw new KnowledgeAgentIndexError(
        "invalid_query",
        "Recent Knowledge browsing must not include a query."
      );
    }
    const query = mode === "recent"
      ? ""
      : normalizeQuery(request.query ?? "");
    const kinds = normalizeKinds(request.kinds);
    const excludedPaths = normalizeExcludedPaths(request.excludePaths);
    const limit = normalizePageSize(request.limit);
    const queryTokens = tokenCounts(query);
    const queryHash = knowledgeQueryHash(
      queryTokens,
      kinds,
      excludedPaths,
      mode
    );
    const cursorGeneration = mode === "recent"
      ? index.recentGeneration
      : index.generation;
    const offset = request.cursor
      ? decodeCursor(request.cursor, cursorGeneration, queryHash, mode)
      : 0;
    const candidates = Object.values(index.entries)
      .filter((entry) => kinds.includes(entry.kind))
      .filter((entry) => !excludedPaths.includes(entry.vaultRelativePath))
      .map((entry) => ({
        entry,
        score: scoreEntry(entry, queryTokens)
      }));
    const matches = mode === "recent"
      ? candidates.sort((left, right) =>
          right.entry.mtimeMs - left.entry.mtimeMs
          || left.entry.vaultRelativePath.localeCompare(
            right.entry.vaultRelativePath
          )
        )
      : candidates
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) =>
          kindPriority(left.entry.kind) - kindPriority(right.entry.kind)
          || verificationPriority(left.entry, index)
            - verificationPriority(right.entry, index)
          || right.score - left.score
          || left.entry.vaultRelativePath.localeCompare(
            right.entry.vaultRelativePath
          )
        );
    if (offset > matches.length) {
      throw new KnowledgeAgentIndexError(
        "cursor_invalid",
        "Knowledge continuation cursor is outside the current result set."
      );
    }
    const page = matches.slice(offset, offset + limit);
    const hits = page.map(({ entry }) => materializeHit(entry, index));
    const nextOffset = offset + hits.length;
    const hasMore = nextOffset < matches.length;
    return Object.freeze({
      generation: cursorGeneration,
      total: matches.length,
      returned: hits.length,
      remaining: Math.max(0, matches.length - nextOffset),
      hasMore,
      exhausted: !hasMore,
      ...(hasMore
          ? { continuationCursor: encodeCursor({
            v: 1,
            ...(mode === "recent" ? { mode } : {}),
            generation: cursorGeneration,
            queryHash,
            offset: nextOffset
          }) }
        : {}),
      hits: Object.freeze(hits.map(freezeHit)) as unknown as KnowledgeAgentSearchHit[]
    });
  }

  async read(input: Readonly<{
    vaultRelativePath: string;
    expectedContentRevision?: string;
  }>): Promise<KnowledgeAgentReadResult> {
    await this.ensureFresh();
    const index = this.requireCurrent();
    const relativePath = normalizeKnowledgePath(resolveKnowledgePath(this.vaultPath, input.vaultRelativePath));
    const entry = index.entries[relativePath];
    if (!entry) {
      throw new KnowledgeAgentIndexError(
        "not_found",
        "Knowledge entry is not present in the current index."
      );
    }
    if (
      input.expectedContentRevision
      && input.expectedContentRevision !== entry.contentRevision
    ) {
      throw new KnowledgeAgentIndexError(
        "source_changed",
        "Knowledge entry changed before it could be read."
      );
    }
    if (!isTextEntry(entry)) {
      throw new KnowledgeAgentIndexError(
        "unsupported_content",
        "This Raw source is indexed for location and version only."
      );
    }
    const absolutePath = await resolveIndexedFile(
      this.vaultPath,
      relativePath
    );
    const bytes = await fsp.readFile(absolutePath);
    const currentRevision = contentRevision(bytes, relativePath);
    if (currentRevision !== entry.contentRevision) {
      this.invalidate(relativePath);
      throw new KnowledgeAgentIndexError(
        "source_changed",
        "Knowledge entry changed while it was being read."
      );
    }
    const content = decodeUtf8(bytes);
    return Object.freeze({
      ...materializeHit(entry, index),
      related: this.relationPage(relativePath, 8),
      content
    });
  }

  async related(input: Readonly<{ vaultRelativePath: string; limit?: number; cursor?: string }>): Promise<KnowledgeRelationPage> {
    await this.ensureFresh();
    const relativePath = normalizeKnowledgePath(resolveKnowledgePath(this.vaultPath, input.vaultRelativePath));
    return this.relationPage(relativePath, input.limit ?? 8, input.cursor);
  }

  private relationPage(relativePath: string, limit: number, cursor?: string): KnowledgeRelationPage {
    const index = this.requireCurrent();
    const entry = index.entries[relativePath];
    if (!entry) throw new KnowledgeAgentIndexError("not_found", "Knowledge relation source is unavailable.");
    const queryHash = createHash("sha256").update(`related:${relativePath}`).digest("hex");
    const offset = cursor ? decodeCursor(cursor, index.generation, queryHash, "search") : 0;
    const all = this.relations.get(relativePath) ?? [];
    if (offset > all.length) throw new KnowledgeAgentIndexError("cursor_invalid", "Relation cursor is out of range.");
    const items = all.slice(offset, offset + normalizePageSize(limit));
    const next = offset + items.length;
    const hasMore = next < all.length;
    return { vaultRelativePath: relativePath, contentRevision: entry.contentRevision, total: all.length, returned: items.length, remaining: Math.max(0, all.length - next), hasMore, exhausted: !hasMore,
      ...(hasMore ? { continuationCursor: encodeCursor({ v: 1, generation: index.generation, queryHash, offset: next }) } : {}), items };
  }

  private rebuildRelations(index: StoredKnowledgeAgentIndex): void {
    const paths = Object.keys(index.entries);
    const graph = new Map<string, KnowledgeRelation[]>();
    const target = (value: string) => { const entry = index.entries[value]; return { vaultRelativePath: value, title: entry.title, contentRevision: entry.contentRevision }; };
    for (const sourcePath of paths) {
      for (const link of index.entries[sourcePath].links ?? []) {
        const resolved = resolveKnowledgeLink({ link, sourcePath, paths, resolveAlias: (value) => resolveKnowledgePath(this.vaultPath, value), hostResolver: this.linkResolver });
        const relation: KnowledgeRelation = { direction: "outgoing", relation: "link", original: link.original,
          ...(link.anchor ? { anchor: link.anchor, anchorStatus: "not_located" } : {}),
          source: { ...target(sourcePath), line: link.line, context: link.context },
          status: resolved.length === 1 ? "available" : resolved.length > 1 ? "ambiguous" : "unresolved",
          ...(resolved.length === 1 ? { target: target(resolved[0]) } : resolved.length > 1 ? { candidates: resolved.map(target) } : {}) };
        graph.set(sourcePath, [...(graph.get(sourcePath) ?? []), relation]);
        if (resolved.length === 1) graph.set(resolved[0], [...(graph.get(resolved[0]) ?? []), { ...relation, direction: "incoming" }]);
      }
    }
    this.relations = graph;
  }

  async readReliableKnowledgeForRaw(
    vaultRelativePath: string
  ): Promise<Readonly<KnowledgeAgentReliableRawKnowledge> | null> {
    await this.ensureFresh();
    const index = this.requireCurrent();
    const rawPath = normalizeRawSourcePath(resolveKnowledgePath(this.vaultPath, vaultRelativePath));
    const raw = index.entries[rawPath];
    if (!raw || raw.kind !== "raw") return null;
    const linked = Object.values(index.entries)
      .filter((entry) => entry.kind === "wiki" || entry.kind === "projects")
      .filter((entry) => entry.rawSources.some((source) =>
        source.vaultRelativePath === rawPath
      ))
      .sort((left, right) => left.vaultRelativePath.localeCompare(right.vaultRelativePath));
    if (!linked.length) return null;
    if (linked.some((entry) => entry.rawSources.some((source) =>
      source.vaultRelativePath === rawPath
      && source.contentRevision !== raw.contentRevision
    ))) return null;
    const entries = await Promise.all(linked.map(async (entry) => {
      const current = await this.read({
        vaultRelativePath: entry.vaultRelativePath,
        expectedContentRevision: entry.contentRevision
      });
      return Object.freeze({
        vaultRelativePath: current.vaultRelativePath,
        title: current.title,
        content: current.content
      });
    }));
    if (!await pathExists(path.join(this.vaultPath, rawPath))) {
      this.invalidate(rawPath);
      return null;
    }
    const rawFile = await resolveIndexedFile(this.vaultPath, rawPath);
    if (await streamedContentRevision(rawFile, rawPath) !== raw.contentRevision) {
      this.invalidate(rawPath);
      return null;
    }
    return Object.freeze({
      rawPath,
      rawContentRevision: raw.contentRevision,
      entries: Object.freeze(entries)
    });
  }

  private async performRefresh(): Promise<KnowledgeAgentIndexRefreshResult> {
    const vaultRoot = await resolveDirectory(this.vaultPath, "Vault");
    await ensurePrivateStorageRoot(this.storageRootPath);
    const previous = this.current ?? await readStoredIndex(this.indexPath);
    const candidates = new Map<string, CandidateEntry>();
    const reused = new Map<string, StoredKnowledgeEntry>();
    let indexedCount = 0;
    let reusedCount = 0;

    for (const kind of KNOWLEDGE_ROOTS) {
      const files = (await Promise.all(knowledgeRoleRoots(vaultRoot, kind).map((root) => walkKnowledgeRoot(vaultRoot, kind, root)))).flat();
      for (const file of files) {
        const oldEntry = previous.entries[file.vaultRelativePath];
        if (oldEntry?.relationSchema === 1 && metadataMatches(oldEntry, file.stat)) {
          reused.set(file.vaultRelativePath, oldEntry);
          reusedCount += 1;
          continue;
        }
        const candidate = await buildCandidateEntry(file, kind);
        if (
          oldEntry
          && oldEntry.contentRevision === candidate.contentRevision
        ) {
          candidate.rawLinks = oldEntry.rawSources.map((source) => ({
            vaultRelativePath: source.vaultRelativePath,
            markerRevision: source.contentRevision
          }));
        }
        candidates.set(file.vaultRelativePath, candidate);
        indexedCount += 1;
      }
    }

    const combined: Record<string, StoredKnowledgeEntry> = {};
    for (const [relativePath, entry] of reused) combined[relativePath] = entry;
    for (const [relativePath, candidate] of candidates) {
      combined[relativePath] = {
        ...candidate,
        rawSources: []
      };
    }

    for (const [relativePath, candidate] of candidates) {
      if (candidate.kind === "raw") continue;
      const oldEntry = previous.entries[relativePath];
      const contentUnchanged = oldEntry?.contentRevision
        === candidate.contentRevision;
      combined[relativePath].rawSources = uniqueRawLinks(candidate.rawLinks.map((source) => ({ ...source, vaultRelativePath: resolveKnowledgePath(vaultRoot, source.vaultRelativePath) })))
        .map((source) => ({
          vaultRelativePath: source.vaultRelativePath,
          contentRevision: source.markerRevision
            ?? (contentUnchanged
              ? oldEntry?.rawSources.find((item) =>
                  item.vaultRelativePath === source.vaultRelativePath
                )?.contentRevision ?? null
              : null)
            ?? combined[source.vaultRelativePath]?.contentRevision
            ?? null
        }));
    }

    for (const entry of Object.values(combined)) {
      entry.rawSources = entry.rawSources.map((source) => ({ ...source, vaultRelativePath: resolveKnowledgePath(vaultRoot, source.vaultRelativePath) }));
    }
    const nextPaths = Object.keys(combined).sort((left, right) =>
      left.localeCompare(right)
    );
    const previousPaths = Object.keys(previous.entries);
    const deletedPaths = previousPaths
      .filter((relativePath) => !combined[relativePath])
      .sort((left, right) => left.localeCompare(right));
    const changedPaths = nextPaths
      .filter((relativePath) => !sameEntry(
        previous.entries[relativePath],
        combined[relativePath]
      ))
      .sort((left, right) => left.localeCompare(right));
    const semanticChanged = changedPaths.length > 0 || deletedPaths.length > 0;
    const recentMetadataChanged = nextPaths.some((relativePath) => {
      const oldEntry = previous.entries[relativePath];
      return oldEntry !== undefined
        && Math.abs(oldEntry.mtimeMs - combined[relativePath].mtimeMs) >= 1;
    });
    const recentSnapshotChanged = semanticChanged || recentMetadataChanged;
    const metadataChanged = indexedCount > 0;
    const next: StoredKnowledgeAgentIndex = {
      schemaVersion: KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION,
      generation: semanticChanged
        ? Math.max(0, previous.generation) + 1
        : previous.generation,
      recentGeneration: recentSnapshotChanged
        ? Math.max(0, previous.recentGeneration) + 1
        : previous.recentGeneration,
      updatedAt: recentSnapshotChanged ? Date.now() : previous.updatedAt,
      entries: Object.fromEntries(nextPaths.map((relativePath) => [
        relativePath,
        combined[relativePath]
      ]))
    };
    const indexMissing = !await pathExists(this.indexPath);
    if (semanticChanged || metadataChanged || indexMissing) {
      if (indexMissing && next.generation === 0) {
        next.generation = 1;
        next.updatedAt = Date.now();
      }
      await persistIndex(this.indexPath, next);
    }
    this.rebuildRelations(next);
    this.current = next;
    return Object.freeze({
      generation: next.generation,
      entries: nextPaths.length,
      indexed: indexedCount,
      reused: reusedCount,
      changedPaths: Object.freeze([...changedPaths]) as unknown as string[],
      deletedPaths: Object.freeze([...deletedPaths]) as unknown as string[],
      indexPath: this.indexPath
    });
  }

  private requireCurrent(): StoredKnowledgeAgentIndex {
    if (!this.current) {
      throw new KnowledgeAgentIndexError(
        "not_found",
        "Knowledge index has not been initialized."
      );
    }
    return this.current;
  }
}

export function formatKnowledgeRawSourceMarker(
  vaultRelativePath: string,
  contentRevisionValue: string
): string {
  const sourcePath = normalizeRawSourcePath(vaultRelativePath);
  const revision = normalizeRevision(contentRevisionValue);
  return `<!-- ${KNOWLEDGE_AGENT_SOURCE_MARKER}: ${JSON.stringify({
    path: sourcePath,
    revision
  })} -->`;
}

async function buildCandidateEntry(
  file: Readonly<{
    absolutePath: string;
    vaultRelativePath: string;
    stat: Stats;
  }>,
  kind: KnowledgeAgentKind
): Promise<CandidateEntry> {
  const isText = kind !== "raw"
    || RAW_TEXT_EXTENSIONS.has(path.extname(file.vaultRelativePath).toLowerCase());
  const bytes = isText ? await fsp.readFile(file.absolutePath) : null;
  const text = bytes ? decodeUtf8(bytes) : "";
  const title = knowledgeTitle(file.vaultRelativePath, text);
  return {
    entryId: stableEntryId(file.vaultRelativePath),
    vaultRelativePath: file.vaultRelativePath,
    kind,
    title,
    contentRevision: bytes
      ? contentRevision(bytes, file.vaultRelativePath)
      : await streamedContentRevision(file.absolutePath),
    size: file.stat.size,
    mtimeMs: file.stat.mtimeMs,
    ctimeMs: file.stat.ctimeMs,
    pathTokens: tokenCounts(file.vaultRelativePath),
    titleTokens: tokenCounts(title),
    bodyTokens: isText ? tokenCounts(text) : {},
    relationSchema: 1,
    links: extractKnowledgeLinks(text),
    applicability: extractKnowledgeApplicability(text),
    rawLinks: kind === "raw"
      ? []
      : extractRawSourceLinks(text, file.vaultRelativePath)
  };
}

async function walkKnowledgeRoot(
  vaultRoot: string,
  kind: KnowledgeAgentKind,
  actualRoot: string = kind
): Promise<Array<{
  absolutePath: string;
  vaultRelativePath: string;
  stat: Stats;
}>> {
  const rootPath = path.join(vaultRoot, actualRoot);
  const rootStat = await fsp.lstat(rootPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new KnowledgeAgentIndexError(
      "unsafe_path",
      `Knowledge root is not a normal directory: ${kind}`
    );
  }
  const files: Array<{
    absolutePath: string;
    vaultRelativePath: string;
    stat: Stats;
  }> = [];
  const walk = async (directoryPath: string): Promise<void> => {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    for (const directoryEntry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (isHiddenName(directoryEntry.name)) continue;
      const absolutePath = path.join(directoryPath, directoryEntry.name);
      const stat = await fsp.lstat(absolutePath);
      const relativePath = path.relative(vaultRoot, absolutePath)
        .split(path.sep).join("/");
      if (stat.isSymbolicLink()) {
        throw new KnowledgeAgentIndexError(
          "unsafe_path",
          `Knowledge root contains a symbolic link: ${relativePath}`
        );
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw new KnowledgeAgentIndexError(
          "unsafe_path",
          `Knowledge root contains an unsupported file: ${relativePath}`
        );
      }
      if (!shouldIndexPath(relativePath, kind)) continue;
      files.push({ absolutePath, vaultRelativePath: relativePath, stat });
    }
  };
  await walk(rootPath);
  return files;
}

function shouldIndexPath(
  relativePath: string,
  kind: KnowledgeAgentKind
): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (kind === "raw") {
    const lower = knowledgeRolePath(relativePath).toLowerCase();
    if (lower === "raw/index.md" || /^raw\/index \d+\.md$/u.test(lower)) {
      return false;
    }
    return true;
  }
  return KNOWLEDGE_MARKDOWN_EXTENSIONS.has(extension);
}

function extractRawSourceLinks(
  text: string,
  knowledgePath: string
): CandidateEntry["rawLinks"] {
  const markerRevisions = new Map<string, string>();
  for (const match of text.matchAll(
    /<!--\s*echoink-source\s*:\s*(\{[^\r\n]*\})\s*-->/gu
  )) {
    try {
      const parsed = JSON.parse(match[1] ?? "") as {
        path?: unknown;
        revision?: unknown;
      };
      if (typeof parsed.path !== "string" || typeof parsed.revision !== "string") {
        continue;
      }
      markerRevisions.set(
        normalizeRawSourcePath(parsed.path),
        normalizeRevision(parsed.revision)
      );
    } catch {
      // Invalid untrusted markers are ignored; maintenance validates its output.
    }
  }
  const links = new Set<string>();
  for (const match of text.matchAll(
    /\[\[([^\]|#\r\n]+)(?:#[^\]|\r\n]+)?(?:\|[^\]\r\n]+)?\]\]/gu
  )) {
    const source = resolveRawLink(match[1] ?? "", knowledgePath);
    if (source) links.add(source);
  }
  for (const match of text.matchAll(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/gu)) {
    const rawTarget = (match[1] ?? "").trim().replace(/^<|>$/gu, "")
      .split(/\s+["']/u, 1)[0] ?? "";
    const source = resolveRawLink(rawTarget, knowledgePath);
    if (source) links.add(source);
  }
  for (const markerPath of markerRevisions.keys()) links.add(markerPath);
  return Array.from(links)
    .sort((left, right) => left.localeCompare(right))
    .map((vaultRelativePath) => ({
      vaultRelativePath,
      markerRevision: markerRevisions.get(vaultRelativePath) ?? null
    }));
}

function resolveRawLink(value: string, knowledgePath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.trim());
  } catch {
    return null;
  }
  if (!decoded || /^[a-z]+:\/\//iu.test(decoded)) return null;
  const withoutAnchor = decoded.split(/[?#]/u, 1)[0]?.replace(/^\/+/, "") ?? "";
  const candidate = knowledgeRolePath(withoutAnchor).toLowerCase().startsWith("raw/")
    ? path.posix.normalize(withoutAnchor)
    : path.posix.normalize(path.posix.join(
        path.posix.dirname(knowledgePath),
        withoutAnchor
      ));
  try {
    return normalizeRawSourcePath(candidate);
  } catch {
    return null;
  }
}

function uniqueRawLinks(
  links: CandidateEntry["rawLinks"]
): CandidateEntry["rawLinks"] {
  const byPath = new Map<string, CandidateEntry["rawLinks"][number]>();
  for (const link of links) {
    const current = byPath.get(link.vaultRelativePath);
    if (!current || (!current.markerRevision && link.markerRevision)) {
      byPath.set(link.vaultRelativePath, link);
    }
  }
  return Array.from(byPath.values()).sort((left, right) =>
    left.vaultRelativePath.localeCompare(right.vaultRelativePath)
  );
}

function materializeHit(
  entry: StoredKnowledgeEntry,
  index: StoredKnowledgeAgentIndex
): KnowledgeAgentSearchHit {
  return {
    ...entry.applicability,
    entryId: entry.entryId,
    vaultRelativePath: entry.vaultRelativePath,
    kind: entry.kind,
    title: entry.title,
    contentRevision: entry.contentRevision,
    recordedAt: entry.mtimeMs,
    verificationStatus: verificationPriority(entry, index) === 0
      ? "local_revision_verified" as const
      : "source_link_changed" as const,
    rawSources: entry.rawSources.map((source) => {
      const current = index.entries[source.vaultRelativePath];
      if (!current || current.kind !== "raw") {
        return {
          vaultRelativePath: source.vaultRelativePath,
          ...(source.contentRevision
            ? { contentRevision: source.contentRevision }
            : {}),
          status: "missing" as const
        };
      }
      if (!source.contentRevision || source.contentRevision === current.contentRevision) {
        return {
          vaultRelativePath: source.vaultRelativePath,
          contentRevision: source.contentRevision ?? current.contentRevision,
          status: "available" as const
        };
      }
      return {
        vaultRelativePath: source.vaultRelativePath,
        contentRevision: source.contentRevision,
        currentContentRevision: current.contentRevision,
        status: "changed" as const
      };
    })
  };
}

function verificationPriority(
  entry: StoredKnowledgeEntry,
  index: StoredKnowledgeAgentIndex
): number {
  return entry.rawSources.some((source) => {
    const current = index.entries[source.vaultRelativePath];
    return !current
      || current.kind !== "raw"
      || (source.contentRevision !== null
        && source.contentRevision !== current.contentRevision);
  }) ? 1 : 0;
}

function freezeHit(hit: KnowledgeAgentSearchHit): KnowledgeAgentSearchHit {
  return Object.freeze({
    ...hit,
    rawSources: Object.freeze(
      hit.rawSources.map((source) => Object.freeze({ ...source }))
    ) as unknown as KnowledgeAgentRawSource[]
  });
}

function scoreEntry(
  entry: StoredKnowledgeEntry,
  queryTokens: Record<string, number>
): number {
  let score = 0;
  let matched = 0;
  for (const token of Object.keys(queryTokens)) {
    const pathHits = entry.pathTokens[token] ?? 0;
    const titleHits = entry.titleTokens[token] ?? 0;
    const bodyHits = entry.bodyTokens[token] ?? 0;
    if (pathHits + titleHits + bodyHits === 0) continue;
    matched += 1;
    score += Math.min(pathHits, 4) * 24;
    score += Math.min(titleHits, 4) * 32;
    score += Math.min(bodyHits, 20) * 4;
  }
  return matched === 0 ? 0 : score + matched * 4;
}

function tokenCounts(value: string): Record<string, number> {
  const counts = new Map<string, number>();
  const add = (token: string) => {
    const normalized = token.toLowerCase().trim();
    if (normalized.length < 2) return;
    const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
    counts.set(digest, Math.min(20, (counts.get(digest) ?? 0) + 1));
  };
  for (const match of value.matchAll(/[a-z0-9][a-z0-9_-]{1,}/giu)) {
    add(match[0]);
  }
  for (const match of value.matchAll(/[\u3400-\u9fff]{2,}/gu)) {
    const text = match[0];
    if (text.length <= 64) add(text);
    for (let size = 2; size <= Math.min(4, text.length); size += 1) {
      for (let index = 0; index <= text.length - size; index += 1) {
        add(text.slice(index, index + size));
      }
    }
  }
  return Object.fromEntries(Array.from(counts.entries()).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

function knowledgeQueryHash(
  queryTokens: Record<string, number>,
  kinds: readonly KnowledgeAgentKind[],
  excludedPaths: readonly string[],
  mode: "search" | "recent" = "search"
): string {
  return createHash("sha256")
    .update(JSON.stringify(mode === "search"
      ? {
          tokens: Object.keys(queryTokens),
          kinds,
          excludedPaths
        }
      : {
          mode,
          kinds,
          excludedPaths
        }))
    .digest("hex");
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  generation: number,
  queryHash: string,
  mode: "search" | "recent"
): number {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as
      Partial<CursorPayload>;
    if (
      parsed.v !== 1
      || (parsed.mode !== undefined && parsed.mode !== "recent")
      || !Number.isInteger(parsed.generation)
      || !Number.isInteger(parsed.offset)
      || (parsed.offset ?? -1) < 0
      || typeof parsed.queryHash !== "string"
    ) {
      throw new Error("invalid");
    }
    const cursorMode = parsed.mode ?? "search";
    if (cursorMode !== mode) {
      throw new KnowledgeAgentIndexError(
        "cursor_invalid",
        "Knowledge continuation cursor does not match this query mode."
      );
    }
    if (parsed.generation !== generation) {
      throw new KnowledgeAgentIndexError(
        "cursor_stale",
        "Knowledge changed after this result page. Search again."
      );
    }
    if (parsed.queryHash !== queryHash) {
      throw new KnowledgeAgentIndexError(
        "cursor_invalid",
        "Knowledge continuation cursor does not match this query."
      );
    }
    return parsed.offset as number;
  } catch (error) {
    if (error instanceof KnowledgeAgentIndexError) throw error;
    throw new KnowledgeAgentIndexError(
      "cursor_invalid",
      "Knowledge continuation cursor is invalid."
    );
  }
}

async function readStoredIndex(indexPath: string): Promise<StoredKnowledgeAgentIndex> {
  const stat = await fsp.lstat(indexPath).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!stat) return emptyIndex();
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new KnowledgeAgentIndexError(
      "unsafe_path",
      "Knowledge index path is not a normal file."
    );
  }
  try {
    return normalizeStoredIndex(JSON.parse(await fsp.readFile(indexPath, "utf8")));
  } catch {
    return emptyIndex();
  }
}

async function persistIndex(
  indexPath: string,
  index: StoredKnowledgeAgentIndex
): Promise<void> {
  await writeFileAtomic(indexPath, `${JSON.stringify(index)}\n`);
}

function normalizeStoredIndex(value: unknown): StoredKnowledgeAgentIndex {
  if (!value || typeof value !== "object") return emptyIndex();
  const record = value as Partial<StoredKnowledgeAgentIndex>;
  if (record.schemaVersion !== KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION) {
    return emptyIndex();
  }
  const entries: Record<string, StoredKnowledgeEntry> = {};
  const rawEntries = record.entries && typeof record.entries === "object"
    ? record.entries
    : {};
  for (const candidate of Object.values(rawEntries)) {
    const entry = normalizeStoredEntry(candidate);
    if (entry) entries[entry.vaultRelativePath] = entry;
  }
  return {
    schemaVersion: KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION,
    generation: Number.isInteger(record.generation) && (record.generation ?? -1) >= 0
      ? record.generation as number
      : 0,
    recentGeneration: Number.isInteger(record.recentGeneration)
      && (record.recentGeneration ?? -1) >= 0
      ? record.recentGeneration as number
      : Number.isInteger(record.generation) && (record.generation ?? -1) >= 0
        ? record.generation as number
        : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    entries: Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]))
  };
}

function normalizeStoredEntry(value: unknown): StoredKnowledgeEntry | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StoredKnowledgeEntry>;
  try {
    const relativePath = normalizeKnowledgePath(record.vaultRelativePath ?? "");
    const kind = knowledgeKindForPath(relativePath);
    if (!kind || record.kind !== kind) return null;
    const revision = normalizeRevision(record.contentRevision ?? "");
    const rawSources = Array.isArray(record.rawSources)
      ? record.rawSources.flatMap((source) => {
          if (!source || typeof source !== "object") return [];
          const raw = source as Partial<StoredRawSource>;
          try {
            return [{
              vaultRelativePath: normalizeRawSourcePath(raw.vaultRelativePath ?? ""),
              contentRevision: raw.contentRevision === null
                ? null
                : normalizeRevision(raw.contentRevision ?? "")
            }];
          } catch {
            return [];
          }
        })
      : [];
    return {
      entryId: typeof record.entryId === "string"
        ? record.entryId
        : stableEntryId(relativePath),
      vaultRelativePath: relativePath,
      kind,
      title: typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : path.posix.basename(relativePath, path.posix.extname(relativePath)),
      contentRevision: revision,
      size: normalizeNonNegativeNumber(record.size),
      mtimeMs: normalizeNonNegativeNumber(record.mtimeMs),
      ctimeMs: normalizeNonNegativeNumber(record.ctimeMs),
      pathTokens: normalizeTokenRecord(record.pathTokens),
      titleTokens: normalizeTokenRecord(record.titleTokens),
      bodyTokens: normalizeTokenRecord(record.bodyTokens),
      rawSources,
      ...(record.relationSchema === 1 && Array.isArray(record.links) ? {
        relationSchema: 1 as const,
        links: record.links.filter((link) => link && typeof link.target === "string" && typeof link.original === "string" && typeof link.context === "string" && Number.isSafeInteger(link.line) && link.line > 0),
        applicability: record.applicability && typeof record.applicability === "object" ? record.applicability : {}
      } : {})
    };
  } catch {
    return null;
  }
}

function normalizeTokenRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, number> = {};
  for (const [token, count] of Object.entries(value)) {
    if (token.length < 2 || typeof count !== "number" || !Number.isFinite(count)) {
      continue;
    }
    result[token] = Math.max(1, Math.min(20, Math.floor(count)));
  }
  return result;
}

function emptyIndex(): StoredKnowledgeAgentIndex {
  return {
    schemaVersion: KNOWLEDGE_AGENT_INDEX_SCHEMA_VERSION,
    generation: 0,
    recentGeneration: 0,
    updatedAt: 0,
    entries: {}
  };
}

function sameEntry(
  left: StoredKnowledgeEntry | undefined,
  right: StoredKnowledgeEntry
): boolean {
  if (!left) return false;
  return JSON.stringify({
    entryId: left.entryId,
    path: left.vaultRelativePath,
    kind: left.kind,
    title: left.title,
    revision: left.contentRevision,
    pathTokens: left.pathTokens,
    titleTokens: left.titleTokens,
    bodyTokens: left.bodyTokens,
    rawSources: left.rawSources,
    links: left.links,
    applicability: left.applicability
  }) === JSON.stringify({
    entryId: right.entryId,
    path: right.vaultRelativePath,
    kind: right.kind,
    title: right.title,
    revision: right.contentRevision,
    pathTokens: right.pathTokens,
    titleTokens: right.titleTokens,
    bodyTokens: right.bodyTokens,
    rawSources: right.rawSources,
    links: right.links,
    applicability: right.applicability
  });
}

function metadataMatches(
  entry: StoredKnowledgeEntry,
  stat: Stats
): boolean {
  return entry.size === stat.size
    && Math.abs(entry.mtimeMs - stat.mtimeMs) < 1
    && Math.abs(entry.ctimeMs - stat.ctimeMs) < 1;
}

async function resolveDirectory(value: string, label: string): Promise<string> {
  const resolved = await fsp.realpath(value).catch(() => "");
  if (!resolved) {
    throw new KnowledgeAgentIndexError("invalid_path", `${label} is unavailable.`);
  }
  const stat = await fsp.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new KnowledgeAgentIndexError("unsafe_path", `${label} is not a normal directory.`);
  }
  return resolved;
}

async function ensurePrivateStorageRoot(storageRootPath: string): Promise<void> {
  await fsp.mkdir(storageRootPath, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(storageRootPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new KnowledgeAgentIndexError(
      "unsafe_path",
      "Knowledge private storage is not a normal directory."
    );
  }
}

async function resolveIndexedFile(
  vaultRoot: string,
  relativePath: string
): Promise<string> {
  const canonicalRoot = await fsp.realpath(vaultRoot).catch(() => "");
  if (!canonicalRoot) {
    throw new KnowledgeAgentIndexError("invalid_path", "Vault is unavailable.");
  }
  const candidate = path.resolve(canonicalRoot, ...relativePath.split("/"));
  const relative = path.relative(canonicalRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge path is outside the Vault.");
  }
  const real = await fsp.realpath(candidate).catch(() => "");
  if (!real || real !== candidate) {
    throw new KnowledgeAgentIndexError("unsafe_path", "Knowledge path is not a normal Vault file.");
  }
  const stat = await fsp.lstat(real);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new KnowledgeAgentIndexError("unsafe_path", "Knowledge path is not a normal Vault file.");
  }
  return real;
}

function normalizeKnowledgePath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge path is invalid.");
  }
  const slashed = value.trim().replace(/\\/gu, "/");
  if (slashed.startsWith("/") || path.posix.isAbsolute(slashed)) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge path must be Vault-relative.");
  }
  const normalized = path.posix.normalize(slashed);
  const segments = normalized.split("/");
  if (
    normalized === "."
    || normalized.startsWith("../")
    || segments.some((segment) => !segment || segment === ".." || isHiddenName(segment))
    || !knowledgeKindForPath(normalized)
  ) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge path is outside the indexed roots.");
  }
  return normalized;
}

function normalizeRawSourcePath(value: string): string {
  const normalized = normalizeKnowledgePath(value);
  if (!knowledgeRolePath(normalized).toLowerCase().startsWith("raw/")) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge source must be under raw/.");
  }
  return normalized;
}

function normalizeRevision(value: string): string {
  if (!REVISION_PATTERN.test(value)) {
    throw new KnowledgeAgentIndexError("invalid_path", "Knowledge source revision is invalid.");
  }
  return value;
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new KnowledgeAgentIndexError("invalid_query", "Knowledge query must not be empty.");
  }
  return value.trim();
}

function normalizeKinds(
  value: readonly KnowledgeAgentKind[] | undefined
): KnowledgeAgentKind[] {
  if (!value?.length) return [...KNOWLEDGE_ROOTS];
  return Array.from(new Set(value))
    .filter((kind): kind is KnowledgeAgentKind => KNOWLEDGE_ROOTS.includes(kind))
    .sort((left, right) => kindPriority(left) - kindPriority(right));
}

function normalizeExcludedPaths(
  values: readonly string[] | undefined
): string[] {
  if (!values?.length) return [];
  return Array.from(new Set(values.map(normalizeKnowledgePath)))
    .sort((left, right) => left.localeCompare(right));
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 8;
  return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function knowledgeKindForPath(value: string): KnowledgeAgentKind | null {
  const root = knowledgeRootRole(value);
  return KNOWLEDGE_ROOTS.includes(root as KnowledgeAgentKind)
    ? root as KnowledgeAgentKind
    : null;
}

function kindPriority(kind: KnowledgeAgentKind): number {
  if (kind === "wiki") return 0;
  if (kind === "projects") return 1;
  return 2;
}

function isTextEntry(entry: StoredKnowledgeEntry): boolean {
  return entry.kind !== "raw"
    || RAW_TEXT_EXTENSIONS.has(path.extname(entry.vaultRelativePath).toLowerCase());
}

function knowledgeTitle(relativePath: string, text: string): string {
  return text.match(/^#\s+(.+)$/mu)?.[1]?.trim()
    || path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function contentRevision(bytes: Uint8Array, relativePath = ""): string {
  if (knowledgeRolePath(relativePath).startsWith("raw/") && isRawMarkdownPath(relativePath)) return `sha256:${rawDigestFingerprint(relativePath, Buffer.from(bytes)).split(":").at(-1)}`;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function streamedContentRevision(absolutePath: string, relativePath = ""): Promise<string> {
  if (knowledgeRolePath(relativePath).startsWith("raw/") && isRawMarkdownPath(relativePath)) return contentRevision(await fsp.readFile(absolutePath), relativePath);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `sha256:${hash.digest("hex")}`;
}

function stableEntryId(relativePath: string): string {
  return `knowledge-entry:${createHash("sha256")
    .update(relativePath)
    .digest("hex")}`;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new KnowledgeAgentIndexError(
      "unsupported_content",
      "Knowledge text is not valid UTF-8."
    );
  }
}

function isHiddenName(value: string): boolean {
  return value.startsWith(".") || value === ".DS_Store";
}

async function pathExists(value: string): Promise<boolean> {
  return await fsp.lstat(value).then(() => true, (error) => {
    if (isMissingPathError(error)) return false;
    throw error;
  });
}
