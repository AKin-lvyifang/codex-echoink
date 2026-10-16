import assert from "node:assert/strict";
import { diaryReadingBody, markDiaryReadingBlock, renderDiaryReading } from "../english-diary/reading-renderer";
import type { DiaryAlignment } from "../english-diary/types";

/** Fixture HTML stands in for host rendering; this tests mapping, not Markdown parsing. */
export async function runEnglishDiaryReadingTests(document: Document): Promise<void> {
  const fixture = (entries: Array<[string, string]>) => {
    const html = new Map(entries);
    return async (markdown: string, container: HTMLElement) => {
      assert.ok(html.has(markdown), `missing renderer fixture: ${JSON.stringify(markdown)}`);
      container.innerHTML = html.get(markdown)!;
    };
  };
  const alignment = (text: string, from: number, to: number, id = "alignment"): DiaryAlignment => ({ id, kind: "correction", source: [{ start: 0, end: 1, text: "原" }], target: [{ start: from, end: to, text: text.slice(from, to) }], reason: "Saved reason", status: "verified" });
  const root = () => document.createElement("div");
  const decorate = (mark: HTMLElement, ids: string[]) => { mark.dataset.alignmentIds = ids.join(","); };

  const english = "---\r\ntitle: diary\r\n---\r\n# Today\n\nI tried again and again.\n\nA **better** day.";
  const body = diaryReadingBody(english);
  assert.equal(body.markdown, "# Today\n\nI tried again and again.\n\nA **better** day.");
  assert.equal(english.slice(body.start), body.markdown);
  assert.equal(diaryReadingBody("---\nnot closed").start, 0, "unfinished frontmatter is preserved");
  assert.equal(diaryReadingBody("\uFEFF---\na: 1\n...\nBody").markdown, "Body");
  const rendered = root();
  const blocks = await renderDiaryReading(rendered, english, fixture([
    [body.markdown, "<h1>Today</h1><p>I tried again and again.</p><p>A <strong>better</strong> day.</p>"],
    ["# Today", "<h1>Today</h1>"],
    ["I tried again and again.", "<p>I tried again and again.</p>"],
    ["A **better** day.", "<p>A <strong>better</strong> day.</p>"]
  ]));
  assert.equal(blocks[0].exactText, false, "headings never get interactive marks");
  assert.equal(blocks[1].exactText, true);
  assert.equal(blocks[2].exactText, false, "Markdown syntax is not stripped with a guessed offset adjustment");
  assert.equal(blocks[2].element, rendered.children[2], "rich paragraph retains its proven fallback anchor");
  const secondAgain = english.lastIndexOf("again");
  const item = alignment(english, secondAgain, secondAgain + 5);
  markDiaryReadingBlock(blocks[1], [item], decorate);
  assert.equal(rendered.querySelector(".echoink-diary-mark")?.textContent, "again");
  assert.equal(rendered.querySelector("p")?.innerHTML, 'I tried again and <span class="echoink-diary-mark is-correction" data-alignment-ids="alignment">again</span>.', "repeat words use the original offset");
  assert.equal(rendered.textContent, "TodayI tried again and again.A better day.", "annotations preserve the rendered content");
  assert.equal(markDiaryReadingBlock(blocks[2], [alignment(english, english.indexOf("better"), english.indexOf("better") + 6)], decorate).size, 0);

  const repeated = "Same paragraph.\n\nSame paragraph.";
  const repeatedRoot = root();
  const repeatedBlocks = await renderDiaryReading(repeatedRoot, repeated, fixture([
    [repeated, "<p>Same paragraph.</p><p>Same paragraph.</p>"], ["Same paragraph.", "<p>Same paragraph.</p>"]
  ]));
  const repeatedAlignment = alignment(repeated, repeated.lastIndexOf("Same"), repeated.lastIndexOf("Same") + 4);
  for (const block of repeatedBlocks) markDiaryReadingBlock(block, [repeatedAlignment], decorate);
  assert.equal(repeatedRoot.children[0].querySelector(".echoink-diary-mark"), null);
  assert.equal(repeatedRoot.children[1].querySelector(".echoink-diary-mark")?.textContent, "Same", "complete ordered renderer output proves repeated paragraphs");

  const fenced = "```text\nrepeat\n\nrepeat\n```\n\nrepeat";
  const fencedRoot = root();
  const fencedBlocks = await renderDiaryReading(fencedRoot, fenced, fixture([
    [fenced, "<pre><code>repeat\n\nrepeat\n</code></pre><p>repeat</p>"],
    ["```text\nrepeat", "<pre><code>repeat\n</code></pre>"],
    ["repeat\n```", "<p>repeat</p><pre><code></code></pre>"],
    ["repeat", "<p>repeat</p>"],
    ["```", "<pre><code></code></pre>"],
    ["```\n\nrepeat", "<pre><code>\nrepeat\n</code></pre>"],
    ["```text\nrepeat\n\nrepeat", "<pre><code>repeat\n\nrepeat\n</code></pre>"],
    ["```text\nrepeat\n\nrepeat\n```", "<pre><code>repeat\n\nrepeat\n</code></pre>"]
  ]));
  assert.equal(fencedBlocks[0].element, fencedRoot.children[0], "multi-envelope Markdown is anchored by full host output");
  assert.equal(fencedBlocks[0].exactText, false);
  const fencedAlignment = alignment(fenced, fenced.lastIndexOf("repeat"), fenced.length);
  for (const block of fencedBlocks) markDiaryReadingBlock(block, [fencedAlignment], decorate);
  assert.equal(fencedRoot.querySelector("pre .echoink-diary-mark"), null, "code is not mistaken for a repeated paragraph");
  assert.equal(fencedRoot.querySelector("p .echoink-diary-mark")?.textContent, "repeat");

  const immediate = "## Work\nI finally got my thoughts straight today.\n\n```text\nUnrelated code\n```";
  const immediateRoot = root();
  const immediateBlocks = await renderDiaryReading(immediateRoot, immediate, fixture([
    [immediate, "<h2>Work</h2><p>I finally got my thoughts straight today.</p><pre><code>Unrelated code\n</code></pre>"],
    ["## Work\nI finally got my thoughts straight today.", "<h2>Work</h2><p>I finally got my thoughts straight today.</p>"],
    ["## Work", "<h2>Work</h2>"],
    ["I finally got my thoughts straight today.", "<p>I finally got my thoughts straight today.</p>"],
    ["```text\nUnrelated code\n```", "<pre><code>Unrelated code\n</code></pre>"]
  ]));
  assert.equal(immediateBlocks[1].element, immediateRoot.querySelector("p"), "heading immediately followed by a paragraph uses a proved newline boundary");
  const phraseStart = immediate.indexOf("got my thoughts straight");
  for (const block of immediateBlocks) markDiaryReadingBlock(block, [alignment(immediate, phraseStart, phraseStart + "got my thoughts straight".length)], decorate);
  assert.equal(immediateRoot.querySelector("p .echoink-diary-mark")?.textContent, "got my thoughts straight");
  assert.equal(immediateRoot.querySelector("h2 .echoink-diary-mark"), null);
  assert.equal(immediateRoot.querySelector("pre .echoink-diary-mark"), null);

  const immediateRich = "## Work\nI **finally** got my thoughts straight today.";
  const richRoot = root();
  const richBlocks = await renderDiaryReading(richRoot, immediateRich, fixture([
    [immediateRich, "<h2>Work</h2><p>I <strong>finally</strong> got my thoughts straight today.</p>"],
    ["## Work", "<h2>Work</h2>"],
    ["I **finally** got my thoughts straight today.", "<p>I <strong>finally</strong> got my thoughts straight today.</p>"]
  ]));
  assert.equal(richBlocks[1].element, richRoot.querySelector("p"), "rich content keeps a local paragraph anchor after a heading without a blank line");
  assert.equal(richBlocks[1].exactText, false, "proving a block boundary does not guess offsets through Markdown formatting");

  const manyLines = Array.from({ length: 160 }, (_, index) => `line ${index}`).join("\n");
  let probeCalls = 0;
  await renderDiaryReading(root(), manyLines, async (markdown, container) => {
    probeCalls++;
    if (markdown === manyLines) container.innerHTML = "<h2>Unmappable heading</h2><p>Unmappable paragraph</p>";
    else { const paragraph = document.createElement("p"); paragraph.textContent = markdown; container.append(paragraph); }
  });
  assert.ok(probeCalls <= 98, "line-boundary probes have one shared finite rendering budget");

  const nested = root();
  const nestedBlocks = await renderDiaryReading(nested, "Hello world.", fixture([["Hello world.", "<p>Hello <span>world</span>.</p>"]]));
  markDiaryReadingBlock(nestedBlocks[0], [alignment("Hello world.", 3, 9)], decorate);
  assert.equal(Array.from(nested.querySelectorAll(".echoink-diary-mark"), (mark) => mark.textContent).join(""), "lo wor", "identity mapping crosses text nodes without changing offsets");
  const invalid = { ...alignment("Hello world.", 0, 5), target: [{ start: 0, end: 5, text: "wrong" }] };
  assert.equal(markDiaryReadingBlock(nestedBlocks[0], [invalid], decorate).size, 0, "changed range text never receives a guessed mark");
  let calls = 0;
  const cancelled = await renderDiaryReading(root(), "hello", async (_markdown, container) => { calls++; container.innerHTML = "<p>hello</p>"; }, () => false);
  assert.deepEqual(cancelled, []);
  assert.equal(calls, 1, "obsolete views stop before adding annotations or rendering more blocks");
}
