import assert from "node:assert/strict";
import { TFile, TFolder, type App } from "obsidian";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { loadKnowledgeHealth } from "../knowledge-base/knowledge-health";
import type { KnowledgeBaseSettings } from "../settings/settings";

export function runKnowledgeHealthTests() {
  const bindings = emptyKnowledgeFolderBindings();
  for (const role of ["wiki", "raw"] as const)
    bindings.roles[role] = {
      enabled: true,
      readPaths: [role],
      writePath: role,
      allowedSubdirectories: [],
    };
  const files = ["a", "b", "c", "d", "index", "expression", "merged"].map((name) =>
    Object.assign(new TFile(), { path: `wiki/${name}.md`, basename: name }),
  );
  const folders = ["wiki", "raw"].map((path) => Object.assign(new TFolder(), { path }));
  const pos = (offset: number) => ({ start: { offset }, end: { offset: offset + 1 } });
  const link = (name: string, offset = 20) => ({
    link: name,
    original: `[[${name}]]`,
    position: pos(offset),
  });
  const caches = new Map<string, any>(files.map((file) => [file.path, { frontmatter: {} }]));
  caches.set("wiki/a.md", {
    frontmatter: {},
    headings: [{ level: 2, heading: "相关条目", position: pos(10) }],
    links: [link("wiki/b.md"), link("missing")],
  });
  caches.set("wiki/b.md", { frontmatter: {}, links: [link("wiki/a.md")] });
  caches.set("wiki/c.md", {
    frontmatter: {},
    headings: [{ level: 2, heading: "来源", position: pos(10) }],
    links: [link("wiki/a.md")],
  });
  caches.set("wiki/index.md", { frontmatter: {}, links: [link("wiki/d.md")] });
  caches.set("wiki/expression.md", { frontmatter: { "echoink-english-diary": true } });
  caches.set("wiki/merged.md", { frontmatter: { 已合并到: "[[a]]" } });
  caches.get("wiki/b.md").headings = [{ level: 1, heading: "来源", position: pos(0) }];
  let reads = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) =>
        [...folders, ...files].find((file) => file.path === path),
      read: () => {
        reads++;
        throw new Error("Scoring must not read note bodies");
      },
    },
    metadataCache: {
      getFileCache: (file: TFile) => caches.get(file.path),
      getFirstLinkpathDest: (path: string) => files.find((file) => file.path === path) ?? null,
    },
    workspace: { layoutReady: true },
  } as unknown as App;
  const settings = {
    folderBindings: bindings,
    processedSources: {},
    healthHistory: [],
    maintenanceHistory: [],
    initialization: { status: "initialized", initializedAt: 1 },
  } as unknown as KnowledgeBaseSettings;
  const initial = loadKnowledgeHealth(app, settings);
  assert.equal(initial.score, 87, "100 - 2 dead link - 1 one-way - round(2/4*20)");
  caches.get("wiki/a.md").frontmatter["体检忽略"] = ["死链：missing"];
  assert.equal(
    loadKnowledgeHealth(app, settings).score,
    89,
    "Dismissed dead links no longer deduct",
  );
  caches.get("wiki/a.md").links.pop();
  assert.equal(
    loadKnowledgeHealth(app, settings).score,
    89,
    "Repairing the same dead link has identical scoring",
  );
  caches.get("wiki/d.md").frontmatter.类型 = "概念";
  assert.equal(
    loadKnowledgeHealth(app, settings).score,
    89,
    "Content-only changes do not change the score",
  );
  caches.get("wiki/d.md").frontmatter["体检忽略"] = ["孤立页"];
  assert.equal(
    loadKnowledgeHealth(app, settings).score,
    94,
    "Ignored orphans stay in the denominator",
  );
  const source = Object.assign(new TFile(), { path: "raw/source.md", basename: "source" });
  files.push(source);
  for (const frontmatter of [
    { 已处理: true },
    { 提炼状态: "已提炼" },
    { 提炼状态: "待重新提炼" },
    { 提炼状态: "提炼失败" },
  ]) {
    caches.set(source.path, { frontmatter });
    assert.equal(loadKnowledgeHealth(app, settings).score, 94, "Existing source states keep the original base score");
  }
  caches.set(source.path, { frontmatter: { 提炼状态: "待校准", 提炼指纹: "saved" } });
  assert.equal(loadKnowledgeHealth(app, settings).score, 90, "Explicit calibration retains the original four-point penalty");
  const withPositions = loadKnowledgeHealth(app, settings).score;
  const rawFolder = folders.pop()!;
  const missingRaw = loadKnowledgeHealth(app, settings);
  assert.equal(missingRaw.score, withPositions - 24, "A missing mapped Raw position deducts once");
  assert.equal(missingRaw.scoreReasons.filter(reason => reason.penalty === 24).length, 1);
  const wikiFolder = folders.pop()!;
  const missingBoth = loadKnowledgeHealth(app, settings);
  assert.equal(missingBoth.score, withPositions - 48, "Two missing mapped positions deduct twice");
  assert.equal(missingBoth.scoreReasons.filter(reason => reason.penalty === 24).length, 2);
  folders.push(wikiFolder, rawFolder);
  files.length = 0;
  assert.equal(
    loadKnowledgeHealth(app, settings).status,
    "unknown",
    "Empty Wiki has no numeric score",
  );
  for (let i = 0; i < 10000; i++) {
    const file = Object.assign(new TFile(), { path: `wiki/n${i}.md`, basename: `n${i}` });
    files.push(file);
    caches.set(file.path, { frontmatter: { 类型: "概念" }, links: [] });
  }
  const started = performance.now();
  const bulk = loadKnowledgeHealth(app, settings);
  const elapsedMs = performance.now() - started;
  assert.equal(bulk.score, 80);
  assert.equal(reads, 0);
  console.log(
    `PASS unified health: native edges, map/source exclusions, ignore denominator, content neutrality; 10000 Wiki ${elapsedMs.toFixed(1)}ms, ${reads} body reads.`,
  );
}
