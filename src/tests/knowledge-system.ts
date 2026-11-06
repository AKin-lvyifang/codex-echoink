import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TFile, type App } from "obsidian";
import {
  patchKnowledgeProperties,
  readMaintenanceFrontmatterProperty,
} from "../knowledge-base/maintenance-source-frontmatter";
import { maintenanceVisibleClassification } from "../knowledge-base/maintenance-p2-planning";
import { maintenanceDomainCatalog } from "../knowledge-base/maintenance-domain-catalog";
import { assertMaintenanceWikiTags } from "../knowledge-base/maintenance-tag-policy";
import {
  knowledgeWikiProperties,
  isGeneralKnowledgeWiki,
} from "../knowledge-base/knowledge-wiki-policy";
import {
  planMaintenanceDomainMaps,
  maintenanceDomainMapModeMarker,
} from "../knowledge-base/maintenance-domain-map";
import { KnowledgeAgentIndex } from "../knowledge-base/knowledge-agent-index";
import { VaultBodySearch } from "../knowledge-base/vault-body-search";
import { KnowledgeLinkHealthService } from "../knowledge-base/link-health";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import {
  knowledgeAnalysisCorpus,
  knowledgeFrameworkPrompt,
  validateKnowledgeDomainAnalysis,
} from "../knowledge-base/knowledge-system-analysis";

export async function runKnowledgeSystemTests(root: string): Promise<void> {
  const before =
    '﻿---\r\ncustom: 0021 # untouched\r\n领域: 旧领域 # domain comment\r\n待核实: false\r\n不是重复:\r\n  - "[[甲]]" # item' +
    ' comment\r\ntags: ["user-tag"]\r\n---\r\n# 正文\r\n用户原文 #我的标签\r\n';
  const patched = patchKnowledgeProperties(before, {
    领域: "新领域",
    待核实: true,
    不是重复: ["[[乙]]"],
    类型: "概念",
  });
  assert.ok(patched.startsWith("\uFEFF---\r\ncustom: 0021 # untouched\r\n"));
  for (const exact of [
    "# domain comment",
    "# item comment",
    'tags: ["user-tag"]\r\n',
    "# 正文\r\n用户原文 #我的标签\r\n",
  ])
    assert.ok(patched.includes(exact));
  assert.deepEqual(readMaintenanceFrontmatterProperty(patched, "不是重复").value, ["[[乙]]"]);
  assert.equal(patchKnowledgeProperties(patched, { 领域: "新领域" }), patched);
  const removed = patchKnowledgeProperties(patched, { 待核实: null });
  assert.equal(readMaintenanceFrontmatterProperty(removed, "待核实").present, false);
  assert.ok(removed.includes('tags: ["user-tag"]\r\n'));
  for (const yaml of [
    "领域: [自定义]",
    "领域:",
    "领域: {a: b}",
    "领域: &a 原值",
    "领域: 旧\n领域: 重复",
  ])
    assert.throws(() => patchKnowledgeProperties(`---\n${yaml}\n---\n原文`, { 领域: "新" }));
  assert.equal(
    maintenanceVisibleClassification("---\n领域: [甲]\n类型: 自定义\n---\n").domainPresent,
    true,
  );
  assert.equal(maintenanceVisibleClassification("---\n领域: [甲]\n---\n").domain, undefined);
  assert.throws(() => assertMaintenanceWikiTags("---\ntags: []\n---\n正文"), /标签/u);
  assert.throws(() => assertMaintenanceWikiTags("正文 #用户标签"), /标签/u);
  assert.throws(() => assertMaintenanceWikiTags("正文", "正文 #旧标签"), /标签/u);
  assertMaintenanceWikiTags("正文\n```md\n#代码示例\n```\n`#示例`\n[[甲#标题]]");
  assertMaintenanceWikiTags(patched, before);
  const catalog = maintenanceDomainCatalog([
    { path: "wiki/甲.md", content: "---\n领域: 学习\n---\n甲" },
    { path: "wiki/乙.md", content: "---\n领域: [错误]\n---\n乙" },
    { path: "wiki/旧.md", content: '---\n领域: 学习\n已合并到: "[[甲]]"\n---\n旧' },
  ]);
  assert.deepEqual(catalog, {
    domains: [{ domain: "学习", count: 1 }],
    incompatible: ["wiki/乙.md"],
  });
  assert.equal(
    isGeneralKnowledgeWiki(knowledgeWikiProperties("---\nechoink-english-diary: true\n---\n")),
    false,
  );
  const entries = [{ path: "wiki/甲.md", title: "甲", domain: "学习", type: "概念" as const }];
  const draft = planMaintenanceDomainMaps({ wikiRoot: "wiki", entries, existing: [] })[0];
  assert.ok(draft.content.includes(maintenanceDomainMapModeMarker("list")));
  assert.deepEqual(
    planMaintenanceDomainMaps({
      wikiRoot: "wiki",
      entries,
      existing: [
        {
          path: draft.targetPath,
          title: "地图",
          aliases: [],
          contentRevision: "x",
          content: draft.content.replace("MODE list", "MODE tree"),
        },
      ],
    })[0].treeDomains,
    ["学习"],
  );
  assert.deepEqual(knowledgeWikiProperties("---\ninvalid: [\n---\n"), {
    merged: false,
    specialized: false,
  });
  const bindings = emptyKnowledgeFolderBindings();
  Object.assign(bindings.roles.wiki, {
    enabled: true,
    readPaths: ["wiki"],
    writePath: "wiki",
    searchEnabled: true,
  });
  const bodies = new Map([
    ["wiki/甲.md", "---\n领域: 学习\n---\n# 甲\n系统测试词 active"],
    ["wiki/乙.md", "# 乙\n系统测试词 connected"],
    ["wiki/旧.md", '---\n已合并到: "[[甲]]"\n---\n# 旧\n系统测试词 merged'],
    ["wiki/index.md", "# 索引\n[[甲]]"],
    ["raw/原文.md", "# 来源\n[[甲]]"],
    ["projects/项目.md", "# 项目\n[[甲]]"],
  ]);
  const vault = path.join(root, "vault");
  for (const [relative, text] of bodies) {
    await mkdir(path.dirname(path.join(vault, relative)), { recursive: true });
    await writeFile(path.join(vault, relative), text);
  }
  const index = new KnowledgeAgentIndex({
    vaultPath: vault,
    storageRootPath: path.join(root, "index"),
  });
  await index.refresh();
  assert.ok(
    !(await index.search({ query: "系统测试词", kinds: ["wiki"] })).hits.some(
      (hit) => hit.vaultRelativePath === "wiki/旧.md",
    ),
  );
  const scans = [];
  for await (const doc of index.scanLinkingDocuments()) scans.push(doc.path);
  assert.ok(!scans.includes("wiki/旧.md"));
  assert.ok(
    (await index.read({ vaultRelativePath: "wiki/旧.md" })).content.includes("merged"),
    "explicit reading stays available",
  );
  const files = [...bodies].map(([name, body]) =>
    Object.assign(new TFile(), {
      path: name,
      basename: path.basename(name, ".md"),
      extension: "md",
      stat: { mtime: 1, ctime: 1, size: body.length },
    }),
  );
  const graph = Object.fromEntries(files.map((file) => [file.path, {}]));
  graph["wiki/index.md"] = { "wiki/甲.md": 1 };
  graph["raw/原文.md"] = { "wiki/甲.md": 1 };
  graph["projects/项目.md"] = { "wiki/甲.md": 1 };
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (name: string) => files.find((file) => file.path === name),
      read: async (file: TFile) => bodies.get(file.path)!,
      cachedRead: async (file: TFile) => bodies.get(file.path)!,
    },
    metadataCache: {
      on: () => ({}),
      offref() {},
      resolvedLinks: graph,
      getFirstLinkpathDest: (link: string) => files.find(file => file.path === link) ?? null,
      getFileCache: (file: TFile) => ({
        links: Object.keys(graph[file.path]).map(link => ({ link, original: `[[${link}]]`,
          position: { start: { offset: 0 }, end: { offset: 1 } } })),
        frontmatter: file.path === "wiki/旧.md" ? { 已合并到: "[[甲]]" } : {},
      }),
    },
    workspace: { layoutReady: true, getActiveFile: () => null, getLastOpenFiles: () => [] },
  } as unknown as App;
  const search = new VaultBodySearch(app, () => bindings);
  assert.ok(
    !(await search.search({ query: "系统测试词", kinds: ["wiki"] })).hits.some(
      (hit) => hit.vaultRelativePath === "wiki/旧.md",
    ),
  );
  assert.ok((await search.read({ vaultRelativePath: "wiki/旧.md" })).content.includes("merged"));
  const health = new KnowledgeLinkHealthService(app);
  assert.deepEqual(
    (await health.load(bindings)).isolatedPaths,
    ["wiki/乙.md", "wiki/甲.md"].sort(),
  );
  graph["wiki/乙.md"] = { "wiki/甲.md": 1 };
  assert.deepEqual((await health.load(bindings)).isolatedPaths, []);
  health.dispose();
  search.dispose();
  const docs = [
    { path: "wiki/甲.md", content: "---\n领域: 学习\n---\n完整正文末尾", revision: "v1" },
  ];
  const corpus = knowledgeAnalysisCorpus(docs);
  assert.ok(knowledgeFrameworkPrompt(corpus, "学习").includes("完整正文末尾"));
  const framework = {
    title: "框架",
    rationale: "组织理由",
    branches: [
      { title: "分支", rationale: "正文依据", entries: [{ path: "wiki/甲.md", why: "全文依据" }] },
    ],
    unplaced: [],
    gaps: [],
  };
  validateKnowledgeDomainAnalysis(
    { domain: "学习", frameworks: [framework, framework] },
    docs,
    "学习",
  );
  assert.throws(
    () =>
      validateKnowledgeDomainAnalysis(
        { domain: "学习", frameworks: [framework, { ...framework, branches: [] }] },
        docs,
        "学习",
      ),
    /完整/u,
  );
  const gap = (title: string) => ({ title, reason: "源文未覆盖", evidencePaths: ["wiki/甲.md"] });
  assert.throws(
    () =>
      validateKnowledgeDomainAnalysis(
        {
          domain: "学习",
          frameworks: [
            { ...framework, gaps: [gap("一"), gap("二")] },
            { ...framework, gaps: [gap("三"), gap("四")] },
          ],
        },
        docs,
        "学习",
      ),
    /每个领域/u,
  );
  console.log(
    "PASS knowledge system: precise properties, incompatible classification, user tags, mode ownersh" +
      "ip, active Wiki in both retrieval paths, Wiki-only isolation, complete read-only proposals.",
  );
}
