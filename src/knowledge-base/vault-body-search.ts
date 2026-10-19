import type { App, TFile } from "obsidian";
import { sha256Hex } from "../utils/sha256";
import { KNOWLEDGE_ROOT_ROLES, knowledgeRootRole } from "./root-paths-core";
import type { KnowledgeFolderBindings } from "./folder-bindings";
import { BodySearchMemoryIndex } from "./search/body-search";
import type { BodySearchDocument, KnowledgeSearchKind } from "./search/contracts";
import type { KnowledgeAgentReadResult, KnowledgeAgentSearchRequest, KnowledgeAgentSearchResult } from "./knowledge-agent-index";

export interface KnowledgeBodySearchPort {
  allowsPath(path: string): boolean;
  scopeKey(): string;
  invalidate(path?: string): void;
  dispose(): void;
  search(request: Readonly<KnowledgeAgentSearchRequest>): Promise<KnowledgeAgentSearchResult>;
  read(input: Readonly<{ vaultRelativePath: string; expectedContentRevision?: string }>): Promise<KnowledgeAgentReadResult>;
}

export function knowledgeSearchPathKind(relativePath: string, bindings?: KnowledgeFolderBindings | null, excludedRoots: readonly string[] = []): KnowledgeSearchKind | null {
  const parts = relativePath.split("/");
  if (!relativePath || relativePath.startsWith("/") || /[\\:\x00-\x1f]/u.test(relativePath)
    || parts.some(part => !part || part.startsWith(".")) || !/\.(?:md|markdown)$/iu.test(relativePath)
    || excludedRoots.some(root => root && (relativePath === root || relativePath.startsWith(`${root}/`)))) return null;
  // Disabled bindings still own their paths. Never reclassify them as notes.
  const matches = bindings ? KNOWLEDGE_ROOT_ROLES.flatMap(role => bindings.roles[role].readPaths
    .filter(root => relativePath === root || relativePath.startsWith(`${root}/`)).map(root => ({ role, root }))) : [];
  matches.sort((a, b) => b.root.length - a.root.length || (a.role === "raw" ? -1 : b.role === "raw" ? 1 : a.role.localeCompare(b.role)));
  let role = matches[0]?.role ?? (!bindings ? knowledgeRootRole(relativePath) : null);
  if (role === "inbox" && bindings && (!bindings.roles.inbox.enabled || bindings.roles.inbox.searchEnabled === false)) {
    const shared = matches.find(match => match.root === matches[0].root && match.role !== "inbox" && match.role !== "templates" && match.role !== "assets"
      && bindings.roles[match.role].enabled && bindings.roles[match.role].searchEnabled !== false);
    if (shared) role = shared.role;
  }
  if (!role && bindings && parts.length === 1) {
    if (bindings.roles.journal.native && !bindings.roles.journal.readPaths.length && /^\d{4}-\d{2}-\d{2}\.(?:md|markdown)$/u.test(relativePath)) role = "journal";
    else if (bindings.roles.templates.native && !bindings.roles.templates.readPaths.length) role = "templates";
  }
  if (role === "templates" || role === "assets") return null;
  if (role && bindings && (!bindings.roles[role].enabled || bindings.roles[role].searchEnabled === false)) return null;
  return role ?? "notes";
}

/** Bind public host events once per owning runtime; release is idempotent. */
export function bindVaultBodySearchEvents(app: App, target: Pick<KnowledgeBodySearchPort, "invalidate">,
  options: Readonly<{ vaultEvents?: boolean }> = {}): () => void {
  const releases: (() => void)[] = [];
  const changed = (file: { path: string }) => target.invalidate(file.path);
  if (options.vaultEvents !== false && app.vault.on) {
    const refs = [app.vault.on("create", changed), app.vault.on("modify", changed), app.vault.on("delete", changed)];
    refs.forEach(ref => releases.push(() => app.vault.offref(ref)));
    const ref = app.vault.on("rename", (file, oldPath) => { changed(file); target.invalidate(oldPath); });
    releases.push(() => app.vault.offref(ref));
  }
  if (app.metadataCache?.on) {
    const ref = app.metadataCache.on("changed", changed);
    releases.push(() => app.metadataCache.offref(ref));
  }
  let released = false;
  return () => { if (released) return; released = true; releases.forEach(release => release()); };
}

/** Public Vault API adapter with a bounded, ephemeral search index. */
export class VaultBodySearch implements KnowledgeBodySearchPort {
  private generation = 1;
  private disposed = false;
  private indexedScope?: string;
  private observedPaths = new Set<string>();
  private readonly activeReads = new Set<{ path: string; invalidated: boolean }>();
  private readonly memory = new BodySearchMemoryIndex();
  constructor(private readonly app: App, private readonly bindings: () => KnowledgeFolderBindings | null | undefined,
    private readonly options: Readonly<{ excludedRoots?: () => readonly string[]; onJournalSearch?: () => void | Promise<void> }> = {}) {}
  invalidate(path?: string): void {
    if (this.disposed) return;
    const normalized = path?.replace(/\\/gu, "/").replace(/\/+$/u, "");
    if (normalized !== undefined && !this.relevantEvent(normalized)) return;
    this.generation += 1;
    for (const reading of this.activeReads) if (normalized === undefined || this.containsPath(normalized, reading.path)) reading.invalidated = true;
    this.memory.invalidate(normalized);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation += 1; this.memory.dispose();
    this.observedPaths.clear(); this.activeReads.clear();
  }
  private assertOpen(): void { if (this.disposed) throw Object.assign(new Error("Knowledge search disposed"), { code: "disposed" }); }
  private ensureScope(): string {
    this.assertOpen();
    const signature = this.scopeKey();
    if (signature !== this.indexedScope) { this.indexedScope = signature; this.generation += 1; this.memory.clear(); }
    return signature;
  }
  allowsPath(path: string): boolean { return knowledgeSearchPathKind(path, this.bindings(), this.options.excludedRoots?.()) !== null; }
  scopeKey(): string { return JSON.stringify([this.bindings(), this.options.excludedRoots?.() ?? []]); }
  private containsPath(directory: string, path: string): boolean { return !directory || directory === path || path.startsWith(`${directory}/`); }
  private relevantEvent(path: string): boolean {
    if (this.allowsPath(path)) return true;
    // Deleted/renamed directories may no longer exist in the live Vault listing.
    // Recheck current policy so remembered paths cannot bypass private/disabled roots.
    const affected = (source: string) => this.containsPath(path, source) && this.allowsPath(source);
    for (const source of this.observedPaths) if (affected(source)) return true;
    for (const reading of this.activeReads) if (affected(reading.path)) return true;
    return this.app.vault.getMarkdownFiles().some(file => affected(file.path));
  }
  private allowed(filePath: string): KnowledgeSearchKind {
    this.assertOpen();
    const kind = knowledgeSearchPathKind(filePath, this.bindings(), this.options.excludedRoots?.());
    if (!kind) throw Object.assign(new Error("Knowledge path is outside the search scope"), { code: "invalid_path" });
    return kind;
  }
  private file(filePath: string): TFile {
    this.allowed(filePath);
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !("extension" in file)) throw Object.assign(new Error("Source not found"), { code: "not_found" });
    return file as TFile;
  }
  async read(input: Readonly<{ vaultRelativePath: string; expectedContentRevision?: string }>): Promise<KnowledgeAgentReadResult> {
    const scope = this.scopeKey();
    const file = this.file(input.vaultRelativePath);
    const version = JSON.stringify([file.stat.mtime, file.stat.size, file.basename]);
    const reading = { path: input.vaultRelativePath, invalidated: false };
    this.activeReads.add(reading);
    try {
      const content = await this.app.vault.read(file);
      this.assertOpen();
      if (scope !== this.scopeKey() || reading.invalidated || file.path !== input.vaultRelativePath) throw Object.assign(new Error("Source changed"), { code: "source_changed" });
      const current = this.file(input.vaultRelativePath);
      if (version !== JSON.stringify([current.stat.mtime, current.stat.size, current.basename])) throw Object.assign(new Error("Source changed"), { code: "source_changed" });
      const kind = this.allowed(file.path);
      const contentRevision = `sha256:${sha256Hex(content)}`;
      if (input.expectedContentRevision && input.expectedContentRevision !== contentRevision) throw Object.assign(new Error("Source changed"), { code: "source_changed" });
      return { entryId: `body:${file.path}`, vaultRelativePath: file.path, kind, title: file.basename,
        contentRevision, content, recordedAt: Math.trunc(file.stat.mtime), verificationStatus: "local_revision_verified", rawSources: [] };
    } finally { this.activeReads.delete(reading); }
  }
  async search(request: Readonly<KnowledgeAgentSearchRequest>): Promise<KnowledgeAgentSearchResult> {
    const scope = this.ensureScope();
    if (request.signal?.aborted) throw Object.assign(new Error("Knowledge search aborted"), { name: "AbortError" });
    const generation = this.generation;
    const bindingSignature = JSON.stringify(this.bindings());
    const excludedRoots = [...(this.options.excludedRoots?.() ?? [])];
    const documents: BodySearchDocument[] = this.app.vault.getMarkdownFiles().flatMap(file => {
      const kind = knowledgeSearchPathKind(file.path, this.bindings(), excludedRoots);
      if (!kind) return [];
      let cache: ReturnType<App["metadataCache"]["getFileCache"]> = null;
      try { cache = this.app.metadataCache?.getFileCache(file) ?? null; } catch { /* Missing metadata must not hide readable Markdown. */ }
      const array = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      const aliases = array(cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias);
      const tags = [...array(cache?.frontmatter?.tags), ...(cache?.tags?.map(tag => tag.tag) ?? [])];
      const headings = cache?.headings?.map(h => ({ heading: h.heading, level: h.level, line: h.position.start.line + 1 }));
      return [{ vaultRelativePath: file.path, title: file.basename, kind, recordedAt: Math.trunc(file.stat.mtime),
        revisionKey: JSON.stringify([file.stat.mtime, file.stat.size, file.basename, kind, aliases, tags, headings]),
        aliases, tags, headings,
        read: () => this.read({ vaultRelativePath: file.path }) }];
    });
    this.observedPaths = new Set(documents.map(document => document.vaultRelativePath));
    if (documents.some(document => document.kind === "journal")) await this.options.onJournalSearch?.();
    const queryKey = sha256Hex(JSON.stringify({ mode: request.mode, query: request.query, queries: request.queries, kinds: request.kinds,
      dateFrom: request.dateFrom, dateTo: request.dateTo, excludePaths: request.excludePaths, bindingSignature,
      excludedRoots, files: documents.map(d => [d.vaultRelativePath, d.revisionKey]) }));
    let offset = 0;
    if (request.cursor) {
      try {
        const cursor = JSON.parse(request.cursor);
        if (cursor.key !== queryKey || cursor.generation !== generation) throw Object.assign(new Error("Search cursor is stale"), { code: "cursor_stale" });
        if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error("offset");
        offset = cursor.offset;
      } catch (error) {
        if ((error as { code?: string }).code === "cursor_stale") throw error;
        throw Object.assign(new Error("Invalid search cursor"), { code: "cursor_invalid" });
      }
    }
    const limit = Math.max(0, Math.min(50, request.limit ?? 20));
    if (request.mode === "recent") {
      if (request.query !== undefined || request.queries !== undefined) throw Object.assign(new Error("Recent browsing does not accept a query"), { code: "invalid_query" });
      const eligible = documents.filter(document => (!request.kinds?.length || request.kinds.includes(document.kind)) && !request.excludePaths?.includes(document.vaultRelativePath))
        .sort((a, b) => b.recordedAt - a.recordedAt || a.vaultRelativePath.localeCompare(b.vaultRelativePath));
      const page = eligible.slice(offset, offset + limit);
      const hits: KnowledgeAgentReadResult[] = [];
      let failedFiles = 0;
      for (const document of page) {
        if (request.signal?.aborted) throw Object.assign(new Error("Knowledge search aborted"), { name: "AbortError" });
        try { hits.push(await this.read({ vaultRelativePath: document.vaultRelativePath })); } catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; failedFiles++; }
      }
      if (request.signal?.aborted) throw Object.assign(new Error("Knowledge search aborted"), { name: "AbortError" });
      this.assertCurrent(scope, generation, Boolean(request.cursor));
      const remaining = Math.max(0, eligible.length - offset - page.length);
      return { generation, total: eligible.length, returned: hits.length, remaining, hasMore: remaining > 0, exhausted: remaining === 0 && failedFiles === 0,
        coverage: { totalFiles: eligible.length, scannedFiles: hits.length, readFiles: page.length, cachedFiles: 0, indexedFiles: hits.length, failedFiles, complete: hits.length === eligible.length && failedFiles === 0, unknownJournalDates: 0 },
        hits: hits.map(({ content: _content, ...hit }) => hit),
        ...(remaining ? { continuationCursor: JSON.stringify({ key: queryKey, generation, offset: offset + page.length }) } : {}) };
    }
    let result: Awaited<ReturnType<BodySearchMemoryIndex["search"]>>;
    try {
      result = await this.memory.search({ documents, request: { ...request, offset, limit },
        activePath: this.app.workspace?.getActiveFile()?.path, recentPaths: this.app.workspace?.getLastOpenFiles?.() ?? [] });
    } catch (error) {
      if ((error as { code?: string })?.code !== "search_index_stale") throw error;
      // A real change rejects the snapshot; it is a cursor error only for pagination.
      this.assertCurrent(scope, generation, Boolean(request.cursor));
      throw this.changedSearch(Boolean(request.cursor));
    }
    // Scope changes during a scan cannot leak material from an earlier setting.
    this.assertCurrent(scope, generation, Boolean(request.cursor));
    const hits = result.hits.map(hit => ({ ...hit, entryId: `body:${hit.vaultRelativePath}:${hit.lineStart}`,
      verificationStatus: "local_revision_verified" as const, rawSources: [] }));
    while (hits.length > 1 && new TextEncoder().encode(JSON.stringify(hits)).length > 10_000) hits.pop();
    const remaining = Math.max(0, result.total - offset - hits.length);
    return { generation, total: result.total, returned: hits.length, remaining, hasMore: remaining > 0,
      exhausted: remaining === 0 && result.coverage.complete, coverage: result.coverage, hits,
      ...(remaining ? { continuationCursor: JSON.stringify({ key: queryKey, generation, offset: offset + hits.length }) } : {}) };
  }
  private changedSearch(cursor: boolean, scopeChanged = false): Error {
    return Object.assign(new Error(cursor ? "Search cursor is stale" : scopeChanged ? "Search scope changed" : "Search source changed"), { code: cursor ? "cursor_stale" : "source_changed" });
  }
  private assertCurrent(scope: string, generation: number, cursor: boolean): void {
    this.assertOpen();
    if (scope !== this.scopeKey() || generation !== this.generation) {
      // A setting change can arrive without a Vault event while a scan yields.
      if (scope !== this.scopeKey()) this.ensureScope();
      throw this.changedSearch(cursor, scope !== this.scopeKey());
    }
  }
}
