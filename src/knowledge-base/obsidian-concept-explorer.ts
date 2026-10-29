import { sha256Hex } from "../utils/sha256";
import { extractKnowledgeLinks, resolveKnowledgeLink, type KnowledgeRelation, type KnowledgeRelationPage } from "./knowledge-relations";
import type { App } from "obsidian";
import type { KnowledgeAgentIndex } from "./knowledge-agent-index";
import type { KnowledgeBodySearchPort } from "./vault-body-search";
import type { ConceptExplorerPort } from "./concept-explorer";

export function createConceptExplorerPort(app: App, index: KnowledgeAgentIndex, body: KnowledgeBodySearchPort): ConceptExplorerPort {
  return {
    candidates: async name => {
      const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();
      const target = normalize(name);
      return app.vault.getMarkdownFiles().filter(file => {
        if (!body.allowsPath(file.path)) return false;
        const cache = app.metadataCache.getFileCache(file);
        const aliases: unknown = cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias;
        const names = [file.basename, ...(typeof aliases === "string" ? [aliases] : Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : [])];
        return names.some(alias => normalize(alias) === target);
      }).map(file => file.path);
    },
    read: async input => {
      const snapshot = await body.read(input);
      if (!["wiki", "projects", "raw"].includes(snapshot.kind)) return snapshot;
      try {
        const indexed = await index.read({ ...input, expectedContentRevision: snapshot.contentRevision });
        await body.read({ ...input, expectedContentRevision: snapshot.contentRevision });
        return { ...indexed, ...snapshot, rawSources: indexed.rawSources.filter(source => body.allowsPath(source.vaultRelativePath)) };
      } catch (error) {
        if ((error as { code?: string }).code === "not_found") return snapshot;
        throw error;
      }
    },
    related: async input => {
      const source = await body.read({ vaultRelativePath: input.vaultRelativePath });
      return ["wiki", "projects", "raw"].includes(source.kind) ? await index.related(input) : await noteRelationPage(app, body, input);
    }
  };
}


/** Ordinary notes use the host's backlink candidates and the same link resolver/parser.
 * Bodies and their revisions are verified before any context is delivered. */
async function noteRelationPage(app: App, body: KnowledgeBodySearchPort, input: { vaultRelativePath: string; limit?: number; cursor?: string }): Promise<KnowledgeRelationPage> {
  const scope = body.scopeKey();
  const source = await body.read({ vaultRelativePath: input.vaultRelativePath });
  const files = app.vault.getMarkdownFiles().filter(file => body.allowsPath(file.path));
  const paths = files.map(file => file.path);
  const names = Object.fromEntries(files.map(file => {
    const aliases: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.aliases ?? app.metadataCache.getFileCache(file)?.frontmatter?.alias;
    return [file.path, [file.basename, ...(typeof aliases === "string" ? [aliases] : Array.isArray(aliases) ? aliases.filter((value): value is string => typeof value === "string") : [])]];
  }));
  const backlinkPaths = files.filter(file => file.path !== source.vaultRelativePath && app.metadataCache.resolvedLinks[file.path]?.[source.vaultRelativePath]);
  const snapshots = [source, ...await Promise.all(backlinkPaths.map(file => body.read({ vaultRelativePath: file.path })))];
  const target = async (vaultRelativePath: string) => {
    const note = snapshots.find(snapshot => snapshot.vaultRelativePath === vaultRelativePath) ?? await body.read({ vaultRelativePath });
    return { vaultRelativePath, title: note.title, contentRevision: note.contentRevision };
  };
  const items: KnowledgeRelation[] = [];
  for (const snapshot of snapshots) {
    for (const link of extractKnowledgeLinks(snapshot.content)) {
      const resolved = resolveKnowledgeLink({ link, sourcePath: snapshot.vaultRelativePath, paths, names, resolveAlias: value => value,
        hostResolver: (name, from) => app.metadataCache.getFirstLinkpathDest(name, from)?.path });
      const outgoing = snapshot.vaultRelativePath === source.vaultRelativePath;
      if (!outgoing && !(resolved.length === 1 && resolved[0] === source.vaultRelativePath)) continue;
      items.push({ direction: outgoing ? "outgoing" : "incoming", relation: "link", original: link.original,
        source: { ...await target(snapshot.vaultRelativePath), line: link.line, context: link.context },
        status: resolved.length === 1 ? "available" : resolved.length ? "ambiguous" : "unresolved",
        ...(link.anchor ? { anchor: link.anchor } : {}),
        ...(resolved.length === 1 ? { target: await target(resolved[0]) } : resolved.length > 1 ? { candidates: await Promise.all(resolved.map(target)) } : {}) });
    }
  }
  const key = sha256Hex(JSON.stringify([scope, source.contentRevision, items]));
  let offset = 0;
  if (input.cursor) {
    let cursor: { key: string; offset: number };
    try { cursor = JSON.parse(input.cursor) as typeof cursor; } catch { throw Object.assign(new Error("Invalid relation cursor"), { code: "cursor_invalid" }); }
    if (cursor?.key !== key) throw Object.assign(new Error("Relation cursor is stale"), { code: "cursor_stale" });
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length) throw Object.assign(new Error("Invalid relation offset"), { code: "cursor_invalid" });
    offset = cursor.offset;
  }
  const selected = items.slice(offset, offset + Math.max(1, Math.min(12, input.limit ?? 6))), next = offset + selected.length;
  await body.read({ vaultRelativePath: source.vaultRelativePath, expectedContentRevision: source.contentRevision });
  if (scope !== body.scopeKey()) throw Object.assign(new Error("Knowledge scope changed"), { code: "source_changed" });
  return { vaultRelativePath: source.vaultRelativePath, contentRevision: source.contentRevision, total: items.length, returned: selected.length,
    remaining: items.length - next, hasMore: next < items.length, exhausted: next >= items.length, items: selected,
    ...(next < items.length ? { continuationCursor: JSON.stringify({ key, offset: next }) } : {}) };
}
