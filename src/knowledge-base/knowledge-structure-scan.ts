import type { App, CachedMetadata, TFile } from "obsidian";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "./folder-bindings";
import {
  isGeneralKnowledgeWiki,
  isKnowledgeMap,
  knowledgeWikiPropertiesFromMetadata,
} from "./knowledge-wiki-policy";

export const isSourceHeading = (title: string): boolean =>
  /^(?:来源|资料来源|参考资料|sources?|references?)$/iu.test(title.trim());
export const isRelatedHeading = (title: string): boolean =>
  /^(?:相关条目|相关页面|相关笔记|related(?: entries| pages| notes)?)$/iu.test(title.trim());
export function sectionAt(cache: CachedMetadata, offset: number): string {
  const heading = (cache.headings ?? [])
    .filter((h) => h.level <= 2 && h.position.start.offset <= offset)
    .at(-1);
  return heading?.level === 2 ? heading.heading : "";
}

/** Native section positions identify generated map blocks without reading their bodies. */
export function isKnowledgeMapMetadata(path: string, cache: CachedMetadata | null): boolean {
  return (
    isKnowledgeMap(path) ||
    (!!cache &&
      (cache.sections ?? []).some((section) => section.type === "html") &&
      (cache.headings ?? []).some((heading) => heading.level === 2) &&
      !Object.hasOwn(cache.frontmatter ?? {}, "类型"))
  );
}

export function generalKnowledgeFiles(app: App, bindings: KnowledgeFolderBindings): TFile[] {
  return app.vault.getMarkdownFiles().filter((file) => {
    const cache = app.metadataCache.getFileCache(file);
    return (
      classifyKnowledgePath(bindings, file.path) === "wiki" &&
      !file.path.split("/").some((part) => part.startsWith(".")) &&
      !isKnowledgeMapMetadata(file.path, cache) &&
      isGeneralKnowledgeWiki(knowledgeWikiPropertiesFromMetadata(cache?.frontmatter))
    );
  });
}

export interface StructureFinding {
  kind: "broken" | "oneWay" | "isolated";
  path: string;
  ignoreKey: string;
  original?: string;
  target?: string;
}
export interface KnowledgeStructureScan {
  files: TFile[];
  findings: StructureFinding[];
  loading: boolean;
}

/** Shared by quick check, desktop and mobile scoring. No note body reads or stored findings. */
export function scanKnowledgeStructure(
  app: App,
  bindings: KnowledgeFolderBindings,
): KnowledgeStructureScan {
  const files = generalKnowledgeFiles(app, bindings);
  const paths = new Set(files.map((file) => file.path));
  const connected = new Set<string>();
  const related = new Map<string, Set<string>>();
  const findings: StructureFinding[] = [];
  const add = (file: TFile, finding: Omit<StructureFinding, "path">) => {
    const ignored: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.["体检忽略"];
    if (Array.isArray(ignored) && ignored.includes(finding.ignoreKey)) return;
    findings.push({ ...finding, path: file.path });
  };
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const relations = new Set<string>();
    related.set(file.path, relations);
    const broken = new Set<string>();
    const refs = [
      ...(cache.links ?? []),
      ...(cache.embeds ?? []),
      ...(cache.frontmatterLinks ?? []),
    ];
    for (const ref of refs) {
      const link = ref.link.split("#")[0];
      if (!link || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link)) continue;
      const target = app.metadataCache.getFirstLinkpathDest(link, file.path)?.path;
      if (!target) {
        if (broken.has(ref.original)) continue;
        broken.add(ref.original);
        add(file, {
          kind: "broken",
          original: ref.original,
          target: link,
          ignoreKey: `死链：${link}`,
        });
        continue;
      }
      const heading = "position" in ref ? sectionAt(cache, ref.position.start.offset) : "来源";
      if (!paths.has(target) || target === file.path || isSourceHeading(heading)) continue;
      connected.add(file.path);
      connected.add(target);
      if (isRelatedHeading(heading)) relations.add(target);
    }
  }
  for (const file of files) {
    if (!connected.has(file.path)) add(file, { kind: "isolated", ignoreKey: "孤立页" });
    for (const target of related.get(file.path) ?? []) {
      if (!related.get(target)?.has(file.path))
        add(file, { kind: "oneWay", target, ignoreKey: `单向相关条目：${target}` });
    }
  }
  return {
    files,
    findings,
    loading:
      !app.workspace.layoutReady || files.some((file) => !app.metadataCache.getFileCache(file)),
  };
}
