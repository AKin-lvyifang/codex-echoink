import assert from "node:assert/strict";
import { resolveMergeHome } from "../plugin/knowledge-deep-repair-planner";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { readMaintenanceFrontmatterProperty } from "../knowledge-base/maintenance-source-frontmatter";
import {
  mergeSections,
  preferredMergeHome,
  applyMergePlacements,
  mergeUserProperties,
} from "../knowledge-base/knowledge-merge-content";
import {
  conflictParagraph,
  applyConflictParagraph,
} from "../knowledge-base/knowledge-conflict-repair";
import {
  mergeKnowledgeDomainMaps,
  rehomeKnowledgeDomainBlock,
} from "../knowledge-base/knowledge-domain-repair";
import { readMaintenanceDomainBlocks } from "../knowledge-base/maintenance-domain-map";
import { normalizeMergedMapEntries } from "../knowledge-base/knowledge-merge-map";
import { applyMaintenanceRelatedEntries } from "../knowledge-base/maintenance-p2-planning";
import { knowledgeBodyLinkSpans } from "../knowledge-base/knowledge-relations";
import { deepFindingSuppressed } from "../knowledge-base/knowledge-deep-checkup";

export async function runKnowledgeDeepRepairTests() {
  const short = "# A\n\n简短正文。\n";
  const fuller = "# B\n\n更完整的业务正文，包含独有事实和适用条件。\n";
  assert.equal(preferredMergeHome([{ path: "A", incoming: 3, content: short },
    { path: "B", incoming: 1, content: fuller }]), "A", "Incoming references retain priority over length");
  assert.equal(preferredMergeHome([{ path: "A", incoming: 1,
    content: "---\naliases: [" + "alias,".repeat(80) + "]\n---\n" + short + "\n## 来源\n" + "[[source]]\n".repeat(80) },
    { path: "B", incoming: 1, content: fuller }]), "B", "Metadata length cannot win a tied home choice");
  assert.equal(preferredMergeHome([{ path: "A", incoming: 1, content: short },
    { path: "B", incoming: 1, content: short + "\n## 独有内容\n另一组必须保留的事实。\n" }]), "B");
  const primary =
    '---\ntags: "research" # 用户标签\naliases: ["主页别名"]\ncustom: "  原样  " # 留住\n---\n# 主页\n\n主页原有导语。\n\n## 取样\n原有取样事实。\n\n## 来源\n- [[Raw/a]]\n';
  const secondary =
    '---\ntags: ["research", "field"]\naliases: ["别页别名"]\n---\n# 另一页\n\n导语独有事实。\n\n## 配额\n独有事实：新老用户各六人。\n\n## 排序\n平分时保留原始证据更完整的一项。 ^tie\n\n## 来源\n- [[Raw/a]]\n- [[Raw/b]]\n';
  const references = {
    primaryPath: "Wiki/主页.md",
    secondaryPath: "Wiki/另一页.md",
    resolve: (link: string) => link.replace(/\.md$/u, "") + ".md",
  };
  const beforeMap = "### 取样\n- [[a]]\n- [[b]]\n手写不动\n- [[b|手写标签]]\n";
  const afterMap = "### 取样\n- [[a]]\n- [[a|b]]\n手写不动\n- [[a|手写标签]]\n";
  const mapApp = { metadataCache: { getFirstLinkpathDest: (link: string) => ({ path: `Wiki/${link}.md`, basename: link }) } } as any;
  const mapResult = normalizeMergedMapEntries(mapApp, "Wiki/index.md", beforeMap, afterMap, new Map([["Wiki/b.md", "Wiki/a.md"]]));
  assert.equal(mapResult, "### 取样\n- [[a]]\n手写不动\n- [[a|手写标签]]\n");
  const nested = "### 方法\n- 第一组\n  - [[a]]\n- 第二组\n  - [[b]]\n";
  const nestedAfter = nested.replace("[[b]]", "[[a|b]]");
  assert.equal(
    normalizeMergedMapEntries(mapApp, "Wiki/index.md", nested, nestedAfter, new Map([["Wiki/b.md", "Wiki/a.md"]])),
    nested.replace("[[b]]", "[[Wiki/a|a]]"),
  );
  const orderedHome = "# Home\n\n## Existing\nKeep.\n\n## 来源\n- [[Raw/a]]\n\n## 相关条目\n- [[peer]]\n";
  const distinct = mergeSections("# Other\n\n## 独有事实\nUnique fact.\n");
  const ordered = applyMergePlacements(orderedHome, distinct, distinct.map(section => ({ id: section.id, target: section.title })), references);
  assert.ok(ordered.content.indexOf("## 独有事实") < ordered.content.indexOf("## 来源"));
  assert.ok(!ordered.content.includes("\n\n\n"));
  assert.deepEqual(ordered.additions, [{ title: "独有事实", body: "Unique fact." }]);
  const relocated = applyMergePlacements(ordered.content, distinct,
    distinct.map(section => ({ id: section.id, target: "重新安排的小节" })), references);
  assert.ok(!relocated.content.includes("## 重新安排的小节"));
  assert.equal(relocated.destinations.get(distinct[0].id), "独有事实",
    "An entirely covered section maps to its retained prose rather than adding a duplicate heading");
  const uniqueSection = mergeSections("# Other\n\n## 新内容\nUnique additional fact.\n");
  assert.ok(applyMergePlacements(ordered.content, uniqueSection,
    uniqueSection.map(section => ({ id: section.id, target: "重新安排的小节" })), references)
    .content.includes("## 重新安排的小节\n\nUnique additional fact."));
  const decisionHome = '---\n并列保留: ["[[A]]"]\ncustom: " exact "\n---\n# Home\n';
  const decisionSource = '---\n并列保留: ["[[B]]"]\n不是重复: ["[[C]]"]\n---\n# Other\n';
  const combinedDecisions = mergeUserProperties(decisionHome, decisionSource, "Other", references);
  assert.deepEqual(readMaintenanceFrontmatterProperty(combinedDecisions, "并列保留").value, ["[[A]]", "[[B]]"]);
  assert.deepEqual(readMaintenanceFrontmatterProperty(combinedDecisions, "不是重复").value, ["[[C]]"]);
  assert.ok(combinedDecisions.includes('custom: " exact "'));
  assert.equal(deepFindingSuppressed("contradiction", [
    { path: "A", coexisting: ["B"], notDuplicates: [] },
    { path: "B", coexisting: [], notDuplicates: [] },
  ] as any), true);
  const sections = mergeSections(secondary);
  const placements = sections.map((section) => ({
    id: section.id,
    target: section.title === "导语" ? "背景" : section.title,
  }));
  const props = mergeUserProperties(primary, secondary, "另一页", references);
  assert.deepEqual(readMaintenanceFrontmatterProperty(props, "tags").value, ["research", "field"]);
  assert.deepEqual(readMaintenanceFrontmatterProperty(props, "aliases").value, [
    "主页别名",
    "别页别名",
    "另一页",
  ]);
  assert.ok(props.includes('custom: "  原样  " # 留住'));
  const introPlacements = sections.map(section => ({ id: section.id, target: section.title }));
  assert.ok(applyMergePlacements(props, sections, introPlacements, references).content.includes("导语独有事实。"));
  const merged = applyMergePlacements(props, sections, placements, references);
  assert.ok(merged.content.includes("主页原有导语。"));
  assert.ok(merged.content.includes("原有取样事实。"));
  assert.ok(merged.content.includes("新老用户各六人"));
  assert.ok(merged.content.includes("^tie"));
  assert.equal(merged.content.match(/\[\[Raw\/a\]\]/gu)?.length, 1);
  assert.throws(() => applyMergePlacements(primary, sections, placements.slice(1), references), /缺少小节/);
  assert.throws(
    () => applyMergePlacements(primary, sections, [...placements.slice(1), placements[1]], references),
    /去向不完整/,
  );
  assert.throws(
    () => mergeUserProperties(primary, "---\ntags: {bad: true}\n---\n正文", "bad", references),
    /不兼容/,
  );

  // The real merge entry validates every section, while metadata uses native target identity.
  const marker = '<!-- echoink-source: {"path":"Raw/shared.md","revision":"sha256:calibrated"} -->';
  const home = [
    "# 主页", "", "主页事实逐字保留。", "", "## 相关条目", "手写关系说明。",
    "<!-- echoink-related:BEGIN -->",
    "- 方法：[[另一页]] — 合并前互链",
    "- 方法：[[主页]] — 原有自指",
    "- 方法：[[同伴|主页的叫法]] — 保留主页理由",
    "<!-- echoink-related:END -->", "",
    "## 来源", "[[shared|主页原来源]]", "[[Raw/only-home.md]]", "",
  ].join("\n");
  const other = [
    "# 另一页", "", "另页独有事实。", "", "## 相关条目",
    "<!-- echoink-related:BEGIN -->",
    "- 应用：[[Wiki/主页.md|另一种主页叫法]] — 反向互链",
    "- 方法：[[Wiki/同伴.md|不同显示名]] — 另页理由不覆盖主页",
    "<!-- echoink-related:END -->",
    "- 方法：[[新增同伴]] — 旧版遗留的块外关系", "", "## 来源",
    "[[Raw/shared.md|校准资料]]", marker,
    "[[shared|无校准重复]]", "[仅另页资料](Raw/only-other.md)", "",
  ].join("\n");
  const nativeReferences = {
    ...references,
    resolve: (link: string) => {
      const name = link.split("/").at(-1)!.replace(/\.md$/u, "");
      return ["shared", "only-home", "only-other"].includes(name) ? `Raw/${name}.md` : `Wiki/${name}.md`;
    },
  };
  const incoming = mergeSections(other);
  const mergedReferences = applyMergePlacements(home, incoming,
    incoming.map(section => ({ id: section.id, target: section.title })), nativeReferences).content;
  assert.ok(mergedReferences.includes("主页事实逐字保留。"));
  assert.ok(mergedReferences.includes("另页独有事实。"));
  assert.ok(mergedReferences.includes("手写关系说明。"));
  const relatedBody = mergeSections(mergedReferences).find(section => section.kind === "related")!.body;
  const relatedTargets = knowledgeBodyLinkSpans(relatedBody).map(link => nativeReferences.resolve(link.target));
  assert.deepEqual(relatedTargets, ["Wiki/同伴.md", "Wiki/新增同伴.md"]);
  assert.ok(relatedBody.includes("保留主页理由"));
  assert.ok(!relatedBody.includes("另页理由不覆盖主页"));
  assert.ok(relatedBody.indexOf("[[新增同伴]]") < relatedBody.indexOf("<!-- echoink-related:END -->"));
  const sourcesBody = mergeSections(mergedReferences).find(section => section.kind === "sources")!.body;
  assert.deepEqual(knowledgeBodyLinkSpans(sourcesBody).map(link => nativeReferences.resolve(link.target)),
    ["Raw/shared.md", "Raw/only-home.md", "Raw/only-other.md"]);
  assert.ok(sourcesBody.includes(marker));
  assert.ok(!sourcesBody.includes("主页原来源") && !sourcesBody.includes("无校准重复"));
  const maintained = applyMaintenanceRelatedEntries(mergedReferences,
    [{ targetPath: "新增同伴", reason: "维护更新理由", type: "方法" }], mergedReferences);
  assert.ok(maintained.includes("维护更新理由"));
  assert.ok(!maintained.includes("旧版遗留的块外关系"), "Subsequent Maintain owns the merged relation row");
  const reverseSources = applyMergePlacements(other, mergeSections(home),
    mergeSections(home).map(section => ({ id: section.id, target: section.title })), nativeReferences).content;
  assert.ok(reverseSources.includes(marker), "A calibrated primary source wins over an uncalibrated incoming alias");

  const proseHome = "# Home\n\n原有导语。\n\n## 原有约束\n\n保管人每周三复核两组的到场数， 不把同一人计入两个组。\n\n## 表格\n\n| 项 | 值 |\n| -- | -- |\n| 人数 | 6 |\n";
  const proseSource = mergeSections("# Source\n\n## 另一处同样约束\n\n保管人每周三复核两组的到场数，\n不把同一人计入两个组。\n\n保管人可以共享客户明细。\n\n保管人不可以共享客户明细。\n\n新增的唯一补位要求。\n\n新增的唯一补位要求。\n\n## 原样表格\n\n| 项 | 值 |\n| -- | -- |\n| 人数 | 6 |\n");
  // Folding whitespace joins line-wraps, not Chinese sentences with different words.
  const proseChoices = proseSource.map(section => ({ id: section.id, target: section.title }));
  const proseResult = applyMergePlacements(proseHome, proseSource, proseChoices, references);
  assert.equal(proseResult.omittedIds.length, 2);
  assert.equal(proseResult.content.match(/每周三复核/gu)?.length, 1);
  assert.equal(proseResult.content.match(/新增的唯一补位要求/gu)?.length, 1);
  assert.ok(proseResult.content.includes("保管人可以共享客户明细。"));
  assert.ok(proseResult.content.includes("保管人不可以共享客户明细。"));
  assert.equal(proseResult.content.match(/\| 人数 \| 6 \|/gu)?.length, 2, "Tables never fold whitespace or deduplicate");
  const replayedProse = applyMergePlacements(proseHome, proseSource, proseChoices, references,
    new Set(proseResult.omittedIds));
  assert.equal(replayedProse.content, proseResult.content, "The anchor and final-write passes share the same omissions");
  const covered = mergeSections("# Other\n\n## 全部重复的小节\n\n原有导语。\n");
  const coveredResult = applyMergePlacements(proseHome, covered,
    covered.map(section => ({ id: section.id, target: section.title })), references);
  assert.equal(coveredResult.destinations.get(covered[0].id), "导语",
    "A removed source heading maps to an existing destination rather than a missing section");
  assert.ok(!coveredResult.content.includes("## 全部重复的小节"));

  const selfDecisions = mergeUserProperties(
    '---\n并列保留: ["[[主页]]", "[[同伴]]"]\n不是重复: ["[[另一页]]"]\n---\n# 主页\n',
    '---\n并列保留: ["[[主页]]"]\n---\n# 另一页\n', "另一页", nativeReferences);
  assert.deepEqual(readMaintenanceFrontmatterProperty(selfDecisions, "并列保留").value, ["[[同伴]]"]);
  assert.deepEqual(readMaintenanceFrontmatterProperty(selfDecisions, "不是重复").value, []);
  const selfDocs = [{ path: "A", notDuplicates: ["A"], coexisting: ["A"] },
    { path: "B", notDuplicates: [], coexisting: [] }] as any;
  assert.equal(deepFindingSuppressed("duplicate", selfDocs), false);
  assert.equal(deepFindingSuppressed("contradiction", selfDocs), false);
  const simple = "# 标题\n\n## 一\n需要改的段落。\n## 二\n后文保持。";
  const oneLine = conflictParagraph("x", simple, "需要改的段落。\n");
  assert.ok(applyConflictParagraph(simple, oneLine, "已经修改的段落。").includes("已经修改的段落。\n## 二"));
  const note =
    '---\ntags: [keep]\ncustom: " exact "\n---\n# 规则\n\n第一段保持。\n\n录音转写后立即删除，其他材料按项目要求保留。\n\n最后一段保持。\n';
  const paragraph = conflictParagraph("Wiki/规则.md", note, "录音转写后立即删除");
  const changed = applyConflictParagraph(
    note,
    paragraph,
    "录音核对转写后保留七天，其他材料按项目要求保留。",
  );
  assert.equal(changed.slice(0, paragraph.start), note.slice(0, paragraph.start));
  assert.ok(changed.endsWith(note.slice(paragraph.end)));
  assert.throws(() => applyConflictParagraph(note, paragraph, "新增 #newtag"), /标签只属于用户/);
  assert.throws(() => conflictParagraph("x", note, "不存在的原句"), /已变化/);

  const block = (domain: string, lines: string) =>
    `<!-- echoink-domain-map:BEGIN ${encodeURIComponent(domain)} -->\n<!-- echoink-domain-map:MODE tree -->\n## ${domain}\n${lines}\n<!-- echoink-domain-map:END ${encodeURIComponent(domain)} -->`;
  const a = block("A", "### 取材\n- [[a]]\n手写A\n### 缺口\n- A框架缺口");
  const b = block("B", "### 取材\n- [[b]]\n手写B\n### 验证\n- [[c]]");
  const maps = `前言必须保留\n${a}\n中间手写\n${b}\n尾注必须保留`;
  const combined = mergeKnowledgeDomainMaps(maps, "A", "B");
  assert.deepEqual(
    readMaintenanceDomainBlocks(combined).map((block) => block.domain),
    ["A"],
  );
  for (const text of ["手写A", "手写B", "中间手写", "尾注必须保留", "[[a]]", "[[b]]", "[[c]]"])
    assert.ok(combined.includes(text), text);
  assert.equal(combined.match(/^### 取材$/gmu)?.length, 1);
  const separateMaps = rehomeKnowledgeDomainBlock(`首文\n${b}\n后文`, a, "A", "B")!;
  assert.equal(separateMaps.source, "首文\n\n后文");
  assert.ok(separateMaps.target.includes("手写B"));
  const docs = [
    { domain: "A", separateDomains: ["B"] },
    { domain: "B", separateDomains: [] },
  ] as any;
  assert.equal(deepFindingSuppressed("nearDomain", docs), true);
  const documents = new Map([
    ["Wiki/A.md", '---\n已合并到: "[[Wiki/B]]"\n---\n# A'],
    ["Wiki/B.md", '---\n已合并到: "[[Wiki/C]]"\n---\n# B'],
    ["Wiki/C.md", "# C\n有效主页。"],
  ]);
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.wiki.enabled = true;
  bindings.roles.wiki.readPaths = ["Wiki"];
  const plugin = { settings: { knowledgeBase: { folderBindings: bindings } }, app: {
    metadataCache: { getFirstLinkpathDest: (link: string) => documents.has(link + ".md") ? { path: link + ".md" } : null },
  } } as any;
  const read = async (path: string) => documents.get(path)!;
  assert.equal(await resolveMergeHome(plugin, "Wiki/A.md", read), "Wiki/C.md");
  documents.set("Wiki/C.md", '---\n已合并到: "[[Wiki/A]]"\n---\n# C');
  await assert.rejects(resolveMergeHome(plugin, "Wiki/A.md", read), /循环/);
  documents.set("Wiki/C.md", '---\n已合并到: "[[Raw/source]]"\n---\n# C');
  documents.set("Raw/source.md", "# 原始资料");
  await assert.rejects(resolveMergeHome(plugin, "Wiki/A.md", read), /有效的通用 Wiki/);
  console.log(
    "PASS deep repairs: exact primary/source coverage, user tags/aliases, local paragraph bytes, joined handwritten trees and separate domains.",
  );
}
