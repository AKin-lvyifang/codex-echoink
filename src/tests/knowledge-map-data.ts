import assert from "node:assert/strict";
import type { CachedMetadata } from "obsidian";
import { buildKnowledgeMapData } from "../home/knowledge-map/data";

/** Synthetic Obsidian cache fixture: shared map boundaries, note hierarchy and legacy read-only behavior. */
export function runKnowledgeMapDataTests(): void {
  const content = [
    "手写前言",
    "<!-- echoink-domain-map:BEGIN A -->",
    "<!-- echoink-domain-map:MODE tree -->",
    "## A：工作框架",
    "### 研究",
    "- [[a|上位概念]]",
    "  - [[b|具体做法]]",
    "### 缺口",
    "- 缺少长期复盘框架",
    "### 来源",
    "- [[source]]",
    "<!-- echoink-domain-map:END A -->",
    "<!-- echoink-domain-map:BEGIN B -->",
    "<!-- echoink-domain-map:MODE list -->",
    "## B领域地图",
    "### 方法 / 流程",
    "- [[c]]",
    "<!-- echoink-domain-map:END B -->",
  ].join("\n");
  const position = (line: number) => {
    const start = content.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
    return {
      start: { line, col: 0, offset: start },
      end: {
        line,
        col: content.split("\n")[line].length,
        offset: start + content.split("\n")[line].length,
      },
    };
  };
  const cache = {
    headings: [3, 4, 7, 9, 14, 15].map((line) => ({
      heading: content.split("\n")[line].replace(/^#+ /u, ""),
      level: line === 3 || line === 14 ? 2 : 3,
      position: position(line),
    })),
    listItems: [5, 6, 8, 10, 16].map((line) => ({
      position: position(line),
      parent: line === 6 ? 5 : -1,
    })),
    links: [
      [5, "a", "上位概念"],
      [6, "b", "具体做法"],
      [10, "source", "source"],
      [16, "c", "c"],
    ].map(([line, link, displayText]) => ({
      link,
      displayText,
      original: `[[${link}]]`,
      position: position(Number(line)),
    })),
  } as CachedMetadata;
  const note = (name: string, domain: string, extra = "") => ({
    path: `Wiki/${name}.md`,
    content: `---\n领域: ${domain}\n类型: 概念\n${extra}---\n正文`,
  });
  const documents = [
    { path: "Wiki/index.md", content },
    note("a", "A"),
    note("b", "A"),
    note("c", "B"),
    note("merged", "A", "已合并到: a\n"),
  ];
  const result = buildKnowledgeMapData(
    documents,
    "Wiki",
    () => cache,
    (link) => ({ path: `Wiki/${link}.md`, basename: link }),
  );
  assert.equal(result.domains.length, 2);
  const [a, b] = result.domains;
  assert.equal(a.count, 2, "Merged notes stay outside the active catalog");
  assert.equal(a.mode, "tree");
  assert.equal(a.groups[0].entries[0].children[0].path, "Wiki/b.md");
  assert.deepEqual(a.gaps, ["缺少长期复盘框架"]);
  assert.equal(a.groups.length, 1, "Source links and the second domain never leak into A");
  assert.equal(b.mode, "list");
  assert.equal(b.mapPath, a.mapPath);
  assert.equal(b.groups[0].entries[0].path, "Wiki/c.md");
  assert.equal(documents[0].content, content, "Viewing never upgrades or rewrites a map");
  const withoutBlock = buildKnowledgeMapData(
    [...documents, note("d", "C")],
    "Wiki",
    () => cache,
    (link) => ({ path: `Wiki/${link}.md`, basename: link }),
  ).domains.find((domain) => domain.domain === "C")!;
  assert.equal(withoutBlock.mapPath, null);
  assert.equal(withoutBlock.mode, "list");
  assert.deepEqual(
    withoutBlock.groups.flatMap((group) => group.entries.map((entry) => entry.path)),
    ["Wiki/d.md"],
    "A shared index without this domain's block must show only its own notes",
  );
  const legacy = buildKnowledgeMapData(
    [note("a", "A")],
    "Wiki",
    () => null,
    () => null,
  );
  assert.equal(legacy.domains[0].mode, "list");
  assert.equal(legacy.domains[0].mapPath, null);
  assert.equal(legacy.domains[0].groups[0].entries[0].path, "Wiki/a.md");
  assert.deepEqual(
    buildKnowledgeMapData(
      [],
      "Wiki",
      () => null,
      () => null,
    ).domains,
    [],
  );
  console.log(
    "Knowledge map data: shared boundaries, nested notes, gaps, sources, merged exclusion and legacy/empty passed.",
  );
}
