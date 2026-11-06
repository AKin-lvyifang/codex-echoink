import { scanKnowledgeStructure, isSourceHeading, isRelatedHeading, sectionAt } from "./knowledge-structure-scan";
import type { App, ReferenceCache, TFile } from "obsidian";
import { classifyKnowledgePath, type KnowledgeFolderBindings } from "./folder-bindings";
import {
  isGeneralKnowledgeWiki,
  isKnowledgeMap,
  knowledgeWikiPropertiesFromMetadata,
} from "./knowledge-wiki-policy";
import { MAINTENANCE_KNOWLEDGE_TYPES } from "./maintenance-page-metadata";
import { readMaintenanceDomainBlocks } from "./maintenance-domain-map";
import { treeMapSuggestedBranch } from "./maintenance-tree-map";
import { extractMachineSourceMarkers } from "./knowledge-maintenance-protocol";
import { createMaintenanceSectionSnapshot } from "./maintenance-section-patch";
import { getDesktopCrypto } from "../platform/desktop-crypto";
import { canonicalRawMarkdownForDigest, isRawMarkdownPath } from "./raw-digest-core";

export const CHECKUP_LABELS = {
  broken: "死链",
  isolated: "孤立页",
  oneWay: "单向相关条目",
  thin: "内容太薄",
  missingType: "缺类型",
  pendingType: "类型待确认",
  source: "来源丢失或已改",
  unplaced: "待归位",
  outdated: "可能过时",
} as const;
export type KnowledgeCheckupKind = keyof typeof CHECKUP_LABELS;
export interface KnowledgeCheckupIssue {
  id: string;
  kind: KnowledgeCheckupKind;
  path: string;
  title: string;
  message: string;
  ignoreKey: string;
  target?: string;
  original?: string;
  candidates?: string[];
  sources?: string[];
  mapPath?: string;
  domain?: string;
  suggestedBranch?: string;
}
export interface KnowledgeCheckupSnapshot {
  issues: KnowledgeCheckupIssue[];
  candidates: string[];
  linkTargets: string[];
  loading: boolean;
  bodyReads: number;
  elapsedMs: number;
}
export function checkupTitle(path: string): string {
  return path
    .split("/")
    .at(-1)!
    .replace(/\.(?:md|markdown)$/iu, "");
}

/** Ephemeral diagnosis. Link findings are rebuilt from native metadata, never written to notes or settings. */
export async function scanKnowledgeCheckup(
  app: App,
  bindings: KnowledgeFolderBindings,
): Promise<KnowledgeCheckupSnapshot> {
  const start = performance.now(),
    issues: KnowledgeCheckupIssue[] = [],
    maps = new Map<
      string,
      {
        path: string;
        tree: boolean;
        pending: Set<string>;
        present: Set<string>;
        suggestions: Map<string, string>;
      }
    >();
  const wiki = app.vault
    .getMarkdownFiles()
    .filter(
      (f) =>
        classifyKnowledgePath(bindings, f.path) === "wiki" &&
        !f.path.split("/").some((s) => s.startsWith(".")),
    );
  const caches = new Map(wiki.map((f) => [f.path, app.metadataCache.getFileCache(f)]));
  const contents = new Map<string, string>();
  let bodyReads = 0;
  const read = async (file: TFile) => {
    if (!contents.has(file.path)) {
      bodyReads++;
      contents.set(file.path, await app.vault.read(file));
    }
    return contents.get(file.path)!;
  };
  const sourceRevisions = new Map<string, Promise<Set<string>>>();
  const sourceRevision = (file: TFile): Promise<Set<string>> => {
    if (!sourceRevisions.has(file.path))
      sourceRevisions.set(
        file.path,
        (async () => {
          bodyReads++;
          const bytes = new Uint8Array(await app.vault.readBinary(file));
          const hash = (value: Uint8Array | string) =>
            "sha256:" + getDesktopCrypto().createHash("sha256").update(value).digest("hex");
          // Maintain records the same canonical Raw body as its source index;
          // upgraded older notes can still carry a full-file revision.
          return new Set([
            hash(bytes),
            ...(isRawMarkdownPath(file.path)
              ? [hash(canonicalRawMarkdownForDigest(new TextDecoder().decode(bytes)))]
              : []),
          ]);
        })(),
      );
    return sourceRevisions.get(file.path)!;
  };
  const mapPaths = new Set<string>();
  for (const file of wiki) {
    const cache = caches.get(file.path);
    if (!cache) continue;
    const plausibleMap =
      isKnowledgeMap(file.path) ||
      ((cache.sections ?? []).some((s) => s.type === "html") &&
        (cache.headings ?? []).some((h) => h.level === 2));
    if (!plausibleMap) continue;
    const content = await read(file);
    if (!isKnowledgeMap(file.path, content)) continue;
    mapPaths.add(file.path);
    for (const block of readMaintenanceDomainBlocks(content)) {
      const pending = new Set<string>(),
        present = new Set<string>(),
        suggestions = new Map<string, string>();
      let section = "";
      for (const line of content.slice(block.start, block.end).split(/\r?\n/u)) {
        if (/^###\s/u.test(line)) section = line.replace(/^###\s+/u, "").trim();
        const raw = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/u.exec(line)?.[1];
        const target = raw && app.metadataCache.getFirstLinkpathDest(raw, file.path)?.path;
        if (!target) continue;
        present.add(target);
        if (section === "待归位") {
          pending.add(target);
          const suggestion = treeMapSuggestedBranch(line);
          if (suggestion) suggestions.set(target, suggestion);
        }
      }
      maps.set(block.domain, {
        path: file.path,
        tree: block.mode === "tree",
        pending,
        present,
        suggestions,
      });
    }
  }
  const files = wiki.filter(
    (f) =>
      !mapPaths.has(f.path) &&
      isGeneralKnowledgeWiki(knowledgeWikiPropertiesFromMetadata(caches.get(f.path)?.frontmatter)),
  );
  const candidates = new Set(files.map((f) => f.path)),
    structure = scanKnowledgeStructure(app, bindings);
  const byName = new Map<string, string[]>();
  const allTargets = app.vault.getFiles();
  for (const file of allTargets) {
    const aliases: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
    for (const name of [
      checkupTitle(file.path),
      ...(Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string") : []),
    ]) {
      const key = name.toLowerCase(),
        values = byName.get(key) ?? [];
      values.push(file.path);
      byName.set(key, values);
    }
  }
  const add = (
    file: TFile,
    kind: KnowledgeCheckupKind,
    message: string,
    detail: Partial<KnowledgeCheckupIssue> = {},
  ) => {
    const key = detail.ignoreKey ?? CHECKUP_LABELS[kind];
    const ignored: unknown = caches.get(file.path)?.frontmatter?.["体检忽略"];
    if (Array.isArray(ignored) && (ignored.includes(key) || kind === "unplaced" && ignored.includes("未归位"))) return;
    issues.push({
      id: `${kind}\0${file.path}\0${detail.target ?? detail.original ?? ""}`,
      kind,
      path: file.path,
      title: checkupTitle(file.path),
      message,
      ignoreKey: key,
      ...detail,
    });
  };
  for (const file of files) {
    const cache = caches.get(file.path);
    if (!cache) continue;
    const links = [...(cache.links ?? []), ...(cache.embeds ?? [])];
    const references: Array<{
      original: string;
      link: string;
      position?: ReferenceCache["position"];
    }> = [...links, ...(cache.frontmatterLinks ?? [])];
    const type: unknown = cache.frontmatter?.类型;
    if (type === undefined) add(file, "missingType", "还没有类型");
    else if (typeof type !== "string" || !MAINTENANCE_KNOWLEDGE_TYPES.includes(type as never))
      add(file, "pendingType", "已有类型需要核对，保留原值");
    else if (cache.frontmatter?.类型待确认 === true) add(file, "pendingType", "类型尚待确认");
    const bodySize = (cache.sections ?? [])
      .filter(
        (s) =>
          s.type !== "yaml" &&
          s.type !== "heading" &&
          !isSourceHeading(sectionAt(cache, s.position.start.offset)) &&
          !isRelatedHeading(sectionAt(cache, s.position.start.offset)),
      )
      .reduce((sum, s) => sum + s.position.end.offset - s.position.start.offset, 0);
    if (bodySize < 220) {
      const content = await read(file);
      const body = createMaintenanceSectionSnapshot(content)
        .regions.filter((r) => r.kind === "section" || r.kind === "introduction")
        .map((r) => content.slice(r.contentStart, r.end))
        .join("\n")
        .replace(/<!--[^]*?-->/gu, "")
        .trim();
      if (body.length < 160)
        add(file, "thin", "正文不足 160 字符", {
          sources: references
            .filter((r) => r.position && isSourceHeading(sectionAt(cache, r.position.start.offset)))
            .map(
              (r) => app.metadataCache.getFirstLinkpathDest(r.link.split("#")[0], file.path)?.path,
            )
            .filter(
              (p): p is string =>
                !!p && ["raw", "inbox"].includes(classifyKnowledgePath(bindings, p) ?? ""),
            ),
        });
    }
    const domain = typeof cache.frontmatter?.领域 === "string" ? cache.frontmatter.领域 : "";
    const map = maps.get(domain);
    if (map?.tree && (map.pending.has(file.path) || !map.present.has(file.path)))
      add(file, "unplaced", "还没有放进知识树分支", {
        mapPath: map.path,
        domain,
        suggestedBranch: map.suggestions.get(file.path),
      });
    if ((cache.headings ?? []).some((h) => isSourceHeading(h.heading))) {
      const markers = extractMachineSourceMarkers(await read(file));
      const missing: string[] = [],
        changed: string[] = [];
      for (const [source, revision] of markers) {
        const original = app.vault.getFileByPath(source);
        if (!original) missing.push(source);
        else if (!(await sourceRevision(original)).has(revision)) changed.push(source);
      }
      if (missing.length || changed.length)
        add(file, "source", missing.length ? "来源文件已丢失" : "来源版本已改变", {
          sources: [...missing, ...changed],
          ignoreKey: "来源丢失或已改",
        });
    }
  }
  for (const finding of structure.findings) {
    const file = app.vault.getFileByPath(finding.path);
    if (!file) continue;
    const message = finding.kind === "broken" ? `「${finding.target}」打不开`
      : finding.kind === "oneWay" ? `「${checkupTitle(finding.target!)}」还没有反向关系`
      : "没有与其他通用 Wiki 连接";
    add(file, finding.kind, message, {
      ...finding,
      ...(finding.kind === "broken" ? {
        candidates: [...new Set(byName.get(checkupTitle(finding.target!).toLowerCase()) ?? [])],
      } : {}),
    });
  }
  return {
    issues,
    candidates: [...candidates],
    linkTargets: allTargets.map((file) => file.path),
    loading: !app.workspace.layoutReady || files.some((f) => !caches.get(f.path)),
    bodyReads,
    elapsedMs: performance.now() - start,
  };
}
