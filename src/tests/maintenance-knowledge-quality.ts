import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MaintenanceKnowledgeSource, MaintenanceKnowledgeUnit } from "../knowledge-base/maintenance-p2-contract";
import { groundMaintenanceKnowledgeUnits, validateMaintenanceKnowledgeUnits, validateMaintenanceNewPage } from "../knowledge-base/maintenance-knowledge-quality";
import { MAINTENANCE_KNOWLEDGE_TYPES, MAINTENANCE_KNOWLEDGE_WRITING_TEMPLATES, maintenanceKnowledgeTypePrompt } from "../knowledge-base/maintenance-knowledge-types";

function source(path: string, content: string): MaintenanceKnowledgeSource {
  return { path, content, contentRevision: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}` };
}

function unit(source: MaintenanceKnowledgeSource, changes: Partial<MaintenanceKnowledgeUnit> = {}): MaintenanceKnowledgeUnit {
  return { id: "unit-1", type: "概念", domain: "学习", title: "间隔复习", aliases: [], points: ["复习间隔应随掌握情况调整。"], evidence: [{ sourcePath: source.path, sourceRevision: source.contentRevision, quote: "复习间隔应随掌握情况调整。" }], ...changes };
}

function page(type: string = "概念", metadata = "aliases: []", body = "# 间隔复习\n\n根据掌握情况安排下一次复习。\n\n## 我自己的组织方式\n\n这里解释做法与适用条件。\n"): string {
  return `---\n类型: ${type}\n${metadata}\n---\n${body}`;
}

export function runMaintenanceKnowledgeQualityTests(): void {
  assert.equal(MAINTENANCE_KNOWLEDGE_TYPES.length, 7);
  assert.equal(new Set(MAINTENANCE_KNOWLEDGE_TYPES).size, 7);
  for (const type of MAINTENANCE_KNOWLEDGE_TYPES) {
    assert.ok(MAINTENANCE_KNOWLEDGE_WRITING_TEMPLATES[type].length > 100);
    assert.ok(maintenanceKnowledgeTypePrompt().includes(type));
  }

  const first = source("raw/first.md", "---\naliases: [仅在属性中的句子]\n---\n# 研究\n\n复习间隔应随掌握情况调整。\n");
  const second = source("raw/second.md", "# 补充材料\n\n长期效果仍需要验证。\n");
  const valid = unit(first);
  validateMaintenanceKnowledgeUnits([valid], [first]);
  const nativeUnit = unit(first, { id: "native-r1-unit" });
  const bareRevision = first.contentRevision.slice("sha256:".length);
  for (const sourceRevision of [bareRevision, bareRevision.toUpperCase()]) {
    validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourceRevision }] }], [first]);
  }
  const failureAt = (sourcePath: string, message: RegExp) => (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('unit.id="native-r1-unit"'), error.message);
    assert.ok(error.message.includes(`sourcePath=${JSON.stringify(sourcePath)}`), error.message);
    assert.match(error.message, message);
    return true;
  };
  for (const sourceRevision of ["", "sha256:bad", bareRevision.slice(1), `${bareRevision}0`, ` ${bareRevision}`, `SHA256:${bareRevision}`, `sha256:${bareRevision.toUpperCase()}`, `sha256:123:${bareRevision}`]) {
    assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourceRevision }] }], [first]), failureAt(first.path, /版本格式非法/u));
  }
  for (const sourceRevision of ["0".repeat(64), `sha256:${"0".repeat(64)}`]) {
    assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourceRevision }] }], [first]), failureAt(first.path, /全文版本不匹配/u));
  }
  assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourcePath: "raw/outside.md" }] }], [first]), failureAt("raw/outside.md", /outside/u));
  assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourcePath: "" }] }], [first]), failureAt("", /sourcePath 缺失或为空/u));
  assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...nativeUnit, evidence: [{ ...nativeUnit.evidence[0], sourcePath: undefined }] } as unknown as MaintenanceKnowledgeUnit], [first]), (error: unknown) => error instanceof Error && error.message.includes('unit.id="native-r1-unit"') && error.message.includes("sourcePath=<missing>") && /sourcePath 缺失或为空/u.test(error.message));
  const multiline = source("raw/multiline.md", "# 原句包含换行\n\n第一行保留条件，\n第二行说明结果。\n");
  const multilineEvidence = { sourcePath: multiline.path, sourceRevision: multiline.contentRevision, quote: "第一行保留条件，\n第二行说明结果。" };
  validateMaintenanceKnowledgeUnits([unit(multiline, { id: nativeUnit.id, evidence: [multilineEvidence] })], [multiline]);
  validateMaintenanceKnowledgeUnits([unit(multiline, { id: nativeUnit.id, evidence: [{ ...multilineEvidence, quote: multilineEvidence.quote.replace(/\n/gu, " ") }] })], [multiline]);
  validateMaintenanceKnowledgeUnits([], []);
  validateMaintenanceKnowledgeUnits([unit(first, { evidence: [...valid.evidence, { sourcePath: second.path, sourceRevision: second.contentRevision, quote: "长期效果仍需要验证。" }] })], [first, second]);
  const crlf = source("raw/crlf.md", "\uFEFF---\r\n摘要: 原始属性\r\n---\r\n复习间隔应随掌握情况调整。\r\n");
  validateMaintenanceKnowledgeUnits([unit(crlf)], [crlf]);
  for (const patch of [
    { id: " " }, { type: "未分类" }, { domain: "" }, { title: "\n" },
    { aliases: undefined }, { aliases: "别名" }, { aliases: [1] }, { aliases: [""] },
    { points: [] }, { points: [" "] }, { evidence: [] }, { typePendingConfirmation: "true" }
  ]) {
    assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...valid, ...patch } as unknown as MaintenanceKnowledgeUnit], [first]));
  }
  assert.throws(() => validateMaintenanceKnowledgeUnits([valid, valid], [first]), /unique/u);
  assert.throws(() => validateMaintenanceKnowledgeUnits([valid], [first, first]), /unique/u);
  assert.throws(() => validateMaintenanceKnowledgeUnits([valid], [{ ...first, content: `${first.content}已修改` }]), /full content/u);
  for (const patch of [
    { sourcePath: "raw/outside.md" }, { sourceRevision: `sha256:${"a".repeat(64)}` },
    { quote: "" }, { quote: " " }, { quote: "复习间隔应根据掌握情况调整。" }, { quote: "仅在属性中的句子" }
  ]) {
    assert.throws(() => validateMaintenanceKnowledgeUnits([{ ...valid, evidence: [{ ...valid.evidence[0], ...patch }] }], [first]));
  }
  // Lexical validation intentionally cannot reject a logically unrelated point.
  validateMaintenanceKnowledgeUnits([unit(first, { points: ["这条主张需要模型另行判断，原句存在不能证明它成立。"] })], [first]);

  for (const type of MAINTENANCE_KNOWLEDGE_TYPES) {
    validateMaintenanceNewPage(page(type), [unit(first, { type })]);
    validateMaintenanceNewPage(page(type, 'aliases:\n  - "可检索别名"\n类型待确认: true'), [unit(first, { type, typePendingConfirmation: true })]);
  }
  validateMaintenanceNewPage(page("概念", 'aliases: ["别名一", 别名二]'), [valid]);
  const aliasedUnits = [unit(first, { aliases: ["Spaced Repetition", "间隔效应", "间隔效应"] }), unit(first, { id: "unit-2", aliases: ["spaced repetition", "复习间隔"] })];
  validateMaintenanceNewPage(page("概念", 'aliases: ["spaced repetition", "间隔效应", "复习间隔"]'), aliasedUnits);
  assert.throws(() => validateMaintenanceNewPage(page("概念", 'aliases: ["spaced repetition", "间隔效应"]'), aliasedUnits), /preserve all/u);
  assert.throws(() => validateMaintenanceNewPage(page("概念", "aliases: []\n别名: [间隔效应]"), [valid]), /standard aliases field/u);
  assert.throws(() => validateMaintenanceNewPage(page("概念", "aliases: []\n别名:"), [valid]), /standard aliases field/u);
  validateMaintenanceNewPage(page(), [unit(first, { title: "标题不强制成为别名" })]);
  validateMaintenanceNewPage(page("方法 / 流程", "aliases: []", "# 操作方法\n\n用下面的命令执行操作。\n\n## 执行命令\n\n```sh\nrun-example\n```\n"), [unit(first, { type: "方法 / 流程" })]);
  validateMaintenanceNewPage(page("概念", "aliases: []\n类型待确认: false"), [valid]);
  assert.throws(() => validateMaintenanceNewPage(page(), []));
  assert.throws(() => validateMaintenanceNewPage(page("第八类"), [valid]), /seven types/u);
  assert.throws(() => validateMaintenanceNewPage(page("趋势 / 主题"), [valid]), /primary unit/u);
  assert.throws(() => validateMaintenanceNewPage(page(), [unit(first, { typePendingConfirmation: true })]), /类型待确认: true/u);
  for (const metadata of [
    "aliases: 别名", "aliases: null", "aliases: [1]", "aliases: [null]", "aliases: [\"\"]",
    "aliases: {name: 别名}", "aliases: &shared [别名]", "aliases: []\naliases: []",
    "aliases: []\n类型待确认: \"true\"", "aliases: []\n类型待确认: null"
  ]) assert.throws(() => validateMaintenanceNewPage(page("概念", metadata), [valid]));
  for (const body of [
    "只有正文，没有标题。", "# 标题\n\n## 小节\n内容。", "# 标题\n\n导语。\n",
    "# 标题\n\n导语。\n\n## 空小节\n\n", "# 标题\n\n导语。\n\n## 小节\n内容。\n\n# 第二个标题\n",
    "# 标题\n\n<!-- 注释不能充当导语 -->\n\n## 小节\n内容。",
    "# 标题\n\n导语。\n\n```markdown\n## 示例里的假小节\n不能充当页面结构。\n```\n"
  ]) assert.throws(() => validateMaintenanceNewPage(page("概念", "aliases: []", body), [valid]));
  for (const title of ["来源", "相关条目", "Sources", "Related", "References", "Related entries", "来源 / Sources", "**相关链接**"]) {
    assert.throws(() => validateMaintenanceNewPage(page("概念", "aliases: []", `# 标题\n\n有导语。\n\n## ${title}\n\n[[raw/source.md]]\n`), [valid]), /knowledge content beyond/u);
    assert.throws(() => validateMaintenanceNewPage(page("概念", "aliases: []", `# 标题\n\n有导语。\n\n## 空知识正文\n\n## ${title}\n\n[[raw/source.md]]\n\n### 管理区内的自定义子标题\n\n[[wiki/related.md]]\n`), [valid]), /knowledge content beyond/u);
  }
  validateMaintenanceNewPage(page("概念", "aliases: []", "# 标题\n\n有导语。\n\n## 来源\n\n[[raw/source.md]]\n\n## 我为什么这样组织复习\n\n掌握程度变化后应重新安排复习间隔。\n\n## 相关条目\n\n[[wiki/related.md]]\n"), [valid]);
  assert.throws(() => validateMaintenanceNewPage("# 标题\n导语\n## 小节\n正文", [valid]), /YAML/u);
  assert.throws(() => validateMaintenanceNewPage("---\n类型: 概念\naliases: []\n# 未关闭", [valid]), /closed/u);
  assertQuoteGrounding();
  console.log("Maintenance knowledge quality: seven-type templates, exact evidence/version checks and flexible new-page structure passed.");
}

function assertQuoteGrounding(): void {
  const text = "\uFEFF---\r\n摘要: This is one paragraph.\r\n---\r\n# 📖 Title\r\n\r\n😀 intro. This  is\r\none\tparagraph.\r\n\r\nThis  is\r\none\tparagraph.\r\n";
  const originalSource = source("raw/grounding.md", text);
  const submitted = "  This is one paragraph. \n";
  const originalUnit = unit(originalSource, { evidence: [{ sourcePath: originalSource.path, sourceRevision: originalSource.contentRevision.slice(7).toUpperCase(), quote: submitted, quoteLocation: { start: 0, end: 1, unit: "utf16", match: "literal", submittedQuote: "caller position is untrusted" } }] });
  const before = structuredClone({ originalUnit, originalSource });
  Object.freeze(originalSource);
  Object.freeze(originalUnit.evidence[0].quoteLocation);
  Object.freeze(originalUnit.evidence[0]);
  Object.freeze(originalUnit.evidence);
  Object.freeze(originalUnit.aliases);
  Object.freeze(originalUnit.points);
  Object.freeze(originalUnit);
  const [grounded] = groundMaintenanceKnowledgeUnits([originalUnit], [originalSource]);
  assert.deepEqual({ originalUnit, originalSource }, before, "grounding must not mutate Raw, units, evidence or supplied positions");
  assert.notEqual(grounded, originalUnit);
  assert.notEqual(grounded.evidence, originalUnit.evidence);
  assert.equal(grounded.evidence[0].sourceRevision, originalSource.contentRevision);
  assert.equal(grounded.evidence[0].quote, "This  is\r\none\tparagraph.");
  const location = grounded.evidence[0].quoteLocation!;
  assert.deepEqual(location, { start: text.indexOf("This  is"), end: text.indexOf("This  is") + grounded.evidence[0].quote.length, unit: "utf16", match: "whitespace", submittedQuote: submitted });
  assert.equal(text.slice(location.start, location.end), grounded.evidence[0].quote);
  const firstMatch = text.indexOf("This  is");
  assert.ok(firstMatch > [...text.slice(0, firstMatch)].length, "offsets include UTF-16 surrogate pairs before the quote");

  const check = (content: string, quote: string, match: "literal" | "whitespace" = "whitespace") => {
    const item = source("raw/range.md", content);
    const [result] = groundMaintenanceKnowledgeUnits([unit(item, { evidence: [{ sourcePath: item.path, sourceRevision: item.contentRevision, quote }] })], [item]);
    const evidence = result.evidence[0];
    assert.equal(evidence.quoteLocation?.match, match);
    assert.equal(evidence.quoteLocation?.submittedQuote, quote);
    assert.equal(item.content.slice(evidence.quoteLocation!.start, evidence.quoteLocation!.end), evidence.quote);
    return evidence;
  };
  check("\uFEFF😀  First\r\nline is here.", "😀 First line is here.");
  check("Same\nparagraph has    spaces.", "Same paragraph has spaces.");
  check("alpha\tbeta\rnext line", "alpha beta next line");
  check("Before   words `token   code` after   words.", "Before words");
  check("Before   words `token   code` after   words.", "after words.");
  check("A code example `<div>` stays inline.\n\nA  normal\nparagraph follows.", "A normal paragraph follows.");
  check("- One  item\n  continues here.\n- Another  item.", "One item continues here.");
  const literalPriority = check("alpha   beta\n\nalpha beta\n\nalpha beta", "alpha beta", "literal");
  assert.equal(literalPriority.quoteLocation?.start, "alpha   beta\n\n".length, "literal match takes priority, then earliest literal occurrence");
  check("# Header\n\n```js\nconst   VALUE = 1;\n```\n", "const   VALUE = 1;", "literal");
  check("first paragraph.\n\nsecond paragraph.", "first paragraph.\n\nsecond paragraph.", "literal");

  const rejects = (content: string, quote: string) => {
    const item = source("raw/reject.md", content);
    assert.throws(() => groundMaintenanceKnowledgeUnits([unit(item, { evidence: [{ sourcePath: item.path, sourceRevision: item.contentRevision, quote }] })], [item]), /quote 不是连续正文原句/u);
  };
  rejects("first  paragraph.\n\nsecond  paragraph.", "first paragraph. second paragraph.");
  rejects("first  paragraph.\n## A heading\nsecond  paragraph.", "first paragraph. second paragraph.");
  rejects("# Some  heading\n\nA real paragraph.", "Some heading");
  rejects("Some  heading\n===\n\nA real paragraph.", "Some heading");
  rejects("- First  item.\n- Second  item.", "First item. - Second item.");
  rejects("before  code\n```\ninside\n```\nafter  code", "before code after code");
  rejects("```js\nconst   VALUE = 1;\n```", "const VALUE = 1;");
  rejects("~~~\nconst   VALUE = 1;\n~~~", "const VALUE = 1;");
  rejects("    const   VALUE = 1;\n", "const VALUE = 1;");
  rejects("  \tconst   VALUE = 1;\n", "const VALUE = 1;");
  rejects("- ```js\n  const   VALUE = 1;\n  ```", "const VALUE = 1;");
  rejects("Before `token   code` after.", "token code");
  rejects("Before ``token\n   code`` after.", "token code");
  rejects("Before  words `token` after  words.", "Before words token after words.");
  rejects("<pre>\nSome   code\n</pre>", "Some code");
  rejects("<div>\n<div>\ninside  HTML\n</div>\n\nstill  HTML\n</div>", "still HTML");
  rejects("<div>\n<!-- </div> -->\nstill  HTML\n</div>", "still HTML");
  rejects("Before <span>inline   HTML</span> after.", "inline HTML");
  rejects("<!--\ncomment   text\n-->", "comment text");
  const nasa = "The answer could be found in the lessons learned from Apollo 1; a major redesign was undertaken.";
  rejects(nasa, nasa.replace(/^The/u, "the")); // NASA diagnosis: case change, not an invented fact.
  rejects(nasa, nasa.replace("redesign", "replacement"));
  rejects(nasa, nasa.replace(";", ","));

  const aggregateSource = source("raw/aggregate.md", "Actual evidence exists here.");
  const badEvidence = (quote: string) => ({ sourcePath: aggregateSource.path, sourceRevision: aggregateSource.contentRevision, quote });
  const aggregateUnits = [unit(aggregateSource, { id: "first-id", evidence: [badEvidence("wrong one"), badEvidence("wrong two")] }), unit(aggregateSource, { id: "second-id", evidence: [badEvidence("wrong three")] })];
  assert.throws(() => groundMaintenanceKnowledgeUnits(aggregateUnits, [aggregateSource]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /共3条/u);
    assert.match(error.message, /知识点ID可沿用.*重发完整批次/u);
    assert.ok(error.message.includes('unit.id="first-id"'));
    assert.ok(error.message.includes('unit.id="second-id"'));
    assert.ok(error.message.includes('sourcePath="raw/aggregate.md"'));
    assert.match(error.message, /quoteIndex=0（从0起始）/u);
    assert.match(error.message, /quoteIndex=1（从0起始）/u);
    for (const quote of ["wrong one", "wrong two", "wrong three"]) assert.ok(error.message.includes(`收到的quote="${quote}"`));
    assert.match(error.message, /已列出3条，遗漏0条/u);
    return true;
  });
  const manyFailures = unit(aggregateSource, { evidence: Array.from({ length: 20 }, (_, index) => badEvidence(`missing quote ${index}`)) });
  assert.throws(() => groundMaintenanceKnowledgeUnits([manyFailures], [aggregateSource]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /共20条/u);
    assert.match(error.message, /已列出12条，遗漏8条/u);
    assert.equal((error.message.match(/quoteIndex=/gu) ?? []).length, 12);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 6500);
    return true;
  });
  const hugeFailures = unit(aggregateSource, { evidence: Array.from({ length: 20 }, () => badEvidence("😀不存在的引文\n".repeat(2000))) });
  assert.throws(() => groundMaintenanceKnowledgeUnits([hugeFailures], [aggregateSource]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 6500);
    assert.match(error.message, /收到的quote已截短/u);
    const counts = /已列出(\d+)条，遗漏(\d+)条/u.exec(error.message)!;
    assert.equal(Number(counts[1]) + Number(counts[2]), 20);
    assert.ok(Number(counts[1]) > 0 && Number(counts[1]) < 12, "byte cap also limits displayed entries");
    assert.equal(error.message.includes("\uFFFD"), false, "UTF-8 truncation must not split emoji");
    return true;
  });
}
