import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { App } from "obsidian";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { projectedKnowledgeLinks } from "../knowledge-base/knowledge-link-resolution";
import { scanKnowledgeCheckup } from "../knowledge-base/knowledge-checkup";
import {
  ignoreKnowledgeCheckup,
  fixKnowledgeBrokenLinks,
} from "../knowledge-base/knowledge-checkup-repairs";

export async function runKnowledgeCheckupTests(): Promise<void> {
  const long = "有来源的知识需要区分输入范围、上下文预算和实际执行结果。".repeat(15);
  const head =
    "---\ntags: [用户标签, '逐字 保留'] # 注释\ncustom: 0021 # 不改\n类型: 概念\n领域: A\n---\n";
  const sourceBody = "# 原始资料\n\n" + long + "\n";
  const source = "---\n提炼状态: 已提炼\n摘要: 维护自己写的摘要\n---\n" + sourceBody;
  const fingerprint = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
  const calibrated = (revision: string) => head + "# 来源检查\n" + long +
    '\n## 来源\n[[Raw/source]]\n<!-- echoink-source: ' +
    JSON.stringify({ path: "Raw/source.md", revision }) + " -->\n";
  const notes = new Map([
    ["Raw/source.md", source],
    ["Wiki/body-revision.md", calibrated(fingerprint(sourceBody))],
    ["Wiki/full-revision.md", calibrated(fingerprint(source))],
    ["Wiki/a.md", head + "# A\n" + long + "\n[[old/b]]\n[[old/c|另一个]]\n"],
    ["Wiki/b.md", head + "# B\n" + long + "\n[[c]]\n"],
    ["Wiki/c.md", head + "# C\n" + long + "\n[[b]]\n"],
    ["Wiki/isolated.md", head + "# Isolated\n" + long + "\n## 来源\n[[b]]\n"],
    ["Wiki/expression.md", "---\nechoink-english-diary: true\n---\nShort."],
    ["Wiki/index.md", "# 地图\n[[isolated]]\n"],
    ["Wiki/thin.md", head + "# Thin\n一句话。\n"],
    ["Wiki/no-type.md", "---\n领域: A\n---\n# Missing\n" + long + "\n[[b]]\n"],
    [
      "Wiki/pending.md",
      head.replace("类型: 概念", "类型: 概念\n类型待确认: true") +
        "# Pending\n" +
        long +
        "\n## 相关条目\n- [[b]]\n",
    ],
  ]);
  for (let i = 0; i < 10000; i++) notes.set(`Elsewhere/${i}.md`, long);
  const files = [...notes.keys()].map((path) => ({
    path,
    stat: { size: notes.get(path)!.length },
  }));
  const caches = new Map(
    files.map((file) => {
      const content = notes.get(file.path)!,
        fm = /^---\n([\s\S]*?)\n---\n/u.exec(content),
        start = fm?.[0].length ?? 0;
      const lines = [...content.matchAll(/[^\n]+/gu)].filter((m) => m.index! >= start);
      const headings = lines
        .filter((m) => /^#{1,6} /u.test(m[0]))
        .map((m) => ({
          level: m[0].match(/^#+/u)![0].length,
          heading: m[0].replace(/^#+ /u, ""),
          position: { start: { offset: m.index }, end: { offset: m.index! + m[0].length } },
        }));
      const links = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)].map((m) => ({
        original: m[0],
        link: m[1],
        position: { start: { offset: m.index }, end: { offset: m.index! + m[0].length } },
      }));
      return [
        file.path,
        {
          frontmatter: fm ? parse(fm[1]) : undefined,
          headings,
          links,
          sections: lines
            .filter((m) => !m[0].startsWith("#"))
            .map((m) => ({
              type: "paragraph",
              position: { start: { offset: m.index }, end: { offset: m.index! + m[0].length } },
            })),
        },
      ];
    }),
  );
  let reads = 0;
  const resolve = projectedKnowledgeLinks([...notes.keys()], new Map());
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getFiles: () => files,
      getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
      read: async (file: { path: string }) => {
        reads++;
        return notes.get(file.path)!;
      },
      readBinary: async (file: { path: string }) => {
        reads++;
        return Buffer.from(notes.get(file.path)!);
      },
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => caches.get(file.path),
      getFirstLinkpathDest: (link: string, source: string) => {
        const path = resolve(link, source);
        return path ? { path } : null;
      },
    },
    workspace: { layoutReady: true },
  } as unknown as App;
  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.wiki = {
    enabled: true,
    searchEnabled: true,
    readPaths: ["Wiki"],
    writePath: "Wiki",
    allowedSubdirectories: [],
  };
  const result = await scanKnowledgeCheckup(app, bindings);
  assert.ok(
    result.issues.some((i) => i.kind === "isolated" && i.path === "Wiki/isolated.md"),
    "Map and source-section links do not connect an isolated note",
  );
  assert.ok(!result.candidates.includes("Wiki/expression.md"));
  assert.ok(!result.candidates.some((p) => p.startsWith("Elsewhere/")));
  for (const kind of ["broken", "oneWay", "thin", "missingType", "pendingType"])
    assert.ok(result.issues.some((i) => i.kind === kind));
  assert.ok(reads < 8, "Bodies are limited to maps, thin notes and explicitly referenced sources");
  assert.ok(!result.issues.some(i => i.kind === "source"),
    "Maintain's canonical body revision and older full-file revisions both recognize unchanged sources");
  notes.set("Raw/source.md", source + "新增了会改变结论的事实。\n");
  const afterSourceEdit = await scanKnowledgeCheckup(app, bindings);
  assert.equal(afterSourceEdit.issues.filter(i => i.kind === "source").length, 2,
    "An actual source body edit invalidates both revision formats");
  const broken = result.issues.filter((i) => i.kind === "broken" && i.path === "Wiki/a.md");
  assert.equal(broken.length, 2);
  const fixed = fixKnowledgeBrokenLinks(
    app,
    "Wiki/a.md",
    notes.get("Wiki/a.md")!,
    broken.map((issue) => ({ issue, target: issue.candidates![0] })),
  );
  assert.ok(fixed.startsWith(head));
  assert.ok(fixed.includes("[[Wiki/b|old/b]]"));
  assert.ok(fixed.includes("[[Wiki/c|另一个]]"));
  const ignored = ignoreKnowledgeCheckup(fixed, "孤立页");
  assert.ok(
    ignored.includes(
      "tags: [用户标签, '逐字 保留'] # 注释\ncustom: 0021 # 不改\n类型: 概念\n领域: A\n",
    ),
  );
  assert.throws(
    () => ignoreKnowledgeCheckup("---\n体检忽略: true\n---\n正文", "孤立页"),
    /文本列表/u,
  );
  assert.deepEqual(
    [...notes.keys()],
    files.map((f) => f.path),
    "Diagnosis has no file writes",
  );
  console.log(
    "PASS checkup: native-cache scope/edges, excluded specialty, metadata-first body budget, multiple link repairs and byte-preserved user properties.",
  );
}
