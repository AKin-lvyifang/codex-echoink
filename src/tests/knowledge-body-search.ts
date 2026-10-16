import assert from "node:assert/strict";
import { BodySearchMemoryIndex, searchBodyDocuments } from "../knowledge-base/search/body-search";
import { buildSearchDictionary, tokenizeSearchText } from "../knowledge-base/search/tokenize";
import type { BodySearchDocument, BodySearchRequest } from "../knowledge-base/search/contracts";

function note(path: string, body: string, metadata: Partial<BodySearchDocument> = {}): BodySearchDocument {
  return { vaultRelativePath: path, title: path.split("/").at(-1)!.replace(/\.md$/u, ""), kind: "notes", recordedAt: 100,
    read: async () => ({ content: body, contentRevision: `sha256:${path}` }), ...metadata };
}

async function search(documents: readonly BodySearchDocument[], request: BodySearchRequest) {
  return searchBodyDocuments({ documents, request });
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
  const uiTask = setTimeout(() => { uiTaskRan = true; }, 0);
  await search(sequential, { query: "needle" });
  clearTimeout(uiTask);
  assert.equal(uiTaskRan, true, "scan yields to a pending UI task");
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
  const cancel = setTimeout(() => duringScan.abort(), 0);
  await assert.rejects(search(sequential, { query: "needle", signal: duringScan.signal }), { name: "AbortError" });
  clearTimeout(cancel);
  const longCancellation = new AbortController();
  let laterFileRead = false;
  const longAbort = setTimeout(() => longCancellation.abort(), 0);
  await assert.rejects(search([
    note("huge-section.md", "large background ".repeat(12_000)),
    note("later.md", "", { read: async () => { laterFileRead = true; return { content: "needle", contentRevision: "later" }; } }),
  ], { query: "needle", signal: longCancellation.signal }), { name: "AbortError" });
  clearTimeout(longAbort);
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
