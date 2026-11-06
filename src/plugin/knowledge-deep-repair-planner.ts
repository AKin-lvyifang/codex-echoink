import { appendKnowledgePairDecision } from "../knowledge-base/knowledge-pair-decisions";
import type CodexForObsidianPlugin from "../main";
import type { CheckupSelection } from "./knowledge-checkup-service";
import type { DeepCheckupFinding } from "../knowledge-base/knowledge-deep-checkup";
import type {
  KnowledgeCheckupActionRow,
  KnowledgeRepairExtras,
} from "../knowledge-base/maintenance-upgrade-contract";
import {
  readMaintenanceFrontmatterProperty,
  patchKnowledgeProperties,
} from "../knowledge-base/maintenance-source-frontmatter";
import {
  mergePropertySummary,
  preferredMergeHome,
  mergeSections,
  mergeContentPrompt,
  applyMergePlacements,
  mergeUserProperties,
} from "../knowledge-base/knowledge-merge-content";
import {
  conflictParagraph,
  conflictPrompt,
  applyConflictParagraph,
} from "../knowledge-base/knowledge-conflict-repair";
import {
  domainValue,
  updateKnowledgeDomain,
  mergeKnowledgeDomainMaps,
  rehomeKnowledgeDomainBlock,
} from "../knowledge-base/knowledge-domain-repair";
import { captureKnowledgeMoveLinks } from "../knowledge-base/knowledge-move-links";
import {
  knowledgeOrganizationBinding,
  knowledgeMayOrganizeMove,
} from "../knowledge-base/folder-organization";
import { classifyKnowledgePath } from "../knowledge-base/folder-bindings";
import { readMaintenanceDomainBlocks } from "../knowledge-base/maintenance-domain-map";
import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";
import { checkupTitle } from "../knowledge-base/knowledge-checkup";
import {
  isKnowledgeMap,
  isGeneralKnowledgeWiki,
  knowledgeWikiProperties,
} from "../knowledge-base/knowledge-wiki-policy";
import { sha256Hex } from "../utils/sha256";
import { normalizeMergedMapEntries } from "../knowledge-base/knowledge-merge-map";

export interface DeepRepairDraft {
  read: (path: string) => Promise<string>;
  update: (path: string, after: string, label: string) => Promise<void>;
  extras: KnowledgeRepairExtras;
}
export async function resolveMergeHome(
  plugin: CodexForObsidianPlugin,
  path: string,
  read: DeepRepairDraft["read"],
): Promise<string> {
  const seen = new Set<string>();
  while (true) {
    if (seen.has(path)) throw new Error("合并指向存在循环，本项不会写入。");
    seen.add(path);
    const content = await read(path);
    const merged = readMaintenanceFrontmatterProperty(content, "已合并到");
    if (!merged.present) {
      const bindings = plugin.settings.knowledgeBase.folderBindings;
      if (!bindings || classifyKnowledgePath(bindings, path) !== "wiki" ||
          !isGeneralKnowledgeWiki(knowledgeWikiProperties(content)) || isKnowledgeMap(path, content))
        throw new Error("合并目标不是有效的通用 Wiki，原文件保留。");
      return path;
    }
    const raw =
      typeof merged.value === "string" &&
      /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/u.exec(merged.value)?.[1];
    const target = raw && plugin.app.metadataCache.getFirstLinkpathDest(raw, path);
    if (merged.error || !target) throw new Error("已有合并指向无效，请先核对原笔记。");
    path = target.path;
  }
}

function json(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, ""),
  );
}

export class KnowledgeDeepRepairPlanner {
  constructor(
    private readonly plugin: CodexForObsidianPlugin,
    private readonly draft: DeepRepairDraft,
  ) {}
  private generate(prompt: string) {
    return this.plugin.generateLifestyleText(
      "你负责已获用户确认范围内的知识修复提案。只返回所需JSON，不执行文件操作。",
      prompt,
      5000,
    );
  }
  async prepare(
    finding: DeepCheckupFinding,
    selection: CheckupSelection,
    row: KnowledgeCheckupActionRow,
  ) {
    if (selection.action === "notDuplicate") {
      const [a, b] = finding.paths;
      row.action = "不合并";
      await this.draft.update(a, appendKnowledgePairDecision(await this.draft.read(a), "不是重复", b), "记为不是重复");
      await this.draft.update(b, appendKnowledgePairDecision(await this.draft.read(b), "不是重复", a), "记为不是重复");
    } else if (selection.action === "merge") await this.merge(finding, selection, row);
    else if (["coexist", "preferFirst", "preferSecond"].includes(selection.action))
      await this.contradiction(finding, selection, row);
    else if (selection.action === "mergeDomains" || selection.action === "separateDomains")
      await this.domains(finding, selection, row);
    else throw new Error("修法与深查发现不匹配。");
  }
  private async merge(
    finding: DeepCheckupFinding,
    selection: CheckupSelection,
    row: KnowledgeCheckupActionRow,
  ) {
    if (finding.kind !== "duplicate") throw new Error("只有重复页可以合并。");
    const app = this.plugin.app;
    const incoming = (path: string) =>
      Object.values(app.metadataCache.resolvedLinks).filter((links) => (links[path] ?? 0) > 0)
        .length;
    const defaultHome = preferredMergeHome(await Promise.all(finding.paths.map(async path => ({
      path, incoming: incoming(path), content: await this.draft.read(path),
    }))));
    const chosen = selection.target ?? defaultHome;
    if (!finding.paths.includes(chosen)) throw new Error("保留主页不在这对重复页中。");
    const primary = await resolveMergeHome(this.plugin, chosen, this.draft.read);
    const secondary = finding.paths.find((path) => path !== chosen)!;
    if (primary === secondary) throw new Error("两篇已指向同一主页，无需再次合并。");
    const bindings = this.plugin.settings.knowledgeBase.folderBindings!;
    const owner = knowledgeOrganizationBinding(bindings, secondary);
    const archive = `${owner?.root}/已合并/${secondary.split("/").at(-1)}`;
    if (owner?.role !== "wiki" || !knowledgeMayOrganizeMove(bindings, secondary, archive))
      throw new Error("请先允许知识成果目录管理，再合并归档。");
    if (app.vault.getAbstractFileByPath(archive))
      throw new Error("已合并文件夹有同名笔记，原文件保留。");
    const originalHome = await this.draft.read(primary),
      originalSource = await this.draft.read(secondary);
    const sections = mergeSections(originalSource);
    const placements = json(
      await this.generate(mergeContentPrompt(originalHome, originalSource, sections)),
    );
    const resolveReference = (link: string, source: string) =>
      app.metadataCache.getFirstLinkpathDest(link, source)?.path ?? null;
    const first = applyMergePlacements(
      originalHome,
      sections,
      placements,
      { primaryPath: primary, secondaryPath: secondary, resolve: resolveReference },
    );
    const redirects = [{ from: secondary, to: primary, revision: sha256Hex(originalSource) }];
    for (const file of app.vault.getMarkdownFiles()) {
      if (file.path === secondary || classifyKnowledgePath(bindings, file.path) !== "wiki")
        continue;
      if (!Object.hasOwn(app.metadataCache.getFileCache(file)?.frontmatter ?? {}, "已合并到"))
        continue;
      if ((await resolveMergeHome(this.plugin, file.path, this.draft.read)) === secondary)
        redirects.push({
          from: file.path,
          to: primary,
          revision: sha256Hex(await this.draft.read(file.path)),
        });
    }
    const redirectPaths = new Set(redirects.map((redirect) => redirect.from));
    const regions = createMaintenanceSectionSnapshot(originalSource).regions.filter((region) =>
      originalSource.slice(region.contentStart, region.end).trim(),
    );
    const anchors: string[] = [];
    const mapAnchor = (target: string, suffix: string): string => {
      if (!redirectPaths.has(target) || !suffix) return suffix;
      const raw = decodeURIComponent(suffix.slice(1));
      const cache = app.metadataCache.getFileCache(app.vault.getFileByPath(secondary)!);
      const heading = cache?.headings?.find((h) => h.heading === raw);
      const block = raw.startsWith("^") ? cache?.blocks?.[raw.slice(1)] : undefined;
      const offset = heading?.position.end.offset ?? block?.position.start.offset;
      const index =
        offset === undefined
          ? 0
          : Math.max(
              0,
              regions.findIndex((region) => offset >= region.start && offset <= region.end),
            );
      const destination =
        first.destinations.get(sections[index]?.id) ?? first.destinations.get(sections[0]?.id);
      const title = ["导语", "前言"].includes(destination ?? "")
        ? app.metadataCache
            .getFileCache(app.vault.getFileByPath(primary)!)
            ?.headings?.find((h) => h.level === 1)?.heading
        : destination;
      const body = first.content;
      const retained = raw.startsWith("^")
        ? (body.match(
            new RegExp(`\\^${raw.slice(1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=\\s|$)`, "gu"),
          )?.length ?? 0) === 1
        : createMaintenanceSectionSnapshot(body).regions.some(
            (region) =>
              body
                .slice(region.start, region.contentStart)
                .replace(/^#+\s+/u, "")
                .trim() === raw,
          );
      const after = retained ? suffix : title ? `#${title}` : "";
      const detail = `${checkupTitle(secondary)}${suffix} → ${checkupTitle(primary)}${after}`;
      if (!anchors.includes(detail)) anchors.push(detail);
      return after;
    };
    const links = await captureKnowledgeMoveLinks(app, redirects, mapAnchor, new Set([secondary]));
    const rebasedSource =
      links.find((link) => link.sourcePath === secondary)?.after ?? originalSource;
    const home = links.find((link) => link.sourcePath === primary)?.after ?? originalHome;
    const merged = applyMergePlacements(
      mergeUserProperties(home, rebasedSource, checkupTitle(secondary),
        { primaryPath: primary, secondaryPath: secondary, resolve: resolveReference }),
      mergeSections(rebasedSource),
      placements,
      { primaryPath: primary, secondaryPath: secondary,
        resolve: (link) => resolveReference(link, primary) },
      new Set(first.omittedIds),
    );
    row.action = `合并到「${checkupTitle(primary)}」`;
    row.merge = {
      primary, secondary, choices: finding.paths, sections: merged.summaries, anchors,
      omittedParagraphs: merged.omittedIds.length,
      additions: merged.additions, properties: mergePropertySummary(originalHome, merged.content),
    };
    row.choice = {
      label: "保留主页",
      value: chosen,
      options: finding.paths.map((value) => ({ value, label: checkupTitle(value) })),
    };
    await this.draft.update(primary, merged.content, row.action);
    for (const link of links) {
      if (link.sourcePath === secondary || link.sourcePath === primary) continue;
      await this.draft.update(
        link.sourcePath,
        normalizeMergedMapEntries(
          app,
          link.sourcePath,
          link.before,
          link.after,
          new Map(redirects.map((redirect) => [redirect.from, redirect.to])),
        ),
        "同步合并引用",
      );
    }
    const archivalLinks = await captureKnowledgeMoveLinks(app, [
      { from: secondary, to: archive, revision: sha256Hex(originalSource) },
    ]);
    const archived = patchKnowledgeProperties(
      archivalLinks.find((link) => link.sourcePath === secondary)?.after ?? originalSource,
      { 已合并到: `[[${primary.replace(/\.md$/u, "")}]]` },
    );
    await this.draft.update(secondary, archived, "标记已合并并归档");
    const moveId = `merge-archive:${sha256Hex(secondary).slice(0, 16)}`;
    (this.draft.extras.moves ??= []).push({
      id: moveId,
      from: secondary,
      to: archive,
      revision: sha256Hex(archived),
    });
    row.operationIds = [moveId];
  }
  private async contradiction(
    finding: DeepCheckupFinding,
    selection: CheckupSelection,
    row: KnowledgeCheckupActionRow,
  ) {
    if (finding.kind !== "contradiction") throw new Error("只有矛盾可用这项改写。");
    const choice = selection.action as "coexist" | "preferFirst" | "preferSecond";
    const contents = await Promise.all(finding.paths.map((path) => this.draft.read(path)));
    const paragraphs = finding.paths.map((path, index) =>
      conflictParagraph(
        path,
        contents[index],
        finding.evidence.find((e) => e.path === path)!.quote,
      ),
    );
    const targets =
      choice === "coexist" ? paragraphs : [paragraphs[choice === "preferFirst" ? 1 : 0]];
    const response = json(await this.generate(conflictPrompt(finding, paragraphs, choice)));
    if (!Array.isArray(response) || response.length !== targets.length)
      throw new Error("局部改写缺少目标段落，本项未写入。");
    row.action =
      choice === "coexist" ? "并列保留" : choice === "preferFirst" ? "以前者为准" : "以后者为准";
    const prepared = targets.map((paragraph) => {
      const edits = (response as unknown[]).filter(
        (edit): edit is { path: string; after: unknown } =>
          !!edit &&
          typeof edit === "object" &&
          "path" in edit &&
          edit.path === paragraph.path &&
          "after" in edit,
      );
      if (edits.length !== 1) throw new Error("局部改写目标不匹配，本项未写入。");
      const after: unknown = edits[0].after;
      if (
        choice === "coexist" &&
        (typeof after !== "string" ||
          !after.includes(paragraph.text.trim()) ||
          !after.includes(
            `[[${finding.paths.find((path) => path !== paragraph.path)!.replace(/\.md$/u, "")}`,
          ))
      )
        throw new Error("并列保留必须保留原段并链接另一种说法，本项未写入。");
      const index = finding.paths.indexOf(paragraph.path);
      return {
        path: paragraph.path,
        content: applyConflictParagraph(contents[index], paragraph, after),
        before: paragraph.text,
        after: after as string,
      };
    });
    row.changes = prepared.map(({ path, before, after }) => ({ path, before, after }));
    for (const edit of prepared) {
      const content = choice === "coexist"
        ? appendKnowledgePairDecision(edit.content, "并列保留", finding.paths.find(path => path !== edit.path)!)
        : edit.content;
      await this.draft.update(edit.path, content, row.action);
    }
  }
  private async domains(
    finding: DeepCheckupFinding,
    selection: CheckupSelection,
    row: KnowledgeCheckupActionRow,
  ) {
    if (finding.kind !== "nearDomain") throw new Error("只有近义领域可用这项修法。");
    const pair = await Promise.all(
      finding.paths.map(async (path) => domainValue(await this.draft.read(path))),
    );
    if (pair.some((name) => !name) || pair[0] === pair[1])
      throw new Error("领域已变化，请重新深查。");
    const domains = pair as [string, string];
    if (selection.action === "separateDomains") {
      const id = `separate-domains:${sha256Hex([...domains].sort().join("\0")).slice(0, 16)}`;
      (this.draft.extras.decisions ??= []).push({ id, domains });
      row.action = "保持分开";
      row.operationIds = [id];
      return;
    }
    const bindings = this.plugin.settings.knowledgeBase.folderBindings!;
    const files: { path: string; content: string }[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (classifyKnowledgePath(bindings, file.path) !== "wiki") continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const value: unknown = cache?.frontmatter?.领域;
      const selected = typeof value === "string" ? domains.includes(value)
        : Array.isArray(value) && value.some(name => typeof name === "string" && domains.includes(name));
      const map = isKnowledgeMap(file.path) || cache?.sections?.some(section => section.type === "html");
      if (cache && !selected && !map) continue;
      files.push({ path: file.path, content: await this.draft.read(file.path) });
    }
    const count = (domain: string) =>
      files.filter(
        (file) =>
          domainValue(file.content) === domain &&
          !isKnowledgeMap(file.path, file.content) &&
          isGeneralKnowledgeWiki(knowledgeWikiProperties(file.content)),
      ).length;
    const keep = selection.target ?? [...domains].sort((a, b) => count(b) - count(a))[0];
    if (!domains.includes(keep)) throw new Error("保留领域不属于这对近义领域。");
    const remove = domains.find((domain) => domain !== keep)!;
    row.choice = {
      label: "保留领域",
      value: keep,
      options: domains.map((value) => ({ value, label: value })),
    };
    row.action = `合并到「${keep}」`;
    row.skipped = files
      .filter((file) => {
        const field = readMaintenanceFrontmatterProperty(file.content, "领域");
        return (
          field.present &&
          typeof field.value !== "string" &&
          ((Array.isArray(field.value) && field.value.includes(remove)) ||
            file.path.includes(`/${remove}/`))
        );
      })
      .map((file) => ({ path: file.path, message: "领域属性类型不兼容，原值保留。" }));
    for (const file of files)
      if (
        !isKnowledgeMap(file.path, file.content) &&
        domainValue(file.content) === remove &&
        isGeneralKnowledgeWiki(knowledgeWikiProperties(file.content))
      )
        await this.draft.update(file.path, updateKnowledgeDomain(file.content, keep), row.action);
    const source = files.find((file) => isKnowledgeMap(file.path, file.content) &&
      readMaintenanceDomainBlocks(file.content).some((block) => block.domain === remove),
    );
    const target = files.find((file) => isKnowledgeMap(file.path, file.content) &&
      readMaintenanceDomainBlocks(file.content).some((block) => block.domain === keep),
    );
    if (source && target && source.path !== target.path) {
      const moved = rehomeKnowledgeDomainBlock(source.content, target.content, keep, remove)!;
      await this.draft.update(target.path, moved.target, "合并两边知识树");
      await this.draft.update(source.path, moved.source, "领域树已移至保留地图");
    } else if (source)
      await this.draft.update(
        source.path,
        mergeKnowledgeDomainMaps(source.content, keep, remove),
        "合并两边知识树",
      );
  }
}
