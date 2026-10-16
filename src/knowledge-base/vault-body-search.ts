import type { App, TFile } from "obsidian";
import { sha256Hex } from "../utils/sha256";
import { KNOWLEDGE_ROOT_ROLES, knowledgeRootRole } from "./root-paths-core";
import type { KnowledgeFolderBindings } from "./folder-bindings";
import { searchBodyDocuments } from "./search/body-search";
import type { BodySearchDocument, KnowledgeSearchKind } from "./search/contracts";
import type { KnowledgeAgentReadResult, KnowledgeAgentSearchRequest, KnowledgeAgentSearchResult } from "./knowledge-agent-index";

export interface KnowledgeBodySearchPort {
  allowsPath(path: string): boolean;
  scopeKey(): string;
  invalidate(path?: string): void;
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
  if (!role && bindings && parts.length === 1) {
    if (bindings.roles.journal.native && !bindings.roles.journal.readPaths.length && /^\d{4}-\d{2}-\d{2}\.(?:md|markdown)$/u.test(relativePath)) role = "journal";
    else if (bindings.roles.templates.native && !bindings.roles.templates.readPaths.length) role = "templates";
  }
  if (role === "templates" || role === "assets") return null;
  if (role && bindings && (!bindings.roles[role].enabled || bindings.roles[role].searchEnabled === false)) return null;
  return role ?? "notes";
}

/** Public Vault API adapter; no filesystem, CLI, persistence or full-body cache. */
export class VaultBodySearch implements KnowledgeBodySearchPort {
  private generation = 1;
  constructor(private readonly app: App, private readonly bindings: () => KnowledgeFolderBindings | null | undefined,
    private readonly options: Readonly<{ excludedRoots?: () => readonly string[]; onJournalSearch?: () => void | Promise<void> }> = {}) {}
  invalidate(): void { this.generation += 1; }
  allowsPath(path: string): boolean { return knowledgeSearchPathKind(path, this.bindings(), this.options.excludedRoots?.()) !== null; }
  scopeKey(): string { return JSON.stringify([this.bindings(), this.options.excludedRoots?.() ?? []]); }
  private allowed(filePath: string): KnowledgeSearchKind {
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
    const file = this.file(input.vaultRelativePath);
    const content = await this.app.vault.read(file);
    const kind = this.allowed(file.path);
    const contentRevision = `sha256:${sha256Hex(content)}`;
    if (input.expectedContentRevision && input.expectedContentRevision !== contentRevision) throw Object.assign(new Error("Source changed"), { code: "source_changed" });
    return { entryId: `body:${file.path}`, vaultRelativePath: file.path, kind, title: file.basename,
      contentRevision, content, recordedAt: Math.trunc(file.stat.mtime), verificationStatus: "local_revision_verified", rawSources: [] };
  }
  async search(request: Readonly<KnowledgeAgentSearchRequest>): Promise<KnowledgeAgentSearchResult> {
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
      return [{ vaultRelativePath: file.path, title: file.basename, kind, recordedAt: Math.trunc(file.stat.mtime),
        aliases: array(cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias),
        tags: [...array(cache?.frontmatter?.tags), ...(cache?.tags?.map(tag => tag.tag) ?? [])],
        headings: cache?.headings?.map(h => ({ heading: h.heading, level: h.level, line: h.position.start.line + 1 })),
        read: () => this.read({ vaultRelativePath: file.path }) }];
    });
    if (documents.some(document => document.kind === "journal")) await this.options.onJournalSearch?.();
    const queryKey = sha256Hex(JSON.stringify({ mode: request.mode, query: request.query, queries: request.queries, kinds: request.kinds,
      dateFrom: request.dateFrom, dateTo: request.dateTo, excludePaths: request.excludePaths, bindingSignature,
      excludedRoots, files: documents.map(d => [d.vaultRelativePath, d.recordedAt]) }));
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
      if (bindingSignature !== JSON.stringify(this.bindings()) || generation !== this.generation || JSON.stringify(excludedRoots) !== JSON.stringify(this.options.excludedRoots?.() ?? [])) throw Object.assign(new Error("Search scope changed"), { code: "cursor_stale" });
      const remaining = Math.max(0, eligible.length - offset - page.length);
      return { generation, total: eligible.length, returned: hits.length, remaining, hasMore: remaining > 0, exhausted: remaining === 0 && failedFiles === 0,
        coverage: { totalFiles: eligible.length, scannedFiles: page.length - failedFiles, failedFiles, complete: remaining === 0 && failedFiles === 0, unknownJournalDates: 0 },
        hits: hits.map(({ content: _content, ...hit }) => hit),
        ...(remaining ? { continuationCursor: JSON.stringify({ key: queryKey, generation, offset: offset + page.length }) } : {}) };
    }
    const result = await searchBodyDocuments({ documents, request: { ...request, offset, limit },
      activePath: this.app.workspace?.getActiveFile()?.path, recentPaths: this.app.workspace?.getLastOpenFiles?.() ?? [] });
    // Scope changes during a scan cannot leak material from an earlier setting.
    if (bindingSignature !== JSON.stringify(this.bindings()) || JSON.stringify(excludedRoots) !== JSON.stringify(this.options.excludedRoots?.() ?? []) || generation !== this.generation) throw Object.assign(new Error("Search scope changed"), { code: "cursor_stale" });
    const hits = result.hits.map(hit => ({ ...hit, entryId: `body:${hit.vaultRelativePath}:${hit.lineStart}`,
      verificationStatus: "local_revision_verified" as const, rawSources: [] }));
    while (hits.length > 1 && new TextEncoder().encode(JSON.stringify(hits)).length > 10_000) hits.pop();
    const remaining = Math.max(0, result.total - offset - hits.length);
    return { generation, total: result.total, returned: hits.length, remaining, hasMore: remaining > 0,
      exhausted: remaining === 0 && result.coverage.complete, coverage: result.coverage, hits,
      ...(remaining ? { continuationCursor: JSON.stringify({ key: queryKey, generation, offset: offset + hits.length }) } : {}) };
  }
}
