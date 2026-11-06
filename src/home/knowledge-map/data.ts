import type { App, CachedMetadata } from "obsidian";
import {
  classifyKnowledgePath,
  type KnowledgeFolderBindings,
} from "../../knowledge-base/folder-bindings";
import { knowledgeAnalysisCorpus } from "../../knowledge-base/knowledge-system-analysis";
import { maintenanceVisibleClassification } from "../../knowledge-base/maintenance-p2-planning";
import { treeMapSuggestedBranch } from "../../knowledge-base/maintenance-tree-map";
import {
  findMaintenanceDomainMap,
  readMaintenanceDomainBlocks,
} from "../../knowledge-base/maintenance-domain-map";
import {
  collectKnowledgeSystemReminders,
  type KnowledgeSystemReminder,
} from "../../knowledge-base/knowledge-system-reminders";

export interface KnowledgeMapEntry {
  title: string;
  path: string | null;
  children: KnowledgeMapEntry[];
  suggestedBranch?: string;
}
export interface KnowledgeMapGroup {
  title: string;
  entries: KnowledgeMapEntry[];
}
export interface KnowledgeMapDomain {
  domain: string;
  count: number;
  mode: "list" | "tree";
  mapPath: string | null;
  title: string;
  groups: KnowledgeMapGroup[];
  gaps: string[];
  indexing: boolean;
}
export interface KnowledgeMapData {
  domains: KnowledgeMapDomain[];
  reminders: KnowledgeSystemReminder[];
}
type Document = { path: string; content: string };
type ResolveLink = (link: string, source: string) => { path: string; basename: string } | null;

/** Obsidian owns Markdown structure and link resolution; block markers only bound the selected domain. */
export function readKnowledgeMapGroups(
  document: Document,
  cache: CachedMetadata,
  start: number,
  end: number,
  resolve: ResolveLink,
): Pick<KnowledgeMapDomain, "groups" | "gaps" | "title"> {
  const headings = (cache.headings ?? []).filter(
    (heading) => heading.position.start.offset >= start && heading.position.start.offset < end,
  );
  const groups: KnowledgeMapGroup[] = [];
  const gaps: string[] = [];
  const items = new Map<number, KnowledgeMapEntry>();
  let group: KnowledgeMapGroup | undefined;
  let section = "";
  let headingIndex = 0;
  for (const item of cache.listItems ?? []) {
    const offset = item.position.start.offset;
    if (offset < start || offset >= end) continue;
    while (headings[headingIndex]?.position.start.offset < offset) {
      const heading = headings[headingIndex++];
      if (heading.level >= 3) {
        section = heading.heading;
        group = undefined;
      }
    }
    if (section === "来源") continue;
    if (section === "缺口") {
      gaps.push(
        document.content
          .slice(offset, item.position.end.offset)
          .replace(/^\s*[-+*]\s+/u, "")
          .trim(),
      );
      continue;
    }
    const link = (cache.links ?? []).find(
      (link) =>
        link.position.start.offset >= offset &&
        link.position.start.offset <= item.position.end.offset,
    );
    if (!link) continue;
    let linkpath = link.link;
    try {
      linkpath = decodeURIComponent(linkpath);
    } catch {
      /* Obsidian may retain a literal percent in a filename. */
    }
    const file = resolve(linkpath, document.path);
    const label = link.displayText;
    const pathLabel =
      !label ||
      label === link.link ||
      label === file?.path ||
      label === file?.path.replace(/\.md$/iu, "");
    const entry: KnowledgeMapEntry = {
      title: pathLabel ? file?.basename || linkpath : label,
      path: file?.path ?? null,
      children: [],
    };
    if (section === "待归位") {
      const suggestion = treeMapSuggestedBranch(
        document.content.slice(offset, item.position.end.offset),
      );
      if (
        headings.filter((heading) => heading.level === 3 && heading.heading === suggestion)
          .length === 1
      ) {
        entry.suggestedBranch = suggestion;
      }
    }
    const parent = items.get(item.parent);
    if (parent) parent.children.push(entry);
    else {
      if (!group) {
        group = { title: section || "条目", entries: [] };
        groups.push(group);
      }
      group.entries.push(entry);
    }
    items.set(item.position.start.line, entry);
  }
  return { groups, gaps, title: headings.find((heading) => heading.level === 2)?.heading ?? "" };
}

export function buildKnowledgeMapData(
  documents: readonly Document[],
  wikiRoot: string,
  cache: (path: string) => CachedMetadata | null,
  resolve: ResolveLink,
): KnowledgeMapData {
  const corpus = knowledgeAnalysisCorpus(documents.map((doc) => ({ ...doc, revision: "" })));
  const existing = documents.map((doc) => ({
    ...doc,
    title: doc.path,
    aliases: [],
    contentRevision: "",
  }));
  const domains = corpus.catalog.domains.map((item): KnowledgeMapDomain => {
    const notes = corpus.documents.filter((doc) => doc.domain === item.domain);
    const entries = notes.map((doc) => ({
      path: doc.path,
      title: doc.path
        .split("/")
        .at(-1)!
        .replace(/\.(?:md|markdown)$/iu, ""),
      domain: item.domain,
      type: maintenanceVisibleClassification(doc.content).type ?? "概念",
    }));
    const mapPath = findMaintenanceDomainMap(item.domain, entries, existing, wikiRoot);
    const candidate = documents.find((doc) => doc.path === mapPath);
    const blocks = candidate ? readMaintenanceDomainBlocks(candidate.content) : [];
    const block = blocks.find((block) => block.domain === item.domain);
    // A shared index's other domains are not a legacy map for this domain.
    const document = blocks.length && !block ? undefined : candidate;
    const mode = block?.mode ?? "list";
    const metadata = document ? cache(mapPath) : null;
    const view =
      document && metadata
        ? readKnowledgeMapGroups(
            document,
            metadata,
            block?.start ?? 0,
            block?.end ?? document.content.length,
            resolve,
          )
        : { groups: [], gaps: [], title: "" };
    // Old indexes stay read-only. Without a map, display the already classified notes as a list.
    if (!document) {
      for (const entry of entries) {
        let group = view.groups.find((group) => group.title === entry.type);
        if (!group) view.groups.push((group = { title: entry.type, entries: [] }));
        group.entries.push({ title: entry.title, path: entry.path, children: [] });
      }
    }
    return {
      domain: item.domain,
      count: item.count,
      mode,
      mapPath: document ? mapPath : null,
      ...view,
      title: block ? view.title : item.domain,
      indexing: !!document && !metadata,
    };
  });
  return { domains, reminders: collectKnowledgeSystemReminders(documents, wikiRoot) };
}

/** One Wiki read supplies both the map and the existing 2B reminders. */
export async function loadKnowledgeMapData(
  app: Pick<App, "vault"> & Partial<Pick<App, "metadataCache">>,
  bindings: KnowledgeFolderBindings,
): Promise<KnowledgeMapData> {
  const documents: Document[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if (classifyKnowledgePath(bindings, file.path) !== "wiki") continue;
    documents.push({
      path: file.path,
      content: await (app.vault.cachedRead?.(file) ?? app.vault.read(file)),
    });
  }
  return buildKnowledgeMapData(
    documents,
    bindings.roles.wiki.writePath ?? "",
    (path) => app.metadataCache?.getCache(path) ?? null,
    (link, source) => app.metadataCache?.getFirstLinkpathDest(link, source) ?? null,
  );
}
