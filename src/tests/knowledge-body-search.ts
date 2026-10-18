import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { BodySearchMemoryIndex, searchBodyDocuments } from "../knowledge-base/search/body-search";
import { VaultBodySearch, knowledgeSearchPathKind } from "../knowledge-base/vault-body-search";
import { emptyKnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import { buildSearchDictionary, tokenizeSearchText } from "../knowledge-base/search/tokenize";
import { yieldSearchTask } from "../knowledge-base/search/scheduling";
import { sliceKnowledgeSourceSpan } from "../knowledge-base/source-span";
import type { BodySearchDocument, BodySearchOptions, BodySearchRequest, BodySearchResult } from "../knowledge-base/search/contracts";

function note(path: string, body: string, metadata: Partial<BodySearchDocument> = {}): BodySearchDocument {
  return { vaultRelativePath: path, title: path.split("/").at(-1)!.replace(/\.md$/u, ""), kind: "notes", recordedAt: 100,
    read: async () => ({ content: body, contentRevision: `sha256:${path}` }), ...metadata };
}

async function search(documents: readonly BodySearchDocument[], request: BodySearchRequest) {
  return searchBodyDocuments({ documents, request });
}

async function withCheckpointTask<T>(onTask: () => void, action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  const timers = new Set<ReturnType<typeof setTimeout>>();
  Object.defineProperty(globalThis, "scheduler", { configurable: true, value: { yield: () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { onTask(); resolve(); } catch (error) { reject(error); }
    }, 0);
    timers.add(timer);
  }) } });
  try { return await action(); }
  finally {
    for (const timer of timers) clearTimeout(timer);
    if (descriptor) Object.defineProperty(globalThis, "scheduler", descriptor);
    else Reflect.deleteProperty(globalThis, "scheduler");
  }
}

export async function runKnowledgeBodySearchMetadataTests(): Promise<void> {
  const paragraph = "The glass samples stay in the north drawer.\nCount the lenses before packing.";
  const cases = [
    { query: "Nacre Atlas", metadata: { title: "Nacre Atlas" }, properties: "status: draft", heading: "# Nacre Atlas", source: "title" },
    { query: "Tidal Compass", metadata: { title: "Field kit", aliases: ["Tidal Compass"] }, properties: "aliases: [Tidal Compass]", heading: "Field kit\n========", source: "alias" },
    { query: "reserve-batch", metadata: { title: "Field kit", tags: ["#reserve-batch"] }, properties: "tags: [reserve-batch]", heading: "# Field kit", source: "tag" },
  ] as const;
  for (const fixture of cases) {
    const content = ["\uFEFF---", fixture.properties, "---", "", fixture.heading, "", paragraph, "", "## Later notes", "A separate paragraph concerns the empty crates."].join("\r\n");
    const document = note("metadata-fixture.md", content, fixture.metadata);
    const result = await search([document], { query: fixture.query });
    assert.ok(result.hits.length > 0);
    for (const hit of result.hits) {
      assert.equal(hit.excerpt, paragraph, "metadata matches deliver the first actual paragraph, excluding properties and headings");
      assert.deepEqual(hit.matchSources, [fixture.source]);
      assert.equal(hit.sectionTitle, fixture.metadata.title);
      assert.equal(hit.excerpt, sliceKnowledgeSourceSpan(content.split(/\r\n|\n|\r/u), hit));
      assert.equal(hit.contentRevision, "sha256:metadata-fixture.md");
    }
  }

  const preciseBody = ["---", "aliases: [Tidal Compass]", "---", "# Tidal Compass", "A short introduction without the search name.", "",
    ...Array.from({ length: 90 }, () => "Background about storage boxes."), "Tidal Compass uses the eastern loading gate."].join("\n");
  const precise = (await search([note("precise.md", preciseBody, { title: "Field kit", aliases: ["Tidal Compass"] })], { query: "Tidal Compass" })).hits.find(hit => hit.matchSources?.includes("body"))!;
  assert.ok(precise.lineStart > 70, "a real body match stays at its source position even when properties and headings repeat the name");
  assert.match(precise.excerpt, /eastern loading gate/u);
  assert.deepEqual(precise.matchSources, ["alias", "body"]);
  assert.equal(precise.excerpt, sliceKnowledgeSourceSpan(preciseBody.split("\n"), precise));

  const boilerplateBody = ["---", "status: draft", "---", "# Nacre Atlas", "", paragraph, "",
    ...Array.from({ length: 90 }, () => "Background about storage boxes."), "这里的笔记和记录稍后再补充。"].join("\n");
  for (const query of ["关于Nacre Atlas的笔记有哪些？", "找一下Nacre Atlas相关的记录"]) {
    const result = await search([note("metadata-with-boilerplate.md", boilerplateBody, { title: "Nacre Atlas" })], { query });
    assert.ok(result.hits.length > 0);
    assert.equal(result.hits[0].excerpt, paragraph, "body boilerplate alone does not replace the first substantive paragraph for a metadata-led query");
    assert.ok(result.hits[0].matchSources?.includes("title"));
  }
  const partialName = "青岚跨海物资转运总方案";
  const partialBody = ["# Field kit", "An unrelated introduction.", "", ...Array.from({ length: 90 }, () => "Background about storage boxes."), "青岚装箱应先检查密封。"].join("\n");
  const partialHit = (await search([note("metadata-partial-name.md", partialBody, { aliases: [partialName] })], { query: `关于${partialName}的笔记有哪些？` })).hits[0];
  assert.ok(partialHit.lineStart > 70, "genuine partial-name bigrams retain their body position even at a small existing token weight");
  assert.match(partialHit.excerpt, /青岚装箱/u);
  assert.equal(partialHit.excerpt, sliceKnowledgeSourceSpan(partialBody.split("\n"), partialHit));

  const longParagraph = "📌Lens measurements ".repeat(1500);
  const longContent = `---\naliases: [Copper Beacon]\n---\n\n# Field kit\n\n${longParagraph}\n\nA later paragraph.`;
  let reads = 0;
  const longDocument = note("long-metadata.md", longContent, { aliases: ["Copper Beacon"], revisionKey: "first", read: async () => {
    reads++; return { content: longContent, contentRevision: "sha256:long-metadata" };
  } });
  const memory = new BodySearchMemoryIndex();
  try {
    const options = { documents: [longDocument], request: { query: "Copper Beacon" } };
    const cold = await memory.search(options);
    const warm = await memory.search(options);
    assert.equal(reads, 1);
    assert.deepEqual(warm.hits, cold.hits, "cached statistics retain the same metadata provenance and first body coordinates");
    const hit = cold.hits[0];
    assert.equal(hit.lineStart, 7);
    assert.equal(hit.lineEnd, 7);
    assert.equal(hit.columnStart, 0);
    assert.ok(hit.columnEnd! > 0 && hit.columnEnd! < longParagraph.length);
    assert.ok(hit.excerpt.length <= 3200, "metadata fallback uses the original fragment budget for long single lines");
    assert.equal(hit.excerpt, sliceKnowledgeSourceSpan(longContent.split("\n"), hit));
    assert.deepEqual(hit.matchSources, ["alias"]);
  } finally { memory.dispose(); }
  console.log("Knowledge metadata evidence: title, alias, tag, boilerplate, partial-name/body priority, bounded columns and cached provenance PASS");
}

export async function runKnowledgeBodySearchReferenceBoundaryTests(): Promise<void> {
  const current = note("wiki/current.md", "# Current source\n\n这份书单的下一步安排是先整理卡片。", { kind: "wiki", title: "Current source" });
  const exact = note("wiki/exact.md", "# 这篇材料\n\n下一步安排先核对纸张数量。", { kind: "wiki", title: "这篇材料" });
  const alias = note("wiki/alias.md", "# Alias source\n\n下一步安排先统计包装规格。", { kind: "wiki", aliases: ["刚才那篇方案"] });
  const rows: { scenario: string; expected: string[]; actual: string[]; passes: boolean }[] = [];
  const record = async (scenario: string, documents: readonly BodySearchDocument[], query: string, expected: string[], activePath?: string, recentPaths: string[] = []) => {
    const result = await searchBodyDocuments({ documents, request: { query }, activePath, recentPaths });
    const actual = [...new Set(result.hits.map(hit => hit.vaultRelativePath))];
    rows.push({ scenario, expected, actual, passes: JSON.stringify(actual) === JSON.stringify(expected) });
  };
  await record("exact-title-is-not-a-pronoun", [current, exact], "这篇材料", [exact.vaultRelativePath], current.vaultRelativePath);
  await record("exact-alias-is-not-a-pronoun", [current, alias], "刚才那篇方案", [alias.vaultRelativePath], current.vaultRelativePath);
  await record("pronoun-text-inside-a-title-is-protected", [current, exact], "找一下这篇材料", [exact.vaultRelativePath], current.vaultRelativePath);
  const recent = note("notes/recent.md", "# Recent source\n\n下一步安排先检查封口，再登记箱数。", { title: "Recent source" });
  await record("current-single-source-boundary", [current, exact, recent], "当前这篇里，下一步安排是什么？", [current.vaultRelativePath], current.vaultRelativePath, [recent.vaultRelativePath]);
  await record("recent-single-source-boundary", [current, exact, recent], "刚才那篇里面，下一步安排是什么？", [recent.vaultRelativePath], undefined, [recent.vaultRelativePath]);
  console.log("Explicit reference boundary development evidence:", JSON.stringify(rows));
  assert.deepEqual(rows.filter(row => !row.passes), [], "exact names and single-source boundaries must both hold");
  console.log("Knowledge explicit reference boundaries: exact title/alias, internal name text and current/recent single-source evidence PASS");
}

export async function runKnowledgeBodySearchReferenceTests(): Promise<void> {
  const currentBody = "---\nstatus: draft\n---\n# Current source\n\nThe current source requires a silver label.\n\nA later paragraph concerns packing.";
  const current = note("notes/current.md", currentBody, { revisionKey: "current-1" });
  const recent = note("notes/recent.md", "# Recent source\n\nThe recent source requires a violet label.", { revisionKey: "recent-1" });
  const matching = note("notes/matching.md", "# Matching source\nQUARTZ_TARGET appears in this separate source.", { revisionKey: "matching-1" });
  const documents = [current, recent, matching];
  for (const query of ["刚才那篇讲了什么？", "这篇的重点是什么？", "当前这篇有什么条件？"]) {
    const result = await searchBodyDocuments({ documents, request: { query }, activePath: current.vaultRelativePath, recentPaths: [recent.vaultRelativePath] });
    assert.equal(result.hits.length, 1);
    const hit = result.hits[0];
    assert.equal(hit.vaultRelativePath, current.vaultRelativePath, "current source takes precedence over a different most-recent source");
    assert.equal(hit.excerpt, "The current source requires a silver label.");
    assert.equal(hit.inclusionReason, "按指代带入");
    assert.equal(hit.score, 0, "a directly included source does not invent a keyword score");
    assert.equal(hit.matchSources, undefined, "an unmatched source does not claim a title, alias, tag or body match");
    assert.equal(hit.excerpt, sliceKnowledgeSourceSpan(currentBody.split("\n"), hit));
  }
  const fallback = await searchBodyDocuments({ documents, request: { query: "这篇的重点是什么？" }, recentPaths: ["missing.md", recent.vaultRelativePath, current.vaultRelativePath] });
  assert.equal(fallback.hits[0].vaultRelativePath, recent.vaultRelativePath);
  assert.equal(fallback.hits.length, 1, "only the first eligible recent source is directly included");
  const excluded = await searchBodyDocuments({ documents, request: { query: "这篇的重点是什么？", excludePaths: [current.vaultRelativePath] }, activePath: current.vaultRelativePath, recentPaths: [recent.vaultRelativePath] });
  assert.equal(excluded.hits[0].vaultRelativePath, recent.vaultRelativePath);
  const restricted = await searchBodyDocuments({ documents, request: { query: "这篇的重点是什么？", kinds: ["wiki"] }, activePath: current.vaultRelativePath, recentPaths: [recent.vaultRelativePath] });
  assert.equal(restricted.hits.length, 0);
  for (const query of ["QUARTZ_TARGET", "最近读过哪些资料？", "我那个想法是什么？", "它的截止时间呢？"]) {
    const result = await searchBodyDocuments({ documents, request: { query }, activePath: current.vaultRelativePath, recentPaths: [recent.vaultRelativePath] });
    assert.equal(result.hits.some(hit => hit.vaultRelativePath === current.vaultRelativePath), false, "ordinary questions and broad pronouns do not include browsing context");
    assert.equal(result.hits.some(hit => hit.inclusionReason !== undefined), false);
  }
  const memory = new BodySearchMemoryIndex();
  try {
    const options = { documents, request: { query: "这篇提到的 QUARTZ_TARGET 在别处还有吗？" }, activePath: current.vaultRelativePath, recentPaths: [recent.vaultRelativePath] };
    const full = await memory.search(options);
    assert.equal(full.hits[0].vaultRelativePath, current.vaultRelativePath, "the current source is directly included even when only another file matches the topic");
    assert.ok(full.hits.some(hit => hit.vaultRelativePath === matching.vaultRelativePath));
    const first = await memory.search({ ...options, request: { ...options.request, limit: 1 } });
    const next = await memory.search({ ...options, request: { ...options.request, limit: 1, offset: 1 } });
    assert.deepEqual([...first.hits, ...next.hits], full.hits);
    assert.equal(first.coverage.readFiles, 0);
    assert.equal(next.coverage.cachedFiles, documents.length);
    assert.equal(next.hits[0].inclusionReason, undefined);
    const matchingCurrent = await memory.search({ ...options, activePath: matching.vaultRelativePath });
    assert.equal(matchingCurrent.total, (await memory.search({ documents, request: options.request })).total, "moving an existing keyword hit does not duplicate it");
    assert.equal(matchingCurrent.hits[0].inclusionReason, "按指代带入");
    assert.ok(matchingCurrent.hits[0].matchSources?.includes("body"), "actual keyword provenance remains available when the current source really matches");
  } finally { memory.dispose(); }
  console.log("Knowledge explicit references: current priority, recent fallback, truthful evidence, filters, ordinary queries and warm pagination PASS");
}

export async function runKnowledgeBodySearchColumnTests(): Promise<void> {
  const cases = [
    `${"无关📌背景。".repeat(4000)}尾部金丝雀答案。`,
    `# 章节\n${"前置📌材料。".repeat(4000)}\n尾部金丝雀答案。\n如果下雨则暂停。`,
  ];
  for (const content of cases) {
    const result = await search([note("column-range.md", content)], { query: "金丝雀答案" });
    const hit = result.hits[0];
    assert.match(hit.excerpt, /尾部金丝雀答案/u);
    assert.equal(typeof hit.columnStart, "number");
    assert.equal(typeof hit.columnEnd, "number");
    const lines = content.split("\n");
    const lineOffset = (line: number) => lines.slice(0, line - 1).reduce((offset, text) => offset + text.length + 1, 0);
    const start = lineOffset(hit.lineStart) + hit.columnStart!;
    const end = lineOffset(hit.lineEnd) + hit.columnEnd!;
    assert.equal(content.slice(start, end), hit.excerpt, "line and UTF-16 column coordinates reconstruct the exact bounded original excerpt");
    assert.ok(hit.excerpt.length <= 3200);
  }
  const whole = (await search([note("whole-lines.md", "# 章节\n金丝雀答案在这里。")], { query: "金丝雀答案" })).hits[0];
  assert.equal(whole.columnStart, undefined);
  assert.equal(whole.columnEnd, undefined);
  console.log("Knowledge body search: bounded UTF-16 source columns PASS");
}

export async function runKnowledgeBodySearchTests(): Promise<void> {
  const dictionary = buildSearchDictionary([
    note("names.md", "", { title: "莫干山徒步路线", aliases: ["远程办公随想", "a multi word alias"], tags: ["#walking/trails"] }),
    note("sentence.md", "", { title: "我对远程办公的看法" }),
    note("punctuation.md", "", { title: "版本：二" }),
    note("long.md", "", { title: "一个长度明显超过十二字的完整笔记标题" }),
  ]);
  assert.ok(dictionary.includes("莫干山徒步路线"));
  assert.ok(dictionary.includes("a multi word alias"));
  assert.ok(dictionary.includes("walking/trails"));
  assert.ok(!dictionary.includes("我对远程办公的看法"));
  assert.ok(!dictionary.includes("版本：二"));
  assert.ok(!dictionary.includes("一个长度明显超过十二字的完整笔记标题"));
  for (const term of ["莫干山徒步路线", "莫干", "干山"]) assert.ok(tokenizeSearchText("莫干山徒步路线", dictionary).includes(term));
  assert.ok(tokenizeSearchText("EchoInk 2.6.2").includes("2.6.2"));
  assert.ok(!tokenizeSearchText("EchoInk 2.6.2").includes("6"));
  assert.equal(tokenizeSearchText("知识知识", ["知识"]).filter((token) => token === "知识").length, 2, "layers do not invent repeated term frequency");
  const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  try {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    assert.deepEqual(tokenizeSearchText("莫干山 2.6.2"), ["2.6.2", "莫干", "干山"]);
  } finally {
    if (segmenterDescriptor) Object.defineProperty(Intl, "Segmenter", segmenterDescriptor);
    else Reflect.deleteProperty(Intl, "Segmenter");
  }

  const strong = note("projects/decision.md", "# 晨星项目\n## 本地方案\n晨星项目没有采用本地方案，因为离线同步需要重复维护两套状态。", { kind: "projects" });
  const weak = Array.from({ length: 100 }, (_, index) => note(`wiki/weak-${index}.md`, "# 泛谈\n晨星项目。通用技术背景。", { kind: "wiki", tags: ["本地方案"] }));
  const relevance = await searchBodyDocuments({ documents: [...weak, strong], request: { query: "晨星项目为什么没有采用本地方案", limit: 5 }, activePath: weak[0].vaultRelativePath, recentPaths: weak.map((item) => item.vaultRelativePath) });
  assert.equal(relevance.hits[0].vaultRelativePath, strong.vaultRelativePath, "strong project evidence beats a hundred weak Wiki hints");
  assert.equal(relevance.hits[0].sectionTitle, "本地方案");
  assert.equal(relevance.coverage.scannedFiles, 101);
  assert.equal(relevance.coverage.complete, true);
  assert.equal((await search([note("tag-only.md", "unrelated content", { tags: ["specialtopic"] })], { query: "specialtopic" })).hits.length, 0);

  const conversationalNoise = [
    ...["灯光调试", "货架装配", "工位调整"].map((topic, index) => note(`discussion-${index}.md`, `# ${topic}\n` + `${topic}时又说起那个想法。那个位置留空，什么材料合适，那个想法以后再试，什么尺寸还得测量。\n`.repeat(18))),
    note("essay.md", "# 书写\n我把昨天的想法写在卡片上，再装订成册。"),
    note("craft.md", "# 陶艺安排\n陶艺课约在青松工作室，下午两点从揉泥开始。", { title: "陶艺安排" }),
    ...Array.from({ length: 24 }, (_, index) => note(`background-${index}.md`, `# 记录${index}\n海边的石头呈灰色，潮水退去后露出贝壳。`)),
  ];
  const noisyQuestion = await search(conversationalNoise, { query: "我那个关于陶艺去哪学的想法是什么？", limit: 10 });
  assert.equal(noisyQuestion.hits[0].vaultRelativePath, "craft.md", "burst repetitions and cross-word bigrams cannot outweigh the actual topic");
  assert.match(noisyQuestion.hits[0].excerpt, /青松工作室/u);

  const mixedDocuments = [
    note("trail.md", "# 行程\nEchoInk 2.6.2 记录了莫干山徒步路线，入口在山脚。", { title: "莫干山徒步路线" }),
    note("other-version.md", "# 升级\nEchoInk 2.7.0 记录其他内容。"),
  ];
  assert.equal((await search(mixedDocuments, { query: "EchoInk 莫干山 2.6.2" })).hits[0].vaultRelativePath, "trail.md");
  try {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    assert.equal((await search(mixedDocuments, { query: "EchoInk 莫干山 2.6.2" })).hits[0].vaultRelativePath, "trail.md", "mixed-language words and versions preserve Chinese fallback when segmentation is unavailable");
    assert.equal((await search(mixedDocuments, { query: "莫干" })).hits[0].vaultRelativePath, "trail.md", "necessary two-character partial names remain searchable");
  } finally {
    if (segmenterDescriptor) Object.defineProperty(Intl, "Segmenter", segmenterDescriptor);
    else Reflect.deleteProperty(Intl, "Segmenter");
  }

  const exactVersion = await search([note("version.md", "# 发布\n2.6.2 修复版本检索。"), note("other.md", "# 发布\n2.7.0 另一个版本。")], { query: "2.6.2" });
  assert.equal(exactVersion.hits[0].vaultRelativePath, "version.md");
  assert.equal(exactVersion.total, 1);
  const versionTopic = await search([
    note("release-4.8.1.md", "# 4.8.1 发布\n4.8.1 加入离线草稿，修复导出时的换行。"),
    note("personal.md", "# 随笔\n我想给朋友做一个版本。"),
    ...Array.from({ length: 20 }, (_, index) => note(`version-background-${index}.md`, "# 别的记录\n花盆底部垫一层碎石，雨后检查积水。")),
  ], { query: "4.8.1 版本改了什么？" });
  assert.equal(versionTopic.hits[0].vaultRelativePath, "release-4.8.1.md", "a normal heading/body repetition cannot weaken an exact dotted version below an incidental generic noun");
  const partialTopic = await search([
    note("ecology.md", "# 从水塘开始\n生态需要从具体环境观察，不能只记术语。", { title: "生态与例子" }),
    note("nursery.md", "# 生态园记录\n生态园种了几排灌木。哪些位置缺水，还得再检查。", { title: "生态园记录" }),
    note("library.md", "# 生态馆\n生态馆每月开放一次。", { title: "生态馆" }),
    note("chat-a.md", "# 手工\n我写了笔记。"),
    note("chat-b.md", "# 河流\n关于河流，另有一张地图。"),
    note("chat-c.md", "# 云朵\n哪些变化需要留下来？"),
    ...Array.from({ length: 20 }, (_, index) => note(`ecology-background-${index}.md`, "# 别的记录\n将门框尺寸写在纸上，再去选木料。")),
  ], { query: "我关于生态的笔记有哪些？", limit: 10 });
  const partialTopicRank = partialTopic.hits.findIndex((hit) => hit.vaultRelativePath === "ecology.md");
  assert.ok(partialTopic.hits.some((hit) => hit.vaultRelativePath === "nursery.md"), "longer dictionary words remain reachable through two-character partial matches");
  const titleAlias = await search([
    note("a.md", "some evidence", { title: "Snowbird" }),
    note("b.md", "some evidence", { title: "ordinary", aliases: ["Snowbird"] }),
  ], { query: "snowbird" });
  assert.equal(titleAlias.hits[0].score, titleAlias.hits[1].score, "aliases receive the same relevance as titles");

  const body = ["# 合成资料", ...Array.from({ length: 80 }, (_, index) => `一般背景 ${index}`), "## 最终安排", "如果天气变差，就取消。", "莫干山集合时间为14:20，务必先确认天气。", "不要按旧安排14:00出发。"].join("\n");
  const staleHeadings = note("long.md", body, { headings: [{ heading: "过期章节", line: 2, level: 2 }] });
  const located = await search([staleHeadings], { query: "莫干山集合时间" });
  assert.equal(located.hits[0].sectionTitle, "最终安排");
  assert.ok(located.hits[0].lineStart > 80);
  assert.match(located.hits[0].excerpt, /如果天气变差/u);
  assert.match(located.hits[0].excerpt, /不要按旧安排/u);
  assert.equal(located.hits[0].excerpt, body.split("\n").slice(located.hits[0].lineStart - 1, located.hits[0].lineEnd).join("\n"));
  assert.equal(located.hits[0].contentRevision, "sha256:long.md");
  assert.equal(located.hits[0].totalLines, 85);
  const longChapter = await search([note("one-section.md", ["# 超长章节", ...Array.from({ length: 220 }, () => "无关背景内容。"), "尾部唯一答案是翡翠岛集合点。", "如果下雨则暂停。"].join("\n"))], { query: "翡翠岛集合点" });
  assert.match(longChapter.hits[0].excerpt, /尾部唯一答案/u);
  assert.ok(longChapter.hits[0].lineStart > 190);
  assert.ok(longChapter.hits[0].excerpt.length <= 3200);
  const repetitiveChapter = await search([note("repetitive.md", [...Array.from({ length: 240 }, () => "commonA commonB commonC"), "raretopicneedle is the actual answer"].join("\n"))], { query: "commonA commonB commonC raretopicneedle" });
  assert.match(repetitiveChapter.hits[0].excerpt, /raretopicneedle is the actual answer/u, "repeated generic query words do not hide a rare answer at the end");
  const longLine = await search([note("one-line.md", `${"无关背景".repeat(4000)}尾部金丝雀答案。`)], { query: "金丝雀答案" });
  assert.match(longLine.hits[0].excerpt, /尾部金丝雀答案/u);
  assert.equal(longLine.hits[0].lineStart, 1);
  assert.equal(longLine.hits[0].lineEnd, 1);
  await runKnowledgeBodySearchColumnTests();
  const expandedGlyphs = await search([note("unicode.md", `${"ﬃ".repeat(2500)}\n## 答案\n金丝雀就在这里。`)], { query: "金丝雀" });
  assert.equal(expandedGlyphs.hits[0].lineStart, 2);
  assert.match(expandedGlyphs.hits[0].excerpt, /金丝雀就在这里/u);
  const fenced = await search([note("fences.md", "# Real\n```md\n# Fake\n```\nneedle\n\nSetext\n------\nsecondneedle")], { query: "needle" });
  assert.equal(fenced.hits[0].sectionTitle, "Real");
  assert.equal((await search([note("setext.md", "# Real\nIntro\n\nSetext\n------\nsecondneedle")], { query: "secondneedle" })).hits[0].sectionTitle, "Setext");

  const multiDocs = [note("both.md", "# Both\nalpha beta evidence"), note("alpha.md", "# Alpha\nalpha evidence"), note("beta.md", "# Beta\nbeta evidence")];
  const multi = await search(multiDocs, { queries: ["alpha", "beta"], limit: 20 });
  assert.equal(multi.total, 3);
  assert.equal(multi.hits[0].vaultRelativePath, "both.md", "RRF promotes evidence found by both phrasings");
  assert.equal(new Set(multi.hits.map((hit) => `${hit.vaultRelativePath}:${hit.lineStart}`)).size, multi.hits.length);
  const second = await search(multiDocs, { queries: ["alpha", "beta"], offset: 1, limit: 1 });
  assert.equal(second.hits[0].vaultRelativePath, multi.hits[1].vaultRelativePath);
  assert.equal(second.total, multi.total);
  const zeroLimit = await search(multiDocs, { queries: ["alpha", "beta"], limit: 0 });
  assert.deepEqual(zeroLimit.hits, []);
  assert.equal(zeroLimit.total, multi.total);
  assert.deepEqual(zeroLimit.coverage, multi.coverage, "zero result budget still reports the full actual scan");
  await assert.rejects(search(multiDocs, { queries: ["a", "b", "c", "d", "e", "f"] }), /five queries/u);

  const dated = [
    note("journal/2026-09-30.md", "topic september", { kind: "journal", recordedAt: Date.UTC(2026, 9, 15) }),
    note("journal/2026-10-01.md", "topic october", { kind: "journal", recordedAt: 0 }),
    note("journal/2026-10-31.md", "topic month end", { kind: "journal", recordedAt: 0 }),
    note("journal/2026-02-30.md", "topic unknown", { kind: "journal" }),
    note("journal/no-date.md", "topic unknown", { kind: "journal" }),
    note("notes/2026-09-30.md", "topic normal", { recordedAt: 0 }),
  ];
  const dateResults = await search(dated, { query: "topic", dateFrom: "2026-10-01", dateTo: "2026-10-31", limit: 20 });
  assert.deepEqual(new Set(dateResults.hits.map((hit) => hit.vaultRelativePath)), new Set(["journal/2026-10-01.md", "journal/2026-10-31.md", "notes/2026-09-30.md"]));
  assert.equal(dateResults.coverage.unknownJournalDates, 2);
  assert.equal(dateResults.coverage.complete, false);
  assert.equal(dateResults.hits.find((hit) => hit.kind === "journal")!.journalDate?.startsWith("2026-10"), true);
  assert.equal((await search(dated, { query: "topic", limit: 20 })).total, 6, "no inferred date filter without explicit parameters");
  await assert.rejects(search(dated, { query: "topic", dateFrom: "2026-02-30" }), /date range/u);
  const limited = await search(dated, { query: "topic", kinds: ["journal"], excludePaths: [dated[0].vaultRelativePath], limit: 20 });
  assert.equal(limited.coverage.scannedFiles, 4);
  assert.ok(limited.hits.every((hit) => hit.kind === "journal" && hit.vaultRelativePath !== dated[0].vaultRelativePath));

  const readCounts = new Map<string, number>();
  let inRead = false;
  const sequential = Array.from({ length: 32 }, (_, index) => note(`read-${index}.md`, "", { read: async () => {
    assert.equal(inRead, false, "body reads remain sequential");
    inRead = true;
    await Promise.resolve();
    readCounts.set(String(index), (readCounts.get(String(index)) ?? 0) + 1);
    inRead = false;
    return { content: "needle", contentRevision: String(index) };
  } }));
  let uiTaskRan = false;
  await withCheckpointTask(() => { uiTaskRan = true; }, () => search(sequential, { query: "needle" }));
  assert.equal(uiTaskRan, true, "scan checkpoints execute a real task");
  assert.equal(readCounts.size, 32);
  assert.ok([...readCounts.values()].every((count) => count === 1));
  const failure = await search([note("good.md", "needle"), note("bad.md", "", { read: async () => { throw new Error("unreadable"); } })], { query: "needle" });
  assert.equal(failure.hits.length, 1);
  assert.deepEqual(failure.coverage, { totalFiles: 2, scannedFiles: 1, readFiles: 2, cachedFiles: 0, indexedFiles: 1, failedFiles: 1, complete: false, unknownJournalDates: 0 });
  const before = new AbortController();
  before.abort();
  await assert.rejects(search(sequential, { query: "needle", signal: before.signal }), { name: "AbortError" });
  const duringRead = new AbortController();
  await assert.rejects(search([note("abort.md", "", { read: async () => {
    duringRead.abort();
    return { content: "needle", contentRevision: "abort" };
  } })], { query: "needle", signal: duringRead.signal }), { name: "AbortError" });
  const readAbort = new Error("reader cancelled");
  readAbort.name = "AbortError";
  await assert.rejects(search([note("abort-error.md", "", { read: async () => { throw readAbort; } })], { query: "needle" }), { name: "AbortError" });
  const duringScan = new AbortController();
  await withCheckpointTask(() => duringScan.abort(), async () => {
    await assert.rejects(search(sequential, { query: "needle", signal: duringScan.signal }), { name: "AbortError" });
  });
  const longCancellation = new AbortController();
  let laterFileRead = false;
  await withCheckpointTask(() => longCancellation.abort(), async () => {
    await assert.rejects(search([
      note("huge-section.md", "large background ".repeat(12_000)),
      note("later.md", "", { read: async () => { laterFileRead = true; return { content: "needle", contentRevision: "later" }; } }),
    ], { query: "needle", signal: longCancellation.signal }), { name: "AbortError" });
  });
  assert.equal(laterFileRead, false, "a single long section yields before scanning the next file");

  let currentBody = "old wording";
  let currentAlias = "old alias";
  const changing = () => note("changing.md", currentBody, { aliases: [currentAlias] });
  assert.equal((await search([changing()], { query: "old alias" })).total, 1);
  currentBody = "new wording";
  currentAlias = "new alias";
  assert.equal((await search([changing()], { query: "new alias" })).total, 1);
  assert.equal((await search([changing()], { query: "old alias" })).total, 0, "metadata and body are not cached between searches");
  console.log("Knowledge body search core: tokenization, evidence, RRF, dates, coverage and cancellation PASS; broad-query ranking check follows");
  assert.ok(partialTopicRank >= 0 && partialTopicRank < 3, "a two-character topic in a longer title remains ahead of incidental conversational words");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function runKnowledgeBodySearchCacheTests(): Promise<void> {
  const reads = new Map<string, number>();
  let revision = "v1";
  let body = "# 章节\nbodymark alpha 2.6.2 莫干山知识库。\n## 后半章\nbeta 的答案在这里。";
  const document = (path: string, content = body, extra: Partial<BodySearchDocument> = {}) => {
    const observedRevision = revision;
    return note(path, content, {
    title: "共同标题", revisionKey: observedRevision,
    read: async () => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return { content, contentRevision: `${path}:${observedRevision}:${content.length}` };
    }, ...extra,
    });
  };
  const documents = [document("folder/a.md"), document("folder/b.md"), document("other/c.md")];
  const index = new BodySearchMemoryIndex();
  const baseline = await search(documents, { query: "alpha" });
  const cold = await index.search({ documents, request: { query: "alpha" } });
  assert.deepEqual(cold.hits, baseline.hits);
  assert.equal(cold.total, baseline.total);
  assert.deepEqual(cold.coverage, { totalFiles: 3, scannedFiles: 3, readFiles: 3, cachedFiles: 0, indexedFiles: 3,
    failedFiles: 0, complete: true, unknownJournalDates: 0 });
  const warm = await index.search({ documents, request: { query: "alpha" } });
  assert.deepEqual(warm.hits, baseline.hits);
  assert.deepEqual(warm.coverage, { ...cold.coverage, scannedFiles: 0, readFiles: 0, cachedFiles: 3 });
  const beforeWarmReads = [...reads.values()].reduce((sum, count) => sum + count, 0);
  for (const request of [{ query: "beta" }, { query: "莫干" }, { query: "2.6.2" }, { queries: ["alpha", "beta"] }, { query: "alpha", offset: 1, limit: 1 }]) {
    const expected = await search(documents, request);
    const actual = await index.search({ documents, request });
    assert.deepEqual(actual.hits, expected.hits, "different queries reuse complete statistics without changing scores or positions");
    assert.equal(actual.total, expected.total);
    assert.equal(actual.coverage.readFiles, 0);
    assert.equal(actual.coverage.cachedFiles, 3);
  }
  assert.equal([...reads.values()].reduce((sum, count) => sum + count, 0), beforeWarmReads + 15, "only the five one-shot comparison scans read bodies");

  const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  const OriginalSegmenter = (Intl as typeof Intl & { Segmenter?: new (...args: any[]) => { segment(text: string): unknown } }).Segmenter;
  if (OriginalSegmenter) {
    let bodyTokenizations = 0;
    class ObservedSegmenter {
      private readonly inner: { segment(text: string): unknown };
      constructor(...args: any[]) { this.inner = new OriginalSegmenter!(...args); }
      segment(text: string) {
        if (text.includes("bodymark")) bodyTokenizations++;
        return this.inner.segment(text);
      }
    }
    try {
      Object.defineProperty(Intl, "Segmenter", { configurable: true, value: ObservedSegmenter });
      const tokenIndex = new BodySearchMemoryIndex();
      await tokenIndex.search({ documents, request: { query: "alpha" } });
      const coldTokenizations = bodyTokenizations;
      assert.ok(coldTokenizations > 0);
      await tokenIndex.search({ documents, request: { query: "beta" } });
      assert.equal(bodyTokenizations, coldTokenizations, "warm changes of query do not tokenize cached body text again");
      tokenIndex.dispose();
    } finally {
      if (segmenterDescriptor) Object.defineProperty(Intl, "Segmenter", segmenterDescriptor);
    }
  }

  revision = "v2";
  body = "# 章节\nchanged alpha 答案。";
  const changed = [document("folder/a.md"), documents[1], documents[2]];
  const modified = await index.search({ documents: changed, request: { query: "alpha" } });
  assert.equal(modified.coverage.readFiles, 1);
  assert.equal(modified.coverage.cachedFiles, 2);
  assert.deepEqual(modified.hits, (await search(changed, { query: "alpha" })).hits);
  index.invalidate("folder");
  const directoryInvalidation = await index.search({ documents: changed, request: { query: "alpha" } });
  assert.equal(directoryInvalidation.coverage.readFiles, 2);
  assert.equal(directoryInvalidation.coverage.cachedFiles, 1);
  const deleted = changed.slice(1);
  assert.equal((await index.search({ documents: deleted, request: { query: "alpha" } })).coverage.readFiles, 0);
  const renamed = [document("folder/renamed.md", body), changed[2]];
  const afterRename = await index.search({ documents: renamed, request: { query: "alpha" } });
  assert.equal(afterRename.coverage.readFiles, 1);
  assert.equal(afterRename.coverage.cachedFiles, 1);
  const added = [...renamed, document("new.md", body)];
  assert.equal((await index.search({ documents: added, request: { query: "alpha" } })).coverage.readFiles, 1);
  const scope = await index.search({ documents: added, request: { query: "alpha", excludePaths: ["new.md"], kinds: ["notes"] } });
  assert.equal(scope.coverage.totalFiles, 2);
  assert.equal(scope.coverage.cachedFiles, 2);
  assert.deepEqual(scope.hits, (await search(added, { query: "alpha", excludePaths: ["new.md"], kinds: ["notes"] })).hits);
  const metadata = [document("folder/renamed.md", body, { aliases: ["新专名"], tags: ["新增标签"] }), changed[2]];
  const changedDictionary = await index.search({ documents: metadata, request: { query: "新专名" } });
  assert.equal(changedDictionary.coverage.readFiles, 2, "new metadata words replace the single dictionary view");
  assert.deepEqual(changedDictionary.hits, (await search(metadata, { query: "新专名" })).hits);
  const updatedTitle = [document("folder/renamed.md", body, { title: "另一标题", aliases: ["新专名"], tags: ["新增标签"] }), changed[2]];
  assert.equal((await index.search({ documents: updatedTitle, request: { query: "alpha" } })).coverage.readFiles, 2);
  index.clear();
  assert.equal((await index.search({ documents: updatedTitle, request: { query: "alpha" } })).coverage.readFiles, 2);
  const unversioned = documents.map((entry) => ({ ...entry, revisionKey: undefined }));
  const noVersion = new BodySearchMemoryIndex();
  await noVersion.search({ documents: unversioned, request: { query: "alpha" } });
  assert.equal((await noVersion.search({ documents: unversioned, request: { query: "beta" } })).coverage.cachedFiles, 0);

  const longContent = `${"背景📌材料。".repeat(1500)}尾部金丝雀答案。`;
  const longDocuments = [document("long.md", longContent)];
  const longIndex = new BodySearchMemoryIndex();
  const longCold = await longIndex.search({ documents: longDocuments, request: { query: "金丝雀答案" } });
  const longWarm = await longIndex.search({ documents: longDocuments, request: { query: "金丝雀答案" } });
  assert.deepEqual(longCold.hits, (await search(longDocuments, { query: "金丝雀答案" })).hits);
  assert.deepEqual(longWarm.hits, longCold.hits, "warm reads retain exact UTF-16 columns and excerpts");

  let failOnce = true;
  const retryIndex = new BodySearchMemoryIndex();
  const unreliable = [documents[0], document("failure.md", "alpha", { read: async () => {
    if (failOnce) { failOnce = false; throw new Error("one read failed"); }
    return { content: "alpha", contentRevision: "retry" };
  } })];
  const partial = await retryIndex.search({ documents: unreliable, request: { query: "alpha" } });
  assert.equal(partial.coverage.complete, false);
  assert.equal(partial.coverage.indexedFiles, 1);
  assert.equal(partial.coverage.failedFiles, 1);
  const retry = await retryIndex.search({ documents: unreliable, request: { query: "alpha" } });
  assert.equal(retry.coverage.readFiles, 2, "a failed search did not publish its partial staged build");
  assert.equal(retry.coverage.complete, true);
  assert.equal((await retryIndex.search({ documents: unreliable, request: { query: "alpha" } })).coverage.cachedFiles, 2);

  const entered = deferred<void>();
  const release = deferred<void>();
  const abortIndex = new BodySearchMemoryIndex();
  const abort = new AbortController();
  let block = true;
  const interruptible = [documents[0], document("blocked.md", "alpha", { read: async () => {
    if (block) { entered.resolve(); await release.promise; }
    return { content: "alpha", contentRevision: "blocked" };
  } })];
  const interrupted = abortIndex.search({ documents: interruptible, request: { query: "alpha", signal: abort.signal } });
  await entered.promise;
  abort.abort(); block = false; release.resolve();
  await assert.rejects(interrupted, { name: "AbortError" });
  assert.equal((await abortIndex.search({ documents: interruptible, request: { query: "alpha" } })).coverage.readFiles, 2);

  const invalidationIndex = new BodySearchMemoryIndex();
  await invalidationIndex.search({ documents, request: { query: "alpha" } });
  invalidationIndex.invalidate("folder/a.md");
  const invalidatedRead = deferred<void>();
  const oldReadReleased = deferred<void>();
  const invalidatedDocuments = [document("folder/a.md", "alpha", { read: async () => {
    invalidatedRead.resolve(); await oldReadReleased.promise;
    return { content: "alpha old snapshot", contentRevision: "old" };
  } }), documents[1], documents[2]];
  const stale = invalidationIndex.search({ documents: invalidatedDocuments, request: { query: "alpha" } });
  await invalidatedRead.promise;
  invalidationIndex.invalidate("folder");
  oldReadReleased.resolve();
  await assert.rejects(stale, { code: "search_index_stale" });
  const freshAfterEvent = await invalidationIndex.search({ documents: changed, request: { query: "alpha" } });
  assert.equal(freshAfterEvent.coverage.readFiles, 2, "real file/directory invalidation cannot let an old in-flight read refill the index");
  assert.equal(freshAfterEvent.coverage.cachedFiles, 1);
  assert.ok(freshAfterEvent.hits.every((hit) => hit.contentRevision !== "old"));

  const concurrent = new BodySearchMemoryIndex();
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  const firstAbort = new AbortController();
  let firstCall = true;
  const parallelDocuments = [document("parallel.md", "alpha beta", { read: async () => {
    if (firstCall) { firstCall = false; firstEntered.resolve(); await releaseFirst.promise; }
    return { content: "alpha beta", contentRevision: "parallel" };
  } })];
  const firstSearch = concurrent.search({ documents: parallelDocuments, request: { query: "alpha", signal: firstAbort.signal } });
  await firstEntered.promise;
  const secondSearch = await concurrent.search({ documents: parallelDocuments, request: { query: "beta" } });
  assert.equal(secondSearch.coverage.complete, true);
  firstAbort.abort(); releaseFirst.resolve();
  await assert.rejects(firstSearch, { name: "AbortError" });
  assert.equal((await concurrent.search({ documents: parallelDocuments, request: { query: "alpha" } })).coverage.cachedFiles, 1, "one query's cancellation does not cancel or discard another's completed build");

  for (const limits of [{ maxCachedCharacters: 1 }, { maxCachedTokenEntries: 1 }, { maxCachedDocuments: 0 }]) {
    const bounded = new BodySearchMemoryIndex(limits);
    await bounded.search({ documents, request: { query: "alpha" } });
    const boundedWarm = await bounded.search({ documents, request: { query: "beta" } });
    assert.equal(boundedWarm.coverage.readFiles, 3);
    assert.equal(boundedWarm.coverage.complete, true);
    assert.deepEqual(boundedWarm.hits, (await search(documents, { query: "beta" })).hits, "memory limits restrict retention, never coverage or results");
    bounded.dispose();
  }
  const oneDocument = new BodySearchMemoryIndex({ maxCachedDocuments: 1 });
  await oneDocument.search({ documents, request: { query: "alpha" } });
  const oneWarm = await oneDocument.search({ documents, request: { query: "alpha" } });
  assert.equal(oneWarm.coverage.cachedFiles, 1);
  assert.equal(oneWarm.coverage.readFiles, 2);

  const disposed = new BodySearchMemoryIndex();
  const disposeEntered = deferred<void>();
  const releaseDisposed = deferred<void>();
  const disposing = disposed.search({ documents: [document("dispose.md", "alpha", { read: async () => {
    disposeEntered.resolve(); await releaseDisposed.promise;
    return { content: "alpha", contentRevision: "disposed" };
  } })], request: { query: "alpha" } });
  await disposeEntered.promise;
  disposed.dispose(); releaseDisposed.resolve();
  await assert.rejects(disposing, { code: "search_index_disposed" });
  disposed.clear(); disposed.invalidate("folder");
  await assert.rejects(disposed.search({ documents, request: { query: "alpha" } }), { code: "search_index_disposed" });
  for (const item of [index, noVersion, longIndex, retryIndex, abortIndex, invalidationIndex, concurrent, oneDocument]) item.dispose();
  console.log("Knowledge body search cache: cold/warm equivalence, complete reuse, revisions, events, cancellation, limits and disposal PASS");
}

export async function runKnowledgeBodySearchSchedulingTests(): Promise<void> {
  const schedulerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "scheduler");
  const channelDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MessageChannel");
  const timerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
  const nativeTimer = globalThis.setTimeout;
  const NativeChannel = globalThis.MessageChannel;
  assert.equal(typeof NativeChannel, "function", "the Node test host supplies real MessageChannel tasks");
  const activeHandles = () => (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles();
  const previousHandles = new Set(activeHandles());
  const channels: { ports: MessagePort[]; closeCalls: number }[] = [];
  let timerCalls = 0;
  let afterMessage: (() => void) | undefined;
  let postFailure = false;
  const setGlobal = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const trackedTimer = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    timerCalls++;
    return nativeTimer(callback, delay, ...args);
  };
  class TrackedChannel {
    readonly port1;
    readonly port2;
    constructor() {
      const channel = new NativeChannel();
      const record = { ports: [channel.port1, channel.port2], closeCalls: 0 };
      channels.push(record);
      const wrap = (port: MessagePort, receiving: boolean) => ({
        get onmessage() { return port.onmessage; },
        set onmessage(handler) {
          port.onmessage = handler && ((event) => {
            handler.call(port, event);
            if (receiving) afterMessage?.();
          });
        },
        get onmessageerror() { return port.onmessageerror; },
        set onmessageerror(handler) { port.onmessageerror = handler; },
        postMessage(value: unknown) {
          if (postFailure) throw new Error("post failed");
          port.postMessage(value);
        },
        close() { record.closeCalls++; port.close(); },
      });
      this.port1 = wrap(channel.port1, true);
      this.port2 = wrap(channel.port2, false);
    }
  }
  const assertReleased = () => {
    for (const channel of channels) {
      assert.equal(channel.closeCalls, 2, "every channel closes both ports exactly once");
      for (const port of channel.ports) {
        assert.equal(port.onmessage, null);
        assert.equal(port.onmessageerror, null);
      }
    }
  };
  const trackAbortListeners = (signal: AbortSignal) => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    Object.defineProperty(signal, "addEventListener", { value: (type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
      if (type === "abort") listeners.add(listener);
      add(type, listener, options);
    } });
    Object.defineProperty(signal, "removeEventListener", { value: (type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
      if (type === "abort") listeners.delete(listener);
      remove(type, listener, options);
    } });
    return listeners;
  };
  try {
    setGlobal("setTimeout", trackedTimer);
    setGlobal("MessageChannel", TrackedChannel);
    let schedulerCalls = 0;
    let realTaskRan = false;
    const scheduler = { yield() {
      assert.equal(this, scheduler, "scheduler.yield retains its host receiver");
      schedulerCalls++;
      return new Promise<void>((resolve) => nativeTimer(() => { realTaskRan = true; resolve(); }, 0));
    } };
    setGlobal("scheduler", scheduler);
    const completedSignal = new AbortController();
    const completedListeners = trackAbortListeners(completedSignal.signal);
    let finished = false;
    const preferred = yieldSearchTask(completedSignal.signal).then(() => { finished = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(finished, false, "microtasks alone cannot complete the preferred task wait");
    assert.equal(realTaskRan, false);
    await preferred;
    assert.equal(realTaskRan, true);
    assert.equal(schedulerCalls, 1);
    assert.equal(channels.length, 0);
    assert.equal(timerCalls, 0, "a successful scheduler does not start a fallback timer");
    assert.equal(completedListeners.size, 0);

    const before = new AbortController(); before.abort();
    await assert.rejects(yieldSearchTask(before.signal), { name: "AbortError" });
    assert.equal(schedulerCalls, 1, "already cancelled work starts no task");

    for (const failure of ["throw", "reject"] as const) {
      setGlobal("scheduler", { yield() {
        if (failure === "throw") throw new Error("scheduler unavailable");
        return new Promise<void>((_resolve, reject) => nativeTimer(() => reject(new Error("scheduler rejected")), 0));
      } });
      const previousChannels = channels.length;
      await yieldSearchTask();
      assert.equal(channels.length, previousChannels + 1, "scheduler exceptions and rejections fall back to a real message task");
      assert.equal(timerCalls, 0);
      assertReleased();
    }

    setGlobal("scheduler", undefined);
    finished = false;
    const messageTask = yieldSearchTask().then(() => { finished = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(finished, false, "MessageChannel completion requires its real posted task");
    await messageTask;
    assertReleased();

    const duringMessage = new AbortController();
    const messageListeners = trackAbortListeners(duringMessage.signal);
    const cancelledMessage = yieldSearchTask(duringMessage.signal);
    duringMessage.abort();
    await assert.rejects(cancelledMessage, { name: "AbortError" });
    assert.equal(messageListeners.size, 0);
    assertReleased();

    const afterMessageController = new AbortController();
    afterMessage = () => afterMessageController.abort();
    await assert.rejects(yieldSearchTask(afterMessageController.signal), { name: "AbortError" });
    afterMessage = undefined;
    assertReleased();

    const independentAbort = new AbortController();
    const independentSuccess = new AbortController();
    const first = yieldSearchTask(independentAbort.signal);
    const second = yieldSearchTask(independentSuccess.signal);
    independentAbort.abort();
    await assert.rejects(first, { name: "AbortError" });
    await second;
    assert.equal(independentSuccess.signal.aborted, false);
    assertReleased();

    let lateReject!: (error: Error) => void;
    setGlobal("scheduler", { yield() { return new Promise<void>((_resolve, reject) => { lateReject = reject; }); } });
    const duringScheduler = new AbortController();
    const schedulerListeners = trackAbortListeners(duringScheduler.signal);
    const cancelledScheduler = yieldSearchTask(duringScheduler.signal);
    duringScheduler.abort();
    await assert.rejects(cancelledScheduler, { name: "AbortError" });
    lateReject(new Error("late rejection is consumed after cancellation"));
    await new Promise<void>((resolve) => nativeTimer(resolve, 0));
    assert.equal(schedulerListeners.size, 0);
    const afterScheduler = new AbortController();
    setGlobal("scheduler", { yield() { return new Promise<void>((resolve) => nativeTimer(() => { resolve(); afterScheduler.abort(); }, 0)); } });
    await assert.rejects(yieldSearchTask(afterScheduler.signal), { name: "AbortError" });

    setGlobal("scheduler", undefined);
    postFailure = true;
    const timersBeforePostFailure = timerCalls;
    await yieldSearchTask();
    postFailure = false;
    assert.equal(timerCalls, timersBeforePostFailure + 1, "posting failures release both ports before timer fallback");
    assertReleased();
    for (const Constructor of [undefined, class { constructor() { throw new Error("channel construction failed"); } }]) {
      setGlobal("MessageChannel", Constructor);
      const timersBefore = timerCalls;
      finished = false;
      const timerTask = yieldSearchTask().then(() => { finished = true; });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(finished, false, "old WebViews still yield to a real timer task");
      await timerTask;
      assert.equal(timerCalls, timersBefore + 1);
    }
    setGlobal("MessageChannel", undefined);
    const duringTimer = new AbortController();
    const timerListeners = trackAbortListeners(duringTimer.signal);
    const cancelledTimer = yieldSearchTask(duringTimer.signal);
    await Promise.resolve();
    duringTimer.abort();
    await assert.rejects(cancelledTimer, { name: "AbortError" });
    assert.equal(timerListeners.size, 0);
    const afterTimer = new AbortController();
    setGlobal("setTimeout", (callback: () => void, delay?: number) => nativeTimer(() => { callback(); afterTimer.abort(); }, delay));
    await assert.rejects(yieldSearchTask(afterTimer.signal), { name: "AbortError" });
    setGlobal("setTimeout", trackedTimer);

    let readFiles = 0;
    const oldWebViewDocuments = Array.from({ length: 32 }, (_, index) => note(`old-webview-${index}.md`, "", { read: async () => {
      readFiles++;
      return { content: "needle", contentRevision: String(index) };
    } }));
    const oldWebView = await search(oldWebViewDocuments, { query: "needle", limit: 50 });
    assert.equal(oldWebView.coverage.indexedFiles, 32);
    assert.equal(oldWebView.coverage.complete, true);
    assert.equal(readFiles, 32);
    const oldWebViewAbort = new AbortController();
    const abortTimer = nativeTimer(() => oldWebViewAbort.abort(), 0);
    readFiles = 0;
    await assert.rejects(search(oldWebViewDocuments, { query: "needle", signal: oldWebViewAbort.signal }), { name: "AbortError" });
    clearTimeout(abortTimer);
    assert.ok(readFiles > 0 && readFiles < 32, "legacy timer fallback keeps scan checkpoints cancellable");
    assertReleased();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(activeHandles().filter(handle => !previousHandles.has(handle) && handle.constructor.name === "MessagePort"), [], "no new active MessagePort handles remain");
  } finally {
    afterMessage = undefined;
    for (const channel of channels) for (const port of channel.ports) port.close();
    for (const [name, descriptor] of [["scheduler", schedulerDescriptor], ["MessageChannel", channelDescriptor], ["setTimeout", timerDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  console.log("Knowledge body search scheduling: real tasks, fallback priority, independent cancellation and released ports PASS");
}

export async function runKnowledgeBodySearchInvalidationTests(): Promise<void> {
  const memory = new BodySearchMemoryIndex();
  const firstEntered = deferred<void>(), firstReleased = deferred<void>();
  const unrelatedEntered = deferred<void>(), unrelatedReleased = deferred<void>();
  const firstDocuments = [note("area/a.md", "", { title: "共同标题", revisionKey: "a1", read: async () => {
    firstEntered.resolve(); await firstReleased.promise;
    return { content: "alpha", contentRevision: "a1" };
  } })];
  const unrelatedDocuments = [note("area-other/b.md", "", { title: "共同标题", revisionKey: "b1", read: async () => {
    unrelatedEntered.resolve(); await unrelatedReleased.promise;
    return { content: "beta", contentRevision: "b1" };
  } })];
  const first = memory.search({ documents: firstDocuments, request: { query: "alpha" } });
  await firstEntered.promise;
  const unrelated = memory.search({ documents: unrelatedDocuments, request: { query: "beta" } });
  await unrelatedEntered.promise;
  memory.invalidate("private/memory.md");
  memory.invalidate("area");
  unrelatedReleased.resolve();
  const unaffected = await unrelated;
  assert.equal(unaffected.coverage.complete, true, "a directory event only invalidates requests whose eligible paths intersect it");
  firstReleased.resolve();
  await assert.rejects(first, { code: "search_index_stale" });
  assert.equal((await memory.search({ documents: unrelatedDocuments, request: { query: "beta" } })).coverage.cachedFiles, 1);
  memory.dispose();

  const bindings = emptyKnowledgeFolderBindings();
  bindings.roles.journal.enabled = true; bindings.roles.journal.readPaths = ["日记"];
  bindings.roles.templates.enabled = true; bindings.roles.templates.readPaths = ["模板"];
  bindings.roles.projects.enabled = false; bindings.roles.projects.readPaths = ["项目"];
  const excludedRoots = ["私有"];
  const bodies = new Map([
    ["普通/A.md", "# A\nneedle ALPHA"], ["普通/B.md", "# B\nneedle BETA"],
    ["日记/2026-10-01.md", "# 日记\nneedle JOURNAL"],
    ["私有/Memory.md", "needle"], ["模板/计划.md", "needle"], ["项目/关闭.md", "needle"],
  ]);
  let journalPause: (() => Promise<void>) | undefined;
  let readPause: ((path: string) => Promise<void>) | undefined;
  const file = (path: string) => ({ path, basename: path.split("/").at(-1)!.slice(0, -3), extension: "md",
    stat: { mtime: 1, size: bodies.get(path)?.length ?? 0 } }) as TFile;
  const app = { vault: {
    getMarkdownFiles: () => [...bodies.keys()].map(file),
    getAbstractFileByPath: (path: string) => bodies.has(path) ? file(path) : null,
    read: async (source: TFile) => {
      const content = bodies.get(source.path);
      await readPause?.(source.path);
      if (content === undefined) throw new Error("gone");
      return content;
    },
  }, metadataCache: { getFileCache: () => null } } as unknown as App;
  const port = new VaultBodySearch(app, () => bindings, { excludedRoots: () => excludedRoots, onJournalSearch: () => journalPause?.() });
  try {
    for (const path of ["私有/Memory.md", "模板/计划.md", "项目/关闭.md", ".echoink/state.md"]) {
      assert.equal(knowledgeSearchPathKind(path, bindings, excludedRoots), null);
    }
    const original = await port.search({ query: "needle", limit: 1 });
    assert.ok(original.continuationCursor);
    const noticeEntered = deferred<void>(), noticeReleased = deferred<void>();
    journalPause = async () => { noticeEntered.resolve(); await noticeReleased.promise; };
    const freshQuery = port.search({ query: "needle", limit: 1 });
    await noticeEntered.promise;
    for (const path of ["私有/Memory.md", "私有", "模板/计划.md", "模板", "项目/关闭.md", "项目", ".echoink/state.md"]) port.invalidate(path);
    noticeReleased.resolve();
    const freshResult = await freshQuery;
    journalPause = undefined;
    assert.equal(freshResult.generation, original.generation, "excluded file/folder events cannot turn a fresh query into a stale snapshot");
    const continuation = await port.search({ query: "needle", limit: 1, cursor: original.continuationCursor });
    assert.equal(continuation.generation, original.generation, "unrelated events also preserve valid old cursors");

    const readEntered = deferred<void>(), readReleased = deferred<void>();
    readPause = async path => { if (path === "普通/A.md") { readEntered.resolve(); await readReleased.promise; } };
    const pendingRead = port.read({ vaultRelativePath: "普通/A.md" });
    await readEntered.promise;
    port.invalidate("私有/Memory.md");
    port.invalidate("日记/2026-10-01.md");
    readReleased.resolve();
    assert.match((await pendingRead).content, /ALPHA/u, "reading one source is not invalidated by an event on another searchable source");
    readPause = undefined;
    await assert.rejects(port.search({ query: "needle", limit: 1, cursor: original.continuationCursor }), { code: "cursor_stale" });

    const changedEntered = deferred<void>(), changedReleased = deferred<void>();
    journalPause = async () => { changedEntered.resolve(); await changedReleased.promise; };
    const changedQuery = port.search({ query: "needle" });
    await changedEntered.promise;
    port.invalidate("普通/A.md");
    changedReleased.resolve();
    await assert.rejects(changedQuery, { code: "source_changed" }, "a genuine event during a query without a cursor is a source change, never a cursor error");
    journalPause = undefined;

    for (const eventPath of ["普通/A.md", "普通", undefined]) {
      const entered = deferred<void>(), released = deferred<void>();
      readPause = async path => { if (path === "普通/A.md") { entered.resolve(); await released.promise; } };
      const reading = port.read({ vaultRelativePath: "普通/A.md" });
      await entered.promise; port.invalidate(eventPath); released.resolve();
      await assert.rejects(reading, { code: "source_changed" });
      readPause = undefined;
    }

    const prior = await port.read({ vaultRelativePath: "普通/A.md" });
    port.invalidate();
    const modifyingEntered = deferred<void>(), modifyingReleased = deferred<void>();
    readPause = async path => { if (path === "普通/A.md") { modifyingEntered.resolve(); await modifyingReleased.promise; } };
    const modifying = port.search({ query: "needle" });
    await modifyingEntered.promise;
    bodies.set("普通/A.md", "# A\nneedle OMEGA");
    port.invalidate("普通/A.md");
    modifyingReleased.resolve();
    await assert.rejects(modifying, { code: "source_changed" });
    readPause = undefined;
    const latest = await port.search({ query: "OMEGA" });
    assert.equal(latest.hits[0].vaultRelativePath, "普通/A.md");
    assert.notEqual(latest.hits[0].contentRevision, prior.contentRevision, "same-mtime/same-size modify still rejects the old source revision");

    const beforeDelete = await port.search({ query: "needle", limit: 1 });
    bodies.delete("普通/A.md"); bodies.delete("普通/B.md");
    port.invalidate("普通");
    const afterDelete = await port.search({ query: "needle" });
    assert.ok(afterDelete.generation > beforeDelete.generation, "a deleted directory remains relevant through its observed allowed descendants");
    assert.ok(afterDelete.hits.every(hit => !hit.vaultRelativePath.startsWith("普通/")));
    await assert.rejects(port.search({ query: "needle", limit: 1, cursor: beforeDelete.continuationCursor }), { code: "cursor_stale" });
  } finally { port.dispose(); }
  console.log("Knowledge body search invalidation: effective paths, independent reads, source-change protocol and cursor protection PASS");
}

export async function runKnowledgeBodySearchConcurrencyTests(): Promise<void> {
  const documents = [
    note("普通/陶艺.md", "# 陶艺\nalpha beta gamma", { title: "陶艺安排", revisionKey: "a1" }),
    note("知识/湿地.md", "# 湿地\nalpha beta gamma", { title: "湿地观察", kind: "wiki", revisionKey: "b1" }),
    note("日记/2026-10-01.md", "# 日记\nalpha beta gamma", { kind: "journal", revisionKey: "c1" }),
  ];
  const requests: BodySearchRequest[] = [{ query: "alpha" }, { query: "beta", kinds: ["wiki"] }, { query: "gamma", kinds: ["journal"] }];
  const expected = await Promise.all(requests.map(request => search(documents, request)));
  for (const warm of [false, true]) {
    const index = new BodySearchMemoryIndex();
    if (warm) await index.search({ documents, request: requests[0] });
    const actual = await Promise.all(requests.map(request => index.search({ documents, request })));
    actual.forEach((result, index) => {
      assert.equal(result.coverage.complete, true);
      assert.deepEqual(result.hits, expected[index].hits, "independent dictionary views cannot change results or invalidate another live request");
    });
    const lastView = await index.search({ documents, request: requests[2] });
    assert.equal(lastView.coverage.readFiles, 0, "only the latest view publishes, even when older views finish afterwards");
    assert.equal(lastView.coverage.cachedFiles, 1);
    index.dispose();
  }

  const released = deferred<void>();
  const blocked = documents.map(document => ({ ...document, read: async () => { await released.promise; return document.read(); } }));
  const cancelled = new AbortController();
  const cancelIndex = new BodySearchMemoryIndex();
  const pending = requests.map((request, index) => cancelIndex.search({ documents: blocked, request: { ...request, ...(index === 0 ? { signal: cancelled.signal } : {}) } }));
  cancelled.abort(); released.resolve();
  const cancelledResults = await Promise.allSettled(pending);
  assert.equal(cancelledResults[0].status, "rejected");
  if (cancelledResults[0].status === "rejected") assert.equal(cancelledResults[0].reason.name, "AbortError");
  assert.equal(cancelledResults[1].status, "fulfilled");
  assert.equal(cancelledResults[2].status, "fulfilled");
  cancelIndex.dispose();

  for (const metadataChange of [false, true]) {
    const index = new BodySearchMemoryIndex();
    const entered = deferred<void>(), release = deferred<void>();
    const older = [{ ...documents[0], read: async () => { entered.resolve(); await release.promise; return documents[0].read(); } }];
    const oldSearch = index.search({ documents: older, request: { query: "alpha" } });
    await entered.promise;
    const newer = [{ ...documents[0], ...(metadataChange ? { aliases: ["new alias"] } : { revisionKey: "a2" }) }];
    const fresh = await index.search({ documents: newer, request: { query: "alpha" } });
    assert.equal(fresh.coverage.complete, true);
    release.resolve();
    await assert.rejects(oldSearch, { code: "search_index_stale" }, "a newly observed body/metadata revision remains a real invalidation");
    assert.equal((await index.search({ documents: newer, request: { query: "alpha" } })).coverage.cachedFiles, 1);
    index.dispose();
  }

  const cleared = new BodySearchMemoryIndex();
  const clearEntered = deferred<void>(), clearRelease = deferred<void>();
  const clearing = cleared.search({ documents: [{ ...documents[0], read: async () => { clearEntered.resolve(); await clearRelease.promise; return documents[0].read(); } }], request: { query: "alpha" } });
  await clearEntered.promise; cleared.clear(); clearRelease.resolve();
  await assert.rejects(clearing, { code: "search_index_stale" }, "explicit clear still invalidates a live source snapshot");
  cleared.dispose();
  console.log("Knowledge body search concurrency: independent cold/warm views, cancellation, publication and true revisions PASS");
}

export async function runKnowledgeBodySearchTopicTests(): Promise<void> {
  for (const topic of ["光学", "气象", "信息整理"]) {
    const documents = [
      note("subject.md", `# 从观察开始\n${topic}需要结合实际例子理解。`, { title: `${topic}与例子` }),
      note("partial.md", `# 工具箱\n${topic}工具箱保存了示意图。`, { title: `${topic}工具箱` }),
      note("notes.md", "# 手工\n我写了笔记。"),
      note("about.md", "# 河流\n关于河流，另有一张地图。"),
      note("which.md", "# 云朵\n哪些变化需要留下来？"),
      ...Array.from({ length: 15 }, (_, i) => note(`background-${i}.md`, "# 其他\n将门框尺寸写在纸上，再去选木料。")),
    ];
    for (const query of [`我关于${topic}的笔记有哪些？`, `我 关于 ${topic} 的 笔记 有哪些 ？`, `有关${topic}的资料有哪些。`, `关于${topic}的记录!`]) {
      const result = await search(documents, { query });
      const rank = result.hits.findIndex(hit => hit.vaultRelativePath === "subject.md");
      assert.ok(rank >= 0 && rank < 3, "a requested topic outranks the lookup wording across unrelated subject names");
      assert.ok(result.hits.some(hit => hit.vaultRelativePath === "partial.md"), "topic grammar preserves partial matches inside longer names");
    }
  }
  const framedName = "关于光学的笔记";
  const named = await search([
    note("a.md", "some evidence", { title: framedName }),
    note("b.md", "some evidence", { title: "ordinary", aliases: [framedName] }),
    note("topic.md", "# 光学\n光学需要先画光路。", { title: "光学" }),
  ], { query: framedName });
  assert.deepEqual(new Set(named.hits.slice(0, 2).map(hit => hit.vaultRelativePath)), new Set(["a.md", "b.md"]), "an exact full title/alias that resembles query grammar is not reduced to its inner topic");
  assert.equal(named.hits[0].score, named.hits[1].score);
  const precise = [
    note("alias-version.md", "# 决定\n草稿采用离线格式。", { title: "方案说明", aliases: ["PKM 4.8.1"] }),
    note("other-version.md", "# 旧稿\nPKM 4.8.0 是旧方案。"),
    note("mountain.md", "# 路线\n莫干山徒步路线从山脚开始。", { title: "莫干山徒步路线" }),
  ];
  assert.equal((await search(precise, { query: "我关于 PKM 4.8.1 的笔记有哪些？" })).hits[0].vaultRelativePath, "alias-version.md");
  assert.equal((await search(precise, { query: "关于4.8.1的记录有哪些？" })).hits[0].vaultRelativePath, "alias-version.md");
  assert.equal((await search(precise, { query: "我关于莫干的资料有哪些？" })).hits[0].vaultRelativePath, "mountain.md");
  const index = new BodySearchMemoryIndex();
  const documents = precise.map(document => ({ ...document, revisionKey: "topic-v1" }));
  try {
    const queries = ["我关于 PKM 4.8.1 的笔记有哪些？", "我关于莫干的资料有哪些？"];
    for (const query of queries) {
      const expected = await search(documents, { query });
      const actual = await index.search({ documents, request: { query } });
      assert.deepEqual(actual.hits, expected.hits);
    }
    assert.equal((await index.search({ documents, request: { query: queries[0] } })).coverage.cachedFiles, 3);
  } finally { index.dispose(); }
  console.log("Knowledge body search topics: generic query framing, exact names, aliases, versions, partial matches and cache equivalence PASS");
}

function boilerplateDevelopmentDocuments(): BodySearchDocument[] {
  return [
    note("field/ecology.md", "# 水塘观察\n生态由水温、食物和鱼群一起影响，先记录各自变化再比较。", { title: "生态与例子" }),
    note("actual/format.md", "# 保存格式\n笔记统一采用 Markdown 格式存储，附件放在同级目录。", { title: "格式约定" }),
    note("noise/phrases.md", "# 短句\n我的笔记记过哪些东西，相关资料与什么方面有关。", { title: "短句摘录" }),
    note("noise/lookup.md", "# 旧页\n关于哪些资料，找一下相关的记录。", { title: "旧页" }),
    ...Array.from({ length: 20 }, (_, i) => note(`background-${i}.md`, "# 背景\n门框尺寸要先测量。")),
  ];
}

/** Pure synthetic inputs; the caller may supply a fixed-source engine for before/after evidence. */
export async function collectKnowledgeBodySearchBoilerplateEvidence(searcher: (options: BodySearchOptions) => Promise<BodySearchResult> = searchBodyDocuments) {
  const documents = boilerplateDevelopmentDocuments();
  const cases = [
    { id: "ecology-reordered", query: "我有哪些关于生态的笔记", targetPath: "field/ecology.md" },
    { id: "ecology-related", query: "生态相关的笔记", targetPath: "field/ecology.md" },
    { id: "ecology-recorded", query: "我记过哪些生态方面的东西", targetPath: "field/ecology.md" },
    { id: "format-development", query: "我的笔记采用什么格式存", targetPath: "actual/format.md" },
  ];
  const rows = [];
  for (const item of cases) {
    const result = await searcher({ documents, request: { query: item.query, limit: 50 } });
    const rank = result.hits.findIndex(hit => hit.vaultRelativePath === item.targetPath);
    const brief = (hit: typeof result.hits[number]) => ({ path: hit.vaultRelativePath, title: hit.title, sectionTitle: hit.sectionTitle,
      lineStart: hit.lineStart, lineEnd: hit.lineEnd, excerpt: hit.excerpt, score: hit.score });
    rows.push({ ...item, targetRank: rank < 0 ? null : rank + 1, target: rank < 0 ? null : brief(result.hits[rank]),
      top: result.hits.slice(0, 5).map(brief), coverage: result.coverage });
  }
  return rows;
}

export async function runKnowledgeBodySearchBoilerplateTests(): Promise<void> {
  const evidence = await collectKnowledgeBodySearchBoilerplateEvidence();
  for (const row of evidence) {
    assert.equal(row.targetRank, 1, "real subject/format evidence leads unrelated question wording in each fixed development case");
    assert.equal(row.top[0].path, row.targetPath);
    assert.equal(row.coverage.complete, true);
  }
  const notesAsTopic = [
    note("subject-notes.md", "# 方法\n笔记应保留原话、时间和可核验的例子。", { title: "笔记方法" }),
    note("unrelated.md", "# 清单\n哪些资料还没有归档？", { title: "清单" }),
  ];
  for (const query of ["笔记", "关于笔记的资料有哪些？"]) {
    const result = await search(notesAsTopic, { query });
    assert.equal(result.hits[0].vaultRelativePath, "subject-notes.md", "notes remains searchable as an actual subject");
    assert.ok(result.hits[0].score > 0);
  }
  const words = ["我", "我的", "关于", "有关", "的", "笔记", "记录", "资料", "文章", "哪些", "什么", "有没有", "找一下", "相关", "方面"];
  const onlyWording = [note("wording.md", words.join("，"), { title: "短句" })];
  for (const query of ["我的笔记", ...words.filter(word => word.length > 1)]) {
    const result = await search(onlyWording, { query });
    assert.ok(result.hits.length > 0 && result.hits[0].score > 0, "boilerplate and derived token/bigram signals retain positive weights");
  }
  const meaningfulFragments = [note("negation.md", "没有", { title: "否定" }), note("pause.md", "一下", { title: "停顿" })];
  const negation = (await search(meaningfulFragments, { query: "没有" })).hits[0];
  const question = (await search(meaningfulFragments, { query: "有没有" })).hits[0];
  assert.equal(negation.vaultRelativePath, "negation.md");
  assert.ok(negation.score > question.score, "a negation outside the complete question phrase is not added to the boilerplate list");
  const pause = (await search(meaningfulFragments, { query: "一下" })).hits[0];
  const lookup = (await search(meaningfulFragments, { query: "找一下" })).hits[0];
  assert.equal(pause.vaultRelativePath, "pause.md");
  assert.ok(pause.score > lookup.score, "a derived fragment is only weakened where its complete listed phrase occurs");
  const names = [
    note("game.md", "# 设置\n游戏设置独立保存。", { title: "我的世界", aliases: ["我的世界"] }),
    note("recorder.md", "# 设备\n设备在通电后保存声音。", { title: "便携记录器", aliases: ["记录器"] }),
    note("version.md", "# 发布\n此版修复了导出换行。", { title: "发布说明", aliases: ["PKM 4.8.1"] }),
    note("framed.md", "some evidence", { title: "关于光学的笔记" }),
    note("framed-alias.md", "some evidence", { title: "ordinary", aliases: ["关于光学的笔记"] }),
    note("noise.md", "# 句子\n我的记录、资料和笔记与什么有关？"),
    note("other-version.md", "# 旧稿\nPKM 4.8.0。"),
  ];
  for (const [query, path] of [
    ["我的世界", "game.md"], ["找一下我的世界相关资料", "game.md"],
    ["便携记录器", "recorder.md"], ["记录器相关的文章", "recorder.md"],
    ["PKM 4.8.1", "version.md"], ["有没有 PKM 4.8.1 相关资料", "version.md"],
  ]) assert.equal((await search(names, { query })).hits[0].vaultRelativePath, path, "short boilerplate fragments cannot outweigh an intact title, alias or dotted version");
  const exactNames = await search(names, { query: "关于光学的笔记" });
  assert.deepEqual(new Set(exactNames.hits.slice(0, 2).map(hit => hit.vaultRelativePath)), new Set(["framed.md", "framed-alias.md"]));
  assert.equal(exactNames.hits[0].score, exactNames.hits[1].score);
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  try {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    const baselineRanks = new Map([["ecology-reordered", 3], ["ecology-related", 3], ["ecology-recorded", 2], ["format-development", 1]]);
    for (const row of await collectKnowledgeBodySearchBoilerplateEvidence()) {
      assert.ok(row.targetRank !== null && row.targetRank <= baselineRanks.get(row.id)!, "Chinese fallback does not regress from the same development fixture on 74bd1ef7");
    }
    assert.equal((await search(notesAsTopic, { query: "笔记" })).hits[0].vaultRelativePath, "subject-notes.md");
    assert.equal((await search(names, { query: "找一下我的世界相关资料" })).hits[0].vaultRelativePath, "game.md");
    assert.equal((await search(names, { query: "有没有 PKM 4.8.1 相关资料" })).hits[0].vaultRelativePath, "version.md");
  } finally {
    if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
    else Reflect.deleteProperty(Intl, "Segmenter");
  }
  console.log("Knowledge body search boilerplate: varied wording, positive signals, real topics, complete names and Chinese fallback PASS");
}
